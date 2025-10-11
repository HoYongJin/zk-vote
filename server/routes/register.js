const express = require("express");
const router = express.Router({ mergeParams: true });
const supabase = require("../supabaseClient");
const crypto = require("crypto");
const { addUserSecret } = require("../utils/merkle");
const auth = require("../middleware/auth");
require("dotenv").config();

/**
 * Generates a deterministic, unique secret for a user based on their UUID.
 * This secret is used as a private input for ZK-SNARK circuits.
 * @param {string} userId - The unique user ID (UUID) from the authentication provider.
 * @returns {string} A large number as a string.
 */
const generateUserSecret = (userId) => {
    if (!process.env.SECRET_SALT) {
        throw new Error("SECRET_SALT environment variable is not defined.");
    }
    const seed = userId + process.env.SECRET_SALT;
    const hash = crypto.createHash("sha256").update(seed).digest("hex");
    return BigInt("0x" + hash).toString();
};

/**
 * @route   POST /register
 * @desc    Allows a logged-in user to complete their voter registration for a specific election.
 * @access  Private (User Authentication Required)
 */
router.post("/", auth, async (req, res) => {
    // 1. Authenticate user via JWT from the header.
    // const authHeader = req.headers.authorization || "";
    // const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    // if (!token) {
    //     return res.status(401).json({ error: "AUTHENTICATION_REQUIRED" });
    // }

    const { election_id } = req.params;
    const { name } = req.body;
    const user = req.user;

    if (!name || typeof name !== 'string' || name.trim() === '') {
        return res.status(400).json({ error: "VALIDATION_ERROR", details: "A non-empty 'name' must be provided in the request body." });
    }

    try {
        // 4. Check if the election exists and if the registration period is active.
        const { data: election, error:electionError } = await supabase 
            .from("Elections")
            .select("id, registration_end_time")
            .eq("id", election_id)
            .single()

        if(electionError || !election) {
            return res.status(404).json({ error: "ELECTION_NOT_FOUND" });
        }

        if (new Date() > new Date(election.registration_end_time)) {
            return res.status(403).json({ error: "REGISTRATION_PERIOD_ENDED" });
        }

         // 5. Verify that the user's email is on the pre-approved voter list for this election.
         const { data: voter, error: selectError } = await supabase
            .from("Voters")
            .select("id, user_id") 
            .eq("email", user.email)
            .eq("election_id", election_id)
            .single();

        if (selectError || !voter) {
            return res.status(403).json({ error: "NOT_ON_VOTER_LIST", details: "This email is not on the pre-approved list for this election." });
        }

        // 6. Check if this voter has already completed their registration.
        if (voter.user_id) {
            return res.status(409).json({ error: "ALREADY_REGISTERED", details: "This voter has already completed the registration process." });
        }

        // 7. Generate the unique, deterministic user_secret.
        const user_secret = generateUserSecret(user.id);

        // 8. Atomically update the voter record with the user's details.
        const { error: updateError } = await supabase
            .from("Voters")
            .update({
                name: name,
                user_id: user.id, // Link the authenticated user account.
                user_secret: user_secret
            })
            .eq("id", voter.id); // Use the primary key for the update condition.

        if (updateError) throw updateError;

        // 9. Add the new secret to the off-chain Merkle tree state.
        await addUserSecret(election_id);

        // 10. Return a success response.
        return res.status(200).json({ // Use 200 OK for updates. 201 is for new resource creation.
            success: true,
            message: "Voter registration completed successfully."
        });

    } catch (err) {
        console.error("Voter registration failed:", err.message);
        return res.status(500).json({ error: "REGISTRATION_PROCESS_ERROR", details: err.message });
    }
});

module.exports = router;