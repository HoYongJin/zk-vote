use crate::auth::{is_admin_or_promote, CurrentUser};
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
}

/// Role endpoint replacing the frontend's direct Supabase `Admins` read
/// (architecture review AR-H4; consumed by the frontend in Phase 15). Also
/// the place where a pending admin invitation takes effect on first login
/// (audit H5 parity).
pub async fn me(
    State(state): State<AppState>,
    user: CurrentUser,
) -> Result<Json<MeResponse>, ApiError> {
    let is_admin = is_admin_or_promote(&state.pg, &user).await?;
    Ok(Json(MeResponse {
        id: user.id,
        email: user.email,
        is_admin,
    }))
}
