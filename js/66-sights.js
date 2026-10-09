// ════════════════════════════════════════════════════════════════
//  照準：潜望鏡（潜水艦）・測距儀（軍艦）で目標を捉えて追いかけ、未来の位置へ撃つ
// ════════════════════════════════════════════════════════════════
//  ・測距儀：軍艦の艦橋の上（船体設定の「🚢 船種」で位置を決める。ギズモでも）から、潜望鏡と同じように覗く。
//    真ん中の十字の所までの距離を測る（水面との交わり）。倍率は ×1〜×15。
//  ・「🎯 捉える」：視界の真ん中にいちばん近い船を目標にして、視界の真ん中に置いたまま追いかける。
//    撃つときは、目標の向き・速さ・距離から、弾（魚雷）が着くまでに目標がまっすぐ進んだ所（未来位置）へ。
//  ・旋回中の目標などで、操縦者が視界を少しずらすと、そのずれ（目標から見た前後・左右[m]）を覚えて、
//    そのずれのまま追いかけ、ずらした所の未来位置へ撃つ。「ずれを戻す」で目標の真ん中へ。
//  ・舵輪の横のボタン：👁 覗く（潜望鏡・測距儀）・🎯 捉える・💥 撃て／🚀 魚雷。
//  ・砲塔の位置（何門でも）・測距儀・潜望鏡の位置は、船体設定の「🚢 船種」で数字かギズモで動かす。
//  座標は船の中（shipGroup：+z 船首・+x 左舷・模型の座標）。

const sight = { lock: null, off: { a: 0, s: 0 }, setYaw: null, setPitch: null, rf: false, rfZoom: 4, baseFov: null, rfCam: null, marks: {}, lead: null, msg: '', msgT: 0 };
window.sight = sight;
const SG_RF_ZOOMS = [1, 4, 8, 15];
function _sgMsg(s) { sight.msg = s; sight.msgT = 6; }
function _sgGun() { return (typeof shipType === 'function' && shipType().gun) || null; }
function _sgIsSub() { return typeof isSubmarine === 'function' && isSubmarine(); }
function _sgViewKey() { return typeof viewpointActiveKey !== 'undefined' ? viewpointActiveKey : null; }
function _sgInView() { const k = _sgViewKey(); return k === 'periscope' || k === 'rangefinder'; }

// ── 測距儀の位置（既定：艦の前寄りの上部構造のいちばん高い所） ──
function _sgAutoRF() {
    const root = typeof importedModelGroup !== 'undefined' ? importedModelGroup : null;
    const key = (root ? root.uuid : 'none') + ':' + (physics.scale || 1);
    if (sight.rfAuto && sight.rfAuto.key === key) return sight.rfAuto.p;
    let best = null;
    const hp = window.hullProfile, half = hp && hp.ready ? hp.halfLen : 6;
    if (root && typeof shipGroup !== 'undefined' && shipGroup) {
        shipGroup.updateMatrixWorld(true);
        const inv = new THREE.Matrix4().copy(shipGroup.matrixWorld).invert(), m = new THREE.Matrix4(), v = new THREE.Vector3();
        const z0 = half * 0.18, dz = half * 0.25, xw = (hp && hp.ready ? hp.halfBeam : 1) * 0.85;
        root.traverse(o => {
            if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
            const P = o.geometry.attributes.position, n = P.count, step = Math.max(1, Math.floor(n / 20000));
            m.multiplyMatrices(inv, o.matrixWorld);
            for (let i = 0; i < n; i += step) {
                v.fromBufferAttribute(P, i).applyMatrix4(m);
                if (Math.abs(v.z - z0) > dz || Math.abs(v.x) > xw) continue;
                if (!best || v.y > best.y) best = { x: 0, y: v.y, z: v.z };
            }
        });
    }
    if (!best && typeof _subModelTop === 'function') { const tp = _subModelTop(); best = { x: 0, y: tp.y, z: tp.z }; }
    if (!best) best = { x: 0, y: 2, z: half * 0.2 };
    sight.rfAuto = { key, p: best };
    return best;
}
function sightRFPos() { return (window.subCfg && subCfg.rf) || _sgAutoRF(); }
window.sightRFPos = sightRFPos;

// ── 砲塔の位置（設定が無ければ、艦の前後に分けて並べる：55-ship-types.js の以前の撃ち方と同じ所） ──
function _sgAutoTurrets() {
    const G = _sgGun(); if (!G) return [];
    const hp = window.hullProfile, sc = physics.scale || 1, half = (hp && hp.ready ? hp.halfLen : 6);
    const top = (typeof _subHullTopAboveWL === 'function') ? _subHullTopAboveWL() : 6;
    const y = (physics.waterlineOffsetY || 0) + top * 0.7 / sc, n = Math.max(1, Math.round(G.n)), out = [];
    for (let i = 0; i < n; i++) out.push({ x: 0, y: +y.toFixed(3), z: +(((i - (n - 1) / 2) * half * 0.5 + half * 0.15)).toFixed(3) });
    return out;
}
function sightTurrets() { return (window.subCfg && Array.isArray(subCfg.turrets) && subCfg.turrets.length) ? subCfg.turrets : _sgAutoTurrets(); }
// 世界の位置（55-ship-types.js の navalFire が撃つ所）
function sightTurretsWorld() {
    if (typeof shipGroup === 'undefined' || !shipGroup) return null;
    shipGroup.updateMatrixWorld();
    return sightTurrets().map(t => new THREE.Vector3(t.x, t.y, t.z).applyMatrix4(shipGroup.matrixWorld));
}
window.sightTurrets = sightTurrets; window.sightTurretsWorld = sightTurretsWorld;

// ── 測距儀を覗く ──
function _sgRFCam() {
    if (typeof shipGroup === 'undefined' || !shipGroup) return null;
    if (!sight.rfCam) { sight.rfCam = new THREE.Object3D(); sight.rfCam.name = 'rangefinder-eye'; sight.rfCam.userData.noSolid = true; }
    if (sight.rfCam.parent !== shipGroup) shipGroup.add(sight.rfCam);
    const p = sightRFPos(), sc = physics.scale || 1;
    sight.rfCam.position.set(p.x, p.y + 1.5 / sc, p.z);
    return sight.rfCam;
}
function sightRFView(on) {
    if (on && !_sgGun()) return;
    if (on && _sgViewKey() === 'periscope' && typeof subScopeView === 'function') subScopeView(false);
    sight.rf = !!on;
    if (on) {
        _sgRFCam();
        if (sight.baseFov == null) sight.baseFov = camera.fov;
        selectViewpoint('rangefinder');
        _sgApplyZoom();
    } else {
        if (sight.baseFov != null) { camera.fov = sight.baseFov; camera.updateProjectionMatrix(); sight.baseFov = null; }
        if (_sgViewKey() === 'rangefinder') selectViewpoint(null);
    }
    _sgOverlay();
    _sgFireStack();
}
function sightRFZoom(d) {
    let i = SG_RF_ZOOMS.indexOf(sight.rfZoom); if (i < 0) i = 1;
    i = Math.max(0, Math.min(SG_RF_ZOOMS.length - 1, i + d));
    sight.rfZoom = SG_RF_ZOOMS[i]; _sgApplyZoom(); _sgOverlay();
}
function _sgApplyZoom() {
    if (_sgViewKey() !== 'rangefinder' || sight.baseFov == null) return;
    camera.fov = Math.max(3, sight.baseFov / sight.rfZoom); camera.updateProjectionMatrix();
}
window.sightRFView = sightRFView; window.sightRFZoom = sightRFZoom;
(function () {
    const orig = window.getActiveViewpointMarker;
    if (typeof orig !== 'function') return;
    window.getActiveViewpointMarker = function () {
        if (_sgViewKey() === 'rangefinder') return _sgRFCam();
        return orig();
    };
})();
// 覗くボタン（舵輪の横）：潜水艦は潜望鏡（下りていれば上げる）、軍艦は測距儀
function sightToggleView() {
    if (_sgIsSub()) {
        if (typeof sub === 'undefined') return;
        if (sub.view) { subScopeView(false); return; }
        if (!sub.scopeUp) { if (typeof subScopeToggle === 'function') subScopeToggle(); _sgMsg('潜望鏡を上げています…'); sight.wantScope = true; return; }
        subScopeView(true);
    } else if (_sgGun()) sightRFView(_sgViewKey() !== 'rangefinder');
    _sgFireStack();
}
window.sightToggleView = sightToggleView;

// ── 目の位置・向き ──
const _sgV = new THREE.Vector3(), _sgQ = new THREE.Quaternion(), _sgFwd = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
function _sgEye() {
    const m = typeof getActiveViewpointMarker === 'function' ? getActiveViewpointMarker() : null;
    if (!m) return null;
    m.updateWorldMatrix(true, false);
    return new THREE.Vector3().setFromMatrixPosition(m.matrixWorld);
}
// 船の中の見回しの角度 (yaw, pitch) → 世界の向き
function _sgDirOf(yaw, pitch) {
    shipGroup.getWorldQuaternion(_sgQ);
    const d = new THREE.Vector3(Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw));
    return d.applyQuaternion(_sgQ);
}
// 世界の点 Q を見る (yaw, pitch)
function _sgYawPitchTo(E, Q) {
    shipGroup.getWorldQuaternion(_sgQ);
    const d = new THREE.Vector3(Q.x - E.x, Q.y - E.y, Q.z - E.z).applyQuaternion(_sgQ.clone().invert());
    return { yaw: Math.atan2(d.x, d.z), pitch: Math.atan2(d.y, Math.hypot(d.x, d.z)) };
}
// 見ている線と水面（高さ wy）との交わり（遠すぎ・上向きなら null）
function _sgRayWater(E, dir, wy) {
    if (!(dir.y < -1e-5)) return null;
    const t = (wy - E.y) / dir.y;
    if (!(t > 0) || t > 60000) return null;
    return { x: E.x + dir.x * t, y: wy, z: E.z + dir.z * t, d: t };
}
function _sgWaterY() { return Number.isFinite(window._physicsWaveY) ? window._physicsWaveY : 0; }

// ── 目標を捉える・はなす ──
function sightLock() {
    if (sight.lock) { sight.lock = null; sight.setYaw = null; _sgMsg('目標をはなしました'); _sgOverlay(); _sgFireStack(); return; }
    if (!_sgInView()) { _sgMsg('先に潜望鏡か測距儀を覗いてください'); _sgFireStack(); return; }
    if (typeof traffic === 'undefined' || !traffic.ships || typeof _tfHullOf !== 'function') return;
    const E = _sgEye(); if (!E) return;
    const dir = new THREE.Vector3(); camera.getWorldDirection(dir);
    const half = (camera.fov / 2) * Math.PI / 180 * 1.3;
    let best = null, bestA = Infinity;
    for (const S of traffic.ships) {
        if (!_tfShown(S) || !S.mesh || !S.mesh.visible || !(S.dPl < 45000) || S.st === 'gone') continue;
        const H = _tfHullOf(S); if (!H) continue;
        const v = new THREE.Vector3(H.x - E.x, _sgWaterY() + 3 - E.y, H.z - E.z), d = v.length();
        // 船の大きさの分だけ、真ん中から外れていてもよい
        const ang = Math.acos(Math.max(-1, Math.min(1, v.dot(dir) / Math.max(1, d)))) - Math.atan2(S.L / 2, d);
        if (ang < half && ang < bestA) { bestA = ang; best = S; }
    }
    if (!best) { _sgMsg('視界の中に船がいません'); _sgOverlay(); return; }
    sight.lock = best; sight.off = { a: 0, s: 0 }; sight.setYaw = null;
    _sgMsg(`目標：${best.name}`);
    _sgOverlay(); _sgFireStack();
}
function sightResetOffset() { sight.off = { a: 0, s: 0 }; _sgOverlay(); }
window.sightLock = sightLock; window.sightResetOffset = sightResetOffset;
// 目標の、ずれ込みの狙う所（世界）と、速さ（世界の向き [m/s]）
function _sgTarget() {
    const S = sight.lock; if (!S) return null;
    const H = _tfHullOf(S); if (!H) return null;
    const v = S.st === 'damaged' || S.st === 'berth' || S.st === 'anchored' ? (S.st === 'damaged' ? (S.v || 0) : 0) : (S.v || 0);
    return { x: H.x + H.fx * sight.off.a + H.sx * sight.off.s, z: H.z + H.fz * sight.off.a + H.sz * sight.off.s, vx: H.fx * v, vz: H.fz * v, H, S };
}

// ── 毎フレーム（17-main-loop.js：視点のカメラを決める前に）──
function updateSightAim() {
    if (sight.msgT > 0) sight.msgT -= 1 / 60;
    if (sight.wantScope && typeof sub !== 'undefined' && sub.scopeUp && !sub.view && sub.scopeRaise > 0.98) { sight.wantScope = false; subScopeView(true); _sgFireStack(); }
    // 覗くのをやめたら（ほかの視点へ）、測距儀の状態も戻す
    if (sight.rf && _sgViewKey() !== 'rangefinder') sightRFView(false);
    const S = sight.lock;
    if (S && (S.st === 'gone' || !S.mesh || !(S.dPl < 45000) || (typeof traffic !== 'undefined' && !traffic.ships.includes(S)))) {
        sight.lock = null; sight.setYaw = null; _sgMsg('目標を見失いました'); _sgOverlay(); _sgFireStack();
    }
    if (!sight.lock || !_sgInView() || typeof shipGroup === 'undefined' || !shipGroup) { sight.setYaw = null; return; }
    const E = _sgEye(); if (!E) return;
    const tg = _sgTarget(); if (!tg) return;
    // 操縦者が視界を動かした：その向きの水面の所を、目標から見たずれにする（倍率が高いほど細かく）
    if (sight.setYaw != null) {
        const dy = viewpointYaw - sight.setYaw, dp = viewpointPitch - sight.setPitch;
        if (Math.abs(dy) > 1e-7 || Math.abs(dp) > 1e-7) {
            const k = sight.baseFov ? camera.fov / sight.baseFov : (_sgViewKey() === 'periscope' && typeof sub !== 'undefined' ? 1 / Math.max(1, sub.zoom) : 1);
            const P = _sgRayWater(E, _sgDirOf(sight.setYaw + dy * k, sight.setPitch + dp * k), _sgWaterY() + 2);
            if (P) {
                const H = tg.H, dx = P.x - H.x, dz = P.z - H.z, lim = Math.max(150, 2 * S.L);
                sight.off = { a: Math.max(-lim, Math.min(lim, dx * H.fx + dz * H.fz)), s: Math.max(-lim, Math.min(lim, dx * H.sx + dz * H.sz)) };
            }
        }
    }
    const t2 = _sgTarget();
    const yp = _sgYawPitchTo(E, { x: t2.x, y: _sgWaterY() + 2, z: t2.z });
    viewpointYaw = yp.yaw; viewpointPitch = Math.max(-1.45, Math.min(1.45, yp.pitch));
    sight.setYaw = viewpointYaw; sight.setPitch = viewpointPitch;
}
window.updateSightAim = updateSightAim;

// ── 射撃の解：狙う所（世界の x・z）と、魚雷なら向き ──
//  kind：'gun'（主砲）・'torpedo'。目標を捉えていれば未来位置、捉えていなければ十字の所（測距儀）/ null
function sightFireSolution(kind) {
    if (typeof shipGroup === 'undefined' || !shipGroup) return null;
    const tg = _sgTarget();
    if (kind === 'torpedo') {
        if (!tg) return null;
        const hp = window.hullProfile, sc = physics.scale || 1, half = ((hp && hp.ready) ? hp.halfLen : 6) * sc;
        const fr = (physics.heading || 0) * Math.PI / 180;
        const Lx = physics.cgWorldX + Math.sin(fr) * half * 0.9, Lz = physics.cgWorldZ + Math.cos(fr) * half * 0.9;
        const vt = ((window.subCfg && subCfg.torpSpeed) || 45) * 0.514;
        // |P + V t − L| = vt (t − 2)（走り出しの遅れ 2 秒）
        const Dx = tg.x - Lx, Dz = tg.z - Lz;
        let t = Math.hypot(Dx, Dz) / vt;
        for (let i = 0; i < 6; i++) { const px = Dx + tg.vx * t, pz = Dz + tg.vz * t; t = Math.hypot(px, pz) / vt + 2; }
        const x = Lx + Dx + tg.vx * t, z = Lz + Dz + tg.vz * t;
        sight.lead = { x, z, t };
        return { x, z, hd: Math.atan2(x - Lx, z - Lz) * 180 / Math.PI, t };
    }
    const G = _sgGun(); if (!G) return null;
    if (tg) {
        // 弾の飛ぶ時間（55-ship-types.js：同じ弧を 0.6 倍の時間で）。目標がまっすぐ進んだ所へ
        const T0 = sightTurretsWorld(), c = T0 && T0.length ? T0.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / T0.length) : new THREE.Vector3(physics.cgWorldX, 0, physics.cgWorldZ);
        let t = 0, x = tg.x, z = tg.z;
        for (let i = 0; i < 5; i++) {
            const R = Math.hypot(x - c.x, z - c.z), el = Math.min(0.7, 0.5 * Math.asin(Math.min(1, R * 9.81 / (G.v * G.v))));
            t = 0.6 * R / (G.v * Math.cos(el));
            x = tg.x + tg.vx * t; z = tg.z + tg.vz * t;
        }
        sight.lead = { x, z, t };
        return { x, z, t };
    }
    // 測距儀を覗いていれば、十字の所
    if (_sgViewKey() === 'rangefinder') {
        const E = _sgEye(); if (!E) return null;
        const dir = new THREE.Vector3(); camera.getWorldDirection(dir);
        const P = _sgRayWater(E, dir, _sgWaterY() + 2);
        if (P) return { x: P.x, z: P.z, t: 0 };
    }
    return null;
}
window.sightFireSolution = sightFireSolution;
// 撃つボタン（舵輪の横）
function sightFire() {
    if (_sgIsSub()) { if (typeof subFire === 'function') subFire(); }
    else if (_sgGun() && typeof navalFire === 'function') navalFire();
    _sgFireStack();
}
window.sightFire = sightFire;

// ── 覗いているときの重ね表示（測距儀：目盛り・距離。どちらも：目標・未来位置） ──
function _sgOverlay() {
    let el = document.getElementById('rf-scope');
    if (!el) {
        el = document.createElement('div'); el.id = 'rf-scope';
        el.innerHTML = '<div class="rf-split"></div><div class="rf-h"></div><div class="rf-v"></div><div class="rf-scale"></div><div class="rf-info"></div><div class="sg-bar rf-bar"></div>';
        document.body.appendChild(el);
    }
    el.classList.toggle('on', _sgViewKey() === 'rangefinder');
    // 潜望鏡（54-submarine.js の重ね表示）にも、捉える・ずれを戻すのボタン
    const ss = document.getElementById('sub-scope');
    if (ss && !ss.querySelector('.sg-bar')) { const b = document.createElement('div'); b.className = 'sg-bar ss-bar'; ss.appendChild(b); }
    let lead = document.getElementById('sg-lead');
    if (!lead) { lead = document.createElement('div'); lead.id = 'sg-lead'; lead.innerHTML = '<span></span>'; document.body.appendChild(lead); }
    const bars = document.querySelectorAll('.sg-bar');
    const isSub = _sgIsSub();
    const html = `<button onclick="sightLock()" class="${sight.lock ? 'on' : ''}">${sight.lock ? '🎯 はなす' : '🎯 捉える'}</button>`
        + (sight.lock ? `<button onclick="sightResetOffset()" title="ずらした分を戻して、目標の真ん中を狙う">⊙ ずれを戻す</button>` : '')
        + (_sgViewKey() === 'rangefinder' ? `<button onclick="sightRFZoom(-1)">−</button><span class="rf-z">×${sight.rfZoom}</span><button onclick="sightRFZoom(1)">＋</button>` : '')
        + `<button class="sg-fire" onclick="sightFire()">${isSub ? '🚀 魚雷' : '💥 撃て'}</button>`
        + (_sgViewKey() === 'rangefinder' ? `<button onclick="sightRFView(false)">✕</button>` : '');
    bars.forEach(b => { if (b.innerHTML !== html) b.innerHTML = html; });
}
function _sgOverlayTick() {
    const vk = _sgViewKey(), on = vk === 'rangefinder' || vk === 'periscope';
    const lead = document.getElementById('sg-lead');
    if (!on) { if (lead) lead.style.display = 'none'; return; }
    const E = _sgEye();
    // 測距儀：十字の所までの距離・方位
    if (vk === 'rangefinder') {
        const el = document.getElementById('rf-scope');
        if (el) {
            const dir = new THREE.Vector3(); camera.getWorldDirection(dir);
            const P = E ? _sgRayWater(E, dir, _sgWaterY()) : null;
            const tg = _sgTarget();
            const brg = (() => { const yawDeg = (viewpointYaw || 0) * 180 / Math.PI; const c = (typeof worldTrueCompass === 'function' ? worldTrueCompass() : 0) - yawDeg; return ((c % 360) + 360) % 360; })();
            const rng = tg && E ? Math.hypot(tg.x - E.x, tg.z - E.z) : P ? P.d : null;
            const G = _sgGun();
            const info = el.querySelector('.rf-info');
            const kn = (v) => (v / 0.514444).toFixed(1);
            const txt = `方位 ${brg.toFixed(0).padStart(3, '0')}°　距離 ${rng != null ? Math.round(rng).toLocaleString() + ' m' : '—'}${G && rng != null && rng > G.range * 1000 ? '（射程外）' : ''}`
                + (tg ? `<br>目標 ${tg.S.name}　${kn(Math.hypot(tg.vx, tg.vz))} kn${sight.off.a || sight.off.s ? `　ずれ 前後 ${Math.round(sight.off.a)}m・左右 ${Math.round(sight.off.s)}m` : ''}` : '')
                + (sight.msgT > 0 && sight.msg ? `<br><span class="sg-msg">${sight.msg}</span>` : '');
            if (info.innerHTML !== txt) info.innerHTML = txt;
            const sc = el.querySelector('.rf-scale');
            if (sc) sc.style.transform = `translateX(${(((rng || 0) / 50) % 40) - 20}px)`;
        }
    } else {
        // 潜望鏡：目標の情報を足す
        const el = document.getElementById('sub-scope');
        const tg = _sgTarget();
        if (el) {
            let ti = el.querySelector('.sg-tinfo');
            if (!ti) { ti = document.createElement('div'); ti.className = 'sg-tinfo'; el.appendChild(ti); }
            const txt = tg && E ? `目標 ${tg.S.name}　距離 ${Math.round(Math.hypot(tg.x - E.x, tg.z - E.z)).toLocaleString()} m　${(Math.hypot(tg.vx, tg.vz) / 0.514444).toFixed(1)} kn${sight.off.a || sight.off.s ? `　ずれ ${Math.round(sight.off.a)}m / ${Math.round(sight.off.s)}m` : ''}` : (sight.msgT > 0 ? sight.msg : '');
            if (ti.textContent !== txt) ti.textContent = txt;
        }
    }
    // 未来位置の印
    if (lead) {
        const sol = sight.lock ? sightFireSolution(_sgIsSub() ? 'torpedo' : 'gun') : null;
        if (sol) {
            const v = new THREE.Vector3(sol.x, _sgWaterY() + 2, sol.z).project(camera);
            const vis = v.z < 1 && Math.abs(v.x) < 1.2 && Math.abs(v.y) < 1.2;
            lead.style.display = vis ? 'block' : 'none';
            if (vis) { lead.style.left = ((v.x + 1) / 2 * window.innerWidth) + 'px'; lead.style.top = ((1 - v.y) / 2 * window.innerHeight) + 'px'; lead.firstChild.textContent = `未来位置 ${sol.t.toFixed(0)}秒後`; }
        } else lead.style.display = 'none';
    }
}

// ── 舵輪の横のボタン ──
function _sgFireStack() {
    let el = document.getElementById('fire-stack');
    if (!el) {
        el = document.createElement('div'); el.id = 'fire-stack';
        document.body.appendChild(el);
    }
    const isSub = _sgIsSub(), G = _sgGun();
    const show = isSub || !!G;
    el.style.display = show ? '' : 'none';
    if (!show) return;
    const viewOn = isSub ? (typeof sub !== 'undefined' && sub.view) : _sgViewKey() === 'rangefinder';
    const ready = isSub ? (typeof sub !== 'undefined' && sub.loaded > 0) : (G && typeof navalGunCount === 'function' ? naval.reload.length < navalGunCount() : true);
    const html = `<button class="fs-view ${viewOn ? 'on' : ''}" onclick="sightToggleView()" title="${isSub ? '潜望鏡を覗く（下りていれば上げる）' : '測距儀を覗く'}">${viewOn ? '✕' : '👁'}<small>${isSub ? '潜望鏡' : '測距儀'}</small></button>`
        + `<button class="fs-lock ${sight.lock ? 'on' : ''}" onclick="sightLock()" title="視界の真ん中の船を目標にして追いかける">🎯<small>${sight.lock ? 'はなす' : '捉える'}</small></button>`
        + `<button class="fs-fire" onclick="sightFire()" ${ready ? '' : 'disabled'} title="${sight.lock ? '目標の未来位置へ' : isSub ? '見ている向きへ' : '測距儀の十字・兵装の方位と距離へ'}">${isSub ? '🚀' : '💥'}<small>${isSub ? '魚雷' : '撃て'}</small></button>`;
    if (el.innerHTML !== html) el.innerHTML = html;
    // 舵輪の左に並べる
    const S = typeof _widgetSize === 'function' ? _widgetSize() : 170;
    const useWh = typeof bridgeUI === 'undefined' || bridgeUI.wheel !== 'buttons';
    el.style.right = `calc(${(useWh ? S : 120) + 22}px + env(safe-area-inset-right))`;
}
window.sightFireStack = _sgFireStack;

// ── 設定（船体設定の「🚢 船種」に足す）：測距儀・砲塔・潜望鏡の位置。ギズモでも ──
function _sgMarkers() {
    if (typeof shipGroup === 'undefined' || !shipGroup) return;
    const sp = document.getElementById('settings-panel'), tb = document.querySelector('.settings-tab.active');
    const open = !!(sp && sp.classList.contains('open') && tb && tb.dataset.tab === 'submarine');
    const mk = (key, color) => {
        let m = sight.marks[key];
        if (!m) {
            m = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8), new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 }));
            m.renderOrder = 990; m.userData.isViewpointMarker = true; m.userData.noSolid = true; m.userData.noLightBake = true;
            sight.marks[key] = m;
        }
        if (m.parent !== shipGroup) shipGroup.add(m);
        return m;
    };
    const G = _sgGun(), isSub = _sgIsSub();
    const rf = mk('rf', 0x66ffcc); rf.visible = open && !!G;
    if (G) { const p = sightRFPos(); if (!(typeof currentGizmoType !== 'undefined' && currentGizmoType === 'sg_rf')) rf.position.set(p.x, p.y, p.z); }
    const tur = G ? sightTurrets() : [];
    for (let i = 0; i < 12; i++) {
        const m = mk('t' + i, 0xff8844);
        m.visible = open && i < tur.length;
        if (i < tur.length && !(typeof currentGizmoType !== 'undefined' && currentGizmoType === 'sg_tur' && currentGizmoIndex === i)) m.position.set(tur[i].x, tur[i].y, tur[i].z);
    }
    const sc = mk('scope', 0x88aaff); sc.visible = open && isSub;
    if (isSub && typeof subScopePos === 'function' && !(typeof currentGizmoType !== 'undefined' && currentGizmoType === 'sg_scope')) { const p = subScopePos(); sc.position.set(p.x, p.y, p.z); }
}
const _sgPrevGizmoTarget = window.getExtraGizmoTarget;
const _sgPrevGizmoChange = window.onExtraGizmoChange;
window.getExtraGizmoTarget = function (type, index) {
    if (type === 'sg_rf' || type === 'sg_tur' || type === 'sg_scope') {
        _sgMarkers();
        const m = type === 'sg_rf' ? sight.marks.rf : type === 'sg_scope' ? sight.marks.scope : sight.marks['t' + index];
        return { mesh: m, btnId: `gizmo-${type}-${index}` };
    }
    return _sgPrevGizmoTarget ? _sgPrevGizmoTarget(type, index) : null;
};
window.onExtraGizmoChange = function (type, index, target) {
    if (type === 'sg_rf' || type === 'sg_tur' || type === 'sg_scope') {
        const r = (v) => Math.round(v * 1000) / 1000, p = { x: r(target.position.x), y: r(target.position.y), z: r(target.position.z) };
        if (type === 'sg_rf') subCfg.rf = p;
        else if (type === 'sg_scope') { subCfg.scope = p; if (typeof sub !== 'undefined') sub.topCache = sub.topCache; }
        else { if (!Array.isArray(subCfg.turrets) || !subCfg.turrets.length) subCfg.turrets = sightTurrets().map(t => Object.assign({}, t)); if (subCfg.turrets[index]) subCfg.turrets[index] = p; }
        _sgSyncSettings();
        return true;
    }
    return _sgPrevGizmoChange ? _sgPrevGizmoChange(type, index, target) : false;
};
function sightSetRF(k, v) {
    if (k === 'auto') { subCfg.rf = null; sight.rfAuto = null; }
    else { const p = Object.assign({}, sightRFPos()); const n = parseFloat(v); if (!Number.isFinite(n)) return; p[k] = n; subCfg.rf = p; }
    _sgSettingsHTML(true);
}
function sightSetTurret(i, k, v) {
    if (!Array.isArray(subCfg.turrets) || !subCfg.turrets.length) subCfg.turrets = sightTurrets().map(t => Object.assign({}, t));
    if (k === 'add') { const last = subCfg.turrets[subCfg.turrets.length - 1] || { x: 0, y: 1, z: 0 }; if (subCfg.turrets.length < 12) subCfg.turrets.push({ x: last.x, y: last.y, z: +(last.z - 0.6).toFixed(3) }); }
    else if (k === 'del') { if (subCfg.turrets.length > 1) subCfg.turrets.splice(i, 1); }
    else if (k === 'auto') subCfg.turrets = null;
    else { const n = parseFloat(v); if (!Number.isFinite(n) || !subCfg.turrets[i]) return; subCfg.turrets[i][k] = n; }
    if (typeof disableGizmo === 'function' && (k === 'add' || k === 'del' || k === 'auto')) disableGizmo();
    _sgSettingsHTML(true);
    if (typeof renderSubPanel === 'function') renderSubPanel();
}
Object.assign(window, { sightSetRF, sightSetTurret });
function _sgSyncSettings() {
    const el = document.getElementById('sg-settings'); if (!el) return;
    const p = sightRFPos();
    el.querySelectorAll('input[data-rf]').forEach(inp => { if (document.activeElement !== inp) inp.value = (+p[inp.dataset.rf]).toFixed(2); });
    const T = sightTurrets();
    el.querySelectorAll('input[data-t]').forEach(inp => { const t = T[+inp.dataset.t]; if (t && document.activeElement !== inp) inp.value = (+t[inp.dataset.k]).toFixed(2); });
    const sc = typeof subScopePos === 'function' ? subScopePos() : null;
    document.querySelectorAll('#sub-settings input[onchange^="subSetScope"]').forEach(inp => { const k = (inp.getAttribute('onchange').match(/'(x|y|z)'/) || [])[1]; if (k && sc && document.activeElement !== inp) inp.value = (+sc[k]).toFixed(2); });
}
function _sgSettingsHTML(force) {
    const host = document.getElementById('sub-settings'); if (!host) return;
    let el = document.getElementById('sg-settings');
    if (!el) { el = document.createElement('div'); el.id = 'sg-settings'; host.appendChild(el); }
    else if (el.parentNode !== host) host.appendChild(el);
    const G = _sgGun(), isSub = _sgIsSub();
    const num = (attr, v, on) => `<input type="number" class="sp-num-input" style="width:60px" step="0.05" value="${(+v).toFixed(2)}" ${attr} onchange="${on}">`;
    let h = '';
    if (G) {
        const p = sightRFPos(), auto = !subCfg.rf, T = sightTurrets(), autoT = !(Array.isArray(subCfg.turrets) && subCfg.turrets.length);
        h += `<div class="sp-section-title" style="margin-top:8px;">🔭 測距儀</div>
            <div class="sp-row" style="gap:4px;flex-wrap:wrap;align-items:center;">X ${num('data-rf="x"', p.x, "sightSetRF('x', this.value)")} Y ${num('data-rf="y"', p.y, "sightSetRF('y', this.value)")} Z ${num('data-rf="z"', p.z, "sightSetRF('z', this.value)")}</div>
            <div class="sp-row" style="gap:6px;flex-wrap:wrap;"><button class="sp-gizmo-btn" id="gizmo-sg_rf-0" onclick="toggleGizmo('sg_rf', 0)">📍 ギズモ</button>
              <button class="sp-gizmo-btn" onclick="sightSetRF('auto')">🔝 艦橋の上（自動）</button><span style="font-size:10px;color:#888;">${auto ? '今は自動' : ''}</span></div>
            <div style="font-size:10px;color:#888;margin-bottom:6px;">画面の「👁 測距儀」で、ここから覗きます（緑の点）。十字の所までの距離を測り、そこへ撃てます。</div>
            <div class="sp-section-title" style="margin-top:8px;">💥 砲塔（${T.length} 基・1 斉射で 1 基 1 発）</div>
            ${T.map((t, i) => `<div class="sp-row" style="gap:4px;flex-wrap:wrap;align-items:center;"><span style="font-size:11px;">#${i + 1}</span>
              X ${num(`data-t="${i}" data-k="x"`, t.x, `sightSetTurret(${i}, 'x', this.value)`)} Y ${num(`data-t="${i}" data-k="y"`, t.y, `sightSetTurret(${i}, 'y', this.value)`)} Z ${num(`data-t="${i}" data-k="z"`, t.z, `sightSetTurret(${i}, 'z', this.value)`)}
              <button class="sp-gizmo-btn" id="gizmo-sg_tur-${i}" onclick="toggleGizmo('sg_tur', ${i})">📍</button>
              <button class="sp-gizmo-btn" onclick="sightSetTurret(${i}, 'del')" ${T.length > 1 ? '' : 'disabled'}>✕</button></div>`).join('')}
            <div class="sp-row" style="gap:6px;flex-wrap:wrap;"><button class="sp-gizmo-btn" onclick="sightSetTurret(0, 'add')" ${T.length < 12 ? '' : 'disabled'}>＋ 砲塔</button>
              <button class="sp-gizmo-btn" onclick="sightSetTurret(0, 'auto')">✨ 前後に並べ直す（自動）</button><span style="font-size:10px;color:#888;">${autoT ? '今は自動' : ''}</span></div>
            <div style="font-size:10px;color:#888;margin-bottom:6px;">オレンジの点が砲塔（弾の出る所）です。それぞれの砲塔から、狙った所へ向けて撃ちます。</div>`;
    }
    if (isSub) h += `<div class="sp-row" style="gap:6px;flex-wrap:wrap;"><button class="sp-gizmo-btn" id="gizmo-sg_scope-0" onclick="toggleGizmo('sg_scope', 0)">📍 潜望鏡の位置をギズモで</button></div>`;
    if (force || el.innerHTML !== h) el.innerHTML = h;
}
// 「🚢 船種」のページを描いたあとに足す
(function () {
    const orig = window.renderSubSettings;
    if (typeof orig !== 'function') return;
    window.renderSubSettings = function () { orig.apply(this, arguments); _sgSettingsHTML(true); };
})();

// 毎フレーム（17-main-loop.js：updateSubmarine のあと）
function updateSights(t, dt) {
    // 視点のボタン（通常・固定・自由・ほかの見張り台）で直接切り替えたとき：測距儀・潜望鏡の重ね表示と倍率を戻す
    //（updateSightAim は見張り台の視点の間しか呼ばれないので、ここで毎フレーム見る）
    const vk = _sgViewKey();
    if (sight.rf && (vk !== 'rangefinder' || cameraMode !== 'viewpoint')) sightRFView(false);
    if (typeof sub !== 'undefined' && sub.view && (vk !== 'periscope' || cameraMode !== 'viewpoint') && typeof subScopeView === 'function') subScopeView(false);
    _sgMarkers();
    _sgOverlayTick();
    if (!sight._fsT || performance.now() - sight._fsT > 500) { sight._fsT = performance.now(); _sgFireStack(); }
}
window.updateSights = updateSights;
window.addEventListener('resize', () => _sgFireStack());
document.addEventListener('DOMContentLoaded', () => setTimeout(() => { _sgOverlay(); _sgFireStack(); }, 800));
