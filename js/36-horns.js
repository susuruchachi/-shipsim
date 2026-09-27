// 36-horns.js — 汽笛・ホーン・号鐘（種類・音階・数の制限なし）と信号
//
// ════════════════════════════════════════════════════════════════
//  汽笛の設定（船ごとに保存）
// ════════════════════════════════════════════════════════════════
//  shipSound.horns : [{ name, type, notes:['A3',...], volume, x, y, z, main }]
//    type  : HORN_TYPES のどれか
//    notes : 鳴らす音（音名＋オクターブ）。複数あれば和音（チャイム汽笛・
//            複数ラッパのエアホーンなど）。数の制限は無い
//    x,y,z : 船の座標（煙突と同じ座標系）。音はここから聞こえる
//    main  : 画面の 📯 ボタン／Hキー・信号で一緒に鳴らすか
//  shipSound.engine : { type, volume }（35-audio-engine.js の ENGINE_TYPES）
//
//  操作：
//    📯 ボタン・Hキー（押している間）… main の汽笛をまとめて鳴らす
//    1〜9キー（押している間）       … その番号の汽笛だけ鳴らす
//    設定の「信号」                  … 長音・短音の組み合わせを自動で吹鳴
//    自動の霧中信号・後進信号        … 設定でON/OFF
//
//  音はすべて合成で作る（35-audio-engine.js の方針）。汽笛らしさのために：
//    ・蒸気汽笛：吹き始めに音程が下からせり上がり（蒸気圧が上がる）、
//      息のような蒸気の音が混ざり、止めると音程が下がって消える
//    ・ダイアフォン：止めるときに低く「ウォー」と落ちる（霧笛のうなり）
//    ・サイレン：回転の上がり下がりで音程が滑る
//    ・号鐘・ゴング：打つ楽器なので、押している間くり返し打つ

const HORN_TYPES = {
    steam_single: { label: '蒸気汽笛（単音）',                      notes: ['C3'] },
    steam_chime:  { label: '蒸気汽笛（チャイム・和音／客船）',        notes: ['Ab2', 'C3', 'Eb3'] },
    steam_organ:  { label: '蒸気汽笛（オルガン管・太く低い）',        notes: ['F2'] },
    steam_bell:   { label: '蒸気汽笛（ベル型・明るく高め）',          notes: ['A3'] },
    tyfon:        { label: 'タイフォン（Tyfon・空気式ホーン）',       notes: ['D3'] },
    airhorn:      { label: 'エアホーン（トランペット・和音／現代船）', notes: ['A3', 'C#4', 'E4'] },
    diaphone:     { label: 'ダイアフォン（霧笛・うなり付き）',        notes: ['E2'] },
    nautophone:   { label: 'ノートフォン（電磁式霧笛）',              notes: ['G3'] },
    electric:     { label: '電気ホーン（振動板式）',                  notes: ['G4'] },
    siren:        { label: 'サイレン（モーター式）',                  notes: ['C5'] },
    bell:         { label: '号鐘（船鐘）',                            notes: ['C6'] },
    gong:         { label: 'ゴング（霧中号鐘・船尾）',                notes: ['C3'] },
};
window.HORN_TYPES = HORN_TYPES;

// 汽笛の長さ（秒）：短音・長音（海上衝突予防法：短音は約1秒、長音は4〜6秒）
const HORN_SHORT = 1.0, HORN_LONG = 5.0, HORN_GAP = 1.0;

let shipSound = _defaultShipSound();
window.shipSound = shipSound;
const _hornRuntime = [];   // 汽笛ごとの { em, out, voices, presses, strikeNext }

function _defaultShipSound() {
    return {
        horns: [_defaultHorn('steam_chime')],
        // 機関音は複数置ける（sym：左右対称の2か所から鳴らす。推進器のシンメトリーと同じ）
        engines: [_defaultEngine('steam_recip')],
    };
}
function _defaultEngine(type) {
    const T = (typeof ENGINE_TYPES !== 'undefined' && ENGINE_TYPES[type]) || { label: type };
    return { name: T.label.replace(/（.*$/, ''), type, volume: 1, x: 0, y: 0, z: 0, sym: false };
}
function _defaultHorn(type) {
    // 置き場所：いちばん前の煙突の前側の上（汽笛は煙突に付いていることが多い）
    let x = 0, y = 1.2, z = 1;
    if (typeof funnels !== 'undefined' && funnels && funnels.length) {
        const f = funnels.reduce((a, b) => (b.z > a.z ? b : a), funnels[0]);
        x = 0; y = +(f.y + (f.ry || 1) * 0.9).toFixed(2); z = +(f.z + (f.rx || 0.3) * 1.1).toFixed(2);
    }
    const T = HORN_TYPES[type] || HORN_TYPES.steam_chime;
    const fogType = type === 'diaphone' || type === 'nautophone' || type === 'bell' || type === 'gong';
    return { name: T.label.replace(/（.*$/, ''), type, notes: T.notes.slice(), volume: 1, x, y, z, main: !fogType, fog: fogType };
}

// ── 音名 ⇔ 周波数 ─────────────────────────────────────────────
const _NOTE_BASE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const _NOTE_JP = ['ド', 'ド♯', 'レ', 'レ♯', 'ミ', 'ファ', 'ファ♯', 'ソ', 'ソ♯', 'ラ', 'ラ♯', 'シ'];
const _NOTE_EN = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function noteToMidi(name) {
    const m = /^([A-Ga-g])([#b♯♭]?)(-?\d)$/.exec(String(name).trim());
    if (!m) return 69;
    let n = _NOTE_BASE[m[1].toUpperCase()];
    if (m[2] === '#' || m[2] === '♯') n++;
    if (m[2] === 'b' || m[2] === '♭') n--;
    return (parseInt(m[3], 10) + 1) * 12 + n;
}
function midiToNote(m) { return _NOTE_EN[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1); }
function noteToFreq(name) { return 440 * Math.pow(2, (noteToMidi(name) - 69) / 12); }
function _noteLabel(m) {
    const f = 440 * Math.pow(2, (m - 69) / 12);
    return `${_NOTE_JP[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}（${midiToNote(m)}・${f < 100 ? f.toFixed(1) : Math.round(f)}Hz）`;
}

// ════════════════════════════════════════════════════════════════
//  音色（1音ぶんの声）
// ════════════════════════════════════════════════════════════════
function _shaper(amount) {
    const ws = audio.ctx.createWaveShaper();
    const n = 1024, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; curve[i] = Math.tanh(x * amount) / Math.tanh(amount); }
    ws.curve = curve;
    return ws;
}
function _stopAll(nodes, when) { for (const n of nodes) { try { if (n.stop) n.stop(when); } catch (e) { /* ignore */ } } }

// 蒸気汽笛（単音・チャイム・オルガン・ベル型の共通）
function _voiceSteam(dest, f, v, variant) {
    const c = audio.ctx, t0 = c.currentTime;
    const nodes = [];
    const out = _mkGain(0, dest);
    const body = _mkGain(1, _shaperTo(out, variant === 'organ' ? 1.2 : 1.6));
    const detune = (Math.random() - 0.5) * 8;   // 1音ずつ僅かにずらして、和音にうなりを出す
    const harm = { single: [1, 0.35, 0.18, 0.07], chime: [1, 0.25, 0.12, 0.05], organ: [1, 0.12, 0.06, 0.02], bell: [1, 0.3, 0.28, 0.12] }[variant] || [1, 0.3, 0.15, 0.05];
    const oscs = [];
    const mk = (type, mul, g) => { const o = _mkOsc(type, f * mul, _mkGain(g, body)); o.detune.value = detune; oscs.push({ o, mul }); nodes.push(o); };
    mk('sine', 1, harm[0]);
    mk('triangle', 1.003, harm[1]);
    mk('sine', 2, harm[2]);
    mk('sine', 3, harm[3]);
    // 管の中を通る蒸気の「息」（音程のあるノイズ）
    const breathBp = _mkFilter('bandpass', f, variant === 'organ' ? 10 : 16, _mkGain(variant === 'chime' ? 0.7 : 0.9, body));
    const nb = audioNoiseSource('white'); nb.connect(breathBp); nodes.push(nb);
    // 吹き出しの「シュー」
    const hissG = _mkGain(0, out);
    const nh = audioNoiseSource('white'); nh.connect(_mkFilter('highpass', 3500, 0.6, hissG)); nodes.push(nh);
    // ゆらぎ（蒸気圧のむら）
    const vib = _mkOsc('sine', 5 + Math.random(), null); nodes.push(vib);
    const wob = _mkOsc('sine', 0.6 + Math.random() * 0.4, null); nodes.push(wob);
    const vibG = _mkGain(f * 0.003, null), wobG = _mkGain(f * 0.005, null);
    vib.connect(vibG); wob.connect(wobG);
    for (const { o, mul } of oscs) { vibG.connect(o.frequency); wobG.connect(o.frequency); }
    vibG.connect(breathBp.frequency);
    // 吹き始め：音程が下からせり上がる
    for (const { o, mul } of oscs) {
        o.frequency.setValueAtTime(f * mul * 0.84, t0);
        o.frequency.setTargetAtTime(f * mul, t0, 0.12);
    }
    breathBp.frequency.setValueAtTime(f * 0.84, t0);
    breathBp.frequency.setTargetAtTime(f, t0, 0.12);
    const attack = variant === 'organ' ? 0.12 : 0.07;
    out.gain.setValueAtTime(0, t0);
    out.gain.setTargetAtTime(v, t0, attack);
    hissG.gain.setValueAtTime(0.3 * v, t0);
    hissG.gain.setTargetAtTime(0.04 * v, t0 + 0.1, 0.2);
    return {
        stop(when) {
            when = Math.max(when, c.currentTime);
            // 弁が閉じると蒸気圧が落ちて、ほんの少し（半音の半分ほど）下がりながら
            // すぐに止む。以前は1割も下げてゆっくり消していたので「ゥオァ…」と
            // 下がって聞こえた。残るのは蒸気の「シュッ」だけ
            for (const { o, mul } of oscs) { o.frequency.cancelScheduledValues(when); o.frequency.setTargetAtTime(f * mul * 0.972, when, 0.07); }
            breathBp.frequency.cancelScheduledValues(when);
            breathBp.frequency.setTargetAtTime(f * 0.972, when, 0.07);
            out.gain.cancelScheduledValues(when);
            out.gain.setTargetAtTime(0, when, 0.075);
            hissG.gain.cancelScheduledValues(when);
            hissG.gain.setTargetAtTime(0.2 * v, when, 0.02);
            hissG.gain.setTargetAtTime(0, when + 0.15, 0.2);
            _stopAll(nodes, when + 1.5);
        },
    };
}
function _shaperTo(dest, amount) { const s = _shaper(amount); s.connect(dest); return s; }

// タイフォン・エアホーン：空気で振動板を鳴らす、力強く金管的な音
function _voiceAirHorn(dest, f, v, bright) {
    const c = audio.ctx, t0 = c.currentTime;
    const nodes = [];
    const out = _mkGain(0, dest);
    // タイフォンは太く澄んだ音（基音を強く）、エアホーンは明るいラッパの音
    const lp = _mkFilter('lowpass', f * (bright ? 10 : 3.5), 0.8, _shaperTo(out, bright ? 2.2 : 1.6));
    const peak = c.createBiquadFilter(); peak.type = 'peaking';
    peak.frequency.value = f * (bright ? 4 : 1); peak.Q.value = bright ? 1.2 : 0.9; peak.gain.value = bright ? 6 : 8;
    peak.connect(lp);
    const o1 = _mkOsc('sawtooth', f, _mkGain(0.7, peak)); nodes.push(o1);
    const o2 = _mkOsc('square', f * 1.002, _mkGain(0.3, peak)); nodes.push(o2);
    const vib = _mkOsc('sine', 6, null); nodes.push(vib);
    const vibG = _mkGain(f * 0.002, null); vib.connect(vibG); vibG.connect(o1.frequency); vibG.connect(o2.frequency);
    for (const o of [o1, o2]) { o.frequency.setValueAtTime(f * 0.95, t0); o.frequency.setTargetAtTime(o === o1 ? f : f * 1.002, t0, 0.04); }
    out.gain.setValueAtTime(0, t0);
    out.gain.setTargetAtTime(v * 0.8, t0, 0.03);
    return {
        stop(when) {
            when = Math.max(when, c.currentTime);
            for (const o of [o1, o2]) { o.frequency.cancelScheduledValues(when); o.frequency.setTargetAtTime(f * 0.96, when, 0.06); }
            out.gain.cancelScheduledValues(when);
            out.gain.setTargetAtTime(0, when, 0.06);
            _stopAll(nodes, when + 0.8);
        },
    };
}

// ダイアフォン：ピストンで空気を断続させる、太いブザーのような霧笛。止めると「うなり」
// ノートフォン：電磁式の霧笛。少し細く、うなりは無い
function _voiceDiaphone(dest, f, v, grunt) {
    const c = audio.ctx, t0 = c.currentTime;
    const nodes = [];
    const out = _mkGain(0, dest);
    const lp = _mkFilter('lowpass', grunt ? 750 : 1400, 0.9, _shaperTo(out, 2.5));
    const o = c.createOscillator();
    const n = 12, real = new Float32Array(n + 1), imag = new Float32Array(n + 1);
    for (let k = 1; k <= n; k++) imag[k] = 1 / k * (k % 2 ? 1 : 0.6);   // ブザー的な倍音
    o.setPeriodicWave(c.createPeriodicWave(real, imag));
    o.frequency.value = f; o.connect(lp); o.start(); nodes.push(o);
    const air = _mkGain(0.15, lp);
    const na = audioNoiseSource('white'); na.connect(_mkFilter('bandpass', f * 2, 3, air)); nodes.push(na);
    o.frequency.setValueAtTime(f * (grunt ? 0.78 : 0.95), t0);
    o.frequency.setTargetAtTime(f, t0, grunt ? 0.12 : 0.05);
    out.gain.setValueAtTime(0, t0);
    out.gain.setTargetAtTime(v * 0.85, t0, grunt ? 0.12 : 0.05);
    return {
        stop(when) {
            when = Math.max(when, c.currentTime);
            o.frequency.cancelScheduledValues(when);
            out.gain.cancelScheduledValues(when);
            if (grunt) {
                // 「ブォー……ウッ」：空気が抜けて音程が大きく下がりながら消える
                o.frequency.setTargetAtTime(f * 0.6, when, 0.16);
                out.gain.setTargetAtTime(v * 0.75, when, 0.05);
                out.gain.setTargetAtTime(0, when + 0.45, 0.18);
                _stopAll(nodes, when + 1.8);
            } else {
                out.gain.setTargetAtTime(0, when, 0.05);
                _stopAll(nodes, when + 0.6);
            }
        },
    };
}

// 電気ホーン：振動板をブザーで鳴らす、鼻にかかったような音
function _voiceElectric(dest, f, v) {
    const c = audio.ctx, t0 = c.currentTime;
    const nodes = [];
    const out = _mkGain(0, dest);
    const mix = _shaperTo(out, 1.5);
    const o = _mkOsc('square', f, null); nodes.push(o);
    o.connect(_mkFilter('bandpass', f * 3, 2.5, _mkGain(0.8, mix)));
    o.connect(_mkFilter('bandpass', 1800, 3, _mkGain(0.5, mix)));
    o.connect(_mkFilter('lowpass', f * 2, 0.7, _mkGain(0.6, mix)));
    out.gain.setValueAtTime(0, t0);
    out.gain.setTargetAtTime(v * 0.7, t0, 0.015);
    return {
        stop(when) {
            when = Math.max(when, c.currentTime);
            out.gain.cancelScheduledValues(when);
            out.gain.setTargetAtTime(0, when, 0.03);
            _stopAll(nodes, when + 0.4);
        },
    };
}

// サイレン：羽根車の回転が上がるにつれて音程が上がり、止めると下がっていく
function _voiceSiren(dest, f, v) {
    const c = audio.ctx, t0 = c.currentTime;
    const nodes = [];
    const out = _mkGain(0, dest);
    const lp = _mkFilter('lowpass', f * 4, 1, _shaperTo(out, 1.4));
    const o1 = _mkOsc('sawtooth', f, _mkGain(0.5, lp)); nodes.push(o1);
    const o2 = _mkOsc('square', f, _mkGain(0.4, lp)); nodes.push(o2);
    for (const o of [o1, o2]) { o.frequency.setValueAtTime(f * 0.12, t0); o.frequency.setTargetAtTime(f, t0, 0.9); }
    out.gain.setValueAtTime(0, t0);
    out.gain.setTargetAtTime(v * 0.7, t0, 0.4);
    return {
        stop(when) {
            when = Math.max(when, c.currentTime);
            for (const o of [o1, o2]) { o.frequency.cancelScheduledValues(when); o.frequency.setTargetAtTime(f * 0.08, when, 1.1); }
            out.gain.cancelScheduledValues(when);
            out.gain.setTargetAtTime(0, when + 0.8, 0.7);
            _stopAll(nodes, when + 4.5);
        },
    };
}

// 号鐘・ゴング：1回打つ（押している間は updateHorns がくり返し打つ）
function _strike(dest, f, v, kind) {
    const c = audio.ctx, t0 = c.currentTime + 0.005;
    const P = kind === 'gong'
        ? { r: [1, 1.47, 1.92, 2.41, 2.9, 3.63, 4.4], a: [1, 0.6, 0.5, 0.35, 0.3, 0.2, 0.12], d: [6, 4.5, 3.5, 2.8, 2.2, 1.6, 1.2] }
        : { r: [0.5, 1, 1.183, 1.506, 2, 2.514, 2.662, 3.011], a: [0.3, 1, 0.55, 0.4, 0.35, 0.18, 0.15, 0.1], d: [5, 3.2, 2.4, 1.8, 1.4, 0.9, 0.8, 0.55] };
    const out = _mkGain(v * (kind === 'gong' ? 0.5 : 0.35), dest);
    P.r.forEach((r, i) => {
        const o = c.createOscillator(); o.type = 'sine';
        o.frequency.value = f * r * (1 + (Math.random() - 0.5) * 0.002);
        const g = c.createGain();
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(P.a[i], t0 + 0.003);
        g.gain.exponentialRampToValueAtTime(0.0003, t0 + P.d[i]);
        o.connect(g); g.connect(out);
        o.start(t0); o.stop(t0 + P.d[i] + 0.05);
    });
    // 打った瞬間の「カン」
    audioBurst(dest, { dur: 0.04, attack: 0.001, gain: 0.3 * v, type: 'highpass', freq: kind === 'gong' ? 1200 : 3000, q: 0.6 });
}

function _makeVoice(type, dest, f, v) {
    switch (type) {
        case 'steam_single': return _voiceSteam(dest, f, v, 'single');
        case 'steam_chime':  return _voiceSteam(dest, f, v, 'chime');
        case 'steam_organ':  return _voiceSteam(dest, f, v, 'organ');
        case 'steam_bell':   return _voiceSteam(dest, f, v, 'bell');
        case 'tyfon':        return _voiceAirHorn(dest, f, v, false);
        case 'airhorn':      return _voiceAirHorn(dest, f, v, true);
        case 'diaphone':     return _voiceDiaphone(dest, f, v, true);
        case 'nautophone':   return _voiceDiaphone(dest, f, v, false);
        case 'electric':     return _voiceElectric(dest, f, v);
        case 'siren':        return _voiceSiren(dest, f, v);
        default: return null;
    }
}
const _isStrikeType = (type) => type === 'bell' || type === 'gong';

// ════════════════════════════════════════════════════════════════
//  鳴らす・止める
// ════════════════════════════════════════════════════════════════
function _hornRt(i) {
    if (!audio.ctx) return null;
    let R = _hornRuntime[i];
    if (!R) {
        R = { em: new AudioEmitter(audio.buses.horn, 60, 0.6), voices: [], presses: 0, strikeNext: 0 };
        R.out = _mkGain(1, R.em.input);
        _hornRuntime[i] = R;
    }
    return R;
}

function hornPress(i) {
    const h = shipSound.horns[i];
    if (!h || !audioEnsure()) return;
    const R = _hornRt(i);
    R.presses++;
    if (R.presses > 1) return;
    R.em.update(audioShipPoint(h.x, h.y, h.z, new THREE.Vector3()));
    const vol = Math.max(0, h.volume != null ? h.volume : 1);
    const notes = (h.notes && h.notes.length) ? h.notes : ['C3'];
    // 和音は音の数が増えても大きくなりすぎないように
    const per = vol / Math.sqrt(notes.length);
    if (_isStrikeType(h.type)) {
        for (const n of notes) _strike(R.out, noteToFreq(n), per, h.type);
        R.strikeNext = audio.ctx.currentTime + (h.type === 'gong' ? 0.9 : 0.34);
        return;
    }
    R.voices = notes.map(n => _makeVoice(h.type, R.out, noteToFreq(n), per)).filter(Boolean);
}
function hornRelease(i) {
    const R = _hornRuntime[i];
    if (!R || R.presses <= 0) return;
    R.presses--;
    if (R.presses > 0) return;
    const now = audio.ctx.currentTime;
    for (const v of R.voices) v.stop(now);
    R.voices = [];
}
function _mainHornIdx() {
    const idx = [];
    shipSound.horns.forEach((h, i) => { if (h.main) idx.push(i); });
    if (idx.length === 0 && shipSound.horns.length) idx.push(0);
    return idx;
}
function hornPressMain() { _mainHornIdx().forEach(hornPress); }
function hornReleaseMain() { _mainHornIdx().forEach(hornRelease); }
// 霧中信号に使う汽笛（「霧中信号用」にチェックしたもの。無ければ 📯 用）
function _fogHornIdx() {
    const idx = [];
    shipSound.horns.forEach((h, i) => { if (h.fog) idx.push(i); });
    return idx.length ? idx : _mainHornIdx();
}
function hornPressFog() { _fogHornIdx().forEach(hornPress); }
function hornReleaseFog() { _fogHornIdx().forEach(hornRelease); }
window.hornPressFog = hornPressFog;
window.hornReleaseFog = hornReleaseFog;
window.hornPressMain = hornPressMain;
window.hornReleaseMain = hornReleaseMain;

// 信号（長音・短音の組み合わせ）を吹鳴する。pattern: 'L','S' の並び
let _signalTimers = [];
function playHornSignal(pattern, role) {
    if (!audioEnsure()) return;
    stopHornSignal();
    const press = role === 'fog' ? hornPressFog : hornPressMain;
    const release = role === 'fog' ? hornReleaseFog : hornReleaseMain;
    let t = 0;
    for (const ch of pattern) {
        const d = ch === 'L' ? HORN_LONG : HORN_SHORT;
        _signalTimers.push(setTimeout(press, t * 1000));
        _signalTimers.push(setTimeout(release, (t + d) * 1000));
        t += d + (ch === 'L' ? 2.0 : HORN_GAP);
    }
}
function stopHornSignal() {
    for (const id of _signalTimers) clearTimeout(id);
    _signalTimers = [];
    // 押しっぱなしのまま止まらないように
    shipSound.horns.forEach((h, i) => { const R = _hornRuntime[i]; if (R && R.presses > 0) { R.presses = 1; hornRelease(i); } });
}
window.playHornSignal = playHornSignal;

// ── 自動の信号 ──
//  霧中信号：霧の中を航行中は2分ごとに長音1回、停止中は長音2回
//  後進信号：前進中に後進をかけたら短音3回
//  出港の汽笛：スタンバイ（機関用意）のあと、初めて前進を指令したとき（off／長音1回／長音3回）
const HORN_DEPART = { off: '鳴らさない', L: '長音1回', LLL: '長音3回' };
window.HORN_DEPART = HORN_DEPART;
const hornAuto = { fog: false, astern: false, depart: 'L', _nextFog: 0, _prevTele: 0, _departArmed: false };
(function restoreHornAuto() {
    try {
        const s = JSON.parse(localStorage.getItem('susuru_horn_auto') || 'null');
        if (s) { hornAuto.fog = !!s.fog; hornAuto.astern = !!s.astern; if (HORN_DEPART[s.depart]) hornAuto.depart = s.depart; }
    } catch (e) { /* ignore */ }
})();
function setHornAuto(key, on) {
    hornAuto[key] = (key === 'depart') ? (HORN_DEPART[on] ? on : 'off') : !!on;
    try { localStorage.setItem('susuru_horn_auto', JSON.stringify({ fog: hornAuto.fog, astern: hornAuto.astern, depart: hornAuto.depart })); } catch (e) { /* ignore */ }
}

// 毎フレーム（35 の updateAudio から）
function updateHorns(t, dt) {
    const now = audio.ctx.currentTime;
    shipSound.horns.forEach((h, i) => {
        const R = _hornRuntime[i];
        if (!R) return;
        // 船と一緒に動く音源
        R.em.update(audioShipPoint(h.x, h.y, h.z, audio._tmpH || (audio._tmpH = new THREE.Vector3())));
        // 号鐘・ゴングは押している間くり返し打つ
        if (_isStrikeType(h.type) && R.presses > 0 && now >= R.strikeNext) {
            const per = Math.max(0, h.volume != null ? h.volume : 1) / Math.sqrt(Math.max(1, h.notes.length));
            for (const n of h.notes) _strike(R.out, noteToFreq(n), per, h.type);
            R.strikeNext = now + (h.type === 'gong' ? 0.9 : 0.34);
        }
    });

    const w = window.weather;
    const foggy = w && w.enabled && (w.fog || 0) > 0.3;
    if (hornAuto.fog && foggy) {
        const nowMs = performance.now();
        if (nowMs > hornAuto._nextFog) {
            if (hornAuto._nextFog > 0) playHornSignal(Math.abs(physics.speed || 0) > 0.5 ? 'L' : 'LL', 'fog');
            hornAuto._nextFog = nowMs + 120000;
        }
    } else {
        hornAuto._nextFog = 0;
    }
    const tele = physics.telegraphState || 0;
    if (hornAuto.astern && tele < 0 && hornAuto._prevTele >= 0 && (physics.speed || 0) > 0.5) playHornSignal('SSS');
    // 出港の汽笛：スタンバイで構え、そのあと初めて前進になったら鳴らす（機関終了で取り消し）
    const sp = physics.telegraphSpecial || '';
    if (sp === 'standby') hornAuto._departArmed = true;
    else if (sp === 'fwe') hornAuto._departArmed = false;
    else if (hornAuto._departArmed && tele > 0) {
        hornAuto._departArmed = false;
        if (hornAuto.depart && hornAuto.depart !== 'off') playHornSignal(hornAuto.depart);
    }
    hornAuto._prevTele = tele;
}

// ════════════════════════════════════════════════════════════════
//  保存・読み込み（13-save-load-config.js から呼ぶ）
// ════════════════════════════════════════════════════════════════
function getShipSoundConfig() {
    const c = JSON.parse(JSON.stringify(shipSound));
    // 前の版でも読めるよう、1つ目の機関音を以前の形でも書いておく
    const e0 = shipSound.engines[0];
    if (e0) {
        c.engine = { type: e0.type, volume: e0.volume };
        c.enginePos = { x: e0.x, y: e0.y, z: e0.z };
        c.engineSym = !!e0.sym;
    }
    return c;
}
function applyShipSoundConfig(s) {
    if (audio.ctx) {
        stopHornSignal();
        _hornRuntime.forEach((R, i) => { if (!R) return; R.presses = 1; hornRelease(i); if (R.em) R.em.disconnect(); });
    }
    _hornRuntime.length = 0;
    const d = _defaultShipSound();
    shipSound.horns = (s && Array.isArray(s.horns)) ? s.horns.map(h => Object.assign(_defaultHorn(h.type || 'steam_single'), h)) : d.horns;
    if (s && Array.isArray(s.engines)) {
        shipSound.engines = s.engines.map(e => Object.assign(_defaultEngine(e.type || 'steam_recip'), e));
    } else if (s && s.engine) {
        // 以前の保存データ（機関音は1つだけだった）
        const e = _defaultEngine(s.engine.type || 'steam_recip');
        if (Number.isFinite(s.engine.volume)) e.volume = s.engine.volume;
        Object.assign(e, s.enginePos || {});
        e.sym = !!s.engineSym;
        shipSound.engines = [e];
    } else {
        shipSound.engines = d.engines;
    }
    delete shipSound.engine; delete shipSound.enginePos; delete shipSound.engineSym;
    _soundMarkersDirty = true;
    renderSoundPanel();
}
window.getShipSoundConfig = getShipSoundConfig;
window.applyShipSoundConfig = applyShipSoundConfig;

// ════════════════════════════════════════════════════════════════
//  設定画面（船体設定の「🔊 音」タブ）
// ════════════════════════════════════════════════════════════════
const _NOTE_OPTIONS = (() => {
    let s = '';
    for (let m = 24; m <= 96; m++) s += `<option value="${midiToNote(m)}">${_noteLabel(m)}</option>`;   // C1〜C7
    return s;
})();
function _esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
const _selStyle = 'background:#0a1932;color:#00ffcc;border:1px solid #00ffcc;border-radius:4px;padding:3px 6px;font-family:inherit;font-size:11px;';

function renderSoundPanel() {
    const list = document.getElementById('horn-list');
    if (list) {
        list.innerHTML = '';
        shipSound.horns.forEach((h, i) => {
            const typeOpts = Object.entries(HORN_TYPES).map(([k, T]) => `<option value="${k}"${k === h.type ? ' selected' : ''}>${T.label}</option>`).join('');
            const notes = (h.notes || []).map((n, j) => `
                <span style="display:inline-flex;align-items:center;gap:2px;margin:2px 4px 2px 0;">
                    <select style="${_selStyle}" onchange="hornSetNote(${i},${j},this.value)">${_NOTE_OPTIONS.replace(`value="${midiToNote(noteToMidi(n))}"`, `value="${midiToNote(noteToMidi(n))}" selected`)}</select>
                    <button class="sp-remove-btn" style="padding:2px 6px;" onclick="hornRemoveNote(${i},${j})">✕</button>
                </span>`).join('');
            const card = document.createElement('div');
            card.className = 'sp-item-card';
            card.innerHTML = `
                <div class="sp-item-header">
                    <span class="sp-item-title">📯 #${i + 1}
                        <input type="text" value="${_esc(h.name || '')}" style="${_selStyle}width:9em;" oninput="shipSound.horns[${i}].name=this.value">
                    </span>
                    <button class="sp-remove-btn" onclick="hornRemove(${i})">✕</button>
                </div>
                <div class="sp-row" style="gap:6px;flex-wrap:wrap;">
                    <span class="sp-label" style="min-width:0;">種類:</span>
                    <select style="${_selStyle}max-width:100%;" onchange="hornSetType(${i},this.value)">${typeOpts}</select>
                </div>
                <div class="sp-row" style="gap:4px;flex-wrap:wrap;align-items:center;">
                    <span class="sp-label" style="min-width:0;">音階:</span>${notes}
                    <button class="sp-add-btn" style="padding:2px 8px;" onclick="hornAddNote(${i})">＋ 音を足す（和音）</button>
                </div>
                <div class="sp-row" style="gap:6px;">
                    <span class="sp-label" style="min-width:0;">音量:</span>
                    <input type="range" class="sp-slider" min="0" max="1.5" step="0.05" value="${h.volume != null ? h.volume : 1}" oninput="shipSound.horns[${i}].volume=parseFloat(this.value)">
                </div>
                <div class="sp-xyz-row">
                    <span class="sp-axis-label">X:</span><input type="number" id="horn-x-${i}" class="sp-xyz-input" value="${h.x}" step="0.05" oninput="shipSound.horns[${i}].x=parseFloat(this.value)||0">
                    <span class="sp-axis-label">Y:</span><input type="number" id="horn-y-${i}" class="sp-xyz-input" value="${h.y}" step="0.05" oninput="shipSound.horns[${i}].y=parseFloat(this.value)||0">
                    <span class="sp-axis-label">Z:</span><input type="number" id="horn-z-${i}" class="sp-xyz-input" value="${h.z}" step="0.05" oninput="shipSound.horns[${i}].z=parseFloat(this.value)||0">
                </div>
                <div class="sp-row" style="gap:8px;flex-wrap:wrap;">
                    <label class="sp-toggle"><input type="checkbox" ${h.main ? 'checked' : ''} onchange="shipSound.horns[${i}].main=this.checked"> 📯ボタン・操船信号用</label>
                    <label class="sp-toggle"><input type="checkbox" ${h.fog ? 'checked' : ''} onchange="shipSound.horns[${i}].fog=this.checked"> 霧中信号用（霧笛）</label>
                    <button class="sp-gizmo-btn" id="gizmo-horn-${i}" onclick="toggleGizmo('horn', ${i})">📍 ギズモ</button>
                    <button class="sp-gizmo-btn" onclick="hornCopy(${i}, false)" title="同じ設定の汽笛をもう1つ作る">⧉ 複製</button>
                    <button class="sp-gizmo-btn" onclick="hornCopy(${i}, true)" title="左右反対側（Xを反転）に同じ汽笛を作る">⇆ 反対舷に複製</button>
                    <button class="sp-gizmo-btn horn-test-btn" data-horn="${i}">🔊 押している間 鳴らす${i < 9 ? `（${i + 1}キー）` : ''}</button>
                </div>`;
            list.appendChild(card);
        });
        list.querySelectorAll('.horn-test-btn').forEach((btn) => {
            const i = parseInt(btn.dataset.horn, 10);
            _bindHold(btn, () => hornPress(i), () => hornRelease(i));
        });
    }
    const elist = document.getElementById('engine-list');
    if (elist) {
        elist.innerHTML = '';
        shipSound.engines.forEach((e, i) => {
            const typeOpts = Object.entries(ENGINE_TYPES).map(([k, T]) => `<option value="${k}"${k === e.type ? ' selected' : ''}>${T.label}</option>`).join('');
            const card = document.createElement('div');
            card.className = 'sp-item-card';
            card.innerHTML = `
                <div class="sp-item-header">
                    <span class="sp-item-title">⚙ #${i + 1}
                        <input type="text" value="${_esc(e.name || '')}" style="${_selStyle}width:9em;" oninput="shipSound.engines[${i}].name=this.value">
                    </span>
                    <button class="sp-remove-btn" onclick="engineRemove(${i})">✕</button>
                </div>
                <div class="sp-row" style="gap:6px;flex-wrap:wrap;">
                    <span class="sp-label" style="min-width:0;">形式:</span>
                    <select style="${_selStyle}max-width:100%;" onchange="engineSet(${i},'type',this.value)">${typeOpts}</select>
                </div>
                <div class="sp-row" style="gap:6px;">
                    <span class="sp-label" style="min-width:0;">音量:</span>
                    <input type="range" class="sp-slider" min="0" max="1.5" step="0.05" value="${e.volume != null ? e.volume : 1}" oninput="engineSet(${i},'volume',this.value)">
                </div>
                <div class="sp-xyz-row">
                    <span class="sp-axis-label">X:</span><input type="number" id="engine-x-${i}" class="sp-xyz-input" value="${e.x}" step="0.1" oninput="engineSet(${i},'x',this.value)">
                    <span class="sp-axis-label">Y:</span><input type="number" id="engine-y-${i}" class="sp-xyz-input" value="${e.y}" step="0.1" oninput="engineSet(${i},'y',this.value)">
                    <span class="sp-axis-label">Z:</span><input type="number" id="engine-z-${i}" class="sp-xyz-input" value="${e.z}" step="0.1" oninput="engineSet(${i},'z',this.value)">
                </div>
                <div class="sp-row" style="gap:8px;flex-wrap:wrap;">
                    <label class="sp-toggle"><input type="checkbox" ${e.sym ? 'checked' : ''} onchange="engineSet(${i},'sym',this.checked)"> シンメトリー（左右2か所）</label>
                    <button class="sp-gizmo-btn" id="gizmo-engine-${i}" onclick="toggleGizmo('engine', ${i})">📍 ギズモ</button>
                    <button class="sp-gizmo-btn" onclick="engineCopy(${i}, false)" title="同じ設定の機関音をもう1つ作る">⧉ 複製</button>
                    <button class="sp-gizmo-btn" onclick="engineCopy(${i}, true)" title="左右反対側（Xを反転）に同じ機関音を作る">⇆ 反対舷に複製</button>
                </div>`;
            elist.appendChild(card);
        });
    }
    const eadd = document.getElementById('engine-add-type');
    if (eadd && !eadd.options.length) {
        eadd.innerHTML = Object.entries(ENGINE_TYPES).filter(([k]) => k !== 'none').map(([k, T]) => `<option value="${k}">${T.label}</option>`).join('');
    }
    // 端末ごとの設定
    const S = audio.settings;
    const set = (id, v, prop = 'value') => { const el = document.getElementById(id); if (el) el[prop] = v; };
    set('audio-enabled', S.enabled, 'checked');
    set('audio-master', S.master); set('audio-horn', S.horn); set('audio-engine', S.engine); set('audio-env', S.env);
    set('audio-bridge', S.bridge != null ? S.bridge : 0.8);
    set('horn-auto-fog', hornAuto.fog, 'checked');
    set('horn-auto-astern', hornAuto.astern, 'checked');
    const dp = document.getElementById('horn-auto-depart');
    if (dp) dp.innerHTML = Object.entries(HORN_DEPART).map(([k, l]) => `<option value="${k}"${k === hornAuto.depart ? ' selected' : ''}>${l}</option>`).join('');
}
window.renderSoundPanel = renderSoundPanel;

function hornAdd() {
    const sel = document.getElementById('horn-add-type');
    shipSound.horns.push(_defaultHorn(sel ? sel.value : 'steam_single'));
    _soundMarkersDirty = true;
    renderSoundPanel();
}
// 汽笛をコピーする（すぐ後ろに入れる）。mirror：左右反対側（X を反転）に置く
function hornCopy(i, mirror) {
    const src = shipSound.horns[i];
    if (!src) return;
    const h = JSON.parse(JSON.stringify(src));
    if (mirror) h.x = -(h.x || 0);
    h.name = (src.name || '') + (mirror ? '（反対舷）' : '（コピー）');
    shipSound.horns.splice(i + 1, 0, h);
    // 鳴っている汽笛の番号がずれないよう、実行中の情報も同じ位置に空きを入れる
    if (_hornRuntime.length > i + 1) _hornRuntime.splice(i + 1, 0, undefined);
    if (typeof disableGizmo === 'function') disableGizmo();
    _soundMarkersDirty = true;
    renderSoundPanel();
}
window.hornCopy = hornCopy;
function hornRemove(i) {
    const R = _hornRuntime[i];
    if (R) { R.presses = 1; hornRelease(i); if (R.em) R.em.disconnect(); }
    _hornRuntime.splice(i, 1);
    shipSound.horns.splice(i, 1);
    if (typeof disableGizmo === 'function') disableGizmo();
    _soundMarkersDirty = true;
    renderSoundPanel();
}
function hornSetType(i, type) {
    const h = shipSound.horns[i];
    // 種類を変えても音階はそのまま（名前が種類の名前のままなら、新しい種類の名前に合わせる）
    const oldLabel = HORN_TYPES[h.type] ? HORN_TYPES[h.type].label.replace(/（.*$/, '') : '';
    h.type = type;
    // 音階は変えない（ユーザーが決めた音のまま、鳴り方だけ変える）
    if (!h.notes || !h.notes.length) h.notes = HORN_TYPES[type].notes.slice();
    if (!h.name || h.name === oldLabel) h.name = HORN_TYPES[type].label.replace(/（.*$/, '');
    renderSoundPanel();
}
function hornSetNote(i, j, v) { shipSound.horns[i].notes[j] = v; }
function hornAddNote(i) {
    const h = shipSound.horns[i];
    const last = h.notes.length ? noteToMidi(h.notes[h.notes.length - 1]) : 48;
    h.notes.push(midiToNote(Math.min(96, last + 4)));   // 長3度上を足す
    renderSoundPanel();
}
function hornRemoveNote(i, j) {
    const h = shipSound.horns[i];
    if (h.notes.length <= 1) return;   // 最低1音
    h.notes.splice(j, 1);
    renderSoundPanel();
}
function engineSet(i, key, v) {
    const e = shipSound.engines[i];
    if (!e) return;
    if (key === 'type') {
        const oldLabel = ENGINE_TYPES[e.type] ? ENGINE_TYPES[e.type].label.replace(/（.*$/, '') : '';
        e.type = v;
        if (!e.name || e.name === oldLabel) { e.name = ENGINE_TYPES[v].label.replace(/（.*$/, ''); renderSoundPanel(); }
    }
    else if (key === 'volume') e.volume = parseFloat(v) || 0;
    else if (key === 'sym') { e.sym = !!v; _soundMarkersDirty = true; }
    else { e[key] = parseFloat(v) || 0; }
}
function engineAdd() {
    const sel = document.getElementById('engine-add-type');
    shipSound.engines.push(_defaultEngine(sel && sel.value ? sel.value : 'steam_recip'));
    _soundMarkersDirty = true;
    renderSoundPanel();
}
function engineRemove(i) {
    shipSound.engines.splice(i, 1);
    if (typeof disableGizmo === 'function') disableGizmo();
    _soundMarkersDirty = true;
    renderSoundPanel();
}
// 機関音をコピーする（すぐ後ろに入れる）。mirror：左右反対側（X を反転）に置く
function engineCopy(i, mirror) {
    const src = shipSound.engines[i];
    if (!src) return;
    const e = JSON.parse(JSON.stringify(src));
    if (mirror) e.x = -(e.x || 0);
    e.name = (src.name || '') + (mirror ? '（反対舷）' : '（コピー）');
    shipSound.engines.splice(i + 1, 0, e);
    if (typeof disableGizmo === 'function') disableGizmo();
    _soundMarkersDirty = true;
    renderSoundPanel();
}
// 以前の画面・保存形式からの呼び出し用（1つ目の機関音を変える）
function setEngineSound(key, v) { if (!shipSound.engines.length) shipSound.engines.push(_defaultEngine('steam_recip')); engineSet(0, key, v); }
Object.assign(window, { hornAdd, hornRemove, hornSetType, hornSetNote, hornAddNote, hornRemoveNote, setEngineSound, setHornAuto,
                        engineSet, engineAdd, engineRemove, engineCopy });

// ════════════════════════════════════════════════════════════════
//  音の位置の目印とギズモ（船体設定を開いている間だけ表示）
// ════════════════════════════════════════════════════════════════
//  汽笛：黄色の角錐、機関室：赤い立方体（シンメトリーのときは反対側に薄い印）
let _soundMarkers = { horns: [], engines: [] };   // engines: [{ m, mirror }]
let _soundMarkersDirty = true;
function _mkSoundMarker(color, geo) {
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 }));
    m.renderOrder = 999;
    m.userData.isViewpointMarker = true;   // モデル差し替え時の一括削除から除外
    m.userData.screenSizeMarker = true;    // 画面上で一定の大きさ（10-ship-editor の updateMarkerScales）
    return m;
}
function _rebuildSoundMarkers() {
    _soundMarkersDirty = false;
    if (typeof shipGroup === 'undefined' || !shipGroup) return;
    for (const m of _soundMarkers.horns) if (m.parent) m.parent.remove(m);
    for (const e of _soundMarkers.engines) [e.m, e.mirror].forEach(m => { if (m && m.parent) m.parent.remove(m); });
    _soundMarkers.horns = shipSound.horns.map(() => { const m = _mkSoundMarker(0xffd23c, new THREE.ConeGeometry(0.12, 0.3, 4)); shipGroup.add(m); return m; });
    _soundMarkers.engines = shipSound.engines.map(() => {
        const m = _mkSoundMarker(0xff4444, new THREE.BoxGeometry(0.25, 0.25, 0.25)); shipGroup.add(m);
        const mirror = _mkSoundMarker(0xff4444, new THREE.BoxGeometry(0.25, 0.25, 0.25));
        mirror.material.opacity = 0.35; shipGroup.add(mirror);
        return { m, mirror };
    });
}
function _updateSoundMarkers() {
    const e0 = _soundMarkers.engines[0];
    if (_soundMarkersDirty || _soundMarkers.horns.length !== shipSound.horns.length || _soundMarkers.engines.length !== shipSound.engines.length
        || (e0 && typeof shipGroup !== 'undefined' && e0.m.parent !== shipGroup)) _rebuildSoundMarkers();
    const panel = document.getElementById('settings-panel');
    const show = !!(panel && panel.classList.contains('open'));
    const dragging = typeof currentGizmoType !== 'undefined' ? currentGizmoType : null;
    shipSound.horns.forEach((h, i) => {
        const m = _soundMarkers.horns[i]; if (!m) return;
        m.visible = show;
        if (!(dragging === 'horn' && currentGizmoIndex === i)) m.position.set(h.x, h.y, h.z);
    });
    shipSound.engines.forEach((p, i) => {
        const mk = _soundMarkers.engines[i]; if (!mk) return;
        mk.m.visible = show;
        if (!(dragging === 'engine' && currentGizmoIndex === i)) mk.m.position.set(p.x, p.y, p.z);
        mk.mirror.visible = show && !!p.sym && Math.abs(p.x) > 1e-3;
        mk.mirror.position.set(-mk.m.position.x, mk.m.position.y, mk.m.position.z);
    });
}
// 10-ship-editor-propulsors.js の toggleGizmo / onGizmoChange から呼ばれる
function getExtraGizmoTarget(type, index) {
    if (type === 'horn') { _updateSoundMarkers(); return { mesh: _soundMarkers.horns[index], btnId: `gizmo-horn-${index}` }; }
    if (type === 'engine') {
        _updateSoundMarkers();
        const i = index >= 0 ? index : 0;
        return { mesh: _soundMarkers.engines[i] && _soundMarkers.engines[i].m, btnId: `gizmo-engine-${i}` };
    }
    return null;
}
function onExtraGizmoChange(type, index, target) {
    const p = target.position;
    const r = (v) => Math.round(v * 1000) / 1000;
    if (type === 'horn' && shipSound.horns[index]) {
        const h = shipSound.horns[index];
        h.x = r(p.x); h.y = r(p.y); h.z = r(p.z);
        ['x', 'y', 'z'].forEach(k => { const el = document.getElementById(`horn-${k}-${index}`); if (el) el.value = h[k]; });
        return true;
    }
    if (type === 'engine') {
        const i = index >= 0 ? index : 0;
        const e = shipSound.engines[i];
        if (!e) return true;
        e.x = r(p.x); e.y = r(p.y); e.z = r(p.z);
        ['x', 'y', 'z'].forEach(k => { const el = document.getElementById(`engine-${k}-${i}`); if (el) el.value = e[k]; });
        return true;
    }
    return false;
}
window.getExtraGizmoTarget = getExtraGizmoTarget;
window.updateSoundMarkers = _updateSoundMarkers;
window.onExtraGizmoChange = onExtraGizmoChange;

// 押している間だけ鳴らすボタン（タッチ・マウス両対応）
function _bindHold(el, down, up) {
    let held = false;
    const start = (e) => { e.preventDefault(); e.stopPropagation(); if (held) return; held = true; down(); };
    const end = (e) => { if (e) e.stopPropagation(); if (!held) return; held = false; up(); };
    el.addEventListener('touchstart', start, { passive: false });
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', end);
    el.addEventListener('mousedown', start);
    el.addEventListener('mouseup', end);
    el.addEventListener('mouseleave', end);
}

// ── 画面のボタンとキー ──
document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('btn-horn');
    if (btn) _bindHold(btn, hornPressMain, hornReleaseMain);
    renderSoundPanel();
});
const _keyHeld = {};
window.addEventListener('keydown', (e) => {
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (e.repeat) return;
    const k = e.key.toLowerCase();
    if (k === 'h' && !_keyHeld.h) { _keyHeld.h = true; hornPressMain(); }       // 操船信号用の汽笛を一斉に
    if (k === 'g' && !_keyHeld.g) { _keyHeld.g = true; hornPressFog(); }        // 霧笛を一斉に
    if (/^[1-9]$/.test(k) && !_keyHeld[k]) {
        const i = parseInt(k, 10) - 1;
        if (i < shipSound.horns.length) { _keyHeld[k] = true; hornPress(i); }
    }
});
window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    if (k === 'h' && _keyHeld.h) { _keyHeld.h = false; hornReleaseMain(); }
    if (k === 'g' && _keyHeld.g) { _keyHeld.g = false; hornReleaseFog(); }
    if (/^[1-9]$/.test(k) && _keyHeld[k]) { _keyHeld[k] = false; hornRelease(parseInt(k, 10) - 1); }
});
// 画面を離れたら鳴りっぱなしにしない
window.addEventListener('blur', () => { Object.keys(_keyHeld).forEach(k => { _keyHeld[k] = false; }); if (audio.ctx) stopHornSignal(); });
