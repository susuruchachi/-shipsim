// 33-performance.js — 描画頻度の上限と、重さに応じた内部解像度の自動調整
//
// ════════════════════════════════════════════════════════════════
//  なぜ必要か
// ════════════════════════════════════════════════════════════════
// iPad などの高性能な端末で「バックグラウンドから戻った直後は軽いのに、
// しばらくすると重くなる」のは、発熱による性能低下（サーマルスロットリング）の
// 典型的な症状。バックグラウンドの間に冷え、戻ると最初は速いが、全力で描き
// 続けるうちに熱くなって GPU のクロックが落ちる。120Hz 表示の端末では、
// 1秒に120回全力で描くのでなおさら熱を持ちやすい。
//
//  ・描画の頻度に上限を設ける（既定60fps）。見た目はほぼ変わらず、発熱と
//    電池の消耗が大きく減る。30fps（省電力）も選べる
//  ・実際のフレーム時間を見て、重くなってきたら内部解像度を少し下げ、余裕が
//    戻れば元へ上げる（動的解像度）。熱で遅くなっても滑らかさを保つ
//  ・ブルーム（光のにじみ）の抽出は、シーン全体をもう1回描く重い処理なので
//    1フレームおきにする（光のにじみは1フレーム遅れても見分けがつかない）

const perfGovernor = {
    fpsCap: 60,            // 0 = 制限なし
    autoResolution: true,  // 重さに応じて内部解像度を自動調整するか
    scale: 1.0,            // 画質設定の解像度に掛ける倍率（0.6〜1）
    _lastFrameTs: -1,
    _frameTimes: [],       // 直近の実フレーム間隔[ms]
    _lastAdjust: 0,
    _goodSince: -1,
    _frameNo: 0,
};
window.perfGovernor = perfGovernor;

const PG_SCALE_MIN = 0.6;
const PG_SCALE_STEP_DOWN = 0.88;
const PG_SCALE_STEP_UP = 1.06;
const PG_ADJUST_COOLDOWN = 2500;   // 解像度を変えたあと、次に変えるまで待つ時間[ms]
const PG_RECOVER_AFTER = 5000;     // 余裕のある状態がこの時間続いたら解像度を上げる[ms]

// animate() の最初（requestAnimationFrame の直後）に呼ぶ。
// false を返したら、このフレームは描かずに次を待つ（描画頻度の上限）。
function perfShouldRenderFrame(now) {
    const G = perfGovernor;
    if (!G.fpsCap) return true;
    const minInterval = 1000 / G.fpsCap;
    if (G._lastFrameTs >= 0 && now - G._lastFrameTs < minInterval - 2) return false;
    return true;
}

// 描いたフレームごとに呼ぶ：フレーム間隔を記録し、必要なら解像度を調整する
function perfRecordFrame(now) {
    const G = perfGovernor;
    G._frameNo++;
    if (G._lastFrameTs >= 0) {
        const dtMs = now - G._lastFrameTs;
        // バックグラウンド明けなどの極端な間隔は数えない
        if (dtMs > 0 && dtMs < 250) {
            G._frameTimes.push(dtMs);
            if (G._frameTimes.length > 90) G._frameTimes.shift();
        }
    }
    G._lastFrameTs = now;
    if (G.autoResolution) _perfAdjustResolution(now);
}

function _perfBasePixelRatio() {
    return Math.min(window.devicePixelRatio || 1, (typeof perf !== 'undefined' && perf.pixelRatio) ? perf.pixelRatio : 1);
}

function _perfApplyScale() {
    const pr = _perfBasePixelRatio() * perfGovernor.scale;
    if (typeof renderer !== 'undefined' && renderer && Math.abs(renderer.getPixelRatio() - pr) > 0.01) {
        renderer.setPixelRatio(pr);
        if (typeof bloomComposer !== 'undefined' && bloomComposer && bloomComposer.setPixelRatio) bloomComposer.setPixelRatio(pr);
    }
}

function _perfAdjustResolution(now) {
    const G = perfGovernor;
    if (G._frameTimes.length < 45 || now - G._lastAdjust < PG_ADJUST_COOLDOWN) return;
    // 中央値で判断する（たまのひっかかりに振り回されないように）
    const sorted = G._frameTimes.slice().sort((a, b) => a - b);
    const med = sorted[sorted.length >> 1];
    const budget = 1000 / (G.fpsCap || 60);
    if (med > budget * 1.3 && G.scale > PG_SCALE_MIN) {
        // 目標のフレーム時間に届いていない：解像度を少し下げる
        G.scale = Math.max(PG_SCALE_MIN, G.scale * PG_SCALE_STEP_DOWN);
        _perfApplyScale();
        G._lastAdjust = now; G._frameTimes.length = 0; G._goodSince = -1;
    } else if (med < budget * 1.08 && G.scale < 1) {
        // 余裕がある状態がしばらく続いたら、少しずつ元の解像度へ戻す
        if (G._goodSince < 0) G._goodSince = now;
        if (now - G._goodSince > PG_RECOVER_AFTER) {
            G.scale = Math.min(1, G.scale * PG_SCALE_STEP_UP);
            _perfApplyScale();
            G._lastAdjust = now; G._frameTimes.length = 0; G._goodSince = now;
        }
    } else {
        G._goodSince = -1;
    }
}

// ブルームの抽出をこのフレームで行うか（1フレームおき）
function perfShouldRenderBloomExtract() {
    return (perfGovernor._frameNo & 1) === 0;
}

// 画質設定を変えたとき（applyPerfPreset）は倍率をリセットする
function perfResetScale() {
    perfGovernor.scale = 1.0;
    perfGovernor._frameTimes.length = 0;
    perfGovernor._goodSince = -1;
}

function setFpsCap(v) {
    perfGovernor.fpsCap = parseInt(v, 10) || 0;
    perfGovernor._frameTimes.length = 0;
    try { localStorage.setItem('susuru_fps_cap', String(perfGovernor.fpsCap)); } catch (e) { /* ignore */ }
}
function setAutoResolution(on) {
    perfGovernor.autoResolution = !!on;
    if (!on) { perfGovernor.scale = 1; _perfApplyScale(); }
    try { localStorage.setItem('susuru_auto_res', on ? '1' : '0'); } catch (e) { /* ignore */ }
}

// バックグラウンドから戻ったら、測り直す（止まっていた間の長い間隔を数えない）
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        perfGovernor._lastFrameTs = -1;
        perfGovernor._frameTimes.length = 0;
        perfGovernor._goodSince = -1;
    }
});

// 保存しておいた設定を戻す（端末ごとの設定なので船の設定とは別に保存する）
(function restorePerfGovernorSettings() {
    try {
        const cap = localStorage.getItem('susuru_fps_cap');
        if (cap !== null) perfGovernor.fpsCap = parseInt(cap, 10) || 0;
        const ar = localStorage.getItem('susuru_auto_res');
        if (ar !== null) perfGovernor.autoResolution = ar === '1';
    } catch (e) { /* ignore */ }
    document.addEventListener('DOMContentLoaded', () => {
        const sel = document.getElementById('perf-fps-cap');
        if (sel) sel.value = String(perfGovernor.fpsCap);
        const cb = document.getElementById('perf-auto-res');
        if (cb) cb.checked = perfGovernor.autoResolution;
    });
})();
