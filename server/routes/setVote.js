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
        voteEndTime,
        contractAddress
    } = req.body;

    // 1. 입력 값 유효성 검사 (생략)
    if (!name || !merkleTreeDepth || !candidates) {
        return res.status(400).json({ error: "필수 정보가 누락되었습니다." });
    }

    try {
        // 2. DB에 새로운 선거 정보 저장
        const { data, error } = await supabase
            .from("Elections")
            .insert([{
                name: name,
                merkle_tree_depth: merkleTreeDepth,
                candidates: candidates,
                registration_start_time: regStartTime,
                registration_end_time: regEndTime,
                voting_start_time: voteStartTime,
                voting_end_time: voteEndTime,
                //contract_address: contractAddress
            }])
            .select();

        if (error) throw error;

        // MerkleState 테이블에 해당 선거를 위한 빈 상태(state)를 미리 생성합니다.
        const { error: merkleError } = await supabase
        .from("MerkleState")
        .insert({
            election_id: data[0].id,
            merkle_data: { leaves: [] }
        });

        if (merkleError) throw merkleError;

        // 3. (선택적) 스마트 컨트랙트의 시간 설정 함수도 여기서 호출 가능
        // const tx = await votingTallyContract.setVotingPeriod(voteStartTime, voteEndTime);
        // await tx.wait();

        res.status(201).json({
            success: true,
            message: "새로운 선거가 성공적으로 생성되었습니다.",
            election: data[0]
        });

    } catch (err) {
        console.error("선거 생성 오류:", err.message);
        return res.status(500).json({ error: "서버 오류가 발생했습니다." });
    }
});

module.exports = router;