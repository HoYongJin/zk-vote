pub mod health;

use crate::state::AppState;
use axum::routing::get;
use axum::Router;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(health::healthz))
        .route("/readyz", get(health::readyz))
        .with_state(state)
}
