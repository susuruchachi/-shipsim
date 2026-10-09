// 23-underwater.js — 水中視点の表現（減光・視界の狭まり・水中色）
//
// カメラが水面より下に入ったとき、「水の中にいる」と分かる見た目にする。
//   ・水の色に染まって暗くなる（深いほど暗い）
//   ・霧が濃くなって遠くが見えない＝視界が狭まる
//   ・画面周辺が暗く落ちる（ビネット）
//   ・空ドームを隠す（水中から空がそのまま見えていると台無しになる）
//
// 【設計方針】描画の直前に上書きし、描画の直後に元へ戻す
//   霧の色/濃さ・環境光・空の背景色は、16-daynight-and-telegraph.js の
//   updateDayNightCycle() が毎フレーム「今の値から目標値へ少しずつ寄せる」
//   形で更新している。水中の値を書き込んだままにすると、昼夜処理はその
//   水中の値から寄せ直すことになり、浮上してもなかなか元に戻らない
//   （しかも光の強さは毎フレーム掛け算が積み重なって、船が真っ黒になる）。
//   そこで updateUnderwater() は描画の直前に「水上での正しい値」を退避して
//   から水中の値を書き込み、描画が終わったら restoreUnderwaterOverrides() で
//   退避した値へ戻す。昼夜処理は常に水上の値だけを見るので、浮上した瞬間に
//   元どおりの見た目になる。
//
// 【ワールドスケールについて】
//   このアプリのワールド1単位はおおよそ1メートル（船の全長12単位 ×
//   physics.scale。Olympicなら 12×22.5≒270 でほぼ実寸）。
//   以下の距離・深度のしきい値はメートルのつもりで置いている。

// 水中の霧の色（浅い所＝やや明るい緑青、深い所＝ほぼ黒に近い青）
const UW_SHALLOW_COLOR = { r: 0.045, g: 0.150, b: 0.195 };
const UW_DEEP_COLOR    = { r: 0.004, g: 0.022, b: 0.045 };
// 霧の濃さ。FogExp2 は factor = 1 - exp(-(density*dist)^2) なので、
// density=0.03 で約30m先がほぼ霞む。澄んだ海〜やや濁った海の範囲。
const UW_FOG_DENSITY_SHALLOW = 0.030;
const UW_FOG_DENSITY_DEEP    = 0.075;
// この深さ[m]で「深い」側の値に到達する
const UW_DEPTH_FULL = 25.0;
// 水面をまたぐ時のブレンド幅[m]。波でカメラが出入りするときに
// パッと切り替わらないよう、この幅で滑らかに遷移させる。
const UW_SURFACE_BLEND = 0.35;

// 水中での光の減衰（深いほど暗い）
const UW_LIGHT_AT_SURFACE = 0.55; // 水面直下でも空気中より暗い
const UW_LIGHT_AT_DEPTH   = 0.12;

let _uwOverlay = null;      // ビネット/色かぶり用のDOM要素
let _uwActive  = false;
// 描画の直前に退避した「水上での値」（restoreUnderwaterOverrides で戻す）
let _uwSaved = null;

// 現在の水没度（0=完全に空中, 1=完全に水中）。他モジュールからも参照できるよう公開する。
window.underwaterAmount = 0;
window.underwaterDepth  = 0;

function _uwSmoothstep(edge0, edge1, x) {
    const t = Math.max(0, Math.min(1, (x - edge0) / Math.max(edge1 - edge0, 1e-6)));
    return t * t * (3 - 2 * t);
}

// ビネット＋色かぶりのオーバーレイ。
// ポストプロセス（EffectComposer）に手を入れず、DOMを1枚重ねるだけにしている。
// 既存のブルーム合成パイプラインに一切触らないので描画側の破綻リスクが無く、
// モバイルでも負荷がほぼ増えない。
function _uwEnsureOverlay() {
    if (_uwOverlay) return _uwOverlay;
    const el = document.createElement('div');
    el.id = 'underwaterOverlay';
    el.style.cssText = [
        'position:fixed', 'inset:0', 'pointer-events:none', 'z-index:5',
        'opacity:0', 'transition:opacity 0.12s linear',
    ].join(';');
    // 中心は薄く、周辺ほど濃く落とす＝視界が狭まって見える
    el.style.background =
        'radial-gradient(ellipse at 50% 50%,'
        + ' rgba(10,40,55,0.10) 0%,'
        + ' rgba(8,32,46,0.34) 45%,'
        + ' rgba(3,14,24,0.72) 78%,'
        + ' rgba(1,7,14,0.92) 100%)';
    document.body.appendChild(el);
    _uwOverlay = el;
    return el;
}

// 点 p（ワールド）が自分の船の船体の中（船底より上・主甲板より下で、その高さの船体の輪郭の内側）か。
// 船内の視点が喫水線より下にあっても、水中の見た目・こもった音にしない（浸水した区画の水の中は別）
const _uwEnds = { k0: 0, k1: 0, f: 0, sternAlong: 0, bowAlong: 0 }, _uwSpan = { lo: 0, hi: 0, tt: 0 };
function _uwHullLocal(p) {
    const hp = window.hullProfile, shape = hp && hp.shape;
    if (!hp || !hp.ready || !shape || !shape.ready || typeof physics === 'undefined' || typeof hullShapeEndsAtY !== 'function') return null;
    const S = Math.max(0.25, physics.scale || 1);
    const hRad = (physics.heading || 0) * Math.PI / 180;
    const tR = typeof _wakeAxisRad === 'function' ? _wakeAxisRad(hRad) : hRad;
    const o = typeof _hullOriginWorld === 'function' ? _hullOriginWorld(physics.cgWorldX, physics.cgWorldZ, tR, S) : { x: physics.cgWorldX, z: physics.cgWorldZ };
    const sn = Math.sin(tR), cs = Math.cos(tR), dx = p.x - o.x, dz = p.z - o.z;
    const alongW = dx * sn + dz * cs, perpW = dx * cs - dz * sn;
    const sinP = Math.sin(physics.pitch || 0), cosP = Math.cos(physics.pitch || 0), sinR = Math.sin(physics.roll || 0);
    const originY = (physics.y || 0) - (physics.waterlineOffsetY || 0) * S;
    // 04-scene-and-water-init.js の updateHullWaterlinePolygon と同じ高さの式を、船体の座標の高さについて解いたもの
    const y = (p.y - originY + alongW * sinP - perpW * sinR * cosP) / S;
    return { a: alongW / S, p: perpW / S, y };
}
function _uwInsideHull(p) {
    const L = _uwHullLocal(p); if (!L) return null;
    const hp = window.hullProfile, shape = hp.shape;
    if (Number.isFinite(hp.deckY) && L.y > hp.deckY) return null;
    if (L.y < shape.levelY[shape.kFirst]) return null;
    hullShapeEndsAtY(shape, L.y, _uwEnds);
    if (!(L.a > _uwEnds.sternAlong && L.a < _uwEnds.bowAlong)) return null;
    const u = (L.a - _uwEnds.sternAlong) / Math.max(1e-6, _uwEnds.bowAlong - _uwEnds.sternAlong);
    return Math.abs(L.p) < hullShapeHwAtU(shape, _uwEnds.k0, _uwEnds.k1, _uwEnds.f, u, _uwSpan) ? L : null;
}
// 船の中の点 L が、浸水した区画の水の中か（63-flooding.js）
function _uwInFloodWater(L) {
    if (typeof flood === 'undefined' || !flood.comps || !flood.comps.length || typeof _flCompAt !== 'function' || typeof _flState !== 'function') return false;
    const sc3 = Math.pow(physics.scale || 1, 3);
    for (const db of [false, true]) {
        const i = _flCompAt(L.a, L.p, L.y, db);
        const c = i >= 0 ? flood.comps[i] : null;
        if (c && c.vol > 0 && L.y >= c.y0 - 0.01 && L.y <= (c.y1 !== undefined ? c.y1 : Infinity) && _flState(c, sc3).y > L.y) return true;
    }
    return false;
}
window.cameraInsideHull = () => (typeof camera !== 'undefined' && camera) ? !!_uwInsideHull(camera.position) : false;

// 毎フレーム呼ぶ。updateDayNightCycle() より後、描画より前。
function updateUnderwater(t) {
    _uwSaved = null;
    if (typeof scene === 'undefined' || !scene || typeof camera === 'undefined' || !camera) return;

    const cam = camera;
    // カメラ位置での水面の高さ（引き波込み）
    const surfaceY = (typeof getWaveHeight === 'function')
        ? getWaveHeight(cam.position.x, cam.position.z, t, true)
        : 0;
    const depth = surfaceY - cam.position.y;   // 正なら水中

    // 船体設定（設定パネルを開いている間）は、船底を下から確認することが
    // あるので水中表現を出さない。
    const panel = document.getElementById('settings-panel');
    const designMode = !!(panel && panel.classList.contains('open'));

    // 水面をまたぐ所をぼかす。波で±数cm出入りしても点滅しない。
    let amount = designMode ? 0 : _uwSmoothstep(-UW_SURFACE_BLEND, UW_SURFACE_BLEND, depth);
    // 船の中（喫水線より下の船内）は水の中ではない。浸水した区画の水の中だけ水中の見た目・音にする
    if (amount > 0.001) {
        const L = _uwInsideHull(cam.position);
        if (L && !_uwInFloodWater(L)) amount = 0;
    }
    window.underwaterAmount = amount;
    window.underwaterDepth  = Math.max(0, depth);

    if (amount <= 0.001) {
        if (_uwActive) {
            // 浮上した瞬間の後始末。色や霧はupdateDayNightCycleが毎フレーム
            // 目標値へ寄せているので、ここで戻す必要があるのは自前の要素だけ。
            if (_uwOverlay) _uwOverlay.style.opacity = '0';
            if (typeof skyMesh !== 'undefined' && skyMesh) skyMesh.visible = true;
            if (typeof waterMesh !== 'undefined' && waterMesh && waterMesh.material
                && waterMesh.material.side !== THREE.FrontSide) {
                waterMesh.material.side = THREE.FrontSide;
                waterMesh.material.needsUpdate = true;
            }
            _uwActive = false;
        }
        return;
    }
    _uwActive = true;

    // ── 水上での値を退避（描画後に restoreUnderwaterOverrides で戻す）──
    _uwSaved = {
        fogDensity: scene.fog ? scene.fog.density : null,
        fogColor: scene.fog ? scene.fog.color.clone() : null,
        background: (scene.background && scene.background.isColor) ? scene.background.clone() : null,
        sun:     (typeof sunLight !== 'undefined' && sunLight) ? sunLight.intensity : null,
        ambient: (typeof ambientLight !== 'undefined' && ambientLight) ? ambientLight.intensity : null,
        hemi:    (typeof hemiLight !== 'undefined' && hemiLight) ? hemiLight.intensity : null,
        fill:    (typeof fillLight !== 'undefined' && fillLight) ? fillLight.intensity : null,
    };

    // 深度の正規化（0=水面直下, 1=UW_DEPTH_FULL以深）
    const dn = _uwSmoothstep(0, UW_DEPTH_FULL, Math.max(0, depth));

    // ── 水の色 ──
    const wr = UW_SHALLOW_COLOR.r + (UW_DEEP_COLOR.r - UW_SHALLOW_COLOR.r) * dn;
    const wg = UW_SHALLOW_COLOR.g + (UW_DEEP_COLOR.g - UW_SHALLOW_COLOR.g) * dn;
    const wb = UW_SHALLOW_COLOR.b + (UW_DEEP_COLOR.b - UW_SHALLOW_COLOR.b) * dn;

    // 夜は水中もさらに暗い。updateDayNightCycleが決めた今の環境光の強さを
    // 「明るさの指標」として借りることで、時刻との整合が自動的に取れる。
    let daylight = 1.0;
    if (typeof ambientLight !== 'undefined' && ambientLight) {
        // 昼の環境光を0.35程度と見込んで正規化（下限を残して真っ暗にはしない）
        daylight = Math.max(0.15, Math.min(1, ambientLight.intensity / 0.35));
    }

    // ── 霧（＝視界の狭まりと減光の主役）──
    if (scene.fog) {
        const density = UW_FOG_DENSITY_SHALLOW
            + (UW_FOG_DENSITY_DEEP - UW_FOG_DENSITY_SHALLOW) * dn;
        // amountで空中の値から補間する。水面をまたぐ間も連続的に変化する。
        const airDensity = scene.fog.density;
        scene.fog.density = airDensity + (density - airDensity) * amount;
        scene.fog.color.setRGB(
            scene.fog.color.r + (wr * daylight - scene.fog.color.r) * amount,
            scene.fog.color.g + (wg * daylight - scene.fog.color.g) * amount,
            scene.fog.color.b + (wb * daylight - scene.fog.color.b) * amount
        );
    }

    // ── 背景色 ──
    // 空ドームを隠すので、見上げたときに見えるのはこの背景色になる。
    if (scene.background && scene.background.isColor) {
        scene.background.setRGB(
            scene.background.r + (wr * daylight - scene.background.r) * amount,
            scene.background.g + (wg * daylight - scene.background.g) * amount,
            scene.background.b + (wb * daylight - scene.background.b) * amount
        );
    }

    // ── 空ドームを隠す ──
    // 水中から空がそのまま見えていると一気に嘘っぽくなる。完全に潜ってから隠す。
    if (typeof skyMesh !== 'undefined' && skyMesh) skyMesh.visible = (amount < 0.75);

    // ── 光の減衰 ──
    // 水中は空気中より暗く、深いほど暗い。太陽・環境光・半球光をまとめて落とす。
    const lightMul = 1 - (1 - (UW_LIGHT_AT_SURFACE + (UW_LIGHT_AT_DEPTH - UW_LIGHT_AT_SURFACE) * dn)) * amount;
    if (typeof sunLight !== 'undefined' && sunLight)         sunLight.intensity *= lightMul;
    if (typeof ambientLight !== 'undefined' && ambientLight) ambientLight.intensity *= lightMul;
    if (typeof hemiLight !== 'undefined' && hemiLight)       hemiLight.intensity *= lightMul;
    if (typeof fillLight !== 'undefined' && fillLight)       fillLight.intensity *= lightMul;

    // ── 水面を下から見えるようにする ──
    // 水面メッシュの材質は既定の FrontSide なので、水中から見上げても
    // 裏面カリングで消えてしまい、天井がぽっかり抜けて見える。
    // 潜っている間だけ両面描画にして、水面の裏側が見えるようにする。
    if (typeof waterMesh !== 'undefined' && waterMesh && waterMesh.material) {
        const wantSide = (amount > 0.5) ? THREE.DoubleSide : THREE.FrontSide;
        if (waterMesh.material.side !== wantSide) {
            waterMesh.material.side = wantSide;
            waterMesh.material.needsUpdate = true; // sideの変更はシェーダー再コンパイルが要る
        }
    }

    // ── ビネット ──
    const el = _uwEnsureOverlay();
    el.style.opacity = String((0.45 + 0.45 * dn) * amount);
}

// 描画の直後に呼ぶ（17-main-loop.js）。updateUnderwater() が描画のために
// 書き換えた霧・背景・光の強さを、水上での値へ戻す。
function restoreUnderwaterOverrides() {
    const sv = _uwSaved;
    if (!sv) return;
    _uwSaved = null;
    if (scene.fog && sv.fogColor) { scene.fog.density = sv.fogDensity; scene.fog.color.copy(sv.fogColor); }
    if (sv.background && scene.background && scene.background.isColor) scene.background.copy(sv.background);
    if (sv.sun !== null)     sunLight.intensity = sv.sun;
    if (sv.ambient !== null) ambientLight.intensity = sv.ambient;
    if (sv.hemi !== null)    hemiLight.intensity = sv.hemi;
    if (sv.fill !== null)    fillLight.intensity = sv.fill;
}
