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

const MM_RANGES = [2000, 6000, 20000, 60000];
const MM_TILE = 160;                      // 地面の絵の細かさ（1辺の点の数）
const MM_TILE_K = 1.6;                    // 地面の絵の広さ（見える半径の何倍）
const _mm = { show: true, zoom: 1, headUp: false, tile: null, build: null, lastDraw: 0, chart: null };
try {
    const s = JSON.parse(localStorage.getItem('susuru_minimap') || 'null');
    if (s) { _mm.show = s.show !== false; _mm.zoom = Math.max(0, Math.min(MM_RANGES.length - 1, s.zoom | 0)); _mm.headUp = !!s.headUp; }
} catch (e) { /* ignore */ }
function _mmSave() { try { localStorage.setItem('susuru_minimap', JSON.stringify({ show: _mm.show, zoom: _mm.zoom, headUp: _mm.headUp })); } catch (e) { /* ignore */ } }

function minimapShow(on) {
    _mm.show = !!on; _mmSave();
    const el = document.getElementById('minimap'); if (el) el.classList.toggle('off', !_mm.show);
    const b = document.getElementById('wp-minimap'); if (b) b.classList.toggle('on', _mm.show);
}
function minimapZoom(d) {
    _mm.zoom = Math.max(0, Math.min(MM_RANGES.length - 1, _mm.zoom + d)); _mmSave();
    _mm.build = null;                      // 新しい範囲で作り直す（できるまでは前の絵を引き伸ばして使う）
    _mm.lastDraw = 0;
}
function minimapHeadUp() { _mm.headUp = !_mm.headUp; _mmSave(); _mm.lastDraw = 0; }
Object.assign(window, { minimapShow, minimapZoom, minimapHeadUp });

function _mmEnsureDom() {
    if (document.getElementById('minimap')) return;
    const el = document.createElement('div');
    el.id = 'minimap';
    el.innerHTML = `<canvas id="mm-canvas"></canvas>
        <button class="mm-b mm-n" title="北が上／船首が上" onclick="minimapHeadUp()">N</button>
        <button class="mm-b mm-plus" title="狭く" onclick="minimapZoom(-1)">＋</button>
        <button class="mm-b mm-minus" title="広く" onclick="minimapZoom(1)">－</button>
        <button class="mm-b mm-x" title="しまう（世界地図から戻せます）" onclick="minimapShow(false)">✕</button>
        <span class="mm-scale"></span>`;
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
    if (B.row >= N) { _mm.tile = B; }
}

function _mmDraw() {
    const cv = document.getElementById('mm-canvas'); if (!cv) return;
    const el = document.getElementById('minimap');
    // TELEMETRY のすぐ下へ
    const tp = document.getElementById('telemetry-panel');
    if (tp) { const r = tp.getBoundingClientRect(); el.style.top = Math.round(r.bottom + 8) + 'px'; }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = cv.clientWidth || 150;
    if (cv.width !== Math.round(W * dpr)) { cv.width = cv.height = Math.round(W * dpr); }
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
    // 港
    if (world.ports) {
        g.font = '9px sans-serif'; g.textBaseline = 'middle';
        for (const p of world.ports) {
            const loc = worldUnitToLocal(p.u);
            if (!Number.isFinite(loc.x)) continue;
            const q = toS(loc.x, loc.z);
            if (Math.hypot(q.x, q.y) > c + 10) continue;
            const Tp = PORT_TYPES[p.type];
            g.fillStyle = Tp.color; g.strokeStyle = '#0a1932'; g.lineWidth = 1;
            g.beginPath(); g.arc(q.x, q.y, 3.5, 0, Math.PI * 2); g.fill(); g.stroke();
            g.save(); g.translate(q.x, q.y); g.rotate(-rot);
            g.fillStyle = _wm.chart ? '#16283c' : '#fff'; g.fillText(p.name, 6, 0);
            g.restore();
        }
    }
    // 自動航行の航路
    const rp = (typeof autopilotRoutePoints === 'function') ? autopilotRoutePoints() : null;
    if (rp && rp.length > 1) {
        g.strokeStyle = _wm.chart ? '#c0208a' : '#ff5ad0'; g.lineWidth = 1.6;
        g.beginPath();
        rp.forEach((q, i) => { const loc = worldUnitToLocal(worldLatLonToUnit(q.lat, q.lon)); if (!Number.isFinite(loc.x)) return; const s = toS(loc.x, loc.z); if (i === 0) g.moveTo(s.x, s.y); else g.lineTo(s.x, s.y); });
        g.stroke();
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
    g.beginPath(); g.moveTo(0, -8); g.lineTo(5, 6); g.lineTo(0, 3); g.lineTo(-5, 6); g.closePath(); g.fill(); g.stroke();
    g.restore();
    // 北の印（縁）
    const nx = c + Math.sin(rot) * (c - 9), ny = c - Math.cos(rot) * (c - 9);
    g.fillStyle = '#ff5a4a'; g.font = 'bold 10px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('N', nx, ny); g.textAlign = 'start';
    // 縁
    g.strokeStyle = 'rgba(0,255,204,0.6)'; g.lineWidth = 1.5; g.beginPath(); g.arc(c, c, c - 1, 0, Math.PI * 2); g.stroke();
    const sc = el.querySelector('.mm-scale');
    if (sc) sc.textContent = `半径 ${viewR >= 1000 ? viewR / 1000 + 'km' : viewR + 'm'}`;
    const nb = el.querySelector('.mm-n'); if (nb) nb.classList.toggle('on', _mm.headUp);
}

function updateMinimap(t) {
    const on = _mm.show && window.world && world.mode === 'world' && typeof worldHeightAtLocal === 'function';
    const el = document.getElementById('minimap');
    if (!on) { if (el) el.classList.add('hidden'); return; }
    _mmEnsureDom();
    document.getElementById('minimap').classList.remove('hidden');
    const sx = physics.cgWorldX || 0, sz = physics.cgWorldZ || 0;
    const viewR = MM_RANGES[_mm.zoom];
    const T = _mm.tile, B = _mm.build;
    // 色の決まり（海図／地形）が変わったら、高さはそのまま塗り直す
    if (_mm.chart !== !!_wm.chart) {
        _mm.chart = !!_wm.chart;
        for (const X of [T, B]) if (X && X.cv.rows) _wmPaint(X.cv, 0, X.cv.rows);
    }
    const need = !T || T.zoom !== _mm.zoom || Math.hypot(sx - T.cx, sz - T.cz) > viewR * 0.3;
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
