// ════════════════════════════════════════════════════════════════
//  タグを使った自動の離岸・着岸
// ════════════════════════════════════════════════════════════════
//  着岸（自動航行で港に着いたとき、またはタグのパネルの「自動着岸」）
//    1. 泊地の、岸壁から船幅の3倍ほど沖に、岸壁の方を向いて止まる（自動航行が連れて来る）
//    2. タグ2隻を、着岸したとき沖側になる舷の、船首と船尾に呼ぶ
//    3. その場で 90° 回して、岸壁と平行にする
//    4. 横へゆっくり押して岸壁に付ける（近づくほど遅く。最後は 0.1m/s ほど）
//    5. もやい綱を取り、タグを帰す
//  離岸（タグのパネルの「自動離岸」、または岸壁から自動航行を始めたとき）
//    1. タグ2隻を沖側の舷の船首・船尾に呼ぶ（もやい綱を放す）
//    2. 横へ引いて岸壁から離す → 港口の方へ回す → タグを帰す → 自動航行へ
//  船の動かし方：目標の位置・向きとのずれから「ほしい横の速さ・回る速さ」を決め、
//  そのための横の力と回す力を、船首・船尾のタグの 押す／引く と強さに分ける。
//  前後のずれは機関（微速の前進・後進を少しずつ）で直す。舵は中央。
//  座標：物理の面（+x が西）。船の中の +x は左舷。港の形 S（44-world-terrain.js の _portShape）の
//  a は岸壁から沖へ、b は岸壁に沿って。岸壁の面は a≒6m（岸壁の当たり判定の外側）。

const harborAuto = { mode: null, phase: '', msg: '', plan: null, then: null, t: 0, phaseT: 0, lastOrderT: -99, bow: null, stern: null, lines: [] };
window.harborAuto = harborAuto;
const _haRad = Math.PI / 180;

function _haDims() {
    const hp = window.hullProfile;
    const sc = physics.scale || 1;
    const HL = ((hp && hp.ready) ? hp.halfLen : 6) * sc;
    let hw = 0;
    for (let k = -10; k <= 10; k++) hw = Math.max(hw, worldHullAt(k / 10 * HL / sc).hw);
    return { HL, hw, B: hw * 2, L: HL * 2 };
}
function _haWrap(d) { return ((d + 540) % 360) - 180; }
function _haQ(S) {
    return {
        toW: (a, b) => ({ x: S.x + S.sx * a + S.sz * b, z: S.z + S.sz * a - S.sx * b }),
        toQ: (x, z) => { const dx = x - S.x, dz = z - S.z; return { a: dx * S.sx + dz * S.sz, b: dx * S.sz - dz * S.sx }; },
    };
}
// 着岸の計画：どの港のどこに、どちら向きで付けるか
function harborBerthPlan(port, prefHeading) {
    if (!port) return { ok: false, why: '港がありません' };
    if (port.type === 'fishing' || port.type === 'naval') return { ok: false, why: `${port.name}には大きな船が横付けできる岸壁がありません` };
    const S = _portShape(port), Q = _haQ(S), D = _haDims();
    if (S.quayLen < D.L + 20) return { ok: false, why: `${port.name}の岸壁（${Math.round(S.quayLen)}m）は船（${Math.round(D.L)}m）より短いので付けられません` };
    const T = PORT_TYPES[port.type];
    const draft = worldShipDraft();
    if (draft + 1 > T.depth + 2) return { ok: false, why: `${port.name}の岸壁は船に対して浅いので付けられません` };
    const aB = 6 + D.hw + 1.5;
    const aE = Math.min(S.basin * 0.8 - D.HL * 0.3, aB + 3 * D.B + 60);
    if (aE - D.HL < aB - D.hw) return { ok: false, why: `${port.name}の泊地は船を回すには狭すぎます` };
    // 岸壁と平行な 2 つの向きのうち、今の向きに近い方
    const h1 = Math.atan2(S.sz, -S.sx) / _haRad, h2 = h1 + 180;
    const cur = prefHeading !== undefined ? prefHeading : physics.heading;
    const useH1 = Math.abs(_haWrap(h1 - cur)) <= Math.abs(_haWrap(h2 - cur));
    const hB = useH1 ? h1 : h2;
    const open = useH1 ? -1 : 1;              // 沖側の舷（船の中の +x ＝ 左舷 なら +1）。h1 では左舷が岸壁側
    const pB = Q.toW(aB, 0), pE = Q.toW(aE, 0);
    return {
        ok: true, port, S, aB, aE, open,
        berth: { x: pB.x, z: pB.z, h: hB },
        turn: { x: pE.x, z: pE.z },
        hIn: Math.atan2(-S.sx, -S.sz) / _haRad,     // 岸壁の方を向く
        hOut: Math.atan2(S.sx, S.sz) / _haRad,      // 港口の方を向く
    };
}
window.harborBerthPlan = harborBerthPlan;

// 今、岸壁に横付けしているか（離岸できるか）
function harborBerthedAt() {
    if (!window.world || world.mode !== 'world') return null;
    const ll = worldShipLatLon(), np = worldNearestPort(ll.lat, ll.lon);
    if (!np || np.dist > 4000) return null;
    const plan = harborBerthPlan(np.port);
    if (!plan.ok) return null;
    const Q = _haQ(plan.S), q = Q.toQ(physics.cgWorldX, physics.cgWorldZ), D = _haDims();
    const parallel = Math.min(Math.abs(_haWrap(physics.heading - plan.berth.h)), Math.abs(_haWrap(physics.heading - plan.berth.h - 180)));
    if (q.a < plan.aB + 25 && q.a > 0 && Math.abs(q.b) < plan.S.quayLen / 2 + 20 && parallel < 25) {
        // 今の向きで計画し直す
        return harborBerthPlan(np.port, physics.heading);
    }
    return null;
}
window.harborBerthedAt = harborBerthedAt;

// ── タグの持ち場：沖側の舷の、いちばん前・いちばん後ろ ──
function _haStations(open) {
    const st = tugStations().filter(s => s.side === open);
    const hp = window.hullProfile, hl = (hp && hp.ready) ? hp.halfLen : 6;
    const fwd = st.filter(s => s.z > 0.3 * hl).sort((a, b) => b.z - a.z)[0];
    const aft = st.filter(s => s.z < -0.3 * hl).sort((a, b) => a.z - b.z)[0];
    return { bow: fwd || st.find(s => s.key === `d0.75:${open}`), stern: aft || st.find(s => s.key === `d-0.75:${open}`) };
}

// ── 始める・やめる ──
function _haMsg(s) { harborAuto.msg = s; if (typeof renderTugPanel === 'function') renderTugPanel(); if (typeof renderAutopilotPanel === 'function') renderAutopilotPanel(); }
function harborAutoStart(mode, plan, then) {
    if (!plan || !plan.ok) { _haMsg(plan ? plan.why : '港の近くではありません'); return false; }
    if (typeof autopilot !== 'undefined' && autopilot.active) autopilotStop('', true);
    Object.assign(harborAuto, { mode, plan, then: then || null, phase: 'tugs', t: 0, phaseT: 0, lastOrderT: -99, bow: null, stern: null });
    _haClearLines();
    // タグを呼ぶ（もう付いているタグは帰して、呼び直す）
    if (typeof tugReleaseAll === 'function') tugReleaseAll();
    const S = _haStations(plan.open);
    const b = tugCall(S.bow && S.bow.key), s = tugCall(S.stern && S.stern.key);
    harborAuto.bow = b ? b.id : null; harborAuto.stern = s ? s.id : null;
    for (const t of [b, s]) if (t) { t.action = 'standby'; t.autoPower = 0; t.dir = 'side'; }
    _haMsg(mode === 'berth' ? `${plan.port.name}：タグを待っています（着岸）` : `${plan.port.name}：タグを待っています（離岸）`);
    return true;
}
function harborAutoStop(msg) {
    harborAuto.mode = null; harborAuto.phase = '';
    for (const t of (window.tugs || [])) delete t.autoPower;
    if (typeof _apOrder === 'function') _apOrder(0);
    _haMsg(msg || '');
}
function harborAutoBerthNow() {
    const ll = worldShipLatLon(), np = worldNearestPort(ll.lat, ll.lon);
    if (!np || np.dist > 6000) { _haMsg('港の近くではありません'); return; }
    harborAutoStart('berth', harborBerthPlan(np.port));
}
function harborAutoDepartNow(then) {
    const plan = harborBerthedAt();
    if (!plan) { _haMsg('岸壁に横付けしていません'); return false; }
    return harborAutoStart('depart', plan, then);
}
Object.assign(window, { harborAutoStart, harborAutoStop, harborAutoBerthNow, harborAutoDepartNow });

// ── 目標の位置・向きへ動かす ──
function _haTug(id) { return (window.tugs || []).find(t => t.id === id && t.state !== 'leaving'); }
function _haControl(target, dt, opt) {
    const hp = window.hullProfile, D = _haDims();
    const h = physics.heading * _haRad, fx = Math.sin(h), fz = Math.cos(h), sx = Math.cos(h), sz = -Math.sin(h);
    const ex = target.x - physics.cgWorldX, ez = target.z - physics.cgWorldZ;
    const eA = ex * fx + ez * fz, eS = ex * sx + ez * sz;
    const eY = target.h !== undefined ? _haWrap(target.h - physics.heading) : 0;
    const massKg = Math.max(1e5, (physics.mass || 1) * 1e6);
    // 前後：機関を少しずつ（ベルが鳴りすぎないよう 6 秒に一度まで）
    const vA = physics.speed || 0;
    const vAd = Math.abs(eA) < 3 ? 0 : Math.max(-(opt.vA || 0.5), Math.min(opt.vA || 0.5, 0.02 * eA));
    harborAuto.t += dt;
    if (harborAuto.t - harborAuto.lastOrderT > 6) {
        let o = 0;
        if (vA < vAd - 0.2) o = 1; else if (vA > vAd + 0.2) o = -1;
        if (typeof _apOrder === 'function' && autopilot.lastOrder !== o) { _apOrder(o); harborAuto.lastOrderT = harborAuto.t; }
    }
    if (typeof _apHelm === 'function') _apHelm(0, dt);
    // 横と回頭：タグで
    const vS = _tugShip.vSway, r = _tugShip.yawRate + (physics.turnRate || 0) * _haRad;
    const vSmax = Math.abs(eS) < 8 ? 0.12 : (opt.vS || 0.35);
    const vSd = Math.abs(eS) < 0.3 ? 0 : Math.max(-vSmax, Math.min(vSmax, 0.03 * eS));
    const rMax = opt.r || 0.005;
    const rd = Math.max(-rMax, Math.min(rMax, 0.04 * eY * _haRad));
    const Fs = massKg * 1.8 * 0.3 * (vSd - vS);
    const Mz = massKg * 1.5 * D.L * D.L / 12 * 0.3 * (rd - r);
    const tb = _haTug(harborAuto.bow), ts = _haTug(harborAuto.stern);
    const st = tugStations();
    const sc = physics.scale || 1;
    const lever = (t) => { const s = t && st.find(q => q.key === t.station); return s ? s.z * sc : 0; };
    const ab = tb ? lever(tb) : D.HL * 0.75, as = ts ? lever(ts) : -D.HL * 0.75;
    let Fb = (Mz - Fs * as) / Math.max(1, ab - as), Fst = Fs - Fb;
    if (!tb) { Fb = 0; Fst = Fs; }
    if (!ts) { Fst = 0; Fb = tb ? Fs : 0; }
    const Fmax = _tugPullN();
    const big = Math.max(Math.abs(Fb), Math.abs(Fst));
    if (big > Fmax) { Fb *= Fmax / big; Fst *= Fmax / big; }
    const open = harborAuto.plan.open;
    for (const [t, f] of [[tb, Fb], [ts, Fst]]) {
        if (!t) continue;
        t.dir = 'side';
        const p = Math.min(1, Math.abs(f) / Fmax);
        const wantAct = p < 0.03 ? t.action : (Math.sign(f) === open ? 'pull' : 'push');
        if (t.action === 'standby') t.action = wantAct === 'standby' ? 'push' : wantAct;
        if (wantAct !== t.action) {
            // 押す⇄引く は付き直すので、少し待ってから（その間は力を出さない）
            t.autoPower = 0;
            t.switchT = (t.switchT || 0) + dt;
            if (t.switchT > 4) { t.action = wantAct; t.switchT = 0; }
        } else { t.switchT = 0; t.autoPower = p; }
    }
    return { eA, eS, eY, vS, r, dist: Math.hypot(ex, ez) };
}

// ── もやい綱（着岸したら、沖側でない舷の金物から岸壁のボラードへ）──
function _haClearLines() { for (const l of harborAuto.lines) { scene.remove(l); l.geometry.dispose(); } harborAuto.lines = []; }
function _haMakeLines(plan) {
    _haClearLines();
    if (typeof mooringPoints !== 'function') return;
    const S = plan.S, Q = _haQ(S), half = S.quayLen / 2;
    const mat = new THREE.LineBasicMaterial({ color: 0xd8c9a0 });
    const pts = mooringPoints().filter(m => m.side === -plan.open);
    for (const m of pts) {
        const q = Q.toQ(m.world.x, m.world.z);
        const lead = m.local.z > 0 ? 1 : -1;
        // 船首側は前へ、船尾側は後ろへ（ヘッドライン・スターンライン）
        const hB = plan.berth.h * _haRad, dirB = Math.sign((Math.sin(hB) * S.sz - Math.cos(hB) * S.sx)) || 1;   // 船首が b の＋向きか
        let bb = q.b + lead * dirB * 20;
        bb = Math.round((bb + half - 12) / 25) * 25 - half + 12;
        bb = Math.max(-half + 12, Math.min(half - 12, bb));
        const w = Q.toW(4.5, bb);
        const g = new THREE.BufferGeometry().setFromPoints([m.world.clone(), new THREE.Vector3(w.x, 3.7, w.z)]);
        const l = new THREE.Line(g, mat); l.frustumCulled = false;
        scene.add(l); harborAuto.lines.push(l);
    }
    harborAuto.linePose = { x: physics.cgWorldX, z: physics.cgWorldZ };
}

// ── 毎フレーム ──
function updateHarborAuto(t, dt) {
    // 綱を取っている間に船が動いたら綱を外す
    if (harborAuto.lines.length && harborAuto.linePose && Math.hypot(physics.cgWorldX - harborAuto.linePose.x, physics.cgWorldZ - harborAuto.linePose.z) > 4) _haClearLines();
    if (!harborAuto.mode) return;
    dt = Math.min(2, Math.max(0, dt || 0));
    if (!window.world || world.mode !== 'world') { harborAutoStop('世界を航海するモードではないので止めました'); return; }
    if ((typeof keys !== 'undefined' && (keys.a || keys.d)) || (typeof _br !== 'undefined' && _br.wheelDrag)) { harborAutoStop('手で舵を取ったので、自動の離着岸を止めました'); return; }
    const P = harborAuto.plan;
    harborAuto.phaseT += dt;
    const next = (ph, msg) => { harborAuto.phase = ph; harborAuto.phaseT = 0; _haMsg(msg); };
    const tb = _haTug(harborAuto.bow), ts = _haTug(harborAuto.stern);
    if (!tb && !ts) { harborAutoStop('タグがいなくなったので止めました'); return; }
    const ready = (!tb || tb.state === 'on') && (!ts || ts.state === 'on');
    if (harborAuto.mode === 'berth') {
        if (harborAuto.phase === 'tugs') {
            _haControl({ x: P.turn.x, z: P.turn.z, h: physics.heading }, dt, { vA: 0.4 });
            for (const q of [tb, ts]) if (q) q.autoPower = 0;
            if (ready) next('turn', `${P.port.name}：タグで岸壁と平行に回しています`);
            else if (harborAuto.phaseT > 900) harborAutoStop('タグが持ち場に着けないので止めました');
        } else if (harborAuto.phase === 'turn') {
            const e = _haControl({ x: P.turn.x, z: P.turn.z, h: P.berth.h }, dt, { vA: 0.3, r: 0.006 });
            if (Math.abs(e.eY) < 2.5 && Math.abs(e.r) < 0.002) next('side', `${P.port.name}：タグで岸壁へ寄せています`);
        } else if (harborAuto.phase === 'side') {
            const e = _haControl(P.berth, dt, { vA: 0.3, vS: 0.35, r: 0.003 });
            harborAuto.remain = Math.abs(e.eS);
            if (Math.abs(e.eS) < 0.8 && Math.abs(e.eA) < 6 && Math.abs(e.eY) < 1.5 && Math.abs(e.vS) < 0.06 && Math.abs(physics.speed || 0) < 0.15) {
                _tugShip.vSway = 0; _tugShip.yawRate = 0; physics.speed = 0; physics.turnRate = 0;
                _apOrder(0);
                _haMakeLines(P);
                tugReleaseAll();
                harborAuto.mode = null; harborAuto.phase = '';
                for (const q of (window.tugs || [])) delete q.autoPower;
                _haMsg(`${P.port.name}に着岸しました。もやい綱を取り、タグを帰します`);
            }
        }
    } else if (harborAuto.mode === 'depart') {
        const Q = _haQ(P.S);
        const q = Q.toQ(physics.cgWorldX, physics.cgWorldZ);
        const off = Q.toW(P.aE, q.b * 0.5);
        if (harborAuto.phase === 'tugs') {
            _haControl({ x: physics.cgWorldX, z: physics.cgWorldZ, h: physics.heading }, dt, { vA: 0.2 });
            for (const x of [tb, ts]) if (x) x.autoPower = 0;
            if (ready) next('off', `${P.port.name}：タグで岸壁から離しています`);
            else if (harborAuto.phaseT > 900) harborAutoStop('タグが持ち場に着けないので止めました');
        } else if (harborAuto.phase === 'off') {
            const e = _haControl({ x: off.x, z: off.z, h: physics.heading }, dt, { vA: 0.2, vS: 0.35, r: 0.002 });
            if (q.a > P.aE - 15) next('turn', `${P.port.name}：港口の方へ回しています`);
        } else if (harborAuto.phase === 'turn') {
            const e = _haControl({ x: off.x, z: off.z, h: P.hOut }, dt, { vA: 0.3, r: 0.006 });
            if (Math.abs(e.eY) < 4 && Math.abs(e.r) < 0.003) {
                tugReleaseAll();
                const then = harborAuto.then;
                harborAuto.mode = null; harborAuto.phase = '';
                for (const x of (window.tugs || [])) delete x.autoPower;
                _haMsg(`${P.port.name}を離岸しました。タグを帰します`);
                if (then && typeof autopilotStart === 'function') autopilotStart(then);
            }
        }
    }
}
window.updateHarborAuto = updateHarborAuto;
