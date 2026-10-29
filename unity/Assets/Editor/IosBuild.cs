using System;
using System.IO;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Callbacks;
using UnityEngine;
#if UNITY_IOS
using UnityEditor.iOS.Xcode;
#endif

// App Store build. Exports an Xcode project from Windows; signing, archiving and the upload happen on a Mac.
//   "C:\Program Files\Unity\Hub\Editor\6000.6.3f1\Editor\Unity.exe" -batchmode -nographics -buildTarget iOS -projectPath unity
//       -executeMethod IosBuild.Export -buildNumber 1 -quit -logFile ios.log
// Writes ios/<name>/ (open Unity-iPhone.xcworkspace after `pod install`, see IOS.md). Add -testAds for a TestFlight build
// that still uses Google's test AdMob IDs. MV_APPLE_TEAM (10-character Team ID) turns on automatic signing.
public static class IosBuild
{
    // ---- per-game settings (keep in step with AndroidBuild) ----
    const string BundleId = "com.mellovibes.orbyt";
    const string Product = "ORBYT";
    const string FileName = "orbyt";
    const string Version = "1.0.0";
    static void PrepareScene() => OrbytBuild.Setup();

    [MenuItem("iOS/Export Xcode project")]
    public static void Export()
    {
        if (Ads.IosUsesTestIds && !HasArg("-testAds"))
        {
            Fail("Ads.cs still has Google's test AdMob IDs for iOS. Paste this game's iOS AdMob app ID and rewarded unit ID into unity/Assets/Scripts/Ads.cs (or pass -testAds for a TestFlight test build).");
            return;
        }
        PrepareScene();

        PlayerSettings.companyName = "Mello Vibes Games";
        PlayerSettings.productName = Product;
        PlayerSettings.bundleVersion = Version;
        PlayerSettings.SetApplicationIdentifier(NamedBuildTarget.iOS, BundleId);
        PlayerSettings.iOS.buildNumber = Math.Max(1, ArgInt("-buildNumber", 1)).ToString();
        PlayerSettings.iOS.targetOSVersionString = "15.0";
        PlayerSettings.iOS.targetDevice = iOSTargetDevice.iPhoneAndiPad;
        PlayerSettings.iOS.requiresFullScreen = true;   // portrait-only on iPad too
        PlayerSettings.iOS.appInBackgroundBehavior = iOSAppInBackgroundBehavior.Suspend;
        PlayerSettings.SetScriptingBackend(NamedBuildTarget.iOS, ScriptingImplementation.IL2CPP);
        PlayerSettings.SetManagedStrippingLevel(NamedBuildTarget.iOS, ManagedStrippingLevel.Medium);
        PlayerSettings.SetIl2CppCodeGeneration(NamedBuildTarget.iOS, Il2CppCodeGeneration.OptimizeSpeed);
        PlayerSettings.stripEngineCode = true;

        PlayerSettings.colorSpace = ColorSpace.Gamma;
        PlayerSettings.runInBackground = false;
        PlayerSettings.SplashScreen.show = false;
        PlayerSettings.defaultInterfaceOrientation = UIOrientation.Portrait;
        PlayerSettings.allowedAutorotateToPortrait = true;
        PlayerSettings.allowedAutorotateToPortraitUpsideDown = false;
        PlayerSettings.allowedAutorotateToLandscapeLeft = false;
        PlayerSettings.allowedAutorotateToLandscapeRight = false;

        var team = Environment.GetEnvironmentVariable("MV_APPLE_TEAM");
        PlayerSettings.iOS.appleEnableAutomaticSigning = !string.IsNullOrEmpty(team);
        if (!string.IsNullOrEmpty(team)) PlayerSettings.iOS.appleDeveloperTeamID = team;

        // the full square icon (no alpha, 1024) doubles as the App Store icon; Unity scales the rest
        var icon = AssetDatabase.LoadAssetAtPath<Texture2D>("Assets/Android/icon.png");
        if (icon)
        {
            PlayerSettings.SetIcons(NamedBuildTarget.iOS, new[] { icon }, IconKind.Any);
            // SetIcons alone can leave the App Store (1024), Spotlight, Settings and Notification slots empty, and
            // App Store Connect rejects a build without the 1024 icon, so fill every iOS icon slot explicitly.
            foreach (var kind in PlayerSettings.GetSupportedIconKinds(NamedBuildTarget.iOS))
            {
                var slots = PlayerSettings.GetPlatformIcons(NamedBuildTarget.iOS, kind);
                foreach (var slot in slots) slot.SetTextures(icon);
                PlayerSettings.SetPlatformIcons(NamedBuildTarget.iOS, kind, slots);
            }
        }

        SetAdMobIos();
        EditorUserBuildSettings.SwitchActiveBuildTarget(BuildTargetGroup.iOS, BuildTarget.iOS);

        var outPath = Path.GetFullPath(Path.Combine(Application.dataPath, "../../ios", FileName));
        Directory.CreateDirectory(Path.GetDirectoryName(outPath));
        var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions
        {
            scenes = Array.ConvertAll(EditorBuildSettings.scenes, s => s.path),
            locationPathName = outPath,
            target = BuildTarget.iOS,
            options = BuildOptions.None,
        });
        var ok = report.summary.result == UnityEditor.Build.Reporting.BuildResult.Succeeded;
        Debug.Log($"IOS EXPORT {(ok ? "OK" : "FAILED")}: {outPath} build={PlayerSettings.iOS.buildNumber} errors={report.summary.totalErrors}");
        if (Application.isBatchMode) EditorApplication.Exit(ok ? 0 : 1);
    }

    // The Google Mobile Ads plugin writes GADApplicationIdentifier, SKAdNetworkItems and the tracking text into
    // Info.plist from its settings asset.
    static void SetAdMobIos()
    {
        const string path = "Assets/GoogleMobileAds/Resources/GoogleMobileAdsSettings.asset";
        var settings = AssetDatabase.LoadAssetAtPath<ScriptableObject>(path);
        if (!settings)
        {
            var type = Type.GetType("GoogleMobileAds.Editor.GoogleMobileAdsSettings, GoogleMobileAds.Editor");
            settings = type?.GetMethod("LoadInstance", System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic)?.Invoke(null, null) as ScriptableObject;
        }
        if (!settings) { Debug.LogWarning("Google Mobile Ads settings not found; the ads plugin will stop the build."); return; }
        var so = new SerializedObject(settings);
        so.FindProperty("adMobIOSAppId").stringValue = Ads.IosAppId;
        so.FindProperty("userTrackingUsageDescription").stringValue = Ads.TrackingReason;
        so.ApplyModifiedPropertiesWithoutUndo();
        AssetDatabase.SaveAssets();
    }

#if UNITY_IOS
    // Info.plist and framework tweaks the plugins don't make.
    [PostProcessBuild(900)]
    static void OnPostProcess(BuildTarget target, string path)
    {
        if (target != BuildTarget.iOS) return;
        var plistPath = Path.Combine(path, "Info.plist");
        var plist = new PlistDocument();
        plist.ReadFromFile(plistPath);
        plist.root.SetBoolean("ITSAppUsesNonExemptEncryption", false);   // only standard HTTPS: skips the export-compliance question
        plist.root.SetBoolean("CADisableMinimumFrameDurationOnPhone", true);   // lets ProMotion iPhones run at 120 Hz
        plist.WriteToFile(plistPath);

        var projPath = PBXProject.GetPBXProjectPath(path);
        var proj = new PBXProject();
        proj.ReadFromFile(projPath);
        var fw = proj.GetUnityFrameworkTargetGuid();
        proj.AddFrameworkToProject(fw, "AppTrackingTransparency.framework", true);   // weak: MelloNative.mm's tracking prompt
        proj.AddFrameworkToProject(fw, "UserNotifications.framework", false);   // MelloNative.mm's reminder notifications
        proj.WriteToFile(projPath);
    }
#endif

    static void Fail(string msg)
    {
        Debug.LogError("IOS EXPORT FAILED: " + msg);
        if (Application.isBatchMode) EditorApplication.Exit(1);
        else EditorUtility.DisplayDialog("iOS build", msg, "OK");
    }

    static bool HasArg(string name) => Array.IndexOf(Environment.GetCommandLineArgs(), name) >= 0;

    static int ArgInt(string name, int fallback)
    {
        var args = Environment.GetCommandLineArgs();
        int i = Array.IndexOf(args, name);
        return i >= 0 && i + 1 < args.Length && int.TryParse(args[i + 1], out var v) ? v : fallback;
    }
}
