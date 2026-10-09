// 38-clip-recorder.js — スクショを撮ったとき、直前の数秒の動画も保存する
//
// 3D の画面（HUD のボタン類は入らない）と船の音を、裏でずっと録画しておき、
// スクショを撮った瞬間に「直前の約5〜10秒」を動画として保存する。
//
// 録画は2本を5秒ずらして交互に回す（どちらも10秒ごとに録り直す）。
// 録画ファイルは途中から切り出すと再生できないことが多いので、撮った時点で
// 5秒以上録れている方を止めてそのまま保存する。こうすると、いつ撮っても
// 直前5秒は必ず入る（長さは5〜10秒）。
// 動画のエンコードを常に2本回すので、端末が温まりやすい。設定で切れる。

const clipRec = {
    enabled: true,
    recs: [null, null], started: [0, 0],
    stream: null, hasAudio: false, audioDest: null, mime: '', timer: null,
};
window.clipRec = clipRec;
const CLIP_SEGMENT_MS = 10000;
const CLIP_OFFSET_MS = 5000;

(function restoreClipSetting() {
    try { const v = localStorage.getItem('susuru_clip'); if (v !== null) clipRec.enabled = v === '1'; } catch (e) { /* ignore */ }
})();

function _clipSupported() {
    return typeof MediaRecorder !== 'undefined' && typeof renderer !== 'undefined' && renderer
        && renderer.domElement && typeof renderer.domElement.captureStream === 'function';
}
function _clipMime() {
    const cands = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    for (const m of cands) { try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (e) { /* ignore */ } }
    return '';
}

function _clipStopAll() {
    for (let i = 0; i < 2; i++) {
        const r = clipRec.recs[i];
        if (r && r.state !== 'inactive') { r.ondataavailable = null; try { r.stop(); } catch (e) { /* ignore */ } }
        clipRec.recs[i] = null;
    }
}

// 画面と音を1本の流れにまとめる（音の仕組みが後から起動したら作り直す）
function _clipEnsureStream() {
    const wantAudio = !!(typeof audio !== 'undefined' && audio.ctx && audio.comp && typeof audio.ctx.createMediaStreamDestination === 'function'
        && !(typeof _audioOffline === 'function' && _audioOffline()));
    if (clipRec.stream && clipRec.hasAudio === wantAudio) return true;
    _clipStopAll();
    const tracks = renderer.domElement.captureStream(30).getVideoTracks();
    if (wantAudio) {
        if (!clipRec.audioDest || clipRec.audioDest.context !== audio.ctx) {
            clipRec.audioDest = audio.ctx.createMediaStreamDestination();
            audio.comp.connect(clipRec.audioDest);
        }
        tracks.push(...clipRec.audioDest.stream.getAudioTracks());
    }
    clipRec.stream = new MediaStream(tracks);
    clipRec.hasAudio = wantAudio;
    clipRec.mime = _clipMime();
    return true;
}

function _clipStart(i) {
    try {
        const opts = { videoBitsPerSecond: 6000000 };
        if (clipRec.mime) opts.mimeType = clipRec.mime;
        const r = new MediaRecorder(clipRec.stream, opts);
        r._chunks = [];
        r.ondataavailable = (e) => { if (e.data && e.data.size) r._chunks.push(e.data); };
        r.start(1000);
        clipRec.recs[i] = r;
        clipRec.started[i] = performance.now();
    } catch (e) {
        console.warn('[Clip] 録画を開始できませんでした:', e);
        clipRec.enabled = false;
    }
}

function _clipTick() {
    if (!clipRec.enabled || document.visibilityState !== 'visible' || !_clipSupported()) { _clipStopAll(); return; }
    if (!_clipEnsureStream()) return;
    const now = performance.now();
    for (let i = 0; i < 2; i++) {
        const r = clipRec.recs[i];
        if (!r) {
            // 2本目は1本目から5秒遅らせて始める
            const other = clipRec.recs[1 - i];
            if (i === 1 && other && now - clipRec.started[0] < CLIP_OFFSET_MS) continue;
            _clipStart(i);
        } else if (now - clipRec.started[i] >= CLIP_SEGMENT_MS) {
            // 録り直し（古い録画は捨てる）
            r.ondataavailable = null;
            try { r.stop(); } catch (e) { /* ignore */ }
            _clipStart(i);
        }
    }
}

// スクショを撮ったときに呼ぶ：直前の動画を保存する
function saveRecentClip() {
    if (!clipRec.enabled) return false;
    const now = performance.now();
    let best = -1;
    for (let i = 0; i < 2; i++) {
        const r = clipRec.recs[i];
        if (r && r.state === 'recording' && (best < 0 || clipRec.started[i] < clipRec.started[best])) best = i;
    }
    if (best < 0) return false;
    const r = clipRec.recs[best];
    const secs = (now - clipRec.started[best]) / 1000;
    clipRec.recs[best] = null;
    r.onstop = () => {
        const type = (r.mimeType || clipRec.mime || 'video/webm').split(';')[0];
        const blob = new Blob(r._chunks, { type });
        const ext = type.includes('mp4') ? 'mp4' : 'webm';
        const pad = (n) => String(n).padStart(2, '0');
        const d = new Date();
        const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `ship_clip_${stamp}_${Math.round(secs)}s.${ext}`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    };
    try { r.stop(); } catch (e) { return false; }
    // 止めた方はすぐ録り直す（次のスクショに備える）
    _clipStart(best);
    return true;
}
window.saveRecentClip = saveRecentClip;

function setClipEnabled(on) {
    clipRec.enabled = !!on;
    try { localStorage.setItem('susuru_clip', on ? '1' : '0'); } catch (e) { /* ignore */ }
    if (!on) _clipStopAll();
}
window.setClipEnabled = setClipEnabled;

document.addEventListener('DOMContentLoaded', () => {
    const cb = document.getElementById('clip-enabled');
    if (cb) cb.checked = clipRec.enabled;
    // 3D の描画が始まってから録画を回し始める
    clipRec.timer = setInterval(_clipTick, 500);
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') _clipStopAll(); });
