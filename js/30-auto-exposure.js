// 30-auto-exposure.js — 見ている画面の明るさに合わせる自動露出（目の慣れ）
//
// 暗い夜の海を見ているときは露出を上げ、明るい空や灯りを見ているときは
// 下げる。人の目が明るさに慣れていくのと同じように、ゆっくり合わせる。
//
// 【明るさの測り方】画面全体をCPUに読み出すと重い（スマホで数ms〜十数ms
// 止まる）。そこで、
//   1. 描画し終えた画面を GPU 上でテクスチャへコピー（CPUは待たない）
//   2. 8×8 画素に縮めながら各画素で明るさを平均（GPU）
//   3. その 64 画素だけを読み出す（AE_INTERVAL 秒に1回）
// という手順で、読み出す量を最小にしている。
// さらに読み出しは「非同期」で行う（WebGL2）。普通の readPixels は、GPUが
// それまでに頼まれた描画を全部終えるまでCPUを止めてしまい、CPUとGPUが
// 交互にしか働けなくなる（数百msおきにカクつく原因になる）。そこで読み出しを
// バッファへ予約だけしておき、GPUが終わったこと（フェンス）を次のフレーム
// 以降で確かめてから受け取る。WebGL1 の端末では従来の読み出しを間隔を
// 空けて行う。
// 平均は「明るさの対数の平均」（幾何平均）で取り、画面の中央ほど重みを
// 大きくする。窓の灯りや太陽のような小さな明るい点に引きずられないため。
//
// 【露出の決め方】測ったのは露出を掛けた後の画面なので、目標の明るさとの
// 比から露出の倍率を少しずつ直す（フィードバック）。倍率は利用者が
// 設定した露出（照明タブの「露出」）に掛け算するので、基本の明るさは
// 今までどおり設定で決められる。

const AE_INTERVAL = 0.4;          // 明るさを測る間隔[秒]
const AE_MUL_MIN = 0.55;          // 露出倍率の下限（明るい所で絞る限度）
const AE_MUL_MAX = 2.4;           // 露出倍率の上限（暗い所で開ける限度）
const AE_TARGET_DAY = 0.40;       // 目標の画面の明るさ（0〜1、表示上の値）
const AE_TARGET_NIGHT = 0.20;     // 夜は暗めを目標にする（夜が昼のように明るくならないように）
const AE_ADAPT_DARKEN = 1 / 0.8;  // 明るい所に慣れる速さ[1/秒]（まぶしさにはすぐ慣れる）
const AE_ADAPT_BRIGHTEN = 1 / 2.5;// 暗い所に慣れる速さ[1/秒]（暗さに慣れるのはゆっくり）

const autoExposure = {
    enabled: true,
    mul: 1.0,        // 今の露出倍率
    desired: 1.0,    // 目標の露出倍率
    measured: null,  // 最後に測った画面の明るさ
    _lastSample: -1,
    _lastT: -1,
    _src: null, _srcW: 0, _srcH: 0,
    _rt: null, _scene: null, _cam: null, _buf: null,
    _pbo: null, _sync: null,   // 非同期読み出し用（WebGL2）
};
window.autoExposure = autoExposure;

function _aeSetup() {
    const A = autoExposure;
    if (A._rt) return;
    A._rt = new THREE.WebGLRenderTarget(8, 8, {
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
        format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
        depthBuffer: false, stencilBuffer: false,
    });
    A._buf = new Uint8Array(8 * 8 * 4);
    const mat = new THREE.ShaderMaterial({
        uniforms: { tSrc: { value: null } },
        vertexShader: `
            varying vec2 vUv;
            void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
        fragmentShader: `
            uniform sampler2D tSrc;
            varying vec2 vUv;
            void main() {
                // この画素が受け持つ 1/8×1/8 の範囲を 4×4 点で標本化して平均する
                vec2 base = floor(vUv * 8.0) / 8.0;
                float s = 0.0;
                for (int i = 0; i < 4; i++) {
                    for (int j = 0; j < 4; j++) {
                        vec2 uv = base + (vec2(float(i), float(j)) + 0.5) / 32.0;
                        vec3 c = texture2D(tSrc, uv).rgb;
                        s += dot(c, vec3(0.2126, 0.7152, 0.0722));
                    }
                }
                gl_FragColor = vec4(vec3(s / 16.0), 1.0);
            }`,
        depthTest: false, depthWrite: false,
    });
    A._mat = mat;
    A._scene = new THREE.Scene();
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    quad.frustumCulled = false;
    A._scene.add(quad);
    A._cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
}

// 画面の大きさに合わせて、コピー先のテクスチャを用意する
function _aeEnsureSource(w, h) {
    const A = autoExposure;
    if (A._src && A._srcW === w && A._srcH === h) return;
    if (A._src) A._src.dispose();
    // 既定のフレームバッファは RGB（アルファ無し）のことがあるので RGB で受ける
    A._src = new THREE.DataTexture(new Uint8Array(w * h * 3), w, h, THREE.RGBFormat);
    A._src.minFilter = THREE.LinearFilter;
    A._src.magFilter = THREE.LinearFilter;
    A._src.generateMipmaps = false;
    A._src.needsUpdate = true;
    A._srcW = w; A._srcH = h;
}

// 描画の直前に呼ぶ：露出を目標へ少しずつ寄せて、レンダラーに反映する
function applyAutoExposure(t) {
    const A = autoExposure;
    const dt = (A._lastT < 0) ? 0 : Math.min(0.1, Math.max(0, t - A._lastT));
    A._lastT = t;
    const base = (typeof lightSettings !== 'undefined' && Number.isFinite(lightSettings.exposure)) ? lightSettings.exposure : 1.0;
    if (!A.enabled) { A.mul = 1; renderer.toneMappingExposure = base; return; }
    const rate = (A.desired < A.mul) ? AE_ADAPT_DARKEN : AE_ADAPT_BRIGHTEN;
    // 対数の上で寄せる（2倍→1倍と0.5倍→1倍が同じ速さに感じられるように）
    const lm = Math.log(A.mul), ld = Math.log(A.desired);
    A.mul = Math.exp(lm + (ld - lm) * (1 - Math.exp(-rate * dt)));
    renderer.toneMappingExposure = base * A.mul;
}

// 64画素の明るさから、目標の露出倍率を決め直す
function _aeConsume(buf) {
    const A = autoExposure;
    // 中央重視の幾何平均
    let sw = 0, sl = 0;
    for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
            const l = buf[(y * 8 + x) * 4] / 255;
            const dx = x - 3.5, dy = y - 3.5;
            const wgt = Math.exp(-(dx * dx + dy * dy) / (2 * 2.6 * 2.6));
            sl += wgt * Math.log(l + 0.02);
            sw += wgt;
        }
    }
    const meas = Math.exp(sl / sw) - 0.02;
    A.measured = meas;
    // 夜は暗めを目標に（窓の発光を自動点灯させる昼夜係数と同じもの）
    const night = (typeof lightingNightFactor === 'number') ? lightingNightFactor : 0;
    const target = AE_TARGET_DAY + (AE_TARGET_NIGHT - AE_TARGET_DAY) * night;
    // 表示上の明るさは露出の 1/2.2 乗くらいで効くので、比を 1.5 乗して直す。
    // 1回で直しすぎないよう、1回あたりの修正は 0.6〜1.7 倍に抑える。
    const ratio = Math.min(1.7, Math.max(0.6, Math.pow(target / Math.max(0.01, meas), 1.5)));
    A.desired = Math.min(AE_MUL_MAX, Math.max(AE_MUL_MIN, A.mul * ratio));
}

// 予約しておいた非同期読み出しが終わっていれば受け取る（WebGL2）
function _aePollAsync() {
    const A = autoExposure;
    if (!A._sync) return;
    const gl = renderer.getContext();
    const st = gl.clientWaitSync(A._sync, 0, 0);
    if (st === gl.TIMEOUT_EXPIRED) return;          // まだGPUが終わっていない
    gl.deleteSync(A._sync);
    A._sync = null;
    if (st === gl.WAIT_FAILED) return;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, A._pbo);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, A._buf);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    _aeConsume(A._buf);
}

// 描画の直後に呼ぶ：ときどき画面の明るさを測って、目標の露出倍率を決め直す
function sampleAutoExposure(t) {
    const A = autoExposure;
    if (!A.enabled || typeof renderer === 'undefined' || !renderer) return;
    const isGL2 = renderer.capabilities && renderer.capabilities.isWebGL2;
    if (isGL2) _aePollAsync();
    if (A._sync) return;   // 前回の読み出しを待っている間は次を頼まない
    const interval = isGL2 ? AE_INTERVAL : AE_INTERVAL * 4;   // WebGL1 は同期読み出しなので間隔を空ける
    if (t - A._lastSample < interval && A._lastSample >= 0) return;
    A._lastSample = t;
    try {
        _aeSetup();
        const size = renderer.getDrawingBufferSize(new THREE.Vector2());
        const w = Math.max(1, Math.floor(size.x)), h = Math.max(1, Math.floor(size.y));
        _aeEnsureSource(w, h);
        // 今の画面（既定のフレームバッファ）をテクスチャへコピー（GPUの中だけで済む）
        renderer.setRenderTarget(null);
        renderer.copyFramebufferToTexture(new THREE.Vector2(0, 0), A._src);
        // 8×8 に縮める
        A._mat.uniforms.tSrc.value = A._src;
        const prevAutoClear = renderer.autoClear;
        renderer.autoClear = true;
        renderer.setRenderTarget(A._rt);
        renderer.render(A._scene, A._cam);
        if (isGL2) {
            // 8×8 を読み出し用バッファへ「予約」するだけ（CPUは待たない）
            const gl = renderer.getContext();
            if (!A._pbo) {
                A._pbo = gl.createBuffer();
                gl.bindBuffer(gl.PIXEL_PACK_BUFFER, A._pbo);
                gl.bufferData(gl.PIXEL_PACK_BUFFER, 8 * 8 * 4, gl.STREAM_READ);
            } else {
                gl.bindBuffer(gl.PIXEL_PACK_BUFFER, A._pbo);
            }
            gl.readPixels(0, 0, 8, 8, gl.RGBA, gl.UNSIGNED_BYTE, 0);
            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
            A._sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
            gl.flush();
        } else {
            renderer.readRenderTargetPixels(A._rt, 0, 0, 8, 8, A._buf);
            _aeConsume(A._buf);
        }
        renderer.setRenderTarget(null);
        renderer.autoClear = prevAutoClear;
    } catch (e) {
        // この環境でフレームバッファのコピーができない場合は自動露出を止める
        console.warn('[AutoExposure] 無効化しました:', e);
        A.enabled = false;
        A.mul = 1;
    }
}

function setAutoExposureEnabled(on) {
    autoExposure.enabled = !!on;
    if (!on) { autoExposure.mul = 1; autoExposure.desired = 1; }
    if (typeof lightSettings !== 'undefined') lightSettings.autoExposure = !!on;
}
