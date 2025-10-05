const express = require("express");
const router = express.Router();
const validator = require('validator');
const supabase = require("../supabaseClient");
const { generateMerkleTree } = require("../utils/merkle"); 
const { ethers } = require("ethers");
// const { buildPoseidon } = require("circomlibjs");
// const { MerkleTree } = require("fixed-merkle-tree");
const authAdmin = require("../middleware/authAdmin");

// VotingTally contract ABI
const votingTallyAbi = require("../../artifacts/contracts/VotingTally.sol/VotingTally.json").abi;

/**
 * @route   POST /finalize/:election_id
 * @desc    An admin finalizes the voter registration period, calculates the final Merkle root,
 *          sets the root and voting period on the smart contract, and officially starts the vote.
 * @access  Private (Admin Only)
 */
router.post("/:election_id", authAdmin, async (req, res) => {
    const { election_id } = req.params;
    const { voteEndTime } = req.body;
    const now = new Date();

    // --- 1. Input Validation ---
    if (!election_id) {
        return res.status(400).json({ error: "VALIDATION_ERROR", details: "Election ID is required in the URL path." });
    }
    if (!voteEndTime || !validator.isISO8601(voteEndTime) || new Date(voteEndTime) <= new Date()) {
        return res.status(400).json({ error: "VALIDATION_ERROR", details: "`voteEndTime` must be a valid ISO 8601 date string set in the future." });
    }

    try {
        // --- 2. Fetch Election Details and Pre-condition Checks ---
        const { data: election, error: electionError } = await supabase
            .from("Elections")
            .select("contract_address, merkle_tree_depth, merkle_root, registration_end_time")
            .eq("id", election_id)
            .single();

        if (electionError || !election) {
            return res.status(404).json({ error: "ELECTION_NOT_FOUND" });
        }

        // Check for correct state before proceeding
        if (!election.contract_address) {
            return res.status(400).json({ error: "STATE_ERROR", details: "The smart contract for this election has not been deployed." });
        }
        if (election.merkle_root) {
            return res.status(409).json({ error: "ALREADY_FINALIZED", details: "This election has already been finalized." });
        }

        // --- 3. Fetch All Finalized Voters ---
        const { data: voters, error: votersError } = await supabase
            .from("Voters")
            .select("user_secret")
            .eq("election_id", election_id)
            .not("user_secret", "is", null);

        if (votersError) throw votersError;
        if (voters.length === 0) {
            return res.status(400).json({ error: "NO_VOTERS_REGISTERED", details: "No voters have completed their registration for this election." });
        }
        
        // --- 4. Calculate the Final Merkle Root Off-Chain ---
        // const poseidon = await buildPoseidon();
        // const leaves = voters.map(v => poseidon.F.toString(poseidon([BigInt(v.user_secret)])));
        // const tree = new MerkleTree(election.merkle_tree_depth, leaves, {
        //     hashFunction: (a, b) => poseidon.F.toString(poseidon([a, b])),
        //     // derived from keccak256("tornado") to ensure compatibility with circomlib.(tornado-core/contracts/MerkleTreeWithHistory.sol)
        //     zeroElement: "21663839004416932945382355908790599225266501822907911457504978515578255421292"
        // });
        // const finalMerkleRoot = tree.root.toString();
        const tree = await generateMerkleTree(election_id);
        if (tree.leaves.length === 0) {
            return res.status(400).json({ error: "NO_VOTERS_REGISTERED" });
        }
        const finalMerkleRoot = tree.root.toString();

                
        // --- 5. Update the Smart Contract First ---
        const provider = new ethers.providers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
        const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
        const votingTally = new ethers.Contract(election.contract_address, votingTallyAbi, wallet);
        
        // a. Set the Merkle Root on-chain
        console.log(`Submitting Merkle Root ${finalMerkleRoot} to contract...`);
        const txRoot = await votingTally.setMerkleRoot(finalMerkleRoot);
        await txRoot.wait();
        console.log("Merkle Root set successfully on-chain. Tx hash:", txRoot.hash);

        // b. Set the voting period on-chain (using Unix timestamps in seconds)
        const startTime = Math.floor(now.getTime() / 1000);
        const endTime = Math.floor(new Date(voteEndTime).getTime() / 1000);

        console.log(`Setting voting period from ${startTime} to ${endTime} on-chain...`);
        const txPeriod = await votingTally.setVotingPeriod(startTime, endTime);
        await txPeriod.wait();
        console.log("Voting period set successfully on-chain. Tx hash:", txPeriod.hash);
        
        // --- 6. Update the Database only after successful on-chain transactions ---
        const { error: updateDbError } = await supabase
            .from("Elections")
            .update({ 
                merkle_root: finalMerkleRoot,
                registration_end_time: now.toISOString(), 
                voting_start_time: now.toISOString(),  
                voting_end_time: voteEndTime 
            })
            .eq("id", election_id);

        if (updateDbError) {
            // This is a critical state error. The contract is finalized, but the DB failed to update.
            // This requires manual intervention or a retry mechanism.
            console.error("CRITICAL ERROR: On-chain finalization succeeded, but DB update failed.", updateDbError);
            // We still return success to the admin, but log the error for monitoring.
        }

        return res.status(200).json({
            success: true,
            message: "Election finalized and voting has started successfully.",
            merkleRoot: finalMerkleRoot
        });

    } catch (err) {
        console.error("Failed to finalize election:", err.message);
        // Check for common blockchain errors
        if (err.code === 'CALL_EXCEPTION') {
            return res.status(500).json({ error: "ON_CHAIN_ERROR", details: `Smart contract call failed. Reason: ${err.reason}` });
        }
        return res.status(500).json({ error: "FINALIZATION_ERROR", details: err.message });
    }
});

module.exports = router;