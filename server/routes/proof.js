const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const { generateMerkleProof } = require("../utils/merkle");

// [수정됨] Merkle Proof를 생성하여 클라이언트에 반환하는 API
// 이제 클라이언트로부터 user_secret을 받지 않습니다.
router.post("/", async (req, res) => {
    console.log("[1] /proof API handler started.");

    // 1. JWT 토큰으로 사용자 인증
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) {
        return res.status(401).json({ error: "AUTHENTICATION_REQUIRED" });
    }

    let user;
    try {
        const { data: { user: authUser }, error } = await supabase.auth.getUser(token);
        if (error || !authUser) {
            throw new Error("Invalid or expired token.");
        }
        user = authUser;
    } catch (authError) {
        return res.status(401).json({ error: "INVALID_TOKEN", details: authError.message });
    }

    try {
        console.log("[2] Attempting to fetch user_secret from DB...");

        // 2. 'Voters' 테이블에서 인증된 사용자의 user_secret을 직접 조회
        const { data: voter, error } = await supabase
            .from("Voters")
            .select("user_secret")
            .eq("user_id", user.id) // email 대신 user_id로 조회하는 것이 더 정확
            .single(); // .single()은 결과가 없거나 1개 이상이면 오류를 반환

        if (error) throw error;

        // 2-1. user_secret이 없는 경우 (최종 등록을 완료하지 않음)
        if (!voter.user_secret) {
            return res.status(403).json({ error: "Voter has not completed registration." });
        }
        
        console.log("[3] Attempting to generate Merkle proof...");

        // 3. DB에서 가져온 user_secret으로 바로 Merkle 증명 생성
        const proofData = await generateMerkleProof(voter.user_secret);

        // 4. 클라이언트에 Merkle 증명 반환
        return res.status(200).json({
            success: true,
            ...proofData // leaf, root, path_elements, path_index 포함
        });

    } catch (err) {
        // .single()에서 행을 찾지 못하면 PostgrestError가 발생
        if (err.code === 'PGRST116') {
             console.error("Proof generation failed: User not found in Voters table.", err.message);
            return res.status(403).json({ error: "User is not a registered voter." });
        }
        console.error("PROOF_GENERATION_ERROR:", err.message);
        return res.status(500).json({ error: "Failed to generate Merkle proof.", details: err.message });
    }
});

module.exports = router;

// try {
    //     // Merkle Tree에서 증명 생성
    //     const { leaf, root, path_elements, path_index } = await generateMerkleProof(user_secret);

    //     // 클라이언트에 Merkle 증명 반환
    //     return res.json({ 
    //         leaf,                   // user_secret으로부터 생성된 해시 leaf
    //         merkle_root: root,      // merkle_data(leaves)로 만들어진 Merkle Tree의 최상위 루트 해시
    //         path_elements,          // pathElements: 해당 leaf에서 root까지 올라가는 경로에 있는 형제 노드들의 값
    //         path_index              // pathIndices: 각 레벨에서 본인이 왼쪽(0)인지 오른쪽(1)인지 표시
    //     });
    // } catch (err) {
    //     // 증명 생성 중 오류 발생
    //     console.error("PROOF ERROR:", err.message);
    //     return res.status(500).json({ error: "FAILED TO GENERATE MERKLE PROOF", details: err.message });
    // }