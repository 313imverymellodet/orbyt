// Smoke test against a deployed orbyt-api: catalog, art, metadata, and a full SIWE link/unlink with a throwaway key.
//   node smoke-base.mjs [apiUrl]
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";

const API = process.argv[2] || "https://orbyt-api-production-29f6.up.railway.app";
const get = (p) => fetch(API + p).then(async (r) => ({ code: r.status, type: r.headers.get("content-type"), body: await r.text() }));
const post = (p, b) => fetch(API + p, { method: "POST", body: JSON.stringify(b) }).then(async (r) => ({ code: r.status, ...(await r.json()) }));
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) process.exitCode = 1; };

const cat = JSON.parse((await get("/api/base/catalog")).body);
ok(cat.badges.length === 35 && Object.keys(cat.games).length === 11, `catalog: ${cat.badges.length} badges, ${Object.keys(cat.games).length} games`);
const svg = await get("/api/base/badge/1103.svg");
ok(svg.code === 200 && /svg/.test(svg.type), "badge art");
const meta = JSON.parse((await get("/api/base/badge/1103.json")).body);
ok(meta.name && meta.image.endsWith("1103.svg"), "metadata: " + meta.name);

const h = await post("/api/base/hello", { game: "hub" });
ok(h.pid && h.key, "anonymous player id");
const { nonce } = JSON.parse((await get("/api/base/nonce")).body);
const acct = privateKeyToAccount(generatePrivateKey());
const message = createSiweMessage({ domain: "orbyt-arcade.vercel.app", address: acct.address, statement: "Smoke test", uri: "https://orbyt-arcade.vercel.app", version: "1", chainId: 8453, nonce });
const signature = await acct.signMessage({ message });
const l = await post("/api/base/link", { pid: h.pid, key: h.key, message, signature });
ok(l.code === 200 && l.address && l.address.toLowerCase() === acct.address.toLowerCase(), "Sign in with Ethereum link verified on Base");
const replay = await post("/api/base/link", { pid: h.pid, key: h.key, message, signature });
ok(replay.code !== 200, "nonce replay rejected");
const u = await post("/api/base/unlink", { pid: h.pid, key: h.key });
ok(u.code === 200 && !u.address, "unlink");
const c = await post("/api/base/claim", { pid: h.pid, key: h.key });
ok(c.code !== 500, "claim without a wallet handled (" + c.code + ")");
