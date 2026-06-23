// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {VotingTally} from "../contracts/VotingTally.sol";

/// @title Deploy
/// @notice Manual / dev deployment of an election's Groth16 verifier + VotingTally.
///         Production deployment is the Rust/alloy backend path (POST /setZkDeploy
///         -> deploy_election); this forge script replaces the removed Hardhat
///         deploy JS for local/dev use.
///
/// @dev Env:
///   MERKLE_TREE_DEPTH  uint    - Merkle depth (selects Groth16Verifier_<depth>_<numCandidates>)
///   NUM_CANDIDATES     uint    - candidate width of the circuit/verifier
///   ELECTION_ID        uint    - election id as a decimal uint256
///   OWNER              address - cold owner key address (configureElection rights; AR-M4)
///   PRIVATE_KEY        uint    - hot relayer key that signs the deploy txs (pays gas only)
///
/// Usage:
///   MERKLE_TREE_DEPTH=4 NUM_CANDIDATES=10 ELECTION_ID=123 OWNER=0x.. PRIVATE_KEY=0x.. \
///     forge script script/Deploy.s.sol:Deploy --rpc-url <rpc> --broadcast
contract Deploy is Script, StdCheats {
    function run() external {
        uint256 depth = vm.envUint("MERKLE_TREE_DEPTH");
        uint256 numCandidates = vm.envUint("NUM_CANDIDATES");
        uint256 electionId = vm.envUint("ELECTION_ID");
        address owner = vm.envAddress("OWNER");
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");

        // Resolve the shape-specific verifier artifact by name (e.g.
        // "Groth16Verifier_4_10.sol") so this script is shape-agnostic.
        string memory verifierArtifact =
            string.concat("Groth16Verifier_", vm.toString(depth), "_", vm.toString(numCandidates), ".sol");

        vm.startBroadcast(deployerKey);
        address verifier = deployCode(verifierArtifact);
        VotingTally votingTally = new VotingTally(verifier, electionId, numCandidates, owner);
        vm.stopBroadcast();

        console.log("Verifier    :", verifier);
        console.log("VotingTally :", address(votingTally));
        console.log("owner       :", owner);
        console.log("electionId  :", electionId);
    }
}
