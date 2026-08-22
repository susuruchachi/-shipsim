// ----------------------------------------------------
// GLOBAL SMOKE SYSTEM VARIABLES (WORLD SPACE)
// ----------------------------------------------------
let globalSmokeGeo, globalSmokeMat, globalSmokePoints;
const MAX_SMOKE = 2600;
let smokeIdx = 0;
let smokeData = [];
let smokeEmitAccum = 0;

function createGlobalSmokeSystem() {
    function getSmokeTex() {
        const c = document.createElement('canvas'); c.width = 64; c.height = 64;
        const ctx = c.getContext('2d');
        const g = ctx.createRadialGradient(32,32,0, 32,32,32);
        g.addColorStop(0, 'rgba(255,255,255,1)');
        g.addColorStop(0.4, 'rgba(255,255,255,0.6)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g; ctx.fillRect(0,0,64,64);
        return new THREE.CanvasTexture(c);
    }

    globalSmokeGeo = new THREE.BufferGeometry();
    const posArr = new Float32Array(MAX_SMOKE * 3);
    const ageArr = new Float32Array(MAX_SMOKE);
    const randArr = new Float32Array(MAX_SMOKE);
    for(let i=0; i<MAX_SMOKE; i++) {
        randArr[i] = Math.random();
        ageArr[i] = 999; 
        smokeData.push({ vel: new THREE.Vector3() });
    }
    globalSmokeGeo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
    globalSmokeGeo.setAttribute('age', new THREE.BufferAttribute(ageArr, 1));
    globalSmokeGeo.setAttribute('rand', new THREE.BufferAttribute(randArr, 1));

    globalSmokeMat = new THREE.ShaderMaterial({
        uniforms: {
            map: { value: getSmokeTex() },
            color: { value: new THREE.Color(0xaaaaaa) },
            dens: { value: 0.6 },
            sizeScale: { value: 1.0 },
            lightFactor: { value: 1.0 }
        },
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: THREE.NormalBlending,
        vertexShader: `
            attribute float age;
            attribute float rand;
            varying float vAge;
            varying float vRand;
            uniform float sizeScale;
            // 対数深度バッファ対応（04-scene-and-water-init.jsのwaterMatと同じ理由。
            // depthWrite:falseでもdepthTest:trueで船体/水面と比較するため必要）。
            // v153-fix3: EXT_frag_depthに依存しない経路のみを使う。
            #ifdef USE_LOGDEPTHBUF
                uniform float logDepthBufFC;
            #endif
            bool isPerspectiveMatrix(mat4 m) { return m[2][3] == -1.0; }
            void main() {
                vAge = age; vRand = rand;
                vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
                // Smaller, more gradual growth avoids the "blobby" look on small/slow ships
                float baseSize = (7.0 + 42.0 * age + rand * 16.0) * sizeScale;
                gl_PointSize = baseSize * (300.0 / -mvPos.z);
                gl_Position = projectionMatrix * mvPos;
                // v153-fix3: EXT_frag_depthに依存しない経路のみを使う。
                #ifdef USE_LOGDEPTHBUF
                    if (isPerspectiveMatrix(projectionMatrix)) {
                        gl_Position.z = log2(max(1e-6, gl_Position.w + 1.0)) * logDepthBufFC - 1.0;
                        gl_Position.z *= gl_Position.w;
                    }
                #endif
            }
        `,
        fragmentShader: `
            uniform sampler2D map;
            uniform vec3 color;
            uniform float dens;
            uniform float lightFactor;
            varying float vAge;
            varying float vRand;
            // v153-fix3: EXT_frag_depthに依存しない経路のみを使う。
            #ifdef USE_LOGDEPTHBUF
                uniform float logDepthBufFC;
            #endif
            void main() {
                // v153-fix3: 対数深度は頂点シェーダー側でgl_Position.zに直接
                // エンコード済み。フラグメント側で追加の書き込みは不要。
                if (vAge > 1.0) discard;
                float alpha = smoothstep(0.0, 0.08, vAge) * (1.0 - smoothstep(0.35, 1.0, vAge));
                alpha *= dens * (0.2 + 0.8 * vRand);
                vec4 tex = texture2D(map, gl_PointCoord);
                vec3 finalColor = color * lightFactor;
                gl_FragColor = vec4(finalColor, tex.a * alpha);
                #include <tonemapping_fragment>
                #include <encodings_fragment>
            }
        `
    });

    globalSmokePoints = new THREE.Points(globalSmokeGeo, globalSmokeMat);
    globalSmokeGeo.setDrawRange(0, perf.smokeCap);
    globalSmokePoints.renderOrder = 10;
    globalSmokePoints.frustumCulled = false;
    globalSmokePoints.userData.noBloom = true; // 昼間に排煙がブルームで光って見えるのを防ぐ
    scene.add(globalSmokePoints);
}

// ====================================================
//  SCREW BUBBLE SYSTEM
// ====================================================
let bubbleGeo, bubbleMat, bubblePoints;
const MAX_BUBBLES = 800;
let bubbleIdx = 0;
let bubbleData = [];
let bubbleEmitAccum = 0;

function createBubbleSystem() {
    function getBubbleTex() {
        const c = document.createElement('canvas'); c.width = 64; c.height = 64;
        const ctx = c.getContext('2d');
        const g = ctx.createRadialGradient(32,32,2, 32,32,32);
        g.addColorStop(0,   'rgba(255,255,255,1)');
        g.addColorStop(0.4, 'rgba(210,240,255,0.8)');
        g.addColorStop(0.8, 'rgba(180,220,255,0.3)');
        g.addColorStop(1,   'rgba(180,220,255,0)');
        ctx.fillStyle = g; ctx.fillRect(0,0,64,64);
        return new THREE.CanvasTexture(c);
    }

    bubbleGeo = new THREE.BufferGeometry();
    const posArr = new Float32Array(MAX_BUBBLES * 3);
    const ageArr = new Float32Array(MAX_BUBBLES);
    // 全パーティクルを最初から画面外（y=-9999）に退避
    for (let i = 0; i < MAX_BUBBLES; i++) {
        ageArr[i] = 999;
        posArr[i*3]   = 0;
        posArr[i*3+1] = -9999;
        posArr[i*3+2] = 0;
        bubbleData.push({ vx: 0, vy: 0, vz: 0, rand: Math.random() });
    }
    bubbleGeo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
    bubbleGeo.setAttribute('age',      new THREE.BufferAttribute(ageArr, 1));

    bubbleMat = new THREE.ShaderMaterial({
        // v153-fix2: WebGL2ではEXT_frag_depth拡張が存在しないため出し分ける（水面と同じ対策）。
        uniforms: { map: { value: getBubbleTex() }, sizeScale: { value: 1.0 }, lightFactor: { value: 1.0 } },
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: THREE.NormalBlending,
        vertexShader: `
            attribute float age;
            uniform float sizeScale;
            varying float vAge;
            // 対数深度バッファ対応（waterMatと同じ理由）
            // v153-fix3: EXT_frag_depthに依存しない経路のみを使う。
            #ifdef USE_LOGDEPTHBUF
                uniform float logDepthBufFC;
            #endif
            bool isPerspectiveMatrix(mat4 m) { return m[2][3] == -1.0; }
            void main() {
                vAge = age;
                if (age > 1.0) {
                    // 不活性パーティクルはクリップ空間外に追い出す
                    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
                    gl_PointSize = 0.0;
                    return;
                }
                vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
                // sizeScale: 船サイズに比例、ただし最小でも見えるサイズを確保
                float basePx = (8.0 + 30.0 * age) * max(0.4, sizeScale);
                gl_PointSize = basePx * (400.0 / -mvPos.z);
                gl_Position = projectionMatrix * mvPos;
                // v153-fix3: EXT_frag_depthに依存しない経路のみを使う。
                #ifdef USE_LOGDEPTHBUF
                    if (isPerspectiveMatrix(projectionMatrix)) {
                        gl_Position.z = log2(max(1e-6, gl_Position.w + 1.0)) * logDepthBufFC - 1.0;
                        gl_Position.z *= gl_Position.w;
                    }
                #endif
            }
        `,
        fragmentShader: `
            uniform sampler2D map;
            uniform float lightFactor;
            varying float vAge;
            // v153-fix3: EXT_frag_depthに依存しない経路のみを使う。
            #ifdef USE_LOGDEPTHBUF
                uniform float logDepthBufFC;
            #endif
            void main() {
                // v153-fix3: 対数深度は頂点シェーダー側でgl_Position.zに直接
                // エンコード済み。フラグメント側で追加の書き込みは不要。
                if (vAge > 1.0) discard;
                float alpha = smoothstep(0.0, 0.12, vAge) * (1.0 - smoothstep(0.45, 1.0, vAge)) * 0.85;
                vec4 tex = texture2D(map, gl_PointCoord);
                vec3 col = vec3(0.88, 0.96, 1.0) * lightFactor;
                gl_FragColor = vec4(col, tex.a * alpha);
                #include <tonemapping_fragment>
                #include <encodings_fragment>
            }
        `
    });

    bubblePoints = new THREE.Points(bubbleGeo, bubbleMat);
    bubblePoints.renderOrder = 11;
    bubblePoints.frustumCulled = false;
    bubblePoints.userData.noBloom = true; // 昼間にスクリューの泡がブルームで光って見えるのを防ぐ
    scene.add(bubblePoints);
}

// ====================================================
//  WAKE FOAM & SPRAY PARTICLE SYSTEM
// ====================================================
let wakeParticleGeo, wakeParticleMat, wakeParticlePoints;
const MAX_WAKE_PARTICLES = 3600; // waterline foam追加のため増量
let wakeParticleIdx = 0;
let wakeParticleData = [];
let wakeEmitAccum = 0;
let lastWakeEmitPos = null; // 前回放出した位置（距離ベースで放出制御）
// v164: foamの重い高さ計算(getWaveHeight)を間引くためのローテーション用カウンタ。
// perf.foamUpdateIntervalフレームで1周し、(i + foamFrameCounter) % interval === 0
// の粒子だけがそのフレームで再計算対象になる（毎フレーム全foamの1/interval量だけ
// 処理することで、どの粒子も平均してinterval フレームに1回は更新される）。
let foamFrameCounter = 0;

function createWakeParticleSystem() {
    function getSprayTex() {
        const c = document.createElement('canvas'); c.width = 64; c.height = 64;
        const ctx = c.getContext('2d');
        const g = ctx.createRadialGradient(32,32,1, 32,32,32);
        g.addColorStop(0,   'rgba(255,255,255,1)');
        g.addColorStop(0.3, 'rgba(220,240,255,0.85)');
        g.addColorStop(0.7, 'rgba(200,230,255,0.35)');
        g.addColorStop(1,   'rgba(200,230,255,0)');
        ctx.fillStyle = g; ctx.fillRect(0,0,64,64);
        return new THREE.CanvasTexture(c);
    }

    // 【新規】波切りスプレー(ptype=2)専用の横長ストリークテクスチャ。
    // 丸い水滴(getSprayTex)ではなく、速度方向へ引き伸ばされた「筋」に見せることで
    // 「船首が波を切り裂いて水が一枚のシートになって流れる」印象を作る。
    // 頂点シェーダーが画面空間での速度方向(vAngle)を計算し、フラグメント側で
    // gl_PointCoordをその角度分だけ回転させてこのテクスチャをサンプリングすることで、
    // 常にスプライトが自分の速度方向を向いているように見せる。
    // 【修正】以前は横長の楕円+ぼかしのみで、角度によっては「平たい筋」に見えて
    // 煙(getSmokeTex)のような立体感・ボリューム感が出にくかった。速度方向への
    // 伸び（＝水を切り裂く筋の印象）は維持しつつ、中心に煙と同系統の柔らかい
    // 放射状グラデーションのコアを重ねることで、どの角度から見ても丸みのある
    // 「3Dの水塊」らしい質感に近づけている。
    function getStreakTex() {
        const c = document.createElement('canvas'); c.width = 128; c.height = 64;
        const ctx = c.getContext('2d');
        ctx.clearRect(0, 0, 128, 64);

        // ① 外側の柔らかいハロー（横長・伸びた方向性はここで表現）
        ctx.filter = 'blur(9px)';
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.beginPath();
        ctx.ellipse(64, 32, 46, 14, 0, 0, Math.PI * 2);
        ctx.fill();

        // ② 中心に煙と同じ放射状グラデーションのコアを重ね、丸み・立体感を出す
        //    （横長のシルエットの中に丸い"塊"が入ることで、あらゆる角度で
        //     ボリュームがあるように見える）
        ctx.filter = 'none';
        const g = ctx.createRadialGradient(64, 32, 0, 64, 32, 22);
        g.addColorStop(0,    'rgba(255,255,255,1)');
        g.addColorStop(0.45, 'rgba(255,255,255,0.75)');
        g.addColorStop(1,    'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.ellipse(64, 32, 30, 18, 0, 0, Math.PI * 2);
        ctx.fill();

        // ③ さらに明るい芯（水しぶきのハイライト）
        ctx.filter = 'blur(2px)';
        ctx.fillStyle = 'rgba(255,255,255,1)';
        ctx.beginPath();
        ctx.ellipse(64, 32, 24, 6, 0, 0, Math.PI * 2);
        ctx.fill();

        return new THREE.CanvasTexture(c);
    }

    wakeParticleGeo = new THREE.BufferGeometry();
    const posArr = new Float32Array(MAX_WAKE_PARTICLES * 3);
    const ageArr = new Float32Array(MAX_WAKE_PARTICLES);
    const typeArr = new Float32Array(MAX_WAKE_PARTICLES); // 0=foam, 1=spray, 2=波切りストリーク
    // ptype=2のストリークを速度方向へ向けるための、パーティクルごとの現在速度(GPU属性)。
    // 位置と同様に animateWakeParticles() / emitHullWakeParticles() から毎フレーム書き込まれる。
    const velArr = new Float32Array(MAX_WAKE_PARTICLES * 3);
    for (let i = 0; i < MAX_WAKE_PARTICLES; i++) {
        ageArr[i] = 999;
        posArr[i*3+1] = -9999;
        // 【v98】sizeScale: そのパーティクルが生まれた瞬間の大きさ基準（重力にもこれを使い、
        // 発生時の初速と同じ基準で落ちるようにする）。spawnTime: 発生時刻(clock.getElapsedTime())。
        // 「無敵時間」判定（発生からSPLASH_COLLISION_GRACE秒は海面/船体に触れても消えない）に使う。
        wakeParticleData.push({ vx:0, vy:0, vz:0, rand: Math.random(), type: 0, sizeScale: 1, spawnTime: 0 });
    }
    wakeParticleGeo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
    wakeParticleGeo.setAttribute('age',      new THREE.BufferAttribute(ageArr, 1));
    wakeParticleGeo.setAttribute('ptype',    new THREE.BufferAttribute(typeArr, 1));
    wakeParticleGeo.setAttribute('velocity', new THREE.BufferAttribute(velArr, 3));

    wakeParticleMat = new THREE.ShaderMaterial({
        // v153-fix2: WebGL2ではEXT_frag_depth拡張が存在しないため出し分ける（水面と同じ対策）。
        uniforms: {
            map:         { value: getSprayTex() },
            mapStreak:   { value: getStreakTex() },
            sizeScale:   { value: 1.0 },
            lightFactor: { value: 1.0 },
            // 波切りストリークの画面空間回転を正しく計算するための画面アスペクト比。
            // animateWakeParticles()内で毎フレーム camera.aspect から更新される
            // （画面回転・リサイズにも自動追従）。
            uAspect:     { value: (window.innerWidth && window.innerHeight) ? (window.innerWidth / window.innerHeight) : 1.0 },
        },
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: THREE.NormalBlending,
        vertexShader: `
            attribute float age;
            attribute float ptype;
            attribute vec3 velocity;
            uniform float sizeScale;
            uniform float uAspect;
            varying float vAge;
            varying float vType;
            varying float vAngle;
            // 対数深度バッファ対応（waterMatと同じ理由）
            // v153-fix3: EXT_frag_depthに依存しない経路のみを使う。
            #ifdef USE_LOGDEPTHBUF
                uniform float logDepthBufFC;
            #endif
            bool isPerspectiveMatrix(mat4 m) { return m[2][3] == -1.0; }
            void main() {
                vAge = age; vType = ptype;
                if (age > 1.0) {
                    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
                    gl_PointSize = 0.0;
                    return;
                }
                vec4 mvPos = modelViewMatrix * vec4(position, 1.0);

                float baseSize;
                vAngle = 0.0;
                if (ptype > 1.5) {
                    // ── 波切りストリーク(ptype=2) ──
                    // 「船首が波を切り裂いて水が一枚のシートになって飛ぶ」印象のため、
                    // 画面空間での速度方向を計算し、フラグメント側でUVをその角度分
                    // 回転させてストリークテクスチャをサンプリングする。速度が速いほど
                    // 点そのものも大きくして「勢いよく流れる筋」に見せる。
                    float velLen = length(velocity);
                    vec3 velDir = velLen > 0.0001 ? (velocity / velLen) : vec3(0.0, -1.0, 0.0);
                    vec4 mvPosB  = modelViewMatrix * vec4(position + velDir * 0.5, 1.0);
                    vec4 clipA   = projectionMatrix * mvPos;
                    vec4 clipB   = projectionMatrix * mvPosB;
                    vec2 screenA = clipA.xy / max(1e-4, clipA.w);
                    vec2 screenB = clipB.xy / max(1e-4, clipB.w);
                    vec2 screenDelta = screenB - screenA;
                    screenDelta.x *= uAspect;
                    // 【安定化】画面に投影した速度ベクトルの長さがほぼ0(=カメラがほぼ
                    // 速度方向の真正面/真後ろから見ている)に近づくと、atan()の結果は
                    // ごくわずかな数値誤差にも敏感になり、視点を少し動かしただけで
                    // 角度が大きく暴れて「くるくる回って見える」原因になっていた。
                    // 投影ベクトルが短いほど回転量を0(基準向き)へ寄せることで、
                    // その不安定な領域での暴れを抑える。
                    float sdLen = length(screenDelta);
                    float angleStability = smoothstep(0.0, 0.02, sdLen);
                    vAngle = atan(screenDelta.y, screenDelta.x) * angleStability;

                    // 【v75で再修正】旧clamp上限260は「400/距離」の式と組み合わさると
                    // 通常の観覧距離(10〜100程度)でも要求サイズが千〜万px単位になり、
                    // 結局どこかでclampされる状況は変わらなかった。上限そのものを
                    // 現実的な範囲に縮小（260→60）。
                    // 【バグ修正】直前の編集でここのサイズ計算式そのものを誤って削除して
                    // しまっており、baseSizeが未初期化のままclampされ、速度・経過時間に
                    // 関係なく常に最小値(4.0)付近に固定されていた。これが「近くで見ると
                    // しぶきが小さい」の直接の原因だったため、計算式を復元する。
                    baseSize = (5.0 + velLen * 22.0) * (1.0 - 0.4 * age) * max(0.4, sizeScale);
                    baseSize = clamp(baseSize, 4.0, 60.0);
                } else if (ptype > 0.5) {
                    baseSize = (3.0 + 6.0 * (1.0 - age)) * max(0.4, sizeScale);  // spray: 小さめ
                } else {
                    baseSize = (6.0 + 15.0 * age) * max(0.4, sizeScale);         // foam: やや小さめ
                }
                // 【v74での対策が裏目に出た点の修正】
                // 前回、「船首に近いカメラだと-mvPos.zが小さくなり要求サイズが
                // 数千pxに達し、GPU任せのclampが端末ごとにバラバラになる」問題への
                // 対策として、掛け算した後の最終ピクセル値を固定上限(maxPointPx)で
                // clampしていた。しかしこれは「距離に関係なく常に同じ最大pxで頭打ち」
                // になるため、本来は距離に応じて滑らかに変化するはずの見た目が壊れ、
                // 「間近で見ると(本来ならもっと大きいはずが)頭打ちで小さく見え、
                // 遠くから見ると(他の全てが遠近法で小さくなる中)一定pxのまま浮いて
                // 相対的に大きく見える」という、まさに今回報告された症状の原因になって
                // いた。
                // → 掛け算後の固定pxクランプは撤去し、代わりに「割り算する距離
                //   (-mvPos.z)側」に小さな下限(MIN_DIST)を設けることで対応。これなら
                //   通常の観覧距離では式は今まで通り連続的に(近いほど大きく・遠いほど
                //   小さく)動作し、カメラが粒子に極端に近づいた場合(ほぼ0距離)にだけ
                //   サイズの発散を防ぐ。baseSize自体の上限も現実的な値に下げたため、
                //   最終pxが数百pxを超えることは通常ほぼ無い。念のための保険として、
                //   本当に異常な値だけを弾く緩いセーフティネット(500px)だけ残す。
                const float MIN_DIST = 3.0;
                float requestedSize = baseSize * (400.0 / max(-mvPos.z, MIN_DIST));
                gl_PointSize = min(requestedSize, 500.0);
                // 【対策】しぶきの発生点は船体表面や海面すれすれのことが多く、視点に
                // よっては発生点そのものだけがわずかに船体/海面の裏側に回り込み、
                // depthTestでスプライト全体が丸ごと消えてしまうことがあった
                // （＝「タイミングで完全に船体や海面に隠れて見えなくなる」）。
                // 視点(カメラ原点)からその点へ向かうレイに沿って、画面上の位置
                // (x/w, y/w)を変えずにごく僅かだけ手前へ引き寄せることで、この
                // 消失を緩和する。sizeの計算には影響しないよう、この処理は
                // sizeを求めた後にだけ行う。
                vec4 mvPosDepthBiased = vec4(mvPos.xyz * 0.985, 1.0);
                gl_Position = projectionMatrix * mvPosDepthBiased;
                // v153-fix3: EXT_frag_depthに依存しない経路のみを使う。
                #ifdef USE_LOGDEPTHBUF
                    if (isPerspectiveMatrix(projectionMatrix)) {
                        gl_Position.z = log2(max(1e-6, gl_Position.w + 1.0)) * logDepthBufFC - 1.0;
                        gl_Position.z *= gl_Position.w;
                    }
                #endif
            }
        `,
        fragmentShader: `
            uniform sampler2D map;
            uniform sampler2D mapStreak;
            uniform float lightFactor;
            varying float vAge;
            varying float vType;
            varying float vAngle;
            // v153-fix3: EXT_frag_depthに依存しない経路のみを使う。
            #ifdef USE_LOGDEPTHBUF
                uniform float logDepthBufFC;
            #endif
            void main() {
                // v153-fix3: 対数深度は頂点シェーダー側でgl_Position.zに直接
                // エンコード済み。フラグメント側で追加の書き込みは不要。
                if (vAge > 1.0) discard;
                float alpha;
                vec4 tex;
                if (vType > 1.5) {
                    // 波切りストリーク: 速度方向へ回転させたUVでストリークテクスチャをサンプリング
                    vec2 uv = gl_PointCoord - vec2(0.5);
                    float s = sin(vAngle), co = cos(vAngle);
                    uv = vec2(uv.x * co - uv.y * s, uv.x * s + uv.y * co) + vec2(0.5);
                    tex = texture2D(mapStreak, uv);
                    // 波を切り裂いた瞬間は明るく強く、通常のスプレーよりわずかに長く尾を引く
                    alpha = (1.0 - smoothstep(0.0, 0.9, vAge)) * 0.85;
                } else if (vType > 0.5) {
                    // spray: 素早くフェードアウト
                    tex = texture2D(map, gl_PointCoord);
                    alpha = (1.0 - smoothstep(0.0, 1.0, vAge)) * 0.7;
                } else {
                    // foam: じわっと広がってからゆっくりフェード
                    tex = texture2D(map, gl_PointCoord);
                    alpha = smoothstep(0.0, 0.15, vAge) * (1.0 - smoothstep(0.5, 1.0, vAge)) * 0.6;
                }
                vec3 col = vec3(0.9, 0.97, 1.0) * lightFactor;
                gl_FragColor = vec4(col, tex.a * alpha);
                #include <tonemapping_fragment>
                #include <encodings_fragment>
            }
        `
    });

    wakeParticlePoints = new THREE.Points(wakeParticleGeo, wakeParticleMat);
    wakeParticlePoints.renderOrder = 12;
    wakeParticlePoints.frustumCulled = false;
    wakeParticlePoints.userData.noBloom = true; // 昼間に引き波がブルームで光って見えるのを防ぐ
    scene.add(wakeParticlePoints);
}

// 【v98】水しぶき(spray/波切りストリーク)が発生してから、海面・船体に触れても
// まだ消えない「無敵時間」（秒）。発生直後に船体すれすれ・波すれすれから
// 飛び出すこと自体は多いため、この猶予が無いと生まれた瞬間に消えてしまう。
const SPLASH_COLLISION_GRACE = 1.0;

function animateWakeParticles(t, dt) {
    if (!wakeParticleGeo) return;
    const posAttr = wakeParticleGeo.attributes.position;
    const ageAttr = wakeParticleGeo.attributes.age;
    const typeAttr = wakeParticleGeo.attributes.ptype;
    const velAttr = wakeParticleGeo.attributes.velocity;

    const spd = Math.abs(physics.speed);
    const sizeScale = THREE.MathUtils.clamp(physics.scale / 22.0, 0.3, 5.0);
    wakeParticleMat.uniforms.sizeScale.value = sizeScale;
    // 波切りストリーク(ptype=2)の画面空間回転をカメラの現在のアスペクト比に追従させる
    // （リサイズ・端末回転時も自動的に正しい向きになる）
    if (typeof camera !== 'undefined' && camera && camera.aspect) {
        wakeParticleMat.uniforms.uAspect.value = camera.aspect;
    }
    const waterSurface = 0.0; // フォールバック（波面取得できない場合）
    // 船体回避マージン：パーティクル半径相当ぶん外側に余白を持たせる
    const hullAvoidMargin = sizeScale * 0.12;
    const canAvoidHull = (typeof pushOutsideHull === 'function')
        && window.hullProfile && window.hullProfile.ready;

    // v107: foam(type0)は毎フレーム getWaveHeight(引き波込み) で水面高さに追従
    // させるが、getWaveHeight は内部で getWakeHeight(shipHistory走査、比較的
    // 重い) を呼ぶ。船からずっと離れて漂流したfoamは、そもそも引き波の
    // 届く範囲(getWakeHeightのmaxDist、02-utils-and-wave-physics.js側の
    // 計算式と同じ)の外にあるはずなので、そこでは軽量な getWaveCrestAndHeight
    // (通常波のみ)にフォールバックしてよい。船の現在位置からの距離だけを
    // 使う簡易フィルタ（正確な判定はgetWaveHeight/getWakeHeight内部の
    // shipHistory各点基準のものだが、船の現在位置基準の方が広め＝安全側になる
    // ため事前フィルタとして十分）。
    const wakeScaleRatio = (physics.scale || 1) / 12.0;
    const wakeReachDist = Math.sqrt(8000.0 * wakeScaleRatio * wakeScaleRatio) + 6.0 * (physics.scale || 1);
    const wakeReachDist2 = wakeReachDist * wakeReachDist;
    const shipCX = physics.cgWorldX || 0, shipCZ = physics.cgWorldZ || 0;

    // 既存パーティクルを更新
    for (let i = 0; i < MAX_WAKE_PARTICLES; i++) {
        if (ageAttr.array[i] > 1.0) continue;
        const d = wakeParticleData[i];
        // 【バグ修正】以前は `d.type === 1` だけをスプレー(重力あり・自由弾道)として扱い、
        // それ以外(=0のfoamだけでなく、新設した2の波切りストリークまで)を
        // 「foam=水面に張り付いてフロートする」挙動にしてしまっていた。
        // このため波切りストリーク(ptype=2)は重力放物線を描かず発生直後に水面へ
        // クランプされ、狙った「勢いよく飛び散るシート」に見えなかった。
        // → foam(=0)だけを水面フロート扱いにし、spray(1)と波切りストリーク(2)は
        //   どちらも重力を受けて自由に飛ぶ弾道運動に統一する。
        const isBallistic = d.type !== 0;
        // v95: 「引き波をもっと長持ちさせて」の要望で、水面に張り付く泡(foam=type0、
        // 引き波の帯そのもの)だけ寿命を約3倍に伸ばす(0.14→0.047)。spray(1)・
        // 波切りストリーク(2)は勢いよく飛び散って落ちる一瞬の水しぶきなので、
        // 「長持ち」の対象ではなく従来のまま。
        ageAttr.array[i] += dt * (d.type === 0 ? 0.047 : (d.type === 2 ? 0.55 : 0.75)) * (0.8 + d.rand * 0.4);
        if (isBallistic) {
            // spray / 波切りストリーク は上昇後に重力で落ちる弾道運動。
            // 波切りストリークは「水の重いシート」を表現するため、通常スプレーより
            // やや強めの重力を与えて勢いよく飛び、素早く落ちる弾道にする。
            // 【v98修正】以前はここで毎フレーム再計算した sizeScale
            // (physics.scale/22を基準)を使っていたが、これは発生元
            // (emitHullWakeParticles側)が初速の計算に使っていた sizeScale
            // (船体ローカル形状基準、physics.scaleを含まない別の式)と
            // 一致していなかった。船が大きい/小さいと両者のズレが大きくなり、
            // 「初速の勢いに対して重力が強すぎ/弱すぎ」に見え、水しぶきの
            // 弾道が不自然（一瞬で落ちる、逆にふわふわ浮いたまま落ちない等）に
            // なる原因になっていた。→ 発生時に記録した d.sizeScale（=その粒子の
            // 初速を決めた時と同じ基準）を重力にも使い、常に同じスケール基準で
            // 「初速で飛び、重力で落ちる」が一貫するようにする。
            const gravScale = (d.sizeScale || sizeScale);
            d.vy -= (d.type === 2 ? 3.6 : 3.0) * gravScale * dt;
        } else {
            // foam: その場所の実際の波面高さに追従
            // v107: 引き波エフェクト自体が、通常の海洋波(swell/chop)だけでなく
            // 船が作っている引き波(wake)の盛り上がりの上にも乗るようにする。
            // 従来は getWaveCrestAndHeight (=通常波のみ) を使っており、
            // 引き波の帯のすぐ上にいるfoamでも本来の水面の高さに落ち着いて
            // しまい、盛り上がった引き波から浮いて見える/沈んで見える不整合が
            // あった。getWaveHeight は通常波+引き波を合成して返す。
            // ただし船から遠く離れて漂流したfoamは引き波の届く範囲外のはず
            // なので、そこでは軽量な getWaveCrestAndHeight にフォールバックし、
            // 全foam粒子ぶん毎フレーム重い引き波計算を走らせるのを避ける。
            //
            // v164: 上記の距離フィルタだけでは「引き波が長時間出続ける」場合に
            // 効かない（帯の範囲内にいる限りずっと重い経路を通る）。getWaveHeight
            // は shipHistory を毎回全件走査するため、生存中のfoam数×history長に
            // 比例してコストが増え、これが「引き波が出始めると重くなる」の主因
            // だった。ここでは通常波(getWaveCrestAndHeight、historyを見ないので
            // 軽い)は毎フレーム呼びつつ、"引き波による上乗せ分"だけを
            // perf.foamUpdateInterval フレームに1回だけ再計算してキャッシュする
            // （波の盛り上がりはゆっくり変化するため、数フレーム古い値を使っても
            // 見た目にはほぼ気付かれない）。通常波には毎フレーム追従するので、
            // 上下動が止まって見えることもない。
            const px = posAttr.array[i*3], pz = posAttr.array[i*3+2];
            const distToShip2 = (px - shipCX) * (px - shipCX) + (pz - shipCZ) * (pz - shipCZ);
            const baseSurface = (typeof getWaveCrestAndHeight === 'function')
                ? getWaveCrestAndHeight(px, pz, t).height : waterSurface;
            const inWakeRange = distToShip2 <= wakeReachDist2 && typeof getWaveHeight === 'function';
            const interval = Math.max(1, perf.foamUpdateInterval || 1);
            const dueForUpdate = ((i + foamFrameCounter) % interval) === 0;
            if (inWakeRange && (dueForUpdate || d.wakeBonus === undefined)) {
                // getWaveHeight = 通常波+引き波の合成値なので、引き波だけの
                // 上乗せ分を差分として抽出してキャッシュする。
                d.wakeBonus = getWaveHeight(px, pz, t, false) - baseSurface;
            } else if (!inWakeRange) {
                d.wakeBonus = 0;
            }
            // dueForUpdate=falseかつ範囲内の場合は、前回キャッシュしたwakeBonusを
            // そのまま使い回す（= getWaveHeightの再計算をスキップ）。
            const localSurface = baseSurface + (d.wakeBonus || 0);
            const py = posAttr.array[i*3+1];
            if (py < localSurface) d.vy += (0.5 * sizeScale - d.vy) * 3.0 * dt;
            else d.vy *= Math.pow(0.05, dt);
            posAttr.array[i*3]   += d.vx * dt;
            posAttr.array[i*3+1] += d.vy * dt;
            posAttr.array[i*3+2] += d.vz * dt;
            // foam は波面+わずか上でクランプ
            posAttr.array[i*3+1] = Math.min(posAttr.array[i*3+1], localSurface + 0.3 * sizeScale);
            velAttr.array[i*3]   = d.vx;
            velAttr.array[i*3+1] = d.vy;
            velAttr.array[i*3+2] = d.vz;
            // 船体回避：foamは常に水面付近にいるため毎フレームチェックして良い
            if (canAvoidHull) {
                const corrected = pushOutsideHull(posAttr.array[i*3], posAttr.array[i*3+2], hullAvoidMargin);
                if (corrected.pushed) {
                    posAttr.array[i*3]   = corrected.x;
                    posAttr.array[i*3+2] = corrected.z;
                }
            }
            continue;
        }
        posAttr.array[i*3]   += d.vx * dt;
        posAttr.array[i*3+1] += d.vy * dt;
        posAttr.array[i*3+2] += d.vz * dt;
        velAttr.array[i*3]   = d.vx;
        velAttr.array[i*3+1] = d.vy;
        velAttr.array[i*3+2] = d.vz;

        // 【v98新規】水しぶき(spray/波切りストリーク)の当たり判定つき消滅。
        // 発生から SPLASH_COLLISION_GRACE 秒（無敵時間）が経過した後、実際に
        // 海面 or 船体に触れた瞬間、その場で消滅させる（それまでは寿命(age)
        // 任せでフェードアウトしていたため、「海に着水したはずなのに宙で
        // 消える／水面下に沈み込んだまま漂う」ように見えることがあった）。
        // 無敵時間中は従来通り「船体の外へ押し出す」対応だけに留め、生まれた
        // 直後に船体すれすれ・波すれすれから飛び出しても消えないようにする。
        const elapsedSinceSpawn = t - (d.spawnTime || 0);
        const px = posAttr.array[i*3], pz = posAttr.array[i*3+2], py = posAttr.array[i*3+1];

        if (elapsedSinceSpawn >= SPLASH_COLLISION_GRACE) {
            const localSurface = (typeof getWaveCrestAndHeight === 'function')
                ? getWaveCrestAndHeight(px, pz, t).height : waterSurface;
            if (py <= localSurface) {
                // 海面に着水した瞬間に消滅（水しぶきが海へ還った表現）
                ageAttr.array[i] = 999;
                continue;
            }
            if (canAvoidHull) {
                const hit = pushOutsideHull(px, pz, hullAvoidMargin);
                if (hit.pushed) {
                    // 船体に触れた瞬間に消滅
                    ageAttr.array[i] = 999;
                    continue;
                }
            }
        } else if (canAvoidHull) {
            // 無敵時間中：消滅させず、従来通り船体の外へ押し出すだけ
            const corrected = pushOutsideHull(px, pz, hullAvoidMargin);
            if (corrected.pushed) {
                posAttr.array[i*3]   = corrected.x;
                posAttr.array[i*3+2] = corrected.z;
            }
        }
    }
    // v164: foamの高さ計算間引き用ローテーションカウンタを進める。
    // ループ内の判定式 (i + foamFrameCounter) % interval を毎フレーム変化させる
    // ことで、「常に同じインデックスだけ更新されない」偏りを防ぎ、interval
    // フレームかけて全foamが一巡するようにする。
    foamFrameCounter = (foamFrameCounter + 1) % 997; // 997=適当な大きい素数（オーバーフロー防止、周期性回避）

    // 18-hull-wake-physics.js の emitHullWakeParticles が有効なら
    // こちらの旧放出ロジックはスキップ（二重放出を防ぐ）
    if (window.hullWakeEmitterActive) {
        posAttr.needsUpdate = true;
        ageAttr.needsUpdate = true;
        velAttr.needsUpdate = true;
        return;
    }

    // 船が動いているとき、船首・船尾から放出
    if (spd < 0.5 || shipHistory.length < 2) {
        wakeEmitAccum = 0;
        posAttr.needsUpdate = true;
        ageAttr.needsUpdate = true;
        velAttr.needsUpdate = true;
        return;
    }

    const rotY = (physics.heading * Math.PI) / 180;
    const sinH = Math.sin(rotY), cosH = Math.cos(rotY);
    const shipLen = physics.scale; // 半長（front/back offset）
    const cx = physics.cgWorldX, cz = physics.cgWorldZ;

    // 船首（前方）と船尾（後方）の位置
    const bowX = cx + sinH * shipLen * 0.45;
    const bowZ = cz + cosH * shipLen * 0.45;
    const sternX = cx - sinH * shipLen * 0.45;
    const sternZ = cz - cosH * shipLen * 0.45;

    // 距離ベースで放出レートを制御（速いほど密に）
    const emitRate = spd * 4.0;
    wakeEmitAccum += emitRate * dt;

    const shipVx = sinH * physics.speed * 0.514;
    const shipVz = cosH * physics.speed * 0.514;
    const spdFactor = Math.min(spd / 5.0, 1.0);

    while (wakeEmitAccum >= 1) {
        wakeEmitAccum -= 1;
        const isBow = Math.random() < 0.6; // 船首多め
        const srcX = isBow ? bowX : sternX;
        const srcZ = isBow ? bowZ : sternZ;

        // foam か spray かをランダムに（船首は spray 多め）
        const isSpray = isBow && Math.random() < 0.45 * spdFactor;

        // 左右にランダムに広がる横方向
        let sideT = (Math.random() - 0.5) * 2.0 * sizeScale;
        if (isSpray) {
            // 船首の水しぶきは船体（船首太さ）に隠れないよう、
            // 太さに応じて両舷側へさらに広がるよう外側へオフセットする
            const bowHalfWidth = sizeScale * physics.bowFullness * 1.2;
            const outwardSign = sideT >= 0 ? 1 : -1;
            sideT = outwardSign * (bowHalfWidth + Math.abs(sideT));
        }
        const emitX = srcX + cosH * sideT + (Math.random()-0.5) * sizeScale * 0.5;
        const emitZ = srcZ - sinH * sideT + (Math.random()-0.5) * sizeScale * 0.5;

        const ii = wakeParticleIdx;

        posAttr.array[ii*3]   = emitX;
        // その地点の実際の波面高さ（海面と船体の境目）
        const emitSurface = (typeof getWaveCrestAndHeight === 'function')
            ? getWaveCrestAndHeight(emitX, emitZ, t).height
            : waterSurface;
        posAttr.array[ii*3+1] = emitSurface + (isSpray ? sizeScale * 0.1 : 0);
        posAttr.array[ii*3+2] = emitZ;
        ageAttr.array[ii] = 0;
        typeAttr.array[ii] = isSpray ? 1 : 0;
        // 【v98】発生時刻と、発生時の初速に使ったsizeScaleを記録
        // （重力・無敵時間つき当たり判定の基準として使う）
        wakeParticleData[ii].spawnTime = t;
        wakeParticleData[ii].sizeScale = sizeScale;

        const sideVx = cosH * (Math.random()-0.5) * spd * 0.3 * sizeScale;
        const sideVz = -sinH * (Math.random()-0.5) * spd * 0.3 * sizeScale;

        if (isSpray) {
            // 水しぶき：上向き＋船の後ろへ＋船体の外側へ広がる
            const outwardVx = cosH * Math.sign(sideT) * (0.3 + 0.4 * spdFactor) * sizeScale;
            const outwardVz = -sinH * Math.sign(sideT) * (0.3 + 0.4 * spdFactor) * sizeScale;
            wakeParticleData[ii].vx = shipVx * 0.2 + sideVx + outwardVx;
            wakeParticleData[ii].vy = (0.8 + Math.random() * 1.5) * sizeScale * spdFactor;
            wakeParticleData[ii].vz = shipVz * 0.2 + sideVz + outwardVz;
        } else {
            // 泡（foam）：ほぼ水平、船の後ろへゆっくり流れる
            wakeParticleData[ii].vx = shipVx * 0.15 + sideVx * 0.6;
            wakeParticleData[ii].vy = 0.05 * sizeScale;
            wakeParticleData[ii].vz = shipVz * 0.15 + sideVz * 0.6;
        }
        velAttr.array[ii*3]   = wakeParticleData[ii].vx;
        velAttr.array[ii*3+1] = wakeParticleData[ii].vy;
        velAttr.array[ii*3+2] = wakeParticleData[ii].vz;
        wakeParticleData[ii].rand = Math.random();
        wakeParticleData[ii].type = isSpray ? 1 : 0;
        // v164: リングバッファ再利用時の古いwakeBonusキャッシュ引き継ぎ防止
        // （animateWakeParticles冒頭のfoam処理、および他2箇所の生成経路と同じ理由）。
        wakeParticleData[ii].wakeBonus = undefined;

        wakeParticleIdx = (wakeParticleIdx + 1) % MAX_WAKE_PARTICLES;
    }

    posAttr.needsUpdate = true;
    ageAttr.needsUpdate = true;
    typeAttr.needsUpdate = true;
    velAttr.needsUpdate = true;
}

// 組み込みpropulsors用の疑似回転角（GLBパーツのpart.spinに相当するものが無いため自前で積算）
let builtinPropSpin = 0;

function animateBubbles(t, dt) {
    if (!bubbleGeo || !shipGroup) return;
    const posAttr = bubbleGeo.attributes.position;
    const ageAttr = bubbleGeo.attributes.age;

    const spd = Math.abs(physics.speed);
    const sizeScale = THREE.MathUtils.clamp(physics.scale / 22.0, 0.3, 6.0);
    bubbleMat.uniforms.sizeScale.value = sizeScale;

    // 水面高さ（簡易：Y=0付近が水面）
    const waterSurface = 0.0;
    const riseSpeed = 1.2 * sizeScale; // 水面へ浮上する速度
    builtinPropSpin += physics.speed * 0.15 * dt; // animatePropellers内のpropMeshes回転と同じ角速度
    // 船体回避：気泡は深いところ（スクリュー付近、船底の下）にいる間は
    // 船体footprint判定の対象外とし、従来通りまっすぐ浮上させる
    // （半幅モデルが船体の上下方向の形状を持たないため、深い場所で適用すると
    // キール下の何もない開けた水中まで「船体内部」と誤判定してしまうため）。
    // 水面に近づいた最後の一瞬だけ、船体に重ならないよう側方へ押し出す。
    const hullAvoidBand   = sizeScale * 1.5;
    const hullAvoidMargin = sizeScale * 0.12;
    const canAvoidHull = (typeof pushOutsideHull === 'function')
        && window.hullProfile && window.hullProfile.ready;

    // Age & move existing particles
    for (let i = 0; i < MAX_BUBBLES; i++) {
        if (ageAttr.array[i] <= 1.0) {
            ageAttr.array[i] += dt * (0.45 + bubbleData[i].rand * 0.3);
            const py = posAttr.array[i*3+1];
            // 水面より下にいる間は上向きに加速、水面に近づいたら速度を絞る
            if (py < waterSurface - 0.3) {
                bubbleData[i].vy += (riseSpeed - bubbleData[i].vy) * 4.0 * dt;
            } else {
                // 水面に到達したら横に広がりながらゆっくりフェード
                bubbleData[i].vy *= Math.pow(0.15, dt);
            }
            posAttr.array[i*3]   += bubbleData[i].vx * dt;
            // 水面を超えて浮上しないようクランプ（船に置き去りにされて水上に浮いて見えるのを防ぐ）
            posAttr.array[i*3+1] = Math.min(py + bubbleData[i].vy * dt, waterSurface);
            posAttr.array[i*3+2] += bubbleData[i].vz * dt;

            if (canAvoidHull && posAttr.array[i*3+1] > waterSurface - hullAvoidBand) {
                const corrected = pushOutsideHull(posAttr.array[i*3], posAttr.array[i*3+2], hullAvoidMargin);
                if (corrected.pushed) {
                    posAttr.array[i*3]   = corrected.x;
                    posAttr.array[i*3+2] = corrected.z;
                }
            }
        }
    }

    // 放出源を集める: 組み込みpropulsors ＋ GLBスクリューパーツ
    // center: 軸のワールド座標, axisDir: 回転軸のワールド方向(単位ベクトル), bladeRadius: 羽根半径, angle: 現在の回転角
    const emitSources = []; // { center, axisDir, bladeRadius, angle, dir }

    if (spd > 0.2) {
        // 組み込み推進器
        if (propulsors && propulsors.length > 0) {
            const sym = $('prop-symmetry') && $('prop-symmetry').checked;
            // propMeshesの回転はローカルZ軸周り。ワールド方向はshipGroupの回転を適用して求める。
            const localAxis = new THREE.Vector3(0, 0, 1);
            const worldAxis = localAxis.clone().transformDirection(shipGroup.matrixWorld).normalize();
            const bladeRadius = Math.max(0.5, physics.scale / 22.0) * 1.1; // propサイズに対する目安半径

            propulsors.forEach(p => {
                const lp = new THREE.Vector3(p.x, p.y, p.z);
                const wp = lp.applyMatrix4(shipGroup.matrixWorld);
                // 水面より上にあるスクリューからは泡を出さない
                if (wp.y > 0.0) return;
                emitSources.push({
                    center: wp, axisDir: worldAxis,
                    bladeRadius: bladeRadius * Math.max(0.5, p.size),
                    angle: builtinPropSpin * (p.dir || 1),
                    dir: p.dir || 1
                });
                // 対称側
                if (sym && Math.abs(p.x) > 0.05) {
                    const lp2 = new THREE.Vector3(-p.x, p.y, p.z);
                    const wp2 = lp2.applyMatrix4(shipGroup.matrixWorld);
                    if (wp2.y > 0.0) return;
                    emitSources.push({
                        center: wp2, axisDir: worldAxis,
                        bladeRadius: bladeRadius * Math.max(0.5, p.size),
                        angle: builtinPropSpin * -(p.dir || 1),
                        dir: -(p.dir || 1)
                    });
                }
            });
        }

        // GLBスクリューパーツ
        if (glbMovableParts && glbMovableParts.length > 0) {
            glbMovableParts.forEach(part => {
                if (part.key !== 'screw' && part.key !== 'paddle') return;
                if (part.disabled) return;
                const obj = part.object;
                if (!obj) return;
                obj.updateMatrixWorld(true);
                // 回転軸のワールド中心位置を取得
                const worldPos = new THREE.Vector3();
                obj.getWorldPosition(worldPos);
                // 水面より上にあるスクリューからは泡を出さない
                if (worldPos.y > 0.0) return;

                const axis = part.spinAxis || 'x';
                const localAxis = new THREE.Vector3(
                    axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0
                );
                const worldAxis = localAxis.transformDirection(obj.parent ? obj.parent.matrixWorld : shipGroup.matrixWorld).normalize();

                // 羽根半径をバウンディングボックスから推定
                if (part._bladeRadius === undefined) {
                    const box = new THREE.Box3().setFromObject(obj);
                    const size = new THREE.Vector3();
                    box.getSize(size);
                    // 回転軸に垂直な2成分の最大値の半分を半径とする
                    const dims = [size.x, size.y, size.z];
                    dims[axis === 'x' ? 0 : axis === 'y' ? 1 : 2] = 0;
                    part._bladeRadius = Math.max(0.3, Math.max(...dims) * 0.5);
                }

                emitSources.push({
                    center: worldPos, axisDir: worldAxis,
                    bladeRadius: part._bladeRadius,
                    angle: part.spin || 0,
                    dir: part.invert ? -1 : 1
                });
            });
        }
    }

    if (emitSources.length > 0) {
        // 密度を下げる（従来比で放出レートを抑える）
        const emitRate = (0.6 + spd * 1.1) * emitSources.length;
        bubbleEmitAccum += emitRate * dt;

        const rotY = (physics.heading * Math.PI) / 180;
        const dirSign = physics.speed >= 0 ? -1 : 1;
        const shipVx = Math.sin(rotY) * physics.speed * 0.514;
        const shipVz = Math.cos(rotY) * physics.speed * 0.514;

        // axisDirに垂直な基底ベクトルを1本作るための仮の"up"
        const tmpUp = new THREE.Vector3(0, 1, 0);

        while (bubbleEmitAccum >= 1) {
            bubbleEmitAccum -= 1;
            const src = emitSources[Math.floor(Math.random() * emitSources.length)];
            const i = bubbleIdx;

            // 回転軸に垂直な基底ベクトル(e1, e2)を作り、羽根先端の位置を求める
            let e1 = new THREE.Vector3().crossVectors(tmpUp, src.axisDir);
            if (e1.lengthSq() < 1e-6) e1.set(1, 0, 0).cross(src.axisDir); // axisDirがY軸とほぼ平行な場合の保険
            e1.normalize();
            const e2 = new THREE.Vector3().crossVectors(src.axisDir, e1).normalize();

            // 羽根の枚数ぶんの位相のうちランダムに1枚を選び、回転角+その位相で先端位置を決める
            // → 螺旋状に見えるよう、毎回わずかに角度を進めた位置から放出する
            const bladeCount = 4;
            const bladePhase = (Math.floor(Math.random() * bladeCount) / bladeCount) * Math.PI * 2;
            const ang = src.angle + bladePhase;
            const tipX = Math.cos(ang) * src.bladeRadius;
            const tipY = Math.sin(ang) * src.bladeRadius;

            const emitPos = src.center.clone()
                .addScaledVector(e1, tipX)
                .addScaledVector(e2, tipY);

            posAttr.array[i*3]   = emitPos.x;
            posAttr.array[i*3+1] = emitPos.y;   // 最初はスクリューの深さから出発
            posAttr.array[i*3+2] = emitPos.z;
            ageAttr.array[i] = 0;

            // 螺旋の接線方向（回転方向）の初速を与え、渦を巻きながら後方へ流れるようにする
            const tangent = new THREE.Vector3()
                .addScaledVector(e1, -Math.sin(ang))
                .addScaledVector(e2,  Math.cos(ang))
                .multiplyScalar(src.dir * sizeScale * 0.6);

            const swirlX =  Math.cos(rotY) * src.dir * sizeScale * 0.3 + tangent.x;
            const swirlZ = -Math.sin(rotY) * src.dir * sizeScale * 0.3 + tangent.z;
            bubbleData[i].vx = shipVx * 0.3 + dirSign * Math.sin(rotY) * spd * 0.2 * sizeScale + swirlX;
            bubbleData[i].vy = 0.1 * sizeScale + tangent.y * 0.3; // 最初は遅め、浮力ループが加速させる
            bubbleData[i].vz = shipVz * 0.3 + dirSign * Math.cos(rotY) * spd * 0.2 * sizeScale + swirlZ;
            bubbleData[i].rand = Math.random();

            bubbleIdx = (bubbleIdx + 1) % MAX_BUBBLES;
        }
    } else {
        bubbleEmitAccum = 0;
    }

    posAttr.needsUpdate = true;
    ageAttr.needsUpdate = true;
}


