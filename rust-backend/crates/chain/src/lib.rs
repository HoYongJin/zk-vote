//! Typed chain layer (PROJECT_PLAN Phase 11): verifier + VotingTally
//! deployment, `configureElection` with preflight, receipt polling, and
//! failure classification. Keys are passed in as raw hex (sourced from
//! Secret Manager or local .env by the caller) and never logged.
//!
//! Key separation (AR-M4): deployments are signed by the hot relayer key,
//! but the contract owner is an explicit, separate address; only
//! `configure_election` needs the owner key.

use alloy::network::{EthereumWallet, TransactionBuilder};
use alloy::primitives::{Address, U256};
use alloy::providers::{Provider, ProviderBuilder};
use alloy::rpc::types::TransactionRequest;
use alloy::signers::local::PrivateKeySigner;
use alloy::sol;
use alloy::sol_types::SolValue;
use thiserror::Error;

sol! {
    #[sol(rpc)]
    contract VotingTally {
        function owner() external view returns (address);
        function configured() external view returns (bool);
        function merkleRoot() external view returns (uint256);
        function electionId() external view returns (uint256);
        function numCandidates() external view returns (uint256);
        function votingStartTime() external view returns (uint256);
        function votingEndTime() external view returns (uint256);
        function usedNullifiers(uint256 nullifier) external view returns (bool);
        function voteCounts(uint256 candidate) external view returns (uint256);
        function configureElection(uint256 _root, uint256 _startTime, uint256 _endTime) external;
        function submitTally(uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c, uint256[4] calldata publicInputs) external;
    }
}

#[derive(Debug, Error)]
pub enum ChainError {
    #[error("invalid chain configuration: {0}")]
    Config(String),
    #[error("transport/rpc error: {0}")]
    Transport(String),
    /// The node accepted the call but the contract reverted — a permanent,
    /// non-retryable failure (wrong state, wrong caller, bad input).
    #[error("contract reverted: {0}")]
    Reverted(String),
    #[error("deployment produced no contract address")]
    NoContractAddress,
}

impl ChainError {
    /// Retryable failures are transport-level; reverts are permanent.
    pub fn is_retryable(&self) -> bool {
        matches!(self, Self::Transport(_))
    }
}

fn classify(err: alloy::contract::Error) -> ChainError {
    let text = err.to_string();
    if text.contains("revert") || text.contains("execution reverted") {
        ChainError::Reverted(text)
    } else {
        ChainError::Transport(text)
    }
}

#[derive(Debug, Clone)]
pub struct ChainConfig {
    pub rpc_url: String,
    /// Hot relayer key (deploys contracts, relays votes). Hex, 0x optional.
    pub relayer_private_key: String,
}

#[derive(Debug)]
pub struct DeployedElection {
    pub verifier_address: Address,
    pub voting_tally_address: Address,
    pub deploy_tx_hash: String,
}

fn signer(key: &str) -> Result<PrivateKeySigner, ChainError> {
    key.trim_start_matches("0x")
        .parse::<PrivateKeySigner>()
        .map_err(|err| ChainError::Config(format!("invalid private key: {err}")))
}

/// Derives the EOA address for config validation and explicit owner wiring.
pub fn address_for_private_key(key: &str) -> Result<Address, ChainError> {
    Ok(signer(key)?.address())
}

fn provider_with(rpc_url: &str, key: &str) -> Result<impl Provider + Clone, ChainError> {
    let url = rpc_url
        .parse()
        .map_err(|err| ChainError::Config(format!("invalid rpc url: {err}")))?;
    Ok(ProviderBuilder::new()
        .wallet(EthereumWallet::from(signer(key)?))
        .connect_http(url))
}

async fn deploy_bytecode(
    provider: &(impl Provider + Clone),
    creation_code: Vec<u8>,
) -> Result<(Address, String), ChainError> {
    let tx = TransactionRequest::default().with_deploy_code(creation_code);
    let pending = provider
        .send_transaction(tx)
        .await
        .map_err(|err| ChainError::Transport(err.to_string()))?;
    let receipt = pending
        .get_receipt()
        .await
        .map_err(|err| ChainError::Transport(err.to_string()))?;
    if !receipt.status() {
        return Err(ChainError::Reverted("deployment reverted".to_string()));
    }
    let address = receipt
        .contract_address
        .ok_or(ChainError::NoContractAddress)?;
    Ok((address, format!("{:#x}", receipt.transaction_hash)))
}

/// Deploys the Groth16 verifier and a `VotingTally` bound to it, signed by
/// the relayer key, with `owner` as the explicit contract owner (AR-M4).
pub async fn deploy_election(
    config: &ChainConfig,
    verifier_bytecode: Vec<u8>,
    voting_tally_bytecode: Vec<u8>,
    election_id: U256,
    num_candidates: U256,
    owner: Address,
) -> Result<DeployedElection, ChainError> {
    let provider = provider_with(&config.rpc_url, &config.relayer_private_key)?;

    let (verifier_address, _) = deploy_bytecode(&provider, verifier_bytecode).await?;

    let mut creation_code = voting_tally_bytecode;
    creation_code
        .extend((verifier_address, election_id, num_candidates, owner).abi_encode_params());
    let (voting_tally_address, deploy_tx_hash) = deploy_bytecode(&provider, creation_code).await?;

    Ok(DeployedElection {
        verifier_address,
        voting_tally_address,
        deploy_tx_hash,
    })
}

/// Calls `configureElection` with a preflight `eth_call` first, so permanent
/// failures (wrong owner, already configured) are classified as `Reverted`
/// before any gas is spent. Signed by `owner_private_key` (AR-M4).
pub async fn configure_election(
    config: &ChainConfig,
    owner_private_key: &str,
    voting_tally_address: Address,
    merkle_root: U256,
    voting_start: U256,
    voting_end: U256,
) -> Result<String, ChainError> {
    let provider = provider_with(&config.rpc_url, owner_private_key)?;
    let contract = VotingTally::new(voting_tally_address, provider);

    let call = contract.configureElection(merkle_root, voting_start, voting_end);
    // Preflight: a revert here costs nothing and is permanent.
    call.call().await.map_err(classify)?;

    let pending = call.send().await.map_err(classify)?;
    let receipt = pending
        .get_receipt()
        .await
        .map_err(|err| ChainError::Transport(err.to_string()))?;
    if !receipt.status() {
        return Err(ChainError::Reverted(
            "configureElection reverted on-chain".to_string(),
        ));
    }
    Ok(format!("{:#x}", receipt.transaction_hash))
}

/// Read-side election state used by finalize recovery and submit preflight.
pub struct ElectionOnChain<P: Provider + Clone> {
    contract: VotingTally::VotingTallyInstance<P>,
}

/// Connects a read-side instance using the relayer credentials.
pub fn connect_election(
    config: &ChainConfig,
    voting_tally_address: Address,
) -> Result<ElectionOnChain<impl Provider + Clone>, ChainError> {
    let provider = provider_with(&config.rpc_url, &config.relayer_private_key)?;
    Ok(ElectionOnChain {
        contract: VotingTally::new(voting_tally_address, provider),
    })
}

impl<P: Provider + Clone> ElectionOnChain<P> {
    pub async fn owner(&self) -> Result<Address, ChainError> {
        self.contract.owner().call().await.map_err(classify)
    }

    pub async fn configured(&self) -> Result<bool, ChainError> {
        self.contract.configured().call().await.map_err(classify)
    }

    pub async fn merkle_root(&self) -> Result<U256, ChainError> {
        self.contract.merkleRoot().call().await.map_err(classify)
    }

    pub async fn voting_start_time(&self) -> Result<U256, ChainError> {
        self.contract
            .votingStartTime()
            .call()
            .await
            .map_err(classify)
    }

    pub async fn voting_end_time(&self) -> Result<U256, ChainError> {
        self.contract.votingEndTime().call().await.map_err(classify)
    }

    pub async fn nullifier_used(&self, nullifier: U256) -> Result<bool, ChainError> {
        self.contract
            .usedNullifiers(nullifier)
            .call()
            .await
            .map_err(classify)
    }

    pub async fn vote_count(&self, candidate: U256) -> Result<U256, ChainError> {
        self.contract
            .voteCounts(candidate)
            .call()
            .await
            .map_err(classify)
    }
}

/// Relays a vote transaction. The caller MUST serialize calls per relayer
/// wallet (AR-M5): concurrent sends from one wallet race on nonces. A
/// preflight `eth_call` classifies permanent rejections before any gas is
/// spent or the single-use ticket is consumed.
pub async fn submit_tally(
    config: &ChainConfig,
    voting_tally_address: Address,
    a: [U256; 2],
    b: [[U256; 2]; 2],
    c: [U256; 2],
    public_inputs: [U256; 4],
) -> Result<String, ChainError> {
    let provider = provider_with(&config.rpc_url, &config.relayer_private_key)?;
    let contract = VotingTally::new(voting_tally_address, provider);

    let call = contract.submitTally(a, b, c, public_inputs);
    call.call().await.map_err(classify)?;

    let pending = call.send().await.map_err(classify)?;
    let receipt = pending
        .get_receipt()
        .await
        .map_err(|err| ChainError::Transport(err.to_string()))?;
    if !receipt.status() {
        return Err(ChainError::Reverted(
            "submitTally reverted on-chain".to_string(),
        ));
    }
    Ok(format!("{:#x}", receipt.transaction_hash))
}

/// Preflight-only variant of submitTally — used to validate before the
/// single-use ticket is consumed.
pub async fn preflight_submit_tally(
    config: &ChainConfig,
    voting_tally_address: Address,
    a: [U256; 2],
    b: [[U256; 2]; 2],
    c: [U256; 2],
    public_inputs: [U256; 4],
) -> Result<(), ChainError> {
    let provider = provider_with(&config.rpc_url, &config.relayer_private_key)?;
    let contract = VotingTally::new(voting_tally_address, provider);
    contract
        .submitTally(a, b, c, public_inputs)
        .call()
        .await
        .map_err(classify)?;
    Ok(())
}
