const express = require("express");
const router = express.Router();
const validator = require('validator');
const supabase = require("../supabaseClient");
const authAdmin = require("../middleware/authAdmin");

/**
 * @route   POST /admins
 * @desc    Adds a user's email to the admin invitation list.
 * @access  Private (Admin Only)
 */
router.post("/", authAdmin, async (req, res) => {
    const { email } = req.body;
    const inviterAdminId = req.admin.id; // Assume `authAdmin` middleware attaches admin info to req.admin

    // --- 1. Input Validation ---
    if (!email) {
        return res.status(400).json({ error: "Email is required." });
    }
    if (!validator.isEmail(email)) {
        return res.status(400).json({ error: "Invalid email format provided." });
    }

    // --- 2. Add to Invitation List ---
    try {
        // 초대 명단에 이메일 추가 (이미 존재하면 무시)
        const { error } = await supabase
            .from("AdminInvitations")
            .insert({ email }, { upsert: true });

        if (error) throw error;

        return res.status(201).json({ 
            success: true, 
            message: `Successfully added ${email} to the admin invitation list.` 
        });

    } catch (err) {
        console.error("Admin invitation failed: ", err.message);
        return res.status(500).json({ error: "Failed to process admin invitation.", details: err.message });
    }
});

module.exports = router;