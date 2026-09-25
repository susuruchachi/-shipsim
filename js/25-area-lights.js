// 25-area-lights.js — エリアライト（Blenderのエリアライト由来）と、その影
//
// ════════════════════════════════════════════════════════════════
//  なぜ作り直したか
// ════════════════════════════════════════════════════════════════
//  従来（HullGlow方式）は、エリアライトの照明を **自前のGLSLを全マテリアルへ
//  onBeforeCompileで注入して** 計算していた。PointLightで照らすと「点から
//  放射状に照らされる」不自然さが出たため、それを避けようとした結果だった。
//
//  ただしこの方式には次の問題があった。
//    ・面光源の積分を手書きで近似しているため、正しさの保証が無い。実際
//      コードには「壁が暗くなりすぎるのを防ぐ」ための smoothstep(-0.3, 1.0, …)、
//      面外フォールオフ、正面チェックといった、辻褄合わせの項が積み重なって
//      いた。船やライト配置を変えるたびに、どこかが破綻する。
//    ・reflectedLight.directDiffuse に足しているだけなので、**影が一切出ない**。
//    ・全マテリアルのシェーダーを書き換えるため、マテリアル数ぶんシェーダーが
//      増え、他の描画機能と干渉しやすい。
//
//  three.js には面光源そのものである RectAreaLight があり、LTC（線形変換
//  コサイン）という確立した手法で面光源の積分を正しく行う。手書きの近似を
//  捨てて、これに置き換える。
//
// ════════════════════════════════════════════════════════════════
//  影について（three.js側の制約）
// ════════════════════════════════════════════════════════════════
//  **three.js の RectAreaLight は影を落とせない。** r128 のライト処理を見ると、
//  SpotLight や PointLight にある castShadow の分岐が RectAreaLight には
//  存在せず、色・サイズ・位置だけを渡して終わっている。エンジン側の制約なので、
//  エリアライト単体で影を出す方法は無い。
//
//  そこで、影を出す枠には **同じ位置・同じ向きの SpotLight を重ねて** 置き、
//  光量を両者で分け合う（AREA_LIGHT_SHADOW_SHARE）。SpotLight側を強くすると
//  影ははっきりするが「点から照らした感じ」が戻ってくるので、既定は半々。
//  大きな面光源の影は現実でも輪郭がぼやけて薄いので、これは物理的にも自然。
//
// ════════════════════════════════════════════════════════════════
//  「定義」と「枠（スロット）」を分ける
// ════════════════════════════════════════════════════════════════
//  船の窓ひとつひとつがエリアライトになっていると、灯数は数十に達する。
//  一方 LTC の面光源は1灯あたりの負荷が大きく、全部を点けるのは現実的でない。
//
//  さらに three.js では **シーン内で visible なライトの数が変わるたびに
//  全マテリアルのシェーダーが再コンパイルされる**（NUM_RECT_AREA_LIGHTS 等の
//  #define が変わるため）。「カメラに近い灯だけ visible にする」という素朴な
//  やり方だと、船が揺れて順位が入れ替わるたびに再コンパイルが走り、数百ms
//  単位で画面が固まる。
//
//  そこで次の二層構造にする。
//    ・定義(def)   : Empty1個ぶんの情報。位置・向き・サイズを持つノードと、
//                    UI/保存用のデータ保持役（シーンには入れない RectAreaLight）。
//                    何十個あってもよい。描画コストは無い。
//    ・枠(slot)    : 実際にシーンに居るライト。個数は固定。
//                    毎フレーム「カメラに近い定義」を割り当て直して使い回す。
//  灯数が変わらないので再コンパイルが起きず、負荷も一定に保てる。

// 同時に点ける枠の数。LTCは1灯あたりの負荷が大きいのでこの数で頭打ちにする。
const AREA_LIGHT_MAX_ACTIVE = 8;
// そのうち影を落とす枠の数。影はシャドウマップを1枚ずつ描くのでさらに絞る。
const AREA_LIGHT_MAX_SHADOW = 2;
// 光量のうち、影を落とすSpotLightに持たせる割合。
// 1.0 に近づけるほど影は濃くなるが、面光源らしさは失われる。
const AREA_LIGHT_SHADOW_SHARE = 0.5;
// Blenderのエリアライトのエネルギー[W] → three.jsの強度への換算。
// Blender側は数十〜数百Wで置かれることが多いので、そのままでは明るすぎる。
const AREA_LIGHT_WATT_SCALE = 0.03;
// この閾値より大きい値は「Blenderのワット数」とみなして換算し、
// それ以下は既に調整済みの値とみなしてそのまま使う。
const AREA_LIGHT_WATT_THRESHOLD = 20;
// 割り当て直しの間隔[秒]。毎フレームやると船の揺れで順位が細かく入れ替わり、
// 影がちらちら動いて目障りになる。
const AREA_LIGHT_REBIND_INTERVAL = 0.25;
// 影用SpotLightの広がり。面の全体を覆える程度に広く取る。
const AREA_LIGHT_SPOT_ANGLE = Math.PI / 3;
// 照射方向の合わせ込み。
//  Blenderのエリアライトから作られたEmptyは、glTF書き出し後この向きになる:
//      面の法線 = ローカル +Y （この方向を照らす）
//      面の幅   = ローカル X 方向、スケール x が実寸
//      面の高さ = ローカル Z 方向、スケール z が実寸
//  一方 three.js の RectAreaLight は、面がローカル XY 平面にあり
//  **ローカル -Z 方向を照らす**（実測で確認）。X軸まわりに +90° 回して子に
//  持たせると、光の -Z が親の +Y、光の X が親の X、光の Y が親の Z に一致する。
//  もしモデル側の規約が違って裏側が照らされる場合は、ここを -Math.PI/2 にする。
const AREA_LIGHT_EMIT_ROT_X = Math.PI / 2;

let areaLightDefs  = [];   // { node, holder, mirrorOf, mirrorNode, _dist }
let areaLightSlots = [];   // { root, rect, spot }
let _alLastBindAt  = -1;
let _alBinding     = [];   // slotと同じ長さ。各枠に割り当てた定義（無ければnull）

const _alTmpPos   = new THREE.Vector3();
const _alTmpQuat  = new THREE.Quaternion();
const _alTmpScale = new THREE.Vector3();

// Blenderのエネルギー値を three.js の強度へ
function areaLightIntensityFromProps(raw) {
    const v = parseFloat(raw);
    if (!Number.isFinite(v)) return 3.0;
    return v > AREA_LIGHT_WATT_THRESHOLD ? v * AREA_LIGHT_WATT_SCALE : v;
}

// 画質設定から「影を落とす枠の数」と解像度を決める。
// 窓灯りPointLight（08-model-loading-and-lighting.js）が既に最大8灯ぶんの
// キューブ影を使うので、こちらは控えめに積む。
function getAreaLightShadowConfig() {
    const q = (typeof perf !== 'undefined' && perf.quality) ? perf.quality : 'high';
    if (typeof perf !== 'undefined' && !perf.shadowsEnabled) return { count: 0, mapSize: 512 };
    if (q === 'verylow' || q === 'ultralow') return { count: 0, mapSize: 512 };
    if (q === 'low')    return { count: 1, mapSize: 512 };
    if (q === 'medium') return { count: AREA_LIGHT_MAX_SHADOW, mapSize: 512 };
    return { count: AREA_LIGHT_MAX_SHADOW, mapSize: 1024 };
}

function _alDisposeSlots() {
    for (const s of areaLightSlots) {
        if (s.spot && s.spot.shadow && s.spot.shadow.map) {
            s.spot.shadow.map.dispose();
            s.spot.shadow.map = null;
        }
        if (s.root.parent) s.root.parent.remove(s.root);
    }
    areaLightSlots = [];
    _alBinding = [];
    _alLastBindAt = -1;
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
        spot.decay = 1.2;
        spot.castShadow = true;
        spot.shadow.mapSize.set(mapSize, mapSize);
        spot.shadow.bias = -0.0008;
        spot.shadow.normalBias = 0.02;
        spot.shadow.camera.near = 0.2;
        root.add(spot);
        // SpotLightはtargetの方を向く。ローカル+Y側に置けば、枠ごと回っても
        // スポットの向きは常に面の法線（＝Blender側の規約）と一致する。
        spot.target.position.set(0, 1, 0);
        root.add(spot.target);
    }

    if (typeof scene !== 'undefined' && scene) scene.add(root);
    return { root, rect, spot };
}

function _alRebuildSlots(force) {
    const want = Math.min(AREA_LIGHT_MAX_ACTIVE, areaLightDefs.length);
    // 枠の数が変わらないなら作り直さない。作り直すとシャドウマップを捨てることに
    // なるうえ、シーン内のライト数が一時的に変わって全マテリアルの再コンパイルを
    // 招くため、必要なときだけにする。
    if (!force && want === areaLightSlots.length) return;
    _alDisposeSlots();
    if (want <= 0) return;
    const sh = getAreaLightShadowConfig();
    for (let i = 0; i < want; i++) {
        areaLightSlots.push(_alMakeSlot(i < sh.count, sh.mapSize));
    }
    _alBinding = new Array(want).fill(null);
}

// 画質設定が変わったときに呼ぶ（影の枚数・解像度を作り直す）。
function refreshAreaLightShadowQuality() {
    if (areaLightDefs.length === 0) return;
    _alRebuildSlots(true);
}

// エリアライト用Empty群から、定義を組み立てる。
//   empties : userData.type === 'area' のノード配列（まだmodel階層に居るもの）
// Emptyと同じ親・同じローカル変換のノードを置き換えとして残す。こうすると
// モデルの移動・回転・拡縮にシーングラフの継承だけで追従するので、ワールド座標を
// 手計算して焼き込む必要がない（＝modelOffsetを後から変えてもズレない）。
function buildAreaLights(model, empties) {
    disposeAreaLights();
    if (!empties || empties.length === 0) return areaLightDefs;

    empties.forEach((empty, idx) => {
        const ud = empty.userData || {};
        const intensity = areaLightIntensityFromProps(ud.intensity);
        const colorStr = ud.color || '#ffffff';
        const parent = empty.parent || model;

        // ── 位置・向き・サイズの実体となるノード ──
        // UIのXYZ入力もギズモも、従来の areaNode と同じくこのノードを動かす。
        // scale.x が面の幅、scale.z が面の高さ（Blender側の規約）。
        const node = new THREE.Object3D();
        node.position.copy(empty.position);
        node.quaternion.copy(empty.quaternion);
        node.scale.copy(empty.scale);
        node.name = 'AreaLightNode_' + (empty.name || idx);
        parent.add(node);
        parent.remove(empty);

        // ── UI・保存用のデータ保持役 ──
        // 既存のライト一覧UI・保存/復元・ギズモは glbLights の要素を見るので、
        // 定義1個につき1個のライトオブジェクトを持たせる。ただし**シーンには
        // 追加しない**（実際に照らすのは枠のライト）。型を RectAreaLight に
        // しておくと、UI側の「エリアライト扱い」の判定にそのまま乗る。
        const holder = new THREE.RectAreaLight(new THREE.Color(colorStr).getHex(), intensity, 1, 1);
        holder.userData.isGlbLight    = true;
        holder.userData.isAreaLight   = true;
        holder.userData.baseIntensity = intensity;
        holder.userData.labelName     = empty.name || ('Area #' + (idx + 1));
        holder.userData.areaNode      = node;
        if (typeof glbLights !== 'undefined' && Array.isArray(glbLights)) glbLights.push(holder);

        areaLightDefs.push({ node, holder, mirrorOf: null, _dist: 0 });
    });

    _alRebuildSlots(true);
    return areaLightDefs;
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

        const def = { node, holder: m, mirrorOf: src, _dist: 0 };
        areaLightDefs.push(def);
        src.mirror = def;
        holder.userData.mirrorLight = m;
        _alRebuildSlots();
    } else if (src.mirror) {
        const def = src.mirror;
        if (def.node.parent) def.node.parent.remove(def.node);
        const gi = (typeof glbLights !== 'undefined') ? glbLights.indexOf(def.holder) : -1;
        if (gi !== -1) glbLights.splice(gi, 1);
        const di = areaLightDefs.indexOf(def);
        if (di !== -1) areaLightDefs.splice(di, 1);
        src.mirror = null;
        holder.userData.mirrorLight = null;
        _alRebuildSlots();
    }
}

// 定義が「今点いているべきか」。applyGlbLightIntensities() が毎回
// userData.targetVisible / targetIntensity に「こうしたい値」を書いてくれるので、
// 手動OFFや昼間の自動消灯の判定をここで二重に書かずに済む。
function _alDefVisible(def) {
    const src = def.mirrorOf || def;
    return src.holder.userData.targetVisible !== false;
}
function _alDefIntensity(def) {
    const ud = (def.mirrorOf || def).holder.userData;
    if (Number.isFinite(ud.targetIntensity)) return ud.targetIntensity;
    if (Number.isFinite(ud.baseIntensity))   return ud.baseIntensity;
    return (def.mirrorOf || def).holder.intensity;
}

// 毎フレーム。
function updateAreaLights(t) {
    if (areaLightDefs.length === 0 || areaLightSlots.length === 0) return;
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

    // ── 枠の割り当て直し ──
    if ((t - _alLastBindAt) > AREA_LIGHT_REBIND_INTERVAL || _alLastBindAt < 0) {
        _alLastBindAt = t;
        const live = [];
        for (const d of areaLightDefs) {
            if (!_alDefVisible(d)) continue;
            d.node.updateWorldMatrix(true, false);
            _alTmpPos.setFromMatrixPosition(d.node.matrixWorld);
            d._dist = _alTmpPos.distanceTo(cam.position);
            live.push(d);
        }
        live.sort((a, b) => a._dist - b._dist);
        for (let i = 0; i < areaLightSlots.length; i++) {
            _alBinding[i] = live[i] || null;
        }
    }

    // ── 枠へ反映 ──
    for (let i = 0; i < areaLightSlots.length; i++) {
        const slot = areaLightSlots[i];
        const def  = _alBinding[i];
        if (!def) { slot.root.visible = false; continue; }

        // 定義のワールド変換をそのまま枠へ。スケールもワールドで取るので、
        // モデル全体の拡大率（physics.scale・modelOffset）が自動的に効く。
        def.node.updateWorldMatrix(true, false);
        def.node.matrixWorld.decompose(_alTmpPos, _alTmpQuat, _alTmpScale);
        slot.root.position.copy(_alTmpPos);
        slot.root.quaternion.copy(_alTmpQuat);
        slot.root.visible = true;

        const w = Math.max(0.01, Math.abs(_alTmpScale.x));
        const h = Math.max(0.01, Math.abs(_alTmpScale.z));
        const inten = _alDefIntensity(def);
        const color = def.holder.color;

        slot.rect.width  = w;
        slot.rect.height = h;
        slot.rect.color.copy(color);
        slot.rect.intensity = slot.spot ? inten * (1 - AREA_LIGHT_SHADOW_SHARE) : inten;

        if (slot.spot) {
            slot.spot.color.copy(color);
            slot.spot.intensity = inten * AREA_LIGHT_SHADOW_SHARE;
            // 届く範囲。面が大きいほど遠くまで照らす想定。shadow.camera.far は
            // three.js側がこの値から決めるので、短すぎると影が途中で切れる。
            const reach = Math.max(w, h) * 5 + 15;
            slot.spot.distance = reach;
            // 影の深度精度は far/near の比で決まる。船の甲板を丸ごと照らすような
            // 大きな面だと far が数百mになるので、near を置き去りにすると
            // 深度がつぶれてシャドウアクネ（縞）が出る。面のサイズに合わせて
            // near も動かし、比を常識的な範囲に保つ。
            const near = Math.max(0.3, Math.min(w, h) * 0.05);
            if (Math.abs(slot.spot.shadow.camera.near - near) > near * 0.1) {
                slot.spot.shadow.camera.near = near;
                slot.spot.shadow.camera.updateProjectionMatrix();
            }
        }
    }
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
