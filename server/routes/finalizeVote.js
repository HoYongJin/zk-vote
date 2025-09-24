const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");
const { ethers } = require("ethers");
const { buildPoseidon } = require("circomlibjs");
const { MerkleTree } = require("fixed-merkle-tree");
const authAdmin = require("../middleware/authAdmin"); // Import your admin auth middleware

// VotingTally contract ABI
const votingTallyAbi = require("../../artifacts/contracts/VotingTally.sol/VotingTally.json").abi;

/**
 * @route   POST /finalizeVote/:election_id
 * @desc    Admin finalizes registration, sets the Merkle Root, and starts the vote.
 * @access  Admin
 */
router.post("/:election_id", authAdmin, async (req, res) => {
    const { election_id } = req.params;
    const { voteEndTime } = req.body;

    if (!election_id) {
        return res.status(400).json({ error: "Election ID is required." });
    }
    if (!voteEndTime) {
        return res.status(400).json({ error: "투표 종료 시간이 필요합니다." });
    }

    try {
        // 1. Fetch election details
        const { data: election, error: electionError } = await supabase
            .from("Elections")
            .select("contract_address, merkle_tree_depth, merkle_root")
            .eq("id", election_id)
            .single();

        if (electionError || !election) {
            return res.status(404).json({ error: "Election not found." });
        }

        

        // 2. Validate conditions for finalization
        if (!election.contract_address) {
            return res.status(400).json({ error: "The smart contract for this election has not been deployed." });
        }
        if (election.merkle_root) {
            return res.status(409).json({ error: "This election has already been finalized." });
        }

        // 3. Fetch all registered voters' secrets for this election
        const { data: voters, error: votersError } = await supabase
            .from("Voters")
            .select("user_secret")
            .eq("election_id", election_id)
            .not("user_secret", "is", null);

        if (votersError) throw votersError;
        if (voters.length === 0) {
            return res.status(400).json({ error: "No voters have registered for this election." });
        }
        
        // 4. Calculate the final Merkle Root
        const poseidon = await buildPoseidon();
        const leaves = voters.map(v => poseidon.F.toString(poseidon([BigInt(v.user_secret)])));
        const tree = new MerkleTree(election.merkle_tree_depth, leaves, {
            hashFunction: (a, b) => poseidon.F.toString(poseidon([a, b])),
            zeroElement: 0
        });
        const finalMerkleRoot = tree.root.toString();

        // 5. Update the Merkle Root in the database
        const now = new Date();
        const { error: updateDbError } = await supabase
            .from("Elections")
            .update({ 
                merkle_root: finalMerkleRoot,
                registration_end_time: now.toISOString(),
                voting_start_time: now.toISOString(),
                voting_end_time: voteEndTime 
            })
            .eq("id", election_id);

        if (updateDbError) throw updateDbError;

        // // 6. Call the setMerkleRoot function on the smart contract
        const provider = new ethers.providers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
        const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
        const votingTally = new ethers.Contract(election.contract_address, votingTallyAbi, wallet);
        

        // 1. Merkle Root 설정
        console.log(`Submitting Merkle Root ${finalMerkleRoot} to contract...`);
        const txRoot = await votingTally.setMerkleRoot(finalMerkleRoot);
        await txRoot.wait();
        console.log("Merkle Root set successfully. Tx hash:", txRoot.hash);

        // 2. 투표 기간 설정
        // DB에서 가져온 시간 문자열을 Unix timestamp (초 단위)로 변환합니다.
        const startTime = Math.floor(now.getTime() / 1000);
        const endTime = Math.floor(new Date(voteEndTime).getTime() / 1000);

        console.log(`Setting voting period from ${startTime} to ${endTime}...`);
        const txPeriod = await votingTally.setVotingPeriod(startTime, endTime);
        await txPeriod.wait();
        console.log("Voting period set successfully. Tx hash:", txPeriod.hash);

        return res.status(200).json({
            success: true,
            message: "Election finalized and voting has started successfully.",
            merkleRoot: finalMerkleRoot
        });

    } catch (err) {
        console.error("Failed to finalize election:", err.message);
        return res.status(500).json({ error: "An error occurred while finalizing the election.", details: err.message });
    }
});

module.exports = router;