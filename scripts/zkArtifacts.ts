/**
 * @file scripts/zkArtifacts.ts
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

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_ZKP_DIR = path.join(__dirname, "..", "zk");
const DEFAULT_MANIFEST_PATH = path.join(DEFAULT_ZKP_DIR, "artifact-manifest.json");

interface ArtifactPaths {
    zkeyPath: string;
    verificationKeyPath: string;
    wasmPath: string;
}

interface ArtifactHashes {
    zkeySha256: string;
    verificationKeySha256: string;
    wasmSha256: string;
}

interface ManifestEntry {
    merkleTreeDepth: number;
    numCandidates: number;
    contractAddress: string | null;
    verifierAddress: string | null;
    zkeySha256: string;
    verificationKeySha256: string;
    wasmSha256: string;
    recordedAt: string;
}

type Manifest = Record<string, ManifestEntry>;

interface VerifyResult {
    ok: boolean;
    checked: boolean;
    mismatches?: string[];
    reason?: string;
}

function artifactPathsFor(zkpDir: string, depth: number, numCandidates: number): ArtifactPaths {
    const buildDir = path.join(zkpDir, `build_${depth}_${numCandidates}`);
    return {
        zkeyPath: path.join(buildDir, "circuit_final.zkey"),
        verificationKeyPath: path.join(buildDir, "verification_key.json"),
        wasmPath: path.join(buildDir, "VoteCheck_temp_js", "VoteCheck_temp.wasm"),
    };
}

function sha256File(filePath: string): string {
    const hash = crypto.createHash("sha256");
    hash.update(fs.readFileSync(filePath));
    return hash.digest("hex");
}

/**
 * Computes sha256 hashes for the three proving-critical artifacts of a
 * (depth, candidates) build. Throws if any artifact file is missing.
 */
function computeArtifactHashes(
    depth: number,
    numCandidates: number,
    { zkpDir = DEFAULT_ZKP_DIR }: { zkpDir?: string } = {}
): ArtifactHashes {
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

function readManifest(manifestPath: string = DEFAULT_MANIFEST_PATH): Manifest {
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

function writeManifest(manifest: Manifest, manifestPath: string = DEFAULT_MANIFEST_PATH): void {
    const tmpPath = `${manifestPath}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(manifest, null, 2)}\n`);
    fs.renameSync(tmpPath, manifestPath);
}

/**
 * Records the artifact hashes an election was deployed with. Called by
 * scripts/deployAll.js immediately after the contract address is persisted.
 */
function recordElectionArtifacts(
    electionId: string,
    {
        merkleTreeDepth,
        numCandidates,
        contractAddress = null,
        verifierAddress = null,
    }: {
        merkleTreeDepth: number;
        numCandidates: number;
        contractAddress?: string | null;
        verifierAddress?: string | null;
    },
    {
        zkpDir = DEFAULT_ZKP_DIR,
        manifestPath = DEFAULT_MANIFEST_PATH,
        now = () => new Date().toISOString(),
    }: { zkpDir?: string; manifestPath?: string; now?: () => string } = {}
): ManifestEntry {
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
    electionId: string,
    {
        zkpDir = DEFAULT_ZKP_DIR,
        manifestPath = DEFAULT_MANIFEST_PATH,
    }: { zkpDir?: string; manifestPath?: string } = {}
): VerifyResult {
    const manifest = readManifest(manifestPath);
    const entry = manifest[electionId];
    if (!entry) {
        return { ok: true, checked: false };
    }

    let current: ArtifactHashes;
    try {
        current = computeArtifactHashes(entry.merkleTreeDepth, entry.numCandidates, { zkpDir });
    } catch (err) {
        return { ok: false, checked: true, reason: (err as Error).message };
    }

    const mismatches = (["zkeySha256", "verificationKeySha256", "wasmSha256"] as const)
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

export {
    DEFAULT_MANIFEST_PATH,
    DEFAULT_ZKP_DIR,
    computeArtifactHashes,
    readManifest,
    recordElectionArtifacts,
    verifyElectionArtifacts,
};
