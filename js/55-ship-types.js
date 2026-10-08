// ============================================================
//  船の種類（クルーズ船・貨物船・オーシャンライナー・軍艦・空母・潜水艦…）と、それに合わせた装備
// ============================================================
//  種類は船体設定の「🚢 船種」で選ぶ（保存データの submarine.type。54-submarine.js の subCfg を共用）。
//  ・地図の埠頭の一覧で、その船に合う埠頭（客船→客船ターミナル、貨物船→貨物港、軍艦→軍港）に印
//  ・軍艦（駆逐艦・巡洋艦・戦艦）：主砲。方位と距離を決めて撃つと、砲弾が弧を描いて飛び、水柱か爆発
//  ・空母：艦載機の発艦・着艦（艦の上空を回る）
//  ・潜水艦：54-submarine.js
const SHIP_TYPES = {
    other:      { label: 'その他（指定なし）', icon: '🚢', berth: null },
    liner:      { label: 'オーシャンライナー', icon: '🛳', berth: ['passenger', 'city'] },
    cruise:     { label: 'クルーズ船', icon: '🛳', berth: ['passenger', 'city'] },
    ferry:      { label: 'フェリー・客船', icon: '⛴', berth: ['passenger', 'city', 'town'] },
    cargo:      { label: '貨物船', icon: '🚢', berth: ['cargo', 'city'] },
    container:  { label: 'コンテナ船', icon: '🚢', berth: ['cargo'] },
    tanker:     { label: 'タンカー', icon: '🚢', berth: ['cargo'] },
    destroyer:  { label: '駆逐艦', icon: '⚓', berth: ['naval'], gun: { cal: 127, n: 2, range: 15, v: 800, reload: 4, plume: 1 } },
    cruiser:    { label: '巡洋艦', icon: '⚓', berth: ['naval'], gun: { cal: 203, n: 3, range: 25, v: 820, reload: 10, plume: 1.6 } },
    battleship: { label: '戦艦', icon: '⚓', berth: ['naval'], gun: { cal: 406, n: 3, range: 35, v: 760, reload: 30, plume: 2.6 } },
    carrier:    { label: '航空母艦', icon: '✈', berth: ['naval'], air: { n: 6 }, gun: { cal: 127, n: 2, range: 15, v: 800, reload: 4, plume: 1 } },
    submarine:  { label: '潜水艦', icon: '🌊', berth: ['naval'] },
};
window.SHIP_TYPES = SHIP_TYPES;
function shipTypeKey() {
    const t = (window.subCfg && subCfg.type) || 'other';
    return SHIP_TYPES[t] ? t : 'other';                       // 古い保存データの 'surface' は「その他」
}
function shipType() { return SHIP_TYPES[shipTypeKey()]; }
window.shipTypeKey = shipTypeKey; window.shipType = shipType;
// その埠頭（港の種類）がこの船に合うか
function shipTypeSuits(portType) { const B = shipType().berth; return !!(B && B.includes(portType)); }
window.shipTypeSuits = shipTypeSuits;

// ════════════════════════════════════════════════════════════
//  主砲
// ════════════════════════════════════════════════════════════
const naval = {
    brg: 0, rangeKm: 8, absolute: false,  // 狙う方位（艦首から右回り＋[度]、absolute なら真方位）・距離
    reload: [], shells: [], planes: [], msg: '', msgT: 0,
};
window.naval = naval;
function _nvMsg(s) { naval.msg = s; naval.msgT = 8; }
function _nvGun() { return shipType().gun || null; }
// 船首の向き（コンパス）
function _nvShipCompass() { return (typeof worldTrueCompass === 'function') ? worldTrueCompass() : ((360 - (physics.heading || 0)) % 360 + 360) % 360; }
// 狙う真方位
function _nvAimCompass() { return naval.absolute ? naval.brg : (_nvShipCompass() + naval.brg + 360) % 360; }
// 真方位 → 物理の面の向き（+x 西・+z 北の面で、船の heading と同じ測り方）
function _nvHeadingOfCompass(c) { return (physics.heading || 0) + (_nvShipCompass() - c); }
// 見ている方へ狙いを合わせる
function navalAimCamera() {
    if (typeof camera === 'undefined') return;
    const d = new THREE.Vector3(); camera.getWorldDirection(d);
    const h = Math.atan2(d.x, d.z) * 180 / Math.PI;                 // 物理の面の向き
    const c = (_nvShipCompass() - (h - (physics.heading || 0)) + 720) % 360;
    naval.brg = naval.absolute ? c : (((c - _nvShipCompass()) + 540) % 360) - 180;
    renderSubPanel();
}
function navalSet(k, v) { naval[k] = v; if (k === 'absolute') naval.brg = v ? Math.round(_nvAimCompass()) : 0; renderSubPanel(); }
window.navalAimCamera = navalAimCamera; window.navalSet = navalSet;

// 砲の数（砲塔の設定があればその数：66-sights.js）
function navalGunCount() { const G = _nvGun(); if (!G) return 0; const T = typeof sightTurrets === 'function' ? sightTurrets() : null; return T && T.length ? T.length : Math.max(1, Math.round(G.n)); }
window.navalGunCount = navalGunCount;
function navalFire() {
    const G = _nvGun();
    if (!G || typeof scene === 'undefined') return;
    const nG = navalGunCount();
    if (naval.reload.length >= nG) { _nvMsg('装填中です'); renderSubPanel(); return; }
    const hp = window.hullProfile, sc = physics.scale || 1;
    const top = (typeof _subHullTopAboveWL === 'function') ? _subHullTopAboveWL() : 6;
    const hd = _nvHeadingOfCompass(_nvAimCompass()), r = hd * Math.PI / 180;
    const fr = (physics.heading || 0) * Math.PI / 180;
    const half = ((hp && hp.ready) ? hp.halfLen : 6) * sc;
    const range = Math.max(0.5, Math.min(G.range, naval.rangeKm)) * 1000;
    // 弾道：狙った点（船の真ん中から、狙った向き・距離）へ、砲塔ごとに向けて撃つ。狙った所で水面の少し上
    //（船の舷側の高さ）に来る仰角。砲は水面より高いので、その分を入れる
    //（空気の抵抗は無し。見やすいよう、飛ぶ時間は実際の 0.6 倍の速さで）
    const g = 9.81, v = G.v;
    const wl0 = Number.isFinite(window._physicsWaveY) ? window._physicsWaveY : 0;
    // 狙う点：照準（66-sights.js：捉えた目標の未来位置・測距儀の十字の所）があればそこ、なければ兵装パネルの方位・距離
    const sol = typeof sightFireSolution === 'function' ? sightFireSolution('gun') : null;
    const aimX = sol ? sol.x : physics.cgWorldX + Math.sin(r) * range, aimZ = sol ? sol.z : physics.cgWorldZ + Math.cos(r) * range;
    if (sol && Math.hypot(aimX - physics.cgWorldX, aimZ - physics.cgWorldZ) > G.range * 1000 * 1.02) { _nvMsg(`射程外です（${(Math.hypot(aimX - physics.cgWorldX, aimZ - physics.cgWorldZ) / 1000).toFixed(1)}km・射程 ${G.range}km）`); renderSubPanel(); return; }
    // 砲塔の位置（66-sights.js：設定が無ければ艦の前後に分けて）
    const TW = typeof sightTurretsWorld === 'function' ? sightTurretsWorld() : null;
    const salvo = Math.max(0, nG - naval.reload.length);
    for (let i = 0; i < salvo; i++) {
        let x, y, z;
        if (TW && TW[i]) { x = TW[i].x; y = TW[i].y; z = TW[i].z; }
        else {
            const along = (i - (salvo - 1) / 2) * half * 0.5 + half * 0.15;
            x = physics.cgWorldX + Math.sin(fr) * along; z = physics.cgWorldZ + Math.cos(fr) * along;
            y = physics.y + top * 0.7;
        }
        const ri = Math.atan2(aimX - x, aimZ - z), R = Math.max(50, Math.hypot(aimX - x, aimZ - z));
        const dyT = (wl0 + 3) - y;                                                // 的の高さ − 砲の高さ
        const disc = v * v * v * v - g * (g * R * R + 2 * dyT * v * v);
        const el = disc >= 0 ? Math.atan((v * v - Math.sqrt(disc)) / (g * R)) : Math.PI / 4;
        const spread = (Math.random() - 0.5) * 0.004 * R;   // ばらつき
        const vx = Math.sin(ri) * Math.cos(el) * v, vz = Math.cos(ri) * Math.cos(el) * v, vy = Math.sin(el) * v;
        const mesh = new THREE.Mesh(_nvShellGeo(), _nvShellMat());
        mesh.position.set(x, y, z);
        scene.add(mesh);
        naval.shells.push({ x, y, z, vx, vy, vz, t: 0, spread, mesh, cal: G.cal, plume: G.plume, sideX: Math.cos(r), sideZ: -Math.sin(r) });
        // 砲口の炎と煙
        if (typeof puffEmit === 'function') {
            const mx = x + Math.sin(r) * 8, mz = z + Math.cos(r) * 8;
            for (let k = 0; k < 6; k++) puffEmit({ x: mx, y, z: mz, vx: Math.sin(r) * (20 + k * 6), vy: 2, vz: Math.cos(r) * (20 + k * 6), r: 1, g: 0.6, b: 0.2, a: 0.9, s0: 2 + G.cal / 100, s1: 6 + G.cal / 40, life: 0.5, rise: 0, drag: 2 });
            for (let k = 0; k < 10; k++) puffEmit({ x: mx, y, z: mz, vx: Math.sin(r) * (8 + k * 3) + (Math.random() - 0.5) * 4, vy: 1 + Math.random() * 2, vz: Math.cos(r) * (8 + k * 3) + (Math.random() - 0.5) * 4, r: 0.55, g: 0.55, b: 0.55, a: 0.55, s0: 3 + G.cal / 60, s1: 14 + G.cal / 15, life: 6 + Math.random() * 4, rise: 0.4, drag: 0.8 });
        }
        naval.reload.push(G.reload);
    }
    // 反動で少し横に傾く
    physics.vRoll += (Math.cos(r - fr) > 0 ? 1 : -1) * Math.sin(r - fr) * 0.002 * G.cal / 127;
    // 「ドーン」
    const A = window.shipAudio;
    if (A && A.ctx && A.ctx.state === 'running' && typeof audioBurst === 'function' && A.buses && A.buses.env) {
        const k = G.cal / 200;
        audioBurst(A.buses.env, { dur: 1.2 + k, attack: 0.005, gain: Math.min(1.6, 0.6 + 0.5 * k), type: 'lowpass', freq: 160 - Math.min(90, k * 40), q: 0.8, kind: 'brown' });
        audioBurst(A.buses.env, { dur: 0.25, attack: 0.002, gain: 0.5, type: 'bandpass', freq: 1200, q: 0.5 });
    }
    if (sol) {
        const ac = ((_nvShipCompass() - (Math.atan2(aimX - physics.cgWorldX, aimZ - physics.cgWorldZ) * 180 / Math.PI - (physics.heading || 0))) % 360 + 360) % 360;
        _nvMsg(`主砲 撃て！ 方位 ${Math.round(ac).toString().padStart(3, '0')}°・距離 ${(Math.hypot(aimX - physics.cgWorldX, aimZ - physics.cgWorldZ) / 1000).toFixed(1)}km${typeof sight !== 'undefined' && sight.lock ? `（${sight.lock.name} の未来位置へ）` : '（測距儀の十字へ）'}`);
    } else _nvMsg(`主砲 撃て！ 方位 ${Math.round(_nvAimCompass()).toString().padStart(3, '0')}°・距離 ${(range / 1000).toFixed(1)}km`);
    renderSubPanel();
}
window.navalFire = navalFire;
let _nvSG = null, _nvSM = null;
function _nvShellGeo() { return _nvSG || (_nvSG = new THREE.SphereGeometry(0.6, 6, 4)); }
function _nvShellMat() { return _nvSM || (_nvSM = new THREE.MeshBasicMaterial({ color: 0xffd090, toneMapped: false })); }
function _nvImpact(S, what) {
    const wave = typeof getWaveHeight === 'function' ? getWaveHeight(S.x, S.z, 0) : 0;
    if (typeof puffEmit === 'function') {
        const k = S.plume;
        if (what === 'water') {
            for (let i = 0; i < 40 * k; i++) {
                const a = Math.random() * Math.PI * 2, s = Math.random();
                puffEmit({ x: S.x + Math.cos(a) * s * 3 * k, y: wave + 0.3, z: S.z + Math.sin(a) * s * 3 * k,
                    vx: Math.cos(a) * (1 + s * 4) * k, vy: (14 + Math.random() * 18) * Math.sqrt(k), vz: Math.sin(a) * (1 + s * 4) * k,
                    r: 0.93, g: 0.96, b: 1, a: 0.7, s0: 2 * k, s1: 9 * k, life: 3 + Math.random() * 2, rise: 0, drag: 0.15, grav: 1 });
            }
        } else {
            for (let i = 0; i < 30 * k; i++) {
                const a = Math.random() * Math.PI * 2, s = Math.random();
                puffEmit({ x: S.x, y: S.y + 1, z: S.z, vx: Math.cos(a) * (3 + s * 10) * k, vy: 4 + Math.random() * 10 * k, vz: Math.sin(a) * (3 + s * 10) * k,
                    r: i < 8 ? 1 : 0.35, g: i < 8 ? 0.55 : 0.32, b: i < 8 ? 0.2 : 0.28, a: 0.8, s0: 3 * k, s1: 14 * k, life: i < 8 ? 0.6 : 6 + Math.random() * 4, rise: 0.5, drag: 1 });
            }
        }
    }
    const A = window.shipAudio;
    if (A && A.ctx && A.ctx.state === 'running' && typeof audioBurst === 'function' && A.buses && A.buses.env) {
        const cam = camera.position, d = Math.hypot(S.x - cam.x, S.z - cam.z), near = Math.max(0.1, 1 - d / 12000);
        audioBurst(A.buses.env, { when: Math.min(6, d / 343), dur: 1.5 + S.plume, attack: 0.01, gain: 0.9 * near * Math.min(1.5, S.plume), type: 'lowpass', freq: 120, q: 0.7, kind: 'brown' });
    }
}
function _nvUpdateShells(dt) {
    const inWorld = window.world && world.mode === 'world' && typeof worldSeabedAt === 'function';
    for (let i = naval.shells.length - 1; i >= 0; i--) {
        const S = naval.shells[i];
        // 見やすいように、飛ぶ時間を縮める（同じ弧を 0.6 倍の時間で）
        const h = dt / 0.6;
        S.t += h;
        const px = S.x, py = S.y, pz = S.z;
        S.x += S.vx * h + S.sideX * S.spread * h / 30; S.z += S.vz * h + S.sideZ * S.spread * h / 30;
        S.vy -= 9.81 * h; S.y += S.vy * h;
        S.mesh.position.set(S.x, S.y, S.z);
        let hit = null;
        const wave = typeof getWaveHeight === 'function' ? getWaveHeight(S.x, S.z, 0) : 0;
        // 他の船に当たった（65-ship-hits.js）
        if (S.t > 0.5 && typeof trafficHitSeg === 'function') {
            const th = trafficHitSeg(px, py, pz, S.x, S.y, S.z, 0.5);
            if (th && typeof trafficShellHit === 'function') { trafficShellHit(th, S.cal); hit = 'ship'; _nvMsg(`${th.S.name} に命中！`); }
        }
        if (!hit && inWorld && worldSeabedAt(S.x, S.z) > S.y) hit = 'land';
        else if (!hit && S.y < wave) hit = 'water';
        if (!hit && S.t > 1) for (const tg of (window.tugs || [])) if (Math.hypot(tg.pos.x - S.x, tg.pos.z - S.z) < 15 && S.y < 12) { hit = 'tug'; _nvMsg(`タグ${tg.id}の近くに着弾！（演習弾）`); break; }
        if (hit || S.t > 200) { _nvImpact(S, hit === 'water' ? 'water' : 'land'); scene.remove(S.mesh); naval.shells.splice(i, 1); }
    }
    for (let i = naval.reload.length - 1; i >= 0; i--) { naval.reload[i] -= dt; if (naval.reload[i] <= 0) naval.reload.splice(i, 1); }
}

// ════════════════════════════════════════════════════════════
//  艦載機（空母）
// ════════════════════════════════════════════════════════════
let _nvPlaneProto = null;
function _nvPlaneMesh() {
    if (!_nvPlaneProto) {
        const g = new THREE.Group(), m = new THREE.MeshStandardMaterial({ color: 0x8a949c, roughness: 0.6, metalness: 0.3 });
        const body = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.4, 12), m); g.add(body);
        const wing = new THREE.Mesh(new THREE.BoxGeometry(11, 0.25, 3), m); wing.position.set(0, 0, 0.5); g.add(wing);
        const tail = new THREE.Mesh(new THREE.BoxGeometry(4.5, 0.2, 1.6), m); tail.position.set(0, 0.2, -5.2); g.add(tail);
        const fin = new THREE.Mesh(new THREE.BoxGeometry(0.2, 2.2, 1.8), m); fin.position.set(0, 1.2, -5.2); g.add(fin);
        _nvPlaneProto = g;
    }
    return _nvPlaneProto.clone();
}
// 甲板の高さ（喫水線から）
function _nvDeckY() { return physics.y + ((typeof _subHullTopAboveWL === 'function') ? _subHullTopAboveWL() : 15) + 1; }
function navalLaunch() {
    const T = shipType();
    if (!T.air) return;
    const up = naval.planes.filter(p => p.state !== 'parked').length;
    if (up >= T.air.n) { _nvMsg('すべての艦載機が飛んでいます'); renderSubPanel(); return; }
    if (naval.planes.some(p => p.state === 'roll')) { _nvMsg('前の機が発艦中です'); renderSubPanel(); return; }
    const hp = window.hullProfile, half = ((hp && hp.ready) ? hp.halfLen : 6) * (physics.scale || 1);
    const mesh = _nvPlaneMesh(); scene.add(mesh);
    naval.planes.push({ state: 'roll', s: -half * 0.6, v: Math.abs(physics.speed || 0) * 0.514, mesh, x: 0, y: 0, z: 0, h: 0, ang: Math.random() * Math.PI * 2, alt: 250 + Math.random() * 150, R: 1500 + Math.random() * 800, id: naval.planes.length + 1 });
    _nvMsg('艦載機、発艦！');
    renderSubPanel();
}
function navalRecover() {
    let n = 0;
    for (const p of naval.planes) if (p.state === 'orbit') { p.state = 'return'; n++; }
    _nvMsg(n ? `${n} 機を着艦させます` : '飛んでいる機はありません');
    renderSubPanel();
}
window.navalLaunch = navalLaunch; window.navalRecover = navalRecover;
function _nvUpdatePlanes(dt) {
    if (!naval.planes.length) return;
    const hp = window.hullProfile, half = ((hp && hp.ready) ? hp.halfLen : 6) * (physics.scale || 1);
    const fr = (physics.heading || 0) * Math.PI / 180, fx = Math.sin(fr), fz = Math.cos(fr);
    const shipV = (physics.speed || 0) * 0.514, deck = _nvDeckY();
    for (let i = naval.planes.length - 1; i >= 0; i--) {
        const P = naval.planes[i];
        if (P.state === 'roll') {
            // 甲板を走って（カタパルトで 3 秒ほどで 70m/s）、艦首から飛び立つ
            P.v += 22 * dt; P.s += (P.v - shipV) * dt;
            P.x = physics.cgWorldX + fx * P.s; P.z = physics.cgWorldZ + fz * P.s; P.y = deck; P.h = fr;
            if (P.s > half) { P.state = 'climb'; P.vy = 4; }
        } else if (P.state === 'climb' || P.state === 'orbit') {
            // 艦の上空を半径 R で回る
            const cx = physics.cgWorldX, cz = physics.cgWorldZ;
            const want = Math.atan2(P.x - cx, P.z - cz) + Math.PI / 2;           // 円の接線（左回り）
            const dist = Math.hypot(P.x - cx, P.z - cz);
            let tgtH = want + Math.max(-0.6, Math.min(0.6, (dist - P.R) / P.R));
            if (P.state === 'climb' && dist < P.R * 0.6) tgtH = fr;
            let d = Math.atan2(Math.sin(tgtH - P.h), Math.cos(tgtH - P.h));
            P.h += Math.max(-0.35 * dt, Math.min(0.35 * dt, d));
            P.v = Math.min(110, P.v + 8 * dt);
            P.x += Math.sin(P.h) * P.v * dt; P.z += Math.cos(P.h) * P.v * dt;
            P.y += Math.max(-8, Math.min(12, (P.alt - P.y) * 0.2)) * dt;
            P.bank = -d * 1.2;
            if (P.state === 'climb' && P.y > P.alt * 0.8) P.state = 'orbit';
        } else if (P.state === 'return') {
            // 艦の後ろ 3km から、艦と同じ向きで降りてきて、甲板に降りる
            const ax = physics.cgWorldX - fx * (half + 3000), az = physics.cgWorldZ - fz * (half + 3000);
            if (!P.final) {
                const dh = Math.atan2(ax - P.x, az - P.z);
                let d = Math.atan2(Math.sin(dh - P.h), Math.cos(dh - P.h));
                P.h += Math.max(-0.35 * dt, Math.min(0.35 * dt, d));
                P.x += Math.sin(P.h) * P.v * dt; P.z += Math.cos(P.h) * P.v * dt;
                P.y += Math.max(-8, Math.min(8, (220 - P.y) * 0.2)) * dt;
                P.bank = -d * 1.2;
                if (Math.hypot(ax - P.x, az - P.z) < 250) P.final = true;
            } else {
                // 最終進入：艦の中心線に乗って、甲板の後ろ端へ
                const s = (P.x - physics.cgWorldX) * fx + (P.z - physics.cgWorldZ) * fz;   // 艦の前後
                const lat = (P.x - physics.cgWorldX) * fz - (P.z - physics.cgWorldZ) * fx;
                const toGo = (-half * 0.6) - s;
                const vt = shipV + (toGo > 400 ? 70 : 45);            // 進入の速さ（艦に対して 45m/s で降りる）
                P.v += Math.max(-6 * dt, Math.min(6 * dt, vt - P.v));
                const vr = Math.max(10, P.v - shipV);
                P.h = fr + Math.max(-0.3, Math.min(0.3, -lat / 300));
                P.x += Math.sin(P.h) * P.v * dt; P.z += Math.cos(P.h) * P.v * dt;
                const glide = deck + Math.max(0, toGo) * Math.tan(3.5 * Math.PI / 180);
                P.y += (glide - P.y) * Math.min(1, dt * 1.5);
                P.bank = 0;
                if (toGo <= 0) { P.state = 'trap'; P.v = vr; P.s = s; }
            }
        } else if (P.state === 'trap') {
            // 着艦ワイヤーで止まる
            P.v = Math.max(0, P.v - 30 * dt); P.s += P.v * dt;
            P.x = physics.cgWorldX + fx * P.s; P.z = physics.cgWorldZ + fz * P.s; P.y = deck; P.h = fr;
            if (P.v <= 0) { scene.remove(P.mesh); naval.planes.splice(i, 1); _nvMsg('着艦しました'); renderSubPanel(); continue; }
        }
        P.mesh.position.set(P.x, P.y, P.z);
        P.mesh.rotation.set(0, P.h, 0); P.mesh.rotateZ(P.bank || 0);
    }
}
function navalShift(shift) {
    for (const S of naval.shells) { S.x += shift.x; S.z += shift.z; S.mesh.position.add(shift); }
    for (const P of naval.planes) { P.x += shift.x; P.z += shift.z; P.mesh.position.add(shift); }
}
window.navalShift = navalShift;

function updateNaval(t, dt) {
    if (!naval.shells.length && !naval.planes.length && !naval.reload.length) return;
    const gdt = Math.min(2, Math.max(0, dt || 0)) * (typeof physicsSpeed !== 'undefined' ? physicsSpeed : 1);
    _nvUpdateShells(gdt);
    _nvUpdatePlanes(gdt);
    if (naval.msgT > 0) naval.msgT -= dt;
}
window.updateNaval = updateNaval;

// 兵装パネル（54-submarine.js の「潜水」ボタンのパネルを、軍艦では兵装に使う）
function navalPanelHTML() {
    const T = shipType(), G = T.gun;
    let h = `<div class="sb-head"><span class="sb-title">${T.icon} ${T.label}</span></div>`;
    if (G) {
        const nG = navalGunCount(), ready = Math.max(0, nG - naval.reload.length);
        h += `<div class="sb-status">主砲 ${G.cal}mm × ${nG}　装填済み ${ready}/${nG}${naval.reload.length ? `（次まで ${Math.ceil(Math.min(...naval.reload))}秒）` : ''}　射程 ${G.range}km</div>
        <div class="sb-row">方位：<button onclick="navalSet('absolute', ${!naval.absolute})">${naval.absolute ? '真方位' : '艦首から'}</button>
            <input type="range" min="${naval.absolute ? 0 : -180}" max="${naval.absolute ? 359 : 180}" step="1" value="${Math.round(naval.brg)}" oninput="naval.brg=+this.value;this.nextElementSibling.textContent=this.value+'°'" style="flex:1"><span>${Math.round(naval.brg)}°</span></div>
        <div class="sb-row">距離：<input type="range" min="1" max="${G.range}" step="0.5" value="${Math.min(G.range, naval.rangeKm)}" oninput="naval.rangeKm=+this.value;this.nextElementSibling.textContent=this.value+'km'" style="flex:1"><span>${Math.min(G.range, naval.rangeKm)}km</span></div>
        <div class="sb-row"><button onclick="navalAimCamera()">👁 見ている方へ</button><button onclick="sightRFView(viewpointActiveKey !== 'rangefinder')" ${typeof viewpointActiveKey !== 'undefined' && viewpointActiveKey === 'rangefinder' ? 'class="on"' : ''}>🔭 測距儀</button><button onclick="sightLock()" ${typeof sight !== 'undefined' && sight.lock ? 'class="on"' : ''}>🎯 ${typeof sight !== 'undefined' && sight.lock ? 'はなす' : '捉える'}</button><button class="sb-fire" onclick="navalFire()" ${ready > 0 ? '' : 'disabled'}>💥 撃て</button></div>
        ${typeof sight !== 'undefined' && sight.lock ? `<div class="sb-note">目標 ${sight.lock.name}：撃つと未来位置へ（測距儀でずらすと、そのずれのまま）</div>` : '<div class="sb-note">測距儀を覗いていれば十字の所へ、目標を捉えればその未来位置へ撃ちます</div>'}`;
    }
    if (T.air) {
        const up = naval.planes.length;
        h += `<div class="sb-status" style="margin-top:6px;">艦載機 ${T.air.n - up}/${T.air.n} 機が艦上・${up} 機が飛行中</div>
        <div class="sb-row"><button onclick="navalLaunch()" ${up < T.air.n ? '' : 'disabled'}>🛫 発艦</button><button onclick="navalRecover()" ${naval.planes.some(p => p.state === 'orbit') ? '' : 'disabled'}>🛬 着艦させる</button></div>`;
    }
    if (naval.msg && naval.msgT > 0) h += `<div class="sb-msg">${naval.msg}</div>`;
    return h;
}
window.navalPanelHTML = navalPanelHTML;
