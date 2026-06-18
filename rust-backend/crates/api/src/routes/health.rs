use crate::state::AppState;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use redis::Client as RedisClient;
use serde::Serialize;

#[derive(Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
}

#[derive(Serialize)]
pub struct ReadinessResponse {
    pub status: &'static str,
    pub config_loaded: bool,
    pub postgres: &'static str,
    pub redis: &'static str,
    pub artifact_store: String,
    pub artifact_bucket_configured: bool,
}

pub async fn healthz() -> Json<HealthResponse> {
    Json(HealthResponse { status: "ok" })
}

fn artifact_store_ready(state: &AppState) -> bool {
    match state.config.artifact_store.as_str() {
        "gcs" => state.config.artifact_bucket.is_some(),
        _ => true,
    }
}

pub async fn readyz(State(state): State<AppState>) -> impl IntoResponse {
    let postgres_ok = zkvote_db::ping(&state.pg).await.is_ok();
    let redis_ok = ping_redis(&state.redis).await.is_ok();
    let artifact_ok = artifact_store_ready(&state);
    let ready = postgres_ok && redis_ok && artifact_ok;

    let http_status = if ready {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };

    (
        http_status,
        Json(ReadinessResponse {
            status: if ready { "ready" } else { "not_ready" },
            config_loaded: true,
            postgres: if postgres_ok { "ok" } else { "error" },
            redis: if redis_ok { "ok" } else { "error" },
            artifact_store: state.config.artifact_store.clone(),
            artifact_bucket_configured: state.config.artifact_bucket.is_some(),
        }),
    )
}

async fn ping_redis(client: &RedisClient) -> redis::RedisResult<()> {
    let mut conn = client.get_multiplexed_async_connection().await?;
    let response: String = redis::cmd("PING").query_async(&mut conn).await?;
    if response == "PONG" {
        Ok(())
    } else {
        Err(redis::RedisError::from((
            redis::ErrorKind::ResponseError,
            "unexpected redis PING response",
        )))
    }
}
