const { buildPoseidon } = require("circomlibjs");
const { MerkleTree } = require("fixed-merkle-tree");
const supabase = require("../supabaseClient");
const redis = require('../redisClient');
require("dotenv").config();

const TREE_HEIGHT = parseInt(process.env.MERKLE_TREE_HEIGHT, 10) || 3;
const SINGLETON_ID = "singleton";                   // DB에서 고정 ID를 사용하는 단일 인스턴스

const MERKLE_LOCK_KEY = "merkle_update_lock";       // 분산 잠금을 위한 키
const MERKLE_TREE_CACHE_KEY = "merkle_tree_cache";  // 캐싱을 위한 키
const LOCK_TIMEOUT = 10;                            // 잠금은 10초 후에 자동으로 풀림 (초 단위)
const POLLING_INTERVAL = 100;                       // 100ms 간격으로 잠금 획득 재시도
const POLLING_TIMEOUT = 5000;                       // 최대 5초까지만 대기

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
// Redis 분산 잠금을 사용하여 동시성 문제를 해결하고, 작업 후 캐시를 무효화
async function addUserSecret(user_secret) {
    // Poseidon 해시 함수 로딩
    const poseidon = await getPoseidon();

    // user_secret을 Poseidon 해시로 변환
    const newLeaf = poseidon.F.toString(poseidon([BigInt(user_secret)]));

    const startTime = Date.now();

    while(true) {
        // Redis 분산 잠금 획득 시도
        // 'NX' 옵션: 키가 존재하지 않을 때만 설정 (원자적)
        // 'EX' 옵션: 5초 후 자동으로 잠금 해제 (서버 비정상 종료 대비)
        const lockAcquired = await redis.set(MERKLE_LOCK_KEY, 'locked', 'NX', 'EX', LOCK_TIMEOUT);

        // 잠금 획득 성공! 루프를 빠져나가 실제 작업을 수행
        if (lockAcquired) {
            console.log("Lock acquired. Proceeding with DB update.");
            break;
        }

        // 잠금 획득 실패 시, 타임아웃 확인
        if (Date.now() - startTime > POLLING_TIMEOUT) {
            throw new Error("Could not acquire lock after waiting. The system is busy. Please try again later.");
        }

        // 잠시 대기 후 다시 시도
        await new Promise(resolve => setTimeout(resolve, POLLING_INTERVAL));
    }

    try {
        // --- 잠금을 획득한 동안 안전하게 작업 수행 ---
        const existingLeaves = await loadLeavesFromDB();

        // newLeaf 기존 leaf에 존재하는지 중복 검사
        if (existingLeaves.includes(newLeaf)) {
            console.log("ALREADY EXIST: ", newLeaf);
            return; // 이미 존재하면 작업 종료
        }

        // 새로운 leaf 포함한 merkle_data 생성
        const updated = {
            id: SINGLETON_ID,
            merkle_data: { leaves: [...existingLeaves, newLeaf] },
            updated_at: new Date()
        };

        const { error } = await supabase
            .from("MerkleState")
            .upsert([updated]);

        if (error) {
            console.error("MERKLESTATE UPDATE FAIL: ", error.message);
        } else {
            console.log("MERKLESTATE UPDATE SUCCESS: ", newLeaf);
        }

        // DB 업데이트 성공 시, Redis 캐시를 삭제하여 데이터 일관성 유지
        await redis.del(MERKLE_TREE_CACHE_KEY);
        console.log("Merkle Tree cache invalidated due to new leaf addition.");
        console.log("MERKLESTATE UPDATE SUCCESS: ", newLeaf);
    } finally {
        // 작업이 성공하든 실패하든, 반드시 잠금을 해제하여 다른 요청이 처리될 수 있도록 함
        await redis.del(MERKLE_LOCK_KEY);
    }
}

// user_secret을 받아 merkle_data에 해당 정보(Leaf)가 있으면 Merkle Proof 생성 후 반환하는 함수
// Redis 캐싱을 사용하여 DB 조회를 최소화하고 성능을 향상
async function generateMerkleProof(user_secret) {
    // Poseidon 해시 함수 로딩
    const poseidon = await getPoseidon();

    // 입력된 user_secret을 해싱하여 Merkle Tree의 leaf 값으로 사용
    const leaf = poseidon.F.toString(poseidon([BigInt(user_secret)]));

    let tree;
    let rawLeaves;

    // Redis 캐시에서 leaf 목록 조회 시도
    const cachedLeaves = await redis.get(MERKLE_TREE_CACHE_KEY);

    if (cachedLeaves) {
        // Cache Hit: Redis에 데이터가 있으면 DB 조회 없이 바로 사용
        console.log("Merkle Tree cache hit");
        rawLeaves = JSON.parse(cachedLeaves);
    } else {
        // Cache Miss: Redis에 데이터가 없으면 DB에서 조회
        console.log("Merkle Tree cache miss. Loading from DB");
        rawLeaves = await loadLeavesFromDB();
        
        // DB에서 가져온 정보를 다음번을 위해 Redis 캐시에 저장
        await redis.set(MERKLE_TREE_CACHE_KEY, JSON.stringify(rawLeaves));
    }

    // 가져온 leaf 목록으로 메모리에서 Merkle Tree 구성
    tree = new MerkleTree(TREE_HEIGHT, rawLeaves.map(BigInt), {
        hashFunction: (a, b) => poseidon.F.toString(poseidon([BigInt(a), BigInt(b)])),
        zeroElement: "0"
    });

    // Tree에서 증명 생성
    const index = rawLeaves.indexOf(leaf);

    // Merkle Tree 안에 사용자의 leaf가 없다면 오류 처리
    if (index === -1)   throw new Error("LEAF NOT FOUND IN MERKLE TREE");

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
