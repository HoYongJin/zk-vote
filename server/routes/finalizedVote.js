/**
 * @file server/routes/finalizedVote.js
 * @desc Route handler for fetching a list of elections that are currently active for voting.
 * Admins get all active elections with voter counts.
 * Regular users get only the active elections they are registered for.
 */

const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const auth = require("../middleware/auth");

/**
 * @route   GET /api/elections/finalized
 * @desc    Retrieves a list of elections that are currently in the voting phase
 * (i.e., registration is closed, voting has started, and voting has not ended).
 * - Admins receive all such elections, augmented with total voter count and registered voter count.
 * - Regular users receive only the elections they have completed registration for (user_id is not null).
 * @access  Private (Requires standard user authentication via `auth` middleware)
 * @param   {object} req.user - The authenticated Supabase user object.
 * @returns {object[]} An array of election objects or an error message.
 * For admins, each object includes `total_voters` and `registered_voters`.
 */
router.get("/", auth, async (req, res) => { 
    try {
        const user = req.user; 
        const now = new Date();
        const nowISO = now.toISOString();

        // --- 1. Check if the user is an administrator ---
        // Improvement Suggestion: Use an optional admin middleware (`authAdminOptional`)
        // to avoid this extra DB query. Check `if (req.admin)` instead.
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
             console.error(`[finalizedVote.js] Error checking admin status for user ${user.id}:`, adminCheckError.message);
             throw new Error("Failed to verify admin status."); 
        } 

        // --- 2. Prepare the base query for active (voting phase) elections ---
        // Conditions:
        // - Not yet marked as completed.
        // - Voting start time is in the past.
        // - Voting end time is in the future.
        let query = supabase
            .from("Elections")
            .select("id, name, candidates, voting_end_time, contract_address, merkle_tree_depth, num_candidates") // Fields needed by frontend
            .eq('completed', false)                     // Must not be completed
            .lt('voting_start_time', nowISO)            // Voting must have started
            .gt('voting_end_time', nowISO);             // Voting must not have ended

        // --- 3. If the user is NOT an admin, filter by their completed registrations ---
        if (!isAdmin) {
            // Find all election IDs where this user completed registration (user_id is set).
            const { data: voterRecords, error: voterError } = await supabase
                .from('Voters')
                .select('election_id')
                .eq('user_id', user.id); // Match by the user's unique ID

            if (voterError) {
                console.error(`[finalizedVote.js] Error fetching voter records for user ${user.id}:`, voterError.message);
                throw voterError; 
            }

            // If the user hasn't completed registration for any elections, they can't vote in any.
            if (!voterRecords || voterRecords.length === 0) {
                return res.status(200).json([]); 
            }

            // Extract the list of election IDs the user is eligible to vote in.
            const registeredElectionIds = voterRecords.map(record => record.election_id);

            // Add the filter to the base query.
            query = query.in('id', registeredElectionIds);
        }

        // --- 4. Execute the main query to get the list of elections ---
        const { data: elections, error: electionsError } = await query;

        if (electionsError) {
            console.error(`[finalizedVote.js] Error executing elections query for user ${user.id}:`, electionsError.message);
            throw electionsError;
        }

        // If no elections match the criteria, return an empty array.
        if (!elections || elections.length === 0) {
            return res.status(200).json([]);
        }

        // --- 5. If Admin, fetch voter counts (N+1 Query Issue) ---
        if (isAdmin) {
            const electionsWithCounts = await Promise.all(
                elections.map(async (election) => {
                    let total_voters = 0;
                    let registered_voters = 0;

                    try {
                        // Count all voters pre-registered for this election by the admin.
                        const { count: totalCount, error: totalError } = await supabase
                            .from("Voters")
                            .select('*', { count: 'exact', head: true }) // head:true optimizes by not fetching data
                            .eq("election_id", election.id);
                        if (totalError) throw totalError;
                        total_voters = totalCount;

                        // Count voters who have completed registration (user_id is not null).
                        const { count: registeredCount, error: registeredError } = await supabase
                            .from("Voters")
                            .select('*', { count: 'exact', head: true })
                            .eq("election_id", election.id)
                            .not('user_id', 'is', null); // Filter for completed registrations
                        if (registeredError) throw registeredError;
                        registered_voters = registeredCount;

                    } catch (countError) {
                        console.error(`[finalizedVote.js] Error fetching voter counts for election ${election.id}:`, countError.message);
                        // Return 0 counts if fetching failed, but don't fail the whole request.
                    }

                    return {
                        ...election,
                        total_voters: total_voters || 0,
                        registered_voters: registered_voters || 0,
                    };
                })
            );
            return res.status(200).json(electionsWithCounts);
        }

        // --- 6. If Regular User, return the filtered list without counts ---
        res.status(200).json(elections);  

    } catch (err) {
        // --- 7. General Error Handling ---
        console.error("[finalizedVote.js] Failed to fetch finalized (active) elections:", err.message);
        return res.status(500).json({ 
            error: "SERVER_ERROR", 
            details: "An internal server error occurred while fetching active elections." 
        });
    }
});

module.exports = router;