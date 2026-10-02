// 52-puffs.js — 小さな煙・湯気・しぶきの粒（タグの排煙・汽笛の蒸気・岩に砕ける波など）
//
// 船の排煙（03-particle-systems.js）は船の大きさに合わせた1種類の煙なので、ここでは
// 大きさ[m]・色・寿命・浮き上がり・空気抵抗を粒ごとに持てる、汎用の粒を1つの描画にまとめる。
//   puffEmit({ x, y, z, vx, vy, vz, life, s0, s1, r, g, b, a, rise, drag, grav })
//     s0 → s1：出たとき → 消えるときの大きさ[m]、a：濃さ、rise：浮き上がる加速度[m/s²]、
//     drag：まわりの空気（風）に馴染む速さ[1/s]、grav：重力（しぶき）なら 1
//   updatePuffs(t, dt)：毎フレーム（17-main-loop.js）

const PUFF_MAX = 1800;
const puffState = { pts: null, geo: null, mat: null, n: 0, idx: 0, vel: new Float32Array(PUFF_MAX * 3), life: new Float32Array(PUFF_MAX),
    s0: new Float32Array(PUFF_MAX), s1: new Float32Array(PUFF_MAX), a0: new Float32Array(PUFF_MAX), rise: new Float32Array(PUFF_MAX),
    drag: new Float32Array(PUFF_MAX), grav: new Float32Array(PUFF_MAX) };

function _puffInit() {
    if (puffState.pts || typeof scene === 'undefined' || !scene) return !!puffState.pts;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PUFF_MAX * 3), 3));
    geo.setAttribute('aCol', new THREE.BufferAttribute(new Float32Array(PUFF_MAX * 3), 3));
    geo.setAttribute('aAge', new THREE.BufferAttribute(new Float32Array(PUFF_MAX).fill(2), 1));   // 0〜1、1を超えたら消えている
    geo.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(PUFF_MAX), 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(PUFF_MAX), 1));
    const mat = new THREE.ShaderMaterial({
        uniforms: {
            uPixelScale: { value: 500 },
            uLight: { value: 1 },
            uFogColor: particleFogUniforms.uFogColor,
            uFogDensity: particleFogUniforms.uFogDensity,
        },
        vertexShader: `
            attribute vec3 aCol; attribute float aAge, aSize, aAlpha;
            uniform float uPixelScale;
            varying vec3 vCol; varying float vA, vFogDist;
            #ifdef USE_LOGDEPTHBUF
                uniform float logDepthBufFC;
            #endif
            void main() {
                if (aAge > 1.0) { gl_PointSize = 0.0; gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vA = 0.0; return; }
                vec4 mv = modelViewMatrix * vec4(position, 1.0);
                float dist = max(0.1, -mv.z);
                vFogDist = dist;
                float px = aSize * uPixelScale / dist;
                gl_PointSize = clamp(px, 1.0, 400.0);
                vCol = aCol;
                // 出てすぐふわっと濃くなり、終わりにかけて薄れる。画面いっぱいの近くの粒は薄く
                vA = aAlpha * smoothstep(0.0, 0.08, aAge) * (1.0 - smoothstep(0.45, 1.0, aAge)) * (1.0 - smoothstep(220.0, 400.0, px));
                gl_Position = projectionMatrix * mv;
                #ifdef USE_LOGDEPTHBUF
                    gl_Position.z = log2(max(1e-6, gl_Position.w + 1.0)) * logDepthBufFC - 1.0;
                    gl_Position.z *= gl_Position.w;
                #endif
            }`,
        fragmentShader: `
            uniform float uLight; uniform vec3 uFogColor; uniform float uFogDensity;
            varying vec3 vCol; varying float vA, vFogDist;
            void main() {
                vec2 c = gl_PointCoord - 0.5;
                float r2 = dot(c, c) * 4.0;
                if (r2 > 1.0 || vA <= 0.003) discard;
                float a = (1.0 - r2) * (1.0 - r2) * vA;
                gl_FragColor = vec4(vCol * uLight, a);
                float fogD = uFogDensity * vFogDist;
                gl_FragColor.rgb = mix(gl_FragColor.rgb, uFogColor, clamp(1.0 - exp(-fogD * fogD), 0.0, 1.0));
                #include <tonemapping_fragment>
                #include <encodings_fragment>
            }`,
        transparent: true, depthWrite: false, depthTest: true, blending: THREE.NormalBlending,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false; pts.renderOrder = 11; pts.userData.noBloom = true; pts.name = 'Puffs';
    scene.add(pts);
    Object.assign(puffState, { pts, geo, mat });
    return true;
}

function puffEmit(o) {
    if (!_puffInit()) return;
    const i = puffState.idx; puffState.idx = (i + 1) % PUFF_MAX;
    const G = puffState.geo.attributes;
    G.position.array.set([o.x, o.y, o.z], i * 3);
    G.aCol.array.set([o.r ?? 0.6, o.g ?? 0.6, o.b ?? 0.6], i * 3);
    G.aAge.array[i] = 0;
    G.aSize.array[i] = o.s0 ?? 2;
    G.aAlpha.array[i] = o.a ?? 0.5;
    puffState.vel.set([o.vx || 0, o.vy || 0, o.vz || 0], i * 3);
    puffState.life[i] = o.life || 4;
    puffState.s0[i] = o.s0 ?? 2; puffState.s1[i] = o.s1 ?? 8;
    puffState.a0[i] = o.a ?? 0.5;
    puffState.rise[i] = o.rise ?? 0.6;
    puffState.drag[i] = o.drag ?? 0.6;
    puffState.grav[i] = o.grav || 0;
}
window.puffEmit = puffEmit;

const _puffPush = { x: 0, y: 0, z: 0 };
function updatePuffs(t, dt) {
    if (typeof updateShoreSpray === 'function') updateShoreSpray(t, Math.min(0.1, Math.max(0, dt || 0)));
    if (!puffState.pts) return;
    dt = Math.min(0.1, Math.max(0, dt || 0));
    const G = puffState.geo.attributes, P = G.position.array, A = G.aAge.array, S = G.aSize.array, V = puffState.vel;
    // 風（排煙と同じ：03 / 12）
    const wr = (physics.windDir || 0) * Math.PI / 180, ws = (physics.windSpeed || 0) * 0.5;
    const wX = Math.sin(wr) * ws, wZ = Math.cos(wr) * ws;
    let any = false;
    const solidOn = typeof shipSolidPushUp === 'function' && window.shipSolid && shipSolid.G;
    for (let i = 0; i < PUFF_MAX; i++) {
        if (A[i] > 1) continue;
        any = true;
        A[i] += dt / puffState.life[i];
        const k = Math.min(1, puffState.drag[i] * dt), j = i * 3;
        V[j] += (wX - V[j]) * k; V[j + 2] += (wZ - V[j + 2]) * k;
        V[j + 1] += (puffState.rise[i] - 9.8 * puffState.grav[i]) * dt - V[j + 1] * k * 0.5 * (1 - puffState.grav[i]);
        P[j] += V[j] * dt; P[j + 1] += V[j + 1] * dt; P[j + 2] += V[j + 2] * dt;
        const u = Math.min(1, A[i]);
        S[i] = puffState.s0[i] + (puffState.s1[i] - puffState.s0[i]) * Math.sqrt(u);
        // しぶきは水面より下へ落ちたら消す
        if (puffState.grav[i] > 0 && V[j + 1] < 0 && P[j + 1] < -0.5) A[i] = 2;
        // 船の中に入ったら（60-ship-solid.js）：煙・湯気は上へ押し出し、しぶきは消す
        else if (solidOn && shipSolidPushUp(P[j], P[j + 1], P[j + 2], _puffPush)) {
            if (puffState.grav[i] > 0) A[i] = 2;
            else { P[j] = _puffPush.x; P[j + 1] = _puffPush.y; P[j + 2] = _puffPush.z; if (V[j + 1] < 0) V[j + 1] = 0; }
        }
    }
    if (!any) return;
    G.position.needsUpdate = true; G.aAge.needsUpdate = true; G.aSize.needsUpdate = true;
    G.aCol.needsUpdate = true; G.aAlpha.needsUpdate = true;
    const u = puffState.mat.uniforms;
    if (typeof camera !== 'undefined' && camera && typeof renderer !== 'undefined' && renderer)
        u.uPixelScale.value = renderer.domElement.height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    // 明るさ：排煙と同じ係数と、しぶき（12-bloom-...js の _fxLight：曇天・夜に暗く）の小さい方
    if (typeof globalSmokeMat !== 'undefined' && globalSmokeMat) u.uLight.value = Math.min(globalSmokeMat.uniforms.lightFactor.value, window._fxLight ?? 1);
}
window.updatePuffs = updatePuffs;

// ── 岩・岸に打ちつける波のしぶき ──
// カメラのまわり（±800m）の波打ち際（陸・岩と水の境で、水側がある程度深い所）を時々調べておき、
// 波の山がそこへ「届いた瞬間」（その点の波の高さが上向きに、しきい値を越えたとき）だけ、しぶきを打ち上げる。
// 以前は波打ち際の点をでたらめに調べ、波の山の上なら出していたので、いつもどこかでしぶきが出続けていた。
// 見た目は船の喫水線のしぶき（03-particle-systems.js の水しぶき・波切りの筋・泡）と同じ描き方にする。
// 打ち上げた所の沖側には泡を浮かべ、波が当たった跡が白く残るようにする。
const SPRAY_R = 800, SPRAY_STEP = 20;
const sprayState = { pts: [], cx: 1e12, cz: 1e12, t: -1e9, scan: null, cur: 0 };
function _sprayScanStep(budget) {
    const S = sprayState, sc = S.scan;
    const n = Math.floor(SPRAY_R * 2 / SPRAY_STEP);
    while (budget-- > 0 && sc.j < n) {
        const z = sc.z0 + sc.j * SPRAY_STEP;
        for (let i = 0; i < n; i++) {
            const x = sc.x0 + i * SPRAY_STEP;
            const h = worldSeabedAt(x, z);
            if (h < 0.3 || h > 25) continue;
            // 4方向のどこかが水（深さ 1.5m 以上）なら波打ち際
            let wx = 0, wz = 0, deep = 0;
            for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const hh = worldSeabedAt(x + a * SPRAY_STEP, z + b * SPRAY_STEP);
                if (hh < -1.5) { wx += a; wz += b; deep = Math.max(deep, -hh); }
            }
            if (!deep) continue;
            const L = Math.hypot(wx, wz) || 1;
            sc.out.push({ x, z, nx: wx / L, nz: wz / L, rock: h > 2 || deep > 6 ? 1 : 0.5, prev: 0, cool: 0 });
        }
        sc.j++;
    }
    if (sc.j >= n) { S.pts = sc.out; S.cur = 0; S.scan = null; }
}

// 船の喫水線のしぶきと同じ粒（同じ絵・同じシェーダー）。大きさは船の大きさに関係なく決める
const ROCK_MAX = 1400;
const rockFx = { pts: null, geo: null, idx: 0, d: [] };
function _rockFxInit() {
    if (rockFx.pts) return true;
    if (typeof wakeParticleMat === 'undefined' || !wakeParticleMat || typeof scene === 'undefined' || !scene) return false;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(ROCK_MAX * 3), age = new Float32Array(ROCK_MAX).fill(999);
    for (let i = 0; i < ROCK_MAX; i++) { pos[i * 3 + 1] = -9999; rockFx.d.push({ vx: 0, vy: 0, vz: 0, type: 0, rate: 1, t0: 0 }); }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('age', new THREE.BufferAttribute(age, 1));
    geo.setAttribute('ptype', new THREE.BufferAttribute(new Float32Array(ROCK_MAX), 1));
    geo.setAttribute('velocity', new THREE.BufferAttribute(new Float32Array(ROCK_MAX * 3), 3));
    const mat = wakeParticleMat.clone();
    // 霧は共有（clone すると値が写されるだけなので、元の入れ物を指し直す）
    mat.uniforms.uFogColor = particleFogUniforms.uFogColor;
    mat.uniforms.uFogDensity = particleFogUniforms.uFogDensity;
    mat.uniforms.sizeScale.value = 0.7;
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false; pts.renderOrder = 12; pts.userData.noBloom = true; pts.name = 'RockSpray';
    scene.add(pts);
    Object.assign(rockFx, { pts, geo });
    return true;
}
// type 0＝泡（水面に浮く）・1＝水しぶき・2＝波切りの筋
function _rockEmit(x, y, z, vx, vy, vz, type, t) {
    if (!_rockFxInit()) return;
    const i = rockFx.idx; rockFx.idx = (i + 1) % ROCK_MAX;
    const G = rockFx.geo.attributes, D = rockFx.d[i];
    G.position.array[i * 3] = x; G.position.array[i * 3 + 1] = y; G.position.array[i * 3 + 2] = z;
    G.age.array[i] = 0; G.ptype.array[i] = type;
    D.vx = vx; D.vy = vy; D.vz = vz; D.type = type; D.t0 = t;
    // 年齢の進む速さ（喫水線のしぶきと同じ：泡は長く、しぶきは一瞬）
    // （泡は喫水線の泡より短く：大きく広がって霧の塊のように見えないように。白い泡の広がりは海面の側で：04）
    D.rate = (type === 0 ? 0.2 : type === 2 ? 0.55 : 0.75) * (0.8 + Math.random() * 0.4);
}
function _rockFxUpdate(t, dt) {
    if (!rockFx.pts) return;
    const G = rockFx.geo.attributes, P = G.position.array, A = G.age.array, V = G.velocity.array;
    const U = rockFx.pts.material.uniforms;
    if (typeof wakeParticleMat !== 'undefined' && wakeParticleMat) {
        U.lightFactor.value = wakeParticleMat.uniforms.lightFactor.value;
        U.uAspect.value = wakeParticleMat.uniforms.uAspect.value;
        if (U.uResK && wakeParticleMat.uniforms.uResK) U.uResK.value = wakeParticleMat.uniforms.uResK.value;
    }
    const hasH = typeof getOceanHeight === 'function';
    let any = false;
    for (let i = 0; i < ROCK_MAX; i++) {
        if (A[i] > 1) continue;
        any = true;
        const D = rockFx.d[i], j = i * 3;
        A[i] += dt * D.rate;
        if (D.type === 0) {
            // 泡：波の上に浮いて、ゆっくり沖へ広がる
            D.vx *= Math.exp(-dt * 0.4); D.vz *= Math.exp(-dt * 0.4);
            P[j] += D.vx * dt; P[j + 2] += D.vz * dt;
            P[j + 1] = (hasH ? getOceanHeight(P[j], P[j + 2], t) : 0) + 0.15;
        } else {
            D.vy -= 9.8 * dt;
            P[j] += D.vx * dt; P[j + 1] += D.vy * dt; P[j + 2] += D.vz * dt;
            // 落ちて海面に着いたら消える（出てすぐは消さない）
            if (t - D.t0 > 0.4 && D.vy < 0 && P[j + 1] < (hasH ? getOceanHeight(P[j], P[j + 2], t) : 0)) A[i] = 999;
        }
        V[j] = D.vx; V[j + 1] = D.vy; V[j + 2] = D.vz;
    }
    if (!any) return;
    G.position.needsUpdate = true; G.age.needsUpdate = true; G.ptype.needsUpdate = true; G.velocity.needsUpdate = true;
}
// 波が 1 つ当たったときのしぶき（k：強さ 0〜3）。
// 煙突の排煙のように、薄いしぶきの幕が一瞬だけ広くバッと立って消える（ふわっとした粒を広く・薄く・短く）。
// 細かい水滴（喫水線のしぶきと同じ粒）は少しだけ。濃い塊にならないよう、どれも薄く
function _rockSplash(p, k, rough, t, wy) {
    const up = 2.5 + rough * 1.6 * k;                    // 立ち上がる速さ[m/s]
    const j = () => Math.random() - 0.5;
    const tx = -p.nz, tz = p.nx;                          // 岸に沿う向き
    const w = 10 + 6 * k;                                 // 岸に沿って広がる幅[m]
    for (let q = 0, n = 3 + Math.round(2 * k); q < n; q++) {
        const u = j() * w, c = 0.88 + Math.random() * 0.08;
        puffEmit({ x: p.x + p.nx * (2 + Math.random() * 4) + tx * u, y: wy + 0.5, z: p.z + p.nz * (2 + Math.random() * 4) + tz * u,
            vx: p.nx * (0.5 + Math.random()) + tx * j() * 2, vy: up * (0.6 + Math.random() * 0.5), vz: p.nz * (0.5 + Math.random()) + tz * j() * 2,
            life: 1.1 + Math.random() * 0.8, s0: 3 + 1.5 * k, s1: 10 + 6 * k, r: c, g: c, b: c, a: 0.16 + 0.05 * Math.min(2, k),
            rise: 0, drag: 0.9, grav: 0.25 });
    }
    for (let q = 0, n = 2 + Math.round(2 * k); q < n; q++)
        _rockEmit(p.x + p.nx * 2 + tx * j() * w, wy + 0.3, p.z + p.nz * 2 + tz * j() * w,
            p.nx * (1 + Math.random() * 1.5) + j() * 2, up * (0.6 + Math.random() * 0.6), p.nz * (1 + Math.random() * 1.5) + j() * 2, 1, t);
}
function updateShoreSpray(t, dt) {
    _rockFxUpdate(t, dt);
    if (!window.world || world.mode !== 'world' || typeof worldSeabedAt !== 'function' || typeof camera === 'undefined' || !camera) return;
    const S = sprayState, cx = camera.position.x, cz = camera.position.z;
    if (!S.scan && (Math.hypot(cx - S.cx, cz - S.cz) > 250 || t - S.t > 20 || t < S.t)) {
        S.cx = cx; S.cz = cz; S.t = t;
        S.scan = { x0: cx - SPRAY_R, z0: cz - SPRAY_R, j: 0, out: [] };
    }
    if (S.scan) _sprayScanStep(2);           // 1フレームに2行ずつ（重くならないように）
    if (!S.pts.length || typeof getOceanHeight !== 'function' || !dt) return;
    const rough = physics.waveRoughness || 0;
    if (rough < 0.25) return;
    // 波打ち際の点を順番に（1 フレームに最大 120 点）調べ、波の高さがしきい値を下から越えた点だけ打ち上げる
    const N = S.pts.length, per = Math.min(N, 120);
    const thr = rough * 0.55;
    let budget = Math.round(10 + rough * 6);              // 1 フレームに打ち上げる所の数の上限（重くならないように）
    for (let c = 0; c < per; c++) {
        const p = S.pts[S.cur]; S.cur = (S.cur + 1) % N;
        const wh = getOceanHeight(p.x + p.nx * 6, p.z + p.nz * 6, t);
        const crossed = p.prev < thr && wh >= thr;
        p.prev = wh;
        if (p.cool > t) continue;
        if (!crossed || budget <= 0) continue;
        budget--;
        p.cool = t + 2.5;                                   // 同じ所は続けて打ち上げない
        const k = Math.min(3, wh / Math.max(0.3, rough)) * p.rock;
        _rockSplash(p, k, rough, t, getOceanHeight(p.x, p.z, t));
    }
}
window.updateShoreSpray = updateShoreSpray;
