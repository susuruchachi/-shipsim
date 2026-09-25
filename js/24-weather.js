// 24-weather.js — 天候と、それに連動する風・波
//
// ════════════════════════════════════════════════════════════
//  考え方
// ════════════════════════════════════════════════════════════
//  「天気」「風」「波」を別々のスライダーとして持つと、組み合わせ次第で
//  現実には起こらない海（快晴なのに大時化、暴風なのに鏡のような海面）が
//  簡単に作れてしまう。ここでは1本の芯として **ビューフォート風力階級** を
//  置き、そこから風速と有義波高を導く。天候が変われば風が変わり、風が
//  変われば波が変わる、という一方向の流れにする。
//
//     天候(荒れ具合) → ビューフォート数 → 風速 ─┬→ チョップ（すぐ応答）
//                                            └→ うねり（遅れて応答）
//
//  【うねりが風に遅れる理由】実際の海で、風が止んでもうねりはしばらく残り、
//  逆に吹き始めてすぐは細かい波（チョップ）だけが立つ。この時間差が無いと
//  天候が変わった瞬間に海面全体が一斉に切り替わって嘘っぽくなるので、
//  チョップは短い時定数、うねりは長い時定数で追従させている。
//
//  【風速→波高の対応】WMO の海況表（ビューフォート数ごとの有義波高）を
//  そのまま表として持ち、線形補間する。式で近似するより素直で、
//  値の根拠もはっきりする。
//
// ════════════════════════════════════════════════════════════
//  他モジュールとの関係
// ════════════════════════════════════════════════════════════
//  ・physics.windSpeed/windDir/waveRoughness/waveWidth/swellStrength/
//    chopStrength を毎フレーム書く（波の生成式は 02-utils-and-wave-physics.js）。
//  ・太陽・環境光・霧の強さは window.weatherLightMul を通して
//    16-daynight-and-telegraph.js に渡す。時刻による変化と掛け算になるので、
//    「曇りの朝」「快晴の夕方」が自然に両立する。
//  ・空の雲量は 05-sky-dome.js の cloudAmount uniform へ。

// ビューフォート数 → 有義波高[m]（WMO 海況表の代表値）
const WEATHER_WAVE_HEIGHT_BY_BEAUFORT = [
    0.0,  // 0 平穏
    0.1,  // 1 至軽風
    0.2,  // 2 軽風
    0.6,  // 3 軟風
    1.0,  // 4 和風
    2.0,  // 5 疾風
    3.0,  // 6 雄風
    4.0,  // 7 強風
    5.5,  // 8 疾強風
    7.0,  // 9 大強風
    9.0,  // 10 全強風
    11.5, // 11 暴風
    14.0, // 12 颶風
];

// 有義波高[m] → physics.waveRoughness への換算。
// 以前は「waveRoughness = 有義波高 × 0.5」の一定係数だったが、実際に水面を
// 測ると目標の2〜3倍の波が立っていた（風力11で表は11.5mのところ約35m）。
// うねり・チョップの強さも風力とともに上がるのに、それを換算に入れていな
// かったため。02-utils-and-wave-physics.js の合成式
//   η = h·(1.3·w1 + 0.7·w2 + 0.55·swell·w3 + 0.22·chop·w4)
// の各成分の分散（w1,w2 = 2·max(sinθ,0)² − c → 0.5、w3 = sinθ → 0.5、
// w4 = 0.5·sinθ → 0.125）から、有義波高 Hs = 4σ は
//   Hs = 4h·√(1.09 + 0.151·swell² + 0.00605·chop²)
// になる（実際に水面を標本化して測った値と一致することを確認済み）。
// これを逆に解いて h を決めるので、見た目の波も船の揺れ・抵抗も表どおりの
// 波の大きさになる。もっと派手な海にしたいときは WEATHER_WAVE_HEIGHT_SCALE を上げる。
const WEATHER_WAVE_HEIGHT_SCALE = 1.0;
function weatherRoughnessForHs(hs, swell, chop) {
    const k = 4 * Math.sqrt(1.09 + 0.151 * swell * swell + 0.00605 * chop * chop);
    return Math.max(0, hs) * WEATHER_WAVE_HEIGHT_SCALE / k;
}

// 天候プリセット。severity は 0(穏やか)〜1(大時化) の目安で、
// 自動変化のランダムウォークはこの並び順の上を歩く。
// rain（雨量）・fog（霧）は 0〜1。嵐では雷も鳴る（29-weather-fx.js）。
const WEATHER_PRESETS = [
    { key: 'calm',   label: '凪',       beaufort: 1.0, cloud: 0.06, haze: 0.7,  rain: 0.0,  fog: 0.0 },
    { key: 'fair',   label: '晴れ',     beaufort: 3.0, cloud: 0.22, haze: 0.85, rain: 0.0,  fog: 0.0 },
    { key: 'breezy', label: 'やや波あり', beaufort: 5.0, cloud: 0.45, haze: 1.0,  rain: 0.0,  fog: 0.0 },
    { key: 'rough',  label: '荒れ模様',  beaufort: 7.0, cloud: 0.78, haze: 1.7,  rain: 0.3,  fog: 0.05 },
    { key: 'gale',   label: '時化',     beaufort: 9.0, cloud: 0.92, haze: 2.6,  rain: 0.7,  fog: 0.1 },
    { key: 'storm',  label: '嵐',       beaufort: 11.0, cloud: 0.98, haze: 3.8, rain: 1.0,  fog: 0.15 },
];
// 荒れ具合の並びに乗らない天候（自動の移り変わりでは選ばれない。手動専用）
const WEATHER_SPECIAL_PRESETS = [
    { key: 'fog',    label: '霧',       beaufort: 2.0, cloud: 0.75, haze: 1.0,  rain: 0.0,  fog: 0.9 },
    { key: 'rain',   label: '雨',       beaufort: 4.0, cloud: 0.88, haze: 1.3,  rain: 0.6,  fog: 0.2 },
];

// 各量の追従の速さ[1/秒]。天候そのものは分単位でゆっくり動き、
// チョップは風にすぐ、うねりはかなり遅れてついてくる。
const WEATHER_TAU_CONDITION = 1 / 25;  // 天候の遷移（約25秒で入れ替わる）
const WEATHER_TAU_CHOP      = 1 / 6;   // チョップ（約6秒）
const WEATHER_TAU_SWELL     = 1 / 70;  // うねり（約70秒。風が止んでも残る）

// 自動変化で次の天候を選ぶ間隔[秒]の範囲
const WEATHER_AUTO_MIN_SEC = 90;
const WEATHER_AUTO_MAX_SEC = 260;

// 手で天候を変えたときの追従の速さ[1/秒]（約3秒）。自動の移り変わり
// （約25秒）のままだと、ボタンを押しても何も起きないように見えるため。
// うねりだけは手動でも遅れて育つ（それが自然な海なので）。すぐに全部
// 切り替えたいときは「すぐ反映」を使う。
const WEATHER_TAU_MANUAL = 1 / 3;
const WEATHER_MANUAL_FAST_SEC = 10;   // 手で変えてから、速い追従を続ける時間[秒]
// 手動で風向を決めたときの揺らぎ[度]。完全に固定だと機械的に見えるので少しだけ振れる。
const WEATHER_MANUAL_DIR_SWING = 4;

// 手動で細かく決める天候（presetKey が 'custom' のときに使う）
const WEATHER_CUSTOM_KEY = 'custom';

window.weather = {
    enabled: true,      // 天候で風・波を制御するか（OFFなら既存の手動スライダーのまま）
    auto: true,         // 自動で移り変わるか
    presetKey: 'breezy',// 目標の天候

    // 現在値（目標へ滑らかに追従する）
    beaufort: 5.0,
    cloud: 0.45,
    haze: 1.0,
    swellBeaufort: 5.0, // うねり用の、遅れて追従するビューフォート数
    windDir: 45,        // 度
    _windDirTarget: 45,
    _nextChangeAt: 0,   // 次に自動変化する時刻[秒]
    _initialized: false,

    // 手動で細かく決めた天候（presetKey === 'custom' のとき使う）。
    // windDir が null なら風向は自然に振れるまま。
    custom: { beaufort: 5.0, cloud: 0.45, rain: 0.0, fog: 0.0, windDir: null },
    rain: 0.0,          // 今の雨量（0〜1）
    fog: 0.0,           // 今の霧（0〜1）
    _fastUntil: 0,      // この時刻までは手動の速い追従（WEATHER_TAU_MANUAL）を使う
};

// 16-daynight-and-telegraph.js が参照する光量・霧の倍率
window.weatherLightMul = { sun: 1, ambient: 1, hemi: 1, fog: 1, grey: 0, waterDark: 1 };

function weatherPresetByKey(key) {
    return WEATHER_PRESETS.find(p => p.key === key)
        || WEATHER_SPECIAL_PRESETS.find(p => p.key === key)
        || WEATHER_PRESETS[2];
}

// ビューフォート数に一番近いプリセット
function weatherNearestPreset(beaufort) {
    let best = WEATHER_PRESETS[0];
    for (const p of WEATHER_PRESETS) if (Math.abs(p.beaufort - beaufort) < Math.abs(best.beaufort - beaufort)) best = p;
    return best;
}

// ビューフォート数から、プリセットの表を補間して視程（haze）を決める。
// 手動で風力だけ決めたときも、荒れるほど霞むという関係を保つ。
function weatherHazeFromBeaufort(b) {
    const P = WEATHER_PRESETS;
    if (b <= P[0].beaufort) return P[0].haze;
    for (let i = 1; i < P.length; i++) {
        if (b <= P[i].beaufort) {
            const k = (b - P[i - 1].beaufort) / (P[i].beaufort - P[i - 1].beaufort);
            return P[i - 1].haze + (P[i].haze - P[i - 1].haze) * k;
        }
    }
    return P[P.length - 1].haze;
}

// 今の目標天候 { beaufort, cloud, haze }
function weatherTarget() {
    const w = window.weather;
    if (w.presetKey === WEATHER_CUSTOM_KEY) {
        const c = w.custom;
        return { beaufort: c.beaufort, cloud: c.cloud, haze: weatherHazeFromBeaufort(c.beaufort),
                 rain: c.rain || 0, fog: c.fog || 0 };
    }
    return weatherPresetByKey(w.presetKey);
}

// ビューフォート数 → 風速[m/s]。B = (v/0.836)^(2/3) の逆算。
function weatherWindSpeedFromBeaufort(b) {
    return 0.836 * Math.pow(Math.max(0, b), 1.5);
}

// ビューフォート数 → 有義波高[m]（表を線形補間）
function weatherWaveHeightFromBeaufort(b) {
    const tbl = WEATHER_WAVE_HEIGHT_BY_BEAUFORT;
    const x = Math.max(0, Math.min(tbl.length - 1, b));
    const i = Math.floor(x);
    if (i >= tbl.length - 1) return tbl[tbl.length - 1];
    return tbl[i] + (tbl[i + 1] - tbl[i]) * (x - i);
}

// 指数的な追従（フレームレートに依存しない）
function weatherApproach(current, target, ratePerSec, dt) {
    const k = 1 - Math.exp(-ratePerSec * dt);
    return current + (target - current) * k;
}

// 自動変化のときに次の目標天候を選ぶ。
// 隣の天候へ移りやすく、いきなり凪から嵐へは飛ばない（ランダムウォーク）。
function weatherPickNextPreset(currentKey) {
    let idx = WEATHER_PRESETS.findIndex(p => p.key === currentKey);
    // 手動（カスタム）から自動に戻したときは、今の風力に近いプリセットから歩き始める
    if (idx < 0) idx = WEATHER_PRESETS.indexOf(weatherNearestPreset(window.weather.beaufort));
    const r = Math.random();
    let next;
    if (r < 0.40)      next = idx - 1;
    else if (r < 0.80) next = idx + 1;
    else               next = idx; // そのまま続く
    next = Math.max(0, Math.min(WEATHER_PRESETS.length - 1, next));
    return WEATHER_PRESETS[next].key;
}

function setWeatherPreset(key, opts) {
    const w = window.weather;
    w.presetKey = (key === WEATHER_CUSTOM_KEY) ? WEATHER_CUSTOM_KEY : weatherPresetByKey(key).key;
    if (opts && opts.immediate) applyWeatherTargetNow();
    if (typeof renderWeatherPanel === 'function') renderWeatherPanel();
}

// 目標天候へ、うねりも含めて一気に切り替える（「すぐ反映」ボタン・設定の読込）
function applyWeatherTargetNow() {
    const w = window.weather;
    const tg = weatherTarget();
    w.beaufort = tg.beaufort;
    w.swellBeaufort = tg.beaufort;
    w.cloud = tg.cloud;
    w.haze = tg.haze;
    w.rain = tg.rain || 0;
    w.fog = tg.fog || 0;
    if (w.presetKey === WEATHER_CUSTOM_KEY && w.custom.windDir != null) {
        w.windDir = w._windDirTarget = weatherDirToSigned(w.custom.windDir);
    }
}

// 0〜360度 → -180〜180度
function weatherDirToSigned(d) {
    let v = ((d % 360) + 360) % 360;
    return v > 180 ? v - 360 : v;
}

// 毎フレーム呼ぶ。dt[秒]、t[秒]。
function updateWeather(dt, t) {
    const w = window.weather;
    if (!w) return;
    dt = Math.max(0, Math.min(dt || 0, 0.25)); // 一時停止明けの巨大なdtで飛ばないように

    if (!w._initialized) {
        const p = weatherTarget();
        w.beaufort = p.beaufort; w.swellBeaufort = p.beaufort;
        w.cloud = p.cloud; w.haze = p.haze; w.rain = p.rain || 0; w.fog = p.fog || 0;
        w._nextChangeAt = t + WEATHER_AUTO_MIN_SEC;
        w._initialized = true;
    }
    w._now = t;

    if (!w.enabled) {
        // 天候OFF。光量・雲量の上書きも解除して、手動スライダーに完全に任せる。
        window.weatherLightMul.sun = 1; window.weatherLightMul.ambient = 1;
        window.weatherLightMul.hemi = 1; window.weatherLightMul.fog = 1;
        window.weatherLightMul.grey = 0; window.weatherLightMul.waterDark = 1;
        w.rain = 0; w.fog = 0;
        return;
    }

    // ── 目標天候の決定 ──
    if (w.auto && t >= w._nextChangeAt) {
        w.presetKey = weatherPickNextPreset(w.presetKey);
        w._nextChangeAt = t + WEATHER_AUTO_MIN_SEC
            + Math.random() * (WEATHER_AUTO_MAX_SEC - WEATHER_AUTO_MIN_SEC);
        if (typeof renderWeatherPanel === 'function') renderWeatherPanel();
    }
    const target = weatherTarget();

    // ── 現在値を目標へ寄せる ──
    // 手で変えた直後は速く、自動の移り変わりはゆっくり
    const tau = (t < w._fastUntil) ? WEATHER_TAU_MANUAL : WEATHER_TAU_CONDITION;
    w.beaufort = weatherApproach(w.beaufort, target.beaufort, tau, dt);
    w.cloud    = weatherApproach(w.cloud,    target.cloud,    tau, dt);
    w.haze     = weatherApproach(w.haze,     target.haze,     tau, dt);
    w.rain     = weatherApproach(w.rain || 0, target.rain || 0, tau, dt);
    w.fog      = weatherApproach(w.fog || 0,  target.fog || 0,  tau, dt);
    // うねりは風よりずっと遅れて追従する（風が止んでも残り、吹き始めてもすぐには育たない）
    w.swellBeaufort = weatherApproach(w.swellBeaufort, w.beaufort, WEATHER_TAU_SWELL, dt);

    // ── 風向 ──
    // 普段はゆっくり振れるだけ。荒れているときほど振れ幅が大きい。
    // 手動で風向を決めたときは、その向きのまわりで少しだけ振れる。
    const manualDir = (w.presetKey === WEATHER_CUSTOM_KEY && w.custom.windDir != null)
        ? weatherDirToSigned(w.custom.windDir) : null;
    if (manualDir != null && w._manualDirApplied !== w.custom.windDir) {
        // 新しく向きを決めた：最短回りで向かうよう目標を今の値の近くへ寄せる
        let d = manualDir - w.windDir;
        while (d > 180) d -= 360;
        while (d < -180) d += 360;
        w._windDirTarget = w.windDir + d;
        w._manualDirApplied = w.custom.windDir;
        w._nextDirChangeAt = t + 8;
    } else if (t >= (w._nextDirChangeAt || 0)) {
        if (manualDir != null) {
            let d = manualDir - w.windDir;
            while (d > 180) d -= 360;
            while (d < -180) d += 360;
            w._windDirTarget = w.windDir + d + (Math.random() - 0.5) * 2 * WEATHER_MANUAL_DIR_SWING;
        } else {
            const swing = 12 + w.beaufort * 6;          // 荒天ほど大きく振れる
            w._windDirTarget = w.windDir + (Math.random() - 0.5) * 2 * swing;
        }
        w._nextDirChangeAt = t + 20 + Math.random() * 40;
    }
    if (manualDir == null) w._manualDirApplied = null;
    w.windDir = weatherApproach(w.windDir, w._windDirTarget, (t < w._fastUntil) ? WEATHER_TAU_MANUAL : 1 / 30, dt);
    // -180〜180に正規化（延々と増え続けないように）
    while (w.windDir > 180)  { w.windDir -= 360; w._windDirTarget -= 360; }
    while (w.windDir < -180) { w.windDir += 360; w._windDirTarget += 360; }

    if (typeof physics === 'undefined' || !physics) return;

    // ── 風 ──
    physics.windSpeed = weatherWindSpeedFromBeaufort(w.beaufort);
    physics.windDir   = w.windDir;

    // ── 波 ──
    const hSig = weatherWaveHeightFromBeaufort(w.beaufort);

    // 波長。海が育つほど波長も伸びる（深海波の関係 L ≒ 1.56*T^2 に倣い、
    // 波高の平方根に比例させた緩やかな増加にする）。
    // 02側の自動急峻度カップリングが下限を保証するので、ここは見た目の
    // 「伸びやかさ」を足すだけ。
    physics.waveWidth = 0.7 + Math.sqrt(Math.max(0, hSig)) * 0.45;

    // うねりは遅れて追従するビューフォート数から、チョップは今の風から。
    const hSwell = weatherWaveHeightFromBeaufort(w.swellBeaufort);
    physics.swellStrength = Math.min(3.0, 0.35 + hSwell * 0.32);
    physics.chopStrength  = Math.min(3.0, 0.30 + w.beaufort * 0.16);

    // 全体の波の大きさ。今の風が立てる波に、嵐の後に残ったうねり（今の風より
    // 大きいぶん）を足し合わせたものを、実際の有義波高の目標にする。
    const hsTarget = Math.sqrt(hSig * hSig + Math.pow(Math.max(0, hSwell - hSig), 2));
    physics.waveRoughness = weatherRoughnessForHs(hsTarget, physics.swellStrength, physics.chopStrength);

    // ── 空の雲量 ──
    if (typeof skyMesh !== 'undefined' && skyMesh && skyMesh.material
        && skyMesh.material.uniforms && skyMesh.material.uniforms.cloudAmount) {
        skyMesh.material.uniforms.cloudAmount.value = w.cloud;
    }

    // ── 光量・視程 ──
    // 雲が厚いほど直射は弱く、代わりに空全体が光源になるので環境光の落ち方は
    // 直射よりずっと緩やかにする（曇天が真っ暗にならないように）。
    // 以前は環境光が最大18%しか落ちず、どんよりした空でも明るすぎた。
    // 厚い雲・雨ほど、空全体からの光も目に見えて暗くなるようにする。
    const gloom = Math.min(1, w.cloud * 0.8 + w.rain * 0.35);
    window.weatherLightMul.sun     = Math.max(0.05, 1 - w.cloud * 0.88 - w.rain * 0.1);
    window.weatherLightMul.ambient = 1 - gloom * 0.5;
    window.weatherLightMul.hemi    = 1 - gloom * 0.45;
    // 視程。霧は濃くなると数百m先がほとんど見えないところまで（霧の濃さの係数で
    // 最大およそ40倍）、雨も降りが強いほど霞む。
    window.weatherLightMul.fog     = w.haze * (1 + w.fog * 40 + w.rain * 5);
    // 霧・背景の色を灰色に寄せる割合と、海の色の暗さ（16-daynight-and-telegraph.js）
    window.weatherLightMul.grey      = Math.min(1, w.cloud * 0.45 + w.rain * 0.3 + w.fog * 0.8);
    window.weatherLightMul.waterDark = 1 - gloom * 0.45;

    // 既存の波スライダーの表示を実際の値に追従させる（天候が動かしていることが
    // 画面上で分かるように）。ユーザーが掴んでいる最中の要素には触らない。
    // DOM書き換えは毎フレームだと無駄なので4回/秒に間引く。
    if (t - (w._lastUiSync || -1) > 0.25) {
        w._lastUiSync = t;
        if (typeof syncWeatherDrivenSliders === 'function') syncWeatherDrivenSliders();
        if (typeof updateWeatherReadout === 'function') updateWeatherReadout();
        if (typeof _weatherSyncManualSliders === 'function') _weatherSyncManualSliders(false);
    }
}

// ════════════════════════════════════════════════════════════
//  UI
// ════════════════════════════════════════════════════════════
// 天候が風・波を握っている間は、既存の風・波スライダーは「天候が決めた値の
// 表示」になる（操作不能＋薄表示）。自分で個別に動かしたいときは
// 「天候で風・波を制御」を外す。
//
// 天候そのものを手で決める方法は2つ：
//   ・プリセットのボタン（凪〜嵐）
//   ・風力・雲量・風向のスライダー（細かく決める＝「カスタム」）
// どちらも操作した時点で「自動で移り変わる」を外す。外さないと、しばらく
// して自動変化に上書きされ、手で決めた天候が勝手に変わってしまうため。

// 天候が駆動する側のスライダー。id と physics のキーの対応。
const WEATHER_DRIVEN_SLIDERS = [
    { slider: 'roughness-slider', num: 'roughness-num', key: 'waveRoughness', base: 'roughness' },
    { slider: 'wavewidth-slider', num: 'wavewidth-num', key: 'waveWidth',     base: 'wavewidth' },
    { slider: 'swell-slider',     num: 'swell-num',     key: 'swellStrength', base: 'swell' },
    { slider: 'chop-slider',      num: 'chop-num',      key: 'chopStrength',  base: 'chop' },
    { slider: 'windspd-slider',   num: 'windspd-num',   key: 'windSpeed',     base: 'windspd', digits: 0 },
    { slider: 'winddir-slider',   num: 'winddir-num',   key: 'windDir',       base: 'winddir', digits: 0,
      toUi: (v) => ((Math.round(v) % 360) + 360) % 360 },
];

// 表示だけを実際の値に合わせる。setter は呼ばないので物理には影響しない。
// 入力中の要素（フォーカス中）は触らない。
function syncWeatherDrivenSliders() {
    for (const d of WEATHER_DRIVEN_SLIDERS) {
        let v = physics[d.key];
        if (typeof v !== 'number') continue;
        if (d.toUi) v = d.toUi(v);
        const txt = v.toFixed(d.digits != null ? d.digits : 2);
        const sl = document.getElementById(d.slider);
        const nm = document.getElementById(d.num);
        if (sl && document.activeElement !== sl) sl.value = txt;
        if (nm && document.activeElement !== nm) nm.value = txt;
    }
}

// 天候に握られている間、スライダーを操作不能＋薄表示にして
// 「今はここを触っても効かない」と分かるようにする。
function setWeatherDrivenSlidersDisabled(disabled) {
    for (const d of WEATHER_DRIVEN_SLIDERS) {
        for (const id of [d.slider, d.num, d.base + '-dec', d.base + '-inc']) {
            const el = document.getElementById(id);
            if (!el) continue;
            el.disabled = disabled;
            el.style.opacity = disabled ? '0.45' : '';
        }
    }
}

// メインループが updateWeather に渡すのと同じ時計の、今の時刻
function _weatherClockNow() {
    if (typeof clock !== 'undefined' && clock && clock.getElapsedTime) return clock.getElapsedTime();
    return (typeof window.weather._now === 'number') ? window.weather._now : 0;
}

// 手で天候を変えたときの共通処理：天候制御をON・自動変化をOFFにし、
// しばらく速い追従にする。
function _weatherTakeManualControl() {
    const w = window.weather;
    w._fastUntil = _weatherClockNow() + WEATHER_MANUAL_FAST_SEC;
    let changed = false;
    if (!w.enabled) { w.enabled = true; changed = true; }
    if (w.auto) { w.auto = false; changed = true; }
    if (changed) {
        const cbEnabled = document.getElementById('weather-enabled');
        const cbAuto = document.getElementById('weather-auto');
        if (cbEnabled) cbEnabled.checked = true;
        if (cbAuto) cbAuto.checked = false;
        setWeatherDrivenSlidersDisabled(true);
    }
}

function _weatherStop(el) {
    ['mousedown', 'touchstart', 'pointerdown'].forEach(ev => el.addEventListener(ev, e => e.stopPropagation()));
}

function renderWeatherPanel() {
    const w = window.weather;
    const host = document.getElementById('weather-presets');
    if (host) {
        const isCustom = w.presetKey === WEATHER_CUSTOM_KEY;
        host.innerHTML = WEATHER_PRESETS.concat(WEATHER_SPECIAL_PRESETS).map(p =>
            `<button type="button" class="adjust-btn wx-preset" data-wx="${p.key}"`
            + ` style="flex:1 1 auto;min-width:56px;width:auto;height:auto;font-size:11px;font-weight:normal;padding:4px 6px;white-space:nowrap;`
            + (p.key === w.presetKey ? 'background:#1c4a6e;border-color:#3fa9ff;color:#eaf4ff;' : '')
            + `">${p.label}</button>`
        ).join('')
        + `<span style="flex:1 1 auto;min-width:56px;font-size:11px;padding:4px 6px;text-align:center;white-space:nowrap;`
        + `border:1px dashed ${isCustom ? '#3fa9ff' : 'rgba(255,255,255,0.18)'};border-radius:4px;`
        + `color:${isCustom ? '#eaf4ff' : '#6f8799'};">カスタム</span>`;
        host.querySelectorAll('.wx-preset').forEach(btn => {
            btn.addEventListener('click', () => {
                _weatherTakeManualControl();
                window.weather.presetKey = btn.dataset.wx;
                // 風向は自然に振れる状態へ戻す（プリセットは風向を持たない）
                window.weather.custom.windDir = null;
                renderWeatherPanel();
                _weatherSyncManualSliders(true);
            });
            _weatherStop(btn);
        });
    }
    updateWeatherReadout();
}

// ── 手動スライダー（風力・雲量・風向）──
// 自動で移り変わっている間は「今の値」を、手で決めた（プリセット・カスタム）
// ときは「目標の値」を表示する。
function _weatherSyncManualSliders(force) {
    const w = window.weather;
    const custom = w.presetKey === WEATHER_CUSTOM_KEY;
    const tg = weatherTarget();
    // 自動で移り変わっている間は「今の値」、手で決めたときは「目標の値」を出す
    const showTarget = force || !w.auto;
    const bf = custom ? w.custom.beaufort : (showTarget ? tg.beaufort : w.beaufort);
    const cl = custom ? w.custom.cloud    : (showTarget ? tg.cloud    : w.cloud);
    const dir = (custom && w.custom.windDir != null) ? w.custom.windDir : ((Math.round(w.windDir) % 360) + 360) % 360;
    const set = (id, v) => { const el = document.getElementById(id); if (el && document.activeElement !== el) el.value = v; };
    const rn = custom ? (w.custom.rain || 0) : (showTarget ? (tg.rain || 0) : (w.rain || 0));
    const fg = custom ? (w.custom.fog || 0)  : (showTarget ? (tg.fog || 0)  : (w.fog || 0));
    set('weather-bf', bf.toFixed(1));
    set('weather-cloud', Math.round(cl * 100));
    set('weather-rain', Math.round(rn * 100));
    set('weather-fog', Math.round(fg * 100));
    set('weather-dir', Math.round(dir / 5) * 5);
    const kt = weatherWindSpeedFromBeaufort(bf) * 1.94384;
    const lab = (id, t) => { const el = document.getElementById(id); if (el) el.textContent = t; };
    lab('weather-bf-val', `BF${bf.toFixed(1)}（${kt.toFixed(0)}kt・波${weatherWaveHeightFromBeaufort(bf).toFixed(1)}m）`);
    lab('weather-cloud-val', `${Math.round(cl * 100)}%`);
    lab('weather-rain-val', rn < 0.02 ? 'なし' : (rn < 0.35 ? '小雨' : (rn < 0.75 ? '雨' : '大雨')) + ` ${Math.round(rn * 100)}%`);
    lab('weather-fog-val', fg < 0.02 ? 'なし' : (fg < 0.35 ? 'もや' : (fg < 0.7 ? '霧' : '濃霧')) + ` ${Math.round(fg * 100)}%`);
    lab('weather-dir-val', (custom && w.custom.windDir != null) ? `${Math.round(dir)}°` : `${Math.round(dir)}°（自然に変化）`);
}

function _weatherOnManualSlider(which, value) {
    const w = window.weather;
    // 初めてカスタムにするときは、今見えている天候から始める（急に飛ばない）
    if (w.presetKey !== WEATHER_CUSTOM_KEY) {
        const tg = weatherTarget();
        w.custom.beaufort = tg.beaufort;
        w.custom.cloud = tg.cloud;
        w.custom.rain = tg.rain || 0;
        w.custom.fog = tg.fog || 0;
        w.custom.windDir = null;
        w.presetKey = WEATHER_CUSTOM_KEY;
    }
    _weatherTakeManualControl();
    if (which === 'bf')    w.custom.beaufort = Math.max(0, Math.min(12, value));
    if (which === 'cloud') w.custom.cloud = Math.max(0, Math.min(1, value / 100));
    if (which === 'dir')   w.custom.windDir = ((value % 360) + 360) % 360;
    if (which === 'rain')  w.custom.rain = Math.max(0, Math.min(1, value / 100));
    if (which === 'fog')   w.custom.fog = Math.max(0, Math.min(1, value / 100));
    renderWeatherPanel();
    _weatherSyncManualSliders(false);
}

function updateWeatherReadout() {
    const el = document.getElementById('weather-readout');
    if (!el) return;
    const w = window.weather;
    if (!w.enabled) { el.textContent = '手動'; return; }
    // physics.windSpeed は次の updateWeather まで更新されないので、
    // 天候の今の風力から直接出す（「すぐ反映」直後も正しく表示するため）
    const kt = weatherWindSpeedFromBeaufort(w.beaufort) * 1.94384; // m/s → ノット
    const hSig = weatherWaveHeightFromBeaufort(w.beaufort);
    el.textContent = `BF${w.beaufort.toFixed(1)} / 風${kt.toFixed(0)}kt / 波${hSig.toFixed(1)}m`;
}

function initWeatherUI() {
    const w = window.weather;
    const cbEnabled = document.getElementById('weather-enabled');
    const cbAuto    = document.getElementById('weather-auto');
    if (cbEnabled) {
        cbEnabled.checked = w.enabled;
        cbEnabled.addEventListener('change', (e) => {
            w.enabled = e.target.checked;
            setWeatherDrivenSlidersDisabled(w.enabled);
            renderWeatherPanel();
        });
        _weatherStop(cbEnabled);
    }
    if (cbAuto) {
        cbAuto.checked = w.auto;
        cbAuto.addEventListener('change', (e) => {
            w.auto = e.target.checked;
            if (w.auto) {
                // 自動に戻したら、手で決めた風向の固定も解除し、すぐ次の変化へ
                w.custom.windDir = null;
                if (w.presetKey === WEATHER_CUSTOM_KEY) w.presetKey = weatherNearestPreset(w.beaufort).key;
                w._nextChangeAt = _weatherClockNow() + WEATHER_AUTO_MIN_SEC;
                renderWeatherPanel();
            }
        });
        _weatherStop(cbAuto);
    }

    [['weather-bf', 'bf'], ['weather-cloud', 'cloud'], ['weather-rain', 'rain'], ['weather-fog', 'fog'], ['weather-dir', 'dir']].forEach(([id, which]) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('input', (e) => _weatherOnManualSlider(which, parseFloat(e.target.value)));
        _weatherStop(el);
    });
    const nowBtn = document.getElementById('weather-apply-now');
    if (nowBtn) {
        nowBtn.addEventListener('click', () => {
            applyWeatherTargetNow();
            updateWeatherReadout();
            _weatherSyncManualSliders(true);
        });
        _weatherStop(nowBtn);
    }

    setWeatherDrivenSlidersDisabled(w.enabled);
    renderWeatherPanel();
    _weatherSyncManualSliders(true);
}
