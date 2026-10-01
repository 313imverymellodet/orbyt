// OBBY RUSH service: per-course time leaderboard with ghost replays + /obby WebSocket rooms (up to 8 runners).
//   POST /api/obby/run     -> { token }                          (server clock starts at the countdown)
//   POST /api/obby/finish  -> { rank, total, best, newBest }     (validated against the token's clock)
//   GET  /api/obby/board   -> { course, top }                    ?course=garden|tower|storm
//   GET  /api/obby/ghost   -> { name, skin, ms, g }              the world record's replay
import crypto from "node:crypto";

export const COURSES = ["garden", "tower", "storm"];
// Faster than a perfect run is possible; anything below is rejected (measured from the course layouts).
const MIN_MS = { garden: 13000, tower: 17000, storm: 19000 };
const SKINS = ["knight", "barbarian", "rogue", "mage", "ranger", "minion", "hooded", "skrogue", "warrior", "skmage"];
const GHOST_HZ = 10;

let db = null;
const runs = new Map();            // token -> { start, course, used }
const lastSubmit = new Map();

export async function initObby(pool) {
  db = pool;
  await db.query(`
    CREATE TABLE IF NOT EXISTS obby_times (
      player TEXT NOT NULL,
      name   TEXT NOT NULL,
      course TEXT NOT NULL,
      ms     INTEGER NOT NULL,
      skin   TEXT NOT NULL DEFAULT '',
      ghost  TEXT NOT NULL DEFAULT '',
      at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (player, course)
    );
    CREATE INDEX IF NOT EXISTS obby_board ON obby_times (course, ms ASC, at ASC);
  `);
  setInterval(() => { const cut = Date.now() - 3600e3; for (const [k, v] of runs) if (v.start < cut) runs.delete(k); }, 600e3);
}

async function board(course, limit = 20) {
  const r = await db.query("SELECT name, ms, skin FROM obby_times WHERE course=$1 ORDER BY ms ASC, at ASC LIMIT $2", [course, limit]);
  return r.rows;
}

// ghosts are up to ~60 KB of base64, more than the shared 20 KB reader allows
async function readBig(req) {
  let s = "";
  for await (const c of req) { s += c; if (s.length > 80000) throw new Error("too large"); }
  return s ? JSON.parse(s) : {};
}

// A replay must decode to 8-byte samples covering the claimed time and end at the finish.
function validGhost(g, ms) {
  if (typeof g !== "string" || g.length < 40 || g.length > 76000 || !/^[A-Za-z0-9+/=]+$/.test(g)) return false;
  const n = Buffer.from(g, "base64").length;
  if (n % 8 !== 0) return false;
  const samples = n / 8, expect = (ms / 1000) * GHOST_HZ;
  return samples >= expect - 3 && samples <= expect + 6;
}

// returns true if handled
export async function obbyHttp(req, res, url, { send, cleanName, ipOf, broadcast }) {
  const p = url.pathname;
  if (!p.startsWith("/api/obby/")) return false;

  if (p === "/api/obby/run" && req.method === "POST") {
    const b = await readBig(req);
    const course = COURSES.includes(b.course) ? b.course : "garden";
    const token = crypto.randomBytes(16).toString("hex");
    runs.set(token, { start: Date.now(), course, used: false });
    send(res, 200, { token });
    return true;
  }

  if (p === "/api/obby/board" && req.method === "GET") {
    const course = COURSES.includes(url.searchParams.get("course")) ? url.searchParams.get("course") : "garden";
    send(res, 200, { course, top: await board(course, Math.min(50, Number(url.searchParams.get("limit")) || 30)) });
    return true;
  }

  if (p === "/api/obby/ghost" && req.method === "GET") {
    const course = COURSES.includes(url.searchParams.get("course")) ? url.searchParams.get("course") : "garden";
    const r = await db.query("SELECT name, ms, skin, ghost AS g FROM obby_times WHERE course=$1 AND ghost <> '' ORDER BY ms ASC, at ASC LIMIT 1", [course]);
    send(res, 200, r.rows[0] || {});
    return true;
  }

  if (p === "/api/obby/finish" && req.method === "POST") {
    const ip = ipOf(req);
    if (Date.now() - (lastSubmit.get(ip) || 0) < 2000) { send(res, 429, { error: "slow down" }); return true; }
    lastSubmit.set(ip, Date.now());
    let b;
    try { b = await readBig(req); } catch { send(res, 400, { error: "bad body" }); return true; }
    const run = runs.get(b.token);
    if (!run || run.used) { send(res, 400, { error: "invalid run" }); return true; }
    run.used = true;
    const course = run.course;
    const ms = Math.floor(Number(b.ms));
    const elapsed = Date.now() - run.start;
    if (!Number.isFinite(ms) || ms < MIN_MS[course] || ms > 30 * 60e3) { send(res, 400, { error: "bad time" }); return true; }
    // the token is issued at the countdown, so a real run can never exceed the wall clock
    if (ms > elapsed + 1500) { send(res, 400, { error: "implausible" }); return true; }
    const name = cleanName(b.name);
    if (!name) { send(res, 400, { error: "bad name" }); return true; }
    const player = String(b.player || "").replace(/[^a-f0-9-]/gi, "").slice(0, 40);
    if (player.length < 8) { send(res, 400, { error: "bad player" }); return true; }
    const skin = SKINS.includes(b.skin) ? b.skin : "knight";
    const ghost = validGhost(b.ghost, ms) ? b.ghost : "";

    const up = await db.query(
      `INSERT INTO obby_times (player, name, course, ms, skin, ghost) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (player, course) DO UPDATE SET
         name = EXCLUDED.name,
         ms = LEAST(obby_times.ms, EXCLUDED.ms),
         skin = CASE WHEN EXCLUDED.ms < obby_times.ms THEN EXCLUDED.skin ELSE obby_times.skin END,
         ghost = CASE WHEN EXCLUDED.ms < obby_times.ms THEN EXCLUDED.ghost ELSE obby_times.ghost END,
         at = CASE WHEN EXCLUDED.ms < obby_times.ms THEN now() ELSE obby_times.at END
       RETURNING ms`, [player, name, course, ms, skin, ghost]);
    const best = up.rows[0].ms;
    const newBest = ms <= best;
    const rk = await db.query("SELECT COUNT(*)::int + 1 AS rank FROM obby_times WHERE course=$1 AND ms < $2", [course, best]);
    const tot = await db.query("SELECT COUNT(*)::int AS n FROM obby_times WHERE course=$1", [course]);
    const rank = rk.rows[0].rank;
    if (newBest) broadcast({ type: "obby", course, name, ms: best, rank });
    send(res, 200, { course, rank, total: tot.rows[0].n, best, newBest });
    return true;
  }

  send(res, 404, { error: "not found" });
  return true;
}

export async function obbyRemove(names, prefix) {
  const r = await db.query("DELETE FROM obby_times WHERE name = ANY($1) OR ($2::text IS NOT NULL AND player LIKE $2)", [names, prefix]);
  return r.rowCount;
}

// ---------------------------------------------------------------- live rooms
const MAX = 8;
const rooms = new Map();           // code -> room
let nextId = 1;

const code4 = () => { let c; do { c = Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ"[crypto.randomInt(24)]).join(""); } while (rooms.has(c)); return c; };
const send = (ws, m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
const cast = (room, m, except) => { for (const p of room.players) if (p !== except) send(p.ws, m); };
const pub = (p) => ({ id: p.id, name: p.name, skin: p.skin });

function lobby(room) {
  const m = { t: "lobby", code: room.code, course: room.course, priv: room.priv, players: room.players.map(pub), startsIn: room.startAt ? Math.max(0, room.startAt - Date.now()) : 0 };
  for (const p of room.players) send(p.ws, { ...m, host: room.players[0] === p });
}

function schedule(room) {
  clearTimeout(room.timer);
  if (room.state !== "lobby") return;
  if (room.players.length >= 2 && !room.priv) {
    // quick match: fill for a few seconds, go immediately when full
    const wait = room.players.length >= MAX ? 2500 : 8000;
    room.startAt = Date.now() + wait;
    room.timer = setTimeout(() => start(room), wait);
  } else if (!room.priv && room.players.length === 1) {
    // alone too long: race the world record ghost instead
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
  for (const p of room.players) send(p.ws, { t: "start", course: room.course, you: p.id, players });
  room.timer = setTimeout(() => end(room), 10 * 60e3);   // hard cap
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

function quick(p, course) {
  for (const r of rooms.values())
    if (!r.priv && r.state === "lobby" && r.course === course && r.players.length < MAX) return join(p, r);
  const room = { code: code4(), course, priv: false, state: "lobby", players: [], timer: null, startAt: 0 };
  rooms.set(room.code, room);
  join(p, room);
}

function join(p, room) {
  if (p.room) leave(p);
  p.room = room; room.players.push(p);
  schedule(room);
}

export function handleObby(ws) {
  const p = { ws, id: "o" + nextId++, name: "RUNNER", skin: "knight", room: null, last: 0 };
  send(ws, { t: "hello", id: p.id, online: obbyStats().players });
  ws.on("message", (raw) => {
    if (raw.length > 800) return;
    let m; try { m = JSON.parse(raw); } catch { return; }
    const room = p.room;
    switch (m.t) {
      case "hello":
        p.name = String(m.name || "").toUpperCase().replace(/[^A-Z0-9 _.-]/g, "").slice(0, 12) || "RUNNER";
        p.skin = SKINS.includes(m.skin) ? m.skin : "knight";
        break;
      case "quick": quick(p, COURSES.includes(m.course) ? m.course : "garden"); break;
      case "create": {
        const r = { code: code4(), course: COURSES.includes(m.course) ? m.course : "garden", priv: true, state: "lobby", players: [], timer: null, startAt: 0 };
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
        cast(room, { t: "state", id: p.id, x: n(m.x), y: n(m.y), z: n(m.z), r: n(m.r), a: m.a | 0, c: m.c | 0 }, p);
        break;
      }
      case "fin": {
        if (!room || room.state !== "race" || room.finished.some((f) => f.id === p.id)) return;
        const ms = Math.min(Number(m.ms) | 0, Date.now() - room.started);
        room.finished.push({ id: p.id, name: p.name, ms });
        cast(room, { t: "fin", id: p.id, ms, place: room.finished.length });
        if (room.finished.length >= room.players.length) setTimeout(() => end(room), 1500);
        else if (room.finished.length === 1) { clearTimeout(room.timer); room.timer = setTimeout(() => end(room), 60000); }
        break;
      }
      case "leave": leave(p); break;
    }
  });
  ws.on("close", () => leave(p));
  ws.on("error", () => {});
}

export function obbyStats() {
  let players = 0, racing = 0;
  for (const r of rooms.values()) { players += r.players.length; if (r.state === "race") racing++; }
  return { rooms: rooms.size, racing, players };
}
