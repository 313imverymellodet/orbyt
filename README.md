# ORBYT

One tap. Two orbits. No mercy. This is a Unity 6 WebGL arcade game made for mobile browsers and hosted on Vercel.

## How it plays
- **Tap anywhere** to switch between the inner and outer orbit and dodge the spikes.
- **PERFECT:** dodge at the last moment to get bonus points. Chain them for combos (CLUTCH, INSANE, GODLIKE).
- **FLIP:** every 20 points the orbit changes direction and the whole color palette shifts.
- **Shards:** collect them to unlock 7 skins, including the animated PRISM skin.
- **Daily Challenge:** everyone gets the same seeded course each day. The SHARE button creates a Wordle-style emoji card.

There are no art or audio files. All sprites, sound effects and the synthwave soundtrack are generated in code at startup, which keeps the download small.

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
