const { expect } = require("chai");
const {
    validateFormattedProof,
    validateSubmitPayload,
} = require("../server/utils/submitValidation");
const { FIELD_ELEMENT_MODULUS_DEC } = require("../server/utils/fieldElement");

const formattedProof = {
    a: ["1", "2"],
    b: [["3", "4"], ["5", "6"]],
    c: ["7", "8"],
};

// UUID whose hex value (0x...7b) is 123, matching electionIdToBigInt.
const ELECTION_UUID = "00000000-0000-0000-0000-00000000007b";

// Public signals: [root, candidateIndex, nullifierHash, electionId].
const validBase = {
    electionId: ELECTION_UUID,
    formattedProof,
    publicSignals: ["123", "1", "456", "123"],
    ticketPayload: {
        electionId: ELECTION_UUID,
        merkleRoot: "123",
    },
    election: {
        merkle_root: "123",
        num_candidates: 3,
    },
};

describe("submitValidation", function () {
    it("accepts correctly shaped formatted proofs", function () {
        expect(validateFormattedProof(formattedProof)).to.equal(true);
        expect(validateFormattedProof({ ...formattedProof, b: [["3"], ["4"]] })).to.equal(false);
    });

    it("rejects proof coordinates outside the BN254 scalar field", function () {
        expect(validateFormattedProof({ ...formattedProof, a: [FIELD_ELEMENT_MODULUS_DEC, "2"] })).to.equal(false);
    });

    it("accepts a valid submit payload", function () {
        const result = validateSubmitPayload(validBase);

        expect(result).to.deep.equal({ ok: true });
    });

    it("rejects public signals that are not exactly 4 long", function () {
        const result = validateSubmitPayload({
            ...validBase,
            publicSignals: ["123", "1", "456"],
        });

        expect(result.ok).to.equal(false);
        expect(result.status).to.equal(400);
        expect(result.error).to.equal("INVALID_PAYLOAD");
    });

    it("rejects public signals outside the BN254 scalar field", function () {
        const result = validateSubmitPayload({
            ...validBase,
            publicSignals: [FIELD_ELEMENT_MODULUS_DEC, "1", "456", "123"],
        });

        expect(result.ok).to.equal(false);
        expect(result.status).to.equal(400);
        expect(result.error).to.equal("INVALID_PAYLOAD");
    });

    it("rejects tickets issued for another election", function () {
        const result = validateSubmitPayload({
            ...validBase,
            ticketPayload: { ...validBase.ticketPayload, electionId: "11111111-1111-1111-1111-111111111111" },
        });

        expect(result.ok).to.equal(false);
        expect(result.status).to.equal(403);
        expect(result.error).to.equal("TICKET_ELECTION_MISMATCH");
    });

    it("rejects a proof generated for a different election id (audit C1)", function () {
        const result = validateSubmitPayload({
            ...validBase,
            publicSignals: ["123", "1", "456", "999"],
        });

        expect(result.ok).to.equal(false);
        expect(result.status).to.equal(400);
        expect(result.error).to.equal("ELECTION_ID_MISMATCH");
    });

    it("rejects Merkle root mismatches", function () {
        const result = validateSubmitPayload({
            ...validBase,
            publicSignals: ["999", "1", "456", "123"],
        });

        expect(result.ok).to.equal(false);
        expect(result.error).to.equal("MERKLE_ROOT_MISMATCH");
    });

    it("does not bind tickets to nullifiers", function () {
        const result = validateSubmitPayload({
            ...validBase,
            publicSignals: ["123", "1", "999", "123"],
        });

        expect(result).to.deep.equal({ ok: true });
    });

    it("rejects legacy ticket payloads that carry nullifier hashes", function () {
        const result = validateSubmitPayload({
            ...validBase,
            ticketPayload: { ...validBase.ticketPayload, nullifierHash: "456" },
        });

        expect(result.ok).to.equal(false);
        expect(result.status).to.equal(403);
        expect(result.error).to.equal("INVALID_TICKET_PAYLOAD");
    });

    it("rejects candidate indices outside the election range", function () {
        const result = validateSubmitPayload({
            ...validBase,
            publicSignals: ["123", "3", "456", "123"],
        });

        expect(result.ok).to.equal(false);
        expect(result.error).to.equal("INVALID_CANDIDATE_INDEX");
    });
});
