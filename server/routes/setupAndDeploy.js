/**
 * @file server/routes/setupAndDeploy.js
 * @desc Route handler for triggering ZKP setup (if needed) and smart contract deployment
 * for a specific election. Requires admin privileges.
 */

const express = require("express");
const router = express.Router({ mergeParams: true });
const { exec } = require("child_process");
const util = require("util");
const fs = require("fs");
const path = require("path");
const supabase = require("../supabaseClient");
const authAdmin = require("../middleware/authAdmin");
const execPromise = util.promisify(exec);

// Calculate project root directory relative to this file's location (__dirname)
// __dirname = /path/to/project/server/routes
// projectRoot = /path/to/project
const projectRoot = path.resolve(__dirname, '../../');

/**
 * @route   POST /api/elections/:election_id/setZkDeploy
 * @desc    Initiates the Zero-Knowledge Proof setup and deploys
 * the associated smart contracts (Verifier, VotingTally) for a given election.
 * It first checks if the necessary verifier contract (.sol file) exists.
 * If not, it runs the `setUpZk.sh` script to generate ZKP artifacts and the verifier.
 * Finally, it always runs the `deployAll.js` script to deploy contracts to the network.
 * @access  Private (Admin Only - enforced by authAdmin middleware)
 * @param   {string} req.params.election_id - The UUID of the election to set up and deploy.
 * @param   {object} req.admin - The admin user object (attached by authAdmin middleware).
 * @returns {object} Success message or error details.
 */
router.post("/", authAdmin, async (req, res) => {
    const { election_id } = req.params;

    console.log(`[${election_id}] Received request to setup ZKP and deploy contracts.`);

    try {
        const circomlibPath = path.join(projectRoot, "server", "node_modules", "circomlib", "circuits");
        const poseidonPath = path.join(circomlibPath, "poseidon.circom");
        console.log(`[${election_id}][Diag] Checking for poseidon.circom at: ${poseidonPath}`);

        if (!fs.existsSync(poseidonPath)) {
            console.error(`[${election_id}][Diag Fail] poseidon.circom not found! Ensure 'npm install circomlib' was run in the 'server' directory.`);
            // Return a server error as this indicates an environment setup problem.
            return res.status(500).json({ 
                error: "SERVER_SETUP_ERROR", 
                details: "Core ZKP library file (poseidon.circom) not found. Please check server logs." 
            });
        }
        console.log(`[${election_id}][Diag Success] poseidon.circom found.`);

        // --- 1. Fetch Election Details ---
        // Get merkle_tree_depth and num_candidates needed for ZKP setup/deployment scripts.
        const { data: election, error: dbError } = await supabase
            .from("Elections")
            .select("merkle_tree_depth, num_candidates")
            .eq("id", election_id)
            .single();

        // Handle database errors or election not found.
        if (dbError) {
            console.error(`[${election_id}] Error fetching election details:`, dbError.message);
            if (dbError.code === 'PGRST116') { // Specific Supabase code for "No rows found" from .single()
                return res.status(404).json({ 
                    error: "ELECTION_NOT_FOUND", 
                    details: `Election with ID ${election_id} not found.` 
                });
            }
            throw dbError;
        }

        // Handle database errors or election not found.
        if (dbError) {
            console.error(`[${election_id}] Error fetching election details:`, dbError.message);
            if (dbError.code === 'PGRST116') { // Specific Supabase code for "No rows found" from .single()
                return res.status(404).json({ 
                    error: "ELECTION_NOT_FOUND", 
                    details: `Election with ID ${election_id} not found.` 
                });
            }
            throw dbError; // Throw other potential database errors
        }

        const depth = election.merkle_tree_depth;
        const num_candidates = election.num_candidates;
        console.log(`[${election_id}] Election details found: depth=${depth}, candidates=${num_candidates}`);

        // --- 2. Check if ZKP Setup is Needed ---
        // The existence of the specific Verifier .sol file indicates if setup was previously completed.
        const verifierContractName = `Groth16Verifier_${depth}_${num_candidates}.sol`;
        const contractSolPath = path.join(projectRoot, "contracts", verifierContractName);

        console.log(`[${election_id}] Checking for Verifier contract at: ${contractSolPath}`);

        // Check if the verifier contract file already exists
        if (fs.existsSync(contractSolPath)) {
            console.log(`[${election_id}] Verifier contract '${verifierContractName}' already exists. Skipping ZKP setup script.`);
        } else {
            // --- 3. Run ZKP Setup Script (if needed) ---
            console.log(`[${election_id}] Verifier contract not found. Starting ZKP setup script (setUpZk.sh)...`);

            const zkpScriptPath = path.join(projectRoot, "server", "zkp", "setUpZk.sh"); 
            const zkpWorkingDir = path.dirname(zkpScriptPath);
            
            try {
                // Execute the script from its directory. Pass depth and candidates as arguments.
                // Ensure setUpZk.sh is executable (chmod +x).
                console.log(`[${election_id}] Executing: bash ${zkpScriptPath} ${depth} ${num_candidates} in ${zkpWorkingDir}`);
                const { stdout: zkStdout, stderr: zkStderr } = await execPromise(
                    // Using bash explicitly and providing full script path
                    `bash ${zkpScriptPath} ${depth} ${num_candidates}`,
                    { cwd: zkpWorkingDir } // Set the working directory for the script
                );

                if (zkStderr) {
                    console.warn(`[${election_id}] ZKP setup script stderr output:`, zkStderr);
                }
                console.log(`[${election_id}] ZKP setup script completed successfully.`);
                console.log(`[${election_id}] ZKP setup script stdout:`, zkStdout);

                // check if the expected .sol file was created.
                if (!fs.existsSync(contractSolPath)) {
                     console.error(`[${election_id}] CRITICAL ERROR: setUpZk.sh seemingly ran but did not create ${verifierContractName} at expected path ${contractSolPath}! Check script logs and permissions.`);
                     throw new Error(`ZKP setup script failed to create the expected verifier contract file.`);
                }
                console.log(`[${election_id}] Verified that ${verifierContractName} was created at ${contractSolPath}.`);

            } catch (scriptError) {
                // execPromise rejects if the script exits with a non-zero code.
                // The error object often contains stdout and stderr from the failed process.
                console.error(`[${election_id}] ZKP setup script execution failed (Exit Code: ${scriptError.code}):`, scriptError.stderr || scriptError.stdout || scriptError.message);
                // Return a 500 error indicating script failure. Include stderr if available for debugging.
                return res.status(500).json({
                    error: "ZKP_SETUP_FAILED",
                    // Provide stderr if available, otherwise a generic message.
                    details: scriptError.stderr || "ZKP setup script failed. Check server logs for details."
                });
            }
        }

        // --- 4. Always Run Contract Deployment Script ---
        // This script is responsible for deploying the correct Verifier (based on depth/candidates)
        // and the main VotingTally contract, linking them if necessary.
        console.log(`[${election_id}] Starting contract deployment script (deployAll.js)...`);
        // Define the path to the deployment script relative to projectRoot.
        const deployScriptPath = path.join(projectRoot, "scripts", "deployAll.js");

        try {
            // Execute the Hardhat deployment script using npx.
            // Pass the election UUID as an environment variable using the 'env' option for reliability across platforms.
            console.log(`[${election_id}] Executing: npx hardhat run ${deployScriptPath} --network sepolia with ELECTION_UUID=${election_id}`);
            const { stdout: deployStdout, stderr: deployStderr } = await execPromise(
                // Command to run the hardhat script on the sepolia network
                `npx hardhat run ${deployScriptPath} --network sepolia`,
                {
                    cwd: projectRoot, // Run hardhat commands from the project root directory
                    env: { // Pass environment variables securely and reliably
                        ...process.env, // Inherit existing environment variables (like ALCHEMY_API_KEY, PRIVATE_KEY needed by hardhat)
                        ELECTION_UUID: election_id // Pass the specific election ID to the script
                    }
                }
            );

            // Log stderr even on success, as it might contain warnings.
            if (deployStderr) {
                console.warn(`[${election_id}] Contract deployment script stderr output:`, deployStderr);
            }
            console.log(`[${election_id}] Contract deployment script completed successfully.`);
            console.log(`[${election_id}] Contract deployment script stdout:`, deployStdout);

            // --- 5. Success Response ---
            return res.status(200).json({
                success: true,
                message: "ZKP setup (if needed) and contract deployment process finished successfully."
            });

        } catch (scriptError) {
            // Handle failures during the deployment script execution.
            console.error(`[${election_id}] Contract deployment script execution failed (Exit Code: ${scriptError.code}):`, scriptError.stderr || scriptError.stdout || scriptError.message);
            return res.status(500).json({
                error: "DEPLOYMENT_FAILED",
                // Provide stderr if available for debugging.
                details: scriptError.stderr || "Contract deployment script failed. Check server logs for details."
            });
        }

    } catch (err) {
        // --- 6. General Error Handling ---
        // Catch errors from initial DB queries or unexpected issues (like path resolution).
        console.error(`[${election_id}] Unexpected error in setupAndDeploy endpoint:`, err.message);
        return res.status(500).json({
            error: "SERVER_ERROR",
            details: "An internal server error occurred during the setup and deployment process."
            // In production, avoid sending raw err.message to the client. Use a correlation ID if needed.
            // details: err.message // Use this only for debugging
        });
    }
});

module.exports = router;