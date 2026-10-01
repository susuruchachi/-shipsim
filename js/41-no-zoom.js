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

// ── パネルの書き換え ──
// 自動航行・タグなどのパネルは、状態が変わるたび（数百ミリ秒ごと）に中身を作り直している。
// 作り直すと、開いているプルダウンが勝手に閉じ、押している途中のボタンが消えて効かないことがあった。
//  ・中身が同じなら書き換えない
//  ・パネルの中のプルダウン・入力欄を触っている間、指・マウスを押している間は書き換えを待ち、
//    離したあと（プルダウンを閉じたあと）に最新の中身にする
function uiSetHTML(el, html) {
    if (!el) return;
    if (!el._uiInit) {
        el._uiInit = true;
        const down = () => { el._uiDown = true; };
        el.addEventListener('pointerdown', down, true);
        el.addEventListener('touchstart', down, { passive: true, capture: true });
        el.addEventListener('mousedown', down, true);
        const later = (ms) => setTimeout(() => _uiFlush(el), ms);
        const up = () => { if (el._uiDown) { el._uiDown = false; later(400); } };
        document.addEventListener('pointerup', up, true);
        document.addEventListener('pointercancel', up, true);
        document.addEventListener('touchend', up, true);
        document.addEventListener('touchcancel', up, true);
        document.addEventListener('mouseup', up, true);
        el.addEventListener('change', () => later(300));
        el.addEventListener('focusout', () => later(300));
    }
    if (el._uiHtml === html && !el._uiPending) return;
    el._uiPending = html;
    _uiFlush(el);
}
function _uiBusy(el) {
    const ae = document.activeElement;
    return !!el._uiDown || !!(ae && ae !== document.body && el.contains(ae) && /^(SELECT|INPUT|TEXTAREA)$/.test(ae.tagName) && !/^(checkbox|radio|button)$/i.test(ae.type || ''));
}
function _uiFlush(el) {
    const html = el._uiPending;
    if (html == null || _uiBusy(el)) return;
    el._uiPending = null;
    if (el._uiHtml === html) return;
    el._uiHtml = html;
    const keep = el.scrollTop;
    el.innerHTML = html;
    el.scrollTop = keep;
}
window.uiSetHTML = uiSetHTML;
