// CITY RUSH service: per-map time leaderboard + /race WebSocket rooms (up to 4 racers).
//   POST /api/race/run     -> { token }                          (server clock starts at countdown)
//   POST /api/race/finish  -> { rank, total, best, newBest, top } (validated against the token's clock)
//   GET  /api/race/board   -> { map, top }                       ?map=downtown|suburbs
import crypto from "node:crypto";

export const MAPS = ["downtown", "suburbs"];
// Fastest physically possible lap per map (full nitro the whole way would still be slower).
// Anything below this is rejected. Values are measured from the track lengths in Track.cs.
const MIN_LAP_MS = { downtown: 14500, suburbs: 17500 };
const LAPS = 3;

let db = null;
const runs = new Map();            // token -> { start, map, used }
const lastSubmit = new Map();

export async function initRace(pool) {
  db = pool;
  await db.query(`
    CREATE TABLE IF NOT EXISTS race_times (
      player TEXT NOT NULL,
      name   TEXT NOT NULL,
      map    TEXT NOT NULL,
      ms     INTEGER NOT NULL,
      lap_ms INTEGER NOT NULL DEFAULT 0,
      car    TEXT NOT NULL DEFAULT '',
      at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (player, map)
    );
    CREATE INDEX IF NOT EXISTS race_board ON race_times (map, ms ASC, at ASC);
  `);
  setInterval(() => { const cut = Date.now() - 3600e3; for (const [k, v] of runs) if (v.start < cut) runs.delete(k); }, 600e3);
}

async function board(map, limit = 20) {
  const r = await db.query("SELECT name, ms, lap_ms AS lap, car FROM race_times WHERE map=$1 ORDER BY ms ASC, at ASC LIMIT $2", [map, limit]);
  return r.rows;
}

// returns true if handled
export async function raceHttp(req, res, url, { send, readJson, cleanName, ipOf, broadcast }) {
  const p = url.pathname;
  if (!p.startsWith("/api/race/")) return false;

  if (p === "/api/race/run" && req.method === "POST") {
    const b = await readJson(req);
    const map = MAPS.includes(b.map) ? b.map : "downtown";
    const token = crypto.randomBytes(16).toString("hex");
    runs.set(token, { start: Date.now(), map, used: false });
    send(res, 200, { token });
    return true;
  }

  if (p === "/api/race/board" && req.method === "GET") {
    const map = MAPS.includes(url.searchParams.get("map")) ? url.searchParams.get("map") : "downtown";
    send(res, 200, { map, top: await board(map, Math.min(50, Number(url.searchParams.get("limit")) || 30)) });
    return true;
  }

  if (p === "/api/race/finish" && req.method === "POST") {
    const ip = ipOf(req);
    if (Date.now() - (lastSubmit.get(ip) || 0) < 2000) { send(res, 429, { error: "slow down" }); return true; }
    lastSubmit.set(ip, Date.now());
    const b = await readJson(req);
    const run = runs.get(b.token);
    if (!run || run.used) { send(res, 400, { error: "invalid run" }); return true; }
    run.used = true;
    const map = run.map;
    const ms = Math.floor(Number(b.ms));
    const lap = Math.floor(Number(b.lap)) || 0;
    const elapsed = Date.now() - run.start;
    if (!Number.isFinite(ms) || ms < MIN_LAP_MS[map] * LAPS || ms > 30 * 60e3) { send(res, 400, { error: "bad time" }); return true; }
    // the token is issued at the countdown, so a real race time can never exceed the wall clock
    if (ms > elapsed + 1500) { send(res, 400, { error: "implausible" }); return true; }
    if (lap && lap < MIN_LAP_MS[map]) { send(res, 400, { error: "bad lap" }); return true; }
    const name = cleanName(b.name);
    if (!name) { send(res, 400, { error: "bad name" }); return true; }
    const player = String(b.player || "").replace(/[^a-f0-9-]/gi, "").slice(0, 40);
    if (player.length < 8) { send(res, 400, { error: "bad player" }); return true; }
    const car = String(b.car || "").replace(/[^a-z-]/g, "").slice(0, 20);

    const up = await db.query(
      `INSERT INTO race_times (player, name, map, ms, lap_ms, car) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (player, map) DO UPDATE SET
         name = EXCLUDED.name,
         ms = LEAST(race_times.ms, EXCLUDED.ms),
         lap_ms = CASE WHEN EXCLUDED.ms < race_times.ms THEN EXCLUDED.lap_ms ELSE race_times.lap_ms END,
         car = CASE WHEN EXCLUDED.ms < race_times.ms THEN EXCLUDED.car ELSE race_times.car END,
         at = CASE WHEN EXCLUDED.ms < race_times.ms THEN now() ELSE race_times.at END
       RETURNING ms`, [player, name, map, ms, lap, car]);
    const best = up.rows[0].ms;
    const newBest = ms <= best;
    const rk = await db.query("SELECT COUNT(*)::int + 1 AS rank FROM race_times WHERE map=$1 AND ms < $2", [map, best]);
    const tot = await db.query("SELECT COUNT(*)::int AS n FROM race_times WHERE map=$1", [map]);
    const rank = rk.rows[0].rank;
    if (newBest) broadcast({ type: "race", map, name, ms: best, rank });
    send(res, 200, { map, rank, total: tot.rows[0].n, best, newBest, top: await board(map, 10) });
    return true;
  }

  send(res, 404, { error: "not found" });
  return true;
}

export async function raceRemove(names, prefix) {
  const r = await db.query("DELETE FROM race_times WHERE name = ANY($1) OR ($2::text IS NOT NULL AND player LIKE $2)", [names, prefix]);
  return r.rowCount;
}

// ---------------------------------------------------------------- multiplayer rooms
const CARS = ["race", "race-future", "sedan-sports", "hatchback-sports", "police", "taxi", "suv-luxury", "sedan"];
const MAX = 4;
const rooms = new Map();           // code -> room
let nextId = 1;

const code4 = () => { let c; do { c = Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ"[crypto.randomInt(24)]).join(""); } while (rooms.has(c)); return c; };
const send = (ws, m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
const cast = (room, m, except) => { for (const p of room.players) if (p !== except) send(p.ws, m); };
const pub = (p) => ({ id: p.id, name: p.name, car: p.car });

function lobby(room) {
  const m = { t: "lobby", code: room.code, map: room.map, priv: room.priv, players: room.players.map(pub), startsIn: room.startAt ? Math.max(0, room.startAt - Date.now()) : 0 };
  for (const p of room.players) send(p.ws, { ...m, host: room.players[0] === p });
}

function schedule(room) {
  clearTimeout(room.timer);
  if (room.state !== "lobby") return;
  if (room.players.length >= 2 && !room.priv) {
    // quick match: fill for a few seconds, go immediately when full
    const wait = room.players.length >= MAX ? 2500 : 7000;
    room.startAt = Date.now() + wait;
    room.timer = setTimeout(() => start(room), wait);
  } else if (!room.priv && room.players.length === 1) {
    // alone too long: let this player race the AI
    room.startAt = 0;
    room.timer = setTimeout(() => {
      if (room.state === "lobby" && room.players.length === 1) { send(room.players[0].ws, { t: "solo" }); leave(room.players[0]); }
    }, 14000);
  } else room.startAt = 0;
  lobby(room);
}

function start(room) {
  if (room.state !== "lobby" || room.players.length < 2) return;
  clearTimeout(room.timer);
  room.state = "race"; room.started = Date.now(); room.finished = [];
  const players = room.players.map((p, i) => ({ ...pub(p), slot: i }));
  for (const p of room.players) send(p.ws, { t: "start", map: room.map, you: p.id, players });
  room.timer = setTimeout(() => end(room), 8 * 60e3);   // hard cap
}

function end(room) {
  if (room.state !== "race") return;
  room.state = "done";
  clearTimeout(room.timer);
  const standings = room.finished.map((f, i) => ({ id: f.id, name: f.name, ms: f.ms, place: i + 1 }));
  cast(room, { t: "results", standings });
  rooms.delete(room.code);
}

function leave(p) {
  const room = p.room;
  if (!room) return;
  p.room = null;
  room.players = room.players.filter((x) => x !== p);
  if (!room.players.length) { clearTimeout(room.timer); rooms.delete(room.code); return; }
  cast(room, { t: "left", id: p.id });
  if (room.state === "lobby") schedule(room);
  else if (room.state === "race" && room.finished.length >= room.players.length) end(room);
}

function quick(p, map) {
  for (const r of rooms.values())
    if (!r.priv && r.state === "lobby" && r.map === map && r.players.length < MAX) return join(p, r);
  const room = { code: code4(), map, priv: false, state: "lobby", players: [], timer: null, startAt: 0 };
  rooms.set(room.code, room);
  join(p, room);
}

function join(p, room) {
  if (p.room) leave(p);
  p.room = room; room.players.push(p);
  schedule(room);
}

export function handleRace(ws) {
  const p = { ws, id: "p" + nextId++, name: "RACER", car: "race", room: null, last: 0, n: 0 };
  send(ws, { t: "hello", id: p.id, online: raceStats().players });
  ws.on("message", (raw) => {
    if (raw.length > 800) return;
    let m; try { m = JSON.parse(raw); } catch { return; }
    const room = p.room;
    switch (m.t) {
      case "hello":
        p.name = String(m.name || "").toUpperCase().replace(/[^A-Z0-9 _.-]/g, "").slice(0, 12) || "RACER";
        p.car = CARS.includes(m.car) ? m.car : "race";
        break;
      case "quick": quick(p, MAPS.includes(m.map) ? m.map : "downtown"); break;
      case "create": {
        const r = { code: code4(), map: MAPS.includes(m.map) ? m.map : "downtown", priv: true, state: "lobby", players: [], timer: null, startAt: 0 };
        rooms.set(r.code, r); join(p, r); break;
      }
      case "join": {
        const r = rooms.get(String(m.code || "").toUpperCase());
        if (!r || r.state !== "lobby") send(ws, { t: "error", msg: "Room not found or already racing." });
        else if (r.players.length >= MAX) send(ws, { t: "error", msg: "Room is full." });
        else join(p, r);
        break;
      }
      case "go":   // host starts a private room
        if (room && room.priv && room.players[0] === p && room.players.length >= 2) start(room);
        break;
      case "state": {
        if (!room || room.state !== "race") return;
        const now = Date.now();
        if (now - p.last < 50) return;   // ~20 Hz cap
        p.last = now;
        const n = (v) => Math.round(Number(v) * 100) / 100 || 0;
        cast(room, { t: "state", id: p.id, x: n(m.x), z: n(m.z), h: n(m.h), v: n(m.v), s: n(m.s), lap: m.lap | 0 }, p);
        break;
      }
      case "fin": {
        if (!room || room.state !== "race" || room.finished.some((f) => f.id === p.id)) return;
        const ms = Math.min(Number(m.ms) | 0, Date.now() - room.started);
        room.finished.push({ id: p.id, name: p.name, ms });
        cast(room, { t: "fin", id: p.id, ms, place: room.finished.length });
        if (room.finished.length >= room.players.length) setTimeout(() => end(room), 1500);
        else if (room.finished.length === 1) { clearTimeout(room.timer); room.timer = setTimeout(() => end(room), 45000); }
        break;
      }
      case "leave": leave(p); break;
    }
  });
  ws.on("close", () => leave(p));
  ws.on("error", () => {});
}

export function raceStats() {
  let players = 0, racing = 0;
  for (const r of rooms.values()) { players += r.players.length; if (r.state === "race") racing++; }
  return { rooms: rooms.size, racing, players };
}
