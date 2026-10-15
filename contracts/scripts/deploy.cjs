// Deploys OrbytBadges.
//   DEPLOYER_KEY=0x...   (pays the one-time deploy, becomes admin unless BADGES_ADMIN is set)
//   BADGES_MINTER=0x...  (address of the game server's minter wallet; required)
//   BADGES_ADMIN=0x...   (optional: a multisig / safer wallet to hold the admin role)
//   BADGES_URI=https://.../api/base/badge/   (optional; defaults to the live orbyt-api)
//   npx hardhat run scripts/deploy.cjs --network baseSepolia   (test first)   then   --network base
const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.viem.getWalletClients();
  const minter = process.env.BADGES_MINTER;
  if (!minter) throw new Error("Set BADGES_MINTER to the server minter wallet address");
  const admin = process.env.BADGES_ADMIN || deployer.account.address;
  const uri = process.env.BADGES_URI || "https://orbyt-api-production-29f6.up.railway.app/api/base/badge/";
  console.log("network ", hre.network.name);
  console.log("deployer", deployer.account.address);
  console.log("admin   ", admin);
  console.log("minter  ", minter);
  const badges = await hre.viem.deployContract("OrbytBadges", [admin, minter, uri]);
  console.log("\nOrbytBadges deployed at", badges.address);
  console.log("Set BASE_BADGES_ADDRESS=" + badges.address + " (and BASE_CHAIN=" + (hre.network.name === "base" ? "base" : "baseSepolia") + ") on the orbyt-api service.");
}

main().catch((e) => { console.error(e); process.exit(1); });
