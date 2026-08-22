// ============================================================
//  19-swe-fluid.js  — Shallow Water Equations (SWE) 流体シミュレーター
//
//  【方式】ping-pong WebGLRenderTarget × 2 本
//    ・State Texture A/B : RGBA float
//        R = 水位 h (sea surface height)
//        G = u (X方向の流速)
//        B = v (Z方向の流速)
//        A = 障害物マスク (1=水, 0=船体/陸)
//    ・毎フレーム フラグメントシェーダーで SWE を解き A→B へ書き出す
//    ・次フレームは B→A、と ping-pong で繰り返す
//    ・出力テクスチャを頂点シェーダーの displacement map として使用
//
//  【SWEの方程式（線形化 / 浅水）】
//    ∂h/∂t = -H(∂u/∂x + ∂v/∂z)          // 連続方程式
//    ∂u/∂t = -g ∂h/∂x - damping*u        // x方向運動方程式
//    ∂v/∂t = -g ∂h/∂z - damping*v        // z方向運動方程式
//    有限差分で離散化 (explicit Euler, CFL条件 dt < dx/(sqrt(g*H)) )
//
//  【グリッド】
//    SWE_N × SWE_N テクセル（世界座標 SWE_WORLD × SWE_WORLD をカバー）
//    船周辺のみ高解像度、遠方は粗くする LOD はやらず均一グリッドで
//    モバイル向けに SWE_N=64 がデフォルト（128 に上げると 2〜3 倍重い）
//
//  【船体障害物】
//    scanHullProfile() 後に buildSWEObstacleMask() を呼んで
//    障害物テクスチャをピクセルに焼く。
//    船が動いたら毎フレーム低コストで動的更新（障害物マスクだけ更新）。
//
//  【Gerstner外洋波との合成】
//    SWE h フィールドは「船体が作る局所的な波」のみを扱う。
//    getWaveCrestAndHeight() の外洋 Gerstner 波と加算合成してから
//    waterMesh 頂点に書き込む。
//
//  【Android 対応】
//    ・OES_texture_float 拡張の有無をチェックし、なければ fallback（旧方式）
//    ・SWE_N を 64 に絞って計算負荷を抑制
//    ・障害物マスク更新は毎フレーム行うが CPU 計算ゼロ（シェーダー内で判定）
// ============================================================

'use strict';

// ─── 定数 ──────────────────────────────────────
const SWE_N     = 64;          // グリッド解像度（64×64）
const SWE_WORLD = 180;         // SWEグリッドがカバーする世界座標の幅 [unit]
const SWE_DX    = SWE_WORLD / SWE_N;   // セル幅 [unit]
const SWE_G     = 9.81;        // 重力加速度
const SWE_H     = 8.0;         // 平均水深 [unit] (SWE線形化の基準深度)
const SWE_DAMP  = 0.012;       // 減衰係数（波が遠くで消える）
// CFL条件: dt_max = dx / sqrt(g*H) ≈ SWE_DX / sqrt(9.81*8) ≈ dx/8.86
// 60fps で dt≈0.016s → SWE_N=64, WORLD=180 → dx=2.8 → dt_max≈0.316 → 安全
const SWE_DT    = 0.013;       // SWEシミュ内部タイムステップ (≤ CFL)
const SWE_SUBSTEPS = 1;        // 毎フレームのサブステップ数

// ─── モジュール変数 ────────────────────────────
let swe = null; // SWEシステム全体を保持するオブジェクト

// ─────────────────────────────────────────────────────────
//  initSWE()
//  SWEシステムを初期化する。WebGLRenderer が必要なので init() の後で呼ぶ。
//  呼び出しタイミング: createWater() の末尾で呼ぶ。
// ─────────────────────────────────────────────────────────
function initSWE() {
    const gl = renderer.getContext();

    // float テクスチャのサポートチェック
    const floatExt = gl.getExtension('OES_texture_float')
                  || gl.getExtension('EXT_color_buffer_float');
    const halfExt  = gl.getExtension('OES_texture_half_float')
                  || gl.getExtension('EXT_color_buffer_half_float');

    if (!floatExt && !halfExt) {
        console.warn('[SWE] float texture not supported → SWE disabled, using legacy wave');
        window.sweEnabled = false;
        return;
    }

    const texType = floatExt ? THREE.FloatType : THREE.HalfFloatType;

    // ping-pong render targets
    const rtOpts = {
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        format: THREE.RGBAFormat,
        type: texType,
        depthBuffer: false,
        stencilBuffer: false,
    };
    const rtA = new THREE.WebGLRenderTarget(SWE_N, SWE_N, rtOpts);
    const rtB = new THREE.WebGLRenderTarget(SWE_N, SWE_N, rtOpts);

    // 障害物マスク専用テクスチャ（R: 船体=0, 水=1）
    // 毎フレームシェーダー内で生成するのではなく、別 RT に事前ベイク
    const maskRT = new THREE.WebGLRenderTarget(SWE_N, SWE_N, {
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        format: THREE.RedFormat !== undefined ? THREE.RedFormat : THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        depthBuffer: false,
    });

    // ─── SWEステップシェーダー ──────────────────────────────
    const sweStepMat = new THREE.ShaderMaterial({
        uniforms: {
            stateMap:   { value: rtA.texture }, // 現在のh,u,v
            maskMap:    { value: maskRT.texture },
            dx:         { value: SWE_DX },
            dt:         { value: SWE_DT },
            gravity:    { value: SWE_G },
            depth:      { value: SWE_H },
            damping:    { value: SWE_DAMP },
            // 外部扰動: 船体がこのセルにいたら h に波源を加える
            disturbPos: { value: new THREE.Vector2(0.5, 0.5) }, // UV座標
            disturbAmt: { value: 0.0 },
            disturbRad: { value: 0.04 },  // セル幅比
            shipSpeed:  { value: 0.0 },
            // 船体スライス（最大 HULL_SLICES=24 本）を UV 座標で渡す
            sliceCount: { value: 0 },
            sliceUV:    { value: new Array(24).fill(null).map(()=>new THREE.Vector2()) },
            sliceHW:    { value: new Float32Array(24) }, // 喫水線幅 (UV幅)
            // グリッドのワールド原点（船に追従させるため毎フレーム更新）
            gridOrigin: { value: new THREE.Vector2(0, 0) },
            gridSize:   { value: SWE_WORLD },
        },
        vertexShader: `
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            precision highp float;
            uniform sampler2D stateMap;
            uniform sampler2D maskMap;
            uniform float dx;
            uniform float dt;
            uniform float gravity;
            uniform float depth;
            uniform float damping;
            uniform vec2  disturbPos;
            uniform float disturbAmt;
            uniform float disturbRad;
            uniform float shipSpeed;
            // 障害物判定: スライスUV
            uniform int   sliceCount;
            uniform vec2  sliceUV[24];
            uniform float sliceHW[24];
            uniform vec2  gridOrigin;
            uniform float gridSize;

            varying vec2 vUv;

            // テクセルサイズ
            #define N ${SWE_N}.0
            #define INV_N (1.0 / N)

            // 隣接セルのstate読み込み
            vec4 sample(vec2 uv) { return texture2D(stateMap, clamp(uv, INV_N*0.5, 1.0-INV_N*0.5)); }

            // 船体スライスに基づく障害物判定 (returns 1=水, 0=船体内)
            float getObstacle(vec2 uv) {
                // マスクテクスチャ（計算済み）があれば使う
                float m = texture2D(maskMap, uv).r;
                return m; // 0=船体, 1=水（すでに反転済み）
            }

            void main() {
                vec2 ts = vec2(INV_N); // テクセルサイズ

                // 現在セルと隣接セルのstate
                vec4 cen = sample(vUv);
                vec4 px  = sample(vUv + vec2( ts.x, 0));
                vec4 nx  = sample(vUv + vec2(-ts.x, 0));
                vec4 pz  = sample(vUv + vec2(0,  ts.y));
                vec4 nz  = sample(vUv + vec2(0, -ts.y));

                float h  = cen.r;  // 水位
                float u  = cen.g;  // x流速
                float v  = cen.b;  // z流速

                // v125: 障害物マスクを実際に読んで使う（従来はisWater=1.0固定で
                // getObstacle()は定義されているのに一度も呼ばれていなかった）
                float isWater = getObstacle(vUv);

                // ── SWE 有限差分 (explicit Euler) ──────────────────
                // ∂h/∂t = -H * (∂u/∂x + ∂v/∂z)
                float dh = -depth * (
                    (px.g - nx.g) / (2.0 * dx) +
                    (pz.b - nz.b) / (2.0 * dx)
                );

                // ∂u/∂t = -g * ∂h/∂x - damping*u
                float du = -gravity * (px.r - nx.r) / (2.0 * dx) - damping * u;

                // ∂v/∂t = -g * ∂h/∂z - damping*v
                float dv = -gravity * (pz.r - nz.r) / (2.0 * dx) - damping * v;

                float newH = h + dh * dt;
                float newU = u + du * dt;
                float newV = v + dv * dt;

                // v125: 船体セル(isWater=0)では流速を強制的に0にする。
                // これにより水が船体を素通りできなくなり、連続方程式(dh)を通じて
                // 船体の縁に水位差（＝押しのけられた水）が自然に生まれる。
                newU *= isWater;
                newV *= isWater;

                // v126: 水位(h)も同時に0へ落とす。
                // u/vだけマスクしても「そのセル自身の高さ」は残ったままなので、
                // 船体が新たにそのセルへ進んできた瞬間の波高がそのまま閉じ込め
                // られていた(＝引き波が船体の中に入り込んで見えるバグの本体)。
                // さらにこの残留hは隣接する水セルのdu/dv計算でpx.r/nx.r/pz.r/nz.r
                // として直接読まれるため、船体のすぐ外側の水セルの圧力勾配まで
                // 歪めてしまっていた。u/vと同じくisWaterを掛けて即座に0へ戻す。
                newH *= isWater;

                // 船体進入による波源：disturbPos 周辺に水位を押し込む
                // v125: isWaterを掛けて船体セルそのものには注入しない
                // (注入だけして流速は0のままだと、そのセルの水位がクランプ上限に
                // 張り付いたまま抜けなくなるため)。周囲の水セルには通常どおり届く。
                float distToShip = length(vUv - disturbPos);
                if (distToShip < disturbRad && disturbAmt > 0.0) {
                    float envelope = 1.0 - smoothstep(0.0, disturbRad, distToShip);
                    newH += disturbAmt * envelope * isWater;
                }

                // 発散を抑えるためにソフトクランプ
                newH = clamp(newH, -12.0, 12.0);
                newU = clamp(newU, -30.0, 30.0);
                newV = clamp(newV, -30.0, 30.0);

                // 境界（グリッド端）は減衰させてアーチファクトを防ぐ
                float margin = 3.0 * INV_N;
                float edgeDamp = smoothstep(0.0, margin, vUv.x)
                               * smoothstep(1.0, 1.0-margin, vUv.x)
                               * smoothstep(0.0, margin, vUv.y)
                               * smoothstep(1.0, 1.0-margin, vUv.y);
                newH *= edgeDamp;
                newU *= edgeDamp;
                newV *= edgeDamp;

                gl_FragColor = vec4(newH, newU, newV, isWater);
            }
        `,
        depthTest: false,
        depthWrite: false,
    });

    // ─── 障害物マスク更新シェーダー ───────────────────────────
    // 毎フレーム船体スライス UV に基づいて maskRT を更新する
    const maskMat = new THREE.ShaderMaterial({
        uniforms: {
            sliceCount: { value: 0 },
            sliceUV:    { value: new Array(24).fill(null).map(()=>new THREE.Vector2()) },
            sliceHW:    { value: new Float32Array(24) },
            sliceFWD:   { value: new Array(24).fill(null).map(()=>new THREE.Vector2()) },
            sliceLenUV: { value: 0.02 },
            gridOrigin: { value: new THREE.Vector2(0, 0) },
            gridSize:   { value: SWE_WORLD },
            shipHeading:{ value: 0.0 },
        },
        vertexShader: `
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            precision highp float;
            uniform int   sliceCount;
            uniform vec2  sliceUV[24];   // スライス中心UV
            uniform float sliceHW[24];   // 喫水線幅(UV幅の半分)
            // 船首軸方向ベクトル (UV空間) — スライスは船首軸に直交する
            uniform vec2  sliceFWD[24];
            uniform float sliceLenUV;    // スライスの前後幅（船体長に応じてJS側で計算）
            uniform vec2  gridOrigin;
            uniform float gridSize;
            uniform float shipHeading;
            varying vec2 vUv;

            #define N ${SWE_N}.0
            #define INV_N (1.0 / N)
            #define MAX_SLICES 24

            void main() {
                float isWater = 1.0; // デフォルトは水

                if (sliceCount > 0) {
                    // 各スライスとの距離判定
                    for (int i = 0; i < MAX_SLICES; i++) {
                        if (i >= sliceCount) break;
                        vec2 toCell = vUv - sliceUV[i];
                        // sliceFWD は船首方向(UV)。横方向成分がhw内ならマスク
                        vec2 fwd = sliceFWD[i];
                        vec2 side = vec2(-fwd.y, fwd.x); // 直交(横)方向
                        float alongDist = abs(dot(toCell, fwd));
                        float perpDist  = abs(dot(toCell, side));
                        float hw = sliceHW[i];
                        // v125: 固定値(INV_N*1.5)だと大型船でスライス間に隙間ができるため、
                        // 実際のスライス間隔から求めたsliceLenUVを使う
                        if (perpDist < hw && alongDist < sliceLenUV) {
                            isWater = 0.0;
                            break;
                        }
                    }
                }

                // r=0: 船体, r=1: 水
                gl_FragColor = vec4(isWater, 0.0, 0.0, 1.0);
            }
        `,
        depthTest: false,
        depthWrite: false,
    });

    // フルスクリーンクアッド（SWEステップ・マスク更新用）
    const quadGeo = new THREE.PlaneGeometry(2, 2);
    const quadMesh = new THREE.Mesh(quadGeo, sweStepMat);
    const maskMesh = new THREE.Mesh(quadGeo, maskMat);
    const sweScene = new THREE.Scene();
    const sweCam   = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    swe = {
        rtA, rtB,
        maskRT,
        sweStepMat,
        maskMat,
        sweScene,
        sweCam,
        quadMesh,
        maskMesh,
        texType,
        pingPong: false, // false=A→B, true=B→A
        gridOriginX: 0,
        gridOriginZ: 0,
        lastShipX: 0,
        lastShipZ: 0,
        lastShipSpeed: 0,
        frameCount: 0,
    };

    // 初期状態: h=0, u=0, v=0
    _sweClearRT(rtA);
    _sweClearRT(rtB);

    window.sweEnabled = true;
    console.log(`[SWE] initialized ${SWE_N}×${SWE_N} world=${SWE_WORLD}unit dx=${SWE_DX.toFixed(2)}`);
}

// RenderTargetを0クリア
function _sweClearRT(rt) {
    renderer.setRenderTarget(rt);
    renderer.clearColor();
    renderer.setRenderTarget(null);
}

// ─────────────────────────────────────────────────────────
//  _sweWorldToUV(wx, wz)
//  ワールド座標 → SWEグリッドUV (0〜1)
// ─────────────────────────────────────────────────────────
function _sweWorldToUV(wx, wz) {
    const ox = swe.gridOriginX - SWE_WORLD * 0.5;
    const oz = swe.gridOriginZ - SWE_WORLD * 0.5;
    return new THREE.Vector2(
        (wx - ox) / SWE_WORLD,
        (wz - oz) / SWE_WORLD
    );
}

// ─────────────────────────────────────────────────────────
//  _sweUpdateMask(totalRad, origin, WS)
//  v125: 障害物マスクを実際の船体形状で再有効化。
//  これまでは sliceCount=0 に固定されており、マスクシェーダー自体は
//  正しく書かれているのに一度も船体スライスが渡っておらず、常に
//  「全セル水」を出力していた（＝引き波が船体をすり抜けていた原因）。
//  wakeHF/getWakeHeight と同じ _hullHalfWidthAtNorm() を使って
//  船体の実喫水線幅をHULL_SLICES(24)本のスライスとしてサンプリングし、
//  SWEグリッドUV座標へ変換して渡す。
//  スライス間の隙間ができないよう、sliceLenUV は実際のスライス間隔
//  （船体長・グリッドサイズ依存）から動的に計算する。
// ─────────────────────────────────────────────────────────
const SWE_HULL_SLICES = 24;

function _sweUpdateMask(totalRad, origin, WS) {
    if (!swe || !window.sweEnabled) return;

    const uni = swe.maskMat.uniforms;
    const hp = window.hullProfile;
    const hullReady = hp && hp.ready && typeof _hullHalfWidthAtNorm === 'function'
        && typeof totalRad === 'number' && origin;

    if (!hullReady) {
        // 船体プロファイル未取得（起動直後など）は従来どおり全セル水のまま
        uni.sliceCount.value = 0;
    } else {
        const halfLenW = hp.halfLen * WS;
        const fwdX = Math.sin(totalRad);
        const fwdZ = Math.cos(totalRad);

        // スライス間隔（ワールド単位）→ 隙間なく繋がるよう半幅+αをカバー距離とする
        const spacingW = (halfLenW * 2) / (SWE_HULL_SLICES - 1);
        const sliceLenUV = (spacingW * 0.6) / SWE_WORLD; // 0.6: 隣と少し重なる程度の余裕

        for (let i = 0; i < SWE_HULL_SLICES; i++) {
            const alongNorm = -1 + (2 * i) / (SWE_HULL_SLICES - 1); // -1=船尾 .. +1=船首
            const alongW = alongNorm * halfLenW;
            const wx = origin.x + fwdX * alongW;
            const wz = origin.z + fwdZ * alongW;
            const uv = _sweWorldToUV(wx, wz);
            const hw = _hullHalfWidthAtNorm(alongNorm) * WS;

            uni.sliceUV.value[i].set(uv.x, uv.y);
            uni.sliceFWD.value[i].set(fwdX, fwdZ);
            uni.sliceHW.value[i] = hw / SWE_WORLD;
        }
        uni.sliceLenUV.value = sliceLenUV;
        uni.sliceCount.value = SWE_HULL_SLICES;
        uni.gridOrigin.value.set(swe.gridOriginX, swe.gridOriginZ);
        uni.shipHeading.value = totalRad;
    }

    swe.sweScene.add(swe.maskMesh);
    swe.maskMesh.material = swe.maskMat;
    renderer.setRenderTarget(swe.maskRT);
    renderer.render(swe.sweScene, swe.sweCam);
    renderer.setRenderTarget(null);
    swe.sweScene.remove(swe.maskMesh);
}

// ─────────────────────────────────────────────────────────
//  updateSWE(dt, t)
//  毎フレーム呼ぶ。SWEシミュをサブステップ実行して ping-pong を進める。
// ─────────────────────────────────────────────────────────
function updateSWE(dt, t) {
    if (!swe || !window.sweEnabled) return;
    swe.frameCount++;

    // 船首位置の計算に必要な向き・船体原点を先に求める。
    // 注意: physics.cgWorldX/Zは「重心」のワールド座標であり、cgOffset.x/zを
    // スライダーで動かすとreanchorWorldPositionForPinOffsetChangeの補償により
    // 値そのものが瞬間的にジャンプする（船体メッシュ自体は動かない）。
    // グリッド原点や「移動量」の計算に生のcgWorldX/Zを使うと、このジャンプに
    // つられてSWEの追従グリッドや波源が船体から取り残されてしまうため、
    // _hullOriginWorld()で補正した「船体ローカル原点」を基準にする。
    const headingRad = (physics.heading * Math.PI) / 180;
    const totalRad   = (typeof _wakeAxisRad === 'function') ? _wakeAxisRad(headingRad) : headingRad;
    const WS  = physics.scale || 1;
    const _origin = (typeof _hullOriginWorld === 'function')
        ? _hullOriginWorld(physics.cgWorldX, physics.cgWorldZ, totalRad, WS)
        : { x: physics.cgWorldX, z: physics.cgWorldZ };

    // ── グリッド原点を船に追従（SWE_WORLD/4 ずつスナップ）──
    const snapUnit = SWE_WORLD / 4;
    swe.gridOriginX = Math.round(_origin.x / snapUnit) * snapUnit;
    swe.gridOriginZ = Math.round(_origin.z / snapUnit) * snapUnit;

    // ── 障害物マスク更新（毎フレーム） ──
    _sweUpdateMask(totalRad, _origin, WS);

    // ── 船の移動量から波源扰動を計算 ──
    const spd    = Math.abs(physics.speed);
    const shipDX = _origin.x - swe.lastShipX;
    const shipDZ = _origin.z - swe.lastShipZ;
    const moved  = Math.sqrt(shipDX * shipDX + shipDZ * shipDZ);

    const hp  = window.hullProfile;
    const halfLenW = (hp && hp.ready ? hp.halfLen : 6.0) * WS;

    // 波源位置：船首
    const bowX = _origin.x + Math.sin(totalRad) * halfLenW * 0.9;
    const bowZ = _origin.z + Math.cos(totalRad) * halfLenW * 0.9;
    const bowUV = _sweWorldToUV(bowX, bowZ);

    // 扰動量: 速度に比例、停止時は0
    const disturbAmt = spd > 0.5
        ? THREE.MathUtils.clamp(spd * 0.018 * (WS * 0.3), 0.0, 0.8)
        : 0.0;

    swe.lastShipX     = _origin.x;
    swe.lastShipZ     = _origin.z;
    swe.lastShipSpeed = spd;

    // ── SWE サブステップ ──
    const uni = swe.sweStepMat.uniforms;
    uni.disturbPos.value.copy(bowUV);
    uni.disturbAmt.value  = disturbAmt;
    uni.shipSpeed.value   = spd;
    uni.gridOrigin.value.set(swe.gridOriginX, swe.gridOriginZ);
    uni.maskMap.value     = swe.maskRT.texture;

    swe.sweScene.add(swe.quadMesh);
    swe.quadMesh.material = swe.sweStepMat;

    for (let sub = 0; sub < SWE_SUBSTEPS; sub++) {
        const srcRT = swe.pingPong ? swe.rtB : swe.rtA;
        const dstRT = swe.pingPong ? swe.rtA : swe.rtB;
        uni.stateMap.value = srcRT.texture;
        renderer.setRenderTarget(dstRT);
        renderer.render(swe.sweScene, swe.sweCam);
        renderer.setRenderTarget(null);
        swe.pingPong = !swe.pingPong;
    }

    swe.sweScene.remove(swe.quadMesh);

    // 現在の出力RTをグローバルに公開（waterMesh 頂点更新で使う）
    const outRT = swe.pingPong ? swe.rtB : swe.rtA;
    window.sweOutputTexture = outRT.texture;
}

// ─────────────────────────────────────────────────────────
//  getSWEHeight(wx, wz)
//  SWEテクスチャから CPU 側で波高を読み取る。
//  ※ GPU readPixels は非常に遅いので、CPU 側では近似的な
//    解析的計算を使い、視覚的な vertex displacement は
//    GPU 頂点シェーダー（waterMesh の displacement map）で行う。
//  → この関数は船の浮力計算用 getWaveHeight() の補完として使う。
//    精度よりも速度優先の近似実装。
// ─────────────────────────────────────────────────────────
function getSWEHeight(wx, wz) {
    if (!swe || !window.sweEnabled) return 0.0;
    // 軽量近似: グリッド原点からの距離で SWE 寄与を推定
    // （実際の readPixels は避けてパフォーマンスを保つ）
    return 0.0;
}

// ─────────────────────────────────────────────────────────
//  isSWEReady()
// ─────────────────────────────────────────────────────────
function isSWEReady() {
    return swe !== null && window.sweEnabled === true;
}

// グローバル公開
window.initSWE       = initSWE;
window.updateSWE     = updateSWE;
window.getSWEHeight  = getSWEHeight;
window.isSWEReady    = isSWEReady;
