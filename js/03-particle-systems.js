// 煙・しぶき・スクリューの泡に掛ける霧（船体と同じ FogExp2）。
// 以前はこれらの粒子だけ霧を受けず、濃い霧の中でも船体は霞むのに、
// しぶきや泡・排煙だけがくっきり見えていた。3つの粒子で同じ値を共有し、
// 描画の直前に scene.fog から写す（17-main-loop.js）。
const particleFogUniforms = {
    uFogColor:   { value: new THREE.Color(0, 0, 0) },
    uFogDensity: { value: 0 },
};
// ----------------------------------------------------
// GLOBAL SMOKE SYSTEM VARIABLES (WORLD SPACE)
// ----------------------------------------------------
let globalSmokeGeo, globalSmokeMat, globalSmokePoints;
// 画面の解像度による点の大きさの補正。点の大きさ（gl_PointSize）は描画の画素の数なので、
// 「画質」（内部解像度）を下げると同じ数の画素が画面の大きな割合になり、排煙・しぶきが大きく見えていた。
// その端末のいちばん高い画質（内部解像度の倍率＝devicePixelRatio、2 まで）での見た目を基準にし、
// 画質を下げても画面に対する大きさが変わらないようにする
function particleResK() {
    // （以前は描画の画面の高さ（clientHeight）を毎回読んでいて、そのたびに画面の配置の計算が走り重かった。
    //   内部解像度の倍率は renderer がそのまま持っている）
    const pr = (typeof renderer !== 'undefined' && renderer && renderer.getPixelRatio) ? renderer.getPixelRatio() : 1;
    const full = Math.min(2, window.devicePixelRatio || 1);          // この端末の「高」の倍率
    return Math.max(0.2, Math.min(2, pr / full));
}
window.particleResK = particleResK;
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
            uResK: { value: 1.0 },
            lightFactor: { value: 1.0 },
            uFogColor: particleFogUniforms.uFogColor,
            uFogDensity: particleFogUniforms.uFogDensity,
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
            uniform float uResK;
            // 対数深度バッファ対応（04-scene-and-water-init.jsのwaterMatと同じ理由。
            // depthWrite:falseでもdepthTest:trueで船体/水面と比較するため必要）。
            // v153-fix3: EXT_frag_depthに依存しない経路のみを使う。
            #ifdef USE_LOGDEPTHBUF
                uniform float logDepthBufFC;
            #endif
            varying float vFogDist;
            bool isPerspectiveMatrix(mat4 m) { return m[2][3] == -1.0; }
            varying float vNear;
            void main() {
                vAge = age; vRand = rand;
                // 消えた粒（age > 1）は描かない。以前は大きさが age に比例したまま
                // （不活性は age=999）画面いっぱいの点として毎回塗られ、全部の画素を
                // 捨てていたので、煙だけで描画時間の大半を使っていた。
                if (age > 1.0) { vNear = 0.0; vFogDist = 0.0; gl_PointSize = 0.0; gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
                vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
                vFogDist = -mvPos.z;
                // Smaller, more gradual growth avoids the "blobby" look on small/slow ships
                float baseSize = (7.0 + 42.0 * age + rand * 16.0) * sizeScale;
                float ps = baseSize * (300.0 / max(0.01, -mvPos.z));
                // カメラのすぐ近くの煙は画面を大きく覆うだけで重いので、大きくなるほど薄くして上限で止める
                vNear = 1.0 - smoothstep(260.0, 520.0, ps);
                gl_PointSize = min(ps, 520.0) * uResK;          // 解像度の補正（画質で大きさが変わらないように）
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
            uniform vec3 uFogColor;
            uniform float uFogDensity;
            varying float vFogDist;
            varying float vAge;
            varying float vRand;
            varying float vNear;
            // v153-fix3: EXT_frag_depthに依存しない経路のみを使う。
            #ifdef USE_LOGDEPTHBUF
                uniform float logDepthBufFC;
            #endif
            void main() {
                // v153-fix3: 対数深度は頂点シェーダー側でgl_Position.zに直接
                // エンコード済み。フラグメント側で追加の書き込みは不要。
                if (vAge > 1.0 || vNear <= 0.0) discard;
                float alpha = smoothstep(0.0, 0.08, vAge) * (1.0 - smoothstep(0.35, 1.0, vAge));
                alpha *= dens * (0.2 + 0.8 * vRand) * vNear;
                vec4 tex = texture2D(map, gl_PointCoord);
                if (tex.a * alpha < 0.004) discard;
                vec3 finalColor = color * lightFactor;
                gl_FragColor = vec4(finalColor, tex.a * alpha);
                {
                    // 霧（海面と同じく、トーンマッピング・sRGB変換の前に混ぜる）
                    float fogD = uFogDensity * vFogDist;
                    gl_FragColor.rgb = mix(gl_FragColor.rgb, uFogColor, clamp(1.0 - exp(-fogD * fogD), 0.0, 1.0));
                }
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
// スクリューが水をかくと、羽根の先端（翼端渦）や羽根の背面で水が泡立ち、
// 泡の雲がプロペラの後流（噴流）に乗って渦を巻きながら後ろへ流され、
// 浮き上がって水面で白く湧き上がる（プロペラウォッシュの「ボイル」）。
//   ・泡の出る位置と半径は、実際の羽根の形から求める（32-engine-propeller.js）
//   ・泡の量と噴流の強さは、船の速度ではなく機関の回転数と「負荷」
//     （加速中・逆転中ほど多い）で決める。後進では泡は前へ噴き出す
//   ・1粒は「細かい泡の雲」を表す。水中の泡の雲(kind 0)が水面に着くと、
//     水面で広がって消える湧き上がり(kind 1)に変わる
let bubbleGeo, bubbleMat, bubblePoints;
const MAX_BUBBLES = 1600;
// 画質ごとの同時に出せる泡の数
const BUBBLE_CAP = { high: 1600, medium: 1100, low: 700, verylow: 420, ultralow: 260 };
let bubbleIdx = 0;
let bubbleEmitAccum = 0;
let bubbleFrame = 0;
// 1粒ごとの状態（ゴミを出さないよう型付き配列で持つ）
const bubbleVel  = new Float32Array(MAX_BUBBLES * 3);
const bubbleLife = new Float32Array(MAX_BUBBLES);   // 寿命[秒]
const bubbleSize0 = new Float32Array(MAX_BUBBLES);  // 出たときの大きさ（ワールド単位）
const bubbleSurf = new Float32Array(MAX_BUBBLES);   // 真上の水面の高さ（数フレームごとに更新）
const bubbleRise = new Float32Array(MAX_BUBBLES);   // 浮き上がる速さ

function createBubbleSystem() {
    bubbleGeo = new THREE.BufferGeometry();
    const posArr = new Float32Array(MAX_BUBBLES * 3);
    const ageArr = new Float32Array(MAX_BUBBLES);
    const kindArr = new Float32Array(MAX_BUBBLES);
    const sizeArr = new Float32Array(MAX_BUBBLES);
    const rndArr = new Float32Array(MAX_BUBBLES);
    for (let i = 0; i < MAX_BUBBLES; i++) {
        ageArr[i] = 999;          // 不活性
        posArr[i * 3 + 1] = -9999;
        rndArr[i] = Math.random();
    }
    bubbleGeo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
    bubbleGeo.setAttribute('age',      new THREE.BufferAttribute(ageArr, 1));
    bubbleGeo.setAttribute('kind',     new THREE.BufferAttribute(kindArr, 1));
    bubbleGeo.setAttribute('psize',    new THREE.BufferAttribute(sizeArr, 1));
    bubbleGeo.setAttribute('rnd',      new THREE.BufferAttribute(rndArr, 1));
    [ 'position', 'age', 'kind', 'psize' ].forEach(n => bubbleGeo.attributes[n].setUsage(THREE.DynamicDrawUsage));

    bubbleMat = new THREE.ShaderMaterial({
        // v153-fix2: WebGL2ではEXT_frag_depth拡張が存在しないため出し分ける（水面と同じ対策）。
        uniforms: { sizeScale: { value: 1.0 }, lightFactor: { value: 1.0 }, uViewH: { value: 800 },
                    uFogColor: particleFogUniforms.uFogColor, uFogDensity: particleFogUniforms.uFogDensity },
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: THREE.NormalBlending,
        vertexShader: `
            attribute float age;
            attribute float kind;
            attribute float psize;
            attribute float rnd;
            uniform float uViewH;
            varying float vAge;
            varying float vKind;
            varying float vRnd;
            // 対数深度バッファ対応（waterMatと同じ理由）
            // v153-fix3: EXT_frag_depthに依存しない経路のみを使う。
            #ifdef USE_LOGDEPTHBUF
                uniform float logDepthBufFC;
            #endif
            varying float vFogDist;
            bool isPerspectiveMatrix(mat4 m) { return m[2][3] == -1.0; }
            void main() {
                vAge = age; vKind = kind; vRnd = rnd;
                if (age > 1.0) {
                    // 不活性パーティクルはクリップ空間外に追い出す
                    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
                    gl_PointSize = 0.0;
                    return;
                }
                vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
                vFogDist = -mvPos.z;
                // ワールドでの大きさ → 画面上の画素数（遠近に正しく合わせる）
                float px = psize * projectionMatrix[1][1] * 0.5 * uViewH / max(0.1, -mvPos.z);
                gl_PointSize = clamp(px, 1.5, 140.0);
                gl_Position = projectionMatrix * mvPos;
                #ifdef USE_LOGDEPTHBUF
                    if (isPerspectiveMatrix(projectionMatrix)) {
                        gl_Position.z = log2(max(1e-6, gl_Position.w + 1.0)) * logDepthBufFC - 1.0;
                        gl_Position.z *= gl_Position.w;
                    }
                #endif
            }
        `,
        fragmentShader: `
            uniform float lightFactor;
            uniform vec3 uFogColor;
            uniform float uFogDensity;
            varying float vFogDist;
            varying float vAge;
            varying float vKind;
            varying float vRnd;
            #ifdef USE_LOGDEPTHBUF
                uniform float logDepthBufFC;
            #endif
            float h1(float n) { return fract(sin(n) * 43758.5453); }
            float h2(vec2 q) { return fract(sin(dot(q, vec2(127.1, 311.7))) * 43758.5453); }
            // なめらかなまだら模様（格子状に見えないよう、ずらした2段を重ねる）
            float vnoise(vec2 q) {
                vec2 i = floor(q), f = fract(q);
                f = f * f * (3.0 - 2.0 * f);
                return mix(mix(h2(i), h2(i + vec2(1.0, 0.0)), f.x),
                           mix(h2(i + vec2(0.0, 1.0)), h2(i + vec2(1.0, 1.0)), f.x), f.y);
            }
            void main() {
                if (vAge > 1.0) discard;
                vec2 p = gl_PointCoord * 2.0 - 1.0;
                float d2 = dot(p, p);
                if (d2 > 1.0) discard;
                vec3 col;
                float a;
                if (vKind < 0.5) {
                    // 水中の泡の雲：小さな泡の塊がいくつか集まった形（粒ごとに違う形）
                    float s = 0.0;
                    for (int k = 0; k < 4; k++) {
                        float fk = float(k);
                        vec2 c = (vec2(h1(vRnd * 91.7 + fk * 13.1), h1(vRnd * 37.3 + fk * 7.9)) - 0.5) * 0.9;
                        float r = 0.16 + 0.16 * h1(vRnd * 17.1 + fk * 3.3);
                        vec2 q = p - c;
                        s += exp(-dot(q, q) / (r * r));
                    }
                    float halo = exp(-d2 * 2.5) * 0.35;
                    float cloud = clamp(s * 0.55 + halo, 0.0, 1.0);
                    // 出てすぐは濃く、流されるうちに細かく散って薄くなる
                    a = cloud * smoothstep(0.0, 0.06, vAge) * (1.0 - smoothstep(0.35, 1.0, vAge)) * 0.55;
                    col = mix(vec3(0.70, 0.88, 0.92), vec3(0.97, 1.0, 1.0), clamp(s * 0.6, 0.0, 1.0));
                } else {
                    // 水面の湧き上がり：中央が盛り上がって白く、広がるにつれて
                    // 縁の方に泡が残り、青緑色（泡の混じった水）へ薄れていく
                    float ang = atan(p.y, p.x);
                    float wob = 0.12 * sin(ang * 3.0 + vRnd * 30.0) + 0.08 * sin(ang * 7.0 + vRnd * 57.0);
                    float d = sqrt(d2) * (1.0 + wob);
                    float body = 1.0 - smoothstep(0.55, 1.0, d);
                    float rim = smoothstep(0.35, 0.75, d) * (1.0 - smoothstep(0.75, 1.0, d));
                    float centre = 1.0 - smoothstep(0.0, 0.6, d);
                    float foam = clamp(centre * (1.0 - vAge * 1.2) + rim * (0.5 + 0.5 * vAge), 0.0, 1.0);
                    // 泡の細かいまだら
                    vec2 nq = p * 3.2 + vec2(vRnd * 17.0, vRnd * 29.0);
                    float grain = 0.55 + 0.45 * (0.65 * vnoise(nq) + 0.35 * vnoise(nq * 2.3 + 5.1));
                    a = body * (0.4 + 0.6 * foam) * grain
                        * smoothstep(0.0, 0.08, vAge) * pow(1.0 - vAge, 1.3) * 0.9;
                    col = mix(vec3(0.42, 0.72, 0.70), vec3(0.95, 0.99, 1.0), foam);
                }
                if (a < 0.004) discard;
                gl_FragColor = vec4(col * lightFactor, a);
                {
                    // 霧（海面と同じく、トーンマッピング・sRGB変換の前に混ぜる）
                    float fogD = uFogDensity * vFogDist;
                    gl_FragColor.rgb = mix(gl_FragColor.rgb, uFogColor, clamp(1.0 - exp(-fogD * fogD), 0.0, 1.0));
                }
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
            uResK:       { value: 1.0 },
            // 波切りストリークの画面空間回転を正しく計算するための画面アスペクト比。
            // animateWakeParticles()内で毎フレーム camera.aspect から更新される
            // （画面回転・リサイズにも自動追従）。
            uAspect:     { value: (window.innerWidth && window.innerHeight) ? (window.innerWidth / window.innerHeight) : 1.0 },
            uFogColor:   particleFogUniforms.uFogColor,
            uFogDensity: particleFogUniforms.uFogDensity,
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
            uniform float uResK;
            varying float vAge;
            varying float vType;
            varying float vAngle;
            // 対数深度バッファ対応（waterMatと同じ理由）
            // v153-fix3: EXT_frag_depthに依存しない経路のみを使う。
            #ifdef USE_LOGDEPTHBUF
                uniform float logDepthBufFC;
            #endif
            varying float vFogDist;
            bool isPerspectiveMatrix(mat4 m) { return m[2][3] == -1.0; }
            void main() {
                vAge = age; vType = ptype;
                if (age > 1.0) {
                    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
                    gl_PointSize = 0.0;
                    return;
                }
                vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
                vFogDist = -mvPos.z;

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
                gl_PointSize = min(requestedSize, 500.0) * uResK;   // 解像度の補正（画質で大きさが変わらないように）
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
            uniform vec3 uFogColor;
            uniform float uFogDensity;
            varying float vFogDist;
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
                {
                    // 霧（海面と同じく、トーンマッピング・sRGB変換の前に混ぜる）
                    float fogD = uFogDensity * vFogDist;
                    gl_FragColor.rgb = mix(gl_FragColor.rgb, uFogColor, clamp(1.0 - exp(-fogD * fogD), 0.0, 1.0));
                }
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
    wakeParticleMat.uniforms.uResK.value = particleResK();
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
        // （寿命を半分以下に：泡 約21秒→約9秒、しぶき 約1.3秒→約0.6秒、波切りの筋 約1.8秒→約0.8秒。
        //   長く残る泡が引き波に沿って数千個たまり、1 個ずつの波の高さの計算と、重なった大きな半透明の点の
        //   描画で、引き波が伸びるほど重くなっていた）
        ageAttr.array[i] += dt * (d.type === 0 ? 0.11 : (d.type === 2 ? 1.25 : 1.6)) * (0.8 + d.rand * 0.4);
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
                ? getOceanHeight(px, pz, t) : waterSurface;
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
                ? getOceanHeight(px, pz, t) : waterSurface;
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
            ? getOceanHeight(emitX, emitZ, t)
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

const _bubE1 = new THREE.Vector3(), _bubE2 = new THREE.Vector3(), _bubUp = new THREE.Vector3(0, 1, 0);

// 1つの泡の雲を出す
function _emitBubble(src, sgn, jetV, swirlV, shipVx, shipVz, sizeScale, t) {
    const posA = bubbleGeo.attributes.position.array;
    // 回転軸に垂直な基底 (e1, e2)
    _bubE1.crossVectors(_bubUp, src.axisDir);
    if (_bubE1.lengthSq() < 1e-6) _bubE1.set(1, 0, 0).cross(src.axisDir);
    _bubE1.normalize();
    _bubE2.crossVectors(src.axisDir, _bubE1).normalize();

    // 羽根の先端寄り（翼端渦）から多く出す。羽根4枚のどれかの位置＋少しのばらつき
    const blades = 4;
    const ang = src.angle * src.handed + Math.floor(Math.random() * blades) / blades * Math.PI * 2 + (Math.random() - 0.5) * 0.5;
    const rr = src.radius * (src.paddle ? 1.0 : (0.55 + 0.45 * Math.sqrt(Math.random())));
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const x = src.center.x + _bubE1.x * ca * rr + _bubE2.x * sa * rr;
    const y = src.center.y + _bubE1.y * ca * rr + _bubE2.y * sa * rr;
    const z = src.center.z + _bubE1.z * ca * rr + _bubE2.z * sa * rr;
    // 水面より上の羽根からは出さない（外輪は水に入っている下側だけ）
    const surf = getOceanHeight(x, z, t);
    if (y > surf - 0.02 * src.radius) return;

    const i = bubbleIdx;
    posA[i * 3] = x; posA[i * 3 + 1] = y; posA[i * 3 + 2] = z;
    bubbleGeo.attributes.age.array[i] = 0;
    bubbleGeo.attributes.kind.array[i] = 0;
    // 噴流（推力と逆向き）＋回転による渦（羽根の接線方向）。船の近くの水は船に
    // 少し引きずられている（伴流）ので、船の速度の一部も持つ
    const sw = swirlV * src.dir * src.handed;
    const tx = (-sa * _bubE1.x + ca * _bubE2.x) * sw;
    const ty = (-sa * _bubE1.y + ca * _bubE2.y) * sw;
    const tz = (-sa * _bubE1.z + ca * _bubE2.z) * sw;
    const jv = jetV * (0.7 + 0.6 * Math.random());
    bubbleVel[i * 3]     = shipVx * 0.4 - src.axisDir.x * sgn * jv + tx;
    bubbleVel[i * 3 + 1] =              - src.axisDir.y * sgn * jv + ty * 0.6;
    bubbleVel[i * 3 + 2] = shipVz * 0.4 - src.axisDir.z * sgn * jv + tz;
    bubbleLife[i] = 3.0 + 2.0 * Math.random();
    bubbleSize0[i] = src.radius * (0.35 + 0.35 * Math.random());
    bubbleSurf[i] = surf;
    bubbleRise[i] = sizeScale * (1.6 + 1.6 * Math.random());
    bubbleGeo.attributes.psize.array[i] = bubbleSize0[i];
    bubbleIdx++;
    if (bubbleIdx >= (BUBBLE_CAP[perf.quality] || 1100)) bubbleIdx = 0;
}

function animateBubbles(t, dt) {
    if (!bubbleGeo || !shipGroup) return;
    bubbleFrame++;
    const posA  = bubbleGeo.attributes.position.array;
    const ageA  = bubbleGeo.attributes.age.array;
    const kindA = bubbleGeo.attributes.kind.array;
    const sizeA = bubbleGeo.attributes.psize.array;
    const cap = Math.min(MAX_BUBBLES, BUBBLE_CAP[perf.quality] || 1100);
    if (bubbleIdx >= cap) bubbleIdx = 0;

    const sizeScale = THREE.MathUtils.clamp(physics.scale / 22.0, 0.3, 6.0);
    bubbleMat.uniforms.sizeScale.value = sizeScale;
    if (renderer) bubbleMat.uniforms.uViewH.value = renderer.domElement.height || 800;

    // 船体回避：水面に近づいた泡・水面の湧き上がりだけ、船体に重ならないよう
    // 側方へ押し出す（深い所では半幅モデルが船体の上下方向の形を持たないため）
    const hullAvoidBand   = sizeScale * 1.5;
    const hullAvoidMargin = sizeScale * 0.12;
    const canAvoidHull = (typeof pushOutsideHull === 'function')
        && window.hullProfile && window.hullProfile.ready;

    const dragUnder = Math.exp(-0.9 * dt);   // 水中：噴流・渦が周りの水に負けて弱まる
    const dragSurf  = Math.exp(-0.6 * dt);   // 水面：広がりながら止まる
    const turb = sizeScale * 1.2;            // 乱れ
    let active = 0;

    // 画質を下げた直後は上限より後ろの粒も残っているので、全部を動かす
    for (let i = 0; i < MAX_BUBBLES; i++) {
        if (ageA[i] > 1.0) continue;
        active++;
        const i3 = i * 3;
        ageA[i] += dt / bubbleLife[i];
        if (ageA[i] > 1.0) { ageA[i] = 999; posA[i3 + 1] = -9999; continue; }
        const x = posA[i3], z = posA[i3 + 2];

        if (kindA[i] < 0.5) {
            // ── 水中の泡の雲 ──
            // 真上の水面の高さは、粒ごとにずらして3フレームに1回だけ求める
            if ((i + bubbleFrame) % 3 === 0) bubbleSurf[i] = getOceanHeight(x, z, t);
            bubbleVel[i3]     = bubbleVel[i3] * dragUnder + (Math.random() - 0.5) * turb * dt;
            bubbleVel[i3 + 2] = bubbleVel[i3 + 2] * dragUnder + (Math.random() - 0.5) * turb * dt;
            // 浮力：浮き上がる速さへ近づく
            bubbleVel[i3 + 1] += (bubbleRise[i] - bubbleVel[i3 + 1]) * 1.8 * dt;
            posA[i3]     += bubbleVel[i3] * dt;
            posA[i3 + 1] += bubbleVel[i3 + 1] * dt;
            posA[i3 + 2] += bubbleVel[i3 + 2] * dt;
            // 散りながら広がる
            sizeA[i] = bubbleSize0[i] * (1 + 1.6 * ageA[i]);
            if (posA[i3 + 1] >= bubbleSurf[i] - 0.1 * sizeScale) {
                // 水面に着いた：湧き上がりに変わる（泡が多く残っているほど大きく長く）
                const remain = 1 - ageA[i];
                kindA[i] = 1;
                ageA[i] = 0;
                bubbleLife[i] = (3.0 + 2.0 * Math.random()) * (0.6 + 0.4 * remain);
                bubbleSize0[i] = sizeA[i] * (1.1 + 0.6 * remain);
                bubbleVel[i3] *= 0.5; bubbleVel[i3 + 2] *= 0.5; bubbleVel[i3 + 1] = 0;
            }
        } else {
            // ── 水面の湧き上がり：水面に浮いたまま、広がって消える ──
            bubbleVel[i3]     *= dragSurf;
            bubbleVel[i3 + 2] *= dragSurf;
            posA[i3]     += bubbleVel[i3] * dt;
            posA[i3 + 2] += bubbleVel[i3 + 2] * dt;
            posA[i3 + 1] = getOceanHeight(posA[i3], posA[i3 + 2], t) + 0.12 * sizeScale;
            sizeA[i] = bubbleSize0[i] * (1 + 1.8 * Math.sqrt(ageA[i]));
        }

        if (canAvoidHull && posA[i3 + 1] > bubbleSurf[i] - hullAvoidBand && (i + bubbleFrame) % 2 === 0) {
            const corrected = pushOutsideHull(posA[i3], posA[i3 + 2], hullAvoidMargin);
            if (corrected.pushed) { posA[i3] = corrected.x; posA[i3 + 2] = corrected.z; }
        }
    }

    // ── 新しい泡を出す ──
    const rpm = physics.propRpm || 0;
    const absRpm = Math.abs(rpm);
    const sources = (absRpm > 0.02 && typeof getPropEmitSources === 'function') ? getPropEmitSources() : null;
    if (sources && sources.length > 0) {
        const slip = (typeof getPropSlip === 'function') ? getPropSlip() : 0;
        const racing = window._propRacingIntensity || 0;
        const maxSpd = Math.max(0.1, physics.maxSpeed || 1);
        // 泡の量：回転数と負荷（加速・逆転中は激しく泡立つ）。空転中も増える
        const intensity = absRpm * (0.35 + 1.1 * slip) + racing * 0.6;
        const ratePerSrc = 45 * Math.min(1.6, intensity);
        // 泡が寿命（水中＋水面で合わせて最長8秒ほど）より先に使い回されて、
        // 湧き上がりが途中で消えないよう、全体の出る数を抑える
        const rate = Math.min(ratePerSrc * sources.length, cap / 8);
        bubbleEmitAccum += rate * dt;
        if (bubbleEmitAccum > 40) bubbleEmitAccum = 40;

        const sgn = rpm >= 0 ? 1 : -1;
        const jetV = absRpm * maxSpd * (0.25 + 0.6 * slip);
        const spin = (typeof getPropSpinRate === 'function') ? Math.abs(getPropSpinRate()) : 0;
        const rotY = (physics.heading * Math.PI) / 180;
        const shipVx = Math.sin(rotY) * physics.speed * 0.514444;      // （速さはノット → m/s）
        const shipVz = Math.cos(rotY) * physics.speed * 0.514444;
        let n = 0;
        while (bubbleEmitAccum >= 1) {
            bubbleEmitAccum -= 1;
            const src = sources[n++ % sources.length];
            // 渦の速さ：羽根の先端の速さの一部（大きくなりすぎないよう抑える）
            const swirlV = Math.min(spin * src.radius * 0.2, jetV * 0.8 + sizeScale) * Math.sign(rpm || 1);
            _emitBubble(src, sgn, jetV, swirlV, shipVx, shipVz, sizeScale, t);
        }
    } else {
        bubbleEmitAccum = 0;
    }

    if (active > 0 || sources) {
        bubbleGeo.attributes.position.needsUpdate = true;
        bubbleGeo.attributes.age.needsUpdate = true;
        bubbleGeo.attributes.kind.needsUpdate = true;
        bubbleGeo.attributes.psize.needsUpdate = true;
    }
}
