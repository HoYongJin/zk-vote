const hre = require("hardhat");
require("dotenv").config();

async function main() {
  const verifierAddress = process.env.VERIFIER_CONTRACT_ADDRESS;

  const VotingTally = await hre.ethers.getContractFactory("VotingTally");
  const votingTally = await VotingTally.deploy(verifierAddress);
  await votingTally.waitForDeployment();

  console.log("VotingTally deployed at:", votingTally.target);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
