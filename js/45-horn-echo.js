// ════════════════════════════════════════════════════════════════
//  汽笛のこだま（世界を航海するモードで、陸の近くにいるとき）
// ════════════════════════════════════════════════════════════════
//  船のまわりを 32 の向きに見て、いちばん近い陸（崖・岸壁・島）までの距離を測り、
//  よく返ってきそうな所（近くて高い所）を最大 4 つ選んで、こだまにする。
//    ・遅れ   ＝ 汽笛 → 崖 → 聞く所 の道のり ÷ 音の速さ（1km 先の崖なら約 6 秒後）
//    ・大きさ ＝ その道のりに反比例（汽笛そのものと同じ減衰：60m より先は距離に反比例）＋空気に吸われる分。
//               高い崖ほどよく返る
//    ・音色   ＝ 道のりが長いほど高い音が抜けてこもる
//    ・左右   ＝ 返ってくる向き（視点の向きに合わせて振る）
//  汽笛の音（audio.buses.horn）だけを分けて通すので、機関音やベルはこだましない。

const ECHO_TAPS = 4;
const ECHO_DIRS = 32;
const ECHO_MAX_R = 6000;             // これより遠い陸は返ってこないことにする[m]
const ECHO_SCAN_S = 1.5;             // 見直す間隔[秒]
const _echo = { ctx: null, taps: [], lastScan: -99, lastPan: -99, on: true };
try { _echo.on = localStorage.getItem('susuru_horn_echo') !== '0'; } catch (e) { /* ignore */ }

function setHornEcho(on) {
    _echo.on = !!on;
    try { localStorage.setItem('susuru_horn_echo', _echo.on ? '1' : '0'); } catch (e) { /* ignore */ }
    if (!_echo.on) _echoSilence();
}
window.setHornEcho = setHornEcho;

function _echoBuild() {
    const c = audio.ctx;
    if (!c || !audio.buses || !audio.buses.horn) return false;
    // 汽笛を初めて鳴らして減衰前の音（audio.hornDry）ができたら、そちらにつなぎ直す
    if (_echo.ctx === c && !(audio.hornDry && _echo.src !== 'dry')) return true;
    if (_echo.ctx === c) { try { audio.buses.horn.disconnect(_echo.input); } catch (e) { /* ignore */ } for (const T of _echo.taps) { try { T.g.disconnect(); if (T.pan) T.pan.disconnect(); } catch (e) { /* ignore */ } } }
    _echo.ctx = c;
    _echo.input = c.createGain();
    // 聞く所までの減衰の前の汽笛（36-horns.js の audio.hornDry）。無ければ、今まで通り汽笛の音の出口から
    (audio.hornDry || audio.buses.horn).connect(_echo.input);
    _echo.src = audio.hornDry ? 'dry' : 'bus';
    _echo.taps = [];
    const maxDelay = ECHO_MAX_R * 3 / AUDIO_SPEED_OF_SOUND + 1;
    for (let i = 0; i < ECHO_TAPS; i++) {
        const d = c.createDelay(maxDelay);
        const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2500; lp.Q.value = 0.5;
        const g = c.createGain(); g.gain.value = 0;
        // 崖や建物でばらけて返る分：少し遅れた小さい 2 つ目
        const d2 = c.createDelay(1); d2.delayTime.value = 0.12 + 0.07 * i;
        const g2 = c.createGain(); g2.gain.value = 0.45;
        const pan = c.createStereoPanner ? c.createStereoPanner() : null;
        _echo.input.connect(d); d.connect(lp);
        lp.connect(g); lp.connect(d2); d2.connect(g2); g2.connect(g);
        // 出口は汽笛の音の出口（汽笛の音量の設定が効くように）。入口が 'bus' のときは、回り込まないよう今まで通り
        const out = _echo.src === 'dry' ? audio.buses.horn : audio.muffle;
        if (pan) { g.connect(pan); pan.connect(out); } else g.connect(out);
        _echo.taps.push({ d, lp, g, pan, delay: 0, dir: 0, active: false });
    }
    return true;
}

function _echoSilence() {
    if (!_echo.ctx) return;
    const now = _echo.ctx.currentTime;
    for (const T of _echo.taps) { T.g.gain.setTargetAtTime(0, now, 0.3); T.active = false; }
}

// 近くの格子の高さ（44-world-terrain.js の terrain.nearH）から、その点の高さ[m]
function _echoHeight(G, x, z) {
    const step = G.half * 2 / (G.n - 1);
    const fx = (x - (G.cx - G.half)) / step, fz = (z - (G.cz - G.half)) / step;
    if (fx < 0 || fz < 0 || fx >= G.n - 1 || fz >= G.n - 1) return -100;
    const i = Math.floor(fx), j = Math.floor(fz), a = fx - i, b = fz - j, n = G.n, H = G.H;
    const h00 = H[j * n + i], h10 = H[j * n + i + 1], h01 = H[(j + 1) * n + i], h11 = H[(j + 1) * n + i + 1];
    return (h00 * (1 - a) + h10 * a) * (1 - b) + (h01 * (1 - a) + h11 * a) * b;
}

function _echoScan() {
    const G = window.terrain && terrain.nearH;
    if (!G) return [];
    const sx = physics.cgWorldX || 0, sz = physics.cgWorldZ || 0;
    const hits = [];
    for (let k = 0; k < ECHO_DIRS; k++) {
        const ang = k / ECHO_DIRS * Math.PI * 2, dx = Math.sin(ang), dz = Math.cos(ang);
        let r = 60, found = false;
        for (; r < ECHO_MAX_R; r += 40) { if (_echoHeight(G, sx + dx * r, sz + dz * r) > 2) { found = true; break; } }
        if (!found) continue;
        // 返す面の高さ：陸に入ってから 300m の間でいちばん高い所
        let top = 0;
        for (let q = 0; q <= 300; q += 50) top = Math.max(top, _echoHeight(G, sx + dx * (r + q), sz + dz * (r + q)));
        const refl = Math.min(1, (top + 8) / 50) * 0.5;               // 崖・岸の返しやすさ（高いほど）
        const s = refl * 2 * 350 / (350 + r);
        hits.push({ ang, dx, dz, r, s, refl });
    }
    // 強いものから、向きが近すぎないように選ぶ
    hits.sort((a, b) => b.s - a.s);
    const pick = [];
    for (const h of hits) {
        if (pick.length >= ECHO_TAPS) break;
        if (pick.some(p => Math.abs(Math.atan2(Math.sin(p.ang - h.ang), Math.cos(p.ang - h.ang))) < 0.7)) continue;
        pick.push(h);
    }
    return pick;
}

function _echoPan(T) {
    if (!T.pan || typeof camera === 'undefined') return;
    audio._camRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
    const p = (T.dx * audio._camRight.x + T.dz * audio._camRight.z) * 0.8;
    T.pan.pan.setTargetAtTime(p, _echo.ctx.currentTime, 0.1);
}

function updateHornEcho(t) {
    if (!audio.ctx) return;
    const active = _echo.on && window.world && world.mode === 'world' && window.terrain && terrain.nearH;
    if (!active) { if (_echo.ctx && _echo.taps.some(T => T.active)) _echoSilence(); return; }
    if (!_echoBuild()) return;
    const c = _echo.ctx, now = c.currentTime;
    if (t - _echo.lastScan > ECHO_SCAN_S || t < _echo.lastScan) {
        _echo.lastScan = t;
        const pick = _echoScan();
        _echo.taps.forEach((T, i) => {
            const h = pick[i];
            if (!h) { if (T.active) T.g.gain.setTargetAtTime(0, now, 0.3); T.active = false; return; }
            // 道のり：汽笛 → 崖 → 聞く所（視点）
            const wx = (physics.cgWorldX || 0) + h.dx * h.r, wz = (physics.cgWorldZ || 0) + h.dz * h.r;
            const cam = (typeof camera !== 'undefined' && camera) ? camera.position : null;
            const back = cam ? Math.hypot(cam.x - wx, cam.z - wz) : h.r;
            const L = h.r + back;
            const delay = L / AUDIO_SPEED_OF_SOUND;
            // 汽笛そのものと同じ減衰（60m より先は距離に反比例）× 空気に吸われる分 × 崖の返しやすさ。
            // こだまは聞き分けやすいので少し持ち上げる（×6）。汽笛の音は 'dry' では聞く所までの減衰の前なので、この値がそのまま効く
            const spread = 60 / (60 + Math.max(0, L - 60)), air = Math.exp(-L / 9000);
            const gain = _echo.src === 'dry' ? Math.min(0.5, 6 * h.refl * spread * air) : Math.min(0.45, 2.2 * h.s);
            h.L = L;
            if (!T.active || Math.abs(delay - T.delay) > 0.25) {
                // 別の所からの反射に替わる：いったん消して、遅れを合わせてから戻す（音程が滑らないように）
                T.g.gain.setTargetAtTime(0, now, 0.05);
                T.d.delayTime.setValueAtTime(delay, now + 0.3);
                T.g.gain.setTargetAtTime(gain, now + 0.35, 0.2);
            } else {
                // 船が動いた分だけ少しずつ（こだまのドップラーになる）
                T.d.delayTime.setTargetAtTime(delay, now, 0.5);
                T.g.gain.setTargetAtTime(gain, now, 0.3);
            }
            T.lp.frequency.setTargetAtTime(600 + 3400 * Math.exp(-(h.L || 2 * h.r) / 5000), now, 0.3);
            T.delay = delay; T.dx = h.dx; T.dz = h.dz; T.active = true;
            _echoPan(T);
        });
    } else if (t - _echo.lastPan > 0.25) {
        _echo.lastPan = t;
        for (const T of _echo.taps) if (T.active) _echoPan(T);
    }
}
window.updateHornEcho = updateHornEcho;

document.addEventListener('DOMContentLoaded', () => { const cb = document.getElementById('horn-echo'); if (cb) cb.checked = _echo.on; });
