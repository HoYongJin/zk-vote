const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const authAdmin = require("../middleware/authAdmin"); // 기존 관리자 인증 미들웨어

// POST /admins/invite
// 역할: 새로운 관리자를 초대 명단(AdminInvitations)에 추가
router.post("/", authAdmin, async (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ error: "Email is required." });
    }

    try {
        // 초대 명단에 이메일 추가 (이미 존재하면 무시)
        const { error } = await supabase
            .from("AdminInvitations")
            .insert({ email }, { upsert: true });

        if (error) throw error;

        return res.status(201).json({ success: true, message: `Successfully invited ${email} to become an admin.` });

    } catch (err) {
        console.error("Admin invitation failed:", err.message);
        return res.status(500).json({ error: "Failed to invite admin.", details: err.message });
    }
});

module.exports = router;