/**
 * @file server/utils/electionId.js
 * @desc Single source of truth for converting an election UUID into the field
 * element used as the circuit's `election_id` public signal and the contract's
 * immutable `electionId`. Kept dependency-free so it can be imported by both the
 * Merkle utilities (heavy deps) and the submit-validation unit (no deps).
 */

/**
 * Converts an election UUID (e.g. "11111111-2222-3333-4444-555555555555") into a
 * BigInt by interpreting its hex digits, matching scripts/deployAll.js and the
 * frontend circuit input ("0x" + uuid without dashes).
 * @param {string} election_id
 * @returns {bigint}
 */
function electionIdToBigInt(election_id) {
    return BigInt(`0x${election_id.replace(/-/g, "")}`);
}

module.exports = { electionIdToBigInt };
