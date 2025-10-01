const { buildPoseidon } = require("circomlibjs");
const { MerkleTree } = require("fixed-merkle-tree");
const supabase = require("../supabaseClient");
const redis = require('../redisClient');
require("dotenv").config();

//const TREE_HEIGHT = parseInt(process.env.MERKLE_TREE_HEIGHT, 10) || 3;

// const MERKLE_LOCK_KEY = "merkle_update_lock";       // 분산 잠금을 위한 키
// const MERKLE_TREE_CACHE_KEY = "merkle_tree_cache";  // 캐싱을 위한 키
const LOCK_TIMEOUT_SECONDS = 10;                            // A lock will auto-expire after 10 seconds.
const POLLING_INTERVAL_MS = 100;                       // Wait 100ms between lock acquisition attempts.
const POLLING_TIMEOUT_MS = 5000;                       // Give up acquiring the lock after 5 seconds.

// Poseidon 해시 함수는 비동기 초기화되므로 전역에 한 번만 로드해서 재사용
let poseidon;

// Poseidon 해시 함수를 캐싱하여 반환
async function getPoseidon() {
    if (!poseidon) {
        poseidon = await buildPoseidon();
    }
    return poseidon;
}

/**
 * Fetches the current list of leaves for a given election from the database.
 * @param {string} election_id - The UUID of the election.
 * @returns {Promise<string[]>} An array of leaves.
 */
async function loadLeavesFromDB(election_id) {
    const { data, error } = await supabase
        .from("MerkleState")
        .select("merkle_data")
        .eq("election_id", election_id)
        .single();

    if (error && error.code !== 'PGRST116') {
        console.error("Failed to load Merkle state from DB:", error.message);
        throw error;
    }

    return data?.merkle_data?.leaves || [];
}

/**
 * Adds a new user secret to the Merkle tree state, handling concurrency with a distributed lock.
 * After a successful DB update, it invalidates the Redis cache for this tree.
 * @param {string} election_id - The UUID of the election.
 * @param {string} user_secret - The secret to add.
 */
async function addUserSecret(election_id, user_secret) {
    const poseidon = await getPoseidon();
    const newLeaf = poseidon.F.toString(poseidon([BigInt(user_secret)]));

    const MERKLE_LOCK_KEY = `merkle_lock: ${election_id}`;
    const MERKLE_TREE_CACHE_KEY = `merkle_cache: ${election_id}`;
    const startTime = Date.now();

    // --- Acquire Distributed Lock ---
    while(true) {
        // Attempt to acquire the lock atomically.
        // 'NX': Set only if the key does not exist.
        // 'EX': Set an expiration time in seconds.
        const lockAcquired = await redis.set(MERKLE_LOCK_KEY, 'locked', { NX: true, EX: LOCK_TIMEOUT_SECONDS });

        if (lockAcquired) {
            console.log(`Lock acquired for election: ${election_id}.`);
            break; // Exit loop and proceed with the critical section.
        }

        // Check for timeout if lock is not acquired.
        if (Date.now() - startTime > POLLING_TIMEOUT_MS) {
            throw new Error("Failed to acquire Merkle tree lock due to timeout. System may be busy.");
        }

        // Wait before retrying.
        await new Promise(resolve => setTimeout(resolve, POLLING_INTERVAL_MS));
    }

    try {
        // --- Critical Section: Guaranteed to be executed by only one process at a time ---
        const existingLeaves = await loadLeavesFromDB(election_id);

        if (existingLeaves.includes(newLeaf)) {
            console.log(`Leaf for election ${election_id} already exists. Skipping.`);
            return;
        }

        // 새로운 leaf 포함한 merkle_data 생성
        const updated = {
            election_id: election_id,
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

        // --- Cache Invalidation ---
        // After successfully updating the source of truth (DB), invalidate the cache.
        await redis.del(MERKLE_TREE_CACHE_KEY);
        console.log(`Merkle Tree for election ${election_id} updated. Cache invalidated.`);
    } finally {
        // --- Release Lock ---
        // Always release the lock, whether the operation succeeded or failed.
        await redis.del(MERKLE_LOCK_KEY);
        console.log(`Lock released for election ${election_id}.`);
    }
}

/**
 * Generates a Merkle proof for a given user secret, using Redis for caching.
 * @param {string} election_id - The UUID of the election.
 * @param {string} user_secret - The user's secret to generate a proof for.
 * @returns {Promise<Object>} The Merkle proof components required by the ZKP circuit.
 */
async function generateMerkleProof(election_id, user_secret) {
    const poseidon = await getPoseidon();
    const leaf = poseidon.F.toString(poseidon([BigInt(user_secret)]));

    const MERKLE_TREE_CACHE_KEY = `merkle_cache: ${election_id}`;     // 캐싱을 위한 키

    let rawLeaves;

    // --- Cache Look-up ---
    const cachedLeaves = await redis.get(MERKLE_TREE_CACHE_KEY);

    if (cachedLeaves) {
        // Cache Hit: Redis에 데이터가 있으면 DB 조회 없이 바로 사용
        console.log(`Cache hit for election ${election_id} Merkle tree.`);
        rawLeaves = JSON.parse(cachedLeaves);
    } else {
        // Cache Miss: Redis에 데이터가 없으면 DB에서 조회
        console.log(`Cache miss for election ${election_id}. Loading from DB.`);
        rawLeaves = await loadLeavesFromDB(election_id);
        
        // Store the freshly loaded data in the cache for subsequent requests.
        // Set an expiration (e.g., 1 hour) to prevent stale data in case of errors.
        await redis.set(MERKLE_TREE_CACHE_KEY, JSON.stringify(leaves), { EX: 3600 });
    }

    const { data: election, error } = await supabase
        .from("Elections")
        .select("merkle_tree_depth")
        .eq("id", election_id)
        .single();
    if (error || !election) throw new Error("Could not fetch election details to build Merkle tree.");


    // 가져온 leaf 목록으로 메모리에서 Merkle Tree 구성
    const tree = new MerkleTree(election.merkle_tree_depth, rawLeaves.map(BigInt), {
        hashFunction: (a, b) => poseidon.F.toString(poseidon([BigInt(a), BigInt(b)])),
        zeroElement: "21663839004416932945382355908790599225266501822907911457504D8515578255421292"
    });

    // Tree에서 증명 생성
    const index = rawLeaves.indexOf(leaf);
    if (index === -1) {
        throw new Error("Leaf not found in Merkle tree. The user might not be registered.");
    }

    // 인덱스를 기준으로 ZKP에서 사용할 Merkle proof 경로 생성
    const proof = tree.path(index);

    // 생성된 Merkle proof 반환
    return {
        leaf,                                                            // user_secret으로부터 생성된 해시 leaf
        root: tree.root.toString(),                                      // merkle_data(leaves)로 만들어진 Merkle Tree의 최상위 루트 해시
        pathElements: proof.pathElements.map(el => el.toString()),      // pathElements: 해당 leaf에서 root까지 올라가는 경로에 있는 형제 노드들의 값
        pathIndices: proof.pathIndices                                    // pathIndices: 각 레벨에서 본인이 왼쪽(0)인지 오른쪽(1)인지 표시
    };
}

module.exports = {
  addUserSecret,
  generateMerkleProof
};
