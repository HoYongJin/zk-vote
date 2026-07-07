import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    computeArtifactHashes,
    recordElectionArtifacts,
    verifyElectionArtifacts,
} from "../scripts/zkArtifacts";

function makeFakeBuild(zkpDir: string, depth: number, candidates: number): string {
    const buildDir = path.join(zkpDir, `build_${depth}_${candidates}`);
    fs.mkdirSync(path.join(buildDir, "VoteCheck_temp_js"), { recursive: true });
    fs.writeFileSync(path.join(buildDir, "circuit_final.zkey"), "zkey-v1");
    fs.writeFileSync(path.join(buildDir, "verification_key.json"), '{"nPublic":4}');
    fs.writeFileSync(path.join(buildDir, "VoteCheck_temp_js", "VoteCheck_temp.wasm"), "wasm-v1");
    return buildDir;
}

describe("zkArtifacts manifest binding (audit M5)", function () {
    let zkpDir: string;
    let manifestPath: string;

    beforeEach(function () {
        zkpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zkvote-artifacts-"));
        manifestPath = path.join(zkpDir, "artifact-manifest.json");
        makeFakeBuild(zkpDir, 4, 10);
    });

    afterEach(function () {
        fs.rmSync(zkpDir, { recursive: true, force: true });
    });

    it("records deploy-time artifact hashes and verifies an unchanged build", function () {
        const record = recordElectionArtifacts(
            "election-1",
            { merkleTreeDepth: 4, numCandidates: 10, contractAddress: "0x1" },
            { zkpDir, manifestPath }
        );

        expect(record.zkeySha256).toMatch(/^[0-9a-f]{64}$/);
        expect(record.contractAddress).toBe("0x1");

        const check = verifyElectionArtifacts("election-1", { zkpDir, manifestPath });
        expect(check).toEqual({ ok: true, checked: true });
    });

    it("detects a regenerated zkey for an already-deployed election", function () {
        recordElectionArtifacts(
            "election-1",
            { merkleTreeDepth: 4, numCandidates: 10 },
            { zkpDir, manifestPath }
        );

        // Simulate setUpZk.sh regenerating the shared build with fresh randomness.
        fs.writeFileSync(path.join(zkpDir, "build_4_10", "circuit_final.zkey"), "zkey-v2-new-randomness");

        const check = verifyElectionArtifacts("election-1", { zkpDir, manifestPath });
        expect(check.ok).toBe(false);
        expect(check.checked).toBe(true);
        expect(check.mismatches).toEqual(["zkeySha256"]);
    });

    it("does not block elections deployed before the manifest existed", function () {
        const check = verifyElectionArtifacts("legacy-election", { zkpDir, manifestPath });
        expect(check).toEqual({ ok: true, checked: false });
    });

    it("fails closed when a recorded election's artifacts disappear", function () {
        recordElectionArtifacts(
            "election-1",
            { merkleTreeDepth: 4, numCandidates: 10 },
            { zkpDir, manifestPath }
        );

        fs.rmSync(path.join(zkpDir, "build_4_10", "circuit_final.zkey"));

        const check = verifyElectionArtifacts("election-1", { zkpDir, manifestPath });
        expect(check.ok).toBe(false);
        expect(check.checked).toBe(true);
        expect(check.reason).toContain("missing");
    });

    it("throws a typed error when computing hashes for a missing build", function () {
        expect(() => computeArtifactHashes(9, 9, { zkpDir })).toThrow(/missing/);
    });
});
