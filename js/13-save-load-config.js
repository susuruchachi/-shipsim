// ========================================================
//  SHIP CONFIG SAVE / LOAD (localStorage)
// ========================================================

const SHIP_SAVE_KEY = 'susuru_ship_saves_v1';
const SHIP_AUTOSAVE_KEY = 'susuru_ship_autosave_v2';

function autoSaveConfig() {
    try {
        localStorage.setItem(SHIP_AUTOSAVE_KEY, JSON.stringify(collectShipConfig()));
    } catch (e) { /* ignore */ }
}

function autoLoadConfig() {
    try {
        const raw = localStorage.getItem(SHIP_AUTOSAVE_KEY);
        if (!raw) return;
        const cfg = JSON.parse(raw);
        if (cfg && cfg.version >= 2) applyShipConfig(cfg);
    } catch (e) { /* ignore */ }
}

function getVal(id) {
    const el = $(id);
    if (!el) return null;
    return el.type === 'checkbox' ? el.checked : el.value;
}

function setVal(id, value) {
    const el = $(id);
    if (!el || value === undefined || value === null) return;
    if (el.type === 'checkbox') {
        el.checked = !!value;
    } else {
        el.value = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
}

function collectShipConfig() {
    return {
        version: 2,
        physics: {
            scale: getVal('scale-num'),
            maxSpeed: getVal('maxspeed-num'),
            bowFullness: getVal('bowfull-num'),
            sternFullness: getVal('sternfull-num'),
            turningRadiusFactor: getVal('turnrad-num'),
            buoyancy: getVal('buoyancy-num'),           // GM倍率 (0.5〜2.0)
            buoyancyBase: physics.buoyancyBase || 12.0, // 自動計算ベース値
            draftOffset: getVal('draft-num'),
            waterlineOffsetY: getVal('waterlineY-num'),
            mass: getVal('mass-num'),
            waveRoughness: getVal('roughness-num'),
            waveWidth: getVal('wavewidth-num'),
            swellStrength: getVal('swell-num'),
            chopStrength: getVal('chop-num'),
            windDir: getVal('winddir-num'),
            windSpeed: getVal('windspd-num'),
            physicsSpeed: typeof physicsSpeed !== 'undefined' ? physicsSpeed : 1.0,
        },
        model: {
            offx: getVal('offx-num'), offy: getVal('offy-num'), offz: getVal('offz-num'),
            roty: getVal('roty-num'), mscale: getVal('mscale-num'),
        },
        cg: { x: getVal('cgx-num'), y: getVal('cgy-num'), z: getVal('cgz-num') },
        rudder: {
            width: getVal('rudder-width'), height: getVal('rudder-height'), depth: getVal('rudder-depth'),
            x: getVal('rudx-num'), y: getVal('rudy-num'), z: getVal('rudz-num'),
        },
        propulsion: {
            type: getVal('prop-type'),
            symmetry: getVal('prop-symmetry'),
            list: JSON.parse(JSON.stringify(propulsors)),
        },
        funnels: {
            symmetry: getVal('funnel-symmetry'),
            list: JSON.parse(JSON.stringify(funnels)),
        },
        smoke: {
            density: getVal('smoke-density'),
            speed: getVal('smoke-speed'),
            color: getVal('smoke-color'),
            speedLinked: getVal('smoke-speed-linked'),
        },
        navlights: {
            enabled: navLightsEnabled,
            sideSymmetry: getVal('navlight-side-symmetry'),
            sideX: getVal('navlight-side-x'), sideY: getVal('navlight-side-y'), sideZ: getVal('navlight-side-z'),
            sideIntensity: getVal('navlight-side-intensity'),
            sideAngle: getVal('navlight-side-angle'),
            sphereRadius: getVal('navlight-sphere-radius'),
            mastForeX: getVal('mast-fore-x'), mastForeY: getVal('mast-fore-y'), mastForeZ: getVal('mast-fore-z'),
            mastAftX: getVal('mast-aft-x'), mastAftY: getVal('mast-aft-y'), mastAftZ: getVal('mast-aft-z'),
            mastIntensity: getVal('navlight-mast-intensity'),
            sternX: getVal('sternlight-x'), sternY: getVal('sternlight-y'), sternZ: getVal('sternlight-z'),
        },
        perfQuality: perf.quality,
        waterQuality: waterQuality,
        lighting: {
            sunMult: lightSettings.sunMult,
            ambientMult: lightSettings.ambientMult,
            hemiMult: lightSettings.hemiMult,
            fillMult: lightSettings.fillMult,
            exposure: lightSettings.exposure,
            fogMult: lightSettings.fogMult,
            glbMaster: lightSettings.glbMaster,
            windowGlowMult: lightSettings.windowGlowMult,
            glbAutoMode: glbLightAutoMode,
        },
        waterVisible: userWaterVisible,
        // 視点(見張り台): 固定6スロットの座標 + 任意数の見張り台
        viewpoints: {
            fixed: Object.keys(fixedViewpoints).reduce((acc, k) => {
                const p = fixedViewpoints[k].marker.position;
                acc[k] = { x: p.x, y: p.y, z: p.z };
                return acc;
            }, {}),
            lookouts: lookouts.map(l => ({ x: l.marker.position.x, y: l.marker.position.y, z: l.marker.position.z, name: l.name })),
        },
        glbPartTransforms: glbMovableParts.map(p => ({
            name: p.name,
            rot: { x: p.object.rotation.x, y: p.object.rotation.y, z: p.object.rotation.z },
            invert: !!p.invert,
            spinAxis: p.spinAxis || 'x',
            disabled: !!p.disabled,
            pivotOffset: p.pivotOffset ? { x: p.pivotOffset.x, y: p.pivotOffset.y, z: p.pivotOffset.z } : { x:0, y:0, z:0 },
        })),
        // エリアライト個別設定（強度・色・ON/OFF・位置・向き・サイズ）
        glbLightSettings: glbLights.map(l => {
            const an = l.userData.areaNode;
            return {
                label: l.userData.labelName || '',
                baseIntensity: l.userData.baseIntensity != null ? l.userData.baseIntensity : l.intensity,
                color: '#' + l.color.getHexString(),
                manuallyOff: !!l.userData.manuallyOff,
                // areaNode の変換（位置・回転・スケール）を保存
                // これが照射方向・面サイズ・ライト位置の実体
                areaNode: an ? {
                    pos:   { x: an.position.x, y: an.position.y, z: an.position.z },
                    rot:   { x: an.rotation.x, y: an.rotation.y, z: an.rotation.z, order: an.rotation.order || 'XYZ' },
                    scale: { x: an.scale.x,    y: an.scale.y,    z: an.scale.z },
                } : null,
            };
        }),
        // 位置・向き・月齢
        shipPos: { x: physics.cgWorldX, z: physics.cgWorldZ, heading: physics.heading },
        dayProgress: physics.dayProgress,
        moonPhase: physics.moonPhase,
        moonPhaseManual: !!physics.moonPhaseManual,
        // 最後に使ったモデル形式名（バイナリは保存不可なので名前のみ）
        lastModelName: window.lastLoadedModelName || null,
    };
}

function applyShipConfig(cfg) {
    if (!cfg) return;

    const p = cfg.physics || {};
    setVal('scale-num', p.scale); setVal('scale-slider', p.scale);
    setVal('maxspeed-num', p.maxSpeed); setVal('maxspeed-slider', p.maxSpeed);
    setVal('bowfull-num', p.bowFullness); setVal('bowfull-slider', p.bowFullness);
    setVal('sternfull-num', p.sternFullness); setVal('sternfull-slider', p.sternFullness);
    setVal('turnrad-num', p.turningRadiusFactor); setVal('turnrad-slider', p.turningRadiusFactor);
    // buoyancyBase がある新形式 / なければ旧形式（p.buoyancy が絶対値）に対応
    physics.buoyancyBase = parseFloat(p.buoyancyBase != null ? p.buoyancyBase : p.buoyancy) || 12.0;
    const buoyancyTrim = p.buoyancyBase != null ? (parseFloat(p.buoyancy) || 1.0) : 1.0;
    setVal('buoyancy-num', buoyancyTrim); setVal('buoyancy-slider', buoyancyTrim);
    setVal('draft-num', p.draftOffset); setVal('draft-slider', p.draftOffset);
    setVal('waterlineY-num', p.waterlineOffsetY); setVal('waterlineY-slider', p.waterlineOffsetY);
    setVal('mass-num', p.mass); setVal('mass-slider', p.mass);
    setVal('roughness-num', p.waveRoughness); setVal('roughness-slider', p.waveRoughness);
    setVal('wavewidth-num', p.waveWidth); setVal('wavewidth-slider', p.waveWidth);
    // swellStrength/chopStrengthはStage5で追加した項目。古い保存データには無いため
    // 未定義の場合はデフォルト値1.0（従来と同じ波形）にフォールバックする。
    const swellV = (typeof p.swellStrength === 'number') ? p.swellStrength : 1.0;
    const chopV  = (typeof p.chopStrength  === 'number') ? p.chopStrength  : 1.0;
    setVal('swell-num', swellV); setVal('swell-slider', swellV);
    setVal('chop-num', chopV); setVal('chop-slider', chopV);
    physics.swellStrength = swellV;
    physics.chopStrength  = chopV;
    setVal('winddir-num', p.windDir); setVal('winddir-slider', p.windDir);
    setVal('windspd-num', p.windSpeed); setVal('windspd-slider', p.windSpeed);
    if (p.physicsSpeed != null) {
        physicsSpeed = p.physicsSpeed;
        setVal('physspeed-num', p.physicsSpeed);
        setVal('physspeed-slider', p.physicsSpeed);
    }

    const m = cfg.model || {};
    setVal('offx-num', m.offx); setVal('slider-offx', m.offx);
    setVal('offy-num', m.offy); setVal('slider-offy', m.offy);
    setVal('offz-num', m.offz); setVal('slider-offz', m.offz);
    setVal('roty-num', m.roty); setVal('slider-roty', m.roty);
    setVal('mscale-num', m.mscale); setVal('slider-mscale', m.mscale);

    const cg = cfg.cg || {};
    setVal('cgx-num', cg.x); setVal('cgx-slider', cg.x);
    setVal('cgy-num', cg.y); setVal('cgy-slider', cg.y);
    setVal('cgz-num', cg.z); setVal('cgz-slider', cg.z);

    const r = cfg.rudder || {};
    setVal('rudder-width', r.width);
    setVal('rudder-height', r.height);
    setVal('rudder-depth', r.depth);
    setVal('rudx-num', r.x); setVal('rudx-slider', r.x);
    setVal('rudy-num', r.y); setVal('rudy-slider', r.y);
    setVal('rudz-num', r.z); setVal('rudz-slider', r.z);

    const pr = cfg.propulsion || {};
    if (Array.isArray(pr.list)) propulsors = JSON.parse(JSON.stringify(pr.list));
    const hasOwnScrewCfg = glbMovableParts.some(p => p.key === 'screw' || p.key === 'paddle');
    if (propulsors.length === 0 && !hasOwnScrewCfg) propulsors = [{ x: 0, y: -1.2, z: -7, size: 1.0, dir: 1 }];
    setVal('prop-symmetry', pr.symmetry);
    setVal('prop-type', pr.type);

    const fn = cfg.funnels || {};
    if (Array.isArray(fn.list)) funnels = JSON.parse(JSON.stringify(fn.list));
    if (funnels.length === 0) funnels = [{ x: 0, y: 3.5, z: 0.5, rx: 0.4, ry: 1.2 }];
    setVal('funnel-symmetry', fn.symmetry);

    const sm = cfg.smoke || {};
    setVal('smoke-density', sm.density); setVal('smoke-density-num', sm.density);
    setVal('smoke-speed', sm.speed); setVal('smoke-speed-num', sm.speed);
    setVal('smoke-color', sm.color);
    setVal('smoke-speed-linked', sm.speedLinked);

    const nl = cfg.navlights || {};
    navLightsEnabled = nl.enabled !== false;
    setVal('navlights-toggle', navLightsEnabled);
    setVal('navlight-side-symmetry', nl.sideSymmetry);
    setVal('navlight-side-x', nl.sideX);
    setVal('navlight-side-y', nl.sideY);
    setVal('navlight-side-z', nl.sideZ);
    setVal('navlight-side-intensity', nl.sideIntensity); setVal('navlight-side-intensity-num', nl.sideIntensity);
    setVal('navlight-side-angle', nl.sideAngle); setVal('navlight-side-angle-num', nl.sideAngle);
    setVal('navlight-sphere-radius', nl.sphereRadius); setVal('navlight-sphere-radius-num', nl.sphereRadius);
    setVal('mast-fore-x', nl.mastForeX); setVal('mast-fore-y', nl.mastForeY); setVal('mast-fore-z', nl.mastForeZ);
    setVal('mast-aft-x', nl.mastAftX); setVal('mast-aft-y', nl.mastAftY); setVal('mast-aft-z', nl.mastAftZ);
    setVal('navlight-mast-intensity', nl.mastIntensity); setVal('navlight-mast-intensity-num', nl.mastIntensity);
    setVal('sternlight-x', nl.sternX); setVal('sternlight-y', nl.sternY); setVal('sternlight-z', nl.sternZ);

    // Rebuild everything explicitly to make sure all parts reflect the loaded config,
    // regardless of whether dispatched events were picked up by every listener.
    renderPropList();
    renderFunnelList();
    buildPropMeshes();
    buildFunnelMeshes();
    updateNavLights3D();
    updateNavLightsVisibility();
    updateRudder3D();
    updateSmokeSettings();
    if (shipGroup && Number.isFinite(p.scale)) {
        physics.scale = p.scale / 12.0;
        shipGroup.scale.set(physics.scale, physics.scale, physics.scale);
    }
    updateModelOffset();

    if (cfg.perfQuality && PERF_PRESETS[cfg.perfQuality]) {
        applyPerfPreset(cfg.perfQuality);
        const perfSel = $('perf-quality');
        if (perfSel) perfSel.value = cfg.perfQuality;
    }

    if (cfg.waterQuality && WATER_PRESETS[cfg.waterQuality]) {
        applyWaterQualityPreset(cfg.waterQuality);
        const waterSel = $('perf-water-quality');
        if (waterSel) waterSel.value = cfg.waterQuality;
    }

    if (cfg.lighting) {
        const lt = cfg.lighting;
        if (Number.isFinite(lt.sunMult)) lightSettings.sunMult = lt.sunMult;
        if (Number.isFinite(lt.ambientMult)) lightSettings.ambientMult = lt.ambientMult;
        if (Number.isFinite(lt.hemiMult)) lightSettings.hemiMult = lt.hemiMult;
        if (Number.isFinite(lt.fillMult)) lightSettings.fillMult = lt.fillMult;
        if (Number.isFinite(lt.exposure)) lightSettings.exposure = lt.exposure;
        if (Number.isFinite(lt.fogMult)) lightSettings.fogMult = lt.fogMult;
        if (Number.isFinite(lt.glbMaster)) lightSettings.glbMaster = lt.glbMaster;
        if (Number.isFinite(lt.windowGlowMult)) lightSettings.windowGlowMult = lt.windowGlowMult;
        if (typeof lt.glbAutoMode === 'boolean') glbLightAutoMode = lt.glbAutoMode;
        const autoToggle = $('glb-auto-toggle');
        if (autoToggle) autoToggle.checked = glbLightAutoMode;
    }
    if (cfg.lighting) syncLightingPanelUI();

    // エリアライト個別設定（強度・色・ON/OFF・位置・向き・サイズ）の復元
    if (Array.isArray(cfg.glbLightSettings) && cfg.glbLightSettings.length > 0) {
        if (glbLights.length > 0) {
            applyGlbLightSettingsData(cfg.glbLightSettings);
        } else {
            pendingGlbLightSettings = cfg.glbLightSettings;
        }
    }

    if (typeof cfg.waterVisible === 'boolean') {
        userWaterVisible = cfg.waterVisible;
        const wToggle = $('water-visible-toggle');
        if (wToggle) wToggle.checked = userWaterVisible;
        syncSettingsVisibility();
    }

    // 視点(見張り台)の復元
    if (cfg.viewpoints && typeof fixedViewpoints === 'object') {
        const vp = cfg.viewpoints;
        if (vp.fixed) {
            Object.keys(vp.fixed).forEach(k => {
                const fv = fixedViewpoints[k];
                const d = vp.fixed[k];
                if (fv && d) {
                    fv.marker.position.set(
                        Number.isFinite(d.x) ? d.x : fv.marker.position.x,
                        Number.isFinite(d.y) ? d.y : fv.marker.position.y,
                        Number.isFinite(d.z) ? d.z : fv.marker.position.z
                    );
                }
            });
            if (typeof renderFixedViewpointList === 'function') renderFixedViewpointList();
        }
        if (Array.isArray(vp.lookouts) && typeof removeLookoutPoint === 'function' && typeof addLookoutPoint === 'function') {
            while (lookouts.length > 0) removeLookoutPoint(0);
            vp.lookouts.forEach(l => addLookoutPoint(l.x, l.y, l.z, l.name));
        }
        if (typeof renderViewpointMenu === 'function') renderViewpointMenu();
    }

    if (Array.isArray(cfg.glbPartTransforms) && cfg.glbPartTransforms.length > 0) {
        if (glbMovableParts.length > 0) {
            glbMovableParts.forEach((part) => {
                const saved = cfg.glbPartTransforms.find(t => t.name === part.name);
                if (saved) {
                    if (saved.pos) part.object.position.set(saved.pos.x, saved.pos.y, saved.pos.z);
                    if (saved.rot) part.object.rotation.set(saved.rot.x, saved.rot.y, saved.rot.z);
                    if (typeof saved.invert === 'boolean') part.invert = saved.invert;
                    if (saved.spinAxis) part.spinAxis = saved.spinAxis;
                    if (typeof saved.disabled === 'boolean') part.disabled = saved.disabled;
                    if (saved.pivotOffset) {
                        if (!part.pivotOffset) part.pivotOffset = new THREE.Vector3();
                        part.pivotOffset.set(saved.pivotOffset.x, saved.pivotOffset.y, saved.pivotOffset.z);
                        if (part.pivotMarker) part.pivotMarker.position.copy(part.basePos).add(part.pivotOffset);
                    }
                }
            });
            renderGlbPartsList();
        } else {
            pendingGlbPartTransforms = cfg.glbPartTransforms;
        }
    }

    // 位置・向き・時間帯・月齢を復元
    if (cfg.shipPos) {
        if (Number.isFinite(cfg.shipPos.x)) physics.cgWorldX = cfg.shipPos.x;
        if (Number.isFinite(cfg.shipPos.z)) physics.cgWorldZ = cfg.shipPos.z;
        if (Number.isFinite(cfg.shipPos.heading)) physics.heading = cfg.shipPos.heading;
        window.lastShipPos = null;
        shipHistory.length = 0;
    }
    if (Number.isFinite(cfg.dayProgress)) {
        physics.dayProgress = cfg.dayProgress;
        physics.gameTime = cfg.dayProgress * physics.dayDuration;
        const hour = cfg.dayProgress * 24;
        setVal('time-slider', hour); setVal('time-num', hour.toFixed(1));
        updateDayNightCycle(cfg.dayProgress);
    }
    if (Number.isFinite(cfg.moonPhase)) {
        physics.moonPhase = cfg.moonPhase;
        // moonPhaseManual が true のときだけ手動固定。false（またはセーブに含まれない）なら自動進行
        physics.moonPhaseManual = cfg.moonPhaseManual === true;
        // 自動進行の場合、gameTimeを月齢から逆算して合わせる
        // （totalDays = moonPhase * 29.5 + 任意の整数日）
        if (!physics.moonPhaseManual) {
            const currentDays = physics.gameTime / physics.dayDuration;
            const currentCycles = Math.floor(currentDays / 29.5);
            // 現在のサイクル内で moonPhase に対応する日数に合わせる
            physics.gameTime = (currentCycles * 29.5 + cfg.moonPhase * 29.5) * physics.dayDuration;
        }
        setVal('phase-slider', cfg.moonPhase); setVal('phase-num', cfg.moonPhase.toFixed(2));
    }
    if (cfg.lastModelName) {
        window.lastLoadedModelName = cfg.lastModelName;
        const statusText = $('import-status');
        if (statusText) statusText.innerText = '前回モデル: ' + cfg.lastModelName + ' (再読込が必要)';
    }

    // ── v30 実物理浮力（F=ρgV）対策: massの自動再計算 ──────────────────────
    // セーブデータの mass は、旧バージョン（位置スプリング式の浮力）で
    // 感覚的に調整された値の可能性がある。旧方式は mass の絶対値が物理的に
    // 正しくなくても「それなりに」動いたが、新しい実物理計算は
    // mass(質量) と 船体形状から求まる排水体積 が一致していないと、
    // 浮力と重力が永遠に釣り合わず、船が浮かぶ/沈むかしてY座標の
    // クランプ(±80)に張り付いたまま動かなくなる（設定パネルを開いている間だけ
    // 強制的に正常な姿勢に固定されるため、パネルを開いている時しか
    // 正しく見えない、という症状になる）。
    // 既にハル形状がスキャン済みなら、現在の喫水線設定から実際の排水量を
    // 再計算して mass を上書きする（手動で追い込みたい場合はロード後に
    // スライダーで再調整できる）。スキャンがまだの場合は、モデルを
    // インポートした際に scanHullProfile() が同じ処理を自動的に行う。
    if (window.hullProfile && window.hullProfile.ready && typeof applyDisplacementToMass === 'function') {
        const recalculated = applyDisplacementToMass();
        if (recalculated !== null && Number.isFinite(p.mass) && p.mass > 0) {
            const ratio = recalculated / (p.mass * MASS_TONS_PER_UNIT);
            if (ratio > 1.5 || ratio < 0.667) {
                console.warn(`[ShipConfig] セーブされていたmass(${p.mass})が実際の排水量と大きくズレていたため、` +
                    `${recalculated.toFixed(0)}トン相当の値に自動補正しました（旧バージョンの値の可能性があります）。`);
            }
        }
    }
}

function loadAllShipSaves() {
    try {
        const raw = localStorage.getItem(SHIP_SAVE_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
}

function saveAllShipSaves(data) {
    try { localStorage.setItem(SHIP_SAVE_KEY, JSON.stringify(data)); } catch (e) { /* ignore */ }
}

function saveShipConfig() {
    const nameInput = $('ship-name-input');
    const name = (nameInput && nameInput.value || '').trim();
    const status = $('ship-save-status');
    if (!name) {
        if (status) status.textContent = '船名を入力してください。';
        return;
    }
    const all = loadAllShipSaves();
    all[name] = collectShipConfig();
    saveAllShipSaves(all);
    if (status) status.textContent = `「${name}」として保存しました。`;
    renderShipSaveList();
}

function loadShipConfig(name) {
    const all = loadAllShipSaves();
    const cfg = all[name];
    if (!cfg) return;
    applyShipConfig(cfg);
    const nameInput = $('ship-name-input');
    if (nameInput) nameInput.value = name;
    const status = $('ship-save-status');
    if (status) status.textContent = `「${name}」を読み込みました。`;
}

function deleteShipConfig(name) {
    const all = loadAllShipSaves();
    delete all[name];
    saveAllShipSaves(all);
    renderShipSaveList();
}

function renderShipSaveList() {
    const list = $('ship-save-list'); if (!list) return;
    const all = loadAllShipSaves();
    const names = Object.keys(all);
    list.innerHTML = '';
    if (names.length === 0) {
        list.innerHTML = '<div style="font-size:10px;color:#888;">保存された船はありません。</div>';
        return;
    }
    names.forEach(name => {
        const safeName = name.replace(/'/g, "\\'").replace(/"/g, '&quot;');
        const card = document.createElement('div');
        card.className = 'sp-item-card';
        card.innerHTML = `
            <div class="sp-item-header">
                <span class="sp-item-title">${name}</span>
                <button class="sp-remove-btn" onclick="deleteShipConfig('${safeName}')">✕</button>
            </div>
            <div class="sp-row" style="gap:8px;">
                <button class="sp-add-btn" style="flex:1;" onclick="loadShipConfig('${safeName}')">📂 読み込み</button>
            </div>`;
        list.appendChild(card);
    });
}

// ========================================================
//  SHIP CONFIG SAVE / LOAD (FILE - 複数デバイス用)
// ========================================================

function exportShipConfigFile() {
    const status = $('ship-file-status');
    try {
        const nameInput = $('ship-name-input');
        const name = (nameInput && nameInput.value || '').trim();
        const cfg = collectShipConfig();
        cfg.exportedAt = new Date().toISOString();
        if (name) cfg.shipName = name;

        const json = JSON.stringify(cfg, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);

        const safeName = (name || 'ship').replace(/[\\/:*?"<>|]/g, '_');
        const dateStr = new Date().toISOString().slice(0, 10);
        const a = document.createElement('a');
        a.href = url;
        a.download = `susuru_ship_${safeName}_${dateStr}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        if (status) status.textContent = `ファイルに書き出しました: ${a.download}`;
    } catch (e) {
        if (status) status.textContent = 'エラー: ファイルの書き出しに失敗しました。';
    }
}

function importShipConfigFile(event) {
    const status = $('ship-file-status');
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
        try {
            const cfg = JSON.parse(ev.target.result);
            if (!cfg || !Number.isFinite(cfg.version)) {
                if (status) status.textContent = 'エラー: 無効な設定ファイルです。';
                return;
            }
            applyShipConfig(cfg);
            if (cfg.shipName) {
                const nameInput = $('ship-name-input');
                if (nameInput) nameInput.value = cfg.shipName;
            }
            if (status) status.textContent = `ファイルから読み込みました: ${file.name}`;
        } catch (e) {
            if (status) status.textContent = 'エラー: ファイルの読み込みに失敗しました。(JSON形式エラー)';
        }
    };
    reader.onerror = () => {
        if (status) status.textContent = 'エラー: ファイルの読み込みに失敗しました。';
    };
    reader.readAsText(file);
    event.target.value = '';
}


function initSettingsComponents() {
    const perfSel = $('perf-quality');
    if (perfSel) perfSel.value = perf.quality;
    const waterSel = $('perf-water-quality');
    if (waterSel) waterSel.value = waterQuality;
    renderPropList();
    renderFunnelList();
    buildPropMeshes();
    buildFunnelMeshes();
    updateNavLights3D();
    updateRudder3D();
    renderShipSaveList();
    syncLightingPanelUI();
    renderGlbPartsList();
}

document.addEventListener('DOMContentLoaded', () => {
    const panel = $('settings-panel');
    if (panel) {
        panel.addEventListener('mousedown', (e) => e.stopPropagation());
        panel.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: false });
    }
});

// ホーム画面に追加した際にブラウザのタブ/アドレスバーなしの「スタンドアロン」表示に
// なるよう、最小限のService Workerを登録しておく(manifest.jsonとセットでインストール可能になる)。
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(() => {});
    });
}


