// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// // zk-SNARK 검증용 Verifier 컨트랙트를 가져옴 (Groth16으로 생성된 코드)
// import "./Groth16Verifier.sol";

// /// @title VotingTally - ZK 증명을 통해 투표를 집계하는 스마트 컨트랙트
// contract VotingTally {
//     /// @notice ZK 증명 검증기
//     Groth16Verifier public verifier;

//     /// @notice 후보 인덱스별 득표 수
//     mapping(uint256 => uint256) public voteCounts;

//     /// @notice 투표 이벤트
//     event VoteSubmitted(address indexed voter, uint256 voteIndex);

//     /// @param _verifier Groth16Verifier의 주소
//     constructor(address _verifier) {
//         verifier = Groth16Verifier(_verifier);
//     }

//     /// @notice ZK 증명과 공개 입력을 제출하면 투표가 집계됨
//     /// @param a, b, c ZK-SNARK 증명값 (proof)
//     /// @param input 공개 입력 (public signals) - [root_out, vote_index]
//     function submitTally(
//         uint256[2] memory a,
//         uint256[2][2] memory b,
//         uint256[2] memory c,
//         uint256[] memory input
//     ) public {
//         // 공개 입력은 2개: [0] = root_out, [1] = vote_index
//         require(input.length == 2, "Invalid input length");

//         // Verifier가 요구하는 입력 형식에 맞게 변환
//         uint256[2] memory publicSignals;
//         publicSignals[0] = input[0]; // Merkle Root
//         publicSignals[1] = input[1]; // vote index (선택한 후보 인덱스)

//         // ZK 증명 검증: 유효하지 않으면 실패 처리
//         bool isValid = verifier.verifyProof(a, b, c, publicSignals);
//         require(isValid, "Invalid ZK proof");

//         // 유효한 투표일 경우 집계
//         uint256 voteIndex = publicSignals[1];
//         voteCounts[voteIndex] += 1;

//         // 투표 이벤트 기록
//         emit VoteSubmitted(msg.sender, voteIndex);
//     }

//     /// @notice 특정 후보의 득표 수 확인
//     /// @param voteIndex 후보 인덱스
//     /// @return count 해당 후보의 득표 수
//     function getVoteCount(uint256 voteIndex) public view returns (uint256 count) {
//         return voteCounts[voteIndex];
//     }
// }

// 1. Verifier 컨트랙트의 인터페이스를 먼저 정의합니다.
// 이렇게 하면 VotingTally 컨트랙트가 Verifier의 verifyProof 함수를 호출할 수 있습니다.
interface IVerifier {
    function verifyProof(
        uint256[2] memory a,
        uint256[2][2] memory b,
        uint256[2] memory c,
        uint256[3] memory input // [root, vote_index, nullifier_hash]
    ) external view returns (bool r);
}

/**
 * @title VotingTally
 * @dev ZK-SNARK 증명을 이용해 투표를 집계하고 이중 투표를 방지하는 컨트랙트입니다.
 */
contract VotingTally {
    address public owner; // 컨트랙트 소유자 (관리자)
    IVerifier public verifier; // 증명 검증을 수행할 Verifier 컨트랙트

    uint256 public merkleRoot; // 이 선거에서 유효한 유권자 명단의 Merkle Root
    uint256 public electionId; // 이 선거의 고유 ID

    uint256 public votingStartTime;
    uint256 public votingEndTime;

    // 후보자별 득표수를 저장합니다. (예: 3명의 후보자)
    mapping(uint256 => uint256) public voteCounts;

    // 사용된 널리파이어를 기록하여 이중 투표를 방지합니다.
    mapping(uint256 => bool) public usedNullifiers;

    // --- 이벤트 ---

    // 새로운 투표가 성공적으로 집계될 때마다 발생하는 이벤트
    event VoteCast(uint256 indexed candidateIndex);
    // Merkle Root가 설정될 때 발생하는 이벤트
    event MerkleRootSet(uint256 root);

    // --- 제어자(Modifier) ---

    // 함수를 소유자만 호출할 수 있도록 제한하는 제어자
    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner can call this function.");
        _;
    }

    // --- 생성자 ---

    /**
     * @dev 컨트랙트 배포 시 Verifier 컨트랙트의 주소와 선거 ID를 설정합니다.
     * @param _verifierAddress 배포된 Groth16Verifier_3 컨트랙트의 주소
     * @param _electionId 이 선거를 식별할 고유 ID
     */
    constructor(address _verifierAddress, uint256 _electionId) {
        owner = msg.sender;
        verifier = IVerifier(_verifierAddress);
        electionId = _electionId;
    }

    // --- 관리자 기능 ---

    /**
     * @dev 소유자가 선거를 시작하며 유효한 Merkle Root를 설정합니다.
     * @param _root 서버에서 생성된 유권자 명단의 Merkle Root
     */
    function setMerkleRoot(uint256 _root) external onlyOwner {
        merkleRoot = _root;
        emit MerkleRootSet(_root);
    }

    function setVotingPeriod(uint256 _startTime, uint256 _endTime) external onlyOwner{
        require(_startTime < _endTime, "Start time must be before end time");
        votingStartTime = _startTime;
        votingEndTime = _endTime;
    }

    // --- 핵심 기능 (투표 제출) ---

    /**
     * @dev 사용자가 ZK 증명을 제출하여 투표를 집계합니다.
     * @param a ZK 증명의 일부
     * @param b ZK 증명의 일부
     * @param c ZK 증명의 일부
     * @param input 공개 입력값 배열 [merkleRoot, voteIndex, nullifierHash]
     */
    function submitTally(
        uint256[2] memory a,
        uint256[2][2] memory b,
        uint256[2] memory c,
        uint256[3] memory input
    ) external {
        require(block.timestamp >= votingStartTime, "Voting has no started yet");
        require(block.timestamp < votingEndTime, "Voting has ended");

        // 1. Merkle Root가 설정되었는지 확인 (선거가 시작되었는지 확인)
        require(merkleRoot != 0, "Voting has not started yet.");

        // 2. 증명에 사용된 Merkle Root가 컨트랙트에 설정된 Root와 일치하는지 확인
        require(input[0] == merkleRoot, "Invalid Merkle Root.");

        // 3. 이중 투표 방지: 널리파이어가 이미 사용되었는지 확인
        uint256 nullifierHash = input[2];
        require(!usedNullifiers[nullifierHash], "Vote has already been cast.");

        // 4. Verifier 컨트랙트를 호출하여 증명이 유효한지 검증
        bool isValid = verifier.verifyProof(a, b, c, input);
        require(isValid, "Invalid ZK proof.");

        // 5. 모든 검증을 통과하면, 널리파이어를 기록하고 투표 수를 증가시킴
        usedNullifiers[nullifierHash] = true;
        uint256 candidateIndex = input[1];
        voteCounts[candidateIndex]++;

        // 6. 이벤트 발생
        emit VoteCast(candidateIndex);
    }
}