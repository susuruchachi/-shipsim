// ============================================================
//  操船：サイドスラスター（船首・船尾の横向きのスクリュー）とアジポッド
// ============================================================
//  ・サイドスラスター：船体設定「⚙ 推進器」で、前後の位置と出力[kW]を決めて何基でも付けられる。
//    船体を横に貫くトンネルの中のスクリューで、船首（船尾）を横へ押す。速さが出ると効かなくなる
//   （6 ノットでほぼ 0）。推力 ≒ 120 N/kW。画面の「操船」ボタンのパネル、またはキー（, . ＝船首、K L ＝船尾）で動かす。
//  ・アジポッド：推進器の種類を「アジポッド」にする（またはモデルに "Azipod" という名前の部品がある）と、
//    スクリューごとの機関（56-engines.js）がポッドになり、360° 向きを変えられる。
//      舵輪に連動　：ポッドの向き＝舵角（今までどおりの操船。遅いときは横向きの推力でも回る）
//      個別　　　　：ポッドごとに向きを決め、推力は機関ごとのテレグラフで（舵は効かない）
//      ジョイスティック：船を動かしたい向き（前後・左右）と回したい向きを指で示すと、
//                    ポッドの向き・推力とスラスターを自動で割り振る。方位保持・位置保持（DP）も
//    ポッドは決まった速さ（既定 8°/秒）でしか向きを変えないので、回っている間は推力が斜めにかかる。
//  ・力は 47-tugboats.js の横流れ・回頭の計算（_tugStep）へ shipExtraForces として足す。
//    前後の力はポッドの推力の前向きの成分として、機関の回転数（56-engines.js）から速さの目標に入る。
const MNV_N_PER_KW = 120;          // サイドスラスターの推力 [N/kW]
const POD_N_PER_HP = 80;           // ポッドの推力 [N/馬力]（船のプロペラのボラードプル程度）
const MNV_KEYS = { ',': ['bow', 1], '.': ['bow', -1], 'k': ['stern', 1], 'l': ['stern', -1] };
const maneuver = {
    thrusters: [],                 // { name, at（−1 船尾〜＋1 船首）, kW, y（高さ。null＝自動）, part（モデルの部品の名前。null＝付け足したもの） }
    podMode: 'helm',               // 'helm' | 'indep' | 'joy'
    podRate: 8,                    // ポッドが向きを変える速さ [°/秒]
    joy: { x: 0, y: 0, r: 0, latch: false, holdHdg: false, holdPos: false },
};
window.maneuver = maneuver;
const _mnv = {
    th: [],                        // サイドスラスターの今の状態 { set（パネルの指示）, out（実際の出力 −1〜1） }
    pods: new Map(),               // 機関の id → { az（今の向き[°]・＋＝左舷へ押す）, cmd（指示の向き）, rpmT（ジョイスティックの回転数の指示 or null） }
    keys: {},                      // 押しているキー
    vis: null, visKey: '', puffAcc: [],
    autoVis: null,                 // 自動航行がスラスターで動かしている間の見た目（49-autopilot.js）
    hold: { hdg: null, x: null, z: null },
    activeT: -1e9,
    ui: null, uiKey: '', drawT: 0, statT: 0,
};

// ── 便利 ──
const _mnvRad = Math.PI / 180;
const _mnvWrap = (a) => ((a % 360) + 540) % 360 - 180;
function _mnvHL() { const hp = window.hullProfile; return ((hp && hp.ready) ? hp.halfLen : 6) * (physics.scale || 1); }
function _mnvMassKg() { return Math.max(1e5, (physics.mass || 1) * 1e6); }
// 速さが出ると、スラスター（と遅いときのポッドの横向きの力）は効かなくなる
function thrusterSpeedFactor() { return Math.max(0, 1 - Math.abs(physics.speed || 0) / 6); }
function thrusterCapN(T) { return T._on === false ? 0 : Math.max(0, +T.kW || 0) * MNV_N_PER_KW; }
// ── モデルの部品のスラスター（07-glb-movable-parts.js：名前に "Thruster" / "スラスター" を含む部品、
//    または部品の種類を「バウスラスター」にしたもの）──
function _mnvThrusterParts() {
    return (typeof glbMovableParts !== 'undefined' && glbMovableParts) ? glbMovableParts.filter(p => p.key === 'thruster' && !p.disabled && p.object) : [];
}
function _mnvPartOf(T) { return T.part ? _mnvThrusterParts().find(p => p.name === T.part) || null : null; }
// 部品の真ん中（船のローカル座標）
function _mnvPartCenter(part) {
    const v = new THREE.Vector3();
    part.object.updateWorldMatrix(true, true);
    new THREE.Box3().setFromObject(part.object).getCenter(v);
    shipGroup.updateMatrixWorld(true);
    return _mnvFromShip(shipGroup.worldToLocal(v));      // 船体の向きの面で
}
function _mnvPartRadius(part) {
    const b = new THREE.Box3().setFromObject(part.object), sz = new THREE.Vector3(); b.getSize(sz);
    const sc = new THREE.Vector3(); shipGroup.getWorldScale(sc);
    const r = Math.max(sz.y, Math.min(sz.x, sz.z)) / 2 / (sc.x || 1);
    return Number.isFinite(r) && r > 0 ? r : null;
}
function _mnvBowSign() { const hp = window.hullProfile; return (hp && hp.ready && hp.bowSign) || 1; }
// 船体の向きの面：船の中（shipGroup）で、船の長さの向きが z になるように回した面。
// モデルの向きの補正（modelOffset.ry・X が前のモデル。18-hull-wake-physics.js の _wakeAxisRad と同じ）の分だけ回す
function _mnvFrameA() {
    const hp = window.hullProfile;
    const ry = (typeof modelOffset !== 'undefined' && modelOffset && typeof modelOffset.ry === 'number') ? modelOffset.ry * _mnvRad : 0;
    return ry + (hp && hp.xIsForward ? Math.PI / 2 : 0);
}
// 船体の向きの面（x＝横・左舷が＋、y、z＝長さ）→ 船の中（shipGroup）の座標
function _mnvToShip(x, y, z, out) {
    const a = _mnvFrameA(), c = Math.cos(a), s = Math.sin(a);
    return (out || new THREE.Vector3()).set(x * c + z * s, y, -x * s + z * c);
}
function _mnvFromShip(v) {
    const a = _mnvFrameA(), c = Math.cos(a), s = Math.sin(a);
    return { x: v.x * c - v.z * s, y: v.y, z: v.x * s + v.z * c };
}
// 部品のスラスターを一覧（maneuver.thrusters）に足す・使えなくなった部品のものは休ませる（_on＝false）
function _mnvSyncParts() {
    const parts = _mnvThrusterParts();
    const hp = window.hullProfile, half = (hp && hp.ready) ? hp.halfLen : 6;
    let added = false;
    for (const part of parts) {
        if (maneuver.thrusters.some(T => T.part === part.name)) continue;
        let at = 0.86;
        try { at = Math.max(-1, Math.min(1, _mnvPartCenter(part).z / half * _mnvBowSign())); } catch (e) { /* */ }
        maneuver.thrusters.push({ name: '', at, kW: thrusterDefaultKw(), y: null, part: part.name });
        added = true;
    }
    let changed = added;
    for (const T of maneuver.thrusters) {
        const part = T.part ? _mnvPartOf(T) : null;
        const on = !T.part || !!part;
        if (T._on !== on) { T._on = on; changed = true; }
        // 部品のスラスターの前後の位置は、部品の今の位置から（モデルの置き直し・縮尺の変更にも付いていく）
        if (part && hp && hp.ready) {
            try {
                const at = +Math.max(-1, Math.min(1, _mnvPartCenter(part).z / half * _mnvBowSign())).toFixed(3);
                if (Math.abs(at - (T.at || 0)) > 0.002) { T.at = at; _mnv.visKey = ''; }
            } catch (e) { /* */ }
        }
    }
    if (changed) { _mnv.visKey = ''; _mnvUpdateHudButton(); renderManeuverPanel(); const el = document.getElementById('mnv-settings'); if (el && el.offsetParent) renderManeuverSettings(); }
    return changed;
}
window.maneuverSyncParts = _mnvSyncParts;
// モデルのスラスターの部品の回す速さ[rad/s]（12-bloom-...js の animatePropellers から）
function maneuverThrusterSpin(part) {
    const i = maneuver.thrusters.findIndex(T => T.part === part.name);
    const st = i >= 0 ? _mnv.th[i] : null;
    return st ? st.out * 14 : 0;
}
window.maneuverThrusterSpin = maneuverThrusterSpin;
// 既定の出力：全長から（0.04×L²）。ただし主機の 2 割まで（軽い船に大きすぎないように）
function thrusterDefaultKw() {
    const L = _mnvHL() * 2;
    const main = (typeof engineEstimateHp === 'function') ? engineEstimateHp() / 1.341 : 1e9;
    return Math.round(Math.max(30, Math.min(5000, 0.04 * L * L, 0.2 * main)) / 10) * 10;
}
function _mnvThState(i) { while (_mnv.th.length <= i) _mnv.th.push({ set: 0, out: 0, auto: 0 }); return _mnv.th[i]; }

// ── アジポッドか ──
function azipodActive() {
    const el = document.getElementById('prop-type');
    if (el && el.value === 'azipod') return true;
    return typeof glbMovableParts !== 'undefined' && glbMovableParts.some(p => p.key === 'azipod' && !p.disabled && p.object);
}
window.azipodActive = azipodActive;
// 実際に使う操船の方法（自動航行・自動の離着岸の間は舵輪に連動）
//  'lever'：「舵輪に連動」で、船橋の舵輪を「アジポッド用の旋回レバー」にしているとき。
//           レバーの向き＝ポッドの向き（360°）、推力＝テレグラフ（機関の回転数）。舵は使わない
function podModeNow() {
    if (!azipodActive()) return null;
    const auto = (window.autopilot && (autopilot.active || autopilot.chase)) || (window.harborAuto && harborAuto.mode);
    if (auto) return 'helm';
    if (maneuver.podMode === 'helm' && typeof bridgeAzimuthLever === 'function' && bridgeAzimuthLever() !== null) return 'lever';
    return maneuver.podMode;
}
window.podModeNow = podModeNow;
// 船橋の旋回レバーに出す、今のポッドの向き（ポッドの平均[°]。無ければ null）
function maneuverPodAzNow() {
    if (!azipodActive() || typeof engineList !== 'function') return null;
    const L = engineList(); if (!L.length) return null;
    let sx = 0, sy = 0;
    for (const E of L) { const a = _mnvPod(E).az * _mnvRad; sx += Math.sin(a); sy += Math.cos(a); }
    return Math.atan2(sx, sy) / _mnvRad;
}
window.maneuverPodAzNow = maneuverPodAzNow;
// 舵の効き（17-main-loop.js）：個別・ジョイスティックのときは舵が無い
function maneuverRudderFactor() { const m = podModeNow(); return (m === 'indep' || m === 'joy' || m === 'lever') ? 0 : 1; }
window.maneuverRudderFactor = maneuverRudderFactor;

function _mnvPod(E) {
    let P = _mnv.pods.get(E.id);
    if (!P) { P = { az: 0, cmd: 0, rpmT: null }; _mnv.pods.set(E.id, P); }
    return P;
}
// 機関（ポッド）の位置（船の中の座標）。1 秒ごとに調べ直す
function _mnvEnginePos(E) {
    const now = performance.now();
    if (E._mnvPos && now - E._mnvPosT < 1000) return E._mnvPos;
    E._mnvPosT = now;
    let x = 0, z = -_mnvHL() / (physics.scale || 1) * 0.9;
    const s = E.screw;
    if (s && s.mesh) { x = s.mesh.position.x; z = s.mesh.position.z; }
    else if (s && s.part && typeof analyzeScrewDisc === 'function' && typeof shipGroup !== 'undefined' && shipGroup) {
        const d = analyzeScrewDisc(s.part);
        if (d) {
            const v = d.center.clone(); const par = s.part.object.parent || shipGroup;
            par.updateWorldMatrix(true, false); v.applyMatrix4(par.matrixWorld); shipGroup.worldToLocal(v);
            x = v.x; z = v.z;
        }
    }
    E._mnvPos = { x, z };
    return E._mnvPos;
}
function _mnvPodCapN(E) { return Math.max(1, (typeof engineHp === 'function' ? engineHp(E) : 10000)) * POD_N_PER_HP; }
function _mnvPodName(E) { return (typeof engineName === 'function' ? engineName(E) : 'ポッド').replace('機関', 'ポッド'); }

// ── 56-engines.js から ──
// ポッドの推力のうち前向きの割合（推進の速さに入る）
function maneuverPodCos(E) { if (!azipodActive()) return 1; return Math.cos(_mnvPod(E).az * _mnvRad); }
window.maneuverPodCos = maneuverPodCos;
// ジョイスティックのときは、機関の回転数をこちらで決める（それ以外は null ＝テレグラフどおり）
function maneuverRpmTarget(E) {
    if (podModeNow() !== 'joy') return null;
    const P = _mnvPod(E);
    return Number.isFinite(P.rpmT) ? P.rpmT : 0;
}
window.maneuverRpmTarget = maneuverRpmTarget;

// ════════════════════════════════════════════════════════════
//  力（47-tugboats.js の _tugStep から、細かい時間刻みごとに）
// ════════════════════════════════════════════════════════════
//  C.HL：船の半分の長さ[m]、C.sc：縮尺。戻り値：Fs（＋＝左舷へ）・Ff（前へ）[N]、Mz（＋＝船首を左舷へ）[N·m]
function shipExtraForces(C) {
    if (typeof isDesignMode !== 'undefined' && isDesignMode) return null;
    let Fs = 0, Mz = 0;
    const sc = (C && C.sc) || physics.scale || 1, HL = (C && C.HL) || _mnvHL();
    const lf = thrusterSpeedFactor();
    maneuver.thrusters.forEach((T, i) => {
        const st = _mnv.th[i]; if (!st || !st.out) return;
        const f = st.out * thrusterCapN(T) * lf;
        Fs += f; Mz += f * (T.at || 0) * HL;
    });
    const mode = podModeNow();
    if (mode && typeof engineList === 'function') {
        // 舵輪に連動のときは、速さが出たら舵の計算（17-main-loop.js）に任せる（横向きの力は遅いときだけ）
        const sideK = mode === 'helm' ? Math.max(0, 1 - Math.abs(physics.speed || 0) / 6) : 1;
        for (const E of engineList()) {
            const P = _mnvPod(E), T = E.rpm * Math.abs(E.rpm);
            if (!T) continue;
            const f = T * _mnvPodCapN(E) * (physics.propImmersion ?? 1), a = P.az * _mnvRad, pos = _mnvEnginePos(E);   // 水から出たポッドは効かない
            const fs = f * Math.sin(a) * sideK, ff = f * Math.cos(a);
            Fs += fs;
            Mz += fs * pos.z * sc - ff * pos.x * sc;     // 左舷のポッドが前へ押す → 船首は右舷へ（Mz −）
        }
    }
    return (Fs || Mz) ? { Fs, Ff: 0, Mz } : null;
}
window.shipExtraForces = shipExtraForces;
// タグがいなくても横流れ・回頭の計算をするか（47-tugboats.js）
function maneuverActive() {
    if (_mnv.th.some(s => s && Math.abs(s.out) > 1e-3)) return true;
    const m = podModeNow();
    if (m && typeof engineList === 'function') {
        for (const E of engineList()) if (Math.abs(E.rpm) > 1e-3 && (m !== 'helm' || Math.abs(_mnvPod(E).az) > 0.5)) return true;
    }
    return performance.now() - _mnv.activeT < 60000;
}
window.maneuverActive = maneuverActive;

// ════════════════════════════════════════════════════════════
//  ジョイスティック：前後・左右・回頭の力を、スラスターとポッドへ割り振る
// ════════════════════════════════════════════════════════════
//  変数 u：スラスター j の横の力 t_j、ポッド i の前・横の力 fx_i・fy_i。
//  A u = b（b＝前後の力・横の力・回頭のモーメント）を、出せる力の大きさで重み付けした
//  最小ノルム解 u = W Aᵀ (A W Aᵀ)⁻¹ b で解き、出しすぎなら全体を同じ割合で縮める。
function _mnvSolve3(M, b) {
    const [a, b1, c] = M[0], [d, e, f] = M[1], [g, h, k] = M[2];
    const det = a * (e * k - f * h) - b1 * (d * k - f * g) + c * (d * h - e * g);
    if (Math.abs(det) < 1e-30) return [0, 0, 0];
    const inv = [
        [(e * k - f * h), -(b1 * k - c * h), (b1 * f - c * e)],
        [-(d * k - f * g), (a * k - c * g), -(a * f - c * d)],
        [(d * h - e * g), -(a * h - b1 * g), (a * e - b1 * d)],
    ];
    return inv.map(r => (r[0] * b[0] + r[1] * b[1] + r[2] * b[2]) / det);
}
function _mnvAllocate(Fx, Fy, Mz, L, sc, HL, lf) {
    const cols = [];      // { a:[3], w, kind, ref }
    maneuver.thrusters.forEach((T, j) => {
        const cap = thrusterCapN(T) * lf;
        if (cap > 1) cols.push({ a: [0, 1, (T.at || 0) * HL], cap, kind: 't', j });
    });
    for (const E of L) {
        const cap = _mnvPodCapN(E), pos = _mnvEnginePos(E);
        cols.push({ a: [1, 0, -pos.x * sc], cap, kind: 'fx', E });
        cols.push({ a: [0, 1, pos.z * sc], cap, kind: 'fy', E });
    }
    if (!cols.length) return;
    const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    let tr = 0;
    for (const c of cols) { const w = c.cap * c.cap; for (let r = 0; r < 3; r++) for (let q = 0; q < 3; q++) M[r][q] += c.a[r] * w * c.a[q]; }
    for (let r = 0; r < 3; r++) tr += M[r][r];
    for (let r = 0; r < 3; r++) M[r][r] += tr * 1e-6 + 1e-9;     // 割り振れない向き（ポッド 1 基で横と回頭など）があっても解けるように
    const lam = _mnvSolve3(M, [Fx, Fy, Mz]);
    const out = new Map(); const tOut = [];
    let worst = 1;
    for (const c of cols) {
        const u = c.cap * c.cap * (c.a[0] * lam[0] + c.a[1] * lam[1] + c.a[2] * lam[2]);
        if (c.kind === 't') { tOut[c.j] = u / c.cap; worst = Math.max(worst, Math.abs(u) / c.cap); }
        else { const o = out.get(c.E) || { fx: 0, fy: 0 }; o[c.kind] = u; out.set(c.E, o); }
    }
    for (const E of L) { const o = out.get(E); worst = Math.max(worst, Math.hypot(o.fx, o.fy) / _mnvPodCapN(E)); }
    maneuver.thrusters.forEach((T, j) => { _mnv.th[j].auto = (tOut[j] || 0) / worst; });
    for (const E of L) {
        const o = out.get(E), P = _mnvPod(E);
        const Tn = Math.hypot(o.fx, o.fy) / _mnvPodCapN(E) / worst;   // 推力の割合（0〜1）
        if (Tn < 0.01) { P.rpmT = 0; continue; }                     // ほとんど押さないなら、向きはそのまま
        let az = Math.atan2(o.fy, o.fx) / _mnvRad, sgn = 1;
        // 後進できるポッドは、半周回すより逆転のほうが早ければ逆転（後進の推力は前進の 1/4 まで）
        if (E.conf && E.conf.astern !== false && Tn <= 0.25) {
            const d1 = Math.abs(_mnvWrap(az - P.az)), d2 = Math.abs(_mnvWrap(az + 180 - P.az));
            if (d1 - d2 > 60) { az = _mnvWrap(az + 180); sgn = -1; }
        }
        P.cmd = _mnvWrap(az);
        // 向きが合うまでは推力を絞る（違う向きへ押さないように）
        const err = Math.abs(_mnvWrap(P.cmd - P.az)) * _mnvRad;
        const k = Math.max(0, Math.cos(Math.min(Math.PI / 2, err * 1.5)));
        P.rpmT = sgn * Math.sqrt(Tn * k);
    }
}
// 指で示した量 → 欲しい力
function _mnvJoyDemand(L, sc, HL, lf, dt) {
    const J = maneuver.joy;
    let capP = 0, zP = 0;
    for (const E of L) { capP += _mnvPodCapN(E); zP += Math.abs(_mnvEnginePos(E).z * sc); }
    zP = L.length ? zP / L.length : HL * 0.9;
    let capT = 0, mT = 0;
    maneuver.thrusters.forEach(T => { const c = thrusterCapN(T) * lf; capT += c; mT += c * Math.abs((T.at || 0) * HL); });
    const FyMax = capP * 0.6 + capT, MzMax = mT + capP * 0.5 * zP;
    let Fx = J.y * 0.25 * capP;
    let Fy = -J.x * FyMax;
    let Mz = -J.r * MzMax;
    const m = _mnvMassKg(), Lm = Math.max(10, HL * 2);
    const wn = Math.max(0.06, Math.min(0.35, 2.2 / Math.sqrt(Lm)));
    const H = _mnv.hold;
    const F = (typeof _shipFrame === 'function') ? _shipFrame() : { fx: Math.sin(physics.heading * _mnvRad), fz: Math.cos(physics.heading * _mnvRad), sx: Math.cos(physics.heading * _mnvRad), sz: -Math.sin(physics.heading * _mnvRad) };
    const vS = (typeof _tugShip !== 'undefined') ? _tugShip.vSway : 0;
    // 方位保持：回す指示が無いときは、覚えた方位へ戻す
    if (J.holdHdg && Math.abs(J.r) < 0.05) {
        if (H.hdg === null) H.hdg = physics.heading;
        const e = _mnvWrap(H.hdg - physics.heading) * _mnvRad;
        const r = ((physics.turnRate || 0) * _mnvRad) + ((typeof _tugShip !== 'undefined') ? _tugShip.yawRate : 0);
        const I = m * 1.5 * Lm * Lm / 12;
        Mz = Math.max(-MzMax, Math.min(MzMax, I * (wn * wn * e - 2 * wn * r)));
    } else H.hdg = physics.heading;
    // 位置保持：動かす指示が無いときは、覚えた位置へ戻す
    if (J.holdPos && Math.hypot(J.x, J.y) < 0.05) {
        if (H.x === null) { H.x = physics.cgWorldX; H.z = physics.cgWorldZ; }
        const ex = H.x - physics.cgWorldX, ez = H.z - physics.cgWorldZ;
        const eF = ex * F.fx + ez * F.fz, eS = ex * F.sx + ez * F.sz;
        Fy = Math.max(-FyMax, Math.min(FyMax, m * 1.8 * (wn * wn * eS - 2 * wn * vS)));
        // 前後は、機関の回転数＝速さの目標なので、ずれに比べた速さを目標にする
        const uDes = Math.max(-1, Math.min(1, eF * wn * 0.8));                // m/s
        const vmax = Math.max(1, physics.maxSpeed || 13) * 0.514;
        const S = Math.sign(uDes) * Math.pow(Math.abs(uDes) / vmax, 2);
        Fx = S * capP;
    } else { H.x = physics.cgWorldX; H.z = physics.cgWorldZ; }
    return { Fx, Fy, Mz };
}
function maneuverShift(shift, dH) {
    const H = _mnv.hold;
    if (H.x !== null) { H.x += shift.x; H.z += shift.z; }
    if (H.hdg !== null) H.hdg += (dH || 0) * 180 / Math.PI;
}
window.maneuverShift = maneuverShift;

// ════════════════════════════════════════════════════════════
//  毎フレーム
// ════════════════════════════════════════════════════════════
function updateManeuver(t, dt) {
    dt = Math.min(0.5, Math.max(0, dt || 0));
    const design = typeof isDesignMode !== 'undefined' && isDesignMode;
    if (!_mnv.syncT || performance.now() - _mnv.syncT > 1000) { _mnv.syncT = performance.now(); _mnvSyncParts(); }
    if (maneuver.thrusters.length) _mnvThState(maneuver.thrusters.length - 1);
    _mnv.th.length = maneuver.thrusters.length;
    const mode = podModeNow();
    const L = (mode && typeof engineList === 'function') ? engineList() : [];
    const sc = physics.scale || 1, HL = _mnvHL(), lf = thrusterSpeedFactor();
    // ── ポッドの向きの指示 ──
    if (mode === 'helm') for (const E of L) { const P = _mnvPod(E); P.cmd = Math.max(-35, Math.min(35, physics.rudderAngle || 0)); P.rpmT = null; }
    else if (mode === 'lever') { const a = _mnvWrap(bridgeAzimuthLever()); for (const E of L) { const P = _mnvPod(E); P.cmd = a; P.rpmT = null; } }
    else if (mode === 'joy' && !design) {
        const D = _mnvJoyDemand(L, sc, HL, lf, dt);
        _mnvAllocate(D.Fx, D.Fy, D.Mz, L, sc, HL, lf);
    } else for (const E of L) _mnvPod(E).rpmT = null;
    if (mode !== 'joy') for (const s of _mnv.th) s.auto = 0;
    // ── ポッドは決まった速さで回る（近いほうへ）──
    for (const E of L) {
        const P = _mnvPod(E);
        const d = _mnvWrap(P.cmd - P.az), step = Math.max(0.5, maneuver.podRate || 8) * dt;
        P.az = Math.abs(d) <= step ? P.cmd : _mnvWrap(P.az + Math.sign(d) * step);
    }
    // ── スラスター：キー、パネル、ジョイスティック。2 秒ほどで全力に ──
    maneuver.thrusters.forEach((T, i) => {
        const s = _mnv.th[i], bow = (T.at || 0) >= 0;
        let want = mode === 'joy' ? s.auto : s.set;
        for (const k in _mnv.keys) if (_mnv.keys[k]) { const [w, sg] = MNV_KEYS[k]; if ((w === 'bow') === bow) want = sg; }
        if (design || T._on === false) want = 0;
        want = Math.max(-1, Math.min(1, want || 0));
        const d = want - s.out, step = 0.5 * dt;
        s.out = Math.abs(d) <= step ? want : s.out + Math.sign(d) * step;
    });
    if (_mnv.th.some(s => Math.abs(s.out) > 1e-3) || (mode && mode !== 'helm' && L.some(E => Math.abs(E.rpm) > 1e-3))) _mnv.activeT = performance.now();
    _mnvVisual(t, dt);
    // ギズモの目印は、ギズモで動かしている間だけ見せる
    for (const m of _mnv.markers || []) if (m) m.visible = typeof currentGizmoTarget !== 'undefined' && currentGizmoTarget === m;
    // ── パネル ──
    const panel = document.getElementById('mnv-panel');
    if (panel && panel.classList.contains('open')) {
        const now = performance.now();
        if (now - _mnv.drawT > 90) { _mnv.drawT = now; _mnvDrawDiagram(); _mnvDrawDials(); _mnvDrawPad(); }
        // （uiSetHTML はパネルを触った直後の書き換えを遅らせるので、新しいつまみ・円への結び付けもここで）
        if (now - _mnv.statT > 350) { _mnv.statT = now; _mnvBindInputs(); _mnvStatus(); if (_mnvUiKey() !== _mnv.uiKey) renderManeuverPanel(); }
    }
    _mnvUpdateHudButton();
}
window.updateManeuver = updateManeuver;
// 自動航行がスラスターで船を動かしている間の見た目（lat：＋＝左舷へ、yaw：＋＝船首を左舷へ）
function maneuverAutoVis(lat, yaw) { _mnv.autoVis = { lat: lat || 0, yaw: yaw || 0, t: performance.now() }; }
window.maneuverAutoVis = maneuverAutoVis;

// ════════════════════════════════════════════════════════════
//  見た目：トンネルの口・噴き出す水、ポッドの向き
// ════════════════════════════════════════════════════════════
function _mnvHullX(y, z) {
    const hp = window.hullProfile;
    let hw = 1.5;
    if (hp && hp.ready && hp.slices && hp.slices.length > 1) {
        const a = z / hp.halfLen * (hp.bowSign || 1); let best = hp.slices[0];
        for (const q of hp.slices) if (Math.abs(q.alongNorm - a) < Math.abs(best.alongNorm - a)) best = q;
        hw = best.halfWidth || hp.halfBeam;
    }
    if (typeof importedModelGroup !== 'undefined' && importedModelGroup && typeof shipGroup !== 'undefined' && shipGroup) {
        shipGroup.updateMatrixWorld(true);
        const o = shipGroup.localToWorld(_mnvToShip(hw * 2 + 1, y, z));
        const b = shipGroup.localToWorld(_mnvToShip(0, y, z));
        const rc = new THREE.Raycaster(o, b.sub(o).normalize());
        if (typeof camera !== 'undefined') rc.camera = camera;             // 模型の中のスプライト用
        let hits = [];
        try { hits = rc.intersectObject(importedModelGroup, true).filter(h => h.object.visible && h.object.isMesh); } catch (e) { hits = []; }
        if (hits.length) { const p = _mnvFromShip(shipGroup.worldToLocal(hits[0].point.clone())); if (p.x > 0.02) return { x: p.x, hit: true }; }
    }
    return { x: hw * 0.85, hit: false };
}
function _mnvThrusterGeom(T) {
    if (T._on === false) return null;
    const hp = window.hullProfile, sc = physics.scale || 1;
    const half = (hp && hp.ready) ? hp.halfLen : 6;
    let z = (T.at || 0) * half * _mnvBowSign();
    const wl = (hp && hp.ready) ? (hp.designWaterlineY || 0) : 0, keel = (hp && hp.ready) ? (hp.keelY || -1) : -1;
    let r = Math.max(0.3, Math.min(1.6, 0.0275 * Math.sqrt(Math.max(10, +T.kW || 0)))) / sc;   // トンネルの半径（1000kW で径 1.7m）
    // モデルの部品のスラスター：位置・大きさは部品から（トンネルの口はモデルにあるので作らない）
    const part = _mnvPartOf(T);
    if (part) {
        const c = _mnvPartCenter(part), pr = _mnvPartRadius(part);
        if (pr) r = Math.min(r * 2, Math.max(r * 0.5, pr));
        const q = _mnvHullX(c.y, c.z);
        return { x: q.x, y: c.y, z: c.z, r, part: true };
    }
    // 高さを決めてあれば、その高さ
    if (Number.isFinite(T.y)) { const q = _mnvHullX(T.y, z); return { x: q.x, y: T.y, z, r }; }
    let best = null;
    for (const k of [0.55, 0.45, 0.35]) {
        const y = wl - (wl - keel) * k, q = _mnvHullX(y, z);
        if (q.hit) { best = { x: q.x, y, z, r }; break; }
        if (!best) best = { x: q.x, y, z, r };
    }
    return best;
}
function _mnvBuildVis() {
    if (typeof shipGroup === 'undefined' || !shipGroup) return;
    const hp = window.hullProfile;
    const key = JSON.stringify(maneuver.thrusters.map(T => [T.at, T.kW, T.y, T.part, T._on])) + '|' + _mnvFrameA().toFixed(3) + '|' + (hp && hp.ready ? hp.halfLen + ',' + hp.halfBeam : '-') + '|' + (physics.scale || 1) + '|' + (shipGroup.children.length > 0);
    if (key === _mnv.visKey && _mnv.vis && _mnv.vis.parent === shipGroup) return;
    _mnv.visKey = key;
    if (_mnv.vis) { _mnv.vis.parent && _mnv.vis.parent.remove(_mnv.vis); _mnv.vis.traverse(c => { if (c.geometry) c.geometry.dispose(); }); }
    const g = new THREE.Group(); g.name = 'Thrusters';
    const holeM = _mnvBuildVis.hole || (_mnvBuildVis.hole = new THREE.MeshBasicMaterial({ color: 0x080a0c, side: THREE.DoubleSide }));
    const rimM = _mnvBuildVis.rim || (_mnvBuildVis.rim = new THREE.MeshStandardMaterial({ color: 0x3a3f44, roughness: 0.6, metalness: 0.5, side: THREE.DoubleSide }));
    g.userData.geo = [];
    maneuver.thrusters.forEach((T) => {
        const G = _mnvThrusterGeom(T);
        g.userData.geo.push(G);
        if (!G || G.part) return;
        for (const side of [1, -1]) {
            const hole = new THREE.Mesh(new THREE.CircleGeometry(G.r, 24), holeM);
            hole.position.set(side * (G.x + 0.02 / (physics.scale || 1)), G.y, G.z);
            hole.rotation.y = side * Math.PI / 2;
            const rim = new THREE.Mesh(new THREE.RingGeometry(G.r, G.r * 1.12, 24), rimM);
            rim.position.copy(hole.position); rim.rotation.copy(hole.rotation);
            // 格子（トンネルの口の保護棒）
            const bars = new THREE.Mesh(new THREE.PlaneGeometry(G.r * 0.08, G.r * 2), rimM);
            bars.position.copy(hole.position).x += side * 0.01 / (physics.scale || 1); bars.rotation.copy(hole.rotation);
            for (const m of [hole, rim, bars]) { m.userData.noBloom = true; m.userData.isThruster = true; g.add(m); }
        }
    });
    g.rotation.y = _mnvFrameA();          // 中の物は船体の向きの面で置いてある
    shipGroup.add(g);
    _mnv.vis = g;
    if (typeof bloomTargetsDirty === 'function') bloomTargetsDirty();
}
const _mnvV = new THREE.Vector3(), _mnvV2 = new THREE.Vector3();
function _mnvVisual(t, dt) {
    if (typeof shipGroup === 'undefined' || !shipGroup) return;
    _mnvBuildVis();
    // ポッドの向き（組み込みの推進器）
    if (typeof propMeshes !== 'undefined' && azipodActive()) {
        for (const g of propMeshes) {
            if (!g.userData.isPod) continue;
            // 機関がこの推進器なら、その向き。モデルのスクリューが機関のときは、いちばん近い機関の向き
            const P = _mnv.pods.get('prop:' + g.userData.propIndex + (g.userData.isMirror ? ':m' : ''));
            g.rotation.y = P ? P.az * _mnvRad : _mnvAzNear(g, g.position.x, g.position.z);
        }
    }
    // 噴き出す水：出口の舷の海面に白い泡
    if (typeof puffEmit !== 'function' || !_mnv.vis || !dt) return;
    const geo = _mnv.vis.userData.geo || [];
    const av = _mnv.autoVis && performance.now() - _mnv.autoVis.t < 400 ? _mnv.autoVis : null;
    const sc = physics.scale || 1;
    shipGroup.updateMatrixWorld();
    maneuver.thrusters.forEach((T, i) => {
        const G = geo[i], s = _mnv.th[i]; if (!G || !s) return;
        let out = s.out;
        if (av && !out) out = Math.max(-1, Math.min(1, av.lat * 0.7 + av.yaw * Math.sign(T.at || 1) * 0.8));
        if (Math.abs(out) < 0.05) return;
        // 船を左舷へ押す（out ＋）→ 水は右舷（−x）の口から出る
        const side = out > 0 ? -1 : 1;
        _mnv.puffAcc[i] = (_mnv.puffAcc[i] || 0) + dt * (6 + 14 * Math.abs(out));
        if (_mnv.puffAcc[i] > 30) _mnv.puffAcc[i] = 30;
        _mnv.vis.updateMatrixWorld();
        _mnvV.set(side * (G.x + G.r * 0.5), G.y, G.z); _mnv.vis.localToWorld(_mnvV);
        _mnvV2.set(side, 0, 0).transformDirection(_mnv.vis.matrixWorld);
        const wy = (typeof getOceanHeight === 'function') ? getOceanHeight(_mnvV.x, _mnvV.z, t) : 0;
        if (_mnvV.y > wy + 0.5) { _mnv.puffAcc[i] = 0; return; }         // 口が水の上に出ている
        const R = G.r * sc, v = (2 + 6 * Math.abs(out)) * Math.min(1.6, Math.max(0.6, R));
        while (_mnv.puffAcc[i] >= 1) {
            _mnv.puffAcc[i] -= 1;
            const j = Math.random();
            puffEmit({ x: _mnvV.x + _mnvV2.x * R * (0.5 + j * 2) + (Math.random() - 0.5) * R, y: wy + 0.15, z: _mnvV.z + _mnvV2.z * R * (0.5 + j * 2) + (Math.random() - 0.5) * R,
                vx: _mnvV2.x * v * (0.6 + Math.random() * 0.6), vy: 0.4 + Math.random() * 0.8, vz: _mnvV2.z * v * (0.6 + Math.random() * 0.6),
                r: 0.93, g: 0.96, b: 0.98, a: 0.5 * Math.min(1, Math.abs(out) + 0.3), s0: R * 1.4, s1: R * (4 + 3 * Math.abs(out)), life: 2.5 + Math.random() * 2, rise: 0, drag: 0.7, grav: 0.4 });
        }
    });
}
// いちばん近い機関のポッドの向き[rad]（o に覚えておく。5 秒ごとに調べ直す）
function _mnvAzNear(o, x, z) {
    if (typeof engineList !== 'function') return 0;
    const L = engineList(); if (!L.length) return 0;
    if (!o._mnvEng || !L.some(E => E.id === o._mnvEng) || performance.now() - (o._mnvEngT || 0) > 5000) {
        o._mnvEngT = performance.now();
        let best = L[0], bd = Infinity;
        for (const E of L) { const p = _mnvEnginePos(E), d = Math.hypot(p.x - x, (p.z - z) * 0.3); if (d < bd) { bd = d; best = E; } }
        o._mnvEng = best.id;
    }
    const P = _mnv.pods.get(o._mnvEng);
    return P ? P.az * _mnvRad : 0;
}
// 読み込んだモデルのアジポッドの部品の向き（12-bloom-...js の animatePropellers から）
function maneuverPodAzForPart(part) {
    if (!part._mnvC || performance.now() - (part._mnvCT || 0) > 5000) {
        part._mnvCT = performance.now();
        const v = new THREE.Vector3(); part.object.updateWorldMatrix(true, true);
        new THREE.Box3().setFromObject(part.object).getCenter(v); shipGroup.worldToLocal(v);
        part._mnvC = { x: v.x, z: v.z };
    }
    return _mnvAzNear(part, part._mnvC.x, part._mnvC.z);
}
window.maneuverPodAzForPart = maneuverPodAzForPart;

// ════════════════════════════════════════════════════════════
//  画面：「操船」ボタンとパネル
// ════════════════════════════════════════════════════════════
function _mnvHasPanel() { return maneuver.thrusters.some(T => T._on !== false) || azipodActive(); }
function _mnvUpdateHudButton() {
    const b = document.getElementById('btn-mnv'); if (!b) return;
    const on = _mnvHasPanel();
    if ((b.style.display === 'none') === on) {
        b.style.display = on ? '' : 'none';
        if (!on) { const p = document.getElementById('mnv-panel'); if (p) p.classList.remove('open'); b.classList.remove('on'); }
        if (typeof applyBridgeLayout === 'function') applyBridgeLayout();
    }
}
function _mnvSetup() {
    const after = document.getElementById('btn-sub') || document.getElementById('btn-tug') || document.getElementById('btn-horn-sig');
    if (!after || document.getElementById('btn-mnv')) { if (!after) setTimeout(_mnvSetup, 250); return; }
    const P = hudPopup({ id: 'btn-mnv', panelId: 'mnv-panel', label: '操船', title: 'サイドスラスター・アジポッド', after, render: renderManeuverPanel });
    _mnvSetup.place = P.place;
    P.btn.style.display = 'none';
    _mnvUpdateHudButton();
}
function _mnvUiKey() { return [maneuver.thrusters.map(T => T._on === false ? 0 : 1).join(''), azipodActive(), podModeNow(), maneuver.podMode, typeof engineList === 'function' && azipodActive() ? engineList().map(E => E.id).join(',') : '', maneuver.joy.latch, maneuver.joy.holdHdg, maneuver.joy.holdPos].join('|'); }
function renderManeuverPanel() {
    const panel = document.getElementById('mnv-panel'); if (!panel) return;
    _mnv.uiKey = _mnvUiKey();
    const mode = podModeNow(), pods = azipodActive();
    const L = pods && typeof engineList === 'function' ? engineList() : [];
    let h = `<div class="mv-head"><span class="mv-title">操船</span></div>
        <div class="mv-body"><canvas id="mnv-diag" width="110" height="200"></canvas><div class="mv-ctl">`;
    if (maneuver.thrusters.some(T => T._on !== false)) {
        h += `<div class="mv-sec">サイドスラスター</div>`;
        maneuver.thrusters.forEach((T, i) => {
            if (T._on === false) return;
            const nm = T.name || ((T.at || 0) >= 0 ? '船首スラスター' : '船尾スラスター');
            h += `<div class="mv-th"><div class="mv-thn">${nm}<span id="mnv-th-${i}" class="mv-val"></span></div>
                <div class="mv-row">${[[-1, '◀◀'], [-0.5, '◀'], [0, '■'], [0.5, '▶'], [1, '▶▶']].map(([v, l]) =>
                    `<button onclick="maneuverSetThruster(${i},${-v})" ${mode === 'joy' ? 'disabled' : ''}>${l}</button>`).join('')}</div></div>`;
        });
        h += `<div class="mv-note">◀ 左舷へ押す／右舷へ押す ▶　キー：<b>,</b> <b>.</b>（船首）<b>K</b> <b>L</b>（船尾）</div>`;
    }
    if (pods) {
        h += `<div class="mv-sec">アジポッド</div><div class="mv-row">${[['helm', '舵輪に連動'], ['indep', '個別'], ['joy', 'ジョイスティック']].map(([k, l]) =>
            `<button onclick="maneuverSetPodMode('${k}')" class="${maneuver.podMode === k ? 'on' : ''}">${l}</button>`).join('')}</div>`;
        if (mode !== maneuver.podMode) h += `<div class="mv-note">自動航行・自動の離着岸の間は、舵輪に連動します</div>`;
        if (mode === 'helm') h += `<div class="mv-note">ポッドの向き＝舵角。推力はテレグラフで。遅いときはポッドの横向きの推力でも回ります。船橋の舵輪を「アジポッド用の旋回レバー」にすると、レバーで 360° 向きを変えられます</div>`;
        if (mode === 'lever') h += `<div class="mv-note">ポッドの向き＝船橋の旋回レバー（360°）。推力はテレグラフで。舵は使いません</div>`;
        if (mode === 'indep') {
            h += `<div class="mv-dials">${L.map((E, i) => `<div class="mv-dial"><canvas id="mnv-dial-${i}" data-i="${i}" width="96" height="96"></canvas><div>${_mnvPodName(E)}</div></div>`).join('')}</div>
                <div class="mv-row">${[0, 45, 90, 180, -90, -45].map(a => `<button onclick="maneuverSetAllAz(${a})">${a === 0 ? '前' : a === 180 ? '後' : (a > 0 ? '左' : '右') + Math.abs(a)}°</button>`).join('')}</div>
                <div class="mv-note">円を触ってポッドの向き（推す向き）を決めます。推力は機関ごとのテレグラフで。舵は効きません</div>`;
        }
        if (mode === 'joy') {
            h += `<div class="mv-joy"><canvas id="mnv-pad" width="130" height="130"></canvas>
                <div class="mv-jcol"><div>回頭</div><input id="mnv-twist" type="range" min="-100" max="100" value="${Math.round(maneuver.joy.r * 100)}">
                <label><input type="checkbox" ${maneuver.joy.latch ? 'checked' : ''} onchange="maneuver.joy.latch=this.checked;renderManeuverPanel()"> 手を離しても保つ</label>
                <label><input type="checkbox" ${maneuver.joy.holdHdg ? 'checked' : ''} onchange="maneuverHold('hdg',this.checked)"> 方位保持</label>
                <label><input type="checkbox" ${maneuver.joy.holdPos ? 'checked' : ''} onchange="maneuverHold('pos',this.checked)"> 位置保持</label>
                <button onclick="maneuverJoyZero()">中立</button></div></div>
                <div class="mv-note">十字の向きへ船を動かします（上＝前、左＝左舷）。テレグラフと舵は使いません</div>`;
        }
    }
    h += `<div id="mnv-stat" class="mv-stat"></div></div></div>`;
    uiSetHTML(panel, h);
    setTimeout(() => { _mnvBindInputs(); _mnvStatus(); _mnvDrawDiagram(); _mnvDrawDials(); _mnvDrawPad(); if (panel.classList.contains('open') && _mnvSetup.place) _mnvSetup.place(); }, 0);
}
window.renderManeuverPanel = renderManeuverPanel;
function maneuverSetThruster(i, v) { if (!maneuver.thrusters[i]) return; _mnvThState(i).set = Math.max(-1, Math.min(1, v)); _mnvStatus(); }
window.maneuverSetThruster = maneuverSetThruster;
function maneuverSetPodMode(m) {
    maneuver.podMode = m;
    // 個別のときは機関ごとのテレグラフで推力を決める
    if (typeof engineSetSplit === 'function') engineSetSplit(m === 'indep');
    if (m !== 'joy') { maneuver.joy.x = maneuver.joy.y = maneuver.joy.r = 0; }
    if (m === 'indep' && typeof engineList === 'function') for (const E of engineList()) { const P = _mnvPod(E); P.cmd = P.az; }
    _mnv.hold.hdg = null; _mnv.hold.x = null;
    renderManeuverPanel();
}
window.maneuverSetPodMode = maneuverSetPodMode;
function maneuverSetAllAz(a) { if (typeof engineList === 'function') for (const E of engineList()) _mnvPod(E).cmd = _mnvWrap(a); }
window.maneuverSetAllAz = maneuverSetAllAz;
function maneuverHold(k, on) {
    if (k === 'hdg') { maneuver.joy.holdHdg = !!on; _mnv.hold.hdg = null; }
    else { maneuver.joy.holdPos = !!on; _mnv.hold.x = null; }
    renderManeuverPanel();
}
window.maneuverHold = maneuverHold;
function maneuverJoyZero() { maneuver.joy.x = maneuver.joy.y = maneuver.joy.r = 0; const tw = document.getElementById('mnv-twist'); if (tw) tw.value = 0; }
window.maneuverJoyZero = maneuverJoyZero;

function _mnvBindInputs() {
    const pad = document.getElementById('mnv-pad');
    if (pad && !pad._mnvB) {
        pad._mnvB = true;
        const set = (e) => {
            const r = pad.getBoundingClientRect(), cx = r.width / 2, cy = r.height / 2;
            let x = (e.clientX - r.left - cx) / (cx * 0.85), y = -(e.clientY - r.top - cy) / (cy * 0.85);
            const m = Math.hypot(x, y); if (m > 1) { x /= m; y /= m; }
            maneuver.joy.x = Math.abs(x) < 0.06 ? 0 : x; maneuver.joy.y = Math.abs(y) < 0.06 ? 0 : y;
        };
        pad.addEventListener('pointerdown', (e) => { e.preventDefault(); try { pad.setPointerCapture(e.pointerId); } catch (er) { /* */ } pad._drag = true; set(e); });
        pad.addEventListener('pointermove', (e) => { if (pad._drag) set(e); });
        const up = () => { pad._drag = false; if (!maneuver.joy.latch) { maneuver.joy.x = 0; maneuver.joy.y = 0; } };
        pad.addEventListener('pointerup', up); pad.addEventListener('pointercancel', up);
    }
    const tw = document.getElementById('mnv-twist');
    if (tw && !tw._mnvB) {
        tw._mnvB = true;
        tw.addEventListener('input', () => { maneuver.joy.r = (+tw.value || 0) / 100; });
        const up = () => { if (!maneuver.joy.latch) { maneuver.joy.r = 0; tw.value = 0; } };
        tw.addEventListener('pointerup', up); tw.addEventListener('touchend', up); tw.addEventListener('change', () => { if (!maneuver.joy.latch) up(); });
    }
    document.querySelectorAll('#mnv-panel canvas[id^="mnv-dial-"]').forEach(cv => {
        if (cv._mnvB) return; cv._mnvB = true;
        const set = (e) => {
            const r = cv.getBoundingClientRect(), dx = e.clientX - r.left - r.width / 2, dy = e.clientY - r.top - r.height / 2;
            if (Math.hypot(dx, dy) < 6) return;
            const L = engineList(), E = L[+cv.dataset.i]; if (!E) return;
            // 上＝船首の向き、左＝左舷。角度は 5° ずつ
            _mnvPod(E).cmd = _mnvWrap(Math.round(Math.atan2(-dx, -dy) / _mnvRad / 5) * 5);
        };
        cv.addEventListener('pointerdown', (e) => { e.preventDefault(); try { cv.setPointerCapture(e.pointerId); } catch (er) { /* */ } cv._drag = true; set(e); });
        cv.addEventListener('pointermove', (e) => { if (cv._drag) set(e); });
        cv.addEventListener('pointerup', () => { cv._drag = false; });
        cv.addEventListener('pointercancel', () => { cv._drag = false; });
    });
}
function _mnvStatus() {
    const lf = thrusterSpeedFactor();
    maneuver.thrusters.forEach((T, i) => {
        const el = document.getElementById('mnv-th-' + i), s = _mnv.th[i]; if (!el || !s) return;
        const o = Math.round(s.out * 100);
        el.textContent = `　${o === 0 ? '停止' : (o > 0 ? '左舷へ ' : '右舷へ ') + Math.abs(o) + '%'}${lf < 0.99 && o ? `（効き ${Math.round(lf * 100)}%）` : ''}`;
    });
    const st = document.getElementById('mnv-stat'); if (!st) return;
    const vS = (typeof _tugShip !== 'undefined') ? _tugShip.vSway : 0;
    const r = ((physics.turnRate || 0)) + ((typeof _tugShip !== 'undefined') ? _tugShip.yawRate / _mnvRad : 0);
    let s = `<div>前後 ${(physics.speed || 0).toFixed(1)}kn　横 ${Math.abs(vS) < 0.02 ? '0' : (vS > 0 ? '左舷へ ' : '右舷へ ') + Math.abs(vS).toFixed(2) + 'm/s'}　回頭 ${Math.abs(r) < 0.02 ? '0' : (r > 0 ? '左 ' : '右 ') + Math.abs(r).toFixed(2) + '°/s'}</div>`;
    if (azipodActive() && typeof engineList === 'function') {
        s += engineList().map(E => { const P = _mnvPod(E); return `<div>${_mnvPodName(E)}　向き ${_mnvAz(P.az)}${Math.abs(_mnvWrap(P.cmd - P.az)) > 1 ? `（→${_mnvAz(P.cmd)}）` : ''}　推力 ${Math.round(E.rpm * Math.abs(E.rpm) * 100)}%</div>`; }).join('');
    }
    if (podModeNow() === 'joy' && (maneuver.joy.holdPos || maneuver.joy.holdHdg)) {
        const H = _mnv.hold, d = H.x !== null ? Math.hypot(H.x - physics.cgWorldX, H.z - physics.cgWorldZ) : 0;
        s += `<div class="mv-hold">${maneuver.joy.holdHdg ? `方位保持 ${H.hdg !== null ? 'ずれ ' + Math.abs(_mnvWrap(H.hdg - physics.heading)).toFixed(1) + '°' : ''}　` : ''}${maneuver.joy.holdPos ? `位置保持 ずれ ${d.toFixed(1)}m` : ''}</div>`;
    }
    st.innerHTML = s;
}
function _mnvAz(a) { a = Math.round(_mnvWrap(a)); return a === 0 ? '前 0°' : Math.abs(a) === 180 ? '後 180°' : (a > 0 ? '左 ' : '右 ') + Math.abs(a) + '°'; }

// ── 船を上から見た図：ポッドとスラスターの推力の向き・大きさ ──
function _mnvDrawDiagram() {
    const cv = document.getElementById('mnv-diag'); if (!cv) return;
    const ctx = cv.getContext('2d'), W = cv.width, Hh = cv.height;
    ctx.clearRect(0, 0, W, Hh);
    const hp = window.hullProfile, half = (hp && hp.ready) ? hp.halfLen : 6, hb = (hp && hp.ready) ? hp.halfBeam : 1.5;
    const k = (Hh * 0.42) / half, kw = Math.min((W * 0.32) / hb, k * 3);   // 幅は見やすく広げる
    const cx = W / 2, cy = Hh / 2;
    const X = (x) => cx - x * kw, Y = (z) => cy - z * k;          // 左舷（+x）は左
    // 船体の輪郭（輪切りから）
    ctx.beginPath();
    const sl = (hp && hp.ready && hp.slices && hp.slices.length > 2) ? hp.slices.slice().sort((a, b) => a.alongNorm - b.alongNorm) : null;
    if (sl) {
        const bs = hp.bowSign || 1;
        sl.forEach((q, i) => { const z = q.alongNorm * half * bs, x = q.halfWidth || hb; i ? ctx.lineTo(X(x), Y(z)) : ctx.moveTo(X(x), Y(z)); });
        for (let i = sl.length - 1; i >= 0; i--) { const q = sl[i]; ctx.lineTo(X(-(q.halfWidth || hb)), Y(q.alongNorm * half * bs)); }
    } else { ctx.moveTo(cx, Y(half)); ctx.lineTo(X(hb), Y(half * 0.6)); ctx.lineTo(X(hb), Y(-half)); ctx.lineTo(X(-hb), Y(-half)); ctx.lineTo(X(-hb), Y(half * 0.6)); }
    ctx.closePath();
    ctx.fillStyle = 'rgba(120,170,210,0.18)'; ctx.fill();
    ctx.strokeStyle = 'rgba(160,210,255,0.7)'; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.fillStyle = '#9cc'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('船首', cx, 9);
    const arrow = (x0, y0, dx, dy, col) => {
        const m = Math.hypot(dx, dy); if (m < 2) return;
        ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0 + dx, y0 + dy); ctx.stroke();
        const ux = dx / m, uy = dy / m;
        ctx.beginPath(); ctx.moveTo(x0 + dx + ux * 5, y0 + dy + uy * 5); ctx.lineTo(x0 + dx - uy * 4, y0 + dy + ux * 4); ctx.lineTo(x0 + dx + uy * 4, y0 + dy - ux * 4); ctx.fill();
    };
    // スラスター
    const lf = thrusterSpeedFactor();
    maneuver.thrusters.forEach((T, i) => {
        if (T._on === false) return;
        const s = _mnv.th[i], y = Y((T.at || 0) * half);
        ctx.strokeStyle = 'rgba(200,220,240,0.6)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(X(hb * 0.7), y); ctx.lineTo(X(-hb * 0.7), y); ctx.stroke();
        if (s && s.out) arrow(cx, y, -s.out * 34 * Math.max(0.2, lf), 0, lf > 0.3 ? '#ffd65a' : '#aa9050');
    });
    // ポッド
    if (azipodActive() && typeof engineList === 'function') {
        for (const E of engineList()) {
            const P = _mnvPod(E), pos = _mnvEnginePos(E), x0 = X(pos.x), y0 = Y(pos.z), a = P.az * _mnvRad;
            const T = E.rpm * Math.abs(E.rpm), len = 8 + Math.abs(T) * 34;
            // ポッドの向き（細い線）と推力（矢印）
            ctx.strokeStyle = 'rgba(0,255,204,0.55)'; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(x0 + Math.sin(a) * 8, y0 + Math.cos(a) * 8); ctx.lineTo(x0 - Math.sin(a) * 8, y0 - Math.cos(a) * 8); ctx.stroke();
            if (Math.abs(T) > 0.005) arrow(x0, y0, -Math.sin(a) * len * Math.sign(T), -Math.cos(a) * len * Math.sign(T), '#00ffcc');
            if (Math.abs(_mnvWrap(P.cmd - P.az)) > 1) { const c = P.cmd * _mnvRad; ctx.strokeStyle = 'rgba(255,214,90,0.8)'; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0 - Math.sin(c) * 22, y0 - Math.cos(c) * 22); ctx.stroke(); ctx.setLineDash([]); }
            ctx.fillStyle = '#cfe'; ctx.beginPath(); ctx.arc(x0, y0, 3, 0, Math.PI * 2); ctx.fill();
        }
    }
}
// ── 個別：ポッドごとの向きの円 ──
function _mnvDrawDials() {
    if (podModeNow() !== 'indep' || typeof engineList !== 'function') return;
    engineList().forEach((E, i) => {
        const cv = document.getElementById('mnv-dial-' + i); if (!cv) return;
        const ctx = cv.getContext('2d'), W = cv.width, c = W / 2, R = W / 2 - 6, P = _mnvPod(E);
        ctx.clearRect(0, 0, W, W);
        ctx.fillStyle = 'rgba(10,30,50,0.9)'; ctx.beginPath(); ctx.arc(c, c, R, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(0,255,204,0.5)'; ctx.lineWidth = 1.2; ctx.stroke();
        for (let d = 0; d < 360; d += 30) { const a = d * _mnvRad; ctx.beginPath(); ctx.moveTo(c + Math.sin(a) * R, c - Math.cos(a) * R); ctx.lineTo(c + Math.sin(a) * (R - (d % 90 ? 4 : 8)), c - Math.cos(a) * (R - (d % 90 ? 4 : 8))); ctx.stroke(); }
        ctx.fillStyle = '#8cc'; ctx.font = '8px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('前', c, 15); ctx.fillText('左', 11, c + 3); ctx.fillText('右', W - 11, c + 3);
        const needle = (az, col, w, len) => { const a = az * _mnvRad; ctx.strokeStyle = col; ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(c, c); ctx.lineTo(c - Math.sin(a) * len, c - Math.cos(a) * len); ctx.stroke(); };
        needle(P.cmd, 'rgba(255,214,90,0.9)', 2, R - 4);
        needle(P.az, '#00ffcc', 4, R - 12);
        const T = E.rpm * Math.abs(E.rpm);
        ctx.fillStyle = '#cfe'; ctx.font = '9px sans-serif'; ctx.fillText(`${Math.round(T * 100)}%`, c, c + R * 0.55);
    });
}
// ── ジョイスティック ──
function _mnvDrawPad() {
    const cv = document.getElementById('mnv-pad'); if (!cv) return;
    const ctx = cv.getContext('2d'), W = cv.width, c = W / 2, R = c * 0.85, J = maneuver.joy;
    ctx.clearRect(0, 0, W, W);
    ctx.fillStyle = 'rgba(10,30,50,0.9)'; ctx.beginPath(); ctx.arc(c, c, R + 4, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(0,255,204,0.35)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(c, c, R * 0.5, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(c - R, c); ctx.lineTo(c + R, c); ctx.moveTo(c, c - R); ctx.lineTo(c, c + R); ctx.stroke();
    ctx.fillStyle = '#8cc'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('前', c, 12); ctx.fillText('後', c, W - 4); ctx.fillText('左舷', 13, c - 4); ctx.fillText('右舷', W - 13, c - 4);
    // 回頭の指示（円弧）
    if (Math.abs(J.r) > 0.02) { ctx.strokeStyle = '#ffd65a'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(c, c, R + 1, -Math.PI / 2, -Math.PI / 2 + J.r * Math.PI * 0.5, J.r < 0); ctx.stroke(); }
    const kx = c + J.x * R, ky = c - J.y * R;
    ctx.fillStyle = '#00ffcc'; ctx.beginPath(); ctx.arc(kx, ky, 10, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#033'; ctx.lineWidth = 2; ctx.stroke();
}

// ── キー（押している間だけ全力）──
window.addEventListener('keydown', (e) => {
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    const k = e.key.toLowerCase();
    if (MNV_KEYS[k] && maneuver.thrusters.some(T => T._on !== false)) _mnv.keys[k] = true;
});
window.addEventListener('keyup', (e) => { const k = e.key.toLowerCase(); if (_mnv.keys[k]) _mnv.keys[k] = false; });
window.addEventListener('blur', () => { _mnv.keys = {}; });

// ════════════════════════════════════════════════════════════
//  船体設定（⚙ 推進器）
// ════════════════════════════════════════════════════════════
function renderManeuverSettings() {
    const el = document.getElementById('mnv-settings'); if (!el) return;
    const L = _mnvHL() * 2, est = thrusterDefaultKw();
    let h = `<div class="sp-section-title">サイドスラスター</div>
        <div style="font-size:10px;color:#888;margin-bottom:6px;">船体を横に貫くトンネルの中のスクリュー（バウスラスター・スターンスラスター）で、船首（船尾）を横へ押します。6ノットを超えるとほとんど効きません。
        推力は出力 1kW あたり約 120N。この船（全長 ${Math.round(L)}m）なら 1 基 ${est}kW ほどが目安です。
        読み込んだモデルに名前に "Thruster" / "スラスター" を含む部品があれば、それがスラスターになります（出力に合わせて回ります）。</div>`;
    const hp = window.hullProfile;
    maneuver.thrusters.forEach((T, i) => {
        if (T._on === false) return;
        const part = T.part ? _mnvPartOf(T) : null;
        const ph = (T.at || 0) >= 0 ? '船首スラスター' : '船尾スラスター';
        h += `<div class="sp-item-card"><div class="sp-item-header"><span class="sp-item-title">
                <input type="text" value="${(T.name || '').replace(/"/g, '&quot;')}" placeholder="${ph}" style="width:110px" onchange="maneuverSetConf(${i},'name',this.value)"></span>
                ${part ? '' : `<button class="sp-gizmo-btn" id="gizmo-thruster-${i}" onclick="toggleGizmo('thruster',${i})" title="ギズモで位置（前後・高さ）を動かす">📍 ギズモ</button>
                <button class="sp-del-btn" onclick="maneuverRemoveThruster(${i})">✕</button>`}</div>`;
        if (part) {
            h += `<div style="font-size:10px;color:#9ab;margin-bottom:4px;">モデルの部品「${part.name}」（位置は部品から。止める・スクリューとして扱うときは、上の「モデル内パーツ」で）</div>`;
        } else {
            h += `<div class="sp-row"><span class="sp-label">前後の位置:</span><input type="range" id="mnv-at-${i}" min="-100" max="100" value="${Math.round((T.at || 0) * 100)}" oninput="maneuverSetConf(${i},'at',this.value/100);this.nextElementSibling.textContent=(this.value>=0?'船首寄り ':'船尾寄り ')+Math.abs(this.value)+'%'"><span style="font-size:10px;color:#aef;width:80px">${(T.at || 0) >= 0 ? '船首寄り ' : '船尾寄り '}${Math.abs(Math.round((T.at || 0) * 100))}%</span></div>
            <div class="sp-row"><span class="sp-label">高さ:</span><input type="number" id="mnv-y-${i}" step="0.05" value="${Number.isFinite(T.y) ? T.y.toFixed(2) : ''}" placeholder="自動" style="width:70px" onchange="maneuverSetConf(${i},'y',this.value)">
                <button class="sp-add-btn" style="flex:none" onclick="maneuverSetConf(${i},'y','');renderManeuverSettings()" title="喫水線と船底の間で、船体の横腹に当たる高さ">自動</button></div>`;
        }
        h += `<div class="sp-row"><span class="sp-label">出力 kW:</span><input type="number" min="10" max="20000" step="10" value="${T.kW}" style="width:80px" onchange="maneuverSetConf(${i},'kW',this.value)">
                <span style="font-size:10px;color:#9ab">推力 約 ${(thrusterCapN(T) / 9806).toFixed(1)} t</span></div></div>`;
    });
    h += `<div class="sp-row" style="gap:4px;flex-wrap:wrap">
            <button class="sp-add-btn" onclick="maneuverAddThruster(0.86)">＋ バウスラスター（船首）</button>
            <button class="sp-add-btn" onclick="maneuverAddThruster(-0.82)">＋ スターンスラスター（船尾）</button>
            ${maneuver.thrusters.some(T => !T.part) ? `<button class="sp-add-btn" onclick="maneuverClearThrusters()">付け足したものをすべて外す</button>` : ''}</div>`;
    if (azipodActive()) {
        h += `<div class="sp-section-title" style="margin-top:10px">アジポッド</div>
            <div style="font-size:10px;color:#888;margin-bottom:6px;">推進器ごとの機関がポッドになり、360° 向きを変えられます。推力は機関の馬力 1 馬力あたり約 80N。
            画面の「操船」ボタンから、舵輪に連動・個別・ジョイスティック（方位保持・位置保持つき）を選べます。
            読み込んだモデルでは、名前に "Azipod" / "ポッド" を含む部品がポッドの向きに合わせて回ります。</div>
            <div class="sp-row"><span class="sp-label">向きを変える速さ:</span><input type="number" min="1" max="60" step="1" value="${maneuver.podRate}" style="width:60px" onchange="maneuver.podRate=Math.max(1,Math.min(60,+this.value||8))"> °/秒</div>`;
    }
    el.innerHTML = h;
}
window.renderManeuverSettings = renderManeuverSettings;
function maneuverAddThruster(at) {
    maneuver.thrusters.push({ name: '', at, kW: thrusterDefaultKw(), y: null, part: null });
    renderManeuverSettings(); renderManeuverPanel(); _mnvUpdateHudButton();
}
function _mnvGizmoOff() { if (typeof currentGizmoType !== 'undefined' && currentGizmoType === 'thruster' && typeof disableGizmo === 'function') disableGizmo(); }
// ギズモの目印を外す（i を省くと全部）。番号がずれるので、外したスラスターの分は詰める
function _mnvDropMarker(i) {
    const M = _mnv.markers || [];
    const drop = (m) => { if (m) { if (m.parent) m.parent.remove(m); m.geometry.dispose(); m.material.dispose(); } };
    if (i === undefined) { M.forEach(drop); _mnv.markers = []; return; }
    drop(M[i]); M.splice(i, 1);
}
function maneuverRemoveThruster(i) {
    _mnvGizmoOff();
    maneuver.thrusters.splice(i, 1); _mnv.th.splice(i, 1); _mnvDropMarker(i);
    renderManeuverSettings(); renderManeuverPanel(); _mnvUpdateHudButton();
}
function maneuverClearThrusters() {
    _mnvGizmoOff();
    for (let i = maneuver.thrusters.length - 1; i >= 0; i--) if (!maneuver.thrusters[i].part) { maneuver.thrusters.splice(i, 1); _mnv.th.splice(i, 1); _mnvDropMarker(i); }
    renderManeuverSettings(); renderManeuverPanel(); _mnvUpdateHudButton();
}
function maneuverSetConf(i, k, v) {
    const T = maneuver.thrusters[i]; if (!T) return;
    if (k === 'name') T.name = String(v || '').slice(0, 30);
    else if (k === 'at') T.at = Math.max(-1, Math.min(1, +v || 0));
    else if (k === 'kW') { T.kW = Math.max(10, Math.min(20000, +v || 0)); renderManeuverSettings(); }
    else if (k === 'y') T.y = (v === '' || v === null || !Number.isFinite(+v)) ? null : +v;
    _mnvPlaceMarker(i);
    renderManeuverPanel();
}
// ── ギズモ（10-ship-editor-propulsors.js の toggleGizmo / onGizmoChange）：目印を動かすと前後の位置・高さが変わる ──
function _mnvPlaceMarker(i) {
    const m = (_mnv.markers || [])[i], T = maneuver.thrusters[i];
    if (!m || !T || T.part) return;
    const G = _mnvThrusterGeom(T);
    if (G) m.position.set(0, G.y, G.z);
}
function _mnvMarker(i) {
    const T = maneuver.thrusters[i];
    if (!T || T.part || typeof shipGroup === 'undefined' || !shipGroup) return null;
    _mnv.markers = _mnv.markers || [];
    let m = _mnv.markers[i];
    if (!m) {
        const sc = physics.scale || 1;
        m = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffd65a, depthTest: false, transparent: true, opacity: 0.85 }));
        m.scale.setScalar(Math.max(0.3, 1.2 / sc));
        m.renderOrder = 999; m.visible = false;
        m.userData.noBloom = true; m.userData.noLightBake = true; m.userData.isThrusterMarker = true;
        _mnv.markers[i] = m;
    }
    // 目印は船体の向きの面（回した入れ物）の中に置く。ギズモの前後＝船の長さの向き
    if (!_mnv.mHolder) { _mnv.mHolder = new THREE.Group(); _mnv.mHolder.name = 'ThrusterMarkers'; }
    if (_mnv.mHolder.parent !== shipGroup) shipGroup.add(_mnv.mHolder);
    _mnv.mHolder.rotation.y = _mnvFrameA();
    if (m.parent !== _mnv.mHolder) _mnv.mHolder.add(m);
    _mnvPlaceMarker(i);
    return m;
}
{
    const prevT = window.getExtraGizmoTarget, prevC = window.onExtraGizmoChange;
    window.getExtraGizmoTarget = function (type, index) {
        if (type === 'thruster') { const m = _mnvMarker(index); return m ? { mesh: m, btnId: `gizmo-thruster-${index}` } : null; }
        return typeof prevT === 'function' ? prevT(type, index) : null;
    };
    window.onExtraGizmoChange = function (type, index, target) {
        if (type === 'thruster') {
            const T = maneuver.thrusters[index]; if (!T) return true;
            const hp = window.hullProfile, half = (hp && hp.ready) ? hp.halfLen : 6;
            target.position.x = 0;                       // トンネルは船の真ん中を横に貫く
            T.at = Math.max(-1, Math.min(1, target.position.z / half * _mnvBowSign()));
            T.at = +T.at.toFixed(3);
            T.y = Math.round(target.position.y * 1000) / 1000;
            const a = document.getElementById('mnv-at-' + index);
            if (a) { a.value = Math.round(T.at * 100); if (a.nextElementSibling) a.nextElementSibling.textContent = (T.at >= 0 ? '船首寄り ' : '船尾寄り ') + Math.abs(Math.round(T.at * 100)) + '%'; }
            const y = document.getElementById('mnv-y-' + index); if (y) y.value = T.y.toFixed(2);
            return true;
        }
        return typeof prevC === 'function' ? prevC(type, index, target) : false;
    };
}
Object.assign(window, { maneuverAddThruster, maneuverRemoveThruster, maneuverClearThrusters, maneuverSetConf });

// ── 保存・読み込み（13-save-load-config.js）──
function getManeuverConfig() {
    // モデルの部品のスラスターは、今のモデルにその部品があるものだけ（モデルがまだ無いときは全部）
    const haveParts = typeof glbMovableParts !== 'undefined' && glbMovableParts && glbMovableParts.length > 0;
    const keep = (T) => !T.part || !haveParts || glbMovableParts.some(p => p.name === T.part);
    return { thrusters: maneuver.thrusters.filter(keep).map(T => ({ name: T.name || '', at: +(+T.at || 0).toFixed(3), kW: +T.kW || 0, y: Number.isFinite(T.y) ? T.y : null, part: T.part || null })), podMode: maneuver.podMode, podRate: maneuver.podRate };
}
function applyManeuverConfig(c) {
    _mnvGizmoOff(); _mnvDropMarker();
    maneuver.thrusters = (c && Array.isArray(c.thrusters)) ? c.thrusters.map(T => ({ name: String(T.name || ''), at: Math.max(-1, Math.min(1, +T.at || 0)), kW: Math.max(10, +T.kW || 100),
        y: (T.y !== null && T.y !== undefined && Number.isFinite(+T.y)) ? +T.y : null, part: T.part ? String(T.part) : null })) : [];
    _mnv.th.length = 0;
    _mnv.syncT = 0;
    maneuver.podMode = (c && ['helm', 'indep', 'joy'].includes(c.podMode)) ? c.podMode : 'helm';
    maneuver.podRate = (c && +c.podRate > 0) ? +c.podRate : 8;
    _mnv.pods.clear(); _mnv.visKey = '';
    renderManeuverSettings(); renderManeuverPanel(); _mnvUpdateHudButton();
}
window.getManeuverConfig = getManeuverConfig; window.applyManeuverConfig = applyManeuverConfig;

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(_mnvSetup, 300));
else setTimeout(_mnvSetup, 300);
