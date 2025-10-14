const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const auth = require("../middleware/auth");

/**
 * @route   GET /api/finalizedVote
 * @desc    로그인한 사용자가 참여 가능한 (투표가 시작된) 선거 목록을 조회합니다. 관리자는 모든 투표를 조회합니다.
 * @access  Private (로그인 필요)
 */
router.get("/", auth, async (req, res) => { 
    try {
        const user = req.user; 
        const now = new Date();

        // 1. 현재 사용자가 관리자인지 확인합니다.
        const { data: adminData } = await supabase
            .from("Admins")
            .select('id')
            .eq('id', user.id)
            .single();

        if (adminError && adminError.code !== 'PGRST116') {
            // 예측하지 못한 다른 DB 오류(연결 실패 등)는 catch 블록으로 던집니다.
            throw adminError;
        } 

        // 2. 'finalized'된 선거를 찾는 기본 쿼리를 생성합니다.
        //    - Merkle Root가 설정되어 있어야 함 (등록 마감)
        //    - 투표 시작 시간이 현재보다 과거여야 함 (투표 시작)
        //    - 투표 종료 시간이 현재보다 미래여야 함 (투표 진행 중)
        let query = supabase
            .from("Elections")
            .select("id, name, candidates, voting_end_time, contract_address") // 프론트엔드에 필요한 정보
            .lt('voting_start_time', now.toISOString())
            .gt('voting_end_time', now.toISOString());

        // 3. 일반 유저인 경우, 자신이 등록된 선거만 보도록 필터링합니다.
        if (!adminData) {
            const { data: finalizedVotes, error: voterError } = await supabase
                .from('Voters')
                .select('election_id')
                .eq('email', user.email);

            if (voterError) throw voterError;

            // 등록된 선거가 없으면 빈 배열을 반환합니다.
            if (!finalizedVotes || finalizedVotes.length === 0) {
                return res.status(200).json([]);
            }

            const electionIds = finalizedVotes.map(v => v.election_id);

            // 기본 쿼리에 내가 등록된 선거 ID 필터를 추가합니다.
            query = query.in('id', electionIds);
        }

        // 4. 최종 쿼리를 실행합니다.
        const { data, error } = await query;

        if (error) throw error;

        res.status(200).json(data);

    } catch (err) {
        console.error("투표 가능한 선거 조회 오류:", err.message);
        res.status(500).json({ error: "서버 오류가 발생했습니다." });
    }
});

module.exports = router;