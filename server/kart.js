// KART CHAOS service: /kart WebSocket battle rooms (up to 8 drivers, bots fill to 6).
// Rooms run back-to-back 150 s matches. Players can join mid-match (taking a bot's seat).
// Each client simulates its own kart; the room host (a human) also simulates the bots.
// Hits are reported by the victim's simulator; the server keeps the only scoreboard.
import crypto from "node:crypto";

const MAX = 8, MIN_KARTS = 6, MATCH_MS = 150e3, BREAK_MS = 10e3, MAPS = 2, VEHICLES = 14;
const BOT_NAMES = ["ZOOMER", "TURBO TOM", "SKIDMARK", "NITRO NAT", "BUMPER", "DRIFTY", "VROOM", "PIXEL PETE", "CRASHLEY", "HONK",
  "SPARKY", "LUGNUT", "MAX DASH", "ROCKETTE", "WHEELIE", "GRIDLOCK", "TOAST", "BLITZ", "PISTON", "ZIGZAG",
  "CHAOS CAT", "BEEP BEEP", "RALLY", "SPIN CITY", "DONUT", "BOLT", "SCOOT", "FUMES", "COG", "PEDAL"];
const rooms = new Map();           // code -> room
let nextId = 1, matchesPlayed = 0;

const code4 = () => { let c; do { c = Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ"[crypto.randomInt(24)]).join(""); } while (rooms.has(c)); return c; };
const send = (ws, m) => { if (ws.readyState === 1) ws.send(typeof m === "string" ? m : JSON.stringify(m)); };
const humans = (room) => room.slots.filter((s) => s && s.p);
const occupied = (room) => room.slots.filter(Boolean).length;
const cast = (room, m, except) => { const s = JSON.stringify(m); for (const h of humans(room)) if (h.p !== except) send(h.p.ws, s); };

function botName(room) {
  const used = new Set(room.slots.filter(Boolean).map((s) => s.name));
  for (let i = 0; i < 40; i++) { const n = BOT_NAMES[crypto.randomInt(BOT_NAMES.length)]; if (!used.has(n)) return n; }
  return "BOT " + crypto.randomInt(100);
}
const newBot = (room) => ({ bot: true, name: botName(room), kart: crypto.randomInt(VEHICLES) });

function roster(room) {
  const karts = [];
  room.slots.forEach((s, i) => { if (s) karts.push({ s: i, n: s.p ? s.p.name : s.name, k: s.p ? s.p.kart : s.kart, b: s.p ? 0 : 1, a: s.p && s.p.away ? 1 : 0 }); });
  return karts;
}

// host: the longest-present active human who is actually sending updates; they simulate the bots.
// A backgrounded tab stops sending (browsers pause it), so hosting moves on instead of freezing every bot.
const fresh = (p, now) => now - p.last < 2500 || now - p.joined < 4000;
function pickHost(room) {
  const now = Date.now();
  const active = room.slots.map((s, i) => ({ s, i })).filter((x) => x.s && x.s.p && !x.s.p.away).sort((a, b) => a.s.p.joined - b.s.p.joined);
  const live = active.filter((x) => fresh(x.s.p, now));
  const pick = live.length ? live : active;
  room.host = pick.length ? pick[0].i : -1;
}
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.state !== "play") continue;
    const h = room.host >= 0 && room.slots[room.host] && room.slots[room.host].p;
    if (h && !h.away && fresh(h, now)) continue;
    const old = room.host; pickHost(room);
    if (room.host !== old) syncRoster(room);
  }
}, 1000);

function snapshot(room, p) {
  return { t: "match", you: p.slot, host: room.host, map: room.map, code: room.priv ? room.code : "", left: Math.max(0, room.endsAt - Date.now()), karts: roster(room), sc: room.scores };
}

function fillBots(room) {
  // drop bots above the minimum, then top back up to it
  for (let i = MAX - 1; i >= 0 && occupied(room) > MIN_KARTS; i--) if (room.slots[i] && room.slots[i].bot) room.slots[i] = null;
  for (let i = 0; i < MAX && occupied(room) < MIN_KARTS; i++) if (!room.slots[i]) room.slots[i] = newBot(room);
}

function newMatch(room) {
  clearTimeout(room.timer);
  if (!humans(room).length) { rooms.delete(room.code); return; }
  room.state = "play";
  room.scores = new Array(MAX).fill(0);
  room.lastHit = new Array(MAX).fill(0);
  room.map = (room.map + 1 + crypto.randomInt(MAPS - 1 || 1)) % MAPS;
  for (let i = 0; i < MAX; i++) if (room.slots[i] && room.slots[i].bot) room.slots[i] = newBot(room);   // fresh bot names each match
  fillBots(room);
  room.endsAt = Date.now() + MATCH_MS;
  pickHost(room);
  for (const h of humans(room)) if (!h.p.away) send(h.p.ws, snapshot(room, h.p));
  room.timer = setTimeout(() => endMatch(room), MATCH_MS);
  matchesPlayed++;
}

function endMatch(room) {
  if (room.state !== "play") return;
  room.state = "break";
  cast(room, { t: "end", sc: room.scores });
  room.endsAt = Date.now() + BREAK_MS;
  room.timer = setTimeout(() => newMatch(room), BREAK_MS);
}

function syncRoster(room) {
  pickHost(room);
  cast(room, { t: "roster", host: room.host, karts: roster(room) });
}

function join(p, room) {
  if (p.room) leave(p);
  // take a bot's seat first, else an empty one
  let slot = room.slots.findIndex((s) => s && s.bot);
  if (humans(room).length < MIN_KARTS && slot < 0) slot = room.slots.findIndex((s) => !s);
  if (slot < 0) slot = room.slots.findIndex((s) => !s);
  if (slot < 0) { send(p.ws, { t: "error", msg: "That room is full." }); return; }
  p.room = room; p.slot = slot; p.away = false; p.joined = Date.now();
  room.slots[slot] = { p };
  room.scores[slot] = 0;
  pickHost(room);
  if (room.state === "play") { send(p.ws, snapshot(room, p)); syncRoster(room); }
  else syncRoster(room);   // between matches: they get the next "match"
}

function leave(p) {
  const room = p.room;
  if (!room) return;
  p.room = null;
  if (room.slots[p.slot] && room.slots[p.slot].p === p) room.slots[p.slot] = null;
  if (!humans(room).length) { clearTimeout(room.timer); rooms.delete(room.code); return; }
  fillBots(room);
  if (room.slots[p.slot] && room.slots[p.slot].bot) room.scores[p.slot] = 0;
  syncRoster(room);
}

function makeRoom(priv) {
  const room = { code: code4(), priv, slots: new Array(MAX).fill(null), scores: new Array(MAX).fill(0), lastHit: new Array(MAX).fill(0), state: "play", map: crypto.randomInt(MAPS), host: -1, endsAt: 0, timer: null };
  rooms.set(room.code, room);
  return room;
}

function quick(p) {
  // the public room with the most people that still has a seat and time on the clock
  let best = null;
  for (const r of rooms.values()) {
    if (r.priv || humans(r).length >= MAX) continue;
    if (r.state === "play" && r.endsAt - Date.now() < 30e3) continue;
    if (r.state === "break" && r.endsAt - Date.now() > 4e3) continue;   // don't park a new player on a results screen
    if (!best || humans(r).length > humans(best).length) best = r;
  }
  if (best) return join(p, best);
  const room = makeRoom(false);
  room.slots[0] = { p }; p.room = room; p.slot = 0; p.away = false; p.joined = Date.now();
  room.map = crypto.randomInt(MAPS) - 1;   // newMatch advances it
  newMatch(room);
}

function create(p) {
  const room = makeRoom(true);
  room.slots[0] = { p }; p.room = room; p.slot = 0; p.away = false; p.joined = Date.now();
  room.map = crypto.randomInt(MAPS) - 1;
  newMatch(room);
}

// does this player simulate kart `slot`?
const owns = (p, slot) => {
  const room = p.room; if (!room || slot < 0 || slot >= MAX) return false;
  const s = room.slots[slot];
  return !!s && (s.p === p || (s.bot && room.host === p.slot));
};

export function handleKart(ws) {
  const p = { ws, id: nextId++, name: "RACER", kart: 0, room: null, slot: -1, away: false, joined: 0, last: 0, hits: [] };
  send(ws, { t: "hello", online: kartStats().players + 1 });
  ws.on("message", (raw) => {
    if (raw.length > 1500) return;
    let m; try { m = JSON.parse(raw); } catch { return; }
    const room = p.room;
    switch (m.t) {
      case "hello":
        p.name = String(m.name || "").toUpperCase().replace(/[^A-Z0-9 _.-]/g, "").slice(0, 12).trim() || "RACER";
        p.kart = Math.max(0, Math.min(VEHICLES - 1, m.kart | 0));
        break;
      case "quick": if (!room) quick(p); break;
      case "create": if (!room) create(p); break;
      case "join": {
        const r = rooms.get(String(m.code || "").toUpperCase().slice(0, 6));
        if (!r) send(ws, { t: "error", msg: "No room with that code." });
        else join(p, r);
        break;
      }
      case "s": {
        if (!room || room.state !== "play" || p.away || !Array.isArray(m.d)) return;
        const now = Date.now();
        if (now - p.last < 50) return;   // ~20 Hz cap
        p.last = now;
        const d = [];
        for (let i = 0; i + 6 < m.d.length && i < 7 * MAX; i += 7) {
          const slot = m.d[i] | 0;
          if (!owns(p, slot)) continue;
          for (let j = 0; j < 7; j++) d.push(Math.round(Number(m.d[i + j]) * 100) / 100 || 0);
        }
        if (d.length) { const s = JSON.stringify({ t: "s", d }); for (const h of humans(room)) if (h.p !== p && !h.p.away) send(h.p.ws, s); }
        break;
      }
      case "f": {
        if (!room || room.state !== "play" || !owns(p, m.k | 0)) return;
        const n = (v) => Math.round(Number(v) * 100) / 100 || 0;
        const f = JSON.stringify({ t: "f", k: m.k | 0, i: Math.max(1, Math.min(6, m.i | 0)), x: n(m.x), z: n(m.z), a: n(m.a), p: m.p | 0 });
        for (const h of humans(room)) if (h.p !== p && !h.p.away) send(h.p.ws, f);
        break;
      }
      case "h": {
        // the victim's simulator reports; one hit per victim per second, max 12 reports a second per sender
        if (!room || room.state !== "play") return;
        const v = m.v | 0, by = m.by | 0, now = Date.now();
        if (!owns(p, v) || by === v || by < 0 || by >= MAX || !room.slots[by]) return;
        p.hits = p.hits.filter((t) => now - t < 1000); if (p.hits.length >= 12) return; p.hits.push(now);
        if (now - room.lastHit[v] < 1000) return;
        room.lastHit[v] = now;
        room.scores[by]++;
        cast(room, { t: "h", v, by, p: m.p | 0, sc: room.scores });
        break;
      }
      case "b": {
        if (!room || room.state !== "play") return;
        const s = JSON.stringify({ t: "b", i: Math.max(0, Math.min(40, m.i | 0)) });
        for (const h of humans(room)) if (h.p !== p && !h.p.away) send(h.p.ws, s);
        break;
      }
      case "away": if (room) { p.away = true; syncRoster(room); } break;
      case "back":
        if (room) {
          p.away = false;
          pickHost(room);
          if (room.state === "play") send(ws, snapshot(room, p));
          syncRoster(room);
        }
        break;
      case "leave": leave(p); break;
    }
  });
  ws.on("close", () => leave(p));
  ws.on("error", () => {});
}

export function kartStats() {
  let players = 0, priv = 0;
  for (const r of rooms.values()) { players += humans(r).length; if (r.priv) priv++; }
  return { rooms: rooms.size, private: priv, players, matches: matchesPlayed };
}
