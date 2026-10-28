using UnityEngine;

// Native phone integrations for the Google Play and App Store builds. In the browser build every call
// here falls through to the existing WebBridge path, so the web game is unchanged.
public static class Mobile
{
#if (UNITY_ANDROID || UNITY_IOS) && !UNITY_EDITOR
    public static readonly bool Native = true;
#else
    public static readonly bool Native = false;
#endif

#if UNITY_IOS && !UNITY_EDITOR
    [System.Runtime.InteropServices.DllImport("__Internal")] static extern void MV_Haptic(int style);
    [System.Runtime.InteropServices.DllImport("__Internal")] static extern void MV_Share(string text);
    [System.Runtime.InteropServices.DllImport("__Internal")] static extern void MV_AudioPlayback();
    [System.Runtime.InteropServices.DllImport("__Internal")] static extern void MV_NotifyRequest();
    [System.Runtime.InteropServices.DllImport("__Internal")] static extern void MV_NotifySchedule(string id, string title, string body, int seconds);
    [System.Runtime.InteropServices.DllImport("__Internal")] static extern void MV_NotifyCancelAll();
#endif

    // Run at the display's real refresh rate. Android and iOS default to 30 fps when targetFrameRate is -1.
    public static void Init()
    {
        if (!Native) return;
        int hz = Mathf.RoundToInt((float)Screen.currentResolution.refreshRateRatio.value);
        Application.targetFrameRate = Mathf.Max(60, hz);
        Screen.sleepTimeout = SleepTimeout.NeverSleep;
        Input.backButtonLeavesApp = false;
#if UNITY_IOS && !UNITY_EDITOR
        PlayThroughSilentSwitch();
        var keeper = new GameObject("AudioSession");
        Object.DontDestroyOnLoad(keeper);
        keeper.AddComponent<AudioSessionKeeper>();
#endif
    }

    // Sound plays with the iPhone's Silent switch on. Ads, calls and Siri can reset the audio session,
    // so AudioSessionKeeper applies it again whenever the app gets focus back.
    public static void PlayThroughSilentSwitch()
    {
#if UNITY_IOS && !UNITY_EDITOR
        MV_AudioPlayback();
#endif
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
#elif UNITY_IOS && !UNITY_EDITOR
        if (PlayerPrefs.GetInt("haptics_off", 0) == 1) return;
        MV_Haptic(ms <= 15 ? 0 : ms <= 60 ? 1 : 2);
#endif
    }

    // Local reminder notifications (iOS). Ask once at a moment the reminder makes sense; schedule when the player leaves
    // and cancel when they're back. Android and the browser build do nothing.
    public static void RequestNotifications()
    {
#if UNITY_IOS && !UNITY_EDITOR
        MV_NotifyRequest();
#endif
    }

    public static void Notify(string id, string title, string body, int seconds)
    {
#if UNITY_IOS && !UNITY_EDITOR
        MV_NotifySchedule(id, title, body, seconds);
#endif
    }

    public static void CancelNotifications()
    {
#if UNITY_IOS && !UNITY_EDITOR
        MV_NotifyCancelAll();
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
#elif UNITY_IOS && !UNITY_EDITOR
        MV_Share(text);
#else
        GUIUtility.systemCopyBuffer = text;
#endif
    }

    // Back goes to the home screen without killing the process (what Android users expect from a game).
    // iOS has no back button, so this is never reached there.
    public static void MoveToBack()
    {
#if UNITY_ANDROID && !UNITY_EDITOR
        try { Activity.Call<bool>("moveTaskToBack", true); } catch (System.Exception) { Application.Quit(); }
#endif
    }
}

public class AudioSessionKeeper : MonoBehaviour
{
    void OnApplicationFocus(bool focus) { if (focus) Mobile.PlayThroughSilentSwitch(); }
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
