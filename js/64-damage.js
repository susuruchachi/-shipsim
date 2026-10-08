// ════════════════════════════════════════════════════════════════
//  船体の損傷（衝突・座礁・魚雷・砲弾で穴があく）と、穴の見た目
// ════════════════════════════════════════════════════════════════
//  ・他の船との衝突（59-traffic.js の _tfContact から）：ぶつかる力（近づく速さと、両方の船の重さから
//    求めた衝突のエネルギー）が大きければ穴があく。自分の船首で当てたときは船首（水面の上が多い）、
//    舷側に当てられたときは喫水線の少し下。軽く触れただけなら、へこむだけ（穴なし）。
//  ・座礁（44-world-terrain.js から）：船底がいちばん強く当たった所。ゆっくり（2kn ほどまで）なら何もなし、
//    少し速ければ外板だけ破れて二重底の中までしか水が入らない、速ければ内底板まで破れて区画に入る。
//  ・魚雷・砲弾（54-submarine.js・55-ship-types.js）：当たった所に、大きな穴。
//  穴の見た目：当たった所の外板に、ぎざぎざにめくれた黒い穴（焦げ・さびの縁）を貼る（船に付いて動く）。
//  穴から水が入っている間、水面の近くの穴のまわりは白く泡立つ。

const damage = { decals: [], group: null, tex: {}, lastGround: -1e9, lastHit: {}, t: 0 };
window.damage = damage;
const DM_RHO = 1025;

function _dmMsg(s) {
    if (typeof flood !== 'undefined') { flood.msg = s; flood.msgT = 10; }
    if (typeof _trMsgSafe === 'function') _trMsgSafe(s);
}
// 世界の位置 → 船体の座標（62-watertight.js の _wt.root の中）
const _dmV = new THREE.Vector3(), _dmM = new THREE.Matrix4();
function _dmToHull(x, y, z) {
    const root = typeof wtRoot === 'function' ? wtRoot() : null;
    if (!root) return null;
    _dmM.copy(root.matrixWorld).invert();
    _dmV.set(x, y, z).applyMatrix4(_dmM);
    return { p: _dmV.x, y: _dmV.y, a: _dmV.z };
}
// 船体の外板の上の点（高さ y・前後 a の、p の側の舷）
function _dmOnHull(a, p, y) {
    const w = typeof wtHW === 'function' ? wtHW(y, a) : 0;
    return { a, y, p: (p < 0 ? -1 : 1) * w };
}

// ── 穴の見た目 ──
// ぎざぎざにめくれた穴の絵（キャンバスで一度だけ描く。kind：'hole' 黒い穴・'dent' へこみ・'scorch' 焦げ）
function _dmTexture(kind) {
    if (damage.tex[kind]) return damage.tex[kind];
    const N = 256, cv = document.createElement('canvas'); cv.width = cv.height = N;
    const ctx = cv.getContext('2d'), c = N / 2;
    let seed = kind === 'hole' ? 7 : kind === 'dent' ? 13 : 29;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const blob = (r0, jag, n) => { ctx.beginPath(); for (let i = 0; i <= n; i++) { const a = i / n * Math.PI * 2, r = r0 * (1 - jag + jag * 2 * rnd()); const x = c + Math.cos(a) * r, y = c + Math.sin(a) * r * 0.8; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); } ctx.closePath(); };
    if (kind === 'hole' || kind === 'scorch') {
        // 焦げとさびのにじみ
        const g = ctx.createRadialGradient(c, c, N * 0.1, c, c, N * 0.5);
        g.addColorStop(0, 'rgba(25,18,12,0.95)'); g.addColorStop(0.55, 'rgba(60,35,20,0.6)'); g.addColorStop(1, 'rgba(60,35,20,0)');
        ctx.fillStyle = g; blob(N * 0.48, 0.25, 40); ctx.fill();
    }
    if (kind === 'hole') {
        // めくれた鋼板の縁（明るい灰色の裂け目）と、中の暗い穴
        ctx.fillStyle = 'rgba(120,112,100,0.95)'; blob(N * 0.3, 0.35, 28); ctx.fill();
        ctx.fillStyle = 'rgba(4,4,6,1)'; blob(N * 0.24, 0.4, 24); ctx.fill();
        ctx.strokeStyle = 'rgba(170,160,145,0.8)'; ctx.lineWidth = 3;
        for (let i = 0; i < 9; i++) { const a = rnd() * Math.PI * 2, r0 = N * 0.22, r1 = N * (0.3 + rnd() * 0.12); ctx.beginPath(); ctx.moveTo(c + Math.cos(a) * r0, c + Math.sin(a) * r0 * 0.8); ctx.lineTo(c + Math.cos(a + 0.12) * r1, c + Math.sin(a + 0.12) * r1 * 0.8); ctx.stroke(); }
    } else if (kind === 'dent') {
        const g = ctx.createRadialGradient(c - N * 0.08, c - N * 0.08, 2, c, c, N * 0.45);
        g.addColorStop(0, 'rgba(0,0,0,0.55)'); g.addColorStop(0.6, 'rgba(40,30,25,0.35)'); g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g; blob(N * 0.45, 0.2, 30); ctx.fill();
        ctx.strokeStyle = 'rgba(150,140,130,0.5)'; ctx.lineWidth = 2;
        for (let i = 0; i < 6; i++) { const y = c + (rnd() - 0.5) * N * 0.5; ctx.beginPath(); ctx.moveTo(c - N * 0.3, y); ctx.lineTo(c + N * 0.3, y + (rnd() - 0.5) * 20); ctx.stroke(); }
    }
    const tex = new THREE.CanvasTexture(cv);
    if (THREE.sRGBEncoding) tex.encoding = THREE.sRGBEncoding;
    tex.anisotropy = 4;
    return (damage.tex[kind] = tex);
}
function _dmGroup() {
    if (!damage.group) { damage.group = new THREE.Group(); damage.group.name = 'damage-decals'; damage.group.matrixAutoUpdate = false; }
    if (typeof scene !== 'undefined' && scene && damage.group.parent !== scene) scene.add(damage.group);
    return damage.group;
}
// 穴の絵を、船体の座標の (a, p, y) の外板に貼る。area[m²]
function damageDecalAt(a, p, y, area, kind) {
    const root = typeof wtRoot === 'function' ? wtRoot() : null;
    if (!root) return null;
    const sc = physics.scale || 1;
    const q = _dmOnHull(a, p, y);
    const tk = kind === 'dent' ? 'dent' : kind === 'scorch' ? 'scorch' : 'hole';
    const mat = new THREE.MeshStandardMaterial({ map: _dmTexture(tk), transparent: true, depthWrite: false, roughness: 0.9, metalness: 0.1 });
    if (typeof depthBiasMaterial === 'function') depthBiasMaterial(mat, -0.0008);      // 船体の面より手前に（ちらつかないように）
    // 穴の絵は、穴そのものより少し大きく（焦げ・めくれた縁の分）
    const size = Math.max(1.2, Math.sqrt(Math.max(0.05, area)) * (tk === 'hole' ? 2.2 : 1.6)) / sc;
    const geo = new THREE.PlaneGeometry(size * 1.25, size);
    const m = new THREE.Mesh(geo, mat);
    // 外板の向き：舷側は外向き（左舷は +perp）。船底は下向き
    const D = typeof wtDims === 'function' ? wtDims() : null;
    const bottom = D && y < D.yBot + (D.yWL - D.yBot) * 0.12 && Math.abs(q.p) < (typeof wtHW === 'function' ? wtHW(D.yWL, a) : 1) * 0.7;
    if (bottom) { m.rotation.x = Math.PI / 2; m.position.set(p, D.yBot - 0.01 / sc, a); }
    else { m.rotation.y = q.p >= 0 ? Math.PI / 2 : -Math.PI / 2; m.position.set(q.p + Math.sign(q.p || 1) * 0.03 / sc, y, a); }
    m.renderOrder = 2; m.userData = { noLightBake: true, noSolid: true };
    m.castShadow = false; m.receiveShadow = true;
    _dmGroup().add(m);
    damage.decals.push(m);
    return m;
}
window.damageDecalAt = damageDecalAt;
function damageClearDecals() {
    for (const m of damage.decals) { if (m.parent) m.parent.remove(m); m.geometry.dispose(); m.material.dispose(); }
    damage.decals = [];
}
window.damageClearDecals = damageClearDecals;

// ── 穴をあける（ここから浸水：63-flooding.js）──
//  a・p・y：船体の座標。area[m²]。inner：二重底の内底板まで破れたか
function damageHole(a, p, y, area, kind, inner) {
    const q = _dmOnHull(a, p, y);
    if (typeof floodAddHole === 'function') floodAddHole(q.a, q.p, q.y, area, kind, inner);
    damageDecalAt(q.a, q.p, q.y, area, kind);
}
window.damageHole = damageHole;

// ── 衝突（59-traffic.js の _tfContact から）──
//  c：触れた所（世界の x・z）、SA・SB：他の船（SA が null なら自分の船と SB）、vn：近づく速さ[m/s]、mA・mB：重さ[kg]（動かない船は Infinity）
function damageCollision(c, SA, SB, vn, mA, mB) {
    if (!(vn > 0.25)) return;
    const mE = !Number.isFinite(mA) ? mB : !Number.isFinite(mB) ? mA : mA * mB / (mA + mB);
    if (!(mE > 0)) return;
    const E = 0.5 * mE * vn * vn / 1e6;            // 衝突のエネルギー[MJ]
    const key = (SA ? SA.id : 'P') + '-' + (SB ? SB.id : 'x');
    const now = (typeof traffic !== 'undefined' && traffic.t) || performance.now() / 1000;
    if (now - (damage.lastHit[key] ?? -1e9) < 10) return;
    damage.lastHit[key] = now;
    // 他の船の側の穴（65-ship-hits.js）：当てられた舷側に
    if (E >= 8 && typeof trafficDamage === 'function' && typeof _tfHullOf === 'function') {
        for (const X of [SA, SB]) {
            if (!X || X.st === 'gone') continue;
            const H = _tfHullOf(X); if (!H) continue;
            const dx = c.px - H.x, dz = c.pz - H.z, a = dx * H.fx + dz * H.fz, s = dx * H.sx + dz * H.sz;
            const bowX = a > X.L * 0.42;
            const ar = Math.min(25, 0.08 * Math.pow(E - 8, 0.75)) * (bowX ? 0.4 : 1);
            trafficDamage(X, a, s, bowX ? X.d + 1 : Math.max(0.5, X.d * 0.6), ar, 'collision');
        }
    }
    if (SA) return;                                  // （他の船どうし：自分の船は無事）
    const D = typeof wtDims === 'function' ? wtDims() : null;
    if (!D) return;
    const sc = physics.scale || 1, T = (D.yWL - D.yBot) * sc;
    const wl = Number.isFinite(window._physicsWaveY) ? window._physicsWaveY : 0;
    const h = _dmToHull(c.px, wl, c.pz); if (!h) return;
    const nm = SB ? SB.name : '';
    // 船首で当てた（自分の船首の 8％ の所）
    const bow = h.a > D.aB - (D.aB - D.aS) * 0.08;
    if (E < 8) {
        // へこむだけ
        const y = bow ? D.yWL + 1 / sc : D.yWL - Math.min(2, 0.2 * T) / sc;
        damageDecalAt(h.a, h.p, y, 0.6 + E * 0.15, 'dent');
        _dmMsg(`${nm} と当たり、${bow ? '船首' : '舷側'}の外板がへこみました（穴はあいていません）`);
        return;
    }
    let area = Math.min(25, 0.08 * Math.pow(E - 8, 0.75));
    if (bow) {
        // 船首材がつぶれる：水面の上が多い。船首の先の区画（船首倉）に少し
        area *= 0.5;
        damageHole(h.a, h.p, D.yWL + Math.min(1.5, 0.12 * T) / sc, area, 'collision', false);
        if (area > 1.5) damageHole(h.a, h.p, D.yWL - Math.min(2, 0.2 * T) / sc, area * 0.4, 'collision', false);
        _dmMsg(`${nm} と衝突！ 船首がつぶれました（穴 ${area.toFixed(1)} m²）`);
    } else {
        // 舷側に当てられた：喫水線から相手の船首の下（喫水の 4 割ほど）まで
        const yc = D.yWL - Math.min(4, 0.35 * T) / sc;
        damageHole(h.a, h.p, yc, area, 'collision', false);
        _dmMsg(`${nm} と衝突！ 舷側に穴があき（${area.toFixed(1)} m²）、浸水しています`);
    }
}
window.damageCollision = damageCollision;

// ── 座礁（44-world-terrain.js から）──
//  hits：船底の当たった点（a・s：船の中の前後・横[m]（左舷が＋）、c：めり込み[m]）、v：当たったときの速さ[m/s]
function damageGround(hits, v) {
    if (!hits || !hits.length || !(v > 1.0)) return;
    const now = damage.gt || 0;                      // 物理の時間（早送りでも、8 秒に一度まで）
    if (now - damage.lastGround < 8) return;
    let best = null;
    for (const p of hits) if (!p.dense && (!best || (p.c || 0) > (best.c || 0))) best = p;
    if (!best) return;
    damage.lastGround = now;
    const D = typeof wtDims === 'function' ? wtDims() : null;
    if (!D || typeof shipGroup === 'undefined') return;
    const sc = physics.scale || 1;
    // 船の中の座標（shipGroup）→ 世界 → 船体の座標
    shipGroup.updateMatrixWorld();
    const w = new THREE.Vector3(best.s / sc, D.yBot + 0.1 / sc, best.a / sc).applyMatrix4(shipGroup.matrixWorld);
    const h = _dmToHull(w.x, w.y, w.z); if (!h) return;
    const kn = v / 0.514444;
    const db = (typeof shipWT !== 'undefined' && shipWT.db > 0);
    const yB = D.yBot + 0.15 / sc;
    if (v < 2.5) {
        // 外板だけ破れる：二重底の中まで
        const area = 0.2 + 0.6 * (v - 1);
        if (typeof floodAddHole === 'function') floodAddHole(h.a, h.p, yB, area, 'ground', false);
        damageDecalAt(h.a, h.p, yB, area, 'hole');
        _dmMsg(db ? `座礁（${kn.toFixed(1)} kn）：船底の外板が破れましたが、二重底で止まっています` : `座礁（${kn.toFixed(1)} kn）：船底に穴があき、浸水しています（二重底なし）`);
    } else {
        // 内底板まで破れる。当たった所から後ろへ裂ける
        const area = Math.min(12, 0.8 + 1.2 * (v - 2.5));
        const along = Math.min((D.aB - D.aS) * 0.15, (8 + 6 * (v - 2.5)) / sc);
        if (typeof floodAddHole === 'function') { floodAddHole(h.a, h.p, yB, area, 'ground', true); floodAddHole(h.a - along, h.p, yB, area * 0.6, 'ground', true); }
        damageDecalAt(h.a, h.p, yB, area, 'hole'); damageDecalAt(h.a - along, h.p, yB, area * 0.6, 'hole');
        _dmMsg(`座礁（${kn.toFixed(1)} kn）！ 船底が裂けて内底板まで破れ、浸水しています`);
    }
}
window.damageGround = damageGround;

// ── 毎フレーム：穴の絵を船に付けて動かす・水面近くの穴のまわりの泡 ──
function updateDamage(t, dt) {
    damage.gt = (damage.gt || 0) + Math.max(0, dt || 0);
    if (!damage.decals.length && !(typeof flood !== 'undefined' && flood.holes.length)) return;
    const root = typeof wtRoot === 'function' ? wtRoot() : null;
    if (root && damage.group) { damage.group.matrix.copy(root.matrixWorld); damage.group.matrixWorld.copy(root.matrixWorld); damage.group.matrixWorldNeedsUpdate = true; }
    // 泡（水面から 1.5m の中の穴で、水が入っている間）
    if (!root || typeof puffEmit !== 'function' || !(dt > 0) || typeof flood === 'undefined') return;
    damage.t += dt;
    if (damage.t < 0.12) return;
    damage.t = 0;
    const e = root.matrixWorld.elements;
    for (const h of flood.holes) {
        if (!(h.out > -1e8)) continue;
        const wy = e[1] * h.p + e[5] * h.y + e[9] * h.a + e[13];
        const d = h.out - wy;
        if (d < -0.5 || d > 1.5 || (h.plug || 0) > 0.9) continue;
        const wx = e[0] * h.p + e[4] * h.y + e[8] * h.a + e[12], wz = e[2] * h.p + e[6] * h.y + e[10] * h.a + e[14];
        const n = Math.min(4, 1 + Math.round(Math.sqrt(h.A)));
        for (let i = 0; i < n; i++) puffEmit({ x: wx + (Math.random() - 0.5) * 2, y: h.out + 0.1, z: wz + (Math.random() - 0.5) * 2, vx: (Math.random() - 0.5) * 1.2, vy: 0.3 + Math.random() * 0.6, vz: (Math.random() - 0.5) * 1.2, r: 0.93, g: 0.96, b: 1, a: 0.5, s0: 0.8, s1: 2.5 + Math.sqrt(h.A), life: 2.5, rise: 0, drag: 1.2 });
    }
}
window.updateDamage = updateDamage;
