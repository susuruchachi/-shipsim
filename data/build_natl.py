# 北大西洋の土台の粗い地形：fetch_natl.py で取った ETOPO 2022（15 秒角を 6 点おき＝1.5 分角）を natl.png に
#   python3 build_natl.py [作業フォルダ]
# （ブリテン諸島・アメリカ東海岸は、それぞれの細かい格子（britain・useast）が上に重なる。これはその外の大洋と岸）
import numpy as np, glob, sys, os, json
from PIL import Image
src = sys.argv[1] if len(sys.argv) > 1 else '.'
HERE = os.path.dirname(os.path.abspath(__file__))
rows = {}
lon0 = None; ncols = None; cell = None
for fn in sorted(glob.glob(os.path.join(src, 'chunk*.asc'))):
    with open(fn) as f:
        hdr = {}
        for _ in range(6):
            k, v = f.readline().split(); hdr[k] = float(v)
        nc, nr = int(hdr['ncols']), int(hdr['nrows'])
        data = np.loadtxt(f, dtype=np.float32)
    assert data.shape == (nr, nc), (fn, data.shape)
    if lon0 is None: lon0, ncols, cell = hdr['xllcenter'], nc, hdr['cellsize']
    assert abs(hdr['xllcenter'] - lon0) < 1e-6 and nc == ncols
    for r in range(nr):
        lat = hdr['yllcenter'] + (nr - 1 - r) * hdr['cellsize']
        rows[int(round((lat + 89.99791666666667) * 240))] = data[r]
# 最後の区切りは、ERDDAP が始まりを近い点に寄せるので 1 点ずれることがある：6 点おきの並びに寄せる（先に取った行を残す）
k0 = min(rows); al = {}
for k in sorted(rows):
    kk = k0 + 6 * round((k - k0) / 6)
    if kk not in al: al[kk] = rows[k]
rows = al
keys = sorted(rows)
assert all(b - a == 6 for a, b in zip(keys, keys[1:])), 'gap'
g = np.stack([rows[k] for k in keys[::-1]])     # 北が上
C = 6 / 240
lat_top = keys[-1] / 240 - 89.99791666666667
print('grid', g.shape, 'lat', keys[0] / 240 - 89.99791666666667, lat_top, 'lon0', lon0, 'min/max', g.min(), g.max(), flush=True)
h = np.round(g).astype(np.float64)
h = np.where(h > 50, 50 + np.round((h - 50) / 5) * 5, np.where(h < -1000, -1000 + np.round((h + 1000) / 50) * 50, np.where(h < -200, -200 + np.round((h + 200) / 10) * 10, h)))
h = np.clip(h, -32000, 32000).astype(np.int32) + 32768
img = np.zeros((g.shape[0], g.shape[1], 3), np.uint8)
img[..., 0] = h >> 8; img[..., 1] = h & 255
Image.fromarray(img, 'RGB').save(os.path.join(HERE, 'natl.png'), optimize=True)
nr, nc = g.shape
meta = {'lat0': lat_top - (nr - 1) * C, 'lat1': lat_top, 'lon0': lon0, 'lon1': lon0 + (nc - 1) * C, 'rows': nr, 'cols': nc, 'cell': C,
        'source': 'NOAA NCEI ETOPO 2022 15 arc-second (public domain), via ERDDAP coastwatch.pfeg.noaa.gov, every 6th point (1.5 arc-minute)'}
json.dump(meta, open(os.path.join(HERE, 'natl.json'), 'w'), indent=1)
print(meta, os.path.getsize(os.path.join(HERE, 'natl.png')))
