const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
// user_secret을 받아 merkle_data에 해당 정보(Leaf)가 있으면 Merkle Proof 생성 후 반환하는 함수
const { generateMerkleProof } = require("../utils/merkle"); 

// Merkle Proof를 생성하여 클라이언트에 반환하는 API
router.post("/", async (req, res) => {
    // Authorization 헤더에서 Bearer 토큰 추출
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

    // 클라이언트 요청에서 user_secret 추출
    const { user_secret } = req.body;

    // Token 유뮤 확인
    if(!token) {
        return res.status(400).json({ error: "NO TOKEN INFORMATION"});
    }

    // 입력값(user_secret) 유무 확인
    if(!user_secret) {
        return res.status(400).json({ error: "NO USER_SECRET INFORMATION"});
    }

    // Supabase 토큰 인증 처리 후 유효하다면 user 정보를 얻음
    let user;
    try {
        const result = await supabase.auth.getUser(token);
        user = result.data.user;
        if (!user) throw new Error("USER NOT FOUND");
    } catch (authError) {
        return res.status(401).json({ error: "INVALID TOKEN", details: authError.message });
    }

    // user 정보 중 email 정보를 추출
    const email = user.email;

    // Voter 테이블에서 해당 이메일, user_secret 모두 일치하는 유저를 찾음
    const { data: voter, error } = await supabase
        .from("Voter")
        .select("*")
        .eq("email", email)
        .eq("user_secret", user_secret)
        .maybeSingle();

    // 서버 에러 발생 시 로그 출력 및 응답 반환
    if (error) {
        console.error("DB ERROR: ", error.message);
        return res.status(500).json({ error: "DATABASE ERROR" });
    }

    // 등록된 유저가 아닌 경우 에러 발생
    if (!voter) {
        return res.status(403).json({ error: "NOT REGISTERED USER" });
    }

    try {
        // Merkle Tree에서 증명 생성
        const { leaf, root, path_elements, path_index } = await generateMerkleProof(user_secret);

        // 클라이언트에 Merkle 증명 반환
        return res.json({ 
            leaf,                   // user_secret으로부터 생성된 해시 leaf
            merkle_root: root,      // merkle_data(leaves)로 만들어진 Merkle Tree의 최상위 루트 해시
            path_elements,          // pathElements: 해당 leaf에서 root까지 올라가는 경로에 있는 형제 노드들의 값
            path_index              // pathIndices: 각 레벨에서 본인이 왼쪽(0)인지 오른쪽(1)인지 표시
        });
    } catch (err) {
        // 증명 생성 중 오류 발생
        console.error("PROOF ERROR:", err.message);
        return res.status(500).json({ error: "FAILED TO GENERATE MERKLE PROOF", details: err.message });
    }
});

module.exports = router;