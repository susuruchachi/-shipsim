// ════════════════════════════════════════════════════════════════
//  水密隔壁・区画
// ════════════════════════════════════════════════════════════════
//  船体設定の「🧱 水密区画」タブで、船を仕切る水密隔壁を決める。
//   ・横隔壁（船を前後に仕切る）：枚数を決めると、船の全長を等分して並ぶ。📍ギズモで前後へ動かす。
//     高さは船底から（1＝主甲板）。ギズモで1枚ずつ、または全体の平均を上下できる。
//   ・縦隔壁（船を左右に仕切る）：枚数を決めると、船の幅を等分して並ぶ。舷側に沿って曲がる
//     （その前後位置の喫水線の半幅に対する割合で置く）。左右対称に置く（選べる）。ギズモで左右へ動かす。
//   ・二重底：船底から決めた高さ[m]まで。軽い座礁・衝突の穴は、ここまでしか水が入らない。
//  座標は、船体の輪切り（hullProfile・22-hull-shape.js）と同じ「船体の座標」：along（船首が＋）・
//  perp（左舷が＋）・y（上が＋）。模型の座標（physics.scale 前）で、船（shipGroup）に付いて動き、船首の向きへ
//  回したグループ（_wt.root）に置く（shipGroup の子にすると、目印として画面上の大きさにそろえられたり、
//  模型を差し替えたときに消されたりするので、シーンに置いて毎フレーム船の位置・向きを写す）。前後は船の長さの半分（hullProfile.halfLen）、左右はその前後位置の
//  喫水線の半幅、高さは船底〜主甲板に対する割合で持つ（模型の大きさ・縮尺を変えても同じ配置）。
//  区画の容積・浸水は 63-flooding.js。

const WT_DEF = { tN: null, tz: [], th: [], lN: 0, lx: [], lSym: true, lh: 1, sA: null, sB: null, db: null, show: false };
const shipWT = JSON.parse(JSON.stringify(WT_DEF));
window.shipWT = shipWT;
const _wt = { root: null, key: '', dirty: true, meshes: [], marks: {}, proxies: {}, mats: {}, sph: null, D: null, rev: 0 };

// ── 船体の形 ──
function _wtHull() {
    const hp = window.hullProfile;
    if (!hp || !hp.ready || !hp.shape || !hp.shape.ready || typeof hullShapeHalfWidthAtAlong !== 'function') return null;
    return hp;
}
// shipGroup の中での、船体の座標の船首（＋along）の向き（18-hull-wake-physics.js の _wakeAxisRad と同じ）
function _wtAlpha(hp) {
    const ry = (typeof modelOffset !== 'undefined' && modelOffset && +modelOffset.ry) ? modelOffset.ry * Math.PI / 180 : 0;
    return ry + (hp.xIsForward ? Math.PI / 2 : 0) + (hp.bowSign === -1 ? Math.PI : 0);
}
// 船体の寸法（模型の座標）：船底 yBot・主甲板 yDeck・喫水線 yWL・前後の端 aS（船尾）〜aB（船首）
function _wtDims(hp) {
    const S = hp.shape;
    const yBot = S.levelY[S.kFirst];
    const yDeck = Math.max(yBot + 1e-3, Number.isFinite(hp.deckY) ? hp.deckY : S.levelY[S.kTop]);
    let aS = Infinity, aB = -Infinity;
    for (let k = S.kFirst; k <= S.kTop; k++) { aS = Math.min(aS, S.sternAlong[k]); aB = Math.max(aB, S.bowAlong[k]); }
    if (!(aB > aS)) { aS = -hp.halfLen; aB = hp.halfLen; }
    // 喫水線：船が浮いている高さ（喫水線の基準点・喫水の調整）。船底より上・甲板より下でなければ、輪切りの推定
    const sc = Math.max(0.25, physics.scale || 1);
    let yWL = (physics.waterlineOffsetY || 0) + (physics.draftOffset || 0) / sc;
    if (!(yWL > yBot + (yDeck - yBot) * 0.05 && yWL < yDeck)) yWL = hp.designWaterlineY;
    return { yBot, yDeck, H: yDeck - yBot, yWL: Math.max(yBot, Math.min(yDeck, yWL)), aS, aB, half: hp.halfLen || 1 };
}
// 高さ y・前後 a での船体の半幅（模型の座標）
function _wtHW(y, a) { return hullShapeHalfWidthAtAlong(window.hullProfile.shape, y, a); }
// 前後 a での甲板（舷側の外板の上の縁）の高さ。隔壁の面は、舷側と同じく甲板からもはみ出さない（22-hull-shape.js）
function _wtDeckAt(D, a) { const y = typeof hullShapeDeckAt === 'function' ? hullShapeDeckAt(window.hullProfile.shape, a) : Infinity; return Math.max(D.yBot + D.H * 0.1, Math.min(D.yDeck, y)); }
// 縦隔壁を置く割合の基準の半幅：喫水線の半幅（喫水線の無い船首尾の端では、いちばん広い所）
function _wtHWRef(D, a) {
    let w = _wtHW(D.yWL, a);
    if (w > 1e-6) return w;
    for (let i = 0; i <= 12; i++) w = Math.max(w, _wtHW(D.yBot + D.H * i / 12, a));
    return w;
}
// 喫水[m]
function _wtDraft(D) { return (D.yWL - D.yBot) * (physics.scale || 1); }

// ── 配置の決まり ──
function _wtAutoCount(D) { const L = (D.aB - D.aS) * (physics.scale || 1); return Math.max(3, Math.min(20, Math.round(L / 22))); }
function _wtEqualT(D, n) { const out = []; for (let j = 0; j < n; j++) out.push(+((D.aS + (D.aB - D.aS) * (j + 1) / (n + 1)) / D.half).toFixed(4)); return out; }
function _wtEqualL(n) { const out = []; for (let k = 0; k < n; k++) out.push(+(-1 + 2 * (k + 1) / (n + 1)).toFixed(4)); return out; }
// 設定をそろえる（枚数と並びの数・順番・範囲）。船体がまだ無ければ null
function _wtEnsure() {
    const hp = _wtHull(); if (!hp) return null;
    const D = _wtDims(hp);
    if (!Number.isFinite(shipWT.tN) || shipWT.tN === null) { shipWT.tN = _wtAutoCount(D); shipWT.tz = []; shipWT.sA = null; }
    const n = shipWT.tN = Math.max(0, Math.min(40, Math.round(shipWT.tN)));
    if (!Array.isArray(shipWT.tz) || shipWT.tz.length !== n) shipWT.tz = _wtEqualT(D, n);
    if (!Array.isArray(shipWT.th)) shipWT.th = [];
    while (shipWT.th.length < n) shipWT.th.push(shipWT.th.length ? shipWT.th[shipWT.th.length - 1] : 1);
    shipWT.th.length = n;
    shipWT.th = shipWT.th.map(h => Math.max(0.05, Math.min(1.5, +h || 1)));
    shipWT.tz.sort((x, y) => x - y);
    shipWT.lN = Math.max(0, Math.min(8, Math.round(+shipWT.lN || 0)));
    if (!Array.isArray(shipWT.lx) || shipWT.lx.length !== shipWT.lN) shipWT.lx = _wtEqualL(shipWT.lN);
    shipWT.lx.sort((x, y) => x - y);
    shipWT.lh = Math.max(0.05, Math.min(1.5, +shipWT.lh || 1));
    if (shipWT.sA === null || shipWT.sB === null || !Number.isFinite(shipWT.sA) || !Number.isFinite(shipWT.sB)) { shipWT.sA = n >= 2 ? 1 : 0; shipWT.sB = n >= 2 ? n - 1 : n; }
    shipWT.sA = Math.max(0, Math.min(n, Math.round(shipWT.sA)));
    shipWT.sB = Math.max(shipWT.sA, Math.min(n, Math.round(shipWT.sB)));
    if (typeof shipWT.db !== 'number' || !Number.isFinite(shipWT.db)) shipWT.db = +Math.max(0.9, Math.min(2.0, 0.12 * _wtDraft(D))).toFixed(2);
    shipWT.db = Math.max(0, Math.min(_wtDraft(D) * 0.6, shipWT.db));
    return D;
}
// 区画の並び：前後の区切り（船尾の端・横隔壁・船首の端）、縦隔壁のある区切りの範囲
function wtLayout() {
    const D = _wtEnsure(); if (!D) return null;
    const cuts = [D.aS].concat(shipWT.tz.map(u => Math.max(D.aS, Math.min(D.aB, u * D.half)))).concat([D.aB]);
    return { D, cuts, n: shipWT.tN, lN: shipWT.lN, lx: shipWT.lx.slice(), sA: shipWT.sA, sB: shipWT.sB };
}
window.wtLayout = wtLayout;
window.wtDims = () => { const hp = _wtHull(); return hp ? _wtDims(hp) : null; };
window.wtHW = _wtHW;
window.wtHWRef = _wtHWRef;
window.wtAlpha = () => { const hp = _wtHull(); return hp ? _wtAlpha(hp) : 0; };

// ── 形 ──
function _wtMat(kind) {
    if (_wt.mats[kind]) return _wt.mats[kind];
    const col = { t: 0x33ccff, l: 0xffaa33, db: 0xb8c0c8, mk: 0x33ccff, ml: 0xffaa33, ma: 0xffffff, md: 0xb8c0c8 }[kind.replace('E', '')] || 0xffffff;
    let m;
    if (kind.endsWith('E')) m = new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false });
    else if (kind[0] === 'm') m = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false });
    else m = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: kind === 'db' ? 0.16 : 0.24, side: THREE.DoubleSide, depthTest: false, depthWrite: false });
    m.toneMapped = false;
    return (_wt.mats[kind] = m);
}
function _wtGeo(pos, idx) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    if (idx) g.setIndex(idx);
    return g;
}
// 横隔壁（前後 a・上の縁 yTop）：外板に沿った面と縁取り
function _wtTransGeo(D, a, yTop) {
    const N = 24, pos = [], idx = [], edge = [];
    for (let k = 0; k <= N; k++) { const y = D.yBot + (yTop - D.yBot) * k / N, w = _wtHW(y, a); pos.push(-w, y, a, w, y, a); }
    for (let k = 0; k < N; k++) { const i = k * 2; idx.push(i, i + 1, i + 3, i, i + 3, i + 2); }
    for (let k = 0; k <= N; k++) edge.push(pos[k * 6 + 3], pos[k * 6 + 4], a);
    for (let k = N; k >= 0; k--) edge.push(pos[k * 6], pos[k * 6 + 1], a);
    return { face: _wtGeo(pos, idx), edge: _wtGeo(edge) };
}
// 縦隔壁（割合 f・前後 a0〜a1・上の縁 yTop）：舷側に沿って曲がる。船底のふくらみの所は、外板から上だけ
function _wtLongGeo(D, f, a0, a1, yTop) {
    const NA = 48, NY = 10, pos = [], idx = [], top = [], bot = [];
    const yTop0 = yTop;
    for (let i = 0; i <= NA; i++) {
        const a = a0 + (a1 - a0) * i / NA, p = f * _wtHWRef(D, a);
        yTop = Math.min(yTop0, _wtDeckAt(D, a));
        let yLow = yTop;
        for (let k = 0; k <= 40; k++) { const y = D.yBot + (yTop - D.yBot) * k / 40; if (_wtHW(y, a) >= Math.abs(p) - 1e-6) { yLow = y; break; } }
        for (let j = 0; j <= NY; j++) {
            const y = yLow + (yTop - yLow) * j / NY, w = _wtHW(y, a);
            pos.push(Math.sign(p) * Math.min(Math.abs(p), w), y, a);
        }
        top.push(pos[pos.length - 3], pos[pos.length - 2], a);
        bot.push(pos[pos.length - 3 * (NY + 1)], pos[pos.length - 3 * (NY + 1) + 1], a);
    }
    for (let i = 0; i < NA; i++) for (let j = 0; j < NY; j++) {
        const q = i * (NY + 1) + j, r = q + NY + 1;
        idx.push(q, r, r + 1, q, r + 1, q + 1);
    }
    // 縁取り：上の縁 → 船首の縦の線 → 下の縁（逆向き）→ 船尾の縦の線
    const e = top.slice();
    for (let i = NA; i >= 0; i--) e.push(bot[i * 3], bot[i * 3 + 1], bot[i * 3 + 2]);
    return { face: _wtGeo(pos, idx), edge: _wtGeo(e) };
}
// 二重底の内底板（高さ yDb の水平な面）
function _wtDbGeo(D, yDb) {
    const NA = 60, pos = [], idx = [];
    for (let i = 0; i <= NA; i++) { const a = D.aS + (D.aB - D.aS) * i / NA, w = _wtHW(yDb, a); pos.push(-w, yDb, a, w, yDb, a); }
    for (let i = 0; i < NA; i++) { const q = i * 2; idx.push(q, q + 1, q + 3, q, q + 3, q + 2); }
    return _wtGeo(pos, idx);
}
// 縦隔壁の範囲（前後）と、置く前後の真ん中
function _wtLongSpan(D, cuts) {
    const a0 = cuts[shipWT.sA], a1 = cuts[shipWT.sB + 1];
    return { a0, a1, mid: (a0 + a1) / 2 };
}
function _wtClearMeshes() {
    for (const m of _wt.meshes) { if (m.parent) m.parent.remove(m); if (m.geometry && m.geometry !== _wt.sph) m.geometry.dispose(); }
    _wt.meshes = []; _wt.marks = {};
}
function _wtBuild() {
    _wt.dirty = false;
    const hp = _wtHull();
    if (!hp || typeof shipGroup === 'undefined' || !shipGroup) return;
    const Lay = wtLayout(); if (!Lay) return;
    const D = Lay.D; _wt.D = D;
    if (!_wt.root) {
        _wt.root = new THREE.Group(); _wt.root.name = 'watertight';
        _wt.root.matrixAutoUpdate = false;
        _wt.root.userData.noSolid = true; _wt.root.userData.noLightBake = true;
    }
    if (typeof scene !== 'undefined' && scene && _wt.root.parent !== scene) scene.add(_wt.root);
    _wt.rotM = new THREE.Matrix4().makeRotationY(_wtAlpha(hp));
    _wtFollow();
    _wtClearMeshes();
    if (!_wt.sph) _wt.sph = new THREE.SphereGeometry(1, 14, 10);
    const add = (geo, kind, line, tag) => {
        const m = line ? new THREE.Line(geo, _wtMat(kind + 'E')) : new THREE.Mesh(geo, _wtMat(kind));
        m.renderOrder = 980 + (line ? 2 : 0);
        m.userData = { noLightBake: true, noSolid: true, wt: tag || kind };
        m.frustumCulled = false; m.castShadow = false; m.receiveShadow = false;
        _wt.root.add(m); _wt.meshes.push(m);
        return m;
    };
    const mark = (key, kind, x, y, z) => {
        const m = new THREE.Mesh(_wt.sph, _wtMat(kind));
        const r = Math.max(1e-3, (D.aB - D.aS) * 0.008);
        m.scale.set(r, r, r); m.position.set(x, y, z);
        m.renderOrder = 985; m.frustumCulled = false;
        m.userData = { noLightBake: true, noSolid: true, wt: key };
        _wt.root.add(m); _wt.meshes.push(m); _wt.marks[key] = m;
        return m;
    };
    // 横隔壁
    for (let j = 0; j < Lay.n; j++) {
        const a = Lay.cuts[j + 1], yT = Math.min(D.yBot + D.H * shipWT.th[j], _wtDeckAt(D, a));
        const g = _wtTransGeo(D, a, yT);
        add(g.face, 't'); add(g.edge, 't', true);
        mark('t' + j, 'mk', 0, yT, a);
    }
    // 全体の高さの目印（船の真ん中）
    const avg = Lay.n ? shipWT.th.reduce((s, v) => s + v, 0) / Lay.n : 1;
    mark('avg', 'ma', 0, D.yBot + D.H * avg, (D.aS + D.aB) / 2);
    // 縦隔壁
    if (Lay.lN) {
        const sp = _wtLongSpan(D, Lay.cuts), yT = D.yBot + D.H * shipWT.lh;
        for (let k = 0; k < Lay.lN; k++) {
            const g = _wtLongGeo(D, Lay.lx[k], sp.a0, sp.a1, yT);
            add(g.face, 'l'); add(g.edge, 'l', true);
            mark('l' + k, 'ml', Lay.lx[k] * _wtHWRef(D, sp.mid), yT, sp.mid);
        }
    }
    // 二重底
    const sc = physics.scale || 1, yDb = D.yBot + shipWT.db / sc;
    if (shipWT.db > 0) { add(_wtDbGeo(D, yDb), 'db'); mark('db', 'md', 0, yDb, D.aS + (D.aB - D.aS) * 0.3); }
    _wt.rev++;
}
// 船体（模型・縮尺・向き）が変わったら作り直す
function _wtHullKey(hp) {
    const S = hp.shape;
    return [S.levelY[0], S.levelY[S.nLevels - 1], S.bowAlong[S.kTop], S.sternAlong[S.kTop], hp.deckY, hp.halfLen, hp.designWaterlineY, physics.scale, _wtAlpha(hp)].map(v => Math.round((+v || 0) * 1e4)).join(',');
}

// 船の位置・向きを写す（船体の座標 → 世界）
//（船の模型の子まで行列を計算し直すと重いので、shipGroup そのものの行列だけ）
function _wtFollow() {
    if (!_wt.root || typeof shipGroup === 'undefined' || !shipGroup) return;
    shipGroup.updateMatrix();
    const M = _wt.root.matrix;
    if (shipGroup.parent && shipGroup.parent.matrixWorld) M.multiplyMatrices(shipGroup.parent.matrixWorld, shipGroup.matrix); else M.copy(shipGroup.matrix);
    if (_wt.rotM) M.multiply(_wt.rotM);
    _wt.root.matrixWorld.copy(M);
    _wt.root.matrixWorldNeedsUpdate = true;
}
window.wtRoot = () => _wt.root;
// ── 表示（毎フレーム）──
function _wtTabOpen() {
    const sp = document.getElementById('settings-panel');
    if (!sp || !sp.classList.contains('open')) return false;
    const t = document.querySelector('.settings-tab.active');
    return !!(t && t.dataset.tab === 'bulkheads');
}
function updateWatertight() {
    const hp = _wtHull();
    if (!hp || typeof shipGroup === 'undefined' || !shipGroup) { if (_wt.root) _wt.root.visible = false; return; }
    const key = _wtHullKey(hp);
    if (key !== _wt.key) { _wt.key = key; _wt.dirty = true; if (shipWT._auto) { shipWT.tN = null; } }
    if (_wt.dirty || !_wt.root || (typeof scene !== 'undefined' && _wt.root.parent !== scene)) _wtBuild();
    if (!_wt.root) return;
    _wtFollow();
    const tab = _wtTabOpen();
    const fl = typeof floodView === 'function' ? floodView() : false;
    _wt.root.visible = tab || !!shipWT.show || fl;
    for (const k in _wt.marks) _wt.marks[k].visible = tab;
}
window.updateWatertight = updateWatertight;

// ── ギズモ（10-ship-editor-propulsors.js の toggleGizmo から）──
//  wt_tz：横隔壁を前後へ・wt_th：横隔壁の高さ・wt_avg：横隔壁全体の高さ（平均）・
//  wt_lx：縦隔壁を左右へ・wt_lh：縦隔壁の高さ・wt_db：二重底の高さ
function _wtProxy(key, x, y, z) {
    let o = _wt.proxies[key];
    if (!o) { o = new THREE.Object3D(); o.name = 'wt-gizmo-' + key; _wt.proxies[key] = o; }
    if (_wt.root && o.parent !== _wt.root) _wt.root.add(o);
    o.position.set(x, y, z);
    return o;
}
function _wtGizmoPos(type, index) {
    const Lay = wtLayout(); if (!Lay) return null;
    const D = Lay.D, sc = physics.scale || 1;
    if (type === 'wt_tz' || type === 'wt_th') { const j = index; if (j < 0 || j >= Lay.n) return null; return [0, D.yBot + D.H * shipWT.th[j], Lay.cuts[j + 1]]; }
    if (type === 'wt_avg') { const avg = Lay.n ? shipWT.th.reduce((s, v) => s + v, 0) / Lay.n : 1; return [0, D.yBot + D.H * avg, (D.aS + D.aB) / 2]; }
    if (type === 'wt_lx' || type === 'wt_lh') {
        if (!Lay.lN) return null;
        const sp = _wtLongSpan(D, Lay.cuts), k = type === 'wt_lx' ? index : 0;
        if (k < 0 || k >= Lay.lN) return null;
        return [Lay.lx[k] * _wtHWRef(D, sp.mid), D.yBot + D.H * shipWT.lh, sp.mid];
    }
    if (type === 'wt_db') return [0, D.yBot + shipWT.db / sc, D.aS + (D.aB - D.aS) * 0.3];
    return null;
}
const _wtPrevGizmoTarget = window.getExtraGizmoTarget;
const _wtPrevGizmoChange = window.onExtraGizmoChange;
window.getExtraGizmoTarget = function (type, index) {
    if (typeof type === 'string' && type.startsWith('wt_')) {
        if (_wt.dirty || !_wt.root) _wtBuild();
        const p = _wtGizmoPos(type, index);
        if (!p || !_wt.root) return null;
        return { mesh: _wtProxy(type + ':' + index, p[0], p[1], p[2]), btnId: `gizmo-${type}-${index}` };
    }
    return _wtPrevGizmoTarget ? _wtPrevGizmoTarget(type, index) : null;
};
window.onExtraGizmoChange = function (type, index, target) {
    if (typeof type === 'string' && type.startsWith('wt_')) {
        const Lay = wtLayout(); if (!Lay) return true;
        const D = Lay.D, sc = physics.scale || 1, P = target.position;
        const gap = Math.max(2 / sc, (D.aB - D.aS) * 0.01);           // となりの隔壁・船の端との間（2m 以上）
        if (type === 'wt_tz') {
            const j = index, lo = (j > 0 ? Lay.cuts[j] : D.aS) + gap, hi = (j < Lay.n - 1 ? Lay.cuts[j + 2] : D.aB) - gap;
            const a = Math.max(lo, Math.min(hi, P.z));
            shipWT.tz[j] = +(a / D.half).toFixed(5);
        } else if (type === 'wt_th') {
            shipWT.th[index] = +Math.max(0.05, Math.min(1.5, (P.y - D.yBot) / D.H)).toFixed(4);
        } else if (type === 'wt_avg') {
            const avg = Lay.n ? shipWT.th.reduce((s, v) => s + v, 0) / Lay.n : 1;
            const want = Math.max(0.05, Math.min(1.5, (P.y - D.yBot) / D.H)), d = want - avg;
            shipWT.th = shipWT.th.map(h => +Math.max(0.05, Math.min(1.5, h + d)).toFixed(4));
        } else if (type === 'wt_lx') {
            const sp = _wtLongSpan(D, Lay.cuts), ref = Math.max(1e-6, _wtHWRef(D, sp.mid));
            const k = index, n = Lay.lN, mg = 0.04;
            const lo = (k > 0 ? Lay.lx[k - 1] : -1) + mg, hi = (k < n - 1 ? Lay.lx[k + 1] : 1) - mg;
            let f = Math.max(lo, Math.min(hi, P.x / ref));
            if (shipWT.lSym) {
                const m = n - 1 - k;
                if (m === k) f = 0;                                         // 奇数枚の真ん中は中心線
                else {
                    // 反対舷の相手と入れ替わらない（真ん中を越えない）
                    f = k < m ? Math.min(f, -mg / 2) : Math.max(f, mg / 2);
                    shipWT.lx[m] = +(-f).toFixed(4);
                }
            }
            shipWT.lx[k] = +f.toFixed(4);
        } else if (type === 'wt_lh') {
            shipWT.lh = +Math.max(0.05, Math.min(1.5, (P.y - D.yBot) / D.H)).toFixed(4);
        } else if (type === 'wt_db') {
            shipWT.db = +Math.max(0, Math.min(_wtDraft(D) * 0.6, (P.y - D.yBot) * sc)).toFixed(2);
        }
        // ギズモの位置は、決まった所へ戻す（ほかの向きには動かない）
        const p = _wtGizmoPos(type, index);
        if (p) P.set(p[0], p[1], p[2]);
        _wtChanged(false);
        _wtSyncPanelValues();
        return true;
    }
    return _wtPrevGizmoChange ? _wtPrevGizmoChange(type, index, target) : false;
};
// ギズモを出す（動かせる向きだけ表示する）
function wtGizmo(type, index) {
    if (typeof toggleGizmo !== 'function') return;
    if (_wt.dirty || !_wt.root) _wtBuild();
    toggleGizmo(type, index);
    if (typeof currentGizmoType !== 'undefined' && currentGizmoType === type && transformControl) {
        transformControl.showX = type === 'wt_lx';
        transformControl.showY = type === 'wt_th' || type === 'wt_avg' || type === 'wt_lh' || type === 'wt_db';
        transformControl.showZ = type === 'wt_tz';
    }
}
window.wtGizmo = wtGizmo;

// ── 設定の変更 ──
function _wtChanged(rerender) {
    shipWT._auto = false;
    _wt.dirty = true;
    if (typeof floodLayoutChanged === 'function') floodLayoutChanged();
    if (rerender !== false) renderWTPanel();
}
function wtSet(key, v) {
    const Lay = wtLayout(); if (!Lay) return;
    const D = Lay.D, sc = physics.scale || 1;
    if (key === 'tN') { shipWT.tN = Math.max(0, Math.min(40, Math.round(+v || 0))); shipWT.tz = []; shipWT.sA = null; shipWT.sB = null; }
    else if (key === 'lN') { shipWT.lN = Math.max(0, Math.min(8, Math.round(+v || 0))); shipWT.lx = []; }
    else if (key === 'lSym') { shipWT.lSym = !!v; if (shipWT.lSym) { const n = shipWT.lN; for (let k = 0; k < Math.floor(n / 2); k++) { const f = (Math.abs(shipWT.lx[k]) + Math.abs(shipWT.lx[n - 1 - k])) / 2; shipWT.lx[k] = -f; shipWT.lx[n - 1 - k] = f; } if (n % 2) shipWT.lx[(n - 1) / 2] = 0; } }
    else if (key === 'avg') { const avg = Lay.n ? shipWT.th.reduce((s, x) => s + x, 0) / Lay.n : 1, d = (+v) - avg; shipWT.th = shipWT.th.map(h => +Math.max(0.05, Math.min(1.5, h + d)).toFixed(4)); }
    else if (key === 'lh') shipWT.lh = Math.max(0.05, Math.min(1.5, +v || 1));
    else if (key === 'db') shipWT.db = Math.max(0, Math.min(_wtDraft(D) * 0.6, +v || 0));
    else if (key === 'sA') { shipWT.sA = Math.max(0, Math.min(Lay.n, Math.round(+v))); shipWT.sB = Math.max(shipWT.sA, shipWT.sB); }
    else if (key === 'sB') { shipWT.sB = Math.max(0, Math.min(Lay.n, Math.round(+v))); shipWT.sA = Math.min(shipWT.sA, shipWT.sB); }
    else if (key === 'show') { shipWT.show = !!v; renderWTPanel(); return; }
    if (typeof disableGizmo === 'function' && typeof currentGizmoType !== 'undefined' && currentGizmoType && String(currentGizmoType).startsWith('wt_') && (key === 'tN' || key === 'lN')) disableGizmo();
    _wtChanged(key !== 'avg' && key !== 'lh' && key !== 'db');
    if (key === 'avg' || key === 'lh' || key === 'db') _wtSyncPanelValues();
}
// 1枚ずつ：横隔壁の位置（船尾の端から[m]）・高さ（船底から[m]）、縦隔壁の位置（船の真ん中で中心線から[m]、左舷が＋）
function wtSetOne(kind, i, v) {
    const Lay = wtLayout(); if (!Lay) return;
    const D = Lay.D, sc = physics.scale || 1, x = parseFloat(v);
    if (!Number.isFinite(x)) return;
    if (kind === 'tz') {
        const gap = Math.max(2 / sc, (D.aB - D.aS) * 0.01);
        const lo = (i > 0 ? Lay.cuts[i] : D.aS) + gap, hi = (i < Lay.n - 1 ? Lay.cuts[i + 2] : D.aB) - gap;
        shipWT.tz[i] = +(Math.max(lo, Math.min(hi, D.aS + x / sc)) / D.half).toFixed(5);
    } else if (kind === 'th') shipWT.th[i] = +Math.max(0.05, Math.min(1.5, x / sc / D.H)).toFixed(4);
    else if (kind === 'lx') {
        const sp = _wtLongSpan(D, Lay.cuts), ref = Math.max(1e-6, _wtHWRef(D, sp.mid));
        const n = Lay.lN, mg = 0.04, lo = (i > 0 ? Lay.lx[i - 1] : -1) + mg, hi = (i < n - 1 ? Lay.lx[i + 1] : 1) - mg;
        let f = Math.max(lo, Math.min(hi, x / sc / ref));
        if (shipWT.lSym) { const m = n - 1 - i; if (m === i) f = 0; else { f = i < m ? Math.min(f, -mg / 2) : Math.max(f, mg / 2); shipWT.lx[m] = +(-f).toFixed(4); } }
        shipWT.lx[i] = +f.toFixed(4);
    }
    _wtChanged(false);
    _wtSyncPanelValues();
}
function wtEqual(kind) {
    const Lay = wtLayout(); if (!Lay) return;
    if (kind === 't') shipWT.tz = _wtEqualT(Lay.D, shipWT.tN);
    else shipWT.lx = _wtEqualL(shipWT.lN);
    _wtChanged();
}
function wtAuto() {
    if (!confirm('水密隔壁を、この船の長さに合わせたおすすめの配置（全長を等分・主甲板までの高さ・縦隔壁なし）に戻しますか？')) return;
    if (typeof disableGizmo === 'function') disableGizmo();
    Object.assign(shipWT, JSON.parse(JSON.stringify(WT_DEF)), { show: shipWT.show });
    _wtChanged();
}
function wtTestHole() {
    const el = document.getElementById('wt-settings'); if (!el || typeof floodTestHole !== 'function') return;
    const q = (c) => el.querySelector(c);
    floodTestHole(+q('.wt-test-s').value, q('.wt-test-side').value, Math.max(0.05, +q('.wt-test-a').value || 1), Math.max(0, +q('.wt-test-d').value || 0));
}
Object.assign(window, { wtSet, wtSetOne, wtEqual, wtAuto, wtTestHole });

// ── 設定パネル（入力欄には id を付けない：保存の「パネルの入力欄すべて」に混ざらないように）──
function _wtFmt(v, d) { return (Math.round(v * Math.pow(10, d)) / Math.pow(10, d)).toFixed(d); }
function renderWTPanel() {
    const el = document.getElementById('wt-settings');
    if (!el) return;
    const Lay = wtLayout();
    if (!Lay) { el.innerHTML = '<div class="sp-section-title">🧱 水密区画</div><div style="font-size:11px;color:#888;">船の模型を読み込むと設定できます。</div>'; return; }
    const D = Lay.D, sc = physics.scale || 1, Lm = (D.aB - D.aS) * sc, Hm = D.H * sc;
    const avg = Lay.n ? shipWT.th.reduce((s, v) => s + v, 0) / Lay.n : 1;
    const sp = _wtLongSpan(D, Lay.cuts), ref = _wtHWRef(D, sp.mid) * sc;
    const btn = (type, i, label, title) => `<button class="sp-gizmo-btn" id="gizmo-${type}-${i}" onclick="wtGizmo('${type}', ${i})" title="${title || ''}">${label}</button>`;
    const nSec = Lay.n + 1;
    const secOpt = (cur) => Array.from({ length: nSec }, (_, s) => `<option value="${s}"${s === cur ? ' selected' : ''}>${s + 1}</option>`).join('');
    const nComp = (() => { let c = 0; for (let s = 0; s < nSec; s++) c += (Lay.lN && s >= Lay.sA && s <= Lay.sB) ? Lay.lN + 1 : 1; return c; })();
    el.innerHTML = `<div class="sp-section-title">🧱 水密隔壁・区画</div>
        <div style="font-size:10px;color:#888;margin-bottom:6px;">
          船を仕切る水密隔壁です。魚雷・砲弾・衝突・座礁で船体に穴があくと、その区画に水が入り、水の量と区画の位置で船が沈み・傾きます。
          水が隔壁の上の縁を越えると、となりの区画へあふれます。船の中に、隔壁が透けて見えます（青＝横隔壁・橙＝縦隔壁・灰＝二重底）。<br>
          全長 ${_wtFmt(Lm, 1)}m・船底から主甲板まで ${_wtFmt(Hm, 1)}m・喫水 ${_wtFmt(_wtDraft(D), 1)}m　区画の数 <b class="wt-ncomp">${nComp}</b>
        </div>
        <div class="sp-row" style="gap:6px;flex-wrap:wrap;">
          <button class="sp-gizmo-btn" onclick="wtAuto()">✨ おすすめの配置に戻す</button>
          <label class="sp-toggle"><input type="checkbox" ${shipWT.show ? 'checked' : ''} onchange="wtSet('show', this.checked)"> 航海中も隔壁を透かして表示する</label>
        </div>
        <div class="sp-section-title" style="margin-top:8px;">横隔壁（船を前後に仕切る）</div>
        <div class="sp-row" style="gap:6px;flex-wrap:wrap;align-items:center;">
          <span class="sp-label" style="min-width:0;">枚数:</span>
          <button class="sp-gizmo-btn" onclick="wtSet('tN', shipWT.tN - 1)">−</button>
          <input type="number" class="sp-num-input" style="width:52px" min="0" max="40" step="1" value="${Lay.n}" onchange="wtSet('tN', this.value)">
          <button class="sp-gizmo-btn" onclick="wtSet('tN', shipWT.tN + 1)">＋</button>
          <button class="sp-gizmo-btn" onclick="wtEqual('t')" title="全長を等分する位置に並べ直す">⇔ 等間隔に並べ直す</button>
        </div>
        <div class="sp-row" style="gap:6px;flex-wrap:wrap;align-items:center;">
          <span class="sp-label" style="min-width:0;">全体の高さ（平均）:</span>
          <input type="range" class="sp-slider wt-avg" min="0.2" max="1.3" step="0.01" value="${avg.toFixed(3)}" oninput="wtSet('avg', +this.value)">
          <span class="wt-avg-txt" style="font-size:11px;">${_wtFmt(avg * Hm, 1)}m</span>
          ${btn('wt_avg', 0, '↕ ギズモで全体の高さ', '横隔壁ぜんぶの高さを、平均で上下する（1枚ずつの差はそのまま）')}
        </div>
        <div style="font-size:10px;color:#888;margin-bottom:4px;">高さ ${_wtFmt(Hm, 1)}m が主甲板です（タイタニックのように主甲板より低い隔壁は、船首が沈むと水が上を越えて後ろの区画へあふれます）。</div>
        <div class="wt-tlist">${shipWT.tz.map((u, j) => `
          <div class="sp-row" style="gap:4px;flex-wrap:wrap;align-items:center;">
            <span style="font-size:11px;white-space:nowrap;">#${j + 1} 船尾から</span>
            <input type="number" class="sp-num-input wt-tz" style="width:58px" data-i="${j}" step="0.5" value="${_wtFmt((Lay.cuts[j + 1] - D.aS) * sc, 1)}" onchange="wtSetOne('tz', ${j}, this.value)"><span style="font-size:10px;">m</span>
            <span style="font-size:11px;white-space:nowrap;">高さ</span>
            <input type="number" class="sp-num-input wt-th" style="width:52px" data-i="${j}" step="0.5" value="${_wtFmt(shipWT.th[j] * Hm, 1)}" onchange="wtSetOne('th', ${j}, this.value)"><span style="font-size:10px;">m</span>
            ${btn('wt_tz', j, '📍前後', 'この隔壁を前後へ動かす')}${btn('wt_th', j, '↕高さ', 'この隔壁の高さを変える')}
          </div>`).join('')}</div>
        <div class="sp-section-title" style="margin-top:8px;">縦隔壁（船を左右に仕切る）</div>
        <div class="sp-row" style="gap:6px;flex-wrap:wrap;align-items:center;">
          <span class="sp-label" style="min-width:0;">枚数:</span>
          <button class="sp-gizmo-btn" onclick="wtSet('lN', shipWT.lN - 1)">−</button>
          <input type="number" class="sp-num-input" style="width:52px" min="0" max="8" step="1" value="${Lay.lN}" onchange="wtSet('lN', this.value)">
          <button class="sp-gizmo-btn" onclick="wtSet('lN', shipWT.lN + 1)">＋</button>
          <label class="sp-toggle"><input type="checkbox" ${shipWT.lSym ? 'checked' : ''} onchange="wtSet('lSym', this.checked)"> 左右対称</label>
          <button class="sp-gizmo-btn" onclick="wtEqual('l')" title="幅を等分する位置に並べ直す">⇔ 等間隔に並べ直す</button>
        </div>
        ${Lay.lN ? `
        <div class="sp-row" style="gap:6px;flex-wrap:wrap;align-items:center;">
          <span class="sp-label" style="min-width:0;">付ける区画（船尾から）:</span>
          <select onchange="wtSet('sA', this.value)">${secOpt(Lay.sA)}</select> 番目 〜
          <select onchange="wtSet('sB', this.value)">${secOpt(Lay.sB)}</select> 番目
        </div>
        <div class="sp-row" style="gap:6px;flex-wrap:wrap;align-items:center;">
          <span class="sp-label" style="min-width:0;">高さ:</span>
          <input type="range" class="sp-slider wt-lh" min="0.2" max="1.3" step="0.01" value="${shipWT.lh.toFixed(3)}" oninput="wtSet('lh', +this.value)">
          <span class="wt-lh-txt" style="font-size:11px;">${_wtFmt(shipWT.lh * Hm, 1)}m</span>
          ${btn('wt_lh', 0, '↕ ギズモで高さ', '縦隔壁の高さを上下する')}
        </div>
        <div style="font-size:10px;color:#888;margin-bottom:4px;">位置は、範囲の真ん中（その所の喫水線の幅 ${_wtFmt(ref * 2, 1)}m）での中心線からの距離です（左舷が＋）。前後では舷側に沿って曲がります。</div>
        <div class="wt-llist">${Lay.lx.map((f, k) => `
          <div class="sp-row" style="gap:4px;flex-wrap:wrap;align-items:center;">
            <span style="font-size:11px;white-space:nowrap;">#${k + 1} 中心線から</span>
            <input type="number" class="sp-num-input wt-lx" style="width:58px" data-i="${k}" step="0.2" value="${_wtFmt(f * ref, 2)}" onchange="wtSetOne('lx', ${k}, this.value)"><span style="font-size:10px;">m</span>
            ${btn('wt_lx', k, '📍左右', 'この縦隔壁を左右へ動かす' + (shipWT.lSym ? '（反対舷の隔壁も対称に動く）' : ''))}
          </div>`).join('')}</div>` : '<div style="font-size:10px;color:#888;">縦隔壁なし（区画は左右いっぱい）。左右に分けると、片舷だけに水が入って船が横に傾くことがあります。</div>'}
        <div class="sp-section-title" style="margin-top:8px;">二重底</div>
        <div class="sp-row" style="gap:6px;flex-wrap:wrap;align-items:center;">
          <span class="sp-label" style="min-width:0;">内底板の高さ（船底から）:</span>
          <input type="number" class="sp-num-input wt-db" style="width:64px" min="0" step="0.1" value="${_wtFmt(shipWT.db, 2)}" onchange="wtSet('db', this.value)"><span style="font-size:10px;">m</span>
          ${btn('wt_db', 0, '↕ ギズモで高さ', '二重底（内底板）の高さを上下する')}
        </div>
        <div style="font-size:10px;color:#888;">軽い座礁・衝突で船底に穴があいても、水は二重底の中までで、区画には入りません（強い座礁・魚雷は内底板まで破ります）。0 で二重底なし。</div>
        <div class="wt-vol" style="font-size:10px;color:#9ab;margin-top:6px;"></div>
        <div class="sp-section-title" style="margin-top:8px;">試しに穴をあける</div>
        <div class="sp-row" style="gap:6px;flex-wrap:wrap;align-items:center;">
          <span style="font-size:11px;">船尾から</span><select class="wt-test-s">${secOpt(Math.max(0, Lay.n - 1))}</select><span style="font-size:11px;">番目の区画の</span>
          <select class="wt-test-side"><option value="p">左舷</option><option value="s">右舷</option></select>
        </div>
        <div class="sp-row" style="gap:6px;flex-wrap:wrap;align-items:center;">
          <span style="font-size:11px;">大きさ</span><input type="number" class="sp-num-input wt-test-a" style="width:52px" min="0.05" step="0.1" value="1"><span style="font-size:10px;">m²</span>
          <span style="font-size:11px;">喫水線の下</span><input type="number" class="sp-num-input wt-test-d" style="width:52px" min="0" step="0.5" value="4"><span style="font-size:10px;">m</span>
          <button class="sp-gizmo-btn" onclick="wtTestHole()">💥 穴をあける</button>
        </div>
        <div style="font-size:10px;color:#888;">設定画面を閉じると水が入り始めます。画面の「被害」ボタンで、区画ごとの水・傾き・排水ポンプ・修理。（タイタニックの氷山の穴は合わせて 1m² ほどと言われます）</div>`;
    _wtSyncPanelValues(true);
}
window.renderWTPanel = renderWTPanel;
// ギズモで動かしている間は、パネルの数字だけ書き換える
function _wtSyncPanelValues(volOnly) {
    const el = document.getElementById('wt-settings'); if (!el) return;
    const Lay = wtLayout(); if (!Lay) return;
    const D = Lay.D, sc = physics.scale || 1, Hm = D.H * sc;
    if (!volOnly) {
        el.querySelectorAll('.wt-tz').forEach(inp => { const j = +inp.dataset.i; if (j < Lay.n && document.activeElement !== inp) inp.value = _wtFmt((Lay.cuts[j + 1] - D.aS) * sc, 1); });
        el.querySelectorAll('.wt-th').forEach(inp => { const j = +inp.dataset.i; if (j < Lay.n && document.activeElement !== inp) inp.value = _wtFmt(shipWT.th[j] * Hm, 1); });
        const sp = _wtLongSpan(D, Lay.cuts), ref = _wtHWRef(D, sp.mid) * sc;
        el.querySelectorAll('.wt-lx').forEach(inp => { const k = +inp.dataset.i; if (k < Lay.lN && document.activeElement !== inp) inp.value = _wtFmt(Lay.lx[k] * ref, 2); });
        const avg = Lay.n ? shipWT.th.reduce((s, v) => s + v, 0) / Lay.n : 1;
        const a = el.querySelector('.wt-avg'); if (a && document.activeElement !== a) a.value = avg.toFixed(3);
        const at = el.querySelector('.wt-avg-txt'); if (at) at.textContent = _wtFmt(avg * Hm, 1) + 'm';
        const lh = el.querySelector('.wt-lh'); if (lh && document.activeElement !== lh) lh.value = shipWT.lh.toFixed(3);
        const lt = el.querySelector('.wt-lh-txt'); if (lt) lt.textContent = _wtFmt(shipWT.lh * Hm, 1) + 'm';
        const db = el.querySelector('.wt-db'); if (db && document.activeElement !== db) db.value = _wtFmt(shipWT.db, 2);
    }
    const vb = el.querySelector('.wt-vol');
    if (vb && typeof floodSummary === 'function') vb.innerHTML = floodSummary();
}

// ── 保存（13-save-load-config.js から）──
function getWTConfig() { const c = JSON.parse(JSON.stringify(shipWT)); delete c._auto; return c; }
function applyWTConfig(c) {
    if (typeof disableGizmo === 'function' && typeof currentGizmoType !== 'undefined' && currentGizmoType && String(currentGizmoType).startsWith('wt_')) disableGizmo();
    Object.keys(shipWT).forEach(k => delete shipWT[k]);
    Object.assign(shipWT, JSON.parse(JSON.stringify(WT_DEF)), c && typeof c === 'object' ? JSON.parse(JSON.stringify(c)) : {});
    shipWT._auto = !c;                     // 保存に無ければ、船の長さに合わせたおすすめの配置（模型が変われば数え直す）
    _wt.dirty = true;
    if (typeof floodLayoutChanged === 'function') floodLayoutChanged();
    renderWTPanel();
}
window.getWTConfig = getWTConfig;
window.applyWTConfig = applyWTConfig;
shipWT._auto = true;

document.addEventListener('DOMContentLoaded', renderWTPanel);
