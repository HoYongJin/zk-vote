/**
 * @file server/routes/completeVote.js
 * @desc Route handler for marking an election as 'completed'. Requires admin privileges.
 */

const express = require("express");
const router = express.Router({ mergeParams: true });
const supabase = require("../supabaseClient");
const authAdmin = require("../middleware/authAdmin");

/**
 * @route   POST /api/elections/:election_id/complete
 * @desc    Marks a specific election as completed by setting its
 * `completed` flag to true in the database. Performs checks to ensure the
 * election exists, is not already completed
 * @access  Private (Admin Only - enforced by authAdmin middleware)
 * @param   {string} req.params.election_id - The UUID of the election to mark as completed.
 * @param   {object} req.admin - The admin user object (attached by authAdmin middleware).
 * @returns {object} Success message or error details.
 */
router.post("/", authAdmin, async (req, res) => {
    const { election_id } = req.params;
    const now = new Date();

    try {
        // --- 1. Pre-checks: Verify the election exists and is in a valid state to be completed ---
        const { data: election, error: fetchError } = await supabase
            .from("Elections")
            .select("id, completed, voting_end_time") // Select fields needed for checks
            .eq("id", election_id)
            .single();

        if (fetchError) {
            console.error(`[${election_id}] Error fetching election for completion check:`, fetchError.message);
            if (fetchError.code === 'PGRST116') {
                return res.status(404).json({ error: "ELECTION_NOT_FOUND", details: `Election with ID ${election_id} not found.` });
            }
            throw fetchError;
        }

        if (!election) { // Should be redundant due to .single() error handling
            return res.status(404).json({ error: "ELECTION_NOT_FOUND", details: `Election with ID ${election_id} not found.` });
        }

       // Check if the election is already marked as completed
       if (election.completed === true) {
           console.warn(`[${election_id}] Election is already marked as completed.`);
           return res.status(409).json({ // 409 Conflict
               error: "ALREADY_COMPLETED",
               details: "This election has already been marked as completed."
           });
       }

        // --- 2. Update the election record in the database ---
        // Set the 'completed' flag to true.
        // Use .select() to get the updated record back for confirmation.
        const { data: updatedElection, error: updateError } = await supabase
            .from("Elections")
            .update({ completed: true })
            .eq("id", election_id)
            .select('id, completed') // Select fields to confirm update
            .single(); // Expect one row to be updated

        // Handle potential errors during the update.
        if (updateError) {
            console.error(`[${election_id}] Error updating election to completed state:`, updateError.message);
            throw updateError;
        }

        // Verify that the update actually happened and returned the updated record.
        // If updatedElection is null here, it means the .eq("id", election_id) didn't match
        if (!updatedElection || updatedElection.completed !== true) {
            console.error(`[${election_id}] Failed to confirm election completion after update query. Update might have failed silently.`);
            return res.status(500).json({
               error: "UPDATE_CONFIRMATION_FAILED",
               details: "Failed to confirm the election status update in the database."
            });
       }

        // --- 3. Success Response ---
        return res.status(200).json({
            success: true,
            message: "Election has been successfully marked as completed."
        });

    } catch (err) {
        // --- 4. General Error Handling ---
        console.error(`[${election_id}] Error processing complete election request:`, err.message);
        return res.status(500).json({
            error: "SERVER_ERROR",
            details: "An internal server error occurred while marking the election as completed."
        });
    }
});

module.exports = router;