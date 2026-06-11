use crate::auth::AdminUser;
use axum::Json;
use serde::Serialize;

#[derive(Serialize)]
pub struct AdminPingResponse {
    pub status: &'static str,
}

/// Minimal admin-gated endpoint proving the AdminUser extractor end to end
/// (Phase 5 gate: admin-only routes reject non-admin users). The Phase 8
/// admin routes supersede it as the real admin surface.
pub async fn ping(AdminUser(_user): AdminUser) -> Json<AdminPingResponse> {
    Json(AdminPingResponse { status: "ok" })
}
