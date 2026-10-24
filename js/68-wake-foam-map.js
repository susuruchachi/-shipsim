// 68-wake-foam-map.js — 船の後ろに残る泡の帯（航跡の泡）
// ════════════════════════════════════════════════════════════════
//  船尾の後ろの水は、スクリュー（外輪）と船体の渦で泡立って白くなる。泡は水に浮いてその場に残るので、
//  船が進むと後ろに長い白い帯ができ、時間とともに薄れ・横へ広がって、まだらな泡の筋になって消えていく。
//  泡が消えた後も、細かい泡の混じった明るい青緑の帯がしばらく残る。
//  これを、カメラの見ている点のまわり（一辺 700〜2000m）を覆う 512×512 の「泡の地図」に毎フレーム書き足して残す。
//   r：白い泡（τ≈28 秒で減る）、g：泡の混じった水（τ≈120 秒）
//  水面のシェーダー（04-scene-and-water-init.js）がこれを読み、細かい波の模様で千切れた泡にして塗る。
//  ・地図は、前の絵を「新しい中心で見た位置」から読み直して作る（中心は画素の幅ずつ動かすので、絵はずれも
//    にじみもしない）。見ている点が動いても、泡はその場に残る
//  ・泡を出す所：自分の船のスクリュー・外輪（推進器の位置。回っているほど強く）と、船尾（速いほど強い船体の渦）。
//    他の船（59-traffic.js）は、近い 3 隻の船尾から
//  ・時間は物理の時間（時間倍率込み）で進める（倍速でも、泡の帯の長さ（m）は同じ）
//  ・8bit の絵に少しずつ減る値を書くと、丸めで減らなくなるので、書く前に画素ごとのばらつきを足して丸める
//    （平均すると正しく減る）

const WFM_N = 512;
const WFM_SEG = 10;
const WFM_TAU_FOAM = 28;     // 白い泡が 1/e になるまで[s]
const WFM_TAU_AIR = 120;     // 泡の混じった水
const WFM_SPREAD = 0.5;      // 横への広がり（拡散係数[m²/s]）
let _wfm = null;

function _wfmInit() {
    if (_wfm) return _wfm;
    if (typeof renderer === 'undefined' || !renderer || typeof THREE === 'undefined') return null;
    const opt = {
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
        wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
        format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
        depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    };
    const rtA = new THREE.WebGLRenderTarget(WFM_N, WFM_N, opt);
    const rtB = new THREE.WebGLRenderTarget(WFM_N, WFM_N, opt);
    const segA = [], segB = [];
    for (let i = 0; i < WFM_SEG; i++) { segA.push(new THREE.Vector4()); segB.push(new THREE.Vector4()); }
    const mat = new THREE.ShaderMaterial({
        uniforms: {
            prevTex:  { value: null },
            oldRect:  { value: new THREE.Vector3(0, 0, 1) },   // 前の地図の中心 x,z・一辺
            newRect:  { value: new THREE.Vector3(0, 0, 1) },
            keep:     { value: new THREE.Vector2(1, 1) },      // このフレームで残る割合（白い泡・泡の混じった水）
            spreadW:  { value: 0.0 },                          // 隣の画素へ広がる割合
            reset:    { value: 1.0 },
            segA:     { value: segA },                         // 泡を出す線分：始点 x,z・終点 x,z
            segB:     { value: segB },                         // 幅（ガウスの半径[m]）・白い泡の濃さ・泡の混じった水の濃さ
            segCount: { value: 0 },
            seed:     { value: 0.0 },
        },
        vertexShader: `
            varying vec2 vUv;
            void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
        `,
        fragmentShader: `
            precision highp float;
            #define WFM_N ${WFM_N}.0
            #define WFM_SEG ${WFM_SEG}
            uniform sampler2D prevTex;
            uniform vec3  oldRect;
            uniform vec3  newRect;
            uniform vec2  keep;
            uniform float spreadW;
            uniform float reset;
            uniform vec4  segA[WFM_SEG];
            uniform vec4  segB[WFM_SEG];
            uniform int   segCount;
            uniform float seed;
            varying vec2 vUv;
            vec2 readPrev(vec2 w) {
                vec2 u = (w - oldRect.xy) / oldRect.z + 0.5;
                if (u.x < 0.0 || u.y < 0.0 || u.x > 1.0 || u.y > 1.0) return vec2(0.0);
                return texture2D(prevTex, u).rg;
            }
            void main() {
                vec2 w = newRect.xy + (vUv - 0.5) * newRect.z;
                vec2 v = vec2(0.0);
                if (reset < 0.5) {
                    float px = oldRect.z / WFM_N;
                    vec2 s = readPrev(w + vec2(px, 0.0)) + readPrev(w - vec2(px, 0.0)) + readPrev(w + vec2(0.0, px)) + readPrev(w - vec2(0.0, px));
                    // 横への広がり（隣の画素とならす）
                    v = (readPrev(w) * (1.0 - 4.0 * spreadW) + s * spreadW) * keep;
                }
                for (int i = 0; i < WFM_SEG; i++) {
                    if (i >= segCount) break;
                    vec4 a = segA[i];
                    vec4 b = segB[i];
                    vec2 e = a.zw - a.xy;
                    float t = clamp(dot(w - a.xy, e) / max(dot(e, e), 1.0e-6), 0.0, 1.0);
                    vec2 d = w - (a.xy + e * t);
                    float g = exp(-dot(d, d) / (b.x * b.x));
                    v = max(v, g * b.yz);
                }
                float r = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233)) + seed) * 43758.5453);
                v = max(v + (r - 0.5) / 255.0, 0.0);
                gl_FragColor = vec4(v, 0.0, 1.0);
            }
        `,
        depthTest: false, depthWrite: false,
    });
    const scene = new THREE.Scene();
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    quad.frustumCulled = false;
    scene.add(quad);
    _wfm = {
        rtA, rtB, mat, scene, cam,
        cx: 0, cz: 0, size: 0, live: false, idle: 1e9,
        prev: new Map(), segs: [],
    };
    return _wfm;
}

// 泡を出す線分を 1 本足す（前のフレームの位置 → 今の位置。初めて・飛んだときは今の位置の点だけ）
function _wfmEmit(W, key, x, z, width, sFoam, sAir, dt) {
    const p = W.prev.get(key);
    W.prev.set(key, { x, z, used: true });
    if (!(sFoam > 0.01 || sAir > 0.01) || W.segs.length >= WFM_SEG) return;
    let x0 = x, z0 = z;
    if (p && Math.hypot(x - p.x, z - p.z) < Math.max(60, width * 4)) { x0 = p.x; z0 = p.z; }
    W.segs.push([x0, z0, x, z, Math.max(0.5, width), Math.min(1, sFoam), Math.min(1, sAir)]);
}

function _wfmOwnShip(W, dt) {
    if (typeof physics === 'undefined' || typeof shipGroup === 'undefined' || !shipGroup) return;
    if (typeof subSurfaceFxOff === 'function' && subSurfaceFxOff()) return;
    const uni = window._waterUniforms;
    const ps = Math.max(0.25, physics.scale || 1);
    const kn = Math.abs(physics.speed || 0);
    const rpm = Math.min(1, Math.abs(physics.propRpm || 0));
    const sm = THREE.MathUtils.smoothstep;
    // 船の幅（一番太い所の半幅）
    let hwMax = 0;
    if (uni && uni.hullWidthsU) { const a = uni.hullWidthsU.value; const n = Math.max(1, uni.hullSliceCountU ? uni.hullSliceCountU.value : a.length); for (let i = 0; i < n && i < a.length; i++) hwMax = Math.max(hwMax, a[i]); }
    if (!(hwMax > 0)) { const hp = window.hullProfile; hwMax = ((hp && hp.ready) ? hp.halfBeam : 1.5) * ps; }
    // 推進器（スクリュー・外輪。32-engine-propeller.js の泡の発生源と同じ）：回っているほど泡立つ。遅くても回せば泡立つ
    const src = (rpm > 0.01 && typeof getPropEmitSources === 'function') ? getPropEmitSources() : [];
    const sP = rpm * (0.35 + 0.65 * sm(kn, 1, 10));
    for (let i = 0; i < src.length && i < 4; i++) {
        const q = src[i];
        const w = q.paddle ? Math.max(1.0, q.radius * 1.2) : Math.max(q.radius * 2.6, hwMax * 0.32);
        _wfmEmit(W, 'p' + i, q.center.x, q.center.z, w, sP, Math.min(1, sP * 1.1), dt);
    }
    // 船尾：船体のまわりの渦（速いほど）
    const sH = 0.5 * sm(kn, 2, 14);
    if (sH > 0.01 && uni && uni.hullHalfLenU && typeof _hullOriginWorld === 'function' && typeof _wakeAxisRad === 'function') {
        const rotY = (physics.heading || 0) * Math.PI / 180;
        const o = _hullOriginWorld(physics.cgWorldX, physics.cgWorldZ, rotY, ps);
        const ax = _wakeAxisRad(rotY);
        const L = uni.hullHalfLenU.value;
        const a = uni.sternTipAlongNormU ? uni.sternTipAlongNormU.value : -1;
        _wfmEmit(W, 'h', o.x + Math.sin(ax) * L * a, o.z + Math.cos(ax) * L * a, hwMax * 0.7, sH, Math.min(1, sH + 0.3 * sm(kn, 1, 8)), dt);
    }
}

function _wfmTraffic(W, dt) {
    if (typeof traffic === 'undefined' || !traffic || !traffic.on || !traffic.ships || typeof _tfHullOf !== 'function') return;
    const cand = [];
    for (const S of traffic.ships) {
        if (!S.mesh || !S.mesh.visible || S.st === 'gone' || S.st === 'off' || S.st === 'damaged') continue;
        if (!(Math.abs(S.v || 0) > 0.5)) continue;
        const d = Math.hypot(S.mesh.position.x - W.fcx, S.mesh.position.z - W.fcz);
        if (d > W.fsize * 0.7 + (S.L || 0)) continue;
        cand.push([d, S]);
    }
    cand.sort((a, b) => a[0] - b[0]);
    const sm = THREE.MathUtils.smoothstep;
    for (let k = 0; k < Math.min(3, cand.length); k++) {
        const S = cand[k][1];
        const H = _tfHullOf(S); if (!H) continue;
        const v = S.v || 0, kn = Math.abs(v) / 0.514444, dir = v >= 0 ? 1 : -1;
        const a = -H.HL * 0.96 * dir;
        const s = Math.min(1, 0.5 * sm(kn, 2, 14) + 0.45 * sm(kn, 1, 8));
        _wfmEmit(W, S, H.x + H.fx * a, H.z + H.fz * a, Math.max(1.5, H.hw(a * 0.85) * 0.75), s, Math.min(1, s + 0.2), dt);
    }
}

// 毎フレーム（17-main-loop.js から。dt は物理の時間[s]）
function updateWakeFoamMap(dt) {
    const uni = window._waterUniforms;
    if (!uni || !uni.wakeFoamRect) return;
    if (typeof waterMesh !== 'undefined' && waterMesh && !waterMesh.visible) return;
    const W = _wfmInit();
    if (!W) return;
    dt = Math.max(0, Math.min(dt || 0, 5));
    // 地図の大きさ：船の長さの 5 倍くらい（小さい船は細かく、大きい船は長い帯まで。1 画素 1.4〜4m）
    const HL = uni.hullHalfLenU ? uni.hullHalfLenU.value : 50;
    const size = THREE.MathUtils.clamp(HL * 10, 700, 2000);
    // 中心：カメラが見ている点（他の船を追っているときはその船）。画素の幅ずつ動かす
    let fx = physics.cgWorldX || 0, fz = physics.cgWorldZ || 0;
    if (typeof controls !== 'undefined' && controls && controls.target) { fx = controls.target.x; fz = controls.target.z; }
    const px = size / WFM_N;
    const cx = Math.round(fx / px) * px, cz = Math.round(fz / px) * px;
    // 泡を出す所を集める
    W.segs.length = 0;
    for (const v of W.prev.values()) v.used = false;
    W.fcx = cx; W.fcz = cz; W.fsize = size;
    if (dt > 0) { _wfmOwnShip(W, dt); _wfmTraffic(W, dt); }
    for (const [k, v] of W.prev) if (!v.used) W.prev.delete(k);
    // 何も出さずに十分たてば、地図は空（描くのも読むのもやめる）
    if (W.segs.length) W.idle = 0; else W.idle += dt;
    if (!W.segs.length && W.idle > WFM_TAU_AIR * 6) {
        W.live = false;
        uni.wakeFoamRect.value.w = 0;
        return;
    }
    // 大きさが変わった・遠くへ飛んだ（世界の原点を移した等）・空だった：まっさらから
    const reset = !W.live || Math.abs(size - W.size) > 1e-3 || Math.hypot(cx - W.cx, cz - W.cz) > size * 0.5;
    if (dt <= 0 && !reset) return;
    const m = W.mat.uniforms;
    m.prevTex.value = W.rtA.texture;
    m.oldRect.value.set(W.cx, W.cz, W.size || size);
    m.newRect.value.set(cx, cz, size);
    m.keep.value.set(Math.exp(-dt / WFM_TAU_FOAM), Math.exp(-dt / WFM_TAU_AIR));
    m.spreadW.value = Math.min(0.2, WFM_SPREAD * dt / (px * px));
    m.reset.value = reset ? 1 : 0;
    m.segCount.value = W.segs.length;
    for (let i = 0; i < W.segs.length; i++) {
        const s = W.segs[i];
        m.segA.value[i].set(s[0], s[1], s[2], s[3]);
        m.segB.value[i].set(s[4], s[5], s[6], 0);
    }
    m.seed.value = (m.seed.value + 1.618) % 97;
    const savedRT = renderer.getRenderTarget();
    const savedClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(W.rtB);
    renderer.render(W.scene, W.cam);
    renderer.setRenderTarget(savedRT);
    renderer.autoClear = savedClear;
    const tmp = W.rtA; W.rtA = W.rtB; W.rtB = tmp;
    W.cx = cx; W.cz = cz; W.size = size; W.live = true;
    uni.wakeFoamTex.value = W.rtA.texture;
    uni.wakeFoamRect.value.set(cx, cz, size, 1);
}
window.updateWakeFoamMap = updateWakeFoamMap;
