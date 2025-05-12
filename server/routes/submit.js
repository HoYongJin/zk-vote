// const express = require("express");
// const router = express.Router();
// const supabase = require("../supabaseClient");

// // router.post("/", async (req, res) => {
// //     const token = req.headers.authorization?.split(" ")[1];
// //     if (!token) return res.status(401).json({ error: "NO TOKEN" });

// //     const { data: { user }, error } = await supabase.auth.getUser(token);
// //     if (error || !user) return res.status(401).json({ error: "INVALID TOKEN" });

// //     const email = user.email;

// //     const { data: voter } = await supabase
// //         .from("Voter")
// //         .select("user_secret")
// //         .eq("email", email)
// //         .maybeSingle();

// //     if (!voter || !voter.user_secret) {
// //         return res.status(403).json({ error: "NOT REGISTERED" });
// //     }

// //     return res.json({ user_secret: voter.user_secret });
// // });

// router.post("/", async (req, res) => {
//     const authHeader = req.headers.authorization || "";
//     const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

//     if (!token) return res.status(401).json({ error: "NO VALID TOKEN" });

//     const { data: { user }, error } = await supabase.auth.getUser(token);
//     if (error || !user) return res.status(401).json({ error: "INVALID TOKEN" });

//     const email = user.email;

//     const { data: voter } = await supabase
//         .from("Voter")
//         .select("user_secret")
//         .eq("email", email)
//         .maybeSingle();

//     if (!voter || !voter.user_secret) {
//         return res.status(403).json({ error: "NOT REGISTERED" });
//     }

//     console.log(`[user_secret 전달] ${email} @ ${new Date().toISOString()}`);

//     return res.status(200).json({
//         success: true,
//         user_secret: voter.user_secret
//     });
// });


// module.exports = router;
