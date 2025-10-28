/**
 * @file server/routes/setVote.js
 * @desc Route handler for creating a new election record in the database.
 * Requires admin privileges. This endpoint only handles the initial DB record creation.
 */

const express = require("express");
const router = express.Router();
const validator = require('validator');
const supabase = require("../supabaseClient");
const authAdmin = require("../middleware/authAdmin");

/**
 * @route   POST /api/elections/set
 * @desc    Creates a new election record in the database with the provided configuration.
 * Validates input parameters like name, Merkle tree depth, candidates, and registration end time.
 * Sets the registration start time to the current time.
 * This endpoint *only* creates the database record; ZKP setup/deployment happens elsewhere.
 * @access  Private (Admin Only - enforced by authAdmin middleware)
 * @param   {string} req.body.name - The name of the election (must be non-empty).
 * @param   {number} req.body.merkleTreeDepth - The depth for the Merkle tree (must be a positive integer).
 * @param   {string[]} req.body.candidates - An array of candidate names (must be non-empty strings).
 * @param   {string} req.body.regEndTime - The registration deadline in ISO 8601 format (must be in the future).
 * @param   {object} req.admin - The admin user object (attached by authAdmin middleware).
 * @returns {object} Success message and the created election data, or error details.
 */
router.post("/", authAdmin, async (req, res) => {
    // --- 1. Input Destructuring and Validation ---
    const {
        name,
        merkleTreeDepth,
        candidates,
        regEndTime  // Registration End Time
    } = req.body;

    // Basic presence check for all required fields.
    if (!name || !merkleTreeDepth || !candidates || !regEndTime) {
        return res.status(400).json({ 
            error: "Missing required fields.",
            details: "Fields `name`, `merkleTreeDepth`, `candidates`, and `regEndTime` are all required."
        });
    }

    // Detailed validation for each field.
    if (typeof name !== 'string' || name.trim() === '') {
        return res.status(400).json({ error: "VALIDATION_ERROR", details: "`name` must be a non-empty string." });
    }
    if (!Number.isInteger(merkleTreeDepth) || merkleTreeDepth <= 0) {
        return res.status(400).json({ error: "VALIDATION_ERROR", details: "`merkleTreeDepth` must be a positive integer." });
    }
    if (!Array.isArray(candidates) || candidates.length === 0 || !candidates.every(c => typeof c === 'string' && c.trim() !== '')) {
        return res.status(400).json({ error: "VALIDATION_ERROR", details: "`candidates` must be a non-empty array of strings." });
    }
    if (!validator.isISO8601(regEndTime) || new Date(regEndTime) <= new Date()) {
        return res.status(400).json({ error: "VALIDATION_ERROR", details: "`regEndTime` must be a valid ISO 8601 date string set in the future." });
    }

    try {
        // --- 2. Insert New Election into Supabase 'Elections' Table ---
        const numCandidates = candidates.length;

        // Insert the new election record.
        const { data: electionData, error: electionError } = await supabase
            .from("Elections")
            .insert([{
                name: name.trim(),
                merkle_tree_depth: merkleTreeDepth,
                candidates: candidates,
                num_candidates: numCandidates,
                registration_start_time: new Date().toISOString(),
                registration_end_time: regEndTime,
            }])
            .select()
            .single(); // .single()을 사용하여 결과를 배열이 아닌 단일 객체로 받습니다.

        if (electionError) throw electionError;

        // Defensive check: Ensure data was returned after insert.
        // If `createdElection` is null here, it might indicate RLS issues
        // preventing the service role from reading its own inserts immediately.
        if (!createdElection || !createdElection.id) {
            console.error("[setVote.js] Failed to retrieve data after inserting into Elections table. Check RLS policies or Supabase function permissions.");
            return res.status(500).json({
                error: "ELECTION_CREATION_FAILED",
                details: "Could not retrieve election details immediately after creation. The record might exist, but confirmation failed."
            });
        }

        // --- 3. Success Response ---
        // Return 201 Created status code as a new resource (election record) was created.
        return res.status(201).json({
            success: true,
            message: "New election record created successfully.",
            election: electionData // Return the data of the created election record
        });

    } catch (err) {
        // --- 4. Error Handling ---
        console.error("[setVote.js] Error creating election record:", err.message);

        // Handle specific database errors
        if (err.code === '23505') { // PostgreSQL unique_violation code
            return res.status(409).json({
                error: "DUPLICATE_ELECTION",
                details: "An election with this name or potentially conflicting parameters might already exist."
            });
        }

        // Handle generic server errors.
        return res.status(500).json({
            error: "SERVER_ERROR",
            details: "An internal server error occurred while creating the election record."
        });
    }
});

module.exports = router;