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

    if (!election_id) {
        return res.status(400).json({ error: "Election ID is required." });
    }

    try {
        // 1. Fetch election details
        const { data: election, error: electionError } = await supabase
            .from("Elections")
            .select("registration_end_time, contract_address, merkle_tree_depth, merkle_root")
            .eq("id", election_id)
            .single();

        if (electionError || !election) {
            return res.status(404).json({ error: "Election not found." });
        }

        //========================================================================

        const registrationEndTime = new Date(election.registration_end_time);
        const currentTime = new Date();

        console.log("=============================================");
        console.log("DB 등록 마감 시간:", registrationEndTime.toString());
        console.log("서버 현재 시간:", currentTime.toString());
        console.log("등록 기간 종료 여부:", currentTime >= registrationEndTime);
        console.log("=============================================");

        if (currentTime < registrationEndTime) { // 디버깅을 위해 변수로 변경
            return res.status(403).json({ error: "아직 등록 기간이 종료되지 않았습니다." });
        }

        //========================================================================

        // 2. Validate conditions for finalization
        if (new Date() < new Date(election.registration_end_time)) {
            return res.status(403).json({ error: "Registration period has not ended yet." });
        }
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
        const { error: updateDbError } = await supabase
            .from("Elections")
            .update({ merkle_root: finalMerkleRoot })
            .eq("id", election_id);

        if (updateDbError) throw updateDbError;

        // 6. Call the setMerkleRoot function on the smart contract
        const provider = new ethers.providers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
        const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
        const votingTally = new ethers.Contract(election.contract_address, votingTallyAbi, wallet);
        
        console.log(`Submitting Merkle Root ${finalMerkleRoot} to contract ${election.contract_address}...`);
        const tx = await votingTally.setMerkleRoot(finalMerkleRoot);
        const receipt = await tx.wait();

        return res.status(200).json({
            success: true,
            message: "Election finalized and voting has started successfully.",
            merkleRoot: finalMerkleRoot,
            transactionHash: receipt.transactionHash
        });

    } catch (err) {
        console.error("Failed to finalize election:", err.message);
        return res.status(500).json({ error: "An error occurred while finalizing the election.", details: err.message });
    }
});

module.exports = router;