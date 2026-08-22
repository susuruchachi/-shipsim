// スクリュー・舵・外輪などを名前から検出してギズモで動かせるようにする
const GLB_PART_PATTERNS = [
    { key: 'screw',  label: '🌀 スクリュー', regex: /screw|propeller|プロペラ|スクリュー/i },
    { key: 'rudder', label: '🕹 舵',          regex: /rudder|舵/i },
    { key: 'paddle', label: '🛞 外輪',         regex: /paddle|wheel|外輪|水車/i },
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
                    object: child,
                    basePos: child.position.clone(),   // モデル初期位置（変えない）
                    baseRot: child.rotation.clone(),
                    invert: false,
                    spin: 0,
                    spinAxis: 'x',           // 回転軸 x/y/z
                    disabled: false,         // true の場合、アニメーション対象から除外（誤検出パーツの機能停止用）
                    pivotOffset: new THREE.Vector3(), // 回転軸のオフセット（モデルは動かない）
                    pivotMarker: null,       // 回転軸位置を示すギズモ用マーカー
                };
                // デフォルトの回転軸は、このパーツの形状の中心に置く
                part.pivotOffset = computeGlbPartCenterOffset(part);
                part.pivotMarker = createGlbPartPivotMarker(part);
                glbMovableParts.push(part);
                break;
            }
        }
    });
    renderGlbPartsList();

    if (pendingGlbPartTransforms) {
        glbMovableParts.forEach((part) => {
            const saved = pendingGlbPartTransforms.find(t => t.name === part.name);
            if (saved) {
                // 旧形式 (pos) は無視 — 位置はモデルの初期位置固定
                if (saved.rot) part.object.rotation.set(saved.rot.x, saved.rot.y, saved.rot.z);
                if (typeof saved.invert === 'boolean') part.invert = saved.invert;
                if (saved.spinAxis) part.spinAxis = saved.spinAxis;
                if (typeof saved.disabled === 'boolean') part.disabled = saved.disabled;
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
    const card = document.createElement('div');
    card.className = 'sp-item-card';
    if (part.disabled) card.style.opacity = '0.5';
    card.innerHTML = `
        <div class="sp-item-header">
            <span class="sp-item-title">${part.label} : <span style="color:#aaa;font-size:10px;">${part.name}</span>${part.disabled ? ' <span style="color:#ff5555;">(機能停止中)</span>' : ''}</span>
            <button class="sp-remove-btn" style="${part.disabled ? 'background:rgba(0,255,204,0.1);border-color:#00ffcc;color:#00ffcc;' : ''}" onclick="toggleGlbPartDisabled('${part.id}')">${part.disabled ? '↺ 復活' : '⛔ 機能停止'}</button>
        </div>
        ${part.disabled ? '<div style="font-size:10px;color:#888;margin-bottom:4px;">このパーツはアニメーション・回転設定から除外されています。誤って選択した場合は「復活」で元に戻せます。</div>' : `
        <div class="sp-row" style="gap:6px;margin-bottom:4px;">
            <span class="sp-label" style="min-width:50px;">回転軸:</span>
            <label style="font-size:11px;cursor:pointer;"><input type="radio" name="axis-${part.id}" value="x" ${ax==='x'?'checked':''} onchange="setGlbPartAxis('${part.id}','x')"> X</label>
            <label style="font-size:11px;cursor:pointer;"><input type="radio" name="axis-${part.id}" value="y" ${ax==='y'?'checked':''} onchange="setGlbPartAxis('${part.id}','y')"> Y</label>
            <label style="font-size:11px;cursor:pointer;"><input type="radio" name="axis-${part.id}" value="z" ${ax==='z'?'checked':''} onchange="setGlbPartAxis('${part.id}','z')"> Z</label>
            <button class="sp-add-btn" style="flex:none;margin-left:auto;${part.invert?'color:#ff8866;':''}" onclick="toggleGlbPartInvert('${part.id}')">${part.invert?'🔁反転中':'🔁反転'}</button>
        </div>
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
        <div style="font-size:10px;color:#888;margin-bottom:4px;">${part.key === 'rudder' ? '舵角に連動して回転します。' : '船速に連動して回転します。'}</div>
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

    const propParts = glbMovableParts.filter(p => p.key === 'screw' || p.key === 'paddle');
    const rudderParts = glbMovableParts.filter(p => p.key === 'rudder');

    if (propList) {
        if (propParts.length === 0) {
            propList.innerHTML = '<div style="font-size:10px;color:#888;">スクリュー・外輪などの名前を持つパーツは見つかりませんでした。<br>(Blenderでオブジェクト名に "Screw" / "Paddle" などを含めてください)</div>';
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
}

function setGlbPartAxis(id, axis) {
    const part = glbMovableParts.find(p => p.id === id);
    if (!part) return;
    part.spinAxis = axis;
    part.spin = 0;
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
    // 回転軸はデフォルト（パーツの形状中心）に戻す
    part.pivotOffset = computeGlbPartCenterOffset(part);
    if (part.pivotMarker) part.pivotMarker.position.copy(part.basePos).add(part.pivotOffset);
    renderGlbPartsList();
}

