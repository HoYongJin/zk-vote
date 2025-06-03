pragma circom 2.0.0;

include "../circomlib/circuits/poseidon.circom";

// =====================================
// MerkleProof 회로 템플릿(입력받은 merkle_data를 이용해서 root 계산 후 제공된 root와 일치하는지 확인)
// =====================================
template MerkleProof(depth) {
    // 입력 신호 정의
    signal input leaf;                          // Merkle Tree에서 검증할 leaf 해시값
    signal input root;                          // 기대하는 Merkle Root
    signal input pathElements[depth];           // Merkle path: 형제 노드들
    signal input pathIndices[depth];            // Merkle path: 각 단계에서의 방향 정보(0: 왼쪽, 1: 오른쪽)

    // 내부 계산용 신호
    signal left[depth];                         // 각 단계에서 왼쪽 자식 노드
    signal right[depth];                        // 각 단계에서 오른쪽 자식 노드
    signal a1[depth];                           // left 계산용 분기
    signal a2[depth];                           // left 계산용 분기
    signal b1[depth];                           // right 계산용 분기
    signal b2[depth];                           // right 계산용 분기
    signal cur[depth + 1];                      // 각 단계에서의 결과 해시값

    // Poseidon 해시 컴포넌트 배열
    component hashers[depth];

    // 초기 노드 설정 (leaf부터 시작)
    cur[0] <== leaf;

    // 각 단계마다 Merkle hash 계산
    for (var i = 0; i < depth; i++) {
        // left[i] 결정
        // pathIndices = 0 --> a1 = 0, a2 = myLeaf          --> left = a1 + a2 = myLeaf
        // pathIndices = 1 --> a1 = pathElements, a2 = 0    --> left = a1 + a2 = pathElements
        a1[i] <== pathIndices[i] * pathElements[i];
        a2[i] <== (1 - pathIndices[i]) * cur[i];
        left[i] <== a1[i] + a2[i];

        // right[i] 결정:
        // pathIndices = 0 --> b1 = 0, b2 = pathElements    --> right = b1 + b2 = pathElements
        // pathIndices = 1 --> b1 = myLeaf, b2 = 0          --> right = b1 + b2 = myLeaf
        b1[i] <== pathIndices[i] * cur[i];
        b2[i] <== (1 - pathIndices[i]) * pathElements[i];
        right[i] <== b1[i] + b2[i];

        // Poseidon 해싱 수행
        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== left[i];
        hashers[i].inputs[1] <== right[i];

        // 다음 단계 해시 결과 저장
        cur[i + 1] <== hashers[i].out;
    }
    // 최종 계산 결과가 주어진 root와 일치해야 함
    cur[depth] === root;
}

// =====================================
// VoteProof 템플릿
// =====================================
template VoteProof(treeHeight, numOptions) {
    signal input user_secret;                   // 사용자 user_secret
    signal input vote[numOptions];              // 투표 배열
    signal input pathElements[treeHeight];      // Merkle path: 형제 노드들
    signal input pathIndices[treeHeight];       // Merkle path: 각 단계에서의 방향 정보(0: 왼쪽, 1: 오른쪽)
    signal input root;                          // 기대하는 Merkle Root

    signal output vote_index;                   // 선택된 후보 인덱스

    // 1. user_secret을 해시하여 leaf 생성
    component hasher = Poseidon(1);
    hasher.inputs[0] <== user_secret;
    signal leaf;
    leaf <== hasher.out;

    // 2. Merkle 증명 회로 구성(MerkleProof 템플릿을 활용)
    component mp = MerkleProof(treeHeight);
    mp.leaf <== leaf;
    mp.root <== root;

    // Merkle 경로 연결
    for (var i = 0; i < treeHeight; i++) {
        mp.pathElements[i] <== pathElements[i];
        mp.pathIndices[i] <== pathIndices[i];
    }

    // 3. 투표 배열 검증: 전체 합이 1이어야 함
    signal sum[numOptions + 1];
    sum[0] <== 0;

    for (var i = 0; i < numOptions; i++) {
        vote[i] * (1 - vote[i]) === 0;          // vote[i] ∈ {0, 1} 강제
        sum[i + 1] <== sum[i] + vote[i];        // 누적합 계산
    }
    sum[numOptions] === 1;                      // 총합이 1이어야 유효한 1-hot

    // 4. 투표배열에서 선택된 인덱스 계산
    signal tmp[numOptions + 1];
    tmp[0] <== 0;

    for (var i = 0; i < numOptions; i++) {
        tmp[i + 1] <== tmp[i] + vote[i] * i;
    }
    vote_index <== tmp[numOptions];
}

// =====================================
// Main 템플릿
// =====================================
template Main(treeHeight, numOptions) {
    // 입력 정의
    signal input root_in;               // 공개 Merkle Root
    signal input user_secret;           // 사용자 user_secret
    signal input vote[3];               // 투표 배열
    signal input pathElements[3];       // Merkle path: 형제 노드들
    signal input pathIndices[3];        // Merkle path: 각 단계에서의 방향 정보(0: 왼쪽, 1: 오른쪽)

    signal output root_out;             // 검증된 공개 Merkle Root
    signal output vote_index;           // 선택된 후보 인덱스

    // VoteProof 하위 회로 구성
    component voteProof = VoteProof(treeHeight, numOptions);

    // 모든 입력 연결
    voteProof.root <== root_in;
    voteProof.user_secret <== user_secret;

    for (var i = 0; i < treeHeight; i++) {
        voteProof.pathElements[i] <== pathElements[i];
        voteProof.pathIndices[i] <== pathIndices[i];
    }

    for (var i = 0; i < numOptions; i++) {
        voteProof.vote[i] <== vote[i];
    }

    // 출력 연결
    root_out <== root_in;                   // root_in(검증완료)을 public output으로 넘긴다
    vote_index <== voteProof.vote_index;    // vote_index(검증완료)를 public output으로 넘긴다
}

// 컴파일 대상 인스턴스 정의 (트리 높이 3, 후보 3명)
component main = Main(3, 3);
