// ORBYT duels: lobby overlay + WebSocket client + ghost playback. Unity only sees OnDuel(json) messages.
(function () {
  var WS_URL = "wss://orbyt-api-production-29f6.up.railway.app/duel";
  var ws = null, mode = null, seed = 0, oppName = "", ghost = null, ghostTimer = null, t0 = 0, myPoints = [], iWasAlive = false;

  function toUnity(msg) { try { window.orbyt && window.orbyt.SendMessage("Game", "OnDuel", JSON.stringify(msg)); } catch (e) {} }
  function myName() { try { return localStorage.getItem("orbyt_name") || ""; } catch (e) { return ""; } }
  function sendWs(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }

  // ---------------------------------------------------------------- overlay
  var css = document.createElement("style");
  css.textContent = [
    "#duel{position:fixed;inset:0;z-index:20;display:none;align-items:center;justify-content:center;background:rgba(6,3,20,.78);backdrop-filter:blur(3px);font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#fff}",
    "#duel.on{display:flex}",
    "#duel .card{width:min(400px,92vw);background:#140c33;border:1px solid rgba(255,255,255,.12);border-radius:24px;padding:22px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.5);animation:dIn .25s ease}",
    "@keyframes dIn{from{transform:scale(.9);opacity:0}}",
    "#duel h2{margin:0 0 4px;font-size:30px;font-weight:900;letter-spacing:3px;text-shadow:-2px 0 #25F4EE,2px 0 #FF4FD8}",
    "#duel .sub{opacity:.7;font-size:14px;margin-bottom:18px}",
    "#duel button{width:100%;padding:16px;margin:6px 0;border-radius:16px;border:0;font-weight:900;font-size:17px;letter-spacing:1px;cursor:pointer}",
    "#duel .p{background:#25F4EE;color:#0B0620}#duel .s{background:rgba(255,255,255,.1);color:#fff}#duel .m{background:#FF4FD8;color:#0B0620}",
    "#duel input{width:100%;box-sizing:border-box;padding:14px;margin:6px 0;border-radius:14px;border:2px solid rgba(255,79,216,.55);background:#0B0620;color:#fff;font-size:26px;font-weight:900;text-align:center;letter-spacing:8px;text-transform:uppercase;outline:none}",
    "#duel .code{font-size:52px;font-weight:900;letter-spacing:10px;margin:8px 0 4px;color:#FF4FD8;text-shadow:0 0 24px rgba(255,79,216,.5)}",
    "#duel .spin{width:46px;height:46px;margin:18px auto;border-radius:50%;border:4px solid rgba(255,255,255,.15);border-top-color:#25F4EE;animation:sp .8s linear infinite}",
    "@keyframes sp{to{transform:rotate(360deg)}}",
    "#duel .err{color:#FF6B8A;min-height:18px;font-size:13px}"
  ].join("\n");
  document.head.appendChild(css);
  var box = document.createElement("div"); box.id = "duel";
  box.innerHTML = '<div class="card"></div>';
  document.body.appendChild(box);
  var card = box.querySelector(".card");
  ["keydown", "keyup", "keypress"].forEach(function (t) { box.addEventListener(t, function (e) { e.stopPropagation(); }, true); });

  function view(html) { card.innerHTML = html; box.classList.add("on"); }
  function hide() { box.classList.remove("on"); }

  function home(err) {
    view('<h2>DUEL</h2><div class="sub">Same course. Live rival. Winner takes bragging rights.</div>' +
      '<button class="p" data-a="quick">QUICK MATCH</button>' +
      '<button class="m" data-a="create">CREATE ROOM</button>' +
      '<input maxlength="4" placeholder="CODE" autocomplete="off" autocapitalize="characters" spellcheck="false">' +
      '<button class="s" data-a="join">JOIN WITH CODE</button>' +
      '<div class="err">' + (err || "") + '</div><button class="s" data-a="close">BACK</button>');
    bind();
  }

  function bind() {
    card.querySelectorAll("button[data-a]").forEach(function (b) {
      b.onclick = function () {
        var a = b.getAttribute("data-a");
        if (a === "close") { cancel(); hide(); }
        if (a === "quick") connect(function () { sendWs({ t: "quick" }); searching(); });
        if (a === "create") connect(function () { sendWs({ t: "create" }); });
        if (a === "join") {
          var code = (card.querySelector("input").value || "").toUpperCase().replace(/[^A-Z]/g, "");
          if (code.length !== 4) { card.querySelector(".err").textContent = "Codes are 4 letters."; return; }
          connect(function () { sendWs({ t: "join", code: code }); view('<h2>JOINING</h2><div class="spin"></div>'); });
        }
        if (a === "cancel") { cancel(); home(); }
        if (a === "invite") invite(b.getAttribute("data-code"));
      };
    });
  }

  function searching() {
    view('<h2>SEARCHING</h2><div class="sub">Finding a rival... if nobody is around, you will race a ghost of a real run.</div><div class="spin"></div><button class="s" data-a="cancel">CANCEL</button>');
    bind();
  }

  function invite(code) {
    var url = location.origin + location.pathname + "?duel=" + code;
    var text = "Race me in ORBYT — room " + code;
    if (navigator.share) navigator.share({ title: "ORBYT DUEL", text: text, url: url }).catch(function () {});
    else if (navigator.clipboard) navigator.clipboard.writeText(text + "\n" + url).then(function () { window.orbytToast && window.orbytToast("Invite link copied!"); });
  }

  function cancel() { sendWs({ t: "cancel" }); stopGhost(); mode = null; }

  // ---------------------------------------------------------------- socket
  function connect(then) {
    if (ws && ws.readyState === 1) { then(); return; }
    if (ws && ws.readyState === 0) { ws.addEventListener("open", then, { once: true }); return; }
    ws = new WebSocket(WS_URL);
    ws.onopen = function () { sendWs({ t: "hello", name: myName() || "PLAYER" }); then(); };
    ws.onclose = function () { ws = null; if (mode === "live") { toUnity({ t: "left" }); mode = null; } };
    ws.onerror = function () { home("Can't reach the duel server. Try again."); };
    ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      switch (m.t) {
        case "room":
          view('<h2>ROOM</h2><div class="sub">Send this code to a friend</div><div class="code">' + m.code + '</div>' +
            '<button class="m" data-a="invite" data-code="' + m.code + '">SHARE INVITE</button><div class="spin"></div><button class="s" data-a="cancel">CANCEL</button>');
          bind(); break;
        case "queued": searching(); break;
        case "error": home(m.msg); break;
        case "start":
          mode = "live"; seed = m.seed; oppName = m.opp; begin(false); break;
        case "ghost":
          mode = "ghost"; seed = m.seed; oppName = m.name; ghost = m; begin(true); break;
        case "opp": toUnity({ t: "opp", score: m.score, progress: m.progress, lane: m.lane }); break;
        case "oppDead": toUnity({ t: "oppDead", score: m.score }); break;
        case "end": toUnity({ t: "end", result: m.result, you: m.you, oppScore: m.opp }); break;
        case "left": toUnity({ t: "left" }); break;
        case "rematchAsk": toUnity({ t: "rematchAsk" }); break;
      }
    };
  }

  function begin(isGhost) {
    hide();
    myPoints = []; t0 = performance.now(); iWasAlive = true;
    toUnity({ t: "start", seed: seed, opp: oppName, ghost: isGhost, bot: !!(ghost && ghost.bot) });
    window.orbytTrack && window.orbytTrack(isGhost ? "duel_ghost" : "duel_live", 0);
    if (isGhost) playGhost();
  }

  // ---------------------------------------------------------------- ghost playback
  function playGhost() {
    stopGhost();
    var pts = ghost.points, i = 0, dead = false, start = performance.now();
    ghostTimer = setInterval(function () {
      var t = (performance.now() - start) / 1000;
      while (i < pts.length - 1 && pts[i + 1][0] <= t) i++;
      var p = pts[i];
      if (!dead) toUnity({ t: "opp", score: p[1], progress: p[2], lane: p[3] });
      if (!dead && t > pts[pts.length - 1][0]) { dead = true; toUnity({ t: "oppDead", score: ghost.final }); }
    }, 100);
  }
  function stopGhost() { if (ghostTimer) clearInterval(ghostTimer); ghostTimer = null; }

  function ghostResult(myScore) {
    stopGhost();
    var r = myScore > ghost.final ? "win" : myScore === ghost.final ? "draw" : "lose";
    toUnity({ t: "end", result: r, you: myScore, oppScore: ghost.final });
  }

  // ---------------------------------------------------------------- called from Unity
  window.orbytDuel = {
    open: function () { if (!myName()) { window.orbytLB && window.orbytLB.askNameThen ? window.orbytLB.askNameThen(function () { home(); }) : home(); } else home(); },
    state: function (score, progress, lane) {
      var t = (performance.now() - t0) / 1000;
      if (myPoints.length < 2400) myPoints.push([+t.toFixed(2), score, +progress.toFixed(2), lane]);
      if (mode === "live") sendWs({ t: "state", score: score, progress: progress, lane: lane });
    },
    dead: function (score) {
      iWasAlive = false;
      sendWs({ t: "timeline", seed: seed, points: myPoints, final: score });
      if (mode === "live") sendWs({ t: "dead", score: score });
      else if (mode === "ghost") ghostResult(score);
    },
    passed: function (score) {
      if (mode === "live") sendWs({ t: "passed", score: score });
      else if (mode === "ghost") { sendWs({ t: "timeline", seed: seed, points: myPoints, final: score }); ghostResult(score); }
    },
    rematch: function () {
      if (mode === "live") sendWs({ t: "rematch" });
      else if (mode === "ghost") { connect(function () { sendWs({ t: "quick" }); searching(); }); }
    },
    leave: function () { cancel(); }
  };

  // invite links: ?duel=ABCD auto-joins once the game is up
  var inviteCode = (new URLSearchParams(location.search).get("duel") || "").toUpperCase().replace(/[^A-Z]/g, "");
  if (inviteCode.length === 4) {
    var tryJoin = function () {
      if (!window.orbyt) return setTimeout(tryJoin, 500);
      setTimeout(function () {
        view('<h2>JOINING ' + inviteCode + '</h2><div class="spin"></div>');
        connect(function () { sendWs({ t: "join", code: inviteCode }); });
      }, 1200);
    };
    tryJoin();
  }
})();
