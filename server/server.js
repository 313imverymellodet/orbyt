// ORBYT + CITY RUSH + ORDER UP! + BONK BRAWL service (see race.js for the racing endpoints)
// ORBYT leaderboard service — Node + Postgres + WebSocket (Railway).
//   POST /api/run    -> { token }                       (server clock starts)
//   POST /api/score  -> { rank, total, best, top, around } (validated against the token's clock)
//   GET  /api/board  -> { top }                          ?mode=daily|endless&day=YYYYMMDD
//   WS   /live       -> pushes { type:"score", ... } whenever a new personal best lands
import http from "node:http";
import crypto from "node:crypto";
import pg from "pg";
import { WebSocketServer } from "ws";
import { handleDuel, duelStats } from "./duel.js";
import { initRace, raceHttp, raceRemove, handleRace, raceStats } from "./race.js";
import { initKitchen, kitchenHttp, kitchenRemove, handleKitchen, kitchenStats } from "./kitchen.js";
import { initBrawl, brawlHttp, brawlRemove, handleBrawl, brawlStats } from "./brawl.js";
import { initObby, obbyHttp, obbyRemove, handleObby, obbyStats } from "./obby.js";
import { handleKart, kartStats } from "./kart.js";
import { initSnack, snackHttp, snackRemove } from "./snack.js";
import { initAnalytics, analyticsHttp } from "./analytics.js";

const PORT = process.env.PORT || 3000;
const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway.internal") ? false : { rejectUnauthorized: false },
  max: 8,
});

await db.query(`
  CREATE TABLE IF NOT EXISTS scores (
    player   TEXT NOT NULL,
    name     TEXT NOT NULL,
    mode     TEXT NOT NULL,
    day      INTEGER NOT NULL,
    score    INTEGER NOT NULL,
    perfects INTEGER NOT NULL DEFAULT 0,
    flips    INTEGER NOT NULL DEFAULT 0,
    at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (player, mode, day)
  );
  CREATE INDEX IF NOT EXISTS scores_board ON scores (mode, day, score DESC, at ASC);
`);
await initRace(db);
await initKitchen(db);
await initBrawl(db);
await initObby(db);
await initSnack(db);
await initAnalytics(db);

// ---------------------------------------------------------------- helpers
const today = () => { const d = new Date(); return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate(); };
const runs = new Map();            // token -> { start, used }
const lastSubmit = new Map();      // ip -> ms
const BAD = ["fuck", "shit", "cunt", "nigg", "fag", "bitch", "whore", "rape", "nazi", "hitler", "dick", "cock", "pussy", "slut", "retard"];

function cleanName(raw) {
  let n = String(raw || "").toUpperCase().replace(/[^A-Z0-9 _.-]/g, "").replace(/\s+/g, " ").trim().slice(0, 12);
  // translate leetspeak BEFORE stripping symbols, or "SH1T" sails through
  const squashed = n.toLowerCase().replace(/0/g, "o").replace(/[1!|]/g, "i").replace(/3/g, "e").replace(/[4@]/g, "a").replace(/[5$]/g, "s").replace(/7/g, "t").replace(/[^a-z]/g, "");
  if (n.length < 2 || BAD.some((w) => squashed.includes(w))) return null;
  return n;
}

// Highest score a real run of `secs` seconds could plausibly reach. Obstacles arrive at most ~4/s at
// top speed, each worth 1 + up to 2 perfect bonus; this bound is deliberately generous.
const maxScore = (secs) => Math.ceil(secs * 7 + 10);

// our Vercel sites, local dev, and the web-game portals that host our builds (they serve games from their own CDNs)
const PORTALS = /^https:\/\/([a-z0-9-]+\.)*(crazygames\.com|crazygames\.io|poki\.com|poki\.io|poki-gdn\.com|gamedistribution\.com)$/;
const ALLOWED = [/^https:\/\/([a-z0-9-]+\.)*vercel\.app$/, PORTALS, /^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/];
function cors(req, res) {
  const o = req.headers.origin;
  if (o && ALLOWED.some((r) => r.test(o))) { res.setHeader("Access-Control-Allow-Origin", o); res.setHeader("Vary", "Origin"); }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function send(res, code, body) { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); }

async function readJson(req) {
  let s = "";
  for await (const c of req) { s += c; if (s.length > 20000) throw new Error("too large"); }
  return JSON.parse(s || "{}");
}

async function board(mode, day, limit = 10) {
  const r = await db.query("SELECT name, score, perfects, flips FROM scores WHERE mode=$1 AND day=$2 ORDER BY score DESC, at ASC LIMIT $3", [mode, day, limit]);
  return r.rows;
}

const ipOf = (req) => (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();

// ---------------------------------------------------------------- routes
const server = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/" || url.pathname === "/health") return send(res, 200, { ok: true, service: "orbyt-leaderboard", day: today(), duels: duelStats(), race: raceStats(), kitchen: kitchenStats(), brawl: brawlStats(), obby: obbyStats(), kart: kartStats() });

    if (await raceHttp(req, res, url, { send, readJson, cleanName, ipOf, broadcast })) return;
    if (await kitchenHttp(req, res, url, { send, readJson, cleanName, ipOf, broadcast })) return;
    if (await brawlHttp(req, res, url, { send })) return;
    if (await obbyHttp(req, res, url, { send, cleanName, ipOf, broadcast })) return;
    if (await snackHttp(req, res, url, { send, readJson, cleanName, ipOf, broadcast })) return;
    if (await analyticsHttp(req, res, url, { send, ipOf })) return;

    if (url.pathname === "/api/run" && req.method === "POST") {
      const token = crypto.randomBytes(16).toString("hex");
      runs.set(token, { start: Date.now(), used: false });
      return send(res, 200, { token, day: today() });
    }

    if (url.pathname === "/api/board" && req.method === "GET") {
      const mode = url.searchParams.get("mode") === "daily" ? "daily" : "endless";
      const day = mode === "daily" ? Number(url.searchParams.get("day")) || today() : 0;
      return send(res, 200, { mode, day, top: await board(mode, day, Math.min(50, Number(url.searchParams.get("limit")) || 20)) });
    }

    if (url.pathname === "/api/score" && req.method === "POST") {
      const ip = ipOf(req);
      if (Date.now() - (lastSubmit.get(ip) || 0) < 2000) return send(res, 429, { error: "slow down" });
      lastSubmit.set(ip, Date.now());

      const b = await readJson(req);
      const run = runs.get(b.token);
      if (!run || run.used) return send(res, 400, { error: "invalid run" });
      run.used = true;
      const secs = (Date.now() - run.start) / 1000;
      const score = Math.floor(Number(b.score));
      if (!Number.isFinite(score) || score < 1 || score > 100000) return send(res, 400, { error: "bad score" });
      if (score > maxScore(secs)) return send(res, 400, { error: "implausible" });
      const name = cleanName(b.name);
      if (!name) return send(res, 400, { error: "bad name" });
      const player = String(b.player || "").replace(/[^a-f0-9-]/gi, "").slice(0, 40);
      if (player.length < 8) return send(res, 400, { error: "bad player" });
      const mode = b.mode === "daily" ? "daily" : "endless";
      const day = mode === "daily" ? today() : 0;
      const perfects = Math.max(0, Math.min(score, Math.floor(Number(b.perfects) || 0)));
      const flips = Math.max(0, Math.min(1000, Math.floor(Number(b.flips) || 0)));

      // keep each player's best; name updates ride along
      const up = await db.query(
        `INSERT INTO scores (player, name, mode, day, score, perfects, flips) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (player, mode, day) DO UPDATE SET
           name = EXCLUDED.name,
           score = GREATEST(scores.score, EXCLUDED.score),
           perfects = CASE WHEN EXCLUDED.score > scores.score THEN EXCLUDED.perfects ELSE scores.perfects END,
           flips = CASE WHEN EXCLUDED.score > scores.score THEN EXCLUDED.flips ELSE scores.flips END,
           at = CASE WHEN EXCLUDED.score > scores.score THEN now() ELSE scores.at END
         RETURNING score, (xmax = 0) AS inserted`,
        [player, name, mode, day, score, perfects, flips]);
      const best = up.rows[0].score;
      const newBest = score >= best;

      const rk = await db.query("SELECT COUNT(*)::int + 1 AS rank FROM scores WHERE mode=$1 AND day=$2 AND score > $3", [mode, day, best]);
      const tot = await db.query("SELECT COUNT(*)::int AS n FROM scores WHERE mode=$1 AND day=$2", [mode, day]);
      const rank = rk.rows[0].rank;
      const around = await db.query(
        `SELECT name, score, player = $4 AS me FROM scores WHERE mode=$1 AND day=$2
         ORDER BY score DESC, at ASC OFFSET GREATEST($3 - 3, 0) LIMIT 5`, [mode, day, rank, player]);
      const top = await board(mode, day, 10);

      if (newBest) broadcast({ type: "score", mode, day, name, score, rank });
      return send(res, 200, { rank, total: tot.rows[0].n, best, newBest, top, around: around.rows });
    }

    // moderation: POST /api/admin/remove { key, names?: [], playerPrefix?: "" }  (key = ADMIN_KEY env)
    if (url.pathname === "/api/admin/remove" && req.method === "POST") {
      const b = await readJson(req);
      const key = process.env.ADMIN_KEY || "";
      if (key.length < 16 || !b.key || !crypto.timingSafeEqual(Buffer.from(String(b.key).padEnd(64)).subarray(0, 64), Buffer.from(key.padEnd(64)).subarray(0, 64))) return send(res, 403, { error: "forbidden" });
      const names = Array.isArray(b.names) ? b.names.map((n) => String(n).toUpperCase()) : [];
      const prefix = b.playerPrefix ? String(b.playerPrefix) + "%" : null;
      const r = await db.query("DELETE FROM scores WHERE name = ANY($1) OR ($2::text IS NOT NULL AND player LIKE $2)", [names, prefix]);
      return send(res, 200, { removed: r.rowCount, raceRemoved: await raceRemove(names, prefix), kitchenRemoved: await kitchenRemove(names, prefix), brawlRemoved: await brawlRemove(names, prefix), obbyRemoved: await obbyRemove(names, prefix), snackRemoved: await snackRemove(names, prefix) });
    }

    send(res, 404, { error: "not found" });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: "server error" });
  }
});

// ---------------------------------------------------------------- live feed
// two socket endpoints on one port: route upgrades by path
const wss = new WebSocketServer({ noServer: true });
const duelWss = new WebSocketServer({ noServer: true });
duelWss.on("connection", handleDuel);
const raceWss = new WebSocketServer({ noServer: true });
raceWss.on("connection", handleRace);
const kitchenWss = new WebSocketServer({ noServer: true, maxPayload: 16384 });
kitchenWss.on("connection", handleKitchen);
const brawlWss = new WebSocketServer({ noServer: true, maxPayload: 8192 });
brawlWss.on("connection", (ws, req) => handleBrawl(ws, req, cleanName));
const obbyWss = new WebSocketServer({ noServer: true, maxPayload: 2048 });
obbyWss.on("connection", handleObby);
const kartWss = new WebSocketServer({ noServer: true, maxPayload: 2048 });
kartWss.on("connection", handleKart);
server.on("upgrade", (req, socket, head) => {
  const path = new URL(req.url, "http://x").pathname;
  const target = path === "/live" ? wss : path === "/duel" ? duelWss : path === "/race" ? raceWss : path === "/kitchen" ? kitchenWss : path === "/brawl" ? brawlWss : path === "/obby" ? obbyWss : path === "/kart" ? kartWss : null;
  if (!target) return socket.destroy();
  target.handleUpgrade(req, socket, head, (ws) => target.emit("connection", ws, req));
});
function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(s);
}
wss.on("connection", (ws) => ws.send(JSON.stringify({ type: "hello", day: today(), online: wss.clients.size })));
setInterval(() => broadcast({ type: "online", n: wss.clients.size }), 15000);

// expire stale run tokens
setInterval(() => { const cut = Date.now() - 3 * 3600e3; for (const [k, v] of runs) if (v.start < cut) runs.delete(k); }, 600e3);

server.listen(PORT, () => console.log("orbyt leaderboard on :" + PORT));
