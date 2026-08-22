// ── 「面ベースエリアグロー」シェーダーパッチ ────────────────────────────
// Blenderのエリアライトを面として正確に再現する。
// ライトのワールド変換行列から法線・幅ベクトル・高さベクトルを毎フレーム計算し、
// GLSLで「フラグメントからライト面への最短距離」を求めてemissiveを加算する。
// 法線方向の符号チェックにより面の「表側」（照射方向）のみ照らされるので、
// 外壁への漏れが自然に抑制され、内壁も正しく照らされる。
const HULL_GLOW_MAX_LIGHTS = 16;
let hullGlowUniforms = null;
let hullGlowEntries = []; // [{ light: PointLight, node: Object3D, color, baseIntensity }]

function createHullGlowUniforms() {
    const positions = [], colors = [], normals = [], halfW = [], halfH = [];
    for (let i = 0; i < HULL_GLOW_MAX_LIGHTS; i++) {
        positions.push(new THREE.Vector3());
        colors.push(new THREE.Color());
        normals.push(new THREE.Vector3(0, 1, 0));
        halfW.push(new THREE.Vector3(1, 0, 0));
        halfH.push(new THREE.Vector3(0, 0, 1));
    }
    return {
        glowCount:       { value: 0 },
        glowPositions:   { value: positions },
        glowColors:      { value: colors },
        glowIntensities: { value: new Float32Array(HULL_GLOW_MAX_LIGHTS) },
        glowNormals:     { value: normals },
        glowHalfW:       { value: halfW },
        glowHalfH:       { value: halfH },
    };
}

function applyHullGlowShader(modelRoot, glowSources) {
    hullGlowEntries = glowSources.slice(0, HULL_GLOW_MAX_LIGHTS);
    hullGlowUniforms = createHullGlowUniforms();
    hullGlowUniforms.glowCount.value = hullGlowEntries.length;

    hullGlowEntries.forEach((entry, i) => {
        hullGlowUniforms.glowColors.value[i].copy(entry.color);
    });

    const patched = new Set();
    modelRoot.traverse((obj) => {
        if (!obj.isMesh || !obj.material) return;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach((mat) => {
            if (!mat || patched.has(mat) || !mat.isMeshStandardMaterial) return;
            patched.add(mat);
            patchMaterialWithHullGlow(mat);
        });
    });

    updateHullGlowUniforms();
}

function patchMaterialWithHullGlow(mat) {
    mat.userData.hullGlowPatched = true;
    mat.onBeforeCompile = (shader) => {
        shader.uniforms.glowCount       = hullGlowUniforms.glowCount;
        shader.uniforms.glowPositions   = hullGlowUniforms.glowPositions;
        shader.uniforms.glowColors      = hullGlowUniforms.glowColors;
        shader.uniforms.glowIntensities = hullGlowUniforms.glowIntensities;
        shader.uniforms.glowNormals     = hullGlowUniforms.glowNormals;
        shader.uniforms.glowHalfW       = hullGlowUniforms.glowHalfW;
        shader.uniforms.glowHalfH       = hullGlowUniforms.glowHalfH;

        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nvarying vec3 vAreaGlowWorldPos;\nvarying vec3 vAreaGlowWorldNormal;')
            .replace('#include <begin_vertex>', '#include <begin_vertex>\nvAreaGlowWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvAreaGlowWorldNormal = normalize(mat3(modelMatrix) * objectNormal);');

        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', `#include <common>
varying vec3 vAreaGlowWorldPos;
varying vec3 vAreaGlowWorldNormal;
#define HULL_GLOW_MAX ${HULL_GLOW_MAX_LIGHTS}
uniform int glowCount;
uniform vec3 glowPositions[HULL_GLOW_MAX];
uniform vec3 glowColors[HULL_GLOW_MAX];
uniform float glowIntensities[HULL_GLOW_MAX];
uniform vec3 glowNormals[HULL_GLOW_MAX];
uniform vec3 glowHalfW[HULL_GLOW_MAX];
uniform vec3 glowHalfH[HULL_GLOW_MAX];`)
            .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
// ── 面ベースエリアライト（スポットライト型・面全体均一照射） ─────────────
// 「エリア全体からスポットライトのように照らす」実装：
// 1. ライト面への垂直距離（depth）だけで主減衰させる（面内位置は関係なし）
// 2. フラグメントが面の射影内に収まるかどうかで境界の自然なフォールオフを出す
// 3. フラグメント法線との余弦則はソフトに（0値カットなし・pow圧縮）
// → エリアの端にある壁も原点から遠いからではなく「面に近い距離」で照らされる
{
    vec3 fragNormal = normalize(vAreaGlowWorldNormal);
    for (int i = 0; i < HULL_GLOW_MAX; i++) {
        if (i >= glowCount) break;
        vec3 lNorm = glowNormals[i]; // ライト面法線（照射方向）
        vec3 toFrag = vAreaGlowWorldPos - glowPositions[i];
        // 照射方向チェック：法線と反対側（裏面）は照らさない
        float depth = dot(toFrag, lNorm); // 面法線方向の符号付き距離（正=照射側）
        if (depth < 0.0) continue;        // 裏面は照らさない（透過もしない）

        // 面上への射影 UV を求める
        float wLen = length(glowHalfW[i]);
        float hLen = length(glowHalfH[i]);
        vec3 wDir = glowHalfW[i] / max(wLen, 0.0001);
        vec3 hDir = glowHalfH[i] / max(hLen, 0.0001);
        float pu = dot(toFrag, wDir);
        float pv = dot(toFrag, hDir);

        // 面上の最近接点（面の外ならクランプ）までの3D距離で減衰を計算。
        // エリアライトらしい「面全体から均等に広がる照射」の核心。
        float clampedU = clamp(pu, -wLen, wLen);
        float clampedV = clamp(pv, -hLen, hLen);
        vec3 nearest  = glowPositions[i] + wDir * clampedU + hDir * clampedV;
        vec3 toNearest = vAreaGlowWorldPos - nearest; // フラグ→最近接点
        float distSq   = dot(toNearest, toNearest);
        float attenuation = 1.0 / (distSq * 0.5 + 1.0);

        // ── nDotL ──
        // lNorm固定ランバート：三角アーティファクトが出ない安定した計算。
        // smoothstepの下限を負にすることで、ライト法線と平行な壁（dot=0付近）にも
        // 適度な明るさを与え、完全に暗くなるのを防ぐ。
        float nDotL = smoothstep(-0.3, 1.0, dot(fragNormal, -lNorm));

        // 面外フォールオフ（面の外に出るほど減衰）
        float outerU2    = max(abs(pu) - wLen, 0.0);
        float outerV2    = max(abs(pv) - hLen, 0.0);
        float outerDist2 = outerU2 * outerU2 + outerV2 * outerV2;
        float edgeFade   = 1.0 / (outerDist2 * 0.8 + 1.0);

        // 正面チェック（depthが小さいほど弱く、境界をソフトに）
        float frontFactor = smoothstep(0.0, 0.1, depth / (sqrt(distSq) + 0.001));

        reflectedLight.directDiffuse += glowColors[i] * glowIntensities[i]
                                       * attenuation * nDotL * edgeFade * frontFactor;
    }
}`);
    };
    mat.needsUpdate = true;
}

// ============================================================
//  Stage 3: 船体曲げシェーダー（ホギング/サギングの視覚表現）
//  21-bow-stern-effects.js の hogSagUniforms / computeHogSagAmount() と対になる。
//  hull-glowと同じ「マテリアルをtraverseしてonBeforeCompileを仕込む」手法を使うが、
//  同一マテリアルに両方のパッチが乗る場合があるため、既存のonBeforeCompileを
//  破棄せずチェーン（先に呼んでから自分の処理を足す）する。
// ============================================================
function applyHogSagBendShader(modelRoot) {
    const hp = window.hullProfile;
    if (!modelRoot || !importedModelGroup || !hp || !hp.ready) return;
    if (typeof createHogSagUniforms !== 'function') return; // 21-bow-stern-effects.js未読込

    if (!hogSagUniforms) hogSagUniforms = createHogSagUniforms();
    hogSagUniforms.halfLen.value = Math.max(0.1, hp.halfLen);
    const axisKey = hp.xIsForward ? 'x' : 'z'; // scanHullProfile()の長軸判定と揃える

    importedModelGroup.updateWorldMatrix(true, true);
    const invGroupMat = new THREE.Matrix4().copy(importedModelGroup.matrixWorld).invert();
    const tmpPos = new THREE.Vector3();
    const patched = new Set();

    modelRoot.traverse((node) => {
        if (!node.isMesh || !node.geometry) return;
        // scanHullProfile()が除外するscrew/rudder/mast/flag等は曲げない
        // （船体本体のみを弓なりに曲げる軽量近似）。
        if (typeof _isHullScanExcluded === 'function' && _isHullScanExcluded(node)) return;

        node.updateWorldMatrix(true, false);
        const relMat = new THREE.Matrix4().multiplyMatrices(invGroupMat, node.matrixWorld);
        tmpPos.setFromMatrixPosition(relMat);
        const meshAlongOffset = axisKey === 'x' ? tmpPos.x : tmpPos.z;

        const mats = Array.isArray(node.material) ? node.material : [node.material];
        mats.forEach((mat) => {
            if (!mat || patched.has(mat) || !mat.isMeshStandardMaterial) return;
            patched.add(mat);
            patchMaterialWithHogSagBend(mat, meshAlongOffset, axisKey);
        });
    });
}

function patchMaterialWithHogSagBend(mat, meshAlongOffset, axisKey) {
    mat.userData.hogSagPatched = true;
    const hsOffsetUniform = { value: meshAlongOffset };
    const prevOnBeforeCompile = mat.onBeforeCompile; // hull-glow等、既存のパッチがあれば温存する

    mat.onBeforeCompile = (shader) => {
        if (typeof prevOnBeforeCompile === 'function') prevOnBeforeCompile(shader);

        shader.uniforms.hogSagAmount  = hogSagUniforms.amount;
        shader.uniforms.hogSagHalfLen = hogSagUniforms.halfLen;
        shader.uniforms.hsAlongOffset = hsOffsetUniform;

        shader.vertexShader = shader.vertexShader
            .replace('#include <common>', `#include <common>
uniform float hogSagAmount;
uniform float hogSagHalfLen;
uniform float hsAlongOffset;`)
            .replace('#include <begin_vertex>', `#include <begin_vertex>
{
    // ホギング/サギング: 沿岸軸(${axisKey})方向の位置に応じた放物線状のYオフセット。
    // hogSagAmount>0=中央が持ち上がる(ホギング), <0=中央が沈む(サギング)。
    float _hsAlong = transformed.${axisKey} + hsAlongOffset;
    float _hsT = clamp(_hsAlong / max(hogSagHalfLen, 0.001), -1.0, 1.0);
    transformed.y += hogSagAmount * (1.0 - _hsT * _hsT);
}`);
    };
    mat.needsUpdate = true;
}

// 毎フレーム：ライト面のワールド変換を計算してGPUへ送る。
// Blenderエリアライトのローカル座標系：Y軸が法線（照射方向）、XとZが面の幅・高さ。
// scaleはノードのscaleから取得（width=1,height=1でもscaleに実サイズが入っている）。
const _glowMat  = new THREE.Matrix4();
const _glowPos  = new THREE.Vector3();
const _glowNorm = new THREE.Vector3();
const _glowW    = new THREE.Vector3();
const _glowH    = new THREE.Vector3();
const _glowScale = new THREE.Vector3();
const _glowQuat  = new THREE.Quaternion();

function updateHullGlowUniforms() {
    if (!hullGlowUniforms || hullGlowEntries.length === 0) return;
    hullGlowEntries.forEach((entry, i) => {
        const node = entry.node; // エリアライトのObject3D（scaleにサイズが入っている）
        node.updateWorldMatrix(true, false);
        _glowMat.copy(node.matrixWorld);

        // ワールド座標でのスケール・回転を取り出す
        _glowMat.decompose(_glowPos, _glowQuat, _glowScale);

        // 法線 = ローカルY軸のワールド方向
        _glowNorm.set(0, 1, 0).applyQuaternion(_glowQuat).normalize();
        // 幅方向 = ローカルX軸 × ワールドスケールX（面の実半幅）
        _glowW.set(1, 0, 0).applyQuaternion(_glowQuat).multiplyScalar(_glowScale.x * 0.5);
        // 高さ方向 = ローカルZ軸 × ワールドスケールZ（面の実半高さ）
        _glowH.set(0, 0, 1).applyQuaternion(_glowQuat).multiplyScalar(_glowScale.z * 0.5);

        hullGlowUniforms.glowPositions.value[i].copy(_glowPos);
        hullGlowUniforms.glowNormals.value[i].copy(_glowNorm);
        hullGlowUniforms.glowHalfW.value[i].copy(_glowW);
        hullGlowUniforms.glowHalfH.value[i].copy(_glowH);

        const visible = entry.light.visible ? 1.0 : 0.0;
        // 以前はPointLightの直接照明（標準ライトループ）+ このシェーダー加算の二重構成だった。
        // PointLightをシーンから外した分、ここで強度を約2倍に補正し、見た目の明るさを維持する。
        // 減衰・余弦則は最近接点（面全体）ベースなので、エリアの端でも自然に減衰する。
        hullGlowUniforms.glowIntensities.value[i] = entry.light.intensity * 2.4 * visible;
    });
}


// 昼夜で自動的にON/OFFできるよう基準のemissiveIntensityを記録する。
// 赤・緑（航行灯の色）に近いマテリアルは舷灯レンズ等とみなし対象外にする
// （航行灯は既存の航行灯トグル/夜間判定で別途制御されるため）。
function registerWindowGlowMaterial(mat) {
    if (!mat || !mat.emissive) return;
    const c = mat.emissive;
    if (c.r < 0.02 && c.g < 0.02 && c.b < 0.02) return; // 発光していないマテリアルは対象外
    const isPureRed = c.r > 0.6 && c.g < 0.3 && c.b < 0.3;
    const isPureGreen = c.g > 0.6 && c.r < 0.3 && c.b < 0.3;
    if (isPureRed || isPureGreen) return; // 航行灯レンズは対象外
    if (mat.userData.baseEmissiveIntensity == null) {
        mat.userData.baseEmissiveIntensity = (mat.emissiveIntensity != null) ? mat.emissiveIntensity : 1.0;
    }
    if (windowGlowMaterials.indexOf(mat) === -1) windowGlowMaterials.push(mat);
}

// v135-fix: メッシュ単体のワールド座標(mesh.getWorldPosition)だけに頼ると、
// 窓が1個ずつ別オブジェクトになっているモデル(例: Teutonic)では問題ないが、
// 窓が1個の結合メッシュにまとまっているモデル(例: Mauretania、Blenderの
// 結合(Join)操作でよく起きる)だと、集まる代表点がそのメッシュのピボット1点
// だけになってしまう。ピボット位置は結合時にアクティブだったオブジェクトの
// 原点になっていることが多く、実際の窓の分布とは無関係な場所になりがちで、
// 結果的にPointLightが実質どこにも効いていないように見える不具合があった。
// 対策：メッシュのノード座標1点に頼るのではなく、メッシュの頂点データ自体を
// 「頂点共有で繋がった部品(連結成分)」ごとにクラスタリングし、各クラスタの
// v169: メッシュ（ノード）1個全体の形状を判定するための指標を計算する。
// 「窓のような細長い面」か「プロムナードライトのような丸い/正方形に近い塊」かを
// 見分けるために使う。ワールド座標のbboxで見ると、扁平な円盤形オブジェクト
// （半径に対して厚みが薄い照明カバー等）が細長い窓と混同されるケースがあるため、
// メッシュの主法線方向を軸の1つとみなし、それに直交する平面へ全頂点を投影した
// 上での2次元アスペクト比を使う（円形/正方形の断面ならほぼ1、細長い矩形なら
// 小さい値になる）。結果はmesh.userDataにキャッシュする。
// 戻り値: { aspect: 0〜1の値(1に近いほど円形), maxWorldDim: ワールド座標での最大辺長 } | null(法線なし等で判定不能)
function computeMeshShapeInfo(mesh) {
    if (mesh.userData._wgShapeInfoCache !== undefined) return mesh.userData._wgShapeInfoCache;
    const geom = mesh.geometry;
    const posAttr = geom && geom.attributes && geom.attributes.position;
    const normAttr = geom && geom.attributes && geom.attributes.normal;
    if (!posAttr || !normAttr || posAttr.count === 0) {
        mesh.userData._wgShapeInfoCache = null;
        return null;
    }
    const vCount = posAttr.count;
    // 平均法線を求める（面ごとに向きが違っても、球のような閉曲面全体では
    // 法線が概ね打ち消し合うため、代わりに「最初の頂点の法線」を代表方向として使う。
    // 円盤状オブジェクトは全体でおおよそ同じ厚み方向を向いているはずなので、
    // 1頂点のサンプルでも十分実用的——サンプル法線が偶然ノイズだった場合の
    // リスクよりも、全頂点平均で相殺してゼロベクトルになるリスクの方が大きいため）。
    const n = new THREE.Vector3().fromBufferAttribute(normAttr, 0);
    if (n.lengthSq() < 1e-10) {
        mesh.userData._wgShapeInfoCache = null;
        return null;
    }
    n.normalize();
    const u = new THREE.Vector3();
    if (Math.abs(n.x) < 0.9) u.set(1, 0, 0); else u.set(0, 1, 0);
    u.cross(n).normalize();
    const v = new THREE.Vector3().crossVectors(n, u).normalize();

    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    let localMin = new THREE.Vector3(Infinity, Infinity, Infinity);
    let localMax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    const vtmp = new THREE.Vector3();
    for (let i = 0; i < vCount; i++) {
        vtmp.fromBufferAttribute(posAttr, i);
        const du = vtmp.dot(u), dv = vtmp.dot(v);
        if (du < uMin) uMin = du; if (du > uMax) uMax = du;
        if (dv < vMin) vMin = dv; if (dv > vMax) vMax = dv;
        localMin.min(vtmp); localMax.max(vtmp);
    }
    const uSpan = uMax - uMin, vSpan = vMax - vMin;
    const longSpan = Math.max(uSpan, vSpan), shortSpan = Math.min(uSpan, vSpan);
    const aspect = longSpan > 1e-6 ? shortSpan / longSpan : 0;

    // ワールドスケールでの最大辺長（結合メッシュ除外の判定用）。
    // スケールの非一様性は考慮せず、ローカルbboxの対角長にmatrixWorldの
    // 平均スケール係数を掛けた近似値で十分（厳密なワールドbboxはコストが高いため）。
    const localSize = new THREE.Vector3().subVectors(localMax, localMin);
    const scaleVec = new THREE.Vector3().setFromMatrixScale(mesh.matrixWorld);
    const avgScale = (scaleVec.x + scaleVec.y + scaleVec.z) / 3;
    const maxWorldDim = Math.max(localSize.x, localSize.y, localSize.z) * avgScale;

    const result = { aspect, maxWorldDim };
    mesh.userData._wgShapeInfoCache = result;
    return result;
}

// 重心をワールド座標に変換して代表点として使う。窓が別オブジェクトのモデル
// では1メッシュ≒1クラスタになり従来とほぼ同じ結果になり、結合済みモデル
// でも個々の窓の分布に沿った配置に戻る。読み込み時に1回だけ走る処理なので
// 数万頂点規模でもコストは問題にならない（結果はmesh.userDataにキャッシュ）。
function clusterMeshWindowPositions(mesh) {
    if (mesh.userData._wgClusterCache) return mesh.userData._wgClusterCache;
    const geom = mesh.geometry;
    const posAttr = geom && geom.attributes && geom.attributes.position;
    if (!posAttr) { mesh.userData._wgClusterCache = []; return []; }
    const normAttr = geom.attributes.normal; // v148-fix3: 無い場合もあるのでnullチェック必須
    const vCount = posAttr.count;
    const parent = new Int32Array(vCount);
    for (let i = 0; i < vCount; i++) parent[i] = i;
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    function union(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }

    const idxAttr = geom.index;
    if (idxAttr) {
        const idx = idxAttr.array;
        for (let i = 0; i + 2 < idx.length; i += 3) {
            union(idx[i], idx[i + 1]); union(idx[i + 1], idx[i + 2]);
        }
    } else {
        for (let i = 0; i + 2 < vCount; i += 3) {
            union(i, i + 1); union(i + 1, i + 2);
        }
    }

    // ルートごとに頂点をローカル座標で集計（重心・頂点数）。
    // v148-fix3: 法線も同時に平均する。これは後段でライトを窓面から外側へ
    // わずかに押し出す（nudgeする）ために使う（下記buildWindowGlowLights参照）。
    const rootSum = new Map(); // root -> {x,y,z,n, nx,ny,nz, verts:[i,...]}
    const tmp = new THREE.Vector3();
    const tmpN = new THREE.Vector3();
    for (let i = 0; i < vCount; i++) {
        const r = find(i);
        tmp.fromBufferAttribute(posAttr, i);
        let e = rootSum.get(r);
        if (!e) { e = { x: 0, y: 0, z: 0, n: 0, nx: 0, ny: 0, nz: 0, verts: [] }; rootSum.set(r, e); }
        e.x += tmp.x; e.y += tmp.y; e.z += tmp.z; e.n++;
        e.verts.push(i);
        if (normAttr) {
            tmpN.fromBufferAttribute(normAttr, i);
            e.nx += tmpN.x; e.ny += tmpN.y; e.nz += tmpN.z;
        }
    }

    // 頂点数が極端に少ない断片（リベット等のゴミ片）は除外し、ワールド座標へ変換。
    // v148-fix3: 当初はクラスタの生の重心をそのまま返し、バケツ平均した「後」に
    // 押し出す方式にしていたが、Mauretania実データで検証したところ問題が見つかった。
    // 1バケツは最大250個超のクラスタを平均するため、結果の座標が「特定の窓のすぐ
    // 外側」ではなく「船内の広い空間の中途半端な場所」に落ちてしまい、そこから
    // 平均法線方向へ押し出しても近くの壁を確実にクリアできる保証が無かった
    // （実際、多くのバケツでは押し出し前から最寄りの他メッシュ頂点まで40〜50
    // ユニットも離れており、逆に「本当に窓のすぐ内側にあった」バケツは数ユニット
    // しか無かった＝バケツ平均が窓の実際の位置を代表できていなかった）。
    // 対策：押し出しをバケツ平均の「前」、クラスタ1個＝窓1枚ごとに個別に行う。
    // 各クラスタは実際に1枚の窓ガラスの範囲に閉じているため、その重心・法線・
    // extentはその窓の実寸をそのまま反映する。実データで検証したところ、
    // クラスタ単位での押し出し（extentの約1.8倍）後は、最寄りの他メッシュ頂点
    // までの距離が平均12〜19、最小でも7.5〜9.8ユニットまで改善した
    // （押し出し前は2〜8.7ユニットで、内壁のすぐそばに埋もれていた）。
    // 個別に押し出し済みの点をバケツ平均すれば、平均後の位置も自然と各窓の
    // 外側寄りに保たれる。
    const NUDGE_MULT = 1.8;
    const MIN_VERTS = 6;
    const out = [];
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
    const vtmp = new THREE.Vector3();
    rootSum.forEach((e) => {
        if (e.n < MIN_VERTS) return;
        const local = new THREE.Vector3(e.x / e.n, e.y / e.n, e.z / e.n);
        const worldPos = mesh.localToWorld(local.clone());
        // v151-fix: 押し出し（nudge）前のワールドY座標を退避しておく。天窓ドームの
        // ように面法線が上下左右さまざまな方向を向く構造では、押し出し後の座標は
        // 実データ検証で「押し出し前はY幅3.3だったのに押し出し後は16超に拡散する」
        // ケースが見つかっており、デッキ（高さ）帯の判定には向かない。下の
        // buildWindowGlowLights()内splitByYBand()では、こちらの押し出し前Y座標を使う
        // （配置そのものは従来通り押し出し後のworldPosを使うので、v148-fix3の効果は
        // 維持される）。
        const preNudgeY = worldPos.y;
        let extent = 0;
        for (let k = 0; k < e.verts.length; k++) {
            vtmp.fromBufferAttribute(posAttr, e.verts[k]);
            mesh.localToWorld(vtmp);
            extent = Math.max(extent, worldPos.distanceTo(vtmp));
        }
        if (normAttr) {
            const n = new THREE.Vector3(e.nx, e.ny, e.nz);
            if (n.lengthSq() > 1e-10) {
                n.applyMatrix3(normalMatrix).normalize();
                worldPos.addScaledVector(n, extent * NUDGE_MULT);
            }
        }
        worldPos._preNudgeY = preNudgeY;
        worldPos._extent = extent; // v169: プロムナードライト用の小型PointLightのdistance算出に使う
        out.push(worldPos);
    });
    mesh.userData._wgClusterCache = out;
    return out;
}

// v147: windowGlowLightsをシーンから外す際、shadow.map（GPU上のRenderTarget、
// PointLightは立方体マップなので6面ぶん）も一緒に破棄する。remove()だけでは
// Three.jsはVRAMを自動解放しないため、モデルを何度も読み替えると解放し忘れた
// 分のシャドウマップが蓄積してしまう（v91で対応したテクスチャ解放漏れと同種の
// 問題。以下、castShadow有効化に伴い新規に必要になった後始末）。
function disposeWindowGlowLight(l) {
    if (l.shadow && l.shadow.map) { l.shadow.map.dispose(); l.shadow.map = null; }
    if (l.parent) l.parent.remove(l);
}

// v151-fix: buildWindowGlowLights()は元々、船全体のemissive窓クラスタを単一の
// プールとして扱い、「舷（左右、v148-fix2）」でのみグループ分けした上で船の全長
// 方向にソート→バケツ分割していた。この方式は、Mauretania2.glbのように舷窓
// （下層デッキ、多数）とプロムナードデッキ等の窓（上層デッキ、少数）が同じ結合
// メッシュに含まれ、かつ全長方向でほぼ同じ範囲に分布しているケースでは、同じ
// バケツ内で高さの異なる2種類の窓クラスタが混ざり合い、平均座標が数の多い舷窓側
// の高さに引っ張られてしまう。
//
// アップロードされたMauretania2.glb実データをPython側で検証（union-find相当の
// 連結成分クラスタリングを再現）したところ、実クラスタ数2078個のうちY座標
// （押し出し前）でおよそ1400個が下層3列（Y≈1.4/2.7/4.0付近、舷窓とみられる）、
// 残り650個強が上層2列（Y≈7.3/7.8付近、プロムナードデッキ窓とみられる）に
// 分かれており、両者の間（Y≈4.9〜7.2あたり）は疎になっていることを確認した
// （大津の二値化法で求めた最良分割点はY≈4.9、境界を挟んだ2群の分散比
// between/total≈0.75）。この構造で「舷だけ」の分割を行うと、下層側クラスタが
// 4倍以上多いため、同じ全長区間のバケツは高さ方向の平均が下層寄りに引っ張られ、
// 上層窓の近くには実質ライトが置かれない。結果、「舷窓は船内を照らすのに、
// 上のデッキの窓はあまり照らさない」という報告どおりの見え方になる。
// （比較用に検証したRMS_Teutonic1971-4.glbには、天窓以外にemissive窓メッシュが
// 存在しない＝競合する高さ帯が無いため、この問題はそもそも発生しない）
//
// 対策：ライトを舷だけでなく「デッキ帯（高さ）」でも分けてから配置する
// （下のsplitByYBand）。高さのグルーピングは大津の二値化法（Otsu's method、
// 「2グループに分けたときに群間分散が最大になる境界」を求める標準的な統計
// 手法）で候補境界を求める。
//
// 注意：群間分散比（between/total）だけでは「2つの高さ帯に分かれている」ことの
// 判定として不十分だった。検証の結果、単一の連続した山（例えば正規分布1個）でも
// 最適な2分割点では群間分散比が約0.64にもなることを確認しており（中央値で割れば
// 上下半分の平均は自然と離れるため）、0.5前後の閾値では「本当は1デッキしか無い
// 単一構造」まで誤って2帯に分割してしまう。実際、この閾値だけのバージョンを
// 合成データ（単峰分布）でテストしたところ誤検出が再現した。
// 対策：群間分散比に加えて、分割点に「実際に密度が疎な区間（すきま）」が
// あることも要求する。分割点のギャップが、両グループそれぞれの内部での典型的な
// 点間隔より十分広い場合のみ分割を採用する（Mauretania実データでは分割点の
// ギャップが両グループ内典型間隔の45〜129倍あった一方、単峰分布ではこの比は
// 1前後にしかならない）。この2条件（分散比0.5以上 かつ ギャップ比4倍以上）の
// 両方を満たす場合のみ2帯に分割し、どちらか一方でも満たさない曖昧なケース
// （天窓のような単一構造で、たまたま少しばらけているだけ、等）は従来通り
// 1帯のまま扱う。
//
// 高さの判定にはclusterMeshWindowPositions()が退避したpreNudgeY（面から押し出す
// 前のワールドY）を使う。押し出し後の座標をそのまま使うと、天窓ドームのように
// 面法線が上下左右さまざまな方向を向く構造では、押し出しによって元の構造には
// 無いY方向のばらつきが生まれてしまう（RMS_Teutonic1971-4.glbの天窓で実測：
// 押し出し前Y幅3.3→押し出し後16.4に拡散、格子状の桟に連結成分のextentが
// 大きいものが含まれるため）。これをそのまま高さ判定に使うと、単一構造を
// 誤って2帯に分割しかねない。
const Y_BAND_MIN_VARIANCE_RATIO = 0.5;
const Y_BAND_MIN_GAP_RATIO = 4; // 分割点のすきまが、両グループ内の典型間隔の何倍以上あれば「本物のすきま」とみなすか
const Y_BAND_MIN_SAMPLES = 8; // これ未満のクラスタ数では統計的に分割判定しない
function splitByYBand(positions) {
    if (positions.length < Y_BAND_MIN_SAMPLES) return [positions];
    const yOf = (p) => (p._preNudgeY != null ? p._preNudgeY : p.y);
    const ys = positions.map(yOf).sort((a, b) => a - b);
    const nn = ys.length;
    const totalSum = ys.reduce((a, b) => a + b, 0);
    const mean = totalSum / nn;
    const totalVar = ys.reduce((a, y) => a + (y - mean) * (y - mean), 0) / nn;
    if (totalVar < 1e-9) return [positions]; // ほぼ同一平面なら分割不要

    let bestScore = -1, bestI = -1, cumSum = 0;
    for (let i = 1; i < nn; i++) {
        cumSum += ys[i - 1];
        const w0 = i / nn, w1 = 1 - w0;
        const m0 = cumSum / i, m1 = (totalSum - cumSum) / (nn - i);
        const between = w0 * w1 * (m0 - m1) * (m0 - m1);
        if (between > bestScore) { bestScore = between; bestI = i; }
    }
    if (bestScore / totalVar < Y_BAND_MIN_VARIANCE_RATIO) return [positions];

    // 分割点の実ギャップと、両グループ内の典型間隔を比較する
    const gapAtSplit = ys[bestI] - ys[bestI - 1];
    const lowerSpan = ys[bestI - 1] - ys[0];
    const upperSpan = ys[nn - 1] - ys[bestI];
    const avgSpacingLower = bestI > 1 ? lowerSpan / (bestI - 1) : gapAtSplit;
    const avgSpacingUpper = (nn - bestI) > 1 ? upperSpan / (nn - bestI - 1) : gapAtSplit;
    const typicalSpacing = Math.max(avgSpacingLower, avgSpacingUpper, 1e-9);
    if (gapAtSplit < Y_BAND_MIN_GAP_RATIO * typicalSpacing) return [positions];

    const splitY = (ys[bestI - 1] + ys[bestI]) / 2;
    const lowerBand = positions.filter(p => yOf(p) <= splitY);
    const upperBand = positions.filter(p => yOf(p) >  splitY);
    if (lowerBand.length === 0 || upperBand.length === 0) return [positions];
    return [lowerBand, upperBand];
}

// v151-fix: ライト本数予算を複数グループ（デッキ帯、舷など）へクラスタ数に応じて
// 按分する共通ヘルパー。各グループはクラスタが1つでもあれば最低1灯を保証し、
// 残りは剰余最大法（largest remainder method）で配分する。元々は左右2分割専用
// だったv148-fix2のロジック（1グループ目を四捨五入、2グループ目は残り全部）と
// 数学的に同じ結果を返すことを確認済みで、それを任意グループ数に一般化したもの。
function allocateLightBudget(groupSizes, totalLights) {
    const m = groupSizes.length;
    const counts = new Array(m).fill(0);
    const nonEmpty = groupSizes.map(s => s > 0);
    const nonEmptyCount = nonEmpty.filter(Boolean).length;
    if (nonEmptyCount === 0) return counts;

    // 予算がグループ数より少ない極端なケース：クラスタ数が多い方から優先的に1灯ずつ
    if (totalLights <= nonEmptyCount) {
        const order = groupSizes.map((s, i) => i).filter(i => nonEmpty[i])
            .sort((a, b) => groupSizes[b] - groupSizes[a]);
        for (let k = 0; k < totalLights && k < order.length; k++) counts[order[k]] = 1;
        return counts;
    }

    const totalClusters = groupSizes.reduce((a, b) => a + b, 0);
    const remaining = totalLights - nonEmptyCount;
    const exact = groupSizes.map(s => totalClusters > 0 ? remaining * s / totalClusters : 0);
    for (let i = 0; i < m; i++) counts[i] = (nonEmpty[i] ? 1 : 0) + Math.floor(exact[i]);
    let leftover = totalLights - counts.reduce((a, b) => a + b, 0);
    const order = exact.map((e, i) => ({ i, frac: e - Math.floor(e) }))
        .filter(o => nonEmpty[o.i])
        .sort((a, b) => b.frac - a.frac);
    for (let k = 0; k < leftover && k < order.length; k++) counts[order[k].i]++;
    return counts;
}

// v168: 窓明かりPointLight方式に加えて、発光メッシュ自体をやんわり照らす
// 環境光として扱うためのライトプローブ(球面調和/SH)を計算するヘルパー群。
//
// 背景：v147→v148で窓明かりPointLightを4→8灯に増やし影も有効化したことで、
// 「船内の狭い区画を少数の点光源＋指向性シャドウだけでカバーする」構造的な
// 弱点が表面化した。窓のあるデッキでも、たまたまPointLightのシャドウカメラの
// 死角に入った区画は真っ暗になり、逆に光源の正面はほぼ白飛びするほど明るい
// ——という「半分だけ煌々・半分真っ暗」のムラが起きていた。
//
// 対策として、PointLightは代表的な発光クラスタのみ少数残し（灯数削減により
// 影のコスト・ムラの双方を緩和）、それとは別に「船内全体がほんのり
// 底上げされる」環境光をライトプローブで追加する。ライトプローブは指向性の
// 影を持たない（＝原理的にムラが出ない）ため、点光源だけでは光が届きにくい
// 区画の「真っ暗」を防ぐ役割に向いている。Blender Cyclesのような発光メッシュ
// からの本物のグローバルイルミネーション計算はスマホGPUでは不可能なため、
// 「発光メッシュ群の位置・色を1回だけ解析し、その分布を球面調和(SH)9係数に
// 焼き込んで環境光として近似する」簡易版とする。
//
// SHの基底関数（3次、9項）。標準的な実時間グラフィックスの定義に準拠。
const SH_BASIS = [
    () => 0.282095, // L0
    (x, y, z) => 0.488603 * y, // L1
    (x, y, z) => 0.488603 * z,
    (x, y, z) => 0.488603 * x,
    (x, y, z) => 1.092548 * x * y, // L2
    (x, y, z) => 1.092548 * y * z,
    (x, y, z) => 0.315392 * (3 * z * z - 1),
    (x, y, z) => 1.092548 * x * z,
    (x, y, z) => 0.546274 * (x * x - y * y),
];

// windowGlowMeshEntriesから収集した発光クラスタ点群を、船の中心付近を
// 観測点とみなしたSH9係数(RGB各9個=27個)に投影する。
// 各クラスタ点は「その方向から光が来る」1サンプルとして扱う簡易モデル
// （本物のGIのような相互反射・可視性判定は行わない——スマホGPUで
// リアルタイムに解けない計算なので、位置と色の分布だけを近似的に反映する）。
function computeWindowGlowProbeSH(wPositions, probeOrigin, lightColor, perPointWeight) {
    const coeffs = [];
    for (let i = 0; i < 9; i++) coeffs.push(new THREE.Vector3(0, 0, 0));
    if (wPositions.length === 0) return coeffs;

    const dir = new THREE.Vector3();
    wPositions.forEach((p) => {
        dir.subVectors(p, probeOrigin);
        const dist = dir.length();
        if (dist < 0.001) return;
        dir.multiplyScalar(1 / dist); // 正規化
        // 距離減衰（逆二乗だと近接クラスタだけが支配的になりすぎるため、
        // PointLightのdecay=1.5と揃えた緩やかめのカーブにする）
        const atten = 1 / Math.max(1, Math.pow(dist, 1.5));
        const w = perPointWeight * atten;
        for (let i = 0; i < 9; i++) {
            const basis = SH_BASIS[i](dir.x, dir.y, dir.z);
            coeffs[i].x += lightColor.r * basis * w;
            coeffs[i].y += lightColor.g * basis * w;
            coeffs[i].z += lightColor.b * basis * w;
        }
    });
    return coeffs;
}

// v169: プロムナードライト等（丸い照明カバー、shapeAspectが高いクラスタ）を
// 個別の小型PointLightとして配置する。窓明かり(windowGlowLights)側の
// 「少数灯+SHプローブで底上げ」という設計は、面として連続する舷窓には合うが、
// Olympicの「球」オブジェクト群（153個、天井の間隔照明）のように「多数の
// 独立した点状の光源が等間隔で並ぶ」パターンには向かない
// （少数灯に集約すると個々の光源の存在がほぼ消えてしまう。詳細はv169の
// buildWindowGlowLights側コメント参照）。そこで、こちらは1個体=1灯を維持しつつ、
// 影なし・短い到達距離にすることでコストと「あり得ない範囲まで貫通する光漏れ」
// の両方を抑える。
//
// 到達距離(distance)の決め方：
// 「本来照らされるはずのない範囲（天井を貫通して煙突まで届く等）を避けたい」
// という要件から、distanceは各クラスタの実寸(extent)を基準に、ごく近傍
// （すぐ真下の床・すぐ上の天井程度）だけをカバーするよう保守的に短くする。
// 影を計算しない（castShadow=false）ため、幾何学的な遮蔽再現はできず、
// 「距離を短く絞る」ことだけが貫通を防ぐ唯一の手段になる点に注意。
function buildPromenadeLights(modelRoot, roundLightPositions) {
    if (roundLightPositions.length === 0) return;

    // 全体の平均emissive色（電球色補正は窓側と同じロジックを流用）
    let rSum = 0, gSum = 0, bSum = 0;
    roundLightPositions.forEach((wp) => {
        const m = wp.userData_mat;
        rSum += m.emissive.r; gSum += m.emissive.g; bSum += m.emissive.b;
    });
    const n = roundLightPositions.length;
    const avgR = rSum / n, avgG = gSum / n, avgB = bSum / n;
    const lum = avgR * 0.299 + avgG * 0.587 + avgB * 0.114;
    const lightColor = (lum > 0.45 && avgR >= avgB)
        ? new THREE.Color(1.0, 0.82, 0.55) // 電球色
        : new THREE.Color(avgR, avgG, avgB);

    // v169: 全クラスタの実寸(extent)の中央値を基準にdistanceを決める。
    // extentはclusterMeshWindowPositions()で「クラスタ重心から最も遠い頂点までの
    // 距離」として計算済み＝照明オブジェクト自体のおおよその半径に相当する。
    // 「すぐ近くの床・天井には届くが、次のデッキや遠くの構造物までは
    // 届かない」を狙い、半径の6倍程度・上限4ユニットでクランプする
    // （Olympic実データでの球間隔の中央値が約3.4ユニットだったことを踏まえ、
    // 隣の照明の担当範囲を大きく侵食しない値として設定。天井高さの目安
    // （デッキ間隔）は多くの客船モデルで3〜4ユニット程度になることが多いため、
    // 上限4は「1デッキ分は照らせるが、2デッキ分は貫通しない」を意図している）。
    const extents = roundLightPositions.map(p => p._extent || 0.1).sort((a, b) => a - b);
    const medianExtent = extents[Math.floor(extents.length / 2)] || 0.1;
    const distance = THREE.MathUtils.clamp(medianExtent * 6, 0.5, 4.0);

    promenadeLights = roundLightPositions.map((wp) => {
        const localPos = modelRoot.worldToLocal(wp.clone());
        // decayはPointLightのデフォルト(2、物理的な逆二乗則)のままにする。
        // 窓明かりPointLight(decay=1.5)と違い、こちらは「近距離でしっかり
        // 减衰させて遠くまで漏れないようにする」ことが目的なので、緩めない。
        const pl = new THREE.PointLight(lightColor.getHex(), 0, distance, 2);
        pl.position.copy(localPos);
        pl.castShadow = false; // v169: 影は計算しない（153個規模で影ありは重すぎる上、今回は距離クランプで貫通を防ぐ方針のため不要）
        pl.userData.isPromenadeLight = true;
        pl.userData.wgBaseIntensity = 2.5; // v169: 窓明かりPointLight(18.0)より大幅に低め。1灯あたりのカバー範囲が狭い分、多灯合計での見た目の明るさで帳尻を合わせる
        modelRoot.add(pl);
        return pl;
    });
}

// v169: プロムナードライトの後片付け（モデル再構築・破棄時に呼ぶ）
function disposePromenadeLights() {
    promenadeLights.forEach((pl) => {
        if (pl.parent) pl.parent.remove(pl);
    });
    promenadeLights = [];
}

// emissiveメッシュのワールド座標をクラスタリングし、
// PointLightを配置して窓灯りが周囲を照らすようにする。
// モデルがシーンに追加されてupdateModelOffset()が完了した後（100msディレイ）に呼ぶこと。
function buildWindowGlowLights() {
    windowGlowLights.forEach(disposeWindowGlowLight);
    windowGlowLights = [];
    disposeWindowGlowLightProbe(); // v169: 舷窓が無いモデルへの切り替え等でも確実にリセットされるよう冒頭に移動
    disposePromenadeLights(); // v169: 同上、プロムナードライトも冒頭でリセット

    const modelRoot = importedModelGroup && importedModelGroup.children[0];
    if (!modelRoot || windowGlowMeshEntries.length === 0) return;

    // モデルのワールド行列を最新化
    modelRoot.updateWorldMatrix(true, true);

    // 全emissiveメッシュのワールド座標と色を収集
    // （メッシュ単位の代表点だけでなく、メッシュ内の連結成分ごとの重心も使う。
    //  上のclusterMeshWindowPositions()参照。各クラスタは既に自身の法線方向へ
    //  窓面から少し外側へ押し出し済みなので、ここでは単純にVector3として扱う）
    //
    // v169: 「窓（細長い面）」と「プロムナードライト等の照明カバー（丸い/正方形
    // に近い塊）」を仕分ける。当初はクラスタ（連結成分）単位のアスペクト比で
    // 判定を試みたが、実データ検証（Teutonic/Olympic双方のGLB）で以下が判明し、
    // メッシュ（ノード）単位の判定に変更した：
    // - プロムナードライトの球は面ごとに頂点が非共有（フラットシェーディング）で
    //   連結成分が全て3〜4頂点の極小クラスタに分裂し、MIN_VERTS足切りで消える
    // - 逆に「窓1枚」のはずが複数の窓が部分的に頂点共有されてしまうケースがあり、
    //   クラスタ単位では正方形に近い誤判定が出た
    // メッシュ単位でも「円形かどうか」だけでは、複数の窓が1メッシュにJoinされた
    // 結合メッシュ（Teutonicの「立方体.006」、1メッシュに約100枚の窓を含む）を
    // 誤って円形と判定してしまう（全体の外形が正方形に近くなるため）。これを
    // 避けるため、「円形（aspect高）」に加えて「絶対サイズが小さい（発光メッシュ
    // 全体の分布スケールに対して十分小さい）」の両方を満たすものだけを
    // プロムナードライトと判定する。結合メッシュは船体規模（十数〜数十ユニット）
    // になるため、このサイズ条件で確実に除外できる。
    //
    // v169注記：スケールの基準は当初modelRoot全体のBox3から取ろうとしたが、
    // 実データ検証でBlenderの演出用カメラノード（メッシュを持たないnull
    // オブジェクト、船体から大きく離れた座標に多数配置されていることがある）
    // まで巻き込んでバウンディングボックスが不当に膨張することが判明した。
    // 代わりに、windowGlowMeshEntries（既に発光メッシュとして検出済みの実
    // ジオメトリのみ）のワールド座標範囲を基準にする——非ジオメトリノードを
    // 拾わない上、「発光オブジェクト同士の相対スケール比較」という今回の目的にも
    // 直接合致する。
    const scaleBBox = new THREE.Box3();
    const scaleTmp = new THREE.Vector3();
    windowGlowMeshEntries.forEach(({ mesh }) => {
        if (!mesh.parent) return;
        mesh.getWorldPosition(scaleTmp);
        scaleBBox.expandByPoint(scaleTmp);
    });
    const modelSize = scaleBBox.isEmpty() ? new THREE.Vector3(1, 1, 1) : scaleBBox.getSize(new THREE.Vector3());
    const modelSpanForScale = Math.max(modelSize.x, modelSize.z, 1);
    // 実データでは結合窓メッシュが発光メッシュ分布の全長の30%超、独立照明
    // オブジェクトは数%未満だったため、余裕を持って「全長の5%以下」を
    // 「小さい」の基準にする。
    const ROUND_LIGHT_MAX_SIZE = modelSpanForScale * 0.05;
    const SHAPE_ASPECT_ROUND_THRESHOLD = 0.55;

    const wPositions = [];       // 窓（細長い面）側。従来通りクラスタリング→バケツ化→SHプローブ＋少数PointLight
    const roundLightPositions = []; // v169: プロムナードライト等（丸い塊）側。個別の小型PointLightで対応（下記buildPromenadeLights参照）
    let rSum = 0, gSum = 0, bSum = 0;
    windowGlowMeshEntries.forEach(({ mesh, mat }) => {
        if (!mesh.parent) return;

        // v169: このメッシュ全体（全プリミティブ合算ではなく、このmesh1個）の
        // ローカル頂点群から形状指標を計算する。法線が無い場合は判定不能として
        // 窓側（従来の挙動）にフォールバックする。
        const shapeInfo = computeMeshShapeInfo(mesh);
        const isRoundLight = shapeInfo &&
            shapeInfo.aspect >= SHAPE_ASPECT_ROUND_THRESHOLD &&
            shapeInfo.maxWorldDim <= ROUND_LIGHT_MAX_SIZE;

        if (isRoundLight) {
            // プロムナードライト側は個体ごとの位置精度が重要なので、
            // クラスタリング（複数点への分割）はせず、メッシュの重心1点を使う。
            const wp = new THREE.Vector3();
            mesh.getWorldPosition(wp);
            wp._extent = shapeInfo.maxWorldDim / 2;
            wp.userData_mat = mat;
            roundLightPositions.push(wp);
            return;
        }

        let pts = clusterMeshWindowPositions(mesh);
        if (pts.length === 0) {
            // クラスタリングで何も拾えなかった場合は従来通りノード座標にフォールバック
            const wp = new THREE.Vector3();
            mesh.getWorldPosition(wp);
            wp._preNudgeY = wp.y; // v151-fix: splitByYBand()向け（押し出しが無いのでそのままでよい）
            pts = [wp];
        }
        pts.forEach((wp) => {
            wPositions.push(wp);
            rSum += mat.emissive.r;
            gSum += mat.emissive.g;
            bSum += mat.emissive.b;
        });
    });

    // v169: プロムナードライト等（丸い照明カバー）は、窓とは別の専用ロジックで
    // 個別の小型PointLightを配置する（詳細はbuildPromenadeLights参照）。
    // wPositionsが空でもroundLightPositionsだけ存在するケース（例：窓のない
    // 甲板部分のみのメッシュ登録）もありうるため、こちらは早期returnの前に処理する。
    buildPromenadeLights(modelRoot, roundLightPositions);

    if (wPositions.length === 0) return;


    // 平均emissive色を計算（ほぼ白→電球色に補正）
    const n = wPositions.length;
    const avgR = rSum / n, avgG = gSum / n, avgB = bSum / n;
    const lum = avgR * 0.299 + avgG * 0.587 + avgB * 0.114;
    let lightColor;
    if (lum > 0.45 && avgR >= avgB) {
        lightColor = new THREE.Color(1.0, 0.82, 0.55); // 電球色
    } else {
        lightColor = new THREE.Color(avgR, avgG, avgB);
    }

    // ワールド空間でのバウンディングボックス（reach・軸判定・本数の算出用。
    // 個々のライトの配置には使わない — 理由は下のv147-fix2参照）
    const bbox = new THREE.Box3();
    wPositions.forEach(p => bbox.expandByPoint(p));
    const bsize = bbox.getSize(new THREE.Vector3());

    // v168: ライトプローブ用のSH係数をここで計算する。観測点は発光クラスタ
    // 群の中心（bboxの中心）。1個のプローブで船全体を代表させる簡易版
    // ——観測点を複数に分けて船内をブロックごとに補間する方式(LightProbe
    // 複数配置+距離ブレンド)はより精度が上がるが、まずは1個で様子を見る。
    // 見た目のムラが気になる場合はデッキ帯(yBands、後述)ごとに分けることを検討。
    const probeOrigin = bbox.getCenter(new THREE.Vector3());
    // 1点あたりの重みはクラスタ総数で正規化し、窓の数が多い船ほど
    // 1点あたりが薄まる形にする（総発光量が概ね一定になるように）
    const perPointWeight = 4.0 / Math.max(1, wPositions.length);
    const probeSH = computeWindowGlowProbeSH(wPositions, probeOrigin, lightColor, perPointWeight);

    // 船の長手方向（X/Z どちらが長いか）に沿って均等配置
    const useX  = bsize.x >= bsize.z;
    const span  = useX ? bsize.x : bsize.z;
    // 幅は短手方向。PointLightの届く距離は船幅の4〜5倍（水面・甲板まで届く範囲）
    const shipWidth = useX ? bsize.z : bsize.x;
    const reach = Math.max(shipWidth * 5, 14);

    // v168: PointLightはライトプローブと役割分担する形に変更。プローブが
    // 「船内全体の底上げ・ムラの解消」を担うため、PointLightは「窓際の
    // 明るいアクセント・軽いシャドウディテール」だけに絞り、本数を
    // 大幅に削減する（8→3）。これによりcastShadowのコスト
    // （立方体マップ6面×灯数）も8→3灯分に減り、v147比でもまだ増加は
    // 残るが、v148以降と比べれば大幅に軽くなる。
    // 長さ4単位ごとに1灯、最大8灯（v147-fix2で4→8に引き上げ）。
    // v151で「デッキ帯分割により1帯あたりが薄まる」ことを懸念して8→12に
    // 引き上げたが、実機（Xperia 5 III、非力な端末ではない）で影ON品質帯
    // （low以上）が壊滅的に重くなる回帰を招いたため、v152で8に戻す。
    // PointLightの影は立方体マップ6面ぶんのコストがあり、12灯稼働時は
    // 8灯稼働時の1.5倍（6面×1024^2の深度テクスチャがさらに4灯ぶん増える）
    // というのは、モバイルGPUには軽視できない増分だった。デッキ帯を分けた
    // ことによる「各帯が薄くなる」こと自体は、正しい高さにライトが置かれる
    // という主目的に対しては副次的な問題なので、パフォーマンスを優先する。
    const numLightsTotal = Math.min(3, Math.max(1, Math.round(span / 10)));

    // v148-fix2: v147-fix2はX軸（船の全長方向）だけでソート→バケツ分割しており、
    // 左右両舷（useX時はZ軸の符号）の区別を一切していなかった。Mauretania2.glbの
    // ような「片側だけでなく船全体の窓が1回のbuildWindowGlowLightsで集約される」
    // モデルでは、同じX区間にある右舷の窓群と左舷の窓群が同一バケツに混在し、
    // その平均座標＝ほぼ船の中心線（Z≈0、外壁から500ユニット以上内側）にライトが
    // 置かれてしまっていた。verylow/ultralow（シャドウ丸ごとOFF）では光が壁を
    // 素通りするため気づきにくいが、shadowsEnabledな品質帯（low/medium/high）では
    // 中心線からわずか数百ユニット先の内壁・仕切りに光が完全に遮られ、「外壁側が
    // 光らず、船体中心の空洞付近しか照らせない」という見え方になっていた。
    // 対策：useXの場合はZ符号（左右）、useZの場合はX符号（船首尾どちら側かは
    // 通常問題にならないが対称性のため同様に扱う）でクラスタを2グループに分けた
    // 上で、それぞれ独立にソート→バケツ分割する。どちらか一方の側にクラスタが
    // 無い（左右非対称な発光配置）場合は、そちらのライト数を0にして無駄なライトを
    // 作らない。
    const sideAxis = useX ? 'z' : 'x';
    const sideEps = shipWidth * 0.02; // 中心線ちょうど上のクラスタをどちらか一方に安定して倒すための微小しきい値
    const sortAxis = useX ? 'x' : 'z';

    const buildSideBuckets = (sidePositions, sideNumLights) => {
        if (sidePositions.length === 0 || sideNumLights <= 0) return [];
        const sorted = sidePositions.slice().sort((a, b) => a[sortAxis] - b[sortAxis]);
        const nPos = sorted.length;
        const out = [];
        for (let i = 0; i < sideNumLights; i++) {
            const startIdx = Math.floor(i * nPos / sideNumLights);
            const endIdx   = Math.max(startIdx + 1, Math.floor((i + 1) * nPos / sideNumLights));
            // v148-fix3: 各クラスタ（窓1枚）は、clusterMeshWindowPositions()の時点で
            // 既に自身の法線方向へ窓面から外側へ押し出し済み（詳細は同関数のコメント
            // 参照）。ここでは単純にバケツ内の実座標を平均するだけでよい
            // （押し出し済みの点を平均するので、結果も自然と各窓の外側寄りに保たれる）。
            const worldPos = new THREE.Vector3();
            for (let k = startIdx; k < endIdx; k++) worldPos.add(sorted[k]);
            worldPos.multiplyScalar(1 / (endIdx - startIdx));
            let bucketReach = 0;
            for (let k = startIdx; k < endIdx; k++) bucketReach = Math.max(bucketReach, worldPos.distanceTo(sorted[k]));
            out.push({ worldPos, bucketReach });
        }
        return out;
    };

    // 与えられたクラスタ群を左右2舷に分け（中心線上はv148-fix2と同様に半分ずつ
    // 按分）、allocateLightBudget()で舷ごとのライト本数を決めてバケツ化する。
    // v151-fixでデッキ帯ごとにこの関数を呼び出せるよう、舷分割部分を関数化した
    // （ロジック自体はv148-fix2から変更なし）。
    const buildGroupBuckets = (positions, lightBudget) => {
        const posSide = positions.filter(p => p[sideAxis] >  sideEps);
        const negSide = positions.filter(p => p[sideAxis] < -sideEps);
        const zeroSide = positions.filter(p => Math.abs(p[sideAxis]) <= sideEps);
        zeroSide.forEach((p, i) => (i % 2 === 0 ? posSide : negSide).push(p));
        const [numPos, numNeg] = allocateLightBudget([posSide.length, negSide.length], lightBudget);
        return [
            ...buildSideBuckets(posSide, numPos),
            ...buildSideBuckets(negSide, numNeg),
        ];
    };

    // v151-fix: デッキ帯（高さ）でグループ分けしてから、各帯ごとに上の舷分割・
    // バケツ化を行う。詳細は上のsplitByYBand()のコメント参照。天窓のみ・単一
    // デッキのみのモデルではyBandsは常に長さ1（=wPositions全体）になり、
    // 下記ロジックはv148-fix2までと完全に同じ結果になる。
    const yBands = splitByYBand(wPositions);
    const bandBudgets = allocateLightBudget(yBands.map(b => b.length), numLightsTotal);
    const buckets = [];
    yBands.forEach((bandPositions, bi) => {
        buildGroupBuckets(bandPositions, bandBudgets[bi]).forEach((b) => {
            b.bandIndex = bi; // v151-debug: debugWindowGlowLights()でどのデッキ帯由来か確認できるように
            buckets.push(b);
        });
    });

    // v147: 影を有効にするか・マップ解像度は品質設定だけで決まるためループの外で1回計算する
    const wg = getWindowGlowShadowConfig();

    for (let i = 0; i < buckets.length; i++) {
        // v148-fix2: worldPos/bucketReachは上のbuildSideBuckets()で、左右どちらか
        // 片側のクラスタだけを対象に既に計算済み（中心線に潰れないようにするのが
        // 目的なので、ここではその結果を取り出すだけでよい）。
        const { worldPos, bucketReach, bandIndex } = buckets[i];

        // v148-fix: このバケツが実際にカバーしているクラスタまでの最大距離を
        // 求めておく。天窓ドームのように小さくまとまった構造物では、この値は
        // reach（船幅ベースの全体到達距離、≈97のような大きな値になりうる）より
        // ずっと小さい。以前はshadow.camera.farに一律reachを使っていたため、
        // 直径19ユニット程度の天窓に対して奥行97ユニット分のZバッファ精度を
        // 割り当てる形になり、実際に影を落とす格子の桟（細いジオメトリ）に
        // 使える深度分解能がほとんど残らず、bias/normalBiasの効き方が
        // キューブマップの面ごと・光源との角度ごとにばらつく原因になっていた
        // （左右対称な構造なのに片側だけ影が出ない/出すぎるように見える不具合）。
        // 影を落とす壁・桟はクラスタ点そのものよりわずかに外側にあるので余裕を
        // 持たせつつ、天窓のような密集構造でfar平面が極端に薄くなりすぎない
        // 下限、船全体規模のreachを超えない上限でクランプする。
        const shadowFar = THREE.MathUtils.clamp(bucketReach * 3 + 4, 8, reach);

        // modelRootのローカル座標系に変換してPointLightを追加
        const localPos = modelRoot.worldToLocal(worldPos.clone());
        // pl.distance（光の減衰到達距離）は従来通り船全体基準のreachを使う
        // ＝天窓の光が甲板・水面まで届く「見た目の照射範囲」はこれまで通り維持し、
        // 変えるのはシャドウの深度精度だけにする。
        // v152: decayを2（物理的に正確な逆二乗則）→1.5へ。照らす境（reach付近で
        // 減衰しきる部分）がやや急に暗転して見えるとの要望を受け、減衰カーブを
        // 緩やかにして境目をぼかす方向に調整。物理的な正確さより見た目の柔らかさを
        // 優先（他の光源と明るさの相対バランスが変わって見える場合はここを2寄りに
        // 戻すか、wgBaseIntensity側で調整すること）。
        const pl = new THREE.PointLight(lightColor.getHex(), 0, reach, 1.5);
        pl.position.copy(localPos);
        pl.userData.isWindowGlowLight = true;
        pl.userData.wgBaseIntensity   = 18.0; // フル点灯時の強さ（updateWindowGlowでスケール）
        pl.userData.wgBandIndex       = bandIndex; // v151-debug: どのデッキ帯由来か（debugWindowGlowLights参照）

        // v147-fix: このPointLightはcastShadowを立てていなかったため、壁・甲板等の
        // 遮蔽物を無視して光がそのまま突き抜け、窓明かりが船内反対側や外の海面まで
        // 漏れて見える不具合があった（v135→v136でクラスタリングにより灯りが実際の
        // 窓位置へ正しく配置されるようになった副作用で、この漏れが目立つように
        // なった）。castShadowを有効化し、壁・甲板側はapplyMaterialsToModel()で
        // 元々castShadow=trueなので正しく遮蔽されるようにする。
        // PointLightの影は立方体マップ6面ぶんのコストがあり最大8灯同時使うため
        // 相応に重いが、v148時点ではパフォーマンスより見た目の一貫性を優先し
        // getWindowGlowShadowConfig()側の解像度も引き上げている
        // （verylow/ultralowでは引き続き丸ごと無効化）。
        pl.castShadow = wg.enabled;
        if (wg.enabled) {
            pl.shadow.mapSize.set(wg.mapSize, wg.mapSize);
            pl.shadow.bias       = -0.0015; // v148: far平面を引き締めた分、精度が上がるためbiasも弱めて桟の薄い影を出やすくする
            pl.shadow.normalBias = 0.01;    // 同上。強すぎるnormalBiasは面によって影が消える方向に働いていた
            pl.shadow.camera.near = 0.1; // 窓のすぐ近くの壁・仕切りも遮蔽できるよう小さめに
            pl.shadow.camera.far  = shadowFar; // v148: reach一律ではなく、このライトが実際に照らす範囲に合わせる
            pl.shadow.radius      = 2;   // PCFSoftShadowMapの追加ソフト化（sunLightより弱め）
            // v166: 毎フレームの自動再計算をやめ、updateWindowGlow()側のローテーション式
            // 間引き更新に任せる（wgShadowUpdateInterval参照）。初回は必ず1回描画されるよう
            // needsUpdateをtrueにしておく（Three.jsのデフォルトもtrueだが明示しておく）。
            pl.shadow.autoUpdate = false;
            pl.shadow.needsUpdate = true;
        }
        pl.userData.wgShadowSlot = windowGlowLights.length; // v166: ローテーション間引きで自分の担当フレームを判定するための番号
        modelRoot.add(pl);
        windowGlowLights.push(pl);
    }

    // v168: ライトプローブを追加。SH係数は上で計算済み(probeSH)。
    // modelRootの子にして船に追従させる（船の移動・多少の回転はプローブにも
    // 反映されるべきなので、windowGlowLightsのPointLightと同じ扱いにする。
    // 大きく旋回した際にSHの方向性が実際の窓配置とズレる可能性はあるが、
    // プローブは元々「ほんのり底上げ」が目的で強い指向性を持たせていない
    // ため、影響は軽微なはず）。
    // v169: 破棄は関数冒頭のdisposeWindowGlowLightProbe()で既に済んでいるので、
    // ここでは新規作成のみでよい。
    windowGlowLightProbe = new THREE.LightProbe();
    // 注：THREE.LightProbeのpositionは主にヘルパー表示・将来のマルチプローブ
    // 補間用の情報で、SH自体は「その観測点から見た周囲の放射輝度分布」を
    // 表す方向依存データであり、適用時は距離減衰なしにシーン全体へ一様に
    // 反映される（PointLightのような「窓に近いほど明るい」距離感は出ない）。
    // 今回の用途（船内全体の底上げでPointLightの死角を埋める）には
    // ちょうど合う性質だが、「窓の真下だけ特に明るい」ような距離減衰込みの
    // 表現がほしくなった場合はプローブを複数配置して手動でブレンドする
    // （Three.js標準にはLightProbeの自動距離ブレンド機構は無い）必要がある。
    windowGlowLightProbe.position.copy(modelRoot.worldToLocal(probeOrigin.clone()));
    // SH係数自体（方向ごとの色分布＝発光クラスタの配置形状）はここで1回だけ焼き込み、
    // 昼夜サイクルによる明滅はintensity（全係数への一律乗数）で表現する。
    // こうすることで、updateWindowGlow()側は毎フレームintensityの数値を1個
    // 書き換えるだけで済み、SH係数の再計算(computeWindowGlowProbeSH、船全体の
    // 発光クラスタを毎回舐める重い処理)は再構築時以外走らない。
    for (let i = 0; i < 9; i++) windowGlowLightProbe.sh.coefficients[i].copy(probeSH[i]);
    windowGlowLightProbe.intensity = 0; // updateWindowGlow()が昼夜係数に応じて設定する
    windowGlowProbeBaseSH = probeSH;
    modelRoot.add(windowGlowLightProbe);
}

// v168: windowGlowLightProbeの後片付け（モデル再構築・破棄時に呼ぶ）
function disposeWindowGlowLightProbe() {
    if (windowGlowLightProbe && windowGlowLightProbe.parent) {
        windowGlowLightProbe.parent.remove(windowGlowLightProbe);
    }
    windowGlowLightProbe = null;
    windowGlowProbeBaseSH = null;
}

// v148-debug: 天窓など窓明かりPointLightの左右非対称バグ調査用の一時ヘルパー。
// ブラウザのDevToolsコンソールから直接呼び出せる。恒久機能ではないので、
// 原因を切り分けたら消してよい。
//   debugWindowGlowLights()        -> 各ライトのワールド座標・shadow設定を一覧表示
//   debugWindowGlowShadows(false)  -> 窓明かりPointLightのcastShadowを全部一時OFF
//                                      （これで甲板の光の偏りが消えるなら、原因は
//                                      シャドウ計算側。消えないなら別要因）
//   debugWindowGlowShadows(true)   -> castShadowを元に戻す
window.debugWindowGlowLights = function () {
    const wPos = new THREE.Vector3();
    windowGlowLights.forEach((pl, i) => {
        pl.getWorldPosition(wPos);
        console.log(
            `[windowGlowLight ${i}] band=${pl.userData.wgBandIndex} world=(${wPos.x.toFixed(2)}, ${wPos.y.toFixed(2)}, ${wPos.z.toFixed(2)}) ` +
            `intensity=${pl.intensity.toFixed(2)} castShadow=${pl.castShadow} ` +
            `mapSize=${pl.shadow.mapSize.x} near=${pl.shadow.camera.near} far=${pl.shadow.camera.far.toFixed(2)} ` +
            `bias=${pl.shadow.bias} normalBias=${pl.shadow.normalBias}`
        );
    });
    console.log(`Total: ${windowGlowLights.length} lights`);
};

// v151-debug: デッキ帯（高さ）分割が実際どう判定されたかを確認する一時ヘルパー。
// splitByYBand()を現在のwindowGlowMeshEntriesに対して再実行し、何帯に分かれたか・
// 各帯のクラスタ数とY範囲を表示する。1帯のまま（分割なし）と出た場合、その船は
// 元々デッキ帯混在の問題が無かった（またはY_BAND_MIN_VARIANCE_RATIOに満たない
// 曖昧なケースだった）ことを意味する。恒久機能ではないので不要になったら消してよい。
window.debugWindowGlowYBands = function () {
    const modelRoot = importedModelGroup && importedModelGroup.children[0];
    if (!modelRoot) { console.log('モデル未読み込み'); return; }
    const wPositions = [];
    windowGlowMeshEntries.forEach(({ mesh }) => {
        if (!mesh.parent) return;
        let pts = clusterMeshWindowPositions(mesh);
        if (pts.length === 0) {
            const wp = new THREE.Vector3();
            mesh.getWorldPosition(wp);
            wp._preNudgeY = wp.y;
            pts = [wp];
        }
        pts.forEach((wp) => wPositions.push(wp));
    });
    const yBands = splitByYBand(wPositions);
    console.log(`windowGlowクラスタ総数: ${wPositions.length}`);
    console.log(yBands.length === 1 ? 'デッキ帯分割: なし（1帯）' : `デッキ帯分割: ${yBands.length}帯`);
    yBands.forEach((band, i) => {
        const ys = band.map(p => (p._preNudgeY != null ? p._preNudgeY : p.y));
        console.log(`  帯[${i}] クラスタ数=${band.length} Y範囲(押し出し前)=[${Math.min(...ys).toFixed(2)}, ${Math.max(...ys).toFixed(2)}]`);
    });
};
window.debugWindowGlowShadows = function (enabled) {
    windowGlowLights.forEach((pl) => {
        pl.castShadow = enabled;
        if (pl.shadow && pl.shadow.map) {
            // 既存のシャドウマップRenderTargetを破棄して次フレームで作り直させる
            pl.shadow.map.dispose();
            pl.shadow.map = null;
        }
    });
    console.log(`windowGlowLights castShadow -> ${enabled} (${windowGlowLights.length} lights)`);
};

// v148-debug2: 「灯りの本数は合っているのに、船の一部にしか配置されない」系の
// 不具合調査用。windowGlowMeshEntries（発光メッシュとして登録された生データ）の
// 中身を直接ダンプする。各エントリについて、頂点数・クラスタリング結果の個数・
// クラスタ全体のワールドバウンディングボックスを表示する。もしメッシュ登録数が
// 想定より少ない、あるいは特定メッシュのクラスタが船の一部分に偏っているなら
// ここで直接わかる。恒久機能ではないので原因が判明したら消してよい。
window.debugWindowGlowMeshEntries = function () {
    console.log(`windowGlowMeshEntries: ${windowGlowMeshEntries.length} 件`);
    const overallBox = new THREE.Box3();
    windowGlowMeshEntries.forEach(({ mesh, mat }, i) => {
        const hasParent = !!mesh.parent;
        const posAttr = mesh.geometry && mesh.geometry.attributes && mesh.geometry.attributes.position;
        const vCount = posAttr ? posAttr.count : 0;
        const pts = hasParent ? clusterMeshWindowPositions(mesh) : [];
        const box = new THREE.Box3();
        pts.forEach((p) => box.expandByPoint(p));
        if (pts.length > 0) overallBox.union(box);
        const size = new THREE.Vector3();
        box.getSize(size);
        console.log(
            `  [${i}] mesh=${mesh.name || '(no name)'} parented=${hasParent} verts=${vCount} ` +
            `clusters=${pts.length} clusterBBoxSize=(${size.x.toFixed(1)}, ${size.y.toFixed(1)}, ${size.z.toFixed(1)}) ` +
            `material=${mat.name || '(no name)'}`
        );
    });
    const overallSize = new THREE.Vector3();
    overallBox.getSize(overallSize);
    console.log(`Overall cluster bbox size across ALL entries: (${overallSize.x.toFixed(1)}, ${overallSize.y.toFixed(1)}, ${overallSize.z.toFixed(1)})`);
};

// Blenderで「Emission Strength」を1超に設定したマテリアル（窓の発光・航行灯レンズ等）が
// 本来より暗く読み込まれてしまう。生のglTF JSONから値を読み取り、マテリアル名で対応する
// THREE.Material（読み込み済みシーン側）に emissiveIntensity として手動で反映する。
// 対象が無い/失敗した場合は何もせず元の挙動のまま。
function applyGltfEmissiveStrengthExt(modelRoot, json) {
    try {
        if (!json || !Array.isArray(json.materials) || !modelRoot) return;
        const strengthByName = new Map();
        json.materials.forEach((m) => {
            const ext = m.extensions && m.extensions.KHR_materials_emissive_strength;
            const strength = ext && ext.emissiveStrength;
            if (m.name && Number.isFinite(strength) && strength > 0) {
                strengthByName.set(m.name, strength);
            }
        });
        if (strengthByName.size === 0) return;
        const done = new Set();
        modelRoot.traverse((child) => {
            if (!child.isMesh || !child.material) return;
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            mats.forEach((mat) => {
                if (!mat || done.has(mat)) return;
                const strength = strengthByName.get(mat.name);
                if (strength && 'emissiveIntensity' in mat) {
                    mat.emissiveIntensity = (mat.emissiveIntensity != null ? mat.emissiveIntensity : 1.0) * strength;
                    done.add(mat);
                }
            });
        });
    } catch (e) { /* 失敗しても元の挙動のまま続行 */ }
}

// ============================================================
//  拡散色テクスチャからのオンザフライ法線マップ生成（v83b〜、v84で強化）
// ============================================================
// 船体モデルは拡散色(diffuse)テクスチャしか持たず法線マップが無いため、
// テクスチャに描かれたリベット列やパネル継ぎ目は「色」としては見えても、
// 光を受けて実際の凹凸として陰影がつくことはなかった。ここでは読み込んだ
// 拡散色テクスチャの輝度を疑似的な高さマップとみなし、Sobelフィルタで
// その場で法線マップを生成する。新規テクスチャファイルは不要＝どのGLBを
// 読み込んでも自動的に効く。
//
// v84: 1px間隔のSobelだけだと「くっきりした1px単位のエッジ」しか拾えず、
// 塗りでゆるやかに描かれたパネルの継ぎ目や面ごとの明暗差は勾配がほぼ0に
// 近く、結果として立体に見えていなかった。fine(1px間隔)とcoarse(数px間隔)
// の2種類のSobelを合成することで、細かいディテールとパネル単位の
// 大まかな起伏の両方を拾うようにした。coarse側は間引きサンプリングの
// ぶん単純なノイズにも強くなる。
//
// 微調整メモ: coarseの寄与(COARSE_WEIGHT)を上げすぎるとパネルの起伏が
// 「ゆるく・ぼやけた」印象になり、くっきり感が薄れる。くっきりさせたい
// ときはCOARSE_WEIGHTを下げてfine(STRENGTH)を主役にする方が効果的。
// 全体の強さはSCALE_XYで最終調整（前バージョン比で「強すぎ／弱すぎ」の
// 感覚に応じてここだけ動かすのが手っ取り早い）。
//
// 既知の制限:
// ・UVアトラス内の複数パーツの継ぎ目をまたいで微妙な勾配が出ることがある
//   （テクスチャの2D構造だけを見ており、UV島の境界までは認識していない）。
// ・元テクスチャがのっぺりした単色塗りに近いほど、当然ながら効果は薄い。
// ・逆に強すぎる/ザラつく場合は下のNORMAL_GEN_SCALE_XYを下げるか、
//   生成後に各materialのnormalScaleを個別に下げれば弱められる。
const NORMAL_GEN_MAX_SIZE = { high: 1536, medium: 1280, low: 1024 }; // perf.quality別の処理解像度上限
const NORMAL_GEN_STRENGTH = 2.9;      // fineタップ(1px間隔)の勾配→法線ベクトル変換の強さ（くっきり感の主役）
const NORMAL_GEN_COARSE_STEP = 4;     // coarseタップのサンプリング間隔(px)。パネル単位の起伏用
const NORMAL_GEN_COARSE_WEIGHT = 0.6; // coarseタップの寄与度（fineタップを1.0とした相対値。控えめにして脇役に）
const NORMAL_GEN_SCALE_XY = 0.92;     // 生成後にmaterial.normalScaleへ入れる強さ（全体の強さの最終調整はここで）

function generateNormalMapFromDiffuse(sourceTexture) {
    if (!sourceTexture || !sourceTexture.image) return null;
    const img = sourceTexture.image;
    const srcW = img.width || img.videoWidth || 0;
    const srcH = img.height || img.videoHeight || 0;
    if (!srcW || !srcH) return null;

    const maxSize = NORMAL_GEN_MAX_SIZE[perf.quality] || 1024;
    const scale = Math.min(1, maxSize / Math.max(srcW, srcH));
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));

    let srcPixels;
    try {
        const srcCanvas = document.createElement('canvas');
        srcCanvas.width = w; srcCanvas.height = h;
        const sctx = srcCanvas.getContext('2d');
        sctx.drawImage(img, 0, 0, w, h);
        srcPixels = sctx.getImageData(0, 0, w, h).data;
    } catch (e) {
        // クロスオリジン画像等でピクセル読み取りができない場合は諦める（致命的ではない）
        console.warn('法線マップ自動生成: テクスチャのピクセル読み取りに失敗したためスキップしました', e);
        return null;
    }

    // 輝度(≒ペイントの明暗)を高さとみなす
    const heights = new Float32Array(w * h);
    for (let i = 0, p = 0; i < w * h; i++, p += 4) {
        heights[i] = (0.299 * srcPixels[p] + 0.587 * srcPixels[p + 1] + 0.114 * srcPixels[p + 2]) / 255;
    }
    const atH = (x, y) => {
        // タイル前提(wrap)ではなく端をクランプする＝UV島をまたいだ誤爆を避ける安全側の選択
        x = x < 0 ? 0 : (x >= w ? w - 1 : x);
        y = y < 0 ? 0 : (y >= h ? h - 1 : y);
        return heights[y * w + x];
    };
    // 間隔(step)を変えてSobel勾配を取るヘルパー。step=1で1px単位のエッジ、
    // step>1でそれより広い面の起伏を拾う（間引きサンプリングなので簡易ブラーも兼ねる）。
    const sobelGrad = (x, y, step) => {
        const tl = atH(x - step, y - step), tc = atH(x, y - step), tr = atH(x + step, y - step);
        const ml = atH(x - step, y),                                       mr = atH(x + step, y);
        const bl = atH(x - step, y + step), bc = atH(x, y + step), br = atH(x + step, y + step);
        const gx = (tr + 2 * mr + br) - (tl + 2 * ml + bl);
        const gy = (bl + 2 * bc + br) - (tl + 2 * tc + tr);
        return [gx, gy];
    };

    const outCanvas = document.createElement('canvas');
    outCanvas.width = w; outCanvas.height = h;
    const octx = outCanvas.getContext('2d');
    const outImg = octx.createImageData(w, h);
    const out = outImg.data;

    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const [gxF, gyF] = sobelGrad(x, y, 1);
            const [gxC, gyC] = sobelGrad(x, y, NORMAL_GEN_COARSE_STEP);
            const gx = gxF + gxC * NORMAL_GEN_COARSE_WEIGHT;
            const gy = gyF + gyC * NORMAL_GEN_COARSE_WEIGHT;

            let nx = -gx * NORMAL_GEN_STRENGTH;
            let ny = -gy * NORMAL_GEN_STRENGTH;
            let nz = 1.0;
            const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1.0;
            nx /= len; ny /= len; nz /= len;

            const idx = (y * w + x) * 4;
            out[idx]     = Math.round((nx * 0.5 + 0.5) * 255);
            out[idx + 1] = Math.round((ny * 0.5 + 0.5) * 255);
            out[idx + 2] = Math.round((nz * 0.5 + 0.5) * 255);
            out[idx + 3] = 255;
        }
    }
    octx.putImageData(outImg, 0, 0);

    const normalTex = new THREE.CanvasTexture(outCanvas);
    // UV変換・ラップ設定を元の拡散テクスチャと完全に一致させる
    // （ここがズレると法線マップだけタイリングや向きが食い違って見た目が破綻する）
    normalTex.wrapS = sourceTexture.wrapS;
    normalTex.wrapT = sourceTexture.wrapT;
    normalTex.repeat.copy(sourceTexture.repeat);
    normalTex.offset.copy(sourceTexture.offset);
    normalTex.center.copy(sourceTexture.center);
    normalTex.rotation = sourceTexture.rotation;
    normalTex.flipY = sourceTexture.flipY; // GLTFLoaderはflipY=falseにすることが多いため必ずコピーする
    normalTex.encoding = THREE.LinearEncoding; // 法線マップは色ではなくデータなので必ずLinear
    normalTex.needsUpdate = true;
    return normalTex;
}

function maybeGenerateDetailNormalMap(mat, doneSet) {
    if (!mat || (!mat.isMeshStandardMaterial && !mat.isMeshPhysicalMaterial)) return;
    if (mat.normalMap || !mat.map) return; // 既に法線マップがある/拡散テクスチャが無いなら何もしない
    if (perf.quality === 'ultralow' || perf.quality === 'verylow') return; // 軽量端末では読み込み時間を優先してスキップ
    if (doneSet.has(mat)) return;
    doneSet.add(mat);
    try {
        const normalTex = generateNormalMapFromDiffuse(mat.map);
        if (normalTex) {
            mat.normalMap = normalTex;
            mat.normalScale.set(NORMAL_GEN_SCALE_XY, NORMAL_GEN_SCALE_XY);
            mat.needsUpdate = true;
        }
    } catch (e) {
        console.warn('法線マップ自動生成に失敗しました（見た目には影響しますが致命的ではありません）:', e);
    }
}

// v89: テクスチャに異方性フィルタリング(anisotropic filtering)を適用する。
// これまで未設定(=1、等方フィルタのみ)だったため、船体側面のように画面に対して
// 浅い角度で見えるテクスチャ(甲板の線・リベット・窓の並び等)がボケて/ジャギって
// 見えていた。renderer.capabilities.getMaxAnisotropy()の値まで上げることで、
// 追加のテクスチャメモリ無しでその見た目の粗さをかなり軽減できる。
function applyAnisotropyToMaterial(mat) {
    if (!mat || !renderer || !renderer.capabilities) return;
    const maxAniso = renderer.capabilities.getMaxAnisotropy ? renderer.capabilities.getMaxAnisotropy() : 1;
    if (!maxAniso || maxAniso <= 1) return;
    ['map', 'normalMap', 'emissiveMap', 'roughnessMap', 'metalnessMap', 'aoMap'].forEach((key) => {
        const tex = mat[key];
        if (tex && tex.anisotropy !== maxAniso) {
            tex.anisotropy = maxAniso;
            tex.needsUpdate = true;
        }
    });
}

function applyMaterialsToModel(model) {
    const normalMapDone = new Set(); // 同じマテリアルを複数メッシュで共有していても生成は1回だけ
    model.traverse((child) => {
        if (!child.isMesh || !child.material) return;
        // v83: 船体・上部構造・煙突・舵などすべてのGLBメッシュで影を出す/受ける。
        // 特定のパーツ（例: ガラス窓）で影の見え方が不自然な場合は、そのメッシュだけ
        // 後から child.castShadow=false 等で個別に上書きすればよい。
        child.castShadow = true;
        child.receiveShadow = true;
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        const newMats = mats.map((mat) => {
            if (!mat) return mat;
            // RectAreaLight は MeshStandard/MeshPhysical にしか当たらない。
            // Phong/Lambert/Basic → Standard に変換する。
            if (mat.isMeshPhongMaterial || mat.isMeshLambertMaterial || mat.isMeshBasicMaterial) {
                const std = new THREE.MeshStandardMaterial({
                    color:       mat.color       ? mat.color.clone()   : new THREE.Color(0xffffff),
                    map:         mat.map         || null,
                    normalMap:   mat.normalMap   || null,
                    emissive:    mat.emissive    ? mat.emissive.clone() : new THREE.Color(0x000000),
                    emissiveMap: mat.emissiveMap || null,
                    roughness:   0.6,
                    metalness:   0.1,
                    transparent: mat.transparent || false,
                    opacity:     mat.opacity     != null ? mat.opacity : 1.0,
                    side:        THREE.DoubleSide,
                });
                std.needsUpdate = true;
                patchMaterialForAreaLight(std);
                registerWindowGlowMaterial(std);
                maybeGenerateDetailNormalMap(std, normalMapDone);
                applyAnisotropyToMaterial(std);
                return std;
            }
            mat.side = THREE.DoubleSide;
            // GLBネイティブのroughnessが低い場合も底上げ
            if (mat.isMeshStandardMaterial || mat.isMeshPhysicalMaterial) {
                mat.roughness = Math.max(mat.roughness, 0.55);
            }
            mat.needsUpdate = true;
            patchMaterialForAreaLight(mat);
            registerWindowGlowMaterial(mat);
            maybeGenerateDetailNormalMap(mat, normalMapDone);
            applyAnisotropyToMaterial(mat);
            return mat;
        });
        if (Array.isArray(child.material)) {
            child.material = newMats;
        } else {
            child.material = newMats[0];
        }
        // 窓・キャビンなどの発光マテリアル（registerWindowGlowMaterialで登録済み）を
        // 含むメッシュだけブルーム対象として残す。それ以外のPBR面（船体・甲板等）は
        // 引き続きブルームパスから除外する（ガビガビ防止）。
        const hasWindowGlow = newMats.some((m) => m && windowGlowMaterials.indexOf(m) !== -1);
        child.userData.noBloom = !hasWindowGlow;
        // emissiveメッシュをリストに追加（後でPointLight配置に使う）
        if (hasWindowGlow) {
            const gm = newMats.find(m => m && windowGlowMaterials.indexOf(m) !== -1);
            if (gm) windowGlowMeshEntries.push({ mesh: child, mat: gm });
            // v147-fix: 窓ガラス（発光メッシュ）自体がcastShadow=trueのままだと、
            // すぐ近く（クラスタ重心＝ほぼ窓面そのもの）に置かれる窓灯りPointLight
            // (buildWindowGlowLights参照)がほぼ自分自身のメッシュに遮蔽されてしまい、
            // castShadowを有効にしても光がほとんど外へ出てこなくなる。窓は光源側と
            // みなしcastShadowはOFFにする（上のコメントで想定されていた「特定のパーツ
            // で影の見え方が不自然な場合の個別上書き」に該当）。receiveShadowはtrueの
            // ままなので、他の物の影を窓ガラスが受けるのは従来通り。
            child.castShadow = false;
        }
    });
}

// RectAreaLight の発光をシェーダーレベルで面全体に均一化するパッチ。
// RE_Direct_RectArea_Physical を5点サンプル版に差し替える。
// GPU追加負荷: サンプル数5倍だが頂点でなくフラグメントなので軽量。
function patchMaterialForAreaLight(mat) {
    if (mat.__areaLightPatched) return;
    mat.__areaLightPatched = true;
    mat.onBeforeCompile = (shader) => {
        // 元の RE_Direct_RectArea_Physical を 5 サブサンプル版で置き換える
        // 中央1点 + 四隅4点を 1/5 強度でサンプリングし合算することで
        // 面全体から光が当たっているように見せる
        shader.fragmentShader = shader.fragmentShader.replace(
            'void RE_Direct_RectArea_Physical',
            `
void RE_Direct_RectArea_Physical_Single(
    const in vec3 lightPos, const in vec3 halfW, const in vec3 halfH,
    const in vec3 lightColor,
    const in GeometricContext geometry, const in PhysicalMaterial material,
    inout ReflectedLight reflectedLight
) {
    vec3 normal   = geometry.normal;
    vec3 viewDir  = geometry.viewDir;
    vec3 position = geometry.position;
    float roughness = material.specularRoughness;
    vec3 rectCoords[4];
    rectCoords[0] = lightPos + halfW - halfH;
    rectCoords[1] = lightPos - halfW - halfH;
    rectCoords[2] = lightPos - halfW + halfH;
    rectCoords[3] = lightPos + halfW + halfH;
    vec2 uv = LTC_Uv( normal, viewDir, roughness );
    vec4 t1 = texture2D( ltc_1, uv );
    vec4 t2 = texture2D( ltc_2, uv );
    mat3 mInv = mat3( vec3( t1.x, 0, t1.y ), vec3( 0, 1, 0 ), vec3( t1.z, 0, t1.w ) );
    vec3 fresnel = ( material.specularColor * t2.x + ( vec3( 1.0 ) - material.specularColor ) * t2.y );
    reflectedLight.directSpecular += lightColor * fresnel * LTC_Evaluate( normal, viewDir, position, mInv, rectCoords );
    reflectedLight.directDiffuse  += lightColor * material.diffuseColor * LTC_Evaluate( normal, viewDir, position, mat3( 1.0 ), rectCoords );
}

// 面全体均一化: 5点サンプル（中央 + 四隅オフセット）
void RE_Direct_RectArea_Physical`,
        );

        // 5点サンプル呼び出しに差し替え
        shader.fragmentShader = shader.fragmentShader.replace(
            /RE_Direct_RectArea_Physical\s*\(\s*rectAreaLight\s*,\s*geometry\s*,\s*material\s*,\s*reflectedLight\s*\)\s*;/,
            `{
    vec3 _lp  = rectAreaLight.position;
    vec3 _hw  = rectAreaLight.halfWidth;
    vec3 _hh  = rectAreaLight.halfHeight;
    vec3 _lc  = rectAreaLight.color * 0.2;   // 5点 × 0.2 = 1.0 倍相当
    // 中央
    RE_Direct_RectArea_Physical_Single(_lp, _hw, _hh, _lc, geometry, material, reflectedLight);
    // 四隅オフセット（面内で 60% の位置）
    float _ox = 0.6; float _oy = 0.6;
    RE_Direct_RectArea_Physical_Single(_lp + _hw*_ox + _hh*_oy, _hw*(1.0-_ox), _hh*(1.0-_oy), _lc, geometry, material, reflectedLight);
    RE_Direct_RectArea_Physical_Single(_lp - _hw*_ox + _hh*_oy, _hw*(1.0-_ox), _hh*(1.0-_oy), _lc, geometry, material, reflectedLight);
    RE_Direct_RectArea_Physical_Single(_lp + _hw*_ox - _hh*_oy, _hw*(1.0-_ox), _hh*(1.0-_oy), _lc, geometry, material, reflectedLight);
    RE_Direct_RectArea_Physical_Single(_lp - _hw*_ox - _hh*_oy, _hw*(1.0-_ox), _hh*(1.0-_oy), _lc, geometry, material, reflectedLight);
}`
        );
    };
}

// v91: 船モデルを読み替える際、古いモデルのジオメトリ/マテリアル/テクスチャを
// 明示的にGPUメモリから解放する。
// これまではshipGroup.remove(child)でシーングラフから外すだけで、
// Three.js側のGPUリソース（VRAM上のテクスチャ・頂点バッファ）は解放していなかった。
// remove()しただけではdispose()は自動的には呼ばれないため、船を何度も読み替えて
// 検証していると古いモデル分のテクスチャがVRAMに残り続けて積み上がっていく。
// これが「軽いモデルは平気だが、少し重い(テクスチャの大きい)GLBを読み込むと
// 形は出るのにテクスチャだけ反映されない」不具合の主因と考えられる
// （ジオメトリは数MB程度で収まることが多いが、2K/4K テクスチャは1枚十数MB以上
// VRAMを使うため、蓄積した分と合わせてブラウザ/GPUのメモリ上限を超えると
// テクスチャのアップロードだけが失敗し、ジオメトリはそのまま描画される）。
function disposeObject3D(root) {
    if (!root) return;
    const seenGeo = new Set();
    const seenMat = new Set();
    const seenTex = new Set();
    const texKeys = [
        'map', 'normalMap', 'emissiveMap', 'roughnessMap', 'metalnessMap',
        'aoMap', 'alphaMap', 'bumpMap', 'displacementMap', 'envMap', 'lightMap',
        'clearcoatMap', 'clearcoatNormalMap', 'clearcoatRoughnessMap',
        'metalnessRoughnessMap', 'specularMap', 'gradientMap',
    ];
    root.traverse((obj) => {
        if (obj.geometry && !seenGeo.has(obj.geometry)) {
            seenGeo.add(obj.geometry);
            obj.geometry.dispose();
        }
        const mats = Array.isArray(obj.material) ? obj.material : (obj.material ? [obj.material] : []);
        mats.forEach((mat) => {
            if (!mat || seenMat.has(mat)) return;
            seenMat.add(mat);
            texKeys.forEach((key) => {
                const tex = mat[key];
                if (tex && tex.isTexture && !seenTex.has(tex)) {
                    seenTex.add(tex);
                    tex.dispose();
                }
            });
            mat.dispose();
        });
    });
}

function setCustomModel(model) {
    if (!modelHasMesh(model)) return;
    
    if (currentGizmoTarget === importedModelGroup?.children[0]) disableGizmo();
    if (currentGizmoType === 'glbpart' || currentGizmoType === 'glbpart_pivot') disableGizmo();
    
    // 前のモデルとGLBライトを削除
    const toRemove = [];
    shipGroup.children.forEach((child) => {
        if (child !== cgMarker && child !== rudderMarker
            && !child.userData.isSky
            && !child.userData.isViewpointMarker) toRemove.push(child);
    });
    toRemove.forEach((child) => {
        shipGroup.remove(child);
        disposeObject3D(child); // v91: シーンから外すのと同時にGPUリソースも解放
    });

    // 以前のGLBライトをシーンから削除（エリアライト枠も一緒に削除）
    glbLights.forEach((l) => {
        if (l.parent) l.parent.remove(l);
        if (l.target && l.target.parent) l.target.parent.remove(l.target);
        if (l.userData.areaBoxHelper && l.userData.areaBoxHelper.parent) {
            l.userData.areaBoxHelper.parent.remove(l.userData.areaBoxHelper);
        }
    });
    glbLights = [];
    windowGlowMaterials = [];
    windowGlowMeshEntries = [];
    // 既存の窓グローPointLightを削除（shadow.mapもdisposeWindowGlowLight内で解放）
    windowGlowLights.forEach(disposeWindowGlowLight);
    windowGlowLights = [];
    disposeWindowGlowLightProbe(); // v168: 新しいモデルに切り替える際、旧プローブも確実に破棄する
    disposePromenadeLights(); // v169: 同上、プロムナードライトも確実に破棄する
    // 甲板照明・煙突アップライトもリセット
    clearDecorLights();
    clearFunnelUplights();

    applyMaterialsToModel(model);

    const box = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3();
    box.getSize(size);
    const origLength = Math.max(size.x, size.y, size.z);
    modelOffset.autoScale = origLength > 0 ? 12.0 / origLength : 1.0;

    // GLBに含まれるライトを抽出（Punctual: Point/Spot/Directional）
    model.traverse((child) => {
        if (child.isLight) {
            child.userData.isGlbLight = true;
            child.userData.baseIntensity = child.intensity;
            glbLights.push(child);
        }
    });

    // カスタムプロパティからエリアライト（RectAreaLight）を生成
    // Blenderで Object Custom Properties に type="area" を設定した空オブジェクトを読み込む
    // ※ まずEmptyオブジェクトを収集するだけ。ライト生成はmodelをシーンに追加した後に行う。
    const pendingAreaLightEmpties = [];
    model.traverse((child) => {
        const ud = child.userData;
        if (!ud || ud.type !== 'area') return;
        pendingAreaLightEmpties.push(child);
    });

    // ── エリアライト（PointLight代用）をモデル階層内に直接生成 ──────────────
    // 旧実装は「ワールド座標を手計算で焼き込んでimportedModelGroupの子として配置」
    // していたため、(1) GLBごとにメッシュノードとEmptyノードのベイク済み回転が
    // 異なる（ブリタニックは一致、タイタニック/オリンピックの"mirrored"書き出しは
    // 不一致）ことで初期配置がズレ、(2) 船体設定パネルでmodelOffsetを後から変えても
    // 焼き込み済みの位置は再計算されない、という2つの不具合の原因になっていた。
    // → 元のEmptyと同じ親・同じローカル座標にPointLightを差し込むことで、
    //   通常のThree.jsシーングラフ継承により model 自身の回転・移動・スケールに
    //   常に自動追従するようになる（手動でのワールド座標計算が不要になる）。
    const hullGlowSources = []; // 後段のシェーダーパッチ（面全体グロー）用に位置・色を集めておく
    pendingAreaLightEmpties.forEach((child) => {
        const ud = child.userData;
        const rawIntensity = parseFloat(ud.intensity) || 100.0;
        const intensity = rawIntensity > 20 ? rawIntensity * 0.03 : rawIntensity;
        const colorStr = ud.color || '#ffffff';

        // ── 間接照明エミュレーション ──────────────────────────────
        // 以前はこのPointLightをシーンに追加し、標準のThree.jsライティング
        // （1点からのランバート減衰）でも面を照らしていたため、点の位置から見て
        // 真裏・側面を向いた壁（エリアの端で原点から外側を向いている面など）が
        // 不自然に暗く落ちる「原点からのスポットライト」現象が発生していた。
        // → このPointLightはシーンに追加せず、強度・色・位置のデータ保持専用
        //   （UIスライダー等の表示・保存用）にとどめる。実際に面を照らすのは
        //   下のHullGlowシェーダー（面全体の最近接点ベースの減衰）のみとし、
        //   エリア全体を使った自然な「面光源」の見え方に統一する。
        const ambPt = new THREE.PointLight(colorStr, intensity * 0.4, 0, 0);
        ambPt.position.copy(child.position); // 元Emptyと全く同じローカル座標をそのまま使う
        ambPt.userData.isGlbLight    = true;
        ambPt.userData.isAreaLight   = true;  // UIでエリアライトとして扱う
        ambPt.userData.baseIntensity = intensity;
        ambPt.userData.labelName     = child.name || ('Area #' + (glbLights.length + 1));
        glbLights.push(ambPt);
        // 注意: 意図的に parent.add(ambPt) を呼ばない（シーングラフに追加しない）。
        // これにより標準ライトループの計算コスト・ライト数も増えない（モバイル負荷対策にもなる）。

        // 面の変換情報（position/quaternion/scale）をnodeとして保持しておく。
        // updateHullGlowUniformsでワールド変換を毎フレーム計算するため、
        // PointLightではなくemptyの変換を持つObject3Dをそのまま使う。
        // ただしemptyはparent.remove(child)で削除してしまうので、
        // PointLightに同じ変換を引き継いだダミーObject3Dを用意する。
        const areaNode = new THREE.Object3D();
        areaNode.position.copy(child.position);
        areaNode.quaternion.copy(child.quaternion);
        areaNode.scale.copy(child.scale);
        ambPt.userData.areaNode = areaNode; // UIからサイズ・向き変更のため参照を保持
        hullGlowSources.push({ light: ambPt, node: areaNode, color: new THREE.Color(colorStr), baseIntensity: intensity });

        // 元のEmptyと同じ親（＝modelのローカル階層）にぶら下げ、Emptyは削除
        const parent = child.parent || model;
        parent.add(areaNode); // 面変換追従用ノード（updateWorldMatrix対象）。ambPtはシーンに追加しない。
        parent.remove(child);
    });

    importedModelGroup = new THREE.Group();
    importedModelGroup.add(model);
    shipGroup.add(importedModelGroup);

    // モデル内の全マテリアルに「面全体グロー」をシェーダーで仕込む。
    // 法線方向に関係なく、近くのエリアライト位置からの距離だけで
    // emissiveを底上げするので、窓の外側プレートのような
    // 「光源の真反対を向いた面」でも自然に明るくなる。
    if (hullGlowSources.length > 0) {
        applyHullGlowShader(model, hullGlowSources);
    }

    detectGlbMovableParts(model);

    // モデル自体にスクリュー・外輪パーツが含まれている場合は、
    // 組み込みの推進器（プロペラ等）を自動追加しない。
    // 含まれていない場合のみ、デフォルトの推進器を1つ用意する。
    const hasOwnScrew = glbMovableParts.some(p => p.key === 'screw' || p.key === 'paddle');
    if (hasOwnScrew) {
        propulsors = [];
    } else if (propulsors.length === 0) {
        propulsors = [{ x: 0, y: -1.2, z: -7, size: 1.0, dir: 1 }];
    }

    // ライト数をステータスに反映
    if (glbLights.length > 0) {
        const statusText = $('import-status');
        if (statusText) {
            const prev = statusText.innerText;
            statusText.innerText = prev + ` ＋ライト×${glbLights.length}`;
        }
    }
    
    initSettingsComponents();
    updateModelOffset();

    // pendingGlbLightSettings: モデルロード前に保存データが来た場合に適用
    if (pendingGlbLightSettings && glbLights.length > 0) {
        applyGlbLightSettingsData(pendingGlbLightSettings);
        pendingGlbLightSettings = null;
    }

    // ── 船体形状スキャン（引き波物理用） ──
    // updateModelOffset() が matrixWorld を更新した後に実行する必要があるため
    // 1フレーム遅らせて呼ぶ。
    setTimeout(() => {
        if (typeof scanHullProfile === 'function') {
            scanHullProfile();
        }
        // Stage1/2で使う判定用の履歴を、前に読み込んでいた船のものが残らないように
        // リセットする（船を載せ替えた直後に前の船の状態のまま判定してしまう問題を防ぐ）。
        window._prevBowVolSubmerged = null;
        window._prevSternVolSubmerged = null;
        window._lastBowSlamT = null;
        window._lastSternSlamT = null;
        window._bowExcessBaselineVol = null; // 恒常バイアス除去の窓トラッカーも前の船の値を引き継がないようリセット
        window._bowExcessBufA = null;
        window._bowExcessBufB = null;
        window._bowExcessHalfTimer = null;
        if (typeof HOGSAG_ENABLED !== 'undefined' && HOGSAG_ENABLED && typeof applyHogSagBendShader === 'function') {
            applyHogSagBendShader(model); // Stage3: 船体曲げシェーダー（hullProfile確定後に実行する必要がある）
        }
        if (window._invalidateWlCache) window._invalidateWlCache();
        // emissiveメッシュのワールド座標が確定してからPointLightを配置する
        buildWindowGlowLights();
    }, 100);
}

// エリアライト設定（位置・回転・スケール・強度・色・ON/OFF）を一括復元する
function applyGlbLightSettingsData(settingsArr) {
    settingsArr.forEach((saved, i) => {
        // ラベル名で検索、なければインデックスでフォールバック
        let light = glbLights.find(l => (l.userData.labelName || '') === saved.label);
        if (!light && i < glbLights.length) light = glbLights[i];
        if (!light) return;

        // 強度
        if (Number.isFinite(saved.baseIntensity)) {
            light.userData.baseIntensity = saved.baseIntensity;
        }
        // 色
        if (saved.color) {
            light.color.set(saved.color);
            if (light.userData.mirrorLight) light.userData.mirrorLight.color.set(saved.color);
        }
        // ON/OFF
        if (typeof saved.manuallyOff === 'boolean') {
            light.userData.manuallyOff = saved.manuallyOff;
        }

        // areaNode の変換（位置・回転・スケール）を復元
        // これが照射方向・面サイズ・ライト位置の実体
        const an = light.userData.areaNode;
        if (an && saved.areaNode) {
            const sn = saved.areaNode;
            if (sn.pos)   an.position.set(sn.pos.x, sn.pos.y, sn.pos.z);
            if (sn.rot)   an.rotation.set(sn.rot.x, sn.rot.y, sn.rot.z, sn.rot.order || 'XYZ');
            if (sn.scale) an.scale.set(sn.scale.x, sn.scale.y, sn.scale.z);
            // light本体の位置もareaNodeに同期（シェーダー以外のPointLight等でも使われるため）
            light.position.copy(an.position);
            // mirrorLightの位置も対称に更新
            if (light.userData.mirrorLight) {
                light.userData.mirrorLight.position.set(-an.position.x, an.position.y, an.position.z);
            }
            // areaBoxHelper（ギズモ用ワイヤーフレーム）も同期
            if (light.userData.areaBoxHelper) {
                const h = light.userData.areaBoxHelper;
                h.position.copy(an.position);
                h.rotation.copy(an.rotation);
                h.scale.copy(an.scale);
            }
        }
    });

    applyGlbLightIntensities();
    if (typeof renderGlbLightsList === 'function') renderGlbLightsList();
}

function updateModelOffset() {
    if (!importedModelGroup || !importedModelGroup.children[0]) return;
    const child = importedModelGroup.children[0];
    child.position.set(modelOffset.x, modelOffset.y, modelOffset.z);
    child.rotation.y = (modelOffset.ry * Math.PI) / 180;
    const finalScale = modelOffset.autoScale * modelOffset.scale;
    child.scale.set(finalScale, finalScale, finalScale);

    // 船首方向(ry)やスケールが変わったら引き波断面スキャンも更新
    clearTimeout(updateModelOffset._scanTimer);
    updateModelOffset._scanTimer = setTimeout(() => {
        if (typeof scanHullProfile === 'function') scanHullProfile();
        if (window._invalidateWlCache) window._invalidateWlCache();
    }, 50);
}

function loadOBJ(text, fileName) {
    pendingOBJText = text; pendingOBJName = fileName;
    const loader = new THREE.OBJLoader();
    if (pendingMTLMaterials) loader.setMaterials(pendingMTLMaterials);
    const obj = loader.parse(text);
    if (!modelHasMesh(obj)) throw new Error('OBJ has no mesh');
    setCustomModel(obj);
    $('import-status').innerText = pendingMTLMaterials ? 'Loaded OBJ + MTL: ' + fileName : 'Loaded OBJ: ' + fileName;
}

function loadMTL(text, fileName, reloaded) {
    const statusText = $('import-status');
    if (!THREE.MTLLoader) return;
    try {
        const manager = new THREE.LoadingManager();
        manager.setURLModifier((url) => resolveTextureAlias(url) || url);
        const mtlLoader = new THREE.MTLLoader(manager);
        const materials = mtlLoader.parse(text, '');
        if (materials && materials.preload) materials.preload();
        pendingMTLMaterials = materials; pendingMTLText = text;
        if (pendingOBJText) loadOBJ(pendingOBJText, pendingOBJName);
        statusText.innerText = (reloaded ? 'Reloaded MTL: ' : 'Loaded MTL: ') + fileName;
    } catch (e) {
        statusText.innerText = 'Error loading MTL';
    }
}

function setupTextureFolderLoader() {
    const folderInput = $('texture-folder-loader');
    if (!folderInput) return;
    folderInput.addEventListener('change', (e) => {
        const files = Array.from(e.target.files || []);
        textureObjectURLs.forEach((url) => URL.revokeObjectURL(url));
        textureObjectURLs = []; textureAliases = {}; textureAliasCount = 0;

        for (const file of files) {
            const url = URL.createObjectURL(file);
            textureObjectURLs.push(url);
            const cleanName = file.name.toLowerCase();
            textureAliases[cleanName] = url;
            textureAliasCount++;
        }
        let firstMTL = null;
        for (const file of files) {
            if (file.name.toLowerCase().endsWith('.mtl')) { firstMTL = file; break; }
        }
        if (firstMTL) {
            const reader = new FileReader();
            reader.onload = (ev) => loadMTL(ev.target.result, firstMTL.name, true);
            reader.readAsText(firstMTL);
        } else if (pendingMTLText) {
            loadMTL(pendingMTLText, 'Reloaded MTL', true);
        } else if (pendingOBJText) {
            loadOBJ(pendingOBJText, pendingOBJName);
        }
        e.target.value = '';
    });
}

function setGlbMaster(v) {
    glbLightMaster = v;
    applyGlbLightIntensities();
}

// GLBライト（エリア/ポイント等、航行灯以外）の実際の明るさを
// 「基準強度 × 全体明るさスライダー × 昼夜自動係数」から再計算する。
// 自動モードがOFFの間は昼夜係数=1なので、常時このまま明るさが反映される。
function applyGlbLightIntensities() {
    const factor = glbLightAutoMode ? lightingNightFactor : 1.0;
    // 完全に昼間(factor≈0)の間はvisible=falseにして、Three.js側のライトループから完全に除外する。
    // intensity=0にするだけだとシェーダー内のライト数(NUM_POINT_LIGHTS等)は減らないままなので、
    // GPU負荷は下がらない。visibleをfalseにすることで初めて実際の計算コストが減る。
    const autoHide = glbLightAutoMode && factor < 0.02;
    glbLights.forEach((light) => {
        if (light.userData && light.userData.isMirrorLight) return; // ミラーは元ライトに同期するのでスキップ
        const base = light.userData.baseIntensity != null ? light.userData.baseIntensity : light.intensity;
        light.intensity = base * glbLightMaster * factor;
        // 個別のON/OFFスイッチ(手動)が優先。手動でOFFでなければ、昼の自動消灯判定に従う。
        light.visible = !light.userData.manuallyOff && !autoHide;
        if (light.userData.mirrorLight) {
            light.userData.mirrorLight.intensity = light.intensity;
            light.userData.mirrorLight.visible = light.visible;
        }
    });
}

// 「日が昇ったら自動消灯」ボタン用。航行灯はこの対象外（既存の航行灯トグル/夜間判定で別管理）。
function setGlbAutoMode(enabled) {
    glbLightAutoMode = enabled;
    applyGlbLightIntensities();
}

function setGlbDistance(v) {
    // v=0 → distance=0 (Three.jsでは∞扱い)
    glbLights.forEach((light) => {
        if (light.isPointLight || light.isSpotLight || light.isDirectionalLight) {
            light.distance = v;
        }
    });
}

function updateLightingSettings() {
    lightSettings.sunMult = parseFloat($('light-sun-mult').value);
    lightSettings.ambientMult = parseFloat($('light-ambient-mult').value);
    lightSettings.hemiMult = parseFloat($('light-hemi-mult').value);
    lightSettings.fillMult = parseFloat($('light-fill-mult').value);
    lightSettings.exposure = parseFloat($('light-exposure').value);
    lightSettings.fogMult = parseFloat($('light-fog-mult').value);
    lightSettings.glbMaster = parseFloat($('light-glb-master').value);
    lightSettings.windowGlowMult = parseFloat($('light-window-glow').value);

    $('light-sun-mult-num').value = lightSettings.sunMult;
    $('light-ambient-mult-num').value = lightSettings.ambientMult;
    $('light-hemi-mult-num').value = lightSettings.hemiMult;
    $('light-fill-mult-num').value = lightSettings.fillMult;
    $('light-exposure-num').value = lightSettings.exposure;
    $('light-fog-mult-num').value = lightSettings.fogMult;
    $('light-glb-master-num').value = lightSettings.glbMaster;
    $('light-window-glow-num').value = lightSettings.windowGlowMult;

    if (renderer) renderer.toneMappingExposure = lightSettings.exposure;
    setGlbMaster(lightSettings.glbMaster);

    // glb-master-num（spanテキスト）も同期
    const masterNumSpan = $('glb-master-num');
    if (masterNumSpan) masterNumSpan.textContent = lightSettings.glbMaster.toFixed(2);
}

function syncLightingPanelUI() {
    setVal('light-sun-mult', lightSettings.sunMult); setVal('light-sun-mult-num', lightSettings.sunMult);
    setVal('light-ambient-mult', lightSettings.ambientMult); setVal('light-ambient-mult-num', lightSettings.ambientMult);
    setVal('light-hemi-mult', lightSettings.hemiMult); setVal('light-hemi-mult-num', lightSettings.hemiMult);
    setVal('light-fill-mult', lightSettings.fillMult); setVal('light-fill-mult-num', lightSettings.fillMult);
    setVal('light-exposure', lightSettings.exposure); setVal('light-exposure-num', lightSettings.exposure);
    setVal('light-fog-mult', lightSettings.fogMult); setVal('light-fog-mult-num', lightSettings.fogMult);
    setVal('light-glb-master', lightSettings.glbMaster); setVal('light-glb-master-num', lightSettings.glbMaster);
    setVal('light-window-glow', lightSettings.windowGlowMult); setVal('light-window-glow-num', lightSettings.windowGlowMult);

    if (renderer) renderer.toneMappingExposure = lightSettings.exposure;
    setGlbMaster(lightSettings.glbMaster);
}

function resetLightingSettings() {
    lightSettings.sunMult = 1.0;
    lightSettings.ambientMult = 1.0;
    lightSettings.hemiMult = 1.0;
    lightSettings.fillMult = 1.0;
    lightSettings.exposure = 0.85;
    lightSettings.fogMult = 1.0;
    lightSettings.glbMaster = 1.0;
    lightSettings.windowGlowMult = 1.0;
    syncLightingPanelUI();
}

// ── エリアライト選択枠（ワイヤーフレームボックス） ──────────────────────────
// ギズモでエリアライトを選択したとき、面の大きさと向きが分かる枠を3Dに表示する。
// areaNode の変換（位置・回転・サイズ）に追従する Object3D として shipGroup に追加。
function createAreaLightBoxHelper(light) {
    if (light.userData.areaBoxHelper) return; // 既に作成済み
    const anode = light.userData.areaNode;
    if (!anode) return;

    // 単位1×1の平板ワイヤーフレーム（areaNodeのscaleで実サイズに合わせる）
    const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 0.02, 1));
    const mat = new THREE.LineBasicMaterial({
        color: 0x00ffcc,
        linewidth: 1,
        depthTest: false,
        transparent: true,
        opacity: 0.85
    });
    const box = new THREE.LineSegments(geo, mat);
    // 面の向き矢印：照射方向（ローカルY+方向）を示す小さな線
    const arrowGeo = new THREE.BufferGeometry();
    arrowGeo.setAttribute('position', new THREE.Float32BufferAttribute([
        0, 0.01, 0,   0, 0.6, 0  // Y方向の短い矢印
    ], 3));
    const arrowMat = new THREE.LineBasicMaterial({ color: 0xffcc00, depthTest: false, opacity: 0.9, transparent: true });
    const arrow = new THREE.Line(arrowGeo, arrowMat);

    const group = new THREE.Group();
    group.add(box);
    group.add(arrow);
    group.visible = false;
    group.userData.isAreaBoxHelper = true;

    // areaNodeの親（モデルノード）に同じ変換で追随させる
    anode.parent.add(group);
    light.userData.areaBoxHelper = group;
}

function updateAreaLightBoxHelper(light) {
    const helper = light.userData.areaBoxHelper;
    const anode  = light.userData.areaNode;
    if (!helper || !anode) return;
    // areaNodeの変換をそのままコピー（位置・回転・スケール）
    helper.position.copy(anode.position);
    helper.rotation.copy(anode.rotation);
    helper.scale.copy(anode.scale);
}

function showAreaLightBoxHelper(lightIndex) {
    glbLights.forEach((l, i) => {
        if (!l.userData.areaBoxHelper) return;
        l.userData.areaBoxHelper.visible = (i === lightIndex);
    });
}

function hideAllAreaLightBoxHelpers() {
    glbLights.forEach(l => {
        if (l.userData.areaBoxHelper) l.userData.areaBoxHelper.visible = false;
    });
}

function updateGlbLightsUI() {
    const sectionTab = $('glb-lights-section-tab');  // 照明タブ内のセクション
    const emptyMsg   = $('glb-lights-empty-msg');
    const list = $('glb-lights-list');
    if (!list) return;

    if (glbLights.length === 0) {
        if (sectionTab) sectionTab.style.display = 'none';
        if (emptyMsg)   emptyMsg.style.display = '';
        return;
    }
    if (sectionTab) sectionTab.style.display = '';
    if (emptyMsg)   emptyMsg.style.display = 'none';

    // マスタースライダー・自動消灯トグルを現在値に同期
    const masterSlider = $('light-glb-master');
    const masterNum    = $('light-glb-master-num');
    const masterNumSpan = $('glb-master-num');
    if (masterSlider) masterSlider.value = glbLightMaster;
    if (masterNum)    masterNum.value = glbLightMaster;
    if (masterNumSpan) masterNumSpan.textContent = glbLightMaster.toFixed(2);
    const autoToggle = $('glb-auto-toggle');
    if (autoToggle) { autoToggle.checked = glbLightAutoMode; }

    const typeLabel = {
        PointLight: '🔆 点光源',
        SpotLight: '🔦 スポット',
        DirectionalLight: '☀ 平行光',
        RectAreaLight: '▭ エリア'
    };
    list.innerHTML = '';

    glbLights.forEach((light, i) => {
        // ミラーライト（シンメトリーで自動生成）はUIカードを表示しない
        if (light.userData && light.userData.isMirrorLight) return;

        const typeStr = (light.userData && light.userData.isAreaLight) ? '▭ エリア' : (typeLabel[light.type] || light.type);
        const colorHex = '#' + light.color.getHexString();
        const baseName = light.userData.labelName || light.name || (typeStr + ' #' + (i + 1));
        const base = light.userData.baseIntensity || light.intensity;

        const row = document.createElement('div');
        row.style.cssText = 'margin-bottom:10px;padding:8px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.12);border-radius:6px;';

        // エリアライトはサイズ・位置・ギズモ・シンメトリーも表示
        const pos = light.position;
        const isSym = !!light.userData.symmetry;
        // isAreaLight（PointLight代用）も RectAreaLight と同じUIを出す
        const isAreaLike = light.isRectAreaLight || light.userData.isAreaLight;
        // サイズ・向きの現在値を取得
        const _anode = light.userData.areaNode;
        const _aw = light.isRectAreaLight ? light.width  : (_anode ? _anode.scale.x : 1);
        const _ah = light.isRectAreaLight ? light.height : (_anode ? _anode.scale.z : 1); // Z=高さ(シェーダー軸と一致)
        const _asrc = light.isRectAreaLight ? light.rotation : (_anode ? _anode.rotation : new THREE.Euler());
        const _rx = THREE.MathUtils.radToDeg(_asrc.x || 0);
        const _ry = THREE.MathUtils.radToDeg(_asrc.y || 0);
        const _rz = THREE.MathUtils.radToDeg(_asrc.z || 0);
        const _isT = currentGizmoType === 'glb_arealight' && currentGizmoIndex === i && currentGizmoMode === 'translate';
        const _isR = currentGizmoType === 'glb_arealight' && currentGizmoIndex === i && currentGizmoMode === 'rotate';
        const _isS = currentGizmoType === 'glb_arealight' && currentGizmoIndex === i && currentGizmoMode === 'scale';
        const extraRow = isAreaLike
            ? `<div style="margin-top:8px;display:flex;flex-direction:column;gap:6px;">

                 <!-- ギズモボタン行 -->
                 <div style="display:flex;gap:4px;">
                   <button class="sp-gizmo-btn${_isT?' active':''}" id="gizmo-alight-${i}-translate"
                     onclick="toggleGizmo('glb_arealight',${i},'translate')"
                     style="flex:1;font-size:10px;">📍 移動</button>
                   <button class="sp-gizmo-btn${_isR?' active':''}" id="gizmo-alight-${i}-rotate"
                     onclick="toggleGizmo('glb_arealight',${i},'rotate')"
                     style="flex:1;font-size:10px;">🔄 回転</button>
                   <button class="sp-gizmo-btn${_isS?' active':''}" id="gizmo-alight-${i}-scale"
                     onclick="toggleGizmo('glb_arealight',${i},'scale')"
                     style="flex:1;font-size:10px;">⤢ 拡縮</button>
                 </div>

                 <!-- 位置 -->
                 <div>
                   <div style="font-size:10px;color:#888;margin-bottom:2px;">位置 XYZ</div>
                   <div class="sp-xyz-row">
                     <span class="sp-axis-label">X:</span>
                     <input type="number" id="alight-x-${i}" class="sp-xyz-input" value="${pos.x.toFixed(2)}" step="0.1"
                       oninput="setAreaLightPos(${i},'x',parseFloat(this.value)||0)">
                     <span class="sp-axis-label">Y:</span>
                     <input type="number" id="alight-y-${i}" class="sp-xyz-input" value="${pos.y.toFixed(2)}" step="0.1"
                       oninput="setAreaLightPos(${i},'y',parseFloat(this.value)||0)">
                     <span class="sp-axis-label">Z:</span>
                     <input type="number" id="alight-z-${i}" class="sp-xyz-input" value="${pos.z.toFixed(2)}" step="0.1"
                       oninput="setAreaLightPos(${i},'z',parseFloat(this.value)||0)">
                   </div>
                 </div>

                 <!-- 向き -->
                 <div>
                   <div style="font-size:10px;color:#888;margin-bottom:2px;">向き (deg) — X:上下 Y:左右 Z:ロール</div>
                   <div class="sp-xyz-row">
                     <span class="sp-axis-label">X:</span>
                     <input type="number" id="alight-rx-${i}" class="sp-xyz-input" value="${_rx.toFixed(1)}" step="5"
                       oninput="setAreaLightRotation(${i},'x',this.value)">
                     <span class="sp-axis-label">Y:</span>
                     <input type="number" id="alight-ry-${i}" class="sp-xyz-input" value="${_ry.toFixed(1)}" step="5"
                       oninput="setAreaLightRotation(${i},'y',this.value)">
                     <span class="sp-axis-label">Z:</span>
                     <input type="number" id="alight-rz-${i}" class="sp-xyz-input" value="${_rz.toFixed(1)}" step="5"
                       oninput="setAreaLightRotation(${i},'z',this.value)">
                   </div>
                 </div>

                 <!-- サイズ -->
                 <div>
                   <div style="font-size:10px;color:#888;margin-bottom:2px;">サイズ (幅 W / 高さ H)</div>
                   <div class="sp-xyz-row">
                     <span class="sp-axis-label">W:</span>
                     <input type="number" id="alight-w-${i}" class="sp-xyz-input" value="${_aw.toFixed(2)}" step="0.1" min="0.01"
                       oninput="setAreaLightSize(${i},'w',this.value)">
                     <span class="sp-axis-label">H:</span>
                     <input type="number" id="alight-h-${i}" class="sp-xyz-input" value="${_ah.toFixed(2)}" step="0.1" min="0.01"
                       oninput="setAreaLightSize(${i},'h',this.value)">
                   </div>
                 </div>

               </div>`
            : '';

        row.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                <span style="font-size:11px;color:#ffcc55;font-weight:bold;">${typeStr}</span>
                <label style="display:flex;align-items:center;gap:5px;font-size:10px;cursor:pointer;">
                    <input type="checkbox" ${!light.userData.manuallyOff ? 'checked' : ''} style="accent-color:#00ffcc;"
                        onchange="glbLights[${i}].userData.manuallyOff=!this.checked;applyGlbLightIntensities();">ON
                </label>
            </div>
            <div style="font-size:10px;color:#888;margin-bottom:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${baseName}</div>
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;font-size:10px;color:#aaa;">
                <span style="min-width:40px;">強度</span>
                <input type="range" min="0" max="${(light.isRectAreaLight || light.userData.isAreaLight) ? 30 : 10}" step="0.05" value="${base.toFixed(2)}"
                    style="flex:1;accent-color:#00ffcc;"
                    oninput="const _v=parseFloat(this.value);glbLights[${i}].userData.baseIntensity=_v;
                             applyGlbLightIntensities();
                             this.nextElementSibling.textContent=_v.toFixed(2);">
                <span style="min-width:28px;">${base.toFixed(2)}</span>
            </div>
            <div style="display:flex;align-items:center;gap:6px;font-size:10px;color:#aaa;">
                <span style="min-width:40px;">色</span>
                <input type="color" value="${colorHex}"
                    style="width:32px;height:22px;border:none;cursor:pointer;background:none;"
                    oninput="glbLights[${i}].color.set(this.value);if(glbLights[${i}].userData.mirrorLight)glbLights[${i}].userData.mirrorLight.color.set(this.value);">
            </div>
            ${extraRow}`;
        list.appendChild(row);
    });
}

