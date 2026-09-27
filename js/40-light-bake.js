// 40-light-bake.js — 船の照明の焼き込み（ベイク）
//
// ════════════════════════════════════════════════════════════════
//  やりたいこと
// ════════════════════════════════════════════════════════════════
//  夜の船は、窓・灯具（発光パネル）、Blender のエリアライト、GLB のライト、
//  煙突のアップライト、甲板灯に照らされる。これまでは毎フレーム、
//    ・カメラに近い数灯を面光源（RectAreaLight）＋影（SpotLight）で
//    ・その先の数十灯を簡易の計算（影なし）で
//  画素ごとに計算していて、夜はとても重かった（しかも遠くの灯りは壁を抜ける）。
//
//  灯りは船に固定されていて、船と一緒に動くだけなので、「船のどこが、どの
//  灯りに、どれだけ照らされるか」は船が動いても変わらない。そこで、それを
//  船ごとに一度だけ計算して（焼き込んで）端末に保存し、あとは読むだけにする。
//    ・全部の灯りが影付きで照らす（遠くの灯りも壁を抜けない）
//    ・毎フレームの計算は「頂点の値 × 灯りの種類ごとの倍率」を足すだけになる
//    ・昼夜・明るさのスライダー・煙突照明のオンオフは倍率で掛けるので、
//      焼き直さなくてもすぐ反映される
//
// ════════════════════════════════════════════════════════════════
//  やり方
// ════════════════════════════════════════════════════════════════
//  1. 明るさは船の頂点ごとに持たせる。大きな三角形（広い甲板など）は頂点が
//     少なく、灯りの丸い明かりが表現できないので、辺が約1m（細かさの設定）
//     より長い三角形を分ける。辺ごとに分けて隣の三角形も同じ点で分けるので、
//     すき間はできない（色やUVの継ぎ目で頂点が分かれていても、位置が同じ点を
//     同じ点として扱う）
//  2. 灯りごとに、灯りから見た船までの距離（影の地図）を GPU で撮る
//     （256×256 の地図を 2048×2048 の1枚に 64 灯ぶん並べる）
//  3. 全頂点について、GPU で「灯りの明るさ × 向き × 距離 × 影」を足し合わせる。
//     面光源は three.js の RectAreaLight と同じ式（LTC の拡散の部分）を使うので、
//     リアルタイムのときと明るさが揃う。点・スポットも three.js と同じ式
//  4. 結果を頂点の値（RGBM：8bit×4 で明るさの幅を持たせる形）として船に付け、
//     船のマテリアルで「倍率 × 頂点の値 × 色」を光の計算の最後に足す
//  5. 結果は IndexedDB に保存し、同じ船・同じ灯りなら次からは計算しない
//
//  灯りの種類（倍率を別々に掛けるため、別々に焼く）：
//    G：窓・灯具の発光パネル（26-glow-emitters.js）… 窓の発光の強さ × 昼夜
//    L：Blender のエリアライト・GLB のライト … GLBライトの明るさ × 昼夜
//    F：煙突のアップライト … オン/オフ × 昼夜
//    D：甲板灯（配置したスポット）… 甲板照明の明るさ × 昼夜
//  航行灯（色つき）は数が少ないので、今まで通りリアルタイムで照らす。
//
//  灯りの位置・向き・個別の明るさ・色、船の大きさを変えたときは、少し待って
//  から自動で焼き直す（その間は前の結果のまま）。
//  焼き込み中・焼き込み前は、今まで通りのリアルタイムの照明で表示する。

const LB_RGBM_RANGE = 16.0;
const LB_TEX_W = 2048;                    // 頂点の表（テクスチャ）の幅
const LB_CHUNK_ROWS = 128;                // 1回に計算する頂点 = 2048×128
const LB_CHUNK = LB_TEX_W * LB_CHUNK_ROWS;
const LB_ATLAS = 2048;                    // 影の地図をまとめる画像の大きさ
const LB_TILE = 256;                      // 灯り1つぶんの影の地図
const LB_TILES_ROW = LB_ATLAS / LB_TILE;
const LB_TILES = LB_TILES_ROW * LB_TILES_ROW;   // = 64
const LB_MAX_LIGHTS = 64;                 // 1回の計算で扱う灯りの数（シェーダーのループの上限）
const LB_RECT_FOV = 140;                  // 面光源の影を撮る視野角[度]（正面から±70°＝光の約9割）
const LB_LAYER = 8;                       // 影の地図に描く物（船）のレイヤー
const LB_EDGE_M = { fine: 0.6, normal: 1.0, coarse: 1.6 };   // 三角形を分ける辺の長さ[m]
const LB_MAX_NEW_TRIS = 600000;           // 分けて増やす三角形の上限（船全体で）
const LB_SETTLE_S = 1.5;                  // 灯りの変更が落ち着いてから焼き直すまで[秒]
const LB_SIG_INTERVAL = 1.0;              // 変更を調べる間隔[秒]
const LB_CHANNELS = ['G', 'L', 'F', 'D'];
const LB_CH_COMP = { G: 'x', L: 'y', F: 'z', D: 'w' };
// 届く範囲の目安：実行時の明るさ（焼き込み値 × 倍率）がこれを下回る距離で打ち切る
const LB_MIN_E = 0.003;
const LB_TYPICAL_SCALE = { G: 4.0, L: 1.0, F: 1.0, D: 1.0 };
const LB_RECT_MAX_RANGE = 60;             // 面光源の届く範囲の上限[m]
const LB_POINT_MAX_RANGE = 120;           // 距離で減らない点・スポットの範囲の上限[m]
const LB_CACHE_KEEP = 4;                  // 端末に残す焼き込み結果の数（1つ数MB〜十数MB）

const lightBake = {
    enabled: true,          // 焼き込みを使うか（端末の設定）
    detail: 'normal',       // 細かさ
    active: false,          // 焼き込んだ明るさを表示中（リアルタイムの灯りは消している）
    channelSet: '',         // 焼き込んだ灯りの種類（例 'GFD'）
    busy: false,
    progress: 0,
    status: '',
    failed: false,
    modelGroup: null,       // 焼き込んだ時の importedModelGroup（船の差し替えを見分ける）
    meshes: [],
    subdivKey: '',          // 細分割済みのキー（船＋細かさ）
    appliedSig: '',
    pendingSig: '',
    pendingAt: 0,
    lastSigAt: -1,
    job: null,
    waiting: false,
    force: false,
    stats: null,
};
window.lightBake = lightBake;
const lightBakeUniforms = { uBakeScale: { value: new THREE.Vector4() } };

function lightBakeActive() { return lightBake.enabled && lightBake.active; }
window.lightBakeActive = lightBakeActive;
// この灯り（の種類）を焼き込み済みなのでリアルタイムでは消してよいか
function lightBakeHides(kind, light) {
    if (!lightBakeActive() || !lightBake.channelSet.includes(kind)) return false;
    if (light && !(light.userData && light.userData.lbBaked)) return false;
    return true;
}
window.lightBakeHides = lightBakeHides;

(function restoreLightBakeSetting() {
    try {
        const s = JSON.parse(localStorage.getItem('susuru_light_bake') || 'null');
        if (s) {
            if (typeof s.enabled === 'boolean') lightBake.enabled = s.enabled;
            if (LB_EDGE_M[s.detail]) lightBake.detail = s.detail;
        }
    } catch (e) { /* ignore */ }
})();
function _lbSaveSetting() {
    try { localStorage.setItem('susuru_light_bake', JSON.stringify({ enabled: lightBake.enabled, detail: lightBake.detail })); } catch (e) { /* ignore */ }
}

// ════════════════════════════════════════════════════════════════
//  焼き込む対象のメッシュ
// ════════════════════════════════════════════════════════════════
function _lbCollectMeshes() {
    const out = [];
    const glowSet = new Set((typeof windowGlowMeshEntries !== 'undefined' ? windowGlowMeshEntries : []).map(e => e.mesh));
    const visibleChain = (o) => { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; };
    const add = (o) => {
        if (!o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || !o.geometry || !o.geometry.attributes || !o.geometry.attributes.position) return;
        if (glowSet.has(o)) return;   // 窓（発光面）は灯りの側
        const ud = o.userData || {};
        if (ud.isViewpointMarker || ud.screenSizeMarker || ud.isGlbPivotMarker || ud.noLightBake) return;
        if (o.geometry.morphAttributes && Object.keys(o.geometry.morphAttributes).length) return;
        if (!visibleChain(o)) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        if (!mats.some(m => m && (m.isMeshStandardMaterial || m.isMeshPhongMaterial))) return;
        out.push(o);
    };
    if (typeof importedModelGroup !== 'undefined' && importedModelGroup) importedModelGroup.traverse(add);
    if (typeof funnelMeshes3D !== 'undefined') funnelMeshes3D.forEach(g => g.traverse(add));
    return out;
}

// ════════════════════════════════════════════════════════════════
//  大きな三角形を分ける（辺ごとに分けるので、すき間ができない）
// ════════════════════════════════════════════════════════════════
function _lbReadAttr(attr) {
    const n = attr.count, s = attr.itemSize;
    const out = new Float32Array(n * s);
    const src = attr.isInterleavedBufferAttribute ? attr.data.array : attr.array;
    let k = 1;
    if (attr.normalized) {
        if (src instanceof Uint8Array) k = 1 / 255;
        else if (src instanceof Uint16Array) k = 1 / 65535;
        else if (src instanceof Int8Array) k = 1 / 127;
        else if (src instanceof Int16Array) k = 1 / 32767;
    }
    if (!attr.isInterleavedBufferAttribute && k === 1 && src instanceof Float32Array) {
        out.set(src.subarray(0, n * s));
        return out;
    }
    const get = ['getX', 'getY', 'getZ', 'getW'];
    for (let i = 0; i < n; i++) for (let c = 0; c < s; c++) out[i * s + c] = attr[get[c]](i) * k;
    return out;
}

function _lbGrowF(a, need) {
    if (need <= a.length) return a;
    let c = a.length; while (c < need) c = Math.ceil(c * 1.5) + 64;
    const b = new Float32Array(c); b.set(a); return b;
}
function _lbGrowI(a, need) {
    if (need <= a.length) return a;
    let c = a.length; while (c < need) c = Math.ceil(c * 1.5) + 64;
    const b = new Int32Array(c); b.set(a); return b;
}
function _lbGrowU8(a, need) {
    if (need <= a.length) return a;
    let c = a.length; while (c < need) c = Math.ceil(c * 1.5) + 64;
    const b = new Uint8Array(c); b.set(a); return b;
}

// 位置がまったく同じ頂点に同じ番号（pid）を振る（-0 と +0 は同じ扱い）
function _lbWeld(P, n) {
    const bits = new Uint32Array(n * 3);
    const fbits = new Uint32Array(P.buffer, P.byteOffset, n * 3);
    for (let i = 0; i < n * 3; i++) bits[i] = fbits[i] === 0x80000000 ? 0 : fbits[i];
    let cap = 16; while (cap < n * 2) cap <<= 1;
    const table = new Int32Array(cap).fill(-1);
    const pid = new Int32Array(n);
    let next = 0;
    for (let i = 0; i < n; i++) {
        const x = bits[i * 3], y = bits[i * 3 + 1], z = bits[i * 3 + 2];
        let s = (Math.imul(x, 0x9E3779B1) ^ Math.imul(y, 0x85EBCA77) ^ Math.imul(z, 0xC2B2AE3D)) & (cap - 1);
        for (;;) {
            const v = table[s];
            if (v < 0) { table[s] = i; pid[i] = next++; break; }
            if (bits[v * 3] === x && bits[v * 3 + 1] === y && bits[v * 3 + 2] === z) { pid[i] = pid[v]; break; }
            s = (s + 1) & (cap - 1);
        }
    }
    return { pid, count: next };
}

// 同じ行列のメッシュをまとめて1つのジオメトリにし、_lbSubdivide で分けてから
// メッシュごとに戻す。重なった面（同じ位置の頂点）は同じ辺として扱われ、一緒に分かれる。
// 戻り値：増えた三角形の数
function _lbSubdivideMeshes(list, opts) {
    if (list.length === 1) {
        const m = list[0];
        const res = _lbSubdivide(m.geometry, Object.assign({}, opts, { multi: Array.isArray(m.material) }));
        if (!res) return 0;
        const old = m.geometry; m.geometry = res.geom; old.dispose();
        return res.added;
    }
    // 属性の種類（どれかのメッシュにあれば全部に用意し、無いメッシュは 0 で埋める）
    const names = new Map();
    for (const m of list) {
        for (const nm of Object.keys(m.geometry.attributes)) {
            if (nm.startsWith('bake')) continue;
            const sz = m.geometry.attributes[nm].itemSize;
            if (names.has(nm) && names.get(nm) !== sz) {
                // 形が合わない（まれ）：まとめずに1つずつ
                let add = 0;
                for (const mm of list) add += _lbSubdivideMeshes([mm], Object.assign({}, opts, { budget: opts.budget - add }));
                return add;
            }
            names.set(nm, sz);
        }
    }
    let nV = 0, nI = 0;
    const info = list.map(m => {
        const g = m.geometry, n = g.attributes.position.count;
        const idx = g.index ? g.index.array : null;
        const ni = idx ? idx.length : n;
        const r = { vOff: nV, n, iOff: nI, ni, idx };
        nV += n; nI += ni;
        return r;
    });
    const merged = new THREE.BufferGeometry();
    for (const [nm, sz] of names) {
        const D = new Float32Array(nV * sz);
        list.forEach((m, k) => { const a = m.geometry.attributes[nm]; if (a) D.set(_lbReadAttr(a), info[k].vOff * sz); });
        merged.setAttribute(nm, new THREE.BufferAttribute(D, sz));
    }
    const I = new Uint32Array(nI);
    const combos = [];   // 合わせたグループ → { k: メッシュ, materialIndex }
    list.forEach((m, k) => {
        const r = info[k];
        for (let i = 0; i < r.ni; i++) I[r.iOff + i] = (r.idx ? r.idx[i] : i) + r.vOff;
        const gs = (Array.isArray(m.material) && m.geometry.groups && m.geometry.groups.length) ? m.geometry.groups : null;
        if (gs) gs.forEach(g => { merged.addGroup(r.iOff + g.start, Math.min(g.count, r.ni - g.start), combos.length); combos.push({ k, materialIndex: g.materialIndex, multi: true }); });
        else { merged.addGroup(r.iOff, r.ni, combos.length); combos.push({ k, materialIndex: 0, multi: false }); }
    });
    merged.setIndex(new THREE.BufferAttribute(I, 1));
    const res = _lbSubdivide(merged, Object.assign({}, opts, { multi: true }));
    merged.dispose();
    if (!res) return 0;

    // メッシュごとに戻す
    const ng = res.geom, NI = ng.index.array;
    const remap = new Int32Array(ng.attributes.position.count).fill(-1);
    list.forEach((m, k) => {
        const old = m.geometry;
        const mine = [];
        ng.groups.forEach((g, gi) => { if (combos[gi].k === k) mine.push({ g, c: combos[gi] }); });
        const used = [];
        let count = 0;
        for (const { g } of mine) count += g.count;
        const idx = new Uint32Array(count);
        let w = 0;
        const groups = [];
        for (const { g, c } of mine) {
            const start = w;
            for (let i = g.start; i < g.start + g.count; i++) {
                const v = NI[i];
                if (remap[v] < 0) { remap[v] = used.length; used.push(v); }
                idx[w++] = remap[v];
            }
            if (c.multi) groups.push({ start, count: w - start, materialIndex: c.materialIndex });
        }
        const out = new THREE.BufferGeometry();
        for (const nm of Object.keys(old.attributes)) {
            if (nm.startsWith('bake') || !names.has(nm)) continue;
            const sz = names.get(nm), src = ng.attributes[nm].array;
            const D = new Float32Array(used.length * sz);
            for (let u = 0; u < used.length; u++) for (let c = 0; c < sz; c++) D[u * sz + c] = src[used[u] * sz + c];
            out.setAttribute(nm, new THREE.BufferAttribute(D, sz));
        }
        for (const v of used) remap[v] = -1;
        out.setIndex(new THREE.BufferAttribute(used.length > 65535 ? idx : Uint16Array.from(idx), 1));
        groups.forEach(g => out.addGroup(g.start, g.count, g.materialIndex));
        out.name = old.name;
        out.userData = Object.assign({}, old.userData, { lbOrigCount: (old.userData && old.userData.lbOrigCount) || old.attributes.position.count });
        out.computeBoundingBox();
        out.computeBoundingSphere();
        m.geometry = out;
        old.dispose();
    });
    ng.dispose();
    return res.added;
}

// opts.maxEdge：これより短い辺は分けない（メッシュのローカル単位）
// opts.budget ：増やしてよい三角形の数
// opts.needs(P, a, b, c)：この三角形を分ける必要があるか（明るさの変化が大きいか）
// 分け方は「一番長い辺の中点で2つに分ける」（最長辺二分割）。分ける辺が隣の三角形の
// 一番長い辺でないときは、先に隣を分けてから分ける（Rivara の LEPP）。こうすると
// 細長い三角形ができにくく、増える数も少ない。分ける辺を共有する三角形は全部同じ点で
// 分けるので、すき間はできない。
// 戻り値：{ geom, added } または null（分ける三角形が無い）
function _lbSubdivide(geom, opts) {
    const posAttr = geom.attributes.position;
    const nV = posAttr.count;
    const idxSrc = geom.index ? geom.index.array : null;
    const nT = idxSrc ? (idxSrc.length / 3) | 0 : (nV / 3) | 0;
    const budget = opts.budget;
    if (nT === 0 || budget <= 0) return null;
    const L2 = opts.maxEdge * opts.maxEdge;
    let P = _lbReadAttr(posAttr);
    const vidx = (t, k) => idxSrc ? idxSrc[t * 3 + k] : t * 3 + k;
    const d2 = (a, b) => {
        const dx = P[a * 3] - P[b * 3], dy = P[a * 3 + 1] - P[b * 3 + 1], dz = P[a * 3 + 2] - P[b * 3 + 2];
        return dx * dx + dy * dy + dz * dz;
    };
    // 分ける必要のある三角形が1つも無ければ何もしない
    let any = false;
    for (let t = 0; t < nT && !any; t++) {
        const a = vidx(t, 0), b = vidx(t, 1), c = vidx(t, 2);
        if ((d2(a, b) > L2 || d2(b, c) > L2 || d2(c, a) > L2) && opts.needs(P, a, b, c)) any = true;
    }
    if (!any) return null;

    const names = Object.keys(geom.attributes).filter(nm => !nm.startsWith('bake'));
    const attrs = names.map(nm => ({ name: nm, size: geom.attributes[nm].itemSize,
        data: nm === 'position' ? P : _lbReadAttr(geom.attributes[nm]) }));
    const posA = attrs.find(a => a.name === 'position');
    let nVerts = nV;
    const weld = _lbWeld(P, nV);
    let pid = new Int32Array(Math.max(16, nV)); pid.set(weld.pid);
    let nextPid = weld.count;
    const PM = 67108864;   // 2^26
    const ek = (a, b) => a < b ? a * PM + b : b * PM + a;

    let T = new Int32Array(nT * 3), G = new Int32Array(nT), alive = new Uint8Array(nT);
    let nTri = nT;
    const groups = (opts.multi && geom.groups && geom.groups.length) ? geom.groups : null;
    for (let t = 0; t < nT; t++) {
        T[t * 3] = vidx(t, 0); T[t * 3 + 1] = vidx(t, 1); T[t * 3 + 2] = vidx(t, 2);
        alive[t] = 1; G[t] = groups ? -1 : 0;
    }
    if (groups) {
        groups.forEach((g, gi) => {
            const t0 = Math.floor(g.start / 3), t1 = Math.min(nT, Math.floor((g.start + g.count) / 3));
            for (let t = t0; t < t1; t++) G[t] = gi;
        });
    }

    // 長い辺だけ「その辺を持つ三角形」を覚えておく（短い辺は分けないので要らない）
    const E = new Map();
    const addE = (key, t) => { let l = E.get(key); if (!l) { l = []; E.set(key, l); } l.push(t); };
    const replaceIn = (key, from, to) => { const l = E.get(key); if (!l) return; const i = l.indexOf(from); if (i >= 0) l[i] = to; };
    const longest2 = (t) => Math.max(d2(T[t * 3], T[t * 3 + 1]), d2(T[t * 3 + 1], T[t * 3 + 2]), d2(T[t * 3 + 2], T[t * 3]));
    const needs = (t) => longest2(t) > L2 && opts.needs(P, T[t * 3], T[t * 3 + 1], T[t * 3 + 2]);
    // 積む印：三角形の番号。負の数は「形を整えるために先に分ける隣」（-1-番号）
    const stack = [];
    for (let t = 0; t < nT; t++) {
        const a = T[t * 3], b = T[t * 3 + 1], c = T[t * 3 + 2];
        let has = false;
        if (d2(a, b) > L2) { addE(ek(pid[a], pid[b]), t); has = true; }
        if (d2(b, c) > L2) { addE(ek(pid[b], pid[c]), t); has = true; }
        if (d2(c, a) > L2) { addE(ek(pid[c], pid[a]), t); has = true; }
        if (has && opts.needs(P, a, b, c)) stack.push(t);
    }

    const newVertex = (first, second, p) => {
        const v = nVerts++;
        for (const at of attrs) {
            const s = at.size;
            at.data = _lbGrowF(at.data, nVerts * s);
            const D = at.data;
            for (let c = 0; c < s; c++) D[v * s + c] = (D[first * s + c] + D[second * s + c]) * 0.5;
            if (at.name === 'normal' || at.name === 'tangent') {
                const x = D[v * s], y = D[v * s + 1], z = D[v * s + 2];
                const l = Math.hypot(x, y, z) || 1;
                D[v * s] = x / l; D[v * s + 1] = y / l; D[v * s + 2] = z / l;
                if (at.name === 'tangent') D[v * s + 3] = D[first * s + 3];
            }
        }
        P = posA.data;
        pid = _lbGrowI(pid, nVerts); pid[v] = p;
        return v;
    };
    const addTri = (a, b, c, g) => {
        const t = nTri++;
        T = _lbGrowI(T, nTri * 3); G = _lbGrowI(G, nTri); alive = _lbGrowU8(alive, nTri);
        T[t * 3] = a; T[t * 3 + 1] = b; T[t * 3 + 2] = c; G[t] = g; alive[t] = 1;
        return t;
    };

    let added = 0;
    const midCache = new Map();
    let guard = 0;
    while (stack.length && added < budget && guard++ < 50000000) {
        const top = stack.pop();
        const forced = top < 0;
        const t = forced ? -1 - top : top;
        if (!alive[t]) continue;
        const a = T[t * 3], b = T[t * 3 + 1], c = T[t * 3 + 2];
        const dab = d2(a, b), dbc = d2(b, c), dca = d2(c, a);
        let i, j, dmax;
        if (dab >= dbc && dab >= dca) { i = a; j = b; dmax = dab; }
        else if (dbc >= dca) { i = b; j = c; dmax = dbc; }
        else { i = c; j = a; dmax = dca; }
        if (dmax <= L2) continue;
        if (!forced && !opts.needs(P, a, b, c)) continue;
        const pa = pid[i], pb = pid[j];
        const key = ek(pa, pb);
        const list = E.get(key) || [t];
        // 隣の一番長い辺がこの辺より長ければ、先に隣を分ける（細長い三角形を作らない）
        let defer = -1;
        for (let q = 0; q < list.length; q++) {
            const u = list[q];
            if (u !== t && alive[u] && longest2(u) > dmax * 1.000001) { defer = u; break; }
        }
        if (defer >= 0) { stack.push(top); stack.push(-1 - defer); continue; }
        E.delete(key);
        const np = nextPid++;
        const lo = pa < pb ? pa : pb;
        midCache.clear();
        for (let q = 0; q < list.length; q++) {
            const u = list[q];
            if (!alive[u]) continue;
            let k = -1;
            for (let s = 0; s < 3; s++) {
                const px = pid[T[u * 3 + s]], py = pid[T[u * 3 + (s + 1) % 3]];
                if ((px === pa && py === pb) || (px === pb && py === pa)) { k = s; break; }
            }
            if (k < 0) continue;
            const vi = T[u * 3 + k], vj = T[u * 3 + (k + 1) % 3], vo = T[u * 3 + (k + 2) % 3];
            const mk = vi < vj ? vi * PM + vj : vj * PM + vi;
            let m = midCache.get(mk);
            if (m === undefined) {
                // 位置のビットが両側で同じになるよう、pid の小さい端から計算する
                const first = pid[vi] === lo ? vi : vj;
                m = newVertex(first, first === vi ? vj : vi, np);
                midCache.set(mk, m);
            }
            const g = G[u];
            alive[u] = 0;
            const t1 = addTri(vi, m, vo, g);
            const t2 = addTri(m, vj, vo, g);
            added++;
            replaceIn(ek(pid[vj], pid[vo]), u, t2);
            replaceIn(ek(pid[vo], pid[vi]), u, t1);
            if (d2(vi, m) > L2) addE(ek(pid[vi], np), t1);
            if (d2(m, vj) > L2) addE(ek(np, pid[vj]), t2);
            if (d2(m, vo) > L2) { const kk = ek(np, pid[vo]); addE(kk, t1); addE(kk, t2); }
            if (needs(t1)) stack.push(t1);
            if (needs(t2)) stack.push(t2);
        }
    }
    if (added === 0) return null;

    // 新しいジオメトリ（元のグループ順に並べ直す）
    const ng = new THREE.BufferGeometry();
    for (const at of attrs) {
        ng.setAttribute(at.name, new THREE.BufferAttribute(at.data.slice(0, nVerts * at.size), at.size));
    }
    const IndexArray = nVerts > 65535 ? Uint32Array : Uint16Array;
    let liveCount = 0;
    for (let t = 0; t < nTri; t++) if (alive[t]) liveCount++;
    const index = new IndexArray(liveCount * 3);
    let w = 0;
    if (groups) {
        // グループごとに並べる（数えてから詰める：グループが多くても1回ずつ見るだけ）
        const cnt = new Int32Array(groups.length + 1);
        for (let t = 0; t < nTri; t++) if (alive[t] && G[t] >= 0) cnt[G[t] + 1]++;
        for (let gi = 0; gi < groups.length; gi++) cnt[gi + 1] += cnt[gi];
        const pos = cnt.slice(0, groups.length);
        for (let t = 0; t < nTri; t++) {
            if (!alive[t] || G[t] < 0) continue;
            const o = 3 * pos[G[t]]++;
            index[o] = T[t * 3]; index[o + 1] = T[t * 3 + 1]; index[o + 2] = T[t * 3 + 2];
        }
        groups.forEach((g, gi) => ng.addGroup(cnt[gi] * 3, (cnt[gi + 1] - cnt[gi]) * 3, g.materialIndex));
        w = cnt[groups.length] * 3;
    } else {
        for (let t = 0; t < nTri; t++) {
            if (!alive[t]) continue;
            index[w++] = T[t * 3]; index[w++] = T[t * 3 + 1]; index[w++] = T[t * 3 + 2];
        }
    }
    ng.setIndex(new THREE.BufferAttribute(w === index.length ? index : index.slice(0, w), 1));
    ng.name = geom.name;
    ng.userData = Object.assign({}, geom.userData, { lbOrigCount: (geom.userData && geom.userData.lbOrigCount) || nV });
    ng.computeBoundingBox();
    ng.computeBoundingSphere();
    return { geom: ng, added };
}

// ── どこを分けるか：灯りの明るさの変化が大きい所だけ ──
// 三角形の3つの頂点と3つの辺の中点で、影を無視したおおよその明るさを計算し、
// 中点の明るさが「両端の平均」（頂点の値を直線でつないだもの）から大きくずれて
// いたら分ける。灯りの近く（明かりの丸・明るさの変わり目）だけが細かくなり、
// 灯りから遠い所や、明るさがなだらかな所は分けない。
const LB_REFINE_ABS = 0.004;   // 見分けられる明るさの差（実行時の明るさの単位）
const LB_REFINE_REL = 0.15;    // 明るい所では、この割合のずれまでは許す
const LB_REFINE_CELL = 8;      // 灯りを探すための格子の大きさ[m]
function _lbMakeRefiner(lightsByCh) {
    const all = [];
    for (const ch of LB_CHANNELS) {
        for (const L of lightsByCh[ch]) {
            const k = LB_TYPICAL_SCALE[ch];
            const peak = Math.max(L.color[0], L.color[1], L.color[2]) * k;
            const area = L.type === 0 ? (L.hw.length() * 2) * (L.hh.length() * 2) : 0;
            // この距離より遠くでは、見分けられるほどの明るさの変化が無い
            const reach = L.type === 0
                ? Math.min(L.range, Math.sqrt(peak * area / (Math.PI * LB_REFINE_ABS)))
                : Math.min(L.range, Math.sqrt(peak / LB_REFINE_ABS));
            all.push({ L, peak, area, reach: Math.max(0.5, reach) });
        }
    }
    const grid = new Map();
    const C = LB_REFINE_CELL;
    const key = (x, y, z) => ((x + 512) * 1024 + (y + 512)) * 1024 + (z + 512);
    all.forEach((e, idx) => {
        const p = e.L.pos, r = e.reach;
        const x0 = Math.floor((p.x - r) / C), x1 = Math.floor((p.x + r) / C);
        const y0 = Math.floor((p.y - r) / C), y1 = Math.floor((p.y + r) / C);
        const z0 = Math.floor((p.z - r) / C), z1 = Math.floor((p.z + r) / C);
        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
            const kk = key(x, y, z);
            let l = grid.get(kk); if (!l) { l = []; grid.set(kk, l); } l.push(idx);
        }
    });
    const W = [0, 0, 0, 0, 0, 0, 0, 0, 0];   // 世界座標の a,b,c（作業用）
    const est = (px, py, pz, nx, ny, nz, cand) => {
        let E = 0;
        for (let q = 0; q < cand.length; q++) {
            const e = all[cand[q]], L = e.L;
            let lx = L.pos.x - px, ly = L.pos.y - py, lz = L.pos.z - pz;
            const dd = lx * lx + ly * ly + lz * lz;
            if (dd > e.reach * e.reach) continue;
            const d = Math.sqrt(dd) || 1e-4;
            lx /= d; ly /= d; lz /= d;
            const cr = nx * lx + ny * ly + nz * lz;
            if (cr <= 0) continue;
            if (L.type === 0) {
                const cl = -(L.dir.x * lx + L.dir.y * ly + L.dir.z * lz);
                if (cl <= 0) continue;
                E += e.peak * e.area * cr * cl / (Math.PI * dd + e.area);
            } else {
                let att = 1;
                if (L.cutoff > 0 && L.decay > 0) att = Math.pow(Math.max(0, 1 - d / L.cutoff), L.decay);
                if (L.type === 1) {
                    const ac = L.dir.x * lx + L.dir.y * ly + L.dir.z * lz;
                    if (ac <= L.coneCos) continue;
                    const u = Math.min(1, (ac - L.coneCos) / Math.max(1e-4, L.penCos - L.coneCos));
                    att *= u * u * (3 - 2 * u);
                }
                E += e.peak * att * cr;
            }
        }
        return E;
    };
    // 1つのメッシュ用の判定（M：そのメッシュの、船の基準の姿勢でのワールド行列）
    return function forMesh(M, facing) {
        const m = M.elements;
        const flip = (M.determinant() < 0 ? -1 : 1) * (facing || 1);
        return function needs(P, a, b, c) {
            const vs = [a, b, c];
            for (let k = 0; k < 3; k++) {
                const x = P[vs[k] * 3], y = P[vs[k] * 3 + 1], z = P[vs[k] * 3 + 2];
                W[k * 3]     = m[0] * x + m[4] * y + m[8] * z + m[12];
                W[k * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
                W[k * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
            }
            // 三角形の中心の格子にいる灯りだけ見る
            const cx = (W[0] + W[3] + W[6]) / 3, cy = (W[1] + W[4] + W[7]) / 3, cz = (W[2] + W[5] + W[8]) / 3;
            const cand = grid.get(key(Math.floor(cx / C), Math.floor(cy / C), Math.floor(cz / C)));
            if (!cand) return false;
            // 面の向き
            const e1x = W[3] - W[0], e1y = W[4] - W[1], e1z = W[5] - W[2];
            const e2x = W[6] - W[0], e2y = W[7] - W[1], e2z = W[8] - W[2];
            let nx = (e1y * e2z - e1z * e2y) * flip, ny = (e1z * e2x - e1x * e2z) * flip, nz = (e1x * e2y - e1y * e2x) * flip;
            const nl = Math.hypot(nx, ny, nz);
            if (nl < 1e-12) return false;
            nx /= nl; ny /= nl; nz /= nl;
            const Ea = est(W[0], W[1], W[2], nx, ny, nz, cand);
            const Eb = est(W[3], W[4], W[5], nx, ny, nz, cand);
            const Ec = est(W[6], W[7], W[8], nx, ny, nz, cand);
            const pairs = [[0, 3, Ea, Eb], [3, 6, Eb, Ec], [6, 0, Ec, Ea]];
            for (const [p0, p1, E0, E1] of pairs) {
                const mx = (W[p0] + W[p1]) / 2, my = (W[p0 + 1] + W[p1 + 1]) / 2, mz = (W[p0 + 2] + W[p1 + 2]) / 2;
                const Em = est(mx, my, mz, nx, ny, nz, cand);
                const lin = (E0 + E1) / 2;
                if (Math.abs(Em - lin) > LB_REFINE_ABS + LB_REFINE_REL * Math.max(Em, lin)) return true;
            }
            return false;
        };
    };
}

// ════════════════════════════════════════════════════════════════
//  焼き込む灯り（船の基準の姿勢＝原点・回転なしでのワールド座標）
// ════════════════════════════════════════════════════════════════
// 船（shipGroup）を原点・回転なしに置いた状態で fn を呼ぶ。大きさ（physics.scale）は
// そのままなので、座標はメートル。灯りも頂点もすべてこの姿勢で測るので、焼き込みの
// 途中で船が動いても結果は変わらない（1回の呼び出しの中で元に戻す）。
function _lbCanonical(fn) {
    const sp = shipGroup.position.clone(), sq = shipGroup.quaternion.clone();
    shipGroup.position.set(0, 0, 0);
    shipGroup.quaternion.identity();
    shipGroup.updateMatrixWorld(true);
    try { return fn(); }
    finally {
        shipGroup.position.copy(sp);
        shipGroup.quaternion.copy(sq);
        shipGroup.updateMatrixWorld(true);
    }
}

function _lbRange(ch, peak, isRect, area, cutoff) {
    const minE = LB_MIN_E / LB_TYPICAL_SCALE[ch];
    if (isRect) return Math.min(LB_RECT_MAX_RANGE, Math.max(Math.sqrt(area) * 2, Math.sqrt(peak * area / (Math.PI * minE))));
    if (cutoff > 0) return cutoff;
    return Math.min(LB_POINT_MAX_RANGE, Math.sqrt(peak / minE));
}

// 灯りの一覧を作る。姿勢は _lbCanonical の中で呼ぶこと
function _lbGatherLights() {
    const out = { G: [], L: [], F: [], D: [] };
    const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3();
    const ex = new THREE.Vector3(), ey = new THREE.Vector3(), ez = new THREE.Vector3();

    // 面光源（発光パネル・エリアライト）
    const defs = (typeof getAreaLightDefs === 'function') ? getAreaLightDefs() : [];
    for (const d of defs) {
        let ch, intensity;
        if (d.kind === 'glow') { ch = 'G'; intensity = d.weight || 1; }
        else {
            const src = d.mirrorOf || d;
            const ud = src.holder.userData;
            if (ud.manuallyOff) continue;
            ch = 'L';
            intensity = Number.isFinite(ud.baseIntensity) ? ud.baseIntensity : src.holder.intensity;
            if (d.holder) d.holder.userData.lbBaked = true;
        }
        if (!(intensity > 0)) continue;
        d.node.updateWorldMatrix(true, false);
        d.node.matrixWorld.decompose(pos, quat, scl);
        const w = Math.max(0.01, Math.abs(scl.x)), h = Math.max(0.01, Math.abs(scl.z));
        // 照らす向き：発光パネルは +Y、Blender のエリアライトは -Y（25-area-lights.js）。
        // 面の四隅の回り方も向きに合わせる（高さの向きを逆にする。three.js の
        // RectAreaLight を -90° 回したときと同じ）
        const sign = (typeof areaLightEmitSign === 'function') ? areaLightEmitSign(d) : 1;
        ex.set(1, 0, 0).applyQuaternion(quat);
        ey.set(0, sign, 0).applyQuaternion(quat);
        ez.set(0, 0, sign).applyQuaternion(quat);
        const col = d.color;
        const peak = Math.max(col.r, col.g, col.b) * intensity;
        const range = _lbRange(ch, peak, true, w * h, 0);
        out[ch].push({
            type: 0, pos: pos.clone(), dir: ey.clone(),
            color: [col.r * intensity, col.g * intensity, col.b * intensity], decay: 0, cutoff: 0,
            hw: ex.clone().multiplyScalar(w / 2), hh: ez.clone().multiplyScalar(h / 2),
            coneCos: 0, penCos: 0, range,
            views: [{ pos: pos.clone(), dir: ey.clone(), fov: LB_RECT_FOV, near: 0.02, far: range }],
        });
    }

    // p: { pos, isSpot, target, distance, decay, angle, penumbra, color, intensity }
    const spotLike = (ch, p) => {
        const lp = p.pos.clone();
        const colorObj = p.color, intensity = p.intensity;
        const peak = Math.max(colorObj.r, colorObj.g, colorObj.b) * intensity;
        if (!(peak > 0)) return;
        const cutoff = (p.distance > 0 && p.decay > 0) ? p.distance : 0;
        const range = _lbRange(ch, peak, false, 0, cutoff);
        const base = {
            pos: lp, color: [colorObj.r * intensity, colorObj.g * intensity, colorObj.b * intensity],
            decay: p.decay || 0, cutoff, hw: new THREE.Vector3(), hh: new THREE.Vector3(), range,
        };
        if (p.isSpot) {
            const dir = lp.clone().sub(p.target);
            if (dir.lengthSq() < 1e-10) dir.set(0, 1, 0);
            dir.normalize();
            const ang = Math.min(Math.PI / 2 - 0.01, p.angle);
            out[ch].push(Object.assign(base, {
                type: 1, dir, coneCos: Math.cos(ang), penCos: Math.cos(ang * (1 - (p.penumbra || 0))),
                views: [{ pos: lp.clone(), dir: dir.clone().negate(), fov: Math.min(170, THREE.MathUtils.radToDeg(ang) * 2 + 8), near: 0.05, far: range }],
            }));
        } else {
            const axes = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
            out[ch].push(Object.assign(base, {
                type: 2, dir: new THREE.Vector3(0, 1, 0), coneCos: 0, penCos: 0,
                views: axes.map(a => ({ pos: lp.clone(), dir: new THREE.Vector3(a[0], a[1], a[2]), fov: 92, near: 0.05, far: range })),
            }));
        }
    };

    const worldPos = (o) => { o.updateWorldMatrix(true, false); return new THREE.Vector3().setFromMatrixPosition(o.matrixWorld); };
    const fromLight = (l, intensity) => ({
        pos: worldPos(l), isSpot: !!l.isSpotLight, target: (l.isSpotLight && l.target) ? worldPos(l.target) : null,
        distance: l.distance || 0, decay: l.decay || 0, angle: l.angle || 0, penumbra: l.penumbra || 0,
        color: l.color, intensity,
    });

    // GLB に入っているライト（点・スポット）
    if (typeof glbLights !== 'undefined') {
        for (const l of glbLights) {
            if (!l || !(l.isPointLight || l.isSpotLight) || (l.userData && l.userData.isAreaLight)) continue;
            if (!l.parent) continue;
            l.userData.lbBaked = true;
            if (l.userData.manuallyOff) continue;
            const base = Number.isFinite(l.userData.baseIntensity) ? l.userData.baseIntensity : l.intensity;
            spotLike('L', fromLight(l, base));
        }
    }

    // 煙突のアップライト
    if (typeof funnelUplights !== 'undefined') {
        for (const fu of funnelUplights) {
            for (const s of [fu.spotL, fu.spotR]) {
                if (!s || !s.parent || !s.target) continue;
                spotLike('F', fromLight(s, fu.baseIntensity || 5.0));
            }
        }
    }

    // 甲板灯（配置したスポット。リアルタイムでは近い数個だけ本物の灯りだった）。
    // 12-bloom-and-deck-lighting-fx.js の甲板灯のプールと同じ灯り方
    if (typeof decorLights !== 'undefined' && decorLights.length && typeof shipGroup !== 'undefined') {
        const dirDeg = ((typeof deckLightDirAngle !== 'undefined' ? deckLightDirAngle : 270) - 270 + 360) % 360;
        const dr = THREE.MathUtils.degToRad(dirDeg);
        const worldDir = new THREE.Vector3(Math.sin(dr), -Math.cos(dr), 0).normalize().transformDirection(shipGroup.matrixWorld);
        const deckColor = new THREE.Color(0xffd090);
        for (const d of decorLights) {
            const p = worldPos(d.group);
            spotLike('D', { pos: p, isSpot: true, target: p.clone().add(worldDir), distance: 20, decay: 2,
                angle: Math.PI / 3, penumbra: 0.5, color: deckColor, intensity: 1.8 });
        }
    }
    return out;
}

// ════════════════════════════════════════════════════════════════
//  変更の検出と、保存用のキー
// ════════════════════════════════════════════════════════════════
function _lbHash(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

// 焼き込み結果が変わるもの全部（船・灯り・細かさ）を文字列にしてハッシュにする。
// 船の姿勢には関係しない（船に対する相対の位置で測る）
function _lbSignature(meshes) {
    const inv = new THREE.Matrix4().copy(shipGroup.matrixWorld).invert();
    const M = new THREE.Matrix4();
    const r = (v) => Math.round(v * 1000) / 1000;
    const rel = (o) => { o.updateWorldMatrix(true, false); return M.multiplyMatrices(inv, o.matrixWorld).elements.map(r).join(','); };
    const parts = ['v3', lightBake.detail, r(shipGroup.scale.x)];   // v3: 重なった面をまとめて分ける・鏡像部品の内向き法線を裏返す
    // スクリュー・舵など、いつも動いている部品（07-glb-movable-parts.js）の向きは数えない
    // （数えると、回るたびに「変わった」ことになって焼き直しが止まらない）
    const moving = new Set();
    if (typeof glbMovableParts !== 'undefined') glbMovableParts.forEach(pt => pt.object && pt.object.traverse(o => moving.add(o)));
    for (const m of meshes) {
        const g = m.geometry;
        const n = (g.userData && g.userData.lbOrigCount) || g.attributes.position.count;
        const p = g.attributes.position;
        parts.push(n, r(p.getX(0)), r(p.getY(0)), r(p.getZ(0)), moving.has(m) ? 'M' : rel(m));
    }
    const defs = (typeof getAreaLightDefs === 'function') ? getAreaLightDefs() : [];
    let glowN = 0;
    for (const d of defs) {
        if (d.kind === 'glow') { glowN++; continue; }
        const src = d.mirrorOf || d;
        const ud = src.holder.userData;
        parts.push('A', rel(d.node), d.color.getHexString(), r(Number.isFinite(ud.baseIntensity) ? ud.baseIntensity : src.holder.intensity), ud.manuallyOff ? 0 : 1);
    }
    parts.push('G', glowN);
    const root = (typeof importedModelGroup !== 'undefined' && importedModelGroup) ? importedModelGroup.children[0] : null;
    if (root && glowN) parts.push(rel(root));
    if (typeof glbLights !== 'undefined') {
        for (const l of glbLights) {
            if (!l || !(l.isPointLight || l.isSpotLight) || (l.userData && l.userData.isAreaLight) || !l.parent) continue;
            parts.push('P', rel(l), l.target ? rel(l.target) : '', l.color.getHexString(), r(l.userData.baseIntensity || 0),
                r(l.distance), r(l.decay), r(l.angle || 0), r(l.penumbra || 0), l.userData.manuallyOff ? 0 : 1);
        }
    }
    if (typeof funnelUplights !== 'undefined') {
        for (const fu of funnelUplights) for (const s of [fu.spotL, fu.spotR]) if (s && s.parent) parts.push('F', rel(s), rel(s.target));
    }
    if (typeof decorLights !== 'undefined') {
        parts.push('D', typeof deckLightDirAngle !== 'undefined' ? deckLightDirAngle : 270);
        for (const d of decorLights) parts.push(rel(d.group));
    }
    return _lbHash(parts.join('|'));
}

// ════════════════════════════════════════════════════════════════
//  端末への保存（IndexedDB）
// ════════════════════════════════════════════════════════════════
const LB_DB_NAME = 'susuru_light_bake';
function _lbDb() {
    return new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') { reject(new Error('no indexedDB')); return; }
        const req = indexedDB.open(LB_DB_NAME, 1);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
            if (!db.objectStoreNames.contains('data')) db.createObjectStore('data', { keyPath: 'key' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}
function _lbReq(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function _lbCacheGet(key) {
    try {
        const db = await _lbDb();
        const tx = db.transaction(['data', 'meta'], 'readwrite');
        const v = await _lbReq(tx.objectStore('data').get(key));
        if (v) tx.objectStore('meta').put({ key, time: Date.now() });
        db.close();
        return v || null;
    } catch (e) { return null; }
}
async function _lbCachePut(entry) {
    try {
        const db = await _lbDb();
        let tx = db.transaction(['data', 'meta'], 'readwrite');
        tx.objectStore('data').put(entry);
        tx.objectStore('meta').put({ key: entry.key, time: Date.now() });
        await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
        // 古いものを消す
        tx = db.transaction(['data', 'meta'], 'readwrite');
        const metas = await _lbReq(tx.objectStore('meta').getAll());
        metas.sort((a, b) => b.time - a.time);
        for (const m of metas.slice(LB_CACHE_KEEP)) { tx.objectStore('meta').delete(m.key); tx.objectStore('data').delete(m.key); }
        db.close();
        if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    } catch (e) { console.warn('[LightBake] 保存できませんでした:', e); }
}
async function _lbCacheClear() {
    try {
        const db = await _lbDb();
        const tx = db.transaction(['data', 'meta'], 'readwrite');
        tx.objectStore('data').clear(); tx.objectStore('meta').clear();
        db.close();
    } catch (e) { /* ignore */ }
}

// ════════════════════════════════════════════════════════════════
//  GPU での計算
// ════════════════════════════════════════════════════════════════
const _LB_BAKE_FRAG = `
precision highp float;
precision highp int;
#include <packing>
uniform sampler2D uPos;
uniform sampler2D uNrm;
uniform sampler2D uLights;
uniform sampler2D uViews;
uniform sampler2D uAtlas;
uniform int uCount;
uniform vec2 uSize;
uniform float uAtlasTexel;
uniform float uTileUV;

vec4 LR(int i, float r) { return texture2D(uLights, vec2((float(i) + 0.5) / ${LB_MAX_LIGHTS}.0, (r + 0.5) / 6.0)); }
vec4 VR(int j, float r) { return texture2D(uViews, vec2((float(j) + 0.5) / ${LB_TILES}.0, (r + 0.5) / 5.0)); }

// three.js の RectAreaLight（LTC）の拡散の部分と同じ式
vec3 edgeFF(vec3 v1, vec3 v2) {
    float x = dot(v1, v2);
    float y = abs(x);
    float a = 0.8543985 + (0.4965155 + 0.0145206 * y) * y;
    float b = 3.4175940 + (4.1616724 + y) * y;
    float v = a / b;
    float ts = (x > 0.0) ? v : 0.5 * inversesqrt(max(1.0 - x * x, 1e-7)) - v;
    return cross(v1, v2) * ts;
}
float rectFF(vec3 N, vec3 P, vec3 C, vec3 hw, vec3 hh) {
    vec3 up = abs(N.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 T1 = normalize(cross(N, up));
    vec3 T2 = -cross(N, T1);
    vec3 p0 = C + hw - hh - P;
    vec3 p1 = C - hw - hh - P;
    vec3 p2 = C - hw + hh - P;
    vec3 p3 = C + hw + hh - P;
    vec3 q0 = normalize(vec3(dot(T1, p0), dot(T2, p0), dot(N, p0)));
    vec3 q1 = normalize(vec3(dot(T1, p1), dot(T2, p1), dot(N, p1)));
    vec3 q2 = normalize(vec3(dot(T1, p2), dot(T2, p2), dot(N, p2)));
    vec3 q3 = normalize(vec3(dot(T1, p3), dot(T2, p3), dot(N, p3)));
    vec3 f = edgeFF(q0, q1) + edgeFF(q1, q2) + edgeFF(q2, q3) + edgeFF(q3, q0);
    float l = length(f);
    return max((l * l + f.z) / (l + 1.0), 0.0);
}
// 影の地図1枚ぶん。写っていなければ -1
float viewVis(int j, vec3 Pw, float dist) {
    mat4 VP = mat4(VR(j, 0.0), VR(j, 1.0), VR(j, 2.0), VR(j, 3.0));
    vec4 clip = VP * vec4(Pw, 1.0);
    if (clip.w <= 1e-6) return -1.0;
    vec2 ndc = clip.xy / clip.w;
    if (abs(ndc.x) > 1.0 || abs(ndc.y) > 1.0) return -1.0;
    vec4 r4 = VR(j, 4.0);
    vec2 org = r4.xy * uTileUV;
    vec2 lo = org + vec2(uAtlasTexel * 0.5);
    vec2 hi = org + vec2(uTileUV - uAtlasTexel * 0.5);
    vec2 c = org + (ndc * 0.5 + 0.5) * uTileUV;
    float bias = 0.02 + 1.5 * r4.w * dist;
    float vis = 0.0;
    for (int x = -1; x <= 1; x++) {
        for (int y = -1; y <= 1; y++) {
            vec2 uv = clamp(c + vec2(float(x), float(y)) * uAtlasTexel, lo, hi);
            float stored = unpackRGBAToDepth(texture2D(uAtlas, uv)) * r4.z;
            vis += (dist - bias <= stored) ? 1.0 : 0.0;
        }
    }
    return vis / 9.0;
}
void main() {
    vec2 uv = gl_FragCoord.xy / uSize;
    vec4 pw = texture2D(uPos, uv);
    if (pw.w < 0.5) { gl_FragColor = vec4(0.0); return; }
    vec3 P = pw.xyz;
    vec3 N = texture2D(uNrm, uv).xyz * 2.0 - 1.0;
    float nl = length(N);
    N = nl > 1e-4 ? N / nl : vec3(0.0, 1.0, 0.0);
    vec3 sum = vec3(0.0);
    for (int i = 0; i < ${LB_MAX_LIGHTS}; i++) {
        if (i >= uCount) break;
        vec4 r0 = LR(i, 0.0);                  // 位置・届く範囲
        vec3 Lv = r0.xyz - P;
        float d2 = dot(Lv, Lv);
        if (d2 > r0.w * r0.w) continue;
        vec4 r1 = LR(i, 1.0);                  // 向き・種類（0面 1スポット 2点）
        vec4 r2 = LR(i, 2.0);                  // 色×強さ・減衰の指数
        vec4 r3 = LR(i, 3.0);                  // 面の半幅・届く距離
        vec4 r4 = LR(i, 4.0);                  // 面の半高さ・スポットの縁
        vec4 r5 = LR(i, 5.0);                  // 影の地図の番号・枚数・スポットのぼかし
        float d = sqrt(d2);
        vec3 l = Lv / max(d, 1e-5);
        vec3 contrib;
        if (r1.w < 0.5) {
            if (dot(r1.xyz, P - r0.xyz) <= 0.0) continue;   // 面の裏側
            float ff = rectFF(N, P, r0.xyz, r3.xyz, r4.xyz);
            if (ff <= 1e-6) continue;
            contrib = r2.rgb * ff;
        } else {
            float dotNL = dot(N, l);
            if (dotNL <= 0.0) continue;
            float att = 1.0;
            if (r3.w > 0.0 && r2.w > 0.0) att = pow(clamp(1.0 - d / r3.w, 0.0, 1.0), r2.w);
            if (r1.w < 1.5) {
                float ac = dot(l, r1.xyz);
                if (ac <= r4.w) continue;
                att *= smoothstep(r4.w, r5.z, ac);
            }
            contrib = r2.rgb * (att * dotNL);
        }
        vec3 Pb = P + N * (0.02 + 0.003 * d);
        float dist = length(r0.xyz - Pb);
        int first = int(r5.x + 0.5);
        int cnt = int(r5.y + 0.5);
        float vis = 1.0;
        for (int v = 0; v < 6; v++) {
            if (v >= cnt) break;
            float s = viewVis(first + v, Pb, dist);
            if (s >= 0.0) { vis = s; break; }
        }
        sum += contrib * vis;
    }
    vec3 c = sum / ${LB_RGBM_RANGE.toFixed(1)};
    float m = clamp(max(max(c.r, c.g), max(c.b, 1e-6)), 0.0, 1.0);
    m = ceil(m * 255.0) / 255.0;
    gl_FragColor = vec4(clamp(c / m, 0.0, 1.0), m);
}`;

function _lbCreateGpu() {
    const gpu = {};
    gpu.atlas = new THREE.WebGLRenderTarget(LB_ATLAS, LB_ATLAS, {
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true, stencilBuffer: false,
    });
    gpu.atlas.texture.generateMipmaps = false;
    gpu.out = new THREE.WebGLRenderTarget(LB_TEX_W, LB_CHUNK_ROWS, {
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, stencilBuffer: false,
    });
    gpu.out.texture.generateMipmaps = false;
    const ft = (w, h) => {
        const t = new THREE.DataTexture(new Float32Array(w * h * 4), w, h, THREE.RGBAFormat, THREE.FloatType);
        t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true;
        return t;
    };
    gpu.posTex = ft(LB_TEX_W, LB_CHUNK_ROWS);
    gpu.nrmTex = new THREE.DataTexture(new Uint8Array(LB_CHUNK * 4), LB_TEX_W, LB_CHUNK_ROWS, THREE.RGBAFormat, THREE.UnsignedByteType);
    gpu.nrmTex.minFilter = gpu.nrmTex.magFilter = THREE.NearestFilter; gpu.nrmTex.generateMipmaps = false;
    gpu.lightTex = ft(LB_MAX_LIGHTS, 6);
    gpu.viewTex = ft(LB_TILES, 5);
    gpu.distMat = new THREE.ShaderMaterial({
        uniforms: { uLightPos: { value: new THREE.Vector3() }, uFar: { value: 1 } },
        vertexShader: `varying vec3 vW;
void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
        fragmentShader: `#include <packing>
uniform vec3 uLightPos; uniform float uFar; varying vec3 vW;
void main() { gl_FragColor = packDepthToRGBA(clamp(length(vW - uLightPos) / uFar, 0.0, 0.9999)); }`,
        side: THREE.DoubleSide,
    });
    gpu.bakeMat = new THREE.ShaderMaterial({
        uniforms: {
            uPos: { value: gpu.posTex }, uNrm: { value: gpu.nrmTex }, uLights: { value: gpu.lightTex },
            uViews: { value: gpu.viewTex }, uAtlas: { value: gpu.atlas.texture }, uCount: { value: 0 },
            uSize: { value: new THREE.Vector2(LB_TEX_W, LB_CHUNK_ROWS) },
            uAtlasTexel: { value: 1 / LB_ATLAS }, uTileUV: { value: LB_TILE / LB_ATLAS },
        },
        vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: _LB_BAKE_FRAG,
        depthTest: false, depthWrite: false,
    });
    gpu.quadScene = new THREE.Scene();
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), gpu.bakeMat);
    quad.frustumCulled = false;
    gpu.quadScene.add(quad);
    gpu.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    gpu.cam = new THREE.PerspectiveCamera(90, 1, 0.05, 10);
    gpu.cam.layers.set(LB_LAYER);
    gpu.readBuf = new Uint8Array(LB_CHUNK * 4);
    return gpu;
}
function _lbDisposeGpu(gpu) {
    if (!gpu) return;
    ['atlas', 'out'].forEach(k => gpu[k] && gpu[k].dispose());
    ['posTex', 'nrmTex', 'lightTex', 'viewTex'].forEach(k => gpu[k] && gpu[k].dispose());
    ['distMat', 'bakeMat'].forEach(k => gpu[k] && gpu[k].dispose());
    gpu.quadScene && gpu.quadScene.traverse(o => o.geometry && o.geometry.dispose());
}

function _lbSaveRenderState() {
    const cc = new THREE.Color();
    renderer.getClearColor(cc);
    return {
        target: renderer.getRenderTarget(), clearColor: cc, clearAlpha: renderer.getClearAlpha(),
        autoClear: renderer.autoClear, override: scene.overrideMaterial, background: scene.background,
        shadowAuto: renderer.shadowMap.autoUpdate, shadowNeeds: renderer.shadowMap.needsUpdate,
    };
}
function _lbRestoreRenderState(s) {
    renderer.setRenderTarget(s.target);
    renderer.setClearColor(s.clearColor, s.clearAlpha);
    renderer.autoClear = s.autoClear;
    scene.overrideMaterial = s.override;
    scene.background = s.background;
    renderer.shadowMap.autoUpdate = s.shadowAuto;
    renderer.shadowMap.needsUpdate = s.shadowNeeds;
}

// 影の地図を撮る（views は1回の計算ぶん、最大64枚）。船の基準の姿勢で呼ぶ
function _lbRenderViews(gpu, views, meshes) {
    const st = _lbSaveRenderState();
    const rt = gpu.atlas, cam = gpu.cam, VD = gpu.viewTex.image.data;
    try {
        meshes.forEach(m => m.layers.enable(LB_LAYER));
        scene.overrideMaterial = gpu.distMat;
        scene.background = null;
        renderer.shadowMap.autoUpdate = false;
        renderer.shadowMap.needsUpdate = false;
        renderer.autoClear = false;
        renderer.setClearColor(0xffffff, 1);
        const vp = new THREE.Matrix4();
        const up = new THREE.Vector3();
        views.forEach((v, j) => {
            const tx = j % LB_TILES_ROW, ty = (j / LB_TILES_ROW) | 0;
            rt.viewport.set(tx * LB_TILE, ty * LB_TILE, LB_TILE, LB_TILE);
            rt.scissor.set(tx * LB_TILE, ty * LB_TILE, LB_TILE, LB_TILE);
            rt.scissorTest = true;
            renderer.setRenderTarget(rt);
            renderer.clear(true, true, false);
            cam.fov = v.fov; cam.near = v.near; cam.far = Math.max(v.far, v.near * 2);
            cam.aspect = 1;
            cam.position.copy(v.pos);
            up.set(0, 1, 0);
            if (Math.abs(v.dir.y) > 0.99) up.set(0, 0, 1);
            cam.up.copy(up);
            cam.lookAt(v.pos.x + v.dir.x, v.pos.y + v.dir.y, v.pos.z + v.dir.z);
            cam.updateMatrixWorld(true);
            cam.updateProjectionMatrix();
            gpu.distMat.uniforms.uLightPos.value.copy(v.pos);
            gpu.distMat.uniforms.uFar.value = cam.far;
            renderer.render(scene, cam);
            vp.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
            const e = vp.elements;
            for (let c = 0; c < 4; c++) {
                const o = (c * LB_TILES + j) * 4;
                VD[o] = e[c * 4]; VD[o + 1] = e[c * 4 + 1]; VD[o + 2] = e[c * 4 + 2]; VD[o + 3] = e[c * 4 + 3];
            }
            const o4 = (4 * LB_TILES + j) * 4;
            VD[o4] = tx; VD[o4 + 1] = ty; VD[o4 + 2] = cam.far;
            VD[o4 + 3] = 2 * Math.tan(THREE.MathUtils.degToRad(v.fov) / 2) / LB_TILE;
        });
        rt.scissorTest = false;
        rt.viewport.set(0, 0, LB_ATLAS, LB_ATLAS);
        rt.scissor.set(0, 0, LB_ATLAS, LB_ATLAS);
        gpu.viewTex.needsUpdate = true;
    } finally {
        meshes.forEach(m => m.layers.disable(LB_LAYER));
        _lbRestoreRenderState(st);
    }
}

// 灯りの表を書く
function _lbWriteLights(gpu, lights) {
    const D = gpu.lightTex.image.data;
    D.fill(0);
    const put = (row, i, a, b, c, d) => { const o = (row * LB_MAX_LIGHTS + i) * 4; D[o] = a; D[o + 1] = b; D[o + 2] = c; D[o + 3] = d; };
    let view = 0;
    lights.forEach((L, i) => {
        put(0, i, L.pos.x, L.pos.y, L.pos.z, L.range);
        put(1, i, L.dir.x, L.dir.y, L.dir.z, L.type);
        put(2, i, L.color[0], L.color[1], L.color[2], L.decay);
        put(3, i, L.hw.x, L.hw.y, L.hw.z, L.cutoff);
        put(4, i, L.hh.x, L.hh.y, L.hh.z, L.coneCos);
        put(5, i, view, L.views.length, L.penCos, 0);
        view += L.views.length;
    });
    gpu.lightTex.needsUpdate = true;
    gpu.bakeMat.uniforms.uCount.value = lights.length;
}

function _lbBakePass(gpu) {
    const st = _lbSaveRenderState();
    try {
        renderer.setRenderTarget(gpu.out);
        renderer.autoClear = true;
        renderer.setClearColor(0x000000, 0);
        renderer.render(gpu.quadScene, gpu.quadCam);
        renderer.readRenderTargetPixels(gpu.out, 0, 0, LB_TEX_W, LB_CHUNK_ROWS, gpu.readBuf);
    } finally {
        _lbRestoreRenderState(st);
    }
    return gpu.readBuf;
}

// ════════════════════════════════════════════════════════════════
//  焼き込みの手順（少しずつ進める：1フレームに1歩）
// ════════════════════════════════════════════════════════════════
function _lbSetStatus(s, progress) {
    lightBake.status = s;
    if (progress !== undefined) lightBake.progress = progress;
    const el = document.getElementById('bake-status');
    if (el) el.textContent = s;
    _lbHud();
}
function _lbHud() {
    let el = document.getElementById('bake-hud');
    if (!el) {
        el = document.createElement('div');
        el.id = 'bake-hud';
        document.body.appendChild(el);
    }
    el.style.display = lightBake.busy ? '' : 'none';
    if (lightBake.busy) el.textContent = `💡 照明を焼き込み中… ${Math.round(lightBake.progress * 100)}%`;
}
function _lbFmt(n) {
    if (n >= 10000) return (Math.round(n / 1000) / 10) + '万';
    return String(n);
}

function* _lbJob(job) {
    const gpuSupported = renderer.capabilities.isWebGL2 || !!renderer.extensions.get('OES_texture_float');
    if (!gpuSupported) throw new Error('この端末では浮動小数のテクスチャが使えません');
    lightBake.busy = true;
    _lbSetStatus('焼き込みの準備中…', 0);
    yield 'frame';

    // ── 1. 対象のメッシュと灯り。灯りの近くの大きな三角形を分ける ──
    let meshes = _lbCollectMeshes();
    if (!meshes.length) throw new Error('焼き込む船のメッシュがありません');
    // 同じジオメトリを複数の場所で使い回しているモデル（通風筒・左右対称の船体など）では、
    // 焼き込んだ明るさ（頂点ごとの値）が置き場所ごとに違うので、それぞれ別のジオメトリにする。
    // 分けないと最後に計算した1か所の明るさが全部に貼られ、まだらになる。
    {
        const seen = new Set();
        for (const m of meshes) {
            if (seen.has(m.geometry)) m.geometry = m.geometry.clone();
            seen.add(m.geometry);
        }
    }
    const lights = _lbCanonical(() => _lbGatherLights());
    const edgeM = LB_EDGE_M[lightBake.detail] || 1.0;
    const subKey = (job.sig || '') + '|' + lightBake.detail;
    if (lightBake.subdivKey !== subKey) {
        const refiner = _lbMakeRefiner(lights);
        const mats = _lbCanonical(() => meshes.map(m => { m.updateWorldMatrix(true, false); return m.matrixWorld.clone(); }));
        let budget = LB_MAX_NEW_TRIS;
        // 同じ位置（同じ行列）にあるメッシュはまとめて分ける。表と裏で別々の面を
        // ぴったり重ねたモデル（SketchUp 由来など：黒い塗装の面と白い裏面が同じ所にある）で、
        // 片方だけ・違う形に分けると奥行きの計算が微妙にずれて、まだらにちらつく。
        // まとめて分ければ、重なった面は同じ点で同じように分かれる。
        const byMatrix = new Map();
        for (let i = 0; i < meshes.length; i++) {
            const key = mats[i].elements.join(',');
            let l = byMatrix.get(key); if (!l) { l = []; byMatrix.set(key, l); } l.push(i);
        }
        let lastYield = performance.now();
        let doneN = 0;
        for (const idxs of byMatrix.values()) {
            const M = mats[idxs[0]];
            const sc = new THREE.Vector3().setFromMatrixScale(M);
            const mpu = Math.max(Math.abs(sc.x), Math.abs(sc.y), Math.abs(sc.z)) || 1;
            const list = idxs.map(i => meshes[i]);
            const facing = (typeof meshFacingSign === 'function') ? meshFacingSign(list[0]) : 1;
            const opts = { maxEdge: edgeM / mpu, budget, multi: true, needs: refiner(M, facing) };
            const added = _lbSubdivideMeshes(list, opts);
            budget -= added;
            doneN += idxs.length;
            if (performance.now() - lastYield > 30) {
                _lbSetStatus(`灯りの近くの三角形を分けています… ${doneN}/${meshes.length}`, 0.25 * doneN / meshes.length);
                yield 'frame';
                if (job.aborted) return;
                lastYield = performance.now();
            }
        }
        lightBake.subdivKey = subKey;
        lightBake.subdivAdded = LB_MAX_NEW_TRIS - budget;
    }
    meshes.forEach(m => { if (!m.geometry.attributes.normal) m.geometry.computeVertexNormals(); });

    // ── 2. 保存してある結果があれば使う ──
    const sig = _lbSignature(meshes);
    const counts = meshes.map(m => m.geometry.attributes.position.count);
    if (!lightBake.force) {
        _lbSetStatus('保存してある焼き込みを探しています…', 0.27);
        const cached = yield _lbCacheGet(sig);
        if (job.aborted) return;
        if (cached && cached.counts && cached.counts.length === counts.length && cached.counts.every((c, i) => c === counts[i])) {
            const outputs = {};
            for (const ch of cached.set) outputs[ch] = cached.data[ch];
            _lbApply(meshes, outputs, cached.set);
            lightBake.stats = Object.assign({}, cached.stats, { fromCache: true });
            _lbSetStatus(_lbDoneText(), 1);
            return;
        }
    }
    lightBake.force = false;

    // ── 3. 頂点（位置・向き）を船の基準の姿勢で集める ──
    let N = 0;
    const meshStart = [];
    for (const c of counts) { meshStart.push(N); N += c; }
    const P = new Float32Array(N * 3);
    const Nq = new Int8Array(N * 3);
    let aabbMin = new THREE.Vector3(Infinity, Infinity, Infinity), aabbMax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    _lbCanonical(() => {
        const v = new THREE.Vector3(), nm = new THREE.Matrix3();
        meshes.forEach((m, mi) => {
            m.updateWorldMatrix(true, false);
            const M = m.matrixWorld;
            nm.getNormalMatrix(M);
            // 鏡像で複製された部品の法線が内向きなら、裏返して使う（26-glow-emitters.js）
            if (typeof meshFacingSign === 'function' && meshFacingSign(m) < 0) nm.multiplyScalar(-1);
            const pa = _lbReadAttr(m.geometry.attributes.position), na = _lbReadAttr(m.geometry.attributes.normal);
            const o = meshStart[mi];
            for (let i = 0; i < counts[mi]; i++) {
                v.set(pa[i * 3], pa[i * 3 + 1], pa[i * 3 + 2]).applyMatrix4(M);
                P[(o + i) * 3] = v.x; P[(o + i) * 3 + 1] = v.y; P[(o + i) * 3 + 2] = v.z;
                aabbMin.min(v); aabbMax.max(v);
                v.set(na[i * 3], na[i * 3 + 1], na[i * 3 + 2]).applyMatrix3(nm);
                const l = v.length() || 1;
                Nq[(o + i) * 3] = Math.round(v.x / l * 127); Nq[(o + i) * 3 + 1] = Math.round(v.y / l * 127); Nq[(o + i) * 3 + 2] = Math.round(v.z / l * 127);
            }
        });
    });
    _lbSetStatus(`頂点を並べています…（${_lbFmt(N)}）`, 0.3);
    yield 'frame';
    if (job.aborted) return;

    // 近い頂点が同じ回の計算に入るよう、空間の順（Z曲線）に並べる
    const order = new Uint32Array(N);
    if (N < 4194304) {
        const keys = new Float64Array(N);
        const ext = aabbMax.clone().sub(aabbMin);
        const inv = [1023 / Math.max(1e-6, ext.x), 1023 / Math.max(1e-6, ext.y), 1023 / Math.max(1e-6, ext.z)];
        const spread = (x) => { x &= 0x3ff; x = (x | (x << 16)) & 0x30000ff; x = (x | (x << 8)) & 0x300f00f; x = (x | (x << 4)) & 0x30c30c3; x = (x | (x << 2)) & 0x9249249; return x; };
        for (let i = 0; i < N; i++) {
            const qx = ((P[i * 3] - aabbMin.x) * inv[0]) | 0, qy = ((P[i * 3 + 1] - aabbMin.y) * inv[1]) | 0, qz = ((P[i * 3 + 2] - aabbMin.z) * inv[2]) | 0;
            const code = (spread(qx) | (spread(qy) << 1) | (spread(qz) << 2)) >>> 0;
            keys[i] = code * 4194304 + i;
        }
        keys.sort();
        for (let i = 0; i < N; i++) order[i] = keys[i] % 4194304;
    } else {
        for (let i = 0; i < N; i++) order[i] = i;
    }
    yield 'frame';
    if (job.aborted) return;

    // ── 4. 灯りの種類 ──
    const set = LB_CHANNELS.filter(ch => lights[ch].length > 0).join('');
    const nLights = LB_CHANNELS.reduce((s, ch) => s + lights[ch].length, 0);
    if (!set) {
        _lbApply(meshes, {}, '');
        lightBake.stats = { lights: 0, points: N };
        _lbSetStatus(_lbDoneText(), 1);
        return;
    }

    // ── 5. GPU で計算 ──
    const outputs = {};
    for (const ch of set) outputs[ch] = meshes.map((m, mi) => new Uint8Array(counts[mi] * 4));
    const meshOf = (g) => {   // 通し番号 → メッシュ番号（二分探索）
        let lo = 0, hi = meshStart.length - 1;
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (meshStart[mid] <= g) lo = mid; else hi = mid - 1; }
        return lo;
    };
    const gpu = _lbCreateGpu();
    const acc = new Float32Array(LB_CHUNK * 3);
    const nChunks = Math.ceil(N / LB_CHUNK);
    const cMin = new THREE.Vector3(), cMax = new THREE.Vector3(), tmpV = new THREE.Vector3();
    let stepsDone = 0;
    // 進み具合の見積もり（灯りと頂点の塊の組の数）
    const totalSteps = Math.max(1, nChunks * set.length);
    try {
        for (let ci = 0; ci < nChunks; ci++) {
            const c0 = ci * LB_CHUNK, cn = Math.min(LB_CHUNK, N - c0);
            // 頂点の表を書く
            const PD = gpu.posTex.image.data, ND = gpu.nrmTex.image.data;
            PD.fill(0); ND.fill(0);
            cMin.set(Infinity, Infinity, Infinity); cMax.set(-Infinity, -Infinity, -Infinity);
            for (let k = 0; k < cn; k++) {
                const g = order[c0 + k];
                const x = P[g * 3], y = P[g * 3 + 1], z = P[g * 3 + 2];
                PD[k * 4] = x; PD[k * 4 + 1] = y; PD[k * 4 + 2] = z; PD[k * 4 + 3] = 1;
                ND[k * 4] = Nq[g * 3] + 128; ND[k * 4 + 1] = Nq[g * 3 + 1] + 128; ND[k * 4 + 2] = Nq[g * 3 + 2] + 128; ND[k * 4 + 3] = 255;
                if (x < cMin.x) cMin.x = x; if (y < cMin.y) cMin.y = y; if (z < cMin.z) cMin.z = z;
                if (x > cMax.x) cMax.x = x; if (y > cMax.y) cMax.y = y; if (z > cMax.z) cMax.z = z;
            }
            gpu.posTex.needsUpdate = true;
            gpu.nrmTex.needsUpdate = true;
            const box = new THREE.Box3(cMin.clone(), cMax.clone());

            for (const ch of set) {
                // この塊に届く灯りだけ
                const near = lights[ch].filter(L => box.distanceToPoint(tmpV.copy(L.pos)) <= L.range);
                acc.fill(0);
                let i0 = 0;
                while (i0 < near.length) {
                    // 1回ぶん（灯り64・影の地図64枚まで）
                    const batch = [];
                    let nv = 0;
                    while (i0 < near.length && batch.length < LB_MAX_LIGHTS && nv + near[i0].views.length <= LB_TILES) {
                        batch.push(near[i0]); nv += near[i0].views.length; i0++;
                    }
                    const views = [];
                    batch.forEach(L => L.views.forEach(v => views.push(v)));
                    _lbCanonical(() => _lbRenderViews(gpu, views, meshes));
                    _lbWriteLights(gpu, batch);
                    const buf = _lbBakePass(gpu);
                    for (let k = 0; k < cn; k++) {
                        const a = buf[k * 4 + 3];
                        if (!a) continue;
                        const s = a * (LB_RGBM_RANGE / (255 * 255));
                        acc[k * 3] += buf[k * 4] * s; acc[k * 3 + 1] += buf[k * 4 + 1] * s; acc[k * 3 + 2] += buf[k * 4 + 2] * s;
                    }
                    const frac = (stepsDone + i0 / Math.max(1, near.length)) / totalSteps;
                    _lbSetStatus(`照明を焼き込んでいます… ${Math.round(frac * 100)}%`, 0.32 + 0.66 * frac);
                    yield 'frame';
                    if (job.aborted) return;
                }
                // RGBM にして頂点へ
                const outCh = outputs[ch];
                for (let k = 0; k < cn; k++) {
                    const g = order[c0 + k];
                    const mi = meshOf(g), vi = g - meshStart[mi];
                    const r = acc[k * 3] / LB_RGBM_RANGE, gg = acc[k * 3 + 1] / LB_RGBM_RANGE, b = acc[k * 3 + 2] / LB_RGBM_RANGE;
                    let m = Math.min(1, Math.max(r, gg, b, 1e-6));
                    m = Math.ceil(m * 255) / 255;
                    const o = vi * 4, O = outCh[mi];
                    O[o] = Math.min(255, Math.round(r / m * 255));
                    O[o + 1] = Math.min(255, Math.round(gg / m * 255));
                    O[o + 2] = Math.min(255, Math.round(b / m * 255));
                    O[o + 3] = Math.round(m * 255);
                }
                stepsDone++;
            }
        }
    } finally {
        _lbDisposeGpu(gpu);
    }

    // ── 6. 付ける・保存する ──
    _lbApply(meshes, outputs, set);
    lightBake.stats = { lights: nLights, points: N, channels: set };
    _lbSetStatus(_lbDoneText(), 1);
    _lbCachePut({ key: sig, set, counts, data: outputs, stats: lightBake.stats, time: Date.now() });
}

function _lbDoneText() {
    const s = lightBake.stats || {};
    if (!s.lights) return '焼き込み済み（焼き込む灯りがありません）';
    return `焼き込み済み：灯り ${s.lights} 個・頂点 ${_lbFmt(s.points || 0)}${s.fromCache ? '（保存してある結果を使用）' : ''}`;
}

// ════════════════════════════════════════════════════════════════
//  焼き込んだ明るさを船に付ける
// ════════════════════════════════════════════════════════════════
function _lbPatchMaterial(mat) {
    if (!mat || mat.userData.lightBakePatched) return;
    if (!(mat.isMeshStandardMaterial || mat.isMeshPhongMaterial)) return;
    mat.userData.lightBakePatched = true;
    const prev = mat.onBeforeCompile;
    const prevKey = mat.customProgramCacheKey;
    mat.onBeforeCompile = function (shader, r) {
        if (typeof prev === 'function') prev.call(this, shader, r);
        const set = lightBake.channelSet;
        if (!set) return;
        shader.uniforms.uBakeScale = lightBakeUniforms.uBakeScale;
        let decl = '\nuniform vec4 uBakeScale;\nvarying vec3 vBakeLight;\n';
        let expr = '\n    // 焼き込んだ船の照明（40-light-bake.js）\n    vBakeLight = vec3(0.0);\n';
        for (const ch of set) {
            decl += `attribute vec4 bake${ch};\n`;
            expr += `    vBakeLight += bake${ch}.rgb * (bake${ch}.a * ${LB_RGBM_RANGE.toFixed(1)} * uBakeScale.${LB_CH_COMP[ch]});\n`;
        }
        shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>' + decl)
            .replace(/\}\s*$/, expr + '}\n');
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', '#include <common>\nvarying vec3 vBakeLight;\n')
            .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n    reflectedLight.directDiffuse += vBakeLight * material.diffuseColor;\n');
    };
    mat.customProgramCacheKey = function () {
        const base = (typeof prevKey === 'function') ? prevKey.call(this) : '';
        return 'lightBake:' + lightBake.channelSet + '|' + base;
    };
    const zero = [0, 0, 0, 0];
    mat.defaultAttributeValues = Object.assign({}, mat.defaultAttributeValues || {}, { bakeG: zero, bakeL: zero, bakeF: zero, bakeD: zero });
    mat.needsUpdate = true;
}

function _lbApply(meshes, outputs, set) {
    const setChanged = lightBake.channelSet !== set;
    meshes.forEach((m, mi) => {
        const g = m.geometry;
        for (const ch of LB_CHANNELS) {
            const name = 'bake' + ch;
            if (set.includes(ch) && outputs[ch]) g.setAttribute(name, new THREE.BufferAttribute(outputs[ch][mi], 4, true));
            else if (g.attributes[name]) g.deleteAttribute(name);
        }
    });
    lightBake.channelSet = set;
    meshes.forEach(m => (Array.isArray(m.material) ? m.material : [m.material]).forEach(mat => {
        if (!mat) return;
        const had = mat.userData.lightBakePatched;
        _lbPatchMaterial(mat);
        if (had && setChanged) mat.needsUpdate = true;
    }));
    lightBake.meshes = meshes;
    lightBake.modelGroup = (typeof importedModelGroup !== 'undefined') ? importedModelGroup : null;
    lightBake.appliedSig = lightBake.jobSig || '';
    lightBake.active = true;
    lightBake.busy = false;
    _lbRefreshRealtimeLights();
}

function _lbRefreshRealtimeLights() {
    // GLB ライト（点・スポット）の表示を焼き込みに合わせる（08-model-loading-and-lighting.js）
    if (typeof applyGlbLightIntensities === 'function') applyGlbLightIntensities();
}

function _lbDeactivate() {
    if (!lightBake.active) return;
    lightBake.active = false;
    lightBakeUniforms.uBakeScale.value.set(0, 0, 0, 0);
    _lbRefreshRealtimeLights();
}

// ════════════════════════════════════════════════════════════════
//  毎フレーム（描画の前）
// ════════════════════════════════════════════════════════════════
function _lbStartJob() {
    const job = { aborted: false, gen: null, hasResume: false, resumeValue: undefined, sig: lightBake.jobSig };
    job.gen = _lbJob(job);
    lightBake.job = job;
    lightBake.failed = false;
}
function _lbAbortJob() {
    const job = lightBake.job;
    if (!job) return;
    job.aborted = true;
    try { job.gen.return(); } catch (e) { /* ignore */ }
    lightBake.job = null;
    lightBake.waiting = false;
    lightBake.busy = false;
    _lbHud();
}

function _lbStepJob(budgetMs) {
    const job = lightBake.job;
    if (!job || lightBake.waiting) return;
    const t0 = performance.now();
    try {
        while (performance.now() - t0 < budgetMs) {
            let r;
            if (job.hasResume) { job.hasResume = false; r = job.gen.next(job.resumeValue); }
            else r = job.gen.next();
            if (r.done) { if (lightBake.job === job) lightBake.job = null; lightBake.busy = false; _lbHud(); break; }
            const v = r.value;
            if (v && typeof v.then === 'function') {
                lightBake.waiting = true;
                v.then((res) => { job.resumeValue = res; }, () => { job.resumeValue = null; })
                    .then(() => { job.hasResume = true; lightBake.waiting = false; });
                break;
            }
            if (v === 'frame') break;
        }
    } catch (e) {
        console.warn('[LightBake] 焼き込みに失敗しました:', e);
        lightBake.job = null;
        lightBake.busy = false;
        lightBake.failed = true;
        lightBake.appliedSig = lightBake.pendingSig;   // 同じ状態で何度も失敗しないように
        _lbDeactivate();
        _lbSetStatus('焼き込みできませんでした（今まで通りの照明で表示します）：' + (e && e.message ? e.message : e));
    }
}

function _lbUpdateScales() {
    const S = lightBakeUniforms.uBakeScale.value;
    if (!lightBakeActive()) { S.set(0, 0, 0, 0); return; }
    const glow = (typeof _alGlowFactor !== 'undefined') ? _alGlowFactor : 0;
    const lum = (typeof GLOW_PANEL_LUMINANCE !== 'undefined') ? GLOW_PANEL_LUMINANCE : 4.0;
    S.x = glow > 0.01 ? lum * glow : 0;
    const nf = (typeof lightingNightFactor !== 'undefined') ? lightingNightFactor : 0;
    const auto = (typeof glbLightAutoMode !== 'undefined') ? glbLightAutoMode : true;
    const factor = auto ? nf : 1;
    S.y = (auto && factor < 0.02) ? 0 : ((typeof glbLightMaster !== 'undefined' ? glbLightMaster : 1) * factor);
    let fr = 0;
    if (typeof funnelUplights !== 'undefined' && funnelUplights.length) {
        const fu = funnelUplights[0];
        fr = (fu.baseIntensity > 0 && fu.spotL) ? fu.spotL.intensity / fu.baseIntensity : 0;
    }
    S.z = fr > 0.002 ? fr : 0;
    S.w = nf > 0.02 ? nf * (typeof deckLightIntensityMult !== 'undefined' ? deckLightIntensityMult : 1) : 0;
}

function updateLightBake(t) {
    if (typeof renderer === 'undefined' || !renderer || typeof shipGroup === 'undefined' || !shipGroup) return;
    // 船が差し替えられたら、前の結果は使えない
    const mg = (typeof importedModelGroup !== 'undefined') ? importedModelGroup : null;
    if (lightBake.modelGroup && lightBake.modelGroup !== mg) {
        _lbAbortJob();
        _lbDeactivate();
        lightBake.modelGroup = null;
        lightBake.appliedSig = '';
        lightBake.channelSet = '';
        lightBake.subdivKey = '';
    }
    if (!lightBake.enabled) {
        if (lightBake.job) _lbAbortJob();
        _lbDeactivate();
        _lbUpdateScales();
        return;
    }
    if (lightBake.job) {
        _lbStepJob(12);
    } else if (mg && (t - lightBake.lastSigAt > LB_SIG_INTERVAL || lightBake.force)) {
        // 灯り・船の変更を調べる（変わってから LB_SETTLE_S 秒落ち着いたら焼き直す。
        // 焼き込み中に変わった分は、終わってから次の回で拾う）
        lightBake.lastSigAt = t;
        const meshes = _lbCollectMeshes();
        const sig = meshes.length ? _lbSignature(meshes) + ':' + mg.uuid : '';
        if (sig && (sig !== lightBake.appliedSig || lightBake.force)) {
            if (sig !== lightBake.pendingSig) { lightBake.pendingSig = sig; lightBake.pendingAt = t; }
            if ((t - lightBake.pendingAt >= LB_SETTLE_S || lightBake.force) && (!lightBake.failed || lightBake.force)) {
                lightBake.modelGroup = mg;
                lightBake.jobSig = sig;
                _lbStartJob();
            }
        }
    }
    _lbUpdateScales();
}
window.updateLightBake = updateLightBake;

// ════════════════════════════════════════════════════════════════
//  設定（軽量化タブ）
// ════════════════════════════════════════════════════════════════
function setLightBakeEnabled(on) {
    lightBake.enabled = !!on;
    lightBake.failed = false;
    _lbSaveSetting();
    if (!on) { _lbAbortJob(); _lbDeactivate(); _lbSetStatus('焼き込みを使っていません（リアルタイムの照明）'); }
    else { lightBake.appliedSig = ''; lightBake.pendingSig = ''; lightBake.lastSigAt = -1; _lbSetStatus('焼き込みを待っています…'); }
}
function setLightBakeDetail(v) {
    if (!LB_EDGE_M[v] || v === lightBake.detail) return;
    lightBake.detail = v;
    _lbSaveSetting();
    lightBake.failed = false;
    lightBake.lastSigAt = -1;
}
// 保存してある結果を使わずに、今すぐ焼き直す
function rebakeLights() {
    lightBake.failed = false;
    lightBake.force = true;
    lightBake.appliedSig = '';
    lightBake.lastSigAt = -1;
    if (lightBake.job) _lbAbortJob();
    _lbSetStatus('焼き直しを待っています…');
}
function clearLightBakeCache() {
    _lbCacheClear().then(() => _lbSetStatus('保存してある焼き込みを消しました'));
}
window.setLightBakeEnabled = setLightBakeEnabled;
window.setLightBakeDetail = setLightBakeDetail;
window.rebakeLights = rebakeLights;
window.clearLightBakeCache = clearLightBakeCache;

document.addEventListener('DOMContentLoaded', () => {
    const cb = document.getElementById('bake-enabled');
    if (cb) cb.checked = lightBake.enabled;
    const sel = document.getElementById('bake-detail');
    if (sel) sel.value = lightBake.detail;
    _lbSetStatus(lightBake.enabled ? '焼き込みを待っています…' : '焼き込みを使っていません（リアルタイムの照明）');
});
