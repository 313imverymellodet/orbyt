/* MelloBase: achievement badges + "Sign in with Base" for every Mello game page.
 *
 *   <script src="base.js" data-game="graveshift" data-corner="bl"></script>
 *
 * - Watches the events each game already sends to analytics (window.__ev) and reports the ones that count
 *   toward badges to orbyt-api, which awards them per player (an anonymous id kept on this device).
 * - "Sign in with Base" (a Base Account: passkey, no seed phrase, no app install) links the badges to a wallet.
 *   The wallet is also what ties a player together across all of our games.
 * - Collecting mints the badges on Base as soulbound ERC-1155 tokens. The server pays the gas; nothing is
 *   ever bought or sold, and the badges can't be transferred.
 * - Portal builds (window.PORTAL set by tools/portals.mjs) and other hosts get none of this.
 *
 * The UI lives in a shadow root so the game's page styles and ours never touch.
 * Master copy: orbyt/tools/base/base.js (copy into each game's WebGL template and dist/).
 */
(function () {
  "use strict";
  var me0 = document.currentScript;
  var GAME = (me0 && me0.getAttribute("data-game")) || "";
  var CORNER = (me0 && me0.getAttribute("data-corner")) || "bl";
  var HUB_MODE = GAME === "hub";
  var ALWAYS = !!(me0 && me0.getAttribute("data-always"));   // idle games that never leave gameplay
  var host = location.hostname;
  var q = new URLSearchParams(location.search);
  if (window.PORTAL) return;                                                           // portals: crypto-free
  if (!/(^|\.)vercel\.app$|(^|\.)mellovibes\.io$|^localhost$|^127\.0\.0\.1$/.test(host)) return;
  if (q.get("nobase") === "1") return;

  var API = q.get("api") || "https://orbyt-api-production-29f6.up.railway.app";
  var HUB = "https://orbyt-arcade.vercel.app";
  var SDK_URL = "https://unpkg.com/@base-org/account@2.5.13/dist/base-account.min.js";
  var STORE = "mello_base";
  var dbg = q.get("basedebug") === "1";
  var SDK = function () { return window.createBaseAccountSDK || (window.base && window.base.createBaseAccountSDK); };
  var log = function () { if (dbg) try { console.log.apply(console, ["[base]"].concat([].slice.call(arguments))); } catch (e) {} };

  var id = null, me = null, catalog = null, rules = [], queue = [], playing = false, nonce = null, sdk = null, busy = false, ageOk = false;
  try { id = JSON.parse(localStorage.getItem(STORE) || "null"); } catch (e) {}

  function api(path, body) {
    var opt = body ? { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(body) } : {};
    return fetch(API + path, opt).then(function (r) { return r.json().then(function (j) { j.__code = r.status; return j; }, function () { return { __code: r.status }; }); });
  }
  function save() { try { localStorage.setItem(STORE, JSON.stringify(id)); } catch (e) {} }

  // ---------------------------------------------------------------- boot
  function boot() {
    Promise.all([api("/api/base/catalog"), api("/api/base/hello", { pid: id && id.pid, key: id && id.key, game: GAME })]).then(function (r) {
      catalog = r[0]; var h = r[1];
      if (!h || !h.pid) return;
      id = { pid: h.pid, key: h.key }; save();
      me = h.me;
      rules = (catalog.badges || []).filter(function (b) { return b.game === GAME && (b.ev || b.prefix); });
      log("ready", GAME, id.pid, me);
      ui();
      render();
    }).catch(function (e) { log("offline", e); });
  }

  // ---------------------------------------------------------------- events from the game
  function relevant(name) {
    for (var i = 0; i < rules.length; i++) { var r = rules[i]; if (r.ev ? r.ev === name : name.indexOf(r.prefix) === 0) return true; }
    return false;
  }
  function hookEvents() {
    var tries = 0;
    (function wait() {
      if (typeof window.__ev !== "function") { if (tries++ < 100) setTimeout(wait, 200); return; }
      var orig = window.__ev;
      window.__ev = function (name, value) {
        try {
          var n = String(name).toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 40);
          if (rules.length && relevant(n)) { queue.push([n, Math.round(Number(value) || 0)]); if (queue.length >= 20) flush(); }
        } catch (e) {}
        return orig.apply(this, arguments);
      };
    })();
    setInterval(flush, 4000);
  }
  function flush() {
    if (!queue.length || !id) return;
    var e = queue.splice(0, 60);
    api("/api/base/ev", { pid: id.pid, key: id.key, game: GAME, e: e }).then(function (r) {
      if (r && r.earned && r.earned.length) {
        r.earned.forEach(function (bid) { if (me && me.earned.indexOf(bid) < 0) me.earned.push(bid); toast(bid); });
        refresh();
      }
    }).catch(function () { queue = e.concat(queue).slice(0, 200); });
  }
  function refresh() { if (!id) return; api("/api/base/me?pid=" + id.pid + "&key=" + id.key).then(function (r) { if (r && r.earned) { me = r; render(); } }); }

  // the badge button stays out of the way while a run / match / race is going
  function hookGameplay() {
    var tries = 0;
    (function wait() {
      var sd = window.SD, lb = window.orbytLB;
      if (sd && sd.gameplay) {
        var g = sd.gameplay;
        sd.gameplay = function (on) { playing = !!on; vis(); if (!on) flush(); return g.apply(this, arguments); };
        return;
      }
      if (lb && lb.start) {
        var st = lb.start, sub = lb.submit;
        lb.start = function () { playing = true; vis(); return st.apply(this, arguments); };
        if (sub) lb.submit = function () { playing = false; vis(); flush(); return sub.apply(this, arguments); };
        return;
      }
      if (tries++ < 100) setTimeout(wait, 200);
    })();
  }

  // ---------------------------------------------------------------- ui
  var root, launcher, launchCount, panel, toastBox;
  var CSS = [
    ":host{all:initial}",
    "*{box-sizing:border-box;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}",
    ".l{position:fixed;z-index:2147483000;display:flex;align-items:center;gap:8px;padding:8px 14px 8px 10px;border-radius:999px;border:1px solid rgba(230,194,106,.55);background:rgba(10,14,26,.82);color:#f3e7c9;font-weight:800;font-size:13px;letter-spacing:.06em;cursor:pointer;backdrop-filter:blur(6px);box-shadow:0 6px 18px rgba(0,0,0,.35);transition:opacity .25s,transform .25s;user-select:none;-webkit-tap-highlight-color:transparent}",
    ".l:hover{transform:translateY(-1px)}.l.hide{opacity:0;pointer-events:none;transform:translateY(6px)}",
    ".l b{background:#e6c26a;color:#1a1206;border-radius:999px;padding:1px 7px;font-size:12px}",
    ".bl{left:calc(12px + env(safe-area-inset-left));bottom:calc(12px + env(safe-area-inset-bottom))}.br{right:calc(12px + env(safe-area-inset-right));bottom:calc(12px + env(safe-area-inset-bottom))}",
    ".tl{left:calc(12px + env(safe-area-inset-left));top:calc(12px + env(safe-area-inset-top))}.tr{right:calc(12px + env(safe-area-inset-right));top:calc(12px + env(safe-area-inset-top))}",
    ".t{position:fixed;z-index:2147483001;left:50%;top:calc(14px + env(safe-area-inset-top));transform:translate(-50%,-140%);display:flex;align-items:center;gap:12px;padding:10px 18px 10px 10px;border-radius:16px;background:rgba(10,14,26,.92);border:1px solid rgba(230,194,106,.6);color:#fff;box-shadow:0 10px 30px rgba(0,0,0,.45);transition:transform .45s cubic-bezier(.2,1.4,.4,1),opacity .3s,visibility 0s .45s;pointer-events:none;max-width:92vw;opacity:0;visibility:hidden}",
    ".t.on{transform:translate(-50%,0);opacity:1;visibility:visible;transition:transform .45s cubic-bezier(.2,1.4,.4,1),opacity .2s}.t img{width:52px;height:52px;border-radius:12px}.t small{display:block;color:#e6c26a;font-size:11px;font-weight:900;letter-spacing:.12em}.t span{font-size:17px;font-weight:900}.t i{display:block;font-style:normal;font-size:12px;color:rgba(243,231,201,.7);margin-top:2px}",
    ".bg{position:fixed;inset:0;z-index:2147483002;background:rgba(3,6,14,.62);display:flex;align-items:center;justify-content:center;padding:14px;backdrop-filter:blur(3px)}",
    ".p{width:min(560px,100%);max-height:min(92vh,760px);overflow:auto;background:linear-gradient(180deg,#141b2e,#0b1020);border:1px solid rgba(230,194,106,.45);border-radius:22px;color:#f3e7c9;box-shadow:0 20px 60px rgba(0,0,0,.6);padding:18px 18px 16px}",
    ".h{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}.h div small{display:block;color:#e6c26a;font-weight:900;font-size:11px;letter-spacing:.14em}.h div span{font-size:22px;font-weight:900;color:#fff}",
    ".x{width:36px;height:36px;border-radius:12px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);color:#fff;font-size:18px;cursor:pointer}",
    ".g{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}",
    ".c{position:relative;border-radius:16px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);padding:10px;text-align:center}",
    ".c img{width:92px;height:92px;border-radius:14px;display:block;margin:2px auto 6px}.c.lock img{filter:grayscale(1) brightness(.45)}",
    ".c b{display:block;font-size:14px;color:#fff}.c p{margin:3px 0 7px;font-size:11.5px;line-height:1.3;color:rgba(243,231,201,.72);min-height:30px}",
    ".bar{height:6px;border-radius:9px;background:rgba(255,255,255,.1);overflow:hidden}.bar i{display:block;height:100%;background:linear-gradient(90deg,#e6c26a,#ffe08a)}",
    ".n{font-size:11px;color:rgba(243,231,201,.6);margin-top:4px}",
    ".chip{position:absolute;top:8px;right:8px;font-size:10px;font-weight:900;letter-spacing:.08em;padding:2px 7px;border-radius:999px;background:#2f9a4a;color:#fff}.chip.base{background:#0052ff}",
    ".a{margin-top:14px;padding:14px;border-radius:16px;background:rgba(0,82,255,.08);border:1px solid rgba(0,82,255,.35)}",
    ".a p{margin:0 0 10px;font-size:13px;line-height:1.45;color:rgba(243,231,201,.85)}",
    ".sib{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;height:48px;border:0;border-radius:12px;background:#0000ff;color:#fff;font-size:16px;font-weight:800;cursor:pointer}",
    ".sib:disabled{opacity:.45;cursor:default}.sib i{width:18px;height:18px;background:#fff;border-radius:3px;display:inline-block}",
    ".col{display:block;width:100%;height:46px;border:0;border-radius:12px;background:#e6c26a;color:#1a1206;font-size:15px;font-weight:900;cursor:pointer;margin-top:8px}",
    ".age{display:flex;gap:8px;align-items:center;font-size:12.5px;margin:0 0 10px;color:#f3e7c9}.age input{width:18px;height:18px;accent-color:#0052ff}",
    ".err{color:#ff8a8a;font-size:12.5px;margin-top:8px;min-height:1em}.ok{color:#7cff8a}",
    ".row{display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:13px}.row a,.lk{color:#9ec1ff;text-decoration:none;font-weight:700;cursor:pointer;background:none;border:0;font-size:12.5px;padding:0}",
    ".sec{margin:14px 0 6px;font-size:11px;font-weight:900;letter-spacing:.14em;color:#e6c26a}",
    ".gh{display:flex;align-items:center;justify-content:space-between;margin:16px 0 8px}.gh span{font-weight:900;color:#fff}.gh a{color:#9ec1ff;font-size:12px;font-weight:800;text-decoration:none}",
    ".hub{color:#f3e7c9}.hs{padding:16px;border-radius:18px;background:rgba(255,255,255,.04);border:1px solid rgba(230,194,106,.3)}.hs small{display:block;color:#e6c26a;font-weight:900;font-size:11px;letter-spacing:.14em}.hs span{display:block;font-size:26px;font-weight:900;color:#fff;margin:2px 0 10px}.hs .bar{height:8px}",
    ".gh span i{display:inline-block;width:10px;height:10px;border-radius:3px;background:var(--gc,#e6c26a);margin-right:8px}.gh em{font-style:normal;font-weight:700;color:rgba(243,231,201,.55);font-size:12px;margin-left:6px}",
    "@media (max-width:420px){.g{grid-template-columns:repeat(2,1fr)}.c img{width:76px;height:76px}}",
  ].join("");

  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  var MEDAL = '<svg width="18" height="18" viewBox="0 0 24 24"><path d="M7 2h4l1 5-3 3zM17 2h-4l-1 5 3 3z" fill="#e6c26a" opacity=".8"/><circle cx="12" cy="15" r="6.5" fill="#e6c26a"/><circle cx="12" cy="15" r="4" fill="#1a1206" opacity=".25"/></svg>';

  function ui() {
    if (root) return;
    var holder = document.createElement("div");
    holder.id = "mello-base";
    document.body.appendChild(holder);
    root = holder.attachShadow ? holder.attachShadow({ mode: "open" }) : holder;
    root.appendChild(el("style", null, CSS));
    toastBox = el("div", "t"); root.appendChild(toastBox);
    if (HUB_MODE) return;
    launcher = el("div", "l " + CORNER, MEDAL + "<span>BADGES</span>");
    launchCount = el("b"); launcher.appendChild(launchCount);
    launcher.addEventListener("click", function (e) { e.stopPropagation(); open(); });
    ["pointerdown", "touchstart", "mousedown"].forEach(function (t) { launcher.addEventListener(t, function (e) { e.stopPropagation(); }); });
    root.appendChild(launcher);
    vis();
  }
  function vis() { if (launcher) launcher.classList.toggle("hide", (playing && !ALWAYS) || !!panel); }

  function badgesFor(game) { return (catalog && catalog.badges || []).filter(function (b) { return b.game === game; }); }
  function img(bid) { return API + "/api/base/badge/" + bid + ".svg"; }
  function earned(bid) { return !!(me && me.earned.indexOf(bid) >= 0); }
  function claimed(bid) { return !!(me && me.claimed && (bid in me.claimed)); }

  function render() {
    if (launchCount) {
      var mine = badgesFor(GAME), n = mine.filter(function (b) { return earned(b.id); }).length;
      launchCount.textContent = n + "/" + mine.length;
    }
    if (panel) fillPanel();
    if (HUB_MODE && window.__melloHubRender) window.__melloHubRender();
  }

  function toast(bid) {
    var b = (catalog.badges || []).filter(function (x) { return x.id === bid; })[0];
    if (!b || !toastBox) return;
    var signedIn = me && me.address;
    toastBox.innerHTML = '<img src="' + img(bid) + '"><div><small>BADGE UNLOCKED</small><span>' + esc(b.name) + "</span><i>" +
      (signedIn ? (me.mintOpen ? "Collect it on Base from the Badges menu" : "Saved to your Base account") : "Sign in with Base to collect it") + "</i></div>";
    toastBox.classList.add("on");
    try { navigator.vibrate && navigator.vibrate(40); } catch (e) {}
    clearTimeout(toast.t); toast.t = setTimeout(function () { toastBox.classList.remove("on"); }, 4200);
  }

  // ---------------------------------------------------------------- panel
  function open() {
    if (panel) return;
    panel = el("div", "bg");
    panel.addEventListener("click", function (e) { if (e.target === panel) close(); });
    ["pointerdown", "touchstart", "mousedown", "keydown", "wheel"].forEach(function (t) { panel.addEventListener(t, function (e) { e.stopPropagation(); }); });
    root.appendChild(panel);
    vis(); fillPanel(); refresh();
    if (me && !me.address) prepareSignIn();
    track("base_panel");
  }
  function close() { if (panel) panel.remove(); panel = null; vis(); }

  function cards(list) {
    return list.map(function (b) {
      var have = earned(b.id), got = claimed(b.id);
      var cur = Math.min(b.goal, (me && me.progress && me.progress[b.id]) || (have ? b.goal : 0));
      var pct = Math.round(100 * (have ? 1 : cur / b.goal));
      return '<div class="c' + (have ? "" : " lock") + '">' + (got ? '<span class="chip base">ON BASE</span>' : have ? '<span class="chip">EARNED</span>' : "") +
        '<img src="' + img(b.id) + '" alt=""><b>' + esc(b.name) + "</b><p>" + esc(b.desc) + '</p><div class="bar"><i style="width:' + pct + '%"></i></div>' +
        '<div class="n">' + (have ? "Unlocked" : (b.goal > 1 ? cur + " / " + b.goal : "Locked")) + "</div></div>";
    }).join("");
  }

  function account() {
    var unclaimed = me ? me.earned.filter(function (bid) { return !claimed(bid); }).length : 0;
    if (!me || !me.address) {
      return '<div class="a"><p><b>Collect your badges on Base.</b> Free, soulbound collectibles that live in your own wallet, across every Mello game. ' +
        "Sign in with a Base Account: a passkey, no seed phrase, no app to install. No purchases and no fees, ever.</p>" +
        '<label class="age"><input type="checkbox" id="age"' + (ageOk ? " checked" : "") + '> I\'m 18 or older</label>' +
        '<button class="sib" id="sib" disabled><i></i>Sign in with Base</button><div class="err" id="err"></div></div>';
    }
    var short = me.address.slice(0, 6) + "…" + me.address.slice(-4);
    var action = me.mintOpen
      ? (unclaimed ? '<button class="col" id="col">Collect ' + unclaimed + " badge" + (unclaimed === 1 ? "" : "s") + " on Base</button>" : '<p class="ok" style="margin:8px 0 0">Every badge you\'ve earned is on Base.</p>')
      : '<p style="margin:8px 0 0">Your badges are saved to this account. Minting on Base opens soon.</p>';
    return '<div class="a"><div class="row"><span>Signed in as <b>' + short + '</b></span><button class="lk" id="out">Sign out</button></div>' + action +
      '<div class="err" id="err"></div><div class="row" style="margin-top:10px"><a href="' + HUB + '" target="_blank" rel="noopener">All your badges across our games &rarr;</a></div></div>';
  }

  function fillPanel() {
    if (!panel || !catalog) return;
    var g = (catalog.games || {})[GAME] || { name: "Mello" };
    panel.innerHTML = '<div class="p"><div class="h"><div><small>BADGES</small><span>' + esc(g.name) + '</span></div><button class="x" id="x">&times;</button></div>' +
      '<div class="g">' + cards(badgesFor(GAME)) + '</div><div class="sec">ACROSS THE ARCADE</div><div class="g">' + cards(badgesFor("arcade")) + "</div>" + account() + "</div>";
    wire(panel);
  }

  function wire(scope) {
    var x = scope.querySelector("#x"); if (x) x.onclick = close;
    var age = scope.querySelector("#age"), sib = scope.querySelector("#sib");
    if (age && sib) {
      var ready = function () { sib.disabled = !(ageOk && nonce && SDK()) || busy; };
      age.onchange = function () { ageOk = age.checked; ready(); }; ready(); prepareSignIn(ready);
      sib.onclick = function () { signIn(scope); };
    }
    var col = scope.querySelector("#col"); if (col) col.onclick = function () { collect(scope); };
    var out = scope.querySelector("#out"); if (out) out.onclick = function () { api("/api/base/unlink", { pid: id.pid, key: id.key }).then(function (r) { if (r.earned) { me = r; render(); } }); };
  }

  // The wallet popup must open straight from the tap, so the SDK and a fresh nonce are fetched beforehand.
  function prepareSignIn(cb) {
    if (!SDK()) {
      if (!prepareSignIn.loading) {
        prepareSignIn.loading = true;
        var s = document.createElement("script"); s.src = SDK_URL; s.async = true;
        s.onload = function () { cb && cb(); render(); };
        s.onerror = function () { prepareSignIn.loading = false; showErr("Couldn't load Base sign-in. Check your connection."); };
        document.head.appendChild(s);
      }
    }
    if (!nonce) api("/api/base/nonce").then(function (r) { nonce = r.nonce; cb && cb(); render(); });
  }

  function showErr(m) { var e = root && root.querySelector("#err"); if (e) e.textContent = m || ""; }

  function signIn(scope) {
    if (busy || !nonce) return;
    busy = true;
    var n = nonce; nonce = null;
    try {
      if (!sdk) {
        var g = (catalog.games || {})[GAME];
        sdk = SDK()({ appName: g ? g.name : "Orbyt Arcade", appLogoUrl: location.origin + "/icon-192.png" });
      }
      var provider = sdk.getProvider();
      provider.request({ method: "wallet_connect", params: [{ version: "1", capabilities: { signInWithEthereum: { nonce: n, chainId: "0x2105" } } }] }).then(function (res) {
        var acc = res.accounts[0], siwe = acc.capabilities && acc.capabilities.signInWithEthereum;
        if (!siwe) throw new Error("This wallet didn't return a sign-in message.");
        return api("/api/base/link", { pid: id.pid, key: id.key, message: siwe.message, signature: siwe.signature });
      }).then(function (r) {
        busy = false;
        if (r.__code !== 200) { showErr(r.error || "Sign-in failed. Please try again."); prepareSignIn(); return; }
        me = r; render(); track("base_signin");
      }, function (e) {
        busy = false; prepareSignIn();
        var m = String(e && (e.message || e)) || "";
        showErr(/reject|denied|cancel|closed/i.test(m) ? "" : "Sign-in failed: " + m.slice(0, 120));
        render();
      });
    } catch (e) { busy = false; showErr("Sign-in failed: " + e.message); prepareSignIn(); }
  }

  function collect(scope) {
    if (busy) return;
    busy = true;
    var b = scope.querySelector("#col"); if (b) { b.disabled = true; b.textContent = "Minting on Base..."; }
    api("/api/base/claim", { pid: id.pid, key: id.key }).then(function (r) {
      busy = false;
      if (r.me) me = r.me;
      render();
      if (r.tx) { track("base_claim", (r.ids || []).length); showErr(""); var e = root.querySelector("#err"); if (e) { e.className = "err ok"; e.innerHTML = 'Minted! <a class="lk" target="_blank" rel="noopener" href="https://' + (r.chain === "Base Sepolia" ? "sepolia." : "") + 'basescan.org/tx/' + r.tx + '">View on Basescan</a>'; } }
      else if (r.__code !== 200) showErr(r.error || "Couldn't mint right now. Try again in a moment.");
    }, function () { busy = false; showErr("Couldn't reach the server."); render(); });
  }

  function track(n, v) { try { window.__ev && window.__ev(n, v || 0); } catch (e) {} }

  // ---------------------------------------------------------------- hub (orbyt-arcade) uses the same engine
  window.MelloBase = {
    game: GAME, open: open,
    state: function () { return { id: id, me: me, catalog: catalog }; },
    mount: function (elm) {
      // full collection: every game's badges, plus the account box
      window.__melloHubRender = function () {
        if (!catalog) return;
        var games = catalog.games || {}, all = catalog.badges || [];
        var got = all.filter(function (b) { return earned(b.id); }).length;
        var html = '<div class="hs"><div><small>YOUR COLLECTION</small><span>' + got + " / " + all.length + ' badges</span></div><div class="bar"><i style="width:' + Math.round(100 * got / Math.max(1, all.length)) + '%"></i></div></div>';
        html += account();
        html += '<div class="gh"><span>ACROSS THE ARCADE</span></div><div class="g">' + cards(badgesFor("arcade")) + "</div>";
        Object.keys(games).forEach(function (k) {
          var mine = badgesFor(k), n = mine.filter(function (b) { return earned(b.id); }).length;
          html += '<div class="gh" style="--gc:' + games[k].col + '"><span><i></i>' + esc(games[k].name) + " <em>" + n + "/" + mine.length + '</em></span><a href="' + games[k].url + '" target="_blank" rel="noopener">PLAY &rarr;</a></div><div class="g">' + cards(mine) + "</div>";
        });
        var box = el("div", "hub");
        box.innerHTML = html;
        var sr = elm.shadowRoot || elm.attachShadow({ mode: "open" });
        sr.innerHTML = "<style>" + CSS + "</style>";
        sr.appendChild(box);
        root = sr; wire(sr);
      };
      if (catalog) window.__melloHubRender();
      if (me && !me.address) prepareSignIn(function () { window.__melloHubRender(); });
    },
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
  function start() { hookEvents(); hookGameplay(); setTimeout(boot, HUB_MODE ? 0 : 2500); }
})();
