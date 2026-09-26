// 26-glow-emitters.js — 発光メッシュ（窓・灯具・天窓・看板）を面光源として扱う
//
// ════════════════════════════════════════════════════════════════
//  やりたいこと
// ════════════════════════════════════════════════════════════════
//  Blenderで「光る」マテリアルを貼った窓や灯具が、周りの甲板・壁・水面を
//  照らすようにする。点光源のように近くを明るくしつつ、面光源のように
//  柔らかく広がる光にしたい。
//
// ════════════════════════════════════════════════════════════════
//  やり方：発光面を「向き × 格子」でまとめてパネルにする
// ════════════════════════════════════════════════════════════════
//  発光メッシュの三角形を1枚ずつ見て、
//    ・向き : 法線がどの軸方向（±X / -Y / ±Z）に一番近いか
//    ・場所 : 船のローカル座標で、約 GLOW_CELL_METERS 四方の格子のどこか
//  の組でグループにまとめる。1グループが1枚の「発光パネル」になり、
//  グループの中心に、その向きを照らす面光源（25-area-lights.js）を置く。
//
//  こうすると、
//    ・窓が1枚ずつ別オブジェクトでも、何百枚が1つに結合（Join）されていても
//      同じ結果になる（以前は結合メッシュの扱いで何度も不具合が出ていた）
//    ・天窓のドームのように四方を向いた形は、面ごとに外向きのパネルに分かれ、
//      周りの甲板を四方へ照らす
//    ・並んだ灯具は近いもの同士が1枚のパネルにまとまり、光源の数が抑えられる
//  上向きの面（+Y）は空を照らすだけなので使わない。
//
//  光源の数が数百になっても、実際に点けるのはカメラに近い数灯だけ
//  （25-area-lights.js の枠の仕組み）なので、重さは灯数に比例しない。

// 格子の一辺[m]。灯具の間隔（数m）程度にしておくと、1灯具≒1パネルになる。
const GLOW_CELL_METERS = 6.0;
// パネルの最小サイズ[m]。灯具のような小さな発光体でも、周りを照らせる
// 程度の広がりを持たせる（小さすぎる面光源はほとんど光を出さない）。
const GLOW_MIN_PANEL_METERS = 1.0;
// これより面積[m²]の小さいグループは無視する（文字のかけら等のゴミ）
const GLOW_MIN_AREA_M2 = 0.004;
// パネルを発光面から浮かせる距離[m]。面そのものに置くと、灯具の枠などに
// 光が遮られて外に出てこないことがある。
const GLOW_SURFACE_OFFSET_M = 0.08;
// パネルの明るさ（RectAreaLightの輝度）の基準値。昼夜係数と
// 「窓の発光の強さ」スライダー（windowGlowMult）がこれに掛かる。
const GLOW_PANEL_LUMINANCE = 4.0;
// 船内全体を底上げする環境光プローブの強さ。あくまで「真っ暗を防ぐ」程度に
// 留める（強くすると外板まで一様に明るくなり、夜の船らしさが消える）。
const GLOW_PROBE_STRENGTH = 0.25;

let glowPanelNodes = [];
let glowHaloPoints = null;   // 遠景用の光のにじみ（全パネルを1回の描画で）

// 6方向のビン。+Y（上向き）は使わないので null。
const GLOW_BIN_DIRS = [
    new THREE.Vector3( 1, 0, 0), new THREE.Vector3(-1, 0, 0),
    null,                        new THREE.Vector3( 0, -1, 0),
    new THREE.Vector3( 0, 0, 1), new THREE.Vector3( 0, 0, -1),
];

function disposeGlowEmitters() {
    for (const n of glowPanelNodes) if (n.parent) n.parent.remove(n);
    glowPanelNodes = [];
    if (glowHaloPoints) {
        if (glowHaloPoints.parent) glowHaloPoints.parent.remove(glowHaloPoints);
        glowHaloPoints.geometry.dispose();
        glowHaloPoints.material.dispose();
        glowHaloPoints = null;
    }
    if (typeof setGlowAreaDefs === 'function') setGlowAreaDefs([]);
    if (windowGlowLightProbe && windowGlowLightProbe.parent) {
        windowGlowLightProbe.parent.remove(windowGlowLightProbe);
    }
    windowGlowLightProbe = null;
}

// 発光マテリアルの平均色から、照らす光の色を決める。
// ほぼ白〜暖色の明るい発光は、電球色として扱う（白い窓ガラスの発光色を
// そのまま使うと、蛍光灯のような青白い光になって船の雰囲気に合わない）。
function _glowLightColor(r, g, b) {
    const lum = r * 0.299 + g * 0.587 + b * 0.114;
    if (lum > 0.45 && r >= b) return new THREE.Color(1.0, 0.82, 0.55);
    const m = Math.max(r, g, b, 1e-6);
    return new THREE.Color(r / m, g / m, b / m);
}

// 発光メッシュの三角形を、向き×格子のグループに集計する。
// 座標はすべて modelRoot のローカル座標（＝モデルの向き・拡縮を除いた座標）。
// 戻り値: Map<key, {bin, area, sx,sy,sz, min:Vector3, max:Vector3, r,g,b}>
function _glowCollectGroups(modelRoot, entries, metersPerUnit) {
    const invRoot = new THREE.Matrix4().copy(modelRoot.matrixWorld).invert();
    const M = new THREE.Matrix4();
    const cellLocal = GLOW_CELL_METERS / metersPerUnit;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), n = new THREE.Vector3();
    const groups = new Map();
    const glowMatSet = new Set(windowGlowMaterials);

    for (const { mesh } of entries) {
        if (!mesh.parent || !mesh.geometry) continue;
        const geom = mesh.geometry;
        const pos = geom.attributes && geom.attributes.position;
        if (!pos) continue;
        mesh.updateWorldMatrix(true, false);
        M.multiplyMatrices(invRoot, mesh.matrixWorld);
        // 鏡像変換（Blenderの "mirrored" 書き出し等）では三角形の巻きが逆になり、
        // 外積で求めた法線が裏返る。行列式の符号で打ち消す。
        const flip = M.determinant() < 0 ? -1 : 1;

        // 複数マテリアルのメッシュでは、発光マテリアルの範囲の三角形だけを使う
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        const ranges = [];
        const idx = geom.index ? geom.index.array : null;
        const triCount = (idx ? idx.length : pos.count) / 3 | 0;
        if (Array.isArray(mesh.material) && geom.groups && geom.groups.length) {
            geom.groups.forEach((g) => {
                if (glowMatSet.has(mats[g.materialIndex])) {
                    ranges.push([g.start / 3 | 0, Math.min(triCount, (g.start + g.count) / 3 | 0)]);
                }
            });
        } else {
            ranges.push([0, triCount]);
        }

        const col = (mats.find(m => glowMatSet.has(m)) || mats[0]).emissive || new THREE.Color(1, 1, 1);

        for (const [t0, t1] of ranges) {
            for (let t = t0; t < t1; t++) {
                const i0 = idx ? idx[t * 3] : t * 3;
                const i1 = idx ? idx[t * 3 + 1] : t * 3 + 1;
                const i2 = idx ? idx[t * 3 + 2] : t * 3 + 2;
                a.fromBufferAttribute(pos, i0).applyMatrix4(M);
                b.fromBufferAttribute(pos, i1).applyMatrix4(M);
                c.fromBufferAttribute(pos, i2).applyMatrix4(M);
                e1.subVectors(b, a); e2.subVectors(c, a);
                n.crossVectors(e1, e2);
                const len = n.length();
                if (len < 1e-12) continue;
                const area = len * 0.5;
                n.multiplyScalar(flip / len);

                // 法線がいちばん近い軸方向
                const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
                let bin;
                if (ax >= ay && ax >= az) bin = n.x >= 0 ? 0 : 1;
                else if (ay >= az)        bin = n.y >= 0 ? 2 : 3;
                else                      bin = n.z >= 0 ? 4 : 5;
                if (!GLOW_BIN_DIRS[bin]) continue;   // 上向きは空を照らすだけなので捨てる

                const cx = (a.x + b.x + c.x) / 3, cy = (a.y + b.y + c.y) / 3, cz = (a.z + b.z + c.z) / 3;
                const cell = Math.floor(cx / cellLocal) + '|' + Math.floor(cy / cellLocal) + '|' + Math.floor(cz / cellLocal);
                const key = bin + '|' + cell;
                let g = groups.get(key);
                if (!g) {
                    g = { bin, cell, area: 0, sx: 0, sy: 0, sz: 0, r: 0, g: 0, b: 0,
                          min: new THREE.Vector3(Infinity, Infinity, Infinity),
                          max: new THREE.Vector3(-Infinity, -Infinity, -Infinity) };
                    groups.set(key, g);
                }
                g.area += area;
                g.sx += cx * area; g.sy += cy * area; g.sz += cz * area;
                g.r += col.r * area; g.g += col.g * area; g.b += col.b * area;
                g.min.min(a).min(b).min(c);
                g.max.max(a).max(b).max(c);
            }
        }
    }
    return groups;
}

// 格子1マスの中のグループを整理する。
//  ・マス内の発光体が小さい（GLOW_POINTLIKE_METERS 未満）なら、灯具のような
//    「点に近い光源」とみなし、真下を照らすパネル1枚にまとめる。小さな
//    円筒形の灯具は側面・底面がそれぞれ別の向きのグループになるが、それを
//    全部パネルにすると、カメラの近くの枠が1個の灯具の各面で埋まってしまう。
//  ・大きいもの（窓の列・天窓など）は向きごとのパネルを残すが、マス内で一番
//    大きい向きの GLOW_MINOR_BIN_RATIO 未満しかない向きは、縁や厚みの
//    部分とみなして捨てる。
const GLOW_POINTLIKE_METERS = 1.2;
const GLOW_MINOR_BIN_RATIO = 0.15;
function _glowMergeCells(groups, metersPerUnit) {
    const cells = new Map();
    groups.forEach((g) => {
        let c = cells.get(g.cell);
        if (!c) { c = []; cells.set(g.cell, c); }
        c.push(g);
    });
    const out = [];
    cells.forEach((list) => {
        const min = new THREE.Vector3(Infinity, Infinity, Infinity);
        const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
        let maxArea = 0;
        list.forEach((g) => { min.min(g.min); max.max(g.max); maxArea = Math.max(maxArea, g.area); });
        const extentM = Math.max(max.x - min.x, max.y - min.y, max.z - min.z) * metersPerUnit;
        if (extentM < GLOW_POINTLIKE_METERS) {
            const m = { bin: 3, cell: list[0].cell, area: 0, sx: 0, sy: 0, sz: 0, r: 0, g: 0, b: 0,
                        min: min.clone(), max: max.clone() };
            list.forEach((g) => {
                m.area += g.area; m.sx += g.sx; m.sy += g.sy; m.sz += g.sz;
                m.r += g.r; m.g += g.g; m.b += g.b;
            });
            // 真下を照らすので、パネルは発光体の底面に置く
            m.sy = min.y * m.area;
            out.push(m);
        } else {
            list.forEach((g) => { if (g.area >= maxArea * GLOW_MINOR_BIN_RATIO) out.push(g); });
        }
    });
    return out;
}

// モデル読み込み後（ワールド行列が確定してから）に1回呼ぶ。
function buildGlowEmitters() {
    disposeGlowEmitters();
    const modelRoot = (typeof importedModelGroup !== 'undefined' && importedModelGroup)
        ? importedModelGroup.children[0] : null;
    if (!modelRoot || !windowGlowMeshEntries || windowGlowMeshEntries.length === 0) return [];

    modelRoot.updateWorldMatrix(true, true);
    // modelRoot の1単位が何mか（船全体は一様に拡縮される）
    const metersPerUnit = new THREE.Vector3().setFromMatrixScale(modelRoot.matrixWorld).x || 1;
    const groups = _glowMergeCells(_glowCollectGroups(modelRoot, windowGlowMeshEntries, metersPerUnit), metersPerUnit);

    const up = new THREE.Vector3(0, 1, 0);
    const axX = new THREE.Vector3(), axZ = new THREE.Vector3(), size = new THREE.Vector3();
    const minLocal = GLOW_MIN_PANEL_METERS / metersPerUnit;
    const maxLocal = GLOW_CELL_METERS / metersPerUnit;
    const minArea = GLOW_MIN_AREA_M2 / (metersPerUnit * metersPerUnit);

    const panels = [];
    const probePts = [];
    let pr = 0, pg = 0, pb = 0, pArea = 0;
    groups.forEach((g) => {
        if (g.area < minArea) return;
        const dir = GLOW_BIN_DIRS[g.bin];
        const center = new THREE.Vector3(g.sx / g.area, g.sy / g.area, g.sz / g.area);

        // パネルの向き：ローカル+Y が照らす方向を向くように回す
        const q = new THREE.Quaternion().setFromUnitVectors(up, dir);
        axX.set(1, 0, 0).applyQuaternion(q);
        axZ.set(0, 0, 1).applyQuaternion(q);
        size.subVectors(g.max, g.min);
        // 回した軸に沿った発光面の広がり（軸は座標軸のどれかと平行なので、成分の絶対値で取れる）
        const w = Math.abs(axX.x) * size.x + Math.abs(axX.y) * size.y + Math.abs(axX.z) * size.z;
        const h = Math.abs(axZ.x) * size.x + Math.abs(axZ.y) * size.y + Math.abs(axZ.z) * size.z;

        const node = new THREE.Object3D();
        node.name = 'GlowPanel';
        node.position.copy(center).addScaledVector(dir, GLOW_SURFACE_OFFSET_M / metersPerUnit);
        node.quaternion.copy(q);
        node.scale.set(THREE.MathUtils.clamp(w, minLocal, maxLocal), 1,
                       THREE.MathUtils.clamp(h, minLocal, maxLocal));
        modelRoot.add(node);
        glowPanelNodes.push(node);

        const color = _glowLightColor(g.r / g.area, g.g / g.area, g.b / g.area);
        panels.push({ node, color, weight: 1 });

        probePts.push({ p: center.clone(), w: g.area });
        pr += color.r * g.area; pg += color.g * g.area; pb += color.b * g.area; pArea += g.area;
    });

    if (typeof setGlowAreaDefs === 'function') setGlowAreaDefs(panels);
    _glowBuildHalos(modelRoot, panels);
    _glowBuildProbe(modelRoot, probePts, pArea > 0 ? new THREE.Color(pr / pArea, pg / pArea, pb / pArea) : null);
    console.log(`[GlowEmitters] 発光パネル ${panels.length} 枚（発光メッシュ ${windowGlowMeshEntries.length} 個から）`);
    return panels;
}

// 船内全体をほんのり底上げする環境光（球面調和ライトプローブ）。
// 面光源は近くの数灯しか点けないので、遠くの窓際が真っ暗にならないよう、
// 発光パネルの分布を1回だけSH係数に焼き込んでおく。影は持たないが、
// 1個の係数セットを全マテリアルが共有するだけなので非常に軽い。
const _GLOW_SH_BASIS = [
    () => 0.282095,
    (x, y, z) => 0.488603 * y,
    (x, y, z) => 0.488603 * z,
    (x, y, z) => 0.488603 * x,
    (x, y, z) => 1.092548 * x * y,
    (x, y, z) => 1.092548 * y * z,
    (x, y, z) => 0.315392 * (3 * z * z - 1),
    (x, y, z) => 1.092548 * x * z,
    (x, y, z) => 0.546274 * (x * x - y * y),
];
function _glowBuildProbe(modelRoot, pts, color) {
    if (!color || pts.length === 0) return;
    const origin = new THREE.Vector3();
    let wsum = 0;
    pts.forEach(({ p, w }) => { origin.addScaledVector(p, w); wsum += w; });
    origin.multiplyScalar(1 / wsum);

    const coeffs = [];
    for (let i = 0; i < 9; i++) coeffs.push(new THREE.Vector3());
    const dir = new THREE.Vector3();
    // 各パネルを「その方向から光が来る」1サンプルとし、面積で重み付けする。
    // 全体の明るさがパネル数に左右されないよう、面積の合計で正規化する。
    pts.forEach(({ p, w }) => {
        dir.subVectors(p, origin);
        const d = dir.length();
        if (d < 1e-6) return;
        dir.multiplyScalar(1 / d);
        const k = GLOW_PROBE_STRENGTH * w / wsum;
        for (let i = 0; i < 9; i++) {
            const basis = _GLOW_SH_BASIS[i](dir.x, dir.y, dir.z) * k;
            coeffs[i].x += color.r * basis;
            coeffs[i].y += color.g * basis;
            coeffs[i].z += color.b * basis;
        }
    });

    windowGlowLightProbe = new THREE.LightProbe();
    windowGlowLightProbe.position.copy(origin);
    for (let i = 0; i < 9; i++) windowGlowLightProbe.sh.coefficients[i].copy(coeffs[i]);
    windowGlowLightProbe.intensity = 0;   // updateWindowGlow() が昼夜係数で設定する
    modelRoot.add(windowGlowLightProbe);
}

// ════════════════════════════════════════════════════════════════
//  遠景用の「光のにじみ」
// ════════════════════════════════════════════════════════════════
// 実際に周りを照らす面光源は、負荷の都合でカメラに近い数灯しか点けられない。
// 離れて船を眺めると、点いていない窓・灯具は発光マテリアルが光るだけで、
// 「灯りがともっている」感じが出にくい。
// そこで全パネルの位置に、加算合成の光点（ポイントスプライト）を置く。
//   ・1回の描画で全パネル分を描くので、数百個あってもほぼ負荷にならない
//   ・近くでは本物の面光源に任せてフェードアウトし、離れるほど見えてくる
//   ・霧・雨のときは大きくにじませ、灯りが空気中の水滴を照らして
//     光の玉ができる感じを出す（24-weather.js の haze / 雨量を使う）
//   ・霧も雨も無いときは、近〜中距離ではほとんど出さない（澄んだ空気では
//     灯りはにじまない）。ずっと遠くの船を眺めたときの「灯っている点」だけ残す
//
//  【隠れるかどうかの判定】にじみは空気が光っているもので、船体の表面に
//  貼り付いているわけではない。画素ごとに船体と奥行きを比べると、スプライト
//  （四角い板）が船体の曲面に切られて、船体の辺に沿った線が見えてしまう。
//  そこで画素ごとの比較はせず、**灯りの中心（とその周り4点）**について、
//  カメラとの間に壁などがあるかを、ブルーム抽出パスが描いたシーンの奥行き
//  （下の _haloDepthPass：船だけの奥行きを1/4の解像度で描いたもの）で調べ、
//  にじみ全体を出す／隠す。
//  あわせて「その灯りの面がカメラの方を向いているか」でも隠す。
//  （ブルームを切っていて奥行きが無いときは、画素ごとの比較に戻す）
const GLOW_HALO_SIZE_MUL   = 1.8;   // パネルの大きさに対するにじみの大きさ
const GLOW_HALO_MIN_M      = 2.5;   // にじみの最小サイズ[m]
const GLOW_HALO_MAX_M      = 14.0;  // にじみの最大サイズ[m]
const GLOW_HALO_FADE_NEAR  = 25.0;  // これより近いと見えない[m]（本物の面光源に任せる）
const GLOW_HALO_FADE_FAR   = 90.0;  // これより遠いと完全に見える[m]
const GLOW_HALO_STRENGTH   = 0.55;
const GLOW_HALO_DRY_NEAR   = 300.0; // 霧・雨が無いとき、これより近いにじみは出さない[m]
const GLOW_HALO_DRY_FAR    = 700.0; // 霧・雨が無いとき、これより遠いと遠景用の点として見える[m]

function _glowBuildHalos(modelRoot, panels) {
    if (!panels.length) return;
    const n = panels.length;
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n);
    const nrm = new Float32Array(n * 3);   // 灯りの面の向き（カメラの方を向いているか見るため）
    const dir = new THREE.Vector3();
    const metersPerUnit = new THREE.Vector3().setFromMatrixScale(modelRoot.matrixWorld).x || 1;
    panels.forEach((p, i) => {
        const node = p.node;
        // 発光面から少し前に出す（壁にめり込んで半分隠れないように）
        dir.set(0, 1, 0).applyQuaternion(node.quaternion);
        pos[i * 3]     = node.position.x + dir.x * (0.3 / metersPerUnit);
        pos[i * 3 + 1] = node.position.y + dir.y * (0.3 / metersPerUnit);
        pos[i * 3 + 2] = node.position.z + dir.z * (0.3 / metersPerUnit);
        nrm[i * 3] = dir.x; nrm[i * 3 + 1] = dir.y; nrm[i * 3 + 2] = dir.z;
        col[i * 3] = p.color.r; col[i * 3 + 1] = p.color.g; col[i * 3 + 2] = p.color.b;
        const sizeM = Math.max(node.scale.x, node.scale.z) * metersPerUnit * GLOW_HALO_SIZE_MUL;
        size[i] = THREE.MathUtils.clamp(sizeM, GLOW_HALO_MIN_M, GLOW_HALO_MAX_M);   // m
    });
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geom.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geom.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geom.setAttribute('aNormal', new THREE.BufferAttribute(nrm, 3));
    const mat = new THREE.ShaderMaterial({
        uniforms: {
            uStrength:   { value: 0 },
            uPixelScale: { value: 500 },
            uNear:       { value: GLOW_HALO_FADE_NEAR },
            uFar:        { value: GLOW_HALO_FADE_FAR },
            uSizeMul:    { value: 1 },
            uMinPx:      { value: 6 },
            uFogDensity: { value: 0 },
            uWet:        { value: 0 },    // 霧・雨の度合い（0〜1）
            uDryNear:    { value: GLOW_HALO_DRY_NEAR },
            uDryFar:     { value: GLOW_HALO_DRY_FAR },
            uSceneDepth: { value: null },
            uHasDepth:   { value: 0 },
            uInvViewport:{ value: new THREE.Vector2(1 / 800, 1 / 600) },
        },
        vertexShader: `
            attribute vec3 aColor;
            attribute float aSize;
            attribute vec3 aNormal;
            uniform float uStrength, uPixelScale, uNear, uFar, uSizeMul, uMinPx, uFogDensity;
            uniform float uWet, uDryNear, uDryFar;
            uniform sampler2D uSceneDepth;
            uniform float uHasDepth;
            uniform vec2 uInvViewport;
            varying vec3 vColor;
            varying float vAlpha;
            #ifdef USE_LOGDEPTHBUF
                uniform float logDepthBufFC;
                // シーンの奥行き（対数深度）→ カメラからの距離
                float sceneDistAt(vec2 uv) {
                    float d = texture2D(uSceneDepth, uv).r;
                    return exp2(d * 2.0 / logDepthBufFC) - 1.0;
                }
            #endif
            void main() {
                vec4 mv = modelViewMatrix * vec4(position, 1.0);
                float dist = max(0.1, -mv.z);
                gl_Position = projectionMatrix * mv;
                // 遠くでも「灯りがともっている」と分かるよう、見た目の大きさに下限を設ける
                // （実寸どおりだと400m先の灯具は3ピクセルほどで、ほとんど見えない）
                float px = aSize * uSizeMul * uPixelScale / dist;
                gl_PointSize = clamp(px, uMinPx, 256.0);
                vColor = aColor;
                // 下限で大きく見せているぶん、少しだけ明るさを抑える
                vAlpha = uStrength * smoothstep(uNear, uFar, dist) * mix(0.75, 1.0, clamp(px / uMinPx - 1.0, 0.0, 1.0));
                // 霧が濃いと、遠くの灯りのにじみも霧に溶けて薄れる（船体と同じ FogExp2 の
                // 式を少し弱めて使う：にじみ自体が霧の光なので、船体ほどは消えない）
                float fd = dist * uFogDensity * 0.35;
                vAlpha *= exp(-fd * fd);
                // 霧・雨が無いときは、遠景用の点としてだけ出す
                vAlpha *= mix(smoothstep(uDryNear, uDryFar, dist), 1.0, uWet);
                // 灯りの面がカメラの方を向いていないもの（船の向こう側の窓など）は出さない
                vec4 wp = modelMatrix * vec4(position, 1.0);
                vec3 wn = normalize(mat3(modelMatrix) * aNormal);
                float facing = dot(wn, normalize(cameraPosition - wp.xyz));
                vAlpha *= smoothstep(-0.05, 0.3, facing);
                // 灯りとカメラの間に壁などがあれば隠す（中心とその周り4点で調べ、
                // 隠れている割合だけ薄くする）
                #ifdef USE_LOGDEPTHBUF
                if (uHasDepth > 0.5 && vAlpha > 0.0) {
                    vec2 uv = gl_Position.xy / gl_Position.w * 0.5 + 0.5;
                    if (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0) {
                        // 灯具の枠など、灯りのすぐ手前にある物では隠さない余裕
                        float lim = dist - (0.6 + dist * 0.004);
                        vec2 o = uInvViewport * gl_PointSize * 0.22;
                        float vis = step(lim, sceneDistAt(uv))
                                  + step(lim, sceneDistAt(uv + vec2(o.x, 0.0)))
                                  + step(lim, sceneDistAt(uv - vec2(o.x, 0.0)))
                                  + step(lim, sceneDistAt(uv + vec2(0.0, o.y)))
                                  + step(lim, sceneDistAt(uv - vec2(0.0, o.y)));
                        vAlpha *= vis / 5.0;
                    }
                }
                #endif
            }`,
        fragmentShader: `
            varying vec3 vColor;
            varying float vAlpha;
            void main() {
                vec2 c = gl_PointCoord - 0.5;
                float r2 = dot(c, c) * 4.0;           // 0（中心）〜1（縁）
                if (r2 > 1.0) discard;
                // 中心の芯＋ふんわりした裾
                float a = exp(-r2 * 9.0) * 1.1 + exp(-r2 * 2.2) * 0.35;
                a *= (1.0 - r2);
                gl_FragColor = vec4(vColor * a * vAlpha, 1.0);
            }`,
        transparent: true,
        depthWrite: false,
        depthTest: false,   // 画素ごとの奥行き比較はしない（上の説明。中心で隠れるか調べる）
        blending: THREE.AdditiveBlending,
    });
    glowHaloPoints = new THREE.Points(geom, mat);
    glowHaloPoints.name = 'GlowHalos';
    glowHaloPoints.frustumCulled = false;
    glowHaloPoints.renderOrder = 5;
    glowHaloPoints.userData.noBloom = true;   // 既に柔らかい光なので、ブルームで二重ににじませない
    modelRoot.add(glowHaloPoints);
}

// ── にじみの隠れ判定用：船の奥行きだけを小さく描く ─────────────────
// 船のメッシュだけを専用のレイヤーに入れ、色を書かない材質で 1/4 の解像度の
// 画像に描いて、その奥行きをテクスチャとして使う。にじみが見えている間だけ、
// 2フレームに1回描く（シーン全体を描き直すブルームよりずっと軽い）。
const HALO_DEPTH_LAYER = 7;
const _haloDepth = { rt: null, mat: null, key: '', frame: 0, w: 0, h: 0 };
function _haloDepthPass() {
    if (typeof renderer === 'undefined' || !renderer || typeof camera === 'undefined' || !camera) return null;
    if (!renderer.capabilities.isWebGL2 && !renderer.extensions.get('WEBGL_depth_texture')) return null;
    const root = (typeof importedModelGroup !== 'undefined' && importedModelGroup) ? importedModelGroup : null;
    if (!root) return null;
    // 船のメッシュをレイヤーに入れる（モデルが変わったら入れ直す）
    let n = 0; root.traverse(o => { if (o.isMesh) n++; });
    const key = root.uuid + ':' + n;
    if (key !== _haloDepth.key) {
        _haloDepth.key = key;
        root.traverse(o => { if (o.isMesh) o.layers.enable(HALO_DEPTH_LAYER); });
    }
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const w = Math.max(64, Math.floor(size.x / 4)), h = Math.max(64, Math.floor(size.y / 4));
    if (!_haloDepth.rt || _haloDepth.w !== w || _haloDepth.h !== h) {
        if (_haloDepth.rt) _haloDepth.rt.dispose();
        const rt = new THREE.WebGLRenderTarget(w, h, { depthBuffer: true });
        rt.depthTexture = new THREE.DepthTexture(w, h);
        rt.depthTexture.format = THREE.DepthFormat;
        rt.depthTexture.type = renderer.capabilities.isWebGL2 ? THREE.UnsignedIntType : THREE.UnsignedShortType;
        _haloDepth.rt = rt; _haloDepth.w = w; _haloDepth.h = h;
        _haloDepth.frame = 0;
    }
    if (!_haloDepth.mat) _haloDepth.mat = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });
    if ((_haloDepth.frame++ & 1) === 0) {
        const prevTarget = renderer.getRenderTarget();
        const prevOverride = scene.overrideMaterial;
        const prevMask = camera.layers.mask;
        const prevShadow = renderer.shadowMap.autoUpdate, prevNeeds = renderer.shadowMap.needsUpdate;
        const prevBg = scene.background;
        scene.overrideMaterial = _haloDepth.mat;
        scene.background = null;
        camera.layers.set(HALO_DEPTH_LAYER);
        renderer.shadowMap.autoUpdate = false; renderer.shadowMap.needsUpdate = false;
        renderer.setRenderTarget(_haloDepth.rt);
        renderer.clear(true, true, false);
        renderer.render(scene, camera);
        renderer.setRenderTarget(prevTarget);
        camera.layers.mask = prevMask;
        scene.overrideMaterial = prevOverride;
        scene.background = prevBg;
        renderer.shadowMap.autoUpdate = prevShadow; renderer.shadowMap.needsUpdate = prevNeeds;
    }
    return _haloDepth.rt.depthTexture;
}

// 毎フレーム（描画の直前）。昼夜・窓の発光の強さ・天候に合わせる。
function updateGlowHalos() {
    if (!glowHaloPoints) return;
    const u = glowHaloPoints.material.uniforms;
    const glow = (typeof _alGlowFactor !== 'undefined') ? _alGlowFactor : 0;
    // 霧・雨のときは、灯りが空気中の水滴を照らしてにじみが大きく・明るくなる
    const w = window.weather;
    const haze = (w && w.enabled) ? Math.max(0, (w.haze || 1) - 1) : 0;         // 晴れ0 〜 嵐≒2.8
    const rain = (w && w.enabled && typeof w.rain === 'number') ? w.rain : 0;    // 0〜1
    const fog  = (w && w.enabled && typeof w.fog === 'number') ? w.fog : 0;      // 0〜1
    // 船内（34-shelter.js）では、室内の空気は霧っていないのでにじませない
    const wet = Math.min(1.5, haze * 0.25 + rain * 0.6 + fog * 1.0) * (1 - (window.shelterIndoor || 0));
    // にじみが大きくなるぶん面積で明るく見えるので、1点あたりの明るさはほぼ据え置く
    // （以前は大きさ2.8倍×明るさ2.4倍で、霧の中ではまぶしすぎた）
    u.uStrength.value = glow * GLOW_HALO_STRENGTH * (1 + wet * 0.2);
    u.uSizeMul.value = 1 + wet * 0.9;
    u.uFogDensity.value = (typeof scene !== 'undefined' && scene && scene.fog && scene.fog.density) ? scene.fog.density : 0;
    u.uWet.value = THREE.MathUtils.smoothstep(wet, 0.05, 0.6);
    // シーンの奥行き（ブルーム抽出パス）があれば、それで隠れるかを調べる。
    // 無いとき（ブルームOFF）は画素ごとの奥行き比較に戻す。
    const depthTex = glowHaloPoints.visible ? _haloDepthPass() : null;
    u.uSceneDepth.value = depthTex;
    u.uHasDepth.value = depthTex ? 1 : 0;
    if (glowHaloPoints.material.depthTest !== !depthTex) {
        glowHaloPoints.material.depthTest = !depthTex;
    }
    if (typeof renderer !== 'undefined' && renderer) {
        const hPx = renderer.domElement.height, wPx = renderer.domElement.width;
        u.uInvViewport.value.set(1 / Math.max(1, wPx), 1 / Math.max(1, hPx));
    }
    // 水中からは見えない（水面の上の空気が光っているものなので）
    if ((window.underwaterAmount || 0) > 0.5) u.uStrength.value = 0;
    // 霧の中では近くでもにじみが見える
    u.uNear.value = GLOW_HALO_FADE_NEAR * (1 - Math.min(0.85, wet * 0.6));
    u.uFar.value  = GLOW_HALO_FADE_FAR  * (1 - Math.min(0.6, wet * 0.4));
    glowHaloPoints.visible = u.uStrength.value > 0.003;
    // 画面の高さ[px] ÷ (2·tan(視野角/2)) … 距離1mで1mの物が何pxになるか
    if (typeof camera !== 'undefined' && camera && camera.isPerspectiveCamera && typeof renderer !== 'undefined') {
        const hPx = renderer.domElement.height;
        u.uPixelScale.value = hPx / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
        u.uMinPx.value = 6 * Math.max(1, renderer.getPixelRatio());
    }
    // aSize は m 単位、距離もビュー空間（ワールド単位）で測るので、
    // 船体設定で船の拡大率を変えても補正は要らない。
}
