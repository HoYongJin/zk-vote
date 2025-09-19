// const express = require("express");
// const router = express.Router();
// const supabase = require("../supabaseClient");
// const authAdmin = require("../middleware/authAdmin"); // 1. 관리자 인증 미들웨어 가져오기

// const isValidEmail = (email) =>
//     typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

// // 2. API 경로에 authAdmin 미들웨어를 적용
// router.post("/", authAdmin, async (req, res) => {
//     const originalEmails = req.body.emails || (req.body.email ? [req.body.email] : []);

//     if (!Array.isArray(originalEmails) || originalEmails.length === 0) {
//         return res.status(400).json({ error: "NEED email or emails as array" });
//     }

//     // 3. 상세한 결과 응답을 위한 객체
//     const results = {
//         newly_registered: [],
//         duplicates_skipped: [],
//         invalid_format_skipped: [],
//     };

//     const validEmails = new Set();
//     for (const email of originalEmails) {
//         if (isValidEmail(email)) {
//             validEmails.add(email);
//         } else {
//             results.invalid_format_skipped.push(email);
//         }
//     }
//     const uniqueValidEmails = Array.from(validEmails);

//     if (uniqueValidEmails.length === 0) {
//         return res.status(400).json({ error: "NO valid emails provided", details: results });
//     }

//     try {
//         // 4. Voters 테이블에서 중복 이메일 미리 조회
//         const { data: existingVoters, error: selectError } = await supabase
//             .from("Voters") // <-- 조회 대상 테이블 변경
//             .select("email")
//             .in("email", uniqueValidEmails);

//         if (selectError) throw selectError;

//         const existingEmails = new Set(existingVoters.map(v => v.email));

//         const emailsToInsert = [];
//         for (const email of uniqueValidEmails) {
//             if (existingEmails.has(email)) {
//                 results.duplicates_skipped.push(email);
//             } else {
//                 emailsToInsert.push(email);
//             }
//         }

//         if (emailsToInsert.length > 0) {
//             const recordsToInsert = emailsToInsert.map(email => ({ email }));

//             // 5. 대규모 데이터를 위한 배치(Batch) 처리
//             const BATCH_SIZE = 500;
//             for (let i = 0; i < recordsToInsert.length; i += BATCH_SIZE) {
//                 const batch = recordsToInsert.slice(i, i + BATCH_SIZE);
                
//                 const { error: insertError } = await supabase
//                     .from("Voters") // <-- 삽입 대상 테이블 변경
//                     .insert(batch);
                
//                 if (insertError) throw insertError;
//             }
//             results.newly_registered = emailsToInsert;
//         }

//         // 6. 관리자가 보기 편하도록 상세한 결과 반환
//         return res.status(201).json({
//             success: true,
//             summary: {
//                 newly_registered_count: results.newly_registered.length,
//                 duplicates_skipped_count: results.duplicates_skipped.length,
//                 invalid_format_skipped_count: results.invalid_format_skipped.length,
//             },
//             details: results
//         });

//     } catch (err) {
//         console.error("ADMIN REGISTRATION FAIL:", err.message);
//         return res.status(500).json({ error: "REGISTRATION ERROR", details: err.message });
//     }
// });

// module.exports = router;

const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const authAdmin = require("../middleware/authAdmin"); // Assuming you have this middleware

const isValidEmail = (email) =>
    typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

// authAdmin 미들웨어를 적용하여 관리자만 접근하도록 설정
router.post("/", authAdmin, async (req, res) => {
    // --- ▼ [수정 1] election_id를 request body에서 받기 ▼ ---
    const { election_id, emails: originalEmails = [] } = req.body;

    if (!election_id) {
        return res.status(400).json({ error: "An election_id must be provided." });
    }
    // --- ▲ [수정 1] 여기까지 ▲ ---

    if (!Array.isArray(originalEmails) || originalEmails.length === 0) {
        return res.status(400).json({ error: "An array of emails must be provided." });
    }

    const results = {
        newly_registered: [],
        duplicates_skipped: [],
        invalid_format_skipped: [],
    };

    // 이메일 유효성 검사 및 중복 제거
    const uniqueValidEmails = Array.from(new Set(originalEmails.filter(email => {
        if (isValidEmail(email)) return true;
        results.invalid_format_skipped.push(email);
        return false;
    })));

    if (uniqueValidEmails.length === 0) {
        return res.status(400).json({ error: "No valid emails provided", details: results });
    }

    try {
        // --- ▼ [수정 2] DB에서 중복 이메일을 확인할 때 election_id 사용 ▼ ---
        // 먼저, election_id가 유효한지 확인합니다.
        const { data: election, error: electionError } = await supabase
            .from("Elections")
            .select("id")
            .eq("id", election_id)
            .single();

        if (electionError || !election) {
            return res.status(404).json({ error: "The provided election_id does not exist." });
        }

        // 해당 선거에 이미 등록된 이메일을 조회합니다.
        const { data: existingVoters, error: selectError } = await supabase
            .from("Voters")
            .select("email")
            .eq("election_id", election_id) // 이 선거에 대해서만 중복 검사
            .in("email", uniqueValidEmails);

        if (selectError) throw selectError;

        const existingEmails = new Set(existingVoters.map(v => v.email));

        const votersToInsert = [];
        for (const email of uniqueValidEmails) {
            if (existingEmails.has(email)) {
                results.duplicates_skipped.push(email);
            } else {
                // --- ▼ [수정 3] 삽입할 데이터에 election_id 포함 ▼ ---
                votersToInsert.push({ email, election_id });
                // --- ▲ [수정 3] 여기까지 ▲ ---
            }
        }
        // --- ▲ [수정 2] 여기까지 ▲ ---

        if (votersToInsert.length > 0) {
            results.newly_registered = votersToInsert.map(v => v.email);
            
            // 대규모 데이터를 위한 배치 처리 (Batch)
            const BATCH_SIZE = 500;
            for (let i = 0; i < votersToInsert.length; i += BATCH_SIZE) {
                const batch = votersToInsert.slice(i, i + BATCH_SIZE);
                
                const { error: insertError } = await supabase
                    .from("Voters")
                    .insert(batch);
                
                if (insertError) throw insertError;
            }
        }

        return res.status(201).json({
            success: true,
            message: `Voter registration process completed for election ${election_id}.`,
            summary: {
                newly_registered_count: results.newly_registered.length,
                duplicates_skipped_count: results.duplicates_skipped.length,
                invalid_format_skipped_count: results.invalid_format_skipped.length,
            },
            details: results
        });

    } catch (err) {
        console.error("ADMIN REGISTRATION FAIL:", err.message);
        if (err.code === '23505') { // Unique constraint violation
            return res.status(409).json({ error: "Duplicate email found for this election.", details: err.details });
        }
        return res.status(500).json({ error: "REGISTRATION ERROR", details: err.message });
    }
});

module.exports = router;