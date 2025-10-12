// server/routes/setupAndDeploy.js
const express = require("express");
const router = express.Router({ mergeParams: true });
const { exec } = require("child_process");
const util = require("util");
const fs = require("fs");
const path = require("path");
const supabase = require("../supabaseClient");
const authAdmin = require("../middleware/authAdmin");

const execPromise = util.promisify(exec);

/**
 * @route   POST /api/elections/:election_id/setup-and-deploy
 * @desc    (Admin) Conditionally runs ZKP setup and always runs contract deployment.
 * @access  Admin
 */
router.post("/", authAdmin, async (req, res) => {
    const { election_id } = req.params;

    try {
        const { data: election, error: dbError } = await supabase
            .from("Elections")
            .select("merkle_tree_depth, num_candidates")
            .eq("id", election_id)
            .single();

        if (dbError || !election) {
            return res.status(404).json({ message: "Election with the given ID not found." });
        }

        const depth = election.merkle_tree_depth;
        const num_candidates = election.num_candidates;

        // 3. Construct the verifier contract's filename and its full path
        const verifierContractName = `Groth16Verifier_${depth}_${num_candidates}.sol`;
        const contractPath = path.join(__dirname, `../../contracts/${verifierContractName}`);

        // 4. Check if the verifier contract file already exists
        if (fs.existsSync(contractPath)) {
            console.log(`[${election_id}] Verifier contract '${verifierContractName}' already exists. Skipping ZKP setup.`);
        } else {
            // --- File does NOT exist, so run setUpZk.sh ---
            console.log(`[${election_id}] Verifier contract not found. Starting ZKP setup (depth: ${depth}, candidates: ${num_candidates})...`);
            
            const { stdout: zkStdout, stderr: zkStderr } = await execPromise(
                // It's safer to use absolute paths
                `cd /home/ubuntu/zk-vote/server/zkp/ && ./setUpZk.sh ${depth} ${num_candidates}`
            );

            if (zkStderr) {
                console.error(`[${election_id}] ZKP setup error:`, zkStderr);
            }
            console.log(`[${election_id}] ZKP setup complete.`);
            console.log(zkStdout);
        }

        // --- 5. Always run deployAll.js script ---
        console.log(`[${election_id}] Starting contract deployment...`);
        const { stdout: deployStdout, stderr: deployStderr } = await execPromise(
            `cd /home/ubuntu/zk-vote/ && ELECTION_UUID=${election_id} npx hardhat run scripts/deployAll.js --network sepolia`
        );

        if (deployStderr) {
            console.error(`[${election_id}] Contract deployment error:`, deployStderr);
        }
        console.log(`[${election_id}] Contract deployment complete.`);
        console.log(deployStdout);

        res.status(200).json({ message: "Deployment process finished successfully." });

    } catch (err) {
        console.error("Script execution process error:", err.message);
        res.status(500).json({ message: "An error occurred during script execution.", error: err.message });
    }
});

module.exports = router;