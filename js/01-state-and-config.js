'use strict';

const EMBEDDED_OBJ_B64 = 'omission=';
const $ = (id) => document.getElementById(id);

let scene, camera, renderer, controls, transformControl;
let perspCamera, orthoCamera, bloomRenderPass; // XYZ軸ビュー(正投影)切替用: cameraは常に「現在有効なカメラ」を指す
let cameraMode = 'follow'; // 'follow' (現状) / 'chase' (固定視点) / 'free' (自由視点)
let waterMesh, waterGeometry;
let waterReflectionRT = null;    // 水面反射用レンダーターゲット
let waterReflectionCamera = null; // 反射カメラ（y反転）
let shipGroup;
let importedModelGroup = null;
let glbMovableParts = []; // GLBモデル内のスクリュー・舵・外輪など、ギズモで移動できるパーツ
let pendingGlbPartTransforms = null; // ロード前に適用待ちのパーツ位置・回転（保存データから復元用）
let pendingGlbLightSettings  = null; // ロード前に適用待ちのエリアライト設定（保存データから復元用）

// 視点固定モードでの2本指パンオフセット（カメラtargetをずらす量、船座標系）
const chasePanOffset = new THREE.Vector3(0, 0, 0);
let glbLights = []; // Blenderからインポートされたライトを管理
let glbLightMaster = 1.0; // 全GLBライトのマスター明るさ倍率
let glbLightAutoMode = true; // true: 日が昇ったらGLBライト(エリア/ポイント等、航行灯以外)を自動消灯
// ↑デフォルトON。昼間は使わないライトをvisible=falseで完全にレンダリング対象外にし、
//   フラグメントシェーダーのライト計算負荷(モバイルGPUの上限)を下げる。
let windowGlowMaterials = [];    // 窓・キャビンなど常時emissiveで光らせているマテリアル（昼夜で自動ON/OFF）
let windowGlowMeshEntries = []; // [{mesh, mat}] emissiveメッシュ一覧（PointLight配置計算用）
let windowGlowLights = [];      // emissiveクラスタに配置したPointLight（窓灯りで周囲を照らす）
let windowGlowLightProbe = null; // v168: 発光メッシュ群をSH係数化した環境光（PointLightだけでは
                                  // カバーしきれない区画の「真っ暗」を防ぐための底上げ役）
let windowGlowProbeBaseSH = null; // v168: フル点灯時のSH係数(THREE.Vector3[9])。updateWindowGlow()で
                                   // 昼夜係数に応じてこれをスケールしてプローブへ適用する
let promenadeLights = []; // v169: プロムナードライト等（丸い照明カバー）用の個別小型PointLight一覧。
                           // 窓明かり(windowGlowLights)とは別枠で管理する（役割・distance設定が違うため）
let sunLight, skyMesh;

// ============================================================
//  甲板照明システム (Deck Light System)
// ============================================================
// decorLights: 見た目だけの発光スポット（数無制限）。
//   常時 emissive+加算ブレンドで光って見える。本物の光源は持たない。
// deckLightPool: 実際に床・壁を照らす PointLight のプール（Android予算内: 最大5個）
//   毎フレーム、カメラに近い decorLights 上位N個にのみ割り当てる。
// ============================================================
const decorLights = [];        // { group, worldPos(vec3, 毎フレーム更新) }
const DECK_LIGHT_POOL_SIZE = 5; // Android向け予算: 太陽1+補助1+航行灯5+甲板5=12個以内
const deckLightPool = [];      // THREE.SpotLight × DECK_LIGHT_POOL_SIZE（下向き片側照射）
const deckLightTargets = [];   // SpotLight用ターゲットObject3D
let deckLightPoolReady = false;
let deckLightIntensityMult = 1.0; // 甲板照明の明るさ倍率（UIスライダーから制御）
let deckLightDirAngle = 270;       // 照射方向（deg）：270=真下、0=+Z前、90=+X右など
let selectedDecorLightIndex = -1;  // 現在ギズモ選択中のdecorLightインデックス（-1=未選択）

// ============================================================
//  ブルーム (Bloom / UnrealBloomPass)
// ============================================================
// 構成（v2: オフスクリーンRenderTarget経由を船体描画から完全に排除）:
//   ① noBloom対象を黒く塗りつぶした状態で bloomComposer（RenderPass+UnrealBloomPass）を
//      画面に出さずに実行 → 輝度抽出+ブラーした「光だけ」のテクスチャを得る
//   ② renderer.render(scene, camera) で通常通りキャンバスへ直接描画
//      （ブルームOFF時と完全に同一の経路・精度。船体は一切オフスクリーンRenderTargetを経由しない）
//   ③ ①のテクスチャを貼った全画面クアッドを加算合成でキャンバスに重ねる
// 以前はベース画像も別のEffectComposer(RenderPass)経由でオフスクリーンRenderTargetへ
// 描いていたため、メインキャンバスより精度の低いDepthバッファでZファイティングが悪化し、
// 船体が「ガビガビ」に見える問題が直らなかった（むしろ悪化していた）。
// この構成ではキャンバスへの直接描画(②)以外は単純な2D加算オーバーレイのみのため、
// 船体のZファイティングはブルームOFF時と完全に同じになるはず。
let bloomComposer = null;      // EffectComposer（ブルーム抽出専用。画面には出さない）
let bloomPass = null;          // UnrealBloomPass
let bloomOverlayScene = null;  // ブルーム結果を加算合成するための全画面クアッド用シーン
let bloomOverlayCamera = null; // 全画面クアッド用の正射影カメラ
let bloomEnabled = true;       // ブルームのON/OFF
let noBloomDarkMaterial = null;          // ブルーム抽出パス中、noBloom対象を塗りつぶす黒マテリアル
const noBloomMaterialCache = new Map();  // 退避した元マテリアル（抽出パスの間だけ差し替える）

// ============================================================
//  煙突スポットライト (Funnel Uplight)
// ============================================================
// 煙突の左右両脇・根元より下から、斜め上の煙突へ向けて照らし上げる SpotLight 群。
// buildFunnelMeshes() 呼び出し時に煙突と同期して再生成する。
// 各エントリ: { spotL, targetL, markerL, spotR, targetR, markerR, baseIntensity, funnelIndex, isMirror }
// markerL/markerR はギズモで回転させることで照射角度を変更できる見た目のないノード。
const funnelUplights = [];
let funnelUplightEnabled = true; // オン/オフ
let lightingNightFactor = 0; // 1=夜(点灯) 〜 0=昼(消灯)。窓emissiveとGLBライト自動モードの両方で使う
let cgMarker, rudderMarker;
let ambientLight, hemiLight, fillLight;

let pendingOBJText = null;
let pendingOBJName = null;
let pendingMTLMaterials = null;
let pendingMTLText = null;
let textureAliases = {};
let textureObjectURLs = [];
let textureResolverInstalled = false;
let textureAliasCount = 0;

const perf = {
    quality: 'medium',
    // LODグリッドのRing0（船周辺・最高密度域）の格子分割数（辺あたり）。
    // 数値が大きいほど船周辺が細かくなる。遠方コストはほぼ変わらない。
    waterSegments: 120,
    smokeCap: 1000,
    normalsInterval: 3,
    historyMax: 35,
    pixelRatio: 1.0,
    // ── リアルタイムシャドウマップ品質 ──
    // shadowsEnabled=falseの端末では影を完全にOFFにして（shadowMap.enabled自体を
    // 切り替える）コストをゼロにする。shadowMapSizeは太陽用シャドウマップの
    // 一辺の解像度（正方形）。
    shadowsEnabled: true,
    shadowMapSize: 2048,
    // v164: 「引き波(泡パーティクル)が出始めると重くなる」への対応。
    // foam(引き波の帯、type=0)は毎フレーム getWaveHeight() で水面に追従させて
    // いるが、この関数は shipHistory を毎回全件(historyMax分、highなら最大60件)
    // 線形走査するため、生存中のfoam数×historyMax に比例してコストが増える
    // （foamは寿命が他の粒子の約3倍長いv95の変更もあり、同時生存数が多くなり
    // やすい）。foamUpdateIntervalは「1個のfoam粒子について、この重い高さ
    // 計算を何フレームに1回行うか」の間引き間隔。1=毎フレーム(従来通り)、
    // 3なら3フレームに1回だけ計算し、それ以外のフレームは前回の速度で
    // そのまま位置を進める（波の上下運動はゆっくりなので、数フレーム間引いても
    // 見た目にはほぼ気付かれない）。
    foamUpdateInterval: 1,
    // v166: 窓明かりPointLight（windowGlowLights）のシャドウマップ再計算を
    // 間引く間隔。v165でマップ解像度は品質帯別に段階化したが、灯数自体は
    // 最大8灯のまま（意図的に維持）。8灯すべてを毎フレーム再計算しなくても、
    // ライトは船（modelRoot）に対して常に同じローカル座標なので、船の移動・
    // 回転に伴うワールド位置の変化はシャドウの形そのものにはほぼ影響しない
    // （船全体が一体で動くだけで、窓と壁の相対位置関係は変わらないため）。
    // そこで各ライトにautoUpdate=falseを設定し、updateWindowGlow()側で
    // 「wgShadowUpdateInterval フレームに1回、8灯のうち1灯だけ」を
    // ローテーションで更新する（8灯 × interval フレームで一巡）。
    // interval=1なら従来通り毎フレーム全灯更新。
    wgShadowUpdateInterval: 1
};
let normalsFrameCounter = 0;
let wgShadowFrameCounter = 0; // v166: windowGlowLightsのシャドウ間引き更新用フレームカウンタ

const lightSettings = {
    sunMult: 1.0,
    ambientMult: 1.0,
    hemiMult: 1.0,
    fillMult: 1.0,
    exposure: 0.85,       // v83で色空間を修正した分、全体的に明るく出るようになったため1.1→0.85へ
    fogMult: 1.0,
    glbMaster: 1.0,
    windowGlowMult: 1.0,  // 窓・キャビンなど常時emissiveマテリアルの発光強さ（ユーザー調整用）
    envMult: 1.0,         // 空(PMREM)由来の環境光/反射の強さ。0でscene.environmentをOFFにできる
    skyMult: 1.0          // 空シェーダー自体の明るさの追加倍率（基準となる0.75補正の上にさらに掛かる）
};

let userWaterVisible = true;

const PERF_PRESETS = {
    // グラフィック全般（水面以外）の品質プリセット。
    // smokeCap=煙パーティクル数上限、normalsInterval=法線再計算間隔(フレーム)、
    // historyMax=航跡履歴の長さ、pixelRatio=内部レンダリング解像度倍率。
    // 海面の重さは別途 WATER_PRESETS / applyWaterQualityPreset() で独立に調整する。
    // v89: high の pixelRatio上限を1.5→2.0へ引き上げ。スマホは大抵devicePixelRatioが
    // 2.5〜3台あるため、上限1.5だと内部解像度が画面ネイティブより低いまま引き伸ばされ、
    // 全体的に少しぼやけた/粗い見え方になっていた(実際に使われる値はこことdevicePixelRatio
    // のMath.minなので、DPIが低い端末では今まで通り軽いまま)。
    // v166: wgShadowUpdateInterval = windowGlowLightsのシャドウ再計算間隔（フレーム）。
    // medium/lowは段階的に間引く。verylow/ultralowはgetWindowGlowShadowConfig()側で
    // シャドウ自体がenabled=falseになるため値は使われないが、一応大きめにしておく。
    // v167: 「v147と比べてまだ重い」との報告を受け、high=1（間引きなし）だった点を見直し。
    // v166時点ではhigh帯は従来通り8灯×6面×1024²を毎フレーム再計算しており、v148で
    // 発生した重さがhigh帯には手つかずのまま残っていた（medium/lowだけが間引きの恩恵を
    // 受けていた）。high=2に変更し、画質最優先の帯であることを踏まえてmedium(3)・low(6)
    // より緩やかな間引きに留める（1灯あたりの実質更新間隔は16フレーム≒0.27秒@60fps）。
    high:    { smokeCap: 2000, normalsInterval: 1, historyMax: 60, pixelRatio: 2.0,  shadowsEnabled: true,  shadowMapSize: 2048, foamUpdateInterval: 1, wgShadowUpdateInterval: 2 },
    medium:  { smokeCap: 1000, normalsInterval: 3, historyMax: 35, pixelRatio: 1.0,  shadowsEnabled: true,  shadowMapSize: 2048, foamUpdateInterval: 2, wgShadowUpdateInterval: 3 },
    low:     { smokeCap: 600,  normalsInterval: 4, historyMax: 22, pixelRatio: 0.85, shadowsEnabled: true,  shadowMapSize: 1024, foamUpdateInterval: 3, wgShadowUpdateInterval: 6 },
    verylow: { smokeCap: 300,  normalsInterval: 6, historyMax: 14, pixelRatio: 0.75, shadowsEnabled: true,  shadowMapSize: 512,  foamUpdateInterval: 4, wgShadowUpdateInterval: 6 },
    // 内部解像度をさらに落として(0.55倍)CSSで引き延ばす、最も軽い設定。影も完全にOFF。
    ultralow:{ smokeCap: 150,  normalsInterval: 8, historyMax: 10, pixelRatio: 0.55, shadowsEnabled: false, shadowMapSize: 512,  foamUpdateInterval: 4, wgShadowUpdateInterval: 6 }
};

function applyPerfPreset(name) {
    const preset = PERF_PRESETS[name];
    if (!preset) return;
    perf.quality = name;
    Object.assign(perf, preset);
    if (renderer) {
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, perf.pixelRatio));
    }
    applyShadowQualityFromPerf();
    if (globalSmokeGeo) {
        globalSmokeGeo.setDrawRange(0, perf.smokeCap);
        if (smokeIdx >= perf.smokeCap) smokeIdx = 0;
        // Fade out particles beyond the new cap immediately
        const ageAttr = globalSmokeGeo.attributes.age;
        for (let i = perf.smokeCap; i < MAX_SMOKE; i++) ageAttr.array[i] = 999;
        ageAttr.needsUpdate = true;
    }
    while (shipHistory.length > perf.historyMax) shipHistory.shift();
}

// perf.shadowsEnabled / perf.shadowMapSize を実際のrenderer/sunLightへ反映する。
// mapSizeを変えた場合は既存のシャドウマップRenderTargetを破棄し、次フレームで
// 新しい解像度で再生成させる（Three.js側は自動では再生成してくれないため）。
function applyShadowQualityFromPerf() {
    if (!renderer || !sunLight) return;
    renderer.shadowMap.enabled = !!perf.shadowsEnabled;
    sunLight.castShadow = !!perf.shadowsEnabled;
    if (sunLight.shadow && sunLight.shadow.mapSize.width !== perf.shadowMapSize) {
        sunLight.shadow.mapSize.set(perf.shadowMapSize, perf.shadowMapSize);
        if (sunLight.shadow.map) {
            sunLight.shadow.map.dispose();
            sunLight.shadow.map = null;
        }
    }
    // v147: 窓灯りPointLight（windowGlowLights、08-model-loading-and-lighting.js）の
    // 影設定も、画質プリセットが変わるたびに追従させる（モデルを読み込み直さなくても
    // 品質スライダーの変更だけで即座に切り替わるように）。
    const wg = getWindowGlowShadowConfig();
    windowGlowLights.forEach((pl) => {
        pl.castShadow = wg.enabled;
        // v166: シャドウ更新はupdateWindowGlow()側のローテーション間引きに一任するため、
        // ここでも常にautoUpdate=falseを保証しておく（Three.jsのデフォルトはtrueなので、
        // 新規ライト以外の経路でここに来た場合も明示的に落としておく必要がある）。
        pl.shadow.autoUpdate = false;
        if (wg.enabled) {
            if (pl.shadow.mapSize.width !== wg.mapSize) {
                pl.shadow.mapSize.set(wg.mapSize, wg.mapSize);
                if (pl.shadow.map) {
                    pl.shadow.map.dispose();
                    pl.shadow.map = null;
                }
            }
            // マップが再生成されるケース（新規/dispose後/解像度変更後）に備え、
            // 次の担当フレームを待たず即座に1回描画させる
            pl.shadow.needsUpdate = true;
        } else if (pl.shadow.map) {
            // 品質を下げてOFFにした際もRenderTargetを持ち越さずすぐ解放する
            pl.shadow.map.dispose();
            pl.shadow.map = null;
        }
    });
}

// v147: windowGlowLights（窓灯りPointLight、buildWindowGlowLights参照）の
// 影を有効にするかどうか・マップ解像度を品質設定から決める。sunLightの
// shadowMapSizeとは別枠で管理する：PointLightの影は立方体マップ6面ぶんの
// コストがあり、最大8灯（v147-fix2で4→8に増量）が同時にこれを使う。
// v148: 従来は192px固定だったが、天窓ドームのような細い格子ジオメトリでは
// 低解像度＋bias/normalBiasの組み合わせでテクセル誤差が無視できず、
// 左右対称なはずの構造でも面ごとに影の出方が違って見える不具合があった
// （キューブマップの6面それぞれでbiasの効き方が変わるため）。パフォーマンス
// より見た目の一貫性を優先し、1024pxに引き上げる。
// 注意: 8灯 × 6面 × 1024^2 の深度テクスチャは低スペック端末では
// 重くなる可能性がある（verylow/ultralowでは従来通り丸ごと無効化）。
// 実機で重ければこの値を下げて調整すること。
//
// v165: 「iPadで画質をhigh/medium/lowにすると重い、verylow/ultralowだと
// ぬるぬる動く」という報告を受けての対応。従来はverylow/ultralow以外
// （high/medium/low）が一律1024pxだったため、8灯×6面×1024^2という最重量級の
// 設定がhigh〜lowの3段階すべてに掛かっていた。ここをperf.qualityに応じて
// 段階化する（high=1024px従来通り、medium=512px、low=256px）。
// キューブマップの深度パスコストは解像度の2乗に比例するため、512pxは1024pxの
// 約1/4、256pxは約1/16のコストになる（6面×灯数ぶんに、この比率がそのまま掛かる）。
function getWindowGlowShadowConfig() {
    if (!perf.shadowsEnabled || perf.quality === 'verylow' || perf.quality === 'ultralow') {
        return { enabled: false, mapSize: 0 };
    }
    if (perf.quality === 'low') return { enabled: true, mapSize: 256 };
    if (perf.quality === 'medium') return { enabled: true, mapSize: 512 };
    return { enabled: true, mapSize: 1024 }; // high
}

// ============================================================
//  海面リアリティー（Water Realism）— グラフィック品質とは独立して調整できる
// ============================================================
// 海面表示が重くなる主な原因は以下の3点で、いずれもグラフィック全般の品質とは
// 別軸の「海面専用」コストのため、ここで独立に管理する。
//   1) waterSegments … LOD水面メッシュの船周辺密度（頂点数 → 毎フレームCPU波計算量）
//   2) reflectionEnabled/skipFrames … 水面反射用のシーン再レンダリング頻度
//   3) sweEnabled … SWE流体シミュ(GPU)。OFFにすると軽量な従来式の波計算に切り替わる
let waterQuality = 'medium';
window.waterReflectionEnabled = true;
window.waterReflectionSkipFrames = 3; // Nフレームに1回反射を再レンダリング（大きいほど軽い）

const WATER_PRESETS = {
    // v163: parallaxEnabled = 水面の視差マッピング（水平に近い視点での立体感対策）。
    // ハイトマップの追加サンプリング(1テクスチャあたり+1回、3枚で計+3回)が乗る分、
    // verylow相当の非力な端末では素直にOFFにして負荷を増やさない。
    high:    { waterSegments: 168, reflectionEnabled: true,  reflectionSkipFrames: 2, sweEnabled: true,  parallaxEnabled: true  },
    medium:  { waterSegments: 120, reflectionEnabled: true,  reflectionSkipFrames: 3, sweEnabled: true,  parallaxEnabled: true  },
    low:     { waterSegments: 84,  reflectionEnabled: true,  reflectionSkipFrames: 5, sweEnabled: false, parallaxEnabled: true  },
    verylow: { waterSegments: 60,  reflectionEnabled: false, reflectionSkipFrames: 8, sweEnabled: false, parallaxEnabled: false }
};

function applyWaterQualityPreset(name) {
    const preset = WATER_PRESETS[name];
    if (!preset) return;
    waterQuality = name;
    window.waterQuality = name;
    perf.waterSegments = preset.waterSegments;
    window.waterReflectionEnabled = preset.reflectionEnabled;
    window.waterReflectionSkipFrames = preset.reflectionSkipFrames;
    // SWE（流体シミュ）はWebGL float texture非対応環境では常にfalseのまま。
    // 対応環境でのみ、プリセットに応じてON/OFFを切り替える。
    if (typeof swe !== 'undefined' && swe) {
        window.sweEnabled = preset.sweEnabled;
    }
    // v163: 視差マッピングのON/OFFをシェーダーuniformへ反映。
    // window._waterUniformsは04-scene-and-water-init.js側でwater初期化後に
    // セットされるグローバル参照（17-main-loop.jsの他のuniform更新と同じパターン）。
    // 初期化前にこの関数が呼ばれるケースに備えてnullチェックしておく。
    if (window._waterUniforms && window._waterUniforms.parallaxEnabled) {
        window._waterUniforms.parallaxEnabled.value = preset.parallaxEnabled ? 1.0 : 0.0;
    }
    if (typeof rebuildWaterGeometry === 'function') rebuildWaterGeometry(perf.waterSegments);
}

const shipHistory = [];
const clock = new THREE.Clock();

const physics = {
    y: 0.0, vy: 0.0, speed: 0.0, targetSpeed: 0.0,
    heading: 0.0, turnRate: 0.0,
    pitch: 0.0, vPitch: 0.0, roll: 0.0, vRoll: 0.0,
    mass: 1.5, buoyancy: 12.0, buoyancyBase: 12.0, draftOffset: 0.0,
    // 喫水線の基準点（モデルローカルY）。重心(cgOffset.y)とは独立に設定できる。
    // 例: 重心が水面より下にある船（バラストキール等）もこの値とcgOffset.yを別々に設定すれば再現できる。
    // デフォルト値はcgOffset.yの初期値(-0.5)と一致させ、既存挙動を変えないようにしている。
    waterlineOffsetY: -0.5,
    waveRoughness: 1.0, waveWidth: 1.0, swellStrength: 1.0, chopStrength: 1.0, maxSpeed: 13.0, scale: 1.0,
    turningRadiusFactor: 5.0,
    bowFullness: 1.0, sternFullness: 1.0,
    rudderAngle: 0.0, telegraphState: 0,
    cgOffset: { x: 0.0, y: -0.5, z: 0.0 },
    rudderOffset: { x: 0.0, y: -1.0, z: -7.0 },
    cgWorldX: 0.0, cgWorldZ: 0.0,
    gameTime: 12 * 60,  // dayDuration=900sec基準での正午（=12/24*900=450秒）→ 0.5dayProgress
    dayDuration: 15 * 60,
    dayProgress: 0.5,
    moonPhase: 0.0,     // 新月からスタート
    moonPhaseManual: false,
    windDir: 45, windSpeed: 5
};

const modelOffset = { x: 0.0, y: 0.0, z: 0.0, ry: 0.0, scale: 1.0, autoScale: 1.0 };
const keys = { w: false, s: false, a: false, d: false };
let touchLeft = false, touchRight = false;
let nextMeteorTime = 30.0 + Math.random() * 60.0;
let auroraActive = 0.0;
let nextAuroraDay = 25.0 + Math.random() * 10.0;

// 時間進行速度: 0=等速(1:1), 1=×12, 2=×96(default), 3=×576, 4=×3456
const TIME_SPEED_STEPS = [1, 12, 96, 576, 3456];
let timeSpeedIndex = 2; // default ×96
let timeFrozen = false;

// 航行灯の光源適応距離
window.navLightDistance = 60;

// ============================================================
//  物理シミュレーション速度倍率
//  1.0 = リアルタイム（等倍）  最大 20.0
//  加速度・慣性・旋回・波揺れ等、物理全体が一律に早送りされる。
//  時刻進行(TIME_SPEED_STEPS)とは独立。
// ============================================================
let physicsSpeed = 1.0;

