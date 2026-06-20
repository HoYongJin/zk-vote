//! Phase 8 admin setup routes. Validation parity with the Node reference
//! (`setVote.js` M4 caps, `addAdmins.js` invitation upsert) — see
//! docs/API_COMPATIBILITY.md.

use crate::auth::AdminUser;
use crate::error::ApiError;
use crate::state::AppState;
use alloy::primitives::{Address, U256};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path as FsPath, PathBuf};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use uuid::Uuid;
use zkvote_chain::{address_for_private_key, deploy_election, ChainConfig, ChainError};
use zkvote_db::repos::{
    AdminRepo, DeploymentRepo, Election, ElectionRepo, NewElection, ZkArtifact, ZkArtifactRepo,
};
use zkvote_domain::services::{
    election_id_to_field, validate_election_input, PUBLIC_SIGNAL_COUNT,
    PUBLIC_SIGNAL_ELECTION_ID_INDEX,
};

fn coded(status: u16, code: &'static str, details: impl Into<String>) -> ApiError {
    ApiError::Coded {
        status,
        code,
        details: details.into(),
    }
}

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

const DEPLOYMENT_LOCK_SECONDS: u64 = 900;
const RELAYER_LOCK_SECONDS: u64 = 900;

#[derive(Serialize)]
pub struct SetZkDeployResponse {
    pub success: bool,
    pub message: String,
    #[serde(rename = "contractAddress")]
    pub contract_address: String,
    #[serde(rename = "verifierAddress")]
    pub verifier_address: String,
    #[serde(rename = "deployTxHash")]
    pub deploy_tx_hash: String,
    #[serde(rename = "artifactId")]
    pub artifact_id: Uuid,
}

struct RedisLease {
    key: String,
    token: String,
}

async fn acquire_redis_lease(
    client: &redis::Client,
    key: String,
    ttl_seconds: u64,
    conflict_code: &'static str,
    conflict_details: &'static str,
) -> Result<RedisLease, ApiError> {
    let token = Uuid::new_v4().to_string();
    let mut conn = client
        .get_multiplexed_async_connection()
        .await
        .map_err(ApiError::from)?;
    let reply: Option<String> = redis::cmd("SET")
        .arg(&key)
        .arg(&token)
        .arg("NX")
        .arg("EX")
        .arg(ttl_seconds)
        .query_async(&mut conn)
        .await
        .map_err(ApiError::from)?;

    if reply.as_deref() == Some("OK") {
        Ok(RedisLease { key, token })
    } else {
        Err(coded(409, conflict_code, conflict_details))
    }
}

async fn release_redis_lease(client: &redis::Client, lease: &RedisLease) -> Result<(), ApiError> {
    let mut conn = client
        .get_multiplexed_async_connection()
        .await
        .map_err(ApiError::from)?;
    let _: i32 = redis::Script::new(
        "if redis.call('GET', KEYS[1]) == ARGV[1] then \
             return redis.call('DEL', KEYS[1]) \
         else \
             return 0 \
         end",
    )
    .key(&lease.key)
    .arg(&lease.token)
    .invoke_async(&mut conn)
    .await
    .map_err(ApiError::from)?;
    Ok(())
}

fn string_is_blank(value: &Option<String>) -> bool {
    value
        .as_deref()
        .map(str::trim)
        .unwrap_or_default()
        .is_empty()
}

fn ensure_election_not_superseded(election: &Election) -> Result<(), ApiError> {
    if election.superseded_at.is_some() {
        return Err(coded(
            409,
            "ELECTION_SUPERSEDED",
            "This election was superseded and must be replaced by a new election row.",
        ));
    }
    Ok(())
}

fn object_field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.as_object()?.get(key)
}

fn u64_field(value: &Value, keys: &[&str]) -> Option<u64> {
    keys.iter().find_map(|key| {
        let field = object_field(value, key)?;
        field
            .as_u64()
            .or_else(|| field.as_str().and_then(|raw| raw.parse().ok()))
    })
}

fn nested_u64_field(value: &Value, object_key: &str, keys: &[&str]) -> Option<u64> {
    let nested = object_field(value, object_key)?;
    u64_field(nested, keys)
}

fn signal_index_from_array(value: &Value) -> Option<u64> {
    for key in ["publicSignals", "public_signals"] {
        let Some(signals) = object_field(value, key).and_then(Value::as_array) else {
            continue;
        };
        for (index, signal) in signals.iter().enumerate() {
            let name = signal
                .as_str()
                .or_else(|| object_field(signal, "name").and_then(Value::as_str))?;
            if matches!(name, "election_id" | "electionId") {
                return Some(index as u64);
            }
        }
    }
    None
}

fn ensure_deployable_artifact(artifact: &ZkArtifact) -> Result<(), ApiError> {
    if string_is_blank(&artifact.wasm_uri)
        || string_is_blank(&artifact.zkey_uri)
        || string_is_blank(&artifact.verification_key_uri)
        || string_is_blank(&artifact.solidity_verifier_uri)
    {
        return Err(coded(
            409,
            "ARTIFACT_MANIFEST_INCOMPLETE",
            "The selected artifact is missing one or more deploy-time artifact URIs.",
        ));
    }

    let signal_count = u64_field(
        &artifact.manifest,
        &["publicSignalCount", "public_signal_count"],
    )
    .or_else(|| nested_u64_field(&artifact.manifest, "publicSignals", &["count"]))
    .or_else(|| nested_u64_field(&artifact.manifest, "public_signals", &["count"]));
    if signal_count != Some(PUBLIC_SIGNAL_COUNT as u64) {
        return Err(coded(
            409,
            "ARTIFACT_SCHEMA_MISMATCH",
            format!("The selected artifact must declare publicSignalCount={PUBLIC_SIGNAL_COUNT}."),
        ));
    }

    let election_index = u64_field(
        &artifact.manifest,
        &[
            "electionIdIndex",
            "election_id_index",
            "publicSignalElectionIdIndex",
            "public_signal_election_id_index",
        ],
    )
    .or_else(|| {
        nested_u64_field(
            &artifact.manifest,
            "publicSignals",
            &["electionIdIndex", "election_id_index"],
        )
    })
    .or_else(|| {
        nested_u64_field(
            &artifact.manifest,
            "public_signals",
            &["electionIdIndex", "election_id_index"],
        )
    })
    .or_else(|| signal_index_from_array(&artifact.manifest));

    if election_index != Some(PUBLIC_SIGNAL_ELECTION_ID_INDEX as u64) {
        return Err(coded(
            409,
            "ARTIFACT_SCHEMA_MISMATCH",
            format!(
                "The selected artifact must declare electionId at public signal index {PUBLIC_SIGNAL_ELECTION_ID_INDEX}."
            ),
        ));
    }

    Ok(())
}

fn contract_artifact_path(base_dir: &str, contract_folder: &str, contract_name: &str) -> PathBuf {
    FsPath::new(base_dir)
        .join(contract_folder)
        .join(format!("{contract_name}.json"))
}

fn decode_hex_bytecode(raw: &str, path: &FsPath) -> Result<Vec<u8>, ApiError> {
    let hex = raw.strip_prefix("0x").unwrap_or(raw);
    if hex.is_empty() || !hex.len().is_multiple_of(2) {
        return Err(coded(
            409,
            "CONTRACT_ARTIFACT_INVALID",
            format!(
                "Contract artifact {} has malformed bytecode.",
                path.display()
            ),
        ));
    }

    let mut bytes = Vec::with_capacity(hex.len() / 2);
    for pair in hex.as_bytes().chunks_exact(2) {
        let high = hex_nibble(pair[0]).ok_or_else(|| {
            coded(
                409,
                "CONTRACT_ARTIFACT_INVALID",
                format!("Contract artifact {} has non-hex bytecode.", path.display()),
            )
        })?;
        let low = hex_nibble(pair[1]).ok_or_else(|| {
            coded(
                409,
                "CONTRACT_ARTIFACT_INVALID",
                format!("Contract artifact {} has non-hex bytecode.", path.display()),
            )
        })?;
        bytes.push((high << 4) | low);
    }
    Ok(bytes)
}

fn hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn read_contract_bytecode(path: &FsPath) -> Result<Vec<u8>, ApiError> {
    let raw = fs::read_to_string(path).map_err(|err| {
        coded(
            409,
            "CONTRACT_ARTIFACT_MISSING",
            format!("Cannot read contract artifact {}: {err}", path.display()),
        )
    })?;
    let json: Value = serde_json::from_str(&raw).map_err(|err| {
        coded(
            409,
            "CONTRACT_ARTIFACT_INVALID",
            format!(
                "Contract artifact {} is not valid JSON: {err}",
                path.display()
            ),
        )
    })?;
    let bytecode = object_field(&json, "bytecode")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            coded(
                409,
                "CONTRACT_ARTIFACT_INVALID",
                format!(
                    "Contract artifact {} has no bytecode field.",
                    path.display()
                ),
            )
        })?;
    decode_hex_bytecode(bytecode, path)
}

fn deployment_bytecodes(
    base_dir: &str,
    merkle_depth: i32,
    num_candidates: i32,
) -> Result<(Vec<u8>, Vec<u8>), ApiError> {
    let verifier_name = format!("Groth16Verifier_{merkle_depth}_{num_candidates}");
    let verifier_path =
        contract_artifact_path(base_dir, &format!("{verifier_name}.sol"), &verifier_name);
    let tally_path = contract_artifact_path(base_dir, "VotingTally.sol", "VotingTally");
    Ok((
        read_contract_bytecode(&verifier_path)?,
        read_contract_bytecode(&tally_path)?,
    ))
}

fn deployment_chain_config(state: &AppState) -> Result<(ChainConfig, Address), ApiError> {
    let rpc_url = state.config.rpc_url.clone().ok_or_else(|| {
        coded(
            503,
            "CHAIN_CONFIG_MISSING",
            "SEPOLIA_RPC_URL or RPC_URL must be configured before deployment.",
        )
    })?;
    let relayer_private_key = state.config.relayer_private_key.clone().ok_or_else(|| {
        coded(
            503,
            "CHAIN_CONFIG_MISSING",
            "RELAYER_PRIVATE_KEY must be configured before deployment.",
        )
    })?;
    let owner_private_key = state.config.owner_private_key.as_deref().ok_or_else(|| {
        coded(
            503,
            "CHAIN_CONFIG_MISSING",
            "OWNER_PRIVATE_KEY must be configured so the hot relayer key does not own the contract.",
        )
    })?;
    let owner = address_for_private_key(owner_private_key).map_err(chain_config_error)?;
    Ok((
        ChainConfig {
            rpc_url,
            relayer_private_key,
        },
        owner,
    ))
}

fn election_uuid_to_u256(election_id: Uuid) -> Result<U256, ApiError> {
    U256::from_str_radix(&election_id_to_field(&election_id).to_string(), 10)
        .map_err(|err| ApiError::Internal(format!("election id conversion failed: {err}")))
}

fn chain_config_error(err: ChainError) -> ApiError {
    coded(
        503,
        "CHAIN_CONFIG_INVALID",
        format!("Invalid chain configuration: {err}"),
    )
}

fn chain_deploy_error(err: ChainError) -> ApiError {
    if err.is_retryable() {
        coded(
            502,
            "CHAIN_UNAVAILABLE",
            "The blockchain RPC is unreachable; contract deployment can be retried.",
        )
    } else {
        coded(
            500,
            "ON_CHAIN_ERROR",
            format!("Contract deployment failed: {err}"),
        )
    }
}

async fn deploy_with_locked_election(
    state: &AppState,
    election_id: Uuid,
    artifact: ZkArtifact,
    verifier_bytecode: Vec<u8>,
    voting_tally_bytecode: Vec<u8>,
) -> Result<Json<SetZkDeployResponse>, ApiError> {
    let latest = ElectionRepo::find(&state.pg, election_id)
        .await?
        .ok_or_else(|| ApiError::NotFound(format!("Election with ID {election_id} not found.")))?;

    if latest.contract_address.is_some() {
        return Err(ApiError::Conflict(
            "The smart contract for this election has already been deployed.".to_string(),
        ));
    }
    ensure_election_not_superseded(&latest)?;

    let (chain, owner) = deployment_chain_config(state)?;
    let relayer_lease = acquire_redis_lease(
        &state.redis,
        "chain-relayer:tx".to_string(),
        RELAYER_LOCK_SECONDS,
        "RELAYER_BUSY",
        "The relayer is processing another transaction. Retry shortly.",
    )
    .await?;

    let deployed_result = {
        let _local_relay_guard = state.relay_lock.lock().await;
        deploy_election(
            &chain,
            verifier_bytecode,
            voting_tally_bytecode,
            election_uuid_to_u256(election_id)?,
            U256::from(latest.num_candidates as u64),
            owner,
            // §0.5 gap #2: refuse to deploy unless the live RPC reports this chain id.
            state.config.chain_id as u64,
        )
        .await
    };

    if let Err(err) = release_redis_lease(&state.redis, &relayer_lease).await {
        tracing::warn!(error = %err, "failed to release relayer redis lease");
    }

    let deployed = deployed_result.map_err(chain_deploy_error)?;
    let verifier_address = format!("{:#x}", deployed.verifier_address);
    let contract_address = format!("{:#x}", deployed.voting_tally_address);

    let bound = DeploymentRepo::record_and_bind(
        &state.pg,
        election_id,
        Some(artifact.id),
        &verifier_address,
        &contract_address,
        state.config.chain_id,
        &deployed.deploy_tx_hash,
    )
    .await?;
    if !bound {
        return Err(coded(
            409,
            "DEPLOYMENT_STATE_CONFLICT",
            "On-chain deployment succeeded, but another writer already bound this election. Manual reconciliation is required.",
        ));
    }

    Ok(Json(SetZkDeployResponse {
        success: true,
        message: "Smart contracts deployed and recorded successfully.".to_string(),
        contract_address,
        verifier_address,
        deploy_tx_hash: deployed.deploy_tx_hash,
        artifact_id: artifact.id,
    }))
}

/// Deployment guard (Phase 8/11): rejects unknown/already deployed elections,
/// requires a manifest-bound artifact set, serializes deployment with Redis,
/// deploys through the typed chain layer, and atomically records DB metadata.
pub async fn set_zk_deploy(
    State(state): State<AppState>,
    AdminUser(_admin): AdminUser,
    Path(election_id): Path<Uuid>,
) -> Result<Json<SetZkDeployResponse>, ApiError> {
    let election = ElectionRepo::find(&state.pg, election_id)
        .await?
        .ok_or_else(|| ApiError::NotFound(format!("Election with ID {election_id} not found.")))?;

    if election.contract_address.is_some() {
        return Err(ApiError::Conflict(
            "The smart contract for this election has already been deployed.".to_string(),
        ));
    }
    ensure_election_not_superseded(&election)?;

    let artifact = ZkArtifactRepo::find_by_shape(
        &state.pg,
        election.merkle_tree_depth,
        election.num_candidates,
    )
    .await?;
    let Some(artifact) = artifact else {
        // Phase 8 gate: missing ZK artifacts block deployment setup.
        return Err(ApiError::Validation(format!(
            "No registered ZK artifact set for depth {} / {} candidates. \
             Run the artifact pipeline before contract deployment.",
            election.merkle_tree_depth, election.num_candidates
        )));
    };
    ensure_deployable_artifact(&artifact)?;
    let (verifier_bytecode, voting_tally_bytecode) = deployment_bytecodes(
        &state.config.contract_artifacts_dir,
        election.merkle_tree_depth,
        election.num_candidates,
    )?;

    let deploy_lease = acquire_redis_lease(
        &state.redis,
        format!("election:{election_id}:deploy"),
        DEPLOYMENT_LOCK_SECONDS,
        "DEPLOYMENT_IN_PROGRESS",
        "Contract deployment for this election is already in progress.",
    )
    .await?;

    let result = deploy_with_locked_election(
        &state,
        election_id,
        artifact,
        verifier_bytecode,
        voting_tally_bytecode,
    )
    .await;

    if let Err(err) = release_redis_lease(&state.redis, &deploy_lease).await {
        tracing::warn!(error = %err, "failed to release deployment redis lease");
    }

    result
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
        election.superseded_at.is_some(),
    ) {
        let (status, code, details): (u16, &'static str, &str) = match rejection {
            CompletionRejection::AlreadyCompleted => (
                409,
                "ALREADY_COMPLETED",
                "This election is already marked as completed.",
            ),
            CompletionRejection::Superseded => (
                409,
                "ELECTION_SUPERSEDED",
                "This election was superseded and cannot be completed.",
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

    // Guarded, idempotent (Node parity: `.eq("completed", false)`) and
    // fail-closed if the election is superseded after the pre-check.
    if !ElectionRepo::mark_completed(&state.pg, election_id).await? {
        return Err(ApiError::Coded {
            status: 409,
            code: "ELECTION_NOT_COMPLETABLE",
            details: "This election was completed or superseded by a concurrent request."
                .to_string(),
        });
    }

    Ok(Json(CompleteResponse {
        success: true,
        message: "Election marked as completed.".to_string(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn artifact_with_manifest(manifest: Value) -> ZkArtifact {
        ZkArtifact {
            id: Uuid::nil(),
            circuit_id: "votecheck".to_string(),
            version: "v1".to_string(),
            backend: "circom".to_string(),
            merkle_tree_depth: 4,
            num_candidates: 5,
            wasm_uri: Some("gs://bucket/circuits/votecheck/v1/VoteCheck.wasm".to_string()),
            zkey_uri: Some("gs://bucket/circuits/votecheck/v1/circuit_final.zkey".to_string()),
            verification_key_uri: Some(
                "gs://bucket/circuits/votecheck/v1/verification_key.json".to_string(),
            ),
            solidity_verifier_uri: Some(
                "gs://bucket/circuits/votecheck/v1/Groth16Verifier_4_5.sol".to_string(),
            ),
            sha256: "0".repeat(64),
            manifest,
        }
    }

    #[test]
    fn deployment_artifact_schema_accepts_v2_public_signals() {
        let artifact = artifact_with_manifest(json!({
            "publicSignalCount": 4,
            "publicSignals": ["root", "candidateIndex", "nullifierHash", "election_id"]
        }));

        ensure_deployable_artifact(&artifact).unwrap();
    }

    #[test]
    fn deployment_artifact_schema_rejects_missing_election_index() {
        let artifact = artifact_with_manifest(json!({
            "publicSignalCount": 4,
            "publicSignals": ["root", "candidateIndex", "nullifierHash", "other"]
        }));

        let err = ensure_deployable_artifact(&artifact).expect_err("schema must fail closed");
        assert!(matches!(
            err,
            ApiError::Coded {
                status: 409,
                code: "ARTIFACT_SCHEMA_MISMATCH",
                ..
            }
        ));
    }

    #[test]
    fn deployment_rejects_superseded_elections_before_side_effects() {
        let election = Election {
            id: Uuid::nil(),
            name: "superseded".to_string(),
            state: "failed".to_string(),
            merkle_tree_depth: 4,
            num_candidates: 5,
            candidates: json!(["A", "B"]),
            registration_start_time: OffsetDateTime::UNIX_EPOCH,
            registration_end_time: OffsetDateTime::UNIX_EPOCH,
            voting_start_time: None,
            voting_end_time: None,
            merkle_root: None,
            contract_address: None,
            verifier_address: None,
            completed: false,
            circuit_id: None,
            superseded_at: Some(OffsetDateTime::UNIX_EPOCH),
        };

        let err = ensure_election_not_superseded(&election).expect_err("superseded rows must fail");

        assert!(matches!(
            err,
            ApiError::Coded {
                status: 409,
                code: "ELECTION_SUPERSEDED",
                ..
            }
        ));
    }

    #[test]
    fn bytecode_decoder_rejects_malformed_hex() {
        let path = FsPath::new("bad-artifact.json");
        let err = decode_hex_bytecode("0x123", path).expect_err("odd-length hex must fail");
        assert!(matches!(
            err,
            ApiError::Coded {
                status: 409,
                code: "CONTRACT_ARTIFACT_INVALID",
                ..
            }
        ));
    }

    #[test]
    fn deployment_bytecodes_read_current_hardhat_artifacts() {
        let base = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../artifacts/contracts");
        let base = base.to_str().unwrap();

        let (verifier, tally) = deployment_bytecodes(base, 4, 5).unwrap();

        assert!(!verifier.is_empty());
        assert!(!tally.is_empty());
    }
}
