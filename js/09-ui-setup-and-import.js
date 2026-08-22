function setupModelImport() {
    installTextureAliasResolver();
    setupTextureFolderLoader();
    const modelLoader = $('model-loader'), mtlLoader = $('mtl-loader'), statusText = $('import-status');

    function handleFile(input, file) {
        if (!file) return;
        const ext = file.name.split('.').pop().toLowerCase();
        const reader = new FileReader();
        statusText.innerText = 'Loading: ' + file.name + '...';

        if (ext === 'gltf' || ext === 'glb') {
            modelOffset.ry = -90.0; syncModelOffsetUI();
            pendingMTLMaterials = null; pendingMTLText = null; pendingOBJText = null;
            reader.onload = (ev) => {
                const view = new DataView(ev.target.result);
                let isBinary = ev.target.result.byteLength > 4 && view.getUint32(0, true) === 0x46546C67;
                const manager = new THREE.LoadingManager();
                manager.setURLModifier((url) => resolveTextureAlias(url) || url);
                const loader = new THREE.GLTFLoader(manager);
                const success = (gltf) => {
                    applyGltfEmissiveStrengthExt(gltf.scene, gltf.parser && gltf.parser.json);
                    setCustomModel(gltf.scene);
                    statusText.innerText = 'Loaded: ' + file.name;
                    window.lastLoadedModelName = file.name;
                    // Blenderのワット単位 → Three.js向けに自動スケーリング
                    glbLights.forEach((light) => {
                        if (light.isRectAreaLight) {
                            // カスタムプロパティ経由は生成時に変換済み、
                            // KHR_lights_punctual経由のRectAreaLightはないが念のため
                            if (!light.userData.isAreaLight && light.intensity > 50) {
                                light.intensity *= 0.02;
                            }
                        } else if (light.isPointLight || light.isSpotLight) {
                            if (light.intensity > 100) { light.intensity *= 0.001; }
                        } else if (light.isDirectionalLight) {
                            if (light.intensity > 10) { light.intensity *= 0.1; }
                        }
                        light.userData.baseIntensity = light.intensity;
                    });
                    glbLightMaster = 1.0;
                    updateGlbLightsUI();
                };
                if (isBinary) loader.parse(ev.target.result, './', success, () => {});
                else loader.parse(new TextDecoder('utf-8').decode(ev.target.result), './', success, () => {});
            };
            reader.readAsArrayBuffer(file);
        } else if (ext === 'obj') {
            modelOffset.ry = -90.0; syncModelOffsetUI();
            reader.onload = (ev) => {
                try { loadOBJ(ev.target.result, file.name); window.lastLoadedModelName = file.name; }
                catch (e) { statusText.innerText = 'Error'; }
            };
            reader.readAsText(file);
        } else if (ext === 'mtl') {
            reader.onload = (ev) => loadMTL(ev.target.result, file.name, false);
            reader.readAsText(file);
        }
    }
    modelLoader.addEventListener('change', (e) => { handleFile(e.target, e.target.files[0]); e.target.value = ''; });
    mtlLoader.addEventListener('change', (e) => { handleFile(e.target, e.target.files[0]); e.target.value = ''; });
}

function setupParamControl(sliderId, numInputId, decBtnId, incBtnId, setter) {
    const slider = $(sliderId), numInput = $(numInputId), decBtn = $(decBtnId), incBtn = $(incBtnId);
    if (!slider || !numInput || !decBtn || !incBtn) return;

    const min = parseFloat(slider.min), max = parseFloat(slider.max), step = parseFloat(slider.step) || 1, defaultValue = parseFloat(slider.value);
    const decimals = String(step).includes('.') ? String(step).split('.')[1].length : 0;
    const roundValue = (v) => decimals > 0 ? Number(v.toFixed(decimals)) : Math.round(v);

    function updateAll(value) {
        let v = Number.isFinite(value) ? value : defaultValue;
        v = roundValue(Math.max(min, Math.min(max, v)));
        slider.value = v; numInput.value = v;
        setter(v);
    }
    slider.addEventListener('input', (e) => updateAll(parseFloat(e.target.value)));
    numInput.addEventListener('change', (e) => updateAll(parseFloat(e.target.value)));
    decBtn.addEventListener('click', () => updateAll(parseFloat(slider.value) - step));
    incBtn.addEventListener('click', () => updateAll(parseFloat(slider.value) + step));

    const stopProp = (e) => e.stopPropagation();
    [slider, numInput, decBtn, incBtn].forEach(el => {
        el.addEventListener('touchstart', stopProp); el.addEventListener('mousedown', stopProp);
    });
    updateAll(defaultValue);
}

function setupUIControls() {
    setupParamControl('time-slider', 'time-num', 'time-dec', 'time-inc', (v) => {
        physics.dayProgress = v / 24.0;
        physics.gameTime = physics.dayProgress * physics.dayDuration;
        updateDayNightCycle(physics.dayProgress);
        // 手動操作時は固定モードでも位置を即反映（lerpターゲットをリセット）
        if (sunLight && sunLight.userData.currentPos) {
            const sA = physics.dayProgress * Math.PI * 2 - Math.PI * 0.5;
            const sd = 400;
            sunLight.userData.currentPos.set(Math.cos(sA)*sd, Math.sin(sA)*sd*Math.cos(0.4), -Math.sin(sA)*sd*Math.sin(0.4));
        }
    });
    setupParamControl('phase-slider', 'phase-num', 'phase-dec', 'phase-inc', (v) => {
        physics.moonPhase = v;
        physics.moonPhaseManual = true;
        updateDayNightCycle(physics.dayProgress);
    });
    
    setupParamControl('winddir-slider', 'winddir-num', 'winddir-dec', 'winddir-inc', (v) => { physics.windDir = v; });
    setupParamControl('windspd-slider', 'windspd-num', 'windspd-dec', 'windspd-inc', (v) => { physics.windSpeed = v; });

    const navlightsToggle = $('navlights-toggle');
    if (navlightsToggle) {
        navlightsToggle.addEventListener('change', (e) => {
            navLightsEnabled = e.target.checked;
            updateNavLightsVisibility();
        });
    }

    setupParamControl('buoyancy-slider', 'buoyancy-num', 'buoyancy-dec', 'buoyancy-inc', (v) => {
        physics.buoyancy = Math.max(1.0, Math.min(50.0, (physics.buoyancyBase || 12.0) * v));
    });
    setupParamControl('draft-slider', 'draft-num', 'draft-dec', 'draft-inc', (v) => {
        physics.draftOffset = v;
        // 【変更】喫水線基準点が変わったら、その場でmassも自動的に再カリブレーションする。
        // 以前はreadout表示だけ更新してmassは据え置きだったため、基準点を調整しても
        // 実際に釣り合う喫水はズレたままだった（表示上の数字と実際の物理が食い違う）。
        if (typeof applyDisplacementToMass === 'function') applyDisplacementToMass();
        else if (typeof updateDisplacementReadout === 'function') updateDisplacementReadout();
    });
    setupParamControl('roughness-slider', 'roughness-num', 'roughness-dec', 'roughness-inc', (v) => { physics.waveRoughness = v; });
    setupParamControl('wavewidth-slider', 'wavewidth-num', 'wavewidth-dec', 'wavewidth-inc', (v) => { physics.waveWidth = v; });
    setupParamControl('swell-slider', 'swell-num', 'swell-dec', 'swell-inc', (v) => { physics.swellStrength = v; });
    setupParamControl('chop-slider', 'chop-num', 'chop-dec', 'chop-inc', (v) => { physics.chopStrength = v; });
    setupParamControl('turnrad-slider', 'turnrad-num', 'turnrad-dec', 'turnrad-inc', (v) => { physics.turningRadiusFactor = v; });
    setupParamControl('physspeed-slider', 'physspeed-num', 'physspeed-dec', 'physspeed-inc', (v) => { physicsSpeed = v; });

    setupParamControl('maxspeed-slider', 'maxspeed-num', 'maxspeed-dec', 'maxspeed-inc', (v) => { physics.maxSpeed = v; });
    setupParamControl('scale-slider', 'scale-num', 'scale-dec', 'scale-inc', (v) => {
        physics.scale = v / 12.0;
        shipGroup.scale.set(physics.scale, physics.scale, physics.scale);
        // スケール変更後は排水量・mass を自動再計算
        if (typeof applyDisplacementToMass === 'function') applyDisplacementToMass();
        else if (typeof updateDisplacementReadout === 'function') updateDisplacementReadout();
    });
    setupParamControl('bowfull-slider', 'bowfull-num', 'bowfull-dec', 'bowfull-inc', (v) => { physics.bowFullness = v; });
    setupParamControl('sternfull-slider', 'sternfull-num', 'sternfull-dec', 'sternfull-inc', (v) => { physics.sternFullness = v; });

    function bindSettingsSlider(sliderId, numId, setter) {
        const slider = $(sliderId), num = $(numId);
        if (!slider || !num) return;
        const sync = (v) => { v = parseFloat(v); if (!isFinite(v)) return; slider.value = v; num.value = v; setter(v); };
        slider.addEventListener('input', (e) => sync(e.target.value));
        num.addEventListener('change', (e) => sync(e.target.value));
        // モバイルでOrbitControlsにタッチが奪われないようにstopPropagation
        const stopP = (e) => e.stopPropagation();
        [slider, num].forEach(el => {
            el.addEventListener('touchstart', stopP);
            el.addEventListener('mousedown', stopP);
        });
        sync(parseFloat(slider.value));
    }
    // modelOffset(モデル位置・船首方向・スケール)を変更する際は、変更直前の変換を
    // 記録しておき、変更後にcgOffset/waterlineOffsetYを再アンカーすることで、
    // 重心マーカーや喫水線が船体メッシュに「置いていかれる」のを防ぐ。
    bindSettingsSlider('slider-offx', 'offx-num', (v) => {
        const _old = _captureModelOffsetTransform(); modelOffset.x = v;
        reanchorReferencePointsToModelOffset(_old); updateModelOffset();
    });
    bindSettingsSlider('slider-offy', 'offy-num', (v) => {
        const _old = _captureModelOffsetTransform(); modelOffset.y = v;
        reanchorReferencePointsToModelOffset(_old); updateModelOffset();
    });
    bindSettingsSlider('slider-offz', 'offz-num', (v) => {
        const _old = _captureModelOffsetTransform(); modelOffset.z = v;
        reanchorReferencePointsToModelOffset(_old); updateModelOffset();
    });
    bindSettingsSlider('slider-roty', 'roty-num', (v) => {
        const _old = _captureModelOffsetTransform(); modelOffset.ry = v;
        reanchorReferencePointsToModelOffset(_old); updateModelOffset();
    });
    bindSettingsSlider('slider-mscale', 'mscale-num', (v) => {
        const _old = _captureModelOffsetTransform(); modelOffset.scale = v;
        reanchorReferencePointsToModelOffset(_old); updateModelOffset();
    });
    bindSettingsSlider('cgx-slider', 'cgx-num', (v) => {
        const oldPin = _currentPinOffsetScaled();
        physics.cgOffset.x = v;
        reanchorWorldPositionForPinOffsetChange(oldPin, _currentPinOffsetScaled());
        if (cgMarker) cgMarker.position.x = v;
        if (typeof updateDisplacementReadout === 'function') updateDisplacementReadout();
    });
    bindSettingsSlider('cgy-slider', 'cgy-num', (v) => { physics.cgOffset.y = v; if (cgMarker) cgMarker.position.y = v; if (typeof updateDisplacementReadout === 'function') updateDisplacementReadout(); });
    bindSettingsSlider('cgz-slider', 'cgz-num', (v) => {
        const oldPin = _currentPinOffsetScaled();
        physics.cgOffset.z = v;
        reanchorWorldPositionForPinOffsetChange(oldPin, _currentPinOffsetScaled());
        if (cgMarker) cgMarker.position.z = v;
        if (typeof updateDisplacementReadout === 'function') updateDisplacementReadout();
    });
    // 喫水線基準点（重心とは独立。船体のどの高さを「喫水ゼロ」とみなすか）
    bindSettingsSlider('waterlineY-slider', 'waterlineY-num', (v) => {
        physics.waterlineOffsetY = v;
        // 【変更】基準点そのものが変わったら、massをその場で自動的に基準点に
        // 合わせて再カリブレーションする（＝物理が「基準点=釣り合いの喫水」に
        // なるよう常に自己修正され続ける）。
        if (typeof applyDisplacementToMass === 'function') applyDisplacementToMass();
        else if (typeof updateDisplacementReadout === 'function') updateDisplacementReadout();
    });
    // 質量（排水量ベース、単位=千トン）。手動調整も、船体形状からの自動計算も可能。
    bindSettingsSlider('mass-slider', 'mass-num', (v) => {
        physics.mass = v;
        // 手動設定時は readout に「手動設定」を明示する
        const el = $('displacement-readout');
        if (el) {
            const tons = Math.round(v * 1000); // MASS_TONS_PER_UNIT = 1000
            el.textContent = `排水量: 約 ${tons.toLocaleString()} トン（手動設定）`;
        }
    });
    bindSettingsSlider('rudx-slider', 'rudx-num', (v) => { physics.rudderOffset.x = v; if (rudderMarker) rudderMarker.position.x = v; if(rudder3DMesh) rudder3DMesh.position.x = v;});
    bindSettingsSlider('rudy-slider', 'rudy-num', (v) => { physics.rudderOffset.y = v; if (rudderMarker) rudderMarker.position.y = v; if(rudder3DMesh) rudder3DMesh.position.y = v;});
    bindSettingsSlider('rudz-slider', 'rudz-num', (v) => { physics.rudderOffset.z = v; if (rudderMarker) rudderMarker.position.z = v; if(rudder3DMesh) rudder3DMesh.position.z = v;});

    // 時間速度スライダー (0=等速 1=×12 2=×96 3=×576 4=×3456)
    const timeSpeedSlider = $('time-speed-slider');
    const timeSpeedLabel = $('time-speed-label');
    function updateTimeSpeedLabel() {
        if (!timeSpeedLabel) return;
        if (timeFrozen) { timeSpeedLabel.textContent = '⏸ 固定'; return; }
        const m = TIME_SPEED_STEPS[timeSpeedIndex];
        timeSpeedLabel.textContent = m === 1 ? '×1 等速' : '×' + m;
    }
    if (timeSpeedSlider) {
        timeSpeedSlider.value = timeSpeedIndex;
        timeSpeedSlider.addEventListener('input', (e) => {
            timeSpeedIndex = parseInt(e.target.value);
            timeFrozen = false;
            updateTimeSpeedLabel();
            const freezeBtn = $('time-freeze-btn');
            if (freezeBtn) freezeBtn.style.background = 'rgba(255,255,255,0.2)';
        });
        const stopP = (e) => e.stopPropagation();
        timeSpeedSlider.addEventListener('touchstart', stopP);
        timeSpeedSlider.addEventListener('mousedown', stopP);
    }
    const freezeBtn = $('time-freeze-btn');
    if (freezeBtn) {
        freezeBtn.addEventListener('click', () => {
            timeFrozen = !timeFrozen;
            freezeBtn.style.background = timeFrozen ? 'rgba(255,200,0,0.5)' : 'rgba(255,255,255,0.2)';
            updateTimeSpeedLabel();
        });
        freezeBtn.addEventListener('touchstart', (e) => e.stopPropagation());
        freezeBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    }
    updateTimeSpeedLabel();

    // 航行灯 光源距離スライダー
    const navDistSlider = $('navdist-slider');
    const navDistLabel = $('navdist-label');
    if (navDistSlider) {
        navDistSlider.addEventListener('input', (e) => {
            const d = parseFloat(e.target.value);
            window.navLightDistance = d;
            if (navDistLabel) navDistLabel.textContent = d;
            // 既存の全航行灯SpotLightに反映
            Object.values(navLightMeshes).forEach(lg => {
                if (lg && lg.userData.spot) lg.userData.spot.distance = d;
            });
        });
        const stopP2 = (e) => e.stopPropagation();
        navDistSlider.addEventListener('touchstart', stopP2);
        navDistSlider.addEventListener('mousedown', stopP2);
    }
}

function setupWindowEvents() {
    window.addEventListener('resize', onWindowResize);
    const menuBtn = $('menu-toggle');
    const handler = (e) => { e.stopPropagation(); e.preventDefault(); toggleMenu(); };
    menuBtn.addEventListener('click', handler);
    menuBtn.addEventListener('touchstart', handler, { passive: false });
    $('ui-container').addEventListener('mousedown', (e) => e.stopPropagation());
    $('ui-container').addEventListener('touchstart', (e) => e.stopPropagation());
}

