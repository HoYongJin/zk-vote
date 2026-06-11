mod config;
// The shared error type has no production call sites until the Phase 5+
// business routes land; its contract is locked by tests below.
#[allow(dead_code)]
mod error;
mod middleware;
mod routes;
mod state;

use config::AppConfig;
use redis::Client as RedisClient;
use state::AppState;
use std::sync::Arc;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::from_default_env())
        .with(tracing_subscriber::fmt::layer())
        .init();

    let config = Arc::new(AppConfig::from_env()?);
    // Lazy pool: the process starts (and /healthz answers) even when Postgres
    // is briefly unavailable; /readyz keeps reporting the truth.
    let pg = zkvote_db::connect_lazy(&config.database_url)?;
    let redis = RedisClient::open(config.redis_url.as_str())?;
    let bind_addr = config.bind_addr;

    let state = AppState {
        config: config.clone(),
        pg,
        redis,
    };

    let (set_request_id, propagate_request_id) = middleware::request_id_layers();
    let app = routes::router(state)
        .layer(propagate_request_id)
        .layer(middleware::trace_layer())
        .layer(set_request_id)
        .layer(middleware::cors_layer(&config.cors_allowed_origins));

    let listener = tokio::net::TcpListener::bind(bind_addr).await?;
    tracing::info!("zkvote-api listening on {bind_addr}");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    tracing::info!("zkvote-api shut down cleanly");
    Ok(())
}

/// Resolves on SIGINT (ctrl-c) or SIGTERM (Cloud Run / container stop), so
/// in-flight requests drain instead of being severed.
async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install ctrl-c handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutdown signal received");
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn test_state() -> AppState {
        let config = Arc::new(
            AppConfig::from_lookup(|name| match name {
                "DATABASE_URL" => Some("postgres://localhost:1/unreachable".to_string()),
                "REDIS_URL" => Some("redis://localhost:1".to_string()),
                _ => None,
            })
            .unwrap(),
        );
        AppState {
            config: config.clone(),
            pg: zkvote_db::connect_lazy(&config.database_url).unwrap(),
            redis: RedisClient::open(config.redis_url.as_str()).unwrap(),
        }
    }

    #[tokio::test]
    async fn healthz_works_without_live_dependencies() {
        let app = routes::router(test_state());
        let response = app
            .oneshot(Request::get("/healthz").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(&body[..], br#"{"status":"ok"}"#);
    }

    #[tokio::test]
    async fn responses_carry_a_request_id() {
        let (set, propagate) = middleware::request_id_layers();
        let app = routes::router(test_state()).layer(propagate).layer(set);
        let response = app
            .oneshot(Request::get("/healthz").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let request_id = response
            .headers()
            .get(middleware::REQUEST_ID_HEADER)
            .expect("x-request-id header missing");
        assert!(uuid::Uuid::parse_str(request_id.to_str().unwrap()).is_ok());
    }

    #[tokio::test]
    async fn readyz_reports_unready_when_dependencies_are_down() {
        let app = routes::router(test_state());
        let response = app
            .oneshot(Request::get("/readyz").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn api_error_shape_matches_node_contract() {
        let response = axum::response::IntoResponse::into_response(error::ApiError::Validation(
            "bad field".to_string(),
        ));
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["error"], "VALIDATION_ERROR");
        assert_eq!(json["details"], "bad field");
    }
}
