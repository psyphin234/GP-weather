/* Weather analysis: pure functions over one Open-Meteo location result
   (requested with timeformat=unixtime, so every time is in UTC seconds and
   utc_offset_seconds gives local time). No DOM, no network: tested in tests/. */
(function () {
  "use strict";

  var WMO = {
    0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Fog", 48: "Freezing fog",
    51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle",
    56: "Freezing drizzle", 57: "Freezing drizzle",
    61: "Light rain", 63: "Rain", 65: "Heavy rain",
    66: "Freezing rain", 67: "Freezing rain",
    71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains",
    80: "Light showers", 81: "Showers", 82: "Violent showers",
    85: "Snow showers", 86: "Heavy snow showers",
    95: "Thunderstorm", 96: "Thunderstorm, hail", 99: "Thunderstorm, heavy hail"
  };
  function wmoText(code) { return WMO[code] || ("Code " + code); }
  function isThunder(code) { return code >= 95 && code <= 99; }

  var POINTS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
                "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  function compass(deg) {
    if (deg === null || deg === undefined || isNaN(deg)) return "–";
    return POINTS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
  }

  /* Wind chill (Environment Canada / US NWS 2001), T in degC, V in km/h at 10 m.
     Defined only for T <= 10 degC and V > 4.8 km/h; returns null otherwise. */
  function windChill(T, V) {
    if (T === null || V === null || T > 10 || V <= 4.8) return null;
    var p = Math.pow(V, 0.16);
    return 13.12 + 0.6215 * T - 11.37 * p + 0.3965 * T * p;
  }

  /* Hourly storm level: 3 thunderstorm forecast, 2 elevated, 1 possible, 0 low. */
  function stormLevel(code, cape, pop, cfg) {
    if (isThunder(code)) return 3;
    cape = cape || 0; pop = pop || 0;
    if (cape >= cfg.cape2 && pop >= cfg.pop2) return 2;
    if (cape >= cfg.cape1 && pop >= cfg.pop1) return 1;
    return 0;
  }

  // local calendar day number (days since 1970 in local time) and local hour
  function localDay(t, off) { return Math.floor((t + off) / 86400); }
  function localHour(t, off) { return Math.floor(((t + off) % 86400 + 86400) % 86400 / 3600); }

  /* Today's and tomorrow's 24 hours for one location, with a storm level per hour
     and a summary per day. `now` in UTC seconds. */
  function stormDays(loc, now, cfg) {
    var h = loc.hourly, off = loc.utc_offset_seconds || 0, today = localDay(now, off), days = [];
    for (var k = 0; k < 2; k++) {
      var day = today + k, hours = [], sum = { maxLevel: 0, maxCape: 0, maxPop: 0, tsFirst: null, tsLast: null, hail: false, tsCount: 0 };
      for (var i = 0; i < h.time.length; i++) {
        var t = h.time[i];
        if (localDay(t, off) !== day) continue;
        var code = h.weather_code[i], cape = h.cape[i], pop = h.precipitation_probability[i],
            lvl = stormLevel(code, cape, pop, cfg);
        hours.push({ t: t, hour: localHour(t, off), level: lvl, code: code, cape: cape, pop: pop, past: t + 3600 <= now });
        if (lvl > sum.maxLevel) sum.maxLevel = lvl;
        if (cape > sum.maxCape) sum.maxCape = cape;
        if (pop > sum.maxPop) sum.maxPop = pop;
        if (lvl === 3) {
          sum.tsCount++;
          if (sum.tsFirst === null) sum.tsFirst = t;
          sum.tsLast = t;
          if (code === 96 || code === 99) sum.hail = true;
        }
      }
      days.push({ day: day, hours: hours, summary: sum });
    }
    return days;
  }

  /* The night that is running now or comes next: [sunset, next sunrise], from
     Open-Meteo's daily sunrise/sunset. Before today's sunrise the night is the
     one already running (start = local midnight, as the data begins there). */
  function nightWindow(loc, now) {
    var d = loc.daily, n = d.time.length;
    if (now < d.sunrise[0]) return { start: d.time[0], end: d.sunrise[0], running: true };
    for (var i = 0; i < n - 1; i++) {
      if (now < d.sunrise[i + 1]) {
        return { start: d.sunset[i], end: d.sunrise[i + 1], running: now >= d.sunset[i] };
      }
    }
    return null;
  }

  function hoursBetween(loc, from, to) {
    var h = loc.hourly, out = [];
    for (var i = 0; i < h.time.length; i++) {
      // an hour counts if any part of it falls inside [from, to)
      if (h.time[i] + 3600 > from && h.time[i] < to) out.push(i);
    }
    return out;
  }

  function minOf(arr, idx) { var m = null; idx.forEach(function (i) { var v = arr[i]; if (v !== null && (m === null || v < m)) m = v; }); return m; }
  function maxOf(arr, idx) { var m = null; idx.forEach(function (i) { var v = arr[i]; if (v !== null && (m === null || v > m)) m = v; }); return m; }
  function sumOf(arr, idx) { var s = 0; idx.forEach(function (i) { s += arr[i] || 0; }); return s; }

  /* Night survivability numbers and flags for one location.
     While the night is running only the hours still to come are used. */
  function nightSummary(loc, now, cfg) {
    var w = nightWindow(loc, now);
    if (!w) return null;
    var from = w.running ? Math.max(w.start, now) : w.start,
        idx = hoursBetween(loc, from, w.end), h = loc.hourly;
    if (!idx.length) return null;
    var chill = null, chillHour = null;
    idx.forEach(function (i) {
      var c = windChill(h.temperature_2m[i], h.wind_speed_10m[i]);
      if (c !== null && (chill === null || c < chill)) { chill = c; chillHour = h.time[i]; }
    });
    var lowIdx = idx.reduce(function (a, i) { return h.temperature_2m[i] < h.temperature_2m[a] ? i : a; }, idx[0]);
    var cloudAvg = sumOf(h.cloud_cover, idx) / idx.length,
        clearHours = idx.filter(function (i) { return h.cloud_cover[i] < cfg.clearCloud; }).length,
        s = {
          window: w,
          low: h.temperature_2m[lowIdx],
          lowAt: h.time[lowIdx],
          feelsMin: minOf(h.apparent_temperature, idx),
          windChill: chill,
          windChillAt: chillHour,
          rain: sumOf(h.precipitation, idx),
          popMax: maxOf(h.precipitation_probability, idx),
          gustMax: maxOf(h.wind_gusts_10m, idx),
          windMax: maxOf(h.wind_speed_10m, idx),
          dewMin: minOf(h.dew_point_2m, idx),
          cloudAvg: cloudAvg,
          clearHours: clearHours,
          hours: idx.length,
          thunder: idx.some(function (i) { return isThunder(h.weather_code[i]); })
        };
    var flags = [], coldest = Math.min(s.feelsMin === null ? 99 : s.feelsMin, s.windChill === null ? 99 : s.windChill);
    if (coldest <= cfg.veryCold) flags.push({ key: "vcold", text: "Very cold", level: 3 });
    else if (coldest <= cfg.cold) flags.push({ key: "cold", text: "Cold", level: 2 });
    var wet = s.rain >= cfg.wetMm || (s.popMax || 0) >= cfg.wetPop;
    if (wet && (s.gustMax || 0) >= cfg.windyGust) flags.push({ key: "wetwind", text: "Wet + wind", level: 3 });
    else if (wet) flags.push({ key: "wet", text: "Wet", level: 2 });
    if (s.thunder) flags.push({ key: "ts", text: "Thunder", level: 3 });
    if (cloudAvg < cfg.clearCloud) flags.push({ key: "clear", text: "Clear sky: fast cooling", level: 1 });
    s.flags = flags;
    s.level = flags.reduce(function (m, f) { return Math.max(m, f.level); }, 0);
    return s;
  }

  /* The hour row holding `now` (the hour that has started), or -1. */
  function currentIndex(loc, now) {
    var t = loc.hourly.time;
    for (var i = t.length - 1; i >= 0; i--) if (t[i] <= now) return i;
    return -1;
  }

  /* Next 24 hours from the current hour: rain total, highest rain chance,
     strongest gust, any thunder. */
  function next24(loc, now) {
    var i0 = Math.max(0, currentIndex(loc, now)), h = loc.hourly, idx = [];
    for (var i = i0; i < Math.min(i0 + 24, h.time.length); i++) idx.push(i);
    return {
      idx: idx,
      rain: sumOf(h.precipitation, idx),
      popMax: maxOf(h.precipitation_probability, idx),
      gustMax: maxOf(h.wind_gusts_10m, idx),
      thunder: idx.some(function (i) { return isThunder(h.weather_code[i]); })
    };
  }

  /* Warning colour (0 none, 1 yellow, 2 orange, 3 red) for each tile on an
     area card, from the same thresholds as the night flags. */
  function coldLevel(t, cfg) {
    if (t === null || t === undefined) return 0;
    return t <= cfg.veryCold ? 3 : t <= cfg.cold ? 2 : 0;
  }
  function nowLevels(cur, n24, night, now) {
    var gust = Math.max(cur.wind_gusts_10m || 0, n24.gustMax || 0);
    return {
      gust: gust >= night.windyGust ? 1 : 0,
      rain: (n24.rain >= night.wetMm || (n24.popMax || 0) >= night.wetPop) ? 1 : 0,
      vis: cur.visibility !== null && cur.visibility !== undefined && cur.visibility < now.lowVisKm * 1000 ? 2 : 0
    };
  }
  function nightLevels(n, cfg) {
    var wet = n.rain >= cfg.wetMm || (n.popMax || 0) >= cfg.wetPop,
        windy = (n.gustMax || 0) >= cfg.windyGust;
    return {
      low: coldLevel(n.low, cfg),
      feels: coldLevel(n.feelsMin, cfg),
      chill: coldLevel(n.windChill, cfg),
      rain: wet ? (windy ? 3 : 2) : 0,
      gust: windy ? (wet ? 3 : 1) : 0,
      clear: n.cloudAvg < cfg.clearCloud ? 1 : 0
    };
  }

  window.SARWX_WX = {
    coldLevel: coldLevel,
    nowLevels: nowLevels,
    nightLevels: nightLevels,
    wmoText: wmoText,
    isThunder: isThunder,
    compass: compass,
    windChill: windChill,
    stormLevel: stormLevel,
    stormDays: stormDays,
    nightWindow: nightWindow,
    nightSummary: nightSummary,
    currentIndex: currentIndex,
    next24: next24,
    localDay: localDay,
    localHour: localHour
  };
})();
