use crate::auth::{is_admin_or_promote, is_superadmin, CurrentUser};
use crate::error::ApiError;
use crate::state::AppState;
use axum::extract::State;
use axum::Json;
use serde::Serialize;
use uuid::Uuid;

#[derive(Serialize)]
pub struct MeResponse {
    pub id: Uuid,
    pub email: Option<String>,
    pub is_admin: bool,
    /// GOV-1 second tier: true only for a non-revoked superadmin. The frontend
    /// uses this to hide/disable the high-blast-radius controls (addAdmins,
    /// setZkDeploy) so an ordinary admin is not shown buttons that 403.
    pub is_superadmin: bool,
}

/// Role endpoint that serves the frontend's admin-status check server-side
/// (architecture review AR-H4). Also the place where a pending admin
/// invitation takes effect on first login (audit H5).
pub async fn me(
    State(state): State<AppState>,
    user: CurrentUser,
) -> Result<Json<MeResponse>, ApiError> {
    let is_admin = is_admin_or_promote(&state.pg, &user).await?;
    // Only meaningful for admins; skip the extra query for ordinary voters.
    let is_superadmin = is_admin && is_superadmin(&state.pg, user.id).await?;
    Ok(Json(MeResponse {
        id: user.id,
        email: user.email,
        is_admin,
        is_superadmin,
    }))
}
