// 53-landmarks.js — 名所の建物・像（ロイヤル・リバー・ビルディング、タイタニック・ベルファスト、自由の女神像など）
//
// 港の建物は OpenStreetMap の輪郭を押し出した箱（51-harbor-detail.js）なので、形に特徴のある名所は
// ここで手で形を作って置く。緯度・経度で置くので、作り込んだ港の中でなくても、将来ほかの国の世界を
// 作ったときも、そこへ行けば見える（例：ニューヨークの自由の女神像はもう登録してある）。
//   LANDMARKS：{ id, name, lat, lon, bearing（長い方の軸の方位）, kind, clear（この半径[m]の OSM の箱は出さない）, ... }
//   船から LANDMARK_RANGE 以内のものだけ作って置き、離れたら捨てる。

const LANDMARK_RANGE = 25000;
const LANDMARKS = [
    // リヴァプールのピア・ヘッド「スリー・グレイシズ」
    { id: 'royal_liver', name: 'ロイヤル・リバー・ビルディング', lat: 53.405837, lon: -2.995896, bearing: 58, kind: 'royal_liver', len: 97, wid: 57, clear: 52 },
    { id: 'cunard', name: 'キュナード・ビルディング', lat: 53.405131, lon: -2.995602, bearing: 67, kind: 'palazzo', len: 97, wid: 62, hgt: 31, clear: 52 },
    { id: 'port_of_liverpool', name: 'ポート・オブ・リヴァプール・ビルディング', lat: 53.404395, lon: -2.994916, bearing: 153, kind: 'pol', len: 80, wid: 65, clear: 48 },
    // ベルファスト：タイタニック号の船首を 4 つ並べた形の博物館（船台のそば）
    { id: 'titanic_belfast', name: 'タイタニック・ベルファスト', lat: 54.608130, lon: -5.909927, bearing: 172, kind: 'titanic_belfast', size: 88, hgt: 38, clear: 50 },
    // ニューヨーク（アメリカの世界を作ったとき用。いまのブリテン諸島の世界からは遠いので出ない）
    { id: 'liberty', name: '自由の女神像', lat: 40.689250, lon: -74.044500, bearing: 135, kind: 'liberty', clear: 80 },
];
window.LANDMARKS = LANDMARKS;

// 51-harbor-detail.js の建物の箱を出さない所（名所の足元）
function landmarkClears(lat, lon) {
    for (const L of LANDMARKS) {
        if (!L.clear) continue;
        const dN = (lat - L.lat) * 111195, dE = (lon - L.lon) * 111195 * Math.cos(L.lat * Math.PI / 180);
        if (dN * dN + dE * dE < L.clear * L.clear) return true;
    }
    return false;
}
window.landmarkClears = landmarkClears;

// ── 材質 ──
const _lmMats = {};
function _lmMat(key, hex, o) {
    if (!_lmMats[key]) {
        const m = new THREE.MeshStandardMaterial(Object.assign({ roughness: 0.8, metalness: 0.05 }, o || {}));
        m.color.setHex(hex).convertSRGBToLinear();
        if (o && o.emissive !== undefined) m.emissive.setHex(o.emissive).convertSRGBToLinear();
        _lmMats[key] = typeof noShipLightProbe === 'function' ? noShipLightProbe(m) : m;
    }
    return _lmMats[key];
}
// 夜に灯る所（時計の文字盤・たいまつ）
const _lmGlow = [];
function _lmGlowMat(key, hex, base) {
    const m = _lmMat(key, hex, { emissive: hex, roughness: 0.4 });
    if (!_lmGlow.includes(m)) { m.userData.glowBase = base; _lmGlow.push(m); }
    return m;
}

// ── 形を作る道具（原点＝建物の足元の真ん中、+z＝長い方の軸、単位 m）──
function _lmKit(g) {
    const box = new THREE.BoxGeometry(1, 1, 1);
    const add = (geo, m, x, y, z, sx, sy, sz, rx, ry, rz) => {
        const o = new THREE.Mesh(geo, m);
        o.position.set(x, y, z);
        if (sx !== undefined) o.scale.set(sx, sy, sz);
        if (rx || ry || rz) o.rotation.set(rx || 0, ry || 0, rz || 0);
        o.castShadow = true; o.receiveShadow = true;
        g.add(o); return o;
    };
    return {
        box: (m, x, y, z, w, h, d) => add(box, m, x, y + h / 2, z, w, h, d),
        cyl: (m, x, y, z, r0, r1, h, seg) => add(new THREE.CylinderGeometry(r1, r0, h, seg || 16), m, x, y + h / 2, z),
        dome: (m, x, y, z, r, k) => add(new THREE.SphereGeometry(r, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), m, x, y, z, 1, k || 1, 1),
        sphere: (m, x, y, z, r, sx, sy, sz) => add(new THREE.SphereGeometry(r, 14, 10), m, x, y, z, sx || 1, sy || 1, sz || 1),
        disc: (m, x, y, z, r, ry) => add(new THREE.CircleGeometry(r, 20), m, x, y, z, 1, 1, 1, 0, ry || 0, 0),
        geo: (geo, m, x, y, z, rx, ry, rz) => add(geo, m, x, y, z, 1, 1, 1, rx, ry, rz),
    };
}
// 窓の段（壁の表面に暗い帯を何段か）
function _lmWindowBands(K, m, w, d, y0, y1, step) {
    for (let y = y0; y < y1; y += step) {
        K.box(m, 0, y, d / 2 + 0.05, w * 0.92, step * 0.32, 0.2);
        K.box(m, 0, y, -d / 2 - 0.05, w * 0.92, step * 0.32, 0.2);
        K.box(m, w / 2 + 0.05, y, 0, 0.2, step * 0.32, d * 0.92);
        K.box(m, -w / 2 - 0.05, y, 0, 0.2, step * 0.32, d * 0.92);
    }
}

// ロイヤル・リバー・ビルディング（1911 年）：花崗岩の本体（約 46m）の両端（川側と街側）に、時計塔（時計の文字盤は
// 4 面・直径 7.6m）。塔の上は列柱の胴と緑青の丸屋根、そのてっぺんにリバー・バード（高さ 98m）
function _lmRoyalLiver(L) {
    const g = new THREE.Group(), K = _lmKit(g);
    const stone = _lmMat('granite', 0xc8c3b6), dark = _lmMat('win', 0x5d6066, { roughness: 0.5 }), copper = _lmMat('copper', 0x6fa58c, { roughness: 0.6, metalness: 0.3 });
    const clock = _lmGlowMat('clock', 0xf4f0e2, 0.9), hand = _lmMat('hand', 0x1d1d1d);
    const W = L.wid, D = L.len;
    K.box(stone, 0, 0, 0, W, 42, D);
    _lmWindowBands(K, dark, W, D, 4, 40, 4.2);
    K.box(stone, 0, 42, 0, W + 1.2, 1.4, D + 1.2);                   // 軒の飾り
    K.box(stone, 0, 43.4, 0, W * 0.86, 6, D * 0.86);                 // 一段下がった上の階
    for (const s of [-1, 1]) {
        const z = s * (D / 2 - 11);
        K.box(stone, 0, 43, z, 19, 18, 19);                          // 塔の胴
        K.box(stone, 0, 61, z, 20.5, 1.2, 20.5);
        K.box(stone, 0, 62.2, z, 17, 11, 17);                        // 時計の段
        for (const [dx, dz, ry] of [[0, 8.6, 0], [0, -8.6, Math.PI], [8.6, 0, Math.PI / 2], [-8.6, 0, -Math.PI / 2]]) {
            K.disc(clock, dx, 67.7, z + dz, 3.8, ry);
            const hnd = K.box(hand, dx * 1.003, 67.7, z + dz * 1.003, 0.35, 3.0, 0.35); hnd.rotation.set(0, ry, 0.9);
        }
        K.cyl(stone, 0, 73.2, z, 7.5, 7.5, 1.0, 20);
        for (let k = 0; k < 12; k++) {                               // 列柱
            const a = k / 12 * Math.PI * 2;
            K.cyl(stone, Math.sin(a) * 6.6, 74.2, z + Math.cos(a) * 6.6, 0.55, 0.55, 6.5, 8);
        }
        K.cyl(stone, 0, 74.2, z, 5.2, 5.2, 6.5, 16);
        K.cyl(stone, 0, 80.7, z, 7.6, 7.6, 1.2, 20);
        K.dome(copper, 0, 81.9, z, 7.0, 1.0);                        // 丸屋根
        K.cyl(copper, 0, 88.6, z, 1.6, 1.3, 3.0, 10);                // 頂塔
        // リバー・バード（鵜に似た伝説の鳥。翼を広げ、くちばしに海草）
        const bz = z, by = 92.4;
        K.sphere(copper, 0, by + 2.0, bz, 1.2, 1, 1.8, 1);           // 胴
        K.sphere(copper, 0, by + 4.2, bz + s * 0.6, 0.7);            // 頭
        K.box(copper, 0, by + 4.0, bz + s * 1.5, 0.3, 0.3, 1.4);     // くちばし
        for (const w of [-1, 1]) { const o = K.box(copper, w * 1.8, by + 2.8, bz, 3.0, 0.3, 1.4); o.rotation.z = w * 0.5; }
    }
    return g;
}
// 宮殿風の箱（キュナード・ビルディング）：石の大きな箱に、窓の段と軒、上に一段下がった階
function _lmPalazzo(L) {
    const g = new THREE.Group(), K = _lmKit(g);
    const stone = _lmMat('portland', 0xd2cbbb), dark = _lmMat('win', 0x5d6066, { roughness: 0.5 });
    K.box(stone, 0, 0, 0, L.wid, L.hgt, L.len);
    _lmWindowBands(K, dark, L.wid, L.len, 4, L.hgt - 2, 3.8);
    K.box(stone, 0, L.hgt, 0, L.wid + 1.5, 1.5, L.len + 1.5);
    K.box(stone, 0, L.hgt + 1.5, 0, L.wid * 0.9, 4, L.len * 0.9);
    return g;
}
// ポート・オブ・リヴァプール・ビルディング：四隅に丸屋根の小塔、真ん中に高い緑青の大きな丸屋根
function _lmPortOfLiverpool(L) {
    const g = new THREE.Group(), K = _lmKit(g);
    const stone = _lmMat('portland', 0xd2cbbb), dark = _lmMat('win', 0x5d6066, { roughness: 0.5 }), copper = _lmMat('copper', 0x6fa58c, { roughness: 0.6, metalness: 0.3 });
    const W = L.wid, D = L.len, H = 34;
    K.box(stone, 0, 0, 0, W, H, D);
    _lmWindowBands(K, dark, W, D, 4, H - 2, 4);
    K.box(stone, 0, H, 0, W + 1.4, 1.4, D + 1.4);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        const x = sx * (W / 2 - 6), z = sz * (D / 2 - 6);
        K.box(stone, x, H, z, 11, 8, 11);
        K.cyl(stone, x, H + 8, z, 4.5, 4.5, 3, 12);
        K.dome(copper, x, H + 11, z, 4.6, 1.3);
    }
    K.cyl(stone, 0, H, 0, 15, 15, 9, 24);                            // 大きな丸屋根の胴
    for (let k = 0; k < 16; k++) { const a = k / 16 * Math.PI * 2; K.cyl(stone, Math.sin(a) * 15.3, H + 1, Math.cos(a) * 15.3, 0.6, 0.6, 7, 8); }
    K.cyl(stone, 0, H + 9, 0, 15.6, 15.6, 1.4, 24);
    K.dome(copper, 0, H + 10.4, 0, 14.4, 1.25);                      // 大きな丸屋根（てっぺん 約 63m）
    K.cyl(copper, 0, H + 28, 0, 2, 1.4, 5, 10);                      // 頂塔
    return g;
}
// タイタニック・ベルファスト（2012 年）：タイタニック号の船首の高さ（38m）の、とがった 4 つの棟を十字に
function _lmTitanicBelfast(L) {
    const g = new THREE.Group();
    const skin = _lmMat('tb_skin', 0xb9c2c9, { roughness: 0.35, metalness: 0.7 }), base = _lmMat('tb_base', 0x55595e, { roughness: 0.6 });
    const K = _lmKit(g);
    K.box(base, 0, 0, 0, 34, 6, 34);
    const R = L.size / 2, H = L.hgt;
    for (let k = 0; k < 4; k++) {
        // 上から見て船首の形（とがった先が外向き）。上へ行くほど外へ張り出す
        const sh = new THREE.Shape();
        sh.moveTo(-9, 0); sh.lineTo(9, 0); sh.lineTo(4, R * 0.75); sh.lineTo(0, R); sh.lineTo(-4, R * 0.75); sh.closePath();
        const geo = new THREE.ExtrudeGeometry(sh, { depth: H, bevelEnabled: false, steps: 1 });
        geo.rotateX(-Math.PI / 2);                                    // 形の y → −z、押し出し → +y
        // 上ほど外へ（船首が前へ反り出す形）
        const P = geo.attributes.position;
        for (let i = 0; i < P.count; i++) { const y = P.getY(i), f = 1 + 0.25 * (y / H); P.setX(i, P.getX(i) * (1 + 0.1 * y / H)); P.setZ(i, P.getZ(i) * f); }
        geo.computeVertexNormals();
        const o = K.geo(geo, skin, 0, 0, 0, 0, k * Math.PI / 2 + Math.PI / 4, 0);
        o.userData.noLightBake = true;
    }
    return g;
}
// 自由の女神像（1886 年）：星形の要塞の上の台座（地面から 47m）に、銅の像（46m。たいまつまで 93m）
function _lmLiberty(L) {
    const g = new THREE.Group(), K = _lmKit(g);
    const granite = _lmMat('lib_granite', 0xb8b2a6), fort = _lmMat('lib_fort', 0x9e978a), green = _lmMat('lib_copper', 0x6fae95, { roughness: 0.55, metalness: 0.35 });
    const flame = _lmGlowMat('lib_flame', 0xffc53a, 1.2);
    // 11 角の星形の要塞（高さ 9m）
    const sh = new THREE.Shape();
    for (let k = 0; k < 22; k++) { const a = k / 22 * Math.PI * 2, r = k % 2 ? 46 : 70; const x = Math.sin(a) * r, y = Math.cos(a) * r; if (k) sh.lineTo(x, y); else sh.moveTo(x, y); }
    const fg = new THREE.ExtrudeGeometry(sh, { depth: 9, bevelEnabled: false }); fg.rotateX(-Math.PI / 2);
    K.geo(fg, fort, 0, 0, 0);
    // 台座：裾の広がった四角い塔（9m → 47m）
    K.box(granite, 0, 9, 0, 28, 6, 28);
    K.cyl(granite, 0, 15, 0, 13.5 * 1.414, 10.5 * 1.414, 26, 4).rotation.y = Math.PI / 4;
    K.box(granite, 0, 41, 0, 17, 6, 17);
    // 像：衣（裾の広い円すい）・胴・頭・冠・掲げた右腕とたいまつ・左腕の銘板
    const y0 = 47;
    K.cyl(green, 0, y0, 0, 6.5, 4.2, 20, 18);
    K.cyl(green, 0, y0 + 20, 0, 4.2, 3.2, 8, 14);
    K.sphere(green, 0, y0 + 30.8, 0.3, 2.6, 1, 1.15, 1);
    K.cyl(green, 0, y0 + 28, 0, 1.4, 1.2, 1.4, 10);                 // 首
    for (let k = 0; k < 7; k++) {                                     // 冠の 7 本の光線
        const a = -Math.PI / 2 + (k - 3) * 0.32;
        const o = K.cyl(green, Math.sin(a) * 2.4, y0 + 32.2, -Math.cos(a) * 2.4 + 0.3, 0.35, 0.05, 3.4, 5);
        o.rotation.set(-Math.cos(a) * 0.9, 0, -Math.sin(a) * 0.9);
    }
    const arm = K.cyl(green, 2.6, y0 + 27, 0, 0.9, 0.8, 12, 10);     // 右腕（まっすぐ上へ、少し外へ）
    arm.rotation.z = -0.18;
    K.cyl(green, 3.7, y0 + 38.5, 0, 0.7, 1.4, 3, 12);                // たいまつの握り・受け皿
    K.sphere(flame, 3.7, y0 + 43, 0, 1.4, 1, 1.8, 1);                // 炎（金色。夜は灯る）
    const tab = K.box(green, -3.8, y0 + 17, 1.2, 1.0, 7, 4.2);      // 銘板（左腕に抱える）
    tab.rotation.x = 0.25;
    return g;
}
const _LM_BUILD = { royal_liver: _lmRoyalLiver, palazzo: _lmPalazzo, pol: _lmPortOfLiverpool, titanic_belfast: _lmTitanicBelfast, liberty: _lmLiberty };

// ── 置く・捨てる ──
const lmState = { built: new Map(), t: -1e9, refKey: '' };
function updateLandmarks(t) {
    const on = !!(window.world && world.mode === 'world' && typeof worldLatLonToUnit === 'function');
    if (!on) { if (lmState.built.size) { for (const [, o] of lmState.built) scene.remove(o); lmState.built.clear(); } return; }
    // 夜は時計の文字盤・たいまつを灯す
    const nf = (typeof lightingNightFactor === 'number') ? lightingNightFactor : 0;
    for (const m of _lmGlow) m.emissiveIntensity = (m.userData.glowBase || 1) * nf;
    const refKey = world.ref ? world.ref.lat + ',' + world.ref.lon : '';
    if (t - lmState.t < 1 && refKey === lmState.refKey && t >= lmState.t) return;
    lmState.t = t;
    const moved = refKey !== lmState.refKey; lmState.refKey = refKey;
    const ll = worldShipLatLon();
    for (const L of LANDMARKS) {
        const d = worldDistance(ll.lat, ll.lon, L.lat, L.lon);
        let o = lmState.built.get(L.id);
        if (d > LANDMARK_RANGE + 2000) { if (o) { scene.remove(o); lmState.built.delete(L.id); } continue; }
        if (d > LANDMARK_RANGE) continue;
        if (!o) {
            const mk = _LM_BUILD[L.kind]; if (!mk) continue;
            o = mk(L); o.name = 'Landmark:' + L.name;
            o.traverse(c => { if (c.isMesh) c.userData.noLightBake = true; });
            o.userData.placed = false;
            scene.add(o); lmState.built.set(L.id, o);
        }
        if (!o.userData.placed || moved || !o.userData.grounded) {
            const loc = worldUnitToLocal(worldLatLonToUnit(L.lat, L.lon));
            // 地面の高さ：港のまわりの細かい地形ができていれば、その高さ（まだなら後でもう一度）
            let gh = typeof worldSeabedAt === 'function' ? worldSeabedAt(loc.x, loc.z) : 0;
            // 岬の上の灯台など：緯度・経度が地形の陸から少しずれて海になっていたら、近くの陸（400m 以内）に寄せる
            if (L.snapLand && gh < 1.5 && typeof worldSeabedAt === 'function' && terrain && (terrain.fine || terrain.near)) {
                search: for (let r = 20; r <= 400; r += 20) for (let k = 0; k < 16; k++) {
                    const a = k / 16 * Math.PI * 2, x = loc.x + Math.sin(a) * r, z = loc.z + Math.cos(a) * r, h = worldSeabedAt(x, z);
                    if (h > 2) { loc.x = x; loc.z = z; gh = h; break search; }
                }
            }
            o.position.set(loc.x, Math.max(0, gh), loc.z);
            const br = L.bearing * Math.PI / 180;
            o.rotation.y = Math.atan2(-Math.sin(br), Math.cos(br));     // 物理の面：東は −x。+z を bearing の向きへ
            o.userData.placed = true;
            o.userData.grounded = !!(terrain && (terrain.fine || terrain.near));
        }
    }
}
window.updateLandmarks = updateLandmarks;
