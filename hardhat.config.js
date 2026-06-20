require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
    solidity: "0.8.20",
    networks: {
      sepolia: {
        url: process.env.SEPOLIA_RPC_URL || "", // Infura나 Alchemy에서 받은 RPC URL
        // PROJECT_PLAN §0.5 gap #1: pin the chain id so Hardhat rejects an RPC URL
        // that points at the wrong network (a mis-set SEPOLIA_RPC_URL would
        // otherwise deploy to whatever chain the URL serves).
        chainId: 11155111,
        accounts:
          process.env.PRIVATE_KEY !== undefined ? [process.env.PRIVATE_KEY] : [],
      },
    },
    etherscan: {
        apiKey: process.env.ETHERSCAN_API_KEY,
    },
    sourcify: {
        enabled: false
    },
  };
