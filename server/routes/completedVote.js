const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const auth = require("../middleware/auth");

/**
 * @route   GET /api/elections/completed
 * @desc    종료된 투표 목록을 조회합니다. 관리자는 모든 목록을, 유권자는 자신이 참여한 목록만 조회합니다.
 * @access  Private
 */
router.get("/", auth, async (req, res) => {
    try {
        const user = req.user;

        // 1. 관리자인지 확인합니다.
        const { data: adminData } = await supabase
            .from("Admins")
            .select('id')
            .eq('id', user.id)
            .single();

        // 2. 'completed'가 true인 모든 선거를 가져오는 기본 쿼리를 준비합니다.
        let query = supabase
            .from("Elections")
            .select("id, name, candidates, voting_end_time, contract_address") // 종료된 투표에 필요한 정보만 선택
            .eq('completed', true);

        // 3. 관리자가 아닐 경우, 해당 유권자가 참여했던 투표만 필터링합니다.
        if (!adminData) {
            const { data: voterRecords, error: voterError } = await supabase
                .from('Voters')
                .select('election_id')
                .eq('user_id', user.id); // user_id로 찾는 것이 더 정확합니다.

            if (voterError) throw voterError;
            if (!voterRecords || voterRecords.length === 0) {
                return res.status(200).json([]);
            }

            const electionIds = voterRecords.map(record => record.election_id);
            query = query.in('id', electionIds);
        }

        // 4. 최종 쿼리를 실행하고 결과를 반환합니다.
        const { data, error } = await query;
        if (error) throw error;
        res.status(200).json(data);

    } catch (err) {
        console.error("종료된 투표 조회 오류:", err.message);
        res.status(500).json({ error: "서버 오류가 발생했습니다." });
    }
});

module.exports = router;