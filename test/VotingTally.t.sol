// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {VotingTally} from "../contracts/VotingTally.sol";
import {MockVerifier} from "../contracts/test/MockVerifier.sol";

/**
 * @title VotingTallyTest
 * @dev Foundry port of test/VotingTally.js. Each test function maps 1:1 to a
 * chai `it(...)` case (function names note the JS case they replace). Revert
 * strings are asserted verbatim against contracts/VotingTally.sol.
 *
 * Public signal layout: [root, vote_index(candidate), nullifier_hash, election_id].
 */
contract VotingTallyTest is Test {
    uint256 internal constant ELECTION_ID = 123;
    uint256 internal constant NUM_CANDIDATES = 3;

    // Signers mirroring the JS fixture's ethers.getSigners() ordering intent:
    // owner holds onlyOwner rights; otherAccount/relayer are non-owner keys.
    address internal owner = makeAddr("owner");
    address internal otherAccount = makeAddr("otherAccount");
    address internal relayer = makeAddr("relayer");

    // Re-declare events so vm.expectEmit can match them.
    event VoteCast(uint256 indexed electionId, uint256 indexed candidateIndex);

    // --- Helpers (mirror publicInputs()/emptyProof() in the JS suite) ---

    function _publicInputs(uint256 root, uint256 candidate, uint256 nullifier, uint256 electionId)
        internal
        pure
        returns (uint256[4] memory)
    {
        return [root, candidate, nullifier, electionId];
    }

    function _a() internal pure returns (uint256[2] memory) {
        return [uint256(0), 0];
    }

    function _b() internal pure returns (uint256[2][2] memory) {
        return [[uint256(0), 0], [uint256(0), 0]];
    }

    function _c() internal pure returns (uint256[2] memory) {
        return [uint256(0), 0];
    }

    // deployVotingTallyFixture: verifier = otherAccount, owner = owner.
    function _deployVotingTally() internal returns (VotingTally) {
        return new VotingTally(otherAccount, ELECTION_ID, NUM_CANDIDATES, owner);
    }

    // deployConfiguredWithMockFixture: MockVerifier-backed, configured election.
    function _deployConfiguredWithMock() internal returns (VotingTally vt, MockVerifier mock) {
        mock = new MockVerifier();
        vt = new VotingTally(address(mock), ELECTION_ID, NUM_CANDIDATES, owner);
        // now - 1 .. now + 3600. Use a non-trivial base time so `now - 1` is valid.
        vm.warp(10_000);
        uint256 nowTs = block.timestamp;
        vm.prank(owner);
        vt.configureElection(1, nowTs - 1, nowTs + 3600);
    }

    // ===================== Deployment =====================

    // JS: "sets immutable election configuration"
    function test_Deployment_setsImmutableElectionConfiguration() public {
        VotingTally vt = _deployVotingTally();
        assertEq(vt.owner(), owner);
        assertEq(address(vt.verifier()), otherAccount);
        assertEq(vt.electionId(), ELECTION_ID);
        assertEq(vt.numCandidates(), NUM_CANDIDATES);
    }

    // ===================== Admin configuration =====================

    // JS: "keeps onlyOwner rights off the deploying relayer key (AR-M4)"
    function test_Admin_relayerHasNoOwnerRights_AR_M4() public {
        // The hot relayer key DEPLOYS but must hold no owner privileges.
        vm.prank(relayer);
        VotingTally vt = new VotingTally(relayer, ELECTION_ID, NUM_CANDIDATES, owner);

        vm.warp(10_000);
        uint256 nowTs = block.timestamp;

        // Non-owner (relayer) cannot configure.
        vm.prank(relayer);
        vm.expectRevert(bytes("VotingTally: Caller is not the owner"));
        vt.configureElection(1, nowTs - 1, nowTs + 3600);

        // Owner can configure (must not revert).
        vm.prank(owner);
        vt.configureElection(1, nowTs - 1, nowTs + 3600);
        assertTrue(vt.configured());
    }

    // JS: "rejects zero owner, zero verifier, and zero candidates at deployment"
    function test_Admin_rejectsZeroOwnerVerifierCandidatesAtDeployment() public {
        vm.expectRevert(bytes("VotingTally: Verifier cannot be zero address"));
        new VotingTally(address(0), ELECTION_ID, NUM_CANDIDATES, owner);

        vm.expectRevert(bytes("VotingTally: Owner cannot be zero address"));
        new VotingTally(otherAccount, ELECTION_ID, NUM_CANDIDATES, address(0));

        vm.expectRevert(bytes("VotingTally: Candidates must be positive"));
        new VotingTally(otherAccount, ELECTION_ID, 0, owner);
    }

    // JS: "allows only the owner to set the Merkle root"
    function test_Admin_onlyOwnerSetsMerkleRoot() public {
        VotingTally vt = _deployVotingTally();

        vm.prank(otherAccount);
        vm.expectRevert(bytes("VotingTally: Caller is not the owner"));
        vt.setMerkleRoot(1);

        vm.prank(owner);
        vm.expectRevert(bytes("VotingTally: Merkle root cannot be zero"));
        vt.setMerkleRoot(0);

        vm.prank(owner);
        vt.setMerkleRoot(1);
        assertEq(vt.merkleRoot(), 1);

        vm.prank(owner);
        vm.expectRevert(bytes("VotingTally: Merkle root already set"));
        vt.setMerkleRoot(2);
    }

    // JS: "requires a valid voting period"
    function test_Admin_requiresValidVotingPeriod() public {
        VotingTally vt = _deployVotingTally();
        vm.warp(10_000);
        uint256 nowTs = block.timestamp;

        vm.prank(otherAccount);
        vm.expectRevert(bytes("VotingTally: Caller is not the owner"));
        vt.setVotingPeriod(nowTs, nowTs + 60);

        vm.prank(owner);
        vm.expectRevert(bytes("VotingTally: Merkle root is not set"));
        vt.setVotingPeriod(nowTs, nowTs + 60);

        vm.prank(owner);
        vt.setMerkleRoot(1);

        vm.prank(owner);
        vm.expectRevert(bytes("VotingTally: Start time must be before end time"));
        vt.setVotingPeriod(nowTs + 60, nowTs);

        vm.prank(owner);
        vt.setVotingPeriod(nowTs, nowTs + 60);
        assertEq(vt.votingStartTime(), nowTs);
        assertEq(vt.votingEndTime(), nowTs + 60);
        assertTrue(vt.configured());

        vm.prank(owner);
        vm.expectRevert(bytes("VotingTally: Election already configured"));
        vt.setVotingPeriod(nowTs, nowTs + 120);
    }

    // JS: "atomically configures the Merkle root and voting period once"
    function test_Admin_configureElectionAtomicOnce() public {
        VotingTally vt = _deployVotingTally();
        vm.warp(10_000);
        uint256 nowTs = block.timestamp;

        vm.prank(otherAccount);
        vm.expectRevert(bytes("VotingTally: Caller is not the owner"));
        vt.configureElection(1, nowTs, nowTs + 60);

        vm.prank(owner);
        vm.expectRevert(bytes("VotingTally: Merkle root cannot be zero"));
        vt.configureElection(0, nowTs, nowTs + 60);

        vm.prank(owner);
        vm.expectRevert(bytes("VotingTally: Start time must be before end time"));
        vt.configureElection(1, nowTs + 60, nowTs);

        vm.prank(owner);
        vt.configureElection(1, nowTs, nowTs + 60);
        assertEq(vt.merkleRoot(), 1);
        assertEq(vt.votingStartTime(), nowTs);
        assertEq(vt.votingEndTime(), nowTs + 60);
        assertTrue(vt.configured());

        vm.prank(owner);
        vm.expectRevert(bytes("VotingTally: Election already configured"));
        vt.configureElection(1, nowTs, nowTs + 120);

        vm.prank(owner);
        vm.expectRevert(bytes("VotingTally: Election already configured"));
        vt.setMerkleRoot(2);
    }

    // ===================== Vote submission guards (pre-verifier) =====================

    // JS: "rejects proofs with the wrong Merkle root before calling the verifier"
    function test_Submit_rejectsWrongMerkleRoot() public {
        (VotingTally vt,) = _deployConfiguredWithMock();
        vm.expectRevert(bytes("VotingTally: Invalid Merkle root"));
        vt.submitTally(_a(), _b(), _c(), _publicInputs(2, 0, 777, ELECTION_ID));
    }

    // JS: "rejects proofs whose election id does not match this election (audit C1)"
    function test_Submit_rejectsWrongElectionId_C1() public {
        (VotingTally vt,) = _deployConfiguredWithMock();
        vm.expectRevert(bytes("VotingTally: Invalid election id"));
        vt.submitTally(_a(), _b(), _c(), _publicInputs(1, 0, 777, 999));
    }

    // JS: "rejects out-of-range candidate indices before calling the verifier"
    // This is the line ~178 invariant: candidateIndex < numCandidates.
    function test_Submit_rejectsOutOfRangeCandidateIndex() public {
        (VotingTally vt,) = _deployConfiguredWithMock();
        // candidate == numCandidates (3) is out of range (valid: 0,1,2).
        vm.expectRevert(bytes("VotingTally: Invalid candidate index"));
        vt.submitTally(_a(), _b(), _c(), _publicInputs(1, NUM_CANDIDATES, 777, ELECTION_ID));
    }

    // ===================== Vote submission with MockVerifier =====================

    // JS: "accepts a valid vote, increments the tally, and emits VoteCast"
    function test_Submit_acceptsValidVote_incrementsTally_emits() public {
        (VotingTally vt,) = _deployConfiguredWithMock();
        uint256 candidate = 1;

        vm.expectEmit(true, true, false, true, address(vt));
        emit VoteCast(ELECTION_ID, candidate);
        vt.submitTally(_a(), _b(), _c(), _publicInputs(1, candidate, 555, ELECTION_ID));

        assertEq(vt.voteCounts(candidate), 1);
        assertTrue(vt.usedNullifiers(555));
    }

    // JS: "rejects a second vote that reuses the same nullifier"
    function test_Submit_rejectsNullifierReuse() public {
        (VotingTally vt,) = _deployConfiguredWithMock();

        vt.submitTally(_a(), _b(), _c(), _publicInputs(1, 0, 777, ELECTION_ID));

        // Same nullifier, different candidate -> still rejected.
        vm.expectRevert(bytes("VotingTally: This vote has already been cast"));
        vt.submitTally(_a(), _b(), _c(), _publicInputs(1, 2, 777, ELECTION_ID));
    }

    // JS: "rejects the vote when the verifier returns false"
    function test_Submit_rejectsWhenVerifierReturnsFalse() public {
        (VotingTally vt, MockVerifier mock) = _deployConfiguredWithMock();

        mock.setResult(false);

        vm.expectRevert(bytes("VotingTally: Invalid ZK proof"));
        vt.submitTally(_a(), _b(), _c(), _publicInputs(1, 0, 12345, ELECTION_ID));

        // A rejected proof must not consume a nullifier or move the tally.
        assertFalse(vt.usedNullifiers(12345));
        assertEq(vt.voteCounts(0), 0);
    }

    // ===================== Voting-window / time-bound reverts =====================
    // (Strengthens coverage of the time guards exercised implicitly by the JS
    //  fixture's now-1 .. now+3600 window.)

    // Vote before the window opens.
    function test_Submit_revertsBeforeVotingStarts() public {
        MockVerifier mock = new MockVerifier();
        VotingTally vt = new VotingTally(address(mock), ELECTION_ID, NUM_CANDIDATES, owner);
        vm.warp(10_000);
        uint256 nowTs = block.timestamp;
        vm.prank(owner);
        vt.configureElection(1, nowTs + 100, nowTs + 3600);

        // block.timestamp (nowTs) < votingStartTime (nowTs + 100).
        vm.expectRevert(bytes("VotingTally: Voting has not started yet"));
        vt.submitTally(_a(), _b(), _c(), _publicInputs(1, 0, 777, ELECTION_ID));
    }

    // Vote after the window closes.
    function test_Submit_revertsAfterVotingEnds() public {
        (VotingTally vt,) = _deployConfiguredWithMock();
        // Configured end was block.timestamp + 3600; warp past it.
        vm.warp(block.timestamp + 7200);
        vm.expectRevert(bytes("VotingTally: Voting has ended"));
        vt.submitTally(_a(), _b(), _c(), _publicInputs(1, 0, 777, ELECTION_ID));
    }
}
