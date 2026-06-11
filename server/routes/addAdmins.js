/**
 * @file server/routes/addAdmins.js
 * @desc Route handler for adding a potential administrator's email
 * to an invitation list. Requires admin privileges.
 */

const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const authAdmin = require("../middleware/authAdmin");
const { normalizeEmail } = require("../utils/email");

async function findExistingAuthUserByEmail(normalizedEmail) {
    if (!supabase.auth?.admin?.listUsers) {
        return null;
    }

    let page = 1;
    const perPage = 1000;
    while (true) {
        const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
        if (error) {
            throw error;
        }

        const users = data?.users || [];
        const match = users.find((user) => normalizeEmail(user.email) === normalizedEmail);
        if (match) {
            return match;
        }

        if (users.length < perPage) {
            return null;
        }
        page += 1;
    }
}

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
    if (!email || typeof email !== "string") {
        return res.status(400).json({ 
            error: "VALIDATION_ERROR", 
            details: "Email is required in the request body." 
        });
    }
    const normalizedEmail = normalizeEmail(email);
    // Check if the provided email has a valid format.
    if (!normalizedEmail) {
        return res.status(400).json({ 
            error: "VALIDATION_ERROR", 
            details: "Invalid email format provided." 
        });
    }

    // --- 2. Add email to Invitation List in Supabase ---
    try {
        // 초대 명단에 이메일 추가 (이미 존재하면 갱신)
        const { error } = await supabase
            .from("AdminInvitations")
            .upsert({ email: normalizedEmail }, { onConflict: "email" });

        // If Supabase returned an error during the insert/upsert.
        if (error) {
            // Throw the error to be caught by the catch block below.
            throw error; 
        }

        let promotedExistingUser = false;
        try {
            const existingUser = await findExistingAuthUserByEmail(normalizedEmail);
            if (existingUser?.id) {
                const { error: adminUpsertError } = await supabase
                    .from("Admins")
                    .upsert({ id: existingUser.id }, { onConflict: "id" });

                if (adminUpsertError) {
                    throw adminUpsertError;
                }
                promotedExistingUser = true;
            }
        } catch (promotionError) {
            console.warn(`[addAdmins.js] Admin invitation was saved, but existing-user promotion failed for ${normalizedEmail}:`, promotionError.message);
            return res.status(500).json({
                error: "ADMIN_PROMOTION_FAILED",
                details: "The invitation was saved, but the existing user could not be granted admin access."
            });
        }

        // --- 3. Success Response ---
        return res.status(201).json({ 
            success: true, 
            message: promotedExistingUser
                ? `Successfully added ${normalizedEmail} to the admin invitation list and granted admin access to the existing user.`
                : `Successfully added ${normalizedEmail} to the admin invitation list.`,
            promotedExistingUser
        });

    } catch (err) {
        // --- 4. Error Handling ---
        console.error(`[addAdmins.js] Failed to add admin invitation for ${normalizedEmail}:`, err.message);
        
        // Provide a more specific error message if possible, otherwise generic.
        let statusCode = 500;
        let errorType = "SERVER_ERROR";
        let details = "Failed to process the admin invitation due to an internal server error.";
            
        return res.status(statusCode).json({ error: errorType, details: details });
    }
});

module.exports = router;
