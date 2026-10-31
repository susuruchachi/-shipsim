# 世界全体の地形：NOAA NCEI ETOPO 2022（15 秒角）を ERDDAP から 6 点おき（1.5 分角 ≒ 2.8km）に取る
#   python3 fetch_world.py [作業フォルダ] [同時に取る数]   → b{緯度の帯}_{経度の4分の1}.nc（netCDF）
# 格子は ETOPO の 15 秒角の点の 0 番目から 6 点おき（北大西洋の natl と同じ並び）：
#   緯度 −89.99791667 ＋ 0.025 × i（i ＝ 0〜7199）、経度 −179.99791667 ＋ 0.025 × j（j ＝ 0〜14399）
# 緯度は 400 点（10°）ずつの帯に、となりと 1 点重ねて取る（build_world.py が 10°×10° の区画に分ける）
import subprocess, sys, os
from concurrent.futures import ThreadPoolExecutor
out = sys.argv[1] if len(sys.argv) > 1 else '.'
par = int(sys.argv[2]) if len(sys.argv) > 2 else 3
os.makedirs(out, exist_ok=True)
NLAT, NLON = 7200, 14400            # 6 点おきの点の数
BAND, QUART = 400, 3600
jobs = []
for b in range(NLAT // BAND):
    k0, k1 = b * BAND, min(NLAT - 1, b * BAND + BAND)
    for q in range(NLON // QUART):
        j0, j1 = q * QUART, min(NLON - 1, q * QUART + QUART)
        jobs.append((b, q, k0, k1, j0, j1))

def fetch(job):
    b, q, k0, k1, j0, j1 = job
    fn = os.path.join(out, f'b{b:02d}_{q}.nc')
    want = (k1 - k0 + 1) * (j1 - j0 + 1) * 4
    if os.path.exists(fn) and os.path.getsize(fn) > want:
        return fn, 'have'
    url = (f"https://coastwatch.pfeg.noaa.gov/erddap/griddap/ETOPO_2022_v1_15s.nc?"
           f"z%5B{6 * k0}:6:{6 * k1}%5D%5B{6 * j0}:6:{6 * j1}%5D")
    for attempt in range(5):
        tmp = fn + '.part'
        r = subprocess.run(['curl', '-s', '-m', '1200', '-o', tmp, url])
        if r.returncode == 0 and os.path.exists(tmp) and os.path.getsize(tmp) > want:
            os.replace(tmp, fn)
            return fn, os.path.getsize(fn)
    return fn, 'FAILED'

with ThreadPoolExecutor(par) as ex:
    for fn, st in ex.map(fetch, jobs):
        print(fn, st, flush=True)
