const hre = require("hardhat");
const supabase = require("../server/supabaseClient"); // Import Supabase client from the server directory.
require("dotenv").config();

async function main() {
    // --- 1. Get Election UUID ---
    const electionUUID = process.env.ELECTION_UUID;
    if (!electionUUID) {
        console.error("Error: ELECTION_UUID environment variable must be set.");
        console.log("Usage: ELECTION_UUID=<your-uuid> npx hardhat run scripts/deployAll.js --network sepolia");
        process.exit(1);
    }
    console.log(`Deploying contracts for Election UUID: [${electionUUID}]`);

    // --- 2. Fetch Election Details from Database ---
    // MODIFIED: Also select `candidates` to pass to the VotingTally constructor and find the correct Verifier.
    const { data: election, error } = await supabase
        .from("Elections")
        .select("id, merkle_tree_depth, num_candidates") 
        .eq("id", electionUUID)
        .single();

    if (error) {
        console.error("Supabase query failed! Details:", error);
        return;
    }
    if (!election) {
        console.error("Could not find the specified election in the database.");
        return;
    }
    // MODIFIED: Add a validation check for `num_candidates`.
    if (typeof election.num_candidates !== 'number' || election.num_candidates <= 0) {
        console.error("Error: `num_candidates` for the election is not set or is invalid in the database.");
        return;
    }

    // --- Convert UUID to uint256 for the contract ---
    const hexUUID = "0x" + election.id.replace(/-/g, "");
    const electionId = BigInt(hexUUID);

    // --- 3. Deploy the Correct Verifier Contract ---
    // MODIFIED: The verifier name now includes both depth and number of num_candidates for precision.
    const verifierContractName = `Groth16Verifier_${election.merkle_tree_depth}_${election.num_candidates}`;
    console.log(`Attempting to deploy Verifier: ${verifierContractName}...`);
    
    let Verifier;
    try {
        Verifier = await hre.ethers.getContractFactory(verifierContractName);
    } catch (e) {
        console.error(`\nError: Could not find the contract factory for "${verifierContractName}".`);
        console.error("Please ensure you have run the `setUpZk.sh` script for this specific depth and candidate count.");
        console.error(`Example: bash server/zkp/setUpZk.sh ${election.merkle_tree_depth} ${election.num_candidates}\n`);
        process.exit(1);
    }

    const verifier = await Verifier.deploy();
    await verifier.waitForDeployment();
    const verifierAddress = await verifier.getAddress();
    console.log(`${verifierContractName} deployed to: ${verifierAddress}`);

    // --- 4. Deploy the VotingTally Contract ---
    // MODIFIED: Pass all three required arguments to the constructor.
    const VotingTally = await hre.ethers.getContractFactory("VotingTally");
    const votingTally = await VotingTally.deploy(
        verifierAddress,
        electionId,
        election.num_candidates // Pass the number of num_candidates
    );
    await votingTally.waitForDeployment();
    const votingTallyAddress = await votingTally.getAddress();
    console.log(`VotingTally deployed to: ${votingTallyAddress}`);

    // --- 5. Update the Database with the Deployed Contract Address ---
    const { error: updateError } = await supabase
        .from("Elections")
        .update({ contract_address: votingTallyAddress })
        .eq("id", electionUUID);

    if (updateError) {
        console.error("Failed to update contract address in DB:", updateError);
    } else {
        console.log("Successfully updated the contract address in the database.");
    }

    // --- 6. Verify Contracts on Etherscan ---
    console.log("\nStarting contract verification on Etherscan (will wait 30s)...");
    
    await new Promise(resolve => setTimeout(resolve, 30000)); // Wait for Etherscan to index the transaction.

    try {
        await hre.run("verify:verify", {
            address: verifierAddress,
            constructorArguments: [],
        });
        console.log(`Verification successful for ${verifierContractName}`);
    } catch (e) {
        if (e.message.toLowerCase().includes("already verified")) {
            console.log(`${verifierContractName} is already verified.`);
        } else {
            console.error(`Failed to verify ${verifierContractName}:`, e.message);
        }
    }

    try {
        await hre.run("verify:verify", {
            address: votingTallyAddress,
            // MODIFIED: Provide the correct constructor arguments for verification.
            constructorArguments: [
                verifierAddress,
                electionId.toString(),
                election.num_candidates,
            ],
        });
        console.log("Verification successful for VotingTally");
    } catch (e) {
        if (e.message.toLowerCase().includes("already verified")) {
            console.log("VotingTally is already verified.");
        } else {
            console.error("Failed to verify VotingTally:", e.message);
        }
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
