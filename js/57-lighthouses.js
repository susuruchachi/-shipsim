// 57-lighthouses.js — 実在の灯台（ニードルズ、エディストン、ビショップ・ロック、ファストネット、クロッホ…）
//
// 53-landmarks.js の名所の仕組みで置く（船から 25km 以内のものを作る）。
//   ・塔の形・色（白・赤白・黒白の帯・御影石）と高さ、岩の上（海の中）か岬の上（陸）か
//   ・灯りの光り方（灯質）：Fl(n) 閃光（n 回ずつ）、Oc 明暗、Iso 等明暗。周期[秒]
//     閃光の灯台は、光の帯（ビーム）が回り、こちらを向いた瞬間に光る（本物の回転灯と同じ）
//   ・夜だけ灯る。遠くからも分かるよう、灯りのにじみ（スプライト）を付ける
//   位置は灯台の所在地の緯度・経度。陸の灯台は、地形の陸からずれていたら近くの陸に寄せる（snapLand）
const LIGHTHOUSES = [
    // ── イングランド南岸・ソレント（サウサンプトンの近く）──
    { id: 'lh_needles', name: 'ニードルズ灯台', lat: 50.66232, lon: -1.59166, h: 31, style: 'redband', rock: true, ch: 'Oc(2) 20' },
    { id: 'lh_hurst', name: 'ハースト・ポイント灯台', lat: 50.70664, lon: -1.55185, h: 26, style: 'white', ch: 'Fl(4) 15' },
    { id: 'lh_stcath', name: 'セント・キャサリンズ・ポイント灯台', lat: 50.57583, lon: -1.29778, h: 27, style: 'white', oct: true, ch: 'Fl 5' },
    { id: 'lh_nab', name: 'ナブ・タワー', lat: 50.66798, lon: -0.95204, h: 28, style: 'nab', rock: true, ch: 'Fl 10' },
    { id: 'lh_anvil', name: 'アンヴィル・ポイント灯台', lat: 50.59205, lon: -1.95998, h: 12, style: 'white', ch: 'Fl 10' },
    { id: 'lh_portland', name: 'ポートランド・ビル灯台', lat: 50.51367, lon: -2.45672, h: 41, style: 'redband', ch: 'Fl(4) 20' },
    { id: 'lh_beachy', name: 'ビーチー・ヘッド灯台', lat: 50.73375, lon: 0.24136, h: 43, style: 'redband', rock: true, ch: 'Fl(2) 20' },
    { id: 'lh_dungeness', name: 'ダンジネス灯台', lat: 50.91332, lon: 0.97627, h: 43, style: 'blackband', ch: 'Fl 10' },
    // ── 南西（コーンウォール・シリー諸島）──
    { id: 'lh_eddystone', name: 'エディストン灯台', lat: 50.18038, lon: -4.26464, h: 49, style: 'granite', rock: true, ch: 'Fl(2) 10' },
    { id: 'lh_lizard', name: 'リザード灯台', lat: 49.95950, lon: -5.20180, h: 19, style: 'white', oct: true, ch: 'Fl 3' },
    { id: 'lh_wolf', name: 'ウルフ・ロック灯台', lat: 49.94594, lon: -5.80838, h: 41, style: 'granite', rock: true, ch: 'Fl 15' },
    { id: 'lh_longships', name: 'ロングシップス灯台', lat: 50.06695, lon: -5.74656, h: 35, style: 'granite', rock: true, ch: 'Iso 10' },
    { id: 'lh_bishop', name: 'ビショップ・ロック灯台', lat: 49.87250, lon: -6.44530, h: 49, style: 'granite', rock: true, ch: 'Fl(2) 15' },
    // ── ウェールズ・アイリッシュ海（リヴァプールの近く）──
    { id: 'lh_smalls', name: 'スモールズ灯台', lat: 51.72083, lon: -5.66972, h: 41, style: 'redband', rock: true, ch: 'Fl(3) 15' },
    { id: 'lh_southstack', name: 'サウス・スタック灯台', lat: 53.30763, lon: -4.69790, h: 28, style: 'white', ch: 'Fl 10' },
    { id: 'lh_perchrock', name: 'ニュー・ブライトン灯台（パーチ・ロック）', lat: 53.44438, lon: -3.04186, h: 28, style: 'granite', rock: true, ch: 'Fl 5' },
    // ── 北アイルランド（ベルファストの近く）──
    { id: 'lh_mew', name: 'ミュー島灯台', lat: 54.69697, lon: -5.51534, h: 37, style: 'blackband', ch: 'Fl(4) 30' },
    { id: 'lh_blackhead', name: 'ブラックヘッド灯台', lat: 54.76611, lon: -5.68920, h: 16, style: 'white', oct: true, ch: 'Fl 3' },
    { id: 'lh_donaghadee', name: 'ドナガディー灯台', lat: 54.64570, lon: -5.53035, h: 17, style: 'white', ch: 'Iso 4' },
    // ── クライド湾（グラスゴーの近く）──
    { id: 'lh_cloch', name: 'クロッホ灯台', lat: 55.94200, lon: -4.87850, h: 23, style: 'white', ch: 'Fl 3' },
    { id: 'lh_toward', name: 'トワード・ポイント灯台', lat: 55.86160, lon: -4.97890, h: 19, style: 'white', ch: 'Fl 10' },
    { id: 'lh_cumbrae', name: 'リトル・カンブレー灯台', lat: 55.72060, lon: -4.96680, h: 28, style: 'white', ch: 'Fl 6' },
    { id: 'lh_pladda', name: 'プラッダ灯台', lat: 55.42530, lon: -5.11970, h: 29, style: 'white', ch: 'Fl(3) 30' },
    { id: 'lh_turnberry', name: 'ターンベリー灯台', lat: 55.32930, lon: -4.83610, h: 24, style: 'white', ch: 'Fl 15' },
    { id: 'lh_kintyre', name: 'マル・オブ・キンタイア灯台', lat: 55.31100, lon: -5.80230, h: 12, style: 'white', ch: 'Fl(2) 20' },
    { id: 'lh_corsewall', name: 'コースウォール灯台', lat: 55.00860, lon: -5.15950, h: 34, style: 'white', ch: 'Fl(5) 30' },
    // ── 北海側 ──
    { id: 'lh_flamborough', name: 'フラムボロー・ヘッド灯台', lat: 54.11622, lon: -0.08263, h: 27, style: 'white', oct: true, ch: 'Fl(4) 15' },
    { id: 'lh_longstone', name: 'ロングストーン灯台', lat: 55.64400, lon: -1.61055, h: 26, style: 'redband', rock: true, ch: 'Fl 20' },
    { id: 'lh_bellrock', name: 'ベル・ロック灯台', lat: 56.43389, lon: -2.38722, h: 35, style: 'granite', rock: true, ch: 'Fl 5' },
    // ── アイルランド ──
    { id: 'lh_fastnet', name: 'ファストネット灯台', lat: 51.38930, lon: -9.60330, h: 54, style: 'granite', rock: true, ch: 'Fl 5' },
    { id: 'lh_hook', name: 'フック・ヘッド灯台', lat: 52.12390, lon: -6.92960, h: 35, style: 'blackband2', ch: 'Fl 3' },
    { id: 'lh_baily', name: 'ベイリー灯台', lat: 53.36178, lon: -6.05275, h: 13, style: 'white', ch: 'Fl 15' },
    { id: 'lh_poolbeg', name: 'プールベグ灯台', lat: 53.34222, lon: -6.15139, h: 20, style: 'red', rock: true, ch: 'Oc(2) 20' },
    // ── フランス（コタンタン半島）──
    { id: 'lh_lahague', name: 'ラ・アーグ灯台（ゴーリー）', lat: 49.71900, lon: -1.95630, h: 48, style: 'granite', rock: true, ch: 'Fl 5' },
    { id: 'lh_gatteville', name: 'ガットヴィル灯台', lat: 49.69690, lon: -1.26600, h: 75, style: 'granite', ch: 'Fl(2) 10' },
];
for (const L of LIGHTHOUSES) { L.kind = 'lighthouse'; L.bearing = 0; if (!L.rock) L.snapLand = true; LANDMARKS.push(L); }
window.LIGHTHOUSES = LIGHTHOUSES;

// 灯質 'Fl(2) 20' → { type: 'Fl', n: 2, period: 20 }
function _lhParse(ch) {
    const m = /^(Fl|Oc|Iso|Q)(?:\((\d+)\))?\s*([\d.]+)?/.exec(ch || 'Fl 10') || [];
    return { type: m[1] || 'Fl', n: +(m[2] || 1), period: +(m[3] || 10) };
}
// 明暗・等明暗の灯り：t[秒] で灯っているか（0〜1）
function _lhSteady(C, t) {
    const ph = ((t % C.period) + C.period) % C.period;
    if (C.type === 'Iso') return ph < C.period / 2 ? 1 : 0;
    // Oc(n)：周期の始めに n 回、1 秒ずつ消える（間は 1 秒）
    for (let k = 0; k < C.n; k++) if (ph >= k * 2 && ph < k * 2 + 1) return 0;
    return 1;
}

const _lhLamps = [];       // { lamp, sprite, beams, C, L, beamYaw }
let _lhGlowTex = null;
function _lhTex() {
    if (_lhGlowTex) return _lhGlowTex;
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const x = c.getContext('2d'), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,240,1)'); g.addColorStop(0.2, 'rgba(255,245,210,0.7)'); g.addColorStop(1, 'rgba(255,240,200,0)');
    x.fillStyle = g; x.fillRect(0, 0, 64, 64);
    _lhGlowTex = new THREE.CanvasTexture(c);
    return _lhGlowTex;
}
function _lmLighthouse(L) {
    const g = new THREE.Group(), K = _lmKit(g);
    const H = L.h || 30, r0 = Math.max(2.2, H * 0.1), r1 = r0 * 0.68;
    const white = _lmMat('lh_white', 0xf2f0ea, { roughness: 0.6 }), red = _lmMat('lh_red', 0xb5262a, { roughness: 0.6 });
    const black = _lmMat('lh_black', 0x1d1d20, { roughness: 0.6 }), granite = _lmMat('lh_granite', 0x8c8a84, { roughness: 0.9 });
    const rock = _lmMat('lh_rock', 0x4a4844, { roughness: 1 }), dark = _lmMat('lh_dark', 0x222428, { roughness: 0.5, metalness: 0.4 });
    const glass = _lmMat('lh_glass', 0x9fb4bf, { roughness: 0.15, metalness: 0.3 });
    const seg = L.oct ? 8 : 20;
    // 岩の上の灯台：海から立ち上がる土台
    let y0 = 0;
    if (L.rock) {
        K.cyl(rock, 0, -12, 0, r0 * 2.2, r0 * 1.7, 13, 9);
        y0 = 1;
        if (L.style === 'granite') { K.cyl(granite, 0, y0, 0, r0 * 1.5, r0 * 1.35, 4, 24); y0 += 4; }
    } else {
        // 灯台守の家（白い平屋）
        K.box(white, r0 * 2.6, 0, 0, r0 * 2.6, 4, r0 * 1.8);
        K.box(dark, r0 * 2.6, 4, 0, r0 * 2.8, 0.6, r0 * 2);
    }
    const tower = H - (y0) - 4;
    // 塔の色の帯
    const bands = { white: [[0, 1, white]], red: [[0, 1, red]], granite: [[0, 1, granite]],
        redband: [[0, 0.4, white], [0.4, 0.7, red], [0.7, 1, white]], blackband: [[0, 0.45, black], [0.45, 0.65, white], [0.65, 1, black]],
        blackband2: [[0, 0.2, white], [0.2, 0.4, black], [0.4, 0.6, white], [0.6, 0.8, black], [0.8, 1, white]], nab: [[0, 1, _lmMat('lh_conc', 0xa9a59c, { roughness: 0.95 })]] }[L.style] || [[0, 1, white]];
    for (const [a, b, m] of bands) {
        const ra = r0 + (r1 - r0) * a, rb = r0 + (r1 - r0) * b;
        K.cyl(m, 0, y0 + tower * a, 0, ra, rb, tower * (b - a) + 0.02, seg);
    }
    const yt = y0 + tower;
    // 回廊（手すり）と灯室
    K.cyl(dark, 0, yt, 0, r1 * 1.35, r1 * 1.35, 0.4, 20);
    K.cyl(dark, 0, yt + 0.4, 0, r1 * 1.33, r1 * 1.33, 1.1, 20).material = dark;
    const lr = r1 * 0.85;
    K.cyl(glass, 0, yt + 0.4, 0, lr, lr, 2.6, 16);
    const capM = (L.style === 'granite' || L.style === 'redband' || L.style === 'red') ? red : black;
    K.dome(capM, 0, yt + 3.0, 0, lr * 1.05, 0.8);
    K.cyl(dark, 0, yt + 3.0 + lr * 0.8, 0, 0.25, 0.1, 1.2, 8);
    // 灯り（灯器）
    const lampMat = new THREE.MeshBasicMaterial({ color: 0xfff6d8, toneMapped: false });
    const lamp = K.sphere(lampMat, 0, yt + 1.7, 0, Math.max(0.5, lr * 0.45));
    lamp.castShadow = false;
    // 遠くからのにじみ
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: _lhTex(), color: 0xfff2d0, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, sizeAttenuation: false, toneMapped: false }));
    sp.position.set(0, yt + 1.7, 0); sp.scale.setScalar(0.0); sp.renderOrder = 6;
    g.add(sp);
    // 回る光の帯（閃光の灯台）。霧・もやの中でよく見える
    const C = _lhParse(L.ch);
    const beams = [];
    if (C.type === 'Fl' || C.type === 'Q') {
        const bg = new THREE.ConeGeometry(30, 420, 16, 1, true); bg.translate(0, -210, 0); bg.rotateX(-Math.PI / 2);   // 先が +z へ広がる
        const bm = new THREE.MeshBasicMaterial({ color: 0xfff4d6, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false });
        const piv = new THREE.Group(); piv.position.set(0, yt + 1.7, 0); g.add(piv);
        // 閃光 n 回 → n 本の帯を少しずつずらして並べる（回って n 回続けて光る）
        for (let k = 0; k < C.n; k++) { const b = new THREE.Mesh(bg, bm); b.rotation.y = -k * 0.35; b.userData.noBloom = true; piv.add(b); beams.push(b); }
        beams.pivot = piv; beams.mat = bm;
    }
    g.userData.lh = { lamp, lampMat, sp, beams, C, L, top: yt + 1.7 };
    _lhLamps.push(g.userData.lh);
    return g;
}
_LM_BUILD.lighthouse = _lmLighthouse;

// 毎フレーム（17-main-loop.js）：灯す・光の帯を回す・にじみの大きさ
const _lhV = new THREE.Vector3(), _lhC = new THREE.Vector3();
function updateLighthouses(t) {
    if (!_lhLamps.length) return;
    const nf = (typeof lightingNightFactor === 'number') ? lightingNightFactor : 0;
    const w = window.weather, haze = (w && w.enabled) ? Math.max(0, (w.fog || 0) + (w.rain || 0) * 0.5) : 0;
    const real = (typeof performance !== 'undefined') ? performance.now() / 1000 : t;   // 灯質は実時間で
    for (let i = _lhLamps.length - 1; i >= 0; i--) {
        const H = _lhLamps[i], g = H.lamp.parent;
        if (!g || !g.parent) { _lhLamps.splice(i, 1); continue; }     // 捨てた灯台
        const C = H.C;
        let on = 0;
        if (H.beams.length) {
            // 帯は周期で 1 回転。こちら（カメラ）を向いた帯の分だけ光る
            const yaw = (real / C.period) * Math.PI * 2;
            H.beams.pivot.rotation.y = yaw;
            g.getWorldPosition(_lhV); _lhV.y += H.top;
            _lhC.copy(camera.position).sub(_lhV);
            const ca = Math.atan2(_lhC.x, _lhC.z) - g.rotation.y;
            for (const b of H.beams) {
                const a = yaw + b.rotation.y, d = Math.atan2(Math.sin(ca - a), Math.cos(ca - a));
                on = Math.max(on, Math.exp(-(d * d) / (2 * 0.06 * 0.06)));
            }
            on = Math.max(on, 0.25);                               // 灯器そのものはいつも見える（横からでも灯っているのが分かる）
            H.beams.mat.opacity = nf * (0.08 + 0.15 * Math.min(1, haze));
        } else on = _lhSteady(C, real);
        const k = nf * on;
        H.lampMat.color.setScalar(0.15 + 3 * k);
        H.lamp.visible = true;
        const dist = camera.position.distanceTo(_lhV.copy(H.lamp.position).applyMatrix4(g.matrixWorld));
        H.sp.scale.setScalar(k > 0.01 ? (0.02 + 0.05 * k) * Math.min(1, 1800 / Math.max(300, dist) + 0.4) : 0);
        H.sp.material.opacity = Math.min(1, k * 1.2);
        H.sp.visible = k > 0.01;
    }
}
window.updateLighthouses = updateLighthouses;
