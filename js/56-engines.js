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
//  ・名前：スクリューとその機関は同じ名前で呼ぶ（「左舷」なら左舷スクリュー・左舷機関）。名前を決めなければ
//    船の中の位置から付ける（同じ舷に2つあれば外側・内側）。決めた名前は、モデル内パーツ・機関の欄・
//    独立操作のテレグラフ・機関音（36-horns.js）のどこでも同じになる。
//  ・種類：機関ごとに形式（35-audio-engine.js の ENGINE_TYPES：蒸気レシプロ・タービン・ディーゼル…）を選べる。
//    回転の上がり下がりの速さ・前後進を切り替えるまでの時間がその形式らしくなり、機関音もその機関の
//    回転数・形式で鳴る（機関音の欄で、その機関の音として結び付けたもの）。
//  ・推力：機関 i の回転数 r_i（前進全速＝1、後進全速＝−0.5）、推力の重み w_i ∝ 馬力^(2/3)。
//    S = Σ w_i r_i|r_i|、船の出す速さ ＝ 最高速力 × sign(S)√|S|（全部同じ回転なら今までと同じ）。
//    馬力の合計が見積もりより大きければ、加速も速い（物理の推力の強さに掛ける）。
const ENG_RPM_OF = { 3: 1, 2: 0.6, 1: 0.3, 0: 0, '-1': -0.15, '-2': -0.3, '-3': -0.5 };
const shipEngines = { split: false, conf: {} };     // conf[スクリューの id] = { astern, hp, name, type }
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
// 船の中の左右の位置（+x＝左舷）を、船の半幅に対する割合で。E.x には船の座標（機関音の位置と同じ）の x を入れる
function _engSide(s, E) {
    if (typeof shipGroup === 'undefined' || !shipGroup) return 0;
    let x = 0;
    if (s.part && typeof analyzeScrewDisc === 'function') {
        const d = analyzeScrewDisc(s.part);
        if (d) { const v = d.center.clone(); const par = s.part.object.parent || shipGroup; par.updateWorldMatrix(true, false); v.applyMatrix4(par.matrixWorld); shipGroup.worldToLocal(v); x = v.x; }
    } else if (s.mesh) x = s.mesh.position.x;
    if (E) E.x = x;
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
                if (!shipEngines.conf[s.id]) shipEngines.conf[s.id] = { astern: true, hp: 0, name: '', type: '' };
                E.conf = shipEngines.conf[s.id];
                E.side = _engSide(s, E);
                return E;
            });
            _engAutoNames(_eng.list);
            _engLayoutUI();
        } else {
            for (const E of _eng.list) { E.side = _engSide(E.screw, E); E.conf = shipEngines.conf[E.id] || E.conf; }
            _engAutoNames(_eng.list);
        }
    }
    return _eng.list;
}
window.engineList = engineList;
function engineById(id) { return engineList().find(E => E.id === id) || null; }
// スクリューの数・種類を変えた直後に一覧を見るとき（1秒待たずに作り直す）
function engineListRefresh() { _eng.checkT = -Infinity; return engineList(); }
window.engineListRefresh = engineListRefresh;
window.engineById = engineById;

// ── 名前（スクリューと機関で同じ） ──
// 位置から付ける名前のもと：左舷・右舷・中央。同じ舷に2つなら外側・内側、3つ以上なら外から1・2・3
function _engAutoNames(L) {
    if (L.length === 1) { L[0].autoBase = ''; return; }
    const groups = { 左舷: [], 右舷: [], 中央: [] };
    for (const E of L) groups[E.side > 0.15 ? '左舷' : E.side < -0.15 ? '右舷' : '中央'].push(E);
    for (const [w, G] of Object.entries(groups)) {
        G.sort((a, b) => Math.abs(b.side) - Math.abs(a.side));
        G.forEach((E, k) => {
            E.autoBase = G.length === 1 ? w : (G.length === 2 && w !== '中央') ? w + (k === 0 ? '外側' : '内側') : w + (k + 1);
        });
    }
}
function _engIsPod() { return typeof azipodActive === 'function' && azipodActive(); }   // アジポッドの船（58-maneuvering.js）
// スクリューの呼び方（スクリュー・外輪・ポッド）
function _engScrewWord(E) {
    if (_engIsPod()) return 'ポッド';
    const p = E.screw && E.screw.part;
    if (p) return p.key === 'paddle' ? '外輪' : 'スクリュー';
    const el = document.getElementById('prop-type');
    return el && el.value === 'paddlewheel' ? '外輪' : 'スクリュー';
}
// 機関の名前（名前を決めていれば、それをそのまま）
function engineName(E) {
    if (E.conf && E.conf.name) return E.conf.name;
    return (E.autoBase || '') + (_engIsPod() ? 'ポッド' : '機関');
}
// スクリューの名前（機関と同じ名前。決めていなければ「左舷スクリュー」など）
function engineScrewName(E) {
    if (E.conf && E.conf.name) return E.conf.name;
    return (E.autoBase || '') + _engScrewWord(E);
}
// モデルの部品・組み込みの推進器の id から、そのスクリューの名前（機関が無ければ null）
function engineScrewNameFor(id) { const E = engineList().find(q => q.id === id); return E ? engineScrewName(E) : null; }
window.engineName = engineName; window.engineScrewName = engineScrewName; window.engineScrewNameFor = engineScrewNameFor;

// ── 機関の形式ごとの応答（回転の上がり・下がり[全速の割合/秒]、前後進を切り替える前に止まっている時間[秒]） ──
//  蒸気レシプロ：ゆっくり上がり、逆転は弁装置を切り替えてすぐ。タービン：重い回転子でさらにゆっくり、
//  後進タービンへ蒸気を切り替えるのに時間がかかる。ディーゼル：速く上がり、逆転は止めてから圧縮空気で
//  逆に掛け直す。電気推進：モーターなので速く、逆転もすぐ。
const ENG_RESPONSE = {
    steam_recip:   { up: 0.08, down: 0.14, rev: 3.0 },
    combined:      { up: 0.07, down: 0.12, rev: 3.5 },
    steam_turbine: { up: 0.05, down: 0.08, rev: 6.0 },
    diesel_slow:   { up: 0.10, down: 0.18, rev: 4.0 },
    diesel_medium: { up: 0.16, down: 0.25, rev: 2.5 },
    diesel_high:   { up: 0.25, down: 0.35, rev: 2.0 },
    gas_turbine:   { up: 0.14, down: 0.20, rev: 2.5 },
    electric:      { up: 0.30, down: 0.40, rev: 0.5 },
};
function engineTypeOf(E) { const t = E && E.conf && E.conf.type; return (t && typeof ENGINE_TYPES !== 'undefined' && ENGINE_TYPES[t] && t !== 'none') ? t : ''; }
window.engineTypeOf = engineTypeOf;
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
    E.answerAt = wait ? 1.3 * (0.8 + Math.random() * 0.5) : -1;            // 応答までの物理の時間[秒]（engineUpdate で減らす）
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
    for (const E of L) {
        if (E.answerAt > 0) { E.answerAt -= dt; if (E.answerAt <= 0) { E.answerAt = -1; E.answer = E.order; if (typeof telegraphBell === 'function') telegraphBell(bridgeUI.telegraph, true); _engDrawAll(); } }
        // アジポッドのジョイスティック操船（58-maneuvering.js）では、回転数をそちらで決める
        const ov = (!designMode && typeof maneuverRpmTarget === 'function') ? maneuverRpmTarget(E) : null;
        let target = designMode ? 0 : (ov !== null ? ov : ENG_RPM_OF[_engTargetOrder(E)] || 0);
        if (E.conf && E.conf.astern === false && target < 0) target = 0;
        let r = E.rpm;
        const R = ENG_RESPONSE[engineTypeOf(E)];
        const up = R ? R.up : ENG_SPOOL_UP, down = R ? R.down : ENG_SPOOL_DOWN, rev = R ? R.rev : ENG_REVERSE_DELAY;
        const ap = (v, t, rate) => { const d = t - v, s = rate * dt; return Math.abs(d) <= s ? t : v + Math.sign(d) * s; };
        if (target * r < 0) { r = ap(r, 0, down); if (r === 0) E.hold = rev; }
        else if (E.hold > 0 && r === 0 && target !== 0) E.hold -= dt;
        else { E.hold = 0; r = ap(r, target, Math.abs(target) > Math.abs(r) ? up : down); }
        E.rpm = r;
    }
    const w = _engWeights();
    // アジポッドは推力のうち前向きの成分だけが前後の速さに効く（横の成分は 58-maneuvering.js の力）
    const pc = typeof maneuverPodCos === 'function' ? maneuverPodCos : null;
    let S = 0; L.forEach((E, i) => { S += w[i] * E.rpm * Math.abs(E.rpm) * (pc ? pc(E) : 1); });
    return Math.sign(S) * Math.sqrt(Math.abs(S));
}
window.engineUpdate = engineUpdate;
// 左右の位置を、左右で対になる機関どうしでそろえる。モデルのスクリューの位置が左右で少しずれていると
// （左舷 0.45・右舷 −0.41 など）、テレグラフも馬力も同じなのに推力の差ができて、舵を切らなくても回り続けていた。
// 真ん中（半幅の 15% 以内）は 0
function _engPairedSides(L) {
    const s = L.map(E => (Math.abs(E.side) < 0.15 ? 0 : E.side)), used = new Set();
    for (let i = 0; i < L.length; i++) {
        if (!s[i] || used.has(i)) continue;
        let best = -1, bd = Infinity;
        for (let j = 0; j < L.length; j++) {
            if (j === i || used.has(j) || !s[j] || Math.sign(s[j]) === Math.sign(s[i])) continue;
            const d = Math.abs(Math.abs(s[j]) - Math.abs(s[i]));
            if (d < bd) { bd = d; best = j; }
        }
        if (best >= 0 && bd < 0.4) {
            const a = (Math.abs(s[i]) + Math.abs(s[best])) / 2;
            s[i] = Math.sign(s[i]) * a; s[best] = Math.sign(s[best]) * a;
            used.add(i); used.add(best);
        }
    }
    return s;
}
// 左右の機関の推力の差で回る速さ[度/秒]（左舷の機関が前進 → 船首は右へ＝heading が減る）
function engineTwistDeg() {
    const L = engineList(); if (L.length < 2) return 0;
    if (typeof azipodActive === 'function' && azipodActive()) return 0;     // アジポッドは力で回す（58-maneuvering.js）
    const w = _engWeights(), sd = _engPairedSides(L);
    let m = 0; L.forEach((E, i) => { m += w[i] * E.rpm * Math.abs(E.rpm) * sd[i]; });
    // 左右がそろって同じ回転・同じ馬力なら、ちょうど 0（丸めの誤差で回り続けない）
    if (Math.abs(m) < 1e-4) return 0;
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
    // テレグラフの右上（汽笛のボタンと重ならないように）。メニューを開いたときにテレグラフと一緒に
    // 右へ動くよう、位置は CSS の変数で渡し、動かす分は CSS（body.menu-open）で足す
    U.btn.style.left = '';
    U.btn.style.setProperty('--eng-x', `${14 + Math.max(90, S - 84)}px`);
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
    U.canvases.forEach(cv => { cv._key = null; cv.width = Math.round(each * dpr); cv.height = Math.round(each * 1.18 * dpr); cv.style.width = each + 'px'; cv.style.height = Math.round(each * 1.18) + 'px'; cv._s = each; });
    _engDrawAll();
}
window.engineLayoutUI = _engLayoutUI;
// 指の位置 → 指令（ふつうのテレグラフ（37-bridge-controls.js）と同じ形ごとの決め方）
function _engPointerOrder(E, cv, e) {
    const r = cv.getBoundingClientRect(), S = cv._s || r.width, d = _engDesign();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    let v;
    if (d === 'fore' && typeof _tgForeGeom === 'function') { const g = _tgForeGeom(S); v = (g.yc - y) / g.step; }
    else if (d === 'modern') { const y0 = S * 0.05 + S * 0.03, bh = S * 0.9 / 8.6; v = 3 - (Math.floor((y - y0) / bh) - 1); }
    else if (typeof _tgFromAngleCont === 'function') {
        const piv = d === 'tilt' ? { x: S / 2, y: S * 0.86 } : { x: S / 2, y: S * 0.54 };
        v = _tgFromAngleCont(d, Math.atan2(x - piv.x, -(y - piv.y)));
    } else v = 0;
    v = Math.max(E.conf.astern === false ? 0 : -3, Math.min(3, Math.round(v)));
    return v;
}
function _engDesign() { const d = (window.bridgeUI && bridgeUI.telegraph) || 'olympic'; return d === 'buttons' ? 'olympic' : d; }
function _engSetupInput(cv, i) {
    const pick = (e) => { const E = engineList()[i]; if (!E) return; engineSetOrder(i, _engPointerOrder(E, cv, e)); };
    cv.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); try { cv.setPointerCapture(e.pointerId); } catch (er) { /* */ } cv._drag = true; pick(e); });
    cv.addEventListener('pointermove', (e) => { if (cv._drag) { e.preventDefault(); pick(e); } });
    const up = () => { cv._drag = false; };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
}
function _engDrawAll() {
    const U = _eng.ui; if (!U || !shipEngines.split) return;
    const L = engineList();
    const nk = Math.round(((typeof _tgNight === 'function') ? _tgNight() : 0) * 20);
    U.canvases.forEach((cv, i) => {
        const E = L[i]; if (!E) return;
        // 変わったときだけ描き直す（ハンドル・針が動いている間、回転数の表示が変わったとき）
        const key = [E.order, E.answer, Math.round(E.rpm * 100), E.conf.astern, nk, _engDesign(), cv._s, engineName(E)].join('|');
        const moving = (Number.isFinite(E.hv) && E.hv !== E.order) || (Number.isFinite(E.av) && E.av !== E.answer) || !Number.isFinite(E.hv);
        if (!moving && cv._key === key) return;
        cv._key = key;
        _engDraw(cv, E);
    });
}
function _engDraw(cv, E) {
    const s = cv._s || 100, dpr = cv.width / s;
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, s, s * 1.18);
    const d = _engDesign();
    // ハンドルは指令へなめらかに、針（機関室の応答）は応答へ
    E.hv = Number.isFinite(E.hv) ? E.hv + (E.order - E.hv) * 0.5 : E.order;
    E.av = Number.isFinite(E.av) ? E.av + (E.answer - E.av) * 0.35 : E.answer;
    if (Math.abs(E.order - E.hv) < 0.01) E.hv = E.order;
    if (Math.abs(E.answer - E.av) < 0.01) E.av = E.answer;
    if (typeof _drawTelegraph === 'function') {
        ctx.save();
        _drawTelegraph(ctx, s, d, E.hv, E.av, E.order, '', '');
        ctx.restore();
        if (E.conf.astern === false) _engCoverAstern(ctx, s, d);
    }
    // 名前・回転数・出力
    const hp = engineHp(E), out = hp * Math.pow(Math.abs(E.rpm), 3);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#e8f6ff'; ctx.font = `bold ${Math.max(8, s * 0.1)}px sans-serif`;
    ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 3;
    ctx.fillText(engineName(E), s / 2, s * 1.04);
    ctx.font = `${Math.max(7, s * 0.08)}px sans-serif`;
    ctx.fillText(`${Math.round(E.rpm * 100)}%・${Math.round(out).toLocaleString()}馬力`, s / 2, s * 1.13);
    ctx.shadowBlur = 0;
}
// 後進できない機関：後進の目盛りの上に「後進なし」の目隠し板（真鍮）をかぶせる
function _engCoverAstern(ctx, S, d) {
    const night = (typeof _tgNight === 'function') ? _tgNight() : 0;
    const plate = () => {
        const g = ctx.createLinearGradient(0, 0, S, S);
        g.addColorStop(0, night > 0.5 ? '#3a2e14' : '#d9b85f'); g.addColorStop(1, night > 0.5 ? '#21190a' : '#8a6420');
        return g;
    };
    const label = (x, y, rot) => {
        ctx.save(); ctx.translate(x, y); if (rot) ctx.rotate(rot);
        ctx.fillStyle = night > 0.5 ? '#e9c46a' : '#3a2608'; ctx.font = `bold ${Math.max(7, S * 0.075)}px sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('後進なし', 0, 0); ctx.restore();
    };
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = S * 0.02;
    if (d === 'fore' && typeof _tgForeGeom === 'function') {
        const g = _tgForeGeom(S), y0 = g.yOf(-0.5), y1 = g.yOf(-3.5);
        ctx.fillStyle = plate(); ctx.fillRect(S * 0.12, y0, S * 0.76, y1 - y0);
        ctx.shadowBlur = 0; label(S / 2, (y0 + y1) / 2);
    } else if (d === 'modern') {
        const y0 = S * 0.05 + S * 0.03, bh = S * 0.9 / 8.6;
        ctx.fillStyle = plate(); ctx.fillRect(S * 0.14, y0 + bh * 5, S * 0.72, bh * 3);
        ctx.shadowBlur = 0; label(S / 2, y0 + bh * 6.5);
    } else if (typeof _tgAngle === 'function') {
        // 文字盤の後進側の扇
        const piv = d === 'tilt' ? { x: S / 2, y: S * 0.86 } : { x: S / 2, y: S * 0.54 };
        const R = d === 'tilt' ? S * 0.8 : S * 0.44 * 0.84;
        const a0 = _tgAngle(d, -0.5), a1 = _tgAngle(d, -3.7);
        const t0 = Math.min(a0, a1) - Math.PI / 2, t1 = Math.max(a0, a1) - Math.PI / 2;
        ctx.fillStyle = plate();
        ctx.beginPath(); ctx.moveTo(piv.x, piv.y); ctx.arc(piv.x, piv.y, R, t0, t1); ctx.closePath(); ctx.fill();
        ctx.shadowBlur = 0;
        const am = (a0 + a1) / 2;
        label(piv.x + Math.sin(am) * R * 0.6, piv.y - Math.cos(am) * R * 0.6, am);
    }
    ctx.restore();
}
// 回転数の表示はときどき描き直す
setInterval(() => { if (shipEngines.split && _eng.ui && _eng.ui.box.style.display !== 'none') _engDrawAll(); }, 80);

// ════════════════════════════════════════════════════════════
//  船体設定「⚙ 推進器」の機関の欄
// ════════════════════════════════════════════════════════════
function renderEngineSettings() {
    const el = document.getElementById('engine-settings'); if (!el) return;
    const L = engineList();
    const est = engineEstimateHp();
    const any = L.some(E => E.conf.hp > 0);
    let tot = 0; for (const E of L) tot += engineHp(E);
    const inp = 'background:#0a1932;color:#00ffcc;border:1px solid #00ffcc55;border-radius:4px;padding:2px 4px;font-size:11px;';
    const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const typeOpts = (cur) => `<option value=""${!cur ? ' selected' : ''}>― 決めない ―</option>` + (typeof ENGINE_TYPES !== 'undefined'
        ? Object.entries(ENGINE_TYPES).filter(([k]) => k !== 'none').map(([k, T]) => `<option value="${k}"${k === cur ? ' selected' : ''}>${T.label}</option>`).join('') : '');
    el.innerHTML = `<div class="sp-section-title">🔥 機関（スクリューごと）</div>
        <div style="font-size:10px;color:#888;margin-bottom:6px;">スクリューごとに機関が 1 基あります。スクリューと機関は同じ名前で呼びます（名前が空なら、位置から「左舷」「右舷」「中央」など）。
            後進できない機関（タービン船の中央のスクリューなど）は、後進の指令では止まり、独立操作のテレグラフにも後進がありません。<br>
            「種類」を決めると、回転の上がり下がりの速さ・前後進を切り替える間合いがその機関らしくなり、機関音もその機関の回転で鳴ります（音タブの機関音が機関ごとに分かれます）。<br>
            馬力が空なら、排水量（${Math.round((physics.mass || 1.5) * 1000).toLocaleString()} トン）と最高速力（${physics.maxSpeed} ノット）から見積もった <b>${Math.round(est).toLocaleString()} 馬力</b>を等分します。</div>
        ${L.length ? L.map((E, i) => `<div class="sp-item-card" style="padding:6px 8px;">
            <div class="sp-row" style="gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:4px;">
                <b style="min-width:70px;color:#00ffcc;">${esc(engineName(E))}</b>
                <span style="font-size:10px;color:#8ab;">${E.screw.part ? (E.screw.part.key === 'paddle' ? '🛞 ' : '🌀 ') : ''}${esc(engineScrewName(E))}${E.screw.part ? `（モデル：${esc(E.screw.label)}）` : ''}</span>
            </div>
            <div class="sp-row" style="gap:6px;flex-wrap:wrap;align-items:center;">
                <span class="sp-label" style="min-width:0;">名前:</span><input type="text" placeholder="${esc(E.autoBase || '（1基だけ）')}" value="${esc(E.conf.name || '')}" maxlength="16" style="width:90px;${inp}" onchange="engineSetConf(${i}, 'name', this.value)">
                <span class="sp-label" style="min-width:0;">種類:</span><select style="max-width:100%;${inp}" onchange="engineSetConf(${i}, 'type', this.value)">${typeOpts(engineTypeOf(E))}</select>
            </div>
            <div class="sp-row" style="gap:6px;flex-wrap:wrap;align-items:center;">
                <label class="sp-toggle"><input type="checkbox" ${E.conf.astern !== false ? 'checked' : ''} onchange="engineSetConf(${i}, 'astern', this.checked)"> 後進できる</label>
                <span class="sp-label" style="min-width:0;">馬力:</span><input type="number" min="0" step="100" class="sp-num-input" style="width:84px" placeholder="${Math.round(est / L.length)}" value="${E.conf.hp > 0 ? E.conf.hp : ''}" onchange="engineSetConf(${i}, 'hp', this.value)">
            </div></div>`).join('') : '<div style="font-size:11px;color:#888;">スクリューがありません</div>'}
        <div style="font-size:10px;color:#9cd;margin-top:4px;">合計 ${Math.round(tot).toLocaleString()} 馬力${any ? `（この馬力での最高速力の目安 ${engineTopSpeedForHp(tot).toFixed(1)} ノット・加速 ×${enginePowerFactor().toFixed(2)}）` : ''}</div>`;
}
window.renderEngineSettings = renderEngineSettings;
// 名前・種類を変えたら、同じ名前を出している所（モデル内パーツ・推進器リスト・機関音・アジポッド）も描き直す
function _engRefreshViews() {
    renderEngineSettings(); _engLayoutUI();
    if (typeof renderGlbPartsList === 'function') renderGlbPartsList();
    if (typeof renderPropList === 'function' && document.getElementById('prop-list')) renderPropList();
    if (typeof renderSoundPanel === 'function') renderSoundPanel();
    if (typeof renderManeuverSettings === 'function') renderManeuverSettings();
}
function engineSetConf(i, k, v) {
    const E = engineList()[i]; if (!E) return;
    _engSetConf(E, k, v);
}
function _engSetConf(E, k, v) {
    if (k === 'hp') { const n = parseFloat(v); E.conf.hp = Number.isFinite(n) && n > 0 ? n : 0; renderEngineSettings(); _engLayoutUI(); return; }
    if (k === 'astern') { E.conf.astern = !!v; if (!v && E.order < 0) { E.order = E.answer = 0; } renderEngineSettings(); _engLayoutUI(); return; }
    if (k === 'name') E.conf.name = String(v || '').trim().slice(0, 16);
    else if (k === 'type') { E.conf.type = (typeof ENGINE_TYPES !== 'undefined' && ENGINE_TYPES[v] && v !== 'none') ? v : ''; engineSoundSync(E); }
    else E.conf[k] = v;
    _engRefreshViews();
}
// id で（モデル内パーツ・機関音の欄から）
function engineSetConfById(id, k, v) { const E = engineById(id); if (E) _engSetConf(E, k, v); }
window.engineSetConf = engineSetConf; window.engineSetConfById = engineSetConfById;

// ── 機関音との結び付け（36-horns.js の shipSound.engines[].eng ＝ 機関の id） ──
// 機関の種類を決めたとき、その機関の音が無ければ、今の機関音を機関ごとの音に分ける
// （場所の高さ・前後・音量・形式は、今の機関音のうち左右の位置がいちばん近いものから引き継ぐ。
//   左右の位置はその機関のスクリューの位置）。結び付いた音の形式は、機関の種類に合わせる。
function engineSoundSync(E) {
    const S = (typeof shipSound !== 'undefined') ? shipSound : null;
    if (!S || !Array.isArray(S.engines)) return;
    const L = engineList();
    const ids = new Set(L.map(q => q.id));
    const linked = S.engines.filter(e => e.eng && ids.has(e.eng));
    if (!linked.some(e => e.eng === E.id)) {
        const loose = S.engines.filter(e => !(e.eng && ids.has(e.eng)));
        const keepLinked = S.engines.filter(e => e.eng && ids.has(e.eng));
        // まだ音の無い機関ぶんを作る（既に結び付いている機関はそのまま）
        const need = L.filter(q => !keepLinked.some(e => e.eng === q.id));
        const near = (q) => {
            let best = null, bd = Infinity;
            for (const e of loose) {
                const d = Math.min(Math.abs((q.x || 0) - (e.x || 0)), e.sym ? Math.abs((q.x || 0) + (e.x || 0)) : Infinity);
                if (d < bd) { bd = d; best = e; }
            }
            return best;
        };
        const share = new Map();
        need.forEach(q => { const b = near(q); if (b) share.set(b, (share.get(b) || 0) + 1); });
        const made = need.map(q => {
            const b = near(q);
            const n = b ? share.get(b) : 1;
            const type = engineTypeOf(q) || (b && b.type) || 'steam_recip';
            return { name: '', type, volume: +(((b && Number.isFinite(b.volume)) ? b.volume : 1) / Math.sqrt(n)).toFixed(2),
                     x: +(q.x || 0).toFixed(3), y: b ? b.y || 0 : 0, z: b ? b.z || 0 : 0, sym: false, eng: q.id };
        });
        // どの機関にも選ばれなかった音（補機など）は、そのまま残す
        const used = new Set(share.keys());
        S.engines = keepLinked.concat(made, loose.filter(e => !used.has(e)));
        if (typeof window._soundMarkersDirtySet === 'function') window._soundMarkersDirtySet();
    }
    const t = engineTypeOf(E);
    if (t) for (const e of S.engines) if (e.eng === E.id) e.type = t;
}
window.engineSoundSync = engineSoundSync;

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
