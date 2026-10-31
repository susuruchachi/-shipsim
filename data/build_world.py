# 世界全体の地形：fetch_world.py で取った ETOPO 2022（1.5 分角）から
#   data/world/t{緯度の帯}_{経度の帯}.webp（10°×10° の区画、401×401 点：となりと 1 点重ねる）
#   data/world/overview.webp（全体図：6 分角 ≒ 11km、3601×1800 点。経度の端は 1 点重ねる）
#   data/world/index.json（区画の一覧）・overview.json（全体図の範囲）
# を作る。   python3 build_world.py <作業フォルダ>
# 形式は britain・natl と同じ 1 画素が 1 点（高さ[m] ＝ R × 256 ＋ G − 32768。上が北）で、可逆の WebP。
# 船から見えない細かさは丸める（陸は 50〜300m を 5m・1500m までを 20m・その上を 50m、海は 200〜1000m を 20m・その下を 100m きざみ）。
# どこも 300m より深い区画（大洋の真ん中）と、どこも 20m より高い区画（内陸）は作らない（全体図で足りる）。
import numpy as np, glob, sys, os, json
from PIL import Image
from scipy.io import netcdf_file
src = sys.argv[1] if len(sys.argv) > 1 else '.'
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'world')
os.makedirs(OUT, exist_ok=True)
NLAT, NLON, BAND, QUART, TILE = 7200, 14400, 400, 3600, 400
LAT0, LON0, CELL = -89.99791666666667, -179.99791666666667, 0.025

A = np.zeros((NLAT, NLON), dtype=np.int16)          # A[k, j]：k は南から
seen = np.zeros((NLAT, NLON), dtype=bool)
for fn in sorted(glob.glob(os.path.join(src, 'b*_*.nc'))):
    b, q = [int(x) for x in os.path.basename(fn)[1:-3].split('_')]
    f = netcdf_file(fn, 'r', mmap=False)
    lat = f.variables['latitude'][:].copy(); lon = f.variables['longitude'][:].copy(); z = f.variables['z'][:].astype(np.float32)
    f.close()
    k = np.rint((lat - LAT0) / CELL).astype(int); j = np.rint((lon - LON0) / CELL).astype(int)
    assert np.all(np.abs(lat - (LAT0 + k * CELL)) < 1e-6) and np.all(np.abs(lon - (LON0 + j * CELL)) < 1e-6), fn
    if lat[0] > lat[-1]: z = z[::-1]; k = k[::-1]
    A[k[0]:k[-1] + 1, j[0]:j[-1] + 1] = np.clip(np.rint(z), -32000, 32000).astype(np.int16)
    seen[k[0]:k[-1] + 1, j[0]:j[-1] + 1] = True
assert seen.all(), 'missing points: %d' % (~seen).sum()

def quantize(h):
    h = h.astype(np.int32)
    out = h.copy()
    for lo, hi, st in [(50, 300, 5), (300, 1500, 20), (1500, 99999, 50)]:
        m = (h > lo) & (h <= hi); out[m] = np.rint(h[m] / st) * st
    for hi, lo, st in [(-200, -1000, 20), (-1000, -99999, 100)]:
        m = (h < hi) & (h >= lo); out[m] = np.rint(h[m] / st) * st
    return out

# WebP（可逆）：PNG の半分ほど。画素の値はそのまま（R × 256 ＋ G − 32768）
def save_img(h, fn):
    v = (h.astype(np.int32) + 32768)
    rgb = np.zeros(h.shape + (3,), dtype=np.uint8)
    rgb[..., 0] = (v >> 8) & 255; rgb[..., 1] = v & 255
    Image.fromarray(rgb, 'RGB').save(fn, 'WEBP', lossless=True, method=6)

Q = quantize(A).astype(np.int16)
have = []
tot = 0
for ti in range(NLAT // TILE):
    k0, k1 = ti * TILE, min(NLAT - 1, ti * TILE + TILE)
    for tj in range(NLON // TILE):
        j0 = tj * TILE
        cols = [(j0 + c) % NLON for c in range(TILE + 1)]
        t = Q[k0:k1 + 1][:, cols]
        if t.max() < -300: continue          # 大洋の真ん中（全体図で足りる）
        if t.min() > 20: continue            # 海も低い陸も無い内陸（船から見えない）
        fn = os.path.join(OUT, f't{ti:02d}_{tj:02d}.webp')
        save_img(t[::-1], fn)
        have.append(f'{ti}_{tj}')
        tot += os.path.getsize(fn)
print('tiles', len(have), 'bytes', tot)

# 全体図：4×4 点（6 分角の升目）のまとまりごとに。水が 6 点以上なら水の点の中ほどの深さ、そうでなければ陸の点の中ほどの高さ
# （細い海峡（ジブラルタルなど）が全体図で閉じないように、水を少しひいきする）
RO, CO = NLAT // 4, NLON // 4
blk = A[:RO * 4, :CO * 4].reshape(RO, 4, CO, 4).transpose(0, 2, 1, 3).reshape(RO, CO, 16).astype(np.float32)
water = blk < 0
nw = water.sum(axis=2)
wv = np.where(water, blk, np.nan); lv = np.where(water, np.nan, blk)
import warnings
with warnings.catch_warnings():
    warnings.simplefilter('ignore')
    wm = np.nanmedian(wv, axis=2); lm = np.nanmedian(lv, axis=2)
ov = np.where(nw >= 6, wm, lm)
ov = np.where(np.isnan(ov), blk[..., 5], ov)
ov = quantize(np.rint(ov)).astype(np.int16)
ov = np.concatenate([ov, ov[:, :1]], axis=1)       # 経度の端（＋180°）に、−180° の列を重ねる
# 4×4 のまとまりの真ん中を、その升目の点の位置にする
olat0, olon0, ocell = LAT0 + 1.5 * CELL, LON0 + 1.5 * CELL, 4 * CELL
save_img(ov[::-1], os.path.join(OUT, 'overview.webp'))
meta = {'lat0': olat0, 'lat1': olat0 + ocell * (RO - 1), 'lon0': olon0, 'lon1': olon0 + ocell * CO, 'rows': RO, 'cols': CO + 1, 'cell': ocell, 'wrap': True, 'ext': 'webp',
        'source': 'NOAA NCEI ETOPO 2022 15 arc-second (public domain), via ERDDAP coastwatch.pfeg.noaa.gov; median of 4x4 points at 1.5 arc-minute (6 arc-minute)'}
json.dump(meta, open(os.path.join(OUT, 'overview.json'), 'w'), indent=1)
idx = {'lat0': LAT0, 'lon0': LON0, 'cell': CELL, 'tile': TILE, 'nLat': NLAT // TILE, 'nLon': NLON // TILE, 'rows': NLAT, 'cols': NLON, 'ext': 'webp', 'have': have,
       'source': 'NOAA NCEI ETOPO 2022 15 arc-second (public domain), via ERDDAP coastwatch.pfeg.noaa.gov, every 6th point (1.5 arc-minute)'}
json.dump(idx, open(os.path.join(OUT, 'index.json'), 'w'))
print('overview', os.path.getsize(os.path.join(OUT, 'overview.webp')))
