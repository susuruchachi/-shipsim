// 43-world.js — 世界（球体の惑星）・港・世界地図・モード切替
//
// ════════════════════════════════════════════════════════════════
//  2つのモード
// ════════════════════════════════════════════════════════════════
//   ・ocean : 今まで通り、海だけの世界
//   ・world : 陸地や港のある惑星を航海する
//
// ════════════════════════════════════════════════════════════════
//  惑星
// ════════════════════════════════════════════════════════════════
//  表面積が地球の半分の球（半径 約4500km）。陸地の形は、決まった種（シード）から
//  作る3次元のノイズで決める。同じ種なら毎回同じ世界になる。
//    ・大陸：大きな波長のノイズを、別のノイズで少しゆがめて（ドメインワープ）作る。
//      陸地が全体の約3割になるよう、海面の高さを自動で決める
//    ・海岸線・島：細かい波長のノイズを重ねる。船のまわりでは 数十m の細かさまで
//      重ねるので、近づくほど入り江や岬・小島が現れる（地図は粗く、3Dは細かく）
//  高さ e（無次元）→ 陸は √e、海は √(-e) で標高・水深[m]にする。岸の近くは急に、
//  沖や内陸はゆるやかに変わる（大陸棚・海岸平野のように）。
//
//  座標：船の物理は平らな面（x＝東、z＝北、単位 m）の上で動く。world モードでは、
//  その原点が惑星のどこか（world.ref の緯度・経度）に接していると考え、
//    面の点 (x, z) → 球の点 = normalize(C + x/R·東 + z/R·北)   （C：原点の方向）
//  で惑星の上の位置に直す（原点のまわりの接平面への投影）。
//
// ════════════════════════════════════════════════════════════════
//  港
// ════════════════════════════════════════════════════════════════
//  海岸を探して、互いに離れた場所に港を置く。種類は
//    漁港（小）・港町・港湾都市（大）・貨物港・軍港
//  名前は音節を組み合わせて作る。港の正確な位置（海岸線）と、海の方の向きは、
//  細かい高さで調べ直して決める（44-world-terrain.js が岸壁や建物を建てる）。

const WORLD_R = 4504000;              // 惑星の半径[m]（表面積が地球の半分）
const WORLD_SEED = 20260927;
const WORLD_LAND_FRACTION = 0.31;     // 陸地の割合
const WORLD_OCT_MAP = 9;              // 地図に使う細かさ（ノイズを重ねる数）
const WORLD_OCT_FULL = 20;            // 船のまわりの細かさ（約35mの起伏まで）

const PORT_TYPES = {
    fishing: { label: '漁港',     suffix: '漁港', color: '#7ee39a', size: 1, depth: 8, basin: 260, pier: 70, quay: 170 },
    town:    { label: '港町',     suffix: '港',   color: '#ffe38a', size: 2, depth: 12, basin: 380, pier: 10, quay: 320 },
    city:    { label: '港湾都市', suffix: '港',   color: '#ffb36b', size: 3, depth: 18, basin: 640, pier: 10, quay: 720 },
    cargo:   { label: '貨物港',   suffix: '貨物港', color: '#8cc6ff', size: 3, depth: 18, basin: 760, pier: 10, quay: 1050 },
    naval:   { label: '軍港',     suffix: '軍港', color: '#ff7a7a', size: 2, depth: 16, basin: 620, pier: 270, quay: 640 },
};
window.PORT_TYPES = PORT_TYPES;

const world = {
    mode: 'ocean',                     // 'ocean' | 'world'
    ref: { lat: 0, lon: 0 },           // 物理の原点が接している緯度・経度[度]
    ports: null,                       // 港の一覧（初めて要るときに作る）
    seaLevel: 0,                       // 海面の高さ（ノイズの値）
    ready: false,
};
window.world = world;

// ── 乱数（種から決まる）──
function _wRng(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ── 3次元シンプレックスノイズ（Gustavson の方式）──
const _wPerm = new Uint8Array(512), _wPermMod12 = new Uint8Array(512);
(function () {
    const r = _wRng(WORLD_SEED);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
    for (let i = 0; i < 512; i++) { _wPerm[i] = p[i & 255]; _wPermMod12[i] = _wPerm[i] % 12; }
})();
const _wGrad3 = new Float32Array([1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1, 0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1]);
function _wNoise3(xin, yin, zin) {
    const F3 = 1 / 3, G3 = 1 / 6;
    const s = (xin + yin + zin) * F3;
    const i = Math.floor(xin + s), j = Math.floor(yin + s), k = Math.floor(zin + s);
    const t = (i + j + k) * G3;
    const x0 = xin - (i - t), y0 = yin - (j - t), z0 = zin - (k - t);
    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
        if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
        else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
        else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else {
        if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
        else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
        else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    }
    const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;
    const ii = i & 255, jj = j & 255, kk = k & 255;
    let n = 0, tt, g;
    tt = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    if (tt > 0) { g = _wPermMod12[ii + _wPerm[jj + _wPerm[kk]]] * 3; tt *= tt; n += tt * tt * (_wGrad3[g] * x0 + _wGrad3[g + 1] * y0 + _wGrad3[g + 2] * z0); }
    tt = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (tt > 0) { g = _wPermMod12[ii + i1 + _wPerm[jj + j1 + _wPerm[kk + k1]]] * 3; tt *= tt; n += tt * tt * (_wGrad3[g] * x1 + _wGrad3[g + 1] * y1 + _wGrad3[g + 2] * z1); }
    tt = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (tt > 0) { g = _wPermMod12[ii + i2 + _wPerm[jj + j2 + _wPerm[kk + k2]]] * 3; tt *= tt; n += tt * tt * (_wGrad3[g] * x2 + _wGrad3[g + 1] * y2 + _wGrad3[g + 2] * z2); }
    tt = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (tt > 0) { g = _wPermMod12[ii + 1 + _wPerm[jj + 1 + _wPerm[kk + 1]]] * 3; tt *= tt; n += tt * tt * (_wGrad3[g] * x3 + _wGrad3[g + 1] * y3 + _wGrad3[g + 2] * z3); }
    return 32 * n;   // およそ -1〜1
}

// ── 高さ（ノイズの値）。ux,uy,uz：球の上の点（長さ1）。oct：重ねる数 ──
// 大陸の形（最初の5段）を正規化した値から海面を引き、6段目以降の細かい起伏を足す。
function worldNoiseE(ux, uy, uz, oct) {
    // 大陸の形を自然にするためのゆがみ
    const W = 0.42, fw = 1.6;
    const px = ux + W * _wNoise3(ux * fw + 31.7, uy * fw, uz * fw);
    const py = uy + W * _wNoise3(ux * fw, uy * fw + 17.3, uz * fw);
    const pz = uz + W * _wNoise3(ux * fw, uy * fw, uz * fw + 5.9);
    let a = 1, f = 1.25, sum = 0, norm = 0;
    const nBase = Math.min(5, oct);
    for (let i = 0; i < nBase; i++) { sum += a * _wNoise3(px * f + i * 7.1, py * f, pz * f); norm += a; a *= 0.5; f *= 2.03; }
    let e = sum / norm - world.seaLevel;
    for (let i = nBase; i < oct; i++) {
        // 細かい起伏。少し強め（0.53倍ずつ）にして、海岸線を入り組ませる
        e += (a / norm) * _wNoise3(px * f + i * 7.1, py * f - i * 3.3, pz * f);
        a *= 0.53; f *= 2.03;
    }
    return e;
}
// 高さ[m]（陸は＋、海は−）
//  陸：海岸近くはなだらかな低地、内陸の高い所だけが山になる。
//  海：岸から少しのあいだは浅い大陸棚（〜150m）、その先で深くなる。
function worldHeightFromE(e) {
    if (e >= 0) return 7000 * Math.pow(e, 1.5) + 60 * Math.sqrt(e);
    const s = -e;
    return s < 0.05 ? -150 * Math.pow(s / 0.05, 0.7) : -Math.min(6000, 150 + 5000 * (s - 0.05));
}

// 浅瀬・岩礁：大陸棚（深さ130mまで）のところどころに「浅瀬の多い海域」（数十km）があり、
// その中に砂州や岩の連なり（2〜3km）と、ひとつひとつの岩（数百m）がある。
// 海面から頭を出す岩もあれば、数mの深さに隠れているものもある。
// 細かい所（oct 12 以上）だけで足す（世界全体の地図では見えない大きさなので）。
function worldShoal(ux, uy, uz, h, oct) {
    if (h >= 0 || h < -130 || oct < 12) return h;
    const field = _wNoise3(ux * 140 + 11.3, uy * 140 - 4.1, uz * 140 + 7.7);
    if (field < 0.18) return h;
    const w = Math.min(1, (field - 0.18) / 0.2) * Math.min(1, (h + 130) / 60);
    const n1 = _wNoise3(ux * 1900 - 3.3, uy * 1900 + 8.8, uz * 1900 + 1.2);
    const n2 = oct >= 16 ? _wNoise3(ux * 7000 + 5.5, uy * 7000 - 2.2, uz * 7000 + 9.1) : 0;
    const ridge = 1 - Math.abs(n1);
    // 尾根のいちばん高い所が数mの浅さ。海面から出る岩は、その中のさらに一部だけ
    const top = -42 + 40 * ridge * ridge * ridge + 5 * n2;
    if (top <= h) return h;
    return h + (top - h) * w;
}
// その点のまわりに浅瀬・岩が出ることがないか（大陸棚より深い、または「浅瀬の多い海域」の外）
function worldShoalFree(ux, uy, uz) {
    const h = worldHeightFromE(worldNoiseE(ux, uy, uz, 14));
    if (h < -160) return true;
    return _wNoise3(ux * 140 + 11.3, uy * 140 - 4.1, uz * 140 + 7.7) < 0.15;
}
// 球の上の点の高さ[m]（浅瀬・岩礁込み）
function worldHeightAt(ux, uy, uz, oct) {
    return worldShoal(ux, uy, uz, worldHeightFromE(worldNoiseE(ux, uy, uz, oct)), oct);
}

// 海面の高さを、陸が WORLD_LAND_FRACTION になるように決める
(function () {
    const r = _wRng(WORLD_SEED + 1);
    const vals = [];
    world.seaLevel = 0;
    for (let i = 0; i < 6000; i++) {
        const z = r() * 2 - 1, t = r() * Math.PI * 2, s = Math.sqrt(1 - z * z);
        vals.push(worldNoiseE(s * Math.cos(t), z, s * Math.sin(t), 5));
    }
    vals.sort((a, b) => a - b);
    world.seaLevel = vals[Math.floor(vals.length * (1 - WORLD_LAND_FRACTION))];
})();

// ── 緯度・経度 ↔ 球の点 ──
// 球の点：y が北極、経度0は +x、東経が増えると +z の向きへ回る
function worldLatLonToUnit(lat, lon, out) {
    const la = lat * Math.PI / 180, lo = lon * Math.PI / 180;
    out = out || {};
    out.x = Math.cos(la) * Math.cos(lo); out.y = Math.sin(la); out.z = Math.cos(la) * Math.sin(lo);
    return out;
}
function worldUnitToLatLon(u, out) {
    out = out || {};
    out.lat = Math.asin(Math.max(-1, Math.min(1, u.y))) * 180 / Math.PI;
    out.lon = Math.atan2(u.z, u.x) * 180 / Math.PI;
    return out;
}
// 原点（ref）での 東・北・上 の向き
function _worldFrame(lat, lon) {
    const la = lat * Math.PI / 180, lo = lon * Math.PI / 180;
    const C = { x: Math.cos(la) * Math.cos(lo), y: Math.sin(la), z: Math.cos(la) * Math.sin(lo) };
    const E = { x: -Math.sin(lo), y: 0, z: Math.cos(lo) };
    const N = { x: -Math.sin(la) * Math.cos(lo), y: Math.cos(la), z: -Math.sin(la) * Math.sin(lo) };
    return { C, E, N };
}
let _wFrameCache = null;
function worldFrame() {
    if (!_wFrameCache || _wFrameCache.lat !== world.ref.lat || _wFrameCache.lon !== world.ref.lon) {
        _wFrameCache = Object.assign({ lat: world.ref.lat, lon: world.ref.lon }, _worldFrame(world.ref.lat, world.ref.lon));
    }
    return _wFrameCache;
}
// 物理の面の点 (x=西, z=北)[m] → 球の点
//  three.js を上から北を上にして見ると、右（東）は −x になる。なので +x は西。
//  physics.heading は上から見て左回りに増えるので、羅針盤の方位は 360 − heading（worldCompass）。
function worldLocalToUnit(x, z, out) {
    const F = worldFrame();
    const a = -x / WORLD_R, b = z / WORLD_R;
    let ux = F.C.x + a * F.E.x + b * F.N.x, uy = F.C.y + a * F.E.y + b * F.N.y, uz = F.C.z + a * F.E.z + b * F.N.z;
    const l = Math.hypot(ux, uy, uz);
    out = out || {};
    out.x = ux / l; out.y = uy / l; out.z = uz / l;
    return out;
}
// 球の点 → 物理の面の点（原点の側の半球だけ）
function worldUnitToLocal(u, out) {
    const F = worldFrame();
    const d = u.x * F.C.x + u.y * F.C.y + u.z * F.C.z;
    out = out || {};
    if (d <= 0.01) { out.x = out.z = Infinity; return out; }
    out.x = -WORLD_R * (u.x * F.E.x + u.y * F.E.y + u.z * F.E.z) / d;
    out.z = WORLD_R * (u.x * F.N.x + u.y * F.N.y + u.z * F.N.z) / d;
    return out;
}
// physics.heading（上から見て左回り）⇄ 羅針盤の方位（北0・東90、右回り）
function worldCompass(heading) { return ((360 - (heading || 0)) % 360 + 360) % 360; }
function worldHeadingFromCompass(c) { return ((360 - c) % 360 + 360) % 360; }
window.worldCompass = worldCompass;
// 物理の面の点の高さ[m]（oct を省くと一番細かく）
const _wTmpU = {};
function worldHeightAtLocal(x, z, oct) {
    worldLocalToUnit(x, z, _wTmpU);
    return worldHeightAt(_wTmpU.x, _wTmpU.y, _wTmpU.z, oct || WORLD_OCT_FULL);
}
// 大円距離[m]
function worldDistance(latA, lonA, latB, lonB) {
    const a = worldLatLonToUnit(latA, lonA), b = worldLatLonToUnit(latB, lonB);
    const d = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z));
    return Math.acos(d) * WORLD_R;
}
// 今の船の緯度・経度
function worldShipLatLon() {
    const u = worldLocalToUnit(physics.cgWorldX || 0, physics.cgWorldZ || 0);
    return worldUnitToLatLon(u);
}
window.worldShipLatLon = worldShipLatLon;
function worldFmtLatLon(lat, lon) {
    const f = (v, pos, neg) => {
        const a = Math.abs(v), d = Math.floor(a), m = (a - d) * 60;
        return `${d}°${m.toFixed(1).padStart(4, '0')}'${v >= 0 ? pos : neg}`;
    };
    return `${f(lat, 'N', 'S')} ${f(lon, 'E', 'W')}`;
}
window.worldFmtLatLon = worldFmtLatLon;

// ════════════════════════════════════════════════════════════════
//  港を作る
// ════════════════════════════════════════════════════════════════
const _W_SYL_A = ['ノル', 'カス', 'ベル', 'アル', 'ミラ', 'サン', 'オス', 'リヴ', 'ヴァル', 'ポル', 'エル', 'マリ', 'トル', 'ハル', 'セラ', 'ロサ', 'キル', 'ブラン', 'アズ', 'グレ', 'シオ', 'ナギ', 'ウラ', 'カモ', 'イソ', 'ミサ', 'タカ', 'フジ', 'オル', 'ヴェ', 'ルナ', 'テオ', 'ザル', 'コル', 'メル', 'ソル'];
const _W_SYL_B = ['ヴィク', 'ハーフェン', 'ミナト', 'ベイ', 'ブルク', 'ヴァ', 'ナ', 'リア', 'サ', 'ドン', 'ヘイヴン', 'ハム', 'ス', 'ノ', 'マ', 'ツ', 'ラ', 'ゴ', 'ポリス', 'モンテ', 'シ', 'ザキ', 'ウラ', 'トン'];
function _wPortName(r, type) {
    const a = _W_SYL_A[Math.floor(r() * _W_SYL_A.length)];
    const b = _W_SYL_B[Math.floor(r() * _W_SYL_B.length)];
    return a + b + PORT_TYPES[type].suffix;
}
// 海岸の点を、陸と海の2点の間で細かく探す（二分法）
function _wFindCoast(ua, ub, oct) {
    // ua：海、ub：陸
    let a = ua, b = ub;
    for (let i = 0; i < 26; i++) {
        const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
        const l = Math.hypot(m.x, m.y, m.z); m.x /= l; m.y /= l; m.z /= l;
        if (worldNoiseE(m.x, m.y, m.z, oct) >= 0) b = m; else a = m;
    }
    return a;   // 海側のすぐ近く
}
// 港の一覧を作る（決まった種なので、いつも同じ）
function worldBuildPorts() {
    if (world.ports) return world.ports;
    const r = _wRng(WORLD_SEED + 7);
    const STEP = 0.75;
    const nLat = Math.round(150 / STEP), nLon = Math.round(360 / STEP);
    const land = new Uint8Array(nLat * nLon);
    const u = {};
    for (let i = 0; i < nLat; i++) {
        const lat = -75 + (i + 0.5) * STEP;
        for (let j = 0; j < nLon; j++) {
            worldLatLonToUnit(lat, -180 + (j + 0.5) * STEP, u);
            land[i * nLon + j] = worldNoiseE(u.x, u.y, u.z, 7) >= 0 ? 1 : 0;
        }
    }
    // 海岸の海側のマス（隣に陸がある海のマス）
    const cands = [];
    for (let i = 1; i < nLat - 1; i++) {
        for (let j = 0; j < nLon; j++) {
            if (land[i * nLon + j]) continue;
            let nb = -1, cnt = 0;
            for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const jj = (j + dj + nLon) % nLon;
                if (land[(i + di) * nLon + jj]) { cnt++; nb = [i + di, jj]; }
            }
            if (cnt > 0 && cnt < 4) cands.push({ i, j, nb, cnt });
        }
    }
    // 入り江（陸に多く囲まれた所）ほど港に向く
    for (let k = cands.length - 1; k > 0; k--) { const q = Math.floor(r() * (k + 1)); const t = cands[k]; cands[k] = cands[q]; cands[q] = t; }
    cands.sort((a, b) => b.cnt - a.cnt);
    const ports = [];
    const MIN_DIST = 260000;
    const unitOf = (i, j) => worldLatLonToUnit(-75 + (i + 0.5) * STEP, -180 + (j + 0.5) * STEP);
    for (const c of cands) {
        if (ports.length >= 150) break;
        const us = unitOf(c.i, c.j);
        let far = true;
        for (const p of ports) {
            const d = Math.acos(Math.max(-1, Math.min(1, us.x * p.u.x + us.y * p.u.y + us.z * p.u.z))) * WORLD_R;
            if (d < MIN_DIST) { far = false; break; }
        }
        if (!far) continue;
        // 海岸線を細かく探す（地図より細かい段まで）
        const ul = unitOf(c.nb[0], c.nb[1]);
        if (worldNoiseE(us.x, us.y, us.z, 12) >= 0 || worldNoiseE(ul.x, ul.y, ul.z, 12) < 0) continue;
        const uc = _wFindCoast(us, ul, 14);
        // 海の方の向き：高さが下がる向き
        const ll = worldUnitToLatLon(uc);
        const F = _worldFrame(ll.lat, ll.lon);
        const h = 1500 / WORLD_R;
        const at = (a, b) => { const x = F.C.x + a * F.E.x + b * F.N.x, y = F.C.y + a * F.E.y + b * F.N.y, z = F.C.z + a * F.E.z + b * F.N.z, l = Math.hypot(x, y, z); return worldNoiseE(x / l, y / l, z / l, 12); };
        const gx = at(h, 0) - at(-h, 0), gz = at(0, h) - at(0, -h);
        const gl = Math.hypot(gx, gz);
        if (gl < 1e-9) continue;
        const seaE = -gx / gl, seaN = -gz / gl;         // 海の方（東・北の成分）
        // 種類：緯度が高すぎる所は漁港に、残りはくじ
        const q = r();
        let type = q < 0.34 ? 'fishing' : q < 0.56 ? 'town' : q < 0.72 ? 'city' : q < 0.88 ? 'cargo' : 'naval';
        if (Math.abs(ll.lat) > 62 && (type === 'city' || type === 'cargo')) type = 'fishing';
        ports.push({
            id: 'p' + ports.length, type, name: _wPortName(r, type),
            lat: ll.lat, lon: ll.lon, u: uc,
            seaBearing: (Math.atan2(seaE, seaN) * 180 / Math.PI + 360) % 360,   // 海の方の方位（0＝北、90＝東）
            seed: Math.floor(r() * 1e9),
        });
    }
    // 名前が重ならないように
    const seen = new Set();
    for (const p of ports) {
        let n = p.name, k = 2;
        while (seen.has(n)) n = p.name.replace(PORT_TYPES[p.type].suffix, '') + '第' + (k++) + PORT_TYPES[p.type].suffix;
        p.name = n; seen.add(n);
    }
    world.ports = ports;
    return ports;
}
window.worldBuildPorts = worldBuildPorts;

// 近い港（距離[m]付き）
function worldNearestPort(lat, lon) {
    const ports = worldBuildPorts();
    const u = worldLatLonToUnit(lat, lon);
    let best = null, bd = Infinity;
    for (const p of ports) {
        const d = Math.acos(Math.max(-1, Math.min(1, u.x * p.u.x + u.y * p.u.y + u.z * p.u.z))) * WORLD_R;
        if (d < bd) { bd = d; best = p; }
    }
    return best ? { port: best, dist: bd } : null;
}
window.worldNearestPort = worldNearestPort;

// ════════════════════════════════════════════════════════════════
//  モード・移動・保存
// ════════════════════════════════════════════════════════════════
(function restoreWorld() {
    try {
        const s = JSON.parse(localStorage.getItem('susuru_world') || 'null');
        if (s) {
            if (s.mode === 'world' || s.mode === 'ocean') world.mode = s.mode;
            if (s.ref && Number.isFinite(s.ref.lat) && Number.isFinite(s.ref.lon)) world.ref = { lat: s.ref.lat, lon: s.ref.lon };
            // 前回の船の位置から続ける（その位置を新しい原点にする）
            if (s.ship && Number.isFinite(s.ship.lat) && Number.isFinite(s.ship.lon)) {
                world.ref = { lat: s.ship.lat, lon: s.ship.lon };
                if (Number.isFinite(s.ship.hdg)) world._resumeHeading = s.ship.hdg;
            }
        }
    } catch (e) { /* ignore */ }
})();
function _worldSave() {
    const o = { mode: world.mode, ref: world.ref };
    if (world.mode === 'world' && typeof physics !== 'undefined') {
        const ll = worldShipLatLon();
        o.ship = { lat: ll.lat, lon: ll.lon, hdg: physics.heading || 0 };
    }
    try { localStorage.setItem('susuru_world', JSON.stringify(o)); } catch (e) { /* ignore */ }
}
window._worldSave = _worldSave;
function worldSetMode(mode) {
    if (mode !== 'world' && mode !== 'ocean') return;
    if (mode === 'world' && world.mode !== 'world') {
        world.mode = 'world';
        // 初めてなら、いちばん大きな港湾都市から出航する
        if (!world.ref || (world.ref.lat === 0 && world.ref.lon === 0)) {
            const ports = worldBuildPorts();
            const start = ports.find(p => p.type === 'city') || ports[0];
            if (start) { worldStartAtPort(start); return; }
        }
    } else {
        world.mode = mode;
    }
    _worldSave();
    if (typeof worldTerrainModeChanged === 'function') worldTerrainModeChanged();
    worldMapRedraw();
}
window.worldSetMode = worldSetMode;

// 船の喫水[m]（喫水線からキールまで）
// 模型の形から決めた喫水（いちばん深い所）[m]
function worldShipDraftAuto() {
    const hp = window.hullProfile;
    const sy = (typeof shipGroup !== 'undefined' && shipGroup) ? Math.abs(shipGroup.scale.y) || 1 : 1;
    if (hp && hp.ready) {
        let d = 0;
        for (const sl of hp.slices || []) d = Math.max(d, sl.draft || 0);
        if (!(d > 0) && hp.designWaterlineY > hp.keelY) d = hp.designWaterlineY - hp.keelY;
        if (d > 0) return d * sy;
    }
    return 0.4 * (physics.scale || 1);
}
// 喫水[m]。船体設定で手入力（physics.draftOverride）していればそれ
function worldShipDraft() {
    return physics.draftOverride > 0 ? physics.draftOverride : worldShipDraftAuto();
}
// 船の中の前後位置 z（模型の座標）での 半幅[m]・喫水[m]（船体の輪切りから。手入力の喫水は比で掛ける）
function worldHullAt(zLocal) {
    const hp = window.hullProfile;
    const sc = physics.scale || 1;
    const sy = (typeof shipGroup !== 'undefined' && shipGroup) ? Math.abs(shipGroup.scale.y) || 1 : 1;
    if (!hp || !hp.ready || !hp.slices || hp.slices.length < 2) return { hw: 1.5 * sc, d: worldShipDraft() };
    const a = zLocal / hp.halfLen * (hp.bowSign || 1);
    const sl = hp.slices;
    let i = 0;
    while (i < sl.length - 2 && sl[i + 1].alongNorm < a) i++;
    const A = sl[i], B = sl[i + 1];
    const u = Math.max(0, Math.min(1, (a - A.alongNorm) / ((B.alongNorm - A.alongNorm) || 1)));
    const hw = (A.halfWidth + (B.halfWidth - A.halfWidth) * u) * sc;
    let d = (A.draft + (B.draft - A.draft) * u) * sy;
    if (physics.draftOverride > 0) d *= physics.draftOverride / Math.max(1e-3, worldShipDraftAuto());
    return { hw, d };
}
function setShipDraft(v) {
    physics.draftOverride = Math.max(0, parseFloat(v) || 0);
    const el = document.getElementById('draft-auto');
    if (el) el.textContent = `0 ＝ 模型から自動（${worldShipDraftAuto().toFixed(1)} m）`;
}
Object.assign(window, { worldShipDraft, worldShipDraftAuto, worldHullAt, setShipDraft });
setInterval(() => { const el = document.getElementById('draft-auto'); const p = document.getElementById('settings-panel'); if (el && p && p.classList.contains('open')) el.textContent = `0 ＝ 模型から自動（${worldShipDraftAuto().toFixed(1)} m）`; }, 2000);

// 港から出航する：港の前の泊地に、海の方を向けて置く。
// 船が深すぎて港に入れないときは、足りる深さの所まで沖へ出して置く。
function worldStartAtPort(port) {
    const T = PORT_TYPES[port.type];
    const F = _worldFrame(port.lat, port.lon);
    const br = port.seaBearing * Math.PI / 180;
    const unitAt = (d) => {
        const a = Math.sin(br) * d / WORLD_R, b = Math.cos(br) * d / WORLD_R;
        const x = F.C.x + a * F.E.x + b * F.N.x, y = F.C.y + a * F.E.y + b * F.N.y, z = F.C.z + a * F.E.z + b * F.N.z, l = Math.hypot(x, y, z);
        return { x: x / l, y: y / l, z: z / l };
    };
    const need = worldShipDraft() + 3;
    const hp = window.hullProfile;
    const halfLen = ((hp && hp.ready) ? hp.halfLen : 6) * (physics.scale || 1) * 1.1 + 10;
    const mouth = T.basin * 0.76;                     // 防波堤の出入り口
    let off = { fishing: 150, town: 220, city: 360, cargo: 420, naval: 350 }[port.type] || 250;
    // 泊地に収まらない（長すぎる・深すぎる）船は、港の外の、船の端から端まで深さが足りる所へ
    if (need > T.depth + 1 || off - halfLen < T.pier || off + halfLen > mouth) {
        const depthAt = (d) => {
            const u = unitAt(d), nat = -worldHeightAt(u.x, u.y, u.z, 16);
            // 航路（44-world-terrain.js の _portAdjust）の中は掘ってある
            return d < T.basin + worldPortChannelLen(port) - 400 ? Math.max(nat, T.depth + 2) : nat;
        };
        for (let d = mouth + halfLen + 60; d < 15000; d += 100) {
            off = d;
            if (depthAt(d - halfLen) > need && depthAt(d) > need && depthAt(d + halfLen) > need && (() => { const u = unitAt(d); return worldShoalFree(u.x, u.y, u.z); })()) break;
        }
    }
    const ll = worldUnitToLatLon(unitAt(off));
    world.mode = 'world';
    world.ref = { lat: ll.lat, lon: ll.lon };
    _wFrameCache = null;
    physics.cgWorldX = 0; physics.cgWorldZ = 0;
    physics.heading = worldHeadingFromCompass(port.seaBearing);
    physics.speed = 0; physics.targetSpeed = 0; physics.turnRate = 0;
    physics.telegraphState = 0;
    // 岸壁に横付けできる港なら、岸壁に着岸した状態から始める（もやい綱も取る。出港はタグで離岸）
    if (typeof harborBerthPlan === 'function') {
        const plan = harborBerthPlan(port, physics.heading);
        if (plan.ok) {
            physics.cgWorldX = plan.berth.x; physics.cgWorldZ = plan.berth.z; physics.heading = plan.berth.h;
            if (typeof harborAuto !== 'undefined') { harborAuto.pendingLines = plan; harborAuto.pendingT = 0; }
        }
    }
    if (typeof shipHistory !== 'undefined') shipHistory.length = 0;
    window.lastShipPos = null;
    _worldSave();
    if (typeof worldTerrainModeChanged === 'function') worldTerrainModeChanged(true);
    worldMapRedraw();
}
window.worldStartAtPort = worldStartAtPort;

// ════════════════════════════════════════════════════════════════
//  世界地図（画面いっぱいのパネル）
// ════════════════════════════════════════════════════════════════
//  正距円筒図法（横＝経度、縦＝緯度）。ドラッグで動かし、ピンチ・ボタンで拡大。
//  全体の絵は1回だけ作って覚えておき、拡大したときは見えている範囲だけ細かく作り直す。
const _wm = { open: false, cx: 0, cy: 10, zoom: 1, base: null, detail: null, detailKey: '', sel: null, drag: null, pinch: null, job: 0 };
const WM_BASE_W = 720, WM_BASE_H = 360;

function _wmColor(h) {
    if (h < 0) {
        const d = Math.min(1, -h / 2500);
        if (h > -25) return [96, 170, 196];                   // 浅瀬
        if (h > -160) return [62, 138, 182];                  // 大陸棚
        return [Math.round(20 + 40 * (1 - d)), Math.round(60 + 70 * (1 - d)), Math.round(110 + 60 * (1 - d))];
    }
    if (h < 15) return [214, 200, 150];                       // 砂浜
    if (h < 400) { const k = h / 400; return [Math.round(96 - 30 * k), Math.round(150 - 30 * k), Math.round(80 - 20 * k)]; }
    if (h < 1100) { const k = (h - 400) / 700; return [Math.round(66 + 70 * k), Math.round(120 - 10 * k), Math.round(60 + 20 * k)]; }
    if (h < 1900) return [150, 140, 125];
    return [236, 238, 242];                                   // 雪
}
// 海図の色：陸は黄土色、海は深さの段ごとに青から白へ（浅いほど濃い青）
const WM_CHART_BANDS = [2, 5, 10, 20, 50, 200];              // 等深線[m]
const WM_CHART_COL = [[158, 204, 168], [120, 182, 232], [158, 205, 242], [196, 224, 248], [224, 239, 252], [242, 248, 254], [252, 253, 255]];
function _wmBand(h) {
    if (h >= 0) return -1;
    const d = -h;
    let k = 0;
    while (k < WM_CHART_BANDS.length && d >= WM_CHART_BANDS[k]) k++;
    return k;
}
// 高さの配列 → 絵（rows r0〜r1-1）。海図のときは段の境目に等深線を引く
function _wmPaint(cv, r0, r1) {
    const w = cv.width, H = cv.H, img = cv.img, D = img.data, chart = !!_wm.chart;
    for (let y = r0; y < r1; y++) {
        for (let x = 0; x < w; x++) {
            const k = y * w + x, h = H[k], o = k * 4;
            let c;
            if (!chart) c = _wmColor(h);
            else {
                const b = _wmBand(h);
                c = b < 0 ? (h > 300 ? [228, 208, 158] : [240, 222, 170]) : WM_CHART_COL[b];
                const bl = x > 0 ? _wmBand(H[k - 1]) : b, bu = y > 0 ? _wmBand(H[k - w]) : b;
                if (bl !== b || bu !== b) {
                    const coast = (b < 0) !== (bl < 0) || (b < 0) !== (bu < 0);
                    c = coast ? [70, 62, 48] : [96, 140, 186];
                }
            }
            D[o] = c[0]; D[o + 1] = c[1]; D[o + 2] = c[2]; D[o + 3] = 255;
        }
    }
    cv.getContext('2d').putImageData(img, 0, 0);
}
// 港へ入る航路の長さ[m]（泊地の端から）。浅瀬の多い海域を抜けて、十分な深さが
// 1.5km 続く所まで伸ばす。途中に本当の陸（島など）があれば、その手前で止める。
function worldPortChannelLen(p) {
    if (p._chLen) return p._chLen;
    const T = PORT_TYPES[p.type], F = _worldFrame(p.lat, p.lon), br = p.seaBearing * Math.PI / 180;
    const sx = Math.sin(br), sz = Math.cos(br);
    // 浅瀬の出る所（大陸棚で「浅瀬の多い海域」）を抜けて、そうでない所が 1.5km 続くまで伸ばす
    let len = 25000, deepFrom = -1;
    for (let d = 0; d <= 25000; d += 100) {
        const a = T.basin + d;
        const x = F.C.x + (a * sx) / WORLD_R * F.E.x + (a * sz) / WORLD_R * F.N.x;
        const y = F.C.y + (a * sx) / WORLD_R * F.E.y + (a * sz) / WORLD_R * F.N.y;
        const z = F.C.z + (a * sx) / WORLD_R * F.E.z + (a * sz) / WORLD_R * F.N.z;
        const l = Math.hypot(x, y, z), ux = x / l, uy = y / l, uz = z / l;
        const e = worldNoiseE(ux, uy, uz, 16);
        if (e >= 0) { len = Math.max(600, d - 150); break; }          // 島・岬：その手前まで
        // 深くて、しかも浅瀬が出ない所か
        let deep = -worldHeightAt(ux, uy, uz, 16) > T.depth + 6 && worldShoalFree(ux, uy, uz);
        if (deep) deepFrom = deepFrom < 0 ? d : deepFrom; else deepFrom = -1;
        if (deepFrom >= 0 && d - deepFrom >= 1500) { len = Math.max(1200, deepFrom + 400); break; }
    }
    p._chLen = len;
    return len;
}
window.worldPortChannelLen = worldPortChannelLen;
// 港の手直し（泊地・航路の浚渫、44-world-terrain.js の _portAdjust）を地図にも入れるための、
// 港それぞれの面（港の点に接する面）での形
function _wmPortShapes(lon0, lon1, lat0, lat1) {
    if (!world.ports || typeof _portAdjust !== 'function') return [];
    const out = [];
    const cl = worldLatLonToUnit((lat0 + lat1) / 2, (lon0 + lon1) / 2);
    const rad = worldDistance(lat0, lon0, lat1, lon1) / 2 + 8000;
    for (const p of world.ports) {
        const d = Math.acos(Math.max(-1, Math.min(1, cl.x * p.u.x + cl.y * p.u.y + cl.z * p.u.z))) * WORLD_R;
        if (d > rad) continue;
        const T = PORT_TYPES[p.type], br = p.seaBearing * Math.PI / 180;
        const quayLen = T.quay;
        out.push({ F: _worldFrame(p.lat, p.lon), S: [{ x: 0, z: 0, sx: Math.sin(br), sz: Math.cos(br), quayLen, apron: 0, basin: T.basin, depth: T.depth, chLen: worldPortChannelLen(p) }] });
    }
    return out;
}
function _wmApplyPorts(ps, u, h) {
    for (const q of ps) {
        const F = q.F;
        const dot = u.x * F.C.x + u.y * F.C.y + u.z * F.C.z;
        if (dot < 0.999998) continue;                      // 約9km より遠い
        const x = WORLD_R * (u.x * F.E.x + u.y * F.E.y + u.z * F.E.z) / dot;
        const z = WORLD_R * (u.x * F.N.x + u.y * F.N.y + u.z * F.N.z) / dot;
        if (h < 0 || x * q.S[0].sx + z * q.S[0].sz > 0) h = _portAdjust(h, x, z, q.S);   // 陸（岸壁の後ろ）はそのまま
    }
    return h;
}
// 緯度・経度の範囲を絵にする（少しずつ。終わったら done(canvas)）
function _wmRender(w, h, lon0, lon1, lat0, lat1, oct, done) {
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    cv.img = cv.getContext('2d').createImageData(w, h);
    cv.H = new Float32Array(w * h);
    cv.rows = 0;
    cv.ext = { lon0, lon1, lat0, lat1 };
    const job = ++_wm.job;
    let row = 0;
    const u = {};
    const ports = oct >= 12 ? _wmPortShapes(lon0, lon1, lat0, lat1) : [];
    cv.ports = ports;
    const step = () => {
        if (job !== _wm.job && oct !== WORLD_OCT_MAP - 2) return;   // 新しい作り直しが始まった（全体図は止めない）
        const t0 = performance.now(), r0 = row;
        while (row < h && performance.now() - t0 < 12) {
            const lat = lat1 - (row + 0.5) / h * (lat1 - lat0);
            for (let x = 0; x < w; x++) {
                const lon = lon0 + (x + 0.5) / w * (lon1 - lon0);
                worldLatLonToUnit(lat, lon, u);
                let hh = worldHeightAt(u.x, u.y, u.z, oct);
                if (ports.length) hh = _wmApplyPorts(ports, u, hh);
                cv.H[row * w + x] = hh;
            }
            row++;
        }
        cv.rows = row;
        _wmPaint(cv, r0, row);
        if (row < h) { setTimeout(step, 0); if ((row & 15) === 0 || row - r0 > 15) done(cv, false); return; }
        done(cv, true);
    };
    step();
}
// 海図と地形図を切り替える（作った高さはそのまま使って塗り直す）
function worldMapSetChart(on) {
    _wm.chart = !!on;
    try { localStorage.setItem('susuru_wm_chart', _wm.chart ? '1' : '0'); } catch (e) { /* ignore */ }
    for (const cv of [_wm.base || _wm.basePartial, _wm.detail]) if (cv && cv.H) _wmPaint(cv, 0, cv.rows);
    const b = document.getElementById('wp-chart'); if (b) b.classList.toggle('on', _wm.chart);
    worldMapRedraw(true);
}
window.worldMapSetChart = worldMapSetChart;
try { _wm.chart = localStorage.getItem('susuru_wm_chart') === '1'; } catch (e) { /* ignore */ }

function _wmEnsureDom() {
    if (document.getElementById('world-panel')) return;
    const el = document.createElement('div');
    el.id = 'world-panel';
    el.innerHTML = `
        <div class="wp-head">
            <span class="wp-title">🗺 世界地図</span>
            <span class="wp-modes">
                <button id="wp-mode-ocean" onclick="worldSetMode('ocean')">🌊 海だけ</button>
                <button id="wp-mode-world" onclick="worldSetMode('world')">🌍 世界を航海</button>
            </span>
            <button id="wp-chart" class="wp-chartbtn" onclick="worldMapSetChart(!_wm.chart)">📘 海図</button>
            <button id="wp-minimap" class="wp-chartbtn wp-mmbtn" onclick="minimapShow(!_mm.show)" title="右上の小さな地図">◉ ミニ地図</button>
            <button class="wp-close" onclick="toggleWorldMap(false)">✕</button>
        </div>
        <div class="wp-body">
            <canvas id="wp-canvas"></canvas>
            <div class="wp-tools">
                <button onclick="_wmZoomBy(1.6)">＋</button>
                <button onclick="_wmZoomBy(1/1.6)">－</button>
                <button onclick="_wmCenterShip()" title="今の場所へ">◎</button>
            </div>
            <div class="wp-legend"></div>
            <div id="wp-info"></div>
            <div id="wp-status"></div>
        </div>`;
    document.body.appendChild(el);
    const lg = el.querySelector('.wp-legend');
    lg.innerHTML = Object.values(PORT_TYPES).map(t => `<span><i style="background:${t.color}"></i>${t.label}</span>`).join('');
    const cv = el.querySelector('#wp-canvas');
    const pos = (e) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const pts = new Map();
    cv.addEventListener('pointerdown', (e) => {
        cv.setPointerCapture(e.pointerId);
        pts.set(e.pointerId, pos(e));
        if (pts.size === 1) _wm.drag = { p: pos(e), cx: _wm.cx, cy: _wm.cy, moved: false };
        if (pts.size === 2) { const [a, b] = [...pts.values()]; _wm.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: _wm.zoom }; _wm.drag = null; }
    });
    cv.addEventListener('pointermove', (e) => {
        if (!pts.has(e.pointerId)) return;
        pts.set(e.pointerId, pos(e));
        if (_wm.pinch && pts.size >= 2) {
            const [a, b] = [...pts.values()];
            _wmSetZoom(_wm.pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, _wm.pinch.d));
        } else if (_wm.drag) {
            const p = pos(e), dpd = _wmDegPerPx();
            const dx = p.x - _wm.drag.p.x, dy = p.y - _wm.drag.p.y;
            if (Math.abs(dx) + Math.abs(dy) > 4) _wm.drag.moved = true;
            _wm.cx = _wm.drag.cx - dx * dpd;
            _wm.cy = Math.max(-80, Math.min(80, _wm.drag.cy + dy * dpd));
            worldMapRedraw(true);
        }
    });
    const up = (e) => {
        const wasDrag = _wm.drag;
        pts.delete(e.pointerId);
        if (pts.size < 2) _wm.pinch = null;
        if (pts.size === 0) {
            _wm.drag = null;
            if (wasDrag && !wasDrag.moved) _wmTap(pos(e));
            worldMapRedraw();
        }
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('wheel', (e) => { e.preventDefault(); _wmZoomBy(e.deltaY < 0 ? 1.25 : 0.8); }, { passive: false });
    window.addEventListener('resize', () => { if (_wm.open) worldMapRedraw(); });
}
function _wmDegPerPx() {
    const cv = document.getElementById('wp-canvas');
    return 360 / Math.max(1, cv.clientWidth) / _wm.zoom;
}
function _wmSetZoom(z) { _wm.zoom = Math.max(1, Math.min(400, z)); worldMapRedraw(true); }
function _wmZoomBy(k) { _wmSetZoom(_wm.zoom * k); clearTimeout(_wm._t); _wm._t = setTimeout(() => worldMapRedraw(), 200); }
window._wmZoomBy = _wmZoomBy;
function _wmCenterShip() {
    if (world.mode === 'world') { const ll = worldShipLatLon(); _wm.cx = ll.lon; _wm.cy = ll.lat; if (_wm.zoom < 30) _wm.zoom = 30; }
    worldMapRedraw();
}
window._wmCenterShip = _wmCenterShip;
// 画面の点 ↔ 緯度・経度
function _wmToScreen(lat, lon, cv) {
    const dpd = _wmDegPerPx();
    let dl = lon - _wm.cx; dl = ((dl + 540) % 360) - 180;
    return { x: cv.clientWidth / 2 + dl / dpd, y: cv.clientHeight / 2 - (lat - _wm.cy) / dpd };
}
function _wmTap(p) {
    const cv = document.getElementById('wp-canvas');
    const ports = worldBuildPorts();
    let best = null, bd = 22;
    for (const q of ports) {
        const s = _wmToScreen(q.lat, q.lon, cv);
        const d = Math.hypot(s.x - p.x, s.y - p.y);
        if (d < bd) { bd = d; best = q; }
    }
    _wm.sel = best;
    // 港でない所：その海域を選ぶ（自動航行の行き先にできる）
    _wm.selPt = null;
    if (!best) {
        const dpd = _wmDegPerPx();
        const lat = _wm.cy - (p.y - cv.clientHeight / 2) * dpd;
        const lon = ((_wm.cx + (p.x - cv.clientWidth / 2) * dpd) + 540) % 360 - 180;
        if (Math.abs(lat) < 80) _wm.selPt = { lat, lon };
    }
    _wmShowInfo();
    worldMapRedraw(true);
}
function _wmShowInfo() {
    const el = document.getElementById('wp-info');
    if (!el) return;
    const p = _wm.sel;
    if (!p && _wm.selPt) { _wmShowPointInfo(el, _wm.selPt); return; }
    if (!p) { el.style.display = 'none'; return; }
    const T = PORT_TYPES[p.type];
    let dist = '';
    let apBtn = '';
    if (world.mode === 'world') {
        const ll = worldShipLatLon();
        dist = `　今の場所から ${(worldDistance(ll.lat, ll.lon, p.lat, p.lon) / 1852).toFixed(0)} 海里`;
        if (typeof rhumbCourse === 'function') {
            const rc = rhumbCourse(ll.lat, ll.lon, p.lat, p.lon);
            dist += `（航程線の針路 ${Math.round(rc.course).toString().padStart(3, '0')}°・${(rc.dist / 1852).toFixed(0)} 海里）`;
        }
        if (typeof autopilotStart === 'function') apBtn = `<button onclick="autopilotStart(world.ports.find(q => q.id === '${p.id}'))">🧭 ここへ自動航行</button>`;
    }
    el.style.display = 'block';
    el.innerHTML = `<div class="wp-pname"><i style="background:${T.color}"></i>${p.name}</div>
        <div class="wp-pmeta">${T.label}・${worldFmtLatLon(p.lat, p.lon)}${dist}</div>
        <div class="wp-pbtns">${apBtn}<button onclick="worldStartAtPort(world.ports.find(q => q.id === '${p.id}')); toggleWorldMap(false);">⚓ この港から出航</button>
        <button onclick="_wm.sel=null;_wmShowInfo();worldMapRedraw(true)">閉じる</button></div>`;
}
window._wmShowInfo = _wmShowInfo;
// 選んだ海域の説明（水深・距離・針路）と「ここへ自動航行」
function _wmShowPointInfo(el, q) {
    const u = worldLatLonToUnit(q.lat, q.lon);
    const h = worldHeightAt(u.x, u.y, u.z, 16);
    const land = h >= 0;
    let dist = '', apBtn = '';
    if (world.mode === 'world') {
        const ll = worldShipLatLon();
        if (typeof rhumbCourse === 'function') {
            const rc = rhumbCourse(ll.lat, ll.lon, q.lat, q.lon);
            dist = `<br>今の場所から ${(rc.dist / 1852).toFixed(rc.dist < 18520 ? 1 : 0)} 海里（航程線の針路 ${Math.round(rc.course).toString().padStart(3, '0')}°）`;
        }
        if (typeof autopilotStartPoint === 'function') apBtn = `<button onclick="autopilotStartPoint(${q.lat}, ${q.lon})">🧭 ここへ自動航行</button>`;
    }
    const shoal = !land && !worldShoalFree(u.x, u.y, u.z) ? '・浅瀬の多い海域' : '';
    el.style.display = 'block';
    el.innerHTML = `<div class="wp-pname">📍 ${land ? '陸地' : '海域'}</div>
        <div class="wp-pmeta">${worldFmtLatLon(q.lat, q.lon)}・${land ? `標高 約 ${Math.round(h)}m（近くの海で止まります）` : `水深 約 ${Math.round(-h)}m${shoal}`}${dist}</div>
        <div class="wp-pbtns">${apBtn}<button onclick="_wm.selPt=null;_wmShowInfo();worldMapRedraw(true)">閉じる</button></div>`;
}
window._wm = _wm;

// 描き直す（quick：細かい絵を作り直さない＝ドラッグ中）
function worldMapRedraw(quick) {
    if (!_wm.open) return;
    const cv = document.getElementById('wp-canvas');
    if (!cv) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = cv.clientWidth, H = cv.clientHeight;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = _wm.chart ? '#e4edf5' : '#0d2a44'; g.fillRect(0, 0, W, H);
    const chartBtn = document.getElementById('wp-chart'); if (chartBtn) chartBtn.classList.toggle('on', !!_wm.chart);
    const mmBtn = document.getElementById('wp-minimap'); if (mmBtn && typeof _mm !== 'undefined') mmBtn.classList.toggle('on', !!_mm.show);
    document.getElementById('wp-mode-ocean').classList.toggle('on', world.mode === 'ocean');
    document.getElementById('wp-mode-world').classList.toggle('on', world.mode === 'world');
    const st = document.getElementById('wp-status');
    // 全体の絵
    if (!_wm.base) {
        if (!_wm.baseBusy) {
            _wm.baseBusy = true;
            if (st) st.textContent = '地図を作っています…';
            _wmRender(WM_BASE_W, WM_BASE_H, -180, 180, -90, 90, WORLD_OCT_MAP - 2, (c, fin) => { _wm.basePartial = c; if (fin) { _wm.base = c; _wm.baseBusy = false; if (st) st.textContent = ''; } worldMapRedraw(true); });
        }
    }
    const baseImg = _wm.base || _wm.basePartial;
    const dpd = _wmDegPerPx();
    if (baseImg) {
        g.imageSmoothingEnabled = _wm.zoom < 6;
        // 経度方向は繰り返し描く
        const pxPerDeg = 1 / dpd;
        const top = H / 2 - (90 - _wm.cy) * pxPerDeg;
        const wWorld = 360 * pxPerDeg;
        let left = W / 2 - (_wm.cx + 180) * pxPerDeg;
        left = ((left % wWorld) + wWorld) % wWorld - wWorld;
        for (let x = left; x < W; x += wWorld) g.drawImage(baseImg, x, top, wWorld, 180 * pxPerDeg);
    }
    // 拡大したときは、見えている範囲を細かく作り直す
    if (_wm.zoom >= 4) {
        const lon0 = _wm.cx - W / 2 * dpd, lon1 = _wm.cx + W / 2 * dpd;
        const lat1 = Math.min(90, _wm.cy + H / 2 * dpd), lat0 = Math.max(-90, _wm.cy - H / 2 * dpd);
        const key = [lon0, lon1, lat0, lat1].map(v => v.toFixed(3)).join(',');
        if (_wm.detail && _wm.detailKey === key) {
            g.imageSmoothingEnabled = true;
            const s = _wmToScreen(lat1, lon0, cv);
            g.drawImage(_wm.detail, s.x, s.y, (lon1 - lon0) / dpd, (lat1 - lat0) / dpd);
        } else if (!quick) {
            const oct = Math.min(16, WORLD_OCT_MAP + Math.round(Math.log2(_wm.zoom)));
            const rw = Math.min(480, Math.round(W / 2)), rh = Math.round(rw * H / W);
            _wm.detailKey = key; _wm.detail = null;
            _wmRender(rw, rh, lon0, lon1, lat0, lat1, oct, (c, fin) => { if (_wm.detailKey === key) { _wm.detail = c; worldMapRedraw(true); } });
        }
    }
    // 海図：水深の数字（拡大したとき。細かい絵の高さから拾う）
    if (_wm.chart && _wm.zoom >= 24 && _wm.detail && _wm.detail.H && _wm.detail.rows === _wm.detail.height) {
        const Dt = _wm.detail, E = Dt.ext, dw = Dt.width, dh = Dt.height;
        g.font = 'italic 10px serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
        const GAP = 46;
        for (let sy = GAP / 2; sy < H; sy += GAP) {
            for (let sx = GAP / 2 + ((sy / GAP) & 1) * GAP / 2; sx < W; sx += GAP) {
                const lon = _wm.cx + (sx - W / 2) * dpd, lat = _wm.cy - (sy - H / 2) * dpd;
                const ix = Math.floor((lon - E.lon0) / (E.lon1 - E.lon0) * dw), iy = Math.floor((E.lat1 - lat) / (E.lat1 - E.lat0) * dh);
                if (ix < 0 || iy < 0 || ix >= dw || iy >= dh) continue;
                const h = Dt.H[iy * dw + ix];
                if (h >= -0.5) continue;
                const d = -h;
                g.fillStyle = d < 10 ? '#1b3552' : '#4d6780';
                g.fillText(d < 20 ? d.toFixed(0) : String(Math.round(d / 5) * 5), sx, sy);
            }
        }
        g.textAlign = 'start';
    }
    // 海図：港へ入る航路（浚渫してある所）を破線で。ここを外れると浅瀬があるかもしれない
    if (_wm.chart && _wm.zoom >= 24 && world.ports) {
        g.save();
        g.strokeStyle = 'rgba(190, 40, 150, 0.85)'; g.lineWidth = 1.4; g.setLineDash([6, 4]);
        for (const p of world.ports) {
            const s0 = _wmToScreen(p.lat, p.lon, cv);
            if (s0.x < -400 || s0.x > W + 400 || s0.y < -400 || s0.y > H + 400) continue;
            const T = PORT_TYPES[p.type], F = _worldFrame(p.lat, p.lon), br = p.seaBearing * Math.PI / 180;
            const sx = Math.sin(br), sz = Math.cos(br);
            const toS = (a, b) => {
                const x = a * sx + b * sz, z = a * sz - b * sx;          // 港の a（沖へ）・b（岸沿い）→ 東・北
                const ux = F.C.x + x / WORLD_R * F.E.x + z / WORLD_R * F.N.x, uy = F.C.y + x / WORLD_R * F.E.y + z / WORLD_R * F.N.y, uz = F.C.z + x / WORLD_R * F.E.z + z / WORLD_R * F.N.z;
                const l = Math.hypot(ux, uy, uz), ll = worldUnitToLatLon({ x: ux / l, y: uy / l, z: uz / l });
                return _wmToScreen(ll.lat, ll.lon, cv);
            };
            for (const side of [-1, 1]) {
                g.beginPath();
                const aEnd = T.basin + worldPortChannelLen(p) - 300;
                for (let a = T.basin * 0.76; a <= aEnd; a += 200) {
                    const ch = Math.max(90, T.quay / 4) + Math.max(0, a - T.basin) * 0.06;
                    const q = toS(a, side * ch);
                    if (a === T.basin * 0.76) g.moveTo(q.x, q.y); else g.lineTo(q.x, q.y);
                }
                g.stroke();
            }
        }
        g.restore();
    }
    // 緯線・経線
    g.strokeStyle = _wm.chart ? 'rgba(40,80,130,0.22)' : 'rgba(255,255,255,0.12)'; g.lineWidth = 1;
    const gridStep = _wm.zoom < 3 ? 30 : _wm.zoom < 12 ? 10 : _wm.zoom < 60 ? 2 : 0.5;
    for (let lat = -90; lat <= 90; lat += gridStep) { const y = _wmToScreen(lat, _wm.cx, cv).y; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
    const lonStart = Math.floor((_wm.cx - W / 2 * dpd) / gridStep) * gridStep;
    for (let lon = lonStart; lon <= _wm.cx + W / 2 * dpd; lon += gridStep) { const x = W / 2 + (lon - _wm.cx) / dpd; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
    // 港
    const ports = world.ports;
    if (ports) {
        g.font = '11px sans-serif'; g.textBaseline = 'middle';
        for (const p of ports) {
            const s = _wmToScreen(p.lat, p.lon, cv);
            if (s.x < -20 || s.x > W + 20 || s.y < -20 || s.y > H + 20) continue;
            const T = PORT_TYPES[p.type];
            const r = 2.5 + T.size * 1.2 + (p === _wm.sel ? 3 : 0);
            g.fillStyle = T.color; g.strokeStyle = '#0a1932'; g.lineWidth = 1.5;
            g.beginPath(); g.arc(s.x, s.y, r, 0, Math.PI * 2); g.fill(); g.stroke();
            if (_wm.zoom >= 4 || T.size >= 3 || p === _wm.sel) {
                if (_wm.chart) {
                    g.lineWidth = 3; g.strokeStyle = 'rgba(255,255,255,0.85)'; g.strokeText(p.name, s.x + r + 3, s.y);
                    g.fillStyle = '#16283c'; g.fillText(p.name, s.x + r + 3, s.y);
                } else {
                    g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillText(p.name, s.x + r + 3.5, s.y + 1);
                    g.fillStyle = '#ffffff'; g.fillText(p.name, s.x + r + 3, s.y);
                }
            }
        }
    } else if (!_wm.portsBusy) {
        _wm.portsBusy = true;
        setTimeout(() => { worldBuildPorts(); _wm.portsBusy = false; worldMapRedraw(true); }, 30);
    }
    // 自動航行の航路（49-autopilot.js）
    const rp = (typeof autopilotRoutePoints === 'function') ? autopilotRoutePoints() : null;
    if (rp && rp.length > 1) {
        g.save();
        g.strokeStyle = _wm.chart ? '#c0208a' : '#ff5ad0'; g.lineWidth = 2; g.setLineDash([]);
        g.beginPath();
        let prevX = null;
        rp.forEach((q, i) => {
            const s = _wmToScreen(q.lat, q.lon, cv);
            // 経度 ±180 をまたぐ所は線を切る
            if (i === 0 || (prevX !== null && Math.abs(s.x - prevX) > W / 2)) g.moveTo(s.x, s.y); else g.lineTo(s.x, s.y);
            prevX = s.x;
        });
        g.stroke();
        // タグの付き添いで通る狭い水路（橙の破線）
        if (rp.some(q => q.narrow)) {
            g.strokeStyle = '#ff9f1a'; g.lineWidth = 3; g.setLineDash([5, 3]);
            g.beginPath();
            for (let i = 1; i < rp.length; i++) {
                if (!rp[i].narrow) continue;
                const a = _wmToScreen(rp[i - 1].lat, rp[i - 1].lon, cv), b = _wmToScreen(rp[i].lat, rp[i].lon, cv);
                if (Math.abs(a.x - b.x) > W / 2) continue;
                g.moveTo(a.x, a.y); g.lineTo(b.x, b.y);
            }
            g.stroke(); g.setLineDash([]);
            g.strokeStyle = _wm.chart ? '#c0208a' : '#ff5ad0';
        }
        g.fillStyle = g.strokeStyle;
        for (const q of rp) if (q.wp) { const s = _wmToScreen(q.lat, q.lon, cv); g.beginPath(); g.arc(s.x, s.y, 3, 0, Math.PI * 2); g.fill(); }
        g.restore();
    }
    // 選んだ海域（＋）と、自動航行で向かっている海域（旗）
    const mark = (q, flag) => {
        const s = _wmToScreen(q.lat, q.lon, cv);
        g.save(); g.translate(s.x, s.y);
        g.strokeStyle = _wm.chart ? '#c0208a' : '#ff5ad0'; g.fillStyle = g.strokeStyle; g.lineWidth = 2;
        if (flag) { g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -16); g.stroke(); g.beginPath(); g.moveTo(0, -16); g.lineTo(10, -12); g.lineTo(0, -8); g.closePath(); g.fill(); }
        else { g.beginPath(); g.arc(0, 0, 7, 0, Math.PI * 2); g.moveTo(-11, 0); g.lineTo(11, 0); g.moveTo(0, -11); g.lineTo(0, 11); g.stroke(); }
        g.restore();
    };
    if (_wm.selPt) mark(_wm.selPt, false);
    if (typeof autopilot !== 'undefined' && autopilot.dest && autopilot.dest.point && (autopilot.active || autopilot.planning)) mark(autopilot.dest, true);
    // 船
    if (world.mode === 'world') {
        const ll = worldShipLatLon();
        const s = _wmToScreen(ll.lat, ll.lon, cv);
        g.save(); g.translate(s.x, s.y); g.rotate((typeof worldTrueCompass === 'function' ? worldTrueCompass() : worldCompass(physics.heading)) * Math.PI / 180);
        g.fillStyle = '#ffffff'; g.strokeStyle = '#ff3b30'; g.lineWidth = 2;
        g.beginPath(); g.moveTo(0, -11); g.lineTo(7, 8); g.lineTo(0, 4); g.lineTo(-7, 8); g.closePath(); g.fill(); g.stroke();
        g.restore();
    }
    if (st && _wm.base && world.mode === 'ocean') st.textContent = '「海だけ」モード中：港を選んで「この港から出航」すると、世界を航海するモードになります';
    else if (st && _wm.base) st.textContent = '';
}
window.worldMapRedraw = worldMapRedraw;

function toggleWorldMap(open) {
    _wmEnsureDom();
    _wm.open = (typeof open === 'boolean') ? open : !_wm.open;
    document.getElementById('world-panel').classList.toggle('open', _wm.open);
    if (_wm.open) {
        if (world.mode === 'world' && !_wm._centered) { const ll = worldShipLatLon(); _wm.cx = ll.lon; _wm.cy = ll.lat; _wm.zoom = 8; _wm._centered = true; }
        _wmShowInfo();
        setTimeout(() => worldMapRedraw(), 0);
    }
}
window.toggleWorldMap = toggleWorldMap;

// 世界地図を開いている間は、船の位置の印を時々更新する
setInterval(() => { if (_wm.open && world.mode === 'world') worldMapRedraw(true); }, 1000);
