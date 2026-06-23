//! Chain-layer gates against a local EVM node (anvil).
//! Start it first: `anvil` (repo root), then run:
//! `cargo test -p zkvote-chain -- --ignored`.
//! anvil's defaults match Hardhat's exactly (verified): chainId 31337, port 8545,
//! mnemonic `test test test test test test test test test test test junk` — so
//! accounts 0/1 are the RELAYER/OWNER keys below. No extra flags needed.

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
    // Hardhat: `bytecode` is a top-level hex string. Foundry (`forge build`):
    // `bytecode` is an object with the hex under `.object`. Accept both.
    let hex = json["bytecode"]
        .as_str()
        .or_else(|| json["bytecode"]["object"].as_str())
        .unwrap()
        .trim_start_matches("0x");
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
        .collect()
}

#[tokio::test]
#[ignore = "requires a local anvil node (run `anvil`)"]
async fn deploys_and_enforces_owner_separation() {
    let config = ChainConfig {
        rpc_url: RPC.to_string(),
        relayer_private_key: RELAYER_KEY.to_string(),
    };
    let owner: Address = OWNER_ADDR.parse().unwrap();

    // Deploy verifier + VotingTally, signed by the RELAYER, owned by OWNER.
    let deployed = deploy_election(
        &config,
        bytecode("out/Groth16Verifier_4_5.sol/Groth16Verifier_4_5.json"),
        bytecode("out/VotingTally.sol/VotingTally.json"),
        U256::from(123u64),
        U256::from(5u64),
        owner,
        31337, // anvil local node chain id (§0.5 gap #2)
    )
    .await
    .expect("deployment failed — is `anvil` running?");
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

// PROJECT_PLAN §0.5 gap #2: deploy_election must refuse when the live RPC's
// chain id != the expected CHAIN_ID. Before this guard a mis-set RPC_URL would
// have silently deployed to the wrong chain. The local node reports 31337, so
// claiming Sepolia (11155111) must fail with a Config error before any deploy.
#[tokio::test]
#[ignore = "requires a local anvil node (run `anvil`)"]
async fn refuses_to_deploy_on_a_chain_id_mismatch() {
    let config = ChainConfig {
        rpc_url: RPC.to_string(),
        relayer_private_key: RELAYER_KEY.to_string(),
    };
    let owner: Address = OWNER_ADDR.parse().unwrap();

    let err = deploy_election(
        &config,
        bytecode("out/Groth16Verifier_4_5.sol/Groth16Verifier_4_5.json"),
        bytecode("out/VotingTally.sol/VotingTally.json"),
        U256::from(123u64),
        U256::from(5u64),
        owner,
        11_155_111, // wrong: the local node is 31337
    )
    .await
    .expect_err("must refuse to deploy when the RPC chain id != expected CHAIN_ID");
    assert!(
        matches!(err, ChainError::Config(_)),
        "expected a Config (chain-id mismatch) error, got {err:?}"
    );
    assert!(
        !err.is_retryable(),
        "a wrong-chain config error is permanent"
    );
}
