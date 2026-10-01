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
    // タップ：指を離した時点で、その場で click を届ける（ブラウザの合成する click は使わない）。
    //  重い場面では、ブラウザがタップを「長押し」などと見なして click を出さないことがあり、待っても
    //  ボタンが効かなかった。touchend は重くても順に必ず届くので、ここで確実に押したことにする。
    //  （動かした・長く押した・入力欄・3D画面・押している間だけ効くボタン（data-hold）は除く）
    //  あわせて、ダブルタップでの拡大も起きない（ネイティブの click を止めるので）
    let tap = null;
    document.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) { tap = null; return; }
        const c = e.touches[0];
        tap = { x: c.clientX, y: c.clientY, t: e.timeStamp, target: e.target, ev: e };
    }, { passive: true, capture: true });
    document.addEventListener('touchmove', (e) => {
        if (!tap) return;
        const c = e.touches[0];
        if (!c || Math.hypot(c.clientX - tap.x, c.clientY - tap.y) > 12) tap = null;
    }, { passive: true, capture: true });
    document.addEventListener('touchend', (e) => {
        const T = tap; tap = null;
        if (!T || e.touches.length !== 0 || !e.cancelable) return;
        const c = e.changedTouches && e.changedTouches[0];
        if (!c || Math.hypot(c.clientX - T.x, c.clientY - T.y) > 12) return;
        if (e.timeStamp - T.t > 900) return;                             // 長押し
        if (T.ev.defaultPrevented) return;                               // 押した瞬間に自分で動くボタン（メニュー・テレグラフなど）
        const t = T.target;
        if (!t || !t.closest) return;
        if (t.closest('canvas, [data-hold], textarea, select')) return;
        const inp = t.closest('input');
        if (inp && !/^(checkbox|radio|button|submit)$/i.test(inp.type)) return;   // 文字・数字・スライダーの入力欄
        e.preventDefault();
        const el = document.elementFromPoint(c.clientX, c.clientY) || t;
        if (typeof el.click === 'function') el.click();
    }, { passive: false, capture: true });

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
