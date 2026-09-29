using System;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.UI;

// ORBYT — one tap, two orbits, no mercy.
public class Game : MonoBehaviour
{
    enum State { Menu, Playing, Dead }
    public enum Mode { Endless, Daily }

    // ---------- tuning ----------
    const float R_IN = 1.75f, R_OUT = 2.85f;
    const float VIEW = 2.7f;            // radians of look-ahead
    const float HIT_ARC = 0.34f;        // world units along the ring
    const float HIT_RAD = 0.42f;        // world units across rings
    const float PERFECT_ARC = 0.7f;     // swap this close to a spike = PERFECT
    const int FLIP_EVERY = 25;
    static readonly float[] Lanes = { R_IN, R_OUT };

    // ---------- palettes ----------
    struct Pal { public Color bg, ring, core, danger, accent; }
    static Pal P(string bg, string ring, string core, string danger, string accent) => new Pal
    { bg = Gfx.Hex(bg), ring = Gfx.Hex(ring), core = Gfx.Hex(core), danger = Gfx.Hex(danger), accent = Gfx.Hex(accent) };

    static readonly Pal[] Palettes =
    {
        P("#0B0620", "#4A3A9A", "#7B4DFF", "#FF2E63", "#25F4EE"), // synth
        P("#03161B", "#16757A", "#12B5A6", "#FF8A00", "#C6FF3B"), // reef
        P("#1A0514", "#7A1F5A", "#FF2E88", "#FFD23F", "#FF6BF0"), // candy
        P("#040A1E", "#23479E", "#3B82F6", "#FF4D4D", "#7CF9FF"), // deep
        P("#120A00", "#7A4700", "#FF6D00", "#00E5FF", "#FFB300"), // solar
        P("#0C0C0F", "#4A4A55", "#B0B0C0", "#FF1F3D", "#FFFFFF"), // mono
    };
    Pal cur, tgt;
    int palIndex;

    // ---------- skins ----------
    struct Skin { public string name; public Color col; public int cost; public bool prism; }
    static readonly Skin[] Skins =
    {
        new Skin { name = "NOVA",   col = Gfx.Hex("#F4FBFF"), cost = 0 },
        new Skin { name = "EMBER",  col = Gfx.Hex("#FF8A3D"), cost = 25 },
        new Skin { name = "TOXIC",  col = Gfx.Hex("#A6FF00"), cost = 60 },
        new Skin { name = "PLASMA", col = Gfx.Hex("#FF3DF2"), cost = 120 },
        new Skin { name = "GLACIER",col = Gfx.Hex("#5CE1FF"), cost = 200 },
        new Skin { name = "GOLD",   col = Gfx.Hex("#FFD447"), cost = 350 },
        new Skin { name = "PRISM",  col = Color.white,        cost = 600, prism = true },
    };
    int equipped, viewing;

    // ---------- runtime ----------
    State state = State.Menu;
    Mode mode;
    System.Random rng = new System.Random();
    Camera cam;
    Material matAdd, matAlpha;
    Sprite sCircle, sGlow, sRing, sSquare, sRound;
    Font font;

    Transform player; SpriteRenderer pCore, pGlow; TrailRenderer trail;
    float theta, radius, progress, dir = 1f, w, nextPos, lastAspect = -1;
    int lane = 1;

    class Ob
    {
        public Transform t; public SpriteRenderer body, glow;
        public int lane; public float pos, born, spin;
        public bool gem, passed, perfectArmed, dead;
    }
    readonly List<Ob> obs = new List<Ob>();
    readonly Stack<Ob> obPool = new Stack<Ob>();

    int score, best, level, nextFlip, combo, maxCombo, perfects, gemsRun, shards;
    float comboTimer, deadTimer, runTime, attractSwapCooldown;
    bool newBest, tutorialDone;
    bool bot; float botReach = 0.8f;

    // world deco
    LineRenderer[] rings = new LineRenderer[2];
    LineRenderer[] ringGlows = new LineRenderer[2];
    LineRenderer flipArc;
    SpriteRenderer core, coreGlow, coreRim, bgGlow;
    Transform stars;
    readonly List<SpriteRenderer> starList = new List<SpriteRenderer>();

    // UI
    Canvas canvas; CanvasScaler scaler;
    RectTransform menuUI, hudUI, deadUI;
    Text scoreText, comboText, hudBest, flipInText, tutText;
    Text titleMain, titleA, titleB, menuBest, shardText, dailyLabel, skinName, skinAction, muteLabel;
    Text dScore, dBest, dNewBest, dGems, dHead, dStats;
    Image flash, skinSwatch;
    Button skinActionBtn;
    readonly List<Text> popups = new List<Text>();
    readonly List<float> popupLife = new List<float>();
    readonly List<Vector3> popupWorld = new List<Vector3>();
    float scorePunch;

    // ======================================================================
    void Awake()
    {
        Application.targetFrameRate = -1;
        Input.multiTouchEnabled = true;
        cam = Camera.main;
        cam.orthographic = true;
        cam.clearFlags = CameraClearFlags.SolidColor;

        matAdd = Resources.Load<Material>("OrbytAlpha"); // alpha glow reads better than additive on WebGL
        matAlpha = Resources.Load<Material>("OrbytAlpha");
        sCircle = Gfx.Circle(); sGlow = Gfx.Glow(); sRing = Gfx.Ring(); sSquare = Gfx.Square(); sRound = Gfx.RoundedUI();
        font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");

        gameObject.AddComponent<Sfx>();
        var fx = new GameObject("Fx").AddComponent<Fx>();
        fx.Init(cam, sCircle, sRing, matAdd);

        best = PlayerPrefs.GetInt("best", 0);
        shards = PlayerPrefs.GetInt("shards", 0);
        equipped = viewing = PlayerPrefs.GetInt("skin", 0);
        tutorialDone = PlayerPrefs.GetInt("tut", 0) == 1;
        bot = Application.absoluteURL.Contains("bot=1");

        cur = tgt = Palettes[0];
        BuildWorld();
        BuildUI();
        ApplySkin(equipped);
        EnterMenu();
        WebBridge.Ready();
    }

    // ======================================================================
    // World construction
    SpriteRenderer Spr(string name, Sprite s, float scale, int order, bool additive, Transform parent = null)
    {
        var go = new GameObject(name);
        go.transform.SetParent(parent ? parent : transform, false);
        go.transform.localScale = Vector3.one * scale;
        var sr = go.AddComponent<SpriteRenderer>();
        sr.sprite = s; sr.sortingOrder = order;
        if (additive && matAdd) sr.sharedMaterial = matAdd;
        return sr;
    }

    LineRenderer Circle(string name, float r, float width, int order)
    {
        var go = new GameObject(name);
        go.transform.SetParent(transform, false);
        var lr = go.AddComponent<LineRenderer>();
        lr.sharedMaterial = matAlpha;
        lr.useWorldSpace = false; lr.loop = true;
        lr.widthMultiplier = width;
        lr.sortingOrder = order;
        lr.numCapVertices = 0;
        const int N = 128;
        lr.positionCount = N;
        for (int i = 0; i < N; i++)
        {
            float a = i / (float)N * Mathf.PI * 2f;
            lr.SetPosition(i, new Vector3(Mathf.Cos(a) * r, Mathf.Sin(a) * r, 0));
        }
        return lr;
    }

    void BuildWorld()
    {
        bgGlow = Spr("bgGlow", sGlow, 16f, -20, true);

        stars = new GameObject("Stars").transform;
        stars.SetParent(transform, false);
        var srng = new System.Random(3);
        for (int i = 0; i < 90; i++)
        {
            float a = (float)srng.NextDouble() * Mathf.PI * 2f;
            float r = 1.2f + (float)Math.Sqrt(srng.NextDouble()) * 13f;
            var s = Spr("star", sCircle, 0.03f + (float)srng.NextDouble() * 0.06f, -15, true, stars);
            s.transform.localPosition = new Vector3(Mathf.Cos(a) * r, Mathf.Sin(a) * r, 0);
            s.color = new Color(1, 1, 1, 0.15f + (float)srng.NextDouble() * 0.5f);
            starList.Add(s);
        }

        for (int i = 0; i < 2; i++)
        {
            ringGlows[i] = Circle("ringGlow" + i, Lanes[i], 0.32f, -6);
            rings[i] = Circle("ring" + i, Lanes[i], 0.045f, -5);
        }

        coreGlow = Spr("coreGlow", sGlow, 6f, -4, true);
        core = Spr("core", sCircle, 2.2f, -3, false);
        coreRim = Spr("coreRim", sRing, 2.5f, -2, true);

        flipArc = new GameObject("flipArc").AddComponent<LineRenderer>();
        flipArc.transform.SetParent(transform, false);
        flipArc.sharedMaterial = matAlpha; flipArc.useWorldSpace = false;
        flipArc.widthMultiplier = 0.07f; flipArc.sortingOrder = -1; flipArc.numCapVertices = 4;

        player = new GameObject("Player").transform;
        player.SetParent(transform, false);
        pGlow = Spr("glow", sGlow, 1.5f, 21, true, player);
        pCore = Spr("core", sCircle, 0.36f, 22, false, player);
        trail = player.gameObject.AddComponent<TrailRenderer>();
        trail.sharedMaterial = matAdd ? matAdd : matAlpha;
        trail.time = 0.35f; trail.minVertexDistance = 0.04f;
        trail.widthCurve = new AnimationCurve(new Keyframe(0, 0.3f), new Keyframe(1, 0f));
        trail.sortingOrder = 20; trail.numCapVertices = 4;
    }

    // ======================================================================
    // UI construction
    RectTransform Rect(string name, Transform parent, Vector2 anchor, Vector2 pos, Vector2 size)
    {
        var go = new GameObject(name, typeof(RectTransform));
        go.transform.SetParent(parent, false);
        var rt = (RectTransform)go.transform;
        rt.anchorMin = rt.anchorMax = anchor; rt.pivot = new Vector2(0.5f, 0.5f);
        rt.anchoredPosition = pos; rt.sizeDelta = size;
        return rt;
    }

    RectTransform Fill(string name, Transform parent)
    {
        var rt = Rect(name, parent, Vector2.zero, Vector2.zero, Vector2.zero);
        rt.anchorMin = Vector2.zero; rt.anchorMax = Vector2.one; rt.offsetMin = rt.offsetMax = Vector2.zero;
        return rt;
    }

    Text Label(Transform parent, string s, int size, Vector2 anchor, Vector2 pos, Color c, FontStyle st = FontStyle.Bold)
    {
        var rt = Rect("txt", parent, anchor, pos, new Vector2(1000, size * 1.5f));
        var t = rt.gameObject.AddComponent<Text>();
        t.font = font; t.fontSize = size; t.fontStyle = st; t.alignment = TextAnchor.MiddleCenter;
        t.color = c; t.text = s; t.raycastTarget = false;
        t.horizontalOverflow = HorizontalWrapMode.Overflow; t.verticalOverflow = VerticalWrapMode.Overflow;
        return t;
    }

    Button Btn(Transform parent, string s, int fs, Vector2 anchor, Vector2 pos, Vector2 size, Color bg, Color fg, Action onClick, out Text label, float corner = 1f)
    {
        var rt = Rect("btn", parent, anchor, pos, size);
        var img = rt.gameObject.AddComponent<Image>();
        img.sprite = sRound; img.type = Image.Type.Sliced; img.color = bg;
        img.pixelsPerUnitMultiplier = corner;
        var b = rt.gameObject.AddComponent<Button>();
        b.targetGraphic = img;
        var cb = b.colors; cb.pressedColor = new Color(0.85f, 0.85f, 0.85f); cb.highlightedColor = Color.white; cb.fadeDuration = 0.05f; b.colors = cb;
        b.onClick.AddListener(() => { Sfx.I.Click(); onClick(); });
        rt.gameObject.AddComponent<PressJuice>();
        label = Label(rt, s, fs, new Vector2(0.5f, 0.5f), Vector2.zero, fg);
        label.rectTransform.sizeDelta = size;
        return b;
    }

    Image Diamond(Transform parent, Vector2 anchor, Vector2 pos, float size, Color c)
    {
        var rt = Rect("gem", parent, anchor, pos, new Vector2(size, size));
        rt.localRotation = Quaternion.Euler(0, 0, 45);
        var img = rt.gameObject.AddComponent<Image>();
        img.sprite = sSquare; img.color = c; img.raycastTarget = false;
        return img;
    }

    void BuildUI()
    {
        var es = new GameObject("EventSystem");
        es.AddComponent<EventSystem>();
        es.AddComponent<StandaloneInputModule>();

        var cgo = new GameObject("Canvas");
        canvas = cgo.AddComponent<Canvas>();
        canvas.renderMode = RenderMode.ScreenSpaceOverlay;
        canvas.sortingOrder = 10;
        scaler = cgo.AddComponent<CanvasScaler>();
        scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
        scaler.referenceResolution = new Vector2(1080, 1920);
        cgo.AddComponent<GraphicRaycaster>();
        var root = canvas.transform;

        Vector2 TOP = new Vector2(0.5f, 1), BOT = new Vector2(0.5f, 0), MID = new Vector2(0.5f, 0.5f);
        Vector2 TL = new Vector2(0, 1), TR = new Vector2(1, 1);
        Color white = Color.white, dim = new Color(1, 1, 1, 0.55f);

        // ---- HUD ----
        hudUI = Fill("HUD", root);
        scoreText = Label(hudUI, "0", 130, MID, new Vector2(0, 4), white);
        comboText = Label(hudUI, "", 40, MID, new Vector2(0, -78), white);
        hudBest = Label(hudUI, "", 40, TOP, new Vector2(0, -110), dim);
        flipInText = Label(hudUI, "", 34, TOP, new Vector2(0, -165), dim, FontStyle.Normal);
        tutText = Label(hudUI, "TAP ANYWHERE TO SWITCH ORBIT", 44, BOT, new Vector2(0, 260), white);

        // ---- Menu ----
        menuUI = Fill("Menu", root);
        titleA = Label(menuUI, "ORBYT", 190, TOP, new Vector2(-7, -330), Gfx.Hex("#25F4EE"));
        titleB = Label(menuUI, "ORBYT", 190, TOP, new Vector2(7, -330), Gfx.Hex("#FF2E63"));
        titleMain = Label(menuUI, "ORBYT", 190, TOP, new Vector2(0, -330), white);
        Label(menuUI, "ONE TAP.  TWO ORBITS.  NO MERCY.", 36, TOP, new Vector2(0, -470), dim);
        menuBest = Label(menuUI, "", 46, TOP, new Vector2(0, -545), white);

        var shardRow = Rect("shards", menuUI, TR, new Vector2(-150, -90), new Vector2(260, 80));
        Diamond(shardRow, new Vector2(0, 0.5f), new Vector2(40, 0), 34, Gfx.Hex("#25F4EE"));
        shardText = Label(shardRow, "0", 48, new Vector2(0, 0.5f), new Vector2(0, 0), white);
        shardText.alignment = TextAnchor.MiddleLeft;
        shardText.rectTransform.pivot = new Vector2(0, 0.5f);
        shardText.rectTransform.anchoredPosition = new Vector2(80, 0);
        shardText.rectTransform.sizeDelta = new Vector2(200, 70);

        Btn(menuUI, "", 38, TL, new Vector2(130, -90), new Vector2(200, 90), new Color(1, 1, 1, 0.12f), white, () =>
        {
            Sfx.I.ToggleMute(); RefreshMenu();
        }, out muteLabel);

        Btn(menuUI, "PLAY", 80, BOT, new Vector2(0, 560), new Vector2(600, 180), white, Gfx.Hex("#0B0620"), () => StartRun(Mode.Endless), out _, 0.5f);
        Btn(menuUI, "DAILY", 44, BOT, new Vector2(0, 385), new Vector2(600, 120), new Color(1, 1, 1, 0.14f), white, () => StartRun(Mode.Daily), out dailyLabel, 0.7f);

        Btn(menuUI, "<", 60, BOT, new Vector2(-240, 230), new Vector2(120, 120), new Color(1, 1, 1, 0.1f), white, () => CycleSkin(-1), out _, 0.7f);
        Btn(menuUI, ">", 60, BOT, new Vector2(240, 230), new Vector2(120, 120), new Color(1, 1, 1, 0.1f), white, () => CycleSkin(1), out _, 0.7f);
        skinSwatch = Diamond(menuUI, BOT, new Vector2(-110, 250), 34, white);
        skinName = Label(menuUI, "", 40, BOT, new Vector2(20, 255), white);
        skinName.alignment = TextAnchor.MiddleCenter;
        skinActionBtn = Btn(menuUI, "", 30, BOT, new Vector2(0, 170), new Vector2(460, 56), new Color(1, 1, 1, 0.0f), dim, TrySkinAction, out skinAction, 0.9f);

        // ---- Dead ----
        deadUI = Fill("Dead", root);
        var shade = deadUI.gameObject.AddComponent<Image>();
        shade.color = new Color(0, 0, 0, 0.55f);
        shade.raycastTarget = true;
        dHead = Label(deadUI, "CRASHED", 64, TOP, new Vector2(0, -300), white);
        Label(deadUI, "SCORE", 40, TOP, new Vector2(0, -420), dim);
        dScore = Label(deadUI, "0", 230, TOP, new Vector2(0, -580), white);
        dNewBest = Label(deadUI, "NEW BEST!", 60, TOP, new Vector2(0, -760), Gfx.Hex("#FFD447"));
        dBest = Label(deadUI, "", 44, TOP, new Vector2(0, -850), dim);
        dStats = Label(deadUI, "", 36, TOP, new Vector2(0, -920), dim, FontStyle.Normal);
        dGems = Label(deadUI, "", 40, TOP, new Vector2(0, -990), Gfx.Hex("#25F4EE"));

        Btn(deadUI, "RETRY", 80, BOT, new Vector2(0, 560), new Vector2(600, 180), white, Gfx.Hex("#0B0620"), () => StartRun(mode), out _, 0.5f);
        var share = Btn(deadUI, "SHARE SCORE", 46, BOT, new Vector2(0, 385), new Vector2(600, 120), Gfx.Hex("#25F4EE"), Gfx.Hex("#0B0620"), () => { }, out _, 0.7f);
        share.gameObject.AddComponent<ShareOnPress>().Text = ShareText;
        Btn(deadUI, "HOME", 40, BOT, new Vector2(0, 235), new Vector2(300, 100), new Color(1, 1, 1, 0.12f), white, EnterMenu, out _, 0.8f);

        // ---- overlay ----
        for (int i = 0; i < 8; i++)
        {
            var p = Label(root, "", 56, new Vector2(0, 0), Vector2.zero, white);
            p.rectTransform.pivot = new Vector2(0.5f, 0.5f);
            p.gameObject.SetActive(false);
            var sh = p.gameObject.AddComponent<Shadow>(); sh.effectColor = new Color(0, 0, 0, 0.5f); sh.effectDistance = new Vector2(3, -3);
            popups.Add(p); popupLife.Add(0); popupWorld.Add(Vector3.zero);
        }
        flash = Fill("flash", root).gameObject.AddComponent<Image>();
        flash.color = new Color(1, 1, 1, 0); flash.raycastTarget = false;
    }

    // ======================================================================
    // Flow
    void EnterMenu()
    {
        state = State.Menu;
        ClearObstacles(false);
        menuUI.gameObject.SetActive(true);
        hudUI.gameObject.SetActive(false);
        deadUI.gameObject.SetActive(false);
        player.gameObject.SetActive(true);
        Time.timeScale = 1f;
        dir = 1f; w = 1.6f; progress = 0; nextPos = 1.2f; lane = 1;
        rng = new System.Random();
        viewing = equipped; ApplySkin(equipped);
        Sfx.I.Music.volume = 0.35f; Sfx.I.Music.pitch = 1f;
        RefreshMenu();
    }

    void StartRun(Mode m)
    {
        mode = m;
        if (!IsOwned(viewing)) viewing = equipped;
        ApplySkin(equipped = viewing);
        PlayerPrefs.SetInt("skin", equipped);

        rng = m == Mode.Daily ? new System.Random(DailySeed()) : new System.Random(Environment.TickCount);
        ClearObstacles(false);
        Fx.I.ClearAll();
        state = State.Playing;
        score = 0; level = 0; combo = 0; maxCombo = 0; perfects = 0; gemsRun = 0; runTime = 0; comboTimer = 0;
        nextFlip = FLIP_EVERY; newBest = false;
        dir = 1f; progress = 0; theta = Mathf.PI * 0.5f; lane = 1; radius = R_OUT; w = SpeedTarget();
        nextPos = tutorialDone ? 1.5f : 2.4f; // extra runway for first-timers
        palIndex = m == Mode.Daily ? DailySeed() % Palettes.Length : 0;
        tgt = Palettes[palIndex];
        player.gameObject.SetActive(true);
        player.localPosition = Polar(theta, radius);
        trail.Clear();
        Time.timeScale = 1f;

        menuUI.gameObject.SetActive(false);
        deadUI.gameObject.SetActive(false);
        hudUI.gameObject.SetActive(true);
        tutText.gameObject.SetActive(!tutorialDone);
        hudBest.text = "BEST " + CurrentBest();
        scoreText.text = "0";
        comboText.text = "";

        Sfx.I.EnsureMusic();
        Sfx.I.Music.volume = 0.55f; Sfx.I.Music.pitch = 1f;
        Fx.I.Punch(0.6f);
        Fx.I.Shockwave(Vector3.zero, Gfx.A(Color.white, 0.6f), 9f, 0.6f);
        WebBridge.Event(m == Mode.Daily ? "start_daily" : "start", 0);
    }

    void Die(Vector3 at)
    {
        state = State.Dead;
        deadTimer = 0;
        Sfx.I.Die();
        WebBridge.Vibrate(160);
        var pc = SkinColor();
        Fx.I.Burst(player.position, pc, 40, 9f, 0.22f, 0.9f, 2.2f);
        Fx.I.Burst(at, cur.danger, 20, 6f, 0.18f, 0.7f);
        Fx.I.Shockwave(player.position, pc, 6f, 0.5f);
        Fx.I.Shake(0.9f);
        Fx.I.Punch(1f);
        Flash(cur.danger, 0.45f);
        player.gameObject.SetActive(false);
        Time.timeScale = 0.25f;

        int prev = CurrentBest();
        if (score > prev)
        {
            newBest = prev > 0;
            if (mode == Mode.Daily) PlayerPrefs.SetInt(DailyKey(), score);
            else { best = score; PlayerPrefs.SetInt("best", best); }
        }
        PlayerPrefs.SetInt("shards", shards);
        PlayerPrefs.SetInt("runs", PlayerPrefs.GetInt("runs", 0) + 1);
        PlayerPrefs.Save();
        WebBridge.Event(mode == Mode.Daily ? "death_daily" : "death", score);
    }

    void ShowResults()
    {
        deadUI.gameObject.SetActive(true);
        hudUI.gameObject.SetActive(false);
        dHead.text = mode == Mode.Daily ? "DAILY #" + DailyNum() : Taunt();
        dHead.color = cur.accent;
        dScore.text = score.ToString();
        dNewBest.gameObject.SetActive(newBest);
        dBest.text = "BEST " + CurrentBest();
        dStats.text = perfects == 0 && level == 0 ? "TIP: SWITCH AT THE LAST SECOND FOR PERFECTS"
            : perfects + " PERFECT   ·   x" + maxCombo + " COMBO   ·   " + level + " FLIP" + (level == 1 ? "" : "S");
        dGems.text = gemsRun > 0 ? "+" + gemsRun + " SHARDS" : "";
        if (newBest) { Sfx.I.NewBest(); Flash(Gfx.Hex("#FFD447"), 0.3f); }
    }

    string Taunt()
    {
        if (score >= 100) return "LEGENDARY";
        if (score >= 60) return "UNREAL";
        if (score >= 40) return "SO CLOSE";
        if (score >= 20) return "NOT BAD";
        if (score >= 8) return "CRASHED";
        return "OOF";
    }

    // ======================================================================
    void Update()
    {
        FitCamera();
        float dt = Mathf.Min(Time.deltaTime, 0.05f);

        // Input
        bool tapped = false;
        if (Input.touchCount > 0)
        {
            for (int i = 0; i < Input.touchCount; i++)
                if (Input.GetTouch(i).phase == TouchPhase.Began) tapped = true;
        }
        else if (Input.GetMouseButtonDown(0)) tapped = true;
        if (Input.GetKeyDown(KeyCode.Space) || Input.GetKeyDown(KeyCode.UpArrow) || Input.GetKeyDown(KeyCode.DownArrow)) tapped = true;

        if (state == State.Playing)
        {
            if (tapped) Swap();
            runTime += dt;
            int steps = Mathf.CeilToInt(dt / 0.0125f);
            for (int s = 0; s < steps && state == State.Playing; s++) Step(dt / steps, false);
            comboTimer -= dt;
            if (comboTimer <= 0 && combo > 0) { combo = 0; comboText.text = ""; }
        }
        else if (state == State.Menu)
        {
            Step(dt, true);
            if (Input.GetKeyDown(KeyCode.Space) || Input.GetKeyDown(KeyCode.Return)) StartRun(Mode.Endless);
        }
        else if (state == State.Dead)
        {
            deadTimer += Time.unscaledDeltaTime;
            Time.timeScale = Mathf.MoveTowards(Time.timeScale, 1f, Time.unscaledDeltaTime * 1.2f);
            Sfx.I.Music.pitch = Mathf.MoveTowards(Sfx.I.Music.pitch, 0.6f, Time.unscaledDeltaTime * 1.5f);
            Sfx.I.Music.volume = Mathf.MoveTowards(Sfx.I.Music.volume, 0.3f, Time.unscaledDeltaTime);
            if (deadTimer > 0.75f && !deadUI.gameObject.activeSelf) { Time.timeScale = 1; ShowResults(); Sfx.I.Music.pitch = 1f; }
            if (deadUI.gameObject.activeSelf && deadTimer > 1.1f && (Input.GetKeyDown(KeyCode.Space) || Input.GetKeyDown(KeyCode.Return))) StartRun(mode);
            UpdateObstacleVisuals(dt);
        }

        UpdateVisuals(dt);
        UpdatePopups();
    }

    void FitCamera()
    {
        float aspect = (float)Screen.width / Mathf.Max(1, Screen.height);
        // Gameplay: rings fill the screen. Menu/results: pull back so buttons clear the rings.
        float playSize = Mathf.Max(4.6f, (R_OUT + 0.95f) / aspect);
        float menuSize = Mathf.Max(playSize, R_OUT / 0.34f);
        float target = state == State.Menu ? menuSize : playSize;
        if (!Mathf.Approximately(aspect, lastAspect)) { lastAspect = aspect; Fx.I.BaseSize = target; }
        Fx.I.BaseSize = Mathf.Lerp(Fx.I.BaseSize, target, 1f - Mathf.Exp(-Time.unscaledDeltaTime * 5f));
        scaler.matchWidthOrHeight = aspect > 0.75f ? 1f : 0f;
    }

    float SpeedTarget()
    {
        int inLevel = score - level * FLIP_EVERY;
        return Mathf.Min(1.55f + level * 0.28f + Mathf.Max(0, inLevel) * 0.012f, 3.9f);
    }

    static Vector3 Polar(float a, float r) => new Vector3(Mathf.Cos(a) * r, Mathf.Sin(a) * r, 0);

    void Swap()
    {
        int from = lane;
        lane = 1 - lane;
        Sfx.I.Tap(lane);
        Fx.I.Burst(player.position, SkinColor(), 6, 3f, 0.12f, 0.3f);

        // Arm PERFECT on the nearest spike we just dodged.
        Ob nearest = null; float nd = 999;
        foreach (var o in obs)
        {
            if (o.gem || o.passed || o.dead || o.lane != from) continue;
            float d = o.pos - progress;
            if (d > 0 && d < nd) { nd = d; nearest = o; }
        }
        if (nearest != null && nd * Lanes[from] < PERFECT_ARC) nearest.perfectArmed = true;
    }

    // Simulation step. auto = attract-mode autopilot on the menu.
    void Step(float dt, bool auto)
    {
        if (!auto) w = Mathf.MoveTowards(w, SpeedTarget(), dt * 0.6f);
        else w = 1.6f;
        progress += w * dt;
        theta += dir * w * dt;
        radius = Mathf.Lerp(radius, Lanes[lane], 1f - Mathf.Exp(-dt * 30f));
        player.localPosition = Polar(theta, radius);

        while (nextPos < progress + VIEW) SpawnPattern(auto);

        if (auto || bot)
        {
            // Autopilot: menu attract mode, and ?bot=1 for testing / trailer capture.
            attractSwapCooldown -= dt;
            foreach (var o in obs)
            {
                if (o.gem || o.passed || o.dead || o.lane != lane) continue;
                float d = (o.pos - progress) * Lanes[lane];
                if (d > 0 && d < (bot ? botReach : 0.75f) && attractSwapCooldown <= 0)
                {
                    if (bot) { Swap(); botReach = UnityEngine.Random.Range(0.45f, 1.3f); } else lane = 1 - lane;
                    attractSwapCooldown = 0.12f;
                    break;
                }
            }
        }

        for (int i = obs.Count - 1; i >= 0; i--)
        {
            if (i >= obs.Count) continue; // a FLIP can clear the list mid-loop
            var o = obs[i];
            if (o.dead) continue;
            float d = o.pos - progress;
            float r = Lanes[o.lane];
            if (!o.passed)
            {
                float arc = Mathf.Abs(d) * r;
                float rad = Mathf.Abs(radius - r);
                if (o.gem)
                {
                    if (arc < 0.4f && rad < 0.5f) CollectGem(o, auto);
                }
                else if (!auto && arc < HIT_ARC && rad < HIT_RAD)
                {
                    Die(o.t.position);
                    return;
                }
                if (!o.dead && d < -0.1f)
                {
                    o.passed = true;
                    if (!o.gem && !auto) OnPass(o);
                }
            }
            if (!o.dead && d < -0.9f) Recycle(o);
        }
        if (!auto) UpdateObstacleVisuals(0);
    }

    void OnPass(Ob o)
    {
        int gain = 1;
        if (o.perfectArmed)
        {
            combo++; perfects++;
            maxCombo = Mathf.Max(maxCombo, combo);
            comboTimer = 3.5f;
            int bonus = combo >= 5 ? 2 : 1;
            gain += bonus;
            Sfx.I.Perfect(combo);
            var pos = o.t.position;
            Fx.I.Burst(pos, cur.accent, 14 + combo * 2, 5f, 0.14f, 0.5f);
            Fx.I.Shockwave(pos, cur.accent, 1.8f, 0.35f);
            Fx.I.Punch(0.25f + Mathf.Min(combo, 5) * 0.05f);
            string word = combo >= 8 ? "GODLIKE" : combo >= 5 ? "INSANE" : combo >= 3 ? "CLUTCH" : "PERFECT";
            Popup(player.position * 1.25f, word + "  +" + bonus, cur.accent, 58 + Mathf.Min(combo, 6) * 4);
            comboText.text = "x" + combo;
            comboText.color = cur.accent;
            WebBridge.Vibrate(12);
        }
        score += gain;
        scoreText.text = score.ToString();
        scorePunch = 1f;

        if (!tutorialDone && score >= 5)
        {
            tutorialDone = true; tutText.gameObject.SetActive(false);
            PlayerPrefs.SetInt("tut", 1);
        }
        if (score >= nextFlip) Flip();
        if (!newBest && CurrentBest() >= 5 && score > CurrentBest())
        {
            newBest = true;
            Popup(Vector3.up * 1.6f, "NEW BEST!", Gfx.Hex("#FFD447"), 64);
            Sfx.I.NewBest();
        }
    }

    void CollectGem(Ob o, bool auto)
    {
        o.passed = true;
        if (auto) { Recycle(o); return; }
        gemsRun++; shards++;
        Sfx.I.Gem();
        Fx.I.Burst(o.t.position, cur.accent, 8, 3.5f, 0.1f, 0.4f);
        Popup(o.t.position, "+1", cur.accent, 40);
        Recycle(o);
    }

    void Flip()
    {
        level++;
        nextFlip += FLIP_EVERY;
        dir = -dir;
        foreach (var o in obs)
        {
            if (o.dead) continue;
            Fx.I.Burst(o.t.position, o.gem ? cur.accent : cur.danger, 6, 4f, 0.12f, 0.5f);
        }
        ClearObstacles(true);
        nextPos = progress + 1.3f;
        palIndex = (palIndex + 1) % Palettes.Length;
        tgt = Palettes[palIndex];
        Sfx.I.Flip();
        Sfx.I.Music.pitch = 1f + Mathf.Min(level, 6) * 0.025f;
        Fx.I.Shockwave(Vector3.zero, Color.white, 14f, 0.8f);
        Fx.I.Punch(1f);
        Fx.I.Shake(0.35f);
        Flash(Color.white, 0.35f);
        Popup(Vector3.zero + Vector3.up * 1.5f, "FLIP!", Color.white, 110);
        WebBridge.Vibrate(40);
    }

    // ======================================================================
    // Obstacles
    void SpawnPattern(bool auto)
    {
        float diff = auto ? 0.2f : Mathf.Clamp01(score / 140f);
        float gapT = Mathf.Lerp(0.56f, 0.3f, diff);
        float sp = Mathf.Max(gapT * (auto ? 1.6f : SpeedTarget()), 0.36f);
        int roll = rng.Next(100);

        if (roll < 34 - diff * 14)
        {
            int ln = rng.Next(2);
            Place(ln, nextPos, false);
            if (rng.Next(100) < 40) Place(1 - ln, nextPos, true);
            nextPos += sp * Mathf.Lerp(2.1f, 1.45f, diff);
        }
        else if (roll < 64)
        {
            int n = 3 + rng.Next(2 + (int)(diff * 3));
            int ln = rng.Next(2);
            for (int i = 0; i < n; i++)
            {
                Place(ln, nextPos, false);
                if (i == n - 1 && rng.Next(2) == 0) Place(1 - ln, nextPos, true);
                ln = 1 - ln;
                nextPos += sp;
            }
            nextPos += sp * 1.1f;
        }
        else if (roll < 82)
        {
            int ln = rng.Next(2);
            int n = 3 + rng.Next(3);
            for (int i = 0; i < n; i++)
            {
                Place(ln, nextPos, false);
                if ((i & 1) == 0) Place(1 - ln, nextPos, true);
                nextPos += sp * 0.7f;
            }
            nextPos += sp * 1.2f;
        }
        else
        {
            int ln = rng.Next(2);
            Place(ln, nextPos, false); nextPos += sp * 0.75f;
            Place(ln, nextPos, false); nextPos += sp;
            Place(1 - ln, nextPos, false); nextPos += sp * 1.5f;
        }
    }

    void Place(int ln, float pos, bool gem)
    {
        Ob o = obPool.Count > 0 ? obPool.Pop() : NewOb();
        o.lane = ln; o.pos = pos; o.gem = gem; o.passed = false; o.perfectArmed = false; o.dead = false;
        o.born = Time.time; o.spin = (float)rng.NextDouble() * 360f;
        float a = theta + dir * (pos - progress);
        o.t.localPosition = Polar(a, Lanes[ln]);
        o.t.localScale = Vector3.zero;
        o.body.transform.localScale = Vector3.one * (gem ? 0.3f : 0.56f);
        o.glow.transform.localScale = Vector3.one * (gem ? 1.2f : 1.9f);
        o.t.gameObject.SetActive(true);
        obs.Add(o);
    }

    Ob NewOb()
    {
        var o = new Ob();
        o.t = new GameObject("ob").transform;
        o.t.SetParent(transform, false);
        o.glow = Spr("glow", sGlow, 1.5f, 10, true, o.t);
        o.body = Spr("body", sSquare, 0.46f, 11, false, o.t);
        return o;
    }

    void Recycle(Ob o)
    {
        o.dead = true;
        o.t.gameObject.SetActive(false);
        obs.Remove(o);
        obPool.Push(o);
    }

    void ClearObstacles(bool _)
    {
        for (int i = obs.Count - 1; i >= 0; i--) Recycle(obs[i]);
    }

    void UpdateObstacleVisuals(float _)
    {
        float now = Time.time;
        foreach (var o in obs)
        {
            float age = now - o.born;
            float s = age < 0.35f ? Back(age / 0.35f) : 1f;
            if (o.gem) s *= 1f + Mathf.Sin(now * 8f + o.spin) * 0.12f;
            float d = o.pos - progress;
            float fade = d < 0 ? Mathf.Clamp01(1f + d / 0.9f) : 1f;
            o.t.localScale = Vector3.one * s;
            o.body.transform.localRotation = Quaternion.Euler(0, 0, 45f + o.spin + now * (o.gem ? 160f : 70f));
            Color c = o.gem ? cur.accent : cur.danger;
            o.body.color = Gfx.A(Color.Lerp(c, Color.white, o.gem ? 0.3f : 0.15f), fade);
            o.glow.color = Gfx.A(c, (o.gem ? 0.5f : 0.6f) * fade);
        }
    }

    static float Back(float t)
    {
        const float c1 = 1.70158f, c3 = c1 + 1f;
        return 1f + c3 * Mathf.Pow(t - 1f, 3) + c1 * Mathf.Pow(t - 1f, 2);
    }

    // ======================================================================
    // Visual polish
    void UpdateVisuals(float dt)
    {
        float k = 1f - Mathf.Exp(-Time.unscaledDeltaTime * 4f);
        cur.bg = Color.Lerp(cur.bg, tgt.bg, k);
        cur.ring = Color.Lerp(cur.ring, tgt.ring, k);
        cur.core = Color.Lerp(cur.core, tgt.core, k);
        cur.danger = Color.Lerp(cur.danger, tgt.danger, k);
        cur.accent = Color.Lerp(cur.accent, tgt.accent, k);

        cam.backgroundColor = cur.bg;
        bgGlow.color = Gfx.A(cur.core, 0.16f);

        float beatPhase = Sfx.I.Music.isPlaying ? (Sfx.I.Music.time % Sfx.Beat) / Sfx.Beat : (Time.time % Sfx.Beat) / Sfx.Beat;
        float pulse = Mathf.Exp(-beatPhase * 6f);

        for (int i = 0; i < 2; i++)
        {
            bool active = state != State.Dead && lane == i;
            var rc = Color.Lerp(cur.ring, Color.white, active ? 0.25f : 0f);
            rings[i].startColor = rings[i].endColor = Gfx.A(rc, active ? 0.95f : 0.6f);
            ringGlows[i].startColor = ringGlows[i].endColor = Gfx.A(cur.ring, 0.12f + pulse * 0.1f);
        }

        core.color = Color.Lerp(cur.bg, cur.core, 0.35f);
        core.transform.localScale = Vector3.one * (2.2f + pulse * 0.08f);
        coreRim.color = Gfx.A(cur.core, 0.8f);
        coreRim.transform.localScale = Vector3.one * (2.5f + pulse * 0.12f);
        coreGlow.color = Gfx.A(cur.core, 0.35f + pulse * 0.25f);
        coreGlow.transform.localScale = Vector3.one * (5.5f + pulse * 0.8f);

        stars.localRotation = Quaternion.Euler(0, 0, stars.localEulerAngles.z - dir * dt * 3f);

        // flip progress arc around the core
        if (state == State.Playing)
        {
            float f = Mathf.Clamp01((score - (nextFlip - FLIP_EVERY)) / (float)FLIP_EVERY);
            int n = Mathf.Max(2, (int)(f * 64));
            flipArc.positionCount = n;
            for (int i = 0; i < n; i++)
            {
                float a = Mathf.PI * 0.5f - (i / 63f) * Mathf.PI * 2f * dir;
                flipArc.SetPosition(i, Polar(a, 1.42f));
            }
            flipArc.startColor = flipArc.endColor = Gfx.A(cur.accent, f > 0 ? 0.9f : 0f);
            flipIn(nextFlip - score);
        }
        else flipArc.positionCount = 0;

        // player
        var pc = SkinColor();
        pCore.color = Color.Lerp(pc, Color.white, 0.35f);
        pGlow.color = Gfx.A(pc, 0.8f);
        float sq = 1f + Mathf.Abs(radius - Lanes[lane]) * 0.6f;
        pCore.transform.localScale = new Vector3(0.36f / sq, 0.36f * sq, 1);
        trail.startColor = Gfx.A(pc, 0.9f);
        trail.endColor = Gfx.A(pc, 0f);

        if (state == State.Menu) UpdateObstacleVisuals(dt);

        // HUD
        scorePunch = Mathf.MoveTowards(scorePunch, 0, Time.unscaledDeltaTime * 5f);
        scoreText.rectTransform.localScale = Vector3.one * (1f + scorePunch * 0.25f);
        if (tutText.gameObject.activeSelf) tutText.color = Gfx.A(Color.white, 0.5f + 0.5f * Mathf.Sin(Time.unscaledTime * 6f));

        if (flash.color.a > 0) flash.color = Gfx.A(flash.color, Mathf.MoveTowards(flash.color.a, 0, Time.unscaledDeltaTime * 2.5f));

        if (menuUI.gameObject.activeSelf)
        {
            float gl = Mathf.PerlinNoise(Time.unscaledTime * 3f, 0) > 0.8f ? 18f : 7f;
            titleA.rectTransform.anchoredPosition = new Vector2(-gl, -330);
            titleB.rectTransform.anchoredPosition = new Vector2(gl, -330);
            titleA.color = Gfx.A(cur.accent, 0.9f);
            titleB.color = Gfx.A(cur.danger, 0.9f);
            float ts = 1f + pulse * 0.03f;
            titleMain.rectTransform.localScale = titleA.rectTransform.localScale = titleB.rectTransform.localScale = new Vector3(ts, ts, 1);
            if (Skins[viewing].prism) skinSwatch.color = SkinColor();
        }
    }

    void flipIn(int n) { flipInText.text = "FLIP IN " + Mathf.Max(0, n); }

    void Flash(Color c, float a) => flash.color = Gfx.A(c, a);

    void Popup(Vector3 world, string s, Color c, int size)
    {
        int idx = 0; float least = 99;
        for (int i = 0; i < popups.Count; i++) if (popupLife[i] < least) { least = popupLife[i]; idx = i; }
        var p = popups[idx];
        p.text = s; p.color = c; p.fontSize = size;
        p.gameObject.SetActive(true);
        popupLife[idx] = 1f; popupWorld[idx] = world;
    }

    void UpdatePopups()
    {
        for (int i = 0; i < popups.Count; i++)
        {
            if (popupLife[i] <= 0) continue;
            popupLife[i] -= Time.unscaledDeltaTime * 1.3f;
            var p = popups[i];
            if (popupLife[i] <= 0) { p.gameObject.SetActive(false); continue; }
            float t = 1f - popupLife[i];
            var sp = cam.WorldToScreenPoint(popupWorld[i]);
            float half = p.preferredWidth * 0.5f * canvas.scaleFactor + 24f;
            sp.x = Mathf.Clamp(sp.x, half, Screen.width - half); // keep popups on screen
            p.rectTransform.position = sp + new Vector3(0, t * 120f * canvas.scaleFactor, 0);
            float sc = t < 0.12f ? Mathf.Lerp(0.4f, 1.15f, t / 0.12f) : Mathf.Lerp(1.15f, 1f, (t - 0.12f) * 4f);
            p.rectTransform.localScale = Vector3.one * sc;
            p.color = Gfx.A(p.color, Mathf.Clamp01(popupLife[i] * 3f));
        }
    }

    // ======================================================================
    // Skins & meta
    Color SkinColor()
    {
        var s = Skins[state == State.Menu ? viewing : equipped];
        return s.prism ? Color.HSVToRGB(Time.unscaledTime * 0.35f % 1f, 0.75f, 1f) : s.col;
    }

    bool IsOwned(int i) => Skins[i].cost == 0 || PlayerPrefs.GetInt("own_" + i, 0) == 1;

    void ApplySkin(int i) { viewing = i; }

    void CycleSkin(int d)
    {
        viewing = (viewing + d + Skins.Length) % Skins.Length;
        if (IsOwned(viewing)) { equipped = viewing; PlayerPrefs.SetInt("skin", equipped); }
        Fx.I.Burst(player.position, SkinColor(), 12, 4f, 0.12f, 0.4f);
        RefreshMenu();
    }

    void TrySkinAction()
    {
        var s = Skins[viewing];
        if (IsOwned(viewing)) return;
        if (shards < s.cost) { Fx.I.Shake(0.2f); return; }
        shards -= s.cost;
        PlayerPrefs.SetInt("own_" + viewing, 1);
        PlayerPrefs.SetInt("shards", shards);
        equipped = viewing; PlayerPrefs.SetInt("skin", equipped);
        PlayerPrefs.Save();
        Sfx.I.Unlock();
        Fx.I.Burst(player.position, SkinColor(), 50, 8f, 0.2f, 0.9f);
        Fx.I.Shockwave(player.position, SkinColor(), 5f, 0.5f);
        Flash(SkinColor(), 0.3f);
        WebBridge.Event("unlock_" + s.name.ToLowerInvariant(), s.cost);
        RefreshMenu();
    }

    void RefreshMenu()
    {
        menuBest.text = best > 0 ? "BEST  " + best : "";
        shardText.text = shards.ToString();
        int db = PlayerPrefs.GetInt(DailyKey(), 0);
        dailyLabel.text = "DAILY #" + DailyNum() + (db > 0 ? "   ·   BEST " + db : "   ·   NEW");
        muteLabel.text = Sfx.I.Muted ? "SOUND OFF" : "SOUND ON";
        muteLabel.fontSize = 26;

        var s = Skins[viewing];
        skinName.text = s.name;
        skinSwatch.color = s.prism ? SkinColor() : s.col;
        bool owned = IsOwned(viewing);
        skinAction.text = owned ? (viewing == equipped ? "EQUIPPED" : "") : (shards >= s.cost ? "TAP TO UNLOCK · " + s.cost : "LOCKED · " + s.cost + " SHARDS");
        skinAction.color = owned ? new Color(1, 1, 1, 0.5f) : (shards >= s.cost ? Gfx.Hex("#FFD447") : new Color(1, 1, 1, 0.45f));
        var img = skinActionBtn.targetGraphic as Image;
        img.color = !owned && shards >= s.cost ? new Color(1, 0.83f, 0.28f, 0.18f) : new Color(1, 1, 1, 0);
    }

    // ======================================================================
    // Daily challenge + share
    static readonly DateTime Epoch = new DateTime(2026, 9, 1, 0, 0, 0, DateTimeKind.Utc);
    static int DailyNum() => (int)(DateTime.UtcNow.Date - Epoch).TotalDays + 1;
    static int DailySeed() { var d = DateTime.UtcNow; return d.Year * 10000 + d.Month * 100 + d.Day; }
    static string DailyKey() => "daily_" + DailySeed();
    int CurrentBest() => mode == Mode.Daily ? PlayerPrefs.GetInt(DailyKey(), 0) : best;

    string ShareText()
    {
        var sb = new System.Text.StringBuilder();
        sb.Append(mode == Mode.Daily ? "\U0001F300 ORBYT Daily #" + DailyNum() : "\U0001F300 ORBYT");
        sb.Append("\n");
        // Wordle-style bar: one block per 10 points, colored by tier.
        int blocks = Mathf.Clamp(Mathf.CeilToInt(score / 10f), 1, 10);
        string fill = score >= 80 ? "\U0001F7E8" : score >= 40 ? "\U0001F7EA" : "\U0001F7E6";
        for (int i = 0; i < 10; i++) sb.Append(i < blocks ? fill : "⬛");
        sb.Append("\n");
        sb.Append("\U0001F3AF " + score + " pts");
        if (perfects > 0) sb.Append("  ⚡ " + perfects + " perfect");
        if (maxCombo >= 3) sb.Append("  \U0001F525 x" + maxCombo);
        if (level > 0) sb.Append("  \U0001F504 " + level + " flip" + (level == 1 ? "" : "s"));
        sb.Append("\n");
        sb.Append(score >= 40 ? "Bet you can't beat it." : "One tap. Harder than it looks.");
        return sb.ToString();
    }
}
