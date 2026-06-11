//! Phase 8 admin setup routes. Validation parity with the Node reference
//! (`setVote.js` M4 caps, `addAdmins.js` invitation upsert) — see
//! docs/API_COMPATIBILITY.md.

use crate::auth::AdminUser;
use crate::error::ApiError;
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use uuid::Uuid;
use zkvote_db::repos::{AdminRepo, Election, ElectionRepo, NewElection, ZkArtifactRepo};
use zkvote_domain::services::validate_election_input;

// ---------------------------------------------------------------------------
// POST /api/elections/set
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct CreateElectionBody {
    pub name: Option<String>,
    #[serde(rename = "merkleTreeDepth")]
    pub merkle_tree_depth: Option<u32>,
    pub candidates: Option<Vec<String>>,
    #[serde(rename = "regEndTime")]
    pub reg_end_time: Option<String>,
}

#[derive(Serialize)]
pub struct ElectionResponse {
    pub id: Uuid,
    pub name: String,
    pub state: String,
    pub merkle_tree_depth: i32,
    pub num_candidates: i32,
    pub candidates: serde_json::Value,
    #[serde(with = "time::serde::rfc3339")]
    pub registration_start_time: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub registration_end_time: OffsetDateTime,
    pub contract_address: Option<String>,
    pub completed: bool,
}

impl From<Election> for ElectionResponse {
    fn from(election: Election) -> Self {
        Self {
            id: election.id,
            name: election.name,
            state: election.state,
            merkle_tree_depth: election.merkle_tree_depth,
            num_candidates: election.num_candidates,
            candidates: election.candidates,
            registration_start_time: election.registration_start_time,
            registration_end_time: election.registration_end_time,
            contract_address: election.contract_address,
            completed: election.completed,
        }
    }
}

#[derive(Serialize)]
pub struct CreateElectionResponse {
    pub success: bool,
    pub message: String,
    pub election: ElectionResponse,
}

pub async fn create_election(
    State(state): State<AppState>,
    AdminUser(_admin): AdminUser,
    Json(body): Json<CreateElectionBody>,
) -> Result<(StatusCode, Json<CreateElectionResponse>), ApiError> {
    let name = body.name.unwrap_or_default();
    let depth = body.merkle_tree_depth.unwrap_or(0);
    let candidates = body.candidates.unwrap_or_default();
    let reg_end_raw = body.reg_end_time.unwrap_or_default();

    let registration_end = OffsetDateTime::parse(&reg_end_raw, &Rfc3339).map_err(|_| {
        ApiError::Validation(
            "`regEndTime` must be a valid ISO 8601 date string set in the future.".to_string(),
        )
    })?;
    let now = OffsetDateTime::now_utc();
    let (name, candidates) =
        validate_election_input(&name, depth, &candidates, registration_end, now)
            .map_err(ApiError::Validation)?;

    let election = ElectionRepo::create(
        &state.pg,
        &NewElection {
            name,
            merkle_tree_depth: depth as i32,
            candidates,
            registration_end_time: registration_end,
        },
    )
    .await?;

    Ok((
        StatusCode::CREATED,
        Json(CreateElectionResponse {
            success: true,
            message: "New election record created successfully.".to_string(),
            election: election.into(),
        }),
    ))
}

// ---------------------------------------------------------------------------
// POST /api/management/addAdmins
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct AddAdminBody {
    pub email: Option<String>,
}

#[derive(Serialize)]
pub struct AddAdminResponse {
    pub success: bool,
    pub message: String,
    /// Always false in the Rust port: there is no Supabase Auth Admin API
    /// here (AR-L4 decision); invited users are promoted on their first
    /// authenticated request instead (audit H5).
    #[serde(rename = "promotedExistingUser")]
    pub promoted_existing_user: bool,
}

fn normalize_email(raw: &str) -> Option<String> {
    let normalized = raw.trim().to_lowercase();
    let mut parts = normalized.split('@');
    match (parts.next(), parts.next(), parts.next()) {
        (Some(local), Some(domain), None)
            if !local.is_empty() && domain.contains('.') && !domain.ends_with('.') =>
        {
            Some(normalized)
        }
        _ => None,
    }
}

pub async fn add_admins(
    State(state): State<AppState>,
    AdminUser(_admin): AdminUser,
    Json(body): Json<AddAdminBody>,
) -> Result<(StatusCode, Json<AddAdminResponse>), ApiError> {
    let raw = body.email.ok_or_else(|| {
        ApiError::Validation("Email is required in the request body.".to_string())
    })?;
    let email = normalize_email(&raw)
        .ok_or_else(|| ApiError::Validation("Invalid email format provided.".to_string()))?;

    AdminRepo::upsert_invitation(&state.pg, &email).await?;

    Ok((
        StatusCode::CREATED,
        Json(AddAdminResponse {
            success: true,
            message: format!(
                "Successfully added {email} to the admin invitation list. The user is granted admin access on their next sign-in."
            ),
            promoted_existing_user: false,
        }),
    ))
}

// ---------------------------------------------------------------------------
// POST /api/elections/:election_id/setZkDeploy
// ---------------------------------------------------------------------------

/// Deployment guard (Phase 8 gates): rejects unknown elections, already
/// deployed elections, and — until the Phase 10 artifact pipeline and the
/// Phase 11 chain layer land — any election without a registered artifact
/// set. Artifact generation and contract deployment stay on the Node
/// backend until then; this route never silently half-deploys.
pub async fn set_zk_deploy(
    State(state): State<AppState>,
    AdminUser(_admin): AdminUser,
    Path(election_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let election = ElectionRepo::find(&state.pg, election_id)
        .await?
        .ok_or_else(|| ApiError::NotFound(format!("Election with ID {election_id} not found.")))?;

    if election.contract_address.is_some() {
        return Err(ApiError::Conflict(
            "The smart contract for this election has already been deployed.".to_string(),
        ));
    }

    let artifact = ZkArtifactRepo::find_by_shape(
        &state.pg,
        election.merkle_tree_depth,
        election.num_candidates,
    )
    .await?;
    if artifact.is_none() {
        // Phase 8 gate: missing ZK artifacts block deployment setup.
        return Err(ApiError::Validation(format!(
            "No registered ZK artifact set for depth {} / {} candidates. \
             Artifact generation is not ported yet (Phase 10); deploy through the Node backend.",
            election.merkle_tree_depth, election.num_candidates
        )));
    }

    Err(ApiError::Internal(
        "Contract deployment through the Rust API lands with the Phase 11 chain layer.".to_string(),
    ))
}

// ---------------------------------------------------------------------------
// POST /api/elections/:election_id/complete  (Phase 14)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct CompleteResponse {
    pub success: bool,
    pub message: String,
}

pub async fn complete_election(
    State(state): State<AppState>,
    AdminUser(_admin): AdminUser,
    Path(election_id): Path<Uuid>,
) -> Result<Json<CompleteResponse>, ApiError> {
    let election = ElectionRepo::find(&state.pg, election_id)
        .await?
        .ok_or_else(|| ApiError::NotFound(format!("Election with ID {election_id} not found.")))?;

    use zkvote_domain::services::{check_completion, CompletionRejection};
    if let Err(rejection) = check_completion(
        OffsetDateTime::now_utc(),
        election.voting_end_time,
        election.completed,
    ) {
        let (status, code, details): (u16, &'static str, &str) = match rejection {
            CompletionRejection::AlreadyCompleted => (
                409,
                "ALREADY_COMPLETED",
                "This election is already marked as completed.",
            ),
            CompletionRejection::VotingNotStarted => (
                400,
                "VOTING_NOT_STARTED",
                "This election does not have a voting end time yet.",
            ),
            CompletionRejection::VotingActive => (
                403,
                "VOTING_PERIOD_ACTIVE",
                "Cannot complete the election before voting ends.",
            ),
        };
        return Err(ApiError::Coded {
            status,
            code,
            details: details.to_string(),
        });
    }

    // Guarded, idempotent (Node parity: `.eq("completed", false)`).
    if !ElectionRepo::mark_completed(&state.pg, election_id).await? {
        return Err(ApiError::Coded {
            status: 409,
            code: "ALREADY_COMPLETED",
            details: "This election was completed by a concurrent request.".to_string(),
        });
    }

    Ok(Json(CompleteResponse {
        success: true,
        message: "Election marked as completed.".to_string(),
    }))
}
