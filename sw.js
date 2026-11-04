/* SAR Weather service worker: keeps the last good copy of each FlyWatch image, so
   a failed load (FlyWatch hiccup, no signal) can still show something.

   It touches only two kinds of request; everything else goes straight to the
   network as if it weren't here (so the page itself is never served stale):
   - FlyWatch images: passed through unchanged (no extra requests), and the
     response is kept in PENDING. It's opaque (no CORS), so the worker can't tell a
     picture from an error page: the page says which ones really loaded
     (postMessage {keep, as}) and only those are copied to SAVED.
   - <scope>/saved-image/<file>: answered from SAVED (404 if there is none).
     SAVED also holds <file>.json = {at: ms} (when it was saved), read by the page.
   - Looped radar images (message has frames: {keep, maxAgeMin}): also kept as
     <file>.f<at>, with <file>.frames.json = [at, ...] newest first, trimmed to
     `keep` copies and maxAgeMin minutes. The page picks which ones it loops. */
"use strict";
var PENDING = "sarwx-img-pending-v1", SAVED = "sarwx-img-saved-v1";
var FW = "https://www.flywatch.com/api/weather/images/";
var SAVED_PATH = new URL("saved-image/", self.registration.scope).href;
var inflight = {}; // request URL -> promise of its PENDING write

self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) {
      return k.indexOf("sarwx-img-") === 0 && k !== PENDING && k !== SAVED;
    }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function base(url) { return url.split("?")[0]; }

self.addEventListener("fetch", function (e) {
  var url = e.request.url;
  if (e.request.method !== "GET") return;
  if (url.indexOf(FW) === 0) {
    e.respondWith(fetch(e.request).then(function (res) {
      var copy = res.clone();
      var write = caches.open(PENDING).then(function (c) {
        // drop older pending copies of the same image, then keep this one
        return c.keys().then(function (reqs) {
          return Promise.all(reqs.filter(function (r) { return base(r.url) === base(url); })
                                 .map(function (r) { return c.delete(r); }));
        }).then(function () { return c.put(url, copy); });
      }).catch(function () { /* storage full or refused: just no saved copy */ });
      inflight[url] = write;
      e.waitUntil(write.then(function () { delete inflight[url]; }));
      return res;
    }));
  } else if (url.indexOf(SAVED_PATH) === 0) {
    e.respondWith(caches.open(SAVED).then(function (c) { return c.match(base(url)); })
      .then(function (r) { return r || new Response("", { status: 404 }); }));
  }
});

// The page: "this one loaded fine, keep it as <as>".
self.addEventListener("message", function (e) {
  var d = e.data || {};
  if (!d.keep || !d.as || d.as.indexOf(SAVED_PATH) !== 0) return;
  e.waitUntil((inflight[d.keep] || Promise.resolve()).then(function () {
    return caches.open(PENDING);
  }).then(function (p) {
    return p.match(d.keep).then(function (r) {
      if (!r) return;
      var at = Date.now(), frame = d.frames ? r.clone() : null;
      return caches.open(SAVED).then(function (s) {
        return s.put(d.as, r).then(function () {
          // when it was saved, for the page's "Saved copy from ..." line
          return s.put(d.as + ".json", json({ at: at }));
        }).then(function () { if (frame) return addFrame(s, d.as, frame, at, d.frames); });
      }).then(function () { return p.delete(d.keep); });
    });
  }).catch(function () {}));
});

function json(v) { return new Response(JSON.stringify(v), { headers: { "Content-Type": "application/json" } }); }

// one more copy for the full-screen loop; drop the ones past keep / maxAgeMin
function addFrame(s, as, res, at, f) {
  var idx = as + ".frames.json", keep = Math.min(10, Math.max(1, +f.keep || 1)),
      maxAge = (+f.maxAgeMin || 90) * 60000;
  return s.match(idx).then(function (r) { return r ? r.json() : []; }).catch(function () { return []; })
    .then(function (ats) {
      ats = (Array.isArray(ats) ? ats : []).filter(function (t) { return typeof t === "number" && t !== at; });
      ats.unshift(at);
      var kept = ats.filter(function (t, i) { return i < keep && t >= at - maxAge; });
      return s.put(as + ".f" + at, res).then(function () {
        return s.put(idx, json(kept));
      }).then(function () {
        return Promise.all(ats.filter(function (t) { return kept.indexOf(t) < 0; })
                              .map(function (t) { return s.delete(as + ".f" + t); }));
      });
    });
}
