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
const TR_FINE = { half: 2500, n: 501 };       // 作り込んだ港の中だけ：10m おき（ドック・岸壁の形が出る）
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
    const quayLen = p.quay || T.quay;      // 現実の港は岸壁の長さを決めてあることがある（ドックの中の岸壁など）
    const apron = { fishing: 45, town: 70, city: 130, cargo: 190, naval: 110, passenger: 190 }[p.type];
    const basin = T.basin;
    const loc = worldUnitToLocal(p.u);
    const br = p.seaBearing * Math.PI / 180;
    // s：海の方、l：岸沿い（s を右に90°）
    // 海の方の向き（物理の面では東が −x）
    // detail：作り込んだ港の地形の中（本物の岸壁・ドックがあるので、地形はほとんど手直ししない）
    const detail = !!(p.real && typeof _rwDetailOf === 'function' && _RW && _RW.hd && _rwDetailOf(p.lat, p.lon));
    return { id: p.id, type: p.type, real: !!p.real, detail, x: loc.x, z: loc.z, sx: -Math.sin(br), sz: Math.cos(br),
             quayLen, apron, basin, depth: T.depth, seed: p.seed, name: p.name, chLen: worldPortChannelLen(p) };
}
// 桟橋の並び（港の座標：b＝岸沿い）。軍港は桟橋を岸壁の片側に寄せ、残りを大きな船が横付けできる岸壁にする
//（50-harbor-auto.js の着岸の計画もこれを使う）。free：横付けに使える岸壁の区間 [b0, b1]、
// keepOut：桟橋と横に付いている軍艦が占める b の範囲（桟橋の長さ len まで）
function _portPierLayout(type, quayLen) {
    const half = quayLen / 2;
    if (type === 'naval') {
        const len = 260, w = 22;
        const piers = [{ b: -half + 70, w, len }, { b: -half + 230, w, len }];
        const edge = piers[1].b + w / 2 + 3 + 19;                  // 横の軍艦（幅 19m まで）の外側
        return { piers, len, free: [edge + 25, half - 10], keepOut: [-half, edge] };
    }
    if (type === 'fishing') {
        const piers = [];
        for (let i = 0; i < 2; i++) piers.push({ b: -half + (i + 1) * quayLen / 3, w: 6, len: 60 });
        return { piers, len: 60, free: null, keepOut: null };
    }
    return { piers: [], len: 0, free: [-half, half], keepOut: null };
}
window._portPierLayout = _portPierLayout;
// 高さに港の手直しを加える（ワーカーと同じ式。関数の中身を文字列にしてワーカーへ渡す）
function _portAdjust(h, x, z, shapes) {
    for (let i = 0; i < shapes.length; i++) {
        const S = shapes[i];
        const dx = x - S.x, dz = z - S.z;
        const a = dx * S.sx + dz * S.sz;            // 海の方への距離（岸＝0）
        const b = dx * S.sz - dz * S.sx;            // 岸沿いの距離
        const half = S.quayLen / 2;
        // 作り込んだ港：岸壁の後ろの陸を平らにし、前の水面を掘るだけ（陸は削らない・沖への航路は掘らない）
        if (S.detail) {
            // 地形に合わせる：陸は削らず・平らにもしない（本物の岸の線のまま）。岸壁の前の、もともと水
            // （か干潟ほどの低い所）だけを、船が付けられる深さに掘る。船を寄せる位置は本物の岸の線から測る
            //（50-harbor-auto.js の harborBerthPlan）
            if (a > -10 && a < 45 && Math.abs(b) < half && h < 0.3) { h = Math.min(h, -S.depth - 2); continue; }   // 陸（低い岸壁も）は掘らない：掘ると岸の線がでこぼこになり、クレーンが水の上に立った
            if (a > 0 && a < Math.min(S.basin, 450) && Math.abs(b) < half + 40 && h < -0.5) {
                const want = -S.depth - 2, k = Math.min(1, (half + 40 - Math.abs(b)) / 40) * Math.min(1, (Math.min(S.basin, 450) - a) / 150);
                if (h > want) h = h + (want - h) * k;
            }
            continue;
        }
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
        ${worldWorkerSource()}
        ${_wNoise3.toString()}
        ${worldNoiseE.toString()}
        ${worldHeightFromE.toString()}
        ${worldShoal.toString()}
        ${worldHeightAt.toString()}
        ${_portAdjust.toString()}
        onmessage = (ev) => {
            if (_rwHook(ev)) return;
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
    worldWorkerSync(terrain.worker);
    terrain.worker.onmessage = (ev) => _trOnHeights(ev.data);
    return terrain.worker;
}

// 海は海底も網にする（この深さ[m]まで。波の谷や水中から海底が見え、座礁した船が海底に載って見える。
// 潜水艦で潜っても海底が見えるように 100m まで）
const TR_SEABED = -100;
// ── 地面の材質：海底の網より深い所は描かない ──
let _trMat = null;
function _trMaterial() {
    if (_trMat) return _trMat;
    _trMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
    _trMat.onBeforeCompile = (sh) => {
        sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying float vTrY;')
            .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n    vTrY = (modelMatrix * vec4(transformed, 1.0)).y;');
        sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vTrY;')
            .replace('void main() {', 'void main() {\n    if (vTrY < ' + TR_SEABED.toFixed(1) + ') discard;');
    };
    _trMat.customProgramCacheKey = () => 'worldTerrain';
    noShipLightProbe(_trMat);
    return _trMat;
}
// 港のそばの細かい網の材質：重なる所では手前に描く（粗い網と同じ高さの陸で、ちらつかないように）
let _trMatFine = null;
function _trMaterialFine() {
    if (_trMatFine) return _trMatFine;
    _trMatFine = _trMaterial().clone();
    _trMatFine.onBeforeCompile = _trMaterial().onBeforeCompile;
    _trMatFine.customProgramCacheKey = () => 'worldTerrain';
    _trMatFine.userData = {}; noShipLightProbe(_trMatFine);
    _trMatFine.polygonOffset = true; _trMatFine.polygonOffsetFactor = -2; _trMatFine.polygonOffsetUnits = -4;
    return _trMatFine;
}
// 高さ・傾き → 色
function _trColor(h, slope, x, z, out, o) {
    let r, g, b;
    if (h < -0.5) {
        // 浅い海の海底（TR_SEABED まで網を作る）：急な所は岩、ほかは砂・泥（深いほど暗く）
        const mott = (Math.sin(x * 0.013 + z * 0.007) * Math.sin(x * 0.005 - z * 0.011) + 1) * 0.5, k = 1 - Math.min(0.55, -h / 60);
        if (slope > 0.12 || mott > 0.8) { r = 0.40 * k; g = 0.39 * k; b = 0.35 * k; }
        else { r = (0.66 - 0.1 * mott) * k; g = (0.61 - 0.08 * mott) * k; b = (0.46 - 0.05 * mott) * k; }
    }
    else if (h < 1.2) { if (_RW) { r = 0.52; g = 0.55; b = 0.40; } else { r = 0.78; g = 0.72; b = 0.54; } }   // 砂浜（現実世界は干潟・湿地の色）
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
// その点のまわり（r 点）に水（高さ 0.5m 未満）があるか
function _trNearWater(H, n, i, j, r) {
    for (let b = -r; b <= r; b++) { const jj = j + b; if (jj < 0 || jj >= n) continue; for (let a = -r; a <= r; a++) { const ii = i + a; if (ii >= 0 && ii < n && H[jj * n + ii] < 0.5) return true; } }
    return false;
}
// ── 岸の線をなめらかに ──
// 格子のままだと、陸と水の境目（岸・岸壁・桟橋の縁）が升目の階段のギザギザになる。
// 境目を格子の辺の上で拾ってつなぎ（マーチング・スクエア。陸を左に見る向き）、小さな段を省いた
// 折れ線にして（岸壁はまっすぐな線になる）、線の「反対側」にはみ出している点だけを線の上へ横に寄せる
//（陸の点が水の側に出ていれば引っ込め、水の点が陸の側に入っていれば押し出す）。
// 陸と水の点が同じ線に乗るので、岸壁は垂直な壁になる。線の内側の点は動かさないので、細い桟橋も潰れない。
// 見た目だけ（座礁・水深の判定は元の高さのまま）
function _trSmoothCoast(H, n, P, step) {
    const N = n * n, isW = (k) => H[k] < 0.5;
    const nx = new Int32Array(2 * N).fill(-1), pv = new Int32Array(2 * N).fill(-1);
    const ex = new Float32Array(2 * N), ez = new Float32Array(2 * N);
    // 辺 e の上の境目の点（e＝2k：k と右隣、e＝2k+1：k と下隣）
    const edgePt = (e) => {
        const k = e >> 1, k2 = (e & 1) ? k + n : k + 1;
        let t = (0.5 - H[k]) / ((H[k2] - H[k]) || 1e-6);
        t = t < 0.2 ? 0.2 : t > 0.8 ? 0.8 : t;
        ex[e] = P[k * 3] + (P[k2 * 3] - P[k * 3]) * t; ez[e] = P[k * 3 + 2] + (P[k2 * 3 + 2] - P[k * 3 + 2]) * t;
        return e;
    };
    const landEnd = (e) => { const k = e >> 1, k2 = (e & 1) ? k + n : k + 1; return isW(k) ? k2 : k; };
    // e1→e2 を、陸が左になる向きでつなぐ
    const link = (e1, e2) => {
        const L = landEnd(e1);
        const s = (ex[e2] - ex[e1]) * (P[L * 3 + 2] - ez[e1]) - (ez[e2] - ez[e1]) * (P[L * 3] - ex[e1]);
        if (s < 0) { const t = e1; e1 = e2; e2 = t; }
        if (nx[e1] < 0 && pv[e2] < 0) { nx[e1] = e2; pv[e2] = e1; }
    };
    let any = false;
    for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
        const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
        const wa = isW(a), wb = isW(b), wc = isW(c), wd = isW(d);
        if (wa === wb && wa === wc && wa === wd) continue;
        any = true;
        const E = [];
        if (wa !== wb) E.push(edgePt(2 * a));          // 上
        if (wb !== wd) E.push(edgePt(2 * b + 1));      // 右
        if (wc !== wd) E.push(edgePt(2 * c));          // 下
        if (wa !== wc) E.push(edgePt(2 * a + 1));      // 左
        if (E.length === 2) link(E[0], E[1]);
        else if (E.length === 4) {
            // 鞍点：真ん中が a と同じなら、b と c の角を切り取る線に
            const mid = (H[a] + H[b] + H[c] + H[d]) / 4 < 0.5;
            if (mid === wa) { link(E[0], E[1]); link(E[2], E[3]); }
            else { link(E[0], E[3]); link(E[1], E[2]); }
        }
    }
    if (!any) return null;
    // 鎖にして、小さな段を省く（Douglas-Peucker）
    const tol = step * 0.9, seen = new Uint8Array(2 * N), segs = [], lines = [];
    const simplify = (C) => {
        const m = C.length / 2;
        if (m < 2) return;
        const keep = new Uint8Array(m); keep[0] = keep[m - 1] = 1;
        const st = [0, m - 1];
        while (st.length) {
            const b = st.pop(), a = st.pop();
            const ax = C[a * 2], az = C[a * 2 + 1], dx = C[b * 2] - ax, dz = C[b * 2 + 1] - az, L = Math.hypot(dx, dz) || 1e-6;
            let best = -1, bd = tol;
            for (let q = a + 1; q < b; q++) {
                const dd = Math.abs((C[q * 2] - ax) * dz - (C[q * 2 + 1] - az) * dx) / L;
                if (dd > bd) { bd = dd; best = q; }
            }
            if (best >= 0) { keep[best] = 1; st.push(a, best, best, b); }
        }
        let px = null, pz = null;
        const line = [];
        for (let q = 0; q < m; q++) if (keep[q]) {
            if (px !== null) segs.push(px, pz, C[q * 2], C[q * 2 + 1]);
            px = C[q * 2]; pz = C[q * 2 + 1]; line.push(px, pz);
        }
        lines.push(line);
    };
    const walk = (e0) => {
        const C = [];
        let e = e0;
        while (e >= 0 && !seen[e]) { seen[e] = 1; C.push(ex[e], ez[e]); e = nx[e]; }
        if (e === e0) C.push(ex[e0], ez[e0]);        // 輪
        // 輪は 2 つに分けて省く（始めと終わりが同じ点だと線の向きが決まらない）
        if (e === e0 && C.length > 8) { const h = (C.length / 4 | 0) * 2; simplify(C.slice(0, h + 2)); simplify(C.slice(h)); }
        else simplify(C);
    };
    for (let e = 0; e < 2 * N; e++) if (nx[e] >= 0 && pv[e] < 0 && !seen[e]) walk(e);    // 端のある鎖
    for (let e = 0; e < 2 * N; e++) if (nx[e] >= 0 && !seen[e]) walk(e);                  // 輪
    if (!segs.length) return null;
    // 線分の索引（2 升ごとの区画）
    const cs = step * 2, x0 = P[0], z0 = P[2], gw = Math.ceil((n * step) / cs) + 2;
    const grid = new Map();
    const S = segs.length / 4;
    for (let s = 0; s < S; s++) {
        const x1 = segs[s * 4], z1 = segs[s * 4 + 1], x2 = segs[s * 4 + 2], z2 = segs[s * 4 + 3];
        const ia = Math.floor((Math.min(x1, x2) - x0) / cs), ib = Math.floor((Math.max(x1, x2) - x0) / cs);
        const ja = Math.floor((Math.min(z1, z2) - z0) / cs), jb = Math.floor((Math.max(z1, z2) - z0) / cs);
        for (let jj = ja; jj <= jb; jj++) for (let ii = ia; ii <= ib; ii++) {
            const key = jj * gw + ii; let A = grid.get(key); if (!A) grid.set(key, A = []); A.push(s);
        }
    }
    // 境目の近くの点を、線の反対側にはみ出していれば線の上へ
    const R = step * 1.6;
    for (let j = 1; j < n - 1; j++) for (let i = 1; i < n - 1; i++) {
        const k = j * n + i, w = isW(k);
        let edge = false;
        for (let b = -1; b <= 1 && !edge; b++) for (let a = -1; a <= 1; a++) if (isW(k + b * n + a) !== w) { edge = true; break; }
        if (!edge) continue;
        const vx = P[k * 3], vz = P[k * 3 + 2];
        const gi = Math.floor((vx - x0) / cs), gj = Math.floor((vz - z0) / cs);
        let bd = R, bx = 0, bz = 0, bs = 0;
        for (let jj = gj - 1; jj <= gj + 1; jj++) for (let ii = gi - 1; ii <= gi + 1; ii++) {
            const A = grid.get(jj * gw + ii);
            if (A) for (const s of A) {
                const x1 = segs[s * 4], z1 = segs[s * 4 + 1], dx = segs[s * 4 + 2] - x1, dz = segs[s * 4 + 3] - z1;
                const L2 = dx * dx + dz * dz || 1e-9;
                let u = ((vx - x1) * dx + (vz - z1) * dz) / L2; u = u < 0 ? 0 : u > 1 ? 1 : u;
                const qx = x1 + dx * u, qz = z1 + dz * u, dd = Math.hypot(vx - qx, vz - qz);
                if (dd < bd) { bd = dd; bx = qx; bz = qz; bs = dx * (vz - z1) - dz * (vx - x1); }
            }
        }
        if (bd >= R) continue;
        // 陸は左（bs > 0）。陸の点が右（水の側）、水の点が左（陸の側）にあれば寄せる。
        // 陸の点が線のすぐ内側（2m 以内）なら線の上へ（そこから水へ下る斜面が線の外へ出ないように）
        if ((!w && (bs < 0 || bd < 2)) || (w && bs > 0)) { P[k * 3] = bx; P[k * 3 + 2] = bz; }
    }
    return lines;
}
// 岸壁・桟橋の縁：なめらかにした岸の線に沿って、垂直な壁と、縁の舗装の帯（陸の側へ 12m）を置く。
// 格子の網の斜面（升目の分だけ内側に下がっている所）を上から覆い、縁をまっすぐに見せる。
// 陸がしっかり高く（0.6m 以上）、すぐ外が深い（-1.5m より深い）所だけ（砂浜・自然の岸には置かない）
function _trQuayWalls(lines, H, n, step, cx, cz, detail) {
    const x0 = cx - (n - 1) * step / 2, z0 = cz - (n - 1) * step / 2;
    const hAt = (x, z) => {
        let fi = (x - x0) / step, fj = (z - z0) / step;
        if (!(fi >= 0 && fj >= 0 && fi < n - 1 && fj < n - 1)) return NaN;
        const i = fi | 0, j = fj | 0, u = fi - i, v = fj - j, k = j * n + i;
        return (H[k] * (1 - u) + H[k + 1] * u) * (1 - v) + (H[k + n] * (1 - u) + H[k + n + 1] * u) * v;
    };
    const drop = (x, z) => ((x - cx) * (x - cx) + (z - cz) * (z - cz)) / (2 * WORLD_R);
    const W = 12, BOT = -8;
    const pos = [], col = [];
    const C_WALL_TOP = [0.47, 0.45, 0.41], C_WALL_BOT = [0.20, 0.21, 0.19];
    const deckCol = (x, z) => {
        if (detail) {
            const ll = worldUnitToLatLon(worldLocalToUnit(x, z)), kd = _rwDetailKindAt(detail, ll.lat, ll.lon);
            if (kd === 4) return [0.52, 0.52, 0.50];
            if (kd === 3) return [0.60, 0.58, 0.54];
        }
        return [0.55, 0.54, 0.50];
    };
    const sq = (c) => [c[0] * c[0], c[1] * c[1], c[2] * c[2]];
    // 三角形（表が want の向きになるよう並びを直す）
    const tri = (a, b, c, ca, cb, cc, want) => {
        const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        if (nx * want[0] + ny * want[1] + nz * want[2] < 0) { const t = b; b = c; c = t; const tc = cb; cb = cc; cc = tc; }
        pos.push(...a, ...b, ...c); col.push(...ca, ...cb, ...cc);
    };
    const UP = [0, 1, 0];
    for (const L of lines) {
        const m = L.length / 2;
        if (m < 2) continue;
        // 線の点ごとの、陸の側の向き（前後の線分の左の法線の平均）と岸壁の上の高さ
        const segN = [];
        for (let q = 0; q < m - 1; q++) {
            const dx = L[q * 2 + 2] - L[q * 2], dz = L[q * 2 + 3] - L[q * 2 + 1], l = Math.hypot(dx, dz) || 1e-6;
            segN.push([-dz / l, dx / l, l]);
        }
        for (let q = 0; q < m - 1; q++) {
            const [nx, nz, len] = segN[q];
            if (len < 0.5) continue;
            const ax = L[q * 2], az = L[q * 2 + 1], bx = L[q * 2 + 2], bz = L[q * 2 + 3];
            const mx = (ax + bx) / 2, mz = (az + bz) / 2;
            const hin = Math.max(hAt(mx + nx * 4, mz + nz * 4), hAt(mx + nx * 8, mz + nz * 8));
            const hout = Math.min(hAt(mx - nx * 5, mz - nz * 5), hAt(mx - nx * 9, mz - nz * 9));
            if (!(hin > 0.6 && hout < -1.5)) continue;
            // 岸壁の上の高さ：線から陸の側 4〜20m の、いちばん高い所（格子の点の間は線の近くで低く出るので）
            const topAt = (x, z) => {
                let t = -Infinity;
                for (let d = 4; d <= 20; d += 4) { const v = hAt(x + nx * d, z + nz * d); if (v > t) t = v; }
                return (Number.isFinite(t) ? Math.min(8, Math.max(0.8, t)) : hin) + 0.1;
            };
            const ta = topAt(ax, az), tb = topAt(bx, bz);
            const A1 = [ax, ta - drop(ax, az), az], B1 = [bx, tb - drop(bx, bz), bz];
            const A0 = [ax, BOT, az], B0 = [bx, BOT, bz];
            const ct = sq(C_WALL_TOP), cb = sq(C_WALL_BOT);
            // 壁（水の側を向く）
            const OUT = [-nx, 0, -nz];
            tri(A1, A0, B1, ct, cb, ct, OUT); tri(B1, A0, B0, ct, cb, cb, OUT);
            // 縁の舗装（陸の側へ W）
            const A2 = [ax + nx * W, ta - drop(ax + nx * W, az + nz * W), az + nz * W], B2 = [bx + nx * W, tb - drop(bx + nx * W, bz + nz * W), bz + nz * W];
            const cd = sq(deckCol(mx + nx * 5, mz + nz * 5));
            tri(A1, B1, A2, cd, cd, cd, UP); tri(B1, B2, A2, cd, cd, cd, UP);
            // 次の線分との角（出っ張った角）のすき間を埋める
            if (q + 1 < m - 1) {
                const [nx2, nz2] = segN[q + 1];
                if (nx * nz2 - nz * nx2 < 0) {      // 右へ曲がる（陸の側が外へ広がる角）
                    const C2 = [bx + nx2 * W, tb - drop(bx + nx2 * W, bz + nz2 * W), bz + nz2 * W];
                    tri(B1, C2, B2, cd, cd, cd, UP);
                }
            }
        }
    }
    if (!pos.length) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    // 細かい網（地形）より手前に描く（同じ高さの陸と重なっても、縁の舗装が勝つように）
    if (!_trQuayWalls.mat) {
        const m = _trMaterialFine().clone();
        m.onBeforeCompile = _trMaterial().onBeforeCompile; m.customProgramCacheKey = () => 'worldTerrain';
        m.userData = {}; noShipLightProbe(m);
        m.polygonOffset = true; m.polygonOffsetFactor = -4; m.polygonOffsetUnits = -8;
        _trQuayWalls.mat = m;
    }
    const mesh = new THREE.Mesh(geo, _trQuayWalls.mat);
    mesh.receiveShadow = true; mesh.userData.noLightBake = true;
    return mesh;
}
function _trBuildMesh(H, n, half, cx, cz, lowerInside, opts) {
    const geo = new THREE.BufferGeometry();
    const P = new Float32Array(n * n * 3), Cc = new Float32Array(n * n * 3);
    const step = half * 2 / (n - 1);
    for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
            const k = j * n + i;
            const x = cx - half + i * step, z = cz - half + j * step;
            let h = H[k];
            // 粗い格子の、細かい格子と重なる所は沈めて隠す（waterOnly：細かい網は水の近くだけなので、水の近くの点だけ）
            if (lowerInside && Math.abs(x - lowerInside.cx) < lowerInside.half - step && Math.abs(z - lowerInside.cz) < lowerInside.half - step
                && (!lowerInside.waterOnly || _trNearWater(H, n, i, j, 1))) h = Math.min(h - 25, -30);   // 細かい網の海底より下へ
            // 惑星の丸み：中心から離れるほど下がる
            const d2 = (x - cx) * (x - cx) + (z - cz) * (z - cz);
            P[k * 3] = x; P[k * 3 + 1] = h - d2 / (2 * WORLD_R); P[k * 3 + 2] = z;
            const hx = H[j * n + Math.min(n - 1, i + 1)] - H[j * n + Math.max(0, i - 1)];
            const hz = H[Math.min(n - 1, j + 1) * n + i] - H[Math.max(0, j - 1) * n + i];
            _trColor(h, Math.hypot(hx, hz) / (2 * step), x, z, Cc, k * 3);
            // 作り込んだ港の細かい網：港の敷地はアスファルト、桟橋はコンクリートの色
            if (opts && opts.detail && h > 0.3) {
                const ll = worldUnitToLatLon(worldLocalToUnit(x, z)), kd = _rwDetailKindAt(opts.detail, ll.lat, ll.lon);
                if (kd === 4) { Cc[k * 3] = 0.52 * 0.52; Cc[k * 3 + 1] = 0.52 * 0.52; Cc[k * 3 + 2] = 0.50 * 0.50; }
                else if (kd === 3) { Cc[k * 3] = 0.60 * 0.60; Cc[k * 3 + 1] = 0.58 * 0.58; Cc[k * 3 + 2] = 0.54 * 0.54; }
            }
        }
    }
    // 岸・岸壁・桟橋の縁のギザギザをなめらかに（細かい網と、近くの網）
    const coastLines = (opts && opts.smoothCoast) ? _trSmoothCoast(H, n, P, step) : null;
    // 陸を含むマスだけ三角形にする（水面下だけのマスは作らない）。
    // coastOnly（港のそばの細かい網）：水から coastOnly 升以内のマスだけ（内陸は粗い網にまかせて軽く）
    let nearW = null;
    if (opts && opts.coastOnly) {
        nearW = new Uint8Array(n * n);
        const r = opts.coastOnly;
        for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
            if (!(H[j * n + i] < 0.5)) continue;
            for (let b = -r; b <= r; b++) { const jj = j + b; if (jj < 0 || jj >= n) continue; for (let a = -r; a <= r; a++) { const ii = i + a; if (ii >= 0 && ii < n) nearW[jj * n + ii] = 1; } }
        }
    }
    const idx = [];
    for (let j = 0; j < n - 1; j++) {
        for (let i = 0; i < n - 1; i++) {
            const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
            if (Math.max(P[a * 3 + 1], P[b * 3 + 1], P[c * 3 + 1], P[d * 3 + 1]) < TR_SEABED) continue;
            if (nearW && !(nearW[a] || nearW[b] || nearW[c] || nearW[d])) continue;
            idx.push(a, c, b, b, c, d);
        }
    }
    if (!idx.length) return null;
    geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(Cc, 3));
    geo.setIndex(n * n > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const m = new THREE.Mesh(geo, opts && opts.coastOnly ? _trMaterialFine() : _trMaterial());
    // 岸壁・桟橋の縁（細かい網だけ）
    if (coastLines && opts.quayWalls) { const qw = _trQuayWalls(coastLines, H, n, step, cx, cz, opts.detail); if (qw) m.add(qw); }
    m.receiveShadow = true;
    m.castShadow = false;
    m.userData.noLightBake = true; m.userData.noBloom = true;      // 地面は光らない（ブルームに入れない）
    if (m.children[0]) m.children[0].userData.noBloom = true;
    if (typeof bloomTargetsDirty === 'function') bloomTargetsDirty();
    return m;
}

function _trDispose(m) {
    if (!m) return;
    if (m.parent) m.parent.remove(m);
    m.geometry.dispose();
    for (const c of m.children) if (c.geometry) c.geometry.dispose();
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

// 船のまわり（細かい網の広さ＋少し）が、作り込んだ港にかかるか
function _trNearDetail(cx, cz) {
    if (!_RW || !_RW.hd) return false;
    const u = worldLocalToUnit(cx, cz), ll = worldUnitToLatLon(u);
    const m = TR_FINE.half + 1500, dLat = m / WORLD_R * 57.29577951308232, dLon = dLat / Math.max(0.1, Math.cos(ll.lat / 57.29577951308232));
    return _RW.hd.some(d => ll.lat > d.lat0 - dLat && ll.lat < d.lat1 + dLat && ll.lon > d.lon0 - dLon && ll.lon < d.lon1 + dLon);
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
        _trDispose(terrain.near); _trDispose(terrain.far); _trDispose(terrain.fine);
        terrain.near = terrain.far = terrain.fine = null;
        return;
    }
    const F = worldFrame();
    const frame = { C: F.C, E: F.E, N: F.N };
    const shapes = _trNearbyShapes(cx, cz, TR_NEAR.half + 2000);
    const id = ++terrain.reqId;
    terrain.pending = true;
    const w = _trWorker();
    // 作り込んだ港のそばなら、船のまわりをもっと細かく
    terrain.fineOn = _trNearDetail(cx, cz);
    if (terrain.fineOn) w.postMessage({ id, which: 'fine', frame, n: TR_FINE.n, half: TR_FINE.half, cx, cz, oct: WORLD_OCT_FULL, shapes });
    else { _trDispose(terrain.fine); terrain.fine = null; }
    w.postMessage({ id, which: 'near', frame, n: TR_NEAR.n, half: TR_NEAR.half, cx, cz, oct: WORLD_OCT_FULL, shapes });
    w.postMessage({ id, which: 'far', frame, n: TR_FAR.n, half: TR_FAR.half, cx, cz, oct: 15, shapes: [] });
}
function _trOnHeights(msg) {
    if (msg.id !== terrain.reqId || world.mode !== 'world' || !terrain.center) return;
    const { x: cx, z: cz } = terrain.center;
    if (msg.which === 'near') {
        terrain.nearH = { H: msg.H, n: TR_NEAR.n, half: TR_NEAR.half, cx, cz };
        _brkBuild(terrain.nearH);
        _trSeabedTex(terrain.nearH);
        _trDispose(terrain.near);
        terrain.near = _trBuildMesh(msg.H, TR_NEAR.n, TR_NEAR.half, cx, cz, terrain.fineOn ? { cx, cz, half: TR_FINE.half, waterOnly: true } : null, { smoothCoast: true });
        if (terrain.near) scene.add(terrain.near);
    } else if (msg.which === 'fine') {
        _trDispose(terrain.fine);
        const ll = worldUnitToLatLon(worldLocalToUnit(cx, cz));
        terrain.fine = _trBuildMesh(msg.H, TR_FINE.n, TR_FINE.half, cx, cz, null, { coastOnly: 10, smoothCoast: true, quayWalls: true, detail: _rwDetailOf(ll.lat, ll.lon) || (typeof _hdNearDetail === 'function' ? _hdNearDetail(cx, cz) : null) });
        if (terrain.fine) scene.add(terrain.fine);
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
        noShipLightProbe(m);
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
    // （作り込んだ港は、本物の岸壁の地形があるので、作り物の岸壁は置かない）
    if (!S.detail) addBox(concrete, -S.apron / 2 + 4, 0, -3, S.apron + 8, 12, S.quayLen);
    // （作り込んだ港は、本物の岸壁の地形で当たりが取れるので、作り物の岸壁の当たりは置かない。同じ岸沿いの
    //  別の埠頭の岸壁と少し向きがずれていると、となりの埠頭の船に食い込んでしまう）
    if (!S.detail) colliders.push([-S.apron - 20, 6, -half, half]);
    // 係船柱（ボラード）：岸壁の縁に 25m おき
    const bollards = [];
    for (let b = -half + 12; b <= half - 12 && !S.detail; b += 25) {
        const q = P(4.5, b);
        bollards.push({ x: q.x, y: 3.35, z: q.z, w: 0.7, h: 0.7, d: 0.7, rot });
    }
    // 防波堤（港の前を囲む。真ん中に出入り口）。現実世界の港は、実際の航路（曲がっている）から入るので作らない
    if (S.type !== 'cargo' && !S.real) {
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
    const PL = _portPierLayout(S.type, S.quayLen);
    const pierLen = PL.len;
    for (const pr of PL.piers) {
        const b = pr.b, w = pr.w;
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
    // 陸の建物（作り込んだ港は、本物の建物・クレーン（51-harbor-detail.js）があるので作らない：
    //  大きさの決まった作り物を重ねると、本物の岸壁や建物と大きさが合わず、縮尺がおかしく見えた）
    const nB = S.detail ? 0 : { fishing: 14, town: 40, city: 90, cargo: 18, naval: 16 }[S.type];
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
    if (S.type === 'cargo' && !S.detail) {
        const cols = [0xb3352a, 0x2e5d8a, 0x2f7d4a, 0xd98e2b, 0x777777, 0x5b3f8c];
        for (let row = 0; row < 8; row++) for (let k = 0; k < 16; k++) {
            if (r() < 0.2) continue;
            const a = -35 - row * 17, b = -half + 60 + k * ((S.quayLen - 120) / 16);
            const stack = 1 + Math.floor(r() * 4);
            for (let s = 0; s < stack; s++) addBox(containers, a, b, 3 + 1.3 + s * 2.6, 12.2, 2.6, 2.45 * 2, { color: cols[Math.floor(r() * cols.length)] });
        }
        for (let i = 0; i < 6; i++) {
            const b = -half + 90 + i * (S.quayLen - 180) / 5;
            // 脚4本（岸壁の上：海側の脚は縁から 3m 内側）・梁・海へ張り出すブーム
            for (const la of [-33, -3]) for (const lb of [-9, 9]) addBox(cranes, la, b + lb, 3 + 22, 1.6, 44, 1.6);
            addBox(cranes, -18, b, 3 + 45, 36, 3, 20);
            addBox(cranes, 10, b, 3 + 50, 80, 2.2, 3);
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
    if (typeof _hdClear === 'function') _hdClear();
    _trDispose(terrain.near); _trDispose(terrain.far); _trDispose(terrain.fine);
    terrain.near = terrain.far = terrain.fine = null;
    terrain.center = null;
    terrain.reqId++;
    for (const [, P] of terrain.ports) { scene.remove(P.group); P.group.traverse(o => { if (o.geometry) o.geometry.dispose(); }); }
    terrain.ports.clear();
    terrain.grounded = false;
    terrain.depth = null;
    terrain.nearH = null;
    _brkBuild(null);
    _trSeabedTex(null);
}

// モードが変わった・港へ移動した（43-world.js から）
function worldTerrainModeChanged(moved) {
    terrain.good = null; _trHullCache = null;
    if (typeof minimapReset === 'function') minimapReset();
    _trClearAll();
    if (world.mode === 'world') { worldBuildPorts(); terrain._dirty = true; }
}
window.worldTerrainModeChanged = worldTerrainModeChanged;

// ════════════════════════════════════════════════════════════════
//  遠くの水面（波の計算をする水面の外側）
// ════════════════════════════════════════════════════════════════
//  波の水面は船のまわり ±1.8km しかないので、その外に見える陸地が宙に浮いて見える。
//  そこで、波の水面の外側から陸地の範囲（±32km）まで、平らな水面を張る（波の計算はしない）。
//  色・空の映り込み・霧は近くの水面と同じ値（_waterUniforms）を使うので、昼夜・天気で一緒に変わる。
let _trFarWater = null;
function _trFarWaterMesh() {
    if (_trFarWater) return _trFarWater;
    const U = window._waterUniforms;
    if (!U) return null;
    // 遠くほど粗い格子の水面（波の水面の四角 ±1800m の少し内側から、±32km まで）。
    // 大きな三角形 1 枚で張ると、頂点ごとに計算する対数深度が三角形の内側で大きくずれて、
    // 波の水面との継ぎ目で前後が入れ替わる（細い黒い線が出る）。そのため距離に応じた細かさの格子にする
    const pos = [], idx = [];
    const addPatch = (x0, z0, x1, z1, cell) => {
        const nx = Math.max(1, Math.round((x1 - x0) / cell)), nz = Math.max(1, Math.round((z1 - z0) / cell)), base = pos.length / 3;
        for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) pos.push(x0 + (x1 - x0) * i / nx, 0, z0 + (z1 - z0) * j / nz);
        for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) { const a = base + j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1; idx.push(a, c, b, b, c, d); }
    };
    // 内側 r0〜外側 r1 の四角い輪（r0・r1 は cell の倍数。輪どうしは少し重ねる：同じ色なので重なっても見えない）
    const addRing = (r0, r1, cell) => {
        addPatch(-r1, -r1, r1, -r0, cell); addPatch(-r1, r0, r1, r1, cell);
        addPatch(-r1, -r0, -r0, r0, cell); addPatch(r0, -r0, r1, r0, cell);
    };
    addRing(1680, 4200, 120); addRing(3600, 12000, 600); addRing(10000, 32000, 2000);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
    const mat = new THREE.ShaderMaterial({
        uniforms: {
            deepColor: U.deepColor, shallowColor: U.shallowColor, sunDir: U.sunDir, sunColor: U.sunColor,
            waterFogColor: U.waterFogColor, waterFogDensity: U.waterFogDensity, uBloomDark: U.uBloomDark,
        },
        // 深度は地形・船・近くの水面と同じ対数深度（04-scene-and-water-init.js の水面と同じ式）にそろえる。
        // 通常の深度のままだと、遠くでは地形の海底（対数深度）のほうが手前と判定されて、水面を突き抜けて見える
        vertexShader: `
            #ifdef USE_LOGDEPTHBUF
                uniform float logDepthBufFC;
            #endif
            varying vec3 vW;
            void main() {
                vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz;
                gl_Position = projectionMatrix * viewMatrix * w;
                #ifdef USE_LOGDEPTHBUF
                    if (projectionMatrix[2][3] == -1.0) {
                        gl_Position.z = log2(max(1e-6, gl_Position.w + 1.0)) * logDepthBufFC - 1.0;
                        gl_Position.z *= gl_Position.w;
                    }
                #endif
            }`,
        fragmentShader: `
            uniform vec3 deepColor, shallowColor, sunDir, sunColor, waterFogColor;
            uniform float waterFogDensity, uBloomDark;
            varying vec3 vW;
            void main() {
                if (uBloomDark > 0.5) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
                vec3 viewDir = normalize(cameraPosition - vW);
                vec3 n = vec3(0.0, 1.0, 0.0);
                // 遠くは斜めに見るので、浅い海でも海底は透けない：普通の海の色（近くの水面の端も同じ色へ戻してある）
                vec3 base = mix(deepColor, shallowColor, 0.6);
                float fresnel = pow(1.0 - max(0.0, dot(n, viewDir)), 4.0);
                vec3 skyRefl = vec3(0.30, 0.52, 0.82);
                vec3 col = mix(base, skyRefl, 0.12 + fresnel * 0.5);
                vec3 halfDir = normalize(sunDir + viewDir);
                col += sunColor * pow(max(0.0, dot(n, halfDir)), 60.0) * 0.6;
                float fd = length(vW - cameraPosition) * waterFogDensity;
                col = mix(col, waterFogColor, clamp(1.0 - exp(-fd * fd), 0.0, 1.0));
                gl_FragColor = vec4(col, 1.0);
                // 近くの水面（04-scene-and-water-init.js）と同じ変換（これが無いと、遠くの海だけ暗い紺色になる）
                #include <tonemapping_fragment>
                #include <encodings_fragment>
            }`,
    });
    _trFarWater = new THREE.Mesh(geo, mat);
    _trFarWater.frustumCulled = false;
    _trFarWater.userData.noLightBake = true;
    _trFarWater.renderOrder = -1;
    return _trFarWater;
}
function _trFarWaterUpdate() {
    const show = world.mode === 'world' && !!(terrain.near || terrain.far);
    const m = show ? _trFarWaterMesh() : _trFarWater;
    if (!m) return;
    if (show && !m.parent) scene.add(m);
    if (!show && m.parent) m.parent.remove(m);
    m.visible = show;
    // 波の水面と同じ所（船について動く）。高さは波の水面の平均の高さ
    if (show && typeof waterMesh !== 'undefined' && waterMesh) m.position.set(waterMesh.position.x, waterMesh.position.y - 0.3, waterMesh.position.z);
}

// ════════════════════════════════════════════════════════════════
//  浅い海の海底を水面から見えるように（04-scene-and-water-init.js の水のシェーダーへ渡す）
// ════════════════════════════════════════════════════════════════
//  船のまわり（細かい格子と同じ ±7km）の海底の 色（rgb）と 深さ/200m（a）を 1 枚の絵にする。
//  砂地・岩場・海草の生えた所・泥を、深さと傾き、場所ごとのまだらで塗り分ける。
let _trSbTex = null;
function _trSeabedTex(G) {
    const U = window._waterUniforms;
    if (!U || !U.seabedTex) return;
    if (!G) { U.seabedRect.value.w = 0; return; }
    const { H, n, half, cx, cz } = G, step = half * 2 / (n - 1);
    const data = new Uint8Array(n * n * 4);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const k = j * n + i, h = H[k], o = k * 4;
        const d = Math.max(0, -h);
        const hx = H[j * n + Math.min(n - 1, i + 1)] - H[j * n + Math.max(0, i - 1)];
        const hz = H[Math.min(n - 1, j + 1) * n + i] - H[Math.max(0, j - 1) * n + i];
        const slope = Math.hypot(hx, hz) / (2 * step);
        const x = cx - half + i * step, z = cz - half + j * step;
        const mott = (Math.sin(x * 0.013 + z * 0.007) * Math.sin(x * 0.005 - z * 0.011) + 1) * 0.5;
        let r, g, b;
        if (slope > 0.12 || (d < 12 && mott > 0.72)) { r = 0.42; g = 0.40; b = 0.36; }         // 岩場
        else if (d > 8 && d < 30 && mott < 0.35) { r = 0.30; g = 0.42; b = 0.26; }             // 海草
        else if (d > 60) { r = 0.40; g = 0.42; b = 0.38; }                                    // 泥
        else { r = 0.80; g = 0.74; b = 0.56; }                                                 // 砂地
        const shade = 0.85 + 0.3 * mott;
        data[o] = Math.min(255, r * shade * 255); data[o + 1] = Math.min(255, g * shade * 255); data[o + 2] = Math.min(255, b * shade * 255);
        data[o + 3] = Math.min(255, Math.round(d / 200 * 255));
    }
    if (_trSbTex && (_trSbTex.image.width !== n)) { _trSbTex.dispose(); _trSbTex = null; }
    if (!_trSbTex) {
        _trSbTex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
        _trSbTex.minFilter = THREE.LinearFilter; _trSbTex.magFilter = THREE.LinearFilter;
        _trSbTex.wrapS = _trSbTex.wrapT = THREE.ClampToEdgeWrapping;
        _trSbTex.generateMipmaps = false;
    } else _trSbTex.image.data.set(data);
    _trSbTex.needsUpdate = true;
    U.seabedTex.value = _trSbTex;
    // 点 i の中心が格子の点に来るように、半升ずらす
    U.seabedRect.value.set(cx - half - step / 2, cz - half - step / 2, n * step, 1);
}

// ════════════════════════════════════════════════════════════════
//  浅瀬・岩礁の白波（水面の下の浅瀬は見えないので、波が砕ける白い泡で分かるように）
// ════════════════════════════════════════════════════════════════
const BRK_MAX = 2500;
const _brk = { pts: null, xz: null, base: null, phase: null, n: 0, lastT: -1 };
function _brkMaterial() {
    return new THREE.ShaderMaterial({
        uniforms: { uSize: { value: 26 }, uScale: { value: 400 } },
        vertexShader: `
            #ifdef USE_LOGDEPTHBUF
                uniform float logDepthBufFC;
            #endif
            attribute float aAlpha;
            varying float vA;
            uniform float uSize, uScale;
            void main() {
                vec4 mv = modelViewMatrix * vec4(position, 1.0);
                vA = aAlpha;
                gl_PointSize = aAlpha <= 0.001 ? 0.0 : min(160.0, uSize * uScale / max(1.0, -mv.z));
                gl_Position = projectionMatrix * mv;
                #ifdef USE_LOGDEPTHBUF
                    if (projectionMatrix[2][3] == -1.0) {         // 地形・水面と同じ対数深度
                        gl_Position.z = log2(max(1e-6, gl_Position.w + 1.0)) * logDepthBufFC - 1.0;
                        gl_Position.z *= gl_Position.w;
                    }
                #endif
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
    const rough = physics.waveRoughness || 0;
    const sea = Math.min(1.3, 0.35 + hs / 2.5) * THREE.MathUtils.smoothstep(rough, 0.15, 0.6);
    const cam = camera.position;
    const hasH = typeof getOceanHeight === 'function';
    _brk.pts.material.uniforms.uScale.value = (renderer.domElement.height || 800) / (2 * Math.tan(camera.fov * Math.PI / 360));
    for (let k = 0; k < _brk.n; k++) {
        const x = _brk.xz[k * 2], z = _brk.xz[k * 2 + 1];
        const d = Math.hypot(x - cam.x, z - cam.z);
        if (d > 5000) { A[k] = 0; continue; }
        const wy = hasH ? getOceanHeight(x, z, t) : 0;
        P[k * 3 + 1] = wy + 0.25;
        // 波の山が来たときだけ白く砕ける（以前は決まった周期で明滅し、いつも白く見えていた）。凪では出さない
        const crest = Math.max(0, Math.min(1, (wy / Math.max(0.3, rough) - 0.15) / 0.6));
        A[k] = _brk.base[k] * sea * crest * crest * Math.min(1, (5000 - d) / 1500);
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.aAlpha.needsUpdate = true;
}

// ════════════════════════════════════════════════════════════════
//  座礁
// ════════════════════════════════════════════════════════════════
// 物理の面の点の「底の高さ」：地形（港の手直し込み）と、岸壁・桟橋などの施設
// 岸壁・桟橋・防波堤・停泊中の船の中か（地形は見ない。速い）
function _trInCollider(x, z) {
    for (const [, P] of terrain.ports) {
        const S = P.shape;
        const dx = x - S.x, dz = z - S.z;
        const a = dx * S.sx + dz * S.sz, b = dx * S.sz - dz * S.sx;
        for (const c of P.colliders) if (a >= c[0] && a <= c[1] && b >= c[2] && b <= c[3]) return true;
    }
    return false;
}
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

// ── 港内・川の中の穏やかな波 ──
// 船のまわりの「吹送距離」（風上側へ、陸・防波堤に当たるまでの水の広がり）を 24 方向で測り、
// 狭いほど波を低く・波長を短くする（防波堤の内や川の中では、荒天でも細かい穏やかな波になる）。
// 2 秒ごとに測って、ゆっくり変える。返す amp：波高の倍率、width：波長の倍率、swell：うねりの倍率
const WAVE_FETCH_FULL = 6000;      // これだけ開けていれば外洋と同じ[m]
const _wvShelter = { t: -1e9, amp: 1, width: 1, swell: 1, tAmp: 1, tWidth: 1, tSwell: 1 };
function worldWaveShelter(t, dt) {
    const S = _wvShelter;
    if (!window.world || world.mode !== 'world' || typeof physics === 'undefined') { S.amp = S.width = S.swell = 1; return S; }
    if (!(t - S.t < 2) || t < S.t) {
        S.t = t;
        const x0 = physics.cgWorldX || 0, z0 = physics.cgWorldZ || 0;
        // 風上の向き（physics.windDir は風の吹いていく向き：煙は (sin, cos) へ流れる。03 / 12）
        const wr = (physics.windDir || 0) * Math.PI / 180, aUp = Math.atan2(-Math.sin(wr), -Math.cos(wr));
        let sumW = 0, sumF = 0, sumAll = 0, nAll = 0;
        for (let k = 0; k < 24; k++) {
            const a = k / 24 * Math.PI * 2, dx = Math.sin(a), dz = Math.cos(a);
            let d = 0;
            for (let r = 120; r <= WAVE_FETCH_FULL; r += r < 1500 ? 120 : 300) {
                if (worldSeabedAt(x0 + dx * r, z0 + dz * r) > -0.5) break;
                d = r;
            }
            if (d >= WAVE_FETCH_FULL - 300) d = WAVE_FETCH_FULL;
            // 風上ほど重く（風下の広がりは波を育てない）。うねりはどの向きからでも入る
            const up = Math.cos(a - aUp);
            const w = Math.max(0.05, up) ** 2;
            sumW += w; sumF += w * d; sumAll += d; nAll++;
        }
        const fWind = sumF / Math.max(1e-6, sumW) / WAVE_FETCH_FULL, fAll = sumAll / nAll / WAVE_FETCH_FULL;
        S.tAmp = Math.max(0.12, Math.pow(Math.min(1, fWind), 0.6));
        S.tWidth = 0.3 + 0.7 * Math.sqrt(Math.min(1, fWind));
        S.tSwell = Math.max(0.05, Math.pow(Math.min(1, fAll), 1.2));
    }
    const k = Math.min(1, (dt || 0) / 8);
    S.amp += (S.tAmp - S.amp) * k; S.width += (S.tWidth - S.width) * k; S.swell += (S.tSwell - S.swell) * k;
    return S;
}
window.worldWaveShelter = worldWaveShelter;

// 船体の当たりを見る点（船の中の座標[m]：a＝前後、s＝横（+x 側）、d＝その点の喫水）
//  前後 9 か所 × （キール・左右の舷）＋ 船首・船尾の先。舷は喫水の 7 割（丸い船底の分）で見る。
let _trHullCache = null;
function _trHullPoints() {
    const hp = window.hullProfile;
    const key = hp && hp.ready ? [hp.halfLen, physics.scale, physics.draftOverride || 0, Math.round(worldShipDraftLever() * 20), (typeof shipGroup !== 'undefined' && shipGroup) ? shipGroup.scale.y : 1].join(',') : 'none';
    if (_trHullCache && _trHullCache.key === key) return _trHullCache.pts;
    const sc = physics.scale || 1;
    const hl = (hp && hp.ready) ? hp.halfLen : 6;
    const pts = [];
    for (const k of [-0.93, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 0.93]) {
        const H = worldHullAt(k * hl);
        pts.push({ a: k * hl * sc, s: 0, d: H.d, k });
        // 舷は 0.4m 外（防舷材の分）で見る：船体そのものは岸壁の手前で止まる
        pts.push({ a: k * hl * sc, s: H.hw + 0.4, d: H.d * 0.7, k });
        pts.push({ a: k * hl * sc, s: -H.hw - 0.4, d: H.d * 0.7, k });
    }
    for (const k of [-1, 1]) pts.push({ a: k * (hl * sc + 0.4), s: 0, d: worldHullAt(k * hl * 0.98).d * 0.8, k, tip: true });
    // 岸壁の角などが点の間に入り込まないように、舷の線を 6m おきに（施設だけ見る）
    const dense = [];
    const L = hl * sc, n = Math.max(4, Math.ceil(2 * L / 6));
    for (let i = 0; i <= n; i++) {
        const a = -L + 2 * L * i / n, H = worldHullAt(a / sc);
        dense.push({ a, s: H.hw + 0.4 }, { a, s: -H.hw - 0.4 });
    }
    _trHullCache = { key, pts, dense };
    return pts;
}
// その姿勢（重心の位置 x,z と向き h）で、船体がどれだけ底・岸壁に入っているか（0 なら当たっていない）
function _trHullScore(x, z, h, off, out) {
    const r = h * Math.PI / 180, fx = Math.sin(r), fz = Math.cos(r), sx = Math.cos(r), sz = -Math.sin(r);
    const ox = x + fx * off.a + sx * off.s, oz = z + fz * off.a + sz * off.s;
    let score = 0, hard = 0;
    // 船底の深さは喫水（船体設定の喫水＋操作パネルのレバーの分：worldHullAt）で決め、
    // 波の動きだけを足す：船の下の海面の高さ（波で上下）と、縦揺れ・横揺れで前後・両舷が上下する分。
    // 波の山で船が持ち上がれば船底も上がり、座礁していても外れる
    const scl = physics.scale || 1;
    const M = shipGroup.matrixWorld.elements;
    const sea = Number.isFinite(window._physicsWaveY) ? Math.max(-6, Math.min(6, window._physicsWaveY)) : 0;
    for (const p of _trHullPoints()) {
        const px = ox + fx * p.a + sx * p.s, pz = oz + fz * p.a + sz * p.s;
        const b = worldSeabedAt(px, pz);
        // 縦揺れ・横揺れでこの点が上下する分（行列の y 行の、横・前後の成分）
        const lx = p.s / scl, lz = p.a / scl;
        // 潜水艦は潜っている分だけ深い（54-submarine.js：sub.applied＝深さ＋届かない波の分）
        const keelY = sea + M[1] * lx + M[9] * lz - p.d - ((window.sub && sub.applied) || 0);
        const c = b - keelY;                             // 正：底（岸壁）が船底より上
        if (c > 0) { score += Math.min(12, c); if (out) out.push(Object.assign({ c }, p)); }
        if (b > 0) hard++;                               // 岸壁・桟橋・陸（水面より上）の中
    }
    if (terrain.ports.size && _trHullCache) for (const p of _trHullCache.dense) {
        if (_trInCollider(ox + fx * p.a + sx * p.s, oz + fz * p.a + sz * p.s)) { hard++; score += 12; if (out) out.push(p); }
    }
    _trHullScore.hard = hard;
    return score;
}
// 今の船を、前後 dA[m]・横 dS[m]（＋＝左舷の方）・向き dH[度] だけ動かしたら、どれだけ乗り上げるか（座礁から抜け出す向きを探す）
function worldGroundTry(dA, dS, dH) {
    if (typeof shipGroup === 'undefined' || !shipGroup) return { score: 0, hard: 0 };
    const x0 = physics.cgWorldX || 0, z0 = physics.cgWorldZ || 0, h0 = physics.heading || 0, r0 = h0 * Math.PI / 180;
    const dx = shipGroup.position.x - x0, dz = shipGroup.position.z - z0;
    const off = { a: dx * Math.sin(r0) + dz * Math.cos(r0), s: dx * Math.cos(r0) - dz * Math.sin(r0) };
    const x = x0 + Math.sin(r0) * dA + Math.cos(r0) * dS, z = z0 + Math.cos(r0) * dA - Math.sin(r0) * dS;
    const score = _trHullScore(x, z, h0 + (dH || 0), off);
    return { score, hard: _trHullScore.hard };
}
window.worldGroundTry = worldGroundTry;
// 前の姿勢より悪くなったか（固い所に入る点が増えた、または深く乗り上げた）
function _trWorse(score, hard, good) { return hard > good.hard || score > good.score + 0.02; }
// 乗り上げたときの船の姿勢：海底に当たっている所（c：海底が船底より上に出ている高さ[m]）を持ち上げるように、
// 前後の傾き（縦）と横の傾きを、当たっている点の位置で最小二乗に合わせる。船は水にも支えられているので 6 割ほど。
// 描く姿勢にだけ足す（17-main-loop.js：physics.groundPitch / groundRoll）。離れたら数秒で戻す
function _trGroundAttitude(hits, dt) {
    const pts = _trHullPoints();
    let sa = 0, ss = 0, ca = 0, cs = 0;
    for (const p of pts) { sa += p.a * p.a; ss += p.s * p.s; }
    if (terrain.grounded) for (const p of hits) if (p.c > 0 && !p.dense) { ca += Math.min(8, p.c) * p.a; cs += Math.min(8, p.c) * p.s; }
    const lim = (v, m) => Math.max(-m, Math.min(m, v));
    // 船首（+a）が持ち上がる＝ピッチは負（17：Euler の x 回転は正で船首が下がる）。左舷（+s）が持ち上がる＝ロールは正
    const tp = terrain.grounded ? lim(-Math.atan(0.6 * ca / Math.max(1, sa)), 0.1) : 0;
    const tr = terrain.grounded ? lim(Math.atan(0.6 * cs / Math.max(1, ss)), 0.14) : 0;
    const k = Math.min(1, (dt || 0) / (terrain.grounded ? 2.5 : 4));
    physics.groundPitch = (physics.groundPitch || 0) + (tp - (physics.groundPitch || 0)) * k;
    physics.groundRoll = (physics.groundRoll || 0) + (tr - (physics.groundRoll || 0)) * k;
}
function _trCheckGrounding(t, dt) {
    const hp = window.hullProfile;
    if (typeof shipGroup === 'undefined' || !shipGroup) return;
    const x = physics.cgWorldX || 0, z = physics.cgWorldZ || 0, h = physics.heading || 0;
    // 重心と、模型の原点（船体の輪切りの基準）とのずれ（船の向きの座標で）
    const r0 = h * Math.PI / 180;
    const dx = shipGroup.position.x - x, dz = shipGroup.position.z - z;
    const off = { a: dx * Math.sin(r0) + dz * Math.cos(r0), s: dx * Math.cos(r0) - dz * Math.sin(r0) };
    // 深さの表示・浅い警告（ときどきでよい）
    if (t - terrain.lastCheck > 0.2) {
        terrain.lastCheck = t;
        terrain.depth = -worldSeabedAt(x, z);
        const fx = Math.sin(r0), fz = Math.cos(r0), HL = ((hp && hp.ready) ? hp.halfLen : 6) * (physics.scale || 1);
        const bowD = worldHullAt(((hp && hp.ready) ? hp.halfLen : 6) * 0.9).d, sternD = worldHullAt(-((hp && hp.ready) ? hp.halfLen : 6) * 0.9).d;
        terrain._bowWarn = worldSeabedAt(x + fx * HL * 0.9, z + fz * HL * 0.9) > -bowD - 3;
        terrain._sternWarn = worldSeabedAt(x - fx * HL * 0.9, z - fz * HL * 0.9) > -sternD - 3;
    }
    // 外洋のまん中（近くに陸も港も無い）では調べない
    if (!terrain.near && !terrain.ports.size && terrain.depth > worldShipDraft() + 80) { terrain.grounded = false; terrain.good = { x, z, h, score: 0, hard: 0 }; _trGroundAttitude([], dt); return; }
    const hits = [];
    const score = _trHullScore(x, z, h, off, hits), hard = _trHullScore.hard;
    const wasGrounded = terrain.grounded;
    // 前の位置（good）と、今の波・姿勢のまま比べる（波で船底が上下しただけで「深く入った」としない。
    // そうしないと、波のたびに動きを取り消されて、乗り上げた所から後進で抜けられない）
    let good = terrain.good;
    if (good && (score > 0.02 || hard > 0) && (good.x !== x || good.z !== z || good.h !== h)) {
        const so = _trHullScore(good.x, good.z, good.h, off), ho = _trHullScore.hard;
        good = { x: good.x, z: good.z, h: good.h, score: so, hard: ho };
    }
    if (good && _trWorse(score, hard, good)) {
        // 調べるとき用：どの点が何に当たったか（船の中の前後 a・横 s・その点の喫水 d）
        terrain._lastHits = hits.slice(0, 12).map(p => ({ a: Math.round(p.a), s: Math.round(p.s), d: +(p.d || 0).toFixed(1), tip: !!p.tip }));
        // 前より深く入った：動いた分を取り消す（向きだけ・位置だけ戻して済むならそれで）
        const cands = [{ x, z, h: good.h }, { x: good.x, z: good.z, h }, { x: good.x, z: good.z, h: good.h }];
        let pick = cands[2], pickS = good.score, pickH = good.hard;
        for (const c of cands) { const sc2 = _trHullScore(c.x, c.z, c.h, off), hd2 = _trHullScore.hard; if (!_trWorse(sc2, hd2, good)) { pick = c; pickS = sc2; pickH = hd2; break; } }
        const v = Math.abs(physics.speed || 0);
        if (pick.x !== x || pick.z !== z) {
            // 前後に進んで当たった：止まる（少し跳ね返る）
            if (v > 0.6 && typeof audioWaveImpact === 'function') audioWaveImpact(shipGroup.position.clone(), Math.min(2, 0.5 + v / 6), true);
            physics.speed = -(physics.speed || 0) * 0.05;
            if (typeof _tugShip !== 'undefined') _tugShip.vSway = 0;
        }
        if (pick.h !== h) { physics.turnRate = 0; if (typeof _tugShip !== 'undefined') _tugShip.yawRate = 0; }
        physics.cgWorldX = pick.x; physics.cgWorldZ = pick.z; physics.heading = pick.h;
        // 描く船もこのフレームのうちに戻す（1フレームでも岸壁に食い込んで見えないように）
        const dH = (pick.h - h) * Math.PI / 180;
        if (dH) {
            const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), dH);
            const rel = shipGroup.position.clone().sub(new THREE.Vector3(x, shipGroup.position.y, z)).applyQuaternion(q);
            shipGroup.position.set(x + rel.x, shipGroup.position.y, z + rel.z);
            shipGroup.quaternion.premultiply(q);
        }
        shipGroup.position.x += pick.x - x; shipGroup.position.z += pick.z - z;
        shipGroup.updateMatrixWorld();
        terrain.grounded = true;
        terrain.good = { x: pick.x, z: pick.z, h: pick.h, score: pickS, hard: pickH };
    } else {
        terrain.grounded = score > 0.02;
        terrain.good = { x, z, h, score, hard };
        // 乗り上げている間は船底がこすれて、ゆっくりにしか動けない
        if (terrain.grounded) physics.speed *= Math.exp(-dt * 0.8);
    }
    terrain.hullHits = hits.length;
    _trGroundAttitude(hits, dt);
    if (terrain.grounded && !wasGrounded && Math.abs(physics.speed || 0) > 0.6 && typeof audioWaveImpact === 'function') {
        audioWaveImpact(shipGroup.position.clone(), Math.min(2, 0.5 + Math.abs(physics.speed) / 6), true);
    }
}

// ════════════════════════════════════════════════════════════════
//  毎フレーム（17-main-loop.js から）
// ════════════════════════════════════════════════════════════════
function updateWorldTerrain(t, dt) {
    if (typeof updateHornEcho === 'function') updateHornEcho(t);   // 汽笛のこだま（45-horn-echo.js）
    if (world.mode !== 'world') {
        if (terrain.near || terrain.far || terrain.ports.size) _trClearAll();
        _trFarWaterUpdate();
        return;
    }
    _trFarWaterUpdate();
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
    if (typeof updateHarborDetail === 'function') updateHarborDetail(t, dt);   // 作り込んだ港の建物・標識（51-harbor-detail.js）
    _trCheckGrounding(t, dt);
}
window.updateWorldTerrain = updateWorldTerrain;
