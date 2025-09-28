const express = require("express");
const router = express.Router();
const validator = require('validator');
const supabase = require("../supabaseClient");
const authAdmin = require("../middleware/authAdmin");

/**
 * @route   POST /setVote
 * @desc    Creates a new election with its initial configuration.
 * @access  Private (Admin Only)
 */
router.post("/", authAdmin, async (req, res) => {
    // --- 1. Input Destructuring and Validation ---
    const {
        name,
        merkleTreeDepth,
        candidates,
        regEndTime
    } = req.body;

    // presence check
    if (!name || !merkleTreeDepth || !candidates || !regEndTime) {
        return res.status(400).json({ 
            error: "Missing required fields.",
            details: "Fields `name`, `merkleTreeDepth`, `candidates`, and `regEndTime` are all required."
        });
    }

    // Detailed validation
    if (typeof name !== 'string' || name.trim() === '') {
        return res.status(400).json({ error: "Validation Error", details: "`name` must be a non-empty string." });
    }
    if (!Number.isInteger(merkleTreeDepth) || merkleTreeDepth <= 0) {
        return res.status(400).json({ error: "Validation Error", details: "`merkleTreeDepth` must be a positive integer." });
    }
    if (!Array.isArray(candidates) || candidates.length === 0 || !candidates.every(c => typeof c === 'string' && c.trim() !== '')) {
        return res.status(400).json({ error: "Validation Error", details: "`candidates` must be a non-empty array of strings." });
    }
    if (!validator.isISO8601(regEndTime) || new Date(regEndTime) <= new Date()) {
        return res.status(400).json({ error: "Validation Error", details: "`regEndTime` must be a valid ISO 8601 date string set in the future." });
    }

    try {
        // --- 2. Insert New Election into the Database ---
        const numCandidates = candidates.length;

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

        if (!electionData || !electionData.id) {
            console.error("Failed to retrieve data after inserting into Elections table. Check RLS policies.");
            return res.status(500).json({ error: "Failed to create the election.", details: "Could not retrieve election details after creation." });
        }

        // --- 3. Create Initial State in MerkleState Table ---
        // This ensures every election has a corresponding Merkle tree record from the start.
        const { error: merkleError } = await supabase
            .from("MerkleState")
            .insert({
                election_id: electionData.id,
                merkle_data: { leaves: [] }
            });

        if (merkleError) throw merkleError;

        return res.status(201).json({
            success: true,
            message: "New election created successfully.",
            election: electionData
        });

    } catch (err) {
        console.error("Error creating election:", err.message);
        if (err.code === '23505') { // PostgreSQL unique violation code
            return res.status(409).json({ error: "Conflict", details: "An election with this name or ID might already exist." });
        }
        return res.status(500).json({ error: "An internal server error occurred.", details: err.message });
    }
});

module.exports = router;