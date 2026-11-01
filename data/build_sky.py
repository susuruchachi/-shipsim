# 夜空のデータ（70-night-sky.js が使う）：data/sky/
#   python3 build_sky.py <作業フォルダ>
# 作業フォルダに置くもの（どれも公開のデータ）：
#   heasarc_hipparcos.tdat.gz   … Hipparcos 星表（ESA。NASA HEASARC の表：
#                                  https://heasarc.gsfc.nasa.gov/FTP/heasarc/dbase/tdat_files/heasarc_hipparcos.tdat.gz）
#   milkyway_2020_4k.exr        … 天の川（明るい星を除いた星の光の地図。NASA SVS「Deep Star Maps 2020」
#                                  https://svs.gsfc.nasa.gov/4851 。Gaia DR2：ESA/Gaia/DPAC）
#   lroc_color_poles_1k.jpg     … 月面の地図（NASA SVS「CGI Moon Kit」 https://svs.gsfc.nasa.gov/4720 。LRO の写真）
# 作るもの：
#   stars.bin     … 7.5 等より明るい星（約 2.6 万個）。明るい順。1 個 6 バイト（Uint16 × 3、リトルエンディアン）：
#                   赤経（0〜65535 で 1 周）・赤緯（0〜65535 で −90°〜＋90°）・等級と色（上の 8 ビット：(等級＋2)×20、
#                   下の 8 ビット：(B−V＋0.5)×80）。位置は J2000（ICRS）。日付の歳差は 70-night-sky.js が回す
#   milkyway.jpg  … 天の川（2048×1024、赤経・赤緯の正距円筒：真ん中が赤経 0h、左へ赤経が増える。上が北）。
#                   明るさ（リニア）＝ (画素の値/255)^2.2 × milkyScale（sky.json）
#   moon.jpg      … 月面（1024×512、真ん中が経度 0°（地球に向いた面の中心）、右へ東経。上が北）
#   sky.json      … 上の値と出典
import gzip, json, os, shutil, sys
import numpy as np
from PIL import Image
src = sys.argv[1] if len(sys.argv) > 1 else '.'
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'sky')
os.makedirs(OUT, exist_ok=True)

# ── 星 ──
names, stars = [], []
with gzip.open(os.path.join(src, 'heasarc_hipparcos.tdat.gz'), 'rt') as f:
    data = False
    for line in f:
        if line.startswith('field['): names.append(line.split('[')[1].split(']')[0]); continue
        if line.startswith('<DATA>'): data = True; continue
        if not data or line.startswith('<END>'): continue
        p = line.rstrip('\n').split('|')
        try:
            ra, dec, v = float(p[names.index('ra')]), float(p[names.index('dec')]), float(p[names.index('vmag')])
        except ValueError:
            continue
        if v > 7.5: continue
        try: bv = float(p[names.index('bv_color')])
        except ValueError: bv = 0.6
        stars.append((v, ra, dec, bv))
stars.sort()
buf = np.zeros((len(stars), 3), dtype='<u2')
for k, (v, ra, dec, bv) in enumerate(stars):
    buf[k, 0] = int(round(ra / 360 * 65536)) % 65536
    buf[k, 1] = int(round((dec + 90) / 180 * 65535))
    m = max(0, min(255, int(round((v + 2) * 20))))
    c = max(0, min(255, int(round((bv + 0.5) * 80))))
    buf[k, 2] = (m << 8) | c
buf.tofile(os.path.join(OUT, 'stars.bin'))
print('stars', len(stars), 'brightest', stars[0][:3], 'bytes', os.path.getsize(os.path.join(OUT, 'stars.bin')))

# ── 天の川 ──
import OpenEXR, Imath
f = OpenEXR.InputFile(os.path.join(src, 'milkyway_2020_4k.exr'))
dw = f.header()['dataWindow']; W, H = dw.max.x - dw.min.x + 1, dw.max.y - dw.min.y + 1
rgb = np.stack([np.frombuffer(f.channel(c, Imath.PixelType(Imath.PixelType.FLOAT)), dtype=np.float32).reshape(H, W) for c in 'RGB'], -1)
rgb = rgb.reshape(H // 2, 2, W // 2, 2, 3).mean(axis=(1, 3))         # 2048×1024
scale = float(np.percentile(rgb.max(axis=2), 99.995))
enc = np.clip(rgb / scale, 0, 1) ** (1 / 2.2)
Image.fromarray((enc * 255 + 0.5).astype(np.uint8), 'RGB').save(os.path.join(OUT, 'milkyway.jpg'), quality=90, optimize=True)
L = 0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2]
print('milkyway scale', scale, 'median L', float(np.median(L)), 'p99', float(np.percentile(L, 99)), 'bytes', os.path.getsize(os.path.join(OUT, 'milkyway.jpg')))

# ── 月 ──
shutil.copyfile(os.path.join(src, 'lroc_color_poles_1k.jpg'), os.path.join(OUT, 'moon.jpg'))
m = np.asarray(Image.open(os.path.join(OUT, 'moon.jpg')).convert('RGB')).astype(np.float32) / 255
ml = (m ** 2.2).mean(axis=2)
near = ml[:, ml.shape[1] // 4: 3 * ml.shape[1] // 4]
print('moon near-side mean linear', float(near.mean()))

json.dump({'stars': len(stars), 'starMagMax': 7.5, 'milkyScale': scale, 'milkyMedian': float(np.median(L)), 'milkyP99': float(np.percentile(L, 99)),
           'moonMean': float(near.mean()),
           'source': {'stars': 'Hipparcos Main Catalogue (ESA 1997), via NASA HEASARC',
                      'milkyway': 'NASA/Goddard Space Flight Center Scientific Visualization Studio, Deep Star Maps 2020 (milkyway_2020_4k). Gaia DR2: ESA/Gaia/DPAC',
                      'moon': 'NASA Scientific Visualization Studio, CGI Moon Kit (LRO LROC WAC color mosaic)'}},
          open(os.path.join(OUT, 'sky.json'), 'w'), indent=1)
