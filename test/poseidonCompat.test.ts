import { describe, it, expect, beforeAll } from "vitest";
import { buildPoseidon } from "circomlibjs";
// Deliberately imported from frontend/node_modules: this asserts the EXACT
// implementation the browser bundles produces backend-identical commitments.
// The H2 model breaks silently if the client commitment H(secret) ever
// diverges from the circomlibjs Poseidon leaves the server's Merkle tree uses.
// The frontend copy ships a non-module ambient .d.ts; @ts-ignore the untyped
// relative import (runtime target unchanged — see types/shims.d.ts).
// @ts-ignore — non-module .d.ts in the frontend's pinned poseidon-lite copy
import { poseidon1, poseidon2 } from "../frontend/node_modules/poseidon-lite";

describe("poseidon-lite / circomlibjs compatibility (H2 commitment, AR-H7 style vectors)", function () {
    let poseidon: any;

    beforeAll(async function () {
        poseidon = await buildPoseidon();
    });

    const SECRET_FIXTURES = [
        1n,
        123n,
        // 31-byte upper bound the frontend secret generator can produce.
        BigInt("0x" + "ff".repeat(31)),
        BigInt("21663839004416932945382355908790599225266501822907911457504978515578255421292"),
    ];

    it("produces identical 1-input hashes (leaf commitment H(secret))", function () {
        for (const secret of SECRET_FIXTURES) {
            const lite = poseidon1([secret]).toString();
            const reference = poseidon.F.toString(poseidon([secret]));
            expect(lite, `mismatch for secret ${secret}`).toBe(reference);
        }
    });

    it("produces identical 2-input hashes (nullifier = Poseidon(secret, electionId))", function () {
        const electionId = BigInt("0x" + "00000000000000000000000000000d7b".replace(/-/g, ""));
        for (const secret of SECRET_FIXTURES) {
            const lite = poseidon2([secret, electionId]).toString();
            const reference = poseidon.F.toString(poseidon([secret, electionId]));
            expect(lite, `mismatch for secret ${secret}`).toBe(reference);
        }
    });
});
