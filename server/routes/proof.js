/**
 * @file server/routes/proof.js
 * @desc Route handler for generating Merkle proof data needed by a voter
 * to create a ZK-SNARK for casting their vote. AND issuing a
 * single-use submission ticket.
 * It retrieves the user's stored leaf commitment. The plaintext voter secret is
 * client-held and is never returned by this endpoint.
 */

const express = require("express");
const router = express.Router({ mergeParams: true });
const supabase = require("../supabaseClient");
const auth = require("../middleware/auth");
const { generateMerkleProof } = require("../utils/merkle");
const { issueSubmissionTicket } = require("../utils/submissionTickets");
const { verifyElectionArtifacts } = require("../utils/zkArtifacts");

/**
 * @route   POST /api/elections/:election_id/proof
 * @desc    Generates Merkle proof components for the authenticated user
 * AND issues a short-lived, single-use "submission ticket".
 * This ticket is required by the anonymous /submit endpoint to prevent DDoS.
 * @access  Private (Requires standard user authentication via `auth` middleware)
 * @param   {string} req.params.election_id - The UUID of the election.
 * @param   {object} req.user - The authenticated Supabase user object (attached by `auth` middleware).
 * @returns {object} Contains Merkle proof components and the newly generated
 * `submissionTicket`. It does not include the plaintext voter secret.
 */
router.post("/", auth, async (req, res) => {
    // Extract election ID from URL and user info from auth middleware.
    const { election_id } = req.params;
    const user = req.user;

    // Basic validation for election_id presence (though handled by routing typically).
    if (!election_id) {
        return res.status(400).json({ 
            error: "VALIDATION_ERROR", 
            details: "An `election_id` URL parameter must be provided." 
        });
    }

    try {
        // --- 1. Fetch Election Details & Validate Voting Period ---
        const { data: election, error: electionError } = await supabase
            .from("Elections")
            .select("id, voting_start_time, voting_end_time, merkle_root")
            .eq("id", election_id)
            .single();

        if (electionError) {
            console.error(`[proof.js] Error fetching election ${election_id}:`, electionError.message);
            if (electionError.code === 'PGRST116') { // No rows found
                return res.status(404).json({ 
                    error: "ELECTION_NOT_FOUND", 
                    details: `Election with ID ${election_id} not found.` 
                });
            }
            throw electionError;
        }
        
        // Validate if the current time is within the voting window.
        const now = new Date();
        if (!election.voting_start_time) {
            return res.status(403).json({ 
                error: "VOTING_NOT_STARTED", 
                details: "The voting period for this election has not started yet." 
            });
        }
        if (now < new Date(election.voting_start_time)) {
            return res.status(403).json({
                error: "VOTING_NOT_STARTED",
                details: "The voting period for this election has not started yet."
            });
        }
        if (!election.merkle_root) {
            return res.status(403).json({
                error: "ELECTION_NOT_FINALIZED",
                details: "The election Merkle root has not been finalized yet."
            });
        }
        if (!election.voting_end_time || now > new Date(election.voting_end_time)) {
            return res.status(403).json({
                error: "VOTING_ENDED",
                details: "The voting period for this election has already ended."
            });
        }

        // 1b. Ensure the proving artifacts on disk are still the ones this
        // election was deployed with (audit M5). A regenerated zkey carries new
        // randomness, so every proof built against it would be rejected by the
        // deployed on-chain verifier; fail fast with a typed error instead.
        const artifactCheck = verifyElectionArtifacts(election_id);
        if (!artifactCheck.ok) {
            console.error(`[proof.js] Artifact binding mismatch for election ${election_id}: ${artifactCheck.reason}`);
            return res.status(409).json({
                error: "ARTIFACT_MISMATCH",
                details: "The ZK artifacts for this election no longer match the ones it was deployed with. Voting requires manual reconciliation by the operator."
            });
        }

        // 2. Fetch the voter's committed leaf using their authenticated user ID.
        const { data: voterRecord, error: voterError } = await supabase
            .from("Voters")
            .select("user_secret")
            .eq("user_id", user.id)
            .eq("election_id", election_id)
            .single();

        if (voterError) {
            console.error(`[proof.js] Error fetching voter record for user ${user.id} in election ${election_id}:`, voterError.message);
            if (voterError.code === 'PGRST116') {
                return res.status(403).json({ 
                    error: "NOT_A_REGISTERED_VOTER", 
                    details: "The authenticated user is not registered for this election or hasn't completed registration." 
                });
            }
            throw voterError;
        }

        // 3. Check if the user has completed registration (has a non-null commitment).
        if (!voterRecord || !voterRecord.user_secret) {
            // This case might overlap with PGRST116 if the row exists but commitment is null,
            // or if the row itself wasn't found (handled above). Keeping it for clarity.
            return res.status(403).json({ 
                error: "REGISTRATION_INCOMPLETE", 
                details: "Voter has not completed the registration process." 
            });
        }

        // --- Generate Proof ---

        // 4. Generate the Merkle proof using the stored H(secret) commitment.
        //    The `generateMerkleProof` function handles tree generation/caching internally.
        const proofData = await generateMerkleProof(election_id, voterRecord.user_secret);
        if (BigInt(proofData.root) !== BigInt(election.merkle_root)) {
            console.error(`[proof.js] Merkle root mismatch for election ${election_id}: proof=${proofData.root}, db=${election.merkle_root}`);
            return res.status(409).json({
                error: "MERKLE_ROOT_OUT_OF_SYNC",
                details: "The Merkle proof root is out of sync with the finalized election root."
            });
        }
        // --- 5. Generate and Store Single-Use Submission Ticket ---
        const submissionTicket = await issueSubmissionTicket({
            electionId: election_id,
            merkleRoot: proofData.root,
        });

        // 5. Return proof components only. The client already holds the plaintext
        //    secret needed by proof.worker.js.
        return res.status(200).json({
            success: true,
            message: "Merkle proof generated successfully.",
            submissionTicket: submissionTicket,
            ...proofData
        });

    } catch (err) {
        // Catch any unexpected errors from DB calls or generateMerkleProof.
        console.error(`[proof.js] Proof generation failed for user ${user.id}, election ${election_id}:`, err.message);
        return res.status(500).json({ 
            error: "PROOF_GENERATION_ERROR", 
            details: "An internal server error occurred while generating the proof." 
            // Avoid sending raw err.message to client in production for security.
        });
    }
});

module.exports = router;
