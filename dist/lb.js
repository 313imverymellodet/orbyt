// ORBYT live leaderboard: talks to the Railway service, renders an overlay, streams updates over WebSocket.
(function () {
  var API = "https://orbyt-api-production-29f6.up.railway.app";
  var WS = API.replace(/^http/, "ws") + "/live";
  var LS = window.localStorage;
  var token = null, runMode = "endless", ws = null, openMode = null, online = 0, meName = null;

  function store(k, v) { try { if (v === undefined) return LS.getItem(k); LS.setItem(k, v); } catch (e) { return null; } }
  function playerId() {
    var id = store("orbyt_player");
    if (!id) { id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)); store("orbyt_player", id); }
    return id;
  }
  meName = store("orbyt_name");
  function toUnity(method, payload) { try { window.orbyt && window.orbyt.SendMessage("Game", method, JSON.stringify(payload)); } catch (e) {} }
  function post(path, body) {
    return fetch(API + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) }).then(function (r) { return r.json(); });
  }

  // ---------------------------------------------------------------- styles + DOM
  var css = document.createElement("style");
  css.textContent = [
    "#lb{position:fixed;inset:0;z-index:20;display:none;align-items:center;justify-content:center;background:rgba(6,3,20,.72);backdrop-filter:blur(3px);font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}",
    "#lb.on{display:flex}",
    "#lb .card{width:min(420px,92vw);max-height:84vh;display:flex;flex-direction:column;background:#140c33;border:1px solid rgba(255,255,255,.12);border-radius:22px;box-shadow:0 20px 60px rgba(0,0,0,.5);color:#fff;overflow:hidden;animation:lbin .25s ease}",
    "@keyframes lbin{from{transform:scale(.9);opacity:0}}",
    "#lb .hd{padding:18px 18px 10px;display:flex;align-items:center;justify-content:space-between}",
    "#lb h2{margin:0;font-size:22px;font-weight:900;letter-spacing:2px;text-shadow:-2px 0 #25F4EE,2px 0 #FF2E63}",
    "#lb .x{background:rgba(255,255,255,.1);border:0;color:#fff;width:36px;height:36px;border-radius:12px;font-size:18px;cursor:pointer}",
    "#lb .tabs{display:flex;gap:8px;padding:0 18px 10px}",
    "#lb .tab{flex:1;padding:10px;border-radius:12px;border:0;background:rgba(255,255,255,.08);color:#fff;font-weight:800;letter-spacing:1px;cursor:pointer}",
    "#lb .tab.on{background:#25F4EE;color:#0B0620}",
    "#lb .live{padding:0 18px 8px;font-size:12px;opacity:.7;display:flex;align-items:center;gap:6px}",
    "#lb .dot{width:8px;height:8px;border-radius:50%;background:#7CFF6B;box-shadow:0 0 8px #7CFF6B;animation:pulse 1.4s infinite}",
    "@keyframes pulse{50%{opacity:.35}}",
    "#lb ol{list-style:none;margin:0;padding:0 10px 14px;overflow:auto}",
    "#lb li{display:flex;align-items:center;gap:10px;padding:10px 10px;border-radius:12px;font-weight:700}",
    "#lb li:nth-child(odd){background:rgba(255,255,255,.04)}",
    "#lb li.me{background:rgba(37,244,238,.18);outline:1px solid rgba(37,244,238,.5)}",
    "#lb li.flash{animation:flash 1.2s ease}",
    "@keyframes flash{0%{background:rgba(255,212,71,.6)}}",
    "#lb .rk{width:34px;text-align:center;font-weight:900;opacity:.8}",
    "#lb li:nth-child(1) .rk{color:#FFD447;opacity:1}#lb li:nth-child(2) .rk{color:#D9E2F2;opacity:1}#lb li:nth-child(3) .rk{color:#FF9A5C;opacity:1}",
    "#lb .nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    "#lb .sc{font-weight:900;font-size:18px}",
    "#lb .empty{padding:30px;text-align:center;opacity:.6}",
    "#lbname{position:fixed;inset:0;z-index:21;display:none;align-items:center;justify-content:center;background:rgba(6,3,20,.78);font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}",
    "#lbname.on{display:flex}",
    "#lbname .card{width:min(360px,90vw);background:#140c33;border-radius:22px;padding:22px;color:#fff;text-align:center;border:1px solid rgba(255,255,255,.12);animation:lbin .25s ease}",
    "#lbname h3{margin:0 0 6px;font-size:22px;font-weight:900}",
    "#lbname p{margin:0 0 14px;opacity:.7;font-size:14px}",
    "#lbname input{width:100%;box-sizing:border-box;padding:14px;border-radius:14px;border:2px solid rgba(37,244,238,.5);background:#0B0620;color:#fff;font-size:20px;font-weight:800;text-align:center;letter-spacing:2px;text-transform:uppercase;outline:none}",
    "#lbname .row{display:flex;gap:10px;margin-top:14px}",
    "#lbname button{flex:1;padding:14px;border-radius:14px;border:0;font-weight:900;font-size:16px;cursor:pointer}",
    "#lbname .ok{background:#25F4EE;color:#0B0620}#lbname .skip{background:rgba(255,255,255,.1);color:#fff}",
    "#lbname .err{color:#FF6B8A;font-size:13px;min-height:18px;margin-top:8px}"
  ].join("\n");
  document.head.appendChild(css);

  var lb = document.createElement("div"); lb.id = "lb";
  lb.innerHTML = '<div class="card"><div class="hd"><h2>LEADERBOARD</h2><button class="x" aria-label="Close">&#10005;</button></div>' +
    '<div class="tabs"><button class="tab" data-m="daily">DAILY</button><button class="tab" data-m="endless">ALL-TIME</button></div>' +
    '<div class="live"><span class="dot"></span><span class="on">LIVE</span></div><ol></ol></div>';
  document.body.appendChild(lb);
  var list = lb.querySelector("ol"), liveTxt = lb.querySelector(".live .on");
  lb.querySelector(".x").onclick = close;
  lb.addEventListener("click", function (e) { if (e.target === lb) close(); });
  lb.querySelectorAll(".tab").forEach(function (b) { b.onclick = function () { show(b.getAttribute("data-m")); }; });

  var nm = document.createElement("div"); nm.id = "lbname";
  nm.innerHTML = '<div class="card"><h3>CLAIM YOUR SPOT</h3><p>Pick a name for the leaderboard</p>' +
    '<input maxlength="12" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="YOUR NAME">' +
    '<div class="err"></div><div class="row"><button class="skip">SKIP</button><button class="ok">SUBMIT</button></div></div>';
  document.body.appendChild(nm);
  var nmInput = nm.querySelector("input"), nmErr = nm.querySelector(".err");

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  function render(rows, flashName) {
    if (!rows.length) { list.innerHTML = '<div class="empty">No scores yet. Be the first!</div>'; return; }
    list.innerHTML = rows.map(function (r, i) {
      var me = meName && r.name === meName.toUpperCase();
      return '<li class="' + (me ? "me " : "") + (flashName && r.name === flashName ? "flash" : "") + '"><span class="rk">' + (i + 1) + '</span><span class="nm">' + esc(r.name) + (me ? " (YOU)" : "") + '</span><span class="sc">' + r.score + "</span></li>";
    }).join("");
  }

  function load(mode, flashName) {
    return fetch(API + "/api/board?mode=" + mode + "&limit=30").then(function (r) { return r.json(); })
      .then(function (d) { if (openMode === mode) render(d.top || [], flashName); })
      .catch(function () { list.innerHTML = '<div class="empty">Leaderboard offline. Try again soon.</div>'; });
  }

  function show(mode) {
    openMode = mode === "daily" ? "daily" : "endless";
    lb.querySelectorAll(".tab").forEach(function (b) { b.classList.toggle("on", b.getAttribute("data-m") === openMode); });
    lb.classList.add("on");
    list.innerHTML = '<div class="empty">Loading...</div>';
    connect();
    load(openMode);
    window.orbytTrack && window.orbytTrack("lb_open", 0);
  }
  function close() { lb.classList.remove("on"); openMode = null; }

  // ---------------------------------------------------------------- live feed
  function connect() {
    if (ws && ws.readyState <= 1) return;
    try { ws = new WebSocket(WS); } catch (e) { return; }
    ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type === "online" || m.type === "hello") { online = m.n || m.online || online; liveTxt.textContent = "LIVE · " + online + " watching"; }
      if (m.type === "score" && openMode === m.mode) load(m.mode, m.name);
    };
    ws.onclose = function () { ws = null; if (openMode) setTimeout(connect, 3000); };
  }

  // ---------------------------------------------------------------- run lifecycle (called from Unity)
  window.orbytLB = {
    start: function (mode) {
      runMode = mode; token = null;
      post("/api/run").then(function (d) { token = d.token; }).catch(function () {});
    },
    submit: function (mode, score, perfects, flips) {
      if (!token || score < 1) return;
      var t = token; token = null;
      var send = function (name) {
        post("/api/score", { token: t, player: playerId(), name: name, mode: mode, score: score, perfects: perfects, flips: flips })
          .then(function (r) {
            if (r.error === "bad name") { store("orbyt_name", ""); meName = null; askName(send, "That name isn't allowed. Try another."); return; }
            if (r.error) { toUnity("OnRank", { rank: 0, total: 0, error: r.error }); return; }
            toUnity("OnRank", { rank: r.rank, total: r.total, best: r.best, newBest: r.newBest, mode: mode });
          }).catch(function () { toUnity("OnRank", { rank: 0, total: 0, error: "offline" }); });
      };
      if (meName) send(meName); else askName(send);
    },
    show: show,
    askNameThen: function (cb) { askName(function () { cb(); }, null, cb); }
  };

  function askName(cb, err, onSkip) {
    nmErr.textContent = err || "";
    nmInput.value = meName || "";
    nm.classList.add("on");
    setTimeout(function () { nmInput.focus(); }, 50);
    nm.querySelector(".ok").onclick = function () {
      var v = nmInput.value.toUpperCase().replace(/[^A-Z0-9 _.-]/g, "").trim();
      if (v.length < 2) { nmErr.textContent = "At least 2 letters or numbers."; return; }
      meName = v; store("orbyt_name", v);
      nm.classList.remove("on");
      cb(v);
    };
    nm.querySelector(".skip").onclick = function () { nm.classList.remove("on"); if (onSkip) onSkip(); else toUnity("OnRank", { rank: 0, total: 0, error: "skipped" }); };
    nmInput.onkeydown = function (e) { e.stopPropagation(); if (e.key === "Enter") nm.querySelector(".ok").click(); };
  }
  // keep game keyboard shortcuts (space = tap) from firing while typing
  ["keydown", "keyup", "keypress"].forEach(function (t) { nm.addEventListener(t, function (e) { e.stopPropagation(); }, true); });
})();
