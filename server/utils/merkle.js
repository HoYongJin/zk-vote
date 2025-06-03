const { buildPoseidon } = require("circomlibjs");
const { MerkleTree } = require("fixed-merkle-tree");    // 고정 크기의 Merkle Tree 생성 라이브러리
const supabase = require("../supabaseClient");
require("dotenv").config();

const TREE_HEIGHT = 3;
const SINGLETON_ID = "singleton";     // DB에서 고정 ID를 사용하는 단일 인스턴스

// Poseidon 해시 함수는 비동기 초기화되므로 전역에 한 번만 로드해서 재사용
let poseidon;

// Poseidon 해시 함수를 캐싱하여 반환
async function getPoseidon() {
    if (!poseidon) {
        poseidon = await buildPoseidon();
    }
    return poseidon;
}

// DB에서 MerkleState의 merkle_data(leaves) 정보 불러오기
// merkle_data: { leaves: [...] }
async function loadLeavesFromDB() {
    const { data, error } = await supabase
        .from("MerkleState")
        .select("merkle_data")
        .eq("id", SINGLETON_ID)
        .maybeSingle();

    if (error) {
        console.error("MERKLESTATE LOAD FAIL: ", error.message);
        return [];
    }

    // merkle_data.leaves 배열 반환
    return data?.merkle_data?.leaves || [];
}

// user_secret을 Poseidon 해시하여 merkle_data에 추가하여 업데이트하는 함수
async function addUserSecret(user_secret) {
    // Poseidon 해시 함수 로딩
    const poseidon = await getPoseidon();

    // user_secret을 Poseidon 해시로 변환
    const newLeaf = poseidon.F.toString(poseidon([BigInt(user_secret)]));

    // 기존 merkle_data(leaves) 불러오기
    const existingLeaves = await loadLeavesFromDB();

    // newLeaf 기존 leaf에 존재하는지 중복 검사
    if (existingLeaves.includes(newLeaf)) {
        console.log("ALREADY EXIST: ", newLeaf);
        return;
    }

    // 새로운 leaf 포함한 merkle_data 생성
    const updated = {
        id: SINGLETON_ID,
        merkle_data: { leaves: [...existingLeaves, newLeaf] },
        updated_at: new Date()
    };

    // 새롭게 생성한 merkle_data를 DB에 업데이트
    const { error } = await supabase
        .from("MerkleState")
        .upsert([updated]);

    if (error) {
        console.error("MERKLESTATE UPDATE FAIL: ", error.message);
    } else {
        console.log("MERKLESTATE UPDATE SUCCESS: ", newLeaf);
    }
}

// user_secret을 받아 merkle_data에 해당 정보(Leaf)가 있으면 Merkle Proof 생성 후 반환하는 함수
async function generateMerkleProof(user_secret) {
    // Poseidon 해시 함수 로딩
    const poseidon = await getPoseidon();

    // 입력된 user_secret을 해싱하여 Merkle Tree의 leaf 값으로 사용
    // Poseidon Hash를 위해서 user_secret(String) 값을 BigInt로 변환해줌
    const leaf = poseidon.F.toString(poseidon([BigInt(user_secret)]));

    // 기존 merkle_data(leaves) 불러오기(String 배열)
    const rawLeaves = await loadLeavesFromDB();

    // 불러온 merkle_data(leaves)를 BigInt 배열로 변환
    const leaves = rawLeaves.map(BigInt);

    // 불러온 merkle_data(leaves) 정보를 기반으로 Merkle Tree 생성
    // leaves: 입력은 BigInt 형식으로 받음
    // hashFunction(Poseidon 사용): 좌우 노드를 해싱하여 부모 노드(String)를 생성하는 함수
    // [BigInt(a), BigInt(b)]: hashFunction에서 String 값으로 저장되었기 때문에 BigInt로 다시 변횐
    // zeroElement: 트리의 빈 노드를 채울 기본값.(String: "0"이어야 타입 일치)
    const tree = new MerkleTree(TREE_HEIGHT, leaves, {
        hashFunction: (a, b) => poseidon.F.toString(poseidon([BigInt(a), BigInt(b)])),
        zeroElement: "0"        
    });

    // 현재 사용자의 leaf가 leaves 배열의 몇 번째 인덱스에 있는지 확인
    // 이 인덱스를 기준으로 Merkle proof를 생성
    const index = rawLeaves.indexOf(leaf);

    // Merkle Tree 안에 사용자의 leaf가 없다면 오류 처리
    if (index === -1) throw new Error("LEAF NOT FOUND IN MERKLE TREE");

    // 인덱스를 기준으로 ZKP에서 사용할 Merkle proof 경로 생성
    const proof = tree.path(index);

    // 생성된 Merkle proof 반환
    return {
        leaf,                                   // user_secret으로부터 생성된 해시 leaf
        root: tree.root,                        // merkle_data(leaves)로 만들어진 Merkle Tree의 최상위 루트 해시
        path_elements: proof.pathElements,      // pathElements: 해당 leaf에서 root까지 올라가는 경로에 있는 형제 노드들의 값
        path_index: proof.pathIndices           // pathIndices: 각 레벨에서 본인이 왼쪽(0)인지 오른쪽(1)인지 표시
    };
}

module.exports = {
  addUserSecret,
  generateMerkleProof
};
