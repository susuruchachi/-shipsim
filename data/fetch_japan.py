# 日本の主な湾（九州北部・瀬戸内海・大阪湾・伊勢湾・東京湾・相模湾）の地形：NOAA NCEI ETOPO 2022（15 秒角）を ERDDAP から
#   python3 fetch_japan.py [作業フォルダ]   → j{番号}.nc（緯度 0.4° ずつの帯）
import subprocess, sys, os
LAT0, LAT1, LON0, LON1 = 32.6, 36.2, 129.6, 140.95
out = sys.argv[1] if len(sys.argv) > 1 else '.'
os.makedirs(out, exist_ok=True)
step = 0.4
lat, i = LAT0, 0
while lat < LAT1 - 1e-9:
    a, b = lat, min(LAT1, lat + step)
    fn = os.path.join(out, f'j{i:02d}.nc')
    if not (os.path.exists(fn) and os.path.getsize(fn) > 500000):
        url = f"https://coastwatch.pfeg.noaa.gov/erddap/griddap/ETOPO_2022_v1_15s.nc?z%5B({a:.5f}):1:({b:.5f})%5D%5B({LON0}):1:({LON1})%5D"
        for attempt in range(4):
            r = subprocess.run(['curl', '-s', '-m', '900', '-o', fn, url])
            if r.returncode == 0 and os.path.exists(fn) and os.path.getsize(fn) > 500000: break
        print(fn, a, b, os.path.getsize(fn), flush=True)
    lat = b; i += 1
