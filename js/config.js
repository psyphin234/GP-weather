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
  //   note  optional, shown under the card's name
  var LOCATIONS = [
    { id: "magalies", name: "Magaliesberg (Tonquani / Hekpoort)", short: "Magalies", lat: -25.81, lon: 27.55,
      note: "Kloofs and the valley floor can be much colder than this on clear, calm nights" },
    { id: "hbp",      name: "Hartbeespoort",           short: "H'poort",   lat: -25.74, lon: 27.85 },
    { id: "cradle",   name: "Cradle of Humankind",     short: "Cradle",    lat: -25.97, lon: 27.73 },
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

  // Radar panel buttons. SAWS images can't be embedded (login + SameSite=Strict
  // session cookie, checked 2026-11-03), so they are links that open on SAWS.
  var RADAR_LINKS = [
    { label: "SAWS aviation radar: Irene (login)", url: "https://aviation.weathersa.co.za/ftpfile.php?f=IRS.gif&type=RADAR" },
    { label: "Windy: satellite over Gauteng", url: "https://www.windy.com/-Satellite-satellite?satellite,-26.000,28.000,8" },
    { label: "Windy: thunderstorm / CAPE layer", url: "https://www.windy.com/-CAPE-Index-cape?cape,-26.000,28.000,8" }
  ];

  // When the link panels were last checked by hand (shown as their "last updated").
  var LINKS_CHECKED = "2026-11-03";

  window.SARWX_CONFIG = {
    LOCATIONS: LOCATIONS,
    ASTRO_DEFAULT: ASTRO_DEFAULT,
    REFRESH_MIN: REFRESH_MIN,
    MIN_MANUAL_MIN: MIN_MANUAL_MIN,
    STORM: STORM,
    NIGHT: NIGHT,
    RADAR_LINKS: RADAR_LINKS,
    LINKS_CHECKED: LINKS_CHECKED,
    TIMEZONE: "Africa/Johannesburg"
  };
})();
