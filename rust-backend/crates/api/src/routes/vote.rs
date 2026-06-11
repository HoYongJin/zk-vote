//! Phase 13: the privacy-critical voting path (Milestone D).
//!
//! `/proof` (authenticated): Merkle path + a single-use ticket bound to the
//! election and root only — the server never learns a nullifier here
//! (AR-H5). `/submit` (anonymous by design — NO auth extractor): 4-signal
//! validation, on-chain nullifier preflight, validate-then-consume ticket
//! (audit M1), serialized relaying (AR-M5), and front-run reconciliation
//! (AR-L8).

use crate::auth::CurrentUser;
use crate::error::ApiError;
use crate::state::AppState;
use crate::tickets::{self, TicketPayload};
use alloy::primitives::{Address, U256};
use axum::extract::{Path, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;
use zkvote_chain::{connect_election, submit_tally, ChainConfig, ChainError};
use zkvote_domain::services::{
    check_submission, SubmitCheck, SubmitRejection, PUBLIC_SIGNAL_NULLIFIER_INDEX,
};
use zkvote_zkp::merkle::FixedMerkleTree;

fn coded(status: u16, code: &'static str, details: impl Into<String>) -> ApiError {
    ApiError::Coded {
        status,
        code,
        details: details.into(),
    }
}

#[derive(sqlx::FromRow)]
struct VotingElection {
    merkle_tree_depth: i32,
    num_candidates: i32,
    merkle_root: Option<String>,
    contract_address: Option<String>,
    voting_start_time: Option<OffsetDateTime>,
    voting_end_time: Option<OffsetDateTime>,
    superseded_at: Option<OffsetDateTime>,
}

async fn load_voting_election(
    pool: &sqlx::PgPool,
    election_id: Uuid,
) -> Result<VotingElection, ApiError> {
    sqlx::query_as::<_, VotingElection>(
        "SELECT merkle_tree_depth, num_candidates, merkle_root, contract_address, \
                voting_start_time, voting_end_time, superseded_at \
         FROM elections WHERE id = $1",
    )
    .bind(election_id)
    .fetch_optional(pool)
    .await
    .map_err(zkvote_db::DbError::from)?
    .ok_or_else(|| {
        coded(
            404,
            "ELECTION_NOT_FOUND",
            format!("Election with ID {election_id} not found."),
        )
    })
}

fn guard_voting_window(election: &VotingElection, now: OffsetDateTime) -> Result<(), ApiError> {
    if election.superseded_at.is_some() {
        // AR-M7: a superseded election must never accept app-relayed votes.
        return Err(coded(
            409,
            "ELECTION_SUPERSEDED",
            "This election was superseded; votes are no longer accepted.",
        ));
    }
    if election.merkle_root.is_none() || election.contract_address.is_none() {
        return Err(coded(
            403,
            "NOT_FINALIZED",
            "Voting for this election is not yet finalized by the admin.",
        ));
    }
    match (election.voting_start_time, election.voting_end_time) {
        (Some(start), Some(end)) if now >= start && now <= end => Ok(()),
        _ => Err(coded(
            403,
            "VOTING_PERIOD_INACTIVE",
            "The voting period is not active.",
        )),
    }
}

// ---------------------------------------------------------------------------
// POST /api/elections/:election_id/proof  (authenticated)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct ProofResponse {
    pub success: bool,
    pub message: String,
    #[serde(rename = "submissionTicket")]
    pub submission_ticket: String,
    pub root: String,
    #[serde(rename = "pathElements")]
    pub path_elements: Vec<String>,
    #[serde(rename = "pathIndices")]
    pub path_indices: Vec<u8>,
}

pub async fn proof(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(election_id): Path<Uuid>,
) -> Result<Json<ProofResponse>, ApiError> {
    let now = OffsetDateTime::now_utc();
    let election = load_voting_election(&state.pg, election_id).await?;
    guard_voting_window(&election, now)?;

    let commitment: Option<Option<String>> = sqlx::query_scalar(
        "SELECT user_secret_commitment FROM voters \
         WHERE election_id = $1 AND user_id = $2",
    )
    .bind(election_id)
    .bind(user.id)
    .fetch_optional(&state.pg)
    .await
    .map_err(zkvote_db::DbError::from)?;
    let commitment = commitment.flatten().ok_or_else(|| {
        coded(
            403,
            "NOT_A_REGISTERED_VOTER",
            "The authenticated user is not registered for this election.",
        )
    })?;

    let leaves: Vec<String> = sqlx::query_scalar(
        "SELECT user_secret_commitment FROM voters \
         WHERE election_id = $1 AND user_secret_commitment IS NOT NULL ORDER BY id",
    )
    .bind(election_id)
    .fetch_all(&state.pg)
    .await
    .map_err(zkvote_db::DbError::from)?;

    let tree = FixedMerkleTree::build(election.merkle_tree_depth.max(0) as usize, &leaves)
        .map_err(|err| ApiError::Internal(format!("Merkle build failed: {err}")))?;
    let root = tree.root();
    if Some(root.as_str()) != election.merkle_root.as_deref() {
        return Err(coded(
            409,
            "MERKLE_ROOT_OUT_OF_SYNC",
            "The Merkle proof root is out of sync with the finalized election root.",
        ));
    }
    let index = leaves
        .iter()
        .position(|leaf| leaf == &commitment)
        .ok_or_else(|| {
            ApiError::Internal("registered commitment missing from the tree".to_string())
        })?;
    let path = tree
        .path(index)
        .map_err(|err| ApiError::Internal(format!("Merkle path failed: {err}")))?;

    // Election + root binding ONLY — no nullifier (AR-H5).
    let ticket = tickets::issue(
        &state.redis,
        &TicketPayload {
            election_id,
            merkle_root: root.clone(),
        },
    )
    .await?;

    Ok(Json(ProofResponse {
        success: true,
        message: "Merkle proof generated successfully.".to_string(),
        submission_ticket: ticket,
        root,
        path_elements: path.path_elements,
        path_indices: path.path_indices,
    }))
}

// ---------------------------------------------------------------------------
// POST /api/elections/:election_id/submit  (anonymous by design)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct FormattedProof {
    pub a: Vec<String>,
    pub b: Vec<Vec<String>>,
    pub c: Vec<String>,
}

#[derive(Deserialize)]
pub struct SubmitBody {
    #[serde(rename = "formattedProof")]
    pub formatted_proof: Option<FormattedProof>,
    #[serde(rename = "publicSignals", default)]
    pub public_signals: Vec<String>,
    #[serde(rename = "submissionTicket")]
    pub submission_ticket: Option<String>,
}

#[derive(Serialize)]
pub struct SubmitResponse {
    pub success: bool,
    pub message: String,
    #[serde(rename = "transactionHash", skip_serializing_if = "Option::is_none")]
    pub transaction_hash: Option<String>,
}

fn parse_u256(value: &str) -> Result<U256, ApiError> {
    let parsed = zkvote_domain::services::parse_field_element(value)
        .map_err(|_| ApiError::Validation("Proof or public signals are malformed.".to_string()))?;
    U256::from_str_radix(&parsed.to_string(), 10)
        .map_err(|_| ApiError::Validation("Proof value out of range.".to_string()))
}

struct ProofArgs {
    a: [U256; 2],
    b: [[U256; 2]; 2],
    c: [U256; 2],
    signals: [U256; 4],
}

fn parse_proof(proof: &FormattedProof, signals: &[String]) -> Result<ProofArgs, ApiError> {
    let invalid = || {
        coded(
            400,
            "INVALID_PAYLOAD",
            "Proof or public signals are missing or malformed.",
        )
    };
    if proof.a.len() != 2
        || proof.b.len() != 2
        || proof.b.iter().any(|row| row.len() != 2)
        || proof.c.len() != 2
        || signals.len() != 4
    {
        return Err(invalid());
    }
    Ok(ProofArgs {
        a: [parse_u256(&proof.a[0])?, parse_u256(&proof.a[1])?],
        b: [
            [parse_u256(&proof.b[0][0])?, parse_u256(&proof.b[0][1])?],
            [parse_u256(&proof.b[1][0])?, parse_u256(&proof.b[1][1])?],
        ],
        c: [parse_u256(&proof.c[0])?, parse_u256(&proof.c[1])?],
        signals: [
            parse_u256(&signals[0])?,
            parse_u256(&signals[1])?,
            parse_u256(&signals[2])?,
            parse_u256(&signals[3])?,
        ],
    })
}

fn submit_rejection(rejection: SubmitRejection) -> ApiError {
    let (status, code): (u16, &'static str) = match rejection {
        SubmitRejection::MalformedSignals => (400, "INVALID_PAYLOAD"),
        SubmitRejection::TicketElectionMismatch => (403, "TICKET_ELECTION_MISMATCH"),
        SubmitRejection::ElectionIdMismatch => (400, "ELECTION_ID_MISMATCH"),
        SubmitRejection::RootMismatch => (400, "MERKLE_ROOT_MISMATCH"),
        SubmitRejection::CandidateOutOfRange => (400, "INVALID_CANDIDATE_INDEX"),
    };
    coded(status, code, rejection.to_string())
}

pub async fn submit(
    State(state): State<AppState>,
    Path(election_id): Path<Uuid>,
    Json(body): Json<SubmitBody>,
) -> Result<Json<SubmitResponse>, ApiError> {
    let now = OffsetDateTime::now_utc();
    let formatted = body
        .formatted_proof
        .as_ref()
        .ok_or_else(|| coded(400, "INVALID_PAYLOAD", "Proof is missing."))?;
    let args = parse_proof(formatted, &body.public_signals)?;
    let ticket_token = body.submission_ticket.as_deref().ok_or_else(|| {
        coded(
            401,
            "SUBMISSION_TICKET_REQUIRED",
            "A valid submission ticket is required to vote.",
        )
    })?;

    let election = load_voting_election(&state.pg, election_id).await?;
    guard_voting_window(&election, now)?;
    let contract_address: Address = election
        .contract_address
        .as_deref()
        .and_then(|addr| addr.parse().ok())
        .ok_or_else(|| ApiError::Internal("contract address invalid".to_string()))?;

    // Peek (non-destructive): the ticket survives every later rejection
    // except a successful (or front-run-completed) relay (audit M1).
    let ticket = tickets::read(&state.redis, ticket_token)
        .await?
        .ok_or_else(|| {
            coded(
                403,
                "INVALID_OR_EXPIRED_TICKET",
                "The submission ticket is invalid, has expired, or has already been used.",
            )
        })?;

    let merkle_root = election.merkle_root.as_deref().unwrap_or_default();
    check_submission(&SubmitCheck {
        public_signals: &body.public_signals,
        route_election_id: election_id,
        ticket_election_id: ticket.election_id,
        election_merkle_root: merkle_root,
        ticket_merkle_root: &ticket.merkle_root,
        num_candidates: election.num_candidates.max(0) as u64,
    })
    .map_err(submit_rejection)?;

    let rpc_url = state
        .config
        .rpc_url
        .clone()
        .ok_or_else(|| ApiError::Internal("SEPOLIA_RPC_URL is not configured".to_string()))?;
    let relayer_key =
        state.config.relayer_private_key.clone().ok_or_else(|| {
            ApiError::Internal("RELAYER_PRIVATE_KEY is not configured".to_string())
        })?;
    let chain = ChainConfig {
        rpc_url,
        relayer_private_key: relayer_key,
    };

    let nullifier = args.signals[PUBLIC_SIGNAL_NULLIFIER_INDEX];
    let onchain = connect_election(&chain, contract_address)
        .map_err(|err| ApiError::Internal(format!("chain connect failed: {err}")))?;
    if onchain
        .nullifier_used(nullifier)
        .await
        .map_err(chain_unavailable)?
    {
        return Err(coded(
            409,
            "VOTE_ALREADY_CAST",
            "This nullifier has already been used for this election.",
        ));
    }

    // Serialize the relay per wallet (AR-M5): concurrent sends from the one
    // relayer key race on nonces and burn tickets. (Holding the lock through
    // receipt-wait is acceptable locally; staging splits send/wait.)
    let relay_result = {
        let _serialized = state.relay_lock.lock().await;
        // Consume the ticket only once everything else has passed; the relay
        // itself is the last fallible step.
        if tickets::consume(&state.redis, ticket_token)
            .await?
            .is_none()
        {
            return Err(coded(
                403,
                "INVALID_OR_EXPIRED_TICKET",
                "The submission ticket was already used or expired.",
            ));
        }
        submit_tally(
            &chain,
            contract_address,
            args.a,
            args.b,
            args.c,
            args.signals,
        )
        .await
    };

    match relay_result {
        Ok(tx_hash) => {
            let _ = zkvote_db::repos::SubmissionRepo::record(
                &state.pg,
                election_id,
                &nullifier.to_string(),
                "confirmed",
                Some(&tx_hash),
            )
            .await;
            Ok(Json(SubmitResponse {
                success: true,
                message: "Your vote has been successfully and anonymously cast.".to_string(),
                transaction_hash: Some(tx_hash),
            }))
        }
        Err(ChainError::Reverted(reason)) => {
            // AR-L8: a third party may have copied the calldata from the
            // mempool and landed it first. The vote IS counted; report
            // success instead of a spurious failure.
            let used = onchain.nullifier_used(nullifier).await.unwrap_or(false);
            if used {
                let _ = zkvote_db::repos::SubmissionRepo::record(
                    &state.pg,
                    election_id,
                    &nullifier.to_string(),
                    "confirmed",
                    None,
                )
                .await;
                return Ok(Json(SubmitResponse {
                    success: true,
                    message:
                        "Your vote was already recorded on-chain (completed by another transaction)."
                            .to_string(),
                    transaction_hash: None,
                }));
            }
            Err(coded(400, "PROOF_REJECTED", reason))
        }
        Err(err) => Err(chain_unavailable(err)),
    }
}

fn chain_unavailable(err: ChainError) -> ApiError {
    if err.is_retryable() {
        coded(
            502,
            "CHAIN_UNAVAILABLE",
            "The blockchain RPC is unreachable; please retry.",
        )
    } else {
        coded(400, "PROOF_REJECTED", err.to_string())
    }
}
