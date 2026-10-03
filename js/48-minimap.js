// ════════════════════════════════════════════════════════════════
//  小さな地図（ミニマップ）
// ════════════════════════════════════════════════════════════════
//  世界を航海するモードのとき、右上の TELEMETRY の下に丸い地図を出す。
//    ・色は世界地図と同じ（「📘 海図」にしていれば海図の色・等深線）
//    ・＋／－で範囲（半径 2km・6km・20km・60km）、「N」で北が上 ⇄ 船首が上
//    ・地図を触ると大きな世界地図が開く。✕ でしまう（世界地図のパネルから戻せる）
//  地面の絵は、船のまわり（見える範囲の 1.6 倍）を少しずつ作って覚えておき、
//  船が動いたら位置をずらして描く。はみ出しそうになったら作り直す。
//  物理の面の座標：+x が西、+z が北（43-world.js の worldLocalToUnit）。

const MM_RANGES = [500, 1000, 2000, 6000, 20000, 60000];
const MM_DANGER_IDX = 2;                   // 危ない海域で自動で拡大するときの範囲（半径 2km）
const MM_TILE = 160;                      // 地面の絵の細かさ（1辺の点の数）
const MM_TILE_K = 1.6;                    // 地面の絵の広さ（見える半径の何倍）
const _mm = { show: true, zoom: 1, headUp: false, depth: true, tile: null, build: null, lastDraw: 0, chart: null };
try {
    const s = JSON.parse(localStorage.getItem('susuru_minimap') || 'null');
    // （v2 より前の保存は、範囲の並びが [2km, 6km, 20km, 60km] だったので、2 つずらす）
    if (s) { _mm.show = s.show !== false; _mm.zoom = Math.max(0, Math.min(MM_RANGES.length - 1, (s.zoom | 0) + (s.v2 ? 0 : 2))); _mm.headUp = !!s.headUp; _mm.depth = s.depth !== false; }
} catch (e) { /* ignore */ }
// （危ない海域で自動で拡大している間は、元の範囲を覚えておく）
function _mmSave() { try { localStorage.setItem('susuru_minimap', JSON.stringify({ v2: true, show: _mm.show, zoom: _mm.auto ? _mm.auto.prev : _mm.zoom, headUp: _mm.headUp, depth: _mm.depth })); } catch (e) { /* ignore */ } }

function minimapShow(on) {
    _mm.show = !!on; _mmSave();
    const el = document.getElementById('minimap'); if (el) el.classList.toggle('off', !_mm.show);
    const b = document.getElementById('wp-minimap'); if (b) b.classList.toggle('on', _mm.show);
}
function minimapZoom(d) {
    _mm.auto = null;                       // 手で変えたら、自動の拡大はやめる（元へも戻さない）
    _mm.zoom = Math.max(0, Math.min(MM_RANGES.length - 1, _mm.zoom + d)); _mmSave();
    _mm.build = null;                      // 新しい範囲で作り直す（できるまでは前の絵を引き伸ばして使う）
    _mm.lastDraw = 0;
}
function minimapHeadUp() { _mm.headUp = !_mm.headUp; _mmSave(); _mm.lastDraw = 0; }
function minimapDepth() { _mm.depth = !_mm.depth; _mmSave(); _mm.lastDraw = 0; }
Object.assign(window, { minimapShow, minimapZoom, minimapHeadUp, minimapDepth });

function _mmEnsureDom() {
    if (document.getElementById('minimap')) return;
    const el = document.createElement('div');
    el.id = 'minimap';
    el.innerHTML = `<canvas id="mm-canvas"></canvas>
        <button class="mm-b mm-n" title="北が上／船首が上" onclick="minimapHeadUp()">N</button>
        <button class="mm-b mm-plus" title="狭く" onclick="minimapZoom(-1)">＋</button>
        <button class="mm-b mm-minus" title="広く" onclick="minimapZoom(1)">－</button>
        <button class="mm-b mm-x" title="しまう（世界地図から戻せます）" onclick="minimapShow(false)">✕</button>
        <button class="mm-b mm-d" title="水深の数字を出す／消す" onclick="minimapDepth()">深</button>
        <span class="mm-scale"></span>
        <span class="mm-depth"></span>`;
    document.body.appendChild(el);
    el.querySelector('#mm-canvas').addEventListener('click', () => {
        if (typeof toggleWorldMap !== 'function') return;
        const ll = worldShipLatLon();
        _wm.cx = ll.lon; _wm.cy = ll.lat; _wm.zoom = Math.max(_wm.zoom || 1, 60); _wm._centered = true;
        toggleWorldMap(true);
    });
    el.classList.toggle('off', !_mm.show);
}

// 地面の絵を少しずつ作る（1フレーム 5ms まで）
function _mmStartBuild(cx, cz) {
    const R = MM_RANGES[_mm.zoom] * MM_TILE_K;
    const oct = R < 5000 ? 18 : R < 12000 ? 16 : R < 40000 ? 14 : 12;
    const cv = document.createElement('canvas'); cv.width = cv.height = MM_TILE;
    cv.H = new Float32Array(MM_TILE * MM_TILE); cv.rows = 0; cv.img = cv.getContext('2d').createImageData(MM_TILE, MM_TILE);
    const shapes = (typeof _trNearbyShapes === 'function') ? _trNearbyShapes(cx, cz, R * 1.5 + 6000) : [];
    _mm.build = { cv, cx, cz, R, oct, shapes, row: 0, zoom: _mm.zoom, chart: !!_wm.chart };
}
function _mmStepBuild() {
    const B = _mm.build; if (!B || B.row >= MM_TILE) return;
    const t0 = performance.now(), N = MM_TILE, r0 = B.row;
    while (B.row < N && performance.now() - t0 < 5) {
        const n = B.R - (B.row + 0.5) / N * 2 * B.R;                 // 北へ[m]
        for (let i = 0; i < N; i++) {
            const e = (i + 0.5) / N * 2 * B.R - B.R;                 // 東へ[m]
            const x = B.cx - e, z = B.cz + n;                        // 物理の面（+x が西）
            let h = worldHeightAtLocal(x, z, B.oct);
            if (B.shapes.length && h < 6 && typeof _portAdjust === 'function') h = _portAdjust(h, x, z, B.shapes);
            B.cv.H[B.row * N + i] = h;
        }
        B.row++;
    }
    B.cv.rows = B.row;
    _wmPaint(B.cv, Math.max(0, r0 - 1), B.row);
    if (B.row >= N) { B.at = performance.now(); _mm.tile = B; }
}

function _mmDraw() {
    const cv = document.getElementById('mm-canvas'); if (!cv) return;
    const el = document.getElementById('minimap');
    // TELEMETRY のすぐ下へ。下の舵輪などとぶつかる（画面が低い）ときは TELEMETRY の左へ
    const tp = document.getElementById('telemetry-panel');
    if (tp) {
        const r = tp.getBoundingClientRect(), mh = el.offsetHeight || 150;
        const wh = document.getElementById('wheel-widget');
        const floor = (wh && wh.offsetParent) ? wh.getBoundingClientRect().top : window.innerHeight;
        if (r.bottom + 8 + mh + 36 <= floor - 4) { el.style.top = Math.round(r.bottom + 8) + 'px'; el.style.right = ''; }
        else {
            // 上のボタンの列（スクショ・地図など）より下へ
            let btnBottom = 0;
            for (const id of ['worldmap-toggle', 'screenshot-toggle', 'viewpoint-toggle', 'camera-mode-toggle']) {
                const b = document.getElementById(id);
                if (b && b.offsetParent) { const q = b.getBoundingClientRect(); if (q.right > r.left - 200) btnBottom = Math.max(btnBottom, q.bottom); }
            }
            el.style.top = Math.round(Math.max(r.top + 14, btnBottom + 18)) + 'px';
            el.style.right = Math.round(window.innerWidth - r.left + 16) + 'px';
        }
    }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = cv.clientWidth || 150;
    // 幅と高さの両方を見る（キャンバスは最初 300×150。高解像度の画面だと幅だけ合っていて高さが違うことがある）
    const px = Math.round(W * dpr);
    if (cv.width !== px || cv.height !== px) { cv.width = px; cv.height = px; }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const c = W / 2, viewR = MM_RANGES[_mm.zoom], k = c / viewR;     // 1m あたりの点
    // 真ん中は、画面に描いている船の位置
    const shipP = (typeof shipGroup !== 'undefined' && shipGroup) ? shipGroup.position : null;
    const sx = shipP ? shipP.x : (physics.cgWorldX || 0), sz = shipP ? shipP.z : (physics.cgWorldZ || 0);
    const compass = (typeof worldCompass === 'function') ? worldCompass(physics.heading) : 0;
    const rot = _mm.headUp ? -compass * Math.PI / 180 : 0;
    g.clearRect(0, 0, W, W);
    g.save();
    g.beginPath(); g.arc(c, c, c - 1, 0, Math.PI * 2); g.clip();
    g.fillStyle = _wm.chart ? '#f6f9fc' : '#1a4a6e'; g.fillRect(0, 0, W, W);
    g.translate(c, c); g.rotate(rot);
    // 物理の面の点 → 画面（北が上：右が東 ＝ −x）
    const toS = (x, z) => ({ x: (sx - x) * k, y: -(z - sz) * k });
    const T = _mm.tile;
    if (T) {
        const s0 = toS(T.cx, T.cz);
        g.imageSmoothingEnabled = true;
        g.drawImage(T.cv, s0.x - T.R * k, s0.y - T.R * k, 2 * T.R * k, 2 * T.R * k);
    }
    // 水深の数字（海図のように。船の喫水＋2m より浅い所は赤で）
    if (_mm.depth && T && T.cv.H) {
        const N = MM_TILE, draft = (typeof worldShipDraft === 'function') ? worldShipDraft() : 5;
        const GAP = 24, cr = Math.cos(-rot), sr = Math.sin(-rot);
        g.save(); g.rotate(-rot);
        g.font = 'italic 9px serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
        for (let py = -c + GAP / 2; py < c; py += GAP) {
            for (let px0 = -c + GAP / 2 + ((Math.round((py + c) / GAP) & 1) ? GAP / 2 : 0); px0 < c; px0 += GAP) {
                if (Math.hypot(px0, py) > c - 8 || Math.hypot(px0, py) < 14) continue;
                // 画面の点 → 地図の向き（回す前）→ 物理の面
                const u = px0 * cr - py * sr, v = px0 * sr + py * cr;
                const x = sx - u / k, z = sz - v / k;
                const e = T.cx - x, n = z - T.cz;
                const i = Math.floor((e + T.R) / (2 * T.R) * N), j = Math.floor((T.R - n) / (2 * T.R) * N);
                if (i < 0 || j < 0 || i >= N || j >= N) continue;
                const h = T.cv.H[j * N + i];
                if (!(h < -0.5)) continue;
                const d = -h;
                const txt = d < 20 ? d.toFixed(0) : d < 1000 ? String(Math.round(d / 5) * 5) : (d / 1000).toFixed(1) + 'k';
                const danger = d < draft + 2;
                g.lineWidth = 2.2; g.strokeStyle = _wm.chart ? 'rgba(255,255,255,0.85)' : 'rgba(6,24,40,0.7)'; g.strokeText(txt, px0, py);
                g.fillStyle = danger ? '#ff4a3a' : _wm.chart ? '#34506e' : '#bfe6ff';
                g.fillText(txt, px0, py);
            }
        }
        g.textAlign = 'start';
        g.restore();
    }
    // 港
    // （埠頭は点だけ。名前は港ごとに 1 つ：埠頭のまとまりの真ん中に）
    if (world.ports) {
        g.font = '9px sans-serif'; g.textBaseline = 'middle';
        for (const p of world.ports) {
            const loc = worldUnitToLocal(p.u);
            if (!Number.isFinite(loc.x)) continue;
            const q = toS(loc.x, loc.z);
            if (Math.hypot(q.x, q.y) > c + 10) continue;
            const Tp = PORT_TYPES[p.type];
            g.fillStyle = Tp.color; g.strokeStyle = '#0a1932'; g.lineWidth = 1;
            g.beginPath(); g.arc(q.x, q.y, p.group ? 2.5 : 3.5, 0, Math.PI * 2); g.fill(); g.stroke();
        }
        const groups = typeof worldPortGroups === 'function' ? worldPortGroups() : [];
        for (const gr of groups) {
            const loc = worldUnitToLocal(worldLatLonToUnit(gr.lat, gr.lon));
            if (!Number.isFinite(loc.x)) continue;
            const q = toS(loc.x, loc.z);
            if (Math.hypot(q.x, q.y) > c - 4) continue;
            g.save(); g.translate(q.x, q.y); g.rotate(-rot);
            g.lineWidth = 2.2; g.strokeStyle = _wm.chart ? 'rgba(255,255,255,0.85)' : 'rgba(6,24,40,0.7)'; g.strokeText(gr.name, 6, 0);
            g.fillStyle = _wm.chart ? '#16283c' : '#fff'; g.fillText(gr.name, 6, 0);
            g.restore();
        }
    }
    // 他の船（59-traffic.js）
    if (typeof trafficDrawMinimap === 'function' && world.mode === 'world') trafficDrawMinimap(g, toS, k, c, rot);
    // 自動航行の航路
    const rp = (typeof autopilotRoutePoints === 'function') ? autopilotRoutePoints() : null;
    if (rp && rp.length > 1) {
        g.strokeStyle = _wm.chart ? '#c0208a' : '#ff5ad0'; g.lineWidth = 1.6;
        g.beginPath();
        const sp = rp.map(q => { const loc = worldUnitToLocal(worldLatLonToUnit(q.lat, q.lon)); return Number.isFinite(loc.x) ? toS(loc.x, loc.z) : null; });
        sp.forEach((s, i) => { if (!s) return; if (i === 0) g.moveTo(s.x, s.y); else g.lineTo(s.x, s.y); });
        g.stroke();
        // タグの付き添いで通る狭い水路
        if (rp.some(q => q.narrow)) {
            g.strokeStyle = '#ff9f1a'; g.lineWidth = 2.4; g.setLineDash([4, 3]);
            g.beginPath();
            for (let i = 1; i < sp.length; i++) if (rp[i].narrow && sp[i] && sp[i - 1]) { g.moveTo(sp[i - 1].x, sp[i - 1].y); g.lineTo(sp[i].x, sp[i].y); }
            g.stroke(); g.setLineDash([]);
        }
    }
    // 自動航行で向かっている海域（旗）
    if (typeof autopilot !== 'undefined' && autopilot.dest && autopilot.dest.point && autopilot.active) {
        const loc = worldUnitToLocal(worldLatLonToUnit(autopilot.dest.lat, autopilot.dest.lon));
        if (Number.isFinite(loc.x)) {
            let q = toS(loc.x, loc.z);
            const d = Math.hypot(q.x, q.y);
            if (d > c - 10) q = { x: q.x / d * (c - 10), y: q.y / d * (c - 10) };      // 遠いときは縁に
            g.save(); g.translate(q.x, q.y); g.rotate(-rot);
            g.strokeStyle = g.fillStyle = _wm.chart ? '#c0208a' : '#ff5ad0'; g.lineWidth = 1.6;
            g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -12); g.stroke();
            g.beginPath(); g.moveTo(0, -12); g.lineTo(8, -9); g.lineTo(0, -6); g.closePath(); g.fill();
            g.restore();
        }
    }
    // タグボート
    if (window.tugs) for (const t of tugs) {
        const q = toS(t.pos.x, t.pos.z);
        g.fillStyle = '#ffb347'; g.beginPath(); g.arc(q.x, q.y, 2.2, 0, Math.PI * 2); g.fill();
    }
    g.restore();
    // 船（真ん中）
    g.save(); g.translate(c, c); g.rotate(_mm.headUp ? 0 : compass * Math.PI / 180);
    g.fillStyle = '#ffffff'; g.strokeStyle = '#ff3b30'; g.lineWidth = 1.6;
    // 大きく拡大したら、船の本当の大きさの形で（長さ・幅）
    const hpS = window.hullProfile, shipL = (hpS && hpS.ready ? hpS.halfLen * 2 : 12) * (physics.scale || 1);
    if (shipL * k > 18) {
        const len = shipL * k, wid = Math.max(4, (typeof _apShipHalfBeam === 'function' ? _apShipHalfBeam() * 2 : shipL / 9) * k);
        g.beginPath(); g.moveTo(0, -len / 2); g.quadraticCurveTo(wid / 2, -len / 2 + wid, wid / 2, -len / 2 + wid * 1.6); g.lineTo(wid / 2, len / 2 - wid * 0.3);
        g.quadraticCurveTo(wid / 2, len / 2, 0, len / 2); g.quadraticCurveTo(-wid / 2, len / 2, -wid / 2, len / 2 - wid * 0.3); g.lineTo(-wid / 2, -len / 2 + wid * 1.6);
        g.quadraticCurveTo(-wid / 2, -len / 2 + wid, 0, -len / 2); g.closePath(); g.fill(); g.stroke();
    } else { g.beginPath(); g.moveTo(0, -8); g.lineTo(5, 6); g.lineTo(0, 3); g.lineTo(-5, 6); g.closePath(); g.fill(); g.stroke(); }
    g.restore();
    // 北の印（縁）
    const nx = c + Math.sin(rot) * (c - 9), ny = c - Math.cos(rot) * (c - 9);
    g.fillStyle = '#ff5a4a'; g.font = 'bold 10px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('N', nx, ny); g.textAlign = 'start';
    // 縁
    // 縁（危ない海域では赤く）
    g.strokeStyle = _mm.danger ? 'rgba(255,80,60,0.95)' : 'rgba(0,255,204,0.6)'; g.lineWidth = _mm.danger ? 2.5 : 1.5; g.beginPath(); g.arc(c, c, c - 1, 0, Math.PI * 2); g.stroke();
    const sc = el.querySelector('.mm-scale');
    if (sc) sc.textContent = `半径 ${viewR >= 1000 ? viewR / 1000 + 'km' : viewR + 'm'}`;
    const nb = el.querySelector('.mm-n'); if (nb) nb.classList.toggle('on', _mm.headUp);
    const db = el.querySelector('.mm-d'); if (db) db.classList.toggle('on', _mm.depth);
    // 船の下の水深（喫水と比べて：足りないと赤）
    const dl = el.querySelector('.mm-depth');
    if (dl) {
        const dep = (window.terrain && Number.isFinite(terrain.depth)) ? terrain.depth : null;
        const draft = (typeof worldShipDraft === 'function') ? worldShipDraft() : 0;
        if (dep === null) dl.textContent = '';
        else {
            dl.textContent = (_mm.danger ? '⚠ 浅い海域　' : '') + (dep > 999 ? `水深 ${(dep / 1000).toFixed(1)}km` : `水深 ${Math.round(dep)}m（余裕 ${Math.round(dep - draft)}m）`);
            dl.classList.toggle('warn', dep - draft < 3 || !!_mm.danger);
        }
    }
}

// ── 危ない海域（浅くて、船の下の余裕が少ない）では、自動で半径 2km に拡大する ──
//   ・今いる所の余裕が 4m 未満、船首・船尾の下が浅い、または前（速さに応じて 300m〜1.5km 先まで）に
//     喫水＋2m より浅い所がある
//   ・抜けて 20 秒たったら、元の範囲に戻す（その間に手で変えたら、そのまま）
const MM_DANGER_CLEAR_S = 20;
function _mmDanger() {
    if (!window.terrain || !Number.isFinite(terrain.depth) || typeof worldSeabedAt !== 'function') return false;
    const draft = (typeof worldShipDraft === 'function') ? worldShipDraft() : 5;
    if (terrain.depth - draft < 4) return true;
    // 止まっている（岸壁に着けている・錨地）ときは、船の真下だけ見る（前の岸壁を「浅い」としない）
    const v = physics.speed || 0;
    if (Math.abs(v) < 0.3) return false;
    if (terrain._bowWarn || terrain._sternWarn) return true;
    const look = Math.min(1500, Math.max(300, Math.abs(v) * 120)), sg = v < -0.3 ? -1 : 1;
    const h = (physics.heading || 0) * Math.PI / 180, fx = Math.sin(h) * sg, fz = Math.cos(h) * sg, sx = Math.cos(h), sz = -Math.sin(h);
    const x0 = physics.cgWorldX || 0, z0 = physics.cgWorldZ || 0;
    for (const f of [0.33, 0.66, 1]) for (const side of [-1, 0, 1]) {
        const x = x0 + fx * look * f + sx * side * 60, z = z0 + fz * look * f + sz * side * 60;
        if (worldSeabedAt(x, z) > -(draft + 2)) return true;
    }
    return false;
}
function _mmAutoZoom() {
    const now = performance.now();
    if (now - (_mm.azT || 0) < 500) return;
    const dt = Math.min(2, (now - (_mm.azT || now)) / 1000);
    _mm.azT = now;
    const danger = _mmDanger();
    _mm.danger = danger;
    if (danger) {
        _mm.azClear = 0;
        if (!_mm.auto && _mm.zoom > MM_DANGER_IDX) { _mm.auto = { prev: _mm.zoom }; _mm.zoom = MM_DANGER_IDX; _mm.build = null; _mm.lastDraw = 0; }
    } else if (_mm.auto) {
        _mm.azClear = (_mm.azClear || 0) + dt;
        if (_mm.azClear > MM_DANGER_CLEAR_S) { _mm.zoom = _mm.auto.prev; _mm.auto = null; _mm.build = null; _mm.lastDraw = 0; }
    }
}
function updateMinimap(t) {
    const on = _mm.show && window.world && world.mode === 'world' && typeof worldHeightAtLocal === 'function';
    const el = document.getElementById('minimap');
    if (!on) { if (el) el.classList.add('hidden'); return; }
    _mmEnsureDom();
    document.getElementById('minimap').classList.remove('hidden');
    _mmAutoZoom();
    const sx = physics.cgWorldX || 0, sz = physics.cgWorldZ || 0;
    const viewR = MM_RANGES[_mm.zoom];
    const T = _mm.tile, B = _mm.build;
    // 色の決まり（海図／地形）が変わったら、高さはそのまま塗り直す
    if (_mm.chart !== !!_wm.chart) {
        _mm.chart = !!_wm.chart;
        for (const X of [T, B]) if (X && X.cv.rows) _wmPaint(X.cv, 0, X.cv.rows);
    }
    // （3 分ごとにも作り直す：メモリが足りないと、iPad などでは作った絵の中身が消えて、他の船と航路しか見えなくなるので）
    const need = !T || T.zoom !== _mm.zoom || Math.hypot(sx - T.cx, sz - T.cz) > viewR * 0.3 || performance.now() - (T.at || 0) > 180000;
    const building = B && B.row < MM_TILE && B.zoom === _mm.zoom;
    if (need && !building) _mmStartBuild(Math.round(sx), Math.round(sz));
    _mmStepBuild();
    const now = performance.now();
    if (now - _mm.lastDraw > 100) { _mm.lastDraw = now; _mmDraw(); }
}
window.updateMinimap = updateMinimap;
// 地図を作り直さないといけないとき（港へ移動した・原点が変わった）
function minimapReset() { _mm.tile = null; _mm.build = null; }
window.minimapReset = minimapReset;
