import subprocess, sys, os
LAT0, LAT1, LON0, LON1 = 48.3, 61.0, -11.0, 3.0
step = 1.0
lat = LAT0
i = 0
while lat < LAT1 - 1e-9:
    a, b = lat, min(LAT1, lat + step)
    fn = f'chunk{i:02d}.asc'
    if not (os.path.exists(fn) and os.path.getsize(fn) > 1000000):
        url = f"https://coastwatch.pfeg.noaa.gov/erddap/griddap/ETOPO_2022_v1_15s.esriAscii?z%5B({a:.4f}):1:({b:.4f})%5D%5B({LON0}):1:({LON1})%5D"
        for attempt in range(4):
            r = subprocess.run(['curl', '-s', '-m', '600', '-o', fn, url])
            if r.returncode == 0 and os.path.getsize(fn) > 1000000: break
        print(fn, a, b, os.path.getsize(fn), flush=True)
    lat = b; i += 1
