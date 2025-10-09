const supabase = require("../supabaseClient");

const auth = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        const token = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

        if (!token) {
            return res.status(401).json({ error: "AUTHENTICATION_REQUIRED", details: "No token provided." });
        }

        // 2. 추출한 토큰을 Supabase에 보내 사용자 정보를 검증합니다.
        const { data: { user }, error } = await supabase.auth.getUser(token);

        if (error || !user) {
            // Supabase가 토큰이 유효하지 않다고 판단한 경우
            return res.status(401).json({ message: "유효하지 않은 토큰입니다." });
        }

        // 3. 검증된 사용자 정보를 req 객체에 담아 다음 단계로 넘깁니다.
        req.user = user;
        next();

    } catch (err) {
        res.status(500).json({ message: "인증 처리 중 서버 오류가 발생했습니다." });
    }
};

module.exports = auth;