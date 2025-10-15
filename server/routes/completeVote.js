// server/routes/completeVote.js
const express = require("express");
const router = express.Router({ mergeParams: true });
const supabase = require("../supabaseClient");
const authAdmin = require("../middleware/authAdmin");

/**
 * @route   POST /api/elections/:election_id/complete
 * @desc    (관리자) 특정 선거를 '완료' 상태로 변경합니다.
 * @access  Admin
 */
router.post("/", authAdmin, async (req, res) => {
    const { election_id } = req.params;

    try {
        const { error } = await supabase
            .from("Elections")
            .update({ completed: true })
            .eq("id", election_id);

        if (error) throw error;

        res.status(200).json({ success: true, message: "선거가 성공적으로 종료(완료) 처리되었습니다." });

    } catch (err) {
        console.error(`선거 완료 처리 오류 (ID: ${election_id}):`, err.message);
        res.status(500).json({ error: "서버 오류가 발생했습니다." });
    }
});

module.exports = router;