//! Phase 11 gates against a local hardhat node.
//! Start it first: `npx hardhat node` (repo root), then run:
//! `cargo test -p zkvote-chain -- --ignored`

use alloy::primitives::{Address, U256};
use zkvote_chain::{
    configure_election, connect_election, deploy_election, ChainConfig, ChainError,
};

const RPC: &str = "http://127.0.0.1:8545";
// Hardhat's well-known development accounts (public test keys, never used
// outside a local node).
const RELAYER_KEY: &str = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const OWNER_KEY: &str = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const OWNER_ADDR: &str = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

fn bytecode(artifact_rel_path: &str) -> Vec<u8> {
    let path = format!(
        "{}/../../../{artifact_rel_path}",
        env!("CARGO_MANIFEST_DIR")
    );
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|_| panic!("missing artifact {path}"));
    let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let hex = json["bytecode"].as_str().unwrap().trim_start_matches("0x");
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
        .collect()
}

#[tokio::test]
#[ignore = "requires a local hardhat node (npx hardhat node)"]
async fn deploys_and_enforces_owner_separation() {
    let config = ChainConfig {
        rpc_url: RPC.to_string(),
        relayer_private_key: RELAYER_KEY.to_string(),
    };
    let owner: Address = OWNER_ADDR.parse().unwrap();

    // Deploy verifier + VotingTally, signed by the RELAYER, owned by OWNER.
    let deployed = deploy_election(
        &config,
        bytecode("artifacts/contracts/Groth16Verifier_4_5.sol/Groth16Verifier_4_5.json"),
        bytecode("artifacts/contracts/VotingTally.sol/VotingTally.json"),
        U256::from(123u64),
        U256::from(5u64),
        owner,
    )
    .await
    .expect("deployment failed — is `npx hardhat node` running?");
    assert!(deployed.deploy_tx_hash.starts_with("0x"));

    let election = connect_election(&config, deployed.voting_tally_address).unwrap();
    assert_eq!(
        election.owner().await.unwrap(),
        owner,
        "AR-M4 owner mismatch"
    );
    assert!(!election.configured().await.unwrap());

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();

    // Gate (AR-M4): the hot relayer key cannot call configureElection.
    let relayer_attempt = configure_election(
        &config,
        RELAYER_KEY,
        deployed.voting_tally_address,
        U256::from(42u64),
        U256::from(now),
        U256::from(now + 3600),
    )
    .await
    .unwrap_err();
    assert!(
        matches!(relayer_attempt, ChainError::Reverted(_)),
        "expected permanent revert, got {relayer_attempt:?}"
    );
    assert!(!relayer_attempt.is_retryable());
    assert!(
        !election.configured().await.unwrap(),
        "failed call must not advance on-chain state"
    );

    // The owner key configures successfully.
    let tx_hash = configure_election(
        &config,
        OWNER_KEY,
        deployed.voting_tally_address,
        U256::from(42u64),
        U256::from(now),
        U256::from(now + 3600),
    )
    .await
    .unwrap();
    assert!(tx_hash.starts_with("0x"));
    assert!(election.configured().await.unwrap());
    assert_eq!(election.merkle_root().await.unwrap(), U256::from(42u64));

    // Gate: duplicate configuration is rejected (preflight revert) and the
    // root is unchanged.
    let duplicate = configure_election(
        &config,
        OWNER_KEY,
        deployed.voting_tally_address,
        U256::from(43u64),
        U256::from(now),
        U256::from(now + 3600),
    )
    .await
    .unwrap_err();
    assert!(matches!(duplicate, ChainError::Reverted(_)));
    assert_eq!(election.merkle_root().await.unwrap(), U256::from(42u64));
}
