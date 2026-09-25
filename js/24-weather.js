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

// 有義波高[m] → physics.waveRoughness への換算係数。
// 02-utils-and-wave-physics.js の合成式では、波面の山から谷までの振れ幅が
// おおよそ waveRoughness の5.3倍になる。ただしここは物理的な厳密さより
// 「見た目の据わり」を優先した補正で、既定値 waveRoughness=1.0 が
// ビューフォート5（有義波高2m）相当に見えるように 0.5 としている。
const WEATHER_WAVE_ROUGHNESS_PER_METER = 0.5;

// 天候プリセット。severity は 0(穏やか)〜1(大時化) の目安で、
// 自動変化のランダムウォークはこの並び順の上を歩く。
const WEATHER_PRESETS = [
    { key: 'calm',   label: '凪',       beaufort: 1.0, cloud: 0.06, haze: 0.7 },
    { key: 'fair',   label: '晴れ',     beaufort: 3.0, cloud: 0.22, haze: 0.85 },
    { key: 'breezy', label: 'やや波あり', beaufort: 5.0, cloud: 0.45, haze: 1.0 },
    { key: 'rough',  label: '荒れ模様',  beaufort: 7.0, cloud: 0.78, haze: 1.7 },
    { key: 'gale',   label: '時化',     beaufort: 9.0, cloud: 0.92, haze: 2.6 },
    { key: 'storm',  label: '嵐',       beaufort: 11.0, cloud: 0.98, haze: 3.8 },
];

// 各量の追従の速さ[1/秒]。天候そのものは分単位でゆっくり動き、
// チョップは風にすぐ、うねりはかなり遅れてついてくる。
const WEATHER_TAU_CONDITION = 1 / 25;  // 天候の遷移（約25秒で入れ替わる）
const WEATHER_TAU_CHOP      = 1 / 6;   // チョップ（約6秒）
const WEATHER_TAU_SWELL     = 1 / 70;  // うねり（約70秒。風が止んでも残る）

// 自動変化で次の天候を選ぶ間隔[秒]の範囲
const WEATHER_AUTO_MIN_SEC = 90;
const WEATHER_AUTO_MAX_SEC = 260;

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
};

// 16-daynight-and-telegraph.js が参照する光量・霧の倍率
window.weatherLightMul = { sun: 1, ambient: 1, hemi: 1, fog: 1 };

function weatherPresetByKey(key) {
    return WEATHER_PRESETS.find(p => p.key === key) || WEATHER_PRESETS[2];
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
    const idx = Math.max(0, WEATHER_PRESETS.findIndex(p => p.key === currentKey));
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
    const p = weatherPresetByKey(key);
    w.presetKey = p.key;
    if (opts && opts.immediate) {
        w.beaufort = p.beaufort;
        w.swellBeaufort = p.beaufort;
        w.cloud = p.cloud;
        w.haze = p.haze;
    }
    if (typeof renderWeatherPanel === 'function') renderWeatherPanel();
}

// 毎フレーム呼ぶ。dt[秒]、t[秒]。
function updateWeather(dt, t) {
    const w = window.weather;
    if (!w) return;
    dt = Math.max(0, Math.min(dt || 0, 0.25)); // 一時停止明けの巨大なdtで飛ばないように

    if (!w._initialized) {
        const p = weatherPresetByKey(w.presetKey);
        w.beaufort = p.beaufort; w.swellBeaufort = p.beaufort;
        w.cloud = p.cloud; w.haze = p.haze;
        w._nextChangeAt = t + WEATHER_AUTO_MIN_SEC;
        w._initialized = true;
    }

    if (!w.enabled) {
        // 天候OFF。光量・雲量の上書きも解除して、手動スライダーに完全に任せる。
        window.weatherLightMul.sun = 1; window.weatherLightMul.ambient = 1;
        window.weatherLightMul.hemi = 1; window.weatherLightMul.fog = 1;
        return;
    }

    // ── 目標天候の決定 ──
    if (w.auto && t >= w._nextChangeAt) {
        w.presetKey = weatherPickNextPreset(w.presetKey);
        w._nextChangeAt = t + WEATHER_AUTO_MIN_SEC
            + Math.random() * (WEATHER_AUTO_MAX_SEC - WEATHER_AUTO_MIN_SEC);
        if (typeof renderWeatherPanel === 'function') renderWeatherPanel();
    }
    const target = weatherPresetByKey(w.presetKey);

    // ── 現在値を目標へ寄せる ──
    w.beaufort = weatherApproach(w.beaufort, target.beaufort, WEATHER_TAU_CONDITION, dt);
    w.cloud    = weatherApproach(w.cloud,    target.cloud,    WEATHER_TAU_CONDITION, dt);
    w.haze     = weatherApproach(w.haze,     target.haze,     WEATHER_TAU_CONDITION, dt);
    // うねりは風よりずっと遅れて追従する（風が止んでも残り、吹き始めてもすぐには育たない）
    w.swellBeaufort = weatherApproach(w.swellBeaufort, w.beaufort, WEATHER_TAU_SWELL, dt);

    // ── 風向 ──
    // 普段はゆっくり振れるだけ。荒れているときほど振れ幅が大きい。
    if (t >= (w._nextDirChangeAt || 0)) {
        const swing = 12 + w.beaufort * 6;          // 荒天ほど大きく振れる
        w._windDirTarget = w.windDir + (Math.random() - 0.5) * 2 * swing;
        w._nextDirChangeAt = t + 20 + Math.random() * 40;
    }
    w.windDir = weatherApproach(w.windDir, w._windDirTarget, 1 / 30, dt);
    // -180〜180に正規化（延々と増え続けないように）
    while (w.windDir > 180)  { w.windDir -= 360; w._windDirTarget -= 360; }
    while (w.windDir < -180) { w.windDir += 360; w._windDirTarget += 360; }

    if (typeof physics === 'undefined' || !physics) return;

    // ── 風 ──
    physics.windSpeed = weatherWindSpeedFromBeaufort(w.beaufort);
    physics.windDir   = w.windDir;

    // ── 波 ──
    const hSig = weatherWaveHeightFromBeaufort(w.beaufort);
    physics.waveRoughness = hSig * WEATHER_WAVE_ROUGHNESS_PER_METER;

    // 波長。海が育つほど波長も伸びる（深海波の関係 L ≒ 1.56*T^2 に倣い、
    // 波高の平方根に比例させた緩やかな増加にする）。
    // 02側の自動急峻度カップリングが下限を保証するので、ここは見た目の
    // 「伸びやかさ」を足すだけ。
    physics.waveWidth = 0.7 + Math.sqrt(Math.max(0, hSig)) * 0.45;

    // うねりは遅れて追従するビューフォート数から、チョップは今の風から。
    const hSwell = weatherWaveHeightFromBeaufort(w.swellBeaufort);
    physics.swellStrength = Math.min(3.0, 0.35 + hSwell * 0.32);
    physics.chopStrength  = Math.min(3.0, 0.30 + w.beaufort * 0.16);

    // ── 空の雲量 ──
    if (typeof skyMesh !== 'undefined' && skyMesh && skyMesh.material
        && skyMesh.material.uniforms && skyMesh.material.uniforms.cloudAmount) {
        skyMesh.material.uniforms.cloudAmount.value = w.cloud;
    }

    // ── 光量・視程 ──
    // 雲が厚いほど直射は弱く、代わりに空全体が光源になるので環境光の落ち方は
    // 直射よりずっと緩やかにする（曇天が真っ暗にならないように）。
    window.weatherLightMul.sun     = 1 - w.cloud * 0.78;
    window.weatherLightMul.ambient = 1 - w.cloud * 0.18;
    window.weatherLightMul.hemi    = 1 - w.cloud * 0.12;
    window.weatherLightMul.fog     = w.haze;

    // 既存の波スライダーの表示を実際の値に追従させる（天候が動かしていることが
    // 画面上で分かるように）。ユーザーが掴んでいる最中の要素には触らない。
    // DOM書き換えは毎フレームだと無駄なので4回/秒に間引く。
    if (t - (w._lastUiSync || -1) > 0.25) {
        w._lastUiSync = t;
        if (typeof syncWeatherDrivenSliders === 'function') syncWeatherDrivenSliders();
        if (typeof updateWeatherReadout === 'function') updateWeatherReadout();
    }
}

// ════════════════════════════════════════════════════════════
//  UI
// ════════════════════════════════════════════════════════════
// 天候が風・波を握っている間は、既存の波スライダーは「天候が決めた値の表示」に
// なる。ユーザーが自分で動かしたいときは「天候で風・波を制御」を外す。
// 勝手にOFFに切り替えたりはしない（意図せず制御が移ると分かりにくいため）。

// 天候が駆動する側のスライダー。id と physics のキーの対応。
const WEATHER_DRIVEN_SLIDERS = [
    { slider: 'roughness-slider', num: 'roughness-num', key: 'waveRoughness' },
    { slider: 'wavewidth-slider', num: 'wavewidth-num', key: 'waveWidth' },
    { slider: 'swell-slider',     num: 'swell-num',     key: 'swellStrength' },
    { slider: 'chop-slider',      num: 'chop-num',      key: 'chopStrength' },
];

// 表示だけを実際の値に合わせる。setter は呼ばないので物理には影響しない。
// 入力中の要素（フォーカス中）は触らない。
function syncWeatherDrivenSliders() {
    for (const d of WEATHER_DRIVEN_SLIDERS) {
        const v = physics[d.key];
        if (typeof v !== 'number') continue;
        const sl = document.getElementById(d.slider);
        const nm = document.getElementById(d.num);
        if (sl && document.activeElement !== sl) sl.value = v.toFixed(2);
        if (nm && document.activeElement !== nm) nm.value = v.toFixed(2);
    }
}

// 天候に握られている間、波スライダーを操作不能＋薄表示にして
// 「今はここを触っても効かない」と分かるようにする。
function setWeatherDrivenSlidersDisabled(disabled) {
    for (const d of WEATHER_DRIVEN_SLIDERS) {
        for (const id of [d.slider, d.num]) {
            const el = document.getElementById(id);
            if (!el) continue;
            el.disabled = disabled;
            el.style.opacity = disabled ? '0.45' : '';
        }
    }
    // ± ボタンも同様に
    for (const base of ['roughness', 'wavewidth', 'swell', 'chop']) {
        for (const sfx of ['-dec', '-inc']) {
            const el = document.getElementById(base + sfx);
            if (!el) continue;
            el.disabled = disabled;
            el.style.opacity = disabled ? '0.45' : '';
        }
    }
}

function renderWeatherPanel() {
    const w = window.weather;
    const host = document.getElementById('weather-presets');
    if (host) {
        host.innerHTML = WEATHER_PRESETS.map(p =>
            `<button type="button" class="adjust-btn wx-preset" data-wx="${p.key}"`
            + ` style="flex:1 1 auto;min-width:56px;font-size:11px;padding:4px 6px;`
            + (p.key === w.presetKey ? 'background:#1c4a6e;border-color:#3fa9ff;color:#eaf4ff;' : '')
            + `">${p.label}</button>`
        ).join('');
        host.querySelectorAll('.wx-preset').forEach(btn => {
            btn.addEventListener('click', () => {
                window.weather.presetKey = btn.dataset.wx;
                // 手でプリセットを選んだら、その直後に自動変化が上書きしないよう
                // 次の自動変化までの時間をリセットする
                window.weather._nextChangeAt = (typeof clock !== 'undefined' ? clock.getElapsedTime() : 0)
                    + WEATHER_AUTO_MIN_SEC;
                renderWeatherPanel();
            });
            btn.addEventListener('mousedown', e => e.stopPropagation());
            btn.addEventListener('touchstart', e => e.stopPropagation());
        });
    }
    updateWeatherReadout();
}

function updateWeatherReadout() {
    const el = document.getElementById('weather-readout');
    if (!el) return;
    const w = window.weather;
    if (!w.enabled) { el.textContent = '手動'; return; }
    const kt = (physics.windSpeed || 0) * 1.94384; // m/s → ノット
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
        cbEnabled.addEventListener('mousedown', e => e.stopPropagation());
    }
    if (cbAuto) {
        cbAuto.checked = w.auto;
        cbAuto.addEventListener('change', (e) => { w.auto = e.target.checked; });
        cbAuto.addEventListener('mousedown', e => e.stopPropagation());
    }
    setWeatherDrivenSlidersDisabled(w.enabled);
    renderWeatherPanel();
}
