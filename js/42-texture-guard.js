// 42-texture-guard.js — 重いモデルのテクスチャで船体が真っ黒になるのを防ぐ
//
// 大きなテクスチャ（4096〜8192px）をたくさん持つモデルを iPad 等で開くと、
// 画像の展開やGPUへの転送でメモリが足りなくなり、一部のテクスチャが
// 黒（空）のまま貼られて船体が真っ黒になることがある。そこで：
//
//  ・読み込む前に GLB の中の画像の大きさを調べ、端末のメモリに収まるよう
//    テクスチャの最大サイズ（辺の長さ）を決める。大きすぎる画像は縮めて展開する
//  ・画像の展開を同時にたくさん走らせない（iPad は1枚ずつ）
//  ・展開に失敗した・空（真っ黒で透明）になった画像は、半分の大きさでやり直す。
//    それでもだめなら灰色の仮の画像にして、モデル全体の読み込みは止めない
//
// 最大サイズは ⚙ の「軽さ」タブで選べる（自動／1024／2048／4096／制限なし）。
// 変えたら、モデルを読み込み直すと効く。

const texGuard = {
    setting: 'auto',          // 'auto' | '1024' | '2048' | '4096' | 'none'
    stats: null,              // 最後に読み込んだモデルの { reduced, maxFrom, cap, failed, retried }
    _active: 0,
    _queue: [],
};

(function () {
    try {
        const s = localStorage.getItem('susuru_tex_max');
        if (s && ['auto', '1024', '2048', '4096', 'none'].includes(s)) texGuard.setting = s;
    } catch (e) { /* ignore */ }
})();

function _texIsMobile() {
    const ua = navigator.userAgent || '';
    return /iPad|iPhone|iPod|Android|Mobile/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
function _texGpuMax() {
    try { return (renderer && renderer.capabilities && renderer.capabilities.maxTextureSize) || 4096; } catch (e) { return 4096; }
}
// 設定から { edge: 辺の上限, budget: 全テクスチャの画素数の上限 }
function _texLimits() {
    const gpu = _texGpuMax();
    if (texGuard.setting === 'none') return { edge: gpu, budget: Infinity };
    if (texGuard.setting !== 'auto') return { edge: Math.min(gpu, parseInt(texGuard.setting, 10)), budget: Infinity };
    return _texIsMobile()
        ? { edge: Math.min(gpu, 2048), budget: 48e6 }     // iPad・スマホ：およそ 250MB 分まで
        : { edge: Math.min(gpu, 4096), budget: 160e6 };
}

function setTextureMaxSize(v) {
    texGuard.setting = String(v);
    try { localStorage.setItem('susuru_tex_max', texGuard.setting); } catch (e) { /* ignore */ }
}

// ── 画像の大きさを、先頭のバイト列だけから読む（PNG・JPEG・WebP）──
function _texImageSize(u8) {
    const n = u8.length;
    if (n > 24 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4E && u8[3] === 0x47) {
        const dv = new DataView(u8.buffer, u8.byteOffset, n);
        return { w: dv.getUint32(16), h: dv.getUint32(20) };
    }
    if (n > 4 && u8[0] === 0xFF && u8[1] === 0xD8) {
        let i = 2;
        while (i + 9 < n) {
            if (u8[i] !== 0xFF) { i++; continue; }
            const m = u8[i + 1];
            if (m === 0xFF) { i++; continue; }
            if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
                return { h: (u8[i + 5] << 8) | u8[i + 6], w: (u8[i + 7] << 8) | u8[i + 8] };
            }
            if (m === 0xD8 || (m >= 0xD0 && m <= 0xD7) || m === 0x01) { i += 2; continue; }
            i += 2 + ((u8[i + 2] << 8) | u8[i + 3]);
        }
        return null;
    }
    if (n > 30 && u8[0] === 0x52 && u8[1] === 0x49 && u8[8] === 0x57 && u8[9] === 0x45) {   // RIFF....WEBP
        const tag = String.fromCharCode(u8[12], u8[13], u8[14], u8[15]);
        if (tag === 'VP8 ') return { w: (u8[26] | (u8[27] << 8)) & 0x3FFF, h: (u8[28] | (u8[29] << 8)) & 0x3FFF };
        if (tag === 'VP8L') { const b = u8[21] | (u8[22] << 8) | (u8[23] << 16) | (u8[24] << 24); return { w: (b & 0x3FFF) + 1, h: ((b >> 14) & 0x3FFF) + 1 }; }
        if (tag === 'VP8X') return { w: 1 + (u8[24] | (u8[25] << 8) | (u8[26] << 16)), h: 1 + (u8[27] | (u8[28] << 8) | (u8[29] << 16)) };
    }
    return null;
}

// ── GLB の中の画像を調べて、このモデルに使う最大サイズを決める ──
function _texScanGlb(data) {
    const sizes = [];
    try {
        if (!(data instanceof ArrayBuffer)) return sizes;
        const dv = new DataView(data);
        if (data.byteLength < 20 || dv.getUint32(0, true) !== 0x46546C67) return sizes;
        const jsonLen = dv.getUint32(12, true);
        const json = JSON.parse(new TextDecoder('utf-8').decode(new Uint8Array(data, 20, jsonLen)));
        const binStart = 20 + jsonLen + 8;
        for (const im of json.images || []) {
            if (im.bufferView === undefined) continue;
            const bv = json.bufferViews[im.bufferView];
            const off = binStart + (bv.byteOffset || 0);
            const s = _texImageSize(new Uint8Array(data, off, Math.min(bv.byteLength, 1 << 20)));
            if (s) sizes.push(s);
        }
    } catch (e) { /* 調べられなければ上限だけ使う */ }
    return sizes;
}
function _texChooseCap(sizes) {
    const L = _texLimits();
    let cap = L.edge;
    const total = c => sizes.reduce((a, s) => { const k = Math.min(1, c / Math.max(s.w, s.h)); return a + s.w * s.h * k * k; }, 0);
    while (cap > 512 && total(cap) > L.budget) cap = Math.floor(cap / 2);
    return cap;
}

// ── 画像の展開（同時に走らせる数を絞る）──
function _texRun(job) {
    return new Promise((resolve, reject) => {
        texGuard._queue.push({ job, resolve, reject });
        _texPump();
    });
}
function _texPump() {
    const limit = _texIsMobile() ? 1 : 3;
    while (texGuard._active < limit && texGuard._queue.length) {
        const q = texGuard._queue.shift();
        texGuard._active++;
        q.job().then(q.resolve, q.reject).finally(() => { texGuard._active--; _texPump(); });
    }
}

let _texProbeCanvas = null;
// 展開した画像が空（全部が黒で透明）になっていないか。メモリ不足の Safari はこうなる
function _texLooksBlank(img) {
    try {
        if (!_texProbeCanvas) { _texProbeCanvas = document.createElement('canvas'); _texProbeCanvas.width = _texProbeCanvas.height = 4; }
        const g = _texProbeCanvas.getContext('2d');
        g.clearRect(0, 0, 4, 4);
        g.drawImage(img, 0, 0, 4, 4);
        const d = g.getImageData(0, 0, 4, 4).data;
        for (let i = 0; i < d.length; i++) if (d[i] !== 0) return false;
        return true;
    } catch (e) { return false; }
}

// 大きすぎる画像をキャンバスで縮める（createImageBitmap の縮小が効かない端末用）
async function _texShrinkVia2d(img, w, h, opts) {
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const g = cv.getContext('2d');
    if (!g) throw new Error('canvas');
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, w, h);
    const out = await createImageBitmap(cv, opts);
    cv.width = cv.height = 0;       // iPad はキャンバスのメモリを早めに返す
    return out;
}

// blob を最大 cap の大きさで ImageBitmap にする
async function _texDecode(blob, opts, cap, size) {
    const fit = (w, h) => { const k = cap > 0 ? Math.min(1, cap / Math.max(w, h)) : 1; return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)), k }; };
    let bmp;
    if (size && cap > 0 && Math.max(size.w, size.h) > cap) {
        const t = fit(size.w, size.h);
        bmp = await createImageBitmap(blob, Object.assign({}, opts, { resizeWidth: t.w, resizeHeight: t.h, resizeQuality: 'high' }));
    } else {
        bmp = await createImageBitmap(blob, opts);
    }
    if (cap > 0 && Math.max(bmp.width, bmp.height) > cap) {
        // 縮小の指定が効かなかった
        const t = fit(bmp.width, bmp.height);
        const small = await _texShrinkVia2d(bmp, t.w, t.h, opts);
        bmp.close && bmp.close();
        bmp = small;
    }
    return bmp;
}

function _texPlaceholder(opts) {
    const d = new ImageData(2, 2);
    for (let i = 0; i < d.data.length; i += 4) { d.data[i] = d.data[i + 1] = d.data[i + 2] = 150; d.data[i + 3] = 255; }
    return createImageBitmap(d, opts);
}

// ctx：読み込み中のモデルごとの { cap, stats }（同時に2つ読み込んでも混ざらないように）
async function _texLoadBitmap(url, opts, ctx) {
    ctx = ctx || { cap: _texLimits().edge, stats: texGuard.stats || (texGuard.stats = _texNewStats(0)) };
    const st = ctx.stats;
    const res = await fetch(url);
    const blob = await res.blob();
    let size = null;
    try { size = _texImageSize(new Uint8Array(await blob.slice(0, 1 << 20).arrayBuffer())); } catch (e) { size = null; }
    let cap = ctx.cap || _texLimits().edge;
    if (size && Math.max(size.w, size.h) > cap) { st.reduced++; st.maxFrom = Math.max(st.maxFrom, size.w, size.h); st.cap = cap; }
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const bmp = await _texDecode(blob, opts, cap, size);
            if (attempt < 2 && _texLooksBlank(bmp) && (!size || Math.max(size.w, size.h) > 256)) {
                bmp.close && bmp.close();
                throw new Error('blank');
            }
            return bmp;
        } catch (e) {
            st.retried++;
            const edge = size ? Math.max(size.w, size.h) : 4096;
            cap = Math.max(256, Math.floor(Math.min(cap || edge, edge) / 2));
            await new Promise(r => setTimeout(r, 200));
        }
    }
    st.failed++;
    console.warn('[TextureGuard] テクスチャを読み込めませんでした:', url);
    return _texPlaceholder(opts);
}

// ── three.js の画像読み込みを差し替える ──
(function () {
    if (typeof THREE === 'undefined') return;

    // GLTFLoader が使う ImageBitmapLoader（Safari・Chrome）
    if (THREE.ImageBitmapLoader && typeof createImageBitmap !== 'undefined') {
        THREE.ImageBitmapLoader.prototype.load = function (url, onLoad, onProgress, onError) {
            if (url === undefined) url = '';
            if (this.path !== undefined) url = this.path + url;
            url = this.manager.resolveURL(url);
            const scope = this;
            const opts = Object.assign({}, this.options, { colorSpaceConversion: 'none' });
            const ctx = this.manager && this.manager.__texCtx;
            scope.manager.itemStart(url);
            _texRun(() => _texLoadBitmap(url, opts, ctx)).then((bmp) => {
                if (onLoad) onLoad(bmp);
                scope.manager.itemEnd(url);
            }).catch((e) => {
                if (onError) onError(e);
                scope.manager.itemError(url);
                scope.manager.itemEnd(url);
            });
        };
    }

    // TextureLoader が使う ImageLoader（Firefox・OBJ/MTL）：読んだ後で大きすぎれば縮める
    if (THREE.ImageLoader) {
        const origLoad = THREE.ImageLoader.prototype.load;
        THREE.ImageLoader.prototype.load = function (url, onLoad, onProgress, onError) {
            const tctx = this.manager && this.manager.__texCtx;
            return origLoad.call(this, url, function (img) {
                const cap = (tctx && tctx.cap) || _texLimits().edge;
                const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
                if (cap > 0 && Math.max(w, h) > cap) {
                    try {
                        const k = cap / Math.max(w, h);
                        const cv = document.createElement('canvas');
                        cv.width = Math.max(1, Math.round(w * k)); cv.height = Math.max(1, Math.round(h * k));
                        const g = cv.getContext('2d');
                        g.imageSmoothingQuality = 'high';
                        g.drawImage(img, 0, 0, cv.width, cv.height);
                        const st = tctx ? tctx.stats : (texGuard.stats || (texGuard.stats = _texNewStats(cap)));
                        st.reduced++; st.maxFrom = Math.max(st.maxFrom, w, h); st.cap = cap;
                        if (onLoad) onLoad(cv);
                        return;
                    } catch (e) { /* 縮められなければそのまま */ }
                }
                if (onLoad) onLoad(img);
            }, onProgress, onError);
        };
    }

    // GLB を読む前に中の画像を調べて、最大サイズを決める。読み終えたら結果を表示する
    if (THREE.GLTFLoader) {
        const origParse = THREE.GLTFLoader.prototype.parse;
        THREE.GLTFLoader.prototype.parse = function (data, path, onLoad, onError) {
            const cap = _texChooseCap(_texScanGlb(data));
            const ctx = { cap, stats: _texNewStats(cap) };
            texGuard.stats = ctx.stats;
            if (this.manager) this.manager.__texCtx = ctx;
            return origParse.call(this, data, path, (gltf) => {
                if (onLoad) onLoad(gltf);
                _texReport(ctx.stats);
            }, onError);
        };
    }
})();

function _texNewStats(cap) { return { reduced: 0, maxFrom: 0, cap, failed: 0, retried: 0 }; }
function _texReport(st) {
    if (!st) return;
    const el = document.getElementById('import-status');
    const notes = [];
    if (st.reduced) notes.push(`テクスチャ${st.reduced}枚を ${st.maxFrom}px → ${st.cap}px に縮小`);
    if (st.failed) notes.push(`${st.failed}枚は読み込めず灰色で代用`);
    if (el && notes.length) el.innerText += '（' + notes.join('・') + '）';
    if (notes.length) console.info('[TextureGuard]', notes.join(' / '), st);
}

function syncTextureMaxSizeUI() {
    const el = document.getElementById('tex-max-size');
    if (el) el.value = texGuard.setting;
}
window.addEventListener('load', syncTextureMaxSizeUI);

// ════════════════════════════════════════════════════════════
//  テクスチャを読み込み直す（⚡ 軽量化タブのボタン）
// ════════════════════════════════════════════════════════════
// メモリが足りないときなどに一部のテクスチャが真っ黒のまま残ることがある。保存してあるモデル
//（27-model-store.js の IndexedDB、同梱モデルはサーバー）から画像だけをもう一度展開して貼り直し、
// ほかのテクスチャも GPU へ送り直す。モデル全体は読み込み直さないので、設定はそのまま。
let _texImgIndex = new WeakMap();      // 画像（ImageBitmap など）→ GLB の images の番号
function texRememberGltf(gltf, isBinary) {
    _texImgIndex = new WeakMap();
    const P = gltf && gltf.parser; if (!P || !P.associations || !isBinary) return;
    const json = P.json || {};
    P.associations.forEach((ref, obj) => {
        if (!obj || !obj.isTexture || !ref || ref.type !== 'textures') return;
        const T = (json.textures || [])[ref.index]; if (!T) return;
        let src = T.source;
        const ext = T.extensions || {};
        for (const k in ext) if (ext[k] && ext[k].source !== undefined) src = ext[k].source;   // WebP などの拡張
        if (src !== undefined && obj.image) _texImgIndex.set(obj.image, src);
    });
}
async function _texModelBuffer() {
    const ref = (typeof getCurrentModelRef === 'function') ? getCurrentModelRef() : null;
    if (!ref) return null;
    try {
        if (ref.embedded) { const r = await fetch(ref.name); return r.ok ? await r.arrayBuffer() : null; }
        if (!ref.id || typeof modelStoreGet !== 'function') return null;
        const rec = await modelStoreGet(ref.id);
        return rec ? await modelRecordBuffer(rec) : null;
    } catch (e) { return null; }
}
async function reloadModelTextures() {
    const el = document.getElementById('tex-reload-status');
    const say = (t) => { if (el) el.textContent = t; };
    if (typeof importedModelGroup === 'undefined' || !importedModelGroup) { say('モデルが読み込まれていません'); return; }
    // モデルの中のテクスチャを集める（同じ画像を使うものはまとめる）
    const byImage = new Map();
    importedModelGroup.traverse(o => {
        const mats = !o.material ? [] : Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) for (const k in m) {
            const t = m[k];
            if (t && t.isTexture && t.image) { if (!byImage.has(t.image)) byImage.set(t.image, new Set()); byImage.get(t.image).add(t); }
        }
    });
    if (!byImage.size) { say('このモデルにはテクスチャがありません'); return; }
    say(`読み込み直しています…（${byImage.size} 枚）`);
    const buf = await _texModelBuffer();
    let redone = 0, resent = 0, failed = 0;
    let json = null, binStart = 0;
    if (buf) {
        try {
            const dv = new DataView(buf);
            if (dv.getUint32(0, true) === 0x46546C67) {
                const jl = dv.getUint32(12, true);
                json = JSON.parse(new TextDecoder('utf-8').decode(new Uint8Array(buf, 20, jl)));
                binStart = 20 + jl + 8;
            }
        } catch (e) { json = null; }
    }
    const cap = json ? _texChooseCap(_texScanGlb(buf)) : _texLimits().edge;
    const ctx = { cap, stats: _texNewStats(cap) };
    let n = 0;
    for (const [img, texs] of byImage) {
        n++; if (n % 4 === 0) say(`読み込み直しています…（${n}/${byImage.size}）`);
        const idx = _texImgIndex.get(img);
        const im = json && idx !== undefined ? (json.images || [])[idx] : null;
        if (im && im.bufferView !== undefined) {
            try {
                const bv = json.bufferViews[im.bufferView];
                const blob = new Blob([new Uint8Array(buf, binStart + (bv.byteOffset || 0), bv.byteLength)], { type: im.mimeType || 'image/png' });
                const url = URL.createObjectURL(blob);
                const t0 = texs.values().next().value;
                const opts = { imageOrientation: t0 && t0.flipY ? 'flipY' : 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none' };
                const bmp = await _texRun(() => _texLoadBitmap(url, opts, ctx));
                URL.revokeObjectURL(url);
                for (const t of texs) { t.image = bmp; t.needsUpdate = true; }
                _texImgIndex.set(bmp, idx);
                if (img && img.close && img !== bmp) { try { img.close(); } catch (e) { /* */ } }
                redone++;
                continue;
            } catch (e) { failed++; }
        }
        // 元の画像が分からないものは、今の画像を GPU へ送り直すだけ
        for (const t of texs) t.needsUpdate = true;
        resent++;
    }
    if (typeof bloomTargetsDirty === 'function') bloomTargetsDirty();
    const st = ctx.stats;
    say(`読み込み直しました：${redone} 枚を展開し直し${resent ? `・${resent} 枚を送り直し` : ''}${st.failed || failed ? `（${st.failed + failed} 枚は読み込めず）` : ''}`);
}
window.reloadModelTextures = reloadModelTextures;
window.texRememberGltf = texRememberGltf;
