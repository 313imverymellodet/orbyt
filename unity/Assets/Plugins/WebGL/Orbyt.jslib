mergeInto(LibraryManager.library, {
  OrbytArmShare: function (textPtr) {
    var text = UTF8ToString(textPtr);
    var w = window;
    var url = w.location.origin + w.location.pathname;
    var toast = function (msg) {
      if (w.orbytToast) { w.orbytToast(msg); return; }
    };
    var doShare = function () {
      if (!w.__orbytPending) return;
      var t = w.__orbytPending;
      w.__orbytPending = null;
      if (navigator.share) {
        navigator.share({ title: "ORBYT", text: t, url: url }).catch(function () {});
      } else if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(t + "\n" + url).then(function () {
          toast("Copied! Paste it anywhere ✨");
        }, function () { toast("Couldn't copy — screenshot it!"); });
      } else {
        toast("Screenshot it & tag a friend!");
      }
      if (w.orbytTrack) w.orbytTrack("share", 0);
    };
    if (!w.__orbytShareHooked) {
      w.__orbytShareHooked = true;
      w.addEventListener("pointerup", doShare, true);
      w.addEventListener("touchend", doShare, true);
      w.addEventListener("click", doShare, true);
    }
    w.__orbytPending = text;
    // Safety net if the DOM pointer-up already fired before Unity processed the press.
    setTimeout(doShare, 450);
  },

  OrbytVibrate: function (ms) {
    try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) {}
  },

  OrbytEvent: function (namePtr, value) {
    var name = UTF8ToString(namePtr);
    if (window.orbytTrack) window.orbytTrack(name, value);
  },

  OrbytReady: function () {
    if (window.orbytReady) window.orbytReady();
  }
});
