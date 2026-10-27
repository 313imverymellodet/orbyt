using System;
using System.IO;
using UnityEditor;
using UnityEditor.Build;
using UnityEngine;

// Google Play build. From the repo root on Windows:
//   "C:\Program Files\Unity\Hub\Editor\6000.6.3f1\Editor\Unity.exe" -batchmode -nographics -buildTarget Android -projectPath unity
//       -executeMethod AndroidBuild.Release -versionCode 1 -quit -logFile android.log
// Writes android/<name>.aab (upload this to Play Console) and, with -apk, android/<name>.apk to sideload on a phone.
// Signing comes from environment variables so no secret ever lands in git:
//   MV_KEYSTORE (path to the .keystore), MV_KEYSTORE_PASS, MV_KEY_ALIAS, MV_KEY_PASS
public static class AndroidBuild
{
    // ---- per-game settings ----
    const string PackageId = "com.mellovibes.orbyt";
    const string Product = "ORBYT";
    const string FileName = "orbyt";
    const string Version = "1.0.0";
    static readonly Color32 SplashBg = new Color32(11, 6, 32, 255);
    static void PrepareScene() => OrbytBuild.Setup();

    [MenuItem("Android/Build AAB for Google Play")]
    public static void Release() => Build(apk: HasArg("-apk"));

    [MenuItem("Android/Build test APK")]
    public static void TestApk() => Build(apk: true);

    static void Build(bool apk)
    {
        PrepareScene();

        PlayerSettings.companyName = "Mello Vibes Games";
        PlayerSettings.productName = Product;
        PlayerSettings.bundleVersion = Version;
        PlayerSettings.SetApplicationIdentifier(NamedBuildTarget.Android, PackageId);
        int code = ArgInt("-versionCode", PlayerSettings.Android.bundleVersionCode);
        PlayerSettings.Android.bundleVersionCode = Math.Max(1, code);

        PlayerSettings.colorSpace = ColorSpace.Gamma;
        PlayerSettings.runInBackground = false;
        PlayerSettings.SplashScreen.show = false;
        PlayerSettings.SplashScreen.backgroundColor = SplashBg;

        PlayerSettings.defaultInterfaceOrientation = UIOrientation.Portrait;
        PlayerSettings.allowedAutorotateToPortrait = true;
        PlayerSettings.allowedAutorotateToPortraitUpsideDown = false;
        PlayerSettings.allowedAutorotateToLandscapeLeft = false;
        PlayerSettings.allowedAutorotateToLandscapeRight = false;
        PlayerSettings.Android.startInFullscreen = true;
        PlayerSettings.Android.renderOutsideSafeArea = true;   // draw under the notch; UI uses SafeArea
        PlayerSettings.Android.optimizedFramePacing = true;
        PlayerSettings.Android.applicationEntry = AndroidApplicationEntry.Activity;

        PlayerSettings.Android.minSdkVersion = (AndroidSdkVersions)26;   // Android 8.0+: ~97% of active devices
        PlayerSettings.Android.targetSdkVersion = AndroidSdkVersions.AndroidApiLevelAuto;   // highest installed: Play needs the current level
        PlayerSettings.SetScriptingBackend(NamedBuildTarget.Android, ScriptingImplementation.IL2CPP);
        PlayerSettings.Android.targetArchitectures = AndroidArchitecture.ARM64 | AndroidArchitecture.ARMv7;
        PlayerSettings.SetManagedStrippingLevel(NamedBuildTarget.Android, ManagedStrippingLevel.Medium);
        PlayerSettings.stripEngineCode = true;
        PlayerSettings.SetIl2CppCodeGeneration(NamedBuildTarget.Android, Il2CppCodeGeneration.OptimizeSpeed);

        SetIcon();
        SetAdMobAppId();
        if (!apk && Ads.AndroidUsesTestIds && !HasArg("-testAds"))
        {
            Fail("Ads.cs still has Google's test AdMob IDs. Paste this game's AdMob app ID and rewarded unit ID into unity/Assets/Scripts/Ads.cs (or pass -testAds for an internal test build).");
            return;
        }
        if (!Sign() && !apk)
        {
            Fail("Signing key not set. Set MV_KEYSTORE, MV_KEYSTORE_PASS, MV_KEY_ALIAS and MV_KEY_PASS (see ANDROID.md), or build a test APK with -apk.");
            return;
        }

        EditorUserBuildSettings.SwitchActiveBuildTarget(BuildTargetGroup.Android, BuildTarget.Android);
        EditorUserBuildSettings.buildAppBundle = !apk;

        var outDir = Path.GetFullPath(Path.Combine(Application.dataPath, "../../android"));
        Directory.CreateDirectory(outDir);
        var outPath = Path.Combine(outDir, FileName + (apk ? ".apk" : ".aab"));

        var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions
        {
            scenes = Array.ConvertAll(EditorBuildSettings.scenes, s => s.path),
            locationPathName = outPath,
            target = BuildTarget.Android,
            options = BuildOptions.None,
        });

        var ok = report.summary.result == UnityEditor.Build.Reporting.BuildResult.Succeeded;
        Debug.Log($"ANDROID BUILD {(ok ? "OK" : "FAILED")}: {outPath} versionCode={PlayerSettings.Android.bundleVersionCode} size={report.summary.totalSize} errors={report.summary.totalErrors}");
        if (Application.isBatchMode) EditorApplication.Exit(ok ? 0 : 1);
    }

    // Launcher icons from Assets/Android: icon.png (full square, 1024) for legacy/round icons, and
    // icon-bg.png + icon-fg.png (432-style layers, art inside the middle 66%) for Android 8+ adaptive icons.
    static void SetIcon()
    {
        var full = Tex("Assets/Android/icon.png");
        var bg = Tex("Assets/Android/icon-bg.png");
        var fg = Tex("Assets/Android/icon-fg.png");
        if (!full) { Debug.LogWarning("No Assets/Android/icon.png; the app will use Unity's default icon."); return; }
        PlayerSettings.SetIcons(NamedBuildTarget.Unknown, new[] { full }, IconKind.Any);
        try
        {
            foreach (var kind in PlayerSettings.GetSupportedIconKinds(NamedBuildTarget.Android))
            {
                var icons = PlayerSettings.GetPlatformIcons(NamedBuildTarget.Android, kind);
                bool adaptive = kind.ToString().IndexOf("dapt", StringComparison.OrdinalIgnoreCase) >= 0;
                foreach (var icon in icons)
                {
                    if (adaptive && bg && fg) icon.SetTextures(bg, fg);
                    else if (!adaptive) icon.SetTextures(full);
                }
                PlayerSettings.SetPlatformIcons(NamedBuildTarget.Android, kind, icons);
            }
        }
        catch (Exception e) { Debug.LogWarning("Adaptive icons not set: " + e.Message); }
    }

    // The Google Mobile Ads plugin reads the app ID from its settings asset; keep it in sync with Ads.AndroidAppId.
    static void SetAdMobAppId()
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
        so.FindProperty("adMobAndroidAppId").stringValue = Ads.AndroidAppId;
        so.ApplyModifiedPropertiesWithoutUndo();
        AssetDatabase.SaveAssets();
    }

    static Texture2D Tex(string path)
    {
        AssetDatabase.ImportAsset(path);
        return AssetDatabase.LoadAssetAtPath<Texture2D>(path);
    }

    static bool Sign()
    {
        var ks = Environment.GetEnvironmentVariable("MV_KEYSTORE");
        if (string.IsNullOrEmpty(ks) || !File.Exists(ks)) { PlayerSettings.Android.useCustomKeystore = false; return false; }
        PlayerSettings.Android.useCustomKeystore = true;
        PlayerSettings.Android.keystoreName = ks;
        PlayerSettings.Android.keystorePass = Environment.GetEnvironmentVariable("MV_KEYSTORE_PASS");
        PlayerSettings.Android.keyaliasName = Environment.GetEnvironmentVariable("MV_KEY_ALIAS") ?? "upload";
        PlayerSettings.Android.keyaliasPass = Environment.GetEnvironmentVariable("MV_KEY_PASS") ?? PlayerSettings.Android.keystorePass;
        return true;
    }

    static void Fail(string msg)
    {
        Debug.LogError("ANDROID BUILD FAILED: " + msg);
        if (Application.isBatchMode) EditorApplication.Exit(1);
        else EditorUtility.DisplayDialog("Android build", msg, "OK");
    }

    static bool HasArg(string name) => Array.IndexOf(Environment.GetCommandLineArgs(), name) >= 0;

    static int ArgInt(string name, int fallback)
    {
        var args = Environment.GetCommandLineArgs();
        int i = Array.IndexOf(args, name);
        return i >= 0 && i + 1 < args.Length && int.TryParse(args[i + 1], out var v) ? v : fallback;
    }
}
