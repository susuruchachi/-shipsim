// 70-night-sky.js — 本物の夜空（星・惑星・天の川・月の向き）と、光害・街明かり
//
//  ・星：Hipparcos 星表の 7.5 等より明るい星（約 2.6 万個、data/sky/stars.bin）を、その日・その時刻・その場所
//    （船の緯度・経度）の空に置く。地軸の首振り（歳差：200 年で約 3°）も入れる。
//    惑星（水星・金星・火星・木星・土星）は軌道の式（JPL の近似の軌道要素：1800〜2050 年）で、本当の位置と明るさに。
//    どこまで暗い星が見えるか（限界等級）は、その向きの空の明るさで決まる：
//      暗い夜空（1）＋ 薄明 ＋ 月明かり（月のそばほど）＋ 光害（街のある方位の地平線ほど）。
//    地平線の近くは大気で暗く（大気の厚さ × 0.25 等）、よくまたたく。雲・霧の向こうは見えない。月に隠れる星も消える。
//  ・天の川（05-sky-dome.js）：NASA の星の光の地図。空が暗いほどよく見える
//  ・月（05-sky-dome.js）：月面の地図を、月の北極（≒ 黄道の北極）を上にして貼る。その向きと大きさはここで決める
//    （ふだんは見やすく大きめ。双眼鏡で寄ると本当の大きさ（直径 0.5°）へ）
//  ・光害：NASA の夜の地球の灯り（Black Marble 2016、data/world/lights.webp）から、まわり 250km の街の光を集めて、
//    天頂の空の明るさ（距離の 2.5 乗に反比例：Walker の法則）と、方位ごとの地平線の光の丘を出す。
//    年代で弱める（今を 1 として、1950 年は 2 割、1900 年は 6%、1800 年はほぼ無し）。色も時代で（ガス灯・白熱灯・
//    水銀灯・ナトリウム灯・LED）
//  ・街明かり：船のまわり 30km の陸の上に、灯りの点を置く（Black Marble の 3km の区画の明るさで数を決め、
//    地形の格子（44-world-terrain.js）で陸の上だけに）。近いほど細かく、遠いほどまばらに（遠くは重なって帯に見える）
//    作った「世界」（地図の生成）では、港の種類と大きさから灯りを作る
const NS = {
    inited: false,
    eq2scene: new THREE.Matrix3(), scene2eq: new THREE.Matrix3(), _P: new THREE.Matrix3(), _H: new THREE.Matrix3(),
    stars: null, starMat: null, starMags: null, nStars: 0,
    planetsN: -1e9,
    lpTex: null, lpData: new Uint8Array(64 * 4), lpA: new Float32Array(64), lpW: new Float32Array(64),
    lp: { zen: 0, max: 0, lat: NaN, lon: NaN, t: -1e9, year: NaN, mode: '' },
    coarse: null, coarseLoading: false, lightsMeta: null, lightsMetaLoading: false,
    tiles: new Map(),
    city: { pts: null, mat: null, job: null, builtId: -1, builtYear: NaN, builtQ: '' },
};
window.NS_nightSky = NS;
const NS_PLANETS = 5;
// 光害の強さ（Black Marble の明るさ × 面積[km²] × 距離[km]^−2.5 の和 → 暗い夜空を 1 とした天頂の明るさ）。
// 東京湾で約 30（4 等星まで）、横浜港で約 50、ニューヨーク港で約 100、サウサンプトン港で約 35、カウズ（ソレント）で約 6、
// 英仏海峡の真ん中で 0.2、外洋で 0
const LP_K_ZEN = 10;
const LP_K_DIR = 100;        // 地平線の光の丘（× 距離^−2）
const LP_RADIUS = 250;       // これより遠い街は数えない[km]

// ── 年代 ──
function _nsYear() {
    try { const q = calDateOf(calDayNow()); return q.y + (q.m - 1) / 12; } catch (e) { return 2026; }
}
// 灯りの量（2016 年を 1）
const _NS_LP_YEARS = [[1800, 0.004], [1850, 0.012], [1880, 0.025], [1900, 0.06], [1920, 0.1], [1950, 0.22], [1970, 0.45], [1990, 0.72], [2010, 0.95], [2016, 1.0], [2035, 1.1]];
function nsLightYearFactor(y) {
    const T = _NS_LP_YEARS;
    if (y <= T[0][0]) return T[0][1];
    for (let i = 1; i < T.length; i++) if (y <= T[i][0]) { const a = T[i - 1], b = T[i]; return a[1] + (b[1] - a[1]) * (y - a[0]) / (b[0] - a[0]); }
    return T[T.length - 1][1];
}
window.nsLightYearFactor = nsLightYearFactor;
// 灯りの種類の割合：ガス灯・白熱灯・水銀灯・ナトリウム灯・LED（色はリニア）
const NS_LAMPS = [
    [1.00, 0.62, 0.30],     // ガス灯・石油ランプ
    [1.00, 0.76, 0.50],     // 白熱灯（窓の灯りも）
    [0.72, 0.88, 1.00],     // 水銀灯・アーク灯（青白い）
    [1.00, 0.55, 0.20],     // ナトリウム灯（橙）
    [0.92, 0.95, 1.00],     // LED（白）
];
function _nsBump(y, a, b, c, d) { return y <= a || y >= d ? 0 : y < b ? (y - a) / (b - a) : y <= c ? 1 : (d - y) / (d - c); }
function nsLampMix(y) {
    const w = [
        _nsBump(y, 1700, 1700.1, 1890, 1935),
        0.35 + 0.65 * _nsBump(y, 1870, 1905, 1950, 1975),
        0.8 * _nsBump(y, 1890, 1955, 1970, 2000),
        _nsBump(y, 1955, 1975, 2010, 2030),
        _nsBump(y, 2008, 2025, 2200, 2201),
    ];
    const s = w.reduce((a, b) => a + b, 0);
    return w.map(v => v / s);
}

// ── 歳差（J2000 → その日の赤道座標）：Lieske (1977) ──
function _nsPrecession(T, out) {
    const as = Math.PI / 648000;
    const ze = (2306.2181 * T + 0.30188 * T * T + 0.017998 * T * T * T) * as;
    const z = (2306.2181 * T + 1.09468 * T * T + 0.018203 * T * T * T) * as;
    const th = (2004.3109 * T - 0.42665 * T * T - 0.041833 * T * T * T) * as;
    const cz = Math.cos(ze), sz = Math.sin(ze), cZ = Math.cos(z), sZ = Math.sin(z), ct = Math.cos(th), st = Math.sin(th);
    return out.set(
        cz * ct * cZ - sz * sZ, -sz * ct * cZ - cz * sZ, -st * cZ,
        cz * ct * sZ + sz * cZ, -sz * ct * sZ + cz * cZ, -st * sZ,
        cz * st, -sz * st, ct);
}
// その日の赤道座標 → 空の向き（+x 西・+y 上・+z 北）。16 の _skyHorizon と同じ式を行列にしたもの
function _nsHorizon(lst, lat, out) {
    const sL = Math.sin(lst), cL = Math.cos(lst), sp = Math.sin(lat), cp = Math.cos(lat);
    return out.set(
        sL, -cL, 0,
        cp * cL, cp * sL, sp,
        -sp * cL, -sp * sL, cp);
}

// ── 星の色：B−V → 温度 → 色（夜の目には色が淡いので、白へ寄せる） ──
function _nsStarColor(bv, out, o) {
    bv = Math.max(-0.4, Math.min(2.0, bv));
    const T = 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
    // 黒体の色（Tanner Helland の近似、sRGB 0〜1）
    const t = T / 100;
    let r, g, b;
    if (t <= 66) { r = 1; g = Math.max(0, Math.min(1, (99.4708025861 * Math.log(t) - 161.1195681661) / 255)); }
    else { r = Math.max(0, Math.min(1, 329.698727446 * Math.pow(t - 60, -0.1332047592) / 255)); g = Math.max(0, Math.min(1, 288.1221695283 * Math.pow(t - 60, -0.0755148492) / 255)); }
    if (t >= 66) b = 1; else if (t <= 19) b = 0; else b = Math.max(0, Math.min(1, (138.5177312231 * Math.log(t - 10) - 305.0447927307) / 255));
    r = r * r; g = g * g; b = b * b;              // リニアへ（おおよそ）
    const L = 0.2126 * r + 0.7152 * g + 0.0722 * b || 1;
    const k = 0.55;                               // 色の濃さ
    out[o] = (1 - k) + k * r / L; out[o + 1] = (1 - k) + k * g / L; out[o + 2] = (1 - k) + k * b / L;
}

// ── 惑星：JPL「惑星のおおよその位置の軌道要素」（1800〜2050 年）。a・e・I・L・近日点黄経・昇交点黄経とその 1 世紀の変化 ──
const NS_PLANET_EL = {
    mercury: [0.38709927, 0.00000037, 0.20563593, 0.00001906, 7.00497902, -0.00594749, 252.25032350, 149472.67411175, 77.45779628, 0.16047689, 48.33076593, -0.12534081],
    venus: [0.72333566, 0.00000390, 0.00677672, -0.00004107, 3.39467605, -0.00078890, 181.97909950, 58517.81538729, 131.60246718, 0.00268329, 76.67984255, -0.27769418],
    earth: [1.00000261, 0.00000562, 0.01671123, -0.00004392, -0.00001531, -0.01294668, 100.46457166, 35999.37244981, 102.93768193, 0.32327364, 0, 0],
    mars: [1.52371034, 0.00001847, 0.09339410, 0.00007882, 1.84969142, -0.00813131, -4.55343205, 19140.30268499, -23.94362959, 0.44441088, 49.55953891, -0.29257343],
    jupiter: [5.20288700, -0.00011607, 0.04838624, -0.00013253, 1.30439695, -0.00183714, 34.39644051, 3034.74612775, 14.72847983, 0.21252668, 100.47390909, 0.20469106],
    saturn: [9.53667594, -0.00125060, 0.05386179, -0.00050991, 2.48599187, 0.00193609, 49.95424423, 1222.49362201, 92.59887831, -0.41897216, 113.66242448, -0.28867794],
};
// 等級の式（H ＋ 5log(rΔ) ＋ 位相の項）と、色（B−V）
const NS_PLANET_PH = {
    mercury: [(a) => -0.42 + 0.0380 * a - 0.000273 * a * a + 0.000002 * a * a * a, 0.95],
    venus: [(a) => -4.40 + 0.0009 * a + 0.000239 * a * a - 0.00000065 * a * a * a, 0.82],
    mars: [(a) => -1.52 + 0.016 * a, 1.36],
    jupiter: [(a) => -9.40 + 0.005 * a, 0.83],
    saturn: [(a) => -8.88 + 0.044 * a, 1.04],
};
function _nsHelio(el, T) {
    const D = Math.PI / 180;
    const a = el[0] + el[1] * T, e = el[2] + el[3] * T, I = (el[4] + el[5] * T) * D, L = el[6] + el[7] * T, wb = el[8] + el[9] * T, Om = (el[10] + el[11] * T) * D;
    const w = wb * D - Om;
    let M = ((L - wb) % 360 + 540) % 360 - 180; M *= D;
    let E = M + e * Math.sin(M);
    for (let k = 0; k < 6; k++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    const xp = a * (Math.cos(E) - e), yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
    const cw = Math.cos(w), sw = Math.sin(w), cO = Math.cos(Om), sO = Math.sin(Om), cI = Math.cos(I), sI = Math.sin(I);
    return [
        (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp,
        (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp,
        (sw * sI) * xp + (cw * sI) * yp,
    ];
}
// 惑星の J2000 の赤道座標の向きと等級
function nsPlanets(nDays) {
    const T = nDays / 36525, eps = 23.43928 * Math.PI / 180, ce = Math.cos(eps), se = Math.sin(eps);
    const E = _nsHelio(NS_PLANET_EL.earth, T), R = Math.hypot(E[0], E[1], E[2]);
    const out = [];
    for (const k of ['venus', 'jupiter', 'mars', 'saturn', 'mercury']) {
        const P = _nsHelio(NS_PLANET_EL[k], T), r = Math.hypot(P[0], P[1], P[2]);
        const g = [P[0] - E[0], P[1] - E[1], P[2] - E[2]], d = Math.hypot(g[0], g[1], g[2]);
        const ca = Math.max(-1, Math.min(1, (r * r + d * d - R * R) / (2 * r * d)));
        const alpha = Math.acos(ca) * 180 / Math.PI;
        const mag = 5 * Math.log10(r * d) + NS_PLANET_PH[k][0](alpha);
        out.push({ name: k, x: g[0] / d, y: (g[1] * ce - g[2] * se) / d, z: (g[1] * se + g[2] * ce) / d, mag, bv: NS_PLANET_PH[k][1] });
    }
    return out;
}
window.nsPlanets = nsPlanets;

// ── 星の点の材質 ──
const _NS_NOISE_GLSL = `
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p) {
        vec2 i = floor(p); vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y);
    }
    float fbm(vec2 p) {
        float v = 0.0; float a = 0.5;
        for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.1; a *= 0.5; }
        return v;
    }`;
const _NS_LP_GLSL = `
    uniform float lpZenith;
    uniform sampler2D lpTex;
    uniform float lpMax;
    float lpAt(vec3 d) {
        float sa = max(d.y, 0.0);
        float b = lpZenith * (1.0 + 1.5 * pow(1.0 - sa, 3.0));
        if (lpMax > 0.0) {
            vec2 g = texture2D(lpTex, vec2(atan(-d.x, d.z) / 6.2831853 + 0.5, 0.5)).rg;
            float w = 0.02 + g.y * 0.5;
            b += g.x * g.x * lpMax * exp(-asin(sa) / w);
        }
        return b;
    }`;
function _nsStarMaterial(skyU) {
    return new THREE.ShaderMaterial({
        uniforms: {
            eq2scene: { value: NS.eq2scene },
            uDpr: { value: 1 }, uTw: { value: 0 }, uBmoon: { value: 0 }, uGain: { value: 1 }, uLimBias: { value: 0.25 }, uExt: { value: 0.25 },
            moonDirection: skyU.moonDirection, moonRadius: skyU.moonRadius,
            lpZenith: skyU.lpZenith, lpTex: skyU.lpTex, lpMax: skyU.lpMax, skyBgB: skyU.skyBgB,
            time: skyU.time, cloudAmount: skyU.cloudAmount, overcast: skyU.overcast, fogVeil: skyU.fogVeil, fogExtraDensity: skyU.fogExtraDensity,
            skyExposure: skyU.skyExposure,
        },
        vertexShader: `
            uniform mat3 eq2scene;
            uniform float uDpr, uTw, uBmoon, uGain, uLimBias, uExt;
            uniform vec3 moonDirection;
            uniform float moonRadius;
            uniform float skyBgB;
            uniform float time, cloudAmount, overcast, fogVeil, fogExtraDensity;
            attribute float aMag;
            attribute vec3 aCol;
            attribute float aTw;
            varying vec3 vCol;
            varying float vI;
            ${_NS_NOISE_GLSL}
            ${_NS_LP_GLSL}
            void main() {
                vCol = aCol; vI = 0.0;
                gl_PointSize = 0.0;
                gl_Position = vec4(2.0, 2.0, 2.0, 1.0);          // 見えない星は画面の外へ
                vec3 d = normalize(eq2scene * position);
                if (d.y < -0.01) return;
                float sa = max(d.y, 0.0);
                float X = 1.0 / (sa + 0.025 * exp(-11.0 * sa));   // 大気の厚さ（天頂を 1）
                float m = aMag + uExt * (X - 1.0);
                // その向きの空の明るさ（暗い夜空を 1）→ 見える限界の等級（Schaefer・Garstang の近似）
                float cm = dot(d, moonDirection);
                float B = skyBgB * (1.0 + 0.6 * (1.0 - sa) * (1.0 - sa))
                        + uBmoon * 3.0 * exp(-acos(clamp(cm, -1.0, 1.0)) / 0.3) * step(-0.02, moonDirection.y)
                        + lpAt(d);
                float mlim = 7.93 - 5.0 * log(0.824 * sqrt(B) + 1.0) / 2.302585 + uLimBias;
                float s = exp(-0.921034 * (m - mlim));            // 限界の星の何倍明るいか
                if (s < 0.8) return;
                // 雲（05-sky-dome.js の空と同じ式）・霧・月の後ろ
                float vis = (1.0 - overcast) * (1.0 - clamp(fogVeil * 1.6, 0.0, 1.0));
                if (d.y > 0.02) {
                    vec2 cloudUV = d.xz / (d.y + 0.05) * 0.18 + vec2(time * 0.0015, time * 0.0008);
                    float cloud = fbm(cloudUV);
                    float cloudEdge = fbm(cloudUV * 2.3 + vec2(3.7, 1.2)) * 0.4;
                    float cloudThr = mix(0.63, 0.16, clamp(cloudAmount, 0.0, 1.0));
                    cloud = smoothstep(cloudThr - cloudEdge * 0.15, cloudThr + 0.24, cloud) * smoothstep(0.02, 0.12, d.y);
                    vis *= 1.0 - cloud * 0.97;
                }
                if (fogExtraDensity > 0.0) { float fl = fogExtraDensity * 400.0 / max(d.y, 0.012); vis *= exp(-fl * fl); }
                if (cm > 0.0 && length(d - moonDirection * cm) < sin(moonRadius) && moonDirection.y > -0.02) vis = 0.0;
                if (vis < 0.01) return;
                // またたき：地平線に近いほど強い（惑星はほとんどまたたかない）
                float ph = fract(sin(dot(position.xy, vec2(12.9898, 78.233))) * 43758.5453) * 6.2831853;
                float amp = aTw * (0.08 + 0.42 * pow(1.0 - sa, 3.0));
                float tw = 1.0 + amp * (0.6 * sin(uTw * (8.0 + ph) + ph * 3.0) + 0.4 * sin(uTw * (13.0 + 2.0 * ph) + ph * 7.0));
                vI = uGain * min(0.26 * sqrt(s), 4.0) * smoothstep(0.8, 1.7, s) * vis * tw;
                gl_PointSize = clamp(1.9 + 0.8 * log(s) / 2.302585, 1.9, 7.5) * uDpr;
                vec4 v = viewMatrix * vec4(d, 0.0);
                gl_Position = projectionMatrix * vec4(v.xyz * 1000.0, 1.0);
                gl_Position.z = gl_Position.w * 0.99999;          // いちばん奥（地形・船の後ろ）
            }`,
        fragmentShader: `
            uniform float skyExposure;
            varying vec3 vCol;
            varying float vI;
            void main() {
                vec2 p = gl_PointCoord * 2.0 - 1.0;
                float r2 = dot(p, p);
                if (r2 > 1.0 || vI <= 0.0) discard;
                gl_FragColor = vec4(vCol * (vI * exp(-r2 * 4.5) * skyExposure), 1.0);
                #include <tonemapping_fragment>
                #include <encodings_fragment>
            }`,
        transparent: true, depthTest: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    });
}

// ── 読み込み ──
function _nsTex1(r, g, b) {
    const t = new THREE.DataTexture(new Uint8Array([r, g, b, 255]), 1, 1, THREE.RGBAFormat);
    t.needsUpdate = true;
    return t;
}
async function _nsDecodeR(url) {
    const blob = await (await fetch(url)).blob();
    let bmp;
    try { bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }); }
    catch (e) { bmp = await createImageBitmap(blob); }
    const w = bmp.width, h = bmp.height;
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, 0, 0);
    const px = g.getImageData(0, 0, w, h).data;
    const out = new Uint8Array(w * h);
    for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = px[j];
    cv.width = cv.height = 1;
    if (bmp.close) bmp.close();
    return { w, h, data: out };
}
function _nsLoadStars() {
    fetch('data/sky/stars.bin').then(r => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); }).then(buf => {
        const u = new Uint16Array(buf), n = u.length / 3, N = n + NS_PLANETS;
        const pos = new Float32Array(N * 3), mag = new Float32Array(N), col = new Float32Array(N * 3), tw = new Float32Array(N);
        NS.starMags = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            const ra = u[i * 3] / 65536 * 2 * Math.PI, dec = u[i * 3 + 1] / 65535 * Math.PI - Math.PI / 2, mb = u[i * 3 + 2];
            const k = i + NS_PLANETS, cd = Math.cos(dec);
            pos[k * 3] = cd * Math.cos(ra); pos[k * 3 + 1] = cd * Math.sin(ra); pos[k * 3 + 2] = Math.sin(dec);
            mag[k] = (mb >> 8) / 20 - 2; NS.starMags[i] = mag[k];
            _nsStarColor((mb & 255) / 80 - 0.5, col, k * 3);
            tw[k] = 1;
        }
        for (let k = 0; k < NS_PLANETS; k++) { mag[k] = 30; tw[k] = 0.12; pos[k * 3 + 2] = 1; col[k * 3] = col[k * 3 + 1] = col[k * 3 + 2] = 1; }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('aMag', new THREE.BufferAttribute(mag, 1));
        geo.setAttribute('aCol', new THREE.BufferAttribute(col, 3));
        geo.setAttribute('aTw', new THREE.BufferAttribute(tw, 1));
        NS.starMat = _nsStarMaterial(skyMesh.material.uniforms);
        NS.stars = new THREE.Points(geo, NS.starMat);
        NS.stars.frustumCulled = false;
        NS.stars.renderOrder = -999;
        NS.stars.userData.noBloom = true;
        NS.nStars = n;
        NS.planetsN = -1e9;
        scene.add(NS.stars);
    }).catch(e => console.warn('星表を読めませんでした（乱数の星は出ません）:', e));
}
function _nsLoadMoon() {
    const U = skyMesh.material.uniforms;
    new THREE.TextureLoader().load('data/sky/moon.jpg', (t) => { t.anisotropy = 4; U.moonTex.value = t; }, undefined, () => console.warn('月面の地図を読めませんでした'));
}
function _nsLoadTextures() {
    const U = skyMesh.material.uniforms;
    const L = new THREE.TextureLoader();
    L.load('data/sky/milkyway.jpg', (t) => {
        t.generateMipmaps = false; t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter;
        t.wrapS = THREE.RepeatWrapping;
        U.milkyTex.value = t; NS.milkyOk = true;
    }, undefined, () => console.warn('天の川の地図を読めませんでした'));
}
function initNightSky() {
    if (NS.inited || typeof skyMesh === 'undefined' || !skyMesh || !skyMesh.material.uniforms.scene2eq) return;
    NS.inited = true;
    const U = skyMesh.material.uniforms;
    U.moonTex.value = _nsTex1(200, 200, 200);
    U.milkyTex.value = _nsTex1(0, 0, 0);
    NS.lpTex = new THREE.DataTexture(NS.lpData, 64, 1, THREE.RGBAFormat);
    NS.lpTex.wrapS = THREE.RepeatWrapping; NS.lpTex.minFilter = THREE.LinearFilter; NS.lpTex.magFilter = THREE.LinearFilter;
    NS.lpTex.generateMipmaps = false; NS.lpTex.needsUpdate = true;
    U.lpTex.value = NS.lpTex;
    U.scene2eq.value = NS.scene2eq;
    _nsLoadMoon();              // （月は昼の空にも出るので、最初から。小さい）
    // 天の川・星表・街明かりの地図は、日が沈むころ（太陽の高さ 3° より下）に初めて読む（updateNightSky）。
    //（以前は昼でも起動したときに全部読んでいて、特に街明かりの地図（4500×2250 を展開：一時 40MB）が起動を重くしていた）
}
function _nsNightNear() {
    const sd = skyMesh.material.uniforms.sunDirection.value;
    return sd.y < Math.sin(3 * Math.PI / 180);
}
window.initNightSky = initNightSky;

// ── 光害 ──
function _nsRealWorld() { return typeof _RW !== 'undefined' && !!_RW && window.world && world.mode === 'world'; }
function _nsEnsureLightsData() {
    if (!_nsRealWorld()) return false;
    if (!NS.lightsMeta && !NS.lightsMetaLoading) {
        NS.lightsMetaLoading = true;
        fetch('data/world/lights.json').then(r => r.json()).then(m => { NS.lightsMeta = m; NS.lightsHave = new Set(m.tile.have); })
            .catch(e => { console.warn('街明かりの一覧を読めませんでした:', e); });
    }
    if (!NS.coarse && !NS.coarseLoading) {
        NS.coarseLoading = true;
        _nsDecodeR('data/world/lights.webp').then(c => { NS.coarse = c; NS.lp.t = -1e9; })
            .catch(e => { console.warn('光害の地図を読めませんでした:', e); });
    }
    return !!NS.coarse;
}
// 作った「世界」：港の種類ごとの灯りの量（Black Marble の明るさ × km² にあたる値）と広がり[km]
const NS_GEN_PORT_LIGHT = { city: [0.8, 8], cargo: [0.65, 3.5], town: [0.55, 2.6], naval: [0.5, 2.2], fishing: [0.35, 0.9] };
function _nsGenPorts() { return (window.world && world.mode === 'world' && !_nsRealWorld() && Array.isArray(world.ports)) ? world.ports : null; }
function _nsAddDir(az, w, dome) {
    const f = (az / (2 * Math.PI) + 0.5) * 64 - 0.5, i0 = Math.floor(f), t = f - i0;
    const a = ((i0 % 64) + 64) % 64, b = (a + 1) % 64;
    NS.lpA[a] += w * (1 - t); NS.lpA[b] += w * t;
    NS.lpW[a] += w * (1 - t) * dome; NS.lpW[b] += w * t * dome;
}
function _nsComputeLP(lat0, lon0) {
    NS.lpA.fill(0); NS.lpW.fill(0);
    let zen = 0;
    const D2R = Math.PI / 180;
    const add = (lum, dx, dy, r0) => {
        const D = Math.hypot(dx, dy);
        if (D > LP_RADIUS) return;
        zen += lum * Math.pow(Math.max(D, r0 || 2), -2.5);
        if (D > 3) _nsAddDir(Math.atan2(dx, dy), lum / (D * D) * Math.min(1, (D - 3) / 7), Math.atan(1.5 / D));
    };
    if (_nsRealWorld() && NS.coarse) {
        const C = NS.coarse, cell = 180 / C.h;
        const r0 = Math.floor((90 - lat0) / cell), c0 = Math.floor((lon0 + 180) / cell);
        const dr = Math.ceil(LP_RADIUS / (111.2 * cell)), dc = Math.min(C.w >> 1, Math.ceil(LP_RADIUS / (Math.max(1, 111.2 * Math.cos(lat0 * D2R)) * cell)));
        for (let r = Math.max(0, r0 - dr); r <= Math.min(C.h - 1, r0 + dr); r++) {
            const lat = 90 - (r + 0.5) * cell, kx = 111.2 * Math.cos(lat * D2R), area = cell * 111.2 * cell * kx, dy = (lat - lat0) * 111.2;
            const row = r * C.w;
            for (let c = c0 - dc; c <= c0 + dc; c++) {
                const v = C.data[row + (((c % C.w) + C.w) % C.w)];
                if (v < 3) continue;
                const lin = (v / 255) * (v / 255);
                add(lin * area, (-180 + (c + 0.5) * cell - lon0) * kx, dy);
            }
        }
    } else {
        const P = _nsGenPorts();
        if (P) for (const p of P) {
            const q = NS_GEN_PORT_LIGHT[p.type] || NS_GEN_PORT_LIGHT.town;
            // （1 点にまとめた街なので、街の中では街の半径の半分より近くには数えない）
            add(q[0] * Math.PI * q[1] * q[1], (p.lon - lon0) * 111.2 * Math.cos(lat0 * D2R), (p.lat - lat0) * 111.2, Math.max(2, q[1] * 0.5));
        }
    }
    // 方位の帯をなめらかに
    const A = NS.lpA, W = NS.lpW, a2 = new Float32Array(64), w2 = new Float32Array(64);
    for (let i = 0; i < 64; i++) {
        const p = (i + 63) % 64, n = (i + 1) % 64;
        a2[i] = 0.25 * A[p] + 0.5 * A[i] + 0.25 * A[n]; w2[i] = 0.25 * W[p] + 0.5 * W[i] + 0.25 * W[n];
    }
    let mx = 0;
    for (let i = 0; i < 64; i++) mx = Math.max(mx, a2[i]);
    for (let i = 0; i < 64; i++) {
        const dome = a2[i] > 0 ? w2[i] / a2[i] : 0.05;
        NS.lpData[i * 4] = mx > 0 ? Math.round(Math.sqrt(a2[i] / mx) * 255) : 0;
        NS.lpData[i * 4 + 1] = Math.round(Math.max(0, Math.min(1, (dome - 0.02) / 0.5)) * 255);
        NS.lpData[i * 4 + 2] = 0; NS.lpData[i * 4 + 3] = 255;
    }
    if (NS.lpTex) NS.lpTex.needsUpdate = true;
    NS.lp.zenRaw = zen * LP_K_ZEN; NS.lp.maxRaw = mx * LP_K_DIR;
}
function _nsUpdateLP(t) {
    const U = skyMesh.material.uniforms;
    const inWorld = window.world && world.mode === 'world' && typeof worldShipLatLon === 'function';
    if (!inWorld) { NS.lp.zenRaw = 0; NS.lp.maxRaw = 0; NS.lp.lat = NaN; }
    else {
        // （光害は夜だけ効くので、街明かりの地図は日が沈むころから）
        if (NS.coarse || _nsNightNear()) _nsEnsureLightsData();
        const ll = worldShipLatLon(), mode = _nsRealWorld() ? (NS.coarse ? 'real' : 'wait') : 'gen';
        const moved = !Number.isFinite(NS.lp.lat) || Math.abs(ll.lat - NS.lp.lat) * 111.2 > 1.5 || Math.abs(ll.lon - NS.lp.lon) * 111.2 * Math.cos(ll.lat * Math.PI / 180) > 1.5;
        if (moved || mode !== NS.lp.mode || t - NS.lp.t > 20 || t < NS.lp.t) {
            NS.lp.t = t; NS.lp.mode = mode; NS.lp.lat = ll.lat; NS.lp.lon = ll.lon;
            _nsComputeLP(ll.lat, ll.lon);
        }
    }
    const yf = nsLightYearFactor(NS.year);
    U.lpZenith.value = (NS.lp.zenRaw || 0) * yf;
    U.lpMax.value = (NS.lp.maxRaw || 0) * yf;
    // 空の光の色：灯りの種類の割合で
    const mix = NS.lampMix;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < 5; i++) { r += mix[i] * NS_LAMPS[i][0]; g += mix[i] * NS_LAMPS[i][1]; b += mix[i] * NS_LAMPS[i][2]; }
    // 空の光は青い光ほど散って届く（橙の灯りでも少し白っぽく）
    U.lpColor.value.setRGB(r * 0.92, g * 0.95 + 0.03, b + 0.08);
}

// ── 毎フレーム（17-main-loop.js の updateSky から）──
const _nsV = new THREE.Vector3();
function updateNightSky(t) {
    if (!NS.inited) initNightSky();
    if (!NS.inited) return;
    const U = skyMesh.material.uniforms, F = window.skyFrameNow;
    if (!F) return;
    const yr = _nsYear();
    if (!(Math.abs(yr - NS.year) < 0.05)) { NS.year = yr; NS.lampMix = nsLampMix(yr); }
    // 空の向き：J2000 → その日（歳差）→ その場所・時刻（地方恒星時・緯度）
    _nsPrecession(F.n / 36525, NS._P);
    _nsHorizon(F.lst, F.lat, NS._H);
    NS.eq2scene.multiplyMatrices(NS._H, NS._P);
    NS.scene2eq.copy(NS.eq2scene).transpose();
    // 月の北極：黄道の北極（その日の赤道座標で 赤経 270°・赤緯 90°−ε）
    _nsV.set(0, -Math.sin(F.eps), Math.cos(F.eps)).applyMatrix3(NS._H);
    U.moonNorth.value.copy(_nsV);
    // 月の見かけの大きさ：ふだんは見やすく大きめ（直径約 2.5°）。双眼鏡で寄ると、本当の大きさ（0.52°）まで小さく
    const fov = (typeof camera !== 'undefined' && camera && camera.fov) ? camera.fov / (camera.zoom || 1) : 50;
    U.moonRadius.value = Math.max(0.00454, 0.022 * Math.min(1, fov / 50));
    // 月の色：低いほど大気で赤く暗く
    const md = U.moonDirection.value, sd = U.sunDirection.value;
    {
        const sa = Math.max(0, md.y), X = Math.min(14, 1 / (sa + 0.025 * Math.exp(-11 * sa)));
        U.moonTint.value.setRGB(1.0 * Math.exp(-0.10 * (X - 1)), 0.97 * Math.exp(-0.17 * (X - 1)), 0.92 * Math.exp(-0.30 * (X - 1)));
    }
    // 地球照：新月に近いほど（地球が「満地球」に近い）
    const cosPa = -sd.dot(md);
    U.earthshine.value = 0.010 * Math.pow(Math.max(0, (1 - cosPa) / 2), 2);
    // 空の明るさ（暗い夜空を 1）：薄明（太陽の高さ）＋ 月明かり
    const sunAlt = Math.asin(Math.max(-1, Math.min(1, sd.y))) * 180 / Math.PI;
    if (sunAlt < 3 && !NS.assetsReq) { NS.assetsReq = true; _nsLoadTextures(); _nsLoadStars(); }
    const bmTw = sunAlt <= 0 ? 11 + 0.6 * (-sunAlt) : 11 - 2 * sunAlt;
    const bTw = Math.pow(10, 0.4 * (22 - bmTw)) * smoothstep(-19, -16, sunAlt);
    const bMoon = 19 * (window.skyMoonLightNow || 0);
    U.skyBgB.value = 1 + bTw + bMoon;
    U.milkyGain.value = NS.milkyOk ? 0.022 : 0;
    _nsUpdateLP(t);
    // 星
    if (NS.stars) {
        const su = NS.starMat.uniforms;
        su.uDpr.value = renderer.getPixelRatio();
        su.uTw.value = performance.now() / 1000;
        su.uBmoon.value = bMoon;
        // いちばん条件の良い所（天頂）での限界等級 → それより暗い星は描かない
        const Bz = U.skyBgB.value + U.lpZenith.value;
        const mlim = 7.93 - 5 * Math.log10(0.824 * Math.sqrt(Bz) + 1) + su.uLimBias.value;
        NS.stars.visible = mlim > -1.8;
        if (NS.stars.visible) {
            const mags = NS.starMags;
            let lo = 0, hi = NS.nStars;
            while (lo < hi) { const m = (lo + hi) >> 1; if (mags[m] <= mlim + 0.4) lo = m + 1; else hi = m; }
            NS.stars.geometry.setDrawRange(0, NS_PLANETS + lo);
            // 惑星（30 分ごとに）
            if (Math.abs(F.n - NS.planetsN) > 0.02) {
                NS.planetsN = F.n;
                const P = nsPlanets(F.n), g = NS.stars.geometry;
                const pa = g.attributes.position, ma = g.attributes.aMag, ca = g.attributes.aCol;
                P.forEach((p, k) => {
                    pa.array[k * 3] = p.x; pa.array[k * 3 + 1] = p.y; pa.array[k * 3 + 2] = p.z;
                    ma.array[k] = p.mag;
                    _nsStarColor(p.bv, ca.array, k * 3);
                });
                pa.needsUpdate = ma.needsUpdate = ca.needsUpdate = true;
            }
        }
    }
    updateCityLights(t);
}
window.updateNightSky = updateNightSky;

// ════════════════════════════════════════════════════════════════
//  街明かり（陸の灯りの点）
// ════════════════════════════════════════════════════════════════
const CL_CELL = 250;             // 灯りを置く升目[m]（世界で固定の升目：作り直しても同じ所に同じ灯り）
const CL_DENS_Q = { high: 1, medium: 0.75, low: 0.5, verylow: 0.32, ultralow: 0.2 };
// 升目（i, j）と番号 k の乱数（0〜1。いつも同じ値）：MurmurHash3 の最後の混ぜ方で、となりの番号どうしも無関係に
function _clHash(i, j, k) {
    let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(k, 0x27d4eb2f) + 0x165667b1) | 0;
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
    h = Math.imul(h ^ Math.imul(k + 1, 0x9e3779b1), 0x85ebca6b); h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
}
function _clMaterial() {
    if (NS.city.mat) return NS.city.mat;
    NS.city.mat = new THREE.ShaderMaterial({
        uniforms: { uNight: { value: 0 }, uDpr: { value: 1 }, uFogD: { value: 0 }, uGain: { value: 1.25 }, uTw: { value: 0 }, uFov: { value: 1 } },
        vertexShader: `
            #include <common>
            #include <logdepthbuf_pars_vertex>
            uniform float uNight, uDpr, uFogD, uGain, uTw, uFov;
            attribute vec3 aCol;
            attribute float aI;
            varying vec3 vCol;
            varying float vI;
            void main() {
                vec4 mv = modelViewMatrix * vec4(position, 1.0);
                float d = max(1.0, -mv.z);
                gl_Position = projectionMatrix * mv;
                #include <logdepthbuf_vertex>
                // 霧で薄れる（FogExp2）。遠くの灯りは空気のゆらぎで少しまたたく
                float fog = exp(-pow(uFogD * d, 2.0));
                float ph = fract(sin(dot(position.xz, vec2(0.0129898, 0.078233))) * 43758.5453) * 6.2831853;
                float tw = 1.0 + smoothstep(3000.0, 20000.0, d) * 0.3 * sin(uTw * (6.0 + ph) + ph * 5.0);
                vI = aI * uGain * uNight * clamp(1500.0 / d, 0.45, 2.5) * fog * tw;
                vCol = aCol;
                gl_PointSize = clamp(900.0 / d, 1.5, 3.2) * uDpr * clamp(uFov, 1.0, 3.0);
                if (vI < 0.004) { gl_PointSize = 0.0; gl_Position = vec4(2.0, 2.0, 2.0, 1.0); }
            }`,
        fragmentShader: `
            #include <common>
            #include <logdepthbuf_pars_fragment>
            varying vec3 vCol;
            varying float vI;
            void main() {
                #include <logdepthbuf_fragment>
                vec2 p = gl_PointCoord * 2.0 - 1.0;
                float r2 = dot(p, p);
                if (r2 > 1.0) discard;
                gl_FragColor = vec4(vCol * (vI * exp(-r2 * 3.5)), 1.0);
                #include <tonemapping_fragment>
                #include <encodings_fragment>
            }`,
        transparent: true, depthTest: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    });
    return NS.city.mat;
}
// 3km の区画の明るさ（リニア 0〜1）：まわり 4 画素からなめらかに
function _clTileKeyLoad(ti, tj) {
    tj = ((tj % 36) + 36) % 36;
    const key = ti + '_' + tj;
    if (!NS.lightsHave || !NS.lightsHave.has(key)) return null;
    let T = NS.tiles.get(key);
    if (T === undefined) {
        NS.tiles.set(key, 'loading');
        _nsDecodeR(`data/world/lights/l${String(ti).padStart(2, '0')}_${String(tj).padStart(2, '0')}.webp`)
            .then(d => NS.tiles.set(key, d.data)).catch(e => { console.warn('街明かりの区画を読めませんでした:', key, e); NS.tiles.set(key, null); });
        return 'loading';
    }
    return T;
}
function _clPix(gr, gc) {
    // gr：北極から 1/37.5° ごとの行、gc：西経 180° から 1/37.5° ごとの列
    if (gr < 0 || gr >= 6750) return 0;
    gc = ((gc % 13500) + 13500) % 13500;
    const ti = 17 - Math.floor(gr / 375), tj = Math.floor(gc / 375);
    const T = NS.tiles.get(ti + '_' + tj);
    if (!T || T === 'loading') return 0;
    const v = T[(gr % 375) * 375 + (gc % 375)];
    return v ? Math.pow(v / 255, 2.2) : 0;
}
function _clRadiance(lat, lon) {
    if (_nsRealWorld()) {
        const fr = (90 - lat) * 37.5 - 0.5, fc = (lon + 180) * 37.5 - 0.5;
        const r = Math.floor(fr), c = Math.floor(fc), a = fr - r, b = fc - c;
        return (_clPix(r, c) * (1 - b) + _clPix(r, c + 1) * b) * (1 - a) + (_clPix(r + 1, c) * (1 - b) + _clPix(r + 1, c + 1) * b) * a;
    }
    const P = NS.city.genPorts;
    if (!P) return 0;
    let s = 0;
    const kx = 111.2 * Math.cos(lat * Math.PI / 180);
    for (const p of P) {
        const dx = (lon - p.lon) * kx, dy = (lat - p.lat) * 111.2, q = NS_GEN_PORT_LIGHT[p.type] || NS_GEN_PORT_LIGHT.town;
        const r2 = (dx * dx + dy * dy) / (q[1] * q[1]);
        if (r2 < 9) s += q[0] * Math.exp(-r2);
    }
    return Math.min(1, s);
}
function _clGridH(G, x, z) {
    if (!G) return NaN;
    const step = G.half * 2 / (G.n - 1);
    const fi = (x - (G.cx - G.half)) / step, fj = (z - (G.cz - G.half)) / step;
    if (fi < 0 || fj < 0 || fi > G.n - 1.001 || fj > G.n - 1.001) return NaN;
    const i = Math.floor(fi), j = Math.floor(fj), a = fi - i, b = fj - j, n = G.n, H = G.H;
    return (H[j * n + i] * (1 - a) + H[j * n + i + 1] * a) * (1 - b) + (H[(j + 1) * n + i] * (1 - a) + H[(j + 1) * n + i + 1] * a) * b;
}
// 灯りの点を作る（何フレームかに分けて：1 フレーム 4ms まで）
function* _clBuildJob(N, Fr, Fi, cx, cz, year, q) {
    // 経緯度は 2km おきに正しく出して、その間は補間（地図の原点から遠くても北がずれないように）
    const half = Fr.half, gs = 2000, gn = Math.ceil(half * 2 / gs) + 1;
    const LL = new Float64Array(gn * gn * 2);
    for (let j = 0; j < gn; j++) for (let i = 0; i < gn; i++) {
        const ll = worldUnitToLatLon(worldLocalToUnit(cx - half + i * gs, cz - half + j * gs));
        LL[(j * gn + i) * 2] = ll.lat; LL[(j * gn + i) * 2 + 1] = ll.lon;
    }
    const llAt = (x, z) => {
        const fi = Math.min(gn - 1.001, Math.max(0, (x - (cx - half)) / gs)), fj = Math.min(gn - 1.001, Math.max(0, (z - (cz - half)) / gs));
        const i = Math.floor(fi), j = Math.floor(fj), a = fi - i, b = fj - j;
        const o00 = (j * gn + i) * 2, o10 = o00 + 2, o01 = o00 + gn * 2, o11 = o01 + 2;
        let l0 = LL[o00 + 1], l1 = LL[o10 + 1], l2 = LL[o01 + 1], l3 = LL[o11 + 1];
        if (Math.abs(l1 - l0) > 180) l1 += l1 < l0 ? 360 : -360;
        if (Math.abs(l2 - l0) > 180) l2 += l2 < l0 ? 360 : -360;
        if (Math.abs(l3 - l0) > 180) l3 += l3 < l0 ? 360 : -360;
        return [(LL[o00] * (1 - a) + LL[o10] * a) * (1 - b) + (LL[o01] * (1 - a) + LL[o11] * a) * b,
            (l0 * (1 - a) + l1 * a) * (1 - b) + (l2 * (1 - a) + l3 * a) * b];
    };
    // 要る区画を読み終えるまで待つ
    if (_nsRealWorld()) {
        for (;;) {
            let wait = false;
            const c = [llAt(cx - half, cz - half), llAt(cx + half, cz - half), llAt(cx - half, cz + half), llAt(cx + half, cz + half)];
            const la0 = Math.min(...c.map(v => v[0])), la1 = Math.max(...c.map(v => v[0]));
            let lo0 = Math.min(...c.map(v => v[1])), lo1 = Math.max(...c.map(v => v[1]));
            for (let ti = Math.floor((la0 + 90) / 10); ti <= Math.floor((la1 + 90) / 10); ti++)
                for (let tj = Math.floor((lo0 + 180) / 10); tj <= Math.floor((lo1 + 180) / 10); tj++)
                    if (_clTileKeyLoad(ti, tj) === 'loading') wait = true;
            if (!wait) break;
            yield 'wait';
        }
    }
    const mix = nsLampMix(year), yf = nsLightYearFactor(year);
    const cum = []; { let s = 0; for (const w of mix) { s += w; cum.push(s); } }
    const dq = (CL_DENS_Q[q] || 0.75) * Math.sqrt(yf) * 1e-6;     // [個/m²] に直す係数（画質・年代）
    const bright = Math.pow(yf, 0.35);
    const pos = [], col = [], inten = [];
    const shipX = physics.cgWorldX || 0, shipZ = physics.cgWorldZ || 0;
    const I0 = Math.floor((cx - half) / CL_CELL), I1 = Math.floor((cx + half) / CL_CELL), J0 = Math.floor((cz - half) / CL_CELL), J1 = Math.floor((cz + half) / CL_CELL);
    // 地面の明るさの絵（256×256：地形の材質が、陸の地面をほのかに光らせるのに使う。44-world-terrain.js の _trCityU）
    const GN = 256, glow = new Uint8Array(GN * GN * 4), gcell = half * 2 / GN;
    let gr = 0, gg = 0, gb = 0;
    for (let i = 0; i < 5; i++) { gr += mix[i] * NS_LAMPS[i][0]; gg += mix[i] * NS_LAMPS[i][1]; gb += mix[i] * NS_LAMPS[i][2]; }
    let t0 = performance.now();
    for (let j = 0; j < GN; j++) {
        for (let i = 0; i < GN; i++) {
            const ll = llAt(cx - half + (i + 0.5) * gcell, cz - half + (j + 0.5) * gcell);
            const r = Math.pow(_clRadiance(ll[0], ll[1]), 0.8);
            const o = (j * GN + i) * 4;
            glow[o] = Math.round(255 * r * gr); glow[o + 1] = Math.round(255 * r * gg); glow[o + 2] = Math.round(255 * r * gb); glow[o + 3] = 255;
        }
        if (performance.now() - t0 > 4) { yield 'work'; t0 = performance.now(); }
    }
    for (let J = J0; J <= J1; J++) {
        for (let I = I0; I <= I1; I++) {
            const x0 = I * CL_CELL, z0 = J * CL_CELL, xm = x0 + CL_CELL / 2, zm = z0 + CL_CELL / 2;
            // 升目の真ん中が陸の近くか（遠くの格子で粗く。海の真ん中の升目はすぐ飛ばす）
            let hm = _clGridH(Fr, xm, zm);
            if (Fi && !(hm > -15)) { const hf = _clGridH(Fi, xm, zm); if (Number.isFinite(hf)) hm = Math.max(hm, hf); }
            if (!(hm > -15)) continue;
            const ll = llAt(xm, zm);
            const rad = _clRadiance(ll[0], ll[1]);
            if (rad < 0.004) continue;
            // 灯りの数[個/km²]：近いほど多く（1km で約 700、3km で 160、遠くは 25：遠くは重なって帯に見えるので少なくてよい）
            const D = Math.hypot(xm - shipX, zm - shipZ);
            const dens = 25 + 1100 / (1 + (D / 1200) * (D / 1200));
            const exp = Math.pow(rad, 0.8) * dens * dq * CL_CELL * CL_CELL;
            // 数は「期待値 ＋ その升目の乱数」の切り捨て（船が動いて期待値が少し変わっても、増減するのは最後の 1 個だけ）
            const cnt = Math.min(120, Math.floor(exp + _clHash(I, J, 0)));
            for (let k = 0; k < cnt; k++) {
                const px = x0 + _clHash(I, J, k * 8 + 1) * CL_CELL, pz = z0 + _clHash(I, J, k * 8 + 2) * CL_CELL;
                // 高さ：港のそばの細かい格子（岸壁・埋立地）→ 近くの格子 → 遠くの格子
                let h = _clGridH(Fi, px, pz);
                if (!Number.isFinite(h)) h = _clGridH(N, px, pz);
                if (!Number.isFinite(h)) h = _clGridH(Fr, px, pz);
                if (!(h > 0.8) || h > 2500) continue;
                const r3 = _clHash(I, J, k * 8 + 3), r4 = _clHash(I, J, k * 8 + 4);
                // 街灯の高さ ＋ 明るい街ほど高い建物の窓の灯り。地形と同じく、惑星の丸みで遠いほど下げる
                let y = h + 3.5 + r3 * 8;
                if (rad > 0.45 && r4 < 0.18) y += r4 / 0.18 * r4 / 0.18 * 110 * rad;
                y -= ((px - cx) * (px - cx) + (pz - cz) * (pz - cz)) / (2 * WORLD_R);
                pos.push(px, y, pz);
                const rr = _clHash(I, J, k * 8 + 5);
                let li = 0; while (li < 4 && rr > cum[li]) li++;
                const L = NS_LAMPS[li];
                col.push(L[0], L[1], L[2]);
                inten.push(bright * (0.45 + 0.75 * _clHash(I, J, k * 8 + 6)) * (0.6 + 0.4 * Math.pow(rad, 0.3)));
            }
        }
        if (performance.now() - t0 > 4) { yield 'work'; t0 = performance.now(); }
    }
    return { pos, col, inten, glow, GN, box: [cx - half, cz - half, 1 / (2 * half), half] };

}
function _clClear() {
    const C = NS.city;
    if (C.pts) { scene.remove(C.pts); C.pts.geometry.dispose(); C.pts = null; }
    if (C.glowTex) { C.glowTex.dispose(); C.glowTex = null; }
    if (C.portPts) { scene.remove(C.portPts); C.portPts.geometry.dispose(); C.portPts = null; }
    C.portKey = '';
    C.job = null; C.builtId = -1;
}
function updateCityLights(t) {
    const C = NS.city;
    const T = window.terrain;
    const inWorld = window.world && world.mode === 'world';
    const night = typeof lightingNightFactor === 'number' ? lightingNightFactor : 0;
    const GU = window._trCityU;
    // 港の建物の窓の灯り（44-world-terrain.js の _pWindowLights）
    if (GU) GU.win.value = inWorld ? 0.9 * night * Math.pow(nsLightYearFactor(NS.year || 2026), 0.25) : 0;
    if (!inWorld || !T || !T.farH) { if (C.pts || C.job) _clClear(); if (GU) GU.k.value = 0; return; }
    // 地面のほのかな明るさ（街灯に照らされた地面）：作った絵がいまの地形のものなら
    if (GU) {
        if (C.glowTex) {          // （地形を作り直している間も、前の絵のまま：場所の座標で持っているので、そのまま正しい）
            GU.tex.value = C.glowTex; GU.box.value.set(C.glowBox[0], C.glowBox[1], C.glowBox[2], C.glowBox[3]);
            GU.k.value = 0.035 * night * Math.sqrt(nsLightYearFactor(NS.year));
        } else GU.k.value = 0;
    }
    if (_nsRealWorld() && !(night > 0.001 || NS.coarse)) return;      // （昼は街明かりの地図を読まない）
    if (_nsRealWorld() && !_nsEnsureLightsData()) return;
    if (_nsRealWorld() && !NS.lightsMeta) return;
    C.genPorts = _nsGenPorts();
    const q = (typeof perf !== 'undefined' && perf.quality) || 'medium';
    const id = T.farH.id;
    const nearOk = T.nearH && T.nearH.id === id && (!T.fineOn || (T.fineH && T.fineH.id === id));
    // 作り直す：新しい地形・年代が変わった（灯りの量・色）・画質を変えた
    if (nearOk && !C.job && (C.builtId !== id || Math.abs(NS.year - C.builtYear) > 3 || C.builtQ !== q) && night > 0.001) {
        C.job = _clBuildJob(T.nearH, T.farH, T.fineOn ? T.fineH : null, T.farH.cx, T.farH.cz, NS.year, q);
        C.jobId = id; C.jobYear = NS.year; C.jobQ = q;
    }
    if (C.job) {
        if (C.jobId !== id) C.job = null;
        else {
            const r = C.job.next();
            if (r.done) {
                C.job = null;
                const R = r.value;
                if (C.pts) { scene.remove(C.pts); C.pts.geometry.dispose(); C.pts = null; }
                if (R.pos.length) {
                    const g = new THREE.BufferGeometry();
                    g.setAttribute('position', new THREE.Float32BufferAttribute(R.pos, 3));
                    g.setAttribute('aCol', new THREE.Float32BufferAttribute(R.col, 3));
                    g.setAttribute('aI', new THREE.Float32BufferAttribute(R.inten, 1));
                    g.computeBoundingSphere();
                    C.pts = new THREE.Points(g, _clMaterial());
                    C.pts.renderOrder = 5;
                    C.pts.userData.noBloom = true;
                    scene.add(C.pts);
                }
                // 地面の明るさの絵
                if (!C.glowTex || C.glowTex.image.width !== R.GN) {
                    if (C.glowTex) C.glowTex.dispose();
                    C.glowTex = new THREE.DataTexture(R.glow, R.GN, R.GN, THREE.RGBAFormat);
                    C.glowTex.minFilter = THREE.LinearFilter; C.glowTex.magFilter = THREE.LinearFilter; C.glowTex.generateMipmaps = false;
                } else C.glowTex.image.data = R.glow;
                C.glowTex.needsUpdate = true;
                C.glowBox = R.box;
                C.builtId = C.jobId; C.builtYear = C.jobYear; C.builtQ = C.jobQ;
                C.count = R.pos.length / 3;
            }
        }
    }
    // 港の照明塔の灯り（44-world-terrain.js の港の施設の userData.lamps）と、照らされた岸壁・桟橋
    {
        let key = '';
        if (T.ports) for (const [id] of T.ports) key += id + ',';
        key += '|' + Math.round(NS.year / 4);
        if (key !== C.portKey) {
            C.portKey = key;
            if (C.portPts) { scene.remove(C.portPts); C.portPts.geometry.dispose(); C.portPts = null; }
            const pos = [], col = [], inten = [];
            const mix = nsLampMix(NS.year), yf = nsLightYearFactor(NS.year);
            // 照明塔は時代の主な街灯の色（昔はガス灯・白熱灯、ナトリウム灯の時代は橙、今は白）
            let li = 0; for (let i = 1; i < 5; i++) if (mix[i] > mix[li]) li = i;
            if (T.ports) for (const [, P] of T.ports) {
                const L = P.group.userData.lamps;
                if (!L) continue;
                for (const q of L) { pos.push(q.x, q.y, q.z); col.push(...NS_LAMPS[li]); inten.push(1.6 * Math.pow(yf, 0.3)); }
            }
            if (pos.length) {
                const g = new THREE.BufferGeometry();
                g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
                g.setAttribute('aCol', new THREE.Float32BufferAttribute(col, 3));
                g.setAttribute('aI', new THREE.Float32BufferAttribute(inten, 1));
                g.computeBoundingSphere();
                C.portPts = new THREE.Points(g, _clMaterial());
                C.portPts.renderOrder = 5;
                C.portPts.userData.noBloom = true;
                scene.add(C.portPts);
            }
        }
        if (C.portPts) C.portPts.visible = night > 0.01;
        // 照らされた岸壁・桟橋（44 の港の材質の emissive：夜だけ）
        if (typeof _pMats !== 'undefined') {
            const yk = night * Math.pow(nsLightYearFactor(NS.year), 0.4);
            if (_pMats.concrete) _pMats.concrete.emissive.setRGB(0.034, 0.029, 0.023).multiplyScalar(yk);
            if (_pMats.wood) _pMats.wood.emissive.setRGB(0.030, 0.024, 0.016).multiplyScalar(yk);
        }
        if (!C.mat) _clMaterial();
    }
    if (C.pts || C.portPts) {
        const u = C.mat.uniforms;
        u.uNight.value = night;
        u.uDpr.value = renderer.getPixelRatio();
        u.uFogD.value = scene.fog ? scene.fog.density : 0;
        u.uTw.value = performance.now() / 1000;
        // 双眼鏡で寄ると、灯りの点も少し大きく
        const fov = (typeof camera !== 'undefined' && camera && camera.fov) ? camera.fov / (camera.zoom || 1) : 50;
        u.uFov.value = Math.sqrt(50 / Math.max(1, fov));
        if (C.pts) C.pts.visible = night > 0.01;
    }
}
window.updateCityLights = updateCityLights;
