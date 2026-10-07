// First-party game analytics: daily event counts per game, plus unique sessions (≈ daily players).
//   POST /api/ev                  { g, s, e: [[name, value], ...] }   (also accepts sendBeacon text bodies)
//   POST /api/admin/stats         { key, days? }                      -> per game, per day, per event totals
// No personal data: a random per-tab session id, the game id, event names and small integer values.
import crypto from "node:crypto";

const GAMES = ["orbyt", "spacediner", "graveshift", "cityrush", "orderup", "bonkbrawl", "obbyrush", "snackmerge", "kartchaos", "orbitdepot"];
const NAME = /^[a-z0-9_]{1,40}$/;
let db = null;
const lastHit = new Map();

const today = () => { const d = new Date(); return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate(); };

export async function initAnalytics(pool) {
  db = pool;
  await db.query(`
    CREATE TABLE IF NOT EXISTS ev_daily (
      game TEXT NOT NULL, name TEXT NOT NULL, day INTEGER NOT NULL,
      n BIGINT NOT NULL DEFAULT 0, total BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY (game, name, day)
    );
    CREATE TABLE IF NOT EXISTS ev_sessions (
      game TEXT NOT NULL, day INTEGER NOT NULL, sid TEXT NOT NULL,
      PRIMARY KEY (game, day, sid)
    );
  `);
  setInterval(() => lastHit.clear(), 600e3);
}

async function readBody(req) {
  let s = "";
  for await (const c of req) { s += c; if (s.length > 8000) throw new Error("too large"); }
  return s ? JSON.parse(s) : {};
}

export async function analyticsHttp(req, res, url, { send, ipOf }) {
  const p = url.pathname;

  if (p === "/api/ev" && req.method === "POST") {
    // a page flushes at most every few seconds; anything faster is noise
    const ip = ipOf(req);
    const n = (lastHit.get(ip) || 0) + 1; lastHit.set(ip, n);
    if (n > 400) { send(res, 429, {}); return true; }
    let b; try { b = await readBody(req); } catch { send(res, 400, {}); return true; }
    const g = String(b.g || "");
    // portal builds report as "<game>_cg" / "_poki" / "_gd" so each storefront gets its own funnel
    if (!GAMES.includes(g.replace(/_(cg|poki|gd)$/, "")) || !Array.isArray(b.e)) { send(res, 400, {}); return true; }
    const day = today();
    const sid = String(b.s || "").replace(/[^a-z0-9]/gi, "").slice(0, 24);
    if (sid.length >= 8) await db.query("INSERT INTO ev_sessions (game, day, sid) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [g, day, sid]);
    // fold duplicates client-side-style before writing
    const agg = new Map();
    for (const ev of b.e.slice(0, 60)) {
      if (!Array.isArray(ev)) continue;
      const name = String(ev[0] || "").toLowerCase();
      if (!NAME.test(name)) continue;
      const v = Math.max(-1e7, Math.min(1e7, Math.floor(Number(ev[1]) || 0)));
      const a = agg.get(name) || [0, 0]; a[0]++; a[1] += v; agg.set(name, a);
    }
    for (const [name, [cnt, sum]] of agg)
      await db.query(`INSERT INTO ev_daily (game, name, day, n, total) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (game, name, day) DO UPDATE SET n = ev_daily.n + EXCLUDED.n, total = ev_daily.total + EXCLUDED.total`, [g, name, day, cnt, sum]);
    send(res, 200, {});
    return true;
  }

  if (p === "/api/admin/stats" && req.method === "POST") {
    let b; try { b = await readBody(req); } catch { send(res, 400, {}); return true; }
    const key = process.env.ADMIN_KEY || "";
    if (key.length < 16 || !b.key || !crypto.timingSafeEqual(Buffer.from(String(b.key).padEnd(64)).subarray(0, 64), Buffer.from(key.padEnd(64)).subarray(0, 64))) { send(res, 403, { error: "forbidden" }); return true; }
    const days = Math.max(1, Math.min(90, Math.floor(Number(b.days) || 7)));
    const since = (() => { const d = new Date(Date.now() - (days - 1) * 864e5); return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate(); })();
    const ev = await db.query("SELECT game, day, name, n, total FROM ev_daily WHERE day >= $1 ORDER BY game, day, name", [since]);
    const ss = await db.query("SELECT game, day, COUNT(*)::int AS players FROM ev_sessions WHERE day >= $1 GROUP BY game, day ORDER BY game, day", [since]);
    send(res, 200, { since, events: ev.rows, sessions: ss.rows });
    return true;
  }
  return false;
}
