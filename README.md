# ORBYT

One tap. Two orbits. No mercy. This is a Unity 6 WebGL arcade game made for mobile browsers and hosted on Vercel.

## The hook: ECHO
Your previous run comes back. From 3 seconds in, a ghostly orb rides the rings the **opposite way**, replaying your last run's lane switches at the same moments.
- **Touch it** and the run is over ("YOUR ECHO GOT YOU").
- **Slip past it** in the other orbit for **+2** (ECHO DODGE).
- It dies where your last run died: **outlive it for +5**.
- First-time players get a demo echo, so everyone meets it in the first few seconds. DUEL mode has no echo.
- Endless and Daily each keep their own echo (PlayerPrefs `echo` / `echo_daily`).
- Analytics: `echo_spawn`, `echo_death`, `echo_outlived`.

## How it plays
- **Tap anywhere** to switch between the inner and outer orbit and dodge the spikes.
- **PERFECT:** dodge at the last moment to get bonus points. Chain them for combos (CLUTCH, INSANE, GODLIKE).
- **FLIP:** every 25 points the orbit changes direction and the whole color palette shifts.
- **Shards:** collect them to unlock 7 skins, including the animated PRISM skin.
- **Daily Challenge:** everyone gets the same seeded course each day. The SHARE button creates a Wordle-style emoji card.

There are no art or audio files. All sprites, sound effects and the synthwave soundtrack are generated in code at startup, which keeps the download small.

## How to play (also shown in-game on first launch, and from the HOW TO PLAY button)
- **Tap** anywhere to jump between the inner and outer orbit.
- **Dodge** the spikes riding the rings. One touch ends the run.
- **PERFECT:** switch at the last second for bonus points. Chain PERFECTs for combos.
- **FLIP:** every 25 points the orbit reverses direction and the palette changes.
- **Shards** unlock skins on the menu.
- **DAILY:** one seeded course for everyone each day, ranked. **DUEL:** race a rival live.

## Online features (Railway: `server/`)
One Node service (`server.js` + `duel.js`) with Postgres, deployed with `railway up --service orbyt-api`.

| Feature | How it works |
|---|---|
| Live leaderboard | `POST /api/run` starts a server-timed run, then `POST /api/score` validates and ranks it. `/live` WebSocket pushes new bests to open boards. Page overlay: `WebGLTemplates/Orbyt/lb.js` |
| Duels | `/duel` WebSocket: Quick Match queue, private 4-letter rooms, invite links `?duel=CODE`, live state relay, overtake-to-win, rematch. Page lobby: `duel.js` |
| Ghosts | Finished runs are stored as ghosts. Quick Match falls back to a ghost after 8s, or a practice bot on an empty server. |
| Anti-cheat | Server-timed runs, max-score-per-second checks, one-time run tokens, rate limits, name filter |
| Moderation | `POST /api/admin/remove {key, names:[...]}`. The key is in `ADMIN_KEY.txt` (git-ignored) and in the Railway `ADMIN_KEY` variable. |

## Layout
```
unity/                        Unity 6 project (6000.6.3f1)
  Assets/Scripts/             Game.cs, Fx.cs, Sfx.cs, Gfx.cs, WebBridge.cs
  Assets/Plugins/WebGL/       Orbyt.jslib: native share sheet, haptics, analytics
  Assets/Editor/OrbytBuild.cs One-command build
  Assets/WebGLTemplates/Orbyt Loader page, OG card, icons, PWA manifest, vercel.json
dist/                         Build output. Deploy this folder.
tools/serve.mjs               Local server that mirrors the Vercel headers
tools/finalize.mjs            Adds your public URL to the OG meta tags
art/                          HTML sources for the OG image and icons
```

## Build
```bash
"C:\Program Files\Unity\Hub\Editor\6000.6.3f1\Editor\Unity.exe" -batchmode -nographics -projectPath unity -executeMethod OrbytBuild.WebGL -quit -logFile build.log
```
You can also use the **ORBYT → Build WebGL** menu in the editor. This needs the "Web Build Support" module from Unity Hub.

## Test locally (and on your phone)
```bash
node tools/serve.mjs 8080
```

## Deploy to Vercel
To deploy from GitHub, import this repo in Vercel. The root `vercel.json` has everything Vercel needs: there's no install step and no framework, the output folder is `dist/`, and it sets the compression headers. During the build, `tools/finalize.mjs` automatically adds your production domain to the social preview tags.

Vercel can't run Unity. **After changing the game, rebuild locally (see Build above), then commit `dist/`.** Pushing that commit triggers a redeploy.

To deploy from the CLI instead: `npx vercel --prod`
