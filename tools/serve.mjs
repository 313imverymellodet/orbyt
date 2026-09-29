// Local static server that mirrors the Vercel headers in dist/vercel.json.
// Usage: node tools/serve.mjs [port]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "../dist");
const port = Number(process.argv[2] || process.env.PORT || 8080);
const types = {
  ".html": "text/html; charset=utf-8", ".js": "application/javascript", ".json": "application/json",
  ".png": "image/png", ".css": "text/css", ".webmanifest": "application/manifest+json", ".wasm": "application/wasm",
};

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p.endsWith("/")) p += "index.html";
  const file = path.join(root, p);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end("not found");
  }
  const headers = { "Cache-Control": "no-cache" };
  if (file.endsWith(".unityweb")) {
    headers["Content-Encoding"] = "br";
    headers["Content-Type"] = file.includes(".wasm.") ? "application/wasm" : file.includes(".js.") ? "application/javascript" : "application/octet-stream";
  } else {
    headers["Content-Type"] = types[path.extname(file)] || "application/octet-stream";
  }
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}).listen(port, "0.0.0.0", () => {
  const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal);
  console.log(`ORBYT on http://localhost:${port}` + (lan ? `  (phone on same Wi-Fi: http://${lan.address}:${port})` : ""));
});
