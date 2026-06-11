pub mod admin;
pub mod health;
pub mod me;

use crate::state::AppState;
use axum::routing::get;
use axum::Router;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(health::healthz))
        .route("/readyz", get(health::readyz))
        // Authenticated surface. Anonymous-by-design endpoints (the future
        // /api/elections/:id/submit port) must NOT use the auth extractors.
        .route("/api/me", get(me::me))
        .route("/api/admin/ping", get(admin::ping))
        .with_state(state)
}
