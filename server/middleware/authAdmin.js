const supabase = require("../supabaseClient");

const authAdmin = async (req, res, next) => {
    // 1. 요청 헤더에서 JWT 토큰 추출
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (!token) {
        return res.status(401).json({ error: "AUTHENTICATION_REQUIRED" });
    }

    try {
        // 2. 토큰으로 사용자 정보 가져오기
        const { data: { user }, error: userError } = await supabase.auth.getUser(token);
        if (userError || !user) {
            return res.status(401).json({ error: "INVALID_TOKEN" });
        }

        // 3. 'Admins' 테이블을 조회하여 관리자인지 확인
        const { data: admin, error: adminError } = await supabase
            .from("Admins")
            .select("id")
            .eq("id", user.id)
            .maybeSingle();

        if (adminError) throw adminError;

        // 4. Admins 테이블에 존재하지 않으면 권한 없음 처리
        if (!admin) {
            return res.status(403).json({ error: `${user.id}, ${admin.id} ADMIN_PRIVILEGES_REQUIRED` });
        }

        // 5. 관리자 확인 완료! 다음 로직으로 진행
        next();

    } catch (err) {
        console.error("Auth Admin Middleware Error:", err.message);
        return res.status(500).json({ error: "SERVER_ERROR", details: err.message });
    }
};

module.exports = authAdmin;