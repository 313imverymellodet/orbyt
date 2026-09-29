// ORDER UP! service: per-kitchen score leaderboard + /kitchen WebSocket rooms (up to 4 chefs, co-op).
//   POST /api/kitchen/run     -> { token }                         (server clock starts at the countdown)
//   POST /api/kitchen/finish  -> { rank, total, best, newBest }    (score checked against the token's clock)
//   GET  /api/kitchen/board   -> { map, top }                      ?map=burgerbar|splitshift
// Rooms are host-authoritative: the first chef simulates the kitchen, everyone else sends inputs.
// The server only relays: "in" (client -> host) and "snap" (host -> everyone else).
import crypto from "node:crypto";

export const KITCHENS = ["burgerbar", "splitshift"];
const SHIFT_MS = 180000;
const MAX_PER_SEC = 4;           // a perfect crew serves a 50-pt dish every ~12s; this is very generous

let db = null;
const runs = new Map();
const lastSubmit = new Map();

export async function initKitchen(pool) {
  db = pool;
  await db.query(`
    CREATE TABLE IF NOT EXISTS kitchen_scores (
      player TEXT NOT NULL,
      name   TEXT NOT NULL,
      map    TEXT NOT NULL,
      score  INTEGER NOT NULL,
      stars  INTEGER NOT NULL DEFAULT 0,
      crew   INTEGER NOT NULL DEFAULT 1,
      at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (player, map)
    );
    CREATE INDEX IF NOT EXISTS kitchen_board ON kitchen_scores (map, score DESC, at ASC);
  `);
  setInterval(() => { const cut = Date.now() - 3600e3; for (const [k, v] of runs) if (v.start < cut) runs.delete(k); }, 600e3);
}

async function board(map, limit = 20) {
  const r = await db.query("SELECT name, score, stars, crew FROM kitchen_scores WHERE map=$1 ORDER BY score DESC, at ASC LIMIT $2", [map, limit]);
  return r.rows;
}

export async function kitchenHttp(req, res, url, { send, readJson, cleanName, ipOf, broadcast }) {
  const p = url.pathname;
  if (!p.startsWith("/api/kitchen/")) return false;

  if (p === "/api/kitchen/run" && req.method === "POST") {
    const b = await readJson(req);
    const map = KITCHENS.includes(b.map) ? b.map : "burgerbar";
    const token = crypto.randomBytes(16).toString("hex");
    runs.set(token, { start: Date.now(), map, used: false });
    send(res, 200, { token });
    return true;
  }

  if (p === "/api/kitchen/board" && req.method === "GET") {
    const map = KITCHENS.includes(url.searchParams.get("map")) ? url.searchParams.get("map") : "burgerbar";
    send(res, 200, { map, top: await board(map, Math.min(50, Number(url.searchParams.get("limit")) || 30)) });
    return true;
  }

  if (p === "/api/kitchen/finish" && req.method === "POST") {
    const ip = ipOf(req);
    if (Date.now() - (lastSubmit.get(ip) || 0) < 2000) { send(res, 429, { error: "slow down" }); return true; }
    lastSubmit.set(ip, Date.now());
    const b = await readJson(req);
    const run = runs.get(b.token);
    if (!run || run.used) { send(res, 400, { error: "invalid run" }); return true; }
    run.used = true;
    const map = run.map;
    const elapsed = Date.now() - run.start;
    const score = Math.floor(Number(b.score));
    // a shift lasts 3 minutes; the token is issued at the countdown
    if (elapsed < SHIFT_MS - 5000) { send(res, 400, { error: "too early" }); return true; }
    if (!Number.isFinite(score) || score < 1 || score > (SHIFT_MS / 1000) * MAX_PER_SEC * 4) { send(res, 400, { error: "bad score" }); return true; }
    const crew = Math.max(1, Math.min(4, Math.floor(Number(b.crew)) || 1));
    if (score > (SHIFT_MS / 1000) * MAX_PER_SEC * crew) { send(res, 400, { error: "implausible" }); return true; }
    const name = cleanName(b.name);
    if (!name) { send(res, 400, { error: "bad name" }); return true; }
    const player = String(b.player || "").replace(/[^a-f0-9-]/gi, "").slice(0, 40);
    if (player.length < 8) { send(res, 400, { error: "bad player" }); return true; }
    const stars = Math.max(0, Math.min(3, Math.floor(Number(b.stars)) || 0));

    const up = await db.query(
      `INSERT INTO kitchen_scores (player, name, map, score, stars, crew) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (player, map) DO UPDATE SET
         name = EXCLUDED.name,
         score = GREATEST(kitchen_scores.score, EXCLUDED.score),
         stars = CASE WHEN EXCLUDED.score > kitchen_scores.score THEN EXCLUDED.stars ELSE kitchen_scores.stars END,
         crew = CASE WHEN EXCLUDED.score > kitchen_scores.score THEN EXCLUDED.crew ELSE kitchen_scores.crew END,
         at = CASE WHEN EXCLUDED.score > kitchen_scores.score THEN now() ELSE kitchen_scores.at END
       RETURNING score`, [player, name, map, score, stars, crew]);
    const best = up.rows[0].score;
    const newBest = score >= best;
    const rk = await db.query("SELECT COUNT(*)::int + 1 AS rank FROM kitchen_scores WHERE map=$1 AND score > $2", [map, best]);
    const tot = await db.query("SELECT COUNT(*)::int AS n FROM kitchen_scores WHERE map=$1", [map]);
    if (newBest) broadcast({ type: "kitchen", map, name, score: best, rank: rk.rows[0].rank });
    send(res, 200, { map, rank: rk.rows[0].rank, total: tot.rows[0].n, best, newBest });
    return true;
  }

  send(res, 404, { error: "not found" });
  return true;
}

export async function kitchenRemove(names, prefix) {
  const r = await db.query("DELETE FROM kitchen_scores WHERE name = ANY($1) OR ($2::text IS NOT NULL AND player LIKE $2)", [names, prefix]);
  return r.rowCount;
}

// ---------------------------------------------------------------- co-op rooms
const MAX = 4;
const rooms = new Map();
let nextId = 1;

const code4 = () => { let c; do { c = Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ"[crypto.randomInt(24)]).join(""); } while (rooms.has(c)); return c; };
const send = (ws, m) => { if (ws.readyState === 1) ws.send(typeof m === "string" ? m : JSON.stringify(m)); };
const pub = (p) => ({ id: p.id, name: p.name, look: p.look });

function lobby(room) {
  const m = { t: "lobby", code: room.code, map: room.map, priv: room.priv, players: room.players.map(pub), startsIn: room.startAt ? Math.max(0, room.startAt - Date.now()) : 0 };
  for (const p of room.players) send(p.ws, { ...m, host: room.players[0] === p });
}

function schedule(room) {
  clearTimeout(room.timer);
  if (room.state !== "lobby") return;
  if (room.players.length >= 2 && !room.priv) {
    const wait = room.players.length >= MAX ? 2500 : 8000;
    room.startAt = Date.now() + wait;
    room.timer = setTimeout(() => start(room), wait);
  } else if (!room.priv && room.players.length === 1) {
    room.startAt = 0;
    room.timer = setTimeout(() => {
      if (room.state === "lobby" && room.players.length === 1) { send(room.players[0].ws, { t: "solo" }); leave(room.players[0]); }
    }, 15000);
  } else room.startAt = 0;
  lobby(room);
}

function start(room) {
  if (room.state !== "lobby" || room.players.length < 2) return;
  clearTimeout(room.timer);
  room.state = "cooking";
  room.host = room.players[0];
  const players = room.players.map(pub);
  for (const p of room.players) send(p.ws, { t: "start", map: room.map, you: p.id, host: room.host.id, players });
  // a shift is 3 minutes; close the room a little after
  room.timer = setTimeout(() => close(room), SHIFT_MS + 60000);
}

function close(room) {
  clearTimeout(room.timer);
  rooms.delete(room.code);
}

function leave(p) {
  const room = p.room;
  if (!room) return;
  p.room = null;
  room.players = room.players.filter((x) => x !== p);
  if (!room.players.length) { close(room); return; }
  if (room.state === "cooking" && room.host === p) {
    // the kitchen lived on the host's device: the shift ends for everyone
    for (const o of room.players) { send(o.ws, { t: "end" }); o.room = null; }
    close(room);
    return;
  }
  for (const o of room.players) send(o.ws, { t: "left", id: p.id });
  if (room.state === "lobby") schedule(room);
}

function quick(p, map) {
  for (const r of rooms.values())
    if (!r.priv && r.state === "lobby" && r.map === map && r.players.length < MAX) return join(p, r);
  const room = { code: code4(), map, priv: false, state: "lobby", players: [], timer: null, startAt: 0, host: null };
  rooms.set(room.code, room);
  join(p, room);
}

function join(p, room) {
  if (p.room) leave(p);
  p.room = room; room.players.push(p);
  schedule(room);
}

export function handleKitchen(ws) {
  const p = { ws, id: "c" + nextId++, name: "CHEF", look: 0, room: null, last: 0 };
  send(ws, { t: "hello", id: p.id, online: kitchenStats().players });
  ws.on("message", (raw) => {
    if (raw.length > 6000) return;
    const room = p.room;
    const s = raw.toString();
    // hot path: relay without a full parse
    if (room && room.state === "cooking") {
      if (s.startsWith('{"t":"in"')) {
        const now = Date.now();
        if (now - p.last < 30) return;   // ~30 Hz cap
        p.last = now;
        if (room.host && room.host !== p) send(room.host.ws, '{"t":"in","from":"' + p.id + '"' + s.slice(9));   // s.slice(9) starts with ',"x":...' 
        return;
      }
      if (s.startsWith('{"t":"snap"')) {
        if (room.host === p) for (const o of room.players) if (o !== p) send(o.ws, s);
        return;
      }
    }
    let m; try { m = JSON.parse(s); } catch { return; }
    switch (m.t) {
      case "hello":
        p.name = String(m.name || "").toUpperCase().replace(/[^A-Z0-9 _.-]/g, "").slice(0, 12) || "CHEF";
        p.look = Math.max(0, Math.min(7, Math.floor(Number(m.look)) || 0));
        break;
      case "quick": quick(p, KITCHENS.includes(m.map) ? m.map : "burgerbar"); break;
      case "create": {
        const r = { code: code4(), map: KITCHENS.includes(m.map) ? m.map : "burgerbar", priv: true, state: "lobby", players: [], timer: null, startAt: 0, host: null };
        rooms.set(r.code, r); join(p, r); break;
      }
      case "join": {
        const r = rooms.get(String(m.code || "").toUpperCase());
        if (!r || r.state !== "lobby") send(ws, { t: "error", msg: "Kitchen not found or already cooking." });
        else if (r.players.length >= MAX) send(ws, { t: "error", msg: "That kitchen is full." });
        else join(p, r);
        break;
      }
      case "go":
        if (room && room.priv && room.players[0] === p && room.players.length >= 2) start(room);
        break;
      case "leave": leave(p); break;
    }
  });
  ws.on("close", () => leave(p));
  ws.on("error", () => {});
}

export function kitchenStats() {
  let players = 0, cooking = 0;
  for (const r of rooms.values()) { players += r.players.length; if (r.state === "cooking") cooking++; }
  return { rooms: rooms.size, cooking, players };
}
