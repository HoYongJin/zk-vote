// const express = require("express");
// const router = express.Router();
// const supabase = require("../supabaseClient");
// const authAdmin = require("../middleware/authAdmin");

// router.post("/", authAdmin, async (req, res) => {
//     const {
//         name,
//         merkleTreeDepth,
//         candidates,
//         regStartTime,
//         regEndTime,
//         voteStartTime,
//         voteEndTime
//     } = req.body;

//     // 1. 입력 값 유효성 검사 (생략)
//     if (!name || !merkleTreeDepth || !candidates) {
//         return res.status(400).json({ error: "필수 정보가 누락되었습니다." });
//     }

//     try {
//         // 2. DB에 새로운 선거 정보 저장
//         const { data, error } = await supabase
//             .from("Elections")
//             .insert([{
//                 name: name,
//                 merkle_tree_depth: merkleTreeDepth,
//                 candidates: candidates,
//                 registration_start_time: regStartTime,
//                 registration_end_time: regEndTime,
//                 voting_start_time: voteStartTime,
//                 voting_end_time: voteEndTime,
//             }])
//             .select();

//         if (error) throw error;

//         // MerkleState 테이블에 해당 선거를 위한 빈 상태(state)를 미리 생성합니다.
//         const { error: merkleError } = await supabase
//         .from("MerkleState")
//         .insert({
//             election_id: data.id,
//             merkle_data: { leaves: [] }
//         });

//         if (merkleError) throw merkleError;

//         res.status(201).json({
//             success: true,
//             message: "새로운 선거가 성공적으로 생성되었습니다.",
//             election: data[0]
//         });

//     } catch (err) {
//         console.error("선거 생성 오류:", err.message);
//         return res.status(500).json({ error: "서버 오류가 발생했습니다." });
//     }
// });

// module.exports = router;

const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const authAdmin = require("../middleware/authAdmin");

router.post("/", authAdmin, async (req, res) => {
    const {
        name,
        merkleTreeDepth,
        candidates,
        regStartTime,
        regEndTime,
        voteStartTime,
        voteEndTime
    } = req.body;

    if (!name || !merkleTreeDepth || !candidates) {
        return res.status(400).json({ error: "필수 정보가 누락되었습니다." });
    }

    try {
        // 1. DB에 새로운 선거 정보 저장하고, 결과를 단일 객체로 받음
        const { data: electionData, error: electionError } = await supabase
            .from("Elections")
            .insert([{
                name: name,
                merkle_tree_depth: merkleTreeDepth,
                candidates: candidates,
                registration_start_time: regStartTime,
                registration_end_time: regEndTime,
                voting_start_time: voteStartTime,
                voting_end_time: voteEndTime,
            }])
            .select()
            .single(); // .single()을 사용하여 결과를 배열이 아닌 단일 객체로 받습니다.

        if (electionError) throw electionError;

        // --- ▼ [핵심 수정] 반환된 데이터가 유효한지 확인 ▼ ---
        if (!electionData || !electionData.id) {
            console.error("Elections 테이블 insert 후 데이터 반환 실패. RLS 정책을 확인하세요.");
            return res.status(500).json({ error: "선거를 생성했지만, 생성된 정보를 가져올 수 없습니다." });
        }
        // --- ▲ [핵심 수정] 여기까지 ▲ ---

        // 2. MerkleState 테이블에 빈 상태를 미리 생성
        const { error: merkleError } = await supabase
            .from("MerkleState")
            .insert({
                election_id: electionData.id, // 이제 electionData.id는 유효한 UUID 값임
                merkle_data: { leaves: [] }
            });

        if (merkleError) throw merkleError;

        res.status(201).json({
            success: true,
            message: "새로운 선거가 성공적으로 생성되었습니다.",
            election: electionData
        });

    } catch (err) {
        console.error("선거 생성 오류:", err.message);
        return res.status(500).json({ error: "서버 오류가 발생했습니다." });
    }
});

module.exports = router;