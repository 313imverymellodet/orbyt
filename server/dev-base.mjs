// Local dev server for the badge API (in-memory Postgres). node dev-base.mjs [port]
import http from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { initBase, baseHttp } from "./base.js";
const lite = new PGlite();
await initBase({ query: (q, p) => (p ? lite.query(q, p) : lite.exec(q).then((r) => r[r.length - 1] || { rows: [] })) });
const send = (res, code, body) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS"); res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, "http://x");
  try { if (!(await baseHttp(req, res, url, { send, ipOf: () => "1" }))) send(res, 404, {}); } catch (e) { console.error(e); send(res, 500, { e: e.message }); }
}).listen(+(process.argv[2] || 3999), () => console.log("base dev api on", process.argv[2] || 3999));
