use super::token::{AuthError, KeySet};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

const DEFAULT_TTL: Duration = Duration::from_secs(600);
const FETCH_TIMEOUT: Duration = Duration::from_secs(5);

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
        // Another task may have refreshed while this one waited on the lock.
        if !force_refresh {
            if let Some(cached) = guard.as_ref() {
                if cached.fetched_at.elapsed() < self.ttl {
                    return Ok(cached.keyset.clone());
                }
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
