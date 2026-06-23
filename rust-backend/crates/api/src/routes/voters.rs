//! Voter allowlisting and registration, race-safe via a Postgres
//! advisory transaction lock per election. Privacy model (audit H2): the
//! client generates and keeps the secret; only the Poseidon commitment
//! H(secret) reaches this API. AR-H6: a registered voter may re-bind a new
//! commitment until registration closes ("reset my registration").

use crate::auth::{AdminUser, CurrentUser};
use crate::error::ApiError;
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;
use zkvote_db::{with_transaction, DbError, Tx};
use zkvote_domain::services::{check_allowlist_capacity, parse_field_element};

fn coded(status: u16, code: &'static str, details: impl Into<String>) -> ApiError {
    ApiError::Coded {
        status,
        code,
        details: details.into(),
    }
}

async fn lock_election(tx: &mut Tx, election_id: Uuid) -> Result<(), DbError> {
    // Serializes every allowlist/registration critical section for one
    // election without Redis: the lock is released at COMMIT/ROLLBACK.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(election_id.to_string())
        .execute(&mut **tx)
        .await?;
    Ok(())
}

#[derive(sqlx::FromRow)]
struct ElectionGuardRow {
    registration_end_time: OffsetDateTime,
    merkle_root: Option<String>,
    merkle_tree_depth: i32,
    superseded_at: Option<OffsetDateTime>,
}

async fn load_election_for_update(
    tx: &mut Tx,
    election_id: Uuid,
) -> Result<Option<ElectionGuardRow>, DbError> {
    Ok(sqlx::query_as::<_, ElectionGuardRow>(
        "SELECT registration_end_time, merkle_root, merkle_tree_depth, superseded_at \
         FROM elections WHERE id = $1 FOR UPDATE",
    )
    .bind(election_id)
    .fetch_optional(&mut **tx)
    .await?)
}

fn guard_open_registration(election: &ElectionGuardRow) -> Result<(), ApiError> {
    if election.superseded_at.is_some() {
        return Err(coded(
            409,
            "ELECTION_SUPERSEDED",
            "This election was superseded and cannot be modified.",
        ));
    }
    if election.merkle_root.is_some() {
        return Err(coded(
            409,
            "ALREADY_FINALIZED",
            "This election has already been finalized.",
        ));
    }
    if OffsetDateTime::now_utc() > election.registration_end_time {
        return Err(coded(
            403,
            "REGISTRATION_PERIOD_ENDED",
            "The registration period for this election has ended.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::Duration;

    fn open_election() -> ElectionGuardRow {
        ElectionGuardRow {
            registration_end_time: OffsetDateTime::now_utc() + Duration::hours(1),
            merkle_root: None,
            merkle_tree_depth: 4,
            superseded_at: None,
        }
    }

    #[test]
    fn registration_guard_rejects_superseded_elections() {
        let mut election = open_election();
        election.superseded_at = Some(OffsetDateTime::now_utc());

        let err = guard_open_registration(&election).expect_err("superseded row must fail");

        assert!(matches!(
            err,
            ApiError::Coded {
                status: 409,
                code: "ELECTION_SUPERSEDED",
                ..
            }
        ));
    }
}

fn election_not_found(election_id: Uuid) -> ApiError {
    coded(
        404,
        "ELECTION_NOT_FOUND",
        format!("Election with ID {election_id} not found."),
    )
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

// ---------------------------------------------------------------------------
// POST /api/elections/:election_id/voters  (admin allowlist)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct AllowlistBody {
    #[serde(default)]
    pub emails: Vec<String>,
}

#[derive(Serialize)]
pub struct AllowlistSummary {
    pub newly_registered_count: usize,
    pub duplicates_skipped_count: usize,
    pub invalid_format_skipped_count: usize,
}

#[derive(Serialize)]
pub struct AllowlistResponse {
    pub success: bool,
    pub message: String,
    pub summary: AllowlistSummary,
}

pub async fn allowlist_voters(
    State(state): State<AppState>,
    AdminUser(_admin): AdminUser,
    Path(election_id): Path<Uuid>,
    Json(body): Json<AllowlistBody>,
) -> Result<Json<AllowlistResponse>, ApiError> {
    let mut invalid = 0usize;
    let mut normalized: Vec<String> = Vec::new();
    for email in &body.emails {
        match normalize_email(email) {
            Some(email) => normalized.push(email),
            None => invalid += 1,
        }
    }
    normalized.sort();
    normalized.dedup();

    if normalized.is_empty() {
        if invalid > 0 {
            return Err(coded(
                400,
                "NO_VALID_EMAILS",
                "No valid email addresses were found in the provided list.",
            ));
        }
        return Ok(Json(AllowlistResponse {
            success: true,
            message: "No emails provided to register.".to_string(),
            summary: AllowlistSummary {
                newly_registered_count: 0,
                duplicates_skipped_count: 0,
                invalid_format_skipped_count: 0,
            },
        }));
    }

    let emails = normalized.clone();
    let outcome: Result<(usize, usize), ApiError> = with_transaction(&state.pg, move |tx| {
        Box::pin(async move {
            lock_election(tx, election_id).await?;
            let election = load_election_for_update(tx, election_id).await?;
            let Some(election) = election else {
                return Ok(Err(election_not_found(election_id)));
            };
            if let Err(rejection) = guard_open_registration(&election) {
                return Ok(Err(rejection));
            }

            // `email` is citext (case-insensitive), but the dedup below is a
            // case-sensitive Rust comparison. Lower-case the stored values so a
            // mixed-case row already present (e.g. from an import) is recognized
            // as existing instead of being re-inserted into a citext UNIQUE
            // violation (500). The upload side is already lower-cased above.
            let existing: Vec<String> = sqlx::query_scalar(
                "SELECT lower(email::text) FROM voters WHERE election_id = $1 AND email = ANY($2)",
            )
            .bind(election_id)
            .bind(&emails)
            .fetch_all(&mut **tx)
            .await?;
            let to_insert: Vec<&String> =
                emails.iter().filter(|e| !existing.contains(e)).collect();

            let current: i64 =
                sqlx::query_scalar("SELECT count(*) FROM voters WHERE election_id = $1")
                    .bind(election_id)
                    .fetch_one(&mut **tx)
                    .await?;
            if check_allowlist_capacity(
                current as u64,
                to_insert.len() as u64,
                election.merkle_tree_depth as u32,
            )
            .is_err()
            {
                return Ok(Err(coded(
                    409,
                    "OVER_CAPACITY",
                    format!(
                        "Adding {} voter(s) would exceed this election's Merkle capacity of {} (currently {} allowlisted).",
                        to_insert.len(),
                        1u64 << election.merkle_tree_depth,
                        current
                    ),
                )));
            }

            let mut inserted = 0usize;
            for email in &to_insert {
                sqlx::query("INSERT INTO voters (election_id, email) VALUES ($1, $2)")
                    .bind(election_id)
                    .bind(email)
                    .execute(&mut **tx)
                    .await?;
                inserted += 1;
            }
            Ok(Ok((inserted, emails.len() - inserted)))
        })
    })
    .await?;
    let (inserted, duplicates) = outcome?;

    Ok(Json(AllowlistResponse {
        success: true,
        message: format!("Admin voter registration process completed for election {election_id}."),
        summary: AllowlistSummary {
            newly_registered_count: inserted,
            duplicates_skipped_count: duplicates,
            invalid_format_skipped_count: invalid,
        },
    }))
}

// ---------------------------------------------------------------------------
// POST /api/elections/:election_id/register  (voter, commitment-based)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct RegisterBody {
    pub name: Option<String>,
    #[serde(rename = "secretCommitment")]
    pub secret_commitment: Option<String>,
}

#[derive(Serialize)]
pub struct RegisterResponse {
    pub success: bool,
    pub message: String,
}

pub async fn register_voter(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(election_id): Path<Uuid>,
    Json(body): Json<RegisterBody>,
) -> Result<Json<RegisterResponse>, ApiError> {
    let name = body
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .ok_or_else(|| {
            ApiError::Validation(
                "A non-empty 'name' must be provided in the request body.".to_string(),
            )
        })?
        .to_string();
    let commitment = body
        .secret_commitment
        .as_deref()
        .and_then(|raw| parse_field_element(raw).ok())
        .ok_or_else(|| {
            ApiError::Validation(
                "A valid client-generated secretCommitment is required.".to_string(),
            )
        })?
        .to_string();
    let email = user.email.clone().ok_or_else(|| {
        ApiError::Validation("The authenticated user email is invalid.".to_string())
    })?;
    let user_id = user.id;

    let outcome: Result<&'static str, ApiError> = with_transaction(&state.pg, move |tx| {
        Box::pin(async move {
            lock_election(tx, election_id).await?;
            let election = load_election_for_update(tx, election_id).await?;
            let Some(election) = election else {
                return Ok(Err(election_not_found(election_id)));
            };
            if let Err(rejection) = guard_open_registration(&election) {
                return Ok(Err(rejection));
            }

            let voter: Option<(Uuid, Option<Uuid>)> = sqlx::query_as(
                "SELECT id, user_id FROM voters WHERE election_id = $1 AND email = $2",
            )
            .bind(election_id)
            .bind(&email)
            .fetch_optional(&mut **tx)
            .await?;
            let Some((voter_id, bound_user)) = voter else {
                return Ok(Err(coded(
                    403,
                    "NOT_ON_VOTER_LIST",
                    "This email is not on the pre-approved list for this election.",
                )));
            };

            // G1: a commitment must be unique within an election. Two voters
            // sharing one commitment produce identical Merkle leaves and one
            // shared nullifier, so on-chain only ONE can vote — the other is
            // silently disenfranchised (409 VOTE_ALREADY_CAST, unrecoverable
            // once registration closes). The advisory lock above serializes this
            // check; the partial UNIQUE index (migration 0005) is the backstop.
            let commitment_taken: Option<Uuid> = sqlx::query_scalar(
                "SELECT id FROM voters \
                 WHERE election_id = $1 AND user_secret_commitment = $2 AND id <> $3",
            )
            .bind(election_id)
            .bind(&commitment)
            .bind(voter_id)
            .fetch_optional(&mut **tx)
            .await?;
            if commitment_taken.is_some() {
                return Ok(Err(coded(
                    409,
                    "COMMITMENT_ALREADY_USED",
                    "This secret commitment is already registered by another voter for \
                     this election. Generate a new secret and try again.",
                )));
            }

            match bound_user {
                // AR-H6: same user may replace a lost secret's commitment
                // until registration closes.
                Some(bound) if bound == user_id => {
                    sqlx::query(
                        "UPDATE voters SET user_secret_commitment = $2, name = $3, \
                             registered_at = now() WHERE id = $1",
                    )
                    .bind(voter_id)
                    .bind(&commitment)
                    .bind(&name)
                    .execute(&mut **tx)
                    .await?;
                    Ok(Ok("re-bound"))
                }
                Some(_) => Ok(Err(coded(
                    409,
                    "ALREADY_REGISTERED",
                    "This voter has already completed the registration process for this election.",
                ))),
                None => {
                    let updated = sqlx::query(
                        "UPDATE voters SET user_id = $2, name = $3, \
                             user_secret_commitment = $4, registered_at = now() \
                         WHERE id = $1 AND user_id IS NULL",
                    )
                    .bind(voter_id)
                    .bind(user_id)
                    .bind(&name)
                    .bind(&commitment)
                    .execute(&mut **tx)
                    .await?;
                    if updated.rows_affected() == 1 {
                        Ok(Ok("registered"))
                    } else {
                        Ok(Err(coded(
                            409,
                            "ALREADY_REGISTERED",
                            "This voter has already completed the registration process for this election.",
                        )))
                    }
                }
            }
        })
    })
    .await?;
    let kind = outcome?;

    Ok(Json(RegisterResponse {
        success: true,
        message: if kind == "re-bound" {
            "Voter registration updated: a new secret commitment was bound.".to_string()
        } else {
            "Voter registration completed successfully.".to_string()
        },
    }))
}
