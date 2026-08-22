// ============================================================
//  甲板照明システム (Deck Light System)
// ============================================================

// ============================================================
//  ブルーム初期化
// ============================================================
function initBloomComposer() {
    if (!THREE.EffectComposer) return; // CDN未ロードなら何もしない

    noBloomDarkMaterial = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide });

    // UnrealBloomPass: resolution, strength, radius, threshold
    // threshold を高めにして「本当に明るいもの（航行灯・デコールライト）だけ」光らせる
    // v87: radiusを0.45→0.35、strengthを0.55→0.48、thresholdを0.72→0.8へ。
    // 個々の光源(甲板灯・窓明かり等)のにじみが広範囲に重なり合い、空や海際まで
    // パヤッとした白っぽい靄になって見えていたための調整（上のfog色除外とセット）。
    bloomPass = new THREE.UnrealBloomPass(
        new THREE.Vector2(window.innerWidth, window.innerHeight),
        0.48,   // strength  (光の広がり強さ)
        0.35,   // radius    (光の広がり半径)
        0.80    // threshold (この輝度以上がブルームの対象)
    );

    // --- ① ブルーム抽出専用コンポーザー（画面には出さない） ---
    // renderWithBloom() が毎フレーム noBloom 対象を黒く塗りつぶしてから render() する。
    // ここで作られる renderTarget2 の中身は「光だけ」のテクスチャとして②で使う。
    bloomComposer = new THREE.EffectComposer(renderer);
    bloomComposer.renderToScreen = false;
    bloomRenderPass = new THREE.RenderPass(scene, camera);
    bloomComposer.addPass(bloomRenderPass);
    bloomComposer.addPass(bloomPass);

    // --- ② ブルーム結果をキャンバスに加算で重ねるための全画面クアッド ---
    // renderer.render(scene, camera) でキャンバスへ直接描いた直後に、これを
    // autoClear=false で重ねて描くだけ。船体本体はオフスクリーンRenderTargetを
    // 一切経由しないため、ブルームOFF時と完全に同じ精度・経路で描画される。
    bloomOverlayScene = new THREE.Scene();
    bloomOverlayCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const overlayMat = new THREE.MeshBasicMaterial({
        map: bloomComposer.renderTarget2.texture,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthTest: false,
        depthWrite: false
    });
    bloomOverlayScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), overlayMat));
}

// noBloom対象（GLB船体・プロペラ・舵・空・海面などPBR/シェーダー面）を一時的に真っ黒へ差し替える。
// ブルーム抽出パスの輝度抽出・ブラーから完全に除外するための処理。
// Points（煙突の煙・スクリューの泡・引き波など）はMeshと違って同じ手法でマテリアルを
// 差し替えられないため、抽出パスの間だけ visible=false にして除外する。
function darkenNoBloomObjects(obj) {
    if (obj.isMesh && obj.userData.noBloom && obj.material !== noBloomDarkMaterial) {
        noBloomMaterialCache.set(obj.uuid, obj.material);
        obj.material = noBloomDarkMaterial;
    } else if (obj.isPoints && obj.userData.noBloom) {
        obj.userData._wasVisibleForBloom = obj.visible;
        obj.visible = false;
    }
}

// ブルーム抽出パスの直後に元のマテリアルへ戻す。
function restoreNoBloomObjects(obj) {
    const mat = noBloomMaterialCache.get(obj.uuid);
    if (mat) {
        obj.material = mat;
        noBloomMaterialCache.delete(obj.uuid);
    } else if (obj.isPoints && obj.userData.noBloom) {
        obj.visible = obj.userData._wasVisibleForBloom;
    }
}

// 選択的ブルームの実レンダリング。
// ①noBloom対象を黒く塗りつぶしてブルーム抽出 → ②元に戻す →
// ③renderer.render()でキャンバスへ直接描画 → ④ブルーム結果を加算で重ねる。
function renderWithBloom() {
    scene.traverse(darkenNoBloomObjects);

    // v87: ブルーム抽出パスの間だけ霧の色を黒に差し替える。
    // 理由: 窓明かりなど(hasWindowGlow=trueでnoBloom対象から外れているメッシュ)は
    // 通常のscene.fogをそのまま受けるため、霧の明るい色(fogColor)にブレンドされた
    // ぶんだけ抽出輝度が底上げされ、本来光らせたい範囲を超えて空や海際まで
    // ブルームがパヤッと滲む原因になっていた。fogを無効化(null)せず色だけ黒に
    // するのは、有効/無効を切り替えるとシェーダーのUSE_FOG定義が変わってしまい
    // 毎フレームprogram切り替えコストが発生するため（色の変更はuniform更新だけで
    // 済み、day/nightサイクルが毎フレーム行っているのと同じくらい軽い）。
    const savedFogColorHex = scene.fog ? scene.fog.color.getHex() : null;
    if (scene.fog) scene.fog.color.setRGB(0, 0, 0);

    bloomComposer.render();

    if (scene.fog && savedFogColorHex !== null) scene.fog.color.setHex(savedFogColorHex);
    scene.traverse(restoreNoBloomObjects);

    renderer.setRenderTarget(null);
    renderer.autoClear = true;
    renderer.render(scene, camera);

    renderer.autoClear = false;
    renderer.render(bloomOverlayScene, bloomOverlayCamera);
    renderer.autoClear = true;
}

function setBloomEnabled(enabled) {
    bloomEnabled = enabled;
}
function setBloomStrength(v)   { if (bloomPass) bloomPass.strength   = v; }
function setBloomRadius(v)     { if (bloomPass) bloomPass.radius     = v; }
function setBloomThreshold(v)  { if (bloomPass) bloomPass.threshold  = v; }

// ============================================================
//  煙突スポットライト（両脇から下から照らし上げるアップライト）
// ============================================================
/**
 * 既存の煙突アップライトを全削除する。
 */
function clearFunnelUplights() {
    funnelUplights.forEach(fu => {
        [fu.spotL, fu.spotR].forEach(s => { if (s && s.parent) s.parent.remove(s); });
        [fu.targetL, fu.targetR].forEach(t => { if (t && t.parent) t.parent.remove(t); });
        [fu.markerL, fu.markerR].forEach(m => { if (m && m.parent) m.parent.remove(m); });
    });
    funnelUplights.length = 0;
}

/**
 * 煙突の左右両脇、根元より下（甲板付近）に SpotLight を1つずつ配置し、
 * 下から斜め上の煙突に向けて照らし上げる「ライトアップ」を実現する。
 * 各サイドには見た目だけのマーカー(Object3D)があり、これをギズモで回転させると
 * 照射方向（角度）を調整できる。
 * @param {number} x, y, z  煙突の根元座標（shipGroupローカル）
 * @param {number} rx       煙突の下径
 * @param {number} ry       煙突の高さ
 * @param {number} funnelIndex
 * @param {boolean} isMirror
 */
function createFunnelUplight(x, y, z, rx, ry, funnelIndex, isMirror) {
    const spotColor = 0xffcc66;  // 温かみのあるアンバー
    // 煙突の真横・やや外側に配置（rx基準で余裕をもたせる）
    const sideOffset = rx * 1.8 + 0.8;
    // スポットライトの設置高さ：煙突根元より大きく下（甲板より下）
    const baseY = y - ry * 0.5 - 1.2;

    function makeSide(sign, savedRot) {
        // angle広め（PI/5 ≒ 36°）で煙突全体を照らせる円錐角、距離制限なし(0)
        const spot = new THREE.SpotLight(spotColor, 0, 0, Math.PI / 5, 0.35, 1.5);
        spot.position.set(x + sign * sideOffset, baseY, z);
        spot.castShadow = false;
        spot.userData.isFunnelUplight = true;

        const target = new THREE.Object3D();
        shipGroup.add(target);
        spot.target = target;
        shipGroup.add(spot);

        // ギズモ操作用マーカー：回転させると照射方向（仰角・振り）が変わる。
        const marker = new THREE.Object3D();
        marker.position.copy(spot.position);
        // 既定の照射方向＝真上斜め内側（下から煙突頂部に向かう）
        // sign=+1(左)なら右内側(-X)・上に向ける。sign=-1(右)なら左内側(+X)・上
        marker.userData.aimDir = new THREE.Vector3(-sign * 0.4, 1.0, 0).normalize();
        marker.userData.spot = spot;
        marker.userData.aimDistance = ry + sideOffset + 1.5;
        if (savedRot) marker.rotation.set(savedRot.x || 0, savedRot.y || 0, savedRot.z || 0);
        shipGroup.add(marker);
        updateFunnelUplightAim(marker);

        return { spot, target, marker };
    }

    const f = funnels[funnelIndex];
    const rotKeyL = isMirror ? 'upRotR' : 'upRotL'; // ミラー側は左右が入れ替わる
    const rotKeyR = isMirror ? 'upRotL' : 'upRotR';
    const sideA = makeSide(1, f && f[rotKeyL]);
    const sideB = makeSide(-1, f && f[rotKeyR]);

    funnelUplights.push({
        spotL: sideA.spot, targetL: sideA.target, markerL: sideA.marker,
        spotR: sideB.spot, targetR: sideB.target, markerR: sideB.marker,
        baseIntensity: 5.0, funnelIndex, isMirror: !!isMirror
    });
}

/**
 * マーカーの現在の回転から照射方向を再計算し、SpotLightのtargetを更新する。
 * ギズモでマーカーを回転させた直後、および初期生成時に呼ぶ。
 */
function updateFunnelUplightAim(marker) {
    const spot = marker.userData.spot;
    if (!spot || !spot.target) return;
    const dir = marker.userData.aimDir.clone().applyEuler(marker.rotation);
    spot.target.position.copy(marker.position).addScaledVector(dir, marker.userData.aimDistance);
}

/**
 * 毎フレーム：夜間係数に応じてアップライトの強度を更新する。
 */
function updateFunnelUplights() {
    if (funnelUplights.length === 0) return;
    const nf = lightingNightFactor;
    const targetIntensity = funnelUplightEnabled ? nf : 0;
    funnelUplights.forEach(fu => {
        [fu.spotL, fu.spotR].forEach(s => {
            s.intensity += (fu.baseIntensity * targetIntensity - s.intensity) * 0.08;
            s.visible = s.intensity > 0.01;
        });
    });
}

function setFunnelUplightEnabled(enabled) {
    funnelUplightEnabled = enabled;
    if (!enabled) funnelUplights.forEach(fu => {
        fu.spotL.intensity = 0; fu.spotL.visible = false;
        fu.spotR.intensity = 0; fu.spotR.visible = false;
    });
}

/**
 * ライトプール初期化。init() 後に一度だけ呼ぶ。
 * DECK_LIGHT_POOL_SIZE 個の SpotLight を shipGroup に置いておき、
 * 毎フレーム位置だけ差し替える。SpotLight により片方向（通常は下向き）にのみ照射。
 */
function initDeckLightPool() {
    if (deckLightPoolReady) return;
    for (let i = 0; i < DECK_LIGHT_POOL_SIZE; i++) {
        // 暖色系の電球色。甲板を下向きに照らすSpotLight
        const spot = new THREE.SpotLight(0xffd090, 0, 20, Math.PI / 3, 0.5, 2);
        spot.castShadow = false;
        spot.visible = false;
        spot.userData.isDeckPoolLight = true;
        shipGroup.add(spot);
        // ターゲット（照射方向を決める）
        const tgt = new THREE.Object3D();
        shipGroup.add(tgt);
        spot.target = tgt;
        deckLightPool.push(spot);
        deckLightTargets.push(tgt);
    }
    deckLightPoolReady = true;
}

// UIから呼ぶ：照射方向を設定
function setDeckLightDirAngle(val) {
    deckLightDirAngle = parseFloat(val) || 270;
}
// 照射方向ラベル（UIの説明テキスト用）
function _deckDirLabel(deg) {
    deg = ((parseFloat(deg) % 360) + 360) % 360;
    if (deg >= 247 && deg <= 293) return `${Math.round(deg)}° = 真下`;
    if (deg >= 67 && deg <= 113) return `${Math.round(deg)}° = 真上`;
    if (deg >= 337 || deg <= 23) return `${Math.round(deg)}° = +Z前方（斜め）`;
    if (deg >= 157 && deg <= 203) return `${Math.round(deg)}° = -Z後方（斜め）`;
    if (deg > 23 && deg < 157) return `${Math.round(deg)}° = +X右向き（斜め）`;
    return `${Math.round(deg)}° = -X左向き（斜め）`;
}


// UIから呼ぶ：強度倍率を設定（0=消灯 ～ 5=最大）
function setDeckLightIntensity(val) {
    deckLightIntensityMult = Math.max(0, parseFloat(val) || 0);
}


/**
 * 装飾発光スポット（見た目だけ）を shipGroup のローカル座標に配置する。
 * @param {THREE.Vector3} localPos  shipGroupローカル座標での位置
 * @param {number} color  16進数カラー（例: 0xffd090）
 * @param {number} glowSize  光球の半径
 * @returns {{ group: THREE.Group, worldPos: THREE.Vector3 }}
 */
function createDecorLight(localPos, color = 0xffd090, glowSize = 0.18) {
    const g = new THREE.Group();
    g.position.copy(localPos);

    // 中心の明るい核（小さい球）
    const coreMat = new THREE.MeshBasicMaterial({ color });
    const core = new THREE.Mesh(new THREE.SphereGeometry(glowSize * 0.35, 6, 6), coreMat);
    g.add(core);

    // ソフトな外周グロー（大きめ半透明、加算ブレンド）
    const glowMat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
        blending: THREE.AdditiveBlending
    });
    const glow = new THREE.Mesh(new THREE.SphereGeometry(glowSize, 8, 8), glowMat);
    g.add(glow);

    // 下向きの淡い光の広がり（扁平な楕円グロー）
    const haloMat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.18,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide
    });
    const haloGeo = new THREE.SphereGeometry(glowSize * 2.5, 8, 6);
    const halo = new THREE.Mesh(haloGeo, haloMat);
    halo.scale.set(1, 0.28, 1); // 上下方向に潰す
    halo.position.y = -glowSize * 0.3;
    g.add(halo);

    g.userData.isDecorLight = true;
    g.userData.glowMat = glowMat;
    g.userData.haloMat = haloMat;
    shipGroup.add(g);

    const entry = { group: g, worldPos: new THREE.Vector3(), glowSize, color };
    decorLights.push(entry);
    return entry;
}

/**
 * 既存のすべての装飾発光スポットを削除する。
 * buildFunnelMeshes や importedModel差し替え時に呼ぶ。
 */
function clearDecorLights() {
    decorLights.forEach(d => { if (d.group.parent) d.group.parent.remove(d.group); });
    decorLights.length = 0;
    selectedDecorLightIndex = -1;
    // プールライトをすべて OFF に
    deckLightPool.forEach(sp => { sp.visible = false; sp.intensity = 0; });
}

/**
 * 毎フレーム呼ぶ。
 * 1. 各 decorLight の worldPos を更新
 * 2. カメラとの距離順でソート
 * 3. 上位 DECK_LIGHT_POOL_SIZE 個だけに実際の SpotLight を割り当て
 * 4. 夜間のみ点灯（lightingNightFactor 連動）+ 強度倍率・方向適用
 */
function updateDeckLightPool() {
    if (!deckLightPoolReady || decorLights.length === 0) return;

    // 夜間係数。0=昼=消灯、1=夜=全灯
    const nf = lightingNightFactor;
    const isLit = nf > 0.02;

    // 全グロー球の輝度を昼夜係数に合わせる（見た目だけ点灯）
    decorLights.forEach((d, idx) => {
        const gm = d.group.userData.glowMat;
        const hm = d.group.userData.haloMat;
        if (gm) gm.opacity = 0.45 * nf;
        if (hm) hm.opacity = 0.18 * nf;
        // worldPos 更新
        d.group.getWorldPosition(d.worldPos);
        // 選択中スポットをハイライト（コア球を少し大きく）
        const core = d.group.children[0];
        if (core) core.scale.setScalar(idx === selectedDecorLightIndex ? 2.0 : 1.0);
    });

    if (!isLit) {
        deckLightPool.forEach(sp => { sp.visible = false; sp.intensity = 0; });
        return;
    }

    // カメラとの距離でソート（近い順）
    const camPos = camera.position;
    const sorted = decorLights.slice().sort((a, b) =>
        a.worldPos.distanceToSquared(camPos) - b.worldPos.distanceToSquared(camPos)
    );

    // 照射方向オフセット（shipGroupローカル座標）
    // UIの「方向(deg)」は 0=+Z前 90=+X右 180=-Z後 270=真下（デフォルト）
    // 270degの場合: x=cos(270°)=0, y=-1（真下）, z=sin(270°)=-1 → Y成分が主
    // → 「下方向の成分」を Y = -cos(angle - 270deg) で取り、水平成分も加える
    const dirDeg = (deckLightDirAngle - 270 + 360) % 360; // 270=0基準にシフト
    const dirRad = THREE.MathUtils.degToRad(dirDeg);
    const tiltDist = 6; // ターゲット位置のライトからの距離
    // dirDeg=0 → 真下(0,−1,0)、90 → +X斜め、180 → 真上、270 → −X斜め
    const tgtDir = new THREE.Vector3(
        Math.sin(dirRad),
        -Math.cos(dirRad),
        0
    ).normalize().multiplyScalar(tiltDist);

    // 上位 N 個にライトを割り当て
    deckLightPool.forEach((sp, i) => {
        if (i < sorted.length) {
            const entry = sorted[i];
            const localPt = entry.worldPos.clone();
            shipGroup.worldToLocal(localPt);
            sp.position.copy(localPt);
            // ターゲットをライト位置 + 照射方向へ
            const tgt = deckLightTargets[i];
            if (tgt) tgt.position.copy(localPt).add(tgtDir);
            sp.intensity = 1.8 * nf * deckLightIntensityMult;
            sp.visible = true;
        } else {
            sp.visible = false;
            sp.intensity = 0;
        }
    });
}

// ============================================================
//  (旧)煙突サーチライトコーンは廃止 — 両脇からのアップライト式に統一
// ============================================================

/**
 * プロムナードデッキ用の帯状照明を配置する。
 * shipGroup ローカル座標で y=deckY の高さに沿って連続したスポットを並べる。
 * @param {number} deckY   甲板の高さ（shipGroupローカルY）
 * @param {number} deckZFrom  船首方向 Z 開始
 * @param {number} deckZTo    船尾方向 Z 終了
 * @param {number} count   配置するスポット数
 * @param {number} sideX   左右のX座標（対称で配置）
 */
function placePromenadeLights(deckY, deckZFrom, deckZTo, count, sideX, color) {
    const col = color || 0xffc870;
    for (let i = 0; i < count; i++) {
        const z = deckZFrom + (deckZTo - deckZFrom) * (i / Math.max(1, count - 1));
        createDecorLight(new THREE.Vector3( sideX, deckY, z), col, 0.22);
        createDecorLight(new THREE.Vector3(-sideX, deckY, z), col, 0.22);
    }
}

/**
 * プロムナードデッキ一括配置ボタンのハンドラ
 */
function applyPromenadeLights() {
    const deckY     = parseFloat($('dl-prom-y').value)    || 2.5;
    const zFrom     = parseFloat($('dl-prom-zfrom').value) || 6;
    const zTo       = parseFloat($('dl-prom-zto').value)   || -6;
    const sideX     = parseFloat($('dl-prom-x').value)    || 2.5;
    const count     = Math.max(2, parseInt($('dl-prom-count').value) || 8);
    const hexColor  = $('dl-prom-color').value || '#ffc870';
    const color     = parseInt(hexColor.replace('#', '0x'));
    clearDecorLights();
    placePromenadeLights(deckY, zFrom, zTo, count, sideX, color);
    updateDeckLightPoolStatus();
}

/**
 * 個別スポット追加ボタンのハンドラ
 */
function addSingleDecorLight() {
    const x    = parseFloat($('dl-spot-x').value)    || 0;
    const y    = parseFloat($('dl-spot-y').value)    || 3;
    const z    = parseFloat($('dl-spot-z').value)    || 0;
    const size = parseFloat($('dl-spot-size').value) || 0.22;
    const hexColor = $('dl-spot-color').value || '#ffd090';
    const color = parseInt(hexColor.replace('#', '0x'));
    createDecorLight(new THREE.Vector3(x, y, z), color, size);
    updateDeckLightPoolStatus();
}

/**
 * インデックス指定でdecorLightを1個削除する
 */
function removeDecorLightAt(index) {
    if (index < 0 || index >= decorLights.length) return;
    if (currentGizmoType === 'decklight' && currentGizmoIndex === index) disableGizmo();
    const d = decorLights[index];
    if (d.group.parent) d.group.parent.remove(d.group);
    decorLights.splice(index, 1);
    // ギズモのインデックスがずれる場合は無効化
    if (currentGizmoType === 'decklight' && currentGizmoIndex > index) {
        currentGizmoIndex--;
        selectedDecorLightIndex = currentGizmoIndex;
    }
    updateDeckLightPoolStatus();
}

function setDecorLightSize(i, newSize) {
    const d = decorLights[i];
    if (!d) return;
    newSize = Math.max(0.05, parseFloat(newSize) || 0.18);
    d.glowSize = newSize;
    // メッシュを作り直す（group内の3つ: core, glow, halo）
    while (d.group.children.length > 0) d.group.remove(d.group.children[0]);
    const col = d.color || 0xffd090;
    const coreMat = new THREE.MeshBasicMaterial({ color: col });
    const core = new THREE.Mesh(new THREE.SphereGeometry(newSize * 0.35, 6, 6), coreMat);
    d.group.add(core);
    const glowMat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.45, depthWrite: false, blending: THREE.AdditiveBlending });
    const glow = new THREE.Mesh(new THREE.SphereGeometry(newSize, 8, 8), glowMat);
    d.group.add(glow);
    const haloMat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.18, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    const halo = new THREE.Mesh(new THREE.SphereGeometry(newSize * 2.5, 8, 6), haloMat);
    halo.scale.set(1, 0.28, 1);
    halo.position.y = -newSize * 0.3;
    d.group.add(halo);
    d.group.userData.glowMat = glowMat;
    d.group.userData.haloMat = haloMat;
}

function setDecorLightPos(i, x, y, z) {
    const d = decorLights[i];
    if (!d) return;
    d.group.position.set(
        x !== null ? parseFloat(x) : d.group.position.x,
        y !== null ? parseFloat(y) : d.group.position.y,
        z !== null ? parseFloat(z) : d.group.position.z
    );
    updateDeckLightPoolStatus();
}

function updateDeckLightPoolStatus() {
    const el = $('dl-pool-status');
    if (el) el.textContent = `配置数: ${decorLights.length} スポット / プール予算: ${DECK_LIGHT_POOL_SIZE} 本物ライト`;

    const listEl = $('dl-spot-list');
    if (!listEl) return;
    listEl.innerHTML = '';

    if (decorLights.length === 0) {
        listEl.innerHTML = '<div style="font-size:10px;color:#555;padding:4px 0;">スポットがありません。上で追加してください。</div>';
        return;
    }

    decorLights.forEach((d, i) => {
        const pos = d.group.position;
        const gs = (d.glowSize || 0.18).toFixed(2);
        const isGizmoActive = currentGizmoType === 'decklight' && currentGizmoIndex === i;

        const wrap = document.createElement('div');
        wrap.style.cssText = 'border:1px solid #1a3a5a;border-radius:4px;padding:4px 6px;margin-bottom:5px;background:#040f1c;';

        // 行1: 番号 + 座標 + ギズモ + 削除
        const row1 = document.createElement('div');
        row1.style.cssText = 'display:flex;align-items:center;gap:4px;margin-bottom:4px;';
        row1.innerHTML = `
          <span style="color:#00ffcc;font-size:10px;min-width:22px;font-weight:bold;">#${i}</span>
          <span style="flex:1;font-size:10px;color:#aaa;">
            X:<input type="number" value="${pos.x.toFixed(2)}" step="0.1" style="width:42px;background:#0a1932;color:#fff;border:1px solid #333;border-radius:2px;font-size:9px;padding:1px;"
              oninput="setDecorLightPos(${i},this.value,null,null)">
            Y:<input type="number" value="${pos.y.toFixed(2)}" step="0.1" style="width:42px;background:#0a1932;color:#fff;border:1px solid #333;border-radius:2px;font-size:9px;padding:1px;"
              oninput="setDecorLightPos(${i},null,this.value,null)">
            Z:<input type="number" value="${pos.z.toFixed(2)}" step="0.1" style="width:42px;background:#0a1932;color:#fff;border:1px solid #333;border-radius:2px;font-size:9px;padding:1px;"
              oninput="setDecorLightPos(${i},null,null,this.value)">
          </span>`;
        wrap.appendChild(row1);

        // 行2: サイズ + ギズモ(移動) + 削除
        const row2 = document.createElement('div');
        row2.style.cssText = 'display:flex;align-items:center;gap:4px;';
        row2.innerHTML = `
          <span style="font-size:10px;color:#888;">サイズ:</span>
          <input type="number" value="${gs}" step="0.02" min="0.05" max="2.0"
            style="width:50px;background:#0a1932;color:#fff;border:1px solid #333;border-radius:2px;font-size:9px;padding:1px;"
            oninput="setDecorLightSize(${i},this.value)">
          <button class="sp-gizmo-btn${isGizmoActive ? ' active' : ''}"
            id="gizmo-decklight-${i}"
            onclick="toggleGizmo('decklight',${i},'translate');updateDeckLightPoolStatus();"
            style="padding:2px 6px;font-size:11px;" title="3Dギズモで移動">📍 移動</button>
          <button class="sp-remove-btn"
            onclick="removeDecorLightAt(${i})"
            style="padding:2px 6px;font-size:10px;margin-left:auto;" title="削除">✕</button>`;
        wrap.appendChild(row2);

        listEl.appendChild(wrap);
    });
}
function updateSmokeSettings() {
    smokeSettings.density   = spVal('smoke-density');
    smokeSettings.speed     = spVal('smoke-speed');
    smokeSettings.color     = $('smoke-color') ? $('smoke-color').value : 'gray';
    smokeSettings.speedLinked = $('smoke-speed-linked') ? $('smoke-speed-linked').checked : true;
    const colorMap = { gray: 0xaaaaaa, black: 0x222222, white: 0xeeeeee, light: 0xcccccc };
    if (globalSmokeMat) {
        globalSmokeMat.uniforms.color.value.setHex(colorMap[smokeSettings.color] || 0xaaaaaa);
        globalSmokeMat.uniforms.dens.value = smokeSettings.density;
    }
}

function animateSmoke(t, dt) {
    if (!globalSmokeGeo) return;
    const active = smokeSettings.speedLinked ? Math.abs(physics.speed) > 0.3 : true;
    const spd = smokeSettings.speed;

    // Wind force
    const windRad = physics.windDir * Math.PI / 180;
    const wX = Math.sin(windRad) * physics.windSpeed * 0.15;
    const wZ = Math.cos(windRad) * physics.windSpeed * 0.15;

    const posAttr = globalSmokeGeo.attributes.position;
    const ageAttr = globalSmokeGeo.attributes.age;

    // Day/night brightness factor so smoke isn't unnaturally glowing at night
    const lf = THREE.MathUtils.clamp(
        ambientLight.intensity * 0.6 + hemiLight.intensity * 0.5 + sunLight.intensity * 0.35,
        0.16, 1.15
    );
    globalSmokeMat.uniforms.lightFactor.value = lf;
    // 水しぶき・泡も同じ明るさ係数で暗くする
    if (wakeParticleMat) wakeParticleMat.uniforms.lightFactor.value = THREE.MathUtils.clamp(lf * 0.9, 0.05, 1.0);
    if (bubbleMat) bubbleMat.uniforms.lightFactor.value = THREE.MathUtils.clamp(lf * 0.85, 0.05, 1.0);
    // Scale puff size relative to ship size so small ships don't get oversized "moko" blobs
    globalSmokeMat.uniforms.sizeScale.value = THREE.MathUtils.clamp(physics.scale / 22.0, 0.18, 1.6);

    // Update existing particles
    for(let i=0; i<perf.smokeCap; i++) {
        if (ageAttr.array[i] <= 1.0) {
            // Slower aging => smoke lingers and travels much further before fading
            ageAttr.array[i] += dt * spd * (0.055 + smokeData[i].rand * 0.04);

            // Gentle per-particle turbulence breaks up uniform "blob" clumping
            const swirl = smokeData[i].rand * Math.PI * 2.0;
            const turbX = Math.sin(t * 0.4 + swirl) * 0.18;
            const turbZ = Math.cos(t * 0.35 + swirl) * 0.18;

            posAttr.array[i*3]   += (smokeData[i].vel.x + wX + turbX) * dt;
            posAttr.array[i*3+1] += (smokeData[i].vel.y + spd * 1.7 + smokeData[i].rand * 1.1) * dt;
            posAttr.array[i*3+2] += (smokeData[i].vel.z + wZ + turbZ) * dt;
        }
    }

    // Emit new particles from funnels using a fractional accumulator so that
    // slow ships / low density settings still get a smooth continuous stream
    // instead of sporadic big puffs.
    if (active && funnels.length > 0) {
        const sym = $('funnel-symmetry') && $('funnel-symmetry').checked;
        const emitPositions = [];

        funnels.forEach(f => {
            let localPos = new THREE.Vector3(f.x, f.y + f.ry, f.z);
            let wp = localPos.applyMatrix4(shipGroup.matrixWorld);
            emitPositions.push(wp.clone());

            if (sym && Math.abs(f.x) > 0.05) {
                let localPos2 = new THREE.Vector3(-f.x, f.y + f.ry, f.z);
                let wp2 = localPos2.applyMatrix4(shipGroup.matrixWorld);
                emitPositions.push(wp2.clone());
            }
        });

        const emitRate = (1.0 + 5.0 * smokeSettings.density) * (0.35 + 0.65 * spd) * emitPositions.length;
        smokeEmitAccum += emitRate * dt;

        while (smokeEmitAccum >= 1 && emitPositions.length > 0) {
            smokeEmitAccum -= 1;
            const wp = emitPositions[Math.floor(Math.random() * emitPositions.length)];
            const i = smokeIdx;
            ageAttr.array[i] = 0;
            posAttr.array[i*3]   = wp.x + (Math.random()-0.5) * 0.4;
            posAttr.array[i*3+1] = wp.y;
            posAttr.array[i*3+2] = wp.z + (Math.random()-0.5) * 0.4;

            smokeData[i].rand = Math.random();
            const rotY = (physics.heading * Math.PI) / 180;
            const shipVx = Math.sin(rotY) * physics.speed * 0.5;
            const shipVz = Math.cos(rotY) * physics.speed * 0.5;
            smokeData[i].vel.set(shipVx, 0, shipVz);

            smokeIdx = (smokeIdx + 1) % perf.smokeCap;
        }
    } else {
        smokeEmitAccum = 0;
    }

    posAttr.needsUpdate = true;
    ageAttr.needsUpdate = true;
}

function animatePropellers(t, dt) {
    const spd = physics.speed;
    propMeshes.forEach(g => {
        const dir = g.userData.dir || 1;
        if (g.userData.isProp) {
            g.rotation.z += spd * 0.15 * dir;
        }
    });

    // 読み込んだGLB/OBJモデル内の "Screw"(スクリュー) / "Rudder"(舵) を自動で動かす
    if (glbMovableParts && glbMovableParts.length > 0) {
        glbMovableParts.forEach((part) => {
            if (part.disabled) return;
            const obj = part.object;
            if (!obj) return;
            const invert = part.invert ? -1 : 1;
            const axis = part.spinAxis || 'x';
            // pivotOffset は親（shipGroup）ローカル座標系でのオフセット
            const pv = part.pivotOffset || new THREE.Vector3();

            if (part.key === 'screw' || part.key === 'paddle') {
                part.spin = (part.spin || 0) + spd * 1.5 * invert * (dt || 0);

                // 回転軸 (basePos + pivotOffset) を中心に回転させる。
                // モデル自体の原点は basePos のまま変わらない。
                const angle = part.baseRot[axis] + part.spin;
                obj.rotation.copy(part.baseRot);
                obj.rotation[axis] = angle;

                const pvBase = pv.clone().applyEuler(part.baseRot); // 基準姿勢でのオフセット
                const pvRot = pv.clone().applyEuler(obj.rotation);  // 回転後のオフセット
                obj.position.copy(part.basePos).add(pvBase).sub(pvRot);

            } else if (part.key === 'rudder') {
                const rudderRad = THREE.MathUtils.degToRad(physics.rudderAngle) * invert;

                if (pv.lengthSq() < 0.0001) {
                    // pivotOffsetが未設定(ゼロ)なら従来通り原点回転
                    obj.rotation.copy(part.baseRot);
                    obj.rotation[axis] = part.baseRot[axis] + rudderRad;
                } else {
                    // pivotOffsetが設定されているとき:
                    // オブジェクトのワールド行列を使ってpivotをワールド空間で処理する
                    obj.updateMatrixWorld(true);
                    const parent = obj.parent;

                    // pivot位置をワールド座標で計算（parentのローカル座標系でbasePos+pivotOffset）
                    const pivotWorld = new THREE.Vector3();
                    if (parent) {
                        parent.updateMatrixWorld(true);
                        pivotWorld.copy(part.basePos).add(pv);
                        pivotWorld.applyMatrix4(parent.matrixWorld);
                    } else {
                        pivotWorld.copy(part.basePos).add(pv);
                    }

                    // baseRotを適用した状態をワールド空間で取得
                    obj.rotation.copy(part.baseRot);
                    obj.position.copy(part.basePos);
                    obj.updateMatrixWorld(true);

                    // ワールド空間でpivotを中心に回転させるクォータニオン
                    const axisVec = new THREE.Vector3(
                        axis === 'x' ? 1 : 0,
                        axis === 'y' ? 1 : 0,
                        axis === 'z' ? 1 : 0
                    );
                    // 軸をワールド空間に変換（オブジェクトのbaseRotを反映）
                    if (parent) axisVec.transformDirection(parent.matrixWorld);
                    const rotQ = new THREE.Quaternion().setFromAxisAngle(axisVec, rudderRad);

                    // オブジェクトのワールド座標を取得してpivotからの相対位置を回転
                    const objWorld = new THREE.Vector3();
                    obj.getWorldPosition(objWorld);
                    const relWorld = objWorld.clone().sub(pivotWorld);
                    relWorld.applyQuaternion(rotQ);
                    const newObjWorld = relWorld.add(pivotWorld);

                    // ワールド座標を親のローカル座標に変換して position に設定
                    if (parent) {
                        const invParent = new THREE.Matrix4().copy(parent.matrixWorld).invert();
                        newObjWorld.applyMatrix4(invParent);
                    }
                    obj.position.copy(newObjWorld);

                    // 回転はbaseRotにaxis回転を追加（親のワールド回転を考慮）
                    const baseQ = new THREE.Quaternion().setFromEuler(part.baseRot);
                    // parentのワールドクォータニオン
                    const parentQ = new THREE.Quaternion();
                    if (parent) parent.getWorldQuaternion(parentQ);
                    // ワールド空間での回転を親ローカルに変換
                    const parentQInv = parentQ.clone().invert();
                    const finalQ = parentQInv.multiply(rotQ).multiply(parentQ).multiply(baseQ);
                    obj.quaternion.copy(finalQ);
                }
            }
        });
    }
}

