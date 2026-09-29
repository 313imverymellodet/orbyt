using UnityEngine;

// Procedurally generated sprites — ORBYT ships with zero texture assets.
public static class Gfx
{
    static Texture2D NewTex(int n)
    {
        var t = new Texture2D(n, n, TextureFormat.RGBA32, false);
        t.wrapMode = TextureWrapMode.Clamp;
        t.filterMode = FilterMode.Bilinear;
        return t;
    }

    static Sprite Finish(Texture2D t, Color[] px, float ppu)
    {
        t.SetPixels(px);
        t.Apply(false, true);
        return Sprite.Create(t, new Rect(0, 0, t.width, t.height), new Vector2(0.5f, 0.5f), ppu, 0, SpriteMeshType.FullRect);
    }

    // Solid anti-aliased disc, 1 world unit wide.
    public static Sprite Circle(int n = 128)
    {
        var t = NewTex(n); var px = new Color[n * n];
        float r = n * 0.5f - 1f;
        for (int y = 0; y < n; y++)
            for (int x = 0; x < n; x++)
            {
                float d = Vector2.Distance(new Vector2(x + 0.5f, y + 0.5f), new Vector2(n * 0.5f, n * 0.5f));
                px[y * n + x] = new Color(1, 1, 1, Mathf.Clamp01(r - d + 0.5f));
            }
        return Finish(t, px, n);
    }

    // Soft radial glow, 1 world unit wide.
    public static Sprite Glow(int n = 128)
    {
        var t = NewTex(n); var px = new Color[n * n];
        for (int y = 0; y < n; y++)
            for (int x = 0; x < n; x++)
            {
                float d = Vector2.Distance(new Vector2(x + 0.5f, y + 0.5f), new Vector2(n * 0.5f, n * 0.5f)) / (n * 0.5f);
                float a = Mathf.Clamp01(1f - d);
                px[y * n + x] = new Color(1, 1, 1, a * a);
            }
        return Finish(t, px, n);
    }

    // Thin ring outline, 1 world unit wide.
    public static Sprite Ring(int n = 256, float thickness = 0.035f)
    {
        var t = NewTex(n); var px = new Color[n * n];
        float half = n * 0.5f, th = thickness * n;
        for (int y = 0; y < n; y++)
            for (int x = 0; x < n; x++)
            {
                float d = Vector2.Distance(new Vector2(x + 0.5f, y + 0.5f), new Vector2(half, half));
                float edge = Mathf.Abs(d - (half - th - 1f));
                px[y * n + x] = new Color(1, 1, 1, Mathf.Clamp01(th - edge + 0.5f));
            }
        return Finish(t, px, n);
    }

    // Square with slightly rounded corners (rotate 45° for a diamond).
    public static Sprite Square(int n = 64, float radius = 8f)
    {
        var t = NewTex(n); var px = new Color[n * n];
        float half = n * 0.5f - 1f, inner = half - radius;
        for (int y = 0; y < n; y++)
            for (int x = 0; x < n; x++)
            {
                float dx = Mathf.Max(Mathf.Abs(x + 0.5f - n * 0.5f) - inner, 0);
                float dy = Mathf.Max(Mathf.Abs(y + 0.5f - n * 0.5f) - inner, 0);
                float d = Mathf.Sqrt(dx * dx + dy * dy);
                px[y * n + x] = new Color(1, 1, 1, Mathf.Clamp01(radius - d + 0.5f));
            }
        return Finish(t, px, n);
    }

    // 9-sliced rounded rect for UI.
    public static Sprite RoundedUI(int n = 96, int radius = 44)
    {
        var t = NewTex(n); var px = new Color[n * n];
        float inner = n * 0.5f - radius;
        for (int y = 0; y < n; y++)
            for (int x = 0; x < n; x++)
            {
                float dx = Mathf.Max(Mathf.Abs(x + 0.5f - n * 0.5f) - inner, 0);
                float dy = Mathf.Max(Mathf.Abs(y + 0.5f - n * 0.5f) - inner, 0);
                float d = Mathf.Sqrt(dx * dx + dy * dy);
                px[y * n + x] = new Color(1, 1, 1, Mathf.Clamp01(radius - d + 0.5f));
            }
        t.SetPixels(px); t.Apply(false, true);
        return Sprite.Create(t, new Rect(0, 0, n, n), new Vector2(0.5f, 0.5f), 100, 0, SpriteMeshType.FullRect,
            new Vector4(radius + 1, radius + 1, radius + 1, radius + 1));
    }

    public static Color Hex(string hex)
    {
        ColorUtility.TryParseHtmlString(hex, out var c);
        return c;
    }

    public static Color A(Color c, float a) { c.a = a; return c; }
}
