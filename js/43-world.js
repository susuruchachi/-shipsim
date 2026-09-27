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
    fishing: { label: '漁港',     suffix: '漁港', color: '#7ee39a', size: 1, depth: 8, basin: 260, pier: 70 },
    town:    { label: '港町',     suffix: '港',   color: '#ffe38a', size: 2, depth: 12, basin: 380, pier: 10 },
    city:    { label: '港湾都市', suffix: '港',   color: '#ffb36b', size: 3, depth: 18, basin: 640, pier: 10 },
    cargo:   { label: '貨物港',   suffix: '貨物港', color: '#8cc6ff', size: 3, depth: 18, basin: 760, pier: 10 },
    naval:   { label: '軍港',     suffix: '軍港', color: '#ff7a7a', size: 2, depth: 16, basin: 620, pier: 270 },
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
// 物理の面の点 (x=東, z=北)[m] → 球の点
function worldLocalToUnit(x, z, out) {
    const F = worldFrame();
    const a = x / WORLD_R, b = z / WORLD_R;
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
    out.x = WORLD_R * (u.x * F.E.x + u.y * F.E.y + u.z * F.E.z) / d;
    out.z = WORLD_R * (u.x * F.N.x + u.y * F.N.y + u.z * F.N.z) / d;
    return out;
}
// 物理の面の点の高さ[m]（oct を省くと一番細かく）
const _wTmpU = {};
function worldHeightAtLocal(x, z, oct) {
    worldLocalToUnit(x, z, _wTmpU);
    return worldHeightFromE(worldNoiseE(_wTmpU.x, _wTmpU.y, _wTmpU.z, oct || WORLD_OCT_FULL));
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
function worldShipDraft() {
    const hp = window.hullProfile;
    const sy = (typeof shipGroup !== 'undefined' && shipGroup) ? Math.abs(shipGroup.scale.y) || 1 : 1;
    if (hp && hp.ready && hp.designWaterlineY > hp.keelY) return (hp.designWaterlineY - hp.keelY) * sy;
    return 0.4 * (physics.scale || 1);
}
window.worldShipDraft = worldShipDraft;

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
        const depthAt = (d) => { const u = unitAt(d); return -worldHeightFromE(worldNoiseE(u.x, u.y, u.z, 16)); };
        for (let d = mouth + halfLen + 60; d < 15000; d += 100) {
            off = d;
            if (depthAt(d - halfLen) > need && depthAt(d) > need && depthAt(d + halfLen) > need) break;
        }
    }
    const ll = worldUnitToLatLon(unitAt(off));
    world.mode = 'world';
    world.ref = { lat: ll.lat, lon: ll.lon };
    _wFrameCache = null;
    physics.cgWorldX = 0; physics.cgWorldZ = 0;
    physics.heading = port.seaBearing;
    physics.speed = 0; physics.targetSpeed = 0; physics.turnRate = 0;
    physics.telegraphState = 0;
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

function _wmColor(e) {
    const h = worldHeightFromE(e);
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
// 緯度・経度の範囲を絵にする（少しずつ。終わったら done(canvas)）
function _wmRender(w, h, lon0, lon1, lat0, lat1, oct, done) {
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const g = cv.getContext('2d'), img = g.createImageData(w, h), D = img.data;
    const job = ++_wm.job;
    let row = 0;
    const u = {};
    const step = () => {
        if (job !== _wm.job && oct !== WORLD_OCT_MAP - 2) return;   // 新しい作り直しが始まった（全体図は止めない）
        const t0 = performance.now();
        while (row < h && performance.now() - t0 < 12) {
            const lat = lat1 - (row + 0.5) / h * (lat1 - lat0);
            for (let x = 0; x < w; x++) {
                const lon = lon0 + (x + 0.5) / w * (lon1 - lon0);
                worldLatLonToUnit(lat, lon, u);
                const c = _wmColor(worldNoiseE(u.x, u.y, u.z, oct));
                const o = (row * w + x) * 4;
                D[o] = c[0]; D[o + 1] = c[1]; D[o + 2] = c[2]; D[o + 3] = 255;
            }
            row++;
        }
        if (row < h) { setTimeout(step, 0); if ((row & 15) === 0) { g.putImageData(img, 0, 0); done(cv, false); } return; }
        g.putImageData(img, 0, 0);
        done(cv, true);
    };
    step();
}

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
    _wmShowInfo();
    worldMapRedraw(true);
}
function _wmShowInfo() {
    const el = document.getElementById('wp-info');
    if (!el) return;
    const p = _wm.sel;
    if (!p) { el.style.display = 'none'; return; }
    const T = PORT_TYPES[p.type];
    let dist = '';
    if (world.mode === 'world') {
        const ll = worldShipLatLon();
        dist = `　今の場所から ${(worldDistance(ll.lat, ll.lon, p.lat, p.lon) / 1852).toFixed(0)} 海里`;
    }
    el.style.display = 'block';
    el.innerHTML = `<div class="wp-pname"><i style="background:${T.color}"></i>${p.name}</div>
        <div class="wp-pmeta">${T.label}・${worldFmtLatLon(p.lat, p.lon)}${dist}</div>
        <div class="wp-pbtns"><button onclick="worldStartAtPort(world.ports.find(q => q.id === '${p.id}')); toggleWorldMap(false);">⚓ この港から出航</button>
        <button onclick="_wm.sel=null;_wmShowInfo();worldMapRedraw(true)">閉じる</button></div>`;
}
window._wmShowInfo = _wmShowInfo;
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
    g.fillStyle = '#0d2a44'; g.fillRect(0, 0, W, H);
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
    // 緯線・経線
    g.strokeStyle = 'rgba(255,255,255,0.12)'; g.lineWidth = 1;
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
                g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillText(p.name, s.x + r + 3.5, s.y + 1);
                g.fillStyle = '#ffffff'; g.fillText(p.name, s.x + r + 3, s.y);
            }
        }
    } else if (!_wm.portsBusy) {
        _wm.portsBusy = true;
        setTimeout(() => { worldBuildPorts(); _wm.portsBusy = false; worldMapRedraw(true); }, 30);
    }
    // 船
    if (world.mode === 'world') {
        const ll = worldShipLatLon();
        const s = _wmToScreen(ll.lat, ll.lon, cv);
        g.save(); g.translate(s.x, s.y); g.rotate((physics.heading || 0) * Math.PI / 180);
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
