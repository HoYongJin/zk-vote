const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const crypto = require("crypto");
const { addUserSecret } = require("../utils/merkle");

const generateUserSecret = (id) => {
    const seed = id + process.env.SECRET_SALT;
    const hash = crypto.createHash("sha256").update(seed).digest("hex");
    return BigInt("0x" + hash).toString();
};

router.post("/", async (req, res) => {
    const token = req.headers.authorization?.split(" ")[1];
    const { name, id } = req.body;

    if (!token || !name || !id) {
        return res.status(400).json({ error: "NEED name, id, token" });
    }

    const {
        data: { user },
        error: authError
    } = await supabase.auth.getUser(token);

    if (authError || !user) {
        return res.status(401).json({ error: "INVALID TOKEN" });
    }

    const email = user.email;

    const { data: voter, error } = await supabase
        .from("Voter")
        .select("*")
        .eq("email", email)
        .maybeSingle();

    if (error) {
        console.error("DB ERROR:", error.message);
        return res.status(500).json({ error: "DATABASE ERROR" });
    }

    if (!voter) {
        return res.status(403).json({ error: "EMAIL NOT REGISTERED BY ADMIN" });
    }

    if (voter.user_secret) {
        return res.status(409).json({ error: "ALREADY REGISTERED" });
    }

    try {
        const user_secret = generateUserSecret(id);

        // DB 업데이트
        const { error: updateErr } = await supabase
            .from("Voter")
            .update({
                name,
                id,
                voted: false,
                user_secret
            })
            .eq("email", email);

        if (updateErr) throw updateErr;

        // Merkle Tree에 추가
        await addUserSecret(user_secret);

        return res.status(201).json({ success: true, email });
    } catch (err) {
        console.error("REGISTER FAIL:", err.message);
        return res.status(500).json({ error: "REGISTRATION ERROR", details: err.message });
    }
});

module.exports = router;