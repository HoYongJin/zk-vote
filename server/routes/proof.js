const express = require("express");
const router = express.Router({ mergeParams: true });
const supabase = require("../supabaseClient");
const auth = require("../middleware/auth");
const { generateMerkleProof } = require("../utils/merkle");

/**
 * @route   POST /proof
 * @desc    Generates and returns the Merkle proof for an authenticated user for a specific election.
 * The user's secret is never sent from the client; it's securely retrieved from the DB.
 * @access  Private (User Authentication Required)
 */
router.post("/", auth, async (req, res) => {
    const { election_id } = req.params;
    const user = req.user;

    if (!election_id) {
        return res.status(400).json({ error: "VALIDATION_ERROR", details: "An `election_id` must be provided." });
    }

    try {
        // 2. Check if the election is currently in the voting phase.
        const { data: election, error: electionError } = await supabase
            .from("Elections")
            .select("id, voting_start_time, voting_end_time") // Make sure these columns exist
            .eq("id", election_id)
            .single();

        if (electionError || !election) {
            return res.status(404).json({ error: "ELECTION_NOT_FOUND" });
        }
        
        const now = new Date();
        if (!election.voting_start_time) {
            return res.status(403).json({ error: "VOTING_NOT_STARTED", details: "The voting period for this election has not started yet." });
        }
        if (!election.voting_end_time || now > new Date(election.voting_end_time)) {
            return res.status(403).json({ error: "VOTING_ENDED", details: "The voting period for this election has already ended." });
        }

        // 3. Securely fetch the user's secret from the database using their authenticated ID.
        const { data: voter, error: voterError } = await supabase
            .from("Voters")
            .select("user_secret")
            .eq("email", user.email)
            .eq("election_id", election_id)
            .single(); 

        if (voterError) throw voterError;

        // 4. Check if the user has completed the registration process (i.e., has a secret).
        if (!voter.user_secret) {
            return res.status(403).json({ error: "REGISTRATION_INCOMPLETE", details: "Voter has not completed the registration process to generate a secret." });
        }

        // 5. Generate the Merkle proof using the secret retrieved from the database.
        const proofData = await generateMerkleProof(election_id, voter.user_secret);

        // 6. Return the proof to the client.
        return res.status(200).json({
            success: true,
            message: "Merkle proof generated successfully.",
            ...proofData
        });

    } catch (err) {
        if (err.code === 'PGRST116') {
            console.error("Proof generation failed: User not found in Voters table for this election.", err.message);
            return res.status(403).json({ error: "NOT_A_REGISTERED_VOTER", details: "The authenticated user is not a registered voter for this specific election." });
        }
        console.error("Proof generation error:", err.message);
        return res.status(500).json({ error: "PROOF_GENERATION_ERROR", details: err.message });
    }
});

module.exports = router;