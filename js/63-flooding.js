// ════════════════════════════════════════════════════════════════
//  浸水（区画ごとの水の量で、船が沈み・傾く）
// ════════════════════════════════════════════════════════════════
//  62-watertight.js の隔壁で仕切った区画（と二重底のタンク）ごとに、水位ごとの容積・水の重心・
//  自由水面の広さを、船体の形（22-hull-shape.js）から前もって積分しておく。
//  船体の穴（魚雷・砲弾・衝突・座礁：64-damage.js）から入る水は、外の水面と中の水面の差 h で
//    Q = 0.6 × 穴の面積 × √(2gh)
//  隔壁の上の縁を越えた水は、となりの区画へあふれる（堰の式 Q = 0.42 × 幅 × √(2g) × h^1.5）。
//  中の水面は、外の水面と同じく水平（世界の上下）なので、船首が下がれば船に対して傾き、
//  船首の区画の水は後ろの隔壁の上を越えやすくなる（タイタニックのように）。主甲板が水に入った
//  区画には、上から（ハッチ・階段などから）水が入る。
//  入った水の重さは 17-main-loop.js の上下動の重さ・縦揺れのモーメントに足し、左右の偏りは
//  横傾斜（GM と自由水面の影響から求めた傾き）にする。浸水しているときは、主甲板より上の船体は
//  浮力にならない（18-hull-wake-physics.js）。予備浮力より多く水が入れば沈む。

const FL_RHO = 1025, FL_G = 9.81, FL_CD = 0.6, FL_CW = 0.42;
const FL_PUMP = 0.5;          // 排水ポンプの能力[m³/秒]（全部で。タイタニックで 1 時間に 1,700 トンほど）
const flood = {
    comps: [], links: [], holes: [], dirty: true, key: '',
    pump: false, view: false,
    massKg: 0, torqueP: 0, rollBias: 0, heel: 0, deckCap: false,
    reserveKg: 0, GM0: 1, B: 20,
    sinking: false, sunk: false, msg: '', msgT: 0, rev: 0, shown: false,
};
window.flood = flood;
function floodLayoutChanged() { flood.dirty = true; }
window.floodLayoutChanged = floodLayoutChanged;
function _flMsg(s) { flood.msg = s; flood.msgT = 10; if (typeof _flPanelRender === 'function') _flPanelRender(); }

// ── 区画の表（水位ごとの容積など：模型の座標）──
// 前後 a0〜a1・左右（舷側の割合）fLo〜fHi・高さ y0〜y1 の中の、船体の中の部分
function _flSlice(c, D, y) {
    let A = 0, Sx = 0, Sa = 0, Ixx = 0;
    const na = c.na, da = (c.a1 - c.a0) / na;
    for (let i = 0; i < na; i++) {
        const a = c.a0 + (i + 0.5) * da;
        const hw = wtHW(y, a); if (!(hw > 0)) continue;
        let xl = -hw, xh = hw;
        if (c.fLo !== -Infinity || c.fHi !== Infinity) {
            const ref = wtHWRef(D, a);
            if (c.fLo !== -Infinity) xl = Math.max(xl, c.fLo * ref);
            if (c.fHi !== Infinity) xh = Math.min(xh, c.fHi * ref);
        }
        const w = xh - xl; if (!(w > 0)) continue;
        const xm = (xl + xh) / 2;
        A += w * da; Sx += w * xm * da; Sa += w * a * da; Ixx += (w * w * w / 12 + w * xm * xm) * da;
    }
    return { A, Sx, Sa, Ixx };
}
function _flTable(c, D, dA, NY) {
    c.na = Math.max(4, Math.ceil((c.a1 - c.a0) / dA));
    const n = NY;
    c.Y = new Float64Array(n + 1); c.V = new Float64Array(n + 1); c.MX = new Float64Array(n + 1); c.MA = new Float64Array(n + 1);
    c.MY = new Float64Array(n + 1); c.IX = new Float64Array(n + 1); c.AW = new Float64Array(n + 1);
    let prev = _flSlice(c, D, c.y0);
    c.Y[0] = c.y0; c.AW[0] = prev.A; c.IX[0] = prev.A > 0 ? prev.Ixx - prev.Sx * prev.Sx / prev.A : 0;
    for (let k = 1; k <= n; k++) {
        const y = c.y0 + (c.y1 - c.y0) * k / n, cur = _flSlice(c, D, y), dy = y - c.Y[k - 1];
        c.Y[k] = y;
        c.V[k] = c.V[k - 1] + (prev.A + cur.A) / 2 * dy;
        c.MX[k] = c.MX[k - 1] + (prev.Sx + cur.Sx) / 2 * dy;
        c.MA[k] = c.MA[k - 1] + (prev.Sa + cur.Sa) / 2 * dy;
        c.MY[k] = c.MY[k - 1] + (prev.A * c.Y[k - 1] + cur.A * y) / 2 * dy;
        c.AW[k] = cur.A; c.IX[k] = cur.A > 0 ? cur.Ixx - cur.Sx * cur.Sx / cur.A : 0;
        prev = cur;
    }
    // 空のときの基準（底の水面の重心）
    let k1 = 1; while (k1 < n && !(c.V[k1] > 0)) k1++;
    c.x0 = c.V[k1] > 0 ? c.MX[k1] / c.V[k1] : 0;
    c.am = c.V[k1] > 0 ? c.MA[k1] / c.V[k1] : (c.a0 + c.a1) / 2;
    // 主甲板の所の、左右の真ん中
    const top = _flSlice(c, D, c.y1);
    c.pTop = top.A > 0 ? top.Sx / top.A : c.x0;
    c.deckA = top.A;
    c.vol = 0;
    return c;
}
// 今の水の量での水位・重心（模型の座標）・自由水面
function _flState(c, sc3) {
    const st = c.st || (c.st = {});
    const v = c.vol / sc3, V = c.V, n = V.length - 1;
    if (!(v > 0)) { st.y = c.Y[0]; st.x = c.x0; st.a = c.am; st.yc = c.Y[0]; st.ix = 0; st.aw = c.AW[0] || c.AW[1]; return st; }
    if (v >= V[n]) { st.y = c.Y[n]; st.x = c.MX[n] / V[n]; st.a = c.MA[n] / V[n]; st.yc = c.MY[n] / V[n]; st.ix = 0; st.aw = c.AW[n]; return st; }
    let lo = 0, hi = n;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (V[m] <= v) lo = m; else hi = m; }
    const f = (v - V[lo]) / ((V[hi] - V[lo]) || 1);
    const L = (A) => A[lo] + (A[hi] - A[lo]) * f;
    st.y = L(c.Y); st.x = L(c.MX) / v; st.a = L(c.MA) / v; st.yc = L(c.MY) / v; st.ix = L(c.IX); st.aw = L(c.AW);
    return st;
}
// 前後 a・高さ y での、左右の範囲 lo〜hi（舷側の割合）の中の幅と、その真ん中
function _flWidthAt(D, a, y, lo, hi) {
    const hw = wtHW(y, a), ref = wtHWRef(D, a);
    const xl = Math.max(-hw, lo === -Infinity ? -Infinity : lo * ref), xh = Math.min(hw, hi === Infinity ? Infinity : hi * ref);
    return { b: Math.max(0, xh - xl), pm: (xl + xh) / 2 };
}
function _flKey() {
    const Lay = typeof wtLayout === 'function' ? wtLayout() : null;
    if (!Lay) return '';
    return JSON.stringify([Lay.cuts.map(v => +v.toFixed(4)), shipWT.th, shipWT.lx, shipWT.lh, shipWT.sA, shipWT.sB, shipWT.lN, shipWT.db, physics.scale, Lay.D.yDeck, Lay.D.yBot]);
}
function _flBuild() {
    flood.dirty = false;
    const Lay = typeof wtLayout === 'function' ? wtLayout() : null;
    flood.comps = []; flood.links = [];
    flood.key = _flKey();
    if (!Lay) return false;
    const D = Lay.D, sc = physics.scale || 1;
    flood.D = D;
    const yIB = D.yBot + (shipWT.db || 0) / sc;
    const dA = (D.aB - D.aS) / 160;
    const nSec = Lay.n + 1;
    const parts = (s) => (Lay.lN && s >= Lay.sA && s <= Lay.sB) ? Lay.lN + 1 : 1;
    const fOf = (s, p) => parts(s) === 1 ? [-Infinity, Infinity] : [p === 0 ? -Infinity : Lay.lx[p - 1], p === Lay.lN ? Infinity : Lay.lx[p]];
    const first = [];
    for (let s = 0; s < nSec; s++) {
        first[s] = flood.comps.length;
        for (let p = 0; p < parts(s); p++) {
            const [fLo, fHi] = fOf(s, p);
            flood.comps.push(_flTable({ kind: 'c', s, p, np: parts(s), a0: Lay.cuts[s], a1: Lay.cuts[s + 1], fLo, fHi, y0: yIB, y1: D.yDeck }, D, dA, 24));
        }
    }
    flood.nMain = flood.comps.length;
    // 二重底のタンク（区画ごと・左右いっぱい）
    flood.dbFirst = flood.comps.length;
    if (shipWT.db > 0) for (let s = 0; s < nSec; s++) flood.comps.push(_flTable({ kind: 'db', s, p: 0, np: 1, a0: Lay.cuts[s], a1: Lay.cuts[s + 1], fLo: -Infinity, fHi: Infinity, y0: D.yBot, y1: yIB }, D, dA, 6));
    // つながり：横隔壁の上の縁（前後のとなり）
    for (let j = 0; j < Lay.n; j++) {
        const a = Lay.cuts[j + 1], yTop = D.yBot + D.H * shipWT.th[j];
        const pa = parts(j), pb = parts(j + 1);
        for (let p = 0; p < pa; p++) for (let q = 0; q < pb; q++) {
            if (pa === pb && p !== q) continue;
            const [f1, f2] = fOf(j, p), [g1, g2] = fOf(j + 1, q);
            const w = _flWidthAt(D, a, Math.min(yTop, D.yDeck), Math.max(f1, g1), Math.min(f2, g2));
            if (!(w.b > 0)) continue;
            flood.links.push({ i: first[j] + p, j: first[j + 1] + q, a, y: yTop, p: w.pm, b: w.b * sc, kind: 't', k: j });
        }
    }
    // 縦隔壁の上の縁（左右のとなり）
    for (let s = 0; s < nSec; s++) {
        if (parts(s) === 1) continue;
        const a0 = Lay.cuts[s], a1 = Lay.cuts[s + 1], am = (a0 + a1) / 2, yTop = D.yBot + D.H * shipWT.lh;
        for (let p = 0; p < Lay.lN; p++) flood.links.push({ i: first[s] + p, j: first[s] + p + 1, a: am, y: yTop, p: Lay.lx[p] * wtHWRef(D, am), b: (a1 - a0) * sc, kind: 'l', k: p });
    }
    // 予備浮力（主甲板までの船体の容積 − 排水量）・GM
    _flStatics(D);
    _flVmax();
    // 穴は、新しい区画に付け直す（水は抜く）
    for (const h of flood.holes) _flAssign(h);
    flood.rev++;
    return true;
}
// 船の重さ・形から：主甲板までの容積（予備浮力）・GM（横の安定）・幅
function _flStatics(D) {
    const sc = physics.scale || 1, sc3 = sc * sc * sc;
    const NA = 120, NY = 24, da = (D.aB - D.aS) / NA;
    let Vdeck = 0, Vwl = 0, Mwl = 0, IT = 0, B = 0;
    for (let i = 0; i < NA; i++) {
        const a = D.aS + (i + 0.5) * da;
        for (let k = 0; k < NY; k++) {
            const y = D.yBot + (k + 0.5) * D.H / NY, w = 2 * wtHW(y, a), dv = w * da * D.H / NY;
            Vdeck += dv;
            if (y < D.yWL) { Vwl += dv; Mwl += dv * y; }
        }
        const hw = wtHW(D.yWL, a);
        IT += 2 / 3 * hw * hw * hw * da;
        B = Math.max(B, 2 * hw);
    }
    const disp = Math.max(1, physics.mass * 1e6);
    flood.reserveKg = Math.max(0, Vdeck * sc3 * FL_RHO - disp);
    flood.B = Math.max(1, B * sc);
    // 船の重さ（排水量）に合う BM（模型の喫水線と重さが合っていなくても、浮いている水の量で割る）
    const vol = disp / FL_RHO;
    const KB = Vwl > 0 ? (Mwl / Vwl - D.yBot) * sc : (D.yWL - D.yBot) * sc * 0.53;
    const BM = IT * Math.pow(sc, 4) / vol;
    const KG = ((physics.cgOffset ? physics.cgOffset.y : 0) - D.yBot) * sc;
    flood.BM = BM;
    flood.GM0 = Math.max(0.03 * flood.B, Math.min(0.5 * flood.B, KB + BM - KG));
    flood.sKey = physics.mass + '|' + (physics.cgOffset ? physics.cgOffset.y : 0);
}
// 穴の区画：前後 a・左右 p・高さ y（模型の座標）
function _flCompAt(a, p, y, dbOnly) {
    const D = flood.D; if (!D || !flood.comps.length) return -1;
    if (dbOnly) {
        for (let i = flood.dbFirst; i < flood.comps.length; i++) { const c = flood.comps[i]; if (a >= c.a0 && a <= c.a1) return i; }
        return -1;
    }
    let best = -1;
    for (let i = 0; i < flood.nMain; i++) {
        const c = flood.comps[i];
        if (a < c.a0 - 1e-6 || a > c.a1 + 1e-6) continue;
        if (c.np === 1) return i;
        const ref = wtHWRef(D, a), f = ref > 0 ? p / ref : 0;
        if (f >= c.fLo && f <= c.fHi) return i;
        best = i;
    }
    if (best >= 0) return best;
    // 船の端より外：いちばん近い区画
    return a < D.aS ? 0 : flood.nMain - 1 - (flood.comps[flood.nMain - 1] ? flood.comps[flood.nMain - 1].np - 1 : 0);
}
// 穴を区画に付ける：二重底の高さより下の穴は、二重底のタンクへ。内底板まで破れていれば、上の区画へも
function _flAssign(h) {
    const D = flood.D; if (!D) { h.c = -1; h.c2 = -1; return; }
    const sc = physics.scale || 1, yIB = D.yBot + (shipWT.db || 0) / sc;
    h.c2 = -1;
    if (shipWT.db > 0 && h.y < yIB) {
        h.c = _flCompAt(h.a, h.p, h.y, true);
        if (h.inner) h.c2 = _flCompAt(h.a, h.p, yIB + 0.01, false);
    } else h.c = _flCompAt(h.a, h.p, h.y, false);
}

// ── 穴（64-damage.js から）──
//  a・p・y：模型の座標（船体の座標）、area[m²]、kind：'torpedo'|'shell'|'collision'|'ground'|'test'、
//  inner：二重底の内底板まで破れたか
function floodAddHole(a, p, y, area, kind, inner) {
    if (flood.dirty || _flKey() !== flood.key) _flBuild();
    const h = { a, p, y, A: Math.max(0.01, area), kind: kind || 'test', inner: !!inner, t: (typeof performance !== 'undefined' ? performance.now() : 0), plug: 0 };
    _flAssign(h);
    flood.holes.push(h);
    flood.shown = true;
    flood.rev++;
    if (typeof _flPanelRender === 'function') _flPanelRender(true);
    return h;
}
window.floodAddHole = floodAddHole;

// ── 毎フレーム ──
const _flE = { e: null };
function _flWY(e, p, y, a) { return e[1] * p + e[5] * y + e[9] * a + e[13]; }
function _flWX(e, p, y, a) { return e[0] * p + e[4] * y + e[8] * a + e[12]; }
function _flWZ(e, p, y, a) { return e[2] * p + e[6] * y + e[10] * a + e[14]; }
function _flOut(e, p, y, a, t) {
    const x = _flWX(e, p, y, a), z = _flWZ(e, p, y, a);
    return typeof getWaveHeight === 'function' ? getWaveHeight(x, z, t, true) : 0;
}
function updateFlooding(t, dt) {
    let any = flood.holes.length > 0;
    if (!any) for (const c of flood.comps) if (c.vol > 0) { any = true; break; }
    if (!any) { flood.massKg = 0; flood.torqueP = 0; flood.rollBias = 0; flood.deckCap = false; window._wtDeckCap = false; _flVisual(false); return; }
    if (flood.dirty || _flKey() !== flood.key) {
        // 区画の並びが変わった：水は抜いて、穴を付け直す
        _flBuild();
    }
    const root = typeof wtRoot === 'function' ? wtRoot() : null;
    if (!root || !flood.comps.length) return;
    // 船の重さ・重心を変えたら、予備浮力・GM を計り直す
    const sKey = physics.mass + '|' + (physics.cgOffset ? physics.cgOffset.y : 0);
    if (sKey !== flood.sKey) { flood.sKey = sKey; _flStatics(flood.D); }
    const e = root.matrixWorld.elements, sc = physics.scale || 1, sc2 = sc * sc, sc3 = sc2 * sc;
    dt = Math.max(0, Math.min(30, dt || 0));
    if (dt > 0) {
        // 主甲板から上で水が入る所（甲板が水面の近くの区画だけ、外の水面を測る）
        const wl0 = Number.isFinite(window._physicsWaveY) ? window._physicsWaveY : 0;
        for (let i = 0; i < flood.nMain; i++) {
            const c = flood.comps[i];
            const yd = _flWY(e, c.pTop, c.y1, c.am);
            c.deckOut = yd < wl0 + 4 ? _flOut(e, c.pTop, c.y1, c.am, t) : -Infinity;
            c.deckY = yd;
        }
        for (const h of flood.holes) h.out = _flOut(e, h.p, h.y, h.a, t);
        const n = Math.min(60, Math.max(1, Math.ceil(dt / 0.25))), hdt = dt / n;
        for (let it = 0; it < n; it++) {
            for (const c of flood.comps) { const st = _flState(c, sc3); c.Yw = _flWY(e, st.x, st.y, st.a); c.dv = 0; }
            // 穴
            for (const h of flood.holes) {
                const yw = _flWY(e, h.p, h.y, h.a), A = h.A * (1 - (h.plug || 0));
                if (!(A > 0)) continue;
                for (const ci of [h.c, h.c2]) {
                    const c = flood.comps[ci]; if (!c) continue;
                    const top = Math.max(yw, c.Yw);
                    if (h.out > top) c.dv += FL_CD * A * Math.sqrt(2 * FL_G * (h.out - top)) * hdt;
                    else if (c.vol > 0 && c.Yw > Math.max(yw, h.out)) c.dv -= FL_CD * A * Math.sqrt(2 * FL_G * (c.Yw - Math.max(yw, h.out))) * hdt;
                }
            }
            // 隔壁の上を越えて、となりへ
            for (const L of flood.links) {
                const A = flood.comps[L.i], B = flood.comps[L.j];
                const yt = _flWY(e, L.p, L.y, L.a);
                const H = A.Yw >= B.Yw ? A : B, Lo = H === A ? B : A;
                if (!(H.Yw > yt) || !(H.vol > 0)) continue;
                const h1 = H.Yw - yt, h2 = Math.max(0, Lo.Yw - yt);
                let q = FL_CW * L.b * Math.sqrt(2 * FL_G) * (Math.pow(h1, 1.5) - Math.pow(h2, 1.5)) * hdt;
                const aH = Math.max(1, H.st.aw * sc2), aL = Math.max(1, Lo.st.aw * sc2);
                q = Math.max(0, Math.min(q, (H.Yw - Lo.Yw) * aH * aL / (aH + aL), H.vol + H.dv, Lo.vmax - Lo.vol - Lo.dv));
                H.dv -= q; Lo.dv += q;
            }
            // 主甲板が水に入った区画：上から
            for (let i = 0; i < flood.nMain; i++) {
                const c = flood.comps[i];
                if (!(c.deckOut > c.deckY)) continue;
                const top = Math.max(c.deckY, c.Yw);
                if (c.deckOut > top) c.dv += FL_CD * Math.max(2, c.deckA * sc2 * 0.03) * Math.sqrt(2 * FL_G * (c.deckOut - top)) * hdt;
            }
            // 排水ポンプ：水の多い区画から
            if (flood.pump) {
                let cap = FL_PUMP * hdt;
                const list = flood.comps.filter(c => c.vol + c.dv > 0).sort((x, y) => (y.vol + y.dv) - (x.vol + x.dv));
                for (const c of list) { const q = Math.min(cap, c.vol + c.dv); c.dv -= q; cap -= q; if (cap <= 0) break; }
            }
            for (const c of flood.comps) c.vol = Math.max(0, Math.min(c.vmax, c.vol + c.dv));
        }
    }
    _flTotals(e, sc);
    flood.noEqT = flood.noEq && !flood.sunk ? (flood.noEqT || 0) + dt : 0;
    _flSinkCheck(e, t);
    _flVisual(true);
    if (flood.msgT > 0) flood.msgT -= dt;
    _flPanelTick();
}
window.updateFlooding = updateFlooding;
// 区画の容積（m³）
function _flVmax() { const sc = physics.scale || 1, sc3 = sc * sc * sc; for (const c of flood.comps) c.vmax = c.V[c.V.length - 1] * sc3; }
// 水の重さ・重心から、上下動の重さ・縦揺れのモーメント・横傾斜（17-main-loop.js が使う）
function _flTotals(e, sc) {
    const sc3 = sc * sc * sc, sc4 = sc3 * sc;
    let m = 0, mx = 0, ma = 0, my = 0;
    const fs = [];
    for (const c of flood.comps) {
        if (!(c.vol > 0)) continue;
        const st = _flState(c, sc3), mm = c.vol * FL_RHO;
        m += mm; mx += mm * st.x; ma += mm * st.a; my += mm * st.yc;
        // 自由水面（満水の区画には無い）：傾いた側へ水が寄る。寄れる量は区画の幅で決まる（少しの水なら少し）
        const fill = c.vol / c.vmax;
        if (fill < 0.985 && st.ix > 0) {
            const len = Math.max(1e-6, c.a1 - c.a0), b = st.aw / len * sc;
            // （二重底は、中心線の桁と左右の側桁で幅の方向に 3 つほどに仕切られているので、水が寄る分は 1/9・寄れる量は 1/3）
            const kd = c.kind === 'db' ? 1 / 3 : 1;
            fs.push({ i: st.ix * sc4 * kd * kd, cap: c.vol * 0.3 * b * kd * Math.min(1, 4 * (1 - fill)) });
        }
    }
    flood.massKg = m;
    flood.deckCap = m > 0;
    window._wtDeckCap = flood.deckCap;
    if (!(m > 0)) { flood.torqueP = 0; flood.rollBias = 0; flood.heel = 0; return; }
    const D = flood.D;
    const al = typeof wtAlpha === 'function' ? wtAlpha() : 0;
    const cg = physics.cgOffset || { x: 0, y: 0, z: 0 };
    const cgA = cg.x * Math.sin(al) + cg.z * Math.cos(al), cgP = cg.x * Math.cos(al) - cg.z * Math.sin(al);
    const ca = ma / m, cx = mx / m, cy = my / m;
    flood.ca = ca; flood.cx = cx; flood.cy = cy;
    // 縦：船首寄りの水は船首を下げる（＋）
    flood.torqueP = m * FL_G * (ca - cgA) * sc;
    // 横：左舷寄りの水は左舷へ傾ける。低い所に入った水は重心を下げて GM を増やす
    const disp0 = Math.max(1, physics.mass * 1e6), disp = disp0 + m;
    const KG0 = ((cg.y || 0) - D.yBot) * sc, hW = (cy - D.yBot) * sc;
    const GM = flood.GM0 + m / disp * (KG0 - hW);
    const Mh = m * FL_G * (cx - cgP) * sc;
    let ifs = 0; for (const f of fs) ifs += f.i;
    flood.GMe = GM - FL_RHO * ifs / disp;
    // 甲板の縁が水に入る角度（船の真ん中の、甲板の高さと水面の差から）。そこから先は復原力が落ちていく
    const wl0 = Number.isFinite(window._physicsWaveY) ? window._physicsWaveY : 0;
    const fb = Math.max(0.3, _flWY(e, 0, D.yDeck, (D.aS + D.aB) / 2) - wl0);
    flood.phiDeck = Math.atan(fb / Math.max(1, flood.B / 2));
    const phi = _flHeel(Mh, disp, GM, flood.BM, fs, flood.phiDeck);
    flood.heel = phi;
    flood.noEq = Math.abs(phi) >= 0.749;              // 43° まで傾いても起こせない（転覆する：_flSinkCheck）
    // 17-main-loop.js のロール：＋は左舷が上がる向き。左舷へ傾ける（左舷が下がる）のは −
    flood.rollBias = -phi;
    // 転覆した：横倒しを越えて、裏返るところまで回る（傾きの限界は設けていない：17-main-loop.js）
    if (flood.capsized) flood.rollBias = flood.capsized * 2.6;
}
// 横傾斜のつり合い：船を起こすモーメント Δ·g·GZ(φ)（GZ ＝ sinφ·(GM ＋ BM·tan²φ／2)：舷側が立った船）と、
// 傾けるモーメント（水の重心の偏り ＋ 自由水面の水が傾いた側へ寄る分。寄れる量には上限）が等しくなる角度 φ（左舷へ＋）。
// まっすぐで復原力が足りなければ、傾いた方へ（ロール角）。0.75rad まで起こせなければ転覆
//（甲板の縁が水に入る角度 phD から先は、舷側が立った船の式は使えない：起こす力は、そこから 1rad 先で無くなるまで落ちていく）
function _flHeel(Mh, disp, GM, BM, fs, phD) {
    const HM = (ph) => { const t = Math.abs(Math.tan(ph)), sg = ph < 0 ? -1 : 1; let v = Mh * Math.cos(ph); for (const f of fs) v += sg * FL_RHO * FL_G * Math.min(f.i * t, f.cap); return v; };
    const ws = (ph) => { const t = Math.tan(ph); return disp * FL_G * Math.sin(ph) * (GM + Math.max(0, BM) * t * t / 2); };
    const pd = Number.isFinite(phD) ? Math.max(0.05, phD) : 9;
    const RM = (ph) => Math.abs(ph) <= pd ? ws(ph) : ws(Math.sign(ph) * pd) * Math.max(0, 1 - (Math.abs(ph) - pd) / 1.0);
    const s = Math.abs(Mh) > disp * FL_G * 1e-5 ? Math.sign(Mh) : (physics.roll > 0 ? -1 : 1);
    for (let k = 1; k <= 75; k++) {
        const ph = s * k * 0.01;
        if (s * (RM(ph) - HM(ph)) >= 0) {
            let lo = s * (k - 1) * 0.01, hi = ph;
            for (let it = 0; it < 14; it++) { const mid = (lo + hi) / 2; if (s * (RM(mid) - HM(mid)) >= 0) hi = mid; else lo = mid; }
            return (lo + hi) / 2;
        }
    }
    return s * 0.75;
}
// 沈む・沈んだ
function _flSinkCheck(e, t) {
    const D = flood.D; if (!D) return;
    if (!flood.sinking && flood.massKg > flood.reserveKg * 0.97 && flood.reserveKg > 0) {
        flood.sinking = true;
        _flMsg('浸水が予備浮力を超えました。船は沈みます。');
    }
    if (flood.sunk) return;
    // 傾いた側へ寄った水を起こせない（つり合う角度が無い）まま 60 秒：転覆
    //（区画に入りかけの水が寄って一時的に起こせなくなっても、区画が満ちれば戻ることが多いので、少し待つ）
    if (flood.noEqT > 60) {
        flood.sunk = true; flood.capsized = Math.sign(physics.roll) || Math.sign(flood.rollBias) || 1;
        _flMsg('傾きを起こせず、船は転覆しました。');
        if (typeof setTelegraphOrder === 'function') try { setTelegraphOrder(0); } catch (err) { /* */ }
        physics.targetSpeed = 0;
        return;
    }
    // 主甲板（前・中・後ろ）がすべて水の下に 3m 以上
    let under = 0;
    for (const f of [0.15, 0.5, 0.85]) {
        const a = D.aS + (D.aB - D.aS) * f, yd = _flWY(e, 0, D.yDeck, a);
        if (_flOut(e, 0, D.yDeck, a, t) - yd > 3) under++;
    }
    if (under === 3 || (Math.abs(physics.roll) > 0.74 && flood.massKg > flood.reserveKg * 0.5)) {
        flood.sunk = true;
        if (Math.abs(physics.roll) > 0.74) flood.capsized = Math.sign(physics.roll);
        _flMsg(Math.abs(physics.roll) > 0.74 ? '船は転覆して沈みました。' : '船は沈没しました。');
        if (typeof setTelegraphOrder === 'function') try { setTelegraphOrder(0); } catch (err) { /* */ }
        physics.targetSpeed = 0;
    }
}

// ── 船の中の水を透かして見せる（62-watertight.js の隔壁と同じグループに）──
let _flWaterMat = null;
function floodView() { return !!flood.view && flood.holes.length > 0; }
window.floodView = floodView;
function _flVisual(on) {
    const root = typeof wtRoot === 'function' ? wtRoot() : null;
    if (!root) return;
    if (!flood.wGroup) { flood.wGroup = new THREE.Group(); flood.wGroup.name = 'flood-water'; }
    if (flood.wGroup.parent !== root) root.add(flood.wGroup);
    const tab = (() => { const sp = document.getElementById('settings-panel'); const tb = document.querySelector('.settings-tab.active'); return !!(sp && sp.classList.contains('open') && tb && tb.dataset.tab === 'bulkheads'); })();
    const show = on && (flood.view || tab || !!shipWT.show);
    flood.wGroup.visible = show;
    if (!show) return;
    const now = performance.now();
    if (now - (flood.wT || 0) < 250 && flood.wRev === flood.rev) return;
    flood.wT = now; flood.wRev = flood.rev;
    if (!_flWaterMat) { _flWaterMat = new THREE.MeshBasicMaterial({ color: 0x1e7bff, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthTest: false, depthWrite: false }); _flWaterMat.toneMapped = false; }
    for (const m of flood.wGroup.children.slice()) { flood.wGroup.remove(m); m.geometry.dispose(); }
    const D = flood.D, sc = physics.scale || 1, sc3 = sc * sc * sc;
    for (const c of flood.comps) {
        if (!(c.vol > c.vmax * 0.002)) continue;
        const st = _flState(c, sc3), y = st.y;
        // 水面（その高さでの区画の中）と、まわりの壁の水に入った部分（下の縁は区画の底）
        const NA = Math.max(3, Math.min(16, c.na)), pos = [], idx = [];
        for (let i = 0; i <= NA; i++) {
            const a = c.a0 + (c.a1 - c.a0) * i / NA, w = _flWidthAt(D, a, y, c.fLo, c.fHi);
            const xl = w.pm - w.b / 2, xh = w.pm + w.b / 2;
            pos.push(xl, y, a, xh, y, a, xl, c.y0, a, xh, c.y0, a);
        }
        for (let i = 0; i < NA; i++) {
            const q = i * 4, r = q + 4;
            idx.push(q, q + 1, r + 1, q, r + 1, r);               // 水面
            idx.push(q, r, r + 2, q, r + 2, q + 2);               // 右舷側の壁
            idx.push(q + 1, q + 3, r + 3, q + 1, r + 3, r + 1);   // 左舷側の壁
        }
        idx.push(0, 2, 3, 0, 3, 1);                                 // 後ろの壁
        const L = NA * 4; idx.push(L, L + 1, L + 3, L, L + 3, L + 2); // 前の壁
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
        const m = new THREE.Mesh(g, _flWaterMat);
        m.renderOrder = 984; m.frustumCulled = false;
        m.userData = { noLightBake: true, noSolid: true };
        flood.wGroup.add(m);
    }
}

// ── 修理（すべて元どおり）──
function floodRepair() {
    flood.holes = [];
    for (const c of flood.comps) c.vol = 0;
    flood.massKg = 0; flood.torqueP = 0; flood.rollBias = 0; flood.heel = 0; flood.deckCap = false; window._wtDeckCap = false;
    flood.sinking = false; flood.sunk = false; flood.capsized = 0; flood.bedT = 0; flood.settle = false; flood.rev++;
    if (typeof damageClearDecals === 'function') damageClearDecals();
    // 沈んでいたら水面へ戻す
    physics.vy = 0; physics.vPitch = 0; physics.vRoll = 0; physics.pitch = 0; physics.roll = 0;
    if (Number.isFinite(window._physicsWaveY)) physics.y = window._physicsWaveY - (physics.draftOffset || 0);
    _flMsg('修理しました（穴をふさいで、水を抜きました）。');
    _flPanelRender(true);
}
window.floodRepair = floodRepair;
// 応急修理：穴を少しずつふさぐ（1 か所 2 分ほど。大きい穴は半分まで）
function floodPlug() {
    let n = 0;
    for (const h of flood.holes) if (!(h.plugging) && (h.plug || 0) < 0.95) { h.plugging = true; n++; }
    _flMsg(n ? `応急修理を始めます（穴 ${n} か所）。` : 'ふさげる穴はありません。');
}
function floodPump(on) { flood.pump = !!on; _flPanelRender(true); }
function floodSetView(on) { flood.view = !!on; _flPanelRender(true); }
Object.assign(window, { floodPlug, floodPump, floodSetView });
// 応急修理の進み（毎フレーム、_flPanelTick から）
function _flPlugStep(dt) {
    for (const h of flood.holes) {
        if (!h.plugging) continue;
        const max = h.A > 6 ? 0.5 : h.A > 2 ? 0.8 : 0.97;           // 大きな穴は、ふさぎきれない
        h.plug = Math.min(max, (h.plug || 0) + dt / 120);
        if (h.plug >= max) h.plugging = false;
    }
}

// ── 被害の画面（汽笛の右の列の「被害」ボタンで開く：穴があいてから出る）──
let _flPop = null;
function _flSetup() {
    if (document.getElementById('btn-flood')) return;
    const after = document.getElementById('btn-mnv') || document.getElementById('btn-sub') || document.getElementById('btn-tug') || document.getElementById('btn-horn-sig');
    if (!after || typeof hudPopup !== 'function') { setTimeout(_flSetup, 300); return; }
    _flPop = hudPopup({ id: 'btn-flood', panelId: 'flood-panel', label: '被害', title: '被害・浸水', after, render: () => _flPanelRender(true) });
    _flPanelRender();
}
function _flEnsurePanel() {
    const p = document.getElementById('flood-panel');
    if (p && !p.querySelector('#flood-canvas')) p.innerHTML = `<div class="fp-head"><span class="fp-title">🌊 被害・浸水</span></div>
        <canvas id="flood-canvas" width="600" height="300"></canvas>
        <div class="fp-stat" id="flood-stat"></div>
        <div class="fp-btns" id="flood-btns"></div>`;
    return p;
}
function _flPanelRender(force) {
    const btn = document.getElementById('btn-flood');
    if (btn) { btn.style.display = (flood.holes.length || flood.shown) ? '' : 'none'; btn.classList.toggle('alert', flood.massKg > 0 && !btn.classList.contains('on')); }
    const p = document.getElementById('flood-panel');
    if (!p || !p.classList.contains('open')) return;
    _flEnsurePanel();
    const b = document.getElementById('flood-btns');
    if (b && (force || !b.innerHTML)) b.innerHTML = `
        <label class="sp-toggle"><input type="checkbox" ${flood.pump ? 'checked' : ''} onchange="floodPump(this.checked)"> 排水ポンプ</label>
        <label class="sp-toggle"><input type="checkbox" ${flood.view ? 'checked' : ''} onchange="floodSetView(this.checked)"> 船の中の水を透かして見る</label>
        <button onclick="floodPlug()">🩹 応急修理（穴をふさぐ）</button>
        <button onclick="floodRepair()">🔧 修理して元どおりに</button>`;
    _flPanelStat();
    _flDraw();
}
window._flPanelRender = _flPanelRender;
function _flPanelStat() {
    const el = document.getElementById('flood-stat'); if (!el) return;
    const t = flood.massKg / 1000, deg = (r) => Math.abs(r * 180 / Math.PI).toFixed(1);
    const res = flood.reserveKg > 0 ? Math.min(999, flood.massKg / flood.reserveKg * 100) : 0;
    const roll = physics.roll || 0, pitch = physics.pitch || 0;
    let inRate = 0; for (const h of flood.holes) inRate += h.A * (1 - (h.plug || 0));
    el.innerHTML = `浸水 <b>${t >= 100 ? Math.round(t).toLocaleString() : t.toFixed(1)}</b> トン（予備浮力の ${res.toFixed(0)}%）<br>
        横傾斜 <b>${deg(roll)}°</b>${Math.abs(roll) > 0.002 ? (roll < 0 ? '（左舷へ）' : '（右舷へ）') : ''}・縦傾斜 <b>${deg(pitch)}°</b>${Math.abs(pitch) > 0.002 ? (pitch > 0 ? '（船首が下がる）' : '（船尾が下がる）') : ''}<br>
        穴 ${flood.holes.length} か所（合わせて ${inRate.toFixed(1)} m²）${flood.pump ? '・ポンプ運転中' : ''}
        ${flood.sunk ? '<br><b style="color:#ff6b6b">沈没しました</b>' : flood.sinking ? '<br><b style="color:#ffb36b">沈みつつあります</b>' : ''}
        ${flood.msgT > 0 && flood.msg ? `<div class="fp-msg">${flood.msg}</div>` : ''}`;
}
function _flPanelTick() {
    const p = document.getElementById('flood-panel');
    const now = performance.now();
    _flPlugStep(Math.min(1, (now - (flood.tickT || now)) / 1000) * (typeof physicsSpeed !== 'undefined' ? physicsSpeed : 1));
    flood.tickT = now;
    if (!p || !p.classList.contains('open')) {
        const btn = document.getElementById('btn-flood');
        if (btn) { btn.style.display = (flood.holes.length || flood.shown) ? '' : 'none'; btn.classList.toggle('alert', flood.massKg > 0); }
        return;
    }
    if (now - (flood.panelT || 0) < 400) return;
    flood.panelT = now;
    _flPanelStat(); _flDraw();
}
// 船の横から見た区画と水（縦隔壁のある区画は、上から見た図も）
function _flDraw() {
    const cv = document.getElementById('flood-canvas'); if (!cv) return;
    const ctx = cv.getContext('2d'), W = cv.width, H = cv.height, K = W / 300;
    ctx.clearRect(0, 0, W, H);
    const D = flood.D; if (!D || !flood.comps.length) return;
    const sc3 = Math.pow(physics.scale || 1, 3);
    const hasL = flood.comps.some(c => c.kind === 'c' && c.np > 1);
    const sideH = hasL ? H * 0.55 : H - 10 * K, X = (a) => 6 * K + (a - D.aS) / (D.aB - D.aS) * (W - 12 * K);
    const Ys = (y) => 4 * K + (1 - (y - D.yBot) / D.H) * (sideH - 8 * K);
    // 船体（横から：喫水線の高さの前後の端で）
    ctx.fillStyle = 'rgba(160,175,190,0.18)'; ctx.strokeStyle = '#8fa3b5'; ctx.lineWidth = K;
    ctx.beginPath();
    const N = 60;
    for (let i = 0; i <= N; i++) { const a = D.aS + (D.aB - D.aS) * i / N; let yb = D.yDeck; for (let k = 0; k <= 20; k++) { const y = D.yBot + D.H * k / 20; if (wtHW(y, a) > 0) { yb = y; break; } } const px = X(a), py = Ys(yb); if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); }
    ctx.lineTo(X(D.aB), Ys(D.yDeck)); ctx.lineTo(X(D.aS), Ys(D.yDeck)); ctx.closePath(); ctx.fill(); ctx.stroke();
    // 喫水線
    ctx.strokeStyle = 'rgba(80,160,255,0.6)'; ctx.setLineDash([4 * K, 3 * K]); ctx.beginPath(); ctx.moveTo(X(D.aS), Ys(D.yWL)); ctx.lineTo(X(D.aB), Ys(D.yWL)); ctx.stroke(); ctx.setLineDash([]);
    // 区画ごとの水（横から：区画の左右をまとめた水位）
    for (const c of flood.comps) {
        if (!(c.vol > 0)) continue;
        const st = _flState(c, sc3), full = c.vol >= c.vmax * 0.985;
        ctx.fillStyle = full ? 'rgba(30,110,255,0.75)' : 'rgba(30,140,255,0.55)';
        const x0 = X(c.a0), x1 = X(c.a1);
        ctx.fillRect(x0 + K, Ys(st.y), Math.max(K, x1 - x0 - 2 * K), Ys(c.y0) - Ys(st.y));
    }
    // 横隔壁（高さまで）
    ctx.strokeStyle = '#33ccff'; ctx.lineWidth = 1.5 * K;
    const Lay = typeof wtLayout === 'function' ? wtLayout() : null;
    if (Lay) for (let j = 0; j < Lay.n; j++) { const a = Lay.cuts[j + 1], yT = D.yBot + D.H * shipWT.th[j]; ctx.beginPath(); ctx.moveTo(X(a), Ys(D.yBot)); ctx.lineTo(X(a), Ys(yT)); ctx.stroke(); }
    // 二重底
    if (shipWT.db > 0) { const yIB = D.yBot + shipWT.db / (physics.scale || 1); ctx.strokeStyle = '#b8c0c8'; ctx.lineWidth = K; ctx.beginPath(); ctx.moveTo(X(D.aS), Ys(yIB)); ctx.lineTo(X(D.aB), Ys(yIB)); ctx.stroke(); }
    // 穴
    for (const h of flood.holes) { ctx.fillStyle = h.plug > 0.9 ? '#888' : '#ff4d3d'; ctx.beginPath(); ctx.arc(X(h.a), Ys(h.y), (3 + Math.min(4, Math.sqrt(h.A))) * K, 0, Math.PI * 2); ctx.fill(); }
    // 上から（縦隔壁のある所）
    if (hasL) {
        const top = sideH + 4 * K, hh = H - top - 4 * K, Bm = flood.B / (physics.scale || 1) / 2;
        const Yp = (p) => top + hh / 2 - p / Bm * hh / 2;
        ctx.strokeStyle = '#8fa3b5'; ctx.beginPath();
        for (let i = 0; i <= N; i++) { const a = D.aS + (D.aB - D.aS) * i / N, w = wtHWRef(D, a); if (i === 0) ctx.moveTo(X(a), Yp(w)); else ctx.lineTo(X(a), Yp(w)); }
        for (let i = N; i >= 0; i--) { const a = D.aS + (D.aB - D.aS) * i / N, w = wtHWRef(D, a); ctx.lineTo(X(a), Yp(-w)); }
        ctx.closePath(); ctx.stroke();
        for (let i = 0; i < flood.nMain; i++) {
            const c = flood.comps[i]; if (!(c.vol > 0)) continue;
            const k = Math.min(1, c.vol / c.vmax);
            ctx.fillStyle = `rgba(30,140,255,${0.25 + 0.6 * k})`;
            const am = (c.a0 + c.a1) / 2, ref = wtHWRef(D, am);
            const lo = c.fLo === -Infinity ? -ref : c.fLo * ref, hi = c.fHi === Infinity ? ref : c.fHi * ref;
            ctx.fillRect(X(c.a0) + K, Yp(hi), X(c.a1) - X(c.a0) - 2 * K, Yp(lo) - Yp(hi));
        }
        ctx.fillStyle = '#ccd'; ctx.font = `${Math.round(9 * K)}px sans-serif`; ctx.fillText('左舷', 2 * K, top + 9 * K); ctx.fillText('右舷', 2 * K, H - 4 * K);
    }
    ctx.fillStyle = '#ccd'; ctx.font = `${Math.round(9 * K)}px sans-serif`; ctx.fillText('船尾', 4 * K, sideH - 2 * K); ctx.fillText('船首', W - 26 * K, sideH - 2 * K);
}

// 設定の画面に出す：区画の容積の合計・いちばん大きい区画
function floodSummary() {
    if (flood.dirty || _flKey() !== flood.key) _flBuild();
    if (!flood.comps.length) return '';
    const main = flood.comps.slice(0, flood.nMain), tot = main.reduce((s, c) => s + c.vmax, 0), big = Math.max(...main.map(c => c.vmax));
    const fmt = (v) => v >= 1e4 ? Math.round(v).toLocaleString() : v.toFixed(0);
    return `区画の容積の合計 ${fmt(tot)} m³・いちばん大きい区画 ${fmt(big)} m³・予備浮力 ${fmt(flood.reserveKg / 1000)} トン・GM およそ ${flood.GM0.toFixed(1)} m`;
}
window.floodSummary = floodSummary;

// 試しに穴をあける（設定の画面から）：区画（船尾から s 番目）・舷（'p' 左舷 / 's' 右舷）・面積[m²]・喫水線の下[m]
function floodTestHole(s, side, area, depth) {
    if (flood.dirty || _flKey() !== flood.key) _flBuild();
    const Lay = typeof wtLayout === 'function' ? wtLayout() : null; if (!Lay) return;
    const D = Lay.D, sc = physics.scale || 1;
    s = Math.max(0, Math.min(Lay.n, s | 0));
    const a = (Lay.cuts[s] + Lay.cuts[s + 1]) / 2, y = Math.max(D.yBot + 0.02, D.yWL - (depth ?? 3) / sc);
    const p = (side === 's' ? -1 : 1) * wtHW(y, a);
    floodAddHole(a, p, y, area || 2, 'test', true);
    if (typeof damageDecalAt === 'function') damageDecalAt(a, p, y, area || 2, 'test');
    _flMsg(`試験：船尾から ${s + 1} 番目の区画の${side === 's' ? '右舷' : '左舷'}に ${area || 2} m² の穴をあけました。`);
    if (_flPop) _flPop.setOpen(true); else _flPanelRender(true);
}
window.floodTestHole = floodTestHole;


document.addEventListener('DOMContentLoaded', () => setTimeout(_flSetup, 500));
