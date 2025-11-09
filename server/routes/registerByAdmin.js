/**
 * @file server/routes/registerByAdmin.js
 * @desc Route handler for allowing an admin to bulk-register voters (pre-approve emails)
 * for a specific election. Requires admin privileges.
 */

const express = require("express");
const router = express.Router({ mergeParams: true });
const validator = require('validator');
const supabase = require("../supabaseClient");
const authAdmin = require("../middleware/authAdmin");

/**
 * @route   POST /api/elections/:election_id/voters
 * @desc    Bulk registers voters for a specific election by providing a list of emails.
 * It validates emails, checks for duplicates within the election, ensures the registration
 * period is open, and inserts valid, new emails into the 'Voters' table in batches.
 * @access  Private (Admin Only - enforced by authAdmin middleware)
 * @param   {string} req.params.election_id - The UUID of the election to register voters for.
 * @param   {string[]} req.body.emails - An array of email addresses to register.
 * @param   {object} req.admin - The admin user object (attached by authAdmin middleware).
 * @returns {object} A summary report of the registration process (newly registered, duplicates, invalids) or error details.
 */
router.post("/", authAdmin, async (req, res) => {
    const { election_id } = req.params;
    const { emails: originalEmails = [] } = req.body;   // Default to empty array if emails property is missing

    // --- 1. Basic Input Validation ---
    if (!election_id) { // Should be guaranteed by router, but good practice
        return res.status(400).json({ error: "VALIDATION_ERROR", details: "Election ID is required in the URL path." });
    }
    if (!Array.isArray(originalEmails)) {
         return res.status(400).json({ error: "VALIDATION_ERROR", details: "`emails` must be provided as an array." });
    }

    // Allow empty array submission, but return early if so.
    if (originalEmails.length === 0) {
        return res.status(200).json({ // 200 OK is appropriate as the request was valid but resulted in no action
            success: true,
            message: "No emails provided to register.",
            summary: { newly_registered_count: 0, duplicates_skipped_count: 0, invalid_format_skipped_count: 0 },
            details: { newly_registered: [], duplicates_skipped: [], invalid_format_skipped: [] }
        });
    }

    // --- 2. Sanitize, Validate, and Deduplicate Input Emails ---
    const results = {
        newly_registered: [],
        duplicates_skipped: [],
        invalid_format_skipped: [],
    };

    // --- 3. Checking Input Emails ---
    // Use validator for consistency and robustness. Deduplicate using a Set.
    const uniqueValidEmails = Array.from(new Set(originalEmails.filter(email => {
        if (typeof email === 'string' && validator.isEmail(email)) {
            return true;
        }
        results.invalid_format_skipped.push(email);
        return false;
    })));

    // If no valid emails remain after filtering.
    if (uniqueValidEmails.length === 0) {
        console.warn(`[${election_id}] No valid emails found after filtering ${originalEmails.length} inputs.`);
        return res.status(400).json({ 
            error: "NO_VALID_EMAILS", 
            details: "No valid email addresses were found in the provided list.", 
            summary: results // Provide details on skipped emails
        });
    }

    try {
        // --- 3. Pre-check Election Status ---
        // Ensure the election exists and the registration period is still open.
        const { data: election, error: electionError } = await supabase
            .from("Elections")
            .select("id, registration_end_time")
            .eq("id", election_id)
            .single();

        if (electionError) {
            console.error(`[${election_id}] Error fetching election:`, electionError.message);
            if (electionError.code === 'PGRST116') {
                return res.status(404).json({ error: "ELECTION_NOT_FOUND", details: `Election with ID ${election_id} not found.` });
            }
            throw electionError;
        }
        if (!election) {
            return res.status(404).json({ error: "ELECTION_NOT_FOUND", details: `Election with ID ${election_id} not found.` });
        }

        // Check if the registration period has already ended.
        const registrationEndTime = new Date(election.registration_end_time);
        if (new Date() > registrationEndTime) {
            console.warn(`[${election_id}] Attempted to register voters after registration ended at ${registrationEndTime.toISOString()}.`);
            return res.status(403).json({ // 403 Forbidden
                error: "REGISTRATION_PERIOD_ENDED",
                details: `Cannot register voters: The registration deadline (${registrationEndTime.toISOString()}) has passed.`
            });
        }

        // --- 4. Check for Existing Voters within this Election ---
        const { data: existingVoters, error: selectError } = await supabase
            .from("Voters")
            .select("email")
            .eq("election_id", election_id) 
            .in("email", uniqueValidEmails);

        if (selectError) {
            console.error(`[${election_id}] Error checking for existing voters:`, selectError.message);
            throw selectError; // Propagate DB errors
        }

        const existingEmails = new Set(existingVoters.map(v => v.email));
        
        // Filter the input list to find only the emails that need to be inserted.
        const votersToInsert = [];
        for (const email of uniqueValidEmails) {
            if (existingEmails.has(email)) {
                results.duplicates_skipped.push(email);
            } else {
                // Prepare the record for insertion (user_id and user_secret are initially null)
                votersToInsert.push({ email: email, election_id: election_id });
            }
        }

        // --- 5. Perform Batch Insert for New Voters ---
        if (votersToInsert.length > 0) {
            // Store the emails that will be inserted for the final report.
            results.newly_registered = votersToInsert.map(v => v.email);
            
            // Define a reasonable batch size to avoid overwhelming the DB/network.
            const BATCH_SIZE = 500; // Adjust based on DB limits and performance testing

            for (let i = 0; i < votersToInsert.length; i += BATCH_SIZE) {
                const batch = votersToInsert.slice(i, i + BATCH_SIZE);
                
                const { error: insertError } = await supabase
                    .from("Voters")
                    .insert(batch);
                
                // If any batch insert fails, throw the error.
                // Consider adding retry logic or more granular error handling per batch if needed.
                if (insertError) {
                     console.error(`[${election_id}] Error inserting batch starting at index ${i}:`, insertError.message);
                    throw insertError;
                }
            }
        }

        // --- 6. Final Success Response ---
        // Use 200 OK if some emails were skipped but the operation logic completed.
        // Use 201 Created if only new emails were processed and inserted. Choose one for consistency.
        return res.status(200).json({ // Using 200 OK as it reports on skipped items too.
            success: true,
            message: `Admin voter registration process completed for election ${election_id}.`,
            // Provide a summary count for quick overview.
            summary: {
                newly_registered_count: results.newly_registered.length,
                duplicates_skipped_count: results.duplicates_skipped.length,
                invalid_format_skipped_count: results.invalid_format_skipped.length,
            },
            // Optionally include detailed lists (might be large, consider if needed by client).
            // details: results 
        });

    } catch (err) {
        // --- 7. Error Handling ---
        console.error(`[${election_id}] Admin bulk voter registration failed:`, err.message);

        // Handle specific errors like unique constraints (can happen with high concurrency
        // even with the pre-check if two admins submit overlapping lists simultaneously).
        if (err.code === '23505') { // PostgreSQL unique_violation
            return res.status(409).json({ // 409 Conflict
                 error: "DUPLICATE_EMAIL_ON_INSERT", 
                 details: "A unique constraint violation occurred during insertion. This might happen in high-concurrency scenarios or if duplicates were missed in the check." 
            });
        }
        
        // Generic server error for other issues.
        return res.status(500).json({ 
            error: "SERVER_ERROR", 
            details: "An internal server error occurred during the bulk registration process." 
            // Avoid sending raw err.message in production.
        });
    }
});

module.exports = router;