// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// zk-SNARK 검증용 Verifier 컨트랙트를 가져옴 (Groth16으로 생성된 코드)
import "./Groth16Verifier.sol";

/// @title VotingTally - ZK 증명을 통해 투표를 집계하는 스마트 컨트랙트
contract VotingTally {
    /// @notice ZK 증명 검증기
    Groth16Verifier public verifier;

    /// @notice 후보 인덱스별 득표 수
    mapping(uint256 => uint256) public voteCounts;

    /// @notice 투표 이벤트
    event VoteSubmitted(address indexed voter, uint256 voteIndex);

    /// @param _verifier Groth16Verifier의 주소
    constructor(address _verifier) {
        verifier = Groth16Verifier(_verifier);
    }

    /// @notice ZK 증명과 공개 입력을 제출하면 투표가 집계됨
    /// @param a, b, c ZK-SNARK 증명값 (proof)
    /// @param input 공개 입력 (public signals) - [root_out, vote_index]
    function submitTally(
        uint256[2] memory a,
        uint256[2][2] memory b,
        uint256[2] memory c,
        uint256[] memory input
    ) public {
        // 공개 입력은 2개: [0] = root_out, [1] = vote_index
        require(input.length == 2, "Invalid input length");

        // Verifier가 요구하는 입력 형식에 맞게 변환
        uint256[2] memory publicSignals;
        publicSignals[0] = input[0]; // Merkle Root
        publicSignals[1] = input[1]; // vote index (선택한 후보 인덱스)

        // ZK 증명 검증: 유효하지 않으면 실패 처리
        bool isValid = verifier.verifyProof(a, b, c, publicSignals);
        require(isValid, "Invalid ZK proof");

        // 유효한 투표일 경우 집계
        uint256 voteIndex = publicSignals[1];
        voteCounts[voteIndex] += 1;

        // 투표 이벤트 기록
        emit VoteSubmitted(msg.sender, voteIndex);
    }

    /// @notice 특정 후보의 득표 수 확인
    /// @param voteIndex 후보 인덱스
    /// @return count 해당 후보의 득표 수
    function getVoteCount(uint256 voteIndex) public view returns (uint256 count) {
        return voteCounts[voteIndex];
    }
}
