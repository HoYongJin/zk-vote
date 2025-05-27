require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  networks: {
    zkevm: {
      url: process.env.ZKEVM_RPC_URL, 
      accounts: [process.env.PRIVATE_KEY],
    },
  },
  solidity: "0.8.28",
};
