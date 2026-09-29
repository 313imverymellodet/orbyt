using System;
using UnityEngine;

// Every sound and the soundtrack are synthesized at startup — no audio files.
public class Sfx : MonoBehaviour
{
    public static Sfx I;
    const int SR = 22050;
    public const float BPM = 128f;
    public static float Beat => 60f / BPM;

    AudioSource[] voices;
    int next;
    public AudioSource Music { get; private set; }

    AudioClip tap, perfect, gem, flip, die, click, unlock, newBest;
    public bool Muted { get; private set; }

    System.Random noise = new System.Random(7);
    float Noise() => (float)(noise.NextDouble() * 2.0 - 1.0);

    void Awake()
    {
        I = this;
        voices = new AudioSource[6];
        for (int i = 0; i < voices.Length; i++)
        {
            voices[i] = gameObject.AddComponent<AudioSource>();
            voices[i].playOnAwake = false;
        }
        Music = gameObject.AddComponent<AudioSource>();
        Music.loop = true;
        Music.playOnAwake = false;
        Music.volume = 0.35f;

        Build();
        Music.clip = MakeMusic();
        Muted = PlayerPrefs.GetInt("muted", 0) == 1;
        AudioListener.volume = Muted ? 0 : 1;
    }

    public void ToggleMute()
    {
        Muted = !Muted;
        AudioListener.volume = Muted ? 0 : 1;
        PlayerPrefs.SetInt("muted", Muted ? 1 : 0);
        PlayerPrefs.Save();
    }

    public void EnsureMusic()
    {
        if (!Music.isPlaying) Music.Play();
    }

    void Play(AudioClip c, float vol = 1f, float pitch = 1f)
    {
        var s = voices[next];
        next = (next + 1) % voices.Length;
        s.pitch = pitch;
        s.PlayOneShot(c, vol);
    }

    public void Tap(int lane) => Play(tap, 0.55f, lane == 0 ? 1.2f : 0.95f);
    public void Perfect(int combo) => Play(perfect, 0.6f, 1f + Mathf.Min(combo - 1, 8) * 0.06f);
    public void Gem() => Play(gem, 0.45f, UnityEngine.Random.Range(0.95f, 1.08f));
    public void Flip() => Play(flip, 0.8f);
    public void Die() => Play(die, 0.9f);
    public void Click() => Play(click, 0.4f);
    public void Unlock() => Play(unlock, 0.7f);
    public void NewBest() => Play(newBest, 0.6f);

    // ---------------- synthesis ----------------

    static AudioClip Clip(string name, float[] d)
    {
        var c = AudioClip.Create(name, d.Length, 1, SR, false);
        c.SetData(d, 0);
        return c;
    }

    delegate float Gen(float t, float dt);

    static float[] Render(float dur, Gen g)
    {
        int n = (int)(SR * dur);
        var d = new float[n];
        float dt = 1f / SR;
        for (int i = 0; i < n; i++)
        {
            float v = g(i * dt, dt);
            // soft tail fade to avoid clicks
            float tail = Mathf.Clamp01((n - i) / (SR * 0.01f));
            d[i] = Mathf.Clamp(v * tail, -1f, 1f);
        }
        return d;
    }

    const float TAU = Mathf.PI * 2f;

    void Build()
    {
        float ph = 0;
        tap = Clip("tap", Render(0.09f, (t, dt) =>
        {
            float f = Mathf.Lerp(520f, 980f, t / 0.09f);
            ph += TAU * f * dt;
            return (Mathf.Sin(ph) + 0.25f * Mathf.Sin(ph * 2f)) * Mathf.Exp(-t * 38f) * 0.8f;
        }));

        float[] pNotes = { 880f, 1108.73f, 1318.51f, 1760f };
        ph = 0;
        perfect = Clip("perfect", Render(0.42f, (t, dt) =>
        {
            int k = Mathf.Min((int)(t / 0.055f), 3);
            float lt = t - k * 0.055f;
            ph += TAU * pNotes[k] * dt;
            float env = k < 3 ? Mathf.Exp(-lt * 25f) : Mathf.Exp(-lt * 9f);
            return (Mathf.Sin(ph) + 0.3f * Mathf.Sin(ph * 3f)) * env * 0.5f;
        }));

        ph = 0;
        gem = Clip("gem", Render(0.2f, (t, dt) =>
        {
            float f = t < 0.06f ? 1567.98f : 2093f;
            float lt = t < 0.06f ? t : t - 0.06f;
            ph += TAU * f * dt;
            return Mathf.Sin(ph) * Mathf.Exp(-lt * 22f) * 0.55f;
        }));

        ph = 0; float lp = 0;
        flip = Clip("flip", Render(0.75f, (t, dt) =>
        {
            float f = 160f * Mathf.Pow(6f, t / 0.75f);
            ph += TAU * f * dt;
            float a = Mathf.Lerp(0.02f, 0.4f, t / 0.75f);
            lp += (Noise() - lp) * a;
            float env = Mathf.Min(t * 20f, 1f) * Mathf.Exp(-t * 3.2f);
            return (Mathf.Sin(ph) * 0.45f + lp * 0.8f) * env;
        }));

        ph = 0; lp = 0;
        die = Clip("die", Render(1.0f, (t, dt) =>
        {
            float f = Mathf.Lerp(260f, 35f, Mathf.Sqrt(t));
            ph += TAU * f * dt;
            lp += (Noise() - lp) * Mathf.Lerp(0.6f, 0.03f, t);
            float sq = Mathf.Sign(Mathf.Sin(ph)) * 0.25f + Mathf.Sin(ph) * 0.4f;
            return (sq + lp * 1.1f) * Mathf.Exp(-t * 3.5f);
        }));

        ph = 0;
        click = Clip("click", Render(0.04f, (t, dt) =>
        {
            ph += TAU * 1400f * dt;
            return Mathf.Sin(ph) * Mathf.Exp(-t * 90f) * 0.6f;
        }));

        float[] uNotes = { 523.25f, 659.25f, 783.99f, 1046.5f, 1318.51f };
        ph = 0;
        unlock = Clip("unlock", Render(0.8f, (t, dt) =>
        {
            int k = Mathf.Min((int)(t / 0.08f), 4);
            float lt = t - k * 0.08f;
            ph += TAU * uNotes[k] * dt;
            return (Mathf.Sin(ph) + 0.2f * Mathf.Sin(ph * 2f)) * Mathf.Exp(-lt * (k < 4 ? 14f : 5f)) * 0.5f;
        }));

        float[] bNotes = { 659.25f, 783.99f, 987.77f, 1318.51f, 987.77f, 1318.51f };
        ph = 0;
        newBest = Clip("best", Render(0.9f, (t, dt) =>
        {
            int k = Mathf.Min((int)(t / 0.07f), 5);
            float lt = t - k * 0.07f;
            ph += TAU * bNotes[k] * dt;
            return (Mathf.Sin(ph) + 0.35f * Mathf.Sin(ph * 3f)) * Mathf.Exp(-lt * (k < 5 ? 16f : 4f)) * 0.4f;
        }));
    }

    // 4-bar synthwave loop: Am – F – C – G, sidechained to the kick.
    AudioClip MakeMusic()
    {
        float beat = Beat;
        int beats = 16;
        float dur = beat * beats;
        int n = (int)(SR * dur);
        var d = new float[n];

        float[] roots = { 55f, 43.65f, 65.41f, 49f };
        float[][] chords =
        {
            new[] { 440f, 523.25f, 659.25f },
            new[] { 349.23f, 440f, 523.25f },
            new[] { 523.25f, 659.25f, 783.99f },
            new[] { 392f, 493.88f, 587.33f },
        };
        int[] bassPat = { 1, 1, 2, 1, 1, 2, 1, 2 };
        int[] arpPat = { 0, 1, 2, 1, 2, 0, 1, 2, 0, 2, 1, 2, 0, 1, 2, 1 };

        float bassLp = 0, hatPrev = 0;
        for (int i = 0; i < n; i++)
        {
            float t = (float)i / SR;
            float bt = t / beat;
            int bi = (int)bt;
            int bar = (bi / 4) % 4;
            float inBeat = (bt - bi) * beat;

            // kick
            float kf = 45f + 110f * Mathf.Exp(-inBeat * 28f);
            float kick = Mathf.Sin(TAU * kf * inBeat) * Mathf.Exp(-inBeat * 7f) * 0.75f;
            float duck = 1f - 0.65f * Mathf.Exp(-inBeat * 9f);

            // hats on off-8ths
            float e8 = bt * 2f; int e8i = (int)e8; float in8 = (e8 - e8i) * beat * 0.5f;
            float hat = 0;
            if ((e8i & 1) == 1)
            {
                float nz = Noise();
                hat = (nz - hatPrev) * Mathf.Exp(-in8 * 55f) * 0.09f;
                hatPrev = nz;
            }

            // bass (8ths, saw, one-pole lowpass)
            float bf = roots[bar] * bassPat[e8i % 8];
            float saw = 2f * ((bf * in8) % 1f) - 1f;
            float bassEnv = Mathf.Exp(-in8 * 7f);
            bassLp += (saw * bassEnv - bassLp) * 0.12f;
            float bass = bassLp * 0.55f;

            // arp (16ths)
            float e16 = bt * 4f; int e16i = (int)e16; float in16 = (e16 - e16i) * beat * 0.25f;
            float af = chords[bar][arpPat[e16i % 16]] * ((e16i / 8) % 2 == 0 ? 1f : 2f);
            float arp = (Mathf.Sin(TAU * af * in16) + 0.25f * Mathf.Sin(TAU * af * 3f * in16)) * Mathf.Exp(-in16 * 16f) * 0.11f;

            // pad (chord, slow swell)
            float pad = 0;
            var ch = chords[bar];
            for (int k = 0; k < 3; k++) pad += Mathf.Sin(TAU * ch[k] * 0.5f * t + k);
            pad *= 0.022f;

            d[i] = Mathf.Clamp(kick + hat + (bass + arp + pad) * duck, -1f, 1f) * 0.8f;
        }
        return Clip("music", d);
    }
}
