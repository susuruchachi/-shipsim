function toggleMenu() {
    const menu = $('ui-container');
    const btn = $('menu-toggle');
    menu.classList.toggle('open');
    document.body.classList.toggle('menu-open');
    btn.innerText = menu.classList.contains('open') ? '✕ Close' : '☰ Menu';
}

function normalizeAngle(angle) {
    while (angle < -Math.PI) angle += Math.PI * 2;
    while (angle > Math.PI) angle -= Math.PI * 2;
    return angle;
}

function normalizeHeadingDegrees(deg) {
    return ((((deg + 180) % 360) + 360) % 360) - 180;
}

function modelHasMesh(root) {
    if (!root || !root.traverse) return false;
    let found = false;
    root.traverse((child) => { if (child.isMesh) found = true; });
    return found;
}

function resolveTextureAlias(url) {
    if (!url || typeof url !== 'string') return null;
    const clean = decodeURIComponent(url.split(/[?#]/)[0].split(/[\\/]/).pop().toLowerCase());
    return textureAliases[clean] || null;
}

function installTextureAliasResolver() {
    if (textureResolverInstalled) return;
    textureResolverInstalled = true;
    const originalLoad = THREE.TextureLoader.prototype.load;
    THREE.TextureLoader.prototype.load = function(url, onLoad, onProgress, onError) {
        const alias = resolveTextureAlias(url);
        return originalLoad.call(this, alias || url, onLoad, onProgress, onError);
    };
}

function syncModelOffsetUI() {
    const rotySlider = $('slider-roty');
    const rotyNum = $('roty-num');
    if (rotySlider) rotySlider.value = modelOffset.ry;
    if (rotyNum) rotyNum.value = modelOffset.ry;
}

// ============================================================
//  重心(cgOffset)・喫水線基準点(waterlineOffsetY)の「置いていかれる」問題の修正
// ============================================================
//  cgOffset / waterlineOffsetY は、importedModelGroup のローカル座標系
//  （= modelOffset の位置・回転(ry)・スケールが反映された後の座標系）における
//  「絶対座標」として保持されている。そのため、ユーザーがモデル位置(offx/y/z)・
//  船首方向(roty)・モデルスケール(mscale)を後から変更すると、船体メッシュ自体は
//  移動・回転・拡縮するのに、cgOffset/waterlineOffsetYの数値はそのまま変わらない
//  ため、「実際の船体上のどの点を指しているか」がズレてしまう
//  （＝重心マーカーや喫水線が船体に対して置いていかれる）。
//
//  対策: modelOffsetを変更する直前の変換(oldTr)を使って、現在のcgOffset/
//  waterlineOffsetYを「モデル本来の生座標（raw座標、modelOffset変換前）」に
//  逆算しておき、変更後の新しい変換(newTr)で再度ローカル座標に焼き直す。
//  これにより、cgOffset/waterlineOffsetYは常に「船体上の同じ物理的な点」を
//  指し続けるようになる。
// ============================================================
function _captureModelOffsetTransform() {
    return {
        x: modelOffset.x, y: modelOffset.y, z: modelOffset.z,
        ryRad: (modelOffset.ry * Math.PI) / 180,
        scale: Math.max(1e-6, modelOffset.autoScale * modelOffset.scale),
    };
}

// local = T + R(ry) * scale * raw  の逆変換（local → raw）
function _modelLocalToRaw(lx, ly, lz, tr) {
    const dx = lx - tr.x, dz = lz - tr.z;
    const c = Math.cos(tr.ryRad), s = Math.sin(tr.ryRad);
    return {
        x: (dx * c - dz * s) / tr.scale,
        y: (ly - tr.y) / tr.scale,
        z: (dx * s + dz * c) / tr.scale,
    };
}
// raw → local（順変換）
function _modelRawToLocal(rx, ry, rz, tr) {
    const c = Math.cos(tr.ryRad), s = Math.sin(tr.ryRad);
    return {
        x: tr.x + (rx * c + rz * s) * tr.scale,
        y: tr.y + ry * tr.scale,
        z: tr.z + (-rx * s + rz * c) * tr.scale,
    };
}

// modelOffsetの変更前後でcgOffset・waterlineOffsetYが「同じ船体上の点」を
// 指し続けるよう再計算する。oldTr は変更直前に _captureModelOffsetTransform() で
// 取得しておいた変換。UIスライダー・数値表示・3Dマーカーも合わせて同期する。
function reanchorReferencePointsToModelOffset(oldTr) {
    const newTr = _captureModelOffsetTransform();

    const rawCg = _modelLocalToRaw(physics.cgOffset.x, physics.cgOffset.y, physics.cgOffset.z, oldTr);
    const newCg = _modelRawToLocal(rawCg.x, rawCg.y, rawCg.z, newTr);
    physics.cgOffset.x = newCg.x;
    physics.cgOffset.y = newCg.y;
    physics.cgOffset.z = newCg.z;

    // 喫水線基準点はY成分のみ（船体のどの「高さ」を喫水ゼロとみなすかの値のため、
    // 回転(ry)の影響は受けない＝平行移動とスケールだけ追従させればよい）
    const rawWlY = (physics.waterlineOffsetY - oldTr.y) / oldTr.scale;
    physics.waterlineOffsetY = newTr.y + rawWlY * newTr.scale;

    const setSlider = (slId, numId, v, dec) => {
        const sl = $(slId), nm = $(numId);
        if (sl) sl.value = v;
        if (nm) nm.value = v.toFixed(dec);
    };
    setSlider('cgx-slider', 'cgx-num', physics.cgOffset.x, 2);
    setSlider('cgy-slider', 'cgy-num', physics.cgOffset.y, 2);
    setSlider('cgz-slider', 'cgz-num', physics.cgOffset.z, 2);
    setSlider('waterlineY-slider', 'waterlineY-num', physics.waterlineOffsetY, 2);
    if (typeof cgMarker !== 'undefined' && cgMarker) {
        cgMarker.position.set(physics.cgOffset.x, physics.cgOffset.y, physics.cgOffset.z);
    }
}

// ============================================================
//  重心(cgOffset.x/z)スライダーを動かしたときに「船体メッシュ自体が
//  ワールド座標上で瞬間移動してしまう」問題の修正
// ============================================================
//  17-main-loop.js末尾の配置処理は、shipGroupのローカル座標系における
//  「基準点」pinOffsetScaled = (cgOffset.x, waterlineOffsetY, cgOffset.z) * physScale
//  が、常にワールド座標 (physics.cgWorldX, physics.y, physics.cgWorldZ) と
//  一致するように shipGroup.position を逆算している。
//
//  そのため、cgOffset.x/zだけをスライダーで変更すると「基準点」自体が船体に
//  対して移動するのに、ワールド座標(cgWorldX/cgWorldZ)はそのままなので、
//  結果的に船体メッシュ全体がワールド座標上で瞬間移動してしまう
//  （＝回転軸や、船の現在位置を参照して生成されるエフェクト（航跡パーティクル等）が
//    古い位置に「取り残される」ように見える）。
//
//  対策: cgOffset.x/zの変更前後で「基準点」がローカル座標系内でどれだけ動いたか
//  を求め、現在の船体姿勢(heading/pitch/roll)で回転させてワールド座標系に変換し、
//  その分だけ cgWorldX/physics.y/cgWorldZ を同時にずらして補償する。
//  これにより、基準点(=重心)が変わってもメッシュ自体は同じワールド位置に留まり、
//  「重心マーカーだけが船体上の新しい位置に動き、船体メッシュは動かない」という
//  直感的な挙動になる。
// ============================================================
function reanchorWorldPositionForPinOffsetChange(oldPinLocal, newPinLocal) {
    if (typeof shipGroup === 'undefined' || !shipGroup) return;
    const rotY = (physics.heading * Math.PI) / 180;
    const finalEuler = new THREE.Euler(physics.pitch || 0, rotY, physics.roll || 0, 'YXZ');
    const delta = new THREE.Vector3(
        newPinLocal.x - oldPinLocal.x,
        newPinLocal.y - oldPinLocal.y,
        newPinLocal.z - oldPinLocal.z
    ).applyEuler(finalEuler);
    physics.cgWorldX += delta.x;
    physics.y         += delta.y;
    physics.cgWorldZ += delta.z;
}

// 現在のcgOffset.x/y/z・waterlineOffsetYから「scaled pinOffsetローカル座標」を求める
// （17-main-loop.jsのpinOffsetScaledと同じ定義: cgOffset.x/zとwaterlineOffsetYに
//   physScaleを掛けたもの。cgOffset.yはこの基準点には使われていない点に注意）。
function _currentPinOffsetScaled() {
    const physScale = Math.max(0.25, physics.scale || 1);
    return {
        x: physics.cgOffset.x * physScale,
        y: physics.waterlineOffsetY * physScale,
        z: physics.cgOffset.z * physScale,
    };
}



function sanitizePhysics() {
    const values = [
        physics.y, physics.vy, physics.speed, physics.targetSpeed,
        physics.heading, physics.turnRate, physics.pitch, physics.vPitch,
        physics.roll, physics.vRoll, physics.buoyancy, physics.draftOffset,
        physics.waveRoughness, physics.waveWidth, physics.maxSpeed, physics.scale,
        physics.turningRadiusFactor, physics.rudderAngle, physics.telegraphState,
        physics.cgWorldX, physics.cgWorldZ, physics.mass, physics.waterlineOffsetY,
        physics.cgOffset.x, physics.cgOffset.y, physics.cgOffset.z,
        physics.rudderOffset.x, physics.rudderOffset.y, physics.rudderOffset.z
    ];

    if (values.some((v) => !Number.isFinite(v))) {
        Object.assign(physics, {
            y: 0, vy: 0, speed: 0, targetSpeed: 0, heading: 0, turnRate: 0,
            pitch: 0, vPitch: 0, roll: 0, vRoll: 0, buoyancy: 12, draftOffset: 0,
            waveRoughness: 1, waveWidth: 1, maxSpeed: 13, scale: 1,
            turningRadiusFactor: 5, rudderAngle: 0, telegraphState: 0,
            cgWorldX: 0, cgWorldZ: 0, mass: 1.5, waterlineOffsetY: -0.5
        });
        physics.cgOffset.x = 0; physics.cgOffset.y = -0.5; physics.cgOffset.z = 0;
        physics.rudderOffset.x = 0; physics.rudderOffset.y = -1; physics.rudderOffset.z = -7;
        shipHistory.length = 0;
        window.lastHistoryTime = 0;
    }

    physics.y = THREE.MathUtils.clamp(physics.y, -80, 80);
    physics.vy = THREE.MathUtils.clamp(physics.vy, -12, 12);
    physics.speed = THREE.MathUtils.clamp(physics.speed, -physics.maxSpeed * 0.5, physics.maxSpeed);
    physics.turnRate = THREE.MathUtils.clamp(physics.turnRate, -15, 15);
    physics.rudderAngle = THREE.MathUtils.clamp(physics.rudderAngle, -35, 35);
    physics.telegraphState = Math.max(-3, Math.min(3, physics.telegraphState));
    physics.vPitch = THREE.MathUtils.clamp(physics.vPitch, -4, 4);
    physics.vRoll = THREE.MathUtils.clamp(physics.vRoll, -4, 4);

    if (Math.abs(physics.heading) > 100000) {
        physics.heading = normalizeHeadingDegrees(physics.heading);
    }
}

function getWakeHeight(x, z, t) {
    const historyLen = shipHistory.length;
    if (historyLen < 2) return { y: 0, foam: 0 };

    let wakeY = 0, wakeFoam = 0;
    const scaleRatio = physics.scale / 12.0;
    const maxDist2 = 8000.0 * scaleRatio * scaleRatio;
    const maxDist = Math.sqrt(maxDist2);

    // v105: GPU版(wakeHF, 04-scene-and-water-init.js)と同じロジックに揃えた。
    // 波長のピッチ周期連動は物理計算(浮力)にも効かせるため、このCPU版でも
    // 同じ式にしておく必要がある（片方だけ更新すると見た目と実際に船が
    // 受ける力がズレてしまう）。
    const pitchOmega = Math.max(0.05, physics.pitchNaturalOmega || 1.0);
    const pitchWavelenScale = THREE.MathUtils.clamp(1.8 / Math.sqrt(pitchOmega), 0.5, 4.0);

    const hp = (typeof window !== 'undefined') ? window.hullProfile : null;
    const hullReady = hp && hp.ready && hp.slices && hp.slices.length > 1;
    const hullHalfLen = hullReady ? hp.halfLen * physics.scale : 6.0 * physics.scale;
    // v106: 波源(船首・船尾)の位置は、固定オフセット(6.0*physScale)ではなく
    // 実際の船体スキャンから得た半長(hullHalfLen)に合わせる。従来の固定値は
    // 喫水線が実際に閉じる先端よりだいぶ手前になっていることが多く、
    // 引き波の発生源が船首から後ろにずれて見える原因だった。
    const L = hullHalfLen;

    for (let i = 0; i < historyLen; i++) {
        const p = shipHistory[i];
        const absSpeed = Math.abs(p.speed);
        if (absSpeed < 0.5) continue;

        const dt = t - p.t;
        if (dt <= 0 || dt > 15.0) continue;

        // Quick bounding-box reject before computing per-source trig
        const dxp = x - p.x, dzp = z - p.z;
        if (dxp * dxp + dzp * dzp > (maxDist + L) * (maxDist + L)) continue;

        const sinH = Math.sin(p.headingRad);
        const cosH = Math.cos(p.headingRad);

        // v103/v104: 船体内側マスク（実喫水線輪郭ベース）
        const lateralDist = Math.abs(dxp * cosH - dzp * sinH);
        const alongDist = dxp * sinH + dzp * cosH;
        let hullMask = 1.0;
        if (hullReady) {
            const alongNorm = THREE.MathUtils.clamp(alongDist / Math.max(0.01, hullHalfLen), -1, 1);
            const hullW = _hullHalfWidthAtNorm(alongNorm) * physics.scale;
            const withinHullLen = 1.0 - smoothstepJS(hullHalfLen * 0.98, hullHalfLen * 1.08, Math.abs(alongDist));
            // v124: 0.9〜1.3では際の遷移帯が広く、船体のすぐ内側でもマスクが
            // 完全に0にならず、波が薄く透けて見える原因になっていた
            // (v121/v122で振幅を上げ、v123で船首波を持続的に立たせたことで
            // この薄い透け残りが目立つようになった)。withinHullLenと同じ
            // 0.98〜1.08の狭い帯に絞り、実喫水線のすぐ内側は確実に0にする。
            const lateralMask = smoothstepJS(hullW * 0.98, hullW * 1.08, lateralDist);
            hullMask = THREE.MathUtils.lerp(1.0, lateralMask, withinHullLen);
        }

        const sources = [
            { x: p.x + sinH * L, z: p.z + cosH * L, isBow: true },
            { x: p.x - sinH * L, z: p.z - cosH * L, isBow: false }
        ];

        for (let s = 0; s < 2; s++) {
            const src = sources[s];
            const dx = x - src.x;
            const dz = z - src.z;
            const d2 = dx * dx + dz * dz;

            if (d2 > maxDist2) continue;
            const d = Math.sqrt(d2);
            if (d < 0.1) continue;

            const fullness = src.isBow ? physics.bowFullness : physics.sternFullness;
            const waveSpeed = (3.0 + absSpeed * 0.2) * scaleRatio;
            const waveRadius = waveSpeed * dt;
            const distanceToWaveFront = d - waveRadius;
            const absDistToWaveFront = Math.abs(distanceToWaveFront);
            const waveLength = (5.0 + absSpeed * 0.3) * scaleRatio * Math.sqrt(fullness) * pitchWavelenScale;

            if (absDistToWaveFront < waveLength * 1.5) {
                // v122: 「今の倍くらい」の要望でv121の値からさらに2倍(0.033→0.066, 0.024→0.048)
                const ampFactor = src.isBow ? 0.066 : 0.048;
                const amp = absSpeed * ampFactor * fullness * scaleRatio * (1.0 - d / (90.0 * scaleRatio)) * (1.0 - dt / 15.0);
                if (amp <= 0) continue;

                const k = 6.283 / waveLength;
                const phase = distanceToWaveFront * k;
                const angleToVertex = Math.atan2(dx, dz);
                const relativeAngle = Math.abs(normalizeAngle(angleToVertex - p.headingRad));

                const sideGate = smoothstepJS(1.30, 1.57, relativeAngle);
                if (sideGate > 0) {
                    const theta = Math.PI - relativeAngle;
                    const kelvinAngle = 0.34;
                    const angleDist = theta - kelvinAngle;
                    const absAngleDist = Math.abs(angleDist);
                    const angleEnvelope = (Math.exp(-absAngleDist * absAngleDist * (11.0 / fullness)) + Math.exp(-theta * theta * (8.0 / fullness)) * 0.3) * sideGate;

                    // v123: v120で船首もシンプルな正弦波(sin(phase))に戻したところ、船首波が
                    // 「立って下がって立って下がって」と往復してしまう問題が判明。
                    // 波面(phase≈0)のごく近くだけ通常どおり正弦波で立ち上がらせ、そこから
                    // 内側(船体寄り、phaseが負に進む)へ入ったらsin波を使わず一定のプロファイルを
                    // 維持することで、船首すぐ脇の盛り上がりが往復せず立ちっぱなしになるようにした。
                    // 角度方向の絞り込み(V字稜線)自体は使うが、先端ブースト(bowTipBoost)は
                    // 今回の件と無関係なので復活させていない。
                    let h;
                    if (src.isBow) {
                        const ridge = Math.exp(-absAngleDist * absAngleDist * (60.0 / fullness)) * sideGate;
                        const innerDip = smoothstepJS(0.0, 0.45, angleDist) * (1.0 - smoothstepJS(0.45, 1.1, angleDist)) * sideGate;
                        const bowProfile = ridge - innerDip * 0.35;

                        const distLift = 1.0 - smoothstepJS(-1.6, 0.3, phase);
                        const liftBlend = 1.0 - smoothstepJS(Math.PI, Math.PI * 2.5, Math.abs(phase));
                        const wave = THREE.MathUtils.lerp(Math.sin(phase) * angleEnvelope, bowProfile * distLift, liftBlend);
                        h = amp * wave;
                    } else {
                        h = amp * Math.sin(phase) * angleEnvelope;
                    }
                    h *= hullMask;
                    wakeY += h;

                    if (h > 0.02 && absDistToWaveFront < waveLength * 0.5) {
                        wakeFoam += (h / waveLength) * angleEnvelope * (19.0 + absSpeed * 0.6) * hullMask;
                    }
                }
            }
        }
    }
    return { y: wakeY, foam: Math.min(1.0, wakeFoam) };
}

// GLSLのsmoothstepと同じ定義（THREE.MathUtils.smoothstepは引数順が異なるため専用ヘルパーを用意）
function smoothstepJS(edge0, edge1, x) {
    const t = THREE.MathUtils.clamp((x - edge0) / Math.max(1e-6, edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
}

function getWaveCrestAndHeight(x, z, t) {
    const h = physics.waveRoughness;
    // ── 波の急峻さ(高さ÷波長)を現実的な範囲に保つ自動カップリング ──────────
    // waveRoughness(波高)とwaveWidth(波長)が完全に独立したスライダーだと、
    // 波高だけを上げて波長を変えないと「鋭く尖った、非現実的に急な」波になる。
    // 実際の海洋波は波高/波長比(波形勾配)に物理的な上限があり(砕波限界は
    // 概ね1/7、一般的な外洋うねりは1/15〜1/30程度)、これを超えると波は崩れる。
    // ここでは最も急峻な成分(k1, 振幅係数1.82)を基準に、目標勾配
    // WAVE_STEEPNESS_MAX(≒1/15)を超えないために必要な最低波長(=最低waveWidth)
    // を波高から逆算し、ユーザー指定のwaveWidthとの大きい方を採用する。
    // これにより「波を高くするほど自動的に波長も伸びる」物理的に自然な挙動になり、
    // 短波長×大振幅という不自然な急加速度の原因を取り除く。
    const WAVE_STEEPNESS_MAX = 1 / 15;
    // 係数導出: steepness1 = 1.82*h*0.018/(2π*w) ≒ 0.005214*h/w
    //           → w_min = 0.005214*h / WAVE_STEEPNESS_MAX
    const AUTO_WIDTH_COEFF = 0.005214 / WAVE_STEEPNESS_MAX; // ≒0.0782
    const autoWidthMin = h * AUTO_WIDTH_COEFF;
    const w = Math.max(physics.waveWidth, autoWidthMin);

    // ── v95: 風向・風速を波形に反映 ──────────────────────────────
    // ① 向き: k1〜k4の位相計算に使うxz座標を風向(windDir)の分だけ回転させる。
    //    元の式は(x, z)を固定の軸に対して斜めに組み合わせていただけ（風とは無関係）
    //    だったが、この座標系ごと回転させることで「うねり・チョップの向き」が
    //    風向スライダーと連動するようになる。各成分間の相対角（k1とk2が交差する
    //    見た目の複雑さ等）は保ったまま、全体の向きだけが風について回る。
    // ② シャープさ: crest(泡・砕波の判定に使う値)だけ、風速に応じて指数
    //    (crestPow)を上げてピークをより狭く・鋭くする。height側（浮力計算が
    //    使う実際の波高）は据え置きなので、波の高さ自体はwaveRoughnessスライダーの
    //    支配のまま保たれ、見た目の「先端の尖り方」だけが強風ほどシャープになる。
    const windRad = (typeof physics.windDir === 'number') ? physics.windDir * Math.PI / 180 : 0;
    const wCos = Math.cos(windRad), wSin = Math.sin(windRad);
    const rx = x * wCos - z * wSin;
    const rz = x * wSin + z * wCos;
    const windSpd = (typeof physics.windSpeed === 'number') ? physics.windSpeed : 0;
    const windSharpen = Math.min(1.6, windSpd / 18); // 無風0 〜 強風(30kt程度)で最大1.6

    const k1 = 0.018 / w;
    const p1 = rx * k1 + rz * (k1 * 0.6) + t * 0.38;
    const s1 = Math.sin(p1);
    const s1Max = Math.max(s1, 0);
    const w1 = (s1Max * s1Max) * 2.0 - 0.6;

    const k2 = 0.026 / w;
    const p2 = -rx * k2 + rz * (k2 * 0.8) + t * 0.52;
    const s2 = Math.sin(p2);
    const s2Max = Math.max(s2, 0);
    const w2 = (s2Max * s2Max) * 2.0 - 0.7;

    const k3 = 0.009 / w;
    const p3 = rz * k3 + t * 0.22;
    const s3 = Math.sin(p3);
    const w3 = s3; // 最も波長が長い成分＝「うねり」

    const k4 = 0.072 / w;
    const p4 = rx * (k4 * 0.7) + rz * k4 - t * 0.95;
    const s4 = Math.sin(p4);
    const w4 = s4 * 0.5; // 最も波長が短い成分＝「チョップ」

    // Stage5: うねり(k3)とチョップ(k4)を個別スライダーで独立に強調できるようにする。
    // k1/k2は「一般的な海況のベース」として据え置き、この2成分だけ倍率をかける。
    const swellMul = (typeof physics.swellStrength === 'number') ? physics.swellStrength : 1.0;
    const chopMul  = (typeof physics.chopStrength  === 'number') ? physics.chopStrength  : 1.0;

    const height = h * (w1 * 1.3 + w2 * 0.7 + w3 * 0.55 * swellMul + w4 * 0.22 * chopMul);
    const crestPow = 2.0 + windSharpen; // 無風=2.0（従来通り）、強風ほど尖度が上がる
    const c1 = Math.pow(s1Max, crestPow);
    const c2 = Math.pow(s2Max, crestPow);
    const c3 = s3 > 0 ? s3 * s3 : 0;
    const c4 = s4 > 0 ? Math.pow(s4, crestPow) : 0;
    const crest = (c1 * 1.3 + c2 * 0.7 + c3 * 0.55 * swellMul + c4 * 0.22 * chopMul) * 0.361;

    return { height, crest };
}


function getWaveHeight(x, z, t, excludeWake = false) {
    const oceanWave = getWaveCrestAndHeight(x, z, t).height;
    const wakeWave = excludeWake ? 0 : getWakeHeight(x, z, t).y;
    return oceanWave + wakeWave;
}

function createWaterNormalMap(scale, repeatOverride) {
    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    const imgData = ctx.createImageData(size, size);
    const sc = scale || 1.0;

    // v161-v4: 「波の頭をもっとシャープに」「もう少し荒く」の要望に対応。
    // v161-v3の12オクターブ(単純なsin合成、丸い凹凸)に加え、"リッジ"成分
    // （1-|sin(p)|で作る、頂点が尖った山）を別の8オクターブで作り、両者を
    // ブレンドする。sin成分だけだと山も谷もなだらかな丸みを帯びるが、
    // リッジ成分を混ぜることで頂点がキュッと立った鋭い凹凸になる。
    // 周波数もv3よりやや低め(粒を大きく)、振幅もやや強めにして「荒さ」を出す。
    //
    // v162: 「凹凸の深さ高さが出てる感じがしない」への対応。上のv4時点では
    // 山と谷の"形"はシャープになったが、法線ベクトルとしての振幅(sx/sy)が
    // 素のsin合成のままだったため、多数のオクターブを足し合わせる過程で
    // 振幅同士が打ち消し合い、中間値付近に収束しがちだった（＝法線マップの
    // 色が全体的に灰色っぽく平坦になり、結果として陰影が弱く見える）。
    // → 最終合成後にS字カーブ(コントラストカーブ)を通し、0.5(=平ら)付近の
    //   値を中央へさらに寄せず、逆に0.5から離れた値ほど強調するようにして、
    //   谷は谷らしく暗く、山は山らしく明るく出るようにする。
    const CONTRAST_POW = 0.62; // 1.0=無補正、小さいほど中間値が0/1側へ強く引っ張られコントラストが上がる
    function applyContrast(v) {
        // vは0..1。0.5を中心にした符号付き距離をpowで強調してから戻す。
        const d = v - 0.5;
        const sign = d >= 0 ? 1 : -1;
        const strong = Math.pow(Math.abs(d) * 2.0, CONTRAST_POW) * 0.5;
        return 0.5 + sign * strong;
    }
    let seed = 20250815; // 固定シード：この関数の結果が毎回同じになるようにする
    function makeRand(seedStart) {
        let s = seedStart;
        return function nextRand() {
            s = (s * 1103515245 + 12345) & 0x7fffffff;
            return (s % 100000) / 100000;
        };
    }
    function buildOctaves(n, seedStart, freqLo, freqHi, ampLo, ampHi) {
        const rnd = makeRand(seedStart);
        const arr = [];
        for (let i = 0; i < n; i++) {
            const ang = rnd() * 360;
            const freq = (freqLo + rnd() * (freqHi - freqLo)) * sc;
            const amp = ampLo + rnd() * (ampHi - ampLo);
            const phase = rnd() * 6.283;
            const rad = ang * Math.PI / 180;
            arr.push({ dx: Math.cos(rad) * freq, dy: Math.sin(rad) * freq, amp: amp, phase: phase });
        }
        return arr;
    }
    // ベース成分（なだらかな凹凸のsin合成）と、リッジ成分（尖った山）を別々の
    // 乱数列で生成する（同じ乱数を使うと2つの成分が同じ場所で重なり方向性が
    // 揃ってしまうため、シード違いで独立させる）。
    const baseOctaves  = buildOctaves(12, seed,       0.11, 0.65, 0.10, 0.34);
    const ridgeOctaves = buildOctaves(8,  seed + 7654, 0.15, 0.80, 0.13, 0.32);
    const ridgeMix = 0.5; // リッジ成分の混ぜ具合（0=丸い凹凸のみ、1=尖った山のみ）

    // v163: 視差マッピング(Parallax Mapping)用のハイトマップをBチャンネルに追加。
    // 「水平に近い角度で見ると法線マップだけでは立体感が出ない」という相談への対応。
    // 法線マップは陰影を偽装するだけで実際の凹凸位置はズレないため、水平視点では
    // 「本来手前の波が奥を隠すはず」の視差が一切出ず、平坦さがバレやすい。
    // 視差マッピングはこの高さ情報を使ってUVをずらし、疑似的な視差を作る。
    //
    // 高さの合成には既存のbaseOctaves/ridgeOctavesをそのまま再利用する（新しい
    // 乱数列は増やさない＝計算コストの増加をこのループ内のsin加算1回分に留める）。
    // ただし既存のnx/ny(XY法線)と同じ位相のままだと相関が強く出すぎ、視差の
    // ズレる方向がXY法線の陰影と重なりすぎて不自然になるため、定数位相オフセット
    // (HEIGHT_PHASE_OFFSET)を1つ加えて緩く独立させている（Node.js上で相関係数
    // 約-0.09、ほぼ無相関であることを検証済み）。
    // これは物理的に厳密な「法線=高さの勾配」の関係ではないが、視差マッピング
    // 自体が元々疑似効果なので、視覚的にそれらしい視差が付けば十分という判断。
    const HEIGHT_PHASE_OFFSET = 1.732;

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const idx = (y * size + x) * 4;
            let sx = 0, sy = 0;
            for (let i = 0; i < baseOctaves.length; i++) {
                const o = baseOctaves[i];
                const p = x * o.dx + y * o.dy;
                sx += Math.sin(p) * o.amp;
                sy += Math.sin(p + o.phase) * o.amp;
            }
            let rx = 0, ry = 0;
            let hBase = 0, hRidge = 0;
            for (let i = 0; i < ridgeOctaves.length; i++) {
                const o = ridgeOctaves[i];
                const p = x * o.dx + y * o.dy;
                const s1 = Math.sin(p);
                const s2 = Math.sin(p + o.phase);
                // 1 - |sin| で頂点が尖った山を作り、元のsinの符号を掛けて
                // 山と谷それぞれの向きを保つ。
                rx += (1.0 - Math.abs(s1)) * (s1 >= 0 ? 1 : -1) * o.amp;
                ry += (1.0 - Math.abs(s2)) * (s2 >= 0 ? 1 : -1) * o.amp;
            }
            // 高さ専用の合成（baseOctavesはHEIGHT_PHASE_OFFSET付きのsinで、
            // ridgeOctavesは同じオフセットを使ったリッジ成分で計算）。
            for (let i = 0; i < baseOctaves.length; i++) {
                const o = baseOctaves[i];
                const p = x * o.dx + y * o.dy + HEIGHT_PHASE_OFFSET;
                hBase += Math.sin(p) * o.amp;
            }
            for (let i = 0; i < ridgeOctaves.length; i++) {
                const o = ridgeOctaves[i];
                const p = x * o.dx + y * o.dy + HEIGHT_PHASE_OFFSET;
                const s1 = Math.sin(p);
                hRidge += (1.0 - Math.abs(s1)) * (s1 >= 0 ? 1 : -1) * o.amp;
            }
            const fx = sx * (1.0 - ridgeMix) + rx * ridgeMix;
            const fy = sy * (1.0 - ridgeMix) + ry * ridgeMix;
            const fh = hBase * (1.0 - ridgeMix) + hRidge * ridgeMix;
            const nx = applyContrast(Math.max(0, Math.min(1, fx + 0.5)));
            const ny = applyContrast(Math.max(0, Math.min(1, fy + 0.5)));
            const nh = applyContrast(Math.max(0, Math.min(1, fh + 0.5)));

            imgData.data[idx] = Math.floor(Math.max(0, Math.min(1, nx)) * 255);
            imgData.data[idx + 1] = Math.floor(Math.max(0, Math.min(1, ny)) * 255);
            imgData.data[idx + 2] = Math.floor(Math.max(0, Math.min(1, nh)) * 255);
            imgData.data[idx + 3] = 255;
        }
    }
    ctx.putImageData(imgData, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    // v162: 大波用の第3マップは模様自体の周波数(scale)を下げただけでは足りず、
    // テクスチャのタイリング回数(repeat)も一緒に下げないと、結局細かく繰り返されて
    // 「大きなうねり」には見えない。第3引数で個別に指定できるようにする
    // （未指定時は従来通り88のまま＝wNorm1/wNorm2の挙動は変えない）。
    const rep = repeatOverride || 88;
    tex.repeat.set(rep, rep);
    return tex;
}

