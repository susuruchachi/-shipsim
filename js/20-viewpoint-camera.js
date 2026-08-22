'use strict';

// ============================================================
//  視点(見張り台)カメラシステム (Viewpoint / Lookout Camera)
// ============================================================
// 固定スロット6種（船首／船尾船橋／船首見張り台(左右)／船尾見張り台(左右)）に加え、
// 任意の数の「見張り台」を追加配置できる。
// いずれもshipGroupの子ノード(マーカー)として配置するため、船の移動・旋回・
// 横揺れ/縦揺れ(roll/pitch)に自動追従する。
// cameraMode === 'viewpoint' のとき、main-loop側でこのマーカーのワールド座標・
// 向きをカメラへコピーし、OrbitControlsは無効化してドラッグでヨー/ピッチの
// 自由見回し（viewpointYaw / viewpointPitch）を行う。

const FIXED_VIEWPOINT_DEFS = [
    { key: 'bow',              label: '船首',            color: 0xffaa00, pos: { x: 0,    y: 3.0, z: 10 } },
    { key: 'sternBridge',      label: '船尾船橋',         color: 0x3399ff, pos: { x: 0,    y: 6.0, z: -8 } },
    { key: 'lookoutBowPort',   label: '船首見張り台(左)',  color: 0xff4444, pos: { x: -2.5, y: 4.0, z: 8 } },
    { key: 'lookoutBowStbd',   label: '船首見張り台(右)',  color: 0x44ff44, pos: { x: 2.5,  y: 4.0, z: 8 } },
    { key: 'lookoutSternPort', label: '船尾見張り台(左)',  color: 0xff4444, pos: { x: -2.5, y: 5.0, z: -8 } },
    { key: 'lookoutSternStbd', label: '船尾見張り台(右)',  color: 0x44ff44, pos: { x: 2.5,  y: 5.0, z: -8 } },
];

const fixedViewpoints = {};   // key -> { marker: THREE.Object3D }
const lookouts = [];          // 任意数の追加見張り台: { marker, name }

let viewpointActiveKey = null; // null=視点モード未選択 / 'bow' など / 'lookout_<i>'
let viewpointYaw   = 0;        // 自由見回し ヨー(rad)。ドラッグで変化、視点切替時に0へリセット
let viewpointPitch = 0;        // 自由見回し ピッチ(rad)
let _lookoutAutoId = 1;

// 視点モード一覧で使うラベル（main camera-mode-toggleボタン表示用）
if (typeof window !== 'undefined') window.VIEWPOINT_MODE_LABEL = '📷 視点: 見張り台';

function _makeViewpointMarker(color, geo) {
    const marker = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, depthTest: false }));
    marker.visible = false;
    marker.renderOrder = 999;
    marker.userData.isViewpointMarker = true; // setCustomModelでの一括削除から除外するためのタグ
    return marker;
}

function createViewpointMarkers() {
    if (!shipGroup) return;
    FIXED_VIEWPOINT_DEFS.forEach(def => {
        const geo = new THREE.ConeGeometry(0.18, 0.4, 8);
        const marker = _makeViewpointMarker(def.color, geo);
        marker.rotation.x = Math.PI; // 先端を下にして「目の位置」を示す
        marker.position.set(def.pos.x, def.pos.y, def.pos.z);
        marker.userData.viewpointLabel = def.label;
        shipGroup.add(marker);
        fixedViewpoints[def.key] = { marker };
    });
    renderFixedViewpointList();
    renderViewpointMenu();
}

// ── 任意数の見張り台 ──────────────────────────────────────────
function addLookoutPoint(x, y, z, name) {
    if (!shipGroup) return null;
    x = Number.isFinite(x) ? x : 0;
    y = Number.isFinite(y) ? y : 5;
    z = Number.isFinite(z) ? z : 0;
    const marker = _makeViewpointMarker(0xffff33, new THREE.OctahedronGeometry(0.2, 0));
    marker.position.set(x, y, z);
    const panelOpen = $('settings-panel') && $('settings-panel').classList.contains('open');
    marker.visible = !!panelOpen;
    shipGroup.add(marker);
    const entry = { marker, name: (name && String(name).trim()) || `見張り台 ${_lookoutAutoId++}` };
    lookouts.push(entry);
    renderLookoutList();
    renderViewpointMenu();
    return entry;
}

function addLookoutFromUI() {
    const x = parseFloat($('vp-add-x').value) || 0;
    const y = parseFloat($('vp-add-y').value) || 5;
    const z = parseFloat($('vp-add-z').value) || 0;
    addLookoutPoint(x, y, z, null);
}

function removeLookoutPoint(i) {
    const entry = lookouts[i];
    if (!entry) return;
    if (currentGizmoType === 'viewpoint_lookout' && currentGizmoIndex === i) disableGizmo();
    if (entry.marker.parent) entry.marker.parent.remove(entry.marker);
    lookouts.splice(i, 1);
    if (currentGizmoType === 'viewpoint_lookout' && currentGizmoIndex > i) currentGizmoIndex--;
    if (viewpointActiveKey === `lookout_${i}`) viewpointActiveKey = null;
    renderLookoutList();
    renderViewpointMenu();
}

function setLookoutPos(i, x, y, z) {
    const entry = lookouts[i]; if (!entry) return;
    entry.marker.position.set(
        x !== null && x !== undefined ? parseFloat(x) : entry.marker.position.x,
        y !== null && y !== undefined ? parseFloat(y) : entry.marker.position.y,
        z !== null && z !== undefined ? parseFloat(z) : entry.marker.position.z
    );
}

function setLookoutName(i, name) {
    const entry = lookouts[i]; if (!entry) return;
    entry.name = (name || '').trim() || `見張り台 ${i + 1}`;
    renderViewpointMenu();
}

// ── 固定6スロットの座標編集 ────────────────────────────────────
function setFixedViewpointPos(key, x, y, z) {
    const fv = fixedViewpoints[key]; if (!fv) return;
    fv.marker.position.set(
        x !== null && x !== undefined ? parseFloat(x) : fv.marker.position.x,
        y !== null && y !== undefined ? parseFloat(y) : fv.marker.position.y,
        z !== null && z !== undefined ? parseFloat(z) : fv.marker.position.z
    );
}

// ── 設定パネル「🔭 視点」タブのリスト描画 ──────────────────────
function renderFixedViewpointList() {
    const list = $('vp-fixed-list'); if (!list) return;
    list.innerHTML = '';
    FIXED_VIEWPOINT_DEFS.forEach(def => {
        const fv = fixedViewpoints[def.key]; if (!fv) return;
        const pos = fv.marker.position;
        const isGizmoActive = currentGizmoType === 'viewpoint_fixed' && currentGizmoIndex === def.key;
        const card = document.createElement('div');
        card.className = 'sp-item-card';
        card.innerHTML = `
            <div class="sp-item-header">
                <span class="sp-item-title">🔭 ${def.label}
                    <button class="sp-gizmo-btn${isGizmoActive ? ' active' : ''}" id="gizmo-viewpoint_fixed-${def.key}"
                        onclick="toggleGizmo('viewpoint_fixed','${def.key}')">📍 ギズモ</button>
                </span>
            </div>
            <div class="sp-xyz-row">
                <span class="sp-axis-label">X:</span>
                <input type="number" class="sp-xyz-input" value="${pos.x.toFixed(2)}" step="0.1"
                    oninput="setFixedViewpointPos('${def.key}',this.value,null,null)">
                <span class="sp-axis-label">Y:</span>
                <input type="number" class="sp-xyz-input" value="${pos.y.toFixed(2)}" step="0.1"
                    oninput="setFixedViewpointPos('${def.key}',null,this.value,null)">
                <span class="sp-axis-label">Z:</span>
                <input type="number" class="sp-xyz-input" value="${pos.z.toFixed(2)}" step="0.1"
                    oninput="setFixedViewpointPos('${def.key}',null,null,this.value)">
            </div>`;
        list.appendChild(card);
    });
}

function renderLookoutList() {
    const list = $('vp-lookout-list'); if (!list) return;
    list.innerHTML = '';
    if (lookouts.length === 0) {
        list.innerHTML = '<div style="font-size:10px;color:#555;padding:4px 0;">見張り台がありません。上で追加してください。</div>';
        return;
    }
    lookouts.forEach((entry, i) => {
        const pos = entry.marker.position;
        const isGizmoActive = currentGizmoType === 'viewpoint_lookout' && currentGizmoIndex === i;
        const card = document.createElement('div');
        card.className = 'sp-item-card';
        card.innerHTML = `
            <div class="sp-item-header">
                <span class="sp-item-title">
                    <input type="text" value="${entry.name}" style="width:108px;background:#0a1932;color:#ffff66;border:1px solid #444;border-radius:3px;font-size:11px;padding:2px 4px;"
                        oninput="setLookoutName(${i}, this.value)">
                    <button class="sp-gizmo-btn${isGizmoActive ? ' active' : ''}" id="gizmo-viewpoint_lookout-${i}"
                        onclick="toggleGizmo('viewpoint_lookout',${i})">📍 ギズモ</button>
                </span>
                <button class="sp-remove-btn" onclick="removeLookoutPoint(${i})">✕</button>
            </div>
            <div class="sp-xyz-row">
                <span class="sp-axis-label">X:</span>
                <input type="number" class="sp-xyz-input" value="${pos.x.toFixed(2)}" step="0.1"
                    oninput="setLookoutPos(${i},this.value,null,null)">
                <span class="sp-axis-label">Y:</span>
                <input type="number" class="sp-xyz-input" value="${pos.y.toFixed(2)}" step="0.1"
                    oninput="setLookoutPos(${i},null,this.value,null)">
                <span class="sp-axis-label">Z:</span>
                <input type="number" class="sp-xyz-input" value="${pos.z.toFixed(2)}" step="0.1"
                    oninput="setLookoutPos(${i},null,null,this.value)">
            </div>`;
        list.appendChild(card);
    });
}

// ── HUD: 視点選択メニュー ───────────────────────────────────
function toggleViewpointMenu() {
    const menu = $('viewpoint-menu'); if (!menu) return;
    const isOpen = menu.style.display === 'block';
    if (isOpen) { menu.style.display = 'none'; return; }
    renderViewpointMenu();
    menu.style.display = 'block';
}

function renderViewpointMenu() {
    const menu = $('viewpoint-menu'); if (!menu) return;
    menu.innerHTML = '';

    const backBtn = document.createElement('button');
    backBtn.className = 'vp-menu-item' + (!viewpointActiveKey ? ' active' : '');
    backBtn.textContent = '↩ 通常視点に戻る';
    backBtn.onclick = () => selectViewpoint(null);
    menu.appendChild(backBtn);

    FIXED_VIEWPOINT_DEFS.forEach(def => {
        const btn = document.createElement('button');
        btn.className = 'vp-menu-item' + (viewpointActiveKey === def.key ? ' active' : '');
        btn.textContent = '🔭 ' + def.label;
        btn.onclick = () => selectViewpoint(def.key);
        menu.appendChild(btn);
    });

    lookouts.forEach((entry, i) => {
        const key = `lookout_${i}`;
        const btn = document.createElement('button');
        btn.className = 'vp-menu-item' + (viewpointActiveKey === key ? ' active' : '');
        btn.textContent = '🔭 ' + entry.name;
        btn.onclick = () => selectViewpoint(key);
        menu.appendChild(btn);
    });
}

function getActiveViewpointMarker() {
    if (!viewpointActiveKey) return null;
    if (fixedViewpoints[viewpointActiveKey]) return fixedViewpoints[viewpointActiveKey].marker;
    if (viewpointActiveKey.indexOf('lookout_') === 0) {
        const i = parseInt(viewpointActiveKey.split('_')[1], 10);
        return lookouts[i] ? lookouts[i].marker : null;
    }
    return null;
}

function selectViewpoint(key) {
    viewpointActiveKey = key;
    viewpointYaw = 0;
    viewpointPitch = 0;
    window.lastChaseHeadingRot = undefined;
    cameraMode = key ? 'viewpoint' : 'follow';

    const btn = $('camera-mode-toggle');
    if (btn) {
        if (key) btn.innerText = window.VIEWPOINT_MODE_LABEL || '📷 視点: 見張り台';
        else if (typeof CAMERA_MODE_LABELS !== 'undefined') btn.innerText = CAMERA_MODE_LABELS.follow;
    }

    if (!key) {
        // 通常視点へ戻る際、カメラを船の少し後方上空に置き直して混乱を防ぐ
        const rotY = (physics.heading * Math.PI) / 180;
        const offsetDir = new THREE.Vector3(0, 6 * physics.scale, 25 * physics.scale);
        offsetDir.applyAxisAngle(new THREE.Vector3(0, 1, 0), rotY);
        camera.position.set(physics.cgWorldX + offsetDir.x, physics.y + offsetDir.y, physics.cgWorldZ + offsetDir.z);
        controls.target.set(physics.cgWorldX, physics.y, physics.cgWorldZ);
        controls.update();
    }

    const menu = $('viewpoint-menu');
    if (menu) menu.style.display = 'none';
    renderViewpointMenu();
}

// shipGroupの最新トランスフォーム確定後（main-loopの該当箇所から）呼び出される。
// マーカーのワールド座標・向き(船の横揺れ/縦揺れ込み)をカメラへコピーし、
// その上にユーザーの自由見回し(viewpointYaw/Pitch)を重ねる。
function updateViewpointCamera() {
    const vpMarker = getActiveViewpointMarker();
    if (!vpMarker || !shipGroup || !camera) return;

    shipGroup.updateMatrixWorld(true);

    const worldPos = new THREE.Vector3();
    vpMarker.getWorldPosition(worldPos);
    camera.position.copy(worldPos);

    const shipQuat = new THREE.Quaternion();
    shipGroup.getWorldQuaternion(shipQuat);

    // 船の前方は+Z方向（bowがz=+10）だが、Three.jsのカメラは
    // デフォルトで−Z方向を向くため、Y軸180°回転で前方を+Zに合わせる。
    const forwardRot = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0), Math.PI
    );
    const lookQuat = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(viewpointPitch, viewpointYaw, 0, 'YXZ')
    );
    camera.quaternion.copy(shipQuat).multiply(forwardRot).multiply(lookQuat);
}
