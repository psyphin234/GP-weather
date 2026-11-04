/* Timing rules, pure functions, tested in tests/.
   fetchWait: when may the next Open-Meteo request go?
   - Forecast on screen: not before REFRESH_MIN minutes after the data (or after the
     last attempt, if that was later); the Refresh button: MIN_MANUAL_MIN instead.
   - No forecast to show (first visit, the area list changed, or a request was cut
     off by a reload): don't make people wait 15 minutes looking at nothing. Go
     straight away, but at most one attempt per 30 s; after failures in this visit
     back off 1, 2, 4, 8, then REFRESH_MIN minutes. */
(function () {
  "use strict";
  var MIN = 60000;

  // s: { now, dataAt (0 = no usable forecast), lastAttempt (0 = never),
  //      failures (failed attempts in a row, this visit), force, cfg }
  // returns milliseconds to wait; 0 = go now
  function fetchWait(s) {
    var gap;
    if (!s.dataAt) {
      gap = s.failures ? Math.min(s.cfg.REFRESH_MIN, Math.pow(2, s.failures - 1)) * MIN : 0.5 * MIN;
      return Math.max(0, (s.lastAttempt || 0) + gap - s.now);
    }
    gap = (s.force ? s.cfg.MIN_MANUAL_MIN : s.cfg.REFRESH_MIN) * MIN;
    return Math.max(0, Math.max(s.dataAt, s.lastAttempt || 0) + gap - s.now);
  }

  /* Which saved copies go in the full-screen radar loop, before the one on screen?
     ats: when each copy was saved (ms, any order); newestAt: when the image on screen
     was fetched; L: config LOOP. Walks back from newestAt taking a copy only if it is
     at least gapMin older than the last one taken (so a quick Refresh doesn't make a
     near-duplicate frame), and not more than maxAgeMin older than newestAt.
     Returns up to frames - 1 times, oldest first. */
  function loopFrames(ats, newestAt, L) {
    var picked = [], last = newestAt;
    ats.slice().sort(function (a, b) { return b - a; }).forEach(function (t) {
      if (picked.length >= L.frames - 1 || typeof t !== "number") return;
      if (t <= last - L.gapMin * MIN && t >= newestAt - L.maxAgeMin * MIN) { picked.push(t); last = t; }
    });
    return picked.reverse();
  }

  window.SARWX_REFRESH = { fetchWait: fetchWait, loopFrames: loopFrames };
})();
