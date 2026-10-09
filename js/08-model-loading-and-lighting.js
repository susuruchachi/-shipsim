// ============================================================
//  Stage 3: 船体曲げシェーダー（ホギング/サギングの視覚表現）
//  21-bow-stern-effects.js の hogSagUniforms / computeHogSagAmount() と対になる。
//  マテリアルをtraverseしてonBeforeCompileを仕込む手法を使うが、
//  同一マテリアルに両方のパッチが乗る場合があるため、既存のonBeforeCompileを
//  破棄せずチェーン（先に呼んでから自分の処理を足す）する。
// ============================================================
function applyHogSagBendShader(modelRoot) {
    const hp = window.hullProfile;
    if (!modelRoot || !importedModelGroup || !hp || !hp.ready) return;
    if (typeof createHogSagUniforms !== 'function') return; // 21-bow-stern-effects.js未読込

    if (!hogSagUniforms) hogSagUniforms = createHogSagUniforms();
    hogSagUniforms.halfLen.value = Math.max(0.1, hp.halfLen);
    const axisKey = hp.xIsForward ? 'x' : 'z'; // scanHullProfile()の長軸判定と揃える

    importedModelGroup.updateWorldMatrix(true, true);
    const invGroupMat = new THREE.Matrix4().copy(importedModelGroup.matrixWorld).invert();
    const tmpPos = new THREE.Vector3();
    const patched = new Set();

    modelRoot.traverse((node) => {
        if (!node.isMesh || !node.geometry) return;
        // scanHullProfile()が除外するscrew/rudder/mast/flag等は曲げない
        // （船体本体のみを弓なりに曲げる軽量近似）。
        if (typeof _isHullScanExcluded === 'function' && _isHullScanExcluded(node)) return;

        node.updateWorldMatrix(true, false);
        const relMat = new THREE.Matrix4().multiplyMatrices(invGroupMat, node.matrixWorld);
        tmpPos.setFromMatrixPosition(relMat);
        const meshAlongOffset = axisKey === 'x' ? tmpPos.x : tmpPos.z;

        const mats = Array.isArray(node.material) ? node.material : [node.material];
        mats.forEach((mat) => {
            if (!mat || patched.has(mat) || !mat.isMeshStandardMaterial) return;
            patched.add(mat);
            patchMaterialWithHogSagBend(mat, meshAlongOffset, axisKey);
        });
    });
}

function patchMaterialWithHogSagBend(mat, meshAlongOffset, axisKey) {
    mat.userData.hogSagPatched = true;
    const hsOffsetUniform = { value: meshAlongOffset };
    const prevOnBeforeCompile = mat.onBeforeCompile; // hull-glow等、既存のパッチがあれば温存する

    mat.onBeforeCompile = (shader) => {
        if (typeof prevOnBeforeCompile === 'function') prevOnBeforeCompile(shader);

        shader.uniforms.hogSagAmount  = hogSagUniforms.amount;
        shader.uniforms.hogSagHalfLen = hogSagUniforms.halfLen;
        shader.uniforms.hsAlongOffset = hsOffsetUniform;

        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', `#include <common>
uniform float hogSagAmount;
uniform float hogSagHalfLen;
uniform float hsAlongOffset;`)
            .replace('#include <begin_vertex>', `#include <begin_vertex>
{
    // ホギング/サギング: 沿岸軸(${axisKey})方向の位置に応じた放物線状のYオフセット。
    // hogSagAmount>0=中央が持ち上がる(ホギング), <0=中央が沈む(サギング)。
    float _hsAlong = transformed.${axisKey} + hsAlongOffset;
    float _hsT = clamp(_hsAlong / max(hogSagHalfLen, 0.001), -1.0, 1.0);
    transformed.y += hogSagAmount * (1.0 - _hsT * _hsT);
}`);
    };
    mat.needsUpdate = true;
}


// 昼夜で自動的にON/OFFできるよう基準のemissiveIntensityを記録する。
// 赤・緑（航行灯の色）に近いマテリアルは舷灯レンズ等とみなし対象外にする
// （航行灯は既存の航行灯トグル/夜間判定で別途制御されるため）。
function registerWindowGlowMaterial(mat) {
    if (!mat || !mat.emissive) return;
    const c = mat.emissive;
    if (c.r < 0.02 && c.g < 0.02 && c.b < 0.02) return; // 発光していないマテリアルは対象外
    const isPureRed = c.r > 0.6 && c.g < 0.3 && c.b < 0.3;
    const isPureGreen = c.g > 0.6 && c.r < 0.3 && c.b < 0.3;
    if (isPureRed || isPureGreen) return; // 航行灯レンズは対象外
    if (mat.userData.baseEmissiveIntensity == null) {
        mat.userData.baseEmissiveIntensity = (mat.emissiveIntensity != null) ? mat.emissiveIntensity : 1.0;
    }
    if (windowGlowMaterials.indexOf(mat) === -1) windowGlowMaterials.push(mat);
}

// Blenderで「Emission Strength」を1超に設定したマテリアル（窓の発光・航行灯レンズ等）が
// 本来より暗く読み込まれてしまう。生のglTF JSONから値を読み取り、マテリアル名で対応する
// THREE.Material（読み込み済みシーン側）に emissiveIntensity として手動で反映する。
// 対象が無い/失敗した場合は何もせず元の挙動のまま。
function applyGltfEmissiveStrengthExt(modelRoot, json) {
    try {
        if (!json || !Array.isArray(json.materials) || !modelRoot) return;
        const strengthByName = new Map();
        json.materials.forEach((m) => {
            const ext = m.extensions && m.extensions.KHR_materials_emissive_strength;
            const strength = ext && ext.emissiveStrength;
            if (m.name && Number.isFinite(strength) && strength > 0) {
                strengthByName.set(m.name, strength);
            }
        });
        if (strengthByName.size === 0) return;
        const done = new Set();
        modelRoot.traverse((child) => {
            if (!child.isMesh || !child.material) return;
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            mats.forEach((mat) => {
                if (!mat || done.has(mat)) return;
                const strength = strengthByName.get(mat.name);
                if (strength && 'emissiveIntensity' in mat) {
                    mat.emissiveIntensity = (mat.emissiveIntensity != null ? mat.emissiveIntensity : 1.0) * strength;
                    done.add(mat);
                }
            });
        });
    } catch (e) { /* 失敗しても元の挙動のまま続行 */ }
}

// ============================================================
//  拡散色テクスチャからのオンザフライ法線マップ生成（v83b〜、v84で強化）
// ============================================================
// 船体モデルは拡散色(diffuse)テクスチャしか持たず法線マップが無いため、
// テクスチャに描かれたリベット列やパネル継ぎ目は「色」としては見えても、
// 光を受けて実際の凹凸として陰影がつくことはなかった。ここでは読み込んだ
// 拡散色テクスチャの輝度を疑似的な高さマップとみなし、Sobelフィルタで
// その場で法線マップを生成する。新規テクスチャファイルは不要＝どのGLBを
// 読み込んでも自動的に効く。
//
// v84: 1px間隔のSobelだけだと「くっきりした1px単位のエッジ」しか拾えず、
// 塗りでゆるやかに描かれたパネルの継ぎ目や面ごとの明暗差は勾配がほぼ0に
// 近く、結果として立体に見えていなかった。fine(1px間隔)とcoarse(数px間隔)
// の2種類のSobelを合成することで、細かいディテールとパネル単位の
// 大まかな起伏の両方を拾うようにした。coarse側は間引きサンプリングの
// ぶん単純なノイズにも強くなる。
//
// 微調整メモ: coarseの寄与(COARSE_WEIGHT)を上げすぎるとパネルの起伏が
// 「ゆるく・ぼやけた」印象になり、くっきり感が薄れる。くっきりさせたい
// ときはCOARSE_WEIGHTを下げてfine(STRENGTH)を主役にする方が効果的。
// 全体の強さはSCALE_XYで最終調整（前バージョン比で「強すぎ／弱すぎ」の
// 感覚に応じてここだけ動かすのが手っ取り早い）。
//
// 既知の制限:
// ・UVアトラス内の複数パーツの継ぎ目をまたいで微妙な勾配が出ることがある
//   （テクスチャの2D構造だけを見ており、UV島の境界までは認識していない）。
// ・元テクスチャがのっぺりした単色塗りに近いほど、当然ながら効果は薄い。
// ・逆に強すぎる/ザラつく場合は下のNORMAL_GEN_SCALE_XYを下げるか、
//   生成後に各materialのnormalScaleを個別に下げれば弱められる。
const NORMAL_GEN_MAX_SIZE = { high: 1536, medium: 1280, low: 1024 }; // perf.quality別の処理解像度上限
const NORMAL_GEN_STRENGTH = 2.9;      // fineタップ(1px間隔)の勾配→法線ベクトル変換の強さ（くっきり感の主役）
const NORMAL_GEN_COARSE_STEP = 4;     // coarseタップのサンプリング間隔(px)。パネル単位の起伏用
const NORMAL_GEN_COARSE_WEIGHT = 0.6; // coarseタップの寄与度（fineタップを1.0とした相対値。控えめにして脇役に）
const NORMAL_GEN_SCALE_XY = 0.92;     // 生成後にmaterial.normalScaleへ入れる強さ（全体の強さの最終調整はここで）

function generateNormalMapFromDiffuse(sourceTexture) {
    if (!sourceTexture || !sourceTexture.image) return null;
    const img = sourceTexture.image;
    const srcW = img.width || img.videoWidth || 0;
    const srcH = img.height || img.videoHeight || 0;
    if (!srcW || !srcH) return null;

    const maxSize = NORMAL_GEN_MAX_SIZE[perf.quality] || 1024;
    const scale = Math.min(1, maxSize / Math.max(srcW, srcH));
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));

    let srcPixels;
    try {
        const srcCanvas = document.createElement('canvas');
        srcCanvas.width = w; srcCanvas.height = h;
        const sctx = srcCanvas.getContext('2d');
        sctx.drawImage(img, 0, 0, w, h);
        srcPixels = sctx.getImageData(0, 0, w, h).data;
    } catch (e) {
        // クロスオリジン画像等でピクセル読み取りができない場合は諦める（致命的ではない）
        console.warn('法線マップ自動生成: テクスチャのピクセル読み取りに失敗したためスキップしました', e);
        return null;
    }

    // 輝度(≒ペイントの明暗)を高さとみなす
    const heights = new Float32Array(w * h);
    for (let i = 0, p = 0; i < w * h; i++, p += 4) {
        heights[i] = (0.299 * srcPixels[p] + 0.587 * srcPixels[p + 1] + 0.114 * srcPixels[p + 2]) / 255;
    }
    const atH = (x, y) => {
        // タイル前提(wrap)ではなく端をクランプする＝UV島をまたいだ誤爆を避ける安全側の選択
        x = x < 0 ? 0 : (x >= w ? w - 1 : x);
        y = y < 0 ? 0 : (y >= h ? h - 1 : y);
        return heights[y * w + x];
    };
    // 間隔(step)を変えてSobel勾配を取るヘルパー。step=1で1px単位のエッジ、
    // step>1でそれより広い面の起伏を拾う（間引きサンプリングなので簡易ブラーも兼ねる）。
    const sobelGrad = (x, y, step) => {
        const tl = atH(x - step, y - step), tc = atH(x, y - step), tr = atH(x + step, y - step);
        const ml = atH(x - step, y),                                       mr = atH(x + step, y);
        const bl = atH(x - step, y + step), bc = atH(x, y + step), br = atH(x + step, y + step);
        const gx = (tr + 2 * mr + br) - (tl + 2 * ml + bl);
        const gy = (bl + 2 * bc + br) - (tl + 2 * tc + tr);
        return [gx, gy];
    };

    const outCanvas = document.createElement('canvas');
    outCanvas.width = w; outCanvas.height = h;
    const octx = outCanvas.getContext('2d');
    const outImg = octx.createImageData(w, h);
    const out = outImg.data;

    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const [gxF, gyF] = sobelGrad(x, y, 1);
            const [gxC, gyC] = sobelGrad(x, y, NORMAL_GEN_COARSE_STEP);
            const gx = gxF + gxC * NORMAL_GEN_COARSE_WEIGHT;
            const gy = gyF + gyC * NORMAL_GEN_COARSE_WEIGHT;

            let nx = -gx * NORMAL_GEN_STRENGTH;
            let ny = -gy * NORMAL_GEN_STRENGTH;
            let nz = 1.0;
            const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1.0;
            nx /= len; ny /= len; nz /= len;

            const idx = (y * w + x) * 4;
            out[idx]     = Math.round((nx * 0.5 + 0.5) * 255);
            out[idx + 1] = Math.round((ny * 0.5 + 0.5) * 255);
            out[idx + 2] = Math.round((nz * 0.5 + 0.5) * 255);
            out[idx + 3] = 255;
        }
    }
    octx.putImageData(outImg, 0, 0);

    const normalTex = new THREE.CanvasTexture(outCanvas);
    // UV変換・ラップ設定を元の拡散テクスチャと完全に一致させる
    // （ここがズレると法線マップだけタイリングや向きが食い違って見た目が破綻する）
    normalTex.wrapS = sourceTexture.wrapS;
    normalTex.wrapT = sourceTexture.wrapT;
    normalTex.repeat.copy(sourceTexture.repeat);
    normalTex.offset.copy(sourceTexture.offset);
    normalTex.center.copy(sourceTexture.center);
    normalTex.rotation = sourceTexture.rotation;
    normalTex.flipY = sourceTexture.flipY; // GLTFLoaderはflipY=falseにすることが多いため必ずコピーする
    normalTex.encoding = THREE.LinearEncoding; // 法線マップは色ではなくデータなので必ずLinear
    normalTex.needsUpdate = true;
    return normalTex;
}

function maybeGenerateDetailNormalMap(mat, doneSet) {
    if (!mat || (!mat.isMeshStandardMaterial && !mat.isMeshPhysicalMaterial)) return;
    if (mat.normalMap || !mat.map) return; // 既に法線マップがある/拡散テクスチャが無いなら何もしない
    if (perf.quality === 'ultralow' || perf.quality === 'verylow') return; // 軽量端末では読み込み時間を優先してスキップ
    if (doneSet.has(mat)) return;
    doneSet.add(mat);
    try {
        const normalTex = generateNormalMapFromDiffuse(mat.map);
        if (normalTex) {
            mat.normalMap = normalTex;
            mat.normalScale.set(NORMAL_GEN_SCALE_XY, NORMAL_GEN_SCALE_XY);
            mat.needsUpdate = true;
        }
    } catch (e) {
        console.warn('法線マップ自動生成に失敗しました（見た目には影響しますが致命的ではありません）:', e);
    }
}

// v89: テクスチャに異方性フィルタリング(anisotropic filtering)を適用する。
// これまで未設定(=1、等方フィルタのみ)だったため、船体側面のように画面に対して
// 浅い角度で見えるテクスチャ(甲板の線・リベット・窓の並び等)がボケて/ジャギって
// 見えていた。renderer.capabilities.getMaxAnisotropy()の値まで上げることで、
// 追加のテクスチャメモリ無しでその見た目の粗さをかなり軽減できる。
function applyAnisotropyToMaterial(mat) {
    if (!mat || !renderer || !renderer.capabilities) return;
    const maxAniso = renderer.capabilities.getMaxAnisotropy ? renderer.capabilities.getMaxAnisotropy() : 1;
    if (!maxAniso || maxAniso <= 1) return;
    ['map', 'normalMap', 'emissiveMap', 'roughnessMap', 'metalnessMap', 'aoMap'].forEach((key) => {
        const tex = mat[key];
        if (tex && tex.anisotropy !== maxAniso) {
            tex.anisotropy = maxAniso;
            tex.needsUpdate = true;
        }
    });
}

// ── 背中合わせに重なった面（同じ位置の三角形が表裏 2 枚）──
//  模型によっては、薄い板（通風筒の口・煙突の縁・ボートのカバーなど）を、表向きと裏向きの 2 枚の面で作ってある
//  （表と裏で色が違うことも多い）。この船の材質は両面を描く（DoubleSide）ので、同じ所に 2 枚とも描かれて奥行きが
//  まったく同じになり、どちらが見えるかが画素ごとに入れ替わって、まだらに見えていた（モーリタニアの通風筒・煙突など）。
//  そこで、その 2 枚の組は表だけ描く材質（FrontSide：裏から見ると反対の 1 枚が見える）に分ける。
//  向きまで同じ、まったく同じ面が 2 枚あるときは 1 枚を消す。ほかの面は今まで通り両面
function splitTwinFaces(mesh, frontCache) {
    const g = mesh.geometry, P = g && g.attributes.position;
    if (!P || !mesh.material) return 0;
    const idx = g.index ? g.index.array : null, nT = Math.floor((idx ? idx.length : P.count) / 3);
    if (nT < 2 || nT > 4000000) return 0;
    if (!g.boundingBox) g.computeBoundingBox();
    const bb = g.boundingBox, ext = Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z);
    const q = Math.max(1e-9, ext * 2e-6);
    // 頂点の位置を細かい升目に丸めた番号（同じ位置の頂点は同じ番号）
    const qv = new Int32Array(P.count * 3), vh = new Uint32Array(P.count);
    for (let v = 0; v < P.count; v++) {
        const x = Math.round((P.getX(v) - bb.min.x) / q), y = Math.round((P.getY(v) - bb.min.y) / q), z = Math.round((P.getZ(v) - bb.min.z) / q);
        qv[v * 3] = x; qv[v * 3 + 1] = y; qv[v * 3 + 2] = z;
        let h = Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791);
        vh[v] = h >>> 0;
    }
    const V = (t, k) => idx ? idx[t * 3 + k] : t * 3 + k;
    const same = (a, b) => qv[a * 3] === qv[b * 3] && qv[a * 3 + 1] === qv[b * 3 + 1] && qv[a * 3 + 2] === qv[b * 3 + 2];
    const kind = new Uint8Array(nT);               // 0：ふつう、1：背中合わせの組、2：まったく同じ面（消す）
    const map = new Map();
    let twins = 0, dups = 0;
    for (let t = 0; t < nT; t++) {
        const a = V(t, 0), b = V(t, 1), c = V(t, 2);
        if (same(a, b) || same(b, c) || same(a, c)) continue;          // つぶれた三角形
        const h = ((vh[a] + vh[b] + vh[c]) ^ Math.imul(vh[a] ^ vh[b] ^ vh[c], 2654435761)) >>> 0;
        const L = map.get(h);
        if (L) {
            let hit = false;
            for (const u of L) {
                const ua = V(u, 0), ub = V(u, 1), uc = V(u, 2);
                // 同じ 3 点か（順番は問わない）
                const m0 = same(a, ua) ? 0 : same(a, ub) ? 1 : same(a, uc) ? 2 : -1;
                if (m0 < 0) continue;
                const U = [ua, ub, uc];
                if (!(same(b, U[(m0 + 1) % 3]) && same(c, U[(m0 + 2) % 3])) && !(same(b, U[(m0 + 2) % 3]) && same(c, U[(m0 + 1) % 3]))) continue;
                if (same(b, U[(m0 + 1) % 3])) { kind[t] = 2; dups++; }   // 同じ向き（同じ面が 2 枚）
                else { if (kind[u] === 0) { kind[u] = 1; twins++; } kind[t] = 1; twins++; }
                hit = true; break;
            }
            if (hit) continue;
            L.push(t);
        } else map.set(h, [t]);
    }
    if (!twins && !dups) return 0;
    // 三角形を並べ直す：元の材質ごとに、ふつうの面（両面）と、背中合わせの面（表だけ）
    const mats = Array.isArray(mesh.material) ? mesh.material.slice() : [mesh.material];
    const groups = g.groups && g.groups.length ? g.groups : [{ start: 0, count: nT * 3, materialIndex: 0 }];
    const out = [], ng = [];
    const frontIdx = new Map();
    for (const G of groups) {
        const t0 = Math.floor(G.start / 3), t1 = Math.min(nT, t0 + Math.floor(G.count / 3)), mi = G.materialIndex || 0;
        const s0 = out.length;
        for (let t = t0; t < t1; t++) if (kind[t] === 0) out.push(V(t, 0), V(t, 1), V(t, 2));
        if (out.length > s0) ng.push({ start: s0, count: out.length - s0, materialIndex: mi });
        const s1 = out.length;
        for (let t = t0; t < t1; t++) if (kind[t] === 1) out.push(V(t, 0), V(t, 1), V(t, 2));
        if (out.length > s1) {
            let fi = frontIdx.get(mi);
            if (fi === undefined) {
                const m = mats[mi];
                let fm = frontCache && frontCache.get(m);
                if (!fm) {
                    fm = m.clone(); fm.side = THREE.FrontSide;
                    // （材質に足した描き方の変更も引き継ぐ：clone は onBeforeCompile を写さない）
                    fm.onBeforeCompile = m.onBeforeCompile; fm.customProgramCacheKey = m.customProgramCacheKey;
                    if (typeof registerWindowGlowMaterial === 'function' && typeof windowGlowMaterials !== 'undefined' && windowGlowMaterials.indexOf(m) !== -1) registerWindowGlowMaterial(fm);
                    if (frontCache) frontCache.set(m, fm);
                }
                fi = mats.length; mats.push(fm); frontIdx.set(mi, fi);
            }
            ng.push({ start: s1, count: out.length - s1, materialIndex: fi });
        }
    }
    const IA = P.count > 65535 ? Uint32Array : Uint16Array;
    g.setIndex(new THREE.BufferAttribute(new IA(out), 1));
    g.clearGroups(); for (const G of ng) g.addGroup(G.start, G.count, G.materialIndex);
    mesh.material = mats;
    return twins + dups;
}
window.splitTwinFaces = splitTwinFaces;

function applyMaterialsToModel(model) {
    const normalMapDone = new Set(); // 同じマテリアルを複数メッシュで共有していても生成は1回だけ
    const frontCache = new Map();
    let twinN = 0;
    model.traverse((child) => {
        if (!child.isMesh || !child.material) return;
        // v83: 船体・上部構造・煙突・舵などすべてのGLBメッシュで影を出す/受ける。
        // 特定のパーツ（例: ガラス窓）で影の見え方が不自然な場合は、そのメッシュだけ
        // 後から child.castShadow=false 等で個別に上書きすればよい。
        child.castShadow = true;
        child.receiveShadow = true;
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        const newMats = mats.map((mat) => {
            if (!mat) return mat;
            // RectAreaLight は MeshStandard/MeshPhysical にしか当たらない。
            // Phong/Lambert/Basic → Standard に変換する。
            if (mat.isMeshPhongMaterial || mat.isMeshLambertMaterial || mat.isMeshBasicMaterial) {
                const std = new THREE.MeshStandardMaterial({
                    color:       mat.color       ? mat.color.clone()   : new THREE.Color(0xffffff),
                    map:         mat.map         || null,
                    normalMap:   mat.normalMap   || null,
                    emissive:    mat.emissive    ? mat.emissive.clone() : new THREE.Color(0x000000),
                    emissiveMap: mat.emissiveMap || null,
                    roughness:   0.6,
                    metalness:   0.1,
                    transparent: mat.transparent || false,
                    opacity:     mat.opacity     != null ? mat.opacity : 1.0,
                    side:        THREE.DoubleSide,
                });
                std.needsUpdate = true;
                registerWindowGlowMaterial(std);
                maybeGenerateDetailNormalMap(std, normalMapDone);
                applyAnisotropyToMaterial(std);
                return std;
            }
            mat.side = THREE.DoubleSide;
            // GLBネイティブのroughnessが低い場合も底上げ
            if (mat.isMeshStandardMaterial || mat.isMeshPhysicalMaterial) {
                mat.roughness = Math.max(mat.roughness, 0.55);
            }
            mat.needsUpdate = true;
            registerWindowGlowMaterial(mat);
            maybeGenerateDetailNormalMap(mat, normalMapDone);
            applyAnisotropyToMaterial(mat);
            return mat;
        });
        if (Array.isArray(child.material)) {
            child.material = newMats;
        } else {
            child.material = newMats[0];
        }
        // 窓・キャビンなどの発光マテリアル（registerWindowGlowMaterialで登録済み）を
        // 含むメッシュだけブルーム対象として残す。それ以外のPBR面（船体・甲板等）は
        // 引き続きブルームパスから除外する（ガビガビ防止）。
        // 背中合わせに重なった面は、表だけ描く（まだらに見えないように）
        twinN += splitTwinFaces(child, frontCache);
        const hasWindowGlow = newMats.some((m) => m && windowGlowMaterials.indexOf(m) !== -1);
        child.userData.noBloom = !hasWindowGlow;
        // emissiveメッシュをリストに追加（後で発光パネルの抽出に使う）
        if (hasWindowGlow) {
            const gm = newMats.find(m => m && windowGlowMaterials.indexOf(m) !== -1);
            if (gm) windowGlowMeshEntries.push({ mesh: child, mat: gm });
            // 窓ガラス（発光メッシュ）自体は光源側とみなし、影を落とさない。
            // 発光パネルの光源は窓面のすぐ外に置くので、窓ガラスが影を落とすと
            // 自分自身に遮られて光が外へ出てこなくなる。receiveShadowはtrueの
            // ままなので、他の物の影を窓ガラスが受けるのは従来通り。
            child.castShadow = false;
        }
    });
    if (twinN) console.log(`[model] 背中合わせに重なった面 ${twinN} 枚を、表だけ描くようにしました`);
}

// v91: 船モデルを読み替える際、古いモデルのジオメトリ/マテリアル/テクスチャを
// 明示的にGPUメモリから解放する。
// これまではshipGroup.remove(child)でシーングラフから外すだけで、
// Three.js側のGPUリソース（VRAM上のテクスチャ・頂点バッファ）は解放していなかった。
// remove()しただけではdispose()は自動的には呼ばれないため、船を何度も読み替えて
// 検証していると古いモデル分のテクスチャがVRAMに残り続けて積み上がっていく。
// これが「軽いモデルは平気だが、少し重い(テクスチャの大きい)GLBを読み込むと
// 形は出るのにテクスチャだけ反映されない」不具合の主因と考えられる
// （ジオメトリは数MB程度で収まることが多いが、2K/4K テクスチャは1枚十数MB以上
// VRAMを使うため、蓄積した分と合わせてブラウザ/GPUのメモリ上限を超えると
// テクスチャのアップロードだけが失敗し、ジオメトリはそのまま描画される）。
function disposeObject3D(root) {
    if (!root) return;
    const seenGeo = new Set();
    const seenMat = new Set();
    const seenTex = new Set();
    const texKeys = [
        'map', 'normalMap', 'emissiveMap', 'roughnessMap', 'metalnessMap',
        'aoMap', 'alphaMap', 'bumpMap', 'displacementMap', 'envMap', 'lightMap',
        'clearcoatMap', 'clearcoatNormalMap', 'clearcoatRoughnessMap',
        'metalnessRoughnessMap', 'specularMap', 'gradientMap',
    ];
    root.traverse((obj) => {
        if (obj.geometry && !seenGeo.has(obj.geometry)) {
            seenGeo.add(obj.geometry);
            obj.geometry.dispose();
        }
        const mats = Array.isArray(obj.material) ? obj.material : (obj.material ? [obj.material] : []);
        mats.forEach((mat) => {
            if (!mat || seenMat.has(mat)) return;
            seenMat.add(mat);
            texKeys.forEach((key) => {
                const tex = mat[key];
                if (tex && tex.isTexture && !seenTex.has(tex)) {
                    seenTex.add(tex);
                    tex.dispose();
                }
            });
            mat.dispose();
        });
    });
}

function setCustomModel(model) {
    if (!modelHasMesh(model)) return;
    
    if (currentGizmoTarget === importedModelGroup?.children[0]) disableGizmo();
    if (currentGizmoType === 'glbpart' || currentGizmoType === 'glbpart_pivot') disableGizmo();
    
    // 前のモデルとGLBライトを削除
    const toRemove = [];
    shipGroup.children.forEach((child) => {
        if (child !== cgMarker && child !== rudderMarker
            && !child.userData.isSky
            && !child.userData.isViewpointMarker) toRemove.push(child);
    });
    toRemove.forEach((child) => {
        shipGroup.remove(child);
        disposeObject3D(child); // v91: シーンから外すのと同時にGPUリソースも解放
    });

    // 以前のGLBライトをシーンから削除（エリアライト枠も一緒に削除）
    glbLights.forEach((l) => {
        if (l.parent) l.parent.remove(l);
        if (l.target && l.target.parent) l.target.parent.remove(l.target);
        if (l.userData.areaBoxHelper && l.userData.areaBoxHelper.parent) {
            l.userData.areaBoxHelper.parent.remove(l.userData.areaBoxHelper);
        }
    });
    glbLights = [];
    windowGlowMaterials = [];
    windowGlowMeshEntries = [];
    // 旧モデルの発光パネル（26-glow-emitters.js）と環境光プローブを片付ける
    if (typeof disposeGlowEmitters === 'function') disposeGlowEmitters();
    // 甲板照明・煙突アップライトもリセット
    clearDecorLights();
    clearFunnelUplights();

    applyMaterialsToModel(model);

    const box = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3();
    box.getSize(size);
    const origLength = Math.max(size.x, size.y, size.z);
    modelOffset.autoScale = origLength > 0 ? 12.0 / origLength : 1.0;

    // GLBに含まれるライトを抽出（Punctual: Point/Spot/Directional）
    model.traverse((child) => {
        if (child.isLight) {
            child.userData.isGlbLight = true;
            child.userData.baseIntensity = child.intensity;
            glbLights.push(child);
        }
    });

    // カスタムプロパティからエリアライト（RectAreaLight）を生成
    // Blenderで Object Custom Properties に type="area" を設定した空オブジェクトを読み込む
    // ※ まずEmptyオブジェクトを収集するだけ。ライト生成はmodelをシーンに追加した後に行う。
    const pendingAreaLightEmpties = [];
    model.traverse((child) => {
        const ud = child.userData;
        if (!ud || ud.type !== 'area') return;
        pendingAreaLightEmpties.push(child);
    });

    // ── エリアライトの生成は 25-area-lights.js に任せる ──────────────────
    // 元のEmptyと同じ親・同じローカル変換のノードを置き、その子に光源を持たせる
    // 方式なので、モデルの移動・回転・拡縮にシーングラフの継承だけで追従する
    // （ワールド座標を手計算して焼き込む必要がない＝modelOffsetを後から変えても
    //   ズレない）。実際の照明は three.js の RectAreaLight（面光源）が行い、
    // 影は同じ位置・向きに置いた SpotLight が担当する。
    if (typeof buildAreaLights === 'function') {
        buildAreaLights(model, pendingAreaLightEmpties);
    }

    importedModelGroup = new THREE.Group();
    importedModelGroup.add(model);
    shipGroup.add(importedModelGroup);

    detectGlbMovableParts(model);

    // モデル自体にスクリュー・外輪パーツが含まれている場合は、
    // 組み込みの推進器（プロペラ等）を自動追加しない。
    // 含まれていない場合のみ、デフォルトの推進器を1つ用意する。
    const hasOwnScrew = glbMovableParts.some(p => p.key === 'screw' || p.key === 'paddle');
    if (hasOwnScrew) {
        propulsors = [];
    } else if (propulsors.length === 0) {
        propulsors = [{ x: 0, y: -1.2, z: -7, size: 1.0, dir: 1 }];
    }

    // ライト数をステータスに反映
    if (glbLights.length > 0) {
        const statusText = $('import-status');
        if (statusText) {
            const prev = statusText.innerText;
            statusText.innerText = prev + ` ＋ライト×${glbLights.length}`;
        }
    }
    
    initSettingsComponents();
    updateModelOffset();

    // pendingGlbLightSettings: モデルロード前に保存データが来た場合に適用
    if (pendingGlbLightSettings && glbLights.length > 0) {
        applyGlbLightSettingsData(pendingGlbLightSettings);
        pendingGlbLightSettings = null;
    }

    // ── 船体形状スキャン（引き波物理用） ──
    // updateModelOffset() が matrixWorld を更新した後に実行する必要があるため
    // 1フレーム遅らせて呼ぶ。
    setTimeout(() => {
        if (typeof scanHullProfile === 'function') {
            scanHullProfile();
        }
        // Stage1/2で使う判定用の履歴を、前に読み込んでいた船のものが残らないように
        // リセットする（船を載せ替えた直後に前の船の状態のまま判定してしまう問題を防ぐ）。
        window._prevBowVolSubmerged = null;
        window._prevSternVolSubmerged = null;
        window._lastBowSlamT = null;
        window._lastSternSlamT = null;
        window._bowExcessBaselineVol = null; // 恒常バイアス除去の窓トラッカーも前の船の値を引き継がないようリセット
        window._bowExcessBufA = null;
        window._bowExcessBufB = null;
        window._bowExcessHalfTimer = null;
        if (typeof HOGSAG_ENABLED !== 'undefined' && HOGSAG_ENABLED && typeof applyHogSagBendShader === 'function') {
            applyHogSagBendShader(model); // Stage3: 船体曲げシェーダー（hullProfile確定後に実行する必要がある）
        }
        if (window._invalidateWlCache) window._invalidateWlCache();
        // 発光メッシュのワールド座標が確定してから、発光パネル（窓・灯具を
        // 面光源として扱う。26-glow-emitters.js）を組み立てる
        if (typeof buildGlowEmitters === 'function') buildGlowEmitters();
    }, 100);
}

// エリアライト設定（位置・回転・スケール・強度・色・ON/OFF）を一括復元する
function applyGlbLightSettingsData(settingsArr) {
    settingsArr.forEach((saved, i) => {
        // ラベル名で検索、なければインデックスでフォールバック
        let light = glbLights.find(l => (l.userData.labelName || '') === saved.label);
        if (!light && i < glbLights.length) light = glbLights[i];
        if (!light) return;

        // 強度
        if (Number.isFinite(saved.baseIntensity)) {
            light.userData.baseIntensity = saved.baseIntensity;
        }
        // 色
        if (saved.color) {
            light.color.set(saved.color);
            if (light.userData.mirrorLight) light.userData.mirrorLight.color.set(saved.color);
        }
        // ON/OFF
        if (typeof saved.manuallyOff === 'boolean') {
            light.userData.manuallyOff = saved.manuallyOff;
        }

        // areaNode の変換（位置・回転・スケール）を復元
        // これが照射方向・面サイズ・ライト位置の実体
        const an = light.userData.areaNode;
        if (an && saved.areaNode) {
            const sn = saved.areaNode;
            if (sn.pos)   an.position.set(sn.pos.x, sn.pos.y, sn.pos.z);
            if (sn.rot) {
                an.rotation.set(sn.rot.x, sn.rot.y, sn.rot.z, sn.rot.order || 'XYZ');
                // 古い保存データ（ローカル +Y を照らす決まりだった頃）で、読み込んだときの
                // 向きから手で回してあるもの＝その頃の決まりで向きを合わせたもの。
                // 照らす向きが変わらないよう、ローカルX軸まわりに180°回して今の決まり
                // （-Y を照らす）に直す。回していないものは、今の決まりで正しい向きになる。
                if (sn.conv !== 2 && an.userData.origQuat && an.quaternion.angleTo(an.userData.origQuat) > 0.02) {
                    an.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI));
                }
            }
            if (sn.scale) an.scale.set(sn.scale.x, sn.scale.y, sn.scale.z);
            // RectAreaLight本体は「スケールを持たない光源ノード」の子として
            // ローカル原点に置いてあり、位置はそのノードが areaNode から毎フレーム
            // 受け取る（25-area-lights.js）。ここで light.position を触ると
            // 二重にオフセットされてしまうので、エリアライト以外だけ同期する。
            if (!light.isRectAreaLight) light.position.copy(an.position);
            // areaBoxHelper（ギズモ用ワイヤーフレーム）も同期
            if (light.userData.areaBoxHelper) {
                const h = light.userData.areaBoxHelper;
                h.position.copy(an.position);
                h.rotation.copy(an.rotation);
                h.scale.copy(an.scale);
            }
        }
    });

    applyGlbLightIntensities();
    if (typeof renderGlbLightsList === 'function') renderGlbLightsList();
}

function updateModelOffset() {
    if (!importedModelGroup || !importedModelGroup.children[0]) return;
    const child = importedModelGroup.children[0];
    child.position.set(modelOffset.x, modelOffset.y, modelOffset.z);
    child.rotation.y = (modelOffset.ry * Math.PI) / 180;
    const finalScale = modelOffset.autoScale * modelOffset.scale;
    child.scale.set(finalScale, finalScale, finalScale);

    // 船首方向(ry)やスケールが変わったら引き波断面スキャンも更新
    clearTimeout(updateModelOffset._scanTimer);
    updateModelOffset._scanTimer = setTimeout(() => {
        if (typeof scanHullProfile === 'function') scanHullProfile();
        if (window._invalidateWlCache) window._invalidateWlCache();
    }, 50);
}

function loadOBJ(text, fileName) {
    pendingOBJText = text; pendingOBJName = fileName;
    const loader = new THREE.OBJLoader();
    if (pendingMTLMaterials) loader.setMaterials(pendingMTLMaterials);
    const obj = loader.parse(text);
    if (!modelHasMesh(obj)) throw new Error('OBJ has no mesh');
    setCustomModel(obj);
    $('import-status').innerText = pendingMTLMaterials ? 'Loaded OBJ + MTL: ' + fileName : 'Loaded OBJ: ' + fileName;
}

function loadMTL(text, fileName, reloaded) {
    const statusText = $('import-status');
    if (!THREE.MTLLoader) return;
    try {
        const manager = new THREE.LoadingManager();
        manager.setURLModifier((url) => resolveTextureAlias(url) || url);
        const mtlLoader = new THREE.MTLLoader(manager);
        const materials = mtlLoader.parse(text, '');
        if (materials && materials.preload) materials.preload();
        pendingMTLMaterials = materials; pendingMTLText = text;
        if (pendingOBJText) loadOBJ(pendingOBJText, pendingOBJName);
        statusText.innerText = (reloaded ? 'Reloaded MTL: ' : 'Loaded MTL: ') + fileName;
    } catch (e) {
        statusText.innerText = 'Error loading MTL';
    }
}

function setupTextureFolderLoader() {
    const folderInput = $('texture-folder-loader');
    if (!folderInput) return;
    folderInput.addEventListener('change', (e) => {
        const files = Array.from(e.target.files || []);
        textureObjectURLs.forEach((url) => URL.revokeObjectURL(url));
        textureObjectURLs = []; textureAliases = {}; textureAliasCount = 0;

        for (const file of files) {
            const url = URL.createObjectURL(file);
            textureObjectURLs.push(url);
            const cleanName = file.name.toLowerCase();
            textureAliases[cleanName] = url;
            textureAliasCount++;
        }
        let firstMTL = null;
        for (const file of files) {
            if (file.name.toLowerCase().endsWith('.mtl')) { firstMTL = file; break; }
        }
        if (firstMTL) {
            const reader = new FileReader();
            reader.onload = (ev) => loadMTL(ev.target.result, firstMTL.name, true);
            reader.readAsText(firstMTL);
        } else if (pendingMTLText) {
            loadMTL(pendingMTLText, 'Reloaded MTL', true);
        } else if (pendingOBJText) {
            loadOBJ(pendingOBJText, pendingOBJName);
        }
        e.target.value = '';
    });
}

function setGlbMaster(v) {
    glbLightMaster = v;
    applyGlbLightIntensities();
}

// GLBライト（エリア/ポイント等、航行灯以外）の実際の明るさを
// 「基準強度 × 全体明るさスライダー × 昼夜自動係数」から再計算する。
// 自動モードがOFFの間は昼夜係数=1なので、常時このまま明るさが反映される。
function applyGlbLightIntensities() {
    const factor = glbLightAutoMode ? lightingNightFactor : 1.0;
    // 完全に昼間(factor≈0)の間はvisible=falseにして、Three.js側のライトループから完全に除外する。
    // intensity=0にするだけだとシェーダー内のライト数(NUM_POINT_LIGHTS等)は減らないままなので、
    // GPU負荷は下がらない。visibleをfalseにすることで初めて実際の計算コストが減る。
    const autoHide = glbLightAutoMode && factor < 0.02;
    glbLights.forEach((light) => {
        if (light.userData && light.userData.isMirrorLight) return; // ミラーは元ライトに同期するのでスキップ
        const base = light.userData.baseIntensity != null ? light.userData.baseIntensity : light.intensity;
        // 個別のON/OFFスイッチ(手動)が優先。手動でOFFでなければ、昼の自動消灯判定に従う。
        const wantVisible = !light.userData.manuallyOff && !autoHide;
        // エリアライトは RectAreaLight と影用SpotLightの2灯構成で、光量を分け合う。
        // その配分は 25-area-lights.js の updateAreaLights() が毎フレーム決めるので、
        // ここでは「こうしたい値」をuserDataに残すだけにして、直接の代入は競合させない。
        light.userData.targetIntensity = base * glbLightMaster * factor;
        light.userData.targetVisible   = wantVisible;
        light.intensity = light.userData.targetIntensity;
        // 照明を焼き込んでいる間（40-light-bake.js）は、焼き込み済みの点・スポットの
        // ライトは消す（水面の映り込み用に、点いているはずかどうかは残しておく）
        const bakedHide = !light.userData.isAreaLight && typeof lightBakeHides === 'function' && lightBakeHides('L', light);
        light.visible = wantVisible && !bakedHide;
        light.userData.bakedHidden = wantVisible && bakedHide;
        if (light.userData.mirrorLight) {
            light.userData.mirrorLight.intensity = light.intensity;
            light.userData.mirrorLight.visible = light.visible;
        }
    });
}

// 「日が昇ったら自動消灯」ボタン用。航行灯はこの対象外（既存の航行灯トグル/夜間判定で別管理）。
function setGlbAutoMode(enabled) {
    glbLightAutoMode = enabled;
    applyGlbLightIntensities();
}

function setGlbDistance(v) {
    // v=0 → distance=0 (Three.jsでは∞扱い)
    glbLights.forEach((light) => {
        if (light.isPointLight || light.isSpotLight || light.isDirectionalLight) {
            light.distance = v;
        }
    });
}

function updateLightingSettings() {
    lightSettings.sunMult = parseFloat($('light-sun-mult').value);
    lightSettings.ambientMult = parseFloat($('light-ambient-mult').value);
    lightSettings.hemiMult = parseFloat($('light-hemi-mult').value);
    lightSettings.fillMult = parseFloat($('light-fill-mult').value);
    lightSettings.exposure = parseFloat($('light-exposure').value);
    lightSettings.fogMult = parseFloat($('light-fog-mult').value);
    lightSettings.glbMaster = parseFloat($('light-glb-master').value);
    lightSettings.windowGlowMult = parseFloat($('light-window-glow').value);

    $('light-sun-mult-num').value = lightSettings.sunMult;
    $('light-ambient-mult-num').value = lightSettings.ambientMult;
    $('light-hemi-mult-num').value = lightSettings.hemiMult;
    $('light-fill-mult-num').value = lightSettings.fillMult;
    $('light-exposure-num').value = lightSettings.exposure;
    $('light-fog-mult-num').value = lightSettings.fogMult;
    $('light-glb-master-num').value = lightSettings.glbMaster;
    $('light-window-glow-num').value = lightSettings.windowGlowMult;

    if (renderer) renderer.toneMappingExposure = lightSettings.exposure;
    setGlbMaster(lightSettings.glbMaster);

    // glb-master-num（spanテキスト）も同期
    const masterNumSpan = $('glb-master-num');
    if (masterNumSpan) masterNumSpan.textContent = lightSettings.glbMaster.toFixed(2);
}

function syncLightingPanelUI() {
    setVal('light-sun-mult', lightSettings.sunMult); setVal('light-sun-mult-num', lightSettings.sunMult);
    setVal('light-ambient-mult', lightSettings.ambientMult); setVal('light-ambient-mult-num', lightSettings.ambientMult);
    setVal('light-hemi-mult', lightSettings.hemiMult); setVal('light-hemi-mult-num', lightSettings.hemiMult);
    setVal('light-fill-mult', lightSettings.fillMult); setVal('light-fill-mult-num', lightSettings.fillMult);
    setVal('light-exposure', lightSettings.exposure); setVal('light-exposure-num', lightSettings.exposure);
    setVal('light-fog-mult', lightSettings.fogMult); setVal('light-fog-mult-num', lightSettings.fogMult);
    setVal('light-glb-master', lightSettings.glbMaster); setVal('light-glb-master-num', lightSettings.glbMaster);
    setVal('light-window-glow', lightSettings.windowGlowMult); setVal('light-window-glow-num', lightSettings.windowGlowMult);

    if (renderer) renderer.toneMappingExposure = lightSettings.exposure;
    setGlbMaster(lightSettings.glbMaster);
}

function resetLightingSettings() {
    lightSettings.sunMult = 1.0;
    lightSettings.ambientMult = 1.0;
    lightSettings.hemiMult = 1.0;
    lightSettings.fillMult = 1.0;
    lightSettings.exposure = 0.85;
    lightSettings.fogMult = 1.0;
    lightSettings.glbMaster = 1.0;
    lightSettings.windowGlowMult = 1.0;
    syncLightingPanelUI();
}

// ── エリアライト選択枠（ワイヤーフレームボックス） ──────────────────────────
// ギズモでエリアライトを選択したとき、面の大きさと向きが分かる枠を3Dに表示する。
// areaNode の変換（位置・回転・サイズ）に追従する Object3D として shipGroup に追加。
function createAreaLightBoxHelper(light) {
    if (light.userData.areaBoxHelper) return; // 既に作成済み
    const anode = light.userData.areaNode;
    if (!anode) return;

    // 単位1×1の平板ワイヤーフレーム（areaNodeのscaleで実サイズに合わせる）
    const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 0.02, 1));
    const mat = new THREE.LineBasicMaterial({
        color: 0x00ffcc,
        linewidth: 1,
        depthTest: false,
        transparent: true,
        opacity: 0.85
    });
    const box = new THREE.LineSegments(geo, mat);
    // 面の向き矢印：照射方向（ローカルY+方向）を示す小さな線
    const arrowGeo = new THREE.BufferGeometry();
    arrowGeo.setAttribute('position', new THREE.Float32BufferAttribute([
        0, 0.01, 0,   0, 0.6, 0  // Y方向の短い矢印
    ], 3));
    const arrowMat = new THREE.LineBasicMaterial({ color: 0xffcc00, depthTest: false, opacity: 0.9, transparent: true });
    const arrow = new THREE.Line(arrowGeo, arrowMat);

    const group = new THREE.Group();
    group.add(box);
    group.add(arrow);
    group.visible = false;
    group.userData.isAreaBoxHelper = true;

    // areaNodeの親（モデルノード）に同じ変換で追随させる
    anode.parent.add(group);
    light.userData.areaBoxHelper = group;
}

function updateAreaLightBoxHelper(light) {
    const helper = light.userData.areaBoxHelper;
    const anode  = light.userData.areaNode;
    if (!helper || !anode) return;
    // areaNodeの変換をそのままコピー（位置・回転・スケール）
    helper.position.copy(anode.position);
    helper.rotation.copy(anode.rotation);
    helper.scale.copy(anode.scale);
}

function showAreaLightBoxHelper(lightIndex) {
    glbLights.forEach((l, i) => {
        if (!l.userData.areaBoxHelper) return;
        l.userData.areaBoxHelper.visible = (i === lightIndex);
    });
}

function hideAllAreaLightBoxHelpers() {
    glbLights.forEach(l => {
        if (l.userData.areaBoxHelper) l.userData.areaBoxHelper.visible = false;
    });
}

function updateGlbLightsUI() {
    const sectionTab = $('glb-lights-section-tab');  // 照明タブ内のセクション
    const emptyMsg   = $('glb-lights-empty-msg');
    const list = $('glb-lights-list');
    if (!list) return;

    if (glbLights.length === 0) {
        if (sectionTab) sectionTab.style.display = 'none';
        if (emptyMsg)   emptyMsg.style.display = '';
        return;
    }
    if (sectionTab) sectionTab.style.display = '';
    if (emptyMsg)   emptyMsg.style.display = 'none';

    // マスタースライダー・自動消灯トグルを現在値に同期
    const masterSlider = $('light-glb-master');
    const masterNum    = $('light-glb-master-num');
    const masterNumSpan = $('glb-master-num');
    if (masterSlider) masterSlider.value = glbLightMaster;
    if (masterNum)    masterNum.value = glbLightMaster;
    if (masterNumSpan) masterNumSpan.textContent = glbLightMaster.toFixed(2);
    const autoToggle = $('glb-auto-toggle');
    if (autoToggle) { autoToggle.checked = glbLightAutoMode; }

    const typeLabel = {
        PointLight: '🔆 点光源',
        SpotLight: '🔦 スポット',
        DirectionalLight: '☀ 平行光',
        RectAreaLight: '▭ エリア'
    };
    list.innerHTML = '';

    glbLights.forEach((light, i) => {
        // ミラーライト（シンメトリーで自動生成）はUIカードを表示しない
        if (light.userData && light.userData.isMirrorLight) return;

        const typeStr = (light.userData && light.userData.isAreaLight) ? '▭ エリア' : (typeLabel[light.type] || light.type);
        const colorHex = '#' + light.color.getHexString();
        const baseName = light.userData.labelName || light.name || (typeStr + ' #' + (i + 1));
        const base = light.userData.baseIntensity || light.intensity;

        const row = document.createElement('div');
        row.style.cssText = 'margin-bottom:10px;padding:8px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.12);border-radius:6px;';

        // エリアライトはサイズ・位置・ギズモ・シンメトリーも表示
        // エリアライトの位置の実体は areaNode（光源本体はその子ノードの原点に居る）
        const pos = (light.userData && light.userData.areaNode) ? light.userData.areaNode.position : light.position;
        const isSym = !!light.userData.symmetry;
        // isAreaLight（PointLight代用）も RectAreaLight と同じUIを出す
        const isAreaLike = light.isRectAreaLight || light.userData.isAreaLight;
        // サイズ・向きの現在値を取得
        const _anode = light.userData.areaNode;
        // areaNode があるときは常にそちらが実体（scale.x=幅, scale.z=高さ, rotationは面の向き）
        const _aw = _anode ? _anode.scale.x : (light.isRectAreaLight ? light.width  : 1);
        const _ah = _anode ? _anode.scale.z : (light.isRectAreaLight ? light.height : 1);
        const _asrc = _anode ? _anode.rotation : (light.isRectAreaLight ? light.rotation : new THREE.Euler());
        const _rx = THREE.MathUtils.radToDeg(_asrc.x || 0);
        const _ry = THREE.MathUtils.radToDeg(_asrc.y || 0);
        const _rz = THREE.MathUtils.radToDeg(_asrc.z || 0);
        const _isT = currentGizmoType === 'glb_arealight' && currentGizmoIndex === i && currentGizmoMode === 'translate';
        const _isR = currentGizmoType === 'glb_arealight' && currentGizmoIndex === i && currentGizmoMode === 'rotate';
        const _isS = currentGizmoType === 'glb_arealight' && currentGizmoIndex === i && currentGizmoMode === 'scale';
        const extraRow = isAreaLike
            ? `<div style="margin-top:8px;display:flex;flex-direction:column;gap:6px;">

                 <!-- ギズモボタン行 -->
                 <div style="display:flex;gap:4px;">
                   <button class="sp-gizmo-btn${_isT?' active':''}" id="gizmo-alight-${i}-translate"
                     onclick="toggleGizmo('glb_arealight',${i},'translate')"
                     style="flex:1;font-size:10px;">📍 移動</button>
                   <button class="sp-gizmo-btn${_isR?' active':''}" id="gizmo-alight-${i}-rotate"
                     onclick="toggleGizmo('glb_arealight',${i},'rotate')"
                     style="flex:1;font-size:10px;">🔄 回転</button>
                   <button class="sp-gizmo-btn${_isS?' active':''}" id="gizmo-alight-${i}-scale"
                     onclick="toggleGizmo('glb_arealight',${i},'scale')"
                     style="flex:1;font-size:10px;">⤢ 拡縮</button>
                 </div>

                 <!-- 位置 -->
                 <div>
                   <div style="font-size:10px;color:#888;margin-bottom:2px;">位置 XYZ</div>
                   <div class="sp-xyz-row">
                     <span class="sp-axis-label">X:</span>
                     <input type="number" id="alight-x-${i}" class="sp-xyz-input" value="${pos.x.toFixed(2)}" step="0.1"
                       oninput="setAreaLightPos(${i},'x',parseFloat(this.value)||0)">
                     <span class="sp-axis-label">Y:</span>
                     <input type="number" id="alight-y-${i}" class="sp-xyz-input" value="${pos.y.toFixed(2)}" step="0.1"
                       oninput="setAreaLightPos(${i},'y',parseFloat(this.value)||0)">
                     <span class="sp-axis-label">Z:</span>
                     <input type="number" id="alight-z-${i}" class="sp-xyz-input" value="${pos.z.toFixed(2)}" step="0.1"
                       oninput="setAreaLightPos(${i},'z',parseFloat(this.value)||0)">
                   </div>
                 </div>

                 <!-- 向き -->
                 <div>
                   <div style="font-size:10px;color:#888;margin-bottom:2px;">向き (deg) — X:上下 Y:左右 Z:ロール</div>
                   <div class="sp-xyz-row">
                     <span class="sp-axis-label">X:</span>
                     <input type="number" id="alight-rx-${i}" class="sp-xyz-input" value="${_rx.toFixed(1)}" step="5"
                       oninput="setAreaLightRotation(${i},'x',this.value)">
                     <span class="sp-axis-label">Y:</span>
                     <input type="number" id="alight-ry-${i}" class="sp-xyz-input" value="${_ry.toFixed(1)}" step="5"
                       oninput="setAreaLightRotation(${i},'y',this.value)">
                     <span class="sp-axis-label">Z:</span>
                     <input type="number" id="alight-rz-${i}" class="sp-xyz-input" value="${_rz.toFixed(1)}" step="5"
                       oninput="setAreaLightRotation(${i},'z',this.value)">
                   </div>
                 </div>

                 <!-- サイズ -->
                 <div>
                   <div style="font-size:10px;color:#888;margin-bottom:2px;">サイズ (幅 W / 高さ H)</div>
                   <div class="sp-xyz-row">
                     <span class="sp-axis-label">W:</span>
                     <input type="number" id="alight-w-${i}" class="sp-xyz-input" value="${_aw.toFixed(2)}" step="0.1" min="0.01"
                       oninput="setAreaLightSize(${i},'w',this.value)">
                     <span class="sp-axis-label">H:</span>
                     <input type="number" id="alight-h-${i}" class="sp-xyz-input" value="${_ah.toFixed(2)}" step="0.1" min="0.01"
                       oninput="setAreaLightSize(${i},'h',this.value)">
                   </div>
                 </div>

               </div>`
            : '';

        row.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                <span style="font-size:11px;color:#ffcc55;font-weight:bold;">${typeStr}</span>
                <label style="display:flex;align-items:center;gap:5px;font-size:10px;cursor:pointer;">
                    <input type="checkbox" ${!light.userData.manuallyOff ? 'checked' : ''} style="accent-color:#00ffcc;"
                        onchange="glbLights[${i}].userData.manuallyOff=!this.checked;applyGlbLightIntensities();">ON
                </label>
            </div>
            <div style="font-size:10px;color:#888;margin-bottom:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${baseName}</div>
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;font-size:10px;color:#aaa;">
                <span style="min-width:40px;">強度</span>
                <input type="range" min="0" max="${(light.isRectAreaLight || light.userData.isAreaLight) ? 30 : 10}" step="0.05" value="${base.toFixed(2)}"
                    style="flex:1;accent-color:#00ffcc;"
                    oninput="const _v=parseFloat(this.value);glbLights[${i}].userData.baseIntensity=_v;
                             applyGlbLightIntensities();
                             this.nextElementSibling.textContent=_v.toFixed(2);">
                <span style="min-width:28px;">${base.toFixed(2)}</span>
            </div>
            <div style="display:flex;align-items:center;gap:6px;font-size:10px;color:#aaa;">
                <span style="min-width:40px;">色</span>
                <input type="color" value="${colorHex}"
                    style="width:32px;height:22px;border:none;cursor:pointer;background:none;"
                    oninput="glbLights[${i}].color.set(this.value);if(glbLights[${i}].userData.mirrorLight)glbLights[${i}].userData.mirrorLight.color.set(this.value);">
            </div>
            ${extraRow}`;
        list.appendChild(row);
    });
}

