// 28-ship-archive.js — 保存済みの船（設定＋モデル）をZIPで一括書き出し／読み込み
//
// 書き出すZIPの中身:
//   manifest.json            … 一覧（船名・設定ファイル・モデルファイルの対応）
//   ships/<船名>.json        … 各船の設定（「ファイルに保存」の .json と同じ形式）
//   models/<ID>/<ファイル名> … モデル本体（複数の船で同じモデルなら1個だけ）
// 設定の .json は単体でも「ファイルから読み込み」でそのまま使える。
//
// ZIPは外部ライブラリを使わず自前で組み立てる（オフライン＝ホーム画面から
// 起動した状態でも動くように）。モデル（GLB）は中のテクスチャが既に圧縮
// されていて再圧縮してもほとんど縮まないので、無圧縮（store）で格納する。
// 読み込みは無圧縮に加えて、ブラウザに DecompressionStream があれば
// 通常の圧縮（deflate）のZIPも読める。

const SHIP_ARCHIVE_FORMAT = 'susuru-shipsim-archive';

// ── CRC32 ─────────────────────────────────────────────────────────
let _crcTable = null;
function _crc32(u8) {
    if (!_crcTable) {
        _crcTable = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            _crcTable[n] = c >>> 0;
        }
    }
    let c = 0xFFFFFFFF;
    for (let i = 0; i < u8.length; i++) c = _crcTable[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

function _dosDateTime(d) {
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time, date };
}

// CRC32 を少しずつ計算する（大きなモデルでも画面が固まらないように）
function _crc32Update(c, u8) {
    if (!_crcTable) _crc32(new Uint8Array(0));
    for (let i = 0; i < u8.length; i++) c = _crcTable[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return c;
}
async function _crc32Blob(blob, onProgress) {
    const CH = 4 * 1024 * 1024;
    let c = 0xFFFFFFFF;
    for (let o = 0; o < blob.size; o += CH) {
        c = _crc32Update(c, new Uint8Array(await blob.slice(o, o + CH).arrayBuffer()));
        if (onProgress) onProgress(Math.min(1, (o + CH) / blob.size));
        await new Promise(r => setTimeout(r, 0));
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
}
// モデルの CRC は中身（＝モデルのID）が同じなら変わらないので、覚えておいて次から計算しない
function _crcCacheGet(id) {
    try { const m = JSON.parse(localStorage.getItem('susuru_model_crc') || '{}'); return Number.isFinite(m[id]) ? m[id] : null; } catch (e) { return null; }
}
function _crcCacheSet(id, crc) {
    try {
        const m = JSON.parse(localStorage.getItem('susuru_model_crc') || '{}');
        m[id] = crc;
        const keys = Object.keys(m);
        if (keys.length > 64) delete m[keys[0]];
        localStorage.setItem('susuru_model_crc', JSON.stringify(m));
    } catch (e) { /* ignore */ }
}

// files: [{ name, data: Uint8Array | Blob, crc? }] → Blob（無圧縮ZIP）
// ファイル名は UTF-8（汎用フラグ bit11）で書くので、日本語の船名もそのまま使える。
// data が Blob のときは中身を読み込まずにつなぐだけなので、大きなモデルでもメモリを食わない
// （crc は先に計算して渡す）。
function buildZipBlob(files) {
    const enc = new TextEncoder();
    const now = _dosDateTime(new Date());
    const parts = [];
    const central = [];
    let offset = 0;
    for (const f of files) {
        const nameBytes = enc.encode(f.name);
        const data = f.data;
        const size = (data instanceof Blob) ? data.size : data.length;
        const crc = (f.crc !== undefined && f.crc !== null) ? f.crc : _crc32(data);
        const lh = new DataView(new ArrayBuffer(30));
        lh.setUint32(0, 0x04034b50, true);
        lh.setUint16(4, 20, true);          // 展開に必要なバージョン
        lh.setUint16(6, 0x0800, true);      // UTF-8 ファイル名
        lh.setUint16(8, 0, true);           // 無圧縮
        lh.setUint16(10, now.time, true);
        lh.setUint16(12, now.date, true);
        lh.setUint32(14, crc, true);
        lh.setUint32(18, size, true);
        lh.setUint32(22, size, true);
        lh.setUint16(26, nameBytes.length, true);
        lh.setUint16(28, 0, true);
        parts.push(lh.buffer, nameBytes, data);

        const ch = new DataView(new ArrayBuffer(46));
        ch.setUint32(0, 0x02014b50, true);
        ch.setUint16(4, 20, true);
        ch.setUint16(6, 20, true);
        ch.setUint16(8, 0x0800, true);
        ch.setUint16(10, 0, true);
        ch.setUint16(12, now.time, true);
        ch.setUint16(14, now.date, true);
        ch.setUint32(16, crc, true);
        ch.setUint32(20, size, true);
        ch.setUint32(24, size, true);
        ch.setUint16(28, nameBytes.length, true);
        ch.setUint32(42, offset, true);
        central.push(ch.buffer, nameBytes);

        offset += 30 + nameBytes.length + size;
    }
    let centralSize = 0;
    central.forEach(p => { centralSize += p.byteLength; });
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

// ZIP（File / Blob / ArrayBuffer）→ Map<ファイル名, { size, blob(), bytes() }>
// 目次だけを先に読み、中身は必要になったときに1個ずつ読む（大きなZIPでもメモリを食わない）。
async function readZip(src) {
    const file = (src instanceof Blob) ? src : new Blob([src]);
    const tailLen = Math.min(file.size, 65557);
    const tail = new Uint8Array(await file.slice(file.size - tailLen).arrayBuffer());
    const tdv = new DataView(tail.buffer);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
        if (tdv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('ZIPファイルではありません');
    const count = tdv.getUint16(eocd + 10, true);
    const cdSize = tdv.getUint32(eocd + 12, true);
    const cdOff = tdv.getUint32(eocd + 16, true);
    const cd = new Uint8Array(await file.slice(cdOff, cdOff + cdSize).arrayBuffer());
    const dv = new DataView(cd.buffer);
    const utf8 = new TextDecoder('utf-8');
    const out = new Map();
    let p = 0;
    for (let n = 0; n < count; n++) {
        if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('ZIPの目次が壊れています');
        const method = dv.getUint16(p + 10, true);
        const csize = dv.getUint32(p + 20, true);
        const usize = dv.getUint32(p + 24, true);
        const nlen = dv.getUint16(p + 28, true);
        const xlen = dv.getUint16(p + 30, true);
        const clen = dv.getUint16(p + 32, true);
        const lho = dv.getUint32(p + 42, true);
        const name = utf8.decode(cd.subarray(p + 46, p + 46 + nlen));
        p += 46 + nlen + xlen + clen;
        if (name.endsWith('/')) continue;
        if (method !== 0 && !(method === 8 && typeof DecompressionStream !== 'undefined')) {
            throw new Error('このZIPの圧縮形式には対応していません: ' + name);
        }
        const blob = async () => {
            const lh = new DataView(await file.slice(lho, lho + 30).arrayBuffer());
            const start = lho + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
            const raw = file.slice(start, start + csize);
            if (method === 0) return raw;
            const ds = raw.stream().pipeThrough(new DecompressionStream('deflate-raw'));
            return await new Response(ds).blob();
        };
        out.set(name, { size: usize, blob, bytes: async () => new Uint8Array(await (await blob()).arrayBuffer()) });
    }
    return out;
}

function _archiveSafeName(s) {
    return String(s || 'ship').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 80) || 'ship';
}

function _setArchiveStatus(text) {
    const el = $('ship-archive-status');
    if (el) el.textContent = text;
}

// ZIPに入れない船（一覧のチェックを外した船）。このページを開いている間だけ覚える
const shipZipExcluded = new Set();
function setShipZipPick(name, on) {
    if (on) shipZipExcluded.delete(name); else shipZipExcluded.add(name);
}

// 保存済みの船（チェックした船）を、モデルごとZIPに書き出す
// モデルは IndexedDB から1個ずつ取り出し、中身をメモリに載せずにZIPへつなぐ。
async function exportAllShipsZip() {
    const all = loadAllShipSaves();
    const names = Object.keys(all).filter(n => !shipZipExcluded.has(n));
    if (Object.keys(all).length === 0) { _setArchiveStatus('保存された船がありません。先に「この船名で保存」してください。'); return; }
    if (names.length === 0) { _setArchiveStatus('ZIPに入れる船が選ばれていません（一覧のチェック）。'); return; }
    const withModels = !($('ship-zip-models') && !$('ship-zip-models').checked);
    const btn = $('ship-zip-export-btn');
    if (btn) btn.disabled = true;
    try {
        _setArchiveStatus('書き出しの準備をしています…');
        const enc = new TextEncoder();
        const files = [];
        const manifest = { format: SHIP_ARCHIVE_FORMAT, version: 1, exportedAt: new Date().toISOString(), ships: [], models: [] };
        const modelFiles = new Map();   // id → ファイルパス
        const usedShipFiles = new Set();
        const missing = [];
        const modelIds = [...new Set(names.map(n => all[n] && all[n].modelRef).filter(r => r && r.id && !r.embedded).map(r => r.id))];
        let modelNo = 0;

        for (const name of names) {
            const cfg = Object.assign({}, all[name], { shipName: name });
            let shipFile = 'ships/' + _archiveSafeName(name) + '.json';
            for (let k = 2; usedShipFiles.has(shipFile); k++) shipFile = 'ships/' + _archiveSafeName(name) + '_' + k + '.json';
            usedShipFiles.add(shipFile);
            files.push({ name: shipFile, data: enc.encode(JSON.stringify(cfg, null, 2)) });

            const ref = cfg.modelRef;
            const entry = { name, file: shipFile, model: null };
            if (ref && ref.embedded) {
                entry.model = { embedded: true, name: ref.name };
            } else if (ref && ref.id && withModels) {
                if (!modelFiles.has(ref.id)) {
                    modelNo++;
                    let rec = null;
                    try { rec = await modelStoreGet(ref.id); } catch (e) { rec = null; }
                    if (rec && rec.data) {
                        const label = `モデル ${modelNo}/${modelIds.length}（${rec.name}・${formatModelSize(rec.size)}）`;
                        _setArchiveStatus(label + ' を準備しています…');
                        let blob = rec.data;
                        if (!(blob instanceof Blob)) {
                            // 以前の保存形式（ArrayBuffer）は、この機会に Blob で保存し直す
                            blob = new Blob([rec.data]);
                            rec.data = null;
                            try {
                                await modelStorePutData(Object.assign({}, rec, { data: undefined }), blob);
                                const again = await modelStoreGet(ref.id);
                                if (again && again.data instanceof Blob) blob = again.data;
                            } catch (e) { /* そのまま使う */ }
                        }
                        let crc = _crcCacheGet(ref.id);
                        if (crc === null) {
                            crc = await _crc32Blob(blob, (f) => _setArchiveStatus(`${label} を確認しています… ${Math.round(f * 100)}%`));
                            _crcCacheSet(ref.id, crc);
                        }
                        const path = 'models/' + ref.id + '/' + _archiveSafeName(rec.name);
                        files.push({ name: path, data: blob, crc });
                        modelFiles.set(ref.id, path);
                        manifest.models.push({ id: ref.id, name: rec.name, type: rec.type, file: path, size: blob.size });
                    } else {
                        modelFiles.set(ref.id, null);
                        missing.push(ref.name);
                    }
                    rec = null;
                }
                entry.model = { id: ref.id, name: ref.name, file: modelFiles.get(ref.id) };
            } else if (ref && ref.id) {
                entry.model = { id: ref.id, name: ref.name, file: null };
            }
            manifest.ships.push(entry);
        }
        files.unshift({ name: 'manifest.json', data: enc.encode(JSON.stringify(manifest, null, 2)) });

        _setArchiveStatus('ZIPを作成しています…');
        const blob = buildZipBlob(files);
        const fname = `susuru_ships_${new Date().toISOString().slice(0, 10)}.zip`;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fname;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 120000);

        let msg = `${names.length}隻・モデル${manifest.models.length}個を書き出しました（${formatModelSize(blob.size)}）: ${fname}`;
        if (!withModels) msg = `${names.length}隻の設定だけを書き出しました（モデルなし・${formatModelSize(blob.size)}）: ${fname}`;
        if (missing.length) msg += ` ※モデルが保存されていない船があります: ${[...new Set(missing)].join(', ')}`;
        _setArchiveStatus(msg);
    } catch (e) {
        _setArchiveStatus('エラー: ' + (e && e.message ? e.message : 'ZIPを作れませんでした'));
    } finally {
        if (btn) btn.disabled = false;
    }
}

// ZIPから船（設定＋モデル）を取り込む。同じ船名の保存は上書きする。
// モデルは1個ずつ読み込んで保存する（ZIP全体をメモリに載せない）。
async function importShipsZip(event) {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    _setArchiveStatus('読み込んでいます…');
    try {
        const entries = await readZip(file);
        const dec = new TextDecoder('utf-8');
        const mf = entries.get('manifest.json');
        if (!mf) throw new Error('manifest.json が見つかりません（このアプリで書き出したZIPではありません）');
        const manifest = JSON.parse(dec.decode(await mf.bytes()));
        if (manifest.format !== SHIP_ARCHIVE_FORMAT) throw new Error('このアプリで書き出したZIPではありません');

        // モデルを先に保存する（IDは中身から計算し直す＝壊れたファイルを取り込まない）
        let modelCount = 0;
        const idMap = new Map();
        const models = manifest.models || [];
        for (let i = 0; i < models.length; i++) {
            const m = models[i];
            const ent = entries.get(m.file);
            if (!ent) continue;
            _setArchiveStatus(`モデル ${i + 1}/${models.length}（${m.name}）を取り込んでいます…`);
            const blob = await ent.blob();
            let id;
            {
                const buf = await blob.arrayBuffer();
                id = await computeModelId(buf);
            }
            await modelStorePutData({ id, name: m.name, type: m.type || modelTypeFromName(m.name), size: blob.size, savedAt: Date.now() }, blob);
            idMap.set(m.id, id);
            modelCount++;
        }

        const all = loadAllShipSaves();
        let shipCount = 0;
        for (const s of manifest.ships || []) {
            const ent = entries.get(s.file);
            if (!ent) continue;
            const cfg = JSON.parse(dec.decode(await ent.bytes()));
            if (cfg.modelRef && cfg.modelRef.id && idMap.has(cfg.modelRef.id)) {
                cfg.modelRef = Object.assign({}, cfg.modelRef, { id: idMap.get(cfg.modelRef.id) });
            }
            all[s.name || cfg.shipName || ('ship ' + (shipCount + 1))] = cfg;
            shipCount++;
        }
        saveAllShipSaves(all);
        renderShipSaveList();
        if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
        _setArchiveStatus(`${shipCount}隻・モデル${modelCount}個を取り込みました。「保存済みの船」から読み込めます。`);
    } catch (e) {
        _setArchiveStatus('エラー: ' + (e && e.message ? e.message : 'ZIPを読み込めませんでした'));
    }
}
