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

function updatePuffs(t, dt) {
    if (typeof updateShoreSpray === 'function') updateShoreSpray(t, Math.min(0.1, Math.max(0, dt || 0)));
    if (!puffState.pts) return;
    dt = Math.min(0.1, Math.max(0, dt || 0));
    const G = puffState.geo.attributes, P = G.position.array, A = G.aAge.array, S = G.aSize.array, V = puffState.vel;
    // 風（排煙と同じ：03 / 12）
    const wr = (physics.windDir || 0) * Math.PI / 180, ws = (physics.windSpeed || 0) * 0.5;
    const wX = Math.sin(wr) * ws, wZ = Math.cos(wr) * ws;
    let any = false;
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
    }
    if (!any) return;
    G.position.needsUpdate = true; G.aAge.needsUpdate = true; G.aSize.needsUpdate = true;
    G.aCol.needsUpdate = true; G.aAlpha.needsUpdate = true;
    const u = puffState.mat.uniforms;
    if (typeof camera !== 'undefined' && camera && typeof renderer !== 'undefined' && renderer)
        u.uPixelScale.value = renderer.domElement.height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    if (typeof globalSmokeMat !== 'undefined' && globalSmokeMat) u.uLight.value = globalSmokeMat.uniforms.lightFactor.value;
}
window.updatePuffs = updatePuffs;

// ── 岩・岸に打ちつける波のしぶき ──
// カメラのまわり（±800m）の波打ち際（陸・岩と水の境で、水側がある程度深い所）を時々調べておき、
// 波の山がそこへ来たら白いしぶきを打ち上げる。波が高いほど高く・多く。岩場（急な所）ほど派手に。
const SPRAY_R = 800, SPRAY_STEP = 20;
const sprayState = { pts: [], cx: 1e12, cz: 1e12, t: -1e9, scan: null, acc: 0 };
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
            sc.out.push({ x, z, nx: wx / L, nz: wz / L, rock: h > 2 || deep > 6 ? 1 : 0.5 });
        }
        sc.j++;
    }
    if (sc.j >= n) { S.pts = sc.out; S.scan = null; }
}
function updateShoreSpray(t, dt) {
    if (!window.world || world.mode !== 'world' || typeof worldSeabedAt !== 'function' || typeof camera === 'undefined' || !camera) return;
    const S = sprayState, cx = camera.position.x, cz = camera.position.z;
    if (!S.scan && (Math.hypot(cx - S.cx, cz - S.cz) > 250 || t - S.t > 20 || t < S.t)) {
        S.cx = cx; S.cz = cz; S.t = t;
        S.scan = { x0: cx - SPRAY_R, z0: cz - SPRAY_R, j: 0, out: [] };
    }
    if (S.scan) _sprayScanStep(2);           // 1フレームに2行ずつ（重くならないように）
    if (!S.pts.length || typeof getOceanHeight !== 'function') return;
    const rough = physics.waveRoughness || 0;
    if (rough < 0.25) return;
    // 1秒に調べる点の数（波が高いほど多く）。波の山（高さが大きい所）に当たった点だけ打ち上げる
    S.acc += dt * Math.min(60, 8 + rough * 10);
    while (S.acc >= 1) {
        S.acc -= 1;
        const p = S.pts[(Math.random() * S.pts.length) | 0];
        const wh = getOceanHeight(p.x + p.nx * 6, p.z + p.nz * 6, t);
        if (wh < rough * 0.5) continue;
        const k = Math.min(3, wh / Math.max(0.3, rough)) * p.rock;
        const up = 3 + rough * 2.2 * k;
        const nn = 3 + Math.round(4 * k);
        for (let q = 0; q < nn; q++) {
            const j = () => (Math.random() - 0.5);
            const c = 0.9 + Math.random() * 0.08;
            puffEmit({ x: p.x + p.nx * 3 + j() * 8, y: 0.5 + Math.random(), z: p.z + p.nz * 3 + j() * 8,
                vx: -p.nx * (1 + Math.random() * 2) + j() * 2, vy: up * (0.6 + Math.random() * 0.6), vz: -p.nz * (1 + Math.random() * 2) + j() * 2,
                life: 1.6 + Math.random() * 1.2, s0: 1.5 + k, s1: 5 + 4 * k, r: c, g: c, b: c, a: 0.6, rise: 0, drag: 0.4, grav: 1 });
        }
    }
}
window.updateShoreSpray = updateShoreSpray;
