// Service Worker — ホーム画面にインストールしたアプリとして動かすためのもの
//
// ・インストール（Chromeの「アプリをインストール」「ホーム画面に追加」）の条件を満たす
// ・一度オンラインで開けば、次からは電波が無くても起動できるよう、読み込んだ
//   ファイル（HTML・JS・CSS・three.js本体など）を保存しておく
//
// 取り方は「ネットワーク優先」：つながっていれば常に最新を取りに行き、その結果で
// 保存分も更新する。つながらないときだけ保存分を使う。ローカルサーバー
// （Termux）でファイルを書き換えても、古い版が出続けることはない。
//
// 船のモデル（.glb 等）は数十MBあり、アプリ側で IndexedDB に保存している
// （27-model-store.js）ので、ここでは二重に保存しない。

const CACHE_NAME = 'shipsim-runtime-v1';
const CDN_HOSTS = ['cdnjs.cloudflare.com', 'cdn.jsdelivr.net'];
const SKIP_EXT = /\.(glb|gltf|obj|mtl|bin|zip|apk)(\?|$)/i;

self.addEventListener('install', (event) => {
    // 起動に最低限必要なものだけ先に保存しておく（失敗しても続行）
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => Promise.allSettled(['./', './index.html', './css/style.css', './manifest.json',
                './icon-192.png', './icon-512.png'].map((u) => cache.add(u))))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET' || req.headers.has('range')) return;
    const url = new URL(req.url);
    const sameOrigin = url.origin === self.location.origin;
    if (!sameOrigin && !CDN_HOSTS.includes(url.hostname)) return;
    if (SKIP_EXT.test(url.pathname)) return;

    event.respondWith(
        fetch(req)
            .then((res) => {
                // 正常な応答だけ保存する（cross-origin は CORS 付きのものだけ。
                // 中身の見えない opaque 応答は容量を大きく食うので保存しない）
                if (res && res.ok && (res.type === 'basic' || res.type === 'cors')) {
                    const copy = res.clone();
                    caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
                }
                return res;
            })
            .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => {
                if (hit) return hit;
                if (req.mode === 'navigate') return caches.match('./index.html');
                return Response.error();
            }))
    );
});
