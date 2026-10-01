// 32-engine-propeller.js — 機関（スクリューの回転数）と、スクリューの形状の解析
//
// ════════════════════════════════════════════════════════════════
//  回転数は「機関指令（テレグラフ）」を目標に加減速する
// ════════════════════════════════════════════════════════════════
// 以前はスクリューの回転を船の速度から直接決めていたため、後進をかけても
// 船が止まるまでスクリューは前進方向に回り続けていた（実際は逆で、先に
// スクリューが逆転し、その力で船が止まり、後ろへ進み始める）。
//
// 実際の機関と同じく、
//   ・指令の回転数へ、決まった速さで回転数を上げ下げする
//   ・前進⇔後進の切り替えは、いったん回転を止め、少し間を置いて（機関の
//     逆転操作）から反対向きに回し始める
// とし、船を押す力（推力）もこの回転数から決める（17-main-loop.js）。
//
// physics.propRpm は「前進全速のときの回転数」に対する割合（後進は負、
// 後進全速は -0.5）。

const ENGINE_SPOOL_UP = 0.08;       // 回転数を上げる速さ（前進全速の回転に対する割合／秒）
const ENGINE_SPOOL_DOWN = 0.14;     // 回転数を下げる速さ
const ENGINE_REVERSE_DELAY = 3.0;   // 前進⇔後進の切り替えで、回転を止めておく時間[秒]
// 前進全速のときの見た目の回転の速さ[rad/s] = 最高速度 × この値
// （以前の「船の速度 × 1.5」と、前進全速のときに同じ見た目になるようにしている）
const PROP_SPIN_PER_MAXSPEED = 1.5;

physics.propRpm = 0;
let _engineReverseHold = 0;

function _approach(v, target, rate, dt) {
    const d = target - v;
    const step = rate * dt;
    return Math.abs(d) <= step ? target : v + Math.sign(d) * step;
}

// 物理のサブステップごとに呼ぶ（17-main-loop.js）
function updatePropRpm(dt, designMode) {
    // 機関がスクリューごとにあるとき（56-engines.js）：機関ごとに回して、合わせた推力の回転数にする
    if (typeof engineUpdate === 'function') {
        const r = engineUpdate(dt, designMode);
        if (r !== null && r !== undefined) { physics.propRpm = r; return r; }
    }
    const maxSpd = Math.max(0.1, physics.maxSpeed || 1);
    const target = designMode ? 0 : THREE.MathUtils.clamp((physics.targetSpeed || 0) / maxSpd, -0.5, 1);
    let r = physics.propRpm || 0;

    if (target * r < 0) {
        // 逆向きの指令：まず今の向きの回転を止める
        r = _approach(r, 0, ENGINE_SPOOL_DOWN, dt);
        if (r === 0) _engineReverseHold = ENGINE_REVERSE_DELAY;
    } else if (_engineReverseHold > 0 && r === 0 && target !== 0) {
        // 機関の逆転操作中（止まったまま少し待つ）
        _engineReverseHold -= dt;
    } else {
        _engineReverseHold = 0;
        const rate = Math.abs(target) > Math.abs(r) ? ENGINE_SPOOL_UP : ENGINE_SPOOL_DOWN;
        r = _approach(r, target, rate, dt);
    }
    physics.propRpm = r;
    return r;
}

// スクリューの見た目の角速度[rad/s]（正＝前進方向の回転）。
// プロペラが水面から出て空転しているときは回転が上がる。
function getPropSpinRate() {
    const maxSpd = Math.max(0.1, physics.maxSpeed || 1);
    const racing = window._propRacingIntensity || 0;
    return (physics.propRpm || 0) * maxSpd * PROP_SPIN_PER_MAXSPEED * (1 + racing * 0.6);
}

// 推力の目標速度：今の回転数で押し出せる速度
function getPropThrustTargetSpeed() {
    return (physics.propRpm || 0) * Math.max(0.1, physics.maxSpeed || 1);
}

// 回転数の「負荷」：指令と実際の速度の差が大きいほど（加速中・後進への
// 切り替え中）プロペラが水をかき回し、泡（キャビテーション）が増える。
function getPropSlip() {
    const maxSpd = Math.max(0.1, physics.maxSpeed || 1);
    return THREE.MathUtils.clamp(Math.abs(getPropThrustTargetSpeed() - (physics.speed || 0)) / maxSpd, 0, 1);
}

// ════════════════════════════════════════════════════════════════
//  スクリューの羽根の「円盤」を、実際の形状から求める
// ════════════════════════════════════════════════════════════════
// 以前は泡の出る半径を、回転中の姿勢のままワールド座標の外接箱から推定して
// いた。スクリュー部品にシャフトが含まれていたり（Teutonic はシャフトごと
// 1つの部品）、原点がプロペラの中心から離れていたりすると、泡の出る位置・
// 半径が実物と合わなかった。
// ここでは部品の頂点を「実際に回っている軸からの距離」で調べ、軸に沿って細かく
// 区切ったうち最も外まで張り出している位置＝羽根の円盤の位置、その張り出し
// ＝半径とする。
// 座標はすべて部品の親（船）の座標系で扱う。回転軸はその座標系で動かないので、
// 一度求めれば回転中でもそのまま使える（軸・回転中心の設定が変わったら求め直す）。
//   part.pivotOffset : 回転中心のオフセット（12-bloom-...js の animatePropellers と同じ扱い）
//   part.spinAxis    : 回転させるオイラー角の成分（'x' / 'y' / 'z'）
const _discE = new THREE.Euler();
const _discQ1 = new THREE.Quaternion(), _discQ2 = new THREE.Quaternion();

// 回転中心（親座標）：animatePropellers は
//   位置 = basePos + R(baseRot)·pv − R(今の回転)·pv
// としているので、親座標で basePos + R(baseRot)·pv の点が常に動かない。
function _screwPivotInParent(part) {
    const pv = part.pivotOffset || new THREE.Vector3();
    return pv.clone().applyEuler(part.baseRot || new THREE.Euler()).add(part.basePos || part.object.position);
}

// 回転軸（親座標）：オイラー角の1成分を少し変えたときの回転の差から求める
// （成分によっては部品の軸ではなく親の軸まわりに回るため、計算で確かめる）
function _screwAxisInParent(part) {
    const obj = part.object;
    const key = part.spinAxis || 'x';
    _discE.copy(obj.rotation);
    _discQ1.setFromEuler(_discE);
    _discE[key] += 0.01;
    _discQ2.setFromEuler(_discE);
    _discQ2.multiply(_discQ1.invert());   // 差分の回転
    const ax = new THREE.Vector3(_discQ2.x, _discQ2.y, _discQ2.z);
    if (ax.lengthSq() < 1e-12) return new THREE.Vector3(1, 0, 0);
    return ax.normalize();
}

function analyzeScrewDisc(part) {
    const obj = part.object;
    if (!obj) return null;
    const pv = part.pivotOffset || new THREE.Vector3();
    const cacheKey = (part.spinAxis || 'x') + ':' + pv.x.toFixed(4) + ',' + pv.y.toFixed(4) + ',' + pv.z.toFixed(4);
    if (part._disc && part._disc.key === cacheKey) return part._disc;

    const parent = obj.parent;
    obj.updateWorldMatrix(true, true);
    const invParent = new THREE.Matrix4();
    if (parent) invParent.copy(parent.matrixWorld).invert();
    const a = _screwAxisInParent(part);
    const pivot = _screwPivotInParent(part);
    const rel = new THREE.Matrix4();
    const v = new THREE.Vector3(), d = new THREE.Vector3();
    const samples = [];   // [軸方向の位置, 軸からの距離]
    obj.traverse((m) => {
        if (!m.isMesh || !m.geometry || !m.geometry.attributes.position) return;
        const pos = m.geometry.attributes.position;
        rel.multiplyMatrices(invParent, m.matrixWorld);
        const step = Math.max(1, Math.floor(pos.count / 4000));
        for (let i = 0; i < pos.count; i += step) {
            v.fromBufferAttribute(pos, i).applyMatrix4(rel).sub(pivot);
            const along = v.dot(a);
            d.copy(v).addScaledVector(a, -along);
            samples.push([along, d.length()]);
        }
    });
    if (samples.length < 8) return null;

    let aMin = Infinity, aMax = -Infinity;
    for (const [al] of samples) { aMin = Math.min(aMin, al); aMax = Math.max(aMax, al); }
    // 軸方向に 24 区切りにして、各区切りで最も外に張り出した距離を見る
    const bins = 24, span = Math.max(1e-6, aMax - aMin);
    const binR = new Float32Array(bins);
    for (const [al, r] of samples) {
        const b = Math.min(bins - 1, Math.floor((al - aMin) / span * bins));
        if (r > binR[b]) binR[b] = r;
    }
    let best = 0;
    for (let b = 1; b < bins; b++) if (binR[b] > binR[best]) best = b;
    // 羽根の円盤：最も張り出した区切りと、それに近い（8割以上の）隣の区切りの範囲
    let lo = best, hi = best;
    while (lo > 0 && binR[lo - 1] > binR[best] * 0.8) lo--;
    while (hi < bins - 1 && binR[hi + 1] > binR[best] * 0.8) hi++;
    const hubAlong = aMin + (lo + hi + 1) / 2 / bins * span;

    part._disc = {
        key: cacheKey,
        center: pivot.clone().addScaledVector(a, hubAlong),   // 親座標
        axis: a,                                               // 親座標
        radius: binR[best],                                    // 親座標の長さ
        width: (hi - lo + 1) / bins * span,                    // 羽根の円盤の厚み
    };
    return part._disc;
}

// 泡の発生源の一覧（ワールド座標）。GLB のスクリュー・外輪部品と、組み込みの推進器。
//   { center, axisDir（前進推力の向き）, radius, angle（今の回転角）, dir（回転の向き）,
//     handed（軸を前向きにそろえるため裏返したら -1）, paddle }
// 毎フレーム呼ぶので、結果の入れ物は使い回す（ゴミを出さない）。
const _psTmp = new THREE.Vector3();
const _psFwd = new THREE.Vector3();
const _psPool = [];
const _psOut = [];
function _psSlot(i) {
    if (!_psPool[i]) _psPool[i] = { center: new THREE.Vector3(), axisDir: new THREE.Vector3(), radius: 1, angle: 0, dir: 1, handed: 1, paddle: false };
    return _psPool[i];
}
function getPropEmitSources() {
    const out = _psOut;
    out.length = 0;
    if (!shipGroup) return out;
    shipGroup.updateWorldMatrix(true, false);
    // 船の前向き（ワールド）：推力の向きの基準
    const fwd = _psFwd.set(0, 0, 1).transformDirection(shipGroup.matrixWorld);

    if (glbMovableParts && glbMovableParts.length > 0) {
        for (const part of glbMovableParts) {
            if ((part.key !== 'screw' && part.key !== 'paddle') || part.disabled || !part.object) continue;
            const disc = analyzeScrewDisc(part);
            if (!disc || disc.radius <= 0) continue;
            const parent = part.object.parent || shipGroup;
            parent.updateWorldMatrix(true, false);
            const src = _psSlot(out.length);
            src.center.copy(disc.center).applyMatrix4(parent.matrixWorld);
            src.axisDir.copy(disc.axis).transformDirection(parent.matrixWorld);
            // 軸の向きを前進方向にそろえる（部品の軸は前後どちら向きでもありうる）
            // （裏返したときは、同じ回転でも軸から見た回る向きが逆になる）
            src.handed = 1;
            if (src.axisDir.dot(fwd) < 0) { src.axisDir.negate(); src.handed = -1; }
            src.radius = disc.radius * (_psTmp.setFromMatrixScale(parent.matrixWorld).x || 1);
            src.angle = part.spin || 0;
            src.dir = part.invert ? -1 : 1;
            src.paddle = part.key === 'paddle';
            out.push(src);
        }
    }
    // 組み込み推進器は、船体設定を開いている間しか表示されない（ふだんは見えない）。
    // モデルにスクリュー・外輪の部品があるときは、見えているそちらからだけ泡を出す
    // （以前は両方から出していたため、スクリューの無い所からも泡が出ていた）。
    if (out.length === 0 && typeof propMeshes !== 'undefined' && propMeshes && propMeshes.length > 0) {
        // 組み込み推進器：10-ship-editor-propulsors.js の makeScrew と同じ寸法
        // （羽根の中心が 0.3×サイズ、長さ 0.5×サイズ → 先端は 0.55×サイズ。外輪は 0.8×サイズ）
        const paddle = $('prop-type') && $('prop-type').value === 'paddlewheel';
        for (const g of propMeshes) {
            if (!g.userData.isProp) continue;
            const size = g.userData.size || 1;
            g.updateWorldMatrix(true, false);
            const src = _psSlot(out.length);
            src.center.setFromMatrixPosition(g.matrixWorld);
            src.axisDir.copy(fwd);
            src.radius = (paddle ? 0.8 : 0.55) * size * (_psTmp.setFromMatrixScale(g.matrixWorld).x || 1);
            src.angle = g.rotation.z;
            src.handed = 1;
            src.dir = g.userData.dir || 1;
            src.paddle = paddle;
            out.push(src);
        }
    }
    return out;
}
