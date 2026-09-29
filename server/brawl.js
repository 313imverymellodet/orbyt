// BONK BRAWL service: /brawl WebSocket rooms (2-4 fighters, rollback netcode) + online-wins leaderboard.
// The server never simulates anything: every client runs the same deterministic sim. We only
//   - match players into rooms and hand out slots + a shared random seed,
//   - relay input packets ("i") and state hashes ("h") to the other players, tagged with the sender's slot,
//   - count a win when every human in the room reports the same winner.
import crypto from "node:crypto";

const STAGES = 4, MAX = 4;
let db = null;

export async function initBrawl(pool) {
  db = pool;
  await db.query(`
    CREATE TABLE IF NOT EXISTS brawl_stats (
      player TEXT PRIMARY KEY,
      name   TEXT NOT NULL,
      wins   INTEGER NOT NULL DEFAULT 0,
      games  INTEGER NOT NULL DEFAULT 0,
      kos    INTEGER NOT NULL DEFAULT 0,
      at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS brawl_board ON brawl_stats (wins DESC, games ASC);
  `);
}

export async function brawlHttp(req, res, url, { send }) {
  if (url.pathname !== "/api/brawl/board") return false;
  const r = await db.query("SELECT name, wins, games FROM brawl_stats WHERE wins > 0 ORDER BY wins DESC, games ASC, at ASC LIMIT $1", [Math.min(50, Number(url.searchParams.get("limit")) || 30)]);
  send(res, 200, { top: r.rows });
  return true;
}

export async function brawlRemove(names, prefix) {
  const r = await db.query("DELETE FROM brawl_stats WHERE name = ANY($1) OR ($2::text IS NOT NULL AND player LIKE $2)", [names, prefix]);
  return r.rowCount;
}

// ---------------------------------------------------------------- rooms
const rooms = new Map();
let nextId = 1;
const code4 = () => { let c; do { c = Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ"[crypto.randomInt(24)]).join(""); } while (rooms.has(c)); return c; };
const send = (ws, m) => { if (ws.readyState === 1) ws.send(typeof m === "string" ? m : JSON.stringify(m)); };
const pub = (p) => ({ id: p.id, name: p.name, ch: p.ch });

function lobby(room) {
  const m = { t: "lobby", code: room.code, priv: room.priv, players: room.players.map(pub), startsIn: room.startAt ? Math.max(0, room.startAt - Date.now()) : 0, stage: room.stage, bots: room.bots, botLv: room.botLv };
  for (const p of room.players) send(p.ws, { ...m, host: room.players[0] === p });
}

function schedule(room) {
  clearTimeout(room.timer);
  if (room.state !== "lobby") return;
  if (!room.priv && room.players.length >= 2) {
    const wait = room.players.length >= MAX ? 2500 : 6500;
    room.startAt = Date.now() + wait;
    room.timer = setTimeout(() => start(room), wait);
  } else if (!room.priv && room.players.length === 1) {
    room.startAt = 0;
    room.timer = setTimeout(() => { if (room.state === "lobby" && room.players.length === 1) { send(room.players[0].ws, { t: "solo" }); leave(room.players[0]); } }, 15000);
  } else room.startAt = 0;
  lobby(room);
}

function start(room) {
  if (room.players.length < 1) return;
  if (room.players.length < 2 && room.bots < 1) return;
  clearTimeout(room.timer);
  room.state = "fight";
  room.results = new Map(); room.rematch = new Set();
  room.players.forEach((p, i) => { p.slot = i; });
  const seed = crypto.randomInt(1, 2 ** 31 - 1);
  const stage = room.stage >= 0 ? room.stage : crypto.randomInt(STAGES);
  const bots = Math.max(0, Math.min(MAX - room.players.length, room.bots));
  const players = room.players.map((p) => ({ ...pub(p), slot: p.slot }));
  for (const p of room.players) send(p.ws, { t: "start", stage, seed, you: p.slot, bots, botLv: room.botLv, players });
  room.timer = setTimeout(() => close(room), 15 * 60e3);   // hard cap on a room's life
}

function close(room) { clearTimeout(room.timer); rooms.delete(room.code); }

function leave(p) {
  const room = p.room;
  if (!room) return;
  p.room = null;
  room.players = room.players.filter((x) => x !== p);
  if (!room.players.length) { close(room); return; }
  if (room.state === "fight") {
    for (const o of room.players) send(o.ws, { t: "left", s: p.slot });
    maybeRematch(room);
  } else schedule(room);
}

function quick(p) {
  for (const r of rooms.values()) if (!r.priv && r.state === "lobby" && r.players.length < MAX) return join(p, r);
  const room = { code: code4(), priv: false, state: "lobby", players: [], timer: null, startAt: 0, stage: -1, bots: 0, botLv: 2 };
  rooms.set(room.code, room);
  join(p, room);
}

function join(p, room) {
  if (p.room) leave(p);
  p.room = room; room.players.push(p);
  schedule(room);
}

function maybeRematch(room) {
  if (room.state !== "fight" || !room.rematch || room.rematch.size === 0) return;
  if (room.players.every((p) => room.rematch.has(p))) start(room);
}

async function tally(room) {
  // every human reported, and they agree
  if (room.results.size < room.players.length || room.counted) return;
  const vals = [...room.results.values()];
  if (!vals.every((v) => v === vals[0])) return;
  room.counted = true;
  const w = vals[0];
  for (const p of room.players) {
    if (!p.pid) continue;
    const won = p.slot === w ? 1 : 0;
    try {
      const r = await db.query(
        `INSERT INTO brawl_stats (player, name, wins, games) VALUES ($1,$2,$3,1)
         ON CONFLICT (player) DO UPDATE SET name = EXCLUDED.name, wins = brawl_stats.wins + $3, games = brawl_stats.games + 1, at = now()
         RETURNING wins`, [p.pid, p.name, won]);
      const wins = r.rows[0].wins;
      const rk = await db.query("SELECT COUNT(*)::int + 1 AS rank FROM brawl_stats WHERE wins > $1", [wins]);
      const tot = await db.query("SELECT COUNT(*)::int AS n FROM brawl_stats WHERE wins > 0");
      send(p.ws, { t: "rank", wins, rank: rk.rows[0].rank, total: Math.max(tot.rows[0].n, rk.rows[0].rank) });
    } catch (e) { console.error(e); }
  }
}

export function handleBrawl(ws, req, cleanName) {
  const p = { ws, id: "b" + nextId++, pid: null, name: "BRAWLER", ch: 0, room: null, slot: -1 };
  send(ws, { t: "hello", id: p.id, online: brawlStats().players });
  ws.on("message", (raw) => {
    if (raw.length > 4000) return;
    const s = raw.toString();
    const room = p.room;
    // hot path: inputs and hashes go straight to the other fighters, tagged with our slot
    if (room && room.state === "fight" && (s.startsWith('{"t":"i"') || s.startsWith('{"t":"h"'))) {
      const out = s.slice(0, 8) + ',"s":' + p.slot + s.slice(8);
      for (const o of room.players) if (o !== p) send(o.ws, out);
      return;
    }
    let m; try { m = JSON.parse(s); } catch { return; }
    switch (m.t) {
      case "hello": {
        p.name = (cleanName && cleanName(m.name)) || "BRAWLER";
        p.ch = Math.max(0, Math.min(9, Math.floor(Number(m.ch)) || 0));
        const pid = String(m.player || "").replace(/[^a-f0-9-]/gi, "").slice(0, 40);
        p.pid = pid.length >= 8 ? pid : null;
        break;
      }
      case "quick": quick(p); break;
      case "create": {
        const r = { code: code4(), priv: true, state: "lobby", players: [], timer: null, startAt: 0, stage: -1, bots: 0, botLv: 2 };
        rooms.set(r.code, r); join(p, r); break;
      }
      case "join": {
        const r = rooms.get(String(m.code || "").toUpperCase());
        if (!r || r.state !== "lobby") send(ws, { t: "error", msg: "Room not found or already fighting." });
        else if (r.players.length >= MAX) send(ws, { t: "error", msg: "That room is full." });
        else join(p, r);
        break;
      }
      case "config":
        if (room && room.priv && room.players[0] === p && room.state === "lobby") {
          room.stage = Math.max(-1, Math.min(STAGES - 1, Math.floor(Number(m.stage))));
          room.bots = Math.max(0, Math.min(3, Math.floor(Number(m.bots)) || 0));
          room.botLv = Math.max(1, Math.min(3, Math.floor(Number(m.botLv)) || 2));
          lobby(room);
        }
        break;
      case "go":
        if (room && room.priv && room.players[0] === p && room.state === "lobby" && room.players.length + room.bots >= 2) start(room);
        break;
      case "result":
        if (room && room.state === "fight" && !room.results.has(p)) { room.results.set(p, Math.floor(Number(m.w))); tally(room); }
        break;
      case "rematch":
        if (room && room.state === "fight") { room.rematch.add(p); for (const o of room.players) send(o.ws, { t: "rematchVote", n: room.rematch.size, of: room.players.length }); maybeRematch(room); }
        break;
      case "leave": leave(p); break;
    }
  });
  ws.on("close", () => leave(p));
  ws.on("error", () => {});
}

export function brawlStats() {
  let players = 0, fighting = 0;
  for (const r of rooms.values()) { players += r.players.length; if (r.state === "fight") fighting++; }
  return { rooms: rooms.size, fighting, players };
}
