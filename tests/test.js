/* Tests for js/astro.js and js/wx.js. Open tests/index.html, or run tests/run.ps1.
   Astro reference values: PyEphem 4.x for Pretoria (-25.75, 28.19), sea-level
   horizon at -0.833 deg (sun) with use_center, pressure 0 (computed 2026-11-03). */
(function () {
  "use strict";
  var A = window.SARWX_ASTRO, W = window.SARWX_WX, C = window.SARWX_CONFIG;
  var results = $("results"), pass = 0, fail = 0;
  function $(id) { return document.getElementById(id); }
  function report(ok, msg) {
    var li = document.createElement("li");
    li.className = ok ? "ok" : "bad";
    li.textContent = (ok ? "PASS " : "FAIL ") + msg;
    results.appendChild(li);
    if (ok) pass++; else fail++;
  }
  function eq(a, b, msg) { report(a === b, msg + " (got " + JSON.stringify(a) + ", want " + JSON.stringify(b) + ")"); }
  function near(a, b, tol, msg) { report(a !== null && Math.abs(a - b) <= tol, msg + " (got " + a + ", want " + b + " ±" + tol + ")"); }

  // SAST is UTC+2 all year
  function sast(s) { if (s.length === 16) s += ":00"; return new Date(s.replace(" ", "T") + "+02:00"); }
  function minDiff(d, s) { return d ? Math.round((d - sast(s)) / 6000) / 10 : null; }

  // ---------------------------------------------------------------- astro
  var PTA = [-25.75, 28.19];
  var SUN = [
    // date, civil dawn, sunrise, sunset, civil dusk (centre of the sun; to the second)
    ["2026-11-03", "04:52:57", "05:17:09", "18:24:47", "18:49:01"],
    ["2026-06-21", "06:27:57", "06:53:10", "17:24:54", "17:50:07"],
    ["2026-12-21", "04:46:41", "05:12:43", "18:57:48", "19:23:50"]
  ];
  SUN.forEach(function (r) {
    var t = A.sunTimes(sast(r[0] + " 12:00"), PTA[0], PTA[1]);
    near(minDiff(t.dawn, r[0] + " " + r[1]), 0, 2, r[0] + " civil dawn vs ephem, minutes");
    near(minDiff(t.sunrise, r[0] + " " + r[2]), 0, 2, r[0] + " sunrise vs ephem, minutes");
    near(minDiff(t.sunset, r[0] + " " + r[3]), 0, 2, r[0] + " sunset vs ephem, minutes");
    near(minDiff(t.dusk, r[0] + " " + r[4]), 0, 2, r[0] + " civil dusk vs ephem, minutes");
  });

  var MOON = [
    // date, moonrise, moonset (null = none that local day). ephem: upper limb at
    // the horizon with refraction; ours: centre at +0.133 deg, a minute or so apart.
    ["2026-11-03", "2026-11-03 01:34:10", "2026-11-03 13:08:52"],
    ["2026-06-21", "2026-06-21 11:45:15", null],  // sets 00:09 on the 22nd
    ["2026-12-21", "2026-12-21 16:21:51", "2026-12-21 02:13:49"]
  ];
  MOON.forEach(function (r) {
    var m = A.moonTimes(sast(r[0] + " 00:00"), PTA[0], PTA[1]);
    near(minDiff(m.rise, r[1]), 0, 10, r[0] + " moonrise vs ephem, minutes");
    if (r[2] === null) eq(m.set, null, r[0] + " no moonset that day");
    else near(minDiff(m.set, r[2]), 0, 10, r[0] + " moonset vs ephem, minutes");
  });

  near(A.moonIllumination(sast("2026-11-03 12:00")).fraction, 0.3305, 0.02, "2026-11-03 12:00 moon fraction lit");
  near(A.moonIllumination(sast("2026-06-21 12:00")).fraction, 0.4517, 0.02, "2026-06-21 12:00 moon fraction lit");
  near(A.moonIllumination(sast("2026-12-21 12:00")).fraction, 0.898, 0.02, "2026-12-21 12:00 moon fraction lit");

  var POS = [
    // SAST time, sun bearing (deg from true north), sun alt, moon bearing, moon alt
    // (PyEphem, topocentric, refraction at 1010 hPa)
    ["2026-11-03 06:00", 102.67, 8.59, 28.24, 47.03],
    ["2026-11-03 10:00", 73.05, 62.03, 309.43, 36.16],
    ["2026-11-03 16:30", 264.25, 24.48, 258.75, -43.84],
    ["2026-06-21 12:00", 2.74, 40.78, 87.78, 2.63],
    ["2026-12-21 21:00", 226.35, -23.42, 12.58, 37.78],
    ["2026-11-04 03:00", 126.38, -28.32, 76.43, 10.29]
  ];
  function angDiff(a, b) { return ((a - b) % 360 + 540) % 360 - 180; }
  POS.forEach(function (r) {
    var s = A.sunPosition(sast(r[0]), PTA[0], PTA[1]), m = A.moonPosition(sast(r[0]), PTA[0], PTA[1]);
    near(angDiff(s.bearing, r[1]), 0, 0.5, r[0] + " sun bearing vs ephem, deg");
    near(s.alt - r[2], 0, 0.5, r[0] + " sun altitude vs ephem, deg");
    near(angDiff(m.bearing, r[3]), 0, 2.5, r[0] + " moon bearing vs ephem, deg");
    near(m.alt - r[4], 0, 1.5, r[0] + " moon altitude vs ephem, deg");
  });

  // compass dial: north up, east right, south down, west left (screen y down)
  [[0, 0, -10], [90, 10, 0], [180, 0, 10], [270, -10, 0], [45, 7.071, -7.071]].forEach(function (r) {
    var p = A.dialPoint(r[0], 10);
    near(p.x, r[1], 0.001, "dial point " + r[0] + " deg x");
    near(p.y, r[2], 0.001, "dial point " + r[0] + " deg y");
  });
  report(C.SUN_COMPASS && C.SUN_COMPASS.maxAlt > 45 && C.SUN_COMPASS.maxAlt < 90, "sun compass maxAlt between 45 and 90");

  function hoursDiff(d, s) { return d ? (d - sast(s)) / 36e5 : null; }
  near(hoursDiff(A.nextPhase(sast("2026-11-03 12:00"), 0.5), "2026-11-24 16:53"), 0, 8, "next full moon after 3 Nov, hours");
  near(hoursDiff(A.nextPhase(sast("2026-11-03 12:00"), 0), "2026-11-09 09:02"), 0, 8, "next new moon after 3 Nov, hours");
  near(hoursDiff(A.nextPhase(sast("2026-12-21 12:00"), 0.5), "2026-12-24 03:28"), 0, 8, "next full moon after 21 Dec, hours");
  near(hoursDiff(A.nextPhase(sast("2026-06-21 12:00"), 0), "2026-07-14 11:43"), 0, 8, "next new moon after 21 Jun, hours");

  eq(A.phaseName(0), "New moon", "phase name 0");
  eq(A.phaseName(0.25), "First quarter", "phase name 0.25");
  eq(A.phaseName(0.5), "Full moon", "phase name 0.5");
  eq(A.phaseName(0.74), "Last quarter", "phase name 0.74");
  eq(A.phaseName(0.98), "New moon", "phase name 0.98");
  eq(A.phaseName(0.33), "Waxing gibbous", "phase name 0.33");
  eq(A.phaseName(0.8), "Waning crescent", "phase name 0.8 (35% lit, 2 days past last quarter)");
  eq(A.phaseName(0.1), "Waxing crescent", "phase name 0.1");
  eq(A.phaseName(0.6), "Waning gibbous", "phase name 0.6");
  eq(A.phaseName(A.moonIllumination(sast("2026-11-03 12:00")).phase), "Waning crescent", "3 Nov 2026 is a waning crescent");

  // ---------------------------------------------------------------- wx: small functions
  eq(W.compass(0), "N", "compass 0");
  eq(W.compass(359), "N", "compass 359");
  eq(W.compass(11), "N", "compass 11");
  eq(W.compass(12), "NNE", "compass 12");
  eq(W.compass(180), "S", "compass 180");
  eq(W.compass(337.5), "NNW", "compass 337.5");
  eq(W.compass(-10), "N", "compass -10");
  eq(W.compass(null), "–", "compass null");

  near(W.windChill(0, 20), -5.24, 0.05, "wind chill 0 degC, 20 km/h");
  near(W.windChill(-10, 30), -19.52, 0.05, "wind chill -10 degC, 30 km/h");
  eq(W.windChill(11, 30), null, "no wind chill above 10 degC");
  eq(W.windChill(5, 4), null, "no wind chill in near-calm");

  var S = C.STORM;
  eq(W.stormLevel(95, 0, 0, S), 3, "code 95 is level 3 even with no CAPE");
  eq(W.stormLevel(99, 0, 0, S), 3, "code 99 is level 3");
  eq(W.stormLevel(94, 5000, 100, S), 2, "code 94 is not thunder; big CAPE + POP is level 2");
  eq(W.stormLevel(3, 1000, 40, S), 2, "CAPE 1000 + POP 40 is level 2 (edges inclusive)");
  eq(W.stormLevel(3, 999, 90, S), 1, "CAPE 999 + POP 90 is level 1");
  eq(W.stormLevel(3, 500, 20, S), 1, "CAPE 500 + POP 20 is level 1");
  eq(W.stormLevel(3, 2000, 19, S), 0, "dry high CAPE is level 0");
  eq(W.stormLevel(3, null, null, S), 0, "missing values are level 0");

  eq(W.wmoText(96), "Thunderstorm, hail", "WMO 96 text");
  eq(W.wmoText(42), "Code 42", "unknown WMO code text");

  // ---------------------------------------------------------------- wx: fixture
  // Three local days from 2026-11-03 00:00 SAST, like Open-Meteo with
  // timeformat=unixtime and timezone=Africa/Johannesburg.
  var T0 = 1793656800, OFF = 7200;
  eq(W.localHour(T0, OFF), 0, "fixture starts at local midnight");
  eq(W.localHour(T0 + 13 * 3600, OFF), 13, "local hour 13");
  function fixture(edit) {
    var h = { time: [], temperature_2m: [], apparent_temperature: [], dew_point_2m: [], precipitation_probability: [],
              precipitation: [], weather_code: [], cape: [], cloud_cover: [], visibility: [], wind_speed_10m: [],
              wind_gusts_10m: [], wind_direction_10m: [] };
    for (var i = 0; i < 72; i++) {
      h.time.push(T0 + i * 3600);
      h.temperature_2m.push(15); h.apparent_temperature.push(14); h.dew_point_2m.push(8);
      h.precipitation_probability.push(0); h.precipitation.push(0); h.weather_code.push(1);
      h.cape.push(0); h.cloud_cover.push(60); h.visibility.push(30000);
      h.wind_speed_10m.push(10); h.wind_gusts_10m.push(15); h.wind_direction_10m.push(0);
    }
    var loc = {
      utc_offset_seconds: OFF, elevation: 1400, hourly: h,
      daily: {
        time: [T0, T0 + 86400, T0 + 2 * 86400],
        sunrise: [T0 + 5.25 * 3600, T0 + 86400 + 5.25 * 3600, T0 + 2 * 86400 + 5.25 * 3600],
        sunset: [T0 + 18.5 * 3600, T0 + 86400 + 18.5 * 3600, T0 + 2 * 86400 + 18.5 * 3600]
      }
    };
    if (edit) edit(h);
    return loc;
  }
  function at(day, hour) { return day * 24 + hour; }

  var storm = fixture(function (h) {
    [14, 15, 16, 17].forEach(function (hr) { var i = at(0, hr); h.weather_code[i] = 95; h.cape[i] = 1500; h.precipitation_probability[i] = 60; });
    h.cape[at(0, 12)] = 800; h.precipitation_probability[at(0, 12)] = 30;
    h.weather_code[at(1, 15)] = 96; h.cape[at(1, 15)] = 2200; h.precipitation_probability[at(1, 15)] = 70;
  });
  var nowNoon = T0 + 12.5 * 3600;
  var sd = W.stormDays(storm, nowNoon, C.STORM);
  eq(sd.length, 2, "storm days: today and tomorrow");
  eq(sd[0].hours.length, 24, "24 hours today");
  eq(sd[0].summary.tsCount, 4, "4 thunder hours today");
  eq(W.localHour(sd[0].summary.tsFirst, OFF), 14, "first thunder hour 14:00");
  eq(W.localHour(sd[0].summary.tsLast, OFF), 17, "last thunder hour 17:00");
  eq(sd[0].summary.hail, false, "no hail today");
  eq(sd[0].hours[12].level, 1, "12:00 is level 1 (CAPE 800, POP 30)");
  eq(sd[0].hours[11].past, true, "11:00 is past at 12:30");
  eq(sd[0].hours[12].past, false, "12:00 is not past at 12:30 (still running)");
  eq(sd[1].summary.hail, true, "hail tomorrow (code 96)");
  eq(sd[1].summary.maxCape, 2200, "tomorrow max CAPE");
  eq(sd[1].summary.maxLevel, 3, "tomorrow max level");

  // night window
  var day = fixture();
  var w1 = W.nightWindow(day, T0 + 10 * 3600);
  eq(w1.start, T0 + 18.5 * 3600, "at 10:00 the night starts at today's sunset");
  eq(w1.end, T0 + 86400 + 5.25 * 3600, "and ends at tomorrow's sunrise");
  eq(w1.running, false, "and isn't running yet");
  eq(W.nightWindow(day, T0 + 20 * 3600).running, true, "at 20:00 the night is running");
  var w3 = W.nightWindow(day, T0 + 3 * 3600);
  eq(w3.end, T0 + 5.25 * 3600, "at 03:00 the night ends at today's sunrise");
  eq(w3.running, true, "at 03:00 the night is running");

  // night summary: cold, wet, windy, clear-ish
  var cold = fixture(function (h) {
    for (var hr = 18; hr < 24; hr++) { h.temperature_2m[at(0, hr)] = 8; h.apparent_temperature[at(0, hr)] = 5; h.cloud_cover[at(0, hr)] = 10; }
    for (hr = 0; hr < 6; hr++) { h.temperature_2m[at(1, hr)] = 6; h.apparent_temperature[at(1, hr)] = 2; h.cloud_cover[at(1, hr)] = 10; }
    h.temperature_2m[at(1, 4)] = 3; h.wind_speed_10m[at(1, 4)] = 20; h.apparent_temperature[at(1, 4)] = -1;
    h.precipitation[at(0, 21)] = 1.5; h.precipitation_probability[at(0, 21)] = 70; h.wind_gusts_10m[at(0, 21)] = 40;
  });
  var ns = W.nightSummary(cold, T0 + 10 * 3600, C.NIGHT);
  eq(ns.low, 3, "night low 3 degC");
  eq(W.localHour(ns.lowAt, OFF), 4, "low at 04:00");
  eq(ns.feelsMin, -1, "feels-like min -1");
  near(ns.windChill, 13.12 + 0.6215 * 3 - 11.37 * Math.pow(20, 0.16) + 0.3965 * 3 * Math.pow(20, 0.16), 1e-9, "wind chill at the coldest windy hour");
  near(ns.rain, 1.5, 1e-9, "night rain 1.5 mm");
  eq(ns.gustMax, 40, "night max gust");
  eq(ns.hours, 12, "sunset 18:30 to sunrise 05:15 touches the 12 hours 18:00 to 05:00");
  var keys = ns.flags.map(function (f) { return f.key; }).join(",");
  eq(keys, "vcold,wetwind,clear", "flags: very cold, wet + wind, clear");
  eq(ns.level, 3, "night level 3");

  var mild = W.nightSummary(day, T0 + 10 * 3600, C.NIGHT);
  eq(mild.flags.length, 0, "mild cloudy dry night has no flags");
  eq(mild.windChill, null, "no wind chill at 15 degC");

  // while the night is running, only hours still to come count
  var late = W.nightSummary(cold, T0 + 86400 + 4.5 * 3600, C.NIGHT);
  eq(late.hours, 2, "at 04:30 the rest of the night is the 04:00 and 05:00 hours");
  eq(late.rain, 0, "the evening's rain no longer counts at 04:30");

  // tile colours on the area cards
  eq(W.coldLevel(6, C.NIGHT), 0, "6 degC: no cold colour");
  eq(W.coldLevel(5, C.NIGHT), 2, "5 degC: cold (orange)");
  eq(W.coldLevel(0, C.NIGHT), 3, "0 degC: very cold (red)");
  eq(W.coldLevel(null, C.NIGHT), 0, "no value: no colour");
  var nl = W.nightLevels(ns, C.NIGHT);
  eq([nl.low, nl.feels, nl.chill, nl.rain, nl.gust, nl.clear].join(","), "2,3,3,3,3,1",
     "cold wet windy clear night: low orange, feels/chill red, rain + gust red (wet + wind), clear yellow");
  var ml = W.nightLevels(mild, C.NIGHT);
  eq([ml.low, ml.feels, ml.chill, ml.rain, ml.gust, ml.clear].join(","), "0,0,0,0,0,0", "mild night: no tile colours");
  var dryWindy = W.nightLevels({ low: 10, feelsMin: 9, windChill: null, rain: 0, popMax: 10, gustMax: 35, cloudAvg: 60 }, C.NIGHT);
  eq(dryWindy.gust + "," + dryWindy.rain, "1,0", "dry windy night: gust yellow only");
  var cur = { wind_gusts_10m: 12, visibility: 800 };
  var nw0 = W.nowLevels(cur, { rain: 0.2, popMax: 55, gustMax: 31 }, C.NIGHT, C.NOW);
  eq(nw0.gust + "," + nw0.rain + "," + nw0.vis, "1,1,2", "now: 24 h gust 31 yellow, 55% rain yellow, 800 m visibility orange");
  var nw1 = W.nowLevels({ wind_gusts_10m: 12, visibility: 20000 }, { rain: 0, popMax: 0, gustMax: 20 }, C.NIGHT, C.NOW);
  eq(nw1.gust + "," + nw1.rain + "," + nw1.vis, "0,0,0", "now: calm, dry, clear: no colours");

  // next 24 h
  var rainy = fixture(function (h) { h.precipitation[at(0, 13)] = 2; h.precipitation[at(1, 12)] = 3; h.precipitation[at(1, 13)] = 4; h.weather_code[at(1, 11)] = 95; });
  var n = W.next24(rainy, T0 + 13.2 * 3600);
  eq(n.idx.length, 24, "next 24 h has 24 hours");
  eq(n.idx[0], at(0, 13), "starts at the current hour");
  near(n.rain, 5, 1e-9, "rain in next 24 h counts 13:00 today to 12:00 tomorrow");
  eq(n.thunder, true, "thunder in next 24 h");
  eq(W.currentIndex(rainy, T0 - 10), -1, "no current hour before the data starts");

  // ---------------------------------------------------------------- refresh timing
  var F = window.SARWX_REFRESH.fetchWait, NOW = 1793690000000, MIN = 60000;
  function fw(o) { o.now = NOW; o.cfg = C; return F(o); }
  eq(fw({ dataAt: 0, lastAttempt: 0, failures: 0 }), 0, "first visit: fetch now");
  eq(fw({ dataAt: 0, lastAttempt: NOW - 60 * MIN, failures: 0 }), 0, "no data, old attempt: fetch now");
  eq(fw({ dataAt: 0, lastAttempt: NOW - 1 * MIN, failures: 0 }), 0,
     "no data after a reload cut off a request 1 min ago: fetch now (was a 14-min wait, the stuck 'Waiting for forecast data' bug)");
  eq(fw({ dataAt: 0, lastAttempt: NOW - 10000, failures: 0 }), 20000, "no data: at most one attempt per 30 s");
  eq(fw({ dataAt: 0, lastAttempt: NOW, failures: 1 }), 1 * MIN, "no data, 1 failure: retry in 1 min");
  eq(fw({ dataAt: 0, lastAttempt: NOW, failures: 3 }), 4 * MIN, "no data, 3 failures: retry in 4 min");
  eq(fw({ dataAt: 0, lastAttempt: NOW, failures: 9 }), C.REFRESH_MIN * MIN, "no data, many failures: back off to the normal interval");
  eq(fw({ dataAt: NOW - 5 * MIN, lastAttempt: NOW - 5 * MIN, failures: 0 }), (C.REFRESH_MIN - 5) * MIN, "data 5 min old: wait for the normal interval");
  eq(fw({ dataAt: NOW - 20 * MIN, lastAttempt: NOW - 20 * MIN, failures: 0 }), 0, "data 20 min old: fetch now");
  eq(fw({ dataAt: NOW - 20 * MIN, lastAttempt: NOW - 2 * MIN, failures: 1 }), (C.REFRESH_MIN - 2) * MIN, "data on screen, last attempt failed 2 min ago: normal interval from the attempt");
  eq(fw({ dataAt: NOW - 5 * MIN, lastAttempt: NOW - 5 * MIN, failures: 0, force: true }), (C.MIN_MANUAL_MIN - 5) * MIN, "Refresh button with data: manual minimum");
  eq(fw({ dataAt: 0, lastAttempt: NOW - 1 * MIN, failures: 0, force: true }), 0, "Refresh button with no data: allowed");

  // ---------------------------------------------------------------- radar loop frames
  var LF = window.SARWX_REFRESH.loopFrames, L = C.LOOP;
  function ago(m) { return NOW - m * MIN; }
  eq(JSON.stringify(LF([], NOW, L)), "[]", "loop: no saved copies, no older frames");
  eq(JSON.stringify(LF([ago(0.1)], NOW, L)), "[]", "loop: the copy of the image on screen isn't used twice");
  eq(JSON.stringify(LF([ago(0.1), ago(15), ago(30), ago(45)], NOW, L)), JSON.stringify([ago(30), ago(15)]),
     "loop: 15-min reloads give the two before the one on screen, oldest first");
  eq(JSON.stringify(LF([ago(45), ago(15), ago(30)], NOW, L)), JSON.stringify([ago(30), ago(15)]), "loop: order of the saved list doesn't matter");
  eq(JSON.stringify(LF([ago(4), ago(12), ago(16), ago(25)], NOW, L)), JSON.stringify([ago(25), ago(12)]),
     "loop: copies under " + L.gapMin + " min apart are skipped (quick Refresh presses)");
  eq(JSON.stringify(LF([ago(20), ago(L.maxAgeMin + 5)], NOW, L)), JSON.stringify([ago(20)]),
     "loop: copies over " + L.maxAgeMin + " min older than the one on screen are left out (page was closed)");
  eq(JSON.stringify(LF([ago(15), "x", null], NOW, L)), JSON.stringify([ago(15)]), "loop: junk in the saved list is ignored");
  var SL = window.SARWX_REFRESH.serverLoop;
  function fr(m, t) { return { f: "IRS50-" + ago(m) + ".gif", at: ago(m), t: t === undefined ? ago(m + 2) : t, h: "x" }; }
  function names(list) { return list.map(function (x) { return x.f === null ? "screen" : Math.round((NOW - x.at) / MIN) + "m"; }).join(","); }
  eq(names(SL({ checked: ago(1), frames: [fr(30), fr(15), fr(1)] }, ago(0.5), NOW, L)), "30m,15m,1m",
     "server loop: the three frames GitHub kept, oldest first");
  eq(names(SL({ checked: ago(1), frames: [fr(1), fr(30), fr(15)] }, ago(0.5), NOW, L)), "30m,15m,1m", "server loop: list order doesn't matter");
  eq(SL({ checked: ago(1), frames: [fr(1)] }, ago(0.5), NOW, L)[0].t, ago(3), "server loop: keeps the time printed on the image");
  eq(names(SL({ checked: ago(14), frames: [fr(44), fr(29), fr(14)] }, ago(0.5), NOW, L)), "29m,14m,screen",
     "server loop: the FlyWatch image on screen goes last when loaded " + L.gapMin + "+ min after the last run");
  eq(names(SL({ checked: ago(14), frames: [fr(44), fr(29), fr(14)] }, ago(0.5), NOW, L, true)), "44m,29m,14m",
     "server loop: not for the site's own mosaic (the image on screen is the newest frame)");
  eq(names(SL({ checked: ago(5), frames: [fr(200), fr(120), fr(5)] }, ago(0.5), NOW, L)), "5m",
     "server loop: frames fetched over " + L.maxAgeMin + " min ago are left out");
  eq(names(SL({ checked: ago(5), frames: [{ f: "../x.gif", at: ago(10) }, { f: "a.gif", at: "x" }, null, fr(5)] }, 0, NOW, L)), "5m",
     "server loop: bad entries are ignored (no paths, numbers only)");
  eq(SL(undefined, 0, NOW, L).length, 0, "server loop: no entry, no frames");
  report(L.frames === 3 && L.keep >= L.frames && L.maxAgeMin >= (L.frames - 1) * C.REFRESH_MIN,
         "loop: 3 frames, enough copies kept, age limit covers 15-min reloads");

  // config sanity
  var ids = {};
  C.LOCATIONS.forEach(function (l) { ids[l.id] = (ids[l.id] || 0) + 1; });
  report(Object.keys(ids).every(function (k) { return ids[k] === 1; }), "location ids are unique");
  report(C.LOCATIONS.every(function (l) { return l.lat < -24 && l.lat > -28 && l.lon > 26 && l.lon < 30; }), "every location is in greater Gauteng");
  report(C.LOCATIONS.some(function (l) { return l.id === C.ASTRO_DEFAULT; }), "astro default is a location id");
  report(C.RADAR_STALE_MIN >= 10 && C.RADAR_STALE_MIN <= 120, "radar stale cutoff is a sensible number of minutes");
  report(C.REFRESH_MIN >= 10 && C.REFRESH_MIN <= 15 && C.MIN_MANUAL_MIN >= 10, "refresh interval is 10–15 min, manual at least 10");
  var allUrls = [].concat(C.IMAGES, [{ url: C.RADAR_SOURCE_PAGE }]).map(function (x) { return x.url; }).filter(Boolean);
  report(allUrls.every(function (u) { return /^https:\/\//.test(u) || /^[\w-]+\/[\w.-]+$/.test(u); }), "all links and images are https (or this site's own files)");
  report(C.IMAGES.every(function (x) { return !!x.own === !/^https:/.test(x.url); }), "images marked own are exactly the site's own files");
  report(allUrls.every(function (u) { return u.indexOf("aviation.weathersa.co.za") < 0; }), "nothing points at the SAWS aviation site (owner's rule)");

  $("summary").textContent = fail ? (fail + " FAILED, " + pass + " passed") : ("ALL PASSED (" + pass + ")");
})();
