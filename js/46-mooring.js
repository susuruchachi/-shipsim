// ════════════════════════════════════════════════════════════════
//  係船設備（ビット・ボラード・クリート）
// ════════════════════════════════════════════════════════════════
//  船に索（もやい綱・タグボートの索）を取る金物を置く。船体設定の「⚓ 係船」タブで、
//  種類を選んで位置・向き・大きさを決める。「左右対称」なら反対舷（X を反転）にも同じものが付く。
//    ・ビット（双係柱）：台の上に太い柱が2本。大型船の船首・船尾の主な係船具
//    ・ボラード（単柱）：頭がきのこ形に広がった柱が1本
//    ・クリート：横に伸びた角（つの）に索を8の字に掛ける小さな金物
//  位置は船（shipGroup）の中の座標（汽笛・機関音と同じ）。+z が船首、+x が左舷側（右舷は −x）。
//  大きさは実寸[m]で作り、船の縮尺（physics.scale）で割って置く。
//  タグボート（次の段）はここで置いた金物の位置に索を取る（mooringPoints）。

const MOOR_TYPES = {
    bitt:    { label: 'ビット（双係柱）' },
    bollard: { label: 'ボラード（単柱）' },
    cleat:   { label: 'クリート' },
};
const MOOR_COLORS = {
    black: { label: '黒', hex: 0x1d1d1f },
    grey:  { label: '灰色', hex: 0x6d7176 },
    white: { label: '白', hex: 0xe6e5de },
    red:   { label: '赤さび色', hex: 0x7a3a26 },
    green: { label: '緑', hex: 0x2f5a3c },
};
// show：設定画面の外（ふだんの航海）でも金物を表示するか
const shipMooring = { items: [], show: true };
window.shipMooring = shipMooring;

function _moorDefault(type) {
    // tow：ビット・ボラードにタグの索を直接かけてよいか（クリートはいつも索を取れる）
    return { name: '', type: type || 'bitt', x: 0.5, y: 1, z: 0, rot: 0, size: 1, color: 'black', sym: true, tow: false };
}

// ── 形（実寸[m]。原点は甲板の上、+x が柱の並ぶ向き）──
const _moorGeoCache = {};
function _moorParts(type) {
    if (_moorGeoCache[type]) return _moorGeoCache[type];
    const parts = [];
    const add = (geo, x, y, z, rx, rz) => { const g = geo.clone(); if (rx) g.rotateX(rx); if (rz) g.rotateZ(rz); g.translate(x, y, z); parts.push(g); };
    if (type === 'bitt') {
        add(new THREE.BoxGeometry(1.6, 0.08, 0.55), 0, 0.04, 0);
        for (const sx of [-0.45, 0.45]) {
            add(new THREE.CylinderGeometry(0.17, 0.19, 0.62, 20), sx, 0.39, 0);
            add(new THREE.CylinderGeometry(0.23, 0.2, 0.07, 20), sx, 0.72, 0);      // 索が抜けないための頭のつば
            add(new THREE.CylinderGeometry(0.2, 0.23, 0.04, 20), sx, 0.1, 0);       // 根元の補強
        }
    } else if (type === 'bollard') {
        add(new THREE.BoxGeometry(0.62, 0.06, 0.62), 0, 0.03, 0);
        add(new THREE.CylinderGeometry(0.2, 0.22, 0.46, 20), 0, 0.29, 0);
        add(new THREE.CylinderGeometry(0.29, 0.2, 0.12, 20), 0, 0.57, 0);           // きのこ形の頭
        add(new THREE.CylinderGeometry(0.27, 0.29, 0.03, 20), 0, 0.645, 0);
    } else {
        add(new THREE.BoxGeometry(0.42, 0.05, 0.2), 0, 0.025, 0);
        for (const sx of [-0.13, 0.13]) add(new THREE.BoxGeometry(0.1, 0.17, 0.13), sx, 0.13, 0);
        // 左右に伸びる角（先へ細くなる）
        for (const s of [-1, 1]) add(new THREE.CylinderGeometry(0.035, 0.065, 0.3, 14), s * 0.3, 0.24, 0, 0, s * Math.PI / 2);
        add(new THREE.CylinderGeometry(0.065, 0.065, 0.3, 14), 0, 0.24, 0, 0, Math.PI / 2);
    }
    const merged = (THREE.BufferGeometryUtils && THREE.BufferGeometryUtils.mergeBufferGeometries) ? THREE.BufferGeometryUtils.mergeBufferGeometries(parts) : null;
    _moorGeoCache[type] = merged ? [merged] : parts;
    return _moorGeoCache[type];
}
const _moorMats = {};
function _moorMat(color) {
    if (!_moorMats[color]) {
        const m = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.35 });
        m.color.setHex((MOOR_COLORS[color] || MOOR_COLORS.black).hex).convertSRGBToLinear();
        _moorMats[color] = m;
    }
    return _moorMats[color];
}
function _moorMakeGroup(it) {
    const g = new THREE.Group();
    for (const geo of _moorParts(it.type)) {
        const m = new THREE.Mesh(geo, _moorMat(it.color));
        m.castShadow = true; m.receiveShadow = true;
        m.userData.noLightBake = true;
        g.add(m);
    }
    g.userData.isViewpointMarker = true;   // モデルを差し替えても消さない（係船設備は船の設定）
    g.userData.isMooring = true;
    return g;
}

// ── 3D の金物（船にずっと付いている）──
const _moor = { groups: [], dirty: true, scale: 0 };   // groups: [{ g, mirror }]
function _moorRebuild() {
    _moor.dirty = false;
    if (typeof shipGroup === 'undefined' || !shipGroup) return;
    for (const e of _moor.groups) [e.g, e.mirror].forEach(o => { if (o && o.parent) o.parent.remove(o); });
    _moor.groups = shipMooring.items.map(it => {
        const g = _moorMakeGroup(it), mirror = _moorMakeGroup(it);
        shipGroup.add(g); shipGroup.add(mirror);
        return { g, mirror, type: it.type, color: it.color };
    });
    _moorPlaceAll();
}
function _moorPlaceAll() {
    const sc = Math.max(1e-6, (typeof physics !== 'undefined' && physics.scale) || 1);
    _moor.scale = sc;
    const dragging = typeof currentGizmoType !== 'undefined' ? currentGizmoType : null;
    shipMooring.items.forEach((it, i) => {
        const e = _moor.groups[i]; if (!e) return;
        const s = (it.size || 1) / sc;
        if (!(dragging === 'moor' && currentGizmoIndex === i)) e.g.position.set(it.x, it.y, it.z);
        e.g.rotation.set(0, (it.rot || 0) * Math.PI / 180, 0);
        e.g.scale.setScalar(s);
        // 反対舷：X を反転。向きも鏡に映したように
        e.mirror.visible = !!it.sym && Math.abs(e.g.position.x) > 1e-3;
        e.mirror.position.set(-e.g.position.x, e.g.position.y, e.g.position.z);
        e.mirror.rotation.set(0, -(it.rot || 0) * Math.PI / 180, 0);
        e.mirror.scale.setScalar(s);
    });
}
function updateMooring() {
    if (typeof shipGroup === 'undefined' || !shipGroup) return;
    const e0 = _moor.groups[0];
    const changed = _moor.groups.length !== shipMooring.items.length
        || shipMooring.items.some((it, i) => _moor.groups[i] && (_moor.groups[i].type !== it.type || _moor.groups[i].color !== it.color));
    if (_moor.dirty || changed || (e0 && e0.g.parent !== shipGroup)) _moorRebuild();
    else if (typeof currentGizmoType !== 'undefined' && currentGizmoType === 'moor') _moorPlaceAll();
    else if (_moor.scale !== ((typeof physics !== 'undefined' && physics.scale) || 1)) _moorPlaceAll();
    // 設定画面の外では、選んだときだけ表示する（索を取る位置としてはいつも使う）
    const sp = document.getElementById('settings-panel');
    const show = shipMooring.show !== false || !!(sp && sp.classList.contains('open'));
    shipMooring.items.forEach((it, i) => {
        const e = _moor.groups[i]; if (!e) return;
        e.g.visible = show;
        e.mirror.visible = show && !!it.sym && Math.abs(e.g.position.x) > 1e-3;
    });
}
// 索を取れる金物か：クリートはいつも、ビット・ボラードは「索を直接かける」を選んだものだけ。
// タグの索だけでなく、着岸したときに岸壁のボラードへ取るもやい綱（50-harbor-auto.js）も同じ
function mooringTowOk(it) { return !!it && (it.type === 'cleat' || !!it.tow); }
window.mooringTowOk = mooringTowOk;
function mooringRotate(i, d) {
    const it = shipMooring.items[i]; if (!it) return;
    it.rot = ((((it.rot || 0) + d) % 360) + 360) % 360;
    _moorPlaceAll(); renderMooringPanel();
}
window.mooringRotate = mooringRotate;
// いちばん近い舷（船体の外板）と平行に向ける：その前後位置での舷の線の傾きに合わせる
//（金物の +x（柱・角の並ぶ向き）を舷に沿わせる。右舷側なら舷の線も鏡の向き）
function mooringAlignSide(i) {
    const it = shipMooring.items[i]; if (!it || typeof worldHullAt !== 'function') return;
    const sc = (typeof physics !== 'undefined' && physics.scale) || 1;
    const hp = window.hullProfile, dz = Math.max(0.05, ((hp && hp.ready) ? hp.halfLen : 6) * 0.02);
    const slope = (worldHullAt(it.z + dz).hw - worldHullAt(it.z - dz).hw) / (2 * dz * sc);   // 半幅の前後の変わり方
    const phi = Math.atan(slope) * 180 / Math.PI;
    const side = it.x >= 0 ? 1 : -1;                       // +x が左舷
    let rot = side > 0 ? phi - 90 : -phi - 90;
    it.rot = Math.round((((rot % 360) + 360) % 360) * 10) / 10;
    _moorPlaceAll(); renderMooringPanel();
}
window.mooringAlignSide = mooringAlignSide;
window.updateMooring = updateMooring;

// 金物の位置（ワールド座標）の一覧。タグボートの索を取る所（反対舷の分も）
function mooringPoints() {
    const out = [];
    const v = new THREE.Vector3();
    shipMooring.items.forEach((it, i) => {
        const e = _moor.groups[i]; if (!e) return;
        const h = (it.type === 'cleat' ? 0.25 : it.type === 'bitt' ? 0.55 : 0.5) * (it.size || 1) / Math.max(1e-6, physics.scale || 1);
        for (const [o, side] of [[e.g, it.x >= 0 ? 1 : -1], [e.mirror, it.x >= 0 ? -1 : 1]]) {
            if (!o.parent || (o === e.mirror && !(it.sym && Math.abs(e.g.position.x) > 1e-3))) continue;
            v.set(o.position.x, o.position.y + h, o.position.z);
            shipGroup.localToWorld(v);
            out.push({ index: i, type: it.type, side, local: { x: o.position.x, y: o.position.y + h, z: o.position.z }, world: v.clone() });
        }
    });
    return out;
}
window.mooringPoints = mooringPoints;

// ── 甲板に合わせる：その点の少し上から下へ光線を飛ばして、当たった面の高さにする ──
const _moorRay = new THREE.Raycaster();
function _moorDeckY(x, z, fromY) {
    if (typeof importedModelGroup === 'undefined' || !importedModelGroup || typeof shipGroup === 'undefined') return null;
    shipGroup.updateMatrixWorld(true);
    const o = shipGroup.localToWorld(new THREE.Vector3(x, fromY, z));
    const b = shipGroup.localToWorld(new THREE.Vector3(x, fromY - 1, z));
    _moorRay.set(o, b.sub(o).normalize());
    _moorRay.far = Infinity;
    if (typeof camera !== 'undefined') _moorRay.camera = camera;    // 模型の中のスプライト用
    const hits = _moorRay.intersectObject(importedModelGroup, true).filter(h => h.object.visible && !(h.object.userData && (h.object.userData.isMooring || h.object.userData.isViewpointMarker)));
    if (!hits.length) return null;
    return shipGroup.worldToLocal(hits[0].point.clone()).y;
}
// 模型の高さの範囲（船の中の座標）
function _moorModelBox() {
    if (typeof importedModelGroup === 'undefined' || !importedModelGroup) return null;
    shipGroup.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(importedModelGroup);
    if (box.isEmpty()) return null;
    const a = shipGroup.worldToLocal(box.min.clone()), b = shipGroup.worldToLocal(box.max.clone());
    return { minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y) };
}
function mooringSnap(i) {
    const it = shipMooring.items[i]; if (!it) return;
    const sc = physics.scale || 1;
    const y = _moorDeckY(it.x, it.z, it.y + 2.5 / sc);    // 今の高さの 2.5m 上から
    if (y !== null) { it.y = Math.round(y * 1000) / 1000; _moorPlaceAll(); renderMooringPanel(); }
}

// ── おすすめの配置：船首・船尾にビット、中ほどにボラード、その間にクリート ──
//  船の形（hullProfile）から甲板の幅を探して、舷側から少し内側に置く。
function mooringAutoLayout() {
    const hp = window.hullProfile;
    if (!hp || !hp.ready) { alert('船体の形を調べ終わってから使ってください（モデルを読み込んで少し待ってください）'); return; }
    const box = _moorModelBox(); if (!box) return;
    const sc = physics.scale || 1;
    const L = hp.halfLen * 2 * sc;                 // 全長[m]
    const size = Math.max(0.6, Math.min(1.8, L / 180));
    const top = box.maxY + 1;
    // その z での船の半幅（船体を調べたときの輪切り hullProfile.slices から）。
    // 光線を何十本も飛ばすと重い模型ではとても遅いので、幅は輪切りから決め、
    // 光線は「載せる所の確認」に数本だけ使う。
    const halfWidthAt = (zn) => {
        const sl = hp.slices || [];
        if (sl.length < 2) return hp.halfBeam;
        const a = zn * (hp.bowSign || 1);
        let best = sl[0];
        for (const q of sl) if (Math.abs(q.alongNorm - a) < Math.abs(best.alongNorm - a)) best = q;
        return best.halfWidth || hp.halfBeam;
    };
    const deckAt = (z) => {
        const hw = halfWidthAt(z / hp.halfLen);
        for (let k = 0; k < 6; k++) {
            const x = hw * (1 - k * 0.12);
            const y = _moorDeckY(x, z, top);
            if (y !== null && y > (hp.designWaterlineY || 0) + 0.2 / sc) return { x, y };
        }
        return null;
    };
    const items = [];
    const put = (type, zn, inset, rot) => {
        const z = zn * hp.halfLen;
        const edge = deckAt(z); if (!edge) return;
        const x = Math.max(0.05, edge.x - inset / sc);
        const y = _moorDeckY(x, z, top);
        if (y === null) return;
        items.push(Object.assign(_moorDefault(type), { x: +x.toFixed(3), y: +y.toFixed(3), z: +z.toFixed(3), rot, size: +size.toFixed(2), sym: true,
            name: `${MOOR_TYPES[type].label.replace(/（.*）/, '')} ${zn > 0.3 ? '船首' : zn < -0.3 ? '船尾' : '中央'}` }));
    };
    // 船首・船尾：舷側に沿ってビット2組（柱の並びは船の前後）
    for (const zn of [0.82, 0.72]) put('bitt', zn, 1.6 * size, 90);
    for (const zn of [-0.8, -0.7]) put('bitt', zn, 1.6 * size, 90);
    // 中ほど：ボラード
    for (const zn of [0.35, 0, -0.35]) put('bollard', zn, 1.0 * size, 0);
    // 船首・船尾の間：クリート
    for (const zn of [0.55, -0.55]) put('cleat', zn, 0.7 * size, 90);
    if (!items.length) { alert('甲板が見つかりませんでした'); return; }
    // 同じ名前には番号を付ける（ビット 船首1・ビット 船首2 …）
    const cnt = {};
    items.forEach(it => { cnt[it.name] = (cnt[it.name] || 0) + 1; });
    const seen = {};
    items.forEach(it => { if (cnt[it.name] > 1) { seen[it.name] = (seen[it.name] || 0) + 1; it.name = it.name + seen[it.name]; } });
    if (shipMooring.items.length && !confirm('今の係船設備を消して、おすすめの配置にしますか？')) return;
    if (typeof disableGizmo === 'function') disableGizmo();
    shipMooring.items = items;
    _moor.dirty = true;
    renderMooringPanel();
}

// ── 編集 ──
function mooringAdd(type) {
    const it = _moorDefault(type);
    const hp = window.hullProfile;
    const sc = physics.scale || 1;
    if (hp && hp.ready) {
        it.x = +(hp.halfBeam * 0.6).toFixed(3);
        it.size = +Math.max(0.6, Math.min(1.8, hp.halfLen * 2 * sc / 180)).toFixed(2);
        const box = _moorModelBox();
        const y = box ? _moorDeckY(it.x, 0, box.maxY + 1) : null;
        if (y !== null) it.y = +y.toFixed(3);
    }
    it.name = MOOR_TYPES[it.type].label.replace(/（.*）/, '') + ' ' + (shipMooring.items.length + 1);
    shipMooring.items.push(it);
    _moor.dirty = true;
    renderMooringPanel();
}
function mooringRemove(i) {
    if (typeof disableGizmo === 'function') disableGizmo();
    shipMooring.items.splice(i, 1);
    _moor.dirty = true;
    renderMooringPanel();
}
function mooringCopy(i) {
    const src = shipMooring.items[i]; if (!src) return;
    const e = JSON.parse(JSON.stringify(src));
    e.z = +(e.z - 0.3).toFixed(3);
    e.name = (src.name || '') + '（コピー）';
    shipMooring.items.splice(i + 1, 0, e);
    if (typeof disableGizmo === 'function') disableGizmo();
    _moor.dirty = true;
    renderMooringPanel();
}
function mooringClear() {
    if (!shipMooring.items.length || !confirm('係船設備をすべて消しますか？')) return;
    if (typeof disableGizmo === 'function') disableGizmo();
    shipMooring.items = [];
    _moor.dirty = true;
    renderMooringPanel();
}
function mooringSet(i, key, v) {
    const it = shipMooring.items[i]; if (!it) return;
    if (key === 'sym' || key === 'tow') it[key] = !!v;
    else if (key === 'type' || key === 'color' || key === 'name') it[key] = v;
    else { const n = parseFloat(v); if (!Number.isFinite(n)) return; it[key] = key === 'size' ? Math.max(0.2, Math.min(5, n)) : n; }
    if (key === 'type' || key === 'color') _moor.dirty = true;
    _moorPlaceAll();
    if (key === 'type') renderMooringPanel();
}
Object.assign(window, { mooringAdd, mooringRemove, mooringCopy, mooringClear, mooringSet, mooringSnap, mooringAutoLayout });

// ── ギズモ（10-ship-editor-propulsors.js の toggleGizmo から。汽笛の分は 36-horns.js）──
const _moorPrevGizmoTarget = window.getExtraGizmoTarget;
const _moorPrevGizmoChange = window.onExtraGizmoChange;
window.getExtraGizmoTarget = function (type, index) {
    if (type === 'moor') { updateMooring(); const e = _moor.groups[index]; return { mesh: e && e.g, btnId: `gizmo-moor-${index}` }; }
    if (type === 'moor_rot') { updateMooring(); const e = _moor.groups[index]; return { mesh: e && e.g, btnId: `gizmo-moor-rot-${index}` }; }
    return _moorPrevGizmoTarget ? _moorPrevGizmoTarget(type, index) : null;
};
window.onExtraGizmoChange = function (type, index, target) {
    if (type === 'moor') {
        const it = shipMooring.items[index];
        if (!it) return true;
        const r = (v) => Math.round(v * 1000) / 1000;
        it.x = r(target.position.x); it.y = r(target.position.y); it.z = r(target.position.z);
        const row = document.querySelector(`#moor-list .moor-item[data-i="${index}"]`);
        if (row) ['x', 'y', 'z'].forEach(k => { const el = row.querySelector(`input[data-k="${k}"]`); if (el) el.value = it[k]; });
        _moorPlaceAll();
        return true;
    }
    if (type === 'moor_rot') {
        // 回すのは上下の軸（甲板の上で向きを変える）だけ。ほかの軸に回されたら戻す
        const it = shipMooring.items[index];
        if (!it) return true;
        const e = new THREE.Euler().setFromQuaternion(target.quaternion, 'YXZ');
        it.rot = Math.round((((e.y * 180 / Math.PI) % 360) + 360) % 360 * 10) / 10;
        const row = document.querySelector(`#moor-list .moor-item[data-i="${index}"]`);
        if (row) { const el = row.querySelector('input[data-k="rot"]'); if (el) el.value = it.rot; }
        _moorPlaceAll();
        return true;
    }
    return _moorPrevGizmoChange ? _moorPrevGizmoChange(type, index, target) : false;
};

// ── 設定パネル（入力欄には id を付けない：保存の「パネルの入力欄すべて」に混ざらないように）──
function renderMooringPanel() {
    const list = document.getElementById('moor-list');
    if (!list) return;
    const showBox = document.querySelector('.moor-show');
    if (showBox) showBox.checked = shipMooring.show !== false;
    if (!shipMooring.items.length) {
        list.innerHTML = '<div style="font-size:11px;color:#888;padding:6px 0;">まだありません。下のボタンで追加するか、「おすすめの配置」を押してください。</div>';
        return;
    }
    const opt = (obj, cur) => Object.entries(obj).map(([k, v]) => `<option value="${k}"${k === cur ? ' selected' : ''}>${v.label}</option>`).join('');
    const num = (i, k, v, step) => `<input type="number" class="sp-xyz-input" data-k="${k}" value="${v}" step="${step}" oninput="mooringSet(${i}, '${k}', this.value)">`;
    list.innerHTML = shipMooring.items.map((it, i) => `
        <div class="sp-funnel-item moor-item" data-i="${i}">
            <div class="sp-item-header">
                <span class="sp-item-title">⚓ #${i + 1}
                    <input type="text" value="${(it.name || '').replace(/"/g, '&quot;')}" maxlength="30" style="background:#0a1932;color:#00ffcc;border:1px solid #00ffcc55;border-radius:4px;padding:2px 6px;font-family:inherit;font-size:11px;width:120px;" oninput="mooringSet(${i}, 'name', this.value)">
                </span>
                <button class="sp-del-btn" onclick="mooringRemove(${i})">✕</button>
            </div>
            <div class="sp-row" style="gap:6px;flex-wrap:wrap;">
                <select class="moor-sel" onchange="mooringSet(${i}, 'type', this.value)">${opt(MOOR_TYPES, it.type)}</select>
                <select class="moor-sel" onchange="mooringSet(${i}, 'color', this.value)">${opt(MOOR_COLORS, it.color)}</select>
                <label class="sp-toggle"><input type="checkbox" ${it.sym ? 'checked' : ''} onchange="mooringSet(${i}, 'sym', this.checked)"> 左右対称</label>
                ${it.type === 'cleat' ? '<span style="font-size:10px;color:#8ab;">索は舷の外から取る</span>' : `<label class="sp-toggle" title="タグボートの索・岸壁のボラードへのもやい綱をこの金物に直接かけてよい（クリートはいつもかけられる）"><input type="checkbox" ${it.tow ? 'checked' : ''} onchange="mooringSet(${i}, 'tow', this.checked)"> タグの索・もやい綱を直接かける</label>`}
            </div>
            <div class="sp-row sp-xyz-row">
                <span class="sp-axis-label">X:</span>${num(i, 'x', it.x, 0.05)}
                <span class="sp-axis-label">Y:</span>${num(i, 'y', it.y, 0.05)}
                <span class="sp-axis-label">Z:</span>${num(i, 'z', it.z, 0.05)}
            </div>
            <div class="sp-row sp-xyz-row">
                <span class="sp-axis-label" style="white-space:nowrap;width:auto;">向き°</span>${num(i, 'rot', it.rot, 15)}
                <button class="sp-gizmo-btn" style="padding:2px 6px;" onclick="mooringRotate(${i}, -90)" title="左へ90°回す">⟲</button>
                <button class="sp-gizmo-btn" style="padding:2px 6px;" onclick="mooringRotate(${i}, 90)" title="右へ90°回す">⟳</button>
                <span class="sp-axis-label" style="white-space:nowrap;width:auto;">大きさ</span>${num(i, 'size', it.size, 0.1)}
            </div>
            <div class="sp-row" style="gap:6px;flex-wrap:wrap;">
                <button class="sp-gizmo-btn" id="gizmo-moor-${i}" onclick="toggleGizmo('moor', ${i})">📍 ギズモ</button>
                <button class="sp-gizmo-btn" id="gizmo-moor-rot-${i}" onclick="toggleGizmo('moor_rot', ${i}, 'rotate'); if (typeof applyRotateAxisRestriction === 'function' && currentGizmoType === 'moor_rot') applyRotateAxisRestriction('Y')" title="ギズモで向きを回す（上下の軸だけ）">🔄 ギズモで回す</button>
                <button class="sp-gizmo-btn" onclick="mooringAlignSide(${i})" title="いちばん近い舷の外板と平行に向ける">∥ 舷と平行に</button>
                <button class="sp-gizmo-btn" onclick="mooringSnap(${i})" title="いまの位置の真下の甲板に載せる">⬇ 甲板に載せる</button>
                <button class="sp-gizmo-btn" onclick="mooringCopy(${i})">⧉ 複製</button>
            </div>
        </div>`).join('');
}
window.renderMooringPanel = renderMooringPanel;

// ── 保存（13-save-load-config.js から）──
function getMooringConfig() { return JSON.parse(JSON.stringify(shipMooring)); }
function applyMooringConfig(c) {
    if (typeof disableGizmo === 'function' && typeof currentGizmoType !== 'undefined' && currentGizmoType === 'moor') disableGizmo();
    shipMooring.items = (c && Array.isArray(c.items)) ? c.items.map(it => Object.assign(_moorDefault(it.type), it)) : [];
    shipMooring.items.forEach(it => { if (!MOOR_TYPES[it.type]) it.type = 'bitt'; if (!MOOR_COLORS[it.color]) it.color = 'black'; });
    shipMooring.show = !(c && c.show === false);
    _moor.dirty = true;
    renderMooringPanel();
}
window.getMooringConfig = getMooringConfig;
window.applyMooringConfig = applyMooringConfig;

document.addEventListener('DOMContentLoaded', renderMooringPanel);
