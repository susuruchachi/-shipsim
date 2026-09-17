// レンダラー生成より前に、自動保存(localStorage)された前回の画質設定が
// 「高」だったかどうかだけを先読みする。まだ何も保存されていない初回起動時は
// 安全側(軽量端末を想定)でfalseを返す。
function shouldEnableAntialiasOnBoot() {
    try {
        const key = (typeof SHIP_AUTOSAVE_KEY !== 'undefined') ? SHIP_AUTOSAVE_KEY : 'susuru_ship_autosave_v2';
        const raw = localStorage.getItem(key);
        if (!raw) return false;
        const cfg = JSON.parse(raw);
        return !!cfg && cfg.perfQuality === 'high';
    } catch (e) { return false; }
}

function init() {
    const container = $('canvas-container');
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x040810);
    scene.fog = new THREE.FogExp2(0x040810, 0.00022);

    camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 12000);
    camera.position.set(0, 15, -35);
    perspCamera = camera; // 通常時の透視投影カメラ（XYZ軸ビュー時はorthoCameraに切り替える）

    // XYZ軸ビュー用の正投影カメラ。left/right/top/bottomはsetAxisView()内でその都度、
    // 船のバウンディングサイズとアスペクト比から再計算するため、ここではプレースホルダ値でよい。
    orthoCamera = new THREE.OrthographicCamera(-50, 50, 50, -50, 0.1, 12000);

    // v89: 画質「高」を選んでいる場合はMSAA(アンチエイリアス)をONにする。
    // 以前は「モバイルのタイルベースGPUはMSAAが重い」という想定で常時OFFにしていたが、
    // 実際にはタイルベース(Mali/Adreno/Apple GPU等)のマルチサンプル解決はタイル内メモリで
    // 完結するため、PC(immediate-mode)ほど致命的な負荷にはならないことが多い。
    // 帆装のワイヤー(ステー)のような細い線がギザギザ/点線状に見えるのはAA無効が主因なので、
    // 「高」を選んだユーザーだけAAも有効化する形にする。
    // ハードウェアMSAAはWebGLコンテキスト生成時にしか指定できず、applyPerfPreset()のように
    // 実行中に動的on/offはできないため、レンダラー生成前のこのタイミングで
    // 前回の自動保存設定を先読みして決める(画質を「高」に変えた直後は、次回リロードから反映)。
    const ENABLE_ANTIALIAS = shouldEnableAntialiasOnBoot();
    // ── 対数深度バッファ（喫水線z-fighting対策の本丸）──
    // near=0.1, far=12000 と視野範囲が非常に広いため、通常の深度バッファだと
    // カメラから遠いほど深度精度が急激に落ちる。船体の水面下メッシュと水面メッシュが
    // ほぼ同じ高さで接するウォーターライン付近では、この精度不足によって
    // 「どちらが手前か」が1ピクセル単位・1フレーム単位で入れ替わり、
    // バリバリ・ギザギザとしたz-fighting（喫水線が暴れて見える症状）が発生し、
    // 遠目になるほど悪化する。polygonOffsetだけでは範囲全体をカバーしきれないため、
    // レンダラー側で対数深度バッファを有効化し、水面用・パーティクル用カスタム
    // シェーダー側にも対応コード（USE_LOGDEPTHBUF分岐）を追加して精度を底上げする。
    renderer = new THREE.WebGLRenderer({ antialias: ENABLE_ANTIALIAS, powerPreference: 'high-performance', logarithmicDepthBuffer: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, perf.pixelRatio));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.85;
    // ── v83: outputEncodingを正しくsRGBEncodingへ戻す ──
    // 以前「Linearのままにする」としていたのは誤診断だった。GLTFLoaderがテクスチャに
    // 付ける sRGBEncoding（入力側のデコード）と、renderer.outputEncoding（出力側の
    // エンコード）は別の場所に一度ずつしかかからず、本来二重変換にはならない。
    // 実際に白飛びした原因は、太陽・アンビエント等の光量をLinear出力（＝ガンマ補正
    // 無しで暗く潰れた見た目）に合わせてチューニングしていたため、正しくsRGB出力
    // した瞬間に全体が想定より明るく/コントラスト高く出て頭打ちしたことだと考えられる。
    // → sRGBEncodingに戻し、その分toneMappingExposureを1.1→1.0へ少し下げて様子見。
    // まだ明るすぎる/眩しい場合は、この値か下のライト強度(sunLight.intensity等)を
    // 下げる。逆にLinearのまま使い続けると、今回追加したシャドウの階調やIBLの
    // 反射も含めて画面全体が眠く見えてしまうため、Linearには戻さないこと。
    renderer.outputEncoding = THREE.sRGBEncoding;
    // ── v84: モバイル(特にiPad/iPhoneのSafari系ブラウザ)で明るく/鮮やかに出る問題の対策 ──
    // SafariにはWebGLキャンバスの出力を「sRGBのはずなのにP3(広色域)として」誤って
    // 解釈してしまう既知の不具合があり、同じピクセル値でもPCのsRGBモニタより
    // 彩度・明るさが強く見えることがある(WebKit bug 262429として報告されている)。
    // drawingBufferColorSpaceを明示的に'srgb'にすると、この誤解釈を避けやすくなる。
    // 古いブラウザではこのプロパティ自体が存在しないため、存在チェック＋try/catchで
    // 安全側に倒す(失敗しても他の描画には影響しない)。
    try {
        const gl = renderer.getContext();
        if (gl && 'drawingBufferColorSpace' in gl) gl.drawingBufferColorSpace = 'srgb';
    } catch (e) { /* 対応していない環境では無視して続行 */ }
    // renderer.physicallyCorrectLights = true;
    // ── シャドウマップ有効化 ──
    // PCFSoftShadowMapは通常のPCFよりエッジが柔らかく、影MOD的な柔らかい
    // 影の見た目に近づく。実際のON/OFFとサイズはperf.shadowsEnabled/
    // shadowMapSize経由でapplyShadowQualityFromPerf()が管理する
    // （sunLight自体はこの少し下で生成されるため、有効化はそちらで行う）。
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // RectAreaLight（エリアライト）のサポートを有効化
    if (THREE.RectAreaLightUniformsLib) THREE.RectAreaLightUniformsLib.init();
    container.appendChild(renderer.domElement);

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.minDistance = 0.1;
    controls.maxDistance = 8000;
    controls.maxPolarAngle = Math.PI * 0.95; // ほぼ真下まで、真上も可
    controls.enablePan = false;

    transformControl = new THREE.TransformControls(camera, renderer.domElement);
    transformControl.setSize(0.7);
    transformControl.addEventListener('dragging-changed', function (event) {
        controls.enabled = !event.value;
    });
    transformControl.addEventListener('change', onGizmoChange);
    scene.add(transformControl);
    restrictRotateGizmoToAxes(transformControl);

    sunLight = new THREE.DirectionalLight(0xffffff, 3.0);
    sunLight.position.set(200, 300, -200);
    scene.add(sunLight);

    // ── 太陽シャドウマップの設定 ──
    // このシーンはnear=0.1/far=12000と非常に広いが、影の解像度を無駄にしないため
    // シャドウカメラの視錐台は「船の周囲」だけをタイトに覆うサイズに固定し、
    // 毎フレーム船の位置へ追従させる（追従処理はjs/17-main-loop.jsの
    // updateSunShadowFollow()）。ここでは視錐台のサイズとバイアスだけを設定する。
    // ※ 想定より大きい/小さい船モデルを読み込んで影が欠ける・粗く見える場合は
    //    下のSHADOW_FRUSTUM_HALF_SIZEを調整する。
    const SHADOW_FRUSTUM_HALF_SIZE = 220;  // 船+航跡+波しぶきを覆う半幅
    const SHADOW_CAM_NEAR = 1;
    const SHADOW_CAM_FAR  = 900;           // 太陽をshipから約500離れた位置に置く前提の余裕分
    sunLight.shadow.camera.left   = -SHADOW_FRUSTUM_HALF_SIZE;
    sunLight.shadow.camera.right  =  SHADOW_FRUSTUM_HALF_SIZE;
    sunLight.shadow.camera.top    =  SHADOW_FRUSTUM_HALF_SIZE;
    sunLight.shadow.camera.bottom = -SHADOW_FRUSTUM_HALF_SIZE;
    sunLight.shadow.camera.near   = SHADOW_CAM_NEAR;
    sunLight.shadow.camera.far    = SHADOW_CAM_FAR;
    sunLight.shadow.mapSize.set(perf.shadowMapSize, perf.shadowMapSize);
    sunLight.shadow.bias       = -0.0008;
    sunLight.shadow.normalBias = 0.4;
    sunLight.shadow.radius     = 3; // PCFSoftShadowMapの追加ソフト化
    sunLight.shadow.camera.updateProjectionMatrix();
    applyShadowQualityFromPerf(); // perf.shadowsEnabledに応じてON/OFFを反映

    // 補助光: 太陽と反対側からの弱い光で、船体の平面が極端に暗く落ちて
    // 「凹んでいる」ように見えるのを和らげる
    fillLight = new THREE.DirectionalLight(0xaaccff, 0.8);
    fillLight.position.set(-150, 120, 180);
    scene.add(fillLight);

    createSkyDome();
    if (typeof initEnvironmentLighting === 'function') initEnvironmentLighting(); // 空を撮影したPMREM環境光(IBL)

    ambientLight = new THREE.AmbientLight(0x4477bb, 1.0);
    scene.add(ambientLight);
    hemiLight = new THREE.HemisphereLight(0xc8dff5, 0x081828, 2.2);
    scene.add(hemiLight);

    createWater();
    createShipGroup();
    if (typeof createViewpointMarkers === 'function') createViewpointMarkers(); // 視点(見張り台)マーカー初期化
    createGlobalSmokeSystem();
    createBubbleSystem();
    createWakeParticleSystem();
    loadEmbeddedOBJ();
    initDeckLightPool();  // 甲板照明ライトプール初期化
    initBloomComposer();  // ブルームポストプロセス初期化

    physics.cgWorldX = shipGroup.position.x;
    physics.cgWorldZ = shipGroup.position.z;

    setupKeyboardControls();
    setupMobileControls();
    setupUIControls();
    setupModelImport();
    setupWindowEvents();
    initSettingsComponents();

    // 設定パネル内の全パラメーターに微調整(±)ボタンを付与
    addFineTuneButtons($('settings-panel') || document);

    // エリアライト変換スクリプトをテキストエリアに設定
    initAreaLightScript();

    controls.target.set(physics.cgWorldX, physics.y, physics.cgWorldZ);
    controls.update();
    updateDayNightCycle(physics.dayProgress);

    // 前回の設定を自動ロード
    autoLoadConfig();

    // ページを閉じる・タブ切替時に自動保存
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') autoSaveConfig(); });
    window.addEventListener('beforeunload', autoSaveConfig);
    // 30秒ごとに自動保存
    setInterval(autoSaveConfig, 30000);
}

// ─────────────────────────────────────────
//  createLodWaterGeometry(innerSegs)
//
//  船周辺が細かく、遠方が粗い「同心矩形LODグリッド」をゼロから生成する。
//
//  【リング設計】
//   Ring0: 半径   0 〜  r0  → innerSegs × innerSegs の均一グリッド（最高密度）
//   Ring1: 半径  r0 〜  r1  → セル幅 r0 の2倍でタイル展開
//   Ring2: 半径  r1 〜  r2  → セル幅 r0 の6倍
//   Ring3: 半径  r2 〜  r3  → セル幅 r0 の18倍
//
//  innerSegs を増やすほど Ring0 が細かくなる（遠方コストはほぼ変わらない）。
//  waterMesh.position を毎フレーム船座標に追従させているため、
//  頂点はローカル座標（中心=0）で生成し、updateWater側でwaterMesh.positionを加算して
//  ワールド座標に変換する。（既存の wx = vx + waterMesh.position.x と同じ方式）
// ─────────────────────────────────────────
function createLodWaterGeometry(innerSegs) {
    const IS = Math.max(8, Math.round(innerSegs)); // Ring0 の格子数（辺）

    // Ring0 の半幅: 船体スケールに応じて動的に決定。
    // physics.scale と hullProfile から現在の船の「見た目半長」を取得し、
    // 船体がRing0に十分収まりつつ、1セルが船全長の1/IS以下になるよう設定する。
    // physics は 04-scene-and-water-init.js より後に定義されるが、
    // この関数は init() から呼ばれるため、その時点では physics が存在する。
    const WS = (typeof physics !== 'undefined' && physics.scale) ? physics.scale : 1;
    const hp = (typeof window !== 'undefined' && window.hullProfile) ? window.hullProfile : null;
    const hullHalfLen_ws  = (hp && hp.ready ? hp.halfLen  : 6.0) * WS;
    const hullHalfBeam_ws = (hp && hp.ready ? hp.halfBeam : 1.5) * WS;

    // ウォーターライン密着の方針:
    // Ring0 の半幅を「船体半幅の ~3倍」に絞ることで、
    // IS セルを船体幅方向に細かく割り当てる。
    // ただし船体全長も Ring0 に収まる必要があるので halfLen*1.2 も考慮し大きい方を採用。
    // 最低15unit は確保（小型船でも破綻しない）。
    const r0 = Math.max(15, Math.max(hullHalfBeam_ws * 3.0, hullHalfLen_ws * 1.2));

    const r1 = r0  * 4.0;               // Ring1 外縁
    const r2 = r1  * 4.0;               // Ring2 外縁
    const r3 = 1800;                     // Ring3 外縁（海面の端）

    const cellW0 = (r0 * 2) / IS;        // Ring0 セル幅
    const cellW1 = cellW0 * 2;           // Ring1 セル幅（2倍粗い）
    const cellW2 = cellW0 * 6;           // Ring2 セル幅（6倍粗い）
    const cellW3 = cellW0 * 18;          // Ring3 セル幅（18倍粗い）

    const positions = [];
    const colors    = [];
    const uvs       = [];
    const ringIds   = [];   // 各頂点のリング番号 (0=Ring0, 1=Ring1, 2=Ring2, 3=Ring3)
    const indices   = [];

    let vtxCount = 0;
    let _currentRing = 0;  // addPatch呼び出し時にセットするリング番号

    // 矩形パッチ1枚を追加する内部ヘルパー
    // x0,z0: 左下隅（ローカル）  x1,z1: 右上隅（ローカル）  nX,nZ: 格子分割数
    function addPatch(x0, z0, x1, z1, nX, nZ) {
        const dx = (x1 - x0) / nX;
        const dz = (z1 - z0) / nZ;
        const base = vtxCount;

        for (let zi = 0; zi <= nZ; zi++) {
            for (let xi = 0; xi <= nX; xi++) {
                const px = x0 + xi * dx;
                const pz = z0 + zi * dz;
                positions.push(px, 0, pz);
                colors.push(0.0, 0.08, 0.22);
                uvs.push((px + r3) / (r3 * 2), (pz + r3) / (r3 * 2));
                ringIds.push(_currentRing);
                vtxCount++;
            }
        }
        for (let zi = 0; zi < nZ; zi++) {
            for (let xi = 0; xi < nX; xi++) {
                const a = base + zi * (nX + 1) + xi;
                const b = a + 1;
                const c = a + (nX + 1);
                const d = c + 1;
                indices.push(a, c, b,  b, c, d);
            }
        }
    }

    // Ring0: 中央の高密度正方形（−r0〜+r0）
    _currentRing = 0;
    addPatch(-r0, -r0, r0, r0, IS, IS);

    // Ring1〜3: 中心正方形を囲むL字形を8方向パッチで構成
    // 各リングは外縁まで埋める（角パッチ4枚 + 辺パッチ4枚）
    function addRing(inner, outer, cellW, ringId) {
        _currentRing = ringId;
        const nSide = Math.max(1, Math.round((outer - inner) / cellW));

        // 上辺・下辺（フルwidth）
        const nTop = Math.max(1, Math.round(outer * 2 / cellW));
        addPatch(-outer,  inner,  outer, outer, nTop, nSide); // 上
        addPatch(-outer, -outer,  outer, -inner, nTop, nSide); // 下
        // 左辺・右辺（inner〜inner の高さ）
        const nLR = Math.max(1, Math.round(inner * 2 / cellW));
        addPatch(-outer, -inner, -inner,  inner, nSide, nLR); // 左
        addPatch( inner, -inner,  outer,  inner, nSide, nLR); // 右
    }

    addRing(r0, r1, cellW1, 1);
    addRing(r1, r2, cellW2, 2);
    addRing(r2, r3, cellW3, 3);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color',    new THREE.Float32BufferAttribute(colors, 3));
    geo.setAttribute('uv',       new THREE.Float32BufferAttribute(uvs, 2));
    // ringId は更新スキップ判定に使う（シェーダーには渡さない）
    geo.setAttribute('ringId',   new THREE.Uint8BufferAttribute(new Uint8Array(ringIds), 1));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    // r0をuserDataに保存（updateWaterでのWAKE_R計算に使う）
    geo.userData.r0 = r0;
    // XZ座標をFlat32Arrayにキャッシュ（updateWaterでgetX/getZの低速アクセスを避ける）
    const _xzCache = new Float32Array(vtxCount * 2);
    for (let i = 0; i < vtxCount; i++) {
        _xzCache[i * 2]     = positions[i * 3];      // x
        _xzCache[i * 2 + 1] = positions[i * 3 + 2];  // z
    }
    geo.userData._xzCache = _xzCache;

    console.log(`[LOD Water] innerSegs=${IS} r0=${r0.toFixed(0)} r1=${r1.toFixed(0)} r2=${r2.toFixed(0)} vtx=${vtxCount} tri=${indices.length/3}`);
    return geo;
}

function rebuildWaterGeometry(segments) {
    if (!waterMesh) return;
    const newGeo = createLodWaterGeometry(segments);
    const oldGeo = waterGeometry;
    waterGeometry = newGeo;
    waterMesh.geometry = newGeo;
    if (oldGeo) oldGeo.dispose();
    // geometry再構築後はフレームカウンタをリセット（楕円外スキップの位相ずれ防止）
    if (typeof updateWater === 'function') updateWater._frame = 0;
}

// ─────────────────────────────────────────
//  _computeReflectionRTSize(baseSize, aspect)
//  画面アスペクト比を保ったまま、長辺がbaseSizeになるようなレンダーターゲットの
//  幅・高さを計算する（正方形固定だと縦長スマホ画面で反射が歪むため）。
// ─────────────────────────────────────────
function _computeReflectionRTSize(baseSize, aspect) {
    const a = Math.max(0.1, aspect || 1.0);
    let w, h;
    if (a >= 1.0) { w = baseSize; h = Math.max(1, Math.round(baseSize / a)); }
    else          { h = baseSize; w = Math.max(1, Math.round(baseSize * a)); }
    return { w, h };
}

// ─────────────────────────────────────────
//  resizeWaterReflectionRT(aspect)
//  onWindowResize()（画面回転・リサイズ時）から呼ばれ、反射レンダーターゲットの
//  サイズを現在の画面アスペクト比に合わせて作り直す。
// ─────────────────────────────────────────
function resizeWaterReflectionRT(aspect) {
    if (!waterReflectionRT) return;
    const dims = _computeReflectionRTSize(512, aspect);
    if (waterReflectionRT.width === dims.w && waterReflectionRT.height === dims.h) return;
    waterReflectionRT.setSize(dims.w, dims.h);
}

function createWater() {
    waterGeometry = createLodWaterGeometry(perf.waterSegments);

    const wNorm1 = createWaterNormalMap(1.0);
    const wNorm2 = createWaterNormalMap(0.45);
    // v162: 「大きめ・小さめの波があってもいい」の要望に対応する3枚目の法線マップ。
    // createWaterNormalMap(scale)はscaleが小さいほどオクターブの周波数が下がり
    // 粒が大きくなる（wNorm2=0.45がwNorm1=1.0より粒が大きいのと同じ理屈）。
    // 既存の2枚(1.0 / 0.45)はどちらも密度の近い"さざ波"止まりで、それより一回り
    // 大きなスケールのうねり成分が欠けていたため、さらに低いscale=0.20で
    // 粒の大きい第3の法線マップを追加する。
    const wNorm3 = createWaterNormalMap(0.20, 22);

    // 水面反射用レンダーターゲット（低解像度でAndroidでも動作）
    // 【修正】以前は固定512×512の正方形で作っていたが、スマホの縦長画面（camera.aspectは
    // 0.5前後）のカメラをこの正方形ターゲットへレンダリングすると、映像が実際の画面比率
    // に対して引き伸ばされた状態でテクスチャに焼き込まれてしまう。その後、水面シェーダー
    // 側では「本来の（正しいアスペクト比の）画面座標」でこのテクスチャをサンプリングする
    // ため、位置・形状がズレた反射になっていた（見張り台のような近距離・高精細な視点で
    // 特に目立った）。
    // → レンダーターゲットのサイズを実際の画面アスペクト比に合わせて作る/リサイズする
    //   ようにした。解像度は抑えつつ（長辺512px程度）、比率だけは画面と一致させる。
    const RT_SIZE = 512;
    const initAspect = window.innerWidth / window.innerHeight;
    const initRtDims = _computeReflectionRTSize(RT_SIZE, initAspect);
    waterReflectionRT = new THREE.WebGLRenderTarget(initRtDims.w, initRtDims.h, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
    });
    waterReflectionCamera = new THREE.PerspectiveCamera();

    // 船明かり反射用ユニフォーム（最大16個のエリアライト）
    const WATER_SHIP_LIGHT_MAX = 16;
    const waterShipLightPositions   = [];
    const waterShipLightColors      = [];
    const waterShipLightIntensities = new Float32Array(WATER_SHIP_LIGHT_MAX);
    for (let i = 0; i < WATER_SHIP_LIGHT_MAX; i++) {
        waterShipLightPositions.push(new THREE.Vector3());
        waterShipLightColors.push(new THREE.Color(1, 1, 1));
    }

    const waterUniforms = {
        normalMap1: { value: wNorm1 },
        normalMap2: { value: wNorm2 },
        normalMap3: { value: wNorm3 },
        // v161-v3: 法線マップ生成を12オクターブのランダム合成に変更し、単体の
        // 凹凸振幅がv160時点よりかなり強くなったため、normalScaleは0.38よりやや
        // 控えめの0.32に調整（強すぎるとチカチカしすぎるため）。
        // v161-v4: 「もう少し荒く・波の頭をシャープに」の要望で、法線マップ生成に
        // リッジ(尖った山)成分を混ぜ、周波数もやや低め(粒を大きく)にしたのに
        // 合わせて、normalScaleも0.32→0.36に少し上げて凹凸をしっかり見せる。
        // v162: 上のコントラストカーブ追加＋3枚目の大波マップ追加＋specular乗数の
        // 見直し(下記シェーダー参照)により見た目の総凹凸量が上がったため、
        // 極端にチカチカしないよう0.36→0.33へ少し戻して調整。
        normalScale: { value: new THREE.Vector2(0.33, 0.33) },
        // v163: 視差マッピングのON/OFF。低スペック機ではWATER_PRESETSのverylowで
        // falseになり、シェーダー内でハイトサンプリング＋UVオフセットをスキップして
        // 従来通りuv1/uv2/uv3をそのまま法線サンプリングに使う（負荷を増やさない）。
        parallaxEnabled: { value: 1.0 },
        time: { value: 0.0 },
        sunDir: { value: new THREE.Vector3(0.45, 0.82, -0.36).normalize() },
        sunColor: { value: new THREE.Color(1.0, 0.96, 0.85) },
        // v120: v45の海色パレットに戻した（v93で「もっと濃い群青っぽい色に」の要望により
        // 青み(B)を強めて彩度を上げていたが、今回それ以前の落ち着いた色合いに戻す方針）。
        deepColor: { value: new THREE.Color(0.008, 0.04, 0.14) },
        shallowColor: { value: new THREE.Color(0.02, 0.12, 0.32) },
        foamColor: { value: new THREE.Color(0.92, 0.97, 1.00) },
        // 船明かり反射
        shipLightCount:       { value: 0 },
        shipLightPositions:   { value: waterShipLightPositions },
        shipLightColors:      { value: waterShipLightColors },
        shipLightIntensities: { value: waterShipLightIntensities },
        // 船体・景色の反射テクスチャ
        reflectionTex:    { value: waterReflectionRT.texture },
        reflectionStrength: { value: 0.75 },
        // 【反射方式修正】反射カメラ視点のクリップ空間へワールド座標を投影するための
        // テクスチャ行列（bias * reflCam.projectionMatrix * reflCam.matrixWorldInverse）。
        // 17-main-loop.js の updateWaterReflection() が反射カメラを更新するたびに
        // このuniformも一緒に更新する。
        textureMatrix: { value: new THREE.Matrix4() },
    };
    // 毎フレーム glbLights からユニフォームを更新する関数（main-loopから呼ぶ）
    window._updateWaterShipLights = function() {
        const lights = (window.glbLights || []).filter(l => l.visible && l.intensity > 0);
        const cnt = Math.min(lights.length, WATER_SHIP_LIGHT_MAX);
        waterUniforms.shipLightCount.value = cnt;
        const _wp = new THREE.Vector3();
        for (let i = 0; i < cnt; i++) {
            const l = lights[i];
            if (l.getWorldPosition) l.getWorldPosition(_wp); else _wp.copy(l.position);
            waterShipLightPositions[i].copy(_wp);
            waterShipLightColors[i].copy(l.color);
            waterShipLightIntensities[i] = l.intensity * 0.18;
        }
        waterUniforms.shipLightIntensities.value = waterShipLightIntensities;
    };
    window.waterShipLightUniforms = waterUniforms; // 外部参照用

    // ── 船体マスク用ユニフォーム（ウォーターラインポリゴン方式）──
    // 毎フレーム hullProfile（既にスキャン済みの軽量な船体断面データ）から
    // 喫水線の輪郭ポリゴンを生成しシェーダーに渡す。生のメッシュ三角形を
    // 走査する方式（下の _updateWaterHullMask、現在未使用）より大幅に軽量。
    // v130: 船首尾ファインポイント（片端2点×2端×2舷=8点）を追加したぶん、
    // 32→40に拡張。GLSL側のwlPtsX[40]/wlPtsZ[40]も合わせて変更している。
    const MAX_WL_PTS = 40;
    Object.assign(waterUniforms, {
        wlPtCount: { value: 0 },
        wlPtsX:    { value: new Float32Array(MAX_WL_PTS) },
        wlPtsZ:    { value: new Float32Array(MAX_WL_PTS) },
        // v165: 各輪郭点の「濡れ具合」(0=完全に離水〜1=しっかり沈んでいる)。
        // 以前は離水した点をポリゴンから間引いていたが、そうすると輪郭の
        // 点の並び自体が毎フレーム変わり、閉じる辺が船体を横切って水面上を
        // 直線状に走る（＝泡が船体からはみ出す/内側に食い込む）原因になって
        // いた。点は常に全部揃えたまま、この重みでフラグメント側の泡の
        // 濃さを落とすことで、輪郭のトポロジーを壊さずに離水部分だけ
        // 泡を消す。
        wlWet:     { value: new Float32Array(MAX_WL_PTS) },
        hullBoundCenter: { value: new THREE.Vector2(0, 0) },
        hullBoundRadius: { value: 0.0 },
        // v165: 喫水線の泡帯の幅。従来は1.1mの固定値で、小さい船では
        // 船体から大きくはみ出し、大きい船では細すぎて見えなかった。
        // 船体サイズに比例させる（updateHullWaterlinePolygonで毎フレーム更新）。
        hullFoamWidth:   { value: 1.1 },
    });

    // ── GPU波・引き波（Kelvin wake）計算用ユニフォーム ──
    // 以前はCPU側で「全頂点 × 航跡履歴」のループを毎フレーム計算しており重かったが、
    // 頂点シェーダーに移植してGPU側の並列計算に任せることでCPUコストをほぼゼロにする。
    const MAX_WAKE = 32;
    window._MAX_WAKE = MAX_WAKE;
    Object.assign(waterUniforms, {
        waveRoughnessU: { value: 1.0 },
        waveWidthU:     { value: 1.0 },
        swellStrengthU: { value: 1.0 },
        chopStrengthU:  { value: 1.0 },
        windDirU:       { value: (typeof physics !== 'undefined' && typeof physics.windDir === 'number') ? physics.windDir : 45 },
        windSpeedU:     { value: (typeof physics !== 'undefined' && typeof physics.windSpeed === 'number') ? physics.windSpeed : 5 },
        physScaleU:     { value: 1.0 },
        hullHalfLenU:   { value: 6.0 },
        hullSliceCountU:{ value: 0 },
        hullWidthsU:    { value: new Float32Array(24) }, // HULL_SLICESと同数。alongNorm=-1..+1に等間隔対応
        // v113-fix: 通常スライス配列は実際には alongNorm=[-0.9,+0.9]程度の範囲しか
        // カバーしておらず、その外側（船首/船尾のごく先端）は実測タイポイントへ向けて
        // 減衰させる必要がある。CPU側_hullHalfWidthAtNormと同じロジックをGPU側にも
        // 持たせるため、範囲とタイポイントをuniformで渡す。
        hullSliceAlongMinU: { value: -1.0 }, // hp.slices[0].alongNorm
        hullSliceAlongMaxU: { value:  1.0 }, // hp.slices[last].alongNorm
        bowTipAlongNormU:   { value: 1.0 },
        bowTipWidthU:       { value: 0.0 },
        sternTipAlongNormU: { value: -1.0 },
        sternTipWidthU:     { value: 0.0 },
        pitchOmegaU:    { value: 1.0 }, // ピッチ自然角周波数[rad/s]。大型船ほど小さい→波長が長くなる
        bowFullnessU:   { value: 1.0 },
        sternFullnessU: { value: 1.0 },
        wakeCount:      { value: 0 },
        wakeXZTH:       { value: Array.from({ length: MAX_WAKE }, () => new THREE.Vector4()) },
        wakeSpeed:      { value: new Float32Array(MAX_WAKE) },
    });

    // ── ウォーターライン走査 & 凸包 ──
    // 走査コストを抑えるため、インデックス付き三角形キャッシュを初回だけ構築する。
    const _wlCache = {
        // ローカル座標キャッシュ: shipGroup 基準の三角形頂点
        // [ax,ay,az, bx,by,bz, cx,cy,cz, ...]
        // 船の移動・回転とは独立しているため、モデル形状変更時のみ再構築
        trisLocal: null,
        dirty: true,
    };

    // importedModelGroupが更新されたら呼ぶ（モデルロード時・パーツ移動後）
    window._invalidateWlCache = function() { _wlCache.dirty = true; };

    function _buildWlCache() {
        if (!importedModelGroup || !shipGroup) return;
        // shipGroup 基準のローカル座標で三角形をキャッシュ
        shipGroup.updateWorldMatrix(true, true);
        const invShipMat = new THREE.Matrix4().copy(shipGroup.matrixWorld).invert();
        const tmp = new THREE.Vector3();
        const trisArr = [];
        importedModelGroup.traverse((node) => {
            if (!node.isMesh) return;
            const geo = node.geometry;
            if (!geo || !geo.attributes.position) return;
            node.updateWorldMatrix(true, false);
            // node.matrixWorld → shipGroup ローカル座標
            const relMat = new THREE.Matrix4().multiplyMatrices(invShipMat, node.matrixWorld);
            const pos = geo.attributes.position;
            const idx = geo.index;
            const triCount = idx ? idx.count / 3 : pos.count / 3;
            for (let t = 0; t < triCount; t++) {
                const ia = idx ? idx.getX(t * 3)     : t * 3;
                const ib = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
                const ic = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
                tmp.fromBufferAttribute(pos, ia).applyMatrix4(relMat);
                const ax = tmp.x, ay = tmp.y, az = tmp.z;
                tmp.fromBufferAttribute(pos, ib).applyMatrix4(relMat);
                const bx = tmp.x, by = tmp.y, bz = tmp.z;
                tmp.fromBufferAttribute(pos, ic).applyMatrix4(relMat);
                const cx = tmp.x, cy = tmp.y, cz = tmp.z;
                trisArr.push(ax, ay, az, bx, by, bz, cx, cy, cz);
            }
        });
        _wlCache.trisLocal = new Float32Array(trisArr);
        _wlCache.dirty = false;
        console.log(`[WlCache] rebuilt: ${trisArr.length / 9} triangles (shipGroup-local)`);
    }

    // 三角形エッジと水面Yの交点XZを返す（交差しない場合 null）
    function _edgeXZ(ax, ay, az, bx, by, bz, wY) {
        // a と b が水面Yをまたいでいるか？
        if ((ay - wY) * (by - wY) >= 0) return null;
        const t = (wY - ay) / (by - ay);
        return [ax + t * (bx - ax), az + t * (bz - az)];
    }

    // Graham scan 凸包（XZ点群 → 時計回り頂点列）
    function _convexHull(pts) {
        if (pts.length <= 3) return pts;
        // 最下点（Z最小、同一ならX最小）を基準にソート
        let base = 0;
        for (let i = 1; i < pts.length; i++) {
            if (pts[i][1] < pts[base][1] || (pts[i][1] === pts[base][1] && pts[i][0] < pts[base][0])) base = i;
        }
        const [bx, bz] = pts[base];
        pts.splice(base, 1);
        pts.sort((a, b) => {
            const angA = Math.atan2(a[1] - bz, a[0] - bx);
            const angB = Math.atan2(b[1] - bz, b[0] - bx);
            return angA - angB;
        });
        pts.unshift([bx, bz]);
        const hull = [pts[0], pts[1]];
        for (let i = 2; i < pts.length; i++) {
            while (hull.length >= 2) {
                const [ox, oz] = hull[hull.length - 2];
                const [ex, ez] = hull[hull.length - 1];
                const [nx, nz] = pts[i];
                // 外積（反時計回りチェック）
                if ((ex - ox) * (nz - oz) - (ez - oz) * (nx - ox) <= 0) hull.pop();
                else break;
            }
            hull.push(pts[i]);
        }
        return hull;
    }

    // 毎フレーム呼び出す：現在の水面Yと船体三角形からウォーターラインを抽出
    // ── ローカル→ワールド変換用の使い回しオブジェクト ──
    const _wlTmpV = new THREE.Vector3();

    window._updateWaterHullMask = function() {
        // キャッシュ再構築（モデルロード後・パーツ移動後のみ）
        if (_wlCache.dirty) _buildWlCache();
        if (!_wlCache.trisLocal || _wlCache.trisLocal.length === 0 || !shipGroup) {
            waterUniforms.wlPtCount.value = 0;
            return;
        }

        // ── スロットル: 3フレームに1回のみ再計算（モバイルGPU負荷軽減）──
        if (!window._updateWaterHullMask._frame) window._updateWaterHullMask._frame = 0;
        window._updateWaterHullMask._frame++;
        if (window._updateWaterHullMask._frame % 3 !== 0) return;

        // shipGroup.matrixWorld でローカル→ワールド変換
        const mat = shipGroup.matrixWorld;

        // 水面Y = 0（ワールド座標での海面は常にY≈0、波は別途頂点シェーダーで処理）
        // 交線判定はY=0平面でやることで、波の凹凸に関係なく船体/水面の交線が正確に出る
        const wY = 0.0;

        const trisL = _wlCache.trisLocal;
        const rawPts = [];

        // ローカル座標の三角形をワールド座標に変換しながら交線を取る
        for (let t = 0; t < trisL.length; t += 9) {
            _wlTmpV.set(trisL[t],   trisL[t+1], trisL[t+2]).applyMatrix4(mat);
            const ax = _wlTmpV.x, ay = _wlTmpV.y, az = _wlTmpV.z;
            _wlTmpV.set(trisL[t+3], trisL[t+4], trisL[t+5]).applyMatrix4(mat);
            const bx = _wlTmpV.x, by = _wlTmpV.y, bz = _wlTmpV.z;
            _wlTmpV.set(trisL[t+6], trisL[t+7], trisL[t+8]).applyMatrix4(mat);
            const cx = _wlTmpV.x, cy = _wlTmpV.y, cz = _wlTmpV.z;
            const p1 = _edgeXZ(ax, ay, az, bx, by, bz, wY);
            const p2 = _edgeXZ(bx, by, bz, cx, cy, cz, wY);
            const p3 = _edgeXZ(cx, cy, cz, ax, ay, az, wY);
            if (p1) rawPts.push(p1);
            if (p2) rawPts.push(p2);
            if (p3) rawPts.push(p3);
        }

        if (rawPts.length < 3) {
            waterUniforms.wlPtCount.value = 0;
            return;
        }

        // 凸包 → MAX_WL_PTS点に均等間引き
        const hull = _convexHull(rawPts);

        // ── 凸包を少し外側に膨らます（inflate）──
        // 凸包は凸形状しか表現できないため、船尾スクリュー付近などの凹み形状では
        // 実際のウォーターラインより内側になってしまい隙間ができる。
        // 重心を計算し、各頂点を外方向に INFLATE_M メートル分押し出す。
        const INFLATE_M = 0.25; // 25cm外側に膨らます
        if (hull.length >= 3) {
            let cx = 0, cz = 0;
            for (const pt of hull) { cx += pt[0]; cz += pt[1]; }
            cx /= hull.length; cz /= hull.length;
            for (const pt of hull) {
                const dx = pt[0] - cx, dz = pt[1] - cz;
                const len = Math.sqrt(dx*dx + dz*dz) + 1e-6;
                pt[0] += (dx / len) * INFLATE_M;
                pt[1] += (dz / len) * INFLATE_M;
            }
        }

        const n = Math.min(hull.length, MAX_WL_PTS);
        const step = hull.length / n;
        const pxArr = waterUniforms.wlPtsX.value;
        const pzArr = waterUniforms.wlPtsZ.value;
        const wetArr = waterUniforms.wlWet.value;
        for (let i = 0; i < n; i++) {
            const hi = Math.floor(i * step);
            pxArr[i] = hull[hi][0];
            pzArr[i] = hull[hi][1];
            wetArr[i] = 1.0; // この経路（生メッシュ凸包・現在未使用）は離水判定を持たない
        }
        waterUniforms.wlPtCount.value = n;
    };

    // v166: 輪郭計算用の共有スクラッチ。毎フレーム呼ばれるのでアロケーションしない。
    const _wlEnds = { k0:0, k1:0, f:0, sternAlong:0, bowAlong:0 };
    const _wlSpan = { lo:0, hi:0, tt:0 };
    const _wlHalf = MAX_WL_PTS >> 1;
    const _wlStbd = { along: new Float64Array(_wlHalf), hw: new Float64Array(_wlHalf), wet: new Float64Array(_wlHalf) };
    const _wlPort = { along: new Float64Array(_wlHalf), hw: new Float64Array(_wlHalf), wet: new Float64Array(_wlHalf) };

    // ── ウォーターラインポリゴン（hullProfile.shape ベース）──
    // v166: 船首・船尾形状の取得を作り直した（js/22-hull-shape.js 参照）。
    //
    // 【旧実装が船首尾を再現できなかった理由】
    // 旧実装は「24等分スライスの半幅」＋「船首尾専用の実測タイポイント」
    // ＋「先端手前を埋めるファインポイント」＋「タイポイントのalong位置プロファイル」
    // …という別々のデータを繋ぎ合わせて1本の輪郭を組み立てていた。これらは
    // それぞれ独立した近似・独立したフォールバックを持つため、
    //   ・タイポイントが最後の通常スライスより内側に来て輪郭がねじれる
    //   ・ファインポイントとスライスで幅の出所が違い、繋ぎ目で段差ができる
    //   ・along格子が全高で固定なので、レーキした船首材やカウンタースターンの
    //     「高さによって前後端が動く」挙動を原理的に表現できない
    // といった破綻が船型ごとに現れた。Olympicはレーキ船首とカウンタースターンを
    // 併せ持つため、その全部が同時に出る。
    //
    // 【新実装】
    // hp.shape は高さレベルごとに「その高さ自身の前後端で正規化した半幅
    // プロファイル」を持つ。輪郭は station を順に辿るだけで組み上がり、
    // 前後端も高さに応じて補間で動くので、船首尾の特別扱いが一切要らない。
    // 点の並び順・点数は毎フレーム固定なので、シェーダー側の距離場も安定する。
    //
    // 【傾き追従】各stationについて、その場所の実際の波高とロール・ピッチから
    // 「船体ローカル座標系で見た今の水面の高さ」を求め、その高さでの輪郭を引く。
    // ヒーブ・ロール・ピッチ・波のすべてが自動的に効く。
    window.updateHullWaterlinePolygon = function(t) {
        const hp = window.hullProfile;
        const shape = hp && hp.shape;
        if (!hp || !hp.ready || !shape || !shape.ready) {
            waterUniforms.wlPtCount.value = 0;
            waterUniforms.hullBoundRadius.value = 0;
            if (window._hullWaterlineDyn) window._hullWaterlineDyn.ready = false;
            return;
        }

        // 片舷あたりの点数。MAX_WL_PTS(40)を左右で折半する。
        // shape側は48station持っているが、シェーダーのuniform配列の都合で
        // ここでは20点に間引く（コサイン配置のまま間引くので船首尾は密なまま）。
        const N_SIDE = MAX_WL_PTS >> 1;

        const physScale  = Math.max(0.25, (typeof physics !== 'undefined' && physics.scale) || 1);
        const headingRad = (typeof physics !== 'undefined') ? (physics.heading * Math.PI) / 180 : 0;
        const totalRad   = (typeof _wakeAxisRad === 'function') ? _wakeAxisRad(headingRad) : headingRad;
        // 重心(cgOffset)がローカル原点からズレていても輪郭が船体からズレないよう、
        // 船体スキャン座標系の原点を求めてから along/perp をワールドへ載せる。
        let cx, cz;
        if (typeof _hullOriginWorld === 'function' && typeof physics !== 'undefined') {
            const _o = _hullOriginWorld(physics.cgWorldX, physics.cgWorldZ, totalRad, physScale);
            cx = _o.x; cz = _o.z;
        } else {
            cx = (typeof physics !== 'undefined') ? physics.cgWorldX : 0;
            cz = (typeof physics !== 'undefined') ? physics.cgWorldZ : 0;
        }
        const sinT = Math.sin(totalRad), cosT = Math.cos(totalRad);
        const tNow = (typeof t === 'number') ? t : ((typeof clock !== 'undefined') ? clock.getElapsedTime() : 0);

        const roll  = (typeof physics !== 'undefined') ? physics.roll  : 0;
        const pitch = (typeof physics !== 'undefined') ? physics.pitch : 0;
        const shipY = (typeof physics !== 'undefined') ? physics.y     : 0;
        const waterlineYScaled = ((typeof physics !== 'undefined') ? physics.waterlineOffsetY : 0) * physScale;
        const sinP = Math.sin(pitch), cosP = Math.cos(pitch), sinR = Math.sin(roll);

        // 船体ローカル y=0 がワールドのどの高さにあるか。
        // shipY(=喫水基準点のワールドY)から waterlineOffsetY のスケール分を戻す。
        const originY = shipY - waterlineYScaled;

        // 【局所水面高さの導出】
        //   keelYSide  = originY + localY*physScale - alongW*sinP + sign*hwW*sinR*cosP
        // を localY について解くと、そのstationで水面に相当するローカルYは
        //   localWaterY = (waveY - originY + alongW*sinP - sign*hwW*sinR*cosP) / physScale
        // となる。旧実装はここにスライスごとのdraftを噛ませていたが、式の上では
        // 完全に相殺する項であり、しかもメッシュによっては実測に失敗して
        // 極端な値（実測: 組み込みモデルで0.165）になることがあった。
        // 相殺する項は最初から書かない方が安全で、かつ速い。
        const localWaterYAt = (alongW, hwW, sign, waveY) =>
            (waveY - originY + alongW * sinP - sign * hwW * sinR * cosP) / physScale;

        const pxArr  = waterUniforms.wlPtsX.value;
        const pzArr  = waterUniforms.wlPtsZ.value;
        const wetArr = waterUniforms.wlWet.value;
        let n = 0;

        // 共有スクラッチ（毎フレーム呼ばれるのでアロケーションしない）
        const ends = _wlEnds, span = _wlSpan;

        // 設計喫水での輪郭を初期推定に使う
        hullShapeEndsAtY(shape, shape.designWaterlineY, ends);
        const refStern = ends.sternAlong, refBow = ends.bowAlong;

        // 1station分を解く。u は輪郭上の正規化位置（0=船尾端, 1=船首端）。
        // alongW/hwW は互いに依存する（ロール項とレーキ）ので数回反復して収束させる。
        const solveStation = (u, sign) => {
            // 初期推定は設計喫水の輪郭。endsは共有スクラッチなので、前のstationの
            // 状態を引きずらないよう毎回ここで設計喫水に戻してから始める。
            hullShapeEndsAtY(shape, shape.designWaterlineY, ends);
            let alongLocal = refStern + (refBow - refStern) * u;
            let hwLocal = hullShapeHwAtU(shape, ends.k0, ends.k1, ends.f, u, span);

            // 波高サンプルは1回だけ。getWaveHeight(...,true)は引き波の履歴を
            // 走査するのでこの関数の中で最も重く、station数×2舷ぶん毎フレーム
            // 呼ばれる。水面形状は船体スケールに対して十分緩やかなので、
            // 仮位置での1サンプルで実用上の精度が出る（旧実装も同じ判断）。
            // 一方、along/半幅/高さレベルの相互依存（レーキとロール）は
            // 波高を固定したまま数回反復すれば十分収束する。
            const alongW0 = alongLocal * physScale;
            const hwW0 = hwLocal * physScale;
            const waveY = (typeof getWaveHeight === 'function')
                ? getWaveHeight(cx + sinT * alongW0 + cosT * sign * hwW0,
                                cz + cosT * alongW0 - sinT * sign * hwW0, tNow, true)
                : 0;

            let localWaterY = shape.designWaterlineY;
            for (let it = 0; it < 3; it++) {
                localWaterY = localWaterYAt(alongLocal * physScale, hwLocal * physScale, sign, waveY);
                hullShapeEndsAtY(shape, localWaterY, ends);
                alongLocal = ends.sternAlong + (ends.bowAlong - ends.sternAlong) * u;
                hwLocal = hullShapeHwAtU(shape, ends.k0, ends.k1, ends.f, u, span);
            }
            // 濡れ具合。輪郭の上の点は定義上すべて水と接しているので、
            // 消すべきなのは「その断面がキールより上に出た＝空中にある」場合だけ。
            const wet = hullShapeWetness(shape, localWaterY);
            return { alongLocal, hwLocal, wet };
        };

        // パーティクル側（18-hull-wake-physics.js）と共有する実喫水線テーブル
        const wlDyn = window._hullWaterlineDyn || (window._hullWaterlineDyn = {
            ready: false, time: -1, n: 0,
            alongNorm: new Float64Array(N_SIDE),
            hwStbd: new Float64Array(N_SIDE), hwPort: new Float64Array(N_SIDE),
            wetStbd: new Float64Array(N_SIDE), wetPort: new Float64Array(N_SIDE),
        });
        if (wlDyn.alongNorm.length !== N_SIDE) {
            wlDyn.alongNorm = new Float64Array(N_SIDE);
            wlDyn.hwStbd  = new Float64Array(N_SIDE); wlDyn.hwPort  = new Float64Array(N_SIDE);
            wlDyn.wetStbd = new Float64Array(N_SIDE); wlDyn.wetPort = new Float64Array(N_SIDE);
        }
        wlDyn.n = N_SIDE;

        // 左右それぞれ解く。u はコサイン配置（shape内のstation配置と同じ考え方で、
        // 船首尾を密に取る）。
        const uOf = (i) => 0.5 * (1 - Math.cos(Math.PI * i / (N_SIDE - 1)));
        const stbd = _wlStbd, port = _wlPort;
        for (let i = 0; i < N_SIDE; i++) {
            const u = uOf(i);
            const rs = solveStation(u, 1);
            const rp = solveStation(u, -1);
            stbd.along[i] = rs.alongLocal; stbd.hw[i] = rs.hwLocal; stbd.wet[i] = rs.wet;
            port.along[i] = rp.alongLocal; port.hw[i] = rp.hwLocal; port.wet[i] = rp.wet;
        }

        // along方向の単調性を保証する。各stationが自分の局所水面高さで輪郭を引くため、
        // 強いピッチや波で稀に前後が入れ替わることがあり、そのまま多角形にすると
        // 自己交差してシェーダーの距離場が破綻する（旧実装で船首がV字に割れた症状と
        // 同じ原因）。ここで潰しておけば、以降の処理は順序を信頼してよい。
        for (let i = 1; i < N_SIDE; i++) {
            if (stbd.along[i] < stbd.along[i-1]) stbd.along[i] = stbd.along[i-1];
            if (port.along[i] < port.along[i-1]) port.along[i] = port.along[i-1];
        }

        // 共有テーブルへ（alongNormはhalfLen基準。パーティクル側の規約に合わせる）
        const halfLen = Math.max(hp.halfLen, 1e-6);
        for (let i = 0; i < N_SIDE; i++) {
            wlDyn.alongNorm[i] = ((stbd.along[i] + port.along[i]) * 0.5) / halfLen;
            wlDyn.hwStbd[i] = stbd.hw[i]; wlDyn.wetStbd[i] = stbd.wet[i];
            wlDyn.hwPort[i] = port.hw[i]; wlDyn.wetPort[i] = port.wet[i];
        }

        // ポリゴンを一周させる: 右舷を船尾→船首、左舷を船首→船尾。
        // 点数・並び順は毎フレーム同一（N_SIDE*2点）なので、離水した区間も
        // 点を間引かずwet=0で消す（v165で確立した方針をそのまま踏襲）。
        const emit = (alongLocal, hwLocal, wet, sign) => {
            if (n >= MAX_WL_PTS) return;
            const alongW = alongLocal * physScale;
            const hwW = hwLocal * physScale;
            pxArr[n]  = cx + sinT * alongW + cosT * sign * hwW;
            pzArr[n]  = cz + cosT * alongW - sinT * sign * hwW;
            wetArr[n] = wet;
            n++;
        };
        for (let i = 0; i < N_SIDE; i++) emit(stbd.along[i], stbd.hw[i], stbd.wet[i], 1);
        for (let i = N_SIDE - 1; i >= 0; i--) emit(port.along[i], port.hw[i], port.wet[i], -1);

        waterUniforms.wlPtCount.value = n;
        waterUniforms.hullBoundCenter.value.set(cx, cz);
        waterUniforms.hullBoundRadius.value = hp.halfLen * physScale * 1.6 + 5.0;
        // 泡帯の幅は船体サイズ追従（係数0.037は全長60m級で従来の固定値1.1mになる値）
        waterUniforms.hullFoamWidth.value = Math.min(2.4, Math.max(0.4, hp.halfLen * physScale * 0.037));

        // 診断用（画面には出さない。コンソールで window.__wlDebug を見る）
        window.__wlDebug = {
            wlPtCount: n,
            stations: N_SIDE,
            // 今フレームで実際に使われた輪郭の前後端（右舷の船尾側/船首側station）
            sternAlong: +stbd.along[0].toFixed(3),
            bowAlong:   +stbd.along[N_SIDE - 1].toFixed(3),
            // 比較用の設計喫水での前後端
            designStern: +refStern.toFixed(3),
            designBow:   +refBow.toFixed(3),
        };

        wlDyn.time = tNow;
        wlDyn.ready = true;
    };

    // ── SWE displacement map 用の uniform を追加 ──
    Object.assign(waterUniforms, {
        sweMap:        { value: null },
        sweEnabled:    { value: false },
        sweGridOrigin: { value: new THREE.Vector2(0, 0) },
        sweGridSize:   { value: 180.0 },
        sweScale:      { value: 1.0 },
    });
    // ── v83: 太陽シャドウマップを水面でも手動サンプリングするためのuniform ──
    // waterMatは完全自前のShaderMaterialなのでThree.js標準のreceiveShadowは
    // 自動では効かない。sunLight.shadow.map/matrixを毎フレームここへ流し込み、
    // フラグメントシェーダー側で自前のシャドウ判定を行う（更新はjs/17-main-loop.js）。
    Object.assign(waterUniforms, {
        sunShadowMap:    { value: null },
        sunShadowMatrix: { value: new THREE.Matrix4() },
        sunShadowActive: { value: false },
        sunShadowMapSize:{ value: perf.shadowMapSize },
    });
    window._waterUniforms = waterUniforms;

    const waterMat = new THREE.ShaderMaterial({
        uniforms: waterUniforms,
        transparent: false,
        depthWrite: true,
        depthTest: true,
        // v153-fix3: gl_FragDepthEXT(EXT_frag_depth拡張)を使う経路をやめたため、
        // この拡張フラグ自体が不要になった。
        // ── z-fighting対策 ──
        // 船体の水面下メッシュと水面メッシュがほぼ同じ深度になる箇所があり、
        // どちらもopaque(depthWrite:true/depthTest:true)なので、深度バッファの
        // 精度限界でどちらが手前か毎フレーム入れ替わってしまい、境界が
        // バリバリとチラつく(z-fighting)。カメラから遠いほど深度バッファの
        // 精度が落ちる（near=0.1, far=12000と範囲が広いため）ため、
        // 遠目で症状が悪化するのもこれで説明がつく。
        // polygonOffsetで水面を常にわずかに「奥」側へバイアスし、際どい
        // 深度の引き分けで必ず船体側が勝つようにして解消する。
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
        defines: { USE_COLOR: '', WATER_SHIP_LIGHT_MAX: WATER_SHIP_LIGHT_MAX, MAX_WAKE: MAX_WAKE, MAX_WL_PTS: MAX_WL_PTS },
        vertexShader: `
            uniform sampler2D sweMap;
            uniform bool      sweEnabled;
            uniform vec2      sweGridOrigin;
            uniform float     sweGridSize;
            uniform float     sweScale;
            uniform float     time;
            uniform float     waveRoughnessU;
            uniform float     waveWidthU;
            uniform float     swellStrengthU;
            uniform float     chopStrengthU;
            uniform float     windDirU;
            uniform float     windSpeedU;
            uniform float     physScaleU;
            uniform float     hullHalfLenU;
            uniform int       hullSliceCountU;
            uniform float     hullWidthsU[24];
            uniform float     hullSliceAlongMinU;
            uniform float     hullSliceAlongMaxU;
            uniform float     bowTipAlongNormU;
            uniform float     bowTipWidthU;
            uniform float     sternTipAlongNormU;
            uniform float     sternTipWidthU;
            uniform float     pitchOmegaU;
            uniform float     bowFullnessU;
            uniform float     sternFullnessU;
            uniform int       wakeCount;
            uniform vec4      wakeXZTH[MAX_WAKE];   // x, z, t, headingRad
            uniform float     wakeSpeed[MAX_WAKE];
            // 【反射方式修正】反射カメラ視点への投影行列（ワールド座標→反射RTのテクスチャ座標）
            uniform mat4      textureMatrix;
            varying vec3 vColor;
            varying vec3 vWorldPos;
            varying vec3 vNormal;
            varying vec2 vUv;
            varying vec4 vScreenPos;
            varying vec4 vReflectUv;
            varying float vSWEFoam;

            // ── 対数深度バッファ対応 ──
            // このシェーダーはThree.jsの<logdepthbuf_*>チャンクをincludeしない完全自前の
            // ShaderMaterialなので、renderer側でlogarithmicDepthBuffer:trueにしても
            // 自動的には効かない（USE_LOGDEPTHBUFのdefineは自動で付与されるが、それを
            // 実際に使うコードがこちらに無いと意味がない）。Three.js公式のchunkと
            // 同じロジックを手動で埋め込み、船体（標準マテリアル、自動対応済み）と
            // 深度エンコード方式を一致させる。これが無いと逆に深度の食い違いで
            // 症状が悪化するため、対数深度バッファ有効化とこのブロックは必ずセットで使う。
            //
            // v153-fix3: Three.jsはWebGL2コンテキストでは常に USE_LOGDEPTHBUF_EXT を
            // 自動定義するが、これは「WebGL2ならEXT_frag_depthが必ず使える」という
            // 前提に基づいており、実機ではこの前提が崩れることがある（GL_EXT_frag_depth
            // 拡張自体が「extension is not supported」となり、gl_FragDepthEXTが未定義
            // identifierとしてシェーダーのコンパイル/リンクごと失敗 → 海面が丸ごと
            // 消える不具合の直接の原因だった）。
            // Three.js側のUSE_LOGDEPTHBUF_EXTは無視し、常にEXT不使用の経路
            // （gl_Position.zを直接エンコードするだけの、拡張が要らない安全な方式）を使う。
            #ifdef USE_LOGDEPTHBUF
                uniform float logDepthBufFC;
            #endif
            bool isPerspectiveMatrix(mat4 m) { return m[2][3] == -1.0; }

            // ── 海面波（getWaveCrestAndHeightのGPU移植） ──
            // .x = 高さ, .y = 波頭量(crest)
            // CPU側(02-utils-and-wave-physics.js)と同じ「波高に応じて波長下限を
            // 自動的に引き上げる」カップリングをここでも適用し、見た目と物理の
            // 急峻さ(波形勾配)を一致させる。
            vec2 oceanWaveHC(vec2 xz, float t, float h, float wIn) {
                float autoWidthMin = h * 0.0782; // ≒ 0.005214/(1/15)
                float w = max(wIn, autoWidthMin);

                // ── v95: 風向・風速を波形に反映（CPU側 getWaveCrestAndHeight と対で維持）──
                // ①向き: 位相計算に使うxzを風向の分だけ回転させ、うねり・チョップの
                //   進行方向を風向スライダーに追従させる。
                // ②シャープさ: crestだけ風速に応じて指数(crestPow)を上げてピークを
                //   鋭く・狭くする。heightは変えないので浮力に使う波高は変わらない。
                float windRad = radians(windDirU);
                float wCos = cos(windRad), wSin = sin(windRad);
                vec2 rxz = vec2(xz.x * wCos - xz.y * wSin, xz.x * wSin + xz.y * wCos);
                float windSharpen = min(1.6, windSpeedU / 18.0);
                float crestPow = 2.0 + windSharpen;

                float k1 = 0.018 / w;
                float p1 = rxz.x * k1 + rxz.y * (k1 * 0.6) + t * 0.38;
                float s1 = sin(p1); float s1m = max(s1, 0.0);
                float ww1 = (s1m * s1m) * 2.0 - 0.6;
                float c1 = pow(s1m, crestPow);

                float k2 = 0.026 / w;
                float p2 = -rxz.x * k2 + rxz.y * (k2 * 0.8) + t * 0.52;
                float s2 = sin(p2); float s2m = max(s2, 0.0);
                float ww2 = (s2m * s2m) * 2.0 - 0.7;
                float c2 = pow(s2m, crestPow);

                // うねり成分（最も波長が長い）
                float k3 = 0.009 / w;
                float p3 = rxz.y * k3 + t * 0.22;
                float s3 = sin(p3);
                float ww3 = s3;
                float c3 = s3 > 0.0 ? s3 * s3 : 0.0;

                // チョップ成分（最も波長が短い）
                float k4 = 0.072 / w;
                float p4 = rxz.x * (k4 * 0.7) + rxz.y * k4 - t * 0.95;
                float s4 = sin(p4);
                float ww4 = s4 * 0.5;
                float c4 = s4 > 0.0 ? pow(s4, crestPow) : 0.0;

                float height = h * (ww1 * 1.3 + ww2 * 0.7 + ww3 * 0.55 * swellStrengthU + ww4 * 0.22 * chopStrengthU);
                float crest  = (c1 * 1.3 + c2 * 0.7 + c3 * 0.55 * swellStrengthU + c4 * 0.22 * chopStrengthU) * 0.361;
                return vec2(height, crest);
            }

            float normAngle(float a) {
                return mod(a + 3.14159265, 6.2831853) - 3.14159265;
            }

            // ── 実際の喫水線輪郭から半幅を補間で求める（CPU側 _hullHalfWidthAtNorm のGLSL移植）──
            // alongNorm: -1(船尾)〜+1(船首)。
            // hullWidthsU は scanHullProfile() の等幅スライス(HULL_SLICES=24)を格納したもの。
            // その実際のalongNorm範囲は[hullSliceAlongMinU, hullSliceAlongMaxU]で、これは
            // 通常±1よりわずかに内側（スライス中心基準のため）。
            // v113-fix: 従来はこの範囲外（船首/船尾のごく先端付近）を最後のスライス値で
            // クランプしており、実際には船体が先細りして0に近づいているはずの区間で
            // 幅が水平に保持されたままだった。これにより白波・引き波のマスク判定が
            // その区間で緩くなり、水面の泡が実際の船体輪郭より前方まで飛び出て見える
            // 原因になっていた（Olympic実測で確認）。範囲外は実測タイポイント
            // (bowTipAlongNormU/bowTipWidthU、sternTipAlongNormU/sternTipWidthU)へ
            // 向けて線形に減衰させ、タイポイントより外側は0を返す。
            float hullHalfWidthAt(float alongNorm) {
                int n = hullSliceCountU;
                if (n <= 1) return hullWidthsU[0];
                float aMin = hullSliceAlongMinU;
                float aMax = hullSliceAlongMaxU;
                if (alongNorm >= aMax) {
                    float lastW = hullWidthsU[n - 1];
                    if (alongNorm >= bowTipAlongNormU) {
                        return (bowTipAlongNormU > aMax) ? 0.0 : bowTipWidthU;
                    }
                    float span = bowTipAlongNormU - aMax;
                    float tt = span > 1e-6 ? (alongNorm - aMax) / span : 0.0;
                    return mix(lastW, bowTipWidthU, tt);
                }
                if (alongNorm <= aMin) {
                    float firstW = hullWidthsU[0];
                    if (alongNorm <= sternTipAlongNormU) {
                        return (sternTipAlongNormU < aMin) ? 0.0 : sternTipWidthU;
                    }
                    float span = aMin - sternTipAlongNormU;
                    float tt = span > 1e-6 ? (alongNorm - sternTipAlongNormU) / span : 0.0;
                    return mix(sternTipWidthU, firstW, tt);
                }
                float spanAll = max(1e-6, aMax - aMin);
                float fi = clamp((alongNorm - aMin) / spanAll, 0.0, 1.0) * float(n - 1);
                int i0 = int(floor(fi));
                i0 = clamp(i0, 0, n - 2);
                float tt2 = fi - float(i0);
                // GLSL(WebGL1)は配列の動的添字が不可な実装があるため、24個までのループで探す。
                float w0 = 0.0, w1 = 0.0;
                for (int k = 0; k < 24; k++) {
                    if (k == i0)     w0 = hullWidthsU[k];
                    if (k == i0 + 1) w1 = hullWidthsU[k];
                }
                return mix(w0, w1, tt2);
            }

            // ── 引き波（Kelvin wake / getWakeHeightのGPU移植） ──
            // .x = 高さ, .y = 泡量(foam)
            //
            // v160-fix: 一部スマホ端末(Adreno系GPU + ANGLE経由のWebGL2)で、
            // 「forループの変数iでuniform配列(wakeXZTH[i]など)を読む」という
            // 動的インデックスアクセスが原因でシェーダーのリンクがサイレントに
            // 失敗し、海面が丸ごと消える不具合が確認された（エラーメッセージが
            // 一切出ないまま失敗するタイプの不具合で、実機診断で切り分け済み）。
            // 対策として、1つの波源(ph, speed)を処理する部分を関数として分離し、
            // 呼び出し側でコンパイル時定数のインデックス(0, 1, 2, ...)を直接
            // 指定して呼ぶ形にする。GLSLの配列アクセスがすべて定数インデックスに
            // なるため、動的アクセスを避けられる。
            vec2 wakeContribution(vec2 xz, float t, vec4 ph, float speed) {
                float wakeY = 0.0;
                float wakeFoam = 0.0;
                float physScale = physScaleU;
                float scaleRatio = physScale / 12.0;
                // v106: 波源(船首・船尾)の位置を、固定オフセット(6.0*physScale)ではなく
                // 実際の船体スキャンから得た半長(hullHalfLenU)に合わせる。
                // 従来の固定値は喫水線が実際に閉じる先端よりだいぶ手前になっている
                // ことが多く、引き波の発生源が船首から後ろにずれて見える原因だった。
                float L = hullHalfLenU;
                float maxDist2 = 8000.0 * scaleRatio * scaleRatio;
                float maxDist = sqrt(maxDist2);

                float absSpeed = abs(speed);
                if (absSpeed < 0.5) return vec2(0.0);
                float dt = t - ph.z;
                if (dt <= 0.0 || dt > 15.0) return vec2(0.0);

                float dxp = xz.x - ph.x;
                float dzp = xz.y - ph.y;
                if (dxp * dxp + dzp * dzp > (maxDist + L) * (maxDist + L)) return vec2(0.0);

                float sinH = sin(ph.w);
                float cosH = cos(ph.w);

                // v104: 楕円近似(半幅一定)だと船首の絞り込み形状を再現できず、
                // 先端付近で波が船体内側まで入り込んでしまっていた。
                // 喫水線輪郭の砕け波(bow spray)と同じ実データ(hullWidthsU)を使い、
                // その場所ごとの実際の半幅で判定するよう変更。
                // 中心線（船首方位ベクトル）に対する観測点の横距離・前後位置を求め、
                // 船体が実際に存在する前後範囲内でだけ、その位置での実喫水線半幅より
                // 内側の波の寄与を滑らかにゼロへ絞る。
                // これを全域に適用すると、船首点そのもの（V字の頂点、中心線上）まで
                // マスクされてしまい、肝心の「めくり上げの始点」が消えてしまうため、
                // 船体の前後範囲の外ではマスクをかけない。
                // 右舷方向ベクトル = 船首方向(sinH, cosH)を90°回転した(cosH, -sinH)
                float lateralDist = abs(dxp * cosH - dzp * sinH);
                float alongDist   = dxp * sinH + dzp * cosH; // 船首方向への射影（船首側+、船尾側-）
                float alongNorm   = clamp(alongDist / max(0.01, hullHalfLenU), -1.0, 1.0);
                float hullW       = hullHalfWidthAt(alongNorm);
                float withinHullLen = 1.0 - smoothstep(hullHalfLenU * 0.98, hullHalfLenU * 1.08, abs(alongDist));
                // v124: 0.9〜1.3では際の遷移帯が広く、船体のすぐ内側でもマスクが
                // 完全に0にならず、波が薄く透けて見える原因になっていた
                // (v121/v122で振幅を上げ、v123で船首波を持続的に立たせたことで
                // この薄い透け残りが目立つようになった)。withinHullLenと同じ
                // 0.98〜1.08の狭い帯に絞り、実喫水線のすぐ内側は確実に0にする。
                float lateralMask = smoothstep(hullW * 0.98, hullW * 1.08, lateralDist);
                float hullMask = mix(1.0, lateralMask, withinHullLen);

                for (int s = 0; s < 2; s++) {
                    float sx, sz;
                    bool isBow;
                    if (s == 0) { sx = ph.x + sinH * L; sz = ph.y + cosH * L; isBow = true; }
                    else        { sx = ph.x - sinH * L; sz = ph.y - cosH * L; isBow = false; }

                    float dx = xz.x - sx;
                    float dz = xz.y - sz;
                    float d2 = dx * dx + dz * dz;
                    if (d2 > maxDist2) continue;
                    float d = sqrt(d2);
                    if (d < 0.1) continue;

                    float fullness  = isBow ? bowFullnessU : sternFullnessU;
                    float waveSpeed = (3.0 + absSpeed * 0.2) * scaleRatio;
                    float waveRadius = waveSpeed * dt;
                    float distanceToWaveFront = d - waveRadius;
                    float absDistToWaveFront = abs(distanceToWaveFront);
                    // v105: ケルビン波が波打つ周期は、船がピッチ(縦揺れ)する周期に由来する
                    // という考えに基づき、船のピッチ自然角周波数(pitchOmegaU)で波長を
                    // スケールする。ωが小さい(=大型・重い船でピッチがゆっくり)ほど
                    // 波長が長くなる。1.8は中型船的な基準角周波数の目安値。
                    float pitchWavelenScale = clamp(1.8 / sqrt(max(0.05, pitchOmegaU)), 0.5, 4.0);
                    float waveLength = (5.0 + absSpeed * 0.3) * scaleRatio * sqrt(fullness) * pitchWavelenScale;

                    if (absDistToWaveFront < waveLength * 1.5) {
                        // v122: 「今の倍くらい」の要望でv121の値からさらに2倍(0.033→0.066, 0.024→0.048)
                        float ampFactor = isBow ? 0.066 : 0.048;
                        float amp = absSpeed * ampFactor * fullness * scaleRatio * (1.0 - d / (90.0 * scaleRatio)) * (1.0 - dt / 15.0);
                        if (amp > 0.0) {
                            float k = 6.283 / waveLength;
                            float phase = distanceToWaveFront * k;
                            float angleToVertex = atan(dx, dz);
                            float relativeAngle = abs(normAngle(angleToVertex - ph.w));

                            // v99: 以前は relativeAngle > 1.57 (真横=90°) でハード切り替えしており、
                            // 観測点が船の真横を通過する瞬間に波がパツンと消える/現れる原因になっていた。
                            // smoothstepで90°付近をなだらかに繋ぎ、角度エンベロープの指数も緩めて
                            // ケルビン角からズレても波の筋が完全にゼロにならないようにする。
                            float sideGate = smoothstep(1.30, 1.57, relativeAngle);
                            if (sideGate > 0.0) {
                                float theta = 3.14159265 - relativeAngle;
                                float kelvinAngle = 0.34;
                                float angleDist = theta - kelvinAngle; // >0: V字の内側(船首軸寄り) / <0: V字の外側(まだめくれていない側)
                                float absAngleDist = abs(angleDist);
                                // 25.0→11.0: ケルビン角からのズレに対する減衰を緩やかにし、
                                // 常時「筋」が見える帯を広げる（完全に消える瞬間を無くす）。
                                float angleEnvelope = (exp(-absAngleDist * absAngleDist * (11.0 / fullness)) + exp(-theta * theta * (8.0 / fullness)) * 0.3) * sideGate;

                                // v123: v120で船首もシンプルな正弦波(sin(phase))に戻したところ、船首波が
                                // 「立って下がって立って下がって」と往復してしまう問題が判明。
                                // 波面(phase≈0)のごく近くだけ通常どおり正弦波で立ち上がらせ、そこから
                                // 内側(船体寄り、phaseが負に進む)へ入ったらsin波を使わず一定のプロファイルを
                                // 維持することで、船首すぐ脇の盛り上がりが往復せず立ちっぱなしになるようにした。
                                // 角度方向の絞り込み(V字稜線)自体は使うが、先端ブースト(bowTipBoostU)は
                                // 今回の件と無関係なので復活させていない。
                                float hh;
                                if (isBow) {
                                    float ridge = exp(-absAngleDist * absAngleDist * (60.0 / fullness)) * sideGate;
                                    float innerDip = smoothstep(0.0, 0.45, angleDist) * (1.0 - smoothstep(0.45, 1.1, angleDist)) * sideGate;
                                    float bowProfile = ridge - innerDip * 0.35;

                                    float distLift = 1.0 - smoothstep(-1.6, 0.3, phase);
                                    float liftBlend = 1.0 - smoothstep(3.14159265, 3.14159265 * 2.5, abs(phase));
                                    float wave = mix(sin(phase) * angleEnvelope, bowProfile * distLift, liftBlend);
                                    hh = amp * wave;
                                } else {
                                    hh = amp * sin(phase) * angleEnvelope;
                                }

                                wakeY += hh * hullMask;

                                if (hh > 0.02 && absDistToWaveFront < waveLength * 0.5) {
                                    wakeFoam += (hh / waveLength) * angleEnvelope * (19.0 + absSpeed * 0.6) * hullMask;
                                }
                            }
                        }
                    }
                }
                return vec2(wakeY, wakeFoam);
            }

            vec2 wakeHF(vec2 xz, float t) {
                float wakeY = 0.0;
                float wakeFoam = 0.0;
                // v160-fix: wakeCountでの早期break自体は動的int比較なので問題なく、
                // 配列インデックスだけを定数(0,1,2,...)に固定してある。
                if (0 >= wakeCount) return vec2(0.0, 0.0);
                vec2 c0 = wakeContribution(xz, t, wakeXZTH[0], wakeSpeed[0]); wakeY += c0.x; wakeFoam += c0.y;
                if (1 >= wakeCount) return vec2(wakeY, min(1.0, wakeFoam));
                vec2 c1 = wakeContribution(xz, t, wakeXZTH[1], wakeSpeed[1]); wakeY += c1.x; wakeFoam += c1.y;
                if (2 >= wakeCount) return vec2(wakeY, min(1.0, wakeFoam));
                vec2 c2 = wakeContribution(xz, t, wakeXZTH[2], wakeSpeed[2]); wakeY += c2.x; wakeFoam += c2.y;
                if (3 >= wakeCount) return vec2(wakeY, min(1.0, wakeFoam));
                vec2 c3 = wakeContribution(xz, t, wakeXZTH[3], wakeSpeed[3]); wakeY += c3.x; wakeFoam += c3.y;
                if (4 >= wakeCount) return vec2(wakeY, min(1.0, wakeFoam));
                vec2 c4 = wakeContribution(xz, t, wakeXZTH[4], wakeSpeed[4]); wakeY += c4.x; wakeFoam += c4.y;
                if (5 >= wakeCount) return vec2(wakeY, min(1.0, wakeFoam));
                vec2 c5 = wakeContribution(xz, t, wakeXZTH[5], wakeSpeed[5]); wakeY += c5.x; wakeFoam += c5.y;
                if (6 >= wakeCount) return vec2(wakeY, min(1.0, wakeFoam));
                vec2 c6 = wakeContribution(xz, t, wakeXZTH[6], wakeSpeed[6]); wakeY += c6.x; wakeFoam += c6.y;
                if (7 >= wakeCount) return vec2(wakeY, min(1.0, wakeFoam));
                vec2 c7 = wakeContribution(xz, t, wakeXZTH[7], wakeSpeed[7]); wakeY += c7.x; wakeFoam += c7.y;
                if (8 >= wakeCount) return vec2(wakeY, min(1.0, wakeFoam));
                vec2 c8 = wakeContribution(xz, t, wakeXZTH[8], wakeSpeed[8]); wakeY += c8.x; wakeFoam += c8.y;
                if (9 >= wakeCount) return vec2(wakeY, min(1.0, wakeFoam));
                vec2 c9 = wakeContribution(xz, t, wakeXZTH[9], wakeSpeed[9]); wakeY += c9.x; wakeFoam += c9.y;
                if (10 >= wakeCount) return vec2(wakeY, min(1.0, wakeFoam));
                vec2 c10 = wakeContribution(xz, t, wakeXZTH[10], wakeSpeed[10]); wakeY += c10.x; wakeFoam += c10.y;
                if (11 >= wakeCount) return vec2(wakeY, min(1.0, wakeFoam));
                vec2 c11 = wakeContribution(xz, t, wakeXZTH[11], wakeSpeed[11]); wakeY += c11.x; wakeFoam += c11.y;
                if (12 >= wakeCount) return vec2(wakeY, min(1.0, wakeFoam));
                vec2 c12 = wakeContribution(xz, t, wakeXZTH[12], wakeSpeed[12]); wakeY += c12.x; wakeFoam += c12.y;
                if (13 >= wakeCount) return vec2(wakeY, min(1.0, wakeFoam));
                vec2 c13 = wakeContribution(xz, t, wakeXZTH[13], wakeSpeed[13]); wakeY += c13.x; wakeFoam += c13.y;
                if (14 >= wakeCount) return vec2(wakeY, min(1.0, wakeFoam));
                vec2 c14 = wakeContribution(xz, t, wakeXZTH[14], wakeSpeed[14]); wakeY += c14.x; wakeFoam += c14.y;
                if (15 >= wakeCount) return vec2(wakeY, min(1.0, wakeFoam));
                vec2 c15 = wakeContribution(xz, t, wakeXZTH[15], wakeSpeed[15]); wakeY += c15.x; wakeFoam += c15.y;
                if (16 >= wakeCount) return vec2(wakeY, min(1.0, wakeFoam));
                vec2 c16 = wakeContribution(xz, t, wakeXZTH[16], wakeSpeed[16]); wakeY += c16.x; wakeFoam += c16.y;
                if (17 >= wakeCount) return vec2(wakeY, min(1.0, wakeFoam));
                vec2 c17 = wakeContribution(xz, t, wakeXZTH[17], wakeSpeed[17]); wakeY += c17.x; wakeFoam += c17.y;
                if (18 >= wakeCount) return vec2(wakeY, min(1.0, wakeFoam));
                vec2 c18 = wakeContribution(xz, t, wakeXZTH[18], wakeSpeed[18]); wakeY += c18.x; wakeFoam += c18.y;
                if (19 >= wakeCount) return vec2(wakeY, min(1.0, wakeFoam));
                vec2 c19 = wakeContribution(xz, t, wakeXZTH[19], wakeSpeed[19]); wakeY += c19.x; wakeFoam += c19.y;
                if (20 >= wakeCount) return vec2(wakeY, min(1.0, wakeFoam));
                vec2 c20 = wakeContribution(xz, t, wakeXZTH[20], wakeSpeed[20]); wakeY += c20.x; wakeFoam += c20.y;
                if (21 >= wakeCount) return vec2(wakeY, min(1.0, wakeFoam));
                vec2 c21 = wakeContribution(xz, t, wakeXZTH[21], wakeSpeed[21]); wakeY += c21.x; wakeFoam += c21.y;
                if (22 >= wakeCount) return vec2(wakeY, min(1.0, wakeFoam));
                vec2 c22 = wakeContribution(xz, t, wakeXZTH[22], wakeSpeed[22]); wakeY += c22.x; wakeFoam += c22.y;
                if (23 >= wakeCount) return vec2(wakeY, min(1.0, wakeFoam));
                vec2 c23 = wakeContribution(xz, t, wakeXZTH[23], wakeSpeed[23]); wakeY += c23.x; wakeFoam += c23.y;
                if (24 >= wakeCount) return vec2(wakeY, min(1.0, wakeFoam));
                vec2 c24 = wakeContribution(xz, t, wakeXZTH[24], wakeSpeed[24]); wakeY += c24.x; wakeFoam += c24.y;
                if (25 >= wakeCount) return vec2(wakeY, min(1.0, wakeFoam));
                vec2 c25 = wakeContribution(xz, t, wakeXZTH[25], wakeSpeed[25]); wakeY += c25.x; wakeFoam += c25.y;
                if (26 >= wakeCount) return vec2(wakeY, min(1.0, wakeFoam));
                vec2 c26 = wakeContribution(xz, t, wakeXZTH[26], wakeSpeed[26]); wakeY += c26.x; wakeFoam += c26.y;
                if (27 >= wakeCount) return vec2(wakeY, min(1.0, wakeFoam));
                vec2 c27 = wakeContribution(xz, t, wakeXZTH[27], wakeSpeed[27]); wakeY += c27.x; wakeFoam += c27.y;
                if (28 >= wakeCount) return vec2(wakeY, min(1.0, wakeFoam));
                vec2 c28 = wakeContribution(xz, t, wakeXZTH[28], wakeSpeed[28]); wakeY += c28.x; wakeFoam += c28.y;
                if (29 >= wakeCount) return vec2(wakeY, min(1.0, wakeFoam));
                vec2 c29 = wakeContribution(xz, t, wakeXZTH[29], wakeSpeed[29]); wakeY += c29.x; wakeFoam += c29.y;
                if (30 >= wakeCount) return vec2(wakeY, min(1.0, wakeFoam));
                vec2 c30 = wakeContribution(xz, t, wakeXZTH[30], wakeSpeed[30]); wakeY += c30.x; wakeFoam += c30.y;
                if (31 >= wakeCount) return vec2(wakeY, min(1.0, wakeFoam));
                vec2 c31 = wakeContribution(xz, t, wakeXZTH[31], wakeSpeed[31]); wakeY += c31.x; wakeFoam += c31.y;
                return vec2(wakeY, min(1.0, wakeFoam));
            }

            void main() {
                vUv = uv;
                vec4 wp = modelMatrix * vec4(position, 1.0);

                float h = max(0.0001, waveRoughnessU);
                float w = max(0.05, waveWidthU);
                vec2 hc = oceanWaveHC(wp.xz, time, h, w);
                float oceanH = hc.x;
                float crest  = hc.y;

                float waveAmp = max(0.001, h * 2.0);
                float depthRatio = clamp((oceanH + waveAmp) / (2.0 * waveAmp), 0.0, 1.0);
                float foam = 0.0;
                if (h > 0.05) {
                    // v94: さらにシャープに(遷移幅0.28→0.16)。ここは頂点シェーダー側
                    // (メッシュ解像度依存)なので、これ以上狭めると粗いLODで三角形の
                    // 継ぎ目が見えやすくなる恐れがあり、このあたりが実用上の下限。
                    // 細かい粒立ちはフラグメント側のmicroFoam(fleckノイズ)側で稼ぐ。
                    foam = clamp((crest - 0.44) / 0.16, 0.0, 1.0) * min(1.0, h * 0.85);
                }

                // SWE displacement（流体シミュ有効時）
                float sweH = 0.0;
                vSWEFoam = 0.0;
                if (sweEnabled) {
                    vec2 origin = sweGridOrigin - vec2(sweGridSize * 0.5);
                    vec2 sweUV  = (wp.xz - origin) / sweGridSize;
                    if (sweUV.x >= 0.0 && sweUV.x <= 1.0 && sweUV.y >= 0.0 && sweUV.y <= 1.0) {
                        vec4 s = texture2D(sweMap, sweUV);
                        sweH = s.r * sweScale;
                        vSWEFoam = clamp(length(s.gb) * 0.12 - 0.1, 0.0, 1.0);
                    }
                } else {
                    // SWEが無効な場合のみ解析的な引き波（Kelvin wake）を加算。
                    // ここがいわゆる「引き波系」で、軽量化しても見た目の正確さを保つ部分。
                    vec2 wk = wakeHF(wp.xz, time);
                    oceanH += wk.x;
                    foam = max(foam, wk.y);
                }

                wp.y += oceanH + sweH;
                vColor    = vec3(foam, depthRatio, 0.0);
                vWorldPos = wp.xyz;

                // 【反射方式修正】このワールド座標(波の高さ込み)を「反射カメラ視点の
                // クリップ空間→テクスチャ座標」へ変換する行列で投影する。従来は
                // メインカメラのスクリーン座標をそのまま反射RTのUVとして流用していたが、
                // これは反射カメラとメインカメラの視錐台がほぼ同じ場合にしか成立しない
                // 近似であり、見張り台のような近距離・急角度の視点では実際の反射位置と
                // 大きくズレて、船体内側などが見当違いの場所に映り込むバグの原因だった。
                // textureMatrixを使えば、水面上のどの点がRT画像のどのピクセルに対応するか
                // を毎頂点ごとに正しく（パースを考慮して）計算できる。
                vReflectUv = textureMatrix * wp;

                // 法線: 大きいうねりの傾きを有限差分で近似（メッシュ解像度に依存しない見た目の滑らかさ）
                float eps = 0.6;
                float hX = oceanWaveHC(wp.xz + vec2(eps, 0.0), time, h, w).x - oceanH;
                float hZ = oceanWaveHC(wp.xz + vec2(0.0, eps), time, h, w).x - oceanH;
                vec3 approxNormal = normalize(vec3(-hX / eps, 1.0, -hZ / eps));
                vNormal   = normalize(normalMatrix * approxNormal);

                gl_Position = projectionMatrix * viewMatrix * wp;
                vScreenPos  = gl_Position;

                // ── 対数深度エンコード（pars_vertexのUSE_LOGDEPTHBUF分岐に対応）──
                // vScreenPosには通常の投影値を保持させたいのでここ（main末尾）で適用する。
                // v153-fix3: EXT_frag_depthに依存しない経路のみを使う（上記コメント参照）。
                #ifdef USE_LOGDEPTHBUF
                    if (isPerspectiveMatrix(projectionMatrix)) {
                        gl_Position.z = log2(max(1e-6, gl_Position.w + 1.0)) * logDepthBufFC - 1.0;
                        gl_Position.z *= gl_Position.w;
                    }
                #endif
            }
        `,
        fragmentShader: `
            precision highp float;
            uniform sampler2D normalMap1;
            uniform sampler2D normalMap2;
            uniform sampler2D normalMap3;
            uniform vec2      normalScale;
            uniform float     parallaxEnabled;
            uniform float     time;
            uniform float     windDirU;
            uniform float     windSpeedU;
            uniform vec3      sunDir;
            uniform vec3      sunColor;
            uniform vec3      deepColor;
            uniform vec3      shallowColor;
            uniform vec3      foamColor;
            // 船明かり反射
            uniform int       shipLightCount;
            uniform vec3      shipLightPositions[WATER_SHIP_LIGHT_MAX];
            uniform vec3      shipLightColors[WATER_SHIP_LIGHT_MAX];
            uniform float     shipLightIntensities[WATER_SHIP_LIGHT_MAX];
            // 船体反射テクスチャ
            uniform sampler2D reflectionTex;
            uniform float     reflectionStrength;
            // 太陽シャドウ（v83: 自前サンプリング。Three.js標準のreceiveShadowは
            // 完全自前シェーダーには自動適用されないため、手動で判定する）
            uniform sampler2D sunShadowMap;
            uniform mat4      sunShadowMatrix;
            uniform bool      sunShadowActive;
            uniform float     sunShadowMapSize;
            varying vec3 vColor;
            varying vec3 vWorldPos;
            varying vec3 vNormal;
            varying vec2 vUv;
            varying vec4 vScreenPos;
            varying vec4 vReflectUv;
            varying float vSWEFoam;
            // ── 船体マスクuniform（ウォーターラインポリゴン方式）──
            uniform int   wlPtCount;
            uniform float wlPtsX[MAX_WL_PTS];
            uniform float wlPtsZ[MAX_WL_PTS];
            uniform float wlWet[MAX_WL_PTS];
            uniform vec2  hullBoundCenter;
            uniform float hullBoundRadius;
            uniform float hullFoamWidth;

            // ── 対数深度バッファ対応（頂点シェーダー側のUSE_LOGDEPTHBUFブロックとペア）──
            // v153-fix3: EXT_frag_depthに依存しない経路のみを使う。
            #ifdef USE_LOGDEPTHBUF
                uniform float logDepthBufFC;
            #endif

            // 点pがウォーターラインポリゴン内かを射線交差法で判定（現状未使用、将来用に保持）
            // v165-fix: ループ上限が32のままだった。MAX_WL_PTSはv130で32→40に
            // 拡張済みなので、33点目以降が判定から丸ごと抜け落ちていた。
            bool pointInPolygon(vec2 p, int n) {
                bool allRight = true;
                bool allLeft  = true;
                vec2 prev = vec2(wlPtsX[0], wlPtsZ[0]);
                for (int i = 1; i <= MAX_WL_PTS; i++) {
                    if (i > n) break;
                    vec2 curr = (i < n) ? vec2(wlPtsX[i], wlPtsZ[i]) : vec2(wlPtsX[0], wlPtsZ[0]);
                    vec2 edge = curr - prev;
                    vec2 toP  = p - prev;
                    float cross = edge.x * toP.y - edge.y * toP.x;
                    if (cross < 0.0) allLeft  = false;
                    if (cross > 0.0) allRight = false;
                    prev = curr;
                    if (i == n) break;
                }
                return allRight || allLeft;
            }

            // 点pから船体ウォーターライン輪郭（折れ線）までの最短距離。
            // hullProfileから作った実際の船体形状ポリゴンを使うため、
            // 水面メッシュの解像度に関係なく船体にピッタリ沿った帯を描ける。
            //
            // v165-fix【喫水線の泡が船体に沿わない不具合の本丸・その2】
            //  ・ループ上限が i < 32 のままで、CPU側がv130で40点まで詰める
            //    ようになった輪郭の33点目以降（＝船尾のファインポイントと
            //    船尾先端タイポイント）が完全に無視されていた。しかも
            //    i < n が成立し続けるので輪郭を閉じる最後の辺も引かれず、
            //    船尾側だけ泡帯が途切れる／船首側の点との間で辺が張られず
            //    形が崩れる、という状態だった。上限をMAX_WL_PTSに揃え、
            //    閉じる辺を必ず1回通るよう i <= MAX_WL_PTS にする。
            //  ・最近傍の辺の上で wlWet を線形補間して返す。CPU側が
            //    離水した点を間引く代わりにこの重みを渡すようになったので、
            //    輪郭の形は保ったまま離水区間の泡だけを消せる。
            float distToHullEdge(vec2 p, int n, out float wetOut) {
                wetOut = 0.0;
                if (n < 3) return 1.0e6;
                float minD = 1.0e6;
                vec2  prev  = vec2(wlPtsX[0], wlPtsZ[0]);
                float prevW = wlWet[0];
                for (int i = 1; i <= MAX_WL_PTS; i++) {
                    if (i > n) break;
                    bool  closing = (i >= n);
                    vec2  curr  = closing ? vec2(wlPtsX[0], wlPtsZ[0]) : vec2(wlPtsX[i], wlPtsZ[i]);
                    float currW = closing ? wlWet[0] : wlWet[i];
                    vec2 e = curr - prev;
                    vec2 w = p - prev;
                    float denom = max(dot(e, e), 1.0e-6);
                    float t = clamp(dot(w, e) / denom, 0.0, 1.0);
                    vec2 proj = prev + e * t;
                    float d = distance(p, proj);
                    if (d < minD) {
                        minD   = d;
                        wetOut = mix(prevW, currW, t);
                    }
                    prev  = curr;
                    prevW = currW;
                    if (closing) break;
                }
                return minD;
            }

            // Three.jsの標準シャドウマップ(PCF/PCFSoft)は深度をRGBA8の4チャンネルに
            // パックして保存している（生のfloat深度テクスチャではない）ため、.r を
            // そのまま読むだけでは正しい値にならない。Three.js本体のpacking.glsl.js
            // (unpackRGBAToDepth)と全く同じ復元式をここでも使う。
            const float _sunShadowUnpackDownscale = 255.0 / 256.0;
            const vec4 _sunShadowUnpackFactors = _sunShadowUnpackDownscale / vec4(256.0 * 256.0 * 256.0, 256.0 * 256.0, 256.0, 1.0);
            float unpackSunShadowDepth(vec4 v) {
                return dot(v, _sunShadowUnpackFactors);
            }

            // 太陽シャドウマップを3x3 PCFで手動サンプリングし、0(完全影)〜1(完全に日向)を返す。
            // sunShadowMatrixは既にThree.js側で「ワールド座標→シャドウマップUV+深度(0..1)」の
            // バイアス込み変換になっているので、そのままw除算するだけでUVが得られる。
            float sampleSunShadow(vec3 worldPos) {
                if (!sunShadowActive) return 1.0;
                vec4 sc = sunShadowMatrix * vec4(worldPos, 1.0);
                sc.xyz /= sc.w;
                // 視錐台の外（影マップの範囲外）は「影なし」として扱う
                if (sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z > 1.0) return 1.0;
                float texel = 1.0 / max(sunShadowMapSize, 1.0);
                float litSum = 0.0;
                for (int dx = -1; dx <= 1; dx++) {
                    for (int dy = -1; dy <= 1; dy++) {
                        float depth = unpackSunShadowDepth(texture2D(sunShadowMap, sc.xy + vec2(float(dx), float(dy)) * texel));
                        litSum += (sc.z - 0.0006 > depth) ? 0.0 : 1.0;
                    }
                }
                return litSum / 9.0;
            }

            // v93: 砕波を細かく粒立たせるための簡易ハッシュノイズ(テクスチャ不要、
            // メッシュ解像度にも依存しないピクセル単位のランダム値)。
            float hash21(vec2 p) {
                p = fract(p * vec2(123.34, 456.21));
                p += dot(p, p + 45.32);
                return fract(p.x * p.y);
            }

            // v160-fix: 船明かり1個分の水面反射寄与を計算する関数。定数インデックスで
            // 呼び出せるようにforループ本体を関数として切り出したもの（引き波の
            // wakeContributionと同じ狙い）。
            vec3 shipLightContribution(vec3 worldPos, vec3 viewDir, vec3 n, vec3 lPos, vec3 lColor, float lInt) {
                // ライトが水面より上にある場合のみ反射（水中は除外）
                if (lPos.y < 0.0) return vec3(0.0);
                // ライトを水面に鏡像（y反転）
                vec3 mirrorPos = vec3(lPos.x, -lPos.y, lPos.z);
                vec3 toMirror  = normalize(mirrorPos - worldPos);
                // 反射方向との一致度（スペキュラー反射）
                vec3 reflDir = reflect(-viewDir, n);
                float rDot   = max(0.0, dot(reflDir, toMirror));
                // 光源距離による減衰
                float dist   = length(lPos - worldPos);
                float atten  = 1.0 / (dist * dist * 0.004 + 1.0);
                // 波の揺らぎで広がる反射（低めのべき乗で幅を出す）
                float refl   = pow(rDot, 12.0) * atten * lInt;
                // 拡散成分（波面全体にじんわり色がつく）
                float diff   = atten * lInt * 0.12 / (dist * 0.05 + 1.0);
                return lColor * (refl + diff);
            }

            void main() {
                // v153-fix3: 対数深度は頂点シェーダー側でgl_Position.zに直接エンコード
                // 済み（EXT_frag_depthを使わない経路）。フラグメント側で追加の
                // 書き込みは不要になった。
                // 船体マスク: discardをやめてdepthTestに任せる。
                // waterMat は transparent:false（不透明キュー）。船体側の深度が既に書き込まれた
                // 状態でdepthTestするため、船体に隠れる水面フラグメントは自動的に描画されない
                // （→ カメラが水面より高くても穴が見えない）。ウォーターライン直下のような
                // 際どい深度差は対数深度バッファ＋polygonOffsetで解決している（詳細は
                // renderer生成箇所とwaterMatのpolygonOffset設定のコメントを参照）。
                vec2 worldXZ = vWorldPos.xz * 0.007;
                // v163: 視差マッピング用にviewDirをこの位置（UV計算より前）に前倒し。
                // 元々はもっと下（scatter/specular計算の直前）で計算していたが、
                // 視差オフセットをUVサンプリングより前に適用する必要があるため、
                // ここで先に計算しておく（値自体は変更なし、計算位置の前倒しのみ）。
                vec3 viewDir = normalize(cameraPosition - vWorldPos);
                // ── v163: 視差マッピング（水平に近い視点での立体感不足への対応）──
                // 法線マップは陰影しか偽装できず、実際のジオメトリはズレないため、
                // 水平に近い角度で見ると「本来手前の波が奥を隠すはず」の視差が
                // 一切出ず、水面が平坦に見えてしまう。ここでは正確なレイマーチングは
                // 行わず、視線のXZ方向へUVを少しずらすだけの簡易版（1サンプルの
                // オフセットマッピング）を使う。モバイルGPUでも1テクスチャあたり
                // 追加コストはハイトマップのサンプル1回分のみに抑えている。
                // viewDir.yが小さい（＝水平に近い）ほど1/viewDir.yが大きくなり、
                // オフセット量が強く出る（水平視点でこそ効果が必要なため）。
                // 真上から見下ろす場合はviewDir.y≈1で分母が大きく、オフセットは
                // ほぼゼロになる（真上からは元々視差が要らないので自然）。
                float parallaxStrength = 0.55; // オフセットの強さ（大きいほど視差が強く出る代わりに歪みやすい）
                float viewDirY = max(viewDir.y, 0.06); // 0除算・極端な引き伸ばし防止のクランプ
                vec2 parallaxDir = viewDir.xz / viewDirY;
                // オフセット量が暴走しないよう最終的な長さも制限（波打ち際やほぼ水平の
                // 極端な角度でUVが遠くまで飛んでテクスチャが繰り返しすぎないように）。
                float parallaxLen = length(parallaxDir);
                if (parallaxLen > 4.0) parallaxDir = parallaxDir / parallaxLen * 4.0;
                // ── v95: テクスチャ上の細かい波紋(法線マップ)の向き・流れる速さを風に連動 ──
                // windVec: 船の進行方向と同じsin/cos規約（0度=+Z方向）の風向ベクトル。
                // uv1は風向そのまま（メインの風波）、uv2はそこから約131°回した向き
                // （元のクロスするうねり感を保ちつつ、主方向は風に追従させる）。
                // 風速が強いほどスクロール速度も上げ、水面の細波が「風で流れている」
                // ように見せる。
                float windRadF = radians(windDirU);
                vec2 windVec = vec2(sin(windRadF), cos(windRadF));
                float wSpdNorm = clamp(windSpeedU / 20.0, 0.0, 1.5);
                vec2 uv1 = worldXZ + windVec * time * (0.010 + wSpdNorm * 0.010);
                float xa = 2.29; // ≒131度: uv2をずらす角度（cos,sin併用で回転）
                vec2 windVec2 = vec2(windVec.x * cos(xa) - windVec.y * sin(xa), windVec.x * sin(xa) + windVec.y * cos(xa));
                vec2 uv2 = worldXZ * 1.85 - windVec2 * time * (0.008 + wSpdNorm * 0.009);
                // v162: 「大きめの波」用の第3レイヤー。uv1/uv2よりUVスケールを縮小
                // （＝1テクセルが世界座標でより広い範囲をカバーする＝模様が大きく見える）し、
                // スクロールも遅くして、細波よりゆったりしたうねりとして流れさせる。
                // 向きはuv1とも違う角度(約47°)に振って、3枚が同じ方向に重ならないようにする。
                float xb = 0.82; // ≒47度
                vec2 windVec3 = vec2(windVec.x * cos(xb) - windVec.y * sin(xb), windVec.x * sin(xb) + windVec.y * cos(xb));
                vec2 uv3 = worldXZ * 0.42 + windVec3 * time * (0.005 + wSpdNorm * 0.004);
                // v163: 各UVで一度ハイトマップ(normalMapのBチャンネル)を読み、視線方向に
                // ズラしたUVを最終サンプリング座標として使う。オフセット量はテクスチャの
                // UVスケールに対して相対的に効くよう、各レイヤーのUV空間のスケールに
                // 合わせて0.02〜0.05程度の小さい係数を掛ける（テクスチャそのものが
                // worldXZ×0.007〜0.42という細かいUV空間なので、大きすぎる係数だと
                // すぐにテクスチャが暴れて見える）。
                // parallaxEnabled=0（低スペック機向けverylowプリセット）の場合は
                // ハイトサンプリング自体を丸ごとスキップし、従来通りuv1/uv2/uv3を
                // そのまま法線サンプリングに使う（テクスチャフェッチ+3回を節約）。
                vec2 uv1p = uv1;
                vec2 uv2p = uv2;
                vec2 uv3p = uv3;
                if (parallaxEnabled > 0.5) {
                    float h1 = texture2D(normalMap1, uv1).b - 0.5;
                    float h2 = texture2D(normalMap2, uv2).b - 0.5;
                    float h3 = texture2D(normalMap3, uv3).b - 0.5;
                    uv1p = uv1 + parallaxDir * h1 * parallaxStrength * 0.05;
                    uv2p = uv2 + parallaxDir * h2 * parallaxStrength * 0.05;
                    uv3p = uv3 + parallaxDir * h3 * parallaxStrength * 0.05;
                }
                vec3 n1 = texture2D(normalMap1, uv1p).rgb * 2.0 - 1.0;
                vec3 n2 = texture2D(normalMap2, uv2p).rgb * 2.0 - 1.0;
                vec3 n3 = texture2D(normalMap3, uv3p).rgb * 2.0 - 1.0;
                // 風速が強いほど法線の凹凸を強調 → 細かい波紋がよりシャープに立って見える。
                // v162: 3枚それぞれに個別の重みを持たせる。小波(n1)・中波(n2)は元より
                // 少し強めにしてくっきりさせ、大波(n3)は主張しすぎないよう控えめにして、
                // 「細かい凹凸の上に緩やかなうねりが乗る」という重なりの階層感を出す。
                vec2 windNormalScale = normalScale * (1.0 + wSpdNorm * 0.5);
                vec3 nSum = (n1 * 1.15 + n2 * 1.05 + n3 * 0.55);
                vec3 n = normalize(vNormal + vec3(nSum.x * windNormalScale.x, 0.0, nSum.y * windNormalScale.y));

                // ── 船体に密着した波しぶき帯 ──
                // 水面メッシュ自体は粗くても、実際の船体形状（hullProfile由来）との
                // 距離をフラグメント単位（ピクセル単位）で評価するため、輪郭はガタつかない。
                float hullEdgeFoam = 0.0;
                if (wlPtCount >= 3 && distance(vWorldPos.xz, hullBoundCenter) < hullBoundRadius) {
                    float edgeWet = 0.0;
                    float dEdge = distToHullEdge(vWorldPos.xz, wlPtCount, edgeWet);
                    // v165: 帯の幅は船体サイズ追従(hullFoamWidth)。edgeWetで、
                    // 今まさに離水している区間の泡だけを滑らかに消す。
                    hullEdgeFoam = (1.0 - smoothstep(0.0, hullFoamWidth, dEdge)) * edgeWet;
                }

                float baseFoam = vColor.r;
                float waveSteepness = length(n1.xy + n2.xy) * 0.5;
                // v94: 「風で立った波の穂先だけが砕けて白くなる」感じをもっと強く。
                // ① crestGate: 大きいうねりの高さ(vColor.g、1に近いほど波の頂上)でゲートする。
                //    これが無いと谷でも細かい傾き(waveSteepness)さえあれば泡が出てしまい、
                //    「面で白い」印象になる。頂上付近だけに絞ることで「先端だけ砕ける」形にする。
                // ② microFoamMask: steepnessのしきい値幅を0.12→0.06にさらに狭め、輪郭をより鋭く。
                // ③ fleck: ハッシュノイズの周波数を上げ、さらにそれ自体もsmoothstepで
                //    二値化気味にして、なだらかな濃淡ではなく尖った粒状の砕けにする。
                float crestGate = smoothstep(0.58, 0.88, vColor.g);
                float microFoamMask = smoothstep(0.60, 0.66, waveSteepness);
                float fleckA = hash21(floor(vWorldPos.xz * 42.0));
                float fleckB = hash21(floor(vWorldPos.xz * 97.0 + vec2(13.0, 7.0)));
                float fleck  = fleckA * 0.6 + fleckB * 0.4;
                float fleckMask = smoothstep(0.42, 0.58, fleck);
                float microFoam = microFoamMask * crestGate * mix(0.2, 1.0, fleckMask);
                float foam = clamp(baseFoam + microFoam * 0.9 + vSWEFoam * 0.6 + hullEdgeFoam * 0.75, 0.0, 1.0);
                
                // 船体・煙突などが太陽を遮っているかを判定（日陰では直射成分だけを弱める。
                // 空からの拡散光であるskyRefl等はここでは減衰させない＝影が真っ黒にならない）
                float sunShadowFactor = sampleSunShadow(vWorldPos);

                float depth = vColor.g;
                vec3 waterBase = mix(deepColor, shallowColor, depth);
                // v162: 「凹凸の深さ高さが出てる感じがしない」への対応その2。
                // specular(下)は太陽の映り込みが鋭い点として光る成分で、凹凸の
                // "形"そのものを陰影として見せる役割はscatterが担っている
                // （n＝波面の傾きとsunDirの内積が高いほど明るい＝傾いた波面が
                // 面として光って見える）。ここが弱いと、法線マップの凹凸自体は
                // 存在していても画面上では「ほぼ平らな面にたまに反射点が光る」
                // ようにしか見えない。べき乗を3→2に緩めて傾きへの反応を鈍感に
                // せず、寄与量も0.35/0.18→0.5/0.26へ上げて、波面の起伏がそのまま
                // 明暗のグラデーションとして見えるようにする。
                float scatter = pow(max(0.0, dot(sunDir, n)), 2.0) * 0.5;
                waterBase += sunColor * scatter * 0.26 * sunShadowFactor;
                // v163: viewDirはUV計算より前（parallaxDir計算時）に前倒し済みのため、
                // ここでの再宣言は削除。halfDir以降はそのまま既存のviewDirを使う。
                vec3 halfDir = normalize(sunDir + viewDir);
                // v162: べき乗180は反射スポットが小さすぎ、凹凸が細かい点にしか
                // 見えなかったため130へ緩め、代わりに乗数を1.8→1.5に少し絞って
                // 全体の明るさバランスを保つ（面としての陰影はscatter側で担保）。
                float spec = pow(max(0.0, dot(n, halfDir)), 130.0);
                vec3 specular = sunColor * spec * 1.5 * sunShadowFactor;
                float fresnel = pow(1.0 - max(0.0, dot(n, viewDir)), 4.0);
                // v120: deepColor/shallowColorをv45の色合いに戻したのに合わせて、
                // 際(フレネル)の空色もv45の値に戻す。
                vec3 skyRefl = vec3(0.30, 0.52, 0.82);
                waterBase = mix(waterBase, skyRefl, fresnel * 0.38);

                // ── 船明かりの鏡面反射 ──
                // v160-fix: 引き波と同じ理由(uniform配列への動的インデックスアクセスが
                // 一部端末でリンク失敗の原因になる)で、こちらも念のため定数インデックス
                // アクセスに展開しておく。
                vec3 shipRefl = vec3(0.0);
                if (0 < shipLightCount) shipRefl += shipLightContribution(vWorldPos, viewDir, n, shipLightPositions[0], shipLightColors[0], shipLightIntensities[0]);
                if (1 < shipLightCount) shipRefl += shipLightContribution(vWorldPos, viewDir, n, shipLightPositions[1], shipLightColors[1], shipLightIntensities[1]);
                if (2 < shipLightCount) shipRefl += shipLightContribution(vWorldPos, viewDir, n, shipLightPositions[2], shipLightColors[2], shipLightIntensities[2]);
                if (3 < shipLightCount) shipRefl += shipLightContribution(vWorldPos, viewDir, n, shipLightPositions[3], shipLightColors[3], shipLightIntensities[3]);
                if (4 < shipLightCount) shipRefl += shipLightContribution(vWorldPos, viewDir, n, shipLightPositions[4], shipLightColors[4], shipLightIntensities[4]);
                if (5 < shipLightCount) shipRefl += shipLightContribution(vWorldPos, viewDir, n, shipLightPositions[5], shipLightColors[5], shipLightIntensities[5]);
                if (6 < shipLightCount) shipRefl += shipLightContribution(vWorldPos, viewDir, n, shipLightPositions[6], shipLightColors[6], shipLightIntensities[6]);
                if (7 < shipLightCount) shipRefl += shipLightContribution(vWorldPos, viewDir, n, shipLightPositions[7], shipLightColors[7], shipLightIntensities[7]);
                if (8 < shipLightCount) shipRefl += shipLightContribution(vWorldPos, viewDir, n, shipLightPositions[8], shipLightColors[8], shipLightIntensities[8]);
                if (9 < shipLightCount) shipRefl += shipLightContribution(vWorldPos, viewDir, n, shipLightPositions[9], shipLightColors[9], shipLightIntensities[9]);
                if (10 < shipLightCount) shipRefl += shipLightContribution(vWorldPos, viewDir, n, shipLightPositions[10], shipLightColors[10], shipLightIntensities[10]);
                if (11 < shipLightCount) shipRefl += shipLightContribution(vWorldPos, viewDir, n, shipLightPositions[11], shipLightColors[11], shipLightIntensities[11]);
                if (12 < shipLightCount) shipRefl += shipLightContribution(vWorldPos, viewDir, n, shipLightPositions[12], shipLightColors[12], shipLightIntensities[12]);
                if (13 < shipLightCount) shipRefl += shipLightContribution(vWorldPos, viewDir, n, shipLightPositions[13], shipLightColors[13], shipLightIntensities[13]);
                if (14 < shipLightCount) shipRefl += shipLightContribution(vWorldPos, viewDir, n, shipLightPositions[14], shipLightColors[14], shipLightIntensities[14]);
                if (15 < shipLightCount) shipRefl += shipLightContribution(vWorldPos, viewDir, n, shipLightPositions[15], shipLightColors[15], shipLightIntensities[15]);
                // フレネル係数で反射量を調整（水平に見るほど強く反射）
                float shipFresnel = mix(0.3, 1.0, fresnel);
                shipRefl *= shipFresnel;

                // ── 船体・景色の鏡面反射テクスチャ ──
                // 【反射方式修正】以前は「メインカメラのスクリーン座標をそのまま
                // 反射RTのUVとして流用し、Y座標だけ反転する」という近似だった。
                // これは反射カメラとメインカメラがほぼ同じ視錐台を向いている
                // （水平線を遠くから見るような）場合はそれなりに機能したが、
                // 見張り台から近い水面を急角度で見下ろすような場合はパースのズレが
                // 無視できなくなり、船体内側やスクリューなど本来映らないはずの
                // ものが見当違いの場所に反射して見える原因になっていた。
                // → 頂点シェーダーで計算した vReflectUv（textureMatrixによる
                //   反射カメラ視点への正しい射影）を使い、パースを考慮した
                //   除算(xy/w)でテクスチャ座標を求める、鏡面反射の標準的な手法に変更。
                vec2 reflUV = vReflectUv.xy / max(vReflectUv.w, 1e-5);
                // 波の法線でUVを揺らしてリップル効果（小さめで自然に）
                vec2 distort = vec2(n.x, n.z) * 0.012;
                reflUV       += distort;
                reflUV        = clamp(reflUV, 0.002, 0.998);
                vec3 reflColor = texture2D(reflectionTex, reflUV).rgb;
                // フレネル係数のみで混合（余分な抑制はなし）
                float reflMix = fresnel * reflectionStrength;
                // 泡の部分は反射を弱める
                reflMix *= (1.0 - foam * 0.7);

                vec3 finalColor = mix(waterBase + specular + shipRefl, foamColor, foam);
                finalColor      = mix(finalColor, reflColor, reflMix);
                gl_FragColor = vec4(finalColor, 1.0);
                // v83: このシェーダーは完全自前のためThree.jsの標準チャンクを何も
                // includeしていない。船体(MeshStandardMaterial)は自動でトーン
                // マッピング＋sRGB出力エンコードされるが、このgl_FragColorは何も
                // しなければ生の値のまま出てしまい、船体と水面で明るさ・コントラストの
                // 質感が食い違って見える。#include で船体と全く同じ変換を明示的に適用する。
                #include <tonemapping_fragment>
                #include <encodings_fragment>
            }
        `
    });
    waterMesh = new THREE.Mesh(waterGeometry, waterMat);
    waterMesh.renderOrder = 0;
    waterMesh.userData.noBloom = true;   // 太陽スペキュラのハイライトが白飛びしやすく、ブルームを重ねると海全体が光りすぎるため除外
    waterMesh.receiveShadow = true; // 実際の影の描画は上のsampleSunShadow()による自前判定で行う
    scene.add(waterMesh);

    // SWEシミュレーター初期化（WebGL floatテクスチャが使えれば有効化）
    if (typeof initSWE === 'function') {
        initSWE();
    }
}

function createShipGroup() {
    shipGroup = new THREE.Group();
    scene.add(shipGroup);

    cgMarker = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 8), new THREE.MeshBasicMaterial({ color: 0xff00ff, depthTest: false }));
    cgMarker.visible = false;
    cgMarker.renderOrder = 999;
    shipGroup.add(cgMarker);

    rudderMarker = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.7, 0.07), new THREE.MeshBasicMaterial({ color: 0x00ffff, depthTest: false }));
    rudderMarker.visible = false;
    rudderMarker.renderOrder = 999;
    shipGroup.add(rudderMarker);
}

function loadEmbeddedOBJ() {
    const statusText = $('import-status');
    const candidates = [
        { name: 'ship_model.glb',  type: 'glb' },
        { name: 'ship_model.gltf', type: 'gltf' },
        { name: 'ship_model.obj',  type: 'obj' },
    ];

    function useFallback(reason) {
        console.warn('Local model not found, using built-in Titanic:', reason);
        statusText.innerText = 'Default: Built-in Titanic model';
        const fallbackGroup = new THREE.Group();
        createTitanicModel(fallbackGroup);
        setCustomModel(fallbackGroup);
    }

    function tryNext(index) {
        if (index >= candidates.length) { useFallback('all candidates failed'); return; }
        const c = candidates[index];
        statusText.innerText = 'Trying ' + c.name + '...';

        fetch(c.name)
            .then(function(res) {
                if (!res.ok) throw new Error(res.status);
                return res.arrayBuffer();
            })
            .then(function(buf) {
                if (c.type === 'glb' || c.type === 'gltf') {
                    const loader = new THREE.GLTFLoader();
                    loader.parse(buf, '', function(gltf) {
                        if (!modelHasMesh(gltf.scene)) { tryNext(index + 1); return; }
                        modelOffset.ry = -90.0; syncModelOffsetUI();
                        applyGltfEmissiveStrengthExt(gltf.scene, gltf.parser && gltf.parser.json);
                        setCustomModel(gltf.scene);
                        statusText.innerText = 'Loaded: ' + c.name;
                    }, function(err) { tryNext(index + 1); });
                } else {
                    const text = new TextDecoder().decode(buf);
                    const loader = new THREE.OBJLoader();
                    const obj = loader.parse(text);
                    if (!modelHasMesh(obj)) { tryNext(index + 1); return; }
                    modelOffset.ry = -90.0; syncModelOffsetUI();
                    setCustomModel(obj);
                    statusText.innerText = 'Loaded: ' + c.name;
                }
            })
            .catch(function() { tryNext(index + 1); });
    }

    tryNext(0);
}

// 回転ギズモを X/Y/Z の単軸回転のみに制限する。
// TransformControls の rotate モードには、X/Y/Z の各軸円に加えて
// 画面に正対する自由回転（内部名 "E"）と、それを含む "XYZE" ハンドルが存在し、
// これらはクリックした位置から任意の軸で回転できてしまう。
// 「x,y,z軸それぞれでしか回せないようにしたい」という要望に対応するため、
// rotateモードのギズモ表示・ピッカー双方から "E"/"XYZE" ハンドルを恒久的に非表示にする。
// (TransformControlsの内部更新は handle.visible = handle.visible && (...) という
//  論理積で毎フレーム再計算されるため、一度 false にすれば以後ずっと非表示のまま保たれる)
// ── ギズモ回転軸選択オーバーレイ ─────────────────────────────────────────
// rotateモードのときに画面上にX/Y/Z軸選択ボタンを表示し、
// 選んだ軸のみ操作できるようにする（E/XYZEは常に非表示）。
let _gizmoRotateAxis = 'Y'; // 現在選択中の回転軸

function restrictRotateGizmoToAxes(tc) {
    if (!tc) return;
    // E（自由回転）とXYZE（全軸同時）を恒久的に非表示
    ['gizmo', 'picker', 'helper'].forEach((groupKey) => {
        const rotateGroup = tc[groupKey] && tc[groupKey]['rotate'];
        if (!rotateGroup || !rotateGroup.traverse) return;
        rotateGroup.traverse((obj) => {
            if (obj.name === 'E' || obj.name === 'XYZE') {
                obj.visible = false;
            }
        });
    });
}

function applyRotateAxisRestriction(axis) {
    if (!transformControl) return;
    _gizmoRotateAxis = axis;

    // Three.js r128 TransformControls: rotateグループ内の各軸ハンドルをname('X','Y','Z')で制御
    // showX/Y/Zプロパティが存在すれば使い、なければ内部ハンドルのvisibleを直接操作
    if ('showX' in transformControl) {
        transformControl.showX = (axis === 'X');
        transformControl.showY = (axis === 'Y');
        transformControl.showZ = (axis === 'Z');
    } else {
        ['gizmo', 'picker', 'helper'].forEach((groupKey) => {
            const rotateGroup = transformControl[groupKey] && transformControl[groupKey]['rotate'];
            if (!rotateGroup || !rotateGroup.traverse) return;
            rotateGroup.traverse((obj) => {
                if (obj.name === 'X') obj.visible = (axis === 'X');
                else if (obj.name === 'Y') obj.visible = (axis === 'Y');
                else if (obj.name === 'Z') obj.visible = (axis === 'Z');
                else if (obj.name === 'E' || obj.name === 'XYZE') obj.visible = false;
            });
        });
    }
    // 軸選択ボタンのアクティブ状態を更新
    ['X','Y','Z'].forEach(a => {
        const btn = document.getElementById('gizmo-axis-btn-' + a);
        if (btn) btn.classList.toggle('active', a === axis);
    });
}

function showRotateAxisOverlay() {
    let overlay = document.getElementById('gizmo-axis-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'gizmo-axis-overlay';
        overlay.style.cssText = [
            'position:fixed', 'bottom:120px', 'left:50%', 'transform:translateX(-50%)',
            'display:flex', 'gap:8px', 'z-index:9999', 'pointer-events:auto',
            'background:rgba(0,10,30,0.85)', 'border:1px solid #0af',
            'border-radius:8px', 'padding:6px 12px', 'align-items:center'
        ].join(';');
        overlay.innerHTML = `
            <span style="color:#7af;font-size:11px;margin-right:4px;">回転軸:</span>
            <button id="gizmo-axis-btn-X" onclick="applyRotateAxisRestriction('X')"
              style="background:#1a0000;color:#f44;border:1px solid #f44;border-radius:4px;padding:3px 10px;font-size:12px;cursor:pointer;">X</button>
            <button id="gizmo-axis-btn-Y" onclick="applyRotateAxisRestriction('Y')"
              style="background:#001a00;color:#4f4;border:1px solid #4f4;border-radius:4px;padding:3px 10px;font-size:12px;cursor:pointer;">Y</button>
            <button id="gizmo-axis-btn-Z" onclick="applyRotateAxisRestriction('Z')"
              style="background:#00001a;color:#44f;border:1px solid #44f;border-radius:4px;padding:3px 10px;font-size:12px;cursor:pointer;">Z</button>`;
        document.body.appendChild(overlay);
    }
    overlay.style.display = 'flex';
    applyRotateAxisRestriction(_gizmoRotateAxis);
}

function hideRotateAxisOverlay() {
    const overlay = document.getElementById('gizmo-axis-overlay');
    if (overlay) overlay.style.display = 'none';
    // すべての軸を表示に戻す
    if (!transformControl) return;
    if ('showX' in transformControl) {
        transformControl.showX = true;
        transformControl.showY = true;
        transformControl.showZ = true;
    } else {
        ['gizmo', 'picker', 'helper'].forEach((groupKey) => {
            ['rotate', 'translate', 'scale'].forEach((modeKey) => {
                const group = transformControl[groupKey] && transformControl[groupKey][modeKey];
                if (!group || !group.traverse) return;
                group.traverse((obj) => {
                    if (obj.name === 'X' || obj.name === 'Y' || obj.name === 'Z') {
                        obj.visible = true;
                    }
                });
            });
        });
    }
}

function createTitanicModel(group) {
    const bottomMat = new THREE.MeshStandardMaterial({ color: 0x8b0000, roughness: 0.5 });
    const bh = new THREE.Mesh(new THREE.BoxGeometry(3.8, 1.0, 12), bottomMat);
    bh.position.y = -0.25; group.add(bh);

    const topMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.4 });
    const th = new THREE.Mesh(new THREE.BoxGeometry(4.0, 1.5, 12), topMat);
    th.position.y = 1.0; group.add(th);

    const deckMat = new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.5 });
    const d1 = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.8, 9), deckMat);
    d1.position.set(0, 2.15, -0.5); group.add(d1);
    group.traverse((c) => { if (c.isMesh) c.userData.noBloom = true; });
}

