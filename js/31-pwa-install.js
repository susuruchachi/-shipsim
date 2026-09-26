// 31-pwa-install.js — ホーム画面にアプリとしてインストールするボタン
//
// Chrome（Android・パソコン）は、manifest.json と Service Worker（sw.js）が
// そろっていると「アプリをインストール」できる。その案内が出せる状態になると
// beforeinstallprompt イベントが来るので、それを取っておき、メニューの
// 「📲 アプリとしてインストール」ボタンから出す。
//   ・すでにアプリとして開いている／インストール済みならボタンは出さない
//   ・iPhone/iPad の Safari にはこの仕組みが無いので、手順の案内だけ出す
//
// 【注意】インストールできるのは https:// か http://localhost（同じ端末の
// ローカルサーバー）で開いたときだけ。別の端末から http://192.168.x.x のように
// 開いた場合、ブラウザはインストールを許可しない。

let _pwaDeferredPrompt = null;

function _pwaIsStandalone() {
    return (window.matchMedia && (window.matchMedia('(display-mode: standalone)').matches
        || window.matchMedia('(display-mode: fullscreen)').matches))
        || window.navigator.standalone === true;
}

function _pwaShow(show, note) {
    const box = document.getElementById('pwa-install-box');
    if (!box) return;
    box.style.display = show ? '' : 'none';
    const n = document.getElementById('pwa-install-note');
    if (n) n.textContent = note || '';
}

window.addEventListener('beforeinstallprompt', (e) => {
    // ブラウザ任せの小さな案内は出さず、メニューのボタンから出す
    e.preventDefault();
    _pwaDeferredPrompt = e;
    if (!_pwaIsStandalone()) {
        _pwaShow(true, 'ホーム画面から全画面で起動できます。一度開けば、電波が無くても起動できます。');
        const btn = document.getElementById('pwa-install-btn');
        if (btn) btn.style.display = '';
    }
});

window.addEventListener('appinstalled', () => {
    _pwaDeferredPrompt = null;
    _pwaShow(false);
});

document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('pwa-install-btn');
    if (btn) {
        btn.addEventListener('click', async () => {
            if (!_pwaDeferredPrompt) return;
            const ev = _pwaDeferredPrompt;
            _pwaDeferredPrompt = null;
            ev.prompt();
            try {
                const choice = await ev.userChoice;
                if (choice && choice.outcome === 'accepted') _pwaShow(false);
            } catch (e) { /* ignore */ }
        });
        ['mousedown', 'touchstart'].forEach(t => btn.addEventListener(t, (e) => e.stopPropagation()));
    }
    // iPhone/iPad の Safari：インストールのイベントが無いので、手順だけ案内する
    const ua = navigator.userAgent || '';
    const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (isIOS && !_pwaIsStandalone()) {
        if (btn) btn.style.display = 'none';
        _pwaShow(true, '📲 ホーム画面に追加するには、Safari の共有ボタン（□↑）から「ホーム画面に追加」を選んでください。');
    }
});
