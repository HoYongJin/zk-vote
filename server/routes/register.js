const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const crypto = require("crypto");
const { addUserSecret } = require("../utils/merkle");
require("dotenv").config();

// user_secret 생성 함수 (입력값으로 서버에서 인증된 userId를 받음)
const generateUserSecret = (userId) => {
    if (!process.env.SECRET_SALT) {
        throw new Error("SECRET_SALT environment variable is not defined.");
    }
    const seed = userId + process.env.SECRET_SALT;
    const hash = crypto.createHash("sha256").update(seed).digest("hex");
    return BigInt("0x" + hash).toString();
};

router.post("/", async (req, res) => {
    // 1. JWT 토큰 추출 및 기본적인 유효성 검사
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) {
        return res.status(401).json({ error: "AUTHENTICATION_REQUIRED" });
    }

    // 2. 클라이언트로부터 'name'만 받음 (id는 받지 않음!)
    const { name, election_id } = req.body;
    if (!name) {
        return res.status(400).json({ error: "Name is a required field." });
    }
    if (!election_id) {
        return res.status(400).json({ error: "Election_id is a required field." });
    }

    let user;
    try {
        // 3. 토큰을 사용하여 Supabase에서 사용자 정보 안전하게 가져오기
        const { data: { user: authUser }, error } = await supabase.auth.getUser(token);
        if (error || !authUser) {
            throw new Error("Invalid or expired token.");
        }
        user = authUser; // user 변수에는 이제 서버가 인증한 사용자 정보가 담김
    } catch (authError) {
        return res.status(401).json({ error: "INVALID_TOKEN", details: authError.message });
    }

    try {
        const { data: election, error:electionError } = await supabase 
            .from("Elections")
            .select("id, registration_start_time, registration_end_time")
            .eq("id", election_id)
            .single()

        if(electionError || !election) {
            return res.status(404).json({ error: "Unavailable vote"});
        }

        const now = new Date();
        if(now < new Date(election.registration_start_time && now > new Date(election.registration_end_time))) {
            return res.status(403).json({ error: "Not registeraion period"});
        }

        // 4. 'Voters' 테이블에서 관리자가 등록한 유권자 명단에 해당 이메일이 있는지 확인
        const { data: voter, error: selectError } = await supabase
            .from("Voters") // <-- 조회할 테이블을 'Voters'로 변경
            .select("*")
            .eq("email", user.email)
            .eq("election_id", election_id)
            .maybeSingle();

        if (selectError) throw selectError;

        // 4-1. 명단에 없는 경우
        if (!voter) {
            return res.status(403).json({ error: "This email is not on the voter registration list." });
        }

        // 4-2. 이미 다른 계정과 연결(등록)된 경우
        if (voter.user_id) {
            return res.status(409).json({ error: "This voter has already completed the registration." });
        }

        // 5. 서버에서 인증된 'user.id'를 사용하여 안전하게 user_secret 생성
        const user_secret = generateUserSecret(user.id);

        // 6. 'Voters' 테이블 업데이트: 인증된 계정(user_id)을 연결하고, 이름과 비밀키 저장
        const { error: updateError } = await supabase
            .from("Voters") // <-- 업데이트할 테이블을 'Voters'로 변경
            .update({
                name: name,
                user_id: user.id, // <-- 핵심: 인증된 id로 계정 연결
                user_secret: user_secret
            })
            .eq("email", user.email);

        if (updateError) throw updateError;

        // 7. Merkle Tree에 새로 생성된 secret 추가
        await addUserSecret(election_id, user_secret);

        // 8. 성공 응답 반환
        return res.status(201).json({
            success: true,
            message: "Voter registration completed successfully."
        });

    } catch (err) {
        console.error("VOTER REGISTRATION FAILED:", err.message);
        return res.status(500).json({ error: "REGISTRATION_PROCESS_ERROR", details: err.message });
    }
});

module.exports = router;