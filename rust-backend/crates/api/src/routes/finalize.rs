//! Recoverable finalization (post-H4 semantics).
//!
//! Order of operations is the safety property:
//!   1. durably close registration in Postgres (fail-closed across crashes)
//!   2. snapshot registered commitments and build the Merkle root (AR-H7
//!      bit-exact tree)
//!   3. configureElection on-chain (owner key, AR-M4), idempotent when the
//!      contract is already configured with the same root
//!   4. revalidate the snapshot, then sync the DB exactly once
//!
//! A finalization_jobs row tracks every step for retry/audit.

use crate::auth::AdminUser;
use crate::error::ApiError;
use crate::leases;
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;
use zkvote_chain::{
    address_for_private_key, configure_election, connect_election, ChainConfig, ChainError,
};
use zkvote_db::repos::{ElectionRepo, JobRepo};
use zkvote_db::{with_transaction, DbError, Tx};
use zkvote_domain::services::{check_finalization, FinalizationCheck, FinalizationRejection};
use zkvote_domain::ElectionState;
use zkvote_zkp::merkle::FixedMerkleTree;

fn coded(status: u16, code: &'static str, details: impl Into<String>) -> ApiError {
    ApiError::Coded {
        status,
        code,
        details: details.into(),
    }
}

#[derive(Deserialize)]
pub struct FinalizeBody {
    #[serde(rename = "voteEndTime")]
    pub vote_end_time: Option<String>,
    /// AR-M7: the voting period is immutable on-chain; exceeding the
    /// configured maximum duration requires this explicit confirmation.
    #[serde(rename = "confirmExtendedDuration", default)]
    pub confirm_extended_duration: bool,
}

#[derive(Serialize)]
pub struct FinalizeResponse {
    pub success: bool,
    pub message: String,
    #[serde(rename = "merkleRoot")]
    pub merkle_root: String,
}

struct Snapshot {
    leaves: Vec<String>,
    registration_closed_at: OffsetDateTime,
}

#[derive(sqlx::FromRow)]
struct FinalizationElectionRow {
    contract_address: Option<String>,
    merkle_root: Option<String>,
    registration_end_time: OffsetDateTime,
    superseded_at: Option<OffsetDateTime>,
}

async fn close_and_snapshot(
    tx: &mut Tx,
    election_id: Uuid,
    now: OffsetDateTime,
    vote_end: OffsetDateTime,
) -> Result<Result<Snapshot, ApiError>, DbError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(election_id.to_string())
        .execute(&mut **tx)
        .await?;

    let row: Option<FinalizationElectionRow> = sqlx::query_as(
        "SELECT contract_address, merkle_root, registration_end_time, superseded_at \
         FROM elections WHERE id = $1 FOR UPDATE",
    )
    .bind(election_id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some(row) = row else {
        return Ok(Err(coded(
            404,
            "ELECTION_NOT_FOUND",
            format!("Election with ID {election_id} not found."),
        )));
    };

    if row.superseded_at.is_some() {
        return Ok(Err(coded(
            409,
            "ELECTION_SUPERSEDED",
            "This election was superseded; finalization is no longer allowed.",
        )));
    }

    let registered: Vec<String> = sqlx::query_scalar(
        "SELECT user_secret_commitment FROM voters \
         WHERE election_id = $1 AND user_secret_commitment IS NOT NULL \
         ORDER BY id",
    )
    .bind(election_id)
    .fetch_all(&mut **tx)
    .await?;

    if let Err(rejection) = check_finalization(&FinalizationCheck {
        now,
        contract_deployed: row.contract_address.is_some(),
        already_finalized: row.merkle_root.is_some(),
        registered_voters: registered.len() as u64,
        vote_end,
    }) {
        let (status, code, details): (u16, &'static str, String) = match rejection {
            FinalizationRejection::ContractNotDeployed => (
                400,
                "STATE_ERROR",
                "The smart contract for this election has not been deployed yet.".into(),
            ),
            FinalizationRejection::AlreadyFinalized => (
                409,
                "ALREADY_FINALIZED",
                "This election's registration period has already been finalized.".into(),
            ),
            FinalizationRejection::NoVotersRegistered => (
                400,
                "NO_VOTERS_REGISTERED",
                "Cannot finalize: No voters have completed their registration.".into(),
            ),
            FinalizationRejection::VoteEndNotInFuture => (
                400,
                "VALIDATION_ERROR",
                "`voteEndTime` must be set in the future.".into(),
            ),
        };
        return Ok(Err(coded(status, code, details)));
    }

    // Durable fail-closed close (audit H4/M3): even if the process crashes
    // after the on-chain transaction, registration stays closed in Postgres.
    let registration_closed_at = now.min(row.registration_end_time);
    let closed = sqlx::query(
        "UPDATE elections SET registration_end_time = $2, state = $3 \
         WHERE id = $1 AND merkle_root IS NULL",
    )
    .bind(election_id)
    .bind(registration_closed_at)
    .bind(ElectionState::Finalizing.to_string())
    .execute(&mut **tx)
    .await?;
    if closed.rows_affected() != 1 {
        return Ok(Err(coded(
            409,
            "FINALIZATION_STATE_CONFLICT",
            "Could not durably close registration before finalization.",
        )));
    }

    Ok(Ok(Snapshot {
        leaves: registered,
        registration_closed_at,
    }))
}

async fn current_leaves(pool: &sqlx::PgPool, election_id: Uuid) -> Result<Vec<String>, DbError> {
    Ok(sqlx::query_scalar(
        "SELECT user_secret_commitment FROM voters \
         WHERE election_id = $1 AND user_secret_commitment IS NOT NULL \
         ORDER BY id",
    )
    .bind(election_id)
    .fetch_all(pool)
    .await?)
}

pub async fn finalize(
    State(state): State<AppState>,
    AdminUser(_admin): AdminUser,
    Path(election_id): Path<Uuid>,
    Json(body): Json<FinalizeBody>,
) -> Result<Json<FinalizeResponse>, ApiError> {
    let now = OffsetDateTime::now_utc();
    let vote_end = body
        .vote_end_time
        .as_deref()
        .and_then(|raw| OffsetDateTime::parse(raw, &Rfc3339).ok())
        .ok_or_else(|| {
            ApiError::Validation(
                "`voteEndTime` must be provided as a valid ISO 8601 date string.".to_string(),
            )
        })?;

    // AR-M7: the configured voting period is immutable on-chain.
    let max_duration = Duration::days(state.config.max_voting_duration_days);
    if vote_end - now > max_duration && !body.confirm_extended_duration {
        return Err(coded(
            400,
            "VOTING_DURATION_EXCEEDS_MAXIMUM",
            format!(
                "The requested voting window exceeds the {}-day maximum and the period is immutable on-chain. Pass `confirmExtendedDuration: true` to proceed deliberately.",
                state.config.max_voting_duration_days
            ),
        ));
    }

    let rpc_url = state
        .config
        .rpc_url
        .clone()
        .ok_or_else(|| ApiError::Internal("SEPOLIA_RPC_URL is not configured".to_string()))?;
    let relayer_key =
        state.config.relayer_private_key.clone().ok_or_else(|| {
            ApiError::Internal("RELAYER_PRIVATE_KEY is not configured".to_string())
        })?;
    let owner_key = state.config.owner_private_key.clone().ok_or_else(|| {
        coded(
            503,
            "CHAIN_CONFIG_MISSING",
            "OWNER_PRIVATE_KEY must be configured so the hot relayer key cannot own or configure VotingTally.",
        )
    })?;
    let relayer = address_for_private_key(&relayer_key).map_err(chain_config_error)?;
    let owner = address_for_private_key(&owner_key).map_err(chain_config_error)?;
    if owner == relayer {
        return Err(coded(
            503,
            "CHAIN_CONFIG_INVALID",
            "OWNER_PRIVATE_KEY and RELAYER_PRIVATE_KEY must be different keys (AR-M4): \
             the cold owner key must not equal the hot relayer key.",
        ));
    }
    let chain = ChainConfig {
        rpc_url,
        relayer_private_key: relayer_key,
    };

    let lease = leases::acquire(
        &state.redis,
        leases::finalize_lease_key(&election_id),
        leases::FINALIZE_LEASE_SECONDS,
        "FINALIZATION_IN_PROGRESS",
        "Finalization for this election is already in progress.",
    )
    .await?;

    let result = finalize_locked(&state, election_id, now, vote_end, &chain, &owner_key).await;

    if let Err(err) = leases::release(&state.redis, &lease).await {
        tracing::warn!(error = %err, "failed to release finalize redis lease");
    }

    result
}

/// The serialized finalization body: durably close registration, build the
/// root, configure on-chain (with idempotent recovery), revalidate, and sync
/// the DB exactly once. Runs under the per-election finalize lease.
async fn finalize_locked(
    state: &AppState,
    election_id: Uuid,
    now: OffsetDateTime,
    vote_end: OffsetDateTime,
    chain: &ChainConfig,
    owner_key: &str,
) -> Result<Json<FinalizeResponse>, ApiError> {
    // Step 1+2: durably close registration and snapshot, atomically.
    let snapshot: Result<Snapshot, ApiError> = with_transaction(&state.pg, move |tx| {
        Box::pin(async move { close_and_snapshot(tx, election_id, now, vote_end).await })
    })
    .await?;
    let snapshot = snapshot?;

    let tree = FixedMerkleTree::build(merkle_depth(state, election_id).await?, &snapshot.leaves)
        .map_err(|err| ApiError::Internal(format!("Merkle build failed: {err}")))?;
    let root = tree.root();

    let job_id = JobRepo::create(&state.pg, election_id, &root).await?;

    // Step 3: on-chain configuration (idempotent recovery path included).
    let election = ElectionRepo::find(&state.pg, election_id)
        .await?
        .ok_or_else(|| coded(404, "ELECTION_NOT_FOUND", "Election vanished mid-flight."))?;
    let contract_address = election
        .contract_address
        .as_deref()
        .and_then(|addr| addr.parse().ok())
        .ok_or_else(|| coded(400, "STATE_ERROR", "Contract address is missing/invalid."))?;
    let expected_chain_id = state.config.chain_id as u64;
    let onchain = connect_election(chain, expected_chain_id, contract_address)
        .await
        .map_err(|err| ApiError::Internal(format!("chain connect failed: {err}")))?;

    let root_u256 = alloy::primitives::U256::from_str_radix(&root, 10)
        .map_err(|err| ApiError::Internal(format!("root parse failed: {err}")))?;

    macro_rules! chain_try {
        ($expr:expr) => {
            match $expr {
                Ok(value) => value,
                Err(err) => return Err(chain_api_error(state, job_id, err).await),
            }
        };
    }

    let (voting_start, voting_end_final, tx_hash) = if chain_try!(onchain.configured().await) {
        // Recovery: a previous attempt configured the contract but failed
        // before the DB sync. Reconcile only when the root matches.
        let onchain_root = chain_try!(onchain.merkle_root().await);
        if onchain_root != root_u256 {
            JobRepo::set_status(
                &state.pg,
                job_id,
                "failed",
                None,
                Some("on-chain root mismatch"),
            )
            .await?;
            return Err(coded(
                409,
                "ON_CHAIN_STATE_MISMATCH",
                "The contract is already configured with a different Merkle root. Manual reconciliation is required.",
            ));
        }
        let start = chain_try!(onchain.voting_start_time().await);
        let end = chain_try!(onchain.voting_end_time().await);
        (from_unix(start)?, from_unix(end)?, None)
    } else {
        // L-trunc: the contract stores whole-second timestamps; truncate BEFORE
        // both the chain call and the DB tuple so the fresh path and the recovery
        // path (which reads whole seconds back from chain) agree bit-for-bit.
        let now = truncate_to_seconds(now)?;
        let vote_end = truncate_to_seconds(vote_end)?;
        // After truncation a sub-second window collapses to start == end, which
        // configureElection rejects (require start < end). Fail with a clean 400
        // here rather than a confusing post-revert 500 for a valid-looking input.
        if vote_end <= now {
            JobRepo::set_status(
                &state.pg,
                job_id,
                "failed",
                None,
                Some("voting window shorter than one second"),
            )
            .await?;
            return Err(coded(
                400,
                "VOTING_WINDOW_TOO_SHORT",
                "The voting window must be at least one whole second; choose a later vote end time.",
            ));
        }
        JobRepo::set_status(&state.pg, job_id, "onchain_sent", None, None).await?;
        let owner_lease = leases::acquire(
            &state.redis,
            leases::OWNER_LEASE_KEY.to_string(),
            leases::OWNER_LEASE_SECONDS,
            "OWNER_BUSY",
            "The owner key is configuring another election. Retry shortly.",
        )
        .await?;
        let configure_result = configure_election(
            chain,
            expected_chain_id,
            owner_key,
            contract_address,
            root_u256,
            alloy::primitives::U256::from(now.unix_timestamp() as u64),
            alloy::primitives::U256::from(vote_end.unix_timestamp() as u64),
        )
        .await;
        if let Err(err) = leases::release(&state.redis, &owner_lease).await {
            tracing::warn!(error = %err, "failed to release owner redis lease");
        }
        let tx_hash = match configure_result {
            Ok(tx_hash) => tx_hash,
            Err(err) => return Err(chain_api_error(state, job_id, err).await),
        };
        JobRepo::set_status(&state.pg, job_id, "onchain_confirmed", Some(&tx_hash), None).await?;
        (now, vote_end, Some(tx_hash))
    };

    // Step 4: revalidate the snapshot before the DB sync (audit H4).
    let revalidated = current_leaves(&state.pg, election_id).await?;
    if revalidated != snapshot.leaves {
        JobRepo::set_status(&state.pg, job_id, "failed", None, Some("snapshot changed")).await?;
        return Err(coded(
            500,
            "FINALIZATION_SNAPSHOT_CHANGED",
            "On-chain finalization succeeded, but the voter snapshot changed before database synchronization. Manual reconciliation is required.",
        ));
    }

    let synced = ElectionRepo::finalize_sync(
        &state.pg,
        election_id,
        &root,
        snapshot.registration_closed_at,
        voting_start,
        voting_end_final,
    )
    .await?;
    if !synced {
        JobRepo::set_status(&state.pg, job_id, "failed", None, Some("db sync raced")).await?;
        return Err(coded(
            500,
            "FINALIZATION_DB_SYNC_FAILED",
            "On-chain finalization succeeded, but the database row was already finalized by another writer.",
        ));
    }
    JobRepo::set_status(&state.pg, job_id, "db_synced", tx_hash.as_deref(), None).await?;

    Ok(Json(FinalizeResponse {
        success: true,
        message: "Election finalized and voting has started successfully.".to_string(),
        merkle_root: root,
    }))
}

async fn merkle_depth(state: &AppState, election_id: Uuid) -> Result<usize, ApiError> {
    let depth: Option<i32> =
        sqlx::query_scalar("SELECT merkle_tree_depth FROM elections WHERE id = $1")
            .bind(election_id)
            .fetch_optional(&state.pg)
            .await
            .map_err(zkvote_db::DbError::from)?;
    Ok(depth.unwrap_or(0).max(0) as usize)
}

fn from_unix(value: alloy::primitives::U256) -> Result<OffsetDateTime, ApiError> {
    let secs: i64 = value
        .try_into()
        .map_err(|_| ApiError::Internal("on-chain timestamp out of range".to_string()))?;
    OffsetDateTime::from_unix_timestamp(secs)
        .map_err(|err| ApiError::Internal(format!("invalid on-chain timestamp: {err}")))
}

/// L-trunc: drops sub-second precision so the value written to the DB matches the
/// whole-second value the contract stores (and the recovery path reads back).
fn truncate_to_seconds(t: OffsetDateTime) -> Result<OffsetDateTime, ApiError> {
    OffsetDateTime::from_unix_timestamp(t.unix_timestamp())
        .map_err(|err| ApiError::Internal(format!("timestamp truncation failed: {err}")))
}

fn chain_config_error(err: ChainError) -> ApiError {
    coded(
        503,
        "CHAIN_CONFIG_INVALID",
        format!("Invalid chain key configuration: {err}"),
    )
}

/// Classifies chain failures into the API error vocabulary and records the
/// job failure. Reverts are permanent (ON_CHAIN_ERROR); transport errors are
/// retryable (502).
async fn chain_api_error(state: &AppState, job_id: Uuid, err: ChainError) -> ApiError {
    let retryable = err.is_retryable();
    let _ = JobRepo::set_status(&state.pg, job_id, "failed", None, Some(&err.to_string())).await;
    if retryable {
        coded(
            502,
            "CHAIN_UNAVAILABLE",
            "The blockchain RPC is unreachable; the finalization can be retried.",
        )
    } else {
        coded(
            500,
            "ON_CHAIN_ERROR",
            format!("Smart contract execution failed: {err}"),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::{AdminUser, CurrentUser};
    use crate::config::AppConfig;
    use axum::extract::{Path, State};
    use axum::Json;
    use redis::Client as RedisClient;
    use std::sync::Arc;

    #[tokio::test]
    async fn finalize_requires_explicit_owner_key_before_db_or_chain() {
        let config = Arc::new(
            AppConfig::from_lookup(|name| match name {
                "DATABASE_URL" => Some("postgres://example".to_string()),
                "REDIS_URL" => Some("redis://localhost:1".to_string()),
                "SEPOLIA_RPC_URL" => Some("http://127.0.0.1:8545".to_string()),
                "RELAYER_PRIVATE_KEY" => Some("0x1234".to_string()),
                _ => None,
            })
            .unwrap(),
        );
        let state = AppState {
            pg: zkvote_db::connect_lazy(&config.database_url).unwrap(),
            redis: RedisClient::open(config.redis_url.as_str()).unwrap(),
            auth: None,
            relay_lock: Arc::new(tokio::sync::Mutex::new(())),
            config,
        };
        let vote_end = (OffsetDateTime::now_utc() + Duration::hours(1))
            .format(&Rfc3339)
            .unwrap();

        let result = finalize(
            State(state),
            AdminUser(CurrentUser {
                id: Uuid::new_v4(),
                email: Some("admin@example.com".to_string()),
            }),
            Path(Uuid::new_v4()),
            Json(FinalizeBody {
                vote_end_time: Some(vote_end),
                confirm_extended_duration: false,
            }),
        )
        .await;
        let Err(err) = result else {
            panic!("missing OWNER_PRIVATE_KEY must fail closed");
        };

        assert!(matches!(
            err,
            ApiError::Coded {
                status: 503,
                code: "CHAIN_CONFIG_MISSING",
                ..
            }
        ));
    }

    #[tokio::test]
    async fn finalize_rejects_same_owner_and_relayer_key_before_db_or_chain() {
        let config = Arc::new(
            AppConfig::from_lookup(|name| match name {
                "DATABASE_URL" => Some("postgres://example".to_string()),
                "REDIS_URL" => Some("redis://localhost:1".to_string()),
                "SEPOLIA_RPC_URL" => Some("http://127.0.0.1:8545".to_string()),
                "RELAYER_PRIVATE_KEY" => Some(
                    "0x59c6995e998f97a5a0044966f094538fef40b1dbb44b67533a5edb8f6bbd2a65"
                        .to_string(),
                ),
                "OWNER_PRIVATE_KEY" => Some(
                    "0x59c6995e998f97a5a0044966f094538fef40b1dbb44b67533a5edb8f6bbd2a65"
                        .to_string(),
                ),
                _ => None,
            })
            .unwrap(),
        );
        let state = AppState {
            pg: zkvote_db::connect_lazy(&config.database_url).unwrap(),
            redis: RedisClient::open(config.redis_url.as_str()).unwrap(),
            auth: None,
            relay_lock: Arc::new(tokio::sync::Mutex::new(())),
            config,
        };
        let vote_end = (OffsetDateTime::now_utc() + Duration::hours(1))
            .format(&Rfc3339)
            .unwrap();

        let result = finalize(
            State(state),
            AdminUser(CurrentUser {
                id: Uuid::new_v4(),
                email: Some("admin@example.com".to_string()),
            }),
            Path(Uuid::new_v4()),
            Json(FinalizeBody {
                vote_end_time: Some(vote_end),
                confirm_extended_duration: false,
            }),
        )
        .await;
        let Err(err) = result else {
            panic!("equal OWNER_PRIVATE_KEY and RELAYER_PRIVATE_KEY must fail closed");
        };

        assert!(matches!(
            err,
            ApiError::Coded {
                status: 503,
                code: "CHAIN_CONFIG_INVALID",
                ..
            }
        ));
    }
}
