use super::token::{AuthError, KeySet};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

const DEFAULT_TTL: Duration = Duration::from_secs(600);
const FETCH_TIMEOUT: Duration = Duration::from_secs(5);
/// Minimum wall-clock interval between *forced* (unknown-kid) JWKS refetches.
/// Without this, an attacker minting tokens with random `kid`s (no valid
/// signature needed — the unknown-kid check precedes verification) drives an
/// unbounded outbound JWKS fetch per request, amplifying onto the Supabase JWKS
/// endpoint and serializing the auth path on the write lock (RUST-AUTH-1). A
/// real key rotation is still picked up within this window.
const MIN_FORCED_REFRESH_INTERVAL: Duration = Duration::from_secs(30);

struct CachedKeys {
    fetched_at: Instant,
    keyset: Arc<KeySet>,
}

/// Fetches and caches the Supabase JWKS document. Refreshes after the TTL,
/// or immediately (once per request) when a token arrives with an unknown
/// `kid` — the normal shape of a key rotation.
pub struct JwksCache {
    url: String,
    http: reqwest::Client,
    cached: RwLock<Option<CachedKeys>>,
    ttl: Duration,
}

impl JwksCache {
    pub fn new(url: String) -> Self {
        Self {
            url,
            http: reqwest::Client::builder()
                .timeout(FETCH_TIMEOUT)
                .build()
                .expect("reqwest client construction cannot fail with static options"),
            cached: RwLock::new(None),
            ttl: DEFAULT_TTL,
        }
    }

    pub async fn keyset(&self, force_refresh: bool) -> Result<Arc<KeySet>, AuthError> {
        if !force_refresh {
            let guard = self.cached.read().await;
            if let Some(cached) = guard.as_ref() {
                if cached.fetched_at.elapsed() < self.ttl {
                    return Ok(cached.keyset.clone());
                }
            }
        }

        let mut guard = self.cached.write().await;
        if let Some(cached) = guard.as_ref() {
            // Non-forced: another task may have refreshed the TTL while this one
            // waited on the lock. Forced (unknown kid): throttle so attacker-
            // chosen kids cannot drive an unbounded refetch — serve the cached
            // keyset (the request then fails closed with UnknownKeyId) unless the
            // last refresh is older than MIN_FORCED_REFRESH_INTERVAL (RUST-AUTH-1).
            let still_fresh = if force_refresh {
                cached.fetched_at.elapsed() < MIN_FORCED_REFRESH_INTERVAL
            } else {
                cached.fetched_at.elapsed() < self.ttl
            };
            if still_fresh {
                return Ok(cached.keyset.clone());
            }
        }

        let body = self
            .http
            .get(&self.url)
            .send()
            .await
            .map_err(|err| AuthError::Jwks(format!("fetch failed: {err}")))?
            .error_for_status()
            .map_err(|err| AuthError::Jwks(format!("fetch failed: {err}")))?
            .text()
            .await
            .map_err(|err| AuthError::Jwks(format!("fetch failed: {err}")))?;

        let keyset = Arc::new(KeySet::from_jwks_json(&body)?);
        *guard = Some(CachedKeys {
            fetched_at: Instant::now(),
            keyset: keyset.clone(),
        });
        Ok(keyset)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// RUST-AUTH-1: a burst of forced (unknown-kid) refreshes must not drive a
    /// matching burst of outbound JWKS fetches; the throttle serves the cached
    /// keyset and the upstream is hit at most once per window.
    #[tokio::test]
    async fn forced_refreshes_are_throttled_to_one_upstream_fetch() {
        static HITS: AtomicUsize = AtomicUsize::new(0);
        let app = axum::Router::new().route(
            "/jwks",
            axum::routing::get(|| async {
                HITS.fetch_add(1, Ordering::SeqCst);
                (
                    [(axum::http::header::CONTENT_TYPE, "application/json")],
                    super::super::token::test_support::TEST_JWKS_JSON,
                )
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let cache = JwksCache::new(format!("http://{addr}/jwks"));
        // Initial populate (1 fetch).
        cache.keyset(false).await.unwrap();
        // A burst of forced refreshes within the throttle window must NOT refetch.
        for _ in 0..10 {
            cache.keyset(true).await.unwrap();
        }
        assert_eq!(
            HITS.load(Ordering::SeqCst),
            1,
            "forced refreshes within MIN_FORCED_REFRESH_INTERVAL must reuse the cache"
        );
    }
}
