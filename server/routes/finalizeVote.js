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
const { buildFinalMerkleSnapshot, withElectionMerkleLock } = require("../utils/merkle");
const { isRedisLockHeld } = require("../utils/redisLock");
const { markOnchainConfigured } = require("../utils/finalizationState");
const { ethers } = require("ethers");
const authAdmin = require("../middleware/authAdmin");
const { isElectionSuperseded } = require("../utils/supersede");

// Load contract ABI (ensure path is correct relative to this file)
const votingTallyAbi = require("../../artifacts/contracts/VotingTally.sol/VotingTally.json").abi;
const FINALIZE_LOCK_OPTIONS = {
    lockTimeoutSeconds: 1800,
    pollingTimeoutMs: 30000,
};

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
        const result = await withElectionMerkleLock(election_id, async (lock) => {
        const finalizationTime = new Date();
        if (votingEndTime <= finalizationTime) {
            return {
                status: 400,
                body: {
                    error: "VALIDATION_ERROR",
                    details: "`voteEndTime` must still be in the future when finalization starts."
                }
            };
        }
        // --- 2. Fetch Election Details and Perform Pre-condition Checks ---
        const { data: election, error: electionError } = await supabase
            .from("Elections")
            .select("contract_address, merkle_root, registration_end_time")
            .eq("id", election_id)
            .single();

        if (electionError) {
            console.error(`[${election_id}] Error fetching election:`, electionError.message);
            if (electionError.code === 'PGRST116') {
                return { status: 404, body: { error: "ELECTION_NOT_FOUND", details: `Election with ID ${election_id} not found.` } };
            }
            throw electionError;
        }
        if (!election) {
            return { status: 404, body: { error: "ELECTION_NOT_FOUND", details: `Election with ID ${election_id} not found.` } };
        }
        if (await isElectionSuperseded(supabase, election_id)) {
            return {
                status: 409,
                body: {
                    error: "ELECTION_SUPERSEDED",
                    details: "This election was superseded and cannot be finalized."
                }
            };
        }

        // Check 1: Ensure the smart contract address exists (meaning deployment was successful).
        if (!election.contract_address) {
            console.warn(`[${election_id}] Attempted to finalize election before contract deployment.`);
            return { status: 400, body: { error: "STATE_ERROR", details: "The smart contract for this election has not been deployed yet. Run setup/deploy first." } };
        }
        // Check 2: Ensure the election hasn't already been finalized (merkle_root is null).
        if (election.merkle_root) {
            console.warn(`[${election_id}] Attempted to finalize an already finalized election.`);
            return { status: 409, body: { // 409 Conflict
                error: "ALREADY_FINALIZED", 
                details: "This election's registration period has already been finalized." 
            } };
        }

        const currentRegistrationEnd = new Date(election.registration_end_time);
        const registrationClosedAt = new Date(
            Math.min(finalizationTime.getTime(), currentRegistrationEnd.getTime())
        ).toISOString();

        // Build and validate the snapshot before mutating durable state. A
        // zero-voter finalize is a validation failure, not a state transition:
        // it must not close registration as a side effect.
        const { tree, leaves } = await buildFinalMerkleSnapshot(
            election_id,
            registrationClosedAt
        );

        if (!leaves || leaves.length === 0) {
            console.warn(`[${election_id}] Attempted to finalize election with zero registered voters.`);
            return { status: 400, body: {
                error: "NO_VOTERS_REGISTERED",
                details: "Cannot finalize: No voters have completed their registration for this election."
            } };
        }
        const finalMerkleRoot = tree.root.toString();

        // Durable fail-closed marker before any on-chain side effect. Even if the
        // process crashes after the transaction succeeds, registration remains
        // closed in Postgres and late voters cannot silently diverge from the
        // on-chain Merkle root.
        const { data: closedElection, error: closeError } = await supabase
            .from("Elections")
            .update({ registration_end_time: registrationClosedAt })
            .eq("id", election_id)
            .is("merkle_root", null)
            .select("id")
            .single();

        if (closeError || !closedElection) {
            const details = closeError?.message || "Registration close update returned no row.";
            console.error(`[${election_id}] Failed to durably close registration before finalization: ${details}`);
            return {
                status: 409,
                body: {
                    error: "FINALIZATION_STATE_CONFLICT",
                    details: "Could not durably close registration before finalization."
                }
            };
        }

                
        // --- 4. Update the Smart Contract (On-Chain) ---
        // Connect to the blockchain provider and wallet. configureElection is
        // onlyOwner: use OWNER_PRIVATE_KEY when the owner key is separated
        // from the hot relayer key (AR-M4); local dev may fall back to the
        // relayer key when both roles share one account.
        const provider = new ethers.providers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
        const ownerKey = process.env.OWNER_PRIVATE_KEY || process.env.PRIVATE_KEY;
        const wallet = new ethers.Wallet(ownerKey, provider);
        const votingTallyContract = new ethers.Contract(election.contract_address, votingTallyAbi, wallet);
        
        // --- [Tx] Atomically set the Merkle root and voting period on the contract ---
        let txReceiptConfigure;
        let votingStartTimeIso = finalizationTime.toISOString();
        let votingEndTimeIso = votingEndTime.toISOString();
        let onchainConfigured = false;
        try {
            onchainConfigured = await votingTallyContract.configured();
            if (onchainConfigured) {
                const onchainRoot = await votingTallyContract.merkleRoot();
                if (BigInt(onchainRoot.toString()) !== BigInt(finalMerkleRoot)) {
                    return {
                        status: 409,
                        body: {
                            error: "ON_CHAIN_STATE_MISMATCH",
                            details: "The contract is already configured with a different Merkle root. Manual reconciliation is required."
                        }
                    };
                }

                const onchainStart = await votingTallyContract.votingStartTime();
                const onchainEnd = await votingTallyContract.votingEndTime();
                votingStartTimeIso = new Date(Number(onchainStart.toString()) * 1000).toISOString();
                votingEndTimeIso = new Date(Number(onchainEnd.toString()) * 1000).toISOString();
                await markOnchainConfigured(election_id, {
                    merkleRoot: finalMerkleRoot,
                    registrationClosedAt,
                    votingStartTime: votingStartTimeIso,
                    votingEndTime: votingEndTimeIso,
                });
            } else {
                const votingStartTimeSeconds = Math.floor(finalizationTime.getTime() / 1000);
                const votingEndTimeSeconds = Math.floor(votingEndTime.getTime() / 1000);
                const txConfigure = await votingTallyContract.configureElection(
                    finalMerkleRoot,
                    votingStartTimeSeconds,
                    votingEndTimeSeconds
                );
                txReceiptConfigure = await txConfigure.wait();
                console.log(`[${election_id}] Election configured successfully on-chain. Gas used: ${txReceiptConfigure.gasUsed.toString()}`);
                await markOnchainConfigured(election_id, {
                    merkleRoot: finalMerkleRoot,
                    registrationClosedAt,
                    votingStartTime: votingStartTimeIso,
                    votingEndTime: votingEndTimeIso,
                    configureTransactionHash: txReceiptConfigure.transactionHash,
                });
            }
        } catch (contractError) {
             console.error(`[${election_id}] Error configuring election on contract:`, contractError.reason || contractError.message);
             throw new Error(`On-chain error during configureElection: ${contractError.reason || contractError.message}`);
        }

        if (!(await isRedisLockHeld(lock))) {
            console.error(`[${election_id}] Finalization lock expired before DB sync after on-chain configuration.`);
            return {
                status: 500,
                body: {
                    error: "FINALIZATION_LOCK_EXPIRED",
                    details: "On-chain finalization may have succeeded, but the finalization lock expired before database synchronization."
                }
            };
        }

        const revalidatedSnapshot = await buildFinalMerkleSnapshot(election_id, registrationClosedAt);
        const revalidatedRoot = revalidatedSnapshot.tree.root.toString();
        if (BigInt(revalidatedRoot) !== BigInt(finalMerkleRoot) || revalidatedSnapshot.leaves.length !== leaves.length) {
            console.error(`[${election_id}] CRITICAL ERROR: voter snapshot changed after on-chain finalization. originalRoot=${finalMerkleRoot}, revalidatedRoot=${revalidatedRoot}`);
            return {
                status: 500,
                body: {
                    error: "FINALIZATION_SNAPSHOT_CHANGED",
                    details: "On-chain finalization succeeded, but the voter snapshot changed before database synchronization. Manual reconciliation is required.",
                    merkleRoot: finalMerkleRoot,
                    revalidatedRoot,
                }
            };
        }
        
        // --- 5. Update the Database (Off-Chain) - Only after successful on-chain updates ---
        // Update the election record with the Merkle root and the actual voting times.
        // Also update registration_end_time to 'now' to definitively close registration in the DB.
        const { data: updatedElection, error: updateDbError } = await supabase
            .from("Elections")
            .update({ 
                merkle_root: finalMerkleRoot,
                registration_end_time: registrationClosedAt,
                voting_start_time: votingStartTimeIso,
                voting_end_time: votingEndTimeIso
            })
            .eq("id", election_id)
            .is("merkle_root", null)
            .select("id")
            .single();

        if (updateDbError || !updatedElection) {
            // CRITICAL STATE: The contract is finalized, but the DB failed to reflect this.
            // This requires monitoring and potentially manual DB correction.
            const details = updateDbError?.message || "Database update returned no row.";
            console.error(`[${election_id}] CRITICAL ERROR: On-chain finalization succeeded (Configure Tx: ${txReceiptConfigure?.transactionHash}), but database update failed: ${details}`);
            return {
                status: 500,
                body: {
                    error: "FINALIZATION_DB_SYNC_FAILED",
                    details: "On-chain finalization succeeded, but the database could not be updated. Manual reconciliation is required.",
                    merkleRoot: finalMerkleRoot,
                    configureTransactionHash: txReceiptConfigure?.transactionHash,
                }
            };
        }

        // --- 6. Success Response ---
        return {
            status: 200,
            body: {
            success: true,
            message: "Election finalized and voting has started successfully.",
            merkleRoot: finalMerkleRoot,
            }
        };
        }, FINALIZE_LOCK_OPTIONS);

        return res.status(result.status).json(result.body);

    } catch (err) {
        // --- 7. General Error Handling ---
        console.error(`[${election_id}] Failed to finalize election:`, err.message);
        if (err.status && err.code) {
            return res.status(err.status).json({
                error: err.code,
                details: err.message
            });
        }
        
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
