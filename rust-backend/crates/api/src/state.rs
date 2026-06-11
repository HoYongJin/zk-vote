use crate::config::AppConfig;
use redis::Client as RedisClient;
use sqlx::PgPool;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<AppConfig>,
    pub pg: PgPool,
    pub redis: RedisClient,
}
