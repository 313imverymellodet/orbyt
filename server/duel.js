// ORBYT duels: 1v1 on the same seeded course, relayed over WebSocket.
//
// client -> server                     server -> client
//   hello  {name}                        room   {code}                  (private room created, waiting)
//   quick  {}                            queued {}                      (in the quick-match queue)
//   create {}                            ghost  {seed, name, points}    (nobody around: race a recorded run)
//   join   {code}                        start  {seed, opp}             (both players in: go!)
//   state  {score, progress, lane}       opp    {score, progress, lane} (opponent's live state, ~10 Hz)
//   dead   {score}                       oppDead{score}                 (opponent crashed; beat this to win)
//   passed {score}                       end    {result, you, opp}      (win / lose / draw)
//   rematch{}                            left   {}                      (opponent disconnected)
//   timeline {seed, points, final}       error  {msg}
//   cancel {}
import crypto from "node:crypto";

const ghosts = [];                 // recent real runs: { seed, name, points: [[t, score, progress, lane]...], final }
const rooms = new Map();           // code -> Room
let waiting = null;                // quick-match player waiting for a partner
const WORDS = "BCDFGHJKLMNPQRSTVWXZ";

const code4 = () => { let c; do { c = Array.from({ length: 4 }, () => WORDS[crypto.randomInt(WORDS.length)]).join(""); } while (rooms.has(c)); return c; };
const seed = () => crypto.randomInt(1, 2_000_000_000);
const send = (p, msg) => { if (p && p.ws.readyState === 1) p.ws.send(JSON.stringify(msg)); };
const other = (room, p) => room.players.find((x) => x !== p);

function cleanName(n) { return String(n || "").toUpperCase().replace(/[^A-Z0-9 _.-]/g, "").trim().slice(0, 12) || "PLAYER"; }

function newRoom(private_) {
  const room = { code: code4(), players: [], state: "wait", seed: 0, private: private_, rematch: new Set(), started: 0 };
  rooms.set(room.code, room);
  return room;
}

function start(room) {
  room.state = "play";
  room.seed = seed();
  room.started = Date.now();
  room.rematch.clear();
  for (const p of room.players) { p.alive = true; p.score = 0; p.final = null; p.lastState = 0; }
  for (const p of room.players) send(p, { t: "start", seed: room.seed, opp: other(room, p).name, code: room.code });
}

function finish(room, winner) {
  if (room.state !== "play") return;
  room.state = "done";
  const [a, b] = room.players;
  for (const p of room.players) {
    const o = other(room, p);
    const result = !winner ? "draw" : winner === p ? "win" : "lose";
    send(p, { t: "end", result, you: p.final ?? p.score, opp: o ? (o.final ?? o.score) : 0 });
  }
}

// plausibility: a player can't score faster than ~7 points/second of real match time
function plausible(room, score) { return score <= (Date.now() - room.started) / 1000 * 7 + 10; }

function leave(p) {
  if (waiting === p) waiting = null;
  const room = p.room;
  if (!room) return;
  p.room = null;
  room.players = room.players.filter((x) => x !== p);
  const o = room.players[0];
  if (o) {
    if (room.state === "play") { o.final = o.score; finishFor(o, "win"); }
    send(o, { t: "left" });
  }
  if (!room.players.length) rooms.delete(room.code);
}

function finishFor(p, result) { send(p, { t: "end", result, you: p.final ?? p.score, opp: 0 }); if (p.room) p.room.state = "done"; }

// Synthetic ghost for an empty server: a believable run (speeds up, dies somewhere between 12 and 45).
function botGhost() {
  const s = seed(), final = 12 + crypto.randomInt(34), pts = [];
  let t = 0, score = 0, prog = 0, lane = 1, w = 1.55;
  while (score < final) {
    t += 0.25; w = Math.min(3.9, 1.55 + score * 0.012 + Math.floor(score / 25) * 0.28); prog += w * 0.25;
    if (Math.random() < 0.38) score++;
    if (Math.random() < 0.3) lane = 1 - lane;
    pts.push([+t.toFixed(2), score, +prog.toFixed(2), lane]);
  }
  return { seed: s, name: "ORBYT BOT", points: pts, final, bot: true };
}

export function handleDuel(ws) {
  const p = { ws, name: "PLAYER", room: null, alive: false, score: 0, final: null, lastState: 0, msgs: 0, window: Date.now() };

  ws.on("message", (raw) => {
    // flood guard: 40 messages / second
    if (Date.now() - p.window > 1000) { p.window = Date.now(); p.msgs = 0; }
    if (++p.msgs > 40) return;
    let m; try { m = JSON.parse(raw); } catch { return; }

    switch (m.t) {
      case "hello": p.name = cleanName(m.name); break;

      case "quick": {
        if (p.room) leave(p);
        if (waiting && waiting !== p && waiting.ws.readyState === 1) {
          const room = newRoom(false);
          room.players.push(waiting, p);
          waiting.room = p.room = room;
          waiting = null;
          start(room);
        } else {
          waiting = p;
          send(p, { t: "queued" });
          setTimeout(() => {
            if (waiting !== p) return;
            waiting = null;
            const pool = ghosts.filter((g) => g.name !== p.name);
            const g = pool.length ? pool[crypto.randomInt(pool.length)] : botGhost();
            send(p, { t: "ghost", seed: g.seed, name: g.name, points: g.points, final: g.final, bot: !!g.bot });
          }, 8000);
        }
        break;
      }

      case "create": {
        if (p.room) leave(p);
        const room = newRoom(true);
        room.players.push(p); p.room = room;
        send(p, { t: "room", code: room.code });
        break;
      }

      case "join": {
        const room = rooms.get(String(m.code || "").toUpperCase());
        if (!room || room.players.length >= 2 || room.state !== "wait") { send(p, { t: "error", msg: "Room not found or already full." }); break; }
        if (p.room) leave(p);
        room.players.push(p); p.room = room;
        start(room);
        break;
      }

      case "state": {
        const room = p.room;
        if (!room || room.state !== "play" || !p.alive) break;
        const score = Math.max(0, Math.floor(Number(m.score) || 0));
        if (!plausible(room, score)) break;
        p.score = score;
        send(other(room, p), { t: "opp", score, progress: Number(m.progress) || 0, lane: m.lane ? 1 : 0 });
        break;
      }

      case "dead": {
        const room = p.room;
        if (!room || room.state !== "play" || !p.alive) break;
        p.alive = false;
        p.final = Math.min(Math.max(p.score, Math.floor(Number(m.score) || 0)), Math.floor((Date.now() - room.started) / 1000 * 7 + 10));
        const o = other(room, p);
        if (!o || !o.alive) {
          const a = p.final, b = o ? o.final : -1;
          finish(room, a === b ? null : a > b ? p : o);
        } else send(o, { t: "oppDead", score: p.final });
        break;
      }

      case "passed": {
        // survivor overtook a crashed opponent: they win on the spot
        const room = p.room;
        if (!room || room.state !== "play" || !p.alive) break;
        const o = other(room, p);
        const s = Math.floor(Number(m.score) || 0);
        if (o && !o.alive && s > o.final && plausible(room, s)) { p.final = s; p.alive = false; finish(room, p); }
        break;
      }

      case "rematch": {
        const room = p.room;
        if (!room || room.state !== "done") break;
        room.rematch.add(p);
        const o = other(room, p);
        if (o) send(o, { t: "rematchAsk" });
        if (room.players.length === 2 && room.rematch.size === 2) start(room);
        break;
      }

      case "timeline": {
        // keep recent real runs to serve as ghosts; lightly validated
        const pts = Array.isArray(m.points) ? m.points.slice(0, 2400) : [];
        const final = Math.floor(Number(m.final) || 0);
        if (pts.length > 8 && final >= 5 && Number.isFinite(Number(m.seed))) {
          ghosts.push({ seed: Number(m.seed), name: p.name, points: pts, final });
          if (ghosts.length > 120) ghosts.shift();
        }
        break;
      }

      case "cancel": leave(p); break;
    }
  });

  ws.on("close", () => leave(p));
}

export function duelStats() { return { rooms: rooms.size, waiting: waiting ? 1 : 0, ghosts: ghosts.length }; }
