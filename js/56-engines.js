// ============================================================
//  機関（スクリューごとのエンジン）：後進できるか・馬力・独立操作
// ============================================================
//  ・スクリュー（モデルのスクリュー部品、無ければ組み込みの推進器）ごとに機関が 1 基ある。
//    船体設定「⚙ 推進器」で、後進できるか（タービン船の中央のスクリューなど、後進できないものがある）と
//    馬力を決める。馬力が空なら、排水量と最高速力から見積もった馬力を等分する。
//  ・ふだんはテレグラフ 1 つで全部の機関を動かす（後進できない機関は後進の指令では止まる）。
//  ・テレグラフの上の「機関」ボタンで独立操作にすると、機関ごとの小さなテレグラフが並ぶ
//   （後進できない機関のテレグラフには後進の目盛りが無い）。左右の機関を前進・後進に分けると、
//    船はその場で回る。
//  ・推力：機関 i の回転数 r_i（前進全速＝1、後進全速＝−0.5）、推力の重み w_i ∝ 馬力^(2/3)。
//    S = Σ w_i r_i|r_i|、船の出す速さ ＝ 最高速力 × sign(S)√|S|（全部同じ回転なら今までと同じ）。
//    馬力の合計が見積もりより大きければ、加速も速い（物理の推力の強さに掛ける）。
const ENG_RPM_OF = { 3: 1, 2: 0.6, 1: 0.3, 0: 0, '-1': -0.15, '-2': -0.3, '-3': -0.5 };
const shipEngines = { split: false, conf: {} };     // conf[スクリューの id] = { astern, hp, name }
window.shipEngines = shipEngines;
const _eng = { list: [], key: '', checkT: -1, ui: null };

// ── 排水量（千トン単位の physics.mass）と最高速力から、必要な馬力を見積もる（アドミラルティ係数 C≈380, kW） ──
function engineEstimateHp() {
    const disp = Math.max(1, (physics.mass || 1.5) * 1000);         // トン
    const V = Math.max(1, physics.maxSpeed || 13);
    const kW = Math.pow(disp, 2 / 3) * V * V * V / 380;
    return kW * 1.341;
}
function engineTopSpeedForHp(hp) {
    const disp = Math.max(1, (physics.mass || 1.5) * 1000);
    return Math.cbrt(Math.max(0, hp / 1.341) * 380 / Math.pow(disp, 2 / 3));
}

// ── スクリューの一覧（変わったら作り直す） ──
function _engScrews() {
    const out = [];
    if (typeof glbMovableParts !== 'undefined' && glbMovableParts) {
        for (const p of glbMovableParts) if ((p.key === 'screw' || p.key === 'paddle') && !p.disabled && p.object) out.push({ id: 'glb:' + p.id, part: p, label: p.name || p.id });
    }
    if (!out.length && typeof propMeshes !== 'undefined' && propMeshes) {
        for (const g of propMeshes) if (g.userData.isProp) out.push({ id: 'prop:' + g.userData.propIndex + (g.userData.isMirror ? ':m' : ''), mesh: g, label: `推進器 ${g.userData.propIndex + 1}${g.userData.isMirror ? '（反対舷）' : ''}` });
    }
    return out;
}
// 船の中の左右の位置（+x＝左舷）を、船の半幅に対する割合で
function _engSide(s) {
    if (typeof shipGroup === 'undefined' || !shipGroup) return 0;
    let x = 0;
    if (s.part && typeof analyzeScrewDisc === 'function') {
        const d = analyzeScrewDisc(s.part);
        if (d) { const v = d.center.clone(); const par = s.part.object.parent || shipGroup; par.updateWorldMatrix(true, false); v.applyMatrix4(par.matrixWorld); shipGroup.worldToLocal(v); x = v.x; }
    } else if (s.mesh) x = s.mesh.position.x;
    const hp = window.hullProfile;
    let hb = 1; if (hp && hp.ready) { hb = 0; for (const q of hp.slices) hb = Math.max(hb, q.halfWidth || 0); }
    return Math.max(-1.5, Math.min(1.5, x / (hb || 1)));
}
function engineList() {
    const now = performance.now();
    if (now - _eng.checkT > 1000 || !_eng.list.length) {
        _eng.checkT = now;
        const S = _engScrews();
        const key = S.map(s => s.id).join(',');
        if (key !== _eng.key) {
            const old = new Map(_eng.list.map(E => [E.id, E]));
            _eng.key = key;
            _eng.list = S.map((s, i) => {
                const E = old.get(s.id) || { order: 0, answer: 0, answerAt: -1, rpm: 0, hold: 0 };
                E.id = s.id; E.screw = s; E.idx = i;
                if (!shipEngines.conf[s.id]) shipEngines.conf[s.id] = { astern: true, hp: 0, name: '' };
                E.conf = shipEngines.conf[s.id];
                E.side = _engSide(s);
                return E;
            });
            _engLayoutUI();
        } else for (const E of _eng.list) { E.side = _engSide(E.screw); E.conf = shipEngines.conf[E.id] || E.conf; }
    }
    return _eng.list;
}
window.engineList = engineList;
function engineName(E) { return (E.conf && E.conf.name) || (_eng.list.length === 1 ? '機関' : (E.side > 0.15 ? '左舷' : E.side < -0.15 ? '右舷' : '中央') + '機関'); }
// 機関ごとの馬力（空なら見積もりを等分）
function engineHp(E) { const L = engineList(); return E.conf && E.conf.hp > 0 ? E.conf.hp : engineEstimateHp() / Math.max(1, L.length); }
function _engWeights() {
    const L = engineList(); let s = 0; const w = L.map(E => { const v = Math.pow(engineHp(E), 2 / 3); s += v; return v; });
    return w.map(v => v / (s || 1));
}
// 推力の強さの倍率：馬力の合計 ÷ 見積もり の 1/3 乗（0.5〜2）
function enginePowerFactor() {
    const L = engineList(); if (!L.length || !L.some(E => E.conf && E.conf.hp > 0)) return 1;
    let P = 0; for (const E of L) P += engineHp(E);
    return Math.max(0.5, Math.min(2, Math.cbrt(P / Math.max(1, engineEstimateHp()))));
}
window.enginePowerFactor = enginePowerFactor;

// ── 指令 ──
function _engIndependent() {
    // 自動航行・自動の離着岸の間は、テレグラフ 1 つでまとめて動かす
    const auto = (window.autopilot && autopilot.active) || (window.harborAuto && harborAuto.mode);
    return shipEngines.split && !auto;
}
function _engTargetOrder(E) {
    let o = _engIndependent() ? E.answer : (Number.isFinite(physics.telegraphAnswer) ? physics.telegraphAnswer : physics.telegraphState || 0);
    if (!_engIndependent() && physics.telegraphAnswerSpecial) o = 0;
    if (E.conf && E.conf.astern === false && o < 0) o = 0;           // 後進できない機関は止める
    return o;
}
function engineSetOrder(i, v) {
    const E = engineList()[i]; if (!E) return;
    const lim = E.conf.astern === false ? 0 : -3;
    v = Math.max(lim, Math.min(3, Math.round(v)));
    if (v === E.order) return;
    const steps = Math.abs(v - E.order) || 1;
    E.order = v;
    if (typeof telegraphBell === 'function') telegraphBell(bridgeUI.telegraph, false, steps);
    const wait = !(window.bridgeUI && bridgeUI.waitAnswer === false);
    E.answerAt = wait ? performance.now() + 1300 * (0.8 + Math.random() * 0.5) : -1;
    if (!wait) E.answer = v;
    _engDrawAll();
}
window.engineSetOrder = engineSetOrder;
function engineSetSplit(on) {
    shipEngines.split = !!on;
    // 独立にしたときは、今のテレグラフの指令から始める
    const o = physics.telegraphState || 0;
    for (const E of engineList()) { const lim = E.conf.astern === false ? 0 : -3; E.order = E.answer = Math.max(lim, o); E.answerAt = -1; }
    if (!on) { /* まとめて動かすときは、メインのテレグラフに従う */ }
    _engLayoutUI();
}
window.engineSetSplit = engineSetSplit;

// ── 物理（32-engine-propeller.js の updatePropRpm から） ──
const ENG_SPOOL_UP = 0.08, ENG_SPOOL_DOWN = 0.14, ENG_REVERSE_DELAY = 3.0;
function engineUpdate(dt, designMode) {
    const L = engineList();
    if (!L.length) return null;
    const now = performance.now();
    for (const E of L) {
        if (E.answerAt > 0 && now >= E.answerAt) { E.answerAt = -1; E.answer = E.order; if (typeof telegraphBell === 'function') telegraphBell(bridgeUI.telegraph, true); _engDrawAll(); }
        const target = designMode ? 0 : ENG_RPM_OF[_engTargetOrder(E)] || 0;
        let r = E.rpm;
        const ap = (v, t, rate) => { const d = t - v, s = rate * dt; return Math.abs(d) <= s ? t : v + Math.sign(d) * s; };
        if (target * r < 0) { r = ap(r, 0, ENG_SPOOL_DOWN); if (r === 0) E.hold = ENG_REVERSE_DELAY; }
        else if (E.hold > 0 && r === 0 && target !== 0) E.hold -= dt;
        else { E.hold = 0; r = ap(r, target, Math.abs(target) > Math.abs(r) ? ENG_SPOOL_UP : ENG_SPOOL_DOWN); }
        E.rpm = r;
    }
    const w = _engWeights();
    let S = 0; L.forEach((E, i) => { S += w[i] * E.rpm * Math.abs(E.rpm); });
    return Math.sign(S) * Math.sqrt(Math.abs(S));
}
window.engineUpdate = engineUpdate;
// 左右の機関の推力の差で回る速さ[度/秒]（左舷の機関が前進 → 船首は右へ＝heading が減る）
function engineTwistDeg() {
    const L = engineList(); if (L.length < 2) return 0;
    const w = _engWeights();
    let m = 0; L.forEach((E, i) => { m += w[i] * E.rpm * Math.abs(E.rpm) * E.side; });
    const hp = window.hullProfile, len = ((hp && hp.ready) ? hp.halfLen * 2 : 12) * (physics.scale || 1);
    return -m * 700 / Math.max(20, len);           // 270m の船で、左右を半速の前進・後進にして毎秒 0.2° ほど
}
window.engineTwistDeg = engineTwistDeg;
// そのスクリューの回転数（前進全速＝1）。見た目の回転・泡に使う
function engineRpmFor(id) { const E = _eng.list.find(q => q.id === id); return E ? E.rpm : (physics.propRpm || 0); }
window.engineRpmFor = engineRpmFor;

// ════════════════════════════════════════════════════════════
//  画面：独立操作のボタンと、機関ごとの小さなテレグラフ
// ════════════════════════════════════════════════════════════
function _engSetupUI() {
    if (_eng.ui) return;
    const btn = document.createElement('div');
    btn.id = 'btn-engines'; btn.className = 'control-btn'; btn.title = '機関を独立して操作する';
    btn.addEventListener('click', (e) => { e.stopPropagation(); engineSetSplit(!shipEngines.split); });
    document.body.appendChild(btn);
    const box = document.createElement('div');
    box.id = 'engine-tgs';
    document.body.appendChild(box);
    _eng.ui = { btn, box, canvases: [] };
    window.addEventListener('resize', _engLayoutUI);
    _engLayoutUI();
}
function _engLayoutUI() {
    const U = _eng.ui; if (!U) return;
    const L = engineList();
    const tg = document.getElementById('telegraph-widget');
    const S = (typeof _br !== 'undefined' && _br.size) || 170;
    const useTg = !(window.bridgeUI && bridgeUI.telegraph === 'buttons');
    const show = L.length >= 2;
    U.btn.style.display = show ? '' : 'none';
    U.btn.textContent = shipEngines.split ? '機関：独立' : '機関：一括';
    U.btn.classList.toggle('on', !!shipEngines.split);
    U.btn.style.bottom = `calc(${useTg ? S + 6 : 150}px + env(safe-area-inset-bottom))`;
    // テレグラフの右上（汽笛のボタンと重ならないように）
    if (!document.body.classList.contains('menu-open')) U.btn.style.left = `calc(${14 + Math.max(90, S - 84)}px + env(safe-area-inset-left))`;
    else U.btn.style.left = '';
    const split = show && shipEngines.split;
    if (tg) tg.style.visibility = split ? 'hidden' : '';
    U.box.style.display = split ? 'flex' : 'none';
    if (!split) return;
    // 機関ごとのテレグラフ（画面の幅の半分に収まる大きさ）
    const each = Math.max(84, Math.min(Math.round(S * 0.85), Math.floor((window.innerWidth * 0.55) / L.length)));
    if (U.canvases.length !== L.length) {
        U.box.innerHTML = '';
        U.canvases = L.map((E, i) => {
            const cv = document.createElement('canvas'); cv.className = 'eng-tg'; cv.dataset.i = i;
            _engSetupInput(cv, i);
            U.box.appendChild(cv);
            return cv;
        });
    }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    U.canvases.forEach(cv => { cv.width = Math.round(each * dpr); cv.height = Math.round(each * 1.18 * dpr); cv.style.width = each + 'px'; cv.style.height = Math.round(each * 1.18) + 'px'; cv._s = each; });
    _engDrawAll();
}
window.engineLayoutUI = _engLayoutUI;
// 目盛り：前進は左、後進は右（後進できない機関は、停止から前進だけの扇）
function _engDial(E) {
    const astern = E.conf.astern !== false;
    const orders = astern ? [3, 2, 1, 0, -1, -2, -3] : [3, 2, 1, 0];
    const span = astern ? 210 : 150;             // 扇の開き[度]
    const a0 = -span / 2;
    const ang = (o) => (a0 + (orders.indexOf(Math.max(orders[orders.length - 1], Math.min(3, o))) / (orders.length - 1)) * span) * Math.PI / 180;
    return { orders, ang, astern };
}
function _engAngleToOrder(E, a) {
    const D = _engDial(E); let best = 0, bd = 1e9;
    for (const o of D.orders) { const d = Math.abs(D.ang(o) - a); if (d < bd) { bd = d; best = o; } }
    return best;
}
function _engSetupInput(cv, i) {
    const pick = (e) => {
        const E = engineList()[i]; if (!E) return;
        const r = cv.getBoundingClientRect(), s = cv._s || r.width;
        const cx = r.left + s / 2, cy = r.top + s * 0.55;
        const a = Math.atan2(e.clientX - cx, -(e.clientY - cy));
        engineSetOrder(i, _engAngleToOrder(E, a));
    };
    cv.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); try { cv.setPointerCapture(e.pointerId); } catch (er) { /* */ } cv._drag = true; pick(e); });
    cv.addEventListener('pointermove', (e) => { if (cv._drag) { e.preventDefault(); pick(e); } });
    const up = () => { cv._drag = false; };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
}
function _engDrawAll() {
    const U = _eng.ui; if (!U || !shipEngines.split) return;
    const L = engineList();
    U.canvases.forEach((cv, i) => { const E = L[i]; if (E) _engDraw(cv, E); });
}
function _engDraw(cv, E) {
    const s = cv._s || 100, dpr = cv.width / s;
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, s, s * 1.18);
    const cx = s / 2, cy = s * 0.55, R = s * 0.46;
    const night = (typeof _tgNight === 'function') ? _tgNight() : 0;
    // 真鍮の縁と盤面
    const g = ctx.createLinearGradient(0, cy - R, 0, cy + R);
    g.addColorStop(0, '#f3d88a'); g.addColorStop(0.5, '#b88a2e'); g.addColorStop(1, '#6e4f17');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = night > 0.5 ? '#1e1a12' : '#f4efe2'; ctx.beginPath(); ctx.arc(cx, cy, R * 0.86, 0, Math.PI * 2); ctx.fill();
    const D = _engDial(E);
    // 目盛り（前進：緑寄り、後進：赤寄り、停止：黒）
    ctx.font = `bold ${Math.max(6, s * (D.astern ? 0.068 : 0.08))}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const lab = { 3: 'FULL', 2: 'HALF', 1: 'SLOW', 0: 'STOP', '-1': 'SLOW', '-2': 'HALF', '-3': 'FULL' };
    for (const o of D.orders) {
        const a = D.ang(o), x = cx + Math.sin(a) * R * 0.62, y = cy - Math.cos(a) * R * 0.62;
        ctx.fillStyle = o > 0 ? '#1e6b38' : o < 0 ? '#9a2a1e' : (night > 0.5 ? '#ddd' : '#222');
        ctx.save(); ctx.translate(x, y); ctx.rotate(a); ctx.fillText(lab[o], 0, 0); ctx.restore();
        ctx.strokeStyle = night > 0.5 ? '#998' : '#555'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(cx + Math.sin(a) * R * 0.78, cy - Math.cos(a) * R * 0.78); ctx.lineTo(cx + Math.sin(a) * R * 0.86, cy - Math.cos(a) * R * 0.86); ctx.stroke();
    }
    ctx.fillStyle = night > 0.5 ? '#8fd' : '#333'; ctx.font = `${Math.max(6, s * 0.07)}px sans-serif`;
    ctx.fillText('AHEAD', cx - R * 0.42, cy + R * 0.42);
    if (D.astern) ctx.fillText('ASTERN', cx + R * 0.42, cy + R * 0.42);
    else { ctx.fillStyle = '#9a2a1e'; ctx.fillText('後進なし', cx + R * 0.4, cy + R * 0.42); }
    // 機関室の応答（赤い細い針）と、指令のハンドル（真鍮の太い針）
    const needle = (a, len, w, col) => { ctx.strokeStyle = col; ctx.lineWidth = w; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.sin(a) * len, cy - Math.cos(a) * len); ctx.stroke(); };
    needle(D.ang(E.answer), R * 0.55, Math.max(1.5, s * 0.02), '#c0392b');
    needle(D.ang(E.order), R * 0.8, Math.max(3, s * 0.05), '#7a5a1a');
    ctx.fillStyle = '#5a3f10'; ctx.beginPath(); ctx.arc(cx, cy, s * 0.05, 0, Math.PI * 2); ctx.fill();
    // 名前・回転数・出力
    const hp = engineHp(E), out = hp * Math.pow(Math.abs(E.rpm), 3);
    ctx.fillStyle = '#e8f6ff'; ctx.font = `bold ${Math.max(8, s * 0.1)}px sans-serif`;
    ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 3;
    ctx.fillText(engineName(E), cx, s * 1.04);
    ctx.font = `${Math.max(7, s * 0.08)}px sans-serif`;
    ctx.fillText(`${Math.round(E.rpm * 100)}%・${Math.round(out).toLocaleString()}馬力`, cx, s * 1.13);
    ctx.shadowBlur = 0;
}
// 回転数の表示はときどき描き直す
setInterval(() => { if (shipEngines.split && _eng.ui && _eng.ui.box.style.display !== 'none') _engDrawAll(); }, 300);

// ════════════════════════════════════════════════════════════
//  船体設定「⚙ 推進器」の機関の欄
// ════════════════════════════════════════════════════════════
function renderEngineSettings() {
    const el = document.getElementById('engine-settings'); if (!el) return;
    const L = engineList();
    const est = engineEstimateHp();
    const any = L.some(E => E.conf.hp > 0);
    let tot = 0; for (const E of L) tot += engineHp(E);
    el.innerHTML = `<div class="sp-section-title">🔥 機関（スクリューごと）</div>
        <div style="font-size:10px;color:#888;margin-bottom:6px;">スクリューごとに機関が 1 基あります。後進できない機関（タービン船の中央のスクリューなど）は、後進の指令では止まり、独立操作のテレグラフにも後進がありません。
            馬力が空なら、排水量（${Math.round((physics.mass || 1.5) * 1000).toLocaleString()} トン）と最高速力（${physics.maxSpeed} ノット）から見積もった <b>${Math.round(est).toLocaleString()} 馬力</b>を等分します。</div>
        ${L.length ? L.map((E, i) => `<div class="sp-row" style="gap:6px;flex-wrap:wrap;align-items:center;">
            <b style="min-width:70px;">${engineName(E)}</b>
            <input type="text" placeholder="名前" value="${(E.conf.name || '').replace(/"/g, '&quot;')}" maxlength="16" style="width:80px;background:#0a1932;color:#00ffcc;border:1px solid #00ffcc55;border-radius:4px;padding:2px 4px;font-size:11px;" onchange="engineSetConf(${i}, 'name', this.value)">
            <label class="sp-toggle"><input type="checkbox" ${E.conf.astern !== false ? 'checked' : ''} onchange="engineSetConf(${i}, 'astern', this.checked)"> 後進できる</label>
            <span>馬力</span><input type="number" min="0" step="100" class="sp-num-input" style="width:84px" placeholder="${Math.round(est / L.length)}" value="${E.conf.hp > 0 ? E.conf.hp : ''}" onchange="engineSetConf(${i}, 'hp', this.value)">
            <span style="font-size:10px;color:#8ab;">${E.screw.label}</span></div>`).join('') : '<div style="font-size:11px;color:#888;">スクリューがありません</div>'}
        <div style="font-size:10px;color:#9cd;margin-top:4px;">合計 ${Math.round(tot).toLocaleString()} 馬力${any ? `（この馬力での最高速力の目安 ${engineTopSpeedForHp(tot).toFixed(1)} ノット・加速 ×${enginePowerFactor().toFixed(2)}）` : ''}</div>`;
}
window.renderEngineSettings = renderEngineSettings;
function engineSetConf(i, k, v) {
    const E = engineList()[i]; if (!E) return;
    if (k === 'hp') { const n = parseFloat(v); E.conf.hp = Number.isFinite(n) && n > 0 ? n : 0; }
    else if (k === 'astern') { E.conf.astern = !!v; if (!v && E.order < 0) { E.order = E.answer = 0; } }
    else E.conf[k] = v;
    renderEngineSettings(); _engLayoutUI();
}
window.engineSetConf = engineSetConf;

// ── 保存・読み込み（13-save-load-config.js） ──
function getEngineConfig() { return JSON.parse(JSON.stringify({ split: shipEngines.split, conf: shipEngines.conf })); }
function applyEngineConfig(c) {
    shipEngines.split = !!(c && c.split);
    shipEngines.conf = (c && c.conf) ? JSON.parse(JSON.stringify(c.conf)) : {};
    _eng.key = ''; _eng.list = []; _eng.checkT = -1;
    engineList(); _engLayoutUI();
    if (document.getElementById('engine-settings')) renderEngineSettings();
}
window.getEngineConfig = getEngineConfig; window.applyEngineConfig = applyEngineConfig;

document.addEventListener('DOMContentLoaded', () => { setTimeout(_engSetupUI, 100); });
