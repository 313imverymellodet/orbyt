const { expect } = require("chai");
const hre = require("hardhat");

describe("OrbytBadges", function () {
  async function setup() {
    const [admin, minter, alice, bob] = await hre.viem.getWalletClients();
    const badges = await hre.viem.deployContract("OrbytBadges", [admin.account.address, minter.account.address, "https://api.test/badge/"]);
    const asMinter = await hre.viem.getContractAt("OrbytBadges", badges.address, { client: { wallet: minter } });
    const asAlice = await hre.viem.getContractAt("OrbytBadges", badges.address, { client: { wallet: alice } });
    return { badges, asMinter, asAlice, admin, minter, alice, bob };
  }

  it("lets the minter award a badge once per wallet", async function () {
    const { badges, asMinter, alice } = await setup();
    await asMinter.write.award([alice.account.address, 101n]);
    expect(await badges.read.balanceOf([alice.account.address, 101n])).to.equal(1n);
    let failed = false;
    try { await asMinter.write.award([alice.account.address, 101n]); } catch (e) { failed = /AlreadyAwarded/.test(e.message); }
    expect(failed).to.equal(true);
  });

  it("batch awards skip badges already held", async function () {
    const { badges, asMinter, alice } = await setup();
    await asMinter.write.award([alice.account.address, 101n]);
    await asMinter.write.awardBatch([alice.account.address, [101n, 102n, 1n]]);
    const bals = await badges.read.balanceOfBatch([[alice.account.address, alice.account.address, alice.account.address], [101n, 102n, 1n]]);
    expect(bals.map(Number)).to.deep.equal([1, 1, 1]);
  });

  it("only the minter can award", async function () {
    const { asAlice, alice } = await setup();
    let failed = false;
    try { await asAlice.write.award([alice.account.address, 101n]); } catch (e) { failed = /AccessControl/.test(e.message); }
    expect(failed).to.equal(true);
  });

  it("is soulbound: no transfers, no approvals", async function () {
    const { asMinter, asAlice, alice, bob } = await setup();
    await asMinter.write.award([alice.account.address, 201n]);
    let t = false, a = false;
    try { await asAlice.write.safeTransferFrom([alice.account.address, bob.account.address, 201n, 1n, "0x"]); } catch (e) { t = /Soulbound/.test(e.message); }
    try { await asAlice.write.setApprovalForAll([bob.account.address, true]); } catch (e) { a = /Soulbound/.test(e.message); }
    expect(t).to.equal(true);
    expect(a).to.equal(true);
  });

  it("owners can burn their own badge", async function () {
    const { badges, asMinter, asAlice, alice } = await setup();
    await asMinter.write.award([alice.account.address, 301n]);
    await asAlice.write.burn([301n]);
    expect(await badges.read.balanceOf([alice.account.address, 301n])).to.equal(0n);
  });

  it("serves per-badge metadata URIs and lets the admin move them", async function () {
    const { badges } = await setup();
    expect(await badges.read.uri([1003n])).to.equal("https://api.test/badge/1003.json");
    await badges.write.setBaseUri(["https://new.test/b/"]);
    expect(await badges.read.uri([7n])).to.equal("https://new.test/b/7.json");
  });

  it("reports ERC-1155 support", async function () {
    const { badges } = await setup();
    expect(await badges.read.supportsInterface(["0xd9b67a26"])).to.equal(true);
  });
});
