// ════════════════════════════════════════════════════════════════
//  船の「空の見え方」（環境光の遮られ方：アンビエント・オクルージョン）の焼き込み
// ════════════════════════════════════════════════════════════════
//  空や海からの柔らかい光（半球光・環境光・窓明かりの光のプローブ）は、three.js では向きだけで決まり、
//  上に甲板がかぶさっている所（プロムナードの内側の壁・ボート甲板の下・煙突の根元のすき間など）も、
//  吹きさらしの舷側と同じ明るさで照らしていた。そのため、プロムナードの内側と舷側の明るさの差が小さかった。
//  そこで、船の形の升目（60-ship-solid.js）を使って、船の表面のすぐ外の升目ごとに、いろいろな向きへ
//  まっすぐ見通して空・海が見える割合を、6 つの向き（上下・左右・前後の半球）ごとに求めておき、
//  頂点ごとにその面の向きで混ぜた値（0〜1）を頂点に持たせる。船のマテリアルでは、柔らかい光（間接光）
//  にその値を掛ける。太陽の直接の光は今まで通り影の地図で、焼き込んだ照明（40-light-bake.js）はそのまま。
//  計算は少しずつ（1 フレームに 6ms ほど）。船のモデル・形が変わったら（升目を作り直したら）やり直す。

const shipAO = { grid: null, field: null, job: null, meshesDone: new WeakMap(), strength: 0.85, checkT: 0 };
window.shipAO = shipAO;
// 見通す向き（球の上にほぼ均等に 40 本）
const _AO_DIRS = (() => {
    const n = 40, out = [], ga = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < n; i++) { const y = 1 - (i + 0.5) / n * 2, r = Math.sqrt(1 - y * y), a = i * ga; out.push([Math.cos(a) * r, y, Math.sin(a) * r]); }
    return out;
})();
const _AO_AXES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

// 表面のすぐ外（2 升目以内）の空気の升目ごとに、6 つの半球の見える割合（0〜255）
function* _aoField(G) {
    const { data, nx, ny, nz } = G, N = nx * ny * nz;
    // 船の升目を 2 升目ずつ太らせ（x・y・z の順に）、太らせた所のうち空気の升目が「表面のすぐ外」
    const A = new Uint8Array(data), B = new Uint8Array(N);
    const dil = (src, dst, step, len, pos) => {
        for (let idx = 0; idx < N; idx++) {
            const c = pos(idx);
            let v = 0;
            for (let o = -2; o <= 2 && !v; o++) { const q = c + o; if (q >= 0 && q < len && src[idx + o * step]) v = 1; }
            dst[idx] = v;
        }
    };
    dil(A, B, 1, nx, (idx) => idx % nx); yield;
    dil(B, A, nx, ny, (idx) => ((idx / nx) | 0) % ny); yield;
    dil(A, B, nx * ny, nz, (idx) => (idx / (nx * ny)) | 0); yield;
    const near = new Map();             // 升目の番号 → 何番目の値
    for (let idx = 0; idx < N; idx++) if (B[idx] && !data[idx]) near.set(idx, near.size);
    yield;
    const vals = new Uint8Array(near.size * 6);
    const maxSteps = Math.min(90, Math.ceil(25 / Math.max(1e-6, G.vWorld || G.v)));     // 25m ほど先まで見る
    const W = _AO_AXES.map(ax => _AO_DIRS.map(d => Math.max(0, d[0] * ax[0] + d[1] * ax[1] + d[2] * ax[2])));
    const wsum = W.map(w => w.reduce((a, b) => a + b, 0));
    const sz = nx * ny;
    let done = 0;
    for (const [idx, slot] of near) {
        const i0 = idx % nx, j0 = ((idx / nx) | 0) % ny, k0 = (idx / sz) | 0;
        const vis = new Float32Array(_AO_DIRS.length);
        for (let d = 0; d < _AO_DIRS.length; d++) {
            const D = _AO_DIRS[d];
            let x = i0 + 0.5, y = j0 + 0.5, z = k0 + 0.5, ok = 1;
            for (let s = 0; s < maxSteps; s++) {
                x += D[0] * 0.8; y += D[1] * 0.8; z += D[2] * 0.8;
                const i = x | 0, j = y | 0, k = z | 0;
                if (x < 0 || y < 0 || z < 0 || i >= nx || j >= ny || k >= nz) break;
                if (data[(k * ny + j) * nx + i]) { ok = 0; break; }
            }
            vis[d] = ok;
        }
        for (let a = 0; a < 6; a++) {
            let v = 0; const w = W[a];
            for (let d = 0; d < vis.length; d++) v += w[d] * vis[d];
            vals[slot * 6 + a] = Math.round(255 * v / wsum[a]);
        }
        if (++done % 1500 === 0) yield;
    }
    return { near, vals };
}
// 頂点ごとの値（面の向きで 6 つを混ぜる）
function* _aoMeshes(G, F, list) {
    const inv = new THREE.Matrix4().copy(shipGroup.matrixWorld).invert(), M = new THREE.Matrix4(), NM = new THREE.Matrix3();
    const p = new THREE.Vector3(), n = new THREE.Vector3();
    const look = (x, y, z) => {
        const i = Math.floor((x - G.lo.x) / G.v), j = Math.floor((y - G.lo.y) / G.v), k = Math.floor((z - G.lo.z) / G.v);
        if (i < 0 || j < 0 || k < 0 || i >= G.nx || j >= G.ny || k >= G.nz) return -2;      // 升目の外：よく見える
        const s = F.near.get((k * G.ny + j) * G.nx + i);
        return s === undefined ? -1 : s;
    };
    const geoUsers = new Map();
    for (const m of list) geoUsers.set(m.geometry, (geoUsers.get(m.geometry) || 0) + 1);
    for (const m of list) {
        if (geoUsers.get(m.geometry) > 1) {
            // 同じ形を何か所かで使っている（救命ボートなど）：場所ごとに値が違うので、形を分ける（小さい物だけ）
            if (m.geometry.attributes.position.count > 30000) continue;
            geoUsers.set(m.geometry, geoUsers.get(m.geometry) - 1);
            m.geometry = m.geometry.clone();
        }
        const g = m.geometry, P = g.attributes.position, Nn = g.attributes.normal;
        if (!Nn) continue;
        M.multiplyMatrices(inv, m.matrixWorld); NM.getNormalMatrix(M);
        const out = new Float32Array(P.count);
        for (let i = 0; i < P.count; i++) {
            p.fromBufferAttribute(P, i).applyMatrix4(M);
            n.fromBufferAttribute(Nn, i).applyMatrix3(NM).normalize();
            let s = -1;
            for (const off of [0.9, 1.8, 2.7]) { s = look(p.x + n.x * G.v * off, p.y + n.y * G.v * off, p.z + n.z * G.v * off); if (s !== -1) break; }
            if (s === -1) for (const off of [-0.9, -1.8]) { s = look(p.x + n.x * G.v * off, p.y + n.y * G.v * off, p.z + n.z * G.v * off); if (s !== -1) break; }
            if (s < 0) { out[i] = 1; continue; }
            const wx = n.x * n.x, wy = n.y * n.y, wz = n.z * n.z, b = s * 6;
            const v = wx * F.vals[b + (n.x >= 0 ? 0 : 1)] + wy * F.vals[b + (n.y >= 0 ? 2 : 3)] + wz * F.vals[b + (n.z >= 0 ? 4 : 5)];
            out[i] = v / 255;
            if (i % 40000 === 39999) yield;
        }
        g.setAttribute('aSky', new THREE.BufferAttribute(out, 1));
        shipAO.meshesDone.set(m, g);
        (Array.isArray(m.material) ? m.material : [m.material]).forEach(_aoPatchMaterial);
        yield;
    }
}
const shipAOUniforms = { uAOStrength: { value: 0.85 }, uAODebug: { value: 0 } };    // uAODebug=1：空の見え方を白黒で表示（調整用）
function _aoPatchMaterial(mat) {
    if (!mat || mat.userData.aoPatched) return;
    if (!(mat.isMeshStandardMaterial || mat.isMeshPhongMaterial || mat.isMeshLambertMaterial)) return;
    mat.userData.aoPatched = true;
    const prev = mat.onBeforeCompile, prevKey = mat.customProgramCacheKey;
    mat.onBeforeCompile = function (shader, r) {
        if (typeof prev === 'function') prev.call(this, shader, r);
        shader.uniforms.uAOStrength = shipAOUniforms.uAOStrength; shader.uniforms.uAODebug = shipAOUniforms.uAODebug;
        shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nattribute float aSky;\nvarying float vSkyAO;\n')
            .replace(/\}\s*$/, '    vSkyAO = aSky;\n}\n');
        // 間接光（半球光・環境光・光のプローブ・環境マップ）に掛ける。少し強めに効くよう曲げる
        shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uAOStrength;\nuniform float uAODebug;\nvarying float vSkyAO;\n')
            .replace('#include <aomap_fragment>', '#include <aomap_fragment>\n    { float sk = mix(1.0, pow(clamp(vSkyAO * 1.15, 0.0, 1.0), 1.4), uAOStrength);\n      reflectedLight.indirectDiffuse *= sk; reflectedLight.indirectSpecular *= mix(1.0, sk, 0.7); }\n')
            .replace(/\}\s*$/, '    if (uAODebug > 0.5) gl_FragColor = vec4(vec3(vSkyAO), 1.0);\n}\n');
    };
    mat.customProgramCacheKey = function () { return 'skyAO|' + ((typeof prevKey === 'function') ? prevKey.call(this) : ''); };
    mat.defaultAttributeValues = Object.assign({}, mat.defaultAttributeValues || {}, { aSky: 1 });
    mat.needsUpdate = true;
}
function updateShipAO() {
    const G = window.shipSolid && shipSolid.G;
    if (!G || typeof shipGroup === 'undefined' || !shipGroup) return;
    if (shipAO.job) {
        const t0 = performance.now();
        while (performance.now() - t0 < 6) {
            const r = shipAO.job.next();
            if (r.done) { shipAO.job = null; break; }
        }
        return;
    }
    if (shipAO.grid !== G) {
        // 升目が新しくなった：見える割合から計算し直す
        shipAO.grid = G; shipAO.field = null;
        shipAO.job = (function* () {
            G.vWorld = G.v * shipGroup.matrixWorld.getMaxScaleOnAxis();
            shipAO.field = yield* _aoField(G);
            shipAO.meshesDone = new WeakMap();
        })();
        return;
    }
    if (!shipAO.field) return;
    // まだ値を付けていない船の形（焼き込みで三角形を分けたときも、形が新しくなる）
    const now = performance.now();
    if (now - shipAO.checkT < 2000) return;
    shipAO.checkT = now;
    const all = (typeof _ssMeshes === 'function' ? _ssMeshes() : []);
    // 値は付いているが、マテリアルが後から差し替わった（焼き込みなど）：マテリアルだけ直す
    for (const m of all) if (shipAO.meshesDone.get(m) === m.geometry) (Array.isArray(m.material) ? m.material : [m.material]).forEach(_aoPatchMaterial);
    const list = all.filter(m => shipAO.meshesDone.get(m) !== m.geometry);
    if (list.length) shipAO.job = _aoMeshes(G, shipAO.field, list);
}
window.updateShipAO = updateShipAO;
function shipAOSetStrength(v) { shipAO.strength = shipAOUniforms.uAOStrength.value = Math.max(0, Math.min(1, v)); }
window.shipAOSetStrength = shipAOSetStrength;
