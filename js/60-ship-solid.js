// ════════════════════════════════════════════════════════════════
//  船の形の中（ボクセル）：煙・湯気・しぶきの粒が、船体・上部構造・煙突を突き抜けないように
// ════════════════════════════════════════════════════════════════
//  船のモデルを読み込んだら、船の中の座標（shipGroup）で、船を細かい升目（船の大きさの 1/320 ほど）に
//  分け、面が通る升目と、そのすき間の「外から入れない」升目（船体・部屋の中）を「中」とする。
//  ・排煙（12-bloom-and-deck-lighting-fx.js）・タグの煙や汽笛の湯気（52-puffs.js）：中に入った粒は、
//    いちばん近い外へ押し出す（マスト・煙突は左右に分かれて、甲板室の屋根は上を越えて流れる：shipSolidPushOut）
//  ・落ちてくるしぶき：中に入ったら消す
//  面の升目を付けるのは重いので、少しずつ（1 フレームに 6 万面ほど）進める。

const shipSolid = { G: null, key: '', inv: new THREE.Matrix4(), job: null, checkT: 0, center: new THREE.Vector3(), r2: 0 };
window.shipSolid = shipSolid;
const _ssV = new THREE.Vector3();

function _ssMeshes() {
    const out = [];
    if (typeof shipGroup === 'undefined' || !shipGroup) return out;
    shipGroup.traverse(o => {
        if (!o.isMesh || o.isInstancedMesh || !o.geometry || !o.geometry.attributes.position || !o.visible) return;
        if (o.userData.noSolid || o.userData.isProp) return;
        const m = Array.isArray(o.material) ? o.material[0] : o.material;
        if (m && m.transparent && (m.opacity ?? 1) < 0.5) return;
        out.push(o);
    });
    return out;
}
function _ssKey(list) {
    let v = 0; for (const o of list) v += o.geometry.attributes.position.count;
    return list.length + ':' + v + ':' + (physics.scale || 1).toFixed(3);
}
// 升目を作る（ジェネレーター：少しずつ）。root：船の中の座標の元（省くと自分の船。他の船のモデルにも使う：59-traffic.js）
function* _ssBuild(list, root) {
    root = root || shipGroup;
    root.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(root.matrixWorld).invert(), M = new THREE.Matrix4();
    // 船の中の座標での大きさ
    const lo = new THREE.Vector3(Infinity, Infinity, Infinity), hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    const mats = list.map(o => new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
    for (let k = 0; k < list.length; k++) {
        const P = list[k].geometry.attributes.position, step = Math.max(1, Math.floor(P.count / 3000));
        for (let i = 0; i < P.count; i += step) { _ssV.fromBufferAttribute(P, i).applyMatrix4(mats[k]); lo.min(_ssV); hi.max(_ssV); }
    }
    if (!Number.isFinite(lo.x)) return null;
    const ext = Math.max(hi.x - lo.x, hi.y - lo.y, hi.z - lo.z);
    let v = ext / 320;
    lo.addScalar(-2 * v); hi.addScalar(2 * v);
    let nx = Math.ceil((hi.x - lo.x) / v), ny = Math.ceil((hi.y - lo.y) / v), nz = Math.ceil((hi.z - lo.z) / v);
    while (nx * ny * nz > 4e6) { v *= 1.2; nx = Math.ceil((hi.x - lo.x) / v); ny = Math.ceil((hi.y - lo.y) / v); nz = Math.ceil((hi.z - lo.z) / v); }
    const data = new Uint8Array(nx * ny * nz);
    const iv = 1 / v;
    const mark = (x, y, z) => {
        const i = Math.floor((x - lo.x) * iv), j = Math.floor((y - lo.y) * iv), k = Math.floor((z - lo.z) * iv);
        if (i >= 0 && j >= 0 && k >= 0 && i < nx && j < ny && k < nz) data[(k * ny + j) * nx + i] = 1;
    };
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    let done = 0;
    for (let q = 0; q < list.length; q++) {
        const g = list[q].geometry, P = g.attributes.position, I = g.index;
        const nTri = I ? I.count / 3 : P.count / 3;
        M.copy(mats[q]);
        for (let t = 0; t < nTri; t++) {
            const i0 = I ? I.getX(t * 3) : t * 3, i1 = I ? I.getX(t * 3 + 1) : t * 3 + 1, i2 = I ? I.getX(t * 3 + 2) : t * 3 + 2;
            a.fromBufferAttribute(P, i0).applyMatrix4(M); b.fromBufferAttribute(P, i1).applyMatrix4(M); c.fromBufferAttribute(P, i2).applyMatrix4(M);
            const L = Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a));
            const n = Math.min(64, Math.max(1, Math.ceil(L * iv * 1.5)));
            for (let i = 0; i <= n; i++) for (let j = 0; j <= n - i; j++) {
                const u = i / n, w = j / n;
                mark(a.x + (b.x - a.x) * u + (c.x - a.x) * w, a.y + (b.y - a.y) * u + (c.y - a.y) * w, a.z + (b.z - a.z) * u + (c.z - a.z) * w);
            }
            if (++done % 60000 === 0) yield;
        }
    }
    // 外から入れる升目（2）を、縁から広げて塗る。残り（0）は船の中 → 1
    const Q = new Int32Array(nx * ny * nz); let qh = 0, qt = 0;
    const push = (idx) => { if (data[idx] === 0) { data[idx] = 2; Q[qt++] = idx; } };
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        if (i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1) push((k * ny + j) * nx + i);
    }
    const sx = 1, sy = nx, sz = nx * ny;
    while (qh < qt) {
        const idx = Q[qh++];
        const i = idx % nx, j = ((idx / nx) | 0) % ny, k = (idx / sz) | 0;
        if (i > 0) push(idx - sx); if (i < nx - 1) push(idx + sx);
        if (j > 0) push(idx - sy); if (j < ny - 1) push(idx + sy);
        if (k > 0) push(idx - sz); if (k < nz - 1) push(idx + sz);
        if (qh % 400000 === 0) yield;
    }
    for (let idx = 0; idx < data.length; idx++) data[idx] = data[idx] === 2 ? 0 : 1;
    return { data, lo, v, nx, ny, nz, ext };
}
function updateShipSolid(t) {
    if (typeof shipGroup === 'undefined' || !shipGroup || !window.hullProfile || !hullProfile.ready) return;
    shipGroup.updateMatrixWorld();
    shipSolid.inv.copy(shipGroup.matrixWorld).invert();
    if (shipSolid.G) {
        const G = shipSolid.G;
        shipSolid.center.set(G.lo.x + G.nx * G.v / 2, G.lo.y + G.ny * G.v / 2, G.lo.z + G.nz * G.v / 2).applyMatrix4(shipGroup.matrixWorld);
        const s = shipGroup.matrixWorld.getMaxScaleOnAxis(), r = G.ext * 0.75 * s;
        shipSolid.r2 = r * r;
    }
    if (shipSolid.job) {
        const t0 = performance.now();
        while (performance.now() - t0 < 6) {
            const r = shipSolid.job.next();
            if (r.done) { shipSolid.G = r.value; shipSolid.job = null; break; }
        }
        return;
    }
    // モデルが変わったら作り直す（3 秒ごとに調べる）
    const now = performance.now();
    if (now - shipSolid.checkT < 3000) return;
    shipSolid.checkT = now;
    const list = _ssMeshes(), key = _ssKey(list);
    if (key !== shipSolid.key) { shipSolid.key = key; shipSolid.G = null; if (list.length) shipSolid.job = _ssBuild(list); }
}
window.updateShipSolid = updateShipSolid;
// ワールドの点が船の中か（船のまわりの球の外は、すぐ false）
function shipSolidAt(x, y, z) {
    const G = shipSolid.G;
    if (!G) return false;
    const dx = x - shipSolid.center.x, dy = y - shipSolid.center.y, dz = z - shipSolid.center.z;
    if (dx * dx + dy * dy + dz * dz > shipSolid.r2) return false;
    _ssV.set(x, y, z).applyMatrix4(shipSolid.inv);
    const i = Math.floor((_ssV.x - G.lo.x) / G.v), j = Math.floor((_ssV.y - G.lo.y) / G.v), k = Math.floor((_ssV.z - G.lo.z) / G.v);
    if (i < 0 || j < 0 || k < 0 || i >= G.nx || j >= G.ny || k >= G.nz) return false;
    return G.data[(k * G.ny + j) * G.nx + i] === 1;
}
// 船の中なら、船の上向きへ外まで押し出したワールドの点を out に入れて true（押し出せなければ false のまま）
const _ssUp = new THREE.Vector3();
function shipSolidPushUp(x, y, z, out) {
    if (!shipSolidAt(x, y, z)) return false;
    const G = shipSolid.G;
    // 船の中の座標で、真上へ升目をたどる
    const i = Math.floor((_ssV.x - G.lo.x) / G.v), k = Math.floor((_ssV.z - G.lo.z) / G.v);
    let j = Math.floor((_ssV.y - G.lo.y) / G.v);
    while (j < G.ny && G.data[(k * G.ny + j) * G.nx + i] === 1) j++;
    _ssUp.set(_ssV.x, G.lo.y + (j + 0.6) * G.v, _ssV.z).applyMatrix4(shipGroup.matrixWorld);
    out.x = _ssUp.x; out.y = _ssUp.y; out.z = _ssUp.z;
    return true;
}
// 船の中なら、いちばん近い外へ押し出す：左右（船の横の向き）を先に見て、上へ出る方がずっと近いときだけ上へ
//（上へだけ押し出すと、マスト・煙突に当たった煙がそれに沿って打ち上げられて見えた。マストは細いので左右に分かれて流れる。
//  甲板室の屋根をかすめる煙・甲板に降りた煙は、上へ出る方が近いので上へ）
// out：押し出したワールドの点（x, y, z）と、押し出した横の向き（nx, nz：ワールドの水平の単位。上へなら 0）
const _ssSide = new THREE.Vector3();
function shipSolidPushOut(x, y, z, out) {
    if (!shipSolidAt(x, y, z)) return false;
    const G = shipSolid.G, D = G.data, nx = G.nx, ny = G.ny, nz = G.nz;
    const i = Math.floor((_ssV.x - G.lo.x) / G.v), j = Math.floor((_ssV.y - G.lo.y) / G.v), k = Math.floor((_ssV.z - G.lo.z) / G.v);
    const lim = Math.max(nx, nz);
    // 横（船の中の x：左右）・前後（z）・上（y）へ、外に出るまでの升目の数
    const run = (di, dj, dk) => {
        let a = i, b = j, c = k, n = 0;
        while (n < lim) {
            a += di; b += dj; c += dk; n++;
            if (a < 0 || b < 0 || c < 0 || a >= nx || b >= ny || c >= nz) return n;
            if (D[(c * ny + b) * nx + a] !== 1) return n;
        }
        return Infinity;
    };
    const cand = [[run(1, 0, 0), 1, 0, 0], [run(-1, 0, 0), -1, 0, 0], [run(0, 0, 1), 0, 0, 1], [run(0, 0, -1), 0, 0, -1]];
    // 左右がほぼ同じなら、その粒の位置（升目の端からの割合）で分ける（煙が左右に割れて流れる）
    const fx = (_ssV.x - G.lo.x) / G.v - i;
    cand.sort((A, B) => (A[0] - B[0]) || ((A[1] !== 0 && B[1] !== 0) ? (fx < 0.5 ? A[1] - B[1] : B[1] - A[1]) : 0));
    const best = cand[0], up = run(0, 1, 0);
    if (up * 2 < best[0] || !Number.isFinite(best[0])) {
        _ssUp.set(_ssV.x, G.lo.y + (j + up + 0.6) * G.v, _ssV.z).applyMatrix4(shipGroup.matrixWorld);
        out.x = _ssUp.x; out.y = _ssUp.y; out.z = _ssUp.z; out.nx = 0; out.nz = 0;
        return true;
    }
    const n = best[0] + 0.6;
    _ssUp.set(_ssV.x + best[1] * n * G.v, _ssV.y, _ssV.z + best[3] * n * G.v).applyMatrix4(shipGroup.matrixWorld);
    _ssSide.set(best[1], 0, best[3]).transformDirection(shipGroup.matrixWorld); _ssSide.y = 0; _ssSide.normalize();
    out.x = _ssUp.x; out.y = _ssUp.y; out.z = _ssUp.z; out.nx = _ssSide.x; out.nz = _ssSide.z;
    return true;
}
window.shipSolidAt = shipSolidAt; window.shipSolidPushUp = shipSolidPushUp; window.shipSolidPushOut = shipSolidPushOut;
