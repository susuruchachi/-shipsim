// ════════════════════════════════════════════════════════════════
//  作り込んだ港の建物・航路の標識・クレーン（data/harbors/<key>_feat.json）
//  ・建物：OpenStreetMap の輪郭と高さ（無ければ種類ごとの高さ）。1km 四方ごとにまとめ、船から 3km の所だけ作る
//  ・航路の標識：ブイ（赤＝円筒・緑＝円錐・方位標識は黄と黒）、立標、灯火。ブイは波で上下し、夜は灯りが点滅する
//  ・クレーン：岸壁のクレーン。腕は水の方へ
//  座標は港の枠の南西の角からの m（x 東・y 北）。物理の面では +x が西なので、x は引く
// ════════════════════════════════════════════════════════════════
const HD_TILE = 1000, HD_RANGE = 3000;
const hdState = { key: null, frame: '', feat: null, loading: null, tiles: new Map(), marks: null, cranes: null, lights: [], group: null };
window.hdState = hdState;

function _hdFrameKey(d) { return d.key + '@' + world.ref.lat.toFixed(6) + ',' + world.ref.lon.toFixed(6); }
function _hdOrigin(d) { return worldUnitToLocal(worldLatLonToUnit(d.lat0, d.lon0)); }

// 船のまわりにかかる作り込んだ港
function _hdNearDetail(cx, cz) {
    if (!_RW || !_RW.hd) return null;
    const ll = worldUnitToLatLon(worldLocalToUnit(cx, cz));
    const m = HD_RANGE + 1000, dLat = m / WORLD_R * 57.29577951308232, dLon = dLat / Math.max(0.1, Math.cos(ll.lat / 57.29577951308232));
    return _RW.hd.find(d => ll.lat > d.lat0 - dLat && ll.lat < d.lat1 + dLat && ll.lon > d.lon0 - dLon && ll.lon < d.lon1 + dLon) || null;
}

function _hdClear() {
    if (hdState.group) {
        scene.remove(hdState.group);
        hdState.group.traverse(o => { if (o.geometry && !o.userData.sharedGeo) o.geometry.dispose(); });
    }
    hdState.group = null; hdState.tiles.clear(); hdState.marks = null; hdState.cranes = null; hdState.lights = []; hdState.frame = '';
}

// ── 建物（1 区画ぶんを 1 つの網に）──
const _HD_COLORS = {
    0: { wall: [0x9c5b43, 0xa86a4c, 0xb9a58a, 0x8e5a48, 0xc8b89c], roof: [0x4a4a52, 0x6b3a2e, 0x55504c] },   // 家（レンガ・漆喰、スレート・瓦）
    1: { wall: [0x7f8a94, 0x8c9098, 0x6f7c86, 0x9a9384], roof: [0x5d6670, 0x6d7278] },                          // 倉庫・工場
    2: { wall: [0xc8bda8, 0xa9a39a, 0xb8b0a0, 0x9fa6ad], roof: [0x6a6a6a, 0x5a5e62] },                          // 事務所・店・ターミナル
    3: { wall: [0xd8d8d4, 0xcfd2d0], roof: [0xc8c8c4] },                                                        // タンク・サイロ
    4: { wall: [0xb8ae98], roof: [0x55575c] },                                                                  // 教会
};
function _hdPick(arr, i) { return arr[Math.abs(i * 2654435761 | 0) % arr.length]; }
function _hdBuildTile(d, list, org) {
    const pos = [], col = [], idx = [];
    const c = new THREE.Color();
    const mLat = d.cell / d.dLat, mLon = d.cell / d.dLon;
    const push = (x, y, z, hex, shade) => { c.setHex(hex).convertSRGBToLinear().multiplyScalar(shade); pos.push(x, y, z); col.push(c.r, c.g, c.b); return pos.length / 3 - 1; };
    for (const b of list) {
        const kind = b[0], H = b[1], n = (b.length - 2) / 2;
        if (n < 3) continue;
        let ex = 0, ny = 0, area = 0;
        const P = [];
        for (let i = 0; i < n; i++) { const x = b[2 + i * 2], y = b[3 + i * 2]; P.push([x, y]); ex += x; ny += y; }
        ex /= n; ny /= n;
        for (let i = 0; i < n; i++) { const a = P[i], q = P[(i + 1) % n]; area += a[0] * q[1] - q[0] * a[1]; }
        if (area < 0) P.reverse();                                  // 反時計回り（上から見て）にそろえる
        // 地面の高さ（建物の真ん中）。水の上には建てない
        const g0 = _rwDetailAt(d, d.lat0 + ny / mLat, d.lon0 + ex / mLon);
        if (!(g0 > 0.3)) continue;
        const base = g0 - 0.8, top = g0 + H;
        const seed = Math.round(ex * 7 + ny * 13);
        const C = _HD_COLORS[kind] || _HD_COLORS[2];
        const wall = _hdPick(C.wall, seed), roof = _hdPick(C.roof, seed + 1);
        const L = P.map(([x, y]) => [org.x - x, org.z + y]);        // 物理の面（x は西が +）
        // 壁：辺ごとに 4 点・三角形 2 つ（向きで少し明るさを変える）
        for (let i = 0; i < n; i++) {
            const a = L[i], q = L[(i + 1) % n];
            const nx = q[1] - a[1], nz = -(q[0] - a[0]), nl = Math.hypot(nx, nz) || 1;
            const shade = 0.72 + 0.28 * (0.5 + 0.5 * (nx * 0.6 + nz * 0.8) / nl);
            const i0 = push(a[0], base, a[1], wall, shade), i1 = push(q[0], base, q[1], wall, shade), i2 = push(q[0], top, q[1], wall, shade), i3 = push(a[0], top, a[1], wall, shade);
            idx.push(i0, i2, i1, i0, i3, i2);
        }
        // 屋根
        const contour = P.map(([x, y]) => new THREE.Vector2(x, y));
        let tris;
        try { tris = THREE.ShapeUtils.triangulateShape(contour, []); } catch (e) { tris = []; }
        const r0 = pos.length / 3;
        for (const [x, z] of L) push(x, top, z, roof, 1.0);
        for (const t of tris) idx.push(r0 + t[0], r0 + t[2], r0 + t[1]);
    }
    if (!idx.length) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    if (!_hdBuildTile.mat) _hdBuildTile.mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0.0 });
    const m = new THREE.Mesh(geo, _hdBuildTile.mat);
    m.receiveShadow = true; m.castShadow = false;
    m.userData.noLightBake = true;
    return m;
}

// ── 航路の標識 ──
const _hdGeo = {};
function _hdG(key, make) { if (!_hdGeo[key]) _hdGeo[key] = make(); return _hdGeo[key]; }
function _hdMat(hex, opts) {
    const k = hex + JSON.stringify(opts || {});
    if (!_hdMat.c) _hdMat.c = {};
    if (!_hdMat.c[k]) { const m = new THREE.MeshStandardMaterial(Object.assign({ roughness: 0.6, metalness: 0.1 }, opts || {})); m.color.setHex(hex).convertSRGBToLinear(); _hdMat.c[k] = m; }
    return _hdMat.c[k];
}
function _hdColourHex(s) {
    s = (s || '').split(';')[0];
    return { red: 0xc8202a, green: 0x1f8a3a, yellow: 0xe8c01c, black: 0x1a1a1a, white: 0xeeeeea, orange: 0xe07020 }[s] || 0xc8c8c8;
}
function _hdLightHex(s) {
    s = (s || '').split(';')[0];
    return { red: 0xff3020, green: 0x30ff60, yellow: 0xffd040, white: 0xfff6e0, orange: 0xffa040, blue: 0x5080ff }[s] || 0;
}
function _hdMark(m, org) {
    const [x, y, st, colour, cat, shape, lc] = m;
    const g = new THREE.Group();
    g.position.set(org.x - x, 0, org.z + y);
    const col = _hdColourHex(colour);
    const floating = st.startsWith('buoy');
    const add = (geo, mat, px, py, pz) => { const o = new THREE.Mesh(geo, mat); o.position.set(px, py, pz); o.userData.sharedGeo = true; o.castShadow = false; g.add(o); return o; };
    let lampY = 4;
    if (floating) {
        // 柱形のブイ：浮き＋柱＋頭の形（左舷（赤）は円筒、右舷（緑）は円錐）
        add(_hdG('buoyBase', () => new THREE.CylinderGeometry(1.3, 1.5, 1.6, 12)), _hdMat(col), 0, 0.2, 0);
        add(_hdG('buoyPillar', () => new THREE.CylinderGeometry(0.35, 0.45, 3.2, 8)), _hdMat(col), 0, 2.4, 0);
        if (st === 'buoy_cardinal') {
            add(_hdG('buoyBand', () => new THREE.CylinderGeometry(1.32, 1.32, 0.6, 12)), _hdMat(0x1a1a1a), 0, 0.5, 0);
            add(_hdG('cone', () => new THREE.ConeGeometry(0.45, 0.8, 10)), _hdMat(0x1a1a1a), 0, 4.4, 0);
        } else if (/green/.test(colour) || shape === 'conical') add(_hdG('cone', () => new THREE.ConeGeometry(0.45, 0.8, 10)), _hdMat(col), 0, 4.4, 0);
        else add(_hdG('can', () => new THREE.CylinderGeometry(0.4, 0.4, 0.7, 10)), _hdMat(col), 0, 4.35, 0);
        lampY = 4.1;
    } else if (st.startsWith('beacon')) {
        // 立標：海底からの柱と頭の形
        add(_hdG('pole', () => new THREE.CylinderGeometry(0.22, 0.3, 10, 8)), _hdMat(col), 0, 1, 0);
        if (/green/.test(colour)) add(_hdG('cone', () => new THREE.ConeGeometry(0.45, 0.8, 10)), _hdMat(col), 0, 6.4, 0);
        else add(_hdG('can', () => new THREE.CylinderGeometry(0.4, 0.4, 0.7, 10)), _hdMat(col), 0, 6.35, 0);
        lampY = 6.8;
    } else if (st === 'light_major') {
        // 大きな灯台
        add(_hdG('lhTower', () => new THREE.CylinderGeometry(1.6, 2.4, 16, 12)), _hdMat(0xeeeeea), 0, 8, 0);
        add(_hdG('lhBand', () => new THREE.CylinderGeometry(1.75, 1.95, 3, 12)), _hdMat(0xc02020), 0, 10, 0);
        add(_hdG('lhLamp', () => new THREE.CylinderGeometry(1.2, 1.2, 2, 10)), _hdMat(0x333333), 0, 17, 0);
        lampY = 17;
    } else if (st === 'light_minor') {
        // 桟橋・岸壁の小さな灯（柱）
        add(_hdG('lampPost', () => new THREE.CylinderGeometry(0.12, 0.15, 5, 6)), _hdMat(0x707070), 0, 2.5, 0);
        lampY = 5.2;
    } else return null;
    // 灯り（夜だけ・点滅）
    const lh = _hdLightHex(lc) || (st === 'light_minor' || st === 'light_major' ? 0xfff6e0 : (/red/.test(colour) ? 0xff3020 : /green/.test(colour) ? 0x30ff60 : 0));
    let lamp = null;
    if (lh) {
        const mat = new THREE.MeshBasicMaterial({ color: lh, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
        lamp = new THREE.Mesh(_hdG('lampGlow', () => new THREE.SphereGeometry(st === 'light_major' ? 2.2 : 0.9, 10, 8)), mat);
        lamp.userData.sharedGeo = true;
        lamp.position.y = lampY;
        g.add(lamp);
    }
    // 点滅：3〜6 秒ごとに 0.5〜1 秒（位置で決まる）
    const r = Math.abs(Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1;
    return { g, floating, lamp, period: 3 + 3 * r, on: 0.5 + 0.5 * r, phase: r * 10 };
}

// ── クレーン：4 本脚の門形＋水の方へ伸びる腕 ──
function _hdCrane(d, cr, org) {
    const [x, y] = cr;
    const mLat = d.cell / d.dLat, mLon = d.cell / d.dLon;
    const lat = d.lat0 + y / mLat, lon = d.lon0 + x / mLon;
    if (!(_rwDetailAt(d, lat, lon) > 0.3)) return null;
    // 水の方（まわり 80m で一番深い向き）
    let best = 0, bd = 0;
    for (let k = 0; k < 16; k++) {
        const a = k / 16 * Math.PI * 2, e = Math.sin(a) * 60, n = Math.cos(a) * 60;
        const h = _rwDetailAt(d, lat + n / mLat, lon + e / mLon);
        if (-h > bd) { bd = -h; best = a; }
    }
    const g = new THREE.Group();
    g.position.set(org.x - x, _rwDetailAt(d, lat, lon), org.z + y);
    g.rotation.y = Math.atan2(-Math.sin(best), Math.cos(best));      // 物理の面：東は −x
    const mat = _hdMat(0xd8742a), dark = _hdMat(0x3a3a3a);
    const box = _hdG('unitBox', () => new THREE.BoxGeometry(1, 1, 1));
    const add = (w, h, dd, px, py, pz, m) => { const o = new THREE.Mesh(box, m); o.scale.set(w, h, dd); o.position.set(px, py, pz); o.userData.sharedGeo = true; g.add(o); };
    for (const sx of [-8, 8]) for (const sz of [-9, 9]) add(1.4, 34, 1.4, sx, 17, sz, mat);
    add(18, 3, 2, 0, 34, -9, mat); add(18, 3, 2, 0, 34, 9, mat);
    add(3, 3, 80, 0, 38, 22, mat);                                   // 腕（水の方 +z）
    add(10, 6, 8, 0, 41, -8, dark);                                  // 機械室
    return g;
}

// ── 毎フレーム（44-world-terrain.js の updateWorldTerrain から）──
function updateHarborDetail(t, dt) {
    if (!window.world || world.mode !== 'world' || !_RW || !_RW.hd || typeof scene === 'undefined') { if (hdState.group) _hdClear(); return; }
    const cx = physics.cgWorldX || 0, cz = physics.cgWorldZ || 0;
    const d = _hdNearDetail(cx, cz);
    if (!d) { if (hdState.group) _hdClear(); return; }
    const fk = _hdFrameKey(d);
    if (hdState.frame !== fk) {
        _hdClear();
        hdState.frame = fk; hdState.key = d.key;
        hdState.group = new THREE.Group(); hdState.group.name = 'HarborDetail:' + d.key;
        scene.add(hdState.group);
    }
    if (!hdState.feat || hdState.feat.key !== d.key) {
        if (!hdState.loading) {
            hdState.loading = fetch('data/harbors/' + d.key + '_feat.json').then(r => r.json()).then(F => { F.key = d.key; hdState.feat = F; hdState.loading = null; })
                .catch(e => { console.warn('港の建物を読めませんでした', e); hdState.loading = null; hdState.feat = { key: d.key, b: [], s: [], c: [] }; });
        }
        return;
    }
    const F = hdState.feat, org = _hdOrigin(d);
    // 建物：船から HD_RANGE の区画を作り、離れた区画は捨てる（区画の番号は、枠の南西の角からの km）
    if (!F._tiles) {
        F._tiles = new Map();
        for (const b of F.b) {
            let ex = 0, ny = 0; const n = (b.length - 2) / 2;
            for (let i = 0; i < n; i++) { ex += b[2 + i * 2]; ny += b[3 + i * 2]; }
            const k = Math.floor(ex / n / HD_TILE) + ',' + Math.floor(ny / n / HD_TILE);
            if (!F._tiles.has(k)) F._tiles.set(k, []);
            F._tiles.get(k).push(b);
        }
    }
    const sx = org.x - cx, sy = cz - org.z;                          // 船の位置（枠の角からの東・北 m）
    if (!hdState.lastTileCheck || t - hdState.lastTileCheck > 1) {
        hdState.lastTileCheck = t;
        let built = 0;
        for (const [k, list] of F._tiles) {
            const [ti, tj] = k.split(',').map(Number);
            const dx = Math.max(0, Math.abs((ti + 0.5) * HD_TILE - sx) - HD_TILE / 2), dy = Math.max(0, Math.abs((tj + 0.5) * HD_TILE - sy) - HD_TILE / 2);
            const want = Math.hypot(dx, dy) < HD_RANGE;
            const have = hdState.tiles.get(k);
            if (want && have === undefined && built < 2) {            // 1 秒に 2 区画まで（引っかからないよう）
                const m = _hdBuildTile(d, list, org);
                hdState.tiles.set(k, m);
                if (m) hdState.group.add(m);
                built++;
            } else if (!want && have !== undefined && Math.hypot(dx, dy) > HD_RANGE + 1500) {
                if (have) { hdState.group.remove(have); have.geometry.dispose(); }
                hdState.tiles.delete(k);
            }
        }
    }
    // 標識・クレーン（一度だけ）
    if (!hdState.marks) {
        hdState.marks = [];
        for (const m of F.s) { const o = _hdMark(m, org); if (o) { hdState.group.add(o.g); hdState.marks.push(o); } }
        hdState.cranes = [];
        for (const c of F.c) { const o = _hdCrane(d, c, org); if (o) { hdState.group.add(o); hdState.cranes.push(o); } }
    }
    // ブイは波で上下、灯りは夜だけ点滅（遠くのは動かさない）
    const nf = (typeof lightingNightFactor !== 'undefined') ? lightingNightFactor : 0;
    for (const o of hdState.marks) {
        const p = o.g.position;
        const far = Math.abs(p.x - cx) > 4000 || Math.abs(p.z - cz) > 4000;
        if (o.floating && !far && typeof getOceanHeight === 'function') p.y = getOceanHeight(p.x, p.z, t) - 0.6;
        if (o.lamp) {
            const on = ((t + o.phase) % o.period) < o.on;
            o.lamp.material.opacity = nf > 0.05 && on ? Math.min(1, nf * 1.5) : 0;
            o.lamp.visible = o.lamp.material.opacity > 0;
        }
    }
}
window.updateHarborDetail = updateHarborDetail;
