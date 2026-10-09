function changeTelegraph(dir) {
    const prev = physics.telegraphState;
    physics.telegraphState = Math.max(-3, Math.min(3, physics.telegraphState + dir));
    // ベルを鳴らし、機関室の応答を待つ（37-bridge-controls.js）
    if (typeof onTelegraphOrder === 'function') onTelegraphOrder(prev, physics.telegraphState);
}

function onWindowResize() {
    const aspect = window.innerWidth / window.innerHeight;
    if (perspCamera) {
        perspCamera.aspect = aspect;
        perspCamera.updateProjectionMatrix();
    }
    if (orthoCamera) {
        // orthoHalfHeight（縦方向の半サイズ）は維持しつつ、横幅だけアスペクト比に合わせて再計算する
        orthoCamera.left = -orthoHalfHeight * aspect;
        orthoCamera.right = orthoHalfHeight * aspect;
        orthoCamera.updateProjectionMatrix();
    }
    renderer.setSize(window.innerWidth, window.innerHeight);
    if (bloomComposer) bloomComposer.setSize(window.innerWidth, window.innerHeight);
    if (typeof resizeWaterReflectionRT === 'function') resizeWaterReflectionRT(aspect);
}

function smoothstep(edge0, edge1, x) {
    const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
}

// 窓・キャビンのemissive発光を昼夜係数(0=消灯,1=フル点灯)とユーザー設定の強さに応じてスケールする
function updateWindowGlow(factor) {
    const eff = factor * lightSettings.windowGlowMult;
    windowGlowMaterials.forEach((mat) => {
        mat.emissiveIntensity = mat.userData.baseEmissiveIntensity * eff;
    });
    // 発光パネル（窓・灯具を面光源として扱うもの、26-glow-emitters.js）の明るさも
    // 同じ係数で連動させる。windowGlowMultスライダーで、窓の輝きと周囲を照らす
    // 光が同時に変わる。
    if (typeof setAreaLightGlowFactor === 'function') setAreaLightGlowFactor(eff);
    // 船内全体をほんのり底上げする環境光プローブ。SH係数（分布の形）は
    // 組み立て時に焼き込み済みなので、ここでは全体の強さだけを書き換える。
    if (windowGlowLightProbe) windowGlowLightProbe.intensity = 1.2 * eff;
}

function updateDayNightCycle(dayProgress) {
    const sunAngle = dayProgress * Math.PI * 2 - Math.PI * 0.5;
    const tilt = 0.4; 
    const sunDistance = 400;

    // 世界の座標は +x が西（43-world.js）。東から昇って南を通り、西へ沈むよう、x は -cos
    const sunX = -Math.cos(sunAngle) * sunDistance;
    const sunY = Math.sin(sunAngle) * sunDistance * Math.cos(tilt);
    const sunZ = -Math.sin(sunAngle) * sunDistance * Math.sin(tilt);

    const sunPos = new THREE.Vector3(sunX, sunY, sunZ);

    // 月の位置は太陽との位相差（月齢）で決まる。
    // moonPhase=0→新月(太陽と同方向), 0.5→満月(太陽の反対側)
    // 月は太陽より「遅れて」公転するので、moonPhaseが増えるほど太陽より後方（西）へ移動する
    const moonAngle = sunAngle - physics.moonPhase * Math.PI * 2;
    const moonX = -Math.cos(moonAngle) * sunDistance;
    const moonY = Math.sin(moonAngle) * sunDistance * Math.cos(tilt);
    const moonZ = -Math.sin(moonAngle) * sunDistance * Math.sin(tilt);
    const moonPos = new THREE.Vector3(moonX, moonY, moonZ);

    let lightIntensity = 0.0;
    let lightColor = new THREE.Color();
    let background = new THREE.Color();
    let fogColor = new THREE.Color();
    let activeLightPos = new THREE.Vector3();
    let isNight = sunY < 0;

    // 窓emissive・GLBライト自動モード用の昼夜係数（1=夜=点灯 〜 0=昼=消灯）。
    // 日の出/日の入り前後でなめらかに切り替わるようsmoothstep+lerpで遷移させる。
    const sunElevRatio = sunY / sunDistance;
    const targetNightFactor = 1 - smoothstep(-0.05, 0.12, sunElevRatio);
    lightingNightFactor += (targetNightFactor - lightingNightFactor) * 0.05;
    updateWindowGlow(lightingNightFactor);
    applyGlbLightIntensities();

    const moonPhaseFactor = Math.sin(physics.moonPhase * Math.PI);

    let ambientIntensity = 0.0;
    let hemiIntensity = 0.0;

    if (!isNight) {
        activeLightPos.copy(sunPos);
        const sunHeightRatio = sunY / sunDistance; 
        
        if (sunHeightRatio < 0.15) {
            const t = Math.max(0.0, sunHeightRatio / 0.15);
            lightIntensity = 0.2 + t * 1.0;
            lightColor.setRGB(1.0, 0.4 + t * 0.56, 0.15 + t * 0.7); 
            background.setRGB(0.4 * t + 0.35 * (1-t), 0.55 * t + 0.2 * (1-t), 0.75 * t + 0.15 * (1-t));
            fogColor.copy(background);
            ambientIntensity = 0.15 + t * 0.35;
            hemiIntensity = 0.2 + t * 0.6;
        } else {
            lightIntensity = 1.2;
            lightColor.setRGB(1.0, 0.96, 0.85);
            background.setRGB(0.45, 0.60, 0.80);
            fogColor.setRGB(0.55, 0.70, 0.85);
            ambientIntensity = 0.5;
            hemiIntensity = 0.8;
        }
    } else {
        activeLightPos.copy(moonPos);
        const moonY = moonPos.y;
        const moonHeightRatio = moonY / sunDistance;
        const baseMoonIntensity = 0.25 * moonPhaseFactor;
        
        // Moon above horizon: full light; below horizon: fade out quickly
        const moonAbove = smoothstep(-0.05, 0.08, moonHeightRatio);
        lightIntensity = baseMoonIntensity * moonAbove;
        const mc = baseMoonIntensity * 4 * moonAbove;
        lightColor.setRGB(0.35 * mc, 0.45 * mc, 0.65 * mc);
        const bgBright = 0.01 + 0.04 * moonPhaseFactor * moonAbove;
        background.setRGB(bgBright, bgBright * 1.5, bgBright * 3.0);
        fogColor.copy(background);
        ambientIntensity = 0.04 + 0.08 * moonPhaseFactor * moonAbove;
        hemiIntensity = 0.03 + 0.12 * moonPhaseFactor * moonAbove;
    }

    if (!sunLight.userData.currentPos) sunLight.userData.currentPos = activeLightPos.clone();
    sunLight.userData.currentPos.lerp(activeLightPos, 0.03);
    sunLight.position.copy(sunLight.userData.currentPos);
    // v170: 天候による減光。時刻で決まる明るさに掛け算することで、
    // 「曇りの朝」「快晴の夕方」が自然に両立する（どちらか一方が
    // もう一方を上書きしてしまわない）。
    const wxMul = window.weatherLightMul || { sun: 1, ambient: 1, hemi: 1, fog: 1, grey: 0, waterDark: 1 };
    // 曇天・雨・霧では、空と霧の色を灰色へ寄せ、少し暗くする（青空の色のまま
    // 暗くなるだけだと、どんよりした天気に見えないため）
    if (wxMul.grey > 0.001) {
        const g = wxMul.grey;
        for (const c of [fogColor, background]) {
            const l = (c.r * 0.3 + c.g * 0.55 + c.b * 0.15) * (1 - g * 0.35);
            c.setRGB(c.r + (l - c.r) * g, c.g + (l - c.g) * g, c.b + (l * 1.04 - c.b) * g);
        }
    }
    sunLight.intensity += (lightIntensity * lightSettings.sunMult * wxMul.sun - sunLight.intensity) * 0.05;
    sunLight.color.lerp(lightColor, 0.05);
    scene.background.lerp(background, 0.05);
    scene.fog.color.lerp(fogColor, 0.05);
    // 荒天ほど視程が落ちる（しぶき・降水・もやで霞む）
    const targetFogDensity = (isNight ? 0.00015 : 0.00025) * lightSettings.fogMult * wxMul.fog;
    scene.fog.density += (targetFogDensity - scene.fog.density) * 0.02;

    ambientLight.intensity += (ambientIntensity * lightSettings.ambientMult * wxMul.ambient - ambientLight.intensity) * 0.05;
    hemiLight.intensity += (hemiIntensity * lightSettings.hemiMult * wxMul.hemi - hemiLight.intensity) * 0.05;
    if (fillLight) {
        const targetFill = lightIntensity * 0.3 * lightSettings.fillMult;
        fillLight.intensity += (targetFill - fillLight.intensity) * 0.05;
    }

    if (waterMesh && waterMesh.material.uniforms) {
        waterMesh.material.uniforms.sunDir.value.copy(activeLightPos).sub(camera.position).normalize();
        waterMesh.material.uniforms.sunColor.value.copy(sunLight.color);

        const u = waterMesh.material.uniforms;
        if (!isNight) {
            const sunH = Math.max(0, sunY / sunDistance);
            const t = Math.min(sunH / 0.15, 1.0);
            u.deepColor.value.setRGB(
                0.01 + (1 - t) * 0.06,
                0.06 + t * 0.06,
                0.18 + t * 0.04
            );
            u.shallowColor.value.setRGB(
                0.03 + (1 - t) * 0.12,
                0.28 * (0.5 + t * 0.5),
                0.42 * (0.5 + t * 0.5)
            );
            u.foamColor.value.setRGB(0.92, 0.97, 1.00);
        } else {
            const b = 0.005 + 0.03 * moonPhaseFactor;
            u.deepColor.value.setRGB(b * 0.5, b * 0.8, b * 2.0);
            u.shallowColor.value.setRGB(b * 1.0, b * 2.0, b * 4.5);
            u.foamColor.value.setRGB(0.3 + moonPhaseFactor * 0.3, 0.35 + moonPhaseFactor * 0.35, 0.4 + moonPhaseFactor * 0.4);
        }
        // 水面に映る空の色：水平線の近くの空（05-sky-dome.js と同じ昼・朝夕・夜の混ぜ方）。以前は昼の空色のままで、
        // 夕方や夜に、遠くの海（斜めに見るので空がよく映る）だけ明るい青に見えていた
        if (u.skyReflColor) {
            const sh = sunY / sunDistance, ss = (a, b, x) => { const k = Math.max(0, Math.min(1, (x - a) / (b - a))); return k * k * (3 - 2 * k); };
            const dayF = ss(-0.18, 0.18, sh), dawnF = ss(-0.25, 0.0, sh) * (1 - ss(0.0, 0.25, sh));
            const mb = 0.6 + 0.8 * moonPhaseFactor;
            const nr = 0.010 * mb, ng = 0.016 * mb, nb = 0.040 * mb;
            const r0 = nr + (0.42 - nr) * dawnF, g0 = ng + (0.26 - ng) * dawnF, b0 = nb + (0.16 - nb) * dawnF;
            u.skyReflColor.value.setRGB(r0 + (0.30 - r0) * dayF, g0 + (0.52 - g0) * dayF, b0 + (0.82 - b0) * dayF);
        }
        // 曇天・荒天では海の色も暗く沈む
        const wd = (typeof wxMul.waterDark === 'number') ? wxMul.waterDark : 1;
        if (wd < 0.999) {
            if (u.skyReflColor) u.skyReflColor.value.multiplyScalar(wd);
            u.deepColor.value.multiplyScalar(wd);
            u.shallowColor.value.multiplyScalar(wd);
            u.foamColor.value.multiplyScalar(0.55 + 0.45 * wd);
        }
    }
    if (skyMesh && skyMesh.material.uniforms) {
        skyMesh.material.uniforms.dayProgress.value = dayProgress;
        skyMesh.material.uniforms.sunDirection.value.copy(sunPos).normalize();
        skyMesh.material.uniforms.moonDirection.value.copy(moonPos).normalize();
        skyMesh.material.uniforms.moonPhase.value = physics.moonPhase;
    }
}


// ════════════════════════════════════════════════════════════════
//  暦（日付）と月齢
// ════════════════════════════════════════════════════════════════
//  日付は 1800 年 1 月 1 日から今日まで選べる。時刻が 24 時を過ぎれば次の日になる。
//  月齢は日付と時刻から天文の式で出す（平均の朔望月 29.530589 日。2000 年 1 月 6 日 18 時ごろの新月が基準）。
//  月齢を手で変えたときは、元の日付にいちばん近い、その月齢の日にする。
//  physics.dateDay0：gameTime の 0 日目が、1800 年 1 月 1 日から数えて何日目か
const CAL_JD0 = 2378496.5;                  // 1800-01-01 0 時のユリウス日
const CAL_SYNODIC = 29.530588853;
const CAL_NEW_MOON_JD = 2451550.26;
function _calUTC(y, m, d) { const t = new Date(0); t.setUTCFullYear(y, m - 1, d); t.setUTCHours(0, 0, 0, 0); return t.getTime(); }
const CAL_MS0 = _calUTC(1800, 1, 1);
function calDayOf(y, m, d) { return Math.round((_calUTC(y, m, d) - CAL_MS0) / 86400000); }
function calDateOf(n) { const t = new Date(CAL_MS0 + n * 86400000); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }; }
function calToday() { const t = new Date(); return calDayOf(t.getFullYear(), t.getMonth() + 1, t.getDate()); }
function calDayNow() {
    if (!Number.isFinite(physics.dateDay0)) physics.dateDay0 = calToday();
    return physics.dateDay0 + Math.floor(physics.gameTime / physics.dayDuration);
}
function calISO(n) { const q = calDateOf(n); return `${String(q.y).padStart(4, '0')}-${String(q.m).padStart(2, '0')}-${String(q.d).padStart(2, '0')}`; }
// その日（時刻も）の月齢（0＝新月、0.5＝満月）
function calMoonPhaseAt(n, frac) {
    const jd = CAL_JD0 + n + (frac || 0);
    const p = ((jd - CAL_NEW_MOON_JD) / CAL_SYNODIC) % 1;
    return p < 0 ? p + 1 : p;
}
function calMoonPhase() { return calMoonPhaseAt(calDayNow(), physics.dayProgress || 0); }
// 日付を決める（時刻はそのまま）。1800 年 1 月 1 日〜今日
function calSetDay(n) {
    n = Math.max(0, Math.min(calToday(), Math.round(n)));
    physics.dateDay0 = n - Math.floor(physics.gameTime / physics.dayDuration);
    physics.moonPhase = calMoonPhase();
    calSyncUI(true);
}
// 月齢を決める：元の日付にいちばん近い、その月齢の日へ（同じ時刻のまま）
function calSetMoonPhase(p) {
    const n = calDayNow(), cur = calMoonPhase();
    let dp = ((p - cur) % 1 + 1.5) % 1 - 0.5;                    // −0.5〜0.5 周
    let k = Math.round(dp * CAL_SYNODIC);
    // 今日より先にはできないので、前の周の同じ月齢へ
    if (n + k > calToday()) k -= Math.round(CAL_SYNODIC);
    calSetDay(n + k);
}
let _calShown = null;
function calSyncUI(force) {
    const n = calDayNow();
    const el = document.getElementById('date-input');
    if (el && document.activeElement !== el && (force || _calShown !== n)) { el.max = calISO(calToday()); el.value = calISO(n); }
    _calShown = n;
    const ps = document.getElementById('phase-slider'), pn = document.getElementById('phase-num');
    if (ps && document.activeElement !== ps) ps.value = physics.moonPhase;
    if (pn && document.activeElement !== pn) pn.value = physics.moonPhase.toFixed(2);
    const ml = document.getElementById('moon-age');
    if (ml) {
        const age = physics.moonPhase * CAL_SYNODIC;
        const name = physics.moonPhase < 0.03 || physics.moonPhase > 0.97 ? '新月' : Math.abs(physics.moonPhase - 0.5) < 0.03 ? '満月'
            : Math.abs(physics.moonPhase - 0.25) < 0.04 ? '上弦' : Math.abs(physics.moonPhase - 0.75) < 0.04 ? '下弦' : '';
        ml.textContent = `月齢 ${age.toFixed(1)}${name ? '（' + name + '）' : ''}`;
    }
}
window.calDayNow = calDayNow; window.calSetDay = calSetDay; window.calSetMoonPhase = calSetMoonPhase;
window.calISO = calISO; window.calMoonPhase = calMoonPhase; window.calDayOf = calDayOf; window.calSyncUI = calSyncUI;

// ── オーロラ（天候の欄のボタン）：今夜から出す・止める（夜だけ見える） ──
function auroraToggle(on) {
    const days = physics.gameTime / physics.dayDuration;
    if (on === undefined) on = !(auroraActive > 0.01 || days >= nextAuroraDay);
    if (on) { nextAuroraDay = days; window._auroraHold = true; }
    else { window._auroraHold = false; nextAuroraDay = days + 25 + Math.random() * 9; }
    auroraSyncUI();
}
function auroraSyncUI() {
    const b = document.getElementById('aurora-btn');
    if (!b) return;
    const days = physics.gameTime / physics.dayDuration;
    const on = !!window._auroraHold || days >= nextAuroraDay;
    const lab = on ? '🌌 オーロラを止める' : '🌌 オーロラを出す（夜に見えます）';
    if (b.textContent !== lab) b.textContent = lab;
}
window.auroraToggle = auroraToggle;
