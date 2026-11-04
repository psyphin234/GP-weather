/* SAR Weather: Greater Gauteng. Fetching, caching and drawing.
   One network source at run time: Open-Meteo, one batched request for every
   location, cached in localStorage, refreshed at most every REFRESH_MIN minutes
   and only while the tab is visible. Sun and moon are computed on the device. */
(function () {
  "use strict";

  var C = window.SARWX_CONFIG, W = window.SARWX_WX, A = window.SARWX_ASTRO;
  var CACHE_KEY = "sarwx-openmeteo-v1";
  var ATTEMPT_KEY = "sarwx-openmeteo-attempt";
  var TZ = C.TIMEZONE;

  // ---------------------------------------------------------------- helpers
  function $(id) { return document.getElementById(id); }
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === "text") n.textContent = v;
      else if (k === "class") n.className = v;
      else if (k === "html") n.innerHTML = v; // only ever used with our own SVG strings
      else n.setAttribute(k, v === true ? "" : v);
    });
    (kids || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return n;
  }
  var fmtHM = new Intl.DateTimeFormat("en-ZA", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
  var fmtDay = new Intl.DateTimeFormat("en-ZA", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" });
  var fmtDayLong = new Intl.DateTimeFormat("en-ZA", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" });
  function hm(d) { return d ? fmtHM.format(d) : "–"; }
  function hmS(sec) { return sec === null || sec === undefined ? "–" : fmtHM.format(new Date(sec * 1000)); }
  function dayS(sec) { return fmtDay.format(new Date(sec * 1000)); }
  function deg(v) { return v === null || v === undefined ? "–" : Math.round(v) + "°"; }
  function km(m) {
    if (m === null || m === undefined) return "–";
    var k = m / 1000;
    return k >= 20 ? "20+ km" : (k < 1 ? k.toFixed(1) : Math.round(k)) + " km";
  }
  function mm(v) { return v === null || v === undefined ? "–" : (v < 0.05 ? "0" : v < 10 ? v.toFixed(1) : Math.round(v)) + " mm"; }
  function ago(ms) {
    var m = Math.round((Date.now() - ms) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return m + " min ago";
    var h = Math.floor(m / 60);
    return h + " h " + (m % 60) + " min ago";
  }
  function stamp(ms) { return hm(new Date(ms)) + " (" + ago(ms) + ")"; }
  function arrow(dir) {
    // wind is FROM dir; the arrow points where it blows TO
    var r = (dir + 180) % 360;
    return el("span", { class: "arrow", "aria-hidden": "true",
      html: '<svg viewBox="0 0 20 20" width="16" height="16" style="transform:rotate(' + r + 'deg)"><path d="M10 2 L15 12 L10 9.5 L5 12 Z" fill="currentColor"/><rect x="9" y="9" width="2" height="9" fill="currentColor"/></svg>' });
  }

  function link(label, url, cls) {
    return el("a", { href: url, target: "_blank", rel: "noopener noreferrer", class: cls || null }, [label]);
  }

  // ---------------------------------------------------------------- data
  function locKey() { return C.LOCATIONS.map(function (l) { return l.lat + "," + l.lon; }).join(";"); }

  function buildUrl() {
    var q = [
      "latitude=" + C.LOCATIONS.map(function (l) { return l.lat; }).join(","),
      "longitude=" + C.LOCATIONS.map(function (l) { return l.lon; }).join(","),
      "current=temperature_2m,apparent_temperature,dew_point_2m,relative_humidity_2m,wind_speed_10m,wind_gusts_10m,wind_direction_10m,cloud_cover,visibility,precipitation,weather_code,is_day",
      "hourly=temperature_2m,apparent_temperature,dew_point_2m,precipitation_probability,precipitation,weather_code,cape,cloud_cover,visibility,wind_speed_10m,wind_gusts_10m,wind_direction_10m",
      "daily=temperature_2m_min,temperature_2m_max,sunrise,sunset",
      "timezone=" + encodeURIComponent(TZ),
      "forecast_days=3",
      "timeformat=unixtime",
      "wind_speed_unit=kmh"
    ];
    return "https://api.open-meteo.com/v1/forecast?" + q.join("&");
  }

  function readCache() {
    try {
      var c = JSON.parse(localStorage.getItem(CACHE_KEY));
      if (c && c.key === locKey() && Array.isArray(c.data) && c.data.length === C.LOCATIONS.length) return c;
    } catch (e) { /* no cache */ }
    return null;
  }
  function lastAttempt() { return +(localStorage.getItem(ATTEMPT_KEY) || 0); }

  var cache = readCache(), inflight = false, lastError = null, failures = 0, retryTimer = null;
  var FETCH_TIMEOUT_MS = 20000; // a hung request on a weak signal must not block the page

  function minutesSince(ms) { return (Date.now() - ms) / 60000; }

  // ms until a request may go (see js/refresh.js for the rules)
  function waitMs(force) {
    return window.SARWX_REFRESH.fetchWait({
      now: Date.now(), dataAt: cache ? cache.fetchedAt : 0, lastAttempt: lastAttempt(),
      failures: failures, force: !!force, cfg: C
    });
  }

  /* force = the Refresh button. Visible tab only, one request in flight. */
  function maybeFetch(force) {
    if (document.visibilityState !== "visible" || inflight) return;
    var wait = waitMs(force);
    if (wait > 0) {
      // nothing on screen yet: come back exactly when allowed, not at the next minute tick
      if (!cache && !retryTimer) retryTimer = setTimeout(function () { retryTimer = null; maybeFetch(false); }, wait + 250);
      return;
    }
    inflight = true;
    localStorage.setItem(ATTEMPT_KEY, String(Date.now()));
    renderStatus();
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, FETCH_TIMEOUT_MS);
    fetch(buildUrl(), { credentials: "omit", referrerPolicy: "no-referrer", signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) {
        if (!r.ok) throw new Error("Open-Meteo answered " + r.status);
        return r.json();
      })
      .then(function (data) {
        if (!Array.isArray(data)) data = [data];
        if (data.length !== C.LOCATIONS.length) throw new Error("Open-Meteo returned " + data.length + " locations");
        cache = { key: locKey(), fetchedAt: Date.now(), data: data };
        try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch (e) { /* storage full: keep in memory */ }
        lastError = null;
        failures = 0;
      })
      .catch(function (e) {
        failures++;
        lastError = e && e.name === "AbortError" ? "no answer in " + (FETCH_TIMEOUT_MS / 1000) + " s" : (e.message || String(e));
      })
      .then(function () {
        clearTimeout(timer);
        inflight = false;
        renderAll();
        if (!cache) maybeFetch(false); // schedules the next try
      });
  }

  // what the panels show while there is no forecast at all
  function noDataText() {
    if (inflight || !lastError) return "Loading forecast…";
    var sec = Math.ceil(waitMs(false) / 1000);
    return "Couldn't load the forecast (" + lastError + "). Trying again " +
      (sec <= 5 ? "now" : "in " + (sec < 90 ? sec + " s" : Math.ceil(sec / 60) + " min")) + ".";
  }

  // ---------------------------------------------------------------- status bar
  /* Radar staleness reminder. FlyWatch's images carry no date header and no CORS,
     so the page can't read the time printed on them (checked 2026-11-03); instead
     it works out the cutoff for the reader: an image stamped before it is stale. */
  var fmtUTC = new Intl.DateTimeFormat("en-ZA", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", hour12: false });
  function renderUtcNow() {
    var b = $("radar-check");
    if (!b) return;
    var now = new Date(), cutoff = new Date(now.valueOf() - C.RADAR_STALE_MIN * 60000);
    b.textContent = "";
    b.appendChild(el("strong", { text: "\u26a0 Image time should be after " + fmtUTC.format(cutoff) + " UTC" }));
    b.appendChild(document.createTextNode(" (now " + fmtUTC.format(now) + " UTC). Earlier = stale."));
  }

  function renderStatus() {
    renderUtcNow();
    renderAstroNow();
    var s = $("status-text"), btn = $("refresh");
    var parts = [];
    if (inflight) parts.push("Updating…");
    else if (cache) parts.push("Forecast from " + stamp(cache.fetchedAt));
    else parts.push("No forecast yet");
    if (lastError) parts.push("Last update failed (" + lastError + ")" + (cache ? ": showing saved data" : ""));
    if (cache && minutesSince(cache.fetchedAt) > 90) parts.push("Data is over 90 min old");
    s.className = lastError || (cache && minutesSince(cache.fetchedAt) > 90) ? "warn" : "";
    if (checkNote && !inflight) parts.push(checkNote);
    s.textContent = parts.join(" · ");
    btn.disabled = inflight;
    btn.textContent = inflight ? "Checking…" : "Refresh";
  }

  /* The Refresh button checks for new data without letting a busy thumb hammer
     the servers: it always looks at what this browser already has (another tab
     may have fetched newer data), but only asks Open-Meteo / FlyWatch again when
     the minimum gap (MIN_MANUAL_MIN) has passed. Otherwise it says "up to date". */
  var checkNote = "", checkNoteTimer = null;
  function onRefresh() {
    if (inflight) return;
    var c = readCache();
    if (c && (!cache || c.fetchedAt > cache.fetchedAt)) { cache = c; lastError = null; renderAll(); }
    var askForecast = waitMs(true) === 0;
    var imagesReloaded = loadImages(C.MIN_MANUAL_MIN);
    if (askForecast) {
      checkNote = "";
      maybeFetch(true);
      return;
    }
    var next = new Date(Date.now() + waitMs(true));
    checkNote = (imagesReloaded ? "Radar reloaded; forecast up to date" : "Up to date") + " (next check from " + hm(next) + ")";
    clearTimeout(checkNoteTimer);
    checkNoteTimer = setTimeout(function () { checkNote = ""; renderStatus(); }, 6000);
    renderStatus();
  }

  // ---------------------------------------------------------------- 1. storms
  var LEVEL_TEXT = ["Low", "Possible", "Likely", "Storm"];

  function renderStorms(now) {
    var box = $("storm-body");
    box.textContent = "";
    if (!cache) { box.appendChild(el("p", { class: lastError ? "warn" : "muted", text: noDataText() })); return; }
    var per = cache.data.map(function (loc) { return W.stormDays(loc, now, C.STORM); });
    var detail = el("p", { class: "tap-detail", id: "storm-tap", "aria-live": "polite", hidden: true });

    [0].forEach(function (k) { // today only (owner, 2026-11-03)
      var label = "Today";
      var dayStart = per[0][k].hours.length ? per[0][k].hours[0].t : null;
      // region summary
      var tsAreas = [], first = null, last = null, maxCape = 0, maxCapeAt = "", maxPop = 0, hail = false;
      per.forEach(function (d, i) {
        var s = d[k].summary;
        if (s.tsCount) {
          tsAreas.push(C.LOCATIONS[i].short);
          if (first === null || s.tsFirst < first) first = s.tsFirst;
          if (last === null || s.tsLast > last) last = s.tsLast;
        }
        if (s.hail) hail = true;
        if (s.maxCape > maxCape) { maxCape = s.maxCape; maxCapeAt = C.LOCATIONS[i].short; }
        if (s.maxPop > maxPop) maxPop = s.maxPop;
      });
      var maxLvl = per.reduce(function (m, d) { return Math.max(m, d[k].summary.maxLevel); }, 0);
      var head = el("div", { class: "day-head" }, [
        el("span", { class: "badge lv" + maxLvl, text: LEVEL_TEXT[maxLvl] }),
        el("strong", { class: "headline", text: tsAreas.length
          ? hmS(first) + "–" + hmS(last + 3600) + " · " + tsAreas.length + " of " + per.length + " areas" + (hail ? " · hail" : "")
          : "No storms forecast" })
      ]);
      var lines = [];

      // grid: rows = areas, 24 hourly cells
      var grid = el("div", { class: "storm-grid", role: "table", "aria-label": label + " storm risk by hour" });
      var hdr = el("div", { class: "sg-row sg-hours", role: "row" }, [el("span", { class: "sg-name", role: "columnheader", text: "" })]);
      for (var hr = 0; hr < 24; hr++) hdr.appendChild(el("span", { class: "sg-h", role: "columnheader", text: hr % 3 === 0 ? String(hr).padStart(2, "0") : "" }));
      grid.appendChild(hdr);
      per.forEach(function (d, i) {
        var row = el("div", { class: "sg-row", role: "row" }, [el("span", { class: "sg-name", role: "rowheader", text: C.LOCATIONS[i].short })]);
        var byHour = {};
        d[k].hours.forEach(function (h) { byHour[h.hour] = h; });
        for (var hr = 0; hr < 24; hr++) {
          var h = byHour[hr];
          if (!h) { row.appendChild(el("span", { class: "sg-c na", role: "cell" })); continue; }
          var isNow = now >= h.t && now < h.t + 3600;
          var txt = C.LOCATIONS[i].short + " " + String(hr).padStart(2, "0") + ":00: " + W.wmoText(h.code) +
                    ", CAPE " + Math.round(h.cape || 0) + " J/kg, rain chance " + (h.pop || 0) + "% (" + LEVEL_TEXT[h.level] + ")";
          row.appendChild(el("button", {
            type: "button", class: "sg-c lv" + h.level + (h.past ? " past" : "") + (isNow ? " now" : ""),
            role: "cell", title: txt, "aria-label": txt, "data-detail": txt
          }));
        }
        grid.appendChild(row);
      });
      grid.addEventListener("click", function (ev) {
        var t = ev.target.closest("[data-detail]");
        if (t) { var d = $("storm-tap"); d.textContent = t.getAttribute("data-detail"); d.hidden = false; }
      });
      box.appendChild(el("div", { class: "storm-day" }, [head].concat(lines).concat([el("div", { class: "grid-scroll" }, [grid])])));
    });
    box.appendChild(detail);
    box.appendChild(el("div", { class: "legend" }, [
      el("span", null, [el("i", { class: "sg-c lv0" }), " Low"]),
      el("span", null, [el("i", { class: "sg-c lv1" }), " Possible"]),
      el("span", null, [el("i", { class: "sg-c lv2" }), " Likely"]),
      el("span", null, [el("i", { class: "sg-c lv3" }), " Storm"]),
      el("span", null, [el("i", { class: "sg-c lv0 now" }), " Now"])
    ]));
  }

  // ---------------------------------------------------------------- 2. area cards
  // Line icons (24x24, stroke = currentColor), our own strings only.
  var ICON = {
    gust: '<path d="M9.6 4.6A2 2 0 1 1 11 8H2m10.6 11.4A2 2 0 1 0 14 16H2m15.7-8.3A2.5 2.5 0 1 1 19.5 12H2"/>',
    rain: '<path d="M22 12a10 10 0 0 0-20 0z"/><path d="M12 12v7a2.5 2.5 0 0 1-5 0"/>',
    dew: '<path d="M12 2.7l5.7 5.7a8 8 0 1 1-11.4 0z"/>',
    cloud: '<path d="M18 10h-1.3A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>',
    vis: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
    low: '<path d="M14 14.8V3.5a2.5 2.5 0 0 0-5 0v11.3a4.5 4.5 0 1 0 5 0z"/><path d="M19 5v8m-3-3l3 3 3-3"/>',
    feels: '<circle cx="12" cy="6" r="3"/><path d="M6 22v-6a6 6 0 0 1 12 0v6"/>',
    chill: '<path d="M12 2v20M3.3 7l17.4 10M3.3 17l17.4-10M9 4l3 2 3-2M9 20l3-2 3 2"/>',
    clear: '<path d="M12 3l2.1 4.3 4.7.7-3.4 3.3.8 4.7-4.2-2.2-4.2 2.2.8-4.7L5.2 8l4.7-.7z"/><path d="M19 17l.8 1.7 1.7.3-1.3 1.2.3 1.8-1.5-.8-1.5.8.3-1.8-1.3-1.2 1.7-.3z"/>'
  };
  function icon(name) {
    return el("span", { class: "ic", "aria-hidden": "true",
      html: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + ICON[name] + "</svg>" });
  }
  function windArrow(dir) {
    // wind is FROM dir; the arrow points where it blows TO
    return el("span", { class: "ic", "aria-hidden": "true",
      html: '<svg viewBox="0 0 20 20" width="18" height="18" style="transform:rotate(' + ((dir + 180) % 360) + 'deg)"><path d="M10 2 L15 12 L10 9.5 L5 12 Z" fill="currentColor"/><rect x="9" y="9" width="2" height="9" fill="currentColor"/></svg>' });
  }

  // weather picture for the WMO code; sun or moon by day / night
  function wxIcon(code, isDay) {
    var sun = '<circle cx="12" cy="12" r="4.5" fill="#ffd34d" stroke="none"/><path stroke="#ffd34d" d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/>',
        moon = '<path fill="#f4f1d6" stroke="none" d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>',
        cloud = function (dy) { return '<path transform="translate(0 ' + dy + ')" fill="#3a4a7a" stroke="#c9d6f0" d="M17.5 11h-1.1A6.5 6.5 0 1 0 8.5 19h9a4 4 0 0 0 0-8z"/>'; },
        corner = function (s) { return '<g transform="translate(-3 -3) scale(0.75)">' + s + "</g>"; },
        sky = isDay ? sun : moon, body;
    if (code <= 1) body = sky;
    else if (code === 2) body = corner(sky) + cloud(3);
    else if (code === 45 || code === 48) body = '<path stroke="#c9d6f0" d="M3 8h18M5 12h14M3 16h18M6 20h12"/>';
    else if (code >= 95) body = cloud(-4) + '<path fill="#ffc857" stroke="none" d="M13 14l-4 5h3l-1 4 5-6h-3l1-3z"/>';
    else if ((code >= 71 && code <= 77) || code === 85 || code === 86) body = cloud(-4) + '<path stroke="#eaf2ff" stroke-width="2.4" d="M8 19v.1M12 21v.1M16 19v.1"/>';
    else if (code >= 51) body = cloud(-4) + '<path stroke="#4cc9ff" d="M8 18l-1 3M12 18l-1 3M16 18l-1 3"/>';
    else body = cloud(0);
    return el("span", { class: "wx-ic", "aria-hidden": "true",
      html: '<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + body + "</svg>" });
  }

  // one tile: icon + big value (+ small unit), short caption under it; the
  // level (1-3) colours its icon and edge like the risk chips
  function tile(ic, value, unit, caption, level, title) {
    return el("div", { class: "tile" + (level ? " lv" + level : ""), title: title || null }, [
      el("div", { class: "tv" }, [ic, el("span", { text: value }), unit ? el("small", { text: unit }) : null]),
      el("div", { class: "tc", text: caption })
    ]);
  }
  function mmNum(v) { return v === null || v === undefined ? "–" : v < 0.05 ? "0" : v < 10 ? v.toFixed(1) : String(Math.round(v)); }
  function kmNum(m) {
    if (m === null || m === undefined) return "–";
    var k = m / 1000;
    return k >= 20 ? "20+" : k < 1 ? k.toFixed(1) : String(Math.round(k));
  }

  function renderPoints(now) {
    var box = $("points-body");
    box.textContent = "";
    if (!cache) { box.appendChild(el("p", { class: lastError ? "warn" : "muted", text: noDataText() })); return; }
    var ref = W.nightSummary(cache.data[0], now, C.NIGHT), nw = $("night-window");
    if (nw) nw.textContent = ref ? "Tonight: sunset " + hmS(ref.window.start) + " → sunrise " + hmS(ref.window.end) : "";
    cache.data.forEach(function (loc, i) {
      var L = C.LOCATIONS[i], c = loc.current, n24 = W.next24(loc, now),
          night = W.nightSummary(loc, now, C.NIGHT), h = loc.hourly,
          lv = W.nowLevels(c, n24, C.NIGHT, C.NOW), dir = W.compass(c.wind_direction_10m);
      var card = el("article", { class: "card", id: "area-" + L.id }, [
        el("div", { class: "now-row" }, [
          wxIcon(c.weather_code, c.is_day !== 0),
          el("span", { class: "big", text: deg(c.temperature_2m) }),
          el("span", { class: "now-wx" }, [
            el("h3", { text: L.name }),
            el("span", { class: "small" }, [W.wmoText(c.weather_code), el("span", { class: "muted", text: " · feels " + deg(c.apparent_temperature) })])
          ]),
          n24.thunder ? el("span", { class: "badge lv3", title: "Thunder in the next 24 h", text: "⚡ 24 h" }) : null
        ]),
        el("div", { class: "tiles" }, [
          tile(windArrow(c.wind_direction_10m), String(Math.round(c.wind_speed_10m)), "km/h", "Wind " + dir, 0, "Wind now, from " + dir),
          tile(icon("gust"), String(Math.round(c.wind_gusts_10m)), "km/h", "Gust · max " + Math.round(n24.gustMax || 0), lv.gust, "Gust now · strongest in the next 24 h"),
          tile(icon("rain"), mmNum(n24.rain), "mm", "24h · " + (n24.popMax || 0) + "%", lv.rain, "Rain in the next 24 h · highest chance"),
          tile(icon("dew"), deg(c.dew_point_2m), "", "Dew · RH " + c.relative_humidity_2m + "%", 0, "Dew point · relative humidity"),
          tile(icon("cloud"), String(c.cloud_cover), "%", "Cloud", 0, "Cloud cover now"),
          tile(icon("vis"), kmNum(c.visibility), "km", "Visibility", lv.vis, "Visibility now")
        ]),
        tonightStrip(night)
      ]);

      // hourly table, next 24 h
      var rows = n24.idx.map(function (j) {
        return el("tr", { class: W.isThunder(h.weather_code[j]) ? "ts" : null }, [
          el("th", { scope: "row", text: hmS(h.time[j]) }),
          el("td", { text: W.wmoText(h.weather_code[j]) }),
          el("td", { text: deg(h.temperature_2m[j]) }),
          el("td", { text: deg(h.apparent_temperature[j]) }),
          el("td", { text: deg(h.dew_point_2m[j]) }),
          el("td", null, [arrow(h.wind_direction_10m[j]), " " + W.compass(h.wind_direction_10m[j]) + " " + Math.round(h.wind_speed_10m[j]) + "/" + Math.round(h.wind_gusts_10m[j])]),
          el("td", { text: h.cloud_cover[j] + "%" }),
          el("td", { text: km(h.visibility[j]) }),
          el("td", { text: (h.precipitation_probability[j] || 0) + "% " + mm(h.precipitation[j]) }),
          el("td", { text: Math.round(h.cape[j] || 0) })
        ]);
      });
      var table = el("table", { class: "hourly" }, [
        el("thead", null, [el("tr", null, ["Time", "Weather", "Temp", "Feels", "Dew", "Wind/gust km/h", "Cloud", "Vis", "Rain", "CAPE"].map(function (t) { return el("th", { scope: "col", text: t }); }))]),
        el("tbody", null, rows)
      ]);
      card.appendChild(el("details", { "data-keep": "hourly-" + L.id }, [
        el("summary", { text: "Hourly, next 24 h" }),
        el("div", { class: "table-scroll" }, [table])
      ]));
      box.appendChild(card);
    });
  }

  // ---------------------------------------------------------------- 3. night
  // the "Tonight" part of each area card: flag chips, then the same kind of tiles
  function tonightStrip(n) {
    if (!n) return null;
    var lv = W.nightLevels(n, C.NIGHT);
    return el("div", { class: "tonight lv" + n.level }, [
      el("div", { class: "tonight-head" }, [el("strong", { text: "Tonight" })].concat(
        n.flags.map(function (f) { return el("span", { class: "chip lv" + f.level, text: f.text }); }))),
      el("div", { class: "tiles" }, [
        tile(icon("low"), deg(n.low), "", "Low · " + hmS(n.lowAt), lv.low, "Lowest temperature tonight · when"),
        tile(icon("feels"), deg(n.feelsMin), "", "Feels like", lv.feels, "Lowest feels-like tonight"),
        tile(icon("chill"), n.windChill === null ? "–" : deg(n.windChill), "", "Wind chill", lv.chill, "Lowest wind chill tonight (only below 10° with wind)"),
        tile(icon("rain"), mmNum(n.rain), "mm", "Rain · " + (n.popMax || 0) + "%", lv.rain, "Rain tonight · highest chance"),
        tile(icon("gust"), String(Math.round(n.gustMax || 0)), "km/h", "Gusts max", lv.gust, "Strongest gust tonight"),
        tile(icon("clear"), n.clearHours + "/" + n.hours, "", "Clear hours", lv.clear, "Clear hours tonight (fast cooling)")
      ])
    ]);
  }


  // ---------------------------------------------------------------- 4. sun & moon
  function moonSvg(fraction, phase) {
    var r = 18, k = fraction, rx = Math.abs(1 - 2 * k) * r, waxing = phase < 0.5;
    // southern hemisphere: a waxing moon is lit on the LEFT
    var flip = waxing ? -1 : 1;
    var inner = k < 0.5 ? 0 : 1;
    var d = "M0," + (-r) + " A" + r + "," + r + " 0 0 1 0," + r + " A" + rx.toFixed(2) + "," + r + " 0 0 " + inner + " 0," + (-r) + " Z";
    return '<svg viewBox="-20 -20 40 40" width="56" height="56" role="img" aria-label="Moon ' + Math.round(k * 100) + '% lit">' +
      '<circle r="' + r + '" fill="#1b2547" stroke="#3a4a7a" stroke-width="1"/>' +
      '<path d="' + d + '" fill="#f4f1d6" transform="scale(' + flip + ',1)"/></svg>';
  }

  function localMidnight(dayOffset) {
    // SAST is UTC+2 all year (no daylight saving)
    var now = new Date(), ms = now.valueOf() + 2 * 36e5;
    var mid = Math.floor(ms / 864e5) * 864e5 - 2 * 36e5;
    return new Date(mid + dayOffset * 864e5);
  }

  function astroLoc() {
    var sel = $("astro-loc");
    return C.LOCATIONS.filter(function (l) { return l.id === sel.value; })[0] || C.LOCATIONS[0];
  }

  /* Where the sun and moon are right now, as a rough nav aid: bearing from TRUE
     north (a compass reads magnetic) and height above the horizon. Below the
     horizon: when and where it next rises. Redrawn every minute. */
  function renderAstroNow() {
    var box = $("astro-now");
    if (!box) return;
    var L = astroLoc(), now = new Date(), today = localMidnight(0);
    function dir(b) { return Math.round(b) % 360 + "° " + W.compass(b); }
    function row(icon, name, pos, rise) {
      var where = pos.alt > 0
        ? [el("strong", { text: dir(pos.bearing) }), " · " + Math.round(pos.alt) + "° up"]
        : [el("span", { class: "muted", text: "down" }),
           rise ? " · rises " + hm(rise.t) + " at " : "", rise ? el("span", { class: "nowrap", text: dir(rise.bearing) }) : ""];
      return el("div", { class: "astro-now-row" }, [el("span", { class: "astro-now-name", text: icon + " " + name }), el("span", null, where)]);
    }
    var sunR = A.sunTimes(new Date(today.valueOf() + 12 * 36e5), L.lat, L.lon).sunrise;
    if (!sunR || sunR <= now) sunR = A.sunTimes(new Date(today.valueOf() + 36 * 36e5), L.lat, L.lon).sunrise;
    var moonR = A.moonTimes(now, L.lat, L.lon).rise;
    box.textContent = "";
    box.appendChild(el("div", { class: "astro-now-head small muted", text: "Now · bearing from true north" }));
    box.appendChild(row("☀", "Sun", A.sunPosition(now, L.lat, L.lon),
      sunR && { t: sunR, bearing: A.sunPosition(sunR, L.lat, L.lon).bearing }));
    box.appendChild(row("☾", "Moon", A.moonPosition(now, L.lat, L.lon),
      moonR && { t: moonR, bearing: A.moonPosition(moonR, L.lat, L.lon).bearing }));
  }

  function renderAstro() {
    var L = astroLoc();
    var box = $("astro-body");
    box.textContent = "";
    box.appendChild(el("div", { id: "astro-now", class: "astro-now" }));
    renderAstroNow();
    var nowD = new Date(), ill = A.moonIllumination(nowD);
    var days = [0, 1].map(function (k) {
      var mid = localMidnight(k), noon = new Date(mid.valueOf() + 12 * 36e5);
      return { label: k === 0 ? "Today" : "Tomorrow", mid: mid, sun: A.sunTimes(noon, L.lat, L.lon), moon: A.moonTimes(mid, L.lat, L.lon) };
    });
    var tbl = el("table", { class: "astro" }, [
      el("thead", null, [el("tr", null, [el("th", { text: "" })].concat(days.map(function (d) {
        return el("th", { scope: "col" }, [d.label, el("br"), el("span", { class: "small muted", text: fmtDay.format(d.mid.valueOf() + 6 * 36e5) })]);
      })))]),
      el("tbody", null, [
        ["Sunrise", function (d) { return hm(d.sun.sunrise); }],
        ["Sunset", function (d) { return hm(d.sun.sunset); }],
        ["Daylight", function (d) { var m = Math.round((d.sun.sunset - d.sun.sunrise) / 60000); return Math.floor(m / 60) + " h " + String(m % 60).padStart(2, "0"); }],
        ["Moonrise", function (d) { return d.moon.rise ? hm(d.moon.rise) : "none"; }],
        ["Moonset", function (d) { return d.moon.set ? hm(d.moon.set) : "none"; }]
      ].map(function (r) {
        return el("tr", null, [el("th", { scope: "row", text: r[0] })].concat(days.map(function (d) { return el("td", { text: r[1](d) }); })));
      }))
    ]);
    var full = A.nextPhase(nowD, 0.5), nw = A.nextPhase(nowD, 0);
    box.appendChild(el("div", { class: "astro-wrap" }, [
      el("div", { class: "table-scroll" }, [tbl]),
      el("div", { class: "moon" }, [
        el("span", { class: "moon-icon", html: moonSvg(ill.fraction, ill.phase) }),
        el("div", null, [
          el("strong", { text: A.phaseName(ill.phase) }),
          el("div", { text: Math.round(ill.fraction * 100) + "% lit, " + (ill.phase < 0.5 ? "growing" : "shrinking") }),
          el("div", { class: "small", text: "Full moon " + (full ? fmtDay.format(full) : "–") + " · New moon " + (nw ? fmtDay.format(nw) : "–") })
        ])
      ])
    ]));
  }

  // ---------------------------------------------------------------- SAWS images (via FlyWatch)
  // Plain <img>s, reloaded at most every REFRESH_MIN minutes and only while the
  // tab is visible. Tapping one opens the full-screen viewer.
  var shownImgs = [], imagesLoadedAt = 0;
  // A failed load is retried after these delays (FlyWatch sometimes fails a request
  // or serves a half-written file); after that, the next scheduled reload tries again.
  var IMG_RETRY_S = [20, 60, 180];

  // Last good copies, kept by the service worker (sw.js; same cache name there).
  // Without it (first visit, file://, old browser) the page just works as before.
  var SAVED_CACHE = "sarwx-img-saved-v1";
  function sw() { return navigator.serviceWorker && navigator.serviceWorker.controller; }

  function figure(x) {
    var file = x.url.split("/").pop();
    var slot = { url: x.url, title: x.title, day: x.day || null, img: null, savedAt: null, tries: 0, timer: null,
                 savedUrl: new URL("saved-image/" + file, location.href).href };
    slot.msg = el("p", { class: "small warn", hidden: true });
    slot.btn = el("button", { type: "button", class: "img-open", hidden: true, "aria-label": "Show " + x.title + " full screen" },
                  [el("span", { class: "img-hint", "aria-hidden": "true", text: "\u2922" })]);
    slot.placeholder = el("div", { class: "img-wait", style: "aspect-ratio:" + x.w + "/" + x.h, text: "Loading\u2026" });
    slot.w = x.w; slot.h = x.h;
    slot.btn.addEventListener("click", function () { if (slot.img) openViewer(slot.img.currentSrc || slot.img.src, x.title); });
    shownImgs.push(slot);
    return el("figure", { class: "chart" }, [
      el("figcaption", null, [el("strong", { text: x.title })]),
      slot.placeholder, slot.btn, slot.msg
    ]);
  }

  function showMsg(slot, text) {
    slot.msg.textContent = "";
    if (!text) { slot.msg.hidden = true; return; }
    slot.msg.appendChild(document.createTextNode(text + " "));
    slot.msg.appendChild(link("Open FlyWatch", C.RADAR_SOURCE_PAGE));
    slot.msg.hidden = false;
  }

  function failText(slot, wait) {
    var again = wait ? "; trying again in " + (wait < 60 ? wait + " s" : wait / 60 + " min") + "." : ".";
    if (slot.savedAt) {
      var at = new Date(slot.savedAt), today = fmtDay.format(at) === fmtDay.format(new Date());
      // savedAt is when this phone got it, not the image's own time (unreadable: no CORS)
      return "Not loading: last copy, fetched " + (today ? "" : fmtDay.format(at) + " ") + fmtHM.format(at) +
             (slot.day && !today ? " (not " + slot.day + "'s chart)" : "") + ". Go by the time printed on it." +
             (wait ? " Trying again in " + (wait < 60 ? wait + " s" : wait / 60 + " min") + "." : "");
    }
    return (slot.img ? "Couldn't refresh, showing the previous image" : "Image not loading") + again;
  }

  function show(slot, img) {
    if (slot.img) slot.img.replaceWith(img);
    else slot.btn.insertBefore(img, slot.btn.firstChild);
    slot.img = img;
    slot.placeholder.hidden = true;
    slot.btn.hidden = false;
  }

  function newImg(slot) {
    return el("img", { alt: slot.title + " (SAWS chart)", width: String(slot.w), height: String(slot.h), decoding: "async" });
  }

  /* Nothing on screen and FlyWatch failed: show the service worker's saved copy,
     if there is one, then call done(). */
  function showSaved(slot, done) {
    if (!sw() || !window.caches) { done(); return; }
    caches.open(SAVED_CACHE).then(function (c) { return c.match(slot.savedUrl + ".json"); })
      .then(function (r) { return r ? r.json() : null; })
      .then(function (meta) {
        if (!meta || !meta.at) { done(); return; }
        var img = newImg(slot);
        img.addEventListener("load", function () {
          if (!slot.img) { show(slot, img); slot.savedAt = meta.at; }
          done();
        });
        img.addEventListener("error", function () { done(); });
        img.src = slot.savedUrl;
      })
      .catch(function () { done(); });
  }

  /* Load one image off-screen and only swap it in once it has loaded, so a failed
     reload keeps the last good picture on screen instead of a broken one. */
  function loadOne(slot) {
    clearTimeout(slot.timer);
    var probe = newImg(slot);
    probe.addEventListener("load", function () {
      show(slot, probe);
      slot.savedAt = null;
      slot.tries = 0;
      showMsg(slot, "");
      // it really is a picture: tell the service worker to keep it
      if (sw()) sw().postMessage({ keep: probe.src, as: slot.savedUrl });
    });
    probe.addEventListener("error", function () {
      slot.tries++;
      var wait = IMG_RETRY_S[slot.tries - 1];
      function report() { slot.placeholder.hidden = true; showMsg(slot, failText(slot, wait)); }
      if (slot.img) report(); else showSaved(slot, report);
      if (wait) slot.timer = setTimeout(function () {
        if (document.visibilityState === "visible") loadOne(slot);
        else slot.tries--; // hidden tab: let the next visible tick handle it
      }, wait * 1000);
    });
    probe.src = slot.url + "?t=" + Date.now(); // new URL each try, so the browser fetches it again
  }

  function renderImages() {
    shownImgs = [];
    var stormBox = $("storm-images"), radarBox = $("radar-body");
    stormBox.textContent = ""; radarBox.textContent = "";
    var stormGrid = el("div", { class: "chart-grid" }), radarGrid = el("div", { class: "chart-grid" });
    C.IMAGES.forEach(function (x) {
      (x.panel === "storm" ? stormGrid : radarGrid).appendChild(figure(x));
    });
    if (stormGrid.firstChild) stormBox.appendChild(stormGrid);
    radarBox.appendChild(radarGrid);
  }

  // returns true if the images were asked for again
  function loadImages(minGap) {
    if (document.visibilityState !== "visible" || !shownImgs.length) return false;
    if (minutesSince(imagesLoadedAt) < minGap) return false;
    imagesLoadedAt = Date.now();
    shownImgs.forEach(function (slot) { slot.tries = 0; loadOne(slot); });
    return true;
  }

  // ---------------------------------------------------------------- full-screen viewer
  // A fixed overlay rather than the Fullscreen API (iPhones don't allow that for
  // images). Tap the picture to switch between fit-to-screen and 2x zoom; close
  // with the X, Esc, or the phone's Back button (the viewer adds a history entry).
  var viewer = null, viewerImg = null, viewerTitle = null, viewerStage = null, viewerOpen = false;

  function buildViewer() {
    viewerImg = el("img", { alt: "" });
    viewerTitle = el("span", { class: "viewer-title" });
    var close = el("button", { type: "button", class: "viewer-close", "aria-label": "Close full screen", text: "\u2715" });
    viewerStage = el("div", { class: "viewer-stage" }, [viewerImg]);
    viewer = el("div", { class: "viewer", role: "dialog", "aria-modal": "true", "aria-label": "Image, full screen", hidden: true }, [
      el("div", { class: "viewer-bar" }, [viewerTitle, close]),
      viewerStage
    ]);
    document.body.appendChild(viewer);
    close.addEventListener("click", function () { closeViewer(true); });
    viewerImg.addEventListener("click", function (ev) {
      var r = viewerImg.getBoundingClientRect(),
          fx = (ev.clientX - r.left) / r.width, fy = (ev.clientY - r.top) / r.height;
      var zoomed = viewer.classList.toggle("zoomed");
      if (zoomed) {
        // keep the tapped spot roughly in the middle of the screen
        requestAnimationFrame(function () {
          viewerStage.scrollLeft = fx * viewerStage.scrollWidth - viewerStage.clientWidth / 2;
          viewerStage.scrollTop = fy * viewerStage.scrollHeight - viewerStage.clientHeight / 2;
        });
      }
    });
    viewerStage.addEventListener("click", function (ev) { if (ev.target === viewerStage) closeViewer(true); });
    document.addEventListener("keydown", function (ev) { if (viewerOpen && ev.key === "Escape") closeViewer(true); });
    window.addEventListener("popstate", function () { if (viewerOpen) closeViewer(false); });
  }

  function openViewer(src, title) {
    if (!viewer) buildViewer();
    viewerImg.src = src;
    viewerImg.alt = title;
    viewerTitle.textContent = title;
    viewer.classList.remove("zoomed");
    viewer.hidden = false;
    viewerOpen = true;
    document.documentElement.classList.add("viewer-on");
    history.pushState({ sarwxViewer: 1 }, "");
    viewer.querySelector(".viewer-close").focus();
  }

  function closeViewer(fromUi) {
    if (!viewerOpen) return;
    viewerOpen = false;
    viewer.hidden = true;
    document.documentElement.classList.remove("viewer-on");
    if (fromUi && history.state && history.state.sarwxViewer) history.back();
  }

  // ---------------------------------------------------------------- render loop
  function keepOpen(fn) {
    var open = {};
    document.querySelectorAll("details[data-keep]").forEach(function (d) { if (d.open) open[d.getAttribute("data-keep")] = 1; });
    fn();
    document.querySelectorAll("details[data-keep]").forEach(function (d) { if (open[d.getAttribute("data-keep")]) d.open = true; });
  }

  var lastHour = null;
  function renderAll() {
    var now = Date.now() / 1000;
    lastHour = Math.floor(now / 3600);
    keepOpen(function () {
      renderStatus();
      try { renderStorms(now); } catch (e) { $("storm-body").textContent = "Couldn't draw this panel: " + e.message; }
      try { renderPoints(now); } catch (e) { $("points-body").textContent = "Couldn't draw this panel: " + e.message; }
      renderAstro();
    });
  }

  function tick() {
    maybeFetch(false);
    loadImages(C.REFRESH_MIN);
    if (Math.floor(Date.now() / 3600000) !== lastHour) renderAll();
    else renderStatus();
  }


  function init() {
    var sel = $("astro-loc");
    C.LOCATIONS.forEach(function (l) { sel.appendChild(el("option", { value: l.id, text: l.name, selected: l.id === C.ASTRO_DEFAULT })); });
    sel.addEventListener("change", renderAstro);
    $("refresh").addEventListener("click", onRefresh);
    document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") tick(); });
    // another tab of this page fetched: use its data instead of fetching again
    window.addEventListener("storage", function (ev) {
      if (ev.key === CACHE_KEY) { var c = readCache(); if (c) { cache = c; renderAll(); } }
    });
    // keeps the last good copy of each image (sw.js); needs https (or localhost)
    if (navigator.serviceWorker && window.isSecureContext) navigator.serviceWorker.register("sw.js").catch(function () {});
    renderImages();
    renderAll();
    maybeFetch(false);
    loadImages(0);
    setInterval(tick, 60000);
  }

  // exposed for tests only
  window.SARWX_APP = { buildUrl: buildUrl, moonSvg: moonSvg };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
