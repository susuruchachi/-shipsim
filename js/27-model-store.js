// 27-model-store.js — 船のモデル本体を保存し、船の設定と結びつける
//
// ════════════════════════════════════════════════════════════════
//  なぜ必要か
// ════════════════════════════════════════════════════════════════
//  船の設定（13-save-load-config.js）は localStorage に保存しているが、
//  モデル本体（GLB）は数十MBあり localStorage には入らない。そのため今までは
//  「設定は残るが、モデルは毎回ファイルを選び直す」必要があった。
//
//  ブラウザの IndexedDB はバイナリを大容量で保存できるので、読み込んだ
//  モデルのファイルをそのままここへ保存し、船の設定には「どのモデルか」を
//  示す参照（modelRef）だけを持たせる。
//    ・アプリを開き直したとき  → 前回のモデルを自動で読み込む
//    ・保存済みの船を読み込むとき → その船のモデルに切り替えてから設定を適用
//
// ════════════════════════════════════════════════════════════════
//  モデルの識別
// ════════════════════════════════════════════════════════════════
//  ファイルの中身の SHA-256 をIDにする。同じモデルを複数の船で使っても
//  1回しか保存されず、ファイル名を変えても同じモデルとして扱える。
//  どの船からも参照されなくなったモデルは自動で削除する（gcModelStore）。

const MODEL_DB_NAME = 'susuru_shipsim_models';
const MODEL_DB_VERSION = 1;
const MODEL_DB_STORE = 'models';

// いま表示しているモデルの出どころ { id, name, type, size }（無ければ null）
window.currentModelSource = null;
let _currentModelData = null;     // （使っていない。重いモデルの中身をメモリに持ち続けないよう、常に null）
// 読み込み途中のモデルの参照。読み込み中にページが閉じられて自動保存が
// 走っても、「モデルなし」で上書きされて次回モデルが消えないようにする。
let _pendingModelRef = null;
let _modelDbPromise = null;

function _openModelDb() {
    if (_modelDbPromise) return _modelDbPromise;
    _modelDbPromise = new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return; }
        const req = indexedDB.open(MODEL_DB_NAME, MODEL_DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(MODEL_DB_STORE)) {
                db.createObjectStore(MODEL_DB_STORE, { keyPath: 'id' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    }).catch((e) => { _modelDbPromise = null; throw e; });
    return _modelDbPromise;
}

function _modelDbTx(mode, fn) {
    return _openModelDb().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(MODEL_DB_STORE, mode);
        const store = tx.objectStore(MODEL_DB_STORE);
        let result;
        const req = fn(store);
        if (req) req.onsuccess = () => { result = req.result; };
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    }));
}

function modelStoreGet(id)    { return _modelDbTx('readonly',  s => s.get(id)); }
function modelStorePut(rec)   { return _modelDbTx('readwrite', s => s.put(rec)); }
function modelStoreDelete(id) { return _modelDbTx('readwrite', s => s.delete(id)); }
function modelStoreKeys()     { return _modelDbTx('readonly',  s => s.getAllKeys()); }

// モデル本体は Blob で保存する。Blob なら IndexedDB がファイルとして持つので、
// 取り出しても中身がメモリに載らない（ZIP書き出しで何個も扱っても軽い）。
// Blob を保存できない環境では、以前どおり ArrayBuffer で保存する。
async function modelStorePutData(rec, data) {
    const blob = data instanceof Blob ? data : new Blob([data]);
    try {
        await modelStorePut(Object.assign({}, rec, { data: blob }));
    } catch (e) {
        await modelStorePut(Object.assign({}, rec, { data: data instanceof Blob ? await data.arrayBuffer() : data }));
    }
}
// 保存したモデルの中身を ArrayBuffer で（Blob・ArrayBuffer のどちらで保存されていても）。
// 中身が壊れていて直せなければ null（読み込まずに「モデルが無い」扱いにする）
async function modelRecordBuffer(rec) {
    if (!rec || !rec.data) return null;
    if (_modelRecordSuspect(rec)) {
        rec = await modelRecordRepair(rec);
        if (!rec) return null;
    }
    const buf = (rec.data instanceof Blob) ? await rec.data.arrayBuffer() : rec.data;
    if (!_modelBufLooksRight(rec, buf)) return null;
    return buf;
}

// ── 壊れたモデルの記録を直す ───────────────────────────────────────
// iPad・iPhone（どのブラウザも中身は Safari と同じ WebKit）では、ZIP のファイルから切り出した Blob（file.slice）を
// そのまま IndexedDB に入れると、切り出した所ではなく ZIP のファイル全体が保存されることがある。
// 以前の「ZIPから取り込み」（28-ship-archive.js）はそうして保存していたので、取り込んだモデルがどれも
// ZIP 全体（例：25隻で 600MB）になり、ZIP の書き出しが「モデルの数 × ZIP 全体」（15GB）に膨らみ、
// 船を読み込むと ZIP 全体をモデルとして読もうとして落ちていた。
// 保存した時の大きさ（rec.size）と中身の大きさが違えば、中からそのモデルを取り出し直して（中身の ID で確かめる）
// 保存し直す。
function _modelRecordSuspect(rec) {
    return !!(rec && rec.data instanceof Blob && Number.isFinite(rec.size) && rec.size > 0 && rec.data.size !== rec.size);
}
// GLB なら先頭が 'glTF'（違うものをモデルとして読むと、全体を文字として読もうとしてメモリが溢れる）
function _modelBufLooksRight(rec, buf) {
    if (!buf || !buf.byteLength) return false;
    if (rec.type === 'glb') return buf.byteLength >= 12 && new DataView(buf).getUint32(0, true) === 0x46546C67;
    return true;
}
async function modelRecordRepair(rec) {
    let fixed = null;
    try {
        const head = new Uint8Array(await rec.data.slice(0, 4).arrayBuffer());
        if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04 && typeof readZip === 'function') {
            // ZIP 全体が入っている：同じ大きさで、中身の ID が同じモデルを探す
            const entries = await readZip(rec.data);
            for (const [name, ent] of entries) {
                if (ent.size !== rec.size || !/^models\//.test(name)) continue;
                const buf = await (await ent.blob()).arrayBuffer();
                if (await computeModelId(buf) === rec.id) { fixed = buf; break; }
            }
        } else {
            // 中身は合っていて、大きさだけが違って見える場合
            const buf = await rec.data.slice(0, rec.size).arrayBuffer();
            if (await computeModelId(buf) === rec.id) fixed = buf;
        }
    } catch (e) { fixed = null; }
    if (!fixed) { console.warn('[ModelStore] モデルの記録が壊れていて直せません:', rec.name); return null; }
    // ArrayBuffer から作った Blob（ZIP のファイルとつながっていない）で保存し直す
    const blob = new Blob([fixed], { type: 'application/octet-stream' });
    const out = Object.assign({}, rec, { data: blob, size: fixed.byteLength });
    try { await modelStorePutData(Object.assign({}, rec, { size: fixed.byteLength }), blob); console.info('[ModelStore] モデルの記録を直しました:', rec.name); }
    catch (e) { console.warn('[ModelStore] 直したモデルを保存できませんでした:', e); }
    return out;
}
// 保存してあるモデルを全部調べて、壊れていれば直す（起動してしばらくしてから：gcModelStore）
async function repairModelStore() {
    const keys = await modelStoreKeys();
    let n = 0;
    for (const k of keys || []) {
        let rec = null;
        try { rec = await modelStoreGet(k); } catch (e) { rec = null; }
        if (_modelRecordSuspect(rec) && await modelRecordRepair(rec)) n++;
        rec = null;
    }
    return n;
}

// 中身からIDを作る（SHA-256の先頭16バイト）。crypto.subtle が使えない環境
// （http:// で開いた場合など）では、サイズと中身の一部から作る簡易ハッシュで代用する。
async function computeModelId(buffer) {
    try {
        if (window.crypto && crypto.subtle) {
            const h = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
            return Array.from(h.slice(0, 16), b => b.toString(16).padStart(2, '0')).join('');
        }
    } catch (e) { /* 下の簡易ハッシュへ */ }
    const u8 = new Uint8Array(buffer);
    let h = 0x811c9dc5;
    const step = Math.max(1, Math.floor(u8.length / 65536));
    for (let i = 0; i < u8.length; i += step) { h ^= u8[i]; h = Math.imul(h, 0x01000193) >>> 0; }
    return 'f' + u8.length.toString(16) + '_' + h.toString(16);
}

function modelTypeFromName(name) {
    const ext = String(name || '').split('.').pop().toLowerCase();
    return (ext === 'glb' || ext === 'gltf' || ext === 'obj') ? ext : null;
}

function formatModelSize(bytes) {
    if (!Number.isFinite(bytes)) return '';
    return bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(bytes / 1024)) + 'KB';
}

// 保存用の参照（船の設定に入れる）
function getCurrentModelRef() {
    if (_pendingModelRef) return Object.assign({}, _pendingModelRef);
    const s = window.currentModelSource;
    if (!s) return null;
    if (s.embedded) return { embedded: true, name: s.name, type: s.type, size: s.size };
    return s.id ? { id: s.id, name: s.name, type: s.type, size: s.size } : null;
}
function getCurrentModelData() { return _currentModelData; }

// モデルを読み込んだら呼ぶ。「いまのモデル」として覚え、IndexedDB に保存する。
// 保存に失敗しても（容量不足・プライベートモード等）表示には影響させない。
async function rememberModelSource(name, type, buffer) {
    if (!buffer || !type) { window.currentModelSource = null; _currentModelData = null; return null; }
    const id = await computeModelId(buffer);
    window.currentModelSource = { id, name, type, size: buffer.byteLength };
    try {
        const existing = await modelStoreGet(id);
        if (!existing) {
            await modelStorePutData({ id, name, type, size: buffer.byteLength, savedAt: Date.now() }, buffer);
        }
        // 大きなデータを置くので、ブラウザに勝手に消されないよう永続化を頼んでおく
        if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
        window.currentModelSource.stored = true;
    } catch (e) {
        console.warn('[ModelStore] モデルを保存できませんでした:', e);
        window.currentModelSource.stored = false;
    }
    renderShipSaveListSafe();
    return window.currentModelSource;
}

function renderShipSaveListSafe() {
    if (typeof renderShipSaveList === 'function') renderShipSaveList();
}

// 読み込み処理が終わり、船体スキャン（setCustomModel が100ms後に行う）まで
// 済んだところで解決する。設定の適用（排水量からの質量計算など）は
// 船体スキャンの結果を使うので、これを待ってから行う。
function _waitModelSettled() {
    return new Promise(res => setTimeout(res, 250));
}

// バイト列からモデルを読み込んで表示する（GLB/glTF/OBJ）。
async function loadModelFromBuffer(name, type, buffer) {
    if (type === 'glb' || type === 'gltf') {
        await loadGltfBuffer(buffer, name);
    } else if (type === 'obj') {
        modelOffset.ry = -90.0; syncModelOffsetUI();
        loadOBJ(new TextDecoder('utf-8').decode(buffer), name);
        window.lastLoadedModelName = name;
    } else {
        throw new Error('unsupported model type: ' + type);
    }
    window.currentModelSource = { id: null, name, type, size: buffer.byteLength };
    await _waitModelSettled();
}

// 保存してあるモデルを参照から読み込む。見つからなければ false。
async function loadModelByRef(ref) {
    if (!ref) return false;
    _pendingModelRef = ref;
    try {
        return await _loadModelByRefInner(ref);
    } finally {
        _pendingModelRef = null;
    }
}
async function _loadModelByRefInner(ref) {
    if (ref.embedded) return _loadEmbeddedModel(ref);
    if (!ref.id) return false;
    let rec = null;
    try { rec = await modelStoreGet(ref.id); } catch (e) { rec = null; }
    if (!rec || !rec.data) return false;
    const statusText = $('import-status');
    if (statusText) statusText.innerText = 'Loading: ' + rec.name + '...';
    const buf = await modelRecordBuffer(rec);
    if (!buf) { if (statusText) statusText.innerText = 'モデルの保存が壊れています: ' + rec.name + '（モデルを選び直すか、ZIPから取り込み直してください）'; return false; }
    await loadModelFromBuffer(rec.name, rec.type, buf);
    window.currentModelSource = { id: rec.id, name: rec.name, type: rec.type, size: rec.size, stored: true };
    renderShipSaveListSafe();
    return true;
}

// 同梱モデル（アプリと一緒に置いてある ship_model.*）をサーバーから読み直す
async function _loadEmbeddedModel(ref) {
    try {
        const res = await fetch(ref.name);
        if (!res.ok) return false;
        const buf = await res.arrayBuffer();
        await loadModelFromBuffer(ref.name, ref.type, buf);
        window.currentModelSource = { id: null, name: ref.name, type: ref.type, size: buf.byteLength, embedded: true };
        renderShipSaveListSafe();
        return true;
    } catch (e) { return false; }
}

// 2つの参照が同じモデルを指しているか
function sameModelRef(a, b) {
    if (!a || !b) return false;
    if (a.embedded || b.embedded) return !!(a.embedded && b.embedded && a.name === b.name);
    return !!a.id && a.id === b.id;
}

// どの船（保存済みの船・自動保存・いま表示中）からも参照されていない
// モデルを削除する。
async function gcModelStore() {
    try {
        const keep = new Set();
        const all = (typeof loadAllShipSaves === 'function') ? loadAllShipSaves() : {};
        Object.values(all).forEach(c => { if (c && c.modelRef && c.modelRef.id) keep.add(c.modelRef.id); });
        try {
            const auto = JSON.parse(localStorage.getItem(SHIP_AUTOSAVE_KEY) || 'null');
            if (auto && auto.modelRef && auto.modelRef.id) keep.add(auto.modelRef.id);
        } catch (e) { /* ignore */ }
        if (window.currentModelSource && window.currentModelSource.id) keep.add(window.currentModelSource.id);
        if (_pendingModelRef && _pendingModelRef.id) keep.add(_pendingModelRef.id);
        const keys = await modelStoreKeys();
        for (const k of keys || []) if (!keep.has(k)) await modelStoreDelete(k);
        // 壊れた記録（iPad で ZIP 全体が入ってしまったもの：modelRecordRepair）を直して、場所を空ける
        await repairModelStore();
    } catch (e) { /* IndexedDB が使えない環境では何もしない */ }
}

// 起動時：前回（自動保存）のモデルが保存されていれば、それを読み込む。
// 読み込めたら true。その後で自動保存の設定をもう一度適用する
// （GLBの読み込み処理はモデルの向きなどを初期値に戻すため）。
async function restoreAutosavedModel() {
    let cfg = null;
    try { cfg = JSON.parse(localStorage.getItem(SHIP_AUTOSAVE_KEY) || 'null'); } catch (e) { cfg = null; }
    if (!cfg || !cfg.modelRef) return false;
    try {
        const ok = await loadModelByRef(cfg.modelRef);
        if (!ok) return false;
        if (cfg.version >= 2 && typeof applyShipConfig === 'function') applyShipConfig(cfg);
        const statusText = $('import-status');
        if (statusText) statusText.innerText = 'Loaded: ' + cfg.modelRef.name + '（前回のモデル）';
        return true;
    } catch (e) {
        console.warn('[ModelStore] 前回のモデルを読み込めませんでした:', e);
        return false;
    }
}

// 起動してしばらくしたら、どの船からも参照されていないモデルを片付ける。
// （保存せずに別のモデルへ切り替えた場合、前のモデルはここで消える）
window.addEventListener('load', () => { setTimeout(() => { gcModelStore(); }, 15000); });
