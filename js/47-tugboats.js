// ════════════════════════════════════════════════════════════════
//  タグボート
// ════════════════════════════════════════════════════════════════
//  画面の「タグ」ボタンから呼ぶ（最大4隻）。呼ぶと沖からやって来て、決めた持ち場に付く。
//    持ち場：係船設備（46-mooring.js）の金物のどれか（左右それぞれ）。金物が無い船は
//            船首・船尾の左右（舷側）。
//    指示  ：待機（横に付いて力を出さない）／押す（船体に船首を当てて押す）／
//            引く（金物に索を取って引く。向きは 横・前・後ろ）／帰す
//    力    ：微・半・全（全 ＝ 引く力 12〜70 トン。船が大きいほど強いタグが来る）
//  力は船に「横流れ」「回頭」「前後」として効く。
//    ・横流れと回頭は、船体が水を横に押しのける抵抗で釣り合う（大きな船ほどゆっくり）
//    ・船の速さが 5 ノットを超えると、タグは付いていくのが精いっぱいで力が弱まる（8 ノットで0）
//  座標：physics.heading は上から見て左回りに増える。船の中の +x は左舷側で、その向きは
//        (cos h, −sin h)、船首の向きは (sin h, cos h)。右舷は −x。

const TUG_MAX = 4;
// 全力の引く力[N]：船の大きさに合わせた港のタグ（小さい船 12 トン 〜 大きな船 70 トン）
function _tugPullN() { return Math.max(12, Math.min(70, 10 + (physics.mass || 1))) * 9806; }
const TUG_LEN = 28, TUG_BEAM = 10;       // タグの大きさ[m]
const TUG_POWERS = { low: 0.25, half: 0.55, full: 1 };
const TUG_ACTIONS = { standby: '待機', push: '押す', pull: '引く' };
const TUG_DIRS = { side: '横へ', fwd: '前へ', aft: '後ろへ' };

const tugs = [];                         // { id, g, line, pos, vel, yaw, station, action, dir, power, state, force, ... }
const _tugShip = { vSway: 0, yawRate: 0, lastX: null, lastZ: null, vx: 0, vz: 0 };
window.tugs = tugs;

// ── タグの形（実寸[m]。+z が船首）──
let _tugMats = null;
function _tugMat() {
    if (_tugMats) return _tugMats;
    const mk = (hex, o) => { const m = new THREE.MeshStandardMaterial(Object.assign({ roughness: 0.6, metalness: 0.1 }, o || {})); m.color.setHex(hex).convertSRGBToLinear(); return m; };
    _tugMats = {
        hull: mk(0x1e2226), bottom: mk(0x8a2c20), house: mk(0xece9e0), win: mk(0x1a2530, { roughness: 0.2, metalness: 0.4 }),
        funnel: mk(0xd9651e), black: mk(0x141414), fender: mk(0x222222, { roughness: 0.95 }), deck: mk(0x6b5a48),
        line: new THREE.LineBasicMaterial({ color: 0xcdb892 }),
    };
    return _tugMats;
}
function _tugBuild() {
    const M = _tugMat();
    const g = new THREE.Group();
    // 上から見た船体の形（x：幅、y：長さ。船首が +y）
    const sh = new THREE.Shape();
    const hb = TUG_BEAM / 2, hl = TUG_LEN / 2;
    sh.moveTo(0, hl);
    sh.quadraticCurveTo(hb * 0.95, hl * 0.8, hb, hl * 0.15);
    sh.lineTo(hb, -hl * 0.6);
    sh.quadraticCurveTo(hb * 0.95, -hl, 0, -hl);
    sh.quadraticCurveTo(-hb * 0.95, -hl, -hb, -hl * 0.6);
    sh.lineTo(-hb, hl * 0.15);
    sh.quadraticCurveTo(-hb * 0.95, hl * 0.8, 0, hl);
    const ext = (depth, y0, mat, scale) => {
        const geo = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: false, curveSegments: 10 });
        geo.rotateX(Math.PI / 2);                 // 形の y → z、押し出し → 下向き
        if (scale) geo.scale(scale, 1, scale);
        geo.translate(0, y0, 0);
        const m = new THREE.Mesh(geo, mat); m.castShadow = true; m.receiveShadow = true;
        g.add(m); return m;
    };
    ext(1.6, 1.9, M.hull);                        // 水面より上（黒）
    ext(3.2, 0.3, M.bottom, 0.97);                // 水面より下（赤）
    ext(0.1, 1.95, M.deck, 0.93);                 // 甲板
    const box = (w, h, d, x, y, z, mat) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; g.add(m); return m; };
    // 船首の押し当て用の防舷材（太いゴム）と、舷側のタイヤ
    const bow = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.75, TUG_BEAM * 0.55, 16), M.fender);
    bow.rotation.z = Math.PI / 2; bow.position.set(0, 1.3, hl - 0.6); g.add(bow);
    for (const s of [-1, 1]) for (let k = 0; k < 4; k++) {
        const t = new THREE.Mesh(new THREE.TorusGeometry(0.45, 0.2, 8, 14), M.fender);
        t.rotation.y = Math.PI / 2; t.position.set(s * (hb + 0.15), 1.1, 5 - k * 4.5); g.add(t);
    }
    // 甲板室・操舵室
    box(6.2, 2.6, 10, 0, 3.25, 1.5, M.house);
    box(5.2, 2.4, 4.6, 0, 5.75, 3.2, M.house);
    box(5.28, 0.85, 4.68, 0, 6.2, 3.2, M.win);          // 窓の帯
    box(5.8, 0.18, 5.2, 0, 7.02, 3.2, M.house);         // 屋根
    // 煙突（2本）とマスト
    for (const s of [-1, 1]) {
        const f = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.65, 3.2, 14), M.funnel);
        f.position.set(s * 1.7, 6.0, -1.8); f.castShadow = true; g.add(f);
        const top = new THREE.Mesh(new THREE.CylinderGeometry(0.56, 0.56, 0.5, 14), M.black);
        top.position.set(s * 1.7, 7.6, -1.8); g.add(top);
    }
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.15, 4.5, 8), M.house);
    mast.position.set(0, 9.3, 3.6); g.add(mast);
    // 船尾の引き索のフック（ウインチ）
    box(2.2, 1.2, 1.6, 0, 2.6, -hl + 3.2, M.black);
    g.userData.hookZ = -hl + 3.2;
    g.traverse(o => { if (o.isMesh) o.userData.noLightBake = true; });
    return g;
}

// ── 持ち場（船の中の座標で）──
function _tugHalfWidth(zLocal) {
    const hp = window.hullProfile;
    if (!hp || !hp.ready) return 1.5;
    const sl = hp.slices || [];
    if (sl.length < 2) return hp.halfBeam;
    const a = zLocal / hp.halfLen * (hp.bowSign || 1);
    let best = sl[0];
    for (const q of sl) if (Math.abs(q.alongNorm - a) < Math.abs(best.alongNorm - a)) best = q;
    return best.halfWidth || hp.halfBeam;
}
function tugStations() {
    const out = [];
    const hp = window.hullProfile;
    const hl = (hp && hp.ready) ? hp.halfLen : 6;
    const wl = (hp && hp.ready) ? (hp.designWaterlineY || 0) : 0;
    if (typeof shipMooring !== 'undefined' && shipMooring.items.length) {
        shipMooring.items.forEach((it, i) => {
            const sides = it.sym && Math.abs(it.x) > 1e-3 ? [1, -1] : [1];
            for (const m of sides) {
                const x = it.x * m;
                const center = Math.abs(x) < 0.15 * _tugHalfWidth(it.z);
                const sideLabel = center ? '' : (x > 0 ? '・左舷' : '・右舷');     // 船首を向いて右（右舷）は −x
                out.push({ key: `m${i}:${m}`, label: `${it.name || ('金物' + (i + 1))}${sideLabel}`, x, y: it.y, z: it.z, fitting: true, side: center ? 0 : Math.sign(x) });
            }
        });
    }
    // 金物が無くても押せるように、船首・船尾の舷側も
    for (const [zn, nm] of [[0.75, '船首'], [-0.75, '船尾']]) for (const s of [1, -1]) {
        const z = zn * hl, hw = _tugHalfWidth(z);
        out.push({ key: `d${zn}:${s}`, label: `${nm}の${s > 0 ? '左舷' : '右舷'}（舷側）`, x: s * hw, y: wl, z, fitting: false, side: s });
    }
    return out;
}
window.tugStations = tugStations;

// ── 船の向き・位置（ワールド）──
function _shipFrame() {
    const h = (physics.heading || 0) * Math.PI / 180;
    return { fx: Math.sin(h), fz: Math.cos(h), sx: Math.cos(h), sz: -Math.sin(h) };   // 船首・+x（左舷）の向き
}
function _localToWorldFlat(x, y, z) {
    const v = new THREE.Vector3(x, y, z);
    shipGroup.localToWorld(v);
    return v;
}

// ── 呼ぶ・指示・帰す ──
let _tugNextId = 1;
function tugCall() {
    if (tugs.filter(t => t.state !== 'leaving').length >= TUG_MAX) return;
    if (typeof shipGroup === 'undefined' || !shipGroup) return;
    const st = tugStations();
    // まだ誰も付いていない持ち場から（引ける金物を先に）
    const used = new Set(tugs.map(t => t.station));
    const pick = st.find(s => s.fitting && !used.has(s.key)) || st.find(s => !used.has(s.key)) || st[0];
    const F = _shipFrame();
    const side = pick.side || (tugs.length % 2 ? -1 : 1);
    const from = shipGroup.position.clone();
    from.x += (F.sx * side * 450 + F.fx * (pick.z > 0 ? 300 : -300));
    from.z += (F.sz * side * 450 + F.fz * (pick.z > 0 ? 300 : -300));
    const g = _tugBuild();
    g.position.set(from.x, 0, from.z);
    scene.add(g);
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(16 * 3), 3));
    const line = new THREE.Line(lineGeo, _tugMat().line);
    line.frustumCulled = false; line.visible = false;
    scene.add(line);
    const t = { id: _tugNextId++, g, line, pos: new THREE.Vector3(from.x, 0, from.z), vel: new THREE.Vector3(), yaw: Math.atan2(-(from.x - shipGroup.position.x), -(from.z - shipGroup.position.z)),
                station: pick.key, action: 'standby', dir: 'side', power: 'half', state: 'coming', force: 0, arrivedAt: 0 };
    tugs.push(t);
    _tugToot(t, 1);
    renderTugPanel();
}
function tugSet(id, key, v) {
    const t = tugs.find(q => q.id === id); if (!t) return;
    if (key === 'release') { t.state = 'leaving'; t.action = 'standby'; _tugToot(t, 2); }
    else {
        t[key] = v;
        if (key === 'station' && t.state === 'on') t.state = 'coming';
        if (key === 'action' || key === 'power' || key === 'dir') _tugToot(t, 1);
    }
    renderTugPanel();
}
function tugReleaseAll() { for (const t of tugs) if (t.state !== 'leaving') { t.state = 'leaving'; t.action = 'standby'; } renderTugPanel(); }
Object.assign(window, { tugCall, tugSet, tugReleaseAll });

// タグの返事の汽笛（短く「ポッ」。n 回）
function _tugToot(t, n) {
    if (typeof audioEnsure !== 'function' || !audioEnsure() || !audio.buses || !audio.buses.horn) return;
    const c = audio.ctx;
    const em = new AudioEmitter(audio.buses.horn, 40, 0.8);
    em.update(t.g.position.clone().setY(8));
    for (let k = 0; k < n; k++) {
        const t0 = c.currentTime + 0.05 + k * 0.55;
        for (const [f, a] of [[311, 0.22], [415, 0.16]]) {
            const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f;
            const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1400;
            const g = c.createGain();
            g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(a, t0 + 0.04);
            g.gain.setValueAtTime(a, t0 + 0.32); g.gain.exponentialRampToValueAtTime(0.0005, t0 + 0.45);
            o.connect(lp); lp.connect(g); g.connect(em.input);
            o.start(t0); o.stop(t0 + 0.5);
        }
    }
    setTimeout(() => em.disconnect(), 2500 + n * 600);
}

// ── 毎フレーム ──
const _tv = new THREE.Vector3();
function updateTugs(t, dt) {
    if (!tugs.length || typeof shipGroup === 'undefined' || !shipGroup) { _tugShip.vSway *= 0.95; _tugShip.yawRate *= 0.95; return; }
    dt = Math.min(0.1, Math.max(0, dt || 0));
    shipGroup.updateMatrixWorld();
    const F = _shipFrame();
    const sp = shipGroup.position;
    // 船の速さ（ワールド）
    if (_tugShip.lastX !== null && dt > 0) {
        _tugShip.vx += ((sp.x - _tugShip.lastX) / dt - _tugShip.vx) * Math.min(1, dt * 4);
        _tugShip.vz += ((sp.z - _tugShip.lastZ) / dt - _tugShip.vz) * Math.min(1, dt * 4);
    }
    _tugShip.lastX = sp.x; _tugShip.lastZ = sp.z;
    const stations = tugStations();
    const hp = window.hullProfile;
    const sc = physics.scale || 1;
    const L = Math.max(10, ((hp && hp.ready) ? hp.halfLen * 2 : 12) * sc);
    const T = (typeof worldShipDraft === 'function') ? worldShipDraft() : 0.4 * sc;
    const massKg = Math.max(1e5, (physics.mass || 1) * 1e6);
    const speedKn = Math.abs(physics.speed || 0);
    const escort = speedKn < 5 ? 1 : Math.max(0, 1 - (speedKn - 5) / 3);     // 速いと力を出せない
    let Fs = 0, Ff = 0, Mz = 0;
    for (let i = tugs.length - 1; i >= 0; i--) {
        const tg = tugs[i];
        const st = stations.find(s => s.key === tg.station) || stations[0];
        tg.st = st;
        // 目標の位置と向き
        let tx, tz, tyaw, hook = null;
        if (tg.state === 'leaving') {
            const away = tg.pos.clone().sub(sp).setY(0).normalize();
            tx = tg.pos.x + away.x * 50; tz = tg.pos.z + away.z * 50; tyaw = Math.atan2(away.x, away.z);
            if (tg.pos.distanceTo(sp) > 900) { scene.remove(tg.g); scene.remove(tg.line); tg.line.geometry.dispose(); tugs.splice(i, 1); renderTugPanel(); continue; }
        } else {
            const side = st.side || 1;
            const hw = _tugHalfWidth(st.z) * sc;
            // 舷側の点（船の中の座標）→ ワールド
            const edge = _localToWorldFlat(st.side ? Math.sign(st.x) * _tugHalfWidth(st.z) : 0, (hp && hp.designWaterlineY) || 0, st.z);
            const out = { x: F.sx * side, z: F.sz * side };           // 舷の外向き
            if (tg.action === 'pull') {
                hook = _localToWorldFlat(st.x, st.y, st.z);
                let d = tg.dir === 'fwd' ? { x: F.fx, z: F.fz } : tg.dir === 'aft' ? { x: -F.fx, z: -F.fz } : (st.side ? out : { x: F.fx * Math.sign(st.z || 1), z: F.fz * Math.sign(st.z || 1) });
                // 横へ：金物から 45m 先。前へ・後ろへ：船首（船尾）の先 40m まで出る
                const hlw = ((hp && hp.ready) ? hp.halfLen : 6) * sc;
                const r = (tg.dir === 'fwd' ? Math.max(0, hlw - st.z * sc) + 40 : tg.dir === 'aft' ? Math.max(0, hlw + st.z * sc) + 40 : 45) + TUG_LEN / 2;
                tx = hook.x + d.x * r; tz = hook.z + d.z * r; tyaw = Math.atan2(d.x, d.z);
                tg.pullDir = d;
            } else if (tg.action === 'push') {
                if (st.side) {
                    tx = edge.x + out.x * (TUG_LEN / 2 + 1.2); tz = edge.z + out.z * (TUG_LEN / 2 + 1.2);
                    tyaw = Math.atan2(-out.x, -out.z);
                    tg.pushDir = { x: -out.x, z: -out.z };
                } else {
                    const s = Math.sign(st.z || 1);                         // 船首なら前から後ろへ押す
                    const tip = _localToWorldFlat(0, 0, (hp && hp.ready ? hp.halfLen : 6) * s);
                    tx = tip.x + F.fx * s * (TUG_LEN / 2 + 1.5); tz = tip.z + F.fz * s * (TUG_LEN / 2 + 1.5);
                    tyaw = Math.atan2(-F.fx * s, -F.fz * s);
                    tg.pushDir = { x: -F.fx * s, z: -F.fz * s };
                }
            } else {
                // 待機：舷側に並んで同じ向き
                tx = edge.x + out.x * (TUG_BEAM / 2 + 3); tz = edge.z + out.z * (TUG_BEAM / 2 + 3);
                tyaw = Math.atan2(F.fx, F.fz);
            }
        }
        // 動き：船と一緒に動きながら目標へ（最大 7m/s ＋ 船の速さ）
        const dx = tx - tg.pos.x, dz = tz - tg.pos.z, dist = Math.hypot(dx, dz);
        const maxV = 7;
        const k = Math.min(maxV, dist * 0.35) / Math.max(1e-6, dist);
        const wantVx = _tugShip.vx * (tg.state === 'leaving' ? 0 : 1) + dx * k, wantVz = _tugShip.vz * (tg.state === 'leaving' ? 0 : 1) + dz * k;
        tg.vel.x += (wantVx - tg.vel.x) * Math.min(1, dt * 1.5);
        tg.vel.z += (wantVz - tg.vel.z) * Math.min(1, dt * 1.5);
        tg.pos.x += tg.vel.x * dt; tg.pos.z += tg.vel.z * dt;
        // 遠いうちは進む向きへ、近づいたら持ち場の向きへ
        const moveYaw = Math.atan2(tg.vel.x - _tugShip.vx, tg.vel.z - _tugShip.vz);
        const relSpeed = Math.hypot(tg.vel.x - _tugShip.vx, tg.vel.z - _tugShip.vz);
        const wantYaw = (dist > 60 && relSpeed > 1) ? moveYaw : tyaw;
        let dy = Math.atan2(Math.sin(wantYaw - tg.yaw), Math.cos(wantYaw - tg.yaw));
        tg.yaw += Math.max(-0.5 * dt, Math.min(0.5 * dt, dy));
        if (tg.state === 'coming' && dist < 4 && Math.abs(dy) < 0.15) { tg.state = 'on'; tg.arrivedAt = t; renderTugPanel(); }
        if (tg.state === 'on' && dist > 25) tg.state = 'coming';
        // 波に乗る
        const oh = (typeof getOceanHeight === 'function') ? getOceanHeight(tg.pos.x, tg.pos.z, t) : 0;
        const fwdX = Math.sin(tg.yaw), fwdZ = Math.cos(tg.yaw);
        const pitch = (typeof getOceanHeight === 'function') ? Math.atan2(getOceanHeight(tg.pos.x + fwdX * 10, tg.pos.z + fwdZ * 10, t) - getOceanHeight(tg.pos.x - fwdX * 10, tg.pos.z - fwdZ * 10, t), 20) : 0;
        const roll = (typeof getOceanHeight === 'function') ? Math.atan2(getOceanHeight(tg.pos.x + fwdZ * 4, tg.pos.z - fwdX * 4, t) - getOceanHeight(tg.pos.x - fwdZ * 4, tg.pos.z + fwdX * 4, t), 8) : 0;
        tg.g.position.set(tg.pos.x, oh, tg.pos.z);
        tg.g.rotation.set(-pitch * 0.8, tg.yaw, roll * 0.8, 'YXZ');
        // 力：持ち場に付いてから、じわっと出す
        const want = (tg.state === 'on' && tg.action !== 'standby') ? TUG_POWERS[tg.power] * escort : 0;
        tg.force += (want - tg.force) * Math.min(1, dt / 4);
        let dirF = null, P = null;
        if (tg.action === 'pull' && hook) { dirF = tg.pullDir; P = hook; }
        else if (tg.action === 'push' && tg.pushDir) { dirF = tg.pushDir; P = new THREE.Vector3(tx - tg.pushDir.x * (TUG_LEN / 2), 0, tz - tg.pushDir.z * (TUG_LEN / 2)); }
        if (dirF && P && tg.force > 0.001 && !(typeof isDesignMode !== 'undefined' && isDesignMode)) {
            const f = tg.force * _tugPullN();
            const fxW = dirF.x * f, fzW = dirF.z * f;
            const fs = fxW * F.sx + fzW * F.sz, ff = fxW * F.fx + fzW * F.fz;
            const lever = (P.x - sp.x) * F.fx + (P.z - sp.z) * F.fz;
            Fs += fs; Ff += ff; Mz += fs * lever;
        }
        // 引き索：金物からタグの船尾のフックへ（張っているほどまっすぐ）
        if (tg.action === 'pull' && hook && tg.state !== 'leaving') {
            const hz = tg.g.userData.hookZ;
            const ex = tg.pos.x + Math.sin(tg.yaw) * hz, ez = tg.pos.z + Math.cos(tg.yaw) * hz, ey = oh + 2.6;
            const A = tg.line.geometry.attributes.position.array, n = 16;
            const span = Math.hypot(ex - hook.x, ez - hook.z);
            const sag = span * (0.12 - 0.1 * Math.min(1, tg.force / 0.3));
            for (let q = 0; q < n; q++) {
                const u = q / (n - 1);
                A[q * 3] = hook.x + (ex - hook.x) * u;
                A[q * 3 + 1] = hook.y + (ey - hook.y) * u - sag * 4 * u * (1 - u);
                A[q * 3 + 2] = hook.z + (ez - hook.z) * u;
            }
            tg.line.geometry.attributes.position.needsUpdate = true;
            tg.line.visible = dist < 30;
        } else tg.line.visible = false;
    }
    // ── 船への効き目 ──
    if (typeof isDesignMode !== 'undefined' && isDesignMode) return;
    const rho = 1025, Cd = 0.9;
    const mSway = massKg * 1.8;                        // 横に動くときは周りの水も一緒に動かす（付加質量）
    const Iyaw = massKg * 1.5 * L * L / 12;
    const vS = _tugShip.vSway, r = _tugShip.yawRate;
    const dragS = 0.5 * rho * Cd * L * T * vS * Math.abs(vS);
    const dragY = 0.5 * rho * Cd * T * r * Math.abs(r) * Math.pow(L, 4) / 32;
    _tugShip.vSway += ((Fs - dragS) / mSway) * dt;
    _tugShip.yawRate += ((Mz - dragY) / Iyaw) * dt;
    // 何もしていないときは、ゆっくり止まる
    if (!Fs) _tugShip.vSway *= Math.exp(-dt * 0.05);
    if (!Mz) _tugShip.yawRate *= Math.exp(-dt * 0.05);
    // 横流れ（ワールドで動かす）と回頭（heading を足す）
    physics.cgWorldX += F.sx * _tugShip.vSway * dt;
    physics.cgWorldZ += F.sz * _tugShip.vSway * dt;
    physics.heading += _tugShip.yawRate * 180 / Math.PI * dt;
    // 前後の力：ノットの速さへ
    physics.speed += (Ff / massKg) / 0.514 * dt;
}
window.updateTugs = updateTugs;

// ── 画面のボタンとパネル ──
function _tugSetup() {
    const sig = document.getElementById('btn-horn-sig') || document.getElementById('btn-horn');
    if (!sig || document.getElementById('btn-tug')) return;
    const b = document.createElement('div');
    b.id = 'btn-tug'; b.className = 'control-btn'; b.title = 'タグボート'; b.textContent = 'タグ';
    sig.after(b);
    if (typeof applyBridgeLayout === 'function') applyBridgeLayout();   // テレグラフの上に並べる
    const panel = document.createElement('div');
    panel.id = 'tug-panel';
    document.body.appendChild(panel);
    const place = () => {
        const r = b.getBoundingClientRect();
        panel.style.left = Math.max(8, Math.min(window.innerWidth - panel.offsetWidth - 8, r.left)) + 'px';
        panel.style.bottom = Math.max(8, window.innerHeight - r.top + 10) + 'px';
    };
    const setOpen = (on) => { panel.classList.toggle('open', on); b.classList.toggle('on', on); if (on) { renderTugPanel(); place(); } };
    b.addEventListener('click', (e) => { e.stopPropagation(); setOpen(!panel.classList.contains('open')); });
    panel.addEventListener('pointerdown', (e) => e.stopPropagation());
    document.addEventListener('pointerdown', (e) => {
        if (!panel.classList.contains('open') || panel.contains(e.target) || b.contains(e.target)) return;
        setOpen(false);
    });
    window.addEventListener('resize', () => { if (panel.classList.contains('open')) place(); });
    _tugSetup.place = place;
}
function renderTugPanel() {
    const panel = document.getElementById('tug-panel');
    if (!panel) return;
    const st = (typeof shipGroup !== 'undefined' && shipGroup) ? tugStations() : [];
    const stateLabel = (t) => t.state === 'coming' ? '向かっています' : t.state === 'leaving' ? '帰ります' : (t.action === 'standby' ? '待機中' : t.action === 'push' ? '押しています' : '引いています');
    const active = tugs.filter(t => t.state !== 'leaving');
    panel.innerHTML = `<div class="tg-head"><span class="tg-title">タグボート</span>
        <button class="tg-call" onclick="tugCall()" ${active.length >= TUG_MAX ? 'disabled' : ''}>＋ 呼ぶ</button>
        ${active.length ? '<button onclick="tugReleaseAll()">全部帰す</button>' : ''}</div>` +
        (tugs.length ? tugs.map(t => `
        <div class="tg-item${t.state === 'leaving' ? ' leaving' : ''}">
            <div class="tg-row"><b>タグ${t.id}</b><span class="tg-state">${stateLabel(t)}</span>
                ${t.state !== 'leaving' ? `<button class="tg-rel" onclick="tugSet(${t.id}, 'release')">帰す</button>` : ''}</div>
            ${t.state !== 'leaving' ? `
            <div class="tg-row"><select onchange="tugSet(${t.id}, 'station', this.value)">${st.map(s => `<option value="${s.key}"${s.key === t.station ? ' selected' : ''}>${s.label}</option>`).join('')}</select></div>
            <div class="tg-row">${Object.entries(TUG_ACTIONS).map(([k, l]) => `<button class="${t.action === k ? 'on' : ''}" onclick="tugSet(${t.id}, 'action', '${k}')">${l}</button>`).join('')}</div>
            <div class="tg-row">${Object.entries({ low: '微', half: '半', full: '全' }).map(([k, l]) => `<button class="pw${t.power === k ? ' on' : ''}" onclick="tugSet(${t.id}, 'power', '${k}')">${l}</button>`).join('')}
                <span class="tg-sep"></span>${t.action === 'pull' ? Object.entries(TUG_DIRS).map(([k, l]) => `<button class="dir${t.dir === k ? ' on' : ''}" onclick="tugSet(${t.id}, 'dir', '${k}')">${l}</button>`).join('') : ''}</div>` : ''}
        </div>`).join('') : '<div class="tg-empty">「＋ 呼ぶ」でタグボートが来ます。持ち場（係船設備の金物・舷側）を選んで、押す・引くを指示します。<br>速さが5ノットを超えると力が弱まり、8ノットでは効きません。</div>');
    if (panel.classList.contains('open') && _tugSetup.place) _tugSetup.place();
}
window.renderTugPanel = renderTugPanel;
document.addEventListener('DOMContentLoaded', () => { setTimeout(_tugSetup, 0); });
// 状態の表示（向かっています→待機中 など）を時々更新
setInterval(() => { const p = document.getElementById('tug-panel'); if (p && p.classList.contains('open') && tugs.length) {
    // 押しているボタンの上で書き換えないように、ボタンに触っていないときだけ
    if (!p.matches(':active')) p.querySelectorAll('.tg-state').forEach((el, i) => { const t = tugs[i]; if (t) el.textContent = t.state === 'coming' ? '向かっています' : t.state === 'leaving' ? '帰ります' : (t.action === 'standby' ? '待機中' : t.action === 'push' ? '押しています' : '引いています'); });
} }, 1000);
