/**
 * @file server/utils/merkle.js
 * @desc Manages Merkle tree generation, caching (Redis), and concurrent-safe updates
 * for ZK-SNARK proofs. Uses Poseidon hash function.
 */

const { buildPoseidon } = require("circomlibjs");
const { MerkleTree } = require("fixed-merkle-tree");
const supabase = require("../supabaseClient");
const redis = require('../redisClient');
require("dotenv").config();

/**
 * The zero element (hash of 0, 0) for the Poseidon Merkle tree.
 * This is a fixed value used for empty leaves.
 */
const ZERO_ELEMENT = "21663839004416932945382355908790599225266501822907911457504978515578255421292";

/**
 * A Promise that resolves to the initialized Poseidon hash function instance.
 * This ensures buildPoseidon() is only called once.
 * @type {Promise<Object> | null}
 */
let poseidonPromise = null;

/**
 * initializes and returns a singleton instance of the Poseidon hash function.
 * @returns {Promise<Object>} The initialized Poseidon hash function object.
 */
async function getPoseidon() {
    // If the promise doesn't exist, create it.
    if (!poseidonPromise) {
        poseidonPromise = buildPoseidon();
    }
    // Return the promise, which resolves to the poseidon object.
    return poseidonPromise;
}

/**
 * Fetches all non-null user secrets for a given election from the database.
 * The results are ordered by 'id' to ensure deterministic leaf ordering.
 * @param {string} election_id - The UUID of the election.
 * @returns {Promise<string[]>} An array of user_secret strings.
 */
async function loadSecretsFromDB(election_id) {
    const { data: voters, error } = await supabase
        .from("Voters")
        .select("user_secret")
        .eq("election_id", election_id)
        .not("user_secret", "is", null)     // Only select voters who have completed registration
        .order('id', { ascending: true });  // CRITICAL: Ensures deterministic leaf order

    if (error) {
        console.error(`[merkle.js] Failed to load user secrets from DB for election ${election_id}:`, error.message);
        throw error;
    }
    return voters.map(v => v.user_secret);
}

/**
 * Calculates the Poseidon hash for each secret to create the Merkle tree leaves.
 * @param {string[]} secrets - An array of user_secret strings.
 * @returns {Promise<string[]>} An array of hashed leaf values as strings.
 */
async function calculateLeaves(secrets) {
    const poseidon = await getPoseidon();
    // Hash the secret. The secret itself is never stored in the tree or cache.
    // The leaf is H(secret).
    return secrets.map(secret => poseidon.F.toString(poseidon([BigInt(secret)])));
}

/**
 * Generates or retrieves a Merkle tree for a given election.
 * It uses a "cache-aside" pattern with Redis:
 * 1. Try to get leaves from Redis.
 * 2. If (Cache Hit), return the tree built from cached leaves.
 * 3. If (Cache Miss or Redis Error), load secrets from DB, build leaves,
 * try to cache them, and then return the tree.
 *
 * @param {string} election_id - The UUID of the election.
 * @returns {Promise<{tree: MerkleTree, leaves: string[]}>} The constructed MerkleTree and its leaves.
 */
async function generateMerkleTree(election_id) {
    const poseidon = await getPoseidon();
    const MERKLE_TREE_CACHE_KEY = `merkle_cache:leaves:${election_id}`;

    let leaves;

    // 1. --- Try to get leaves from Cache (Redis) ---
    try {
        const cachedLeaves = await redis.get(MERKLE_TREE_CACHE_KEY);
        if (cachedLeaves) {
            console.log(`[merkle.js] Cache hit for election ${election_id} leaves.`);
            leaves = JSON.parse(cachedLeaves);
        } else {
            console.log(`[merkle.js] Cache miss for election ${election_id}.`);
        }
    } catch (err) {
        // If Redis GET fails, log a warning and fall back to DB.
        console.warn(`[merkle.js] Redis GET failed for ${election_id}. Falling back to DB. Error: ${err.message}`);
        // 'leaves' remains undefined, so the next block will execute.
    }

    // 2. --- If Cache Miss or Redis Error, load from DB ---
    if (!leaves) {
        console.log(`[merkle.js] Loading secrets from DB for election ${election_id}.`);
        const secrets = await loadSecretsFromDB(election_id);
        leaves = await calculateLeaves(secrets);

        // 3. --- Try to set the cache (best-effort) ---
        if (leaves.length > 0) {
            try {
                // [SECURITY] Store only the *hashed leaves*, not the secrets.
                // Set cache to expire in 1 hour (3600 seconds).
                await redis.set(MERKLE_TREE_CACHE_KEY, JSON.stringify(leaves), 'EX', 3600);
            } catch (err) {
                // If Redis SET fails, just log a warning. The function can still proceed.
                console.warn(`[merkle.js] Redis SET failed for ${election_id}. Cache will not be saved. Error: ${err.message}`);
            }
        }
    }

    // 4. --- Fetch election metadata and build the tree ---
    const { data: election, error } = await supabase
        .from("Elections")
        .select("merkle_tree_depth")
        .eq("id", election_id)
        .single();

    if (error || !election) {
        throw new Error(`[merkle.js] Could not fetch election details for ${election_id}. ${error?.message}`);
    }

    // 5. --- Return the tree and leaves ---
    return {
        tree: new MerkleTree(election.merkle_tree_depth, leaves, {
            hashFunction: (a, b) => poseidon.F.toString(poseidon([a, b])),
            zeroElement: ZERO_ELEMENT
        }),
        leaves: leaves 
    };
}

/**
 * Concurrently-safe function to add a new voter.
 * This function performs the *entire* critical section:
 * 1. Acquires a distributed lock for the election.
 * 2. Updates the 'Voters' table in the DB.
 * 3. Invalidates the (now stale) Merkle tree cache.
 * 4. Releases the lock.
 *
 * NOTE: This function's signature is based on the needs of `register.js`.
 *
 * @param {string} election_id - The UUID of the election.
 * @param {string} user_id - The user's UUID (from auth).
 * @param {string} email - The user's email.
 * @param {string} user_secret - The newly generated user secret.
 */
async function addUserSecret(election_id, user_name, user_id, email, user_secret) {
    // --- Lock Configuration ---
    const MERKLE_LOCK_KEY = `merkle_lock:${election_id}`;
    const MERKLE_TREE_CACHE_KEY = `merkle_cache:leaves:${election_id}`;
    const LOCK_TIMEOUT_SECONDS = 10;    // A lock will auto-expire after 10 seconds.
    const POLLING_INTERVAL_MS = 100;    // Wait 100ms between lock acquisition attempts.
    const POLLING_TIMEOUT_MS = 5000;    // Give up acquiring the lock after 5 seconds.
    const startTime = Date.now();

    // --- 1. Acquire Distributed Lock (with polling) ---
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
            console.log(`[merkle.js] Lock acquired for election: ${election_id}.`);
            break; // Exit loop and proceed with the critical section.
        }

        // Check for timeout if lock is not acquired.
        if (Date.now() - startTime > POLLING_TIMEOUT_MS) {
            throw new Error(`[merkle.js] Failed to acquire Merkle tree lock for ${election_id} (timeout).`);
        }

        // Wait before retrying.
        await new Promise(resolve => setTimeout(resolve, POLLING_INTERVAL_MS));
    }

    try {
        // --- 2. CRITICAL SECTION START ---
        // This block is now atomic. No other request can build a tree
        // while we are in the middle of this update.

        // [A] Update the database with the new voter's secret and ID.
        const { error: dbError } = await supabase
            .from("Voters")
            .update({ 
                name: user_name,
                user_id: user_id,
                user_secret: user_secret 
            })
            .eq('email', email)
            .eq('election_id', election_id);
        
        if (dbError) {
            throw new Error(`[merkle.js] DB update failed inside lock: ${dbError.message}`);
        }

        // [B] Invalidate the stale cache.
        // The next call to generateMerkleTree() will be forced
        // to reload from the (now updated) database.
        await redis.del(MERKLE_TREE_CACHE_KEY);
        
        console.log(`[merkle.js] Voter added to DB and cache invalidated for election ${election_id}.`);
        // --- 3. CRITICAL SECTION END ---
    } catch (err) {
        // Ensure any error during the critical section is logged and thrown.
        console.error(`[merkle.js] Error during locked operation for ${election_id}: ${err.message}`);
        throw err; // Re-throw to inform the calling route (register.js) of the failure.
    } finally {
        // --- 4. Release the Lock ---
        // This 'finally' block ensures the lock is *always* released,
        // even if the critical section failed.
        await redis.del(MERKLE_LOCK_KEY);
        console.log(`[merkle.js] Lock released for election ${election_id}.`);
    }
}

/**
 * Generates a Merkle proof for a given user secret.
 * It fetches the (potentially cached) tree and finds the path for the user's leaf.
 * @param {string} election_id - The UUID of the election.
 * @param {string} user_secret - The user's secret to generate a proof for.
 * @returns {Promise<Object>} The Merkle proof components required by the ZK circuit.
 * (root, pathElements, pathIndices)
 */
async function generateMerkleProof(election_id, user_secret) {
    const poseidon = await getPoseidon();

    // 1. Get the latest (possibly cached) tree and leaves.
    const { tree, leaves } = await generateMerkleTree(election_id);

    // 2. Hash the user's secret to find the corresponding leaf in the tree.
    const currentUserLeaf = poseidon.F.toString(poseidon([BigInt(user_secret)]));
    const index = leaves.indexOf(currentUserLeaf);

    // 3. Check if the user is part of the tree.
    if (index === -1) {
        // This can happen if the user's registration is still pending or failed.
        throw new Error("[merkle.js] Leaf not found in Merkle tree. The user might not be registered or the tree is out of sync.");
    }

    // 4. Generate the proof (path) for the user's leaf index.
    const proof = tree.path(index);

    // 5. Return the proof components in the format required by the circuit.
    return {
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
