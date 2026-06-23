use super::token::{AuthError, KeySet};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

const DEFAULT_TTL: Duration = Duration::from_secs(600);
const FETCH_TIMEOUT: Duration = Duration::from_secs(5);
/// Minimum wall-clock interval between *forced* (unknown-kid) JWKS refetches.
/// Without this, an attacker minting tokens with random `kid`s (no valid
/// signature needed — the unknown-kid check precedes verification) drives an
/// unbounded outbound JWKS fetch per request, amplifying onto the IdP's JWKS
/// endpoint and serializing the auth path on the write lock (RUST-AUTH-1). A
/// real key rotation is still picked up within this window.
const MIN_FORCED_REFRESH_INTERVAL: Duration = Duration::from_secs(30);

struct CachedKeys {
    fetched_at: Instant,
    keyset: Arc<KeySet>,
}

/// Cache plus the last upstream-fetch *attempt* time. Tracking the attempt
/// (not just the last success) lets the forced-refresh throttle cover the
/// empty-cache case — cold start or a persistently-failing JWKS endpoint —
/// which a per-entry freshness check cannot (there is no entry to time from).
struct CacheState {
    keys: Option<CachedKeys>,
    last_attempt: Option<Instant>,
}

/// Fetches and caches the IdP's JWKS document. Refreshes after the TTL,
/// or immediately (once per request) when a token arrives with an unknown
/// `kid` — the normal shape of a key rotation.
pub struct JwksCache {
    url: String,
    http: reqwest::Client,
    state: RwLock<CacheState>,
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
            state: RwLock::new(CacheState {
                keys: None,
                last_attempt: None,
            }),
            ttl: DEFAULT_TTL,
        }
    }

    pub async fn keyset(&self, force_refresh: bool) -> Result<Arc<KeySet>, AuthError> {
        if !force_refresh {
            let guard = self.state.read().await;
            if let Some(cached) = guard.keys.as_ref() {
                if cached.fetched_at.elapsed() < self.ttl {
                    return Ok(cached.keyset.clone());
                }
            }
        }

        let mut guard = self.state.write().await;
        if let Some(cached) = guard.keys.as_ref() {
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

        // Throttle the upstream fetch ATTEMPT itself, so an empty or stale cache
        // during a JWKS outage cannot be driven into an unbounded refetch storm
        // (RUST-AUTH-1) — the empty-cache hole the per-entry check above misses.
        // The first attempt always proceeds (last_attempt is None on cold start).
        if let Some(last_attempt) = guard.last_attempt {
            if last_attempt.elapsed() < MIN_FORCED_REFRESH_INTERVAL {
                return match guard.keys.as_ref() {
                    Some(cached) => Ok(cached.keyset.clone()),
                    None => Err(AuthError::Jwks(
                        "JWKS endpoint unavailable; refetch throttled".to_string(),
                    )),
                };
            }
        }
        guard.last_attempt = Some(Instant::now());

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
        guard.keys = Some(CachedKeys {
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

    /// RUST-AUTH-1 (empty-cache hole): when the JWKS upstream is DOWN and the
    /// cache never populates, a burst of requests must still hit upstream at
    /// most once per throttle window — not once per request (the pre-fix code
    /// skipped the throttle entirely while `cached` was None).
    #[tokio::test]
    async fn empty_cache_refetch_is_throttled_during_outage() {
        static HITS: AtomicUsize = AtomicUsize::new(0);
        let app = axum::Router::new().route(
            "/jwks",
            axum::routing::get(|| async {
                HITS.fetch_add(1, Ordering::SeqCst);
                axum::http::StatusCode::INTERNAL_SERVER_ERROR
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let cache = JwksCache::new(format!("http://{addr}/jwks"));
        for _ in 0..10 {
            // Every call errors (upstream is down); only the first should fetch.
            assert!(cache.keyset(false).await.is_err());
        }
        assert_eq!(
            HITS.load(Ordering::SeqCst),
            1,
            "an unavailable JWKS upstream must be refetched at most once per window"
        );
    }
}
