/**
 * @file server/routes/me.js
 * @desc Role endpoint replacing the frontend's direct Supabase `Admins`
 * table read (architecture review AR-H4): admin gating must survive the
 * Cloud SQL migration, so the ACTIVE backend owns the role lookup. Pending
 * admin invitations are consumed by the auth middleware before this runs
 * (audit H5), so an invited user's first /me already reports is_admin=true.
 */

const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const auth = require("../middleware/auth");

/**
 * @route   GET /api/me
 * @returns {object} { id, email, is_admin }
 */
router.get("/", auth, async (req, res) => {
    try {
        const { data: admin, error } = await supabase
            .from("Admins")
            .select("id")
            .eq("id", req.user.id)
            .maybeSingle();

        if (error) {
            console.error(`[me.js] Admin lookup failed for ${req.user.id}:`, error.message);
            return res.status(500).json({
                error: "SERVER_ERROR",
                details: "Failed to resolve the user's role."
            });
        }

        return res.status(200).json({
            id: req.user.id,
            email: req.user.email || null,
            is_admin: Boolean(admin),
        });
    } catch (err) {
        console.error(`[me.js] Unexpected error:`, err.message);
        return res.status(500).json({
            error: "SERVER_ERROR",
            details: "Failed to resolve the user's role."
        });
    }
});

module.exports = router;
