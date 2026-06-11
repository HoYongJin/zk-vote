/**
 * @file server/routes/artifactInfo.js
 * @desc Exposes the deploy-time artifact hashes (audit M5 manifest) plus the
 * proving-artifact download paths for one election, so the browser can verify
 * the wasm/zkey it fetched BEFORE proving with the client-held secret
 * (architecture review AR-M6: client-side trust ceiling of the H2 model).
 * Authenticated: only eligible voters need it, and it leaks deployment
 * metadata otherwise.
 */

const express = require("express");
const router = express.Router({ mergeParams: true });
const auth = require("../middleware/auth");
const { readManifest } = require("../utils/zkArtifacts");

/**
 * @route   GET /api/elections/:election_id/artifact-info
 * @returns {object} { wasmPath, zkeyPath, wasmSha256, zkeySha256,
 *                     verificationKeySha256, publicSignalCount }
 *          404 ARTIFACTS_NOT_RECORDED when the election predates the
 *          manifest (client falls back to unverified fetch + warning).
 */
router.get("/", auth, async (req, res) => {
    const { election_id } = req.params;

    let entry;
    try {
        entry = readManifest()[election_id];
    } catch (err) {
        console.error(`[artifactInfo] Failed to read the artifact manifest:`, err.message);
        return res.status(500).json({
            error: "SERVER_ERROR",
            details: "Failed to read the artifact manifest."
        });
    }

    if (!entry) {
        return res.status(404).json({
            error: "ARTIFACTS_NOT_RECORDED",
            details: "No deploy-time artifact hashes are recorded for this election."
        });
    }

    const buildDir = `build_${entry.merkleTreeDepth}_${entry.numCandidates}`;
    return res.status(200).json({
        success: true,
        wasmPath: `/api/zkp-files/${buildDir}/VoteCheck_temp_js/VoteCheck_temp.wasm`,
        zkeyPath: `/api/zkp-files/${buildDir}/circuit_final.zkey`,
        wasmSha256: entry.wasmSha256,
        zkeySha256: entry.zkeySha256,
        verificationKeySha256: entry.verificationKeySha256,
        publicSignalCount: 4,
    });
});

module.exports = router;
