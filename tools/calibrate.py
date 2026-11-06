"""Place each radar by lining up the road map on its image with a neighbour's.

Usage: python tools/calibrate.py <dir with IRS.gif, OTS.gif, ...> [FILE=REFFILE ...]
       e.g.  OTS.gif=IRS.gif EO.gif=IRS.gif PP.gif=IRS.gif BLS.gif=OTS.gif
       FILE=REF:0.4 searches +-0.4 deg instead of 0.15 (start far off)

Roads and borders are geography, so they are the same on every radar's image
(stale ones included). For each pair, B's position is searched around its value
in radar.py so that B's roads land on A's roads in the overlap. Prints the best
position, how much it moved, and the match score (share of B's road pixels that
fall on A's roads) before and after. Copy good results into RADARS in radar.py.
radar.py also calls fit() by itself for radars still marked uncalibrated (see
auto_calibrate there).
"""
import os
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
import radar as R  # noqa: E402


def load(d, f):
    rgb = np.array(Image.open(os.path.join(d, f)).convert("RGB"))
    c = R.find_centre(rgb)
    if c is None:
        raise SystemExit(f"{f}: not a readable radar image")
    road, border = R.map_layer(rgb)
    return c, road | border


def render(mask, centre, lat0, lon0, glat, glon):
    x, y = R.aeqd_fwd(lat0, lon0, glat, glon)
    sx = np.round(centre[0] + x * R.KM_PX - 0.5).astype(int)
    sy = np.round(centre[1] - y * R.KM_PX - 0.5).astype(int)
    ok = (sx >= R.PLOT[0]) & (sx <= R.PLOT[2]) & (sy >= R.PLOT[1]) & (sy <= R.PLOT[3])
    out = np.zeros(glat.shape, bool)
    out[ok] = mask[sy[ok], sx[ok]]
    return out, ok


def dilate(m):
    p = np.pad(m, 1)
    h, w = m.shape
    return np.any(np.stack([p[1 + dy:h + 1 + dy, 1 + dx:w + 1 + dx] for dy in (-1, 0, 1) for dx in (-1, 0, 1)]), axis=0)


def fit(ref, new, span0=0.15):
    """ref, new: (centre, map mask, lat, lon). Searches new's position so its
    roads land on ref's. Returns (match before, match after, lat, lon), or None
    if the two boxes hardly overlap."""
    (ca, ma, la, oa), (cb, mb, lb, ob) = ref, new
    # grid: 0.5 km, AEQD at the midpoint, covering both boxes
    mlat, mlon = (la + lb) / 2, (oa + ob) / 2
    xs = np.arange(-450, 450, 0.5)
    gx, gy = np.meshgrid(xs, -xs)
    glat, glon = R.aeqd_inv(mlat, mlon, gx, gy)
    ra, oka = render(ma, ca, la, oa, glat, glon)
    # keep only the overlap's bounding box to make the search fast
    _, okb0 = render(mb, cb, lb, ob, glat, glon)
    both = oka & okb0
    if both.sum() < 1000:
        return None
    rows, cols = np.where(both)
    sl = (slice(rows.min(), rows.max() + 1), slice(cols.min(), cols.max() + 1))
    glat, glon, ra, oka = glat[sl], glon[sl], ra[sl], oka[sl]
    ta = dilate(ra)

    def score(lat, lon):
        rb, okb = render(mb, cb, lat, lon, glat, glon)
        rb &= oka
        n = rb.sum()
        return (rb & ta).sum() / n if n else 0

    s0 = score(lb, ob)
    best = (s0, lb, ob)
    for step, span in ((max(0.01, span0 / 15), span0), (0.002, 0.012), (0.0005, 0.0025)):
        c_lat, c_lon = best[1], best[2]
        for dl in np.arange(-span, span + 1e-9, step):
            for do in np.arange(-span, span + 1e-9, step):
                s = score(c_lat + dl, c_lon + do)
                if s > best[0]:
                    best = (s, c_lat + dl, c_lon + do)
    return (s0,) + best


def main():
    d = sys.argv[1]
    pos = {f: [lat, lon] for f, _, lat, lon, _ in R.RADARS}
    for pair in sys.argv[2:]:
        b, a = pair.split("=")
        a, _, span0 = a.partition(":")
        ca, ma = load(d, a)
        cb, mb = load(d, b)
        lb, ob = pos[b]
        r = fit((ca, ma) + tuple(pos[a]), (cb, mb, lb, ob), float(span0 or 0.15))
        if r is None:
            print(pair, "no overlap")
            continue
        s0, s, lat, lon = r
        km_n, km_e = (lat - lb) * 111.2, (lon - ob) * 111.2 * np.cos(np.radians(lat))
        print(f"{b} vs {a}: {lat:.4f}, {lon:.4f}  (moved {km_n:+.1f} km N, {km_e:+.1f} km E)  match {s0:.2f} -> {s:.2f}")
        pos[b] = [lat, lon]


if __name__ == "__main__":
    main()
