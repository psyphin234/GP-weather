/* Sun and moon, computed on the device (no network).
   Low-precision formulas from Jean Meeus, "Astronomical Algorithms", in the
   compact form popularised by SunCalc (V. Agafonkin, BSD-2). Good to a minute
   or two for the sun, about 10 minutes for moonrise/set, a few hours for phase dates.
   Checked against PyEphem in tests/astro.test.js. */
(function () {
  "use strict";

  var PI = Math.PI, sin = Math.sin, cos = Math.cos, tan = Math.tan,
      asin = Math.asin, acos = Math.acos, atan = Math.atan2,
      rad = PI / 180, dayMs = 864e5, J1970 = 2440588, J2000 = 2451545,
      e = rad * 23.4397; // obliquity of the Earth

  function toJulian(date) { return date.valueOf() / dayMs - 0.5 + J1970; }
  function fromJulian(j) { return new Date((j + 0.5 - J1970) * dayMs); }
  function toDays(date) { return toJulian(date) - J2000; }

  function rightAscension(l, b) { return atan(sin(l) * cos(e) - tan(b) * sin(e), cos(l)); }
  function declination(l, b) { return asin(sin(b) * cos(e) + cos(b) * sin(e) * sin(l)); }
  function altitude(H, phi, dec) { return asin(sin(phi) * sin(dec) + cos(phi) * cos(dec) * cos(H)); }
  function siderealTime(d, lw) { return rad * (280.16 + 360.9856235 * d) - lw; }
  function astroRefraction(h) {
    if (h < 0) h = 0; // formula is for h >= 0; below that it would blow up
    return 0.0002967 / tan(h + 0.00312536 / (h + 0.08901179));
  }

  // ---- sun ----------------------------------------------------------------
  function solarMeanAnomaly(d) { return rad * (357.5291 + 0.98560028 * d); }
  function eclipticLongitude(M) {
    var C = rad * (1.9148 * sin(M) + 0.02 * sin(2 * M) + 0.0003 * sin(3 * M)),
        P = rad * 102.9372; // perihelion of the Earth
    return M + C + P + PI;
  }
  function sunCoords(d) {
    var L = eclipticLongitude(solarMeanAnomaly(d));
    return { dec: declination(L, 0), ra: rightAscension(L, 0) };
  }

  var J0 = 0.0009;
  function julianCycle(d, lw) { return Math.round(d - J0 - lw / (2 * PI)); }
  function approxTransit(Ht, lw, n) { return J0 + (Ht + lw) / (2 * PI) + n; }
  function solarTransitJ(ds, M, L) { return J2000 + ds + 0.0053 * sin(M) - 0.0069 * sin(2 * L); }
  function hourAngle(h, phi, d) { return acos((sin(h) - sin(phi) * sin(d)) / (cos(phi) * cos(d))); }

  /* Sun events for the solar day nearest `date` (pass local noon).
     Returns Dates: dawn (civil, -6 deg), sunrise, noon, sunset, dusk. */
  function sunTimes(date, lat, lng) {
    var lw = rad * -lng, phi = rad * lat,
        d = toDays(date), n = julianCycle(d, lw), ds = approxTransit(0, lw, n),
        M = solarMeanAnomaly(ds), L = eclipticLongitude(M), dec = declination(L, 0),
        Jnoon = solarTransitJ(ds, M, L);
    function pair(h) {
      var w = hourAngle(h * rad, phi, dec);
      if (isNaN(w)) return [null, null]; // sun never reaches that altitude (not in Gauteng)
      var Jset = solarTransitJ(approxTransit(w, lw, n), M, L);
      return [fromJulian(Jnoon - (Jset - Jnoon)), fromJulian(Jset)];
    }
    var rs = pair(-0.833), civ = pair(-6);
    return { dawn: civ[0], sunrise: rs[0], noon: fromJulian(Jnoon), sunset: rs[1], dusk: civ[1] };
  }

  // ---- moon -----------------------------------------------------------------
  function moonCoords(d) {
    var L = rad * (218.316 + 13.176396 * d),  // ecliptic longitude
        M = rad * (134.963 + 13.064993 * d),  // mean anomaly
        F = rad * (93.272 + 13.229350 * d),   // mean distance
        l = L + rad * 6.289 * sin(M),
        b = rad * 5.128 * sin(F),
        dt = 385001 - 20905 * cos(M);         // distance to the moon, km
    return { ra: rightAscension(l, b), dec: declination(l, b), dist: dt };
  }

  function moonAltitude(date, lat, lng) {
    var lw = rad * -lng, phi = rad * lat, d = toDays(date),
        c = moonCoords(d), H = siderealTime(d, lw) - c.ra,
        h = altitude(H, phi, c.dec);
    return h + astroRefraction(h);
  }

  /* Illumination: fraction lit (0..1) and phase (0 new, 0.25 first quarter,
     0.5 full, 0.75 last quarter). */
  function moonIllumination(date) {
    var d = toDays(date), s = sunCoords(d), m = moonCoords(d), sdist = 149598000,
        phi = acos(sin(s.dec) * sin(m.dec) + cos(s.dec) * cos(m.dec) * cos(s.ra - m.ra)),
        inc = atan(sdist * sin(phi), m.dist - sdist * cos(phi)),
        angle = atan(cos(s.dec) * sin(s.ra - m.ra),
                     sin(s.dec) * cos(m.dec) - cos(s.dec) * sin(m.dec) * cos(s.ra - m.ra));
    return {
      fraction: (1 + cos(inc)) / 2,
      phase: 0.5 + 0.5 * inc * (angle < 0 ? -1 : 1) / PI
    };
  }

  /* Moonrise and moonset in the 24 h from `start`: the altitude is sampled every
     hour and each crossing of the horizon (0.133 deg, centre of the disc with
     parallax) is found by fitting a parabola through three samples. */
  function moonTimes(start, lat, lng) {
    var t0 = start.valueOf(), hc = 0.133 * rad, rise = null, set = null, ye, x1, x2, i;
    function at(hours) { return moonAltitude(new Date(t0 + hours * 36e5), lat, lng) - hc; }
    var h0 = at(0);
    for (i = 1; i <= 24; i += 2) {
      var h1 = at(i), h2 = at(i + 1),
          a = (h0 + h2) / 2 - h1, b = (h2 - h0) / 2,
          xe = -b / (2 * a), roots = 0, dx;
      ye = (a * xe + b) * xe + h1;
      var dsc = b * b - 4 * a * h1;
      if (dsc >= 0) {
        dx = Math.sqrt(dsc) / (Math.abs(a) * 2);
        x1 = xe - dx; x2 = xe + dx;
        if (Math.abs(x1) <= 1) roots++;
        if (Math.abs(x2) <= 1) roots++;
        if (x1 < -1) x1 = x2;
      }
      if (roots === 1) {
        if (h0 < 0) { if (rise === null) rise = i + x1; }
        else if (set === null) set = i + x1;
      } else if (roots === 2) {
        if (rise === null) rise = i + (ye < 0 ? x2 : x1);
        if (set === null) set = i + (ye < 0 ? x1 : x2);
      }
      if (rise !== null && set !== null) break;
      h0 = h2;
    }
    return {
      rise: rise === null ? null : new Date(t0 + rise * 36e5),
      set: set === null ? null : new Date(t0 + set * 36e5)
    };
  }

  /* Next time after `from` the phase reaches `target` (0 = new, 0.5 = full),
     found by stepping 6 h and then bisecting. */
  function nextPhase(from, target) {
    var step = 6 * 36e5, t = from.valueOf(), limit = t + 32 * dayMs;
    function off(ms) { // signed distance of the phase past target, in (-0.5, 0.5]
      var x = moonIllumination(new Date(ms)).phase - target;
      x -= Math.round(x);
      return x;
    }
    var prev = off(t);
    for (var u = t + step; u <= limit; u += step) {
      var cur = off(u);
      if (prev < 0 && cur >= 0 && cur - prev < 0.5) {
        var lo = u - step, hi = u;
        for (var k = 0; k < 30; k++) {
          var mid = (lo + hi) / 2;
          if (off(mid) < 0) lo = mid; else hi = mid;
        }
        return new Date((lo + hi) / 2);
      }
      prev = cur;
    }
    return null;
  }

  /* The four main phases are named within about a day (0.034 of a cycle) of the
     exact moment; in between the moon is a crescent or gibbous. */
  function phaseName(phase) {
    var p = ((phase % 1) + 1) % 1, near = 0.034;
    if (p < near || p > 1 - near) return "New moon";
    if (Math.abs(p - 0.25) < near) return "First quarter";
    if (Math.abs(p - 0.5) < near) return "Full moon";
    if (Math.abs(p - 0.75) < near) return "Last quarter";
    if (p < 0.25) return "Waxing crescent";
    if (p < 0.5) return "Waxing gibbous";
    if (p < 0.75) return "Waning gibbous";
    return "Waning crescent";
  }

  window.SARWX_ASTRO = {
    sunTimes: sunTimes,
    moonTimes: moonTimes,
    moonIllumination: moonIllumination,
    moonAltitude: moonAltitude,
    nextPhase: nextPhase,
    phaseName: phaseName
  };
})();
