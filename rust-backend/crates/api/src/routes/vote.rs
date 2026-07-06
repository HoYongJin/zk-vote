//! The privacy-critical voting path.
//!
//! `/proof` (authenticated): Merkle path + a single-use ticket bound to the
//! election and root only — the server never learns a nullifier here
//! (AR-H5). `/submit` (anonymous by design — NO auth extractor): 4-signal
//! validation, on-chain nullifier preflight, validate-then-consume ticket
//! (audit M1), serialized relaying (AR-M5), and front-run reconciliation
//! (AR-L8).

use crate::auth::CurrentUser;
use crate::error::ApiError;
use crate::leases;
use crate::ratelimit;
use crate::state::AppState;
use crate::tickets::{self, TicketPayload};
use alloy::primitives::{Address, U256};
use axum::extract::{Path, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;
use zkvote_chain::{
    connect_election, preflight_submit_tally, submit_tally, ChainConfig, ChainError,
};
use zkvote_domain::services::{
    check_submission, SubmitCheck, SubmitRejection, PUBLIC_SIGNAL_NULLIFIER_INDEX,
};
use zkvote_zkp::merkle::FixedMerkleTree;

/// L-proof-rl: a generous per-voter cap on `/proof` ticket issuance. The window
/// matches `tickets::TICKET_EXPIRY_SECONDS` (300s) so the budget and the ticket
/// lifetime stay aligned; 30 per window is far above any human re-proof rate
/// (ticket expiry, MERKLE_ROOT_OUT_OF_SYNC retry, the ticket-burn restore path)
/// yet bounds Redis-memory abuse from a registered voter.
const PROOF_RATE_LIMIT: u64 = 30;
const PROOF_RATE_WINDOW_SECS: u64 = 300;

fn coded(status: u16, code: &'static str, details: impl Into<String>) -> ApiError {
    ApiError::Coded {
        status,
        code,
        details: details.into(),
    }
}

fn invalid_ticket() -> ApiError {
    coded(
        403,
        "INVALID_OR_EXPIRED_TICKET",
        "The submission ticket is invalid, has expired, or has already been used.",
    )
}

fn map_ticket_error(err: ApiError) -> ApiError {
    match err {
        ApiError::Internal(details) if details.starts_with("ticket payload malformed:") => {
            invalid_ticket()
        }
        other => other,
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
        (Some(start), Some(end)) if now >= start && now < end => Ok(()),
        _ => Err(coded(
            403,
            "VOTING_PERIOD_INACTIVE",
            "The voting period is not active.",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;
    use axum::response::IntoResponse;
    use time::Duration;

    fn voting_election(start: OffsetDateTime, end: OffsetDateTime) -> VotingElection {
        VotingElection {
            merkle_tree_depth: 4,
            num_candidates: 2,
            merkle_root: Some("42".to_string()),
            contract_address: Some("0x0000000000000000000000000000000000000001".to_string()),
            voting_start_time: Some(start),
            voting_end_time: Some(end),
            superseded_at: None,
        }
    }

    #[test]
    fn voting_window_is_start_inclusive_and_end_exclusive() {
        let start = OffsetDateTime::from_unix_timestamp(1_780_000_000).unwrap();
        let end = start + Duration::hours(1);
        let election = voting_election(start, end);

        assert!(guard_voting_window(&election, start).is_ok());
        assert!(guard_voting_window(&election, end - Duration::seconds(1)).is_ok());
        assert!(guard_voting_window(&election, end).is_err());
    }

    #[test]
    fn malformed_ticket_payload_maps_to_node_compatible_403() {
        let response = map_ticket_error(ApiError::Internal(
            "ticket payload malformed: unknown field `nullifierHash`".to_string(),
        ))
        .into_response();

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[test]
    fn malformed_proof_values_map_to_node_compatible_invalid_payload() {
        let proof = FormattedProof {
            a: vec!["not-a-field".to_string(), "2".to_string()],
            b: vec![
                vec!["3".to_string(), "4".to_string()],
                vec!["5".to_string(), "6".to_string()],
            ],
            c: vec!["7".to_string(), "8".to_string()],
        };
        let signals = vec![
            "1".to_string(),
            "1".to_string(),
            "1".to_string(),
            "1".to_string(),
        ];
        let err = parse_proof(&proof, &signals).expect_err("malformed values must fail");

        match err {
            ApiError::Coded { status, code, .. } => {
                assert_eq!(status, 400);
                assert_eq!(code, "INVALID_PAYLOAD");
            }
            other => panic!("expected INVALID_PAYLOAD coded error, got {other:?}"),
        }
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

    // L-proof-rl: rate-limit AFTER the registered-voter check (so it never acts
    // as a registration/timing oracle) and BEFORE the expensive leaf fetch +
    // Merkle build (so abusive requests shed load early). Fails closed (503) on
    // a Redis error.
    ratelimit::check_rate(
        &state.redis,
        &format!("proof-rl:{election_id}:{}", user.id),
        PROOF_RATE_LIMIT,
        PROOF_RATE_WINDOW_SECS,
    )
    .await?;

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
            issued_at: None,
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

fn invalid_payload() -> ApiError {
    coded(
        400,
        "INVALID_PAYLOAD",
        "Proof or public signals are missing or malformed.",
    )
}

/// Public SIGNALS live in the BN254 scalar field Fr.
fn parse_u256(value: &str) -> Result<U256, ApiError> {
    let parsed =
        zkvote_domain::services::parse_field_element(value).map_err(|_| invalid_payload())?;
    U256::from_str_radix(&parsed.to_string(), 10).map_err(|_| invalid_payload())
}

/// Groth16 proof COORDINATES (a/b/c) are G1/G2 points over the BN254 base field
/// Fq, which is larger than Fr — validating them against Fr would spuriously
/// reject valid proofs (SOL-VAL-3).
fn parse_u256_base(value: &str) -> Result<U256, ApiError> {
    let parsed =
        zkvote_domain::services::parse_base_field_element(value).map_err(|_| invalid_payload())?;
    U256::from_str_radix(&parsed.to_string(), 10).map_err(|_| invalid_payload())
}

#[derive(Debug)]
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
        // Proof coordinates: base field Fq. Public signals: scalar field Fr.
        a: [parse_u256_base(&proof.a[0])?, parse_u256_base(&proof.a[1])?],
        b: [
            [
                parse_u256_base(&proof.b[0][0])?,
                parse_u256_base(&proof.b[0][1])?,
            ],
            [
                parse_u256_base(&proof.b[1][0])?,
                parse_u256_base(&proof.b[1][1])?,
            ],
        ],
        c: [parse_u256_base(&proof.c[0])?, parse_u256_base(&proof.c[1])?],
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
        .await
        .map_err(map_ticket_error)?
        .ok_or_else(invalid_ticket)?;

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
    let expected_chain_id = state.config.chain_id as u64;
    let onchain = connect_election(&chain, expected_chain_id, contract_address)
        .await
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

    // Run the contract's view/static preflight before GETDEL.
    // Permanent verifier/contract rejections must not burn the one-use ticket;
    // the actual send path still rechecks after consumption to handle races.
    preflight_submit_tally(
        &chain,
        expected_chain_id,
        contract_address,
        args.a,
        args.b,
        args.c,
        args.signals,
    )
    .await
    .map_err(chain_unavailable)?;

    // Serialize the relay per wallet (AR-M5). The relayer EOA has one nonce
    // sequence, so EVERY send from it (deploy + this vote relay) must be
    // single-writer. The cross-instance Redis lease covers multi-instance; the
    // in-process mutex covers concurrency within one process. The deploy path
    // takes the same `chain-relayer:tx` lease, so the two never race the nonce.
    // (Holding both through receipt-wait is acceptable locally; staging splits
    // send/wait.)
    let relayer_lease = leases::acquire(
        &state.redis,
        leases::RELAYER_LEASE_KEY.to_string(),
        leases::RELAYER_LEASE_SECONDS,
        "RELAYER_BUSY",
        "The relayer is processing another transaction. Retry shortly.",
    )
    .await?;
    // Keep the consumed payload so a genuinely-never-landed transient failure
    // can restore the single-use ticket (L-ticket-burn) instead of burning it.
    let mut consumed_payload: Option<TicketPayload> = None;
    let relay_outcome: Result<Result<String, ChainError>, ApiError> = {
        let _serialized = state.relay_lock.lock().await;
        // Consume the ticket only once everything else has passed; the relay
        // itself is the last fallible step.
        match tickets::consume(&state.redis, ticket_token)
            .await
            .map_err(map_ticket_error)
        {
            Err(err) => Err(err),
            Ok(None) => Err(invalid_ticket()),
            Ok(Some(payload)) => {
                consumed_payload = Some(payload);
                Ok(submit_tally(
                    &chain,
                    expected_chain_id,
                    contract_address,
                    args.a,
                    args.b,
                    args.c,
                    args.signals,
                )
                .await)
            }
        }
    };
    if let Err(err) = leases::release(&state.redis, &relayer_lease).await {
        tracing::warn!(error = %err, "failed to release relayer redis lease");
    }
    let relay_result = relay_outcome?;

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
        Err(err) => {
            // The single-use ticket is already consumed at this point. Before
            // surfacing ANY failure, check whether the vote actually landed
            // on-chain — two distinct cases leave the nullifier used despite an
            // Err here, and both must report success, not a spurious failure:
            //   * AR-L8: a third party copied the calldata from the mempool and
            //     mined it first (typically classified Reverted on our send).
            //   * CHAIN-2: send() succeeded but get_receipt() failed transiently
            //     (RPC dropped/timed out/lagging node) — classified Transport —
            //     yet the broadcast may have been mined.
            // Reconciling on every error (not just Reverted) means a receipt-fetch
            // blip no longer burns the voter's ticket for a vote that succeeded.
            if onchain.nullifier_used(nullifier).await.unwrap_or(false) {
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
            // L-ticket-burn: at this point the nullifier is confirmed NOT used
            // on-chain, so the tx genuinely never landed. For a RETRYABLE
            // transport error, restore the single-use ticket so the voter can
            // retry /submit without re-proving — on-chain nullifier uniqueness
            // makes any redundant later relay revert harmlessly. A non-retryable
            // Reverted proof is permanently invalid and is NOT restored (else a
            // known-bad proof could be resubmitted indefinitely, burning gas).
            if err.is_retryable() {
                if let Some(payload) = consumed_payload.take() {
                    if let Err(restore_err) =
                        tickets::restore(&state.redis, ticket_token, &payload).await
                    {
                        tracing::warn!(
                            error = %restore_err,
                            "failed to restore ticket after transient relay failure"
                        );
                    }
                }
            }
            Err(chain_unavailable(err))
        }
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
        // G7: the anonymous /submit caller must never receive raw chain/RPC
        // error text — ChainError::{Reverted,Transport,Config} can carry node
        // URLs, provider JSON-RPC internals, or contract revert payloads. Log
        // the detail server-side; return a stable, generic rejection.
        tracing::warn!(error = %err, "submit rejected by chain (non-retryable)");
        coded(
            400,
            "PROOF_REJECTED",
            "The submitted proof was rejected by the verifier contract.",
        )
    }
}
