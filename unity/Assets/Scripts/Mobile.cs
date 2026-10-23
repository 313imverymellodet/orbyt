using UnityEngine;

// Native phone integrations for the Google Play build. In the browser build every call
// here falls through to the existing WebBridge path, so the web game is unchanged.
public static class Mobile
{
#if UNITY_ANDROID && !UNITY_EDITOR
    public static readonly bool Native = true;
#else
    public static readonly bool Native = false;
#endif

    // Run at the display's real refresh rate. Android defaults to 30 fps when targetFrameRate is -1.
    public static void Init()
    {
        if (!Native) return;
        int hz = Mathf.RoundToInt((float)Screen.currentResolution.refreshRateRatio.value);
        Application.targetFrameRate = Mathf.Max(60, hz);
        Screen.sleepTimeout = SleepTimeout.NeverSleep;
        Input.backButtonLeavesApp = false;
    }

#if UNITY_ANDROID && !UNITY_EDITOR
    static AndroidJavaObject activity, vibrator;
    static bool vibratorChecked;

    static AndroidJavaObject Activity
    {
        get
        {
            if (activity == null)
                using (var up = new AndroidJavaClass("com.unity3d.player.UnityPlayer"))
                    activity = up.GetStatic<AndroidJavaObject>("currentActivity");
            return activity;
        }
    }
#endif

    // Short haptic tick. Uses VibrationEffect (API 26+) so light taps feel light instead of buzzing.
    public static void Vibrate(int ms, int amplitude = -1)
    {
#if UNITY_ANDROID && !UNITY_EDITOR
        if (PlayerPrefs.GetInt("haptics_off", 0) == 1) return;
        try
        {
            if (!vibratorChecked)
            {
                vibratorChecked = true;
                vibrator = Activity.Call<AndroidJavaObject>("getSystemService", "vibrator");
            }
            if (vibrator == null) return;
            using (var ve = new AndroidJavaClass("android.os.VibrationEffect"))
            using (var effect = ve.CallStatic<AndroidJavaObject>("createOneShot", (long)ms, amplitude))
                vibrator.Call("vibrate", effect);
        }
        catch (System.Exception)
        {
            Handheld.Vibrate();   // also makes Unity add the VIBRATE permission to the manifest
        }
#endif
    }

    // Android share sheet with plain text.
    public static void Share(string text, string title = "Share")
    {
#if UNITY_ANDROID && !UNITY_EDITOR
        try
        {
            using (var intent = new AndroidJavaObject("android.content.Intent", "android.intent.action.SEND"))
            {
                intent.Call<AndroidJavaObject>("setType", "text/plain");
                intent.Call<AndroidJavaObject>("putExtra", "android.intent.extra.TEXT", text);
                using (var ic = new AndroidJavaClass("android.content.Intent"))
                using (var chooser = ic.CallStatic<AndroidJavaObject>("createChooser", intent, title))
                    Activity.Call("startActivity", chooser);
            }
        }
        catch (System.Exception e) { Debug.LogWarning("Share failed: " + e.Message); }
#else
        GUIUtility.systemCopyBuffer = text;
#endif
    }

    // Back goes to the home screen without killing the process (what Android users expect from a game).
    public static void MoveToBack()
    {
#if UNITY_ANDROID && !UNITY_EDITOR
        try { Activity.Call<bool>("moveTaskToBack", true); } catch (System.Exception) { Application.Quit(); }
#endif
    }
}

// Keeps a full-screen UI rect inside Screen.safeArea (notches, punch-hole cameras, gesture bar).
[ExecuteAlways]
public class SafeArea : MonoBehaviour
{
    Rect last; Vector2Int lastSize;

    void OnEnable() => Apply(true);
    void Update() => Apply(false);

    void Apply(bool force)
    {
        var sa = Screen.safeArea;
        var size = new Vector2Int(Screen.width, Screen.height);
        if (!force && sa == last && size == lastSize) return;
        last = sa; lastSize = size;
        if (size.x <= 0 || size.y <= 0) return;
        var rt = (RectTransform)transform;
        rt.anchorMin = new Vector2(sa.xMin / size.x, sa.yMin / size.y);
        rt.anchorMax = new Vector2(sa.xMax / size.x, sa.yMax / size.y);
        rt.offsetMin = rt.offsetMax = Vector2.zero;
    }
}
