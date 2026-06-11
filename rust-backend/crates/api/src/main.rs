use axum::{extract::State, http::StatusCode, response::IntoResponse, routing::get, Json, Router};
use redis::Client as RedisClient;
use serde::Serialize;
use sqlx::PgPool;
use std::{env, net::SocketAddr, sync::Arc};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[derive(Clone)]
struct AppState {
    config: Arc<AppConfig>,
    pg: PgPool,
    redis: RedisClient,
}

#[derive(Debug)]
struct AppConfig {
    bind_addr: SocketAddr,
    database_url: String,
    redis_url: String,
    artifact_store: String,
}

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
}

#[derive(Serialize)]
struct ReadinessResponse {
    status: &'static str,
    config_loaded: bool,
    postgres: &'static str,
    redis: &'static str,
    artifact_store: String,
}

impl AppConfig {
    fn from_env() -> Result<Self, String> {
        let bind_addr = env::var("APP_BIND_ADDR")
            .unwrap_or_else(|_| "127.0.0.1:8080".to_string())
            .parse::<SocketAddr>()
            .map_err(|err| format!("APP_BIND_ADDR is invalid: {err}"))?;

        Ok(Self {
            bind_addr,
            database_url: env::var("DATABASE_URL")
                .map_err(|_| "DATABASE_URL is required".to_string())?,
            redis_url: env::var("REDIS_URL").map_err(|_| "REDIS_URL is required".to_string())?,
            artifact_store: env::var("ARTIFACT_STORE").unwrap_or_else(|_| "local".to_string()),
        })
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::from_default_env())
        .with(tracing_subscriber::fmt::layer())
        .init();

    let config = Arc::new(AppConfig::from_env()?);
    let pg = zkvote_db::connect(&config.database_url).await?;
    let redis = RedisClient::open(config.redis_url.as_str())?;
    let bind_addr = config.bind_addr;

    let state = AppState { config, pg, redis };
    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(bind_addr).await?;
    tracing::info!("zkvote-api listening on {bind_addr}");
    axum::serve(listener, app).await?;
    Ok(())
}

async fn healthz() -> Json<HealthResponse> {
    Json(HealthResponse { status: "ok" })
}

async fn readyz(State(state): State<AppState>) -> impl IntoResponse {
    let postgres_ok = zkvote_db::ping(&state.pg).await.is_ok();
    let redis_ok = ping_redis(&state.redis).await.is_ok();
    let status = if postgres_ok && redis_ok {
        "ready"
    } else {
        "not_ready"
    };
    let http_status = if postgres_ok && redis_ok {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };

    (
        http_status,
        Json(ReadinessResponse {
            status,
            config_loaded: true,
            postgres: if postgres_ok { "ok" } else { "error" },
            redis: if redis_ok { "ok" } else { "error" },
            artifact_store: state.config.artifact_store.clone(),
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
