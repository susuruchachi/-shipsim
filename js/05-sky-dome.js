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
            // 月明かりの強さ（満ち欠け・高さ・雲。16-daynight-and-telegraph.js の skyMoonLight）
            moonLight: { value: 0.0 },
            meteorTime: { value: -999.0 },
            auroraStrength: { value: 0.0 },
            // v83b: 空だけ今まで生値のまま出力していた（トーンマッピング/sRGB出力とも
            // 無関係だった）ため、それらを追加した途端に相対的に白飛びし始めた。
            // 船体・水面と質感を揃えたまま明るさだけ落とすための補正係数。
            skyExposure: { value: 0.75 },
            // v170: 雲量(0=快晴〜1=どんより)。24-weather.js が毎フレーム書き込む。
            // 従来は雲の出方が固定しきい値だったため、天候が変わっても空だけが
            // いつも同じ雲だった。
            cloudAmount: { value: 0.35 },
            // 天候の見た目（24-weather.js / 29-weather-fx.js が毎フレーム書き込む）
            overcast: { value: 0.0 },                        // どんより暗い空（0〜1）
            fogVeil: { value: 0.0 },                         // 霧・雨で空が霞む割合（0〜1）
            fogExtraDensity: { value: 0.0 },                 // 天候で濃くなった霧の濃さ（FogExp2。晴れの霞のぶんは除く）
            fogTintColor: { value: new THREE.Color(0.5, 0.55, 0.6) }, // 霞の色（＝霧の色）
            lightningFlash: { value: 0.0 },                  // 雷の閃光（0〜数）
            lightningDir: { value: new THREE.Vector3(0, 0.3, 1).normalize() }, // 雷の方向
            // ── 本物の夜空（70-night-sky.js が毎フレーム書き込む）──
            scene2eq: { value: new THREE.Matrix3() },        // 空の向き（three.js の座標）→ 赤道座標（J2000）
            milkyTex: { value: null },                       // 天の川（data/sky/milkyway.jpg）
            milkyGain: { value: 0.0 },                       // 天の川の明るさ（読めていなければ 0）
            skyBgB: { value: 1.0 },                          // 天頂の空の明るさ（暗い夜空を 1：薄明・月明かり。光害は別）
            lpZenith: { value: 0.0 },                        // 光害：天頂の明るさ（暗い夜空を 1）
            lpTex: { value: null },                          // 光害：方位ごとの地平線の明るさ（R）と光の丘の高さ（G）。64×1
            lpMax: { value: 0.0 },                           // lpTex の R の 1 にあたる明るさ
            lpColor: { value: new THREE.Color(1.0, 0.62, 0.32) }, // 街明かりの色（時代で変わる）
            moonTex: { value: null },                        // 月面（data/sky/moon.jpg）
            moonNorth: { value: new THREE.Vector3(0, 1, 0) },// 月の北極の向き（≒黄道の北極）
            moonRadius: { value: 0.022 },                    // 月の見かけの半径[rad]（ふだんは大きめ。双眼鏡で寄ると本当の大きさへ）
            moonTint: { value: new THREE.Color(1, 0.97, 0.92) }, // 月の色（低いほど赤く暗く）
            earthshine: { value: 0.0 }                       // 地球照（細い月の暗い側をほのかに）
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
            uniform float moonLight;
            uniform float meteorTime;
            uniform float auroraStrength;
            uniform float skyExposure;
            uniform float cloudAmount;
            uniform float overcast;
            uniform float fogVeil;
            uniform float fogExtraDensity;
            uniform vec3  fogTintColor;
            uniform float lightningFlash;
            uniform vec3  lightningDir;
            uniform mat3  scene2eq;
            uniform sampler2D milkyTex;
            uniform float milkyGain;
            uniform float skyBgB;
            uniform float lpZenith;
            uniform sampler2D lpTex;
            uniform float lpMax;
            uniform vec3  lpColor;
            uniform sampler2D moonTex;
            uniform vec3  moonNorth;
            uniform float moonRadius;
            uniform vec3  moonTint;
            uniform float earthshine;
            // 光害の空の明るさ（暗い夜空を 1）：まわりの街の光で空全体が明るく（地平線ほど）、街のある方位の地平線には光の丘
            float lpAt(vec3 d) {
                float sa = max(d.y, 0.0);
                float b = lpZenith * (1.0 + 1.5 * pow(1.0 - sa, 3.0));
                if (lpMax > 0.0) {
                    vec2 g = texture2D(lpTex, vec2(atan(-d.x, d.z) / 6.2831853 + 0.5, 0.5)).rg;
                    float w = 0.02 + g.y * 0.5;
                    b += g.x * g.x * lpMax * exp(-asin(sa) / w);
                }
                return b;
            }

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

                // 夜空：月明かりがあるほど青く明るく、月の無い夜はほとんど黒（水面に映る色は 16 で同じ式）
                float nightSkyK = 0.55 + 0.6 * moonLight;
                vec3 zenithNight  = vec3(0.008, 0.012, 0.045) * nightSkyK;
                vec3 horizNight   = vec3(0.015, 0.025, 0.065) * nightSkyK;
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
                    // v170: cloudAmount でしきい値を動かして雲量を変える。
                    // 快晴(0)では高いしきい値＝ほとんど雲が出ず、
                    // どんより(1)では低いしきい値＝空一面が覆われる。
                    float cloudThr = mix(0.63, 0.16, clamp(cloudAmount, 0.0, 1.0));
                    cloud = smoothstep(cloudThr - cloudEdge * 0.15, cloudThr + 0.24, cloud);
                    cloud *= smoothstep(0.02, 0.12, h); 
                    vec3 cloudLit  = mix(vec3(0.55, 0.60, 0.70), vec3(1.0, 0.97, 0.93), dayFactor);
                    vec3 cloudShad = mix(vec3(0.12, 0.14, 0.20), vec3(0.55, 0.58, 0.65), dayFactor);
                    // 荒天の雲は分厚く、下から見ると暗い灰色になる
                    cloudLit  *= 1.0 - overcast * 0.55;
                    cloudShad *= 1.0 - overcast * 0.6;
                    float cloudLight = dot(dir, sunDirection) * 0.5 + 0.5;
                    vec3 cloudColor = mix(cloudShad, cloudLit, cloudLight);
                    cloudColor = mix(cloudColor, vec3(0.95, 0.52, 0.20), dawnFactor * cloudLight * 0.7);
                    // 夜の雲：夜空より少し暗い影（星・月を隠す）。月明かりがあれば、月の側ほど灰色に照らされる
                    vec3 cloudNight = horizNight * 0.7 + vec3(0.07, 0.08, 0.10) * moonLight * (0.35 + 0.65 * pow(max(0.0, dot(dir, moonDirection)), 3.0));
                    // 街の上の雲は、下から街明かりに照らされて（晴れた空よりずっと）明るい
                    cloudNight += lpColor * 0.009 * (pow(1.0 + lpAt(dir) * 2.5, 0.5) - 1.0);
                    cloudColor = mix(cloudColor, cloudNight, nightFactor);
                    // 混ぜる割合は 1 を超えないように（朝夕は昼と朝焼けの割合を足すと 1 を超え、太陽の円盤の明るさから
                    // 雲の色へ「行き過ぎて」引かれて、雲の陰の太陽が黒い円になっていた）
                    skyColor = mix(skyColor, cloudColor, clamp(cloud * (dayFactor * 0.85 + dawnFactor * 0.6 + nightFactor * 0.85), 0.0, 0.95));
                    cloudCover = cloud;
                }

                // どんよりした空：青空の色を抜いて暗い灰色へ
                {
                    float lumS = dot(skyColor, vec3(0.3, 0.55, 0.15));
                    skyColor = mix(skyColor, vec3(lumS * 0.62), overcast * 0.75);
                }
                // 雷：雲の中が一瞬明るく光る（光った方向ほど強く、雲が厚いほど広がる）
                if (lightningFlash > 0.001) {
                    float toward = max(0.0, dot(dir, lightningDir));
                    float glow = pow(toward, 3.0) * 1.6 + 0.35;
                    skyColor += vec3(0.78, 0.82, 1.0) * lightningFlash * glow * (0.4 + cloudCover * 0.9) * smoothstep(-0.05, 0.1, h);
                }

                // 曇天・霧・雨では星は見えない
                float starVis = nightFactor * (1.0 - cloudCover * 0.95) * (1.0 - overcast)
                              * (1.0 - clamp(fogVeil * 1.6, 0.0, 1.0));
                // 月の円盤（星・天の川を隠す）
                // （月の中心からの角度は、cos の比較では float の丸めで円が崩れる（1 − cos が小さすぎる）ので、
                //   円盤の面へ射影した長さ（＝ sin(角度)）で測る）
                float moonDot = dot(dir, moonDirection);
                vec3 moonProj = dir - moonDirection * moonDot;
                float moonR = length(moonProj) / sin(moonRadius);            // 月の中心から：1 で月の縁
                float moonMask = smoothstep(1.04, 0.98, moonR) * step(0.0, moonDot) * step(-0.02, moonDirection.y);
                // 光害：街の光で空が明るく（雲・霧の向こうは雲の色のほうで）
                float lpB = lpAt(dir);
                if (lpB > 0.001 && h > -0.05) {
                    skyColor += lpColor * 0.0065 * (pow(1.0 + lpB, 0.5) - 1.0) * (1.0 - dayFactor) * (1.0 - cloudCover * 0.9);
                }
                // 天の川（NASA の星の光の地図：明るい星を除いたもの。星そのものは 70-night-sky.js の点）。
                // 空が明るい（街・月・薄明）ほど、空との差が無くなって見えなくなる
                if (milkyGain > 0.0 && starVis > 0.01 && h > -0.05) {
                    vec3 q = scene2eq * dir;
                    vec2 uv = vec2(fract(0.5 - atan(q.y, q.x) / 6.2831853), 0.5 + asin(clamp(q.z, -1.0, 1.0)) / 3.1415927);
                    vec3 mw = pow(texture2D(milkyTex, uv).rgb, vec3(2.2));
                    float bMw = dot(mw, vec3(0.2126, 0.7152, 0.0722)) * 7.5;      // 暗い夜空を 1 とした明るさ（いちばん明るい所で 1.5 ほど）
                    float sa = max(h, 0.0);
                    float X = 1.0 / (sa + 0.025 * exp(-11.0 * sa));                 // 大気の厚さ（天頂を 1）
                    float bAll = skyBgB * (1.0 + 0.6 * (1.0 - sa) * (1.0 - sa)) + lpB;
                    float contrast = bMw / bAll;
                    float vis = smoothstep(0.04, 0.35, contrast) * exp(-0.25 * (X - 1.0)) * smoothstep(-0.02, 0.08, h);
                    skyColor += mw * (milkyGain * vis * starVis * (1.0 - moonMask) / max(dot(mw, vec3(0.2126, 0.7152, 0.0722)), 1e-5)) * bMw;
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

                // 月：月面の地図（LRO の写真）を、本当の向き（月の北極 ≒ 黄道の北極）で貼り、太陽の向きから照らす。
                // 明るさは月の表面の反射の式（ロンメル・ゼーリガー：μ0/(μ0+μ)）。縁が暗くならず、欠け際はなだらかに暗くなる。
                // 細い月の暗い側は、地球の照り返し（地球照）でほのかに見える
                if (moonDot > 0.0 && moonR < 1.1) {
                    vec3 mU = moonNorth - moonDirection * dot(moonNorth, moonDirection);
                    mU = length(mU) > 1e-4 ? normalize(mU) : vec3(0.0, 1.0, 0.0);
                    vec3 mR = normalize(cross(moonDirection, mU));        // 画面で右（月の東）
                    float inv = 1.0 / sin(moonRadius);
                    float sx = dot(moonProj, mR) * inv, sy = dot(moonProj, mU) * inv;
                    float r2 = sx * sx + sy * sy;
                    float sz = sqrt(max(0.0, 1.0 - r2));
                    vec3 N = sx * mR + sy * mU - sz * moonDirection;        // 月の表面の向き（こちら向きが −moonDirection）
                    float lat = asin(clamp(sy, -1.0, 1.0));
                    float lon = atan(sx, max(sz, 1e-4));
                    // 縁の近くは地図が強く縮むので、細かい段（mip）を少し優先して、縁の模様がぼやけて輪のように見えないように
                    vec3 alb = pow(texture2D(moonTex, vec2(0.5 + lon / 6.2831853, 0.5 + lat / 3.1415927), -1.0).rgb, vec3(2.2)) * 3.0;  // 平均を 0.9 ほどに
                    float mu0 = dot(N, sunDirection), mu = max(sz, 0.02);
                    float ls = mu0 > 0.0 ? min(1.3, 2.0 * mu0 / (mu0 + mu)) : 0.0;
                    float pa = acos(clamp(-dot(sunDirection, moonDirection), -1.0, 1.0));   // 位相角（満月で 0）
                    ls *= mix(1.0, 0.5, smoothstep(0.0, 1.8, pa)) * (1.0 + 0.25 * exp(-pa / 0.1));
                    // 地球照：地球から月へ（−moonDirection の向きから）の光。新月に近いほど強い
                    float es = earthshine * sz * (1.0 - smoothstep(-0.05, 0.05, mu0));
                    float moonVis = (1.0 - cloudCover * 0.92) * (1.0 - overcast * 0.8);
                    float edge = smoothstep(1.02, 0.99, moonR);
                    // 明るい側だけを空に「足す」（空より暗くはならない。昼の月は空に溶けて淡く）
                    skyColor += moonTint * alb * (ls * 0.95 + es) * edge * moonVis * mix(1.0, 0.45, dayFactor);
                }
                // 月のまわりのにじみ（大気・目の中で散る光。月明かりが強いほど）
                {
                    float ang = acos(clamp(moonDot, -1.0, 1.0)) - moonRadius;
                    float halo = exp(-max(0.0, ang) / 0.035) * 0.10 + exp(-max(0.0, ang) / 0.25) * 0.025;
                    skyColor += vec3(0.65, 0.72, 0.92) * halo * moonLight * nightFactor * (1.0 - cloudCover * 0.6) * step(-0.02, moonDirection.y);
                }

                // 霧・雨：空の上の方まで霞で覆う（地平線ほど濃い）。
                // 空ドームは scene.fog の影響を受けないので、ここで霧の色へ寄せる。
                // 霧・雨・しぶきの霞：その向きで霞の層（厚さ約 400m）を通り抜ける長さを、船・海と同じ FogExp2 の式で。
                // 水平線の近くは霞の中をどこまでも見通すので、霧に溶けた遠くの船・海とちょうど同じ色になる
                // （以前は空の霞が一定の割合だけで、昼は霧に溶けた遠くの船・海が空より白く浮いて、輪郭が見えていた）
                float veilPhys = 0.0;
                if (fogExtraDensity > 0.0) {
                    float fl = fogExtraDensity * 400.0 / max(h, 0.012);
                    veilPhys = 1.0 - exp(-fl * fl);
                }
                float veil = max(fogVeil * mix(1.0, 0.72, smoothstep(0.0, 0.8, h)), veilPhys);
                if (veil > 0.001) {
                    skyColor = mix(skyColor, fogTintColor / max(skyExposure, 0.01), clamp(veil, 0.0, 1.0));
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
    if (lightSettings.envMult <= 0 || window.gpuDbg === 'env') { scene.environment = null; return; }   // （表示の不具合の切り分け：01-state-and-config.js）
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
    // 雷の閃光の最中に撮ると、次に撮り直すまでの2秒間、船の反射が明るいまま
    // 残ってしまうので、閃光が収まるまで待つ（29-weather-fx.js）
    if (window._lightningActive) return;
    envRefreshTimer = 0;
    updateEnvironmentMap();
}

