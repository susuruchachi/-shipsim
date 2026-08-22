import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from analyze_hull import load_verts, scan_hull_profile

MAX_WL_PTS = 32
TIP_PTS = 2

def build_polygon(hp):
    sl = hp['slices']
    sCount = len(sl)
    N_SIDE = (MAX_WL_PTS - TIP_PTS * 2) // 2
    halfLen = hp['halfLen']

    def emit_side(sign, reverse):
        pts = []
        for k in range(N_SIDE):
            i = (N_SIDE - 1 - k) if reverse else k
            idx = min(sCount - 1, round(i * (sCount - 1) / (N_SIDE - 1)))
            s = sl[idx]
            pts.append((s['alongNorm'] * halfLen, sign * s['halfWidth']))
        return pts

    poly = []
    poly += emit_side(1, False)
    poly.append((hp['bowTipAlongNorm'] * halfLen, 1 * hp['bowTipWidth']))
    poly.append((hp['bowTipAlongNorm'] * halfLen, -1 * hp['bowTipWidth']))
    poly += emit_side(-1, True)
    poly.append((hp['sternTipAlongNorm'] * halfLen, -1 * hp['sternTipWidth']))
    poly.append((hp['sternTipAlongNorm'] * halfLen, 1 * hp['sternTipWidth']))
    return poly

def plot_ship(name, path, ax, fix_ordering=False):
    verts, exc, names = load_verts(path, exclude=True)
    hp = scan_hull_profile(verts)
    sl = hp['slices']

    if fix_ordering:
        eps = (sl[-1]['alongNorm'] - sl[-2]['alongNorm']) * 0.15
        if hp['bowTipAlongNorm'] <= sl[-1]['alongNorm']:
            hp['bowTipAlongNorm'] = sl[-1]['alongNorm'] + eps
        eps2 = (sl[1]['alongNorm'] - sl[0]['alongNorm']) * 0.15
        if hp['sternTipAlongNorm'] >= sl[0]['alongNorm']:
            hp['sternTipAlongNorm'] = sl[0]['alongNorm'] - eps2

    poly = build_polygon(hp)
    xs = [p[0] for p in poly] + [poly[0][0]]
    zs = [p[1] for p in poly] + [poly[0][1]]
    ax.plot(xs, zs, '-o', markersize=3, linewidth=1)
    ax.set_aspect('equal')
    ax.set_title(f"{name}{' (FIXED)' if fix_ordering else ''}")
    ax.axhline(0, color='gray', linewidth=0.5)

fig, axes = plt.subplots(2, 4, figsize=(20, 8))
files = {
    'Titanic': "/mnt/user-data/uploads/Royal_mail_ship_Titanic_mirrored__2_.glb",
    'Homeric': "/mnt/user-data/uploads/Homeric.glb",
    'Teutonic': "/mnt/user-data/uploads/Teutonic.glb",
    'Mauretania2': "/mnt/user-data/uploads/Mauretania2.glb",
}
for i, (name, path) in enumerate(files.items()):
    plot_ship(name, path, axes[0, i], fix_ordering=False)
    plot_ship(name, path, axes[1, i], fix_ordering=True)
plt.tight_layout()
plt.savefig('/home/claude/work/polygon_compare.png', dpi=130)
print("saved")

# zoomed bow-only view for Titanic before/after
fig2, axes2 = plt.subplots(1, 2, figsize=(12, 6))
verts, exc, names = load_verts(files['Titanic'], exclude=True)
hp = scan_hull_profile(verts)
poly = build_polygon(hp)
xs = [p[0] for p in poly] + [poly[0][0]]
zs = [p[1] for p in poly] + [poly[0][1]]
axes2[0].plot(xs, zs, '-o', markersize=5)
axes2[0].set_xlim(hp['halfLen']*0.75, hp['halfLen']*1.05)
axes2[0].set_title("Titanic bow zoom (BEFORE fix)")
axes2[0].set_aspect('equal')

sl = hp['slices']
eps = (sl[-1]['alongNorm'] - sl[-2]['alongNorm']) * 0.15
hp['bowTipAlongNorm'] = max(hp['bowTipAlongNorm'], sl[-1]['alongNorm'] + eps)
poly2 = build_polygon(hp)
xs2 = [p[0] for p in poly2] + [poly2[0][0]]
zs2 = [p[1] for p in poly2] + [poly2[0][1]]
axes2[1].plot(xs2, zs2, '-o', markersize=5, color='green')
axes2[1].set_xlim(hp['halfLen']*0.75, hp['halfLen']*1.05)
axes2[1].set_title("Titanic bow zoom (AFTER fix)")
axes2[1].set_aspect('equal')
plt.tight_layout()
plt.savefig('/home/claude/work/titanic_bow_zoom.png', dpi=130)
print("saved zoom")
