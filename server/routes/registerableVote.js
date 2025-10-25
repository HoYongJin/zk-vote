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

        const { data: adminData, error: adminError } = await supabase
            .from("Admins")
            .select('id')
            .eq('id', user.id)
            .single();

        if (adminError && adminError.code !== 'PGRST116') {
            // 예측하지 못한 다른 DB 오류(연결 실패 등)는 catch 블록으로 던집니다.
            throw adminError;
        }    

        let query = supabase
            .from("Elections") // 테이블 이름이 'Elections' 또는 'Votes'인지 확인하세요.
            .select("id, name, candidates, contract_address, registration_end_time") // 필요한 컬럼 선택
            .lt('registration_start_time', now.toISOString()) // 필요 시 시간 제약 조건 추가
            .gt('registration_end_time', now.toISOString());


        if (!adminData) {
            // const { data: userVoterRecords, error: voterError } = await supabase
            //     .from('Voters')
            //     .select('election_id, user_id') // election_id와 user_id를 모두 선택
            //     .eq('email', user.email);

            // if (voterError) throw voterError;

            // // 만약 유권자 목록에 아예 없다면, 빈 배열을 반환합니다.
            // if (!userVoterRecords || userVoterRecords.length === 0) {
            //     return res.status(200).json([]);
            // }

            // // 2. 사용자가 유권자로 사전 등록된 모든 투표의 ID 목록을 만듭니다.
            // const preApprovedVoteIds = userVoterRecords.map(record => record.election_id);

            // // 3. 사용자가 등록 절차를 '완료'한 모든 투표의 ID 목록을 만듭니다.
            // //    (user_id가 null이 아닌 경우)
            // const completedVoteIds = new Set(
            //     userVoterRecords
            //         .filter(record => record.user_id !== null)
            //         .map(record => record.election_id)
            // );

            // // 4. 기본 쿼리에 '사전 등록된 투표'만 조회하도록 필터를 추가합니다.
            // query = query.in('id', preApprovedVoteIds);
            
            // // 5. 필터링된 쿼리를 실행합니다.
            // const { data: filteredElections, error } = await query;
            // if (error) throw error;

            // // 6. 최종 결과에 'isRegistered' 꼬리표를 추가하여 반환합니다.
            // const result = filteredElections.map(election => ({
            //     ...election,
            //     isRegistered: completedVoteIds.has(election.id)
            // }));
            
            // return res.status(200).json(result);
            // (유권자 로직)
            // 1. (수정) 필터링 없이 *모든* 등록 가능 투표를 먼저 조회
            const { data: allRegisterableElections, error: electionsError } = await query;
            if (electionsError) throw electionsError;

            // 2. (동일) 현재 유권자의 등록 상태를 별도로 조회
            const { data: userVoterRecords, error: voterError } = await supabase
                .from('Voters')
                .select('election_id, user_id')
                .eq('email', user.email);

            if (voterError) throw voterError;

            // 3. (동일) 유권자가 등록을 '완료'한 투표 ID Set을 생성
            const completedVoteIds = new Set(
                (userVoterRecords || []) // userVoterRecords가 null일 경우 대비
                    .filter(record => record.user_id !== null)
                    .map(record => record.election_id)
            );

            // 4. (수정) *모든* 투표 목록에 'isRegistered' 꼬리표를 추가
            const result = allRegisterableElections.map(election => ({
                ...election,
                isRegistered: completedVoteIds.has(election.id)
            }));

            return res.status(200).json(result);
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