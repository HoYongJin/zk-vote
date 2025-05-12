const { buildPoseidon } = require("circomlibjs");
const { MerkleTree } = require("fixed-merkle-tree");
const fs = require("fs");
const path = require("path");

const TREE_HEIGHT = 3;
const TREE_PATH = path.join(__dirname, "../zk/merkle.json");

// zk/merkle.json에 저장된 모든 유권자의 user_secret (string) 배열 → BigInt[]
function loadRawLeaves() {
    if (fs.existsSync(TREE_PATH)) {
        try {
            const json = JSON.parse(fs.readFileSync(TREE_PATH));
            return json.leaves.map(BigInt);
        } catch (e) {
            console.warn("⚠️ zk/merkle.json 파싱 오류! 초기화합니다.");
            return [];
        }
    }
    return [];
}

async function addUserSecret(user_secret) {
    const poseidon = await buildPoseidon();
    const raw = fs.existsSync(TREE_PATH)
        ? JSON.parse(fs.readFileSync(TREE_PATH))
        : { leaves: [] };

    const newLeaf = poseidon.F.toString(poseidon([BigInt(user_secret)]));
    
    //const existingLeaves = raw.leaves; // 이미 해시된 값들이므로 그대로 비교
    const leafSet = new Set(raw.leaves);

    console.log(`user_secret: ${user_secret}`);
    console.log(`hash: ${newLeaf}`);

    // if (!existingLeaves.includes(newLeaf)) {
    //     raw.leaves.push(newLeaf); // 이미 string이므로 toString()도 불필요
    //     fs.writeFileSync(TREE_PATH, JSON.stringify(raw, null, 2));
    //     console.log("hash(user_secret) 추가됨:", newLeaf);
    // } else {
    //     console.log("이미 존재하는 hash(user_secret):", newLeaf);
    // }
    if (!leafSet.has(newLeaf)) {
        raw.leaves.push(newLeaf);
        fs.writeFileSync(TREE_PATH, JSON.stringify(raw, null, 2));
        console.log("hash(user_secret) 추가됨:", newLeaf);
    } else {
        console.log("이미 존재하는 hash(user_secret):", newLeaf);
    }
}

async function generateMerkleProof(user_secret) {
    const poseidon = await buildPoseidon();

    const leaf = poseidon.F.toString(poseidon([BigInt(user_secret)]));
    console.log(`hash: ${leaf}`);

    const rawLeaves = fs.existsSync(TREE_PATH)
        ? JSON.parse(fs.readFileSync(TREE_PATH))
        : { leaves: [] };

    const leaves = rawLeaves.leaves;

    if(leaves.includes(leaf)) {
        console.log("TRUE");
    } else {
        console.log("FALSE");
    }

    const tree = new MerkleTree(TREE_HEIGHT, leaves.map(BigInt), {
        hashFunction: (a, b) => poseidon.F.toString(poseidon([BigInt(a), BigInt(b)])),
        zeroElement: "0"
    });

    const index = leaves.indexOf(leaf);
    if (index === -1) throw new Error("Leaf not found in Merkle Tree");

    const proof = tree.path(index);

    return {
        leaf,
        root: tree.root,
        path_elements: proof.pathElements || proof,
        path_index: proof.pathIndices || tree.pathIndices?.(index)
    };
}

module.exports = {
    addUserSecret,
    generateMerkleProof
};