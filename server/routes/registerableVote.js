// const express = require("express");
// const router = express.Router();
// const supabase = require("../supabaseClient");

// /**
//  * @route   GET /elections/registerable
//  * @desc    현재 유권자 등록이 가능한 모든 선거의 목록을 조회합니다.
//  * @access  Public
//  */
// router.get("/", async (req, res) => {
//     try {
//         const now = new Date();

//         // Elections 테이블에서 현재 시간이 등록 시작과 종료 시간 사이에 있는
//         // 모든 선거를 조회합니다.
//         const { data, error } = await supabase
//             .from("Elections")
//             .select("id, name, candidates") // 프론트엔드에 필요한 정보만 선택 (id, 이름, 등록 마감일 등)
//             .lt('registration_start_time', now.toISOString()) // 등록 시작 시간이 현재보다 과거이고
//             .gt('registration_end_time', now.toISOString());  // 등록 종료 시간이 현재보다 미래인

//         if (error) {
//             // Supabase 쿼리에서 오류가 발생한 경우
//             throw error;
//         }

//         // 성공적으로 조회된 선거 목록을 반환합니다.
//         res.status(200).json(data);

//     } catch (err) {
//         // 그 외 서버 내부 오류 처리
//         console.error("등록 가능한 선거 조회 오류:", err.message);
//         res.status(500).json({ error: "서버 오류가 발생했습니다." });
//     }
// });

// module.exports = router;

const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const auth = require("../middleware/auth");

/**
 * @route   GET /api/registerableVote
 * @desc    로그인한 사용자가 참여 가능한 투표 목록을 조회합니다. 관리자는 모든 투표를 조회합니다.
 * @access  Private (로그인 필요)
 */
router.get("/", auth, async (req, res) => { 
    try {
        const user = req.user; 
        const now = new Date();

        const { data: adminData } = await supabase
            .from("Admins")
            .select('id')
            .eq('id', user.id)
            .single();

        let query = supabase
            .from("Elections") // 테이블 이름이 'Elections' 또는 'Votes'인지 확인하세요.
            .select("id, name, candidates, registration_end_time") // 필요한 컬럼 선택
            .eq('merkle_root', null) // 마감되지 않은 투표만 조회
            .lt('registration_start_time', now.toISOString()) // 필요 시 시간 제약 조건 추가
            .gt('registration_end_time', now.toISOString());

        if (!adminData) {
            // 'voters' 테이블에서 현재 유저가 등록된 모든 vote_id를 가져옵니다.
            const { data: registeredVotes, error: voterError } = await supabase
                .from('Voters')
                .select('election_id')
                .eq('user_id', user.id);

            if (voterError) throw voterError;

            // 만약 등록된 투표가 하나도 없다면, 빈 배열을 반환하고 종료
            if (!registeredVotes || registeredVotes.length === 0) {
                return res.status(200).json([]);
            }

            // [ { vote_id: 1 }, { vote_id: 3 } ] 형태의 데이터를 [1, 3] 형태로 변환
            const voteIds = registeredVotes.map(v => v.election_id);

            // 준비된 쿼리에 필터 조건을 추가합니다.
            query = query.in('id', voteIds);
        }

        // 6. 최종 쿼리 실행
        const { data, error } = await query;

        if (error) throw error;

        res.status(200).json(data);

    } catch (err) {
        console.error("등록 가능한 투표 조회 오류:", err.message);
        res.status(500).json({ error: "서버 오류가 발생했습니다." });
    }
});

module.exports = router;