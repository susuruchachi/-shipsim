// 37-bridge-controls.js — 画面のテレグラフ（機関指令）と舵輪
//
// ════════════════════════════════════════════════════════════════
//  やりたいこと
// ════════════════════════════════════════════════════════════════
//  前進・後進の ▲▼ ボタンと、舵の ◀▶ ボタンの代わりに、本物の船橋の
//  機器のようなテレグラフと舵輪を画面に置く。デザインは船ごとに選べる。
//
//  テレグラフ（機関指令）：
//    ・olympic   : オリンピック級のような真鍮の丸型（白いほうろうの文字盤）
//    ・queenmary : クイーン・メリーのようなアールデコ調（黒文字盤に金文字）
//    ・warship   : 軍艦の計器のようなメーター型
//    ・modern    : 現代的な押しボタン式パネル
//    ・rotary    : 回転つまみ式レバー
//    ・tilt      : 倒すタイプのレバー（画面の左右に倒す）
//    ・fore      : 前後に倒すレバー（奥へ押すと前進、手前へ引くと後進）
//    ・buttons   : 従来の ▲▼ ボタン
//  ハンドル（または針）を指でドラッグするか、文字の所をタップして指令する。
//  速度のほかに、本物のテレグラフにある2つの指令も出せる：
//    ・STAND BY（スタンバイ／機関用意）：出港前などに「いつでも回せるように」
//    ・FINISHED WITH ENGINES（F.W.E.／機関終了）：機関を止めて休ませる。
//      機関の音が静まり、この後に速度を指令すると機関を起こすのに時間が
//      かかるので、応答が遅くなる
//  丸型（オリンピック級・クイーン・メリー風）は文字盤の両端の位置、ほかの
//  形式は上の小さなボタンで指令する。
//  指令すると船橋のベルが「ジリンジリン」と鳴り、少しして機関室が応答の
//  ベルを鳴らして、応答の針（小さな赤い針）が指令に追いつく。機関は応答が
//  あってから回転を変える（設定で「すぐ反応」にもできる）。
//
//  舵輪：
//    ・classic : 古典的な木の舵輪。縁の金属板に、入力した文字を彫り込む
//    ・handle  : ハンドル型（現代の船橋の舵輪）
//    ・azipod  : アジポッド用の旋回レバー（現代のクルーズ船）
//    ・buttons : 従来の ◀▶ ボタン
//  舵輪は指で回した角度のまま止まる（本物の舵輪と同じ。手を離しても戻らない）。
//  舵は舵取機の速さで舵輪の指示へ追いつき、上の舵角計に実際の舵角が出る。
//  舵輪の中心をダブルタップすると舵中央（ミジップ）に戻る。

const BRIDGE_TELEGRAPHS = {
    olympic:   'オリンピック級（真鍮・丸型）',
    queenmary: 'クイーン・メリー風（アールデコ）',
    warship:   '軍艦のメーター型',
    modern:    '現代的なボタン式',
    rotary:    'レバー（回転つまみ式）',
    tilt:      'レバー（左右に倒すタイプ）',
    fore:      'レバー（前後に倒すタイプ）',
    buttons:   'シンプル（▲▼ボタン）',
};
const BRIDGE_WHEELS = {
    classic: '古典的な舵輪（木製・文字の彫り込み）',
    handle:  'ハンドル型（現代の舵輪）',
    azipod:  'アジポッド用の旋回レバー',
    buttons: 'シンプル（◀▶ボタン）',
};
window.BRIDGE_TELEGRAPHS = BRIDGE_TELEGRAPHS;
window.BRIDGE_WHEELS = BRIDGE_WHEELS;

// 舵輪を端から端まで回すのに必要な角度（片側）
// 古典的な舵輪は、本物の大型船のように1周で舵1°（舵いっぱい35°まで35周）
const WHEEL_LOCK_DEG = { classic: 35 * 360, handle: 270, azipod: 70 };
const HELM_RATE = 20;          // 舵が舵輪の指示へ追いつく速さ[度/秒]（舵取機）
const HELM_KEY_RATE = 60;      // A/Dキーで舵輪を回す速さ（舵角換算[度/秒]）
const HELM_KEY_RATE_WHEEL = { classic: 6 };   // 古典的な舵輪は1秒に6周（＝舵6°）まで
const TG_ANSWER_DELAY = 1.3;   // 機関室が応答するまで[秒]

// テレグラフのベルの音（auto：デザインに合わせる。オリンピック級・クイーン・メリー風は
// 真鍮のゴング、現代型は電子音、ほかは以前の小さなベル）
const BRIDGE_BELLS = {
    auto:     'デザインに合わせる',
    phone:    '電話のようなベル（ジリリン）',
    gong:     '真鍮のゴング（コーン）',
    classic:  '小さなベル（以前の音）',
    electric: '電子音',
};
window.BRIDGE_BELLS = BRIDGE_BELLS;
const bridgeUI = {
    telegraph: 'olympic', wheel: 'classic', wheelText: 'R.M.S. OLYMPIC', waitAnswer: true, bell: 'auto',
    tgTheme: 'auto', tgLit: true,     // 盤面の色（auto/white/black）・暗くなったら盤面を光らせる
};
window.bridgeUI = bridgeUI;
const _br = {
    tgDrag: null, tgHandle: 0, answer: 0, answerAt: -1, lastOrder: null,
    wheelDrag: null, wheelDeg: 0, lastTap: 0, dirtyT: true, dirtyW: true, size: 170,
    lastRudder: 999, lastT: -1, lastSpecial: '',
};
physics.helmOrder = 0;
physics.telegraphAnswer = physics.telegraphState || 0;

const _TG_LABEL = { 3: 'FULL', 2: 'HALF', 1: 'SLOW', 0: 'STOP', '-1': 'SLOW', '-2': 'HALF', '-3': 'FULL' };
const _TG_JP = { 3: '全速前進', 2: '半速前進', 1: '微速前進', 0: '停止', '-1': '微速後進', '-2': '半速後進', '-3': '全速後進' };
// 速度以外の指令。v は丸型の文字盤での位置（前進側の端・後進側の端）
const _TG_SPECIAL = {
    standby: { en: 'STAND BY', short: 'S/B', jp: 'スタンバイ（機関用意）', v: 4 },
    fwe:     { en: 'FINISHED WITH ENGINES', short: 'F.W.E.', jp: '機関終了', v: -4 },
};
window.TG_SPECIAL = _TG_SPECIAL;
const TG_FWE_WAKE = 4;          // 機関終了のあと速度を指令したときの、応答の遅れ（倍）
physics.telegraphSpecial = '';
physics.telegraphAnswerSpecial = '';
const _tgOnDial = (design) => design === 'olympic' || design === 'queenmary';
// ハンドル（針）の位置：丸型では特別な指令は両端の位置
function _tgPos(design, order, special) {
    return (special && _tgOnDial(design)) ? _TG_SPECIAL[special].v : order;
}

// ════════════════════════════════════════════════════════════════
//  音：テレグラフのベル
// ════════════════════════════════════════════════════════════════
// 本物のチャドバーン（オリンピック級の船橋のテレグラフ）は、ハンドルを動かすと
// 中の打ち子が真鍮のお椀形のゴングを「チリリン、チリリン」と連打し、機関室の
// テレグラフも同じようなゴングで応える。
//   phone   : 電話のようなベル「ジリリン」（オリンピック級・クイーン・メリー風の標準）
//   gong    : 真鍮のゴング「コーン」。1打ぶんの音（ゴングの倍音・うなり・打ち子の当たる音）を
//             一度だけ計算して作り、それを少しずつ強さ・音程・間隔を変えて打つ。
//             船橋の中の響きも少し足す。機関室の応答は低めで遠く、こもって聞こえる
//   classic : 以前の小さなベル（速い連打）
//   electric: 現代型の電子音
function _bellKind() {
    if (bridgeUI.bell && bridgeUI.bell !== 'auto') return bridgeUI.bell;
    const d = bridgeUI.telegraph;
    if (d === 'olympic' || d === 'queenmary') return 'phone';
    if (d === 'modern') return 'electric';
    return 'classic';
}

const _gong = { ctx: null, buf: {}, verb: null };
// 1打ぶんのゴングの音（f0：いちばん低い音の高さ）
// decay：減衰の長さの倍率（1＝ゴング、0.3くらい＝電話の小さなベル）
// bright：高い倍音と打ち子の音を強める量（0＝ゴング、1くらい＝電話のベルの鋭い音）
function _gongStrikeBuffer(c, f0, dark, decay = 1, bright = 0) {
    const key = f0 + ':' + (dark ? 1 : 0) + ':' + decay + ':' + bright;
    if (_gong.ctx !== c) { _gong.ctx = c; _gong.buf = {}; _gong.verb = null; }
    if (_gong.buf[key]) return _gong.buf[key];
    const sr = c.sampleRate, len = Math.floor(sr * Math.max(0.6, 2.6 * decay));
    const buf = c.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    // お椀形のベルの倍音（整数倍ではない）。それぞれ2本のわずかにずれた音にして、
    // 本物のベルのような「ワンワン」といううなりを出す
    const parts = [
        { r: 0.5,  a: 0.10, t: 1.6 },
        { r: 1.0,  a: 1.00, t: 2.1 },
        { r: 2.32, a: 0.55, t: 1.25 },
        { r: 3.97, a: 0.34, t: 0.7 },
        { r: 5.91, a: 0.20, t: 0.42 },
        { r: 8.13, a: dark ? 0.04 : 0.10, t: 0.22 },
        { r: 10.6, a: dark ? 0.01 : 0.05, t: 0.12 },
    ];
    if (bright > 0) {
        // 薄い小さなベル：高い倍音が強く、長めに残る（「チリ」という鋭さ）
        for (const p of parts) if (p.r >= 3.9) { p.a *= 1 + 1.6 * bright; p.t *= 1 + 0.8 * bright; }
        parts.push({ r: 13.4, a: 0.12 * bright, t: 0.09 }, { r: 16.9, a: 0.07 * bright, t: 0.06 });
        parts[0].a *= 0.3;   // 低いうなりは小さく
    }
    for (const p of parts) {
        const f = f0 * p.r;
        if (f > sr * 0.45) continue;
        const beat = 0.6 + p.r * 0.35;          // うなりの速さ[Hz]
        const w1 = 2 * Math.PI * (f - beat / 2) / sr, w2 = 2 * Math.PI * (f + beat / 2) / sr;
        const ph1 = Math.random() * 6.28, ph2 = Math.random() * 6.28;
        const k = 1 / (p.t * decay * sr);
        for (let i = 0; i < len; i++) {
            const env = Math.exp(-i * k);
            if (env < 1e-4) break;
            d[i] += p.a * env * 0.5 * (Math.sin(w1 * i + ph1) + Math.sin(w2 * i + ph2));
        }
    }
    // 打ち子が当たる「カッ」（ごく短い金属的な雑音）
    let lp = 0;
    const clickLen = Math.floor(sr * 0.012);
    for (let i = 0; i < clickLen; i++) {
        const n = Math.random() * 2 - 1;
        lp += (n - lp) * 0.55;
        d[i] += (n - lp) * (0.5 + 1.1 * bright) * Math.exp(-i / (sr * 0.0025));
    }
    // 立ち上がりを 1ms かけて滑らかに（プチッという音を防ぐ）
    const a = Math.floor(sr * 0.001);
    for (let i = 0; i < a; i++) d[i] *= i / a;
    let peak = 0; for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(d[i]));
    for (let i = 0; i < len; i++) d[i] /= peak || 1;
    _gong.buf[key] = buf;
    return buf;
}
// 船橋の中の短い響き（作った雑音の残響）
function _gongVerb(c, dest) {
    if (_gong.ctx !== c) { _gong.ctx = c; _gong.buf = {}; _gong.verb = null; }
    if (!_gong.verb) {
        const sr = c.sampleRate, len = Math.floor(sr * 0.9);
        const ir = c.createBuffer(2, len, sr);
        for (let ch = 0; ch < 2; ch++) {
            const d = ir.getChannelData(ch);
            for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3) * Math.exp(-i / (sr * 0.18));
        }
        const conv = c.createConvolver();
        conv.buffer = ir;
        const g = c.createGain(); g.gain.value = 0.35;
        conv.connect(g); g.connect(dest);
        _gong.verb = conv;
    }
    return _gong.verb;
}

function _gongRing(c, dest, t0, answer, steps) {
    const f0 = answer ? 930 : 1175;
    const buf = _gongStrikeBuffer(c, f0, answer);
    const out = c.createGain();
    out.gain.value = answer ? 0.32 : 0.55;
    let node = out;
    if (answer) {
        // 機関室の応答：下の方から伝わってくるので、こもって遠い
        const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2600; lp.Q.value = 0.5;
        out.connect(lp); node = lp;
    }
    node.connect(dest);
    const verb = _gongVerb(c, dest);
    const send = c.createGain(); send.gain.value = answer ? 0.9 : 0.45;
    node.connect(send); send.connect(verb);
    // 打つ回数：ハンドルを大きく動かすほど長く鳴る
    const n = answer ? 5 + Math.floor(Math.random() * 2) : Math.min(14, 5 + 2 * Math.max(1, steps || 1));
    let s = t0;
    for (let k = 0; k < n; k++) {
        const src = c.createBufferSource();
        src.buffer = buf;
        src.playbackRate.value = 1 + (Math.random() - 0.5) * 0.004;
        const g = c.createGain();
        // 打つ強さはばらつき、最後は少し弱まる
        const vel = (0.72 + 0.28 * Math.random()) * (1 - 0.35 * k / n);
        g.gain.value = vel;
        // 弱く打つと高い音が出にくい
        const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.4;
        lp.frequency.value = 3500 + 9000 * vel;
        src.connect(lp); lp.connect(g); g.connect(out);
        src.start(s);
        src.stop(s + 2.6);
        // 打ち子の間隔（ラチェットなので少し不規則）
        s += (1 / 8.5) * (0.85 + Math.random() * 0.3);
    }
}

// 電話のようなベル「ジリリン」：打ち子が2つの小さな椀形のベルを1秒に20回ほど
// 交互に叩く。1打ずつは短く減衰するが、速く叩くので重なって「ジリリリ」と続く。
// 2つのベルは少し高さが違い、打ち子の当たる「カチ」も混ざる
// 電話ベルの2つの椀の高さ[Hz]（指令・応答）
const PHONE_BELL_F = { order: [1250, 1400], answer: [980, 1090] };
function _phoneRing(c, dest, t0, answer, steps) {
    const [fA, fB] = PHONE_BELL_F[answer ? 'answer' : 'order'];
    const bufA = _gongStrikeBuffer(c, fA, false, 0.28, answer ? 0.6 : 1);
    const bufB = _gongStrikeBuffer(c, fB, false, 0.28, answer ? 0.6 : 1);
    const out = c.createGain();
    out.gain.value = answer ? 0.3 : 0.42;
    let node = out;
    if (answer) {
        const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 6000; lp.Q.value = 0.5;
        out.connect(lp); node = lp;
    }
    node.connect(dest);
    const verb = _gongVerb(c, dest);
    const send = c.createGain(); send.gain.value = answer ? 0.45 : 0.14;
    node.connect(send); send.connect(verb);
    // 1回の「ジリン」：打ち子が数回だけ速く当たって、あとは余韻（何段動かしても1回）
    const rate = 19 + Math.random() * 3;            // 1秒に叩く回数
    const n = 5;
    for (let k = 0; k < n; k++) {
        const src = c.createBufferSource();
        src.buffer = (k & 1) ? bufB : bufA;
        src.playbackRate.value = 1 + (Math.random() - 0.5) * 0.003;
        const g = c.createGain();
        // 最初の一打が強く、あとは打ち子の振れが小さくなっていく
        g.gain.value = [1, 0.8, 0.7, 0.55, 0.4][k] * (0.85 + 0.15 * Math.random());
        src.connect(g); g.connect(out);
        src.start(t0 + k / rate + (k ? (Math.random() - 0.5) * 0.004 : 0));
        src.stop(t0 + k / rate + 1.2);
    }
}

function telegraphBell(kind, answer, steps) {
    if (typeof audioEnsure !== 'function' || !audioEnsure() || !audio.buses.bridge) return;
    const c = audio.ctx, dest = audio.buses.bridge;
    const t0 = c.currentTime + 0.01;
    const bell = _bellKind();
    if (bell === 'electric') {
        // 電子音「ピピッ・ピピッ」
        for (let i = 0; i < (answer ? 2 : 4); i++) {
            const o = c.createOscillator(); o.type = 'square';
            o.frequency.value = answer ? 1760 : 2350;
            const g = c.createGain();
            const s = t0 + i * 0.14;
            g.gain.setValueAtTime(0, s);
            g.gain.linearRampToValueAtTime(0.12, s + 0.005);
            g.gain.setValueAtTime(0.12, s + 0.07);
            g.gain.linearRampToValueAtTime(0, s + 0.08);
            o.connect(_mkFilter('lowpass', 5000, 0.7, g)); g.connect(dest);
            o.start(s); o.stop(s + 0.1);
        }
        return;
    }
    if (bell === 'phone') {
        if (!answer && typeof audioBurst === 'function') audioBurst(dest, { dur: 0.05, attack: 0.001, gain: 0.16, type: 'bandpass', freq: 900, q: 2.5 });
        _phoneRing(c, dest, t0 + (answer ? 0 : 0.03), answer, steps);
        return;
    }
    if (bell === 'gong') {
        // ハンドルが止まる「カチッ」（真鍮の機構の低めの音）
        if (!answer && typeof audioBurst === 'function') audioBurst(dest, { dur: 0.05, attack: 0.001, gain: 0.18, type: 'bandpass', freq: 900, q: 2.5 });
        _gongRing(c, dest, t0 + (answer ? 0 : 0.03), answer, steps);
        return;
    }
    const f = answer ? 1650 : (kind === 'warship' ? 2600 : 2100);
    const rate = kind === 'warship' ? 22 : 15;          // 1秒に打つ回数
    const dur = answer ? 0.55 : 0.8;
    const vol = answer ? 0.35 : 0.6;
    const out = c.createGain(); out.gain.value = vol; out.connect(dest);
    // 機関室からの応答は、少しこもって聞こえる
    let target = out;
    if (answer) { const lp = _mkFilter('lowpass', 3000, 0.6, out); target = lp; }
    const ratios = [1, 1.51, 2.02, 2.74, 3.4], amps = [1, 0.5, 0.35, 0.2, 0.12];
    const n = Math.round(dur * rate);
    for (let k = 0; k < n; k++) {
        const s = t0 + k / rate + (Math.random() - 0.5) * 0.004;
        const a = (0.6 + 0.4 * Math.random()) * (1 - 0.4 * k / n);
        ratios.forEach((r, i) => {
            const o = c.createOscillator(); o.type = 'sine';
            o.frequency.value = f * r;
            const g = c.createGain();
            g.gain.setValueAtTime(0, s);
            g.gain.linearRampToValueAtTime(amps[i] * a, s + 0.002);
            g.gain.exponentialRampToValueAtTime(0.0005, s + 0.25 / (1 + i * 0.5));
            o.connect(g); g.connect(target);
            o.start(s); o.stop(s + 0.3);
        });
    }
    // ハンドルを動かしたときの機械の「ガチャ」
    if (!answer && typeof audioBurst === 'function') audioBurst(dest, { dur: 0.08, attack: 0.002, gain: 0.25, type: 'bandpass', freq: 1400, q: 1.2 });
}
window.telegraphBell = telegraphBell;

// 指令が変わったとき（ボタン・キー・画面のテレグラフのどこからでも）
// prevSpecial を渡さないとき（速度の指令）は、スタンバイ・機関終了を解く
function onTelegraphOrder(prev, next, prevSpecial) {
    const ps = prevSpecial !== undefined ? prevSpecial : physics.telegraphSpecial;
    if (prevSpecial === undefined) physics.telegraphSpecial = '';
    if (prev === next && ps === physics.telegraphSpecial) return;
    telegraphBell(bridgeUI.telegraph, false, Math.abs((next || 0) - (prev || 0)) || 1);
    // 機関終了で止めた機関を起こすには時間がかかる
    const wake = (physics.telegraphAnswerSpecial === 'fwe' && physics.telegraphSpecial !== 'fwe') ? TG_FWE_WAKE : 1;
    _br.answerAt = performance.now() + TG_ANSWER_DELAY * wake * 1000 * (0.8 + Math.random() * 0.5);
    _br.dirtyT = true;
}
window.onTelegraphOrder = onTelegraphOrder;
function setTelegraphOrder(v) {
    v = Math.max(-3, Math.min(3, Math.round(v)));
    const prev = physics.telegraphState;
    physics.telegraphState = v;
    onTelegraphOrder(prev, v);
}
function setTelegraphSpecial(sp) {
    if (!_TG_SPECIAL[sp]) return;
    const prev = physics.telegraphState, ps = physics.telegraphSpecial;
    physics.telegraphState = 0;
    physics.telegraphSpecial = sp;
    onTelegraphOrder(prev, 0, ps);
}
window.setTelegraphSpecial = setTelegraphSpecial;
// 舵中央（ミジップ）：舵輪を真ん中へ（キーボードの C・舵輪の中心をダブルタップ）
// 舵輪は一瞬で戻さず、手で回して戻すように回転させる（古典的な舵輪は1周ごとにベルも鳴る）
const WHEEL_CENTER_RATE = { classic: 6 * 360, handle: 540, azipod: 120 };   // 戻す速さ[度/秒]（古典的な舵輪は1秒6周＝1周ごとのベルが全部聞こえる速さ）
function bridgeCenterHelm() {
    if (!bridgeWheelActive()) { physics.helmOrder = 0; return; }
    _br.wheelTarget = 0;
}
window.bridgeCenterHelm = bridgeCenterHelm;

// ════════════════════════════════════════════════════════════════
//  描画の道具
// ════════════════════════════════════════════════════════════════
const _deg = (d) => d * Math.PI / 180;
function _brass(ctx, x0, y0, x1, y1, dark) {
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, dark ? '#5a4214' : '#fff1b8');
    g.addColorStop(0.35, dark ? '#9c7a2e' : '#e0b85a');
    g.addColorStop(0.6, dark ? '#6b5019' : '#a8832f');
    g.addColorStop(1, dark ? '#3a2a0c' : '#f3d27a');
    return g;
}
function _chrome(ctx, x0, y0, x1, y1) {
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, '#f4f6f8'); g.addColorStop(0.3, '#9aa3ad'); g.addColorStop(0.55, '#e8ecf0'); g.addColorStop(1, '#5d6670');
    return g;
}
function _ring(ctx, cx, cy, r0, r1, fill) {
    ctx.beginPath(); ctx.arc(cx, cy, r1, 0, Math.PI * 2); ctx.arc(cx, cy, r0, 0, Math.PI * 2, true);
    ctx.fillStyle = fill; ctx.fill('evenodd');
}
// 彫り込み文字：暗い溝＋下側の光の縁
function _engraved(ctx, text, x, y, color) {
    ctx.fillStyle = 'rgba(255,245,210,0.55)'; ctx.fillText(text, x + 0.6, y + 0.8);
    ctx.fillStyle = color || '#3b2708'; ctx.fillText(text, x, y);
}
// 円に沿って文字を並べる（中心角 a0 から時計回りに）
// flip：円の下側で文字が逆さにならないよう、内向きに右から左へ並べる
function _textOnArc(ctx, text, cx, cy, r, aCenter, engraved, color, flip) {
    const chars = [...text];
    const widths = chars.map(ch => ctx.measureText(ch).width);
    const total = widths.reduce((a, b) => a + b, 0);
    const dir = flip ? -1 : 1;
    let a = aCenter - dir * total / r / 2;
    chars.forEach((ch, i) => {
        const w = widths[i];
        const am = a + dir * w / r / 2;
        ctx.save();
        ctx.translate(cx + Math.sin(am) * r, cy - Math.cos(am) * r);
        ctx.rotate(flip ? am + Math.PI : am);
        if (engraved) _engraved(ctx, ch, -w / 2, 0, color);
        else { ctx.fillStyle = color || '#111'; _tgText(ctx, ch, -w / 2, 0); }
        ctx.restore();
        a += dir * w / r;
    });
}
function _screw(ctx, x, y, r) {
    ctx.fillStyle = _brass(ctx, x - r, y - r, x + r, y + r, true);
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = r * 0.3;
    ctx.beginPath(); ctx.moveTo(x - r * 0.7, y); ctx.lineTo(x + r * 0.7, y); ctx.stroke();
}
function _needle(ctx, cx, cy, ang, len, w, color, tail) {
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(ang);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, -len); ctx.lineTo(w, 0); ctx.lineTo(w * 0.6, tail || len * 0.18); ctx.lineTo(-w * 0.6, tail || len * 0.18); ctx.lineTo(-w, 0);
    ctx.closePath(); ctx.fill();
    ctx.restore();
}

// 前後に倒すレバー：指令（-3〜3）→ 画面の縦の位置（上＝奥＝前進）
function _tgForeGeom(S) {
    const cx = S * 0.5, yc = S * 0.57, step = S * 0.1;
    return { cx, yc, step, pivY: S * 0.93, yOf: (v) => yc - v * step };
}
// 指令（-3〜3）→ 文字盤の角度（上が0、右回りが正）。形式ごとに向きと幅が違う
const _TG_STEP = { olympic: -33, queenmary: -31, warship: 36, rotary: 40, tilt: 13 };
function _tgAngle(design, v) {
    switch (design) {
        case 'olympic':   return _deg(-v * 33);      // 左が前進、右が後進（チャドバーン型）
        case 'queenmary': return _deg(-v * 31);
        case 'warship':   return _deg(v * 36);       // 右回りに前進（計器）
        case 'rotary':    return _deg(v * 40);
        case 'tilt':      return _deg(v * 13);
        default:          return 0;
    }
}

// ════════════════════════════════════════════════════════════════
//  テレグラフの描画
// ════════════════════════════════════════════════════════════════
// ── 盤面の色（白基調・黒基調）と夜の照明 ──
//  白基調：白いほうろう・明るいパネルに黒文字（夜は盤面の裏から照らしたように光る）
//  黒基調：黒い盤面に金・色文字（夜は文字が光る＝夜光・照明文字）
//  暗くなるほど（昼夜係数）ケースやハンドルは暗くなり、盤面と文字だけが光って見える。
const TG_THEMES = { auto: 'デザインに合わせる', white: '白基調', black: '黒基調' };
window.TG_THEMES = TG_THEMES;
function _tgTheme(design) {
    const t = bridgeUI.tgTheme;
    if (t === 'white' || t === 'black') return t;
    return design === 'olympic' ? 'white' : 'black';
}
function _tgNight() {
    if (bridgeUI.tgLit === false) return 0;
    const nf = (typeof lightingNightFactor !== 'undefined') ? lightingNightFactor : 0;
    return Math.max(0, Math.min(1, nf));
}
function _tgPalette(theme) {
    return theme === 'white' ? {
        white: true,
        panel: '#e6e3dc', panelEdge: '#a9a397', ahead: '#17692f', astern: '#b3261e', stop: '#1a1a1a', tick: '#6b6b6b',
        sel: '#b86e00', btnOff: '#f7f5f0', btnEdge: '#b9b3a6', textOff: '#2b2b2b', gauge: '#f3f0e8', gaugeText: '#1a1a1a', sub: '#5a5a5a',
        glow: 'rgba(255,214,150,0.95)',
    } : {
        white: false,
        panel: '#20252b', panelEdge: '#3a4048', ahead: '#8ff0ad', astern: '#ff8a73', stop: '#f2f2f2', tick: '#6c7580',
        sel: '#ffd23c', btnOff: '#262b31', btnEdge: '#3a4048', textOff: '#f2f2f2', gauge: '#0c0f10', gaugeText: '#d8dde0', sub: '#9aa3ad',
        glow: null,   // 文字それぞれの色で光る
    };
}
// 文字を書く（夜は文字が光る）
let _tgGlowPx = 0, _tgGlowCol = null;
function _tgText(ctx, text, x, y) {
    if (_tgGlowPx > 0) {
        ctx.save();
        ctx.shadowColor = _tgGlowCol || ctx.fillStyle;
        ctx.shadowBlur = _tgGlowPx;
        ctx.fillText(text, x, y);
        ctx.restore();
    }
    ctx.fillText(text, x, y);
}
// いま描いてある物（ケース・パネル）だけを暗くする
function _tgDim(ctx, S, k) {
    if (k <= 0.001) return;
    ctx.save();
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = `rgba(4,6,12,${k})`;
    ctx.fillRect(0, 0, S, S);
    ctx.restore();
}
// 夜：パネルの裏から照らした光（白基調）・ほのかな照り返し（黒基調）
function _tgBacklight(ctx, x, y, w, h, r, night, white) {
    if (night <= 0.001) return;
    ctx.save();
    const g = ctx.createRadialGradient(x + w / 2, y + h / 2, 0, x + w / 2, y + h / 2, Math.max(w, h) * 0.7);
    if (white) { g.addColorStop(0, `rgba(255,236,196,${0.55 * night})`); g.addColorStop(1, `rgba(255,214,150,${0.25 * night})`); }
    else { g.addColorStop(0, `rgba(255,190,110,${0.1 * night})`); g.addColorStop(1, 'rgba(255,190,110,0)'); }
    ctx.globalCompositeOperation = white ? 'source-atop' : 'lighter';
    ctx.fillStyle = g;
    _roundRect(ctx, x, y, w, h, r); ctx.fill();
    ctx.restore();
}

function _drawTelegraph(ctx, S, design, handleV, answerV, order, special, ansSpecial) {
    ctx.clearRect(0, 0, S, S);
    const cx = S / 2, cy = S * 0.54, R = S * 0.44;
    const hAng = _tgAngle(design, handleV), aAng = _tgAngle(design, answerV);
    const theme = _tgTheme(design), P = _tgPalette(theme);
    const night = _tgNight();
    const dimK = 0.62 * night;                       // ケース・ハンドルの暗さ
    _tgGlowPx = night > 0.02 ? S * 0.035 * night : 0;
    _tgGlowCol = P.glow;

    if (design === 'olympic' || design === 'queenmary') {
        const deco = design === 'queenmary';
        const dark = theme === 'black';
        const font = deco ? '"Futura","Avenir Next","Century Gothic",sans-serif' : 'Georgia,"Times New Roman",serif';
        // 胴（ケース）
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = S * 0.05; ctx.shadowOffsetY = S * 0.02;
        ctx.fillStyle = deco ? _brass(ctx, 0, 0, S, S, true) : _brass(ctx, 0, 0, S, S);
        ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
        _ring(ctx, cx, cy, R * 0.86, R * 0.95, deco ? 'rgba(20,14,4,0.55)' : 'rgba(80,55,10,0.45)');
        // ケースのねじ
        for (let i = 0; i < 6; i++) { const a = _deg(30 + i * 60); _screw(ctx, cx + Math.sin(a) * R * 0.905, cy - Math.cos(a) * R * 0.905, S * 0.012); }
        _tgDim(ctx, S, dimK);
        // 文字盤（夜は裏から照らされて光る）
        const face = ctx.createRadialGradient(cx - R * 0.2, cy - R * 0.3, R * 0.1, cx, cy, R * 0.86);
        if (dark) { face.addColorStop(0, '#1d1a14'); face.addColorStop(1, '#050403'); }
        else if (night > 0.02) {
            const mix = (c1, c2) => c1.map((v, i) => Math.round(v + (c2[i] - v) * night));
            const c0 = mix([255, 253, 244], [255, 243, 212]), c1 = mix([232, 224, 204], [246, 222, 170]);
            face.addColorStop(0, `rgb(${c0})`); face.addColorStop(1, `rgb(${c1})`);
        } else { face.addColorStop(0, '#fffdf4'); face.addColorStop(1, '#e8e0cc'); }
        ctx.save();
        if (!dark && night > 0.02) { ctx.shadowColor = `rgba(255,214,150,${0.9 * night})`; ctx.shadowBlur = S * 0.07 * night; }
        ctx.fillStyle = face;
        ctx.beginPath(); ctx.arc(cx, cy, R * 0.84, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
        if (dark && night > 0.02) {
            // 黒い盤面：中心からほのかに照らされる
            const gl = ctx.createRadialGradient(cx, cy, R * 0.1, cx, cy, R * 0.84);
            gl.addColorStop(0, `rgba(255,200,120,${0.12 * night})`); gl.addColorStop(1, 'rgba(255,200,120,0)');
            ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(cx, cy, R * 0.84, 0, Math.PI * 2); ctx.fill();
        }
        if (deco) {
            // アールデコの放射線（サンバースト）
            ctx.strokeStyle = dark ? 'rgba(212,175,90,0.25)' : 'rgba(150,110,30,0.22)'; ctx.lineWidth = 1;
            for (let i = -12; i <= 12; i++) {
                const a = _deg(i * 7.5);
                ctx.beginPath(); ctx.moveTo(cx + Math.sin(a) * R * 0.2, cy - Math.cos(a) * R * 0.2);
                ctx.lineTo(cx + Math.sin(a) * R * 0.8, cy - Math.cos(a) * R * 0.8); ctx.stroke();
            }
            _ring(ctx, cx, cy, R * 0.8, R * 0.82, '#c9a24c');
        }
        // 区切りと文字（白基調：前進は黒・後進は赤。黒基調：金と朱）
        const step = deco ? 31 : 33;
        const lineCol = dark ? 'rgba(201,162,76,0.7)' : 'rgba(0,0,0,0.45)';
        ctx.textBaseline = 'middle';
        for (let v = -3; v <= 3; v++) {
            const a = _tgAngle(design, v);
            const lab = _TG_LABEL[v];
            const col = dark ? (v < 0 ? '#e0674a' : (v === 0 ? '#f3e6c0' : '#d9b45a')) : (v < 0 ? '#b3140f' : '#101010');
            ctx.font = `bold ${Math.round(S * (v === 0 ? 0.052 : 0.046))}px ${font}`;
            _textOnArc(ctx, lab, cx, cy, R * 0.68, a, false, col);
            // 区切り線
            const b = _deg((v + 0.5) * -step);
            if (v < 3) {
                ctx.strokeStyle = lineCol; ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(cx + Math.sin(b) * R * 0.5, cy - Math.cos(b) * R * 0.5);
                ctx.lineTo(cx + Math.sin(b) * R * 0.83, cy - Math.cos(b) * R * 0.83); ctx.stroke();
            }
            if (v === order && !special) {
                // 指令中の区画をうっすら強調
                ctx.fillStyle = dark ? 'rgba(212,175,90,0.18)' : 'rgba(255,200,60,0.25)';
                ctx.beginPath(); ctx.moveTo(cx, cy);
                ctx.arc(cx, cy, R * 0.83, a - Math.PI / 2 - _deg(step / 2), a - Math.PI / 2 + _deg(step / 2)); ctx.closePath(); ctx.fill();
            }
        }
        // 両端：スタンバイ（前進側）と機関終了（後進側）。下側なので文字は内向き
        for (const [key, sp] of Object.entries(_TG_SPECIAL)) {
            const a = _tgAngle(design, sp.v);
            ctx.font = `bold ${Math.round(S * 0.036)}px ${font}`;
            // 機関終了は長いので「FINISHED」だけ（下の銘板に日本語で出る）
            _textOnArc(ctx, key === 'fwe' ? 'FINISHED' : sp.en, cx, cy, R * 0.7, a, false, dark ? '#9fc3d9' : '#1d3f73', true);
            const b = _tgAngle(design, sp.v > 0 ? 3.5 : -3.5);
            ctx.strokeStyle = lineCol; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(cx + Math.sin(b) * R * 0.5, cy - Math.cos(b) * R * 0.5);
            ctx.lineTo(cx + Math.sin(b) * R * 0.83, cy - Math.cos(b) * R * 0.83); ctx.stroke();
            if (special === key) {
                ctx.fillStyle = dark ? 'rgba(160,200,230,0.18)' : 'rgba(60,120,220,0.18)';
                ctx.beginPath(); ctx.moveTo(cx, cy);
                ctx.arc(cx, cy, R * 0.83, a - Math.PI / 2 - _deg(step / 2), a - Math.PI / 2 + _deg(step / 2)); ctx.closePath(); ctx.fill();
            }
        }
        ctx.font = `bold ${Math.round(S * 0.042)}px ${font}`;
        ctx.textAlign = 'center';
        // 本物と同じく、前進・後進の文字は文字盤の上半分の内側に
        ctx.fillStyle = dark ? '#d9b45a' : '#101010'; _tgText(ctx, 'AHEAD', cx - R * 0.33, cy - R * 0.22);
        ctx.fillStyle = dark ? '#e0674a' : '#b3140f'; _tgText(ctx, 'ASTERN', cx + R * 0.33, cy - R * 0.22);
        // 下半分：銘板
        ctx.font = `${Math.round(S * 0.045)}px ${font}`;
        ctx.fillStyle = dark ? '#c9a24c' : '#3a2c10';
        _tgText(ctx, deco ? 'ENGINE ORDER' : 'ENGINE ROOM', cx, cy + R * 0.42);
        ctx.font = `${Math.round(S * 0.035)}px ${font}`;
        _tgText(ctx, special ? _TG_SPECIAL[special].jp : _TG_JP[order], cx, cy + R * 0.58);
        ctx.textAlign = 'start';
        // 応答の針（赤・内側）と、指令の針
        _needle(ctx, cx, cy, aAng, R * 0.42, S * 0.018, '#c0201a');
        _needle(ctx, cx, cy, hAng, R * 0.8, S * 0.03, dark ? _brass(ctx, cx - R, cy - R, cx + R, cy + R) : '#2a2a2a');
        // 中心のボス
        ctx.fillStyle = _brass(ctx, cx - R * 0.1, cy - R * 0.1, cx + R * 0.1, cy + R * 0.1);
        ctx.beginPath(); ctx.arc(cx, cy, R * 0.09, 0, Math.PI * 2); ctx.fill();
        // ガラスの映り込み（夜は弱く）
        const gl = ctx.createLinearGradient(cx - R, cy - R, cx + R * 0.3, cy + R * 0.2);
        const gk = 1 - 0.75 * night;
        gl.addColorStop(0, `rgba(255,255,255,${0.28 * gk})`); gl.addColorStop(0.5, `rgba(255,255,255,${0.03 * gk})`); gl.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(cx, cy, R * 0.84, 0, Math.PI * 2); ctx.fill();
        // 外のハンドル（ケースの外まで伸びる把手）。夜はケースと同じく暗く
        ctx.save(); ctx.translate(cx, cy); ctx.rotate(hAng);
        ctx.fillStyle = _brass(ctx, -S * 0.03, -R * 1.18, S * 0.03, -R * 0.9);
        ctx.fillRect(-S * 0.016, -R * 1.12, S * 0.032, R * 0.24);
        ctx.beginPath(); ctx.arc(0, -R * 1.14, S * 0.045, 0, Math.PI * 2);
        ctx.fillStyle = deco ? '#1a1a1a' : '#5b2b12'; ctx.fill();
        if (dimK > 0.001) {
            ctx.fillStyle = `rgba(4,6,12,${dimK})`;
            ctx.fillRect(-S * 0.016, -R * 1.12, S * 0.032, R * 0.24);
            ctx.beginPath(); ctx.arc(0, -R * 1.14, S * 0.045, 0, Math.PI * 2); ctx.fill();
        }
        ctx.restore();
        _tgGlowPx = 0;
        return;
    }

    if (design === 'warship') {
        // 計器：前進（緑）・後進（赤）の目盛り
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,0.7)'; ctx.shadowBlur = S * 0.04;
        ctx.fillStyle = _chrome(ctx, 0, 0, S, S);
        ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
        _drawSpecialBtns(ctx, S, design, special, ansSpecial, P, true);
        _tgDim(ctx, S, dimK);
        ctx.fillStyle = P.gauge; ctx.beginPath(); ctx.arc(cx, cy, R * 0.9, 0, Math.PI * 2); ctx.fill();
        _tgBacklight(ctx, cx - R * 0.9, cy - R * 0.9, R * 1.8, R * 1.8, R * 0.9, night, P.white);
        const arc = (a0, a1, col) => { ctx.strokeStyle = col; ctx.lineWidth = S * 0.035; ctx.beginPath(); ctx.arc(cx, cy, R * 0.74, a0 - Math.PI / 2, a1 - Math.PI / 2); ctx.stroke(); };
        arc(_deg(4), _deg(126), P.white ? '#2e9a4c' : '#1f8a3a');
        arc(_deg(-126), _deg(-4), P.white ? '#c23a32' : '#a51c1c');
        ctx.strokeStyle = P.gaugeText; ctx.fillStyle = P.gaugeText;
        for (let i = -30; i <= 30; i++) {
            const a = _deg(i * 3.6 * 1.166);
            if (Math.abs(i * 3.6 * 1.166) > 126) continue;
            const major = i % 10 === 0, mid = i % 5 === 0;
            ctx.lineWidth = major ? 2 : 1;
            const r0 = R * (major ? 0.62 : (mid ? 0.66 : 0.69));
            ctx.beginPath(); ctx.moveTo(cx + Math.sin(a) * r0, cy - Math.cos(a) * r0); ctx.lineTo(cx + Math.sin(a) * R * 0.8, cy - Math.cos(a) * R * 0.8); ctx.stroke();
        }
        ctx.font = `bold ${Math.round(S * 0.05)}px "Helvetica Neue",Arial,sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        for (let v = -3; v <= 3; v++) {
            const a = _tgAngle(design, v);
            ctx.fillStyle = v > 0 ? P.ahead : (v < 0 ? P.astern : P.stop);
            _tgText(ctx, v === 0 ? 'STOP' : String(Math.abs(v) * 33 + (Math.abs(v) === 3 ? 1 : 0)), cx + Math.sin(a) * R * 0.5, cy - Math.cos(a) * R * 0.5);
        }
        ctx.font = `bold ${Math.round(S * 0.042)}px "Helvetica Neue",Arial,sans-serif`;
        ctx.fillStyle = P.ahead; _tgText(ctx, 'AHEAD', cx + R * 0.34, cy + R * 0.42);
        ctx.fillStyle = P.astern; _tgText(ctx, 'ASTERN', cx - R * 0.34, cy + R * 0.42);
        ctx.fillStyle = P.sub; ctx.font = `${Math.round(S * 0.034)}px "Helvetica Neue",Arial,sans-serif`;
        _tgText(ctx, 'REVOLUTIONS %', cx, cy + R * 0.26);
        // 小窓：指令（デジタル）
        ctx.fillStyle = '#021a08'; ctx.fillRect(cx - R * 0.33, cy + R * 0.5, R * 0.66, R * 0.2);
        ctx.fillStyle = order < 0 ? '#ff6b60' : '#5dff8a'; ctx.font = `bold ${Math.round(S * 0.05)}px "Courier New",monospace`;
        _tgText(ctx, special ? _TG_SPECIAL[special].short : `${order > 0 ? 'AH' : order < 0 ? 'AS' : ''} ${_TG_LABEL[order]}`, cx, cy + R * 0.6);
        ctx.textAlign = 'start';
        _needle(ctx, cx, cy, aAng, R * 0.55, S * 0.016, '#ff3b30');
        _needle(ctx, cx, cy, hAng, R * 0.8, S * 0.025, P.white ? '#1f2328' : '#f5f0e0');
        ctx.fillStyle = _chrome(ctx, cx - 8, cy - 8, cx + 8, cy + 8);
        ctx.beginPath(); ctx.arc(cx, cy, R * 0.08, 0, Math.PI * 2); ctx.fill();
        _drawSpecialBtns(ctx, S, design, special, ansSpecial, P);
        _tgGlowPx = 0;
        return;
    }

    if (design === 'modern') {
        // 押しボタンのパネル（上から全速前進〜全速後進）
        const x0 = S * 0.14, w = S * 0.72, y0 = S * 0.05, h = S * 0.9;
        ctx.fillStyle = P.white ? '#cfd4da' : '#16191d'; _roundRect(ctx, x0, y0, w, h, S * 0.04); ctx.fill();
        ctx.strokeStyle = P.white ? '#9aa3ad' : '#3a4048'; ctx.lineWidth = 2; ctx.stroke();
        _tgDim(ctx, S, dimK);
        const bh = h / 8.6;
        for (let k = 0; k < 7; k++) {
            const v = 3 - k;
            const by = y0 + S * 0.03 + (k + 1) * bh;      // 1段目はスタンバイ・機関終了
            const on = v === order && !special, ans = v === Math.round(answerV) && !ansSpecial;
            ctx.fillStyle = on ? (v < 0 ? '#ff5a3c' : (v === 0 ? '#ffd23c' : '#46e07a')) : P.btnOff;
            ctx.save();
            if (on && night > 0.02) { ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = S * 0.05 * night; }
            _roundRect(ctx, x0 + S * 0.05, by, w - S * 0.1, bh * 0.82, S * 0.02); ctx.fill();
            ctx.restore();
            if (!on) _tgBacklight(ctx, x0 + S * 0.05, by, w - S * 0.1, bh * 0.82, S * 0.02, night * 0.8, P.white);
            if (ans && !on) { ctx.strokeStyle = P.sel; ctx.lineWidth = 2; _roundRect(ctx, x0 + S * 0.05, by, w - S * 0.1, bh * 0.82, S * 0.02); ctx.stroke(); }
            ctx.fillStyle = on ? '#101010' : (v < 0 ? P.astern : (v === 0 ? P.stop : P.ahead));
            ctx.font = `bold ${Math.round(S * 0.052)}px "Helvetica Neue",Arial,sans-serif`;
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            _tgText(ctx, v === 0 ? 'STOP' : `${_TG_LABEL[v]} ${v > 0 ? 'AHEAD' : 'ASTERN'}`, x0 + w / 2, by + bh * 0.41);
        }
        _drawSpecialBtns(ctx, S, design, special, ansSpecial, P);
        _tgGlowPx = 0;
        return;
    }

    if (design === 'rotary') {
        // 目盛りの付いた回転つまみ
        ctx.fillStyle = P.panel; _roundRect(ctx, S * 0.05, S * 0.08, S * 0.9, S * 0.86, S * 0.06); ctx.fill();
        if (P.white) { ctx.strokeStyle = P.panelEdge; ctx.lineWidth = 1.5; ctx.stroke(); }
        _tgDim(ctx, S, dimK);
        _tgBacklight(ctx, S * 0.05, S * 0.08, S * 0.9, S * 0.86, S * 0.06, night, P.white);
        ctx.font = `bold ${Math.round(S * 0.048)}px "Helvetica Neue",Arial,sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        for (let v = -3; v <= 3; v++) {
            const a = _tgAngle(design, v);
            ctx.fillStyle = (v === order && !special) ? P.sel : (v > 0 ? P.ahead : (v < 0 ? P.astern : P.stop));
            _tgText(ctx, v === 0 ? 'STOP' : _TG_LABEL[v], cx + Math.sin(a) * R * 0.8, cy - Math.cos(a) * R * 0.8);
            ctx.fillRect(cx + Math.sin(a) * R * 0.62 - 2, cy - Math.cos(a) * R * 0.62 - 2, 4, 4);
        }
        ctx.fillStyle = P.ahead; _tgText(ctx, 'AHEAD ▶', cx + R * 0.5, cy + R * 0.72);
        ctx.fillStyle = P.astern; _tgText(ctx, '◀ ASTERN', cx - R * 0.5, cy + R * 0.72);
        ctx.textAlign = 'start';
        // つまみ（ギザギザの縁）
        ctx.save(); ctx.translate(cx, cy); ctx.rotate(hAng);
        ctx.fillStyle = '#0d0f11';
        ctx.beginPath();
        for (let i = 0; i < 40; i++) { const a = i / 40 * Math.PI * 2; const r = R * (i % 2 ? 0.5 : 0.53); ctx.lineTo(Math.sin(a) * r, -Math.cos(a) * r); }
        ctx.closePath(); ctx.fill();
        ctx.fillStyle = _chrome(ctx, -R * 0.4, -R * 0.4, R * 0.4, R * 0.4);
        ctx.beginPath(); ctx.arc(0, 0, R * 0.42, 0, Math.PI * 2); ctx.fill();
        if (dimK > 0.001) { ctx.fillStyle = `rgba(4,6,12,${dimK})`; ctx.beginPath(); ctx.arc(0, 0, R * 0.42, 0, Math.PI * 2); ctx.fill(); }
        ctx.fillStyle = '#ff9f1a';
        ctx.save(); if (night > 0.02) { ctx.shadowColor = '#ff9f1a'; ctx.shadowBlur = S * 0.03 * night; }
        ctx.fillRect(-S * 0.012, -R * 0.5, S * 0.024, R * 0.3); ctx.restore();
        ctx.restore();
        // 応答ランプ
        const aa = _tgAngle(design, answerV);
        ctx.save(); if (night > 0.02) { ctx.shadowColor = '#ff3b30'; ctx.shadowBlur = S * 0.04 * night; }
        ctx.fillStyle = '#ff3b30'; ctx.beginPath(); ctx.arc(cx + Math.sin(aa) * R * 0.95, cy - Math.cos(aa) * R * 0.95, S * 0.014, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
        _drawSpecialBtns(ctx, S, design, special, ansSpecial, P);
        _tgGlowPx = 0;
        return;
    }

    if (design === 'tilt') {
        // 横から見たレバー：前へ倒すと前進、手前へ倒すと後進
        const px = cx, py = S * 0.86;
        ctx.fillStyle = P.white ? P.panel : '#23282e'; _roundRect(ctx, S * 0.05, S * 0.05, S * 0.9, S * 0.9, S * 0.06); ctx.fill();
        if (P.white) { ctx.strokeStyle = P.panelEdge; ctx.lineWidth = 1.5; ctx.stroke(); }
        _tgDim(ctx, S, dimK);
        _tgBacklight(ctx, S * 0.05, S * 0.05, S * 0.9, S * 0.9, S * 0.06, night, P.white);
        // 目盛りの弧
        ctx.font = `bold ${Math.round(S * 0.045)}px "Helvetica Neue",Arial,sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        for (let v = -3; v <= 3; v++) {
            const a = _tgAngle(design, v);
            const L = S * 0.56;
            ctx.strokeStyle = (v === order && !special) ? P.sel : P.tick; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.moveTo(px + Math.sin(a) * L * 0.9, py - Math.cos(a) * L * 0.9); ctx.lineTo(px + Math.sin(a) * L * 0.97, py - Math.cos(a) * L * 0.97); ctx.stroke();
            ctx.fillStyle = (v === order && !special) ? P.sel : (v > 0 ? P.ahead : (v < 0 ? P.astern : P.stop));
            ctx.save(); ctx.translate(px + Math.sin(a) * L * 1.08, py - Math.cos(a) * L * 1.08); ctx.rotate(a);
            _tgText(ctx, v === 0 ? 'STOP' : _TG_LABEL[v], 0, 0); ctx.restore();
        }
        ctx.fillStyle = P.ahead; _tgText(ctx, 'AHEAD', S * 0.8, S * 0.9);
        ctx.fillStyle = P.astern; _tgText(ctx, 'ASTERN', S * 0.2, S * 0.9);
        ctx.textAlign = 'start';
        // 応答の印
        const aa = _tgAngle(design, answerV);
        ctx.save(); if (night > 0.02) { ctx.shadowColor = '#ff3b30'; ctx.shadowBlur = S * 0.04 * night; }
        ctx.fillStyle = '#ff3b30'; ctx.beginPath(); ctx.arc(px + Math.sin(aa) * S * 0.49, py - Math.cos(aa) * S * 0.49, S * 0.014, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
        // 溝とレバー
        ctx.fillStyle = '#0b0d0f'; ctx.beginPath(); ctx.arc(px, py, S * 0.12, Math.PI, 0); ctx.fill();
        ctx.save(); ctx.translate(px, py); ctx.rotate(hAng);
        ctx.fillStyle = _chrome(ctx, -S * 0.02, 0, S * 0.02, -S * 0.42);
        ctx.fillRect(-S * 0.018, -S * 0.39, S * 0.036, S * 0.39);
        ctx.fillStyle = '#111'; ctx.beginPath(); ctx.ellipse(0, -S * 0.42, S * 0.048, S * 0.058, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.beginPath(); ctx.ellipse(-S * 0.014, -S * 0.435, S * 0.016, S * 0.024, 0, 0, Math.PI * 2); ctx.fill();
        if (dimK > 0.001) { ctx.fillStyle = `rgba(4,6,12,${dimK})`; ctx.fillRect(-S * 0.018, -S * 0.39, S * 0.036, S * 0.39); ctx.beginPath(); ctx.ellipse(0, -S * 0.42, S * 0.048, S * 0.058, 0, 0, Math.PI * 2); ctx.fill(); }
        ctx.restore();
        _drawSpecialBtns(ctx, S, design, special, ansSpecial, P);
        _tgGlowPx = 0;
        return;
    }
    if (design === 'fore') {
        // 前後に倒すレバーを斜め上から見たところ：奥（画面の上）へ押すと前進、手前へ引くと後進
        const g = _tgForeGeom(S);
        ctx.fillStyle = P.white ? P.panel : '#23282e'; _roundRect(ctx, S * 0.05, S * 0.14, S * 0.9, S * 0.82, S * 0.06); ctx.fill();
        if (P.white) { ctx.strokeStyle = P.panelEdge; ctx.lineWidth = 1.5; ctx.stroke(); }
        _tgDim(ctx, S, dimK);
        _tgBacklight(ctx, S * 0.05, S * 0.14, S * 0.9, S * 0.82, S * 0.06, night, P.white);
        // 溝（奥ほど細く見える）
        ctx.fillStyle = '#0b0d0f';
        ctx.beginPath();
        ctx.moveTo(g.cx - S * 0.018, g.yOf(3.3)); ctx.lineTo(g.cx + S * 0.018, g.yOf(3.3));
        ctx.lineTo(g.cx + S * 0.03, g.yOf(-3.3)); ctx.lineTo(g.cx - S * 0.03, g.yOf(-3.3)); ctx.closePath(); ctx.fill();
        // 目盛りと文字
        ctx.font = `bold ${Math.round(S * 0.045)}px "Helvetica Neue",Arial,sans-serif`; ctx.textBaseline = 'middle';
        for (let v = -3; v <= 3; v++) {
            const y = g.yOf(v), on = v === order && !special;
            ctx.strokeStyle = on ? P.sel : P.tick; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.moveTo(g.cx - S * 0.1, y); ctx.lineTo(g.cx - S * 0.055, y); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(g.cx + S * 0.055, y); ctx.lineTo(g.cx + S * 0.1, y); ctx.stroke();
            ctx.fillStyle = on ? P.sel : (v > 0 ? P.ahead : (v < 0 ? P.astern : P.stop));
            ctx.textAlign = 'right';
            _tgText(ctx, v === 0 ? 'STOP' : _TG_LABEL[v], g.cx - S * 0.12, y);
        }
        ctx.textAlign = 'center';
        ctx.fillStyle = P.ahead; _tgText(ctx, '▲ AHEAD', g.cx + S * 0.27, g.yOf(2));
        ctx.fillStyle = P.astern; _tgText(ctx, '▼ ASTERN', g.cx + S * 0.27, g.yOf(-2));
        ctx.textAlign = 'start';
        // 応答の印（右の目盛りの外）
        ctx.save(); if (night > 0.02) { ctx.shadowColor = '#ff3b30'; ctx.shadowBlur = S * 0.04 * night; }
        ctx.fillStyle = '#ff3b30'; ctx.beginPath(); ctx.arc(g.cx + S * 0.13, g.yOf(answerV), S * 0.014, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
        // レバー：根元（溝の中の支点）から握りまで。手前に引くほど握りが大きく見える
        const ky = g.yOf(handleV), near = (3.3 - handleV) / 6.6;          // 0＝奥 1＝手前
        const kr = S * (0.042 + 0.022 * near);
        ctx.fillStyle = _chrome(ctx, g.cx - S * 0.02, g.pivY, g.cx + S * 0.02, ky);
        ctx.beginPath();
        ctx.moveTo(g.cx - S * 0.016, g.pivY); ctx.lineTo(g.cx + S * 0.016, g.pivY);
        ctx.lineTo(g.cx + kr * 0.35, ky); ctx.lineTo(g.cx - kr * 0.35, ky); ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#111'; ctx.beginPath(); ctx.ellipse(g.cx, ky, kr, kr * 0.85, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.beginPath(); ctx.ellipse(g.cx - kr * 0.3, ky - kr * 0.3, kr * 0.35, kr * 0.25, 0, 0, Math.PI * 2); ctx.fill();
        if (dimK > 0.001) { ctx.fillStyle = `rgba(4,6,12,${dimK})`; ctx.beginPath(); ctx.ellipse(g.cx, ky, kr, kr * 0.85, 0, 0, Math.PI * 2); ctx.fill(); }
        _drawSpecialBtns(ctx, S, design, special, ansSpecial, P);
        _tgGlowPx = 0;
        return;
    }
    _tgGlowPx = 0;
}
// 丸型以外：スタンバイ・機関終了の小さなボタンの位置 [x, y, 幅, 高さ]
function _tgSpecialRects(design, S) {
    if (design === 'modern') {
        const x0 = S * 0.14, w = S * 0.72, by = S * 0.05 + S * 0.03, bh = S * 0.9 / 8.6;
        const bw = (w - S * 0.1) / 2 - S * 0.01;
        return { standby: [x0 + S * 0.05, by, bw, bh * 0.82], fwe: [x0 + w / 2 + S * 0.01, by, bw, bh * 0.82] };
    }
    return { standby: [S * 0.03, S * 0.02, S * 0.25, S * 0.1], fwe: [S * 0.72, S * 0.02, S * 0.25, S * 0.1] };
}
function _drawSpecialBtns(ctx, S, design, special, ansSpecial, P, bgOnly) {
    P = P || _tgPalette('black');
    const rects = _tgSpecialRects(design, S);
    ctx.font = `bold ${Math.round(S * 0.042)}px "Helvetica Neue",Arial,sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const [key, [x, y, w, h]] of Object.entries(rects)) {
        const on = special === key, ans = ansSpecial === key;
        if (bgOnly) {
            // 夜に暗くするため、下地だけ先に描く（上から文字などを描き直す）
            ctx.fillStyle = P.btnOff; _roundRect(ctx, x, y, w, h, S * 0.02); ctx.fill();
            continue;
        }
        ctx.fillStyle = on ? (key === 'standby' ? '#ffb020' : '#4aa3ff') : P.btnOff;
        _roundRect(ctx, x, y, w, h, S * 0.02); ctx.fill();
        ctx.strokeStyle = ans ? P.sel : P.btnEdge; ctx.lineWidth = ans ? 2 : 1; ctx.stroke();
        ctx.fillStyle = on ? '#101010' : (key === 'standby' ? (P.white ? '#a86400' : '#ffc861') : (P.white ? '#1f5fa8' : '#8cc6ff'));
        _tgText(ctx, _TG_SPECIAL[key].short, x + w / 2, y + h * 0.52);
    }
    ctx.textAlign = 'start';
}
function _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

// ════════════════════════════════════════════════════════════════
//  舵輪の描画
// ════════════════════════════════════════════════════════════════
function _drawRudderGauge(ctx, S, rudder, order) {
    // 上部の舵角計（左舷35°〜右舷35°）
    const cx = S / 2, cy = S * 0.22, R = S * 0.2;
    ctx.fillStyle = 'rgba(10,14,18,0.85)';
    ctx.beginPath(); ctx.arc(cx, cy, R * 1.05, Math.PI, 0); ctx.closePath(); ctx.fill();
    ctx.lineWidth = S * 0.018;
    ctx.strokeStyle = '#a51c1c'; ctx.beginPath(); ctx.arc(cx, cy, R * 0.85, Math.PI, Math.PI * 1.5); ctx.stroke();
    ctx.strokeStyle = '#1f8a3a'; ctx.beginPath(); ctx.arc(cx, cy, R * 0.85, Math.PI * 1.5, 0); ctx.stroke();
    ctx.fillStyle = '#e8e8e8'; ctx.font = `bold ${Math.round(S * 0.04)}px Arial,sans-serif`; ctx.textAlign = 'center';
    ctx.fillText('PORT', cx - R * 0.62, cy - R * 0.08); ctx.fillText('STBD', cx + R * 0.62, cy - R * 0.08);
    ctx.textAlign = 'start';
    const toA = (d) => _deg(d / 35 * 90);
    _needle(ctx, cx, cy, toA(order), R * 0.8, S * 0.008, 'rgba(255,210,60,0.8)', 1);
    _needle(ctx, cx, cy, toA(rudder), R * 0.95, S * 0.012, '#ffffff', 1);
    // 舵角の数字は針に隠れないよう最後に、縁取りして描く
    const deg = Math.round(rudder);
    const txt = deg === 0 ? '0°' : `${deg < 0 ? 'P' : 'S'} ${Math.abs(deg)}°`;
    ctx.font = `bold ${Math.round(S * 0.042)}px Arial,sans-serif`; ctx.textAlign = 'center';
    ctx.lineWidth = S * 0.014; ctx.strokeStyle = 'rgba(10,14,18,0.95)'; ctx.lineJoin = 'round';
    ctx.strokeText(txt, cx, cy - R * 0.32);
    ctx.fillStyle = deg < 0 ? '#ff9a8f' : (deg > 0 ? '#8ff0ad' : '#f2f2f2');
    ctx.fillText(txt, cx, cy - R * 0.32);
    ctx.textAlign = 'start';
}

function _drawWheel(ctx, S, design, wheelDeg, rudder, order, text) {
    ctx.clearRect(0, 0, S, S);
    _drawRudderGauge(ctx, S, rudder, order);
    const cx = S / 2, cy = S * 0.62, R = S * (design === 'classic' ? 0.285 : 0.33);
    const rot = _deg(wheelDeg);

    if (design === 'classic') {
        ctx.save(); ctx.translate(cx, cy); ctx.rotate(rot);
        // スポークと握り（縁の外まで伸びる）
        const n = 10;
        for (let i = 0; i < n; i++) {
            ctx.save(); ctx.rotate(i / n * Math.PI * 2);
            const wood = ctx.createLinearGradient(-S * 0.02, 0, S * 0.02, 0);
            wood.addColorStop(0, '#3b1d0c'); wood.addColorStop(0.5, '#8a4a22'); wood.addColorStop(1, '#3b1d0c');
            ctx.fillStyle = wood;
            ctx.fillRect(-S * 0.014, -R * 1.0, S * 0.028, R * 0.9);
            // 握り（ろくろ挽きのふくらみ）
            ctx.beginPath(); ctx.ellipse(0, -R * 1.2, S * 0.026, S * 0.07, 0, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = _brass(ctx, -S * 0.02, 0, S * 0.02, 0);
            ctx.fillRect(-S * 0.02, -R * 1.07, S * 0.04, S * 0.012);
            ctx.restore();
        }
        // 木の縁
        const rim = ctx.createRadialGradient(0, 0, R * 0.8, 0, 0, R * 1.02);
        rim.addColorStop(0, '#4a220e'); rim.addColorStop(0.5, '#9a5528'); rim.addColorStop(1, '#3a1a08');
        _ring(ctx, 0, 0, R * 0.8, R * 1.02, rim);
        // 縁の金属板（真鍮の帯）と、彫り込んだ文字
        _ring(ctx, 0, 0, R * 0.84, R * 0.98, _brass(ctx, -R, -R, R, R));
        _ring(ctx, 0, 0, R * 0.84, R * 0.85, 'rgba(60,40,10,0.6)');
        _ring(ctx, 0, 0, R * 0.97, R * 0.98, 'rgba(60,40,10,0.6)');
        const label = (text && text.trim()) ? text.trim() : ' ';
        ctx.font = `bold ${Math.round(S * 0.043)}px Georgia,"Times New Roman","Hiragino Mincho ProN",serif`;
        ctx.textBaseline = 'middle';
        const unit = label + '  ✦  ';
        const circ = 2 * Math.PI * R * 0.91;
        const w = ctx.measureText(unit).width;
        const reps = Math.max(1, Math.floor(circ / w));
        for (let k = 0; k < reps; k++) _textOnArc(ctx, unit, 0, 0, R * 0.91, k / reps * Math.PI * 2, true, '#3b2708');
        // 中心のハブ
        ctx.fillStyle = _brass(ctx, -R * 0.2, -R * 0.2, R * 0.2, R * 0.2);
        ctx.beginPath(); ctx.arc(0, 0, R * 0.2, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = _brass(ctx, -R * 0.12, -R * 0.12, R * 0.12, R * 0.12, true);
        ctx.beginPath(); ctx.arc(0, 0, R * 0.11, 0, Math.PI * 2); ctx.fill();
        // 舵中央の印（王冠の握り＝上のスポークに真鍮の輪）
        ctx.fillStyle = '#e8c878'; ctx.beginPath(); ctx.arc(0, -R * 1.27, S * 0.012, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
        return;
    }

    if (design === 'handle') {
        ctx.save(); ctx.translate(cx, cy); ctx.rotate(rot);
        // 3本スポーク
        for (const a of [0, 120, 240]) {
            ctx.save(); ctx.rotate(_deg(a + 90));
            ctx.fillStyle = _chrome(ctx, -S * 0.03, 0, S * 0.03, 0);
            ctx.fillRect(-S * 0.022, -R * 0.95, S * 0.044, R * 0.8);
            ctx.restore();
        }
        // 太い握りの輪（革巻き）
        const grip = ctx.createRadialGradient(0, 0, R * 0.84, 0, 0, R * 1.04);
        grip.addColorStop(0, '#0a0a0a'); grip.addColorStop(0.45, '#3a3a3a'); grip.addColorStop(1, '#050505');
        _ring(ctx, 0, 0, R * 0.84, R * 1.04, grip);
        ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1;
        for (let i = 0; i < 48; i++) { const a = i / 48 * Math.PI * 2; ctx.beginPath(); ctx.moveTo(Math.sin(a) * R * 0.86, -Math.cos(a) * R * 0.86); ctx.lineTo(Math.sin(a + 0.05) * R * 1.02, -Math.cos(a + 0.05) * R * 1.02); ctx.stroke(); }
        // 上の目印
        ctx.fillStyle = '#ff9f1a'; ctx.fillRect(-S * 0.012, -R * 1.05, S * 0.024, R * 0.22);
        // ハブ
        ctx.fillStyle = _chrome(ctx, -R * 0.25, -R * 0.25, R * 0.25, R * 0.25);
        ctx.beginPath(); ctx.arc(0, 0, R * 0.25, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#1b1f24'; ctx.beginPath(); ctx.arc(0, 0, R * 0.18, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#cfd6dc'; ctx.font = `bold ${Math.round(S * 0.035)}px Arial,sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText((text && text.trim()) ? text.trim().slice(0, 6) : 'HELM', 0, 0);
        ctx.textAlign = 'start';
        ctx.restore();
        return;
    }

    if (design === 'azipod') {
        // 方位目盛りの付いた旋回レバー（ポッドの向き）
        ctx.fillStyle = '#1a1f25'; ctx.beginPath(); ctx.arc(cx, cy, R * 1.12, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#46505a'; ctx.lineWidth = 2; ctx.stroke();
        ctx.strokeStyle = '#9aa3ad'; ctx.fillStyle = '#cfd6dc';
        ctx.font = `${Math.round(S * 0.035)}px Arial,sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        for (let d = 0; d < 360; d += 10) {
            const a = _deg(d), major = d % 30 === 0;
            ctx.lineWidth = major ? 2 : 1;
            ctx.beginPath(); ctx.moveTo(cx + Math.sin(a) * R * (major ? 0.9 : 0.96), cy - Math.cos(a) * R * (major ? 0.9 : 0.96));
            ctx.lineTo(cx + Math.sin(a) * R * 1.05, cy - Math.cos(a) * R * 1.05); ctx.stroke();
            if (d % 90 === 0) ctx.fillText(String(d), cx + Math.sin(a) * R * 0.76, cy - Math.cos(a) * R * 0.76);
        }
        ctx.fillStyle = '#6e7a86'; ctx.fillText('AZIMUTH', cx, cy + R * 0.42);
        ctx.textAlign = 'start';
        // レバー
        ctx.save(); ctx.translate(cx, cy); ctx.rotate(rot);
        ctx.fillStyle = _chrome(ctx, -S * 0.03, 0, S * 0.03, -R);
        ctx.fillRect(-S * 0.02, -R * 0.95, S * 0.04, R * 0.95);
        ctx.fillStyle = '#ff9f1a'; _roundRect(ctx, -S * 0.05, -R * 1.02, S * 0.1, S * 0.08, S * 0.02); ctx.fill();
        ctx.restore();
        ctx.fillStyle = _chrome(ctx, cx - 10, cy - 10, cx + 10, cy + 10);
        ctx.beginPath(); ctx.arc(cx, cy, R * 0.16, 0, Math.PI * 2); ctx.fill();
        return;
    }
}

// ════════════════════════════════════════════════════════════════
//  画面への配置と操作
// ════════════════════════════════════════════════════════════════
let _tgCanvas = null, _whCanvas = null;
function _widgetSize() {
    const m = Math.min(window.innerWidth, window.innerHeight);
    return Math.round(Math.max(120, Math.min(230, m * 0.27)));
}
function _setupCanvas(cv, S) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(S * dpr); cv.height = Math.round(S * dpr);
    cv.style.width = S + 'px'; cv.style.height = S + 'px';
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
}

function applyBridgeLayout() {
    const S = _widgetSize();
    _br.size = S;
    const tgBtns = ['btn-faster', 'btn-slower'].map(id => document.getElementById(id));
    const whBtns = ['btn-left', 'btn-right'].map(id => document.getElementById(id));
    const useTg = bridgeUI.telegraph !== 'buttons', useWh = bridgeUI.wheel !== 'buttons';
    tgBtns.forEach(b => { if (b) b.style.display = useTg ? 'none' : ''; });
    whBtns.forEach(b => { if (b) b.style.display = useWh ? 'none' : ''; });
    if (_tgCanvas) { _tgCanvas.style.display = useTg ? '' : 'none'; if (useTg) _setupCanvas(_tgCanvas, S); }
    if (_whCanvas) { _whCanvas.style.display = useWh ? '' : 'none'; if (useWh) _setupCanvas(_whCanvas, S); }
    // 汽笛ボタンはテレグラフの上へ
    const horn = document.getElementById('btn-horn');
    if (horn) horn.style.bottom = `calc(${useTg ? S + 30 : 210}px + env(safe-area-inset-bottom))`;
    const sig = document.getElementById('btn-horn-sig');
    if (sig) sig.style.bottom = `calc(${useTg ? S + 41 : 221}px + env(safe-area-inset-bottom))`;
    _br.dirtyT = _br.dirtyW = true;
}
window.applyBridgeLayout = applyBridgeLayout;

function _localPos(cv, e) {
    const r = cv.getBoundingClientRect();
    const p = e.touches ? e.touches[0] : e;
    return { x: p.clientX - r.left, y: p.clientY - r.top };
}

function _setupTelegraphInput(cv) {
    const S = () => _br.size;
    const pivot = () => bridgeUI.telegraph === 'tilt' ? { x: S() / 2, y: S() * 0.86 } : { x: S() / 2, y: S() * 0.54 };
    const angleAt = (p) => { const c = pivot(); return Math.atan2(p.x - c.x, -(p.y - c.y)); };
    // 指の位置 → 指令（連続値）。前後に倒すレバーは縦の位置、ほかは支点からの角度
    const _tgFromPointer = (d, p) => {
        if (d === 'fore') { const g = _tgForeGeom(S()); return Math.max(-3.2, Math.min(3.2, (g.yc - p.y) / g.step)); }
        return _tgFromAngleCont(d, angleAt(p));
    };
    cv.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation();
        try { cv.setPointerCapture(e.pointerId); } catch (err) { /* 合成イベントなど */ }
        const p = _localPos(cv, e);
        const d = bridgeUI.telegraph;
        if (!_tgOnDial(d)) {
            for (const [key, [x, y, w, h]] of Object.entries(_tgSpecialRects(d, S()))) {
                if (p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h) { setTelegraphSpecial(key); return; }
            }
        }
        if (d === 'modern') {
            const y0 = S() * 0.05 + S() * 0.03, bh = S() * 0.9 / 8.6;
            const k = Math.floor((p.y - y0) / bh) - 1;
            if (k >= 0 && k < 7) setTelegraphOrder(3 - k);
            return;
        }
        _br.tgDrag = { id: e.pointerId };
        _br.tgHandle = _tgFromPointer(d, p);
        _tgAim(Math.round(_br.tgHandle));
        _br.dirtyT = true;
    });
    cv.addEventListener('pointermove', (e) => {
        if (!_br.tgDrag) return;
        e.preventDefault();
        _br.tgHandle = _tgFromPointer(bridgeUI.telegraph, _localPos(cv, e));
        _tgAim(Math.round(_br.tgHandle));
        _br.dirtyT = true;
    });
    const up = (e) => {
        if (!_br.tgDrag) return;
        _br.tgDrag = null;
        _tgAim(Math.round(_br.tgHandle));
        _br.dirtyT = true;
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
}
// ── 一段ずつ切り替える ──
// ハンドルを一気に倒しても、指令は一段ずつ（TG_STEP_S 秒おきに）切り替わり、
// 段ごとにベルが鳴る。本物のテレグラフで、ハンドルが途中の目盛りを順に通るのと同じ。
// 目標の位置（-3〜3、丸型は両端の ±4 がスタンバイ・機関終了）
const TG_STEP_S = 0.12;
function _tgCurPos() {
    const sp = physics.telegraphSpecial;
    return (sp && _tgOnDial(bridgeUI.telegraph)) ? _TG_SPECIAL[sp].v : (physics.telegraphState || 0);
}
function _tgAim(v) {
    const lim = _tgOnDial(bridgeUI.telegraph) ? 4 : 3;
    _br.tgTarget = Math.max(-lim, Math.min(lim, v));
}
// 毎フレーム：目標まで一段ずつ進める
function _tgStepTowardTarget(now) {
    if (_br.tgTarget === undefined || _br.tgTarget === null) return;
    const cur = _tgCurPos();
    if (cur === _br.tgTarget) { if (!_br.tgDrag) _br.tgTarget = null; return; }
    if (now < (_br.tgStepAt || 0)) return;
    _br.tgStepAt = now + TG_STEP_S;
    const next = cur + Math.sign(_br.tgTarget - cur);
    const sp = Object.keys(_TG_SPECIAL).find(k => _TG_SPECIAL[k].v === next);
    if (sp && _tgOnDial(bridgeUI.telegraph)) setTelegraphSpecial(sp);
    else setTelegraphOrder(next);
}

// 角度 → 指令（連続値：ドラッグ中にハンドルを指に追従させる）
function _tgFromAngleCont(design, a) {
    const step = _TG_STEP[design] || 26;
    const lim = _tgOnDial(design) ? 4.2 : 3.2;      // 丸型は両端にスタンバイ・機関終了
    return Math.max(-lim, Math.min(lim, (a * 180 / Math.PI) / step));
}

function _setupWheelInput(cv) {
    const center = () => ({ x: _br.size / 2, y: _br.size * 0.62 });
    cv.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation();
        try { cv.setPointerCapture(e.pointerId); } catch (err) { /* 合成イベントなど */ }
        const p = _localPos(cv, e), c = center();
        const now = performance.now();
        // 中心をダブルタップ：舵中央
        if (Math.hypot(p.x - c.x, p.y - c.y) < _br.size * 0.12 && now - _br.lastTap < 350) {
            bridgeCenterHelm(); _br.lastTap = 0; return;
        }
        _br.lastTap = now;
        _br.wheelDrag = { a: Math.atan2(p.x - c.x, -(p.y - c.y)) };
    });
    cv.addEventListener('pointermove', (e) => {
        if (!_br.wheelDrag) return;
        e.preventDefault();
        const p = _localPos(cv, e), c = center();
        const a = Math.atan2(p.x - c.x, -(p.y - c.y));
        let d = a - _br.wheelDrag.a;
        if (d > Math.PI) d -= Math.PI * 2;
        if (d < -Math.PI) d += Math.PI * 2;
        _br.wheelDrag.a = a;
        const lock = WHEEL_LOCK_DEG[bridgeUI.wheel] || 360;
        _br.wheelDeg = Math.max(-lock, Math.min(lock, _br.wheelDeg + d * 180 / Math.PI));
        _br.dirtyW = true;
    });
    const up = () => { _br.wheelDrag = null; };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
}

// 舵輪を使うときは、舵は舵輪の指示を保つ（17-main-loop.js が呼ぶ）
function bridgeWheelActive() { return bridgeUI.wheel !== 'buttons'; }
window.bridgeWheelActive = bridgeWheelActive;
function bridgeHelmRate() { return HELM_RATE; }
window.bridgeHelmRate = bridgeHelmRate;

// 針・ハンドルを目標へ回す量。一気に指令を変えても、途中の目盛りを通って
// 「くるっ」と回る（最高 speed 目盛り/秒。着く直前はゆっくり止まる）
function _sweep(d, dt, speed) {
    const v = Math.min(speed, Math.abs(d) * 9 + 0.4);
    const step = Math.min(Math.abs(d), v * dt);
    return Math.sign(d) * step;
}

// 毎フレーム
function updateBridge(t) {
    const dt = (_br.lastT < 0) ? 0 : Math.min(0.1, Math.max(0, t - _br.lastT));
    _br.lastT = t;
    const order = physics.telegraphState || 0;
    if (_br.lastOrder === null) { _br.lastOrder = order; physics.telegraphAnswer = order; _br.answer = order; }
    const special = physics.telegraphSpecial || '';
    if (order !== _br.lastOrder || special !== _br.lastSpecial) { _br.lastOrder = order; _br.lastSpecial = special; _br.dirtyT = true; }
    // 機関室の応答
    if (_br.answerAt > 0 && performance.now() >= _br.answerAt) {
        _br.answerAt = -1;
        physics.telegraphAnswer = order;
        physics.telegraphAnswerSpecial = special;
        telegraphBell(bridgeUI.telegraph, true);
    }
    if (!bridgeUI.waitAnswer) { physics.telegraphAnswer = order; physics.telegraphAnswerSpecial = special; }
    const design = bridgeUI.telegraph, ansSpecial = physics.telegraphAnswerSpecial || '';
    // 針・ハンドルの動き（なめらかに）
    if (!_br.tgDrag) {
        const d = _tgPos(design, order, special) - _br.tgHandle;
        if (Math.abs(d) > 0.001) { _br.tgHandle += _sweep(d, dt, 7.0); _br.dirtyT = true; }
    }
    const da = _tgPos(design, physics.telegraphAnswer, ansSpecial) - _br.answer;
    if (Math.abs(da) > 0.001) { _br.answer += _sweep(da, dt, 3.2); _br.dirtyT = true; }

    // 舵輪：A/Dキーで回す
    const lock = WHEEL_LOCK_DEG[bridgeUI.wheel] || 360;
    if (bridgeWheelActive()) {
        const kr = HELM_KEY_RATE_WHEEL[bridgeUI.wheel] || HELM_KEY_RATE;
        if (keys.a || keys.d || _br.wheelDrag) _br.wheelTarget = null;     // 手で回したら中央戻しはやめる
        if (keys.a) { _br.wheelDeg = Math.max(-lock, _br.wheelDeg - kr / 35 * lock * dt); _br.dirtyW = true; }
        if (keys.d) { _br.wheelDeg = Math.min(lock, _br.wheelDeg + kr / 35 * lock * dt); _br.dirtyW = true; }
        if (_br.wheelTarget !== null && _br.wheelTarget !== undefined) {
            const d = _br.wheelTarget - _br.wheelDeg;
            const step = (WHEEL_CENTER_RATE[bridgeUI.wheel] || 540) * dt;
            if (Math.abs(d) <= step) { _br.wheelDeg = _br.wheelTarget; _br.wheelTarget = null; }
            else _br.wheelDeg += Math.sign(d) * step;
            _br.dirtyW = true;
        }
        physics.helmOrder = _br.wheelDeg / lock * 35;
        // 古典的な舵輪：1周ごとにベル（テレグラフと同じ音）
        if (bridgeUI.wheel === 'classic') {
            const turn = Math.trunc(_br.wheelDeg / 360);
            if (_br.lastTurn === undefined) _br.lastTurn = turn;
            if (turn !== _br.lastTurn) {
                _br.lastTurn = turn;
                if (t - (_br.turnBellAt || -9) > 0.15) { _br.turnBellAt = t; telegraphBell(bridgeUI.telegraph, false, 1); }
            }
        } else _br.lastTurn = undefined;
    }
    if (Math.abs(physics.rudderAngle - _br.lastRudder) > 0.05) { _br.lastRudder = physics.rudderAngle; _br.dirtyW = true; }

    _tgStepTowardTarget(t);
    // 暗くなる・明るくなるにつれて盤面の光り方を描き直す
    const nk = Math.round(_tgNight() * 40);
    if (nk !== _br.lastNightK) { _br.lastNightK = nk; _br.dirtyT = true; }
    if (_br.dirtyT && _tgCanvas && bridgeUI.telegraph !== 'buttons') {
        _br.dirtyT = false;
        _drawTelegraph(_tgCanvas.getContext('2d'), _br.size, design, _br.tgHandle, _br.answer, order, special, ansSpecial);
    }
    if (_br.dirtyW && _whCanvas && bridgeWheelActive()) {
        _br.dirtyW = false;
        const disp = bridgeUI.wheel === 'azipod' ? physics.helmOrder * 2 : _br.wheelDeg;   // アジポッドはレバーの向き＝ポッドの向き（見やすく2倍）
        _drawWheel(_whCanvas.getContext('2d'), _br.size, bridgeUI.wheel, disp, physics.rudderAngle, physics.helmOrder, bridgeUI.wheelText);
    }
}
window.updateBridge = updateBridge;

// ── 保存・読み込み ──
function getBridgeConfig() { return { telegraph: bridgeUI.telegraph, wheel: bridgeUI.wheel, wheelText: bridgeUI.wheelText, waitAnswer: bridgeUI.waitAnswer, bell: bridgeUI.bell, tgTheme: bridgeUI.tgTheme, tgLit: bridgeUI.tgLit }; }
function applyBridgeConfig(c) {
    const d = { telegraph: 'olympic', wheel: 'classic', wheelText: 'R.M.S. OLYMPIC', waitAnswer: true, bell: 'auto', tgTheme: 'auto', tgLit: true };
    Object.assign(bridgeUI, d, c || {});
    if (!BRIDGE_TELEGRAPHS[bridgeUI.telegraph]) bridgeUI.telegraph = 'olympic';
    if (!BRIDGE_WHEELS[bridgeUI.wheel]) bridgeUI.wheel = 'classic';
    _br.wheelDeg = 0;
    applyBridgeLayout();
    renderBridgePanel();
}
window.getBridgeConfig = getBridgeConfig;
window.applyBridgeConfig = applyBridgeConfig;

function setBridgeOption(key, v) {
    if (key === 'waitAnswer' || key === 'tgLit') bridgeUI[key] = !!v;
    else bridgeUI[key] = v;
    if (key === 'wheel') _br.wheelDeg = Math.max(-(WHEEL_LOCK_DEG[v] || 360), Math.min(WHEEL_LOCK_DEG[v] || 360, physics.helmOrder / 35 * (WHEEL_LOCK_DEG[v] || 360)));
    applyBridgeLayout();
}
window.setBridgeOption = setBridgeOption;

function renderBridgePanel() {
    const bl = document.getElementById('bridge-bell');
    if (bl) bl.innerHTML = Object.entries(BRIDGE_BELLS).map(([k, l]) => `<option value="${k}"${k === (bridgeUI.bell || 'auto') ? ' selected' : ''}>${l}</option>`).join('');
    const th = document.getElementById('bridge-tg-theme');
    if (th) th.innerHTML = Object.entries(TG_THEMES).map(([k, l]) => `<option value="${k}"${k === (bridgeUI.tgTheme || 'auto') ? ' selected' : ''}>${l}</option>`).join('');
    const lit = document.getElementById('bridge-tg-lit'); if (lit) lit.checked = bridgeUI.tgLit !== false;
    const tg = document.getElementById('bridge-telegraph');
    if (tg) tg.innerHTML = Object.entries(BRIDGE_TELEGRAPHS).map(([k, l]) => `<option value="${k}"${k === bridgeUI.telegraph ? ' selected' : ''}>${l}</option>`).join('');
    const wh = document.getElementById('bridge-wheel');
    if (wh) wh.innerHTML = Object.entries(BRIDGE_WHEELS).map(([k, l]) => `<option value="${k}"${k === bridgeUI.wheel ? ' selected' : ''}>${l}</option>`).join('');
    const tx = document.getElementById('bridge-wheel-text'); if (tx) tx.value = bridgeUI.wheelText;
    const wa = document.getElementById('bridge-wait-answer'); if (wa) wa.checked = bridgeUI.waitAnswer;
}
window.renderBridgePanel = renderBridgePanel;

document.addEventListener('DOMContentLoaded', () => {
    _tgCanvas = document.getElementById('telegraph-widget');
    _whCanvas = document.getElementById('wheel-widget');
    if (_tgCanvas) _setupTelegraphInput(_tgCanvas);
    if (_whCanvas) _setupWheelInput(_whCanvas);
    applyBridgeLayout();
    renderBridgePanel();
    window.addEventListener('resize', applyBridgeLayout);
    // 船体設定の Menu を開いたときの位置ずらし（▲▼ と同じ）は CSS 側で行う
});
