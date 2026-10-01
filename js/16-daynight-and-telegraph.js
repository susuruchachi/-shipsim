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
        // 曇天・荒天では海の色も暗く沈む
        const wd = (typeof wxMul.waterDark === 'number') ? wxMul.waterDark : 1;
        if (wd < 0.999) {
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

