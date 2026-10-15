require("@nomicfoundation/hardhat-toolbox-viem");

// Keys come from the environment only; nothing secret lives in this repo.
//   DEPLOYER_KEY   private key of the wallet paying for the one-time deploy (needs a little ETH on Base)
const accounts = process.env.DEPLOYER_KEY ? [process.env.DEPLOYER_KEY] : [];

module.exports = {
  solidity: { version: "0.8.24", settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" } },
  networks: {
    baseSepolia: { url: process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org", chainId: 84532, accounts },
    base: { url: process.env.BASE_RPC || "https://mainnet.base.org", chainId: 8453, accounts },
  },
};
