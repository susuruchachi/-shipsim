// 29-weather-fx.js — 天候の見た目：雨・雷・空の曇り/霞
//
// 天候の「量」（雲量・雨量・霧・風）は 24-weather.js が決める。ここはそれを
// 見た目に変える係。
//
//   ・雨   : カメラのまわり（箱の中）に雨筋を降らせる。位置の計算は全部GPUで
//            行い、箱からはみ出した雨粒は反対側から戻す（無限に降り続けて見える）。
//            近くで光っている灯り（25-area-lights.js の枠）に照らされて光る。
//   ・雷   : 嵐（雨が強く風も強い）のときに、ときどき空が光り、稲妻が落ちる。
//            閃光の間だけ環境光を持ち上げ、描画後に元へ戻す。
//   ・空   : どんより暗い空・霧や雨で霞む空（05-sky-dome.js の uniform）。

// 画質ごとの雨粒の数
const RAIN_DROPS_BY_QUALITY = { high: 8000, medium: 5000, low: 3000, verylow: 1500, ultralow: 800 };
const RAIN_BOX = new THREE.Vector3(70, 40, 70);   // カメラのまわりの雨を降らせる範囲[m]
const RAIN_FALL_SPEED = 9.0;                      // 落下速度[m/s]
const RAIN_WIND_DRIFT = 0.55;                     // 風速に対する横流れの割合
const RAIN_LIGHT_MAX = 6;                         // 雨を照らす灯りの最大数
const RAIN_LIGHT_RADIUS = 9.0;                    // 灯りが雨を照らす範囲の目安[m]

// 雷
const LIGHTNING_MIN_INTERVAL = 4.0;    // 秒（嵐が最も激しいとき）
const LIGHTNING_MAX_INTERVAL = 16.0;
const LIGHTNING_BOLT_CHANCE = 0.6;     // 稲妻が見える割合（残りは雲の中が光るだけ）

let _rain = null;           // { points, uniforms, count }
let _rainOffset = new THREE.Vector3();
let _fxLastT = -1;
let _lightning = { next: 12, strike: null };
let _fxSaved = null;        // 描画前に退避した光の強さ
window.lightningFlash = 0;

function _fxQuality() {
    return (typeof perf !== 'undefined' && perf.quality) ? perf.quality : 'medium';
}

// ── 雨 ──────────────────────────────────────────────────────────────
function _buildRain() {
    const n = RAIN_DROPS_BY_QUALITY[_fxQuality()] || 5000;
    const seed = new Float32Array(n * 2 * 4);
    const end = new Float32Array(n * 2);
    const pos = new Float32Array(n * 2 * 3);   // 使わないが three.js が要求する
    for (let i = 0; i < n; i++) {
        const sx = Math.random(), sy = Math.random(), sz = Math.random(), r = Math.random();
        for (let k = 0; k < 2; k++) {
            const v = i * 2 + k;
            seed[v * 4] = sx; seed[v * 4 + 1] = sy; seed[v * 4 + 2] = sz; seed[v * 4 + 3] = r;
            end[v] = k;
        }
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geom.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
    geom.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));

    const lightPos = [], lightCol = [];
    for (let i = 0; i < RAIN_LIGHT_MAX; i++) { lightPos.push(new THREE.Vector3()); lightCol.push(new THREE.Vector3()); }
    const uniforms = {
        uCamPos:    { value: new THREE.Vector3() },
        uOffset:    { value: new THREE.Vector3() },
        uBox:       { value: RAIN_BOX.clone() },
        uStreakDir: { value: new THREE.Vector3(0, -1, 0) },
        uStreakLen: { value: 0.7 },
        uAmount:    { value: 0 },
        uBase:      { value: new THREE.Vector3(0.3, 0.32, 0.35) },
        uSeaLevel:  { value: 0 },
        uLightPos:  { value: lightPos },
        uLightCol:  { value: lightCol },
        uLightCount:{ value: 0 },
        uLightR2:   { value: RAIN_LIGHT_RADIUS * RAIN_LIGHT_RADIUS },
    };
    const mat = new THREE.ShaderMaterial({
        uniforms,
        vertexShader: `
            attribute vec4 aSeed;
            attribute float aEnd;
            uniform vec3 uCamPos, uOffset, uBox, uStreakDir, uBase;
            uniform float uStreakLen, uAmount, uSeaLevel, uLightR2;
            uniform vec3 uLightPos[${RAIN_LIGHT_MAX}];
            uniform vec3 uLightCol[${RAIN_LIGHT_MAX}];
            uniform int uLightCount;
            varying vec3 vColor;
            varying float vAlpha;
            varying float vWorldY;
            void main() {
                // 雨量に応じて使う雨粒の数を変える（aSeed.w が雨量より小さいものだけ）
                if (aSeed.w > uAmount) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vAlpha = 0.0; return; }
                vec3 minC = uCamPos - uBox * 0.5;
                vec3 p = aSeed.xyz * uBox + uOffset;
                p = minC + mod(p - minC, uBox);          // 箱からはみ出したら反対側へ
                vec3 world = p - uStreakDir * uStreakLen * aEnd;
                vWorldY = world.y;

                // 近くの灯りに照らされる（距離で柔らかく減衰）
                vec3 col = uBase;
                for (int i = 0; i < ${RAIN_LIGHT_MAX}; i++) {
                    if (i >= uLightCount) break;
                    vec3 d = p - uLightPos[i];
                    col += uLightCol[i] / (1.0 + dot(d, d) / uLightR2);
                }
                vColor = col;
                // カメラに近い雨粒ほどはっきり、遠いものは薄く。尾（aEnd=1）は薄く。
                float dist = length(p - uCamPos);
                vAlpha = (1.0 - smoothstep(8.0, uBox.x * 0.5, dist)) * mix(1.0, 0.25, aEnd);
                gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
            }`,
        fragmentShader: `
            varying vec3 vColor;
            varying float vAlpha;
            varying float vWorldY;
            uniform float uSeaLevel;
            void main() {
                if (vWorldY < uSeaLevel) discard;   // 海の中には降らない
                gl_FragColor = vec4(vColor * vAlpha, 1.0);
            }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
    });
    const lines = new THREE.LineSegments(geom, mat);
    lines.frustumCulled = false;
    lines.name = 'Rain';
    lines.renderOrder = 6;
    lines.userData.noBloom = true;
    scene.add(lines);
    _rain = { lines, uniforms, quality: _fxQuality() };
}

function _disposeRain() {
    if (!_rain) return;
    scene.remove(_rain.lines);
    _rain.lines.geometry.dispose();
    _rain.lines.material.dispose();
    _rain = null;
}

function _updateRain(dt, t, w) {
    const amount = (w && w.enabled) ? (w.rain || 0) : 0;
    const under = (window.underwaterAmount || 0) > 0.5;
    if (amount < 0.01 || under) {
        if (_rain) _rain.lines.visible = false;
        return;
    }
    if (!_rain || _rain.quality !== _fxQuality()) { _disposeRain(); _buildRain(); }
    const u = _rain.uniforms;
    _rain.lines.visible = true;

    // 風で斜めに降る
    const wr = ((typeof physics.windDir === 'number') ? physics.windDir : 0) * Math.PI / 180;
    const drift = ((typeof physics.windSpeed === 'number') ? physics.windSpeed : 0) * RAIN_WIND_DRIFT;
    const vel = new THREE.Vector3(Math.sin(wr) * drift, -RAIN_FALL_SPEED, Math.cos(wr) * drift);
    _rainOffset.addScaledVector(vel, dt);
    // 箱の大きさで巻き戻して、数値が大きくならないようにする
    _rainOffset.set(_rainOffset.x % RAIN_BOX.x, _rainOffset.y % RAIN_BOX.y, _rainOffset.z % RAIN_BOX.z);
    u.uOffset.value.copy(_rainOffset);
    u.uStreakDir.value.copy(vel).normalize();
    u.uStreakLen.value = 0.45 + amount * 0.6;
    u.uAmount.value = Math.min(1, amount);
    u.uCamPos.value.copy(camera.position);
    u.uSeaLevel.value = (typeof getWaveHeight === 'function')
        ? getWaveHeight(camera.position.x, camera.position.z, t, true) - 1.0 : 0;

    // 雨粒そのものの明るさ：空からの光（半球光・環境光）＋雷の閃光
    const sky = ((typeof hemiLight !== 'undefined' && hemiLight) ? hemiLight.intensity : 0.5) * 0.12
              + ((typeof ambientLight !== 'undefined' && ambientLight) ? ambientLight.intensity : 0.3) * 0.25
              + window.lightningFlash * 0.5;
    // 夜でも雨筋がうっすら見える下限（真っ暗だと降っていることが分からないため）
    u.uBase.value.set(0.55, 0.6, 0.68).multiplyScalar(Math.min(0.6, Math.max(0.09, sky)));

    // 近くで光っている灯り（面光源の枠）に照らされる
    let n = 0;
    const lights = (typeof getAreaLightSceneLights === 'function') ? getAreaLightSceneLights() : [];
    const wp = new THREE.Vector3();
    for (const l of lights) {
        if (n >= RAIN_LIGHT_MAX) break;
        l.getWorldPosition(wp);
        if (wp.distanceToSquared(camera.position) > 90 * 90) continue;
        u.uLightPos.value[n].copy(wp);
        const k = Math.min(3, l.intensity) * 0.35;
        u.uLightCol.value[n].set(l.color.r * k, l.color.g * k, l.color.b * k);
        n++;
    }
    u.uLightCount.value = n;
}

// ── 雷 ──────────────────────────────────────────────────────────────
// 嵐の激しさ（0〜1）。雨が強く、風も強いときだけ雷が鳴る。
function _storminess(w) {
    if (!w || !w.enabled) return 0;
    const sm = (a, b, x) => { const k = Math.max(0, Math.min(1, (x - a) / (b - a))); return k * k * (3 - 2 * k); };
    return sm(0.5, 0.9, w.rain || 0) * sm(7.0, 10.0, w.beaufort || 0);
}

// 稲妻の形（ギザギザの折れ線）を中点変位法で作る
function _boltPoints(top, bottom, rough, depth, out) {
    if (depth === 0) { out.push(bottom.clone()); return; }
    const mid = top.clone().lerp(bottom, 0.5);
    const len = top.distanceTo(bottom);
    mid.x += (Math.random() - 0.5) * len * rough;
    mid.z += (Math.random() - 0.5) * len * rough;
    mid.y += (Math.random() - 0.5) * len * rough * 0.3;
    _boltPoints(top, mid, rough, depth - 1, out);
    _boltPoints(mid, bottom, rough, depth - 1, out);
}

// 折れ線を、カメラの方を向いた1本のつながった帯にする。
// 以前は線分ごとに別々の四角形を作っていたため、折れ目で四角形が重なったり
// 隙間が空いたりして、周りの薄い光が「つぎはぎ」に見えていた。ここでは
// 折れ目の頂点を前後の線分で共有し（向きは前後の平均）、帯の幅方向の位置
// (across: -1〜1) を持たせて、光の減り方をシェーダーで滑らかに付ける。
// 周りのにじみは太い帯を重ねず、明るい芯をブルームでにじませて出す。
//   taper: 終点での太さの割合（枝分かれの先は細くなる）
function _ribbon(points, width, camPos, taper, positions, across, indices) {
    const n = points.length;
    if (n < 2) return;
    const base = positions.length / 3;
    const tan = new THREE.Vector3(), d0 = new THREE.Vector3(), d1 = new THREE.Vector3();
    const side = new THREE.Vector3(), toCam = new THREE.Vector3(), p = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
        const a = points[i];
        if (i > 0) d0.subVectors(a, points[i - 1]).normalize(); else d0.set(0, 0, 0);
        if (i < n - 1) d1.subVectors(points[i + 1], a).normalize(); else d1.set(0, 0, 0);
        tan.addVectors(d0, d1);
        if (tan.lengthSq() < 1e-8) tan.copy(i > 0 ? d0 : d1);
        tan.normalize();
        toCam.subVectors(camPos, a).normalize();
        side.crossVectors(tan, toCam);
        if (side.lengthSq() < 1e-8) side.set(1, 0, 0);
        side.normalize();
        // 折れ目では帯が細らないよう少し広げる（広げすぎない）
        const segDir = (i < n - 1) ? d1 : d0;
        const sideSeg = new THREE.Vector3().crossVectors(segDir, toCam).normalize();
        const miter = 1 / Math.max(0.6, Math.abs(side.dot(sideSeg)));
        const w = width * 0.5 * miter * (1 + (taper - 1) * (i / (n - 1)));
        p.copy(a).addScaledVector(side, w);  positions.push(p.x, p.y, p.z); across.push(1);
        p.copy(a).addScaledVector(side, -w); positions.push(p.x, p.y, p.z); across.push(-1);
        if (i < n - 1) {
            const k = base + i * 2;
            indices.push(k, k + 1, k + 2, k + 2, k + 1, k + 3);
        }
    }
}

const _boltVS = `
    attribute float across;
    varying float vAcross;
    // 対数深度バッファ対応（03-particle-systems.js の泡と同じ方法）
    #ifdef USE_LOGDEPTHBUF
        uniform float logDepthBufFC;
    #endif
    void main() {
        vAcross = across;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #ifdef USE_LOGDEPTHBUF
            gl_Position.z = log2(max(1e-6, gl_Position.w + 1.0)) * logDepthBufFC - 1.0;
            gl_Position.z *= gl_Position.w;
        #endif
    }`;
const _boltFS = `
    uniform vec3 uCore;
    uniform vec3 uHalo;
    uniform float uOpacity;
    varying float vAcross;
    #ifdef USE_LOGDEPTHBUF
        uniform float logDepthBufFC;
    #endif
    void main() {
        float x = vAcross;
        // 芯：白く細く強い光（ブルームでにじむ）。周り：青白い光が滑らかに消える
        float core = exp(-x * x * 45.0);
        float halo = exp(-x * x * 4.0) * (1.0 - x * x);
        gl_FragColor = vec4((uCore * core + uHalo * halo) * uOpacity, 1.0);
    }`;

function _makeBolt(ground, cloudY) {
    const top = new THREE.Vector3(ground.x + (Math.random() - 0.5) * 120, cloudY, ground.z + (Math.random() - 0.5) * 120);
    const main = [top.clone()];
    _boltPoints(top, ground, 0.35, 6, main);
    const pos = [], acr = [], idx = [];
    const cam = camera.position;
    _ribbon(main, 16, cam, 0.8, pos, acr, idx);
    // 枝分かれ 1〜2本（先へ行くほど細い）
    const branches = 1 + (Math.random() < 0.5 ? 1 : 0);
    for (let b = 0; b < branches; b++) {
        const from = main[Math.floor(main.length * (0.2 + Math.random() * 0.4))];
        const to = from.clone().add(new THREE.Vector3((Math.random() - 0.5) * 260, -(80 + Math.random() * 180), (Math.random() - 0.5) * 260));
        const pts = [from.clone()];
        _boltPoints(from, to, 0.4, 4, pts);
        _ribbon(pts, 10, cam, 0.25, pos, acr, idx);
    }
    const group = new THREE.Group();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('across', new THREE.Float32BufferAttribute(acr, 1));
    g.setIndex(idx);
    const mat = new THREE.ShaderMaterial({
        uniforms: {
            uCore: { value: new THREE.Color(2.6, 2.7, 3.2) },
            uHalo: { value: new THREE.Color(0.22, 0.26, 0.55) },
            uOpacity: { value: 1.0 },
        },
        vertexShader: _boltVS, fragmentShader: _boltFS,
        transparent: true, depthWrite: false, fog: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.frustumCulled = false;
    group.add(mesh);
    scene.add(group);
    return { group, mat };
}

function _disposeBolt(bolt) {
    if (!bolt) return;
    scene.remove(bolt.group);
    bolt.group.traverse(o => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
}

function _startStrike(t, s) {
    // 光る場所：カメラから数百m〜1km先のどこか
    const az = Math.random() * Math.PI * 2;
    const dist = 350 + Math.random() * 850;
    const ground = new THREE.Vector3(camera.position.x + Math.sin(az) * dist, 0, camera.position.z + Math.cos(az) * dist);
    const cloudY = 380 + Math.random() * 240;
    const dir = new THREE.Vector3(ground.x - camera.position.x, cloudY * 0.6 - camera.position.y, ground.z - camera.position.z).normalize();
    // 閃光は2〜3回明滅する
    const pulses = [{ t: 0, a: 1.0 }, { t: 0.08 + Math.random() * 0.06, a: 0.55 }];
    if (Math.random() < 0.7) pulses.push({ t: 0.22 + Math.random() * 0.12, a: 0.85 });
    const bolt = (Math.random() < LIGHTNING_BOLT_CHANCE) ? _makeBolt(ground, cloudY) : null;
    _lightning.strike = { t0: t, pulses, dir, bolt, power: 0.6 + 0.4 * s };
}

function _updateLightning(t, w) {
    const s = _storminess(w);
    const L = _lightning;
    if (!L.strike && s > 0.02 && t >= L.next) {
        _startStrike(t, s);
        const span = LIGHTNING_MAX_INTERVAL - (LIGHTNING_MAX_INTERVAL - LIGHTNING_MIN_INTERVAL) * s;
        L.next = t + span * (0.5 + Math.random());
    }
    if (s <= 0.02 && t >= L.next) L.next = t + 5;

    let flash = 0;
    if (L.strike) {
        const age = t - L.strike.t0;
        for (const p of L.strike.pulses) {
            if (age >= p.t) flash += p.a * Math.exp(-(age - p.t) / 0.07);
        }
        flash *= L.strike.power;
        if (L.strike.bolt) {
            const vis = Math.min(1, flash * 1.3);
            L.strike.bolt.mat.uniforms.uOpacity.value = vis;
        }
        if (age > 0.9) { _disposeBolt(L.strike.bolt); L.strike = null; }
    }
    window.lightningFlash = flash;
    window._lightningActive = flash > 0.02;
}

// ── 毎フレーム（天候の更新の後、描画より前）──────────────────────────
function updateWeatherFx(t) {
    const dt = (_fxLastT < 0) ? 0 : Math.min(0.1, Math.max(0, t - _fxLastT));
    _fxLastT = t;
    if (typeof scene === 'undefined' || !scene || typeof camera === 'undefined' || !camera) return;
    const w = window.weather;
    _updateRain(dt, t, w);
    _updateLightning(t, w);

    // 空：どんより暗く、霧・雨で霞む。雷で光る。
    if (typeof skyMesh !== 'undefined' && skyMesh && skyMesh.material && skyMesh.material.uniforms) {
        const u = skyMesh.material.uniforms;
        const on = w && w.enabled;
        if (u.overcast) u.overcast.value = on ? Math.min(1, w.cloud * 0.65 + (w.rain || 0) * 0.5) : 0;
        if (u.fogVeil) u.fogVeil.value = on ? Math.min(0.95, (w.fog || 0) * 0.95 + (w.rain || 0) * 0.35) : 0;
        if (u.fogTintColor && scene.fog) u.fogTintColor.value.copy(scene.fog.color);
        if (u.lightningFlash) u.lightningFlash.value = window.lightningFlash * 1.4;
        if (u.lightningDir && _lightning.strike) u.lightningDir.value.copy(_lightning.strike.dir);
    }
}

// 雷の閃光ぶん、描画の直前だけ環境光を持ち上げる（描画後に restore で戻す）。
// 昼夜処理は光の強さを「今の値から目標へ少しずつ」寄せるので、書き込んだまま
// にすると閃光が尾を引いてしまうため。
function applyWeatherFxRenderOverrides() {
    _fxSaved = null;
    const f = window.lightningFlash || 0;
    if (f < 0.005) return;
    _fxSaved = { amb: ambientLight.intensity, hemi: hemiLight.intensity };
    ambientLight.intensity += f * 0.22;
    hemiLight.intensity += f * 0.4;
}
function restoreWeatherFxRenderOverrides() {
    if (!_fxSaved) return;
    ambientLight.intensity = _fxSaved.amb;
    hemiLight.intensity = _fxSaved.hemi;
    _fxSaved = null;
}
