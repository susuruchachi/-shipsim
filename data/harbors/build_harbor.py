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
    'southampton': dict(name='サウサンプトン', lat0=50.775, lat1=50.918, lon0=-1.448, lon1=-1.240, cell=10, dock_depth=22.0, berth_depth=23.0, berth_reach=400,
                        # 本航路（ドック・ヘッド → サウサンプトン・ウォーター → カルショット沖）。最低潮位で 12.6m ＋ 潮の分
                        channels=[dict(width=260, depth=24.0, pts=[[50.8973, -1.4118], [50.8923, -1.4067], [50.889, -1.4016], [50.8793, -1.3913], [50.8347, -1.3155], [50.8142, -1.2956], [50.8128, -1.2940]])]),
    # リヴァプール：マージー川（ピア・ヘッドの浮き桟橋・ドック）から、クロスビー水道・クイーンズ水道を通ってリヴァプール湾へ
    'liverpool': dict(name='リヴァプール', lat0=53.385, lat1=53.555, lon0=-3.225, lon1=-2.955, cell=10, dock_depth=22.0, berth_depth=23.0, berth_reach=250,
                      # 掘った航路（潮の満ち引きが無いので、満潮を待たずに通れる深さにする）：ピア・ヘッド → マージー川（ナローズ）→ クロスビー水道 → クイーンズ水道 → 西の縁
                      channels=[dict(width=350, depth=24.0, pts=[[53.4025, -3.0010], [53.4100, -3.0060], [53.4250, -3.0150], [53.4410, -3.0265], [53.4577, -3.0367], [53.470, -3.062], [53.4808, -3.0790], [53.5151, -3.1017], [53.521, -3.130], [53.5307, -3.1887], [53.533, -3.226]]),
                                dict(width=450, depth=24.0, pts=[[53.5296, -3.1788], [53.5307, -3.1887], [53.533, -3.226]]),
                                # クロスビー水道からクイーンズ水道へ曲がる所は広く（大きな船が回れるように。内側の通り道は自動）
                                dict(width=700, depth=24.0, pts=[[53.5040, -3.0930], [53.5151, -3.1017], [53.5185, -3.1180]]),
                                dict(width=600, depth=24.0, pts=[[53.5067, -3.0962], [53.5124, -3.1061], [53.5181, -3.1160], [53.5215, -3.1320]]),
                                # シーフォースの川の埠頭（リヴァプール2）の前：岸壁から川の深い所まで
                                dict(width=450, depth=20.0, pts=[[53.45980, -3.03490], [53.45830, -3.03760]])]),
    # グラスゴー：クライド川（キング・ジョージ5世ドック・クライドバンクのジョン・ブラウン造船所）から、グリーノック沖（テイル・オブ・ザ・バンク）まで
    'glasgow': dict(name='グラスゴー', lat0=55.845, lat1=55.975, lon0=-4.790, lon1=-4.270, cell=10, dock_depth=14.0, berth_depth=14.0, berth_reach=150,
                    river_depth=14.0,
                    # クライド川（ボウリング → アースキン → クライドバンク → レンフルー → キング・ジョージ5世ドックの前）：川の真ん中を掘る
                    auto_channels=[dict(a=[55.9300, -4.5300], b=[55.8735, -4.3533], width=140, depth=14.0)],
                    # グリーノックのオーシャン・ターミナルの前と、クライド川の本航路（南岸寄り：グリーノック → ポート・グラスゴー → ダンバートン → ボウリング）
                    channels=[dict(width=300, depth=14.0, pts=[[55.95620, -4.76121], [55.95820, -4.76121]]),
                              dict(width=200, depth=14.0, pts=[[55.9568, -4.7598], [55.9420, -4.7000], [55.9380, -4.6807], [55.9340, -4.6200], [55.9324, -4.5747], [55.9284, -4.4996]])]),
    # ベルファスト：ハーランド＆ウルフ（クイーンズ島・トンプソン・ドック）・ヴィクトリア水道から、ベルファスト湾まで
    'belfast': dict(name='ベルファスト', lat0=54.595, lat1=54.725, lon0=-5.945, lon1=-5.600, cell=10, dock_depth=22.0, berth_depth=23.0, berth_reach=250,
                    # ヴィクトリア水道の口から、ベルファスト湾を北東へ、湾口の深い所まで
                    channels=[dict(width=350, depth=24.0, pts=[[54.6320, -5.8780], [54.6362, -5.8750], [54.6600, -5.8400], [54.6900, -5.7910], [54.6950, -5.7440], [54.6980, -5.7000], [54.7050, -5.6600], [54.7120, -5.6200], [54.7180, -5.6000]])]),
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
    nodes, ways, rels, ntags = {}, {}, {}, {}
    dlat, dlon = 0.02, 0.025
    files = []
    lat = H['lat0']
    while lat < H['lat1'] - 1e-9:
        lon = H['lon0']
        while lon < H['lon1'] - 1e-9:
            files += fetch_tile(lat, min(H['lat1'], lat + dlat), lon, min(H['lon1'], lon + dlon), cache)
            lon += dlon
        lat += dlat
    pk = os.path.join(cache, 'parsed2.pickle')
    if os.path.exists(pk) and os.path.getmtime(pk) > max(os.path.getmtime(f) for f in files):
        import pickle
        nodes, ways, rels, ntags = pickle.load(open(pk, 'rb'))
        fetch_osm.ntags = ntags
        return nodes, ways, rels
    for fn in files:
        root = ET.parse(fn).getroot()
        for el in root:
            if el.tag == 'node':
                nid = int(el.get('id'))
                nodes[nid] = (float(el.get('lat')), float(el.get('lon')))
                for t in el:
                    if t.tag == 'tag' and (t.get('k').startswith('seamark') or t.get('k') in ('man_made', 'name', 'height', 'ref')):
                        ntags.setdefault(nid, {})[t.get('k')] = t.get('v')
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
    fetch_osm.ntags = ntags
    pickle.dump((nodes, ways, rels, ntags), open(pk, 'wb'), protocol=4)
    return nodes, ways, rels


# ── EMODnet の水深（esriAscii）──
def fetch_emodnet(H, cache):
    fn = os.path.join(cache, 'emodnet.asc')
    # 港の枠を広げたあとは、前に取った分が枠を覆っていないので取り直す
    #（覆っていない所を外挿すると、何百 m もの深さのような、ありえない値になる）
    if os.path.exists(fn) and os.path.getsize(fn) > 1000:
        hd = {}
        with open(fn) as f:
            for _ in range(6):
                k, v = f.readline().split(); hd[k.lower()] = float(v)
        x1 = hd['xllcenter'] + (hd['ncols'] - 1) * hd['cellsize']; y1 = hd['yllcenter'] + (hd['nrows'] - 1) * hd['cellsize']
        if hd['xllcenter'] > H['lon0'] or hd['yllcenter'] > H['lat0'] or x1 < H['lon1'] or y1 < H['lat1']:
            print('EMODnet の範囲が港の枠を覆っていないので取り直します')
            os.remove(fn)
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
    tx = np.clip(fx - x0i, 0, 1); ty = np.clip(fy - y0i, 0, 1)       # 外挿はしない
    a = E['a']
    q = [a[y0i, x0i], a[y0i, x0i + 1], a[y0i + 1, x0i], a[y0i + 1, x0i + 1]]
    w = [(1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty]
    num = sum(np.where(np.isnan(v), 0, v) * ww for v, ww in zip(q, w))
    den = sum(np.where(np.isnan(v), 0, ww) for v, ww in zip(q, w))
    emod = np.where(den > 0.25, num / np.maximum(den, 1e-9), np.nan)
    emod[(fx < -0.5) | (fy < -0.5) | (fx > E['nc'] - 0.5) | (fy > E['nr'] - 0.5)] = np.nan   # 取った範囲の外
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
    nodata = water & np.isnan(depth)
    depth[nodata] = 2.5
    # 大きな川（river_depth）：水深の測られていない川の中は、岸から離れるほど深く（岸から 15m は浅く、
    # そこから 4m 進むごとに 1m、river_depth まで）。大きな船が川の真ん中を遡れるように
    if H.get('river_depth'):
        rd = H['river_depth']
        er = water.copy(); dist = np.zeros(water.shape, np.float32)
        for it in range(int((rd * 4 + 15) / cell) + 2):
            er = er & np.roll(er, 1, 0) & np.roll(er, -1, 0) & np.roll(er, 1, 1) & np.roll(er, -1, 1)
            if not er.any():
                break
            dist += er
        prof = np.clip((dist * cell - 15) / 4.0, 0, rd)
        depth[nodata] = np.maximum(depth[nodata], prof[nodata])
    # ドック：書いてある深さ（なければ港の決まり）。港の決まりより浅くはしない（1911 年の深さ：40ft ≒ 12m）
    depth[kind == 2] = np.maximum(depth[kind == 2], H['dock_depth'])
    # 港の敷地（岸壁）の前 berth_reach[m] は掘ってある
    reach = int(round(H.get('berth_reach', 200) / cell))
    near_port = PORT.copy()
    for it in range(reach):
        near_port = near_port | np.roll(near_port, 1, 0) | np.roll(near_port, -1, 0) | np.roll(near_port, 1, 1) | np.roll(near_port, -1, 1)
    bz = water & near_port
    depth[bz] = np.maximum(depth[bz], H.get('berth_depth', 12.0))
    # 港ごとに書いた掘った航路（線と幅・深さ）：水の所だけ。
    # 曲がり角には、大きな船（旋回半径 TURN_R）が回り始める所から回り終える所まで、内側を結ぶ通り道も掘る
    TURN_R = 2200
    chans = []
    for ch in H.get('channels', []):
        chans.append(ch)
        pts = ch['pts']
        for i in range(1, len(pts) - 1):
            (la0, lo0), (la1, lo1), (la2, lo2) = pts[i - 1], pts[i], pts[i + 1]
            ax, ay = (lo0 - lo1) * mLon, (la0 - la1) * mLat
            bx, by = (lo2 - lo1) * mLon, (la2 - la1) * mLat
            A, B = math.hypot(ax, ay), math.hypot(bx, by)
            if A < 1 or B < 1: continue
            turn = math.pi - math.acos(max(-1, min(1, (ax * bx + ay * by) / (A * B))))   # 曲がる角
            if turn < math.radians(12): continue
            reach = min(TURN_R * math.tan(turn / 2), 0.45 * A, 0.45 * B)
            t1 = (la1 + ay / A * reach / mLat, lo1 + ax / A * reach / mLon)
            t2 = (la1 + by / B * reach / mLat, lo1 + bx / B * reach / mLon)
            mid = ((t1[0] + t2[0]) / 2, (t1[1] + t2[1]) / 2)
            extra = TURN_R * (1 / math.cos(turn / 2) - 1)
            chans.append(dict(width=ch['width'] + 2 * extra, depth=ch['depth'], pts=[list(t1), list(mid), list(t2)]))
    # 川の航路（auto_channels）：a から b まで、岸からできるだけ離れた所（川の真ん中）を通る道を水の上で探し、
    # 折れ線にして掘る（川の線を手で書かなくてよい。曲がりくねった川を遡る大きな船のため）
    for ac in H.get('auto_channels', []):
        pts = river_path(water, lat1, lon0, dLat, dLon, cell, ac['a'], ac['b'])
        if pts:
            print('auto channel', len(pts), 'points')
            chans.append(dict(width=ac['width'], depth=ac['depth'], pts=pts))
    for ch in chans:
        r = int(round(ch['width'] / 2 / cell))
        yy, xx = np.mgrid[-r:r + 1, -r:r + 1]
        disk = (yy * yy + xx * xx) <= r * r
        P = [((lon - lon0) / dLon, (lat1 - lat) / dLat) for lat, lon in ch['pts']]
        for (x0, y0), (x1, y1) in zip(P, P[1:]):
            L = math.hypot(x1 - x0, y1 - y0)
            for t in np.arange(0, L + 1, max(1, r / 2)):
                cx, cy = int(round(x0 + (x1 - x0) * t / max(L, 1e-9))), int(round(y0 + (y1 - y0) * t / max(L, 1e-9)))
                ys, xs = slice(max(0, cy - r), min(rows, cy + r + 1)), slice(max(0, cx - r), min(cols, cx + r + 1))
                dk = disk[(ys.start - cy + r):(ys.stop - cy + r), (xs.start - cx + r):(xs.stop - cx + r)]
                sub = depth[ys, xs]; mm = dk & water[ys, xs]
                sub[mm] = np.maximum(sub[mm], ch['depth'])
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
    export_features(key, cache, nodes, ways, water, lat1, lon0, dLat, dLon, cell)
    print('water cells', int(water.sum()), 'dock cells', int((kind == 2).sum()), 'pier cells', int((kind == 3).sum()),
          'depth max', float(np.nanmax(depth)), flush=True)


def simplify(P, tol):
    """ダグラス・ピューカー（点の数を減らす）"""
    if len(P) < 4:
        return P
    def rec(a, b):
        (x0, y0), (x1, y1) = P[a], P[b]
        L = math.hypot(x1 - x0, y1 - y0) or 1e-9
        best, bi = -1, -1
        for i in range(a + 1, b):
            d = abs((x1 - x0) * (y0 - P[i][1]) - (x0 - P[i][0]) * (y1 - y0)) / L
            if d > best: best, bi = d, i
        if best > tol:
            return rec(a, bi)[:-1] + rec(bi, b)
        return [P[a], P[b]]
    return rec(0, len(P) - 1)


def export_features(key, cache, nodes, ways, water, lat1, lon0, dLat, dLon, cell):
    """建物（水の近く）・航路の標識・クレーンを <key>_feat.json に。座標は範囲の南西の角からの m（x 東・y 北）"""
    H = HARBORS[key]
    rows, cols = water.shape
    mLat = cell / dLat; mLon = cell / dLon
    lat0 = lat1 - (rows - 1) * dLat
    # 水から 600m 以内（港のまわりの街並みも：船から見える範囲）
    near = water.copy()
    for it in range(int(600 / cell)):
        near = near | np.roll(near, 1, 0) | np.roll(near, -1, 0) | np.roll(near, 1, 1) | np.roll(near, -1, 1)
    def xy(lat, lon):
        return ((lon - lon0) * mLon, (lat - lat0) * mLat)
    def inside_near(lat, lon):
        r = int(round((lat1 - lat) / dLat)); c = int(round((lon - lon0) / dLon))
        return 0 <= r < rows and 0 <= c < cols and near[r, c]
    KIND = {'house': 0, 'residential': 0, 'semidetached_house': 0, 'detached': 0, 'bungalow': 0, 'terrace': 0, 'apartments': 0,
            'garage': 0, 'garages': 0, 'industrial': 1, 'warehouse': 1, 'hangar': 1, 'storage_tank': 3, 'silo': 3,
            'commercial': 2, 'retail': 2, 'office': 2, 'church': 4, 'cathedral': 4}
    DEFH = {0: 7.5, 1: 12.0, 2: 12.0, 3: 12.0, 4: 18.0}
    out_b = []
    for wid, (nds, t) in ways.items():
        if 'building' not in t or len(nds) < 4 or nds[0] != nds[-1]:
            continue
        pts = [nodes[n] for n in nds if n in nodes]
        if len(pts) < 4:
            continue
        clat = sum(p[0] for p in pts) / len(pts); clon = sum(p[1] for p in pts) / len(pts)
        if not inside_near(clat, clon):
            continue
        P = [xy(*p) for p in pts]
        area = 0.5 * abs(sum(P[i][0] * P[i + 1][1] - P[i + 1][0] * P[i][1] for i in range(len(P) - 1)))
        if area < 40:
            continue
        k = KIND.get(t.get('building'), 2 if area > 400 else 0)
        if t.get('man_made') in ('storage_tank', 'silo'): k = 3
        h = None
        for tag in ('height', 'building:height'):
            try: h = float(str(t.get(tag, '')).replace('m', '').strip()); break
            except ValueError: pass
        if h is None and t.get('building:levels'):
            try: h = float(t['building:levels']) * 3.2 + 1.5
            except ValueError: pass
        if h is None:
            h = DEFH[k] if area < 3000 else max(DEFH[k], 14.0)
        # 輪は、始まりから一番遠い点で 2 つに分けて減らす（始まりと終わりが同じ点だと、線が引けない）
        R = P[:-1]
        far = max(range(len(R)), key=lambda i: (R[i][0] - R[0][0]) ** 2 + (R[i][1] - R[0][1]) ** 2)
        P = simplify(R[:far + 1], 0.8)[:-1] + simplify(R[far:] + [R[0]], 0.8)[:-1]
        if len(P) < 3:
            continue
        flat = [k, round(h, 1)]
        for x, y in P: flat += [round(x, 1), round(y, 1)]
        out_b.append(flat)
    # 航路の標識（ブイ・立標・灯火）
    out_s = []
    ntags = getattr(fetch_osm, 'ntags', {})
    for nid, t in ntags.items():
        st = t.get('seamark:type')
        if not st or nid not in nodes:
            continue
        lat, lon = nodes[nid]
        if not (lat0 <= lat <= lat1 and lon0 <= lon <= lon0 + (cols - 1) * dLon):
            continue
        if st not in ('buoy_lateral', 'beacon_lateral', 'buoy_cardinal', 'beacon_cardinal', 'buoy_special_purpose', 'beacon_special_purpose',
                      'buoy_safe_water', 'buoy_isolated_danger', 'light_minor', 'light_major', 'landmark', 'berth'):
            continue
        base = st.split('_')[0] if st.startswith(('buoy', 'beacon')) else st
        colour = t.get(f'seamark:{st}:colour', t.get('seamark:light:colour', ''))
        cat = t.get(f'seamark:{st}:category', '')
        shape = t.get(f'seamark:{st}:shape', '')
        lc = t.get('seamark:light:colour', t.get('seamark:light:1:colour', ''))
        x, y = xy(lat, lon)
        out_s.append([round(x, 1), round(y, 1), st, colour, cat, shape, lc, t.get('seamark:name', t.get('name', ''))])
    out_c = []
    for nid, t in ntags.items():
        if t.get('man_made') == 'crane' and nid in nodes:
            x, y = xy(*nodes[nid]); out_c.append([round(x, 1), round(y, 1)])
    for wid, (nds, t) in ways.items():
        if t.get('man_made') == 'crane':
            pts = [nodes[n] for n in nds if n in nodes]
            if pts:
                x, y = xy(sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)); out_c.append([round(x, 1), round(y, 1)])
    json.dump({'b': out_b, 's': out_s, 'c': out_c}, open(os.path.join(HERE, f'{key}_feat.json'), 'w'), ensure_ascii=False, separators=(',', ':'))
    print('features: buildings', len(out_b), 'seamarks', len(out_s), 'cranes', len(out_c), 'bytes', os.path.getsize(os.path.join(HERE, f'{key}_feat.json')), flush=True)


def river_path(water, lat1, lon0, dLat, dLon, cell, A, B, f=2):
    """水の上で、A から B まで、岸から離れた所を通る道（緯度・経度の折れ線）。f 升ずつまとめて探す"""
    import heapq
    rows, cols = water.shape
    ny, nx = rows // f, cols // f
    w = water[:ny * f, :nx * f].reshape(ny, f, nx, f).all(axis=(1, 3))
    # 岸からの距離（升目）：削っていく
    d = np.zeros(w.shape, np.int32); er = w.copy()
    for it in range(40):
        er = er & np.roll(er, 1, 0) & np.roll(er, -1, 0) & np.roll(er, 1, 1) & np.roll(er, -1, 1)
        if not er.any(): break
        d += er
    cost = np.where(w, 1.0 + 60.0 / (1.0 + d.astype(np.float64)) ** 2, np.inf)
    def ij(q): return int(round((lat1 - q[0]) / dLat / f)), int(round((q[1] - lon0) / dLon / f))
    s, t = ij(A), ij(B)
    # 始まり・終わりが水でなければ、近くの水へ
    def snap(p):
        best = None
        for r in range(0, 30):
            for a in range(-r, r + 1):
                for b in (-r, r) if abs(a) != r else range(-r, r + 1):
                    j, i = p[0] + a, p[1] + b
                    if 0 <= j < ny and 0 <= i < nx and w[j, i]:
                        return (j, i)
        return None
    s, t = snap(s), snap(t)
    if not s or not t: return None
    dist = np.full(w.shape, np.inf); prev = {}
    dist[s] = 0; hq = [(0.0, s)]
    nb = [(1, 0, 1), (-1, 0, 1), (0, 1, 1), (0, -1, 1), (1, 1, 1.414), (1, -1, 1.414), (-1, 1, 1.414), (-1, -1, 1.414)]
    while hq:
        g, (j, i) = heapq.heappop(hq)
        if (j, i) == t: break
        if g > dist[j, i]: continue
        for a, b, L in nb:
            jj, ii = j + a, i + b
            if 0 <= jj < ny and 0 <= ii < nx and w[jj, ii]:
                ng = g + L * cost[jj, ii]
                if ng < dist[jj, ii]:
                    dist[jj, ii] = ng; prev[(jj, ii)] = (j, i); heapq.heappush(hq, (ng, (jj, ii)))
    if t not in prev: return None
    path = [t]
    while path[-1] != s: path.append(prev[path[-1]])
    path.reverse()
    # 間引き（線からのずれが 2 升以内なら省く）
    def simp(P):
        if len(P) < 3: return P
        (y0, x0), (y1, x1) = P[0], P[-1]
        L = math.hypot(y1 - y0, x1 - x0) or 1
        dm, k = -1, 0
        for q in range(1, len(P) - 1):
            y, x = P[q]; dd = abs((x1 - x0) * (y0 - y) - (x0 - x) * (y1 - y0)) / L
            if dd > dm: dm, k = dd, q
        return simp(P[:k + 1])[:-1] + simp(P[k:]) if dm > 2 else [P[0], P[-1]]
    P = simp(path)
    return [[round(lat1 - (j + 0.5) * f * dLat, 5), round(lon0 + (i + 0.5) * f * dLon, 5)] for j, i in P]


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
