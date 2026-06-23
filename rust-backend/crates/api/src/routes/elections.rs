//! Read-only election list routes. Visibility rules: admins see every
//! election in the relevant lifecycle window, voters see only elections they
//! are allowlisted/registered for.

use crate::auth::{is_admin_or_promote, CurrentUser};
use crate::error::ApiError;
use crate::state::AppState;
use axum::extract::State;
use axum::Json;
use serde::Serialize;
use time::OffsetDateTime;
use uuid::Uuid;
use zkvote_db::repos::{Election, ElectionRepo, ElectionWithCounts};

#[derive(Serialize)]
pub struct RegisterableRow {
    pub id: Uuid,
    pub name: String,
    pub candidates: serde_json::Value,
    pub contract_address: Option<String>,
    #[serde(with = "time::serde::rfc3339")]
    pub registration_end_time: OffsetDateTime,
    /// Present only for non-admin voters.
    #[serde(rename = "isRegistered", skip_serializing_if = "Option::is_none")]
    pub is_registered: Option<bool>,
}

#[derive(Serialize)]
pub struct FinalizedRow {
    pub id: Uuid,
    pub name: String,
    pub candidates: serde_json::Value,
    #[serde(with = "time::serde::rfc3339::option")]
    pub voting_end_time: Option<OffsetDateTime>,
    pub contract_address: Option<String>,
    pub merkle_tree_depth: i32,
    pub num_candidates: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_voters: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub registered_voters: Option<i64>,
}

#[derive(Serialize)]
pub struct CompletedRow {
    pub id: Uuid,
    pub name: String,
    pub candidates: serde_json::Value,
    #[serde(with = "time::serde::rfc3339::option")]
    pub voting_end_time: Option<OffsetDateTime>,
    pub contract_address: Option<String>,
}

fn registerable_row(election: Election, is_registered: Option<bool>) -> RegisterableRow {
    RegisterableRow {
        id: election.id,
        name: election.name,
        candidates: election.candidates,
        contract_address: election.contract_address,
        registration_end_time: election.registration_end_time,
        is_registered,
    }
}

fn finalized_row(row: ElectionWithCounts, include_counts: bool) -> FinalizedRow {
    let (total_voters, registered_voters) = if include_counts {
        (Some(row.total_voters), Some(row.registered_voters))
    } else {
        (None, None)
    };
    FinalizedRow {
        id: row.election.id,
        name: row.election.name,
        candidates: row.election.candidates,
        voting_end_time: row.election.voting_end_time,
        contract_address: row.election.contract_address,
        merkle_tree_depth: row.election.merkle_tree_depth,
        num_candidates: row.election.num_candidates,
        total_voters,
        registered_voters,
    }
}

fn completed_row(election: Election) -> CompletedRow {
    CompletedRow {
        id: election.id,
        name: election.name,
        candidates: election.candidates,
        voting_end_time: election.voting_end_time,
        contract_address: election.contract_address,
    }
}

/// GET /api/elections/registerable
pub async fn registerable(
    State(state): State<AppState>,
    user: CurrentUser,
) -> Result<Json<Vec<RegisterableRow>>, ApiError> {
    let now = OffsetDateTime::now_utc();
    if is_admin_or_promote(&state.pg, &user).await? {
        let rows = ElectionRepo::list_registerable(&state.pg, now).await?;
        return Ok(Json(
            rows.into_iter()
                .map(|election| registerable_row(election, None))
                .collect(),
        ));
    }

    let Some(email) = user.email.clone() else {
        return Ok(Json(Vec::new()));
    };
    let rows = ElectionRepo::list_registerable_for_email(&state.pg, now, &email).await?;
    Ok(Json(
        rows.into_iter()
            .map(|row| registerable_row(row.election, Some(row.is_registered)))
            .collect(),
    ))
}

/// GET /api/elections/finalized
pub async fn finalized(
    State(state): State<AppState>,
    user: CurrentUser,
) -> Result<Json<Vec<FinalizedRow>>, ApiError> {
    let now = OffsetDateTime::now_utc();
    let is_admin = is_admin_or_promote(&state.pg, &user).await?;
    let rows = if is_admin {
        ElectionRepo::list_voting_with_counts(&state.pg, now).await?
    } else {
        ElectionRepo::list_voting_for_user(&state.pg, now, user.id).await?
    };
    Ok(Json(
        rows.into_iter()
            .map(|row| finalized_row(row, is_admin))
            .collect(),
    ))
}

/// GET /api/elections/completed
pub async fn completed(
    State(state): State<AppState>,
    user: CurrentUser,
) -> Result<Json<Vec<CompletedRow>>, ApiError> {
    let rows = if is_admin_or_promote(&state.pg, &user).await? {
        ElectionRepo::list_completed(&state.pg).await?
    } else {
        ElectionRepo::list_completed_for_user(&state.pg, user.id).await?
    };
    Ok(Json(rows.into_iter().map(completed_row).collect()))
}
