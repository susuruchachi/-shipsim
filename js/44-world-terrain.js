// 44-world-terrain.js — 船のまわりの陸地・港の施設・座礁（「世界を航海」モード）
//
//  ・陸地：船を中心に 2つの格子（細かい：半径7km・約44m間隔／粗い：半径30km・約235m間隔）
//    の高さを、43-world.js の高さの関数で作る。高さの計算は重いので、別スレッド
//    （Web Worker）で行い、画面が固まらないようにする。船が格子の中心から離れたら
//    作り直す。近くに陸が無い（外洋）ときは何も作らない。
//    水面より下は描かない（海の底は見えない。水面の網は船のまわりだけなので）。
//  ・港：近く（12km 以内）の港に、種類に応じた施設を建てる
//      漁港   ：小さな岸壁・桟橋・防波堤・灯台・小屋・漁船
//      港町   ：岸壁・防波堤・灯台・町並み
//      港湾都市：長い岸壁・防波堤・灯台・高いビルを含む街・フェリーターミナル
//      貨物港 ：長い岸壁・ガントリークレーン・コンテナの山・倉庫
//      軍港   ：桟橋・グレーの軍艦・クレーン・格納庫
//    港の前の海は、船が入れる深さまで掘り下げる（高さの関数に「港の手直し」を足す）。
//    岸壁には係船柱（ボラード）が並ぶ（タグボート・係留で使う予定）。
//  ・座礁：船首・中央・船尾の下の水深が喫水より浅いと座礁。前に進めなくなる。
//    岸壁・桟橋・防波堤にも当たる。

const TR_NEAR = { half: 7000, n: 321 };       // 細かい格子（半径[m]・1辺の点の数）
const TR_FAR = { half: 30000, n: 257 };       // 粗い格子
const TR_RECENTER = 1800;                      // 中心からこれだけ離れたら作り直す[m]
const PORT_BUILD_DIST = 12000;                 // これより近い港に施設を建てる[m]

const terrain = {
    near: null, far: null,       // THREE.Mesh
    center: null,                // 格子の中心（物理の面の座標）
    pending: false,
    ports: new Map(),            // 港の id → { group, colliders }
    worker: null,
    reqId: 0,
    grounded: false,
    depth: null,                 // 船の下の水深[m]
    lastCheck: 0,
};
window.terrain = terrain;

// ── 港の手直し（港の前を掘り下げ、岸壁の後ろを平らにする）──
//  船の近くの港の「形」を、物理の面の座標で持っておく（ワーカーにも渡す）
function _portShape(p) {
    const T = PORT_TYPES[p.type];
    const quayLen = T.quay;
    const apron = { fishing: 45, town: 70, city: 130, cargo: 190, naval: 110 }[p.type];
    const basin = T.basin;
    const loc = worldUnitToLocal(p.u);
    const br = p.seaBearing * Math.PI / 180;
    // s：海の方、l：岸沿い（s を右に90°）
    // 海の方の向き（物理の面では東が −x）
    return { id: p.id, type: p.type, x: loc.x, z: loc.z, sx: -Math.sin(br), sz: Math.cos(br),
             quayLen, apron, basin, depth: T.depth, seed: p.seed, name: p.name, chLen: worldPortChannelLen(p) };
}
// 高さに港の手直しを加える（ワーカーと同じ式。関数の中身を文字列にしてワーカーへ渡す）
function _portAdjust(h, x, z, shapes) {
    for (let i = 0; i < shapes.length; i++) {
        const S = shapes[i];
        const dx = x - S.x, dz = z - S.z;
        const a = dx * S.sx + dz * S.sz;            // 海の方への距離（岸＝0）
        const b = dx * S.sz - dz * S.sx;            // 岸沿いの距離
        const half = S.quayLen / 2;
        // 岸壁の後ろ（エプロン）：平らに 3m
        if (a <= 0 && a > -S.apron && Math.abs(b) < half + 30) {
            const k = Math.min(1, Math.max(0, (half + 30 - Math.abs(b)) / 30)) * Math.min(1, Math.max(0, (a + S.apron) / 25 + 0.001));
            h = h + (3 - h) * Math.min(1, k * 4);
            continue;
        }
        // 港の前の海：船が入れる深さまで掘る（岸から basin まで、岸沿いは岸壁の長さ＋α）
        if (a > 0 && a < S.basin && Math.abs(b) < half + S.basin * 0.5) {
            const edge = Math.min(1, (half + S.basin * 0.5 - Math.abs(b)) / 80) * Math.min(1, (S.basin - a) / 120);
            const want = -S.depth - 2;
            if (h > want) h = h + (want - h) * Math.min(1, edge);
            // 岸壁のすぐ前（10m 以内）は垂直な岸壁の外なので、さらに確実に掘る
            if (a < 12 && Math.abs(b) < half) h = Math.min(h, want);
        }
        // 泊地から沖へ続く航路。浅瀬や岩があっても、ここだけは必ず通れる
        // （沖へ行くほど少し広がる。航路を外れると浅瀬があることもある）
        // 長さは港ごと（43-world.js の worldPortChannelLen）。本当の陸（高さ6m以上）は削らない
        const ch = Math.max(90, half * 0.5) + Math.max(0, a - S.basin) * 0.06;
        const chEnd = S.basin + (S.chLen || 4000);
        if (a >= S.basin - 120 && a < chEnd && Math.abs(b) < ch + 60 && h < 6) {
            const want = -S.depth - 2;
            const k = Math.min(1, (ch + 60 - Math.abs(b)) / 60) * Math.min(1, (chEnd - a) / 400);
            if (h > want) h = h + (want - h) * k;
        }
    }
    return h;
}

// ── ワーカー（高さの計算）──
function _trWorker() {
    if (terrain.worker) return terrain.worker;
    const src = `
        const _wPerm = new Uint8Array(${JSON.stringify(Array.from(_wPerm))});
        const _wPermMod12 = new Uint8Array(${JSON.stringify(Array.from(_wPermMod12))});
        const _wGrad3 = new Float32Array(${JSON.stringify(Array.from(_wGrad3))});
        const world = { seaLevel: ${world.seaLevel} };
        const WORLD_R = ${WORLD_R};
        ${_wNoise3.toString()}
        ${worldNoiseE.toString()}
        ${worldHeightFromE.toString()}
        ${worldShoal.toString()}
        ${worldHeightAt.toString()}
        ${_portAdjust.toString()}
        onmessage = (ev) => {
            const q = ev.data;
            const { C, E, N } = q.frame;
            const n = q.n, half = q.half, step = half * 2 / (n - 1);
            const H = new Float32Array(n * n);
            for (let j = 0; j < n; j++) {
                const z = q.cz - half + j * step;
                for (let i = 0; i < n; i++) {
                    const x = q.cx - half + i * step;
                    const a = -x / WORLD_R, b = z / WORLD_R;       // +x は西
                    let ux = C.x + a * E.x + b * N.x, uy = C.y + a * E.y + b * N.y, uz = C.z + a * E.z + b * N.z;
                    const l = Math.hypot(ux, uy, uz);
                    let h = worldHeightAt(ux / l, uy / l, uz / l, q.oct);
                    if (q.shapes.length) h = _portAdjust(h, x, z, q.shapes);
                    H[j * n + i] = h;
                }
            }
            postMessage({ id: q.id, which: q.which, H }, [H.buffer]);
        };`;
    terrain.worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    terrain.worker.onmessage = (ev) => _trOnHeights(ev.data);
    return terrain.worker;
}

// ── 地面の材質：水面より下は描かない ──
let _trMat = null;
function _trMaterial() {
    if (_trMat) return _trMat;
    _trMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
    _trMat.onBeforeCompile = (sh) => {
        sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying float vTrY;')
            .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n    vTrY = (modelMatrix * vec4(transformed, 1.0)).y;');
        sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vTrY;')
            .replace('void main() {', 'void main() {\n    if (vTrY < -0.6) discard;');
    };
    _trMat.customProgramCacheKey = () => 'worldTerrain';
    return _trMat;
}
// 高さ・傾き → 色
function _trColor(h, slope, x, z, out, o) {
    let r, g, b;
    if (h < 1.2) { r = 0.78; g = 0.72; b = 0.54; }                       // 砂浜
    else if (slope > 0.75) { r = 0.42; g = 0.40; b = 0.37; }             // 岩肌
    else if (h > 1800) { r = 0.93; g = 0.94; b = 0.96; }                 // 雪
    else if (h > 1100) { r = 0.50; g = 0.48; b = 0.42; }                  // 高地
    else {
        const f = (Math.sin(x * 0.0021 + z * 0.0013) * Math.sin(x * 0.0007 - z * 0.0019) + 1) * 0.5;   // 草地と林のまだら
        r = 0.30 - 0.12 * f; g = 0.44 - 0.12 * f; b = 0.22 - 0.07 * f;
    }
    // 見た目の色（sRGB）→ 明るさの計算用（リニア）
    out[o] = r * r; out[o + 1] = g * g; out[o + 2] = b * b;
}

// 高さの格子 → 網
function _trBuildMesh(H, n, half, cx, cz, lowerInside) {
    const geo = new THREE.BufferGeometry();
    const P = new Float32Array(n * n * 3), Cc = new Float32Array(n * n * 3);
    const step = half * 2 / (n - 1);
    for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
            const k = j * n + i;
            const x = cx - half + i * step, z = cz - half + j * step;
            let h = H[k];
            // 粗い格子の、細かい格子と重なる所は沈めて隠す
            if (lowerInside && Math.abs(x - lowerInside.cx) < lowerInside.half - step && Math.abs(z - lowerInside.cz) < lowerInside.half - step) h = Math.min(h, -30);
            // 惑星の丸み：中心から離れるほど下がる
            const d2 = (x - cx) * (x - cx) + (z - cz) * (z - cz);
            P[k * 3] = x; P[k * 3 + 1] = h - d2 / (2 * WORLD_R); P[k * 3 + 2] = z;
            const hx = H[j * n + Math.min(n - 1, i + 1)] - H[j * n + Math.max(0, i - 1)];
            const hz = H[Math.min(n - 1, j + 1) * n + i] - H[Math.max(0, j - 1) * n + i];
            _trColor(h, Math.hypot(hx, hz) / (2 * step), x, z, Cc, k * 3);
        }
    }
    // 陸を含むマスだけ三角形にする（水面下だけのマスは作らない）
    const idx = [];
    for (let j = 0; j < n - 1; j++) {
        for (let i = 0; i < n - 1; i++) {
            const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
            if (Math.max(P[a * 3 + 1], P[b * 3 + 1], P[c * 3 + 1], P[d * 3 + 1]) < -0.6) continue;
            idx.push(a, c, b, b, c, d);
        }
    }
    if (!idx.length) return null;
    geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(Cc, 3));
    geo.setIndex(n * n > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const m = new THREE.Mesh(geo, _trMaterial());
    m.receiveShadow = true;
    m.castShadow = false;
    m.userData.noLightBake = true;
    return m;
}

function _trDispose(m) {
    if (!m) return;
    if (m.parent) m.parent.remove(m);
    m.geometry.dispose();
}

// 近くの港の形（手直し用）
function _trNearbyShapes(cx, cz, radius) {
    const out = [];
    if (!world.ports) return out;
    for (const p of world.ports) {
        const loc = worldUnitToLocal(p.u);
        if (!Number.isFinite(loc.x)) continue;
        if (Math.hypot(loc.x - cx, loc.z - cz) < radius) out.push(_portShape(p));
    }
    return out;
}

// 作り直しを頼む
function _trRequest(cx, cz) {
    // 近くに陸がありそうか、粗く調べる（外洋では何も作らない）
    let maxH = -Infinity;
    for (let j = 0; j <= 16; j++) for (let i = 0; i <= 16; i++) {
        const x = cx - TR_FAR.half + i * TR_FAR.half / 8, z = cz - TR_FAR.half + j * TR_FAR.half / 8;
        maxH = Math.max(maxH, worldHeightAtLocal(x, z, 12));
    }
    terrain.center = { x: cx, z: cz };
    if (maxH < -140 && !_trNearbyShapes(cx, cz, TR_FAR.half).length) {   // 大陸棚（浅瀬があり得る所）も無い外洋
        _trDispose(terrain.near); _trDispose(terrain.far);
        terrain.near = terrain.far = null;
        return;
    }
    const F = worldFrame();
    const frame = { C: F.C, E: F.E, N: F.N };
    const shapes = _trNearbyShapes(cx, cz, TR_NEAR.half + 2000);
    const id = ++terrain.reqId;
    terrain.pending = true;
    const w = _trWorker();
    w.postMessage({ id, which: 'near', frame, n: TR_NEAR.n, half: TR_NEAR.half, cx, cz, oct: WORLD_OCT_FULL, shapes });
    w.postMessage({ id, which: 'far', frame, n: TR_FAR.n, half: TR_FAR.half, cx, cz, oct: 15, shapes: [] });
}
function _trOnHeights(msg) {
    if (msg.id !== terrain.reqId || world.mode !== 'world' || !terrain.center) return;
    const { x: cx, z: cz } = terrain.center;
    if (msg.which === 'near') {
        terrain.nearH = { H: msg.H, n: TR_NEAR.n, half: TR_NEAR.half, cx, cz };
        _brkBuild(terrain.nearH);
        _trDispose(terrain.near);
        terrain.near = _trBuildMesh(msg.H, TR_NEAR.n, TR_NEAR.half, cx, cz, null);
        if (terrain.near) scene.add(terrain.near);
    } else {
        _trDispose(terrain.far);
        terrain.far = _trBuildMesh(msg.H, TR_FAR.n, TR_FAR.half, cx, cz, { cx, cz, half: TR_NEAR.half });
        if (terrain.far) scene.add(terrain.far);
        terrain.pending = false;
    }
}

// ════════════════════════════════════════════════════════════════
//  港の施設
// ════════════════════════════════════════════════════════════════
const _pMats = {};
function _pMat(key, color, opts) {
    if (!_pMats[key]) {
        // 色は見た目の色（sRGB）で書いてあるので、明るさの計算用（リニア）に直す
        const m = new THREE.MeshStandardMaterial(Object.assign({ roughness: 0.85, metalness: 0.05 }, opts || {}));
        m.color.setHex(color).convertSRGBToLinear();
        if (key !== 'lamp') m.color.multiplyScalar(0.6);      // 海の上の強い光に合わせて少し暗く
        if (opts && opts.emissive !== undefined) m.emissive.setHex(opts.emissive).convertSRGBToLinear();
        _pMats[key] = m;
    }
    return _pMats[key];
}
// 箱をたくさん（同じ材質）まとめて1つの網にする
function _pBoxes(list, mat) {
    if (!list.length) return null;
    const box = new THREE.BoxGeometry(1, 1, 1);
    const im = new THREE.InstancedMesh(box, mat, list.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), yAxis = new THREE.Vector3(0, 1, 0);
    list.forEach((b, i) => {
        q.setFromAxisAngle(yAxis, b.rot || 0);
        // w：海の方（港の a 軸＝回した箱の z）、d：岸沿い（b 軸＝箱の x）
        m4.compose(p.set(b.x, b.y, b.z), q, s.set(b.d, b.h, b.w));
        im.setMatrixAt(i, m4);
        if (b.color !== undefined) im.setColorAt(i, new THREE.Color(b.color).convertSRGBToLinear());
    });
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.castShadow = true; im.receiveShadow = true;
    im.userData.noLightBake = true;
    return im;
}
function _buildPort(S) {
    const r = _wRng(S.seed);
    const g = new THREE.Group();
    g.name = 'Port:' + S.name;
    // 港の座標系：原点＝岸壁の中央、+a＝海の方、+b＝岸沿い
    const rot = Math.atan2(S.sx, S.sz);                 // +z（北）を海の方へ回す角
    const P = (a, b) => ({ x: S.x + S.sx * a + S.sz * b, z: S.z + S.sz * a - S.sx * b });
    const colliders = [];     // 当たり判定の四角（a0,a1,b0,b1：港の座標系）
    const concrete = [], dark = [], wood = [], buildings = [], roofs = [], containers = [], greyShips = [], cranes = [], boats = [];
    const addBox = (list, a, b, y, w, h, d, extra) => { const q = P(a, b); list.push(Object.assign({ x: q.x, y, z: q.z, w, h, d, rot }, extra || {})); };
    const half = S.quayLen / 2;

    // 岸壁（海側の垂直な壁＋上の面）
    addBox(concrete, -S.apron / 2 + 4, 0, -3, S.apron + 8, 12, S.quayLen);
    colliders.push([-S.apron - 20, 6, -half, half]);
    // 係船柱（ボラード）：岸壁の縁に 25m おき
    const bollards = [];
    for (let b = -half + 12; b <= half - 12; b += 25) {
        const q = P(4.5, b);
        bollards.push({ x: q.x, y: 3.35, z: q.z, w: 0.7, h: 0.7, d: 0.7, rot });
    }
    // 防波堤（港の前を囲む。真ん中に出入り口）
    if (S.type !== 'cargo') {
        const R = S.basin * 0.95, gap = S.type === 'fishing' ? 70 : 140;
        for (const side of [-1, 1]) {
            // 岸から沖へ伸び、先を港の出入り口の方へ曲げる
            const b0 = side * (half + 40), len = R * 0.8;
            addBox(dark, len / 2, b0, -2, len, 8, 16);
            colliders.push([0, len, b0 - 8, b0 + 8]);
            const armLen = Math.max(20, Math.abs(b0) - gap / 2);
            addBox(dark, len, side * (Math.abs(b0) - armLen / 2), -2, 16, 8, armLen);
            colliders.push([len - 8, len + 8, Math.min(side * Math.abs(b0), side * (Math.abs(b0) - armLen)), Math.max(side * Math.abs(b0), side * (Math.abs(b0) - armLen))]);
            // 灯台（出入り口の脇。片側だけ）
            if (side === 1) {
                const q = P(len, gap / 2 + 8);
                const lh = new THREE.Group();
                const tower = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 3, 18, 12), _pMat('lh', 0xf2f2f2));
                tower.position.y = 11; tower.castShadow = true;
                const band = new THREE.Mesh(new THREE.CylinderGeometry(2.25, 2.4, 3, 12), _pMat('lhRed', 0xc0302a));
                band.position.y = 8;
                const lamp = new THREE.Mesh(new THREE.SphereGeometry(1.4, 12, 8), _pMat('lamp', 0xffe8a0, { emissive: 0xffd070, emissiveIntensity: 2.5 }));
                lamp.position.y = 21;
                lh.add(tower, band, lamp);
                lh.position.set(q.x, 0, q.z);
                lh.userData.isLighthouse = true;
                g.add(lh);
            }
        }
    }
    // 桟橋（漁港・軍港）
    const pierN = S.type === 'fishing' ? 2 : S.type === 'naval' ? 3 : 0;
    const pierLen = S.type === 'naval' ? 260 : 60;
    for (let i = 0; i < pierN; i++) {
        const b = -half + (i + 1) * S.quayLen / (pierN + 1);
        const w = S.type === 'naval' ? 22 : 6;
        addBox(S.type === 'naval' ? concrete : wood, pierLen / 2, b, S.type === 'naval' ? -3 : 1.6, pierLen, S.type === 'naval' ? 12 : 1, w);
        colliders.push([0, pierLen, b - w / 2, b + w / 2]);
        for (let a = 15; a < pierLen - 5; a += 25) { const q = P(a, b + w / 2 - 0.6); bollards.push({ x: q.x, y: S.type === 'naval' ? 3.35 : 2.4, z: q.z, w: 0.6, h: 0.6, d: 0.6, rot }); }
        if (S.type === 'naval') {
            // 桟橋の両側に軍艦
            for (const side of [-1, 1]) {
                const len = 120 + r() * 70, beam = 14 + r() * 5;
                const bb = b + side * (w / 2 + beam / 2 + 3);
                addBox(greyShips, pierLen * 0.5, bb, 2, len, 9, beam);
                addBox(greyShips, pierLen * 0.5 - len * 0.05, bb, 9, len * 0.28, 7, beam * 0.6);
                addBox(greyShips, pierLen * 0.5 - len * 0.05, bb, 15, len * 0.08, 8, beam * 0.3);
                colliders.push([pierLen * 0.5 - len / 2, pierLen * 0.5 + len / 2, bb - beam / 2, bb + beam / 2]);
            }
        } else {
            // 漁船
            for (const side of [-1, 1]) {
                const len = 14 + r() * 8;
                addBox(boats, pierLen * 0.55, b + side * 6.5, 0.8, len, 2.4, 4.5, { color: [0xd8d8d0, 0x2e5d8a, 0xb3352a, 0xe2c14b][Math.floor(r() * 4)] });
            }
        }
    }
    // 陸の建物
    const nB = { fishing: 14, town: 40, city: 90, cargo: 18, naval: 16 }[S.type];
    for (let i = 0; i < nB; i++) {
        const a = -S.apron - 15 - r() * (S.type === 'city' ? 420 : 200);
        const b = (r() * 2 - 1) * (half + (S.type === 'city' ? 200 : 60));
        const gh0 = worldHeightAtLocal(P(a, b).x, P(a, b).z, 16);
        if (gh0 < 1.2 || gh0 > 120) continue;          // 水の上・山の上には建てない
        const gh = gh0;
        let w = 10 + r() * 16, d = 10 + r() * 16, h = 5 + r() * 9;
        if (S.type === 'city' && r() < 0.35) { h = 25 + r() * 70; w = 18 + r() * 14; d = w; }
        if (S.type === 'cargo' || S.type === 'naval') { w = 40 + r() * 40; d = 25 + r() * 20; h = 10 + r() * 6; }
        const tall = h > 20;
        const tint = tall ? [0x9aa6b0, 0x7d8a96, 0xb8b2a6, 0x6f7b86, 0xa39583][Math.floor(r() * 5)]
            : [0xd9cfbd, 0xbfa582, 0x9fae98, 0xb5b0a8, 0xc9b79a, 0x8f8a82][Math.floor(r() * 6)];
        addBox(buildings, a, b, gh + h / 2 - 1, d, h + 2, w, { color: tint });
        // 低い建物には色のついた屋根（倉庫・工場は平らな灰色）
        if (!tall) {
            const warehouse = S.type === 'cargo' || S.type === 'naval';
            const rc = warehouse ? [0x6d7278, 0x8a8f94, 0x5d6f7d][Math.floor(r() * 3)] : [0x8e3b2e, 0x5a4a44, 0x3f5569, 0x7a5236, 0x4d5d4a][Math.floor(r() * 5)];
            addBox(roofs, a, b, gh + h + 1 + 0.6, d + 0.8, 1.2, w + 0.8, { color: rc });
        }
    }
    // 貨物港：コンテナの山とガントリークレーン
    if (S.type === 'cargo') {
        const cols = [0xb3352a, 0x2e5d8a, 0x2f7d4a, 0xd98e2b, 0x777777, 0x5b3f8c];
        for (let row = 0; row < 8; row++) for (let k = 0; k < 16; k++) {
            if (r() < 0.2) continue;
            const a = -35 - row * 17, b = -half + 60 + k * ((S.quayLen - 120) / 16);
            const stack = 1 + Math.floor(r() * 4);
            for (let s = 0; s < stack; s++) addBox(containers, a, b, 3 + 1.3 + s * 2.6, 12.2, 2.6, 2.45 * 2, { color: cols[Math.floor(r() * cols.length)] });
        }
        for (let i = 0; i < 6; i++) {
            const b = -half + 90 + i * (S.quayLen - 180) / 5;
            // 脚4本・梁・海へ張り出すブーム
            for (const la of [-6, 18]) for (const lb of [-9, 9]) addBox(cranes, la, b + lb, 3 + 22, 1.6, 44, 1.6);
            addBox(cranes, 6, b, 3 + 45, 30, 3, 20);
            addBox(cranes, 30, b, 3 + 50, 60, 2.2, 3);
        }
    }
    if (S.type === 'naval') {
        for (let i = 0; i < 2; i++) {
            const b = -half + 60 + i * 60;
            addBox(cranes, -10, b, 3 + 14, 3, 28, 3);
            addBox(cranes, 2, b, 3 + 28, 30, 2, 2);
        }
    }
    [[concrete, _pMat('concrete', 0x9a9890)], [dark, _pMat('breakwater', 0x6d6b66)], [wood, _pMat('wood', 0x7a5a3a)],
     [buildings, _pMat('bld', 0xffffff)], [containers, _pMat('cont', 0xffffff, { roughness: 0.6 })], [greyShips, _pMat('navy', 0x70777d, { roughness: 0.6 })],
     [cranes, _pMat('crane', 0xd9a12c, { metalness: 0.3 })], [boats, _pMat('boat', 0xffffff)], [roofs, _pMat('roof', 0xffffff)], [bollards, _pMat('bollard', 0x2a2a2a, { metalness: 0.4 })]]
        .forEach(([list, mat]) => { const m = _pBoxes(list, mat); if (m) g.add(m); });
    g.userData.bollards = bollards.map(b => ({ x: b.x, y: b.y, z: b.z }));
    scene.add(g);
    return { group: g, colliders, shape: S };
}

function _trUpdatePorts() {
    if (!world.ports) return;
    const cx = physics.cgWorldX || 0, cz = physics.cgWorldZ || 0;
    const want = new Set();
    for (const p of world.ports) {
        const loc = worldUnitToLocal(p.u);
        if (!Number.isFinite(loc.x)) continue;
        if (Math.hypot(loc.x - cx, loc.z - cz) < PORT_BUILD_DIST) want.add(p.id);
    }
    for (const [id, P] of terrain.ports) {
        if (!want.has(id)) {
            scene.remove(P.group);
            P.group.traverse(o => { if (o.geometry) o.geometry.dispose(); });
            terrain.ports.delete(id);
        }
    }
    for (const id of want) {
        if (terrain.ports.has(id)) continue;
        const p = world.ports.find(q => q.id === id);
        terrain.ports.set(id, _buildPort(_portShape(p)));
    }
}

function _trClearAll() {
    _trDispose(terrain.near); _trDispose(terrain.far);
    terrain.near = terrain.far = null;
    terrain.center = null;
    terrain.reqId++;
    for (const [, P] of terrain.ports) { scene.remove(P.group); P.group.traverse(o => { if (o.geometry) o.geometry.dispose(); }); }
    terrain.ports.clear();
    terrain.grounded = false;
    terrain.depth = null;
    terrain.nearH = null;
    _brkBuild(null);
}

// モードが変わった・港へ移動した（43-world.js から）
function worldTerrainModeChanged(moved) {
    _trClearAll();
    if (world.mode === 'world') { worldBuildPorts(); terrain._dirty = true; }
}
window.worldTerrainModeChanged = worldTerrainModeChanged;

// ════════════════════════════════════════════════════════════════
//  浅瀬・岩礁の白波（水面の下の浅瀬は見えないので、波が砕ける白い泡で分かるように）
// ════════════════════════════════════════════════════════════════
const BRK_MAX = 2500;
const _brk = { pts: null, xz: null, base: null, phase: null, n: 0, lastT: -1 };
function _brkMaterial() {
    return new THREE.ShaderMaterial({
        uniforms: { uSize: { value: 26 }, uScale: { value: 400 } },
        vertexShader: `
            attribute float aAlpha;
            varying float vA;
            uniform float uSize, uScale;
            void main() {
                vec4 mv = modelViewMatrix * vec4(position, 1.0);
                vA = aAlpha;
                gl_PointSize = aAlpha <= 0.001 ? 0.0 : min(160.0, uSize * uScale / max(1.0, -mv.z));
                gl_Position = projectionMatrix * mv;
            }`,
        fragmentShader: `
            varying float vA;
            void main() {
                vec2 p = gl_PointCoord * 2.0 - 1.0;
                float r = dot(p, p);
                if (r > 1.0) discard;
                gl_FragColor = vec4(vec3(0.93, 0.96, 0.98), vA * (1.0 - r) * (1.0 - r));
            }`,
        transparent: true, depthWrite: false,
    });
}
// 近くの格子の高さから、白波の立つ所（深さ3.5mより浅い海）を拾う
function _brkBuild(G) {
    if (_brk.pts) { scene.remove(_brk.pts); _brk.pts.geometry.dispose(); _brk.pts = null; }
    _brk.n = 0;
    if (!G) return;
    const { H, n, half, cx, cz } = G, step = half * 2 / (n - 1);
    const list = [];
    for (let j = 1; j < n - 1; j++) for (let i = 1; i < n - 1; i++) {
        const h = H[j * n + i];
        if (h > -3.5 && h < 0.3) list.push(i, j, h);
    }
    let cnt = list.length / 3;
    if (!cnt) return;
    const stride = Math.max(1, cnt / BRK_MAX);
    const N = Math.min(BRK_MAX, cnt);
    const pos = new Float32Array(N * 3), alpha = new Float32Array(N);
    _brk.xz = new Float32Array(N * 2); _brk.base = new Float32Array(N); _brk.phase = new Float32Array(N);
    const r = _wRng(Math.round(cx * 7 + cz * 13) | 0);
    for (let k = 0; k < N; k++) {
        const q = Math.floor(k * stride) * 3;
        const x = cx - half + (list[q] + r() - 0.5) * step, z = cz - half + (list[q + 1] + r() - 0.5) * step;
        _brk.xz[k * 2] = x; _brk.xz[k * 2 + 1] = z;
        _brk.base[k] = 0.35 + 0.5 * Math.min(1, (list[q + 2] + 3.5) / 3);   // 浅いほど白い
        _brk.phase[k] = r() * Math.PI * 2;
        pos[k * 3] = x; pos[k * 3 + 2] = z;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, 0, cz), half * 1.5);
    _brk.pts = new THREE.Points(geo, _brkMaterial());
    _brk.pts.frustumCulled = false;
    _brk.pts.renderOrder = 2;
    _brk.n = N;
    scene.add(_brk.pts);
}
function _brkUpdate(t) {
    if (!_brk.pts || t - _brk.lastT < 0.1) return;
    _brk.lastT = t;
    const geo = _brk.pts.geometry, P = geo.attributes.position.array, A = geo.attributes.aAlpha.array;
    const hs = Math.max(0, window._seaHs || 0);
    const sea = Math.min(1.3, 0.35 + hs / 2.5);
    const cam = camera.position;
    const hasH = typeof getOceanHeight === 'function';
    _brk.pts.material.uniforms.uScale.value = (renderer.domElement.height || 800) / (2 * Math.tan(camera.fov * Math.PI / 360));
    for (let k = 0; k < _brk.n; k++) {
        const x = _brk.xz[k * 2], z = _brk.xz[k * 2 + 1];
        const d = Math.hypot(x - cam.x, z - cam.z);
        if (d > 5000) { A[k] = 0; continue; }
        P[k * 3 + 1] = (hasH ? getOceanHeight(x, z, t) : 0) + 0.25;
        const pulse = 0.5 + 0.5 * Math.sin(t * 1.1 + _brk.phase[k]);
        A[k] = _brk.base[k] * sea * (0.25 + 0.75 * pulse * pulse) * Math.min(1, (5000 - d) / 1500);
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.aAlpha.needsUpdate = true;
}

// ════════════════════════════════════════════════════════════════
//  座礁
// ════════════════════════════════════════════════════════════════
// 物理の面の点の「底の高さ」：地形（港の手直し込み）と、岸壁・桟橋などの施設
function worldSeabedAt(x, z) {
    let h = worldHeightAtLocal(x, z, 16);
    const shapes = [];
    for (const [, P] of terrain.ports) shapes.push(P.shape);
    if (shapes.length) h = _portAdjust(h, x, z, shapes);
    for (const [, P] of terrain.ports) {
        const S = P.shape;
        const dx = x - S.x, dz = z - S.z;
        const a = dx * S.sx + dz * S.sz, b = dx * S.sz - dz * S.sx;
        for (const c of P.colliders) if (a >= c[0] && a <= c[1] && b >= c[2] && b <= c[3]) return 5;
    }
    return h;
}
window.worldSeabedAt = worldSeabedAt;

function _trCheckGrounding(t, dt) {
    const hp = window.hullProfile;
    const WS = physics.scale || 1;
    const halfLen = ((hp && hp.ready) ? hp.halfLen : 6) * WS;
    const draft = (hp && hp.ready && hp.designWaterlineY > hp.keelY) ? (hp.designWaterlineY - hp.keelY) * (shipGroup ? Math.abs(shipGroup.scale.y) : 1) : 0.4 * halfLen / 6;
    if (t - terrain.lastCheck > 0.2) {
        terrain.lastCheck = t;
        const hr = (physics.heading || 0) * Math.PI / 180, fx = Math.sin(hr), fz = Math.cos(hr);
        const x = physics.cgWorldX || 0, z = physics.cgWorldZ || 0;
        const bow = worldSeabedAt(x + fx * halfLen * 0.9, z + fz * halfLen * 0.9);
        const mid = worldSeabedAt(x, z);
        const stern = worldSeabedAt(x - fx * halfLen * 0.9, z - fz * halfLen * 0.9);
        terrain.depth = -mid;
        terrain._bowShallow = bow > -draft;
        terrain._sternShallow = stern > -draft;
        terrain._bowWarn = bow > -draft - 3;          // 船首・船尾の下があと3mで底
        terrain._sternWarn = stern > -draft - 3;
        const wasGrounded = terrain.grounded;
        terrain.grounded = terrain._bowShallow || terrain._sternShallow || mid > -draft;
        if (terrain.grounded && !wasGrounded && Math.abs(physics.speed || 0) > 0.6 && typeof audioWaveImpact === 'function') {
            audioWaveImpact(shipGroup.position.clone(), Math.min(2, 0.5 + Math.abs(physics.speed) / 6), true);
        }
    }
    if (terrain.grounded) {
        // 浅い方へは進めない。ゆっくり止まる
        const v = physics.speed || 0;
        if ((v > 0 && (terrain._bowShallow || !terrain._sternShallow)) || (v < 0 && (terrain._sternShallow || !terrain._bowShallow))) {
            physics.speed = v * Math.exp(-dt * 2.5);
            if (Math.abs(physics.speed) < 0.05) physics.speed = 0;
        }
    }
}

// ════════════════════════════════════════════════════════════════
//  毎フレーム（17-main-loop.js から）
// ════════════════════════════════════════════════════════════════
function updateWorldTerrain(t, dt) {
    if (typeof updateHornEcho === 'function') updateHornEcho(t);   // 汽笛のこだま（45-horn-echo.js）
    if (world.mode !== 'world') {
        if (terrain.near || terrain.far || terrain.ports.size) _trClearAll();
        return;
    }
    if (!world.ports) worldBuildPorts();
    // 前回の続き：向きを戻す
    if (world._resumeHeading !== undefined && t > 0.5) { physics.heading = world._resumeHeading; world._resumeHeading = undefined; }
    // 船の位置をときどき覚えておく
    if (!(t - (terrain.lastSave || 0) < 5)) { terrain.lastSave = t; _worldSave(); }
    const cx = physics.cgWorldX || 0, cz = physics.cgWorldZ || 0;
    if (terrain._dirty || !terrain.center || Math.hypot(cx - terrain.center.x, cz - terrain.center.z) > TR_RECENTER) {
        terrain._dirty = false;
        _trUpdatePorts();
        _trRequest(Math.round(cx / 50) * 50, Math.round(cz / 50) * 50);
    }
    // 灯台の灯り：夜だけ光る
    const nf = (typeof lightingNightFactor !== 'undefined') ? lightingNightFactor : 0;
    if (_pMats.lamp) _pMats.lamp.emissiveIntensity = 0.3 + 3 * nf;     // 灯台はどれも同じ材質
    _brkUpdate(t);
    _trCheckGrounding(t, dt);
}
window.updateWorldTerrain = updateWorldTerrain;
