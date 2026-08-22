// ============================================================
//  21-bow-stern-effects.js  — Stage 1: 船首補正（Bow Forces）
// ============================================================
//  計画書①に基づく実装。
//
//  1. 波切りリフト   F_lift = C1 × submergedBow × speed²  （上向き加速度としてheaveに加算）
//  2. 船首抵抗       F_drag = C2 × submergedBow² × speed² （前進速度の減速として作用）
//  3. スラミング     船首が「ほぼ空中」から「急激に没水」した瞬間を検知
//
//  C1・C2は船ごとに手入力しない。scanHullProfile()が既に各スライスへ保存している
//  flareAngle（キール〜喫水線の張り出し角）と、船首tip付近のhalfWidth収束の
//  急峻さ（鋭さ）、halfBeam/halfLenの丸み比から自動算出する。
//  → フレアが強く・丸みのある船首（例: Olympic級）ほどC1が大きく出てリフトが強く、
//     鋭く痩せた船首（例: Lusitania）ほどC1が小さくC2が相対的に大きくなる。
// ============================================================

// 船体スライスのうち、これ以上前方(alongNorm)を「船首域」とみなして積分する範囲
const BOW_ALONG_THRESHOLD = 0.55;
// 船首形状係数（フレア・鋭さ）の算出に使う、tip側スライスのサンプル数
const BOW_TIP_SAMPLE_COUNT = 3;
// スラミング判定: 船首/船尾設計容積に対して1秒あたりこの割合以上の速さで
// 没水量が変化したら発火する（無次元比。船のサイズによらず同じ基準で判定できる）。
const SLAM_RATIO_THRESHOLD = 0.5;
// スラミング発火のクールダウン[秒]。連続発火を防ぎ「一発の衝撃」として見せる。
const SLAM_COOLDOWN = 0.35;
// スラミング発生時の瞬間的な速度低下（暫定値。実装後に体感で調整する）
const SLAM_SPEED_DAMP = 0.985;

// ─────────────────────────────────────────
//  estimateBowShapeFactors()
//  hullProfile.slices の実測形状から C1(リフト係数)・C2(抵抗係数) を自動算出。
//  一度算出したらhullProfile側にキャッシュし、以後は再計算しない
//  （船体を再スキャンした場合はhp._bowShapeFactorsがリセットされる想定）。
// ─────────────────────────────────────────
function estimateBowShapeFactors() {
    const hp = window.hullProfile;
    if (!hp || !hp.ready || hp.slices.length < 4) return { C1: 0, C2: 0 };
    if (hp._bowShapeFactors) return hp._bowShapeFactors;

    // alongNorm降順（船首側が先頭）に並べ替え、tip付近のスライスだけを取り出す
    const sorted = [...hp.slices].sort((a, b) => b.alongNorm - a.alongNorm);
    const tipSlices = sorted.slice(0, Math.min(BOW_TIP_SAMPLE_COUNT, sorted.length));

    // ① フレア係数: tip付近のflareAngle平均を0〜70°で正規化
    const avgFlare = tipSlices.reduce((s, sl) => s + sl.flareAngle, 0) / tipSlices.length;
    const flareNorm = THREE.MathUtils.clamp(avgFlare / 70, 0, 1);

    // ② 鋭さ係数: tipSlices内でhalfWidthがalongNormに対してどれだけ急に0へ収束するか。
    //   halfBeamに対する比率で正規化することで船のスケールに依存しないようにする。
    const tipMost = tipSlices[0];
    const tipBack = tipSlices[tipSlices.length - 1];
    const dAlong = Math.max(0.001, Math.abs(tipMost.alongNorm - tipBack.alongNorm));
    const dWidth = Math.abs(tipBack.halfWidth - tipMost.halfWidth);
    const sharpnessRaw  = dWidth / dAlong; // 大きいほど「急に先細る」＝鋭い
    const sharpnessNorm = THREE.MathUtils.clamp(sharpnessRaw / Math.max(0.01, hp.halfBeam) / 3, 0, 1);

    // ③ 丸み(フルネス)係数: halfBeam/halfLen。太い船体ほど押しのける水量が多い
    const fullnessFactor = THREE.MathUtils.clamp(hp.halfBeam / Math.max(0.1, hp.halfLen), 0.02, 0.5);
    const fullnessRef = 0.12; // 基準比率（この値でC1/C2のベース係数がそのまま効く）

    // C1（リフト）: フレアが強く・丸みがある(鋭さが低い)ほど大きい
    const K1 = 0.028; // 唯一の手動ベース係数。全船共通のスケール合わせ用
    const C1 = K1 * (0.4 + 0.6 * flareNorm) * (0.5 + 0.5 * (1 - sharpnessNorm)) * (fullnessFactor / fullnessRef);

    // C2（抵抗）: 鋭い船首ほど深く突き刺さりやすく、結果的に抵抗係数も高めに出る。
    //   フレアが強いと水を途中で弾いて刺さりにくくなるため、抵抗はやや下がる方向。
    // 【修正】Mauretania級の鋭く高速な船で「波が付いた途端に全速でも1/4以下の
    //   速度しか出なくなる」という過大な抵抗が報告された。鋭さ係数がC2を押し上げる
    //   設計自体は、鋭い船首ほど深く刺さりやすい、という意図通りの挙動だが、
    //   下のdragForceが bowExcess の2乗×速度の2乗（実質4乗相当）で効くため、
    //   鋭くて高速な船ほど組み合わせで暴走しやすかった。K2自体を約半分に下げ、
    //   dragForce側の指数も緩めることで、極端な鋭さ・速度でも破綻しないようにした。
    const K2 = 0.008;
    const C2 = K2 * (0.5 + 0.5 * sharpnessNorm) * (1.0 - 0.3 * flareNorm) * (fullnessFactor / fullnessRef);

    const result = { C1, C2, flareNorm, sharpnessNorm, fullnessFactor };
    hp._bowShapeFactors = result;
    console.log('[BowStern] 船首形状係数を自動算出:', result);
    return result;
}

// ─────────────────────────────────────────
//  computeBowSubmergedVolume()
//  computeHullBuoyancyPhysics() と同じサンプリング方式で、船首域
//  (alongNorm >= BOW_ALONG_THRESHOLD) のスライスだけを積分して没水体積[m³]を返す。
// ─────────────────────────────────────────
function computeBowSubmergedVolume(cgWorldX, cgWorldZ, rotY, pitchAngle, shipY, waterlineYScaled, physScale, len, t) {
    const hp = window.hullProfile;
    if (!hp || !hp.ready || hp.slices.length < 2) return 0;

    const slices = hp.slices;
    const n = slices.length;
    const totalRad = (typeof _wakeAxisRad === 'function') ? _wakeAxisRad(rotY) : rotY;
    const _origin  = (typeof _hullOriginWorld === 'function')
        ? _hullOriginWorld(cgWorldX, cgWorldZ, totalRad, physScale)
        : { x: cgWorldX, z: cgWorldZ };
    const deltaZWorld = (2 * len) / BUOY_SEG_COUNT;

    let volBow = 0;
    for (const i of _buoySampleIndices(n)) {
        const sl = slices[i];
        if (sl.alongNorm < BOW_ALONG_THRESHOLD) continue;
        if (sl.draft <= 0.0001 || sl.halfWidth <= 0) continue;

        const alongDistW = sl.alongNorm * len;
        const px = _origin.x + Math.sin(totalRad) * alongDistW;
        const pz = _origin.z + Math.cos(totalRad) * alongDistW;
        const waveY = getWaveHeight(px, pz, t, true);

        const baseKeelY = shipY - waterlineYScaled + (hp.designWaterlineY - sl.draft) * physScale;
        const keelY = baseKeelY - alongDistW * Math.sin(pitchAngle);
        const depthLocal = (waveY - keelY) / physScale;

        const areaCurrent = _segSubmergedAreaLocal(sl.halfWidth, sl.draft, Math.max(0, depthLocal));
        const areaWorld = areaCurrent * physScale * physScale; // m²
        volBow += areaWorld * deltaZWorld; // m³
    }
    return volBow;
}

// ─────────────────────────────────────────
//  computeBowDesignVolume()
//  「設計喫水（平常巡航時の基準喫水）」における船首域の没水体積[m³]を返す。
//  computeHullBuoyancyPhysics()内のsubmergedFrac算出と同じ基準
//  （physics.waterlineOffsetY / physics.draftOffset / hp.designWaterlineY）を使う。
//  波・ピッチ・位置に依存しない静的な値なので、cgWorldX等の引数は不要。
//
//  【重要】抵抗の基準として、実際の没水量(volBow)をそのまま使うと、平常巡航時
//  （船首が設計喫水どおりに浸かっているだけの状態）でも常にC2×volBow²の抵抗が
//  かかり続け、速度²で効くため最大船速に達する前に頭打ちになってしまう
//  （実際にこの現象が発生していた）。
//  「船首が深く刺さるほど抵抗が増える」という意図は、あくまで設計喫水からの
//  “超過分” に対して働くべきものなので、drag計算にはこちらの基準値を使い、
//  computeBowForces側で excess = max(0, volBow - volBowDesign) を取って使う。
// ─────────────────────────────────────────
function computeBowDesignVolume(physScale, len) {
    const hp = window.hullProfile;
    if (!hp || !hp.ready || hp.slices.length < 2) return 0;

    const slices = hp.slices;
    const n = slices.length;
    const deltaZWorld = (2 * len) / BUOY_SEG_COUNT;
    const userWLLocalY = physics.waterlineOffsetY + physics.draftOffset / physScale;

    let volDesign = 0;
    for (const i of _buoySampleIndices(n)) {
        const sl = slices[i];
        if (sl.alongNorm < BOW_ALONG_THRESHOLD) continue;
        if (sl.draft <= 0.0001 || sl.halfWidth <= 0) continue;

        const designDepthLocal = userWLLocalY - (hp.designWaterlineY - sl.draft);
        const areaDesign = _segSubmergedAreaLocal(sl.halfWidth, sl.draft, Math.max(0, designDepthLocal));
        volDesign += areaDesign * physScale * physScale * deltaZWorld; // m³
    }
    return volDesign;
}

// ─────────────────────────────────────────
//  computeBowForces()
//  main-loop.js のサブステップから毎回呼ばれ、船首リフト・抵抗・スラミングを返す。
//  liftAcc/dragAcc は「加速度」ではなく、まだmassKgで割る前の擬似的な力の大きさ
//  （呼び出し側でmassKgで割って実際の加速度に変換する）。
// ─────────────────────────────────────────
function computeBowForces(cgWorldX, cgWorldZ, rotY, pitchAngle, shipY, waterlineYScaled, physScale, len, t, speedMps, subDt) {
    const hp = window.hullProfile;
    if (!hp || !hp.ready) return { liftForce: 0, dragForce: 0, volBow: 0, slammed: false };

    const { C1, C2 } = estimateBowShapeFactors();
    const volBow = computeBowSubmergedVolume(cgWorldX, cgWorldZ, rotY, pitchAngle, shipY, waterlineYScaled, physScale, len, t);

    // ── 基準値(baseline) ──
    // 【設計の経緯】一時期、船ごとの喫水スライダー調整ズレを吸収するために
    // 「実際の没水量を時定数で追従させる自己校正型baseline」を使っていたが、
    // 根本原因（estimateDisplacementTons/computeSubmergedVolumeLocalが実際の
    // 物理計算computeHullBuoyancyPhysicsと異なるサンプリング精度を使っていて、
    // 基準点ちょうどに質量を合わせても実際には釣り合わなかったこと。また
    // waterlineY-slider/draft-sliderを動かしても質量が再カリブレーションされて
    // いなかったこと）を修正したため、静的な「設計喫水基準点」を直接使う元の
    // 方式に戻した。これで基準点は常にユーザーが設定した「喫水線基準点Y」と
    // 一致し、船を読み込んだ・喫水を調整した直後でも余計な暴走が起きない。
    const volBowDesign = computeBowDesignVolume(physScale, len);
    const rawBowExcess = Math.max(0, volBow - volBowDesign); // 設計喫水(pitch=0想定)からの超過没水量[m³]・生値

    // ── 恒常バイアス除去（二重バッファ・スライディング最小値トラッカー） ──────
    // 【バグ修正】volBowDesignはpitch=0の静的な設計喫水を前提にしているが、実際の
    // 船体は重心位置と浮力中心(LCB)の僅かなズレ等により、凪（波なし）の状態でも
    // ごく僅かな船首下げトリムで静止することがある。特に船が長いほど、同じ角度の
    // トリムでも船首位置での上下ズレ(along距離×sinθ)が大きくなるため、大型船だと
    // 角度自体はごく僅か（0.2〜0.5°程度）でもrawBowExcessは数百m³規模になり得る。
    // 【1回目の修正の反省】最初はrawBowExcessの「谷を素早く・山をゆっくり」追う
    // EMA(指数移動平均)方式のベースラインを試したが、これは理論上は時間をかければ
    // 0に収束するだけで、大型船のように恒常バイアスの絶対量が大きいケースだと
    // 収束が遅すぎて「数百m³の差がずっと残っているように見える」状態になっていた。
    // 【2回目の修正の反省】次に「直近の窓(15秒)で観測した最小値を、次の窓まるごと
    // ベースラインとして使い続ける」バケツ方式に変えたが、これは「窓が一周する
    // までベースラインが一切更新されない」ため、加速中のようにrawBowExcessが
    // 継続的に変化し続ける状況では、ベースラインが常に「一つ前の・低いままの」
    // 値に固定され、最大で窓の長さ(15秒)も更新が遅れていた。この間はbowExcessが
    // 実際にはただの加速による上昇分でしかないのに「動的な超過」として扱われ
    // 続けてしまい、平らな海面・加速中でも水切り波や船首抵抗が出続ける原因に
    // なっていた。
    // → 半窓(HALF_WINDOW_SEC)ごとに交代する2つのバッファ(A=集計中, B=直前に
    //   確定した窓)を持ち、baseline=min(A,B)を「窓が一周するのを待たず」毎フレーム
    //   連続的に再計算する二重バッファ方式に変更。実効的な追従窓は従来の15秒から
    //   6秒(=HALF_WINDOW_SEC×2)に短縮され、かつ更新も「窓一周に1回」ではなく
    //   毎フレーム反映されるため、加速による誤検出の残存時間が大幅に減る。
    //   波によるトランジェントな超過(数秒オーダー)は依然としてバッファの最小値を
    //   押し下げないため、山（本物の超過）はこれまで通りきちんと残る。
    const HALF_WINDOW_SEC = 3.0; // 秒: 半窓長。実効追従窓はこの2倍(≒6秒)

    if (typeof window._bowExcessBufA !== 'number') {
        window._bowExcessBufA      = rawBowExcess;
        window._bowExcessBufB      = rawBowExcess;
        window._bowExcessHalfTimer = 0;
    }
    window._bowExcessBufA       = Math.min(window._bowExcessBufA, rawBowExcess);
    window._bowExcessHalfTimer += Math.max(0, subDt);
    if (window._bowExcessHalfTimer >= HALF_WINDOW_SEC) {
        window._bowExcessBufB      = window._bowExcessBufA;
        window._bowExcessBufA      = rawBowExcess; // 次の半窓の観測をリセット
        window._bowExcessHalfTimer = 0;
    }
    window._bowExcessBaselineVol = Math.min(window._bowExcessBufA, window._bowExcessBufB);

    const bowExcess = Math.max(0, rawBowExcess - window._bowExcessBaselineVol); // 恒常バイアスを除いた「動的な」超過没水量[m³]

    const spd2 = speedMps * speedMps;

    const liftForce = C1 * volBow * spd2;                 // 擬似N（上向き）。通常没水分も含めてOK
    // 【修正】以前は bowExcess の2乗 × 速度の2乗（実質4乗相当）で、大型・高速・
    // 鋭い船首の船（Mauretania等）だと波が付いた途端に指示速度の1/4以下まで
    // 落ち込む暴走的な抵抗になっていた。bowExcess側の指数を1.5乗（3乗相当）に
    // 緩め、下でmassKgに変換した後の減速加速度自体にも安全弁の上限をかけている
    // （main-loop.js側の MAX_BOW_DRAG_ACCEL）。
    const dragForce = C2 * Math.pow(bowExcess, 1.5) * spd2;   // 擬似N（超過分にのみ効かせる）

    // ── スラミング判定 ──
    // 没水体積の変化率(dV/dt)から衝撃を検知する。
    // 【重要】以前は「直前フレームがほぼ空中(volBow<0.01)だったこと」も条件にしていたが、
    // 大型船では船首域(alongNorm>=0.55、船体の半分近く)がまるごと空中に出ることは
    // 現実的にほとんど無く、この条件だと事実上永久に発火しなくなってしまっていた
    // （「船首が丸ごと飲まれる規模でもスラミングが起きている感じがしない」という
    // フィードバックの原因はこれだった可能性が高い）。
    // また dV/dt を絶対値(m³/s)のまま閾値判定すると、大型船ほど常に大きい値になり
    // 小型船では逆に閾値に届かないため、船体規模に依存してしまう。
    // → 船首設計容積(volBowDesign)に対する「1秒あたり何割相当の速さで没水量が
    //   変化したか」という無次元比で判定することで、船のサイズによらず同じ基準で
    //   スラミングを検知できるようにした。
    const prevVolBow = (typeof window._prevBowVolSubmerged === 'number') ? window._prevBowVolSubmerged : volBow;
    const dVdt = subDt > 1e-6 ? (volBow - prevVolBow) / subDt : 0;
    window._prevBowVolSubmerged = volBow;

    const slamRatio  = dVdt / Math.max(1, volBowDesign); // [1/s] 無次元の衝撃度
    const lastSlamT  = (typeof window._lastBowSlamT === 'number') ? window._lastBowSlamT : -999;
    const slammed    = slamRatio > SLAM_RATIO_THRESHOLD && (t - lastSlamT) > SLAM_COOLDOWN;
    if (slammed) window._lastBowSlamT = t;

    return { liftForce, dragForce, volBow, volBowDesign, bowExcess, rawBowExcess, slammed, impactRate: dVdt, slamRatio };
}

// ============================================================
//  Stage 2: 船尾補正（Stern Forces）
// ============================================================
//  1. プロペラのレーシング: 没水深さに応じて推力効率を落とす
//  2. 船尾スラミング: ①のBow Slamming同様のロジックを船尾側に適用
//
//  プロペラ位置は propulsors[]（10-ship-editor-propulsors.js、shipGroupローカル座標）
//  をそのまま使う。03-particle-systems.js のバブル放出処理と同じ
//  shipGroup.matrixWorld 変換でワールド座標を得る（1フレーム分遅延があるが、
//  バブル放出と同程度の精度で十分なため許容する）。
// ============================================================

// 船尾域とみなすalongNormの範囲（この値以下）。船首側のBOW_ALONG_THRESHOLDと対称。
const STERN_ALONG_THRESHOLD = -0.55;

// プロペラ効率カーブ: [depthRatio, efficiency] の基準点を線形補間する。
// depthRatio = 没水深さ ÷ プロペラ半径相当（1.0で「半径分完全に没水」＝通常運転）。
// 計画書の 100/90/70/40/0% を depthRatio 1.0/0.5/0.2/0.0/-0.3 に対応させた。
const PROP_EFFICIENCY_CURVE = [
    [-0.3, 0.0],
    [ 0.0, 0.4],
    [ 0.2, 0.7],
    [ 0.5, 0.9],
    [ 1.0, 1.0],
];

function _lerpEfficiencyCurve(depthRatio) {
    const curve = PROP_EFFICIENCY_CURVE;
    if (depthRatio <= curve[0][0]) return curve[0][1];
    for (let i = 0; i < curve.length - 1; i++) {
        const r0 = curve[i][0], e0 = curve[i][1];
        const r1 = curve[i + 1][0], e1 = curve[i + 1][1];
        if (depthRatio <= r1) {
            const f = (depthRatio - r0) / Math.max(0.0001, (r1 - r0));
            return THREE.MathUtils.lerp(e0, e1, f);
        }
    }
    return curve[curve.length - 1][1];
}

// ─────────────────────────────────────────
//  getPropellerEfficiency()
//  propulsors[] 全基の没水深さから平均推力効率(0〜1)を算出する。
//  1基も定義されていない場合は 1.0（従来通りペナルティ無し）を返す。
// ─────────────────────────────────────────
function getPropellerEfficiency(t, physScale) {
    if (typeof propulsors === 'undefined' || !propulsors || propulsors.length === 0 || !shipGroup) {
        return { efficiency: 1.0, racingIntensity: 0.0 };
    }
    shipGroup.updateMatrixWorld(true);

    let sumEff = 0, count = 0;
    for (const p of propulsors) {
        const worldPos = new THREE.Vector3(p.x, p.y, p.z).applyMatrix4(shipGroup.matrixWorld);
        const waveY = getWaveHeight(worldPos.x, worldPos.z, t, true);
        const depth = waveY - worldPos.y; // 正=没水、負=露出（プロペラが波面より上）

        // プロペラ半径相当（ローカルsize基準。makeScrew()のブレード半径0.3*sizeに準拠）
        const propRadiusWorld = Math.max(0.1, (p.size || 1.0) * 0.35 * physScale);
        const depthRatio = depth / propRadiusWorld;

        sumEff += _lerpEfficiencyCurve(depthRatio);
        count++;
    }
    const efficiency = count > 0 ? sumEff / count : 1.0;
    return { efficiency, racingIntensity: 1.0 - efficiency };
}

// ─────────────────────────────────────────
//  computeSternSubmergedVolume()
//  computeBowSubmergedVolume()と同じ方式で、船尾域(alongNorm <= STERN_ALONG_THRESHOLD)
//  の没水体積[m³]を返す（船尾スラミング判定専用）。
// ─────────────────────────────────────────
function computeSternSubmergedVolume(cgWorldX, cgWorldZ, rotY, pitchAngle, shipY, waterlineYScaled, physScale, len, t) {
    const hp = window.hullProfile;
    if (!hp || !hp.ready || hp.slices.length < 2) return 0;

    const slices = hp.slices;
    const n = slices.length;
    const totalRad = (typeof _wakeAxisRad === 'function') ? _wakeAxisRad(rotY) : rotY;
    const _origin  = (typeof _hullOriginWorld === 'function')
        ? _hullOriginWorld(cgWorldX, cgWorldZ, totalRad, physScale)
        : { x: cgWorldX, z: cgWorldZ };
    const deltaZWorld = (2 * len) / BUOY_SEG_COUNT;

    let volStern = 0;
    for (const i of _buoySampleIndices(n)) {
        const sl = slices[i];
        if (sl.alongNorm > STERN_ALONG_THRESHOLD) continue;
        if (sl.draft <= 0.0001 || sl.halfWidth <= 0) continue;

        const alongDistW = sl.alongNorm * len;
        const px = _origin.x + Math.sin(totalRad) * alongDistW;
        const pz = _origin.z + Math.cos(totalRad) * alongDistW;
        const waveY = getWaveHeight(px, pz, t, true);

        const baseKeelY = shipY - waterlineYScaled + (hp.designWaterlineY - sl.draft) * physScale;
        const keelY = baseKeelY - alongDistW * Math.sin(pitchAngle);
        const depthLocal = (waveY - keelY) / physScale;

        const areaCurrent = _segSubmergedAreaLocal(sl.halfWidth, sl.draft, Math.max(0, depthLocal));
        const areaWorld = areaCurrent * physScale * physScale;
        volStern += areaWorld * deltaZWorld;
    }
    return volStern;
}

// ─────────────────────────────────────────
//  computeSternDesignVolume()
//  computeBowDesignVolume()と同じ方式で、船尾域(alongNorm <= STERN_ALONG_THRESHOLD)の
//  設計喫水における没水体積[m³]を返す（船尾スラミングの無次元化基準用）。
// ─────────────────────────────────────────
function computeSternDesignVolume(physScale, len) {
    const hp = window.hullProfile;
    if (!hp || !hp.ready || hp.slices.length < 2) return 0;

    const slices = hp.slices;
    const n = slices.length;
    const deltaZWorld = (2 * len) / BUOY_SEG_COUNT;
    const userWLLocalY = physics.waterlineOffsetY + physics.draftOffset / physScale;

    let volDesign = 0;
    for (const i of _buoySampleIndices(n)) {
        const sl = slices[i];
        if (sl.alongNorm > STERN_ALONG_THRESHOLD) continue;
        if (sl.draft <= 0.0001 || sl.halfWidth <= 0) continue;

        const designDepthLocal = userWLLocalY - (hp.designWaterlineY - sl.draft);
        const areaDesign = _segSubmergedAreaLocal(sl.halfWidth, sl.draft, Math.max(0, designDepthLocal));
        volDesign += areaDesign * physScale * physScale * deltaZWorld;
    }
    return volDesign;
}

// ─────────────────────────────────────────
//  computeSternForces()
//  main-loop.js のサブステップから毎回呼ばれ、プロペラ推力効率と
//  船尾スラミングを返す。
// ─────────────────────────────────────────
function computeSternForces(cgWorldX, cgWorldZ, rotY, pitchAngle, shipY, waterlineYScaled, physScale, len, t, subDt) {
    const { efficiency, racingIntensity } = getPropellerEfficiency(t, physScale);

    const volStern = computeSternSubmergedVolume(cgWorldX, cgWorldZ, rotY, pitchAngle, shipY, waterlineYScaled, physScale, len, t);
    // 船首側と同じく、質量の自動カリブレーション修正により静的な設計喫水基準点を
    // 直接使えるようになったため、こちらに統一する。
    const volSternDesign = computeSternDesignVolume(physScale, len);

    const prevVolStern = (typeof window._prevSternVolSubmerged === 'number') ? window._prevSternVolSubmerged : volStern;
    const dVdt = subDt > 1e-6 ? (volStern - prevVolStern) / subDt : 0;
    window._prevSternVolSubmerged = volStern;

    // 船首側と同じ理由（大型船では船尾域も丸ごと空中に出ることは稀）でスケール非依存の
    // 比率判定＋クールダウンに変更。
    const slamRatio = dVdt / Math.max(1, volSternDesign);
    const lastSlamT = (typeof window._lastSternSlamT === 'number') ? window._lastSternSlamT : -999;
    const slammed   = slamRatio > SLAM_RATIO_THRESHOLD && (t - lastSlamT) > SLAM_COOLDOWN;
    if (slammed) window._lastSternSlamT = t;

    return { efficiency, racingIntensity, volStern, slammed, impactRate: dVdt, slamRatio };
}

// ============================================================
//  Stage 3: 船中央（Hogging / Sagging）── 見た目のみの近似
// ============================================================
//  剛体の浮力・ピッチ計算（computeHullBuoyancyPhysics）は既にスライスごとに
//  波面をサンプリングしているため、「中央が波の谷/山にある」ことによる
//  ピッチ/ヒーブへの影響はある程度再現できている。
//  ここで追加するのは、実際の船体メッシュを弓なりに曲げて見せる「視覚的な」
//  ホギング/サギング表現のみで、剛体物理（速度・ピッチ角等）には一切影響しない。
//
//  仕組み: 船首・船央・船尾3点の波高差から曲げ量(hogSagAmount)を算出し、
//  船体メッシュの頂点シェーダーで沿岸軸(along-axis)に応じた放物線状のYオフセットを
//  加算する（08-model-loading-and-lighting.js の applyHogSagBendShader が
//  既存のhull-glowシェーダーパッチと同じ手法・同じマテリアル群に対して行う）。
// ============================================================

// 【2026-07 無効化】「ホギング/サギングは無しでいい」との要望により、Stage3全体を
// このフラグ一つで無効化できるようにした。false の間は
// applyHogSagBendShader()（08-model-loading-and-lighting.js）が船体シェーダーへの
// パッチを行わず、main-loop.js側のcomputeHogSagAmount()呼び出しもスキップされる。
// 計算ロジック自体は削除していないので、後で欲しくなったらtrueに戻すだけで良い。
const HOGSAG_ENABLED = false;

const HOGSAG_VISUAL_GAIN = 0.4;  // 波高差 → 曲げ量への変換ゲイン（そのままだと誇張しすぎるため減衰）
const HOGSAG_MAX_WORLD   = 1.2;  // [m] 極端な海況でも破綻しないための曲げ量の上限
const HOGSAG_SMOOTH_TAU  = 0.6;  // [s] 応答の時定数。大きいほどゆっくり滑らかに動く（構造的な"たわみ"らしさ）

// 08-model-loading-and-lighting.js の applyHogSagBendShader が生成・共有する uniform。
// { amount: {value:number}, halfLen: {value:number} } の形。未生成の間はnullのまま。
let hogSagUniforms = null;

function createHogSagUniforms() {
    return {
        amount:  { value: 0.0 }, // 船体ローカル単位（world側でphysScale倍されて表示される）
        halfLen: { value: 50.0 },
    };
}

// ─────────────────────────────────────────
//  computeHogSagAmount()
//  船首/船央/船尾3点の波高から曲げ量[m, world単位]を算出し、時定数付きで平滑化して返す。
//  正=ホギング(中央が持ち上がる/両端がしなだれる)、負=サギング(中央が沈む/両端が持ち上がる)。
// ─────────────────────────────────────────
function computeHogSagAmount(cgWorldX, cgWorldZ, rotY, physScale, len, t, subDt) {
    const hp = window.hullProfile;
    if (!hp || !hp.ready) return 0;

    const totalRad = (typeof _wakeAxisRad === 'function') ? _wakeAxisRad(rotY) : rotY;
    const _origin  = (typeof _hullOriginWorld === 'function')
        ? _hullOriginWorld(cgWorldX, cgWorldZ, totalRad, physScale)
        : { x: cgWorldX, z: cgWorldZ };

    function waveAt(alongDistW) {
        const px = _origin.x + Math.sin(totalRad) * alongDistW;
        const pz = _origin.z + Math.cos(totalRad) * alongDistW;
        return getWaveHeight(px, pz, t, true);
    }

    const midWave   = waveAt(0);
    const bowWave   = waveAt(len);
    const sternWave = waveAt(-len);
    const rawHogSag   = (midWave - (bowWave + sternWave) * 0.5) * HOGSAG_VISUAL_GAIN;
    const targetWorld = THREE.MathUtils.clamp(rawHogSag, -HOGSAG_MAX_WORLD, HOGSAG_MAX_WORLD);

    const prevSmoothed = (typeof window._hogSagSmoothed === 'number') ? window._hogSagSmoothed : 0;
    const alpha = subDt > 0 ? 1 - Math.exp(-subDt / HOGSAG_SMOOTH_TAU) : 1;
    const smoothed = prevSmoothed + (targetWorld - prevSmoothed) * alpha;
    window._hogSagSmoothed = smoothed;

    return smoothed;
}

// ─────────────────────────────────────────
//  _updateBowSternDebugHud()
//  Stage4の係数調整用の簡易デバッグ表示。画面右上に小さく数値を出すだけ。
//  スマホの実機テストで「効き具合を勘で判断する」のを減らすためのもの。
//  不要になったらこの関数ごと削除するか、main-loop.js側の呼び出しを消せばよい。
// ─────────────────────────────────────────
let _bowSternDebugHudEl = null;
function _updateBowSternDebugHud(vals) {
    if (!_bowSternDebugHudEl) {
        _bowSternDebugHudEl = document.createElement('div');
        _bowSternDebugHudEl.style.cssText =
            'position:fixed; top:6px; right:6px; z-index:99999; ' +
            'background:rgba(0,0,0,0.55); color:#7fffb0; font:11px monospace; ' +
            'padding:4px 8px; border-radius:4px; pointer-events:none; white-space:pre;';
        document.body.appendChild(_bowSternDebugHudEl);
    }
    _bowSternDebugHudEl.textContent =
        `volBow: ${vals.volBow.toFixed(2)} m³\n` +
        `volBowDesign: ${vals.bowVolBaseline.toFixed(2)} m³\n` +
        `bowExcessVol(raw): ${(vals.rawBowExcessVol || 0).toFixed(2)} m³\n` +
        `bowExcessBaseline: ${(vals.bowExcessBaseline || 0).toFixed(2)} m³\n` +
        `bowExcessVol: ${vals.bowExcessVol.toFixed(2)} m³\n` +
        `bowSlamRatio: ${vals.bowSlamRatio.toFixed(2)} (spray>1.0)\n` +
        `  └ 直近3秒ピーク: ${(vals.bowSlamRatioPeak3s || 0).toFixed(2)}\n` +
        `speed: ${(vals.speed || 0).toFixed(2)} / target ${(vals.targetSpeed || 0).toFixed(2)}\n` +
        `slamCount(累計): ${vals.slamCount || 0}`;
}

// ─────────────────────────────────────────
//  _trackBowSlamRatioPeak(currentRatio, t)
//  「今は静かなのに大きな水しぶきが見える」という報告の原因切り分け用。
//  直近3秒間でbowSlamRatioが実際どこまで跳ね上がっていたかを追跡する
//  （継続スプレー系はライブ値を直接見ているので、一瞬だけ閾値を超えて
//  すぐ戻っても、その一瞬に出たパーティクルは寿命の間ずっと画面に残る。
//  現在値が穏やかでも直近ピークが高ければ、それが原因である可能性が高いと
//  判断できる）。
// ─────────────────────────────────────────
let _bowSlamRatioHistory = [];
function _trackBowSlamRatioPeak(currentRatio, t) {
    _bowSlamRatioHistory.push({ t, r: currentRatio });
    while (_bowSlamRatioHistory.length > 0 && t - _bowSlamRatioHistory[0].t > 3.0) {
        _bowSlamRatioHistory.shift();
    }
    let peak = currentRatio;
    for (let i = 0; i < _bowSlamRatioHistory.length; i++) {
        if (_bowSlamRatioHistory[i].r > peak) peak = _bowSlamRatioHistory[i].r;
    }
    return peak;
}
