// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./Groth16Verifier.sol";

contract VotingTally {
    Groth16Verifier public verifier;
    mapping(uint256 => uint256) public voteCounts;

    event VoteSubmitted(address indexed voter, uint256 voteIndex);

    constructor(address _verifier) {
        verifier = Groth16Verifier(_verifier);
    }

    function submitTally(
    uint256[2] memory a,
    uint256[2][2] memory b,
    uint256[2] memory c,
    uint256[] memory input
) public {
    require(input.length == 2, "Invalid input length");

    uint256[2] memory publicSignals;
    publicSignals[0] = input[0]; // merkle_root
    publicSignals[1] = input[1]; // vote_index

    bool isValid = verifier.verifyProof(a, b, c, publicSignals);
    require(isValid, "Invalid ZK proof");

    uint256 voteIndex = publicSignals[1];
    voteCounts[voteIndex] += 1;

    emit VoteSubmitted(msg.sender, voteIndex);
}

    function getVoteCount(uint256 voteIndex) public view returns (uint256) {
        return voteCounts[voteIndex];
    }
}
