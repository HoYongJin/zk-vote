/**
 * @file server/routes/register.js
 * @desc Route handler for completing a voter's registration for a specific election.
 * This involves verifying eligibility, generating a unique secret, and updating
 * the database and Merkle cache atomically via the merkle utility.
 */

const express = require("express");
const router = express.Router({ mergeParams: true });
const supabase = require("../supabaseClient");
const crypto = require("crypto");
const { addUserSecret } = require("../utils/merkle");
const auth = require("../middleware/auth");
require("dotenv").config();

/**
 * Generates a deterministic, unique secret for a user based on their UUID and a secret salt.
 * This secret serves as a private input for the ZK-SNARK circuit and is used
 * to build the Merkle tree leaf for the voter.
 * Ensures the secret is consistent for the same user across different actions.
 * @param {string} userId - The unique user ID (UUID) from the Supabase auth user object.
 * @returns {string} A large number (derived from SHA256 hash) represented as a string.
 * @throws {Error} If the SECRET_SALT environment variable is not set.
 */
const generateUserSecret = (userId) => {
    // Ensure the required environment variable is present.
    if (!process.env.SECRET_SALT) {
        throw new Error("SECRET_SALT environment variable is not defined.");
    }
    // Combine user ID and salt to create a unique seed.
    const seed = userId + process.env.SECRET_SALT;
    // Hash the seed using SHA256.
    const hash = crypto.createHash("sha256").update(seed).digest("hex");
    // Convert the hexadecimal hash to a BigInt and then to a string.
    return BigInt("0x" + hash).toString();
};

/**
 * @route   POST /api/elections/:election_id/register
 * @desc    Allows a logged-in user (identified by JWT) to complete their registration
 * for the specified election. It verifies eligibility, generates the user's secret
 * and then calls the `addUserSecret` utility function to atomically
 * update the database and invalidate the Merkle cache.
 * @access  Private (Requires standard user authentication via `auth` middleware)
 * @param   {string} req.params.election_id - The UUID of the election to register for.
 * @param   {string} req.body.name - The name the voter wishes to register under (for display/optional).
 * @param   {object} req.user - The authenticated Supabase user object (attached by `auth` middleware).
 * @returns {object} Success message or error details.
 */
router.post("/", auth, async (req, res) => {
    // Extract election ID from URL parameters and user object from middleware.
    const { election_id } = req.params;
    const user = req.user;

    const { name } = req.body;
    if (!name || typeof name !== 'string' || name.trim() === '') {
        return res.status(400).json({ 
            error: "VALIDATION_ERROR", 
            details: "A non-empty 'name' must be provided in the request body." 
        });
    }
    const trimmedName = name.trim();

    try {
        // --- Pre-checks before attempting the critical section ---

        // 1. Check if the election exists and is currently in the registration period.
        const { data: election, error: electionError } = await supabase 
            .from("Elections")
            .select("id, registration_end_time")
            .eq("id", election_id)
            .single();

        if (electionError) {
            console.error(`[register.js] Error fetching election ${election_id}:`, electionError.message);
            // Distinguish between 'Not Found' and other DB errors
            if (electionError.code === 'PGRST116') { // PGRST116 = No rows found from .single()
                return res.status(404).json({ error: "ELECTION_NOT_FOUND", details: `Election with ID ${election_id} not found.` });
            }
            throw electionError;
        }

        // Check if registration period has ended.
        if (new Date() > new Date(election.registration_end_time)) {
            return res.status(403).json({ 
                error: "REGISTRATION_PERIOD_ENDED", 
                details: "The registration period for this election has ended." 
            });
        }

        // 2. Verify the logged-in user's email is on the pre-approved voter list for this election.
        const { data: voterRecord, error: voterSelectError } = await supabase
            .from("Voters")
            .select("id, user_id")
            .eq("email", user.email)
            .eq("election_id", election_id)
            .single();

        if (voterSelectError) {
            console.error(`[register.js] Error fetching voter record for email ${user.email} in election ${election_id}:`, voterSelectError.message);
            if (voterSelectError.code === 'PGRST116') {
                 return res.status(403).json({ 
                    error: "NOT_ON_VOTER_LIST", 
                    details: "This email is not on the pre-approved list for this election." 
                });
            }
            throw voterSelectError;
        }

        // 3. Check if this voter has already completed registration (user_id is not null).
        if (voterRecord.user_id) {
            return res.status(409).json({ // 409 Conflict is suitable for duplicate actions
                error: "ALREADY_REGISTERED", 
                details: "This voter has already completed the registration process for this election." 
            });
        }

        // --- All pre-checks passed. Proceed to generate secret and call the atomic update function ---

        // 4. Generate the unique, deterministic user_secret based on the user's UUID.
        const user_secret = generateUserSecret(user.id);

        // 5. Call the `addUserSecret` utility.
        //    This function handles acquiring a lock, updating the DB *atomically*,
        //    and invalidating the cache. We pass all necessary info.
        await addUserSecret(election_id, name, user.id, user.email, user_secret);
        
        // 6. Return a success response upon successful completion of the atomic operation.
        return res.status(200).json({ // Use 200 OK for successful update
            success: true,
            message: "Voter registration completed successfully."
        });
    } catch (err) {
        // Catch errors from pre-checks or the addUserSecret function.
        console.error(`[register.js] Voter registration failed for user ${user.id} in election ${election_id}:`, err.message);
        // Provide a generic error message to the client for security.
        return res.status(500).json({ 
            error: "REGISTRATION_PROCESS_ERROR", 
            details: "An internal server error occurred during registration." 
            // Consider providing more specific (but safe) error details if needed
            // based on the type of error caught (e.g., from addUserSecret timeout).
        });
    }
});

module.exports = router;