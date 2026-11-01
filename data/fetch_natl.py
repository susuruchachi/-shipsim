# 北大西洋（アメリカ東海岸〜ブリテン諸島）の土台の粗い地形：NOAA NCEI ETOPO 2022（15 秒角）を ERDDAP から
# 6 点おき（1.5 分角 ≒ 2.8km）に、緯度 2° ずつ取る
#   python3 fetch_natl.py [作業フォルダ]   → chunkNN.asc（esriAscii）
import subprocess, sys, os
LAT0, LAT1, LON0, LON1 = 24.3, 61.0, -82.0, 3.0
out = sys.argv[1] if len(sys.argv) > 1 else '.'
os.makedirs(out, exist_ok=True)
step = 2.0
lat = LAT0
i = 0
while lat < LAT1 - 1e-9:
    a, b = lat, min(LAT1, lat + step)
    fn = os.path.join(out, f'chunk{i:02d}.asc')
    if not (os.path.exists(fn) and os.path.getsize(fn) > 100000):
        url = f"https://coastwatch.pfeg.noaa.gov/erddap/griddap/ETOPO_2022_v1_15s.esriAscii?z%5B({a:.4f}):6:({b:.4f})%5D%5B({LON0}):6:({LON1})%5D"
        for attempt in range(4):
            r = subprocess.run(['curl', '-s', '-m', '900', '-o', fn, url])
            if r.returncode == 0 and os.path.getsize(fn) > 100000: break
        print(fn, a, b, os.path.getsize(fn), flush=True)
    lat = b; i += 1
