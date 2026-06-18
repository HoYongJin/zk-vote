const hre = require("hardhat");

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

async function main() {
  const depth = requiredEnv("MERKLE_TREE_DEPTH");
  const numCandidates = requiredEnv("NUM_CANDIDATES");
  const contractName = `Groth16Verifier_${depth}_${numCandidates}`;

  const Verifier = await hre.ethers.getContractFactory(contractName);
  const verifier = await Verifier.deploy();
  await verifier.waitForDeployment();
  console.log(`${contractName} deployed at:`, await verifier.getAddress());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
