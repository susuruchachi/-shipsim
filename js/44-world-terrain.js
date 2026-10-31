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
    const dBox = p.real && typeof _rwDetailBoxOf === 'function' && _RW ? _rwDetailBoxOf(p.lat, p.lon) : null;     // （細かい地形をまだ読んでいなくても）
    const detail = !!dBox;
    // measured：実測の水深の港（岸壁の前も掘らない。測った深さのまま）
    return { id: p.id, type: p.type, real: !!p.real, detail, measured: !!(dBox && dBox.measured), x: loc.x, z: loc.z, sx: -Math.sin(br), sz: Math.cos(br),
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
            if (S.measured) continue;
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
    worldWorkerSync(terrain.worker, terrain.rwWin = worldWorkerWindow());
    terrain.worker.onmessage = (ev) => _trOnHeights(ev.data);
    return terrain.worker;
}

// 海は海底も網にする（この深さ[m]まで。波の谷や水中から海底が見え、座礁した船が海底に載って見える。
// 潜水艦で潜っても海底が見えるように 100m まで）
const TR_SEABED = -100;
// これより深いマス（4 隅とも）は、カメラが水の上にあるときは描かない（海面は不透明で見えない）
const TR_DEEP = -12;
// 網を分ける区画の数（1 辺）。画面に入らない区画は描かない
const TR_CHUNKS = 4;
let _trSeeDeep = false;
// 海底の網を作る・描く深さ（正の値[m]）。ふだんは TR_SEABED まで。沈んでいく船・深く潜った潜水艦の船底（とカメラ）が
// 深くなったら、その 100m 下まで（_trSeabedCut）。地形の材質の「これより深い所は描かない」もこれに合わせる
const _trSeabedU = { value: TR_SEABED };
// カメラが水の中（潜水艦の視点・波の谷の下など）にあるときだけ、深い海底まで描く
function _trDeepRange() {
    const wy = Number.isFinite(window._physicsWaveY) ? window._physicsWaveY : 0;
    // 海面を非表示にしているときも、海底をぜんぶ描く
    const see = (typeof userWaterVisible !== 'undefined' && !userWaterVisible) || (typeof camera !== 'undefined' && camera && camera.position.y < wy + 3);
    if (see === _trSeeDeep) return;
    _trSeeDeep = see;
    for (const m of [terrain.near, terrain.far, terrain.fine]) {
        if (!m) continue;
        for (const c of m.children) { const g = c.geometry; if (g && g.userData.nAll) g.setDrawRange(0, see ? g.userData.nAll : g.userData.nShallow); }
    }
}
// ── 地面の材質：海底の網より深い所は描かない ──
let _trMat = null;
// 街明かりに照らされた地面（夜）：70-night-sky.js が、まわり 30km の灯りの明るさの絵（tex）・その範囲（box：x0, z0, 1/幅, 中心からの丸みの補正用の半幅）・
// 明るさ（k）を入れる。陸（本当の高さ 0.6m 以上）だけを、升目ごとにまだらに光らせる
const _trCityU = { tex: { value: null }, box: { value: new THREE.Vector4(0, 0, 0, 0) }, k: { value: 0 }, win: { value: 0 } };
window._trCityU = _trCityU;
function _trMaterial() {
    if (_trMat) return _trMat;
    _trMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
    _trMat.onBeforeCompile = (sh) => {
        sh.uniforms.uTrSeabed = _trSeabedU;
        sh.uniforms.uCityTex = _trCityU.tex; sh.uniforms.uCityBox = _trCityU.box; sh.uniforms.uCityK = _trCityU.k;
        sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying float vTrY;\nvarying vec2 vTrXZ;')
            .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n    vec4 trWp = modelMatrix * vec4(transformed, 1.0);\n    vTrY = trWp.y; vTrXZ = trWp.xz;');
        sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
varying float vTrY;
varying vec2 vTrXZ;
uniform float uTrSeabed;
uniform sampler2D uCityTex;
uniform vec4 uCityBox;
uniform float uCityK;
float trCityHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float trCityNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(trCityHash(i), trCityHash(i + vec2(1.0, 0.0)), f.x), mix(trCityHash(i + vec2(0.0, 1.0)), trCityHash(i + vec2(1.0, 1.0)), f.x), f.y);
}`)
            .replace('void main() {', 'void main() {\n    if (vTrY < uTrSeabed) discard;')
            .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
    if (uCityK > 0.0) {
        vec2 cuv = (vTrXZ - uCityBox.xy) * uCityBox.z;
        vec2 dc = vTrXZ - uCityBox.xy - vec2(uCityBox.w);
        float hTrue = vTrY + dot(dc, dc) / 12742000.0;          // 惑星の丸みで下げた分を戻す
        if (hTrue > 0.6 && cuv.x > 0.0 && cuv.y > 0.0 && cuv.x < 1.0 && cuv.y < 1.0) {
            // 街の明るさを、なめらかなまだらに（明るい通り・暗い公園や畑）
            float m = 0.25 + 1.6 * trCityNoise(vTrXZ / 110.0) * (0.35 + trCityNoise(vTrXZ / 37.0 + 7.3));
            totalEmissiveRadiance += texture2D(uCityTex, cuv).rgb * (uCityK * m * smoothstep(0.6, 2.0, hTrue));
        }
    }`);
    };
    _trMat.customProgramCacheKey = () => 'worldTerrain';
    noShipLightProbe(_trMat);
    return _trMat;
}
// 遠くの網の材質：近くの網と重なる縁の帯では、奥に描く（近くの網が勝つように：02 の depthBiasMaterial）
let _trMatFar = null;
function _trMaterialFar() {
    if (_trMatFar) return _trMatFar;
    _trMatFar = _trMaterial().clone();
    _trMatFar.onBeforeCompile = _trMaterial().onBeforeCompile;
    _trMatFar.customProgramCacheKey = () => 'worldTerrain';
    _trMatFar.userData = {}; noShipLightProbe(_trMatFar);
    depthBiasMaterial(_trMatFar, 0.0008);
    return _trMatFar;
}
// 港のそばの細かい網の材質：重なる所では手前に描く（粗い網と同じ高さの陸で、ちらつかないように）
let _trMatFine = null;
function _trMaterialFine() {
    if (_trMatFine) return _trMatFine;
    _trMatFine = _trMaterial().clone();
    _trMatFine.onBeforeCompile = _trMaterial().onBeforeCompile;
    _trMatFine.customProgramCacheKey = () => 'worldTerrain';
    _trMatFine.userData = {}; noShipLightProbe(_trMatFine);
    // （画素ごとに奥行きを書く材質には polygonOffset が効かないので、奥行きそのものを 0.05% 手前に：02 の depthBiasMaterial）
    depthBiasMaterial(_trMatFine, -0.0005);
    return _trMatFine;
}
// 高さ・傾き → 色
// なめらかな値ノイズ（升目の角の乱数を補間。0〜1）：海底・草地のまだらに使う
function _trHash(i, j) { let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
function _trVNoise(x, z) {
    const i = Math.floor(x), j = Math.floor(z), fx = x - i, fz = z - j;
    const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
    const a = _trHash(i, j), b = _trHash(i + 1, j), c = _trHash(i, j + 1), d = _trHash(i + 1, j + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function _trColor(h, slope, x, z, out, o) {
    let r, g, b;
    if (h < -0.5) {
        // 浅い海の海底（TR_SEABED まで網を作る）：急な所は岩、ほかは砂・泥（深いほど暗く）。まだらは不規則なノイズで、
        // 岩の色へはなめらかに移る（以前は sin の積で、約 500m おきに同じ形の暗い楕円（岩の色）がくっきり並び、
        // 海底の下にもう一枚別の海底が透けて見えるようだった）
        const mott = 0.55 * _trVNoise(x / 420, z / 420) + 0.3 * _trVNoise(x / 130 + 17.3, z / 130 + 5.1) + 0.15 * _trVNoise(x / 45 + 3.7, z / 45 + 9.2);
        const k = 1 - Math.min(0.55, -h / 60);
        const rk = Math.min(1, smoothstep(0.09, 0.2, slope) + 0.45 * smoothstep(0.62, 0.8, mott));
        const sr = 0.66 - 0.1 * mott, sg = 0.61 - 0.08 * mott, sb = 0.46 - 0.05 * mott;
        r = (sr + (0.44 - sr) * rk) * k; g = (sg + (0.42 - sg) * rk) * k; b = (sb + (0.37 - sb) * rk) * k;
    }
    else if (h < 1.2) { if (_RW) { r = 0.52; g = 0.55; b = 0.40; } else { r = 0.78; g = 0.72; b = 0.54; } }   // 砂浜（現実世界は干潟・湿地の色）
    else if (slope > 0.75) { r = 0.42; g = 0.40; b = 0.37; }             // 岩肌
    else if (h > 1800) { r = 0.93; g = 0.94; b = 0.96; }                 // 雪
    else if (h > 1100) { r = 0.50; g = 0.48; b = 0.42; }                  // 高地
    else {
        const f = 0.65 * _trVNoise(x / 900 + 41.7, z / 900 + 13.3) + 0.35 * _trVNoise(x / 260 + 7.1, z / 260 + 29.5);   // 草地と林のまだら
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
        // 岸壁（すぐそばの陸が 0.6m より高く、この水の点が 1.5m より深い）の前の水の点も線の上へ：陸の点（線の上）から
        // 升目 1 つ先の深い水の点まで下る斜面が、岸壁の前に水面から出たぎざぎざの歯のように並んでいた
        let quayW = false;
        if (w && H[k] < -1.5) for (let b = -1; b <= 1 && !quayW; b++) for (let a = -1; a <= 1; a++) if (H[k + b * n + a] > 0.6) { quayW = true; break; }
        if ((!w && (bs < 0 || bd < 2)) || (w && (bs > 0 || quayW))) { P[k * 3] = bx; P[k * 3 + 2] = bz; }
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
    const segs = [];        // 壁を置いた線分（物理の岸壁にも使う：_trQuayIndex）[ax, az, bx, bz, 陸の側の向き nx, nz, 上の高さ]
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
            segs.push(ax, az, bx, bz, nx, nz, Math.min(ta, tb));
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
        depthBiasMaterial(m, -0.001);
        _trQuayWalls.mat = m;
    }
    const mesh = new THREE.Mesh(geo, _trQuayWalls.mat);
    mesh.receiveShadow = true; mesh.userData.noLightBake = true;
    mesh.userData.quaySegs = segs;
    return mesh;
}
// ── 物理の岸壁（見えている岸壁と同じ線）──
// 岸壁の壁を置いた線分（_trQuayWalls）を升目の索引にしておき、worldSeabedAt で、その線の近くでは線のどちら側かで
// 陸（岸壁の上の高さ）か水（線から 12m 沖の深さ）かを決める。地形の高さの格子（10m）のままだと、斜めの岸壁は
// 升目の階段（±4m ほど）になり、見えている岸壁より出っ張った所に船体が当たり、着岸した船が岸壁から離れて止まっていた
const QW_CELL = 16, QW_BAND = 12;
function _trQuayIndex(mesh) {
    terrain.quay = null;
    let qs = null;
    if (mesh) mesh.traverse(o => { if (o.userData && o.userData.quaySegs && o.userData.quaySegs.length) qs = o.userData.quaySegs; });
    if (!qs) return;
    const grid = new Map(), N = qs.length / 7;
    for (let i = 0; i < N; i++) {
        const ax = qs[i * 7], az = qs[i * 7 + 1], bx = qs[i * 7 + 2], bz = qs[i * 7 + 3];
        const i0 = Math.floor((Math.min(ax, bx) - QW_BAND) / QW_CELL), i1 = Math.floor((Math.max(ax, bx) + QW_BAND) / QW_CELL);
        const j0 = Math.floor((Math.min(az, bz) - QW_BAND) / QW_CELL), j1 = Math.floor((Math.max(az, bz) + QW_BAND) / QW_CELL);
        for (let j = j0; j <= j1; j++) for (let ii = i0; ii <= i1; ii++) { const k = ii + ',' + j; let A = grid.get(k); if (!A) grid.set(k, A = []); A.push(i); }
    }
    terrain.quay = { segs: qs, grid };
}
// (x, z) にいちばん近い岸壁の線分：符号付きの距離 d（＋：陸の側）と、その線分の陸の側の向き・上の高さ。線分の端の外・帯の外は null
const _qwOut = { d: 0, nx: 0, nz: 0, top: 0 };
function _trQuayNear(x, z) {
    const Q = terrain.quay;
    if (!Q) return null;
    const A = Q.grid.get(Math.floor(x / QW_CELL) + ',' + Math.floor(z / QW_CELL));
    if (!A) return null;
    const S = Q.segs;
    let bd = QW_BAND, bi = -1, bs = 0;
    for (const i of A) {
        const ax = S[i * 7], az = S[i * 7 + 1], dx = S[i * 7 + 2] - ax, dz = S[i * 7 + 3] - az, L2 = dx * dx + dz * dz || 1e-9;
        const u = ((x - ax) * dx + (z - az) * dz) / L2;
        if (u < -0.02 || u > 1.02) continue;
        const d = (x - ax) * S[i * 7 + 4] + (z - az) * S[i * 7 + 5];
        if (Math.abs(d) < bd) { bd = Math.abs(d); bi = i; bs = d; }
    }
    if (bi < 0) return null;
    _qwOut.d = bs; _qwOut.nx = S[bi * 7 + 4]; _qwOut.nz = S[bi * 7 + 5]; _qwOut.top = S[bi * 7 + 6];
    return _qwOut;
}
function _trBuildMesh(H, n, half, cx, cz, lowerInside, opts) {
    const geo = new THREE.BufferGeometry();
    const P = new Float32Array(n * n * 3), Cc = new Float32Array(n * n * 3), Hr = new Float32Array(n * n);
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
            P[k * 3] = x; P[k * 3 + 1] = h - d2 / (2 * WORLD_R); P[k * 3 + 2] = z; Hr[k] = h;
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
    // 網は TR_CHUNKS × TR_CHUNKS の区画に分け、区画ごとに別の三角形の並び（頂点は共有）にする。
    // 船を中心にした 1 枚の網だと、カメラの後ろ・画面の外の部分まで毎フレーム全部描いていた。区画に分ければ、
    // three.js が画面に入らない区画を描かずに済ませる（区画ごとの外接球で判定）。
    // 区画の中は、陸と浅い所のマスを先に、深い海底（4 隅とも TR_DEEP より深いマス）を後ろに並べる。海面は不透明なので、
    // カメラが水の上にあるときは深い海底は見えない：描く範囲（drawRange）を浅い所までにする（_trDeepRange）。
    // 港のまわりでは地形の三角形の半分ほどが深い海底で、毎フレーム数十万の三角形を無駄に描いていた
    const C = TR_CHUNKS, cells = n - 1, per = Math.ceil(cells / C);
    const lists = [];
    for (let q = 0; q < C * C; q++) lists.push({ sh: [], dp: [] });
    let total = 0;
    for (let j = 0; j < cells; j++) {
        for (let i = 0; i < cells; i++) {
            const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
            const top = Math.max(P[a * 3 + 1], P[b * 3 + 1], P[c * 3 + 1], P[d * 3 + 1]);
            if (top < _trSeabedU.value) continue;
            if (nearW && !(nearW[a] || nearW[b] || nearW[c] || nearW[d])) continue;
            const L = lists[Math.min(C - 1, (j / per) | 0) * C + Math.min(C - 1, (i / per) | 0)];
            // （深さは丸みで下げる前の高さで見る。遠くは丸みで何十 m も下がっているが、陸は陸）
            (Math.max(Hr[a], Hr[b], Hr[c], Hr[d]) < TR_DEEP ? L.dp : L.sh).push(a, c, b, b, c, d);
            total += 6;
        }
    }
    if (!total) return null;
    // 法線は網全体で一度だけ（区画の境目で陰がずれないように）
    const posA = new THREE.BufferAttribute(P, 3), colA = new THREE.BufferAttribute(Cc, 3);
    {
        const all = new (n * n > 65535 ? Uint32Array : Uint16Array)(total); let o = 0;
        for (const L of lists) { all.set(L.sh, o); o += L.sh.length; all.set(L.dp, o); o += L.dp.length; }
        geo.setAttribute('position', posA); geo.setIndex(new THREE.BufferAttribute(all, 1)); geo.computeVertexNormals();
    }
    const nrmA = geo.getAttribute('normal');
    geo.dispose();
    const mat = opts && opts.coastOnly ? _trMaterialFine() : opts && opts.far ? _trMaterialFar() : _trMaterial();
    const m = new THREE.Group();
    m.name = 'terrain';
    for (let q = 0; q < C * C; q++) {
        const L = lists[q], cnt = L.sh.length + L.dp.length;
        if (!cnt) continue;
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', posA); g.setAttribute('color', colA); g.setAttribute('normal', nrmA);
        const ix = new (n * n > 65535 ? Uint32Array : Uint16Array)(cnt); ix.set(L.sh, 0); ix.set(L.dp, L.sh.length);
        g.setIndex(new THREE.BufferAttribute(ix, 1));
        // 外接球は、この区画の点だけから（共有の頂点全体から測ると、網全体の大きさになって画面外でも描かれる）
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
        for (let k = 0; k < cnt; k++) {
            const v = ix[k] * 3, x = P[v], y = P[v + 1], z = P[v + 2];
            if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
        }
        g.boundingBox = new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1));
        g.boundingSphere = new THREE.Sphere(new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), 0.5 * Math.hypot(x1 - x0, y1 - y0, z1 - z0));
        g.userData.nShallow = L.sh.length; g.userData.nAll = cnt;
        g.setDrawRange(0, _trSeeDeep ? cnt : L.sh.length);
        const cm = new THREE.Mesh(g, mat);
        cm.receiveShadow = true; cm.castShadow = false;
        cm.userData.noLightBake = true; cm.userData.noBloom = true; cm.userData.terrainChunk = true;
        m.add(cm);
    }
    // 岸壁・桟橋の縁（細かい網だけ）
    if (coastLines && opts.quayWalls) { const qw = _trQuayWalls(coastLines, H, n, step, cx, cz, opts.detail); if (qw) { qw.userData.noBloom = true; m.add(qw); } }
    m.userData.noLightBake = true; m.userData.noBloom = true;      // 地面は光らない（ブルームに入れない）
    if (typeof bloomTargetsDirty === 'function') bloomTargetsDirty();
    return m;
}

function _trDispose(m) {
    if (!m) return;
    if (m.parent) m.parent.remove(m);
    if (m.geometry) m.geometry.dispose();
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
        terrain.nearH = terrain.farH = terrain.fineH = null;
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
    else { _trDispose(terrain.fine); terrain.fine = null; terrain.quay = null; terrain.fineH = null; }
    w.postMessage({ id, which: 'near', frame, n: TR_NEAR.n, half: TR_NEAR.half, cx, cz, oct: WORLD_OCT_FULL, shapes });
    w.postMessage({ id, which: 'far', frame, n: TR_FAR.n, half: TR_FAR.half, cx, cz, oct: 15, shapes: [] });
}
function _trOnHeights(msg) {
    if (msg.id !== terrain.reqId || world.mode !== 'world' || !terrain.center) return;
    const { x: cx, z: cz } = terrain.center;
    if (msg.which === 'near') {
        terrain.nearH = { H: msg.H, n: TR_NEAR.n, half: TR_NEAR.half, cx, cz, id: msg.id };
        _brkBuild(terrain.nearH);
        _trSeabedTex(terrain.nearH);
        _trDispose(terrain.near);
        terrain.near = _trBuildMesh(msg.H, TR_NEAR.n, TR_NEAR.half, cx, cz, terrain.fineOn ? { cx, cz, half: TR_FINE.half, waterOnly: true } : null, { smoothCoast: true });
        if (terrain.near) scene.add(terrain.near);
    } else if (msg.which === 'fine') {
        _trDispose(terrain.fine);
        const ll = worldUnitToLatLon(worldLocalToUnit(cx, cz));
        terrain.fine = _trBuildMesh(msg.H, TR_FINE.n, TR_FINE.half, cx, cz, null, { coastOnly: 10, smoothCoast: true, quayWalls: true, detail: _rwDetailOf(ll.lat, ll.lon) || (typeof _hdNearDetail === 'function' ? _hdNearDetail(cx, cz) : null) });
        terrain.fineH = { H: msg.H, n: TR_FINE.n, half: TR_FINE.half, cx, cz, id: msg.id };   // 街明かり（70-night-sky.js）が岸壁の上に灯りを置くのに使う
        _trQuayIndex(terrain.fine);
        if (terrain.fine) scene.add(terrain.fine);
    } else {
        _trDispose(terrain.far);
        terrain.far = _trBuildMesh(msg.H, TR_FAR.n, TR_FAR.half, cx, cz, { cx, cz, half: TR_NEAR.half }, { far: true });
        if (terrain.far) scene.add(terrain.far);
        terrain.farH = { H: msg.H, n: TR_FAR.n, half: TR_FAR.half, cx, cz, id: msg.id };
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
        if (key === 'bld') _pWindowLights(m);
        _pMats[key] = m;
    }
    return _pMats[key];
}
// 港の建物の窓：夜は、階（3.4m）ごと・窓（2.6m）ごとに、ところどころ灯りがともる（70-night-sky.js が _trCityU.win に夜の明るさを入れる）
function _pWindowLights(m) {
    m.onBeforeCompile = (sh) => {
        sh.uniforms.uWin = _trCityU.win;
        sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vBwp;\nvarying vec3 vBn;')
            .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
    vec4 bwp = vec4(transformed, 1.0);
    vec3 bn = objectNormal;
    #ifdef USE_INSTANCING
        bwp = instanceMatrix * bwp; bn = mat3(instanceMatrix) * bn;
    #endif
    vBwp = (modelMatrix * bwp).xyz; vBn = normalize(mat3(modelMatrix) * bn);`);
        sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
varying vec3 vBwp;
varying vec3 vBn;
uniform float uWin;
float pWinHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`)
            .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
    if (uWin > 0.0 && abs(vBn.y) < 0.5) {
        float u = dot(vBwp.xz, vec2(-vBn.z, vBn.x)) / 2.6, v = (vBwp.y - 1.0) / 3.4;
        vec2 cell = floor(vec2(u, v)), f = fract(vec2(u, v));
        float win = step(0.18, f.x) * step(f.x, 0.82) * step(0.3, f.y) * step(f.y, 0.8) * step(0.0, v);
        float h = pWinHash(cell + floor(vBwp.xz / 40.0) * 13.1);
        float lit = step(0.55, h);
        vec3 wc = mix(vec3(1.0, 0.72, 0.42), vec3(0.85, 0.92, 1.0), step(0.85, h));
        totalEmissiveRadiance += wc * (win * lit * uWin * (0.5 + 0.8 * pWinHash(cell + 3.7)));
    }`);
    };
    m.customProgramCacheKey = () => 'portBldWin';
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
// 港の施設の当たり判定（港の座標系の四角 [a0, a1, b0, b1]：a＝海の方、b＝岸沿い）と、桟橋の横の船の大きさ。
// 乱数は _buildPort と同じ順に引く（r を渡すと、そのまま続きを _buildPort が使う）。
// 自動航行の航路探し（49-autopilot.js）が、まだ建てていない港の桟橋・防波堤もよけられるように、建てずに出せる
function _portLayout(S, r) {
    r = r || _wRng(S.seed);
    const half = S.quayLen / 2, colliders = [], breakwaters = [], ships = [], boats = [];
    if (!S.detail) colliders.push([-S.apron - 20, 6, -half, half]);
    if (S.type !== 'cargo' && !S.real) {
        const R = S.basin * 0.95, gap = S.type === 'fishing' ? 70 : 140;
        for (const side of [-1, 1]) {
            const b0 = side * (half + 40), len = R * 0.8;
            const armLen = Math.max(20, Math.abs(b0) - gap / 2);
            breakwaters.push({ side, b0, len, armLen, gap });
            colliders.push([0, len, b0 - 8, b0 + 8]);
            colliders.push([len - 8, len + 8, Math.min(side * Math.abs(b0), side * (Math.abs(b0) - armLen)), Math.max(side * Math.abs(b0), side * (Math.abs(b0) - armLen))]);
        }
    }
    const PL = _portPierLayout(S.type, S.quayLen), pierLen = PL.len;
    for (const pr of PL.piers) {
        const b = pr.b, w = pr.w;
        colliders.push([0, pierLen, b - w / 2, b + w / 2]);
        for (const side of [-1, 1]) {
            if (S.type === 'naval') {
                const len = 120 + r() * 70, beam = 14 + r() * 5;
                const bb = b + side * (w / 2 + beam / 2 + 3);
                ships.push({ a: pierLen * 0.5, b: bb, len, beam });
                colliders.push([pierLen * 0.5 - len / 2, pierLen * 0.5 + len / 2, bb - beam / 2, bb + beam / 2]);
            } else {
                const len = 14 + r() * 8;
                boats.push({ a: pierLen * 0.55, b: b + side * 6.5, len, color: [0xd8d8d0, 0x2e5d8a, 0xb3352a, 0xe2c14b][Math.floor(r() * 4)] });
            }
        }
    }
    return { colliders, breakwaters, ships, boats, PL, pierLen };
}
// 港の当たり判定（港 p。建てていれば建てた港のもの、まだなら _portLayout で：港ごとに覚えておく）
const _portColCache = new Map();
function worldPortColliders(p) {
    const B = terrain.ports.get(p.id);
    if (B) return B.colliders;
    const key = p.id + ':' + p.seed + ':' + p.type;
    let c = _portColCache.get(key);
    if (!c) { c = _portLayout(_portShape(p)).colliders; _portColCache.set(key, c); }
    return c;
}
window.worldPortColliders = worldPortColliders;
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
    // 当たり判定と、桟橋・防波堤・横付けの船の配置（_portLayout：乱数はここで引く）
    const LY = _portLayout(S, r);
    colliders.push(...LY.colliders);
    // 係船柱（ボラード）：岸壁の縁に 25m おき
    const bollards = [];
    for (let b = -half + 12; b <= half - 12 && !S.detail; b += 25) {
        const q = P(4.5, b);
        bollards.push({ x: q.x, y: 3.35, z: q.z, w: 0.7, h: 0.7, d: 0.7, rot });
    }
    // 防波堤（港の前を囲む。真ん中に出入り口）。現実世界の港は、実際の航路（曲がっている）から入るので作らない
    if (S.type !== 'cargo' && !S.real) {
        const R = S.basin * 0.95, gap = S.type === 'fishing' ? 70 : 140;
        for (const { side, b0, len, armLen } of LY.breakwaters) {
            // 岸から沖へ伸び、先を港の出入り口の方へ曲げる
            addBox(dark, len / 2, b0, -2, len, 8, 16);
            addBox(dark, len, side * (Math.abs(b0) - armLen / 2), -2, 16, 8, armLen);
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
    const pierLen = LY.pierLen;
    for (const pr of LY.PL.piers) {
        const b = pr.b, w = pr.w;
        addBox(S.type === 'naval' ? concrete : wood, pierLen / 2, b, S.type === 'naval' ? -3 : 1.6, pierLen, S.type === 'naval' ? 12 : 1, w);
        for (let a = 15; a < pierLen - 5; a += 25) { const q = P(a, b + w / 2 - 0.6); bollards.push({ x: q.x, y: S.type === 'naval' ? 3.35 : 2.4, z: q.z, w: 0.6, h: 0.6, d: 0.6, rot }); }
    }
    // 桟橋の両側の軍艦（軍港）・漁船（漁港）
    for (const sh of LY.ships) {
        addBox(greyShips, sh.a, sh.b, 2, sh.len, 9, sh.beam);
        addBox(greyShips, sh.a - sh.len * 0.05, sh.b, 9, sh.len * 0.28, 7, sh.beam * 0.6);
        addBox(greyShips, sh.a - sh.len * 0.05, sh.b, 15, sh.len * 0.08, 8, sh.beam * 0.3);
    }
    for (const bt of LY.boats) addBox(boats, bt.a, bt.b, 0.8, bt.len, 2.4, 4.5, { color: bt.color });
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
    // 照明塔の灯り（夜：70-night-sky.js が点にする）：岸壁の縁の少し内側と、荷さばき地の奥に 45m おき（高さ 20m）
    const lamps = [];
    for (let b = -half + 20; b <= half - 20; b += 45) for (const a of [-8, -Math.max(20, (S.apron || 40) * 0.7)]) { const q = P(a, b); lamps.push({ x: q.x, y: 23, z: q.z }); }
    g.userData.lamps = lamps;
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
    terrain.quay = null;
    terrain.center = null;
    terrain.reqId++;
    for (const [, P] of terrain.ports) { scene.remove(P.group); P.group.traverse(o => { if (o.geometry) o.geometry.dispose(); }); }
    terrain.ports.clear();
    terrain.grounded = false;
    terrain.depth = null;
    terrain.nearH = null; terrain.farH = null; terrain.fineH = null;
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
            deepColor: U.deepColor, shallowColor: U.shallowColor, sunDir: U.sunDir, sunColor: U.sunColor, skyReflColor: U.skyReflColor, whitecapU: U.whitecapU, foamColor: U.foamColor,
            windSpeedU: U.windSpeedU, reflectionTex: U.reflectionTex, reflectionStrength: U.reflectionStrength, textureMatrix: U.textureMatrix,
            waterFogColor: U.waterFogColor, waterFogDensity: U.waterFogDensity, uBloomDark: U.uBloomDark,
        },
        // 深度は地形・船・近くの水面と同じ対数深度（04-scene-and-water-init.js の水面と同じ式）にそろえる。
        // 通常の深度のままだと、遠くでは地形の海底（対数深度）のほうが手前と判定されて、水面を突き抜けて見える
        //（v0.03.015.007：三角形が 2km にもなるので、頂点だけで奥行きを決めると三角形の中で大きくずれる。
        //  画素ごとに書ける所（標準の材質と同じ条件）では画素ごとに）
        vertexShader: `
            #ifdef USE_LOGDEPTHBUF
                #ifdef USE_LOGDEPTHBUF_EXT
                    varying float vFragDepthW; varying float vFragPersp;
                #else
                    uniform float logDepthBufFC;
                #endif
            #endif
            uniform mat4 textureMatrix;
            varying vec3 vW;
            varying vec4 vReflectUv;
            void main() {
                vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz;
                vReflectUv = textureMatrix * w;   // 反射の絵の上の位置（近くの水面と同じ）
                gl_Position = projectionMatrix * viewMatrix * w;
                #ifdef USE_LOGDEPTHBUF
                    #ifdef USE_LOGDEPTHBUF_EXT
                        vFragDepthW = 1.0 + gl_Position.w; vFragPersp = projectionMatrix[2][3] == -1.0 ? 1.0 : 0.0;
                    #else
                    if (projectionMatrix[2][3] == -1.0) {
                        gl_Position.z = log2(max(1e-6, gl_Position.w + 1.0)) * logDepthBufFC - 1.0;
                        gl_Position.z *= gl_Position.w;
                    }
                    #endif
                #endif
            }`,
        fragmentShader: `
            uniform vec3 deepColor, shallowColor, sunDir, sunColor, waterFogColor, skyReflColor;
            uniform vec4 whitecapU;   // y＝白波の割合・z＝泡の筋（近くの水面と同じ）
            uniform vec3 foamColor;
            uniform float windSpeedU, reflectionStrength;
            uniform sampler2D reflectionTex;
            uniform float waterFogDensity, uBloomDark;
            varying vec3 vW;
            varying vec4 vReflectUv;
            ${window.WATER_FAR_GLSL || ''}
            #if defined( USE_LOGDEPTHBUF ) && defined( USE_LOGDEPTHBUF_EXT )
                uniform float logDepthBufFC;
                varying float vFragDepthW; varying float vFragPersp;
            #endif
            void main() {
                // 近くの水面より 0.1% 奥（重なる所で近くの水面が勝つように）
                #if defined( USE_LOGDEPTHBUF ) && defined( USE_LOGDEPTHBUF_EXT )
                    gl_FragDepthEXT = vFragPersp < 0.5 ? gl_FragCoord.z : log2(vFragDepthW * 1.001) * logDepthBufFC * 0.5;   // 正投影のカメラでは普通の奥行き
                #endif
                if (uBloomDark > 0.5) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
                vec3 viewDir = normalize(cameraPosition - vW);
                // 近くの水面を遠くから見たときと同じ式（04-scene-and-water-init.js の WATER_FAR_GLSL）。
                // 遠くは斜めに見るので、浅い海でも海底は透けない。空・陸の映り込みは近くの水面と同じ反射の絵から
                vec3 reflCol = texture2D(reflectionTex, clamp(vReflectUv.xy / max(vReflectUv.w, 1e-5), 0.002, 0.998)).rgb;
                vec3 col = waterFarColor(viewDir, reflCol);
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
    // 波の水面（船のまわりの四角）の外の海：どのモードでも（「海だけ」・外洋の真ん中で陸の地形が無いときも）。
    //（以前は世界のモードで陸の地形があるときだけで、ほかでは高い所から見ると、波の水面の四角の外に海が無かった）
    // 海面を非表示にしているときは出さない
    const show = !!(window.world && (world.mode === 'world' || world.mode === 'ocean')) && typeof waterMesh !== 'undefined' && !!waterMesh && waterMesh.visible;
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
        uniforms: { uSize: { value: 18 }, uScale: { value: 400 }, uLight: { value: 1 } },
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
            uniform float uLight;
            void main() {
                vec2 p = gl_PointCoord * 2.0 - 1.0;
                float r = dot(p, p);
                if (r > 1.0) discard;
                gl_FragColor = vec4(vec3(0.93, 0.96, 0.98) * uLight, vA * (1.0 - r) * (1.0 - r));
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
    _brk.pts.material.uniforms.uLight.value = window._fxLight ?? 1;      // 曇天・夜は暗く（12-bloom-...js）
    for (let k = 0; k < _brk.n; k++) {
        const x = _brk.xz[k * 2], z = _brk.xz[k * 2 + 1];
        const d = Math.hypot(x - cam.x, z - cam.z);
        if (d > 5000) { A[k] = 0; continue; }
        const wy = hasH ? getOceanHeight(x, z, t) : 0;
        P[k * 3 + 1] = wy + 0.25;
        // 波の山が来たときだけ白く砕ける（以前は決まった周期で明滅し、いつも白く見えていた）。凪では出さない
        const crest = Math.max(0, Math.min(1, (wy / Math.max(0.3, rough) - 0.15) / 0.6));
        // 近く（波の水面の中）は水のシェーダーの泡で見せるので、点は遠くだけ（近くで大きな白い玉に見えないように）
        A[k] = _brk.base[k] * sea * crest * crest * 0.7 * Math.min(1, (5000 - d) / 1500) * Math.min(1, Math.max(0, (d - 900) / 700));
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
    if (!window.world || world.mode !== 'world') return oceanSeabedAt(x, z);    // 外洋のモード：平均 3000m の海底
    let h = worldHeightAtLocal(x, z, 16, true);      // 岸壁は垂直に（43-world.js の _rwDetailAtSharp）
    const shapes = [];
    for (const [, P] of terrain.ports) shapes.push(P.shape);
    if (shapes.length) h = _portAdjust(h, x, z, shapes);
    // 見えている岸壁の線の近くは、その線で切る（陸の側は岸壁の上の高さ、水の側は線から 12m 沖の深さ）
    const q = terrain.quay ? _trQuayNear(x, z) : null;
    if (q) {
        if (q.d >= 0) h = Math.max(h, q.top);
        else if (h > -1.5) {
            const k = QW_BAND + q.d;          // 線から 12m 沖まで
            let hw = worldHeightAtLocal(x - q.nx * k, z - q.nz * k, 16, true);
            if (shapes.length) hw = _portAdjust(hw, x - q.nx * k, z - q.nz * k, shapes);
            h = Math.min(h, hw);
        }
    }
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
// その姿勢（重心の位置 x,z と向き h）で、船体がどれだけ底・岸壁に入っているか（0 なら当たっていない）。
// 船底・甲板の点（_gcPoints）を、今の上下・縦・横の傾きのまま（波で持ち上がれば、そのぶん船底も上がる）その位置へ置いて調べる。
// 以前は高さを船の下の波の高さ（±6m まで）と設計の喫水で決めていて、波で船体が持ち上がっても、水面より上に出た浅瀬の点は
// どれも「固い所」として数えていたので、浅瀬の縁に引っかかると、どれだけ持ち上がっても抜け出せなかった。
//  score：海底に触れている・入っている深さの合計、hard：入り込みが段（GC_STEP）より深い点＝横から当たる壁・岸壁
function _trHullScore(x, z, h, off, out) {
    const r = h * Math.PI / 180, fx = Math.sin(r), fz = Math.cos(r), sx = Math.cos(r), sz = -Math.sin(r);
    const ox = x + fx * off.a + sx * off.s, oz = z + fz * off.a + sz * off.s;
    let score = 0, hard = 0;
    const pts = _gcPoints(), ps = _gcPose(r), subY = (window.sub && sub.applied) || 0;
    for (const p of pts) {
        _gcWorld(p, ps, _gcW);
        const b = _gcBed(worldSeabedAt(x + _gcW.x, z + _gcW.z), _gcW.x * ps.sy + _gcW.z * ps.cy);
        const c = b - (physics.y + _gcW.y - subY);       // 正：底（岸壁）が点より上（機関の水流で削れた分は低く：_gcDig）
        if (c > -GC_TOUCH) { score += Math.min(12, c + GC_TOUCH); if (out) out.push({ c, a: p.ma, s: p.ms, d: -p.y, tip: !!p.tip }); }
        if (c > GC_STEP) hard++;
    }
    if (terrain.ports.size) _trHullPoints();
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
// 前の姿勢より悪くなったか（壁・岸壁に入る点が増えた）。浅瀬・斜面に乗り上げるのは止めない：船底を海底が支え
// （groundContactStep）、底に載った重さのぶんの摩擦で止まる
function _trWorse(score, hard, good) { return hard > good.hard; }
// 乗り上げたときの描く姿勢の足し分（physics.groundPitch / groundRoll）。今は物理の姿勢そのものが海底に支えられて
// 傾く（groundContactStep）ので、以前の足し分は 0 へ戻すだけ
function _trGroundAttitude(hits, dt) {
    const k = Math.min(1, (dt || 0) / 2);
    physics.groundPitch = (physics.groundPitch || 0) * (1 - k);
    physics.groundRoll = (physics.groundRoll || 0) * (1 - k);
}
// 沈没した船の、船底と甲板の点（船の姿勢のまま：縦に立つ・裏返る）。いちばん低い所（_trLowestY）に使う
function _trSunkPoints() {
    const D = typeof wtDims === 'function' ? wtDims() : null; if (!D) return [];
    const key = [D.aS, D.aB, D.yBot, D.yDeck, physics.scale].join(',');
    if (_trSunkPoints.c && _trSunkPoints.c.key === key) return _trSunkPoints.c.pts;
    const pts = [];
    for (let i = 0; i <= 8; i++) {
        const a = D.aS + (D.aB - D.aS) * i / 8;
        const hwB = typeof wtHW === 'function' ? wtHW(D.yBot + (D.yDeck - D.yBot) * 0.15, a) : 0;
        const hwD = typeof wtHW === 'function' ? wtHW(D.yDeck, a) : 0;
        pts.push([0, D.yBot, a], [hwB, D.yBot + (D.yDeck - D.yBot) * 0.15, a], [-hwB, D.yBot + (D.yDeck - D.yBot) * 0.15, a], [hwD, D.yDeck, a], [-hwD, D.yDeck, a]);
    }
    _trSunkPoints.c = { key, pts };
    return pts;
}
function _trSunkWorldPts() {
    const root = typeof wtRoot === 'function' ? wtRoot() : null;
    const e = (root || shipGroup).matrixWorld.elements, out = [];
    for (const q of _trSunkPoints()) out.push({
        x: e[0] * q[0] + e[4] * q[1] + e[8] * q[2] + e[12], y: e[1] * q[0] + e[5] * q[1] + e[9] * q[2] + e[13], z: e[2] * q[0] + e[6] * q[1] + e[10] * q[2] + e[14] });
    return out;
}

// ════════════════════════════════════════════════════════════════
//  船体と海底の当たり（物理の刻みごと：17-main-loop.js のサブステップから）
// ════════════════════════════════════════════════════════════════
// 以前は 1 フレームに 1 回、物理の計算が全部終わった後に、海底へ入り込んだ分だけ押し戻していた（1 フレームに動かせる量に
// 上限つき）。時間倍率を上げると、そのフレームの間（サブステップ何十回分）に浮力・重力で深く沈み込んでから押し戻されるので、
// 底に当たるたびにびくびく跳ね、船首だけ乗り上げると、押し戻しが浮力の起こし戻しに負けて海底にめり込んでいた。
// 今は物理の刻み（0.02 秒）ごとに、船の今の姿勢（上下・縦・横の傾き）で船底・舷・甲板の縁の点の高さを出して、
// 海底より下に入った点を、その点に上向きの力（撃力）をかけたときの動き方の割合（船の重さと、縦・横の回りにくさ）で
// 押し戻し、底へ向かう速さを止める。船首だけ当たれば、船首が持ち上がり、船首を支点に船尾が沈む向きに回る。
// 底に載った重さ（浮力で支えきれない分）に比例する摩擦で、船は止まる（深く乗り上げるほど抜け出しにくい）。
// 沈んでいく船・沈んだ船は、底に着いたら浮力の縦のモーメントで起こし直さず、着いた端を支点に倒れて底に横たわる
//（以前は、底に着いた後も波・残った浮力で船尾が持ち上がり、縦に立つことがあった）
const GC_TOUCH = 0.1;    // これだけ離れていても「触れている」[m]（座礁の表示・score）
const GC_STEP = 2.5;     // 1 回にこれより深く入り込んだ点は、下から支えず「横から当たる壁」とする[m]（hard）
const GC_MU = 0.3;       // 船底と海底（砂・泥）の摩擦係数
const _gcW = { x: 0, y: 0, z: 0 };
const _gc = { key: '', pts: [], pin: { x: 0, y: 0, z: 0 }, active: false, iP: 0, iR: 0, contact: false, touchT: -1e9, maxPen: 0, support: 0, C: [],
    HL: 0, digB: 0, digS: 0, digX: 0, digZ: 0, digT: 0 };
// 座礁から自分の機関で抜け出す：機関を回していると、スクリューの水流が船底の下の砂・泥を流して、底が削れていく
//（実際の船も、後進をかけ続けて船底の下の砂を洗い流して離礁する）。後進の水流は船底に沿って前へ流れるので船全体の下
//（digB）、前進の水流は後ろへ流れるので船尾の下だけ（digS）。座礁した所から船の長さだけ離れたら、元に戻す
//（時間で戻すと、まだ浅瀬の上にいる船の下で底が急に戻って、また乗り上げてしまう）
const GC_DIG_RATE = 0.006;  // 全速の機関で底が削れる速さ（喫水の割合／秒：喫水 10m の船で 1 秒に 6cm）
function _gcDig(a) { return _gc.digB + (a < -0.4 * _gc.HL ? _gc.digS : 0); }
// 水の下の海底だけ削る（岸壁・陸の高さはそのまま）
function _gcBed(b, a) { return b < 0 ? b - _gcDig(a) : b; }
// 浸水して重い船（予備浮力の 1/4 を超える水・沈みかけ）は削らない：底が下がっても浮かずに、そのぶん沈むだけなので
function _gcDigBlocked() {
    if (typeof flood === 'undefined') return false;
    const lim = flood.reserveKg > 0 ? 0.25 * flood.reserveKg : 0.05 * (physics.mass || 1) * 1e6;
    return !!(flood.sinking || flood.sunk || (flood.massKg || 0) > lim);
}
// 画面の表示用（17-main-loop.js）：'working' いま機関の水流で底を洗っている／'blocked' 浸水で重い・削れる限り削った
//（機関では抜け出せない）／''
function groundDigState() {
    if (_gcDigBlocked() || _gc.digB >= worldShipDraft() - 1e-3) return 'blocked';
    return (_gc.digT && performance.now() - _gc.digT < 500) ? 'working' : '';
}
window.groundDigState = groundDigState;
function _gcDigUpdate(dt, sup) {
    const cx = physics.cgWorldX || 0, cz = physics.cgWorldZ || 0;
    if (_gc.digB + _gc.digS > 0 && Math.hypot(cx - _gc.digX, cz - _gc.digZ) > 2 * _gc.HL) { _gc.digB = 0; _gc.digS = 0; }
    // 底に載って止まっている間だけ（動き出したら、もう削らない）
    if (Math.abs(physics.speed || 0) > 1 || sup < 0.01 || _gcDigBlocked()) return;
    const ms = Math.max(0.1, physics.maxSpeed || 1);
    const tgt = ((typeof getPropThrustTargetSpeed === 'function') ? getPropThrustTargetSpeed() : (physics.targetSpeed || 0)) * (physics.propImmersion ?? 1);
    const eff = Math.min(1, Math.abs(tgt) / (0.5 * ms));
    if (!(eff > 0.02)) return;
    if (_gc.digB + _gc.digS === 0) { _gc.digX = cx; _gc.digZ = cz; }
    _gc.digT = performance.now();
    const dr = worldShipDraft(), cap = dr, d = GC_DIG_RATE * dr * eff * dt;
    if (tgt < 0) _gc.digB = Math.min(cap, _gc.digB + d); else _gc.digS = Math.min(cap, _gc.digS + d);
}
// 当たりを見る点（ピン＝重心の位置の喫水線を原点にした、船の向きの座標[m]：x 横（+ が左舷）・y 上・z 前）。
// 船体の形（22-hull-shape.js）から、前後 13 か所の船底（その位置まで届いているいちばん低い段：船首・船尾で船底が上がる所も）・
// 船底の丸み・舷の中ほど・甲板の縁と、船首・船尾の先。ma・ms：模型の原点からの前後・横[m]（穴の位置：64-damage.js）
function _gcPoints() {
    const hp = window.hullProfile, sc = physics.scale || 1, pin = _gc.pin;
    const D = (hp && hp.ready && hp.shape && typeof wtDims === 'function') ? wtDims() : null;
    const rot = (D && typeof wtRotM === 'function') ? wtRotM() : null;
    const key = [pin.x, pin.y, pin.z, sc, D ? [D.aS, D.aB, D.yBot, D.yDeck].join(',') : 'none', rot ? rot.elements[0].toFixed(5) + ',' + rot.elements[8].toFixed(5) : '', hp && hp.ready ? hp.halfLen : 0].join('|');
    if (_gc.key === key) return _gc.pts;
    const pts = [];
    if (D && rot && typeof wtHW === 'function') {
        const S = hp.shape, e = rot.elements;
        const add = (p, y, a, tip) => {
            // 船体の座標 → 模型の座標（向きの補正）→ m → ピンから
            const mx = (e[0] * p + e[4] * y + e[8] * a) * sc, my = (e[1] * p + e[5] * y + e[9] * a) * sc, mz = (e[2] * p + e[6] * y + e[10] * a) * sc;
            pts.push({ x: mx - pin.x, y: my - pin.y, z: mz - pin.z, ma: mz, ms: mx, tip: !!tip });
        };
        const N = 12;
        for (let i = 0; i <= N; i++) {
            const a = D.aS + (D.aB - D.aS) * (0.01 + 0.98 * i / N);
            let yb = null;
            for (let k = S.kFirst; k <= S.kTop; k++) if (S.sternAlong[k] <= a && a <= S.bowAlong[k]) { yb = S.levelY[k]; break; }
            if (yb === null) continue;
            const y1 = yb + (D.yDeck - yb) * 0.12, y2 = yb + (D.yDeck - yb) * 0.55;
            const w1 = Math.max(0, wtHW(y1, a) || 0), w2 = Math.max(0, wtHW(y2, a) || 0), wd = Math.max(0, wtHW(D.yDeck, a) || 0);
            add(0, yb, a, i === 0 || i === N);
            if (w1 > 0.01) { add(w1, y1, a); add(-w1, y1, a); }
            if (w2 > 0.01) { add(w2, y2, a); add(-w2, y2, a); }
            if (wd > 0.01) { add(wd, D.yDeck, a); add(-wd, D.yDeck, a); }
        }
        add(0, D.yDeck, D.aB, true); add(0, D.yDeck, D.aS, true);
    } else {
        // 船体の形がまだ無いとき：喫水の点（_trHullPoints）
        for (const p of _trHullPoints()) pts.push({ x: p.s - pin.x, y: -p.d, z: p.a - pin.z, ma: p.a, ms: p.s, tip: !!p.tip });
    }
    _gc.key = key; _gc.pts = pts;
    return pts;
}
// 今の姿勢（縦・横の傾き＋向き r[rad]）の回転：three.js の Euler 'YXZ'（描く船と同じ：17-main-loop.js）
const _gcPs = { cp: 1, sp: 0, cr: 1, sr: 0, cy: 1, sy: 0 };
function _gcPose(r) {
    _gcPs.cp = Math.cos(physics.pitch || 0); _gcPs.sp = Math.sin(physics.pitch || 0);
    _gcPs.cr = Math.cos(physics.roll || 0); _gcPs.sr = Math.sin(physics.roll || 0);
    _gcPs.cy = Math.cos(r); _gcPs.sy = Math.sin(r);
    return _gcPs;
}
// 点の、ピンからの世界の向きのずれ（out.x・out.z：水平、out.y：高さ）
function _gcWorld(p, ps, out) {
    const x1 = p.x * ps.cr - p.y * ps.sr, y1 = p.x * ps.sr + p.y * ps.cr;
    const y2 = y1 * ps.cp - p.z * ps.sp, z2 = y1 * ps.sp + p.z * ps.cp;
    out.x = x1 * ps.cy + z2 * ps.sy; out.y = y2; out.z = -x1 * ps.sy + z2 * ps.cy;
    return out;
}
// 1 フレームの物理の前（17-main-loop.js）：当たりを調べるか決め、点を用意する。pin：重心の位置の喫水線（模型の原点から[m]）
function groundContactPrepare(pinX, pinY, pinZ) {
    _gc.active = false; _gc.contact = false; _gc.maxPen = 0; _gc.support = 0;
    if (typeof shipGroup === 'undefined' || !shipGroup || (window.sub && sub.applied > 0.5)) return false;
    const hp = window.hullProfile, sc = physics.scale || 1;
    const L = Math.max(10, ((hp && hp.ready) ? hp.halfLen * 2 : 12) * sc);
    const B = Math.max(3, (typeof flood !== 'undefined' && flood.B) || ((hp && hp.ready && hp.halfBeam) ? hp.halfBeam * 2 * sc : L / 8));
    // 船のいちばん低くなりうる所より、海底がずっと深ければ調べない（外洋のまん中など）
    const lowest = (physics.y || 0) - worldShipDraft() - Math.abs(Math.sin(physics.pitch || 0)) * L * 0.5 - Math.abs(Math.sin(physics.roll || 0)) * B * 0.5 - (physics.vy < 0 ? -physics.vy * 2 : 0);
    const bed = worldSeabedAt(physics.cgWorldX || 0, physics.cgWorldZ || 0);
    const inWorld = window.world && world.mode === 'world';
    if (!(bed > lowest - 40) && !(inWorld && (terrain.near || terrain.ports.size))) return false;
    // 縦・横の回りにくさ（慣性半径²）は、浮力で揺れる計算（17-main-loop.js の IPitch_real・IRoll）と同じにする。
    // 以前は縦が 4 倍・横も 4 倍回りにくい値で、船首が浅瀬に乗ると、船首を支点に船尾が沈む（縦に傾く）代わりに
    // 船全体が持ち上がり、重さの半分近くが海底に載って、後進しても摩擦で動けなかった
    const ps = Math.max(0.25, physics.scale || 1), hpd = ((physics.waterlineOffsetY || 0) - ((physics.cgOffset && physics.cgOffset.y) || 0)) * ps;
    const kP = 0.25 * ((hp && hp.ready) ? hp.halfLen : 6) * ps, kR = 0.35 * ((hp && hp.ready) ? hp.halfBeam : 2) * ps;
    _gc.iP = 1 / Math.max(1e-6, kP * kP + hpd * hpd); _gc.iR = 1 / Math.max(1e-6, kR * kR + hpd * hpd);
    _gc.HL = L / 2;
    _gc.pin.x = pinX; _gc.pin.y = pinY; _gc.pin.z = pinZ;
    _gcPoints();
    _gc.active = true;
    return true;
}
// 物理の 1 刻み（上下・縦・横の傾きを進めた後）。r：向き[rad]、support：船の重さのうち浮力で支えきれていない割合
function groundContactStep(r, subDt, support) {
    physics.groundFriction = 0;
    if (!_gc.active) return;
    const pts = _gc.pts, ps = _gcPose(r), cx = physics.cgWorldX || 0, cz = physics.cgWorldZ || 0, iP = _gc.iP, iR = _gc.iR;
    const fx = ps.sy, fz = ps.cy, sx = ps.cy, sz = -ps.sy;
    const C = _gc.C; let nC = 0;
    for (const p of pts) {
        _gcWorld(p, ps, _gcW);
        const b0 = worldSeabedAt(cx + _gcW.x, cz + _gcW.z);
        if (b0 === 5) continue;                                  // 岸壁・桟橋（横から当たる：_trCheckGrounding）
        const a = _gcW.x * fx + _gcW.z * fz;
        const pen = _gcBed(b0, a) - (physics.y + _gcW.y);
        if (pen <= -GC_TOUCH || pen > GC_STEP) continue;         // 離れている／深く入りすぎ（壁）
        let c = C[nC]; if (!c) c = C[nC] = { pen: 0, a: 0, s: 0, wx: 0, wz: 0 };
        c.pen = pen; c.a = a; c.s = _gcW.x * sx + _gcW.z * sz; c.wx = _gcW.x; c.wz = _gcW.z; nC++;
    }
    if (!nC) return;
    _gc.contact = true;
    // 位置：いちばん深く入っている点から順に押し戻す（押し戻した分で、ほかの点の入り方も変わる）
    let dy = 0, dP = 0, dR = 0;
    for (let it = 0; it < 8; it++) {
        let best = -1, bp = 0.002;
        for (let i = 0; i < nC; i++) { const c = C[i], pr = c.pen - (dy - c.a * dP + c.s * dR); if (pr > bp) { bp = pr; best = i; } }
        if (best < 0) break;
        const c = C[best], K = 1 + c.a * c.a * iP + c.s * c.s * iR, J = bp / K;
        dy += J; dP -= c.a * J * iP; dR += c.s * J * iR;
        if (bp > _gc.maxPen) _gc.maxPen = bp;
    }
    // 1 刻みに動かす量の上限（深く入っていた所は、数刻みかけて出す）
    dy = Math.min(dy, 0.3); dP = Math.max(-0.01, Math.min(0.01, dP)); dR = Math.max(-0.01, Math.min(0.01, dR));
    physics.y += dy; physics.pitch += dP; physics.roll += dR;
    // 速さ：触れている点が底へ向かって動く速さを止める（上下・縦・横の回る速さに分けて）
    for (let it = 0; it < 3; it++) {
        for (let i = 0; i < nC; i++) {
            const c = C[i];
            if (c.pen - (dy - c.a * dP + c.s * dR) < -0.02) continue;
            const v = physics.vy - c.a * physics.vPitch + c.s * physics.vRoll;
            if (v >= 0) continue;
            const K = 1 + c.a * c.a * iP + c.s * c.s * iR, J = -v / K;
            physics.vy += J; physics.vPitch -= c.a * J * iP; physics.vRoll += c.s * J * iR;
        }
    }
    // 底との摩擦：底に載った重さに比例して、前後の速さ（次の刻みで進む前に：17-main-loop.js の physics.groundFriction）と
    // 回頭を止める（触れているだけでも少しこすれる）
    const sup = Math.max(0.005, Math.min(1, support || 0));
    _gc.support = Math.max(_gc.support, sup);
    physics.groundFriction = GC_MU * 9.81 * sup;                // m/s²
    physics.turnRate = (physics.turnRate || 0) * Math.max(0, 1 - subDt * 6 * sup);
    if (typeof _tugShip !== 'undefined' && _tugShip) {
        if (_tugShip.vSway) _tugShip.vSway *= Math.max(0, 1 - subDt * 6 * sup);
        if (_tugShip.yawRate) _tugShip.yawRate *= Math.max(0, 1 - subDt * 6 * sup);
    }
    physics.vPitch *= Math.max(0, 1 - subDt * 2); physics.vRoll *= Math.max(0, 1 - subDt * 2);
    // 斜面：底が押し返す力は底の面に垂直なので、傾いた底に載っていると、下り坂の向きにも押される
    //（乗り上げた浅瀬からは、滑り戻る向き。摩擦に勝たなければ動かない：17-main-loop.js の physics.groundFriction）
    let gx = 0, gz = 0, ng = 0;
    for (let i = 0; i < nC && ng < 6; i++) {
        const c = C[i];
        if (c.pen - (dy - c.a * dP + c.s * dR) < -0.02) continue;
        const wx = cx + c.wx, wz = cz + c.wz;
        const hxp = worldSeabedAt(wx + 2, wz), hxm = worldSeabedAt(wx - 2, wz), hzp = worldSeabedAt(wx, wz + 2), hzm = worldSeabedAt(wx, wz - 2);
        if (hxp >= 0 || hxm >= 0 || hzp >= 0 || hzm >= 0) continue;   // 岸壁・陸の際（段）は斜面としない
        gx += (hxp - hxm) / 4; gz += (hzp - hzm) / 4; ng++;
    }
    if (ng) {
        gx /= ng; gz /= ng;
        const gl = Math.hypot(gx, gz), k = gl > 0.5 ? 0.5 / gl : 1;
        physics.speed -= (gx * fx + gz * fz) * k * 9.81 * sup * subDt / 0.514444;
    }
    _gcDigUpdate(subDt, sup);
    // 沈んでいく船・沈んだ船：底に着いたら、着いた端を支点に倒れて底に横たわる（浮力の縦のモーメントで起こし直さない：
    // flood.settle。真っ直ぐ立っている間はゆっくり、傾くほど速く）
    if (typeof flood !== 'undefined' && (flood.sunk || flood.sinking)) {
        flood.settle = true;
        const pq = physics.pitch, rate = 0.02 + 0.1 * Math.cos(Math.min(1.55, Math.abs(pq)));
        physics.pitch -= Math.sign(pq) * Math.min(Math.abs(pq), rate * subDt);
        if (physics.vPitch * pq > 0) physics.vPitch = 0;
    }
}
// 1 フレームの物理の後：浸水の傾きの上限（17-main-loop.js の floodRoll）に使う、底に支えられている深さ
function groundContactFinish(physDt) {
    if (!_gc.active) physics.groundFriction = 0;
    if (_gc.contact) _gc.touchT = 0; else if (_gc.touchT >= 0) _gc.touchT += physDt || 0;
    const touching = _gc.touchT >= 0 && _gc.touchT < 1.0;
    physics.groundLift = touching ? Math.max(0.05, _gc.support * worldShipDraft()) : 0;
    if (typeof flood !== 'undefined' && !touching && !(flood.sunk && (flood.bedT || 0) > 0)) flood.settle = false;
    if (typeof flood !== 'undefined' && flood.sunk && touching) flood.bedT = (flood.bedT || 0) + (physDt || 0);
}
window.groundContactPrepare = groundContactPrepare;
window.groundContactStep = groundContactStep;
window.groundContactFinish = groundContactFinish;
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
    // 外洋のまん中（近くに陸も港も無い）では調べない（海底で支えるのは物理の刻みごと：groundContactStep）
    if (!terrain.near && !terrain.ports.size && terrain.depth > worldShipDraft() + 80) { terrain.grounded = false; terrain.good = { x, z, h, score: 0, hard: 0 }; _trGroundAttitude([], dt); return; }
    const hits = [];
    const score = _trHullScore(x, z, h, off, hits), hard = _trHullScore.hard;
    const wasGrounded = terrain.grounded, vHit = Math.abs(physics.speed || 0) * 0.514444;
    let worse = false;
    // 前の位置（good）と、今の波・姿勢のまま比べる（波で船底が上下しただけで「深く入った」としない。
    // そうしないと、波のたびに動きを取り消されて、乗り上げた所から後進で抜けられない）
    let good = terrain.good;
    if (good && (score > 0.02 || hard > 0) && (good.x !== x || good.z !== z || good.h !== h)) {
        const so = _trHullScore(good.x, good.z, good.h, off), ho = _trHullScore.hard;
        good = { x: good.x, z: good.z, h: good.h, score: so, hard: ho };
    }
    if (good && _trWorse(score, hard, good)) {
        worse = true;
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
        // 船底が海底に触れている（乗り上げている間の摩擦は groundContactStep）
        terrain.grounded = score > 0.02;
        terrain.good = { x, z, h, score, hard };
    }
    terrain.hullHits = hits.length;
    // 速く乗り上げたら船底に穴（64-damage.js：ゆっくりなら二重底で止まる）
    if (terrain.grounded && (!wasGrounded || worse) && typeof damageGround === 'function') damageGround(hits, vHit);
    _trGroundAttitude(hits, dt);
    if (terrain.grounded && !wasGrounded && Math.abs(physics.speed || 0) > 0.6 && typeof audioWaveImpact === 'function') {
        audioWaveImpact(shipGroup.position.clone(), Math.min(2, 0.5 + Math.abs(physics.speed) / 6), true);
    }
}

// ════════════════════════════════════════════════════════════════
//  毎フレーム（17-main-loop.js から）
// ════════════════════════════════════════════════════════════════
// ── 外洋のモードの海底：平均 3000m（ゆるい起伏 ±250m ほど）──
// 沈んだ船はここで止まる。描くのは、船底（かカメラ）がその 100m 上まで下りてきたときだけ
function oceanSeabedAt(x, z) {
    return -(3000 + 180 * Math.sin(x * 0.00031 + 1.3) * Math.cos(z * 0.00027 - 0.4)
        + 60 * Math.sin((x - z) * 0.0011) + 20 * Math.sin(x * 0.0047) * Math.sin(z * 0.0039));
}
window.oceanSeabedAt = oceanSeabedAt;
// 船のいちばん低い所（沈んだ船は姿勢のままの船底・甲板の点）と、カメラの、どちらか深い方の高さ
function _trLowestY() {
    let y = (physics.y || 0) - worldShipDraft();
    if (typeof flood !== 'undefined' && (flood.sunk || flood.sinking) && typeof _trSunkWorldPts === 'function') for (const p of _trSunkWorldPts()) y = Math.min(y, p.y);
    if (typeof camera !== 'undefined' && camera) y = Math.min(y, camera.position.y);
    return y;
}
// 世界のモード：深い海底も、船底（かカメラ）から 100m 以内なら網を作って描く（25m きざみ。浅くなるときは 50m 余裕を見て）
function _trSeabedCut() {
    const want = Math.max(-TR_SEABED, Math.ceil((-_trLowestY() + 100) / 25) * 25);
    const cur = -_trSeabedU.value;
    if (want > cur || want < cur - 50) { _trSeabedU.value = -want; terrain._dirty = true; }
}
let _ocFloor = null;
function _trOceanFloor() {
    const keel = _trLowestY(), cx = physics.cgWorldX || 0, cz = physics.cgWorldZ || 0;
    const near = keel - oceanSeabedAt(cx, cz) < 100 || (typeof userWaterVisible !== 'undefined' && !userWaterVisible);
    if (!near) { if (_ocFloor) _ocFloor.visible = false; return; }
    const N = 48, W = 1600;
    if (!_ocFloor) {
        const g = new THREE.PlaneGeometry(W, W, N, N); g.rotateX(-Math.PI / 2);
        const m = new THREE.MeshStandardMaterial({ color: 0x4a4436, roughness: 1, metalness: 0 });
        m.color.convertSRGBToLinear();
        if (typeof noShipLightProbe === 'function') noShipLightProbe(m);
        _ocFloor = new THREE.Mesh(g, m); _ocFloor.receiveShadow = false; _ocFloor.castShadow = false;
        _ocFloor.frustumCulled = false; _ocFloor.userData.cx = Infinity;
        scene.add(_ocFloor);
    }
    _ocFloor.visible = true;
    // 船が 200m 動いたら、まわりの起伏を描き直す
    if (Math.hypot(cx - _ocFloor.userData.cx, cz - _ocFloor.userData.cz) > 200) {
        const bx = Math.round(cx / 50) * 50, bz = Math.round(cz / 50) * 50;
        _ocFloor.userData.cx = bx; _ocFloor.userData.cz = bz;
        const P = _ocFloor.geometry.attributes.position;
        for (let i = 0; i < P.count; i++) {
            const x = (i % (N + 1)) / N * W - W / 2 + bx, z = Math.floor(i / (N + 1)) / N * W - W / 2 + bz;
            P.setXYZ(i, x, oceanSeabedAt(x, z), z);
        }
        P.needsUpdate = true; _ocFloor.geometry.computeVertexNormals(); _ocFloor.geometry.computeBoundingSphere();
    }
}
// 外洋のモード：沈んでいく自分の船の下の水深（海底で支えるのは物理の刻みごと：groundContactStep）
function _trOceanContact(dt) {
    terrain.depth = -oceanSeabedAt(physics.cgWorldX || 0, physics.cgWorldZ || 0);
}
function updateWorldTerrain(t, dt) {
    if (typeof updateHornEcho === 'function') updateHornEcho(t);   // 汽笛のこだま（45-horn-echo.js）
    if (world.mode !== 'world') {
        if (terrain.near || terrain.far || terrain.ports.size) _trClearAll();
        _trFarWaterUpdate();
        _trOceanFloor();
        _trOceanContact(dt);
        return;
    }
    if (_ocFloor) _ocFloor.visible = false;
    _trFarWaterUpdate();
    _trSeabedCut();
    _trDeepRange();
    if (!world.ports) worldBuildPorts();
    // 前回の続き：向きを戻す
    if (world._resumeHeading !== undefined && t > 0.5) { physics.heading = world._resumeHeading; world._resumeHeading = undefined; }
    // 船の位置をときどき覚えておく
    if (!(t - (terrain.lastSave || 0) < 5)) { terrain.lastSave = t; _worldSave(); }
    // 作り込んだ港の細かい地形：船が近づいたら読み、遠くなったら捨てる（43-world.js）
    if (!(t - (terrain.hdTick || 0) < 3)) { terrain.hdTick = t; if (typeof worldHarborTick === 'function') worldHarborTick(); }
    const cx = physics.cgWorldX || 0, cz = physics.cgWorldZ || 0;
    // 北大西洋：地形のワーカーには船のまわりの地形だけを渡してあるので、船が離れたら渡し直す
    if (_RW && _RW.grids && terrain.worker) {
        const W = terrain.rwWin, ll = worldShipLatLon();
        if (!W || Math.abs(ll.lat - W.c.lat) > 0.6 || Math.abs(ll.lon - W.c.lon) * Math.cos(ll.lat * Math.PI / 180) > 0.6) {
            worldWorkerSync(terrain.worker, terrain.rwWin = worldWorkerWindow());
            terrain._dirty = true;
        }
    }
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
