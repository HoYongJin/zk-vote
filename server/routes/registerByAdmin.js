const express = require("express");
const router = express.Router();
const validator = require('validator');
const supabase = require("../supabaseClient");
const authAdmin = require("../middleware/authAdmin");

/**
 * @route   POST /registerByAdmin
 * @desc    Allows an admin to bulk-register voters for a specific election.
 * @access  Private (Admin Only)
 */
router.post("/", authAdmin, async (req, res) => {
    const { election_id } = req.params;
    const { emails: originalEmails = [] } = req.body;

    // --- 1. Basic Input Validation ---
    if (!election_id) {
        return res.status(400).json({ error: "An election_id must be provided." });
    }
    if (!Array.isArray(originalEmails) || originalEmails.length === 0) {
        return res.status(400).json({ error: "An array of emails must be provided." });
    }

    const results = {
        newly_registered: [],
        duplicates_skipped: [],
        invalid_format_skipped: [],
    };

    // --- 2. Checking Input Emails ---
    // Use validator for consistency and robustness. Deduplicate using a Set.
    const uniqueValidEmails = Array.from(new Set(originalEmails.filter(email => {
        if (typeof email === 'string' && validator.isEmail(email)) {
            return true;
        }
        results.invalid_format_skipped.push(email);
        return false;
    })));

    if (uniqueValidEmails.length === 0) {
        return res.status(400).json({ error: "No valid emails were provided after filtering.", details: results });
    }

    try {
        // --- 3. Pre-check Election Status ---
        const { data: election, error: electionError } = await supabase
            .from("Elections")
            .select("id, registration_end_time")
            .eq("id", election_id)
            .single();

        if (electionError || !election) {
            return res.status(404).json({ error: "The provided election_id does not exist." });
        }

        // Check if the registration period is still open.
        if (new Date() > new Date(election.registration_end_time)) {
            return res.status(403).json({ 
                error: "Registration period has ended.",
                details: `The registration deadline for this election was ${election.registration_end_time}.`
            });
        }

        // --- 4. Check for Duplicate Voters within this Election ---
        const { data: existingVoters, error: selectError } = await supabase
            .from("Voters")
            .select("email")
            .eq("election_id", election_id) 
            .in("email", uniqueValidEmails);

        if (selectError) throw selectError;

        const existingEmails = new Set(existingVoters.map(v => v.email));
        const votersToInsert = [];

        for (const email of uniqueValidEmails) {
            if (existingEmails.has(email)) {
                results.duplicates_skipped.push(email);
            } else {
                votersToInsert.push({ email, election_id });
            }
        }

        // --- 5. Perform Batch Insert for New Voters ---
        if (votersToInsert.length > 0) {
            results.newly_registered = votersToInsert.map(v => v.email);
            
            // Batch processing is an excellent way to handle large amounts of data efficiently.
            const BATCH_SIZE = 500;
            for (let i = 0; i < votersToInsert.length; i += BATCH_SIZE) {
                const batch = votersToInsert.slice(i, i + BATCH_SIZE);
                
                const { error: insertError } = await supabase
                    .from("Voters")
                    .insert(batch);
                
                if (insertError) throw insertError;
            }
        }

        // --- 6. Final Success Response ---
        return res.status(201).json({
            success: true,
            message: `Voter registration process completed for election ${election_id}.`,
            summary: {
                newly_registered_count: results.newly_registered.length,
                duplicates_skipped_count: results.duplicates_skipped.length,
                invalid_format_skipped_count: results.invalid_format_skipped.length,
            },
            details: results
        });

    } catch (err) {
        console.error("Admin voter registration failed:", err.message);
        if (err.code === '23505') {
            return res.status(409).json({ error: "Duplicate email found.", details: "A unique constraint violation occurred during insertion. This can happen in high-concurrency scenarios." });
        }
        return res.status(500).json({ error: "An internal server error occurred.", details: err.message });
    }
});

module.exports = router;