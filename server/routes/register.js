// const express = require("express");
// const router = express.Router();
// const supabase = require("../supabaseClient");
// const crypto = require("crypto");
// const { addUserSecret } = require("../utils/merkle");
// require("dotenv").config();

// // user_secret을 생성하는 함수
// const generateUserSecret = (id) => {
//     // 환경 변수 확인
//     if (!process.env.SECRET_SALT) {
//         throw new Error("SECRET_SALT NOT DEFINED");
//     }

//     // SHA256 해시 생성 및 BigInt 변환
//     const seed = id + process.env.SECRET_SALT;
//     const hash = crypto.createHash("sha256").update(seed).digest("hex");
//     return BigInt("0x" + hash).toString();
// };

// // POST 요청 처리: 유권자가 본인 인증 후 name, id을 설정하고 user_secret을 생성해주는 API
// router.post("/", async (req, res) => {
//     // Authorization 헤더에서 Bearer 토큰 추출
//     const authHeader = req.headers.authorization || "";
//     const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

//     // 클라이언트 요청에서 name, id 추출
//     const { name, id } = req.body;

//     // Token 유뮤 확인
//     if(!token) {
//         return res.status(400).json({ error: "NO TOKEN INFORMATION"});
//     }

//     // 입력값(name, id) 유무 확인
//     if (!name || !id) {
//         return res.status(400).json({ error: "NEED NAME AND EMAIL" });
//     }

//     // Supabase 토큰 인증 처리 후 유효하다면 user 정보를 얻음
//     let user;
//     try {
//         const result = await supabase.auth.getUser(token);
//         user = result.data.user;
//         if (!user) throw new Error("USER NOT FOUND");
//     } catch (authError) {
//         return res.status(401).json({ error: "INVALID TOKEN", details: authError.message });
//     }

//     // user 정보 중 email 정보를 추출
//     const email = user.email;

//     // 관리자에 의해 사전 등록된 이메일인지 확인
//     const { data: voter, error } = await supabase
//         .from("Voter")
//         .select("*")
//         .eq("email", email)
//         .maybeSingle();

//     // 서버 에러 발생 시 로그 출력 및 응답 반환
//     if (error) {
//         console.error("DB ERROR: ", error.message);
//         return res.status(500).json({ error: "DATABASE ERROR" });
//     }

//     // 관리자에 의해 등록된 유저가 아닌 경우 에러 발생
//     if (!voter) {
//         return res.status(403).json({ error: "EMAIL NOT REGISTERED BY ADMIN" });
//     }

//     // 이미 등록을 완료한 유권자라면 애러 발생
//     if (voter.user_secret) {
//         return res.status(409).json({ error: "ALREADY REGISTERED" });
//     }

//     try {
//         // 유권자 고유의 user_secret 생성
//         const user_secret = generateUserSecret(id);

//         // Voter 정보 업데이트
//         const { error: updateErr } = await supabase
//             .from("Voter")
//             .update({
//                 name,
//                 id,
//                 voted: false,
//                 user_secret
//             })
//             .eq("email", email);

//         // 업데이트 도중 오류 발생하면 예외로 처리
//         if (updateErr) throw updateErr;

//         // Merkle Tree에 추가
//         await addUserSecret(user_secret);

//         // 업데이트 성공 시 클라이언트에 응답 반환
//         return res.status(201).json({ success: true, email });
//     } catch (err) {
//         // 서버 에러 발생 시 로그 출력 및 응답 반환
//         console.error("REGISTER FAIL:", err.message);
//         return res.status(500).json({ error: "REGISTER ERROR", details: err.message });
//     }
// });

// module.exports = router;

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
    const { name } = req.body;
    if (!name) {
        return res.status(400).json({ error: "Name is a required field." });
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
        // 4. 'Voters' 테이블에서 관리자가 등록한 유권자 명단에 해당 이메일이 있는지 확인
        const { data: voter, error: selectError } = await supabase
            .from("Voters") // <-- 조회할 테이블을 'Voters'로 변경
            .select("*")
            .eq("email", user.email)
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
        await addUserSecret(user_secret);

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