// ════════════════════════════════════════════════════════════════
//  船の「空の見え方」（環境光の遮られ方：アンビエント・オクルージョン）の焼き込み
// ════════════════════════════════════════════════════════════════
//  空や海からの柔らかい光（半球光・環境光・窓明かりの光のプローブ）は、three.js では向きだけで決まり、
//  上に甲板がかぶさっている所（プロムナードの内側の壁・ボート甲板の下・煙突の根元のすき間など）も、
//  吹きさらしの舷側と同じ明るさで照らしていた。そのため、プロムナードの内側と舷側の明るさの差が小さかった。
//  そこで、船の形の升目（60-ship-solid.js）を使って、船の表面のすぐ外の升目ごとに、いろいろな向きへ
//  まっすぐ見通して空・海が見える割合を、6 つの向き（上下・左右・前後の半球）ごとに求めておき、
//  頂点ごとにその面の向きで混ぜた値（0〜1）を頂点に持たせる。船のマテリアルでは、柔らかい光（間接光）
//  にその値を掛ける。太陽の直接の光は今まで通り影の地図で、焼き込んだ照明（40-light-bake.js）はそのまま。
//  計算は少しずつ（1 フレームに 6ms ほど）。船のモデル・形が変わったら（升目を作り直したら）やり直す。

//  ※ 焼き込みは今は使わない（strength 0・計算もしない）：升目が粗いので、影でない所が暗くなったり、
//    面の細かい煙突などにまだらに付いて汚れのように見えていた。代わりに、太陽の影そのものを濃く・細かくした
//    （下の _aoContrastUpdate と、17-main-loop.js の updateSunShadowFollow）
const shipAO = { grid: null, field: null, job: null, meshesDone: new WeakMap(), strength: 0, contrast: 1, checkT: 0, bake: false };
window.shipAO = shipAO;
// 見通す向き（球の上にほぼ均等に 40 本）
const _AO_DIRS = (() => {
    const n = 40, out = [], ga = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < n; i++) { const y = 1 - (i + 0.5) / n * 2, r = Math.sqrt(1 - y * y), a = i * ga; out.push([Math.cos(a) * r, y, Math.sin(a) * r]); }
    return out;
})();
const _AO_AXES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

// 表面のすぐ外（2 升目以内）の空気の升目ごとに、6 つの半球の見える割合（0〜255）
function* _aoField(G) {
    const { data, nx, ny, nz } = G, N = nx * ny * nz;
    // 船の升目を 2 升目ずつ太らせ（x・y・z の順に）、太らせた所のうち空気の升目が「表面のすぐ外」
    const A = new Uint8Array(data), B = new Uint8Array(N);
    const dil = (src, dst, step, len, pos) => {
        for (let idx = 0; idx < N; idx++) {
            const c = pos(idx);
            let v = 0;
            for (let o = -2; o <= 2 && !v; o++) { const q = c + o; if (q >= 0 && q < len && src[idx + o * step]) v = 1; }
            dst[idx] = v;
        }
    };
    dil(A, B, 1, nx, (idx) => idx % nx); yield;
    dil(B, A, nx, ny, (idx) => ((idx / nx) | 0) % ny); yield;
    dil(A, B, nx * ny, nz, (idx) => (idx / (nx * ny)) | 0); yield;
    const near = new Map();             // 升目の番号 → 何番目の値
    for (let idx = 0; idx < N; idx++) if (B[idx] && !data[idx]) near.set(idx, near.size);
    yield;
    const vals = new Uint8Array(near.size * 6);
    const maxSteps = Math.min(90, Math.ceil(25 / Math.max(1e-6, G.vWorld || G.v)));     // 25m ほど先まで見る
    const W = _AO_AXES.map(ax => _AO_DIRS.map(d => Math.max(0, d[0] * ax[0] + d[1] * ax[1] + d[2] * ax[2])));
    const wsum = W.map(w => w.reduce((a, b) => a + b, 0));
    const sz = nx * ny;
    let done = 0;
    for (const [idx, slot] of near) {
        const i0 = idx % nx, j0 = ((idx / nx) | 0) % ny, k0 = (idx / sz) | 0;
        const vis = new Float32Array(_AO_DIRS.length);
        for (let d = 0; d < _AO_DIRS.length; d++) {
            const D = _AO_DIRS[d];
            let x = i0 + 0.5, y = j0 + 0.5, z = k0 + 0.5, ok = 1;
            for (let s = 0; s < maxSteps; s++) {
                x += D[0] * 0.8; y += D[1] * 0.8; z += D[2] * 0.8;
                const i = x | 0, j = y | 0, k = z | 0;
                if (x < 0 || y < 0 || z < 0 || i >= nx || j >= ny || k >= nz) break;
                if (data[(k * ny + j) * nx + i]) { ok = 0; break; }
            }
            vis[d] = ok;
        }
        for (let a = 0; a < 6; a++) {
            let v = 0; const w = W[a];
            for (let d = 0; d < vis.length; d++) v += w[d] * vis[d];
            vals[slot * 6 + a] = Math.round(255 * v / wsum[a]);
        }
        if (++done % 1500 === 0) yield;
    }
    return { near, vals };
}
// 頂点ごとの値（面の向きで 6 つを混ぜる）
function* _aoMeshes(G, F, list, root) {
    const inv = new THREE.Matrix4().copy((root || shipGroup).matrixWorld).invert(), M = new THREE.Matrix4(), NM = new THREE.Matrix3();
    const p = new THREE.Vector3(), n = new THREE.Vector3();
    // その点のまわりの 8 つの升目の値を、距離で混ぜる（1 つの升目だけ拾うと、升目の境でまだらになる）
    //  戻り値：0〜1（混ぜられる升目が少なければ -1、升目の外は -2）
    const look = (x, y, z, nx, ny, nz) => {
        const fx = (x - G.lo.x) / G.v - 0.5, fy = (y - G.lo.y) / G.v - 0.5, fz = (z - G.lo.z) / G.v - 0.5;
        const i0 = Math.floor(fx), j0 = Math.floor(fy), k0 = Math.floor(fz);
        if (i0 < -1 || j0 < -1 || k0 < -1 || i0 >= G.nx || j0 >= G.ny || k0 >= G.nz) return -2;     // 升目の外：よく見える
        const tx = fx - i0, ty = fy - j0, tz = fz - k0;
        const wx = nx * nx, wy = ny * ny, wz = nz * nz, ax = nx >= 0 ? 0 : 1, ay = ny >= 0 ? 2 : 3, az = nz >= 0 ? 4 : 5;
        let sum = 0, wsum = 0;
        for (let c = 0; c < 8; c++) {
            const i = i0 + (c & 1), j = j0 + ((c >> 1) & 1), k = k0 + ((c >> 2) & 1);
            if (i < 0 || j < 0 || k < 0 || i >= G.nx || j >= G.ny || k >= G.nz) continue;
            const sl = F.near.get((k * G.ny + j) * G.nx + i);
            if (sl === undefined) continue;
            const w = ((c & 1) ? tx : 1 - tx) * (((c >> 1) & 1) ? ty : 1 - ty) * (((c >> 2) & 1) ? tz : 1 - tz) + 1e-4;
            const b = sl * 6;
            sum += w * (wx * F.vals[b + ax] + wy * F.vals[b + ay] + wz * F.vals[b + az]) / 255;
            wsum += w;
        }
        return wsum > 0.12 ? sum / wsum : -1;
    };
    const geoUsers = new Map();
    for (const m of list) geoUsers.set(m.geometry, (geoUsers.get(m.geometry) || 0) + 1);
    for (const m of list) {
        if (geoUsers.get(m.geometry) > 1) {
            // 同じ形を何か所かで使っている（救命ボートなど）：場所ごとに値が違うので、形を分ける（小さい物だけ）
            if (m.geometry.attributes.position.count > 30000) continue;
            geoUsers.set(m.geometry, geoUsers.get(m.geometry) - 1);
            m.geometry = m.geometry.clone();
        }
        const g = m.geometry, P = g.attributes.position, Nn = g.attributes.normal;
        if (!Nn) continue;
        M.multiplyMatrices(inv, m.matrixWorld); NM.getNormalMatrix(M);
        const out = new Float32Array(P.count);
        for (let i = 0; i < P.count; i++) {
            p.fromBufferAttribute(P, i).applyMatrix4(M);
            n.fromBufferAttribute(Nn, i).applyMatrix3(NM).normalize();
            let v = -1;
            for (const off of [1.2, 2.0, 2.8]) { v = look(p.x + n.x * G.v * off, p.y + n.y * G.v * off, p.z + n.z * G.v * off, n.x, n.y, n.z); if (v !== -1) break; }
            if (v === -1) for (const off of [-0.6, -1.4]) { v = look(p.x + n.x * G.v * off, p.y + n.y * G.v * off, p.z + n.z * G.v * off, n.x, n.y, n.z); if (v !== -1) break; }
            out[i] = v < 0 ? 1 : v;
            if (i % 40000 === 39999) yield;
        }
        g.setAttribute('aSky', new THREE.BufferAttribute(out, 1));
        shipAO.meshesDone.set(m, g);
        (Array.isArray(m.material) ? m.material : [m.material]).forEach(_aoPatchMaterial);
        yield;
    }
}
const shipAOUniforms = { uAOStrength: { value: 0 }, uAODebug: { value: 0 }, uIndirK: { value: 1 }, uDirectK: { value: 1 },
    // 空の遮られ方（下の skyOcc：上から見た船の奥行きの地図）
    uSkyOccMap: { value: null }, uSkyOccMat: { value: new THREE.Matrix4() }, uSkyOccOn: { value: 0 }, uSkyOccR: { value: new THREE.Vector2(0.001, 0.001) },
    uSkyOccBias: { value: 0.002 }, uSkyOccMin: { value: 0.35 }, uSkyOccOff: { value: 1 } };    // uAODebug=1：空の見え方を白黒で表示（調整用）
// 空の遮られ方を調べる（地図の 8 点：やわらかい縁）。上に何かある所は 0、空が見える所は 1
// ・面の向きは、カメラから見えている側を外とする（厚さの無い一枚の面の、プロムナードの内側から見た面・内向きの法線の部品でも正しく）
// ・地図を引く前後左右の位置は面の外へ少し出した所、比べる高さは面そのものの高さ（出しすぎて薄い天井を突き抜けて、
//   天井のすぐ下の角が明るく残っていた）
// ・下を向いた面は空が見えない
// 面の位置と向きは、three.js がもともと画素へ渡している値（カメラから見た位置 vViewPosition と面の向き normal）から
// 世界の座標へ直して使う。以前は世界の位置と向きを自前の値（varying）として 2 つ余分に渡していたが、Adreno の GPU
// （Xperia 5 III で確認）では、それと太陽の影が同じシェーダーに入ると、船の白い所などが真っ青・真っ黒になった
// （GPU のドライバーの不具合。実機の検査で、余分に渡した値を画素で読むと壊れ、読まなければ直ると分かった）
const _SKY_OCC_GLSL = `
uniform sampler2D uSkyOccMap; uniform float uSkyOccOn, uSkyOccBias, uSkyOccMin, uSkyOccOff; uniform vec2 uSkyOccR;
uniform mat4 uSkyOccMat;
float skyOccTap(vec3 c, vec2 o) { return step(c.z - uSkyOccBias, texture2D(uSkyOccMap, c.xy + o * uSkyOccR).r); }
float skyOccVis(vec3 nV, vec3 pV) {
    vec3 n = normalize((vec4(nV, 0.0) * viewMatrix).xyz);
    vec3 sP = cameraPosition + (vec4(pV, 0.0) * viewMatrix).xyz;
    if (dot(n, cameraPosition - sP) < 0.0) n = -n;
    vec4 cp = uSkyOccMat * vec4(sP, 1.0);
    vec4 cq = uSkyOccMat * vec4(sP + n * uSkyOccOff, 1.0);
    vec3 c = vec3(cq.xy / cq.w, cp.z / cp.w) * 0.5 + 0.5;
    if (c.x <= 0.0 || c.x >= 1.0 || c.y <= 0.0 || c.y >= 1.0 || c.z >= 1.0 || c.z <= 0.0) return 1.0;
    float v = skyOccTap(c, vec2(0.0)) * 2.0 + skyOccTap(c, vec2(1.0, 0.0)) + skyOccTap(c, vec2(-1.0, 0.0)) + skyOccTap(c, vec2(0.0, 1.0)) + skyOccTap(c, vec2(0.0, -1.0))
            + skyOccTap(c, vec2(0.7, 0.7)) + skyOccTap(c, vec2(-0.7, 0.7)) + skyOccTap(c, vec2(0.7, -0.7)) + skyOccTap(c, vec2(-0.7, -0.7));
    return v / 10.0 * smoothstep(-0.9, -0.2, n.y);
}
`;
// 船のシェーダーで画素へ渡す小さな値（float の varying）を、1 つの vec4 にまとめる。
// Adreno の GPU（Xperia 5 III で確認）では、船のシェーダーの varying が 9 個を超えると色が壊れた。
// float 1 つも vec4 と同じ 1 個に数えられる（実機の検査：ふだんの 9 個に float を 1 つ足すと青、vec4 1 つで黒、
// vec4 の配列 2 つで赤紫。焼き込みの計算中の灯りの影 3 つで赤、以前の空の遮られ方の 2 つで青）。
// three.js の霧の深さ（fogDepth）・対数の奥行き（vFragDepth・vIsPerspective）と、空の見え方（vSkyAO）を 1 つにまとめて 3 個減らす。
// 名前は #define で置き換えるので、three.js の部品（fog_vertex など）はそのまま動く
const _SHIP_PK_DEF = '#define vSkyAO vShipPk.x\n#define fogDepth vShipPk.y\n#define vFragDepth vShipPk.z\n#define vIsPerspective vShipPk.w\nvarying vec4 vShipPk;\n';
function _shipPackVaryings(src, frag) {
    for (const name of frag ? ['fog_pars_fragment', 'logdepthbuf_pars_fragment'] : ['fog_pars_vertex', 'logdepthbuf_pars_vertex']) {
        const chunk = THREE.ShaderChunk[name];
        if (chunk) src = src.replace(`#include <${name}>`, chunk.replace(/varying\s+float\s+(fogDepth|vFragDepth|vIsPerspective)\s*;/g, ''));
    }
    return src;
}
// シェーダーにまとめる仕掛けを入れる（2 度入れない）
function _shipPackShader(shader) {
    if (shader.vertexShader.indexOf('varying vec4 vShipPk;') >= 0) return;
    shader.vertexShader = _shipPackVaryings(shader.vertexShader.replace('#include <common>', '#include <common>\n' + _SHIP_PK_DEF), false);
    shader.fragmentShader = _shipPackVaryings(shader.fragmentShader.replace('#include <common>', '#include <common>\n' + _SHIP_PK_DEF), true);
}
// 船の陰影の仕掛けを付けない部品（透ける物・スクリューなど：60-ship-solid.js の _ssMeshes に入らない物）にも、まとめる仕掛けだけ付ける
function _shipPackPatch(mat) {
    if (!mat || mat.userData.aoPatched || mat.userData.pkPatched) return;
    if (!(mat.isMeshStandardMaterial || mat.isMeshPhongMaterial || mat.isMeshLambertMaterial)) return;
    mat.userData.pkPatched = true;
    const prev = mat.onBeforeCompile, prevKey = mat.customProgramCacheKey;
    mat.onBeforeCompile = function (shader, r) {
        if (typeof prev === 'function') prev.call(this, shader, r);
        _shipPackShader(shader);
    };
    mat.customProgramCacheKey = function () { return 'shipPk|' + ((typeof prevKey === 'function') ? prevKey.call(this) : ''); };
    mat.needsUpdate = true;
}
// opts.skyOcc：自分の船のマテリアルだけ（他の船は、自分の船の地図を使えないので付けない：59-traffic.js）
function _aoPatchMaterial(mat, opts) {
    if (!mat || mat.userData.aoPatched) return;
    if (!(mat.isMeshStandardMaterial || mat.isMeshPhongMaterial || mat.isMeshLambertMaterial)) return;
    mat.userData.aoPatched = true;
    mat.userData.skyOcc = !(opts && opts.skyOcc === false);
    const prev = mat.onBeforeCompile, prevKey = mat.customProgramCacheKey;
    mat.onBeforeCompile = function (shader, r) {
        if (typeof prev === 'function') prev.call(this, shader, r);
        // 表示の不具合の切り分け（01-state-and-config.js）：pad＝ダミーの値を一つ足して、シェーダーの値の並びを変える
        if (window.gpuDbg === 'pad') {
            shader.uniforms.uGpuPad = { value: new THREE.Vector4(0, 0, 0, 0) };
            shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform vec4 uGpuPad;')
                .replace(/\}\s*$/, '    if (uGpuPad.w > 1.0e9) gl_FragColor = vec4(uGpuPad.rgb, 1.0);\n}\n');
        }
        if (window.gpuDbg === 'ao' || window.gpuDbg === 'allpatch') return;   // 船の陰影の仕掛けを止める
        // （面の位置・向きを three.js の vViewPosition・normal から求めるので、それがある標準・Phong の材質だけ）
        const occ = mat.userData.skyOcc && window.gpuDbg !== 'skyocc' && (mat.isMeshStandardMaterial || mat.isMeshPhongMaterial);
        shader.uniforms.uAOStrength = shipAOUniforms.uAOStrength; shader.uniforms.uAODebug = shipAOUniforms.uAODebug;
        shader.uniforms.uIndirK = shipAOUniforms.uIndirK; shader.uniforms.uDirectK = shipAOUniforms.uDirectK;
        if (occ) for (const k of ['uSkyOccMap', 'uSkyOccMat', 'uSkyOccOn', 'uSkyOccR', 'uSkyOccBias', 'uSkyOccMin', 'uSkyOccOff']) shader.uniforms[k] = shipAOUniforms[k];
        _shipPackShader(shader);   // vSkyAO もまとめた値の 1 つ
        shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nattribute float aSky;\n')
            .replace(/\}\s*$/, '    vSkyAO = aSky;\n}\n');
        // 間接光（半球光・環境光・光のプローブ・環境マップ）に掛ける。少し強めに効くよう曲げる
        const occF = occ ? '      if (uSkyOccOn > 0.5) { float so = mix(uSkyOccMin, 1.0, skyOccVis(normal, -vViewPosition)); reflectedLight.indirectDiffuse *= so; reflectedLight.indirectSpecular *= mix(1.0, so, 0.6); }\n' : '';
        shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uAOStrength;\nuniform float uAODebug;\nuniform float uIndirK;\nuniform float uDirectK;\n' + (occ ? _SKY_OCC_GLSL : ''))
            .replace('#include <aomap_fragment>', '#include <aomap_fragment>\n    { float sk = mix(1.0, pow(clamp(vSkyAO * 1.15, 0.0, 1.0), 1.4), uAOStrength);\n      reflectedLight.indirectDiffuse *= sk * uIndirK; reflectedLight.indirectSpecular *= mix(1.0, sk, 0.7) * uIndirK;\n' + occF + '      reflectedLight.directDiffuse *= uDirectK; }\n')
            .replace(/\}\s*$/, '    if (uAODebug > 0.5) gl_FragColor = vec4(vec3(vSkyAO), 1.0);\n}\n');
    };
    mat.customProgramCacheKey = function () { return 'skyAOpk' + (mat.userData.skyOcc ? 'o2' : '') + (typeof gpuDbgKey === 'function' ? gpuDbgKey() : '') + '|' + ((typeof prevKey === 'function') ? prevKey.call(this) : ''); };
    mat.defaultAttributeValues = Object.assign({}, mat.defaultAttributeValues || {}, { aSky: [1] });
    mat.needsUpdate = true;
}
// 日なたと日陰のくっきりさ：晴れた昼は、船の間接光（空・海からの柔らかい光）を弱め、太陽の直接光を少し強める
//（全体の明るさはあまり変えずに、甲板の上の影・プロムナードの奥などを暗く）。曇り・夜は今まで通り
function _aoContrastUpdate() {
    const night = typeof lightingNightFactor === 'number' ? lightingNightFactor : 0;
    const sun = (window.weatherLightMul && Number.isFinite(weatherLightMul.sun)) ? Math.min(1, weatherLightMul.sun) : 1;
    const k = Math.max(0, Math.min(1, (1 - night * 1.5) * sun)) * shipAO.contrast;
    // （晴れた昼の日陰は、間接光を 7.5 割減らして濃く。日なたは太陽の光を強めて、全体の明るさを保つ。
    //  以前は 6 割・1.18 倍で、白い上部構造の日陰が日なたの 7 割の明るさまでしか落ちず、写真のような陰影が出なかった）
    shipAOUniforms.uIndirK.value = 1 - 0.75 * k;
    shipAOUniforms.uDirectK.value = 1 + 0.3 * k;
}
// ── 空の遮られ方：船を真上から見た奥行きの地図（船の中の座標で 1 度だけ描く。船が動いても描き直さない）──
//  空からの柔らかい光は、ほとんど上から来る。上に甲板・ボート・屋根がかぶさっている所（プロムナードの奥の壁・
//  張り出しの下の甲板・ボート甲板の下）は空が見えないので、間接光を弱めて暗くする（写真のようなくっきりした陰影）。
//  吹きさらしの舷側・煙突の横は、面の外へ少し出した所で地図を引くので空が見える。
//  地図は船の中の座標（shipGroup）に置いたカメラで描くので、船が動いても・揺れても同じ。モデル・縮尺が変わったときだけ描き直す
const SKY_OCC_LAYER = 9;
const skyOcc = { rt: null, key: '', A: new THREE.Matrix4(), cam: null, mat: null, tmp: new THREE.Matrix4(), ok: false };
function _skyOccKey() {
    if (typeof importedModelGroup === 'undefined' || !importedModelGroup || typeof shipGroup === 'undefined' || !shipGroup) return '';
    let n = 0, v = 0; importedModelGroup.traverse(o => { if (o.isMesh && o.visible && o.geometry && o.geometry.attributes.position) { n++; v += o.geometry.attributes.position.count; } });
    const mo = typeof modelOffset !== 'undefined' && modelOffset ? [modelOffset.x, modelOffset.y, modelOffset.z, modelOffset.ry, modelOffset.scale].join(',') : '';
    return importedModelGroup.uuid + ':' + n + ':' + v + ':' + (physics.scale || 1).toFixed(3) + ':' + mo;
}
function _skyOccBuild() {
    shipAOUniforms.uSkyOccOn.value = 0;
    if (typeof renderer === 'undefined' || !renderer || typeof scene === 'undefined') return;
    if (!renderer.capabilities.isWebGL2 && !renderer.extensions.get('WEBGL_depth_texture')) return;
    const list = typeof _ssMeshes === 'function' ? _ssMeshes() : [];
    if (!list.length) return;
    shipGroup.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(shipGroup.matrixWorld).invert(), M = new THREE.Matrix4();
    const box = new THREE.Box3(), b = new THREE.Box3();
    for (const o of list) {
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        b.copy(o.geometry.boundingBox).applyMatrix4(M.multiplyMatrices(inv, o.matrixWorld)); box.union(b);
        o.layers.enable(SKY_OCC_LAYER);
    }
    if (box.isEmpty()) return;
    const sc = physics.scale || 1, pad = 2 / sc;
    const hx = (box.max.x - box.min.x) / 2 + pad, hz = (box.max.z - box.min.z) / 2 + pad, cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
    const top = box.max.y + pad, depth = box.max.y - box.min.y + 2 * pad;
    // 地図の大きさ：前後 2048（スマホ 1024）、左右は船の幅の割合で
    const maxT = Math.min(renderer.capabilities.maxTextureSize || 2048, (typeof _texIsMobile === 'function' && _texIsMobile()) ? 1024 : 2048);
    const H = maxT, W = Math.max(64, Math.min(maxT, Math.round(maxT * hx / hz)));
    if (!skyOcc.rt || skyOcc.rt.width !== W || skyOcc.rt.height !== H) {
        if (skyOcc.rt) { skyOcc.rt.depthTexture.dispose(); skyOcc.rt.dispose(); }
        const rt = new THREE.WebGLRenderTarget(W, H, { depthBuffer: true });
        rt.depthTexture = new THREE.DepthTexture(W, H);
        rt.depthTexture.format = THREE.DepthFormat;
        rt.depthTexture.type = renderer.capabilities.isWebGL2 ? THREE.UnsignedIntType : THREE.UnsignedShortType;
        rt.depthTexture.minFilter = THREE.NearestFilter; rt.depthTexture.magFilter = THREE.NearestFilter;
        skyOcc.rt = rt;
    }
    // 船の中の座標のカメラ：真上（船の上向き）から下を見る。画面の上が船首
    const L = new THREE.Matrix4().lookAt(new THREE.Vector3(cx, top, cz), new THREE.Vector3(cx, top - 1, cz), new THREE.Vector3(0, 0, 1));
    L.setPosition(cx, top, cz);
    if (!skyOcc.cam) { skyOcc.cam = new THREE.OrthographicCamera(); skyOcc.cam.matrixAutoUpdate = false; }
    const cam = skyOcc.cam;
    Object.assign(cam, { left: -hx, right: hx, top: hz, bottom: -hz, near: 0.0001, far: depth });
    cam.updateProjectionMatrix();
    cam.layers.set(SKY_OCC_LAYER);
    cam.matrix.multiplyMatrices(shipGroup.matrixWorld, L);
    cam.updateMatrixWorld(true);
    if (!skyOcc.mat) skyOcc.mat = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });
    const prevTarget = renderer.getRenderTarget(), prevOverride = scene.overrideMaterial, prevBg = scene.background;
    const prevShadow = renderer.shadowMap.autoUpdate, prevNeeds = renderer.shadowMap.needsUpdate;
    scene.overrideMaterial = skyOcc.mat; scene.background = null;
    renderer.shadowMap.autoUpdate = false; renderer.shadowMap.needsUpdate = false;
    renderer.setRenderTarget(skyOcc.rt);
    renderer.clear(true, true, false);
    renderer.render(scene, cam);
    renderer.setRenderTarget(prevTarget);
    scene.overrideMaterial = prevOverride; scene.background = prevBg;
    renderer.shadowMap.autoUpdate = prevShadow; renderer.shadowMap.needsUpdate = prevNeeds;
    // 船の中の座標 → 地図（クリップ座標）
    skyOcc.A.multiplyMatrices(cam.projectionMatrix, new THREE.Matrix4().copy(L).invert());
    const U = shipAOUniforms, Lm = (box.max.z - box.min.z) * sc;
    U.uSkyOccMap.value = skyOcc.rt.depthTexture;
    // やわらかい縁の幅 0.25m・奥行きの余裕 0.2m・面の外へ出す長さ（船の長さの 0.2％、0.25〜0.6m）
    U.uSkyOccR.value.set(0.25 / sc / (2 * hx), 0.25 / sc / (2 * hz));
    U.uSkyOccBias.value = 0.2 / sc / depth;
    U.uSkyOccOff.value = Math.max(0.25, Math.min(0.6, Lm * 0.002));
    skyOcc.ok = true;
    U.uSkyOccOn.value = 1;
    skyOccFollow();
}
// 毎フレーム（17-main-loop.js：船の位置・向きが決まった直後）：世界 → 船の中の座標 → 地図
function skyOccFollow() {
    if (!skyOcc.ok || typeof shipGroup === 'undefined' || !shipGroup) return;
    const m = skyOcc.tmp.compose(shipGroup.position, shipGroup.quaternion, shipGroup.scale);
    if (shipGroup.parent && shipGroup.parent !== scene) m.premultiply(shipGroup.parent.matrixWorld);
    shipAOUniforms.uSkyOccMat.value.multiplyMatrices(skyOcc.A, m.invert());
}
window.skyOccFollow = skyOccFollow;
function shipShadowContrast(v) { shipAO.contrast = Math.max(0, Math.min(1.5, v)); }
window.shipShadowContrast = shipShadowContrast;
function updateShipAO() {
    _aoContrastUpdate();
    if (!shipAO.bake) {
        // 焼き込みはしない：日なたと日陰のくっきりさだけ、船のマテリアルに入れる（2 秒ごとに、新しいマテリアルへ）
        const now = performance.now();
        if (now - shipAO.checkT < 2000) return;
        shipAO.checkT = now;
        for (const m of (typeof _ssMeshes === 'function' ? _ssMeshes() : [])) (Array.isArray(m.material) ? m.material : [m.material]).forEach(x => _aoPatchMaterial(x));
        // それ以外の船の部品には、varying をまとめる仕掛けだけ
        if (typeof shipGroup !== 'undefined' && shipGroup) shipGroup.traverse(o => { if (o.isMesh) (Array.isArray(o.material) ? o.material : [o.material]).forEach(x => _shipPackPatch(x)); });
        // 空の遮られ方の地図：モデル・縮尺が変わったら描き直す（船の形の升目ができてから＝モデルの読み込みが落ち着いてから）
        if (window.shipSolid && shipSolid.G) { const key = _skyOccKey(); if (key && key !== skyOcc.key) { skyOcc.key = key; try { _skyOccBuild(); } catch (e) { console.warn('空の遮られ方の地図を作れませんでした', e); shipAOUniforms.uSkyOccOn.value = 0; } } }
        return;
    }
    const G = window.shipSolid && shipSolid.G;
    if (!G || typeof shipGroup === 'undefined' || !shipGroup) return;
    if (shipAO.job) {
        const t0 = performance.now();
        while (performance.now() - t0 < 6) {
            const r = shipAO.job.next();
            if (r.done) { shipAO.job = null; break; }
        }
        return;
    }
    if (shipAO.grid !== G) {
        // 升目が新しくなった：見える割合から計算し直す
        shipAO.grid = G; shipAO.field = null;
        shipAO.job = (function* () {
            G.vWorld = G.v * shipGroup.matrixWorld.getMaxScaleOnAxis();
            shipAO.field = yield* _aoField(G);
            shipAO.meshesDone = new WeakMap();
        })();
        return;
    }
    if (!shipAO.field) return;
    // まだ値を付けていない船の形（焼き込みで三角形を分けたときも、形が新しくなる）
    const now = performance.now();
    if (now - shipAO.checkT < 2000) return;
    shipAO.checkT = now;
    const all = (typeof _ssMeshes === 'function' ? _ssMeshes() : []);
    // 値は付いているが、マテリアルが後から差し替わった（焼き込みなど）：マテリアルだけ直す
    for (const m of all) if (shipAO.meshesDone.get(m) === m.geometry) (Array.isArray(m.material) ? m.material : [m.material]).forEach(_aoPatchMaterial);
    const list = all.filter(m => shipAO.meshesDone.get(m) !== m.geometry);
    if (list.length) shipAO.job = _aoMeshes(G, shipAO.field, list);
}
window.updateShipAO = updateShipAO;
function shipAOSetStrength(v) { shipAO.strength = shipAOUniforms.uAOStrength.value = Math.max(0, Math.min(1, v)); }
window.shipAOSetStrength = shipAOSetStrength;
