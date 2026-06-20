/**
 * @file scripts/zkArtifacts.js
 * @desc Binds deployed elections to the exact ZK artifacts (zkey/vkey/wasm)
 * they were deployed with (audit M5). Artifacts are keyed on disk only by
 * (depth, candidates); if any artifact is regenerated, the new zkey carries
 * fresh randomness and every proof for an already-deployed election that
 * shared the combination becomes permanently invalid. A deploy-time hash
 * manifest plus a /proof-time comparison turns that silent breakage into a
 * typed ARTIFACT_MISMATCH error.
 *
 * This is the Phase 1/local mitigation; Phase 10 replaces it with a Postgres/
 * GCS artifact manifest.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DEFAULT_ZKP_DIR = path.join(__dirname, "..", "zk");
const DEFAULT_MANIFEST_PATH = path.join(DEFAULT_ZKP_DIR, "artifact-manifest.json");

function artifactPathsFor(zkpDir, depth, numCandidates) {
    const buildDir = path.join(zkpDir, `build_${depth}_${numCandidates}`);
    return {
        zkeyPath: path.join(buildDir, "circuit_final.zkey"),
        verificationKeyPath: path.join(buildDir, "verification_key.json"),
        wasmPath: path.join(buildDir, "VoteCheck_temp_js", "VoteCheck_temp.wasm"),
    };
}

function sha256File(filePath) {
    const hash = crypto.createHash("sha256");
    hash.update(fs.readFileSync(filePath));
    return hash.digest("hex");
}

/**
 * Computes sha256 hashes for the three proving-critical artifacts of a
 * (depth, candidates) build. Throws if any artifact file is missing.
 */
function computeArtifactHashes(depth, numCandidates, { zkpDir = DEFAULT_ZKP_DIR } = {}) {
    const paths = artifactPathsFor(zkpDir, depth, numCandidates);
    const missing = Object.values(paths).filter((p) => !fs.existsSync(p));
    if (missing.length > 0) {
        throw Object.assign(
            new Error(`ZK artifacts are missing: ${missing.join(", ")}`),
            { code: "ARTIFACTS_MISSING" }
        );
    }

    return {
        zkeySha256: sha256File(paths.zkeyPath),
        verificationKeySha256: sha256File(paths.verificationKeyPath),
        wasmSha256: sha256File(paths.wasmPath),
    };
}

function readManifest(manifestPath = DEFAULT_MANIFEST_PATH) {
    if (!fs.existsSync(manifestPath)) {
        return {};
    }
    const raw = fs.readFileSync(manifestPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`Artifact manifest is malformed: ${manifestPath}`);
    }
    return parsed;
}

function writeManifest(manifest, manifestPath = DEFAULT_MANIFEST_PATH) {
    const tmpPath = `${manifestPath}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(manifest, null, 2)}\n`);
    fs.renameSync(tmpPath, manifestPath);
}

/**
 * Records the artifact hashes an election was deployed with. Called by
 * scripts/deployAll.js immediately after the contract address is persisted.
 */
function recordElectionArtifacts(
    electionId,
    { merkleTreeDepth, numCandidates, contractAddress = null, verifierAddress = null },
    { zkpDir = DEFAULT_ZKP_DIR, manifestPath = DEFAULT_MANIFEST_PATH, now = () => new Date().toISOString() } = {}
) {
    const hashes = computeArtifactHashes(merkleTreeDepth, numCandidates, { zkpDir });
    const manifest = readManifest(manifestPath);

    manifest[electionId] = {
        merkleTreeDepth,
        numCandidates,
        contractAddress,
        verifierAddress,
        ...hashes,
        recordedAt: now(),
    };

    writeManifest(manifest, manifestPath);
    return manifest[electionId];
}

/**
 * Verifies that the artifacts currently on disk still match the hashes the
 * election was deployed with.
 *
 * @returns {{ok: boolean, checked: boolean, mismatches?: string[], reason?: string}}
 *  - `checked: false` means no manifest entry exists for this election
 *    (pre-manifest deployment); callers should not block on it.
 */
function verifyElectionArtifacts(
    electionId,
    { zkpDir = DEFAULT_ZKP_DIR, manifestPath = DEFAULT_MANIFEST_PATH } = {}
) {
    const manifest = readManifest(manifestPath);
    const entry = manifest[electionId];
    if (!entry) {
        return { ok: true, checked: false };
    }

    let current;
    try {
        current = computeArtifactHashes(entry.merkleTreeDepth, entry.numCandidates, { zkpDir });
    } catch (err) {
        return { ok: false, checked: true, reason: err.message };
    }

    const mismatches = ["zkeySha256", "verificationKeySha256", "wasmSha256"]
        .filter((field) => entry[field] !== current[field]);

    if (mismatches.length > 0) {
        return {
            ok: false,
            checked: true,
            mismatches,
            reason: `Artifacts were regenerated after deployment: ${mismatches.join(", ")} changed.`,
        };
    }

    return { ok: true, checked: true };
}

module.exports = {
    DEFAULT_MANIFEST_PATH,
    DEFAULT_ZKP_DIR,
    computeArtifactHashes,
    readManifest,
    recordElectionArtifacts,
    verifyElectionArtifacts,
};
