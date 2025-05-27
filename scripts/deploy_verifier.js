const hre = require("hardhat");

async function main() {
  const Verifier = await hre.ethers.getContractFactory("Groth16Verifier");
  const verifier = await Verifier.deploy();
  await verifier.waitForDeployment();
  console.log("Verifier deployed at:", verifier.target);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
