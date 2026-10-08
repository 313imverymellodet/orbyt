// Packages dist/ (the Unity WebGL build) for the web-game portals, one folder + zip each:
//   portals/crazygames/  + orbyt-crazygames.zip   CrazyGames SDK v3
//   portals/poki/        + orbyt-poki.zip         Poki SDK v2
//   portals/gd/          + orbyt-gd.zip           GameDistribution (needs the game id from the GD dashboard)
// Usage: node tools/portals.mjs [--gd <gameId>]
// Each copy sets window.PORTAL, loads that portal's SDK, and drops our site-only bits (OG tags, PWA manifest).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "..");
const dist = path.join(root, "dist"), out = path.join(root, "portals");
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const gdId = arg("--gd") || "GD_GAME_ID";

const PORTALS = {
  crazygames: `<script src="https://sdk.crazygames.com/crazygames-sdk-v3.js"></script>`,
  poki: `<script src="https://game-cdn.poki.com/scripts/v2/poki-sdk.js"></script>`,
  gd: `<script>window["GD_OPTIONS"] = { gameId: ${JSON.stringify(gdId)}, onEvent: function (e) { window.__gdEvent && window.__gdEvent(e); } };</script>
  <script src="https://html5.api.gamedistribution.com/main.min.js"></script>`,
};

if (!fs.existsSync(path.join(dist, "index.html"))) { console.error("dist/ is empty - build the game first"); process.exit(1); }
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

for (const [name, sdk] of Object.entries(PORTALS)) {
  const dir = path.join(out, name);
  fs.cpSync(dist, dir, { recursive: true });
  for (const f of ["og.png", "manifest.webmanifest"]) fs.rmSync(path.join(dir, f), { force: true });
  let html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
  html = html
    .replace(/\s*<meta (property="og:|name="twitter:)[^>]*>/g, "")
    .replace(/\s*<link rel="manifest"[^>]*>/, "")
    .replace(/\s*<meta name="(apple-mobile-web-app-capable|mobile-web-app-capable|apple-mobile-web-app-status-bar-style)"[^>]*>/g, "")
    .replace("<meta charset=\"utf-8\">", `<meta charset="utf-8">\n  <script>window.PORTAL = "${name}";</script>\n  ${sdk}`);
  if (!html.includes(`window.PORTAL = "${name}"`)) throw new Error("could not inject the SDK into " + name);
  fs.writeFileSync(path.join(dir, "index.html"), html);

  const zip = path.join(out, `orbyt-${name}.zip`);
  // Python's zipfile writes plain, forward-slash entries that Windows Explorer and every portal uploader accept
  // (Windows tar.exe zips are valid but Explorer refuses them)
  const py = `import os, sys, zipfile
src, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for root, _, files in os.walk(src):
        for f in files:
            full = os.path.join(root, f)
            z.write(full, os.path.relpath(full, src).replace(os.sep, "/"))`;
  try {
    execFileSync(process.platform === "win32" ? "python" : "python3", ["-c", py, dir, zip]);
  } catch (e) {
    console.error("zip failed for", name, e.message);
    continue;
  }
  const mb = (fs.statSync(zip).size / 1048576).toFixed(1);
  console.log(`${name.padEnd(11)} ${zip}  (${mb} MB)`);
}
if (gdId === "GD_GAME_ID") console.log("\nGameDistribution build uses a placeholder id - rerun with --gd <your game id> before uploading.");
