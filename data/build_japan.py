# 日本の主な湾の細かい地形：fetch_japan.py で取った ETOPO 2022（15 秒角 ≒ 460m × 380m）を、そのまま japan.png に
#   python3 build_japan.py [作業フォルダ]
# 世界全体の区画（1.5 分角 ≒ 2.8km）では、東京湾が幅 8 升ほどしかなく、埋め立て地・岬・水道の形が大まかだった。
# 形式は britain・useast と同じ（高さ[m] ＝ R × 256 ＋ G − 32768、上が北）
import numpy as np, glob, sys, os, json
from PIL import Image
from scipy.io import netcdf_file
src = sys.argv[1] if len(sys.argv) > 1 else '.'
HERE = os.path.dirname(os.path.abspath(__file__))
C = 1 / 240
LAT0E = -89.99791666666667
rows = {}
lon = None
for fn in sorted(glob.glob(os.path.join(src, 'j*.nc'))):
    f = netcdf_file(fn, 'r', mmap=False)
    la = f.variables['latitude'][:].copy(); lo = f.variables['longitude'][:].copy(); z = f.variables['z'][:].astype(np.float32)
    f.close()
    if lon is None: lon = lo
    assert len(lo) == len(lon) and abs(lo[0] - lon[0]) < 1e-6
    for k in range(len(la)):
        rows[int(round((la[k] - LAT0E) * 240))] = z[k]
keys = sorted(rows)
assert keys == list(range(keys[0], keys[-1] + 1)), 'gap'
g = np.stack([rows[k] for k in keys[::-1]])        # 北が上
lat_top = keys[-1] / 240 + LAT0E
lat_bot = keys[0] / 240 + LAT0E
print('grid', g.shape, 'lat', lat_bot, lat_top, 'lon', lon[0], lon[-1], flush=True)
# 船から見えない細かさは丸める（50m より高い陸は 5m、200m より深い海は 10m、1000m より深い海は 50m きざみ）
h = np.round(g).astype(np.float64)
h = np.where(h > 50, 50 + np.round((h - 50) / 5) * 5, np.where(h < -1000, -1000 + np.round((h + 1000) / 50) * 50, np.where(h < -200, -200 + np.round((h + 200) / 10) * 10, h)))
h = np.clip(h, -32000, 32000).astype(np.int32) + 32768
img = np.zeros((g.shape[0], g.shape[1], 3), np.uint8)
img[..., 0] = h >> 8; img[..., 1] = h & 255
Image.fromarray(img, 'RGB').save(os.path.join(HERE, 'japan.webp'), 'WEBP', lossless=True, method=6)
meta = {'lat0': lat_bot, 'lat1': lat_top, 'lon0': float(lon[0]), 'lon1': float(lon[-1]), 'rows': g.shape[0], 'cols': g.shape[1], 'cell': C, 'ext': 'webp',
        'source': 'NOAA NCEI ETOPO 2022 15 arc-second (public domain), via ERDDAP coastwatch.pfeg.noaa.gov'}
json.dump(meta, open(os.path.join(HERE, 'japan.json'), 'w'), indent=1)
print(meta, os.path.getsize(os.path.join(HERE, 'japan.webp')))
