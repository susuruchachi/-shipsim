// ════════════════════════════════════════════════════════════════
//  他の船の被害：魚雷・砲弾・衝突で穴があき、浸水して傾き、沈む
// ════════════════════════════════════════════════════════════════
//  他の船は細かい形が分からないので、上から見た形（59-traffic.js の _tfShapeHW）を縦に伸ばした船体
//  （長さ L・幅 B・喫水 d・乾舷は描く模型と同じ）を、水密隔壁で前後に仕切る（保存した船はその船の
//  「水密区画」の設定、ほかは全長の等分・主甲板まで）。区画ごとの水は 63-flooding.js と同じ式：
//  穴から Q = 0.6 × 面積 × √(2gh)、隔壁の上を越えて（縦の傾き込みで）となりへ、甲板が沈めば上から。
//  水の重さで喫水が増え（水線面積で割る）、前後の偏りで縦に傾き（水線面の二次モーメント）、
//  穴の側に水がかたよって横に傾く。予備浮力を超えたら沈む（重い方から・横倒しにも）。沈み切ったら消える。
//  被弾した船は機関を止めて漂う（状態 'damaged'。59 の _tfRules では止まっている船としてよける）。

const TFD_RHO = 1025, TFD_G = 9.81;
const shipHits = { list: [], t: 0 };
window.shipHits = shipHits;

// 描く模型と同じ乾舷（59-traffic.js の _tfBuildMesh）
function _tfdFreeboard(S) {
    const look = (typeof _tfClassOf === 'function' ? _tfClassOf(S).look : '') || '';
    if (S.saved && S.saved.cfg && S.saved.cfg.physics) return Math.max(4, Math.min(14, S.L * 0.045));
    return look === 'fishing' ? 2.2 : look === 'destroyer' ? 4.5 : look === 'carrier' ? 9 : look === 'cruise' || look === 'ferry' ? 8 : Math.max(5, Math.min(12, S.L * 0.045));
}
function _tfdInit(S) {
    if (S.dmg) return S.dmg;
    const L = S.L, B = S.B, d = S.d, D = d + _tfdFreeboard(S);
    const wt = S.saved && S.saved.cfg && S.saved.cfg.watertight;
    let cuts, tops;
    if (wt && Number.isFinite(+wt.tN) && Array.isArray(wt.tz) && wt.tz.length === +wt.tN && wt.tN > 0) {
        cuts = [-L / 2].concat(wt.tz.map(u => Math.max(-L / 2 + 2, Math.min(L / 2 - 2, (+u || 0) * L / 2))).sort((x, y) => x - y)).concat([L / 2]);
        tops = (wt.th || []).map(h => Math.max(0.05, Math.min(1.5, +h || 1)) * D);
    } else {
        const n = Math.max(3, Math.min(20, Math.round(L / 22)));
        cuts = [-L / 2]; for (let j = 1; j <= n; j++) cuts.push(-L / 2 + L * j / (n + 1)); cuts.push(L / 2);
        tops = new Array(n).fill(D);
    }
    const comps = [];
    for (let i = 0; i < cuts.length - 1; i++) {
        let A = 0; const n = 8, da = (cuts[i + 1] - cuts[i]) / n;
        for (let k = 0; k < n; k++) A += 2 * _tfShapeHW(S, cuts[i] + (k + 0.5) * da) * da;
        A = Math.max(1, A * 0.92);
        comps.push({ a0: cuts[i], a1: cuts[i + 1], am: (cuts[i] + cuts[i + 1]) / 2, A, v: 0, vmax: A * D, lv: 0, dv: 0 });
    }
    let Awp = 0, IL = 0;
    for (const c of comps) { const l = c.a1 - c.a0; Awp += c.A; IL += c.A * (c.am * c.am + l * l / 12); }
    S.dmg = { L, B, d, D, comps, tops, holes: [], Awp, IL, reserve: TFD_RHO * Awp * (D - d) * 0.95, sink: 0, trim: 0, heel: 0, side: 0, mass: 0, fires: [], sinkT: -1, born: (typeof traffic !== 'undefined' ? traffic.t : 0) };
    if (!shipHits.list.includes(S)) shipHits.list.push(S);
    return S.dmg;
}
function _tfdComp(M, a) {
    for (let i = 0; i < M.comps.length; i++) if (a <= M.comps[i].a1 + 1e-6) return i;
    return M.comps.length - 1;
}
// 穴をあける：a（船の中の前後[m]、船首が＋）・side（＋左舷 −右舷）・yk（船底からの高さ[m]）・area[m²]
function trafficDamage(S, a, side, yk, area, kind) {
    if (!S || S.st === 'gone' || S.st === 'off') return;
    const M = _tfdInit(S);
    const c = _tfdComp(M, a);
    M.holes.push({ c, a, y: Math.max(0, yk), A: Math.max(0.05, area), side: side < 0 ? -1 : 1, kind });
    M.side += (side < 0 ? -1 : 1) * area;
    if (S.st !== 'damaged') {
        S.st0 = S.st; S.st = 'damaged'; S.steps = null; S.blockBy = null;
        S.tugKeep = 0;
    }
    S.hitT = (typeof traffic !== 'undefined') ? traffic.t : 0;
}
window.trafficDamage = trafficDamage;
// 火災と煙（上部構造に当たったとき・魚雷の後）：a・side・yk の所から黒い煙
function _tfdFire(S, a, side, yk, sec) {
    const M = _tfdInit(S);
    M.fires.push({ a, side, yk, t: sec || 300 });
}

// ── 当たり判定：世界の点 (x, y, z) が、どれかの他の船の船体（船底から、甲板＋上部構造まで）の中なら ──
//  戻り値 { S, a（前後[m]）, s（横[m]、＋左舷）, yk（船底からの高さ[m]）, top（甲板の高さ）, H }
function trafficHitAt(x, y, z, pad) {
    if (typeof traffic === 'undefined' || !traffic.on || !traffic.ships || typeof _tfHullOf !== 'function') return null;
    pad = pad || 0;
    for (const S of traffic.ships) {
        if (!_tfShown(S) || !(S.dPl < 40000) || !S.mesh) continue;
        const H = _tfHullOf(S); if (!H) continue;
        const dx = x - H.x, dz = z - H.z, R = S.L / 2 + pad + 5;
        if (dx * dx + dz * dz > R * R) continue;
        const a = dx * H.fx + dz * H.fz, s = dx * H.sx + dz * H.sz;
        if (Math.abs(a) > S.L / 2 + pad) continue;
        const hw = _tfShapeHW(S, a);
        if (Math.abs(s) > hw + pad) continue;
        // 船底の高さ：描く船の原点（喫水線。沈んだ分も下がっている）から喫水だけ下。船首が下がれば前ほど低い
        const M = S.dmg, keel = S.mesh.position.y - S.d - (M ? a * Math.tan(M.trim) : 0);
        const yk = y - keel;
        const deck = S.d + _tfdFreeboard(S), top = deck + Math.min(25, S.L * 0.07);
        if (yk < -0.3 || yk > top) continue;
        return { S, a, s, yk, deck, top, H };
    }
    return null;
}
window.trafficHitAt = trafficHitAt;
// 1 フレームに動いた線分（速い弾が細い船を飛び越さないように、2m おきに調べる）
function trafficHitSeg(x0, y0, z0, x1, y1, z1, pad) {
    const L = Math.hypot(x1 - x0, y1 - y0, z1 - z0), n = Math.max(1, Math.min(80, Math.ceil(L / 2)));
    // （まず線分の終わりの近くに船があるか：無ければ調べない）
    if (typeof traffic === 'undefined' || !traffic.on || !traffic.ships) return null;
    for (let i = 1; i <= n; i++) {
        const u = i / n, h = trafficHitAt(x0 + (x1 - x0) * u, y0 + (y1 - y0) * u, z0 + (z1 - z0) * u, pad);
        if (h) return h;
    }
    return null;
}
window.trafficHitSeg = trafficHitSeg;

// 魚雷が当たった（54-submarine.js から）：喫水線の下に大きな穴（区画 1〜2 つ）と火災
function trafficTorpedoHit(h) {
    const S = h.S, M = _tfdInit(S);
    const y = Math.max(0.5, Math.min(h.yk, S.d - 1));
    const area = S.L < 90 ? 10 : 18;
    trafficDamage(S, h.a, h.s, y, area, 'torpedo');
    // 爆発で隣の区画の隔壁も破れることがある
    const c = _tfdComp(M, h.a), cc = M.comps[c];
    if (cc && Math.random() < 0.5) { const na = h.a - cc.am > 0 ? Math.min(S.L / 2 - 1, cc.a1 + 3) : Math.max(-S.L / 2 + 1, cc.a0 - 3); trafficDamage(S, na, h.s, y, area * 0.35, 'torpedo'); }
    _tfdFire(S, h.a, h.s, S.d + 1, 240);
    if (typeof _tfMsg === 'function') _tfMsg(`${S.name} に魚雷が命中！`);
    return S;
}
window.trafficTorpedoHit = trafficTorpedoHit;
// 砲弾が当たった（55-ship-types.js から）：舷側なら穴（口径で大きさ）、上部構造なら火災。大口径の弾は甲板を貫いて下で炸裂することも
function trafficShellHit(h, cal) {
    const S = h.S, k = (cal || 200) / 1000, area = Math.max(0.4, 60 * k * k);
    if (h.yk < h.deck && Math.abs(h.s) > _tfShapeHW(S, h.a) * 0.6) trafficDamage(S, h.a, h.s, h.yk, area, 'shell');
    else if (cal >= 280 && Math.random() < 0.45) trafficDamage(S, h.a, h.s >= 0 ? 1 : -1, Math.max(0.5, S.d * 0.4), area * 0.5, 'shell');
    else { const M = _tfdInit(S); if (S.st !== 'damaged') { S.st0 = S.st; S.st = 'damaged'; S.steps = null; } }
    _tfdFire(S, h.a, h.s, Math.min(h.yk, h.top), 180 + cal);
    if (typeof _tfMsg === 'function') _tfMsg(`${S.name} に砲弾が命中！`);
    return S;
}
window.trafficShellHit = trafficShellHit;

// ── 毎フレーム：浸水・傾き・沈む・火災の煙 ──
function _tfdStep(S, dt) {
    const M = S.dmg;
    // 漂う（機関を止めて、ゆっくり止まる）
    if (S.st === 'damaged') {
        S.v = (S.v || 0) * Math.exp(-dt / 80);
        if (S.v > 0.02 && typeof _tfOff === 'function') { const q = _tfOff(S, S.hdg, S.v * dt); S.lat = q.lat; S.lon = q.lon; }
    }
    if (M.sinkT >= 0) {
        // 沈んでいく：だんだん速く。重い方へ傾き、横にも
        M.sinkT += dt;
        M.sink += dt * (0.04 + 0.012 * M.sinkT);
        const tt = Math.sign(M.trimDir || M.trim || 1) * Math.min(0.75, 0.12 + M.sinkT * 0.004);
        M.trim += (tt - M.trim) * Math.min(1, dt / 25);
        const ht = Math.sign(M.side || 1) * (M.capsize ? 1.5 : 0.35);
        M.heel += (ht - M.heel) * Math.min(1, dt / (M.capsize ? 40 : 60));
        // 油と浮いてくる物
        if (S.dPl < 6000 && typeof puffEmit === 'function' && S.mesh && Math.random() < dt * 2) {
            const p = S.mesh.position, r = Math.random() * S.L * 0.4, an = Math.random() * Math.PI * 2;
            puffEmit({ x: p.x + Math.cos(an) * r, y: (typeof getOceanHeight === 'function' ? getOceanHeight(p.x, p.z, 0) : 0) + 0.05, z: p.z + Math.sin(an) * r, vx: 0, vy: 0.05, vz: 0, r: 0.08, g: 0.08, b: 0.09, a: 0.35, s0: 3, s1: 14, life: 60, rise: 0, drag: 2 });
        }
        if (M.sink > M.D + 12 + Math.abs(Math.sin(M.trim)) * S.L * 0.5) {
            S.st = 'gone'; S.noRespawn = !!S.saved;
            if (typeof _tfMsg === 'function') _tfMsg(`${S.name} が沈みました（${Math.round((traffic.t - M.born) / 60)} 分）`);
            if (typeof _trMsgSafe === 'function' && S.dPl < 15000) _trMsgSafe(`${S.name} が沈みました`);
        }
        return;
    }
    const n = Math.min(40, Math.max(1, Math.ceil(dt / 0.5))), h = dt / n, tg = (x) => Math.tan(x);
    for (let it = 0; it < n; it++) {
        const dAt = (a) => M.d + M.sink + a * tg(M.trim);
        for (const c of M.comps) { c.lv = c.v / c.A; c.dv = 0; }
        for (const H of M.holes) {
            const c = M.comps[H.c];
            const out = dAt(H.a) + H.side * (M.B / 2) * Math.sin(M.heel), top = Math.max(H.y, c.lv);
            if (out > top) c.dv += 0.6 * H.A * Math.sqrt(2 * TFD_G * (out - top)) * h;
        }
        for (let i = 0; i < M.comps.length - 1; i++) {
            const A = M.comps[i], B = M.comps[i + 1], ab = A.a1, top = M.tops[i] ?? M.D;
            const la = A.lv + (ab - A.am) * tg(M.trim), lb = B.lv + (ab - B.am) * tg(M.trim);
            const Hc = la >= lb ? A : B, Lc = Hc === A ? B : A, lh = Math.max(la, lb), ll = Math.min(la, lb);
            if (!(lh > top) || !(Hc.v > 0)) continue;
            let q = 0.42 * M.B * 0.9 * Math.sqrt(2 * TFD_G) * (Math.pow(lh - top, 1.5) - Math.pow(Math.max(0, ll - top), 1.5)) * h;
            q = Math.min(q, Hc.v + Hc.dv, (lh - ll) * Hc.A * Lc.A / (Hc.A + Lc.A), Lc.vmax - Lc.v - Lc.dv);
            if (q > 0) { Hc.dv -= q; Lc.dv += q; }
        }
        for (const c of M.comps) {
            const out = dAt(c.am);
            if (out > M.D) c.dv += 0.6 * Math.max(2, c.A * 0.03) * Math.sqrt(2 * TFD_G * (out - Math.max(M.D, c.lv))) * h;
            // 大きく傾くと、低い側の舷窓・扉（甲板の 2.5m 下）が水に入る
            const low = out + (M.B / 2) * Math.abs(Math.sin(M.heel)) - (M.D - 2.5);
            if (Math.abs(M.heel) > 0.1 && low > 0) c.dv += 0.6 * 0.6 * Math.sqrt(2 * TFD_G * low) * h;
        }
        let m = 0, ma = 0;
        for (const c of M.comps) { c.v = Math.max(0, Math.min(c.vmax, c.v + c.dv)); m += c.v * TFD_RHO; ma += c.v * TFD_RHO * c.am; }
        M.mass = m;
        // 釣り合いへ（ゆっくり）：喫水は水線面積、縦の傾きは水線面の二次モーメントで
        const sinkT = m / (TFD_RHO * M.Awp), trimT = Math.atan(ma / (TFD_RHO * M.IL));
        M.sink += (sinkT - M.sink) * Math.min(1, h / 15);
        M.trim += (trimT - M.trim) * Math.min(1, h / 25);
        M.trimDir = ma;
    }
    // 横：穴の側へ水がかたよる（区画いっぱいになるまで）
    const frac = M.mass / Math.max(1, M.reserve);
    const heelT = Math.sign(M.side || 1) * Math.min(0.4, 0.55 * frac);
    M.heel += (heelT - M.heel) * Math.min(1, dt / 30);
    if (frac > 0.98) {
        M.sinkT = 0;
        M.capsize = Math.abs(M.heel) > 0.25 || Math.random() < 0.25;
        if (typeof _tfMsg === 'function') _tfMsg(`${S.name} が沈みはじめました`);
    }
}
function _tfdSmoke(S, dt) {
    const M = S.dmg;
    if (!M.fires.length || !S.mesh || !(S.dPl < 8000) || typeof puffEmit !== 'function') return;
    for (let i = M.fires.length - 1; i >= 0; i--) {
        const f = M.fires[i];
        f.t -= dt;
        if (f.t <= 0 || M.sink > M.D) { M.fires.splice(i, 1); continue; }
        if (Math.random() > dt * 6) continue;
        const hw = _tfShapeHW(S, f.a);
        const p = new THREE.Vector3(f.side * hw * 0.6, f.yk - S.d, f.a).applyMatrix4(S.mesh.matrixWorld);
        const fire = Math.random() < 0.3;
        puffEmit({ x: p.x, y: p.y + 1, z: p.z, vx: (Math.random() - 0.5) * 1.5, vy: 2 + Math.random() * 2, vz: (Math.random() - 0.5) * 1.5,
            r: fire ? 1 : 0.12, g: fire ? 0.45 : 0.11, b: fire ? 0.15 : 0.1, a: fire ? 0.8 : 0.55, s0: fire ? 2 : 3, s1: fire ? 5 : 18 + S.L * 0.05, life: fire ? 0.8 : 10 + Math.random() * 6, rise: fire ? 0.2 : 0.6, drag: 0.6 });
    }
}
// 17-main-loop.js から（他の船の動きのあと）。dt：物理の時間
function updateShipHits(t, dt) {
    if (!shipHits.list.length) return;
    dt = Math.max(0, Math.min(30, dt || 0));
    for (let i = shipHits.list.length - 1; i >= 0; i--) {
        const S = shipHits.list[i];
        if (!S.dmg || S.st === 'gone' || S.st === 'off' || (typeof traffic !== 'undefined' && !traffic.ships.includes(S))) { shipHits.list.splice(i, 1); continue; }
        if (dt > 0) _tfdStep(S, dt);
        _tfdSmoke(S, Math.min(0.2, dt));
    }
}
window.updateShipHits = updateShipHits;
// 描くときに足す：沈み[m]・縦の傾き（船首が下がる＋）・横の傾き（左舷が下がる＋）（59 の _tfVisual から）
function trafficDamagePose(S) { const M = S.dmg; return M ? { sink: M.sink, trim: M.trim, heel: M.heel } : null; }
window.trafficDamagePose = trafficDamagePose;
