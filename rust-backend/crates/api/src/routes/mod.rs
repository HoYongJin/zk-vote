pub mod admin;
pub mod artifacts;
pub mod elections;
pub mod finalize;
pub mod health;
pub mod manage;
pub mod me;
pub mod vote;
pub mod voters;

use crate::state::AppState;
use axum::routing::{get, post};
use axum::Router;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(health::healthz))
        .route("/readyz", get(health::readyz))
        // Authenticated surface. Anonymous-by-design endpoints (submit)
        // must NOT use the auth extractors.
        .route("/api/me", get(me::me))
        .route("/api/admin/ping", get(admin::ping))
        .route("/api/elections/registerable", get(elections::registerable))
        .route("/api/elections/finalized", get(elections::finalized))
        .route("/api/elections/completed", get(elections::completed))
        .route("/api/elections/set", post(manage::create_election))
        .route("/api/management/addAdmins", post(manage::add_admins))
        .route(
            "/api/admin/zk-artifacts",
            post(manage::register_zk_artifact),
        )
        .route(
            "/api/elections/:election_id/setZkDeploy",
            post(manage::set_zk_deploy),
        )
        .route(
            "/api/elections/:election_id/supersede",
            post(manage::supersede_election),
        )
        .route(
            "/api/elections/:election_id/voters",
            post(voters::allowlist_voters),
        )
        .route(
            "/api/elections/:election_id/register",
            post(voters::register_voter),
        )
        .route(
            "/api/elections/:election_id/finalize",
            post(finalize::finalize),
        )
        .route(
            "/api/elections/:election_id/complete",
            post(manage::complete_election),
        )
        .route(
            "/api/elections/:election_id/artifact-info",
            get(artifacts::artifact_info),
        )
        .route("/api/zkp-files/*artifact_path", get(artifacts::zkp_file))
        .route("/api/elections/:election_id/proof", post(vote::proof))
        // Anonymous by design: no auth extractor on submit (privacy model).
        .route("/api/elections/:election_id/submit", post(vote::submit))
        .with_state(state)
}
