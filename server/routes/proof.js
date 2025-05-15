const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const { generateMerkleProof } = require("../utils/merkle");

router.post("/", async (req, res) => {
    const token = req.headers.authorization?.split(" ")[1];
    const { user_secret } = req.body;

    if (!token || !user_secret) {
        return res.status(400).json({ error: "NEED token AND user_secret" });
    }

    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: "INVALID TOKEN" });

    const email = user.email;

    const { data: voter, error: dbError } = await supabase
        .from("Voter")
        .select("*")
        .eq("email", email)
        .eq("user_secret", user_secret)
        .maybeSingle();

    if (dbError) return res.status(500).json({ error: "DATABASE ERROR", details: dbError.message });
    if (!voter) return res.status(403).json({ error: "INVALID SECRET OR NOT REGISTERED" });

    try {
        const { leaf, root, path_elements, path_index } = await generateMerkleProof(user_secret);
        return res.json({ 
            leaf, 
            merkle_root: root, 
            path_elements, 
            path_index 
        });
    } catch (err) {
        console.error("PROOF ERROR:", err.message);
        return res.status(500).json({ error: "FAILED TO GENERATE MERKLE PROOF", details: err.message });
    }
});

module.exports = router;