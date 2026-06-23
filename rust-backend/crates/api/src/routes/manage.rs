//! Admin setup routes: election creation (M4 candidate/timing caps) and
//! admin-invitation upsert.

use crate::auth::AdminUser;
use crate::error::ApiError;
use crate::leases;
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
use zkvote_chain::{
    address_for_private_key, deploy_verifier, deploy_voting_tally, ChainConfig, ChainError,
};
use zkvote_db::repos::{
    AdminRepo, DeploymentRepo, Election, ElectionRepo, NewElection, NewZkArtifact, ZkArtifact,
    ZkArtifactRepo,
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
    /// Always false: the backend does not call an IdP admin API to look up
    /// existing users (AR-L4 decision); invited users are promoted on their
    /// first authenticated request instead (audit H5).
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
    // AR-M4 / invariant #5, enforced app-side: the cold owner key (configureElection
    // rights) MUST NOT equal the hot relayer key. A misconfiguration that conflates
    // them lets a relayer-key leak front-run configureElection and freeze the
    // election — refuse to deploy rather than silently break the separation.
    let relayer = address_for_private_key(&relayer_private_key).map_err(chain_config_error)?;
    if owner == relayer {
        return Err(coded(
            503,
            "CHAIN_CONFIG_INVALID",
            "OWNER_PRIVATE_KEY and RELAYER_PRIVATE_KEY must be different keys (AR-M4): \
             the cold owner key must not equal the hot relayer key.",
        ));
    }
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
    let election_u256 = election_uuid_to_u256(election_id)?;
    let num_candidates = U256::from(latest.num_candidates as u64);
    // §0.5 gap #2: refuse to deploy unless the live RPC reports this chain id.
    let expected_chain_id = state.config.chain_id as u64;

    // G3: a prior attempt may have landed the verifier but failed before the
    // VotingTally. The verifier address is checkpointed to the DB, so a retry
    // REUSES it instead of deploying (and orphaning) a fresh verifier and
    // burning another relayer nonce. Parse fail-closed: a corrupt stored value
    // must surface, not silently trigger a re-deploy.
    let checkpointed_verifier = match latest.verifier_address.as_deref() {
        Some(raw) => Some(raw.parse::<Address>().map_err(|err| {
            coded(
                500,
                "VERIFIER_ADDRESS_CORRUPT",
                format!("Stored verifier_address {raw} is not a valid address: {err}"),
            )
        })?),
        None => None,
    };

    let relayer_lease = leases::acquire(
        &state.redis,
        leases::RELAYER_LEASE_KEY.to_string(),
        leases::RELAYER_LEASE_SECONDS,
        "RELAYER_BUSY",
        "The relayer is processing another transaction. Retry shortly.",
    )
    .await?;

    // Both on-chain sends (and the verifier checkpoint between them) stay inside
    // the cross-instance relayer lease AND the in-process relay mutex, so the
    // relayer nonce is serialized end-to-end (AR-M5). record_and_bind is a
    // DB-only write and runs after the lease is released.
    let deploy_outcome: Result<(Address, Address, String), ApiError> = async {
        let _local_relay_guard = state.relay_lock.lock().await;

        let verifier_address = match checkpointed_verifier {
            Some(addr) => addr,
            None => {
                let (addr, _tx) = deploy_verifier(&chain, verifier_bytecode, expected_chain_id)
                    .await
                    .map_err(chain_deploy_error)?;
                // Checkpoint BEFORE the tally deploy so a tally-stage failure
                // leaves a reusable verifier rather than an orphan.
                let checkpointed = DeploymentRepo::checkpoint_verifier(
                    &state.pg,
                    election_id,
                    &format!("{addr:#x}"),
                )
                .await?;
                if !checkpointed {
                    return Err(coded(
                        409,
                        "DEPLOYMENT_STATE_CONFLICT",
                        "Verifier deployed but the election was concurrently superseded or bound; \
                         the verifier is abandoned in place (AR-M7).",
                    ));
                }
                addr
            }
        };

        let (tally_address, tx_hash) = deploy_voting_tally(
            &chain,
            voting_tally_bytecode,
            verifier_address,
            election_u256,
            num_candidates,
            owner,
            expected_chain_id,
        )
        .await
        .map_err(chain_deploy_error)?;

        Ok((verifier_address, tally_address, tx_hash))
    }
    .await;

    if let Err(err) = leases::release(&state.redis, &relayer_lease).await {
        tracing::warn!(error = %err, "failed to release relayer redis lease");
    }

    let (verifier_addr, tally_addr, deploy_tx_hash) = deploy_outcome?;
    let verifier_address = format!("{verifier_addr:#x}");
    let contract_address = format!("{tally_addr:#x}");

    let bound = DeploymentRepo::record_and_bind(
        &state.pg,
        election_id,
        Some(artifact.id),
        &verifier_address,
        &contract_address,
        state.config.chain_id,
        &deploy_tx_hash,
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
        deploy_tx_hash,
        artifact_id: artifact.id,
    }))
}

/// Deployment guard: rejects unknown/already deployed elections,
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
        // Missing ZK artifacts block deployment setup.
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

    let deploy_lease = leases::acquire(
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

    if let Err(err) = leases::release(&state.redis, &deploy_lease).await {
        tracing::warn!(error = %err, "failed to release deployment redis lease");
    }

    result
}

// ---------------------------------------------------------------------------
// POST /api/elections/:election_id/supersede
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct SupersedeBody {
    /// Operator-supplied reason, recorded in the audit log. Required.
    pub reason: Option<String>,
}

#[derive(Serialize)]
pub struct SupersedeResponse {
    pub success: bool,
    pub message: String,
    pub state: String,
    #[serde(rename = "supersededAt", with = "time::serde::rfc3339")]
    pub superseded_at: OffsetDateTime,
}

/// G4 / AR-M7: marks an election superseded so every downstream guard
/// (register / vote / finalize / deploy) fail-closes against it. The on-chain
/// contract is deliberately abandoned in place — this endpoint performs NO
/// on-chain action.
///
/// It acquires BOTH the per-election finalize lease and the relayer lease before
/// the DB write, so a supersede cannot interleave with an in-flight finalize or
/// deploy/relay and leave a DB-superseded / contract-live half-state (the
/// finalize path releases its row lock before the on-chain `configureElection`,
/// and the deploy path shares the relayer lease).
pub async fn supersede_election(
    State(state): State<AppState>,
    AdminUser(admin): AdminUser,
    Path(election_id): Path<Uuid>,
    Json(body): Json<SupersedeBody>,
) -> Result<Json<SupersedeResponse>, ApiError> {
    let reason = body
        .reason
        .map(|r| r.trim().to_string())
        .filter(|r| !r.is_empty())
        .ok_or_else(|| {
            ApiError::Validation("`reason` is required to supersede an election.".to_string())
        })?;

    let election = ElectionRepo::find(&state.pg, election_id)
        .await?
        .ok_or_else(|| ApiError::NotFound(format!("Election with ID {election_id} not found.")))?;
    if election.superseded_at.is_some() {
        return Err(coded(
            409,
            "ALREADY_SUPERSEDED",
            "This election is already superseded.",
        ));
    }

    // Serialize against finalize (per-election lease) AND the relayer/deploy path
    // (shared relayer lease) so the DB supersede cannot race a half-applied
    // on-chain transition.
    let finalize_lease = leases::acquire(
        &state.redis,
        leases::finalize_lease_key(&election_id),
        leases::FINALIZE_LEASE_SECONDS,
        "FINALIZATION_IN_PROGRESS",
        "A finalization is in progress for this election; retry once it settles.",
    )
    .await?;
    let relayer_lease = match leases::acquire(
        &state.redis,
        leases::RELAYER_LEASE_KEY.to_string(),
        leases::RELAYER_LEASE_SECONDS,
        "RELAYER_BUSY",
        "The relayer is processing another transaction; retry shortly.",
    )
    .await
    {
        Ok(lease) => lease,
        Err(err) => {
            if let Err(e) = leases::release(&state.redis, &finalize_lease).await {
                tracing::warn!(error = %e, "failed to release finalize lease after relayer conflict");
            }
            return Err(err);
        }
    };

    let result = ElectionRepo::supersede(&state.pg, election_id).await;

    if let Err(e) = leases::release(&state.redis, &relayer_lease).await {
        tracing::warn!(error = %e, "failed to release relayer lease after supersede");
    }
    if let Err(e) = leases::release(&state.redis, &finalize_lease).await {
        tracing::warn!(error = %e, "failed to release finalize lease after supersede");
    }

    if !result? {
        return Err(coded(
            409,
            "ALREADY_SUPERSEDED",
            "This election could not be superseded (already superseded or completed).",
        ));
    }

    // Durable markers are the `superseded_at` timestamp + `state='failed'` on the
    // row; the operator reason + admin identity go to structured logs (the GCP
    // target's Cloud Logging is the audit sink — finalization_jobs cannot hold a
    // supersede row because its desired_merkle_root carries a field-element CHECK).
    tracing::warn!(
        admin_id = %admin.id,
        election_id = %election_id,
        reason = %reason,
        "election superseded (AR-M7: on-chain contract abandoned in place)"
    );

    let refreshed = ElectionRepo::find(&state.pg, election_id).await?;
    let superseded_at = refreshed
        .as_ref()
        .and_then(|e| e.superseded_at)
        .unwrap_or_else(OffsetDateTime::now_utc);
    let state_label = refreshed
        .map(|e| e.state)
        .unwrap_or_else(|| "failed".to_string());

    Ok(Json(SupersedeResponse {
        success: true,
        message: "Election superseded. The on-chain contract is abandoned in place; \
                  create a new election to replace it."
            .to_string(),
        state: state_label,
        superseded_at,
    }))
}

// ---------------------------------------------------------------------------
// POST /api/admin/zk-artifacts  (G5: artifact registration)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct RegisterArtifactBody {
    #[serde(rename = "circuitId")]
    pub circuit_id: Option<String>,
    pub version: Option<String>,
    #[serde(rename = "merkleTreeDepth")]
    pub merkle_tree_depth: Option<i32>,
    #[serde(rename = "numCandidates")]
    pub num_candidates: Option<i32>,
    #[serde(rename = "wasmUri")]
    pub wasm_uri: Option<String>,
    #[serde(rename = "zkeyUri")]
    pub zkey_uri: Option<String>,
    #[serde(rename = "verificationKeyUri")]
    pub verification_key_uri: Option<String>,
    #[serde(rename = "solidityVerifierUri")]
    pub solidity_verifier_uri: Option<String>,
    /// The artifact manifest (the `zkArtifacts.js` shape): MUST carry
    /// `wasmSha256` / `zkeySha256` / `verificationKeySha256` + `publicSignalCount`.
    pub manifest: Option<Value>,
}

#[derive(Serialize)]
pub struct RegisterArtifactResponse {
    pub success: bool,
    pub message: String,
    #[serde(rename = "artifactId")]
    pub artifact_id: Uuid,
}

fn require_field(value: Option<String>, name: &str) -> Result<String, ApiError> {
    value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| ApiError::Validation(format!("`{name}` is required.")))
}

/// G5 fail-closed: a 64-char hex sha256 the verified browser fetch checks. A
/// manifest missing these would make `/artifact-info` 409 and block all voting,
/// so reject at registration instead.
fn require_manifest_sha(manifest: &Value, key: &str) -> Result<String, ApiError> {
    manifest
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|s| s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit()))
        .ok_or_else(|| {
            ApiError::Validation(format!(
                "`manifest.{key}` must be a 64-char hex sha256 (G5: verified artifact fetch)."
            ))
        })
}

/// Registers a sha256-bearing artifact set so deployed elections expose verified
/// (integrity-checked) proving artifacts to the browser. The sha256 values are
/// produced by `scripts/zkArtifacts.js` (`artifact-manifest.json`).
pub async fn register_zk_artifact(
    State(state): State<AppState>,
    AdminUser(_admin): AdminUser,
    Json(body): Json<RegisterArtifactBody>,
) -> Result<(StatusCode, Json<RegisterArtifactResponse>), ApiError> {
    let circuit_id = require_field(body.circuit_id, "circuitId")?;
    let version = require_field(body.version, "version")?;
    let merkle_tree_depth = body.merkle_tree_depth.filter(|d| *d > 0).ok_or_else(|| {
        ApiError::Validation("`merkleTreeDepth` must be a positive integer.".into())
    })?;
    let num_candidates = body.num_candidates.filter(|n| *n > 0).ok_or_else(|| {
        ApiError::Validation("`numCandidates` must be a positive integer.".into())
    })?;
    let manifest = body
        .manifest
        .ok_or_else(|| ApiError::Validation("`manifest` is required.".into()))?;

    // Fail-closed manifest validation (G5).
    let zkey_sha = require_manifest_sha(&manifest, "zkeySha256")?;
    require_manifest_sha(&manifest, "wasmSha256")?;
    require_manifest_sha(&manifest, "verificationKeySha256")?;
    if u64_field(&manifest, &["publicSignalCount", "public_signal_count"]).is_none() {
        return Err(ApiError::Validation(
            "`manifest.publicSignalCount` is required.".into(),
        ));
    }

    let new = NewZkArtifact {
        circuit_id,
        version,
        backend: "circom".to_string(),
        merkle_tree_depth,
        num_candidates,
        wasm_uri: body.wasm_uri,
        zkey_uri: body.zkey_uri,
        verification_key_uri: body.verification_key_uri,
        solidity_verifier_uri: body.solidity_verifier_uri,
        // Representative digest for the artifact set (the zkey is the binding one).
        sha256: zkey_sha,
        manifest,
    };

    let artifact_id = match ZkArtifactRepo::register(&state.pg, &new).await {
        Ok(id) => id,
        Err(err) if err.is_unique_violation() => {
            return Err(coded(
                409,
                "ARTIFACT_ALREADY_REGISTERED",
                "An artifact with this circuitId/version is already registered.",
            ))
        }
        Err(err) => return Err(err.into()),
    };

    Ok((
        StatusCode::CREATED,
        Json(RegisterArtifactResponse {
            success: true,
            message: "ZK artifact set registered.".to_string(),
            artifact_id,
        }),
    ))
}

// ---------------------------------------------------------------------------
// POST /api/elections/:election_id/complete
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

    // Guarded, idempotent (only flips `completed` from false) and
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
