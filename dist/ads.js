/* MelloAds: one ad layer for every Mello game page.
 *
 * Where the page runs decides the network:
 *   window.PORTAL = "crazygames" | "poki" | "gd"  (set by tools/portals.mjs in portal builds)  -> that portal's SDK
 *   our own site (play.mellovibes.io and its game subdomains)                                -> Google H5 Games Ads (adBreak)
 *   anywhere else (vercel.app previews, localhost)                                          -> no ads (add ?adtest=1 on localhost for Google test ads)
 *
 * What it does:
 *   - interstitials at natural breaks: when a new run starts after a game over / results screen
 *     (never the session's first run, never twice inside MIN_GAP), rate limits on top of each network's own
 *   - rewarded ads for the games' "watch an ad" offers
 *   - freezes the Unity main loop and mutes its audio for the length of every ad, then hands control back
 *
 * Pages keep their own window.SD adapter; this file upgrades it in place, so it must load after that
 * adapter and before the Unity loader script.
 */
(function () {
  "use strict";
  // ---- config -------------------------------------------------------------------------------
  var GOOGLE_CLIENT = "";                         // AdSense publisher id, e.g. "ca-pub-1234567890123456". Empty = Google ads off.
  var OWN_HOSTS = /(^|\.)mellovibes\.io$/;        // the only hosts Google ads may serve on (AdSense-approved domain)
  var MIN_GAP = { poki: 0, crazygames: 60e3, gd: 90e3, web: 150e3 };   // ms between interstitials (Poki paces itself)
  var MIN_BREAK = 2500;                           // the player has to be out of gameplay this long (skips pause/unpause)

  var host = location.hostname, q = location.search;
  var P = window.PORTAL || "web";
  var adtest = /[?&]adtest=1/.test(q) && (host === "localhost" || host === "127.0.0.1");
  if (adtest && !GOOGLE_CLIENT) GOOGLE_CLIENT = (q.match(/[?&]adclient=(ca-pub-\d+)/) || [])[1] || "";   // localhost testing only
  var googleOn = P === "web" && !!GOOGLE_CLIENT && (OWN_HOSTS.test(host) || adtest);
  var dbg = /[?&]addebug=1/.test(q);
  var log = function () { if (dbg) try { console.log.apply(console, ["[ads]"].concat([].slice.call(arguments))); } catch (e) {} };
  var track = function (n, v) { try { window.SD && window.SD.track ? window.SD.track(n, v || 0) : window.orbytTrack && window.orbytTrack(n, v || 0); } catch (e) {} };

  // ---- freeze / mute: pause Unity's main loop and every AudioContext it opens -----------------
  var ctxs = [];
  var AC = window.AudioContext || window.webkitAudioContext;
  if (AC && !AC.__mello) {
    var Wrapped = function (a) { var c = a === undefined ? new AC() : new AC(a); ctxs.push(c); return c; };
    Wrapped.prototype = AC.prototype; Wrapped.__mello = true;
    window.AudioContext = Wrapped;
    if (window.webkitAudioContext) window.webkitAudioContext = Wrapped;
  }
  var frozen = false;
  function module() { var u = window.unityInstance || window.orbyt; return u && u.Module; }
  function freeze() {
    if (frozen) return; frozen = true; log("freeze");
    try { var m = module(); m && m.pauseMainLoop && m.pauseMainLoop(); } catch (e) {}
    ctxs.forEach(function (c) {
      try { c.__resume = c.__resume || c.resume; c.resume = function () { return Promise.resolve(); }; c.suspend(); } catch (e) {}
    });
  }
  function unfreeze() {
    if (!frozen) return; frozen = false; log("unfreeze");
    ctxs.forEach(function (c) { try { if (c.__resume) { c.resume = c.__resume; c.resume(); } } catch (e) {} });
    try { var m = module(); m && m.resumeMainLoop && m.resumeMainLoop(); } catch (e) {}
  }
  // live multiplayer (brawls, races, kitchens, duels): never freeze a player mid-match, so no interstitials
  // while any game-server socket is open
  var sockets = [];
  var WS = window.WebSocket;
  if (WS && !WS.__mello) {
    var WrappedWS = function (u, p) { var w = p === undefined ? new WS(u) : new WS(u, p); sockets.push(w); return w; };
    WrappedWS.prototype = WS.prototype; WrappedWS.__mello = true;
    WrappedWS.CONNECTING = 0; WrappedWS.OPEN = 1; WrappedWS.CLOSING = 2; WrappedWS.CLOSED = 3;
    window.WebSocket = WrappedWS;
  }
  function online() { sockets = sockets.filter(function (w) { return w.readyState < 2; }); return sockets.length > 0; }

  // an SDK that never calls back must not leave the game frozen
  function guard(p, ms, fallback) {
    return Promise.race([p, new Promise(function (r) { setTimeout(function () { r(fallback); }, ms); })]).then(function (v) { unfreeze(); return v; });
  }

  // ---- networks -----------------------------------------------------------------------------
  var poki = function () { return P === "poki" && window.PokiSDK; };
  var crazy = function () { return P === "crazygames" && window.CrazyGames && window.CrazyGames.SDK; };
  var gd = function () { return P === "gd" && window.gdsdk; };

  // GameDistribution pauses/resumes the game itself around its ads
  var gdReward = false;
  var prevGd = window.__gdEvent;
  window.__gdEvent = function (e) {
    if (e.name === "SDK_GAME_PAUSE") freeze();
    else if (e.name === "SDK_GAME_START") unfreeze();
    else if (e.name === "SDK_REWARDED_WATCH_COMPLETE") gdReward = true;
    if (prevGd) try { prevGd(e); } catch (x) {}
  };

  var googleReady = false;
  if (googleOn) {
    window.adsbygoogle = window.adsbygoogle || [];
    window.adBreak = window.adConfig = function (o) { window.adsbygoogle.push(o); };
    var s = document.createElement("script");
    s.async = true; s.crossOrigin = "anonymous";
    s.src = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=" + encodeURIComponent(GOOGLE_CLIENT);
    s.setAttribute("data-ad-client", GOOGLE_CLIENT);
    s.setAttribute("data-ad-frequency-hint", "120s");
    if (adtest) s.setAttribute("data-adbreak-test", "on");
    document.head.appendChild(s);
    window.adConfig({ preloadAdBreaks: "on", sound: "on", onReady: function () { googleReady = true; } });
  }

  var initP = Promise.resolve();
  try {
    if (crazy()) initP = window.CrazyGames.SDK.init();
    else if (poki()) initP = window.PokiSDK.init();
  } catch (e) {}
  initP = guard(Promise.resolve(initP).catch(function () {}), 5000);

  function interstitial(name) {
    track("ad_mid_" + P, 0); log("interstitial", P, name);
    if (poki()) return initP.then(function () { return guard(poki().commercialBreak(freeze).then(function () {}, function () {}), 45000); });
    if (crazy()) return initP.then(function () {
      return guard(new Promise(function (res) {
        crazy().ad.requestAd("midgame", { adStarted: freeze, adFinished: function () { res(); }, adError: function () { res(); } });
      }), 45000);
    });
    if (gd()) return guard(Promise.resolve(gd().showAd()).catch(function () {}), 45000);
    if (googleOn) return guard(new Promise(function (res) {
      window.adBreak({ type: "next", name: name || "next-run", beforeAd: freeze, afterAd: unfreeze, adBreakDone: function () { res(); } });
    }), 45000);
    return Promise.resolve();
  }

  function rewarded(name) {
    track("ad_reward_" + P, 0); log("rewarded", P, name);
    if (poki()) return initP.then(function () { return guard(poki().rewardedBreak(freeze).then(function (ok) { return !!ok; }, function () { return false; }), 60000, false); });
    if (crazy()) return initP.then(function () {
      return guard(new Promise(function (res) {
        crazy().ad.requestAd("rewarded", { adStarted: freeze, adFinished: function () { res(true); }, adError: function () { res(false); } });
      }), 60000, false);
    });
    if (gd()) {
      gdReward = false;
      var show = function () { return gd().showAd("rewarded"); };
      return guard((gd().preloadAd ? gd().preloadAd("rewarded").then(show) : show()).then(function () { return gdReward; }, function () { return false; }), 60000, false);
    }
    if (googleOn) return guard(new Promise(function (res) {
      var shown = false;
      window.adBreak({
        type: "reward", name: name || "reward",
        beforeAd: freeze, afterAd: unfreeze,
        beforeReward: function (showAdFn) { shown = true; showAdFn(); },
        adDismissed: function () { res(false); },
        adViewed: function () { res(true); },
        // no ad to show (no fill / frequency cap): the player asked for an ad, give the reward anyway
        adBreakDone: function (info) { if (!shown) res(true); else if (info && info.breakStatus !== "viewed") res(false); }
      });
    }), 60000, false);
    return Promise.resolve(true);   // no network: the games only offer free rewards here
  }

  function adsAvailable() { return !!(poki() || crazy() || gd() || googleOn); }

  // ---- interstitial pacing at natural breaks -------------------------------------------------
  var starts = 0, lastAd = 0, offAt = 0, playing = false;
  function eligible(force) {
    var now = Date.now();
    if (starts < 2) return false;                                  // never before the session's first run
    if (online()) return false;                                    // in a live match
    if (!force && offAt && now - offAt < MIN_BREAK) return false;  // a quick pause/unpause is not a break
    if (lastAd && now - lastAd < (MIN_GAP[P] || 0)) return false;
    return adsAvailable();
  }
  function autoBreak(force) {
    if (!eligible(force)) { log("no break", { starts: starts, online: online(), sinceAd: lastAd ? Date.now() - lastAd : -1 }); return Promise.resolve(); }
    lastAd = Date.now();
    freeze();   // hold the run still while the network fetches the ad; every path below ends in unfreeze()
    return interstitial("next-run").then(function () { lastAd = Date.now(); unfreeze(); });
  }

  window.MelloAds = { portal: P, google: googleOn, interstitial: interstitial, rewarded: rewarded, adsAvailable: adsAvailable, freeze: freeze, unfreeze: unfreeze, autoBreak: autoBreak };

  // ---- upgrade the page adapter ---------------------------------------------------------------
  var SD = window.SD;
  if (SD && SD.midgame) {
    // full adapter (KART CHAOS, SNACK MERGE): the game asks for midgames itself; we only add our own-site network
    if (P === "web" && googleOn) {
      SD.adsAvailable = adsAvailable;
      SD.rewarded = function () { return rewarded("reward"); };
      SD.midgame = function () { starts = Math.max(starts, 2); offAt = 0; return autoBreak(true); };
    }
  } else if (SD) {
    var sdGameplay = SD.gameplay, sdReady = SD.ready;
    SD.portal = P;
    SD.adsAvailable = adsAvailable;
    SD.rewarded = function () { return rewarded("reward"); };
    SD.midgame = function () { return autoBreak(true); };
    SD.ready = function () {
      initP.then(function () {
        try { if (poki()) poki().gameLoadingFinished(); } catch (e) {}
        try { if (crazy()) crazy().game.loadingStop(); } catch (e) {}
      });
      if (sdReady && !poki() && !crazy()) try { sdReady(); } catch (e) {}
    };
    SD.gameplay = function (on) {
      if (on && !playing) {
        playing = true; starts++;
        // the run has just begun: freeze it under an ad if this is a natural break, then tell the portal play resumed
        autoBreak(false).then(function () {
          if (!playing) return;
          try { if (poki()) poki().gameplayStart(); } catch (e) {}
          try { if (crazy()) crazy().game.gameplayStart(); } catch (e) {}
        });
      } else if (!on && playing) {
        playing = false; offAt = Date.now();
        try { if (poki()) poki().gameplayStop(); } catch (e) {}
        try { if (crazy()) crazy().game.gameplayStop(); } catch (e) {}
      }
      if (sdGameplay && !poki() && !crazy()) try { sdGameplay(on); } catch (e) {}
    };
  } else {
    // ORBYT: no SD adapter; a leaderboard run start is the start of a run (duels never get ads)
    var tries = 0;
    (function hook() {
      var lb = window.orbytLB;
      if (!lb || !lb.start) { if (tries++ < 120) setTimeout(hook, 500); return; }
      var start = lb.start;
      lb.start = function () { var r = start.apply(this, arguments); starts++; autoBreak(true); return r; };
    })();
  }
  try { if (crazy()) window.CrazyGames.SDK.game.loadingStart(); } catch (e) {}
})();
