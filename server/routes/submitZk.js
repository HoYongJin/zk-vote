const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const { ethers } = require("ethers");

// VotingTally 컨트랙트의 ABI (artifacts 폴더 경로에 맞게 수정)
const votingTallyAbi = require("../../artifacts/contracts/VotingTally.sol/VotingTally.json").abi;

/**
 * @route   POST /submitZk
 * @desc    ZK 증명과 함께 최종 투표를 스마트 컨트랙트에 제출합니다.
 * @access  Private (JWT 인증 필요)
 * @body    { 
 * "election_id": "...", 
 * "proof": { "a": [...], "b": [[...],[...]], "c": [...] },
 * "publicSignals": [...]
 * }
 */
router.post("/", async (req, res) => {
    // 1. JWT 토큰으로 사용자 인증
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) {
        return res.status(401).json({ error: "인증 토큰이 필요합니다." });
    }

    let user;
    try {
        const { data: { user: authUser }, error } = await supabase.auth.getUser(token);
        if (error || !authUser) throw new Error("유효하지 않은 토큰입니다.");
        user = authUser;
    } catch (authError) {
        return res.status(401).json({ error: "인증에 실패했습니다.", details: authError.message });
    }

    // 2. Body에서 투표 정보와 ZK 증명 데이터 받기
    const { election_id, proof, publicSignals } = req.body;
    if (!election_id || !proof || !publicSignals) {
        return res.status(400).json({ error: "선거 ID, ZK 증명(proof), 공개 신호(publicSignals)는 필수 항목입니다." });
    }

    try {
        // 3. 선거 정보 조회 (컨트랙트 주소, 투표 기간 등)
        const { data: election, error: electionError } = await supabase
            .from("Elections")
            .select("contract_address, voting_start_time, voting_end_time, merkle_root")
            .eq("id", election_id)
            .single();

        if (electionError || !election) {
            return res.status(404).json({ error: "존재하지 않는 선거입니다." });
        }

        // 4. 투표 가능 상태 확인
        if (!election.contract_address || !election.merkle_root) {
            return res.status(403).json({ error: "아직 투표가 시작되지 않았습니다. (관리자 최종 승인 전)" });
        }
        const now = new Date();
        if (now < new Date(election.voting_start_time) || now > new Date(election.voting_end_time)) {
            return res.status(403).json({ error: "현재 투표 기간이 아닙니다." });
        }

        // 5. 스마트 컨트랙트와 연결하여 submitTally 함수 호출
        const provider = new ethers.providers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
        const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
        const votingTally = new ethers.Contract(election.contract_address, votingTallyAbi, wallet);

        console.log(`Submitting vote for election ${election_id}...`);

        // ZK 증명 데이터를 컨트랙트 함수 인자에 맞게 재구성
        const { a, b, c } = proof;
        const input = publicSignals;

        const tx = await votingTally.submitTally(a, b, c, input);
        const receipt = await tx.wait();

        return res.status(200).json({
            success: true,
            message: "투표가 성공적으로 제출되었습니다.",
            transactionHash: receipt.transactionHash
        });

    } catch (err) {
        console.error("투표 제출 실패:", err.message);
        
        // 스마트 컨트랙트 revert 메시지 파싱 (더 친절한 에러 메시지 제공)
        let reason = "알 수 없는 오류가 발생했습니다. 잠시 후 다시 시도해주세요.";
        if (err.reason) {
            reason = err.reason;
        } else if (err.data && err.data.message) {
            reason = err.data.message;
        }

        return res.status(500).json({ 
            error: "투표 제출 중 온체인 오류가 발생했습니다.", 
            details: reason 
        });
    }
});

module.exports = router;