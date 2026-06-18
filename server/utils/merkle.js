/**
 * @file server/utils/merkle.js
 * @desc Manages Merkle tree generation, caching (Redis), and concurrent-safe updates
 * for ZK-SNARK proofs. Uses Poseidon hash function.
 */

const { buildPoseidon } = require("circomlibjs");
const { MerkleTree } = require("fixed-merkle-tree");
const supabase = require("../supabaseClient");
const redis = require('../redisClient');
const { isRedisLockHeld, withRedisLock } = require("./redisLock");
const { isOnchainConfigured } = require("./finalizationState");
const { electionIdToBigInt } = require("./electionId");
const { parseFieldElement } = require("./fieldElement");
const { isElectionSuperseded } = require("./supersede");
require("dotenv").config();

/**
 * The zero element (hash of 0, 0) for the Poseidon Merkle tree.
 * This is a fixed value used for empty leaves.
 * derived from keccak256("tornado") to ensure compatibility with circomlib.(tornado-core/contracts/MerkleTreeWithHistory.sol)
 */
const ZERO_ELEMENT = "21663839004416932945382355908790599225266501822907911457504978515578255421292";

/**
 * A Promise that resolves to the initialized Poseidon hash function instance.
 * This ensures buildPoseidon() is only called once.
 * @type {Promise<Object> | null}
 */
let poseidonPromise = null;

const merkleLockKey = (election_id) => `merkle_lock:${election_id}`;
const merkleCacheKey = (election_id) => `merkle_cache:leaves:${election_id}`;

function withElectionMerkleLock(election_id, fn, options = {}) {
    return withRedisLock(merkleLockKey(election_id), fn, options);
}

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
 * Fetches all non-null voter leaf commitments for a given election from the DB.
 *
 * Historical note: the Supabase column is still named `user_secret` for schema
 * compatibility, but Phase 1/H2 treats it as a leaf commitment H(secret). The
 * backend must not store or derive the plaintext voter secret.
 *
 * @param {string} election_id - The UUID of the election.
 * @returns {Promise<string[]>} An array of Poseidon leaf commitments.
 */
async function loadLeafCommitmentsFromDB(election_id) {
    const { data: voters, error } = await supabase
        .from("Voters")
        .select("user_secret")
        .eq("election_id", election_id)
        .not("user_secret", "is", null)     // Stored as H(secret), not plaintext.
        .order('id', { ascending: true });  // CRITICAL: Ensures deterministic leaf order

    if (error) {
        console.error(`[merkle.js] Failed to load voter commitments from DB for election ${election_id}:`, error.message);
        throw error;
    }
    return voters.map(v => v.user_secret);
}

/**
 * Normalizes already-computed leaf commitments.
 * @param {string[]} commitments - An array of H(secret) field elements.
 * @returns {string[]} An array of leaf values as strings.
 */
function normalizeLeafCommitments(commitments) {
    return commitments.map(commitment => parseFieldElement(commitment, "leaf commitment").toString());
}

async function calculateLeafCommitment(user_secret) {
    const poseidon = await getPoseidon();
    return poseidon.F.toString(poseidon([parseFieldElement(user_secret, "user_secret")]));
}

async function calculateNullifierHash(user_secret, election_id) {
    const poseidon = await getPoseidon();
    return poseidon.F.toString(poseidon([
        parseFieldElement(user_secret, "user_secret"),
        electionIdToBigInt(election_id)
    ]));
}

async function loadElectionDepth(election_id) {
    const { data: election, error } = await supabase
        .from("Elections")
        .select("merkle_tree_depth")
        .eq("id", election_id)
        .single();

    if (error || !election) {
        throw new Error(`[merkle.js] Could not fetch election details for ${election_id}. ${error?.message}`);
    }

    return election.merkle_tree_depth;
}

function buildTree(depth, leaves, poseidon) {
    return new MerkleTree(depth, leaves, {
        hashFunction: (a, b) => poseidon.F.toString(poseidon([a, b])),
        zeroElement: ZERO_ELEMENT
    });
}

async function writeLeavesCache(election_id, leaves) {
    const MERKLE_TREE_CACHE_KEY = merkleCacheKey(election_id);

    try {
        if (leaves.length > 0) {
            await redis.set(MERKLE_TREE_CACHE_KEY, JSON.stringify(leaves), 'EX', 3600);
        } else {
            await redis.del(MERKLE_TREE_CACHE_KEY);
        }
    } catch (err) {
        console.warn(`[merkle.js] Redis cache write failed for ${election_id}. Error: ${err.message}`);
    }
}

async function buildMerkleTreeFromSource(election_id, { forceRefresh = false } = {}) {
    const poseidon = await getPoseidon();
    const MERKLE_TREE_CACHE_KEY = merkleCacheKey(election_id);

    let leaves;

    if (!forceRefresh) {
        try {
            const cachedLeaves = await redis.get(MERKLE_TREE_CACHE_KEY);
            if (cachedLeaves) {
                console.log(`[merkle.js] Cache hit for election ${election_id} leaves.`);
                leaves = JSON.parse(cachedLeaves);
            } else {
                console.log(`[merkle.js] Cache miss for election ${election_id}.`);
            }
        } catch (err) {
            console.warn(`[merkle.js] Redis GET failed for ${election_id}. Falling back to DB. Error: ${err.message}`);
        }
    }

    if (!leaves) {
        console.log(`[merkle.js] Loading voter commitments from DB for election ${election_id}.`);
        const commitments = await loadLeafCommitmentsFromDB(election_id);
        leaves = normalizeLeafCommitments(commitments);
        await writeLeavesCache(election_id, leaves);
    }

    const depth = await loadElectionDepth(election_id);
    return {
        tree: buildTree(depth, leaves, poseidon),
        leaves: leaves
    };
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
async function generateMerkleTree(election_id, options = {}) {
    return withElectionMerkleLock(election_id, () => buildMerkleTreeFromSource(election_id, options));
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
 * @param {string} user_secret_commitment - The client-generated H(secret) leaf commitment.
 */
async function addUserSecret(election_id, user_name, user_id, email, user_secret_commitment) {
    return withElectionMerkleLock(election_id, async (lock) => {
        const { data: election, error: electionError } = await supabase
            .from("Elections")
            .select("registration_end_time, merkle_root")
            .eq("id", election_id)
            .single();

        if (electionError || !election) {
            throw Object.assign(
                new Error(`[merkle.js] Could not fetch election during registration: ${electionError?.message || "not found"}`),
                { status: electionError?.code === "PGRST116" ? 404 : 500, code: "ELECTION_NOT_FOUND" }
            );
        }

        if (election.merkle_root) {
            throw Object.assign(new Error("This election has already been finalized."), {
                status: 409,
                code: "ALREADY_FINALIZED"
            });
        }

        if (await isElectionSuperseded(supabase, election_id)) {
            throw Object.assign(new Error("This election was superseded and registration is closed."), {
                status: 409,
                code: "ELECTION_SUPERSEDED"
            });
        }

        if (await isOnchainConfigured(election_id)) {
            throw Object.assign(new Error("This election has already been finalized on-chain."), {
                status: 409,
                code: "ALREADY_FINALIZED"
            });
        }

        if (new Date() > new Date(election.registration_end_time)) {
            throw Object.assign(new Error("The registration period for this election has ended."), {
                status: 403,
                code: "REGISTRATION_PERIOD_ENDED"
            });
        }

        if (!(await isRedisLockHeld(lock))) {
            throw Object.assign(new Error("Registration lock expired before the update started."), {
                status: 409,
                code: "REGISTRATION_LOCK_EXPIRED"
            });
        }

        const { data: updatedVoter, error: dbError } = await supabase
            .from("Voters")
            .update({ 
                name: user_name,
                user_id: user_id,
                // Column kept for compatibility; value is H(secret), not the plaintext secret.
                user_secret: parseFieldElement(user_secret_commitment, "user_secret_commitment").toString()
            })
            .eq('email', email)
            .eq('election_id', election_id)
            .is('user_id', null)
            .select('id')
            .maybeSingle();
        
        if (dbError) {
            throw new Error(`[merkle.js] DB update failed inside lock: ${dbError.message}`);
        }

        if (!(await isRedisLockHeld(lock))) {
            throw Object.assign(new Error("Registration lock expired before the update completed."), {
                status: 409,
                code: "REGISTRATION_LOCK_EXPIRED"
            });
        }

        if (!updatedVoter) {
            const { data: currentVoter, error: currentError } = await supabase
                .from("Voters")
                .select("id, user_id")
                .eq("email", email)
                .eq("election_id", election_id)
                .maybeSingle();

            if (currentError) {
                throw currentError;
            }

            if (!currentVoter) {
                throw Object.assign(new Error("This email is not on the pre-approved list for this election."), {
                    status: 403,
                    code: "NOT_ON_VOTER_LIST"
                });
            }

            if (currentVoter.user_id && currentVoter.user_id !== user_id) {
                throw Object.assign(new Error("This voter has already completed registration."), {
                    status: 409,
                    code: "ALREADY_REGISTERED"
                });
            }

            if (currentVoter.user_id === user_id) {
                const { data: reboundVoter, error: reboundError } = await supabase
                    .from("Voters")
                    .update({
                        name: user_name,
                        // Same-user re-binding is allowed until registration closes (AR-H6).
                        user_secret: parseFieldElement(user_secret_commitment, "user_secret_commitment").toString()
                    })
                    .eq("id", currentVoter.id)
                    .eq("user_id", user_id)
                    .select("id")
                    .maybeSingle();

                if (reboundError) {
                    throw new Error(`[merkle.js] DB re-bind failed inside lock: ${reboundError.message}`);
                }

                if (!(await isRedisLockHeld(lock))) {
                    throw Object.assign(new Error("Registration lock expired before the re-bind completed."), {
                        status: 409,
                        code: "REGISTRATION_LOCK_EXPIRED"
                    });
                }

                if (reboundVoter) {
                    await redis.del(merkleCacheKey(election_id));
                    console.log(`[merkle.js] Voter commitment re-bound and cache invalidated for election ${election_id}.`);
                    return reboundVoter;
                }
            }

            throw new Error("[merkle.js] Voter update did not modify a row.");
        }

        await redis.del(merkleCacheKey(election_id));
        
        console.log(`[merkle.js] Voter added to DB and cache invalidated for election ${election_id}.`);
        return updatedVoter;
    }, { lockTimeoutSeconds: 60, pollingTimeoutMs: 30000 });
}

async function buildFinalMerkleSnapshot(election_id, requestedCloseTimeIso) {
    const poseidon = await getPoseidon();
    const { data: election, error: electionError } = await supabase
        .from("Elections")
        .select("registration_end_time, merkle_root, merkle_tree_depth")
        .eq("id", election_id)
        .single();

    if (electionError || !election) {
        throw Object.assign(
            new Error(`[merkle.js] Could not fetch election during finalization: ${electionError?.message || "not found"}`),
            { status: electionError?.code === "PGRST116" ? 404 : 500, code: "ELECTION_NOT_FOUND" }
        );
    }

    if (election.merkle_root) {
        throw Object.assign(new Error("This election's registration period has already been finalized."), {
            status: 409,
            code: "ALREADY_FINALIZED"
        });
    }

    const commitments = await loadLeafCommitmentsFromDB(election_id);
    const leaves = normalizeLeafCommitments(commitments);

    if (leaves.length === 0) {
        await redis.del(merkleCacheKey(election_id));
        return {
            tree: buildTree(election.merkle_tree_depth, leaves, poseidon),
            leaves,
            registrationClosedAt: election.registration_end_time,
        };
    }

    const requestedCloseTime = new Date(requestedCloseTimeIso);
    const currentRegistrationEnd = new Date(election.registration_end_time);
    const registrationClosedAt = new Date(
        Math.min(requestedCloseTime.getTime(), currentRegistrationEnd.getTime())
    ).toISOString();

    await writeLeavesCache(election_id, leaves);

    return {
        tree: buildTree(election.merkle_tree_depth, leaves, poseidon),
        leaves,
        registrationClosedAt,
    };
}

async function closeRegistrationAndGenerateMerkleTree(election_id, requestedCloseTimeIso, options = {}) {
    return withElectionMerkleLock(
        election_id,
        () => buildFinalMerkleSnapshot(election_id, requestedCloseTimeIso),
        options
    );
}

/**
 * Generates a Merkle proof for a given voter leaf commitment.
 * @param {string} election_id - The UUID of the election.
 * @param {string} leafCommitment - The client's H(secret) commitment.
 * @returns {Promise<Object>} The Merkle proof components required by the ZK circuit.
 */
async function generateMerkleProof(election_id, leafCommitment) {
    // 1. Get the latest (possibly cached) tree and leaves.
    const { tree, leaves } = await generateMerkleTree(election_id);

    // 2. Find the committed leaf. The backend never receives the plaintext secret.
    const currentUserLeaf = BigInt(leafCommitment).toString();
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
    calculateLeafCommitment,
    calculateNullifierHash,
    buildFinalMerkleSnapshot,
    closeRegistrationAndGenerateMerkleTree,
    generateMerkleTree,
    addUserSecret,
    generateMerkleProof,
    withElectionMerkleLock
};
