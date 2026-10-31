# 街明かり（70-night-sky.js が使う）：NASA「Black Marble 2016」（夜の地球の灯り。VIIRS の 2016 年の合成。公開のデータ）から
#   python3 build_lights.py <BlackMarble_2016_3km_gray_geo.tif>
#   （https://eoimages.gsfc.nasa.gov/images/imagerecords/144000/144897/BlackMarble_2016_3km_gray_geo.tif ：13500×6750、1/37.5°（約 3km）おき、北が上）
# 作るもの：
#   data/world/lights.webp  … 全体の粗い図（0.08° ≒ 9km おき、4500×2250）。光害（空の明るさ）の計算用。
#                             画素の値 ＝ √(3×3 画素の灯りの平均（リニア）) × 255。上が北、左端が西経 180°
#   data/world/lights/lTT_JJ.webp … 海岸の区画（10°×10°、375×375：元の 3km のまま。terrain の区画と同じ番号：TT＝南から 10° ごと、
#                             JJ＝西経 180° から 10° ごと）。陸の灯りの点を置くのに使う。画素の値は元の明るさ（0〜255）。上が北
#   data/world/lights.json  … 範囲と区画の一覧
# 元の画像は表示用に明るさを強めてある（都市の中心は 255 で頭打ち）。リニアの明るさは (値/255)^2.2 とみなす。
import json, os, sys
import numpy as np
from PIL import Image
Image.MAX_IMAGE_PIXELS = None
src = sys.argv[1]
HERE = os.path.dirname(os.path.abspath(__file__))
WD = os.path.join(HERE, 'world')
os.makedirs(os.path.join(WD, 'lights'), exist_ok=True)
g = np.asarray(Image.open(src))
if g.ndim == 3: g = g[..., 0]
H, W = g.shape
assert (W, H) == (13500, 6750), (W, H)
lin = (g.astype(np.float32) / 255) ** 2.2

# 粗い図
B = 3
c = lin.reshape(H // B, B, W // B, B).mean(axis=(1, 3))
enc = (np.sqrt(c) * 255 + 0.5).astype(np.uint8)
Image.fromarray(enc, 'L').convert('RGB').save(os.path.join(WD, 'lights.webp'), 'WEBP', lossless=True, method=6)
print('coarse', enc.shape, os.path.getsize(os.path.join(WD, 'lights.webp')))

# 海岸の区画（地形の区画がある所だけ）
idx = json.load(open(os.path.join(WD, 'index.json')))
have = set(idx['have'])
T = 375
tiles, tot = [], 0
for ti in range(18):
    for tj in range(36):
        if f'{ti}_{tj}' not in have: continue
        r0 = H - (ti + 1) * T; c0 = tj * T            # 画像は北が上：南から ti 番目の帯
        t = g[r0:r0 + T, c0:c0 + T]
        if t.max() < 8: continue
        fn = os.path.join(WD, 'lights', f'l{ti:02d}_{tj:02d}.webp')
        Image.fromarray(t, 'L').convert('RGB').save(fn, 'WEBP', lossless=True, method=6)
        tiles.append(f'{ti}_{tj}'); tot += os.path.getsize(fn)
print('tiles', len(tiles), 'bytes', tot)
json.dump({'coarse': {'w': W // B, 'h': H // B, 'cell': B / 37.5, 'lon0': -180, 'lat1': 90, 'enc': 'sqrt'},
           'tile': {'n': T, 'deg': 10, 'lat0': -90, 'lon0': -180, 'have': tiles},
           'gamma': 2.2,
           'source': 'NASA Earth Observatory, Black Marble 2016 (VIIRS Day/Night Band, 3 km gray), public domain'},
          open(os.path.join(WD, 'lights.json'), 'w'))
