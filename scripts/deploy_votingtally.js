const hre = require("hardhat");
require("dotenv").config();

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function electionIdToUint(value) {
  if (/^[0-9]+$/.test(value)) {
    return BigInt(value);
  }
  if (/^[0-9a-fA-F-]{36}$/.test(value)) {
    return BigInt(`0x${value.replace(/-/g, "")}`);
  }
  throw new Error("ELECTION_ID must be a decimal uint256 or UUID.");
}

async function main() {
  const verifierAddress = requiredEnv("VERIFIER_CONTRACT_ADDRESS");
  const electionId = electionIdToUint(requiredEnv("ELECTION_ID"));
  const numCandidates = BigInt(requiredEnv("NUM_CANDIDATES"));
  const [deployer] = await hre.ethers.getSigners();
  const ownerAddress = process.env.OWNER_ADDRESS || deployer.address;
  if (!process.env.OWNER_ADDRESS) {
    console.warn("WARNING: OWNER_ADDRESS not set; deployer will own configureElection rights.");
  }

  const VotingTally = await hre.ethers.getContractFactory("VotingTally");
  const votingTally = await VotingTally.deploy(
    verifierAddress,
    electionId,
    numCandidates,
    ownerAddress
  );
  await votingTally.waitForDeployment();

  console.log("VotingTally deployed at:", await votingTally.getAddress());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
