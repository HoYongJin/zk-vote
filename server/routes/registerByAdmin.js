// const express = require("express");
// const router = express.Router();
// const supabase = require("../supabaseClient");
// const authAdmin = require("../middleware/authAdmin");

// // email: something + "@" + something + "." + somting --> 이 구조인지 확인
// const isValidEmail = (email) =>
//     typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

// // POST 요청 처리: 관리자가 유권자 이메일을 등록하는 API
// router.post("/", authAdmin, async (req, res) => {
//     // 클라이언트에서 보낸 이메일 배열 또는 단일 이메일 추출
//     let { emails, email } = req.body;

//     // 단일 이메일(email)이 있을 경우 emails 배열로 변환
//     if (!emails && email) {
//         emails = [email];
//     }

//     // emails가 존재하지 않거나 배열이 아닐 경우 요청 거부
//     if (!emails || !Array.isArray(emails)) {
//         return res.status(400).json({ error: "NEED email or emails as array" });
//     }

//     // 유효한 이메일만 필터링하고, 중복 제거
//     emails = [...new Set(emails.filter(isValidEmail))];

//     // 유효한 이메일이 하나도 없으면 요청 거부
//     if (emails.length === 0) {
//         return res.status(400).json({ error: "NO valid emails provided" });
//     }

//     try {
//         // 각 이메일에 대해 삽입할 DB 레코드 생성
//         const records = emails.map((email) => ({
//           email,                    // 유권자 이메일
//           name: null,               // 이름은 아직 입력되지 않음
//           id: null,                 // 로그인용 ID도 아직 없음
//           user_secret: null,        // ZKP 용 개인 비밀값도 아직 없음
//           voted: false              // 아직 투표하지 않은 상태로 초기화
//         }));

//         // Supabase를 통해 Voter 테이블에 레코드 삽입
//         // ignoreDuplicates: true → DB에 같은 이메일이 이미 있으면 새로 추가하지 않음
//         const { error } = await supabase
//             .from("Voter")
//             .insert(records, { ignoreDuplicates: true });

//         // 삽입 도중 오류가 발생하면 예외로 처리
//         if (error) throw error;

//         // 삽입 성공 시 클라이언트에 응답 반환
//         return res.status(201).json({
//             success: true,
//             emails // 등록된 유권자 이메일 목록
//         });
//     } catch (err) {
//         // 서버 에러 발생 시 로그 출력 및 응답 반환
//         console.error("ADMIN REGISTRATION FAIL:", err.message);
//         return res.status(500).json({ error: "REGISTRATION ERROR", details: err.message });
//     }
// });

// module.exports = router;

const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const authAdmin = require("../middleware/authAdmin"); // 1. 관리자 인증 미들웨어 가져오기

const isValidEmail = (email) =>
    typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

// 2. API 경로에 authAdmin 미들웨어를 적용
router.post("/", authAdmin, async (req, res) => {
    const originalEmails = req.body.emails || (req.body.email ? [req.body.email] : []);

    if (!Array.isArray(originalEmails) || originalEmails.length === 0) {
        return res.status(400).json({ error: "NEED email or emails as array" });
    }

    // 3. 상세한 결과 응답을 위한 객체
    const results = {
        newly_registered: [],
        duplicates_skipped: [],
        invalid_format_skipped: [],
    };

    const validEmails = new Set();
    for (const email of originalEmails) {
        if (isValidEmail(email)) {
            validEmails.add(email);
        } else {
            results.invalid_format_skipped.push(email);
        }
    }
    const uniqueValidEmails = Array.from(validEmails);

    if (uniqueValidEmails.length === 0) {
        return res.status(400).json({ error: "NO valid emails provided", details: results });
    }

    try {
        // 4. Voters 테이블에서 중복 이메일 미리 조회
        const { data: existingVoters, error: selectError } = await supabase
            .from("Voters") // <-- 조회 대상 테이블 변경
            .select("email")
            .in("email", uniqueValidEmails);

        if (selectError) throw selectError;

        const existingEmails = new Set(existingVoters.map(v => v.email));

        const emailsToInsert = [];
        for (const email of uniqueValidEmails) {
            if (existingEmails.has(email)) {
                results.duplicates_skipped.push(email);
            } else {
                emailsToInsert.push(email);
            }
        }

        if (emailsToInsert.length > 0) {
            const recordsToInsert = emailsToInsert.map(email => ({ email }));

            // 5. 대규모 데이터를 위한 배치(Batch) 처리
            const BATCH_SIZE = 500;
            for (let i = 0; i < recordsToInsert.length; i += BATCH_SIZE) {
                const batch = recordsToInsert.slice(i, i + BATCH_SIZE);
                
                const { error: insertError } = await supabase
                    .from("Voters") // <-- 삽입 대상 테이블 변경
                    .insert(batch);
                
                if (insertError) throw insertError;
            }
            results.newly_registered = emailsToInsert;
        }

        // 6. 관리자가 보기 편하도록 상세한 결과 반환
        return res.status(201).json({
            success: true,
            summary: {
                newly_registered_count: results.newly_registered.length,
                duplicates_skipped_count: results.duplicates_skipped.length,
                invalid_format_skipped_count: results.invalid_format_skipped.length,
            },
            details: results
        });

    } catch (err) {
        console.error("ADMIN REGISTRATION FAIL:", err.message);
        return res.status(500).json({ error: "REGISTRATION ERROR", details: err.message });
    }
});

module.exports = router;