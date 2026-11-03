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
  function setFooter(panel, source, updated) {
    var f = $(panel + "-meta");
    if (!f) return;
    f.textContent = "";
    f.appendChild(el("span", null, ["Source: ", source]));
    f.appendChild(el("span", { class: "upd" }, ["Updated: ", updated]));
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

  var cache = readCache(), inflight = false, lastError = null;

  function minutesSince(ms) { return (Date.now() - ms) / 60000; }

  /* force = the Refresh button. Either way: visible tab only, one request in
     flight, and never sooner than the minimum gap (attempts count, so a failing
     network or repeated reloads don't hammer the API). */
  function maybeFetch(force) {
    if (document.visibilityState !== "visible" || inflight) return;
    var gap = minutesSince(Math.max(cache ? cache.fetchedAt : 0, lastAttempt()));
    if (gap < (force ? C.MIN_MANUAL_MIN : C.REFRESH_MIN)) return;
    inflight = true;
    localStorage.setItem(ATTEMPT_KEY, String(Date.now()));
    renderStatus();
    fetch(buildUrl(), { credentials: "omit", referrerPolicy: "no-referrer" })
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
      })
      .catch(function (e) { lastError = e.message || String(e); })
      .then(function () { inflight = false; renderAll(); });
  }

  // ---------------------------------------------------------------- status bar
  function renderStatus() {
    var s = $("status-text"), btn = $("refresh");
    var parts = [];
    if (inflight) parts.push("Updating…");
    else if (cache) parts.push("Forecast from " + stamp(cache.fetchedAt));
    else parts.push("No forecast loaded yet");
    if (lastError) parts.push("Last update failed (" + lastError + ")" + (cache ? ": showing saved data" : ""));
    if (cache && minutesSince(cache.fetchedAt) > 90) parts.push("Data is over 90 min old");
    s.textContent = parts.join(" · ");
    s.className = lastError || (cache && minutesSince(cache.fetchedAt) > 90) ? "warn" : "";
    var gap = minutesSince(Math.max(cache ? cache.fetchedAt : 0, lastAttempt()));
    var wait = Math.ceil(C.MIN_MANUAL_MIN - gap);
    btn.disabled = inflight || wait > 0;
    btn.textContent = wait > 0 && !inflight ? "Refresh in " + wait + " min" : "Refresh";
  }

  // ---------------------------------------------------------------- 1. storms
  var LEVEL_TEXT = ["Low", "Possible", "Elevated", "Thunderstorm forecast"];

  function renderStorms(now) {
    var box = $("storm-body");
    box.textContent = "";
    if (!cache) { box.appendChild(el("p", { class: "muted", text: "Waiting for forecast data…" })); return; }
    var per = cache.data.map(function (loc) { return W.stormDays(loc, now, C.STORM); });
    var detail = el("p", { class: "tap-detail", id: "storm-tap", "aria-live": "polite", text: "Tap a square for that hour's numbers." });

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
      var head = el("div", { class: "day-head lv" + maxLvl }, [
        el("h3", null, [label, dayStart ? el("span", { class: "muted small" }, [" " + dayS(dayStart)]) : null]),
        el("span", { class: "badge lv" + maxLvl, text: LEVEL_TEXT[maxLvl] })
      ]);
      var lines = [];
      if (tsAreas.length) {
        lines.push(el("p", { class: "summary" }, [
          el("strong", { text: "Thunderstorms forecast at " + tsAreas.length + " of " + per.length + " areas" }),
          ", between about " + hmS(first) + " and " + hmS(last + 3600) + (hail ? ". Hail possible." : ".")
        ]));
        lines.push(el("p", { class: "small muted", text: tsAreas.join(", ") }));
      } else {
        lines.push(el("p", { class: "summary", text: "No thunderstorm hours in the model for these areas." }));
      }
      lines.push(el("p", { class: "small" }, [
        "Highest CAPE " + Math.round(maxCape) + " J/kg (" + maxCapeAt + ") · highest rain chance " + maxPop + "%"
      ]));

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
        if (t) $("storm-tap").textContent = t.getAttribute("data-detail");
      });
      box.appendChild(el("div", { class: "storm-day" }, [head].concat(lines).concat([el("div", { class: "grid-scroll" }, [grid])])));
    });
    box.appendChild(detail);
    box.appendChild(el("div", { class: "legend" }, [
      el("span", null, [el("i", { class: "sg-c lv0" }), " Low"]),
      el("span", null, [el("i", { class: "sg-c lv1" }), " Possible: CAPE ≥ " + C.STORM.cape1 + " and rain ≥ " + C.STORM.pop1 + "%"]),
      el("span", null, [el("i", { class: "sg-c lv2" }), " Elevated: CAPE ≥ " + C.STORM.cape2 + " and rain ≥ " + C.STORM.pop2 + "%"]),
      el("span", null, [el("i", { class: "sg-c lv3" }), " Thunderstorm in the forecast (WMO 95–99)"]),
      el("span", null, [el("i", { class: "sg-c lv0 now" }), " This hour"])
    ]));
    setFooter("storm", link("Open-Meteo", "https://open-meteo.com/"), stamp(cache.fetchedAt));
  }

  // ---------------------------------------------------------------- 2. point forecasts
  function stat(label, value, extra) {
    return el("div", { class: "stat" }, [el("dt", { text: label }), el("dd", null, [value].concat(extra || []))]);
  }

  function renderPoints(now) {
    var box = $("points-body");
    box.textContent = "";
    if (!cache) { box.appendChild(el("p", { class: "muted", text: "Waiting for forecast data…" })); return; }
    cache.data.forEach(function (loc, i) {
      var L = C.LOCATIONS[i], c = loc.current, n24 = W.next24(loc, now),
          night = W.nightSummary(loc, now, C.NIGHT), h = loc.hourly;
      var card = el("article", { class: "card", id: "area-" + L.id }, [
        el("header", { class: "card-head" }, [
          el("h3", { text: L.name }),
          el("span", { class: "muted small", text: Math.round(loc.elevation) + " m · " + L.lat.toFixed(2) + ", " + L.lon.toFixed(2) })
        ]),
        L.note ? el("p", { class: "note small", text: L.note }) : null,
        el("div", { class: "now-row" }, [
          el("span", { class: "big", text: deg(c.temperature_2m) }),
          el("span", { class: "now-wx" }, [
            el("strong", { text: W.wmoText(c.weather_code) }),
            el("span", { class: "small muted", text: "Feels like " + deg(c.apparent_temperature) + " · now (" + hmS(c.time) + ")" })
          ]),
          n24.thunder ? el("span", { class: "badge lv3", text: "Thunder next 24 h" }) : null
        ]),
        el("dl", { class: "stats" }, [
          stat(night && night.window.running ? "Low rest of night" : "Overnight low", deg(night && night.low), night ? [el("span", { class: "small muted", text: " " + hmS(night.lowAt) })] : null),
          stat("Dew point", deg(c.dew_point_2m), [el("span", { class: "small muted", text: " RH " + c.relative_humidity_2m + "%" })]),
          stat("Wind", W.compass(c.wind_direction_10m) + " " + Math.round(c.wind_speed_10m) + " km/h", [arrow(c.wind_direction_10m)]),
          stat("Gusts", Math.round(c.wind_gusts_10m) + " km/h", [el("span", { class: "small muted", text: " max 24 h " + Math.round(n24.gustMax || 0) })]),
          stat("Cloud", c.cloud_cover + "%"),
          stat("Visibility", km(c.visibility)),
          stat("Rain next 24 h", mm(n24.rain), [el("span", { class: "small muted", text: " max " + (n24.popMax || 0) + "%" })])
        ])
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
        el("summary", { text: "Next 24 hours, hour by hour" }),
        el("div", { class: "table-scroll" }, [table])
      ]));
      box.appendChild(card);
    });
    setFooter("points", link("Open-Meteo", "https://open-meteo.com/"), stamp(cache.fetchedAt));
  }

  // ---------------------------------------------------------------- 3. night
  function renderNight(now) {
    var box = $("night-body");
    box.textContent = "";
    if (!cache) { box.appendChild(el("p", { class: "muted", text: "Waiting for forecast data…" })); return; }
    var sums = cache.data.map(function (loc) { return W.nightSummary(loc, now, C.NIGHT); });
    var ref = sums.filter(Boolean)[0];
    if (ref) {
      box.appendChild(el("p", { class: "summary" }, [
        el("strong", { text: ref.window.running ? "Tonight (now until sunrise)" : "Tonight" }),
        ": sunset " + hmS(ref.window.start) + " → sunrise " + hmS(ref.window.end) + " (" + C.LOCATIONS[0].short + "; within a few minutes elsewhere)"
      ]));
    }
    var list = el("div", { class: "night-list" });
    sums.forEach(function (s, i) {
      if (!s) return;
      var flags = s.flags.length ? s.flags.map(function (f) { return el("span", { class: "chip lv" + f.level, text: f.text }); })
                                 : [el("span", { class: "chip lv0", text: "No flags" })];
      list.appendChild(el("div", { class: "night-row lv" + s.level }, [
        el("div", { class: "night-name" }, [el("strong", { text: C.LOCATIONS[i].short })].concat(flags)),
        el("dl", { class: "night-nums" }, [
          stat("Low", deg(s.low), [el("span", { class: "small muted", text: " " + hmS(s.lowAt) })]),
          stat("Feels", deg(s.feelsMin)),
          stat("Wind chill", s.windChill === null ? "n/a" : deg(s.windChill), s.windChill === null ? [el("span", { class: "small muted", text: " (>10° or calm)" })] : null),
          stat("Rain", mm(s.rain), [el("span", { class: "small muted", text: " " + (s.popMax || 0) + "%" })]),
          stat("Clear sky", s.clearHours + " of " + s.hours + " h"),
          stat("Gusts", Math.round(s.gustMax || 0) + " km/h")
        ])
      ]));
    });
    box.appendChild(list);
    box.appendChild(el("ul", { class: "advice small" }, [
      el("li", { text: "Clear and calm nights cool fastest: kloofs, valley floors and dam basins can be several degrees colder than these grid figures." }),
      el("li", { text: "Wet clothing plus wind can cause hypothermia well above freezing, even at 10–15 °C." }),
      el("li", { text: "Wind chill uses the Environment Canada formula (only below 10 °C with wind over 4.8 km/h). \"Feels\" is Open-Meteo's apparent temperature." })
    ]));
    setFooter("night", link("Open-Meteo", "https://open-meteo.com/"), stamp(cache.fetchedAt));
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

  function renderAstro() {
    var sel = $("astro-loc"), L = C.LOCATIONS.filter(function (l) { return l.id === sel.value; })[0] || C.LOCATIONS[0];
    var box = $("astro-body");
    box.textContent = "";
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
        ["Civil dawn", function (d) { return hm(d.sun.dawn); }],
        ["Sunrise", function (d) { return hm(d.sun.sunrise); }],
        ["Sunset", function (d) { return hm(d.sun.sunset); }],
        ["Civil dusk", function (d) { return hm(d.sun.dusk); }],
        ["Daylight", function (d) { var m = Math.round((d.sun.sunset - d.sun.sunrise) / 60000); return Math.floor(m / 60) + " h " + String(m % 60).padStart(2, "0"); }],
        ["Moonrise", function (d) { return d.moon.rise ? hm(d.moon.rise) : "none"; }],
        ["Moonset", function (d) { return d.moon.set ? hm(d.moon.set) : "none"; }]
      ].map(function (r) {
        return el("tr", null, [el("th", { scope: "row", text: r[0] })].concat(days.map(function (d) { return el("td", { text: r[1](d) }); })));
      }))
    ]);
    var full = A.nextPhase(nowD, 0.5), nw = A.nextPhase(nowD, 0);
    var moonUp = A.moonAltitude(nowD, L.lat, L.lon) > 0;
    box.appendChild(el("div", { class: "astro-wrap" }, [
      el("div", { class: "table-scroll" }, [tbl]),
      el("div", { class: "moon" }, [
        el("span", { class: "moon-icon", html: moonSvg(ill.fraction, ill.phase) }),
        el("div", null, [
          el("strong", { text: A.phaseName(ill.phase) }),
          el("div", { text: Math.round(ill.fraction * 100) + "% lit, " + (ill.phase < 0.5 ? "growing" : "shrinking") }),
          el("div", { class: "small muted", text: "Moon is " + (moonUp ? "up" : "below the horizon") + " now" }),
          el("div", { class: "small", text: "Full moon " + (full ? fmtDay.format(full) : "–") + " · New moon " + (nw ? fmtDay.format(nw) : "–") })
        ])
      ])
    ]));
    box.appendChild(el("p", { class: "small muted", text: "Civil twilight: sun 6° below the horizon; enough light to work outside without torches. Times for " + L.name + "." }));
    setFooter("astro", "calculated on this device (Meeus formulas; sun ±2 min, moon ±10 min): no download", hm(nowD) + " (" + fmtDayLong.format(nowD) + ")");
  }

  // ---------------------------------------------------------------- 5. radar (links only)
  function renderLinks() {
    var r = $("radar-body");
    r.textContent = "";
    var rl = el("div", { class: "btns" });
    C.RADAR_LINKS.forEach(function (x) { rl.appendChild(link(x.label, x.url, "btn")); });
    r.appendChild(rl);
    r.appendChild(el("p", { class: "small muted", text: "SAWS radar images open on the SAWS aviation site: you need your own login there. They can't be shown on this page (SAWS only serves them to its own pages)." }));
    setFooter("radar", "links only", "links checked " + C.LINKS_CHECKED);
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
      try { renderNight(now); } catch (e) { $("night-body").textContent = "Couldn't draw this panel: " + e.message; }
      renderAstro();
    });
  }

  function tick() {
    maybeFetch(false);
    if (Math.floor(Date.now() / 3600000) !== lastHour) renderAll();
    else { renderStatus(); refreshAges(); }
  }
  function refreshAges() {
    if (!cache) return;
    ["storm", "points", "night"].forEach(function (p) {
      var u = document.querySelector("#" + p + "-meta .upd");
      if (u) u.textContent = "Updated: " + stamp(cache.fetchedAt);
    });
  }

  function init() {
    var sel = $("astro-loc");
    C.LOCATIONS.forEach(function (l) { sel.appendChild(el("option", { value: l.id, text: l.name, selected: l.id === C.ASTRO_DEFAULT })); });
    sel.addEventListener("change", renderAstro);
    $("refresh").addEventListener("click", function () { maybeFetch(true); });
    document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") tick(); });
    // another tab of this page fetched: use its data instead of fetching again
    window.addEventListener("storage", function (ev) {
      if (ev.key === CACHE_KEY) { var c = readCache(); if (c) { cache = c; renderAll(); } }
    });
    renderLinks();
    renderAll();
    maybeFetch(false);
    setInterval(tick, 60000);
  }

  // exposed for tests only
  window.SARWX_APP = { buildUrl: buildUrl, moonSvg: moonSvg };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
