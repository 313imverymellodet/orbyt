using System.IO;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;

// One-click / CLI build: Unity -batchmode -projectPath unity -executeMethod OrbytBuild.WebGL -quit
public static class OrbytBuild
{
    const string ScenePath = "Assets/Scenes/Main.unity";

    [MenuItem("ORBYT/Setup Scene")]
    public static void Setup()
    {
        Directory.CreateDirectory("Assets/Resources");
        Directory.CreateDirectory("Assets/Scenes");

        MakeMat("Assets/Resources/OrbytAlpha.mat", "Sprites/Default");
        var add = Shader.Find("Legacy Shaders/Particles/Additive") ? "Legacy Shaders/Particles/Additive" : "Sprites/Default";
        MakeMat("Assets/Resources/OrbytAdd.mat", add);

        var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
        var camGo = new GameObject("Main Camera");
        camGo.tag = "MainCamera";
        var cam = camGo.AddComponent<Camera>();
        cam.orthographic = true;
        cam.orthographicSize = 6;
        cam.clearFlags = CameraClearFlags.SolidColor;
        cam.backgroundColor = new Color32(11, 6, 32, 255);
        camGo.transform.position = new Vector3(0, 0, -10);
        camGo.AddComponent<AudioListener>();
        new GameObject("Game").AddComponent<Game>();
        EditorSceneManager.SaveScene(scene, ScenePath);
        EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(ScenePath, true) };
        AssetDatabase.SaveAssets();
    }

    static void MakeMat(string path, string shader)
    {
        var existing = AssetDatabase.LoadAssetAtPath<Material>(path);
        if (existing) { existing.shader = Shader.Find(shader); EditorUtility.SetDirty(existing); return; }
        var m = new Material(Shader.Find(shader));
        if (m.HasProperty("_TintColor")) m.SetColor("_TintColor", new Color(0.5f, 0.5f, 0.5f, 0.5f));
        AssetDatabase.CreateAsset(m, path);
    }

    [MenuItem("ORBYT/Build WebGL")]
    public static void WebGL()
    {
        Setup();

        PlayerSettings.companyName = "Orbyt";
        PlayerSettings.productName = "ORBYT";
        PlayerSettings.bundleVersion = "1.0.0";
        PlayerSettings.colorSpace = ColorSpace.Gamma;
        PlayerSettings.runInBackground = false;
        PlayerSettings.SplashScreen.show = false;
        PlayerSettings.SplashScreen.showUnityLogo = false;

        PlayerSettings.WebGL.template = "PROJECT:Orbyt";
        PlayerSettings.WebGL.compressionFormat = WebGLCompressionFormat.Brotli;
        PlayerSettings.WebGL.decompressionFallback = true;   // works even if a host drops Content-Encoding
        PlayerSettings.WebGL.nameFilesAsHashes = true;       // immutable caching on Vercel
        PlayerSettings.WebGL.dataCaching = true;
        PlayerSettings.WebGL.exceptionSupport = WebGLExceptionSupport.None;
        PlayerSettings.WebGL.linkerTarget = WebGLLinkerTarget.Wasm;
        PlayerSettings.WebGL.showDiagnostics = false;
        PlayerSettings.SetManagedStrippingLevel(NamedBuildTarget.WebGL, ManagedStrippingLevel.Medium);
        PlayerSettings.stripEngineCode = true;
        PlayerSettings.SetIl2CppCodeGeneration(NamedBuildTarget.WebGL, UnityEditor.Build.Il2CppCodeGeneration.OptimizeSize);
        EditorUserBuildSettings.SwitchActiveBuildTarget(BuildTargetGroup.WebGL, BuildTarget.WebGL);

        var outDir = Path.GetFullPath(Path.Combine(Application.dataPath, "../../dist"));
        if (Directory.Exists(outDir)) Directory.Delete(outDir, true);

        var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions
        {
            scenes = new[] { ScenePath },
            locationPathName = outDir,
            target = BuildTarget.WebGL,
            options = BuildOptions.None,
        });

        Debug.Log("ORBYT BUILD RESULT: " + report.summary.result + " size=" + report.summary.totalSize + " errors=" + report.summary.totalErrors);
        if (Application.isBatchMode)
            EditorApplication.Exit(report.summary.result == UnityEditor.Build.Reporting.BuildResult.Succeeded ? 0 : 1);
    }
}
