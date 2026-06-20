/**
 * @file test/helpers/zkProof.js
 * @desc Test helpers that build real ZK proof inputs for the VoteCheck circuit,
 * mirroring the production Merkle/leaf/nullifier derivation in the Rust
 * `zkvote-zkp` crate + the VoteCheck circuit (same Poseidon, same ZERO_ELEMENT,
 * same fixed-merkle-tree). Used by the real-circuit tests that exercise C1/H1
 * end to end (election binding + path-index booleanity).
 */

const path = require("path");
const snarkjs = require("snarkjs");
const { buildPoseidon } = require("circomlibjs");
const { MerkleTree } = require("fixed-merkle-tree");

// Must match the Rust `zkvote-zkp` crate + the circuit exactly so the off-chain tree and the
// circuit agree on the root.
const ZERO_ELEMENT =
    "21663839004416932945382355908790599225266501822907911457504978515578255421292";

const ZKP_DIR = path.join(__dirname, "..", "..", "zk");

function buildPaths(depth, candidates) {
    const buildDir = path.join(ZKP_DIR, `build_${depth}_${candidates}`);
    return {
        wasm: path.join(buildDir, "VoteCheck_temp_js", "VoteCheck_temp.wasm"),
        zkey: path.join(buildDir, "circuit_final.zkey"),
        vkey: path.join(buildDir, "verification_key.json"),
    };
}

let poseidonPromise = null;
async function getPoseidon() {
    if (!poseidonPromise) {
        poseidonPromise = buildPoseidon();
    }
    return poseidonPromise;
}

async function poseidonHash(values) {
    const poseidon = await getPoseidon();
    return poseidon.F.toString(poseidon(values.map((v) => BigInt(v))));
}

/**
 * Builds the field-element leaf for a secret: H(secret).
 */
async function leafFor(secret) {
    return poseidonHash([secret]);
}

/**
 * Builds the nullifier for (secret, electionId): H(secret, electionId).
 */
async function nullifierFor(secret, electionId) {
    return poseidonHash([secret, electionId]);
}

/**
 * Builds a Merkle tree from a list of secrets and returns helpers for proof
 * generation.
 */
async function buildTree(depth, secrets) {
    const poseidon = await getPoseidon();
    const leaves = [];
    for (const s of secrets) {
        leaves.push(await leafFor(s));
    }
    const tree = new MerkleTree(depth, leaves, {
        hashFunction: (a, b) => poseidon.F.toString(poseidon([a, b])),
        zeroElement: ZERO_ELEMENT,
    });
    return { tree, leaves };
}

/**
 * Assembles the circuit input object for a given voter.
 * @param {object} opts
 * @param {number} opts.depth
 * @param {number} opts.candidates
 * @param {string|bigint} opts.secret
 * @param {string|bigint} opts.electionId  Field element (e.g. electionIdToBigInt result)
 * @param {number} opts.voteIndex          Candidate index to vote for
 * @param {string[]} [opts.secrets]        Full secret set (defaults to [secret])
 * @param {object} [opts.overrides]        Shallow overrides applied to the input (for negative tests)
 */
async function buildCircuitInput({
    depth,
    candidates,
    secret,
    electionId,
    voteIndex,
    secrets,
    overrides = {},
}) {
    const allSecrets = secrets || [secret];
    const { tree, leaves } = await buildTree(depth, allSecrets);

    const leaf = await leafFor(secret);
    const index = leaves.indexOf(leaf);
    if (index === -1) {
        throw new Error("secret leaf not found in provided secret set");
    }
    const proof = tree.path(index);

    const vote = Array(candidates).fill(0);
    vote[voteIndex] = 1;

    const input = {
        root_in: tree.root.toString(),
        user_secret: BigInt(secret).toString(),
        vote,
        pathElements: proof.pathElements.map((e) => e.toString()),
        pathIndices: proof.pathIndices.slice(),
        election_id: BigInt(electionId).toString(),
        ...overrides,
    };

    return { input, tree, leaves, proofPath: proof };
}

/**
 * Generates a full Groth16 proof for the given input and returns the snarkjs
 * proof + publicSignals (verbatim snarkjs order).
 */
async function fullProve(input, depth, candidates) {
    const { wasm, zkey } = buildPaths(depth, candidates);
    return snarkjs.groth16.fullProve(input, wasm, zkey);
}

async function verifyProof(publicSignals, proof, depth, candidates) {
    const { vkey } = buildPaths(depth, candidates);
    const vk = require(vkey);
    return snarkjs.groth16.verify(vk, publicSignals, proof);
}

/**
 * Formats a snarkjs proof for the Solidity verifier (a, b, c), matching
 * frontend VotePage.js (note the b-coordinate reversal).
 */
function formatProofForSolidity(proof) {
    return {
        a: proof.pi_a.slice(0, 2),
        b: proof.pi_b.slice(0, 2).map((row) => row.slice().reverse()),
        c: proof.pi_c.slice(0, 2),
    };
}

module.exports = {
    ZERO_ELEMENT,
    buildPaths,
    getPoseidon,
    poseidonHash,
    leafFor,
    nullifierFor,
    buildTree,
    buildCircuitInput,
    fullProve,
    verifyProof,
    formatProofForSolidity,
};
