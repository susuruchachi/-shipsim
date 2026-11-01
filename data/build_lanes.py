# 世界全体の航路（67-sea-lanes.js が世界（実在）で使う）：data/world/lanes_src.txt → data/world/lanes.json
#   python3 build_lanes.py
# 区画（data/world/t*.webp）と全体図の地形で、
#  ・浅い（25m より浅い）航路の点を、近く（40km まで）のいちばん近い深い所へ寄せる
#  ・まっすぐ（大圏で）結ぶと陸・浅瀬（12m より浅い）を横切る区間に、沖の中継点を足す（3 段まで）
# 北大西洋の航路の点（67-sea-lanes.js の SEA_LANE_NODES）はそのまま使う（ブリテン諸島・アメリカ東海岸は細かい格子で調べてある）
import json, math, os, re
import numpy as np
from PIL import Image
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
WD = os.path.join(HERE, 'world')
idx = json.load(open(os.path.join(WD, 'index.json'))); ov = json.load(open(os.path.join(WD, 'overview.json')))
LAT0, LON0, CELL, T = idx['lat0'], idx['lon0'], idx['cell'], idx['tile']

def img(fn):
    a = np.asarray(Image.open(fn).convert('RGB')).astype(np.int32)
    return (a[..., 0] * 256 + a[..., 1] - 32768).astype(np.int16)

# 1.5 分角の全体の格子（南が 0 行）：全体図で埋めてから、ある区画で上書き
G = np.zeros((idx['rows'], idx['cols']), dtype=np.int16)
O = img(os.path.join(WD, 'overview.webp'))[::-1, :-1]            # 南から・経度の重なりを除く
G[:O.shape[0] * 4, :O.shape[1] * 4] = np.repeat(np.repeat(O, 4, axis=0), 4, axis=1)
for k in idx['have']:
    ti, tj = [int(x) for x in k.split('_')]
    t = img(os.path.join(WD, 't%02d_%02d.webp' % (ti, tj)))[::-1]
    r0, c0 = ti * T, tj * T
    rows = min(t.shape[0], G.shape[0] - r0)
    G[r0:r0 + rows, c0:c0 + T] = t[:rows, :T]

def H(lat, lon):
    lat = np.asarray(lat, dtype=np.float64); lon = np.asarray(lon, dtype=np.float64)
    i = np.clip(np.rint((lat - LAT0) / CELL).astype(int), 0, G.shape[0] - 1)
    j = np.rint((((lon - LON0) % 360) + 360) % 360 / CELL).astype(int) % G.shape[1]
    return G[i, j]

R = 6371000.0
def unit(lat, lon):
    la, lo = np.radians(lat), np.radians(lon)
    return np.array([np.cos(la) * np.cos(lo), np.sin(la), np.cos(la) * np.sin(lo)])
def dist(a, b):
    return R * math.acos(max(-1.0, min(1.0, float(np.dot(unit(*a), unit(*b))))))
def gc_pts(a, b, step=3000.0):
    A, B = unit(*a), unit(*b)
    om = math.acos(max(-1.0, min(1.0, float(np.dot(A, B)))))
    n = max(2, int(om * R / step))
    if om < 1e-9: return np.array([a[0]]), np.array([a[1]])
    u = np.linspace(0, 1, n + 1)[1:-1]
    s0 = np.sin((1 - u) * om) / math.sin(om); s1 = np.sin(u * om) / math.sin(om)
    P = np.outer(s0, A) + np.outer(s1, B)
    return np.degrees(np.arcsin(np.clip(P[:, 1], -1, 1))), np.degrees(np.arctan2(P[:, 2], P[:, 0]))
def bad_count(a, b, need=-12):
    la, lo = gc_pts(a, b)
    return int((H(la, lo) > need).sum()) if len(la) else 0
def dest(p, brg, d):
    la, lo, b, dr = math.radians(p[0]), math.radians(p[1]), math.radians(brg), d / R
    la2 = math.asin(math.sin(la) * math.cos(dr) + math.cos(la) * math.sin(dr) * math.cos(b))
    lo2 = lo + math.atan2(math.sin(b) * math.sin(dr) * math.cos(la), math.cos(dr) - math.sin(la) * math.sin(la2))
    return (math.degrees(la2), (math.degrees(lo2) + 540) % 360 - 180)
def bearing(a, b):
    la1, la2, dl = math.radians(a[0]), math.radians(b[0]), math.radians(b[1] - a[1])
    return math.degrees(math.atan2(math.sin(dl) * math.cos(la2), math.cos(la1) * math.sin(la2) - math.sin(la1) * math.cos(la2) * math.cos(dl)))
def gc_at(a, b, u):
    A, B = unit(*a), unit(*b)
    om = math.acos(max(-1.0, min(1.0, float(np.dot(A, B)))))
    if om < 1e-9: return a
    P = A * math.sin((1 - u) * om) / math.sin(om) + B * math.sin(u * om) / math.sin(om)
    return (math.degrees(math.asin(max(-1, min(1, P[1])))), math.degrees(math.atan2(P[2], P[0])))

# 北大西洋の点
js = open(os.path.join(ROOT, 'js', '67-sea-lanes.js')).read()
natl = {}
for m in re.finditer(r"(\w+): \[([-\d.]+), ([-\d.]+), '([^']+)'\]", js.split('const SEA_LANE_EDGES')[0]):
    natl[m.group(1)] = (float(m.group(2)), float(m.group(3)), m.group(4))
# 元の一覧
nodes, edges, sec = {}, [], None
for line in open(os.path.join(WD, 'lanes_src.txt')):
    line = line.strip()
    if not line or line.startswith('#'): continue
    if line in ('[nodes]', '[edges]'): sec = line; continue
    for it in line.split('|'):
        it = it.strip()
        if sec == '[nodes]':
            p = it.split()
            if len(p) >= 4: nodes[p[0]] = [float(p[1]), float(p[2]), ' '.join(p[3:])]
        elif sec == '[edges]':
            ks = [k for k in it.split('-') if k]
            for a, b in zip(ks, ks[1:]): edges.append((a, b))
allp = dict(natl); allp.update({k: tuple(v) for k, v in nodes.items()})
miss = sorted({k for e in edges for k in e if k not in allp})
assert not miss, miss

# 浅い点を寄せる
moved = []
def ok_at(p, need, ring):
    if H(p[0], p[1]) > need: return False
    for a in range(0, 360, 45):
        q = dest(p, a, ring)
        if H(q[0], q[1]) > -8: return False
    return True
for k, v in nodes.items():
    p = (v[0], v[1])
    if ok_at(p, -25, 2000): continue
    best = None
    for need, rmax in ((-25, 40000), (-12, 20000)):
        for r in range(2000, rmax + 1, 2000):
            cands = [dest(p, a, r) for a in range(0, 360, 15)]
            good = [q for q in cands if ok_at(q, need, 1500)]
            if good: best = min(good, key=lambda q: H(q[0], q[1])); break
        if best: break
    if best:
        moved.append((k, v[2], round(dist(p, best) / 1000, 1), int(H(*p)), int(H(*best))))
        v[0], v[1] = round(best[0], 4), round(best[1], 4)
        allp[k] = (v[0], v[1], v[2])
print('moved', len(moved))
for m in moved: print('  ', m)

# 陸を横切る区間に、沖の中継点を足す
wp = {}
def short(n): return re.sub(r'（.*?）', '', n).replace('沖', '')
def fix(a, b, depth, nm=None):
    A, B = allp[a][:2], allp[b][:2]
    nm = nm or '%s〜%s' % (short(allp[a][2]), short(allp[b][2]))      # 中継点の名前：元の区間の両端
    if bad_count(A, B) == 0 or depth >= 3: return [a, b]
    L = dist(A, B); best = None
    for u in (0.15, 0.3, 0.5, 0.7, 0.85):
        m = gc_at(A, B, u); br = bearing(m, B) if u < 1 else bearing(A, m)
        for d in (15, 30, 60, 100, 150, 220, 320, 450, 650, 900):
            d *= 1000.0
            if d > max(60000.0, 0.8 * L): continue
            for s in (90, -90):
                q = dest(m, br + s, d)
                if H(q[0], q[1]) > -40: continue
                c = bad_count(A, q) + bad_count(q, B)
                score = dist(A, q) + dist(q, B) + c * 50000.0
                if best is None or score < best[0]: best = (score, q, c)
    if best is None: return [a, b]
    key = 'X%d' % (len(wp) + 1)
    wp[key] = [round(best[1][0], 4), round(best[1][1], 4), nm]
    allp[key] = tuple(wp[key])
    left = fix(a, key, depth + 1, nm); right = fix(key, b, depth + 1, nm)
    return left + right[1:]
out_edges, still = [], []
for a, b in edges:
    if a in natl and b in natl: out_edges.append((a, b)); continue
    seq = fix(a, b, 0)
    for x, y in zip(seq, seq[1:]):
        out_edges.append((x, y))
        n = bad_count(allp[x][:2], allp[y][:2])
        if n: still.append((x, y, n))
print('waypoints', len(wp), 'edges', len(out_edges), 'still crossing', len(still))
for s in still: print('  ', s, allp[s[0]][2], allp[s[1]][2])
nodes.update(wp)
json.dump({'v': 1, 'nodes': nodes, 'edges': out_edges}, open(os.path.join(WD, 'lanes.json'), 'w'), ensure_ascii=False, separators=(',', ':'))
print('lanes.json', os.path.getsize(os.path.join(WD, 'lanes.json')))
