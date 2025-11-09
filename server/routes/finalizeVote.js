/**
 * @file server/routes/finalizeVote.js
 * @desc Route handler for finalizing the voter registration period for an election.
 * Requires admin privileges. This calculates the final Merkle root, sets it on the
 * smart contract, sets the voting period on the contract, and updates the DB state.
 */

const express = require("express");
const router = express.Router({ mergeParams: true });
const validator = require('validator');
const supabase = require("../supabaseClient");
const { generateMerkleTree } = require("../utils/merkle"); 
const { ethers } = require("ethers");
const authAdmin = require("../middleware/authAdmin");

// Load contract ABI (ensure path is correct relative to this file)
const votingTallyAbi = require("../../artifacts/contracts/VotingTally.sol/VotingTally.json").abi;

/**
 * @route   POST /api/elections/:election_id/finalize
 * @desc    (Admin Only) Finalizes the voter registration period for the specified election.
 * 1. Validates input (election_id, voteEndTime).
 * 2. Checks election state (must exist, have contract, not already finalized).
 * 3. Generates the final Merkle root using registered voters' secrets.
 * 4. Sets the Merkle root on the associated VotingTally smart contract.
 * 5. Sets the voting start (now) and end times on the smart contract.
 * 6. Updates the election record in the database (sets merkle_root, times).
 * @access  Private (Admin Only - enforced by authAdmin middleware)
 * @param   {string} req.params.election_id - The UUID of the election to finalize.
 * @param   {string} req.body.voteEndTime - The desired voting deadline in ISO 8601 format (must be in the future).
 * @returns {object} Success message with the Merkle root, or error details.
 */
router.post("/", authAdmin, async (req, res) => {
    const { election_id } = req.params;
    const { voteEndTime } = req.body;
    const now = new Date();

    // --- 1. Input Validation ---
    if (!election_id) { // Should be guaranteed by router, but good practice
        return res.status(400).json({ error: "VALIDATION_ERROR", details: "Election ID is required in the URL path." });
    }
    // Validate voteEndTime: must be provided, valid ISO 8601, and in the future.
    if (!voteEndTime || !validator.isISO8601(voteEndTime)) {
         return res.status(400).json({ error: "VALIDATION_ERROR", details: "`voteEndTime` must be provided as a valid ISO 8601 date string." });
    }
    const votingEndTime = new Date(voteEndTime);
    if (votingEndTime <= now) {
         return res.status(400).json({ error: "VALIDATION_ERROR", details: "`voteEndTime` must be set in the future." });
    }

    // Check essential environment variables needed for blockchain interaction
    if (!process.env.SEPOLIA_RPC_URL || !process.env.PRIVATE_KEY) {
        console.error(`[${election_id}] Missing SEPOLIA_RPC_URL or PRIVATE_KEY env vars.`);
        return res.status(500).json({ error: "SERVER_CONFIGURATION_ERROR", details: "Server is missing required configuration for blockchain interaction." });
   }

    try {
        // --- 2. Fetch Election Details and Perform Pre-condition Checks ---
        const { data: election, error: electionError } = await supabase
            .from("Elections")
            .select("contract_address, merkle_tree_depth, merkle_root, registration_end_time")
            .eq("id", election_id)
            .single();

        if (electionError) {
            console.error(`[${election_id}] Error fetching election:`, electionError.message);
            if (electionError.code === 'PGRST116') {
                return res.status(404).json({ error: "ELECTION_NOT_FOUND", details: `Election with ID ${election_id} not found.` });
            }
            throw electionError;
        }
        if (!election) {
            return res.status(404).json({ error: "ELECTION_NOT_FOUND", details: `Election with ID ${election_id} not found.` });
        }

        // Check 1: Ensure the smart contract address exists (meaning deployment was successful).
        if (!election.contract_address) {
            console.warn(`[${election_id}] Attempted to finalize election before contract deployment.`);
            return res.status(400).json({ error: "STATE_ERROR", details: "The smart contract for this election has not been deployed yet. Run setup/deploy first." });
        }
        // Check 2: Ensure the election hasn't already been finalized (merkle_root is null).
        if (election.merkle_root) {
            console.warn(`[${election_id}] Attempted to finalize an already finalized election.`);
            return res.status(409).json({ // 409 Conflict
                error: "ALREADY_FINALIZED", 
                details: "This election's registration period has already been finalized." 
            });
        }

        // --- 3. Generate the Final Merkle Root Off-Chain ---
        const { tree, leaves } = await generateMerkleTree(election_id);

        // Check if any voters actually registered. Cannot finalize with zero voters.
        if (!leaves || leaves.length === 0) {
            console.warn(`[${election_id}] Attempted to finalize election with zero registered voters.`);
            return res.status(400).json({ 
                error: "NO_VOTERS_REGISTERED", 
                details: "Cannot finalize: No voters have completed their registration for this election." 
            });
        }
        const finalMerkleRoot = tree.root.toString();

                
        // --- 4. Update the Smart Contract (On-Chain) ---
        // Connect to the blockchain provider and wallet.
        const provider = new ethers.providers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
        const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
        const votingTallyContract = new ethers.Contract(election.contract_address, votingTallyAbi, wallet);
        
        // --- [Tx 1] Set the Merkle Root on the contract ---
        let txReceiptRoot, txReceiptPeriod;
        try {
            const txRoot = await votingTallyContract.setMerkleRoot(finalMerkleRoot);
            txReceiptRoot = await txRoot.wait(); // Wait for the transaction to be mined
            console.log(`[${election_id}] Merkle Root set successfully on-chain. Gas used: ${txReceiptRoot.gasUsed.toString()}`);
        } catch (contractError) {
             console.error(`[${election_id}] Error setting Merkle Root on contract:`, contractError.reason || contractError.message);
             throw new Error(`On-chain error during setMerkleRoot: ${contractError.reason || contractError.message}`);
        }

        // --- [Tx 2] Set the Voting Period on the contract ---
        // Convert JS Dates to Unix timestamps (seconds).
        const votingStartTimeSeconds = Math.floor(now.getTime() / 1000);
        const votingEndTimeSeconds = Math.floor(votingEndTime.getTime() / 1000);;

        try {
            const txPeriod = await votingTallyContract.setVotingPeriod(votingStartTimeSeconds, votingEndTimeSeconds);
            txReceiptPeriod = await txPeriod.wait();
            console.log(`[${election_id}] Voting Period set successfully on-chain. Gas used: ${txReceiptPeriod.gasUsed.toString()}`);
        } catch(contractError) {
             console.error(`[${election_id}] Error setting Voting Period on contract:`, contractError.reason || contractError.message);
             // If setting the period fails after setting the root, the state is inconsistent.
             // Log critical error. DB update will still be attempted but state needs review.
              console.error(`[${election_id}] CRITICAL: Merkle root set, but failed to set voting period! Manual intervention may be needed.`);
             throw new Error(`On-chain error during setVotingPeriod: ${contractError.reason || contractError.message}`);
        }
        
        // --- 5. Update the Database (Off-Chain) - Only after successful on-chain updates ---
        // Update the election record with the Merkle root and the actual voting times.
        // Also update registration_end_time to 'now' to definitively close registration in the DB.
        const { error: updateDbError } = await supabase
            .from("Elections")
            .update({ 
                merkle_root: finalMerkleRoot,
                registration_end_time: now.toISOString(),
                voting_start_time: now.toISOString(),
                voting_end_time: votingEndTime.toISOString()
            })
            .eq("id", election_id);

        let responseMessage = "Election finalized and voting has started successfully.";
        if (updateDbError) {
            // CRITICAL STATE: The contract is finalized, but the DB failed to reflect this.
            // This requires monitoring and potentially manual DB correction.
            console.error(`[${election_id}] CRITICAL ERROR: On-chain finalization succeeded (Root Tx: ${txReceiptRoot?.transactionHash}, Period Tx: ${txReceiptPeriod?.transactionHash}), but database update failed: ${updateDbError.message}`);
            // Modify the success message to indicate the partial failure.
            responseMessage = "On-chain updates succeeded, but database update failed. Please check server logs.";
            // Still return 200 OK because the critical on-chain part succeeded, but alert the admin.
        }

        // --- 6. Success Response ---
        return res.status(200).json({
            success: true,
            message: responseMessage,
            merkleRoot: finalMerkleRoot,
        });

    } catch (err) {
        // --- 7. General Error Handling ---
        console.error(`[${election_id}] Failed to finalize election:`, err.message);
        
        // Check for common Ethers.js/blockchain errors
        // (err.code might be useful, e.g., 'CALL_EXCEPTION' indicates contract revert)
        let errorType = "FINALIZATION_ERROR";
        let details = "An internal server error occurred during finalization.";
        if (err.code === 'CALL_EXCEPTION' || err.message.includes("On-chain error during")) {
            errorType = "ON_CHAIN_ERROR";
            // Extract reason if available, otherwise use raw message
            details = err.reason || err.message || "Smart contract execution failed. Check transaction on block explorer or server logs.";
        } else if (err.message.includes("Could not fetch election details")) {
             errorType = "DATA_ERROR"; // Example categorization
             details = err.message;
        }
        
        return res.status(500).json({ 
            error: errorType, 
            details: details 
        });
    }
});

module.exports = router;