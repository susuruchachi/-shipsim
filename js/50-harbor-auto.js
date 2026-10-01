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

const harborAuto = { mode: null, phase: '', msg: '', plan: null, then: null, t: 0, phaseT: 0, lastOrderT: -99, tugIds: [], lines: [] };
window.harborAuto = harborAuto;
// 接舷する舷（'auto'：今の向きに近い方／'port'：左舷を岸壁に／'starboard'：右舷を岸壁に）。端末に覚えておく
harborAuto.sidePref = (() => { try { return localStorage.getItem('susuru_berth_side') || 'auto'; } catch (e) { return 'auto'; } })();
function harborSetSidePref(v) {
    harborAuto.sidePref = v;
    try { localStorage.setItem('susuru_berth_side', v); } catch (e) { /* ignore */ }
    if (typeof renderTugPanel === 'function') renderTugPanel();
    if (typeof renderAutopilotPanel === 'function') renderAutopilotPanel();
}
window.harborSetSidePref = harborSetSidePref;
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
    if (port.type === 'fishing') return { ok: false, why: `${port.name}には大きな船が横付けできる岸壁がありません` };
    let S = _portShape(port), Q = _haQ(S);
    const S0 = S, D = _haDims();
    // 横付けに使える岸壁の区間（軍港は桟橋の無い側）
    const PL = _portPierLayout(port.type, S.quayLen);
    const segLen = PL.free[1] - PL.free[0];
    if (!S.detail && segLen < D.L + 20) return { ok: false, why: `${port.name}の空いている岸壁（${Math.round(segLen)}m）は船（${Math.round(D.L)}m）より短いので付けられません` };
    const T = PORT_TYPES[port.type];
    const draft = worldShipDraft();
    if (draft + 1 > T.depth + 2) return { ok: false, why: `${port.name}の岸壁は船に対して浅いので付けられません` };
    let aB = 6 + D.hw + 1.5;
    // 作り込んだ港：本物の岸の線から測る（船の長さの範囲で、岸から沖へ見て、喫水より深くなる所のいちばん沖の方）
    let aQ = 6, quayExt = null, bCq = null;
    if (S.detail && typeof worldSeabedAt === 'function') {
        const PLb = (PL.free[0] + PL.free[1]) / 2;
        // （この港の岸壁の前の掘り込みは、港の形がまだ読み込まれていなくても足して見る）
        const loaded = typeof terrain !== 'undefined' && terrain.ports && terrain.ports.has(port.id);
        const depthAt = (a, b) => { const w = Q.toW(a, b); let h = worldSeabedAt(w.x, w.z); if (!loaded && typeof _portAdjust === 'function') h = _portAdjust(h, w.x, w.z, [S0]); return -h; };
        // 船の幅（＋余裕）の分だけ続けて深い所の、いちばん岸寄りの始まり（岸の先の桟橋などの浅い所の外側）
        // その深い所は、沖の水へ続いていること（リヴァプールの浮き桟橋と岸の間のすき間のような、
        // 船の幅ほどしかない水に付けない）：船の幅＋40m（80m まで）続けて深い所の始まり
        const needW = 2 * D.hw + 6, needRun = Math.max(needW, Math.min(80, needW + 40));
        const shoreAt = (b) => {
            let run0 = null;
            for (let a = -30; a <= 260; a += 2) {
                if (depthAt(a, b) > draft + 0.5) { if (run0 === null) run0 = a; if (a - run0 >= needRun) return run0; }
                else run0 = null;
            }
            return null;
        };
        // 本物の岸壁の長さを測る：真ん中から左右へ、岸の線が続いていて（ずれが 15m 以内）、
        // その後ろが陸（岸壁）の間。地図の設定の長さ（port.quay）ではなく、地形から
        // 岸壁の向き：地図の設定の向きが本物の岸の線と少しずれていることがある（メイフラワーなど）ので、
        // 真ん中の前後 120m の岸の線に合わせて回す（2 回）
        for (let it = 0; it < 2; it++) {
            let n = 0, sb = 0, sa = 0, sbb = 0, sab = 0;
            for (let b = PLb - 120; b <= PLb + 120; b += 20) { const a = shoreAt(b); if (a === null) continue; n++; sb += b; sa += a; sbb += b * b; sab += a * b; }
            if (n < 5) break;
            const m = (n * sab - sb * sa) / ((n * sbb - sb * sb) || 1);
            if (!(Math.abs(m) > 0.015 && Math.abs(m) < 0.4)) break;
            const l = Math.hypot(1, m);
            S = Object.assign({}, S, { sx: (S.sx - m * S.sz) / l, sz: (S.sz + m * S.sx) / l });
            Q = _haQ(S);
        }
        const s0 = shoreAt(PLb);
        if (s0 === null) return { ok: false, why: `${port.name}の岸壁の前は、この船（喫水 ${draft.toFixed(1)}m）には浅すぎます` };
        // 岸の線が続いている間（隣とのずれ 8m・真ん中とのずれ 25m まで）
        const quayHere = (b, prev) => { const sa = shoreAt(b); return sa !== null && Math.abs(sa - prev) <= 8 && Math.abs(sa - s0) <= 25 && depthAt(sa - 10, b) < 3 ? sa : null; };
        let bMin = PLb, bMax = PLb;
        for (let b = PLb + 5, pr = s0; b <= PLb + 1200; b += 5) { const q = quayHere(b, pr); if (q === null) break; bMax = b; pr = q; }
        for (let b = PLb - 5, pr = s0; b >= PLb - 1200; b -= 5) { const q = quayHere(b, pr); if (q === null) break; bMin = b; pr = q; }
        // 船は岸壁の端から少しはみ出してもよい（両端それぞれ 船の長さの 1 割・30m まで）
        const ovh = Math.min(30, D.L * 0.1);
        quayExt = [bMin, bMax];
        if (bMax - bMin + 2 * ovh < D.L) return { ok: false, why: `${port.name}の岸壁（${Math.round(bMax - bMin)}m）は船（${Math.round(D.L)}m）より短いので付けられません` };
        // 船を置く所：設定の真ん中に近い所で、岸壁に収まる所
        bCq = Math.max(bMin - ovh + D.HL, Math.min(bMax + ovh - D.HL, PLb));
        let worst = -Infinity;
        for (let b = bCq - D.HL; b <= bCq + D.HL + 0.1; b += 15) {
            const found = shoreAt(b);
            if (found === null) return { ok: false, why: `${port.name}の岸壁の前は、この船（喫水 ${draft.toFixed(1)}m）には浅すぎます` };
            worst = Math.max(worst, found);
        }
        aQ = worst; aB = aQ + D.hw + 2.5;
    }
    // 回す所：船首が岸壁（a＝6）に、船尾が沖の防波堤（44-world-terrain.js：岸から basin×0.95×0.8 の所）に
    // 届かない所。回っている間は船の端が半径 HL の円を描く
    const outerWall = port.type !== 'cargo' && !port.real ? S.basin * 0.95 * 0.8 - 8 : S.basin - 40;
    const lo = 6 + 12 + D.HL, hi = outerWall - 15 - D.HL;
    if (lo > hi) return { ok: false, why: `${port.name}の泊地（防波堤まで ${Math.round(outerWall)}m）は、この船（${Math.round(D.L)}m）を回すには狭すぎます` };
    const aE = Math.max(lo, Math.min(hi, aB + 3 * D.B + 60));
    // 岸沿いの位置：空いている区間の真ん中。回るときの円（半径 HL）が桟橋の軍艦や防波堤に掛からないように
    let bLo = PL.free[0] + D.HL + 10, bHi = PL.free[1] - D.HL - 10;
    if (PL.keepOut) bLo = Math.max(bLo, PL.keepOut[1] + D.HL + 15);
    if (!port.real && port.type !== 'cargo') bHi = Math.min(bHi, S.quayLen / 2 + 40 - 8 - D.HL - 15);   // 防波堤の腕
    if (quayExt) { bLo = bHi = bCq; }                 // 作り込んだ港：測った岸壁の上の位置
    if (bLo > bHi) return { ok: false, why: `${port.name}には、この船（${Math.round(D.L)}m）を回して横付けできる広さがありません` };
    const bC = Math.max(bLo, Math.min(bHi, (PL.free[0] + PL.free[1]) / 2));
    // 岸壁と平行な 2 つの向きのうち、今の向きに近い方
    const h1 = Math.atan2(S.sz, -S.sx) / _haRad, h2 = h1 + 180;
    const cur = prefHeading !== undefined ? prefHeading : physics.heading;
    // 接舷する舷：設定（harborAuto.sidePref）で左舷・右舷を決められる。自動なら今の向きに近い方
    //（h1 では左舷が岸壁側）
    const sp = harborAuto.sidePref;
    const useH1 = sp === 'port' ? true : sp === 'starboard' ? false : Math.abs(_haWrap(h1 - cur)) <= Math.abs(_haWrap(h2 - cur));
    const hB = useH1 ? h1 : h2;
    const open = useH1 ? -1 : 1;              // 沖側の舷（船の中の +x ＝ 左舷 なら +1）。h1 では左舷が岸壁側
    const pB = Q.toW(aB, bC), pE = Q.toW(aE, bC);
    // 港口の方の向き：現実世界の港は、掘った航路の最初の区間の向き（岸壁からまっすぐ沖とは限らない）
    let hOut = Math.atan2(S.sx, S.sz) / _haRad;
    const fw = port.real && port.fairway ? port.fairway.pts : null;
    if (fw && fw.length >= 3) {
        const A = worldUnitToLocal(worldLatLonToUnit(fw[1].lat, fw[1].lon)), B = worldUnitToLocal(worldLatLonToUnit(fw[2].lat, fw[2].lon));
        if (Number.isFinite(A.x) && Number.isFinite(B.x) && Math.hypot(B.x - A.x, B.z - A.z) > 1) hOut = Math.atan2(B.x - A.x, B.z - A.z) / _haRad;
    }
    // ドックの中の岸壁（43-world.js の dock）：ドックの外（入口の外の真ん中の線の上）で向きを合わせ、
    // 船首からまっすぐ入って、岸壁の前（ドックの真ん中の線の上）で止め、横へ寄せる。出るときは後ろへまっすぐ出る
    if (port.dock) {
        const E = worldUnitToLocal(worldLatLonToUnit(port.dock.entrance[0], port.dock.entrance[1]));
        const ib = port.dock.inBearing * _haRad, ux = -Math.sin(ib), uz = Math.cos(ib);   // 入っていく向き（物理の面：東は −x）
        const hDock = Math.atan2(ux, uz) / _haRad;                                       // 船首から入る向き
        const qE = Q.toQ(E.x, E.z);
        const aMid = Math.max(aB + 4, qE.a);                                             // ドックの真ん中の線（岸壁から）
        if (aMid - aB < 10) return { ok: false, why: `${port.name}のドックは、この船（幅${Math.round(D.B)}m）には狭すぎます` };
        let out = port.dock.turnOut || Math.max(D.HL + 90, 200);
        let T = { x: E.x - ux * out, z: E.z - uz * out };
        // ドックの前（川など）で、この船を回せる広さがあるか（回す所のまわり、船の半分の長さ＋余裕の円が水の上か）
        // （角の 1〜2 点が浅いくらいは、回しながら少しずらして避けられる。3 点以上かかれば無理）
        //（船の両端は喫水が浅いので、喫水の 6 割の深さで見る。タグで回すので、回す所は船の真ん中より少し寄せられる：半径は船の半分の 9 割＋余裕）
        const ringOk = (rr, Tq) => {
            Tq = Tq || T;
            let bad = 0;
            for (let k = 0; k < 24; k++) {
                const a = k / 24 * Math.PI * 2;
                if (worldSeabedAt(Tq.x + Math.sin(a) * rr, Tq.z + Math.cos(a) * rr) > -(worldShipDraft() * 0.6)) bad++;
            }
            return bad <= 2;
        };
        const rNeed = D.HL * 0.9 + 8;
        // 回す所は、ドックの真ん中の線の上で入口から 150〜700m の間の、回せる所（決めた所が駄目なら探す）
        if (typeof worldSeabedAt === 'function' && !ringOk(rNeed)) {
            for (let o = 150; o <= 700; o += 25) {
                const Tq = { x: E.x - ux * o, z: E.z - uz * o };
                if (ringOk(rNeed, Tq)) { out = o; T = Tq; break; }
            }
        }
        if (typeof worldSeabedAt === 'function' && !ringOk(rNeed)) {
            let rMax = 0;
            for (let rr = 20; rr < rNeed; rr += 10) { if (!ringOk(rr)) break; rMax = rr; }
            return { ok: false, why: `${port.name}のドックの前は、この船（${Math.round(D.L)}m）を回すには狭すぎます（回せるのは長さおよそ ${Math.max(0, Math.round(2 * (rMax - 8) / 0.9 / 10) * 10)}m までの船）` };
        }
        const pBd = Q.toW(aB, bC), pCd = Q.toW(aMid, bC);
        // 沖側の舷（船の中の +x ＝ 左舷 が、岸壁から離れた方を向いているなら +1）
        const hr = hDock * _haRad, open = (Math.cos(hr) * S.sx - Math.sin(hr) * S.sz) > 0 ? 1 : -1;
        let hOutD = hDock + 180;
        if (fw && fw.length >= 3) {
            const A = worldUnitToLocal(worldLatLonToUnit(fw[1].lat, fw[1].lon)), B = worldUnitToLocal(worldLatLonToUnit(fw[2].lat, fw[2].lon));
            if (Math.hypot(B.x - A.x, B.z - A.z) > 1) hOutD = Math.atan2(B.x - A.x, B.z - A.z) / _haRad;
        }
        return {
            ok: true, port, S, aB, aE: aMid, bC, open, dock: true, aQ, quayExt,
            berth: { x: pBd.x, z: pBd.z, h: hDock },
            mid: { x: pCd.x, z: pCd.z },                 // ドックの真ん中の線の上の、岸壁の前
            turn: { x: T.x, z: T.z },                    // ドックの外で向きを合わせる所
            hIn: hDock, hOut: hOutD,
        };
    }
    return {
        ok: true, port, S, aB, aE, bC, open, aQ, quayExt,
        berth: { x: pB.x, z: pB.z, h: hB },
        turn: { x: pE.x, z: pE.z },
        hIn: Math.atan2(-S.sx, -S.sz) / _haRad,     // 岸壁の方を向く
        hOut,                                        // 港口の方を向く
    };
}
window.harborBerthPlan = harborBerthPlan;

// 今、岸壁に横付けしているか（離岸できるか）
function harborBerthedAt() {
    if (!window.world || world.mode !== 'world') return null;
    const ll = worldShipLatLon();
    // 近くの港（同じ港の別の埠頭も）を近い順に調べ、その岸壁に横付けしている所を探す
    const cands = (typeof worldBuildPorts === 'function' ? worldBuildPorts() : [])
        .map(p => ({ port: p, dist: worldDistance(ll.lat, ll.lon, p.lat, p.lon) })).filter(c => c.dist < 4000).sort((a, b) => a.dist - b.dist);
    for (const np of cands) {
        const plan = harborBerthPlan(np.port);
        if (!plan.ok) continue;
        const Q = _haQ(plan.S), q = Q.toQ(physics.cgWorldX, physics.cgWorldZ);
        const parallel = Math.min(Math.abs(_haWrap(physics.heading - plan.berth.h)), Math.abs(_haWrap(physics.heading - plan.berth.h - 180)));
        const ext = plan.quayExt || [-plan.S.quayLen / 2, plan.S.quayLen / 2];
        if (q.a < plan.aB + 25 && q.a > 0 && q.b > ext[0] - 20 && q.b < ext[1] + 20 && parallel < 25) {
            // 今の向きで計画し直す
            return harborBerthPlan(np.port, physics.heading);
        }
    }
    return null;
}
window.harborBerthedAt = harborBerthedAt;

// ── タグの数と持ち場 ──
// 船の長さで：小さい船 2 隻、大きい船 4 隻、とても大きい船 6 隻
function harborTugCount() { const L = _haDims().L; return L < 120 ? 2 : L < 230 ? 4 : 6; }
window.harborTugCount = harborTugCount;
// 持ち場の並び：沖側（open）の船首・船尾、4 隻なら反対舷の船首・船尾も、6 隻なら両舷の中央も
function _haStationKeys(open, n) {
    const all = tugStations();
    const hp = window.hullProfile, hl = (hp && hp.ready) ? hp.halfLen : 6;
    const used = new Set();
    const pick = (side, where) => {
        const st = all.filter(s => s.side === side && !used.has(s.key));
        let q;
        if (where === 'fwd') q = st.filter(s => s.z > 0.3 * hl).sort((a, b) => b.z - a.z)[0] || st.find(s => s.key === `d0.75:${side}`);
        else if (where === 'aft') q = st.filter(s => s.z < -0.3 * hl).sort((a, b) => a.z - b.z)[0] || st.find(s => s.key === `d-0.75:${side}`);
        else q = st.filter(s => Math.abs(s.z) < 0.3 * hl).sort((a, b) => Math.abs(a.z) - Math.abs(b.z))[0] || st.find(s => s.key === `d0:${side}`);
        if (q) used.add(q.key);
        return q ? q.key : null;
    };
    const order = [[open, 'fwd'], [open, 'aft'], [-open, 'fwd'], [-open, 'aft'], [open, 'mid'], [-open, 'mid']].slice(0, Math.max(1, n));
    return order.map(([sd, w]) => pick(sd, w)).filter(Boolean);
}
function _haSide(t) { const s = t && tugStations().find(q => q.key === t.station); return s && s.side ? s.side : 0; }
// 付いているタグを持ち場（keys）に割り当てる（同じ舷の近い持ち場へ）。余ったタグは帰し、足りなければ呼ぶ
function _haTakeTugs(keys) {
    const have = (window.tugs || []).filter(t => t.state !== 'leaving');
    const st = tugStations(), S = (k) => st.find(x => x.key === k);
    const out = keys.map(() => null);
    keys.forEach((k, i) => { const t = have.find(q => q.station === k && !out.includes(q)); if (t) out[i] = t; });
    for (const t of have) {
        if (out.includes(t)) continue;
        const ts = S(t.station);
        let bi = -1, bd = Infinity;
        keys.forEach((k, i) => {
            if (out[i]) return;
            const s2 = S(k);
            const d = ts && s2 ? Math.abs(ts.z - s2.z) + (ts.side !== s2.side ? 1e4 : 0) : 0;
            if (d < bd) { bd = d; bi = i; }
        });
        if (bi < 0) { tugSet(t.id, 'release'); continue; }
        out[bi] = t; if (t.station !== keys[bi]) { t.station = keys[bi]; t.engaged = false; if (t.state === 'on') t.state = 'coming'; }
    }
    for (let i = 0; i < keys.length; i++) if (!out[i]) out[i] = tugCall(keys[i]);
    for (const t of out) if (t) { t.action = 'standby'; t.autoPower = 0; t.dir = 'side'; t.switchT = 0; t.awaySide = false; }
    if (typeof renderTugPanel === 'function') renderTugPanel();
    return out.filter(Boolean);
}

// ── タグがそろったか：全部付いた、または 2 隻以上が付いていて、残りは近づけない（すき間が狭い等）か
//    TUG_START_WAIT 秒待ったとき。付いていないタグは近づき続け、付いたら力の割り振りに加わる ──
const TUG_START_WAIT = 45;
function _haReadyState(list, waitT) {
    const all = list.length, on = list.filter(t => t.state === 'on').length;
    const stuck = list.filter(t => t.state !== 'on' && t.stuck).length;
    const needMin = Math.min(2, all);
    const ok = all > 0 && (on === all || (on >= needMin && (on + stuck === all || waitT > TUG_START_WAIT)));
    return { ok, on, all, stuck, partial: ok && on < all };
}
// 付いているタグだけで作業する。一度持ち場に着いたタグ（engaged）は、押す⇄引くの付き直しで
// 少し離れている間も作業中に数える（そうしないと、引きに出たとたん待機に戻されてしまう）
const _haWorking = (t) => t.state === 'on' || t.switchT > 0 || !!t.engaged;

// ── 狭い水路・浅い水道の付き添い（サウサンプトンのように、タグが横と回頭を助ける）──
// 自動航行（49-autopilot.js）が、狭い区間の手前で呼び、通り抜けたら帰す
const tugEscort = { active: false, ids: [], open: 1, held: null, t: 0 };
window.tugEscort = tugEscort;
// 水の広い方の舷に付く
function _teOpenSide() {
    if (typeof worldSeabedAt !== 'function') return 1;
    const D = _haDims(), h = physics.heading * _haRad, fx = Math.sin(h), fz = Math.cos(h), sx = Math.cos(h), sz = -Math.sin(h);
    const room = (sg) => {
        let sum = 0;
        for (const a of [-0.7, 0, 0.7]) for (const d of [30, 70, 130]) {
            const x = physics.cgWorldX + fx * a * D.HL + sx * sg * (D.hw + d), z = physics.cgWorldZ + fz * a * D.HL + sz * sg * (D.hw + d);
            sum += Math.min(30, Math.max(-10, -worldSeabedAt(x, z)));
        }
        return sum;
    };
    return room(1) >= room(-1) ? 1 : -1;
}
function tugEscortStart() {
    if (tugEscort.active) return;
    const open = _teOpenSide();
    const T = _haTakeTugs(_haStationKeys(open, harborTugCount()));
    Object.assign(tugEscort, { active: true, open, ids: T.map(t => t.id), held: null, t: 0, readyOnce: false });
    if (typeof renderAutopilotPanel === 'function') renderAutopilotPanel();
}
// keep：タグは帰さない（そのまま着岸に使う）
function tugEscortStop(keep) {
    tugEscort.manual = false;
    const was = tugEscort.active || tugEscort.held;
    const ids = tugEscort.active ? tugEscort.ids : tugEscort.held ? tugEscort.held.ids : [];
    tugEscort.active = false; tugEscort.held = null; tugEscort.readyOnce = false;
    if (!was) return;
    for (const id of ids) {
        const t = _haTug(id);
        if (!t) continue;
        delete t.autoPower; delete t.awaySide;
        if (!keep) tugSet(t.id, 'release');
    }
}
function _teTugs() { return tugEscort.ids.map(_haTug).filter(Boolean); }
function tugEscortReady() { return _haReadyState(_teTugs(), tugEscort.t || 0).ok; }
function tugEscortAlive() { return _teTugs().length > 0; }
// eS：航路の線へ戻る横のずれ（＋x＝左舷の方へ m）、eYaw：向けたい向きとの差（度、heading の向き）
function tugEscortAssist(eS, eYaw, dt) {
    if (!tugEscort.active) return;
    // 持ち場に付いているタグだけで（付き直している間のタグは力を出さない）
    const all = _teTugs(), use = all.filter(_haWorking);
    for (const t of all) if (!use.includes(t)) t.autoPower = 0;
    if (!use.length) return;
    const D = _haDims();
    const massKg = Math.max(1e5, (physics.mass || 1) * 1e6);
    const vS = _tugShip.vSway, r = _tugShip.yawRate + (physics.turnRate || 0) * _haRad;
    const vSd = Math.abs(eS) < 2 ? 0 : Math.max(-0.4, Math.min(0.4, 0.015 * eS));
    const rd = Math.max(-0.006, Math.min(0.006, 0.03 * eYaw * _haRad));
    const Fs = massKg * 1.8 * 0.3 * (vSd - vS);
    const Mz = massKg * 1.5 * D.L * D.L / 12 * 0.3 * (rd - r);
    _haAllocate(Fs, Mz, use, dt);
}
// 手で頼む付き添い（自動では来ない水路でも）：自動航行中は、頼んでいる間は狭い水路と同じく付き添われて微速で進む
function tugEscortManual(on) {
    if (on) {
        if (!(window.world && world.mode === 'world')) return;
        tugEscortStart();
        tugEscort.manual = true;
    } else tugEscortStop();
    if (typeof renderTugPanel === 'function') renderTugPanel();
    if (typeof renderAutopilotPanel === 'function') renderAutopilotPanel();
}
Object.assign(window, { tugEscortStart, tugEscortStop, tugEscortReady, tugEscortAlive, tugEscortAssist, tugEscortManual });

// ── 始める・やめる ──
function _haMsg(s) { harborAuto.msg = s; if (typeof renderTugPanel === 'function') renderTugPanel(); if (typeof renderAutopilotPanel === 'function') renderAutopilotPanel(); }
function harborAutoStart(mode, plan, then) {
    if (!plan || !plan.ok) { _haMsg(plan ? plan.why : '港の近くではありません'); return false; }
    // 潜水艦（54-submarine.js）は潜ったままでは離着岸しない
    if (window.sub && typeof isSubmarine === 'function' && isSubmarine() && (sub.depth > 1 || sub.mode === 'dive')) { _haMsg('潜航中は離着岸できません。浮上してからにしてください'); return false; }
    if (typeof autopilot !== 'undefined' && autopilot.active) autopilotStop('', true);
    Object.assign(harborAuto, { mode, plan, then: then || null, phase: 'tugs', t: 0, phaseT: 0, lastOrderT: -99, tugIds: [], resume: null, holdH: null, turning: false });
    _haClearLines();
    // タグ：もう付いているタグ（狭い水路で付き添ってきたタグなど）はそのまま使い、足りなければ呼ぶ
    const T = _haTakeTugs(_haStationKeys(plan.open, harborTugCount()));
    harborAuto.tugIds = T.map(t => t.id);
    tugEscort.active = false; tugEscort.held = null; tugEscort.manual = false;
    _haMsg(mode === 'berth' ? `${plan.port.name}：タグを待っています（着岸）` : `${plan.port.name}：タグを待っています（離岸）`);
    return true;
}
function harborAutoStop(msg) {
    // 途中で止めたときは「再開」できるように
    if (harborAuto.mode && msg) harborAuto.resume = { mode: harborAuto.mode, port: harborAuto.plan.port, then: harborAuto.then };
    harborAuto.mode = null; harborAuto.phase = '';
    for (const t of (window.tugs || [])) { delete t.autoPower; delete t.awaySide; }
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
    // 同じ作り込んだ港の中の別の埠頭へ行くときは、港の出口ではなく、そちらへ向かう港内の水路の向きに回す
    if (then && then.real && then.fairway && then.fairway.pts.length >= 2 && typeof _rwDetailOf === 'function') {
        const D = _rwDetailOf(plan.port.lat, plan.port.lon);
        if (D && D === _rwDetailOf(then.lat, then.lon)) {
            const Q = _haQ(plan.S), o = plan.dock ? plan.turn : Q.toW(plan.aE, plan.bC || 0);
            const oll = worldUnitToLatLon(worldLocalToUnit(o.x, o.z)), fin = then.fairway.pts[1];
            const r = _rwDetailRoute(D, oll, { lat: fin.lat, lon: fin.lon });
            const pts = r ? [...r.pts, fin] : [fin];
            const q = pts.find(p => { const L = worldUnitToLocal(worldLatLonToUnit(p.lat, p.lon)); return Math.hypot(L.x - o.x, L.z - o.z) > 250; }) || pts[pts.length - 1];
            const L = worldUnitToLocal(worldLatLonToUnit(q.lat, q.lon));
            if (Math.hypot(L.x - o.x, L.z - o.z) > 30) plan.hOut = Math.atan2(L.x - o.x, L.z - o.z) / _haRad;
        }
    }
    return harborAutoStart('depart', plan, then);
}
function harborAutoResume() {
    const r = harborAuto.resume;
    if (!r) return;
    harborAuto.resume = null;
    if (r.mode === 'berth') harborAutoStart('berth', harborBerthPlan(r.port));
    else if (!harborAutoDepartNow(r.then)) { if (r.then && typeof autopilotStart === 'function') autopilotStart(r.then); }
}
Object.assign(window, { harborAutoStart, harborAutoStop, harborAutoBerthNow, harborAutoDepartNow, harborAutoResume });

// 横の力 Fs（＋x＝左舷へ）と回す力 Mz を、付いているタグ（何隻でも・両舷でも）に割り振る。
// 各タグの力 f = a + b·z（z：船首尾方向の位置）で、合計が Fs、モーメントが Mz になるうち、いちばん小さい力で。
// 押す⇄引く を付け直さずに済むタグに、なるべく受け持たせる（付け直しは少し待ってから。その間は力を出さない）
// 引けるか：索を取れる金物があり、（ドックなど狭い所では）横へ引く所（金物から 45m 先）が水の上か
function _haCanPull(s2, st, narrow) {
    const hs = s2 && tugPullHook(s2, st);
    if (!hs) return false;
    if (!narrow || !s2.side) return true;
    const C = _tugShipCtx(), hk = _localToWorldFlat(hs.x, hs.y, hs.z), sd = s2.side;
    const r = 45 + TUG_LEN / 2 + 6;
    return !_tugStaticBlocked(hk.x + C.F.sx * sd * r, hk.z + C.F.sz * sd * r);
}
function _haAllocate(Fs, Mz, list, dt, noPull) {
    const st = tugStations(), sc = physics.scale || 1;
    const T = list.filter(Boolean).map(t => { const s2 = st.find(q => q.key === t.station); return { t, z: s2 ? s2.z * sc : 0, side: s2 && s2.side ? s2.side : 1, canPull: _haCanPull(s2, st, noPull) }; });
    if (!T.length) return;
    const solve = (w) => {
        let S0 = 0, S1 = 0, S2 = 0;
        T.forEach((q, i) => { S0 += w[i]; S1 += w[i] * q.z; S2 += w[i] * q.z * q.z; });
        const det = S0 * S2 - S1 * S1;
        let a, b;
        if (Math.abs(det) < 1e-6 * Math.max(1, S0 * S2)) { a = Fs / S0; b = 0; }
        else { a = (Fs * S2 - Mz * S1) / det; b = (S0 * Mz - S1 * Fs) / det; }
        return T.map((q, i) => w[i] * (a + b * q.z));
    };
    let f = solve(T.map(() => 1));
    f = solve(T.map((q, i) => { const want = Math.sign(f[i]) === q.side ? 'pull' : 'push'; if (want === 'pull' && !q.canPull) return 0.02; return (q.t.action === 'standby' || q.t.action === want) ? 1 : 0.15; }));
    // 索を取れる金物が近くに無いタグは引けない（押すだけ）
    f = f.map((v, i) => (Math.sign(v) === T[i].side && !T[i].canPull) ? 0 : v);
    // 引けないタグの分などで横の力が足りなければ、その向きに力を出せるタグ（押す側か、引ける側）で残りを分け合う
    //（回す力は少しずれるが、まず動かす。持ち場に着いていないタグがいるときも、着いているタグだけで動かせる）
    const deficit = Fs - f.reduce((a, v) => a + v, 0);
    if (Math.abs(deficit) > Math.abs(Fs) * 0.25) {
        const able = T.map((q, i) => (Math.sign(deficit) === q.side ? q.canPull : true) ? i : -1).filter(i => i >= 0);
        for (const i of able) f[i] += deficit / able.length;
    }
    const Fmax = _tugPullN();
    const big = Math.max(...f.map(Math.abs));
    if (big > Fmax) f = f.map(v => v * Fmax / big);
    T.forEach((q, i) => {
        const t = q.t;
        t.dir = 'side';
        const p = Math.min(1, Math.abs(f[i]) / Fmax);
        const wantAct = p < 0.03 ? t.action : (Math.sign(f[i]) === q.side ? 'pull' : 'push');
        if (t.action === 'standby') t.action = wantAct === 'standby' ? 'push' : wantAct;
        if (wantAct !== t.action) {
            t.autoPower = 0;
            t.switchT = (t.switchT || 0) + dt;
            if (t.switchT > 4) { t.action = wantAct; t.switchT = 0; }
        } else { t.switchT = 0; t.autoPower = p; }
    });
}

// 前後に引くタグを1隻選んで力を決める（引けるのは索を取れる金物のあるタグだけ：47-tugboats.js の tugPullHook）
function _haAxialTug(use, eA, vA, massKg) {
    if (use.length < 4 || Math.abs(eA) > 150 || Math.abs(eA) < 5 || Math.abs(vA) > 2) { harborAuto.axId = null; return null; }
    const fwd = eA > 0, st = tugStations();
    let best = use.find(t => t.id === harborAuto.axId && t.dir === (fwd ? 'fwd' : 'aft')) || null;
    if (!best) {
        let bz = -Infinity;
        for (const t of use) {
            const s2 = st.find(q => q.key === t.station);
            if (!s2 || !tugPullHook(s2, st)) continue;
            const z = fwd ? s2.z : -s2.z;
            if (z > bz) { bz = z; best = t; }
        }
    }
    if (!best) { harborAuto.axId = null; return null; }
    harborAuto.axId = best.id;
    const vAd = Math.sign(eA) * Math.min(0.6, 0.012 * Math.abs(eA));          // ノット
    const Fa = massKg * 0.514 * 0.25 * (vAd - vA);
    best.action = 'pull'; best.dir = fwd ? 'fwd' : 'aft'; best.switchT = 0;
    // 目標へ向かう向きの力だけ（止めるのは機関で）
    best.autoPower = Math.sign(Fa) === (fwd ? 1 : -1) ? Math.min(1, Math.abs(Fa) / _tugPullN()) : 0;
    return best;
}
// ── 目標の位置・向きへ動かす ──
function _haTug(id) { return (window.tugs || []).find(t => t.id === id && t.state !== 'leaving'); }
function _haTugs() { return (harborAuto.tugIds || []).map(_haTug).filter(Boolean); }
function _haControl(target, dt, opt) {
    const hp = window.hullProfile, D = _haDims();
    const h = physics.heading * _haRad, fx = Math.sin(h), fz = Math.cos(h), sx = Math.cos(h), sz = -Math.sin(h);
    const ex = target.x - physics.cgWorldX, ez = target.z - physics.cgWorldZ;
    const eA = ex * fx + ez * fz, eS = ex * sx + ez * sz;
    const eY = target.h !== undefined ? _haWrap(target.h - physics.heading) : 0;
    const massKg = Math.max(1e5, (physics.mass || 1) * 1e6);
    // 前後：機関を少しずつ（ベルが鳴りすぎないよう 6 秒に一度まで）
    const vA = physics.speed || 0;
    // （目標の速さは、機関を動かす幅 ±0.2 より大きくしておく。小さいと、ずれが残っても機関が動かない）
    const vAd = Math.abs(eA) < 12 ? 0 : Math.sign(eA) * Math.max(0.25, Math.min(opt.vA || 0.5, 0.02 * Math.abs(eA)));
    harborAuto.t += dt;
    // （ふだんは 6 秒に一度。速すぎ・後ろへ速いときはすぐ直す）
    const urgent = Math.abs(vA - vAd) > 1.0 && harborAuto.t - harborAuto.lastOrderT > 1.5;
    if (harborAuto.t - harborAuto.lastOrderT > 6 || urgent) {
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
    // 岸壁のすぐ近くでは、岸壁側の舷のタグは挟まれるので離れて待つ（沖側のタグだけで押し引き）
    const L = _haTugs(), open = harborAuto.plan.open;
    const side = opt.openOnly ? L.filter(t => _haSide(t) !== -open) : L;
    for (const t of L) { t.awaySide = !side.includes(t); if (t.awaySide) { t.action = 'standby'; t.autoPower = 0; t.switchT = 0; } }
    // まだ持ち場に着いていないタグは、待機の位置へ向かい続ける（着いたら加わる）
    const use = side.filter(_haWorking);
    for (const t of side) if (!use.includes(t)) { t.autoPower = 0; if (t.action !== 'standby') t.action = 'standby'; }
    // 前後の最後の寄せ：目標まで 150m 以内でゆっくりのときは、船首（前へ）か船尾（後ろへ）のタグにも
    // 前後に引かせる（機関だけより細かく寄せられる）。4 隻以上いるときだけ（横と回頭のタグを残す）
    // （前後に引きに回ったタグは持ち場を移る間「着いていない」になるので、選ぶのは付き添いの全タグから）
    const ax = _haAxialTug(side, eA, vA, massKg);
    // ドックの中では、横へ引く所（45m 先）がドックの壁の中になることがあるので、そのタグは押すだけ
    _haAllocate(Fs, Mz, ax ? use.filter(t => t !== ax) : use, dt, !!(harborAuto.plan && harborAuto.plan.dock));
    return { eA, eS, eY, vS, r, dist: Math.hypot(ex, ez) };
}

// ── もやい綱（着岸したら、沖側でない舷の金物から岸壁のボラードへ）──
function _haClearLines() { for (const l of harborAuto.lines) { scene.remove(l); l.geometry.dispose(); } harborAuto.lines = []; }
function _haMakeLines(plan) {
    _haClearLines();
    if (typeof mooringPoints !== 'function') return;
    const S = plan.S, Q = _haQ(S), half = S.quayLen / 2;
    const ext = plan.quayExt || [-half, half];          // 岸壁の端（作り込んだ港は測った長さ）
    const mat = new THREE.LineBasicMaterial({ color: 0xd8c9a0 });
    const pts = mooringPoints().filter(m => m.side === -plan.open);
    for (const m of pts) {
        const q = Q.toQ(m.world.x, m.world.z);
        const lead = m.local.z > 0 ? 1 : -1;
        // 船首側は前へ、船尾側は後ろへ（ヘッドライン・スターンライン）
        const hB = plan.berth.h * _haRad, dirB = Math.sign((Math.sin(hB) * S.sz - Math.cos(hB) * S.sx)) || 1;   // 船首が b の＋向きか
        let bb = q.b + lead * dirB * 20;
        bb = Math.round((bb - ext[0] - 12) / 25) * 25 + ext[0] + 12;
        bb = Math.max(ext[0] + 12, Math.min(ext[1] - 12, bb));
        // 岸壁の縁（作り込んだ港は本物の岸の線：船の横から陸の方へ見て、最初に陸になる所の少し陸側）
        let aL = 4.5;
        if (S.detail && typeof worldSeabedAt === 'function') {
            for (let a = (plan.aB || 20) - 3; a > -40; a -= 1) { const w0 = Q.toW(a, bb); if (worldSeabedAt(w0.x, w0.z) > 0.3) { aL = a - 1.5; break; } }
        }
        const w = Q.toW(aL, bb);
        // 金物から舷の縁（クリートは舷の外へ索を出す）を通って岸壁のボラードへ
        const sd = Math.sign(m.local.x) || m.side, hw = (typeof _tugHalfWidth === 'function') ? _tugHalfWidth(m.local.z) : Math.abs(m.local.x);
        const edge = shipGroup.localToWorld(new THREE.Vector3(sd * Math.max(hw, Math.abs(m.local.x)) * 1.01, m.local.y, m.local.z));
        const g = new THREE.BufferGeometry().setFromPoints([m.world.clone(), edge, new THREE.Vector3(w.x, 3.7, w.z)]);
        const l = new THREE.Line(g, mat); l.frustumCulled = false;
        scene.add(l); harborAuto.lines.push(l);
    }
    harborAuto.linePose = { x: physics.cgWorldX, z: physics.cgWorldZ };
}

// ── 毎フレーム ──
function updateHarborAuto(t, dt) {
    // 着岸した状態で始めたときのもやい綱（船の位置が画面に反映されてから張る）
    if (harborAuto.pendingLines && ++harborAuto.pendingT > 3) { _haMakeLines(harborAuto.pendingLines); harborAuto.pendingLines = null; }
    // 綱を取っている間に船が動いたら綱を外す
    if (harborAuto.lines.length && harborAuto.linePose && Math.hypot(physics.cgWorldX - harborAuto.linePose.x, physics.cgWorldZ - harborAuto.linePose.z) > 4) _haClearLines();
    // 離岸のあと待たせているタグ：航路が決まらない・狭くない航路なら帰す
    if (tugEscort.held && !harborAuto.mode) {
        tugEscort.held.t += Math.max(0, dt || 0);
        const ap = typeof autopilot !== 'undefined' ? autopilot : null;
        if (!ap || (!ap.planning && !ap.active) || tugEscort.held.t > 900) tugEscortStop();
    }
    if (!harborAuto.mode) return;
    dt = Math.min(2, Math.max(0, dt || 0));
    if (!window.world || world.mode !== 'world') { harborAutoStop('世界を航海するモードではないので止めました'); return; }
    if ((typeof keys !== 'undefined' && (keys.a || keys.d)) || (typeof _br !== 'undefined' && _br.wheelDrag)) { harborAutoStop('手で舵を取ったので、自動の離着岸を止めました'); return; }
    const P = harborAuto.plan;
    harborAuto.phaseT += dt;
    const next = (ph, msg) => { harborAuto.phase = ph; harborAuto.phaseT = 0; _haMsg(msg); };
    const TL = _haTugs();
    if (!TL.length) { harborAutoStop('タグがいなくなったので止めました'); return; }
    // 離岸の最初（岸壁から離す）は沖側の舷のタグだけで押し引きするので、そのタグがそろったかで決める
    const workers = harborAuto.mode === 'depart' ? TL.filter(q => _haSide(q) !== -P.open) : TL;
    const RS = _haReadyState(workers.length ? workers : TL, harborAuto.phase === 'tugs' ? harborAuto.phaseT : 0), ready = RS.ok;
    // 一部のタグが入れないまま始めるときは、そう知らせる
    const partialMsg = () => !RS.partial ? '' : RS.stuck > 0
        ? `（${RS.stuck}隻は今は入れないので、入れるようになったら加わります${RS.all - RS.on - RS.stuck > 0 ? `。ほかの${RS.all - RS.on - RS.stuck}隻は着きしだい加わります` : ''}）`
        : `（残りの${RS.all - RS.on}隻は着きしだい加わります）`;
    if (harborAuto.mode === 'berth') {
        if (harborAuto.phase === 'tugs') {
            _haControl({ x: P.turn.x, z: P.turn.z, h: physics.heading }, dt, { vA: 0.4 });
            for (const q of TL) q.autoPower = 0;
            if (ready) next('turn', `${P.port.name}：タグ${RS.on}隻で岸壁と平行に回しています${partialMsg()}`);
            else if (harborAuto.phaseT > 900) harborAutoStop('タグが持ち場に着けないので止めました');
        } else if (harborAuto.phase === 'turn') {
            // 回す所（軍港などでは港口の線から横へずれた所）に着くまでは、向きを保ったまま横へ運ぶ
            //（途中で回すと、船尾が桟橋の軍艦などを払ってしまう）
            const dTurn = Math.hypot(P.turn.x - physics.cgWorldX, P.turn.z - physics.cgWorldZ);
            if (harborAuto.holdH === undefined || harborAuto.holdH === null) harborAuto.holdH = physics.heading;
            const moving = dTurn > 40 && !harborAuto.turning;
            if (!moving) harborAuto.turning = true;
            const e = _haControl({ x: P.turn.x, z: P.turn.z, h: moving ? harborAuto.holdH : P.berth.h }, dt, { vA: 0.3, r: 0.006 });
            if (!moving && Math.abs(e.eY) < 2.5 && Math.abs(e.r) < 0.002) {
                if (P.dock) next('enter', `${P.port.name}：タグに付き添われて、ドックへまっすぐ入っています`);
                else next('side', `${P.port.name}：タグで岸壁へ寄せています`);
            }
        } else if (harborAuto.phase === 'enter') {
            // ドックの真ん中の線に沿って、岸壁の前まで（前後は機関と、船首・船尾のタグの前後の引き）
            const e = _haControl({ x: P.mid.x, z: P.mid.z, h: P.berth.h }, dt, { vA: 0.5, vS: 0.2, r: 0.003 });
            harborAuto.remain = Math.abs(e.eA);
            if (Math.abs(e.eA) < 12 && Math.abs(e.eS) < 5 && Math.abs(e.eY) < 2 && Math.abs(physics.speed || 0) < 0.3) next('side', `${P.port.name}：タグで岸壁へ寄せています`);
        } else if (harborAuto.phase === 'side') {
            const e = _haControl(P.berth, dt, { vA: 0.3, vS: 0.35, r: 0.003, openOnly: true });
            harborAuto.remain = Math.abs(e.eS);
            if (Math.abs(e.eS) < 0.8 && Math.abs(e.eA) < 15 && Math.abs(e.eY) < 1.5 && Math.abs(e.vS) < 0.06 && Math.abs(physics.speed || 0) < 0.15) {
                _tugShip.vSway = 0; _tugShip.yawRate = 0; physics.speed = 0; physics.turnRate = 0;
                _apOrder(0);
                _haMakeLines(P);
                tugReleaseAll();
                harborAuto.mode = null; harborAuto.phase = '';
                for (const q of (window.tugs || [])) { delete q.autoPower; delete q.awaySide; }
                _haMsg(`${P.port.name}に着岸しました。もやい綱を取り、タグを帰します`);
            }
        }
    } else if (harborAuto.mode === 'depart') {
        const Q = _haQ(P.S);
        const q = Q.toQ(physics.cgWorldX, physics.cgWorldZ);
        const off = Q.toW(P.aE, (P.bC || 0) + (q.b - (P.bC || 0)) * 0.5);
        if (harborAuto.phase === 'tugs') {
            _haControl({ x: physics.cgWorldX, z: physics.cgWorldZ, h: physics.heading }, dt, { vA: 0.2, openOnly: true });
            for (const x of TL) x.autoPower = 0;
            if (ready) next('off', `${P.port.name}：タグ${RS.on}隻で岸壁から離しています${partialMsg()}`);
            else if (harborAuto.phaseT > 900) harborAutoStop('タグが持ち場に着けないので止めました');
        } else if (harborAuto.phase === 'off') {
            const e = _haControl({ x: off.x, z: off.z, h: P.dock ? P.berth.h : physics.heading }, dt, { vA: 0.2, vS: 0.35, r: 0.002, openOnly: true });
            if (q.a > P.aE - 15) {
                if (P.dock) { harborAuto.holdH = physics.heading; next('back', `${P.port.name}：タグに付き添われて、ドックから後ろへまっすぐ出ています`); }
                else next('turn', `${P.port.name}：港口の方へ回しています`);
            }
        } else if (harborAuto.phase === 'back') {
            // ドックの真ん中の線に沿って、入口の外の回す所まで後ろへ（向きはそのまま）
            const e = _haControl({ x: P.turn.x, z: P.turn.z, h: harborAuto.holdH }, dt, { vA: 0.5, vS: 0.2, r: 0.003 });
            harborAuto.remain = e.dist;
            if (e.dist < 30 && Math.abs(physics.speed || 0) < 0.4) next('turn', `${P.port.name}：港口の方へ回しています`);
        } else if (harborAuto.phase === 'turn') {
            const tp = P.dock ? P.turn : off;
            const e = _haControl({ x: tp.x, z: tp.z, h: P.hOut }, dt, { vA: 0.3, r: 0.006 });
            if (Math.abs(e.eY) < 4 && Math.abs(e.r) < 0.003) {
                const then = harborAuto.then;
                // 続けて自動航行するときは、航路が狭ければそのまま付き添えるよう、航路が決まるまでタグを待たせる
                if (then) tugEscort.held = { ids: harborAuto.tugIds.slice(), t: 0 };
                else tugReleaseAll();
                harborAuto.mode = null; harborAuto.phase = '';
                for (const x of (window.tugs || [])) { delete x.autoPower; delete x.awaySide; if (then && x.state !== 'leaving') x.action = 'standby'; }
                _haMsg(then ? `${P.port.name}を離岸しました` : `${P.port.name}を離岸しました。タグを帰します`);
                if (then && typeof autopilotStart === 'function') autopilotStart(then);
            }
        }
    }
}
window.updateHarborAuto = updateHarborAuto;
