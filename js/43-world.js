// 43-world.js — 世界（球体の惑星）・港・世界地図・モード切替
//
// ════════════════════════════════════════════════════════════════
//  2つのモード
// ════════════════════════════════════════════════════════════════
//   ・ocean : 今まで通り、海だけの世界
//   ・world : 陸地や港のある惑星を航海する
//
// ════════════════════════════════════════════════════════════════
//  惑星
// ════════════════════════════════════════════════════════════════
//  表面積が地球の半分の球（半径 約4500km）。陸地の形は、決まった種（シード）から
//  作る3次元のノイズで決める。同じ種なら毎回同じ世界になる。
//    ・大陸：大きな波長のノイズを、別のノイズで少しゆがめて（ドメインワープ）作る。
//      陸地が全体の約3割になるよう、海面の高さを自動で決める
//    ・海岸線・島：細かい波長のノイズを重ねる。船のまわりでは 数十m の細かさまで
//      重ねるので、近づくほど入り江や岬・小島が現れる（地図は粗く、3Dは細かく）
//  高さ e（無次元）→ 陸は √e、海は √(-e) で標高・水深[m]にする。岸の近くは急に、
//  沖や内陸はゆるやかに変わる（大陸棚・海岸平野のように）。
//
//  座標：船の物理は平らな面（x＝東、z＝北、単位 m）の上で動く。world モードでは、
//  その原点が惑星のどこか（world.ref の緯度・経度）に接していると考え、
//    面の点 (x, z) → 球の点 = normalize(C + x/R·東 + z/R·北)   （C：原点の方向）
//  で惑星の上の位置に直す（原点のまわりの接平面への投影）。
//
// ════════════════════════════════════════════════════════════════
//  港
// ════════════════════════════════════════════════════════════════
//  海岸を探して、互いに離れた場所に港を置く。種類は
//    漁港（小）・港町・港湾都市（大）・貨物港・軍港
//  名前は音節を組み合わせて作る。港の正確な位置（海岸線）と、海の方の向きは、
//  細かい高さで調べ直して決める（44-world-terrain.js が岸壁や建物を建てる）。

let WORLD_R = 4504000;                // 惑星の半径[m]（作った世界：表面積が地球の半分。現実世界では地球の半径）
const WORLD_R_GEN = 4504000, WORLD_R_EARTH = 6371000;
const WORLD_SEED = 20260927;
const WORLD_LAND_FRACTION = 0.31;     // 陸地の割合
const WORLD_OCT_MAP = 9;              // 地図に使う細かさ（ノイズを重ねる数）
const WORLD_OCT_FULL = 20;            // 船のまわりの細かさ（約35mの起伏まで）

const PORT_TYPES = {
    fishing: { label: '漁港',     suffix: '漁港', color: '#7ee39a', size: 1, depth: 8, basin: 260, pier: 70, quay: 170 },
    town:    { label: '港町',     suffix: '港',   color: '#ffe38a', size: 2, depth: 12, basin: 380, pier: 10, quay: 320 },
    city:    { label: '港湾都市', suffix: '港',   color: '#ffb36b', size: 3, depth: 18, basin: 640, pier: 10, quay: 720 },
    cargo:   { label: '貨物港',   suffix: '貨物港', color: '#8cc6ff', size: 3, depth: 18, basin: 760, pier: 10, quay: 1050 },
    naval:   { label: '軍港',     suffix: '軍港', color: '#ff7a7a', size: 2, depth: 16, basin: 620, pier: 270, quay: 800 },
    // 客船ターミナル（現実世界の港の埠頭だけ。形は貨物港と同じ大きさ）
    passenger: { label: '客船ターミナル', suffix: '港', color: '#e0a8ff', size: 3, depth: 18, basin: 760, pier: 10, quay: 1050 },
};
window.PORT_TYPES = PORT_TYPES;

const world = {
    mode: 'ocean',                     // 'ocean' | 'world'
    kind: 'gen',                       // 'gen'：作った世界、'real'：現実世界（REAL_WORLDS のどれか：world.realKey）
    realKey: null,
    ref: { lat: 0, lon: 0 },           // 物理の原点が接している緯度・経度[度]
    ports: null,                       // 港の一覧（初めて要るときに作る）
    seaLevel: 0,                       // 海面の高さ（ノイズの値）
    ready: false,
};
window.world = world;

// ── 乱数（種から決まる）──
function _wRng(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ── 3次元シンプレックスノイズ（Gustavson の方式）──
const _wPerm = new Uint8Array(512), _wPermMod12 = new Uint8Array(512);
(function () {
    const r = _wRng(WORLD_SEED);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
    for (let i = 0; i < 512; i++) { _wPerm[i] = p[i & 255]; _wPermMod12[i] = _wPerm[i] % 12; }
})();
const _wGrad3 = new Float32Array([1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1, 0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1]);
function _wNoise3(xin, yin, zin) {
    const F3 = 1 / 3, G3 = 1 / 6;
    const s = (xin + yin + zin) * F3;
    const i = Math.floor(xin + s), j = Math.floor(yin + s), k = Math.floor(zin + s);
    const t = (i + j + k) * G3;
    const x0 = xin - (i - t), y0 = yin - (j - t), z0 = zin - (k - t);
    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
        if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
        else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
        else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else {
        if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
        else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
        else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    }
    const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;
    const ii = i & 255, jj = j & 255, kk = k & 255;
    let n = 0, tt, g;
    tt = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    if (tt > 0) { g = _wPermMod12[ii + _wPerm[jj + _wPerm[kk]]] * 3; tt *= tt; n += tt * tt * (_wGrad3[g] * x0 + _wGrad3[g + 1] * y0 + _wGrad3[g + 2] * z0); }
    tt = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (tt > 0) { g = _wPermMod12[ii + i1 + _wPerm[jj + j1 + _wPerm[kk + k1]]] * 3; tt *= tt; n += tt * tt * (_wGrad3[g] * x1 + _wGrad3[g + 1] * y1 + _wGrad3[g + 2] * z1); }
    tt = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (tt > 0) { g = _wPermMod12[ii + i2 + _wPerm[jj + j2 + _wPerm[kk + k2]]] * 3; tt *= tt; n += tt * tt * (_wGrad3[g] * x2 + _wGrad3[g + 1] * y2 + _wGrad3[g + 2] * z2); }
    tt = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (tt > 0) { g = _wPermMod12[ii + 1 + _wPerm[jj + 1 + _wPerm[kk + 1]]] * 3; tt *= tt; n += tt * tt * (_wGrad3[g] * x3 + _wGrad3[g + 1] * y3 + _wGrad3[g + 2] * z3); }
    return 32 * n;   // およそ -1〜1
}

// ════════════════════════════════════════════════════════════════
//  現実世界：実際の地形（ETOPO 2022、data/README.md）を読んで高さにする
// ════════════════════════════════════════════════════════════════
//  _RW：{ lat0, lat1, lon0, lon1, rows, cols, cell, h: Int16Array（上が北）} ／ 作った世界では null。
//  下の関数は、ワーカー（44-world-terrain.js・49-autopilot.js）にも文字列にして渡すので、
//  _RW・WORLD_R・_wNoise3 だけを使う。
const REAL_WORLDS = {
    britain: {
        name: 'ブリテン諸島・アイルランド', url: 'data/britain', center: { lat: 54.3, lon: -4.5 }, start: 'サウサンプトン港',
        // 作り込んだ港（data/harbors/<key>：10m おきの地形。OpenStreetMap の海岸線・ドック＋EMODnet の水深）
        harbors: ['southampton', 'liverpool', 'belfast', 'glasgow'],
        // 実在の港（おおよその位置。実際の海岸に合わせて数km以内で置き直す）
        ports: [
            // イングランド南岸
            // （5番目：航路が通る所。サウサンプトンは東の口：カルショット沖 → カウズ沖 → スピットヘッド → ナブ）
            ['サウサンプトン港', 'cargo', 50.895, -1.405, [[50.7830, -1.2450], [50.775, -1.180], [50.735, -1.050], [50.670, -0.950]], { at: [50.9034, -1.4252], bearing: 201, quay: 400, group: 'サウサンプトン港', berth: '西ドック（貨物）' }],
            // サウサンプトンのほかの埠頭（東ドック）：オーシャン・ドックは幅 135m ほどの細長いドックなので、
            // ドックの外で向きを合わせてからまっすぐ入り、中で横へ寄せる（dock：入口の真ん中と、入っていく向き）
            ['サウサンプトン港 オーシャン・ドック（43/44番）', 'passenger', 50.8915, -1.3985, [[50.7830, -1.2450], [50.775, -1.180], [50.735, -1.050], [50.670, -0.950]], { at: [50.89152, -1.39851], bearing: 285, quay: 480, dock: { entrance: [50.89025, -1.40008], inBearing: 15 }, group: 'サウサンプトン港', berth: 'オーシャン・ドック（43/44番）' }],
            ['サウサンプトン港 オーシャン・クルーズ・ターミナル（46番）', 'passenger', 50.8922, -1.4002, [[50.7830, -1.2450], [50.775, -1.180], [50.735, -1.050], [50.670, -0.950]], { at: [50.89218, -1.4002], bearing: 105, quay: 400, dock: { entrance: [50.89025, -1.40008], inBearing: 15 }, group: 'サウサンプトン港', berth: 'オーシャン・クルーズ・ターミナル（46番）' }],
            ['サウサンプトン港 QEIIターミナル（38/39番）', 'passenger', 50.8848, -1.3964, [[50.7830, -1.2450], [50.775, -1.180], [50.735, -1.050], [50.670, -0.950]], { at: [50.88481, -1.39643], bearing: 249, quay: 400, group: 'サウサンプトン港', berth: 'QEIIターミナル（38/39番）' }],
            ['サウサンプトン港 シティ・クルーズ・ターミナル（101番）', 'passenger', 50.8999, -1.4146, [[50.7830, -1.2450], [50.775, -1.180], [50.735, -1.050], [50.670, -0.950]], { at: [50.89992, -1.4146], bearing: 201, quay: 500, group: 'サウサンプトン港', berth: 'シティ・クルーズ・ターミナル（101番）' }],
            ['サウサンプトン港 メイフラワー・クルーズ・ターミナル（106番）', 'passenger', 50.9047, -1.4290, [[50.7830, -1.2450], [50.775, -1.180], [50.735, -1.050], [50.670, -0.950]], { at: [50.90466, -1.42897], bearing: 201, quay: 500, group: 'サウサンプトン港', berth: 'メイフラワー・クルーズ・ターミナル（106番）' }],
            ['ポーツマス軍港', 'naval', 50.800, -1.110], ['プリマス軍港', 'naval', 50.375, -4.180],
            ['プール港', 'town', 50.705, -1.990], ['ポートランド港', 'town', 50.570, -2.440], ['ファルマス港', 'town', 50.155, -5.055],
            ['ニューリン漁港', 'fishing', 50.102, -5.548], ['ブリクサム漁港', 'fishing', 50.398, -3.510], ['ドーヴァー港', 'city', 51.120, 1.330],
            // テムズ・東海岸
            ['ロンドン・ゲートウェイ貨物港', 'cargo', 51.505, 0.470], ['フェリクストウ貨物港', 'cargo', 51.955, 1.320], ['グレート・ヤーマス港', 'town', 52.600, 1.735],
            ['イミンガム貨物港', 'cargo', 53.630, -0.185], ['ハル港', 'city', 53.740, -0.290], ['ティーズポート貨物港', 'cargo', 54.605, -1.160],
            ['タイン港', 'city', 55.005, -1.440],
            // スコットランド
            ['ロサイス軍港', 'naval', 56.020, -3.440], ['リース港', 'city', 55.985, -3.175], ['アバディーン港', 'city', 57.143, -2.080],
            ['ピーターヘッド漁港', 'fishing', 57.500, -1.780], ['フレーザーバラ漁港', 'fishing', 57.695, -2.005], ['ラーウィック港', 'town', 60.155, -1.140],
            ['カークウォール港', 'town', 58.985, -2.960], ['ストーノウェイ港', 'town', 58.207, -6.385], ['ウラプール漁港', 'fishing', 57.895, -5.160],
            ['オーバン港', 'town', 56.415, -5.475], ['ファスレーン軍港', 'naval', 56.065, -4.820], ['グリーノック港', 'city', 55.950, -4.765, null, { at: [55.95596, -4.76121], bearing: 0, quay: 360 }],
            // クライド川を遡ったグラスゴー：キング・ジョージ5世ドック（幅 115m）。川幅が 250m ほどなので、ドックの前で回せる長さの船だけ
            ['グラスゴー港 キング・ジョージ5世ドック', 'cargo', 55.868, -4.3514, [[55.9284, -4.4996], [55.9568, -4.7598]], { at: [55.86806, -4.35142], bearing: 265, quay: 360, dock: { entrance: [55.87236, -4.35312], inBearing: 175, turnOut: 110 }, group: 'グラスゴー港', berth: 'キング・ジョージ5世ドック' }],
            // アイリッシュ海・ウェールズ・ブリストル海峡
            ['ベルファスト港', 'cargo', 54.620, -5.890, [[54.7170, -5.6050]], { at: [54.63449, -5.87459], bearing: 303, group: 'ベルファスト港', berth: 'コンテナ・ターミナル（貨物）' }],
            ['ベルファスト港 クルーズ・ターミナル', 'passenger', 54.6260, -5.8850, [[54.7170, -5.6050]], { at: [54.62604, -5.88505], bearing: 312, quay: 360, group: 'ベルファスト港', berth: 'クルーズ・ターミナル（スターモント埠頭）' }],
            // リヴァプール：ピア・ヘッド（浮き桟橋。昔の大西洋航路の客船）・クルーズ・ターミナル・シーフォースの川の埠頭（貨物）
            ['リヴァプール港', 'passenger', 53.450, -3.020, [[53.5325, -3.2210]], { at: [53.40454, -2.99848], bearing: 252, quay: 300, group: 'リヴァプール港', berth: 'ピア・ヘッド（フェリー桟橋・小さな船）' }],
            ['リヴァプール港 クルーズ・ターミナル', 'passenger', 53.4072, -2.9990, [[53.5325, -3.2210]], { at: [53.40740, -2.99905], bearing: 250, quay: 350, group: 'リヴァプール港', berth: 'クルーズ・ターミナル（プリンシズ・パレード）' }],
            ['リヴァプール港 シーフォース', 'cargo', 53.4600, -3.0345, [[53.5325, -3.2210]], { at: [53.46000, -3.03453], bearing: 231, quay: 500, group: 'リヴァプール港', berth: 'シーフォースの川の埠頭（貨物）' }], ['ホーリーヘッド港', 'town', 53.315, -4.625],
            ['ダグラス港', 'town', 54.148, -4.475], ['ミルフォード・ヘイヴン港', 'cargo', 51.705, -5.050], ['ブリストル港', 'cargo', 51.505, -2.715],
            ['カーディフ港', 'town', 51.460, -3.165], ['スウォンジー港', 'town', 51.615, -3.925],
            // アイルランド
            ['ダブリン港', 'city', 53.345, -6.200], ['コーク港', 'city', 51.835, -8.300], ['フォインズ貨物港', 'cargo', 52.612, -9.110],
            ['ゴールウェイ港', 'town', 53.268, -9.045], ['キリーベグス漁港', 'fishing', 54.633, -8.440], ['ロスレア港', 'town', 52.252, -6.335],
            ['ウォーターフォード港', 'town', 52.265, -7.010], ['キャッスルタウンベア漁港', 'fishing', 51.650, -9.905],
            // フランス・ベルギー・チャンネル諸島
            ['シェルブール軍港', 'naval', 49.650, -1.620], ['ル・アーヴル貨物港', 'cargo', 49.480, 0.110], ['カレー港', 'town', 50.965, 1.865],
            ['ダンケルク貨物港', 'cargo', 51.035, 2.300], ['ブレスト軍港', 'naval', 48.380, -4.495], ['サン・マロ港', 'town', 48.645, -2.025],
            ['ロスコフ港', 'town', 48.720, -3.965], ['セント・ピーター・ポート港', 'town', 49.455, -2.535], ['オーステンデ港', 'town', 51.235, 2.925],
        ],
    },
};
let _RW = null;
// 作り込んだ港の細かい地形（10m おき）：その緯度・経度の高さ[m]。範囲の外は NaN
function _rwDetailAt(d, lat, lon) {
    const fy = (d.lat1 - lat) / d.dLat, fx = (lon - d.lon0) / d.dLon;
    if (!(fx >= 0 && fy >= 0 && fx <= d.cols - 1 && fy <= d.rows - 1)) return NaN;
    const x0 = Math.min(d.cols - 2, Math.floor(fx)), y0 = Math.min(d.rows - 2, Math.floor(fy));
    const tx = fx - x0, ty = fy - y0, H = d.h, k = y0 * d.cols + x0;
    return ((H[k] * (1 - tx) + H[k + 1] * tx) * (1 - ty) + (H[k + d.cols] * (1 - tx) + H[k + d.cols + 1] * tx) * ty) * 0.1;
}
// 作り込んだ港の升目の種類（0 海・1 陸・2 ドックの水・3 桟橋・4 港の敷地）。範囲の外は -1
function _rwDetailKindAt(d, lat, lon) {
    const j = Math.round((d.lat1 - lat) / d.dLat), i = Math.round((lon - d.lon0) / d.dLon);
    if (i < 0 || j < 0 || i >= d.cols || j >= d.rows) return -1;
    return d.k[j * d.cols + i];
}
// その所が作り込んだ港の中なら、その港（と、縁からの升目の数）
function _rwDetailOf(lat, lon) {
    const D = _RW && _RW.hd;
    if (!D) return null;
    for (let i = 0; i < D.length; i++) {
        const d = D[i];
        if (lat > d.lat0 && lat < d.lat1 && lon > d.lon0 && lon < d.lon1) return d;
    }
    return null;
}
// その緯度・経度の高さ[m]（格子の 4 点から直線で補う）。範囲の外は低い陸（行き止まり）。
// 作り込んだ港の中はその細かい地形（縁の 250m で、粗い地形となめらかにつなぐ）
function _rwSample(lat, lon) {
    const R = _RW;
    const d = R.hd ? _rwDetailOf(lat, lon) : null;
    if (d) {
        const hd = _rwDetailAt(d, lat, lon);
        const e = Math.min((lat - d.lat0) / d.dLat, (d.lat1 - lat) / d.dLat, (lon - d.lon0) / d.dLon, (d.lon1 - lon) / d.dLon) * d.cell;
        if (e >= 250) return hd;
        const t = Math.max(0, e / 250);
        return hd * t + _rwCoarse(lat, lon) * (1 - t);
    }
    return _rwCoarse(lat, lon);
}
function _rwCoarse(lat, lon) {
    const R = _RW;
    const fy = (R.lat1 - lat) / R.cell, fx = (lon - R.lon0) / R.cell;
    if (!(fx >= 0 && fy >= 0 && fx <= R.cols - 1 && fy <= R.rows - 1)) return 60;
    const x0 = Math.min(R.cols - 2, Math.floor(fx)), y0 = Math.min(R.rows - 2, Math.floor(fy));
    const tx = fx - x0, ty = fy - y0, H = R.h, k = y0 * R.cols + x0;
    return (H[k] * (1 - tx) + H[k + 1] * tx) * (1 - ty) + (H[k + R.cols] * (1 - tx) + H[k + R.cols + 1] * tx) * ty;
}
function _rwInside(lat, lon) {
    const R = _RW;
    return !!R && lat >= R.lat0 && lat <= R.lat1 && lon >= R.lon0 && lon <= R.lon1;
}
// 球の上の点の高さ。oct が細かいとき（船のまわり）は、岸の近くに小さな起伏を足す
//（格子は 460m ごとなので、そのままでは海岸線がのっぺりする。ずれは数十 m まで）
function _rwHeight(ux, uy, uz, oct) {
    const lat = Math.asin(Math.max(-1, Math.min(1, uy))) * 57.29577951308232, lon = Math.atan2(uz, ux) * 57.29577951308232;
    let h = _rwSample(lat, lon);
    if (oct >= 12 && h > -20 && h < 20 && !(_RW.hd && _rwDetailOf(lat, lon))) {
        const n = 0.65 * _wNoise3(ux * 9000 + 1.7, uy * 9000 - 2.9, uz * 9000 + 4.1) + 0.35 * _wNoise3(ux * 30000 - 5.3, uy * 30000 + 0.7, uz * 30000 - 2.2);
        h += n * 3 * (1 - Math.abs(h) / 20);
    }
    return h;
}
// 高さ[m] → ノイズの値 e（worldHeightFromE の逆。陸・海の判定に e を使う所があるので）
function _rwEFromH(h) {
    if (h < 0) { const d = -h; return d <= 150 ? -0.05 * Math.pow(d / 150, 1 / 0.7) : -(0.05 + (d - 150) / 5000); }
    // 7000 e^1.5 + 60 √e ＝ h を √e について解く
    let s = Math.min(Math.cbrt(h / 7000), h / 60);
    for (let i = 0; i < 6; i++) s -= (7000 * s * s * s + 60 * s - h) / (21000 * s * s + 60);
    return s * s;
}
// 浅瀬の心配がない所か：まわり約 1km が、みな 15m より深い
function _rwShoalFree(ux, uy, uz) {
    const lat = Math.asin(Math.max(-1, Math.min(1, uy))) * 57.29577951308232, lon = Math.atan2(uz, ux) * 57.29577951308232;
    const R = _RW, dLat = 1000 / WORLD_R * 57.29577951308232, dLon = dLat / Math.max(0.1, Math.cos(lat / 57.29577951308232));
    for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) if (_rwSample(lat + j * dLat / 2, lon + i * dLon / 2) > -15) return false;
    return true;
}
// ワーカーに渡す：関数と、_RW・WORLD_R を受け取る仕組み（onmessage の最初で _rwHook(ev) を呼ぶ）
function worldWorkerSource() {
    return `
        let WORLD_R = ${WORLD_R};
        let _RW = null;
        const _rwHook = (ev) => { if (ev.data && ev.data.__rw) { _RW = ev.data.rw; WORLD_R = ev.data.R; return true; } return false; };
        ${_rwDetailAt.toString()}
        ${_rwDetailOf.toString()}
        ${_rwSample.toString()}
        ${_rwCoarse.toString()}
        ${_rwHeight.toString()}
        ${_rwEFromH.toString()}
        ${_rwShoalFree.toString()}
    `;
}
function worldWorkerSync(w) { if (w) w.postMessage({ __rw: true, rw: _RW, R: WORLD_R }); }
window.worldWorkerSource = worldWorkerSource;
window.worldWorkerSync = worldWorkerSync;

// ── 高さ（ノイズの値）。ux,uy,uz：球の上の点（長さ1）。oct：重ねる数 ──
// 大陸の形（最初の5段）を正規化した値から海面を引き、6段目以降の細かい起伏を足す。
function worldNoiseE(ux, uy, uz, oct) {
    if (_RW) return _rwEFromH(_rwHeight(ux, uy, uz, oct));
    // 大陸の形を自然にするためのゆがみ
    const W = 0.42, fw = 1.6;
    const px = ux + W * _wNoise3(ux * fw + 31.7, uy * fw, uz * fw);
    const py = uy + W * _wNoise3(ux * fw, uy * fw + 17.3, uz * fw);
    const pz = uz + W * _wNoise3(ux * fw, uy * fw, uz * fw + 5.9);
    let a = 1, f = 1.25, sum = 0, norm = 0;
    const nBase = Math.min(5, oct);
    for (let i = 0; i < nBase; i++) { sum += a * _wNoise3(px * f + i * 7.1, py * f, pz * f); norm += a; a *= 0.5; f *= 2.03; }
    let e = sum / norm - world.seaLevel;
    for (let i = nBase; i < oct; i++) {
        // 細かい起伏。少し強め（0.53倍ずつ）にして、海岸線を入り組ませる
        e += (a / norm) * _wNoise3(px * f + i * 7.1, py * f - i * 3.3, pz * f);
        a *= 0.53; f *= 2.03;
    }
    return e;
}
// 高さ[m]（陸は＋、海は−）
//  陸：海岸近くはなだらかな低地、内陸の高い所だけが山になる。
//  海：岸から少しのあいだは浅い大陸棚（〜150m）、その先で深くなる。
function worldHeightFromE(e) {
    if (e >= 0) return 7000 * Math.pow(e, 1.5) + 60 * Math.sqrt(e);
    const s = -e;
    return s < 0.05 ? -150 * Math.pow(s / 0.05, 0.7) : -Math.min(6000, 150 + 5000 * (s - 0.05));
}

// 浅瀬・岩礁：大陸棚（深さ130mまで）のところどころに「浅瀬の多い海域」（数十km）があり、
// その中に砂州や岩の連なり（2〜3km）と、ひとつひとつの岩（数百m）がある。
// 海面から頭を出す岩もあれば、数mの深さに隠れているものもある。
// 細かい所（oct 12 以上）だけで足す（世界全体の地図では見えない大きさなので）。
function worldShoal(ux, uy, uz, h, oct) {
    if (_RW || h >= 0 || h < -130 || oct < 12) return h;          // 現実世界は地形そのものに浅瀬がある
    const field = _wNoise3(ux * 140 + 11.3, uy * 140 - 4.1, uz * 140 + 7.7);
    if (field < 0.18) return h;
    const w = Math.min(1, (field - 0.18) / 0.2) * Math.min(1, (h + 130) / 60);
    const n1 = _wNoise3(ux * 1900 - 3.3, uy * 1900 + 8.8, uz * 1900 + 1.2);
    const n2 = oct >= 16 ? _wNoise3(ux * 7000 + 5.5, uy * 7000 - 2.2, uz * 7000 + 9.1) : 0;
    const ridge = 1 - Math.abs(n1);
    // 尾根のいちばん高い所が数mの浅さ。海面から出る岩は、その中のさらに一部だけ
    const top = -42 + 40 * ridge * ridge * ridge + 5 * n2;
    if (top <= h) return h;
    return h + (top - h) * w;
}
// その点のまわりに浅瀬・岩が出ることがないか（大陸棚より深い、または「浅瀬の多い海域」の外）
function worldShoalFree(ux, uy, uz) {
    if (_RW) return _rwShoalFree(ux, uy, uz);
    const h = worldHeightFromE(worldNoiseE(ux, uy, uz, 14));
    if (h < -160) return true;
    return _wNoise3(ux * 140 + 11.3, uy * 140 - 4.1, uz * 140 + 7.7) < 0.15;
}
// 球の上の点の高さ[m]（浅瀬・岩礁込み）
function worldHeightAt(ux, uy, uz, oct) {
    if (_RW) return _rwHeight(ux, uy, uz, oct);
    return worldShoal(ux, uy, uz, worldHeightFromE(worldNoiseE(ux, uy, uz, oct)), oct);
}

// 海面の高さを、陸が WORLD_LAND_FRACTION になるように決める
(function () {
    const r = _wRng(WORLD_SEED + 1);
    const vals = [];
    world.seaLevel = 0;
    for (let i = 0; i < 6000; i++) {
        const z = r() * 2 - 1, t = r() * Math.PI * 2, s = Math.sqrt(1 - z * z);
        vals.push(worldNoiseE(s * Math.cos(t), z, s * Math.sin(t), 5));
    }
    vals.sort((a, b) => a - b);
    world.seaLevel = vals[Math.floor(vals.length * (1 - WORLD_LAND_FRACTION))];
})();

// ── 緯度・経度 ↔ 球の点 ──
// 球の点：y が北極、経度0は +x、東経が増えると +z の向きへ回る
function worldLatLonToUnit(lat, lon, out) {
    const la = lat * Math.PI / 180, lo = lon * Math.PI / 180;
    out = out || {};
    out.x = Math.cos(la) * Math.cos(lo); out.y = Math.sin(la); out.z = Math.cos(la) * Math.sin(lo);
    return out;
}
function worldUnitToLatLon(u, out) {
    out = out || {};
    out.lat = Math.asin(Math.max(-1, Math.min(1, u.y))) * 180 / Math.PI;
    out.lon = Math.atan2(u.z, u.x) * 180 / Math.PI;
    return out;
}
// 原点（ref）での 東・北・上 の向き
function _worldFrame(lat, lon) {
    const la = lat * Math.PI / 180, lo = lon * Math.PI / 180;
    const C = { x: Math.cos(la) * Math.cos(lo), y: Math.sin(la), z: Math.cos(la) * Math.sin(lo) };
    const E = { x: -Math.sin(lo), y: 0, z: Math.cos(lo) };
    const N = { x: -Math.sin(la) * Math.cos(lo), y: Math.cos(la), z: -Math.sin(la) * Math.sin(lo) };
    return { C, E, N };
}
let _wFrameCache = null;
function worldFrame() {
    if (!_wFrameCache || _wFrameCache.lat !== world.ref.lat || _wFrameCache.lon !== world.ref.lon) {
        _wFrameCache = Object.assign({ lat: world.ref.lat, lon: world.ref.lon }, _worldFrame(world.ref.lat, world.ref.lon));
    }
    return _wFrameCache;
}
// 物理の面の点 (x=西, z=北)[m] → 球の点
//  three.js を上から北を上にして見ると、右（東）は −x になる。なので +x は西。
//  physics.heading は上から見て左回りに増えるので、羅針盤の方位は 360 − heading（worldCompass）。
function worldLocalToUnit(x, z, out) {
    const F = worldFrame();
    const a = -x / WORLD_R, b = z / WORLD_R;
    let ux = F.C.x + a * F.E.x + b * F.N.x, uy = F.C.y + a * F.E.y + b * F.N.y, uz = F.C.z + a * F.E.z + b * F.N.z;
    const l = Math.hypot(ux, uy, uz);
    out = out || {};
    out.x = ux / l; out.y = uy / l; out.z = uz / l;
    return out;
}
// 球の点 → 物理の面の点（原点の側の半球だけ）
function worldUnitToLocal(u, out) {
    const F = worldFrame();
    const d = u.x * F.C.x + u.y * F.C.y + u.z * F.C.z;
    out = out || {};
    if (d <= 0.01) { out.x = out.z = Infinity; return out; }
    out.x = -WORLD_R * (u.x * F.E.x + u.y * F.E.y + u.z * F.E.z) / d;
    out.z = WORLD_R * (u.x * F.N.x + u.y * F.N.y + u.z * F.N.z) / d;
    return out;
}
// physics.heading（上から見て左回り）⇄ 羅針盤の方位（北0・東90、右回り）
function worldCompass(heading) { return ((360 - (heading || 0)) % 360 + 360) % 360; }
function worldHeadingFromCompass(c) { return ((360 - c) % 360 + 360) % 360; }
window.worldCompass = worldCompass;
// 物理の面の点の高さ[m]（oct を省くと一番細かく）
const _wTmpU = {};
function worldHeightAtLocal(x, z, oct) {
    worldLocalToUnit(x, z, _wTmpU);
    return worldHeightAt(_wTmpU.x, _wTmpU.y, _wTmpU.z, oct || WORLD_OCT_FULL);
}
// 大円距離[m]
function worldDistance(latA, lonA, latB, lonB) {
    const a = worldLatLonToUnit(latA, lonA), b = worldLatLonToUnit(latB, lonB);
    const d = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z));
    return Math.acos(d) * WORLD_R;
}
// 今の船の緯度・経度
function worldShipLatLon() {
    const u = worldLocalToUnit(physics.cgWorldX || 0, physics.cgWorldZ || 0);
    return worldUnitToLatLon(u);
}
window.worldShipLatLon = worldShipLatLon;
function worldFmtLatLon(lat, lon) {
    const f = (v, pos, neg) => {
        const a = Math.abs(v), d = Math.floor(a), m = (a - d) * 60;
        return `${d}°${m.toFixed(1).padStart(4, '0')}'${v >= 0 ? pos : neg}`;
    };
    return `${f(lat, 'N', 'S')} ${f(lon, 'E', 'W')}`;
}
window.worldFmtLatLon = worldFmtLatLon;

// ════════════════════════════════════════════════════════════════
//  港を作る
// ════════════════════════════════════════════════════════════════
const _W_SYL_A = ['ノル', 'カス', 'ベル', 'アル', 'ミラ', 'サン', 'オス', 'リヴ', 'ヴァル', 'ポル', 'エル', 'マリ', 'トル', 'ハル', 'セラ', 'ロサ', 'キル', 'ブラン', 'アズ', 'グレ', 'シオ', 'ナギ', 'ウラ', 'カモ', 'イソ', 'ミサ', 'タカ', 'フジ', 'オル', 'ヴェ', 'ルナ', 'テオ', 'ザル', 'コル', 'メル', 'ソル'];
const _W_SYL_B = ['ヴィク', 'ハーフェン', 'ミナト', 'ベイ', 'ブルク', 'ヴァ', 'ナ', 'リア', 'サ', 'ドン', 'ヘイヴン', 'ハム', 'ス', 'ノ', 'マ', 'ツ', 'ラ', 'ゴ', 'ポリス', 'モンテ', 'シ', 'ザキ', 'ウラ', 'トン'];
function _wPortName(r, type) {
    const a = _W_SYL_A[Math.floor(r() * _W_SYL_A.length)];
    const b = _W_SYL_B[Math.floor(r() * _W_SYL_B.length)];
    return a + b + PORT_TYPES[type].suffix;
}
// 海岸の点を、陸と海の2点の間で細かく探す（二分法）
function _wFindCoast(ua, ub, oct) {
    // ua：海、ub：陸
    let a = ua, b = ub;
    for (let i = 0; i < 26; i++) {
        const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
        const l = Math.hypot(m.x, m.y, m.z); m.x /= l; m.y /= l; m.z /= l;
        if (worldNoiseE(m.x, m.y, m.z, oct) >= 0) b = m; else a = m;
    }
    return a;   // 海側のすぐ近く
}
// 現実世界の港：おおよその位置のまわり（数km）で、港を置ける海岸を探す。
// 前（海の方）に泊地の広さの水面があり、後ろ（陸の方）に岸壁を作れる陸があって、深い方を向いている所
// 6 番目（opt）：{ at: [緯度, 経度], bearing: 沖の方位 } を書いた港は、探さずにその位置・向きに置く
// （自動で探すと、川の分かれ目などで違う向きになることがある。サウサンプトンは南東のサウサンプトン・ウォーターへ）
function _rwPlacePort(def, idx) {
    const [name, type, lat0, lon0, via, opt] = def;
    const T = PORT_TYPES[type], half = T.quay / 2, basin = T.basin;
    const RAD = Math.PI / 180, mLat = WORLD_R * RAD, mLon = mLat * Math.cos(lat0 * RAD);
    const seedOf = () => { let seed = 7; for (const ch of name) seed = (seed * 31 + ch.charCodeAt(0)) % 1000000007; return seed; };
    if (opt && opt.at && Number.isFinite(opt.bearing)) {
        const [la, lo] = opt.at;
        return { id: 'r' + idx, type, name, lat: la, lon: lo, u: worldLatLonToUnit(la, lo), real: true, via: via || null, seaBearing: opt.bearing, seed: seedOf(), fixed: true, quay: opt.quay || null, dock: opt.dock || null, group: opt.group || null, berth: opt.berth || null };
    }
    const SR = 6000, STEP = 150;
    let best = null;
    for (let dy = -SR; dy <= SR; dy += STEP) for (let dx = -SR; dx <= SR; dx += STEP) {
        const dist = Math.hypot(dx, dy);
        if (dist > SR) continue;
        const lat = lat0 + dy / mLat, lon = lon0 + dx / mLon;
        const h0 = _rwSample(lat, lon);
        if (h0 >= 0 || h0 < -40) continue;                       // 岸に近い水面
        const g = 400;
        const gx = _rwSample(lat, lon + g / mLon) - _rwSample(lat, lon - g / mLon);
        const gy = _rwSample(lat + g / mLat, lon) - _rwSample(lat - g / mLat, lon);
        const gl = Math.hypot(gx, gy);
        if (gl < 0.5) continue;
        const se = -gx / gl, sn = -gy / gl;                      // 深くなる向き（東・北）
        const P = (a, b) => _rwSample(lat + (a * sn - b * se) / mLat, lon + (a * se + b * sn) / mLon);
        let water = 0, nW = 0, depth = 0, behind = 0, nB = 0;
        for (const fa of [0.15, 0.4, 0.7, 1]) for (const fb of [-1, -0.5, 0, 0.5, 1]) { const h = P(fa * basin, fb * half); nW++; if (h < 0) { water++; depth += Math.min(20, -h); } }
        for (const a of [-60, -160]) for (const fb of [-0.8, -0.3, 0.3, 0.8]) { nB++; if (P(a, fb * half) > 0) behind++; }
        water /= nW; behind /= nB;
        if (water < 0.6 || behind < 0.4) continue;
        const score = water * 2 + behind + depth / nW / 20 * 0.6 - dist / SR * 0.8;
        if (!best || score > best.score) best = { score, lat, lon, se, sn };
    }
    if (!best) return null;
    // 岸の線まで陸の方へ寄せる
    let lat = best.lat, lon = best.lon;
    for (let d = 0; d < 600; d += 10) {
        const la = lat - best.sn * 10 / mLat, lo = lon - best.se * 10 / mLon;
        if (_rwSample(la, lo) >= 0) break;
        lat = la; lon = lo;
    }
    let seed = 7;
    for (const ch of name) seed = (seed * 31 + ch.charCodeAt(0)) % 1000000007;
    return { id: 'r' + idx, type, name, lat, lon, u: worldLatLonToUnit(lat, lon), real: true, via: via || null,
             seaBearing: (Math.atan2(best.se, best.sn) / RAD + 360) % 360, seed };
}
// 現実世界の港の航路（浚渫した水路）：地形の格子（460m）では、実際に掘ってある航路（サウサンプトン・
// ウォーターやテムズ川の航路など）がならされて浅くなってしまう。そこで港の泊地から、なるべく深い所を
// 通って外洋の深い所までの道（自然の澪筋）を格子の上で探し、その道を港の航路の深さまで掘る。
// 格子そのものを掘るので、3D の地形・座礁・地図・航路探しのどれにも同じ航路が見える。
// ドックの入口の外の点（入口の真ん中から、入っていく向きと反対へ DOCK_TURN_OUT m）。大きな船はここで向きを合わせる
const DOCK_TURN_OUT = 320;
function _rwDockOut(p, dist) {
    if (!p || !p.dock) return null;
    const [la, lo] = p.dock.entrance, br = (p.dock.inBearing + 180) * Math.PI / 180, d = dist || p.dock.turnOut || DOCK_TURN_OUT;
    const mLat = WORLD_R * Math.PI / 180, mLon = mLat * Math.cos(la * Math.PI / 180);
    return { lat: la + Math.cos(br) * d / mLat, lon: lo + Math.sin(br) * d / mLon };
}
window._rwDockOut = _rwDockOut;
function _rwFairway(p) {
    // 作り込んだ港（大きな客船の港）は、喫水 15〜20m の超大型客船でも通れるよう深く掘る
    const R = _RW, T = PORT_TYPES[p.type], D = (_rwDetailOf(p.lat, p.lon) ? 24 : T.depth + 2);
    const RAD = Math.PI / 180;
    const cellOf = (lat, lon) => ({ i: Math.round((lon - R.lon0) / R.cell), j: Math.round((R.lat1 - lat) / R.cell) });
    const llOf = (i, j) => ({ lat: R.lat1 - j * R.cell, lon: R.lon0 + i * R.cell });
    // 始まり：泊地の真ん中（44-world-terrain.js の _portAdjust が掘る所）
    const br = p.seaBearing * RAD, mLat = WORLD_R * RAD, mLon = mLat * Math.cos(p.lat * RAD);
    const a0 = T.basin * 0.6;
    const s0 = cellOf(p.lat + Math.cos(br) * a0 / mLat, p.lon + Math.sin(br) * a0 / mLon);
    const BOX = Math.round(90000 / (R.cell * mLat));            // 90km 四方まで
    const i0 = Math.max(0, s0.i - BOX), i1 = Math.min(R.cols - 1, s0.i + BOX), j0 = Math.max(0, s0.j - BOX), j1 = Math.min(R.rows - 1, s0.j + BOX);
    const W = i1 - i0 + 1, Hh = j1 - j0 + 1, N = W * Hh;
    const hAt = (i, j) => R.h[j * R.cols + i];
    const dx = R.cell * mLon, dy = R.cell * mLat;
    const nb = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    // 深いほど通りやすい。陸は低い所（3m まで：砂州・狭い水路の口）だけ高くついて通れる
    const cost = (h) => h < 0 ? 1 + 40 / Math.max(2, -h) : h < 3 ? 120 : Infinity;
    // 高い陸（3m 以上）のとなりの升目は、なるべく通らない（掘っても航路の端に陸が残って座礁する）
    const nearHigh = (i, j) => {
        for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) { const ii = i + a, jj = j + b; if (ii >= 0 && jj >= 0 && ii < R.cols && jj < R.rows && hAt(ii, jj) >= 3) return true; }
        return false;
    };
    const openDeep = (i, j) => {
        for (let b = -2; b <= 2; b++) for (let a = -2; a <= 2; a++) { const ii = i + a, jj = j + b; if (ii < 0 || jj < 0 || ii >= R.cols || jj >= R.rows || hAt(ii, jj) > -(D + 2)) return false; }
        return true;
    };
    // 1 区間ぶんの道：start（格子）から、goal(i, j) を満たす所まで。見つからなければ一番深く行けた所まで
    const search = (st, goalFn) => {
        const g = new Float32Array(N).fill(Infinity), from = new Int32Array(N).fill(-1);
        const heap = [];
        const push = (k, f) => { heap.push([f, k]); let c = heap.length - 1; while (c > 0) { const q = (c - 1) >> 1; if (heap[q][0] <= heap[c][0]) break; [heap[q], heap[c]] = [heap[c], heap[q]]; c = q; } };
        const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let c = 0; for (;;) { const l = 2 * c + 1, r = l + 1; let m = c; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === c) break; [heap[m], heap[c]] = [heap[c], heap[m]]; c = m; } } return top; };
        const sk = (st.j - j0) * W + (st.i - i0);
        if (sk < 0 || sk >= N) return null;
        g[sk] = 0; push(sk, 0);
        let goal = -1, best = -1, bestD = 0, n = 0;
        while (heap.length && n < 400000) {
            const [, k] = pop(); n++;
            const i = k % W + i0, j = ((k / W) | 0) + j0;
            if (goalFn(i, j)) { goal = k; break; }
            const h = hAt(i, j);
            if (-h > bestD && Math.hypot((i - s0.i) * dx, (j - s0.j) * dy) > 2500) { bestD = -h; best = k; }
            for (const [a, b] of nb) {
                const ii = i + a, jj = j + b;
                if (ii < i0 || jj < j0 || ii > i1 || jj > j1) continue;
                let c = cost(hAt(ii, jj));
                if (c === Infinity) continue;
                // 斜めに進むとき、両どなりがどちらも陸のすき間：低い陸（10m 未満）なら掘って通すので通りにくいだけ、高い陸ならすり抜けない
                if (a && b && hAt(i + a, j) >= 3 && hAt(i, j + b) >= 3) { if (Math.max(hAt(i + a, j), hAt(i, j + b)) >= 10) continue; c *= 3; }
                if (nearHigh(ii, jj)) c *= 4;
                const kk = (jj - j0) * W + (ii - i0), ng = g[k] + Math.hypot(a * dx, b * dy) * c;
                if (ng < g[kk]) { g[kk] = ng; from[kk] = k; push(kk, ng); }
            }
        }
        if (goal < 0) goal = best;
        if (goal < 0) return null;
        const cells = [];
        for (let k = goal; k >= 0; k = from[k]) cells.push([k % W + i0, ((k / W) | 0) + j0]);
        return cells.reverse();
    };
    // 作り込んだ港の中は、細かい地形（40m にまとめる）の上で深い所をたどる（粗い格子では、本物の浅瀬を横切ってしまう）
    let pre = [], vias = (p.via || []).slice(), cur = s0;
    const Dt = _rwDetailOf(p.lat, p.lon);
    if (Dt) {
        const inBox = (v) => v[0] > Dt.lat0 && v[0] < Dt.lat1 && v[1] > Dt.lon0 && v[1] < Dt.lon1;
        let tgt = null;
        while (vias.length && inBox(vias[0])) tgt = vias.shift();
        // ドックの中の岸壁：ドックの入口の外（入口から DOCK_TURN_OUT m）から。航路の最初の点（自動航行が止まる所）もそこ
        const dk = _rwDockOut(p);
        const st = dk || { lat: p.lat + Math.cos(br) * 150 / mLat, lon: p.lon + Math.sin(br) * 150 / mLon };
        const r = _rwDetailRoute(Dt, st, tgt ? { lat: tgt[0], lon: tgt[1] } : null);
        if (r) { pre = dk ? [dk, ...r.pts] : r.pts; cur = cellOf(r.end.lat, r.end.lon); }
    }
    // 通る所（実際の航路の目印。港ごとの via）を順に通ってから、外洋の深い所へ
    let cells = [];
    for (const [vl, vo] of vias) {
        const v = cellOf(vl, vo);
        const seg = search(cur, (i, j) => Math.abs(i - v.i) <= 1 && Math.abs(j - v.j) <= 1);
        if (!seg) break;
        cells = cells.concat(cells.length ? seg.slice(1) : seg);
        const e = seg[seg.length - 1]; cur = { i: e[0], j: e[1] };
    }
    const last = search(cur, (i, j) => Math.hypot((i - s0.i) * dx, (j - s0.j) * dy) > 2500 && hAt(i, j) <= -(D + 4) && openDeep(i, j));
    if (last) cells = cells.concat(cells.length ? last.slice(1) : last);
    if (cells.length < 2) return pre.length ? { depth: D, pts: [{ lat: p.lat, lon: p.lon }, ...pre] } : null;
    // まっすぐにできる所はまっすぐに（途中がずっと水の上の範囲で。低い陸を横切ると、掘ったときに
    // ありもしない運河ができてしまう。道すじそのものが通る低い陸（狭い口）は、そのまま残る）
    // （線の両側 200m に高い陸がある所も、まっすぐにしない：掘った航路の端に陸が残る）
    const clear = (A, B) => {
        const L = Math.max(Math.abs(B[0] - A[0]), Math.abs(B[1] - A[1])) * 4;
        const ex = (B[0] - A[0]) * dx, ey = (B[1] - A[1]) * dy, el = Math.hypot(ex, ey) || 1;
        const oi = -ey / el * 200 / dx, oj = ex / el * 200 / dy;          // 横 200m（格子の升目で）
        for (let t = 1; t < L; t++) {
            const u = t / L, ci = A[0] + (B[0] - A[0]) * u, cj = A[1] + (B[1] - A[1]) * u, q = llOf(ci, cj);
            if (_rwSample(q.lat, q.lon) >= -1) return false;
            for (const k of [-1, 1]) { const r = llOf(ci + oi * k, cj + oj * k); if (_rwSample(r.lat, r.lon) >= 3) return false; }
        }
        return true;
    };
    const simp = [cells[0]];
    let a = 0;
    while (a < cells.length - 1) {
        let b = Math.min(cells.length - 1, a + 1);
        for (let c = cells.length - 1; c > a + 1; c--) if (clear(cells[a], cells[c])) { b = c; break; }
        simp.push(cells[b]); a = b;
    }
    return { depth: D, pts: [{ lat: p.lat, lon: p.lon }, ...pre, ...simp.map(([i, j]) => llOf(i, j))] };
}
// 作り込んだ港の中の航路：40m の升目（中と四隅の浅い方の深さ）で、深いほど通りやすく、6m より浅い所は通らない。
// 始まり st から、目当て tgt（無ければ港の枠の縁）まで。まっすぐ行ける所（途中がずっと 8m より深い）はまっすぐに
function _rwDetailRoute(d, st, tgt) {
    const f = 4, nx = Math.floor((d.cols - 1) / f), ny = Math.floor((d.rows - 1) / f), N = nx * ny;
    const dep = new Float32Array(N);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        let hm = -Infinity;
        for (const [a, b] of [[2, 2], [0, 0], [f, 0], [0, f], [f, f]]) hm = Math.max(hm, d.h[(j * f + b) * d.cols + i * f + a] * 0.1);
        dep[j * nx + i] = -hm;
    }
    const ll = (i, j) => ({ lat: d.lat1 - (j * f + 2) * d.dLat, lon: d.lon0 + (i * f + 2) * d.dLon });
    const cellOf = (q) => ({ i: Math.max(0, Math.min(nx - 1, Math.round((q.lon - d.lon0) / d.dLon / f - 0.5))), j: Math.max(0, Math.min(ny - 1, Math.round((d.lat1 - q.lat) / d.dLat / f - 0.5))) });
    const s = cellOf(st);
    // 始まりが浅ければ、近くの深い升目から
    let sk = -1, bd = Infinity;
    for (let b = -8; b <= 8; b++) for (let a = -8; a <= 8; a++) {
        const i = s.i + a, j = s.j + b;
        if (i < 0 || j < 0 || i >= nx || j >= ny || dep[j * nx + i] < 8) continue;
        const e = a * a + b * b; if (e < bd) { bd = e; sk = j * nx + i; }
    }
    if (sk < 0) return null;
    const t = tgt ? cellOf(tgt) : null;
    const goal = (i, j) => t ? Math.abs(i - t.i) <= 2 && Math.abs(j - t.j) <= 2 : (i < 3 || j < 3 || i >= nx - 3 || j >= ny - 3) && dep[j * nx + i] >= 10;
    // 浅い所（8m 未満）から 80m 以内の升目は通りにくく（水路の真ん中を通る）
    const nearShoal = new Uint8Array(N);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        if (dep[j * nx + i] >= 8) continue;
        for (let b = -2; b <= 2; b++) for (let a = -2; a <= 2; a++) { const ii = i + a, jj = j + b; if (ii >= 0 && jj >= 0 && ii < nx && jj < ny) nearShoal[jj * nx + ii] = 1; }
    }
    const g = new Float64Array(N).fill(Infinity), from = new Int32Array(N).fill(-1), heap = [];
    const push = (k, v) => { heap.push([v, k]); let c = heap.length - 1; while (c > 0) { const q = (c - 1) >> 1; if (heap[q][0] <= heap[c][0]) break; [heap[q], heap[c]] = [heap[c], heap[q]]; c = q; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let c = 0; for (;;) { const l = 2 * c + 1, r = l + 1; let m = c; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === c) break; [heap[m], heap[c]] = [heap[c], heap[m]]; c = m; } } return top; };
    g[sk] = 0; push(sk, 0);
    let end = -1, best = sk, bestE = Infinity;
    while (heap.length) {
        const [v, k] = pop();
        if (v > g[k]) continue;
        const i = k % nx, j = (k / nx) | 0;
        if (goal(i, j)) { end = k; break; }
        if (t) { const e = Math.hypot(i - t.i, j - t.j); if (e < bestE) { bestE = e; best = k; } }
        for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
            const ii = i + a, jj = j + b;
            if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
            const kk = jj * nx + ii, dd = dep[kk];
            if (dd < 6) continue;
            // 大きな船（喫水 10m ほど）が通れる深さ（12.5m）より浅い所は、ずっと通りにくく（掘ってある航路を通る）
            const ng = v + Math.hypot(a, b) * (1 + 200 / (dd * dd) + (dd < 12.5 ? 8 : 0)) * (nearShoal[kk] ? 4 : 1);
            if (ng < g[kk]) { g[kk] = ng; from[kk] = k; push(kk, ng); }
        }
    }
    if (end < 0) end = t ? best : -1;
    if (end < 0) return null;
    const path = [];
    for (let k = end; k >= 0; k = from[k]) path.push(k);
    path.reverse();
    // まっすぐにできる所はまっすぐに（線の上と左右 40m を 20m おきに、12m（道すじの浅い所がそれより浅ければ、そこまで）より深いか：
    // 大きな船の幅と横ずれの分）
    let deepest = Infinity;
    for (const k of path) deepest = Math.min(deepest, dep[k]);
    const clear = (k0, k1) => {
        const A = ll(k0 % nx, (k0 / nx) | 0), B = ll(k1 % nx, (k1 / nx) | 0);
        const ey = (B.lat - A.lat) / d.dLat, ex = (B.lon - A.lon) / d.dLon, el = Math.hypot(ex, ey) || 1;
        const L = el * d.cell, n = Math.max(2, Math.ceil(L / 20));
        const oLat = ex / el * 40 / d.cell * d.dLat, oLon = -ey / el * 40 / d.cell * d.dLon;   // 横 40m
        for (let q = 1; q < n; q++) {
            const u = q / n, la = A.lat + (B.lat - A.lat) * u, lo = A.lon + (B.lon - A.lon) * u;
            for (const k of [0, -1, 1]) if (!(_rwDetailAt(d, la + oLat * k, lo + oLon * k) < -Math.min(12, deepest - 0.5))) return false;
        }
        return true;
    };
    const simp = [path[0]];
    let a = 0;
    while (a < path.length - 1) {
        let b = a + 1;
        for (let c = Math.min(path.length - 1, a + 400); c > a + 1; c--) if (clear(path[a], path[c])) { b = c; break; }
        simp.push(path[b]); a = b;
    }
    const pts = simp.map(k => ll(k % nx, (k / nx) | 0));
    return { pts, end: pts[pts.length - 1] };
}
// 航路を格子に掘る：線から 400m は航路の深さ、900m まではなだらかに（3m 以上の陸は削らない）。
// （格子は 460m おきなので、全部の深さで掘る幅が升目より狭いと、ならした地形で航路の端が浅くなる）
// ただし港の外の航路では、線から 200m の中の低い陸（10m 未満：砂州・浜の砂丘）と、線から 150m の中の陸（30m 未満）も掘る
// （格子は 460m なので、航路の端に陸の升目が残ると、ならした地形が浅くなって必ず座礁する）
function _rwCarve(fw) {
    const R = _RW, RAD = Math.PI / 180, mLat = WORLD_R * RAD;
    const P0 = fw.pts[0];
    for (let s = 0; s < fw.pts.length - 1; s++) {
        const A = fw.pts[s], B = fw.pts[s + 1];
        const mLon = mLat * Math.cos((A.lat + B.lat) / 2 * RAD);
        const ax = (A.lon - R.lon0) * mLon, ay = (R.lat1 - A.lat) * mLat, bx = (B.lon - R.lon0) * mLon, by = (R.lat1 - B.lat) * mLat;
        const L2 = (bx - ax) ** 2 + (by - ay) ** 2 || 1;
        const pad = 900;
        const ci0 = Math.max(0, Math.floor((Math.min(ax, bx) - pad) / (R.cell * mLon))), ci1 = Math.min(R.cols - 1, Math.ceil((Math.max(ax, bx) + pad) / (R.cell * mLon)));
        const cj0 = Math.max(0, Math.floor((Math.min(ay, by) - pad) / (R.cell * mLat))), cj1 = Math.min(R.rows - 1, Math.ceil((Math.max(ay, by) + pad) / (R.cell * mLat)));
        for (let j = cj0; j <= cj1; j++) for (let i = ci0; i <= ci1; i++) {
            const px = i * R.cell * mLon, py = j * R.cell * mLat;
            const t = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / L2));
            const d = Math.hypot(px - ax - t * (bx - ax), py - ay - t * (by - ay));
            if (d > pad) continue;
            const k = j * R.cols + i, h = R.h[k];
            if (h >= 3) {
                if (!(s > 0 && (d < 200 && h < 10 || d < 150 && h < 30))) continue;   // 升目の真ん中が航路の線から 150m なら、升目の大半は水路
                const lat = R.lat1 - j * R.cell, lon = R.lon0 + i * R.cell;
                if (Math.hypot((lat - P0.lat) * mLat, (lon - P0.lon) * mLon) < 400) continue;   // 港の岸壁のまわりは残す
            }
            const want = d < 400 ? fw.depth : fw.depth * (1 - (d - 400) / (pad - 400));
            if (h > -want) R.h[k] = -Math.round(want);
        }
    }
}
function _rwBuildPorts() {
    const W = REAL_WORLDS[world.realKey];
    const out = [];
    (W.ports || []).forEach((d, i) => { const p = _rwPlacePort(d, i); if (p) out.push(p); else console.warn('港を置けませんでした：' + d[0]); });
    // 航路を探して掘る（掘った格子をワーカーにも渡し直す）
    for (const p of out) { p.fairway = _rwFairway(p); if (p.fairway) _rwCarve(p.fairway); }
    if (typeof terrain !== 'undefined') worldWorkerSync(terrain.worker);
    if (typeof _apWorkerObj !== 'undefined') worldWorkerSync(_apWorkerObj);
    return out;
}
// 港の一覧を作る（決まった種なので、いつも同じ）
// 港のまとまり：同じ港の埠頭（opt.group）を 1 つにまとめる。地図には港として 1 つだけ出し、タップで埠頭を選ぶ
//  { name, lat, lon, type, ports: [埠頭…] }（埠頭が 1 つの港は、その港だけのまとまり）
function worldPortGroups() {
    const ports = worldBuildPorts();
    if (world.portGroups && world.portGroups.src === ports) return world.portGroups.list;
    const map = new Map(), list = [];
    for (const p of ports) {
        const key = p.group || ('#' + p.id);
        let g = map.get(key);
        if (!g) { g = { name: p.group || p.name, lat: p.lat, lon: p.lon, type: p.type, ports: [] }; map.set(key, g); list.push(g); }
        g.ports.push(p);
    }
    // 埠頭が複数ある港は、埠頭の真ん中に印を置き、種類はいちばん多いもの（同じなら最初の埠頭）
    for (const g of list) if (g.ports.length > 1) {
        g.lat = g.ports.reduce((a, p) => a + p.lat, 0) / g.ports.length;
        g.lon = g.ports.reduce((a, p) => a + p.lon, 0) / g.ports.length;
        const cnt = {}; for (const p of g.ports) cnt[p.type] = (cnt[p.type] || 0) + 1;
        g.type = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0];
    }
    world.portGroups = { src: ports, list };
    return list;
}
window.worldPortGroups = worldPortGroups;
// 埠頭の短い名前（地図の一覧や小さな地図に出す）
function worldBerthLabel(p) { return p.berth || p.name; }
window.worldBerthLabel = worldBerthLabel;
function worldBuildPorts() {
    if (world.ports) return world.ports;
    if (_RW) { world.ports = _rwBuildPorts(); return world.ports; }
    const r = _wRng(WORLD_SEED + 7);
    const STEP = 0.75;
    const nLat = Math.round(150 / STEP), nLon = Math.round(360 / STEP);
    const land = new Uint8Array(nLat * nLon);
    const u = {};
    for (let i = 0; i < nLat; i++) {
        const lat = -75 + (i + 0.5) * STEP;
        for (let j = 0; j < nLon; j++) {
            worldLatLonToUnit(lat, -180 + (j + 0.5) * STEP, u);
            land[i * nLon + j] = worldNoiseE(u.x, u.y, u.z, 7) >= 0 ? 1 : 0;
        }
    }
    // 海岸の海側のマス（隣に陸がある海のマス）
    const cands = [];
    for (let i = 1; i < nLat - 1; i++) {
        for (let j = 0; j < nLon; j++) {
            if (land[i * nLon + j]) continue;
            let nb = -1, cnt = 0;
            for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const jj = (j + dj + nLon) % nLon;
                if (land[(i + di) * nLon + jj]) { cnt++; nb = [i + di, jj]; }
            }
            if (cnt > 0 && cnt < 4) cands.push({ i, j, nb, cnt });
        }
    }
    // 入り江（陸に多く囲まれた所）ほど港に向く
    for (let k = cands.length - 1; k > 0; k--) { const q = Math.floor(r() * (k + 1)); const t = cands[k]; cands[k] = cands[q]; cands[q] = t; }
    cands.sort((a, b) => b.cnt - a.cnt);
    const ports = [];
    const MIN_DIST = 260000;
    const unitOf = (i, j) => worldLatLonToUnit(-75 + (i + 0.5) * STEP, -180 + (j + 0.5) * STEP);
    for (const c of cands) {
        if (ports.length >= 150) break;
        const us = unitOf(c.i, c.j);
        let far = true;
        for (const p of ports) {
            const d = Math.acos(Math.max(-1, Math.min(1, us.x * p.u.x + us.y * p.u.y + us.z * p.u.z))) * WORLD_R;
            if (d < MIN_DIST) { far = false; break; }
        }
        if (!far) continue;
        // 海岸線を細かく探す（地図より細かい段まで）
        const ul = unitOf(c.nb[0], c.nb[1]);
        if (worldNoiseE(us.x, us.y, us.z, 12) >= 0 || worldNoiseE(ul.x, ul.y, ul.z, 12) < 0) continue;
        const uc = _wFindCoast(us, ul, 14);
        // 海の方の向き：高さが下がる向き
        const ll = worldUnitToLatLon(uc);
        const F = _worldFrame(ll.lat, ll.lon);
        const h = 1500 / WORLD_R;
        const at = (a, b) => { const x = F.C.x + a * F.E.x + b * F.N.x, y = F.C.y + a * F.E.y + b * F.N.y, z = F.C.z + a * F.E.z + b * F.N.z, l = Math.hypot(x, y, z); return worldNoiseE(x / l, y / l, z / l, 12); };
        const gx = at(h, 0) - at(-h, 0), gz = at(0, h) - at(0, -h);
        const gl = Math.hypot(gx, gz);
        if (gl < 1e-9) continue;
        const seaE = -gx / gl, seaN = -gz / gl;         // 海の方（東・北の成分）
        // 種類：緯度が高すぎる所は漁港に、残りはくじ
        const q = r();
        let type = q < 0.34 ? 'fishing' : q < 0.56 ? 'town' : q < 0.72 ? 'city' : q < 0.88 ? 'cargo' : 'naval';
        if (Math.abs(ll.lat) > 62 && (type === 'city' || type === 'cargo')) type = 'fishing';
        ports.push({
            id: 'p' + ports.length, type, name: _wPortName(r, type),
            lat: ll.lat, lon: ll.lon, u: uc,
            seaBearing: (Math.atan2(seaE, seaN) * 180 / Math.PI + 360) % 360,   // 海の方の方位（0＝北、90＝東）
            seed: Math.floor(r() * 1e9),
        });
    }
    // 名前が重ならないように
    const seen = new Set();
    for (const p of ports) {
        let n = p.name, k = 2;
        while (seen.has(n)) n = p.name.replace(PORT_TYPES[p.type].suffix, '') + '第' + (k++) + PORT_TYPES[p.type].suffix;
        p.name = n; seen.add(n);
    }
    world.ports = ports;
    return ports;
}
window.worldBuildPorts = worldBuildPorts;

// 近い港（距離[m]付き）
function worldNearestPort(lat, lon) {
    const ports = worldBuildPorts();
    const u = worldLatLonToUnit(lat, lon);
    let best = null, bd = Infinity;
    for (const p of ports) {
        const d = Math.acos(Math.max(-1, Math.min(1, u.x * p.u.x + u.y * p.u.y + u.z * p.u.z))) * WORLD_R;
        if (d < bd) { bd = d; best = p; }
    }
    return best ? { port: best, dist: bd } : null;
}
window.worldNearestPort = worldNearestPort;

// ════════════════════════════════════════════════════════════════
//  モード・移動・保存
// ════════════════════════════════════════════════════════════════
(function restoreWorld() {
    try {
        const s = JSON.parse(localStorage.getItem('susuru_world') || 'null');
        if (s) {
            if (s.mode === 'world' || s.mode === 'ocean') world.mode = s.mode;
            // 現実世界：地形データを読み終わるまでは「海だけ」にしておき、読んだら続きから（worldRestoreReal）
            if (s.kind === 'real' && REAL_WORLDS[s.realKey]) {
                world.kind = 'real'; world.realKey = s.realKey; WORLD_R = WORLD_R_EARTH;
                world._pendingReal = { mode: world.mode };
                world.mode = 'ocean';
            }
            if (s.ref && Number.isFinite(s.ref.lat) && Number.isFinite(s.ref.lon)) world.ref = { lat: s.ref.lat, lon: s.ref.lon };
            // 前回の船の位置から続ける（その位置を新しい原点にする）
            if (s.ship && Number.isFinite(s.ship.lat) && Number.isFinite(s.ship.lon)) {
                world.ref = { lat: s.ship.lat, lon: s.ship.lon };
                if (Number.isFinite(s.ship.hdg)) world._resumeHeading = s.ship.hdg;
            }
        }
    } catch (e) { /* ignore */ }
})();
function _worldKindKey() { return world.kind === 'real' ? 'real:' + world.realKey : 'gen'; }
function _worldSave() {
    if (world._pendingReal) return;                    // 現実世界の読み込み中は書かない
    let old = null;
    try { old = JSON.parse(localStorage.getItem('susuru_world') || 'null'); } catch (e) { /* ignore */ }
    const o = { mode: world.mode, ref: world.ref, kind: world.kind, realKey: world.realKey, ships: (old && old.ships) || {} };
    if (world.mode === 'world' && typeof physics !== 'undefined') {
        const ll = worldShipLatLon();
        o.ship = { lat: ll.lat, lon: ll.lon, hdg: physics.heading || 0 };
        o.ships[_worldKindKey()] = o.ship;             // 世界ごとに、最後にいた所を覚える
    }
    try { localStorage.setItem('susuru_world', JSON.stringify(o)); } catch (e) { /* ignore */ }
}
window._worldSave = _worldSave;
// ── 現実世界の地形データを読む（PNG：高さ ＝ R×256 ＋ G − 32768）──
const _rwCache = {};
async function worldLoadReal(key) {
    if (_rwCache[key]) return _rwCache[key];
    const W = REAL_WORLDS[key];
    const meta = await (await fetch(W.url + '.json')).json();
    const blob = await (await fetch(W.url + '.png')).blob();
    let bmp;
    try { bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }); }
    catch (e) { bmp = await createImageBitmap(blob); }
    const cv = document.createElement('canvas'); cv.width = meta.cols; cv.height = meta.rows;
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, 0, 0);
    const px = g.getImageData(0, 0, meta.cols, meta.rows).data;
    const h = new Int16Array(meta.cols * meta.rows);
    for (let i = 0, j = 0; i < h.length; i++, j += 4) h[i] = px[j] * 256 + px[j + 1] - 32768;
    cv.width = cv.height = 1;
    if (bmp.close) bmp.close();
    const rw = { key, lat0: meta.lat0, lat1: meta.lat1, lon0: meta.lon0, lon1: meta.lon1, rows: meta.rows, cols: meta.cols, cell: meta.cell, h };
    // 作り込んだ港（読めなかった港は、ふつうの地形のまま）
    rw.hd = [];
    for (const hk of W.harbors || []) {
        try { rw.hd.push(await _rwLoadHarbor(hk)); }
        catch (e) { console.warn('作り込んだ港の地形を読めませんでした：' + hk, e); }
    }
    if (!rw.hd.length) rw.hd = null;
    _rwCache[key] = rw;
    return rw;
}
// 作り込んだ港の地形（PNG：R×256＋G − 32768 ＝ 高さ[0.1m]、B ＝ 種類 0 海・1 陸・2 ドックの水・3 桟橋・4 港の敷地）
async function _rwLoadHarbor(hk) {
    const meta = await (await fetch('data/harbors/' + hk + '.json')).json();
    const blob = await (await fetch('data/harbors/' + hk + '.png')).blob();
    let bmp;
    try { bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }); }
    catch (e) { bmp = await createImageBitmap(blob); }
    const cv = document.createElement('canvas'); cv.width = meta.cols; cv.height = meta.rows;
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, 0, 0);
    const px = g.getImageData(0, 0, meta.cols, meta.rows).data;
    const n = meta.cols * meta.rows, h = new Int16Array(n), k = new Uint8Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) { h[i] = px[j] * 256 + px[j + 1] - 32768; k[i] = px[j + 2]; }
    cv.width = cv.height = 1;
    if (bmp.close) bmp.close();
    return { key: hk, name: meta.name, lat0: meta.lat0, lat1: meta.lat1, lon0: meta.lon0, lon1: meta.lon1, rows: meta.rows, cols: meta.cols, dLat: meta.dLat, dLon: meta.dLon, cell: meta.cell, h, k };
}
window.worldLoadReal = worldLoadReal;
// 世界を切り替えたとき：覚えている物（港・地図・地形・ワーカー・タグ・自動の操船）をやり直す
function _worldKindChanged() {
    world.ports = null; _wFrameCache = null;
    if (typeof terrain !== 'undefined') worldWorkerSync(terrain.worker);
    if (typeof _apWorkerObj !== 'undefined') worldWorkerSync(_apWorkerObj);
    if (typeof autopilotStop === 'function') { autopilotStop('', true); autopilot.route = null; autopilot.resume = null; autopilot.dest = null; autopilot.msg = ''; }
    if (typeof harborAuto !== 'undefined' && harborAuto.mode) harborAutoStop('');
    if (typeof harborAuto !== 'undefined') { harborAuto.resume = null; harborAuto.msg = ''; if (typeof _haClearLines === 'function') _haClearLines(); }
    if (window.tugs && window.tugs.length && typeof scene !== 'undefined') {
        for (const t of tugs) { scene.remove(t.g); scene.remove(t.line); }
        tugs.length = 0;
        if (typeof renderTugPanel === 'function') renderTugPanel();
    }
    if (window._tugCrumbs) _tugCrumbs.length = 0;
    _wm.base = null; _wm.detail = null; _wm.detailKey = ''; _wm.sel = null; _wm.selPt = null;
    if (typeof renderAutopilotPanel === 'function') renderAutopilotPanel();
}
// 世界を選ぶ：'gen'（作った世界）／'real'（現実世界。key：REAL_WORLDS）。前にいた所があればそこから、無ければ最初の港から
async function worldSetKind(kind, key) {
    if (kind === 'real') {
        key = key || 'britain';
        if (!REAL_WORLDS[key]) return false;
        if (world.kind === 'real' && world.realKey === key && _RW && world.mode === 'world') return true;
        const st = document.getElementById('wp-status');
        if (st) st.textContent = `${REAL_WORLDS[key].name}の地形を読み込んでいます…`;
        let rw;
        try { rw = await worldLoadReal(key); }
        catch (e) { if (st) st.textContent = '地形データを読み込めませんでした（通信を確かめてください）'; return false; }
        _RW = rw; WORLD_R = WORLD_R_EARTH; world.kind = 'real'; world.realKey = key;
    } else {
        if (world.kind === 'gen' && world.mode === 'world') return true;
        _RW = null; WORLD_R = WORLD_R_GEN; world.kind = 'gen'; world.realKey = null;
    }
    world._pendingReal = null;
    _worldKindChanged();
    let saved = null;
    try { const o = JSON.parse(localStorage.getItem('susuru_world') || 'null'); saved = o && o.ships && o.ships[_worldKindKey()]; } catch (e) { /* ignore */ }
    if (saved && Number.isFinite(saved.lat) && (kind !== 'real' || _rwInside(saved.lat, saved.lon))) {
        world.mode = 'world';
        world.ref = { lat: saved.lat, lon: saved.lon }; _wFrameCache = null;
        physics.cgWorldX = 0; physics.cgWorldZ = 0; physics.heading = saved.hdg || 0;
        physics.speed = 0; physics.targetSpeed = 0; physics.turnRate = 0;
        if (typeof shipHistory !== 'undefined') shipHistory.length = 0;
        window.lastShipPos = null;
        _worldSave();
        if (typeof worldTerrainModeChanged === 'function') worldTerrainModeChanged(true);
    } else {
        const ports = worldBuildPorts();
        const start = (kind === 'real' ? ports.find(p => p.name === REAL_WORLDS[key].start) : ports.find(p => p.type === 'city')) || ports[0];
        if (start) worldStartAtPort(start);
    }
    if (kind === 'real') { const c = REAL_WORLDS[key].center; if (!_wm._centered) { _wm.cx = c.lon; _wm.cy = c.lat; _wm.zoom = Math.max(_wm.zoom, 22); } }
    worldMapRedraw();
    return true;
}
window.worldSetKind = worldSetKind;
// 起動したとき、前回が現実世界なら、地形を読んでから続きへ
async function worldRestoreReal() {
    const P = world._pendingReal;
    if (!P) return;
    try { _RW = await worldLoadReal(world.realKey); }
    catch (e) { world._pendingReal = null; _RW = null; WORLD_R = WORLD_R_GEN; world.kind = 'gen'; world.realKey = null; return; }
    world._pendingReal = null;
    _worldKindChanged();
    world.mode = P.mode;
    if (world._resumeHeading !== undefined && typeof physics !== 'undefined') physics.heading = world._resumeHeading;
    if (typeof worldTerrainModeChanged === 'function') worldTerrainModeChanged(true);
    worldMapRedraw();
}
window.worldRestoreReal = worldRestoreReal;
function worldSetMode(mode) {
    if (mode !== 'world' && mode !== 'ocean') return;
    // 現実世界から「世界を航海」を押したら、作った世界へ
    if (mode === 'world' && world.kind === 'real') { worldSetKind('gen'); return; }
    if (mode === 'world' && world.mode !== 'world') {
        world.mode = 'world';
        // 初めてなら、いちばん大きな港湾都市から出航する
        if (!world.ref || (world.ref.lat === 0 && world.ref.lon === 0)) {
            const ports = worldBuildPorts();
            const start = ports.find(p => p.type === 'city') || ports[0];
            if (start) { worldStartAtPort(start); return; }
        }
    } else {
        world.mode = mode;
    }
    _worldSave();
    if (typeof worldTerrainModeChanged === 'function') worldTerrainModeChanged();
    worldMapRedraw();
}
window.worldSetMode = worldSetMode;

// 船の喫水[m]（喫水線からキールまで）
// 模型の形から決めた喫水（いちばん深い所）[m]
function worldShipDraftAuto() {
    const hp = window.hullProfile;
    const sy = (typeof shipGroup !== 'undefined' && shipGroup) ? Math.abs(shipGroup.scale.y) || 1 : 1;
    if (hp && hp.ready) {
        let d = 0;
        for (const sl of hp.slices || []) d = Math.max(d, sl.draft || 0);
        if (!(d > 0) && hp.designWaterlineY > hp.keelY) d = hp.designWaterlineY - hp.keelY;
        if (d > 0) return d * sy;
    }
    return 0.4 * (physics.scale || 1);
}
// 操作パネルの「Draft (吃水深)」レバーで沈めた（＋）・浮かせた（－）分[m]
function worldShipDraftLever() {
    const v = +physics.draftOffset;
    return Number.isFinite(v) ? v : 0;
}
// レバーを 0 にしたときの喫水[m]。船体設定で手入力（physics.draftOverride）していればそれ
function worldShipDraftBase() {
    return physics.draftOverride > 0 ? physics.draftOverride : worldShipDraftAuto();
}
// 今の喫水[m]（レバーの分を足す）。座礁・水深の余裕・自動航行・離着岸はこれを基準にする
function worldShipDraft() {
    return Math.max(0.1, worldShipDraftBase() + worldShipDraftLever());
}
// 船の中の前後位置 z（模型の座標）での 半幅[m]・喫水[m]（船体の輪切りから。手入力の喫水は比で掛ける）
function worldHullAt(zLocal) {
    const hp = window.hullProfile;
    const sc = physics.scale || 1;
    const sy = (typeof shipGroup !== 'undefined' && shipGroup) ? Math.abs(shipGroup.scale.y) || 1 : 1;
    if (!hp || !hp.ready || !hp.slices || hp.slices.length < 2) return { hw: 1.5 * sc, d: worldShipDraft() };
    const lever = worldShipDraftLever();
    const a = zLocal / hp.halfLen * (hp.bowSign || 1);
    const sl = hp.slices;
    let i = 0;
    while (i < sl.length - 2 && sl[i + 1].alongNorm < a) i++;
    const A = sl[i], B = sl[i + 1];
    const u = Math.max(0, Math.min(1, (a - A.alongNorm) / ((B.alongNorm - A.alongNorm) || 1)));
    const hw = (A.halfWidth + (B.halfWidth - A.halfWidth) * u) * sc;
    let d = (A.draft + (B.draft - A.draft) * u) * sy;
    if (physics.draftOverride > 0) d *= physics.draftOverride / Math.max(1e-3, worldShipDraftAuto());
    // レバーで沈めた・浮かせた分は船の全長で同じだけ（水面より上の所は 0 のまま）
    if (lever && d > 0) d = Math.max(0, d + lever);
    return { hw, d };
}
// ── 船体の外形の半幅（模型の頂点から）──
// 輪切り（hullProfile.slices）の幅は喫水線のあたりの外板だけを測るので、張り出した砲郭・スポンソン・
// 上へ行くほど広がる舷（フレア）などは入らない。岸壁に付ける間隔やタグ・岸壁との当たりには、
// 船底から水面の上 6m までで、いちばん張り出した所を使う（それより上のマスト・ヤードは除く）。
// 前後に 64 区切りで、模型が変わったら測り直す。戻り値は模型の座標（×physics.scale でメートル）
const _hullExt = { key: '', bins: null, z0: 0, dz: 1, checkT: -1e9 };
function worldHullExtentAt(zLocal) {
    const hp = window.hullProfile;
    if (!hp || !hp.ready || typeof importedModelGroup === 'undefined' || !importedModelGroup || typeof shipGroup === 'undefined' || !shipGroup) return 0;
    const now = performance.now();
    if (now - _hullExt.checkT > 1000 || !_hullExt.key) { _hullExt.checkT = now; _hullExtCheck(hp); }
    const B = _hullExt.bins; if (!B) return 0;
    // 隣の区切りも見る（区切りの境目で細くならないように）
    const k = Math.floor((zLocal - _hullExt.z0) / _hullExt.dz);
    let w = 0; for (let j = k - 1; j <= k + 1; j++) if (j >= 0 && j < B.length) w = Math.max(w, B[j]);
    return w;
}
function _hullExtCheck(hp) {
    const m0 = importedModelGroup.children[0];
    const key = [importedModelGroup.uuid, m0 ? m0.uuid : '', hp.halfLen, hp.designWaterlineY, hp.keelY, physics.scale,
        m0 ? m0.position.toArray().concat(m0.rotation.toArray().slice(0, 3), m0.scale.toArray()).map(v => Math.round(v * 1e4)).join(',') : ''].join('|');
    if (key !== _hullExt.key) {
        _hullExt.key = key; _hullExt.bins = null;
        shipGroup.updateMatrixWorld(true);
        const inv = new THREE.Matrix4().copy(shipGroup.matrixWorld).invert(), M = new THREE.Matrix4(), v = new THREE.Vector3();
        const sc = physics.scale || 1, yLo = (hp.keelY || 0) - 2 / sc, yHi = (hp.designWaterlineY || 0) + 6 / sc;
        const N = 64, z0 = -hp.halfLen * 1.15, dz = hp.halfLen * 2.3 / N, bins = new Float32Array(N);
        let any = false;
        importedModelGroup.traverse(o => {
            if (!o.isMesh || !o.geometry || !o.geometry.attributes.position || !o.visible) return;
            const P = o.geometry.attributes.position;
            M.multiplyMatrices(inv, o.matrixWorld);
            for (let i = 0; i < P.count; i++) {
                v.fromBufferAttribute(P, i).applyMatrix4(M);
                if (v.y < yLo || v.y > yHi) continue;
                const k = Math.floor((v.z - z0) / dz); if (k < 0 || k >= N) continue;
                const x = Math.abs(v.x); if (x > bins[k]) { bins[k] = x; any = true; }
            }
        });
        if (any) { _hullExt.bins = bins; _hullExt.z0 = z0; _hullExt.dz = dz; }
    }
}
window.worldHullExtentAt = worldHullExtentAt;
function setShipDraft(v) {
    physics.draftOverride = Math.max(0, parseFloat(v) || 0);
    _draftAutoLabel();
}
// 「0 ＝ 模型から自動（x m）」の横に、レバーを足した今の喫水も出す
function _draftAutoLabel() {
    const el = document.getElementById('draft-auto'); if (!el) return;
    const lv = worldShipDraftLever();
    el.textContent = `0 ＝ 模型から自動（${worldShipDraftAuto().toFixed(1)} m）` +
        (Math.abs(lv) >= 0.05 ? `／レバー ${lv > 0 ? '+' : ''}${lv.toFixed(2)} m で今の喫水 ${worldShipDraft().toFixed(1)} m` : '');
}
Object.assign(window, { worldShipDraft, worldShipDraftBase, worldShipDraftLever, worldShipDraftAuto, worldHullAt, setShipDraft });
setInterval(() => { const p = document.getElementById('settings-panel'); if (p && p.classList.contains('open')) _draftAutoLabel(); }, 2000);

// 港から出航する：港の前の泊地に、海の方を向けて置く。
// 船が深すぎて港に入れないときは、足りる深さの所まで沖へ出して置く。
function worldStartAtPort(port) {
    const T = PORT_TYPES[port.type];
    const F = _worldFrame(port.lat, port.lon);
    const br = port.seaBearing * Math.PI / 180;
    const unitAt = (d) => {
        const a = Math.sin(br) * d / WORLD_R, b = Math.cos(br) * d / WORLD_R;
        const x = F.C.x + a * F.E.x + b * F.N.x, y = F.C.y + a * F.E.y + b * F.N.y, z = F.C.z + a * F.E.z + b * F.N.z, l = Math.hypot(x, y, z);
        return { x: x / l, y: y / l, z: z / l };
    };
    const need = worldShipDraft() + 3;
    const hp = window.hullProfile;
    const halfLen = ((hp && hp.ready) ? hp.halfLen : 6) * (physics.scale || 1) * 1.1 + 10;
    const mouth = T.basin * 0.76;                     // 防波堤の出入り口
    let off = { fishing: 150, town: 220, city: 360, cargo: 420, naval: 350, passenger: 420 }[port.type] || 250;
    // 泊地に収まらない（長すぎる・深すぎる）船は、港の外の、船の端から端まで深さが足りる所へ
    if (need > T.depth + 1 || off - halfLen < T.pier || off + halfLen > mouth) {
        const depthAt = (d) => {
            const u = unitAt(d), nat = -worldHeightAt(u.x, u.y, u.z, 16);
            // 航路（44-world-terrain.js の _portAdjust）の中は掘ってある
            return d < T.basin + worldPortChannelLen(port) - 400 ? Math.max(nat, T.depth + 2) : nat;
        };
        for (let d = mouth + halfLen + 60; d < 15000; d += 100) {
            off = d;
            if (depthAt(d - halfLen) > need && depthAt(d) > need && depthAt(d + halfLen) > need && (() => { const u = unitAt(d); return worldShoalFree(u.x, u.y, u.z); })()) break;
        }
    }
    let ll = worldUnitToLatLon(unitAt(off)), hdgC = port.seaBearing;
    // 現実世界の港：まっすぐ沖は陸のこともあるので、掘った航路の上の、深さが足りる所に置く（航路の沖向き）
    const fw = port.real && port.fairway ? port.fairway.pts : null;
    if (fw && (need > T.depth + 1 || off - halfLen < T.pier || off + halfLen > mouth)) {
        const deepOK = (q) => -worldHeightAt(...Object.values(worldLatLonToUnit(q.lat, q.lon)), 16) > need;
        let k = fw.findIndex((q, i) => i >= 1 && deepOK(q));
        if (k < 0) k = fw.length - 1;
        const nx = fw[Math.min(fw.length - 1, k + 1)], pv = fw[Math.max(0, k - 1)];
        ll = { lat: fw[k].lat, lon: fw[k].lon };
        const dE = (nx.lon - pv.lon) * Math.cos(fw[k].lat * Math.PI / 180), dN = nx.lat - pv.lat;
        if (Math.hypot(dE, dN) > 1e-9) hdgC = (Math.atan2(dE, dN) * 180 / Math.PI + 360) % 360;
    }
    world.mode = 'world';
    world.ref = { lat: ll.lat, lon: ll.lon };
    _wFrameCache = null;
    physics.cgWorldX = 0; physics.cgWorldZ = 0;
    physics.heading = worldHeadingFromCompass(hdgC);
    physics.speed = 0; physics.targetSpeed = 0; physics.turnRate = 0;
    physics.telegraphState = 0;
    // 岸壁に横付けできる港なら、岸壁に着岸した状態から始める（もやい綱も取る。出港はタグで離岸）
    if (typeof harborBerthPlan === 'function') {
        const plan = harborBerthPlan(port, physics.heading);
        if (plan.ok) {
            physics.cgWorldX = plan.berth.x; physics.cgWorldZ = plan.berth.z; physics.heading = plan.berth.h;
            if (typeof harborAuto !== 'undefined') { harborAuto.pendingLines = plan; harborAuto.pendingT = 0; }
        }
    }
    if (typeof shipHistory !== 'undefined') shipHistory.length = 0;
    window.lastShipPos = null;
    _worldSave();
    if (typeof worldTerrainModeChanged === 'function') worldTerrainModeChanged(true);
    worldMapRedraw();
}
window.worldStartAtPort = worldStartAtPort;

// ════════════════════════════════════════════════════════════════
//  世界地図（画面いっぱいのパネル）
// ════════════════════════════════════════════════════════════════
//  正距円筒図法（横＝経度、縦＝緯度）。ドラッグで動かし、ピンチ・ボタンで拡大。
//  全体の絵は1回だけ作って覚えておき、拡大したときは見えている範囲だけ細かく作り直す。
const _wm = { open: false, cx: 0, cy: 10, zoom: 1, base: null, detail: null, detailKey: '', sel: null, drag: null, pinch: null, job: 0 };
const WM_BASE_W = 720, WM_BASE_H = 360;

function _wmColor(h) {
    if (h < 0) {
        const d = Math.min(1, -h / 2500);
        if (h > -25) return [96, 170, 196];                   // 浅瀬
        if (h > -160) return [62, 138, 182];                  // 大陸棚
        return [Math.round(20 + 40 * (1 - d)), Math.round(60 + 70 * (1 - d)), Math.round(110 + 60 * (1 - d))];
    }
    if (h < 15) return [214, 200, 150];                       // 砂浜
    if (h < 400) { const k = h / 400; return [Math.round(96 - 30 * k), Math.round(150 - 30 * k), Math.round(80 - 20 * k)]; }
    if (h < 1100) { const k = (h - 400) / 700; return [Math.round(66 + 70 * k), Math.round(120 - 10 * k), Math.round(60 + 20 * k)]; }
    if (h < 1900) return [150, 140, 125];
    return [236, 238, 242];                                   // 雪
}
// 海図の色：陸は黄土色、海は深さの段ごとに青から白へ（浅いほど濃い青）
const WM_CHART_BANDS = [2, 5, 10, 20, 50, 200];              // 等深線[m]
const WM_CHART_COL = [[158, 204, 168], [120, 182, 232], [158, 205, 242], [196, 224, 248], [224, 239, 252], [242, 248, 254], [252, 253, 255]];
function _wmBand(h) {
    if (h >= 0) return -1;
    const d = -h;
    let k = 0;
    while (k < WM_CHART_BANDS.length && d >= WM_CHART_BANDS[k]) k++;
    return k;
}
// 高さの配列 → 絵（rows r0〜r1-1）。海図のときは段の境目に等深線を引く
function _wmPaint(cv, r0, r1) {
    const w = cv.width, H = cv.H, img = cv.img, D = img.data, chart = !!_wm.chart;
    for (let y = r0; y < r1; y++) {
        for (let x = 0; x < w; x++) {
            const k = y * w + x, h = H[k], o = k * 4;
            let c;
            if (h !== h) c = chart ? [205, 205, 200] : [70, 74, 80];       // 地形データの外
            else if (!chart) c = _wmColor(h);
            else {
                const b = _wmBand(h);
                c = b < 0 ? (h > 300 ? [228, 208, 158] : [240, 222, 170]) : WM_CHART_COL[b];
                const bl = x > 0 ? _wmBand(H[k - 1]) : b, bu = y > 0 ? _wmBand(H[k - w]) : b;
                if (bl !== b || bu !== b) {
                    const coast = (b < 0) !== (bl < 0) || (b < 0) !== (bu < 0);
                    c = coast ? [70, 62, 48] : [96, 140, 186];
                }
            }
            D[o] = c[0]; D[o + 1] = c[1]; D[o + 2] = c[2]; D[o + 3] = 255;
        }
    }
    cv.getContext('2d').putImageData(img, 0, 0);
}
// 港へ入る航路の長さ[m]（泊地の端から）。浅瀬の多い海域を抜けて、十分な深さが
// 1.5km 続く所まで伸ばす。途中に本当の陸（島など）があれば、その手前で止める。
function worldPortChannelLen(p) {
    if (p._chLen) return p._chLen;
    if (p.real) return (p._chLen = 400);          // 現実世界の港は、まっすぐの航路の代わりに掘った航路（p.fairway）
    const T = PORT_TYPES[p.type], F = _worldFrame(p.lat, p.lon), br = p.seaBearing * Math.PI / 180;
    const sx = Math.sin(br), sz = Math.cos(br);
    // 浅瀬の出る所（大陸棚で「浅瀬の多い海域」）を抜けて、そうでない所が 1.5km 続くまで伸ばす
    let len = 25000, deepFrom = -1;
    for (let d = 0; d <= 25000; d += 100) {
        const a = T.basin + d;
        const x = F.C.x + (a * sx) / WORLD_R * F.E.x + (a * sz) / WORLD_R * F.N.x;
        const y = F.C.y + (a * sx) / WORLD_R * F.E.y + (a * sz) / WORLD_R * F.N.y;
        const z = F.C.z + (a * sx) / WORLD_R * F.E.z + (a * sz) / WORLD_R * F.N.z;
        const l = Math.hypot(x, y, z), ux = x / l, uy = y / l, uz = z / l;
        const e = worldNoiseE(ux, uy, uz, 16);
        if (e >= 0) { len = Math.max(600, d - 150); break; }          // 島・岬：その手前まで
        // 深くて、しかも浅瀬が出ない所か
        let deep = -worldHeightAt(ux, uy, uz, 16) > T.depth + 6 && worldShoalFree(ux, uy, uz);
        if (deep) deepFrom = deepFrom < 0 ? d : deepFrom; else deepFrom = -1;
        if (deepFrom >= 0 && d - deepFrom >= 1500) { len = Math.max(1200, deepFrom + 400); break; }
    }
    p._chLen = len;
    return len;
}
window.worldPortChannelLen = worldPortChannelLen;
// 港の手直し（泊地・航路の浚渫、44-world-terrain.js の _portAdjust）を地図にも入れるための、
// 港それぞれの面（港の点に接する面）での形
function _wmPortShapes(lon0, lon1, lat0, lat1) {
    if (!world.ports || typeof _portAdjust !== 'function') return [];
    const out = [];
    const cl = worldLatLonToUnit((lat0 + lat1) / 2, (lon0 + lon1) / 2);
    const rad = worldDistance(lat0, lon0, lat1, lon1) / 2 + 8000;
    for (const p of world.ports) {
        const d = Math.acos(Math.max(-1, Math.min(1, cl.x * p.u.x + cl.y * p.u.y + cl.z * p.u.z))) * WORLD_R;
        if (d > rad) continue;
        const T = PORT_TYPES[p.type], br = p.seaBearing * Math.PI / 180;
        const quayLen = T.quay;
        out.push({ F: _worldFrame(p.lat, p.lon), S: [{ x: 0, z: 0, sx: Math.sin(br), sz: Math.cos(br), quayLen, apron: 0, basin: T.basin, depth: T.depth, chLen: worldPortChannelLen(p) }] });
    }
    return out;
}
function _wmApplyPorts(ps, u, h) {
    for (const q of ps) {
        const F = q.F;
        const dot = u.x * F.C.x + u.y * F.C.y + u.z * F.C.z;
        if (dot < 0.999998) continue;                      // 約9km より遠い
        const x = WORLD_R * (u.x * F.E.x + u.y * F.E.y + u.z * F.E.z) / dot;
        const z = WORLD_R * (u.x * F.N.x + u.y * F.N.y + u.z * F.N.z) / dot;
        if (h < 0 || x * q.S[0].sx + z * q.S[0].sz > 0) h = _portAdjust(h, x, z, q.S);   // 陸（岸壁の後ろ）はそのまま
    }
    return h;
}
// 緯度・経度の範囲を絵にする（少しずつ。終わったら done(canvas)）
function _wmRender(w, h, lon0, lon1, lat0, lat1, oct, done) {
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    cv.img = cv.getContext('2d').createImageData(w, h);
    cv.H = new Float32Array(w * h);
    cv.rows = 0;
    cv.ext = { lon0, lon1, lat0, lat1 };
    const job = ++_wm.job;
    let row = 0;
    const u = {};
    const ports = oct >= 12 ? _wmPortShapes(lon0, lon1, lat0, lat1) : [];
    cv.ports = ports;
    const step = () => {
        if (job !== _wm.job && oct !== WORLD_OCT_MAP - 2) return;   // 新しい作り直しが始まった（全体図は止めない）
        const t0 = performance.now(), r0 = row;
        while (row < h && performance.now() - t0 < 12) {
            const lat = lat1 - (row + 0.5) / h * (lat1 - lat0);
            for (let x = 0; x < w; x++) {
                const lon = lon0 + (x + 0.5) / w * (lon1 - lon0);
                worldLatLonToUnit(lat, lon, u);
                // 現実世界の地形データの外は NaN（灰色で塗る）
                let hh = (_RW && !_rwInside(lat, ((lon + 540) % 360) - 180)) ? NaN : worldHeightAt(u.x, u.y, u.z, oct);
                if (ports.length && hh === hh) hh = _wmApplyPorts(ports, u, hh);
                cv.H[row * w + x] = hh;
            }
            row++;
        }
        cv.rows = row;
        _wmPaint(cv, r0, row);
        if (row < h) { setTimeout(step, 0); if ((row & 15) === 0 || row - r0 > 15) done(cv, false); return; }
        done(cv, true);
    };
    step();
}
// 海図と地形図を切り替える（作った高さはそのまま使って塗り直す）
function worldMapSetChart(on) {
    _wm.chart = !!on;
    try { localStorage.setItem('susuru_wm_chart', _wm.chart ? '1' : '0'); } catch (e) { /* ignore */ }
    for (const cv of [_wm.base || _wm.basePartial, _wm.detail]) if (cv && cv.H) _wmPaint(cv, 0, cv.rows);
    const b = document.getElementById('wp-chart'); if (b) b.classList.toggle('on', _wm.chart);
    worldMapRedraw(true);
}
window.worldMapSetChart = worldMapSetChart;
try { _wm.chart = localStorage.getItem('susuru_wm_chart') === '1'; } catch (e) { /* ignore */ }

function _wmEnsureDom() {
    if (document.getElementById('world-panel')) return;
    const el = document.createElement('div');
    el.id = 'world-panel';
    el.innerHTML = `
        <div class="wp-head">
            <span class="wp-title">🗺 世界地図</span>
            <span class="wp-modes">
                <button id="wp-mode-ocean" onclick="worldSetMode('ocean')">🌊 海だけ</button>
                <button id="wp-mode-world" onclick="worldSetMode('world')">🌍 世界を航海</button>
                <button id="wp-mode-real" onclick="worldSetKind('real', 'britain')" title="実際の地形（NOAA ETOPO 2022）と実在の港">🇬🇧 実在：ブリテン諸島</button>
            </span>
            <button id="wp-chart" class="wp-chartbtn" onclick="worldMapSetChart(!_wm.chart)">📘 海図</button>
            <button id="wp-minimap" class="wp-chartbtn wp-mmbtn" onclick="minimapShow(!_mm.show)" title="右上の小さな地図">◉ ミニ地図</button>
            <button class="wp-close" onclick="toggleWorldMap(false)">✕</button>
        </div>
        <div class="wp-body">
            <canvas id="wp-canvas"></canvas>
            <div class="wp-tools">
                <button onclick="_wmZoomBy(1.6)">＋</button>
                <button onclick="_wmZoomBy(1/1.6)">－</button>
                <button onclick="_wmCenterShip()" title="今の場所へ">◎</button>
            </div>
            <div class="wp-legend"></div>
            <div id="wp-info"></div>
            <div id="wp-status"></div>
        </div>`;
    document.body.appendChild(el);
    const lg = el.querySelector('.wp-legend');
    lg.innerHTML = Object.values(PORT_TYPES).map(t => `<span><i style="background:${t.color}"></i>${t.label}</span>`).join('');
    const cv = el.querySelector('#wp-canvas');
    const pos = (e) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const pts = new Map();
    cv.addEventListener('pointerdown', (e) => {
        cv.setPointerCapture(e.pointerId);
        pts.set(e.pointerId, pos(e));
        if (pts.size === 1) _wm.drag = { p: pos(e), cx: _wm.cx, cy: _wm.cy, moved: false };
        if (pts.size === 2) { const [a, b] = [...pts.values()]; _wm.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: _wm.zoom }; _wm.drag = null; }
    });
    cv.addEventListener('pointermove', (e) => {
        if (!pts.has(e.pointerId)) return;
        pts.set(e.pointerId, pos(e));
        if (_wm.pinch && pts.size >= 2) {
            const [a, b] = [...pts.values()];
            _wmSetZoom(_wm.pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, _wm.pinch.d));
        } else if (_wm.drag) {
            const p = pos(e), dpd = _wmDegPerPx();
            const dx = p.x - _wm.drag.p.x, dy = p.y - _wm.drag.p.y;
            if (Math.abs(dx) + Math.abs(dy) > 4) _wm.drag.moved = true;
            _wm.cx = _wm.drag.cx - dx * dpd;
            _wm.cy = Math.max(-80, Math.min(80, _wm.drag.cy + dy * dpd));
            worldMapRedraw(true);
        }
    });
    const up = (e) => {
        const wasDrag = _wm.drag;
        pts.delete(e.pointerId);
        if (pts.size < 2) _wm.pinch = null;
        if (pts.size === 0) {
            _wm.drag = null;
            if (wasDrag && !wasDrag.moved) _wmTap(pos(e));
            worldMapRedraw();
        }
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('wheel', (e) => { e.preventDefault(); _wmZoomBy(e.deltaY < 0 ? 1.25 : 0.8); }, { passive: false });
    window.addEventListener('resize', () => { if (_wm.open) worldMapRedraw(); });
}
function _wmDegPerPx() {
    const cv = document.getElementById('wp-canvas');
    return 360 / Math.max(1, cv.clientWidth) / _wm.zoom;
}
function _wmSetZoom(z) { _wm.zoom = Math.max(1, Math.min(400, z)); worldMapRedraw(true); }
function _wmZoomBy(k) { _wmSetZoom(_wm.zoom * k); clearTimeout(_wm._t); _wm._t = setTimeout(() => worldMapRedraw(), 200); }
window._wmZoomBy = _wmZoomBy;
function _wmCenterShip() {
    if (world.mode === 'world') { const ll = worldShipLatLon(); _wm.cx = ll.lon; _wm.cy = ll.lat; if (_wm.zoom < 30) _wm.zoom = 30; }
    worldMapRedraw();
}
window._wmCenterShip = _wmCenterShip;
// 画面の点 ↔ 緯度・経度
function _wmToScreen(lat, lon, cv) {
    const dpd = _wmDegPerPx();
    let dl = lon - _wm.cx; dl = ((dl + 540) % 360) - 180;
    return { x: cv.clientWidth / 2 + dl / dpd, y: cv.clientHeight / 2 - (lat - _wm.cy) / dpd };
}
function _wmTap(p) {
    const cv = document.getElementById('wp-canvas');
    const groups = worldPortGroups();
    let best = null, bd = 22;
    for (const q of groups) {
        const s = _wmToScreen(q.lat, q.lon, cv);
        const d = Math.hypot(s.x - p.x, s.y - p.y);
        if (d < bd) { bd = d; best = q; }
    }
    _wm.sel = best;
    // 港でない所：その海域を選ぶ（自動航行の行き先にできる）
    _wm.selPt = null;
    if (!best) {
        const dpd = _wmDegPerPx();
        const lat = _wm.cy - (p.y - cv.clientHeight / 2) * dpd;
        const lon = ((_wm.cx + (p.x - cv.clientWidth / 2) * dpd) + 540) % 360 - 180;
        if (Math.abs(lat) < 80) _wm.selPt = { lat, lon };
    }
    _wmShowInfo();
    worldMapRedraw(true);
}
function _wmShowInfo() {
    const el = document.getElementById('wp-info');
    if (!el) return;
    const G = _wm.sel;
    if (!G && _wm.selPt) { _wmShowPointInfo(el, _wm.selPt); return; }
    if (!G) { el.style.display = 'none'; return; }
    const ll = world.mode === 'world' ? worldShipLatLon() : null;
    const distOf = (p) => {
        if (!ll) return '';
        let t = `今の場所から ${(worldDistance(ll.lat, ll.lon, p.lat, p.lon) / 1852).toFixed(0)} 海里`;
        if (typeof rhumbCourse === 'function') { const rc = rhumbCourse(ll.lat, ll.lon, p.lat, p.lon); t += `（航程線の針路 ${Math.round(rc.course).toString().padStart(3, '0')}°）`; }
        return t;
    };
    const btns = (p) => `${(ll && typeof autopilotStart === 'function') ? `<button onclick="autopilotStart(world.ports.find(q => q.id === '${p.id}'))">🧭 ここへ自動航行</button>` : ''}<button onclick="worldStartAtPort(world.ports.find(q => q.id === '${p.id}')); toggleWorldMap(false);">⚓ ここから出航</button>`;
    const T = PORT_TYPES[G.type];
    el.style.display = 'block';
    if (G.ports.length === 1) {
        const p = G.ports[0];
        el.innerHTML = `<div class="wp-pname"><i style="background:${PORT_TYPES[p.type].color}"></i>${p.name}</div>
            <div class="wp-pmeta">${PORT_TYPES[p.type].label}・${worldFmtLatLon(p.lat, p.lon)}　${distOf(p)}</div>
            <div class="wp-pbtns">${btns(p)}<button onclick="_wm.sel=null;_wmShowInfo();worldMapRedraw(true)">閉じる</button></div>`;
        return;
    }
    // 埠頭が複数：埠頭を選ぶ
    el.innerHTML = `<div class="wp-pname"><i style="background:${T.color}"></i>${G.name}</div>
        <div class="wp-pmeta">埠頭 ${G.ports.length} か所・${worldFmtLatLon(G.lat, G.lon)}　${distOf(G)}</div>
        <div class="wp-berths">${G.ports.map(p => `<div class="wp-berth"><div class="wp-bname"><i style="background:${PORT_TYPES[p.type].color}"></i>${worldBerthLabel(p)}<span class="wp-btype">${typeof shipTypeSuits === 'function' && shipTypeSuits(p.type) ? '<b class="wp-suit" title="この船に合う埠頭">★</b>' : ''}${PORT_TYPES[p.type].label}</span></div>
            <div class="wp-pbtns">${btns(p)}</div></div>`).join('')}</div>
        <div class="wp-pbtns"><button onclick="_wm.sel=null;_wmShowInfo();worldMapRedraw(true)">閉じる</button></div>`;
}
window._wmShowInfo = _wmShowInfo;
// 選んだ海域の説明（水深・距離・針路）と「ここへ自動航行」
function _wmShowPointInfo(el, q) {
    const u = worldLatLonToUnit(q.lat, q.lon);
    const h = worldHeightAt(u.x, u.y, u.z, 16);
    const land = h >= 0;
    let dist = '', apBtn = '';
    if (world.mode === 'world') {
        const ll = worldShipLatLon();
        if (typeof rhumbCourse === 'function') {
            const rc = rhumbCourse(ll.lat, ll.lon, q.lat, q.lon);
            dist = `<br>今の場所から ${(rc.dist / 1852).toFixed(rc.dist < 18520 ? 1 : 0)} 海里（航程線の針路 ${Math.round(rc.course).toString().padStart(3, '0')}°）`;
        }
        if (typeof autopilotStartPoint === 'function') apBtn = `<button onclick="autopilotStartPoint(${q.lat}, ${q.lon})">🧭 ここへ自動航行</button>`;
    }
    const shoal = !land && !worldShoalFree(u.x, u.y, u.z) ? '・浅瀬の多い海域' : '';
    el.style.display = 'block';
    el.innerHTML = `<div class="wp-pname">📍 ${land ? '陸地' : '海域'}</div>
        <div class="wp-pmeta">${worldFmtLatLon(q.lat, q.lon)}・${land ? `標高 約 ${Math.round(h)}m（近くの海で止まります）` : `水深 約 ${Math.round(-h)}m${shoal}`}${dist}</div>
        <div class="wp-pbtns">${apBtn}<button onclick="_wm.selPt=null;_wmShowInfo();worldMapRedraw(true)">閉じる</button></div>`;
}
window._wm = _wm;

// 描き直す（quick：細かい絵を作り直さない＝ドラッグ中）
function worldMapRedraw(quick) {
    if (!_wm.open) return;
    const cv = document.getElementById('wp-canvas');
    if (!cv) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = cv.clientWidth, H = cv.clientHeight;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = _wm.chart ? '#e4edf5' : '#0d2a44'; g.fillRect(0, 0, W, H);
    const chartBtn = document.getElementById('wp-chart'); if (chartBtn) chartBtn.classList.toggle('on', !!_wm.chart);
    const mmBtn = document.getElementById('wp-minimap'); if (mmBtn && typeof _mm !== 'undefined') mmBtn.classList.toggle('on', !!_mm.show);
    document.getElementById('wp-mode-ocean').classList.toggle('on', world.mode === 'ocean');
    document.getElementById('wp-mode-world').classList.toggle('on', world.mode === 'world' && world.kind !== 'real');
    const rb = document.getElementById('wp-mode-real'); if (rb) rb.classList.toggle('on', world.mode === 'world' && world.kind === 'real');
    const st = document.getElementById('wp-status');
    // 全体の絵
    if (!_wm.base) {
        if (!_wm.baseBusy) {
            _wm.baseBusy = true;
            if (st) st.textContent = '地図を作っています…';
            _wmRender(WM_BASE_W, WM_BASE_H, -180, 180, -90, 90, WORLD_OCT_MAP - 2, (c, fin) => { _wm.basePartial = c; if (fin) { _wm.base = c; _wm.baseBusy = false; if (st) st.textContent = ''; } worldMapRedraw(true); });
        }
    }
    const baseImg = _wm.base || _wm.basePartial;
    const dpd = _wmDegPerPx();
    if (baseImg) {
        g.imageSmoothingEnabled = _wm.zoom < 6;
        // 経度方向は繰り返し描く
        const pxPerDeg = 1 / dpd;
        const top = H / 2 - (90 - _wm.cy) * pxPerDeg;
        const wWorld = 360 * pxPerDeg;
        let left = W / 2 - (_wm.cx + 180) * pxPerDeg;
        left = ((left % wWorld) + wWorld) % wWorld - wWorld;
        for (let x = left; x < W; x += wWorld) g.drawImage(baseImg, x, top, wWorld, 180 * pxPerDeg);
    }
    // 拡大したときは、見えている範囲を細かく作り直す
    if (_wm.zoom >= 4) {
        const lon0 = _wm.cx - W / 2 * dpd, lon1 = _wm.cx + W / 2 * dpd;
        const lat1 = Math.min(90, _wm.cy + H / 2 * dpd), lat0 = Math.max(-90, _wm.cy - H / 2 * dpd);
        const key = [lon0, lon1, lat0, lat1].map(v => v.toFixed(3)).join(',');
        if (_wm.detail && _wm.detailKey === key) {
            g.imageSmoothingEnabled = true;
            const s = _wmToScreen(lat1, lon0, cv);
            g.drawImage(_wm.detail, s.x, s.y, (lon1 - lon0) / dpd, (lat1 - lat0) / dpd);
        } else if (!quick) {
            const oct = Math.min(16, WORLD_OCT_MAP + Math.round(Math.log2(_wm.zoom)));
            const rw = Math.min(480, Math.round(W / 2)), rh = Math.round(rw * H / W);
            _wm.detailKey = key; _wm.detail = null;
            _wmRender(rw, rh, lon0, lon1, lat0, lat1, oct, (c, fin) => { if (_wm.detailKey === key) { _wm.detail = c; worldMapRedraw(true); } });
        }
    }
    // 海図：水深の数字（拡大したとき。細かい絵の高さから拾う）
    if (_wm.chart && _wm.zoom >= 24 && _wm.detail && _wm.detail.H && _wm.detail.rows === _wm.detail.height) {
        const Dt = _wm.detail, E = Dt.ext, dw = Dt.width, dh = Dt.height;
        g.font = 'italic 10px serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
        const GAP = 46;
        for (let sy = GAP / 2; sy < H; sy += GAP) {
            for (let sx = GAP / 2 + ((sy / GAP) & 1) * GAP / 2; sx < W; sx += GAP) {
                const lon = _wm.cx + (sx - W / 2) * dpd, lat = _wm.cy - (sy - H / 2) * dpd;
                const ix = Math.floor((lon - E.lon0) / (E.lon1 - E.lon0) * dw), iy = Math.floor((E.lat1 - lat) / (E.lat1 - E.lat0) * dh);
                if (ix < 0 || iy < 0 || ix >= dw || iy >= dh) continue;
                const h = Dt.H[iy * dw + ix];
                if (h >= -0.5) continue;
                const d = -h;
                g.fillStyle = d < 10 ? '#1b3552' : '#4d6780';
                g.fillText(d < 20 ? d.toFixed(0) : String(Math.round(d / 5) * 5), sx, sy);
            }
        }
        g.textAlign = 'start';
    }
    // 海図：港へ入る航路（浚渫してある所）を破線で。ここを外れると浅瀬があるかもしれない
    if (_wm.chart && _wm.zoom >= 24 && world.ports) {
        g.save();
        g.strokeStyle = 'rgba(190, 40, 150, 0.85)'; g.lineWidth = 1.4; g.setLineDash([6, 4]);
        for (const p of world.ports) {
            // 現実世界の港：掘った航路（曲がっている）を 1 本の破線で
            if (p.real && p.fairway) {
                g.beginPath();
                p.fairway.pts.forEach((q, k) => { const sq = _wmToScreen(q.lat, q.lon, cv); if (k === 0) g.moveTo(sq.x, sq.y); else g.lineTo(sq.x, sq.y); });
                g.stroke();
                continue;
            }
            const s0 = _wmToScreen(p.lat, p.lon, cv);
            if (s0.x < -400 || s0.x > W + 400 || s0.y < -400 || s0.y > H + 400) continue;
            const T = PORT_TYPES[p.type], F = _worldFrame(p.lat, p.lon), br = p.seaBearing * Math.PI / 180;
            const sx = Math.sin(br), sz = Math.cos(br);
            const toS = (a, b) => {
                const x = a * sx + b * sz, z = a * sz - b * sx;          // 港の a（沖へ）・b（岸沿い）→ 東・北
                const ux = F.C.x + x / WORLD_R * F.E.x + z / WORLD_R * F.N.x, uy = F.C.y + x / WORLD_R * F.E.y + z / WORLD_R * F.N.y, uz = F.C.z + x / WORLD_R * F.E.z + z / WORLD_R * F.N.z;
                const l = Math.hypot(ux, uy, uz), ll = worldUnitToLatLon({ x: ux / l, y: uy / l, z: uz / l });
                return _wmToScreen(ll.lat, ll.lon, cv);
            };
            for (const side of [-1, 1]) {
                g.beginPath();
                const aEnd = T.basin + worldPortChannelLen(p) - 300;
                for (let a = T.basin * 0.76; a <= aEnd; a += 200) {
                    const ch = Math.max(90, T.quay / 4) + Math.max(0, a - T.basin) * 0.06;
                    const q = toS(a, side * ch);
                    if (a === T.basin * 0.76) g.moveTo(q.x, q.y); else g.lineTo(q.x, q.y);
                }
                g.stroke();
            }
        }
        g.restore();
    }
    // 緯線・経線
    g.strokeStyle = _wm.chart ? 'rgba(40,80,130,0.22)' : 'rgba(255,255,255,0.12)'; g.lineWidth = 1;
    const gridStep = _wm.zoom < 3 ? 30 : _wm.zoom < 12 ? 10 : _wm.zoom < 60 ? 2 : 0.5;
    for (let lat = -90; lat <= 90; lat += gridStep) { const y = _wmToScreen(lat, _wm.cx, cv).y; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
    const lonStart = Math.floor((_wm.cx - W / 2 * dpd) / gridStep) * gridStep;
    for (let lon = lonStart; lon <= _wm.cx + W / 2 * dpd; lon += gridStep) { const x = W / 2 + (lon - _wm.cx) / dpd; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
    // 港
    const ports = world.ports ? worldPortGroups() : null;
    if (ports) {
        g.font = '11px sans-serif'; g.textBaseline = 'middle';
        for (const p of ports) {
            const s = _wmToScreen(p.lat, p.lon, cv);
            if (s.x < -20 || s.x > W + 20 || s.y < -20 || s.y > H + 20) continue;
            const T = PORT_TYPES[p.type];
            const r = 2.5 + T.size * 1.2 + (p === _wm.sel ? 3 : 0);
            g.fillStyle = T.color; g.strokeStyle = '#0a1932'; g.lineWidth = 1.5;
            g.beginPath(); g.arc(s.x, s.y, r, 0, Math.PI * 2); g.fill(); g.stroke();
            // 大きく拡大したら、まとまった港の埠頭も小さな点で
            if (p.ports.length > 1 && _wm.zoom >= 60) {
                for (const q of p.ports) {
                    const sq = _wmToScreen(q.lat, q.lon, cv);
                    g.fillStyle = PORT_TYPES[q.type].color; g.strokeStyle = '#0a1932'; g.lineWidth = 1;
                    g.beginPath(); g.arc(sq.x, sq.y, 2.5, 0, Math.PI * 2); g.fill(); g.stroke();
                    if (_wm.zoom >= 200) { g.fillStyle = _wm.chart ? '#16283c' : '#fff'; g.fillText(worldBerthLabel(q), sq.x + 5, sq.y); }
                }
            }
            if (_wm.zoom >= 4 || T.size >= 3 || p === _wm.sel) {
                if (_wm.chart) {
                    g.lineWidth = 3; g.strokeStyle = 'rgba(255,255,255,0.85)'; g.strokeText(p.name, s.x + r + 3, s.y);
                    g.fillStyle = '#16283c'; g.fillText(p.name, s.x + r + 3, s.y);
                } else {
                    g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillText(p.name, s.x + r + 3.5, s.y + 1);
                    g.fillStyle = '#ffffff'; g.fillText(p.name, s.x + r + 3, s.y);
                }
            }
        }
    } else if (!_wm.portsBusy) {
        _wm.portsBusy = true;
        setTimeout(() => { worldBuildPorts(); _wm.portsBusy = false; worldMapRedraw(true); }, 30);
    }
    // 自動航行の航路（49-autopilot.js）
    const rp = (typeof autopilotRoutePoints === 'function') ? autopilotRoutePoints() : null;
    if (rp && rp.length > 1) {
        g.save();
        g.strokeStyle = _wm.chart ? '#c0208a' : '#ff5ad0'; g.lineWidth = 2; g.setLineDash([]);
        g.beginPath();
        let prevX = null;
        rp.forEach((q, i) => {
            const s = _wmToScreen(q.lat, q.lon, cv);
            // 経度 ±180 をまたぐ所は線を切る
            if (i === 0 || (prevX !== null && Math.abs(s.x - prevX) > W / 2)) g.moveTo(s.x, s.y); else g.lineTo(s.x, s.y);
            prevX = s.x;
        });
        g.stroke();
        // タグの付き添いで通る狭い水路（橙の破線）
        if (rp.some(q => q.narrow)) {
            g.strokeStyle = '#ff9f1a'; g.lineWidth = 3; g.setLineDash([5, 3]);
            g.beginPath();
            for (let i = 1; i < rp.length; i++) {
                if (!rp[i].narrow) continue;
                const a = _wmToScreen(rp[i - 1].lat, rp[i - 1].lon, cv), b = _wmToScreen(rp[i].lat, rp[i].lon, cv);
                if (Math.abs(a.x - b.x) > W / 2) continue;
                g.moveTo(a.x, a.y); g.lineTo(b.x, b.y);
            }
            g.stroke(); g.setLineDash([]);
            g.strokeStyle = _wm.chart ? '#c0208a' : '#ff5ad0';
        }
        g.fillStyle = g.strokeStyle;
        for (const q of rp) if (q.wp) { const s = _wmToScreen(q.lat, q.lon, cv); g.beginPath(); g.arc(s.x, s.y, 3, 0, Math.PI * 2); g.fill(); }
        g.restore();
    }
    // 選んだ海域（＋）と、自動航行で向かっている海域（旗）
    const mark = (q, flag) => {
        const s = _wmToScreen(q.lat, q.lon, cv);
        g.save(); g.translate(s.x, s.y);
        g.strokeStyle = _wm.chart ? '#c0208a' : '#ff5ad0'; g.fillStyle = g.strokeStyle; g.lineWidth = 2;
        if (flag) { g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -16); g.stroke(); g.beginPath(); g.moveTo(0, -16); g.lineTo(10, -12); g.lineTo(0, -8); g.closePath(); g.fill(); }
        else { g.beginPath(); g.arc(0, 0, 7, 0, Math.PI * 2); g.moveTo(-11, 0); g.lineTo(11, 0); g.moveTo(0, -11); g.lineTo(0, 11); g.stroke(); }
        g.restore();
    };
    if (_wm.selPt) mark(_wm.selPt, false);
    if (typeof autopilot !== 'undefined' && autopilot.dest && autopilot.dest.point && (autopilot.active || autopilot.planning)) mark(autopilot.dest, true);
    // 船
    if (world.mode === 'world') {
        const ll = worldShipLatLon();
        const s = _wmToScreen(ll.lat, ll.lon, cv);
        g.save(); g.translate(s.x, s.y); g.rotate((typeof worldTrueCompass === 'function' ? worldTrueCompass() : worldCompass(physics.heading)) * Math.PI / 180);
        g.fillStyle = '#ffffff'; g.strokeStyle = '#ff3b30'; g.lineWidth = 2;
        g.beginPath(); g.moveTo(0, -11); g.lineTo(7, 8); g.lineTo(0, 4); g.lineTo(-7, 8); g.closePath(); g.fill(); g.stroke();
        g.restore();
    }
    if (st && _wm.base && world.mode === 'ocean') st.textContent = '「海だけ」モード中：港を選んで「この港から出航」すると、世界を航海するモードになります';
    else if (st && _wm.base) st.textContent = world.kind === 'real' ? `実在：${REAL_WORLDS[world.realKey].name}　地形：NOAA ETOPO 2022（航路は港ごとに掘ってあります）` : '';
}
window.worldMapRedraw = worldMapRedraw;

function toggleWorldMap(open) {
    _wmEnsureDom();
    _wm.open = (typeof open === 'boolean') ? open : !_wm.open;
    document.getElementById('world-panel').classList.toggle('open', _wm.open);
    if (_wm.open) {
        if (world.mode === 'world' && !_wm._centered) { const ll = worldShipLatLon(); _wm.cx = ll.lon; _wm.cy = ll.lat; _wm.zoom = 8; _wm._centered = true; }
        _wmShowInfo();
        setTimeout(() => worldMapRedraw(), 0);
    }
}
window.toggleWorldMap = toggleWorldMap;

// 世界地図を開いている間は、船の位置の印を時々更新する
setInterval(() => { if (_wm.open && world.mode === 'world') worldMapRedraw(true); }, 1000);
// 前回が現実世界なら、ページを読み終えたら地形を読んで続きから
if (world._pendingReal) window.addEventListener('load', () => { setTimeout(worldRestoreReal, 0); });
