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
//    ・tilt      : 倒すタイプのレバー（前後に倒す）
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
    tilt:      'レバー（倒すタイプ）',
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
const WHEEL_LOCK_DEG = { classic: 540, handle: 270, azipod: 70 };
const HELM_RATE = 20;          // 舵が舵輪の指示へ追いつく速さ[度/秒]（舵取機）
const HELM_KEY_RATE = 60;      // A/Dキーで舵輪を回す速さ（舵角換算[度/秒]）
const TG_ANSWER_DELAY = 1.3;   // 機関室が応答するまで[秒]

const bridgeUI = {
    telegraph: 'olympic', wheel: 'classic', wheelText: 'R.M.S. OLYMPIC', waitAnswer: true,
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
// 「ジリンジリン」：小さなベルを打ち子が速く連打する音。機関室の応答は
// 少し遠く、音程の違うベルで返ってくる。現代型は電子音。
function telegraphBell(kind, answer) {
    if (typeof audioEnsure !== 'function' || !audioEnsure() || !audio.buses.bridge) return;
    const c = audio.ctx, dest = audio.buses.bridge;
    const t0 = c.currentTime + 0.01;
    if (kind === 'modern') {
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
    telegraphBell(bridgeUI.telegraph, false);
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
        else { ctx.fillStyle = color || '#111'; ctx.fillText(ch, -w / 2, 0); }
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
function _drawTelegraph(ctx, S, design, handleV, answerV, order, special, ansSpecial) {
    ctx.clearRect(0, 0, S, S);
    const cx = S / 2, cy = S * 0.54, R = S * 0.44;
    const hAng = _tgAngle(design, handleV), aAng = _tgAngle(design, answerV);

    if (design === 'olympic' || design === 'queenmary') {
        const deco = design === 'queenmary';
        // 胴（ケース）
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = S * 0.05; ctx.shadowOffsetY = S * 0.02;
        ctx.fillStyle = deco ? _brass(ctx, 0, 0, S, S, true) : _brass(ctx, 0, 0, S, S);
        ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
        _ring(ctx, cx, cy, R * 0.86, R * 0.95, deco ? 'rgba(20,14,4,0.55)' : 'rgba(80,55,10,0.45)');
        // 文字盤
        const face = ctx.createRadialGradient(cx - R * 0.2, cy - R * 0.3, R * 0.1, cx, cy, R * 0.86);
        if (deco) { face.addColorStop(0, '#1d1a14'); face.addColorStop(1, '#050403'); }
        else { face.addColorStop(0, '#fffdf4'); face.addColorStop(1, '#e8e0cc'); }
        ctx.fillStyle = face;
        ctx.beginPath(); ctx.arc(cx, cy, R * 0.84, 0, Math.PI * 2); ctx.fill();
        if (deco) {
            // アールデコの放射線（サンバースト）
            ctx.strokeStyle = 'rgba(212,175,90,0.25)'; ctx.lineWidth = 1;
            for (let i = -12; i <= 12; i++) {
                const a = _deg(i * 7.5);
                ctx.beginPath(); ctx.moveTo(cx + Math.sin(a) * R * 0.2, cy - Math.cos(a) * R * 0.2);
                ctx.lineTo(cx + Math.sin(a) * R * 0.8, cy - Math.cos(a) * R * 0.8); ctx.stroke();
            }
            _ring(ctx, cx, cy, R * 0.8, R * 0.82, '#c9a24c');
        }
        // 区切りと文字（前進は黒、後進は赤。アールデコは金と朱）
        const step = deco ? 31 : 33;
        ctx.textBaseline = 'middle';
        for (let v = -3; v <= 3; v++) {
            const a = _tgAngle(design, v);
            const lab = _TG_LABEL[v];
            const col = deco ? (v < 0 ? '#e0674a' : (v === 0 ? '#f3e6c0' : '#d9b45a')) : (v < 0 ? '#b3140f' : '#101010');
            ctx.font = `bold ${Math.round(S * (v === 0 ? 0.052 : 0.046))}px ${deco ? '"Futura","Avenir Next","Century Gothic",sans-serif' : 'Georgia,"Times New Roman",serif'}`;
            _textOnArc(ctx, lab, cx, cy, R * 0.68, a, false, col);
            // 区切り線
            const b = _deg((v + 0.5) * -step);
            if (v < 3) {
                ctx.strokeStyle = deco ? 'rgba(201,162,76,0.7)' : 'rgba(0,0,0,0.45)'; ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(cx + Math.sin(b) * R * 0.5, cy - Math.cos(b) * R * 0.5);
                ctx.lineTo(cx + Math.sin(b) * R * 0.83, cy - Math.cos(b) * R * 0.83); ctx.stroke();
            }
            if (v === order && !special) {
                // 指令中の区画をうっすら強調
                ctx.fillStyle = deco ? 'rgba(212,175,90,0.18)' : 'rgba(255,200,60,0.25)';
                ctx.beginPath(); ctx.moveTo(cx, cy);
                ctx.arc(cx, cy, R * 0.83, a - Math.PI / 2 - _deg(step / 2), a - Math.PI / 2 + _deg(step / 2)); ctx.closePath(); ctx.fill();
            }
        }
        // 両端：スタンバイ（前進側）と機関終了（後進側）。下側なので文字は内向き
        for (const [key, sp] of Object.entries(_TG_SPECIAL)) {
            const a = _tgAngle(design, sp.v);
            ctx.font = `bold ${Math.round(S * 0.036)}px ${deco ? '"Futura","Avenir Next","Century Gothic",sans-serif' : 'Georgia,"Times New Roman",serif'}`;
            // 機関終了は長いので「FINISHED」だけ（下の銘板に日本語で出る）
            _textOnArc(ctx, key === 'fwe' ? 'FINISHED' : sp.en, cx, cy, R * 0.7, a, false, deco ? '#9fc3d9' : '#1d3f73', true);
            const b = _tgAngle(design, sp.v > 0 ? 3.5 : -3.5);
            ctx.strokeStyle = deco ? 'rgba(201,162,76,0.7)' : 'rgba(0,0,0,0.45)'; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(cx + Math.sin(b) * R * 0.5, cy - Math.cos(b) * R * 0.5);
            ctx.lineTo(cx + Math.sin(b) * R * 0.83, cy - Math.cos(b) * R * 0.83); ctx.stroke();
            if (special === key) {
                ctx.fillStyle = deco ? 'rgba(160,200,230,0.18)' : 'rgba(60,120,220,0.18)';
                ctx.beginPath(); ctx.moveTo(cx, cy);
                ctx.arc(cx, cy, R * 0.83, a - Math.PI / 2 - _deg(step / 2), a - Math.PI / 2 + _deg(step / 2)); ctx.closePath(); ctx.fill();
            }
        }
        ctx.font = `bold ${Math.round(S * 0.042)}px ${deco ? '"Futura",sans-serif' : 'Georgia,serif'}`;
        ctx.textAlign = 'center';
        // 本物と同じく、前進・後進の文字は文字盤の上半分の内側に
        ctx.fillStyle = deco ? '#d9b45a' : '#101010'; ctx.fillText('AHEAD', cx - R * 0.33, cy - R * 0.22);
        ctx.fillStyle = deco ? '#e0674a' : '#b3140f'; ctx.fillText('ASTERN', cx + R * 0.33, cy - R * 0.22);
        ctx.textAlign = 'start';
        // 下半分：銘板
        ctx.font = `${Math.round(S * 0.045)}px ${deco ? '"Futura",sans-serif' : 'Georgia,serif'}`;
        ctx.textAlign = 'center';
        ctx.fillStyle = deco ? '#c9a24c' : '#3a2c10';
        ctx.fillText(deco ? 'ENGINE ORDER' : 'ENGINE ROOM', cx, cy + R * 0.42);
        ctx.font = `${Math.round(S * 0.035)}px ${deco ? '"Futura",sans-serif' : 'Georgia,serif'}`;
        ctx.fillText(special ? _TG_SPECIAL[special].jp : _TG_JP[order], cx, cy + R * 0.58);
        ctx.textAlign = 'start';
        // 応答の針（赤・内側）と、指令の針（真鍮）
        _needle(ctx, cx, cy, aAng, R * 0.42, S * 0.018, '#c0201a');
        _needle(ctx, cx, cy, hAng, R * 0.8, S * 0.03, deco ? _brass(ctx, cx - R, cy - R, cx + R, cy + R) : '#2a2a2a');
        // 中心のボス
        ctx.fillStyle = _brass(ctx, cx - R * 0.1, cy - R * 0.1, cx + R * 0.1, cy + R * 0.1);
        ctx.beginPath(); ctx.arc(cx, cy, R * 0.09, 0, Math.PI * 2); ctx.fill();
        // 外のハンドル（ケースの外まで伸びる把手）
        ctx.save(); ctx.translate(cx, cy); ctx.rotate(hAng);
        ctx.fillStyle = _brass(ctx, -S * 0.03, -R * 1.18, S * 0.03, -R * 0.9);
        ctx.fillRect(-S * 0.016, -R * 1.12, S * 0.032, R * 0.24);
        ctx.beginPath(); ctx.arc(0, -R * 1.14, S * 0.045, 0, Math.PI * 2);
        ctx.fillStyle = deco ? '#1a1a1a' : '#5b2b12'; ctx.fill();
        ctx.restore();
        // ケースのねじ
        for (let i = 0; i < 6; i++) { const a = _deg(30 + i * 60); _screw(ctx, cx + Math.sin(a) * R * 0.905, cy - Math.cos(a) * R * 0.905, S * 0.012); }
        // ガラスの映り込み
        const gl = ctx.createLinearGradient(cx - R, cy - R, cx + R * 0.3, cy + R * 0.2);
        gl.addColorStop(0, 'rgba(255,255,255,0.28)'); gl.addColorStop(0.5, 'rgba(255,255,255,0.03)'); gl.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(cx, cy, R * 0.84, 0, Math.PI * 2); ctx.fill();
        return;
    }

    if (design === 'warship') {
        // 黒い計器：前進（緑）・後進（赤）の目盛り
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,0.7)'; ctx.shadowBlur = S * 0.04;
        ctx.fillStyle = _chrome(ctx, 0, 0, S, S);
        ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
        ctx.fillStyle = '#0c0f10'; ctx.beginPath(); ctx.arc(cx, cy, R * 0.9, 0, Math.PI * 2); ctx.fill();
        const arc = (a0, a1, col) => { ctx.strokeStyle = col; ctx.lineWidth = S * 0.035; ctx.beginPath(); ctx.arc(cx, cy, R * 0.74, a0 - Math.PI / 2, a1 - Math.PI / 2); ctx.stroke(); };
        arc(_deg(4), _deg(126), '#1f8a3a');
        arc(_deg(-126), _deg(-4), '#a51c1c');
        ctx.strokeStyle = '#d8dde0'; ctx.fillStyle = '#d8dde0';
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
            ctx.fillStyle = v > 0 ? '#7ee39a' : (v < 0 ? '#ff8a80' : '#ffffff');
            ctx.fillText(v === 0 ? 'STOP' : String(Math.abs(v) * 33 + (Math.abs(v) === 3 ? 1 : 0)), cx + Math.sin(a) * R * 0.5, cy - Math.cos(a) * R * 0.5);
        }
        ctx.font = `bold ${Math.round(S * 0.042)}px "Helvetica Neue",Arial,sans-serif`;
        ctx.fillStyle = '#7ee39a'; ctx.fillText('AHEAD', cx + R * 0.34, cy + R * 0.42);
        ctx.fillStyle = '#ff8a80'; ctx.fillText('ASTERN', cx - R * 0.34, cy + R * 0.42);
        ctx.fillStyle = '#9aa3ad'; ctx.font = `${Math.round(S * 0.034)}px "Helvetica Neue",Arial,sans-serif`;
        ctx.fillText('REVOLUTIONS %', cx, cy + R * 0.26);
        // 小窓：指令（デジタル）
        ctx.fillStyle = '#021a08'; ctx.fillRect(cx - R * 0.33, cy + R * 0.5, R * 0.66, R * 0.2);
        ctx.fillStyle = order < 0 ? '#ff6b60' : '#5dff8a'; ctx.font = `bold ${Math.round(S * 0.05)}px "Courier New",monospace`;
        ctx.fillText(special ? _TG_SPECIAL[special].short : `${order > 0 ? 'AH' : order < 0 ? 'AS' : ''} ${_TG_LABEL[order]}`, cx, cy + R * 0.6);
        ctx.textAlign = 'start';
        _needle(ctx, cx, cy, aAng, R * 0.55, S * 0.016, '#ff3b30');
        _needle(ctx, cx, cy, hAng, R * 0.8, S * 0.025, '#f5f0e0');
        ctx.fillStyle = _chrome(ctx, cx - 8, cy - 8, cx + 8, cy + 8);
        ctx.beginPath(); ctx.arc(cx, cy, R * 0.08, 0, Math.PI * 2); ctx.fill();
        _drawSpecialBtns(ctx, S, design, special, ansSpecial);
        return;
    }

    if (design === 'modern') {
        // 押しボタンのパネル（上から全速前進〜全速後進）
        const x0 = S * 0.14, w = S * 0.72, y0 = S * 0.05, h = S * 0.9;
        ctx.fillStyle = '#16191d'; _roundRect(ctx, x0, y0, w, h, S * 0.04); ctx.fill();
        ctx.strokeStyle = '#3a4048'; ctx.lineWidth = 2; ctx.stroke();
        const bh = h / 8.6;
        for (let k = 0; k < 7; k++) {
            const v = 3 - k;
            const by = y0 + S * 0.03 + (k + 1) * bh;      // 1段目はスタンバイ・機関終了
            const on = v === order && !special, ans = v === Math.round(answerV) && !ansSpecial;
            ctx.fillStyle = on ? (v < 0 ? '#ff5a3c' : (v === 0 ? '#ffd23c' : '#46e07a')) : '#262b31';
            _roundRect(ctx, x0 + S * 0.05, by, w - S * 0.1, bh * 0.82, S * 0.02); ctx.fill();
            if (ans && !on) { ctx.strokeStyle = '#ffd23c'; ctx.lineWidth = 2; ctx.stroke(); }
            ctx.fillStyle = on ? '#101010' : (v < 0 ? '#ff8a73' : (v === 0 ? '#f2f2f2' : '#8ff0ad'));
            ctx.font = `bold ${Math.round(S * 0.052)}px "Helvetica Neue",Arial,sans-serif`;
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(v === 0 ? 'STOP' : `${_TG_LABEL[v]} ${v > 0 ? 'AHEAD' : 'ASTERN'}`, x0 + w / 2, by + bh * 0.41);
        }
        _drawSpecialBtns(ctx, S, design, special, ansSpecial);
        return;
    }

    if (design === 'rotary') {
        // 目盛りの付いた回転つまみ
        ctx.fillStyle = '#20252b'; _roundRect(ctx, S * 0.05, S * 0.08, S * 0.9, S * 0.86, S * 0.06); ctx.fill();
        ctx.font = `bold ${Math.round(S * 0.048)}px "Helvetica Neue",Arial,sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        for (let v = -3; v <= 3; v++) {
            const a = _tgAngle(design, v);
            ctx.fillStyle = (v === order && !special) ? '#ffd23c' : (v > 0 ? '#8ff0ad' : (v < 0 ? '#ff8a73' : '#f2f2f2'));
            ctx.fillText(v === 0 ? 'STOP' : _TG_LABEL[v], cx + Math.sin(a) * R * 0.8, cy - Math.cos(a) * R * 0.8);
            ctx.fillRect(cx + Math.sin(a) * R * 0.62 - 2, cy - Math.cos(a) * R * 0.62 - 2, 4, 4);
        }
        ctx.fillStyle = '#8ff0ad'; ctx.fillText('AHEAD ▶', cx + R * 0.5, cy + R * 0.72);
        ctx.fillStyle = '#ff8a73'; ctx.fillText('◀ ASTERN', cx - R * 0.5, cy + R * 0.72);
        ctx.textAlign = 'start';
        // つまみ（ギザギザの縁）
        ctx.save(); ctx.translate(cx, cy); ctx.rotate(hAng);
        ctx.fillStyle = '#0d0f11';
        ctx.beginPath();
        for (let i = 0; i < 40; i++) { const a = i / 40 * Math.PI * 2; const r = R * (i % 2 ? 0.5 : 0.53); ctx.lineTo(Math.sin(a) * r, -Math.cos(a) * r); }
        ctx.closePath(); ctx.fill();
        ctx.fillStyle = _chrome(ctx, -R * 0.4, -R * 0.4, R * 0.4, R * 0.4);
        ctx.beginPath(); ctx.arc(0, 0, R * 0.42, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#ff9f1a'; ctx.fillRect(-S * 0.012, -R * 0.5, S * 0.024, R * 0.3);
        ctx.restore();
        // 応答ランプ
        const aa = _tgAngle(design, answerV);
        ctx.fillStyle = '#ff3b30'; ctx.beginPath(); ctx.arc(cx + Math.sin(aa) * R * 0.95, cy - Math.cos(aa) * R * 0.95, S * 0.014, 0, Math.PI * 2); ctx.fill();
        _drawSpecialBtns(ctx, S, design, special, ansSpecial);
        return;
    }

    if (design === 'tilt') {
        // 横から見たレバー：前へ倒すと前進、手前へ倒すと後進
        const px = cx, py = S * 0.86;
        ctx.fillStyle = '#23282e'; _roundRect(ctx, S * 0.05, S * 0.05, S * 0.9, S * 0.9, S * 0.06); ctx.fill();
        // 目盛りの弧
        ctx.font = `bold ${Math.round(S * 0.045)}px "Helvetica Neue",Arial,sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        for (let v = -3; v <= 3; v++) {
            const a = _tgAngle(design, v);
            const L = S * 0.56;
            ctx.strokeStyle = (v === order && !special) ? '#ffd23c' : '#6c7580'; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.moveTo(px + Math.sin(a) * L * 0.9, py - Math.cos(a) * L * 0.9); ctx.lineTo(px + Math.sin(a) * L * 0.97, py - Math.cos(a) * L * 0.97); ctx.stroke();
            ctx.fillStyle = (v === order && !special) ? '#ffd23c' : (v > 0 ? '#8ff0ad' : (v < 0 ? '#ff8a73' : '#f2f2f2'));
            ctx.save(); ctx.translate(px + Math.sin(a) * L * 1.08, py - Math.cos(a) * L * 1.08); ctx.rotate(a);
            ctx.fillText(v === 0 ? 'STOP' : _TG_LABEL[v], 0, 0); ctx.restore();
        }
        ctx.fillStyle = '#8ff0ad'; ctx.fillText('AHEAD', S * 0.8, S * 0.9);
        ctx.fillStyle = '#ff8a73'; ctx.fillText('ASTERN', S * 0.2, S * 0.9);
        ctx.textAlign = 'start';
        // 応答の印
        const aa = _tgAngle(design, answerV);
        ctx.fillStyle = '#ff3b30'; ctx.beginPath(); ctx.arc(px + Math.sin(aa) * S * 0.49, py - Math.cos(aa) * S * 0.49, S * 0.014, 0, Math.PI * 2); ctx.fill();
        // 溝とレバー
        ctx.fillStyle = '#0b0d0f'; ctx.beginPath(); ctx.arc(px, py, S * 0.12, Math.PI, 0); ctx.fill();
        ctx.save(); ctx.translate(px, py); ctx.rotate(hAng);
        ctx.fillStyle = _chrome(ctx, -S * 0.02, 0, S * 0.02, -S * 0.42);
        ctx.fillRect(-S * 0.018, -S * 0.39, S * 0.036, S * 0.39);
        ctx.fillStyle = '#111'; ctx.beginPath(); ctx.ellipse(0, -S * 0.42, S * 0.048, S * 0.058, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.beginPath(); ctx.ellipse(-S * 0.014, -S * 0.435, S * 0.016, S * 0.024, 0, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
        _drawSpecialBtns(ctx, S, design, special, ansSpecial);
        return;
    }
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
function _drawSpecialBtns(ctx, S, design, special, ansSpecial) {
    const rects = _tgSpecialRects(design, S);
    ctx.font = `bold ${Math.round(S * 0.042)}px "Helvetica Neue",Arial,sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const [key, [x, y, w, h]] of Object.entries(rects)) {
        const on = special === key, ans = ansSpecial === key;
        ctx.fillStyle = on ? (key === 'standby' ? '#ffb020' : '#4aa3ff') : '#262b31';
        _roundRect(ctx, x, y, w, h, S * 0.02); ctx.fill();
        ctx.strokeStyle = ans ? '#ffd23c' : '#3a4048'; ctx.lineWidth = ans ? 2 : 1; ctx.stroke();
        ctx.fillStyle = on ? '#101010' : (key === 'standby' ? '#ffc861' : '#8cc6ff');
        ctx.fillText(_TG_SPECIAL[key].short, x + w / 2, y + h * 0.52);
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
        _br.tgHandle = _tgFromAngleCont(d, angleAt(p));
        _br.dirtyT = true;
    });
    cv.addEventListener('pointermove', (e) => {
        if (!_br.tgDrag) return;
        e.preventDefault();
        _br.tgHandle = _tgFromAngleCont(bridgeUI.telegraph, angleAt(_localPos(cv, e)));
        _br.dirtyT = true;
    });
    const up = (e) => {
        if (!_br.tgDrag) return;
        _br.tgDrag = null;
        const v = Math.round(_br.tgHandle);
        const sp = Object.keys(_TG_SPECIAL).find(k => _TG_SPECIAL[k].v === v);
        if (sp) setTelegraphSpecial(sp); else setTelegraphOrder(v);
        _br.dirtyT = true;
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
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
            _br.wheelDeg = 0; _br.lastTap = 0; _br.dirtyW = true; return;
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
        if (Math.abs(d) > 0.001) { _br.tgHandle += d * (1 - Math.exp(-dt / 0.08)); _br.dirtyT = true; }
    }
    const da = _tgPos(design, physics.telegraphAnswer, ansSpecial) - _br.answer;
    if (Math.abs(da) > 0.001) { _br.answer += da * (1 - Math.exp(-dt / 0.15)); _br.dirtyT = true; }

    // 舵輪：A/Dキーで回す
    const lock = WHEEL_LOCK_DEG[bridgeUI.wheel] || 360;
    if (bridgeWheelActive()) {
        if (keys.a) { _br.wheelDeg = Math.max(-lock, _br.wheelDeg - HELM_KEY_RATE / 35 * lock * dt); _br.dirtyW = true; }
        if (keys.d) { _br.wheelDeg = Math.min(lock, _br.wheelDeg + HELM_KEY_RATE / 35 * lock * dt); _br.dirtyW = true; }
        physics.helmOrder = _br.wheelDeg / lock * 35;
    }
    if (Math.abs(physics.rudderAngle - _br.lastRudder) > 0.05) { _br.lastRudder = physics.rudderAngle; _br.dirtyW = true; }

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
function getBridgeConfig() { return { telegraph: bridgeUI.telegraph, wheel: bridgeUI.wheel, wheelText: bridgeUI.wheelText, waitAnswer: bridgeUI.waitAnswer }; }
function applyBridgeConfig(c) {
    const d = { telegraph: 'olympic', wheel: 'classic', wheelText: 'R.M.S. OLYMPIC', waitAnswer: true };
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
    if (key === 'waitAnswer') bridgeUI.waitAnswer = !!v;
    else bridgeUI[key] = v;
    if (key === 'wheel') _br.wheelDeg = Math.max(-(WHEEL_LOCK_DEG[v] || 360), Math.min(WHEEL_LOCK_DEG[v] || 360, physics.helmOrder / 35 * (WHEEL_LOCK_DEG[v] || 360)));
    applyBridgeLayout();
}
window.setBridgeOption = setBridgeOption;

function renderBridgePanel() {
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
