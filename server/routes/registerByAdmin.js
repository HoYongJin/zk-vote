const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");

// email: something + "@" + something + "." + somting --> 이 구조인지 확인
const isValidEmail = (email) =>
    typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

// POST 요청 처리: 관리자가 유권자 이메일을 등록하는 API
router.post("/", async (req, res) => {
    // 클라이언트에서 보낸 이메일 배열 또는 단일 이메일 추출
    let { emails, email } = req.body;

    // 단일 이메일(email)이 있을 경우 emails 배열로 변환
    if (!emails && email) {
        emails = [email];
    }

    // emails가 존재하지 않거나 배열이 아닐 경우 요청 거부
    if (!emails || !Array.isArray(emails)) {
        return res.status(400).json({ error: "NEED email or emails as array" });
    }

    // 유효한 이메일만 필터링하고, 중복 제거
    emails = [...new Set(emails.filter(isValidEmail))];

    // 유효한 이메일이 하나도 없으면 요청 거부
    if (emails.length === 0) {
        return res.status(400).json({ error: "NO valid emails provided" });
    }

    try {
        // 각 이메일에 대해 삽입할 DB 레코드 생성
        const records = emails.map((email) => ({
          email,                    // 유권자 이메일
          name: null,               // 이름은 아직 입력되지 않음
          id: null,                 // 로그인용 ID도 아직 없음
          user_secret: null,        // ZKP 용 개인 비밀값도 아직 없음
          voted: false              // 아직 투표하지 않은 상태로 초기화
        }));

        // Supabase를 통해 Voter 테이블에 레코드 삽입
        // ignoreDuplicates: true → DB에 같은 이메일이 이미 있으면 새로 추가하지 않음
        const { error } = await supabase
            .from("Voter")
            .insert(records, { ignoreDuplicates: true });

        // 삽입 도중 오류가 발생하면 예외로 처리
        if (error) throw error;

        // 삽입 성공 시 클라이언트에 응답 반환
        return res.status(201).json({
            success: true,
            emails // 등록된 유권자 이메일 목록
        });
    } catch (err) {
        // 서버 에러 발생 시 로그 출력 및 응답 반환
        console.error("ADMIN REGISTRATION FAIL:", err.message);
        return res.status(500).json({ error: "REGISTRATION ERROR", details: err.message });
    }
});

module.exports = router;