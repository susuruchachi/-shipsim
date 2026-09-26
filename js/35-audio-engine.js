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
    settings: { enabled: true, master: 0.8, horn: 1.0, engine: 0.7, env: 0.7 },
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
    audio.engine = null; audio.engineType = null; audio.lastT = -1;
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

    for (const k of ['horn', 'engine', 'env']) {
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
    }
    update(worldPos, extraGain = 1) {
        if (typeof camera === 'undefined' || !camera) return;
        const c = audio.ctx, now = c.currentTime;
        const rel = audio._tmp.subVectors(worldPos, camera.position);
        const d = Math.max(0.5, rel.length());
        const g = this.ref / (this.ref + this.rolloff * Math.max(0, d - this.ref)) * extraGain;
        const delay = Math.min(AUDIO_MAX_DELAY, d / AUDIO_SPEED_OF_SOUND);
        const cutoff = Math.max(500, Math.min(18000, 18000 * Math.exp(-d / 2200)));
        const tc = this._first ? 0.001 : 0.08;
        this._first = false;
        this.gain.gain.setTargetAtTime(g, now, 0.05);
        this.delay.delayTime.setTargetAtTime(delay, now, tc);
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
function _audioPulseWave(n) {
    const c = audio.ctx;
    const real = new Float32Array(n + 1), imag = new Float32Array(n + 1);
    for (let k = 1; k <= n; k++) real[k] = (n - k + 1) / n;   // なめらかな（リンギングの無い）パルス
    return c.createPeriodicWave(real, imag);
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
    audioNoiseSource('white').connect(_mkFilter('highpass', 2500, 0.5, E.rainGain));
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

// 雷鳴：距離[m]から音が届くまで遅れて鳴る（29-weather-fx.js の落雷から呼ぶ）
function audioThunder(dist, power, hasBolt) {
    if (!audio.ctx || (audio.ctx.state !== 'running' && !_audioOffline()) || !audio.env) return;
    const delay = Math.min(8, dist / AUDIO_SPEED_OF_SOUND);
    const near = Math.max(0, 1 - dist / 1500);
    const vol = (0.35 + 0.65 * near) * (0.6 + 0.4 * (power || 1));
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
        // 船首が波に突っ込んだ（17-main-loop.js のスラム判定）
        const slam = window._bowSlamCount || 0;
        if (slam > audio.lastSlam) {
            const bow = audioShipPoint(0, 0, half, new THREE.Vector3());
            const d = bow.distanceTo(cam);
            const g = 1 / (1 + Math.max(0, d - 30) / 60);
            audioBurst(E.outdoor, { when: Math.min(2, d / AUDIO_SPEED_OF_SOUND), dur: 0.6, attack: 0.01, gain: 0.45 * g, type: 'lowpass', freq: 160, q: 0.7, kind: 'brown' });
            audioBurst(E.outdoor, { when: Math.min(2, d / AUDIO_SPEED_OF_SOUND) + 0.05, dur: 1.2, attack: 0.04, gain: 0.35 * g, type: 'bandpass', freq: 900, q: 0.5 });
        }
        audio.lastSlam = slam;
    }

    // ── 雨 ──
    const rain = on ? (w.rain || 0) : 0;
    E.rainGain.gain.setTargetAtTime(0.18 * rain, now, 0.4);
    E.roofGain.gain.setTargetAtTime(0.35 * rain * indoor, now, 0.4);

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

function _audioDisposeEngine() {
    const N = audio.engine;
    if (!N) return;
    for (const n of N.nodes) { try { if (n.stop) n.stop(); } catch (e) { /* ignore */ } try { n.disconnect(); } catch (e) { /* ignore */ } }
    if (N.em) N.em.disconnect();
    audio.engine = null;
}

function _audioBuildEngine(type) {
    _audioDisposeEngine();
    audio.engineType = type;
    if (!type || type === 'none' || !ENGINE_TYPES[type]) return;
    const c = audio.ctx;
    const nodes = [];
    const keep = (n) => { nodes.push(n); return n; };
    const em = new AudioEmitter(audio.buses.engine, 30, 1);
    const out = keep(_mkGain(1, em.input));
    const N = { type, em, out, nodes, p: {} };
    const noise = (k) => keep(audioNoiseSource(k));

    // どの形式にも：補機・ボイラーの連続音（止まっていても鳴る）
    N.p.aux = keep(_mkGain(0.02, out));
    noise('white').connect(keep(_mkFilter('highpass', 2500, 0.5, N.p.aux)));
    N.p.hum = keep(_mkGain(0.03, out));
    keep(_mkOsc('sine', 60, N.p.hum));

    if (type === 'steam_recip' || type === 'combined') {
        // 「シュッ・ドッ」：ピストンの往復ごとの蒸気の出入りと、クランクの振動
        N.p.beat = keep(_mkOsc('sine', 1, null));
        N.p.beat.setPeriodicWave(_audioPulseWave(10));
        N.p.chuff = keep(_mkGain(0, out));
        noise('white').connect(keep(_mkFilter('bandpass', 260, 0.9, N.p.chuff)));
        N.p.thump = keep(_mkGain(0, out));
        keep(_mkOsc('sine', 46, N.p.thump));
        N.p.beatDepthC = keep(_mkGain(0, N.p.chuff.gain));
        N.p.beatDepthT = keep(_mkGain(0, N.p.thump.gain));
        N.p.beat.connect(N.p.beatDepthC); N.p.beat.connect(N.p.beatDepthT);
        // 弁やクロスヘッドの「カチャ」（1回転に2回）
        N.p.clankOsc = keep(_mkOsc('sine', 1, null));
        N.p.clankOsc.setPeriodicWave(_audioPulseWave(24));
        N.p.clank = keep(_mkGain(0, out));
        noise('white').connect(keep(_mkFilter('bandpass', 2200, 3, N.p.clank)));
        N.p.clankDepth = keep(_mkGain(0, N.p.clank.gain));
        N.p.clankOsc.connect(N.p.clankDepth);
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
        keep(_mkOsc('sine', 38, N.p.thump));
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
    audio.engine = N;
}

function _audioUpdateEngine(t, dt) {
    const type = (typeof shipSound !== 'undefined' && shipSound.engine) ? shipSound.engine.type : 'steam_recip';
    if (type !== audio.engineType) _audioBuildEngine(type);
    const N = audio.engine;
    if (!N) return;
    const now = audio.ctx.currentTime;
    const T = ENGINE_TYPES[type];
    const r = Math.min(1, Math.abs(physics.propRpm || 0));
    const slip = (typeof getPropSlip === 'function') ? getPropSlip() : 0;
    const load = Math.min(1, r * (0.6 + 0.8 * slip));             // 加速・逆転中ほど苦しそうに
    const run = (T.idle || 0) + (1 - (T.idle || 0)) * r;           // 機関の回転（アイドリング込み）
    const revHz = (T.maxRpm || 60) / 60 * run;
    const set = (param, v, tc = 0.15) => param.setTargetAtTime(v, now, tc);
    const vol = (shipSound && shipSound.engine && Number.isFinite(shipSound.engine.volume)) ? shipSound.engine.volume : 1;

    // 機関室の位置（煙突の下あたり、船体の中）。船内にいると大きく聞こえる
    const indoor = window.shelterIndoor || 0;
    const ep = (typeof shipSound !== 'undefined' && shipSound.enginePos) ? shipSound.enginePos : { x: 0, y: 0, z: 0 };
    N.em.update(audioShipPoint(ep.x, ep.y, ep.z, audio._tmpE || (audio._tmpE = new THREE.Vector3())), vol * (0.35 + 0.65 * indoor));

    set(N.p.aux.gain, type === 'electric' ? 0.004 : 0.02 + 0.02 * r);
    set(N.p.hum.gain, 0.025 + 0.03 * run);

    if (N.p.chuff) {
        const beats = revHz * (T.beatsPerRev || 6);
        set(N.p.beat.frequency, Math.max(0.01, beats), 0.3);
        set(N.p.clankOsc.frequency, Math.max(0.01, revHz * 2), 0.3);
        const on = r > 0.01 ? 1 : 0;
        // パルスは短いので、深さは大きめに取る（1拍ごとの「シュッ・ドッ」をはっきり）
        set(N.p.beatDepthC.gain, on * (0.5 + 1.1 * load));
        set(N.p.beatDepthT.gain, on * (0.5 + 0.7 * load));
        set(N.p.clankDepth.gain, on * 0.18 * (0.4 + r));
        // 拍の合間も、蒸気の流れる音が低く続く
        set(N.p.chuff.gain, on * 0.04 * (0.3 + r));
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
