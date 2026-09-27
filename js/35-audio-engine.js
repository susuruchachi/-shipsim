// 35-audio-engine.js — 音の土台（Web Audio）と、機関音・環境音
//
// ════════════════════════════════════════════════════════════════
//  方針：音はすべてその場で合成する（音声ファイルを使わない）
// ════════════════════════════════════════════════════════════════
//  ・ファイルが要らないので、アプリが軽いまま・電波が無くても鳴る
//  ・回転数・風速・波の高さ・雨量などに合わせて、音色を連続的に変えられる
//
//  音の流れ：
//    各音源 → [位置の効果] → 種類ごとの音量(汽笛/機関/環境) → 水中のこもり → 全体音量 → 音割れ防止 → スピーカー
//  「位置の効果」（Emitter）は、音源とカメラの位置関係から
//    ・距離による減衰
//    ・左右の定位
//    ・遠くほど高音が減る（空気による吸収。遠くの汽笛がまろやかに聞こえる）
//    ・音が届くまでの遅れ（音速343m/s）。カメラや船が動くと、遅れの変化で
//      音の高さが自然に変わる（ドップラー効果）
//  をまとめて付ける。
//
//  iPhone/iPad では、画面に一度触れるまで音を出せない（ブラウザの決まり）。
//  最初のタップ／キー入力で音の仕組みを起動する。消音スイッチがONだと
//  鳴らないことがある。

const audio = {
    ctx: null,
    master: null, comp: null, muffle: null,
    buses: {},
    noise: null, brown: null,
    settings: { enabled: true, master: 0.8, horn: 1.0, engine: 0.7, env: 0.7, bridge: 0.8 },
    env: null, engine: null, engineType: null,
    lastT: -1, lastSlam: 0,
    _camRight: new THREE.Vector3(), _tmp: new THREE.Vector3(),
};
window.shipAudio = audio;

const AUDIO_SPEED_OF_SOUND = 343;
const AUDIO_MAX_DELAY = 6.0;     // これより遠い音の遅れは打ち切る[秒]

// 端末ごとの音量設定（船の設定とは別に保存）
(function restoreAudioSettings() {
    try {
        const s = JSON.parse(localStorage.getItem('susuru_audio') || 'null');
        if (s) Object.assign(audio.settings, s);
    } catch (e) { /* ignore */ }
})();
function saveAudioSettings() {
    try { localStorage.setItem('susuru_audio', JSON.stringify(audio.settings)); } catch (e) { /* ignore */ }
}

// ── 起動 ───────────────────────────────────────────────────────
// オフライン（書き出し用）の音の経路か。オフラインでは一時停止・再開をしない
function _audioOffline() { return !!(audio.ctx && typeof audio.ctx.startRendering === 'function'); }

function audioEnsure() {
    if (audio.ctx) {
        if (!_audioOffline() && audio.ctx.state === 'suspended' && audio.settings.enabled && document.visibilityState === 'visible') audio.ctx.resume();
        return audio.ctx;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    return _audioSetupGraph(new AC());
}

// 音の経路を組み立てる（オフラインでの書き出し・確認にも使えるよう分けてある）
function _audioSetupGraph(c) {
    audio.ctx = c;
    audio.engines = []; audio.lastT = -1;   // 機関音（複数。36-horns.js の shipSound.engines と同じ並び）
    // 前の経路の汽笛の音源は使えないので捨てる（36-horns.js）
    if (typeof _hornRuntime !== 'undefined') _hornRuntime.length = 0;

    audio.comp = c.createDynamicsCompressor();
    audio.comp.threshold.value = -10;
    audio.comp.knee.value = 8;
    audio.comp.ratio.value = 6;
    audio.comp.attack.value = 0.005;
    audio.comp.release.value = 0.25;
    audio.comp.connect(c.destination);

    audio.master = c.createGain();
    audio.master.connect(audio.comp);
    // 水中のこもり（水中表現と連動）
    audio.muffle = c.createBiquadFilter();
    audio.muffle.type = 'lowpass';
    audio.muffle.frequency.value = 20000;
    audio.muffle.Q.value = 0.5;
    audio.muffle.connect(audio.master);

    for (const k of ['horn', 'engine', 'env', 'bridge']) {
        const g = c.createGain();
        g.connect(audio.muffle);
        audio.buses[k] = g;
    }
    audio.noise = _audioNoiseBuffer(c, 'white');
    audio.brown = _audioNoiseBuffer(c, 'brown');
    applyAudioVolumes();
    _audioBuildEnv();
    return c;
}

function _audioNoiseBuffer(c, kind) {
    const len = Math.floor(c.sampleRate * 3);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        if (kind === 'brown') { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
        else d[i] = w;
    }
    return buf;
}

// ループするノイズ音源（開始位置をずらして、重ねても同じ波形にならないように）
function audioNoiseSource(kind) {
    const c = audio.ctx;
    const s = c.createBufferSource();
    s.buffer = kind === 'brown' ? audio.brown : audio.noise;
    s.loop = true;
    s.start(0, Math.random() * 2.5);
    return s;
}

function applyAudioVolumes() {
    if (!audio.ctx) return;
    const S = audio.settings, now = audio.ctx.currentTime;
    audio.master.gain.setTargetAtTime(S.enabled ? S.master : 0, now, 0.05);
    audio.buses.horn.gain.setTargetAtTime(S.horn, now, 0.05);
    audio.buses.engine.gain.setTargetAtTime(S.engine, now, 0.05);
    audio.buses.env.gain.setTargetAtTime(S.env, now, 0.05);
    audio.buses.bridge.gain.setTargetAtTime(S.bridge != null ? S.bridge : 0.8, now, 0.05);   // テレグラフのベルなど（37-bridge-controls.js）
    if (_audioOffline()) return;
    if (!S.enabled && audio.ctx.state === 'running') audio.ctx.suspend();
    if (S.enabled && audio.ctx.state === 'suspended' && document.visibilityState === 'visible') audio.ctx.resume();
}
function setAudioSetting(key, value) {
    audio.settings[key] = (key === 'enabled') ? !!value : Math.max(0, Math.min(1.5, parseFloat(value) || 0));
    saveAudioSettings();
    if (key === 'enabled' && value) audioEnsure();
    applyAudioVolumes();
}

// 最初の操作で起動する（ブラウザの自動再生の決まりのため）
['pointerdown', 'touchstart', 'keydown'].forEach((ev) => {
    window.addEventListener(ev, () => { if (audio.settings.enabled) audioEnsure(); }, { passive: true, capture: true });
});
// バックグラウンドでは止める（電池のため）
document.addEventListener('visibilitychange', () => {
    if (!audio.ctx || _audioOffline()) return;
    if (document.visibilityState === 'visible') { if (audio.settings.enabled) audio.ctx.resume(); }
    else audio.ctx.suspend();
});

// ── 位置の効果（距離・左右・空気の吸収・音の遅れ）────────────────
class AudioEmitter {
    // ref: この距離[m]までは減衰しない。rolloff: 減衰の強さ
    constructor(dest, ref = 20, rolloff = 1) {
        const c = audio.ctx;
        this.ref = ref; this.rolloff = rolloff;
        this.input = c.createGain();
        this.delay = c.createDelay(AUDIO_MAX_DELAY + 0.5);
        this.lp = c.createBiquadFilter();
        this.lp.type = 'lowpass';
        this.lp.frequency.value = 18000;
        this.lp.Q.value = 0.4;
        this.gain = c.createGain();
        this.pan = c.createStereoPanner ? c.createStereoPanner() : null;
        this.input.connect(this.delay);
        this.delay.connect(this.lp);
        this.lp.connect(this.gain);
        if (this.pan) { this.gain.connect(this.pan); this.pan.connect(dest); }
        else this.gain.connect(dest);
        this._first = true;
        this._delay = 0; this._lastNow = 0;
    }
    update(worldPos, extraGain = 1) {
        if (typeof camera === 'undefined' || !camera) return;
        const c = audio.ctx, now = c.currentTime;
        const rel = audio._tmp.subVectors(worldPos, camera.position);
        const d = Math.max(0.5, rel.length());
        const g = this.ref / (this.ref + this.rolloff * Math.max(0, d - this.ref)) * extraGain;
        const delay = Math.min(AUDIO_MAX_DELAY, d / AUDIO_SPEED_OF_SOUND);
        const cutoff = Math.max(500, Math.min(18000, 18000 * Math.exp(-d / 2200)));
        // 音の遅れ：変化の速さを抑える。遅れが変わる速さがそのまま音程の変化
        // （ドップラー効果）になるので、視点を勢いよく動かしたときに音程が
        // 大きく揺れないよう、音程の変化を約1.5%までに抑える。視点を別の場所へ
        // 一瞬で移したとき（大きな差）は、追いかけずにその場で合わせる。
        const step = this._first ? 0 : Math.max(0, now - this._lastNow);
        this._lastNow = now;
        if (this._first || Math.abs(delay - this._delay) > 0.8) this._delay = delay;
        else {
            const lim = 0.015 * step;
            this._delay += Math.max(-lim, Math.min(lim, delay - this._delay));
        }
        const tc = this._first ? 0.001 : 0.05;
        this._first = false;
        this.gain.gain.setTargetAtTime(g, now, 0.05);
        this.delay.delayTime.setTargetAtTime(this._delay, now, tc);
        this.lp.frequency.setTargetAtTime(cutoff, now, 0.1);
        if (this.pan) {
            audio._camRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
            const p = rel.normalize().dot(audio._camRight) * 0.85;
            this.pan.pan.setTargetAtTime(p, now, 0.05);
        }
    }
    disconnect() { try { (this.pan || this.gain).disconnect(); } catch (e) { /* ignore */ } }
}

// 船の座標（shipGroup のローカル座標）→ ワールド座標
function audioShipPoint(x, y, z, out) {
    out = out || new THREE.Vector3();
    out.set(x, y, z);
    if (typeof shipGroup !== 'undefined' && shipGroup) { shipGroup.updateWorldMatrix(true, false); out.applyMatrix4(shipGroup.matrixWorld); }
    return out;
}

// 狭いパルスの周期波形（リズムのある音の「ドッ・ドッ」を作るのに使う）
// phase：1周期のうち、どれだけ遅らせるか（0〜1）。n が小さいほど幅の広いパルス
function _audioPulseWave(n, phase = 0) {
    const c = audio.ctx;
    const real = new Float32Array(n + 1), imag = new Float32Array(n + 1);
    for (let k = 1; k <= n; k++) {
        const a = (n - k + 1) / n;   // なめらかな（リンギングの無い）パルス
        real[k] = a * Math.cos(2 * Math.PI * k * phase);
        imag[k] = a * Math.sin(2 * Math.PI * k * phase);
    }
    return c.createPeriodicWave(real, imag);
}
// 低音を小さなスピーカーでも感じられるよう、倍音を足す歪み
function _audioSat(amount, dest) {
    const ws = audio.ctx.createWaveShaper();
    const n = 1024, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; curve[i] = Math.tanh(x * amount) / Math.tanh(amount); }
    ws.curve = curve;
    if (dest) ws.connect(dest);
    return ws;
}

function _mkGain(v, dest) { const g = audio.ctx.createGain(); g.gain.value = v; if (dest) g.connect(dest); return g; }
function _mkFilter(type, f, q, dest) {
    const b = audio.ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; if (q != null) b.Q.value = q;
    if (dest) b.connect(dest); return b;
}
function _mkOsc(type, f, dest) {
    const o = audio.ctx.createOscillator(); o.type = type; o.frequency.value = f; if (dest) o.connect(dest); o.start(); return o;
}

// ════════════════════════════════════════════════════════════════
//  環境音：風・海・船首の波・雨・雷・波の打ち込み
// ════════════════════════════════════════════════════════════════
function _audioBuildEnv() {
    const c = audio.ctx, out = audio.buses.env;
    const E = {};
    // 室内では外の音がこもる
    E.outdoor = _mkFilter('lowpass', 18000, 0.5, out);

    // 風：帯域ノイズ（ゴーッ）＋リギングの鳴り（ヒュー）
    E.windGain = _mkGain(0, E.outdoor);
    E.windBp = _mkFilter('bandpass', 500, 0.6, E.windGain);
    audioNoiseSource('white').connect(E.windBp);
    E.windLow = _mkGain(0, E.outdoor);
    audioNoiseSource('brown').connect(_mkFilter('lowpass', 180, 0.7, E.windLow));
    E.whistleGain = _mkGain(0, E.outdoor);
    E.whistleBp = _mkFilter('bandpass', 1500, 9, E.whistleGain);
    audioNoiseSource('white').connect(E.whistleBp);

    // 海：うねりの「ザー」（低め）と、波がはじける「チャプ」（高め）
    E.seaGain = _mkGain(0, E.outdoor);
    audioNoiseSource('brown').connect(_mkFilter('lowpass', 520, 0.5, E.seaGain));
    E.seaHiss = _mkGain(0, E.outdoor);
    audioNoiseSource('white').connect(_mkFilter('bandpass', 1400, 0.5, E.seaHiss));

    // 船首の波切り・船尾の航跡（船に付いて動く音源）
    E.bowEm = new AudioEmitter(E.outdoor, 25, 1);
    E.bowGain = _mkGain(0, E.bowEm.input);
    audioNoiseSource('white').connect(_mkFilter('bandpass', 700, 0.6, E.bowGain));
    audioNoiseSource('brown').connect(_mkFilter('lowpass', 300, 0.5, E.bowGain));
    E.sternEm = new AudioEmitter(E.outdoor, 25, 1);
    E.sternGain = _mkGain(0, E.sternEm.input);
    audioNoiseSource('white').connect(_mkFilter('lowpass', 900, 0.5, E.sternGain));

    // 雨：屋外のザーッ、室内では屋根を打つ音（こもった音）
    E.rainGain = _mkGain(0, E.outdoor);
    // 高すぎる成分は耳に刺さるので削る（ザーッをやわらかく）
    audioNoiseSource('white').connect(_mkFilter('highpass', 2200, 0.5, _mkFilter('lowpass', 9000, 0.5, E.rainGain)));
    E.roofGain = _mkGain(0, out);
    audioNoiseSource('white').connect(_mkFilter('lowpass', 900, 0.7, _mkFilter('highpass', 150, 0.5, E.roofGain)));

    E.gust = 0; E.gustTarget = 0; E.gustNext = 0;
    E.lapNext = 0;
    audio.env = E;
}

// 短いノイズの一発音（波のチャプ・水しぶきなど）
function audioBurst(dest, { when = 0, dur = 0.4, attack = 0.01, gain = 0.3, type = 'bandpass', freq = 1000, q = 0.7, kind = 'white' } = {}) {
    const c = audio.ctx;
    const t0 = c.currentTime + when;
    const s = c.createBufferSource();
    s.buffer = kind === 'brown' ? audio.brown : audio.noise;
    const f = _mkFilter(type, freq, q);
    const g = c.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0005, t0 + attack + dur);
    s.connect(f); f.connect(g); g.connect(dest);
    s.start(t0, Math.random() * 2);
    s.stop(t0 + attack + dur + 0.05);
}

// ════════════════════════════════════════════════════════════════
//  大波がぶつかる音
// ════════════════════════════════════════════════════════════════
//  「ドーン」（船体に響く低い音）＋「ザバァーン」（砕ける水）＋しぶきが降る音。
//  船が大きく重いほど低く長く響き、波が高いほど大きい。
//    ・船首・船尾が波に叩きつけられたとき（21-bow-stern-effects.js のスラミング）
//    ・うねりが高いときは、ときどき大きな波が舷側に当たる
//  音はぶつかった場所から、距離に応じて遅れて・小さく・左右に振って聞こえる。
function _audioShipHeft() {
    const L = Math.max(5, (physics.scale || 1) * 12);          // 船の長さ[m]
    const size = Math.min(2, Math.max(0.1, L / 150));
    const m = Math.max(0.1, physics.mass || 1);
    const heavy = Math.min(1.25, Math.max(0.25, Math.log10(1 + m) / Math.log10(60)));
    return { size, heavy };
}
function audioWaveImpact(pos, strength) {
    if (!audio.ctx || !audio.env || strength <= 0.01) return;
    const c = audio.ctx, E = audio.env;
    const cam = camera.position;
    const d = pos.distanceTo(cam);
    const when = Math.min(2.5, d / AUDIO_SPEED_OF_SOUND);
    const g = strength / (1 + Math.max(0, d - 25) / 70);
    if (g < 0.01) return;
    // 左右の向き
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const dir = pos.clone().sub(cam).normalize();
    const pan = c.createStereoPanner ? c.createStereoPanner() : null;
    const dest = c.createGain();
    dest.gain.value = 1;
    if (pan) { pan.pan.value = Math.max(-0.9, Math.min(0.9, dir.dot(right))); dest.connect(pan); pan.connect(E.outdoor); }
    else dest.connect(E.outdoor);
    const { size, heavy } = _audioShipHeft();
    const t0 = c.currentTime + when;
    // 船体に響く「ドーン」：大きく重い船ほど低く長い
    const fr = 34 + 70 / (1 + 2.2 * size);
    const o = c.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(fr * 1.25, t0);
    o.frequency.exponentialRampToValueAtTime(fr, t0 + 0.25);
    const og = c.createGain();
    og.gain.setValueAtTime(0, t0);
    og.gain.linearRampToValueAtTime(0.5 * g * heavy, t0 + 0.02);
    og.gain.exponentialRampToValueAtTime(0.0005, t0 + 0.5 + 1.2 * size * heavy);
    o.connect(og); og.connect(_audioSat ? _audioSat(1.8, dest) : dest);
    o.start(t0); o.stop(t0 + 0.6 + 1.3 * size * heavy);
    audioBurst(dest, { when, dur: 0.8 + 1.6 * size * heavy, attack: 0.015, gain: 0.7 * g * (0.5 + 0.5 * heavy), type: 'lowpass', freq: 70 + 120 / (1 + size), q: 0.7, kind: 'brown' });
    // 砕ける水「ザバァーン」
    audioBurst(dest, { when: when + 0.03, dur: 1.1 + 0.9 * Math.min(1.5, strength), attack: 0.06, gain: 0.45 * g, type: 'bandpass', freq: 550 + 450 / (1 + size), q: 0.55 });
    audioBurst(dest, { when: when + 0.02, dur: 0.9, attack: 0.03, gain: 0.3 * g, type: 'lowpass', freq: 380, q: 0.5, kind: 'brown' });
    // 打ち上がったしぶきが降ってくる
    audioBurst(dest, { when: when + 0.35 + 0.2 * size, dur: 1.3 + 0.8 * strength, attack: 0.35, gain: 0.14 * g, type: 'highpass', freq: 2200, q: 0.5 });
    setTimeout(() => { try { dest.disconnect(); if (pan) pan.disconnect(); } catch (e) { /* ignore */ } }, (when + 6) * 1000);
}
window.audioWaveImpact = audioWaveImpact;

function _audioWaveImpacts(t, half) {
    const E = audio.env;
    const hs = Math.max(0, window._seaHs || 0);                 // 有義波高[m]
    const seaK = Math.min(1.6, Math.max(0.25, hs / 4));
    // 船首・船尾のスラミング
    const bowEv = window._bowSlamEvent, sternEv = window._sternSlamEvent;
    if (bowEv && bowEv !== E.lastBowEv) {
        E.lastBowEv = bowEv;
        E.lastBowImpactT = t;
        const k = Math.min(2, 0.5 + (bowEv.slamRatio || 0) * 0.6) * seaK;
        audioWaveImpact(audioShipPoint(0, 0, half * 0.92, new THREE.Vector3()), k);
    }
    if (sternEv && sternEv !== E.lastSternEv) {
        E.lastSternEv = sternEv;
        const k = Math.min(1.5, 0.4 + (sternEv.slamRatio || 0) * 0.45) * seaK;
        audioWaveImpact(audioShipPoint(0, 0, -half * 0.92, new THREE.Vector3()), k);
    }
    // 船首が波で持ち上がったあと、落ちて水面に打ち付けられる
    _audioBowDrop(t, half);
    // うねりが高いと、ときどき大きな波が舷側に当たる（波高1.5mくらいから）
    if (!E.sideNext) E.sideNext = t + 3;
    if (t > E.sideNext) {
        const rate = Math.max(0, hs - 1.5) * 0.18;               // 1秒あたりの回数（波高6mで約0.8回）
        E.sideNext = t + (rate > 0 ? (0.4 + Math.random() * 1.6) / rate : 3);
        if (rate > 0) {
            const side = Math.random() < 0.5 ? -1 : 1;
            const hp = window.hullProfile;
            const beam = (hp && hp.ready && hp.halfBeam) ? hp.halfBeam : half * 0.12;
            const p = audioShipPoint(side * beam, 0, (Math.random() * 1.6 - 0.8) * half, new THREE.Vector3());
            audioWaveImpact(p, seaK * (0.3 + 0.6 * Math.random()));
        }
    }
}

// 船首の高さ（水面から）を見張り、いつもより大きく持ち上がってから
// 勢いよく水面まで落ちたら「ドーン」と鳴らす（大波が当たる音と同じ音）。
// 強さは、どれだけ持ち上がったか・落ちる速さで決める（船の重さは audioWaveImpact 側で）。
function _audioBowDrop(t, half) {
    const E = audio.env;
    if (typeof getOceanHeight !== 'function') return;
    const bp = audioShipPoint(0, 0, half * 0.92, E._bowTmp || (E._bowTmp = new THREE.Vector3()));
    const rel = bp.y - getOceanHeight(bp.x, bp.z, t);
    if (E.bowRelT === undefined || t - E.bowRelT > 1) {
        E.bowRelT = t; E.bowRelPrev = rel; E.bowRelMean = rel; E.bowVel = 0; E.bowArmed = 0;
        return;
    }
    const dt = t - E.bowRelT;
    if (dt <= 0) return;
    E.bowRelT = t;
    E.bowVel += ((rel - E.bowRelPrev) / dt - E.bowVel) * Math.min(1, dt / 0.08);   // 上下の速さ（なめらかに）
    E.bowRelPrev = rel;
    E.bowRelMean += (rel - E.bowRelMean) * Math.min(1, dt / 20);                    // ふだんの高さ
    const hp = window.hullProfile;
    if (!hp || !hp.ready || !(hp.totalDraft > 0)) return;       // 船体を調べ終わるまで待つ
    const sy = (typeof shipGroup !== 'undefined' && shipGroup) ? Math.abs(shipGroup.scale.y) || 1 : 1;
    // 喫水[m]（喫水線からキールまで。totalDraft は船体の高さ全体なので使わない）
    const dl = (hp.designWaterlineY || 0) - (hp.keelY || 0);
    const draft = Math.max(0.3, (dl > 0 ? dl : hp.totalDraft * 0.3) * sy);
    const d = rel - E.bowRelMean;
    if (d > 0.3 * draft) E.bowArmed = Math.max(E.bowArmed || 0, d);
    if (E.bowArmed && d < 0.08 * draft) {
        const v = -E.bowVel;                       // 落ちる速さ[m/s]
        if (v > 0.8 && t - (E.lastBowImpactT || -9) > 1.2) {
            const k = Math.min(2, 0.3 + 0.5 * E.bowArmed / draft + v / 5);
            audioWaveImpact(bp.clone(), k);
            E.lastBowImpactT = t;
        }
        E.bowArmed = 0;
    }
}

// 雷鳴：距離[m]から音が届くまで遅れて鳴る（29-weather-fx.js の落雷から呼ぶ）
function audioThunder(dist, power, hasBolt) {
    if (!audio.ctx || (audio.ctx.state !== 'running' && !_audioOffline()) || !audio.env) return;
    const delay = Math.min(8, dist / AUDIO_SPEED_OF_SOUND);
    const near = Math.max(0, 1 - dist / 1500);
    const vol = 1.7 * (0.4 + 0.6 * near) * (0.6 + 0.4 * (power || 1));
    // 腹に響く低い「ドーン」（遠くても低音はよく届く）
    audioBurst(audio.env.outdoor, { when: delay + 0.05, dur: 3.5 + near * 2, attack: 0.15, gain: 0.9 * vol, type: 'lowpass', freq: 70 + near * 40, q: 0.7, kind: 'brown' });
    const dest = audio.env.outdoor;
    if (hasBolt && near > 0.3) {
        // 近い落雷は「バリッ」という裂ける音から始まる
        audioBurst(dest, { when: delay, dur: 0.35, attack: 0.003, gain: 0.5 * vol * near, type: 'highpass', freq: 1800, q: 0.5 });
    }
    // ゴロゴロ：低いノイズの山がいくつか重なって、長く尾を引く
    const n = 3 + Math.floor(Math.random() * 3);
    let t = delay + (hasBolt ? 0.05 : 0.2);
    for (let i = 0; i < n; i++) {
        audioBurst(dest, { when: t, dur: 1.5 + Math.random() * 2.5, attack: 0.08 + Math.random() * 0.25,
                           gain: vol * (0.9 - i * 0.12), type: 'lowpass', freq: 140 + Math.random() * 160 + near * 200, q: 0.5, kind: 'brown' });
        t += 0.25 + Math.random() * 0.7;
    }
}

function _audioUpdateEnv(t, dt) {
    const E = audio.env, c = audio.ctx, now = c.currentTime;
    const w = window.weather;
    const on = w && w.enabled;
    const indoor = window.shelterIndoor || 0;
    const under = window.underwaterAmount || 0;
    const cam = camera.position;

    // 室内：外の音をこもらせて小さく
    E.outdoor.frequency.setTargetAtTime(18000 * (1 - indoor) + 700 * indoor, now, 0.2);

    // ── 風 ──
    const windSpd = Math.max(0, physics.windSpeed || 0);   // m/s
    // 船の上（船の近く）では、船の速さぶんの向かい風も受ける
    let apparent = windSpd;
    if (typeof shipGroup !== 'undefined' && shipGroup && cam.distanceTo(shipGroup.position) < 12 * (physics.scale || 1)) {
        const wr = (physics.windDir || 0) * Math.PI / 180, hr = (physics.heading || 0) * Math.PI / 180;
        const wx = Math.sin(wr) * windSpd - Math.sin(hr) * (physics.speed || 0) * 0.514;
        const wz = Math.cos(wr) * windSpd - Math.cos(hr) * (physics.speed || 0) * 0.514;
        apparent = Math.sqrt(wx * wx + wz * wz);
    }
    // 突風：ときどき目標を変えて、なめらかに追いかける
    if (t > E.gustNext) { E.gustTarget = Math.random(); E.gustNext = t + 1.5 + Math.random() * 4; }
    E.gust += (E.gustTarget - E.gust) * (1 - Math.exp(-dt / 1.2));
    const wAmt = Math.min(1.4, apparent / 22) * (0.75 + 0.5 * E.gust);
    E.windGain.gain.setTargetAtTime(0.35 * wAmt * wAmt, now, 0.2);
    E.windLow.gain.setTargetAtTime(0.5 * wAmt * wAmt, now, 0.2);
    E.windBp.frequency.setTargetAtTime(350 + 700 * wAmt * (0.7 + 0.6 * E.gust), now, 0.3);
    const whistle = Math.max(0, wAmt - 0.45);
    E.whistleGain.gain.setTargetAtTime(0.05 * whistle * whistle, now, 0.3);
    E.whistleBp.frequency.setTargetAtTime(1100 + 1400 * E.gust + 500 * whistle, now, 0.4);

    // ── 海：水面に近いほど大きく、波が高いほど大きく ──
    const waterY = (typeof getOceanHeight === 'function') ? getOceanHeight(cam.x, cam.z, t) : 0;
    const height = Math.max(0, cam.y - waterY);
    const near = 1 / (1 + height / 25);
    const hs = Math.max(0.15, (window._seaHs || 0) || (physics.waveRoughness || 0.3));
    const seaAmt = Math.min(1.2, 0.25 + hs / 4);
    const swell = 0.75 + 0.25 * Math.sin(t * 2 * Math.PI / 9) * Math.sin(t * 2 * Math.PI / 13.7);
    E.seaGain.gain.setTargetAtTime(0.45 * seaAmt * (0.35 + 0.65 * near) * swell, now, 0.3);
    E.seaHiss.gain.setTargetAtTime(0.06 * seaAmt * near * swell, now, 0.3);
    // 波がはじける「チャプ」：水面の近くで、波が高いほど多く
    if (t > E.lapNext) {
        const rate = (0.4 + 2.5 * seaAmt) * near;
        E.lapNext = t + (0.2 + Math.random()) / Math.max(0.05, rate);
        if (near > 0.15 && under < 0.5) {
            audioBurst(E.outdoor, { dur: 0.25 + Math.random() * 0.5, attack: 0.02 + Math.random() * 0.05,
                gain: 0.12 * seaAmt * near * (0.4 + Math.random()), type: 'bandpass', freq: 500 + Math.random() * 1400, q: 0.8 });
        }
    }

    // ── 船首の波切り・船尾の航跡 ──
    if (typeof shipGroup !== 'undefined' && shipGroup) {
        const hp = window.hullProfile;
        const half = (hp && hp.ready) ? hp.halfLen : 6;
        const spd = Math.abs(physics.speed || 0);
        const maxS = Math.max(1, physics.maxSpeed || 20);
        const s = Math.min(1.2, spd / maxS);
        E.bowEm.update(audioShipPoint(0, 0, half * 0.95, audio._tmpA || (audio._tmpA = new THREE.Vector3())));
        E.bowGain.gain.setTargetAtTime(0.5 * Math.pow(s, 1.5), now, 0.3);
        const rpm = Math.abs(physics.propRpm || 0);
        E.sternEm.update(audioShipPoint(0, 0, -half * 0.95, audio._tmpB || (audio._tmpB = new THREE.Vector3())));
        E.sternGain.gain.setTargetAtTime(0.3 * rpm * (0.5 + 0.5 * s) + 0.15 * Math.pow(s, 1.5), now, 0.3);
        // 大波がぶつかる音（船首・船尾が波に叩きつけられた・大きな波が舷側に当たる）
        _audioWaveImpacts(t, half);
    }

    // ── 雨 ──
    const rain = on ? (w.rain || 0) : 0;
    // 他の環境音（海・風）より前に出ないくらいに
    E.rainGain.gain.setTargetAtTime(0.065 * rain, now, 0.4);
    E.roofGain.gain.setTargetAtTime(0.16 * rain * indoor, now, 0.4);

    // ── 水中：全体をこもらせる ──
    audio.muffle.frequency.setTargetAtTime(20000 * (1 - under) + 380 * under, now, 0.1);
}

// ════════════════════════════════════════════════════════════════
//  機関音（形式ごと）
// ════════════════════════════════════════════════════════════════
//  回転数は 32-engine-propeller.js の physics.propRpm（前進全速=1）。
//  実際の機関の回転数・シリンダー数から「ドッ・ドッ」の間隔や唸りの高さを
//  決める。止まっていても、ディーゼルはアイドリングし、蒸気船はボイラーの
//  シューという音だけが続く。
const ENGINE_TYPES = {
    steam_recip:   { label: '蒸気レシプロ（三段膨張）', maxRpm: 80,   idle: 0,    beatsPerRev: 6 },
    steam_turbine: { label: '蒸気タービン',             maxRpm: 3000, idle: 0.08 },
    combined:      { label: 'レシプロ＋タービン（混合式・オリンピック級）', maxRpm: 77, idle: 0, beatsPerRev: 6 },
    diesel_slow:   { label: 'ディーゼル（低速2ストローク・大型船）', maxRpm: 100, idle: 0.3, cylinders: 7 },
    diesel_medium: { label: 'ディーゼル（中速4ストローク）',        maxRpm: 750, idle: 0.45, cylinders: 8 },
    diesel_high:   { label: 'ディーゼル（高速・小型船）',           maxRpm: 1800, idle: 0.35, cylinders: 6 },
    gas_turbine:   { label: 'ガスタービン',             maxRpm: 3600, idle: 0.25 },
    electric:      { label: '電気推進（モーター）',     maxRpm: 150,  idle: 0 },
    none:          { label: 'なし（無音）' },
};
window.ENGINE_TYPES = ENGINE_TYPES;

function _audioDisposeEngine(N) {
    if (!N) return;
    for (const n of N.nodes) { try { if (n.stop) n.stop(); } catch (e) { /* ignore */ } try { n.disconnect(); } catch (e) { /* ignore */ } }
    if (N.em) N.em.disconnect();
    if (N.em2) N.em2.disconnect();
}

// 機関音1つぶんの音の仕組みを作る（形式が「なし」なら null）
function _audioBuildEngine(type) {
    if (!type || type === 'none' || !ENGINE_TYPES[type]) return null;
    const c = audio.ctx;
    const nodes = [];
    const keep = (n) => { nodes.push(n); return n; };
    const em = new AudioEmitter(audio.buses.engine, 30, 1);
    const out = keep(_mkGain(1, em.input));
    // シンメトリー配置：左右2か所の機関室から同じ音を出す（それぞれ半分の大きさ）
    const em2 = new AudioEmitter(audio.buses.engine, 30, 1);
    out.connect(em2.input);
    const N = { type, em, em2, out, nodes, p: {} };
    const noise = (k) => keep(audioNoiseSource(k));

    // どの形式にも：補機・ボイラーの連続音（止まっていても鳴る）
    N.p.aux = keep(_mkGain(0.02, out));
    noise('white').connect(keep(_mkFilter('highpass', 2500, 0.5, N.p.aux)));
    N.p.hum = keep(_mkGain(0.03, out));
    keep(_mkOsc('sine', 60, N.p.hum));
    // どの形式にも：船体を伝わる低い唸り（重さ）
    N.p.body = keep(_mkGain(0, out));
    const bodySat = keep(_audioSat(2.2, N.p.body));
    noise('brown').connect(keep(_mkFilter('lowpass', 110, 0.7, keep(_mkGain(1.6, bodySat)))));
    N.p.bodyOsc = keep(_mkOsc('sine', 34, keep(_mkGain(0.7, bodySat))));

    if (type === 'steam_recip' || type === 'combined') {
        // 「ガッシュン、ガッシュン」：クランクが回るたびの重い衝撃（ガッ）と、
        // 少し遅れて吐き出される蒸気（シュン）。1回転に2回。
        // 小さなスピーカーでも重さが伝わるよう、低音は歪ませて倍音を足す。
        N.p.beat = keep(_mkOsc('sine', 1, null));
        N.p.beat.setPeriodicWave(_audioPulseWave(16));                 // 衝撃：鋭いパルス
        N.p.exh = keep(_mkOsc('sine', 1, null));
        N.p.exh.setPeriodicWave(_audioPulseWave(5, 0.16));             // 排気：少し遅れた幅広いパルス
        N.p.thump = keep(_mkGain(0, out));
        const sat = keep(_audioSat(3.2, N.p.thump));
        keep(_mkOsc('sine', 41, keep(_mkGain(1, sat))));
        keep(_mkOsc('sine', 62, keep(_mkGain(0.6, sat))));
        noise('brown').connect(keep(_mkFilter('lowpass', 240, 0.8, keep(_mkGain(1.4, sat)))));
        N.p.chuff = keep(_mkGain(0, out));
        noise('white').connect(keep(_mkFilter('bandpass', 850, 0.6, N.p.chuff)));
        noise('brown').connect(keep(_mkFilter('bandpass', 320, 0.7, keep(_mkGain(1.5, N.p.chuff)))));
        N.p.beatDepthT = keep(_mkGain(0, N.p.thump.gain));
        N.p.beatDepthC = keep(_mkGain(0, N.p.chuff.gain));
        N.p.beat.connect(N.p.beatDepthT);
        N.p.exh.connect(N.p.beatDepthC);
        // 弁・クロスヘッドの金属音「カシャ」（衝撃と同時）
        N.p.clankOsc = N.p.beat;
        N.p.clank = keep(_mkGain(0, out));
        noise('white').connect(keep(_mkFilter('bandpass', 1300, 4, N.p.clank)));
        N.p.clankDepth = keep(_mkGain(0, N.p.clank.gain));
        N.p.beat.connect(N.p.clankDepth);
    }
    if (type === 'steam_turbine' || type === 'combined' || type === 'gas_turbine') {
        N.p.whine = keep(_mkGain(0, out));
        N.p.whineOsc = keep(_mkOsc('triangle', 200, N.p.whine));
        N.p.whine2 = keep(_mkGain(0, out));
        N.p.whineOsc2 = keep(_mkOsc('sine', 400, N.p.whine2));
        N.p.roar = keep(_mkGain(0, out));
        N.p.roarLp = keep(_mkFilter(type === 'gas_turbine' ? 'bandpass' : 'lowpass', 300, 0.5, N.p.roar));
        noise(type === 'gas_turbine' ? 'white' : 'brown').connect(N.p.roarLp);
        N.p.rumble = keep(_mkGain(0, out));
        keep(_mkOsc('sine', 31, N.p.rumble));
    }
    if (type === 'diesel_slow') {
        // 大型の2ストローク：1回転にシリンダー数だけ爆発する、ゆっくり重い「ドッドッドッ」
        N.p.beat = keep(_mkOsc('sine', 1, null));
        N.p.beat.setPeriodicWave(_audioPulseWave(14));
        N.p.thump = keep(_mkGain(0, out));
        keep(_mkOsc('sine', 38, keep(_audioSat(3, N.p.thump))));
        keep(_mkOsc('sine', 57, keep(_mkGain(0.5, keep(_audioSat(3, N.p.thump))))));
        N.p.knock = keep(_mkGain(0, out));
        noise('brown').connect(keep(_mkFilter('lowpass', 420, 0.8, N.p.knock)));
        N.p.beatDepthT = keep(_mkGain(0, N.p.thump.gain));
        N.p.beatDepthC = keep(_mkGain(0, N.p.knock.gain));
        N.p.beat.connect(N.p.beatDepthT); N.p.beat.connect(N.p.beatDepthC);
    }
    if (type === 'diesel_medium' || type === 'diesel_high') {
        // 中・高速ディーゼル：爆発の周期そのものが音の高さになる「ブォー」「ガラガラ」
        N.p.fire = keep(_mkGain(0, out));
        N.p.fireLp = keep(_mkFilter('lowpass', 300, 1.2, N.p.fire));
        N.p.fireOsc = keep(_mkOsc('sawtooth', 40, N.p.fireLp));
        N.p.fireOsc2 = keep(_mkOsc('square', 20, keep(_mkGain(0.35, N.p.fireLp))));
        // 爆発の半分の高さの低音（重さ）
        N.p.fireSub = keep(_mkOsc('sine', 20, keep(_mkGain(0.8, keep(_audioSat(2.5, N.p.fire))))));
        N.p.rattle = keep(_mkGain(0, out));
        noise('white').connect(keep(_mkFilter('bandpass', 1300, 1.5, N.p.rattle)));
        N.p.rattleAm = keep(_mkOsc('sine', 40, null));
        N.p.rattleAm.setPeriodicWave(_audioPulseWave(8));
        N.p.rattleDepth = keep(_mkGain(0, N.p.rattle.gain));
        N.p.rattleAm.connect(N.p.rattleDepth);
    }
    if (type.startsWith('diesel')) {
        // 過給機（ターボ）のヒューン
        N.p.turbo = keep(_mkGain(0, out));
        N.p.turboOsc = keep(_mkOsc('sine', 1500, N.p.turbo));
    }
    if (type === 'electric') {
        N.p.motor = keep(_mkGain(0, out));
        N.p.motorOsc = keep(_mkOsc('sine', 200, N.p.motor));
        N.p.motor2 = keep(_mkGain(0, out));
        N.p.motorOsc2 = keep(_mkOsc('triangle', 600, N.p.motor2));
    }
    return N;
}

// 機関音は複数置ける（例：レシプロ2基と中央のタービン、左右の機関室など）。
// どれも同じスクリューの回転数に合わせて鳴る
function _audioUpdateEngine(t, dt) {
    const list = (typeof shipSound !== 'undefined' && Array.isArray(shipSound.engines)) ? shipSound.engines : [];
    if (!audio.engines) audio.engines = [];
    // 数・形式が変わったものを作り直す
    for (let i = 0; i < Math.max(list.length, audio.engines.length); i++) {
        const t0 = list[i] ? list[i].type : null;
        const want = (t0 && t0 !== 'none' && ENGINE_TYPES[t0]) ? t0 : null;
        const N = audio.engines[i];
        if ((N ? N.type : null) !== want) {
            if (N) _audioDisposeEngine(N);
            audio.engines[i] = want ? _audioBuildEngine(want) : null;
        }
    }
    audio.engines.length = list.length;
    const r = Math.min(1, Math.abs(physics.propRpm || 0));
    const slip = (typeof getPropSlip === 'function') ? getPropSlip() : 0;
    const load = Math.min(1, r * (0.6 + 0.8 * slip));             // 加速・逆転中ほど苦しそうに
    // 機関終了（テレグラフの F.W.E.）の後は、アイドリングもゆっくり止まる
    const liveTarget = (physics.telegraphAnswerSpecial === 'fwe' && r < 0.02) ? 0 : 1;
    audio._engLive = (audio._engLive === undefined) ? liveTarget
        : audio._engLive + (liveTarget - audio._engLive) * Math.min(1, (dt || 0) / (liveTarget ? 3 : 6));
    const live = audio._engLive;
    list.forEach((E, i) => { const N = audio.engines[i]; if (N) _audioUpdateOneEngine(N, E, i, r, load, live); });
}

function _audioUpdateOneEngine(N, E, idx, r, load, live) {
    const now = audio.ctx.currentTime;
    const type = N.type;
    const T = ENGINE_TYPES[type];
    const run = (T.idle || 0) * live + (1 - (T.idle || 0)) * r;    // 機関の回転（アイドリング込み）
    const revHz = (T.maxRpm || 60) / 60 * run;
    const set = (param, v, tc = 0.15) => param.setTargetAtTime(v, now, tc);
    const vol = Number.isFinite(E.volume) ? E.volume : 1;

    // 機関室の位置（煙突の下あたり、船体の中）。船内にいると大きく聞こえる
    const indoor = window.shelterIndoor || 0;
    const ex = E.x || 0, ey = E.y || 0, ez = E.z || 0;
    const sym = !!(E.sym && Math.abs(ex) > 1e-3);
    const eg = vol * (0.55 + 0.45 * indoor) * (sym ? 0.5 : 1);
    N.em.update(audioShipPoint(ex, ey, ez, audio._tmpE || (audio._tmpE = new THREE.Vector3())), eg);
    N.em2.update(audioShipPoint(-ex, ey, ez, audio._tmpE2 || (audio._tmpE2 = new THREE.Vector3())), sym ? eg : 0);

    set(N.p.aux.gain, (type === 'electric' ? 0.004 : 0.02 + 0.02 * r) * (0.35 + 0.65 * live));   // 補機（発電機）は機関終了でも少し回る
    set(N.p.hum.gain, 0.025 + 0.03 * run);
    // 重さ：回転と負荷で強まる（電気推進は静か）
    const bodyAmt = type === 'electric' ? 0.25 : 1;
    set(N.p.body.gain, bodyAmt * (0.05 + 0.22 * run + 0.12 * load));
    set(N.p.bodyOsc.frequency, 26 + 16 * run, 0.5);

    if (N.p.chuff && N.p.exh) {
        const beats = revHz * 2;   // 1回転に「ガッシュン」2回
        set(N.p.beat.frequency, Math.max(0.01, beats), 0.3);
        set(N.p.exh.frequency, Math.max(0.01, beats), 0.3);
        const on = r > 0.01 ? 1 : 0;
        set(N.p.beatDepthT.gain, on * (0.7 + 0.9 * load));
        set(N.p.beatDepthC.gain, on * (0.35 + 0.6 * load));
        set(N.p.clankDepth.gain, on * 0.1 * (0.4 + r));
        set(N.p.chuff.gain, on * 0.02);
    }
    if (N.p.whine) {
        const gasT = type === 'gas_turbine';
        const tr = type === 'combined' ? r * 0.7 : run;   // 混合式は低速ではタービンがほぼ回らない
        set(N.p.whineOsc.frequency, (gasT ? 900 : 180) + (gasT ? 3200 : 1500) * tr, 0.5);
        set(N.p.whineOsc2.frequency, ((gasT ? 900 : 180) + (gasT ? 3200 : 1500) * tr) * 2.03, 0.5);
        set(N.p.whine.gain, (gasT ? 0.03 : 0.025) * tr);
        set(N.p.whine2.gain, 0.012 * tr);
        set(N.p.roarLp.frequency, (gasT ? 450 : 200) + 500 * tr, 0.4);
        set(N.p.roar.gain, (gasT ? 0.35 : 0.2) * (0.1 + tr));
        set(N.p.rumble.gain, 0.12 * tr);
    }
    if (type === 'diesel_slow') {
        const fire = revHz * (T.cylinders || 7);
        set(N.p.beat.frequency, Math.max(0.01, fire), 0.3);
        set(N.p.beatDepthT.gain, 0.25 + 0.3 * load);
        set(N.p.beatDepthC.gain, 0.12 + 0.3 * load);
    }
    if (N.p.fire) {
        const fire = revHz * (T.cylinders || 8) / 2;   // 4ストロークは2回転に1回爆発
        set(N.p.fireOsc.frequency, fire, 0.3);
        set(N.p.fireOsc2.frequency, fire / 2, 0.3);
        set(N.p.fireSub.frequency, fire / 2, 0.3);
        set(N.p.fireLp.frequency, 180 + 500 * load + fire * 2, 0.3);
        set(N.p.fire.gain, 0.12 + 0.2 * load);
        set(N.p.rattleAm.frequency, fire, 0.3);
        set(N.p.rattleDepth.gain, 0.03 + 0.06 * load);
    }
    if (N.p.turbo) {
        set(N.p.turboOsc.frequency, 900 + 3200 * load + 600 * run, 0.8);
        set(N.p.turbo.gain, 0.012 * Math.max(0, run - 0.2));
    }
    if (N.p.motor) {
        set(N.p.motorOsc.frequency, 90 + 700 * r, 0.3);
        set(N.p.motorOsc2.frequency, (90 + 700 * r) * 3, 0.3);
        set(N.p.motor.gain, 0.04 * r);
        set(N.p.motor2.gain, 0.01 * r);
    }
}

// 毎フレーム（描画の前）
function updateAudio(t) {
    if (!audio.ctx || (audio.ctx.state !== 'running' && !_audioOffline()) || typeof camera === 'undefined' || !camera) return;
    const dt = (audio.lastT < 0) ? 0 : Math.min(0.1, Math.max(0, t - audio.lastT));
    audio.lastT = t;
    try {
        _audioUpdateEnv(t, dt);
        _audioUpdateEngine(t, dt);
        if (typeof updateHorns === 'function') updateHorns(t, dt);
    } catch (e) {
        console.warn('[Audio]', e);
    }
}
