const { buildPoseidon } = require("circomlibjs");
const { MerkleTree } = require("fixed-merkle-tree");
const supabase = require("../supabaseClient");

const TREE_HEIGHT = 3;
const SINGLETON_ID = "singleton";

// DB에서 Merkle leaves 전체 불러오기
async function loadLeavesFromDB() {
  const { data, error } = await supabase
    .from("MerkleState")
    .select("leaves")
    .eq("id", SINGLETON_ID)
    .maybeSingle();

  if (error) {
    console.error("[DB ERROR] MerkleState load 실패:", error.message);
    return [];
  }

  return data?.leaves?.leaves || [];
}

// user_secret을 추가하고 DB 업데이트
async function addUserSecret(secret) {
  const poseidon = await buildPoseidon();
  const newLeaf = poseidon.F.toString(poseidon([BigInt(secret)]));

  const existingLeaves = await loadLeavesFromDB();

  if (existingLeaves.includes(newLeaf)) {
    console.log("이미 존재하는 해시:", newLeaf);
    return;
  }

  const updated = {
    id: SINGLETON_ID,
    leaves: { leaves: [...existingLeaves, newLeaf] },
    updated_at: new Date()
  };

  const { error } = await supabase
    .from("MerkleState")
    .upsert([updated]);

  if (error) {
    console.error("[DB ERROR] MerkleState 저장 실패:", error.message);
  } else {
    console.log("Merkle leaf DB에 저장 완료:", newLeaf);
  }
}

// ZK 입력용 Merkle Proof 생성
async function generateMerkleProof(user_secret) {
  const poseidon = await buildPoseidon();
  const leaf = poseidon.F.toString(poseidon([BigInt(user_secret)]));

  const rawLeaves = await loadLeavesFromDB();
  const leaves = rawLeaves.map(BigInt);

  const tree = new MerkleTree(TREE_HEIGHT, leaves, {
    hashFunction: (a, b) => poseidon.F.toString(poseidon([BigInt(a), BigInt(b)])),
    zeroElement: "0"
  });

  const index = rawLeaves.indexOf(leaf);
  if (index === -1) throw new Error("Merkle Tree에 leaf가 없음");

  const proof = tree.path(index);

  return {
    leaf,
    root: tree.root,
    path_elements: proof.pathElements,
    path_index: proof.pathIndices
  };
}

module.exports = {
  addUserSecret,
  generateMerkleProof
};
