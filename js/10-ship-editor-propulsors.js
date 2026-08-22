// ========================================================
//  SETTINGS PANEL & GIZMO LOGIC
// ========================================================

let propulsors = [{ x: 0, y: -1.2, z: -7, size: 1.0, dir: 1 }];
let funnels    = [{ x: 0, y: 3.5, z: 0.5, rx: 0.4, ry: 1.2 }];
let rudder3DMesh = null;
let navLightMeshes = {};
let navLightsEnabled = true;
let propMeshes = [];
let smokeSettings = { density: 0.6, speed: 1.0, color: 'gray', speedLinked: true };

let currentGizmoTarget = null;
let currentGizmoType = null;
let currentGizmoIndex = -1;
let currentGizmoMode = 'translate';

function syncSettingsVisibility() {
    const isOpen = $('settings-panel').classList.contains('open');
    propMeshes.forEach(m => m.visible = isOpen);
    funnelMeshes3D.forEach(m => m.visible = isOpen);
    if (rudder3DMesh) rudder3DMesh.visible = isOpen;
    glbMovableParts.forEach(p => { if (p.pivotMarker) p.pivotMarker.visible = isOpen; });

    // 視点(見張り台)マーカーも設定パネルの開閉に合わせて表示/非表示
    Object.values(fixedViewpoints).forEach(fv => { if (fv.marker) fv.marker.visible = isOpen; });
    lookouts.forEach(l => { if (l.marker) l.marker.visible = isOpen; });

    // エリアライトの放射面ヘルパー・ワイヤーフレーム枠は設定パネルが開いている時だけ表示
    glbLights.forEach((light, i) => {
        // RectAreaLightHelper（旧式）
        if (light.isRectAreaLight && light.userData.helper) {
            light.userData.helper.visible = isOpen;
        }
        // エリアライト用ワイヤーフレーム枠
        if (light.userData.areaBoxHelper) {
            // 設定パネルが閉じているか、このライトが選択中でなければ非表示
            const isSelected = currentGizmoType === 'glb_arealight' && currentGizmoIndex === i;
            light.userData.areaBoxHelper.visible = isOpen && isSelected;
        }
    });

    // ギズモ自体はパネルを閉じたら強制的に無効化
    if (!isOpen && currentGizmoType) {
        disableGizmo();
    }

    // 海面（waterMesh）は「海面を表示する」設定に従う
    if (waterMesh) waterMesh.visible = userWaterVisible;
}

function toggleWaterVisibility() {
    userWaterVisible = $('water-visible-toggle').checked;
    if (waterMesh) waterMesh.visible = userWaterVisible;
}

function disableGizmo() {
    if (transformControl) { transformControl.detach(); transformControl.setMode('translate'); }
    if (currentGizmoType === 'decklight') selectedDecorLightIndex = -1;
    currentGizmoTarget = null; currentGizmoType = null; currentGizmoIndex = -1; currentGizmoMode = 'translate';
    document.querySelectorAll('.sp-gizmo-btn').forEach(btn => btn.classList.remove('active'));
    // 軸選択オーバーレイを隠す
    if (typeof hideRotateAxisOverlay === 'function') hideRotateAxisOverlay();
    // エリアライト枠を全非表示
    if (typeof hideAllAreaLightBoxHelpers === 'function') hideAllAreaLightBoxHelpers();
}

function toggleGizmo(type, index = -1, mode = 'translate') {
    let targetMesh = null;
    let btnId = `gizmo-${type}`;

    if (type === 'pivot' && importedModelGroup && importedModelGroup.children[0]) targetMesh = importedModelGroup.children[0];
    else if (type === 'cg') targetMesh = cgMarker;
    else if (type === 'rudder') targetMesh = rudderMarker;
    else if (type === 'propulsion') { targetMesh = propMeshes.find(m => m.userData.propIndex === index && !m.userData.isMirror); btnId = `gizmo-prop-${index}`; }
    else if (type === 'funnel') { targetMesh = funnelMeshes3D.find(m => m.userData.funnelIndex === index && !m.userData.isMirror); btnId = `gizmo-funnel-${index}`; }
    else if (type === 'funnel_uplight') {
        // index は "0_L" / "0_R" のような文字列（煙突番号_サイド）
        const parts = String(index).split('_');
        const fi = parseInt(parts[0]);
        const side = parts[1];
        const entry = funnelUplights.find(u => u.funnelIndex === fi && !u.isMirror);
        if (entry) {
            targetMesh = side === 'L' ? entry.markerL : entry.markerR;
            btnId = `gizmo-funnel-uplight-${index}`;
        }
        mode = 'rotate'; // 角度調整のみなので回転モード固定
    }
    else if (type === 'nav_port') targetMesh = navLightMeshes.port;
    else if (type === 'nav_mastFore') targetMesh = navLightMeshes.mastFore;
    else if (type === 'nav_mastAft') targetMesh = navLightMeshes.mastAft;
    else if (type === 'nav_stern') targetMesh = navLightMeshes.stern;
    else if (type === 'glbpart') {
        const part = glbMovableParts.find(p => p.id === index);
        if (part) { targetMesh = part.object; btnId = `gizmo-glbpart-${index}-${mode}`; }
    }
    else if (type === 'glbpart_pivot') {
        const part = glbMovableParts.find(p => p.id === index);
        if (part) { targetMesh = part.pivotMarker; btnId = `gizmo-glbpart-pivot-${index}`; }
    }
    else if (type === 'glb_arealight') {
        const light = glbLights[index];
        if (light && (light.isRectAreaLight || light.userData.isAreaLight)) {
            // 全モードで areaNode を操作（translate も areaNode ＋ light を同期）
            targetMesh = (light.userData.areaNode) ? light.userData.areaNode : light;
            btnId = `gizmo-alight-${index}-${mode}`;
            // 選択時にワイヤーフレーム枠を生成・表示
            if (typeof createAreaLightBoxHelper === 'function') createAreaLightBoxHelper(light);
            if (typeof showAreaLightBoxHelper === 'function') showAreaLightBoxHelper(index);
        }
    }
    else if (type === 'decklight') {
        // index: decorLightsの番号。groupをターゲットにする
        if (decorLights[index]) {
            targetMesh = decorLights[index].group;
            btnId = `gizmo-decklight-${index}`;
        }
    }
    else if (type === 'viewpoint_fixed') {
        const fv = fixedViewpoints[index];
        if (fv) { targetMesh = fv.marker; btnId = `gizmo-viewpoint_fixed-${index}`; }
    }
    else if (type === 'viewpoint_lookout') {
        const entry = lookouts[index];
        if (entry) { targetMesh = entry.marker; btnId = `gizmo-viewpoint_lookout-${index}`; }
    }

    if (!targetMesh) return;

    if (currentGizmoTarget === targetMesh && currentGizmoMode === mode) {
        disableGizmo();
    } else {
        disableGizmo();
        transformControl.setSpace('local');
        transformControl.setMode(mode);
        transformControl.attach(targetMesh);
        currentGizmoTarget = targetMesh;
        currentGizmoType = type;
        currentGizmoIndex = index;
        currentGizmoMode = mode;
        if (type === 'decklight') selectedDecorLightIndex = index;

        // rotateモードのとき軸選択オーバーレイを表示
        if (mode === 'rotate') {
            showRotateAxisOverlay();
        }

        const btn = $(btnId);
        if (btn) btn.classList.add('active');
    }
}

function onGizmoChange() {
    if (!currentGizmoTarget) return;
    const pos = currentGizmoTarget.position;

    if (currentGizmoType === 'pivot') {
        const _old = (typeof _captureModelOffsetTransform === 'function') ? _captureModelOffsetTransform() : null;
        modelOffset.x = pos.x; modelOffset.y = pos.y; modelOffset.z = pos.z;
        if (_old && typeof reanchorReferencePointsToModelOffset === 'function') reanchorReferencePointsToModelOffset(_old);
        $('offx-num').value = pos.x.toFixed(2); $('slider-offx').value = pos.x;
        $('offy-num').value = pos.y.toFixed(2); $('slider-offy').value = pos.y;
        $('offz-num').value = pos.z.toFixed(2); $('slider-offz').value = pos.z;
    } 
    else if (currentGizmoType === 'cg') {
        const _oldPin = (typeof _currentPinOffsetScaled === 'function') ? _currentPinOffsetScaled() : null;
        physics.cgOffset.x = pos.x; physics.cgOffset.y = pos.y; physics.cgOffset.z = pos.z;
        if (_oldPin && typeof reanchorWorldPositionForPinOffsetChange === 'function') {
            reanchorWorldPositionForPinOffsetChange(_oldPin, _currentPinOffsetScaled());
        }
        $('cgx-num').value = pos.x.toFixed(2); $('cgx-slider').value = pos.x;
        $('cgy-num').value = pos.y.toFixed(2); $('cgy-slider').value = pos.y;
        $('cgz-num').value = pos.z.toFixed(2); $('cgz-slider').value = pos.z;
    }
    else if (currentGizmoType === 'rudder') {
        physics.rudderOffset.x = pos.x; physics.rudderOffset.y = pos.y; physics.rudderOffset.z = pos.z;
        $('rudx-num').value = pos.x.toFixed(2); $('rudx-slider').value = pos.x;
        $('rudy-num').value = pos.y.toFixed(2); $('rudy-slider').value = pos.y;
        $('rudz-num').value = pos.z.toFixed(2); $('rudz-slider').value = pos.z;
        if (rudder3DMesh) rudder3DMesh.position.copy(pos);
    }
    else if (currentGizmoType === 'propulsion' && currentGizmoIndex >= 0) {
        propulsors[currentGizmoIndex].x = pos.x;
        propulsors[currentGizmoIndex].y = pos.y;
        propulsors[currentGizmoIndex].z = pos.z;
        const ix = $(`prop-x-${currentGizmoIndex}`); if(ix) ix.value = pos.x.toFixed(2);
        const iy = $(`prop-y-${currentGizmoIndex}`); if(iy) iy.value = pos.y.toFixed(2);
        const iz = $(`prop-z-${currentGizmoIndex}`); if(iz) iz.value = pos.z.toFixed(2);
        const sym = $('prop-symmetry') && $('prop-symmetry').checked;
        if (sym) {
            const mirror = propMeshes.find(m => m.userData.propIndex === currentGizmoIndex && m.userData.isMirror);
            if (mirror) mirror.position.set(-pos.x, pos.y, pos.z);
        }
    }
    else if (currentGizmoType === 'funnel' && currentGizmoIndex >= 0) {
        funnels[currentGizmoIndex].x = pos.x;
        funnels[currentGizmoIndex].y = pos.y;
        funnels[currentGizmoIndex].z = pos.z;
        const ix = $(`funnel-x-${currentGizmoIndex}`); if(ix) ix.value = pos.x.toFixed(2);
        const iy = $(`funnel-y-${currentGizmoIndex}`); if(iy) iy.value = pos.y.toFixed(2);
        const iz = $(`funnel-z-${currentGizmoIndex}`); if(iz) iz.value = pos.z.toFixed(2);

        const sym = $('funnel-symmetry') && $('funnel-symmetry').checked;
        if (sym) {
            const mirror = funnelMeshes3D.find(m => m.userData.funnelIndex === currentGizmoIndex && m.userData.isMirror);
            if (mirror) mirror.position.set(-pos.x, pos.y, pos.z);
        }
    }
    else if (currentGizmoType.startsWith('nav_')) {
        const typeId = currentGizmoType.replace('nav_', '');
        if (typeId === 'port') {
            const isSym = $('navlight-side-symmetry').checked;
            let valX = isSym ? Math.abs(pos.x) : pos.x;
            $('navlight-side-x').value = valX.toFixed(2);
            $('navlight-side-y').value = pos.y.toFixed(2);
            $('navlight-side-z').value = pos.z.toFixed(2);

            let sideArc = spVal('navlight-side-angle');
            if (!Number.isFinite(sideArc) || sideArc <= 0) sideArc = NAV_LIGHT_REGS.sideArcDefault;
            sideArc = THREE.MathUtils.clamp(sideArc, NAV_LIGHT_REGS.sideArcMin, NAV_LIGHT_REGS.sideArcMax);
            const halfArcRad = THREE.MathUtils.degToRad(sideArc / 2);

            const portDir = sideLightDir(1, halfArcRad);
            currentGizmoTarget.userData.spot.target.position.set(pos.x + portDir.x * 3, pos.y, pos.z + portDir.z * 3);
            if (isSym && navLightMeshes.stbd) {
                navLightMeshes.stbd.position.set(-valX, pos.y, pos.z);
                const stbdDir = sideLightDir(-1, halfArcRad);
                navLightMeshes.stbd.userData.spot.target.position.set(-valX + stbdDir.x * 3, pos.y, pos.z + stbdDir.z * 3);
            }
        }
        else if (typeId === 'mastFore') {
            $('mast-fore-x').value = pos.x.toFixed(2); $('mast-fore-y').value = pos.y.toFixed(2); $('mast-fore-z').value = pos.z.toFixed(2);
            currentGizmoTarget.userData.spot.target.position.set(pos.x, pos.y - 3, pos.z + 10);
        }
        else if (typeId === 'mastAft') {
            $('mast-aft-x').value = pos.x.toFixed(2); $('mast-aft-y').value = pos.y.toFixed(2); $('mast-aft-z').value = pos.z.toFixed(2);
            currentGizmoTarget.userData.spot.target.position.set(pos.x, pos.y - 3, pos.z + 10);
        }
        else if (typeId === 'stern') {
            $('sternlight-x').value = pos.x.toFixed(2); $('sternlight-y').value = pos.y.toFixed(2); $('sternlight-z').value = pos.z.toFixed(2);
            currentGizmoTarget.userData.spot.target.position.set(pos.x, pos.y - 1, pos.z - 5);
        }
    }
    else if (currentGizmoType === 'glbpart') {
        // transformControl が直接 position/rotation を書き換えるので、3Dビューは自動更新される。
        // 何もしなくて良い（必要なら将来ここで保存用データを更新する）。
    }
    else if (currentGizmoType === 'glb_arealight') {
        const i = currentGizmoIndex;
        const light = glbLights[i];
        if (!light) return;
        const anode = light.userData.areaNode;

        if (currentGizmoMode === 'translate') {
            // areaNode が動く → light も同期（areaNode と light は同じ親のLocal座標）
            if (anode) {
                light.position.copy(anode.position);
                const ix = $(`alight-x-${i}`); if (ix) ix.value = anode.position.x.toFixed(2);
                const iy = $(`alight-y-${i}`); if (iy) iy.value = anode.position.y.toFixed(2);
                const iz = $(`alight-z-${i}`); if (iz) iz.value = anode.position.z.toFixed(2);
            } else {
                const ix = $(`alight-x-${i}`); if (ix) ix.value = pos.x.toFixed(2);
                const iy = $(`alight-y-${i}`); if (iy) iy.value = pos.y.toFixed(2);
                const iz = $(`alight-z-${i}`); if (iz) iz.value = pos.z.toFixed(2);
            }
            if (light.userData.symmetry && light.userData.mirrorLight) {
                const lp = light.position;
                light.userData.mirrorLight.position.set(-lp.x, lp.y, lp.z);
            }
        } else if (currentGizmoMode === 'rotate' && anode) {
            // areaNode.rotation が動く → UI反映
            const r = anode.rotation;
            const toDeg = THREE.MathUtils.radToDeg;
            const rx = $(`alight-rx-${i}`); if (rx) rx.value = toDeg(r.x).toFixed(1);
            const ry = $(`alight-ry-${i}`); if (ry) ry.value = toDeg(r.y).toFixed(1);
            const rz = $(`alight-rz-${i}`); if (rz) rz.value = toDeg(r.z).toFixed(1);
        } else if (currentGizmoMode === 'scale' && anode) {
            // areaNode.scale が動く → UI反映（X=幅,Y=高さ）
            const sw = $(`alight-w-${i}`); if (sw) sw.value = anode.scale.x.toFixed(2);
            const sh = $(`alight-h-${i}`); if (sh) sh.value = anode.scale.z.toFixed(2); // Z=高さ
        }
    }
    else if (currentGizmoType === 'funnel_uplight') {
        updateFunnelUplightAim(currentGizmoTarget);
        // 回転を funnels[] データへ保存（次回 buildFunnelMeshes 時に復元するため）
        const parts = String(currentGizmoIndex).split('_');
        const fi = parseInt(parts[0]);
        const side = parts[1];
        const f = funnels[fi];
        if (f) {
            const r = currentGizmoTarget.rotation;
            f[side === 'L' ? 'upRotL' : 'upRotR'] = { x: r.x, y: r.y, z: r.z };
        }
    }
    else if (currentGizmoType === 'decklight') {
        // position/scale をUIの数値欄に反映
        const i = currentGizmoIndex;
        const ix = $('dl-spot-x'); if (ix) ix.value = pos.x.toFixed(2);
        const iy = $('dl-spot-y'); if (iy) iy.value = pos.y.toFixed(2);
        const iz = $('dl-spot-z'); if (iz) iz.value = pos.z.toFixed(2);
        // スポットリストの座標表示を更新（毎フレームは重いのでここだけ更新）
        updateDeckLightPoolStatus();
    }
    else if (currentGizmoType === 'glbpart_pivot') {
        const part = glbMovableParts.find(p => p.id === currentGizmoIndex);
        if (part) {
            part.pivotOffset.copy(pos).sub(part.basePos);
            const ix = $(`pivot-x-${part.id}`); if (ix) ix.value = part.pivotOffset.x.toFixed(3);
            const iy = $(`pivot-y-${part.id}`); if (iy) iy.value = part.pivotOffset.y.toFixed(3);
            const iz = $(`pivot-z-${part.id}`); if (iz) iz.value = part.pivotOffset.z.toFixed(3);
        }
    }
    else if (currentGizmoType === 'viewpoint_fixed') {
        if (typeof renderFixedViewpointList === 'function') renderFixedViewpointList();
    }
    else if (currentGizmoType === 'viewpoint_lookout') {
        if (typeof renderLookoutList === 'function') renderLookoutList();
    }
}

function spVal(id) { const el = $(id); return el ? parseFloat(el.value) : 0; }
function spAdjDirect(id, delta, minV, maxV) {
    const el = $(id); if (!el) return;
    let v = parseFloat(el.value) + delta;
    v = Math.max(minV, Math.min(maxV, v));
    el.value = v.toFixed(2);
    el.dispatchEvent(new Event('input'));
}
function spAdj(sliderId, numId, delta) {
    const slider = $(sliderId), num = $(numId); if (!slider || !num) return;
    let v = parseFloat(slider.value) + delta;
    v = Math.max(parseFloat(slider.min), Math.min(parseFloat(slider.max), v));
    const decimals = String(parseFloat(slider.step)).includes('.') ? String(parseFloat(slider.step)).split('.')[1].length : 0;
    v = Number(v.toFixed(decimals));
    slider.value = v; num.value = v;
    slider.dispatchEvent(new Event('input'));
}

// ── X/Y/Z軸 平面ビュー（Blenderの上面/正面/側面ビューに相当） ──────────
// 「自由」以外を選ぶと、本物の正投影(Orthographic)カメラに切り替えて遠近感を
// 完全に排除した平面的な見え方にする（Blenderのテンキー視点と同じ考え方）。
// 同じ軸のボタンをもう一度押すと、反対方向（裏側）からの視点になる。
// 回転(rotate)だけを無効化してパン/ズームのみ許可する。船体設定パネルが
// 開いている間（isDesignMode）のカメラ追従ロジックにそのまま乗るため、
// 船が揺れてもビューはズレない。
let axisViewMode = null; // null(自由) | 'top' | 'front' | 'side'
let axisViewFlipped = false; // true=同じ軸ボタンを連続で押し、反対方向から見ている状態
const AXISVIEW_DEFAULT_FOV = 50;
const WORLD_UP = new THREE.Vector3(0, 1, 0);
let orthoHalfHeight = 50; // 正投影カメラの縦方向の半サイズ（リサイズ時のアスペクト再計算用に保持）

function setAxisView(mode) {
    if (!camera || !controls || !shipGroup) return;
    document.querySelectorAll('.sp-axisview-btn').forEach(b => b.classList.remove('active'));

    if (mode !== 'top' && mode !== 'front' && mode !== 'side') mode = 'free';

    if (mode === 'free') {
        axisViewMode = null;
        axisViewFlipped = false;
        controls.enableRotate = true;

        // 正投影カメラから元の透視投影カメラへ戻す（OrbitControls / TransformControls /
        // ブルームのRenderPassが参照しているカメラも、漏れなく揃えて切り替える）
        camera = perspCamera;
        controls.object = camera;
        if (transformControl) transformControl.camera = camera;
        if (bloomRenderPass) bloomRenderPass.camera = camera;

        camera.fov = AXISVIEW_DEFAULT_FOV;
        camera.up.copy(WORLD_UP); // ここでupを世界基準に戻さないと、以後ずっと向きがおかしくなる
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        const btn = $('axisview-free'); if (btn) btn.classList.add('active');
        return;
    }

    // 同じ軸のボタンをもう一度押した場合は、反対方向（裏側）から見るフラグを反転する
    axisViewFlipped = (axisViewMode === mode) ? !axisViewFlipped : false;
    axisViewMode = mode;
    controls.enableRotate = false;

    // 船体の現在のワールド空間バウンディングスフィアから、画角に収まるサイズを毎回計算する
    // （固定サイズだと船が大きいときに見切れる／小さいときに余白が大きすぎる、を防ぐ）
    const box = new THREE.Box3().setFromObject(shipGroup);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const target = sphere.center.clone();
    const radius = Math.max(sphere.radius, 1 * physics.scale);
    const dist = radius * 3; // 正投影では見た目の大きさに影響しないが、near/farクリップ回避のため離しておく

    // 船自身のローカル軸（船首=+Z, 右舷=+X, 上=+Y）を、現在の船の向き(heading)で
    // ワールド空間へ変換する。これによりワールド座標ではなく「船の座標」基準のビューになる。
    const shipQuat = shipGroup.quaternion;
    const shipForward = new THREE.Vector3(0, 0, 1).applyQuaternion(shipQuat); // 船首方向
    const shipRight   = new THREE.Vector3(1, 0, 0).applyQuaternion(shipQuat); // 右舷方向
    const shipUp      = new THREE.Vector3(0, 1, 0).applyQuaternion(shipQuat); // 船の上方向

    const dirSign = axisViewFlipped ? -1 : 1; // 2回目クリックで反対側から
    const pos = new THREE.Vector3();
    const up = new THREE.Vector3();
    if (mode === 'top') {
        pos.copy(target).addScaledVector(shipUp, dist * dirSign).addScaledVector(shipForward, 0.001); // gimbal lock回避の微小オフセット
        up.copy(shipForward); // 船首が画面の上を向くように（上面/底面とも共通）
    } else if (mode === 'front') {
        pos.copy(target).addScaledVector(shipForward, dist * dirSign); // 船首側 → (2回押すと)船尾側から
        up.copy(shipUp);
    } else if (mode === 'side') {
        pos.copy(target).addScaledVector(shipRight, dist * dirSign); // 右舷側 → (2回押すと)左舷側から
        up.copy(shipUp);
    }

    // 正投影カメラへ切り替え（遠近感を完全に排除して平面に見せる。OrbitControls /
    // TransformControls / ブルームのRenderPassが参照しているカメラも揃えて切り替える）
    camera = orthoCamera;
    controls.object = camera;
    if (transformControl) transformControl.camera = camera;
    if (bloomRenderPass) bloomRenderPass.camera = camera;

    orthoHalfHeight = radius * 1.15; // 船全体が収まるよう少し余白を持たせる
    const aspect = window.innerWidth / window.innerHeight;
    camera.left = -orthoHalfHeight * aspect;
    camera.right = orthoHalfHeight * aspect;
    camera.top = orthoHalfHeight;
    camera.bottom = -orthoHalfHeight;
    camera.near = 0.1;
    camera.far = dist * 2 + radius * 4;
    camera.zoom = 1; // 軸切替のたびにズームをリセットし、毎回同じ見え方にする
    camera.up.copy(up);
    camera.position.copy(pos);
    controls.target.copy(target);
    camera.updateProjectionMatrix();
    camera.lookAt(target); // OrbitControls側の up 追従が遅れても向きを確実に合わせる
    controls.update();

    const btn = $('axisview-' + mode); if (btn) btn.classList.add('active');
}
window.setAxisView = setAxisView;

function toggleSettings() {
    const panel = $('settings-panel');
    const isOpen = panel.classList.toggle('open');
    
    if (isOpen) {
        if (cgMarker) cgMarker.visible = true;
        if (rudderMarker) rudderMarker.visible = true;
        
        const rotY = (physics.heading * Math.PI) / 180;
        const offsetDir = new THREE.Vector3(12 * physics.scale, 8 * physics.scale, 18 * physics.scale);
        offsetDir.applyAxisAngle(new THREE.Vector3(0,1,0), rotY);
        
        camera.position.set(physics.cgWorldX + offsetDir.x, physics.y + offsetDir.y, physics.cgWorldZ + offsetDir.z);
        controls.target.set(physics.cgWorldX, physics.y, physics.cgWorldZ);
        controls.update();
    } else {
        disableGizmo();
        if (cgMarker) cgMarker.visible = false;
        if (rudderMarker) rudderMarker.visible = false;
        setAxisView('free');
    }
    syncSettingsVisibility();
}

// 視点モード: follow（現状・追従）→ chase（固定視点：角度・距離が変わらない）→ free（自由視点）
// → viewpoint（見張り台。専用メニューから選択。サイクルボタンでは選ばれず、抜けるときだけ使う）
const CAMERA_MODE_LABELS = { follow: '📷 視点: 通常', chase: '📷 視点: 固定', free: '📷 視点: 自由', viewpoint: '📷 視点: 見張り台' };
const CAMERA_MODE_ORDER = ['follow', 'chase', 'free'];

function cycleCameraMode() {
    const idx = CAMERA_MODE_ORDER.indexOf(cameraMode);
    cameraMode = CAMERA_MODE_ORDER[(idx + 1) % CAMERA_MODE_ORDER.length];
    if (viewpointActiveKey) {
        // 見張り台視点から通常サイクルへ抜けた場合は選択状態を解除
        viewpointActiveKey = null;
        if (typeof renderViewpointMenu === 'function') renderViewpointMenu();
    }
    window.lastChaseHeadingRot = undefined; // chaseモードに入ったときの旋回ジャンプを防ぐ
    const btn = $('camera-mode-toggle');
    if (btn) btn.innerText = CAMERA_MODE_LABELS[cameraMode] || CAMERA_MODE_LABELS.follow;
}

function switchTab(name) {
    disableGizmo(); 
    document.querySelectorAll('.settings-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.settings-page').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
    // 照明タブを開いたときにGLBライトリストを更新
    if (name === 'lighting' && typeof updateGlbLightsUI === 'function') {
        updateGlbLightsUI();
    }
    // 視点タブを開いたときに固定/見張り台リストを更新
    if (name === 'viewpoint') {
        if (typeof renderFixedViewpointList === 'function') renderFixedViewpointList();
        if (typeof renderLookoutList === 'function') renderLookoutList();
    }
}

function addPropulsor() {
    propulsors.push({ x: 0, y: -1.2, z: -7, size: 1.0, dir: 1 });
    renderPropList();
    buildPropMeshes();
}
function removePropulsor(i) {
    disableGizmo();
    propulsors.splice(i, 1);
    renderPropList();
    buildPropMeshes();
}
function copyPropulsor(i) {
    const src = propulsors[i];
    propulsors.push({ x: src.x, y: src.y, z: src.z, size: src.size, dir: src.dir, mirrorDir: src.mirrorDir });
    renderPropList();
    buildPropMeshes();
}
function updatePropulsionType() { disableGizmo(); buildPropMeshes(); }

function renderPropList() {
    const list = $('prop-list'); if (!list) return;
    const sym = $('prop-symmetry') && $('prop-symmetry').checked;
    list.innerHTML = '';
    propulsors.forEach((p, i) => {
        p.dir = p.dir || 1; 
        const card = document.createElement('div');
        card.className = 'sp-item-card';
        card.innerHTML = `
            <div class="sp-item-header">
                <span class="sp-item-title">
                    推進器 #${i+1}${sym && p.x !== 0 ? ' (対称)' : ''}
                    <button class="sp-gizmo-btn" id="gizmo-prop-${i}" onclick="toggleGizmo('propulsion', ${i})">📍 ギズモ</button>
                    <button class="sp-gizmo-btn" onclick="copyPropulsor(${i})">⧉ コピー</button>
                </span>
                <button class="sp-remove-btn" onclick="removePropulsor(${i})">✕</button>
            </div>
            <div class="sp-xyz-row">
                <span class="sp-axis-label">X:</span>
                <input type="number" id="prop-x-${i}" class="sp-xyz-input" value="${p.x}" step="0.1"
                    oninput="propulsors[${i}].x=parseFloat(this.value)||0;buildPropMeshes();">
                <span class="sp-axis-label">Y:</span>
                <input type="number" id="prop-y-${i}" class="sp-xyz-input" value="${p.y}" step="0.1"
                    oninput="propulsors[${i}].y=parseFloat(this.value)||0;buildPropMeshes();">
                <span class="sp-axis-label">Z:</span>
                <input type="number" id="prop-z-${i}" class="sp-xyz-input" value="${p.z}" step="0.1"
                    oninput="propulsors[${i}].z=parseFloat(this.value)||0;buildPropMeshes();">
            </div>
            <div class="sp-row" style="margin-bottom: 5px;">
                <span class="sp-label">回転:</span>
                <select id="prop-dir-${i}" onchange="propulsors[${i}].dir=parseInt(this.value);buildPropMeshes();" style="flex:1;background:#0a1932;color:#00ffcc;border:1px solid #00ffcc;border-radius:4px;padding:2px;font-size:10px;">
                    <option value="1" ${p.dir !== -1 ? 'selected' : ''}>正転 (CW)</option>
                    <option value="-1" ${p.dir === -1 ? 'selected' : ''}>逆転 (CCW)</option>
                </select>
            </div>
            ${sym && Math.abs(p.x) > 0.05 ? `
            <div class="sp-row" style="margin-bottom: 5px;">
                <span class="sp-label">対称側回転:</span>
                <select id="prop-mirrordir-${i}" onchange="propulsors[${i}].mirrorDir=parseInt(this.value);buildPropMeshes();" style="flex:1;background:#0a1932;color:#00ffcc;border:1px solid #00ffcc;border-radius:4px;padding:2px;font-size:10px;">
                    <option value="${-p.dir}" ${(p.mirrorDir === undefined || p.mirrorDir === -p.dir) ? 'selected' : ''}>逆回転 (既定)</option>
                    <option value="${p.dir}" ${p.mirrorDir === p.dir ? 'selected' : ''}>同回転</option>
                </select>
            </div>` : ''}
            <div class="sp-row">
                <span class="sp-label">サイズ:</span>
                <input type="range" class="sp-slider" min="0.2" max="3" step="0.05" value="${p.size}"
                    oninput="propulsors[${i}].size=parseFloat(this.value);this.nextElementSibling.value=this.value;buildPropMeshes();">
                <input type="number" class="sp-num-input" min="0.2" max="3" step="0.05" value="${p.size}"
                    oninput="propulsors[${i}].size=parseFloat(this.value);buildPropMeshes();">
            </div>`;
        list.appendChild(card);
    });
    addFineTuneButtons(list);
}

function buildPropMeshes() {
    let oldType = currentGizmoType;
    let oldIndex = currentGizmoIndex;
    
    propMeshes.forEach(m => { if (m.parent) m.parent.remove(m); });
    propMeshes = [];
    if (!shipGroup) return;

    const type = $('prop-type') ? $('prop-type').value : 'screw';
    const sym  = $('prop-symmetry') && $('prop-symmetry').checked;

    const mat = new THREE.MeshStandardMaterial({ color: 0x888899, roughness: 0.4, metalness: 0.8 });

    function makeScrew(x, y, z, size) {
        const g = new THREE.Group();
        const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.12 * size, 0.12 * size, 0.25 * size, 10), mat);
        hub.rotation.x = Math.PI / 2;
        g.add(hub);
        const bladeCount = 4;
        for (let b = 0; b < bladeCount; b++) {
            const blade = new THREE.Mesh(
                new THREE.BoxGeometry(0.08 * size, 0.5 * size, 0.15 * size),
                mat
            );
            const angle = (b / bladeCount) * Math.PI * 2;
            blade.position.set(Math.cos(angle) * 0.3 * size, Math.sin(angle) * 0.3 * size, 0);
            blade.rotation.z = angle + 0.3;
            g.add(blade);
        }
        g.position.set(x, y, z);
        g.userData.isProp = true;
        return g;
    }

    function makePaddleWheel(x, y, z, size) {
        const g = new THREE.Group();
        const rimMat = new THREE.MeshStandardMaterial({ color: 0x8b5e3c, roughness: 0.6 });
        const rimGeo = new THREE.TorusGeometry(size * 0.7, 0.05 * size, 8, 24);
        const rimL = new THREE.Mesh(rimGeo, rimMat);
        rimL.position.z = -0.25 * size;
        rimL.rotation.x = Math.PI / 2;
        g.add(rimL);
        const rimR = rimL.clone();
        rimR.position.z = 0.25 * size;
        g.add(rimR);
        const paddleCount = 10;
        for (let b = 0; b < paddleCount; b++) {
            const angle = (b / paddleCount) * Math.PI * 2;
            const paddle = new THREE.Mesh(
                new THREE.BoxGeometry(0.1 * size, 0.3 * size, 0.45 * size),
                rimMat
            );
            paddle.position.set(Math.cos(angle) * 0.65 * size, Math.sin(angle) * 0.65 * size, 0);
            paddle.rotation.z = angle;
            g.add(paddle);
        }
        g.position.set(x, y, z);
        g.userData.isProp = true;
        return g;
    }

    function makeAzipod(x, y, z, size) {
        const g = new THREE.Group();
        const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.18 * size, 0.18 * size, 0.8 * size, 10), mat);
        pod.rotation.x = Math.PI / 2;
        g.add(pod);
        const strut = new THREE.Mesh(new THREE.BoxGeometry(0.12 * size, 0.35 * size, 0.12 * size), mat);
        strut.position.y = 0.4 * size;
        g.add(strut);
        const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.08 * size, 0.08 * size, 0.15 * size, 8), mat);
        hub.rotation.x = Math.PI / 2;
        hub.position.z = -0.5 * size;
        g.add(hub);
        g.position.set(x, y, z);
        g.userData.isProp = true;
        return g;
    }

    const spawn = (x, y, z, size, dir, propIndex, isMirror) => {
        let mesh;
        if (type === 'paddlewheel') mesh = makePaddleWheel(x, y, z, size);
        else if (type === 'azipod') mesh = makeAzipod(x, y, z, size);
        else mesh = makeScrew(x, y, z, size);
        mesh.userData.dir = dir;
        mesh.userData.propIndex = propIndex;
        mesh.userData.isMirror = !!isMirror;
        mesh.traverse((c) => { if (c.isMesh) c.userData.noBloom = true; });
        shipGroup.add(mesh);
        propMeshes.push(mesh);
    };

    propulsors.forEach((p, i) => {
        const dir = p.dir || 1;
        spawn(p.x, p.y, p.z, p.size, dir, i, false);
        if (sym && Math.abs(p.x) > 0.05) {
            const mirrorDir = Number.isFinite(p.mirrorDir) ? p.mirrorDir : -dir;
            spawn(-p.x, p.y, p.z, p.size, mirrorDir, i, true);
        }
    });

    if (oldType === 'propulsion') {
        const target = propMeshes.find(m => m.userData.propIndex === oldIndex && !m.userData.isMirror);
        if (target) {
            transformControl.attach(target);
            currentGizmoTarget = target;
        } else {
            disableGizmo();
        }
    }
    syncSettingsVisibility();
}

function updateRudder3D() {
    if (rudder3DMesh) { shipGroup.remove(rudder3DMesh); rudder3DMesh = null; }
    const w = spVal('rudder-width'), h = spVal('rudder-height'), d = spVal('rudder-depth');
    const mat = new THREE.MeshStandardMaterial({ color: 0x445566, roughness: 0.5, metalness: 0.6 });
    rudder3DMesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    rudder3DMesh.userData.noBloom = true;
    rudder3DMesh.position.set(physics.rudderOffset.x, physics.rudderOffset.y, physics.rudderOffset.z);
    if (shipGroup) shipGroup.add(rudder3DMesh);
    syncSettingsVisibility();
}

