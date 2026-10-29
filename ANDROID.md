# Publishing ORBYT on Google Play

This repo builds both the browser game (`OrbytBuild`/`GraveBuild`/`SnackBuild` → `dist/`) and the Android app (`AndroidBuild` → `android/`). The Android build is offline-only: the website's leaderboard, duels and portal ads are left out, and the phone gets native pause, Android back-button handling, safe areas for notches, haptics and the share sheet.

| | |
|---|---|
| App name | ORBYT |
| Package name | `com.mellovibes.orbyt` (permanent once uploaded) |
| Min Android | 8.0 (API 26) |
| Target API | highest installed in Unity (Play needs the current level) |
| Architectures | ARM64 + ARMv7, IL2CPP |
| Orientation | Portrait |

## 1. One-time setup (Windows)

1. **Unity Hub → Installs → 6000.6.3f1 → ⚙ → Add modules → Android Build Support**, with **OpenJDK** and **Android SDK & NDK Tools** ticked.
2. **Create your upload key** (do this once and use it for all Mello Vibes apps). In PowerShell:

   ```powershell
   mkdir C:\keys
   & "C:\Program Files\Unity\Hub\Editor\6000.6.3f1\Editor\Data\PlaybackEngines\AndroidPlayer\OpenJDK\bin\keytool.exe" -genkeypair -v -keystore C:\keys\mellovibes-upload.keystore -alias upload -keyalg RSA -keysize 2048 -validity 10000
   ```

   Pick a strong password and **back up the `.keystore` file and password** somewhere safe (a password manager plus a USB stick). Never commit it; `.gitignore` already blocks `*.keystore`. Google Play App Signing holds the real app signing key, so if you lose this upload key Google can reset it, but it takes days.

## 2. Build

From the repo root in PowerShell:

```powershell
$env:MV_KEYSTORE      = "C:\keys\mellovibes-upload.keystore"
$env:MV_KEYSTORE_PASS = "your-keystore-password"
$env:MV_KEY_ALIAS     = "upload"
$env:MV_KEY_PASS      = "your-keystore-password"
& "C:\Program Files\Unity\Hub\Editor\6000.6.3f1\Editor\Unity.exe" -batchmode -nographics -buildTarget Android -projectPath unity -executeMethod AndroidBuild.Release -versionCode 1 -quit -logFile android.log
```

- Output: `android\orbyt.aab`. Search `android.log` for `ANDROID BUILD OK`.
- **Every upload needs a higher `-versionCode`** (1, 2, 3…). Bump `Version` in `unity/Assets/Editor/AndroidBuild.cs` for user-visible versions (1.0.1…).
- In the editor you can also use the **Android** menu → *Build AAB for Google Play* or *Build test APK*.

### Test on your phone first

Turn on Developer options → USB debugging on the phone, plug it in, then:

```powershell
& "C:\Program Files\Unity\Hub\Editor\6000.6.3f1\Editor\Unity.exe" -batchmode -nographics -buildTarget Android -projectPath unity -executeMethod AndroidBuild.TestApk -quit -logFile android.log
& "C:\Program Files\Unity\Hub\Editor\6000.6.3f1\Editor\Data\PlaybackEngines\AndroidPlayer\SDK\platform-tools\adb.exe" install -r android\orbyt.apk
```

Check: the frame rate is smooth (60 Hz+), nothing is hidden under the notch, the **back button** pauses during play and backs out of menus, switching apps mid-run pauses the game, sound and vibration toggles work, and Share opens the Android share sheet.

## 3. Play Console

Create the app at <https://play.google.com/console> → **Create app** → name `ORBYT`, Game, Free.

**Store listing** (everything is in `store/`):

- App name: `ORBYT: One-Tap Orbit Arcade`
- Short description: `One tap. Two orbits. No mercy. Dodge spikes, chain perfects, beat your best.`
- Full description: `store/listing.md`
- App icon: `store/icon-512.png` · Feature graphic: `store/feature-graphic.png`
- Phone screenshots: `store/screenshots/*.png` (1080×1920)
- Category: **Arcade** · Tags: Arcade, Casual, Offline, Single player, Stylized
- Contact email: your email · Website: `https://play.mellovibes.io`

**App content** (Policy → App content):

| Section | Answer |
|---|---|
| Privacy policy | `https://play.mellovibes.io/privacy` |
| Ads | **No**, the app contains no ads |
| App access | All functionality is available without special access |
| Content rating (IARC questionnaire) | Everyone (no violence) |
| Target audience | 13 and over (simplest; avoids the Families program paperwork) |
| Data safety | **No data collected, no data shared.** No account creation. (Saves stay on the device; the only permission is vibration.) |
| Government / financial / health / news | No |

**Release:**

1. *Testing → Internal testing* → create a release → upload `orbyt.aab` → add yourself as a tester → install from the opt-in link.
2. **New personal developer accounts must run a closed test with at least 12 testers for 14 days** before production. Start this early: *Testing → Closed testing* with friends' Gmail addresses.
3. Then *Production → Create release*.
