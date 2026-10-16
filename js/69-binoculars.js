'use strict';

// ════════════════════════════════════════════════════════════════
//  双眼鏡：見張り台の視点で、遠くを大きく見る
// ════════════════════════════════════════════════════════════════
//  ・見張り台の視点（cameraMode 'viewpoint'。潜望鏡・測距儀は別：54-submarine.js・66-sights.js）のときだけ使える。
//    左の「🔭 双眼鏡」か B キーで覗く／やめる（Esc でもやめる）。
//  ・倍率は ×2〜×25。既定は ×7（船の見張りが使う 7×50 の双眼鏡）。下の − ＋ は ×3・×7・×12・×25 の順に、
//    2 本指でつまむ・広げる、マウスのホイールでは細かく変える。画角は「覗く前の画角 ÷ 倍率」で、滑らかに寄る。
//  ・見回すドラッグの速さを倍率で割る（指の動きと景色の動きが合うように：06-input-controls.js の vpLook）。
//  ・のぞき窓は二つの丸がつながった形（まわりは黒）。下に方位と倍率。
//  ・見張り台の視点から出たら（通常視点に戻る・設定を開く・潜望鏡・測距儀）、画角を元に戻す。
//  ・霧・もやで見えない遠くは、双眼鏡でも見えない（見える距離は天候のまま）。

const BINO_ZOOMS = [3, 7, 12, 25];
const BINO_MIN = 2, BINO_MAX = 25;
const bino = { on: false, zoom: 7, cur: 1, baseFov: null, pinch: null, el: null, btn: null, w: 0, h: 0 };
window.bino = bino;

function _binoKey() { return typeof viewpointActiveKey !== 'undefined' ? viewpointActiveKey : null; }
// 今、双眼鏡を使える視点か
function binoAvailable() {
    if (typeof cameraMode === 'undefined' || cameraMode !== 'viewpoint') return false;
    const k = _binoKey();
    if (!k || k === 'periscope' || k === 'rangefinder') return false;
    const sp = document.getElementById('settings-panel');
    return !(sp && sp.classList.contains('open'));
}
window.binoAvailable = binoAvailable;

function binoToggle(on) {
    if (on === undefined) on = !bino.on;
    if (on) {
        if (bino.on || !binoAvailable()) return;
        bino.on = true;
        bino.baseFov = camera.fov;
        bino.cur = 1;                 // 覗いた瞬間から倍率まで滑らかに寄る
    } else {
        if (!bino.on) return;
        bino.on = false;
        bino.pinch = null;
        if (bino.baseFov != null) { camera.fov = bino.baseFov; camera.updateProjectionMatrix(); }
        bino.baseFov = null;
    }
    _binoOverlay();
}
window.binoToggle = binoToggle;

function binoSetZoom(z) {
    bino.zoom = Math.max(BINO_MIN, Math.min(BINO_MAX, z));
    _binoOverlay();
}
// − ＋：決まった倍率の順に
function binoZoomStep(d) {
    let i;
    if (d > 0) { i = BINO_ZOOMS.findIndex(z => z > bino.zoom + 0.01); if (i < 0) i = BINO_ZOOMS.length - 1; }
    else { i = -1; for (let j = BINO_ZOOMS.length - 1; j >= 0; j--) if (BINO_ZOOMS[j] < bino.zoom - 0.01) { i = j; break; } if (i < 0) i = 0; }
    binoSetZoom(BINO_ZOOMS[i]);
}
window.binoSetZoom = binoSetZoom; window.binoZoomStep = binoZoomStep;

// 見回すドラッグに掛ける（06-input-controls.js の vpLook）
function binoLookScale() { return bino.on ? 1 / Math.max(1, bino.cur) : 1; }
window.binoLookScale = binoLookScale;

function _binoBearing() {
    const yawDeg = (typeof viewpointYaw !== 'undefined' ? viewpointYaw : 0) * 180 / Math.PI;
    const c = (typeof worldTrueCompass === 'function' ? worldTrueCompass() : (typeof worldCompass === 'function' ? worldCompass(physics.heading) : 0)) - yawDeg;
    return ((c % 360) + 360) % 360;
}

// ── のぞき窓 ──
// 二つの丸（半径 r、中心は画面の真ん中から左右に dx）の外を黒く塗る。丸の縁は少しぼかす
function _binoShape() {
    const W = window.innerWidth, H = window.innerHeight;
    if (!bino.el || (W === bino.w && H === bino.h)) return;
    bino.w = W; bino.h = H;
    const r = Math.min(0.47 * H, 0.34 * W), dx = r * 0.58, cy = H / 2;
    const svg = bino.el.querySelector('svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML =
        `<defs>` +
        `<radialGradient id="bino-g"><stop offset="0" stop-color="#000" stop-opacity="1"/><stop offset="0.9" stop-color="#000" stop-opacity="1"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>` +
        `<mask id="bino-m" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}">` +
        `<rect x="0" y="0" width="${W}" height="${H}" fill="#fff"/>` +
        `<circle cx="${W / 2 - dx}" cy="${cy}" r="${r}" fill="url(#bino-g)"/>` +
        `<circle cx="${W / 2 + dx}" cy="${cy}" r="${r}" fill="url(#bino-g)"/>` +
        `</mask></defs>` +
        `<rect x="0" y="0" width="${W}" height="${H}" fill="#000" mask="url(#bino-m)"/>`;
    // 方位・倍率と操作の並びは、のぞき窓の下の縁のすぐ上に
    const info = bino.el.querySelector('.bino-info'), bar = bino.el.querySelector('.bino-bar');
    if (info) info.style.top = `${cy + r * 0.62}px`;
    if (bar) bar.style.top = `${Math.min(H - 44, cy + r * 0.62 + 24)}px`;
}

function _binoOverlay() {
    if (!bino.el) {
        const el = document.createElement('div');
        el.id = 'bino-scope';
        el.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none"></svg>'
            + '<div class="bino-scale"></div><div class="bino-info"></div><div class="bino-bar"></div>';
        document.body.appendChild(el);
        bino.el = el;
        const btn = document.createElement('button');
        btn.id = 'bino-toggle';
        btn.onclick = () => binoToggle();
        document.body.appendChild(btn);
        bino.btn = btn;
    }
    bino.el.classList.toggle('on', bino.on);
    if (bino.on) _binoShape();
    const z = bino.zoom >= 10 ? bino.zoom.toFixed(0) : bino.zoom.toFixed(1).replace(/\.0$/, '');
    const html = `<button onclick="binoZoomStep(-1)">−</button><span class="bino-z">×${z}</span><button onclick="binoZoomStep(1)">＋</button><button onclick="binoToggle(false)">✕</button>`;
    const bar = bino.el.querySelector('.bino-bar');
    if (bar.innerHTML !== html) bar.innerHTML = html;
    const label = bino.on ? '✕ 双眼鏡' : '🔭 双眼鏡';
    if (bino.btn.textContent !== label) bino.btn.textContent = label;
    bino.btn.classList.toggle('on', bino.on);
}

// 毎フレーム（17-main-loop.js）：見張り台から出たらやめる・倍率へ滑らかに寄る・方位の表示
function updateBinoculars(dt) {
    const avail = binoAvailable();
    if (bino.on && !avail) binoToggle(false);
    if (!bino.btn && avail) _binoOverlay();
    if (bino.btn) {
        const show = avail || bino.on;
        if (bino.btn.classList.contains('show') !== show) bino.btn.classList.toggle('show', show);
    }
    if (!bino.on) return;
    _binoShape();
    const k = 1 - Math.exp(-Math.max(0, Math.min(0.1, dt || 0.016)) * 9);
    // 倍率は対数で寄せる（×3 → ×25 でも同じ速さに見える）
    bino.cur = Math.exp(Math.log(bino.cur) + (Math.log(bino.zoom) - Math.log(bino.cur)) * k);
    if (Math.abs(bino.cur - bino.zoom) < 0.002) bino.cur = bino.zoom;
    const fov = bino.baseFov / bino.cur;
    if (Math.abs(camera.fov - fov) > 1e-4) { camera.fov = fov; camera.updateProjectionMatrix(); }
    const info = bino.el.querySelector('.bino-info');
    const txt = `方位 ${_binoBearing().toFixed(0).padStart(3, '0')}°　×${bino.cur >= 10 ? bino.cur.toFixed(0) : bino.cur.toFixed(1)}`;
    if (info.textContent !== txt) info.textContent = txt;
}
window.updateBinoculars = updateBinoculars;

// 潜望鏡・測距儀を覗く前に双眼鏡をやめる（どちらも覗く前の画角を覚えるので、寄ったままの画角を覚えないように）
(function () {
    for (const name of ['sightRFView', 'subScopeView']) {
        const orig = window[name];
        if (typeof orig !== 'function') continue;
        window[name] = function (on) {
            if (on && bino.on) binoToggle(false);
            return orig.apply(this, arguments);
        };
    }
})();

// ── 操作：B キー・Esc・ホイール・2 本指 ──
window.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if ((e.key === 'b' || e.key === 'B') && !e.repeat && (bino.on || binoAvailable())) binoToggle();
    else if (e.key === 'Escape' && bino.on) binoToggle(false);
});
window.addEventListener('wheel', (e) => {
    if (!bino.on) return;
    if (e.target && e.target.closest && e.target.closest('#settings-panel, #viewpoint-menu, #telemetry-panel, #ui-container')) return;
    binoSetZoom(bino.zoom * Math.exp(-e.deltaY * 0.0015));
}, { passive: true });
document.addEventListener('DOMContentLoaded', () => {
    const cv = document.getElementById('canvas-container');
    if (!cv) return;
    const dist = (ts) => Math.hypot(ts[0].clientX - ts[1].clientX, ts[0].clientY - ts[1].clientY);
    cv.addEventListener('touchstart', (e) => {
        if (bino.on && e.touches.length === 2) bino.pinch = { d: Math.max(1, dist(e.touches)), z: bino.zoom };
    }, { passive: true });
    cv.addEventListener('touchmove', (e) => {
        if (bino.on && bino.pinch && e.touches.length === 2) binoSetZoom(bino.pinch.z * dist(e.touches) / bino.pinch.d);
    }, { passive: true });
    cv.addEventListener('touchend', (e) => { if (e.touches.length < 2) bino.pinch = null; }, { passive: true });
});
