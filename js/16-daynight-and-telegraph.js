function changeTelegraph(dir) {
    physics.telegraphState = Math.max(-3, Math.min(3, physics.telegraphState + dir));
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
    // 同じ係数で窓グローのPointLightも連動（windowGlowMultスライダーで輝度と照明が同時に変わる）
    windowGlowLights.forEach(pl => {
        pl.intensity = pl.userData.wgBaseIntensity * eff;
    });

    // v169: プロムナードライト（丸い照明カバー用の個別小型PointLight）も同じ係数で連動
    promenadeLights.forEach(pl => {
        pl.intensity = pl.userData.wgBaseIntensity * eff;
    });

    // v168: ライトプローブの強度も同じ係数で連動させる。SH係数自体（分布の形）は
    // buildWindowGlowLights()で焼き込み済みなので、ここではintensity(全係数への
    // 一律乗数)を書き換えるだけ——毎フレーム呼ばれても軽い処理。
    if (windowGlowLightProbe) {
        // wgProbeBaseIntensityは「フル点灯時にどれくらい底上げするか」の基準値。
        // PointLightのwgBaseIntensity(18.0)とは役割が違う（プローブは面全体への
        // 弱い底上げ、PointLightは局所的な強いアクセント）ため、別の低めの値にする。
        windowGlowLightProbe.intensity = 1.2 * eff;
    }

    // v166: シャドウマップの再計算はintensity更新とは別にローテーション式で間引く
    // （明るさのフェードは毎フレーム滑らかに、影の再計算だけを間引く）。
    // wgShadowUpdateInterval フレームごとに1灯だけneedsUpdate=trueを立てて回す。
    // 8灯 × interval フレームで一巡するので、intervalが大きいほど1灯あたりの
    // 更新頻度は下がる（見た目には「船の動きに対して影の追従が少し遅れる」形になるが、
    // 窓明かりの影自体は元々コントラストの弱いディテールなので目立ちにくい）。
    const interval = (typeof perf !== 'undefined' && perf.wgShadowUpdateInterval) || 1;
    if (interval <= 1) {
        // high品質など間引き不要な設定では従来通り毎フレーム全灯更新
        windowGlowLights.forEach(pl => { if (pl.castShadow) pl.shadow.needsUpdate = true; });
    } else {
        // 1フレームにつき1灯だけ更新し、8灯 × interval フレームで全灯が一巡する。
        // 例：8灯・interval=3フレームなら、24フレームで8灯すべてが1回ずつ更新される
        // （1灯あたりの実質更新間隔は24フレーム、うち「担当フレーム」は3フレームに1回巡ってくる）。
        const numLights = windowGlowLights.length;
        if (numLights > 0 && wgShadowFrameCounter % interval === 0) {
            const slotToUpdate = Math.floor(wgShadowFrameCounter / interval) % numLights;
            windowGlowLights.forEach(pl => {
                if (pl.castShadow && pl.userData.wgShadowSlot === slotToUpdate) {
                    pl.shadow.needsUpdate = true;
                }
            });
        }
    }
    wgShadowFrameCounter++;
}

function updateDayNightCycle(dayProgress) {
    const sunAngle = dayProgress * Math.PI * 2 - Math.PI * 0.5;
    const tilt = 0.4; 
    const sunDistance = 400;

    const sunX = Math.cos(sunAngle) * sunDistance;
    const sunY = Math.sin(sunAngle) * sunDistance * Math.cos(tilt);
    const sunZ = -Math.sin(sunAngle) * sunDistance * Math.sin(tilt);

    const sunPos = new THREE.Vector3(sunX, sunY, sunZ);

    // 月の位置は太陽との位相差（月齢）で決まる。
    // moonPhase=0→新月(太陽と同方向), 0.5→満月(太陽の反対側)
    // 月は太陽より「遅れて」公転するので、moonPhaseが増えるほど太陽より後方（西）へ移動する
    const moonAngle = sunAngle - physics.moonPhase * Math.PI * 2;
    const moonX = Math.cos(moonAngle) * sunDistance;
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
    sunLight.intensity += (lightIntensity * lightSettings.sunMult - sunLight.intensity) * 0.05;
    sunLight.color.lerp(lightColor, 0.05);
    scene.background.lerp(background, 0.05);
    scene.fog.color.lerp(fogColor, 0.05);
    const targetFogDensity = (isNight ? 0.00015 : 0.00025) * lightSettings.fogMult;
    scene.fog.density += (targetFogDensity - scene.fog.density) * 0.02;

    ambientLight.intensity += (ambientIntensity * lightSettings.ambientMult - ambientLight.intensity) * 0.05;
    hemiLight.intensity += (hemiIntensity * lightSettings.hemiMult - hemiLight.intensity) * 0.05;
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
    }
    if (skyMesh && skyMesh.material.uniforms) {
        skyMesh.material.uniforms.dayProgress.value = dayProgress;
        skyMesh.material.uniforms.sunDirection.value.copy(sunPos).normalize();
        skyMesh.material.uniforms.moonDirection.value.copy(moonPos).normalize();
        skyMesh.material.uniforms.moonPhase.value = physics.moonPhase;
    }
}

