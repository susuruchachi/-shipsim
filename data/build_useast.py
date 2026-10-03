# アメリカ東海岸の粗い地形：fetch_useast.py で取った ETOPO 2022（15 秒角）を 20 秒角（≒ 620m × 470m）に直して useast.png に
#   python3 build_useast.py [作業フォルダ]
# （15 秒角のままだと 2400 万点になり、iPad の canvas の大きさの上限（1677 万画素）を超え、メモリも重いので 20 秒角にする。
#   大きな港は data/harbors/ の 10m の地形で作り込んである）
import numpy as np, glob, sys, os, json
from PIL import Image
src = sys.argv[1] if len(sys.argv) > 1 else '.'
HERE = os.path.dirname(os.path.abspath(__file__))
C15 = 1 / 240
rows = {}
lon0 = None; ncols = None
for fn in sorted(glob.glob(os.path.join(src, 'chunk*.asc'))):
    with open(fn) as f:
        hdr = {}
        for _ in range(6):
            k, v = f.readline().split(); hdr[k] = float(v)
        nc, nr = int(hdr['ncols']), int(hdr['nrows'])
        data = np.loadtxt(f, dtype=np.float32)
    assert data.shape == (nr, nc), (fn, data.shape)
    if lon0 is None: lon0, ncols = hdr['xllcenter'], nc
    assert abs(hdr['xllcenter'] - lon0) < 1e-6 and nc == ncols
    ylc = hdr['yllcenter']
    for r in range(nr):
        lat = ylc + (nr - 1 - r) * hdr['cellsize']
        key = int(round((lat + 89.99791666666667) * 240))
        rows[key] = data[r]
keys = sorted(rows)
assert keys == list(range(keys[0], keys[-1] + 1)), 'gap'
g15 = np.stack([rows[k] for k in keys[::-1]])     # 北が上
lat_top = keys[-1] / 240 - 89.99791666666667
lat_bot = keys[0] / 240 - 89.99791666666667
print('15s grid', g15.shape, 'lat', lat_bot, lat_top, 'lon0', lon0, 'min/max', g15.min(), g15.max(), flush=True)
# 20 秒角の格子（北西の角を合わせる）。15 秒角の格子から直線で補う
C20 = 1 / 180
nr20 = int(np.floor((lat_top - lat_bot) / C20)) + 1
nc20 = int(np.floor(((ncols - 1) * C15) / C20)) + 1
fy = (np.arange(nr20) * C20) / C15
fx = (np.arange(nc20) * C20) / C15
y0 = np.minimum(np.floor(fy).astype(int), g15.shape[0] - 2); ty = (fy - y0)[:, None]
x0 = np.minimum(np.floor(fx).astype(int), g15.shape[1] - 2); tx = (fx - x0)[None, :]
a = g15[y0][:, x0]; b = g15[y0][:, x0 + 1]; c = g15[y0 + 1][:, x0]; d = g15[y0 + 1][:, x0 + 1]
g = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty
# 岸の近くでは、直線で補うと細い水路（川）がならされて消えるので、まわりの 15 秒角の点のいちばん深い値を少し混ぜる
mn = np.minimum(np.minimum(a, b), np.minimum(c, d))
g = np.where((mn < -3) & (g > -20) & (g < 2), np.minimum(g, 0.5 * g + 0.5 * mn), g)
print('20s grid', g.shape, flush=True)
# PNG を小さく：船から見えない細かさは丸める（50m より高い陸は 5m きざみ、200m より深い海は 10m、1000m より深い海は 50m）
h = np.round(g).astype(np.float64)
h = np.where(h > 50, 50 + np.round((h - 50) / 5) * 5, np.where(h < -1000, -1000 + np.round((h + 1000) / 50) * 50, np.where(h < -200, -200 + np.round((h + 200) / 10) * 10, h)))
h = np.clip(h, -32000, 32000).astype(np.int32) + 32768
img = np.zeros((g.shape[0], g.shape[1], 3), np.uint8)
img[..., 0] = h >> 8; img[..., 1] = h & 255
Image.fromarray(img, 'RGB').save(os.path.join(HERE, 'useast.png'), optimize=True)
meta = {'lat0': lat_top - (nr20 - 1) * C20, 'lat1': lat_top, 'lon0': lon0, 'lon1': lon0 + (nc20 - 1) * C20, 'rows': nr20, 'cols': nc20, 'cell': C20,
        'source': 'NOAA NCEI ETOPO 2022 15 arc-second (public domain), via ERDDAP coastwatch.pfeg.noaa.gov, resampled to 20 arc-second'}
json.dump(meta, open(os.path.join(HERE, 'useast.json'), 'w'), indent=1)
print(meta, os.path.getsize(os.path.join(HERE, 'useast.png')))
