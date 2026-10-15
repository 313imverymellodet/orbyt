// Orbyt badges on Base.
//
// Off-chain core (always on):
//   POST /api/base/hello   { pid?, key?, game }            -> { pid, key, me }          anonymous per-device player id
//   POST /api/base/ev      { pid, key, game, e:[[n,v]] }    -> { earned:[ids] }          achievement progress from game events
//   GET  /api/base/me      ?pid&key                         -> profile (merged across every device linked to the same wallet)
//   GET  /api/base/catalog                                  -> every badge, its game and its rule
// Sign in with Base (optional, our own sites only):
//   GET  /api/base/nonce                                    -> { nonce }                 single use, 10 minutes
//   POST /api/base/link    { pid, key, message, signature } -> profile                   SIWE (EIP-4361) via viem, ERC-6492 aware
//   POST /api/base/unlink  { pid, key }
// On-chain (dormant until BASE_BADGES_ADDRESS + BASE_MINTER_KEY are set):
//   POST /api/base/claim   { pid, key }                     -> { tx, ids }               server mints, the player pays nothing
//   GET  /api/base/badge/:id.json | :id.svg                 ERC-1155 metadata + art
//   GET  /api/base/profile/:address                         public badge list for the hub
//
// Badges are soulbound and have no cash value. Progress comes from the same events the games already send
// to analytics; values are capped and rate limited, which is enough for collectibles nobody can sell.
import crypto from "node:crypto";
import { createPublicClient, createWalletClient, http, isAddress, getAddress } from "viem";
import { base, baseSepolia, hardhat } from "viem/chains";
import { parseSiweMessage } from "viem/siwe";
import { privateKeyToAccount } from "viem/accounts";
import { Attribution } from "ox/erc8021";

// ---------------------------------------------------------------- catalog
export const GAMES = {
  snackmerge: { name: "SNACK MONSTER", url: "https://snackmerge.vercel.app", col: "#ff7a3c" },
  kartchaos: { name: "KART CHAOS", url: "https://kartchaos.vercel.app", col: "#ff4f8b" },
  obbyrush: { name: "OBBY RUSH", url: "https://obbyrush.vercel.app", col: "#3cc7ff" },
  bonkbrawl: { name: "BONK BRAWL", url: "https://bonkbrawl.vercel.app", col: "#ffc93c" },
  graveshift: { name: "GRAVE SHIFT", url: "https://graveshift.vercel.app", col: "#7cffb2" },
  spacediner: { name: "SPACE DINER", url: "https://spacediner.vercel.app", col: "#ff5c8a" },
  cityrush: { name: "CITY RUSH", url: "https://cityrush-pearl.vercel.app", col: "#ff9a3c" },
  orbyt: { name: "ORBYT", url: "https://orbyt-wine.vercel.app", col: "#25f4ee" },
  orderup: { name: "ORDER UP!", url: "https://orderup-three.vercel.app", col: "#ffd447" },
  orbitdepot: { name: "ORBIT DEPOT", url: "https://orbitdepot.vercel.app", col: "#3cc7ff" },
  bannerfall: { name: "BANNERFALL", url: "https://bannerfall-lac.vercel.app", col: "#e6c26a" },
};
// tier 1 bronze, 2 silver, 3 gold. Rule: ev (exact) or prefix; count = occurrences, sum = total value, max = best value.
export const BADGES = [
  { id: 101, game: "snackmerge", tier: 1, name: "First Bite", desc: "Feed the Snack Monster its craving.", ev: "monster_fed", count: 1 },
  { id: 102, game: "snackmerge", tier: 2, name: "Jackpot!", desc: "Hit a jackpot merge.", ev: "jackpot", count: 1 },
  { id: 103, game: "snackmerge", tier: 3, name: "Bottomless", desc: "Feed the Monster 150 cravings.", ev: "monster_fed", count: 150 },
  { id: 201, game: "kartchaos", tier: 1, name: "First Bump", desc: "Land your first hit.", ev: "first_hit", count: 1 },
  { id: 202, game: "kartchaos", tier: 2, name: "Coin Heist", desc: "Finish a match carrying 25 coins.", ev: "end_coins", max: 25 },
  { id: 203, game: "kartchaos", tier: 3, name: "Road Rager", desc: "Land 100 hits.", ev: "end_hits", sum: 100, cap: 60 },
  { id: 301, game: "obbyrush", tier: 1, name: "Finish Line", desc: "Finish any course.", prefix: "finish_", count: 1 },
  { id: 302, game: "obbyrush", tier: 2, name: "Time Bender", desc: "Rewind out of 5 falls.", ev: "rewind_save", count: 5 },
  { id: 303, game: "obbyrush", tier: 3, name: "Flawless", desc: "Finish a course without rewinding.", ev: "finish_no_rewind", count: 1 },
  { id: 401, game: "bonkbrawl", tier: 1, name: "Hat Trick", desc: "Steal a hat stack.", ev: "hat_steal", count: 1 },
  { id: 402, game: "bonkbrawl", tier: 2, name: "Hat Tower", desc: "Wear a stack of 5 hats.", ev: "hats_end", max: 5 },
  { id: 403, game: "bonkbrawl", tier: 3, name: "Brawler", desc: "Fight 20 online brawls.", ev: "fight_online", count: 20 },
  { id: 501, game: "graveshift", tier: 1, name: "Dawn Patrol", desc: "Survive until dawn.", ev: "run_win", count: 1 },
  { id: 502, game: "graveshift", tier: 2, name: "Monster Hunter", desc: "Beat the graveyard's three bosses.", ev: "stage2_unlock", count: 1 },
  { id: 503, game: "graveshift", tier: 3, name: "Lamplighter", desc: "Collect 150 lantern oils.", ev: "oil_pickup", count: 150 },
  { id: 601, game: "spacediner", tier: 1, name: "Grand Opening", desc: "Build your first expansion.", prefix: "unlock_", count: 1 },
  { id: 602, game: "spacediner", tier: 2, name: "Rush Hour Hero", desc: "Serve through 10 rush hours.", ev: "rush_hour", count: 10 },
  { id: 603, game: "spacediner", tier: 3, name: "Interplanetary", desc: "Launch your diner to a new planet.", ev: "launch", count: 1 },
  { id: 701, game: "cityrush", tier: 1, name: "Checkered Flag", desc: "Finish a race.", prefix: "finish_", count: 1 },
  { id: 702, game: "cityrush", tier: 2, name: "Weaver", desc: "Weave past 100 cars.", ev: "weave_nearmiss", sum: 100, cap: 80 },
  { id: 703, game: "cityrush", tier: 3, name: "Wrecking Crew", desc: "Score 25 takedowns.", ev: "weave_takedowns", sum: 25, cap: 30 },
  { id: 801, game: "orbyt", tier: 1, name: "Echo Survivor", desc: "Outlive your echo.", ev: "echo_outlived", count: 1 },
  { id: 802, game: "orbyt", tier: 2, name: "Stylist", desc: "Unlock a new skin.", prefix: "unlock_", count: 1 },
  { id: 803, game: "orbyt", tier: 3, name: "Echo Breaker", desc: "Outlive your echo 10 times.", ev: "echo_outlived", count: 10 },
  { id: 901, game: "orderup", tier: 1, name: "First Shift", desc: "Finish a kitchen shift.", prefix: "shift_end_", count: 1 },
  { id: 902, game: "orderup", tier: 2, name: "On The Beat", desc: "Chain a 16-hit beat streak.", ev: "beats_best_streak", max: 16 },
  { id: 903, game: "orderup", tier: 3, name: "Head Chef", desc: "Hit 1,000 beats.", ev: "beats_on_beat", sum: 1000, cap: 400 },
  { id: 1001, game: "orbitdepot", tier: 1, name: "First Shipment", desc: "Ship your first bin.", ev: "ship_bin", count: 1 },
  { id: 1002, game: "orbitdepot", tier: 2, name: "Off-World", desc: "Open a second depot.", ev: "new_depot", max: 2 },
  { id: 1003, game: "orbitdepot", tier: 3, name: "Logistics Legend", desc: "Ship 2,000 boxes.", ev: "ship_bin", sum: 2000, cap: 60 },
  { id: 1101, game: "bannerfall", tier: 1, name: "Town Age", desc: "Advance to the Town Age.", ev: "age_2", count: 1 },
  { id: 1102, game: "bannerfall", tier: 2, name: "Kingdom Age", desc: "Advance to the Kingdom Age.", ev: "age_3", count: 1 },
  { id: 1103, game: "bannerfall", tier: 3, name: "Crowned", desc: "Win a battle for the island.", ev: "match_win", count: 1 },
  { id: 1, game: "arcade", tier: 2, name: "Arcade Explorer", desc: "Earn badges in 3 different games.", games: 3 },
  { id: 2, game: "arcade", tier: 3, name: "Arcade Legend", desc: "Earn badges in 8 different games.", games: 8 },
];
const BY_ID = new Map(BADGES.map((b) => [b.id, b]));
const TIER = ["", "BRONZE", "SILVER", "GOLD"];

function matches(rule, name) { return rule.ev ? rule.ev === name : rule.prefix ? name.startsWith(rule.prefix) : false; }
function goal(b) { return b.count || b.sum || b.max || b.games || 1; }

// ---------------------------------------------------------------- state
let db = null;
const SECRET = crypto.createHash("sha256").update("mello-base-id|" + (process.env.ID_SECRET || process.env.DATABASE_URL || "dev")).digest();
const keyFor = (pid) => crypto.createHmac("sha256", SECRET).update(pid).digest("hex").slice(0, 32);
const okId = (pid, key) => typeof pid === "string" && /^[a-z0-9]{20}$/.test(pid) && typeof key === "string" && key.length === 32 && crypto.timingSafeEqual(Buffer.from(keyFor(pid)), Buffer.from(key));
const nonces = new Map();     // nonce -> expiry ms
const rate = new Map();       // pid -> events this minute
const claimAt = new Map();    // address -> last claim ms

const CHAIN = process.env.BASE_CHAIN === "baseSepolia" ? baseSepolia : process.env.BASE_CHAIN === "local" ? hardhat : base;   // local = tests against a hardhat node
const verifier = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC || undefined) });   // sign-in is always checked on Base mainnet
const chainClient = createPublicClient({ chain: CHAIN, transport: http(process.env.BASE_RPC || undefined) });
const CONTRACT = isAddress(process.env.BASE_BADGES_ADDRESS || "") ? getAddress(process.env.BASE_BADGES_ADDRESS) : null;
let minter = null;
try { if (process.env.BASE_MINTER_KEY) minter = privateKeyToAccount(process.env.BASE_MINTER_KEY); } catch { minter = null; }
const mintOpen = () => !!(CONTRACT && minter);
const wallet = mintOpen() ? createWalletClient({ account: minter, chain: CHAIN, transport: http(process.env.BASE_RPC || undefined) }) : null;
const dataSuffix = process.env.BASE_BUILDER_CODE ? Attribution.toDataSuffix({ codes: [process.env.BASE_BUILDER_CODE] }) : undefined;
const AWARD_ABI = [{ type: "function", name: "awardBatch", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "ids", type: "uint256[]" }], outputs: [] }];

// sign-in is accepted only from our own sites
const SITES = [/^([a-z0-9-]+\.)*vercel\.app$/, /^([a-z0-9-]+\.)*mellovibes\.io$/, /^localhost(:\d+)?$/, /^127\.0\.0\.1(:\d+)?$/];

export async function initBase(pool) {
  db = pool;
  await db.query(`
    CREATE TABLE IF NOT EXISTS base_players (pid TEXT PRIMARY KEY, address TEXT, created TIMESTAMPTZ NOT NULL DEFAULT now(), linked TIMESTAMPTZ);
    CREATE INDEX IF NOT EXISTS base_players_addr ON base_players (address);
    CREATE TABLE IF NOT EXISTS base_prog (pid TEXT NOT NULL, badge INTEGER NOT NULL, val BIGINT NOT NULL DEFAULT 0, PRIMARY KEY (pid, badge));
    CREATE TABLE IF NOT EXISTS base_earned (pid TEXT NOT NULL, badge INTEGER NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (pid, badge));
    CREATE TABLE IF NOT EXISTS base_claims (address TEXT NOT NULL, badge INTEGER NOT NULL, tx TEXT, at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (address, badge));
  `);
  setInterval(() => { rate.clear(); const now = Date.now(); for (const [n, t] of nonces) if (t < now) nonces.delete(n); }, 60e3);
  console.log("[base] badges", BADGES.length, "mint", mintOpen() ? "open on " + CHAIN.name + " " + CONTRACT : "closed (no contract configured)");
}

async function readBody(req) {
  let s = "";
  for await (const c of req) { s += c; if (s.length > 12000) throw new Error("too large"); }
  return s ? JSON.parse(s) : {};
}

// every pid that belongs to the same player: just this device, or every device linked to its wallet
async function pidsOf(pid) {
  const r = await db.query("SELECT address FROM base_players WHERE pid=$1", [pid]);
  const address = r.rows[0]?.address || null;
  if (!address) return { address: null, pids: [pid] };
  const all = await db.query("SELECT pid FROM base_players WHERE address=$1", [address]);
  return { address, pids: all.rows.map((x) => x.pid) };
}

async function profileFor(pids, address) {
  const earned = await db.query("SELECT DISTINCT badge FROM base_earned WHERE pid = ANY($1)", [pids]);
  const prog = await db.query("SELECT badge, max(val) AS best, sum(val) AS total FROM base_prog WHERE pid = ANY($1) GROUP BY badge", [pids]);
  const claimed = address ? await db.query("SELECT badge, tx FROM base_claims WHERE address=$1", [address]) : { rows: [] };
  const have = new Set(earned.rows.map((r) => r.badge));
  // arcade-wide badges are derived from the per-game ones
  const games = new Set([...have].map((id) => BY_ID.get(id)?.game).filter((g) => g && g !== "arcade"));
  for (const b of BADGES) if (b.games && games.size >= b.games) have.add(b.id);
  const progress = {};
  for (const r of prog.rows) { const b = BY_ID.get(r.badge); if (b) progress[r.badge] = Number(b.max ? r.best : r.total); }
  for (const b of BADGES) if (b.games) progress[b.id] = games.size;
  return {
    address,
    earned: [...have].sort((a, b) => a - b),
    progress,
    claimed: Object.fromEntries(claimed.rows.map((r) => [r.badge, r.tx || ""])),
    mintOpen: mintOpen(),
    chain: CHAIN.name,
    contract: CONTRACT,
  };
}

async function profile(pid) { const { address, pids } = await pidsOf(pid); return profileFor(pids, address); }

// ---------------------------------------------------------------- badge art
function svgFor(b) {
  const g = GAMES[b.game] || { name: "ORBYT ARCADE", col: "#b98cff" };
  const metal = b.tier === 3 ? ["#fff1a8", "#e6b422", "#8a6400"] : b.tier === 2 ? ["#ffffff", "#c9d1dc", "#6b7684"] : ["#ffd2a8", "#c9844a", "#6b3d17"];
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  // big, readable at thumbnail size: game initials on the medal, tier stars, the badge name on a banner
  const initials = g.name.replace(/[^A-Z ]/g, "").split(" ").filter(Boolean).map((w) => w[0]).join("").slice(0, 2) || "OA";
  const star = (cx) => `<path transform="translate(${cx} 318) scale(1.5)" d="M0-14 4-4 15-4 6 3 9 14 0 7-9 14-6 3-15-4-4-4Z" fill="${metal[0]}" stroke="${metal[2]}" stroke-width="1.5"/>`;
  const stars = b.tier === 1 ? star(256) : b.tier === 2 ? star(226) + star(286) : star(196) + star(256) + star(316);
  const nm = b.name.toUpperCase(), fs = nm.length > 14 ? 30 : nm.length > 10 ? 36 : 42;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
<defs>
<radialGradient id="bg" cx="50%" cy="38%" r="70%"><stop offset="0" stop-color="#2a3350"/><stop offset="1" stop-color="#0b1020"/></radialGradient>
<linearGradient id="m" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${metal[0]}"/><stop offset=".55" stop-color="${metal[1]}"/><stop offset="1" stop-color="${metal[2]}"/></linearGradient>
<linearGradient id="c" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${g.col}"/><stop offset="1" stop-color="#0f1526"/></linearGradient>
</defs>
<rect width="512" height="512" rx="64" fill="url(#bg)"/>
<path d="M150 330 L110 470 L178 446 L210 500 L256 360 Z" fill="${g.col}" opacity=".9"/>
<path d="M362 330 L402 470 L334 446 L302 500 L256 360 Z" fill="${g.col}" opacity=".7"/>
<circle cx="256" cy="210" r="176" fill="url(#m)"/>
<circle cx="256" cy="210" r="146" fill="url(#c)"/>
<circle cx="256" cy="210" r="146" fill="none" stroke="${metal[0]}" stroke-width="6" opacity=".75"/>
<text x="256" y="262" font-family="Arial Black, Arial, sans-serif" font-size="150" font-weight="900" text-anchor="middle" fill="#ffffff" stroke="${metal[2]}" stroke-width="4" paint-order="stroke">${esc(initials)}</text>
${stars}
<rect x="76" y="388" width="360" height="66" rx="16" fill="#0b1020" stroke="${metal[1]}" stroke-width="4"/>
<text x="256" y="${421 + fs * 0.36}" font-family="Arial Black, Arial, sans-serif" font-size="${fs}" font-weight="900" text-anchor="middle" fill="#ffffff">${esc(nm)}</text>
</svg>`;
}

function metadata(b, origin) {
  const g = GAMES[b.game] || { name: "Orbyt Arcade", url: "https://orbyt-arcade.vercel.app" };
  return {
    name: b.name,
    description: b.desc + " A soulbound achievement badge from " + g.name + ". Free to earn, impossible to buy or sell.",
    image: origin + "/api/base/badge/" + b.id + ".svg",
    external_url: g.url,
    attributes: [{ trait_type: "Game", value: g.name }, { trait_type: "Tier", value: TIER[b.tier] }, { trait_type: "Soulbound", value: "Yes" }],
  };
}

// ---------------------------------------------------------------- http
export async function baseHttp(req, res, url, { send, ipOf }) {
  const p = url.pathname;
  if (!p.startsWith("/api/base/")) return false;
  const origin = "https://" + (req.headers["x-forwarded-host"] || req.headers.host || "orbyt-api-production-29f6.up.railway.app");

  if (p === "/api/base/catalog" && req.method === "GET") {
    send(res, 200, { games: GAMES, badges: BADGES.map(({ id, game, tier, name, desc, ev, prefix }) => ({ id, game, tier, name, desc, ev, prefix, goal: goal(BY_ID.get(id)) })), mintOpen: mintOpen(), chain: CHAIN.name, contract: CONTRACT });
    return true;
  }

  let m = p.match(/^\/api\/base\/badge\/(\d+)\.(json|svg)$/);
  if (m && req.method === "GET") {
    const b = BY_ID.get(Number(m[1]));
    if (!b) { send(res, 404, {}); return true; }
    if (m[2] === "svg") { res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" }); res.end(svgFor(b)); }
    else { res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" }); res.end(JSON.stringify(metadata(b, origin))); }
    return true;
  }

  m = p.match(/^\/api\/base\/profile\/(0x[0-9a-fA-F]{40})$/);
  if (m && req.method === "GET") {
    const address = getAddress(m[1]);
    const all = await db.query("SELECT pid FROM base_players WHERE address=$1", [address]);
    send(res, 200, await profileFor(all.rows.map((r) => r.pid), address));
    return true;
  }

  if (p === "/api/base/nonce" && req.method === "GET") {
    if (nonces.size > 50000) { send(res, 503, {}); return true; }
    const nonce = crypto.randomBytes(16).toString("hex");
    nonces.set(nonce, Date.now() + 600e3);
    send(res, 200, { nonce });
    return true;
  }

  if (p === "/api/base/me" && req.method === "GET") {
    const pid = url.searchParams.get("pid"), key = url.searchParams.get("key");
    if (!okId(pid, key)) { send(res, 401, {}); return true; }
    send(res, 200, await profile(pid));
    return true;
  }

  if (req.method !== "POST") return false;
  let b; try { b = await readBody(req); } catch { send(res, 400, {}); return true; }

  if (p === "/api/base/hello") {
    let { pid, key } = b;
    if (!okId(pid, key)) {
      pid = crypto.randomBytes(15).toString("base64").replace(/[^a-z0-9]/gi, "").toLowerCase().padEnd(20, "x").slice(0, 20);
      key = keyFor(pid);
    }
    await db.query("INSERT INTO base_players (pid) VALUES ($1) ON CONFLICT DO NOTHING", [pid]);
    send(res, 200, { pid, key, me: await profile(pid) });
    return true;
  }

  if (!okId(b.pid, b.key)) { send(res, 401, {}); return true; }
  const pid = b.pid;

  if (p === "/api/base/ev") {
    const game = String(b.game || "");
    if (!GAMES[game] || !Array.isArray(b.e)) { send(res, 400, {}); return true; }
    const n = (rate.get(pid) || 0) + b.e.length; rate.set(pid, n);
    if (n > 240) { send(res, 429, {}); return true; }
    const rules = BADGES.filter((x) => x.game === game);
    const before = new Set((await db.query("SELECT badge FROM base_earned WHERE pid=$1", [pid])).rows.map((r) => r.badge));
    const earned = [];
    for (const ev of b.e.slice(0, 60)) {
      if (!Array.isArray(ev)) continue;
      const name = String(ev[0] || "").toLowerCase().slice(0, 40);
      const v = Math.max(0, Math.min(1e6, Math.floor(Number(ev[1]) || 0)));
      for (const r of rules) {
        if (!matches(r, name)) continue;
        let q;
        if (r.count) q = await db.query("INSERT INTO base_prog (pid, badge, val) VALUES ($1,$2,1) ON CONFLICT (pid, badge) DO UPDATE SET val = base_prog.val + 1 RETURNING val", [pid, r.id]);
        else if (r.sum) { const add = Math.min(v, r.cap || 500); q = await db.query("INSERT INTO base_prog (pid, badge, val) VALUES ($1,$2,$3) ON CONFLICT (pid, badge) DO UPDATE SET val = base_prog.val + $3 RETURNING val", [pid, r.id, add]); }
        else if (r.max) q = await db.query("INSERT INTO base_prog (pid, badge, val) VALUES ($1,$2,$3) ON CONFLICT (pid, badge) DO UPDATE SET val = GREATEST(base_prog.val, $3) RETURNING val", [pid, r.id, Math.min(v, 1000)]);
        const val = Number(q?.rows[0]?.val || 0);
        if (val >= goal(r) && !before.has(r.id)) {
          before.add(r.id); earned.push(r.id);
          await db.query("INSERT INTO base_earned (pid, badge) VALUES ($1,$2) ON CONFLICT DO NOTHING", [pid, r.id]);
        }
      }
    }
    // arcade-wide badges that just tipped over
    if (earned.length) {
      const prof = await profile(pid);
      for (const x of BADGES) if (x.games && prof.earned.includes(x.id) && !before.has(x.id)) {
        const had = await db.query("SELECT 1 FROM base_earned WHERE pid=$1 AND badge=$2", [pid, x.id]);
        if (!had.rowCount) { earned.push(x.id); await db.query("INSERT INTO base_earned (pid, badge) VALUES ($1,$2) ON CONFLICT DO NOTHING", [pid, x.id]); }
      }
    }
    send(res, 200, { earned });
    return true;
  }

  if (p === "/api/base/link") {
    const message = String(b.message || ""), signature = String(b.signature || "");
    let f;
    try { f = parseSiweMessage(message); } catch { f = null; }
    if (!f || !f.address || !f.nonce || !f.domain) { send(res, 400, { error: "bad message" }); return true; }
    if (!nonces.has(f.nonce)) { send(res, 400, { error: "expired, try again" }); return true; }
    nonces.delete(f.nonce);
    if (!SITES.some((r) => r.test(f.domain))) { send(res, 400, { error: "wrong site" }); return true; }
    if (f.expirationTime && f.expirationTime < new Date()) { send(res, 400, { error: "expired" }); return true; }
    let valid = false;
    try { valid = await verifier.verifySiweMessage({ message, signature, nonce: f.nonce, domain: f.domain }); } catch (e) { console.warn("[base] verify", e.shortMessage || e.message); }
    if (!valid) { send(res, 401, { error: "signature check failed" }); return true; }
    const address = getAddress(f.address);
    await db.query("UPDATE base_players SET address=$2, linked=now() WHERE pid=$1", [pid, address]);
    send(res, 200, await profile(pid));
    return true;
  }

  if (p === "/api/base/unlink") {
    await db.query("UPDATE base_players SET address=NULL, linked=NULL WHERE pid=$1", [pid]);
    send(res, 200, await profile(pid));
    return true;
  }

  if (p === "/api/base/claim") {
    const prof = await profile(pid);
    if (!prof.address) { send(res, 400, { error: "sign in with Base first" }); return true; }
    if (!mintOpen()) { send(res, 200, { pending: true, me: prof }); return true; }
    const last = claimAt.get(prof.address) || 0;
    if (Date.now() - last < 30e3) { send(res, 429, { error: "one moment, still minting" }); return true; }
    const ids = prof.earned.filter((id) => !(id in prof.claimed));
    if (!ids.length) { send(res, 200, { ids: [], me: prof }); return true; }
    claimAt.set(prof.address, Date.now());
    try {
      const hash = await wallet.writeContract({ address: CONTRACT, abi: AWARD_ABI, functionName: "awardBatch", args: [prof.address, ids.map(BigInt)], dataSuffix });
      for (const id of ids) await db.query("INSERT INTO base_claims (address, badge, tx) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [prof.address, id, hash]);
      chainClient.waitForTransactionReceipt({ hash, timeout: 120e3 }).then((r) => {
        if (r.status !== "success") return db.query("DELETE FROM base_claims WHERE tx=$1", [hash]);   // failed: let them retry
      }).catch((e) => console.warn("[base] receipt", e.shortMessage || e.message));
      send(res, 200, { tx: hash, ids, chain: CHAIN.name, me: await profile(pid) });
    } catch (e) {
      console.warn("[base] mint failed", e.shortMessage || e.message);
      claimAt.delete(prof.address);
      send(res, 502, { error: "minting is busy, try again soon" });
    }
    return true;
  }

  return false;
}

export function baseStats() { return { badges: BADGES.length, mint: mintOpen() ? CHAIN.name : "closed" }; }
