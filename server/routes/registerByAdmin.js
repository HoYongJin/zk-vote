const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");

router.post("/", async (req, res) => {
    let { emails, email } = req.body;

    if (!emails && email) {
        emails = [email];
    }

    if (!emails || !Array.isArray(emails)) {
        return res.status(400).json({ error: "NEED email or emails as array" });
    }

    try {
        const records = emails.map(email => ({
            email,
            name: null,
            id: null,
            user_secret: null,
            voted: false
        }));

        const { error } = await supabase
            .from("Voter")
            .insert(records, { ignoreDuplicates: true });

        if (error) throw error;

        return res.status(201).json({ success: true, count: records.length });
    } catch (err) {
        console.error("ADMIN REGISTRATION FAIL:", err.message);
        return res.status(500).json({ error: "REGISTRATION ERROR", details: err.message });
    }
});

module.exports = router;