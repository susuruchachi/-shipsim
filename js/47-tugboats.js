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

const TUG_MAX = 6;
// 全力の引く力[N]：船の大きさに合わせた港のタグ（小さい船 12 トン 〜 大きな船 70 トン）
// タグ 1 隻の引く・押す力[N]（ボラードプル。重い船ほど大きなタグが来る：15〜100 トン）
function _tugPullN() { return Math.max(15, Math.min(100, 15 + 1.4 * (physics.mass || 1))) * 9806; }
const TUG_LEN = 28, TUG_BEAM = 10;       // タグの大きさ[m]
const TUG_POWERS = { low: 0.25, half: 0.55, full: 1 };
const TUG_ACTIONS = { standby: '待機', push: '押す', pull: '引く' };
const TUG_DIRS = { side: '横へ', fwd: '前へ', aft: '後ろへ' };
// 引き索の長さ（横へ：金物から 45m、前後へ：船首尾の先 40m を 1 として）。狭い所では短く
const TUG_LINES = { long: { k: 1, label: '長' }, mid: { k: 0.55, label: '中' }, short: { k: 0.28, label: '短' } };

const tugs = [];                         // { id, g, line, pos, vel, yaw, station, action, dir, power, state, force, ... }
const _tugShip = { vSway: 0, yawRate: 0, lastX: null, lastZ: null, vx: 0, vz: 0 };
window.tugs = tugs;

// ── タグの形（実寸[m]。+z が船首）──
let _tugMats = null;
function _tugMat() {
    if (_tugMats) return _tugMats;
    const mk = (hex, o) => { const m = new THREE.MeshStandardMaterial(Object.assign({ roughness: 0.6, metalness: 0.1 }, o || {})); m.color.setHex(hex).convertSRGBToLinear(); return noShipLightProbe(m); };
    _tugMats = {
        hull: mk(0x1e2226), bottom: mk(0x8a2c20), house: mk(0xece9e0), win: mk(0x1a2530, { roughness: 0.2, metalness: 0.4 }),
        funnel: mk(0xd9651e), black: mk(0x141414), fender: mk(0x222222, { roughness: 0.95 }), deck: mk(0x6b5a48),
        line: ropeMaterial(),
    };
    return _tugMats;
}
// 索・もやい綱：麻の茶色。線は光を受けないので、まわりの明るさ（昼・夕方・夜・曇り）に合わせて色を暗くする（毎フレーム）
const _ropeBase = new THREE.Color().setHex(0x8b6a43).convertSRGBToLinear();
function ropeMaterial() { return ropeMaterial.m || (ropeMaterial.m = new THREE.LineBasicMaterial({ color: _ropeBase.clone() })); }
function ropeLightUpdate() {
    const k = Number.isFinite(window._fxLight) ? Math.max(0.05, Math.min(1, window._fxLight * 1.05)) : 1;
    ropeMaterial().color.copy(_ropeBase).multiplyScalar(k);
}
window.ropeMaterial = ropeMaterial;
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
    // 航行灯：マスト灯（白・引いているときは縦に2つ）、舷灯（左舷 +x が赤・右舷が緑）、船尾灯（白）、引き船灯（黄）
    //（灯具の小さな玉と、遠くからも見える画面上で一定の大きさの光。夜だけ点ける：_tugLights）
    const L = [];
    const lamp = (hex, x, y, z, dir, half, key) => {
        const c = new THREE.Color(hex);
        const bulb = new THREE.Mesh(_tugLampGeo(), new THREE.MeshBasicMaterial({ color: c, toneMapped: false }));
        bulb.position.set(x, y, z); g.add(bulb);
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: _tugGlowTex(), color: c, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, sizeAttenuation: false, toneMapped: false }));
        sp.position.set(x, y, z); sp.scale.setScalar(0.018); sp.renderOrder = 6; sp.userData.noBloom = true; g.add(sp);
        L.push({ bulb, sp, dir, half, key });
    };
    lamp(0xfff4e0, 0, 11.5, 3.6, [0, 0, 1], 112.5, 'mast');
    lamp(0xfff4e0, 0, 10.4, 3.6, [0, 0, 1], 112.5, 'tow1');
    lamp(0xff2a1a, hb * 0.62, 6.0, 5.6, [1, 0, 0.0001], 112.5, 'side');   // 前から横の少し後ろまで（正横後 22.5°）
    lamp(0x1aff6a, -hb * 0.62, 6.0, 5.6, [-1, 0, 0.0001], 112.5, 'side');
    lamp(0xfff4e0, 0, 3.2, -hl + 0.8, [0, 0, -1], 67.5, 'stern');
    lamp(0xffc030, 0, 4.0, -hl + 0.8, [0, 0, -1], 67.5, 'tow2');
    g.userData.lights = L;
    for (const q of L) if (q.key === 'side') { const fw = new THREE.Vector3(0, 0, 1), sd = new THREE.Vector3(...q.dir).normalize(); q.dir = sd.clone().multiplyScalar(Math.sin(THREE.MathUtils.degToRad(56.25))).add(fw.multiplyScalar(Math.cos(THREE.MathUtils.degToRad(56.25)))).normalize().toArray(); q.half = 56.25 + 0.5; }
    g.userData.funnels = [new THREE.Vector3(1.7, 7.9, -1.8), new THREE.Vector3(-1.7, 7.9, -1.8)];
    return g;
}
function _tugLampGeo() { return _tugLampGeo.g || (_tugLampGeo.g = new THREE.SphereGeometry(0.28, 8, 6)); }
function _tugGlowTex() {
    if (_tugGlowTex.t) return _tugGlowTex.t;
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const x = c.getContext('2d'), gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.15, 'rgba(255,255,255,0.8)'); gr.addColorStop(0.4, 'rgba(255,255,255,0.15)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
    return (_tugGlowTex.t = new THREE.CanvasTexture(c));
}
// 航行灯の点灯と、見える向き（灯の光の届く角度の外からは見えない）
const _tugV = new THREE.Vector3(), _tugD = new THREE.Vector3();
function _tugLights(tg) {
    const L = tg.g.userData.lights;
    if (!L) return;
    const night = typeof lightingNightFactor === 'number' ? lightingNightFactor : 0;
    const fogDay = (window.weather && weather.enabled && (weather.fog || 0) > 0.4) ? 1 : 0;   // 霧のときは昼も点ける
    const on = Math.max(night, fogDay);
    const towing = tg.action === 'pull' && tg.state !== 'leaving';
    for (const q of L) {
        const lit = on > 0.05 && (q.key !== 'tow1' && q.key !== 'tow2' || towing);
        q.bulb.visible = lit; q.sp.visible = lit;
        if (!lit) continue;
        // カメラが灯の光の届く角度の中にいるか（灯の向きをワールドへ）
        q.bulb.getWorldPosition(_tugV);
        _tugD.set(q.dir[0], q.dir[1], q.dir[2]).applyQuaternion(tg.g.quaternion);
        const toCam = camera.position.clone().sub(_tugV); toCam.y = 0;
        const d = toCam.length() || 1, cosA = (toCam.x * _tugD.x + toCam.z * _tugD.z) / d;
        const lim = Math.cos(THREE.MathUtils.degToRad(q.half));
        const vis = THREE.MathUtils.smoothstep(cosA, lim - 0.05, lim + 0.05);
        q.sp.material.opacity = on * vis;
        q.sp.scale.setScalar(0.012 + 0.012 * Math.min(1, d / 600));
    }
}
// 排煙：出力に応じて2本の煙突から
function _tugSmoke(tg, t) {
    if (typeof puffEmit !== 'function') return;
    const last = tg.smokeT === undefined ? t : tg.smokeT;
    const dtS = Math.min(0.5, Math.max(0, t - last)); tg.smokeT = t;
    const p = Math.max(tg.force || 0, tg.state === 'coming' || tg.state === 'leaving' ? 0.5 : 0.1);
    tg.smokeAcc = (tg.smokeAcc || 0) + dtS * (1.2 + 5 * p);
    if (tg.smokeAcc < 1) return;
    if (camera.position.distanceTo(tg.g.position) > 3000) { tg.smokeAcc = 0; return; }
    while (tg.smokeAcc >= 1) {
        tg.smokeAcc -= 1;
        const f = tg.g.userData.funnels[Math.random() < 0.5 ? 0 : 1];
        const w = tg.g.localToWorld(_tugV.copy(f));
        const c = 0.22 + Math.random() * 0.08;
        puffEmit({ x: w.x + (Math.random() - 0.5) * 0.4, y: w.y, z: w.z + (Math.random() - 0.5) * 0.4, vx: tg.vel.x * 0.6, vy: 2 + 3 * p, vz: tg.vel.z * 0.6,
            life: 6 + Math.random() * 4, s0: 1.3, s1: 10 + 6 * p, r: c, g: c, b: c * 1.03, a: 0.35 + 0.3 * p, rise: 0.4, drag: 0.5 });
    }
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
    // 張り出した所（砲郭・スポンソン・フレア）も入れた外形の幅（43-world.js）
    const ext = typeof worldHullExtentAt === 'function' ? worldHullExtentAt(zLocal) : 0;
    return Math.max(best.halfWidth || hp.halfBeam, ext);
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
                out.push({ key: `m${i}:${m}`, label: `${it.name || ('金物' + (i + 1))}${sideLabel}`, x, y: it.y, z: it.z, fitting: true, side: center ? 0 : Math.sign(x), tow: typeof mooringTowOk === 'function' ? mooringTowOk(it) : true });
            }
        });
    }
    // 金物が無くても押せるように、船首・船尾の舷側も
    for (const [zn, nm] of [[0.75, '船首'], [0, '中央'], [-0.75, '船尾']]) for (const s of [1, -1]) {
        const z = zn * hl, hw = _tugHalfWidth(z);
        out.push({ key: `d${zn}:${s}`, label: `${nm}の${s > 0 ? '左舷' : '右舷'}（舷側）`, x: s * hw, y: wl, z, fitting: false, side: s });
    }
    return out;
}
window.tugStations = tugStations;
// 引くときに索を取る金物：クリートか「タグの索を直接かける」を選んだビット・ボラードだけ
//（持ち場がそれ以外なら、同じ舷で前後の近い金物から。船の長さの 3 割より遠ければ引けない）
//（船に、索を取れる金物が一つも無いとき：タグの索を、その所の舷の甲板（ビットがあるものとして）に取る。
//  以前は引けないので、金物を置いていない船はタグでの離岸が「岸壁から離す」から先へ進まなかった）
function tugPullHook(st, stations) {
    if (!st) return null;
    if (st.fitting && st.tow) return st;
    const hp = window.hullProfile, hl = (hp && hp.ready) ? hp.halfLen : 6;
    const L = stations || tugStations();
    if (!L.some(q => q.fitting && q.tow)) {
        if (!st.side) return null;
        const deckY = (hp && hp.ready && Number.isFinite(hp.deckY)) ? hp.deckY : st.y;
        return Object.assign({}, st, { y: deckY, x: st.side * _tugHalfWidth(st.z) * 0.92, fitting: true, tow: true, deck: true });
    }
    let best = null, bd = 0.3 * hl;
    for (const q of L) {
        if (!q.fitting || !q.tow) continue;
        if (st.side && q.side && q.side !== st.side) continue;
        const d = Math.abs(q.z - st.z);
        if (d < bd) { bd = d; best = q; }
    }
    return best;
}
window.tugPullHook = tugPullHook;

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
const TUG_GONE_DIST = 1800;     // 帰るタグを消す距離[m]
function tugCall(stationKey) {
    if (tugs.filter(t => t.state !== 'leaving').length >= TUG_MAX) return null;
    if (typeof shipGroup === 'undefined' || !shipGroup) return null;
    const st = tugStations();
    // 持ち場の指定が無ければ、まだ誰も付いていない持ち場から（引ける金物を先に）
    const used = new Set(tugs.filter(t => t.state !== 'leaving').map(t => t.station));
    const pick = (stationKey && st.find(s => s.key === stationKey)) || st.find(s => s.fitting && !used.has(s.key)) || st.find(s => !used.has(s.key)) || st[0];
    // 帰りかけのタグがまだ近く（消えるまでの 1.8km 以内）にいれば、新しく呼ばずに、そのタグを呼び戻す
    {
        let back = null, bd = TUG_GONE_DIST + 200;
        for (const t of tugs) {
            if (t.state !== 'leaving' || t.aground) continue;
            const d = Math.hypot(t.pos.x - shipGroup.position.x, t.pos.z - shipGroup.position.z);
            if (d < bd) { bd = d; back = t; }
        }
        if (back) {
            Object.assign(back, { station: pick.key, action: 'standby', dir: 'side', power: 'half', state: 'coming', force: 0, arrivedAt: 0, engaged: false, lineOn: null, path: null, stallT: 0, bestDist: undefined, stuck: false });
            _tugToot(back, 1);
            renderTugPanel();
            return back;
        }
    }
    const F = _shipFrame();
    const side = pick.side || (tugs.length % 2 ? -1 : 1);
    // 沖（水の上で、まわりも水の所）から来る
    const base = Math.atan2(F.sx * side * 450 + F.fx * (pick.z > 0 ? 300 : -300), F.sz * side * 450 + F.fz * (pick.z > 0 ? 300 : -300));
    let from = null;
    for (const r of [550, 400, 280, 180]) {
        for (let k = 0; k < 16 && !from; k++) {
            const ang = base + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * Math.PI / 8;
            const x = shipGroup.position.x + Math.sin(ang) * r, z = shipGroup.position.z + Math.cos(ang) * r;
            if (_tugPts(x, z, ang + Math.PI).some(q => _tugStaticBlocked(q.x, q.z))) continue;
            // 船までまっすぐ水の上を来られる所から（岬や砂州の向こうから出てこないように）
            let clear = true;
            for (let d = 20; d < r - 60 && clear; d += 20) {
                const px = x - Math.sin(ang) * d, pz = z - Math.cos(ang) * d;
                if (_tugStaticBlocked(px, pz) || _tugStaticBlocked(px + Math.cos(ang) * 12, pz - Math.sin(ang) * 12) || _tugStaticBlocked(px - Math.cos(ang) * 12, pz + Math.sin(ang) * 12)) clear = false;
            }
            if (clear) from = new THREE.Vector3(x, 0, z);
        }
        if (from) break;
    }
    if (!from) { const x = shipGroup.position.x + F.sx * side * 120, z = shipGroup.position.z + F.sz * side * 120; from = new THREE.Vector3(x, 0, z); }
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
    return t;
}
function tugSet(id, key, v) {
    const t = tugs.find(q => q.id === id); if (!t) return;
    if (key === 'release') { t.state = 'leaving'; t.action = 'standby'; t.engaged = false; _tugToot(t, 2); }
    else {
        t[key] = v;
        if (key === 'station') { t.engaged = false; if (t.state === 'on') t.state = 'coming'; }
        if (key === 'action' || key === 'power' || key === 'dir' || key === 'lineLen') _tugToot(t, 1);
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

// ── ぶつからないように ──
//  ・陸・防波堤・岸壁・桟橋・停泊中の船：worldSeabedAt（44-world-terrain.js）で底がタグの喫水より浅い所
//  ・自分の船：船の中の座標で、船体の長さ・その場所の幅（＋余裕）の中
//  タグは 船首・真ん中・船尾 の3点で見る。押すときの船首だけは船体に触れてよい。
const TUG_DRAFT = 4.5;
function _tugStaticBlocked(x, z) {
    if (!window.world || world.mode !== 'world' || typeof worldSeabedAt !== 'function') return false;
    return worldSeabedAt(x, z) > -TUG_DRAFT;
}
// 他の船（59-traffic.js）の船体の中か（m：船体の外へ足す余裕[m]）
function _tugInTraffic(x, z, m) {
    if (typeof trafficHulls !== 'function') return false;
    for (const H of trafficHulls()) {
        const dx = x - H.x, dz = z - H.z;
        if (Math.abs(dx) > H.HL + m + 60 || Math.abs(dz) > H.HL + m + 60) continue;
        const a = dx * H.fx + dz * H.fz;
        if (Math.abs(a) > H.HL + m) continue;
        if (Math.abs(dx * H.sx + dz * H.sz) < Math.max(0, H.hw(Math.max(-H.HL, Math.min(H.HL, a)))) + m) return true;
    }
    return false;
}
window.tugInTraffic = _tugInTraffic;
function _tugShipCtx() {
    const hp = window.hullProfile;
    const sc = physics.scale || 1;
    const HL = ((hp && hp.ready) ? hp.halfLen : 6) * sc;
    let hwMax = 0;
    for (let k = -10; k <= 10; k++) hwMax = Math.max(hwMax, _tugHalfWidth(k / 10 * HL / sc) * sc);
    return { F: _shipFrame(), sp: shipGroup.position.clone(), HL, hwMax, sc };
}
function _tugToShip(C, x, z) { const dx = x - C.sp.x, dz = z - C.sp.z; return { a: dx * C.F.fx + dz * C.F.fz, s: dx * C.F.sx + dz * C.F.sz }; }
function _tugFromShip(C, a, sd) { return { x: C.sp.x + C.F.fx * a + C.F.sx * sd, z: C.sp.z + C.F.fz * a + C.F.sz * sd }; }
// 船体の中へどれだけ入っているか（入っていなければ 0 以下）
function _tugShipPen(C, x, z, margin) {
    const L = _tugToShip(C, x, z);
    if (Math.abs(L.a) > C.HL + margin) return { pen: -1, L };
    const hw = _tugHalfWidth(L.a / C.sc) * C.sc;
    // 船首・船尾の先は丸く細くなるので、端の余裕は少しずつ減らす
    const endK = Math.max(0, 1 - Math.max(0, Math.abs(L.a) - C.HL) / Math.max(1, margin));
    return { pen: hw + margin * endK - Math.abs(L.s), L };
}
function _tugPts(x, z, yaw) {
    const fx = Math.sin(yaw), fz = Math.cos(yaw), h = TUG_LEN / 2 - 2;
    return [{ x: x + fx * h, z: z + fz * h, bow: true }, { x, z }, { x: x - fx * h, z: z - fz * h }];
}
function _tugPathClear(C, x0, z0, x1, z1) {
    const d = Math.hypot(x1 - x0, z1 - z0), n = Math.max(1, Math.ceil(d / 12));
    for (let k = 1; k <= n; k++) {
        const u = k / n, x = x0 + (x1 - x0) * u, z = z0 + (z1 - z0) * u;
        if (_tugStaticBlocked(x, z)) return false;
        if (_tugShipPen(C, x, z, TUG_BEAM / 2 + 4).pen > 0) return false;
    }
    return true;
}
// 次に向かう点：船の反対側へ行くときは、近い方の端（船首・船尾）を回る
function _tugNextGoal(C, tg, tx, tz) {
    const P = _tugToShip(C, tg.pos.x, tg.pos.z), T = _tugToShip(C, tx, tz);
    const w = C.hwMax + TUG_BEAM + 12, end = C.HL + TUG_LEN / 2 + 25;
    const sideP = Math.abs(P.s) < 1 ? 1 : Math.sign(P.s), sideT = Math.abs(T.s) < C.hwMax * 0.3 ? 0 : Math.sign(T.s);
    const alongside = Math.abs(P.a) < end - 5;
    const endA = (Math.abs(P.a - end) + Math.abs(T.a - end) <= Math.abs(P.a + end) + Math.abs(T.a + end)) ? end : -end;
    if (sideT !== 0 && sideT !== sideP) {
        if (alongside) return _tugFromShip(C, endA, sideP * w);             // まず自分の側を端まで
        return _tugFromShip(C, endA, sideT * w);                            // 端を回って向こう側へ
    }
    if (sideT === 0 && alongside && Math.abs(T.a) > C.HL) return _tugFromShip(C, endA, sideP * w);   // 船首・船尾の先へは、端を回って
    return { x: tx, z: tz };
}
// 向かう向き（障害物があれば、左右に振って通れる向きを探す）
function _tugSteer(C, tg, gx, gz, look) {
    const base = Math.atan2(gx - tg.pos.x, gz - tg.pos.z);
    const dist = Math.hypot(gx - tg.pos.x, gz - tg.pos.z);
    const L = Math.min(look, dist);
    // ほかのタグも障害物（持ち場のすぐ手前では見ない：となりの持ち場のタグに寄り添って止まれるように）
    const others = dist > 30 ? tugs.filter(o => o !== tg && o.state !== 'leaving' && Math.hypot(o.pos.x - tg.pos.x, o.pos.z - tg.pos.z) < L + 20) : [];
    const ok = (ang) => {
        const dx = Math.sin(ang), dz = Math.cos(ang), x1 = tg.pos.x + dx * L, z1 = tg.pos.z + dz * L;
        for (const o of others) {
            const rx = o.pos.x - tg.pos.x, rz = o.pos.z - tg.pos.z, along = rx * dx + rz * dz;
            if (along < 4 || along > L + 8) continue;
            if (Math.abs(rx * dz - rz * dx) < TUG_BEAM + 4) return false;
        }
        return _tugPathClear(C, tg.pos.x, tg.pos.z, x1, z1);
    };
    if (L < 3 || ok(base)) { tg.avoid = 0; return base; }
    const pref = tg.avoid || 1;
    for (let k = 1; k <= 10; k++) for (const sgn of [pref, -pref]) {
        const ang = base + sgn * k * 0.26;
        if (ok(ang)) { tg.avoid = sgn; return ang; }
    }
    return null;                                    // どこにも行けない：その場で待つ
}

// ── 港の中の道すじ（防波堤の口を通って入る）──
//  船のまわり 1.6km 四方を 16m の升目に分け、陸・防波堤・岸壁・桟橋を「通れない」にして
//  （タグの幅の分だけ太らせて）、A* で道を探す。升目は船が 400m 動くまで使い回す。
const TUG_GRID_N = 100, TUG_GRID_CELL = 16;
let _tugGrid = null;
function _tugGridGet() {
    if (!window.world || world.mode !== 'world' || typeof worldSeabedAt !== 'function') return null;
    const sp = shipGroup.position;
    if (_tugGrid && Math.hypot(sp.x - _tugGrid.cx, sp.z - _tugGrid.cz) < 400 && _tugGrid.ports === terrain.ports.size) return _tugGrid;
    const n = TUG_GRID_N, c = TUG_GRID_CELL, cx = Math.round(sp.x), cz = Math.round(sp.z);
    const x0 = cx - n * c / 2, z0 = cz - n * c / 2;
    const raw = new Uint8Array(n * n);
    let any = false;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const b = worldSeabedAt(x0 + (i + 0.5) * c, z0 + (j + 0.5) * c) > -TUG_DRAFT ? 1 : 0;
        raw[j * n + i] = b; if (b) any = true;
    }
    const blocked = new Uint8Array(n * n);
    if (any) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        let b = 0;
        for (let dj = -1; dj <= 1 && !b; dj++) for (let di = -1; di <= 1 && !b; di++) {
            const a = i + di, q = j + dj;
            if (a >= 0 && q >= 0 && a < n && q < n && raw[q * n + a]) b = 1;
        }
        blocked[j * n + i] = b;
    }
    _tugGrid = { cx, cz, x0, z0, n, c, blocked, any, ports: terrain.ports.size };
    return _tugGrid;
}
function _tugGridPath(G, x, z, gx, gz) {
    const n = G.n, c = G.c;
    const cell = (px, pz) => [Math.floor((px - G.x0) / c), Math.floor((pz - G.z0) / c)];
    const inG = (i, j) => i >= 0 && j >= 0 && i < n && j < n;
    const free = (i, j) => inG(i, j) && !G.blocked[j * n + i];
    const near = (i, j) => {
        if (free(i, j)) return [i, j];
        for (let r = 1; r < 8; r++) for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) if (Math.max(Math.abs(di), Math.abs(dj)) === r && free(i + di, j + dj)) return [i + di, j + dj];
        return null;
    };
    let [si, sj] = cell(x, z), [ei, ej] = cell(gx, gz);
    if (!inG(si, sj) || !inG(ei, ej)) return null;                 // 升目の外：そのまま向かう
    const s = near(si, sj), e = near(ei, ej);
    if (!s || !e) return null;
    const N = n * n, g = new Float32Array(N).fill(Infinity), from = new Int32Array(N).fill(-1), closed = new Uint8Array(N);
    const heap = [];
    const push = (k, f) => { heap.push([f, k]); let q = heap.length - 1; while (q > 0) { const pp = (q - 1) >> 1; if (heap[pp][0] <= heap[q][0]) break; [heap[pp], heap[q]] = [heap[q], heap[pp]]; q = pp; } };
    const pop = () => { const top = heap[0], lst = heap.pop(); if (heap.length) { heap[0] = lst; let q = 0; for (;;) { const l = 2 * q + 1, r = l + 1; let m = q; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === q) break; [heap[m], heap[q]] = [heap[q], heap[m]]; q = m; } } return top; };
    const sk = s[1] * n + s[0], ek = e[1] * n + e[0];
    g[sk] = 0; push(sk, 0);
    while (heap.length) {
        const [, k] = pop();
        if (closed[k]) continue; closed[k] = 1;
        if (k === ek) break;
        const i = k % n, j = (k - i) / n;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
            if (!di && !dj) continue;
            const a = i + di, b = j + dj;
            if (!free(a, b)) continue;
            if (di && dj && (!free(i + di, j) || !free(i, j + dj))) continue;   // 角をすり抜けない
            const kk = b * n + a, ng = g[k] + (di && dj ? 1.414 : 1);
            if (ng < g[kk]) { g[kk] = ng; from[kk] = k; push(kk, ng + Math.hypot(a - e[0], b - e[1])); }
        }
    }
    if (from[ek] < 0 && ek !== sk) return null;
    const pts = [];
    for (let k = ek; k >= 0; k = from[k]) pts.push({ x: G.x0 + (k % n + 0.5) * c, z: G.z0 + (Math.floor(k / n) + 0.5) * c });
    pts.reverse();
    // 見通せる所はまっすぐに
    const clear = (A, B) => {
        const d = Math.hypot(B.x - A.x, B.z - A.z), m = Math.max(1, Math.ceil(d / (c * 0.5)));
        for (let q = 1; q < m; q++) { const [a, b] = cell(A.x + (B.x - A.x) * q / m, A.z + (B.z - A.z) * q / m); if (!free(a, b)) return false; }
        return true;
    };
    const out = [];
    let cur = { x, z };
    let i = 0;
    while (i < pts.length) {
        let j = i;
        while (j + 1 < pts.length && clear(cur, pts[j + 1])) j++;
        out.push(pts[j]); cur = pts[j]; i = j + 1;
    }
    out.push({ x: gx, z: gz });
    return out;
}

// ── 毎フレーム（物理の早送りに合わせて、細かく刻んで進める）──
// 船の通った跡（深い水の道）。見通しの利かないタグは、これをたどって船に追いつく
const _tugCrumbs = [];
window._tugCrumbs = _tugCrumbs;
function _tugRecordCrumb() {
    if (typeof shipGroup === 'undefined' || !shipGroup) return;
    const p = shipGroup.position, L = _tugCrumbs[_tugCrumbs.length - 1];
    if (L && Math.hypot(p.x - L.x, p.z - L.z) > 5000) _tugCrumbs.length = 0;      // 港へ移った・原点を移した
    if (!L || Math.hypot(p.x - L.x, p.z - L.z) > 40) { _tugCrumbs.push({ x: p.x, z: p.z }); if (_tugCrumbs.length > 250) _tugCrumbs.shift(); }
}
// タグが通れる見通し（まっすぐ水の上を行けるか。タグの幅の分、左右も見る）
function _tugLos(x0, z0, x1, z1) {
    const d = Math.hypot(x1 - x0, z1 - z0); if (d < 1) return true;
    const ux = (x1 - x0) / d, uz = (z1 - z0) / d;
    for (let s = 15; s < d; s += 15) {
        const x = x0 + ux * s, z = z0 + uz * s;
        if (_tugStaticBlocked(x, z) || _tugStaticBlocked(x - uz * 7, z + ux * 7) || _tugStaticBlocked(x + uz * 7, z - ux * 7)) return false;
    }
    return true;
}
// 見通しが利かないとき：見える跡のうち、いちばん船に近い（新しい）ものへ
function _tugCrumbGoal(tg, gx, gz) {
    tg.losT = (tg.losT || 0) - 1;
    if (tg.crumbGoal && Math.hypot(tg.crumbGoal.x - tg.pos.x, tg.crumbGoal.z - tg.pos.z) < 30) tg.losT = 0;   // 着いたら次の跡へ
    if (tg.losT > 0) return tg.crumbGoal || null;
    tg.losT = 20;                                     // 何ステップかに一度だけ調べる
    tg.crumbGoal = null;
    if (Math.hypot(gx - tg.pos.x, gz - tg.pos.z) < 120 || _tugLos(tg.pos.x, tg.pos.z, gx, gz)) return null;
    for (let i = _tugCrumbs.length - 1; i >= 0; i--) {
        const c = _tugCrumbs[i];
        if (Math.hypot(c.x - tg.pos.x, c.z - tg.pos.z) > 3000) continue;
        if (_tugLos(tg.pos.x, tg.pos.z, c.x, c.z)) { tg.crumbGoal = c; break; }
    }
    return tg.crumbGoal;
}
function updateTugs(t, dt) {
    ropeLightUpdate();
    _tugRecordCrumb();
    // （タグがいない間は船の速さを測らないので、次に呼んだとき古い位置との差で速さが跳ねないよう、測り直す）
    // （サイドスラスター・アジポッド（58-maneuvering.js）を使っている間は、タグがいなくても横流れ・回頭を計算する）
    const extra = typeof maneuverActive === 'function' && maneuverActive();
    if ((!tugs.length && !extra) || typeof shipGroup === 'undefined' || !shipGroup) { _tugShip.vSway *= 0.95; _tugShip.yawRate *= 0.95; _tugShip.lastX = null; _tugShip.vx = 0; _tugShip.vz = 0; return; }
    dt = Math.min(2, Math.max(0, dt || 0));
    if (dt <= 0) return;
    shipGroup.updateMatrixWorld();
    const sp = shipGroup.position;
    // 船の速さ（ワールド、物理の時間で）
    if (_tugShip.lastX !== null) {
        _tugShip.vx += ((sp.x - _tugShip.lastX) / dt - _tugShip.vx) * Math.min(1, dt * 4);
        _tugShip.vz += ((sp.z - _tugShip.lastZ) / dt - _tugShip.vz) * Math.min(1, dt * 4);
        const vv = Math.hypot(_tugShip.vx, _tugShip.vz);
        if (vv > 25) { _tugShip.vx *= 25 / vv; _tugShip.vz *= 25 / vv; }    // 船が瞬間移動した（港へ移った等）ときの跳ね
    }
    _tugShip.lastX = sp.x; _tugShip.lastZ = sp.z;
    const n = Math.max(1, Math.ceil(dt / 0.1)), h = dt / n;
    for (let k = 0; k < n; k++) _tugStep(t, h, k === n - 1);
}
function _tugStep(t, dt, last) {
    const C = _tugShipCtx();
    const F = C.F, sp = C.sp;
    const stations = tugStations();
    const hp = window.hullProfile;
    const sc = C.sc;
    const L = Math.max(10, C.HL * 2);
    const T = (typeof worldShipDraft === 'function') ? worldShipDraft() : 0.4 * sc;
    const massKg = Math.max(1e5, (physics.mass || 1) * 1e6);
    const speedKn = Math.abs(physics.speed || 0);
    // 速いと力を出せない（付き添いのタグは 6 ノットまでは全力、12 ノットで 0：狭い水路は 10 ノットほどで通る）
    const escort = speedKn < 6 ? 1 : Math.max(0, 1 - (speedKn - 6) / 6);
    let Fs = 0, Ff = 0, Mz = 0;
    for (let i = tugs.length - 1; i >= 0; i--) {
        const tg = tugs[i];
        const st = stations.find(s => s.key === tg.station) || stations[0];
        tg.st = st;
        // 目標の位置と向き
        let tx, tz, tyaw, hook = null;
        if (tg.state === 'leaving' && tg.aground) {
            // 座礁したタグ：その場で動かず、しばらくしたら（引き出された）ことにして消す
            tg.agT = (tg.agT || 0) + dt; tg.vel.set(0, 0, 0); tg.force = 0;
            if (tg.agT > 90) { scene.remove(tg.g); scene.remove(tg.line); tg.line.geometry.dispose(); tugs.splice(i, 1); renderTugPanel(); continue; }
            if (last) _tugVisual(tg, t, null, 0);
            continue;
        }
        if (tg.state === 'leaving') {
            const away = tg.pos.clone().sub(sp).setY(0).normalize();
            tx = tg.pos.x + away.x * 200; tz = tg.pos.z + away.z * 200; tyaw = Math.atan2(away.x, away.z);
            // 1.8km 離れたら帰り着いたことにして消す（それまでに呼ばれたら、新しく呼ばずにこのタグを呼び戻す：tugCall）
            if (tg.pos.distanceTo(sp) > TUG_GONE_DIST) { scene.remove(tg.g); scene.remove(tg.line); tg.line.geometry.dispose(); tugs.splice(i, 1); renderTugPanel(); continue; }
        } else {
            let side = st.side || 1;
            const hw = _tugHalfWidth(st.z) * sc;
            // 待機：その舷が岸壁・陸で塞がっていたら反対舷に付く
            // （自動の離着岸で、岸壁側のタグを沖側へ回して待たせるときも：tg.awaySide）
            let flipped = false;
            if (tg.action === 'standby' && st.side) {
                const e0 = _tugFromShip(C, st.z * sc, side * (hw + TUG_BEAM / 2 + 3));
                if (tg.awaySide || _tugStaticBlocked(e0.x, e0.z)) { side = -side; flipped = true; }
            }
            const out = { x: F.sx * side, z: F.sz * side };           // 舷の外向き
            const edge = _tugFromShip(C, st.z * sc, st.side ? side * hw : 0);
            const hs = tugPullHook(st, stations);
            tg.canPull = !!hs;
            // 索：一度取ったら、待機・押すときも繋いだまま（帰すときに放す）
            if (hs && tg.state === 'on') tg.lineOn = hs.key;
            if (!hs) tg.lineOn = null;
            if (tg.lineOn && hs) tg.lineHook = _localToWorldFlat(hs.x, hs.y, hs.z);
            // 索は舷の縁から外へ出る（甲板の内側の金物から、舷の外へまっすぐ抜けないように）
            if (hs) { const sd = Math.sign(hs.x) || side; tg.lineEdge = _localToWorldFlat(sd * Math.max(_tugHalfWidth(hs.z), Math.abs(hs.x)) * 1.01, hs.y, hs.z); }
            else tg.lineEdge = null;
            if (tg.action === 'pull' && hs) {
                hook = _localToWorldFlat(hs.x, hs.y, hs.z);
                const d = tg.dir === 'fwd' ? { x: F.fx, z: F.fz } : tg.dir === 'aft' ? { x: -F.fx, z: -F.fz } : (st.side ? out : { x: F.fx * Math.sign(st.z || 1), z: F.fz * Math.sign(st.z || 1) });
                // 横へ：金物から 45m 先。前へ・後ろへ：船首（船尾）の先 40m まで出る（索の長さ：長・中・短）。
                // 引く所が陸・岸壁・浅瀬にかかるときは、索を自動で縮める（狭い埠頭の間など）
                const k0 = (TUG_LINES[tg.lineLen] || TUG_LINES.long).k;
                const at = (k) => {
                    const ext = Math.max(8, (tg.dir === 'side' ? 45 : 40) * k);
                    const r = (tg.dir === 'fwd' ? Math.max(0, C.HL - st.z * sc) + ext : tg.dir === 'aft' ? Math.max(0, C.HL + st.z * sc) + ext : ext) + TUG_LEN / 2;
                    // 前へ・後ろへ引くときは、船首尾の中心線の先から
                    if (tg.dir !== 'side' && st.side) return _tugFromShip(C, (tg.dir === 'fwd' ? 1 : -1) * (C.HL + ext + TUG_LEN / 2), 0);
                    return { x: hook.x + d.x * r, z: hook.z + d.z * r };
                };
                // 引く所が他の船（向かいの岸壁に着いている船など）にかかるときも縮める（タグが船の間に挟まれないように）
                const busy = (p) => _tugStaticBlocked(p.x, p.z) || _tugInTraffic(p.x, p.z, TUG_BEAM / 2 + 2)
                    || _tugInTraffic(p.x + d.x * TUG_LEN / 2, p.z + d.z * TUG_LEN / 2, 3);
                let q = at(k0);
                tg.lineAuto = false;
                for (const f of [0.6, 0.35, 0.2]) { if (!busy(q)) break; const q2 = at(k0 * f); q = q2; tg.lineAuto = true; }
                tg.pullBusy = busy(q);
                tx = q.x; tz = q.z; tyaw = Math.atan2(d.x, d.z);
                tg.pullDir = d;
            } else if (tg.action === 'push') {
                if (st.side) {
                    tx = edge.x + out.x * (TUG_LEN / 2 + 1.2); tz = edge.z + out.z * (TUG_LEN / 2 + 1.2);
                    tyaw = Math.atan2(-out.x, -out.z);
                    tg.pushDir = { x: -out.x, z: -out.z };
                } else {
                    const s2 = Math.sign(st.z || 1);                         // 船首なら前から後ろへ押す
                    const tip = _tugFromShip(C, s2 * C.HL, 0);
                    tx = tip.x + F.fx * s2 * (TUG_LEN / 2 + 1.5); tz = tip.z + F.fz * s2 * (TUG_LEN / 2 + 1.5);
                    tyaw = Math.atan2(-F.fx * s2, -F.fz * s2);
                    tg.pushDir = { x: -F.fx * s2, z: -F.fz * s2 };
                }
            } else {
                // 待機：舷側に並んで同じ向き（反対舷へ回ったときは、そこで押し引きしているタグの外側で）
                // 待つ所が陸・浅瀬・岸壁にかかるときは、船の中央寄りの空いている所で待つ（ほかのタグの道もふさがない）
                const gap = TUG_BEAM / 2 + 3 + (flipped ? TUG_LEN + 8 : 0);
                tx = edge.x + out.x * gap; tz = edge.z + out.z * gap;
                if (_tugStaticBlocked(tx, tz)) {
                    for (const f of [0.6, 0.3, 0, -0.3]) {
                        const zz = st.z * sc * f, hw2 = _tugHalfWidth(zz / sc) * sc;
                        const q = _tugFromShip(C, zz, side * (hw2 + gap));
                        if (!_tugStaticBlocked(q.x, q.z)) { tx = q.x; tz = q.z; break; }
                    }
                }
                tyaw = Math.atan2(F.fx, F.fz);
            }
        }
        tg.blockedTarget = _tugStaticBlocked(tx, tz);
        // 押す位置へは、いったん少し外（15m）まで来てから、まっすぐ船体へ
        let ax = tx, az = tz;
        const pushing = tg.action === 'push' && tg.pushDir && tg.state !== 'leaving';
        if (pushing) {
            const dFin = Math.hypot(tx - tg.pos.x, tz - tg.pos.z);
            const faced = Math.abs(Math.atan2(Math.sin(tyaw - tg.yaw), Math.cos(tyaw - tg.yaw))) < 0.35;
            if (!(dFin < 22 && faced)) { ax = tx - tg.pushDir.x * 15; az = tz - tg.pushDir.z * 15; }
        }
        // 船の向こう側へは端を回って。港の中は升目の道すじに沿って。細かい障害物は左右に振ってよける
        let goal = tg.state === 'leaving' ? { x: tx, z: tz } : _tugNextGoal(C, tg, ax, az);
        const G = _tugGridGet();
        if (G && G.any) {
            tg.planT = (tg.planT || 0) - dt;
            const moved = !tg.planGoal || Math.hypot(goal.x - tg.planGoal.x, goal.z - tg.planGoal.z) > 30;
            if (tg.planT <= 0 || moved) {
                tg.planT = 3; tg.planGoal = { x: goal.x, z: goal.z };
                tg.path = _tugGridPath(G, tg.pos.x, tg.pos.z, goal.x, goal.z);
            }
            if (tg.path && tg.path.length) {
                while (tg.path.length > 1 && Math.hypot(tg.path[0].x - tg.pos.x, tg.path[0].z - tg.pos.z) < 20) tg.path.shift();
                goal = tg.path[0];
            }
        }
        // 港の外で、浅瀬などで船が見えないときは、船の通った跡をたどる
        if (tg.state === 'coming' && !(tg.path && tg.path.length)) {
            const cg = _tugCrumbGoal(tg, goal.x, goal.z);
            if (cg) goal = cg;
        }
        const gd = Math.hypot(goal.x - tg.pos.x, goal.z - tg.pos.z);
        tg.steerT = (tg.steerT || 0) - dt;
        if (tg.steerT <= 0 || tg.steerAng === undefined) {
            tg.steerT = 0.25;
            const finalApproach = pushing && goal.x === ax && ax === tx;          // 船体に当てる最後の15mは船をよけない
            tg.steerAng = finalApproach ? Math.atan2(goal.x - tg.pos.x, goal.z - tg.pos.z) : _tugSteer(C, tg, goal.x, goal.z, 60);
        }
        // 動き：船と一緒に動きながら目標へ（最大 10m/s ≒ 19 ノット ＋ 船の速さ。以前は 7m/s で、呼んでから着くまでが長すぎた）
        const withShip = tg.state === 'leaving' ? 0 : 1;
        let wantVx = _tugShip.vx * withShip, wantVz = _tugShip.vz * withShip;
        if (tg.steerAng !== null && gd > 0.5) {
            const sp2 = Math.min(10, gd * 0.45);
            wantVx += Math.sin(tg.steerAng) * sp2; wantVz += Math.cos(tg.steerAng) * sp2;
        }
        tg.vel.x += (wantVx - tg.vel.x) * Math.min(1, dt * 2);
        tg.vel.z += (wantVz - tg.vel.z) * Math.min(1, dt * 2);
        // 向き：遠いうちは進む向きへ、近づいたら持ち場の向きへ
        const relVx = tg.vel.x - _tugShip.vx * withShip, relVz = tg.vel.z - _tugShip.vz * withShip;
        const relSpeed = Math.hypot(relVx, relVz);
        const dist = Math.hypot(tx - tg.pos.x, tz - tg.pos.z);
        const wantYaw = (dist > 40 && relSpeed > 1) ? Math.atan2(relVx, relVz) : tyaw;
        const dy = Math.atan2(Math.sin(wantYaw - tg.yaw), Math.cos(wantYaw - tg.yaw));
        const newYaw = tg.yaw + Math.max(-0.7 * dt, Math.min(0.7 * dt, dy));
        // 進めてみて、ぶつかるなら進まない（船に押されたときは外へ押し出す）
        let nx = tg.pos.x + tg.vel.x * dt, nz = tg.pos.z + tg.vel.z * dt;
        // （もう浅い所に入り込んでいたら（地形の細かい絵ができて浅くなった所など）、抜け出すまでは止めない）
        const stuckIn = _tugPts(tg.pos.x, tg.pos.z, tg.yaw).some(q => _tugStaticBlocked(q.x, q.z));
        const hitStatic = (x, z, yaw) => !stuckIn && _tugPts(x, z, yaw).some(q => _tugStaticBlocked(q.x, q.z));
        if (hitStatic(nx, nz, newYaw)) {
            // 横すべりで行けるなら（壁に沿って）
            if (!hitStatic(nx, tg.pos.z, newYaw)) nz = tg.pos.z;
            else if (!hitStatic(tg.pos.x, nz, newYaw)) nx = tg.pos.x;
            else { nx = tg.pos.x; nz = tg.pos.z; }
            tg.vel.multiplyScalar(0.3);
        }
        tg.yaw = hitStatic(nx, nz, newYaw) ? tg.yaw : newYaw;
        // ほかのタグと重ならないように（船体を3つの円で表し、重なった分だけ離れる。
        // 両方のタグが毎回少しずつよけるので、持ち場が近くても横に並んで止まる）
        tg.tugNear = false;
        if (tg.state !== 'leaving') {
            const R = TUG_BEAM / 2 + 1;
            for (const o of tugs) {
                if (o === tg || o.state === 'leaving' || Math.hypot(o.pos.x - nx, o.pos.z - nz) > TUG_LEN + 2 * R) continue;
                const A = _tugPts(nx, nz, tg.yaw), B = _tugPts(o.pos.x, o.pos.z, o.yaw);
                let px = 0, pz = 0, pen = 0;
                for (const a of A) for (const q of B) {
                    const dx = a.x - q.x, dz = a.z - q.z, d = Math.hypot(dx, dz), p = 2 * R - d;
                    if (p > pen) { pen = p; const k = d > 1e-3 ? 1 / d : 0; px = d > 1e-3 ? dx * k : (nx >= o.pos.x ? 1 : -1); pz = dz * k; }
                }
                if (pen > 0) {
                    // 向かっている途中なら、自分の進む向きの成分を除いて横へずれる（押し返し合って行き詰まらず、すり抜ける）
                    if (tg.state === 'coming' && tg.steerAng !== null && tg.steerAng !== undefined) {
                        const dx = Math.sin(tg.steerAng), dz = Math.cos(tg.steerAng), along = px * dx + pz * dz;
                        let qx = px - along * dx, qz = pz - along * dz, ql = Math.hypot(qx, qz);
                        if (ql < 0.3) { const sg = ((tg.id + o.id) % 2 ? 1 : -1) * (tg.id < o.id ? 1 : -1); qx = dz * sg; qz = -dx * sg; ql = 1; }
                        px = qx / ql; pz = qz / ql;
                    }
                    const m = Math.min(pen * 0.6, 4 * dt + pen * 0.3); nx += px * m; nz += pz * m; tg.tugNear = true;
                }
            }
        }
        // 自分の船と重ならないように（押しているときの船首は触れてよい）
        for (let it = 0; it < 2; it++) {
            let worst = 0, push = null;
            for (const q of _tugPts(nx, nz, tg.yaw)) {
                const m = (pushing && q.bow) ? 0.3 : TUG_BEAM / 2 + 0.5;
                const r = _tugShipPen(C, q.x, q.z, m);
                if (r.pen > worst) { worst = r.pen; push = r.L; }
            }
            if (worst <= 0) break;
            const sgn = Math.abs(push.s) < 0.01 ? 1 : Math.sign(push.s);
            nx += F.sx * sgn * worst; nz += F.sz * sgn * worst;
        }
        // 他の船（59-traffic.js）とも重ならないように：船体の外へ押し出し、船体へ向かう速さを消す
        if (typeof trafficHulls === 'function') {
            for (const H of trafficHulls()) {
                if (Math.abs(H.x - nx) > H.HL + TUG_LEN || Math.abs(H.z - nz) > H.HL + TUG_LEN) continue;
                for (const q of _tugPts(nx, nz, tg.yaw)) {
                    const dx = q.x - H.x, dz = q.z - H.z, a = dx * H.fx + dz * H.fz, sb = dx * H.sx + dz * H.sz;
                    if (Math.abs(a) >= H.HL) continue;
                    const pen = H.hw(a) + TUG_BEAM / 2 + 0.5 - Math.abs(sb);
                    if (pen <= 0) continue;
                    const sg = sb >= 0 ? 1 : -1, ux = H.sx * sg, uz = H.sz * sg;
                    nx += ux * pen; nz += uz * pen;
                    const vin = tg.vel.x * ux + tg.vel.z * uz;
                    if (vin < 0) { tg.vel.x -= ux * vin; tg.vel.z -= uz * vin; }
                    tg.tugNear = true;
                }
            }
        }
        tg.pos.x = nx; tg.pos.z = nz;
        // 座礁：浅い所に入り込んだまま、または持ち場へ向かっているのにまったく動けないまま、しばらくたったら
        // 代わりのタグを呼ぶ（持ち場が岸・浅瀬に塞がれているだけのときは、代わりも入れないので呼ばない）
        if (tg.state !== 'leaving' && _tugCheckAground(tg, stuckIn, dt)) { _tugReplace(tg); if (last) renderTugPanel(); continue; }
        if (tg.state === 'coming' && dist < (tg.tugNear ? 16 : 4) && Math.abs(dy) < 0.15) { tg.state = 'on'; tg.arrivedAt = t; tg.engaged = true; renderTugPanel(); }
        if (tg.state === 'on' && dist > 25) tg.state = 'coming';
        // 近づけないタグ（持ち場が岸・浅瀬に塞がれている、または 20 秒たっても近づけない：船と岸・船と船のすき間が狭いなど）
        //（自動の離着岸・付き添いは、動けるタグだけで先に始める。このタグは近づき続け、着いたら加わる）
        if (tg.state === 'coming') {
            if (tg.bestDist === undefined || dist < tg.bestDist - 5) { tg.bestDist = dist; tg.stallT = 0; }
            else tg.stallT = (tg.stallT || 0) + dt;
        } else { tg.bestDist = undefined; tg.stallT = 0; }
        tg.stuck = tg.state === 'coming' && (tg.blockedTarget || tg.stallT > 20);
        // 力：持ち場に付いてから、じわっと出す
        // 自動の離着岸（50-harbor-auto.js）のときは、強さを細かく決めてもらう
        const pw = tg.autoPower !== undefined ? tg.autoPower : TUG_POWERS[tg.power];
        const want = (tg.state === 'on' && tg.action !== 'standby') ? pw * escort : 0;
        tg.force += (want - tg.force) * Math.min(1, dt / 2);
        let dirF = null, P = null;
        if (tg.action === 'pull' && hook) { dirF = tg.pullDir; P = hook; }
        else if (pushing) { dirF = tg.pushDir; P = new THREE.Vector3(tx - tg.pushDir.x * (TUG_LEN / 2), 0, tz - tg.pushDir.z * (TUG_LEN / 2)); }
        if (dirF && P && tg.force > 0.001 && !(typeof isDesignMode !== 'undefined' && isDesignMode)) {
            const f = tg.force * _tugPullN();
            const fxW = dirF.x * f, fzW = dirF.z * f;
            const fs = fxW * F.sx + fzW * F.sz, ff = fxW * F.fx + fzW * F.fz;
            const lever = (P.x - sp.x) * F.fx + (P.z - sp.z) * F.fz;
            Fs += fs; Ff += ff; Mz += fs * lever;
        }
        if (last) _tugVisual(tg, t, hook, dist);
    }
    // サイドスラスター・アジポッドの横の力（58-maneuvering.js）
    if (typeof shipExtraForces === 'function') { const X = shipExtraForces(C); if (X) { Fs += X.Fs; Ff += X.Ff; Mz += X.Mz; } }
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
    // 岸壁・陸に船腹が当たっていたら、そちらへは動かない（防舷材に当たって止まる）
    if (window.world && world.mode === 'world' && typeof worldSeabedAt === 'function') {
        const dr = (typeof worldShipDraft === 'function') ? worldShipDraft() : 5;
        const hit = (along, sideSign, move) => {
            const hw = _tugHalfWidth(along / sc) * sc;
            const q = _tugFromShip(C, along, sideSign * (hw + 1 + Math.abs(move)));
            // 座礁から抜け出す間（49-autopilot.js）は、岸壁・陸だけで止める（浅い所は座礁の判定が深く入る動きを止める）
            if (typeof autopilot !== 'undefined' && autopilot.aground) return worldSeabedAt(q.x, q.z) > -1;
            return worldSeabedAt(q.x, q.z) > -dr;
        };
        const vS2 = _tugShip.vSway;
        if (Math.abs(vS2) > 1e-4) {
            const sg = Math.sign(vS2);
            for (const k of [-0.85, -0.45, 0, 0.45, 0.85]) if (hit(k * C.HL, sg, vS2 * dt)) { _tugShip.vSway = 0; break; }
        }
        const r2 = _tugShip.yawRate;
        if (Math.abs(r2) > 1e-6) {
            // 回頭で船首は +x（左舷）側へ r>0 のとき動く、船尾は逆
            for (const [k, sg] of [[0.85, Math.sign(r2)], [-0.85, -Math.sign(r2)]]) if (hit(k * C.HL, sg, r2 * 0.85 * C.HL * dt)) { _tugShip.yawRate = 0; break; }
        }
    }
    // 横流れ（ワールドで動かす）と回頭（heading を足す）
    physics.cgWorldX += F.sx * _tugShip.vSway * dt;
    physics.cgWorldZ += F.sz * _tugShip.vSway * dt;
    physics.heading += _tugShip.yawRate * 180 / Math.PI * dt;
    // 前後の力：ノットの速さへ
    physics.speed += (Ff / massKg) / 0.514 * dt;
}
// ── 座礁したタグと、代わりのタグ ──
function _tugCheckAground(tg, stuckIn, dt) {
    if (!tg.mv || Math.hypot(tg.pos.x - tg.mv.x, tg.pos.z - tg.mv.z) > 10) { tg.mv = { x: tg.pos.x, z: tg.pos.z, t: 0 }; return false; }
    tg.mv.t += dt;
    if (stuckIn && tg.mv.t > 20) return true;                                                   // 浅い所で 20 秒動けない
    return tg.state === 'coming' && !tg.blockedTarget && tg.mv.t > 60 && (tg.stallT || 0) > 60;   // 向かう途中で 1 分動けない
}
function _tugReplace(tg) {
    const job = { station: tg.station, action: tg.action, dir: tg.dir, power: tg.power, autoPower: tg.autoPower, awaySide: tg.awaySide };
    tg.aground = true; tg.state = 'leaving'; tg.action = 'standby'; tg.engaged = false; tg.lineOn = null; tg.force = 0; tg.agT = 0;
    if (tg.line) tg.line.visible = false;
    // 同じ持ち場・同じ仕事で、新しいタグを呼ぶ（続けて座礁する所なら、5 分に 2 隻まで）
    const now = performance.now();
    _tugReplace.log = (_tugReplace.log || []).filter(q => now - q.t < 300000);
    if (_tugReplace.log.filter(q => q.st === job.station).length >= 2) return null;
    _tugReplace.log.push({ st: job.station, t: now });
    const n = tugCall(job.station);
    if (!n) return null;
    n.action = job.action; n.dir = job.dir; n.power = job.power;
    if (job.autoPower !== undefined) n.autoPower = job.autoPower;
    if (job.awaySide) n.awaySide = job.awaySide;
    // 自動の離着岸・付き添い（50-harbor-auto.js）が覚えているタグの番号を付け替える
    const swap = (arr) => { if (Array.isArray(arr)) { const k = arr.indexOf(tg.id); if (k >= 0) arr[k] = n.id; } };
    if (typeof harborAuto !== 'undefined') swap(harborAuto.tugIds);
    if (typeof tugEscort !== 'undefined') { swap(tugEscort.ids); if (tugEscort.held) swap(tugEscort.held.ids); }
    tg.replacedBy = n.id;
    return n;
}
window.tugReplaceAground = _tugReplace;
// 見た目（波に乗る・引き索）
function _tugVisual(tg, t, hook, dist) {
    const oh = (typeof getOceanHeight === 'function') ? getOceanHeight(tg.pos.x, tg.pos.z, t) : 0;
    const fwdX = Math.sin(tg.yaw), fwdZ = Math.cos(tg.yaw);
    const H = (x, z) => (typeof getOceanHeight === 'function') ? getOceanHeight(x, z, t) : 0;
    const pitch = Math.atan2(H(tg.pos.x + fwdX * 10, tg.pos.z + fwdZ * 10) - H(tg.pos.x - fwdX * 10, tg.pos.z - fwdZ * 10), 20);
    const roll = Math.atan2(H(tg.pos.x + fwdZ * 4, tg.pos.z - fwdX * 4) - H(tg.pos.x - fwdZ * 4, tg.pos.z + fwdX * 4), 8);
    tg.g.position.set(tg.pos.x, oh, tg.pos.z);
    tg.g.rotation.set(-pitch * 0.8, tg.yaw, roll * 0.8, 'YXZ');
    tg.g.updateMatrixWorld();
    _tugLights(tg);
    _tugSmoke(tg, t);
    // 引き索：金物からタグの船尾のフックへ（張っているほどまっすぐ）
    const slack = !(tg.action === 'pull' && hook);
    if (slack && tg.lineOn && tg.lineHook && tg.state !== 'leaving') hook = tg.lineHook;
    if (hook && tg.state !== 'leaving') {
        // 押しているときは船首の索（船首のウインチ）、それ以外は船尾のフックから
        const hz = slack && tg.action === 'push' ? TUG_LEN / 2 - 1.5 : tg.g.userData.hookZ;
        const ex = tg.pos.x + fwdX * hz, ez = tg.pos.z + fwdZ * hz, ey = oh + 2.6;
        const A = tg.line.geometry.attributes.position.array, n = 16;
        const span = Math.hypot(ex - hook.x, ez - hook.z);
        const sag = slack ? Math.min(12, 2 + span * 0.25) : span * (0.12 - 0.1 * Math.min(1, tg.force / 0.3));
        // 1点目は金物、2点目は舷の縁、そこからタグまで垂れた線
        const E = tg.lineEdge || hook;
        A[0] = hook.x; A[1] = hook.y; A[2] = hook.z;
        for (let q = 1; q < n; q++) {
            const u = (q - 1) / (n - 2);
            A[q * 3] = E.x + (ex - E.x) * u;
            A[q * 3 + 1] = E.y + (ey - E.y) * u - sag * 4 * u * (1 - u);
            A[q * 3 + 2] = E.z + (ez - E.z) * u;
        }
        tg.line.geometry.attributes.position.needsUpdate = true;
        tg.line.visible = slack ? span < 80 : dist < 30;
    } else tg.line.visible = false;
}
window.updateTugs = updateTugs;

// ── 画面のボタンとパネル ──
function _tugSetup() {
    const sig = document.getElementById('btn-horn-sig') || document.getElementById('btn-horn');
    if (!sig || document.getElementById('btn-tug')) return;
    const P = hudPopup({ id: 'btn-tug', panelId: 'tug-panel', label: 'タグ', title: 'タグボート', after: sig, render: renderTugPanel });
    _tugSetup.place = P.place;
}
function renderTugPanel() {
    const panel = document.getElementById('tug-panel');
    if (!panel) return;
    const st = (typeof shipGroup !== 'undefined' && shipGroup) ? tugStations() : [];
    const stateLabel = (t) => t.aground ? (t.replacedBy ? '座礁（代わりのタグを呼びました）' : '座礁') : t.state === 'coming' ? (t.blockedTarget ? '近づけません（岸・浅瀬）' : t.stuck ? '入れません（すき間が狭い）' : '向かっています') : t.state === 'leaving' ? '帰ります' : (t.action === 'standby' ? '待機中' : t.action === 'push' ? '押しています' : '引いています');
    const active = tugs.filter(t => t.state !== 'leaving');
    uiSetHTML(panel, `<div class="tg-head"><span class="tg-title">タグボート</span>
        <button class="tg-call" onclick="tugCall()" ${active.length >= TUG_MAX ? 'disabled' : ''}>＋ 呼ぶ</button>
        ${active.length ? '<button onclick="tugReleaseAll()">全部帰す</button>' : ''}</div>` +
        (window.world && world.mode === 'world' && typeof harborAuto !== 'undefined' ? `<div class="tg-row tg-auto">
            ${harborAuto.mode ? `<button onclick="harborAutoStop('自動の離着岸を止めました')">■ 自動の離着岸を止める</button>`
                : `<button onclick="harborAutoBerthNow()">🤖 自動着岸</button><button onclick="harborAutoDepartNow()">🤖 自動離岸</button>`}
            ${!harborAuto.mode ? `<div class="tg-row tg-side">接舷：${[['auto', '自動'], ['port', '左舷'], ['starboard', '右舷']].map(([k, l]) => `<button class="${(harborAuto.sidePref || 'auto') === k ? 'on' : ''}" onclick="harborSetSidePref('${k}')">${l}</button>`).join('')}</div>` : ''}
            ${!harborAuto.mode && typeof tugEscort !== 'undefined' ? (tugEscort.manual
                ? `<button onclick="tugEscortManual(false)">付き添いをやめる</button>`
                : `<button onclick="tugEscortManual(true)" title="狭い水路などで、タグに両舷を付き添ってもらう（自動航行中は付き添われて微速で進む）">🛟 付き添いを頼む</button>`) : ''}
            ${!harborAuto.mode && typeof apTugOptHTML === 'function' ? apTugOptHTML() : ''}
            ${harborAuto.msg ? `<div class="tg-automsg">${harborAuto.msg}</div>` : ''}</div>` : '') +
        (tugs.length ? tugs.map(t => `
        <div class="tg-item${t.state === 'leaving' ? ' leaving' : ''}">
            <div class="tg-row"><b>タグ${t.id}</b><span class="tg-state">${stateLabel(t)}</span>
                ${t.state !== 'leaving' ? `<button class="tg-rel" onclick="tugSet(${t.id}, 'release')">帰す</button>` : ''}</div>
            ${t.state !== 'leaving' ? `
            <div class="tg-row"><select onchange="tugSet(${t.id}, 'station', this.value)">${st.map(s => `<option value="${s.key}"${s.key === t.station ? ' selected' : ''}>${s.label}</option>`).join('')}</select></div>
            <div class="tg-row">${Object.entries(TUG_ACTIONS).map(([k, l]) => { const no = k === 'pull' && !tugPullHook(st.find(s => s.key === t.station), st); return `<button class="${t.action === k ? 'on' : ''}" ${no ? 'disabled title="この近くに索を取れる金物（クリート・索をかけてよいビット）がありません"' : ''} onclick="tugSet(${t.id}, 'action', '${k}')">${l}</button>`; }).join('')}</div>
            <div class="tg-row">${Object.entries({ low: '微', half: '半', full: '全' }).map(([k, l]) => `<button class="pw${t.power === k ? ' on' : ''}" onclick="tugSet(${t.id}, 'power', '${k}')">${l}</button>`).join('')}
                <span class="tg-sep"></span>${t.action === 'pull' ? Object.entries(TUG_DIRS).map(([k, l]) => `<button class="dir${t.dir === k ? ' on' : ''}" onclick="tugSet(${t.id}, 'dir', '${k}')">${l}</button>`).join('') : ''}</div>
            ${t.action === 'pull' ? `<div class="tg-row">索 ${Object.entries(TUG_LINES).map(([k, v]) => `<button class="pw${(t.lineLen || 'long') === k ? ' on' : ''}" onclick="tugSet(${t.id}, 'lineLen', '${k}')" title="引き索の長さ（狭い所では短く）">${v.label}</button>`).join('')}${t.lineAuto ? '<small>（狭いので縮めています）</small>' : ''}</div>` : ''}` : ''}
        </div>`).join('') : '<div class="tg-empty">「＋ 呼ぶ」でタグボートが来ます。持ち場（係船設備の金物・舷側）を選んで、押す・引くを指示します。<br>速さが5ノットを超えると力が弱まり、8ノットでは効きません。</div>'));
    if (panel.classList.contains('open') && _tugSetup.place) _tugSetup.place();
}
window.renderTugPanel = renderTugPanel;
document.addEventListener('DOMContentLoaded', () => { setTimeout(_tugSetup, 0); });
// 状態の表示（向かっています→待機中 など）を時々更新
setInterval(() => { const p = document.getElementById('tug-panel'); if (p && p.classList.contains('open') && tugs.length) {
    // 押しているボタンの上で書き換えないように、ボタンに触っていないときだけ
    if (!p.matches(':active')) p.querySelectorAll('.tg-state').forEach((el, i) => { const t = tugs[i]; if (t) el.textContent = t.state === 'coming' ? '向かっています' : t.state === 'leaving' ? '帰ります' : (t.action === 'standby' ? '待機中' : t.action === 'push' ? '押しています' : '引いています'); });
} }, 1000);
