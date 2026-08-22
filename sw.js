// このService Workerは「インストール可能(standalone表示)」の条件を満たすためだけの
// 最小構成です。オフラインキャッシュなどは行わず、すべてのリクエストをそのまま
// ネットワーク(Termuxのローカルサーバー)に通すだけです。
self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
    event.respondWith(fetch(event.request));
});
