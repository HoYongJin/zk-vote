pragma circom 2.0.0;

include "../circomlib/circuits/poseidon.circom";

// =====================================
// MerkleProof 템플릿
// =====================================
template MerkleProof(depth) {
    signal input leaf;
    signal input root;
    signal input pathElements[depth];
    signal input pathIndices[depth];

    signal left[depth];
    signal right[depth];
    signal a1[depth];
    signal a2[depth];
    signal b1[depth];
    signal b2[depth];
    signal cur[depth + 1];

    component hashers[depth];

    cur[0] <== leaf;

    for (var i = 0; i < depth; i++) {
        a1[i] <== pathIndices[i] * pathElements[i];
        a2[i] <== (1 - pathIndices[i]) * cur[i];
        left[i] <== a1[i] + a2[i];

        b1[i] <== pathIndices[i] * cur[i];
        b2[i] <== (1 - pathIndices[i]) * pathElements[i];
        right[i] <== b1[i] + b2[i];

        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== left[i];
        hashers[i].inputs[1] <== right[i];

        cur[i + 1] <== hashers[i].out;
    }

    cur[depth] === root;
}

// =====================================
// VoteProof 템플릿
// =====================================
template VoteProof(treeHeight, numOptions) {
    signal input user_secret;
    signal input vote[numOptions];
    signal input pathElements[treeHeight];
    signal input pathIndices[treeHeight];
    signal input root;

    signal output vote_index;

    // user_secret 해싱 → leaf
    component hasher = Poseidon(1);
    hasher.inputs[0] <== user_secret;
    signal leaf;
    leaf <== hasher.out;

    // Merkle proof 검증
    component mp = MerkleProof(treeHeight);
    mp.leaf <== leaf;
    mp.root <== root;
    for (var i = 0; i < treeHeight; i++) {
        mp.pathElements[i] <== pathElements[i];
        mp.pathIndices[i] <== pathIndices[i];
    }

    // vote 1-hot 검증
    signal sum[numOptions + 1];
    sum[0] <== 0;
    for (var i = 0; i < numOptions; i++) {
        sum[i + 1] <== sum[i] + vote[i];
    }
    sum[numOptions] === 1;

    // vote_index 계산
    signal tmp[numOptions + 1];
    tmp[0] <== 0;
    for (var i = 0; i < numOptions; i++) {
        tmp[i + 1] <== tmp[i] + vote[i] * i;
    }
    vote_index <== tmp[numOptions];
}

// =====================================
// Main 템플릿 (루트 템플릿)
// =====================================
template Main() {
    signal input root_in;
    signal input user_secret;
    signal input vote[3];
    signal input pathElements[3];
    signal input pathIndices[3];

    signal output root_out;
    signal output vote_index;

    component voteProof = VoteProof(3, 3);

    // 모든 입력 연결
    voteProof.root <== root_in;
    voteProof.user_secret <== user_secret;
    for (var i = 0; i < 3; i++) {
        voteProof.vote[i] <== vote[i];
        voteProof.pathElements[i] <== pathElements[i];
        voteProof.pathIndices[i] <== pathIndices[i];
    }

    // 출력 연결
    root_out <== root_in;               // ✨ root를 public output으로 다시 넘긴다
    vote_index <== voteProof.vote_index; // ✨ vote_index도 public output
}

// 최종 컴파일할 컴포넌트
component main = Main();
