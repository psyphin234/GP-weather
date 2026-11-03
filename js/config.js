/* SAR Weather: Greater Gauteng. Everything you are likely to edit lives here.
   Plain script (no modules), so the page also opens straight from disk. */
(function () {
  "use strict";

  // ---- SAR areas -----------------------------------------------------------
  // One row per point forecast. Add, remove or reorder freely: every panel
  // follows this list, and all of them go in ONE Open-Meteo request.
  //   id    short unique key (used for the page's own links and storage)
  //   name  shown on the forecast cards
  //   short shown in the narrow storm grid and night table (keep it under ~10 chars)
  //   lat, lon  decimal degrees (south and west are negative)
  var LOCATIONS = [
    { id: "magalies", name: "Magaliesberg",            short: "Magalies", lat: -25.81, lon: 27.55 },
    { id: "hbp",      name: "Hartbeespoort",           short: "H'poort",   lat: -25.74, lon: 27.85 },
    { id: "cradle",   name: "Cradle of Humankind",     short: "Cradle",    lat: -25.97, lon: 27.73 },
    { id: "kdorp",    name: "Krugersdorp",             short: "K'dorp",    lat: -26.09, lon: 27.75 },
    { id: "pta",      name: "Pretoria",                short: "Pretoria",  lat: -25.746, lon: 28.188 },
    { id: "jhb",      name: "Johannesburg",            short: "Joburg",    lat: -26.204, lon: 28.047 }
  ];

  // Sun and moon times: computed on the device for the area picked in that
  // panel (default below). Across Gauteng they differ by only a few minutes.
  var ASTRO_DEFAULT = "pta";

  // ---- refresh rules ---------------------------------------------------------
  // At most one Open-Meteo request per REFRESH_MIN minutes, and only while the
  // tab is visible. The Refresh button stays off until MIN_MANUAL_MIN have passed.
  var REFRESH_MIN = 15;
  var MIN_MANUAL_MIN = 10;

  // ---- thunderstorm risk, per hour ------------------------------------------
  // 3 = model forecasts a thunderstorm (WMO weather_code 95, 96 or 99)
  // 2 = CAPE >= cape2 AND rain chance >= pop2
  // 1 = CAPE >= cape1 AND rain chance >= pop1
  // 0 = anything else
  var STORM = { cape1: 500, pop1: 20, cape2: 1000, pop2: 40 };

  // ---- night survivability flags ---------------------------------------------
  var NIGHT = {
    cold: 5,          // feels-like at or below this (degC): "Cold"
    veryCold: 0,      // feels-like at or below this: "Very cold"
    wetMm: 1,         // rain over the night at or above this (mm): "Wet"
    wetPop: 50,       // or a rain chance at or above this (%)
    windyGust: 30,    // gusts at or above this (km/h) make "Wet + wind"
    clearCloud: 25    // average cloud cover below this (%): "Clear sky"
  };

  // ---- area cards: tile colours ----------------------------------------------
  // Gust, rain and cold tiles use the NIGHT thresholds above. Visibility:
  var NOW = {
    lowVisKm: 1       // visibility now below this (km): orange tile
  };

  // ---- SAWS images via FlyWatch ----------------------------------------------------
  // SAWS charts as re-published without a login by FlyWatch (Africa Flight Group);
  // its page lists them at /api/weather/images/<group> with source "WeatherSA".
  // Shown as plain <img>s, reloaded at most every REFRESH_MIN minutes while the tab
  // is visible; tap one to see it full screen. (SAWS's own aviation site can't be
  // embedded: login + SameSite=Strict session cookie, checked 2026-11-03.)
  //   panel  which panel it goes in: "storm" or "radar"
  //   w, h   the image's size in pixels (reserves the space while it loads)
  //   daily  a chart for today only: a saved copy from an earlier day says so
  var FW = "https://www.flywatch.com/api/weather/images/individual/";
  var IMAGES = [
    { panel: "storm", title: "SAWS TS probability", url: FW + "tsprob_d1.gif", w: 800, h: 600, daily: true },
    { panel: "radar", title: "Irene 50 km",  url: FW + "IRS50.gif", w: 750, h: 691 },
    { panel: "radar", title: "Irene 300 km", url: FW + "IRS.gif",   w: 750, h: 691 }
  ];
  var RADAR_SOURCE_PAGE = "https://www.flywatch.com/tracking/weather/radar";

  // The radar banner says an image stamped more than this many minutes ago is stale.
  // (The page can't read the image time itself; the reader compares.)
  var RADAR_STALE_MIN = 30;

  window.SARWX_CONFIG = {
    LOCATIONS: LOCATIONS,
    ASTRO_DEFAULT: ASTRO_DEFAULT,
    REFRESH_MIN: REFRESH_MIN,
    MIN_MANUAL_MIN: MIN_MANUAL_MIN,
    STORM: STORM,
    NIGHT: NIGHT,
    NOW: NOW,
    IMAGES: IMAGES,
    RADAR_SOURCE_PAGE: RADAR_SOURCE_PAGE,
    RADAR_STALE_MIN: RADAR_STALE_MIN,
    TIMEZONE: "Africa/Johannesburg"
  };
})();
