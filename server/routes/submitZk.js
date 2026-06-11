/**
 * @file server/routes/submitZk.js
 * @desc Route handler for submitting a voter's ZK proof to the smart contract.
 * This acts as a "gas relayer," paying the transaction fees.
 * This endpoint is ANONYMOUS but protected by a single-use "submission ticket"
 * obtained from the authenticated /proof endpoint.
 */

const express = require("express");
const router = express.Router({ mergeParams: true });
const supabase = require("../supabaseClient");
const { ethers } = require("ethers");
const {
    consumeSubmissionTicket,
    readSubmissionTicket,
} = require("../utils/submissionTickets");
const {
    validateFormattedProof,
    validateSubmitPayload,
    PUBLIC_SIGNAL_NULLIFIER_INDEX,
    PUBLIC_SIGNAL_COUNT,
} = require("../utils/submitValidation");
const { withRedisLock } = require("../utils/redisLock");
const votingTallyAbi = require("../../artifacts/contracts/VotingTally.sol/VotingTally.json").abi;
const SUBMIT_LOCK_OPTIONS = {
    lockTimeoutSeconds: 1800,
    pollingTimeoutMs: 5000,
};

let provider = null;
let wallet = null;

function assertRelayerConfigured() {
    if (!process.env.SEPOLIA_RPC_URL || !process.env.PRIVATE_KEY) {
        throw Object.assign(
            new Error("Server is missing SEPOLIA_RPC_URL or PRIVATE_KEY."),
            { status: 500, code: "SERVER_CONFIGURATION_ERROR" }
        );
    }
}

function getRelayerWallet() {
    assertRelayerConfigured();
    if (!provider || !wallet) {
        provider = new ethers.providers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
        wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    }
    return wallet;
}

/**
 * Creates a contract instance connected to the server's gas-paying wallet.
 * @param {string} contractAddress - The address of the VotingTally contract.
 * @returns {ethers.Contract} An Ethers.js Contract instance.
 */
const getContract = (contractAddress) => {
    return new ethers.Contract(contractAddress, votingTallyAbi, getRelayerWallet());
};

function submitLockKey(electionId, nullifierHash) {
    return `submit:nullifier:${electionId}:${nullifierHash}`;
}

function ticketLockKey(submissionTicket) {
    return `submit:ticket:${submissionTicket}`;
}

function extractEthersReason(err) {
    if (err.reason) {
        return err.reason;
    }
    if (err.data && typeof err.data === 'string') {
        return err.data;
    }
    return err.message || "An unknown error occurred.";
}

/**
 * @route   POST /api/elections/:election_id/submit
 * @desc    Receives a ZK proof, public signals, and a single-use submission ticket.
 * It validates the ticket first. If valid, it submits the proof to the
 * smart contract. It then deletes the ticket.
 * @access  Public / Anonymous(Protected by single-use ticket mechanism)
 * @param   {string} req.params.election_id - The UUID of the election.
 * @param   {object} req.body.formattedProof - The Groth16 proof (a, b, c).
 * @param   {string[]} req.body.publicSignals - The public signals.
 * @param   {string} req.body.submissionTicket - The single-use ticket from the /proof endpoint.
 * @returns {object} Success message with transaction hash, or error details.
 */
router.post("/", async (req, res) => {
    // --- 1. Extract and Validate Input ---
    const { election_id } = req.params;
    const { formattedProof, publicSignals, submissionTicket } = req.body;

    // --- 2. Validate ProofData ---
    // Basic validation of the proof structure.
    if (!validateFormattedProof(formattedProof) || !Array.isArray(publicSignals) || publicSignals.length !== PUBLIC_SIGNAL_COUNT) {
        return res.status(400).json({ error: "INVALID_PAYLOAD", details: "Proof or public signals are missing or malformed." });
    }

    // --- 3. Validate Submission Ticket ---
    // This is the primary security check, replacing auth and IP rate limiting.
    if (!submissionTicket) {
        console.warn(`[${election_id}] Submission attempt failed: No ticket provided.`);
        return res.status(401).json({ 
            error: "SUBMISSION_TICKET_REQUIRED", 
            details: "A valid submission ticket is required to vote." 
        });
    }

    try {
        assertRelayerConfigured();
    } catch (configError) {
        console.error(`[${election_id}] Submit relayer is not configured:`, configError.message);
        return res.status(configError.status || 500).json({
            error: configError.code || "SERVER_CONFIGURATION_ERROR",
            details: "Server is missing required blockchain relayer configuration."
        });
    }

    try {
        // --- 4. Fetch Election Details & Perform Off-Chain Validation ---
        const { data: election, error: electionError } = await supabase
            .from("Elections")
            .select("contract_address, voting_start_time, voting_end_time, merkle_root, num_candidates")
            .eq("id", election_id)
            .single();

        if (electionError || !election) {
            console.warn(`[${election_id}] Vote submission failed: Election not found.`);
            return res.status(404).json({ 
                error: "ELECTION_NOT_FOUND", 
                details: "Election not found." 
            });
        }

        // Check 1: Ensure election is finalized
        if (!election.contract_address || !election.merkle_root) {
            console.warn(`[${election_id}] Vote submission failed: Election is not finalized.`);
            return res.status(403).json({ 
                error: "NOT_FINALIZED", 
                details: "Voting for this election is not yet finalized by the admin." 
            });
        }

        // Check 2: Ensure the voting period is active.
        const now = new Date();
        const votingStartTime = new Date(election.voting_start_time);
        const votingEndTime = new Date(election.voting_end_time);
        if (now < votingStartTime || now > votingEndTime) {
            console.warn(`[${election_id}] Vote submission failed: Voting period is not active.`);
            return res.status(403).json({ 
                error: "VOTING_PERIOD_INACTIVE", 
                details: `The voting period is not active.` 
            });
        }

        // --- 5. Submit On-Chain Transaction (Gas Relaying) ---
        const votingTallyContract = getContract(election.contract_address);
        const { a, b, c } = formattedProof;
        const nullifierHash = publicSignals[PUBLIC_SIGNAL_NULLIFIER_INDEX].toString();

        return await withRedisLock(ticketLockKey(submissionTicket), async () => {
            let ticketPayload;
            try {
                ticketPayload = await readSubmissionTicket(submissionTicket);
            } catch (redisError) {
                console.error(`[${election_id}] Redis ticket read error:`, redisError.message);
                return res.status(500).json({
                    error: "SERVER_ERROR",
                    details: "Failed to validate submission ticket."
                });
            }

            if (!ticketPayload) {
                console.warn(`[${election_id}] Submission attempt failed: Invalid or expired ticket provided (Ticket: ${submissionTicket}).`);
                return res.status(403).json({
                    error: "INVALID_OR_EXPIRED_TICKET",
                    details: "The submission ticket is invalid, has expired, or has already been used."
                });
            }

            const payloadValidation = validateSubmitPayload({
                electionId: election_id,
                formattedProof,
                publicSignals,
                ticketPayload,
                election,
            });
            if (!payloadValidation.ok) {
                return res.status(payloadValidation.status).json({
                    error: payloadValidation.error,
                    details: payloadValidation.details,
                });
            }

            return await withRedisLock(submitLockKey(election_id, nullifierHash), async () => {
                const alreadyUsed = await votingTallyContract.usedNullifiers(nullifierHash);
                if (alreadyUsed) {
                    return res.status(409).json({
                        error: "VOTE_ALREADY_CAST",
                        details: "This nullifier has already been used for this election."
                    });
                }

                try {
                    await votingTallyContract.callStatic.submitTally(a, b, c, publicSignals);
                } catch (callError) {
                    return res.status(400).json({
                        error: "PROOF_REJECTED",
                        details: extractEthersReason(callError)
                    });
                }

                const consumedPayload = await consumeSubmissionTicket(submissionTicket);
                if (!consumedPayload) {
                    return res.status(403).json({
                        error: "INVALID_OR_EXPIRED_TICKET",
                        details: "The submission ticket was already used or expired."
                    });
                }

                const tx = await votingTallyContract.submitTally(a, b, c, publicSignals);
                const receipt = await tx.wait();

                // --- Success Response ---
                return res.status(200).json({
                    success: true,
                    message: "Your vote has been successfully and anonymously cast.",
                    transactionHash: receipt.transactionHash
                });
            }, SUBMIT_LOCK_OPTIONS);
        }, SUBMIT_LOCK_OPTIONS);

    } catch (err) {
        console.error(`Error submitting vote:`, err);
        if (err.message && err.message.includes("Failed to acquire Redis lock")) {
            return res.status(429).json({
                error: "SUBMISSION_IN_PROGRESS",
                details: "A submission for this nullifier is already being processed."
            });
        }
        return res.status(500).json({
            error: "An on-chain error occurred while submitting your vote.",
            details: extractEthersReason(err)
        });
    }
});

module.exports = router;
