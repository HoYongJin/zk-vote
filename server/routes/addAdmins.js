/**
 * @file server/routes/addAdmins.js
 * @desc Route handler for adding a potential administrator's email
 * to an invitation list. Requires admin privileges.
 */

const express = require("express");
const router = express.Router();
const validator = require('validator');
const supabase = require("../supabaseClient");
const authAdmin = require("../middleware/authAdmin");

/**
 * @route   POST /api/management/addAdmins
 * @desc    Adds a specified email address to the 'AdminInvitations' table.
 * This effectively marks the email as eligible to become an admin,
 * though the actual role change might happen elsewhere
 * @access  Private (Admin Only - enforced by authAdmin middleware)
 * @param   {string} req.body.email - The email address to add to the invitation list.
 * @param   {object} req.admin - The admin user object attached by the authAdmin middleware. (Used for authorization)
 * @returns {object} Success message or error details.
 */
router.post("/", authAdmin, async (req, res) => {
    // Extract email from request body.
    const { email } = req.body;

    // --- 1. Input Validation ---
    // Check if email is provided.
    if (!email) {
        return res.status(400).json({ 
            error: "VALIDATION_ERROR", 
            details: "Email is required in the request body." 
        });
    }
    // Check if the provided email has a valid format.
    if (!validator.isEmail(email)) {
        return res.status(400).json({ 
            error: "VALIDATION_ERROR", 
            details: "Invalid email format provided." 
        });
    }

    // --- 2. Add email to Invitation List in Supabase ---
    try {
        // 초대 명단에 이메일 추가 (이미 존재하면 무시)
        const { error } = await supabase
            .from("AdminInvitations")
            .insert({ email }, { upsert: true });

        // If Supabase returned an error during the insert/upsert.
        if (error) {
            // Throw the error to be caught by the catch block below.
            throw error; 
        }

        // --- 3. Success Response ---
        return res.status(201).json({ 
            success: true, 
            message: `Successfully added ${email} to the admin invitation list.` 
        });

    } catch (err) {
        // --- 4. Error Handling ---
        console.error(`[addAdmins.js] Failed to add admin invitation for ${email}:`, err.message);
        
        // Provide a more specific error message if possible, otherwise generic.
        let statusCode = 500;
        let errorType = "SERVER_ERROR";
        let details = "Failed to process the admin invitation due to an internal server error.";
            
        return res.status(statusCode).json({ error: errorType, details: details });
    }
});

module.exports = router;