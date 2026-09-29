using System.Runtime.InteropServices;
using UnityEngine;
using UnityEngine.EventSystems;

// Browser integrations: native share sheet, haptics, analytics hooks.
public static class WebBridge
{
#if UNITY_WEBGL && !UNITY_EDITOR
    [DllImport("__Internal")] static extern void OrbytArmShare(string text);
    [DllImport("__Internal")] static extern void OrbytVibrate(int ms);
    [DllImport("__Internal")] static extern void OrbytEvent(string name, int value);
    [DllImport("__Internal")] static extern void OrbytReady();
#endif

    // Web Share requires a live user gesture, so we arm on pointer-down and the
    // page fires the share sheet on the matching DOM pointer-up.
    public static void ArmShare(string text)
    {
#if UNITY_WEBGL && !UNITY_EDITOR
        OrbytArmShare(text);
#else
        GUIUtility.systemCopyBuffer = text;
        Debug.Log("Share text copied:\n" + text);
#endif
    }

    public static void Vibrate(int ms)
    {
#if UNITY_WEBGL && !UNITY_EDITOR
        OrbytVibrate(ms);
#endif
    }

    public static void Event(string name, int value = 0)
    {
#if UNITY_WEBGL && !UNITY_EDITOR
        OrbytEvent(name, value);
#endif
    }

    public static void Ready()
    {
#if UNITY_WEBGL && !UNITY_EDITOR
        OrbytReady();
#endif
    }
}

public class ShareOnPress : MonoBehaviour, IPointerDownHandler
{
    public System.Func<string> Text;
    public void OnPointerDown(PointerEventData e)
    {
        if (Text != null) WebBridge.ArmShare(Text());
    }
}

public class PressJuice : MonoBehaviour, IPointerDownHandler, IPointerUpHandler, IPointerExitHandler
{
    float target = 1f;
    public void OnPointerDown(PointerEventData e) => target = 0.92f;
    public void OnPointerUp(PointerEventData e) => target = 1f;
    public void OnPointerExit(PointerEventData e) => target = 1f;
    void Update()
    {
        float s = Mathf.Lerp(transform.localScale.x, target, 1f - Mathf.Exp(-Time.unscaledDeltaTime * 25f));
        transform.localScale = new Vector3(s, s, 1);
    }
}
