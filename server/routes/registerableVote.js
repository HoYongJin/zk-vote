const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");

/**
 * @route   GET /elections/registerable
 * @desc    현재 유권자 등록이 가능한 모든 선거의 목록을 조회합니다.
 * @access  Public
 */
router.get("/", async (req, res) => {
    try {
        const now = new Date();

        // Elections 테이블에서 현재 시간이 등록 시작과 종료 시간 사이에 있는
        // 모든 선거를 조회합니다.
        const { data, error } = await supabase
            .from("Elections")
            .select("id, name, candidates") // 프론트엔드에 필요한 정보만 선택 (id, 이름, 등록 마감일 등)
            .lt('registration_start_time', now.toISOString()) // 등록 시작 시간이 현재보다 과거이고
            .gt('registration_end_time', now.toISOString());  // 등록 종료 시간이 현재보다 미래인

        if (error) {
            // Supabase 쿼리에서 오류가 발생한 경우
            throw error;
        }

        // 성공적으로 조회된 선거 목록을 반환합니다.
        res.status(200).json(data);

    } catch (err) {
        // 그 외 서버 내부 오류 처리
        console.error("등록 가능한 선거 조회 오류:", err.message);
        res.status(500).json({ error: "서버 오류가 발생했습니다." });
    }
});

module.exports = router;