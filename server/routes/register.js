/**
 * @file server/routes/register.js
 * @desc Route handler for completing a voter's registration for a specific election.
 * The client generates and keeps the voter secret; the backend stores only the
 * leaf commitment H(secret) needed for Merkle membership.
 */

const express = require("express");
const router = express.Router({ mergeParams: true });
const supabase = require("../supabaseClient");
const { addUserSecret } = require("../utils/merkle");
const auth = require("../middleware/auth");
const { normalizeEmail } = require("../utils/email");
const { parseFieldElement } = require("../utils/fieldElement");
const { isElectionSuperseded } = require("../utils/supersede");
require("dotenv").config();

/**
 * @route   POST /api/elections/:election_id/register
 * @desc    Allows a logged-in user (identified by JWT) to complete their registration
 * for the specified election. It verifies eligibility, stores the client
 * supplied leaf commitment, and invalidates the Merkle cache atomically.
 * @access  Private (Requires standard user authentication via `auth` middleware)
 * @param   {string} req.params.election_id - The UUID of the election to register for.
 * @param   {string} req.body.name - The name the voter wishes to register under.
 * @param   {string} req.body.secretCommitment - Poseidon H(secret), generated client-side.
 * @param   {object} req.user - The authenticated Supabase user object (attached by `auth` middleware).
 * @returns {object} Success message or error details.
 */
router.post("/", auth, async (req, res) => {
    // Extract election ID from URL parameters and user object from middleware.
    const { election_id } = req.params;
    const user = req.user;

    const { name, secretCommitment } = req.body;
    const normalizedUserEmail = normalizeEmail(user.email);
    if (!name || typeof name !== 'string' || name.trim() === '') {
        return res.status(400).json({ 
            error: "VALIDATION_ERROR", 
            details: "A non-empty 'name' must be provided in the request body." 
        });
    }
    if (!normalizedUserEmail) {
        return res.status(400).json({
            error: "VALIDATION_ERROR",
            details: "The authenticated user email is invalid."
        });
    }
    let normalizedCommitment;
    try {
        normalizedCommitment = parseFieldElement(secretCommitment, "secretCommitment").toString();
    } catch (_) {
        return res.status(400).json({
            error: "VALIDATION_ERROR",
            details: "A valid client-generated secretCommitment is required."
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

        if (await isElectionSuperseded(supabase, election_id)) {
            return res.status(409).json({
                error: "ELECTION_SUPERSEDED",
                details: "This election was superseded and registration is closed."
            });
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
            .eq("email", normalizedUserEmail)
            .eq("election_id", election_id)
            .single();

        if (voterSelectError) {
            console.error(`[register.js] Error fetching voter record for email ${normalizedUserEmail} in election ${election_id}:`, voterSelectError.message);
            if (voterSelectError.code === 'PGRST116') {
                 return res.status(403).json({ 
                    error: "NOT_ON_VOTER_LIST", 
                    details: "This email is not on the pre-approved list for this election." 
                });
            }
            throw voterSelectError;
        }

        // 3. A different authenticated user cannot take over an already-bound
        // allowlist row. The same user may re-bind a fresh commitment before
        // finalization so secret-loss recovery works until registration closes.
        if (voterRecord.user_id && voterRecord.user_id !== user.id) {
            return res.status(409).json({ // 409 Conflict is suitable for duplicate actions
                error: "ALREADY_REGISTERED", 
                details: "This voter has already completed the registration process for this election." 
            });
        }

        // --- All pre-checks passed. Store the client-held secret commitment. ---

        // 4. Call the `addUserSecret` utility.
        //    This function handles acquiring a lock, updating the DB *atomically*,
        //    and invalidating the cache. The stored value is H(secret), not the secret.
        await addUserSecret(election_id, trimmedName, user.id, normalizedUserEmail, normalizedCommitment);
        
        // 6. Return a success response upon successful completion of the atomic operation.
        return res.status(200).json({ // Use 200 OK for successful update
            success: true,
            message: "Voter registration completed successfully."
        });
    } catch (err) {
        // Catch errors from pre-checks or the addUserSecret function.
        console.error(`[register.js] Voter registration failed for user ${user.id} in election ${election_id}:`, err.message);
        if (err.status && err.code) {
            return res.status(err.status).json({
                error: err.code,
                details: err.message
            });
        }
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
