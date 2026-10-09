// 39-android-app.js — Android アプリ（APK）の中で動いているときの調整
//
// APK（android/ フォルダ。shipsim-android.apk）は、このページを全画面の WebView で
// 開くだけの入れ物。アプリの中では window.ShipSimNative（Java 側の窓口）が見える。
// ブラウザで開いているときは ShipSimNative が無いので、ここは何もしない。
//
// ・ファイルの保存：WebView では <a download> の保存が効かないので、保存しようとした
//   ファイル（スクショ・動画・船の設定・ZIP）の中身を小分けにしてアプリへ渡し、
//   「写真」「動画」「ダウンロード」の ShipSim フォルダに保存してもらう。
//   各機能の保存処理はそのまま（a.click() を横取りする）。
// ・戻るボタン：開いているパネル・メニューを閉じる（閉じる物が無ければアプリ側で終了確認）
// ・アプリが裏に回ったとき：音を止める（visibilitychange が来ない端末のための念押し）

(function () {
    const N = window.ShipSimNative;
    if (!N) return;
    document.documentElement.classList.add('in-android-app');

    // 保存用のファイルを、URL を作った時点で覚えておく（すぐ revoke されても保存できるように）
    const blobs = new Map();
    const origCreate = URL.createObjectURL.bind(URL);
    const origRevoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = function (obj) {
        const u = origCreate(obj);
        if (obj instanceof Blob) blobs.set(u, obj);
        return u;
    };
    URL.revokeObjectURL = function (u) {
        setTimeout(() => blobs.delete(u), 120000);
        return origRevoke(u);
    };

    // 768KB ずつ base64 にしてアプリへ渡す（一度に大きな文字列を渡すと落ちるため）
    const CHUNK = 3 * 256 * 1024;
    function readChunkBase64(blob) {
        return new Promise((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = () => { const s = String(fr.result); resolve(s.slice(s.indexOf(',') + 1)); };
            fr.onerror = () => reject(fr.error);
            fr.readAsDataURL(blob);
        });
    }
    async function saveBlob(blob, name) {
        const id = N.saveBegin(name, blob.type || '');
        if (!id) { N.toast('保存できませんでした'); return false; }
        try {
            for (let off = 0; off < blob.size; off += CHUNK) {
                const b64 = await readChunkBase64(blob.slice(off, off + CHUNK));
                if (!N.saveChunk(id, b64)) throw new Error('chunk');
            }
            return !!N.saveEnd(id);
        } catch (e) {
            try { N.saveAbort(id); } catch (_) { /* ignore */ }
            N.toast('保存できませんでした');
            return false;
        }
    }
    async function saveUrl(url, name) {
        let blob = blobs.get(url);
        if (!blob) {
            try { blob = await (await fetch(url)).blob(); }
            catch (e) { N.toast('保存できませんでした'); return false; }
        }
        return saveBlob(blob, name || 'shipsim_file');
    }
    window.shipsimSaveUrl = saveUrl;

    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
        const href = this.href || '';
        if (this.hasAttribute('download') && /^(blob|data):/i.test(href)) {
            saveUrl(href, this.getAttribute('download'));
            return;
        }
        return origClick.call(this);
    };

    // 戻るボタン：閉じた物があれば true
    window.shipsimOnBack = function () {
        const vm = document.getElementById('viewpoint-menu');
        if (vm && vm.style.display === 'block') { vm.style.display = 'none'; return true; }
        const sp = document.getElementById('settings-panel');
        if (sp && sp.classList.contains('open') && typeof toggleSettings === 'function') { toggleSettings(); return true; }
        const ui = document.getElementById('ui-container');
        if (ui && ui.classList.contains('open') && typeof toggleMenu === 'function') { toggleMenu(); return true; }
        return false;
    };

    // アプリが裏に回った・戻った
    window.shipsimNativePause = function (paused) {
        try {
            if (typeof audio === 'undefined' || !audio.ctx) return;
            if (paused) audio.ctx.suspend();
            else if (audio.settings.enabled && document.visibilityState === 'visible') audio.ctx.resume();
        } catch (e) { /* ignore */ }
    };
})();
