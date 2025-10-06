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

async function loadSecretsFromDB(election_id) {
    const { data: voters, error } = await supabase
        .from("Voters")
        .select("user_secret")
        .eq("election_id", election_id)
        .not("user_secret", "is", null)
        .order('id', { ascending: true });

    if (error) {
        console.error("Failed to load user secrets from DB:", error.message);
        throw error;
    }
    return voters.map(v => v.user_secret);
}

// /**
//  * Fetches the current list of leaves for a given election from the database.
//  * @param {string} election_id - The UUID of the election.
//  * @returns {Promise<string[]>} An array of leaves.
//  */
// async function loadLeavesFromDB(election_id) {
//     const { data, error } = await supabase
//         .from("MerkleState")
//         .select("merkle_data")
//         .eq("election_id", election_id)
//         .single();

//     if (error && error.code !== 'PGRST116') {
//         console.error("Failed to load Merkle state from DB:", error.message);
//         throw error;
//     }

//     return data?.merkle_data?.leaves || [];
// }

/**
 * @param {string} election_id - The UUID of the election.
 * @returns {Promise<MerkleTree>} The fully constructed MerkleTree object.
 */
async function generateMerkleTree(election_id) {
    const poseidon = await getPoseidon();
    const MERKLE_TREE_CACHE_KEY = `merkle_cache:secrets:${election_id}`;

    let leaves;
    const cachedLeaves = await redis.get(MERKLE_TREE_CACHE_KEY);

    if(cachedLeaves) {
        console.log(`Cache hit for election ${election_id} leaves.`);
        leaves = JSON.parse(cachedLeaves);
    } else {
        console.log(`Cache miss for election ${election_id}. Loading secrets from DB.`);
        const secrets = await loadSecretsFromDB(election_id);
        
        // [핵심 보안] 원본 secret이 아닌, 해시된 leaf 값을 계산합니다.
        leaves = secrets.map(secret => poseidon.F.toString(poseidon([BigInt(secret)])));

        if (leaves.length > 0) {
            // [핵심 보안] 해시된 leaf 목록을 캐시에 저장합니다.
            await redis.set(
                MERKLE_TREE_CACHE_KEY, 
                JSON.stringify(leaves), 
                'EX', // 구버전 호환 문법
                3600  // 1 hour
            );
        }
    }

    const { data: election, error } = await supabase
        .from("Elections")
        .select("merkle_tree_depth")
        .eq("id", election_id)
        .single();

    if (error || !election) throw new Error(`Could not fetch election details for ${election_id}`);

    return new MerkleTree(election.merkle_tree_depth, leaves, {
        hashFunction: (a, b) => poseidon.F.toString(poseidon([a, b])),
        zeroElement: "21663839004416932945382355908790599225266501822907911457504978515578255421292"
    });
}

/**
 * Adds a new user secret to the Merkle tree state, handling concurrency with a distributed lock.
 * After a successful DB update, it invalidates the Redis cache for this tree.
 * @param {string} election_id - The UUID of the election.
 * @param {string} user_secret - The secret to add.
 */
async function addUserSecret(election_id, user_secret) {
    // const poseidon = await getPoseidon();
    // const newLeaf = poseidon.F.toString(poseidon([BigInt(user_secret)]));

    const MERKLE_LOCK_KEY = `merkle_lock: ${election_id}`;
    const MERKLE_TREE_CACHE_KEY = `merkle_cache:leaves:${election_id}`;
    const startTime = Date.now();

    // --- Acquire Distributed Lock ---
    while(true) {
        // Attempt to acquire the lock atomically.
        // 'NX': Set only if the key does not exist.
        // 'EX': Set an expiration time in seconds.
        const lockAcquired = await redis.set(
            MERKLE_LOCK_KEY, 
            'locked', 
            'NX', // Set only if the key does not exist
            'EX', // Set an expiration time
            LOCK_TIMEOUT_SECONDS 
        );

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
        // --- [핵심 수정] 임계 영역 ---
        // register API가 Voters 테이블에 유권자를 이미 추가했으므로,
        // 이 함수는 오직 캐시를 무효화하는 책임만 가집니다.
        // 따라서 DB에서 데이터를 읽거나 쓰는 로직이 모두 제거됩니다.

        // --- 캐시 무효화 ---
        // 새로운 유권자가 추가되었으므로, 이전 버전의 캐시를 삭제하여
        // 다음번 조회 시 DB에서 최신 데이터를 가져오도록 합니다.
        await redis.del(MERKLE_TREE_CACHE_KEY);
        console.log(`New voter added to election ${election_id}. Cache invalidated.`);

    } finally {
        // --- 락 해제 (로직 동일) ---
        await redis.del(MERKLE_LOCK_KEY);
        console.log(`Lock released for election ${election_id}.`);
    }

    // try {
    //     // --- Critical Section: Guaranteed to be executed by only one process at a time ---
    //     const existingLeaves = await loadLeavesFromDB(election_id);

    //     if (existingLeaves.includes(newLeaf)) {
    //         console.log(`Leaf for election ${election_id} already exists. Skipping.`);
    //         return;
    //     }

    //     // 새로운 leaf 포함한 merkle_data 생성
    //     const updated = {
    //         election_id: election_id,
    //         merkle_data: { leaves: [...existingLeaves, newLeaf] },
    //         updated_at: new Date()
    //     };

    //     const { error } = await supabase
    //         .from("MerkleState")
    //         .upsert([updated]);

    //     if (error) {
    //         console.error("MERKLESTATE UPDATE FAIL: ", error.message);
    //     } else {
    //         console.log("MERKLESTATE UPDATE SUCCESS: ", newLeaf);
    //     }

    //     // --- Cache Invalidation ---
    //     // After successfully updating the source of truth (DB), invalidate the cache.
    //     await redis.del(MERKLE_TREE_CACHE_KEY);
    //     console.log(`Merkle Tree for election ${election_id} updated. Cache invalidated.`);
    // } finally {
    //     // --- Release Lock ---
    //     // Always release the lock, whether the operation succeeded or failed.
    //     await redis.del(MERKLE_LOCK_KEY);
    //     console.log(`Lock released for election ${election_id}.`);
    // }
}

/**
 * Generates a Merkle proof for a given user secret, using Redis for caching.
 * @param {string} election_id - The UUID of the election.
 * @param {string} user_secret - The user's secret to generate a proof for.
 * @returns {Promise<Object>} The Merkle proof components required by the ZKP circuit.
 */
async function generateMerkleProof(election_id, user_secret) {
    const poseidon = await getPoseidon();
    const tree = await generateMerkleTree(election_id);

    const currentUserLeaf = poseidon.F.toString(poseidon([BigInt(user_secret)]));
    const index = tree.leaves.indexOf(currentUserLeaf);

    if (index === -1) {
        throw new Error("Leaf not found in Merkle tree. The user might not be registered.");
    }

    const proof = tree.path(index);

    return {
        leaf: currentUserLeaf,
        root: tree.root.toString(),
        pathElements: proof.pathElements.map(el => el.toString()),
        pathIndices: proof.pathIndices
    };
}

module.exports = {
    generateMerkleTree,
    addUserSecret,
    generateMerkleProof
};
