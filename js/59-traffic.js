// ════════════════════════════════════════════════════════════════
//  他の船（港の間を自動で行き来する船）
// ════════════════════════════════════════════════════════════════
//  世界を航海するモードで、港と港の間を自動で行き来する船を走らせる。
//  ・船の種類（客船・貨物船・軍艦・漁船…）に合う港（の埠頭）を選んで行き来する。
//    決まった航路（定期便：ホワイト・スター・ラインのニューヨーク航路など）がある船は、その順に回る。
//    現実世界の地図の外（大西洋の向こうなど）へ行く船は、地図の縁の「外洋の出入口」から出入りする。
//  ・全部の船を、港の航路（掘った水路）と港の間の航路（自動航行と同じワーカーで探した道すじ）の上で動かす。
//    遠くの船は道すじの上を進めるだけ（軽い）。近く（25km 以内）の船だけ、実際のルールで動かす：
//      - 狭い水路・港の航路では右側を通る（右側通行）。前の船には近づきすぎない（追い越さない）
//      - 行き会い（真正面）は互いに右へ、横切りは相手を右に見る船がよける（右へ・船尾を回る・減速）、
//        追い越す船は追い越される船をよける。保持船も、ぶつかりそうなら最後はよける
//      - 埠頭がふさがっていれば、港の外の錨地（いかりを下ろして待つ所）で空くのを待つ
//      - となりの埠頭で離着岸している船があれば、終わるまで待ってから動く
//      - 霧のときは速力を落とし、霧中信号（長音）を鳴らす。変針するときは操船信号（短音）
//  ・自分の船の自動航行も、同じルールで待ったりよけたりする（49-autopilot.js から呼ぶ）。
//  ・見える所（視程・12km 以内）の船だけ形を作って描く（船の種類ごとの簡単な形・夜は航海灯と窓の明かり）。
//  ・世界地図・小さな地図にも出す。

const TF_NEAR = 25000;          // ルールで動かす範囲[m]
const TF_SHOW = 12000;          // 形を作って描く範囲[m]
const TF_FAR_DT = 2;            // 遠くの船を進める間隔[秒]
const TF_SUB = 0.25;            // 近くの船を進める刻み[秒]（物理早送りのとき、1 フレームを何回かに分ける）
const TF_DT_MAX = 3;            // 1 フレームで進める物理の時間の上限[秒]
const TF_SIG_NEAR = 3000;       // 変針の信号を鳴らす、他の船との距離[m]
const TF_SHADOW_NEAR = 2000;    // 他の船が影を落とす範囲[m]
const TF_HIT_STOP = 40;         // ぶつかった船が機関を止めている時間[秒]
const traffic = {
    on: true, density: 'normal', era: 'mix', horn: true,
    ships: [], key: '', ready: false, nextId: 1,
    lanes: new Map(), laneQ: [], laneBusy: false,
    quays: new Map(),           // 港の id → [{ b0, b1, who }]（岸壁の使っている所。作り込んだ港の埠頭は 1 隻だけ）
    anch: new Map(),            // 錨地（海の出入口ごと）
    t: 0, farAcc: 0, ruleAcc: 0, playerAcc: 0,
    player: { port: null, b: 0, plan: null, reserve: null, lock: null },
    msgs: [],
};
window.traffic = traffic;
try { Object.assign(traffic, (({ on, density, era, horn }) => ({ on, density, era, horn }))(Object.assign({ on: true, density: 'normal', era: 'mix', horn: true }, JSON.parse(localStorage.getItem('susuru_traffic') || '{}')))); } catch (e) { /* ignore */ }
function _tfSave() { try { localStorage.setItem('susuru_traffic', JSON.stringify({ on: traffic.on, density: traffic.density, era: traffic.era, horn: traffic.horn })); } catch (e) { /* ignore */ } }
const TF_DENSITY = { few: { k: 0.35, label: '少なめ' }, normal: { k: 0.7, label: 'ふつう' }, many: { k: 1.2, label: '多め' } };
const TF_ERA = { old: '昔（客船の時代）', new: '今', mix: 'まぜる' };

// ── 船の種類 ──
//  ports：行く港の種類、L：長さ[m]、LB：長さ÷幅、d：喫水[m]、kn：速力[ノット]、hk：港の中の速力、
//  era：old（客船の時代：1900〜60 年代）・new（今）・any、w：出る割合、dwell：港にいる時間[分]、look：形
const TF_CLASSES = {
    liner:       { label: 'オーシャンライナー', ports: ['passenger', 'city'], L: [170, 270], LB: 9.5, d: [8.5, 10.4], kn: [17, 23], hk: 6, era: 'old', w: 3, dwell: [40, 90], look: 'liner', fun: [2, 4], icon: '🛳' },
    coastal:     { label: '沿岸の客船', ports: ['passenger', 'city', 'town'], L: [90, 140], LB: 7.5, d: [4.5, 6.2], kn: [15, 19], hk: 7, era: 'old', w: 2.5, dwell: [15, 40], look: 'liner', fun: [1, 2], icon: '⛴' },
    steamer:     { label: '貨物船', ports: ['cargo', 'city', 'town'], L: [90, 150], LB: 7.5, d: [6.5, 8.5], kn: [9, 12], hk: 6, era: 'old', w: 4, dwell: [30, 120], look: 'steamer', fun: [1, 1], icon: '🚢' },
    dreadnought: { label: '戦艦', ports: ['naval'], L: [170, 210], LB: 6.5, d: [8.5, 9.5], kn: [18, 21], hk: 7, era: 'old', w: 0.8, dwell: [60, 240], look: 'battleship', fun: [2, 3], icon: '⚓' },
    cruiser:     { label: '巡洋艦', ports: ['naval'], L: [150, 200], LB: 9, d: [6.5, 7.8], kn: [20, 28], hk: 8, era: 'any', w: 1, dwell: [60, 200], look: 'cruiser', fun: [2, 4], icon: '⚓' },
    destroyer:   { label: '駆逐艦', ports: ['naval'], L: [95, 150], LB: 10, d: [3.5, 5], kn: [22, 30], hk: 9, era: 'any', w: 1.5, dwell: [40, 180], look: 'destroyer', fun: [1, 4], icon: '⚓' },
    cruise:      { label: 'クルーズ船', ports: ['passenger'], L: [220, 320], LB: 8, d: [7.5, 8.6], kn: [18, 22], hk: 6, era: 'new', w: 2.5, dwell: [40, 90], look: 'cruise', fun: [1, 1], icon: '🛳' },
    ferry:       { label: 'フェリー', ports: ['passenger', 'city', 'town'], L: [100, 190], LB: 6.5, d: [5, 6.5], kn: [17, 22], hk: 8, era: 'new', w: 2, dwell: [10, 30], look: 'ferry', fun: [1, 2], icon: '⛴' },
    container:   { label: 'コンテナ船', ports: ['cargo'], L: [170, 300], LB: 7, d: [9.5, 12], kn: [16, 21], hk: 6, era: 'new', w: 3, dwell: [40, 120], look: 'container', fun: [1, 1], icon: '🚢' },
    tanker:      { label: 'タンカー', ports: ['cargo'], L: [150, 250], LB: 6, d: [9, 12], kn: [13, 15], hk: 5, era: 'new', w: 2, dwell: [40, 120], look: 'tanker', fun: [1, 1], icon: '🚢' },
    bulk:        { label: 'ばら積み船', ports: ['cargo'], L: [150, 230], LB: 6.5, d: [9, 11.5], kn: [12, 14], hk: 5, era: 'new', w: 1.5, dwell: [60, 150], look: 'bulk', fun: [1, 1], icon: '🚢' },
    carrier:     { label: '航空母艦', ports: ['naval'], L: [250, 320], LB: 8, d: [10, 11.5], kn: [20, 28], hk: 7, era: 'new', w: 0.4, dwell: [120, 300], look: 'carrier', fun: [1, 1], icon: '✈' },
    fishing:     { label: '漁船', ports: ['fishing', 'town'], L: [20, 45], LB: 4, d: [2.5, 4], kn: [8, 11], hk: 6, era: 'any', w: 3, dwell: [20, 60], look: 'fishing', fun: [0, 1], icon: '🎣' },
};
window.TF_CLASSES = TF_CLASSES;

// ── 塗り分け（会社ごと）──
const TF_LIVERY = {
    whitestar: { hull: 0x15161a, boot: 0x8a2c20, sup: 0xf1ede2, fun: 0xd29a3c, top: 0x15161a },
    cunard:    { hull: 0x15161a, boot: 0x8a2c20, sup: 0xf1ede2, fun: 0xc8401e, top: 0x15161a, bands: 0x15161a },
    hapag:     { hull: 0x15161a, boot: 0x8a2c20, sup: 0xf1ede2, fun: 0xd8b27a, top: 0x15161a },
    ndl:       { hull: 0x15161a, boot: 0x8a2c20, sup: 0xf1ede2, fun: 0xd8b27a, top: 0x15161a },
    hal:       { hull: 0x15161a, boot: 0x8a2c20, sup: 0xf1ede2, fun: 0xd9c23a, top: 0x15161a, bands: 0x1f6b3a },
    cgt:       { hull: 0x15161a, boot: 0x8a2c20, sup: 0xf1ede2, fun: 0xc8401e, top: 0x15161a },
    italia:    { hull: 0xf2f2ee, boot: 0x2e7d3c, sup: 0xf7f7f2, fun: 0xf7f7f2, top: 0xc8401e, bands: 0x2e7d3c },
    usl:       { hull: 0x15161a, boot: 0x8a2c20, sup: 0xf1ede2, fun: 0xc8102e, top: 0x1a2a6c, bands: 0xffffff },
    american:  { hull: 0x15161a, boot: 0x8a2c20, sup: 0xf1ede2, fun: 0x15161a, top: 0x15161a, bands: 0xf1ede2 },
    redstar:   { hull: 0x15161a, boot: 0x8a2c20, sup: 0xf1ede2, fun: 0x15161a, top: 0x15161a, bands: 0xf1ede2 },
    coastal:   { hull: 0xf1ede2, boot: 0x8a2c20, sup: 0xf1ede2, fun: 0x15161a, top: 0x15161a },
    navy:      { hull: 0x6f777d, boot: 0x5a2420, sup: 0x737b81, fun: 0x6a7278, top: 0x26292c, deck: 0x8a7a60 },
    navymod:   { hull: 0x7c858b, boot: 0x5a2420, sup: 0x80898f, fun: 0x6f777d, top: 0x2a2d30, deck: 0x55595c },
    cruise:    { hull: 0xf7f7f4, boot: 0x1e3c72, sup: 0xf7f7f4, fun: 0x1e3c72, top: 0x1e3c72 },
};
const TF_RANDOM_HULL = [0x15161a, 0x2b2f36, 0x5a1d1d, 0x1d3557, 0x24543a, 0x3a3f45, 0x7a2e1b];
const TF_RANDOM_FUN = [0x15161a, 0xc8401e, 0xd29a3c, 0x1d3557, 0x2e7d3c, 0xd9c23a, 0xe8e2d0];

// ── 名前（決まった船のほかは、ここから選ぶ）──
const TF_NAMES = {
    liner: ['Caledonia', 'Cameronia', 'Columbia', 'Minnewaska', 'Minnetonka', 'Lapland', 'Zeeland', 'Finland', 'Orinoco', 'Arabic', 'Cymric', 'Persic', 'Runic', 'Canada', 'Dominion', 'Victorian', 'Virginian', 'Tunisian', 'Grampian', 'Hesperian'],
    coastal: ['Harvard', 'Yale', 'Priscilla', 'Commonwealth', 'Puritan', 'Providence', 'Calvin Austin', 'Governor Dingley', 'Jefferson', 'Jamestown', 'Yorktown', 'Arapahoe', 'Comanche', 'Apache', 'Iroquois', 'Mohawk', 'Hamilton', 'Merrimack'],
    steamer: ['Eastern Star', 'Northern Queen', 'Atlantic Trader', 'Mystic', 'Blue Ridge', 'Potomac', 'Hudson', 'Delaware', 'Susquehanna', 'Apalachee', 'Kennebec', 'Penobscot', 'Nantucket', 'Connecticut', 'Chatham', 'Wabash', 'Ontario', 'Kentucky'],
    dreadnought: ['USS Texas', 'USS New York', 'USS Wyoming', 'USS Arkansas', 'USS Florida', 'USS Utah', 'USS Delaware', 'USS North Dakota', 'USS Michigan', 'USS South Carolina'],
    cruiser: ['USS Brooklyn', 'USS Olympia', 'USS Chicago', 'USS Boston', 'USS Atlanta', 'USS Raleigh', 'USS Cincinnati', 'USS Richmond', 'USS Norfolk', 'HMS London', 'HMS York'],
    destroyer: ['USS Farragut', 'USS Decatur', 'USS Porter', 'USS Bainbridge', 'USS Lawrence', 'USS Macdonough', 'USS Hopkins', 'USS Whipple', 'USS Truxtun', 'USS Stringham', 'USS Smith', 'USS Preston', 'USS Paul Jones', 'USS Reid'],
    cruise: ['Ocean Dream', 'Sea Princess', 'Atlantic Star', 'Northern Lights', 'Emerald Bay', 'Sunset Queen', 'Harmony', 'Serenade', 'Luminous', 'Aurora'],
    ferry: ['City of Portland', 'Bluenose', 'Casco Bay', 'Cape May', 'Nantucket Dawn', 'Island Queen', 'Highlander', 'St. Columba'],
    container: ['Atlantic Container', 'Port Express', 'Harbour Bridge', 'Ocean Trader', 'Star Liner', 'Blue Horizon', 'Meridian', 'Ever Bright', 'Maersk Virginia', 'North Gate'],
    tanker: ['Gulf Star', 'Petro Atlantic', 'Delta Queen', 'Atlantic Flame', 'North Sea Spirit', 'Ocean Petro'],
    bulk: ['Cape Stone', 'Iron Duke', 'Coal Harbour', 'Grain Queen', 'Stonehaven', 'Ore Trader'],
    carrier: ['USS Enterprise', 'USS Ranger', 'USS Wasp', 'USS Hornet', 'USS Yorktown', 'USS Saratoga'],
    fishing: ['Mary Ann', 'Good Hope', 'Sea Swallow', 'Little John', 'Northern Light', 'Three Brothers', 'Ocean Belle', 'St. Andrew', 'Lucky Star', 'Faith', 'Helen B.', 'Gertrude'],
};
// 作った世界の船の名前（〇〇丸：ローマ字で ○○ Maru）
const TF_GEN_SYL = ['asa', 'shio', 'nami', 'kaze', 'hoshi', 'tsuki', 'hino', 'umi', 'yama', 'haya', 'shira', 'ao', 'kuro', 'mina', 'taka', 'ake', 'waka', 'fuji', 'saku', 'suzu'];

// ── 外洋の出入口（現実世界の地図の外へ行く・地図の外から来る船）──
const TF_GATES = {
    useast: [
        { key: 'g:eu', name: '大西洋（ヨーロッパ航路）', lat: 40.2, lon: -64.5 },
        { key: 'g:sa', name: 'カリブ海・南米航路', lat: 25.3, lon: -66.5 },
    ],
    britain: [
        { key: 'g:am', name: '大西洋（ニューヨーク航路）', lat: 50.7, lon: -10.5 },
        { key: 'g:an', name: '大西洋（カナダ航路・北回り）', lat: 55.6, lon: -10.5 },
        { key: 'g:ns', name: '北海（ハンブルク・ロッテルダム方面）', lat: 53.2, lon: 2.6 },
    ],
    // 北大西洋（1 つの世界）：大西洋そのものは地図の中なので、出入口は地図の外の海へ通じる所だけ
    natl: [
        { key: 'g:ns', name: '北海（ハンブルク・ロッテルダム方面）', lat: 53.2, lon: 2.6 },
        { key: 'g:med', name: '地中海（ジブラルタル海峡）', lat: 35.95, lon: -6.6 },
        { key: 'g:sa', name: 'カリブ海・南米航路', lat: 25.3, lon: -66.5 },
        { key: 'g:gsl', name: 'セント・ローレンス湾（モントリオール・ケベック方面）', lat: 47.2, lon: -60.2 },
    ],
};

// ── 決まった航路の船（定期便）──
//  route：回る所の順（埠頭の名前・港のまとまりの名前・外洋の出入口）。最後まで行ったら最初に戻る
const TF_SERVICES = {
    useast: [
        // 大西洋航路（ニューヨーク）
        { name: 'Adriatic', line: 'ホワイト・スター・ライン', cls: 'liner', L: 222, B: 23, d: 9.4, kn: 17, fun: 2, liv: 'whitestar', route: ['g:eu', 'ニューヨーク港 59番埠頭（ホワイト・スター・ライン）（南側）'] },
        { name: 'Cedric', line: 'ホワイト・スター・ライン', cls: 'liner', L: 213, B: 23, d: 9.4, kn: 16, fun: 2, liv: 'whitestar', route: ['ニューヨーク港 60番埠頭（ホワイト・スター・ライン）', 'g:eu'] },
        { name: 'Baltic', line: 'ホワイト・スター・ライン', cls: 'liner', L: 222, B: 23, d: 9.4, kn: 16, fun: 2, liv: 'whitestar', route: ['g:eu', 'ニューヨーク港 59番埠頭（ホワイト・スター・ライン）（北側）'] },
        { name: 'Lusitania', line: 'キュナード・ライン', cls: 'liner', L: 240, B: 27, d: 10.2, kn: 24, fun: 4, liv: 'cunard', route: ['ニューヨーク港 54番埠頭（キュナード・ライン）（北側）', 'g:eu'] },
        { name: 'Caronia', line: 'キュナード・ライン', cls: 'liner', L: 206, B: 22, d: 9.1, kn: 18, fun: 2, liv: 'cunard', route: ['g:eu', 'ニューヨーク港 56番埠頭（キュナード・ライン）'] },
        { name: 'La Provence', line: 'フレンチ・ライン', cls: 'liner', L: 191, B: 20, d: 8.5, kn: 21, fun: 2, liv: 'cgt', route: ['ニューヨーク港 57番埠頭（フレンチ・ライン）', 'g:eu'] },
        { name: 'Amerika', line: 'ハンブルク・アメリカ・ライン', cls: 'liner', L: 213, B: 23, d: 9.5, kn: 18, fun: 2, liv: 'hapag', route: ['g:eu', 'ニューヨーク港 ホーボーケン（ハンブルク・アメリカ・ライン）'] },
        { name: 'Kaiser Wilhelm der Grosse', line: '北ドイツ・ロイド', cls: 'liner', L: 200, B: 20, d: 8.8, kn: 22, fun: 4, liv: 'ndl', route: ['ニューヨーク港 ホーボーケン（北ドイツ・ロイド）', 'g:eu'] },
        { name: 'Rotterdam', line: 'ホランド・アメリカ・ライン', cls: 'liner', L: 203, B: 23, d: 9.5, kn: 17, fun: 1, liv: 'hal', route: ['g:eu', 'ニューヨーク港 ホーボーケン（ホランド・アメリカ・ライン）'] },
        { name: 'Rex', line: 'イタリアン・ライン', cls: 'liner', L: 268, B: 30, d: 10.0, kn: 26, fun: 2, liv: 'italia', route: ['ニューヨーク港 84番埠頭（イタリアン・ライン）', 'g:eu'] },
        { name: 'Queen Mary', line: 'キュナード・ライン', cls: 'liner', L: 310, B: 36, d: 10.4, kn: 28, fun: 3, liv: 'cunard', route: ['g:eu', 'ニューヨーク港 90番埠頭（キュナード・ライン）（南側）'] },
        { name: 'United States', line: 'ユナイテッド・ステーツ・ライン', cls: 'liner', L: 302, B: 31, d: 9.6, kn: 30, fun: 2, liv: 'usl', route: ['ニューヨーク港 86番埠頭（ユナイテッド・ステーツ・ライン）', 'g:eu'] },
        // フィラデルフィア・ボルティモア・ボストンの大西洋航路
        { name: 'Friesland', line: 'アメリカン・ライン', cls: 'liner', L: 133, B: 15.5, d: 7.5, kn: 15, fun: 1, liv: 'american', route: ['g:eu', 'フィラデルフィア港 ワシントン通り埠頭（アメリカン・ライン／レッド・スター・ライン）'] },
        { name: 'Vaderland', line: 'レッド・スター・ライン', cls: 'liner', L: 170, B: 18, d: 8.2, kn: 15, fun: 1, liv: 'redstar', route: ['フィラデルフィア港 ワシントン通り埠頭（アメリカン・ライン／レッド・スター・ライン）', 'g:eu'] },
        { name: 'Brandenburg', line: '北ドイツ・ロイド', cls: 'liner', L: 145, B: 17, d: 7.8, kn: 13, fun: 1, liv: 'ndl', route: ['g:eu', 'ボルティモア港 ローカスト・ポイント 8番埠頭（北ドイツ・ロイド／移民の埠頭）'] },
        { name: 'Saxonia', line: 'キュナード・ライン', cls: 'liner', L: 176, B: 20, d: 8.5, kn: 15, fun: 1, liv: 'cunard', route: ['ボストン港 コモンウェルス埠頭（5番埠頭）', 'g:eu'] },
        // 沿岸の客船
        { name: 'Harvard', line: 'メトロポリタン・ライン', cls: 'coastal', L: 124, B: 19, d: 5, kn: 19, fun: 3, liv: 'coastal', route: ['ニューヨーク港', 'ボストン港'] },
        { name: 'Yale', line: 'メトロポリタン・ライン', cls: 'coastal', L: 124, B: 19, d: 5, kn: 19, fun: 3, liv: 'coastal', route: ['ボストン港', 'ニューヨーク港'] },
        { name: 'Priscilla', line: 'フォール・リヴァー・ライン', cls: 'coastal', L: 134, B: 16, d: 4.5, kn: 17, fun: 2, liv: 'coastal', route: ['ニューヨーク港', 'フォール・リヴァー港'] },
        { name: 'Jamestown', line: 'オールド・ドミニオン・ライン', cls: 'coastal', L: 110, B: 14, d: 5.5, kn: 15, fun: 1, liv: 'coastal', route: ['ニューヨーク港', 'ノーフォーク港（ハンプトン・ローズ）'] },
        { name: 'Arapahoe', line: 'クライド・ライン', cls: 'coastal', L: 115, B: 14, d: 6, kn: 15, fun: 1, liv: 'american', route: ['ニューヨーク港', 'チャールストン港', 'ジャクソンヴィル港', 'チャールストン港'] },
        { name: 'Morro Castle', line: 'ウォード・ライン', cls: 'coastal', L: 155, B: 21, d: 7.5, kn: 20, fun: 2, liv: 'american', route: ['ニューヨーク港', 'ナッソー港', 'g:sa', 'ナッソー港'] },
        { name: 'Calvin Austin', line: 'イースタン・スチームシップ', cls: 'coastal', L: 100, B: 15, d: 4.5, kn: 16, fun: 1, liv: 'coastal', route: ['ボストン港', 'ポートランド港（メイン）', 'セント・ジョン港', 'ポートランド港（メイン）'] },
        // 海軍
        { name: 'USS Texas', line: 'アメリカ海軍', cls: 'dreadnought', L: 175, B: 29, d: 8.7, kn: 21, fun: 2, liv: 'navy', route: ['ノーフォーク港（ハンプトン・ローズ）', 'ニューヨーク港 ブルックリン海軍工廠', 'ボストン港', 'ニューヨーク港 ブルックリン海軍工廠'] },
        { name: 'USS New York', line: 'アメリカ海軍', cls: 'dreadnought', L: 175, B: 29, d: 8.7, kn: 21, fun: 2, liv: 'navy', route: ['ニューヨーク港 ブルックリン海軍工廠', 'ノーフォーク港（ハンプトン・ローズ）', 'フィラデルフィア港 フィラデルフィア海軍工廠（4番埠頭）', 'ノーフォーク港（ハンプトン・ローズ）'] },
    ],
    britain: [
        { name: 'Majestic', line: 'ホワイト・スター・ライン', cls: 'liner', L: 177, B: 18, d: 7.6, kn: 20, fun: 2, liv: 'whitestar', route: ['サウサンプトン港 オーシャン・ドック（43/44番）', 'シェルブール軍港', 'コーク港', 'g:am', 'コーク港', 'シェルブール軍港'] },
        { name: 'Oceanic', line: 'ホワイト・スター・ライン', cls: 'liner', L: 215, B: 21, d: 9.6, kn: 19, fun: 2, liv: 'whitestar', route: ['g:am', 'コーク港', 'シェルブール軍港', 'サウサンプトン港 オーシャン・ドック（43/44番）', 'シェルブール軍港', 'コーク港'] },
        { name: 'Adriatic', line: 'ホワイト・スター・ライン', cls: 'liner', L: 222, B: 23, d: 9.4, kn: 17, fun: 2, liv: 'whitestar', route: ['サウサンプトン港 オーシャン・ドック（43/44番）', 'g:am'] },
        { name: 'Lusitania', line: 'キュナード・ライン', cls: 'liner', L: 240, B: 27, d: 10.2, kn: 24, fun: 4, liv: 'cunard', route: ['リヴァプール港', 'コーク港', 'g:am', 'コーク港'] },
        { name: 'Campania', line: 'キュナード・ライン', cls: 'liner', L: 189, B: 20, d: 8.5, kn: 21, fun: 2, liv: 'cunard', route: ['g:am', 'コーク港', 'リヴァプール港', 'コーク港'] },
        { name: 'Caronia', line: 'キュナード・ライン', cls: 'liner', L: 206, B: 22, d: 9.1, kn: 18, fun: 2, liv: 'cunard', route: ['リヴァプール港', 'g:am'] },
        { name: 'Caledonia', line: 'アンカー・ライン', cls: 'liner', L: 160, B: 19, d: 8, kn: 16, fun: 2, liv: 'american', route: ['グラスゴー港', 'g:an'] },
        { name: 'Victorian', line: 'アラン・ライン', cls: 'liner', L: 165, B: 18, d: 8, kn: 18, fun: 1, liv: 'cgt', route: ['g:an', 'リヴァプール港'] },
        { name: 'New York', line: 'アメリカン・ライン', cls: 'liner', L: 170, B: 19, d: 8, kn: 20, fun: 3, liv: 'american', route: ['サウサンプトン港', 'シェルブール軍港', 'g:am', 'シェルブール軍港'] },
        { name: 'Kaiser Wilhelm II', line: '北ドイツ・ロイド', cls: 'liner', L: 215, B: 22, d: 9.4, kn: 23, fun: 4, liv: 'ndl', route: ['g:ns', 'サウサンプトン港', 'シェルブール軍港', 'g:am', 'サウサンプトン港', 'g:ns'] },
        // アイリッシュ海・イギリス海峡の連絡船
        { name: 'Hibernia', line: 'ロンドン・ノース・ウェスタン鉄道', cls: 'coastal', L: 115, B: 13, d: 4.5, kn: 21, fun: 2, liv: 'coastal', route: ['ホーリーヘッド港', 'ダブリン港'] },
        { name: 'Munster', line: 'シティ・オブ・ダブリン汽船', cls: 'coastal', L: 115, B: 13, d: 4.5, kn: 22, fun: 2, liv: 'coastal', route: ['ダブリン港', 'ホーリーヘッド港'] },
        { name: 'Viking', line: 'マン島汽船', cls: 'coastal', L: 110, B: 13, d: 4.5, kn: 22, fun: 3, liv: 'coastal', route: ['リヴァプール港', 'ダグラス港'] },
        { name: 'The Queen', line: 'サウス・イースタン鉄道', cls: 'coastal', L: 94, B: 12, d: 4, kn: 21, fun: 2, liv: 'coastal', route: ['ドーヴァー港', 'カレー港'] },
        { name: 'Caledonia', line: 'ロンドン・アンド・サウス・ウェスタン鉄道', cls: 'coastal', L: 90, B: 12, d: 4.2, kn: 19, fun: 2, liv: 'coastal', route: ['サウサンプトン港', 'ル・アーヴル貨物港'] },
        { name: 'Belfast', line: 'ベルファスト汽船', cls: 'coastal', L: 100, B: 13, d: 4.8, kn: 18, fun: 1, liv: 'coastal', route: ['リヴァプール港', 'ベルファスト港'] },
        // 海軍
        { name: 'HMS Dreadnought', line: 'イギリス海軍', cls: 'dreadnought', L: 160, B: 25, d: 8.9, kn: 21, fun: 2, liv: 'navy', route: ['ポーツマス軍港', 'プリマス軍港', 'ロサイス軍港', 'プリマス軍港'] },
        { name: 'HMS Vanguard', line: 'イギリス海軍', cls: 'dreadnought', L: 163, B: 26, d: 8.7, kn: 21, fun: 2, liv: 'navy', route: ['ロサイス軍港', 'ポーツマス軍港'] },
    ],
};
// 北大西洋（1 つの世界）：大西洋航路の客船は、ヨーロッパの港とアメリカの港の間をそのまま行き来する
//（沿岸の客船・海軍は、それぞれの地域の分をそのまま）
(function () {
    const SOT = 'サウサンプトン港 オーシャン・ドック（43/44番）', CHB = 'シェルブール軍港', QT = 'コーク港', LIV = 'リヴァプール港';
    const NY = (k) => 'ニューヨーク港 ' + k;
    const liners = [
        { name: 'Majestic', line: 'ホワイト・スター・ライン', cls: 'liner', L: 177, B: 18, d: 7.6, kn: 20, fun: 2, liv: 'whitestar', route: [SOT, CHB, QT, NY('59番埠頭（ホワイト・スター・ライン）（北側）'), QT, CHB] },
        { name: 'Oceanic', line: 'ホワイト・スター・ライン', cls: 'liner', L: 215, B: 21, d: 9.6, kn: 19, fun: 2, liv: 'whitestar', route: [NY('60番埠頭（ホワイト・スター・ライン）'), QT, CHB, SOT, CHB, QT] },
        { name: 'Adriatic', line: 'ホワイト・スター・ライン', cls: 'liner', L: 222, B: 23, d: 9.4, kn: 17, fun: 2, liv: 'whitestar', route: [SOT, CHB, QT, NY('59番埠頭（ホワイト・スター・ライン）（南側）'), QT, CHB] },
        { name: 'Cedric', line: 'ホワイト・スター・ライン', cls: 'liner', L: 213, B: 23, d: 9.4, kn: 16, fun: 2, liv: 'whitestar', route: [LIV, QT, NY('60番埠頭（ホワイト・スター・ライン）'), QT] },
        { name: 'Baltic', line: 'ホワイト・スター・ライン', cls: 'liner', L: 222, B: 23, d: 9.4, kn: 16, fun: 2, liv: 'whitestar', route: [NY('59番埠頭（ホワイト・スター・ライン）（北側）'), QT, LIV, QT] },
        { name: 'Lusitania', line: 'キュナード・ライン', cls: 'liner', L: 240, B: 27, d: 10.2, kn: 24, fun: 4, liv: 'cunard', route: [LIV, QT, NY('54番埠頭（キュナード・ライン）（北側）'), QT] },
        { name: 'Campania', line: 'キュナード・ライン', cls: 'liner', L: 189, B: 20, d: 8.5, kn: 21, fun: 2, liv: 'cunard', route: [NY('56番埠頭（キュナード・ライン）'), QT, LIV, QT] },
        { name: 'Caronia', line: 'キュナード・ライン', cls: 'liner', L: 206, B: 22, d: 9.1, kn: 18, fun: 2, liv: 'cunard', route: [LIV, NY('56番埠頭（キュナード・ライン）')] },
        { name: 'Queen Mary', line: 'キュナード・ライン', cls: 'liner', L: 310, B: 36, d: 10.4, kn: 28, fun: 3, liv: 'cunard', route: [SOT, CHB, NY('90番埠頭（キュナード・ライン）（南側）'), CHB] },
        { name: 'Saxonia', line: 'キュナード・ライン', cls: 'liner', L: 176, B: 20, d: 8.5, kn: 15, fun: 1, liv: 'cunard', route: [LIV, QT, 'ボストン港 コモンウェルス埠頭（5番埠頭）', QT] },
        { name: 'La Provence', line: 'フレンチ・ライン', cls: 'liner', L: 191, B: 20, d: 8.5, kn: 21, fun: 2, liv: 'cgt', route: ['ル・アーヴル貨物港', NY('57番埠頭（フレンチ・ライン）')] },
        { name: 'Amerika', line: 'ハンブルク・アメリカ・ライン', cls: 'liner', L: 213, B: 23, d: 9.5, kn: 18, fun: 2, liv: 'hapag', route: ['g:ns', 'サウサンプトン港', CHB, NY('ホーボーケン（ハンブルク・アメリカ・ライン）'), CHB, 'サウサンプトン港'] },
        { name: 'Kaiser Wilhelm der Grosse', line: '北ドイツ・ロイド', cls: 'liner', L: 200, B: 20, d: 8.8, kn: 22, fun: 4, liv: 'ndl', route: [NY('ホーボーケン（北ドイツ・ロイド）'), CHB, 'サウサンプトン港', 'g:ns', 'サウサンプトン港', CHB] },
        { name: 'Kaiser Wilhelm II', line: '北ドイツ・ロイド', cls: 'liner', L: 215, B: 22, d: 9.4, kn: 23, fun: 4, liv: 'ndl', route: ['g:ns', 'サウサンプトン港', CHB, NY('ホーボーケン（北ドイツ・ロイド）'), CHB, 'サウサンプトン港'] },
        { name: 'Brandenburg', line: '北ドイツ・ロイド', cls: 'liner', L: 145, B: 17, d: 7.8, kn: 13, fun: 1, liv: 'ndl', route: ['g:ns', 'ボルティモア港 ローカスト・ポイント 8番埠頭（北ドイツ・ロイド／移民の埠頭）'] },
        { name: 'Rotterdam', line: 'ホランド・アメリカ・ライン', cls: 'liner', L: 203, B: 23, d: 9.5, kn: 17, fun: 1, liv: 'hal', route: ['g:ns', NY('ホーボーケン（ホランド・アメリカ・ライン）')] },
        { name: 'Vaderland', line: 'レッド・スター・ライン', cls: 'liner', L: 170, B: 18, d: 8.2, kn: 15, fun: 1, liv: 'redstar', route: ['g:ns', 'フィラデルフィア港 ワシントン通り埠頭（アメリカン・ライン／レッド・スター・ライン）'] },
        { name: 'Friesland', line: 'アメリカン・ライン', cls: 'liner', L: 133, B: 15.5, d: 7.5, kn: 15, fun: 1, liv: 'american', route: [LIV, 'フィラデルフィア港 ワシントン通り埠頭（アメリカン・ライン／レッド・スター・ライン）'] },
        { name: 'New York', line: 'アメリカン・ライン', cls: 'liner', L: 170, B: 19, d: 8, kn: 20, fun: 3, liv: 'american', route: ['サウサンプトン港', CHB, 'ニューヨーク港', CHB] },
        { name: 'United States', line: 'ユナイテッド・ステーツ・ライン', cls: 'liner', L: 302, B: 31, d: 9.6, kn: 30, fun: 2, liv: 'usl', route: [NY('86番埠頭（ユナイテッド・ステーツ・ライン）'), 'ル・アーヴル貨物港', SOT] },
        { name: 'Rex', line: 'イタリアン・ライン', cls: 'liner', L: 268, B: 30, d: 10.0, kn: 26, fun: 2, liv: 'italia', route: ['g:med', NY('84番埠頭（イタリアン・ライン）')] },
        { name: 'Caledonia', line: 'アンカー・ライン', cls: 'liner', L: 160, B: 19, d: 8, kn: 16, fun: 2, liv: 'american', route: ['グラスゴー港', 'ニューヨーク港'] },
        { name: 'Victorian', line: 'アラン・ライン', cls: 'liner', L: 165, B: 18, d: 8, kn: 18, fun: 1, liv: 'cgt', route: [LIV, 'g:gsl'] },
    ];
    const local = (k) => TF_SERVICES[k].filter(sv => sv.cls !== 'liner');
    TF_SERVICES.natl = liners.concat(local('britain'), local('useast'));
})();
window.TF_SERVICES = TF_SERVICES;
// 決まった航路の船の、就航〜引退の年（名前｜会社 か 名前で引く）。乗っている船の年（13-save-load-config.js の
// 船の情報）と重なる船だけを出す。年の分からない船は、いつでも出す
const TF_SHIP_YEARS = {
    'Majestic': [1890, 1914], 'Oceanic': [1899, 1914], 'Adriatic': [1907, 1934], 'Cedric': [1903, 1932], 'Baltic': [1904, 1933],
    'Lusitania': [1907, 1915], 'Campania': [1893, 1918], 'Caronia': [1905, 1932], 'Queen Mary': [1936, 1967], 'Saxonia': [1900, 1925],
    'La Provence': [1906, 1916], 'Amerika': [1905, 1949], 'Kaiser Wilhelm der Grosse': [1897, 1914], 'Kaiser Wilhelm II': [1903, 1940],
    'Brandenburg': [1902, 1914], 'Rotterdam': [1908, 1940], 'Vaderland': [1900, 1917], 'Friesland': [1889, 1912], 'New York': [1888, 1923],
    'United States': [1952, 1969], 'Rex': [1932, 1944], 'Caledonia|アンカー・ライン': [1904, 1916], 'Victorian': [1905, 1929],
    'Harvard': [1907, 1931], 'Yale': [1907, 1948], 'Priscilla': [1894, 1937], 'Morro Castle': [1930, 1934], 'Calvin Austin': [1903, 1933],
    'USS Texas': [1914, 1948], 'USS New York': [1914, 1946], 'Hibernia': [1900, 1915], 'Viking': [1905, 1954], 'The Queen': [1903, 1916],
    'HMS Dreadnought': [1906, 1921], 'HMS Vanguard': [1910, 1917],
};
function _tfYearsOf(sv) { return TF_SHIP_YEARS[sv.name + '|' + (sv.line || '')] || TF_SHIP_YEARS[sv.name] || null; }
// 乗っている船の年（就航〜引退。引退が空いていれば今も現役、就航が空いていれば引退の年まで）。両方空いていれば null
function _tfOwnYears() {
    const I = window.shipInfo || {};
    if (!I.yearFrom && !I.yearTo) return null;
    return [I.yearFrom || -Infinity, I.yearTo || Infinity];
}
// 年が重なるか（どちらかの年が分からなければ、重なるとみなす）
function _tfYearsOk(yr) {
    const own = _tfOwnYears();
    if (!own || !yr || (!yr[0] && !yr[1])) return true;
    return (yr[0] || -Infinity) <= own[1] && (yr[1] || Infinity) >= own[0];
}
// 会社の名前を、決まった航路の船の会社にそろえる（英語の名前・略称・空白や「・」の違いも）
const TF_LINE_ALIAS = {
    'whitestarline': 'ホワイト・スター・ライン', 'whitestar': 'ホワイト・スター・ライン', 'oceansteamnavigationcompany': 'ホワイト・スター・ライン',
    'cunardline': 'キュナード・ライン', 'cunard': 'キュナード・ライン', 'cunardwhitestar': 'キュナード・ライン', 'キュナード': 'キュナード・ライン',
    'frenchline': 'フレンチ・ライン', 'cgt': 'フレンチ・ライン', 'compagniegeneraletransatlantique': 'フレンチ・ライン', 'compagniegénéraletransatlantique': 'フレンチ・ライン',
    'hamburgamericaline': 'ハンブルク・アメリカ・ライン', 'hapag': 'ハンブルク・アメリカ・ライン', 'hamburgamerikalinie': 'ハンブルク・アメリカ・ライン',
    'northgermanlloyd': '北ドイツ・ロイド', 'norddeutscherlloyd': '北ドイツ・ロイド', 'ndl': '北ドイツ・ロイド', 'ノルドドイチャー・ロイド': '北ドイツ・ロイド',
    'hollandamericaline': 'ホランド・アメリカ・ライン', 'hollandamerikalijn': 'ホランド・アメリカ・ライン',
    'italianline': 'イタリアン・ライン', 'italia': 'イタリアン・ライン', 'italiaflotteriunite': 'イタリアン・ライン',
    'unitedstateslines': 'ユナイテッド・ステーツ・ライン', 'unitedstatesline': 'ユナイテッド・ステーツ・ライン',
    'americanline': 'アメリカン・ライン', 'redstarline': 'レッド・スター・ライン', 'anchorline': 'アンカー・ライン', 'allanline': 'アラン・ライン',
    'usnavy': 'アメリカ海軍', 'unitedstatesnavy': 'アメリカ海軍', 'royalnavy': 'イギリス海軍', '英国海軍': 'イギリス海軍', '米海軍': 'アメリカ海軍',
    'metropolitanline': 'メトロポリタン・ライン', 'fallriverline': 'フォール・リヴァー・ライン', 'olddominionline': 'オールド・ドミニオン・ライン',
    'clydeline': 'クライド・ライン', 'wardline': 'ウォード・ライン', 'easternsteamship': 'イースタン・スチームシップ',
    'isleofmansteampacket': 'マン島汽船', 'isleofmansteampacketcompany': 'マン島汽船',
};
function _tfLineKey(s) { return String(s || '').toLowerCase().replace(/[\s・･.\-_'’&]/g, '').replace(/company$|co$|ltd$|inc$/, ''); }
function _tfCanonLine(name) {
    const k = _tfLineKey(name); if (!k) return '';
    for (const key of Object.keys(TF_SERVICES)) for (const sv of TF_SERVICES[key]) if (sv.line && _tfLineKey(sv.line) === k) return sv.line;
    return TF_LINE_ALIAS[k] || String(name).trim();
}

// ── ちょっとした計算 ──
const _tfR = Math.PI / 180;
function _tfRand(a, b) { return a + Math.random() * (b - a); }
function _tfPick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function _tfWrap(d) { return ((d + 540) % 360) - 180; }
function _tfMLat() { return WORLD_R * _tfR; }
// 緯度・経度の点から、方位 brg[度] へ dist[m]
function _tfOff(q, brg, dist) {
    const b = brg * _tfR, mLat = _tfMLat();
    return { lat: q.lat + Math.cos(b) * dist / mLat, lon: q.lon + Math.sin(b) * dist / (mLat * Math.max(0.05, Math.cos(q.lat * _tfR))) };
}
// a から見た b の東・北[m]（近い所だけ。平らとみる）
function _tfEN(a, b) {
    const mLat = _tfMLat();
    return { e: ((((b.lon - a.lon) + 540) % 360) - 180) * mLat * Math.cos(a.lat * _tfR), n: (b.lat - a.lat) * mLat };
}
function _tfDist(a, b) { const d = _tfEN(a, b); return Math.hypot(d.e, d.n); }
function _tfBrg(a, b) { const d = _tfEN(a, b); return (Math.atan2(d.e, d.n) / _tfR + 360) % 360; }
// 航程線の上の点（メルカトル図の上で直線に）
function _tfLerp(A, B, u) {
    const ya = _apMercY(A.lat), yb = _apMercY(B.lat), y = ya + (yb - ya) * u;
    const lat = Math.abs(yb - ya) > 1e-12 ? (2 * Math.atan(Math.exp(y)) - Math.PI / 2) / _tfR : A.lat + (B.lat - A.lat) * u;
    return { lat, lon: A.lon + _tfWrap(B.lon - A.lon) * u };
}
function _tfKn(v) { return v / 0.514444; }
function _tfMs(kn) { return kn * 0.514444; }
function _tfWorldKey() { return world.kind === 'real' ? 'real:' + world.realKey : 'gen'; }
function _tfPlayerLL() { return worldShipLatLon(); }
function _tfDetail(P) { return !!(P && P.real && typeof _rwDetailBoxOf === 'function' && _RW && _rwDetailBoxOf(P.lat, P.lon)); }
function _tfClassOf(S) { return TF_CLASSES[S.cls] || TF_CLASSES.steamer; }
function _tfMsg(s) { traffic.msgs.unshift({ s, t: traffic.t }); if (traffic.msgs.length > 6) traffic.msgs.length = 6; }

// ════════════════════════════════════════════════════════════════
//  港・埠頭・錨地
// ════════════════════════════════════════════════════════════════
function _tfPorts() { return (typeof worldBuildPorts === 'function') ? worldBuildPorts() : []; }
function _tfGroupOf(P) { return P.group || P.name; }
// 埠頭に付ける船の喫水の上限：作り込んだ港の埠頭（前を 14m に掘ってある）は 11m まで
function _tfPortMaxDraft(P) { return _tfDetail(P) ? 11 : PORT_TYPES[P.type].depth + 1; }
function _tfQuayLen(P) { return P.quay || PORT_TYPES[P.type].quay; }
// 岸壁の使える区間（岸沿い b の範囲）。作り込んだ港の埠頭は 1 隻だけ（single）
function _tfQuayFrame(P) {
    if (P._tfQ) return P._tfQ;
    const len = _tfQuayLen(P);
    let b0 = -len / 2, b1 = len / 2;
    if (typeof _portPierLayout === 'function') { const PL = _portPierLayout(P.type, len); if (PL.free) { b0 = PL.free[0]; b1 = PL.free[1]; } }
    return (P._tfQ = { b0, b1, len, single: _tfDetail(P) });
}
function _tfSuits(cls, P) { const C = TF_CLASSES[cls]; return !!(C && C.ports.includes(P.type)); }
// その埠頭にこの船が付けられるか（深さ・岸壁の長さ）
function _tfFits(S, P) {
    if (S.d > _tfPortMaxDraft(P)) return false;
    const Q = _tfQuayFrame(P);
    if (Q.single) return S.L <= Q.len + 2 * Math.min(30, S.L * 0.1);
    return Q.b1 - Q.b0 >= S.L + 30;
}
// 岸壁の使っている所
function _tfQuayList(P) { let a = traffic.quays.get(P.id); if (!a) traffic.quays.set(P.id, a = []); return a; }
function _tfSlotFind(P, L, who, S) {
    const Q = _tfQuayFrame(P), list = _tfQuayList(P).filter(o => o.who !== who);
    if (Q.single) return list.length || !_tfBerthFree(S, P, 0) ? null : 0;
    const need = L + 30;
    for (let b = Q.b0 + need / 2; b <= Q.b1 - need / 2 + 0.1; b += 10) {
        if (list.every(o => b + need / 2 <= o.b0 || b - need / 2 >= o.b1) && _tfBerthFree(S, P, b)) return b;
    }
    return null;
}
// 埠頭に付けた形（上から見たカプセル：線分 a→b と半径 r。東・北[m] は ref から）
function _tfCapOf(ref, q, hdg, L, B) {
    const c = _tfEN(ref, q), h = hdg * _tfR, fe = Math.sin(h), fn = Math.cos(h), hl = Math.max(0, L / 2 - B / 2);
    return { ae: c.e - fe * hl, an: c.n - fn * hl, be: c.e + fe * hl, bn: c.n + fn * hl, r: B / 2 };
}
function _tfBerthCap(S, P, b, ref) {
    const g = _tfBerthGeo(S, P, _tfQuayFrame(P).single ? 0 : b);
    return _tfCapOf(ref, g.pos, g.hdg, S.L, S.B);
}
// 点（x, z）からカプセルまでの距離（中に入っていれば負）
function _tfSegDist(px, pz, c) {
    const dx = c.be - c.ae, dz = c.bn - c.an, L2 = dx * dx + dz * dz;
    let u = L2 > 1e-6 ? ((px - c.ae) * dx + (pz - c.an) * dz) / L2 : 0;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    return Math.hypot(px - c.ae - u * dx, pz - c.an - u * dz) - c.r;
}
// 2 つのカプセルの間（重なっていれば負）
function _tfCapDist(A, B) {
    let m = Infinity;
    for (let i = 0; i <= 8; i++) { const u = i / 8; m = Math.min(m, _tfSegDist(A.ae + (A.be - A.ae) * u, A.an + (A.bn - A.an) * u, B) + B.r); }
    for (let i = 0; i <= 8; i++) { const u = i / 8; m = Math.min(m, _tfSegDist(B.ae + (B.be - B.ae) * u, B.an + (B.bn - B.an) * u, A) + A.r); }
    return m - A.r - B.r;
}
// その埠頭（b）にこの船を付けても、となりの埠頭の船（付いている・付けに来る船・自分の船）とぶつからないか
//（作り込んだ港の埠頭は 1 隻ずつだが、長い船どうしだと、となりの埠頭の船と重なることがある）
function _tfBerthFree(S, P, b) {
    if (!S) return true;
    const me = _tfBerthCap(S, P, b, P);
    for (const O of traffic.ships) {
        if (O === S) continue;
        let P2 = null, b2 = 0;
        if ((O.port || O.mPort) && (O.st === 'berth' || O.st === 'berthing' || O.st === 'unberth')) { P2 = O.port || O.mPort; b2 = O.slotB || 0; }
        else if (O.to && O.to.P) { const sl = _tfSlotOf(O.to.P, O.id); if (sl) { P2 = O.to.P; b2 = (sl.b0 + sl.b1) / 2; } }
        if (!P2 || P2 === P || Math.abs(P2.lat - P.lat) > 0.02 || _tfDist(P, P2) > 1500) continue;
        if (_tfCapDist(me, _tfBerthCap(O, P2, b2, P)) < 5) return false;
    }
    const pp = traffic.player.port;
    if (pp && pp !== P && _tfDist(P, pp) < 1500) {
        const M = _tfPlayerAsShipSafe();
        if (M && _tfCapDist(me, _tfCapOf(P, M, M.hdg, M.L, M.B)) < 5) return false;
    }
    return true;
}
function _tfSlotTake(P, b, L, who, res) { _tfSlotFree(P, who); _tfQuayList(P).push({ b0: b - L / 2 - 15, b1: b + L / 2 + 15, who, res: !!res }); }
function _tfSlotFree(P, who) { if (!P) return; const a = _tfQuayList(P); for (let i = a.length - 1; i >= 0; i--) if (a[i].who === who) a.splice(i, 1); }
function _tfSlotOf(P, who) { return P ? _tfQuayList(P).find(o => o.who === who) || null : null; }
// 港の海の出入口（港の航路の沖の端。港の間の航路はここどうしを結ぶ）
function _tfSeaEnd(P) {
    if (P._tfSE) return P._tfSE;
    let q;
    if (P.real && P.fairway && P.fairway.pts.length >= 2) q = P.fairway.pts[P.fairway.pts.length - 1];
    else { const T = PORT_TYPES[P.type]; q = portChannelPoint(P, T.basin + worldPortChannelLen(P) + 700); }
    return (P._tfSE = { lat: q.lat, lon: q.lon, key: q.lat.toFixed(2) + ',' + q.lon.toFixed(2) });
}
// 港の航路：海の出入口から、泊地（離着岸の前後に止まる所）まで（入ってくる向き）。ch：港の航路の中
function _tfApproach(P) {
    if (P._tfAp) return P._tfAp;
    let pts;
    if (P.real && P.fairway && P.fairway.pts.length >= 2) {
        const fw = P.fairway.pts;
        pts = [];
        for (let k = fw.length - 1; k >= 1; k--) pts.push({ lat: fw[k].lat, lon: fw[k].lon, ch: k < fw.length - 1 });
    } else {
        const T = PORT_TYPES[P.type], chL = worldPortChannelLen(P), se = _tfSeaEnd(P);
        pts = [{ lat: se.lat, lon: se.lon, ch: false }, Object.assign(portChannelPoint(P, T.basin + chL - 200), { ch: true }), Object.assign(portChannelPoint(P, T.basin * 0.6), { ch: true })];
    }
    // 作り込んだ港の中は狭い（ゆっくり）
    for (const q of pts) q.nar = !!(q.ch && typeof _rwDetailBoxOf === 'function' && _RW && _rwDetailBoxOf(q.lat, q.lon));
    return (P._tfAp = pts);
}
// 岸壁に付ける所と、そこまでの動き方（船首の向き hdg、ドックなら入口の外 out・岸壁の前の線の上 mid、岸壁なら回す所 turn）
function _tfBerthGeo(S, P, b) {
    const C = P._tfGeo || (P._tfGeo = new Map()), key = Math.round(S.L) + '|' + Math.round(S.B) + '|' + Math.round(b || 0) + '|' + Math.round(S.d);
    let g = C.get(key);
    if (!g) { if (C.size > 200) C.clear(); g = _tfBerthGeo0(S, P, b); C.set(key, g); }
    return g;
}
// その円（中心 c・半径 r）の中が、どこも need[m] より深いか
function _tfCircleDeep(c, r, need) {
    if (_tfDepthAt(c.lat, c.lon) < need) return false;
    for (const f of [0.5, 1]) for (let k = 0; k < 16; k++) { const q = _tfOff(c, k * 22.5, r * f); if (_tfDepthAt(q.lat, q.lon) < need) return false; }
    return true;
}
// 岸壁に沿った向き hdg の船（長さ L）が、a から b まで横へ動く帯が深いか
function _tfBandMoveDeep(a, b, hdg, L, need) {
    const n = Math.max(1, Math.ceil(_tfDist(a, b) / 20));
    for (let i = 0; i <= n; i++) {
        const u = i / n, c = { lat: a.lat + (b.lat - a.lat) * u, lon: a.lon + (b.lon - a.lon) * u };
        for (const f of [-0.45, 0, 0.45]) { const q = _tfOff(c, hdg, L * f); if (_tfDepthAt(q.lat, q.lon) < need) return false; }
    }
    return true;
}
// 狭いスリップの奥の岸壁（前で回せない）：ドックのように、スリップをまっすぐ出入りする（入口・入っていく向きを、深さから見つける）
function _tfSynthDock(S, P, face, n) {
    const need = S.d + 1;
    let w = 0;
    for (let r = 5; r <= 400; r += 5) { const q = _tfOff(face, n, r); if (_tfDepthAt(q.lat, q.lon) < need) break; w = r; }
    if (w < S.B + 8) return null;
    const cl = _tfOff(face, n, Math.min(w / 2, S.B + 15));
    const run = (brg) => { let r = 0; for (let x = 20; x <= 900; x += 20) { const q = _tfOff(cl, brg, x); if (_tfDepthAt(q.lat, q.lon) < need) break; r = x; } return r; };
    const a = run(n + 90), c = run(n - 90);
    if (Math.max(a, c) < 250) return null;
    const outB = a >= c ? (n + 90) % 360 : (n + 270) % 360;
    const E = _tfOff(_tfOff(face, n, w / 2), outB, _tfQuayLen(P) / 2 + 20);
    return { E, ib: (outB + 180) % 360, out: 320 };
}
function _tfBerthGeo0(S, P, b) {
    const n = P.seaBearing, Q = _tfQuayFrame(P);
    const face = Q.single ? { lat: P.lat, lon: P.lon } : _tfOff(_tfOff(P, n - 90, b || 0), n, 6);
    const pos = _tfOff(face, n, S.B / 2 + 2.5);
    const geo = { face, pos, n };
    let dock = P.dock ? { E: { lat: P.dock.entrance[0], lon: P.dock.entrance[1] }, ib: P.dock.inBearing, out: P.dock.turnOut || (typeof DOCK_TURN_OUT !== 'undefined' ? DOCK_TURN_OUT : 320) } : null;
    if (!dock) {
        // 岸壁の前で回す（回す所の円が深い所：前が狭ければ沖へずらす）。ずらしても回せなければ（狭いスリップの奥）、ドックのように出入りする
        const base = S.B / 2 + 2.5 + Math.min(220, S.B * 2 + 70);
        let turn = null;
        if (!Q.single) turn = _tfOff(face, n, base);
        else for (let extra = 0; extra <= 400 && !turn; extra += 40) {
            const c = _tfOff(face, n, base + extra);
            if (_tfCircleDeep(c, S.L / 2 + 10, S.d + 1) && _tfBandMoveDeep(pos, c, (n + 90) % 360, S.L, S.d + 0.5)) turn = c;
        }
        if (!turn && Q.single) dock = _tfSynthDock(S, P, face, n);
        if (!dock) { geo.turn = turn || _tfOff(face, n, base); geo.hdg = (n + 90) % 360; return geo; }     // 回すときに、近い方の向き（n−90）に替える
    }
    // ドック（スリップ）：岸壁から 10m 離れた筋（自分の側）を、まっすぐ出入りする（向かいの岸壁の船に寄らない）
    const E = dock.E, ib = dock.ib;
    const mid = _tfOff(pos, n, 10);
    const dm = _tfEN(E, mid), um = dm.e * Math.sin(ib * _tfR) + dm.n * Math.cos(ib * _tfR);
    geo.mid = mid;
    geo.door = _tfOff(mid, ib + 180, Math.max(0, um));          // 入口の線の上（同じ筋）
    geo.out = _tfOff(E, ib + 180, dock.out);
    if (Q.single) {
        let found = false;
        for (let extra = 0; extra <= 600 && !found; extra += 40) {
            const c = _tfOff(E, ib + 180, dock.out + extra);
            if (_tfCircleDeep(c, S.L / 2 + 10, S.d + 1)) { geo.out = c; found = true; }
        }
        for (let r = 100; r <= 600 && !found; r += 100) for (let a = 0; a < 360 && !found; a += 30) {
            const c = _tfOff(geo.out, a, r);
            if (_tfCircleDeep(c, S.L / 2 + 10, S.d + 1) && _tfBandMoveDeep(geo.door, c, ib, S.L, S.d + 0.5)) { geo.out = c; found = true; }
        }
    }
    geo.hdg = ib;
    geo.dock = true;
    return geo;
}
// 錨地：港の海の出入口のまわり（1.5〜4km）で、喫水＋5m 以上 70m 以下の深さがあり、浅瀬がなく、
// 港の航路から 600m 以上離れていて、海の出入口までまっすぐ行ける所。いくつか（600m おき）
function _tfDepth(q) { return _tfDepthAt(q.lat, q.lon); }
// 深さ[m]：apDepthAt は港を全部見るので重い。12m ほどの升目ごとに覚えておく（細かい地形を読んだら忘れる：updateTraffic）
const _tfDC = new Map();
function _tfDepthAt(lat, lon) {
    const i = Math.round(lat * 9000), j = Math.round(lon * 6000), k = i * 4194304 + j;
    let d = _tfDC.get(k);
    if (d === undefined) {
        if (_tfDC.size > 250000) _tfDC.clear();
        d = (typeof apDepthAt === 'function') ? apDepthAt(i / 9000, j / 6000) : 50;
        _tfDC.set(k, d);
    }
    return d;
}
function _tfAnchorages(P) {
    const se = _tfSeaEnd(P);
    let A = traffic.anch.get(se.key);
    if (A) return A;
    A = { spots: [] };
    traffic.anch.set(se.key, A);
    const ap = _tfApproach(P);
    const nearFw = (q) => { for (const p of ap) if (_tfDist(p, q) < 600) return true; return false; };
    const cands = [];
    for (const r of [1500, 2200, 3000, 4000, 5500, 7000, 8500]) for (let k = 0; k < 24; k++) {
        const q = _tfOff(se, k * 15, r);
        const d = _tfDepth(q);
        if (!(d >= 14 && d <= 70) || nearFw(q)) continue;
        let ok = true;
        for (let j = 0; j < 8 && ok; j++) if (_tfDepth(_tfOff(q, j * 45, 350)) < 12) ok = false;
        for (let s = 0.1; s < 1 && ok; s += 0.1) if (_tfDepth({ lat: q.lat + (se.lat - q.lat) * s, lon: q.lon + (se.lon - q.lon) * s }) < 13) ok = false;
        if (ok) cands.push({ lat: q.lat, lon: q.lon, d, r });
    }
    cands.sort((a, b) => a.r - b.r);
    for (const c of cands) if (A.spots.every(s => _tfDist(s, c) > 650)) A.spots.push(c);
    return A;
}
function _tfAnchorFor(S, P) {
    const A = _tfAnchorages(P);
    for (const sp of A.spots) {
        if (sp.d < S.d + 5) continue;
        if (traffic.ships.some(o => o !== S && o.anch === sp)) continue;
        return sp;
    }
    return null;
}

// ════════════════════════════════════════════════════════════════
//  港の間の航路（自動航行と同じワーカーで探す。海の出入口どうしで 1 本ずつ、覚えておく）
// ════════════════════════════════════════════════════════════════
function _tfLane(a, b) {
    if (a.key === b.key) return { pts: [{ lat: a.lat, lon: a.lon }, { lat: b.lat, lon: b.lon }], ok: true };
    const L1 = traffic.lanes.get(a.key + '|' + b.key);
    if (L1 && L1.ok) return L1;
    const L2 = traffic.lanes.get(b.key + '|' + a.key);
    if (L2 && L2.ok) return { pts: L2.pts.slice().reverse(), ok: true, draft: L2.draft };
    return L1 || L2 || null;
}
// 航路を探してもらう（近い所から先に）
function _tfLaneNeed(a, b, urgent) {
    const L = _tfLane(a, b);
    if (L) { if (urgent && L.state === 'queued') { const q = traffic.laneQ.find(x => x.a.key === a.key && x.b.key === b.key); if (q) q.urgent = true; } return L; }
    const me = _tfPlayerLL();
    const pri = Math.min(_tfDist(me, a), _tfDist(me, b));
    const st = { state: 'queued' };
    traffic.lanes.set(a.key + '|' + b.key, st);
    traffic.laneQ.push({ a, b, pri, urgent: !!urgent });
    return st;
}
function _tfLanePump() {
    if (traffic.laneBusy || !traffic.laneQ.length || typeof worldPlanRoute !== 'function') return;
    if (typeof autopilot !== 'undefined' && autopilot.planning) return;      // 自分の船の航路探しが先
    // 近い所から（自分の船が動けば、近さも変わる）
    const me = _tfPlayerLL();
    // （地図で置いた・行き先を変えた船は、いちばん先に）
    for (const q of traffic.laneQ) q.pri = q.urgent ? -1 : Math.min(_tfDist(me, q.a), _tfDist(me, q.b));
    traffic.laneQ.sort((x, y) => x.pri - y.pri);
    const q = traffic.laneQ.shift(), key = traffic.key, slot = traffic.lanes.get(q.a.key + '|' + q.b.key);
    traffic.laneBusy = true;
    const done = (pts, draft) => {
        traffic.laneBusy = false;
        if (traffic.key !== key) return;
        if (pts) traffic.lanes.set(q.a.key + '|' + q.b.key, { ok: true, draft, pts: pts.map(p => ({ lat: p.lat, lon: p.lon })) });
        else traffic.lanes.set(q.a.key + '|' + q.b.key, { fail: true });
        if (slot) slot.state = pts ? 'ok' : 'fail';
    };
    // いちばん深い船（喫水 12m：コンテナ船・タンカー）でも通れる道（喫水 13m）を探し、無ければ 11m、6m の道。
    //（以前は 11m の道からで、喫水が 10m より深い船（大きな客船・タンカーなど）は「この船には浅い」となって、どこへも出られず
    //  埠頭に止まったままだった。航路の道は、喫水＋1m の余裕で使う：_tfPlanVoyage）
    const A = { lat: q.a.lat, lon: q.a.lon }, B = { lat: q.b.lat, lon: q.b.lon };
    worldPlanRoute(A, B, { draft: 13, hw: 25 })
        .then(pts => done(pts, 13))
        .catch(() => worldPlanRoute(A, B, { draft: 11, hw: 25 }).then(pts => done(pts, 11))
            .catch(() => worldPlanRoute(A, B, { draft: 6, hw: 15 }).then(pts => done(pts, 6)).catch(() => done(null))));
}

// ════════════════════════════════════════════════════════════════
//  航海の道すじ
// ════════════════════════════════════════════════════════════════
// 行き先：{ P：埠頭 } か { G：外洋の出入口 }。海の出入口（航路の端）
function _tfEnd(x) { return x.P ? _tfSeaEnd(x.P) : { lat: x.G.lat, lon: x.G.lon, key: x.G.key }; }
// 道すじ：出発の港の航路（泊地 → 海の出入口）＋港の間の航路＋行き先の港の航路（海の出入口 → 泊地）。
//  ch：港の航路の中（右側を通る・ゆっくり）、nar：作り込んだ港の中（もっとゆっくり）
function _tfComposePath(S, from, to, lane) {
    const pts = [];
    const push = (q, ch, nar) => {
        const last = pts[pts.length - 1];
        if (last && _tfDist(last, q) < 30) { last.ch = last.ch || ch; return; }
        pts.push({ lat: q.lat, lon: q.lon, ch: !!ch, nar: !!nar });
    };
    if (from.P) { const ap = _tfApproach(from.P); for (let k = ap.length - 1; k >= 0; k--) push(ap[k], ap[k].ch, ap[k].nar); }
    else if (from.G) push(from.G, false);
    else if (from.pt) push(from.pt, false);
    let arriveIdx = -1;
    if (lane) for (const q of lane.pts) push(q, false);
    if (to.P) {
        const ap = _tfApproach(to.P);
        arriveIdx = Math.max(0, pts.length - 1);
        for (const q of ap) push(q, q.ch, q.nar);
        _tfFixArrival(S, pts, arriveIdx, to.P);
    } else if (to.G) push(to.G, false);
    return { pts, arriveIdx };
}
// 着く所の道すじの終わりを、その船に合わせる：
//  ・ドック・スリップの奥の埠頭：入口の外（回して入る所）で終わる（スリップの中へ道すじで入らない）
//  ・岸壁：船首（長さの半分＋20m 先）が浅い所・陸にかからない所まで戻す
function _tfFixArrival(S, pts, ai, P) {
    if (pts.length < 2) return;
    const g = _tfBerthGeo(S, P, Number.isFinite(S.toB) ? S.toB : 0);
    if (g && g.dock && g.out) {
        let j = pts.length - 1, best = Infinity;
        for (let k = Math.max(0, ai); k < pts.length; k++) { const d = _tfDist(pts[k], g.out); if (d < best) { best = d; j = k; } }
        pts.length = j + 1;
        if (best > 40) pts.push({ lat: g.out.lat, lon: g.out.lon, ch: true, nar: !!pts[j].nar });
        return;
    }
    const need = S.d + 1;
    for (let it = 0; it < 40 && pts.length >= 2; it++) {
        const a = pts[pts.length - 2], b = pts[pts.length - 1], dir = _tfBrg(a, b), seg = _tfDist(a, b);
        const bow = _tfOff(b, dir, S.L / 2 + 20), stern = _tfOff(b, dir + 180, S.L * 0.45);
        if (_tfBandOK(S, bow, dir, need) && _tfBandOK(S, b, dir, need) && _tfBandOK(S, stern, dir, need)) return;
        if (seg <= 25) { if (pts.length - 1 <= Math.max(1, ai)) return; pts.pop(); continue; }
        const q = _tfOff(b, dir + 180, 20); b.lat = q.lat; b.lon = q.lon;
    }
}
// 右側通行：港の航路の中の点を、水路の幅に余裕があれば右へ寄せる（行き会う船と左舷どうしですれ違う）
function _tfKeepRight(S, pts) {
    const need = S.d + 1.5;
    for (let k = 1; k < pts.length - 1; k++) {
        const q = pts[k];
        if (!q.ch || q.keep) continue;
        const b0 = _tfBrg(pts[k - 1], q), b1 = _tfBrg(q, pts[k + 1]);
        const br = b0 + _tfWrap(b1 - b0) / 2 + 90;              // 右の向き
        // 右と左に、どれだけ深い所が続くか
        let right = 0, left = 0;
        for (let r = 10; r <= 260; r += 10) { if (_tfDepth(_tfOff(q, br, r)) < need) break; right = r; }
        for (let r = 10; r <= 260; r += 10) { if (_tfDepth(_tfOff(q, br + 180, r)) < need) break; left = r; }
        const width = right + left;
        if (width < 2 * (S.B + 50)) continue;                  // 2 隻が並べるほどの幅が無い
        const off = Math.min(right - S.B / 2 - 20, Math.max(0, (width / 2 - left)) + Math.min(90, width * 0.22));
        if (!(off > 5)) continue;
        // 寄せた点と前後の点を結ぶ線も、深い所を通ること（曲がり角の内側の岬・岸を横切らない）
        for (const f of [1, 0.6, 0.3]) {
            const m = _tfOff(q, br, off * f);
            if (_tfSegDeep(S, pts[k - 1], m, need) && _tfSegDeep(S, m, pts[k + 1], need)) { q.lat = m.lat; q.lon = m.lon; q.keep = true; break; }
        }
    }
}
// A から B へまっすぐ進む船の幅の帯が、need[m] より深いか（20m おき）
function _tfSegDeep(S, A, B, need) {
    const n = Math.max(1, Math.ceil(_tfDist(A, B) / 20)), br = _tfBrg(A, B);
    for (let i = 0; i <= n; i++) { const q = _tfLerp(A, B, i / n); if (!_tfBandOK(S, q, br, need)) return false; }
    return true;
}
// 道すじの距離（航程線）と、点ごとの制限速力[m/s]
//  タグで回す角（円弧が旋回半径より小さい・その場で回す）は、その半径をタグで回せる速さまで
function _tfPrepPath(S, path) {
    const P = path.pts, cum = [0];
    for (let k = 1; k < P.length; k++) cum.push(cum[k - 1] + rhumbCourse(P[k - 1].lat, P[k - 1].lon, P[k].lat, P[k].lon).dist);
    const C = _tfClassOf(S), w = _tfRotRate(S) * _tfR;
    for (const q of P) {
        q.lim = q.nar ? _tfMs(Math.min(5, C.hk)) : q.ch ? _tfMs(C.hk) : S.vSea;
        if (q.piv || q.rad === 0) q.lim = Math.min(q.lim, 0.3);
        else if (q.as) q.lim = Math.min(q.lim, Math.max(0.4, q.rad * w));
    }
    path.cum = cum; path.total = cum[cum.length - 1]; path.crs = [];
    return path;
}
// 旋回半径[m]：ふつうの船は長さの 3 倍。保存した船は、その船の設定から（17-main-loop.js と同じ：舵が重心から離れているほど小さく回れる）
function _tfTurnR(S) {
    const sv = S.saved && S.saved.cfg;
    if (!sv) return 3 * S.L;
    const ph = sv.physics || {}, f = +ph.turningRadiusFactor > 0 ? +ph.turningRadiusFactor : 3;
    const lever = Math.abs(((sv.rudder && +sv.rudder.z) || 0) - ((sv.cg && +sv.cg.z) || 0)) * (+ph.scale || 12) / 12;
    return Math.max(1.2 * S.L, S.L * f / (1 + lever * 0.02));
}
function _tfRad(S) { if (S._RL !== S.L) { S._RL = S.L; S.R = _tfTurnR(S); } return S.R; }
// タグで（その場で）回す速さ[度/秒]
function _tfRotRate(S) { return Math.max(0.25, Math.min(1.5, 70 / S.L)); }
// C から東 e・北 n[m] の点
function _tfFromEN(C, e, n) {
    const mLat = _tfMLat();
    return { lat: C.lat + n / mLat, lon: C.lon + e / (mLat * Math.max(0.05, Math.cos(C.lat * _tfR))) };
}
// q で向き brg の船の幅の帯（真ん中・左右の舷の少し外）が、need[m] より深いか
function _tfBandOK(S, q, brg, need) {
    if (_tfDepthAt(q.lat, q.lon) < need) return false;
    const w = S.B / 2 + 6, a = _tfOff(q, brg + 90, w), b = _tfOff(q, brg - 90, w);
    return _tfDepthAt(a.lat, a.lon) >= need && _tfDepthAt(b.lat, b.lon) >= need;
}
// 道すじの角を、その船の旋回半径の円弧で丸める（その間を進むときは、船首の向き＝進む向き：横滑りしない）。
//  円弧が浅い所・陸にかかれば半径を小さくする（タグで回す：その分ゆっくり）。小さくしても無理なら、角で止まってその場で回す
//  点に付けるもの：rad（その円弧の半径。0 はその場で回す角）・as（タグで回す）・piv（大きく向きを変える角）
function _tfSmoothPath(S, path) {
    const P = path.pts;
    if (!P || P.length < 3) return path;
    const need = S.d + 1, R0 = _tfRad(S);
    const out = [], map = new Array(P.length);
    const push = (q, src, extra) => out.push(Object.assign({ lat: q.lat, lon: q.lon, ch: !!src.ch, nar: !!src.nar, keep: !!src.keep }, extra || {}));
    push(P[0], P[0]); map[0] = 0;
    let usedPrev = 0;                        // 前の角の円弧が、この区間を使った長さ
    for (let k = 1; k < P.length - 1; k++) {
        const A = P[k - 1], C = P[k], D = P[k + 1];
        const a = _tfEN(C, A), dd = _tfEN(C, D);
        const l1 = Math.hypot(a.e, a.n), l2 = Math.hypot(dd.e, dd.n);
        const b1 = Math.atan2(-a.e, -a.n), b2 = Math.atan2(dd.e, dd.n);   // 入る向き・出る向き（北から右回り）
        let th = b2 - b1;
        while (th > Math.PI) th -= 2 * Math.PI;
        while (th < -Math.PI) th += 2 * Math.PI;
        const ath = Math.abs(th);
        if (ath < 3 * _tfR || l1 < 1 || l2 < 1) { push(C, C); map[k] = out.length - 1; usedPrev = 0; continue; }
        if (ath > 150 * _tfR) { push(C, C, { piv: true, rad: 0, as: true }); map[k] = out.length - 1; usedPrev = 0; continue; }
        const tanH = Math.tan(ath / 2), sg = Math.sign(th);
        const T1 = l1 - usedPrev, T2 = (k + 1 === P.length - 1) ? l2 * 0.9 : l2 / 2;
        let R = Math.min(R0, Math.max(0, Math.min(T1, T2)) / tanH), arc = null;
        for (let tries = 0; tries < 8 && R > Math.max(8, S.B * 0.5); tries++, R *= 0.6) {
            const T = R * tanH;
            const sx = -Math.sin(b1) * T, sz = -Math.cos(b1) * T;                 // 円弧の始まり（角の手前 T）
            const ce = sx + sg * Math.cos(b1) * R, cn = sz - sg * Math.sin(b1) * R;   // 円の中心（曲がる側へ R）
            const nSeg = Math.max(2, Math.ceil(ath / (6 * _tfR)));
            const pts = [];
            let ok = true;
            for (let i = 0; i <= nSeg; i++) {
                const ang = b1 + th * i / nSeg;
                const q = _tfFromEN(C, ce - sg * Math.cos(ang) * R, cn + sg * Math.sin(ang) * R);
                if (!_tfBandOK(S, q, ang / _tfR, need)) { ok = false; break; }
                // 船首・船尾の振れ（小さく回るほど外へ振れる）
                if (R < 2.5 * S.L && (!_tfBandOK(S, _tfOff(q, ang / _tfR, S.L * 0.45), ang / _tfR, need) || !_tfBandOK(S, _tfOff(q, ang / _tfR + 180, S.L * 0.45), ang / _tfR, need))) { ok = false; break; }
                pts.push(q);
            }
            if (ok) { arc = { pts, R, T }; break; }
        }
        if (!arc) { push(C, C, { piv: ath > 60 * _tfR, rad: 0, as: true }); map[k] = out.length - 1; usedPrev = 0; continue; }
        const as = arc.R < R0 * 0.95;
        for (const q of arc.pts) push(q, C, { rad: arc.R, as });
        map[k] = out.length - 1 - (arc.pts.length >> 1);
        usedPrev = arc.T;
    }
    push(P[P.length - 1], P[P.length - 1]); map[P.length - 1] = out.length - 1;
    path.pts = out;
    if (path.arriveIdx >= 0) path.arriveIdx = map[path.arriveIdx];
    return path;
}
// 道すじを、今いる所から始める（離岸し終えた所・錨地など）：始めの近すぎる点（回し終えた所から 1.2 隻ぶん）は飛ばし、角を丸める
function _tfPathNear(S) { return Math.max(S.L * 1.2, 250); }
function _tfPathFromHere(S, path) {
    const pts = path.pts;
    let i = 0, best = Infinity, cum = 0;
    for (let k = 0; k < pts.length - 1 && cum < 4000; k++) { const d = _tfDist(S, pts[k]); if (d < best) { best = d; i = k; } cum += _tfDist(pts[k], pts[k + 1]); }
    while (i < pts.length - 1 && _tfDist(S, pts[i]) < _tfPathNear(S)) i++;
    const np = [{ lat: S.lat, lon: S.lon, ch: pts[i].ch, nar: pts[i].nar }].concat(pts.slice(i).map(q => ({ lat: q.lat, lon: q.lon, ch: q.ch, nar: q.nar, keep: q.keep })));
    const ai = path.arriveIdx >= 0 ? Math.max(0, path.arriveIdx - i + 1) : -1;
    return _tfPrepPath(S, _tfSmoothPath(S, { pts: np, arriveIdx: ai }));
}
// 区間 k の向き（覚えておく）と、s[m] の所の道すじの向き（円弧の上は、前後の区間となめらかにつなぐ）
function _tfSegCrs(P, k) {
    const c = P.crs || (P.crs = []);
    if (c[k] === undefined) { const a = P.pts[k], b = P.pts[Math.min(P.pts.length - 1, k + 1)]; c[k] = rhumbCourse(a.lat, a.lon, b.lat, b.lon).course; }
    return c[k];
}
function _tfTangent(P, s, k) {
    k = Math.max(0, Math.min(P.pts.length - 2, k));
    const crs = _tfSegCrs(P, k);
    const segL = (P.cum[k + 1] - P.cum[k]) || 1, u = Math.max(0, Math.min(1, (s - P.cum[k]) / segL));
    if (u < 0.5 && k > 0 && P.pts[k].rad > 0) return (crs + _tfWrap(_tfSegCrs(P, k - 1) - crs) * 0.5 * (1 - 2 * u) + 360) % 360;
    if (u >= 0.5 && k + 2 < P.pts.length && P.pts[k + 1].rad > 0) return (crs + _tfWrap(_tfSegCrs(P, k + 1) - crs) * 0.5 * (2 * u - 1) + 360) % 360;
    return crs;
}
// 道すじの上の s[m] の所
function _tfAlong(path, s) {
    const P = path.pts, cum = path.cum;
    if (s <= 0) return { lat: P[0].lat, lon: P[0].lon, k: 0 };
    if (s >= path.total) { const q = P[P.length - 1]; return { lat: q.lat, lon: q.lon, k: P.length - 2 }; }
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
    const u = (s - cum[lo]) / ((cum[hi] - cum[lo]) || 1), q = _tfLerp(P[lo], P[hi], u);
    return { lat: q.lat, lon: q.lon, k: lo };
}

// ════════════════════════════════════════════════════════════════
//  船を作る・航海を決める
// ════════════════════════════════════════════════════════════════
// 時代：「まぜる」のときは、乗っている船の就航〜引退の年（船の情報）があれば、その年と重なる時代の船だけ
//（昔：客船の時代 1880〜1970 年ごろ、今：1960 年ごろから）
const TF_ERA_YEARS = { old: [1880, 1970], new: [1960, 2200] };
function _tfEraOk(cls) {
    const e = (TF_CLASSES[cls] || {}).era;
    if (e === 'any') return true;
    if (traffic.era !== 'mix') return e === traffic.era;
    return _tfYearsOk(TF_ERA_YEARS[e]);
}
function _tfMakeShip(spec) {
    const C = TF_CLASSES[spec.cls] || TF_CLASSES.steamer;
    const L = spec.L || Math.round(_tfRand(C.L[0], C.L[1]));
    const B = spec.B || Math.round(L / C.LB * (0.92 + Math.random() * 0.16) * 10) / 10;
    const d = spec.d || Math.round(Math.min(C.d[1], Math.max(C.d[0], C.d[0] + (C.d[1] - C.d[0]) * (L - C.L[0]) / Math.max(1, C.L[1] - C.L[0]) + _tfRand(-0.4, 0.4))) * 10) / 10;
    const kn = spec.kn || Math.round(_tfRand(C.kn[0], C.kn[1]));
    let liv = spec.liv && TF_LIVERY[spec.liv] ? Object.assign({}, TF_LIVERY[spec.liv]) : null;
    if (!liv) {
        if (C.look === 'battleship' || C.look === 'cruiser' || C.look === 'destroyer') liv = Object.assign({}, TF_LIVERY[C.era === 'new' ? 'navymod' : 'navy']);
        else if (C.look === 'carrier') liv = Object.assign({}, TF_LIVERY.navymod);
        else if (C.look === 'cruise') liv = Object.assign({}, TF_LIVERY.cruise, { fun: _tfPick([0x1e3c72, 0xc8401e, 0xf7f7f4, 0x0f6e7a]) });
        else if (C.look === 'ferry') liv = { hull: _tfPick([0xf7f7f4, 0x1d3557, 0xc8401e]), boot: 0x1e3c72, sup: 0xf7f7f4, fun: _tfPick([0x1d3557, 0xc8401e, 0xe8c547]), top: 0x15161a };
        else if (C.look === 'fishing') liv = { hull: _tfPick([0x1d3557, 0x2e7d3c, 0x7a2e1b, 0xe8e2d0, 0x2b2f36]), boot: 0x8a2c20, sup: 0xf1ede2, fun: 0x15161a, top: 0x15161a };
        else liv = { hull: _tfPick(TF_RANDOM_HULL), boot: 0x8a2c20, sup: _tfPick([0xf1ede2, 0xe9e2cf, 0xd8cbb0]), fun: _tfPick(TF_RANDOM_FUN), top: 0x15161a };
    }
    const fun = spec.fun !== undefined ? spec.fun : Math.round(_tfRand(C.fun[0], C.fun[1]));
    const S = {
        id: traffic.nextId++, name: spec.name || '', line: spec.line || '', cls: spec.cls, L, B, d, kn, fun, liv,
        vSea: _tfMs(kn), svc: spec.route ? { route: spec.route, i: 0 } : null,
        st: 'pending', lat: 0, lon: 0, hdg: 0, v: 0, s: 0, path: null, port: null, from: null, to: null, steps: null, t: 0,
        acc: Math.min(0.08, Math.max(0.012, 4 / L)), seed: Math.random(), saved: spec.saved || null,
        off: 0, offT: 0, clrR: 0, clrL: 0,
    };
    if (!S.name) S.name = _tfNewName(S);
    return S;
}
// 船の名前の比べ方：大文字・小文字、空白・点・記号、頭の「RMS」「SS」「HMS」などの略号は見ない（RMS Olympic ＝ Olympic）
function _tfNameKey(n) {
    return String(n || '').normalize('NFKC').toLowerCase().trim()
        .replace(/^(r\.?m\.?s|s\.?s|m\.?v|m\.?s|h\.?m\.?s|u\.?s\.?s|h\.?m\.?h\.?s|t\.?s\.?s|s\.?t\.?s|t\.?s)\.?\s+/, '')
        .replace(/[\s.\-_・'’"]/g, '');
}
// 保存した船の名前（モデルの有る無し・使う使わないに関わらず、保存の一覧にある名前すべて）
function _tfSavedNameKeys() {
    const s = new Set();
    if (typeof loadAllShipSaves === 'function') for (const n of Object.keys(loadAllShipSaves())) { const k = _tfNameKey(n); if (k) s.add(k); }
    return s;
}
// 保存した船と同じ名前か（その保存した船そのものは除く）
function _tfSavedNameDup(n) { return !!(traffic.savedNames && traffic.savedNames.size && traffic.savedNames.has(_tfNameKey(n))); }
// 保存した船と同じ名前の他の船は出さない（保存の一覧が変わったとき：もう出ている船は居なくなったことにして、ほかの船に入れ替える）
function _tfDropSavedNameDupes() {
    for (const S of traffic.ships) {
        if (S.saved || S.placed || S.st === 'gone' || !_tfSavedNameDup(S.name)) continue;
        _tfDropMesh(S); S.st = 'gone';
    }
}
function _tfNewName(S) {
    const used = new Set(traffic.ships.map(o => o.name));
    //（保存した船と同じ名前は使わない）
    if (traffic.savedNames) for (const n of [...(TF_NAMES[S.cls] || TF_NAMES.steamer)]) if (_tfSavedNameDup(n)) used.add(n);
    if (world.kind !== 'real') {
        for (let k = 0; k < 40; k++) { const w = _tfPick(TF_GEN_SYL) + _tfPick(TF_GEN_SYL), n = w[0].toUpperCase() + w.slice(1) + ' Maru'; if (!used.has(n)) return n; }
    }
    const pool = TF_NAMES[S.cls] || TF_NAMES.steamer;
    for (let k = 0; k < 30; k++) { const n = _tfPick(pool); if (!used.has(n)) return n; }
    let n = _tfPick(pool), i = 2;
    while (used.has(n + ' ' + i)) i++;
    return n + ' ' + i;
}
// 決まった航路の行き先（名前）→ 埠頭か外洋の出入口
function _tfResolve(S, nm, avoidP) {
    const gates = TF_GATES[world.realKey] || [];
    if (/^g:/.test(nm)) { const G = gates.find(g => g.key === nm); return G ? { G } : null; }
    const ports = _tfPorts();
    let P = ports.find(p => p.name === nm);
    if (P) return { P };
    // 港のまとまりの名前：その中で、この船に合って空いている埠頭（無ければ合う埠頭のどれか）
    const grp = ports.filter(p => (p.group || p.name) === nm && p !== avoidP);
    if (!grp.length) return null;
    const ok = grp.filter(p => _tfSuits(S.cls, p) && _tfFits(S, p));
    const cands = ok.length ? ok : grp.filter(p => _tfFits(S, p));
    if (!cands.length) return null;
    const free = cands.filter(p => _tfSlotFind(p, S.L, S.id, S) !== null);
    return { P: _tfPick(free.length ? free : cands) };
}
// 次の行き先：決まった航路ならその次。ほかは、この船に合う港から（小さな船は近くの港、大きな船は遠くへも）
function _tfChooseDest(S) {
    if (S.svc) {
        const R = S.svc.route;
        for (let tries = 0; tries < R.length; tries++) {
            S.svc.i = (S.svc.i + 1) % R.length;
            const x = _tfResolve(S, R[S.svc.i], S.port);
            if (x && !(x.P && x.P === S.port)) return x;
        }
        return null;
    }
    const here = S.port ? { lat: S.port.lat, lon: S.port.lon } : { lat: S.lat, lon: S.lon };
    const maxD = { fishing: 120000, coastal: 900000, ferry: 600000 }[S.cls] || Infinity;
    const cands = _tfPorts().filter(p => p !== S.port && _tfSuits(S.cls, p) && _tfFits(S, p) && (!S.port || _tfGroupOf(p) !== _tfGroupOf(S.port)) && _tfDist(here, p) < maxD && _tfDist(here, p) > 3000);
    // 外洋の出入口（大きな客船・貨物船）
    const gates = world.kind === 'real' ? (TF_GATES[world.realKey] || []) : [];
    if (gates.length && !S.saved && ['liner', 'container', 'tanker', 'bulk', 'steamer', 'cruise'].includes(S.cls) && Math.random() < 0.3) return { G: _tfPick(gates) };
    if (!cands.length) return gates.length ? { G: _tfPick(gates) } : null;
    // 空いている埠頭を少しひいきする。遠すぎる所は少しだけ
    const me = _tfPlayerLL();
    const w = cands.map(p => (_tfSlotFind(p, S.L, S.id, S) !== null ? 2 : 1) / (1 + _tfDist(here, p) / 800000)
        * (S.saved ? 1 / Math.pow(1 + _tfDist(me, p) / 80000, 2) : 1));      // 保存した船は、自分の船の近くの港を多めに
    let r = Math.random() * w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < cands.length; i++) { r -= w[i]; if (r <= 0) return { P: cands[i] }; }
    return { P: cands[cands.length - 1] };
}

// ════════════════════════════════════════════════════════════════
//  船を並べる（世界を読んだとき）
// ════════════════════════════════════════════════════════════════
function _tfDwell(S) { const C = _tfClassOf(S); return _tfRand(C.dwell[0], C.dwell[1]) * 60; }
function _tfClear() {
    for (const S of traffic.ships) _tfDropMesh(S);
    if (typeof _tfTugClear === 'function') _tfTugClear();
    traffic.ships = []; traffic.lanes.clear(); traffic.laneQ = []; traffic.quays.clear(); traffic.anch.clear();
    traffic.ready = false; traffic.laneBusy = false; traffic.msgs = []; traffic.later = [];
    traffic.player.port = null; traffic.player.reserve = null;
}
// 自分の船が埠頭に付いて（止まって）いれば、その所を自分の船の分として押さえる（他の船が重ならないように）
function _tfPlayerBerthKeep() {
    const me = _tfPlayerLL(), stopped = Math.abs(physics.speed || 0) < 1.5;
    const L = (window.hullProfile && hullProfile.ready) ? hullProfile.halfLen * 2 * (physics.scale || 1) : 200;
    let found = null;
    if (stopped) for (const P of _tfPorts()) {
        const Q = _tfQuayFrame(P), d = _tfEN(P, me);
        const al = (P.seaBearing - 90) * _tfR, b = d.e * Math.sin(al) + d.n * Math.cos(al);
        const off = d.e * Math.sin(P.seaBearing * _tfR) + d.n * Math.cos(P.seaBearing * _tfR);
        if (Math.abs(off) < 120 + L * 0.2 && b > Q.b0 - L / 2 && b < Q.b1 + L / 2) { found = { P, b: Q.single ? 0 : Math.max(Q.b0 + L / 2, Math.min(Q.b1 - L / 2, b)) }; break; }
    }
    const cur = traffic.player.port;
    if (cur && (!found || found.P !== cur)) _tfSlotFree(cur, 'player');
    traffic.player.port = found ? found.P : null;
    if (found) {
        const Q = _tfQuayFrame(found.P), list = _tfQuayList(found.P);
        if (!list.some(o => o.who === 'player')) list.push(Q.single ? { b0: -1e9, b1: 1e9, who: 'player', res: false } : { b0: found.b - L / 2 - 15, b1: found.b + L / 2 + 15, who: 'player', res: false });
    }
}
function _tfSpawnFleet() {
    const ports = _tfPorts();
    if (!ports.length) return false;
    _tfPlayerBerthKeep();
    const rk = world.kind === 'real' ? world.realKey : null;
    const target = Math.round(Math.max(8, Math.min(90, ports.length * TF_DENSITY[traffic.density].k)));
    // 保存した船（自分の船のモデルは除く）
    for (const v of _tfSavedUsed()) {
        const S = _tfMakeShip(_tfSavedSpec(v));
        if (ports.some(p => _tfSuits(S.cls, p) && _tfFits(S, p))) traffic.ships.push(S); else traffic.nextId--;
    }
    // 決まった航路の船（少なめのときは、半分ほど）
    if (rk && TF_SERVICES[rk]) for (const sv of TF_SERVICES[rk]) {
        if (!_tfEraOk(sv.cls) || !_tfYearsOk(_tfYearsOf(sv)) || (traffic.density === 'few' && Math.random() < 0.5)) continue;
        if (_tfSavedNameDup(sv.name)) continue;          // 保存した船と同じ名前の船は出さない（保存した船の方を出す）
        traffic.ships.push(_tfMakeShip(sv));
    }
    // そのほかの船：その世界の港の種類に合う船を、出る割合で
    const classes = Object.keys(TF_CLASSES).filter(c => _tfEraOk(c) && ports.some(p => _tfSuits(c, p)));
    const wsum = classes.reduce((a, c) => a + TF_CLASSES[c].w, 0);
    for (let guard = 0; traffic.ships.length < target && guard < 600; guard++) {
        let r = Math.random() * wsum, cls = classes[0];
        for (const c of classes) { r -= TF_CLASSES[c].w; if (r <= 0) { cls = c; break; } }
        const S = _tfMakeShip({ cls });
        if (ports.some(p => _tfSuits(cls, p) && _tfFits(S, p))) traffic.ships.push(S); else traffic.nextId--;
    }
    // 始めの様子：埠頭に付いている・港の航路を入ってくる・出ていくところ・海の上
    for (const S of traffic.ships) _tfSeed(S);
    _tfUnstack();
    return true;
}
// 航路の上に置いた船が重なっていれば、後ろへずらす（ずらせなければ、居なかったことに：あとで入れ替わる）
function _tfUnstack() {
    const L = traffic.ships.filter(S => S.st === 'go' && S.path);
    for (let it = 0; it < 4; it++) {
        let moved = false;
        for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
            const A = L[i], B = L[j];
            if (A.st !== 'go' || B.st !== 'go' || Math.abs(A.lat - B.lat) > 0.05) continue;
            if (_tfDist(A, B) > (A.L + B.L) / 2 + 120) continue;
            const M = A.s >= B.s ? B : A;              // 後ろにいる方（道すじの上で手前）をずらす
            const back = (A.L + B.L) / 2 + 300;
            if (M.s > back) { M.s -= back; _tfSnapToPath(M); moved = true; }
            else { M.st = 'gone'; }
        }
        if (!moved) break;
    }
}
function _tfSeed(S) {
    const ports = _tfPorts().filter(p => _tfSuits(S.cls, p) && _tfFits(S, p));
    let home = null;
    if (S.svc) {
        const R = S.svc.route, order = R.map((_, i) => i).sort(() => Math.random() - 0.5);
        for (const i of order) { const x = _tfResolve(S, R[i]); if (x && x.P) { home = x.P; S.svc.i = i; break; } }
        if (!home) { const x = _tfResolve(S, R[0]); if (x && x.G) { S.svc.i = 0; _tfGoOff(S, x.G, _tfRand(0, 3600)); } else S.st = 'gone'; return; }
    } else if (S.saved && ports.length) {
        // 保存した船は、自分の船の近くの港に
        const me = _tfPlayerLL(), near = ports.slice().sort((a, b) => _tfDist(me, a) - _tfDist(me, b)).slice(0, 6);
        home = _tfPick(near);
    } else if (ports.length) home = _tfPick(ports);
    if (!home) { S.st = 'gone'; return; }
    // 保存した船は、すぐ近くに見えるよう、埠頭か港の航路に（海の上の途中には置かない）
    const r = S.saved ? Math.random() * 0.82 : Math.random();
    if (r < 0.5 && _tfPlaceBerthed(S, home, Math.random())) return;
    if (r < 0.62 && _tfPlaceBerthed(S, home, 0)) return;            // もうすぐ出港
    const bIn = r < 0.82 ? _tfSlotFind(home, S.L, S.id, S) : null;
    if (bIn !== null) {
        // 港の航路を入ってくるところ（どこかから来た）。（埠頭が空いていなければ、海の上に置く）
        const b = bIn;
        _tfSlotTake(home, b, S.L, S.id, true);
        S.to = { P: home }; S.toB = b; S.port = null;
        const others = ports.filter(p => p !== home && _tfGroupOf(p) !== _tfGroupOf(home));
        S.from = others.length ? { P: _tfPick(others) } : null;
        const path = _tfComposePath(S, { pt: _tfSeaEnd(home) }, S.to, null);
        path.arriveIdx = 0;
        _tfKeepRight(S, path.pts); S.path = _tfPrepPath(S, _tfSmoothPath(S, path));
        S.s = Math.random() * S.path.total * 0.9; S.checked = true;
        _tfSnapToPath(S);
        S.v = Math.min(S.vSea, S.path.pts[Math.min(S.path.pts.length - 1, S.k + 1)].lim);
        S.st = 'go';
        return;
    }
    // 海の上：航路が見つかったら、その途中に置く
    S.port = home; S.seedMid = 0.1 + Math.random() * 0.8; S.st = 'pending';
}
function _tfPlaceBerthed(S, P, dwellFrac) {
    const b = _tfSlotFind(P, S.L, S.id, S);
    if (b === null) return false;
    _tfSlotTake(P, b, S.L, S.id, false);
    const g = _tfBerthGeo(S, P, b);
    S.port = P; S.slotB = b; S.geo = g;
    S.lat = g.pos.lat; S.lon = g.pos.lon;
    S.hdg = g.dock ? g.hdg : (Math.random() < 0.5 ? g.hdg : (g.hdg + 180) % 360);
    S.v = 0; S.st = 'berth'; S.t = dwellFrac * _tfDwell(S); S.path = null; S.to = null;
    return true;
}
function _tfSnapToPath(S) {
    const q = _tfAlong(S.path, S.s);
    S.lat = q.lat; S.lon = q.lon; S.k = q.k;
    const P = S.path.pts, a = P[q.k], b = P[Math.min(P.length - 1, q.k + 1)];
    S.hdg = rhumbCourse(a.lat, a.lon, b.lat, b.lon).course;
}
function _tfGoOff(S, G, t) {
    _tfDropMesh(S);
    if (S.port) _tfSlotFree(S.port, S.id);
    S.st = 'off'; S.gate = G; S.lat = G.lat; S.lon = G.lon; S.v = 0; S.t = t; S.port = null; S.to = null; S.path = null; S.steps = null;
}

// ════════════════════════════════════════════════════════════════
//  出港・入港
// ════════════════════════════════════════════════════════════════
// 次の航海を決め、港の間の航路を探してもらう。航路がそろえば true
function _tfPlanVoyage(S) {
    if (!S.to) {
        const x = _tfChooseDest(S);
        if (!x) return false;
        S.to = x; S.toB = null; S.checked = false;
        if (x.P) { const b = _tfSlotFind(x.P, S.L, S.id, S); if (b !== null) { _tfSlotTake(x.P, b, S.L, S.id, true); S.toB = b; } }
    }
    const a = S.port ? _tfSeaEnd(S.port) : S.gate ? { lat: S.gate.lat, lon: S.gate.lon, key: S.gate.key } : null;
    if (!a) return false;
    const L = _tfLaneNeed(a, _tfEnd(S.to));
    if (L && (L.fail || L.state === 'fail' || (L.ok && L.draft < S.d + 1))) {
        // 行けない（海とつながっていない・この船には浅い）：ほかの所にする
        if (S.to.P) { const sl = _tfSlotOf(S.to.P, S.id); if (sl && sl.res) _tfSlotFree(S.to.P, S.id); }
        S.to = null; S.failN = (S.failN || 0) + 1;
        if (S.svc && S.failN > 3) S.svc = null;              // 決まった航路が回れない世界：ふつうの船に
        return false;
    }
    return !!(L && L.ok);
}
function _tfTryDepart(S, far) {
    if (!_tfPlanVoyage(S)) { S.t = 20 + Math.random() * 20; return; }
    const from = S.port ? { P: S.port } : { G: S.gate };
    const lane = _tfLane(_tfEnd(from), _tfEnd(S.to));
    if (!lane || !lane.ok) { S.t = 20; return; }
    const path = _tfComposePath(S, from, S.to, lane);
    _tfKeepRight(S, path.pts);
    S.path = _tfPrepPath(S, far || !S.port ? _tfSmoothPath(S, path) : path); S.s = 0; S.k = 0; S.checked = false; S.from = from; S.off = 0;
    if (S.port) {
        if (!far) {
            const busy = _tfZoneBusy(S, S.geo);
            if (busy) { S.t = 20; S.waitSince = S.waitSince ?? traffic.t; S.waitWhy = busy === 'player' ? '自分の船の動きを待っています' : `${busy.name} の離着岸・通過を待っています`; return; }
        }
        S.waitWhy = ''; S.waitSince = null;
        //（出ていく埠頭は、離岸し終えるまで押さえたまま：_tfManeuverDone で外す）
        // 行き先の予約は残す（_tfSlotFree は出港する港の分だけ消す）
        //（前に決めた所がその後ふさがった・自分の船が押さえたときは、取り直さない：着く前にもう一度探す）
        if (S.to.P && !_tfSlotOf(S.to.P, S.id)) { const b = _tfSlotFind(S.to.P, S.L, S.id, S); if (b !== null) { _tfSlotTake(S.to.P, b, S.L, S.id, true); S.toB = b; } else S.toB = null; }
        const P = S.port; S.port = null;
        if (far) { _tfSlotFree(P, S.id); _tfSnapToPath(S); S.st = 'go'; S.v = 0; return; }
        S.steps = _tfUnberthSteps(S, S.path); S.st = 'unberth'; S.mPort = P; S.v = 0; _tfManeuverBegin(S);
        _tfHorn(S, 'L');
        if (S.dPl < 8000) _tfMsg(`${S.name}（${_tfClassOf(S).label}）が ${P.name} を離岸します`);
    } else {
        // 外洋の出入口から入ってくる
        S.gate = null; _tfSnapToPath(S); S.st = 'go'; S.v = S.vSea;
    }
}
function _tfUnberthSteps(S, path) {
    const g = S.geo, rp = g.dock ? g.out : g.turn;
    // 回し終えたら向かう所：道すじの、回す所から 1.2 隻ぶんより先の最初の点（_tfPathFromHere と同じ）
    let nxt = path.pts[path.pts.length - 1], i0 = 0, best = Infinity, cum = 0;
    for (let k = 0; k < path.pts.length - 1 && cum < 4000; k++) { const d = _tfDist(rp, path.pts[k]); if (d < best) { best = d; i0 = k; } cum += _tfDist(path.pts[k], path.pts[k + 1]); }
    for (let k = i0; k < path.pts.length; k++) if (_tfDist(rp, path.pts[k]) >= _tfPathNear(S)) { nxt = path.pts[k]; break; }
    const steps = [{ k: 'wait', t: 40 }];
    if (g.dock) {
        steps.push({ k: 'move', to: g.mid, v: 0.3 }, { k: 'move', to: g.door, v: 0.8 }, { k: 'move', to: g.out, v: 0.9 }, { k: 'rot', hdg: _tfBrg(g.out, nxt) });
    } else {
        steps.push({ k: 'move', to: g.turn, v: 0.35 }, { k: 'rot', hdg: _tfBrg(g.turn, nxt) });
    }
    return steps;
}
function _tfBerthSteps(S) {
    const g = S.geo, steps = [];
    // （泊地から回す所までは、前へ進んで：横へは滑らない。向きが大きく違えば、先にタグで向ける）
    if (g.dock) {
        steps.push({ k: 'go', to: g.out, v: 0.8 }, { k: 'rot', hdg: g.hdg }, { k: 'move', to: g.door, v: 0.9 }, { k: 'move', to: g.mid, v: 0.8 }, { k: 'move', to: g.pos, v: 0.3 });
        S.berthHdg = g.hdg;
    } else {
        // 着いたときの船首の向きに近い方の向きで付ける。回す所が近ければ（船の長さの 4 割まで）、向きを変えずにタグで運ぶ
        const h1 = g.hdg, h2 = (g.hdg + 180) % 360, hin = S.hdg;
        const h = Math.abs(_tfWrap(h1 - hin)) <= Math.abs(_tfWrap(h2 - hin)) ? h1 : h2;
        steps.push(_tfDist(S, g.turn) < Math.max(60, S.L * 0.4) ? { k: 'move', to: g.turn, v: 0.5 } : { k: 'go', to: g.turn, v: 0.8 }, { k: 'rot', hdg: h }, { k: 'move', to: g.pos, v: 0.3 });
        S.berthHdg = h;
    }
    steps.push({ k: 'wait', t: 40 });
    return steps;
}
// 離着岸のとき、ほかの船（自分の船も）が近くで離着岸していないか（同じスリップ・となりの埠頭）
function _tfZoneOf(S) { const g = S.geo; return g ? (g.dock ? g.out : g.turn) : null; }
// 離着岸で使う場所：回す所（船の長さの円）と、岸壁の前から回す所までの間（途中も）
function _tfZoneCircles(S, g) {
    const c = g.dock ? g.out : g.turn, z = [{ q: c, r: S.L / 2 + 20 }];
    const pts = g.dock ? [g.pos, g.mid, g.door, c] : [g.pos, c];
    for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1], n = Math.max(1, Math.ceil(_tfDist(a, b) / Math.max(40, S.B)));
        for (let j = 0; j < n; j++) { const u = j / n; z.push({ q: { lat: a.lat + (b.lat - a.lat) * u, lon: a.lon + (b.lon - a.lon) * u }, r: S.L / 2 }); }
    }
    return z;
}
function _tfZoneBusy(S, g) {
    if (!g) return null;
    const Z = _tfZoneCircles(S, g), myWait = S.waitSince ?? traffic.t;
    const inZ = (q, extra) => { for (const z of Z) if (_tfDist(z.q, q) < z.r + extra) return true; return false; };
    for (const O of traffic.ships) {
        if (O === S || !_tfShown(O) || Math.abs(O.lat - S.lat) > 0.06) continue;
        if (O.st === 'berthing' || O.st === 'unberth') {
            // ほかの船の離着岸（同じドック・となりの埠頭）：終わるまで待つ
            const Zo = O.geo ? _tfZoneCircles(O, O.geo) : [{ q: O, r: O.L / 2 }];
            for (const zo of Zo) if (inZ(zo.q, zo.r)) return O;
            continue;
        }
        if (O.st === 'berth' || O.st === 'anchored') continue;
        if (O.blockBy === S.id) continue;             // （この船を待って止まっている船）
        // 止まって待っている船は、先に待ち始めた方が先（後から待ち始めた船は、こちらを待つ）
        const stopped = (O.v || 0) <= 0.3;
        if (stopped) { const ow = O.st === 'holding' ? O.waitSince : O.blockT0; if (!(ow != null && ow < myWait)) continue; }
        // 待っている・進んでいる船が、今その場所にいる
        if (inZ(O, O.L / 2 + 10)) return O;
        // 止まれないうちに、その場所を通る船
        if (!stopped && O.path && (O.st === 'go' || O.st === 'anchoring')) {
            const stop = O.v * O.v / (2 * Math.max(0.01, O.acc * 1.2)) + O.L / 2 + 150;
            for (let s2 = O.s; s2 <= Math.min(O.path.total, O.s + stop); s2 += 40) if (inZ(_tfAlong(O.path, s2), O.B / 2 + 10)) return O;
        }
    }
    // 自分の船：離着岸の途中・動いていてその場所に来る（止まって埠頭に付いているときは、となりでも構わない）
    if (typeof harborAuto !== 'undefined' && harborAuto.mode && harborAuto.plan && harborAuto.plan.turn && typeof worldLocalToUnit === 'function') {
        const t = worldUnitToLatLon(worldLocalToUnit(harborAuto.plan.turn.x, harborAuto.plan.turn.z));
        if (inZ(t, 300)) return 'player';
    }
    const M = _tfPlayerAsShipSafe();
    if (M && !traffic.player.port) {
        if (inZ(M, M.L / 2 + 10)) return 'player';
        if (M.v > 0.3) for (let tt = 30; tt <= 180; tt += 30) if (inZ(_tfOff(M, M.hdg, M.v * tt), M.L / 2)) return 'player';
    }
    return null;
}
// 行き先の港の航路に入る前（海の出入口の手前）：埠頭が空いていなければ、錨地で待つ
function _tfArriveCheck(S) {
    if (S.checked || !S.to || !S.to.P || !S.path || S.path.arriveIdx < 0) return;
    if (S.s < S.path.cum[S.path.arriveIdx] - 1500) return;
    S.checked = true;
    const P = S.to.P;
    if (_tfSlotOf(P, S.id)) return;
    const b = _tfSlotFind(P, S.L, S.id, S);
    if (b !== null) { _tfSlotTake(P, b, S.L, S.id, true); S.toB = b; return; }
    _tfToAnchor(S);
}
function _tfToAnchor(S) {
    const P = S.to.P, se = _tfSeaEnd(P);
    let tgt = _tfAnchorFor(S, P);
    if (!tgt) {
        // 錨地がいっぱい：見えない所なら、ほかへ行ったことにする。見える所なら、海の出入口の少し脇で待つ
        if (!(S.dPl < TF_SHOW)) { S.st = 'gone'; return; }
        const ap = _tfApproach(P), inb = ap.length > 1 ? _tfBrg(ap[0], ap[1]) : (P.seaBearing + 180) % 360;
        for (const side of [90, -90, 135, -135, 0]) {
            const q = _tfOff(se, inb + 180 + side, 900);
            if (_tfDepthAt(q.lat, q.lon) >= S.d + 4 && traffic.ships.every(o => o === S || !o.anch || _tfDist(o.anch, q) > 700)) { tgt = { lat: q.lat, lon: q.lon, d: _tfDepthAt(q.lat, q.lon) }; break; }
        }
        if (!tgt) tgt = { lat: se.lat, lon: se.lon, d: 30 };
    }
    S.anch = tgt;
    // 道すじ：港の航路の中にいれば、来た道を海の出入口まで戻ってから（港の中は、泊地で回してから）
    const pts = [{ lat: S.lat, lon: S.lon, ch: true }];
    const Pa = S.path;
    if (Pa && Pa.arriveIdx >= 0 && S.k >= Pa.arriveIdx) for (let k = Math.min(S.k, Pa.pts.length - 1); k >= Pa.arriveIdx; k--) pts.push({ lat: Pa.pts[k].lat, lon: Pa.pts[k].lon, ch: Pa.pts[k].ch, nar: Pa.pts[k].nar });
    pts.push({ lat: tgt.lat, lon: tgt.lon, ch: false });
    S.path = _tfPrepPath(S, _tfSmoothPath(S, { pts, arriveIdx: -1 }));
    for (const q of S.path.pts) q.lim = Math.min(q.lim, _tfMs(8));
    S.s = 0; S.k = 0; S.off = 0; S.st = 'anchoring'; S.checked = true;
    if (S.dPl < 15000) _tfMsg(`${S.name}：${worldBerthLabel ? worldBerthLabel(P) : P.name} がふさがっているので、錨地で待ちます`);
}
// 道すじの終わりに着いた
function _tfArrive(S, far) {
    if (S.st === 'anchoring') { S.st = 'anchored'; S.v = 0; S.t = 10 + Math.random() * 10; return; }
    if (S.to && S.to.G) { _tfGoOff(S, S.to.G, _tfRand(1800, 5400)); return; }
    if (!S.to || !S.to.P) { S.st = 'gone'; return; }
    const P = S.to.P;
    let sl = _tfSlotOf(P, S.id);
    if (!sl) { const b = _tfSlotFind(P, S.L, S.id, S); if (b !== null) { _tfSlotTake(P, b, S.L, S.id, true); S.toB = b; sl = _tfSlotOf(P, S.id); } }
    // 埠頭が空いていない（自分の船が押さえた・となりの船と重なる）：港の中で待たずに、来た道を錨地へ
    if (!sl) { _tfToAnchor(S); return; }
    const b = (sl.b0 + sl.b1) / 2;
    S.geo = _tfBerthGeo(S, P, _tfQuayFrame(P).single ? 0 : b);
    if (!far) {
        const busy = _tfZoneBusy(S, S.geo);
        if (busy) { S.st = 'holding'; S.v = 0; S.t = 15; S.waitSince = S.waitSince ?? traffic.t; S.waitWhy = busy === 'player' ? '自分の船の動きを待っています' : `${busy.name} の離着岸・通過を待っています`; return; }
    }
    sl.res = false; S.port = P; S.slotB = b; S.waitWhy = ''; S.waitSince = null;
    S.steps = _tfBerthSteps(S);
    if (far) { _tfFinish(S); return; }
    S.st = 'berthing'; S.mPort = P; _tfManeuverBegin(S);
    if (S.dPl < 8000) _tfMsg(`${S.name}（${_tfClassOf(S).label}）が ${P.name} に着岸します`);
}
// 離着岸の動き（タグに押されて横へ・その場で回る・ドックをまっすぐ出入り）
// 離着岸の次の動きの場所に、ほかの船（待っている・進んでいる船・自分の船）がいるか：その船の名前
function _tfStepBlocked(S, st) {
    const shapes = [];
    if (st.k === 'rot') { const c = _tfEN(S, S); shapes.push({ ae: c.e, an: c.n, be: c.e, bn: c.n, r: S.L / 2 + 5 }); }
    else if (st.to) {
        const h = st.k === 'go' ? _tfBrg(S, st.to) : S.hdg;
        const n = Math.max(1, Math.ceil(_tfDist(S, st.to) / Math.max(30, S.B)));
        for (let j = 0; j <= n; j++) { const u = j / n; shapes.push(_tfCapOf(S, { lat: S.lat + (st.to.lat - S.lat) * u, lon: S.lon + (st.to.lon - S.lon) * u }, h, S.L, S.B + 6)); }
    } else return null;
    const test = (O, L, B) => {
        const c = _tfCapOf(S, O, O.hdg, L, B);
        for (const sh of shapes) if (_tfCapDist(sh, c) < 0) return true;
        return false;
    };
    for (const O of traffic.ships) {
        if (O === S || !_tfShown(O) || O.st === 'berth' || O.st === 'anchored' || O.st === 'berthing' || O.st === 'unberth') continue;
        if (Math.abs(O.lat - S.lat) > 0.03 || _tfDist(S, O) > S.L + O.L + 400) continue;
        if (test(O, O.L, O.B)) { S.pausedById = O.id; return O.name; }
    }
    const M = _tfPlayerAsShipSafe();
    if (M && _tfDist(S, M) < S.L + M.L + 400 && test(M, M.L, M.B)) return 'あなたの船';
    return null;
}
function _tfManeuver(S, d) {
    const st = S.steps && S.steps[0];
    S.turning = false;
    if (!st) { _tfManeuverDone(S); return; }
    if (st.k === 'wait') { st.t -= d; S.v = 0; if (st.t <= 0) S.steps.shift(); return; }
    // 次に動く所（回す円・動いていく帯）に、ほかの船がいれば、出ていくまで待つ。
    // 長く（離岸は 1 分半・着岸は 2 分半）あかなければ、いったん来た所（岸壁・泊地）へ戻って、あとでやり直す
    //（その船も、こちらを待って動けないことがある：川の中でみんなが止まってしまわないように）
    if (!S.aborting) {
        if (traffic.t >= (S.pauseChk || 0)) { S.pauseChk = traffic.t + 1; S.pausedById = null; S.pausedBy = _tfStepBlocked(S, st); }
        if (S.pausedBy) {
            S.pauseT = (S.pauseT || 0) + d;
            if (S.pauseT > (S.st === 'unberth' ? 90 : 150) && S.mStart) { _tfManeuverAbort(S); return; }
            S.v = 0; S.why = `${S.pausedBy} が出ていくのを待っています`; return;
        }
        S.pauseT = 0;
    }
    if (st.k === 'rot') {
        const e = _tfWrap(st.hdg - S.hdg), rate = _tfRotRate(S) * d;
        S.hdg = (S.hdg + Math.sign(e) * Math.min(Math.abs(e), rate) + 360) % 360; S.v = 0; S.turning = true;
        if (Math.abs(e) < 0.4) S.steps.shift();
        return;
    }
    const dd = _tfEN(S, st.to), dist = Math.hypot(dd.e, dd.n), dir = Math.atan2(dd.e, dd.n) / _tfR;
    if (st.k === 'go' && dist > Math.max(60, S.L * 0.4)) {
        // 前へ進んで向かう：向きが 20° より違えば、止まってタグで向けてから。進みながら少しずつ向ける（船首の向きに進む）
        const e = _tfWrap(dir - S.hdg), w = _tfRotRate(S) * d;
        if (Math.abs(e) > 20) { S.hdg = (S.hdg + Math.sign(e) * Math.min(Math.abs(e), w) + 360) % 360; S.v = Math.max(0, S.v - 0.05 * d); S.turning = true; return; }
        const v = Math.min(st.v, 0.15 + dist * 0.01);
        S.v += Math.max(-0.05 * d, Math.min(0.02 * d, v - S.v));
        S.hdg = (S.hdg + Math.sign(e) * Math.min(Math.abs(e), w) + 360) % 360;
        const m = _tfOff(S, S.hdg, Math.min(dist, S.v * d)); S.lat = m.lat; S.lon = m.lon;
        return;
    }
    // （タグで押す・引く：横へ、またはドックの中をまっすぐ）
    const v = Math.min(st.v, 0.05 + dist * 0.04);
    const step = Math.min(dist, v * d);
    if (dist > 0.01) { const m = _tfOff(S, dir, step); S.lat = m.lat; S.lon = m.lon; }
    S.v = v * Math.cos(_tfWrap(dir - S.hdg) * _tfR);
    if (Math.abs(_tfWrap(dir - S.hdg)) > 30 && Math.abs(_tfWrap(dir - S.hdg)) < 150) S.turning = true;
    if (dist - step < 0.4) { S.steps.shift(); if (S.mHist && !S.aborting) S.mHist.push({ lat: st.to.lat, lon: st.to.lon }); }
}
function _tfManeuverBegin(S) {
    S.mStart = { lat: S.lat, lon: S.lon, hdg: S.hdg }; S.mHist = [{ lat: S.lat, lon: S.lon }];
    S.pauseT = 0; S.aborting = false; S.pausedBy = null;
}
// 離着岸をやめて、来た所へ戻る（向きを戻してから、通った所を逆にたどって）
function _tfManeuverAbort(S) {
    const back = [];
    if (Math.abs(_tfWrap(S.mStart.hdg - S.hdg)) > 1) back.push({ k: 'rot', hdg: S.mStart.hdg });
    const H = (S.mHist || []).slice();
    for (let i = H.length - 1; i >= 0; i--) if (_tfDist(S, H[i]) > 3 || i === 0) back.push({ k: 'move', to: H[i], v: 0.4 });
    S.steps = back; S.aborting = true; S.pausedBy = null; S.pauseT = 0;
    if (S.dPl < 8000) _tfMsg(`${S.name}：場所があかないので、いったん${S.st === 'unberth' ? '岸壁' : '泊地'}へ戻ります`);
}
function _tfManeuverDone(S) {
    if (S.aborting) {
        S.aborting = false; S.steps = null; S.turning = false; S.mHist = null;
        if (S.st === 'unberth') { S.st = 'berth'; S.port = S.mPort; S.mPort = null; S.v = 0; S.t = 120 + Math.random() * 120; S.hdg = S.mStart.hdg; }
        else { S.st = 'holding'; S.port = null; S.mPort = null; S.v = 0; S.t = 40 + Math.random() * 40; S.hdg = S.mStart.hdg; S.waitSince = traffic.t; }
        return;
    }
    if (S.st === 'unberth' && S.mPort) _tfSlotFree(S.mPort, S.id);
    S.steps = null; S.mPort = null; S.turning = false;
    if (S.st === 'unberth') {
        S.st = 'go'; S.v = 0.3; S.checked = false; S.off = 0;
        // 道すじを、回し終えた今の所から始める
        if (S.path) { S.path = _tfPathFromHere(S, S.path); S.s = 0; S.k = 0; }
    }
    else if (S.st === 'berthing') {
        S.st = 'berth'; S.v = 0; S.t = _tfDwell(S); S.to = null; S.from = null; S.path = null;
        if (S.berthHdg !== undefined) S.hdg = S.berthHdg;
    }
}
function _tfFinish(S) {
    if (S.steps) for (const st of S.steps) { if (st.k === 'move' || st.k === 'go') { S.lat = st.to.lat; S.lon = st.to.lon; } else if (st.k === 'rot') S.hdg = st.hdg; }
    if (S.st !== 'unberth' && S.st !== 'berthing') S.st = 'berthing';
    S.steps = [];
    _tfManeuverDone(S);
    if (S.st === 'go') _tfSnapToPath(S);
}

// ════════════════════════════════════════════════════════════════
//  動かす
// ════════════════════════════════════════════════════════════════
// 視程[m]（霧・雨）
function _tfVisM() {
    const w = window.weather;
    if (!w || !w.enabled) return 15000;
    return Math.max(150, 15000 * Math.exp(-4.6 * (w.fog || 0)) * (1 - 0.45 * (w.rain || 0)));
}
// 海の上の船を、港の間の航路の途中に置く（始めに「海の上」とした船）
function _tfSeedMid(S) {
    if (!_tfPlanVoyage(S)) return false;
    const from = { P: S.port };
    const lane = _tfLane(_tfEnd(from), _tfEnd(S.to));
    if (!lane || !lane.ok) return false;
    const path = _tfComposePath(S, from, S.to, lane);
    _tfKeepRight(S, path.pts);
    S.path = _tfPrepPath(S, _tfSmoothPath(S, path));
    const a0 = _tfApproach(S.port).length - 1, a1 = path.arriveIdx >= 0 ? path.arriveIdx : path.pts.length - 1;
    const s0 = S.path.cum[Math.min(a0, S.path.cum.length - 1)], s1 = S.path.cum[a1];
    S.s = s0 + (s1 - s0) * S.seedMid; S.seedMid = undefined;
    S.from = from; S.port = null; S.checked = false;
    _tfSnapToPath(S); S.v = S.vSea; S.st = 'go';
    return true;
}
// 錨地で待っている船：埠頭が空いたら、錨地から港の航路へ
function _tfFromAnchor(S) {
    const P = S.to && S.to.P;
    if (!P || (S.anchorTries = (S.anchorTries || 0) + 1) > 60) { S.st = 'gone'; return; }     // （30 分ほど待っても空かなければ、よそへ）
    let sl = _tfSlotOf(P, S.id);
    if (!sl) { const b = _tfSlotFind(P, S.L, S.id, S); if (b !== null) { _tfSlotTake(P, b, S.L, S.id, true); S.toB = b; sl = true; } }
    if (!sl) { S.t = 20 + Math.random() * 20; return; }
    const path = _tfComposePath(S, { pt: { lat: S.lat, lon: S.lon } }, S.to, null);
    path.arriveIdx = 0;
    _tfKeepRight(S, path.pts);
    S.path = _tfPrepPath(S, _tfSmoothPath(S, path)); S.s = 0; S.k = 0; S.checked = true; S.anch = null; S.off = 0;
    S.st = 'go'; S.v = 0;
    _tfHorn(S, 'S1');
    if (S.dPl < 15000) _tfMsg(`${S.name}：錨を上げて ${worldBerthLabel ? worldBerthLabel(P) : P.name} へ向かいます`);
}
function _tfStep(S, d, far) {
    // 追従を頼まれた船：動ける状態になったら付いていく（岸壁に着いている船は、早めに離岸してから）
    if (S.followReq) {
        if (S.st === 'go' || S.st === 'anchoring' || S.st === 'anchored' || S.st === 'holding' || S.st === 'placed') _tfFollowBegin(S);
        else if (S.st === 'berth' && S.t > 3) S.t = 3;
    }
    // 行き先を変えた船：岸壁に着いたら、早めにそちらへ
    if (S.redirect && S.st === 'berth') { S.to = { P: S.redirect }; S.toB = null; S.redirect = null; S.svc = null; if (S.t > 5) S.t = 5; }
    switch (S.st) {
        case 'pending':
            S.t = (S.t || 0) - d;
            if (S.t > 0) return;
            if (S.seedMid !== undefined) { if (!_tfSeedMid(S)) { S.t = 5; if ((S.tries = (S.tries || 0) + 1) > 40) { S.seedMid = undefined; if (!_tfPlaceBerthed(S, S.port, Math.random())) S.st = 'gone'; } } }
            else S.st = 'gone';
            return;
        case 'berth':
            S.t -= d;
            // 自分の船がこの埠頭に来ようとしていれば、早めに出る
            if (traffic.player.reserve && traffic.player.reserve.P === S.port && S.t > 3) S.t = 3;
            if (S.t <= 0) _tfTryDepart(S, far);
            return;
        case 'off':
            S.t -= d;
            if (S.t <= 0) { S.to = null; _tfTryDepart(S, far); }
            return;
        case 'placed':           // 地図で置いた船：その場で止まって、航路が見つかったら走り出す（trafficPlaceShip）
            S.t -= d;
            // 航行中に行き先を変えた船・追従をやめた船：道すじが決まるまで、今の向きのまま、道すじを引き始める点（replanPt）へ。
            // 着いても決まらなければ、行き足を落として止まる
            if (S.v > 0 && !far) {
                const toP = S.replanPt ? _tfDist(S, S.replanPt) : 0;
                if (toP < 40) S.v = Math.max(0, S.v - S.acc * 0.5 * d);
                const ds = Math.min(S.v * d, toP > 0 ? toP : Infinity), q = _tfOff(S, S.hdg, ds);
                if (_tfDepth(q) > S.d + 1) { S.lat = q.lat; S.lon = q.lon; } else S.v = 0;
            }
            else S.v = 0;
            if (S.t <= 0) _tfPlacedGo(S);
            return;
        case 'anchored':
            S.t -= d; S.v = 0;
            if (S.t <= 0) _tfFromAnchor(S);
            return;
        case 'holding':
            S.t -= d; S.v = Math.max(0, S.v - 0.05 * d);
            if (S.t <= 0) _tfArrive(S, far);
            return;
        case 'unberth': case 'berthing':
            if (far) _tfFinish(S); else _tfManeuver(S, d);
            return;
        case 'go': case 'anchoring':
            _tfMove(S, d, far);
            return;
        case 'follow':           // 他の船（自分の船も）に付いていく（trafficSetFollow）
            _tfFollowStep(S, d, far);
            return;
        case 'damaged':           // 被弾して漂っている・沈んでいく（65-ship-hits.js）
            return;
    }
}
// ════════════════════════════════════════════════════════════════
//  他の船に付いていく（追従）
// ════════════════════════════════════════════════════════════════
//  S.follow = { id（相手の船の番号。自分の船は 'player'）, side（+1 右舷側・−1 左舷側・0 後ろ）, trail（相手の通った跡） }
//  追従している船に追従させるのも自由（列になる）。横に付けない所（水路の中で、横が浅い）では、その間だけ後ろに付く。
//  後ろに付くときは、相手の通った跡の上をたどる（相手が曲がった所で曲がる：近道して浅い所に入らない）。
//  向きを変える速さ・加速は、その船の性能まで（その場でくるっとは回らない）
function _tfLeaderOf(S) {
    const F = S.follow; if (!F) return null;
    if (F.id === 'player') return _tfPlayerAsShip();
    const O = _tfById(F.id);
    return O && _tfShown(O) ? O : null;
}
// S と O が、追従しあう組か（たがいによけない・前をふさがれたと思わない）
function _tfTeamed(S, O) {
    if (!S || !O) return false;
    const f = (A, B) => !!(A.follow && (B.player ? A.follow.id === 'player' : A.follow.id === B.id));
    return f(S, O) || f(O, S);
}
function _tfFollowBegin(S) {
    S.followReq = false;
    if (S.to && S.to.P && _tfSlotOf(S.to.P, S.id)) _tfSlotFree(S.to.P, S.id);
    S.to = null; S.path = null; S.anch = null; S.svc = null; S.redirect = null;
    S.st = 'follow'; S.turning = false; S.off = 0; S.why = '';
}
function _tfFollowEnd(S, why) {
    const nm = S.follow ? _tfLeaderName(S.follow.id) : '';
    S.follow = null; S.followReq = false;
    if (S.st === 'follow') { S.st = 'placed'; S.t = 2; S.to = null; S.path = null; S.replanPt = _tfReplanPt(S); }
    if (why && S.dPl < 15000) _tfMsg(`${S.name}：${nm ? nm + ' ' : ''}${why}`);
}
// 行き先を変えた・追従をやめた船が、道すじを引き始める点：今の向きのまま 1 分半ほど進んだ所（浅ければ、その手前・止まっていれば今の所）
function _tfReplanPt(S) {
    if (!(S.v > 0.5)) return null;
    const D = Math.max(200, Math.min(2000, S.v * 90));
    let best = null;
    for (let x = 50; x <= D; x += 50) { const q = _tfOff(S, S.hdg, x); if (_tfDepth(q) < S.d + 2) break; best = q; }
    return best ? { lat: best.lat, lon: best.lon } : null;
}
function _tfLeaderName(id) { if (id === 'player') return '自分の船'; const O = _tfById(id); return O ? O.name : '相手の船'; }
// 跡（点の列）の上の、始めから s[m] の所
function _tfTrailAt(pts, cum, s) {
    if (s <= 0) return pts[0];
    for (let i = 1; i < pts.length; i++) if (cum[i] >= s) {
        const u = (s - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1]);
        return { lat: pts[i - 1].lat + (pts[i].lat - pts[i - 1].lat) * u, lon: pts[i - 1].lon + (pts[i].lon - pts[i - 1].lon) * u };
    }
    return pts[pts.length - 1];
}
function _tfFollowStep(S, d, far) {
    const F = S.follow, Ld = _tfLeaderOf(S);
    if (!F) { S.st = 'placed'; S.t = 2; return; }
    if (!Ld) { _tfFollowEnd(S, 'が見えなくなったので、追従をやめます'); return; }
    if (Ld.st === 'berthing' || Ld.st === 'berth') { _tfFollowEnd(S, 'が岸壁へ入ったので、追従をやめます'); return; }
    if (Ld.st === 'damaged' && Ld.dmg && Ld.dmg.sunk) { _tfFollowEnd(S, 'が沈んだので、追従をやめます'); return; }
    // 相手の通った跡（15m ごと。長さは 9km まで）
    const tr = F.trail, lt = tr[tr.length - 1];
    if (!lt || _tfDist(lt, Ld) > 15) { tr.push({ lat: Ld.lat, lon: Ld.lon }); if (tr.length > 600) tr.splice(0, tr.length - 600); }
    const vL = Math.max(0, Ld.v || 0), Lh = Ld.hdg, LL = Ld.L || 100, LB = Ld.B || LL / 8;
    const gapA = Math.max(60, (LL + S.L) * 0.3);                // 後ろ：船尾と船首の間
    const gapS = Math.max(40, (LB + S.B) * 1.2);                // 横：舷と舷の間
    // 横の持ち場（相手の真横）。そこが浅い（水路の中など）間は、後ろに付く
    let mode = F.side ? 'side' : 'astern', st = null;
    if (F.side) {
        st = _tfOff(Ld, Lh + 90 * F.side, (LB + S.B) / 2 + gapS);
        for (const a of [0, S.L / 2, -S.L / 2]) if (_tfDepth(a ? _tfOff(st, Lh, a) : st) < S.d + 3) { mode = 'astern'; break; }
    }
    F.mode = mode;
    // 跡の上の、自分のいる所と、後ろの持ち場
    const pts = tr.concat([{ lat: Ld.lat, lon: Ld.lon }]), cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + _tfDist(pts[i - 1], pts[i]));
    const total = cum[cum.length - 1], sSt = Math.max(0, total - (LL / 2 + S.L / 2 + gapA));
    let wantH = S.hdg, wantV = 0;
    if (mode === 'side') {
        const e = _tfEN(S, st), fe = Math.sin(Lh * _tfR), fn = Math.cos(Lh * _tfR), dist = Math.hypot(e.e, e.n);
        // 相手の速さ＋持ち場へ寄る速さ（離れているほど速く。全体は船の最大の速さまで）
        let ve = fe * vL + 0.02 * e.e, vn = fn * vL + 0.02 * e.n;
        const vv = Math.hypot(ve, vn), vmax = S.vSea;
        if (vv > vmax) { ve *= vmax / vv; vn *= vmax / vv; }
        if (far) { S.lat = st.lat; S.lon = st.lon; S.hdg = Lh; S.v = vL; return; }
        if (dist < 10 && vL < 0.3) { wantV = 0; wantH = Lh; }
        else { wantV = Math.hypot(ve, vn); wantH = wantV > 0.3 ? (Math.atan2(ve, vn) / _tfR + 360) % 360 : Lh; }
        // 持ち場の近くでは、相手と同じ向きにそろえる
        if (dist < 60 && vL > 0.3) wantH = (Lh + Math.max(-15, Math.min(15, _tfWrap(wantH - Lh))) + 360) % 360;
    } else {
        if (far) { const q = _tfTrailAt(pts, cum, sSt); S.lat = q.lat; S.lon = q.lon; S.hdg = Lh; S.v = vL; return; }
        // 跡にいちばん近い所
        let bd = Infinity, bs = 0;
        for (let i = 1; i < pts.length; i++) {
            const sg = _tfEN(pts[i - 1], pts[i]), rl = _tfEN(pts[i - 1], S), l2 = sg.e * sg.e + sg.n * sg.n;
            const u = l2 > 0 ? Math.max(0, Math.min(1, (rl.e * sg.e + rl.n * sg.n) / l2)) : 0;
            const dd = Math.hypot(rl.e - sg.e * u, rl.n - sg.n * u);
            if (dd < bd) { bd = dd; bs = cum[i - 1] + u * Math.sqrt(l2); }
        }
        if (pts.length < 2) bs = 0;
        const ds = sSt - bs;                                    // ＋：持ち場はまだ前
        const look = Math.max(80, S.L * 0.8 + S.v * 10);
        // 跡の上の少し先を目指す（跡から離れていれば、跡の近い所へ寄りながら）
        const q = _tfTrailAt(pts, cum, Math.min(total, bs + look));
        wantH = _tfDist(S, q) > 5 ? _tfBrg(S, q) : Lh;
        wantV = Math.max(0, Math.min(S.vSea, vL + 0.015 * ds));
        if (ds < -20 || (vL < 0.3 && ds < 30)) wantV = 0;
    }
    // 浅い所の手前では止まる
    const dStop = S.v * S.v / (2 * Math.max(0.01, S.acc)) + S.L / 2 + 20;
    if (wantV > 0 && _tfDepth(_tfOff(S, S.hdg, dStop)) < S.d + 1) { wantV = 0; S.why = '浅い所の手前で止まっています'; } else S.why = '';
    // 向き（その船の旋回半径で回れる速さまで）と速さ
    const e = _tfWrap(wantH - S.hdg);
    const rate = Math.max(0.15, 1.3 * S.v / _tfRad(S) / _tfR);
    S.hdg = (S.hdg + Math.sign(e) * Math.min(Math.abs(e), rate * d) + 360) % 360;
    const vT = wantV * Math.max(0.25, Math.cos(Math.min(Math.abs(e), 75) * _tfR));
    S.v += Math.max(-S.acc * 1.5 * d, Math.min(S.acc * d, vT - S.v)); S.v = Math.max(0, S.v);
    const q = _tfOff(S, S.hdg, S.v * d); S.lat = q.lat; S.lon = q.lon;
}
// 追従させる（lead：相手の船の番号・'player'・null でやめる。side：1 右舷側・−1 左舷側・0 後ろ）
function trafficSetFollow(id, lead, side) {
    const S = _tfById(id); if (!S) return;
    if (lead == null || lead === '') { if (S.follow || S.followReq) _tfFollowEnd(S, 'への追従をやめます'); _wmRefreshShipInfo(); return; }
    if (lead !== 'player') { lead = +lead; if (lead === S.id || !_tfById(lead)) return; }
    S.follow = { id: lead, side: +side === 1 || +side === -1 ? +side : 0, trail: [] };
    S.followReq = true; S.redirect = null;
    if (S.st === 'go' || S.st === 'anchoring' || S.st === 'anchored' || S.st === 'holding' || S.st === 'placed') _tfFollowBegin(S);
    _tfMsg(`${S.name}：${_tfLeaderName(lead)}の${S.follow.side === 1 ? '右舷側' : S.follow.side === -1 ? '左舷側' : '後ろ'}に付いていきます${S.st === 'berth' ? '（離岸してから）' : ''}`);
    _wmRefreshShipInfo();
}
window.trafficSetFollow = trafficSetFollow;
// 行き先を変える（P：埠頭）。航行中なら今の所から道すじを引き直す。岸壁に着いている船は、早めにそちらへ出る
function trafficSetDest(id, portId) {
    const S = _tfById(id), P = _tfPorts().find(p => p.id === portId);
    if (!S || !P) return;
    if (S.follow || S.followReq) { S.follow = null; S.followReq = false; }
    if (S.to && S.to.P && S.to.P !== P && _tfSlotOf(S.to.P, S.id)) _tfSlotFree(S.to.P, S.id);
    S.svc = null;
    if (S.st === 'berth') { S.to = { P }; S.toB = null; if (S.t > 5) S.t = 5; }
    else if (S.st === 'unberth' || S.st === 'berthing') S.redirect = P;
    else if (S.st === 'damaged') return;
    else { S.to = { P }; S.toB = null; S.st = 'placed'; S.t = 0; S.path = null; S.anch = null; S.replanPt = _tfReplanPt(S); }
    _tfMsg(`${S.name}：行き先を ${worldBerthLabel ? worldBerthLabel(P) : P.name} に変えました`);
    _wmRefreshShipInfo();
}
window.trafficSetDest = trafficSetDest;
function _wmRefreshShipInfo() { if (typeof _wmShowInfo === 'function' && typeof _wm !== 'undefined' && _wm.selShip != null) _wmShowInfo(); }

// 道すじの上を進む。near（25km 以内）のときは、ルール（_tfRules）で決めた減速 rv・横へのずれ offT に従う
function _tfMove(S, d, far) {
    const P = S.path;
    if (!P) { S.st = 'gone'; return; }
    if (!far) S.turning = false;
    // この先（止まれる距離＋余裕）の制限速力（港の中・タグで回す角・その場で回す角）
    let vT = S.vSea;
    const look = Math.max(400, S.v * S.v / (2 * Math.max(0.01, S.acc)) + 3 * S.L);
    for (let k = S.k + 1; k < P.pts.length && P.cum[k] <= S.s + look; k++) vT = Math.min(vT, P.pts[k].lim + Math.max(0, (P.cum[k] - S.s - S.L * 0.5) * 0.004));
    // 終わり（泊地・錨地）の手前で止まる
    const left = P.total - S.s;
    vT = Math.min(vT, Math.max(0.4, Math.sqrt(2 * S.acc * 0.6 * Math.max(0, left - 20))));
    // ぶつかった船：しばらく機関を止めて、その場に（押された分だけ流れる）
    const hit = !far && traffic.t - (S.hitT ?? -1e9) < TF_HIT_STOP;
    if (hit) vT = 0;
    if (!far) {
        vT *= (S.rv === undefined ? 1 : S.rv);
        // 前をふさぐ船（_tfScan）：その手前で止まる・前の船に付いていく
        if (Number.isFinite(S.vCap)) vT = Math.min(vT, S.vCap);
        // 霧：安全な速力（見える距離の中で止まれる速さ）
        const vis = _tfVisM();
        if (vis < 4000) vT = Math.min(vT, Math.max(1.5, Math.sqrt(2 * S.acc * 0.5 * vis * 0.5)));
    }
    if (far) S.v = vT;
    else S.v += Math.max(-S.acc * 1.5 * d, Math.min(S.acc * d, vT - S.v));
    S.v = Math.max(0, S.v);
    let ds = S.v * d;
    // 道をあけるために下がる（後進：止まってから、ゆっくり）
    if (!far && traffic.t < (S.backT || 0)) {
        S.v = Math.max(0, S.v - S.acc * 2 * d);
        if (S.v < 0.05) { S.vBack = Math.min(0.6, (S.vBack || 0) + S.acc * 0.5 * d); ds = -Math.min(S.s, S.vBack * d); }
        else ds = S.v * d;
    } else S.vBack = 0;
    if (!far) {
        // 道すじの向きと船首の向きが大きく違う（錨を上げた所・その場で回す角を過ぎた所など）：止まって、その場で向きを変えてから（タグで）
        const herr = _tfWrap(_tfTangent(P, S.s, S.k) - S.hdg);
        if (Math.abs(herr) > 25 && S.v < 1.5) {
            S.v = Math.max(0, S.v - S.acc * 2 * d); ds = S.v * d * 0.3;
            S.hdg = (S.hdg + Math.sign(herr) * Math.min(Math.abs(herr), _tfRotRate(S) * d) + 360) % 360; S.turning = true;
        }
        // その場で回す角の手前：角の上で止まって、次の区間の向きにそろえてから
        const kn = S.k + 1;
        if (kn < P.pts.length - 1 && (P.pts[kn].piv || P.pts[kn].rad === 0) && S.s + ds >= P.cum[kn] - 0.5) {
            const e = _tfWrap(_tfSegCrs(P, kn) - S.hdg);
            if (Math.abs(e) > 8) {
                ds = Math.max(0, P.cum[kn] - S.s); S.v = Math.min(S.v, 0.15);
                S.hdg = (S.hdg + Math.sign(e) * Math.min(Math.abs(e), _tfRotRate(S) * d) + 360) % 360; S.turning = true;
            }
        }
    }
    // 船首の向きで進む：道すじに沿う分（s）と、横へずれる分（off）に分ける（横へは、船首を斜めに向けた分だけ動く：横滑りしない）
    const tan0 = far ? 0 : _tfTangent(P, S.s, S.k), dl = far ? 0 : _tfWrap(S.hdg - tan0) * _tfR;
    S.s += far ? ds : ds * Math.cos(dl);
    _tfArriveCheck(S);
    if (S.s >= P.total - 1) {
        S.s = P.total;
        if (far) { _tfSnapToPath(S); S.off = 0; }
        else { const q = _tfAlong(P, P.total), m = Math.abs(S.off || 0) > 0.5 ? _tfOff(q, _tfSegCrs(P, P.pts.length - 2) + 90, S.off) : q; S.lat = m.lat; S.lon = m.lon; }
        _tfArrive(S, far);
        return;
    }
    if (S.s < 0) S.s = 0;
    const q = _tfAlong(P, S.s);
    S.k = q.k;
    const crs = _tfSegCrs(P, q.k);
    if (far) { S.off = 0; S.lat = q.lat; S.lon = q.lon; S.hdg = crs; return; }
    const hitNow = hit && traffic.t - S.hitT < 20;
    S.off = (S.off || 0) + ds * Math.sin(dl);
    // 押された横流れ（ぶつかったとき）：水の抵抗でゆっくり止まる
    if (S.pushV) { S.off += S.pushV * d; S.pushV *= Math.exp(-0.4 * d); if (Math.abs(S.pushV) < 0.01) S.pushV = 0; }
    const m = Math.abs(S.off) > 0.5 ? _tfOff(q, crs + 90, S.off) : q;
    S.lat = m.lat; S.lon = m.lon;
    // 船首の向き：道すじの向き（円弧の上はなめらかに）＋ずれたい所へ向かう斜め（14° まで）。その船の旋回半径で回れる速さまで（タグで回す角は、タグの速さまで）
    //（ぶつかってから 20 秒は押された所に留まる。後進で下がるときは、斜めの向きが逆）
    const tan = _tfTangent(P, S.s, q.k);
    const offT = hitNow ? S.off : (S.offT || 0);
    const lookL = Math.max(S.L * 1.5, 6 * S.B, 150);
    let drift = Math.max(-14, Math.min(14, Math.atan2(offT - S.off, lookL) / _tfR));
    if (S.vBack > 0.05) drift = -drift;
    const want = (tan + drift + 360) % 360;
    const a = P.pts[q.k], b = P.pts[Math.min(P.pts.length - 1, q.k + 1)];
    let rate = Math.max(0.15, 1.3 * (S.v + (S.vBack || 0)) / (a.rad > 0 ? a.rad : _tfRad(S)) / _tfR);
    if (a.as || b.as) { rate = Math.max(rate, _tfRotRate(S)); S.tugKeep = traffic.t + 40; }
    if (S.turning) S.tugKeep = traffic.t + 40;
    const e = _tfWrap(want - S.hdg);
    S.hdg = (S.hdg + Math.sign(e) * Math.min(Math.abs(e), rate * d) + 360) % 360;
    // 曲がり角の手前で短音（変針の信号：右へ 1 回・左へ 2 回）：大きく曲がる所（円弧の始まり）で
    if (a.rad === undefined && b.rad !== undefined && S.sigK !== q.k + 1 && P.cum[q.k + 1] - S.s < Math.max(300, 2 * S.L)) {
        S.sigK = q.k + 1;
        let kk = q.k + 1; while (kk < P.pts.length - 1 && P.pts[kk].rad !== undefined) kk++;
        const turn = _tfWrap(_tfSegCrs(P, Math.min(P.pts.length - 2, kk - 1)) - crs);
        if (Math.abs(turn) > 35 && _tfOtherNear(S, TF_SIG_NEAR)) _tfHorn(S, turn > 0 ? 'S1' : 'S2');
    }
}

// ════════════════════════════════════════════════════════════════
//  ルール（近くの船だけ、0.5 秒ごと）
// ════════════════════════════════════════════════════════════════
//  ・行き会い（ほぼ真正面）：互いに右へ
//  ・横切り：相手を右に見る船（避航船）が、右へよける・減速する（相手の船尾を回る）。保持船はそのまま
//  ・追い越し：追い越す船がよける（港の航路の中では追い越さず、前の船に合わせる）
//  ・前の船（同じ向き）との間を空ける
//  ・霧：速力を落とし、2 分ごとに長音 1 回（錨泊中は 1 分ごとに号鐘の代わりの短い音）
//  自分の船も、相手の 1 隻として扱う（他の船が自分の船をよける）
function _tfPlayerAsShip() {
    if (typeof physics === 'undefined' || !window.world || world.mode !== 'world') return null;
    const ll = _tfPlayerLL();
    const L = (window.hullProfile && hullProfile.ready) ? hullProfile.halfLen * 2 * (physics.scale || 1) : 200;
    const hdg = typeof worldTrueCompass === 'function' ? worldTrueCompass() : 0;
    const B = typeof _apShipHalfBeam === 'function' ? _apShipHalfBeam() * 2 : L / 9;
    return { player: true, lat: ll.lat, lon: ll.lon, hdg, v: Math.abs(physics.speed || 0) * 0.514444, L, B, name: '自分の船' };
}
function _tfVel(o) { const h = o.hdg * _tfR; return { e: Math.sin(h) * (o.v || 0), n: Math.cos(h) * (o.v || 0) }; }
// 最接近（CPA[m]・TCPA[秒]）
function _tfCPA(A, B) {
    const r = _tfEN(A, B), va = _tfVel(A), vb = _tfVel(B);
    const dvx = vb.e - va.e, dvy = vb.n - va.n, dv2 = dvx * dvx + dvy * dvy;
    const tc = dv2 < 1e-6 ? 0 : -(r.e * dvx + r.n * dvy) / dv2;
    const cx = r.e + dvx * tc, cy = r.n + dvy * tc;
    return { cpa: Math.hypot(cx, cy), t: tc, dist: Math.hypot(r.e, r.n) };
}
// ── よけられる幅 ──
// 今の所と、この先（横へずれ終わるまでの距離）の何か所かで、道すじから右・左へどこまで深い所が続くか。
// 返すのは、船の真ん中のずれの上限[m]（船の半幅と余裕を引いたもの。want の向きと、今ずれている向きだけ調べる）
function _tfClearance(S, want) {
    const P = S.path, need = S.d + 1.5, mg = S.B / 2 + 10;
    const reachR = Math.min(1600, Math.max(want, S.off || 0, 0) + mg + 15), reachL = Math.min(1600, Math.max(-want, -(S.off || 0), 0) + mg + 15);
    const LA = Math.min(3000, Math.max(2 * S.L, (Math.abs(want) + Math.abs(S.off || 0)) / 0.25 + S.L));
    let R = Infinity, Lf = Infinity;
    const nF = Math.max(3, Math.min(8, Math.ceil(LA / 150)));
    for (let fi = 0; fi <= nF; fi++) {
        const s0 = Math.min(P.total, S.s + LA * fi / nF), q = _tfAlong(P, s0), crs = _tfSegCrs(P, q.k);
        for (const side of [1, -1]) {
            const reach = side > 0 ? reachR : reachL;
            if (reach <= mg + 15.01 && !(side > 0 ? want > 0 || (S.off || 0) > 0 : want < 0 || (S.off || 0) < 0)) { if (side > 0) R = Math.min(R, 0); else Lf = Math.min(Lf, 0); continue; }
            const step = Math.max(12, reach / 25);
            let c = 0;
            for (let r = step; r <= reach + 0.1; r += step) { const p2 = _tfOff(q, crs + 90 * side, r); if (_tfDepthAt(p2.lat, p2.lon) < need) break; c = r; }
            const v = c + step > reach ? Infinity : Math.max(0, c - mg);
            if (side > 0) R = Math.min(R, v); else Lf = Math.min(Lf, v);
        }
    }
    return { r: R, l: Lf };
}
// ── 前をふさぐ船 ──
// O の上から見た形（S から見た東・北[m] のカプセルのいくつか）。離着岸中の船は、これから回す所（船の長さの円）・動いていく先も
// その船が占める（これから占める）所の広がり[m]（船の位置からの距離）：離着岸中なら、動いていく先・回す所まで
function _tfReach(O) {
    let r = (O.L || 100) / 2 + 20;
    if ((O.st === 'berthing' || O.st === 'unberth') && O.steps) for (const st of O.steps) if (st.to) r = Math.max(r, _tfDist(O, st.to) + O.L / 2 + 20);
    return r;
}
function _tfObsShapes(S, O) {
    const out = [];
    if (O.player) { out.push(_tfCapOf(S, O, O.hdg, O.L, O.B)); out[0].r += 5; return out; }
    if (O.st === 'anchored') { const c = _tfEN(S, O); out.push({ ae: c.e, an: c.n, be: c.e, bn: c.n, r: O.L / 2 + 15 }); return out; }
    if (O.st === 'berthing' || O.st === 'unberth') {
        const circ = (q) => { const c = _tfEN(S, q); out.push({ ae: c.e, an: c.n, be: c.e, bn: c.n, r: O.L / 2 + 10 }); };
        const st0 = O.steps && O.steps[0];
        if (st0 && st0.k === 'rot') circ(O); else out.push(_tfCapOf(S, O, O.hdg, O.L, O.B + 10));
        let at = O, h = O.hdg;
        for (const st of (O.steps || [])) {
            if (st.k === 'rot') { circ(at); h = st.hdg; continue; }
            if (st.k !== 'move' && st.k !== 'go') continue;
            if (st.k === 'go') h = _tfBrg(at, st.to);
            const n = Math.max(1, Math.ceil(_tfDist(at, st.to) / Math.max(30, O.B)));
            for (let j = 1; j <= n; j++) { const u = j / n; out.push(_tfCapOf(S, { lat: at.lat + (st.to.lat - at.lat) * u, lon: at.lon + (st.to.lon - at.lon) * u }, h, O.L, O.B + 10)); }
            at = st.to;
        }
        // この船が、もうその船の動く先にかかっている：先の形では止まらない（止まると、相手もこの船を待って動けなくなる。出ていく）
        const me = _tfCapOf(S, S, S.hdg, S.L, S.B);
        for (let i = 1; i < out.length; i++) if (_tfCapDist(me, out[i]) < 0) return [_tfCapOf(S, O, O.hdg, O.L, O.B + 6)];
        return out;
    }
    out.push(_tfCapOf(S, O, O.hdg, O.L, O.B));
    return out;
}
// この船の道すじ（ずれも入れて）の、船首から D[m] 先までの点（S から見た東・北）：{ e, n, sig（船首から）, te, tn（向き） }
function _tfAheadPts(S, D, offT) {
    const P = S.path, out = [];
    if (!P) return out;
    const s0 = S.s + S.L / 2, s1 = Math.min(P.total, s0 + D);
    const step = Math.max(8, Math.min(25, S.B * 0.7));
    const sStart = Math.max(0, S.s - S.L / 2 + step * 0.5);
    const en = new Map(), EN = (k) => { let v = en.get(k); if (!v) en.set(k, v = _tfEN(S, P.pts[k])); return v; };
    const off0 = S.off || 0;
    let k = Math.max(0, Math.min(P.pts.length - 2, S.k || 0));
    while (k > 0 && P.cum[k] > sStart) k--;
    for (let sg = sStart; sg <= s1 + 0.01; sg += step) {
        while (k < P.pts.length - 2 && P.cum[k + 1] <= sg) k++;
        const A = EN(k), B = EN(k + 1), segL = (P.cum[k + 1] - P.cum[k]) || 1, u = Math.max(0, Math.min(1, (sg - P.cum[k]) / segL));
        const te = (B.e - A.e) / segL, tn = (B.n - A.n) / segL;
        const off = sg <= S.s ? off0 : off0 + Math.max(-(sg - S.s) * 0.25, Math.min((sg - S.s) * 0.25, offT - off0));
        const pe = A.e + (B.e - A.e) * u + tn * off, pn = A.n + (B.n - A.n) * u - te * off;
        out.push({ e: pe, n: pn, sig: sg - s0, te, tn });
        // 小さく回る円弧の上：船首・船尾の振れる所
        const pa = P.pts[k];
        if (sg > S.s && pa.rad > 0 && pa.rad < 2.5 * S.L) {
            const h = S.L * 0.45;
            out.push({ e: pe + te * h, n: pn + tn * h, sig: sg - s0, te, tn }, { e: pe - te * h, n: pn - tn * h, sig: sg - s0, te, tn });
        }
    }
    // この先の、その場で回す角：船の長さの円（その角に着くまでに空いていること）
    for (let j = Math.max(1, S.k + 1); j < P.pts.length - 1 && P.cum[j] <= s1; j++) {
        const pv = P.pts[j];
        if (!(pv.piv || pv.rad === 0) || P.cum[j] < S.s) continue;
        const c = EN(j), sig = Math.max(0, P.cum[j] - s0);
        for (let a = 0; a < 16; a++) { const an = a * Math.PI / 8; for (const r of [S.L * 0.25, S.L * 0.5]) out.push({ e: c.e + Math.sin(an) * r, n: c.n + Math.cos(an) * r, sig, te: Math.sin(an), tn: Math.cos(an) }); }
    }
    return out;
}
// 前をふさぐ船：この船の道すじの帯（船の幅＋余裕）に、ほかの船がかかる所の手前で止まれる速さ vCap と、その船 by
//  ・同じ向きに進む前の船：間をあけて付いていく
//  ・向かってくる船：遠いうちは行き会いのルール（右へよけ合う）に任せ、近くなってもふさいでいれば止まる（間の半分で）
//  ・止まっている船（停泊・錨泊・待っている船）・離着岸中の船（回す所も）・横切っていく船：その手前で止まる
// 横に並んでいる船の方へ、ずれすぎない（真ん中のずれの上限・下限を、相手の舷との間が空くように）
function _tfSideLimit(S, obs, offT) {
    const P = S.path, q = _tfAlong(P, S.s), crs = _tfSegCrs(P, q.k) * _tfR, te = Math.sin(crs), tn = Math.cos(crs);
    const off0 = S.off || 0;
    let hi = Infinity, lo = -Infinity;
    for (const O of obs) {
        if (O === S || Math.abs(O.lat - S.lat) > 0.03) continue;
        const c = _tfEN(q, O), along = c.e * te + c.n * tn;
        if (Math.abs(along) > (S.L + (O.L || 100)) / 2 + 30) continue;
        const lat = c.e * tn - c.n * te;                                  // 道すじから右（＋）への位置
        const dh = Math.abs(Math.sin(((O.hdg || 0) * _tfR) - crs));
        const room = S.B / 2 + (O.B || 20) / 2 + (O.L || 100) / 2 * dh + 12 + 0.02 * S.L;
        if (lat > off0) hi = Math.min(hi, Math.max(off0, lat - room));
        else lo = Math.max(lo, Math.min(off0, lat + room));
    }
    return Math.max(lo, Math.min(hi, offT));
}
// O の占める所（離着岸中なら、動いていく先・回す所も）の、道すじ（q0 で向き c0[rad]）から右（＋）への広がり lo〜hi と、
// 前後の広がり a0〜a1[m]。shore：岸壁（埠頭）がその広がりの右（＋1）か左（−1）か（わからなければ 0）
function _tfLatExt(q0, c0, O) {
    const te = Math.sin(c0), tn = Math.cos(c0);
    let lo = Infinity, hi = -Infinity, a0 = Infinity, a1 = -Infinity;
    const add = (p, r) => { const c = _tfEN(q0, p), lat = c.e * tn - c.n * te, al = c.e * te + c.n * tn; lo = Math.min(lo, lat - r); hi = Math.max(hi, lat + r); a0 = Math.min(a0, al - r); a1 = Math.max(a1, al + r); };
    const hull = (p, h) => { for (const f of [-0.5, 0, 0.5]) add(_tfOff(p, h, O.L * f), O.B / 2); };
    hull(O, O.hdg);
    if (O.st === 'berthing' || O.st === 'unberth') {
        let at = O, h = O.hdg;
        for (const st of (O.steps || [])) {
            if (st.k === 'rot') { add(at, O.L / 2 + 10); if (st.hdg != null) h = st.hdg; continue; }
            if (!st.to || (st.k !== 'move' && st.k !== 'go')) continue;
            if (st.k === 'go') h = _tfBrg(at, st.to);
            hull(st.to, h); at = st.to;
        }
    }
    let shore = 0;
    const F = O.geo && O.geo.face;
    if (F) { const c = _tfEN(q0, F), lat = c.e * tn - c.n * te; shore = lat > (lo + hi) / 2 ? 1 : -1; }
    return { lo, hi, a0, a1, shore };
}
function _tfScan(S, obs, offT) {
    const aB = Math.max(0.01, S.acc * 1.2);
    const D = Math.min(4000, Math.max(500, S.v * S.v / (2 * aB) + 3 * S.L));
    const g0 = 15 + 0.08 * S.L;
    let vCap = Infinity, by = null, pts = null;
    const half = S.B / 2 + 6 + 0.03 * S.L;
    for (const O of obs) {
        if (O === S || O.st === 'off' || O.st === 'gone' || O.st === 'pending') continue;
        if (S.ghost && S.ghost.k === _tfSigKey(O) && traffic.t < S.ghost.until) continue;
        // 自分の船がこの船と並走している（49-autopilot.js）：申し合わせて並んでいるので、この船は針路・速力を保つ
        //（よけるのは並走している自分の船の方。曲がる先に自分の船の船首がかかっても、待って止まらない）
        if (O.player && traffic.player && traffic.player.chaseId === S.id) continue;
        if (_tfTeamed(S, O)) continue;                     // 追従しあう組
        if (Math.abs(O.lat - S.lat) > 0.06) continue;
        if (_tfDist(S, O) > D + S.L / 2 + _tfReach(O) + 30) continue;
        if (!pts) { pts = _tfAheadPts(S, D, offT); pts.sort((x, y) => x.sig - y.sig); }
        const shapes = _tfObsShapes(S, O);
        // 船首より前でかかる所（あれば、そこで止まる）と、船の横でかかる所（前に無いときだけ：追い越し・寄ってくる船）
        //（横でかかる所を先に見つけて、その先の前をふさいでいる所を見落とさないように）
        let hit = null, side = null;
        for (const p of pts) {
            let on = false;
            for (const sh of shapes) if (_tfSegDist(p.e, p.n, sh) < half) { on = true; break; }
            if (!on) continue;
            if (p.sig < 0) { if (!side) side = p; continue; }
            hit = p; break;
        }
        if (!hit) hit = side;
        if (!hit) continue;
        const gap = hit.sig;
        let vA = 0;
        const moving = (O.v || 0) > 0.05 && (O.player || O.st === 'go' || O.st === 'anchoring');
        if (moving) { const h = O.hdg * _tfR; vA = (Math.sin(h) * hit.te + Math.cos(h) * hit.tn) * O.v; }
        let cap;
        if (gap < 0) {
            // 船の横に並んで、帯にかかっている（追い越し・寄ってくる船）：前寄りにいる動いている船なら、こちらが下がって先に行かせる
            //（後ろ寄りの船・止まっている船・離着岸中の船は、相手が待つ・こちらはそのまま通り過ぎる）
            if (!moving || (O.v || 0) < 0.3) continue;
            const c = _tfEN(S, O), h0 = S.hdg * _tfR;
            if (c.e * Math.sin(h0) + c.n * Math.cos(h0) <= 0) continue;
            cap = Math.max(0, vA - 0.4);
        } else if (vA > 0.3) {
            const want = g0 + 30 + S.v * 25;
            cap = Math.max(0, Math.min(vA + (gap - want) * 0.02, vA + Math.sqrt(2 * aB * Math.max(0, gap - g0))));
        } else if (vA < -0.3) {
            if (gap > Math.max(3 * S.L, 700)) continue;
            cap = Math.sqrt(2 * aB * Math.max(0, gap / 2 - g0));
        } else {
            if (moving && (O.v || 0) > 0.5 && gap > Math.max(4 * S.L, S.v * S.v / (2 * aB) + 400)) continue;
            cap = Math.sqrt(2 * aB * Math.max(0, gap - g0));
        }
        if (cap < vCap) { vCap = cap; by = O; }
    }
    return { vCap, by };
}
// 優先：港を出ていく船（3）＞ 港の間を行く船（2）＞ 港へ入ってくる船（1）。自分の船はいちばん上
function _tfPri(S) {
    if (!S || S.player) return 9;
    const P = S.path;
    if (S.st === 'anchoring') return 1;
    if (P && S.to && S.to.P && P.arriveIdx >= 0 && S.k >= P.arriveIdx) return 1;
    if (P && S.from && S.from.P && P.pts[Math.min(P.pts.length - 1, S.k + 1)].ch && !(P.arriveIdx >= 0 && S.k >= P.arriveIdx)) return 3;
    return 2;
}
function _tfRules() {
    const near = traffic.ships.filter(S => S.dPl < TF_NEAR && (S.st === 'go' || S.st === 'anchoring' || S.st === 'anchored' || S.st === 'berthing' || S.st === 'unberth' || S.st === 'holding' || S.st === 'damaged' || S.st === 'follow'));
    const me = _tfPlayerAsShip();
    const all = me ? near.concat([me]) : near;
    // 前をふさぐ船を探すときは、埠頭に付いている船も
    const obs = all.concat(traffic.ships.filter(S => S.st === 'berth' && S.dPl < TF_NEAR));
    const vis = _tfVisM();
    for (const S of near) {
        if (S.st !== 'go' && S.st !== 'anchoring') continue;
        let rv = 1, offT = 0, offL = 0, why = '';
        const inCh = S.path && S.path.pts[Math.min(S.path.pts.length - 1, S.k + 1)].ch;
        const safe = Math.max(inCh ? 1.5 * S.B + 60 : 900, 2.5 * S.L);
        S.avoid = S.avoid || {};
        for (const O of all) {
            if (O === S) continue;
            // 自分の船がこの船と並走している（49-autopilot.js）：申し合わせて並んで走っているので、よけない
            if (O.player && traffic.player && traffic.player.chaseId === S.id) continue;
            if (_tfTeamed(S, O)) continue;                 // 追従しあう組：申し合わせて並んでいる
            // 離着岸中の船は、下の停泊中の船と同じく、岸壁（埠頭）の反対側・動いていく先の外を通る（通れなければ手前で待つ：_tfScan）
            if (O.st === 'berthing' || O.st === 'unberth') continue;
            const c = _tfCPA(S, O);
            if (c.dist > 12000) continue;
            // よけ始めた相手は、すれ違い・追い越しが終わるまで（最接近を過ぎて離れていくまで）よけ続ける
            //（右へ変針すると最接近の予測が離れて、よける理由が消えて戻ってしまうので）
            const key = _tfSigKey(O), lat = S.avoid[key];
            if (lat) {
                const passed = c.t <= 0 && c.dist > (S.L + (O.L || 100)) / 2 + 100;
                if (passed || c.dist > 8000) delete S.avoid[key];
                else {
                    offT = Math.max(offT, lat.r); offL = Math.max(offL, lat.l); why = why || lat.why;
                    // 遠くからよけ始めた相手にも、近く（3km）になったら合図する（行き会い・追い越し・横切りの変針）
                    if (c.dist < 3000 && !lat.sig) { if (lat.kind === 'cross') { lat.sig = true; _tfTurnSig(S, key, 'S1'); } else if (lat.kind) _tfSignal(S, O, lat.kind, c.dist); }
                    // よけているのに、相手（自分の船）がまだぶつかる向きに来る：警告（短音 5 回）
                    if (O.player && lat.r > 0 && traffic.t - (lat.t0 || 0) > 45 && c.t > 0 && c.t < 300 && c.cpa < Math.max(S.L, 250) && c.dist < 4000) _tfWarn(S, O);
                    continue;
                }
            }
            const brgO = _tfBrg(S, O), rb = _tfWrap(brgO - S.hdg);            // 相手の見える向き（右が＋）
            const rbFromO = _tfWrap(_tfBrg(O, S) - O.hdg);                      // 相手から見た自分
            const sameDir = Math.abs(_tfWrap(O.hdg - S.hdg)) < 45;
            // 前の船（同じ向き・前にいる）：間を空ける
            if (sameDir && Math.abs(rb) < 25 && c.dist < Math.max(6 * S.L, 1500) && (O.v || 0) > 0.5) {      // （止まっている船は下で、右によけて通る）
                const gap = c.dist - (S.L + (O.L || 100)) / 2;
                const want = Math.max(2 * S.L, inCh ? 3 * S.L : 600);
                const vO = O.v || 0;
                if (gap < want * 2 && vO < S.v - 0.3) {
                    // 追い越す：減速はせず、相手の左舷側を通る（相手は右側を通っている）。汽笛「長長短短」で知らせる
                    const l = inCh ? Math.min((S.B + (O.B || 20)) / 2 + 40, safe) : safe;
                    offL = Math.max(offL, l);
                    why = why || `${O.name} を追い越しています`;
                    S.avoid[key] = { r: 0, l, why: `${O.name} を追い越しています`, kind: 'over' };
                    _tfSignal(S, O, 'over', c.dist);
                }
                // （ぶつかりそうなほど近いときだけ、相手の速さまで落とす）
                if (gap < Math.max(60, S.L * 0.5)) { rv = Math.min(rv, Math.max(0, vO / Math.max(0.5, S.vSea))); why = why || `${O.name} に近すぎるので、速力を合わせています`; }
                continue;
            }
            // 追い越される：右へ寄って、追い越す船に場所をあける（速力はそのまま）
            if (sameDir && Math.abs(rb) > 155 && c.dist < Math.max(4 * S.L, 900) && (O.v || 0) > S.v + 0.3) {
                offT = Math.max(offT, inCh ? S.B / 2 + 30 : 250);
                continue;
            }
            if (!(c.t > 0 && c.t < 1500 && c.cpa < safe)) continue;
            if ((O.v || 0) < 0.3) {
                // 止まっている船（錨泊・待機中・自分の船）：横を通る。相手の右（こちらから見て右）を通れれば右、浅くて通れなければ左
                if (S.path) {
                    const need = (S.B + (O.B || 20)) / 2 + 25 + 0.03 * S.L;
                    const q0 = _tfAlong(S.path, S.s), c0 = _tfSegCrs(S.path, q0.k) * _tfR, rel = _tfEN(q0, O);
                    const latO = rel.e * Math.cos(c0) - rel.n * Math.sin(c0);           // 道すじから右（＋）への相手の位置
                    if (Math.abs(latO - (S.off || 0)) < need && Math.abs(latO) < need + 400) {
                        const goR = Math.max(0, latO + need), goL = Math.min(0, latO - need);
                        const cR = _tfClearance(S, goR);
                        if (cR.r >= goR) offT = Math.max(offT, goR);
                        else { const cL = _tfClearance(S, goL); if (cL.l >= -goL) offL = Math.max(offL, -goL); }
                    }
                } else offT = Math.max(offT, Math.min(safe, inCh ? S.B + 40 : 600));
                why = why || `${O.player ? 'あなたの船' : O.name} をよけています`;
                continue;
            }
            const headOn = Math.abs(rb) < 12 && Math.abs(rbFromO) < 12;
            const overtaking = Math.abs(rbFromO) > 112.5 && sameDir;             // 自分が相手の船尾の方から近づく
            // （同じ向きの船は横切りではない：追い越すか、追い越されるか）
            const crossing = !sameDir && rb > 0 && rb < 112.5;
            const giveWay = headOn || overtaking || crossing;
            if (giveWay) {
                const amt = inCh ? Math.min(S.B + 60, safe) : Math.min(1500, safe + 300);
                if (overtaking) offL = Math.max(offL, amt); else offT = Math.max(offT, amt);
                S.avoid[key] = overtaking ? { r: 0, l: amt, why: `${O.name} を追い越しています`, t0: traffic.t, kind: 'over' } : { r: amt, l: 0, why: headOn ? `${O.name} と行き会うので右へ` : `${O.name} を右に見るので、よけています`, t0: traffic.t, kind: headOn ? 'meet' : 'cross' };
                // 横切りの避航船が右へ変針する：短音 1 回（行き会い・追い越しは下の合図で）
                if (!headOn && !overtaking && c.dist < 3000) { S.avoid[key].sig = true; _tfTurnSig(S, key, 'S1'); }
                // 行き会い・追い越しでは減速しない（よけるだけ）。横切りの避航船だけ、近ければ少し落とす
                if (!headOn && !overtaking && c.t < 600) rv = Math.min(rv, inCh ? 0.5 : 0.65);
                if (headOn) _tfSignal(S, O, 'meet', c.dist); else if (overtaking) _tfSignal(S, O, 'over', c.dist);
                why = why || (headOn ? `${O.name} と行き会うので右へ` : overtaking ? `${O.name} を追い越すので、よけています` : `${O.name} を右に見るので、よけています`);
            } else if (!sameDir) {
                // 保持船：相手がよけずに近づいてくる（進路が重なってくる）→ 警告（短音 5 回）
                const doing = !O.player && O.avoid && O.avoid[S.id];
                if (!doing && c.t < 420 && c.cpa < Math.max(1.5 * S.L, 300) && c.dist < 4000) _tfWarn(S, O);
                if (c.cpa < Math.max(S.L, 200) && c.t < 240) {
                    // 保持船でも、ぶつかりそうなら最後はよける（減速して右へ：短音 1 回）
                    rv = Math.min(rv, 0.4); offT = Math.max(offT, Math.min(safe, 300)); why = why || `${O.name} が近いので減速しています`;
                    _tfTurnSig(S, key, 'S1');
                }
            }
        }
        // 埠頭に付いている船・離着岸中の船（動いていく先・回す所も）が、この船の帯にはみ出している
        //（長い船が岸壁の端から出ている・航路の脇の埠頭・スリップから出てくる船）：
        //  岸壁（埠頭）の反対側を通る（船と岸壁の間へは入らない）。その側が浅くて通れなければ、手前で待つ（_tfScan）
        let offHi = Infinity, offLo = -Infinity;
        const nearEnd = S.path && S.path.total - S.s < 2 * S.L + 300;
        if (S.path && !nearEnd) {
            const P = S.path, q0 = _tfAlong(P, S.s), c0 = _tfSegCrs(P, q0.k) * _tfR;
            const half = S.B / 2 + 25 + 0.03 * S.L, look = Math.min(2500, Math.max(600, S.v * 240));
            const off0 = S.off || 0;
            for (const O of obs) {
                if ((O.st !== 'berth' && O.st !== 'berthing' && O.st !== 'unberth') || O === S || Math.abs(O.lat - S.lat) > 0.04) continue;
                const X = _tfLatExt(q0, c0, O);
                if (X.a1 < -S.L / 2 || X.a0 > look) continue;
                if (off0 + half < X.lo && offT + half < X.lo) continue;           // 帯にかかっていない（今も、よけていく先でも）
                if (off0 - half > X.hi && offT - half > X.hi) continue;
                const side = X.shore;
                if (side > 0) offHi = Math.min(offHi, X.lo - half);
                else if (side < 0) offLo = Math.max(offLo, X.hi + half);
                else {
                    const goR = X.hi + half, goL = X.lo - half;
                    if (goR > 0 && _tfClearance(S, goR).r >= goR) offT = Math.max(offT, goR);
                    else if (goL < 0 && _tfClearance(S, goL).l >= -goL) offL = Math.max(offL, -goL);
                }
                why = why || (O.st === 'berth' ? `${O.name}（停泊中）の横を通ります` : `${O.name}（${O.st === 'berthing' ? '着岸中' : '離岸中'}）の沖の側を通ります`);
            }
        }
        // 追い越し（左へ）は、右へよける理由が無いときだけ
        if (!(offT > 0) && offL > 0) offT = -offL;
        // 道すじの終わり（泊地・錨地）の手前では、真ん中へ戻る（待つ所・離着岸の始まりは道すじの上）
        if (nearEnd) offT = 0;
        // 停泊中・離着岸中の船の、岸壁の反対側へ
        if (offLo > offHi) offT = (offLo + offHi) / 2;
        else offT = Math.max(offLo, Math.min(offHi, offT));
        // よけられる幅：浅い所・陸にかからない所まで（今の所と、この先の横へずれ終わるまでの所で）。よけきれなければ減速
        if (S.path && (offT !== 0 || Math.abs(S.off || 0) > 1)) {
            const c = _tfClearance(S, offT);
            S.clrR = c.r; S.clrL = c.l;
            const ok = Math.max(-c.l, Math.min(c.r, offT));
            if (offT > 0 && ok < offT * 0.5) rv = Math.min(rv, 0.5);
            offT = ok;
        } else { S.clrR = 0; S.clrL = 0; }
        // 横に並んでいる船（追い越し・追い越される・となりの航路）の方へは、ずれていかない
        if (S.path) offT = _tfSideLimit(S, obs, offT);
        // 前をふさぐ船（近い船から：停泊中・離着岸中・待っている船・自分の船も）：その手前で止まる・前の船に付いていく
        const sc = _tfScan(S, obs, offT);
        S.vCap = sc.vCap;
        if (sc.by && sc.vCap < 0.3) {
            const k = _tfSigKey(sc.by);
            if (S.blockBy !== k) { S.blockBy = k; S.blockT0 = traffic.t; }
            why = `${sc.by.player ? 'あなたの船' : sc.by.name} が前をふさいでいるので、待っています`;
        } else { S.blockBy = null; S.blockT0 = null; if (sc.by && sc.vCap < S.v - 0.2) why = why || `${sc.by.player ? 'あなたの船' : sc.by.name} が前にいるので、速力を落としています`; }
        // 動けないまま待っている（ふさいでいる船も、こちらを待って止まっている：狭い所で向かい合った など）：
        //  優先の低い方が、少し下がって（後進で）道をあける。5 分たっても動けず、自分の船から遠ければ（見えない所）、すり抜けさせる
        if (S.blockBy != null && S.blockT0 != null) {
            const O = S.blockBy === 'P' ? null : traffic.ships.find(o => o.id === S.blockBy);
            const waited = traffic.t - S.blockT0;
            if (O && O.blockBy === S.id && waited > 30 && !(traffic.t < (O.backT || 0))) {
                const pS = _tfPri(S), pO = _tfPri(O);
                if ((pS < pO || (pS === pO && S.id > O.id)) && !(traffic.t < (S.backT || 0)) && S.s > 10) { S.backT = traffic.t + 60; why = `${O.name} に道をあけるため、少し下がります`; }
            }
            if (O && (O.st === 'berthing' || O.st === 'unberth') && O.pausedBy && O.pausedById === S.id && waited > 20 && !(traffic.t < (S.backT || 0)) && S.s > 10) { S.backT = traffic.t + 60; why = `${O.name} の離着岸の場所をあけるため、少し下がります`; }
            if (O && waited > 300 && S.dPl > 4000 && O.dPl > 4000) S.ghost = { k: O.id, until: traffic.t + 240 };
            // 自分の船と向かい合って、互いに待っている：この船が少し下がって道をあける（自分の船は自動航行で待っているだけなので）
            if (S.blockBy === 'P' && traffic.player.blockedBy === S.id && traffic.t - (traffic.player.blockedT ?? -1e9) < 5 && waited > 30 && !(traffic.t < (S.backT || 0)) && S.s > 10) { S.backT = traffic.t + 60; why = 'あなたの船に道をあけるため、少し下がります'; }
        }
        // 霧の中は、レーダーで見る分だけ早めに減速（視程の 2 倍の中に他の船がいれば半分の速さ）
        if (vis < 2000 && all.some(O => O !== S && _tfDist(S, O) < vis * 2)) rv = Math.min(rv, 0.5);
        S.rv = rv; S.offT = offT; S.why = why;
        // 霧中信号（長音 1 回を 2 分ごと）
        if (vis < 2000 && S.dPl < 8000 && !(traffic.t - (S.fogT || -1e9) < 120)) { S.fogT = traffic.t + Math.random() * 10; _tfHorn(S, 'L'); }
    }
    // 錨泊中の船：霧の中は号鐘（ここでは短い音を 3 回）を 1 分ごと
    for (const S of near) if (S.st === 'anchored' && vis < 2000 && S.dPl < 3000 && !(traffic.t - (S.fogT || -1e9) < 60)) { S.fogT = traffic.t + Math.random() * 10; _tfHorn(S, 'S3'); }
}

// ════════════════════════════════════════════════════════════════
//  汽笛（その船の位置から聞こえる）
// ════════════════════════════════════════════════════════════════
//  'L'：長音（4〜6 秒：出港・霧中信号）、'S1'・'S2'・'S3'：短音 1〜3 回（右へ・左へ・後進）、'D'：短音 5 回（疑問・警告）
//  ほかに、長音 L・短音 S の並び（'LLSS'：追い越しの合図、'LSLS'：追い越しへの同意 など）
function _tfHorn(S, pat) {
    if (!traffic.horn || !S || !(S.dPl < 7000)) return;
    if (typeof audioEnsure !== 'function' || !audioEnsure() || !audio.buses || !audio.buses.horn || typeof AudioEmitter === 'undefined') return;
    // 同じ船の汽笛は重ねない（物理早送りのときは、合図が実時間では詰まって来るので）
    const nowR = performance.now();
    if (S.hornEnd > nowR) {
        // 鳴らしている途中：変針・警告の合図は、鳴り終わってから（1 つだけ待たせる）
        if (pat !== 'L' && !S.hornQ) { S.hornQ = pat; _tfLater(0, () => { const q = S.hornQ; S.hornQ = null; _tfHorn(S, q); }, (S.hornEnd - nowR) / 1000 + 1); }
        return;
    }
    S.hornEnd = nowR + _tfSigLen(pat === 'D' ? 'SSSSS' : /^S\d$/.test(pat) ? 'S'.repeat(+pat[1]) : pat) * 1000;
    const loc = _tfLocal(S, {});
    if (!Number.isFinite(loc.x)) return;
    const c = audio.ctx;
    // 長音・短音の並びにする（長音 5 秒・短音 1 秒、間は 36-horns.js と同じ）
    const seq = pat === 'D' ? 'SSSSS' : /^S\d$/.test(pat) ? 'S'.repeat(+pat[1]) : pat;
    const blasts = [];
    let tt = 0;
    const sh = typeof HORN_SHORT !== 'undefined' ? HORN_SHORT : 1, lg = typeof HORN_LONG !== 'undefined' ? HORN_LONG : 5, gp = typeof HORN_GAP !== 'undefined' ? HORN_GAP : 1;
    for (const ch of seq) { const len = ch === 'L' ? lg : (pat === 'D' ? 0.5 : sh); blasts.push([tt, len]); tt += len + (ch === 'L' ? 2 : (pat === 'D' ? 0.4 : gp)); }
    const em = new AudioEmitter(audio.buses.horn, 120, 0.9);
    em.update(new THREE.Vector3(loc.x, 25, loc.z));
    // 保存した船：その船の汽笛（船体設定の汽笛・音・種類）で鳴らす
    const horns = S.saved && S.saved.cfg && S.saved.cfg.sound && Array.isArray(S.saved.cfg.sound.horns) ? S.saved.cfg.sound.horns : null;
    const mains = horns ? horns.filter(h => h && h.main && h.type !== 'bell' && h.type !== 'gong') : [];
    if (mains.length && typeof _makeVoice === 'function' && typeof noteToFreq === 'function') {
        const out = c.createGain(); out.connect(em.input);
        for (const [t0r, len] of blasts) {
            setTimeout(() => {
                const vs = [];
                for (const h of mains) {
                    const notes = (h.notes && h.notes.length) ? h.notes : ['C3'], per = Math.max(0, h.volume != null ? h.volume : 1) / Math.sqrt(notes.length);
                    for (const n of notes) { const v = _makeVoice(h.type, out, noteToFreq(n), per); if (v) vs.push(v); }
                }
                setTimeout(() => { const now = c.currentTime; for (const v of vs) v.stop(now); }, len * 1000);
            }, (0.05 + t0r) * 1000);
        }
        setTimeout(() => em.disconnect(), (tt + 8) * 1000);
        return;
    }
    // 大きな船ほど低い音（汽笛の 2 つの音で和音）
    const f0 = Math.max(70, Math.min(330, 15000 / Math.max(30, S.L) + (S.seed - 0.5) * 20));
    let end = 0;
    for (const [t0r, len] of blasts) {
        const t0 = c.currentTime + 0.05 + t0r;
        for (const [f, a] of [[f0, 0.2], [f0 * 1.26, 0.13], [f0 * 2.02, 0.05]]) {
            const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f;
            const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900 + f0 * 2;
            const g = c.createGain();
            g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(a, t0 + 0.12);
            g.gain.setValueAtTime(a, t0 + len); g.gain.exponentialRampToValueAtTime(0.0005, t0 + len + 0.35);
            o.connect(lp); lp.connect(g); g.connect(em.input);
            o.start(t0); o.stop(t0 + len + 0.4);
        }
        end = Math.max(end, t0r + len + 0.5);
    }
    setTimeout(() => em.disconnect(), (end + 6) * 1000);
}
window._tfHorn = _tfHorn;

// ════════════════════════════════════════════════════════════════
//  形（近くの船だけ）
// ════════════════════════════════════════════════════════════════
const _tfU = {};
function _tfLocal(q, out) { worldLatLonToUnit(q.lat, q.lon, _tfU); return worldUnitToLocal(_tfU, out || {}); }
// 物理の面での向き（tug と同じ：前が (sin yaw, cos yaw)）
function _tfYaw(S, loc) {
    const n = _tfLocal({ lat: S.lat + 0.01, lon: S.lon }, {});
    return Math.atan2(n.x - loc.x, n.z - loc.z) - S.hdg * _tfR;
}
function _tfMats(S) {
    const L = S.liv;
    const mk = (hex, o) => { const m = new THREE.MeshStandardMaterial(Object.assign({ roughness: 0.65, metalness: 0.05 }, o || {})); m.color.setHex(hex).convertSRGBToLinear(); return typeof noShipLightProbe === 'function' ? noShipLightProbe(m) : m; };
    const win = mk(0x20262c, { roughness: 0.3, emissive: new THREE.Color(0xffc77a).convertSRGBToLinear(), emissiveIntensity: 0 });
    const M = { hull: mk(L.hull), boot: mk(L.boot), sup: mk(L.sup), fun: mk(L.fun), top: mk(L.top), deck: mk(L.deck || 0x8a7a60, { roughness: 0.9 }),
        dark: mk(0x2a2c2e), bands: mk(L.bands || L.top), win, gun: mk(0x55595c, { metalness: 0.3 }), box: [mk(0xb5452a), mk(0x2c5d8a), mk(0x3d7a3a), mk(0xc9a23a), mk(0x7a7f85)] };
    // 晴れた昼の影のくっきりさを、自分の船と同じに（61-ship-ao.js：空の見え方の焼き込みは無いので、その分は 1）
    if (typeof _aoPatchMaterial === 'function') for (const k in M) for (const m of [].concat(M[k])) _aoPatchMaterial(m);
    return M;
}
// いくつもの形を、材質ごとに 1 つにまとめる（描く回数を減らす）
function _tfMerge(parts) {
    const by = new Map();
    for (const p of parts) { let a = by.get(p.mat); if (!a) by.set(p.mat, a = []); a.push(p.geo.index ? p.geo.toNonIndexed() : p.geo); }
    const g = new THREE.Group();
    for (const [mat, geos] of by) {
        let n = 0; for (const q of geos) n += q.attributes.position.count;
        const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
        let o = 0;
        for (const q of geos) { pos.set(q.attributes.position.array, o * 3); nor.set(q.attributes.normal.array, o * 3); o += q.attributes.position.count; q.dispose(); }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
        geo.computeBoundingSphere();
        const m = new THREE.Mesh(geo, mat); m.castShadow = true; m.receiveShadow = true; m.userData.noLightBake = true;
        g.add(m);
    }
    return g;
}
function _tfBuildMesh(S) {
    const M = _tfMats(S), C = _tfClassOf(S), look = C.look;
    const L = S.L, B = S.B, d = S.d, hl = L / 2, hb = B / 2;
    const parts = [];
    const add = (geo, mat, x, y, z, ry) => { if (ry) geo.rotateY(ry); geo.translate(x || 0, y || 0, z || 0); parts.push({ geo, mat }); return geo; };
    const box = (w, h, dd, x, y, z, mat) => add(new THREE.BoxGeometry(w, h, dd), mat, x, y, z);
    const cyl = (r0, r1, h, x, y, z, mat, seg, rake) => { const g = new THREE.CylinderGeometry(r0, r1, h, seg || 12); if (rake) g.rotateX(-rake); return add(g, mat, x, y, z); };
    // 乾舷（水面から甲板まで）
    const fb = look === 'fishing' ? 2.2 : look === 'destroyer' ? 4.5 : look === 'carrier' ? 9 : look === 'cruise' || look === 'ferry' ? 8 : Math.max(5, Math.min(12, L * 0.045));
    // 上から見た形（船首がとがり、船尾は丸い）
    const sh = new THREE.Shape();
    const fine = look === 'destroyer' || look === 'cruiser' || look === 'liner' ? 0.32 : look === 'fishing' ? 0.3 : 0.2;
    sh.moveTo(0, hl);
    sh.quadraticCurveTo(hb * 0.9, hl * (1 - fine * 0.4), hb, hl * (1 - fine));
    sh.lineTo(hb, -hl * 0.78);
    sh.quadraticCurveTo(hb * 0.92, -hl, 0, -hl);
    sh.quadraticCurveTo(-hb * 0.92, -hl, -hb, -hl * 0.78);
    sh.lineTo(-hb, hl * (1 - fine));
    sh.quadraticCurveTo(-hb * 0.9, hl * (1 - fine * 0.4), 0, hl);
    const ext = (depth, y0, mat, s) => { const g = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: false, curveSegments: 6 }); g.rotateX(Math.PI / 2); if (s) g.scale(s, 1, s); g.translate(0, y0, 0); parts.push({ geo: g, mat }); };
    ext(fb - 0.8, fb, M.hull);                   // 水面より上
    ext(d + 0.8, 0.8, M.boot, 0.985);            // 水面のまわり・下（喫水線の塗り分け）
    ext(0.15, fb + 0.1, M.deck, 0.96);           // 甲板
    if (S.liv.bands && (look === 'liner')) ext(0.5, fb - 0.2, M.bands, 1.004);   // 舷側の帯
    const funnels = [];
    const funnel = (x, z, r, h, rake) => {
        const y0 = fb + h / 2;
        cyl(r * 0.92, r, h, x, y0, z, M.fun, 14, rake || 0);
        cyl(r * 0.93, r * 0.93, h * 0.14, x, fb + h * 0.93, z - Math.sin(rake || 0) * h * 0.45, M.top, 14, rake || 0);
        funnels.push(new THREE.Vector3(x, fb + h, z - Math.sin(rake || 0) * h * 0.5));
    };
    // 窓の帯は壁から 10cm ずつ出す（3cm だと、遠くから見ると壁と重なってちらついた）
    const winBand = (w, len, y, z) => { box(w + 0.2, 0.9, len * 0.96, 0, y, z, M.win); };
    const mast = (z, h, r) => cyl(r || 0.35, (r || 0.35) * 1.4, h, 0, fb + h / 2, z, M.dark, 8, 0.05);
    const tiers = (n, len0, w0, z0, hT, shrink) => {
        let y = fb, len = len0, w = w0;
        for (let i = 0; i < n; i++) { box(w, hT, len, 0, y + hT / 2, z0, M.sup); winBand(w, len, y + hT * 0.55, z0); y += hT; len *= shrink; w = Math.max(w * 0.97, w - 0.6); }
        return y;
    };
    let mastH = Math.min(45, L * 0.17), foreZ = hl * 0.62, aftZ = -hl * 0.6;
    switch (look) {
        case 'liner': {
            const top = tiers(S.L > 180 ? 4 : 3, L * 0.55, B * 0.78, L * 0.02, 2.7, 0.9);
            box(B * 0.5, 2.4, 6, 0, top + 1.2, L * 0.25, M.sup);           // 船橋
            const n = Math.max(1, S.fun || 1), span = L * 0.36, fh = Math.min(22, L * 0.085), fr = Math.max(1.6, L * 0.0135);
            for (let k = 0; k < n; k++) funnel(0, n === 1 ? -L * 0.02 : span / 2 - k * span / (n - 1) - L * 0.03, fr, fh + (top - fb), 0.14);
            box(B * 0.7, 2.6, L * 0.08, 0, fb + 1.3, hl * 0.78, M.sup);       // 船首楼
            box(B * 0.75, 2.6, L * 0.1, 0, fb + 1.3, -hl * 0.78, M.sup);      // 船尾楼
            mastH = Math.min(55, L * 0.2);
            break;
        }
        case 'cruise': {
            const top = tiers(Math.max(5, Math.round(L / 40)), L * 0.78, B * 0.98, -L * 0.03, 2.9, 0.97);
            box(B * 1.08, 1.4, 7, 0, top - 4, L * 0.31, M.sup);              // 船橋の張り出し
            funnel(0, -L * 0.3, Math.max(2.5, B * 0.12), 8 + (top - fb), 0.08);
            mastH = 6; foreZ = L * 0.31; aftZ = null;
            break;
        }
        case 'ferry': {
            const top = tiers(4, L * 0.62, B * 0.96, -L * 0.04, 2.8, 0.92);
            const n = Math.max(1, S.fun || 1);
            for (let k = 0; k < n; k++) funnel(n === 1 ? 0 : (k ? -B * 0.25 : B * 0.25), -L * 0.22, Math.max(1.5, B * 0.08), 6 + (top - fb), 0.06);
            mastH = 8; foreZ = L * 0.22; aftZ = null;
            break;
        }
        case 'steamer': {
            box(B * 0.95, 2.4, L * 0.12, 0, fb + 1.2, hl * 0.82, M.hull);   // 船首楼
            box(B * 0.95, 2.4, L * 0.14, 0, fb + 1.2, -hl * 0.8, M.hull);   // 船尾楼
            const top = tiers(2, L * 0.16, B * 0.8, 0, 2.6, 0.8);
            box(B * 0.55, 2.2, L * 0.05, 0, top + 1.1, L * 0.04, M.sup);
            funnel(0, -L * 0.05, Math.max(1.2, L * 0.016), 8 + (top - fb), 0.1);
            for (const z of [L * 0.27, L * 0.15, -L * 0.18, -L * 0.3]) box(B * 0.45, 1.2, L * 0.07, 0, fb + 0.6, z, M.dark);   // 船倉の口
            mastH = Math.min(30, L * 0.22); foreZ = L * 0.21; aftZ = -L * 0.24;
            break;
        }
        case 'battleship': case 'cruiser': {
            const bs = look === 'battleship';
            const top = tiers(2, L * 0.28, B * 0.6, L * 0.02, 2.6, 0.75);
            box(B * 0.35, 6, 5, 0, top + 3, L * 0.13, M.sup);              // 艦橋
            const n = Math.max(1, S.fun || 2), fr = Math.max(1.4, B * 0.07);
            for (let k = 0; k < n; k++) funnel(0, -L * 0.02 - k * L * 0.07, fr, 7 + (top - fb), 0.03);
            const turret = (z, flip) => {
                const tr = Math.max(3, B * (bs ? 0.22 : 0.17));
                cyl(tr, tr, 2.6, 0, fb + 1.6, z, M.gun, 16);
                for (const s of (bs ? [-0.6, 0.6] : [-0.5, 0.5])) { const g = new THREE.CylinderGeometry(0.35, 0.45, tr * 2.6, 8); g.rotateX(Math.PI / 2); add(g, M.gun, s, fb + 2.2, z + (flip ? -1 : 1) * tr * 1.6); }
            };
            turret(L * 0.3, false); turret(L * 0.2, false); turret(-L * 0.25, true); if (bs) turret(-L * 0.34, true);
            mastH = Math.min(38, L * 0.19); foreZ = L * 0.1; aftZ = -L * 0.14;
            break;
        }
        case 'destroyer': {
            box(B * 0.6, 2.4, L * 0.12, 0, fb + 1.2, L * 0.22, M.sup);
            box(B * 0.45, 2.2, 4, 0, fb + 3.4, L * 0.24, M.sup);
            const n = Math.max(1, S.fun || 2);
            for (let k = 0; k < n; k++) funnel(0, L * 0.08 - k * L * 0.09, Math.max(0.9, B * 0.09), 6, 0.08);
            for (const z of [L * 0.34, -L * 0.36]) { cyl(1.4, 1.4, 1.4, 0, fb + 0.9, z, M.gun, 12); const g = new THREE.CylinderGeometry(0.18, 0.22, 5, 6); g.rotateX(Math.PI / 2); add(g, M.gun, 0, fb + 1.2, z + (z > 0 ? 3 : -3)); }
            mastH = 14; foreZ = L * 0.18; aftZ = null;
            break;
        }
        case 'container': case 'tanker': case 'bulk': {
            // 船橋は船尾
            const top = tiers(look === 'container' ? 6 : 5, L * 0.07, B * 0.92, -L * 0.38, 2.8, 1);
            box(B * 1.05, 1.0, 5, 0, top - 1, -L * 0.36, M.sup);
            funnel(0, -L * 0.44, Math.max(1.4, B * 0.06), 4 + (top - fb) * 0.6, 0);
            if (look === 'container') {
                for (let z = -L * 0.31; z < L * 0.4; z += 13.5) {
                    const h = 2.6 * (2 + ((z * 7.3 + S.seed * 10) % 4 | 0));
                    box(B * 0.9, h, 12.2, 0, fb + h / 2, z, M.box[Math.abs(Math.round(z * 3 + S.seed * 50)) % M.box.length]);
                }
            } else if (look === 'tanker') {
                box(1.6, 1.2, L * 0.7, 0, fb + 0.6, L * 0.03, M.dark);          // 配管
                for (let z = -L * 0.28; z < L * 0.38; z += L * 0.08) box(B * 0.7, 0.4, 0.8, 0, fb + 0.6, z, M.dark);
            } else {
                for (let z = -L * 0.28; z < L * 0.38; z += L * 0.11) box(B * 0.62, 1.6, L * 0.07, 0, fb + 0.8, z, M.hull);
                for (let z = -L * 0.22; z < L * 0.36; z += L * 0.22) { cyl(0.8, 1, 8, B * 0.3, fb + 4, z, M.boot, 8); const j = new THREE.CylinderGeometry(0.4, 0.4, 20, 6); j.rotateZ(Math.PI / 2.6); add(j, M.boot, B * 0.05, fb + 9, z); }
            }
            mastH = 6; foreZ = L * 0.45; aftZ = null;
            break;
        }
        case 'carrier': {
            box(B * 1.45, 1.6, L * 1.02, B * 0.1, fb + 1.6, 0, M.deck);        // 飛行甲板
            box(B * 0.16, 9, L * 0.12, hb * 1.15, fb + 6.5, L * 0.02, M.sup);  // 島
            box(B * 0.12, 5, L * 0.05, hb * 1.15, fb + 13, L * 0.0, M.sup);
            funnel(hb * 1.15, -L * 0.05, Math.max(1.5, B * 0.05), 14, 0);
            mastH = 0; aftZ = null;
            break;
        }
        case 'fishing': default: {
            box(B * 0.6, 2.4, L * 0.18, 0, fb + 1.2, L * 0.2, M.sup);
            box(B * 0.62, 0.8, L * 0.185, 0, fb + 1.7, L * 0.2, M.win);
            box(B * 0.66, 0.2, L * 0.2, 0, fb + 2.5, L * 0.2, M.sup);
            cyl(0.3, 0.3, 2, 0, fb + 3, L * 0.12, M.fun, 8);
            funnels.push(new THREE.Vector3(0, fb + 4, L * 0.12));
            const gy = new THREE.BoxGeometry(B * 0.8, 0.4, 0.4); add(gy, M.dark, 0, fb + 5, -L * 0.3);
            for (const s of [-1, 1]) box(0.3, 5, 0.3, s * B * 0.38, fb + 2.5, -L * 0.3, M.dark);
            mastH = 7; foreZ = L * 0.3; aftZ = null;
            break;
        }
    }
    if (mastH > 0) { mast(foreZ, mastH); if (aftZ !== null) mast(aftZ, mastH * 0.9); }
    const g = _tfMerge(parts);
    // 航行灯：マスト灯（白）・舷灯（左舷 赤・右舷 緑：+x が左舷）・船尾灯（白）・停泊灯（全周の白：錨泊・停泊中）
    const Lt = [];
    const lamp = (hex, x, y, z, dir, half, key) => {
        const c = new THREE.Color(hex);
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: _tugGlowTex(), color: c, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, sizeAttenuation: false, toneMapped: false }));
        sp.position.set(x, y, z); sp.scale.setScalar(0.016); sp.renderOrder = 6; sp.userData.noBloom = true; g.add(sp);
        Lt.push({ sp, dir, half, key });
    };
    const mh = fb + Math.max(8, mastH);
    lamp(0xfff4e0, 0, mh, mastH > 0 ? foreZ : L * 0.3, [0, 0, 1], 112.5, 'mast');
    if (L > 50 && aftZ !== null) lamp(0xfff4e0, 0, mh * 0.9 + 4, aftZ, [0, 0, 1], 112.5, 'mast');
    const sideZ = look === 'liner' || look === 'steamer' ? L * 0.2 : look === 'container' || look === 'tanker' || look === 'bulk' ? -L * 0.36 : L * 0.25;
    lamp(0xff2a1a, hb * 1.02, fb + 6, sideZ, [0.83, 0, 0.56], 56.75, 'side');
    lamp(0x1aff6a, -hb * 1.02, fb + 6, sideZ, [-0.83, 0, 0.56], 56.75, 'side');
    lamp(0xfff4e0, 0, fb + 1.5, -hl, [0, 0, -1], 67.5, 'stern');
    lamp(0xfff4e0, 0, fb + 6, hl * 0.95, [0, 0, 1], 180, 'anchor');
    lamp(0xfff4e0, 0, fb + 4, -hl * 0.95, [0, 0, -1], 180, 'anchor');
    g.userData.lights = Lt; g.userData.funnels = funnels; g.userData.mats = M;
    g.name = 'Traffic:' + S.name;
    return g;
}
// カメラから船までの距離[m]（カメラで他の船を追っているとき、自分の船から遠くても、カメラの近くの船はよく描く）
const _tfCamU = {};
function _tfCamDist(S) {
    if (typeof camera === 'undefined' || !camera || !(S.dPl < TF_NEAR)) return S.dPl;
    const l = _tfLocal(S, _tfCamU);
    return Number.isFinite(l.x) ? Math.hypot(l.x - camera.position.x, l.z - camera.position.z) : S.dPl;
}
function _tfDropMesh(S) {
    if (!S || !S.mesh) return;
    if (typeof scene !== 'undefined' && scene) scene.remove(S.mesh);
    if (S.mesh.userData.saved) {
        // 保存した船：形・材質は共有なので、灯の絵だけ捨てる
        S.mesh.traverse(o => { if (o.isSprite) o.material.dispose(); });
        const P = _tfProto.get(S.mesh.userData.saved); if (P) P.users = Math.max(0, P.users - 1);
        S.mesh = null;
        return;
    }
    S.mesh.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material && o.material.isSpriteMaterial) o.material.dispose(); });
    const M = S.mesh.userData.mats;
    if (M) for (const k in M) { const m = M[k]; if (Array.isArray(m)) m.forEach(x => x.dispose()); else if (m && m.dispose) m.dispose(); }
    S.mesh = null;
}
const _tfV = new THREE.Vector3(), _tfD3 = new THREE.Vector3();
function _tfVisual(S, t, vis, night) {
    const loc = _tfLocal(S, {});
    if (!Number.isFinite(loc.x)) { _tfDropMesh(S); return; }
    // 保存した船：その船のモデルだけで描く（読み込むまで・メモリが足りずに読み込めない間は描かない。ほかの形で代わりに出さない）
    if (S.saved) {
        const P = _tfProto.get(S.saved.key);
        if (!P && !_tfProtoBusy && S.protoOK && _tfProtoRoom()) _tfLoadProto(S.saved);
        if (P && P.state === 'fail') { _tfDropMesh(S); S.st = 'gone'; S.noRespawn = true; return; }      // モデルが読めない船は出さない
        if (!S.mesh && P && P.state === 'ok' && S.protoOK) { S.mesh = _tfBuildSavedMesh(S, P); scene.add(S.mesh); }
        if (S.mesh && !S.protoOK) _tfDropMesh(S);
        if (!S.mesh) return;
    }
    if (!S.mesh) { S.mesh = _tfBuildMesh(S); scene.add(S.mesh); }
    const g = S.mesh, yaw = _tfYaw(S, loc);
    const H = (x, z) => (typeof getOceanHeight === 'function') ? getOceanHeight(x, z, t) : 0;
    const fx = Math.sin(yaw), fz = Math.cos(yaw), hl = S.L * 0.35, hb = S.B * 0.5;
    const oh = H(loc.x, loc.z);
    const pitch = Math.atan2(H(loc.x + fx * hl, loc.z + fz * hl) - H(loc.x - fx * hl, loc.z - fz * hl), 2 * hl);
    const roll = Math.atan2(H(loc.x + fz * hb, loc.z - fx * hb) - H(loc.x - fz * hb, loc.z + fx * hb), 2 * hb);
    // 浸水して沈んだ分・傾いた分（65-ship-hits.js）
    const dp = S.dmg && typeof trafficDamagePose === 'function' ? trafficDamagePose(S) : null;
    g.position.set(loc.x, oh * 0.8 - (dp ? dp.sink : 0), loc.z);
    g.rotation.set(-pitch * 0.7 + (dp ? dp.trim : 0), yaw, roll * 0.6 - (dp ? dp.heel : 0), 'YXZ');
    // 見える距離：自分の船とカメラの近い方から（カメラで追っている船はいつも）
    const dV = S.id === traffic.camFollow ? 0 : Math.min(S.dPl, Math.hypot(loc.x - camera.position.x, loc.z - camera.position.z));
    g.visible = dV < vis * 1.4 + S.L;
    // 影は近く（TF_SHADOW_NEAR）の船だけ落とす（影の地図に描く数を減らす）
    const sh = S.dPl < TF_SHADOW_NEAR;
    if (g.userData.shadowOn !== sh) { g.userData.shadowOn = sh; g.traverse(o => { if (o.isMesh) { if (o.userData.cs0 === undefined) o.userData.cs0 = o.castShadow; o.castShadow = sh && o.userData.cs0; } }); }
    g.updateMatrixWorld();
    // 窓の明かり（夜）
    const M = g.userData.mats;
    if (M && M.win) M.win.emissiveIntensity = night * 1.6;
    // 航行灯：夜・霧。錨泊・停泊中は停泊灯だけ
    const fogDay = (window.weather && weather.enabled && (weather.fog || 0) > 0.4) ? 1 : 0;
    const on = Math.max(night, fogDay);
    const moving = S.st === 'go' || S.st === 'anchoring' || S.st === 'unberth' || S.st === 'berthing' || S.st === 'holding';
    const camP = camera.position;
    for (const q of g.userData.lights) {
        const lit = on > 0.05 && g.visible && (q.key === 'anchor' ? !moving : moving);
        q.sp.visible = lit;
        if (!lit) continue;
        q.sp.getWorldPosition(_tfV);
        _tfD3.set(q.dir[0], q.dir[1], q.dir[2]).applyQuaternion(g.quaternion);
        const tx = camP.x - _tfV.x, tz = camP.z - _tfV.z, dd = Math.hypot(tx, tz) || 1;
        const cosA = (tx * _tfD3.x + tz * _tfD3.z) / dd, lim = Math.cos(q.half * _tfR);
        const v = q.half >= 180 ? 1 : THREE.MathUtils.smoothstep(cosA, lim - 0.05, lim + 0.05);
        q.sp.material.opacity = on * v * Math.max(0, Math.min(1, 1.6 - dd / (vis * 1.2)));
        q.sp.scale.setScalar((0.01 + 0.012 * Math.min(1, dd / 1500)) * (q.k || 1));
    }
    // 排煙（昔の船・近くだけ）
    if (typeof puffEmit === 'function' && S.dPl < 3500 && g.visible) {
        const old = _tfClassOf(S).era === 'old' || ['fishing', 'destroyer', 'cruiser'].includes(S.cls);
        const p = Math.min(1, (S.v || 0) / Math.max(1, S.vSea));
        const last = S.smokeT === undefined ? t : S.smokeT, dtS = Math.min(0.5, Math.max(0, t - last)); S.smokeT = t;
        S.smokeAcc = (S.smokeAcc || 0) + dtS * (old ? 1.5 + 4 * p : 0.6 + 1.2 * p) * g.userData.funnels.length;
        while (S.smokeAcc >= 1) {
            S.smokeAcc -= 1;
            const f = g.userData.funnels[(Math.random() * g.userData.funnels.length) | 0];
            if (!f) break;
            const w = (g.userData.funnelParent || g).localToWorld(_tfV.copy(f));
            const c = old ? 0.18 + Math.random() * 0.08 : 0.45 + Math.random() * 0.1;
            const vx = fx * (S.v || 0) * 0.5, vz = fz * (S.v || 0) * 0.5;
            puffEmit({ x: w.x, y: w.y, z: w.z, vx, vy: 2 + 2 * p, vz, life: 7 + Math.random() * 5, s0: Math.max(1.5, S.L * 0.012), s1: 12 + S.L * 0.06 * (old ? 1 : 0.5),
                r: c, g: c, b: c * 1.03, a: old ? 0.4 + 0.25 * p : 0.12, rise: 0.5, drag: 0.4 });
        }
    }
}

// ════════════════════════════════════════════════════════════════
//  毎フレーム（17-main-loop.js から）
// ════════════════════════════════════════════════════════════════
//  t：実時間（見た目・汽笛の音）、dt：物理の時間（物理早送り physicsSpeed を掛けたもの）
//  船の動き・ルール・合図の間合いは、物理の時間（traffic.t）で進める。早送りのときは、近くの船を細かく刻んで進める

// ════════════════════════════════════════════════════════════════
//  他の船のタグ（大きな船の離着岸・港の中でその場で回すとき）
// ════════════════════════════════════════════════════════════════
//  自分の船から 3km 以内で見えている大きな船（長さ 110m 以上）に、2 隻（船首・船尾）付ける。形は 47-tugboats.js と同じ。
//  ・その場で回す：船首と船尾を反対の向きへ押す
//  ・岸壁へ寄せる：岸壁から遠い側から押す。岸壁から離す：岸壁から遠い側から引く
//  終わったら離れていって、見えなくなったら次の船に使う（いちどに 6 隻まで）
const TF_TUG_MAX = 6;
const _tfTugs = [];
function _tfTugWanted(S) {
    if (S.L < 110 || S.cls === 'fishing' || S.cls === 'destroyer' || !(S.dPl < 3000) || !S.mesh || !S.mesh.visible) return false;
    if (S.st === 'berthing' || S.st === 'unberth') return true;
    return (S.st === 'go' || S.st === 'anchoring') && traffic.t < (S.tugKeep || 0);
}
// 船の中の持ち場（物理の面の x, z と、タグの向き yaw）
function _tfTugStation(S, H, i) {
    const st = S.steps && S.steps[0];
    const w = S.B / 2 + TUG_LEN / 2 + 0.8, a = (i === 0 ? 1 : -1) * S.L * 0.3;
    const at = (sd, k) => ({ x: H.x + H.fx * a + H.sx * sd * w * k, z: H.z + H.fz * a + H.sz * sd * w * k });
    // その場で回す：右へ回すなら、船首のタグは左舷側（+）から右へ、船尾のタグは右舷側から左へ押す
    const rotTo = st && st.k === 'rot' ? st.hdg : (S.turning && S.path ? _tfTangent(S.path, S.s, S.k) : null);
    if (rotTo !== null && Math.abs(_tfWrap(rotTo - S.hdg)) > 1) {
        const sd = (i === 0 ? 1 : -1) * (Math.sign(_tfWrap(rotTo - S.hdg)) || 1);
        return Object.assign(at(sd, 1), { yaw: Math.atan2(-sd * H.sx, -sd * H.sz), force: 0.6 });
    }
    // 岸壁の側（+：左舷側）。タグは反対の側に付く
    let quay = 0;
    if (S.geo && S.geo.face && (S.st === 'berthing' || S.st === 'unberth')) { const c = _tfLocal(S.geo.face, {}); quay = Math.sign((c.x - H.x) * H.sx + (c.z - H.z) * H.sz) || 1; }
    const away = quay ? -quay : (i === 0 ? 1 : -1);
    let toward = 1;
    if (st && st.k === 'move' && st.to && quay) { const c = _tfLocal(st.to, {}); const m = (c.x - H.x) * H.sx + (c.z - H.z) * H.sz; if (Math.abs(m) > 0.5) toward = Math.sign(m) === quay ? 1 : -1; }
    if (toward < 0) return Object.assign(at(away, 1.8), { yaw: Math.atan2(away * H.sx, away * H.sz), force: 0.6 });   // 引く（索の分だけ離れて）
    return Object.assign(at(away, 1), { yaw: Math.atan2(-away * H.sx, -away * H.sz), force: st && st.k === 'move' ? 0.5 : 0.15 });
}
function _tfTugTake(S, i, H) {
    let T = _tfTugs.find(x => x.state === 'idle');
    if (!T) {
        if (_tfTugs.length >= TF_TUG_MAX || typeof _tugBuild !== 'function') return null;
        const g = _tugBuild();
        if (typeof _tfMergeProto === 'function') _tfMergeProto(g);
        g.name = 'TrafficTug';
        T = { g, S: null, i: 0, x: 0, z: 0, yaw: 0, vel: { x: 0, z: 0 }, state: 'idle', action: 'push', force: 0 };
        _tfTugs.push(T);
    }
    // 船から 250m ほど離れた所（岸壁から遠い側の水の上）から来る
    const st = _tfTugStation(S, H, i);
    const dx = st.x - H.x, dz = st.z - H.z, d = Math.hypot(dx, dz) || 1;
    T.x = H.x + dx / d * 250 + H.fx * (i === 0 ? 1 : -1) * 120; T.z = H.z + dz / d * 250 + H.fz * (i === 0 ? 1 : -1) * 120;
    T.yaw = Math.atan2(st.x - T.x, st.z - T.z);
    T.S = S; T.i = i; T.state = 'coming'; T.t = 0; T.force = 0.5;
    if (!T.g.parent) scene.add(T.g);
    T.g.visible = true;
    return T;
}
function _tfTugTick(t, dt) {
    if (!_tfTugs.length && !traffic.ships.some(_tfTugWanted)) return;
    // 要る船に（近い船から）2 隻ずつ
    for (const S of traffic.ships.filter(_tfTugWanted).sort((a, b) => a.dPl - b.dPl)) {
        const H = _tfHullOf(S); if (!H) continue;
        for (let i = 0; i < 2; i++) if (!_tfTugs.some(T => T.S === S && T.i === i && T.state !== 'leaving')) _tfTugTake(S, i, H);
    }
    for (const T of _tfTugs) {
        if (T.state === 'idle') continue;
        const S = T.S;
        let tx, tz, tyaw = null, spd = 6;
        if (T.state !== 'leaving' && S && traffic.ships.includes(S) && _tfTugWanted(S)) {
            const H = _tfHullOf(S);
            if (H) { const st = _tfTugStation(S, H, T.i); tx = st.x; tz = st.z; tyaw = st.yaw; T.force = st.force; T.action = st.force > 0 && Math.abs(_tfWrap((st.yaw - Math.atan2(-H.sx, -H.sz)) / _tfR)) > 90 ? 'pull' : 'push'; }
        }
        if (tx === undefined) {
            if (T.state !== 'leaving') { T.state = 'leaving'; T.t = 0; T.lx = T.x + Math.sin(T.yaw) * -500; T.lz = T.z + Math.cos(T.yaw) * -500; T.force = 0.4; }
            T.t += dt; tx = T.lx; tz = T.lz;
            if (T.t > 100) { T.state = 'idle'; T.S = null; T.g.visible = false; if (T.g.parent) T.g.parent.remove(T.g); continue; }
        }
        const dx = tx - T.x, dz = tz - T.z, d = Math.hypot(dx, dz);
        const step = Math.min(d, spd * dt);
        if (d > 0.05) { T.x += dx / d * step; T.z += dz / d * step; }
        T.vel.x = d > 0.05 ? dx / d * step / Math.max(1e-3, dt) : 0; T.vel.z = d > 0.05 ? dz / d * step / Math.max(1e-3, dt) : 0;
        if (T.state === 'coming' && d < 3) T.state = 'on';
        if (T.state === 'on' && d > 30) T.state = 'coming';
        // 向き：動いている間は進む向き、持ち場ではその向き
        const yw = (d > 10 || tyaw === null) ? Math.atan2(dx, dz) : tyaw;
        let e = yw - T.yaw; while (e > Math.PI) e -= 2 * Math.PI; while (e < -Math.PI) e += 2 * Math.PI;
        T.yaw += e * Math.min(1, dt * 1.2);
        // 形
        const H2 = (x, z) => (typeof getOceanHeight === 'function') ? getOceanHeight(x, z, t) : 0;
        const fx = Math.sin(T.yaw), fz = Math.cos(T.yaw);
        const pitch = Math.atan2(H2(T.x + fx * 10, T.z + fz * 10) - H2(T.x - fx * 10, T.z - fz * 10), 20);
        const roll = Math.atan2(H2(T.x + fz * 4, T.z - fx * 4) - H2(T.x - fz * 4, T.z + fx * 4), 8);
        T.g.position.set(T.x, H2(T.x, T.z), T.z);
        T.g.rotation.set(-pitch * 0.8, T.yaw, roll * 0.8, 'YXZ');
        T.g.updateMatrixWorld();
        if (typeof _tugLights === 'function') _tugLights(T);
        if (typeof _tugSmoke === 'function') _tugSmoke(T, t);
    }
}
function _tfTugClear() { for (const T of _tfTugs) { T.state = 'idle'; T.S = null; T.g.visible = false; if (T.g.parent) T.g.parent.remove(T.g); } }
function updateTraffic(t, dt) {
    dt = Math.min(TF_DT_MAX, Math.max(0, dt || 0));
    if (!traffic.on || !window.world || world.mode !== 'world' || typeof scene === 'undefined') {
        if (traffic.ships.length || traffic.key) { _tfClear(); traffic.key = ''; }
        return;
    }
    // 保存した船の組み合わせ（保存の一覧を読むのは重いので、3 秒ごと）
    if (traffic.sig === undefined || !(t - (traffic.sigT || -1e9) < 3) || t < traffic.sigT) {
        traffic.sigT = t; traffic.sig = _tfSavedSig();
        // 保存した船の名前：変わったら、同じ名前の他の船を入れ替える
        const nk = _tfSavedNameKeys(), nsig = [...nk].sort().join('|');
        if (nsig !== traffic.savedNamesSig) { traffic.savedNames = nk; traffic.savedNamesSig = nsig; _tfDropSavedNameDupes(); }
    }
    const key = _tfWorldKey() + '|' + traffic.density + '|' + traffic.era + '|' + traffic.sig;
    if (key !== traffic.key) { _tfClear(); traffic.key = key; traffic.initT = t; }
    if (!traffic.ready) {
        if (!world.ports || t - traffic.initT < 3) return;
        _tfSpawnFleet(); traffic.ready = true;
    }
    const hdSig = traffic.key + '|' + ((typeof _RW !== 'undefined' && _RW && _RW.hd) ? _RW.hd.map(d => d.key).join(',') : '');
    if (hdSig !== traffic.hdSig) { traffic.hdSig = hdSig; _tfDC.clear(); for (const P of _tfPorts()) P._tfGeo = null; }
    _tfLanePump();
    const me = _tfPlayerLL();
    for (const S of traffic.ships) S.dPl = (S.st === 'off' || S.st === 'gone') ? Infinity : _tfDist(me, S);
    traffic.farAcc += dt;
    const farStep = traffic.farAcc >= TF_FAR_DT, dF = traffic.farAcc;
    if (farStep) traffic.farAcc = 0;
    if (farStep) for (const S of traffic.ships) if (S.st !== 'gone' && !(S.dPl < TF_NEAR)) _tfStep(S, dF, true);
    // 近くの船：0.25 秒以下に刻んで進める（0.5 秒ごとにルール・合図）
    for (let rem = dt; rem > 1e-6;) {
        const h = Math.min(TF_SUB, rem); rem -= h;
        traffic.t += h;
        for (const S of traffic.ships) if (S.st !== 'gone' && S.dPl < TF_NEAR) _tfStep(S, h, false);
        traffic.ruleAcc += h;
        if (traffic.ruleAcc >= 0.5) { traffic.ruleAcc -= 0.5; if (traffic.ruleAcc > 0.5) traffic.ruleAcc = 0; _tfRules(); _tfPlayerAuto(); }
        _tfLaterTick();
    }
    traffic._hulls = null;
    _tfCollide(dt);
    if (farStep) {
        _tfPlayerBerthKeep();
        _tfProtoTick(dF);
        const going = typeof autopilot !== 'undefined' && (autopilot.active || autopilot.planning) && autopilot.dest && !autopilot.dest.point;
        const berthing = typeof harborAuto !== 'undefined' && harborAuto.mode === 'berth';
        if (going) _tfPlayerReserve(autopilot.dest);
        else if (berthing && harborAuto.plan && harborAuto.plan.port) _tfPlayerReserve(harborAuto.plan.port);
        else if (!berthing && traffic.player.reserve) _tfPlayerReserve(null);
        _tfEncounterTick(dF);
    }
    // 居なくなった船（行き先の無い船）は、そのうち別の船に入れ替える
    if (farStep) for (let i = traffic.ships.length - 1; i >= 0; i--) {
        const S = traffic.ships[i];
        if (S.st !== 'gone') continue;
        _tfDropMesh(S); if (S.port) _tfSlotFree(S.port, S.id); if (S.mPort) _tfSlotFree(S.mPort, S.id); if (S.to && S.to.P) _tfSlotFree(S.to.P, S.id);
        traffic.ships.splice(i, 1);
        //（保存した船は、会社の航路を回る船も、そのうちまた出す）
        if ((!S.svc || S.saved) && !S.transient && !S.noRespawn) { const N = S.saved ? _tfMakeShip(_tfSavedSpec(S.saved)) : _tfMakeShip({ cls: S.cls }); _tfSeed(N); traffic.ships.push(N); }
    }
    // 世界地図・一覧を開いていれば、ときどき描き直す
    if ((traffic.mapT = (traffic.mapT || 0) + dt) > 2) {
        traffic.mapT = 0;
        if (typeof _wm !== 'undefined' && _wm.open && typeof worldMapRedraw === 'function') worldMapRedraw(true);
        trafficPanelRender();
    }
    // 形：見える範囲の船だけ
    const vis = _tfVisM(), night = typeof lightingNightFactor === 'number' ? lightingNightFactor : 0;
    _tfProtoAOStep();
    // 保存した船の窓の明かり：昼は消し、夜は点ける（自分の船の updateWindowGlow と同じ係数）
    const glowK = night * ((typeof lightSettings !== 'undefined' && Number.isFinite(lightSettings.windowGlowMult)) ? lightSettings.windowGlowMult : 1);
    for (const P of _tfProto.values()) if (P.glow && P.users > 0 && P.glowK !== glowK) { P.glowK = glowK; for (const [m, base] of P.glow) m.emissiveIntensity = base * glowK; }
    {
        // （カメラで追っている船はいちばん先に：遠くて後回しにされると、モデルが外れて追うのが切れ、
        //  カメラが自分の船へ飛んで戻る。外から見ると、追っていた船が遠くへ瞬間移動したように見えていた）
        const fol = traffic.camFollow, near = (S) => Math.min(S.dPl, _tfCamDist(S));
        const show = traffic.ships.filter(S => S.saved && (S.dPl < Math.min(TF_SHOW, vis * 1.5 + 2000) || (S.id === fol && S.dPl < TF_NEAR)) && _tfShown(S))
            .sort((a, b) => (b.id === fol) - (a.id === fol) || near(a) - near(b));
        // 近い船から、モデルの大きさの合計が予算に収まるだけ（同じモデルの船は 1 つ分）
        const keys = new Set(), mx = _tfProtoMax(), budget = _tfProtoBudget(), PB = traffic.protoBytes || new Map();
        let used = 0;
        for (const S of show) {
            const k = S.saved.key; if (keys.has(k)) continue;
            const b = PB.get(k) || TF_PROTO_GUESS;
            if (keys.size && (keys.size >= mx || used + b > budget)) continue;
            keys.add(k); used += b;
        }
        for (const S of traffic.ships) if (S.saved) S.protoOK = keys.has(S.saved.key) && !(traffic.savedHoldUntil && performance.now() < traffic.savedHoldUntil);
    }
    for (const S of traffic.ships) {
        if ((S.dPl < Math.min(TF_SHOW, vis * 1.5 + 2000) || (S.id === traffic.camFollow && S.dPl < TF_NEAR)) && S.st !== 'off' && S.st !== 'gone' && S.st !== 'pending') _tfVisual(S, t, vis, night);
        else if (S.mesh && !(S.dPl < TF_SHOW + 1500)) _tfDropMesh(S);
        else if (S.mesh) S.mesh.visible = false;
    }
    _tfTugTick(t, Math.min(0.5, Math.max(0, t - (traffic.tugT ?? t))));
    traffic.tugT = t;
    _tfFollowTick();
}
window.updateTraffic = updateTraffic;

// ════════════════════════════════════════════════════════════════
//  地図（世界地図：43-world.js・小さな地図：48-minimap.js から呼ぶ）
// ════════════════════════════════════════════════════════════════
const TF_MAP_COLOR = { liner: '#ffd27a', coastal: '#ffe9a8', steamer: '#c9d3dc', dreadnought: '#9aa6b0', cruiser: '#9aa6b0', destroyer: '#9aa6b0', cruise: '#ffffff', ferry: '#bfe3ff', container: '#ffb08a', tanker: '#d8a0ff', bulk: '#d9c48a', carrier: '#9aa6b0', fishing: '#9be39b' };
function _tfShown(S) { return S.st !== 'off' && S.st !== 'gone' && S.st !== 'pending' && Number.isFinite(S.lat); }
function trafficDrawMap(g, cv, W, H) {
    if (!traffic.on || typeof _wmToScreen !== 'function') return;
    const z = _wm.zoom, labels = z >= 120;
    const pxPerM = 1 / (_wmDegPerPx() * 111320);
    g.save(); g.font = '10px sans-serif'; g.textBaseline = 'middle';
    for (const S of traffic.ships) {
        if (!_tfShown(S)) continue;
        const s = _wmToScreen(S.lat, S.lon, cv);
        if (s.x < -10 || s.x > W + 10 || s.y < -10 || s.y > H + 10) continue;
        g.save(); g.translate(s.x, s.y); g.rotate(S.hdg * _tfR);
        const r = Math.max(3, Math.min(7, 2 + S.L / 60));
        g.fillStyle = TF_MAP_COLOR[S.cls] || '#ddd'; g.strokeStyle = _wm.chart ? '#16283c' : '#0a1932'; g.lineWidth = 1;
        const len = S.L * pxPerM, wid = Math.max(3, S.B * pxPerM);
        if (len > 16) {
            // 大きく拡大したら、本当の大きさの形で
            g.beginPath(); g.moveTo(0, -len / 2); g.lineTo(wid / 2, -len / 2 + wid * 1.2); g.lineTo(wid / 2, len / 2); g.lineTo(-wid / 2, len / 2); g.lineTo(-wid / 2, -len / 2 + wid * 1.2); g.closePath(); g.fill(); g.stroke();
        } else { g.beginPath(); g.moveTo(0, -r * 1.4); g.lineTo(r * 0.6, r); g.lineTo(-r * 0.6, r); g.closePath(); g.fill(); g.stroke(); }
        g.restore();
        if (labels) { g.fillStyle = _wm.chart ? '#16283c' : 'rgba(255,255,255,0.85)'; g.fillText(S.name, s.x + 7, s.y + 7); }
    }
    _tfDrawMapExtras(g, cv);
    g.restore();
}
window.trafficDrawMap = trafficDrawMap;
function trafficDrawMinimap(g, toS, k, c, rot) {
    if (!traffic.on || !traffic.ships.length) return;
    const R = c / k + 500;
    for (const S of traffic.ships) {
        if (!_tfShown(S) || !(S.dPl < R)) continue;
        const loc = _tfLocal(S, {});
        if (!Number.isFinite(loc.x)) continue;
        const q = toS(loc.x, loc.z);
        if (Math.hypot(q.x, q.y) > c + 6) continue;
        const len = Math.max(7, S.L * k), wid = Math.max(3, S.B * k);
        g.save(); g.translate(q.x, q.y); g.rotate(S.hdg * _tfR);
        g.fillStyle = TF_MAP_COLOR[S.cls] || '#ddd'; g.strokeStyle = '#0a1932'; g.lineWidth = 1;
        g.beginPath(); g.moveTo(0, -len / 2); g.lineTo(wid / 2, -len / 2 + wid * 0.8); g.lineTo(wid / 2, len / 2); g.lineTo(-wid / 2, len / 2); g.lineTo(-wid / 2, -len / 2 + wid * 0.8); g.closePath(); g.fill(); g.stroke();
        g.restore();
        if (k * 1000 > 25) { g.save(); g.translate(q.x, q.y); g.rotate(-rot); g.font = '8px sans-serif'; g.fillStyle = _wm.chart ? '#16283c' : '#fff'; g.fillText(S.name, 6, 8); g.restore(); }
    }
}
window.trafficDrawMinimap = trafficDrawMinimap;

// ════════════════════════════════════════════════════════════════
//  地図で他の船を選ぶ・追う・置く（43-world.js の世界地図から）
// ════════════════════════════════════════════════════════════════
function _tfById(id) { return id == null ? null : traffic.ships.find(S => S.id === id) || null; }
function _tfPlaceName(x) { return !x ? '' : x.P ? worldBerthLabel(x.P) : x.G ? x.G.name : x.pt ? '地図で置いた所' : ''; }
// 地図の点 p（画面の座標）の近く（14 点以内）の他の船
function trafficPickAt(p, cv) {
    if (!traffic.on || typeof _wmToScreen !== 'function') return null;
    let best = null, bd = 14;
    for (const S of traffic.ships) {
        if (!_tfShown(S)) continue;
        const q = _wmToScreen(S.lat, S.lon, cv), d = Math.hypot(q.x - p.x, q.y - p.y);
        if (d < bd) { bd = d; best = S; }
    }
    return best;
}
window.trafficPickAt = trafficPickAt;
// 地図の点 p の近く（14 点以内）の他の船を、近い順に全部（印が重なっているとき、押すたびに順に選ぶ：43-world.js）
function trafficPickAllAt(p, cv) {
    if (!traffic.on || typeof _wmToScreen !== 'function') return [];
    const out = [];
    for (const S of traffic.ships) {
        if (!_tfShown(S)) continue;
        const q = _wmToScreen(S.lat, S.lon, cv), d = Math.hypot(q.x - p.x, q.y - p.y);
        if (d < 14) out.push({ S, d });
    }
    return out.sort((a, b) => a.d - b.d).map(x => x.S);
}
window.trafficPickAllAt = trafficPickAllAt;
// 選んだ船の説明：会社・種類・大きさ、速力、どこからどこへ、と「追う」ボタン
function trafficShipInfoHTML(id) {
    const S = _tfById(id), close = `<button onclick="_wm.selShip=null;_wm.followShip=null;_wmShowInfo();worldMapRedraw(true)">閉じる</button>`;
    if (!S || !_tfShown(S)) return `<div class="wp-pmeta">この船は見えなくなりました（外洋へ出た・入れ替わった）</div><div class="wp-pbtns">${close}</div>`;
    const C = _tfClassOf(S), kn = (S.v || 0) / 0.514444;
    const from = S.st === 'berth' ? (S.port ? worldBerthLabel(S.port) : '') : _tfPlaceName(S.from);
    const to = S.st === 'berth' ? '（停泊中）' : _tfPlaceName(S.to) || '—';
    const gname = (r) => { const G = (TF_GATES[world.realKey] || []).find(g => g.key === r); return G ? G.name : String(r).replace(/^.*?港 /, ''); };
    const cam = traffic.camFollow === S.id, mapF = _wm.followShip === S.id, canCam = S.dPl < TF_SHOW;
    const chase = typeof autopilot !== 'undefined' && autopilot.chase && autopilot.chase.id === S.id;
    const canChase = typeof apChaseStart === 'function' && S.st !== 'berth' && S.st !== 'berthing' && S.st !== 'unberth';
    return `<div class="wp-pname"><span style="color:${TF_MAP_COLOR[S.cls] || '#ddd'}">▲</span> ${S.name}</div>
        <div class="wp-pmeta">${S.line ? S.line + '・' : ''}${C.label}・全長 ${S.L}m・喫水 ${S.d}m<br>
        ${TF_STATE_LABEL[S.st] || ''}　速力 ${kn.toFixed(1)} ノット（最大 ${S.kn} ノット）<br>
        航路：${from || '—'} → ${to}${S.svc ? `<br><small>決まった航路：${S.svc.route.map(gname).join(' → ')}</small>` : ''}<br>
        ${worldFmtLatLon(S.lat, S.lon)}・今の場所から ${(S.dPl / 1852).toFixed(1)} 海里${S.why || S.waitWhy ? `<br>${S.why || S.waitWhy}` : ''}</div>
        <div class="wp-pbtns">
          <button ${canCam || cam ? '' : 'disabled title="近く（12km 以内）の船だけ"'} onclick="trafficFollow(${cam ? 'null' : S.id})">${cam ? '🎥 追うのをやめる' : '🎥 カメラで追う'}</button>
          <button onclick="_wm.followShip=${mapF ? 'null' : S.id};_wmShowInfo();worldMapRedraw(true)">${mapF ? '📍 地図で追うのをやめる' : '📍 地図で追う'}</button>
          ${chase ? `<button class="on" onclick="apChaseStop('並走をやめました（機関はそのまま）','keep');_wmShowInfo()">🚢 並走をやめる</button>`
                  : `<small style="align-self:center">🚢 自分の船で追いかけて付く：</small>${[[1, '右舷側'], [-1, '左舷側'], [0, '後ろ']].map(([v, l]) => `<button ${canChase ? '' : 'disabled title="岸壁に着いている・着けている船は追えません"'} onclick="apChaseStart(${S.id}, ${v});_wmShowInfo()">${l}</button>`).join('')}`}
          ${close}</div>
        ${_tfShipEditHTML(S)}`;
}
window.trafficShipInfoHTML = trafficShipInfoHTML;
// この船の行き先・追従を変える欄（選んでいる途中の値は _wm.tfForm に覚える：欄は 1 秒ごとに描き直す）
function _tfShipEditHTML(S) {
    if (S.st === 'damaged') return '';
    const F = (_wm.tfForm && _wm.tfForm.id === S.id) ? _wm.tfForm : (_wm.tfForm = { id: S.id, lead: S.follow ? String(S.follow.id) : 'player', side: S.follow ? String(S.follow.side) : '1', dest: '' });
    const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const others = traffic.ships.filter(O => O !== S && _tfShown(O) && O.st !== 'damaged' && _tfDist(S, O) < 40000)
        .sort((a, b) => _tfDist(S, a) - _tfDist(S, b)).slice(0, 25);
    const leadOpts = [['player', '自分の船']].concat(others.map(O => [String(O.id), `${O.name}（${(_tfDist(S, O) / 1852).toFixed(1)}海里${O.follow ? '・追従中' : ''}）`]))
        .map(([v, l]) => `<option value="${v}" ${F.lead === v ? 'selected' : ''}>${esc(l)}</option>`).join('');
    const sideOpts = [['1', '右舷側'], ['-1', '左舷側'], ['0', '後ろ']].map(([v, l]) => `<option value="${v}" ${F.side === v ? 'selected' : ''}>${l}</option>`).join('');
    const ports = _tfPorts().filter(P => P.id && Number.isFinite(P.lat)).map(P => [P, _tfDist(S, P)]).sort((a, b) => a[1] - b[1]).slice(0, 60);
    const destOpts = `<option value="">（選んでください）</option>` + ports.map(([P, dd]) => `<option value="${esc(P.id)}" ${F.dest === P.id ? 'selected' : ''}>${esc(worldBerthLabel ? worldBerthLabel(P) : P.name)}（${(dd / 1852).toFixed(0)}海里）</option>`).join('');
    const fol = S.follow ? `<div class="wp-side">🔗 ${esc(_tfLeaderName(S.follow.id))}の${S.follow.side === 1 ? '右舷側' : S.follow.side === -1 ? '左舷側' : '後ろ'}に付いていきます${S.follow.mode === 'astern' && S.follow.side ? '（横が浅いので、今は後ろ）' : ''}${S.followReq ? '（離岸してから）' : ''}
        <button onclick="trafficSetFollow(${S.id}, null)">やめる</button></div>` : '';
    return `<div class="wp-pmeta" style="margin-top:6px">この船を動かす</div>${fol}
        <div class="wp-side">追従：<select onchange="_wm.tfForm.lead=this.value">${leadOpts}</select>
          <select onchange="_wm.tfForm.side=this.value">${sideOpts}</select>
          <button onclick="trafficSetFollow(${S.id}, _wm.tfForm.lead, _wm.tfForm.side)">🔗 付いていかせる</button></div>
        <div class="wp-side">行き先：<select onchange="_wm.tfForm.dest=this.value" style="max-width:14em">${destOpts}</select>
          <button onclick="if(_wm.tfForm.dest)trafficSetDest(${S.id}, _wm.tfForm.dest)">➡ そこへ行かせる</button></div>`;
}
// カメラで他の船を追う：カメラの注視点をその船に付けて動かす（向き・距離は指で変えられる。自由視点と同じ）
function trafficFollow(id) {
    const S = _tfById(id);
    traffic.camFollow = S ? S.id : null; traffic.camLast = null;
    if (S) {
        cameraMode = 'free';
        if (typeof toggleWorldMap === 'function') toggleWorldMap(false);
        _tfMsg(`${S.name} をカメラで追っています（視点のボタンでやめます）`);
    } else { cameraMode = 'follow'; window._waterCenter = null; }
    const btn = document.getElementById('camera-mode-toggle');
    if (btn && typeof CAMERA_MODE_LABELS !== 'undefined') btn.innerText = S ? `🎥 追跡: ${S.name}` : CAMERA_MODE_LABELS.follow;
    if (typeof _wmShowInfo === 'function') _wmShowInfo();
}
window.trafficFollow = trafficFollow;
const _tfFolP = new THREE.Vector3();
function _tfFollowTick() {
    if (traffic.camFollow == null) return;
    const S = _tfById(traffic.camFollow);
    // 視点のボタンで別の視点にした・船が居なくなった・遠く（25km より先）へ行った：やめる
    if (cameraMode !== 'free' || !S || !_tfShown(S) || !(S.dPl < TF_NEAR) || S.st === 'gone' || S.st === 'off') {
        if (cameraMode === 'free') _tfMsg('追っていた船が見えなくなったので、追うのをやめました');
        traffic.camFollow = null; traffic.camLast = null; window._waterCenter = null;
        if (cameraMode === 'free') trafficFollow(null);
        return;
    }
    // （モデルを読み込み直している間など、形が無くても、船の位置で追い続ける）
    let p = S.mesh && S.mesh.position;
    if (!p) { const l = _tfLocal(S, {}); if (!Number.isFinite(l.x)) return; p = _tfFolP.set(l.x, traffic.camLast ? traffic.camLast.y : 0, l.z); }
    if (!traffic.camLast) {
        // 初め：船の斜め後ろの上から
        const yaw = _tfYaw(S, { x: p.x, z: p.z }), fx = Math.sin(yaw), fz = Math.cos(yaw);
        controls.target.set(p.x, p.y + S.L * 0.05, p.z);
        camera.position.set(p.x - fx * S.L * 1.1 + fz * S.L * 0.5, p.y + S.L * 0.45, p.z - fz * S.L * 1.1 - fx * S.L * 0.5);
        controls.update();
        traffic.camLast = p.clone();
        return;
    }
    const dx = p.x - traffic.camLast.x, dy = p.y - traffic.camLast.y, dz = p.z - traffic.camLast.z;
    controls.target.x += dx; controls.target.y += dy; controls.target.z += dz;
    camera.position.x += dx; camera.position.y += dy; camera.position.z += dz;
    traffic.camLast.copy(p);
    // 水面の細かい網はカメラの見ている船のまわりに（17-main-loop.js）
    window._waterCenter = { x: p.x, z: p.z };
}
// ── 地図で他の船を置く ──
//  o：{ lat, lon, cls（種類）か saved（保存した船の名前）, name（空なら自動）, route：[埠頭の id…] }
//  航路の埠頭が 1 つならそこへ行き、着いたあとはふつうの船と同じ。2 つ以上ならその順に回り続ける
function trafficPlaceShip(o) {
    if (!traffic.on || !traffic.ready || !window.world || world.mode !== 'world') return null;
    const v = o.saved ? _tfSavedAll().find(x => x.name === o.saved) : null;
    const spec = v ? _tfSavedSpec(v) : { cls: TF_CLASSES[o.cls] ? o.cls : 'steamer' };
    if (o.name) spec.name = o.name;
    const ports = _tfPorts(), route = (o.route || []).map(id => ports.find(p => p.id === id)).filter(Boolean);
    delete spec.route;
    if (route.length >= 2) spec.route = route.map(p => p.name);
    const S = _tfMakeShip(spec);
    S.placed = true; S.noRespawn = true;
    S.lat = o.lat; S.lon = o.lon; S.hdg = Number.isFinite(o.hdg) ? o.hdg : 0; S.v = 0; S.st = 'placed'; S.t = 0;
    S.port = null; S.gate = null; S.dPl = _tfDist(_tfPlayerLL(), S);
    if (S.svc) S.svc.i = -1;
    else if (route.length === 1) S.to = { P: route[0] };
    traffic.ships.push(S);
    _tfMsg(`${S.name}（${_tfClassOf(S).label}）を置きました${route.length ? `：${route.map(p => worldBerthLabel(p)).join(' → ')}` : ''}`);
    return S;
}
window.trafficPlaceShip = trafficPlaceShip;
function _tfPlacedGo(S) {
    if (!S.to) { const x = _tfChooseDest(S); if (!x) { S.t = 10; S.why = '行き先が見つかりません'; return; } S.to = x; S.toB = null; }
    if (S.to.P && !_tfSlotOf(S.to.P, S.id)) { const b = _tfSlotFind(S.to.P, S.L, S.id, S); if (b !== null) { _tfSlotTake(S.to.P, b, S.L, S.id, true); S.toB = b; } }
    // 航行中に行き先を変えた船は、少し先（今の向きのまま進んだ所：replanPt）から道すじを引く
    //（道すじを探す間も進むので、今の所から引くと、探しているうちに所が変わって、いつまでも探し直していた）
    const p0 = S.replanPt || S;
    const a = { lat: p0.lat, lon: p0.lon, key: 'u' + S.id + '@' + p0.lat.toFixed(4) + ',' + p0.lon.toFixed(4) };
    const L = _tfLaneNeed(a, _tfEnd(S.to), true);
    if (L && (L.fail || L.state === 'fail' || (L.ok && L.draft < S.d + 1))) {
        S.why = `${_tfPlaceName(S.to)} へは行けません（海とつながっていない・この船には浅い）`;
        if (S.to.P) { const sl = _tfSlotOf(S.to.P, S.id); if (sl && sl.res) _tfSlotFree(S.to.P, S.id); }
        S.to = null; S.failN = (S.failN || 0) + 1; S.t = 5;
        if (S.svc && S.failN > 3) S.svc = null;
        return;
    }
    if (!L || !L.ok) { S.t = 2; return; }
    const path = _tfComposePath(S, { pt: a }, S.to, L);
    // 先の点から引いたときは、今の所からその点までを道すじの頭に足す
    if (S.replanPt && _tfDist(S, S.replanPt) > 30) { path.pts.unshift({ lat: S.lat, lon: S.lon, ch: false }); if (path.arriveIdx >= 0) path.arriveIdx++; }
    S.replanPt = null;
    _tfKeepRight(S, path.pts);
    S.path = _tfPrepPath(S, _tfSmoothPath(S, path)); S.s = 0; S.k = 0; S.checked = false; S.from = { pt: a }; S.off = 0; S.why = '';
    // （今の所から道すじを引くので、行き足はそのまま。道すじの向きと違えば、_tfMove が止めてから向きを変える）
    const h0 = S.hdg;
    _tfSnapToPath(S); S.st = 'go'; if (S.v > 0.3) S.hdg = h0;
}
// 地図に描く：選んだ船のこの先の道すじ・置こうとしている船の場所と航路
function _tfDrawMapExtras(g, cv) {
    const S = typeof _wm !== 'undefined' ? _tfById(_wm.selShip) : null;
    if (S && _tfShown(S)) {
        const q = _wmToScreen(S.lat, S.lon, cv);
        g.strokeStyle = '#ffe36b'; g.lineWidth = 2; g.beginPath(); g.arc(q.x, q.y, 11, 0, Math.PI * 2); g.stroke();
        if (S.path && S.st === 'go') {
            g.setLineDash([5, 4]); g.lineWidth = 1.5; g.beginPath(); g.moveTo(q.x, q.y);
            for (let k = Math.max(0, (S.k || 0) + 1); k < S.path.pts.length; k++) { const r = _wmToScreen(S.path.pts[k].lat, S.path.pts[k].lon, cv); g.lineTo(r.x, r.y); }
            g.stroke(); g.setLineDash([]);
        }
    }
    const D = typeof _wm !== 'undefined' ? _wm.draft : null;
    if (D) {
        const q = _wmToScreen(D.lat, D.lon, cv);
        g.strokeStyle = '#7dffb0'; g.fillStyle = 'rgba(125,255,176,0.35)'; g.lineWidth = 2;
        g.beginPath(); g.arc(q.x, q.y, 9, 0, Math.PI * 2); g.fill(); g.stroke();
        const ports = _tfPorts();
        g.setLineDash([3, 4]); g.beginPath(); g.moveTo(q.x, q.y);
        for (const id of D.route) { const P = ports.find(p => p.id === id); if (!P) continue; const r = _wmToScreen(P.lat, P.lon, cv); g.lineTo(r.x, r.y); }
        g.stroke(); g.setLineDash([]);
    }
}
// 置く船の入力（世界地図の説明の所に出す）
function trafficDraftHTML() {
    const D = _wm.draft; if (!D) return '';
    const ports = _tfPorts();
    // 保存した船（今乗っている船のモデルも）を先に。モデルの無い保存は選べない（他の船は、その船のモデルで描く）
    const sv = _tfSavedAll();
    const opts = (sv.length ? `<optgroup label="💾 保存した船">` + sv.map(v => `<option value="s:${v.name.replace(/"/g, '&quot;')}" ${D.kind === 's:' + v.name ? 'selected' : ''}>💾 ${v.name.replace(/</g, '&lt;')}${v.own ? '（今乗っている船と同じモデル）' : ''}</option>`).join('') + `</optgroup>` : '')
        + `<optgroup label="船の種類">` + Object.entries(TF_CLASSES).map(([k, c]) => `<option value="c:${k}" ${D.kind === 'c:' + k ? 'selected' : ''}>${c.icon || ''} ${c.label}</option>`).join('') + `</optgroup>`;
    const rt = D.route.map((id, i) => { const P = ports.find(p => p.id === id); return P ? `<div class="wp-berth">${i + 1}. ${worldBerthLabel(P)} <button onclick="trafficDraftRoute('del', ${i})">✕</button></div>` : ''; }).join('');
    return `<div class="wp-pname">🚢 他の船を置く</div>
        <div class="wp-pmeta">${worldFmtLatLon(D.lat, D.lon)}（置く所を変えるときは、海をタップ）</div>
        <div class="wp-side">種類：<select onchange="_wm.draft.kind=this.value">${opts}</select></div>
        <div class="wp-side">船名：<input type="text" placeholder="空なら自動" value="${(D.name || '').replace(/"/g, '&quot;')}" oninput="_wm.draft.name=this.value" style="width:9em"></div>
        <div class="wp-side">追従：<select onchange="_wm.draft.follow=this.value">${_tfDraftFollowOpts(D)}</select>
          <select onchange="_wm.draft.fside=this.value">${[['1', '右舷側'], ['-1', '左舷側'], ['0', '後ろ']].map(([v, l]) => `<option value="${v}" ${(D.fside || '1') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="wp-pmeta">航路：${D.route.length ? '' : '地図で港をタップして「➕ 航路に加える」（加えなければ行き先は自動。2 つ以上なら、その順に回り続けます。追従させるときは航路は使いません）'}</div>
        ${rt ? `<div class="wp-berths">${rt}</div>` : ''}
        <div class="wp-pbtns"><button onclick="trafficDraftGo()">🚢 ここに出す</button><button onclick="_wm.draft=null;_wmShowInfo();worldMapRedraw(true)">やめる</button></div>`;
}
window.trafficDraftHTML = trafficDraftHTML;
function _tfDraftFollowOpts(D) {
    const p = { lat: D.lat, lon: D.lon };
    const near = traffic.ships.filter(O => _tfShown(O) && O.st !== 'damaged' && _tfDist(p, O) < 40000).sort((a, b) => _tfDist(p, a) - _tfDist(p, b)).slice(0, 25);
    return [['', '（追従しない）'], ['player', '自分の船']].concat(near.map(O => [String(O.id), `${O.name}（${(_tfDist(p, O) / 1852).toFixed(1)}海里）`]))
        .map(([v, l]) => `<option value="${v}" ${(D.follow || '') === v ? 'selected' : ''}>${String(l).replace(/</g, '&lt;')}</option>`).join('');
}
function trafficDraftStart(lat, lon) {
    if (!traffic.on) { traffic.on = true; _tfSave(); }
    _wm.draft = { lat, lon, kind: (_wm.draft && _wm.draft.kind) || 'c:steamer', name: '', route: [] };
    _wm.sel = null; _wm.selPt = null; _wm.selShip = null;
    _wmShowInfo(); worldMapRedraw(true);
}
window.trafficDraftStart = trafficDraftStart;
function trafficDraftRoute(op, x) {
    const D = _wm.draft; if (!D) return;
    if (op === 'add' && !D.route.includes(x)) D.route.push(x);
    if (op === 'del') D.route.splice(x, 1);
    _wm.sel = null; _wmShowInfo(); worldMapRedraw(true);
}
window.trafficDraftRoute = trafficDraftRoute;
function trafficDraftGo() {
    const D = _wm.draft; if (!D) return;
    if (!traffic.ready) { const el = document.getElementById('wp-status'); if (el) el.textContent = '他の船の用意ができるまで、少し待ってください'; return; }
    const o = { lat: D.lat, lon: D.lon, name: (D.name || '').trim(), route: D.route.slice() };
    if (D.kind.startsWith('s:')) o.saved = D.kind.slice(2); else o.cls = D.kind.slice(2);
    const S = trafficPlaceShip(o);
    const fol = D.follow, fs = D.fside || '1';
    _wm.draft = null;
    if (S) { _wm.selShip = S.id; if (fol) trafficSetFollow(S.id, fol, fs); }
    _wmShowInfo(); worldMapRedraw(true);
}
window.trafficDraftGo = trafficDraftGo;

// ════════════════════════════════════════════════════════════════
//  設定と、近くの船の一覧（世界地図の「🚢 他の船」）
// ════════════════════════════════════════════════════════════════
const TF_STATE_LABEL = { berth: '着岸中', go: '航行中', unberth: '離岸中', berthing: '着岸作業中', anchoring: '錨地へ', anchored: '錨泊中（埠頭が空くのを待っています）', holding: '待機中', placed: '出発の用意（航路を探しています）', follow: '追従中' };
function trafficSet(k, v) {
    if (k === 'on') traffic.on = !!v;
    else if (k === 'density' && TF_DENSITY[v]) traffic.density = v;
    else if (k === 'era' && TF_ERA[v]) traffic.era = v;
    else if (k === 'horn') traffic.horn = !!v;
    _tfSave(); trafficPanelRender();
}
window.trafficSet = trafficSet;
function trafficPanelToggle(open) {
    const el = document.getElementById('wp-traffic-panel');
    if (!el) return;
    el.hidden = open === undefined ? !el.hidden : !open;
    const b = document.getElementById('wp-traffic'); if (b) b.classList.toggle('on', !el.hidden);
    trafficPanelRender();
}
window.trafficPanelToggle = trafficPanelToggle;
function trafficPanelRender() {
    const el = document.getElementById('wp-traffic-panel');
    if (!el || el.hidden) return;
    const seg = (k, opts, cur) => opts.map(([v, lab]) => `<button class="${cur === v ? 'on' : ''}" onclick="trafficSet('${k}', ${typeof v === 'string' ? `'${v}'` : v})">${lab}</button>`).join('');
    const near = traffic.ships.filter(S => _tfShown(S) && S.dPl < 30000).sort((a, b) => a.dPl - b.dPl).slice(0, 12);
    el.innerHTML = `
        <div class="tf-row"><b>🚢 他の船</b>${seg('on', [[true, '表示'], [false, '出さない']], traffic.on)}</div>
        <div class="tf-row">数 ${seg('density', Object.entries(TF_DENSITY).map(([k, v]) => [k, v.label]), traffic.density)}</div>
        <div class="tf-row">時代 ${seg('era', Object.entries(TF_ERA), traffic.era)}</div>
        ${_tfOwnYears() ? `<div class="tf-row"><small>乗っている船の年（${(window.shipInfo.yearFrom || '')}〜${(window.shipInfo.yearTo || '')}）と重なる船だけを出しています（船体設定の保存のページ）</small></div>` : ''}
        <div class="tf-row">汽笛・霧中信号 ${seg('horn', [[true, '鳴らす'], [false, '鳴らさない']], traffic.horn)}</div>
        ${_tfSavedPanelHTML()}
        <div class="tf-list">${traffic.on ? (near.length ? near.map(S => `<div><span style="color:${TF_MAP_COLOR[S.cls]}">▲</span> <b>${S.name}</b> <small>${S.line ? S.line + '・' : ''}${_tfClassOf(S).label}・${S.L}m</small><br><small>${(S.dPl / 1852).toFixed(1)}海里　${TF_STATE_LABEL[S.st] || ''}${S.v > 0.3 ? `　${(S.v / 0.514444).toFixed(0)}ノット` : ''}${S.to && S.to.P && S.st !== 'berth' ? `　→ ${worldBerthLabel(S.to.P)}` : S.to && S.to.G ? `　→ ${S.to.G.name}` : S.st === 'berth' && S.port ? `　${worldBerthLabel(S.port)}` : ''}${S.why || S.waitWhy ? `<br>　${S.why || S.waitWhy}` : ''}</small></div>`).join('') : '<small>近く（30km 以内）には、ほかの船はいません</small>') : ''}</div>
        <div class="tf-msgs">${traffic.msgs.slice(0, 4).map(m => `<small>・${m.s}</small>`).join('<br>')}</div>`;
}
window.trafficPanelRender = trafficPanelRender;

// ════════════════════════════════════════════════════════════════
//  自分の船の自動航行（49-autopilot.js から）：同じルールで、よける・待つ
// ════════════════════════════════════════════════════════════════
// 行き先の埠頭を押さえる（他の船は、そこに新しく付けない。付いている船は早めに出る）
function _tfPlayerLen() { return (window.hullProfile && hullProfile.ready) ? hullProfile.halfLen * 2 * (physics.scale || 1) : 200; }
// 自分の船が向かう埠頭は、まるごと空ける（他の船を付けない）
function _tfPlayerResRange(P) { return { b0: -1e9, b1: 1e9 }; }
function _tfPlayerReserve(P) {
    const cur = traffic.player.reserve;
    if (cur && cur.P === P) return;
    if (cur) _tfSlotFree(cur.P, 'player-res');
    traffic.player.reserve = null;
    if (!P || P.point || !P.id) return;
    traffic.player.reserve = { P };
    _tfQuayList(P).push(Object.assign({ who: 'player-res', res: true }, _tfPlayerResRange(P)));
    _tfClearBerthFor(P);
}
// 自分の船の行き先の埠頭にいる・向かっている他の船をどかす：
//  見えない所の船はすぐ別の埠頭へ移し、見えている船は今すぐ離岸させる。向かっている途中の船は予約を外す（錨地で待つ・ほかへ）
function _tfClearBerthFor(P) {
    for (const S of traffic.ships) {
        const at = S.port === P && (S.st === 'berth' || S.st === 'berthing' || S.st === 'unberth');
        const going = S.to && S.to.P === P && !at;
        if (going) {
            const sl = _tfSlotOf(P, S.id); if (sl) _tfSlotFree(P, S.id);
            if (S.st === 'anchored' || S.st === 'holding' || !(S.dPl < TF_SHOW)) { S.to = null; if (S.st === 'holding' || S.st === 'anchored') S.st = 'gone'; }
            continue;
        }
        if (!at) continue;
        if (S.dPl < TF_SHOW && S.mesh) { if (S.st === 'berth') S.t = Math.min(S.t, 3); continue; }     // 見えている：すぐ出る
        // まず、そのまま次の航海へ出す（見えない所なので、離岸の動きは省く）
        _tfDropMesh(S);
        _tfTryDepart(S, true);
        if (S.port !== P) continue;
        _tfSlotFree(P, S.id); S.port = null;
        const me = _tfPlayerLL();
        const alt = _tfPorts().filter(q => q !== P && _tfSuits(S.cls, q) && _tfFits(S, q) && _tfSlotFind(q, S.L, S.id, S) !== null)
            .sort((a, b) => _tfDist(P, a) - _tfDist(P, b))[0];
        _tfDropMesh(S);
        if (!S.svc && alt && _tfDist(alt, me) > TF_SHOW && _tfPlaceBerthed(S, alt, Math.random())) continue;
        // 航路がまだ無い：出港したことにして、航路が見つかったらその途中に置く
        S.port = P; S.st = 'pending'; S.seedMid = 0.05; S.t = 0; S.tries = -360;     // （航路が見つかるまで、30 分ほど待てる）
    }
}
// その埠頭に着いている（着けている・離れている途中の）他の船（「ここから出航」の確かめ：43-world.js）
function trafficBerthShips(P) {
    if (!traffic.on || !P) return [];
    return traffic.ships.filter(S => S.port === P && (S.st === 'berth' || S.st === 'berthing' || S.st === 'unberth'));
}
window.trafficBerthShips = trafficBerthShips;
// 自分の船をその埠頭に置くので、着いている他の船を、近くの空いている別の埠頭へ移す（無ければいなくなる）。
// その埠頭へ向かっている船の予約も外す（着いたときにふさがっていれば、錨地で待つ）
function trafficEvictBerth(P) {
    if (!P) return;
    for (const S of traffic.ships) {
        if (S.to && S.to.P === P && S.port !== P) { const sl = _tfSlotOf(P, S.id); if (sl) _tfSlotFree(P, S.id); }
        if (!(S.port === P && (S.st === 'berth' || S.st === 'berthing' || S.st === 'unberth'))) continue;
        _tfDropMesh(S);
        _tfSlotFree(P, S.id); if (S.mPort) { _tfSlotFree(S.mPort, S.id); S.mPort = null; }
        S.port = null; S.steps = null; S.turning = false; S.follow = null; S.followReq = false;
        const alt = _tfPorts().filter(q => q !== P && _tfSuits(S.cls, q) && _tfFits(S, q) && _tfSlotFind(q, S.L, S.id, S) !== null)
            .sort((a, b) => _tfDist(P, a) - _tfDist(P, b))[0];
        if (alt && _tfPlaceBerthed(S, alt, Math.random())) { _tfMsg(`${S.name} を ${worldBerthLabel ? worldBerthLabel(alt) : alt.name} へ移しました`); continue; }
        S.st = 'gone'; S.noRespawn = !!S.placed;
        _tfMsg(`${S.name} は、空いている埠頭が無いので、いなくなりました`);
    }
}
window.trafficEvictBerth = trafficEvictBerth;
// その埠頭（自分の船が付く所）にいる・付こうとしている他の船
function _tfBerthBlocker(P) {
    const R = _tfPlayerResRange(P);
    for (const S of traffic.ships) {
        const here = (S.port === P && (S.st === 'berth' || S.st === 'unberth' || S.st === 'berthing')) || (S.to && S.to.P === P && (S.st === 'berthing'));
        if (!here) continue;
        const sl = _tfSlotOf(P, S.id);
        if (!sl || (sl.b1 > R.b0 && sl.b0 < R.b1)) return S;
    }
    return null;
}
// 自分の船が、針路 crs へ向かったとき、この先（止まれる距離＋余裕）が深いか（船の幅の帯）
function _tfPlayerCourseOK(me, crs) {
    const need = ((typeof worldShipDraft === 'function') ? worldShipDraft() : 8) + 1.5;
    const D = Math.min(4000, Math.max(3 * me.L, me.v * 150 + me.L));
    for (let x = me.L / 2; x <= D; x += 25) {
        const u = Math.min(1, x / (2 * me.L)), h = me.hdg + _tfWrap(crs - me.hdg) * u;
        const c = _tfOff(me, h, x);
        if (!_tfBandOK(me, c, h, need)) return false;
    }
    return true;
}
// 自分の船の前をふさぐ船：船首から、今の向きから針路 crs へ向かう帯に、ほかの船（離着岸中の船は動く先・回す所も）がかかる所
function _tfPlayerScan(me, crs) {
    const v = me.v, dStop = Math.max(1.5 * me.L, v * 90);
    const D = Math.min(5000, dStop * 2 + me.L);
    const half = me.B / 2 + 8 + 0.03 * me.L;
    const pts = [];
    let e = 0, n = 0, h = me.hdg;
    const step = Math.max(10, me.B * 0.6);
    // 船首まで
    e = Math.sin(h * _tfR) * me.L / 2; n = Math.cos(h * _tfR) * me.L / 2;
    for (let x = 0; x <= D; x += step) {
        const u = Math.min(1, x / (2 * me.L)); h = me.hdg + _tfWrap(crs - me.hdg) * u;
        e += Math.sin(h * _tfR) * step; n += Math.cos(h * _tfR) * step;
        pts.push({ e, n, sig: x, te: Math.sin(h * _tfR), tn: Math.cos(h * _tfR) });
    }
    let best = null;
    for (const O of traffic.ships) {
        if (!_tfShown(O) || !(O.dPl < D + me.L + _tfReach(O))) continue;
        // 離着岸の途中で、こちら（自分の船）が出ていくのを待っている船：その船の動く先では止まらない（止まると、
        // 互いに待ち合って動けなくなる）。船体だけをよける
        const waitsMe = (O.st === 'berthing' || O.st === 'unberth') && O.pausedBy === 'あなたの船';
        const shapes = waitsMe ? [_tfCapOf(me, O, O.hdg, O.L, O.B + 6)] : _tfObsShapes(me, O);
        // 岸壁に付いている船（動かない）は、船体に触れない幅だけ見る（広く見ると、となりの埠頭へ寄るときに、いつまでも待つ）
        const hw = O.st === 'berth' ? me.B / 2 + 4 : half;
        let hit = null;
        for (const p of pts) { for (const sh of shapes) if (_tfSegDist(p.e, p.n, sh) < hw) { hit = p; break; } if (hit) break; }
        if (!hit) continue;
        let vA = 0;
        if ((O.v || 0) > 0.3 && (O.st === 'go' || O.st === 'anchoring')) { const hh = O.hdg * _tfR; vA = (Math.sin(hh) * hit.te + Math.cos(hh) * hit.tn) * O.v; }
        if (vA < -0.3 && hit.sig > Math.max(3 * me.L, 700)) continue;           // 遠くの向かってくる船は、行き会いのルールで
        if (vA > 0.3 && v < vA + 0.3 && hit.sig > 2 * me.L) continue;           // 同じ向きに離れていく船
        if ((O.v || 0) > 0.5 && vA <= 0.3 && vA >= -0.3 && hit.sig > dStop + 400) continue;   // 遠くを横切る船
        if (!best || hit.sig < best.gap) best = { gap: hit.sig, O, vA };
    }
    if (!best) return null;
    const nm = best.O.name, by = best.O.id;
    if (best.gap < dStop * 0.6 && v > 0.4) return { order: -1, by, why: `${nm} が前をふさいでいるので、後進をかけています` };
    if (best.gap < dStop * 1.3) return { order: 0, by, why: `${nm} が前をふさいでいるので、機関を止めて待っています` };
    if (best.gap < dStop * 2.5) return { order: 1, by, why: `${nm} が前にいるので、微速にしています` };
    return null;
}
function trafficAdvice(ctx) {
    if (!traffic.on || !traffic.ready || !window.world || world.mode !== 'world') return null;
    const me = _tfPlayerAsShipSafe();
    if (!me) return null;
    _tfPlayerReserve(ctx && ctx.dest && !ctx.dest.point ? ctx.dest : null);
    let order = 9, dc = 0, why = '';
    const inCh = !!(ctx && (ctx.channel || ctx.narrow));
    const L = me.L, safe = Math.max(inCh ? 150 : 900, 2.5 * L);
    for (const O of traffic.ships) {
        if (!(O.dPl < 12000) || !_tfShown(O) || O.st === 'berth') continue;
        if (ctx && ctx.skip === O.id) continue;             // 追いかけている船（49-autopilot.js の並走）
        const c = _tfCPA(me, O);
        const rb = _tfWrap(_tfBrg(me, O) - me.hdg), rbFromO = _tfWrap(_tfBrg(O, me) - O.hdg);
        const sameDir = Math.abs(_tfWrap(O.hdg - me.hdg)) < 45;
        // よけ始めた相手は、すれ違い・追い越しが終わるまでよけ続ける
        const PA = traffic.player.avoid = traffic.player.avoid || {}, lat = PA[O.id];
        if (lat) {
            if ((c.t <= 0 && c.dist > (L + O.L) / 2 + 100) || c.dist > 8000) delete PA[O.id];
            else {
                if (lat.dc > 0) dc = Math.max(dc, lat.dc); else dc = Math.min(dc, lat.dc); why = why || lat.why;
                if (lat.kind && c.dist < 3000) _tfPlayerSignal(O, lat.kind);      // 遠くからよけ始めた相手にも、近くなったら合図
                continue;
            }
        }
        // 前の船（同じ向き）：追い越す
        if (sameDir && Math.abs(rb) < 25 && c.dist < Math.max(6 * L, 1500)) {
            const gap = c.dist - (L + O.L) / 2, want = Math.max(2 * L, inCh ? 3 * L : 600);
            if (gap < want * 2 && (O.v || 0) < me.v - 0.3) {
                // 追い越す：減速はせず、相手の左舷側を通る（港の航路の中は、相手が右へ寄ってあけてくれる）
                if (!inCh) { dc = Math.min(dc, -20); PA[O.id] = { dc: -20, why: `${O.name} を追い越しています`, kind: 'over' }; }
                why = why || `${O.name} を追い越しています`;
                if (c.dist < 3000) _tfPlayerSignal(O, 'over');
            }
            // （ぶつかりそうなほど近いときだけ止める）
            if (gap < Math.max(60, L * 0.5)) { order = Math.min(order, 0); why = `前の ${O.name} に近すぎるので、機関を止めています`; }
            continue;
        }
        if (!(c.t > 0 && c.t < 1500 && c.cpa < safe)) continue;
        if ((O.v || 0) < 0.3) { if (!inCh) { dc = Math.max(dc, 20); why = why || `${O.name}（止まっている船）を右によけています`; } continue; }
        const headOn = Math.abs(rb) < 12 && Math.abs(rbFromO) < 12;
        const overtaking = Math.abs(rbFromO) > 112.5 && sameDir;
        const giveWay = headOn || overtaking || (!sameDir && rb > 0 && rb < 112.5);
        if (giveWay) {
            if (!inCh) {
                if (overtaking) dc = Math.min(dc, -25); else dc = Math.max(dc, headOn ? 25 : 35);
                PA[O.id] = { kind: overtaking ? 'over' : headOn ? 'meet' : null, dc: overtaking ? -25 : headOn ? 25 : 35, why: headOn ? `${O.name} と行き会うので右へよけています` : overtaking ? `${O.name} を追い越しています` : `${O.name} を右に見るので、よけています（避航船）` };
            }
            // 行き会い・追い越しでは減速しない。横切りの避航船だけ、近ければ落とす
            if (!headOn && !overtaking && c.t < 600) order = Math.min(order, inCh ? 1 : 2);
            if (!headOn && !overtaking && inCh && c.cpa < Math.max(L, 150) && c.t < 300) order = Math.min(order, 0);
            if (c.dist < 3000) { if (headOn) _tfPlayerSignal(O, 'meet'); else if (overtaking) _tfPlayerSignal(O, 'over'); }
            why = why || (headOn ? `${O.name} と行き会うので右へよけています` : overtaking ? `${O.name} を追い越すので、よけています` : `${O.name} を右に見るので、よけています（避航船）`);
        } else if (!sameDir && c.cpa < Math.max(L, 200) && c.t < 240) {
            order = Math.min(order, 0); if (!inCh) dc = Math.max(dc, 20);
            why = why || `${O.name} が近いので、減速して右へよけています`;
        }
    }
    // よける向きに浅い所・陸があれば、よけ方を小さく（無理なら、よけずに速力を落とす：前をふさがれれば下で止まる）
    if (dc && ctx && Number.isFinite(ctx.course)) {
        let ok = 0;
        for (const f of [1, 0.6, 0.3]) if (_tfPlayerCourseOK(me, ctx.course + dc * f)) { ok = dc * f; break; }
        if (ok !== dc) { if (!ok) { order = Math.min(order, 1); why = why ? why + '（浅いので、よけずに減速）' : why; } dc = ok; }
    }
    // 前をふさぐ船（近い船から：針路の先の帯に、ほかの船の船体・離着岸の場所がかかる）：止まれる距離の中なら、機関を止める・後進
    traffic.player.blockedBy = null;
    if (ctx && Number.isFinite(ctx.course)) {
        const sc = _tfPlayerScan(me, ctx.course + dc);
        if (sc) {
            if (sc.order < order) order = sc.order;
            why = sc.why;
            if (sc.order <= 0) { traffic.player.blockedBy = sc.by; traffic.player.blockedT = traffic.t; }
        }
    }
    // 埠頭がふさがっている：港の近くで待つ
    if (ctx && ctx.dest && !ctx.dest.point && ctx.remain < 4000) {
        const B = _tfBerthBlocker(ctx.dest);
        if (B) { order = Math.min(order, 0); why = `${B.name} が ${worldBerthLabel(ctx.dest)} にいるので、空くまで待っています`; }
    }
    // 霧：安全な速力（半速まで）・霧中信号は自分で鳴らす
    if (_tfVisM() < 2000) { order = Math.min(order, 2); why = why || '霧なので、速力を落としています'; }
    if (order === 9 && !dc && !why) return { why: '' };
    return { order: order === 9 ? undefined : order, dc, why };
}
function _tfPlayerAsShipSafe() { try { return _tfPlayerAsShip(); } catch (e) { return null; } }
window.trafficAdvice = trafficAdvice;

// ════════════════════════════════════════════════════════════════
//  保存した船（船体設定で保存した船：13-save-load-config.js・モデルは 27-model-store.js）を、他の船として出す
// ════════════════════════════════════════════════════════════════
//  ・保存した船（自分が今乗っている船のモデルは除く）を、他の船の中心に：自分の船の近くの港に置き、近くの港を多めに回る
//  ・モデルは近くで見えるときだけ読み込み（同じモデルは 1 つを使い回す）、しばらく見えなければ捨てる
//  ・引き波は出さない。煙突（保存した煙突の位置）からの排煙と、航海灯（保存した灯の位置）は出す
//  ・重い船は「🚢 他の船」の一覧で、船ごとに出さないようにできる
const TF_SAVED_OFF_KEY = 'susuru_traffic_saved_off';
traffic.savedOn = true; traffic.savedOff = new Set();
try {
    const o = JSON.parse(localStorage.getItem(TF_SAVED_OFF_KEY) || 'null');
    if (o) { traffic.savedOn = o.on !== false; traffic.savedOff = new Set(o.off || []); }
} catch (e) { /* ignore */ }
function _tfSavedSave() { try { localStorage.setItem(TF_SAVED_OFF_KEY, JSON.stringify({ on: traffic.savedOn, off: [...traffic.savedOff] })); } catch (e) { /* ignore */ } }
const TF_SAVED_CLASS = { liner: 'liner', cruise: 'cruise', ferry: 'ferry', cargo: 'steamer', container: 'container', tanker: 'tanker',
    destroyer: 'destroyer', cruiser: 'cruiser', battleship: 'dreadnought', carrier: 'carrier' };
// 保存した船の一覧（モデルのあるもの）。own：今乗っている船のモデル
function _tfSavedAll() {
    if (typeof loadAllShipSaves !== 'function') return [];
    const all = loadAllShipSaves(), cur = (typeof getCurrentModelRef === 'function') ? getCurrentModelRef() : null;
    const out = [];
    for (const [name, cfg] of Object.entries(all)) {
        const ref = cfg && cfg.modelRef;
        if (!ref || !(ref.id || ref.embedded)) continue;
        const own = !!(cur && ((cur.id && cur.id === ref.id) || (cur.embedded && ref.embedded && cur.name === ref.name)));
        out.push({ name, cfg, ref, own, key: ref.id || ('emb:' + ref.name) });
    }
    return out;
}
function _tfSavedUsed() { return traffic.savedOn ? _tfSavedAll().filter(v => !v.own && !traffic.savedOff.has(v.name) && _tfYearsOk(_tfSavedYears(v))) : []; }
//（会社・年が変わったら、他の船を出し直す）
function _tfSavedSig() {
    const I = window.shipInfo || {};
    return _tfSavedUsed().map(v => v.name + ':' + v.key + ':' + ((v.cfg.info && v.cfg.info.company) || '')).join(',') + '|' + (traffic.savedOn ? 1 : 0) + '|' + (I.yearFrom || '') + '-' + (I.yearTo || '');
}
// 保存した船 → 他の船の作り（長さはモデルの大きさから：モデルは長い辺が 12 になるよう直し、mscale と scale÷12 を掛けてある）
function _tfSavedSpec(v) {
    const ph = v.cfg.physics || {}, m = v.cfg.model || {};
    const type = (v.cfg.submarine && v.cfg.submarine.type) || 'other';
    const L = Math.max(15, Math.round((+m.mscale || 1) * (+ph.scale || 12)));     // （scale は船の長さ[m]：倍率はその 1/12）
    let cls = TF_SAVED_CLASS[type];
    if (!cls) cls = L > 150 ? 'liner' : L > 60 ? 'steamer' : 'fishing';
    const C = TF_CLASSES[cls];
    const d = Math.max(2, Math.min(12, (+ph.draftOverride > 0 ? +ph.draftOverride : C.d[0] + (C.d[1] - C.d[0]) * Math.min(1, Math.max(0, (L - C.L[0]) / Math.max(1, C.L[1] - C.L[0]))))));
    const kn = Math.max(6, Math.min(32, +ph.maxSpeed > 0 ? +ph.maxSpeed : (C.kn[0] + C.kn[1]) / 2));
    const spec = { cls, name: v.name, line: '保存した船', L, B: Math.round(L / C.LB * 10) / 10, d: Math.round(d * 10) / 10, kn: Math.round(kn), saved: v };
    // 会社：決まった航路の船に同じ会社の船があれば、その会社の船として、その航路（会社の埠頭）を回る
    //（同じ種類の船（客船・沿岸の客船・軍艦）の航路から。大きさの近い船の航路を選ぶ）
    const co = v.cfg.info && v.cfg.info.company ? _tfCanonLine(v.cfg.info.company) : '';
    if (co) {
        spec.line = co;
        const rk = world.kind === 'real' ? world.realKey : null;
        const same = (rk && TF_SERVICES[rk] || []).filter(sv => sv.line === co);
        const near = same.filter(sv => sv.cls === cls).concat(same.filter(sv => sv.cls !== cls));
        if (near.length) { near.sort((a, b) => (a.cls !== cls) - (b.cls !== cls) || Math.abs(a.L - L) - Math.abs(b.L - L)); spec.route = near[0].route.slice(); }
    }
    return spec;
}
// 保存した船の就航〜引退の年
function _tfSavedYears(v) { const I = v.cfg && v.cfg.info; return I && (I.yearFrom || I.yearTo) ? [I.yearFrom || null, I.yearTo || null] : null; }
// モデルの読み込み（同じモデルは 1 つ）
const _tfProto = new Map();
let _tfProtoBusy = false;
async function _tfLoadProto(v) {
    let P = _tfProto.get(v.key);
    if (P) return P;
    P = { state: 'loading', users: 0, idleT: 0 }; _tfProto.set(v.key, P);
    _tfProtoBusy = true;
    try {
        let buf;
        if (v.ref.embedded) buf = await (await fetch(v.ref.name)).arrayBuffer();
        else buf = await modelRecordBuffer(await modelStoreGet(v.ref.id));
        if (!buf) throw new Error('no model data');
        const type = v.ref.type || 'glb';
        let root;
        if (type === 'obj') root = new THREE.OBJLoader().parse(new TextDecoder('utf-8').decode(buf));
        else {
            // テクスチャは小さく（スマホ 512px・パソコン 1024px）：自分の船とは別に、まるごと GPU に載るので
            //（自分の船と同じ 2048px で読むと、保存した船が出るたびに数百 MB ずつ増え、iPad などで画面が落ちていた）
            const L = new THREE.GLTFLoader(new THREE.LoadingManager());
            L.__texCapMax = (typeof _texIsMobile === 'function' && _texIsMobile()) ? 512 : 1024; L.__texQuiet = true;
            const gltf = await new Promise((res, rej) => L.parse(buf, '', res, rej));
            // Blender の発光の強さ（窓の明かり）を、自分の船と同じように読む（08-model-loading-and-lighting.js）
            if (typeof applyGltfEmissiveStrengthExt === 'function') applyGltfEmissiveStrengthExt(gltf.scene, gltf.parser && gltf.parser.json);
            root = gltf.scene;
        }
        buf = null;
        // 光源は外す（重い）。影は落とす（窓の発光面は落とさない）。
        // 窓・キャビンの発光（自分の船の registerWindowGlowMaterial と同じ見分け方）は、昼は消して夜だけ点ける
        const lights = [], glow = new Map(), twinCache = new Map();
        const isGlow = (m) => {
            if (!m || !m.emissive) return false;
            const c = m.emissive;
            if (c.r < 0.02 && c.g < 0.02 && c.b < 0.02) return false;
            if ((c.r > 0.6 && c.g < 0.3 && c.b < 0.3) || (c.g > 0.6 && c.r < 0.3 && c.b < 0.3)) return false;   // 航行灯のレンズ
            return true;
        };
        root.traverse(o => {
            if (o.isLight) lights.push(o);
            if (!o.isMesh) return;
            const ms = Array.isArray(o.material) ? o.material : [o.material];
            let win = false;
            for (const m of ms) {
                if (!m) continue;
                m.side = THREE.DoubleSide;
                if (isGlow(m)) { win = true; if (!glow.has(m)) glow.set(m, m.emissiveIntensity != null ? m.emissiveIntensity : 1); }
                // 晴れた昼の影のくっきりさ（間接光を弱める）を、自分の船と同じに（61-ship-ao.js）
                if (typeof _aoPatchMaterial === 'function') _aoPatchMaterial(m);
            }
            // 背中合わせに重なった面は表だけ描く（まだらに見えないように：08-model-loading-and-lighting.js）
            if (typeof splitTwinFaces === 'function' && splitTwinFaces(o, twinCache)) {
                for (const m of [].concat(o.material)) if (m && isGlow(m) && !glow.has(m)) { win = true; glow.set(m, m.emissiveIntensity != null ? m.emissiveIntensity : 1); }
            }
            o.castShadow = !win; o.receiveShadow = true; o.userData.noLightBake = true; o.userData.noBloom = !win;
        });
        for (const o of lights) if (o.parent) o.parent.remove(o);
        // 船体設定の置き方（08-model-loading-and-lighting.js の setCustomModel・updateModelOffset と同じ）
        const m = v.cfg.model || {}, ph = v.cfg.physics || {};
        const b0 = new THREE.Box3().setFromObject(root), sz = new THREE.Vector3(); b0.getSize(sz);
        const orig = Math.max(sz.x, sz.y, sz.z), auto = orig > 0 ? 12 / orig : 1;
        root.position.set(+m.offx || 0, +m.offy || 0, +m.offz || 0);
        root.rotation.y = (Number.isFinite(+m.roty) ? +m.roty : -90) * Math.PI / 180;
        root.scale.setScalar(auto * (+m.mscale || 1));
        const inner = new THREE.Group(); inner.add(root); inner.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(inner);
        const S = (+ph.scale || 12) / 12;                 // （09-ui-setup-and-import.js：physics.scale ＝ 長さ ÷ 12）
        const wl = (Number.isFinite(+ph.waterlineOffsetY) ? +ph.waterlineOffsetY : -0.5) + (+ph.draftOffset || 0) / S;
        // 煙突（煙の出る所）と航海灯の位置（船の中の座標）
        const funnels = [];
        const fl = (v.cfg.funnels && v.cfg.funnels.list) || [], sym = v.cfg.funnels && v.cfg.funnels.symmetry;
        // 煙の出る所は煙突の口（12-bloom-and-deck-lighting-fx.js と同じ：y ＋ ry）
        for (const f of fl) { const y = (+f.y || 0) + (+f.ry || 1.2); funnels.push(new THREE.Vector3(+f.x || 0, y, +f.z || 0)); if (sym && Math.abs(+f.x) > 0.05) funnels.push(new THREE.Vector3(-f.x, y, +f.z || 0)); }
        const nl = v.cfg.navlights || {}, n = (k, d) => Number.isFinite(+nl[k]) ? +nl[k] : d;
        const len = box.max.z - box.min.z, top = box.max.y;
        const lamps = {
            side: [n('sideX', (box.max.x - box.min.x) / 2), n('sideY', top * 0.6), n('sideZ', box.min.z + len * 0.6)],
            fore: [n('mastForeX', 0), n('mastForeY', top), n('mastForeZ', box.min.z + len * 0.75)],
            aft: [n('mastAftX', 0), n('mastAftY', top), n('mastAftZ', box.min.z + len * 0.35)],
            stern: [n('sternX', 0), n('sternY', wl + 0.2 * (top - wl)), n('sternZ', box.min.z)],
        };
        // 部品を材質ごとに 1 つの形へまとめる（描く回数が、部品の数から材質の数に減る：本描画・光のにじみ・影・海面の反射のそれぞれで）
        _tfMergeProto(inner);
        // 空の見え方（プロムナードの奥などを暗く）を、自分の船と同じ方法で少しずつ焼き込む（60・61）
        if (typeof _ssBuild === 'function' && typeof _aoField === 'function' && typeof _aoMeshes === 'function') P.aoJob = _tfProtoAO(inner, (+ph.scale || 12) / 12);
        Object.assign(P, { state: 'ok', glow: [...glow], obj: inner, S, wl, cx: (box.min.x + box.max.x) / 2, cz: (box.min.z + box.max.z) / 2, len, wid: box.max.x - box.min.x, keel: box.min.y, funnels, lamps, bytes: _tfProtoBytes(inner) });
        traffic.protoBytes = traffic.protoBytes || new Map(); traffic.protoBytes.set(v.key, P.bytes);
    } catch (e) {
        console.warn('保存した船のモデルを読めませんでした：' + v.name, e);
        P.state = 'fail';
    }
    _tfProtoBusy = false;
    return P;
}
function _tfProtoDispose(key) {
    const P = _tfProto.get(key);
    _tfProto.delete(key);
    if (!P || !P.obj) return;
    P.obj.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
        for (const mt of ms) { for (const k in mt) { const t = mt[k]; if (t && t.isTexture) { t.dispose(); if (t.image && t.image.close) { try { t.image.close(); } catch (e) { /* ignore */ } } } } mt.dispose(); }
    });
}
// メモリが足りない（描画が捨てられた：33-performance.js）：保存した船のモデルを全部外し、sec 秒のあいだは使わない
function trafficFreeMemory(sec) {
    //（以前は 10 分、保存した船を 1 隻も出さなかった。2 分待ってから、予算を半分にして（30 分）また出す）
    traffic.savedHoldUntil = performance.now() + Math.min(120, sec || 120) * 1000;
    traffic.memLowUntil = performance.now() + 1800 * 1000;
    for (const S of traffic.ships) if (S.mesh && S.mesh.userData.saved) _tfDropMesh(S);
    for (const [key, P] of [..._tfProto]) if (P.state !== 'loading') _tfProtoDispose(key);
}
window.trafficFreeMemory = trafficFreeMemory;
// 保存した船の形（読み込んだモデルを写す。形・材質は共有）
function _tfBuildSavedMesh(S, P) {
    const g = new THREE.Group(), wrap = new THREE.Group();
    wrap.add(P.obj.clone(true));
    wrap.position.set(-P.cx, -P.wl, -P.cz);          // 船の真ん中・喫水線が、置く点に来るように
    g.add(wrap);
    g.scale.setScalar(P.S);
    const Lt = [];
    const lamp = (hex, p, dir, half, key) => {
        const c = new THREE.Color(hex);
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: _tugGlowTex(), color: c, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, sizeAttenuation: false, toneMapped: false }));
        sp.position.set(p[0], p[1], p[2]); sp.renderOrder = 6; sp.userData.noBloom = true; wrap.add(sp);
        Lt.push({ sp, dir, half, key, k: 1 / P.S });
    };
    const A = P.lamps;
    lamp(0xfff4e0, A.fore, [0, 0, 1], 112.5, 'mast');
    if (S.L > 50) lamp(0xfff4e0, A.aft, [0, 0, 1], 112.5, 'mast');
    lamp(0xff2a1a, [Math.abs(A.side[0]), A.side[1], A.side[2]], [0.83, 0, 0.56], 56.75, 'side');
    lamp(0x1aff6a, [-Math.abs(A.side[0]), A.side[1], A.side[2]], [-0.83, 0, 0.56], 56.75, 'side');
    lamp(0xfff4e0, A.stern, [0, 0, -1], 67.5, 'stern');
    lamp(0xfff4e0, [0, A.fore[1] * 0.7 + P.wl * 0.3, P.cz + P.len * 0.45], [0, 0, 1], 180, 'anchor');
    lamp(0xfff4e0, [0, A.stern[1], P.cz - P.len * 0.45], [0, 0, -1], 180, 'anchor');
    g.userData.lights = Lt;
    g.userData.funnels = P.funnels.map(f => f.clone());
    g.userData.funnelParent = wrap;
    g.userData.saved = S.saved.key;
    g.name = 'Traffic:' + S.name;
    P.users++;
    return g;
}
// 見えなくなった保存した船のモデルは、1 分たったら捨てる（メモリ）
// 同時に読み込んでおく保存した船のモデルの数（メモリ：スマホは 2 つ、パソコンは 4 つ）。いっぱいなら、使っていないものを捨てて空ける
// 保存した船のモデルは、数ではなく GPU に載る大きさ（形の頂点・テクスチャ）の合計で決める。
// 以前は 4 つ（スマホ 2 つ）までで、保存した船が多いと、すぐ近くにいる船でも 5 つ目からは描かれなかった。
// 端末のメモリ（navigator.deviceMemory）に合わせ、パソコン 400〜900MB・スマホ 160〜260MB。
// メモリが足りなくなって描画が捨てられたあとは、しばらく半分に
function _tfProtoBudget() {
    const mob = typeof _texIsMobile === 'function' && _texIsMobile(), dm = navigator.deviceMemory || (mob ? 3 : 8);
    let b = mob ? Math.min(260, Math.max(160, dm * 60)) : Math.min(900, Math.max(400, dm * 110));
    if (traffic.memLowUntil && performance.now() < traffic.memLowUntil) b *= 0.5;
    return b * 1048576;
}
// モデルの大きさ[バイト]（頂点の配列＋テクスチャ。ミップマップの分 1.33 倍）
function _tfProtoBytes(obj) {
    let n = 0; const seenG = new Set(), seenT = new Set();
    obj.traverse(o => {
        if (o.geometry && !seenG.has(o.geometry)) { seenG.add(o.geometry); const g = o.geometry; for (const k in g.attributes) n += g.attributes[k].array.byteLength; if (g.index) n += g.index.array.byteLength; }
        const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
        for (const m of ms) for (const k in m) { const t = m[k]; if (t && t.isTexture && !seenT.has(t)) { seenT.add(t); const im = t.image; if (im && im.width) n += im.width * im.height * 4 * 1.33; } }
    });
    return n;
}
const TF_PROTO_GUESS = 60 * 1048576;           // まだ読んでいないモデルの見込み
function _tfProtoMax() { return (typeof _texIsMobile === 'function' && _texIsMobile()) ? 6 : 16; }
function _tfProtoRoom() {
    if (traffic.savedHoldUntil && performance.now() < traffic.savedHoldUntil) return false;
    let used = 0;
    for (const P of _tfProto.values()) used += P.bytes || TF_PROTO_GUESS;
    if (_tfProto.size < _tfProtoMax() && used + TF_PROTO_GUESS <= _tfProtoBudget()) return true;
    for (const [key, P] of _tfProto) if (P.users === 0 && P.state !== 'loading') { _tfProtoDispose(key); return true; }
    return false;
}
function _tfProtoTick(dt) {
    for (const [key, P] of [..._tfProto]) {
        if (P.state === 'loading') continue;
        if (P.users > 0) { P.idleT = 0; continue; }
        P.idleT += dt;
        if (P.idleT > 180 || P.state === 'fail' && P.idleT > 600) _tfProtoDispose(key);
    }
}
function trafficSavedSet(name, on) {
    if (name === '*') traffic.savedOn = !!on;
    else if (on) traffic.savedOff.delete(name); else traffic.savedOff.add(name);
    _tfSavedSave(); traffic.sig = undefined; trafficPanelRender();
}
window.trafficSavedSet = trafficSavedSet;

function _tfSavedPanelHTML() {
    const all = _tfSavedAll();
    if (!all.length) return '<div class="tf-row"><small>保存した船（船体設定で保存した船）があれば、その船も他の船として出ます</small></div>';
    const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/'/g, '&#39;');
    const sz = (v) => (typeof formatModelSize === 'function' && v.ref.size) ? formatModelSize(v.ref.size) : '';
    return `<div class="tf-row"><b>保存した船</b><button class="${traffic.savedOn ? 'on' : ''}" onclick="trafficSavedSet('*', true)">出す</button><button class="${traffic.savedOn ? '' : 'on'}" onclick="trafficSavedSet('*', false)">出さない</button></div>
        ${traffic.savedOn ? `<div class="tf-saved">${all.map(v => `<label><input type="checkbox" ${v.own ? 'disabled' : traffic.savedOff.has(v.name) ? '' : 'checked'} onchange="trafficSavedSet(this.dataset.n, this.checked)" data-n="${esc(v.name)}"> ${esc(v.name)} <small>${sz(v)}${v.own ? '（今乗っている船）' : ''}</small></label>`).join('')}</div>
        <div class="tf-row"><small>重い船は、チェックを外すと出しません（変えると、他の船を並べ直します）</small></div>` : ''}`;
}

// ════════════════════════════════════════════════════════════════
//  外洋で行き会う船（港の間の船は、外洋ではめったに近くを通らないので）
// ════════════════════════════════════════════════════════════════
//  自分の船が港から離れた海の上（いちばん近い港の海の出入口から 30km より遠く）にいて、近く（25km 以内）を走る船が
//  少ないとき、ときどき（数ののぞみに合わせて）近くを通る船を出す：
//   ・港の間の航路（探した道すじ）が近く（40km 以内）を通っていれば、その上を、自分の船の方へ向かって
//   ・無ければ、自分の船の近く（1〜5km 横）を通るまっすぐの航路（同じ向き・反対向き・横切り）で
//  通り過ぎて遠く（30km）まで行ったら消える
const TF_ENC = { few: { n: 1, every: 1500 }, normal: { n: 2, every: 900 }, many: { n: 3, every: 500 } };
function _tfEncounterTick(dt) {
    if (!traffic.ready) return;
    const me = _tfPlayerLL();
    traffic.encT = (traffic.encT || 0) - dt;
    // 通り過ぎた・遠くなった船は消す
    for (const S of traffic.ships) if (S.transient && S.st === 'go' && (S.dPl > 32000 && S.passed || S.dPl > 60000)) S.st = 'gone';
    for (const S of traffic.ships) if (S.transient && S.dPl < 8000) S.passed = true;
    if (traffic.encT > 0) return;
    const E = TF_ENC[traffic.density] || TF_ENC.normal;
    traffic.encT = 60;                                   // 出せないときは 1 分後にもう一度
    // 港の近くでは出さない（港の間の船がいる）
    let nearPort = Infinity;
    for (const P of _tfPorts()) { const d = _tfDist(me, _tfSeaEnd(P)); if (d < nearPort) nearPort = d; }
    if (nearPort < 30000) return;
    const around = traffic.ships.filter(S => _tfShown(S) && S.dPl < 25000).length;
    if (around >= E.n || traffic.ships.filter(S => S.transient).length >= E.n + 1) return;
    if (_tfSpawnEncounter(me)) traffic.encT = E.every * (0.5 + Math.random());
}
function _tfSpawnEncounter(me) {
    // 外洋を行く船の種類（時代に合うもの）
    const cls = _tfPick(['liner', 'steamer', 'steamer', 'container', 'tanker', 'bulk', 'cruise', 'cruiser'].filter(c => _tfEraOk(c)));
    if (!cls) return false;
    const S = _tfMakeShip({ cls });
    const hdgMe = typeof worldTrueCompass === 'function' ? worldTrueCompass() : 0;
    let pts = null, s0 = 0;
    // 1. 近くを通る港の間の航路
    const cands = [];
    for (const L of traffic.lanes.values()) {
        if (!L.ok || !L.pts || L.pts.length < 2 || (L.draft || 11) < S.d + 1) continue;
        let best = Infinity, bi = 0;
        for (let i = 0; i < L.pts.length - 1; i++) {
            const A = L.pts[i], B = L.pts[i + 1];
            for (let u = 0; u <= 1; u += 0.1) { const q = _tfLerp(A, B, u), d = _tfDist(me, q); if (d < best) { best = d; bi = i + u; } }
        }
        if (best < 40000) cands.push({ L, bi, best });
    }
    if (cands.length) {
        const c = _tfPick(cands);
        const P = c.L.pts.map(q => ({ lat: q.lat, lon: q.lon, ch: false }));
        if (Math.random() < 0.5) P.reverse();
        pts = P;
    }
    // 2. 自分の船の近くを通るまっすぐの航路
    if (!pts) {
        const kind = Math.random();
        const crs = kind < 0.4 ? (hdgMe + 180 + _tfRand(-15, 15)) % 360 : kind < 0.7 ? (hdgMe + _tfRand(-10, 10) + 360) % 360 : (hdgMe + (Math.random() < 0.5 ? 90 : -90) + _tfRand(-25, 25) + 360) % 360;
        const side = _tfRand(1000, 5000) * (Math.random() < 0.5 ? 1 : -1);
        const mid = _tfOff(_tfOff(me, crs + 90, side), hdgMe, kind >= 0.4 && kind < 0.7 ? -_tfRand(3000, 8000) : _tfRand(3000, 10000));
        const A = _tfOff(mid, crs + 180, 30000), B = _tfOff(mid, crs, 30000);
        for (let u = 0; u <= 1; u += 0.05) if (_tfDepth(_tfLerp(A, B, u)) < S.d + 6) return false;      // 浅い所を通るなら、今は出さない
        pts = [{ lat: A.lat, lon: A.lon, ch: false }, { lat: B.lat, lon: B.lon, ch: false }];
    }
    S.path = _tfPrepPath(S, _tfSmoothPath(S, { pts, arriveIdx: -1 }));
    // 自分の船から 15〜22km 手前（自分の船の方へ向かう所）から
    let sNear = 0, dBest = Infinity;
    for (let s = 0; s <= S.path.total; s += Math.max(500, S.path.total / 400)) { const d = _tfDist(me, _tfAlong(S.path, s)); if (d < dBest) { dBest = d; sNear = s; } }
    s0 = Math.max(0, sNear - _tfRand(15000, 22000));
    if (S.path.total - s0 < 20000) return false;
    S.s = s0; S.transient = true; S.to = null; S.st = 'go'; S.v = S.vSea; S.checked = true;
    _tfSnapToPath(S);
    S.dPl = _tfDist(me, S);
    traffic.ships.push(S);
    return true;
}

// ── 保存した船のモデルの部品を、材質ごとにまとめる ──
//  root（親の無いグループ。部品の matrixWorld が root の中の座標）の中の、ふつうのメッシュ（1 つの材質・骨や変形の無いもの）を、
//  材質・頂点の持ち物・影の落とし方が同じものどうしで 1 つの形にまとめ、root の直下に置き直す
const _TF_ATTRS = ['position', 'normal', 'uv', 'uv2', 'color', 'tangent'];
function _tfAttrRead(a, i, c) {
    let v = c === 0 ? a.getX(i) : c === 1 ? a.getY(i) : c === 2 ? a.getZ(i) : a.getW(i);
    if (a.normalized) {
        const A = a.isInterleavedBufferAttribute ? a.data.array : a.array;
        v = A instanceof Int8Array ? Math.max(-1, v / 127) : A instanceof Uint8Array ? v / 255 : A instanceof Int16Array ? Math.max(-1, v / 32767) : A instanceof Uint16Array ? v / 65535 : v;
    }
    return v;
}
function _tfMergeProto(root) {
    root.updateMatrixWorld(true);
    const groups = new Map(), drop = [];
    root.traverse(o => {
        if (!o.isMesh || o.isSkinnedMesh || o.isInstancedMesh || Array.isArray(o.material) || !o.material) return;
        const g = o.geometry;
        if (!g || !g.attributes.position || (g.morphAttributes && Object.keys(g.morphAttributes).length) || (g.groups && g.groups.length > 1)) return;
        let vis = true; for (let x = o; x; x = x.parent) if (!x.visible) { vis = false; break; }
        if (!vis) { drop.push(o); return; }
        const names = _TF_ATTRS.filter(n => g.attributes[n]);
        const key = o.material.uuid + '|' + names.map(n => n + g.attributes[n].itemSize).join(',') + '|' + (o.castShadow ? 1 : 0) + (o.userData.noBloom ? 1 : 0) + (o.renderOrder | 0);
        let G = groups.get(key); if (!G) groups.set(key, G = { names, list: [] });
        G.list.push(o);
    });
    const nm = new THREE.Matrix3(), v = new THREE.Vector3();
    for (const G of groups.values()) {
        if (G.list.length < 2) continue;
        let nv = 0, ni = 0;
        for (const o of G.list) { const g = o.geometry; nv += g.attributes.position.count; ni += g.index ? g.index.count : g.attributes.position.count; }
        const out = {}, sizes = {};
        for (const n of G.names) { sizes[n] = G.list[0].geometry.attributes[n].itemSize; out[n] = new Float32Array(nv * sizes[n]); }
        const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
        let vo = 0, io = 0;
        for (const o of G.list) {
            const g = o.geometry, M = o.matrixWorld, cnt = g.attributes.position.count;
            nm.getNormalMatrix(M);
            const flip = M.determinant() < 0;
            for (const n of G.names) {
                const a = g.attributes[n], k = sizes[n], O = out[n];
                for (let i = 0; i < cnt; i++) {
                    const d = (vo + i) * k;
                    if (n === 'position') { v.set(_tfAttrRead(a, i, 0), _tfAttrRead(a, i, 1), _tfAttrRead(a, i, 2)).applyMatrix4(M); O[d] = v.x; O[d + 1] = v.y; O[d + 2] = v.z; }
                    else if (n === 'normal') { v.set(_tfAttrRead(a, i, 0), _tfAttrRead(a, i, 1), _tfAttrRead(a, i, 2)).applyMatrix3(nm).normalize(); O[d] = v.x; O[d + 1] = v.y; O[d + 2] = v.z; }
                    else if (n === 'tangent') { v.set(_tfAttrRead(a, i, 0), _tfAttrRead(a, i, 1), _tfAttrRead(a, i, 2)).transformDirection(M); O[d] = v.x; O[d + 1] = v.y; O[d + 2] = v.z; O[d + 3] = _tfAttrRead(a, i, 3) * (flip ? -1 : 1); }
                    else for (let c = 0; c < k; c++) O[d + c] = _tfAttrRead(a, i, c);
                }
            }
            if (g.index) {
                const I = g.index, n = I.count;
                for (let j = 0; j < n; j += 3) {
                    const a0 = I.getX(j), a1 = I.getX(j + 1), a2 = I.getX(j + 2);
                    idx[io++] = vo + a0; idx[io++] = vo + (flip ? a2 : a1); idx[io++] = vo + (flip ? a1 : a2);
                }
            } else {
                for (let j = 0; j < cnt; j += 3) { idx[io++] = vo + j; idx[io++] = vo + j + (flip ? 2 : 1); idx[io++] = vo + j + (flip ? 1 : 2); }
            }
            vo += cnt;
        }
        const geo = new THREE.BufferGeometry();
        for (const n of G.names) geo.setAttribute(n, new THREE.BufferAttribute(out[n], sizes[n], false));
        geo.setIndex(new THREE.BufferAttribute(idx, 1));
        geo.computeBoundingSphere(); geo.computeBoundingBox();
        const f = G.list[0], m = new THREE.Mesh(geo, f.material);
        m.castShadow = f.castShadow; m.receiveShadow = f.receiveShadow; m.renderOrder = f.renderOrder;
        m.userData.noLightBake = true; m.userData.noBloom = f.userData.noBloom;
        root.add(m);
        for (const o of G.list) drop.push(o);
    }
    // まとめた元の部品を外す（形は、ほかで使っていなければ捨てる）
    const dropS = new Set(drop), keep = new Set();
    root.traverse(o => { if (o.isMesh && !dropS.has(o)) keep.add(o.geometry); });
    for (const o of drop) {
        // （外す部品の子で、まとめなかった物は、見た目の位置のまま root へ移す）
        for (const c of o.children.slice()) if (!dropS.has(c)) root.attach(c);
        if (o.parent) o.parent.remove(o);
        if (!keep.has(o.geometry)) o.geometry.dispose();
    }
}

// 保存した船のモデルに、空の見え方を焼き込む（ジェネレーター：1 フレーム数 ms ずつ。形は使い回すので 1 回だけ）
function* _tfProtoAO(root, S) {
    const list = [];
    root.traverse(o => { if (o.isMesh && o.geometry && o.geometry.attributes.position) list.push(o); });
    if (!list.length) return;
    const G = yield* _ssBuild(list, root);
    if (!G) return;
    G.vWorld = G.v * S;
    const F = yield* _aoField(G);
    yield* _aoMeshes(G, F, list, root);
}
function _tfProtoAOStep() {
    const t0 = performance.now();
    for (const P of _tfProto.values()) {
        if (!P.aoJob) continue;
        try { while (performance.now() - t0 < 4) { if (P.aoJob.next().done) { P.aoJob = null; break; } } }
        catch (e) { console.warn('保存した船の空の見え方を作れませんでした', e); P.aoJob = null; }
        return;                      // 1 つずつ
    }
}

// ════════════════════════════════════════════════════════════════
//  行き会い・追い越しの汽笛と、その返事
// ════════════════════════════════════════════════════════════════
//  行き会い：短音 1 回（右へ変針する）→ 相手も短音 1 回
//  追い越し：長長短短（あなたの左舷側を追い越したい）→ 追い越される船は 長短長短（同意）
//  同じ相手には 10 分に 1 回だけ。自分の船は自動航行中だけ、自動で鳴らす・返す（36-horns.js の汽笛で）
const TF_SIG = { meet: { call: 'S', reply: 'S', delay: 3 }, over: { call: 'LLSS', reply: 'LSLS', delay: 15 } };
function _tfSigKey(O) { return O.player ? 'P' : O.id; }
function _tfSignal(S, O, kind, dist) {
    if (!(dist < 3000) || !(S.dPl < 7000)) return;
    S.sigs = S.sigs || {};
    const k = _tfSigKey(O);
    if (traffic.t - (S.sigs[k] ?? -1e9) < 600) return;
    S.sigs[k] = traffic.t;
    const G = TF_SIG[kind];
    _tfHorn(S, G.call);
    if (S.dPl < 8000) _trMsgSafe(`${S.name}：${kind === 'meet' ? '短音 1 回（右へ変針します）' : '長長短短（追い越します）'}`);
    if (O.player) {
        // 自分の船（自動航行中）：返事をする
        if (typeof autopilot !== 'undefined' && autopilot.active)
            _tfLater(_tfSigLen(G.call) + G.delay, () => { _tfPlayerHorn(G.reply); _tfPlayerTurnQuiet(); }, _tfSigLen(G.call));
        return;
    }
    O.sigs = O.sigs || {}; O.sigs[S.id] = traffic.t;          // 相手からは、同じ出会いで改めて鳴らさない
    _tfLater(_tfSigLen(G.call) + G.delay, () => _tfHorn(O, G.reply), _tfSigLen(G.call));
}
// 自分の船（自動航行中）から鳴らす。相手の船（保存した船ならその汽笛で）が返事をする
function _tfPlayerSignal(O, kind) {
    if (!traffic.horn || typeof autopilot === 'undefined' || !autopilot.active || typeof playHornSignal !== 'function') return;
    traffic.player.sigs = traffic.player.sigs || {};
    if (traffic.t - (traffic.player.sigs[O.id] ?? -1e9) < 600) return;
    traffic.player.sigs[O.id] = traffic.t;
    O.sigs = O.sigs || {}; O.sigs.P = traffic.t;
    const G = TF_SIG[kind];
    _tfPlayerHorn(G.call); _tfPlayerTurnQuiet();
    _tfLater(_tfSigLen(G.call) + G.delay, () => _tfHorn(O, G.reply), _tfSigLen(G.call));
}
// 合図の長さ[秒]（長音 5＋2 秒・短音 1＋1 秒）
function _tfSigLen(p) { return p.split('').reduce((a, ch) => a + (ch === 'L' ? 7 : 2), 0); }
// しばらく後に（船の時間で sec 秒後。realSec を渡せば、実時間でも少なくともそれだけ後：早送りでも、合図を鳴らし終えてから返事）
function _tfLater(sec, fn, realSec) { (traffic.later = traffic.later || []).push({ at: traffic.t + sec, atR: performance.now() + (realSec || 0) * 1000, fn }); }
function _tfLaterTick() {
    const L = traffic.later; if (!L || !L.length) return;
    const nowR = performance.now();
    for (let i = L.length - 1; i >= 0; i--) if (traffic.t >= L[i].at && nowR >= L[i].atR) { const f = L[i].fn; L.splice(i, 1); try { f(); } catch (e) { /* ignore */ } }
}
// 自分の船の汽笛（36-horns.js）。鳴らしている途中の合図は切らない
function _tfPlayerHorn(pat) {
    if (!traffic.horn || typeof playHornSignal !== 'function') return false;
    const nowR = performance.now(), P = traffic.player;
    if (P.hornEnd > nowR) return false;
    P.hornEnd = nowR + _tfSigLen(pat) * 1000;
    playHornSignal(pat);
    return true;
}

// ════════════════════════════════════════════════════════════════
//  警告信号・変針の信号
// ════════════════════════════════════════════════════════════════
//  ・警告（短音 5 回）：進路が重なってきて（最接近が近く・7 分以内）、相手がよけていないとき。保持船（よけなくてよい方）が鳴らす
//    同じ相手には 2 分に 1 回まで
//  ・変針（右へ短音 1 回・左へ短音 2 回）：他の船（動いている船）が TF_SIG_NEAR（3km）以内にいるときだけ。後進の信号（短音 3 回）は鳴らさない
//    （出入港で前進・後進を何度も切り替えるので）
function _tfWarn(S, O) {
    if (!(S.dPl < 7000)) return;
    S.sigs = S.sigs || {};
    const k = 'w' + _tfSigKey(O);
    if (traffic.t - (S.sigs[k] ?? -1e9) < 120) return;
    S.sigs[k] = traffic.t;
    _tfHorn(S, 'D');
    _trMsgSafe(`${S.name}：短音 5 回（${O.player ? 'あなたの船' : O.name} に警告：そちらの動きが分かりません）`);
}
function _tfTurnSig(S, key, pat) {
    S.sigs = S.sigs || {};
    const k = 't' + key;
    if (traffic.t - (S.sigs[k] ?? -1e9) < 300) return;
    S.sigs[k] = traffic.t;
    _tfHorn(S, pat);
}
// S の近く（r[m]）に、動いている他の船（自分の船を含む）がいるか
function _tfMovingOther(O) { return _tfShown(O) && O.st !== 'berth' && O.st !== 'anchored' && (O.v || 0) > 0.3; }
function _tfOtherNear(S, r) {
    if (S.dPl < r) return true;
    for (const O of traffic.ships) if (O !== S && O.dPl < TF_NEAR && _tfMovingOther(O) && Math.abs(O.lat - S.lat) < 0.03 && _tfDist(S, O) < r) return true;
    return false;
}
// 自分の船の合図（0.5 秒ごと）：手で動かしているときも、自動航行のときも（音の設定の「自動の汽笛」で切れる）
//  ・変針：回り始めてから 12° 以上回ったら 1 回（波で振れるくらいの小さな揺れは数えない）
//  ・警告：自分が保持船で、相手がよけずに進路が重なってくるとき
function _tfPlayerAuto() {
    const me = _tfPlayerAsShipSafe();
    if (!me) return;
    const P = traffic.player, HA = typeof hornAuto !== 'undefined' ? hornAuto : {};
    // 回っている量（同じ向きに回り続けている間だけ足す。逆へ回るか、4 秒止まれば数え直す）
    if (P.hPrev === undefined) { P.hPrev = me.hdg; P.turn = 0; P.calm = 0; P.turnSig = false; }
    const d = _tfWrap(me.hdg - P.hPrev); P.hPrev = me.hdg;
    if (Math.abs(d) > 0.15) {
        if (P.turn && Math.sign(d) !== Math.sign(P.turn)) { P.turn = 0; P.turnSig = false; }
        P.turn += d; P.calm = 0;
    } else if ((P.calm += 0.5) > 4) { P.turn = 0; P.turnSig = false; }
    if (!P.turnSig && Math.abs(P.turn) >= 12 && me.v > 0.75 && HA.turn && !(traffic.t < (P.turnQuiet || 0))) {
        let near = false;
        for (const O of traffic.ships) if (O.dPl < TF_SIG_NEAR && _tfMovingOther(O)) { near = true; break; }
        if (near && _tfPlayerHorn(P.turn > 0 ? 'S' : 'SS')) { P.turnSig = true; _trMsgSafe(`あなたの船：${P.turn > 0 ? '短音 1 回（右へ変針）' : '短音 2 回（左へ変針）'}`); }
    }
    if (!HA.warn) return;
    P.sigs = P.sigs || {};
    for (const O of traffic.ships) {
        if (!(O.dPl < 4000) || !_tfMovingOther(O)) continue;
        if (O.avoid && O.avoid.P) continue;                         // 相手はよけている
        const c = _tfCPA(me, O);
        if (!(c.t > 0 && c.t < 420 && c.cpa < Math.max(1.5 * me.L, 300))) continue;
        const rb = _tfWrap(_tfBrg(me, O) - me.hdg), rbFromO = _tfWrap(_tfBrg(O, me) - O.hdg);
        const sameDir = Math.abs(_tfWrap(O.hdg - me.hdg)) < 45;
        const headOn = Math.abs(rb) < 12 && Math.abs(rbFromO) < 12;
        // 自分が保持船：相手を左に見る横切り・追い越されるとき。行き会いは、近くなっても相手がよけないとき
        const standOn = (!sameDir && rb < 0 && rb > -112.5) || (sameDir && Math.abs(rb) > 112.5) || (headOn && c.t < 300);
        if (!standOn) continue;
        const k = 'w' + O.id;
        if (traffic.t - (P.sigs[k] ?? -1e9) < 120) continue;
        if (_tfPlayerHorn('SSSSS')) { P.sigs[k] = traffic.t; _trMsgSafe(`あなたの船：短音 5 回（${O.name} に警告）`); }
        break;
    }
}
function _tfPlayerTurnQuiet() { traffic.player.turnQuiet = traffic.t + 60; traffic.player.turnSig = true; }
function _trMsgSafe(s) { try { _tfMsg(s); } catch (e) { /* ignore */ } }


// ════════════════════════════════════════════════════════════════
//  ぶつかる（自分の船と他の船・他の船どうし）
// ════════════════════════════════════════════════════════════════
//  船体は、上から見た形で調べる：自分の船は船体の輪切りの幅（_tugHalfWidth）、他の船は長さ・幅から作った形（船首は細く、船尾は丸く）
//  相手の外形の点が船体の中に入っていたら、入った深さだけ押し離し、近づく速さを重さの割合で分ける（少しだけ跳ね返る）
//  ・自分の船：前後の速さ（physics.speed）・横流れ・回頭（ここで持つ traffic.bump）が変わる
//  ・他の船：航行中は押されて流れ、しばらく機関を止める。停泊・錨泊・離着岸中の船は動かない（岸壁と同じ）
traffic.bump = { vS: 0, r: 0 };
function _tfShapeHW(S, a) {
    const u = Math.abs(a) / (S.L / 2);
    if (u >= 1) return 0;
    return S.B / 2 * Math.sqrt(Math.max(0, 1 - Math.pow(u, a > 0 ? 2.5 : 6)));
}
function _tfHullOf(S) {
    const loc = _tfLocal(S, {});
    if (!Number.isFinite(loc.x)) return null;
    const yaw = _tfYaw(S, loc);
    return { x: loc.x, z: loc.z, fx: Math.sin(yaw), fz: Math.cos(yaw), sx: Math.cos(yaw), sz: -Math.sin(yaw), HL: S.L / 2, hw: a => _tfShapeHW(S, a), S };
}
function _tfHullOfPlayer() {
    if (typeof shipGroup === 'undefined' || !shipGroup || typeof _tugShipCtx !== 'function') return null;
    const C = _tugShipCtx();
    return { x: C.sp.x, z: C.sp.z, fx: C.F.fx, fz: C.F.fz, sx: C.F.sx, sz: C.F.sz, HL: C.HL, hw: a => _tugHalfWidth(a / C.sc) * C.sc, player: true };
}
// A の外形の点が B の中に入っている一番深い所：{ pen, nx, nz（A を押す向き）, px, pz }
function _tfHullInto(A, B, best, flip) {
    const N = 16;
    for (let i = -N; i <= N; i++) {
        const a = i / N * A.HL * 0.995, w = A.hw(a);
        for (const sg of (w > 0.3 ? [-1, 1] : [0])) {
            const px = A.x + A.fx * a + A.sx * sg * w, pz = A.z + A.fz * a + A.sz * sg * w;
            const dx = px - B.x, dz = pz - B.z, ab = dx * B.fx + dz * B.fz, sb = dx * B.sx + dz * B.sz;
            if (Math.abs(ab) >= B.HL) continue;
            const hwB = B.hw(ab), penS = hwB - Math.abs(sb);
            if (penS <= 0) continue;
            const penA = B.HL - Math.abs(ab);
            // 抜けやすい向き（横・前後）へ押す。B の外へ出る向き → A はその向き、B に入ってきた点（flip）なら逆
            let pen, nx, nz;
            if (penS <= penA) { pen = penS; const k = sb >= 0 ? 1 : -1; nx = B.sx * k; nz = B.sz * k; }
            else { pen = penA; const k = ab >= 0 ? 1 : -1; nx = B.fx * k; nz = B.fz * k; }
            if (flip) { nx = -nx; nz = -nz; }
            if (pen > best.pen) Object.assign(best, { pen, nx, nz, px, pz });
        }
    }
    return best;
}
function _tfHullPen(A, B) {
    const best = { pen: 0 };
    _tfHullInto(A, B, best, false);      // A の点が B に入っている：A を B の外へ
    _tfHullInto(B, A, best, true);       // B の点が A に入っている：B を A の外へ（A はその逆へ）
    return best.pen > 0 ? best : null;
}
// 他の船の重さ[kg]（方形係数 0.7 ほど）。動かない状態なら Infinity
function _tfMassOf(S) {
    if (S.st === 'berth' || S.st === 'berthing' || S.st === 'unberth') return Infinity;
    const m = Math.max(5e5, 0.7 * S.L * S.B * Math.max(2, S.d) * 1025);
    return S.st === 'anchored' ? m * 3 : m;
}
function _tfPlayerMass() { return Math.max(1e5, (physics.mass || 1) * 1e6); }
// 他の船を（物理の面で）dx, dz だけ動かす：道すじに沿う分は s、横は off へ
function _tfShove(S, H, dx, dz) {
    if (S.path && (S.st === 'go' || S.st === 'anchoring' || S.st === 'holding')) {
        const along = dx * H.fx + dz * H.fz, stbd = -(dx * H.sx + dz * H.sz);
        const s0 = S.s, off0 = S.off || 0;
        S.s = Math.max(0, Math.min(S.path.total, S.s + along));
        S.off = off0 + stbd;
        let q = _tfAlong(S.path, S.s);
        const crs = _tfSegCrs(S.path, q.k);
        let m = Math.abs(S.off) > 0.5 ? _tfOff(q, crs + 90, S.off) : q;
        // 横へ押されて浅い所・陸に乗り上げるなら、横へは動かさず前後へ
        if (Math.abs(stbd) > 0.01 && !_tfBandOK(S, m, crs, S.d)) {
            S.off = off0;
            S.s = Math.max(0, Math.min(S.path.total, s0 + along + Math.abs(stbd) * (along >= 0 ? 1 : -1)));
            q = _tfAlong(S.path, S.s);
            m = Math.abs(S.off) > 0.5 ? _tfOff(q, _tfSegCrs(S.path, q.k) + 90, S.off) : q;
            S.pushV = 0;
        }
        S.k = q.k;
        S.lat = m.lat; S.lon = m.lon;
        return;
    }
    if (S.st === 'anchored') {
        const loc = _tfLocal(S, {});
        if (!Number.isFinite(loc.x)) return;
        const ll = worldUnitToLatLon(worldLocalToUnit(loc.x + dx, loc.z + dz));
        if (_tfDepthAt(ll.lat, ll.lon) < S.d) return;
        S.lat = ll.lat; S.lon = ll.lon;
        if (S.anch) { S.anch = { lat: ll.lat, lon: ll.lon, d: S.anch.d }; }
    }
}
function _tfCollide(dt) {
    const B = traffic.bump;
    // 自分の船の横流れ・回頭（ぶつかって押された分）：水の抵抗でゆっくり止まる
    if (B.vS || B.r) {
        if (typeof _shipFrame === 'function' && typeof shipGroup !== 'undefined' && shipGroup) {
            const F = _shipFrame(), dx = F.sx * B.vS * dt, dz = F.sz * B.vS * dt;
            physics.cgWorldX += dx; physics.cgWorldZ += dz; shipGroup.position.x += dx; shipGroup.position.z += dz;
            physics.heading += B.r * 180 / Math.PI * dt;
        }
        B.vS *= Math.exp(-0.35 * dt); B.r *= Math.exp(-0.5 * dt);
        if (Math.abs(B.vS) < 0.005) B.vS = 0;
        if (Math.abs(B.r) < 1e-5) B.r = 0;
    }
    if (typeof isDesignMode !== 'undefined' && isDesignMode) return;
    const me = _tfPlayerLL(), Lp = _tfPlayerLen();
    const cand = traffic.ships.filter(S => _tfShown(S) && S.dPl < TF_SHOW);
    // 自分の船
    const P = cand.some(S => S.dPl < (Lp + S.L) / 2 + 30) ? _tfHullOfPlayer() : null;
    if (P) for (const S of cand) {
        if (!(S.dPl < (Lp + S.L) / 2 + 30)) continue;
        const H = _tfHullOf(S); if (!H) continue;
        const c = _tfHullPen(P, H); if (!c) continue;
        // 止まっている自分の船に、停泊・錨泊中の船が重なっている（隣の埠頭の船が、自分の船の場所まではみ出している）：
        // 自分の船を岸壁の方へ押してしまわないよう押し合わず、その船に出て行ってもらう
        if (_tfMassOf(S) === Infinity && Math.abs(physics.speed || 0) < 0.5 && Math.abs(traffic.bump.vS) < 0.05) {
            if (S.st === 'berth') S.t = Math.min(S.t, 2);
            else if (S.st === 'anchored') S.t = Math.min(S.t, 2);
            continue;
        }
        _tfContact(P, H, c, null, S);
    }
    // 他の船どうし（見える所だけ）
    for (let i = 0; i < cand.length; i++) for (let j = i + 1; j < cand.length; j++) {
        const A = cand[i], C = cand[j];
        if (Math.abs(A.lat - C.lat) > 0.01 || _tfDist(A, C) > (A.L + C.L) / 2 + 10) continue;
        // （どちらも動かない船（停泊・離着岸中）どうしは押し合わない：離着岸の場所は、ほかの船が空くのを待ってから使う）
        if (_tfMassOf(A) === Infinity && _tfMassOf(C) === Infinity) continue;
        if ((A.ghost && A.ghost.k === C.id && traffic.t < A.ghost.until) || (C.ghost && C.ghost.k === A.id && traffic.t < C.ghost.until)) continue;
        const HA = _tfHullOf(A), HC = _tfHullOf(C); if (!HA || !HC) continue;
        const c = _tfHullPen(HA, HC); if (!c) continue;
        _tfContact(HA, HC, c, A, C);
    }
}
// A（自分の船か、他の船 SA）と B（他の船 SB）が c で触れている
function _tfContact(A, Bh, c, SA, SB) {
    const mA = SA ? _tfMassOf(SA) : _tfPlayerMass(), mB = _tfMassOf(SB);
    const iA = mA === Infinity ? 0 : 1 / mA, iB = mB === Infinity ? 0 : 1 / mB;
    if (!(iA + iB > 0)) return;
    const nx = c.nx, nz = c.nz;               // A を押す向き
    // 位置：めり込みを重さの割合で分けて離す（少し余分に）
    const pen = c.pen + 0.3, kA = iA / (iA + iB), kB = iB / (iA + iB);
    if (kA > 0) {
        if (SA) _tfShove(SA, A, nx * pen * kA, nz * pen * kA);
        else { physics.cgWorldX += nx * pen * kA; physics.cgWorldZ += nz * pen * kA; shipGroup.position.x += nx * pen * kA; shipGroup.position.z += nz * pen * kA; }
    }
    if (kB > 0) _tfShove(SB, Bh, -nx * pen * kB, -nz * pen * kB);
    // 速さ（船の向きの速さ＋押された横流れ）
    const vel = (H, S) => {
        if (S) return { x: H.fx * (S.v || 0) + H.sx * -(S.pushV || 0), z: H.fz * (S.v || 0) + H.sz * -(S.pushV || 0) };
        const v = (physics.speed || 0) * 0.514444, vs = traffic.bump.vS + (typeof _tugShip !== 'undefined' && typeof tugs !== 'undefined' && tugs.length ? _tugShip.vSway : 0);
        return { x: H.fx * v + H.sx * vs, z: H.fz * v + H.sz * vs };
    };
    const va = vel(A, SA), vb = vel(Bh, SB);
    const vn = (va.x - vb.x) * nx + (va.z - vb.z) * nz;      // ＜0：近づいている
    if (vn >= 0) return;
    const e = 0.15, J = -(1 + e) * vn / (iA + iB);
    // こすれる向きの速さも少し落とす（摩擦）
    const tx = -nz, tz = nx, vt = (va.x - vb.x) * tx + (va.z - vb.z) * tz;
    const Jt = -Math.sign(vt) * Math.min(Math.abs(vt) / (iA + iB) * 0.5, 0.3 * J);
    const Jx = nx * J + tx * Jt, Jz = nz * J + tz * Jt;
    const apply = (H, S, sgn, inv) => {
        if (!inv) return;
        const dvx = sgn * Jx * inv, dvz = sgn * Jz * inv;
        const dF = dvx * H.fx + dvz * H.fz, dS = dvx * H.sx + dvz * H.sz;
        if (S) { if (S.st === 'go' || S.st === 'anchoring') S.v = Math.max(0, (S.v || 0) + dF); S.pushV = (S.pushV || 0) - dS / 1.8; return; }
        physics.speed = (physics.speed || 0) + dF / 0.514444;
        traffic.bump.vS += dS / 1.8;                       // 横は周りの水も一緒に動かす（付加質量）
        // 回頭：当たった所（船の中の前後 a・横 s）と力の向き
        const rx = c.px - H.x, rz = c.pz - H.z, a = rx * H.fx + rz * H.fz, s = rx * H.sx + rz * H.sz;
        const jf = sgn * (Jx * H.fx + Jz * H.fz), js = sgn * (Jx * H.sx + Jz * H.sz);
        const L = 2 * H.HL, Iyaw = (1 / inv) * 1.5 * L * L / 12;
        traffic.bump.r += (a * js - s * jf) / Iyaw;
    };
    apply(A, SA, 1, iA); apply(Bh, SB, -1, iB);
    // ぶつかった（軽く触れただけでなければ）：他の船は機関を止める
    const hard = -vn;
    // 強く当たれば船体に穴があく（64-damage.js）
    if (typeof damageCollision === 'function') damageCollision(c, SA, SB, hard, mA, mB);
    if (hard > 0.6) { if (SA) SA.hitT = traffic.t; SB.hitT = traffic.t; }
    // 音・知らせ（強く当たったときだけ。同じ相手には 5 秒に 1 回）
    const key = (SA ? SA.id : 'P') + '-' + SB.id;
    traffic.hitMsg = traffic.hitMsg || {};
    if (hard > 0.3 && !(traffic.t - (traffic.hitMsg[key] ?? -1e9) < 5)) {
        traffic.hitMsg[key] = traffic.t;
        if (typeof audioWaveImpact === 'function' && (!SA || SB.dPl < 3000)) audioWaveImpact(new THREE.Vector3(c.px, 2, c.pz), Math.min(2.5, 0.6 + hard / 2), true);
        _trMsgSafe(SA ? `${SA.name} と ${SB.name} がぶつかりました` : `${SB.name} とぶつかりました（${_tfKn(hard).toFixed(1)} kn）`);
    }
}
window.trafficCollide = _tfCollide;
// 近く（自分の船から 3km 以内）の他の船の船体（上から見た形）。タグ（47-tugboats.js）が、他の船に重ならないように使う
// （1 フレームに 1 回だけ作る：updateTraffic で捨てる）
function trafficHulls() {
    if (traffic._hulls) return traffic._hulls;
    const L = [];
    if (traffic.on && traffic.ready) for (const S of traffic.ships) if (_tfShown(S) && S.dPl < 3000) { const H = _tfHullOf(S); if (H) L.push(H); }
    return (traffic._hulls = L);
}
window.trafficHulls = trafficHulls;
