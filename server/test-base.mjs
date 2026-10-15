// End-to-end test of /api/base/* against an in-memory Postgres (PGlite).
//   node test-base.mjs                    -> off-chain flow + sign-in (mint closed)
//   BASE_CHAIN=local BASE_RPC=http://127.0.0.1:8545 BASE_BADGES_ADDRESS=0x.. BASE_MINTER_KEY=0x.. node test-base.mjs  -> also mints
import http from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { initBase, baseHttp } from "./base.js";

const lite = new PGlite();
const pool = { query: (q, p) => (p ? lite.query(q, p) : lite.exec(q).then((r) => r[r.length - 1] || { rows: [] })) };
await initBase(pool);
const send = (res, code, body) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
const srv = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try { if (!(await baseHttp(req, res, url, { send, ipOf: () => "1" }))) send(res, 404, {}); } catch (e) { console.error(e); send(res, 500, { e: e.message }); }
}).listen(0);
const port = srv.address().port, API = "http://127.0.0.1:" + port;
const post = (p, b) => fetch(API + p, { method: "POST", body: JSON.stringify(b) }).then(async (r) => ({ code: r.status, ...(await r.json().catch(() => ({}))) }));
const get = (p) => fetch(API + p).then(async (r) => ({ code: r.status, ...(await r.json().catch(() => ({}))) }));
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? "  ok   " : "  FAIL ") + msg); if (!cond) fails++; };

const a = await post("/api/base/hello", { game: "snackmerge" });
ok(/^[a-z0-9]{20}$/.test(a.pid) && a.key.length === 32, "hello issues a player id");
const again = await post("/api/base/hello", { pid: a.pid, key: a.key });
ok(again.pid === a.pid, "hello keeps a valid id");
ok((await post("/api/base/ev", { pid: a.pid, key: "x".repeat(32), game: "snackmerge", e: [["monster_fed", 1]] })).code === 401, "forged key rejected");

let r = await post("/api/base/ev", { pid: a.pid, key: a.key, game: "snackmerge", e: [["monster_fed", 3], ["page_view", 0]] });
ok(r.earned.join() === "101", "First Bite earned on first feed");
r = await post("/api/base/ev", { pid: a.pid, key: a.key, game: "snackmerge", e: [["monster_fed", 3]] });
ok(r.earned.length === 0, "no double award");
r = await post("/api/base/ev", { pid: a.pid, key: a.key, game: "orbitdepot", e: [["ship_bin", 40], ["ship_bin", 5000]] });
ok(r.earned.join() === "1001", "depot first shipment");
let me = await get(`/api/base/me?pid=${a.pid}&key=${a.key}`);
ok(me.progress[1003] === 100, "sum rules cap a single event (40 + 60 cap = 100)");
r = await post("/api/base/ev", { pid: a.pid, key: a.key, game: "bonkbrawl", e: [["hats_end", 2], ["hats_end", 6]] });
ok(r.earned.includes(402) && r.earned.includes(1), "Hat Tower via max rule, and Arcade Explorer for 3 games: " + r.earned.join());
ok((await post("/api/base/ev", { pid: a.pid, key: a.key, game: "nope", e: [] })).code === 400, "unknown game rejected");

// sign in with an ephemeral test account (a plain EOA; Base Accounts add ERC-6492, which viem also verifies)
const acct = privateKeyToAccount(generatePrivateKey());
let { nonce } = await get("/api/base/nonce");
const msg = (n, domain = "snackmerge.vercel.app") => createSiweMessage({ address: acct.address, chainId: 8453, domain, nonce: n, uri: "https://" + domain, version: "1", issuedAt: new Date() });
let message = msg(nonce), signature = await acct.signMessage({ message });
me = await post("/api/base/link", { pid: a.pid, key: a.key, message, signature });
ok(me.address === acct.address, "Sign in with Base links the wallet");
ok((await post("/api/base/link", { pid: a.pid, key: a.key, message, signature })).code === 400, "nonce can't be replayed");
({ nonce } = await get("/api/base/nonce"));
message = msg(nonce, "evil.example.com"); signature = await acct.signMessage({ message });
ok((await post("/api/base/link", { pid: a.pid, key: a.key, message, signature })).code === 400, "other sites can't sign players in");
({ nonce } = await get("/api/base/nonce"));
message = msg(nonce); signature = await privateKeyToAccount(generatePrivateKey()).signMessage({ message });
ok((await post("/api/base/link", { pid: a.pid, key: a.key, message, signature })).code === 401, "a signature from another wallet fails");

// second device, same wallet: badges merge
const b = await post("/api/base/hello", { game: "graveshift" });
await post("/api/base/ev", { pid: b.pid, key: b.key, game: "graveshift", e: [["run_win", 480]] });
({ nonce } = await get("/api/base/nonce"));
message = msg(nonce, "graveshift.vercel.app"); signature = await acct.signMessage({ message });
me = await post("/api/base/link", { pid: b.pid, key: b.key, message, signature });
ok([101, 501, 1001, 402, 1].every((x) => me.earned.includes(x)), "both devices' badges merge under the wallet: " + me.earned.join());
const pub = await get("/api/base/profile/" + acct.address);
ok(pub.earned.length === me.earned.length, "public profile matches");

const meta = await get("/api/base/badge/402.json");
ok(meta.name === "Hat Tower" && /402\.svg$/.test(meta.image), "ERC-1155 metadata");
const svg = await fetch(API + "/api/base/badge/402.svg").then((x) => x.text());
ok(svg.startsWith("<svg") && svg.includes("HAT TOWER"), "badge art renders");

const claim = await post("/api/base/claim", { pid: a.pid, key: a.key });
if (claim.pending) ok(true, "mint closed: claim reports pending (no contract configured)");
else {
  ok(/^0x[0-9a-f]{64}$/.test(claim.tx) && claim.ids.length === me.earned.length, "claim minted " + claim.ids.join() + " in " + claim.tx);
  ok((await post("/api/base/claim", { pid: b.pid, key: b.key })).code === 429, "claims are throttled per wallet");
  globalThis.__minted = { tx: claim.tx, ids: claim.ids, to: acct.address };
}
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
if (globalThis.__minted) console.log("MINTED", JSON.stringify(globalThis.__minted));
srv.close(); process.exit(fails ? 1 : 0);
