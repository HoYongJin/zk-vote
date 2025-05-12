// const express = require("express");
// const router = express.Router();
// const supabase = require("../supabaseClient");
// const { generateMerkleProof } = require("../utils/merkle");

// router.post("/", async (req, res) => {
//     const token = req.headers.authorization?.split(" ")[1];
//     const { user_secret } = req.body;

//     if (!token || !user_secret) {
//         return res.status(400).json({ error: "NEED user_secret AND BEARER TOKEN" });
//     }

//     // 🔐 토큰 기반 인증
//     const {
//         data: { user },
//         error: authError
//     } = await supabase.auth.getUser(token);

//     if (authError || !user) {
//         return res.status(401).json({ error: "INVALID TOKEN" });
//     }

//     const email = user.email;

//     // 🔐 DB에서 email + user_secret 검증
//     const { data: voter, error: dbError } = await supabase
//         .from("Voter")
//         .select("*")
//         .eq("email", email)
//         .eq("user_secret", user_secret)
//         .maybeSingle();

//     if (dbError) {
//         console.error("DB ERROR:", dbError.message);
//         return res.status(500).json({ error: "DATABASE ERROR" });
//     }

//     if (!voter) {
//         return res.status(403).json({ error: "INVALID SECRET OR UNREGISTERED USER" });
//     }

//     try {
//         const { leaf, root, path_elements, path_index } = await generateMerkleProof(user_secret);

//         return res.json({
//             leaf,
//             merkle_root: root,
//             path_elements,
//             path_index
//         });
//     } catch (err) {
//         console.error("PROOF ERROR:", err.message);
//         return res.status(500).json({ error: "FAILED TO GENERATE MERKLE PROOF", details: err.message });
//     }
// });

// module.exports = router;




// // const express = require("express");
// // const router = express.Router();
// // const fs = require("fs");
// // const path = require("path");
// // const { generateMerkleProof } = require("../utils/merkle");

// // router.post("/", async (req, res) => {
// //     const { user_secret } = req.body;
// //     if (!user_secret) {
// //         return res.status(400).json({ error: "NEED user_secret" });
// //     }

// //     try {
// //         const { leaf, root, path_elements, path_index } = await generateMerkleProof(user_secret);

// //         return res.json({
// //             leaf,
// //             merkle_root: root,
// //             path_elements,
// //             path_index
// //         });
// //     } catch (err) {
// //         console.error("PROOF ERROR:", err.message);
// //         return res.status(500).json({ error: "FAILED TO GENERATE MERKLE PROOF", details: err.message });
// //     }
// // });

// // module.exports = router;

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