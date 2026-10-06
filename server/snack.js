// SNACK MERGE service: classic (all-time) and daily-jar high scores.
//   POST /api/snack/run     -> { token }            (clock starts with the game)
//   POST /api/snack/finish  -> { rank, total, best } (plausibility-checked against drops and wall clock)
//   GET  /api/snack/board   -> { mode, day, top }    ?mode=classic|daily
import crypto from "node:crypto";

const MODES = ["classic", "daily"];
const DROP_CD_MS = 400;          // the game enforces 450 ms between drops
let db = null;
const runs = new Map();          // token -> { start, mode, day, used }
const lastSubmit = new Map();

const today = () => { const d = new Date(); return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate(); };

export async function initSnack(pool) {
  db = pool;
  await db.query(`
    CREATE TABLE IF NOT EXISTS snack_scores (
      player TEXT NOT NULL,
      name   TEXT NOT NULL,
      mode   TEXT NOT NULL,
      day    INTEGER NOT NULL,          -- 0 for classic (all-time)
      score  INTEGER NOT NULL,
      tier   INTEGER NOT NULL DEFAULT 0,
      at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (player, mode, day)
    );
    CREATE INDEX IF NOT EXISTS snack_board ON snack_scores (mode, day, score DESC, at ASC);
  `);
  setInterval(() => { const cut = Date.now() - 6 * 3600e3; for (const [k, v] of runs) if (v.start < cut) runs.delete(k); }, 600e3);
}

async function board(mode, day, limit = 20) {
  const r = await db.query("SELECT name, score, tier FROM snack_scores WHERE mode=$1 AND day=$2 ORDER BY score DESC, at ASC LIMIT $3", [mode, day, limit]);
  return r.rows;
}

export async function snackHttp(req, res, url, { send, readJson, cleanName, ipOf, broadcast }) {
  const p = url.pathname;
  if (!p.startsWith("/api/snack/")) return false;

  if (p === "/api/snack/run" && req.method === "POST") {
    const b = await readJson(req);
    const mode = MODES.includes(b.mode) ? b.mode : "classic";
    const token = crypto.randomBytes(16).toString("hex");
    runs.set(token, { start: Date.now(), mode, day: mode === "daily" ? today() : 0, used: false });
    send(res, 200, { token });
    return true;
  }

  if (p === "/api/snack/board" && req.method === "GET") {
    const mode = MODES.includes(url.searchParams.get("mode")) ? url.searchParams.get("mode") : "classic";
    const day = mode === "daily" ? today() : 0;
    send(res, 200, { mode, day, top: await board(mode, day, Math.min(50, Number(url.searchParams.get("limit")) || 30)) });
    return true;
  }

  if (p === "/api/snack/finish" && req.method === "POST") {
    const ip = ipOf(req);
    if (Date.now() - (lastSubmit.get(ip) || 0) < 2000) { send(res, 429, { error: "slow down" }); return true; }
    lastSubmit.set(ip, Date.now());
    const b = await readJson(req);
    const run = runs.get(b.token);
    if (!run || run.used) { send(res, 400, { error: "invalid run" }); return true; }
    run.used = true;
    const score = Math.floor(Number(b.score)), drops = Math.floor(Number(b.drops)), tier = Math.max(0, Math.min(10, Math.floor(Number(b.tier)) || 0));
    const elapsed = Date.now() - run.start;
    if (!Number.isFinite(score) || score <= 0 || score > 2e6 || !Number.isFinite(drops) || drops < 1) { send(res, 400, { error: "bad score" }); return true; }
    // every drop needs real time, and each drop can only feed so many merges
    if (drops * DROP_CD_MS > elapsed + 3000) { send(res, 400, { error: "implausible" }); return true; }
    // merges + monster meals (up to ~420 a meal) + pepper blasts: generous ceiling per drop
    if (score > drops * 650 + 3000) { send(res, 400, { error: "implausible" }); return true; }
    const name = cleanName(b.name);
    if (!name) { send(res, 400, { error: "bad name" }); return true; }
    const player = String(b.player || "").replace(/[^a-f0-9-]/gi, "").slice(0, 40);
    if (player.length < 8) { send(res, 400, { error: "bad player" }); return true; }

    const up = await db.query(
      `INSERT INTO snack_scores (player, name, mode, day, score, tier) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (player, mode, day) DO UPDATE SET
         name = EXCLUDED.name,
         score = GREATEST(snack_scores.score, EXCLUDED.score),
         tier = CASE WHEN EXCLUDED.score > snack_scores.score THEN EXCLUDED.tier ELSE snack_scores.tier END,
         at = CASE WHEN EXCLUDED.score > snack_scores.score THEN now() ELSE snack_scores.at END
       RETURNING score`, [player, name, run.mode, run.day, score, tier]);
    const best = up.rows[0].score;
    const rk = await db.query("SELECT COUNT(*)::int + 1 AS rank FROM snack_scores WHERE mode=$1 AND day=$2 AND score > $3", [run.mode, run.day, best]);
    const tot = await db.query("SELECT COUNT(*)::int AS n FROM snack_scores WHERE mode=$1 AND day=$2", [run.mode, run.day]);
    if (score >= best) broadcast({ type: "snack", mode: run.mode, name, score: best, rank: rk.rows[0].rank });
    send(res, 200, { mode: run.mode, rank: rk.rows[0].rank, total: tot.rows[0].n, best });
    return true;
  }

  send(res, 404, { error: "not found" });
  return true;
}

export async function snackRemove(names, prefix) {
  const r = await db.query("DELETE FROM snack_scores WHERE name = ANY($1) OR ($2::text IS NOT NULL AND player LIKE $2)", [names, prefix]);
  return r.rowCount;
}
