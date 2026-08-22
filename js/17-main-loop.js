function animate() {
    requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.02);
    if (dt <= 0) return;
    const t = clock.getElapsedTime();
    // 物理早送り倍率を適用したdt（見た目・時刻はdtのまま、船の動き・加速・揺れだけ早送り）
    const physicsDt = dt * (typeof physicsSpeed !== 'undefined' ? physicsSpeed : 1.0);

    // 時間速度倍率を適用（固定時は進めない、等速(1:1)はsec/secで実時間1日=24h）
    if (!timeFrozen) {
        // dayDuration=15*60秒でゲーム内1日 → 等速(×1)は実時間86400秒(24h)で1日
        const baseSpeed = physics.dayDuration / 86400; // 通常速度の比率
        const mult = TIME_SPEED_STEPS[timeSpeedIndex] || 96;
        physics.gameTime += dt * baseSpeed * mult;
    }
    physics.dayProgress = (physics.gameTime / physics.dayDuration) % 1;
    if (!physics.moonPhaseManual) {
        const totalDays = physics.gameTime / physics.dayDuration;
        physics.moonPhase = (totalDays / 29.5) % 1.0;
        $('phase-slider').value = physics.moonPhase;
        $('phase-num').value = physics.moonPhase.toFixed(2);
    }
    updateDayNightCycle(physics.dayProgress);
    updateSunShadowFollow();               // v83: 太陽シャドウカメラを船へ追従
    if (typeof maybeUpdateEnvironmentMap === 'function') maybeUpdateEnvironmentMap(dt); // v83: 空のIBL環境光を数秒おきに再撮影
    // 引き波波源点のワールド座標を heading+modelOffset.ry で毎フレーム更新
    if (typeof updateHullSlicePositions === 'function') updateHullSlicePositions();
    updateHullGlowUniforms(); // 船の移動・回転に合わせて内壁グローの位置・反転設定をGPUへ反映
    // エリアライト枠をareaNodeの変換に追随させる
    if (typeof glbLights !== 'undefined') {
        glbLights.forEach(l => {
            if (l.userData.areaBoxHelper && l.userData.areaBoxHelper.visible && typeof updateAreaLightBoxHelper === 'function') {
                updateAreaLightBoxHelper(l);
            }
        });
    }

    if (skyMesh && skyMesh.material.uniforms) {
        const isNightNow = (physics.dayProgress > 0.75 || physics.dayProgress < 0.25);
        if (t >= nextMeteorTime && isNightNow) {
            skyMesh.material.uniforms.meteorTime.value = t;
            nextMeteorTime = t + 20.0 + Math.random() * 70.0;
        }
        const totalDays2 = physics.gameTime / physics.dayDuration;
        if (totalDays2 >= nextAuroraDay) {
            auroraActive = Math.min(1.0, auroraActive + dt * 0.04);
            if (totalDays2 >= nextAuroraDay + 0.35) {
                auroraActive = Math.max(0.0, auroraActive - dt * 0.015);
                if (auroraActive <= 0.0) nextAuroraDay = totalDays2 + 25.0 + Math.random() * 9.0;
            }
        }
        const sunH2 = Math.sin((physics.dayProgress - 0.25) * Math.PI * 2);
        const nightF2 = Math.max(0.0, -sunH2);
        skyMesh.material.uniforms.auroraStrength.value += (auroraActive * nightF2 - skyMesh.material.uniforms.auroraStrength.value) * 0.05;
    }

    if (document.activeElement !== $('time-slider') && document.activeElement !== $('time-num')) {
        const currentHour = physics.dayProgress * 24.0;
        $('time-slider').value = currentHour;
        $('time-num').value = currentHour.toFixed(1);
    }
    // time-speed-label を timeFrozen 状態で常時更新
    const tsl = $('time-speed-label');
    if (tsl && !timeFrozen) {
        const m = TIME_SPEED_STEPS[timeSpeedIndex];
        tsl.textContent = m === 1 ? '×1 等速' : '×' + m;
    }

    const isDesignMode = $('settings-panel').classList.contains('open');
    // 視点(見張り台)モード中はOrbitControlsの入力を無効化（専用ドラッグで自由見回し）
    controls.enabled = isDesignMode || cameraMode !== 'viewpoint';

    // ── 船体パラメータ（このフレーム内では不変。サブステップ計算と、後段の配置計算の両方で使う） ──
    const physScale = Math.max(0.25, physics.scale);
    // 船首・船体中部・船尾の位置は、可能であれば実際にスキャンした船体形状
    // (window.hullProfile.halfLen/halfBeam) を使う。未スキャン時はデフォルト値にフォールバック。
    const hpForPhys = window.hullProfile;
    const len = ((hpForPhys && hpForPhys.ready) ? hpForPhys.halfLen  : 6.0) * physScale;
    const wid = ((hpForPhys && hpForPhys.ready) ? hpForPhys.halfBeam : 2.0) * physScale;
    const cgXScaled = physics.cgOffset.x * physScale, cgZScaled = physics.cgOffset.z * physScale;
    // 喫水線の基準点（重心とは独立）。デフォルトはcgOffset.yと同じ値で、既存挙動を保つ。
    const waterlineYScaled = physics.waterlineOffsetY * physScale;
    const M = Math.max(1.0, physics.mass * 5.0); // massは排水量(千トン)。自動算出または手動設定。ロールの慣性質量に使用。

    // ── 船体の形状・大きさから自動的に求まる復元力係数 ──────────────────
    // ・横揺れ(ロール)方向の復元力は主に「全幅／全長」比に左右される。
    //   基準比率(全幅2.0／全長6.0≒0.333)より幅広い(ビーミーな)船型ほど復元力が
    //   強く(キビキビ揺れ戻る)、幅が狭く長い(スリムな)船型ほど弱く(ゆったり揺れる)なる。
    const ROLL_SHAPE_REF = 0.3333;
    const rollShapeFactor = THREE.MathUtils.clamp((wid / len) / ROLL_SHAPE_REF, 0.6, 2.2);
    // ・縦揺れ(ピッチ)の船首尾肥痩は、実物理計算では船体形状(halfWidth)から
    //   直接モーメントに反映されるため、人為的な係数は不要になった。

    // ============================================================
    // 物理サブステップ
    // physicsSpeed(早送り倍率)を上げて1フレームあたりのphysicsDtが大きくなると、
    // 横揺れ/縦揺れ/上下動のばね-ダンパー系や旋回追従の積分が数値的に発散し、
    // 「船が空を飛ぶ」「船の回転軸が暴れ出す」といった破綻を起こしていた。
    // これは「stiffなばね系を粗い時間刻みでオイラー積分する」典型的な数値不安定化。
    // 安全な刻み幅(PHYSICS_SUBSTEP_MAX)以下になるよう分割して複数回積分することで、
    // physicsSpeedをどれだけ上げても破綻しないようにする。
    // physicsSpeed=1倍・通常フレームレート時はサブステップ数=1になり、既存の挙動と完全に一致する。
    // ============================================================
    const PHYSICS_SUBSTEP_MAX = 0.02;
    const numSubsteps = isDesignMode ? 1 : Math.max(1, Math.ceil(physicsDt / PHYSICS_SUBSTEP_MAX));
    const subDt = physicsDt / numSubsteps;

    let rotY = (physics.heading * Math.PI) / 180;

    for (let _sub = 0; _sub < numSubsteps; _sub++) {
        // --- 舵 ---
        if (!isDesignMode) {
            if (keys.a || touchLeft) physics.rudderAngle = Math.max(-35.0, physics.rudderAngle - 50 * subDt);
            else if (keys.d || touchRight) physics.rudderAngle = Math.min(35.0, physics.rudderAngle + 50 * subDt);
            else physics.rudderAngle += (0.0 - physics.rudderAngle) * 6 * subDt;
        } else {
            physics.rudderAngle += (0.0 - physics.rudderAngle) * 6 * subDt;
        }

        // --- 速度（テレグラフ追従） ---
        const maxSpd = physics.maxSpeed;
        const speeds = { '-3': -maxSpd * 0.5, '-2': -maxSpd * 0.3, '-1': -maxSpd * 0.15, '0': 0.0, '1': maxSpd * 0.3, '2': maxSpd * 0.6, '3': maxSpd };
        physics.targetSpeed = isDesignMode ? 0.0 : speeds[physics.telegraphState];
        // 推進器の加速度（船首尾軸に沿った推力）。この後の heave 計算で、
        // 船体ピッチ角だけ傾けて鉛直成分も加えるために保持しておく。
        const thrustAccMag = (physics.targetSpeed - physics.speed) * (0.3 / physics.mass);
        physics.speed += thrustAccMag * subDt;
        physics.speed = THREE.MathUtils.clamp(physics.speed, -maxSpd * 0.5, maxSpd);

        // --- 旋回・船首方位 ---
        const LReal = 12.0 * physics.scale;
        const R = LReal * physics.turningRadiusFactor;
        const speedMps = physics.speed * 0.514;
        const maxRudder = 35.0;

        const rudderLeverArm = Math.abs(physics.rudderOffset.z * physics.scale - physics.cgOffset.z * physics.scale);
        const rudderEffectiveness = 1.0 + rudderLeverArm * 0.02;
        const targetTurnRateRad = -(speedMps / R) * (physics.rudderAngle / maxRudder);
        const targetTurnRateDeg = targetTurnRateRad * (180.0 / Math.PI);

        if (isDesignMode) {
            physics.turnRate += (0.0 - physics.turnRate) * 3.0 * subDt;
        } else {
            physics.turnRate += (targetTurnRateDeg * rudderEffectiveness - physics.turnRate) * 3.0 * subDt;
            physics.heading += physics.turnRate * subDt;
        }

        rotY = (physics.heading * Math.PI) / 180;
        // 推進器は船首尾軸（=船体ピッチを含む実際の向き）と完全に平行に押し出すため、
        // 水平方向の進出量は cos(pitch) 分だけ減る（ピッチが付くほど、推力の一部が
        // 鉛直成分に回される）。鉛直成分は下のheave計算で thrustAccMag から加える。
        const cosPitchFwd = Math.cos(physics.pitch);
        const dx = isDesignMode ? 0 : Math.sin(rotY) * cosPitchFwd * physics.speed * subDt;
        const dz = isDesignMode ? 0 : Math.cos(rotY) * cosPitchFwd * physics.speed * subDt;
        physics.cgWorldX += dx; physics.cgWorldZ += dz;

        // ── 喫水線基準の目標Y計算 ──────────────────────────────────
        // physics.y はshipGroupのワールドY原点位置。shipGroup.position.y の計算
        // (pinOffsetScaled) で waterlineYScaled が引かれるため、targetY自体は
        // 「waterSurface - draftOffset」のみでよい。
        const _wlWaterSurface = getWaveHeight(physics.cgWorldX, physics.cgWorldZ, t, true);
        window._physicsWaveY  = _wlWaterSurface; // _getHullDisplacement の空中チェックで参照
        const _targetYBase    = _wlWaterSurface - physics.draftOffset;

        // ── 波面自体の鉛直方向の変化速度 ────────────────────────────────
        // 「波が後ろに去って海水面が急速に下がり、船がついていけず宙に浮く」
        // という現象の正体は、ばね(位置偏差)だけで船を追従させているため、
        // 波面の下降速度がheaveの応答速度を上回ると原理的に追いつけないこと。
        // ここで波面自体の上下速度を直接計算し、下のheave計算でフィードフォワード
        // として加えることで、波に「乗っている」間は船もその速度に追従しやすくする。
        const rawWaveSurfaceVel = (typeof window._prevWlWaterSurface === 'number' && subDt > 1e-6)
            ? (_wlWaterSurface - window._prevWlWaterSurface) / subDt
            : 0;
        window._prevWlWaterSurface = _wlWaterSurface;

        // 【2026-07 追加修正】単純な1階差分は、波の高周波成分やサンプリング数値誤差を
        // そのまま増幅してノイズの多い値になりやすい。このノイズがWAVE_FOLLOW_GAIN経由で
        // そのままheave加速度に注入されると、波高が低い穏やかな設定でもbowExcessVolが
        // 0↔200m³超で大きく往復し続ける（＝船首が細かく暴れ続ける）一因になっていた
        // 可能性が高い。低域通過フィルタ(指数移動平均、時定数0.15秒)で平滑化し、
        // 本来捉えたい「波にゆっくり乗る」低周波成分は残しつつ、高周波ノイズは
        // 減衰させる。波の周期(通常数秒)に対し0.15秒は十分短いため、本来の
        // 波追従の応答性はほぼ損なわれない。
        const WAVE_VEL_SMOOTH_TAU = 0.15; // [秒]
        const _velAlpha = subDt > 0 ? 1 - Math.exp(-subDt / WAVE_VEL_SMOOTH_TAU) : 1;
        window._waveSurfaceVelSmoothed = (typeof window._waveSurfaceVelSmoothed === 'number')
            ? window._waveSurfaceVelSmoothed + (rawWaveSurfaceVel - window._waveSurfaceVelSmoothed) * _velAlpha
            : rawWaveSurfaceVel;
        const waveSurfaceVel = window._waveSurfaceVelSmoothed;

        if (isDesignMode) {
            // 設定パネル中は完全固定 — 揺れ・上下・回転をすべて止める
            physics.vy = 0; physics.vPitch = 0; physics.vRoll = 0;
            physics.pitch = 0; physics.roll = 0;
            physics.y = _targetYBase;
        } else {
            // ════════════════════════════════════════════════════════════
            //  完全物理浮力計算（アルキメデスの原理）── heave + pitch
            // ════════════════════════════════════════════════════════════
            //  船体形状から実際の没水体積・水線面積・浮力モーメントを積分し、
            //  F = ρ・g・V（浮力）と F = m・g（重力）の差をそのままニュートンの
            //  第二法則 a = F/m に通す。バネ定数を手で調整する旧実装と違い、
            //  「水面下にどれだけ沈んでいるか」がそのまま力の大きさになるため、
            //  どんな船・どんな波高でも自然に釣り合い喫水へ収束する。
            //  buoyancyスライダーは、この実物理量に対する倍率（既定1.0=純物理）として残す。
            const RHO_WATER = 1025;          // kg/m³（海水密度）
            const G_REAL    = 9.81;          // m/s²
            const massKg    = physics.mass * 1e6; // 「千トン」単位 → kg（千トン×1000=トン、×1000=kg）
            const buoyMult  = physics.buoyancy / (physics.buoyancyBase || 12.0); // スライダー倍率（既定1.0）

            // ── 質量に応じた応答減衰係数（ヒーブ応答・スラミング減速など複数箇所で共用）──
            // 大型船ほど慣性(運動量)が大きく、同じ波の衝撃力に対する速度変化(Δv=力積/質量)は
            // 小さくなるはず。physics.mass（千トン単位）を基準船型(MASS_REF=1.5≒1500トン級の
            // 小型船)と比較し、massFactor = sqrt(MASS_REF/mass) で応答をスケールダウンする。
            // 小型船(mass<=MASS_REF)では従来通り(factor=1)、大型船ほど0.12倍まで弱まる。
            const MASS_REF = 1.5;
            const massFactor = THREE.MathUtils.clamp(Math.sqrt(MASS_REF / physics.mass), 0.12, 1.0);

            const _buoy = computeHullBuoyancyPhysics(
                physics.cgWorldX, physics.cgWorldZ, rotY, physics.pitch,
                physics.y, waterlineYScaled, physScale, len, t, cgZScaled
            );
            const volSubmerged   = _buoy ? Math.max(0, _buoy.volSubmerged) : 0;
            const AwpReal        = _buoy ? Math.max(0.05, _buoy.Awp) : 1.0;
            const momentVolAboutCG = _buoy ? _buoy.momentVolAboutCG : 0;
            const IwpLong         = _buoy ? Math.max(0.05, _buoy.IwpLong) : 1.0;
            // submergedFrac: 0=完全空中, 1=設計喫水での通常没水（減衰のなめらかなon/offにのみ使用。
            // 力そのものはvolSubmerged/momentVolAboutCGがゼロから連続的に立ち上がるので
            // 人為的なon/off処理は不要）。
            const submergedFrac = _buoy ? _buoy.submergedFrac : 0;

            // ════════════════════════════════════════════════════════════
            //  船首補正（Stage 1）── 波切りリフト・船首抵抗・スラミング
            //  21-bow-stern-effects.js 側で船体形状から自動算出したC1/C2を使用。
            // ════════════════════════════════════════════════════════════
            const _bowF = (typeof computeBowForces === 'function')
                ? computeBowForces(physics.cgWorldX, physics.cgWorldZ, rotY, physics.pitch,
                                    physics.y, waterlineYScaled, physScale, len, t, speedMps, subDt)
                : null;
            // 【2026-07 v71→v72 修正】v71で試した「physics.vy>0の時だけliftForceを
            // 弱める」ヒューリスティックは、実機テストで効果不十分と判明した
            // （slamCountの伸びは緩やかなのに、liveのbowSlamRatioが±の間を
            // 短い周期で往復し続け、水しぶきがほぼ途切れなかった）。
            // 原因は、liftForceが accY の他の項（F_netHeave）とは別枠で加算されて
            // いたため、船体の本物のヒーブ減衰(C_heaveEff, zetaHeave=0.35で
            // 臨界減衰比から算出した「正しい」減衰)を一切受けていなかったこと。
            // v71のヒーリスティックはvyだけを見て事後的に弱めるその場しのぎで、
            // 本来の減衰の物理（バネ=浮力剛性、ダンパー=C_heaveEff）に組み込まれて
            // いなかったため、振動を止めるには弱すぎた。
            // → liftForceをF_netHeaveに直接合算し（下記）、他の浮力と全く同じ
            //   C_heaveEffで一括して減衰されるようにした。ここでは生の力[N]の
            //   まま保持するだけにする。
            const _bowLiftForceRaw = _bowF ? _bowF.liftForce : 0;
            // 減速用加速度 [m/s²]（常に正の大きさ）。
            // 【安全弁】dragForce(C2×bowExcess^1.5×speed²)はSI単位ベースの疑似的な力である
            // 一方、これを直接引き算されるphysics.speedやthrustAccMagは「ノット・
            // 千トン」を使った独自のゲーム内スケールで運用されている。両者を単純に
            // 突き合わせると、大型・高速・鋭い船首の船（Mauretania等）で抵抗が推力を
            // 大きく上回り、「27ノット指示でも全速で6ノットしか出ない」という暴走が
            // 起きていた。
            // → 推力モデルと全く同じ基準(0.3/physics.mass)を使い、「抵抗は指示速度の
            //   最大でも maxBowDragLossFrac 割相当までしか奪えない」という形で
            //   直接キャップする。これにより船のサイズ・速度域によらず一貫して
            //   「大波でもある程度は減速するが、指示速度の大部分は維持できる」
            //   という挙動になる。
            const maxBowDragLossFrac = 0.25; // 波の抵抗だけで指示速度の最大25%までしか奪わない（0.4→0.25、まだ強すぎるとのフィードバックのため再調整）
            const thrustAuthority = 0.3 / Math.max(0.05, physics.mass);
            const MAX_BOW_DRAG_ACCEL = Math.abs(physics.targetSpeed) * maxBowDragLossFrac * thrustAuthority;
            const bowDragAcc = _bowF ? Math.min(_bowF.dragForce / massKg, MAX_BOW_DRAG_ACCEL) : 0;
            window._bowExcessVol = _bowF ? _bowF.bowExcess : 0; // Stage4のグリーンウォーター判定用に公開
            window._volBowDesign = (_bowF && _bowF.volBowDesign) || 0; // 体積ベース正規化用に公開
            window._bowSlamRatioLive = _bowF ? (_bowF.slamRatio || 0) : 0; // 連続値(イベント発火の有無に関わらず毎フレーム更新)

            if (_bowF && _bowF.slammed) {
                // スラミング発生: 瞬間的な減速（水柱・衝撃音等の演出はStage 4以降で追加）
                // 【修正】以前はSLAM_SPEED_DAMP(0.985)を船の規模によらず一律で掛けていたため、
                // 大型船でも小型艇と全く同じ割合(1.5%)だけ速度がガクッと落ちてしまっていた。
                // 大型船ほど運動量(慣性)が大きく、波を1発浴びただけで急減速はしないはず
                // （力積Δp=一定なら、Δv=Δp/massで質量が大きいほど速度変化は小さい）。
                // 上のmassFactor（ヒーブ応答減衰と共用、sqrt(MASS_REF/mass)で大型船ほど
                // 小さくなる係数）を「速度損失分」にだけ掛けることで、基準船型
                // (MASS_REF=1.5≒1500トン級)では従来通りの減速感を保ちつつ、大型船ほど
                // スラミング1回あたりの速度低下がなだらかになるようにする。
                const slamLossFrac = (1 - SLAM_SPEED_DAMP) * massFactor;
                physics.speed *= (1 - slamLossFrac);
                window._bowSlamEvent = { t, impactRate: _bowF.impactRate, slamRatio: _bowF.slamRatio };
                // デバッグ用: ポーポイズ(連続スラミング)が起きていないか件数で確認できるようにする
                window._bowSlamCount = (window._bowSlamCount || 0) + 1;
            }
            // 船首抵抗は「進行方向を妨げる」向きに働くため、speedの符号に関わらず
            // |speed|を減らす方向（前進中は減速、後進中は後進を弱める）に適用する。
            if (Math.abs(physics.speed) > 0.001) {
                const dragDelta = bowDragAcc * subDt * Math.sign(physics.speed);
                if (Math.abs(dragDelta) < Math.abs(physics.speed)) physics.speed -= dragDelta;
                else physics.speed = 0;
            }

            // ════════════════════════════════════════════════════════════
            //  船尾補正（Stage 2）── プロペラのレーシング・船尾スラミング
            // ════════════════════════════════════════════════════════════
            const _sternF = (typeof computeSternForces === 'function')
                ? computeSternForces(physics.cgWorldX, physics.cgWorldZ, rotY, physics.pitch,
                                      physics.y, waterlineYScaled, physScale, len, t, subDt)
                : null;
            if (_sternF) {
                // thrustAccMagはこのサブステップ冒頭で既に全量speedへ適用済みのため、
                // 「本来はefficiency倍しか効かないはずだった分」を事後的に差し引く。
                const thrustLossAcc = thrustAccMag * (1 - _sternF.efficiency);
                physics.speed -= thrustLossAcc * subDt;

                if (_sternF.slammed) {
                    // Bow Slammingと同じ考え方（massFactorで大型船ほど減衰を弱める）を流用
                    const sternSlamLossFrac = (1 - SLAM_SPEED_DAMP) * massFactor;
                    physics.speed *= (1 - sternSlamLossFrac);
                    window._sternSlamEvent = { t, impactRate: _sternF.impactRate, slamRatio: _sternF.slamRatio };
                }
                // レーシング強度(0=通常, 1=完全空転)。Stage6のRPM上昇・振動演出用に公開。
                window._propRacingIntensity = _sternF.racingIntensity;
            }

            // ── デバッグHUD（Stage4調整用）: bowExcess/greenWaterRatio/slamRatioを画面表示 ──
            // 「感覚的に弱い/強い」だけだと係数調整が勘頼りになるため、実測値を
            // 画面の隅に出しておく。不要になったら _updateBowSternDebugHud ごと
            // 削除するか、下の if を false にすれば非表示にできる。
            if (typeof _updateBowSternDebugHud === 'function') {
                const _slamRatioNow = window._bowSlamRatioLive || 0;
                const _slamRatioPeak3s = (typeof _trackBowSlamRatioPeak === 'function')
                    ? _trackBowSlamRatioPeak(_slamRatioNow, t) : _slamRatioNow;
                _updateBowSternDebugHud({
                    volBow: (_bowF && _bowF.volBow) || 0,
                    bowVolBaseline: (_bowF && _bowF.volBowDesign) || 0,
                    bowExcessVol: window._bowExcessVol || 0,
                    rawBowExcessVol: (_bowF && _bowF.rawBowExcess) || 0,
                    bowExcessBaseline: window._bowExcessBaselineVol || 0,
                    bowSlamRatio: _slamRatioNow,
                    bowSlamRatioPeak3s: _slamRatioPeak3s,
                    speed: physics.speed,
                    targetSpeed: physics.targetSpeed,
                    slamCount: window._bowSlamCount || 0,
                });
            }

            // ════════════════════════════════════════════════════════════
            //  船中央（Stage 3）── ホギング/サギングの視覚的な船体曲げ
            //  剛体物理には影響させず、hogSagUniforms経由でシェーダーにのみ反映する。
            // ════════════════════════════════════════════════════════════
            if (HOGSAG_ENABLED && typeof computeHogSagAmount === 'function') {
                const hogSagWorld = computeHogSagAmount(physics.cgWorldX, physics.cgWorldZ, rotY, physScale, len, t, subDt);
                if (typeof hogSagUniforms !== 'undefined' && hogSagUniforms) {
                    hogSagUniforms.amount.value = hogSagWorld / physScale; // world→船体ローカル単位
                }
                window._hogSagWorld = hogSagWorld; // デバッグ/Stage6用に公開
            }

            // ── ヒーブ：F = ρgV（浮力）− mg（重力）, a = F/m ─────────────────
            const F_buoyancyHeave = RHO_WATER * G_REAL * volSubmerged * buoyMult;
            const F_weight        = massKg * G_REAL;
            // 【v72修正】bowLiftForceをここで合算し、下のC_heaveEff減衰を
            // 他の浮力と全く同じように受けさせる（波切りリフトだけ減衰なしで
            // 振動していた問題の根本修正）。
            const F_netHeave      = F_buoyancyHeave - F_weight + _bowLiftForceRaw;

            // 減衰：真の造波減衰・付加質量は周波数依存で厳密計算が困難なため、
            // 静的復原力 K=ρ・g・Awp（静水中の水線面積から決まる本物の剛性）に対する
            // 臨界減衰比という、船舶工学でも標準的な近似を採用する。
            const K_heaveReal = RHO_WATER * G_REAL * AwpReal * buoyMult;
            const zetaHeave   = 0.35; // 実船のヒーブ減衰比の目安(0.2〜0.4)
            const C_heave     = 2.0 * zetaHeave * Math.sqrt(Math.max(1, K_heaveReal * massKg));
            // 完全空中(submergedFrac=0)のときも最低限の減衰(空気抵抗相当)は残す。
            // ゼロにすると「波を跳ね飛んでバウンドし続ける」現象が収束しなくなる。
            const AIR_DAMP_FRAC = 0.15;
            const C_heaveEff = C_heave * Math.max(AIR_DAMP_FRAC, submergedFrac);

            // ── 推進器の鉛直成分：船首尾軸（ピッチ込み）に沿って推力が働くため、
            //   船がピッチしているときは推力の一部が鉛直方向にも加わる。
            const thrustVertAcc = thrustAccMag * -Math.sin(physics.pitch);

            // ── 質量に応じた応答減衰係数 ──────────────────────────────────
            // 以下のWAVE_FOLLOW_GAIN・maxHeaveAcc・vyMaxはこれまで船の質量と無関係な
            // 固定値だったため、数万トン級の船でも小型ボートと同じ速さ・加速度で
            // 上下動できてしまい、「船尾が一瞬でスクリューごと持ち上がる」といった
            // 非物理的な挙動の原因になっていた。massFactor（スラミング減速と共用、
            // このサブステップ冒頭のmassKg付近で算出済み）でスケールダウンする。

            // ── 波面速度フィードフォワード：水面自体の上下速度に船を追従させる。
            //   水面に接している間だけ効かせ、完全に空中の間は重力のみに委ねる。
            //   大型船は短周期の波の上下動に瞬時には追従できないため、massFactorで弱める。
            const WAVE_FOLLOW_GAIN = 5.0 * massFactor; // 【調整】8.0→5.0（waveSurfaceVel平滑化と合わせた二段構え）
            const waveFollowAcc = (waveSurfaceVel - physics.vy) * WAVE_FOLLOW_GAIN * submergedFrac;

            // 加速度上限も質量依存に。28m/s²(≒2.85G)は船の規模を問わず一律で、
            // 実際にはF_netHeave/massKgで質量はすでに考慮されているが、数値的な
            // 安全弁(波面急変時のスパイク対策)として残す上限自体も大型船では下げる。
            const maxHeaveAcc = THREE.MathUtils.clamp(28.0 * massFactor, 2.0, 28.0);
            // 上下動の最大速度も同様に質量依存。小型船は従来通り最大9m/s程度まで
            // 出せるが、大型船ほど慣性で抑えられ、現実の大型客船の上下動速度の目安
            // (おおむね1m/s前後)に近づくようにする。
            const vyMaxBase = THREE.MathUtils.clamp(Math.sqrt(physScale) * 5.0 * massFactor, 0.4, 9.0);
            const vyMax = Math.max(vyMaxBase, Math.abs(waveSurfaceVel) * 1.3 * Math.max(massFactor, 0.3));

            const accY = THREE.MathUtils.clamp(
                (F_netHeave - physics.vy * C_heaveEff) / massKg
                    + thrustVertAcc + waveFollowAcc,
                -maxHeaveAcc, maxHeaveAcc
            );
            physics.vy += accY * subDt;
            physics.vy = THREE.MathUtils.clamp(physics.vy, -vyMax, vyMax);
            physics.y += physics.vy * subDt;
            physics.y = THREE.MathUtils.clamp(physics.y, -80, 80);

            // ── ピッチ：本物の浮力モーメント M = ρ・g・Σ(ΔV・腕の長さ) ───────────
            //   重力は重心位置に作用するため、自重そのものはピッチモーメントに
            //   寄与しない（モーメントの腕がゼロ）。これがニュートン力学的に正しい。
            //   旧実装の「目標角へのバネ」「バウプランジ増幅」は、本物のモーメント
            //   計算が船首尾の没水分布の偏りを直接拾うため不要になった
            //  （没水が偏るほど自然に大きなモーメントが出る＝amplifierが要らない）。
            // 【バグ修正】momentVolAboutCG は「船首側が多く沈んでいれば正」になるが、
            // 船首が多く沈む(=ピッチが船首下げ方向)ほど船首側の浮力が増え、その浮力は
            // 船首を持ち上げる方向（＝ピッチを正方向から戻す方向）に働くはず。
            // 符号をそのまま torqueBuoyPitch に使うと正のフィードバックになり、
            // 少しでも傾くとそのままクランプ角度まで暴走して戻れなくなっていた
            // （実際に数値シミュレーションで確認: pitch+0.05でmomentVolAboutCGも+に
            //   なり、そのままだとpitchをさらに増やす方向に力がかかってしまう）。
            // 復元モーメントになるよう符号を反転する。
            const torqueBuoyPitch = -RHO_WATER * G_REAL * momentVolAboutCG * buoyMult; // N・m

            const k_gyro_pitch = len * 0.25; // 慣性半径（質量分布の代理指標）
            const h_pend = (physics.waterlineOffsetY - physics.cgOffset.y) * physScale;
            const IPitch_real = massKg * (k_gyro_pitch * k_gyro_pitch + h_pend * h_pend); // kg・m²

            // 減衰の基準剛性：縦方向水線二次モーメントIwpLongから求まる
            // 本物の静的縦復原力 K_pitch = ρ・g・IwpLong（微小角近似）。
            const K_pitchReal = RHO_WATER * G_REAL * IwpLong * buoyMult;
            const zetaPitch   = 0.5; // 妥当な近似的減衰比
            const C_pitch     = 2.0 * zetaPitch * Math.sqrt(Math.max(1, K_pitchReal * IPitch_real));
            // ピッチも同様に、完全空中時は最低限の減衰のみ残す
            // （角運動量がいつまでも保存されて跳ね続けるのを防ぐ）。
            const C_pitchEff = C_pitch * Math.max(AIR_DAMP_FRAC, submergedFrac);

            // v105: ケルビン波の波長は、船が縦揺れ(ピッチ)する周期に由来するという
            // 着想に基づき、ここで求めたピッチの自然角周波数を引き波の波長計算
            // （GPU/CPU双方）で使えるようpushysicsに保存しておく。
            // ωpitch = sqrt(K/I) ・ 大型・重い船ほどIPitch_realが大きくωが小さい
            // (=周期が長い)ため、結果として波長も長くなる。
            physics.pitchNaturalOmega = Math.sqrt(Math.max(0.001, K_pitchReal / Math.max(1, IPitch_real)));

            const accPitch = (torqueBuoyPitch - physics.vPitch * C_pitchEff) / IPitch_real;
            // 角加速度・角速度の安全クランプもmassFactorで質量依存にする。
            // (IPitch_realは既に質量を含むためaccPitch自体は自然に小さくなるが、
            //  従来のmaxAcc=15・±4rad/sという一律クランプは大型船でも小型艇と
            //  同じ速さで傾けてしまえるため、ここも縮小する)
            const maxAcc   = THREE.MathUtils.clamp(15.0 * massFactor, 2.0, 15.0);
            const maxAngVel = THREE.MathUtils.clamp(4.0 * massFactor, 0.5, 4.0);
            physics.vPitch += THREE.MathUtils.clamp(accPitch, -maxAcc, maxAcc) * subDt;
            physics.vPitch  = THREE.MathUtils.clamp(physics.vPitch, -maxAngVel, maxAngVel);
            physics.pitch  += physics.vPitch * subDt;
            physics.pitch   = THREE.MathUtils.clamp(physics.pitch, -0.78, 0.78);

            // ════════════════════════════════════════════════════════════
            //  ロール（横揺れ）── 今回は対象外。従来の振り子モデルを維持。
            // ════════════════════════════════════════════════════════════
            const rightX = physics.cgWorldX + Math.cos(rotY) * wid, rightZ = physics.cgWorldZ - Math.sin(rotY) * wid;
            const leftX  = physics.cgWorldX - Math.cos(rotY) * wid, leftZ  = physics.cgWorldZ + Math.sin(rotY) * wid;
            const yLeft  = getWaveHeight(leftX, leftZ, t, true), yRight = getWaveHeight(rightX, rightZ, t, true);
            const waveRoll  = Math.atan2(yLeft  - yRight, wid * 2.0);

            const g_eff = 9.81;
            const k_gyro_roll  = wid * 0.35;
            const restoringBase = 1.0 + physics.buoyancy * 1.8;
            const BM_roll  = restoringBase * k_gyro_roll * k_gyro_roll / g_eff;
            const GM_roll  = Math.max(0.01 * physScale, BM_roll + h_pend);
            const IRoll  = M * (k_gyro_roll * k_gyro_roll + h_pend * h_pend);
            const KRoll  = M * g_eff * GM_roll * rollShapeFactor;
            const zetaRoll  = 0.62;
            const CRoll  = 2.0 * zetaRoll * Math.sqrt(IRoll * KRoll);

            const turnRateRad  = physics.turnRate * Math.PI / 180;
            const turnRollBias = THREE.MathUtils.clamp(physics.speed * turnRateRad * 0.0018, -0.35, 0.35);
            const targetRoll  = -waveRoll + turnRollBias;

            const accRoll  = ((targetRoll  - physics.roll)  * KRoll  - physics.vRoll  * CRoll)  / IRoll;
            physics.vRoll  += THREE.MathUtils.clamp(accRoll, -maxAcc, maxAcc) * subDt;
            physics.vRoll   = THREE.MathUtils.clamp(physics.vRoll, -maxAngVel, maxAngVel);
            physics.roll   += physics.vRoll * subDt;
            physics.roll    = THREE.MathUtils.clamp(physics.roll, -0.78, 0.78);
        }
    }

    sanitizePhysics();
    
    let currentShipPos = new THREE.Vector3(physics.cgWorldX, physics.y, physics.cgWorldZ);
    if (!window.lastShipPos) window.lastShipPos = currentShipPos.clone();
    let shipDelta = currentShipPos.clone().sub(window.lastShipPos);

    if (isDesignMode) {
        controls.target.add(shipDelta);
        camera.position.add(shipDelta);
        controls.minDistance = 0.1;
        controls.enablePan = true;
    } else if (cameraMode === 'chase') {
        // 固定視点: 船を基準にしたカメラの相対位置・向きを保つ。
        // 前フレームからの船の移動・旋回の差分だけカメラとターゲットに加える。
        if (!Number.isFinite(window.lastChaseHeadingRot)) window.lastChaseHeadingRot = rotY;
        const dRotY = rotY - window.lastChaseHeadingRot;
        if (dRotY !== 0) {
            camera.position.sub(controls.target);
            camera.position.applyAxisAngle(new THREE.Vector3(0, 1, 0), dRotY);
            camera.position.add(controls.target);
            // panOffsetも船の旋回に合わせて回転
            chasePanOffset.applyAxisAngle(new THREE.Vector3(0, 1, 0), dRotY);
        }
        controls.target.add(shipDelta);
        camera.position.add(shipDelta);
        // 2本指パンオフセットを反映（targetとcameraを同量ずらす）
        if (chasePanOffset.lengthSq() > 0) {
            controls.target.add(chasePanOffset);
            camera.position.add(chasePanOffset);
            chasePanOffset.set(0, 0, 0);
        }
        window.lastChaseHeadingRot = rotY;
        controls.minDistance = 0.1;
        controls.enablePan = false;
    } else if (cameraMode === 'free') {
        // 自由視点: 船の移動・旋回に追従せず、自由にカメラを動かせる。
        controls.minDistance = 0.1;
        controls.enablePan = true;
    } else if (cameraMode === 'viewpoint') {
        // 見張り台視点: 実際のカメラ位置・向きの計算は、このフレームの
        // shipGroup位置・回転(横揺れ/縦揺れ込み)が確定した後にupdateViewpointCamera()で行う。
        controls.minDistance = 0.1;
        controls.enablePan = false;
    } else {
        // follow（現状）: ターゲットは船を追うが、カメラ自体の位置は固定。
        controls.target.copy(currentShipPos);
        controls.minDistance = 10 * physics.scale;
        controls.enablePan = false;
    }
    controls.maxDistance = 8000 * physics.scale;
    if (!(cameraMode === 'viewpoint' && !isDesignMode)) controls.update();
    window.lastShipPos.copy(currentShipPos);

    if (!window.lastHistoryTime) window.lastHistoryTime = 0;
    // v95: 引き波を約3倍長持ちさせる。
    // GPU側(wakeHF, js/04-scene-and-water-init.js)は shipHistory の「直近MAX_WAKE(32)件」
    // しか読まないため、記録間隔を詰めても古い波源はどのみち届かない。
    // 逆に間隔を広げれば同じ32枠でカバーできる実時間が伸びる＝GPUループ回数を
    // 増やさず（負荷を増やさず）に持続時間だけを延ばせる。0.08s→0.24sで
    // 32枠のカバー時間が約2.6s→約7.7sに伸びる（下のdt>15.0の減衰上限とも整合）。
    // v121: さらに長持ちさせたいとの要望で0.24s→0.4sに拡大。
    // 32枠のカバー時間は約7.7s→約12.8sに伸びる（dt>15.0の上限にはまだ余裕がある）。
    if (t - window.lastHistoryTime > 0.4) {
        shipHistory.push({ x: physics.cgWorldX, z: physics.cgWorldZ, t, speed: physics.speed, headingRad: rotY, turnRate: physics.turnRate });
        window.lastHistoryTime = t;
        if (shipHistory.length > perf.historyMax) shipHistory.shift();
    }

    updateWaterReflection();
    if (typeof updateSWE === 'function') updateSWE(dt, t); // SWE流体シミュ
    updateWater(t);
    updateSky(t);
    sanitizePhysics();

    animateSmoke(t, dt);
    animatePropellers(t, dt);
    animateBubbles(t, dt);
    animateWakeParticles(t, dt);
    if (typeof emitHullWakeParticles === 'function') emitHullWakeParticles(t, dt);
    updateNavLightsVisibility();
    updateDeckLightPool();
    updateFunnelUplights();

    const finalEuler = new THREE.Euler(physics.pitch, rotY, physics.roll, 'YXZ');
    shipGroup.quaternion.setFromEuler(finalEuler);

    // モデルを配置する際の「ワールド座標に固定する基準点」はCGではなく喫水線基準点(waterlineOffsetY)。
    // X/Zは従来通りCGと同じ（水平方向の重心＝旋回軸という扱いは変えない）。
    const pinOffsetScaled = new THREE.Vector3(cgXScaled, waterlineYScaled, cgZScaled);
    const toCenter = pinOffsetScaled.clone().negate().applyEuler(finalEuler);

    shipGroup.position.set(physics.cgWorldX + toCenter.x, physics.y + toCenter.y, physics.cgWorldZ + toCenter.z);

    // 見張り台視点カメラ: 船の位置・回転(横揺れ/縦揺れ込み)が確定した直後に計算する。
    if (!isDesignMode && cameraMode === 'viewpoint' && typeof updateViewpointCamera === 'function') {
        updateViewpointCamera();
    }

    // LODグリッドの中心を船位置に追従（1unit刻みでスナップ）
    waterMesh.position.x = Math.round(physics.cgWorldX);
    waterMesh.position.z = Math.round(physics.cgWorldZ);

    updateUI();

    if (bloomEnabled && bloomComposer) {
        renderWithBloom();
    } else {
        renderer.render(scene, camera);
    }

    // v137: 描画完了直後にスクリーンショット待ちがあればキャプチャする
    // （preserveDrawingBuffer未設定のためrAF後では手遅れになり得るので、
    //   実際にrenderer.render(...)が呼ばれた直後のこのタイミングで拾う。
    //   ブルームON/OFFどちらの分岐でも、この位置なら最終フレームの
    //   描画完了直後になる）
    if (window._pendingScreenshotCallback) {
        const cb = window._pendingScreenshotCallback;
        window._pendingScreenshotCallback = null;
        cb(renderer.domElement);
    }
}

// 水面反射：カメラをy=0でミラーして低解像度レンダリングし、反射テクスチャを更新する
let _reflFrameSkip = 0;
// 毎フレームのGC負荷を下げるためにオブジェクトをキャッシュ
const _reflClipPlane  = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0.5);
const _reflCamPos     = new THREE.Vector3();
const _reflCamTarget  = new THREE.Vector3();
const _reflCamForward = new THREE.Vector3();
const _reflCamUp      = new THREE.Vector3();
// 【反射方式修正】NDC([-1,1])をテクスチャ座標([0,1])に変換するバイアス行列。
// 反射カメラのprojectionMatrix・matrixWorldInverseと合成し、水面シェーダーへ
// 「ワールド座標→反射RTのテクスチャ座標」のtextureMatrixとして渡す。
const _reflBiasMatrix = new THREE.Matrix4().set(
    0.5, 0.0, 0.0, 0.5,
    0.0, 0.5, 0.0, 0.5,
    0.0, 0.0, 0.5, 0.5,
    0.0, 0.0, 0.0, 1.0
);
const _reflTextureMatrix = new THREE.Matrix4();
function updateWaterReflection() {
    if (!waterReflectionRT || !waterReflectionCamera || !waterMesh) return;

    // 海面リアリティー設定で反射そのものを無効化している場合はスキップ。
    // ただし reflectionStrength を 0 にしてシェーダーが古いRTを描画しないようにする。
    // （ここをただ return するだけだと、最後にレンダリングされた古い反射テクスチャが
    //   reflectionStrength=0.75 のまま水面に表示され続けるゴーストバグが発生する）
    if (window.waterReflectionEnabled === false) {
        if (window._waterUniforms) {
            window._waterUniforms.reflectionStrength.value = 0.0;
        }
        return;
    }
    // 有効時は反射強度を通常値に戻す（無効→有効に切り替えたとき用）
    if (window._waterUniforms) {
        window._waterUniforms.reflectionStrength.value = 0.75;
    }

    // Nフレームに1回だけレンダリング（パフォーマンス節約。Nは海面リアリティー設定で変更可能）
    const skipFrames = window.waterReflectionSkipFrames || 3;
    _reflFrameSkip++;
    if (_reflFrameSkip < skipFrames) return;
    _reflFrameSkip = 0;

    // 反射カメラのパラメータをメインカメラからコピー
    waterReflectionCamera.copy(camera);
    waterReflectionCamera.updateProjectionMatrix();

    // カメラ位置をy=0平面でミラーリング（キャッシュベクトルを再利用）
    _reflCamPos.copy(camera.position);
    _reflCamPos.y = -_reflCamPos.y;
    waterReflectionCamera.position.copy(_reflCamPos);

    // 【修正】以前は controls.target をY反転してlookAtしていたが、見張り台視点
    // (20-viewpoint-camera.js)では controls.target が「実際にカメラが見ている方向」
    // ではなく船の重心位置に設定されるため、反射カメラが全く見当違いの方向を向いて
    // しまい、本来映らないはずの船体内側・スクリューが反射に映り込む原因になっていた
    // （見張り台視点でだけ反射が変になる、という症状と一致）。
    // → controls.targetに依存せず、メインカメラの「実際に向いている方向」を
    //   直接取得してY軸ミラーリングする。これならナビゲーションモードに関わらず
    //   常に正しく機能する。
    _reflCamForward.set(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
    _reflCamUp.copy(camera.up).applyQuaternion(camera.quaternion).normalize();
    _reflCamForward.y = -_reflCamForward.y;
    _reflCamUp.y = -_reflCamUp.y;
    _reflCamTarget.copy(_reflCamPos).add(_reflCamForward);
    waterReflectionCamera.up.copy(_reflCamUp);
    waterReflectionCamera.lookAt(_reflCamTarget);
    waterReflectionCamera.updateMatrixWorld(true);

    // 【反射方式修正】反射カメラの視錐台をテクスチャ座標へ変換する行列を計算し、
    // 水面シェーダーのtextureMatrix uniformへ渡す。これを反射カメラ更新（＝RT再
    // レンダリング）と同じタイミングで更新することで、RTの中身と投影行列が
    // 常に同じカメラ状態を参照するようにしている（スキップフレーム中は両方とも
    // 更新されず、直前の状態のまま一致し続ける）。
    _reflTextureMatrix.copy(_reflBiasMatrix);
    _reflTextureMatrix.multiply(waterReflectionCamera.projectionMatrix);
    _reflTextureMatrix.multiply(waterReflectionCamera.matrixWorldInverse);
    if (window._waterUniforms && window._waterUniforms.textureMatrix) {
        window._waterUniforms.textureMatrix.value.copy(_reflTextureMatrix);
    }

    // クリップ平面: y >= -clipMargin (水面より上のみ描画)
    // 【修正】以前はマージンが固定値0.5だったため、大型船だと0.5ワールド単位下という
    // 狭い範囲の中にスクリューや船体裏側が収まってしまい、本来映るはずのない
    // 船体内側・スクリューの泡が反射に映り込むことがあった。
    // 船のスケール(physics.scale)に比例させ、船が大きいほど適切に広いマージンで
    // クリップされるようにした（waterlineぎりぎりの急な断ち切りを避ける程度の
    // 小さな比率に抑えている）。
    _reflClipPlane.constant = 0.15 * Math.max(0.25, (typeof physics !== 'undefined' ? physics.scale : 1));

    renderer.clippingPlanes = [_reflClipPlane];
    renderer.localClippingEnabled = true;

    // 水面メッシュを一時的に非表示にして反射には映らないようにする
    const wasVisible = waterMesh.visible;
    waterMesh.visible = false;

    try {
        // 反射RTにレンダリング（bloom無しで直接render）
        // bloomComposer.render() が内部で autoClear を false にする場合があるため
        // ここで明示的に true に保証し、RTが毎回確実にクリアされるようにする。
        renderer.setRenderTarget(waterReflectionRT);
        const savedAutoClear = renderer.autoClear;
        renderer.autoClear = true;
        renderer.render(scene, waterReflectionCamera);
        renderer.autoClear = savedAutoClear;
        renderer.setRenderTarget(null);
    } finally {
        // 例外が発生してもクリップ平面・waterMesh の状態を必ず元に戻す
        waterMesh.visible = wasVisible;
        renderer.clippingPlanes = [];
        renderer.localClippingEnabled = false;
    }
}

// v83: 太陽のシャドウカメラ（影の視錐台）を毎フレーム船の位置へ追従させる。
// updateDayNightCycle()が設定するsunLight.positionは「ワールド原点から見た太陽の
// 方角」を表す座標（原点からの距離400）でしかないため、船がワールド原点から
// 遠く離れると、そのままでは影の視錐台が船からズレてしまう。
// ここでは「方角」はそのままに、光源の位置だけを船のすぐ近くへ再配置し、
// ターゲットを船に向け直すことで、影の視錐台が常に船を覆うようにする
// （光源からターゲットへの向きは変えないので、船体の陰影の見た目には影響しない）。
// 空・水面のsunDirection/sunDirはこの関数より前（updateDayNightCycle内）で
// 別の変数から独立して計算済みなので、ここでsunLight.positionを動かしても
// それらの見た目には影響しない。
const SUN_SHADOW_LIGHT_DISTANCE = 500;
function updateSunShadowFollow() {
    if (!sunLight || !shipGroup) return;
    const dirToSun = sunLight.position.clone();
    if (dirToSun.lengthSq() < 1e-6) return; // 初期化直後の万一のゼロベクトル対策
    dirToSun.normalize();

    sunLight.target.position.copy(shipGroup.position);
    sunLight.target.updateMatrixWorld();
    sunLight.position.copy(shipGroup.position).addScaledVector(dirToSun, SUN_SHADOW_LIGHT_DISTANCE);

    // 水面シェーダーへシャドウマップ本体と変換行列を渡す。
    // sunLight.shadow.mapはThree.jsが初回描画時に遅延生成するため、
    // まだ無ければ何もせず(sunShadowActive=false)、次フレーム以降で自動的に有効化される。
    if (waterMesh && waterMesh.material.uniforms && waterMesh.material.uniforms.sunShadowMap) {
        const u = waterMesh.material.uniforms;
        const hasMap = !!(perf.shadowsEnabled && sunLight.shadow && sunLight.shadow.map);
        u.sunShadowActive.value = hasMap;
        if (hasMap) {
            u.sunShadowMap.value = sunLight.shadow.map.texture;
            u.sunShadowMatrix.value = sunLight.shadow.matrix;
            u.sunShadowMapSize.value = perf.shadowMapSize;
        }
    }
}

function updateWater(t) {
    if (waterMesh && !waterMesh.visible) return;
    if (!window._waterUniforms) return;
    const uni = window._waterUniforms;

    // ── 波・引き波の計算はすべて頂点シェーダー(GPU)側に移植済み ──
    // ここではCPU側で「全頂点ループ」を行わず、軽量なuniform類だけを毎フレーム更新する。
    // (旧実装: 頂点数×航跡履歴数のCPUループ → 新実装: uniform数十個の更新のみ)
    uni.time.value           = t;
    uni.waveRoughnessU.value = physics.waveRoughness;
    uni.waveWidthU.value     = Math.max(0.05, physics.waveWidth);
    uni.swellStrengthU.value = (typeof physics.swellStrength === 'number') ? physics.swellStrength : 1.0;
    uni.chopStrengthU.value  = (typeof physics.chopStrength  === 'number') ? physics.chopStrength  : 1.0;
    uni.windDirU.value       = (typeof physics.windDir   === 'number') ? physics.windDir   : 45;
    uni.windSpeedU.value     = (typeof physics.windSpeed === 'number') ? physics.windSpeed : 5;
    uni.physScaleU.value     = Math.max(0.25, physics.scale || 1);
    {
        const hp = (typeof window !== 'undefined' && window.hullProfile) ? window.hullProfile : null;
        const ps = physics.scale || 1;
        uni.hullHalfLenU.value = (hp && hp.ready ? hp.halfLen : 6.0) * ps;
        const dst = uni.hullWidthsU.value;
        if (hp && hp.ready && hp.slices && hp.slices.length > 0) {
            const n = Math.min(hp.slices.length, dst.length);
            for (let i = 0; i < n; i++) dst[i] = hp.slices[i].halfWidth * ps;
            uni.hullSliceCountU.value = n;
            // v113-fix: 配列が実際にカバーするalongNorm範囲と、船首/船尾の実測
            // タイポイント（配列範囲外での減衰先）をGPU側に渡す。
            uni.hullSliceAlongMinU.value = hp.slices[0].alongNorm;
            uni.hullSliceAlongMaxU.value = hp.slices[n - 1].alongNorm;
            uni.bowTipAlongNormU.value   = (typeof hp.bowTipAlongNorm === 'number') ? hp.bowTipAlongNorm : hp.slices[n - 1].alongNorm;
            uni.bowTipWidthU.value       = (typeof hp.bowTipWidth === 'number') ? hp.bowTipWidth * ps : dst[n - 1];
            uni.sternTipAlongNormU.value = (typeof hp.sternTipAlongNorm === 'number') ? hp.sternTipAlongNorm : hp.slices[0].alongNorm;
            uni.sternTipWidthU.value     = (typeof hp.sternTipWidth === 'number') ? hp.sternTipWidth * ps : dst[0];
        } else {
            dst[0] = 1.5 * ps;
            uni.hullSliceCountU.value = 1;
            uni.hullSliceAlongMinU.value = -1.0;
            uni.hullSliceAlongMaxU.value = 1.0;
            uni.bowTipAlongNormU.value   = 1.0;
            uni.bowTipWidthU.value       = dst[0];
            uni.sternTipAlongNormU.value = -1.0;
            uni.sternTipWidthU.value     = dst[0];
        }
    }
    // v105: ピッチ自然角周波数→波長のスケール
    uni.pitchOmegaU.value = Math.max(0.05, physics.pitchNaturalOmega || 1.0);
    uni.bowFullnessU.value   = physics.bowFullness;
    uni.sternFullnessU.value = physics.sternFullness;

    // ── SWE統合: SWEが有効な場合はdisplacement mapで水面を動かす（GPU側で加算）──
    if (window.sweEnabled) {
        uni.sweEnabled.value = true;
        if (window.sweOutputTexture) uni.sweMap.value = window.sweOutputTexture;
        if (typeof swe !== 'undefined' && swe) uni.sweGridOrigin.value.set(swe.gridOriginX, swe.gridOriginZ);
        uni.sweGridSize.value = 180.0;
        uni.sweScale.value    = Math.max(0.5, physics.waveRoughness * 1.5);
    } else {
        uni.sweEnabled.value = false;
    }

    // ── 引き波（Kelvin wake）の航跡履歴をGPUへ渡す ──
    // SWEが無効な時は頂点シェーダー側でこの履歴から解析的に引き波を計算する。
    // 「正確さを保ちたい」引き波部分は式そのものを変えずGPUに移しただけなので結果は従来と同じ。
    const MAX_WAKE = window._MAX_WAKE || 32;
    const wArr = uni.wakeXZTH.value;
    const wSpd = uni.wakeSpeed.value;
    const wCount = Math.min(shipHistory.length, MAX_WAKE);
    const startIdx = shipHistory.length - wCount;
    // 各履歴点は記録時点の「重心」ワールド座標(p.x/p.z)。GPU側シェーダーは
    // これを船体ローカル原点として扱いbow/stern位置を計算するため、
    // cgOffset.x/zが(0,0)でないと解析的な引き波(SWE無効時のフォールバック)
    // が船体からズレて「置いていかれる」。CPU版(getWakeHeightVisual)と同様に
    // _hullOriginWorld()で補正してからGPUへ渡す。
    const _wakePhysScale = Math.max(0.25, physics.scale || 1);
    // v119-fix: scanHullProfile()がmodelOffset.ryを打ち消した座標系でスキャン
    // するようになったため（invGroupMatにry逆回転を合成）、GPU側シェーダーが
    // 参照するhullWidthsU等（=hp.slicesのhalfWidth）も「ry=0相当」の座標系の
    // データになった。一方このwakeXZTH配列に渡す方位は、これまでp.headingRad
    // （生のheading、ryを含まない）をそのまま渡していた。CPU側の同種の計算
    // （例: 18-hull-wake-physics.js内のgetWakeHeightVisual等）は既に
    // _wakeAxisRad(p.headingRad)でry分の補正を加えているのに、ここだけ素通し
    // だったため、GPU側だけ方位がズレる不整合があった（旧v118まではスキャン
    // 座標系側にryが織り込まれていたため、素通しでも結果的に辻褄が合って
    // いたが、v119でスキャン座標系からryを除去したことで、ここも明示的な
    // 補正が必要になった）。
    for (let i = 0; i < wCount; i++) {
        const p = shipHistory[startIdx + i];
        let px = p.x, pz = p.z;
        if (typeof _hullOriginWorld === 'function') {
            const _o = _hullOriginWorld(p.x, p.z, p.headingRad, _wakePhysScale);
            px = _o.x; pz = _o.z;
        }
        const _wRad = (typeof _wakeAxisRad === 'function') ? _wakeAxisRad(p.headingRad) : p.headingRad;
        wArr[i].set(px, pz, p.t, _wRad);
        wSpd[i] = p.speed;
    }
    uni.wakeCount.value = wCount;

    // ── 船体に密着した波しぶき帯用のウォーターラインポリゴン更新 ──
    // hullProfile（既存のスキャン済み軽量データ）から組み立てるのでCPUコストはごく僅か。
    // 水面メッシュの粗さに関係なく実際の船体形状にピッタリ沿う。
    if (typeof window.updateHullWaterlinePolygon === 'function') window.updateHullWaterlinePolygon(t);

    if (window._updateWaterShipLights) { window.glbLights = glbLights; window._updateWaterShipLights(); }
}
function updateSky(t) {
    if (!skyMesh) return;
    skyMesh.position.copy(camera.position);
    skyMesh.material.uniforms.time.value = t;
    skyMesh.material.uniforms.camPos.value.copy(camera.position);
    skyMesh.material.uniforms.skyExposure.value = 0.75 * lightSettings.skyMult;
}

function updateUI() {
    const labels = {
        '-3': 'FULL ASTERN (全速後進)', '-2': 'HALF ASTERN (半速後進)', '-1': 'SLOW ASTERN (微速後進)',
        '0': 'STOP (停止)', '1': 'SLOW (微速前進)', '2': 'HALF (半速前進)', '3': 'FULL (全速前進)'
    };
    $('ui-telegraph').innerText = `Telegraph: ${labels[physics.telegraphState]}`;
    $('ui-speed').innerText = `Speed    : ${Math.abs(physics.speed).toFixed(1)} kn`;

    let rudderStr = '0.0°';
    if (physics.rudderAngle < -2) rudderStr = '< '.repeat(Math.floor(Math.abs(physics.rudderAngle) / 5)) + physics.rudderAngle.toFixed(1) + '°';
    else if (physics.rudderAngle > 2) rudderStr = physics.rudderAngle.toFixed(1) + '°' + ' >'.repeat(Math.floor(Math.abs(physics.rudderAngle) / 5));
    $('ui-rudder').innerText = `Rudder   : ${rudderStr}`;

    let deg = Math.floor(physics.heading) % 360; if (deg < 0) deg += 360;
    $('ui-heading').innerText = `Heading  : ${deg}°`;

    const gameHours = Math.floor(physics.gameTime / (physics.dayDuration / 24)) % 24;
    const gameMinutes = Math.floor((physics.gameTime % (physics.dayDuration / 24)) / (physics.dayDuration / 24 / 60));
    $('ui-time').innerText = `Time     : ${gameHours.toString().padStart(2, '0')}:${gameMinutes.toString().padStart(2, '0')}`;

    $('ui-roll').innerText = `Roll     : ${(physics.roll * 180 / Math.PI).toFixed(1)}°`;
    $('ui-pitch').innerText = `Pitch    : ${(physics.pitch * 180 / Math.PI).toFixed(1)}°`;
}

init();
animate();
