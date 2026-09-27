// 41-no-zoom.js — メニューを触っていて画面が拡大してしまうのを防ぐ
//
// iPhone/iPad の Safari は user-scalable=no を無視して、
//   ・小さな文字の入力欄に触れると、自動で拡大する
//   ・2本指で広げる・ダブルタップで拡大する
// このアプリは2本指の操作を3Dの視点に使っているので、一度拡大すると戻せなくなる。
//   ・viewport に maximum-scale=1 を付ける（入力欄の自動拡大が止まる）
//   ・Safari の拡大の合図（gesturestart）を止める。3Dの2本指操作は touch イベントで
//     行っているので影響しない
//   ・それでも拡大してしまったら、viewport を書き直して元の倍率に戻す

(function () {
    const stop = (e) => { e.preventDefault(); };
    ['gesturestart', 'gesturechange', 'gestureend'].forEach(t => document.addEventListener(t, stop, { passive: false }));
    // ダブルタップでの拡大（touch-action が効かない古い端末用）
    let lastTouchEnd = 0;
    document.addEventListener('touchend', (e) => {
        const now = Date.now();
        const t = e.target;
        const isField = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
        if (!isField && now - lastTouchEnd < 300 && e.touches.length === 0 && e.cancelable &&
            !(t && t.closest && t.closest('canvas'))) e.preventDefault();
        lastTouchEnd = now;
    }, { passive: false });

    // 拡大されてしまったら元に戻す
    const meta = document.getElementById('meta-viewport') || document.querySelector('meta[name=viewport]');
    const reset = () => {
        if (!meta || !window.visualViewport || window.visualViewport.scale <= 1.01) return;
        const c = meta.getAttribute('content');
        meta.setAttribute('content', c.replace(/maximum-scale=[^,]*/, 'maximum-scale=1.01'));
        setTimeout(() => meta.setAttribute('content', c), 50);
    };
    if (window.visualViewport) {
        let timer = null;
        window.visualViewport.addEventListener('resize', () => { clearTimeout(timer); timer = setTimeout(reset, 400); });
    }
    // 入力欄から離れたとき（キーボードが閉じたとき）にも確かめる
    document.addEventListener('focusout', () => setTimeout(reset, 300));
})();
