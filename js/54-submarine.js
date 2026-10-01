// ============================================================
//  潜水艦：潜航・浮上（バラスト）・潜望鏡・水中操船・ソナー・魚雷
// ============================================================
//  船体設定の「🌊 潜水艦」で種類を潜水艦にすると使える。
//  ・深さ sub.depth[m]：喫水線の基準点が、静かな海面からどれだけ下にあるか（0＝水上）。
//    浮力・波の計算（17-main-loop.js）は水上の船としてそのまま行い、その結果から深さの分だけ下げて描く
//   （subPreStep で戻し、subPostStep で引く）。深いほど波の上下・揺れが届かなくなる。
//  ・バラスト：0＝空（浮く）、1＝満水（釣り合い。深さは潜舵で保つ）、負＝メインタンクブロー（緊急浮上）。
//  ・潜望鏡：設定した位置（模型の座標）から上へ伸ばす。覗くとその頭からの眺め（倍率・照準線付き）。
//  ・ソナー：パッシブ（タグ・魚雷の方位）とアクティブ（ピン：海底・岸の反響）。測深儀で船底から海底まで。
//  ・魚雷：艦首から（潜望鏡を覗いていればその向きへ）。岸・海底・タグに当たるか、射程の終わりで爆発。
const SUB_DEF = { type: 'surface', maxDepth: 300, scope: null, scopeLen: 8, tubes: 6, torpSpeed: 45, torpRange: 9 };
const subCfg = Object.assign({}, SUB_DEF);
const sub = {
    depth: 0, vDepth: 0, cmd: 0, ballast: 0, mode: 'surface', pitch: 0, applied: 0, k: 1, under: false,
    scopeRaise: 0, scopeUp: false, view: false, zoom: 1.5, baseFov: null,
    sonar: { echoes: [], pingT: -1e9, ping: null, lastDraw: 0 },
    torps: [], loaded: 6, reload: [], msg: '', msgT: 0, mast: null, marker: null, topCache: null,
};
window.subCfg = subCfg; window.sub = sub;
const SUB_RELOAD = 90;            // 魚雷の次発装填[秒]
const SUB_SONAR_RANGE = 3000;     // ソナーの表示範囲[m]

function isSubmarine() { return subCfg.type === 'submarine'; }
window.isSubmarine = isSubmarine;

function _subMsg(s) { sub.msg = s; sub.msgT = 8; }

// ── 設定の保存・読み込み（13-save-load-config.js） ──
function getSubmarineConfig() { return JSON.parse(JSON.stringify(subCfg)); }
function applySubmarineConfig(c) {
    Object.assign(subCfg, SUB_DEF, c || {});
    subSurfaceNow(true);
    sub.loaded = subCfg.tubes; sub.reload = [];
    sub.topCache = null;
    _subUpdateHudButton();
    if (document.getElementById('tab-submarine')) renderSubSettings();
}
window.getSubmarineConfig = getSubmarineConfig;
window.applySubmarineConfig = applySubmarineConfig;

// すぐ水上に戻す（種類を変えたとき・読み込んだとき）
function subSurfaceNow(silent) {
    sub.depth = 0; sub.vDepth = 0; sub.cmd = 0; sub.ballast = 0; sub.mode = 'surface'; sub.pitch = 0;
    sub.scopeUp = false; sub.scopeRaise = 0; sub.under = false; sub.k = 1;
    if (sub.view) subScopeView(false);
    if (!silent) _subMsg('浮上しました');
}

// ── 模型のいちばん高い所（潜望鏡の既定の位置）：shipGroup のローカル座標 ──
function _subModelTop() {
    const root = window.importedModelGroup || (typeof importedModelGroup !== 'undefined' ? importedModelGroup : null);
    const key = root ? root.uuid : 'none';
    if (sub.topCache && sub.topCache.key === key) return sub.topCache.p;
    let best = null;
    if (root && typeof shipGroup !== 'undefined' && shipGroup) {
        shipGroup.updateMatrixWorld(true);
        const inv = new THREE.Matrix4().copy(shipGroup.matrixWorld).invert(), m = new THREE.Matrix4(), v = new THREE.Vector3();
        root.traverse(o => {
            if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
            const P = o.geometry.attributes.position, n = P.count, step = Math.max(1, Math.floor(n / 20000));
            m.multiplyMatrices(inv, o.matrixWorld);
            for (let i = 0; i < n; i += step) {
                v.fromBufferAttribute(P, i).applyMatrix4(m);
                if (!best || v.y > best.y) best = { x: v.x, y: v.y, z: v.z };
            }
        });
    }
    if (!best) best = { x: 0, y: 2, z: 0 };
    sub.topCache = { key, p: best };
    return best;
}
function subScopePos() { return subCfg.scope || _subModelTop(); }
// 喫水線の上の、潜望鏡の付け根（＝艦橋の上）の高さ[m]
function _subTopAboveWL() {
    const p = subScopePos(), sc = physics.scale || 1;
    return Math.max(1, (p.y - (physics.waterlineOffsetY || 0)) * sc);
}
// 潜望鏡深度：艦橋の上が水面の 1.5m 下（潜望鏡を上げれば頭が水面から出る）
function subPeriscopeDepth() { return _subTopAboveWL() + 1.5; }
// 海底の深さ（船の真下・世界の航海中だけ。分からなければ null）
function _subBottom() {
    if (!(window.world && world.mode === 'world') || !window.terrain || !Number.isFinite(terrain.depth)) return null;
    return terrain.depth;
}
function _subDraft() { return (typeof worldShipDraft === 'function') ? worldShipDraft() : 5; }

// ── 指示 ──
function subDive(depth) {
    if (!isSubmarine()) return;
    if (window.harborAuto && harborAuto.mode) { _subMsg('自動の離着岸の最中は潜航できません'); return; }
    sub.mode = 'dive';
    sub.cmd = Math.max(0, Math.min(subCfg.maxDepth, depth != null ? depth : Math.max(sub.cmd, subPeriscopeDepth() + 20)));
    _subMsg(`ベント開け。深さ ${Math.round(sub.cmd)}m へ潜航します`);
    if (typeof audioBurst === 'function' && window.shipAudio && shipAudio.ctx && shipAudio.buses && shipAudio.buses.env) {
        audioBurst(shipAudio.buses.env, { dur: 3.5, attack: 0.3, gain: 0.35, type: 'bandpass', freq: 600, q: 0.6 });   // ベントから空気が抜ける音
    }
    renderSubPanel();
}
function subSetDepth(d) { if (!isSubmarine()) return; if (sub.mode !== 'dive') return subDive(d); sub.cmd = Math.max(0, Math.min(subCfg.maxDepth, d)); renderSubPanel(); }
function subDepthStep(dd) { subSetDepth((sub.mode === 'dive' ? sub.cmd : sub.depth) + dd); }
function subPeriscope() { subDive(subPeriscopeDepth()); _subMsg(`潜望鏡深度（${subPeriscopeDepth().toFixed(0)}m）へ`); }
function subSurface() {
    if (!isSubmarine()) return;
    sub.mode = 'surface'; sub.cmd = 0;
    _subMsg('メインタンクブロー（ゆっくり）。浮上します');
    renderSubPanel();
}
function subEmergency() {
    if (!isSubmarine()) return;
    sub.mode = 'blow'; sub.cmd = 0;
    _subMsg('緊急浮上！ メインタンク全ブロー');
    if (typeof audioBurst === 'function' && window.shipAudio && shipAudio.ctx && shipAudio.buses && shipAudio.buses.env) {
        audioBurst(shipAudio.buses.env, { dur: 6, attack: 0.05, gain: 0.7, type: 'bandpass', freq: 900, q: 0.4 });
        audioBurst(shipAudio.buses.env, { dur: 5, attack: 0.1, gain: 0.5, type: 'lowpass', freq: 160, q: 0.7, kind: 'brown' });
    }
    renderSubPanel();
}
function subScopeToggle() {
    if (!isSubmarine()) return;
    sub.scopeUp = !sub.scopeUp;
    if (!sub.scopeUp && sub.view) subScopeView(false);
    renderSubPanel();
}
window.subDive = subDive; window.subSetDepth = subSetDepth; window.subDepthStep = subDepthStep; window.subPeriscope = subPeriscope;
window.subSurface = subSurface; window.subEmergency = subEmergency; window.subScopeToggle = subScopeToggle;

// ════════════════════════════════════════════════════════════
//  17-main-loop.js から：物理の前後
// ════════════════════════════════════════════════════════════
function subPreStep() {
    if (sub.applied) { physics.y += sub.applied; sub.applied = 0; }
}
function subPostStep(t, dt, design) {
    dt = Math.min(1, Math.max(0, dt || 0));
    if (!isSubmarine() || design) {
        if (sub.depth || sub.mode !== 'surface') subSurfaceNow(true);
        sub.applied = 0; sub.under = false; sub.k = 1;
        _subUpdateMast(dt, design);
        return;
    }
    // バラスト
    const tgt = sub.mode === 'dive' ? 1 : sub.mode === 'blow' ? -0.3 : 0;
    const rate = sub.mode === 'dive' ? 1 / 20 : sub.mode === 'blow' ? 1 / 5 : 1 / 45;
    sub.ballast += Math.sign(tgt - sub.ballast) * Math.min(Math.abs(tgt - sub.ballast), rate * dt);
    // 上下：正の浮力（バラストが満水でない分）で浮き、満水に近ければ潜舵で指示の深さへ
    const spdM = Math.abs(physics.speed || 0) * 0.514;
    const buoy = Math.max(0, 1 - sub.ballast) * 0.25;                 // 上向き[m/s²]
    let ctl = 0;
    const bottom = _subBottom(), draft = _subDraft();
    let cmd = sub.cmd;
    if (bottom != null) cmd = Math.min(cmd, Math.max(0, bottom - draft - 5));   // 海底から 5m は離す
    if (sub.mode === 'dive' && sub.ballast > 0.9) {
        const vmax = 0.5 + spdM * 0.08;                                // 前へ進んでいれば潜舵がよく効く
        const want = THREE.MathUtils.clamp((cmd - sub.depth) * 0.05, -vmax, vmax);
        ctl = (want - sub.vDepth) * 0.25;
    }
    sub.vDepth += (ctl - buoy - sub.vDepth * 0.06) * dt;
    sub.depth += sub.vDepth * dt;
    if (sub.depth <= 0) {
        // 水面へ出た：勢いよく出たら（緊急浮上）艦首が跳ね上がる
        if (sub.vDepth < -1.5) {
            physics.vy = Math.min(4, physics.vy + Math.min(4, -sub.vDepth * 0.5));
            physics.vPitch -= Math.min(0.25, -sub.vDepth * 0.03);
            _subSplash(Math.min(1, -sub.vDepth / 6));
        }
        sub.depth = 0; sub.vDepth = Math.max(0, sub.vDepth);
        if (sub.mode === 'blow') { sub.mode = 'surface'; _subMsg('浮上しました（緊急浮上）'); renderSubPanel(); }
        else if (sub.mode === 'surface' && sub.ballast < 0.05 && sub._wasUnder) { _subMsg('浮上しました'); sub._wasUnder = false; renderSubPanel(); }
    }
    // 着底
    if (bottom != null && sub.depth + draft > bottom - 0.3) {
        sub.depth = Math.max(0, bottom - 0.3 - draft); sub.vDepth = Math.min(0, sub.vDepth);
        if (!sub._bottomed) { _subMsg('着底しました（海底が浅い）'); sub._bottomed = true; }
    } else sub._bottomed = false;
    if (sub.depth > subCfg.maxDepth) {
        sub.depth = Math.min(sub.depth, subCfg.maxDepth * 1.1);
        if (sub.vDepth > 0) sub.vDepth *= 0.9;
        if (!sub._deepWarn) { _subMsg(`安全潜航深度（${subCfg.maxDepth}m）を超えています！ 船体がきしんでいます`); sub._deepWarn = true; }
    } else sub._deepWarn = false;
    if (sub.depth > 3) sub._wasUnder = true;
    // 縦の傾き：潜っていくときは艦首を下げ、浮くときは上げる（＋＝艦首下げ）
    const pT = sub.depth < 0.5 && sub.vDepth <= 0 ? 0 : THREE.MathUtils.clamp(sub.vDepth / Math.max(1.5, spdM) * 0.5, -0.3, 0.3);
    sub.pitch += (pT - sub.pitch) * Math.min(1, dt / 4);
    // 波の届き方（深いほど小さい）と、描く高さの引き分
    sub.k = Math.exp(-sub.depth / 15);
    const wave = Number.isFinite(window._physicsWaveY) ? window._physicsWaveY : 0;
    sub.applied = sub.depth + wave * (1 - sub.k);
    physics.y -= sub.applied;
    // 船体がすっかり水の下か（水面の切り抜き・航跡・しぶきを止める）
    sub.under = sub.depth > _subHullTopAboveWL() + 0.3;
    _subUpdateMast(dt, false);
    if (sub.msgT > 0) sub.msgT -= dt / Math.max(1, (typeof physicsSpeed !== 'undefined' ? physicsSpeed : 1));
}
window.subPreStep = subPreStep; window.subPostStep = subPostStep;
// 描く姿勢：波の揺れを深さで弱め、潜航・浮上の傾きを足す。水上で何もしていなければ null
function subAttitude() {
    if (!isSubmarine() || (sub.depth < 0.01 && Math.abs(sub.pitch) < 1e-4)) return null;
    return { k: sub.k, pitch: sub.pitch };
}
window.subAttitude = subAttitude;
// 船体（甲板の高さまで）の喫水線からの高さ[m]（22-hull-shape.js の輪郭のいちばん上）
function _subHullTopAboveWL() {
    const hp = window.hullProfile, sh = hp && hp.shape;
    const sc = physics.scale || 1;
    if (sh && sh.ready && sh.levelY) return Math.max(0.5, (sh.levelY[sh.levelY.length - 1] - (physics.waterlineOffsetY || 0)) * sc);
    return 3;
}
// 水面の切り抜き（04-scene-and-water-init.js）を止めるか：船体の一番上まで水の下
function subHullUnder() { return isSubmarine() && sub.depth > _subHullTopAboveWL() - 0.1; }
window.subHullUnder = subHullUnder;
// 航跡・しぶき・排煙など、水面の上の演出を止めるか
function subSurfaceFxOff() { return isSubmarine() && sub.under; }
window.subSurfaceFxOff = subSurfaceFxOff;

// ── 潜望鏡の柱（模型の座標に置く。上げ下げ） ──
function _subUpdateMast(dt, design) {
    if (typeof shipGroup === 'undefined' || !shipGroup) return;
    const on = isSubmarine();
    if (!sub.mast && on) {
        const g = new THREE.Group();
        const mat = new THREE.MeshStandardMaterial({ color: 0x2a2d30, roughness: 0.6, metalness: 0.4 });
        const tube = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 12), mat);
        tube.position.y = 0.5;
        const head = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
        g.add(tube); g.add(head);
        g.userData = { tube, head };
        sub.mast = g;
        sub.marker = new THREE.Object3D();
        shipGroup.add(g); shipGroup.add(sub.marker);
    }
    if (!sub.mast) return;
    const tgt = design ? 1 : (on && sub.scopeUp ? 1 : 0);
    sub.scopeRaise += Math.sign(tgt - sub.scopeRaise) * Math.min(Math.abs(tgt - sub.scopeRaise), dt / 6);   // 6 秒で上がる
    const sc = physics.scale || 1, p = subScopePos(), len = Math.max(2, subCfg.scopeLen) / sc, r = 0.22 / sc;
    const up = len * sub.scopeRaise;
    sub.mast.visible = on && sub.scopeRaise > 0.01;
    sub.mast.position.set(p.x, p.y + up - len, p.z);
    const { tube, head } = sub.mast.userData;
    tube.scale.set(r, len, r);
    head.scale.set(r * 2.2, r * 3.2, r * 3.4); head.position.set(0, len + r * 1.2, r * 0.6);
    sub.marker.position.set(p.x, p.y + up + r * 1.4, p.z + r * 2.4);
}

// ════════════════════════════════════════════════════════════
//  潜望鏡を覗く
// ════════════════════════════════════════════════════════════
function subScopeView(on) {
    if (on && !isSubmarine()) return;
    if (on && !sub.scopeUp) { _subMsg('先に潜望鏡を上げてください'); renderSubPanel(); return; }
    sub.view = !!on;
    if (on) {
        if (sub.baseFov == null) sub.baseFov = camera.fov;
        selectViewpoint('periscope');
        _subApplyZoom();
    } else {
        if (sub.baseFov != null) { camera.fov = sub.baseFov; camera.updateProjectionMatrix(); sub.baseFov = null; }
        if (typeof viewpointActiveKey !== 'undefined' && viewpointActiveKey === 'periscope') selectViewpoint(null);
    }
    _subOverlay();
    renderSubPanel();
}
function subZoom(z) { sub.zoom = z; _subApplyZoom(); renderSubPanel(); }
function _subApplyZoom() {
    if (!sub.view || sub.baseFov == null) return;
    camera.fov = Math.max(4, sub.baseFov / sub.zoom); camera.updateProjectionMatrix();
}
window.subScopeView = subScopeView; window.subZoom = subZoom;
// 20-viewpoint-camera.js の見張り台と同じ仕組みで、潜望鏡の頭をカメラにする
(function () {
    const orig = window.getActiveViewpointMarker;
    if (typeof orig !== 'function') return;
    window.getActiveViewpointMarker = function () {
        if (typeof viewpointActiveKey !== 'undefined' && viewpointActiveKey === 'periscope') return sub.marker || null;
        return orig();
    };
})();
// 照準線と方位の重ね表示
function _subOverlay() {
    let el = document.getElementById('sub-scope');
    if (!el) {
        el = document.createElement('div'); el.id = 'sub-scope';
        el.innerHTML = '<div class="ss-ring"></div><div class="ss-h"></div><div class="ss-v"></div><div class="ss-info"></div>';
        document.body.appendChild(el);
    }
    el.classList.toggle('on', !!sub.view);
}
function _subScopeBearing() {
    const yawDeg = (typeof viewpointYaw !== 'undefined' ? viewpointYaw : 0) * 180 / Math.PI;
    const c = (typeof worldTrueCompass === 'function' ? worldTrueCompass() : worldCompass(physics.heading)) - yawDeg;
    return ((c % 360) + 360) % 360;
}
function _subUpdateOverlay() {
    const el = document.getElementById('sub-scope');
    if (!el || !sub.view) return;
    // ほかの視点へ切り替えたら、覗くのをやめる
    if (typeof viewpointActiveKey === 'undefined' || viewpointActiveKey !== 'periscope' || !sub.scopeUp || !isSubmarine()) { subScopeView(false); return; }
    const info = el.querySelector('.ss-info');
    const wave = Number.isFinite(window._physicsWaveY) ? window._physicsWaveY : 0;
    let wet = false;
    if (sub.marker) { const v = new THREE.Vector3(); sub.marker.getWorldPosition(v); wet = v.y < wave + 0.1; }
    info.textContent = `方位 ${_subScopeBearing().toFixed(0).padStart(3, '0')}°　×${sub.zoom}　深さ ${sub.depth.toFixed(1)}m${wet ? '　（潜望鏡の頭が水の中）' : ''}`;
}

// ════════════════════════════════════════════════════════════
//  ソナー
// ════════════════════════════════════════════════════════════
function _subWorldBearing(dx, dz) {
    // ローカル：+x＝西、+z＝北 → 船首からの相対角（右回り＋）
    const h = (physics.heading || 0) * Math.PI / 180;
    const fwdX = Math.sin(h), fwdZ = Math.cos(h);
    const a = Math.atan2(dx * fwdZ - dz * fwdX, dx * fwdX + dz * fwdZ);   // 左回り＋
    return -a;
}
function subPing() {
    if (!isSubmarine()) return;
    const S = sub.sonar, now = performance.now() / 1000;
    if (now - S.pingT < 4) return;
    S.pingT = now;
    const x0 = physics.cgWorldX || 0, z0 = physics.cgWorldZ || 0;
    const lvl = -(sub.depth + _subDraft() * 0.5);
    const echoes = [];
    if (window.world && world.mode === 'world' && typeof worldSeabedAt === 'function') {
        for (let a = 0; a < 360; a += 4) {
            const r = a * Math.PI / 180, dx = Math.sin(r), dz = Math.cos(r);
            for (let d = 40; d <= SUB_SONAR_RANGE; d += d < 600 ? 20 : 40) {
                if (worldSeabedAt(x0 + dx * d, z0 + dz * d) > lvl) { echoes.push({ b: _subWorldBearing(dx, dz), d, kind: 'land' }); break; }
            }
        }
    }
    for (const tg of (window.tugs || [])) {
        const dx = tg.pos.x - x0, dz = tg.pos.z - z0, d = Math.hypot(dx, dz);
        if (d < SUB_SONAR_RANGE) echoes.push({ b: _subWorldBearing(dx, dz), d, kind: 'ship' });
    }
    for (const e of echoes) e.at = now + 2 * e.d / 1500;     // 音が行って帰ってくるまで
    S.echoes = echoes; S.ping = now;
    _subPingSound(echoes);
}
window.subPing = subPing;
function _subPingSound(echoes) {
    const A = window.shipAudio;
    if (!A || !A.ctx || A.ctx.state !== 'running') return;
    const c = A.ctx, dest = (A.buses && (A.buses.bridge || A.buses.env)) || A.master;
    const beep = (when, gain, f) => {
        const o = c.createOscillator(), g = c.createGain();
        o.type = 'sine'; o.frequency.value = f;
        const t0 = c.currentTime + when;
        g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(gain, t0 + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0005, t0 + 1.4);
        o.connect(g); g.connect(dest); o.start(t0); o.stop(t0 + 1.5);
    };
    beep(0, 0.35, 3400);
    const near = echoes.reduce((m, e) => Math.min(m, e.d), Infinity);
    if (near < Infinity) beep(2 * near / 1500, Math.max(0.03, 0.18 * (1 - near / SUB_SONAR_RANGE)), 3380);
}
function _subDrawSonar() {
    const cv = document.getElementById('sub-sonar');
    if (!cv || !cv.offsetParent) return;
    const now = performance.now() / 1000, S = sub.sonar;
    if (now - S.lastDraw < 0.07) return;
    S.lastDraw = now;
    const ctx = cv.getContext('2d'), W = cv.width, R = W / 2 - 4, C = W / 2;
    ctx.fillStyle = '#021a12'; ctx.fillRect(0, 0, W, W);
    ctx.strokeStyle = 'rgba(80,255,170,0.25)'; ctx.lineWidth = 1;
    for (let i = 1; i <= 3; i++) { ctx.beginPath(); ctx.arc(C, C, R * i / 3, 0, Math.PI * 2); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(C, C - R); ctx.lineTo(C, C + R); ctx.moveTo(C - R, C); ctx.lineTo(C + R, C); ctx.stroke();
    const P = (b, d) => [C + Math.sin(b) * R * d / SUB_SONAR_RANGE, C - Math.cos(b) * R * d / SUB_SONAR_RANGE];
    // パッシブ：音を出しているもの（タグの機関・魚雷）の方位を線で
    const x0 = physics.cgWorldX || 0, z0 = physics.cgWorldZ || 0;
    const passive = [];
    for (const tg of (window.tugs || [])) passive.push({ dx: tg.pos.x - x0, dz: tg.pos.z - z0, col: '255,210,120' });
    for (const T of sub.torps) passive.push({ dx: T.x - x0, dz: T.z - z0, col: '255,110,110' });
    for (const q of passive) {
        const d = Math.hypot(q.dx, q.dz), b = _subWorldBearing(q.dx, q.dz), s = Math.max(0.25, 1 - d / 8000);
        ctx.strokeStyle = `rgba(${q.col},${0.25 + 0.6 * s})`; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(C + Math.sin(b) * R * 0.86, C - Math.cos(b) * R * 0.86); ctx.lineTo(C + Math.sin(b) * R, C - Math.cos(b) * R); ctx.stroke();
    }
    // アクティブ：ピンの輪と反響
    if (S.ping != null) {
        const r = (now - S.ping) * 1500 / 2;
        if (r < SUB_SONAR_RANGE) { ctx.strokeStyle = 'rgba(120,255,190,0.5)'; ctx.beginPath(); ctx.arc(C, C, R * r / SUB_SONAR_RANGE, 0, Math.PI * 2); ctx.stroke(); }
        for (const e of S.echoes) {
            if (now < e.at) continue;
            const f = Math.max(0, 1 - (now - e.at) / 12);
            if (f <= 0) continue;
            const [px, py] = P(e.b, e.d);
            ctx.fillStyle = e.kind === 'ship' ? `rgba(255,220,120,${f})` : `rgba(90,255,160,${f * 0.9})`;
            ctx.fillRect(px - 1.5, py - 1.5, e.kind === 'ship' ? 4 : 3, e.kind === 'ship' ? 4 : 3);
        }
    }
    // 自分（上が艦首）
    ctx.fillStyle = '#9fffd0'; ctx.beginPath(); ctx.moveTo(C, C - 6); ctx.lineTo(C - 3, C + 4); ctx.lineTo(C + 3, C + 4); ctx.fill();
    ctx.fillStyle = 'rgba(160,255,210,0.7)'; ctx.font = '9px sans-serif';
    ctx.fillText(`${SUB_SONAR_RANGE / 1000}km`, W - 26, W - 4);
}

// ════════════════════════════════════════════════════════════
//  魚雷
// ════════════════════════════════════════════════════════════
let _subTorpGeo = null, _subTorpMat = null;
function subFire() {
    if (!isSubmarine()) return;
    if (sub.loaded <= 0) { _subMsg('装填済みの魚雷がありません（装填中）'); renderSubPanel(); return; }
    if (typeof scene === 'undefined' || !shipGroup) return;
    const hp = window.hullProfile, sc = physics.scale || 1;
    const half = ((hp && hp.ready) ? hp.halfLen : 6) * sc;
    const yawDeg = sub.view && typeof viewpointYaw !== 'undefined' ? viewpointYaw * 180 / Math.PI : 0;
    const h = (physics.heading || 0) + yawDeg, r = h * Math.PI / 180;
    const fr = (physics.heading || 0) * Math.PI / 180;
    const x = physics.cgWorldX + Math.sin(fr) * half * 0.9, z = physics.cgWorldZ + Math.cos(fr) * half * 0.9;
    const y = physics.y - _subDraft() * 0.6;
    if (!_subTorpGeo) {
        _subTorpGeo = new THREE.CylinderGeometry(0.27, 0.27, 6.5, 10); _subTorpGeo.rotateX(Math.PI / 2);
        _subTorpMat = new THREE.MeshStandardMaterial({ color: 0x3a3f44, roughness: 0.5, metalness: 0.5 });
    }
    const mesh = new THREE.Mesh(_subTorpGeo, _subTorpMat);
    mesh.position.set(x, y, z); mesh.rotation.y = r;
    scene.add(mesh);
    sub.torps.push({ x, y, z, h, v: 0, vMax: subCfg.torpSpeed * 0.514, dist: 0, run: Math.max(4, Math.min(sub.depth + 2, 15)), mesh, trailT: 0 });
    sub.loaded--; sub.reload.push(SUB_RELOAD);
    const brg = ((typeof worldTrueCompass === 'function' ? worldTrueCompass() : worldCompass(physics.heading)) - yawDeg + 720) % 360;
    _subMsg(`魚雷発射！ 方位 ${brg.toFixed(0).padStart(3, '0')}°`);
    // 「シュッ」という圧搾空気の音
    if (typeof audioBurst === 'function' && window.shipAudio && shipAudio.ctx && shipAudio.buses && shipAudio.buses.env) {
        audioBurst(shipAudio.buses.env, { dur: 0.9, attack: 0.01, gain: 0.6, type: 'lowpass', freq: 380, q: 1, kind: 'brown' });
    }
    renderSubPanel();
}
window.subFire = subFire;
function subTorpShift(shift, dH) {
    for (const T of sub.torps) { T.x += shift.x; T.z += shift.z; T.h += (dH || 0) * 180 / Math.PI; T.mesh.position.add(shift); }
}
window.subTorpShift = subTorpShift;
function _subExplode(T, why) {
    const wave = typeof getWaveHeight === 'function' ? getWaveHeight(T.x, T.z, 0) : 0;
    const deep = Math.max(0, wave - T.y);
    // 水柱（深いほど低く広がる）
    if (typeof puffEmit === 'function') {
        const n = 70, hgt = Math.max(0.3, 1 - deep / 40);
        for (let i = 0; i < n; i++) {
            const a = Math.random() * Math.PI * 2, s = Math.random();
            puffEmit({ x: T.x + Math.cos(a) * s * 6, y: wave + 0.5, z: T.z + Math.sin(a) * s * 6,
                vx: Math.cos(a) * (2 + s * 8), vy: (18 + Math.random() * 30) * hgt, vz: Math.sin(a) * (2 + s * 8),
                r: 0.92, g: 0.95, b: 1, a: 0.75, s0: 4, s1: 18, life: 5 + Math.random() * 3, rise: 0, drag: 0.15, grav: 1 });
        }
        for (let i = 0; i < 24; i++) {
            const a = i / 24 * Math.PI * 2;
            puffEmit({ x: T.x, y: wave + 0.3, z: T.z, vx: Math.cos(a) * 14, vy: 3, vz: Math.sin(a) * 14,
                r: 0.95, g: 0.97, b: 1, a: 0.5, s0: 5, s1: 22, life: 6, rise: 0.4, drag: 0.5 });
        }
    }
    // 「ドーン」：距離に応じて遅れて
    const A = window.shipAudio;
    if (A && A.ctx && A.ctx.state === 'running' && typeof audioBurst === 'function' && A.buses && A.buses.env) {
        const cam = (typeof camera !== 'undefined') ? camera.position : { x: 0, z: 0 };
        const d = Math.hypot(T.x - cam.x, T.z - cam.z), delay = Math.min(6, d / 343), near = Math.max(0.15, 1 - d / 6000);
        audioBurst(A.buses.env, { when: delay, dur: 3.5, attack: 0.02, gain: 1.4 * near, type: 'lowpass', freq: 90, q: 0.8, kind: 'brown' });
        audioBurst(A.buses.env, { when: delay + 0.05, dur: 2.5, attack: 0.05, gain: 0.6 * near, type: 'bandpass', freq: 500, q: 0.5 });
    }
    scene.remove(T.mesh);
    _subMsg(why);
}
function _subUpdateTorps(dt) {
    if (!sub.torps.length && !sub.reload.length) return;
    // 次発装填
    for (let i = sub.reload.length - 1; i >= 0; i--) {
        sub.reload[i] -= dt;
        if (sub.reload[i] <= 0) { sub.reload.splice(i, 1); sub.loaded = Math.min(subCfg.tubes, sub.loaded + 1); renderSubPanel(); }
    }
    const inWorld = window.world && world.mode === 'world' && typeof worldSeabedAt === 'function';
    const range = subCfg.torpRange * 1000;
    for (let i = sub.torps.length - 1; i >= 0; i--) {
        const T = sub.torps[i];
        T.v = Math.min(T.vMax, T.v + 6 * dt);
        const r = T.h * Math.PI / 180, step = T.v * dt;
        T.x += Math.sin(r) * step; T.z += Math.cos(r) * step; T.dist += step;
        const wave = typeof getWaveHeight === 'function' ? getWaveHeight(T.x, T.z, 0) : 0;
        const want = wave - T.run;
        T.y += Math.sign(want - T.y) * Math.min(Math.abs(want - T.y), 1.5 * dt);
        T.mesh.position.set(T.x, T.y, T.z); T.mesh.rotation.y = r;
        // 浅く走っていれば、水面に泡の筋
        T.trailT -= dt;
        if (T.trailT <= 0 && wave - T.y < 14 && typeof puffEmit === 'function') {
            T.trailT = 0.12;
            puffEmit({ x: T.x - Math.sin(r) * 8, y: wave + 0.15, z: T.z - Math.cos(r) * 8, r: 0.9, g: 0.95, b: 1, a: 0.3, s0: 1.2, s1: 5, life: 7, rise: 0, drag: 1 });
        }
        let hit = null;
        if (inWorld && worldSeabedAt(T.x, T.z) > T.y - 0.3) hit = '魚雷が岸（海底）に当たって爆発しました';
        if (!hit && T.dist > 80) for (const tg of (window.tugs || [])) {
            if (Math.hypot(tg.pos.x - T.x, tg.pos.z - T.z) < TUG_LEN * 0.6) { hit = `魚雷がタグ${tg.id}に命中！（演習用の弾頭なので沈みません）`; tg.vel && tg.vel.set((Math.random() - 0.5) * 2, 0, (Math.random() - 0.5) * 2); break; }
        }
        if (!hit && T.dist > range) hit = '魚雷が射程の終わりで爆発しました';
        if (hit) { _subExplode(T, hit); sub.torps.splice(i, 1); renderSubPanel(); }
    }
}
// 緊急浮上で水面へ飛び出したときのしぶき
function _subSplash(s) {
    if (typeof puffEmit !== 'function') return;
    const hp = window.hullProfile, half = ((hp && hp.ready) ? hp.halfLen : 6) * (physics.scale || 1);
    const r = (physics.heading || 0) * Math.PI / 180, fx = Math.sin(r), fz = Math.cos(r);
    const wave = Number.isFinite(window._physicsWaveY) ? window._physicsWaveY : 0;
    for (let i = 0; i < 80 * s; i++) {
        const a = (Math.random() * 2 - 1) * half, side = (Math.random() < 0.5 ? -1 : 1) * (2 + Math.random() * 4);
        puffEmit({ x: physics.cgWorldX + fx * a + fz * side, y: wave + 0.5, z: physics.cgWorldZ + fz * a - fx * side,
            vx: fz * side * 1.5, vy: 6 + Math.random() * 14 * s, vz: -fx * side * 1.5,
            r: 0.93, g: 0.96, b: 1, a: 0.6, s0: 3, s1: 12, life: 3 + Math.random() * 2, rise: 0, drag: 0.2, grav: 1 });
    }
}

// 毎フレーム（17-main-loop.js から）：魚雷・表示
function updateSubmarine(t, dt) {
    const gdt = Math.min(2, Math.max(0, dt || 0)) * (typeof physicsSpeed !== 'undefined' ? physicsSpeed : 1);
    _subUpdateTorps(gdt);
    _subUpdateOverlay();
    _subDrawSonar();
    const p = document.getElementById('sub-panel');
    if (p && p.classList.contains('open')) {
        const now = performance.now();
        if (!sub._statT || now - sub._statT > 400) { sub._statT = now; _subRenderStatus(); }
    }
}
window.updateSubmarine = updateSubmarine;

// ════════════════════════════════════════════════════════════
//  画面：ボタンとパネル
// ════════════════════════════════════════════════════════════
function _subUpdateHudButton() {
    const b = document.getElementById('btn-sub');
    if (b) b.style.display = isSubmarine() ? '' : 'none';
    if (!isSubmarine()) { const p = document.getElementById('sub-panel'); if (p) p.classList.remove('open'); if (b) b.classList.remove('on'); }
}
function _subSetup() {
    const tug = document.getElementById('btn-tug') || document.getElementById('btn-horn-sig');
    if (!tug || document.getElementById('btn-sub')) { if (!tug) setTimeout(_subSetup, 200); return; }
    const b = document.createElement('div');
    b.id = 'btn-sub'; b.className = 'control-btn'; b.title = '潜水艦'; b.textContent = '潜水';
    tug.after(b);
    const panel = document.createElement('div');
    panel.id = 'sub-panel';
    document.body.appendChild(panel);
    const place = () => (typeof placePopupPanel === 'function') && placePopupPanel(panel, b);
    const setOpen = (on) => { panel.classList.toggle('open', on); b.classList.toggle('on', on); if (on) { renderSubPanel(); place(); } };
    b.addEventListener('click', (e) => { e.stopPropagation(); setOpen(!panel.classList.contains('open')); });
    panel.addEventListener('pointerdown', (e) => e.stopPropagation());
    document.addEventListener('pointerdown', (e) => {
        if (!panel.classList.contains('open') || panel.contains(e.target) || b.contains(e.target)) return;
        setOpen(false);
    });
    window.addEventListener('resize', () => { if (panel.classList.contains('open')) place(); });
    _subSetup.place = place;
    if (typeof applyBridgeLayout === 'function') applyBridgeLayout();
    _subUpdateHudButton();
}
function _subStateWord() {
    if (sub.mode === 'blow') return '緊急浮上中';
    if (sub.mode === 'surface') return sub.depth > 0.5 ? '浮上中' : (sub.ballast > 0.05 ? 'ブロー中' : '水上');
    if (sub.ballast < 0.9) return '注水中';
    if (Math.abs(sub.depth - sub.cmd) < 1.5) return Math.abs(sub.cmd - subPeriscopeDepth()) < 1 ? '潜望鏡深度' : '潜航中';
    return sub.depth < sub.cmd ? '深度を下げています' : '深度を上げています';
}
function _subRenderStatus() {
    const el = document.getElementById('sub-status');
    if (!el) return;
    const bottom = _subBottom(), draft = _subDraft();
    const under = bottom != null ? Math.max(0, bottom - sub.depth - draft) : null;
    el.innerHTML = `<div><b>${_subStateWord()}</b>　深さ <b>${sub.depth.toFixed(1)}</b>m${sub.mode === 'dive' ? `（指示 ${Math.round(sub.cmd)}m）` : ''}</div>
        <div>バラスト ${Math.round(Math.max(0, sub.ballast) * 100)}%　縦傾斜 ${(sub.pitch * 180 / Math.PI).toFixed(0)}°　測深 ${under == null ? '—' : under.toFixed(0) + 'm（船底から海底まで）'}</div>
        <div>魚雷 ${sub.loaded}/${subCfg.tubes}${sub.reload.length ? `（装填中 ${Math.ceil(Math.min(...sub.reload))}秒）` : ''}${sub.torps.length ? `　航走中 ${sub.torps.length}` : ''}</div>
        ${sub.msg && sub.msgT > 0 ? `<div class="sb-msg">${sub.msg}</div>` : ''}`;
}
function renderSubPanel() {
    const panel = document.getElementById('sub-panel');
    if (!panel) return;
    const pd = subPeriscopeDepth();
    uiSetHTML(panel, `<div class="sb-head"><span class="sb-title">潜水艦</span></div>
        <div id="sub-status" class="sb-status"></div>
        <div class="sb-row">
            <button onclick="subDive()" ${sub.mode === 'dive' ? 'class="on"' : ''}>⬇ 潜航</button>
            <button onclick="subPeriscope()">潜望鏡深度（${pd.toFixed(0)}m）</button>
            <button onclick="subSurface()" ${sub.mode === 'surface' && sub.depth > 0.5 ? 'class="on"' : ''}>⬆ 浮上</button>
        </div>
        <div class="sb-row">深さ：
            <button onclick="subDepthStep(-50)">−50</button><button onclick="subDepthStep(-10)">−10</button>
            <button onclick="subDepthStep(10)">＋10</button><button onclick="subDepthStep(50)">＋50</button>
            <button class="sb-blow" onclick="subEmergency()">🚨 緊急浮上</button>
        </div>
        <div class="sb-row">潜望鏡：
            <button onclick="subScopeToggle()" ${sub.scopeUp ? 'class="on"' : ''}>${sub.scopeUp ? '下げる' : '上げる'}</button>
            <button onclick="subScopeView(${!sub.view})" ${sub.view ? 'class="on"' : ''} ${sub.scopeUp ? '' : 'disabled'}>${sub.view ? '覗くのをやめる' : '👁 覗く'}</button>
            ${[1.5, 6].map(z => `<button onclick="subZoom(${z})" ${sub.zoom === z ? 'class="on"' : ''}>×${z}</button>`).join('')}
        </div>
        <div class="sb-sonar"><canvas id="sub-sonar" width="180" height="180"></canvas>
            <div class="sb-scol"><button onclick="subPing()">📡 ピン（アクティブ）</button>
            <div class="sb-note">線：聞こえる音の方位（タグ・魚雷）<br>点：ピンの反響（緑＝岸・海底、黄＝船）</div>
            <button class="sb-fire" onclick="subFire()" ${sub.loaded ? '' : 'disabled'}>🚀 魚雷発射</button>
            <div class="sb-note">${sub.view ? '潜望鏡の向きへ撃ちます' : '艦首の向きへ撃ちます（潜望鏡を覗けばその向きへ）'}</div></div>
        </div>`);
    _subRenderStatus();
    sub.sonar.lastDraw = 0;
    if (panel.classList.contains('open') && _subSetup.place) _subSetup.place();
}
window.renderSubPanel = renderSubPanel;

// ── 船体設定のページ ──
function renderSubSettings() {
    const el = document.getElementById('sub-settings');
    if (!el) return;
    const p = subScopePos(), auto = !subCfg.scope;
    const num = (k, v, step) => `<input type="number" class="sp-num-input" style="width:64px" step="${step}" value="${(+v).toFixed(2)}" onchange="subSetScope('${k}', this.value)">`;
    el.innerHTML = `<div class="sp-section-title">🌊 艦種</div>
        <div class="sp-row"><span class="sp-label">種類:</span>
            <select onchange="subSetCfg('type', this.value)">
                <option value="surface"${subCfg.type === 'surface' ? ' selected' : ''}>水上艦（ふつうの船）</option>
                <option value="submarine"${subCfg.type === 'submarine' ? ' selected' : ''}>潜水艦</option>
            </select></div>
        ${isSubmarine() ? `
        <div style="font-size:10px;color:#888;margin:4px 0 6px;">画面の「潜水」ボタンで、潜航・浮上・潜望鏡・ソナー・魚雷を操作します。</div>
        <div class="sp-row"><span class="sp-label">安全潜航深度:</span>
            <input type="range" class="sp-slider" min="50" max="600" step="10" value="${subCfg.maxDepth}" oninput="subSetCfg('maxDepth', +this.value);this.nextElementSibling.textContent=this.value+'m'"><span>${subCfg.maxDepth}m</span></div>
        <div class="sp-section-title" style="margin-top:8px;">🔭 潜望鏡</div>
        <div class="sp-row"><span class="sp-label">位置（模型の座標）:</span>
            X ${num('x', p.x, 0.1)} Y ${num('y', p.y, 0.1)} Z ${num('z', p.z, 0.1)}</div>
        <div class="sp-row"><button class="sp-gizmo-btn" onclick="subSetScope('auto')">🔝 いちばん高い所（艦橋の上）に置く</button>
            <span style="font-size:10px;color:#888;">${auto ? '今は自動（いちばん高い所）' : ''}</span></div>
        <div class="sp-row"><span class="sp-label">伸ばす長さ:</span>
            <input type="range" class="sp-slider" min="3" max="15" step="0.5" value="${subCfg.scopeLen}" oninput="subSetCfg('scopeLen', +this.value);this.nextElementSibling.textContent=this.value+'m'"><span>${subCfg.scopeLen}m</span></div>
        <div style="font-size:10px;color:#888;margin-bottom:6px;">設定画面を開いている間は、潜望鏡を上げた形で見せます。潜望鏡深度は ${subPeriscopeDepth().toFixed(1)}m（艦橋の上が水面の 1.5m 下）。</div>
        <div class="sp-section-title" style="margin-top:8px;">🚀 魚雷</div>
        <div class="sp-row"><span class="sp-label">発射管の数:</span>
            <input type="range" class="sp-slider" min="1" max="10" step="1" value="${subCfg.tubes}" oninput="subSetCfg('tubes', +this.value);this.nextElementSibling.textContent=this.value"><span>${subCfg.tubes}</span></div>
        <div class="sp-row"><span class="sp-label">速さ:</span>
            <input type="range" class="sp-slider" min="20" max="70" step="1" value="${subCfg.torpSpeed}" oninput="subSetCfg('torpSpeed', +this.value);this.nextElementSibling.textContent=this.value+'kn'"><span>${subCfg.torpSpeed}kn</span></div>
        <div class="sp-row"><span class="sp-label">射程:</span>
            <input type="range" class="sp-slider" min="2" max="40" step="1" value="${subCfg.torpRange}" oninput="subSetCfg('torpRange', +this.value);this.nextElementSibling.textContent=this.value+'km'"><span>${subCfg.torpRange}km</span></div>` : ''}`;
}
window.renderSubSettings = renderSubSettings;
function subSetCfg(k, v) {
    subCfg[k] = v;
    if (k === 'type') { subSurfaceNow(true); sub.loaded = subCfg.tubes; sub.reload = []; _subUpdateHudButton(); renderSubSettings(); }
    if (k === 'tubes') { sub.loaded = Math.min(sub.loaded, v); if (!sub.reload.length) sub.loaded = v; }
}
function subSetScope(k, v) {
    if (k === 'auto') { subCfg.scope = null; sub.topCache = null; renderSubSettings(); return; }
    const p = Object.assign({}, subScopePos());
    p[k] = +v || 0;
    subCfg.scope = p;
}
window.subSetCfg = subSetCfg; window.subSetScope = subSetScope;

document.addEventListener('DOMContentLoaded', () => { setTimeout(_subSetup, 50); });
