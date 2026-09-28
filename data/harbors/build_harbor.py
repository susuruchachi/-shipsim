#!/usr/bin/env python3
"""詳しい港の地形（10m おき）を作る。

  python3 build_harbor.py southampton [--cache DIR]

・陸と水：OpenStreetMap（api.openstreetmap.org の map、小さな四角に分けて取る）
    - 海岸線（natural=coastline）は「進む向きの左が陸・右が海」なので、線を引いてから、
      線の右・左の点から塗りつぶして海と陸に分ける
    - ドック・泊地・川（natural=water の water=dock/basin/river…、waterway=dock/riverbank）は水
    - 桟橋・防波堤（man_made=pier/breakwater/groyne/quay の線・面）は陸
・水深：EMODnet Bathymetry DTM 2024（1/16 分 ≒ 115m おき、ERDDAP の esriAscii）をならして使う。
  ドックの中は港ごとに決めた深さ（HARBORS の dock_depth）。
・陸の高さ：岸壁の高さ（4m）。岸から離れた所は britain.png の高さ（4m より高ければ）。

出力：<key>.png（R×256＋G − 32768 ＝ 高さ[0.1m]、B ＝ 種類：0 海・1 陸・2 ドックの水・3 桟橋・4 港の敷地）
     <key>.json（範囲・行と列・1 升の度）
"""
import json, math, os, sys, time, subprocess
import xml.etree.ElementTree as ET
import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))

# 港ごとの設定：範囲（緯度・経度）、1 升[m]、ドックの深さ[m]
HARBORS = {
    'southampton': dict(name='サウサンプトン', lat0=50.795, lat1=50.918, lon0=-1.448, lon1=-1.295, cell=10, dock_depth=12.5, berth_depth=13.0, berth_reach=400),
}

UA = 'shipsim-harbor-builder/0.1 (personal ship simulator; one-off download)'


def curl(url, out, tries=4):
    for k in range(tries):
        r = subprocess.run(['curl', '-sS', '-m', '300', '-A', UA, '-o', out, '-w', '%{http_code}', url], capture_output=True, text=True)
        code = r.stdout.strip()
        if r.returncode == 0 and code == '200' and os.path.getsize(out) > 100:
            return True
        print('  retry', k + 1, code, r.stderr.strip()[:120], flush=True)
        time.sleep(3 * (k + 1))
    return False


# ── OpenStreetMap：小さな四角ごとに取って、ひとつにまとめる（点が多すぎる所は 4 つに割って取り直す）──
def fetch_tile(a, b, c, d, cache, depth=0):
    fn = os.path.join(cache, f'osm_{a:.5f}_{c:.5f}_{b:.5f}_{d:.5f}.xml')
    if os.path.exists(fn) and os.path.getsize(fn) > 200:
        return [fn]
    url = f'https://api.openstreetmap.org/api/0.6/map?bbox={c:.6f},{a:.6f},{d:.6f},{b:.6f}'
    r = subprocess.run(['curl', '-sS', '-m', '300', '-A', UA, '-o', fn + '.tmp', '-w', '%{http_code}', url], capture_output=True, text=True)
    code = r.stdout.strip()
    time.sleep(1.0)
    if code == '200' and os.path.getsize(fn + '.tmp') > 100:
        os.replace(fn + '.tmp', fn)
        print('osm', os.path.basename(fn), os.path.getsize(fn), flush=True)
        return [fn]
    if os.path.exists(fn + '.tmp'):
        os.remove(fn + '.tmp')
    if code == '400' and depth < 5:
        ma, mc = (a + b) / 2, (c + d) / 2
        out = []
        for (x0, x1) in ((a, ma), (ma, b)):
            for (y0, y1) in ((c, mc), (mc, d)):
                out += fetch_tile(x0, x1, y0, y1, cache, depth + 1)
        return out
    for k in range(3):
        time.sleep(4 * (k + 1))
        r = subprocess.run(['curl', '-sS', '-m', '300', '-A', UA, '-o', fn, '-w', '%{http_code}', url], capture_output=True, text=True)
        if r.stdout.strip() == '200' and os.path.getsize(fn) > 100:
            return [fn]
    raise SystemExit(f'OSM を取れませんでした: {url} ({code})')


def fetch_osm(H, cache):
    os.makedirs(cache, exist_ok=True)
    nodes, ways, rels = {}, {}, {}
    dlat, dlon = 0.02, 0.025
    files = []
    lat = H['lat0']
    while lat < H['lat1'] - 1e-9:
        lon = H['lon0']
        while lon < H['lon1'] - 1e-9:
            files += fetch_tile(lat, min(H['lat1'], lat + dlat), lon, min(H['lon1'], lon + dlon), cache)
            lon += dlon
        lat += dlat
    pk = os.path.join(cache, 'parsed.pickle')
    if os.path.exists(pk) and os.path.getmtime(pk) > max(os.path.getmtime(f) for f in files):
        import pickle
        return pickle.load(open(pk, 'rb'))
    for fn in files:
        root = ET.parse(fn).getroot()
        for el in root:
            if el.tag == 'node':
                nodes[int(el.get('id'))] = (float(el.get('lat')), float(el.get('lon')))
            elif el.tag == 'way':
                wid = int(el.get('id'))
                if wid in ways:
                    continue
                nds = [int(n.get('ref')) for n in el if n.tag == 'nd']
                tags = {t.get('k'): t.get('v') for t in el if t.tag == 'tag'}
                ways[wid] = (nds, tags)
            elif el.tag == 'relation':
                rid = int(el.get('id'))
                mem = [(m.get('type'), int(m.get('ref')), m.get('role')) for m in el if m.tag == 'member']
                tags = {t.get('k'): t.get('v') for t in el if t.tag == 'tag'}
                rels[rid] = (mem, tags)
    import pickle
    pickle.dump((nodes, ways, rels), open(pk, 'wb'), protocol=4)
    return nodes, ways, rels


# ── EMODnet の水深（esriAscii）──
def fetch_emodnet(H, cache):
    fn = os.path.join(cache, 'emodnet.asc')
    if not (os.path.exists(fn) and os.path.getsize(fn) > 1000):
        url = ('https://erddap.emodnet.eu/erddap/griddap/bathymetry_dtm_2024.esriAscii?elevation'
               f'%5B({H["lat0"] - 0.01:.4f}):1:({H["lat1"] + 0.01:.4f})%5D%5B({H["lon0"] - 0.01:.4f}):1:({H["lon1"] + 0.01:.4f})%5D')
        if not curl(url, fn):
            raise SystemExit('EMODnet を取れませんでした')
    L = open(fn).read().split('\n')
    hdr = {}
    for l in L[:6]:
        k, v = l.split()
        hdr[k.lower()] = float(v)
    a = np.array([list(map(float, l.split())) for l in L[6:] if l.strip()], dtype=np.float64)
    a[a < -1e6] = np.nan
    # 行は北から南
    return dict(a=a, x0=hdr['xllcenter'], y0=hdr['yllcenter'], cs=hdr['cellsize'], nr=int(hdr['nrows']), nc=int(hdr['ncols']))


def britain_sampler():
    meta = json.load(open(os.path.join(HERE, '..', 'britain.json')))
    im = np.asarray(Image.open(os.path.join(HERE, '..', 'britain.png')).convert('RGB')).astype(np.int32)
    h = im[:, :, 0] * 256 + im[:, :, 1] - 32768
    def at(lat, lon):
        fy = (meta['lat1'] - lat) / meta['cell']; fx = (lon - meta['lon0']) / meta['cell']
        x0 = np.clip(np.floor(fx).astype(int), 0, meta['cols'] - 2); y0 = np.clip(np.floor(fy).astype(int), 0, meta['rows'] - 2)
        tx = fx - x0; ty = fy - y0
        return (h[y0, x0] * (1 - tx) + h[y0, x0 + 1] * tx) * (1 - ty) + (h[y0 + 1, x0] * (1 - tx) + h[y0 + 1, x0 + 1] * tx) * ty
    return at


WATER_VALUES = {'dock', 'basin', 'river', 'canal', 'lock', 'harbour', 'tidal', 'riverbank', 'lagoon', 'bay'}


def build(key, cache):
    H = HARBORS[key]
    lat0, lat1, lon0, lon1, cell = H['lat0'], H['lat1'], H['lon0'], H['lon1'], H['cell']
    mLat = 6371000 * math.pi / 180
    latc = (lat0 + lat1) / 2
    mLon = mLat * math.cos(math.radians(latc))
    dLat, dLon = cell / mLat, cell / mLon
    rows = int(math.ceil((lat1 - lat0) / dLat)) + 1
    cols = int(math.ceil((lon1 - lon0) / dLon)) + 1
    print(f'{key}: {rows} x {cols} cells of {cell} m', flush=True)
    nodes, ways, rels = fetch_osm(H, cache)
    print(f'osm: {len(nodes)} nodes, {len(ways)} ways, {len(rels)} relations', flush=True)

    def px(lat, lon):
        return ((lon - lon0) / dLon, (lat1 - lat) / dLat)

    def way_pts(wid):
        nds, _ = ways[wid]
        return [px(*nodes[n]) for n in nds if n in nodes]

    # 0 不明・1 線（海岸線）・2 海・3 陸
    img = Image.new('L', (cols, rows), 0)
    dr = ImageDraw.Draw(img)
    coast = [w for w, (nds, t) in ways.items() if t.get('natural') == 'coastline']
    seeds = []
    for w in coast:
        P = way_pts(w)
        if len(P) < 2:
            continue
        dr.line(P, fill=1, width=2)
        for (x0, y0), (x1, y1) in zip(P, P[1:]):
            L = math.hypot(x1 - x0, y1 - y0)
            if L < 1e-6:
                continue
            ux, uy = (x1 - x0) / L, (y1 - y0) / L
            # 画像は y が下向き：進む向きの右（海）は (−uy, ux)、左（陸）は (uy, −ux)
            for t in np.arange(0.5, L, 4):
                mx, my = x0 + ux * t, y0 + uy * t
                for off in (2.2, 3.2):
                    seeds.append((mx - uy * off, my + ux * off, 2))
                    seeds.append((mx + uy * off, my - ux * off, 3))
    print('coastline ways', len(coast), 'seeds', len(seeds), flush=True)
    # 塗りつぶし（PIL の floodfill は 4 近傍）。区域ごとに、中にある目印の多い方（海・陸）にする
    #（細い桟橋のそばでは、目印が反対側に落ちることがあるので、ひとつの目印では決めない）
    SX = np.array([int(round(x)) for x, y, v in seeds]); SY = np.array([int(round(y)) for x, y, v in seeds]); SV = np.array([v for x, y, v in seeds])
    ok = (SX >= 0) & (SX < cols) & (SY >= 0) & (SY < rows)
    SX, SY, SV = SX[ok], SY[ok], SV[ok]
    nreg = 0
    for i in range(len(SX)):
        if img.getpixel((int(SX[i]), int(SY[i]))) != 0:
            continue
        ImageDraw.floodfill(img, (int(SX[i]), int(SY[i])), 200)
        A = np.asarray(img)
        inreg = A[SY, SX] == 200
        nw, nl = int((inreg & (SV == 2)).sum()), int((inreg & (SV == 3)).sum())
        ImageDraw.floodfill(img, (int(SX[i]), int(SY[i])), 2 if nw >= nl else 3)
        nreg += 1
    print('regions', nreg, flush=True)
    A = np.asarray(img).copy()
    # 塗られなかった所：EMODnet に水深がある所は海、それ以外は陸
    E = fetch_emodnet(H, cache)
    J, I = np.mgrid[0:rows, 0:cols]
    LAT = lat1 - J * dLat
    LON = lon0 + I * dLon
    fy = ((E['y0'] + (E['nr'] - 1) * E['cs']) - LAT) / E['cs']
    fx = (LON - E['x0']) / E['cs']
    x0i = np.clip(np.floor(fx).astype(int), 0, E['nc'] - 2); y0i = np.clip(np.floor(fy).astype(int), 0, E['nr'] - 2)
    tx = fx - x0i; ty = fy - y0i
    a = E['a']
    q = [a[y0i, x0i], a[y0i, x0i + 1], a[y0i + 1, x0i], a[y0i + 1, x0i + 1]]
    w = [(1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty]
    num = sum(np.where(np.isnan(v), 0, v) * ww for v, ww in zip(q, w))
    den = sum(np.where(np.isnan(v), 0, ww) for v, ww in zip(q, w))
    emod = np.where(den > 0.25, num / np.maximum(den, 1e-9), np.nan)
    unk = A == 0
    A[unk & (emod < -1)] = 2
    A[A == 0] = 3
    A[A == 1] = 3                       # 海岸線の上は陸（岸壁）
    kind = np.where(A == 2, 0, 1).astype(np.uint8)

    # ドック・泊地・川の水面
    wimg = Image.new('L', (cols, rows), 0)
    wd = ImageDraw.Draw(wimg)
    dimg = Image.new('L', (cols, rows), 0)       # ドック・泊地・閘門（決まった深さ）
    dkd = ImageDraw.Draw(dimg)
    pimg = Image.new('L', (cols, rows), 0)
    pd = ImageDraw.Draw(pimg)
    port = Image.new('L', (cols, rows), 0)
    pod = ImageDraw.Draw(port)

    def is_water(t):
        return (t.get('natural') == 'water' and (t.get('water') in WATER_VALUES or 'water' not in t)) or t.get('waterway') in ('dock', 'riverbank', 'canal') or t.get('landuse') == 'basin' and t.get('basin') in ('tidal', None)

    def is_dock(t):
        return (t.get('water') in ('dock', 'basin', 'lock', 'harbour') or t.get('waterway') == 'dock' or t.get('landuse') == 'basin'
                or (t.get('natural') == 'water' and 'Dock' in t.get('name', '')))

    def is_drydock(t):
        return t.get('dock') == 'drydock' or t.get('disused:dock') == 'drydock' or 'Dry Dock' in t.get('name', '') or 'Graving' in t.get('name', '')

    def is_port_land(t):
        nm = t.get('name', '') + ' ' + t.get('alt_name', '')
        return t.get('landuse') == 'port' or (t.get('landuse') == 'industrial' and (t.get('industrial') in ('port', 'shipyard') or 'Port' in nm or 'Dock' in nm))

    def depth_tag(t):
        try:
            return float(str(t.get('depth', '')).replace('m', '').strip())
        except ValueError:
            return None
    dock_depths = []                    # (多角形, 深さ)
    dry = Image.new('L', (cols, rows), 0)
    dryd = ImageDraw.Draw(dry)

    def draw_area(drw, P, fill):
        if len(P) >= 3:
            drw.polygon(P, fill=fill)
    nd = 0
    for wid, (nds, t) in ways.items():
        closed = len(nds) > 3 and nds[0] == nds[-1]
        if closed and is_drydock(t):
            draw_area(dryd, way_pts(wid), 255)
        elif closed and is_water(t) and t.get('water') not in ('pond', 'reservoir', 'lake', 'wastewater'):
            draw_area(wd, way_pts(wid), 255); nd += 1
            if is_dock(t):
                draw_area(dkd, way_pts(wid), 255)
                if depth_tag(t): dock_depths.append(([way_pts(wid)], depth_tag(t)))
        mm = t.get('man_made')
        if mm in ('pier', 'breakwater', 'groyne', 'quay', 'jetty') or t.get('seamark:type') == 'harbour' and False:
            P = way_pts(wid)
            if closed and t.get('area') != 'no':
                draw_area(pd, P, 255)
            elif len(P) >= 2:
                wid_m = float(t.get('width', 0) or 0) if str(t.get('width', '')).replace('.', '', 1).isdigit() else 0
                width = max(2, int(round((wid_m or (14 if mm in ('pier', 'jetty') else 10)) / cell)))
                pd.line(P, fill=255, width=width)
        if closed and is_port_land(t):
            draw_area(pod, way_pts(wid), 255)
    # 多角形の関係（multipolygon）：外側を塗って、内側を抜く
    for rid, (mem, t) in rels.items():
        if t.get('type') != 'multipolygon':
            continue
        target = None
        if is_drydock(t):
            for role, P in assemble_rings(mem, ways, nodes, px):
                if role == 'outer': draw_area(dryd, P, 255)
            continue
        if is_water(t) and t.get('water') not in ('pond', 'reservoir', 'lake', 'wastewater'):
            target = (wd, 255)
            if is_dock(t):
                rings = assemble_rings(mem, ways, nodes, px)
                for role, P in rings:
                    if role == 'outer': draw_area(dkd, P, 255)
                if depth_tag(t): dock_depths.append(([P for role, P in rings if role == 'outer'], depth_tag(t)))
                for role, P in rings:
                    if role == 'inner': draw_area(dkd, P, 0)
        elif is_port_land(t):
            target = (pod, 255)
        if not target:
            continue
        rings = assemble_rings(mem, ways, nodes, px)
        for role, P in rings:
            if role == 'outer':
                draw_area(target[0], P, target[1])
        for role, P in rings:
            if role == 'inner':
                draw_area(target[0], P, 0)
        nd += 1
    print('water areas', nd, flush=True)
    W = np.asarray(wimg) > 0
    DK = np.asarray(dimg) > 0
    Pm = np.asarray(pimg) > 0
    PORT = np.asarray(port) > 0
    DRY = np.asarray(dry) > 0
    kind[W] = 0
    kind[DK] = 2                        # ドック・泊地（決まった深さ）
    kind[DRY] = 1                       # 乾ドック（門で閉じている）は陸
    kind[Pm] = 3
    kind[(kind == 1) & PORT] = 4

    # 水深
    water = (kind == 0) | (kind == 2)
    depth = np.where(np.isnan(emod), np.nan, -emod)
    depth[~water] = np.nan
    # 水深の無い水の升目：EMODnet の縁（80m まで）はまわりの値で埋め、その先は浅い（2.5m）
    for it in range(8):
        miss = water & np.isnan(depth)
        if not miss.any():
            break
        acc = np.zeros_like(depth); cnt = np.zeros_like(depth)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            sh = np.roll(np.roll(depth, dy, 0), dx, 1)
            ok = ~np.isnan(sh)
            acc += np.where(ok, sh, 0); cnt += ok
        fill = miss & (cnt > 0)
        depth[fill] = acc[fill] / cnt[fill]
    depth[water & np.isnan(depth)] = 2.5
    # ドック：書いてある深さ（なければ港の決まり）。港の決まりより浅くはしない（1911 年の深さ：40ft ≒ 12m）
    depth[kind == 2] = np.maximum(depth[kind == 2], H['dock_depth'])
    # 港の敷地（岸壁）の前 berth_reach[m] は掘ってある
    reach = int(round(H.get('berth_reach', 200) / cell))
    near_port = PORT.copy()
    for it in range(reach):
        near_port = near_port | np.roll(near_port, 1, 0) | np.roll(near_port, -1, 0) | np.roll(near_port, 1, 1) | np.roll(near_port, -1, 1)
    bz = water & near_port
    depth[bz] = np.maximum(depth[bz], H.get('berth_depth', 12.0))
    # 岸壁の前の掘った所を、いちばん近い深い所（EMODnet の航路）まで、幅 250m の水路でつなぐ
    connect_berths(depth, water, bz, (~np.isnan(emod)) & (-emod >= H.get('berth_depth', 12.0) - 1.5), cell, 250, H.get('berth_depth', 12.0))
    depth[water] = np.maximum(depth[water], 1.0)
    # 陸：岸壁の高さ。離れた所は britain の高さ
    bs = britain_sampler()
    land_h = np.maximum(4.0, bs(LAT, LON))
    h = np.where(water, -depth, 4.0)
    # 水から 150m 以上離れた陸は、元の地形の高さへ
    near = water.copy()
    for it in range(int(150 / cell)):
        near = near | np.roll(near, 1, 0) | np.roll(near, -1, 0) | np.roll(near, 1, 1) | np.roll(near, -1, 1)
    h = np.where(~water & ~near, land_h, h)
    hdm = np.clip(np.round(h * 10), -32000, 32000).astype(np.int32) + 32768
    rgb = np.stack([(hdm >> 8).astype(np.uint8), (hdm & 255).astype(np.uint8), kind.astype(np.uint8)], axis=2)
    Image.fromarray(rgb, 'RGB').save(os.path.join(HERE, f'{key}.png'), optimize=True)
    meta = dict(key=key, name=H['name'], lat0=lat1 - (rows - 1) * dLat, lat1=lat1, lon0=lon0, lon1=lon0 + (cols - 1) * dLon,
                rows=rows, cols=cols, dLat=dLat, dLon=dLon, cell=cell, scale=0.1,
                kinds={'0': 'sea', '1': 'land', '2': 'dock water', '3': 'pier', '4': 'port land'})
    json.dump(meta, open(os.path.join(HERE, f'{key}.json'), 'w'), ensure_ascii=False, indent=1)
    print('water cells', int(water.sum()), 'dock cells', int((kind == 2).sum()), 'pier cells', int((kind == 3).sum()),
          'depth max', float(np.nanmax(depth)), flush=True)


def connect_berths(depth, water, band, deep, cell, width_m, want):
    """岸壁の前の掘った所のうち、深い航路（deep）へ船が通れないまとまりを、水の上のいちばん近い道で掘ってつなぐ。
    通れるかは、ゲームの航路探し（43-world.js の _rwDetailRoute）と同じ見方：40m の升目の、中と四隅の浅い方が 6m 以上"""
    import heapq
    from collections import deque
    f = 4
    rows, cols = depth.shape
    ny, nx = (rows - 1) // f, (cols - 1) // f
    r = int(round(width_m / 2 / cell))
    yy, xx = np.mgrid[-r:r + 1, -r:r + 1]
    disk = (yy * yy + xx * xx) <= r * r
    done = 0
    for rnd in range(200):
        H = np.where(water, -depth, 4.0)
        pts = [(2, 2), (0, 0), (f, 0), (0, f), (f, f)]
        hm = np.max(np.stack([H[b:b + ny * f:f, a:a + nx * f:f][:ny, :nx] for a, b in pts]), axis=0)
        dep = -hm
        ok = dep >= 6
        # つなぐ道は、升目がまるごと水の所だけ（桟橋のすき間など、掘れない陸のあいだは通らない）
        Wd = np.min(np.stack([water[b:b + ny * f:f, a:a + nx * f:f][:ny, :nx] for a, b in pts]), axis=0)
        Dd = deep[2::f, 2::f][:ny, :nx] & ok
        Bd = band[2::f, 2::f][:ny, :nx] & ok
        # 深い航路から通れる所
        reach = np.zeros((ny, nx), bool)
        q = deque(zip(*np.nonzero(Dd)))
        for j, i in q: reach[j, i] = True
        while q:
            j, i = q.popleft()
            for a, b in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)):
                jj, ii = j + b, i + a
                if 0 <= jj < ny and 0 <= ii < nx and ok[jj, ii] and not reach[jj, ii]:
                    reach[jj, ii] = True; q.append((jj, ii))
        lost = Bd & ~reach
        if not lost.any():
            break
        # 届かない掘った所から、水の上を通って届く所へ（いちばん短い道）
        dist = np.full((ny, nx), np.inf); prev = np.full((ny, nx), -1, dtype=np.int64)
        hq = []
        for j, i in zip(*np.nonzero(reach)):
            dist[j, i] = 0; hq.append((0.0, int(j), int(i)))
        heapq.heapify(hq)
        while hq:
            dv, j, i = heapq.heappop(hq)
            if dv > dist[j, i]: continue
            for a, b in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)):
                jj, ii = j + b, i + a
                if 0 <= jj < ny and 0 <= ii < nx and Wd[jj, ii]:
                    nd = dv + math.hypot(a, b)
                    if nd < dist[jj, ii]:
                        dist[jj, ii] = nd; prev[jj, ii] = j * nx + i; heapq.heappush(hq, (nd, jj, ii))
        dd = np.where(lost, dist, np.inf)
        k = np.unravel_index(np.argmin(dd), dd.shape)
        if not np.isfinite(dd[k]):
            break
        cj, ci = k
        if rnd < 4 or rnd % 50 == 0:
            print('  connect', rnd, 'from block', k, 'dist', round(float(dd[k]), 1), 'lost blocks', int(lost.sum()), flush=True)
        n = 0
        while n < 20000:
            y0, x0 = cj * f + 2, ci * f + 2
            ys, xs = slice(max(0, y0 - r), min(rows, y0 + r + 1)), slice(max(0, x0 - r), min(cols, x0 + r + 1))
            dk = disk[(ys.start - y0 + r):(ys.stop - y0 + r), (xs.start - x0 + r):(xs.stop - x0 + r)]
            sub = depth[ys, xs]; m = dk & water[ys, xs]
            sub[m] = np.maximum(sub[m], want)
            pv = prev[cj, ci]
            if pv < 0: break
            cj, ci = divmod(int(pv), nx); n += 1
        done += 1
    print('berth connections', done, flush=True)


def assemble_rings(mem, ways, nodes, px):
    """multipolygon の外側・内側の線をつないで輪にする"""
    out = []
    for role in ('outer', 'inner'):
        segs = []
        for typ, ref, r in mem:
            if typ == 'way' and (r or 'outer') == role and ref in ways:
                nds = [n for n in ways[ref][0] if n in nodes]
                if len(nds) >= 2:
                    segs.append(nds)
        while segs:
            ring = segs.pop(0)
            changed = True
            while ring[0] != ring[-1] and changed:
                changed = False
                for i, s in enumerate(segs):
                    if s[0] == ring[-1]: ring = ring + s[1:]
                    elif s[-1] == ring[-1]: ring = ring + s[::-1][1:]
                    elif s[-1] == ring[0]: ring = s + ring[1:]
                    elif s[0] == ring[0]: ring = s[::-1] + ring[1:]
                    else: continue
                    segs.pop(i); changed = True; break
            out.append((role, [px(*nodes[n]) for n in ring]))
    return out


if __name__ == '__main__':
    key = sys.argv[1]
    cache = os.path.join(HERE, 'cache', key)
    if '--cache' in sys.argv:
        cache = os.path.join(sys.argv[sys.argv.index('--cache') + 1], key)
    build(key, cache)
