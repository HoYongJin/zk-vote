const express = require("express");
const router = express.Router({ mergeParams: true });
const supabase = require("../supabaseClient");
const auth = require("../middleware/auth");
const { ethers } = require("ethers");
const rateLimit = require('express-rate-limit'); // 1. Import the rate-limit library
const votingTallyAbi = require("../../artifacts/contracts/VotingTally.sol/VotingTally.json").abi;

// --- Helper function to initialize the blockchain provider and signer ---
const getContract = (contractAddress) => {
    // Validate that required environment variables are set.
    if (!process.env.SEPOLIA_RPC_URL || !process.env.PRIVATE_KEY) {
        throw new Error("Server configuration error: Missing RPC_URL or PRIVATE_KEY.");
    }
    const provider = new ethers.providers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    return new ethers.Contract(contractAddress, votingTallyAbi, wallet);
};

// --- 2. Configure the Rate Limiter Middleware ---
// const submitVoteLimiter = rateLimit({
//     windowMs: 15 * 60 * 1000, // 15 minutes
//     max: 5, // Limit each user to 5 requests per 15-minute window
//     keyGenerator: (req, res) => {
//         // The key is the user's ID. This is guaranteed to exist because
//         // the authentication middleware runs before this one.
//         return req.user.id;
//     },
//     handler: (req, res) => {
//         res.status(429).json({
//             error: "Too many requests.",
//             details: "You have exceeded the vote submission limit. Please try again later."
//         });
//     },
//     standardHeaders: true,
//     legacyHeaders: false,
// });
const submitVoteLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // IP당 15분 동안 5번의 요청만 허용
    keyGenerator: (req, res) => {
        // 사용자 ID 대신 IP 주소를 키로 사용합니다.
        return req.ip;
    },
    handler: (req, res) => {
        res.status(429).json({
            error: "Too many requests.",
            details: "You have exceeded the vote submission limit from this IP. Please try again later."
        });
    },
    standardHeaders: true,
    legacyHeaders: false,
});

/**
 * @route   POST /submitZk
 * @desc    Submits the final vote with a ZK proof to the smart contract. Acts as a gas relayer.
 * @access  Private (Requires JWT Authentication)
 */
router.post("/", submitVoteLimiter, async (req, res) => {
    try {
        // [수정] 파라미터 및 Body에서 필요한 값을 추출합니다.
        const { election_id } = req.params;
        const { proof, publicSignals } = req.body;

        // --- Input Validation ---
        if (!proof || !publicSignals || !proof.a || !proof.b || !proof.c) {
            return res.status(400).json({ error: "Fields 'proof' and 'publicSignals' are required." });
        }

        // --- Fetch Election Details ---
        const { data: election, error: electionError } = await supabase
            .from("Elections")
            .select("contract_address, voting_start_time, voting_end_time, merkle_root")
            .eq("id", election_id)
            .single();

        if (electionError || !election) {
            return res.status(404).json({ error: "Election not found." });
        }

        // --- Off-Chain Pre-Validation ---
        if (!election.contract_address || !election.merkle_root) {
            return res.status(403).json({ error: "Voting for this election is not yet finalized by the admin." });
        }
        const now = new Date();
        if (now < new Date(election.voting_start_time) || now > new Date(election.voting_end_time)) {
            return res.status(403).json({ error: "The voting period is not active." });
        }

        // --- Smart Contract Interaction ---
        const votingTally = getContract(election.contract_address);
        
        console.log(`Submitting an anonymous vote to election ${election_id}...`);
        
        const { a, b, c } = proof;
        const tx = await votingTally.submitTally(a, b, c, publicSignals);
        const receipt = await tx.wait();
        console.log(`Vote successfully submitted. TxHash: ${receipt.transactionHash}`);

        // --- Update 'voted' status in the database ---
        // const { error: updateError } = await supabase
        //     .from("Voters")
        //     .update({ voted: true })
        //     .eq("election_id", election_id)
        //     .eq("email", user.email);

        // if (updateError) {
        //     console.error("CRITICAL: On-chain vote succeeded, but failed to update 'voted' status in DB.", updateError);
        // }

        // --- Success Response ---
        return res.status(200).json({
            success: true,
            message: "Your vote has been successfully and anonymously cast.",
            transactionHash: receipt.transactionHash
        });

    } catch (err) {
        console.error(`Error submitting vote:`, err);
        let reason = "An unknown error occurred.";
        if (err.reason) {
            reason = err.reason;
        } else if (err.data && typeof err.data === 'string') {
            reason = err.data;
        }
        return res.status(500).json({
            error: "An on-chain error occurred while submitting your vote.",
            details: reason
        });
    }
});

module.exports = router;