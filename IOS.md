# Publishing ORBYT on the App Store

The iOS app is the same offline game as the Android one: AdMob rewarded CONTINUE (after Google's consent form and Apple's tracking prompt), a one-time **Remove Ads** pass with a **Restore** button, haptics and the iOS share sheet. Unity on Windows exports an Xcode project; a Mac signs, archives and uploads it.

| | |
|---|---|
| App name | ORBYT |
| Bundle ID | `com.mellovibes.orbyt` (permanent once uploaded) |
| Minimum iOS | 15.0, iPhone and iPad (portrait, full screen) |
| In-app purchase | `remove_ads`, non-consumable, $2.99 |

## 1. One-time Apple setup

1. **developer.apple.com → Certificates, IDs & Profiles → Identifiers → +** → App IDs → App → Bundle ID (explicit) `com.mellovibes.orbyt`. Leave capabilities at the defaults (In-App Purchase is on by default).
2. **App Store Connect → Apps → + New App**: iOS, name `ORBYT`, the bundle ID above, SKU `orbyt`.
3. In the app: **Monetization → In-App Purchases → +** → Non-Consumable, reference name `Remove Ads`, product ID `remove_ads`, price $2.99, display name "Remove Ads", description "Get every reward instantly, no videos.", plus a review screenshot of the menu's NO ADS button. Sign the **Paid Apps agreement** (Business) first, or the product never loads.
4. **AdMob → Apps → Add app → iOS** (not listed yet) → name ORBYT → add a **Rewarded** ad unit. Paste the iOS app ID and unit ID into `IosAppId` / `IosRewardedId` in `unity/Assets/Scripts/Ads.cs`.
5. Your **Team ID** (developer.apple.com → Membership, 10 characters) goes in `MV_APPLE_TEAM` so the export turns on automatic signing. It isn't secret.

## 2. Export the Xcode project (Windows)

```powershell
$env:MV_APPLE_TEAM = "ABCDE12345"
& "C:\Program Files\Unity\Hub\Editor\6000.6.3f1\Editor\Unity.exe" -batchmode -nographics -buildTarget iOS -projectPath unity -executeMethod IosBuild.Export -buildNumber 1 -quit -logFile ios.log
```

- Output: `ios\orbyt\`. Search `ios.log` for `IOS EXPORT OK`.
- `-testAds` exports a build that still uses Google's test ad IDs (fine for TestFlight, not for review).
- Every upload needs a higher `-buildNumber`. Bump `Version` in `IosBuild.cs` for user-visible versions.
- Copy the whole `ios\orbyt` folder to the Mac (zip it; iCloud Drive, AirDrop or a USB stick).

## 3. Build and upload (Mac)

One-time: install **Xcode** from the App Store, sign in with your Apple ID (Xcode → Settings → Accounts), and install CocoaPods: `brew install cocoapods` (or `sudo gem install cocoapods`).

```bash
cd ~/Downloads/orbyt        # the copied ios/orbyt folder
pod install                 # fetches the Google Mobile Ads and consent SDKs
open Unity-iPhone.xcworkspace   # the .xcworkspace, not the .xcodeproj
```

In Xcode:

1. Select the **Unity-iPhone** target → **Signing & Capabilities** → Team = your team, "Automatically manage signing" on. Do the same for **UnityFramework** if it asks.
2. Pick **Any iOS Device (arm64)** as the destination, then **Product → Archive**.
3. In the Organizer: **Distribute App → App Store Connect → Upload**.
4. After processing (10–30 min) the build shows in App Store Connect → **TestFlight**. Add yourself as an internal tester and install it through the TestFlight app.

## 4. Check on an iPhone (TestFlight)

Haptics and Share work; nothing sits under the notch or the home bar; "Allow tracking?" shows once on first launch (after Google's consent form in the EEA/UK); CONTINUE · WATCH AD plays a video and the run resumes; NO ADS buys the pass with a Sandbox account and RESTORE brings it back after reinstalling.

## 5. App Store Connect before review

| Section | Answer |
|---|---|
| Privacy Policy URL | `https://play.mellovibes.io/privacy` |
| App Privacy → Data collection | **Yes**. Collected by the AdMob SDK: **Identifiers → Device ID**, **Location → Coarse location**, **Usage data → Advertising data, Product interaction**, **Diagnostics → Crash data, Performance data**. Purposes: Third-party advertising, Analytics. **Linked to the user: No. Used for tracking: Yes** (Device ID, Advertising data) |
| Age rating | 9+ is typical (cartoon/fantasy, no violence); declare in-app purchases |
| Category | Games → Arcade |
| Screenshots | 6.9" iPhone (1320×2868) and 13" iPad (2064×2752) are required; capture from TestFlight on device or the simulator |
| Export compliance | Answered in the build (`ITSAppUsesNonExemptEncryption = NO`) |

Then **Add for Review** with the build, the `remove_ads` in-app purchase attached to the version, and submit. After approval, link the app in AdMob (**Apps → app → Add store**) so full ad serving starts.
