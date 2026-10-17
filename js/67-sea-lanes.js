// 67-sea-lanes.js — 実際の航路（外洋・沿岸の決まった道すじ）に沿って航路を引く
// ════════════════════════════════════════════════════════════════
//  遠くへ行くとき（300km より先）は、いちばん短い所を通る道ではなく、実際の船が通る航路の点をたどる：
//   ・イギリス海峡：ドーヴァー海峡 → ビーチー岬沖 → セント・キャサリンズ岬沖 → ポートランド沖 → スタート岬沖 →
//     エディストン沖 → リザード岬沖 → ランズ・エンドとシリー諸島の間（またはビショップ・ロック沖）
//   ・アイルランド南岸（クイーンズタウン沖・ファストネット沖）、セント・ジョージ海峡・アイリッシュ海・ノース海峡
//   ・北大西洋の横断：1898 年の大西洋航路の取り決め（レーン・ルート）。西航と東航で別の道（すれ違わないように）。
//     1 月 15 日〜8 月 23 日は南の航路（氷山を避ける）：西航は北緯 42 度・西経 47 度（「ザ・コーナー」。タイタニックも
//     ここで変針した）、東航は北緯 41 度・西経 47 度を通る。それ以外は北の航路（およそ北緯 46 度・45 度 30 分で西経 49 度）。
//     そこからナンタケット灯船沖へ、またはセーブル島の南からハリファックスへ
//   ・アメリカ東海岸：ナンタケット灯船沖 → アンブローズ灯船沖（ニューヨーク）、グレート・サウス・チャネル → ボストン、
//     デラウェア・チェサピーク湾口・ハッテラス岬沖、バミューダ・バハマ
//  日付は暦（16-daynight-and-telegraph.js）から。航路の点と点の間は大圏（地球の上のいちばん短い線）で、途中が浅ければ
//  その区間だけふつうの探し方（49-autopilot.js の worker）で。港から最初の点・最後の点から港へも、ふつうの探し方で。
//  他の船（59-traffic.js）も、同じ航路を通る（worldPlanRoute を通すので）

const SEA_LANE_NODES = {
    // イギリス海峡（沖の深い所）
    DOVER: [51.02, 1.48, 'ドーヴァー海峡'], BEACHY: [50.58, 0.35, 'ビーチー岬沖'], OWERS: [50.55, -0.70, 'セルシー岬沖'],
    NAB: [50.62, -0.95, 'ナブ灯台沖'], STCATH: [50.46, -1.30, 'セント・キャサリンズ岬沖'], PORTLAND: [50.37, -2.45, 'ポートランド沖'],
    START: [50.10, -3.62, 'スタート岬沖'], EDDY: [50.10, -4.27, 'エディストン沖'], LIZARD: [49.85, -5.20, 'リザード岬沖'],
    WOLF: [50.03, -6.05, 'ランズ・エンド沖（シリー諸島との間）'], BISHOP: [49.80, -6.55, 'ビショップ・ロック沖'],
    CHERB: [49.75, -1.62, 'シェルブール沖'], CASQ: [49.80, -2.55, 'キャスケッツ沖'], HAVRE: [49.52, -0.05, 'ル・アーヴル沖'],
    USHANT: [48.55, -5.55, 'ウェサン島沖'],
    // アイルランド・アイリッシュ海・ノース海峡
    DAUNT: [51.70, -8.25, 'クイーンズタウン沖'], FASTNET: [51.30, -9.62, 'ファストネット沖'],
    SMALLS: [51.72, -5.85, 'スモールズ沖'], TUSKAR: [52.15, -6.05, 'タスカー・ロック沖'], STGEORGE: [52.60, -5.50, 'セント・ジョージ海峡'],
    SKERRIES: [53.45, -4.75, 'スケリーズ沖'], LIVBAR: [53.53, -3.40, 'リヴァプール・バー'], CALF: [53.95, -4.95, 'マン島の南'],
    BELFAST: [54.70, -5.55, 'ベルファスト湾口'], NORTHCH: [55.15, -5.75, 'ノース海峡'], CLYDE: [55.55, -5.05, 'クライド湾口'],
    INISH: [55.55, -7.15, 'イニシュトラハル沖'], TORY: [55.40, -8.40, 'トーリー島沖'],
    // 北大西洋（1898 年の取り決めの航路。北の航路の点はおよそ）
    CORNER_W: [42.0, -47.0, 'ザ・コーナー（北緯42度 西経47度：西航）'], CORNER_E: [41.0, -47.0, '北緯41度 西経47度（東航）'],
    NORTH_W: [46.0, -49.0, '北緯46度 西経49度（北の航路・西航）'], NORTH_E: [45.5, -49.0, '北緯45度30分 西経49度（北の航路・東航）'],
    // カナダ・アメリカ東海岸
    SABLE: [43.40, -60.00, 'セーブル島の南'], HALIFAX: [44.45, -63.47, 'ハリファックス湾口'], CSABLE: [43.20, -65.70, 'セーブル岬沖'],
    NANTUCKET: [40.50, -69.50, 'ナンタケット灯船沖'], GSC: [41.15, -69.15, 'グレート・サウス・チャネル'], BOSTON: [42.37, -70.72, 'ボストン湾口'],
    AMBROSE: [40.45, -73.75, 'アンブローズ灯船沖'], DELAWARE: [38.75, -74.90, 'デラウェア湾口'], CHESA: [36.95, -75.85, 'チェサピーク湾口'],
    HATTERAS: [35.00, -74.85, 'ハッテラス岬沖'], BERMUDA: [32.42, -64.55, 'バミューダ東口'], NEPC: [25.95, -76.95, '北東プロヴィデンス海峡'],
};
// 区間：[a, b, 向き（0 どちらへも・1 a → b だけ）, 季節（'S' 南の航路の季節・'N' 北の航路の季節・無し いつでも）]
const SEA_LANE_EDGES = [
    // イギリス海峡
    ['DOVER', 'BEACHY'], ['BEACHY', 'OWERS'], ['OWERS', 'NAB'], ['NAB', 'STCATH'], ['STCATH', 'PORTLAND'], ['PORTLAND', 'START'],
    ['START', 'EDDY'], ['EDDY', 'LIZARD'], ['LIZARD', 'WOLF'], ['LIZARD', 'BISHOP'], ['WOLF', 'BISHOP'],
    ['STCATH', 'CHERB'], ['CHERB', 'CASQ'], ['CASQ', 'PORTLAND'], ['CASQ', 'LIZARD'], ['CASQ', 'USHANT'], ['USHANT', 'BISHOP'],
    ['HAVRE', 'OWERS'], ['HAVRE', 'BEACHY'], ['HAVRE', 'CHERB'],
    // アイルランド南岸・アイリッシュ海・ノース海峡
    ['BISHOP', 'DAUNT'], ['WOLF', 'SMALLS'], ['SMALLS', 'TUSKAR'], ['TUSKAR', 'DAUNT'], ['DAUNT', 'FASTNET'], ['BISHOP', 'FASTNET'],
    ['TUSKAR', 'STGEORGE'], ['STGEORGE', 'SKERRIES'], ['SKERRIES', 'LIVBAR'], ['SKERRIES', 'CALF'], ['LIVBAR', 'CALF'],
    ['CALF', 'BELFAST'], ['CALF', 'NORTHCH'], ['BELFAST', 'NORTHCH'], ['NORTHCH', 'CLYDE'], ['NORTHCH', 'INISH'], ['INISH', 'TORY'],
    // 北大西洋：南の航路（1/15〜8/23）
    ['BISHOP', 'CORNER_W', 1, 'S'], ['FASTNET', 'CORNER_W', 1, 'S'], ['TORY', 'CORNER_W', 1, 'S'],
    ['CORNER_W', 'NANTUCKET', 1, 'S'], ['CORNER_W', 'SABLE', 1, 'S'],
    ['NANTUCKET', 'CORNER_E', 1, 'S'], ['SABLE', 'CORNER_E', 1, 'S'],
    ['CORNER_E', 'BISHOP', 1, 'S'], ['CORNER_E', 'FASTNET', 1, 'S'], ['CORNER_E', 'TORY', 1, 'S'],
    // 北大西洋：北の航路（8/24〜1/14）
    ['BISHOP', 'NORTH_W', 1, 'N'], ['FASTNET', 'NORTH_W', 1, 'N'], ['TORY', 'NORTH_W', 1, 'N'],
    ['NORTH_W', 'NANTUCKET', 1, 'N'], ['NORTH_W', 'SABLE', 1, 'N'],
    ['NANTUCKET', 'NORTH_E', 1, 'N'], ['SABLE', 'NORTH_E', 1, 'N'],
    ['NORTH_E', 'BISHOP', 1, 'N'], ['NORTH_E', 'FASTNET', 1, 'N'], ['NORTH_E', 'TORY', 1, 'N'],
    // カナダ・アメリカ東海岸
    ['SABLE', 'HALIFAX'], ['HALIFAX', 'CSABLE'], ['CSABLE', 'BOSTON'], ['CSABLE', 'NANTUCKET'],
    ['NANTUCKET', 'AMBROSE'], ['NANTUCKET', 'GSC'], ['GSC', 'BOSTON'],
    ['AMBROSE', 'DELAWARE'], ['DELAWARE', 'CHESA'], ['CHESA', 'HATTERAS'], ['HATTERAS', 'NEPC'],
    ['AMBROSE', 'BERMUDA'], ['HATTERAS', 'BERMUDA'], ['BERMUDA', 'NEPC'],
];
const SEA_LANE_MIN = 300000;        // これより近い所へは、航路の点をたどらない[m]
const SEA_LANE_REACH = 450000;      // 出発点・行き先から、航路の点へ入る・出る遠さの上限[m]

// 季節：1 月 15 日〜8 月 23 日は南の航路
function seaLaneSeason() {
    let m = 4, d = 15;
    if (typeof calDayNow === 'function' && typeof calISO === 'function') { const s = calISO(calDayNow()); m = +s.slice(5, 7); d = +s.slice(8, 10); }
    const md = m * 100 + d;
    return (md >= 115 && md <= 823) ? 'S' : 'N';
}
function _slDist(a, b) { return worldDistance(a.lat, a.lon, b.lat, b.lon); }
// 航路の点の並び（出発点・行き先は含まない）。使わないほうがよければ null
function seaLaneRoute(from, to) {
    if (!window.world || world.kind !== 'real' || typeof worldDistance !== 'function') return null;
    const direct = _slDist(from, to);
    if (direct < SEA_LANE_MIN) return null;
    const season = seaLaneSeason();
    const N = Object.entries(SEA_LANE_NODES).map(([k, v]) => ({ k, lat: v[0], lon: v[1], name: v[2] }));
    const idx = new Map(N.map((n, i) => [n.k, i]));
    const adj = N.map(() => []);
    for (const [a, b, dir, sea] of SEA_LANE_EDGES) {
        if (sea && sea !== season) continue;
        const i = idx.get(a), j = idx.get(b);
        if (i === undefined || j === undefined) continue;
        const w = _slDist(N[i], N[j]);
        adj[i].push([j, w]);
        if (!dir) adj[j].push([i, w]);
    }
    // 出発点 → 近くの航路の点、航路の点 → 行き先（入る・出るは、少しだけ高くつける：航路に乗るほうを選ぶ）
    const S = N.length, T = N.length + 1, n = N.length + 2;
    const dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1), done = new Uint8Array(n);
    dist[S] = 0;
    const entry = N.map((q, i) => [i, _slDist(from, q)]).filter(([, d]) => d < SEA_LANE_REACH);
    const exitD = N.map(q => _slDist(q, to));
    if (!entry.length || !exitD.some(d => d < SEA_LANE_REACH)) return null;
    for (let it = 0; it < n; it++) {
        let u = -1, best = Infinity;
        for (let i = 0; i < n; i++) if (!done[i] && dist[i] < best) { best = dist[i]; u = i; }
        if (u < 0 || u === T) break;
        done[u] = 1;
        const out = u === S ? entry.map(([j, d]) => [j, d * 1.1]) : adj[u].concat(exitD[u] < SEA_LANE_REACH ? [[T, exitD[u] * 1.1]] : []);
        for (const [v, w] of out) if (dist[u] + w < dist[v]) { dist[v] = dist[u] + w; prev[v] = u; }
    }
    if (!Number.isFinite(dist[T])) return null;
    const seq = [];
    for (let v = prev[T]; v >= 0 && v !== S; v = prev[v]) seq.unshift(N[v]);
    if (seq.length < 2) return null;
    // 遠回りすぎる（陸を越えない近道があるのに、航路をたどると 1.35 倍より長い）なら使わない
    let total = _slDist(from, seq[0]) + _slDist(seq[seq.length - 1], to);
    for (let i = 1; i < seq.length; i++) total += _slDist(seq[i - 1], seq[i]);
    const overLand = !_slLegDeep(from, to, 0, 40000);
    if (total > direct * (overLand ? 3.2 : 1.35)) return null;
    return seq;
}
// 大圏の上の点（u：0〜1）
function _slGC(a, b, u) {
    const A = worldLatLonToUnit(a.lat, a.lon), B = worldLatLonToUnit(b.lat, b.lon);
    const dot = Math.max(-1, Math.min(1, A.x * B.x + A.y * B.y + A.z * B.z)), om = Math.acos(dot);
    if (om < 1e-9) return { lat: a.lat, lon: a.lon };
    const s0 = Math.sin((1 - u) * om) / Math.sin(om), s1 = Math.sin(u * om) / Math.sin(om);
    return worldUnitToLatLon({ x: A.x * s0 + B.x * s1, y: A.y * s0 + B.y * s1, z: A.z * s0 + B.z * s1 });
}
// 大圏の区間が、どこも need[m] より深いか（step[m] おき）
function _slLegDeep(a, b, need, step) {
    const L = _slDist(a, b), n = Math.max(2, Math.ceil(L / (step || 3000)));
    for (let i = 1; i < n; i++) {
        const q = _slGC(a, b, i / n);
        const d = typeof apDepthAt === 'function' ? apDepthAt(q.lat, q.lon) : 100;
        if (!(d >= need)) return false;
    }
    return true;
}
// 航路を探す（49-autopilot.js の worldPlanRoute を包む）：遠くへは、航路の点をたどる
const _worldPlanRouteRaw = window.worldPlanRoute;
async function worldPlanRouteLanes(from, to, opt) {
    opt = opt || {};
    const seq = opt.noLanes ? null : seaLaneRoute(from, to);
    if (!seq) return _worldPlanRouteRaw(from, to, opt);
    const need = (typeof apMargins === 'function' ? apMargins(opt.draft).need : 12) + 1;
    const out = [{ lat: from.lat, lon: from.lon }];
    const add = (pts) => { for (const p of pts.slice(1)) out.push(p); };
    try {
        // 出発点 → 最初の航路の点（ふつうの探し方）
        add(await _worldPlanRouteRaw(from, seq[0], opt));
        out[out.length - 1].label = seq[0].name;
        // 航路の点の間：大圏（150km おきに点を置く）。浅い所を通るなら、その区間だけふつうの探し方で
        for (let i = 1; i < seq.length; i++) {
            const a = seq[i - 1], b = seq[i], L = _slDist(a, b);
            if (_slLegDeep(a, b, need, 3000)) {
                const k = Math.max(1, Math.ceil(L / 150000));
                for (let j = 1; j <= k; j++) { const q = _slGC(a, b, j / k); out.push({ lat: q.lat, lon: ((q.lon + 540) % 360) - 180, narrow: false }); }
            } else add(await _worldPlanRouteRaw(a, b, opt));
            out[out.length - 1].label = b.name;
        }
        // 最後の航路の点 → 行き先
        add(await _worldPlanRouteRaw(seq[seq.length - 1], to, opt));
        return out;
    } catch (e) {
        // 航路の点を通れない（港の近くが浅いなど）：ふつうに
        return _worldPlanRouteRaw(from, to, opt);
    }
}
if (typeof _worldPlanRouteRaw === 'function') window.worldPlanRoute = worldPlanRouteLanes;
window.seaLaneRoute = seaLaneRoute;
window.seaLaneSeason = seaLaneSeason;
