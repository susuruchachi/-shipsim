import numpy as np, glob
from PIL import Image
CELL = 1/240
rows = {}
lon0 = None; ncols = None
for fn in sorted(glob.glob('chunk*.asc')):
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
grid = np.stack([rows[k] for k in keys[::-1]])   # north at top
lat_top = keys[-1] / 240 - 89.99791666666667
lat_bot = keys[0] / 240 - 89.99791666666667
print('grid', grid.shape, 'lat', lat_bot, lat_top, 'lon0', lon0, 'min/max', grid.min(), grid.max(), 'nodata', (grid < -20000).sum())
h = np.clip(np.round(grid), -32000, 32000).astype(np.int32) + 32768
img = np.zeros((grid.shape[0], grid.shape[1], 3), np.uint8)
img[..., 0] = h >> 8; img[..., 1] = h & 255
Image.fromarray(img, 'RGB').save('britain.png', optimize=True)
import json, os
meta = {'lat0': lat_bot, 'lat1': lat_top, 'lon0': lon0, 'lon1': lon0 + (grid.shape[1] - 1) * CELL, 'rows': grid.shape[0], 'cols': grid.shape[1], 'cell': CELL,
        'source': 'NOAA NCEI ETOPO 2022 15 arc-second (public domain), via ERDDAP coastwatch.pfeg.noaa.gov'}
json.dump(meta, open('britain.json', 'w'), indent=1)
print(meta, os.path.getsize('britain.png'))
