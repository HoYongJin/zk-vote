const { electionIdToBigInt } = require("./electionId");

// Public signal layout, in snarkjs order (outputs then public inputs):
// [root_out, vote_index, nullifier_hash, election_id]. Verified empirically
// against the regenerated verification_key.json (nPublic = 4).
const PUBLIC_SIGNAL_ROOT_INDEX = 0;
const PUBLIC_SIGNAL_CANDIDATE_INDEX = 1;
const PUBLIC_SIGNAL_NULLIFIER_INDEX = 2;
const PUBLIC_SIGNAL_ELECTION_ID_INDEX = 3;
const PUBLIC_SIGNAL_COUNT = 4;

function isIntegerLike(value) {
    if (typeof value === "number") {
        return Number.isSafeInteger(value) && value >= 0;
    }
    if (typeof value !== "string") {
        return false;
    }
    return /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(value);
}

function toBigInt(value, fieldName) {
    if (!isIntegerLike(value)) {
        throw Object.assign(new Error(`${fieldName} must be a non-negative integer string.`), {
            code: "INVALID_PAYLOAD",
            status: 400,
        });
    }
    return BigInt(value);
}

function isFieldArray(value, expectedLength) {
    return Array.isArray(value) &&
        value.length === expectedLength &&
        value.every((item) => isIntegerLike(item));
}

function validateFormattedProof(formattedProof) {
    if (!formattedProof || typeof formattedProof !== "object") {
        return false;
    }

    return isFieldArray(formattedProof.a, 2) &&
        Array.isArray(formattedProof.b) &&
        formattedProof.b.length === 2 &&
        formattedProof.b.every((row) => isFieldArray(row, 2)) &&
        isFieldArray(formattedProof.c, 2);
}

function validateSubmitPayload({
    electionId,
    formattedProof,
    publicSignals,
    ticketPayload,
    election,
}) {
    if (!validateFormattedProof(formattedProof) || !Array.isArray(publicSignals) || publicSignals.length !== PUBLIC_SIGNAL_COUNT) {
        return {
            ok: false,
            status: 400,
            error: "INVALID_PAYLOAD",
            details: "Proof or public signals are missing or malformed.",
        };
    }

    try {
        const proofRoot = toBigInt(publicSignals[PUBLIC_SIGNAL_ROOT_INDEX], "publicSignals[root]");
        const candidateIndex = toBigInt(publicSignals[PUBLIC_SIGNAL_CANDIDATE_INDEX], "publicSignals[candidate]");
        const nullifierHash = toBigInt(publicSignals[PUBLIC_SIGNAL_NULLIFIER_INDEX], "publicSignals[nullifier]");
        const proofElectionId = toBigInt(publicSignals[PUBLIC_SIGNAL_ELECTION_ID_INDEX], "publicSignals[electionId]");
        const dbMerkleRoot = toBigInt(election.merkle_root, "election.merkle_root");
        const ticketMerkleRoot = toBigInt(ticketPayload.merkleRoot, "ticket.merkleRoot");
        const ticketNullifier = ticketPayload.nullifierHash === undefined || ticketPayload.nullifierHash === null
            ? null
            : toBigInt(ticketPayload.nullifierHash, "ticket.nullifierHash");
        const numCandidates = toBigInt(election.num_candidates, "election.num_candidates");

        if (ticketPayload.electionId !== electionId) {
            return {
                ok: false,
                status: 403,
                error: "TICKET_ELECTION_MISMATCH",
                details: "The submission ticket was issued for a different election.",
            };
        }

        // Bind the proof to THIS election. The on-chain contract enforces the same
        // check (audit C1); rejecting here gives a clear 400 instead of an opaque
        // on-chain revert and avoids relaying a doomed transaction.
        const expectedElectionId = electionIdToBigInt(electionId);
        if (proofElectionId !== expectedElectionId) {
            return {
                ok: false,
                status: 400,
                error: "ELECTION_ID_MISMATCH",
                details: "The proof election id does not match this election.",
            };
        }

        if (proofRoot !== dbMerkleRoot || proofRoot !== ticketMerkleRoot) {
            return {
                ok: false,
                status: 400,
                error: "MERKLE_ROOT_MISMATCH",
                details: "The proof root does not match the finalized election root.",
            };
        }

        if (ticketNullifier !== null && nullifierHash !== ticketNullifier) {
            return {
                ok: false,
                status: 400,
                error: "NULLIFIER_MISMATCH",
                details: "The proof nullifier does not match the submission ticket.",
            };
        }

        if (candidateIndex >= numCandidates) {
            return {
                ok: false,
                status: 400,
                error: "INVALID_CANDIDATE_INDEX",
                details: "The selected candidate index is outside this election's candidate range.",
            };
        }

        return { ok: true };
    } catch (err) {
        return {
            ok: false,
            status: err.status || 400,
            error: err.code || "INVALID_PAYLOAD",
            details: err.message || "Proof public signals are malformed.",
        };
    }
}

module.exports = {
    isIntegerLike,
    validateFormattedProof,
    validateSubmitPayload,
    PUBLIC_SIGNAL_ROOT_INDEX,
    PUBLIC_SIGNAL_CANDIDATE_INDEX,
    PUBLIC_SIGNAL_NULLIFIER_INDEX,
    PUBLIC_SIGNAL_ELECTION_ID_INDEX,
    PUBLIC_SIGNAL_COUNT,
};
