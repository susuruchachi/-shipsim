// 25-area-lights.js — 面光源（エリアライト・発光パネル）と、その影
//
// ════════════════════════════════════════════════════════════════
//  扱う光源は2種類
// ════════════════════════════════════════════════════════════════
//  ・エリアライト : Blenderで type="area" を付けたEmpty由来（UIで位置・向き・
//                   サイズ・強さを個別に調整できる）
//  ・発光パネル   : 窓・灯具・天窓・看板などの発光メッシュ由来
//                   （26-glow-emitters.js が抽出して登録する）
//  どちらも「面の中心・向き・大きさ」を持つノードで表し、同じ仕組みで照らす。
//
// ════════════════════════════════════════════════════════════════
//  なぜ RectAreaLight か
// ════════════════════════════════════════════════════════════════
//  以前はエリアライトを自前のGLSL（HullGlow）で、発光メッシュを影付き
//  PointLight群で近似していた。前者は辻褄合わせの項が積み重なったうえ影が
//  出ず、後者は PointLight の影がキューブマップ（1灯で船全体を6回描画）なので
//  非常に重かった。three.js の RectAreaLight は LTC（線形変換コサイン）で
//  面光源の積分を正しく行うので、どちらもこれに置き換える。
//
// ════════════════════════════════════════════════════════════════
//  影について（three.js側の制約と、軽くする工夫）
// ════════════════════════════════════════════════════════════════
//  **three.js の RectAreaLight は影を落とせない。** そこで影を出す枠には
//  同じ位置・向きの SpotLight を重ね、光量を分け合う（AREA_LIGHT_SHADOW_SHARE）。
//  SpotLight の影は2Dマップ1枚なので、PointLight のキューブ影の1/6で済む。
//
//  さらに、光源は船に固定されていて船と一緒に剛体として動くので、
//  **光源から見た船の奥行き（影マップの中身）は船が動いても変わらない。**
//  変わるのは「ワールド→影マップ」の変換行列だけなので、影マップは
//  割り当てが変わったときだけ描き直し、毎フレームは行列だけを更新する。
//  （three.js は影を描き直さないフレームは行列の更新もしないため、
//   autoUpdate=false のまま放置すると船の移動に影が置いていかれる。
//   以前の窓灯りの影がずれて見えたのはこれが原因だった）
//
// ════════════════════════════════════════════════════════════════
//  「定義」と「枠（スロット）」を分ける
// ════════════════════════════════════════════════════════════════
//  船の窓や灯具を全部光源にすると、定義は数十〜数百に達する。一方 LTC は
//  1灯あたりの負荷が大きく、全部は点けられない。さらに three.js では
//  **シーン内で visible なライトの数が変わるたびに全マテリアルのシェーダーが
//  再コンパイルされる**ので、「近い灯だけ visible にする」素朴なやり方だと、
//  順位が入れ替わるたびに画面が固まる。
//    ・定義(def) : 位置・向き・サイズを持つノード＋色・強さ。何百個あってもよい。
//    ・枠(slot)  : 実際にシーンに居るライト。個数は画質で決まる固定数。
//  カメラに近い定義を枠に割り当てて使い回す。灯数が変わらないので
//  再コンパイルが起きず、負荷も一定に保てる。

// 画質ごとの枠の数と、そのうち影を落とす枠の数・影の解像度
const AREA_LIGHT_BUDGET = {
    high:     { active: 10, shadows: 3, mapSize: 1024 },
    medium:   { active: 7,  shadows: 2, mapSize: 1024 },
    low:      { active: 5,  shadows: 1, mapSize: 512 },
    verylow:  { active: 3, shadows: 0, mapSize: 512 },
    ultralow: { active: 2, shadows: 0, mapSize: 512 },
};
// 光量のうち、影を落とすSpotLightに持たせる割合。
// 1.0 に近づけるほど影は濃くなるが、面光源らしさは失われる。
const AREA_LIGHT_SHADOW_SHARE = 0.5;
// 影用SpotLightの強さを面光源に釣り合わせる基準距離（面の大きさに対する倍率）。
// RectAreaLight と SpotLight は強さの単位も距離による減り方も違うので、
// 同じ intensity を渡しても明るさは揃わない（このアプリの従来ライティングでは
// SpotLight に π が掛かり、距離でもほとんど減衰しない）。そこで「面の大きさ×
// この倍率」の距離で両者の照度が所定の割合になるよう、SpotLight の強さを
// 面光源の照度から逆算する。
const AREA_LIGHT_MATCH_DIST = 1.5;
// SpotLight が届く距離＝基準距離のこの倍。減衰の指数2と組み合わせると、
// 基準距離の約3倍までは面光源の 1/距離² の減り方とほぼ同じ形で暗くなる。
const AREA_LIGHT_SPOT_REACH = 4.0;
// Blenderのエリアライトのエネルギー[W] → three.jsの強度への換算。
// Blender側は数十〜数百Wで置かれることが多いので、そのままでは明るすぎる。
const AREA_LIGHT_WATT_SCALE = 0.03;
// この閾値より大きい値は「Blenderのワット数」とみなして換算し、
// それ以下は既に調整済みの値とみなしてそのまま使う。
const AREA_LIGHT_WATT_THRESHOLD = 20;
// 割り当て直しの間隔[秒]
const AREA_LIGHT_REBIND_INTERVAL = 0.25;
// 割り当て済みの定義を、この割合だけ近いものとして扱う（ヒステリシス）。
// 距離が拮抗する2つの定義の間で、枠が行ったり来たりするのを防ぐ。
const AREA_LIGHT_KEEP_BONUS = 0.15;
// 新しく割り当てた枠を点灯させるフェード時間[秒]。パッと点かないようにする。
const AREA_LIGHT_FADE_IN = 0.4;
// 影マップを念のため描き直す間隔[秒]（舵など船の中で動く部品のため）
const AREA_LIGHT_SHADOW_REFRESH = 4.0;
// 影用SpotLightの広がり。面の全体を覆える程度に広く取る。
const AREA_LIGHT_SPOT_ANGLE = Math.PI / 3;
// 照射方向の合わせ込み。
//  定義ノードは次の規約で向き・大きさを表す（BlenderのエリアライトをEmptyに
//  変換したものが、glTF書き出し後この向きになる）:
//      面の法線 = ローカル +Y （この方向を照らす）
//      面の幅   = ローカル X 方向、スケール x が実寸
//      面の高さ = ローカル Z 方向、スケール z が実寸
//  three.js の RectAreaLight は、面がローカル XY 平面にあり
//  **ローカル -Z 方向を照らす**（実測で確認）。X軸まわりに +90° 回して子に
//  持たせると、光の -Z が親の +Y、光の X が親の X、光の Y が親の Z に一致する。
const AREA_LIGHT_EMIT_ROT_X = Math.PI / 2;

// ════════════════════════════════════════════════════════════════
//  枠に入らなかった遠くの灯り（簡易の照明）
// ════════════════════════════════════════════════════════════════
//  面光源（RectAreaLight）は重いので、実際に点けられるのはカメラに近い数灯
//  （上の AREA_LIGHT_BUDGET）だけ。それ以外の灯りは今まで何も照らさず、
//  離れた所の甲板や天井が真っ暗で不自然だった。
//  そこで枠に入らなかった灯りも、影なしの軽い計算で照らす：
//    ・1灯あたり「面の正面の向き × 受ける面の向き × 距離の2乗で減る」だけ
//      （面光源の小さい光源での近似と同じ明るさになるようにしてある）
//    ・届く範囲を明るさから決め、それより遠くは計算しない
//    ・影は無い代わりに届く範囲が短いので、壁の向こうへの漏れは目立ちにくい
//  灯りの情報は小さな浮動小数テクスチャで船のマテリアルへ渡し（配列uniformの
//  動的添字は一部端末でリンクに失敗するため）、船のマテリアルの光の計算の
//  最後に足す。枠に入った灯りは枠のフェードに合わせて簡易側を消すので、
//  入れ替わりで明るさが跳ねない。
const FILL_LIGHT_MAX = { high: 48, medium: 32, low: 16, verylow: 8, ultralow: 0 };
const FILL_TEX_W = 64;                 // テクスチャの幅（= 最大灯数）
const FILL_LIGHT_MIN_E = 0.004;        // これより暗くなる距離で打ち切る（届く範囲）
const FILL_LIGHT_MAX_RANGE = 60;       // 届く範囲の上限[m]
const fillLightUniforms = {
    uFillTex:   { value: null },
    uFillCount: { value: 0 },
};
let _fillData = null;
let _fillDefs = [];          // 簡易照明の候補（割り当て直しのたびに選ぶ）
let _fillPatchDirty = true;  // 船のマテリアルへ簡易照明を仕込み直すか
const _fillFrustum = new THREE.Frustum();
const _fillProjView = new THREE.Matrix4();
const _fillSphere = new THREE.Sphere();
const _fillN = new THREE.Vector3();

let areaLightDefs  = [];   // { kind:'empty'|'glow', node, holder, color, weight, mirrorOf, mirror, _dist }
let areaLightSlots = [];   // { root, rect, spot, def, fade, shadowDirty, sig }
let _alLastBindAt  = -1;
let _alLastT       = -1;
let _alShadowRefreshAt  = 0;
let _alShadowRefreshIdx = 0;
let _alGlowFactor  = 0;    // 発光パネルの明るさ（昼夜×windowGlowMult、updateWindowGlowが設定）

const _alTmpPos   = new THREE.Vector3();
const _alTmpQuat  = new THREE.Quaternion();
const _alTmpScale = new THREE.Vector3();

// Blenderのエネルギー値を three.js の強度へ
function areaLightIntensityFromProps(raw) {
    const v = parseFloat(raw);
    if (!Number.isFinite(v)) return 3.0;
    return v > AREA_LIGHT_WATT_THRESHOLD ? v * AREA_LIGHT_WATT_SCALE : v;
}

function getAreaLightBudget() {
    const q = (typeof perf !== 'undefined' && perf.quality) ? perf.quality : 'medium';
    const b = AREA_LIGHT_BUDGET[q] || AREA_LIGHT_BUDGET.medium;
    const shadowsOn = !(typeof perf !== 'undefined' && !perf.shadowsEnabled);
    return { active: b.active, shadows: shadowsOn ? b.shadows : 0, mapSize: b.mapSize };
}

// 発光パネルの明るさ（16-daynight-and-telegraph.js の updateWindowGlow から）
function setAreaLightGlowFactor(v) { _alGlowFactor = Math.max(0, v || 0); }

function _alDisposeSlots() {
    for (const s of areaLightSlots) {
        if (s.spot && s.spot.shadow && s.spot.shadow.map) {
            s.spot.shadow.map.dispose();
            s.spot.shadow.map = null;
        }
        if (s.root.parent) s.root.parent.remove(s.root);
    }
    areaLightSlots = [];
    _alLastBindAt = -1;
}

function _alRemoveDef(d) {
    if (d.node && d.node.parent) d.node.parent.remove(d.node);
    if (d.holder && typeof glbLights !== 'undefined') {
        const gi = glbLights.indexOf(d.holder);
        if (gi !== -1) glbLights.splice(gi, 1);
    }
}

// 以前のエリアライトを片付ける（モデル差し替え時）
function disposeAreaLights() {
    _alDisposeSlots();
    for (const d of areaLightDefs) {
        if (d.node && d.node.parent) d.node.parent.remove(d.node);
    }
    areaLightDefs = [];
}

// 枠を1つ作る。枠は**シーン直下**に置き、毎フレーム定義のワールド変換を
// そのまま書き込む。スケールを持たないノードなので、モデル側に非一様スケールが
// かかっていてもライトの向きが歪まない（three.jsは光源の向きを matrixWorld から
// extractRotation＝各列を正規化して取り出すため、親のスケールに影響される）。
function _alMakeSlot(withShadow, mapSize) {
    const root = new THREE.Object3D();
    root.name = 'AreaLightSlot';
    root.visible = false;

    const rect = new THREE.RectAreaLight(0xffffff, 0, 1, 1);
    rect.rotation.x = AREA_LIGHT_EMIT_ROT_X;
    root.add(rect);

    let spot = null;
    if (withShadow) {
        spot = new THREE.SpotLight(0xffffff, 0);
        spot.angle = AREA_LIGHT_SPOT_ANGLE;
        spot.penumbra = 0.9;   // 面光源の影らしく、縁を大きくぼかす
        spot.decay = 2;        // AREA_LIGHT_SPOT_REACH の説明参照
        spot.castShadow = true;
        spot.shadow.mapSize.set(mapSize, mapSize);
        spot.shadow.bias = -0.0006;
        spot.shadow.normalBias = 0.02;
        spot.shadow.radius = 2;
        spot.shadow.camera.near = 0.1;
        // 影マップは割り当て時だけ描く（冒頭の説明参照）
        spot.shadow.autoUpdate = false;
        spot.shadow.needsUpdate = false;
        root.add(spot);
        // SpotLightはtargetの方を向く。ローカル+Y側に置けば、枠ごと回っても
        // スポットの向きは常に面の法線と一致する。
        spot.target.position.set(0, 1, 0);
        root.add(spot.target);
    }

    if (typeof scene !== 'undefined' && scene) scene.add(root);
    return { root, rect, spot, def: null, fade: 0, shadowDirty: false, sig: '' };
}

function _alRebuildSlots(force) {
    const b = getAreaLightBudget();
    const want = Math.min(b.active, areaLightDefs.length);
    const wantShadows = Math.min(b.shadows, want);
    const haveShadows = areaLightSlots.filter(s => s.spot).length;
    // 枠の構成が変わらないなら作り直さない。作り直すとシャドウマップを捨てる
    // うえ、シーン内のライト数が変わって全マテリアルの再コンパイルを招くため。
    if (!force && want === areaLightSlots.length && wantShadows === haveShadows) return;
    _alDisposeSlots();
    for (let i = 0; i < want; i++) {
        areaLightSlots.push(_alMakeSlot(i < wantShadows, b.mapSize));
    }
}

// 画質設定が変わったときに呼ぶ（枠の数・影の枚数・解像度を作り直す）。
function refreshAreaLightShadowQuality() {
    if (areaLightDefs.length === 0) return;
    _alRebuildSlots(true);
}

// ── エリアライト（Empty由来）─────────────────────────────────────
// empties : userData.type === 'area' のノード配列（まだmodel階層に居るもの）
// Emptyと同じ親・同じローカル変換のノードを置き換えとして残す。こうすると
// モデルの移動・回転・拡縮にシーングラフの継承だけで追従する。
function buildAreaLights(model, empties) {
    disposeAreaLights();
    if (!empties || empties.length === 0) return areaLightDefs;

    empties.forEach((empty, idx) => {
        const ud = empty.userData || {};
        const intensity = areaLightIntensityFromProps(ud.intensity);
        const colorStr = ud.color || '#ffffff';
        const parent = empty.parent || model;

        // 位置・向き・サイズの実体となるノード。UIのXYZ入力もギズモも、
        // 従来の areaNode と同じくこのノードを動かす。
        const node = new THREE.Object3D();
        node.position.copy(empty.position);
        node.quaternion.copy(empty.quaternion);
        node.scale.copy(empty.scale);
        node.name = 'AreaLightNode_' + (empty.name || idx);
        parent.add(node);
        parent.remove(empty);

        // UI・保存用のデータ保持役。既存のライト一覧UI・保存/復元・ギズモは
        // glbLights の要素を見るので、定義1個につき1個のライトオブジェクトを
        // 持たせる。**シーンには追加しない**（実際に照らすのは枠のライト）。
        const holder = new THREE.RectAreaLight(new THREE.Color(colorStr).getHex(), intensity, 1, 1);
        holder.userData.isGlbLight    = true;
        holder.userData.isAreaLight   = true;
        holder.userData.baseIntensity = intensity;
        holder.userData.labelName     = empty.name || ('Area #' + (idx + 1));
        holder.userData.areaNode      = node;
        if (typeof glbLights !== 'undefined' && Array.isArray(glbLights)) glbLights.push(holder);

        areaLightDefs.push({ kind: 'empty', node, holder, color: holder.color, mirrorOf: null, _dist: 0 });
    });

    _alRebuildSlots(true);
    _fillPatchDirty = true;
    return areaLightDefs;
}

// ── 発光パネル（発光メッシュ由来、26-glow-emitters.js から）─────────────
// panels: [{ node, color, weight }]。node の規約は上と同じ。
// 渡したものに置き換える（空配列で全部外す）。
function setGlowAreaDefs(panels) {
    for (let i = areaLightDefs.length - 1; i >= 0; i--) {
        if (areaLightDefs[i].kind === 'glow') {
            const d = areaLightDefs[i];
            for (const s of areaLightSlots) if (s.def === d) s.def = null;
            _alRemoveDef(d);
            areaLightDefs.splice(i, 1);
        }
    }
    (panels || []).forEach((p) => {
        areaLightDefs.push({ kind: 'glow', node: p.node, holder: null, color: p.color,
                             weight: p.weight || 1, mirrorOf: null, _dist: 0 });
    });
    _alRebuildSlots(false);
    _alLastBindAt = -1;   // 次のフレームですぐ割り当て直す
    _fillPatchDirty = true;
}

// ── シンメトリー（左右対称コピー）──────────────────────────────
// ミラーは「元の定義から毎フレーム変換を作り直すだけの、もう1個の定義」にする。
// 枠の割り当ては元と同じ仕組みに乗るので、ミラー側にも同じように影が出る。
function _alFindDef(holder) {
    for (const d of areaLightDefs) if (d.holder === holder) return d;
    return null;
}

function setAreaLightMirror(holder, enabled) {
    const src = _alFindDef(holder);
    if (!src || src.mirrorOf) return;

    if (enabled) {
        if (src.mirror) return;
        const node = new THREE.Object3D();
        node.name = src.node.name + '_mirror';
        (src.node.parent || src.node).add(node);

        const m = new THREE.RectAreaLight(holder.color.getHex(), holder.intensity, 1, 1);
        m.userData.isGlbLight    = true;
        m.userData.isAreaLight   = true;
        m.userData.isMirrorLight = true;
        m.userData.labelName     = (holder.userData.labelName || '') + ' (mirror)';
        m.userData.areaNode      = node;
        if (typeof glbLights !== 'undefined' && Array.isArray(glbLights)) glbLights.push(m);

        const def = { kind: 'empty', node, holder: m, color: m.color, mirrorOf: src, _dist: 0 };
        areaLightDefs.push(def);
        src.mirror = def;
        holder.userData.mirrorLight = m;
        _alRebuildSlots(false);
    } else if (src.mirror) {
        const def = src.mirror;
        for (const s of areaLightSlots) if (s.def === def) s.def = null;
        _alRemoveDef(def);
        const di = areaLightDefs.indexOf(def);
        if (di !== -1) areaLightDefs.splice(di, 1);
        src.mirror = null;
        holder.userData.mirrorLight = null;
        _alRebuildSlots(false);
    }
}

// 定義が「今点いているべきか」と、その強さ。
// エリアライトは applyGlbLightIntensities() が userData.targetVisible /
// targetIntensity に「こうしたい値」を書いてくれるので、手動OFFや昼間の
// 自動消灯の判定をここで二重に書かずに済む。
function _alDefVisible(def) {
    if (def.kind === 'glow') return _alGlowFactor > 0.01;
    const src = def.mirrorOf || def;
    return src.holder.userData.targetVisible !== false;
}
function _alDefIntensity(def) {
    if (def.kind === 'glow') {
        const base = (typeof GLOW_PANEL_LUMINANCE !== 'undefined') ? GLOW_PANEL_LUMINANCE : 4.0;
        return base * _alGlowFactor * (def.weight || 1);
    }
    const ud = (def.mirrorOf || def).holder.userData;
    if (Number.isFinite(ud.targetIntensity)) return ud.targetIntensity;
    if (Number.isFinite(ud.baseIntensity))   return ud.baseIntensity;
    return (def.mirrorOf || def).holder.intensity;
}

// 枠へ定義を割り当てる。すでに割り当てられている定義はそのままの枠に残し、
// 空いた枠にだけ新しい定義を入れる（順位が入れ替わるたびに全部の枠を
// 付け替えると、影の描き直しとフェードが無駄に走るため）。
function _alAssignTier(slots, wanted) {
    const wantSet = new Set(wanted);
    const free = [];
    for (const s of slots) {
        if (s.def && wantSet.has(s.def)) wantSet.delete(s.def);
        else free.push(s);
    }
    const rest = wanted.filter(d => wantSet.has(d));   // 近い順を保つ
    free.forEach((s, i) => {
        const d = rest[i] || null;
        if (s.def !== d) {
            s.def = d;
            s.fade = 0;
            s.shadowDirty = !!(s.spot && d);
            s.sig = '';
        }
    });
}

function _alRebind(cam) {
    const bound = new Set();
    for (const s of areaLightSlots) if (s.def) bound.add(s.def);

    const live = [];
    for (const d of areaLightDefs) {
        if (!_alDefVisible(d)) continue;
        d.node.updateWorldMatrix(true, false);
        _alTmpPos.setFromMatrixPosition(d.node.matrixWorld);
        let dist = _alTmpPos.distanceTo(cam.position);
        if (bound.has(d)) dist *= (1 - AREA_LIGHT_KEEP_BONUS);
        d._dist = dist;
        live.push(d);
    }
    live.sort((a, b) => a._dist - b._dist);

    const shadowSlots = areaLightSlots.filter(s => s.spot);
    const plainSlots  = areaLightSlots.filter(s => !s.spot);
    // 一番近いものに影を付ける。
    const forShadow = live.slice(0, shadowSlots.length);
    const forPlain  = live.slice(shadowSlots.length, shadowSlots.length + plainSlots.length);
    _alAssignTier(shadowSlots, forShadow);
    _alAssignTier(plainSlots, forPlain);

    // 簡易照明の候補：画面に届きうる灯りを近い順に（枠に入ったものも含める。
    // 枠のフェードに合わせて簡易側を消すため）
    const nFill = FILL_LIGHT_MAX[(typeof perf !== 'undefined' && perf.quality) || 'medium'] || 0;
    _fillDefs = [];
    if (nFill > 0) {
        cam.updateMatrixWorld();
        _fillProjView.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
        _fillFrustum.setFromProjectionMatrix(_fillProjView);
        for (const d of live) {
            if (_fillDefs.length >= nFill + areaLightSlots.length) break;
            _alTmpPos.setFromMatrixPosition(d.node.matrixWorld);
            _fillSphere.set(_alTmpPos, _fillRange(d));
            if (_fillFrustum.intersectsSphere(_fillSphere)) _fillDefs.push(d);
        }
    }
}

// 簡易照明の明るさの係数 = 強さ × 面積（面光源の、小さい光源での近似）
function _fillPower(def) {
    def.node.matrixWorld.decompose(_alTmpPos, _alTmpQuat, _alTmpScale);
    const area = Math.max(1e-4, Math.abs(_alTmpScale.x * _alTmpScale.z));
    return { power: _alDefIntensity(def) * area, area };
}
// 届く範囲：明るさが FILL_LIGHT_MIN_E まで落ちる距離
function _fillRange(def) {
    const { power } = _fillPower(def);
    return Math.min(FILL_LIGHT_MAX_RANGE, Math.sqrt(power / (Math.PI * FILL_LIGHT_MIN_E)));
}

function _fillEnsureTex() {
    if (fillLightUniforms.uFillTex.value) return;
    _fillData = new Float32Array(FILL_TEX_W * 3 * 4);
    const tex = new THREE.DataTexture(_fillData, FILL_TEX_W, 3, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    fillLightUniforms.uFillTex.value = tex;
}

// 毎フレーム：候補の灯りの位置・向き・明るさをカメラ座標でテクスチャに書く
function _fillUpdate(cam) {
    _fillEnsureTex();
    const fadeOf = new Map();
    for (const s of areaLightSlots) {
        if (s.def && s.root.visible) fadeOf.set(s.def, s.fade * s.fade * (3 - 2 * s.fade));
    }
    const D = _fillData;
    const view = cam.matrixWorldInverse;
    let n = 0;
    for (const d of _fillDefs) {
        if (n >= FILL_TEX_W) break;
        if (!_alDefVisible(d)) continue;
        // 枠で照らしている分は簡易側から引く
        const k = 1 - (fadeOf.get(d) || 0);
        if (k < 0.01) continue;
        d.node.updateWorldMatrix(true, false);
        const { power, area } = _fillPower(d);
        if (power <= 0) continue;
        const range = Math.min(FILL_LIGHT_MAX_RANGE, Math.sqrt(power / (Math.PI * FILL_LIGHT_MIN_E)));
        // 位置と面の向き（ローカル +Y）をカメラ座標へ
        _alTmpPos.setFromMatrixPosition(d.node.matrixWorld).applyMatrix4(view);
        _fillN.set(0, 1, 0).applyQuaternion(_alTmpQuat).transformDirection(view);
        const r0 = n * 4, r1 = (FILL_TEX_W + n) * 4, r2 = (FILL_TEX_W * 2 + n) * 4;
        D[r0] = _alTmpPos.x; D[r0 + 1] = _alTmpPos.y; D[r0 + 2] = _alTmpPos.z; D[r0 + 3] = range;
        D[r1] = _fillN.x;    D[r1 + 1] = _fillN.y;    D[r1 + 2] = _fillN.z;    D[r1 + 3] = area;
        D[r2] = d.color.r * power * k; D[r2 + 1] = d.color.g * power * k; D[r2 + 2] = d.color.b * power * k; D[r2 + 3] = 0;
        n++;
    }
    fillLightUniforms.uFillCount.value = n;
    fillLightUniforms.uFillTex.value.needsUpdate = true;
}

// 船のマテリアル（MeshStandardMaterial）に簡易照明を仕込む。既存の
// onBeforeCompile（船体曲げなど）は先に呼んでから足す。
function _fillPatchMaterial(mat) {
    if (!mat || !mat.isMeshStandardMaterial || mat.userData.fillLightPatched) return;
    mat.userData.fillLightPatched = true;
    const prev = mat.onBeforeCompile;
    const prevKey = mat.customProgramCacheKey;
    mat.onBeforeCompile = function (shader, r) {
        if (typeof prev === 'function') prev.call(this, shader, r);
        shader.uniforms.uFillTex = fillLightUniforms.uFillTex;
        shader.uniforms.uFillCount = fillLightUniforms.uFillCount;
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', `#include <common>
uniform sampler2D uFillTex;
uniform int uFillCount;`)
            .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
{
    // 枠に入らなかった遠くの灯りの簡易照明（25-area-lights.js）
    for (int i = 0; i < ${FILL_TEX_W}; i++) {
        if (i >= uFillCount) break;
        float fu = (float(i) + 0.5) / ${FILL_TEX_W}.0;
        vec4 lp = texture2D(uFillTex, vec2(fu, 0.5 / 3.0));
        vec3 L = lp.xyz - geometry.position;
        float d2 = dot(L, L);
        if (d2 > lp.w * lp.w) continue;
        vec4 ln = texture2D(uFillTex, vec2(fu, 1.5 / 3.0));
        vec3 lc = texture2D(uFillTex, vec2(fu, 2.5 / 3.0)).rgb;
        float d = sqrt(d2);
        vec3 Ld = L / max(d, 1e-4);
        float cosR = max(dot(geometry.normal, Ld), 0.0);   // 受ける面の向き
        float cosL = max(dot(ln.xyz, -Ld), 0.0);           // 灯りの面の正面か
        float win = 1.0 - d / lp.w; win *= win;             // 届く範囲の端で滑らかに0へ
        float e = cosR * cosL * win / (PI * d2 + ln.w);
        reflectedLight.directDiffuse += lc * e * material.diffuseColor;
    }
}`);
    };
    mat.customProgramCacheKey = function () {
        const base = (typeof prevKey === 'function') ? prevKey.call(this) : '';
        // 後から別のパッチ（船体曲げなど）がこの上に被さっても区別できるよう、
        // 今の onBeforeCompile も鍵に含める（three.js はこの鍵でシェーダーを使い回す）
        return 'fillLight|' + String(this.onBeforeCompile) + '|' + (typeof prev === 'function' ? prev.toString() : '') + '|' + base;
    };
    mat.needsUpdate = true;
}

function _fillPatchModel() {
    _fillPatchDirty = false;
    const root = (typeof importedModelGroup !== 'undefined' && importedModelGroup) ? importedModelGroup
               : ((typeof shipGroup !== 'undefined') ? shipGroup : null);
    if (!root) return;
    root.traverse((o) => {
        if (!o.isMesh || !o.material) return;
        (Array.isArray(o.material) ? o.material : [o.material]).forEach(_fillPatchMaterial);
    });
}

// 定義ノードの「船に対する」置き方のシグネチャ。ギズモ等でエリアライトを
// 動かしたら影を描き直すために使う（船ごと動くぶんには変わらない）。
function _alNodeSig(node) {
    const p = node.position, q = node.quaternion, s = node.scale;
    return [p.x, p.y, p.z, q.x, q.y, q.z, q.w, s.x, s.z].map(v => v.toFixed(4)).join(',');
}

// 毎フレーム、**描画の直前**に呼ぶ（船の位置・姿勢が確定した後）。
function updateAreaLights(t) {
    const dt = (_alLastT < 0) ? 0 : Math.min(0.1, Math.max(0, t - _alLastT));
    _alLastT = t;
    if (areaLightDefs.length === 0 || areaLightSlots.length === 0) { fillLightUniforms.uFillCount.value = 0; return; }
    const cam = (typeof camera !== 'undefined') ? camera : null;
    if (!cam) return;

    // ── ミラー定義のローカル変換を、元の定義から作り直す ──
    // X=0 の面に対する鏡像。回転は、反射行列Mで挟んだ M R M が鏡像の回転に
    // なる。これはクォータニオンだと (x, y, z, w) → (x, -y, -z, w) と等しい。
    for (const d of areaLightDefs) {
        if (!d.mirrorOf) continue;
        const s = d.mirrorOf.node, q = s.quaternion;
        d.node.position.set(-s.position.x, s.position.y, s.position.z);
        d.node.quaternion.set(q.x, -q.y, -q.z, q.w);
        d.node.scale.copy(s.scale);
        d.holder.color.copy(d.mirrorOf.holder.color);
    }

    if ((t - _alLastBindAt) > AREA_LIGHT_REBIND_INTERVAL || _alLastBindAt < 0) {
        _alLastBindAt = t;
        _alRebind(cam);
    }

    // 念のための定期的な影の描き直し（1枠ずつ順番に）
    const boundShadowSlots = areaLightSlots.filter(s => s.spot && s.def);
    if (boundShadowSlots.length > 0 && t >= _alShadowRefreshAt) {
        _alShadowRefreshAt = t + AREA_LIGHT_SHADOW_REFRESH / boundShadowSlots.length;
        boundShadowSlots[_alShadowRefreshIdx++ % boundShadowSlots.length].shadowDirty = true;
    }

    // ── 枠へ反映 ──
    let shadowRendersLeft = 1;   // 影マップの描き直しは1フレーム1枚まで（負荷の山を作らない）
    for (const slot of areaLightSlots) {
        const def = slot.def;
        if (!def || !_alDefVisible(def)) {
            slot.root.visible = false;
            continue;
        }

        // 定義のワールド変換をそのまま枠へ。スケールもワールドで取るので、
        // モデル全体の拡大率（physics.scale・modelOffset）が自動的に効く。
        def.node.updateWorldMatrix(true, false);
        def.node.matrixWorld.decompose(_alTmpPos, _alTmpQuat, _alTmpScale);
        slot.root.position.copy(_alTmpPos);
        slot.root.quaternion.copy(_alTmpQuat);
        slot.root.visible = true;
        slot.root.updateMatrixWorld(true);

        const w = Math.max(0.01, Math.abs(_alTmpScale.x));
        const h = Math.max(0.01, Math.abs(_alTmpScale.z));
        slot.fade = Math.min(1, slot.fade + dt / AREA_LIGHT_FADE_IN);
        const fade = slot.fade * slot.fade * (3 - 2 * slot.fade);
        const inten = _alDefIntensity(def) * fade;

        slot.rect.width  = w;
        slot.rect.height = h;
        slot.rect.color.copy(def.color);
        slot.rect.intensity = slot.spot ? inten * (1 - AREA_LIGHT_SHADOW_SHARE) : inten;

        if (slot.spot) {
            const spot = slot.spot;
            spot.color.copy(def.color);
            // 基準距離 d0 で、面光源（全光量のとき）の照度 E のうち
            // AREA_LIGHT_SHADOW_SHARE 分を SpotLight が受け持つように強さを決める。
            //   面光源の正面の照度 ≒ L·A / (A/π + d²)   （同じ面積の円盤で近似）
            //   SpotLight の照度    = I·π·(1 − d/D)^2    （従来ライティングの式）
            const area = w * h;
            const d0 = Math.max(1.5, Math.max(w, h) * AREA_LIGHT_MATCH_DIST);
            const reach = d0 * AREA_LIGHT_SPOT_REACH;
            const eRect = inten * area / (area / Math.PI + d0 * d0);
            const fall = Math.pow(1 - d0 / reach, spot.decay);
            spot.intensity = AREA_LIGHT_SHADOW_SHARE * eRect / (Math.PI * fall);
            // 届く範囲。shadow.camera.far もこの値から決まる。
            spot.distance = reach;
            // 影の深度精度は far/near の比で決まるので、面の大きさに合わせて
            // near も動かし、比を常識的な範囲に保つ。
            const near = Math.max(0.1, Math.min(w, h) * 0.05);
            if (Math.abs(spot.shadow.camera.near - near) > near * 0.1) {
                spot.shadow.camera.near = near;
                spot.shadow.camera.updateProjectionMatrix();
                slot.shadowDirty = true;
            }
            // エリアライトをギズモ等で動かしたら描き直す
            const sig = _alNodeSig(def.node);
            if (sig !== slot.sig) { slot.sig = sig; slot.shadowDirty = true; }

            if (slot.shadowDirty && shadowRendersLeft > 0) {
                spot.shadow.needsUpdate = true;
                slot.shadowDirty = false;
                shadowRendersLeft--;
            }
            // 影マップを描き直さないフレームでも、行列だけは今の位置へ合わせる
            spot.shadow.updateMatrices(spot);
        }
    }

    // ── 枠に入らなかった灯りの簡易照明 ──
    if (_fillPatchDirty) _fillPatchModel();
    _fillUpdate(cam);
}

// UI/保存用。
function getAreaLightDefs() { return areaLightDefs; }

// 水面への映り込み（04-scene-and-water-init.js の _updateWaterShipLights）用。
// glbLights に入っているエリアライトは「シーンに居ないデータ保持役」なので、
// ワールド座標を持たない。実際にシーンに居る枠のライトを返す。
function getAreaLightSceneLights() {
    const out = [];
    for (const s of areaLightSlots) {
        if (s.root.visible && s.rect.intensity > 0) out.push(s.rect);
    }
    return out;
}
