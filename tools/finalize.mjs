// Stamps the public URL into dist/index.html so link previews (iMessage, X, Discord…) show the OG card.
// On Vercel this runs as the build step and picks up the production domain automatically.
// Manual use: node tools/finalize.mjs https://orbyt.vercel.app
import fs from "node:fs";
import path from "node:path";

const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
const url = (process.argv[2] || (host ? "https://" + host : "")).replace(/\/$/, "");
if (!/^https:\/\//.test(url)) {
  console.log("No site URL given — leaving OG tags untouched.");
  process.exit(0);
}
const file = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "../dist/index.html");
const html = fs.readFileSync(file, "utf8").replaceAll("__SITE_URL__", url);
fs.writeFileSync(file, html);
console.log("Stamped", url, "into", file);
