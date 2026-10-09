// 34-shelter.js — 船内・屋根の下では雨を降らせず、霧を薄くする
//
// ════════════════════════════════════════════════════════════════
//  やりたいこと
// ════════════════════════════════════════════════════════════════
//  雨はカメラのまわりの箱の中に降らせているので、船内や屋根付きの遊歩甲板に
//  いても雨筋が見えていた。霧も場面全体に一様に掛かるので、長い船室の中が
//  白っぽく霞んだり、室内の灯りが霧でにじんだりしていた。
//
// ════════════════════════════════════════════════════════════════
//  やり方：船の「屋根の高さ地図」を作る
// ════════════════════════════════════════════════════════════════
//  モデルを読み込んだら一度だけ、船を真上から見たときの「いちばん上の
//  水平な面（甲板・屋根）の高さ」を、船に固定した座標の格子に記録する。
//    ・雨粒は、その場所の屋根より下にあれば描かない（雨のシェーダーで判定）。
//      屋根の外（舷側の外の海の上など）の雨は、窓や開いた側面から見える
//    ・カメラの真上に屋根があり、まわりもほとんど屋根に覆われていれば
//      「船内」とみなし、霧を薄くし、灯りの霧のにじみを出さない
//  格子の中心点が三角形に入るかで調べるので、ロープや細い支柱のような
//  細い物は屋根とみなされにくい。船は剛体なので、船が揺れても地図は
//  そのまま使える（船の行列で座標を変換するだけ）。
//  大きなモデルでも画面が止まらないよう、作るのは数フレームに分けて行う。

const SHELTER_MAX_CELLS = 320;     // 長い方向の格子の数の上限
const SHELTER_MIN_CELL_M = 0.4;    // 格子の最小の大きさ[m]
const SHELTER_MIN_NY = 0.3;        // これより傾いた面（壁など）は屋根に数えない
const SHELTER_FOG_CUT = 0.8;       // 船内で霧をどれだけ薄くするか（1で完全に無し）
const SHELTER_EMPTY = -1.0e4;      // 屋根の無い格子の値
const SHELTER_BUILD_BUDGET_MS = 6; // 1フレームあたりの地図作りの時間

const shelterUniforms = {
    uRoofTex: { value: null },
    uRoofInv: { value: new THREE.Matrix4() },   // ワールド → 船の座標
    uRoofMin: { value: new THREE.Vector2() },   // 格子の端（船の座標の x, z）
    uRoofExt: { value: new THREE.Vector2(1, 1) },// 格子全体の大きさ
    uRoofOn:  { value: 0 },
};
window.shelterUniforms = shelterUniforms;
window.shelterIndoor = 0;   // 0（屋外）〜1（船内）

const shelter = {
    key: null, data: null, nx: 0, nz: 0, minX: 0, minZ: 0, cell: 1,
    gen: null, pendingKey: null, keyCheckAt: 0, lastT: -1,
};
const _shInv = new THREE.Matrix4();
const _shRel = new THREE.Matrix4();
const _shV = new THREE.Vector3();

// 地図を作り直すべきかの目印：モデルと、船に対するモデルの置き方
// （置き方は数で持って、ごくわずかな差は同じとみなす。文字にして比べると
//   計算の誤差で 0.000 と -0.000 が入れ替わり、毎秒作り直してしまっていた）
function _shelterKey() {
    if (typeof importedModelGroup === 'undefined' || !importedModelGroup || !shipGroup) return null;
    shipGroup.updateWorldMatrix(true, false);
    importedModelGroup.updateWorldMatrix(true, false);
    _shRel.copy(shipGroup.matrixWorld).invert().multiply(importedModelGroup.matrixWorld);
    let n = 0;
    importedModelGroup.traverse((o) => { if (o.isMesh) n++; });
    return { id: importedModelGroup.uuid + ':' + n, m: _shRel.elements.slice() };
}
function _shelterKeySame(a, b) {
    if (!a || !b || a.id !== b.id) return false;
    for (let i = 0; i < 16; i++) if (Math.abs(a.m[i] - b.m[i]) > 2e-3) return false;
    return true;
}

// 地図作り（少しずつ進める）
function* _shelterBuild() {
    shipGroup.updateWorldMatrix(true, false);
    importedModelGroup.updateWorldMatrix(true, true);
    _shInv.copy(shipGroup.matrixWorld).invert();
    const meshes = [];
    importedModelGroup.traverse((o) => {
        if (o.isMesh && o.visible && o.geometry && o.geometry.attributes.position) meshes.push(o);
    });
    // 船の座標での大きさ
    // （数フレームに分けて進めるので、他と共有する作業用の行列は使わない）
    const inv = new THREE.Matrix4().copy(_shInv);
    const rel = new THREE.Matrix4();
    const box = new THREE.Box3(), b = new THREE.Box3();
    for (const m of meshes) {
        if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
        b.copy(m.geometry.boundingBox).applyMatrix4(rel.multiplyMatrices(inv, m.matrixWorld));
        box.union(b);
    }
    if (box.isEmpty()) return null;
    const scaleW = new THREE.Vector3().setFromMatrixScale(shipGroup.matrixWorld).x || 1;
    const span = Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
    const cell = Math.max(SHELTER_MIN_CELL_M / scaleW, span / SHELTER_MAX_CELLS);
    const nx = Math.max(2, Math.ceil((box.max.x - box.min.x) / cell) + 2);
    const nz = Math.max(2, Math.ceil((box.max.z - box.min.z) / cell) + 2);
    const minX = box.min.x - cell, minZ = box.min.z - cell;
    const h = new Float32Array(nx * nz).fill(SHELTER_EMPTY);

    const a = new THREE.Vector3(), c = new THREE.Vector3(), d = new THREE.Vector3();
    const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), nrm = new THREE.Vector3();
    let work = 0;
    for (const m of meshes) {
        const pos = m.geometry.attributes.position;
        const idx = m.geometry.index;
        const triCount = idx ? idx.count / 3 : pos.count / 3;
        rel.multiplyMatrices(inv, m.matrixWorld);
        for (let t = 0; t < triCount; t++) {
            const i0 = idx ? idx.getX(t * 3) : t * 3;
            const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
            const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
            a.fromBufferAttribute(pos, i0).applyMatrix4(rel);
            c.fromBufferAttribute(pos, i1).applyMatrix4(rel);
            d.fromBufferAttribute(pos, i2).applyMatrix4(rel);
            e1.subVectors(c, a); e2.subVectors(d, a);
            nrm.crossVectors(e1, e2);
            const len = nrm.length();
            if (len < 1e-12 || Math.abs(nrm.y) / len < SHELTER_MIN_NY) continue;
            // xz 平面での三角形に入る格子の中心を調べる
            const x0 = Math.max(0, Math.ceil((Math.min(a.x, c.x, d.x) - minX) / cell - 0.5));
            const x1 = Math.min(nx - 1, Math.floor((Math.max(a.x, c.x, d.x) - minX) / cell - 0.5));
            const z0 = Math.max(0, Math.ceil((Math.min(a.z, c.z, d.z) - minZ) / cell - 0.5));
            const z1 = Math.min(nz - 1, Math.floor((Math.max(a.z, c.z, d.z) - minZ) / cell - 0.5));
            if (x1 < x0 || z1 < z0) continue;
            const den = (c.z - d.z) * (a.x - d.x) + (d.x - c.x) * (a.z - d.z);
            if (Math.abs(den) < 1e-12) continue;
            for (let iz = z0; iz <= z1; iz++) {
                const pz = minZ + (iz + 0.5) * cell;
                for (let ix = x0; ix <= x1; ix++) {
                    const px = minX + (ix + 0.5) * cell;
                    const w0 = ((c.z - d.z) * (px - d.x) + (d.x - c.x) * (pz - d.z)) / den;
                    const w1 = ((d.z - a.z) * (px - d.x) + (a.x - d.x) * (pz - d.z)) / den;
                    const w2 = 1 - w0 - w1;
                    if (w0 < 0 || w1 < 0 || w2 < 0) continue;
                    const y = w0 * a.y + w1 * c.y + w2 * d.y;
                    const k = iz * nx + ix;
                    if (y > h[k]) h[k] = y;
                }
            }
            if (++work % 4000 === 0) yield;
        }
    }
    return { h, nx, nz, minX, minZ, cell };
}

function _shelterInstall(res) {
    shelter.data = res.h; shelter.nx = res.nx; shelter.nz = res.nz;
    shelter.minX = res.minX; shelter.minZ = res.minZ; shelter.cell = res.cell;
    const rgba = new Float32Array(res.nx * res.nz * 4);
    for (let i = 0; i < res.h.length; i++) rgba[i * 4] = res.h[i];
    if (shelterUniforms.uRoofTex.value) shelterUniforms.uRoofTex.value.dispose();
    const tex = new THREE.DataTexture(rgba, res.nx, res.nz, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    shelterUniforms.uRoofTex.value = tex;
    shelterUniforms.uRoofMin.value.set(res.minX, res.minZ);
    shelterUniforms.uRoofExt.value.set(res.nx * res.cell, res.nz * res.cell);
    shelterUniforms.uRoofOn.value = 1;
}

// 船の座標 (x, z) の屋根の高さ（無ければ SHELTER_EMPTY）
function shelterRoofAt(x, z) {
    if (!shelter.data) return SHELTER_EMPTY;
    const ix = Math.floor((x - shelter.minX) / shelter.cell);
    const iz = Math.floor((z - shelter.minZ) / shelter.cell);
    if (ix < 0 || iz < 0 || ix >= shelter.nx || iz >= shelter.nz) return SHELTER_EMPTY;
    return shelter.data[iz * shelter.nx + ix];
}

// 毎フレーム（天候の見た目の更新より前）
function updateShelter(t) {
    const dt = (shelter.lastT < 0) ? 0 : Math.min(0.1, Math.max(0, t - shelter.lastT));
    shelter.lastT = t;
    if (typeof shipGroup === 'undefined' || !shipGroup) return;

    // モデルが変わったら地図を作り直す（1秒に1回だけ確かめる）
    if (t >= shelter.keyCheckAt) {
        shelter.keyCheckAt = t + 1.0;
        const key = _shelterKey();
        if (key && !_shelterKeySame(key, shelter.key) && !_shelterKeySame(key, shelter.pendingKey)) {
            shelter.pendingKey = key;
            shelter.gen = _shelterBuild();
        }
    }
    if (shelter.gen) {
        const t0 = performance.now();
        let r;
        do { r = shelter.gen.next(); } while (!r.done && performance.now() - t0 < SHELTER_BUILD_BUDGET_MS);
        if (r.done) {
            shelter.gen = null;
            shelter.key = shelter.pendingKey;
            shelter.pendingKey = null;
            if (r.value) _shelterInstall(r.value);
        }
    }

    shipGroup.updateWorldMatrix(true, false);
    shelterUniforms.uRoofInv.value.copy(shipGroup.matrixWorld).invert();

    // ── カメラが船内にいるか ──
    let target = 0;
    if (shelter.data && typeof camera !== 'undefined' && camera) {
        _shV.copy(camera.position).applyMatrix4(shelterUniforms.uRoofInv.value);
        const scaleW = new THREE.Vector3().setFromMatrixScale(shipGroup.matrixWorld).x || 1;
        const m = 1 / scaleW;   // 1m を船の座標へ
        const camY = _shV.y;
        if (shelterRoofAt(_shV.x, _shV.z) > camY + 0.2 * m) {
            // 真上に屋根がある。まわり（16方向×3距離）もどれだけ屋根に覆われているか
            let covered = 0, total = 0;
            for (let k = 0; k < 16; k++) {
                const ang = k / 16 * Math.PI * 2;
                const sx = Math.cos(ang), sz = Math.sin(ang);
                for (const r of [2, 4, 7]) {
                    total++;
                    if (shelterRoofAt(_shV.x + sx * r * m, _shV.z + sz * r * m) > camY + 0.2 * m) covered++;
                }
            }
            const f = covered / total;
            target = Math.min(1, Math.max(0, (f - 0.5) / 0.4));
            target = target * target * (3 - 2 * target);
        }
    }
    // 出入りでパッと変わらないよう、なめらかに
    window.shelterIndoor += (target - window.shelterIndoor) * (1 - Math.exp(-dt / 0.4));
}
