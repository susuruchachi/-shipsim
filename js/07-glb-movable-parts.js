// スクリュー・舵・外輪などを名前から検出してギズモで動かせるようにする
const GLB_PART_PATTERNS = [
    // バウスラスター（船体を横に貫くトンネルの中のスクリュー。58-maneuvering.js のサイドスラスターになる）。
    // "BowThruster_Propeller" のような名前もスラスターにするため、スクリューより先に調べる
    { key: 'thruster', label: '↔ バウスラスター', regex: /thruster|スラスタ/i },
    { key: 'screw',  label: '🌀 スクリュー', regex: /screw|propeller|プロペラ|スクリュー/i },
    { key: 'rudder', label: '🕹 舵',          regex: /rudder|舵/i },
    { key: 'paddle', label: '🛞 外輪',         regex: /paddle|wheel|外輪|水車/i },
    // アジポッドの胴体（向きを変える部品。中のプロペラは別に "Propeller" などの名前で）
    { key: 'azipod', label: '🧭 アジポッド',   regex: /azipod|azimuth|ポッド/i },
];

function createGlbPartLabel(text) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.font = 'bold 28px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(text, 128, 32);
    ctx.fillStyle = '#ffffaa';
    ctx.fillText(text, 128, 32);
    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(2.2, 0.55, 1);
    sprite.renderOrder = 1000;
    return sprite;
}

function computeGlbPartCenterOffset(part) {
    const obj = part.object;
    obj.updateMatrixWorld(true);

    // obj自身のワールド行列の逆行列。これを c.matrixWorld にかけると、
    // 「obj の原点を基準にした、obj から見た c の相対位置」が得られる。
    // 親や祖先（ship本体など）の行列はキャンセルされるので、
    // モデル全体のスケール・位置に影響されない。
    const invSelf = new THREE.Matrix4().copy(obj.matrixWorld).invert();

    const box = new THREE.Box3();
    let has = false;
    obj.traverse((c) => {
        if (c.isMesh && c.geometry) {
            if (!c.geometry.boundingBox) c.geometry.computeBoundingBox();
            const b = c.geometry.boundingBox.clone();
            const rel = new THREE.Matrix4().multiplyMatrices(invSelf, c.matrixWorld);
            b.applyMatrix4(rel);
            if (!has) { box.copy(b); has = true; }
            else box.union(b);
        }
    });
    if (!has || !isFinite(box.min.x)) return new THREE.Vector3();

    // box の中心は「obj の原点を基準とした、obj のローカル軸」での座標。
    // これを obj自身の回転・スケール（位置は除く）だけ適用して
    // 親から見たローカル座標系でのオフセットに変換する。
    const centerLocal = box.getCenter(new THREE.Vector3());
    const rotScale = new THREE.Matrix4().compose(
        new THREE.Vector3(0, 0, 0), obj.quaternion, obj.scale
    );
    return centerLocal.applyMatrix4(rotScale);
}

// v92: バウンディングボックス中心(computeGlbPartCenterOffset)は軸並行の箱の中心なので、
// 3枚羽根のスクリューのように奇数枚・非対称配置の形状だと、本来の回転軸(シャフト中心)から
// ずれてしまう。→ 三角形の面積で重み付けした表面重心(重心/center of gravity)を計算する。
// 羽根がN枚(偶数・奇数を問わず)均等配置された回転対称形状であれば、面積重心は
// 数学的に必ず回転軸上に一致する(形状を2π/N回転させても重心の位置は変わらないはずなので、
// 回転で不動な点＝軸上の点しかありえない、という対称性の議論による)。
function computeGlbPartCentroidOffset(part) {
    const obj = part.object;
    obj.updateMatrixWorld(true);
    const invSelf = new THREE.Matrix4().copy(obj.matrixWorld).invert();
    const rel = new THREE.Matrix4();

    const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
    const ab = new THREE.Vector3(), ac = new THREE.Vector3(), cross = new THREE.Vector3(), triCentroid = new THREE.Vector3();
    const weightedSum = new THREE.Vector3();
    let totalArea = 0;

    obj.traverse((c) => {
        if (!c.isMesh || !c.geometry) return;
        const geo = c.geometry;
        const posAttr = geo.attributes && geo.attributes.position;
        if (!posAttr) return;
        rel.multiplyMatrices(invSelf, c.matrixWorld);
        const index = geo.index;
        const triCount = Math.floor((index ? index.count : posAttr.count) / 3);

        for (let i = 0; i < triCount; i++) {
            const i0 = index ? index.getX(i * 3)     : i * 3;
            const i1 = index ? index.getX(i * 3 + 1) : i * 3 + 1;
            const i2 = index ? index.getX(i * 3 + 2) : i * 3 + 2;
            va.fromBufferAttribute(posAttr, i0).applyMatrix4(rel);
            vb.fromBufferAttribute(posAttr, i1).applyMatrix4(rel);
            vc.fromBufferAttribute(posAttr, i2).applyMatrix4(rel);

            ab.subVectors(vb, va);
            ac.subVectors(vc, va);
            cross.crossVectors(ab, ac);
            const area = cross.length() * 0.5;
            if (area <= 0) continue;

            triCentroid.copy(va).add(vb).add(vc).multiplyScalar(1 / 3);
            weightedSum.addScaledVector(triCentroid, area);
            totalArea += area;
        }
    });

    if (totalArea <= 0) return computeGlbPartCenterOffset(part); // 面が取れない場合は従来方式にフォールバック

    const centroidLocal = weightedSum.multiplyScalar(1 / totalArea);
    const rotScale = new THREE.Matrix4().compose(
        new THREE.Vector3(0, 0, 0), obj.quaternion, obj.scale
    );
    return centroidLocal.applyMatrix4(rotScale);
}

// ── スクリューの回転軸を形から求める（軸が斜めのスクリュー）─────────────────
// Blender で部品を回さずに、形そのものを傾けて作ったスクリュー（シャフトが下向き・外向きに傾いている船など）は、
// 部品の X・Y・Z のどの軸で回しても、軸がずれて首を振るように回っていた。
// 羽根が 3 枚以上で等間隔なら、面の広がり（面積で重みをつけた分散）は羽根の面の中の 2 方向で同じになり、
// 回転軸の向きだけが違う大きさになる（軸のまわりに回しても形が変わらないので）。その「1 つだけ違う向き」を軸にし、
// 面積重心（同じ理由で軸の上にある）を軸が通る点にする。決まらないとき（羽根 2 枚など）や、ありえない向きのときは、
// 推進器の種類から想定される向き（スクリュー：船首尾、外輪・バウスラスター：左右）にいちばん近い向きを選ぶ。
// 座標は「部品の向き・位置を除き、拡大縮小だけかけた」部品の座標（部品の quaternion がかかる座標）。
//   戻り値：{ axis（その座標の単位ベクトル）, center（軸が通る点）, tilt（船首尾・左右の軸からの傾き[度]）}
function _glbEigSym3(A) {
    // 3×3 対称行列の固有値・固有ベクトル（ヤコビ法）
    const a = [A[0].slice(), A[1].slice(), A[2].slice()], v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let sweep = 0; sweep < 32; sweep++) {
        const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
        if (off < 1e-14 * (Math.abs(a[0][0]) + Math.abs(a[1][1]) + Math.abs(a[2][2]) + 1e-30)) break;
        for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
            if (Math.abs(a[p][q]) < 1e-30) continue;
            const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
            const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), sn = t * c;
            for (let k = 0; k < 3; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - sn * akq; a[k][q] = sn * akp + c * akq; }
            for (let k = 0; k < 3; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - sn * aqk; a[q][k] = sn * apk + c * aqk; }
            for (let k = 0; k < 3; k++) { const vkp = v[k][p], vkq = v[k][q]; v[k][p] = c * vkp - sn * vkq; v[k][q] = sn * vkp + c * vkq; }
        }
    }
    return [0, 1, 2].map(i => ({ w: a[i][i], v: new THREE.Vector3(v[0][i], v[1][i], v[2][i]).normalize() })).sort((x, y) => x.w - y.w);
}
function computeGlbPartSpinAxis(part) {
    const obj = part.object;
    if (!obj) return null;
    obj.updateMatrixWorld(true);
    const S = new THREE.Matrix4().makeScale(obj.scale.x, obj.scale.y, obj.scale.z);
    const toF = new THREE.Matrix4().copy(obj.matrixWorld).invert().premultiply(S);
    const m = new THREE.Matrix4();
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
    let A = 0;
    const m1 = new THREE.Vector3();
    const M2 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    obj.traverse((o) => {
        if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
        const pos = o.geometry.attributes.position, idx = o.geometry.index;
        m.multiplyMatrices(toF, o.matrixWorld);
        const n = Math.floor((idx ? idx.count : pos.count) / 3);
        for (let i = 0; i < n; i++) {
            a.fromBufferAttribute(pos, idx ? idx.getX(3 * i) : 3 * i).applyMatrix4(m);
            b.fromBufferAttribute(pos, idx ? idx.getX(3 * i + 1) : 3 * i + 1).applyMatrix4(m);
            c.fromBufferAttribute(pos, idx ? idx.getX(3 * i + 2) : 3 * i + 2).applyMatrix4(m);
            const ar = e1.subVectors(b, a).cross(e2.subVectors(c, a)).length() / 2;
            if (!(ar > 0)) continue;
            A += ar;
            m1.x += ar * (a.x + b.x + c.x) / 3; m1.y += ar * (a.y + b.y + c.y) / 3; m1.z += ar * (a.z + b.z + c.z) / 3;
            // 三角形の上の ∫x xᵀ dA ＝ A/12・(aaᵀ＋bbᵀ＋ccᵀ＋ssᵀ)（s＝a＋b＋c）
            const sx = a.x + b.x + c.x, sy = a.y + b.y + c.y, sz = a.z + b.z + c.z, k = ar / 12;
            const P = [[a.x, a.y, a.z], [b.x, b.y, b.z], [c.x, c.y, c.z], [sx, sy, sz]];
            for (const q of P) for (let r = 0; r < 3; r++) for (let t = r; t < 3; t++) M2[r][t] += k * q[r] * q[t];
        }
    });
    if (!(A > 0)) return null;
    const center = m1.clone().divideScalar(A);
    const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], cc = [center.x, center.y, center.z];
    for (let r = 0; r < 3; r++) for (let t = r; t < 3; t++) C[r][t] = C[t][r] = M2[r][t] / A - cc[r] * cc[t];
    const eg = _glbEigSym3(C);
    const d01 = eg[1].w - eg[0].w, d12 = eg[2].w - eg[1].w;
    // 2 つが同じ大きさ（d が小さい方）で、残りの 1 つが軸
    let axis = (d12 <= d01 ? eg[0].v : eg[2].v).clone();
    const ambiguous = Math.min(d01, d12) > 0.35 * Math.max(d01, d12, 1e-30);
    // 想定される向き（部品の座標で）：スクリューは船首尾、外輪・バウスラスターは左右。
    // 船首尾は、モデル全体（読み込んだモデルのいちばん上の部品）の、水平でいちばん長い向き
    //（モデルを読み込んだ直後は、船の向きの補正・船体のスキャンがまだなので、船の向きからは決めない）
    const fr = _glbPartShipFrame(part);
    const dirF = (d) => d.clone().applyMatrix4(fr.toPartDir).applyMatrix4(S).normalize();
    const fwd = dirF(fr.fwd), side = dirF(fr.side), up = dirF(fr.up);
    const want = part.key === 'screw' ? fwd : side;
    if (ambiguous || Math.abs(axis.dot(want)) < Math.cos(50 * Math.PI / 180)) {
        let best = null;
        for (const e of eg) if (!best || Math.abs(e.v.dot(want)) > Math.abs(best.dot(want))) best = e.v;
        axis = best.clone();
    }
    // 部品の軸にほぼ沿っていれば（2° 以内）、その軸ちょうどにする（形の細かな非対称で軸が首を振らないように）
    for (const u of [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)]) {
        if (Math.abs(axis.dot(u)) > Math.cos(2 * Math.PI / 180)) { axis = u.multiplyScalar(Math.sign(axis.dot(u))); break; }
    }
    // 向き：いちばん大きい成分を ＋ に（X・Y・Z で回していたときと同じ回り方になるように）
    const big = Math.abs(axis.x) >= Math.abs(axis.y) && Math.abs(axis.x) >= Math.abs(axis.z) ? axis.x : Math.abs(axis.y) >= Math.abs(axis.z) ? axis.y : axis.z;
    if (big < 0) axis.negate();
    // 船首尾（外輪・スラスターは左右）の軸からの傾き：上下・左右の角度
    const s2 = axis.dot(want) < 0 ? -1 : 1, ax2 = axis.clone().multiplyScalar(s2);
    const other = part.key === 'screw' ? side : fwd;
    const tilt = { down: Math.round(-Math.asin(Math.max(-1, Math.min(1, ax2.dot(up)))) * 180 / Math.PI * 10) / 10,
                   yaw: Math.round(Math.asin(Math.max(-1, Math.min(1, ax2.dot(other)))) * 180 / Math.PI * 10) / 10 };
    return { axis, center, tilt, ambiguous };
}
// 船首尾・左右・上の向き（モデル全体のいちばん上の部品の座標）と、それを部品の座標（向きを除いた部品の親の座標
// → 基準の向きの逆）へ移す行列
function _glbPartShipFrame(part) {
    const obj = part.object;
    let root = obj;
    while (root.parent && !(typeof importedModelGroup !== 'undefined' && root.parent === importedModelGroup) && root.parent.type !== 'Scene' && !(typeof shipGroup !== 'undefined' && root.parent === shipGroup)) root = root.parent;
    root.updateMatrixWorld(true);
    const invRoot = new THREE.Matrix4().copy(root.matrixWorld).invert(), m = new THREE.Matrix4(), box = new THREE.Box3(), bb = new THREE.Box3();
    root.traverse((o) => {
        if (!o.isMesh || !o.geometry) return;
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        bb.copy(o.geometry.boundingBox).applyMatrix4(m.multiplyMatrices(invRoot, o.matrixWorld)); box.union(bb);
    });
    const size = box.isEmpty() ? new THREE.Vector3(0, 0, 1) : box.getSize(new THREE.Vector3());
    const fwd = size.x > size.z ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
    const up = new THREE.Vector3(0, 1, 0), side = new THREE.Vector3().crossVectors(up, fwd);
    // モデル全体の座標の向き → 部品の親の座標 → 部品の基準の向きの逆（部品の座標）
    const parent = obj.parent || root;
    const toParent = new THREE.Matrix4().copy(parent.matrixWorld).invert().multiply(root.matrixWorld);
    toParent.setPosition(0, 0, 0);
    const qInv = new THREE.Quaternion().setFromEuler(part.baseRot || obj.rotation).invert();
    const toPartDir = new THREE.Matrix4().makeRotationFromQuaternion(qInv).multiply(toParent);
    return { fwd, side, up, toPartDir };
}
// 以前の回し方（オイラー角の 1 成分を変える）で、実際に回っていた軸（部品の座標）。
// 部品が回してある（向きが付いている）と、成分によっては部品の軸ではなく親の軸のまわりに回っていた
function _glbPartEulerAxisF(part, key) {
    const e = (part.baseRot || part.object.rotation).clone(), q1 = new THREE.Quaternion().setFromEuler(e);
    e[key] += 0.01;
    const d = new THREE.Quaternion().setFromEuler(e).multiply(q1.clone().invert());
    const ax = new THREE.Vector3(d.x, d.y, d.z);
    if (ax.lengthSq() < 1e-14) return new THREE.Vector3(1, 0, 0);
    const o = part.object;
    return ax.normalize().applyQuaternion(q1.invert()).multiply(new THREE.Vector3(o.scale.x, o.scale.y, o.scale.z)).normalize();
}
// 「自動」の回転軸にする（part.spinVec・回転の中心）。求められなければ X のまま
function setGlbPartAutoAxis(part) {
    const r = computeGlbPartSpinAxis(part);
    if (!r) return false;
    part.spinAxis = 'auto';
    part.spinVec = r.axis;
    part.spinTilt = r.tilt;
    part.pivotOffset = r.center.clone();
    part.spin = 0;
    part.object.position.copy(part.basePos);
    part.object.rotation.copy(part.baseRot);
    if (part.pivotMarker) part.pivotMarker.position.copy(part.basePos).add(part.pivotOffset);
    return true;
}
// 保存した設定の回転軸を当てる（13-save-load-config.js からも）。
// 以前の既定（X）のまま保存した船でも、形から軸がはっきり斜め（3°〜45°）と分かれば、自動の軸に切り替える
function applyGlbPartSavedSpin(part, saved) {
    if (!saved.spinAxis) return;
    if (saved.spinAxis === 'auto') {
        if (saved.spinVec) {
            part.spinAxis = 'auto';
            part.spinVec = new THREE.Vector3(saved.spinVec.x, saved.spinVec.y, saved.spinVec.z).normalize();
            const r = computeGlbPartSpinAxis(part); part.spinTilt = r ? r.tilt : null;
        } else setGlbPartAutoAxis(part);
        return 'auto';
    }
    part.spinAxis = saved.spinAxis;
    if (saved.spinAxis === 'x' && (part.key === 'screw' || part.key === 'paddle' || part.key === 'thruster')) {
        const r = computeGlbPartSpinAxis(part);
        const cx = r ? Math.abs(r.axis.dot(_glbPartEulerAxisF(part, 'x'))) : 1;
        if (r && !r.ambiguous && cx < Math.cos(3 * Math.PI / 180) && cx > Math.cos(45 * Math.PI / 180)) { setGlbPartAutoAxis(part); return 'auto'; }
    }
    return saved.spinAxis;
}

function createGlbPartPivotMarker(part) {
    const group = new THREE.Group();
    group.visible = false;
    group.userData.isGlbPivotMarker = true;

    // Blenderの3Dカーソルのような x(赤)/y(緑)/z(青) 軸表示
    const axes = new THREE.AxesHelper(1.0);
    axes.material.depthTest = false;
    axes.material.transparent = true;
    axes.renderOrder = 999;
    group.add(axes);

    // 軸の原点を示す小さな球
    const geo = new THREE.SphereGeometry(0.12, 8, 8);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffaa00, depthTest: false, transparent: true, opacity: 0.85 });
    const sphere = new THREE.Mesh(geo, mat);
    sphere.renderOrder = 999;
    group.add(sphere);

    // パーツ名ラベル
    const label = createGlbPartLabel(part.name);
    label.position.set(0, 1.3, 0);
    group.add(label);

    group.position.copy(part.basePos).add(part.pivotOffset);
    const parent = part.object.parent;
    if (parent) parent.add(group);
    return group;
}

function detectGlbMovableParts(model) {
    glbMovableParts = [];
    const seen = new Set();
    model.traverse((child) => {
        if (!child.name) return;
        for (const pat of GLB_PART_PATTERNS) {
            if (pat.regex.test(child.name) && !seen.has(child)) {
                seen.add(child);
                const part = {
                    id: 'glbpart_' + glbMovableParts.length,
                    name: child.name,
                    label: pat.label,
                    key: pat.key,
                    origKey: pat.key,        // 名前から決まった種類（key は「種類」のボタンで変えられる）
                    object: child,
                    basePos: child.position.clone(),   // モデル初期位置（変えない）
                    baseRot: child.rotation.clone(),
                    invert: false,
                    spin: 0,
                    spinAxis: pat.key === 'azipod' ? 'y' : 'x',   // 回転軸 x/y/z（アジポッドは上下の軸で向きを変える）
                    disabled: false,         // true の場合、アニメーション対象から除外（誤検出パーツの機能停止用）
                    pivotOffset: new THREE.Vector3(), // 回転軸のオフセット（モデルは動かない）
                    pivotMarker: null,       // 回転軸位置を示すギズモ用マーカー
                };
                // デフォルトの回転軸は、このパーツの形状の中心に置く
                part.pivotOffset = computeGlbPartCenterOffset(part);
                part.pivotMarker = createGlbPartPivotMarker(part);
                // 回る部品（スクリュー・外輪・スラスター）は、形から求めた軸で回す（軸が斜めのスクリューも）
                if (pat.key === 'screw' || pat.key === 'paddle' || pat.key === 'thruster') setGlbPartAutoAxis(part);
                glbMovableParts.push(part);
                break;
            }
        }
    });
    renderGlbPartsList();

    if (pendingGlbPartTransforms) {
        glbMovableParts.forEach((part) => {
            let saved = pendingGlbPartTransforms.find(t => t.name === part.name);
            if (saved) {
                // 旧形式 (pos) は無視 — 位置はモデルの初期位置固定
                if (saved.rot) part.object.rotation.set(saved.rot.x, saved.rot.y, saved.rot.z);
                if (typeof saved.invert === 'boolean') part.invert = saved.invert;
                if (typeof saved.disabled === 'boolean') part.disabled = saved.disabled;
                if (saved.kind) setGlbPartKindRaw(part, saved.kind);
                // 自動の軸は、軸が通る点も形から（保存した回転の中心は使わない）
                if (applyGlbPartSavedSpin(part, saved) === 'auto') saved = Object.assign({}, saved, { pivotOffset: null });
                if (saved.pivotOffset) {
                    part.pivotOffset.set(saved.pivotOffset.x, saved.pivotOffset.y, saved.pivotOffset.z);
                    if (part.pivotMarker) part.pivotMarker.position.copy(part.basePos).add(part.pivotOffset);
                }
            }
        });
        pendingGlbPartTransforms = null;
        renderGlbPartsList();
    }
    syncSettingsVisibility();
}

function buildGlbPartCard(part) {
    const pv = part.pivotOffset || new THREE.Vector3();
    const ax = part.spinAxis || 'x';
    const spinning = part.key === 'screw' || part.key === 'paddle' || part.key === 'thruster';
    const card = document.createElement('div');
    card.className = 'sp-item-card';
    if (part.disabled) card.style.opacity = '0.5';
    // スクリュー・外輪は、その機関と同じ名前で呼ぶ（56-engines.js）。モデルの中の名前は小さく添える
    const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const engId = 'glb:' + part.id;
    const unitName = (!part.disabled && (part.key === 'screw' || part.key === 'paddle') && typeof engineScrewNameFor === 'function') ? engineScrewNameFor(engId) : null;
    const eng = unitName !== null && typeof engineById === 'function' ? engineById(engId) : null;
    card.innerHTML = `
        <div class="sp-item-header">
            <span class="sp-item-title">${part.label} : ${unitName !== null ? `<b style="color:#00ffcc;">${esc(unitName)}</b> ` : ''}<span style="color:#aaa;font-size:10px;">${unitName !== null ? '（モデル：' + esc(part.name) + '）' : esc(part.name)}</span>${part.disabled ? ' <span style="color:#ff5555;">(機能停止中)</span>' : ''}</span>
            <button class="sp-remove-btn" style="${part.disabled ? 'background:rgba(0,255,204,0.1);border-color:#00ffcc;color:#00ffcc;' : ''}" onclick="toggleGlbPartDisabled('${part.id}')">${part.disabled ? '↺ 復活' : '⛔ 機能停止'}</button>
        </div>
        ${eng ? `<div class="sp-row" style="gap:6px;margin-bottom:4px;flex-wrap:wrap;align-items:center;">
            <span class="sp-label" style="min-width:50px;">名前:</span>
            <input type="text" value="${esc(eng.conf.name || '')}" placeholder="${esc(eng.autoBase || '（1基だけ）')}" maxlength="16" style="width:90px;background:#0a1932;color:#00ffcc;border:1px solid #00ffcc55;border-radius:4px;padding:2px 4px;font-size:11px;" onchange="engineSetConfById('${engId}','name',this.value)">
            <span style="font-size:10px;color:#888;">機関（下の「機関」の欄）と同じ名前になります</span>
        </div>` : ''}
        ${GLB_PROP_KINDS[part.key] ? `<div class="sp-row" style="gap:4px;margin-bottom:4px;flex-wrap:wrap;">
            <span class="sp-label" style="min-width:50px;">種類:</span>
            ${Object.entries(GLB_PROP_KINDS).map(([k, l]) => `<button class="sp-add-btn" style="flex:none;${part.key === k ? 'background:rgba(0,255,204,0.18);border-color:#00ffcc;color:#00ffcc;' : ''}" onclick="setGlbPartKind('${part.id}','${k}')" title="名前から見分けた種類が違うときに">${l}</button>`).join('')}
            ${part.key !== part.origKey ? '<span style="font-size:10px;color:#ffaa66;">（名前からは ' + (GLB_PROP_KINDS[part.origKey] || part.origKey) + '）</span>' : ''}
        </div>` : ''}
        ${part.disabled ? '<div style="font-size:10px;color:#888;margin-bottom:4px;">このパーツはアニメーション・回転設定から除外されています。誤って選択した場合は「復活」で元に戻せます。</div>' : `
        <div class="sp-row" style="gap:6px;margin-bottom:4px;flex-wrap:wrap;">
            <span class="sp-label" style="min-width:50px;">回転軸:</span>
            ${spinning ? `<label style="font-size:11px;cursor:pointer;" title="形から回転軸を求める（軸が斜めのスクリューも）"><input type="radio" name="axis-${part.id}" value="auto" ${ax==='auto'?'checked':''} onchange="setGlbPartAxis('${part.id}','auto')"> 自動</label>` : ''}
            <label style="font-size:11px;cursor:pointer;"><input type="radio" name="axis-${part.id}" value="x" ${ax==='x'?'checked':''} onchange="setGlbPartAxis('${part.id}','x')"> X</label>
            <label style="font-size:11px;cursor:pointer;"><input type="radio" name="axis-${part.id}" value="y" ${ax==='y'?'checked':''} onchange="setGlbPartAxis('${part.id}','y')"> Y</label>
            <label style="font-size:11px;cursor:pointer;"><input type="radio" name="axis-${part.id}" value="z" ${ax==='z'?'checked':''} onchange="setGlbPartAxis('${part.id}','z')"> Z</label>
            <button class="sp-add-btn" style="flex:none;margin-left:auto;${part.invert?'color:#ff8866;':''}" onclick="toggleGlbPartInvert('${part.id}')">${part.invert?'🔁反転中':'🔁反転'}</button>
        </div>
        ${ax === 'auto' && part.spinTilt ? `<div style="font-size:10px;color:#88ccff;margin:-2px 0 4px;">形から求めた軸：${(Math.abs(part.spinTilt.down) < 0.05 && Math.abs(part.spinTilt.yaw) < 0.05) ? `${part.key === 'screw' ? '船首尾' : '左右'}の向きにまっすぐ` : `${part.key === 'screw' ? '船首尾' : '左右'}の向きから 上下に ${Math.abs(part.spinTilt.down).toFixed(1)}°・${part.key === 'screw' ? '左右' : '前後'}に ${Math.abs(part.spinTilt.yaw).toFixed(1)}° 傾いています`}</div>` : ''}
        <div class="sp-row" style="justify-content:space-between;margin-bottom:2px;">
            <span style="font-size:10px;color:#666;">回転軸オフセット (軸のみ移動・モデル位置は変わりません)</span>
            <button class="sp-gizmo-btn" id="gizmo-glbpart-pivot-${part.id}" onclick="toggleGizmo('glbpart_pivot','${part.id}')">📍 ギズモ</button>
        </div>
        <div class="sp-xyz-row" style="margin-bottom:4px;">
            <span class="sp-axis-label">X:</span>
            <input type="number" id="pivot-x-${part.id}" class="sp-xyz-input" value="${pv.x.toFixed(3)}" step="0.05"
                oninput="setGlbPartPivot('${part.id}','x',parseFloat(this.value)||0)">
            <span class="sp-axis-label">Y:</span>
            <input type="number" id="pivot-y-${part.id}" class="sp-xyz-input" value="${pv.y.toFixed(3)}" step="0.05"
                oninput="setGlbPartPivot('${part.id}','y',parseFloat(this.value)||0)">
            <span class="sp-axis-label">Z:</span>
            <input type="number" id="pivot-z-${part.id}" class="sp-xyz-input" value="${pv.z.toFixed(3)}" step="0.05"
                oninput="setGlbPartPivot('${part.id}','z',parseFloat(this.value)||0)">
        </div>
        <div style="font-size:10px;color:#888;margin-bottom:4px;">${part.key === 'rudder' ? '舵角に連動して回転します。' : part.key === 'azipod' ? 'ポッドの向きに連動して回転します（いちばん近い機関のポッド）。' : part.key === 'thruster' ? 'サイドスラスターの出力に連動して回転します（出力・名前は下の「サイドスラスター」で）。トンネルの軸（左右）を回転軸にしてください。' : '船速に連動して回転します。'}</div>
        <div class="sp-row" style="gap:6px;flex-wrap:wrap;">
            <button class="sp-add-btn" style="flex:none;" onclick="resetGlbPart('${part.id}')" title="回転・位置も含めて完全に初期状態へ(回転軸はバウンディング中心)">↺ 全リセット</button>
            <button class="sp-add-btn" style="flex:none;" onclick="setGlbPartPivotToCentroid('${part.id}')" title="面積重心。奇数枚のスクリュー等、バウンディング中心だと軸がずれる場合に">⚖️ 重心中心</button>
            <button class="sp-add-btn" style="flex:none;" onclick="setGlbPartPivotToOrigin('${part.id}')" title="モデル自身のローカル原点(0,0,0)。Blender側で軸を原点に置いてある場合に確実">📍 原点中心</button>
        </div>`}`;
    return card;
}

function renderGlbPartsList() {
    const propList = $('glb-propulsion-parts-list');
    const rudderList = $('glb-rudder-parts-list');
    if (!propList && !rudderList) return;

    const propParts = glbMovableParts.filter(p => p.key === 'screw' || p.key === 'paddle' || p.key === 'azipod' || p.key === 'thruster');
    const rudderParts = glbMovableParts.filter(p => p.key === 'rudder');

    if (propList && propParts.length && typeof engineListRefresh === 'function') engineListRefresh();   // 名前（機関と同じ）を最新に
    if (propList) {
        if (propParts.length === 0) {
            propList.innerHTML = '<div style="font-size:10px;color:#888;">スクリュー・外輪などの名前を持つパーツは見つかりませんでした。<br>(Blenderでオブジェクト名に "Screw" / "Paddle" / "Thruster" などを含めてください)</div>';
        } else {
            propList.innerHTML = '';
            propParts.forEach((part) => propList.appendChild(buildGlbPartCard(part)));
        }
    }
    if (rudderList) {
        if (rudderParts.length === 0) {
            rudderList.innerHTML = '<div style="font-size:10px;color:#888;">舵の名前を持つパーツは見つかりませんでした。<br>(Blenderでオブジェクト名に "Rudder" / "舵" を含めてください)</div>';
        } else {
            rudderList.innerHTML = '';
            rudderParts.forEach((part) => rudderList.appendChild(buildGlbPartCard(part)));
        }
    }
    if (propList) addFineTuneButtons(propList);
    if (rudderList) addFineTuneButtons(rudderList);
}

function toggleGlbPartInvert(id) {
    const part = glbMovableParts.find(p => p.id === id);
    if (!part) return;
    part.invert = !part.invert;
    renderGlbPartsList();
}

function toggleGlbPartDisabled(id) {
    const part = glbMovableParts.find(p => p.id === id);
    if (!part) return;
    part.disabled = !part.disabled;
    if (part.disabled) {
        // 機能停止時はアニメーションをリセットして元の姿勢に戻す
        part.object.position.copy(part.basePos);
        part.object.rotation.copy(part.baseRot);
        part.spin = 0;
        if (currentGizmoType === 'glbpart_pivot' && currentGizmoIndex === id) disableGizmo();
    }
    renderGlbPartsList();
    _glbPropKindChanged();
}

// 推進器の部品の種類（誤認識のとき切り替える）：スクリュー・外輪・バウスラスター
const GLB_PROP_KINDS = { screw: '🌀 スクリュー', paddle: '🛞 外輪', thruster: '↔ バウスラスター' };
function setGlbPartKindRaw(part, kind) {
    if (!GLB_PROP_KINDS[kind] || !GLB_PROP_KINDS[part.key]) return;
    part.key = kind;
    const pat = GLB_PART_PATTERNS.find(q => q.key === kind);
    if (pat) part.label = pat.label;
}
function setGlbPartKind(id, kind) {
    const part = glbMovableParts.find(p => p.id === id);
    if (!part || part.key === kind) return;
    setGlbPartKindRaw(part, kind);
    // 回っていた分を戻す
    part.object.position.copy(part.basePos);
    part.object.rotation.copy(part.baseRot);
    part.spin = 0;
    renderGlbPartsList();
    _glbPropKindChanged();
}
// 機関（56-engines.js）・スラスター（58-maneuvering.js）の一覧を作り直す
function _glbPropKindChanged() {
    if (typeof maneuverSyncParts === 'function') maneuverSyncParts();
    if (typeof renderEngineSettings === 'function') renderEngineSettings();
    if (typeof renderManeuverSettings === 'function') renderManeuverSettings();
}

function setGlbPartAxis(id, axis) {
    const part = glbMovableParts.find(p => p.id === id);
    if (!part) return;
    // 回っていた分を戻してから（自動の軸から X・Y・Z へ変えたときも、途中の向きが残らないように）
    part.object.position.copy(part.basePos);
    part.object.rotation.copy(part.baseRot);
    part.spin = 0;
    if (axis === 'auto') { setGlbPartAutoAxis(part); renderGlbPartsList(); return; }
    part.spinAxis = axis;
    renderGlbPartsList();
}

function setGlbPartPivot(id, component, value) {
    const part = glbMovableParts.find(p => p.id === id);
    if (!part) return;
    if (!part.pivotOffset) part.pivotOffset = new THREE.Vector3();
    part.pivotOffset[component] = value;
    if (part.pivotMarker) part.pivotMarker.position.copy(part.basePos).add(part.pivotOffset);
}

// v92: 回転軸を「重心(面積重心)」に合わせる。3枚羽根など奇数枚のスクリューで、
// バウンディングボックス中心だと軸がずれてしまう場合に使う。
function setGlbPartPivotToCentroid(id) {
    const part = glbMovableParts.find(p => p.id === id);
    if (!part) return;
    part.pivotOffset = computeGlbPartCentroidOffset(part);
    if (part.pivotMarker) part.pivotMarker.position.copy(part.basePos).add(part.pivotOffset);
    renderGlbPartsList();
}

// v92: 回転軸を「モデル自身のローカル原点」に合わせる(オフセット0)。
// Blender側でパーツの原点をシャフト中心に置いてエクスポートしてある場合は、
// これが一番確実(形状からの推定に頼らないため)。
function setGlbPartPivotToOrigin(id) {
    const part = glbMovableParts.find(p => p.id === id);
    if (!part) return;
    part.pivotOffset = new THREE.Vector3(0, 0, 0);
    if (part.pivotMarker) part.pivotMarker.position.copy(part.basePos).add(part.pivotOffset);
    renderGlbPartsList();
}

function resetGlbPart(id) {
    const part = glbMovableParts.find(p => p.id === id);
    if (!part) return;
    // 位置はbasePos（モデルが元々あった場所）に戻す
    part.object.position.copy(part.basePos);
    part.object.rotation.copy(part.baseRot);
    part.spin = 0;
    // 回転軸はデフォルト（パーツの形状中心。回る部品は形から求めた軸）に戻す
    part.pivotOffset = computeGlbPartCenterOffset(part);
    if (part.pivotMarker) part.pivotMarker.position.copy(part.basePos).add(part.pivotOffset);
    if (part.key === 'screw' || part.key === 'paddle' || part.key === 'thruster') setGlbPartAutoAxis(part);
    renderGlbPartsList();
}

