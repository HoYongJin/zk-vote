/**
 * @file test/seedBeaconGate.test.ts
 * @desc No-gcloud behavioral test for the ZK-SETUP-1 trusted-setup seed gate.
 * `scripts/verify/check-ceremony-beacon.sh` is the structural trusted-setup
 * pre-filter that `seed-artifacts.sh` runs (paired with `snarkjs zkey verify`)
 * before uploading any zkey to the billable prod bucket. This proves it fails
 * closed on a non-beacon / malformed / missing manifest without needing gcloud
 * or a ptau file.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "..", "scripts", "verify", "check-ceremony-beacon.sh");

function runGate(content: string | null): number {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ceremony-"));
    const file = path.join(dir, "ceremony.json");
    if (content !== null) {
        fs.writeFileSync(file, content);
    }
    try {
        execFileSync("bash", [SCRIPT, file], { stdio: "pipe" });
        return 0;
    } catch (e: any) {
        return typeof e.status === "number" ? e.status : 1;
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

describe("seed-artifacts beacon pre-filter (check-ceremony-beacon.sh)", () => {
    it("passes a beacon-finalized manifest", () => {
        expect(
            runGate(
                '{"finalizedWithBeacon": true, "beaconHex": "32e1fa8f54f7b40bd12b87e1273b806cc538d2278292ab7c4ff98e823a49497d"}'
            )
        ).toBe(0);
    });

    it("rejects a non-beacon (dev) manifest", () => {
        expect(runGate('{"finalizedWithBeacon": false}')).toBe(1);
    });

    it("rejects a forged flag with a 'true' substring elsewhere", () => {
        // finalizedWithBeacon is still false; only beaconHex contains "true...".
        expect(runGate('{"finalizedWithBeacon": false, "beaconHex": "truested"}')).toBe(1);
    });

    it("rejects a forged boolean prefix without a JSON token boundary", () => {
        expect(runGate('{"finalizedWithBeacon": trueish, "beaconHex": "abc123"}')).toBe(1);
    });

    it("rejects a true flag without a 32-byte hex beacon", () => {
        expect(runGate('{"finalizedWithBeacon": true, "beaconHex": "abc123"}')).toBe(1);
    });

    it("rejects a missing manifest (fail closed)", () => {
        expect(runGate(null)).toBe(1);
    });
});
