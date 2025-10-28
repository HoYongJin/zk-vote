/**
 * @file server/routes/registerableVote.js
 * @desc Route handler for fetching a list of elections currently open for voter registration.
 * Differentiates between admin and regular user views.
 */

const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const auth = require("../middleware/auth");

/**
 * @route   GET /api/elections/registerable
 * @desc    Retrieves a list of elections currently in the registration phase.
 * - Admins see all elections currently open for registration.
 * - Regular users see all elections they are pre-registered for (by email)
 * that are currently open for registration, along with a flag indicating
 * if they have already completed their registration (`isRegistered`).
 * @access  Private (Requires standard user authentication via `auth` middleware)
 * @param   {object} req.user - The authenticated Supabase user object.
 * @returns {object[]} An array of election objects or an error message.
 * For non-admins, each object includes an `isRegistered` boolean flag.
 */
router.get("/", auth, async (req, res) => { 
    try {
        const user = req.user; 
        const now = new Date();
        const nowISO = now.toISOString();
        
        // --- 1. Check if the user is an administrator ---
        // Improvement Suggestion: Use optional admin middleware to avoid this query.
        let isAdmin = false;
        try {
            const { data: adminData, error: adminError } = await supabase
                .from("Admins")
                .select('id')
                .eq('id', user.id)
                .single();

            if (adminError && adminError.code !== 'PGRST116') throw adminError;
            if (adminData) isAdmin = true;
        } catch(adminCheckError) {
             console.error(`[registerableVote.js] Error checking admin status for user ${user.id}:`, adminCheckError.message);
             throw new Error("Failed to verify admin status.");
        }   

        // --- 2. Prepare the base query for elections open for registration ---
        let query = supabase
            .from("Elections")
            .select("id, name, candidates, contract_address, registration_end_time") // Fields needed by frontend
            .lt('registration_start_time', nowISO) // Registration must have started
            .gt('registration_end_time', nowISO);  // Registration must not have ended

        // --- 3. Handle Admin vs. Regular User ---
        if (isAdmin) {
            // Admins see all registerable elections. Execute the base query.
            const { data: elections, error } = await query;
            if (error) throw error;
            return res.status(200).json(elections || []);
        }else {
            // Regular users see only elections they are pre-registered for.

            // [A] Find all election IDs the user is pre-registered for (by email).
            const { data: preRegisteredRecords, error: preRegError } = await supabase
                .from('Voters')
                .select('election_id')
                .eq('email', user.email); // Pre-registration is email-based

            if (preRegError) {
                 console.error(`[registerableVote.js] Error fetching pre-registered records for email ${user.email}:`, preRegError.message);
                 throw preRegError;
            }

            // If the user's email is not on any voter list, they have no registerable elections.
            if (!preRegisteredRecords || preRegisteredRecords.length === 0) {
                return res.status(200).json([]);
            }
            const preRegisteredElectionIds = preRegisteredRecords.map(record => record.election_id);

            // [B] Find all election IDs where the user has *completed* registration (user_id is set).
            // Use user.id here for accuracy, as email might change after registration.
            const { data: completedRegRecords, error: completedRegError } = await supabase
                .from('Voters')
                .select('election_id')
                .eq('user_id', user.id); // Check completed registration by user ID

             if (completedRegError) {
                 console.error(`[registerableVote.js] Error fetching completed registration records for user ${user.id}:`, completedRegError.message);
                 throw completedRegError;
             }
             // Create a Set for efficient lookup of completed registrations.
             const completedVoteIds = new Set(
                (completedRegRecords || []).map(record => record.election_id)
             );

            // [C] Modify the query to fetch only pre-registered elections that are currently registerable.
            query = query.in('id', preRegisteredElectionIds);

            // Execute the filtered query.
            const { data: userRegisterableElections, error: finalQueryError } = await query;
            if (finalQueryError) throw finalQueryError;

            // [D] Add the 'isRegistered' flag to the results.
            const result = (userRegisterableElections || []).map(election => ({
                ...election,
                isRegistered: completedVoteIds.has(election.id) // Check if election ID is in the completed set
            }));

            return res.status(200).json(result);
        }

    } catch (err) {
        // --- 4. General Error Handling ---
        console.error("[registerableVote.js] Failed to fetch registerable votes:", err.message);
        return res.status(500).json({
            error: "SERVER_ERROR",
            details: "An internal server error occurred while fetching registerable elections."
        });
    }
});

module.exports = router;