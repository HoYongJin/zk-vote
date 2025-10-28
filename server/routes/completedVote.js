/**
 * @file server/routes/completedVote.js
 * @desc Route handler for fetching a list of completed elections.
 * Admins get all completed elections, while regular users get only those
 * they were registered in (i.e., completed the registration for).
 */

const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const auth = require("../middleware/auth");

/**
 * @route   GET /api/elections/completed
 * @desc    Retrieves a list of elections marked as completed.
 * - If the authenticated user is an admin, it returns all completed elections.
 * - If the authenticated user is not an admin, it returns only the completed
 * elections that the user was registered for (had a non-null user_id in Voters).
 * @access  Private (Requires standard user authentication via `auth` middleware)
 * @param   {object} req.user - The authenticated Supabase user object (attached by `auth` middleware).
 * @returns {object[]} An array of completed election objects or an error message.
 */
router.get("/", auth, async (req, res) => {
    try {
        const user = req.user;

        // --- 1. Check if the user is an administrator ---
        let isAdmin = false;
        try {
            const { data: adminData, error: adminError } = await supabase
                .from("Admins")
                .select('id') // Only need to check for existence
                .eq('id', user.id)
                .single();

            // Handle potential errors during the admin check, but allow 'PGRST116' (Not Found)
            if (adminError && adminError.code !== 'PGRST116') {
                throw adminError; // Throw unexpected DB errors
            }
            if (adminData) {
                isAdmin = true; // User exists in the Admins table
            }
        } catch(adminCheckError) {
             console.error(`[completedVote.js] Error checking admin status for user ${user.id}:`, adminCheckError.message);
             // Decide if this error should prevent non-admins from seeing their votes.
             // For safety, we can throw, but alternatively, we could proceed assuming not admin.
             throw new Error("Failed to verify admin status."); 
        }

        // --- 2. Prepare the base query for completed elections ---
        let query = supabase
            .from("Elections")
            .select("id, name, candidates, voting_end_time, contract_address") 
            .eq('completed', true); // Filter only elections marked as completed

        // --- 3. If the user is NOT an admin, filter by their participation ---
        if (!isAdmin) {
            // Find all election IDs where this user completed registration (user_id is set).
            const { data: voterRecords, error: voterError } = await supabase
                .from('Voters')
                .select('election_id')
                .eq('user_id', user.id); // Match based on the authenticated user's ID

            if (voterError) {
                console.error(`[completedVote.js] Error fetching voter records for user ${user.id}:`, voterError.message);
                throw voterError; // Throw DB error
            }

            // If the user didn't register for any elections, they have no completed votes to see.
            if (!voterRecords || voterRecords.length === 0) {
                return res.status(200).json([]); // Return empty array
            }

            // Extract the list of election IDs the user participated in.
            const participatedElectionIds = voterRecords.map(record => record.election_id);

            // Add a filter to the base query to only include these election IDs.
            query = query.in('id', participatedElectionIds);
        }

        // --- 4. Execute the final query ---
        const { data: completedElections, error: queryError } = await query;

        if (queryError) {
            console.error(`[completedVote.js] Error executing final query for user ${user.id}:`, queryError.message);
            throw queryError; // Throw DB error
        }

        // --- 5. Return the results ---
        res.status(200).json(completedElections || []); // Return data or empty array if null

    } catch (err) {
        // --- 6. General Error Handling ---
        console.error("[completedVote.js] Failed to fetch completed votes:", err.message);
        return res.status(500).json({ 
            error: "SERVER_ERROR", 
            details: "An internal server error occurred while fetching completed votes." 
        });
    }
});

module.exports = router;