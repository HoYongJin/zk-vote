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
    etherscan: {
        apiKey: {
            polygonZkEVMTestnet: "HRAKGS66KPZJ248PTC5F4IXWBMK28VVIKW", // Etherscan 계정에서 발급
        },
        customChains: [
            {
                network: "zkevm",
                chainId: 1442, // Cardona 테스트넷 체인 ID
                urls: {
                apiURL: "https://api-cardona-zkevm.polygonscan.com/api",
                browserURL: "https://cardona-zkevm.polygonscan.com",
                },
            },
        ],
    },
};
