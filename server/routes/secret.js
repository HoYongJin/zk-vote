// const express = require("express");
// const router = express.Router();
// const supabase = require("../supabaseClient");

// // 사용자 인증 토큰을 기반으로 user_secret을 조회하여 반환하는 API
// router.post("/", async (req, res) => {
//     // Authorization 헤더에서 Bearer 토큰 추출
//     const authHeader = req.headers.authorization || "";
//     const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

//     // Token 유뮤 확인
//     if(!token) {
//         return res.status(400).json({ error: "NO TOKEN INFORMATION"});
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

//     // Voter 테이블에서 해당 이메일과 일치하는 유저의 user_secret 조회
//     const { data: voter } = await supabase
//         .from("Voter")
//         .select("user_secret")
//         .eq("email", email)
//         .maybeSingle();

//     // 등록되지 않은 email인 경우 에러 발생
//     if (!voter) {
//         return res.status(403).json({ error: "EMAIL NOT REGISTERED BY ADMIN" });
//     }

//     // user_secret 미등록인 경우 등록되지 않은 사용자로 간주
//     if (!voter.user_secret) {
//         return res.status(403).json({ error: "NOT REGISTERED(NO USER_SECRET" });
//     }


//     //console.log(`user_secret 전달: ${email} @ ${new Date().toISOString()}`);

//     // 클라이언트에 응답 반환
//     return res.status(200).json({
//         success: true,
//         user_secret: voter.user_secret
//     });
// });


// module.exports = router;
