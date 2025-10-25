/**
 * @file server/routes/proof.js
 * @desc Route handler for generating Merkle proof data needed by a voter
 * to create a ZK-SNARK for casting their vote.
 * It securely retrieves the user's secret from the database.
 */

const express = require("express");
const router = express.Router({ mergeParams: true });
const supabase = require("../supabaseClient");
const auth = require("../middleware/auth");
const { generateMerkleProof } = require("../utils/merkle");

/**
 * @route   POST /api/elections/:election_id/proof
 * @desc    Generates and returns the Merkle proof components for the currently
 * authenticated user for a specific election. This endpoint is called
 * by the voter's client *before* generating the ZK proof locally.
 * It fetches the user's secret securely from the DB based on their auth token.
 * @access  Private (Requires standard user authentication via `auth` middleware)
 * @param   {string} req.params.election_id - The UUID of the election.
 * @param   {object} req.user - The authenticated Supabase user object (attached by `auth` middleware).
 * @returns {object} Contains the Merkle proof (`root`, `pathElements`, `pathIndices`)
 * and the `user_secret` needed as private input for the ZK circuit.
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
        // --- Pre-checks ---
        
        // 1. Fetch election details and validate the voting period.
        const { data: election, error: electionError } = await supabase
            .from("Elections")
            .select("id, voting_start_time, voting_end_time")
            .eq("id", election_id)
            .single();

        if (electionError) {
            console.error(`[proof.js] Error fetching election ${election_id}:`, electionError.message);
            if (electionError.code === 'PGRST116') { // No rows found
                return res.status(404).json({ error: "ELECTION_NOT_FOUND", details: `Election with ID ${election_id} not found.` });
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
        if (!election.voting_end_time || now > new Date(election.voting_end_time)) {
            return res.status(403).json({ 
                error: "VOTING_ENDED", 
                details: "The voting period for this election has already ended." 
            });
        }

        // 2. Securely fetch the voter's record, including their secret, using their authenticated user ID.
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

        // 3. Check if the user has completed the registration (has a non-null user_secret).
        if (!voterRecord || !voterRecord.user_secret) {
            // This case might overlap with PGRST116 if the row exists but secret is null,
            // or if the row itself wasn't found (handled above). Keeping it for clarity.
            return res.status(403).json({ 
                error: "REGISTRATION_INCOMPLETE", 
                details: "Voter has not completed the registration process, required to generate a secret." 
            });
        }

        // --- Generate Proof ---

        // 4. Generate the Merkle proof using the retrieved secret.
        //    The `generateMerkleProof` function handles tree generation/caching internally.
        const proofData = await generateMerkleProof(election_id, voter.user_secret);

        // 5. Return the proof components AND the user secret to the client.
        //    The user_secret is returned because the client-side ZKP generation
        //    (`proof.worker.js`) needs it as a private input. Ensure the client handles it securely.
        return res.status(200).json({
            success: true,
            message: "Merkle proof generated successfully.",
            user_secret: voter.user_secret,
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