using System.Collections.Generic;
using UnityEngine;

// Lightweight pooled particles, shockwaves, screen shake and zoom punch.
public class Fx : MonoBehaviour
{
    public static Fx I;

    class P
    {
        public Transform t;
        public SpriteRenderer sr;
        public Vector2 v;
        public float life, max, size, drag, spin;
        public Color c;
        public bool ring, active;
    }

    readonly List<P> pool = new List<P>();
    Sprite dot, ringSprite;
    Material add;
    Camera cam;

    float trauma, punch;
    public float BaseSize = 5f;

    public void Init(Camera c, Sprite dotSprite, Sprite ring, Material additive)
    {
        I = this; cam = c; dot = dotSprite; ringSprite = ring; add = additive;
        for (int i = 0; i < 160; i++) pool.Add(Create());
    }

    P Create()
    {
        var go = new GameObject("p");
        go.transform.SetParent(transform, false);
        var sr = go.AddComponent<SpriteRenderer>();
        sr.sprite = dot;
        if (add) sr.sharedMaterial = add;
        sr.sortingOrder = 40;
        go.SetActive(false);
        return new P { t = go.transform, sr = sr };
    }

    P Get()
    {
        foreach (var p in pool) if (!p.active) return p;
        if (pool.Count < 500) { var np = Create(); pool.Add(np); return np; }
        return pool[Random.Range(0, pool.Count)];
    }

    public void Burst(Vector3 pos, Color c, int n, float speed, float size, float life, float drag = 3f)
    {
        for (int i = 0; i < n; i++)
        {
            var p = Get();
            float a = Random.Range(0f, Mathf.PI * 2f);
            float s = speed * Random.Range(0.3f, 1f);
            p.v = new Vector2(Mathf.Cos(a), Mathf.Sin(a)) * s;
            p.max = p.life = life * Random.Range(0.6f, 1.1f);
            p.size = size * Random.Range(0.5f, 1.2f);
            p.drag = drag; p.c = c; p.ring = false; p.spin = 0;
            p.sr.sprite = dot; p.sr.sortingOrder = 40;
            p.t.position = pos; p.t.localScale = Vector3.one * p.size;
            p.active = true; p.t.gameObject.SetActive(true);
        }
    }

    public void Shockwave(Vector3 pos, Color c, float maxSize, float life)
    {
        var p = Get();
        p.v = Vector2.zero; p.max = p.life = life; p.size = maxSize; p.c = c; p.ring = true; p.drag = 0;
        p.sr.sprite = ringSprite; p.sr.sortingOrder = 39;
        p.t.position = pos; p.t.localScale = Vector3.zero;
        p.active = true; p.t.gameObject.SetActive(true);
    }

    public void Shake(float amount) => trauma = Mathf.Min(1f, trauma + amount);
    public void Punch(float amount) => punch = Mathf.Max(punch, amount);

    public void ClearAll()
    {
        foreach (var p in pool) { p.active = false; p.t.gameObject.SetActive(false); }
    }

    void Update()
    {
        float dt = Time.deltaTime;
        foreach (var p in pool)
        {
            if (!p.active) continue;
            p.life -= dt;
            if (p.life <= 0) { p.active = false; p.t.gameObject.SetActive(false); continue; }
            float k = p.life / p.max;
            if (p.ring)
            {
                p.t.localScale = Vector3.one * p.size * (1f - k * k * k);
                p.sr.color = Gfx.A(p.c, k * p.c.a);
            }
            else
            {
                p.v *= Mathf.Exp(-p.drag * dt);
                p.t.position += (Vector3)(p.v * dt);
                p.t.localScale = Vector3.one * p.size * k;
                p.sr.color = Gfx.A(p.c, Mathf.Min(1f, k * 1.5f));
            }
        }
    }

    void LateUpdate()
    {
        float dt = Time.unscaledDeltaTime;
        trauma = Mathf.Max(0, trauma - dt * 1.6f);
        punch = Mathf.Max(0, punch - dt * 2.5f);
        float s = trauma * trauma;
        float tt = Time.unscaledTime * 38f;
        var off = new Vector3((Mathf.PerlinNoise(tt, 0.1f) - 0.5f) * 1.2f * s, (Mathf.PerlinNoise(0.7f, tt) - 0.5f) * 1.2f * s, -10f);
        cam.transform.position = off;
        cam.transform.rotation = Quaternion.Euler(0, 0, (Mathf.PerlinNoise(tt, 5f) - 0.5f) * 6f * s);
        cam.orthographicSize = BaseSize * (1f - punch * 0.07f);
    }
}
