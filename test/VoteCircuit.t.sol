// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {VotingTally} from "../contracts/VotingTally.sol";
import {Groth16Verifier_4_10} from "../contracts/Groth16Verifier_4_10.sol";

/// @dev Real-proof end-to-end: a Groth16 proof generated from build_4_10 (the
/// committed proof_fixture.json, the SAME fixture the Rust E2E consumes) must
/// verify on-chain against the deployed Groth16Verifier_4_10 wired into
/// VotingTally. The fixture encodes election 123, secret 1, candidate 0.
contract VoteCircuitTest is Test {
    string internal constant FIXTURE = "rust-backend/crates/api/testdata/proof_fixture.json";
    uint256 internal constant ELECTION_ID = 123;
    uint256 internal constant NUM_CANDIDATES = 5;

    // Loads the proof from the shared fixture. forge-std can't one-shot the nested
    // 2D `b` array, so each component is parsed by path. The fixture's `b` is
    // ALREADY Solidity-ordered (rows reversed at generation) — pass it verbatim.
    function _loadProof()
        internal
        view
        returns (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c, uint256[4] memory pub)
    {
        string memory json = vm.readFile(FIXTURE);
        uint256[] memory aDyn = vm.parseJsonUintArray(json, ".formattedProof.a");
        uint256[] memory cDyn = vm.parseJsonUintArray(json, ".formattedProof.c");
        uint256[] memory b0 = vm.parseJsonUintArray(json, ".formattedProof.b[0]");
        uint256[] memory b1 = vm.parseJsonUintArray(json, ".formattedProof.b[1]");
        uint256[] memory pubDyn = vm.parseJsonUintArray(json, ".publicSignals");

        a = [aDyn[0], aDyn[1]];
        c = [cDyn[0], cDyn[1]];
        b = [[b0[0], b0[1]], [b1[0], b1[1]]];
        pub = [pubDyn[0], pubDyn[1], pubDyn[2], pubDyn[3]];
    }

    function test_RealProof_verifiesAndTallies_thenRejectsNullifierReuse() public {
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c, uint256[4] memory pub) = _loadProof();

        // Public signal layout: [root, vote_index, nullifier_hash, election_id].
        assertEq(pub[3], ELECTION_ID, "fixture election id");
        assertEq(pub[1], 0, "fixture votes candidate 0");

        address owner = makeAddr("owner");
        Groth16Verifier_4_10 verifier = new Groth16Verifier_4_10();
        VotingTally vt = new VotingTally(address(verifier), ELECTION_ID, NUM_CANDIDATES, owner);

        // Configure with the fixture's Merkle root and an open voting window.
        vm.warp(10_000);
        vm.prank(owner);
        vt.configureElection(pub[0], block.timestamp - 1, block.timestamp + 3600);

        // The real proof verifies on-chain and the tally moves.
        vt.submitTally(a, b, c, pub);
        assertEq(vt.voteCounts(0), 1, "candidate 0 tallied");
        assertTrue(vt.usedNullifiers(pub[2]), "nullifier consumed");

        // Replaying the same nullifier is rejected.
        vm.expectRevert(bytes("VotingTally: This vote has already been cast"));
        vt.submitTally(a, b, c, pub);
    }
}
