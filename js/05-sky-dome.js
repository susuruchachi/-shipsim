function createSkyDome() {
    const skyGeo = new THREE.SphereGeometry(1400, 32, 20);
    const skyMat = new THREE.ShaderMaterial({
        uniforms: {
            time: { value: 0.0 },
            camPos: { value: camera.position.clone() },
            dayProgress: { value: physics.dayProgress },
            sunDirection: { value: sunLight.position.clone().sub(camera.position).normalize() },
            moonDirection: { value: new THREE.Vector3() },
            moonPhase: { value: physics.moonPhase },
            meteorTime: { value: -999.0 },
            auroraStrength: { value: 0.0 },
            // v83b: 空だけ今まで生値のまま出力していた（トーンマッピング/sRGB出力とも
            // 無関係だった）ため、それらを追加した途端に相対的に白飛びし始めた。
            // 船体・水面と質感を揃えたまま明るさだけ落とすための補正係数。
            skyExposure: { value: 0.75 }
        },
        vertexShader: `
            varying vec3 vWorldPosition;
            void main() {
                vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                gl_Position.z = gl_Position.w;
            }
        `,
        fragmentShader: `
            precision highp float;
            varying vec3 vWorldPosition;
            uniform float time;
            uniform vec3 camPos;
            uniform float dayProgress;
            uniform vec3 sunDirection;
            uniform vec3 moonDirection;
            uniform float moonPhase;
            uniform float meteorTime;
            uniform float auroraStrength;
            uniform float skyExposure;

            float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
            float hash3(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
            float noise(vec2 p) {
                vec2 i = floor(p); vec2 f = fract(p);
                f = f * f * (3.0 - 2.0 * f);
                return mix(mix(hash(i), hash(i+vec2(1,0)), f.x),
                           mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y);
            }
            float fbm(vec2 p) {
                float v = 0.0; float a = 0.5;
                for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.1; a *= 0.5; }
                return v;
            }

            void main() {
                vec3 dir = normalize(vWorldPosition - camPos);
                float h = clamp(dir.y, -1.0, 1.0);

                float sunH = sunDirection.y; 
                float dayFactor    = smoothstep(-0.18, 0.18, sunH);
                float dawnFactor   = smoothstep(-0.25, 0.0, sunH) * (1.0 - smoothstep(0.0, 0.25, sunH));
                float nightFactor  = 1.0 - smoothstep(-0.18, 0.10, sunH);

                vec3 zenithNight  = vec3(0.008, 0.012, 0.045);
                vec3 horizNight   = vec3(0.015, 0.025, 0.065);
                vec3 zenithDawn   = vec3(0.18, 0.30, 0.55);
                vec3 horizDawn    = vec3(0.85, 0.48, 0.22);
                vec3 zenithDay    = vec3(0.16, 0.42, 0.76);
                vec3 horizDay     = vec3(0.52, 0.74, 0.92);

                vec3 currentZenith = mix(mix(zenithNight, zenithDawn, dawnFactor), zenithDay, dayFactor);
                vec3 currentHoriz  = mix(mix(horizNight,  horizDawn,  dawnFactor), horizDay,  dayFactor);
                vec3 skyColor = mix(currentHoriz, currentZenith, smoothstep(-0.05, 0.9, h));

                float sunsetBand = smoothstep(-0.15, 0.0, sunH) * (1.0 - smoothstep(0.0, 0.20, sunH));
                float horiRing = exp(-h * h * 18.0);
                float sunHorizDot = dot(dir, sunDirection);
                float sunSide = smoothstep(0.0, 1.0, sunHorizDot * 0.5 + 0.5);
                skyColor += vec3(0.9, 0.35, 0.05) * sunsetBand * horiRing * sunSide * 1.2;
                skyColor += vec3(0.5, 0.15, 0.30) * sunsetBand * horiRing * (1.0 - sunSide) * 0.4;

                float sunDot  = max(0.0, dot(dir, sunDirection));
                // Sun disc: purely additive, single smooth ramp — no mix() steps.
                // 2段階 mix() を廃止。加算のみにすることでACESトーンマッピング後の
                // 暗い輪（境界アーティファクト）を根本的になくす。
                float sunVisible = smoothstep(-0.05, 0.05, sunDirection.y);
                float dayDawnFactor = (dayFactor + dawnFactor * 0.8) * sunVisible;
                float corona  = pow(sunDot, 14.0) * 0.22 * (dayFactor + dawnFactor * 0.5);
                float sunGlow = pow(sunDot, 200.0) * 0.6;
                float discT   = smoothstep(0.9985, 0.99999, sunDot);
                float discBrightness = discT * discT * 3.5;
                vec3  sunEdgeCol = mix(vec3(1.0, 0.45, 0.12), vec3(1.0, 0.95, 0.82), dayFactor);
                vec3  sunCoreCol = mix(vec3(1.0, 0.78, 0.55), vec3(1.05, 1.05, 1.0), dayFactor);
                vec3  sunDiscCol = mix(sunEdgeCol, sunCoreCol, smoothstep(0.0, 1.0, discT));
                skyColor += sunDiscCol * discBrightness * dayDawnFactor;
                skyColor += sunEdgeCol * (sunGlow + corona) * dayDawnFactor;

                float cloudCover = 0.0;
                if (h > 0.02) {
                    vec2 cloudUV = dir.xz / (dir.y + 0.05) * 0.18 + vec2(time * 0.0015, time * 0.0008);
                    float cloud = fbm(cloudUV);
                    float cloudEdge = fbm(cloudUV * 2.3 + vec2(3.7, 1.2)) * 0.4;
                    cloud = smoothstep(0.46 - cloudEdge * 0.15, 0.70, cloud);
                    cloud *= smoothstep(0.02, 0.12, h); 
                    vec3 cloudLit  = mix(vec3(0.55, 0.60, 0.70), vec3(1.0, 0.97, 0.93), dayFactor);
                    vec3 cloudShad = mix(vec3(0.12, 0.14, 0.20), vec3(0.55, 0.58, 0.65), dayFactor);
                    float cloudLight = dot(dir, sunDirection) * 0.5 + 0.5;
                    vec3 cloudColor = mix(cloudShad, cloudLit, cloudLight);
                    cloudColor = mix(cloudColor, vec3(0.95, 0.52, 0.20), dawnFactor * cloudLight * 0.7);
                    skyColor = mix(skyColor, cloudColor, cloud * (dayFactor * 0.85 + dawnFactor * 0.6 + nightFactor * 0.05));
                    cloudCover = cloud;
                }

                float starVis = nightFactor * (1.0 - cloudCover * 0.95);
                if (starVis > 0.01 && h > -0.05) {
                    vec3 sd = floor(dir * 280.0);
                    float starRaw = hash3(sd);
                    float twinkle = 0.75 + 0.25 * sin(time * (2.0 + starRaw * 5.0) + starRaw * 6.28);
                    float star = step(0.987, starRaw) * twinkle;
                    float bigStar = step(0.9985, starRaw) * (1.5 + starRaw * 2.0) * twinkle;
                    float moonPhaseGlow = sin(moonPhase * 3.14159);
                    float starBright = (star * 0.7 + bigStar) * (0.4 + 0.6 * moonPhaseGlow);
                    skyColor += vec3(0.85, 0.90, 1.0) * starBright * starVis;
                    float milkyWay = fbm(dir.xz * 1.8 + vec2(0.5)) * 0.5;
                    milkyWay = smoothstep(0.52, 0.72, milkyWay) * smoothstep(-0.05, 0.3, h);
                    skyColor += vec3(0.3, 0.35, 0.55) * milkyWay * starVis * 0.4;
                }

                float meteorAge = time - meteorTime;
                if (meteorAge > 0.0 && meteorAge < 1.8 && starVis > 0.3 && h > 0.1) {
                    vec3 meteorStart = normalize(vec3(0.45, 0.72, 0.53));
                    vec3 meteorDir   = normalize(vec3(0.82, -0.45, -0.36));
                    float progress = meteorAge / 1.8;
                    vec3 meteorHead = meteorStart + meteorDir * progress * 0.55;
                    meteorHead = normalize(meteorHead);
                    float mDist = length(dir - meteorHead) * 180.0;
                    float alongTrail = dot(dir - meteorHead, -meteorDir);
                    float perpDist   = length((dir - meteorHead) - (-meteorDir) * alongTrail) * 180.0;
                    float tail = exp(-perpDist * perpDist * 8.0) * exp(-max(0.0, alongTrail) * 22.0)
                                 * smoothstep(0.0, 0.1, max(0.0, alongTrail));
                    float head = exp(-mDist * mDist * 0.6);
                    float fade = (1.0 - progress) * smoothstep(0.0, 0.08, progress);
                    skyColor += vec3(0.95, 0.97, 1.0) * (head * 2.5 + tail * 1.2) * fade * starVis;
                }

                if (auroraStrength > 0.01 && nightFactor > 0.5 && h > 0.05) {
                    float az = atan(dir.x, dir.z);
                    float el = asin(clamp(dir.y, -1.0, 1.0));
                    float wave1 = sin(az * 3.0 + time * 0.25) * 0.5 + 0.5;
                    float wave2 = sin(az * 5.5 - time * 0.18 + 1.2) * 0.5 + 0.5;
                    float wave3 = sin(az * 2.0 + time * 0.11) * 0.5 + 0.5;
                    float curtain = (wave1 * 0.5 + wave2 * 0.3 + wave3 * 0.2);
                    float band = smoothstep(0.08, 0.22, el) * (1.0 - smoothstep(0.45, 0.75, el));
                    band *= (0.6 + curtain * 0.4);
                    float hueShift = sin(az * 2.0 + time * 0.08) * 0.5 + 0.5;
                    vec3 auroraGreen = vec3(0.05, 0.9, 0.35);
                    vec3 auroraPink  = vec3(0.85, 0.15, 0.55);
                    vec3 auroraBlue  = vec3(0.10, 0.40, 0.95);
                    vec3 auroraCol   = mix(mix(auroraGreen, auroraPink, hueShift), auroraBlue, wave2 * 0.3);
                    float auroraAlpha = band * auroraStrength * nightFactor * (1.0 - cloudCover * 0.7) * 0.75;
                    skyColor += auroraCol * auroraAlpha;
                }

                float moonDot = dot(dir, moonDirection);
                float moonAngularRadius = 0.022; // ~1.25 degrees - larger than real life for visibility, still moon-like
                float moonMask = smoothstep(cos(moonAngularRadius * 1.08), cos(moonAngularRadius * 0.92), moonDot);
                if (moonMask > 0.0) {
                    vec3 moonUp = vec3(0.0, 1.0, 0.0);
                    vec3 moonRight = normalize(cross(moonUp, moonDirection));
                    if (length(moonRight) < 0.01) moonRight = vec3(1.0, 0.0, 0.0);
                    vec3 moonUpOrtho = normalize(cross(moonDirection, moonRight));

                    // Project onto the moon's disc plane and normalize to a -1..1 unit circle
                    vec3 proj = dir - moonDirection * moonDot;
                    float discScale = 1.0 / sin(moonAngularRadius);
                    float localX = dot(proj, moonRight) * discScale;
                    float localY = dot(proj, moonUpOrtho) * discScale;

                    // 光源方向をtai陽の方向から月ディスク上の2Dに投影して求める。
                    // これにより月の位置（高さ・方位）によって明暗境界の角度が変わる。
                    // Project sun direction onto moon disc plane to get actual light direction.
                    vec3 sunRelToMoon = sunDirection - moonDirection * dot(sunDirection, moonDirection);
                    float sunLenOnDisc = length(sunRelToMoon);
                    vec2 lightDir2D;
                    if (sunLenOnDisc > 0.001) {
                        vec3 sunOnDisc = sunRelToMoon / sunLenOnDisc;
                        lightDir2D = vec2(dot(sunOnDisc, moonRight), dot(sunOnDisc, moonUpOrtho));
                    } else {
                        // Sun and moon nearly coincident (new moon), use phase as fallback
                        float phaseAngle = moonPhase * 6.28318;
                        lightDir2D = vec2(sin(phaseAngle), 0.0);
                    }

                    // Moon sphere illumination
                    float r2 = localX * localX + localY * localY;
                    float discZ = sqrt(max(0.0, 1.0 - r2));
                    vec3 sphereN = vec3(localX, localY, discZ);
                    // Light comes from sunDirection side; depth (toward/away viewer) from moon-sun angle
                    float moonSunDot = dot(moonDirection, sunDirection);
                    vec3 moonLightDir = vec3(lightDir2D.x, lightDir2D.y, -moonSunDot);
                    float illum = dot(sphereN, normalize(moonLightDir));
                    float litSide = smoothstep(-0.12, 0.12, illum);

                    // Full moon (phase≈0.5) is bright, new moon (phase≈0 or 1) is dark
                    float phaseBrightness = max(0.08, sin(moonPhase * 3.14159));
                    float crater = noise(dir.xz * 18.0) * 0.12 + 0.88;

                    vec3 moonLitColor  = vec3(0.93, 0.93, 0.97) * crater * (0.7 + 0.3 * phaseBrightness);
                    // Dark side: fully transparent — blend to sky so no dark disc is visible.
                    // 暗い側（影）は完全に空と同化させ、黒い円が見えないようにする。
                    vec3 moonColor = mix(skyColor, moonLitColor, litSide);

                    // Soft glow around the moon disc
                    float moonGlow = pow(max(0.0, moonDot), 300.0) * 0.35 * phaseBrightness * nightFactor;
                    skyColor += vec3(0.65, 0.72, 0.92) * moonGlow;

                    // Only render the lit side — dark side alpha is 0 so it's invisible.
                    // 明るい側だけを描画し、暗い側のalphaを0にする。
                    float litAlpha = smoothstep(-0.05, 0.25, litSide);
                    float diskAlpha = moonMask * litAlpha;
                    skyColor = mix(skyColor, moonColor, diskAlpha);
                }

                gl_FragColor = vec4(max(skyColor * skyExposure, vec3(0.0)), 1.0);
                // v83: 完全自前シェーダーのため、船体(標準マテリアル)と同じ見え方に
                // 揃えるべくトーンマッピング＋sRGB出力エンコードを明示的に適用する。
                // （無いと空だけ「生の値」のまま出て、他の要素とコントラストが食い違う）
                #include <tonemapping_fragment>
                #include <encodings_fragment>
            }
        `,
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: false
    });
    skyMesh = new THREE.Mesh(skyGeo, skyMat);
    skyMesh.userData.isSky = true;
    skyMesh.userData.noBloom = true;   // 太陽グレア/コロナは既にシェーダー側で自作済み。ブルームを重ねると白飛びするため除外
    skyMesh.renderOrder = -1000;
    scene.add(skyMesh);
}

// ============================================================
//  環境光(IBL) — 空をPMREMキャプチャしてscene.environmentに反映（v83〜）
// ============================================================
// scene.environmentを設定すると、船体等のMeshStandardMaterialが自動的に
// 「その瞬間の空の色による柔らかい環境光＋映り込み」を受け取るようになる。
// 今までのambientLight/hemiLightは単色・無指向の補助光でしかなかったため、
// 影の中の色味や金属・ガラス面の映り込みまでは表現できていなかった。
// 撮影対象はskyMeshと同一マテリアル（＝同じuniforms参照）を貼った専用の
// 簡易スフィアのみとし、船体やパーティクルは撮影に含めない（毎回シーン全体を
// 描き直すコストを避けるため）。空はゆっくりとしか変化しないので、撮影も
// 毎フレームではなく数秒おきに行えば十分。
let envPmremGenerator = null;
let envRenderTarget = null;
let envProxyScene = null;
let envRefreshTimer = 999; // 起動直後に1回は必ず撮影させるため大きめの初期値

function initEnvironmentLighting() {
    if (!renderer || !skyMesh || !THREE.PMREMGenerator) return; // 古いCDNビルド等では何もしない
    try {
        envPmremGenerator = new THREE.PMREMGenerator(renderer);
        envProxyScene = new THREE.Scene();
        const proxyGeo = new THREE.SphereGeometry(1400, 24, 16);
        const envProxyMesh = new THREE.Mesh(proxyGeo, skyMesh.material); // uniforms共有、追従コード不要
        envProxyScene.add(envProxyMesh);
        updateEnvironmentMap();
    } catch (e) {
        console.warn('IBL環境光の初期化に失敗しました（致命的ではありません）:', e);
        envPmremGenerator = null;
    }
}

function updateEnvironmentMap() {
    if (!envPmremGenerator || !envProxyScene) return;
    if (lightSettings.envMult <= 0) { scene.environment = null; return; }
    try {
        const prev = envRenderTarget;
        envRenderTarget = envPmremGenerator.fromScene(envProxyScene, 0, 1, 2000);
        scene.environment = envRenderTarget.texture;
        if (prev) prev.dispose();
    } catch (e) {
        console.warn('環境マップの再撮影に失敗しました:', e);
    }
}

// js/17-main-loop.js の animate() から毎フレーム呼ばれる（dt=秒）。
function maybeUpdateEnvironmentMap(dt) {
    if (!envPmremGenerator) return;
    envRefreshTimer += dt;
    if (envRefreshTimer < 2.0) return; // 空はゆっくり変化するので2秒に1回で十分
    envRefreshTimer = 0;
    updateEnvironmentMap();
}

