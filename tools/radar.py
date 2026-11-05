"""Radar frames and the Gauteng radar mosaic, built by the Pages workflow.

Runs on GitHub Actions every 15 min (.github/workflows/pages.yml); nothing runs
on the phones for this. For each run it:
  1. reads the last run's radar/frames.json from the live site, and copies the
     frames it lists back into the new site folder (so nothing is committed);
  2. fetches the Irene 50 km and 300 km images from FlyWatch and keeps the last
     LOOP_KEEP different ones (byte-identical images are skipped);
  3. fetches every SAWS 300 km radar near Gauteng, reads the time printed on each,
     and stitches them into one image (radar/mosaic-<ms>.png), also kept as a loop.
     Radars older than STALE_MIN are still drawn where no fresh radar covers, but
     outlined with "OLD" across them (owner, 2026-11-05).

Usage: python tools/radar.py <site-dir>          (needs Pillow + numpy)
       python tools/radar.py <site-dir> --local <dir-with-gifs>   (no network; tests)

The SAWS images (via FlyWatch) are TITAN plots: 750x691, a km grid centred on the
radar, 76.6 px per 50 km ring, axis lines drawn in forest green, time printed top
left in an 8-px bitmap font. All of this was measured on 2026-11-05; if SAWS
changes the layout, an image fails the checks below and is left out (listed as
"unreadable" in the caption) rather than drawn in the wrong place.
"""
import hashlib
import io
import json
import math
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone

import numpy as np
from PIL import Image, ImageDraw, ImageFont

SITE = "https://psyphin.co.za/GP-weather/"
FW = "https://www.flywatch.com/api/weather/images/individual/"
UA = "Mozilla/5.0 (compatible; GP-weather radar mosaic; +https://psyphin.co.za/GP-weather/)"

LOOP_KEEP = 3          # frames kept per image (the page loops them)
STALE_MIN = 30         # a radar image older than this is drawn as OLD
LOOPED = ["IRS50.gif", "IRS.gif"]   # FlyWatch images the page shows and loops

# Radar sites, as placed on 2026-11-05: Ottosdal, Polokwane and Ermelo by lining
# up the roads drawn on their images with Irene's (tools/calibrate.py: 100 % of
# road pixels matched), then all of them moved together by 1.1 km N, 1.4 km W so
# the red national borders on the images match Natural Earth's (87-95 % of border
# points within 1 px). Bloemfontein: border match on its own (93 %), agrees with
# its road match against Ottosdal to ~2 km. Bethlehem and Skukuza only showed
# "No data available" that day, so their positions are guesses (calibrated=False;
# the mosaic caption marks them "approx."). Recalibrate when they come back.
RADARS = [
    # file,     name,            lat,       lon,      calibrated
    ("IRS.gif", "Irene",        -25.9067,  28.2027,  True),
    ("OTS.gif", "Ottosdal",     -26.7287,  26.0827,  True),
    ("PP.gif",  "Polokwane",    -23.8925,  29.4950,  True),
    ("EO.gif",  "Ermelo",       -26.4915,  29.9725,  True),
    ("BLS.gif", "Bloemfontein", -29.1570,  26.0450,  True),
    ("BLM.gif", "Bethlehem",    -28.2500,  28.3300,  False),
    ("SZ.gif",  "Skukuza",      -24.9900,  31.5900,  False),
]

# ---------------------------------------------------------------- geometry
R_EARTH = 6371.0
KM_PX = 76.6 / 50.0           # source image scale, px per km
PLOT = (2, 57, 609, 662)      # usable plot area in the source (x0, y0, x1, y1)


def aeqd_fwd(lat0, lon0, lat, lon):
    """Azimuthal equidistant: degrees -> km east, km north of (lat0, lon0)."""
    p0, l0 = math.radians(lat0), math.radians(lon0)
    p, l = np.radians(lat), np.radians(lon)
    cosc = np.clip(math.sin(p0) * np.sin(p) + math.cos(p0) * np.cos(p) * np.cos(l - l0), -1, 1)
    c = np.arccos(cosc)
    k = np.where(c < 1e-12, 1.0, c / np.where(np.sin(c) == 0, 1, np.sin(c)))
    x = R_EARTH * k * np.cos(p) * np.sin(l - l0)
    y = R_EARTH * k * (math.cos(p0) * np.sin(p) - math.sin(p0) * np.cos(p) * np.cos(l - l0))
    return x, y


def aeqd_inv(lat0, lon0, x, y):
    """Azimuthal equidistant: km east, km north of (lat0, lon0) -> degrees."""
    p0, l0 = math.radians(lat0), math.radians(lon0)
    rho = np.hypot(x, y)
    c = rho / R_EARTH
    sinc, cosc = np.sin(c), np.cos(c)
    safe = np.where(rho == 0, 1, rho)
    p = np.arcsin(np.clip(cosc * math.sin(p0) + y * sinc * math.cos(p0) / safe, -1, 1))
    l = l0 + np.arctan2(x * sinc, rho * math.cos(p0) * cosc - y * math.sin(p0) * sinc)
    p = np.where(rho == 0, p0, p)
    l = np.where(rho == 0, l0, l)
    return np.degrees(p), np.degrees(l)


# ---------------------------------------------------------------- reading a SAWS radar image
# dBZ colour scale, bottom to top, as in the legend (level 1 = -5 dBZ ... 17 = 70+).
# Pure red (255,0,0) is both the 70+ box and the storm-track outlines/borders, so
# it isn't read as an echo; such pixels are filled from their neighbours instead.
LEGEND = [
    (191, 191, 191), (72, 61, 139), (0, 90, 17), (0, 112, 0), (28, 67, 232),
    (0, 110, 254), (110, 13, 198), (200, 14, 134), (192, 101, 135), (210, 136, 59),
    (250, 197, 49), (254, 227, 33), (254, 250, 3), (254, 154, 88), (254, 95, 37),
    (253, 52, 28), (255, 0, 0),
]
LEGEND_LABELS = ["-5", "5", "10", "20", "30", "33", "36", "39", "42", "45", "48", "51", "54", "57", "60", "65", "70"]
WHITE = (255, 255, 255)
ROAD = (255, 193, 37)
BORDER = (102, 102, 102)
AXIS = (34, 139, 34)

# Header digits, 7x9 cells at x = 8 + 8*i, rows 37..45 ("#" = dark).
GLYPHS = {
    "0": "..##...|.#..#..|#....#.|#....#.|#....#.|#....#.|#....#.|.#..#..|..##...",
    "1": "..#....|.##....|#.#....|..#....|..#....|..#....|..#....|..#....|#####..",
    "2": ".####..|#....#.|#....#.|.....#.|....#..|..##...|.#.....|#......|######.",
    "3": "######.|.....#.|....#..|...#...|..###..|.....#.|.....#.|#....#.|.####..",
    "4": "....#..|...##..|..#.#..|.#..#..|#...#..|#...#..|######.|....#..|....#..",
    "5": "######.|#......|#......|#.###..|##...#.|.....#.|.....#.|#....#.|.####..",
    "6": "..###..|.#.....|#......|#......|#.###..|##...#.|#....#.|#....#.|.####..",
    "7": "######.|.....#.|....#..|...#...|...#...|..#....|..#....|.#.....|.#.....",
    "9": ".####..|#....#.|#....#.|#...##.|.###.#.|.....#.|.....#.|....#..|.###...",
}
GLYPH_BITS = {k: v.replace("|", "") for k, v in GLYPHS.items()}


def read_time(rgb):
    """The UTC time printed top left ("2026/11/05 14:34:59"), as ms, or None.
    Digits are matched exactly; "8" (not seen when the templates were made) is
    whatever digit-shaped glyph matches none of the others."""
    h, w, _ = rgb.shape
    if (w, h) != (750, 691):
        return None
    dark = rgb[37:46].sum(axis=2) < 200
    out = ""
    for i in range(19):
        x0 = 8 + 8 * i
        bits = "".join("#" if v else "." for v in dark[:, x0:x0 + 7].reshape(-1))
        if i in (4, 7):
            out += "/"
            continue
        if i == 10:
            out += " "
            continue
        if i in (13, 16):
            out += ":"
            continue
        ch = next((k for k, v in GLYPH_BITS.items() if v == bits), None)
        if ch is None:
            # unknown glyph: an 8 if it is a closed, digit-sized shape, else unreadable
            if bits.count("#") >= 18 and bits[:7] != "......." and bits[-7:] != ".......":
                ch = "8"
            else:
                return None
        out += ch
    try:
        dt = datetime.strptime(out, "%Y/%m/%d %H:%M:%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    return int(dt.timestamp() * 1000)


def find_centre(rgb):
    """Pixel of the radar (where the green axis lines cross), checked against the
    range rings 50 km either side; None if the image doesn't have this layout."""
    plot = rgb[55:665, 0:612]
    g = np.all(plot == AXIS, axis=2)
    cx = int(np.argmax(g.sum(axis=0)))
    cy = int(np.argmax(g.sum(axis=1))) + 55
    if g[:, cx].sum() < 150 or g[cy - 55].sum() < 150:  # echoes can hide much of it
        return None

    def mid(line, c):
        # rings cross the line at c +- k*76.6 px; average the pairs that are visible
        # (pixel i spans i..i+1, so its middle is i + 0.5)
        hits = np.where(line)[0]
        got = []
        for k in (1, 2, 3):
            pair = []
            for side in (-1, 1):
                near = hits[np.abs(hits - (c + side * k * 76.6)) <= 3]
                if len(near):
                    pair.append(near.mean() + 0.5)
            if len(pair) == 2:
                got.append(sum(pair) / 2)
        return float(np.mean(got)) if len(got) >= 2 else None

    mx = mid(np.all(rgb[cy - 2, :612] == AXIS, axis=1), cx)
    my = mid(np.all(rgb[:665, cx - 2] == AXIS, axis=1), cy)
    if mx is None or my is None or abs(mx - cx - 0.5) > 2 or abs(my - cy - 0.5) > 2:
        return None
    return mx, my


def echo_levels(rgb):
    """Per-pixel dBZ level (0 = no echo) for the source image. Map overlays
    (roads, labels, rings, storm outlines) inside an echo are filled from the
    neighbouring echo so they don't punch holes in the mosaic."""
    h, w, _ = rgb.shape
    lev = np.zeros((h, w), np.int8)
    for i, c in enumerate(LEGEND[:-1]):  # not pure red, see LEGEND
        lev[np.all(rgb == c, axis=2)] = i + 1
    white = np.all(rgb == WHITE, axis=2)
    overlay = (lev == 0) & ~white
    for _ in range(4):  # lines are 1-2 px, labels up to ~8 px
        if not overlay.any():
            break
        p = np.pad(lev, 1)
        best = np.max(np.stack([p[1 + dy:h + 1 + dy, 1 + dx:w + 1 + dx]
                                for dy in (-1, 0, 1) for dx in (-1, 0, 1)]), axis=0)
        fill = overlay & (best > 0)
        lev[fill] = best[fill]
        overlay &= ~fill
    return lev


def map_layer(rgb):
    """Roads and borders drawn on the source image (geography: never stale)."""
    road = np.all(rgb == ROAD, axis=2)
    border = np.all(rgb == BORDER, axis=2)
    return road, border


# ---------------------------------------------------------------- the mosaic
# Output: azimuthal equidistant centred on Gauteng, 1 px per km.
C_LAT, C_LON = -26.0, 28.1
X_KM = (-400, 400)      # west, east of the centre
Y_KM = (420, -400)      # north (top), south (bottom)
HEAD, FOOT = 46, 40     # caption bar above, legend below (px)

# Towns to label (lat, lon). Kept sparse: at 1 px/km anything closer than ~60 km
# to another label collides.
TOWNS = [
    ("Pretoria", -25.7479, 28.2293), ("Johannesburg", -26.2041, 28.0473),
    ("Hartbeespoort", -25.7449, 27.8551),
    ("Polokwane", -23.9045, 29.4689), ("Mbombela", -25.4753, 30.9694),
    ("eMalahleni", -25.8713, 29.2332), ("Klerksdorp", -26.8521, 26.6667),
    ("Vereeniging", -26.6731, 27.9261), ("Mahikeng", -25.8560, 25.6403),
    ("Bela-Bela", -24.8849, 28.2930), ("Ermelo", -26.5333, 29.9833),
    ("Kroonstad", -27.6504, 27.2349), ("Welkom", -27.9774, 26.7351),
    ("Bethlehem", -28.2305, 28.3071), ("Harrismith", -28.2725, 29.1295),
    ("Lephalale", -23.6833, 27.7000), ("Vryburg", -26.9566, 24.7284),
    ("Standerton", -26.9333, 29.2333), ("Mashishing", -25.0960, 30.4590),
]

SAST_MS = 2 * 3600 * 1000  # South Africa has no daylight saving


def sast(ms, with_day=False, now_ms=None):
    d = datetime.fromtimestamp((ms + SAST_MS) / 1000, timezone.utc)
    if with_day and now_ms is not None:
        today = datetime.fromtimestamp((now_ms + SAST_MS) / 1000, timezone.utc).date()
        if d.date() != today:
            return "%d %s %s" % (d.day, d.strftime("%b"), d.strftime("%H:%M"))
    return d.strftime("%H:%M")


def font(size):
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # old Pillow
        return ImageFont.load_default()


def erode(m, n):
    for _ in range(n):
        p = np.pad(m, 1)
        h, w = m.shape
        m = m & p[0:h, 1:w + 1] & p[2:h + 2, 1:w + 1] & p[1:h + 1, 0:w] & p[1:h + 1, 2:w + 2]
    return m


def read_radar(b):
    """bytes -> (rgb, centre, time ms) for a usable TITAN image, else None
    (FlyWatch's "No data available" placeholder, an error page, a new layout)."""
    try:
        rgb = np.array(Image.open(io.BytesIO(b)).convert("RGB"))
    except Exception:
        return None
    if rgb.shape[:2] != (691, 750):
        return None
    c = find_centre(rgb)
    t = read_time(rgb)
    if c is None or t is None:
        return None
    return rgb, c, t


def build_mosaic(sources, now_ms):
    """sources: [{file, name, lat, lon, cal, bytes or None}] -> (PIL image, radar
    states for the caption and frames.json)."""
    xs = np.arange(X_KM[0], X_KM[1]) + 0.5
    ys = Y_KM[0] - np.arange(Y_KM[0] - Y_KM[1]) - 0.5
    gx, gy = np.meshgrid(xs, ys)
    glat, glon = aeqd_inv(C_LAT, C_LON, gx, gy)
    H, W = gx.shape

    used, states = [], []
    for s in sources:
        r = read_radar(s["bytes"]) if s.get("bytes") else None
        if r is None:
            states.append({"name": s["name"], "state": "none", "t": None})
            continue
        rgb, c, t = r
        if t > now_ms + 10 * 60000:  # a time in the future: misread, don't trust the image
            states.append({"name": s["name"], "state": "none", "t": None})
            continue
        old = now_ms - t > STALE_MIN * 60000
        x, y = aeqd_fwd(s["lat"], s["lon"], glat, glon)
        sx = np.round(c[0] + x * KM_PX - 0.5).astype(int)
        sy = np.round(c[1] - y * KM_PX - 0.5).astype(int)
        inbox = (sx >= PLOT[0]) & (sx <= PLOT[2]) & (sy >= PLOT[1]) & (sy <= PLOT[3])
        sxc, syc = np.clip(sx, 0, 749), np.clip(sy, 0, 690)
        lev = echo_levels(rgb)[syc, sxc]
        lev[lev == 1] = 0  # -5 dBZ: clear-air clutter around each radar; hides the towns
        road, border = map_layer(rgb)
        used.append(dict(s, t=t, old=old, inbox=inbox, lev=np.where(inbox, lev, 0),
                         road=inbox & road[syc, sxc], border=inbox & border[syc, sxc],
                         dist=np.where(inbox, np.hypot(x, y), np.inf)))
        states.append({"name": s["name"], "state": "old" if old else "ok", "t": t, "approx": not s["cal"]})

    any_cov = np.zeros((H, W), bool)
    fresh_cov = np.zeros((H, W), bool)
    level = np.zeros((H, W), np.int8)
    for u in used:
        any_cov |= u["inbox"]
        if not u["old"]:
            fresh_cov |= u["inbox"]
            level = np.maximum(level, u["lev"])
    # old radars: only where no current radar sees; the newer old one wins overlaps
    old_shown = []
    taken = fresh_cov.copy()
    for u in sorted([u for u in used if u["old"]], key=lambda u: -u["t"]):
        region = u["inbox"] & ~taken
        if region.sum() < 400:  # under ~20x20 km left over: nothing worth showing
            continue
        level[region] = u["lev"][region]
        taken |= region
        old_shown.append((u, region))

    # map from the nearest radar's image (roads and borders don't go stale)
    road = np.zeros((H, W), bool)
    border = np.zeros((H, W), bool)
    if used:
        near = np.argmin(np.stack([u["dist"] for u in used]), axis=0)
        for i, u in enumerate(used):
            m = near == i
            road |= m & u["road"]
            border |= m & u["border"]

    img = np.empty((H, W, 3), np.uint8)
    img[:] = (226, 228, 232)          # no radar covers this
    img[any_cov] = (255, 255, 255)
    img[road] = (246, 214, 150)
    pal = np.array([(0, 0, 0)] + LEGEND, np.uint8)
    img[level > 0] = pal[level[level > 0]]
    img[border] = (120, 120, 120)
    for u, region in old_shown:  # outline the part drawn from an old radar
        edge = u["inbox"] & ~erode(u["inbox"], 3) & ~fresh_cov
        img[edge] = (200, 0, 0)

    canvas = Image.new("RGB", (W, H + HEAD + FOOT), (255, 255, 255))
    canvas.paste(Image.fromarray(img), (0, HEAD))
    d = ImageDraw.Draw(canvas)

    def at(lat, lon):
        x, y = aeqd_fwd(C_LAT, C_LON, np.array(lat), np.array(lon))
        return float(x) - X_KM[0], Y_KM[0] - float(y) + HEAD

    f_town, f_old, f_small = font(13), font(44), font(15)
    for name, lat, lon in TOWNS:
        px, py = at(lat, lon)
        if 0 <= px < W and HEAD <= py < HEAD + H:
            d.ellipse((px - 2.5, py - 2.5, px + 2.5, py + 2.5), fill=(20, 20, 20))
            d.text((px + 5, py - 8), name, fill=(20, 20, 20), font=f_town, stroke_width=2, stroke_fill=(255, 255, 255))
    for s in used:  # sites of the radars drawn
        px, py = at(s["lat"], s["lon"])
        if 0 <= px < W and HEAD <= py < HEAD + H:
            d.polygon([(px, py - 6), (px - 5, py + 4), (px + 5, py + 4)], fill=(0, 70, 160), outline=(255, 255, 255))
    for u, region in old_shown:
        rr, cc = np.where(region)
        cy, cx = float(rr.mean()) + HEAD, float(cc.mean())
        d.text((cx, cy - 12), "OLD", fill=(200, 0, 0), font=f_old, anchor="mm", stroke_width=3, stroke_fill=(255, 255, 255))
        d.text((cx, cy + 22), u["name"] + " " + sast(u["t"], True, now_ms), fill=(200, 0, 0), font=f_small,
               anchor="mm", stroke_width=2, stroke_fill=(255, 255, 255))

    # caption: newest current time, then every radar's state
    fresh_t = [st["t"] for st in states if st["state"] == "ok"]
    title = "Radar mosaic, " + (sast(max(fresh_t)) + " SAST" if fresh_t else "no current radar")
    d.rectangle((0, 0, W, HEAD - 1), fill=(10, 22, 52))
    d.text((8, 4), title, fill=(255, 255, 255), font=font(17))
    parts = []
    for st in states:
        if st["state"] == "ok":
            parts.append(st["name"] + " " + sast(st["t"]) + (" (approx.)" if st.get("approx") else ""))
        elif st["state"] == "old":
            parts.append(st["name"] + " OLD")
        else:
            parts.append(st["name"] + " no data")
    d.text((8, 26), " · ".join(parts), fill=(200, 210, 230), font=font(12))
    # legend, scale, credit
    y0 = HEAD + H + 6
    bw = 24
    for i, (c, lab) in enumerate(zip(LEGEND[1:], LEGEND_LABELS[1:])):  # from 5 dBZ (see above)
        d.rectangle((8 + i * bw, y0, 8 + (i + 1) * bw - 1, y0 + 12), fill=c)
        if i % 2 == 0:
            d.text((8 + i * bw, y0 + 14), lab, fill=(60, 60, 60), font=font(11))
    d.text((8 + 16 * bw + 4, y0), "dBZ", fill=(60, 60, 60), font=font(11))
    sx0 = W - 230
    d.line((sx0, y0 + 6, sx0 + 100, y0 + 6), fill=(20, 20, 20), width=3)
    d.text((sx0 + 50, y0 + 10), "100 km", fill=(20, 20, 20), font=font(11), anchor="ma")
    d.text((W - 8, y0 + 4), "Data © SAWS via FlyWatch", fill=(60, 60, 60), font=font(11), anchor="ra")
    return canvas, states


# ---------------------------------------------------------------- frames + main
def get(url, timeout=30):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read()
    except Exception as e:
        print("  fetch failed:", url, e)
        return None


def is_image(b):
    return bool(b) and (b[:4] == b"GIF8" or b[:8] == b"\x89PNG\r\n\x1a\n") and len(b) > 1000


def main(argv):
    out = os.path.join(argv[0], "radar")
    os.makedirs(out, exist_ok=True)
    local = argv[argv.index("--local") + 1] if "--local" in argv else None
    prev_base = argv[argv.index("--prev") + 1] if "--prev" in argv else (None if local else SITE + "radar/")
    now = int(argv[argv.index("--now") + 1]) if "--now" in argv else int(time.time() * 1000)

    def src(name):
        if local:
            p = os.path.join(local, name)
            return open(p, "rb").read() if os.path.exists(p) else None
        return get(FW + name + "?t=" + str(now // 60000))

    def prev_file(name):
        if not prev_base:
            return None
        if prev_base.startswith("http"):
            return get(prev_base + name + ("?t=" + str(now // 60000) if name.endswith(".json") else ""))
        p = os.path.join(prev_base, name)
        return open(p, "rb").read() if os.path.exists(p) else None

    prev = {}
    pj = prev_file("frames.json")
    if pj:
        try:
            prev = json.loads(pj).get("images", {})
        except ValueError:
            prev = {}

    def carry(key):
        """last run's frames for key, if their files can be copied across"""
        kept = []
        for fr in (prev.get(key) or {}).get("frames", []):
            f = fr.get("f", "")
            if not f or "/" in f or "\\" in f or f.startswith("."):
                continue
            b = prev_file(f)
            if is_image(b):
                with open(os.path.join(out, f), "wb") as fh:
                    fh.write(b)
                kept.append(fr)
        return kept

    def add(key, frames, b, ext, t, h=None):
        h = h or hashlib.sha1(b).hexdigest()
        if not frames or frames[-1].get("h") != h:
            f = "%s-%d.%s" % (key.rsplit(".", 1)[0], now, ext)
            with open(os.path.join(out, f), "wb") as fh:
                fh.write(b)
            frames.append({"f": f, "at": now, "t": t, "h": h})
        for old in frames[:-LOOP_KEEP]:
            p = os.path.join(out, old["f"])
            if os.path.exists(p):
                os.remove(p)
        return frames[-LOOP_KEEP:]

    images, fetched = {}, {}
    for key in LOOPED:
        frames = carry(key)
        b = src(key)
        fetched[key] = b
        entry = {"frames": frames, "checked": (prev.get(key) or {}).get("checked")}
        if is_image(b):
            r = read_radar(b) if key != "IRS50.gif" else None
            t = r[2] if r else (read_time(np.array(Image.open(io.BytesIO(b)).convert("RGB"))) if key == "IRS50.gif" else None)
            entry["frames"] = add(key, frames, b, "gif", t)
            entry["checked"] = now
        images[key] = entry
        print(key, "frames:", len(entry["frames"]))

    sources = []
    for f, name, lat, lon, cal in RADARS:
        b = fetched.get(f) or src(f)
        sources.append({"file": f, "name": name, "lat": lat, "lon": lon, "cal": cal, "bytes": b if is_image(b) else None})
    frames = carry("mosaic.png")
    entry = {"frames": frames, "checked": (prev.get("mosaic.png") or {}).get("checked")}
    if any(s["bytes"] for s in sources):
        img, states = build_mosaic(sources, now)
        # a new frame only when a radar image or a radar's OLD/current state changed
        h = hashlib.sha1(b"".join(hashlib.sha1(s["bytes"] or b"").digest() for s in sources) +
                         json.dumps([s["state"] for s in states]).encode()).hexdigest()
        buf = io.BytesIO()
        img.save(buf, "PNG", optimize=True)
        fresh = [s["t"] for s in states if s["state"] == "ok"]
        entry["frames"] = add("mosaic.png", frames, buf.getvalue(), "png", max(fresh) if fresh else None, h)
        entry["checked"] = now
        entry["radars"] = states
        print("mosaic:", ", ".join("%s %s" % (s["name"], s["state"]) for s in states))
    images["mosaic.png"] = entry

    # stable names for the newest of each (what the page shows)
    for key, entry in images.items():
        if entry["frames"]:
            with open(os.path.join(out, entry["frames"][-1]["f"]), "rb") as a, open(os.path.join(out, key), "wb") as z:
                z.write(a.read())
    with open(os.path.join(out, "frames.json"), "w") as fh:
        json.dump({"updated": now, "images": images}, fh, separators=(",", ":"))


if __name__ == "__main__":
    main(sys.argv[1:])
