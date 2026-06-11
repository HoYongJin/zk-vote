use crate::auth::AuthContext;
use crate::config::AppConfig;
use redis::Client as RedisClient;
use sqlx::PgPool;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<AppConfig>,
    pub pg: PgPool,
    pub redis: RedisClient,
    /// None when SUPABASE_JWKS_URL is not configured; authenticated routes
    /// then fail with a typed SERVER_ERROR instead of panicking.
    pub auth: Option<Arc<AuthContext>>,
}
