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

// files: [{ name, data: Uint8Array }] → Blob（無圧縮ZIP）
// ファイル名は UTF-8（汎用フラグ bit11）で書くので、日本語の船名もそのまま使える。
function buildZipBlob(files) {
    const enc = new TextEncoder();
    const now = _dosDateTime(new Date());
    const parts = [];
    const central = [];
    let offset = 0;
    for (const f of files) {
        const nameBytes = enc.encode(f.name);
        const data = f.data;
        const crc = _crc32(data);
        const lh = new DataView(new ArrayBuffer(30));
        lh.setUint32(0, 0x04034b50, true);
        lh.setUint16(4, 20, true);          // 展開に必要なバージョン
        lh.setUint16(6, 0x0800, true);      // UTF-8 ファイル名
        lh.setUint16(8, 0, true);           // 無圧縮
        lh.setUint16(10, now.time, true);
        lh.setUint16(12, now.date, true);
        lh.setUint32(14, crc, true);
        lh.setUint32(18, data.length, true);
        lh.setUint32(22, data.length, true);
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
        ch.setUint32(20, data.length, true);
        ch.setUint32(24, data.length, true);
        ch.setUint16(28, nameBytes.length, true);
        ch.setUint32(42, offset, true);
        central.push(ch.buffer, nameBytes);

        offset += 30 + nameBytes.length + data.length;
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

// ZIP（ArrayBuffer）→ Map<ファイル名, Uint8Array>
async function readZip(buffer) {
    const u8 = new Uint8Array(buffer);
    const dv = new DataView(buffer);
    // 末尾から中央ディレクトリ終端を探す
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
        if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('ZIPファイルではありません');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const utf8 = new TextDecoder('utf-8');
    const out = new Map();
    for (let n = 0; n < count; n++) {
        if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('ZIPの目次が壊れています');
        const method = dv.getUint16(p + 10, true);
        const csize = dv.getUint32(p + 20, true);
        const nlen = dv.getUint16(p + 28, true);
        const xlen = dv.getUint16(p + 30, true);
        const clen = dv.getUint16(p + 32, true);
        const lho = dv.getUint32(p + 42, true);
        const name = utf8.decode(u8.subarray(p + 46, p + 46 + nlen));
        p += 46 + nlen + xlen + clen;
        if (name.endsWith('/')) continue;
        const lnlen = dv.getUint16(lho + 26, true);
        const lxlen = dv.getUint16(lho + 28, true);
        const start = lho + 30 + lnlen + lxlen;
        const raw = u8.subarray(start, start + csize);
        if (method === 0) {
            out.set(name, raw);
        } else if (method === 8 && typeof DecompressionStream !== 'undefined') {
            const ds = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
            out.set(name, new Uint8Array(await new Response(ds).arrayBuffer()));
        } else {
            throw new Error('このZIPの圧縮形式には対応していません: ' + name);
        }
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

// 保存済みの全船を、モデルごとZIPに書き出す
async function exportAllShipsZip() {
    const all = loadAllShipSaves();
    const names = Object.keys(all);
    if (names.length === 0) { _setArchiveStatus('保存された船がありません。先に「この船名で保存」してください。'); return; }
    _setArchiveStatus('書き出しの準備をしています…');

    const enc = new TextEncoder();
    const files = [];
    const manifest = { format: SHIP_ARCHIVE_FORMAT, version: 1, exportedAt: new Date().toISOString(), ships: [], models: [] };
    const modelFiles = new Map();   // id → ファイルパス
    const usedShipFiles = new Set();
    const missing = [];

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
        } else if (ref && ref.id) {
            if (!modelFiles.has(ref.id)) {
                let rec = null;
                try { rec = await modelStoreGet(ref.id); } catch (e) { rec = null; }
                if (rec && rec.data) {
                    const path = 'models/' + ref.id + '/' + _archiveSafeName(rec.name);
                    files.push({ name: path, data: new Uint8Array(rec.data) });
                    modelFiles.set(ref.id, path);
                    manifest.models.push({ id: ref.id, name: rec.name, type: rec.type, file: path, size: rec.size });
                } else {
                    modelFiles.set(ref.id, null);
                    missing.push(ref.name);
                }
            }
            entry.model = { id: ref.id, name: ref.name, file: modelFiles.get(ref.id) };
        }
        manifest.ships.push(entry);
    }
    files.unshift({ name: 'manifest.json', data: enc.encode(JSON.stringify(manifest, null, 2)) });

    _setArchiveStatus('ZIPを作成しています…');
    const blob = buildZipBlob(files);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `susuru_ships_${new Date().toISOString().slice(0, 10)}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 60000);

    let msg = `${names.length}隻・モデル${manifest.models.length}個を書き出しました（${formatModelSize(blob.size)}）: ${a.download}`;
    if (missing.length) msg += ` ※モデルが保存されていない船があります: ${[...new Set(missing)].join(', ')}`;
    _setArchiveStatus(msg);
}

// ZIPから船（設定＋モデル）を取り込む。同じ船名の保存は上書きする。
async function importShipsZip(event) {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    _setArchiveStatus('読み込んでいます…');
    try {
        const entries = await readZip(await file.arrayBuffer());
        const dec = new TextDecoder('utf-8');
        const mf = entries.get('manifest.json');
        if (!mf) throw new Error('manifest.json が見つかりません（このアプリで書き出したZIPではありません）');
        const manifest = JSON.parse(dec.decode(mf));
        if (manifest.format !== SHIP_ARCHIVE_FORMAT) throw new Error('このアプリで書き出したZIPではありません');

        // モデルを先に保存する（IDは中身から計算し直す＝壊れたファイルを取り込まない）
        let modelCount = 0;
        const idMap = new Map();
        for (const m of manifest.models || []) {
            const bytes = entries.get(m.file);
            if (!bytes) continue;
            const buf = bytes.slice().buffer;
            const id = await computeModelId(buf);
            await modelStorePut({ id, name: m.name, type: m.type || modelTypeFromName(m.name), size: buf.byteLength, data: buf, savedAt: Date.now() });
            idMap.set(m.id, id);
            modelCount++;
        }

        const all = loadAllShipSaves();
        let shipCount = 0;
        for (const s of manifest.ships || []) {
            const bytes = entries.get(s.file);
            if (!bytes) continue;
            const cfg = JSON.parse(dec.decode(bytes));
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
