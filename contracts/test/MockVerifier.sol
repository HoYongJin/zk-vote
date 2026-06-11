// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title MockVerifier
 * @dev Test-only verifier whose `verifyProof` returns a configurable boolean.
 * It implements the SAME signature as the real Groth16 verifier / IVerifier
 * (uint256[4] public signals), so VotingTally's submit path can be exercised
 * (success, duplicate nullifier, wrong election, wrong root, invalid candidate,
 * and an explicitly-rejecting verifier) without generating real proofs.
 */
contract MockVerifier {
    bool public result = true;

    function setResult(bool _result) external {
        result = _result;
    }

    function verifyProof(
        uint256[2] memory,
        uint256[2][2] memory,
        uint256[2] memory,
        uint256[4] memory
    ) external view returns (bool) {
        return result;
    }
}
