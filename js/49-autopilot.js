// ════════════════════════════════════════════════════════════════
//  自動航行（メルカトル航法）
// ════════════════════════════════════════════════════════════════
//  世界地図で港を選んで「🧭 ここへ自動航行」を押すと、
//    1. 航路を探す（ワーカーで。陸と浅瀬をよけ、深い海を好む）
//       ・出発点と目的地のまわり（半径 25km）は細かい格子（約200m。浅瀬・岩も見る）
//       ・その間の大洋は粗い格子
//       ・見通せる所はまっすぐにつないで、変針点（ウェイポイント）を少なくする
//    2. 変針点と変針点の間は航程線（メルカトル図で直線 ＝ 針路一定）で走る。
//       針路は漸長緯度（メルカトル緯度）の差と経度の差から求める：
//         Δψ = ln(tan(π/4 + φ2/2) / tan(π/4 + φ1/2))、 針路 C = atan2(Δλ, Δψ)
//         距離 = Δφ / cos C（東西にほぼ真横のときは Δλ·cos φ）
//       短い区間（30km 未満。港の航路など）は、線からのずれ（横ずれ）も直して線の上を走る。
//    3. 目的の港の航路の沖で減速し、航路を微速で進んで、港の入口の手前で機関停止。
//  舵輪・テレグラフは自動で動く。手で舵輪を回す（A/D キー）と自動航行は切れる。
//  遠くまで行くと物理の面の原点から離れて地図がゆがむので、150km ごとに原点を船の所へ移す
//  （worldRebase。船の真の針路はそのまま）。

const AP_FINE_R = 25000;          // 細かく探す範囲[m]
const AP_FINE_CELL = 200;         // 細かい格子[m]
const AP_REBASE_DIST = 150000;    // 原点を移す距離[m]
const AP_SPEEDS = { full: 3, half: 2, slow: 1 };
const autopilot = { active: false, planning: false, route: null, leg: 0, dest: null, cruise: 'full', msg: '', lastOrder: null, phase: '', berth: true };
try { autopilot.berth = localStorage.getItem('susuru_ap_berth') !== '0'; } catch (e) { /* ignore */ }
function autopilotSetBerth(on) { autopilot.berth = !!on; try { localStorage.setItem('susuru_ap_berth', on ? '1' : '0'); } catch (e) { /* ignore */ } renderAutopilotPanel(); }
window.autopilotSetBerth = autopilotSetBerth;
window.autopilot = autopilot;
// タグを使うか（出港・狭い水路）：auto（船が 100m 以上なら使う）・on・off。この端末に覚える
autopilot.tugOpt = { depart: 'auto', narrow: 'auto' };
try { Object.assign(autopilot.tugOpt, JSON.parse(localStorage.getItem('susuru_ap_tugs') || '{}')); } catch (e) { /* ignore */ }
function apShipLen() { const hp = window.hullProfile; return ((hp && hp.ready) ? hp.halfLen * 2 : 12) * (physics.scale || 1); }
function apUseTugs(kind) { const v = autopilot.tugOpt[kind]; return v === 'on' ? true : v === 'off' ? false : apShipLen() >= 100; }
function autopilotSetTugOpt(kind, v) {
    autopilot.tugOpt[kind] = v;
    try { localStorage.setItem('susuru_ap_tugs', JSON.stringify(autopilot.tugOpt)); } catch (e) { /* ignore */ }
    renderAutopilotPanel(); if (typeof renderTugPanel === 'function') renderTugPanel();
}
window.apUseTugs = apUseTugs; window.autopilotSetTugOpt = autopilotSetTugOpt;
// タグの選択の HTML（自動航行・タグのパネルで共用）
function apTugOptHTML() {
    const row = (kind, label) => `<div class="ap-row ap-tugopt">${label}：${[['auto', `自動（${apUseTugs(kind) ? '使う' : '使わない'}）`], ['on', '使う'], ['off', '使わない']].map(([k, l]) => `<button class="${autopilot.tugOpt[kind] === k ? 'on' : ''}" onclick="autopilotSetTugOpt('${kind}', '${k}')">${k === 'auto' ? (autopilot.tugOpt[kind] === 'auto' ? l : '自動') : l}</button>`).join('')}</div>`;
    return row('depart', '出港のタグ') + row('narrow', '狭い水路のタグ');
}
window.apTugOptHTML = apTugOptHTML;

// ── 航程線（メルカトル航法）──
const _apRad = Math.PI / 180;
function _apMercY(latDeg) { const f = Math.max(-89.5, Math.min(89.5, latDeg)) * _apRad; return Math.log(Math.tan(Math.PI / 4 + f / 2)); }
function _apDLon(a, b) { return ((b - a + 540) % 360) - 180; }
// 針路[度, 真方位]と距離[m]
function rhumbCourse(lat1, lon1, lat2, lon2) {
    const dPsi = _apMercY(lat2) - _apMercY(lat1);
    const dLon = _apDLon(lon1, lon2) * _apRad;
    const dLat = (lat2 - lat1) * _apRad;
    const C = Math.atan2(dLon, dPsi);
    const q = Math.abs(dPsi) > 1e-10 ? dLat / dPsi : Math.cos(lat1 * _apRad);
    const dist = Math.hypot(dLat, q * dLon) * WORLD_R;
    return { course: (C / _apRad + 360) % 360, dist };
}
window.rhumbCourse = rhumbCourse;

// ── 真方位 ⇄ 物理の向き（その場所での北の向きを物理の面で測る）──
function _apNorthHeading() {
    const ll = worldShipLatLon();
    const sx = physics.cgWorldX || 0, sz = physics.cgWorldZ || 0;
    const n = worldUnitToLocal(worldLatLonToUnit(Math.min(89.9, ll.lat + 0.01), ll.lon));
    return Math.atan2(n.x - sx, n.z - sz) / _apRad;     // 物理の向き（上から見て左回り）で北はどちらか
}
// 船の真方位（羅針盤）
function worldTrueCompass() {
    if (!window.world || world.mode !== 'world') return worldCompass(physics.heading);
    return ((_apNorthHeading() - (physics.heading || 0)) % 360 + 360) % 360;
}
window.worldTrueCompass = worldTrueCompass;
// 舵 25° ほどでの旋回半径[m]（17-main-loop.js：回る速さ ＝ 速さ×0.514 ÷ R × 舵/35、進む速さはそのまま m/s）
// 作り込んだ港（川・入江の奥の港）の中の区間は、実際の港と同じようにタグが付き添う
function _apInDetail(q) { return !!(q && world.kind === 'real' && typeof _rwDetailOf === 'function' && _rwDetailOf(q.lat, q.lon)); }
function _apTurnRadius() { return 12 * (physics.scale || 1) * (physics.turningRadiusFactor || 5) / 0.514 * 1.4; }
function _apHeadingForTrue(course) { return _apNorthHeading() - course; }

// ── 港の航路の上の点（港の点から海の方へ a[m]）──
function portChannelPoint(p, a) {
    const F = _worldFrame(p.lat, p.lon), br = p.seaBearing * _apRad;
    const e = Math.sin(br) * a / WORLD_R, n = Math.cos(br) * a / WORLD_R;
    const x = F.C.x + e * F.E.x + n * F.N.x, y = F.C.y + e * F.E.y + n * F.N.y, z = F.C.z + e * F.E.z + n * F.N.z, l = Math.hypot(x, y, z);
    return worldUnitToLatLon({ x: x / l, y: y / l, z: z / l });
}

// ── 航路探しのワーカー ──
let _apWorkerObj = null;
function _apWorker() {
    if (_apWorkerObj) return _apWorkerObj;
    const src = `
        const _wPerm = new Uint8Array(${JSON.stringify(Array.from(_wPerm))});
        const _wPermMod12 = new Uint8Array(${JSON.stringify(Array.from(_wPermMod12))});
        const _wGrad3 = new Float32Array(${JSON.stringify(Array.from(_wGrad3))});
        const world = { seaLevel: ${world.seaLevel} };
        ${worldWorkerSource()}
        ${_wNoise3.toString()}
        ${worldNoiseE.toString()}
        ${worldHeightFromE.toString()}
        ${worldShoal.toString()}
        ${worldHeightAt.toString()}
        ${worldShoalFree.toString()}
        // 升目の中（半径 rM[m]）で、浅瀬の岩がいちばん高くなりうる高さ（見落とさないよう控えめに）
        function heightConservative(ux, uy, uz, rM) {
            if (_RW) return worldHeightAt(ux, uy, uz, 16);       // 現実世界：地形そのもの
            const h = worldHeightFromE(worldNoiseE(ux, uy, uz, 16));
            if (h >= 0 || h < -135) return h;
            const field = _wNoise3(ux * 140 + 11.3, uy * 140 - 4.1, uz * 140 + 7.7);
            if (field < 0.16) return h;
            const w = Math.min(1, Math.max(0, (field + 0.02 - 0.18) / 0.2)) * Math.min(1, (h + 130) / 60);
            const n1 = _wNoise3(ux * 1900 - 3.3, uy * 1900 + 8.8, uz * 1900 + 1.2);
            const n2 = _wNoise3(ux * 7000 + 5.5, uy * 7000 - 2.2, uz * 7000 + 9.1);
            const g1 = 1.8 * 1900 / WORLD_R * rM, g2 = 1.8 * 7000 / WORLD_R * rM;
            const ridge = 1 - Math.max(0, Math.abs(n1) - g1);
            const top = -42 + 40 * ridge * ridge * ridge + 5 * Math.min(1, n2 + g2);
            return top <= h ? h : h + (top - h) * w;
        }
        const RAD = Math.PI / 180;
        function unit(lat, lon) { const a = lat * RAD, b = lon * RAD; return [Math.cos(a) * Math.cos(b), Math.sin(a), Math.cos(a) * Math.sin(b)]; }
        function mercY(lat) { const f = Math.max(-89.5, Math.min(89.5, lat)) * RAD; return Math.log(Math.tan(Math.PI / 4 + f / 2)); }
        function latOfY(y) { return (2 * Math.atan(Math.exp(y)) - Math.PI / 2) / RAD; }
        // 格子：緯度・経度の四角（lon は連続させた値）。cost 0 は通れない
        function makeGrid(lat0, lat1, lon0, lon1, cellDeg, fine, draft, conservative) {
            const nx = Math.max(2, Math.ceil((lon1 - lon0) / cellDeg)), ny = Math.max(2, Math.ceil((lat1 - lat0) / cellDeg));
            const cost = new Float32Array(nx * ny);
            for (let j = 0; j < ny; j++) {
                const lat = lat0 + (j + 0.5) * cellDeg;
                for (let i = 0; i < nx; i++) {
                    const u = unit(lat, lon0 + (i + 0.5) * cellDeg);
                    let c;
                    if (fine) {
                        // conservative：升目の中に隠れた岩の尾根まで見込む（まっすぐでは通らなかった所を探し直すとき）
                        const d = depthAt(lat, lon0 + (i + 0.5) * cellDeg, u, conservative ? cellDeg * RAD * WORLD_R * 0.75 : 0);
                        c = d < NEED ? 0 : d < NEED + 10 ? 4 : d < 60 ? 1.6 : 1;
                        // 浅瀬の多い海域（岩の尾根が網の目のように続き、深い船には抜け道がないことが多い）は、なるべく避ける
                        if (c && !_RW && d < 135 && _wNoise3(u[0] * 140 + 11.3, u[1] * 140 - 4.1, u[2] * 140 + 7.7) > 0.16 && !(CH.length && dredged(lat, lon0 + (i + 0.5) * cellDeg) > 0)) c *= 8;
                    } else {
                        const h = worldHeightFromE(worldNoiseE(u[0], u[1], u[2], 10));
                        // 大陸棚の「浅瀬の多い海域」は大洋の道すじでは通らない（まわり道する）
                        const shoaly = !_RW && h > -160 && _wNoise3(u[0] * 140 + 11.3, u[1] * 140 - 4.1, u[2] * 140 + 7.7) > 0.18;
                        // 船の喫水より浅い広い浅海（大陸棚の平ら）は、大洋の道すじでも通れない（少しゆるめに）
                        c = h > -Math.max(8, NEED - 1) ? 0 : shoaly ? 60 : h > -60 ? 8 : h > -200 ? 3 : 1;
                    }
                    cost[j * nx + i] = c;
                }
            }
            const G = { lat0, lon0, cellDeg, nx, ny, cost };
            if (fine) inflate(G, Math.max(1, Math.ceil(BAND / (cellDeg * RAD * WORLD_R))));
            return G;
        }
        // 通れない升目を、船の幅（と横ずれ）の分だけ太らせる
        function inflate(G, r) {
            const src = G.cost.slice();
            for (let j = 0; j < G.ny; j++) for (let i = 0; i < G.nx; i++) {
                if (src[j * G.nx + i]) continue;
                for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
                    const a = i + di, b = j + dj;
                    if (a >= 0 && b >= 0 && a < G.nx && b < G.ny && di * di + dj * dj <= r * r) G.cost[b * G.nx + a] = 0;
                }
            }
        }
        // ── 港の航路・泊地（掘ってある所）の深さ（44-world-terrain.js の _portAdjust と同じ形）──
        function dredged(lat, lon) {
            let best = 0;
            for (const P of CH) {
                const dE = (((lon - P.lon) + 540) % 360 - 180) * RAD * WORLD_R * Math.cos(P.lat * RAD), dN = (lat - P.lat) * RAD * WORLD_R;
                const a = dE * P.sx + dN * P.sz, b = dE * P.sz - dN * P.sx;
                const half = P.quay / 2;
                const inBasin = a > 0 && a < P.basin && Math.abs(b) < half + P.basin * 0.5 - 80;
                const ch = Math.max(90, half * 0.5) + Math.max(0, a - P.basin) * 0.06;
                const inCh = a >= P.basin - 120 && a < P.basin + P.chLen - 400 && Math.abs(b) < ch;
                if (inBasin || inCh) best = Math.max(best, P.depth + 2);
            }
            return best;
        }
        function depthAt(lat, lon, u, rM) {
            const d = rM ? -heightConservative(u[0], u[1], u[2], rM) : -worldHeightAt(u[0], u[1], u[2], 16);
            return CH.length ? Math.max(d, dredged(lat, lon)) : d;
        }
        // ── 航路の点検：区間を 80m おきに、船の幅の帯（中心と左右）で、浅瀬・岩まで細かく見る ──
        function legBad(A, B) {
            const ya = mercY(A.lat), yb = mercY(B.lat), dl = B.lon - A.lon;
            const len = Math.hypot(dl * Math.cos((A.lat + B.lat) / 2 * RAD), B.lat - A.lat) * RAD * WORLD_R;
            const n = Math.max(2, Math.ceil(len / 25));          // 岩の尾根は幅 50m ほどなので 25m おきに
            const C = Math.atan2(dl * RAD, yb - ya);                  // 航程線の針路
            const pe = Math.cos(C), pn = -Math.sin(C);                  // 右舷方向（東・北の成分）
            for (let k = 0; k <= n; k++) {
                const t = k / n, lat = latOfY(ya + (yb - ya) * t), lon = A.lon + dl * t;
                const u0 = unit(lat, lon);
                if (worldHeightFromE(worldNoiseE(u0[0], u0[1], u0[2], 10)) < -700) continue;   // 深い大洋は速く飛ばす
                for (const o of [0, -BAND, BAND, -BAND * 0.5, BAND * 0.5]) {
                    const la = lat + pn * o / WORLD_R / RAD, lo = lon + pe * o / WORLD_R / RAD / Math.max(0.05, Math.cos(lat * RAD));
                    const u = unit(la, lo);
                    if (depthAt(la, lo, u) < NEED) return { t, lat, lon };
                }
            }
            return null;
        }
        // 危ない区間を、その区間のまわりの細かい格子で探し直す
        function repairLeg(A, B, depth, padM) {
            const pad = (padM || 6000) / WORLD_R / RAD;
            const lat0 = Math.min(A.lat, B.lat) - pad, lat1 = Math.max(A.lat, B.lat) + pad;
            const cl = Math.max(0.05, Math.cos((A.lat + B.lat) / 2 * RAD));
            const lon0 = Math.min(A.lon, B.lon) - pad / cl, lon1 = Math.max(A.lon, B.lon) + pad / cl;
            const area = (lat1 - lat0) * (lon1 - lon0) * cl;
            const cell = Math.max(MIN_CELL[depth] / WORLD_R / RAD, Math.sqrt(area / 250000));
            const G = makeGrid(lat0, lat1, lon0, lon1, cell, true, 0, depth > 0);
            const s = nearestOpen(G, ...cellOf(G, A.lat, A.lon), 6), e = nearestOpen(G, ...cellOf(G, B.lat, B.lon), 6);
            if (!s || !e) return null;
            const path = astar(G, s[0], s[1], (i, j) => i === e[0] && j === e[1], (i, j) => Math.hypot((i - e[0]) * cl, j - e[1]));
            if (!path) return null;
            return { G, pts: [A, ...path.map(([i, j]) => llOf(G, i, j)), B] };
        }
        // 点検に通らない区間は、細かい格子で探し直す（通るまで升目を 150→90→55→35m と細かく）。
        // 最後まで通らなければ航路を出さない（座礁するかもしれない航路は決して使わない）
        const MIN_CELL = [150, 90, 55, 35];
        // 最後の手：岩の尾根が網の目のように並ぶ所では、まっすぐにしようとすると尾根に掛かり続けるので、
        // 細かい格子の道すじを（まっすぐにせず）そのまま使う。一歩ずつ点検して、全部通れば使う
        function fallbackLeg(A, B) {
            for (const padM of [2500, 8000, 20000]) {
                const pad = padM / WORLD_R / RAD;
                const lat0 = Math.min(A.lat, B.lat) - pad, lat1 = Math.max(A.lat, B.lat) + pad;
                const cl = Math.max(0.05, Math.cos((A.lat + B.lat) / 2 * RAD));
                const lon0 = Math.min(A.lon, B.lon) - pad / cl, lon1 = Math.max(A.lon, B.lon) + pad / cl;
                const area = (lat1 - lat0) * (lon1 - lon0) * cl;
                const cell = Math.max(30 / WORLD_R / RAD, Math.sqrt(area / 700000));
                const G = makeGrid(lat0, lat1, lon0, lon1, cell, true, 0, true);
                const s = nearestOpen(G, ...cellOf(G, A.lat, A.lon), 6), e = nearestOpen(G, ...cellOf(G, B.lat, B.lon), 6);
                if (!s || !e) continue;
                const path = astar(G, s[0], s[1], (i, j) => i === e[0] && j === e[1], (i, j) => Math.hypot((i - e[0]) * cl, j - e[1]));
                if (!path) continue;
                const pts = [A, ...path.map(([i, j]) => llOf(G, i, j)), B];
                let ok = true;
                for (let k = 0; k < pts.length - 1 && ok; k++) if (legBad(pts[k], pts[k + 1])) ok = false;
                if (ok) return pts.slice(1);
            }
            return null;
        }
        function fixLeg(A, B, depth) {
            if (!legBad(A, B)) return [B];
            if (depth >= MIN_CELL.length) {
                const fb = fallbackLeg(A, B); if (fb) return fb;
                const bad = legBad(A, B); throw new Error('shallow leg at ' + (bad ? bad.lat.toFixed(4) + ',' + bad.lon.toFixed(4) : '?'));
            }
            let r = repairLeg(A, B, depth, 6000);
            if (!r) r = repairLeg(A, B, depth, 20000);            // 近くに道が無ければ、広く探す
            if (!r) r = repairLeg(A, B, depth, 45000);
            if (!r) {
                const fb = fallbackLeg(A, B); if (fb) return fb;
                const bad = legBad(A, B); throw new Error('shallow leg (no way) at ' + (bad ? bad.lat.toFixed(4) + ',' + bad.lon.toFixed(4) : '?') + ' leg ' + [A.lat, A.lon, B.lat, B.lon].map(v => v.toFixed(4)).join(',') + ' d' + depth);
            }
            const simp = simplify(r.G, r.pts).map((p, k, arr) => (k === 0 || k === arr.length - 1) ? p : snap(p));
            const out = [];
            let cur = A;
            for (const nx of simp.slice(1)) { for (const q of fixLeg(cur, nx, depth + 1)) out.push(q); cur = nx; }
            return out;
        }
        // 変針点そのものが浅瀬・岩の上だと、そこへ向かう区間はどう直しても通らないので、近くの深い所へずらす
        //（大洋の粗い格子は細い尾根を見ないので、点が尾根の上に乗ることがある）
        function pointOk(lat, lon) {
            const cl = Math.max(0.05, Math.cos(lat * RAD));
            for (let k = -1; k < 8; k++) {
                const a = k * Math.PI / 4, r = k < 0 ? 0 : BAND;
                const la = lat + Math.cos(a) * r / WORLD_R / RAD, lo = lon + Math.sin(a) * r / WORLD_R / RAD / cl;
                if (depthAt(la, lo, unit(la, lo)) < NEED) return false;
            }
            return true;
        }
        function snap(p) {
            if (pointOk(p.lat, p.lon)) return p;
            const cl = Math.max(0.05, Math.cos(p.lat * RAD));
            for (let r = 40; r <= 3000; r += 40) {
                const n = Math.max(8, Math.round(2 * Math.PI * r / 60));
                for (let k = 0; k < n; k++) {
                    const a = k / n * Math.PI * 2;
                    const la = p.lat + Math.cos(a) * r / WORLD_R / RAD, lo = p.lon + Math.sin(a) * r / WORLD_R / RAD / cl;
                    if (pointOk(la, lo)) return { lat: la, lon: lo };
                }
            }
            return p;
        }
        function validate(pts) {
            pts = pts.map((p, k) => (k === 0 || k === pts.length - 1) ? p : snap(p));
            const out = [pts[0]];
            for (let k = 0; k < pts.length - 1; k++) {
                for (const q of fixLeg(out[out.length - 1], pts[k + 1], 0)) out.push(q);
            }
            return tighten(out);
        }
        // 点検に通る範囲で、変針点をできるだけ減らす（遠くへ倍々に伸ばしてから二分探索）
        function tighten(pts) {
            if (pts.length <= 2) return pts;
            const out = [pts[0]];
            let i = 0;
            while (i < pts.length - 1) {
                let good = i + 1, step = 1;
                while (good + step < pts.length && !legBad(pts[i], pts[good + step])) { good += step; step *= 2; }
                let lo = good + 1, hi = Math.min(pts.length - 1, good + step - 1);
                while (lo <= hi) { const m = (lo + hi) >> 1; if (!legBad(pts[i], pts[m])) { good = m; lo = m + 1; } else hi = m - 1; }
                out.push(pts[good]); i = good;
            }
            return out;
        }
        function cellOf(G, lat, lon) {
            let i = Math.floor((lon - G.lon0) / G.cellDeg);
            if (G.wrap) i = ((i % G.nx) + G.nx) % G.nx;              // 世界一周の格子は東西がつながる
            return [i, Math.floor((lat - G.lat0) / G.cellDeg)];
        }
        function llOf(G, i, j) { return { lat: G.lat0 + (j + 0.5) * G.cellDeg, lon: G.lon0 + (i + 0.5) * G.cellDeg }; }
        // 通れる所へ寄せる（始点・終点が陸の格子に落ちたとき）
        function nearestOpen(G, i, j, rmax) {
            if (i >= 0 && j >= 0 && i < G.nx && j < G.ny && G.cost[j * G.nx + i] > 0) return [i, j];
            for (let r = 1; r <= rmax; r++) for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
                if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
                const a = i + di, b = j + dj;
                if (a >= 0 && b >= 0 && a < G.nx && b < G.ny && G.cost[b * G.nx + a] > 0) return [a, b];
            }
            return null;
        }
        // A*。goalFn(i,j) が true の所に着いたら終わり。h(i,j)：残りの見込み
        function astar(G, si, sj, goalFn, hFn) {
            const N = G.nx * G.ny, g = new Float32Array(N).fill(Infinity), from = new Int32Array(N).fill(-1), closed = new Uint8Array(N);
            const heap = [], push = (k, f) => { heap.push([f, k]); let c = heap.length - 1; while (c > 0) { const p = (c - 1) >> 1; if (heap[p][0] <= heap[c][0]) break; [heap[p], heap[c]] = [heap[c], heap[p]]; c = p; } };
            const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let c = 0; for (;;) { const l = 2 * c + 1, r = l + 1; let m = c; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === c) break; [heap[m], heap[c]] = [heap[c], heap[m]]; c = m; } } return top; };
            const s = sj * G.nx + si; g[s] = 0; push(s, hFn(si, sj));
            const nb = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
            let n = 0;
            while (heap.length) {
                const [, k] = pop();
                if (closed[k]) continue; closed[k] = 1;
                const i = k % G.nx, j = (k - i) / G.nx;
                if (goalFn(i, j)) { const path = []; for (let q = k; q >= 0; q = from[q]) path.push([q % G.nx, Math.floor(q / G.nx)]); return path.reverse(); }
                if (++n > 3000000) break;
                const cl = Math.cos((G.lat0 + (j + 0.5) * G.cellDeg) * RAD);
                for (const [di, dj] of nb) {
                    let a = i + di; const b = j + dj;
                    if (G.wrap) a = (a + G.nx) % G.nx;
                    if (a < 0 || b < 0 || a >= G.nx || b >= G.ny) continue;
                    const kk = b * G.nx + a, c = G.cost[kk];
                    if (!c || closed[kk]) continue;
                    const step = Math.hypot(di * cl, dj) * (c + G.cost[k]) / 2;
                    const ng = g[k] + step;
                    if (ng < g[kk]) { g[kk] = ng; from[kk] = k; push(kk, ng + hFn(a, b)); }
                }
            }
            return null;
        }
        // 見通し（航程線 ＝ メルカトル図の直線 の上を細かく見る）
        function clear(G, A, B) {
            const ya = mercY(A.lat), yb = mercY(B.lat);
            const len = Math.hypot((B.lon - A.lon) * Math.cos((A.lat + B.lat) / 2 * RAD), B.lat - A.lat);
            const n = Math.max(2, Math.ceil(len / (G.cellDeg * 0.5)));
            for (let k = 1; k < n; k++) {
                const t = k / n, lat = latOfY(ya + (yb - ya) * t), lon = A.lon + (B.lon - A.lon) * t;
                const [i, j] = cellOf(G, lat, lon);
                if (i < 0 || j < 0 || i >= G.nx || j >= G.ny) return false;
                if (!G.cost[j * G.nx + i]) return false;
            }
            return true;
        }
        function simplify(G, pts) {
            if (pts.length <= 2) return pts;
            const out = [pts[0]];
            let i = 0;
            while (i < pts.length - 1) {
                let j = i + 1;
                // 見通せる一番遠い点まで（二分探索で速く）
                let lo = i + 1, hi = pts.length - 1;
                while (lo <= hi) { const m = (lo + hi) >> 1; if (clear(G, pts[i], pts[m])) { j = m; lo = m + 1; } else hi = m - 1; }
                out.push(pts[j]); i = j;
            }
            return out;
        }
        function fineGrid(c, draft, radiusM) {
            const R = radiusM || ${AP_FINE_R};
            const dLat = R / WORLD_R / RAD, dLon = dLat / Math.max(0.2, Math.cos(c.lat * RAD));
            const cell = Math.max(${AP_FINE_CELL}, R / 125) / WORLD_R / RAD;
            return makeGrid(c.lat - dLat, c.lat + dLat, c.lon - dLon, c.lon + dLon, cell, true, draft);
        }
        let NEED = 10, BAND = 100, CH = [];
        onmessage = (ev) => {
            if (_rwHook(ev)) return;
            const q = ev.data;
            NEED = q.need || (q.draft + 5); BAND = q.band || 100; CH = q.ports || [];
            // タグの補助がある航路（狭い所も通る）：どの区間がふつうの余裕では狭いかも返す
            const narrowOf = (pts) => {
                if (!q.tug) return null;
                const n0 = NEED, b0 = BAND;
                NEED = q.needN; BAND = q.bandN;
                const flags = [];
                for (let k = 0; k < pts.length - 1; k++) flags.push(legBad(pts[k], pts[k + 1]) ? 1 : 0);
                NEED = n0; BAND = b0;
                return flags;
            };
            const A = q.from, B = { lat: q.to.lat, lon: A.lon + ((q.to.lon - A.lon + 540) % 360) - 180 };
            const toDeg = (m) => m / WORLD_R / RAD;
            const gcDist = Math.hypot((B.lon - A.lon) * Math.cos((A.lat + B.lat) / 2 * RAD), B.lat - A.lat);
            try {
                // 近いとき：細かい格子ひとつで
                if (gcDist < toDeg(${AP_FINE_R}) * 1.6) {
                    const c = { lat: (A.lat + B.lat) / 2, lon: (A.lon + B.lon) / 2 };
                    const G = fineGrid(c, q.draft);
                    const s = nearestOpen(G, ...cellOf(G, A.lat, A.lon), 8), e = nearestOpen(G, ...cellOf(G, B.lat, B.lon), 8);
                    if (!s || !e) throw new Error('start/goal blocked');
                    const cl = Math.cos(c.lat * RAD);
                    const path = astar(G, s[0], s[1], (i, j) => i === e[0] && j === e[1], (i, j) => Math.hypot((i - e[0]) * cl, j - e[1]));
                    if (!path) throw new Error('no path');
                    const pts = validate(simplify(G, [A, ...path.map(([i, j]) => llOf(G, i, j)), B]));
                    postMessage({ id: q.id, ok: true, pts, narrow: narrowOf(pts) });
                    return;
                }
                // 出発点のまわり：細かい格子で、縁のうち目的地に一番近づける所まで
                const escape = (P, T, radiusM) => {
                    const G = fineGrid(P, q.draft, radiusM);
                    const s = nearestOpen(G, ...cellOf(G, P.lat, P.lon), 8);
                    if (!s) throw new Error('blocked');
                    const [ti, tj] = cellOf(G, T.lat, T.lon);
                    const cl = Math.cos(P.lat * RAD);
                    const path = astar(G, s[0], s[1], (i, j) => i === 0 || j === 0 || i === G.nx - 1 || j === G.ny - 1, (i, j) => Math.hypot((i - ti) * cl, j - tj) * 0.999);
                    if (!path) throw new Error('trapped');
                    return { G, pts: simplify(G, [P, ...path.map(([i, j]) => llOf(G, i, j))]) };
                };
                let S, E;
                // 浅瀬に囲まれていたら、もっと広く探す
                try { S = escape(A, B); } catch (e) { try { S = escape(A, B, 45000); } catch (e2) { throw new Error('trapped start'); } }
                try { E = escape(B, A); } catch (e) { try { E = escape(B, A, 45000); } catch (e2) { throw new Error('trapped goal'); } }
                const a = S.pts[S.pts.length - 1], b = E.pts[E.pts.length - 1];
                // 大洋：粗い格子。見つからなければ広げて探し直す（最後は世界一周）
                let mid = null, lastErr = 'no ocean path';
                for (const margin of [8, 25, 'world']) {
                    let lat0, lat1, lon0, lon1, wrap = false;
                    if (margin === 'world') { lat0 = -80; lat1 = 80; lon0 = a.lon - 180; lon1 = a.lon + 180; wrap = true; }
                    else {
                        lat0 = Math.max(-80, Math.min(a.lat, b.lat) - margin); lat1 = Math.min(80, Math.max(a.lat, b.lat) + margin);
                        lon0 = Math.min(a.lon, b.lon) - margin; lon1 = Math.max(a.lon, b.lon) + margin;
                        if (lon1 - lon0 >= 340) continue;
                    }
                    const cell = Math.max(0.04, Math.sqrt((lat1 - lat0) * (lon1 - lon0) / 220000));
                    const G = makeGrid(lat0, lat1, lon0, lon1, wrap ? 360 / Math.round(360 / cell) : cell, false, q.draft);
                    G.wrap = wrap;
                    const s = nearestOpen(G, ...cellOf(G, a.lat, a.lon), 4), e = nearestOpen(G, ...cellOf(G, b.lat, b.lon), 4);
                    if (!s || !e) { lastErr = 'ocean blocked'; continue; }
                    const clm = Math.cos((a.lat + b.lat) / 2 * RAD);
                    const hf = wrap ? (i, j) => { let di = Math.abs(i - e[0]); di = Math.min(di, G.nx - di); return Math.hypot(di * clm * 0.5, j - e[1]); }
                                    : (i, j) => Math.hypot((i - e[0]) * clm, j - e[1]);
                    const path = astar(G, s[0], s[1], (i, j) => i === e[0] && j === e[1], hf);
                    if (!path) continue;
                    // 世界一周の格子では、経度を連続させる（±180 をまたいでも線がつながるように）
                    const pts = [a];
                    let prevLon = a.lon;
                    for (const [i, j] of path) {
                        const c = llOf(G, i, j);
                        c.lon = prevLon + (((c.lon - prevLon) + 540) % 360) - 180;
                        prevLon = c.lon; pts.push(c);
                    }
                    const bb = { lat: b.lat, lon: prevLon + (((b.lon - prevLon) + 540) % 360) - 180 };
                    pts.push(bb);
                    mid = simplify(G, pts);
                    break;
                }
                if (!mid) throw new Error(lastErr);
                const pts = validate([...S.pts, ...mid.slice(1, -1), ...E.pts.slice().reverse()]);
                postMessage({ id: q.id, ok: true, pts, narrow: narrowOf(pts) });
            } catch (err) {
                postMessage({ id: q.id, ok: false, err: String(err && err.message || err) });
            }
        };`;
    _apWorkerObj = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    worldWorkerSync(_apWorkerObj);
    return _apWorkerObj;
}
let _apReq = 0;
// opt.tug：タグの補助を前提に、狭い水路も通す（余裕を小さく）。返す点に narrow（その点までの区間が狭い）を付ける
function worldPlanRoute(from, to, opt) {
    opt = opt || {};
    const id = ++_apReq;
    const draft = (typeof worldShipDraft === 'function') ? worldShipDraft() : 8;
    return new Promise((resolve, reject) => {
        const w = _apWorker();
        const on = (ev) => {
            if (ev.data.id !== id) return;
            w.removeEventListener('message', on);
            if (ev.data.ok) resolve(ev.data.pts.map((p, i) => ({ lat: p.lat, lon: ((p.lon + 540) % 360) - 180, narrow: !!(ev.data.narrow && i > 0 && ev.data.narrow[i - 1]) })));
            else reject(new Error(ev.data.err));
        };
        w.addEventListener('message', on);
        // 必要な水深：喫水＋余裕（3m）＋波で上下する分。船の幅＋横ずれの分の帯の中で調べる
        const hs = Math.max(0, window._seaHs || 0);
        const need = draft + 2 + Math.max(0.5, hs * 0.4);
        const hwM = (typeof worldHullAt === 'function' && window.hullProfile && hullProfile.ready) ? (() => { let m = 0; for (let k = -10; k <= 10; k++) { const z = k / 10 * hullProfile.halfLen; m = Math.max(m, worldHullAt(z).hw, (typeof worldHullExtentAt === 'function' ? worldHullExtentAt(z) : 0) * (physics.scale || 1)); } return m; })() : 15;
        // 出発点・目的地のそばの港の、掘ってある航路・泊地
        const ports = [];
        for (const P of worldBuildPorts()) {
            if (worldDistance(P.lat, P.lon, from.lat, from.lon) > 25000 && worldDistance(P.lat, P.lon, to.lat, to.lon) > 25000) continue;
            const T = PORT_TYPES[P.type], br = P.seaBearing * _apRad;
            ports.push({ lat: P.lat, lon: P.lon, sx: Math.sin(br), sz: Math.cos(br), basin: T.basin, quay: T.quay, depth: T.depth, chLen: worldPortChannelLen(P) });
        }
        const m = apMargins();
        if (opt.tug) w.postMessage({ id, from, to, draft, need: m.needTug, band: hwM + m.bandTug, needN: m.need, bandN: hwM + m.band, tug: true, ports });
        else w.postMessage({ id, from, to, draft, need: m.need, band: hwM + m.band, ports });
    });
}
window.worldPlanRoute = worldPlanRoute;
// 必要な水深と、調べる帯の幅（船の半幅に足す分）。タグの補助があれば狭くてよい
function apMargins() {
    const draft = (typeof worldShipDraft === 'function') ? worldShipDraft() : 8;
    const hs = Math.max(0, window._seaHs || 0);
    return {
        need: draft + 2 + Math.max(0.5, hs * 0.4), band: 35,
        needTug: draft + 1 + Math.max(0.3, hs * 0.3), bandTug: 10,
    };
}
window.apMargins = apMargins;
// 点検用：その点の深さ（港の航路・泊地は掘った深さ）
function apDepthAt(lat, lon) {
    const u = worldLatLonToUnit(lat, lon);
    let d = -worldHeightAt(u.x, u.y, u.z, 16);
    for (const P of worldBuildPorts()) {
        if (Math.abs(P.lat - lat) > 0.3) continue;
        const T = PORT_TYPES[P.type], br = P.seaBearing * _apRad, sx = Math.sin(br), sz = Math.cos(br);
        const dE = _apDLon(P.lon, lon) * _apRad * WORLD_R * Math.cos(P.lat * _apRad), dN = (lat - P.lat) * _apRad * WORLD_R;
        const a = dE * sx + dN * sz, b = dE * sz - dN * sx, half = T.quay / 2, chLen = worldPortChannelLen(P);
        const ch = Math.max(90, half * 0.5) + Math.max(0, a - T.basin) * 0.06;
        if ((a > 0 && a < T.basin && Math.abs(b) < half + T.basin * 0.5 - 80) || (a >= T.basin - 120 && a < T.basin + chLen - 400 && Math.abs(b) < ch)) d = Math.max(d, T.depth + 2);
    }
    return d;
}
window.apDepthAt = apDepthAt;

// 地図で指定した海域の、止まる所：その点が浅い・陸・浅瀬の海域なら、まわり（AP_SEA_SNAP 以内）の
// いちばん近い「深さが足りて、浅瀬の出ない所」。無ければ null
const AP_SEA_SNAP = 5000;
function apSeaTarget(lat, lon, need) {
    const hp = window.hullProfile, L = ((hp && hp.ready) ? hp.halfLen * 2 : 12) * (physics.scale || 1);
    const ok = (la, lo) => {
        // 船が止まって向きが変わっても大丈夫なよう、船の長さほどの円の中も見る
        for (let k = -1; k < 8; k++) {
            const a = k * Math.PI / 4, r = k < 0 ? 0 : L * 0.6 + 30;
            const qa = la + Math.cos(a) * r / WORLD_R / _apRad, qo = lo + Math.sin(a) * r / WORLD_R / _apRad / Math.max(0.05, Math.cos(la * _apRad));
            const u = worldLatLonToUnit(qa, qo);
            if (apDepthAt(qa, qo) < need + 1 || !worldShoalFree(u.x, u.y, u.z)) return false;
        }
        return true;
    };
    if (ok(lat, lon)) return { lat, lon, moved: 0 };
    const cl = Math.max(0.05, Math.cos(lat * _apRad));
    for (let r = 100; r <= AP_SEA_SNAP; r += 100) {
        const n = Math.max(8, Math.round(2 * Math.PI * r / 150));
        for (let k = 0; k < n; k++) {
            const a = k / n * Math.PI * 2;
            const la = lat + Math.cos(a) * r / WORLD_R / _apRad, lo = lon + Math.sin(a) * r / WORLD_R / _apRad / cl;
            if (ok(la, lo)) return { lat: la, lon: lo, moved: r };
        }
    }
    return null;
}
window.apSeaTarget = apSeaTarget;
// 地図で指定した海域へ（行き先は港のような形のもの：point が付いている）
function autopilotStartPoint(lat, lon) {
    if (window._wm) { _wm.selPt = null; if (typeof _wmShowInfo === 'function') _wmShowInfo(); }
    return autopilotStart({ point: true, lat, lon, name: `指定海域（${worldFmtLatLon(lat, lon)}）` });
}
window.autopilotStartPoint = autopilotStartPoint;

// ── 航路の点の間を、深さを確かめながら見る（直線で結んでも浅い所にかからないか） ──
// 中心と左右（船の半幅＋余裕）を 30m おきに。need：必要な水深
function _apLineSafe(A, B, need, hw) {
    const rc = rhumbCourse(A.lat, A.lon, B.lat, B.lon), n = Math.max(1, Math.ceil(rc.dist / 30));
    const c = rc.course * _apRad, mLat = WORLD_R * _apRad, mLon = mLat * Math.cos(A.lat * _apRad);
    const ox = Math.cos(c) * (hw + 6), oy = -Math.sin(c) * (hw + 6);          // 横（東・北）
    for (let k = 1; k < n; k++) {
        const u = k / n, la = A.lat + (B.lat - A.lat) * u, lo = A.lon + (B.lon - A.lon) * u;
        for (const sgn of [0, -1, 1]) {
            if (apDepthAt(la + sgn * oy / mLat, lo + sgn * ox / mLon) < need) return false;
        }
    }
    return true;
}
function _apShipHalfBeam() {
    const hp = window.hullProfile;
    if (!hp || !hp.ready) return 15;
    let m = 0; for (const q of hp.slices || []) m = Math.max(m, q.halfWidth || 0);
    return (m || hp.halfBeam || 1) * (physics.scale || 1);
}
// 航路の小さなずれ（短い寄り道）をなくす：前後の点を直線で結んでも深さが足りるなら、間の点を省く。
// 急に曲がって狭い水路で座礁するのを防ぐ（港の中の道すじは 40m の升目から作るので、小さなジグザグが残る）
function _apSmoothRoute(route) {
    if (!route || route.length < 3) return route;
    const M = apMargins(), hw = _apShipHalfBeam();
    let changed = true, guard = 0;
    while (changed && guard++ < 6) {
        changed = false;
        for (let i = 1; i < route.length - 1; i++) {
            const A = route[i - 1], P = route[i], B = route[i + 1];
            if (P.final || A.final) continue;
            const ab = rhumbCourse(A.lat, A.lon, B.lat, B.lon), ap = rhumbCourse(A.lat, A.lon, P.lat, P.lon), pb = rhumbCourse(P.lat, P.lon, B.lat, B.lon);
            const off = Math.abs(Math.sin((ap.course - ab.course) * _apRad)) * ap.dist;   // 線からのずれ[m]
            // 線からのずれが小さければ、曲がりが大きくても省く（航路の継ぎ目の、行き過ぎて折り返す短いずれ）。
            // 前後の線の外へはみ出す点（行き過ぎ）も、はみ出しが短ければ同じ
            const u = Math.cos((ap.course - ab.course) * _apRad) * ap.dist, over = Math.max(0, -u, u - ab.dist);
            if (off > Math.max(80, ab.dist * 0.06) || over > 400) continue;
            const need = (P.narrow || B.narrow) ? M.needTug : M.need;
            // 港の航路の点（水路の真ん中を通るように引いてある）を省くときは、省いた分だけ線が浅い方へ寄ることがあるので、
            // ずれの分（40m 以上）だけ広く見て、それでも深さが足りるときだけ
            if (!_apLineSafe(A, B, need, hw + (P.channel ? Math.max(40, off) : 0))) continue;
            B.narrow = !!(B.narrow || P.narrow); B.channel = !!(B.channel || P.channel);
            if (P.label && !B.label) B.label = P.label;
            route.splice(i, 1); i--; changed = true;
        }
    }
    return route;
}
// 今いる所から最初の点へまっすぐ行くと浅い所（岸壁の角など）にかかるときは、作り込んだ港の中の深い所を通る道すじを前に足す
function _apFixFirstLeg(route) {
    if (!route || !route.length || typeof _rwDetailOf !== 'function' || typeof _rwDetailRoute !== 'function') return route;
    const here = worldShipLatLon(), M = apMargins();
    if (_apLineSafe(here, route[0], M.needTug, _apShipHalfBeam())) return route;
    const D = _rwDetailOf(here.lat, here.lon);
    if (!D) return route;
    const r = _rwDetailRoute(D, here, { lat: route[0].lat, lon: route[0].lon });
    if (!r || !r.pts || !r.pts.length) return route;
    return [...r.pts.map(p => ({ lat: p.lat, lon: p.lon, narrow: true, channel: true })), ...route];
}
// 座礁から抜け出したあと：航路を最初から引き直さず、今の航路のいちばん近い所の少し先へ、まっすぐ戻れるなら
// そこから続ける（港への進入路の途中なら、その続きから）。戻れなければ false（引き直す）
function _apResumeRoute() {
    const R = autopilot.route;
    if (!R || R.length < 1 || !autopilot.dest) return false;
    const here = worldShipLatLon(), mLat = WORLD_R * _apRad, mLon = mLat * Math.cos(here.lat * _apRad);
    const pts = [autopilot.legFrom || here, ...R];
    let best = null;
    for (let k = Math.max(0, (autopilot.leg || 0) - 1); k < pts.length - 1; k++) {
        const A = pts[k], B = pts[k + 1];
        const ax = (A.lon - here.lon) * mLon, ay = (A.lat - here.lat) * mLat, bx = (B.lon - here.lon) * mLon, by = (B.lat - here.lat) * mLat;
        const L2 = (bx - ax) ** 2 + (by - ay) ** 2 || 1, u = Math.max(0, Math.min(1, -(ax * (bx - ax) + ay * (by - ay)) / L2));
        const d = Math.hypot(ax + u * (bx - ax), ay + u * (by - ay));
        if (!best || d < best.d) best = { d, k, u, L: Math.sqrt(L2) };
    }
    if (!best || best.d > 1500) return false;
    // 近い所から、ずれの分＋150m 先の点へ（真横へ戻ると、線に乗ったところで急に曲がることになる）
    let k = best.k, u = best.u, ahead = best.d + 150;
    while (k < pts.length - 1) {
        const A = pts[k], B = pts[k + 1], L = rhumbCourse(A.lat, A.lon, B.lat, B.lon).dist || 1;
        const left = (1 - u) * L;
        if (ahead <= left || k === pts.length - 2) { u = Math.min(1, u + ahead / L); break; }
        ahead -= left; k++; u = 0;
    }
    const A = pts[k], B = pts[k + 1];
    const P = { lat: A.lat + (B.lat - A.lat) * u, lon: A.lon + (B.lon - A.lon) * u };
    const M = apMargins();
    if (!_apLineSafe(here, P, M.needTug, _apShipHalfBeam())) return false;
    const rest = pts.slice(k + 1).map(q => Object.assign({}, q));
    const atEnd = u >= 0.999;
    const route = atEnd ? rest : [{ lat: P.lat, lon: P.lon, label: '航路へ戻る所', narrow: !!B.narrow, channel: !!B.channel }, ...rest];
    autopilot.route = route; autopilot.leg = 0; autopilot.active = true; autopilot.planning = false;
    autopilot.legFrom = here; autopilot.lastOrder = null; autopilot.overshoot = false;
    return true;
}
window._apResumeRoute = _apResumeRoute;

// ── 始める・やめる ──
function _apMsg(s) { autopilot.msg = s; renderAutopilotPanel(); }
async function autopilotStart(port) {
    if (!port || world.mode !== 'world') return;
    // 岸壁に付いているなら：テレグラフが STAND BY（機関用意）になるのを待ってから出港する
    // （タグを使うならタグで離岸してから（50-harbor-auto.js。離岸が終わるとここへ戻る）、使わないなら綱を放して自分で出る）
    if (typeof harborBerthedAt === 'function' && !(harborAuto && harborAuto.mode) && harborBerthedAt()) {
        const sb = physics.telegraphAnswerSpecial === 'standby' || physics.telegraphSpecial === 'standby';
        if (!sb && !autopilot._departGo) {
            autopilot.pendingDepart = port;
            _apMsg(`${port.name} への出港の用意：テレグラフを STAND BY（機関用意）にすると出港します`);
            return;
        }
        autopilot.pendingDepart = null;
        if (apUseTugs('depart')) {
            if (harborAutoDepartNow(port)) { _apMsg(`タグで離岸してから ${port.name} へ向かいます`); return; }
        } else {
            // タグなし：綱を放し、サイドスラスター（船首・船尾の横向きのスクリュー）で岸壁から横へ離れてから出る
            const plan = harborBerthedAt();
            if (typeof _haClearLines === 'function') _haClearLines();
            harborAuto.pendingLines = null;
            if (plan) {
                const h = (physics.heading || 0) * _apRad, side = plan.open || 1;
                const D = (typeof _haDims === 'function') ? _haDims() : { B: 20 };
                // 泊地の真ん中（タグで離岸するときに回す所）まで横へ出て、港口の向きへ回ってから航路を引く
                const T = plan.turn || null;
                const need = T ? Math.max(32, Math.hypot(T.x - physics.cgWorldX, T.z - physics.cgWorldZ)) : Math.max(32, D.B * 0.6 + 14);
                const ux = T ? (T.x - physics.cgWorldX) / need : Math.cos(h) * side, uz = T ? (T.z - physics.cgWorldZ) / need : -Math.sin(h) * side;
                if (!apHasThrusters()) {
                    // サイドスラスターもアジポッドも無い船：横へは動けないので、舵と機関で出る。
                    // 港口の向きが前寄りなら、船首を沖へ振り出して（スプリングで船尾を岸壁に当てて）前進で、
                    // 後ろ寄りなら、船尾を沖へ振り出して後進で船の長さほど下がってから、舵で回って出る
                    const back = Number.isFinite(plan.hOut) && Math.abs(((plan.hOut - physics.heading + 540) % 360) - 180) > 100;
                    const bowOut = side * (back ? -1 : 1);                 // ＋：heading を増やす（左舷へ回る）
                    autopilot.selfDepart = { port, rudder: true, back, h1: physics.heading + bowOut * 12, out: side, moved: 0, need: back ? Math.max(60, apShipLen()) : 0, v: 0, hOut: plan.hOut };
                    _apMsg(`もやい綱を放し、舵と機関で岸壁から離れています（${back ? '後進で下がってから' : '船首を沖へ振ってから前進で'}、${port.name} へ）`);
                    return;
                }
                autopilot.selfDepart = { port, moved: 0, need, dx: ux, dz: uz, v: 0, hOut: plan.hOut };
                _apMsg(`もやい綱を放し、サイドスラスターで岸壁から離れています（${port.name} へ）`);
                return;
            }
        }
    }
    autopilot.pendingDepart = null;
    autopilotStop('', true);
    autopilot.resume = null;
    autopilot.planning = true; autopilot.dest = port;
    _apMsg(`${port.name} への航路を計算しています…`);
    const isPt = !!port.point;                     // 地図で指定した海域
    const T = isPt ? null : PORT_TYPES[port.type];
    const hp = window.hullProfile;
    const halfLen = ((hp && hp.ready) ? hp.halfLen : 6) * (physics.scale || 1);
    const here = worldShipLatLon();
    const M = apMargins();
    const draft = worldShipDraft();
    const chLen = isPt ? 0 : worldPortChannelLen(port);
    // ふつうの余裕で通れないときは、タグの補助で狭い所も通る（サウサンプトンのように）
    let lastErr = null;
    autopilot._newRoute = null;
    // 同じ作り込んだ港の中の、別の埠頭へ：港の中の深い所だけを通って、行き先の航路の最初の点（泊地・ドックの外）へ
    //（ふつうに計画すると、いったん航路を外海まで出てから戻ってくる）
    if (!isPt && port.real && port.fairway && port.fairway.pts.length >= 2 && typeof _rwDetailOf === 'function') {
        const Dh = _rwDetailOf(here.lat, here.lon);
        const fin = port.fairway.pts[1];
        const r = Dh && Dh === _rwDetailOf(port.lat, port.lon) ? _rwDetailRoute(Dh, here, { lat: fin.lat, lon: fin.lon }) : null;
        if (r && r.pts.length) {
            const route = [];
            for (const q of r.pts) route.push({ lat: q.lat, lon: q.lon, label: `${port.name} への港内の水路`, channel: true, narrow: true });
            let berthPlan = null, berthWhy = null;
            if (autopilot.berth && typeof harborBerthPlan === 'function') { const bp = harborBerthPlan(port); if (bp.ok) berthPlan = bp; else berthWhy = bp.why; }
            route.push({ lat: fin.lat, lon: fin.lon, label: berthPlan ? `${port.name} 泊地` : `${port.name} 港口`, channel: true, final: true, narrow: true });
            autopilot.berthPlan = berthPlan; autopilot.berthWhy = berthWhy; autopilot.deepShip = false;
            autopilot._newRoute = route;
        }
    }
    for (const mode of (autopilot._newRoute ? [] : ['normal', 'tug'])) {
        const need = mode === 'tug' ? M.needTug : M.need;
        const route = [];
        // 今いる港の航路の上なら、まず航路を沖へ出る（航路がふつうには浅くても、タグがあれば通る）
        const np = worldNearestPort(here.lat, here.lon);
        // 現実世界の港：掘った航路（港の fairway）に沿って外洋へ
        const fwOut = np && np.port !== port && np.port.real && np.port.fairway && np.port.fairway.depth >= M.needTug ? np.port.fairway : null;
        // 船を航路の線に落とし、いちばん近い区間の次の点から（後ろの点へ戻らない）
        let onFw = -1;
        if (fwOut) {
            let bd = 1500;
            const cl = Math.cos(here.lat * _apRad), m = WORLD_R * _apRad;
            const X = (q) => (q.lon - here.lon) * cl * m, Y = (q) => (q.lat - here.lat) * m;
            for (let k = 0; k < fwOut.pts.length - 1; k++) {
                const ax = X(fwOut.pts[k]), ay = Y(fwOut.pts[k]), bx = X(fwOut.pts[k + 1]), by = Y(fwOut.pts[k + 1]);
                const L2 = (bx - ax) ** 2 + (by - ay) ** 2 || 1, t = Math.max(0, Math.min(1, -(ax * (bx - ax) + ay * (by - ay)) / L2));
                const d = Math.hypot(ax + t * (bx - ax), ay + t * (by - ay));
                // 近い区間がいくつかあれば、いちばん先（沖側）の区間を（泊地の中では、港口向きの区間が後ろにも近い）
                if (d < 400 || d < bd) { if (d < 400 || onFw < 0 || d < bd) onFw = k; bd = Math.min(bd, d); }
            }
        }
        if (onFw >= 0) {
            for (let k = Math.max(1, onFw + 1); k < fwOut.pts.length; k++)
                route.push(Object.assign({ lat: fwOut.pts[k].lat, lon: fwOut.pts[k].lon }, { label: k === fwOut.pts.length - 1 ? `${np.port.name} 航路の出口` : `${np.port.name} 航路`, channel: true,
                    narrow: fwOut.depth < M.need || rhumbCourse(fwOut.pts[k].lat, fwOut.pts[k].lon, np.port.lat, np.port.lon).dist < 4000 || _apInDetail(fwOut.pts[k - 1]) }));
        } else if (np && np.port !== port && !np.port.real) {
            const P = np.port, TP = PORT_TYPES[P.type], chL = worldPortChannelLen(P);
            if (np.dist < TP.basin + chL + 1500 && TP.depth + 2 >= M.needTug) {
                const chNarrow = TP.depth + 2 < M.need;
                // 航路の中心線に乗ってから、線に沿って沖へ（航路は長いこともあり、斜めに出ると掘っていない所へはみ出す）
                const br = P.seaBearing * _apRad, sx = Math.sin(br), sz = Math.cos(br);
                const dE = _apDLon(P.lon, here.lon) * _apRad * WORLD_R * Math.cos(P.lat * _apRad), dN = (here.lat - P.lat) * _apRad * WORLD_R;
                const a0 = dE * sx + dN * sz, exitA = TP.basin + chL - 200;
                if (a0 < exitA - 300) {
                    const aOn = Math.max(TP.basin + 100, Math.min(exitA - 200, a0 + 250));
                    route.push(Object.assign(portChannelPoint(P, aOn), { label: `${P.name} 航路`, channel: true, narrow: chNarrow }));
                }
                route.push(Object.assign(portChannelPoint(P, exitA), { label: `${P.name} 航路の出口`, channel: true, narrow: chNarrow }));
            }
        }
        // 地図で指定した海域：そこ（浅ければ近くの深い所）まで行って止まる
        if (isPt) {
            const tgt = apSeaTarget(port.lat, port.lon, need);
            if (!tgt) { lastErr = new Error('point shallow'); continue; }
            const from = route.length ? route[route.length - 1] : here;
            if (mode === 'tug') _apMsg(`${port.name} へは狭い所があるので、タグの補助を前提に航路を探しています…`);
            try {
                const pts = await worldPlanRoute(from, tgt, { tug: mode === 'tug' });
                if (autopilot.dest !== port || !autopilot.planning) return;      // 途中でやめた
                for (const p of pts.slice(1)) route.push({ lat: p.lat, lon: p.lon, label: '', narrow: !!p.narrow });
                Object.assign(route[route.length - 1], { label: port.name, final: true });
                autopilot.berthPlan = null; autopilot.berthWhy = null; autopilot.deepShip = false;
                autopilot.pointMoved = tgt.moved;
                autopilot._newRoute = route;
                lastErr = null;
                break;
            } catch (e) {
                lastErr = e;
                if (/ocean/.test(e.message)) break;
                continue;
            }
        }
        // 現実世界の港：掘った航路の沖の端まで航路を探し、そこから航路をたどって泊地へ
        if (port.real && port.fairway) {
            const fw = port.fairway.pts, chDepth = port.fairway.depth;
            const channelNarrow = chDepth < M.need && chDepth >= M.needTug;
            const deepShip = chDepth < M.needTug;
            const end = fw[fw.length - 1];
            // 航路の延長線の沖（最後の区間の向きに、旋回半径の 2.5 倍ほど。深さが続く所まで）
            let far = null;
            if (fw.length >= 2) {
                const prevP = fw[fw.length - 2], c = rhumbCourse(prevP.lat, prevP.lon, end.lat, end.lon).course * _apRad;
                const want = Math.max(1500, Math.min(8000, _apTurnRadius() * 2.5));
                for (let d = 200; d <= want; d += 200) {
                    const la = end.lat + Math.cos(c) * d / WORLD_R / _apRad, lo = end.lon + Math.sin(c) * d / WORLD_R / _apRad / Math.cos(end.lat * _apRad);
                    const u = worldLatLonToUnit(la, lo);
                    if (apDepthAt(la, lo) < need + 2 || !worldShoalFree(u.x, u.y, u.z)) break;
                    far = { lat: la, lon: lo };
                }
            }
            let berthPlan = null, berthWhy = null, stopA = T.basin * 0.6;
            if (autopilot.berth && !deepShip && typeof harborBerthPlan === 'function') {
                const bp = harborBerthPlan(port);
                if (bp.ok) { berthPlan = bp; stopA = bp.aE; } else berthWhy = bp.why;
            }
            const from = route.length ? route[route.length - 1] : here;
            if (mode === 'tug') _apMsg(`${port.name} へは狭い所があるので、タグの補助を前提に航路を探しています…`);
            try {
                let pts = null, viaFar = !!far, err = null;
                for (const tgt of far ? [far, end] : [end]) {
                    try { pts = await worldPlanRoute(from, tgt, { tug: mode === 'tug' }); viaFar = tgt === far; break; }
                    catch (e) { err = e; if (/ocean/.test(e.message) || autopilot.dest !== port || !autopilot.planning) break; }
                }
                if (!pts) throw err;
                if (autopilot.dest !== port || !autopilot.planning) return;
                for (const q of pts.slice(1)) route.push({ lat: q.lat, lon: q.lon, label: '', narrow: !!q.narrow });
                if (viaFar) { route[route.length - 1].label = `${port.name} 航路の延長線`; route.push({ lat: end.lat, lon: end.lon, label: `${port.name} 航路の入口`, channel: true, narrow: channelNarrow }); }
                else Object.assign(route[route.length - 1], { label: deepShip ? `${port.name} 沖の錨地` : `${port.name} 航路の入口` });
                if (deepShip) Object.assign(route[route.length - 1], { final: true });
                else {
                    // 港の近く（4km 以内）は、実際の港と同じように、タグが付き添って微速で入る
                    const nearPort = (q) => rhumbCourse(q.lat, q.lon, port.lat, port.lon).dist < 4000 || _apInDetail(q);
                    // 航路の最後の点（泊地の中）で止まる。着岸はそこから（タグで横へ運んでから回す：50-harbor-auto.js）
                    //（港のまっすぐの軸の上の点へ行こうとすると、実際の航路の入り方によっては後ろ向きになる）
                    for (let k = fw.length - 2; k >= 2; k--) route.push({ lat: fw[k].lat, lon: fw[k].lon, label: `${port.name} 航路`, channel: true, narrow: channelNarrow || nearPort(fw[k]) });
                    const fin = fw.length >= 2 ? fw[1] : portChannelPoint(port, stopA);
                    route.push({ lat: fin.lat, lon: fin.lon, label: berthPlan ? `${port.name} 泊地` : `${port.name} 港口`, channel: true, final: true, narrow: true });
                }
                autopilot.berthPlan = berthPlan; autopilot.berthWhy = berthWhy; autopilot.deepShip = deepShip;
                autopilot._newRoute = route;
                lastErr = null;
                break;
            } catch (e) {
                lastErr = e;
                if (/ocean/.test(e.message)) break;
                continue;
            }
        }
        // 目的の港の航路の沖：航路の外で、この船に十分な深さがあり、浅瀬の出ない所
        // （航路の入口より沖。入口より内側だと、沖から来て入口を行き過ぎてから戻る航路になってしまう）
        let outerA = T.basin + chLen + 1500;
        for (let a = T.basin + chLen + 100; a < T.basin + chLen + 15000; a += 100) {
            const q = portChannelPoint(port, a), u = worldLatLonToUnit(q.lat, q.lon);
            if (-worldHeightAt(u.x, u.y, u.z, 16) >= need && worldShoalFree(u.x, u.y, u.z)) { outerA = a; break; }
        }
        const outer = portChannelPoint(port, outerA);
        // 大きな船は回るのに場所が要るので、航路の延長線の上、旋回半径の 2.5 倍ほど沖から線に乗って入る
        let farA = outerA;
        {
            const want = Math.max(1500, Math.min(8000, _apTurnRadius() * 2.5));
            for (let a = outerA + 100; a <= outerA + want; a += 100) {
                const q = portChannelPoint(port, a), u = worldLatLonToUnit(q.lat, q.lon);
                if (worldNoiseE(u.x, u.y, u.z, 16) >= 0 || -worldHeightAt(u.x, u.y, u.z, 16) < need || !worldShoalFree(u.x, u.y, u.z)) break;
                farA = a;
            }
        }
        const far = farA > outerA + 300 ? portChannelPoint(port, farA) : null;
        const gate = portChannelPoint(port, T.basin + chLen - 200);        // 航路の入口
        let stopA = Math.min(Math.max(T.basin * 0.5, T.basin * 0.76 + halfLen + 100), T.basin + chLen - 400);
        // 港の航路の深さ：ふつうに足りる／タグの補助なら足りる（狭い）／足りない（沖で止まる）
        const chDepth = T.depth + 2;
        const channelNarrow = chDepth < M.need && chDepth >= M.needTug;
        let deepShip = chDepth < M.needTug;
        if (deepShip) {
            const depthAt = (a) => { const q = portChannelPoint(port, a), u = worldLatLonToUnit(q.lat, q.lon); return -worldHeightAt(u.x, u.y, u.z, 16); };
            for (let a = T.basin * 0.76 + halfLen + 60; a < T.basin + chLen + 15000; a += 100) {
                stopA = a;
                if (depthAt(a - halfLen) > draft + 3 && depthAt(a) > draft + 3 && depthAt(a + halfLen) > draft + 3) break;
            }
        }
        // 着いたらタグで着岸する：泊地の、岸壁から船幅の3倍ほど沖（ここで回して横付けする）まで行く
        let berthPlan = null, berthWhy = null;
        if (autopilot.berth && !deepShip && typeof harborBerthPlan === 'function') {
            const bp = harborBerthPlan(port);
            if (bp.ok) { berthPlan = bp; stopA = bp.aE; } else berthWhy = bp.why;
        }
        const stop = portChannelPoint(port, stopA);
        const from = route.length ? route[route.length - 1] : here;
        if (mode === 'tug') _apMsg(`${port.name} へは狭い所があるので、タグの補助を前提に航路を探しています…`);
        try {
            // 行き先の候補：航路の延長線の沖 → 航路の入口のすぐ沖 → 航路の中（入口の少し内側。浅瀬の間で沖側に
            // 行ける所が無いとき）の順に試す
            const inA = T.basin + chLen - 450, inner = portChannelPoint(port, inA);     // 掘ってある所（出口の 400m 手前まで）の中
            const cands = [far ? 'far' : null, 'outer', 'inner'].filter(Boolean);
            let pts = null, target = null, err = null;
            for (const c of cands) {
                try { pts = await worldPlanRoute(from, c === 'far' ? far : c === 'outer' ? outer : inner, { tug: mode === 'tug' }); target = c; break; }
                catch (e) { err = e; if (/ocean/.test(e.message) || autopilot.dest !== port || !autopilot.planning) break; }
            }
            if (!pts) throw err;
            const viaFar = target === 'far';
            if (autopilot.dest !== port || !autopilot.planning) return;      // 途中でやめた
            for (const p of pts.slice(1)) route.push({ lat: p.lat, lon: p.lon, label: '', narrow: !!p.narrow });
            if (viaFar) { route[route.length - 1].label = `${port.name} 航路の延長線`; route.push(Object.assign(outer, { label: `${port.name} 沖` })); }
            else if (target === 'inner') Object.assign(route[route.length - 1], { label: `${port.name} 航路の入口`, channel: true, narrow: channelNarrow || route[route.length - 1].narrow });
            else route[route.length - 1].label = `${port.name} 沖`;
            if (!deepShip) {
                if (target !== 'inner') route.push(Object.assign(gate, { label: `${port.name} 航路の入口`, channel: true, narrow: channelNarrow }));
                route.push(Object.assign(stop, { label: berthPlan ? `${port.name} 泊地` : `${port.name} 港口`, channel: true, final: true, narrow: channelNarrow }));
            } else {
                if (stopA < T.basin + chLen - 200) route.push(Object.assign(gate, { label: `${port.name} 航路の入口`, channel: true }));
                route.push(Object.assign(stop, { label: `${port.name} 沖の錨地`, channel: stopA < T.basin + chLen, final: true }));
            }
            autopilot.berthPlan = berthPlan; autopilot.berthWhy = berthWhy; autopilot.deepShip = deepShip;
            autopilot._newRoute = route;
            lastErr = null;
            break;
        } catch (e) {
            lastErr = e;
            if (/ocean/.test(e.message)) break;      // 海とつながっていない（湖など）：タグでも無理
        }
    }
    if (lastErr) {
        const e = lastErr;
        autopilot.planning = false; autopilot.dest = null; autopilot.lastErr = e.message;
        const why = /point shallow/.test(e.message) ? `指定した所のまわり ${AP_SEA_SNAP / 1000}km 以内に、この船（喫水 ${worldShipDraft().toFixed(1)}m）が止まれる深さの海がありません`
            : /trapped goal/.test(e.message) && isPt ? '指定した所のまわりは浅瀬が多く、安全に近づけません'
            : /trapped goal/.test(e.message) ? `${port.name} のまわりは浅瀬が多く、この船（喫水 ${worldShipDraft().toFixed(1)}m）ではタグの補助があっても安全に近づけません`
            : /trapped start/.test(e.message) ? '今いる所のまわりが浅く、安全に出られる道がありません（タグや手で深い所へ出てください）'
            : /shallow/.test(e.message) ? '座礁しない深さの航路が見つかりませんでした（浅瀬が多すぎます）' : /ocean|blocked|trapped/.test(e.message) ? '海とつながった航路がありません。湖の港か、とても狭い水路の奥の港かもしれません' : e.message;
        _apMsg(`${port.name} への航路が見つかりませんでした（${why}）`);
        return;
    }
    const route = _apSmoothRoute(_apFixFirstLeg(autopilot._newRoute)); autopilot._newRoute = null;
    route.forEach((w, i) => { if (!w.label) w.label = `変針点 ${i + 1}`; });
    autopilot.route = route; autopilot.leg = 0; autopilot.planning = false; autopilot.active = true;
    autopilot.planDraft = draft; autopilot.draftT = 0;           // この喫水で引いた航路（深くなったら引き直す）
    if (autopilot.agDest !== port) { autopilot.agDest = port; autopilot.agCount = 0; autopilot.agLog = []; }
    autopilot.legFrom = worldShipLatLon(); autopilot.lastOrder = null; autopilot.overshoot = false;
    autopilot.note = (port.point && autopilot.pointMoved > 0) ? `指定した所は浅い（または陸）ので、${autopilot.pointMoved >= 1000 ? (autopilot.pointMoved / 1000).toFixed(1) + 'km' : autopilot.pointMoved + 'm'} 離れた深い所で止まります` : '';
    _apMsg('');
    if (typeof worldMapRedraw === 'function') worldMapRedraw(true);
}
function autopilotStop(msg, silent) {
    const was = autopilot.active;
    // 途中で止まったときは、あとで「再開」できるように覚えておく
    if (was && !silent && autopilot.route && autopilot.dest) {
        autopilot.resume = { dest: autopilot.dest, route: autopilot.route, leg: autopilot.leg, legFrom: autopilot.legFrom,
                             berthPlan: autopilot.berthPlan, deepShip: autopilot.deepShip, planDraft: autopilot.planDraft };
    }
    autopilot.active = false; autopilot.planning = false; autopilot.aground = null; autopilot.turnFirst = null;
    if (!silent) { autopilot.route = null; autopilot.dest = null; }
    if (!silent && typeof tugEscortStop === 'function') tugEscortStop();
    autopilot.escort = '';
    if (typeof _br !== 'undefined') _br.autoHelm = false;
    if (msg !== undefined) _apMsg(msg || '');
    if (was && typeof worldMapRedraw === 'function') worldMapRedraw(true);
}
// 止まった自動航行を続ける。航路の線の近く（1km 以内）なら同じ航路で、離れていたら今の場所から航路を探し直す
function autopilotResume() {
    const r = autopilot.resume;
    if (!r) return;
    autopilot.resume = null;
    if (typeof harborBerthedAt === 'function' && harborBerthedAt()) { autopilotStart(r.dest); return; }
    const here = worldShipLatLon();
    const from = r.leg > 0 ? r.route[r.leg - 1] : r.legFrom;
    const to = r.route[r.leg];
    let off = Infinity;
    if (from && to) {
        const psiA = _apMercY(from.lat), dX = _apDLon(from.lon, to.lon) * _apRad, dY = _apMercY(to.lat) - psiA;
        const sX = _apDLon(from.lon, here.lon) * _apRad, sY = _apMercY(here.lat) - psiA, dl = Math.hypot(dX, dY);
        off = dl > 1e-9 ? Math.abs(dX * sY - dY * sX) / dl * WORLD_R * Math.cos(here.lat * _apRad) : rhumbCourse(here.lat, here.lon, to.lat, to.lon).dist;
    }
    // 離れた・座礁した・止めている間にレバーで喫水を深くした：今の場所と喫水で探し直す
    if (off > 1000 || (window.terrain && terrain.grounded) || !(worldShipDraft() <= (r.planDraft || 0) + 0.5)) { autopilotStart(r.dest); return; }
    Object.assign(autopilot, { route: r.route, leg: r.leg, legFrom: r.legFrom, dest: r.dest, berthPlan: r.berthPlan, deepShip: r.deepShip,
                               planDraft: r.planDraft, draftT: 0, active: true, planning: false, lastOrder: null, overshoot: false, msg: '' });
    renderAutopilotPanel();
    if (typeof worldMapRedraw === 'function') worldMapRedraw(true);
}
function autopilotDepartNow() { const p = autopilot.pendingDepart; if (!p) return; autopilot.pendingDepart = null; autopilot._departGo = true; autopilotStart(p); autopilot._departGo = false; }
function autopilotCancelDepart() { autopilot.pendingDepart = null; autopilot.selfDepart = null; autopilot.msg = ''; renderAutopilotPanel(); }
window.autopilotDepartNow = autopilotDepartNow; window.autopilotCancelDepart = autopilotCancelDepart;
function autopilotDismiss() { autopilot.pendingDepart = null; autopilot.resume = null; autopilot.msg = ''; if (typeof harborAuto !== 'undefined') { harborAuto.msg = ''; harborAuto.resume = null; } renderAutopilotPanel(); }
function autopilotFold(on) { autopilot.folded = !!on; try { localStorage.setItem('susuru_ap_fold', on ? '1' : '0'); } catch (e) { /* ignore */ } renderAutopilotPanel(); }
try { autopilot.folded = localStorage.getItem('susuru_ap_fold') === '1'; } catch (e) { /* ignore */ }
Object.assign(window, { autopilotResume, autopilotDismiss, autopilotFold });
function autopilotSetCruise(k) { if (AP_SPEEDS[k]) { autopilot.cruise = k; autopilot.lastOrder = null; renderAutopilotPanel(); } }
Object.assign(window, { autopilotStart, autopilotStop, autopilotSetCruise });

// ── 舵を取る ──
function _apHelm(cmd, dt) {
    cmd = Math.max(-35, Math.min(35, cmd));
    if (typeof bridgeWheelActive === 'function' && bridgeWheelActive() && typeof _br !== 'undefined') {
        const lock = WHEEL_LOCK_DEG[bridgeUI.wheel] || 360;
        const want = cmd / 35 * lock;
        const rate = (HELM_KEY_RATE_WHEEL[bridgeUI.wheel] || HELM_KEY_RATE) / 35 * lock * 1.5 * dt;
        const d = want - _br.wheelDeg;
        _br.wheelDeg += Math.abs(d) <= rate ? d : Math.sign(d) * rate;
        _br.wheelTarget = null;
        _br.autoHelm = true;
        _br.dirtyW = true;
        physics.helmOrder = _br.wheelDeg / lock * 35;
    } else {
        physics.autoRudder = cmd;          // 17-main-loop.js の舵の計算が追いかける
    }
}
function _apOrder(v) {
    if (autopilot.lastOrder === v) return;
    autopilot.lastOrder = v;
    if (typeof setTelegraphOrder === 'function') setTelegraphOrder(v);
    else physics.telegraphState = v;
}

// ── 座礁から抜け出す ──
//  1) 自力：乗り上げが浅くなる方（前か後ろ）へ機関をかける（半速 → 全速 → 反対向きも一度）
//  2) 抜けなければタグを呼び、横・回頭はタグ、前後は機関で、乗り上げが浅くなる方へ
//  3) 抜けたら少し深い所へ出て止まり、今の場所から航路を引き直す
//  タグが付いてから AG_TUG_MAX 秒たっても抜けなければ、自動航行を止める
const AG_SELF_MAX = 75, AG_STALL = 18, AG_TUG_MAX = 240;
function _agLen() { const hp = window.hullProfile; return ((hp && hp.ready) ? hp.halfLen * 2 : 12) * (physics.scale || 1); }
// 抜け出す向きの候補：a＝前後（＋前）、s＝横（＋左舷）、h＝回頭（＋heading が増える向き）。
// 少し動いたときにどれだけ浅くなるか（gain）と、どこまで動けば抜けるか（free：船首尾の動く道のり[m]）
function _agOptions(withTugs) {
    const L = _agLen(), s0 = worldGroundTry(0, 0, 0), kMax = Math.max(60, 1.5 * L);
    const out = [];
    const add = (name, a, s, h) => {
        const n = Math.hypot(a, s) || 1, ua = a / n, us = s / n;
        const step = h && !a && !s ? 3 : 10;
        const r1 = h && !a && !s ? worldGroundTry(0, 0, h * step) : worldGroundTry(ua * step, us * step, 0);
        if (r1.hard > s0.hard) return;                                  // 岸壁・陸の方へは行かない
        let free = Infinity;
        if (h && !a && !s) {
            for (const k of [3, 6, 10, 15, 22, 30]) { const r = worldGroundTry(0, 0, h * k); if (r.hard > s0.hard) break; if (r.score < 0.02) { free = L / 2 * k * Math.PI / 180; break; } }
        } else {
            for (const k of [8, 16, 30, 50, 80, 120, 180, 260, 360]) { if (k > kMax) break; const r = worldGroundTry(ua * k, us * k, 0); if (r.hard > s0.hard) break; if (r.score < 0.02 && r.hard === 0) { free = k; break; } }
        }
        out.push({ name, a: ua * (a ? 1 : 0), s: us * (s ? 1 : 0), h, gain: s0.score - r1.score, free });
    };
    add('astern', -1, 0, 0); add('ahead', 1, 0, 0);
    if (withTugs) {
        add('port', 0, 1, 0); add('stbd', 0, -1, 0);
        for (const a of [-1, 1]) for (const s of [-1, 1]) add(`diag${a}${s}`, a, s, 0);
        add('rotL', 0, 0, 1); add('rotR', 0, 0, -1);
    }
    // 近くで抜けられる向き → だめなら、いちばん浅くなる向き（後進を少しひいきする：来た道を戻る）
    out.forEach(o => { o.cost = o.free < Infinity ? o.free : 1e6 - 1000 * o.gain; if (o.name === 'astern') o.cost *= 0.8; });
    out.sort((x, y) => x.cost - y.cost);
    return out.filter(o => o.free < Infinity || o.gain > 0.01);
}
// 船を前後 dA・横 dS[m] 動かした所で、船体のまわり（両舷・船首尾の先 40m まで）が十分深いか
function _agDeepAt(dA, dS) {
    const hp = window.hullProfile, sc = physics.scale || 1, HL = ((hp && hp.ready) ? hp.halfLen : 6) * sc;
    let hw = 0; if (hp && hp.ready) for (const sl of hp.slices || []) hw = Math.max(hw, sl.halfWidth || 0); hw = (hw || 1.5) * sc;
    const need = apMargins().needTug, h = physics.heading * _apRad, fx = Math.sin(h), fz = Math.cos(h), sx = Math.cos(h), sz = -Math.sin(h);
    const x0 = physics.cgWorldX + fx * dA + sx * dS, z0 = physics.cgWorldZ + fz * dA + sz * dS;
    for (const a of [-(HL + 40), -HL * 0.5, 0, HL * 0.5, HL + 40]) for (const s of [-(hw + 40), 0, hw + 40]) {
        if (worldSeabedAt(x0 + fx * a + sx * s, z0 + fz * a + sz * s) > -need) return false;
    }
    return true;
}
// 抜けたあと、どちらへどれだけ動けば深い所に出るか（途中で乗り上げない向きのうち、いちばん近い所）。
// タグがいなければ前後だけ
function _agRetreat(withTugs, prefer) {
    const dirs = [[-1, 0], [1, 0]];
    if (withTugs) dirs.push([0, 1], [0, -1], [-0.7, 0.7], [-0.7, -0.7], [0.7, 0.7], [0.7, -0.7]);
    let best = null;
    for (const [a, s] of dirs) {
        for (let k = 0; k <= 1500; k += 25) {
            if (k && worldGroundTry(a * k, s * k, 0).score > 0.02) break;
            if (_agDeepAt(a * k, s * k)) {
                // 横へ動くのは遅い（タグで 0.4m/s）ので、前後の 3 倍の道のりとみる。抜けてきた向きを少しひいきする
                const cost = k * (1 + 2 * Math.abs(s)) * (prefer && Math.sign(a) === Math.sign(prefer.a) && Math.sign(s) === Math.sign(prefer.s) ? 0.8 : 1);
                if (!best || cost < best.cost) best = { a, s, k, cost };
                break;
            }
        }
    }
    return best;
}
// 座礁から抜けて航路を引き直したあと：最初の区間の向きへ回る円（旋回径）が浅い所にかかるなら、
// 機関は止めたまま、タグでその場で回頭してから進む（かからなければ、そのまま航路へ）。
// 回し終えたら、座礁のときに呼んだタグは帰す。true を返す間は、ふつうの航路の操船をしない
// サイドスラスター・アジポッドがあるか（58-maneuvering.js）。無ければタグなしの出入港は舵と機関だけで
function apHasThrusters() {
    if (typeof azipodActive === 'function' && azipodActive()) return true;
    return typeof maneuver !== 'undefined' && maneuver.thrusters.some(T => T._on !== false && (+T.kW || 0) > 0);
}
window.apHasThrusters = apHasThrusters;
function _apTurnFirst(dt) {
    const F = autopilot.turnFirst, R = autopilot.route;
    const noTug = !apUseTugs('narrow');               // タグを使わないなら、サイドスラスターでその場で回す
    if (!R || !R[autopilot.leg]) { autopilot.turnFirst = null; return false; }
    const here = worldShipLatLon(), wp = R[autopilot.leg];
    const hT = _apHeadingForTrue(rhumbCourse(here.lat, here.lon, wp.lat, wp.lon).course);
    const e = ((hT - physics.heading + 540) % 360) - 180;
    const done = () => { if (F.ownTugs && typeof tugEscortStop === 'function') tugEscortStop(); autopilot.turnFirst = null; return false; };
    if (!F.checked) {
        F.checked = true;
        if (Math.abs(e) < 20) return done();
        // 回る円の上で、船体のまわりが喫水＋1m より深いか（10°おき）
        const hp = window.hullProfile, sc = physics.scale || 1, HL = ((hp && hp.ready) ? hp.halfLen : 6) * sc;
        let hw = 0; if (hp && hp.ready) for (const sl of hp.slices || []) hw = Math.max(hw, sl.halfWidth || 0); hw = (hw || 1.5) * sc;
        const Rt = _apTurnRadius(), s = Math.sign(e), h0 = physics.heading * _apRad, dr = worldShipDraft() + 1;
        const px = Math.cos(h0), pz = -Math.sin(h0);                       // 左舷の向き（heading が増える向きへ回る）
        const cx = physics.cgWorldX + px * Rt * s, cz = physics.cgWorldZ + pz * Rt * s;
        let blocked = false;
        for (let th = 10; th <= Math.abs(e) + 10 && !blocked; th += 10) {
            const h = h0 + s * th * _apRad, fx = Math.sin(h), fz = Math.cos(h), qx = Math.cos(h), qz = -Math.sin(h);
            const X = cx - s * Rt * qx, Z = cz - s * Rt * qz;
            for (const a of [-HL, 0, HL]) for (const o of [-hw, 0, hw]) if (worldSeabedAt(X + fx * a + qx * o, Z + fz * a + qz * o) > -dr) { blocked = true; break; }
        }
        if (!blocked) return done();
        if (noTug && !apHasThrusters()) return done();      // スラスターの無い船は、その場では回れないので舵で
        if (noTug) _apMsg('ここで向きを変えると浅い所にかかるので、サイドスラスターでその場で回します');
        else {
            if (!tugEscort.active && typeof tugEscortStart === 'function') { tugEscortStart(); F.ownTugs = true; tugEscort.t = 0; }
            _apMsg('ここで向きを変えると浅い所にかかるので、タグでその場で回します');
        }
    }
    F.t += dt;
    _apOrder(0); _apHelm(0, dt);
    if (Math.abs(e) < 8 || F.t > 600) { _apMsg(''); return done(); }
    if (noTug) {
        // 船首・船尾のサイドスラスター：小さな船ほど速く回る（270m で毎秒 0.5°、60m で 2°）。行き足は止める
        const gd = dt * (typeof physicsSpeed !== 'undefined' ? physicsSpeed : 1);
        const rate = Math.max(0.4, Math.min(3, 130 / Math.max(20, apShipLen())));
        if (Math.abs(physics.speed || 0) < 1.5) physics.heading += Math.sign(e) * Math.min(Math.abs(e), rate * gd);
        if (typeof maneuverAutoVis === 'function') maneuverAutoVis(0, Math.sign(e));      // スラスターの噴き出す水（58-maneuvering.js）
        _apMsg(`サイドスラスターでその場で回頭しています（あと ${Math.round(Math.abs(e))}°）`);
        return true;
    }
    tugEscort.t = (tugEscort.t || 0) + dt;
    if (typeof tugEscortReady === 'function' && tugEscortReady()) {
        tugEscortAssist(0, e, dt);
        _apMsg(`タグでその場で回頭しています（あと ${Math.round(Math.abs(e))}°）`);
    } else _apMsg('ここで向きを変えると浅い所にかかるので、タグを待っています（その場で回します）');
    return true;
}
function _agDirWord(o) {
    if (!o) return '';
    if (o.h && !o.a && !o.s) return '回頭して';
    const w = [];
    if (o.a < 0) w.push('後ろ'); else if (o.a > 0) w.push('前');
    if (o.s > 0) w.push('左舷の方'); else if (o.s < 0) w.push('右舷の方');
    return w.join('・') + 'へ';
}
function _apAground(dt) {
    if (!autopilot.aground) {
        // 「何度も座礁する」は、同じ辺り（3km 以内）での回数で数える（リヴァプールを出るときの座礁を、
        // サウサンプトンに着いたときまで数えていて、1 回目の座礁で止まっていた）
        const ll = worldShipLatLon();
        autopilot.agLog = (autopilot.agLog || []).filter(e => worldDistance(e.lat, e.lon, ll.lat, ll.lon) < 3000);
        autopilot.agLog.push({ lat: ll.lat, lon: ll.lon });
        autopilot.agCount = autopilot.agLog.length;
        autopilot.turnFirst = null;
        if (autopilot.agCount > 4) {
            _apOrder(0);
            if (typeof tugEscortStop === 'function' && tugEscort.active) tugEscortStop();
            autopilotStop('何度も座礁するので、自動航行を止めました。浅瀬の少ない所まで手で操船してください');
            return;
        }
    }
    const G = autopilot.aground || (autopilot.aground = { phase: 'self', t: 0, phaseT: 0, stallT: 0, best: Infinity, opt: null, tries: 0, order: 2, freeT: 0, tugs: false, tugT: 0, planT: 0 });
    G.t += dt; G.phaseT += dt;
    const grounded = !!(window.terrain && terrain.grounded);
    const score = worldGroundTry(0, 0, 0).score;
    _apHelm(0, dt);
    const go = (phase) => { G.phase = phase; G.phaseT = 0; G.stallT = 0; G.best = Infinity; G.planT = 0; G.stopT = 0; };
    // 抜けたか（波で一瞬浮いただけでなく、1.5 秒続けて）
    G.freeT = grounded ? 0 : G.freeT + dt;
    if (G.t > 900) {                                       // 15 分たっても抜けられない
        _apOrder(0);
        if (G.ownTugs && typeof tugEscortStop === 'function') tugEscortStop();
        autopilotStop('座礁から抜け出せませんでした。操作パネルの Draft レバーで喫水を浅くするか、手で操船してください');
        return;
    }
    if ((G.phase === 'self' || G.phase === 'tug') && G.freeT > 1.5) {
        G.back = G.phase; go('clear');
        G.from = { x: physics.cgWorldX, z: physics.cgWorldZ };
        // 深い所まで出てから航路を引き直す（浅瀬の近くから引くと、また同じ浅瀬を通ることがある）
        G.ret = _agRetreat(G.tugs, G.opt);
        _apMsg('抜け出しました。深い所へ出ています');
    }
    // 進み具合：乗り上げが浅くなっていれば進んでいる
    if (score < G.best - Math.max(0.05, G.best * 0.03)) { G.best = score; G.stallT = 0; } else G.stallT += dt;
    // タグ：前後へ抜けるときは、そちらの端の 2 隻がまっすぐ引き（power）、残りで横ずれ・回頭を押さえる。
    // 横・回頭で抜けるときは、全部で横へ押し引き・回す
    const tugWork = (o, power) => {
        if (typeof _teTugs !== 'function' || typeof _haAllocate !== 'function') return;
        tugEscort.t = (tugEscort.t || 0) + dt;
        const all = _teTugs(), use = all.filter(_haWorking);
        for (const t of all) if (!use.includes(t)) t.autoPower = 0;
        const st = tugStations(), zOf = (t) => { const q = st.find(s2 => s2.key === t.station); return q ? q.z : 0; };
        const along = (o && o.a && !o.s && !o.h) ? use.filter(t => Math.sign(zOf(t)) === Math.sign(o.a)).sort((x, y) => Math.abs(zOf(y)) - Math.abs(zOf(x))).slice(0, 2) : [];
        for (const t of along) {
            if (t.action !== 'pull' || t.dir !== (o.a > 0 ? 'fwd' : 'aft')) { t.action = 'pull'; t.dir = o.a > 0 ? 'fwd' : 'aft'; t.engaged = true; }
            t.autoPower = power; t.switchT = 0;
        }
        const rest = use.filter(t => !along.includes(t));
        if (!rest.length) return;
        const D = _haDims(), massKg = Math.max(1e5, (physics.mass || 1) * 1e6);
        const vS = _tugShip.vSway, r = _tugShip.yawRate + (physics.turnRate || 0) * _haRad;
        const vSd = o ? Math.max(-0.4, Math.min(0.4, 0.015 * o.s * 30 * power)) : 0;
        const rd = o ? Math.max(-0.006, Math.min(0.006, 0.03 * o.h * 10 * power * _haRad)) : 0;
        _haAllocate(massKg * 1.8 * 0.3 * (vSd - vS), massKg * 1.5 * D.L * D.L / 12 * 0.3 * (rd - r), rest, dt);
    };
    const engStopped = () => Math.abs(physics.propRpm || 0) < 0.15 && !(Number.isFinite(physics.telegraphAnswer) && physics.telegraphAnswer !== 0);
    const orderFor = (o, lvl) => (o && o.a) ? Math.sign(o.a) * lvl : 0;
    if (G.phase === 'self') {
        if (!G.opt) {
            G.opt = _agOptions(false)[0] || null;
            if (!G.opt) { go('tug'); return; }
            G.order = 2;
            _apMsg(`座礁しました。${G.opt.a < 0 ? '後進' : '前進'}で、自力で抜け出そうとしています`);
        }
        // 半速で進まなければ全速、全速でもだめなら反対向きを一度、それでもだめならタグ
        if (G.stallT > AG_STALL) {
            if (G.order < 3) { G.order = 3; G.stallT = 0; _apMsg(`座礁しました。${G.opt.a < 0 ? '全速後進' : '全速前進'}で、自力で抜け出そうとしています`); }
            else if (G.tries < 1) {
                G.tries++; G.stallT = 0; G.best = Infinity;
                const other = _agOptions(false).find(o => Math.sign(o.a) !== Math.sign(G.opt.a));
                if (other) { G.opt = other; G.order = 2; _apMsg(`座礁しました。今度は${other.a < 0 ? '後進' : '前進'}で抜け出そうとしています`); }
                else G.tries = 9;
            } else { go('tug'); return; }
        }
        if (G.phaseT > AG_SELF_MAX) { go('tug'); return; }
        _apOrder(orderFor(G.opt, G.order));
        return;
    }
    if (G.phase === 'tug') {
        if (!G.tugs) {
            G.tugs = true;
            if (typeof tugEscortStart === 'function') {
                G.ownTugs = !tugEscort.active;
                if (G.ownTugs) tugEscortStart();
                tugEscort.t = 0;
            }
            _apOrder(0);
            G.opt = null;
        }
        const ready = typeof tugEscortReady === 'function' && tugEscortReady();
        const n = (typeof _teTugs === 'function') ? _teTugs().length : 0, on = (typeof _teTugs === 'function') ? _teTugs().filter(t => t.state === 'on').length : 0;
        if (!ready) {
            _apMsg(`自力では抜け出せないので、タグを呼びました（${on}/${n} 隻が付いています）。タグと一緒に抜け出します`);
            _apOrder(0);
            return;
        }
        G.tugT += dt; G.planT -= dt;
        // 向きは 4 秒おき（止まっていれば、すぐ）に選び直す
        if (!G.opt || G.planT <= 0 || G.stallT > 10) {
            const o = _agOptions(true)[0] || null;
            if (o && (!G.opt || o.name !== G.opt.name)) G.stallT = 0;
            G.opt = o; G.planT = 4;
            if (G.stallT > 10) G.stallT = 0;
        }
        if (G.tugT > AG_TUG_MAX || (!G.opt && G.tugT > 30)) {
            _apOrder(0);
            if (G.ownTugs && typeof tugEscortStop === 'function') tugEscortStop();
            autopilotStop('タグと一緒でも座礁から抜け出せませんでした。操作パネルの Draft レバーで喫水を浅くするか、手で操船してください');
            return;
        }
        _apMsg(`タグ${on}隻と機関で、${_agDirWord(G.opt)}抜け出しています`);
        _apOrder(orderFor(G.opt, G.tugT > 60 ? 3 : 2));
        tugWork(G.opt, 1);
        return;
    }
    if (G.phase === 'clear') {
        // また乗り上げた：もとの手順へ（何度も乗り上げるなら、はじめからタグで）
        if (grounded && G.freeT === 0 && G.phaseT > 0.5) {
            G.regrounds = (G.regrounds || 0) + 1;
            go(G.regrounds > 2 ? 'tug' : (G.back || 'self')); G.opt = null; G.order = 2; G.tries = 0;
            return;
        }
        const moved = Math.hypot(physics.cgWorldX - G.from.x, physics.cgWorldZ - G.from.z);
        const L = _agLen(), v = physics.speed || 0;
        // 深い所へ、ゆっくり（1.5 以下）出る。行き足が付いていれば機関は止めて惰性で。横へはタグで
        G.deepT = (G.deepT || 0) - dt;
        if (G.deepT <= 0) { G.deepT = 0.5; G.deep = _agDeepAt(0, 0); }
        const R = G.ret || (G.opt ? { a: Math.sign(G.opt.a || 0), s: Math.sign(G.opt.s || 0) } : { a: 0, s: 0 });
        if (!G.stopT && (G.ret ? !G.deep : moved < Math.max(40, 0.3 * L)) && G.phaseT < 300) {
            const away = Math.abs(R.a) > 0.3 ? Math.sign(R.a) : 0;
            let o = 0;
            if (Math.abs(v) > 1.5 && Math.sign(v) === away) o = 0;
            else if (away && Math.sign(v) !== away || Math.abs(v) < 0.8) o = away;
            else if (Math.abs(v) < 1.5 && (autopilot.lastOrder || 0) === away) o = away;
            _apOrder(o);
            if (G.tugs) tugWork({ a: away, s: R.s ? Math.sign(R.s) : 0, h: 0 }, Math.abs(v) < 1 ? (away && !R.s ? 0.4 : 1) : 0);
            _apMsg(`抜け出しました。深い所へ出ています${G.ret ? `（${_agDirWord({ a: away, s: R.s ? Math.sign(R.s) : 0 })}あと ${Math.max(0, Math.round(G.ret.k - moved))}m ほど）` : ''}`);
            return;
        }
        // 止まって（プロペラも止まって）から航路を引き直す。逆へかけるとプロペラの遅れで行き過ぎるので、機関を止めて惰性で
        G.stopT = (G.stopT || 0) + dt;
        _apOrder(0);
        if (G.tugs) tugWork(null, 0);
        if ((Math.abs(v) > 0.5 || !engStopped() || autopilot.lastOrder) && G.stopT < 120) return;
        _apOrder(0);
        const withTugs = G.tugs, ownTugs = !!G.ownTugs;
        autopilot.aground = null;
        const dest = autopilot.dest;
        if (!dest) { if (ownTugs && typeof tugEscortStop === 'function') tugEscortStop(); autopilotStop('座礁から抜け出しました'); return; }
        // まず、今の航路の続きへ戻れないか（港への進入路の途中なら、最初からやり直さない）
        if (_apResumeRoute()) {
            autopilot.note = withTugs ? '座礁からタグと一緒に抜け出しました。航路の続きへ戻ります' : '座礁から自力で抜け出しました。航路の続きへ戻ります';
            autopilot.turnFirst = { t: 0, ownTugs, checked: false };
            renderAutopilotPanel();
            return;
        }
        const note = withTugs ? '座礁からタグと一緒に抜け出しました。今の場所から航路を引き直しました' : '座礁から自力で抜け出しました。今の場所から航路を引き直しました';
        autopilotStart(dest).then(() => {
            if (!autopilot.active) { if (ownTugs && typeof tugEscortStop === 'function') tugEscortStop(); return; }
            if (!autopilot.note) autopilot.note = note;
            // 最初の区間へ向きを変える前に、回る円が浅い所にかからないか見る（かかるならタグでその場で回す）
            autopilot.turnFirst = { t: 0, ownTugs, checked: false };
            renderAutopilotPanel();
        });
    }
}

// ── 毎フレーム ──
function updateAutopilot(t, dt) {
    if (!window.world || world.mode !== 'world') { if (autopilot.active) autopilotStop('世界を航海するモードではないので、自動航行を止めました'); return; }
    // タグなしの出港：岸壁から横へ離れる（ゆっくり加速し、離れたら航路を引いて出る）
    if (autopilot.selfDepart && autopilot.selfDepart.rudder) {
        // スラスターの無い船：スプリングで船首（後進なら船尾）を沖へ振り出し、後進なら船の長さほど下がって、舵で出る
        const S = autopilot.selfDepart, d = Math.min(0.1, Math.max(0, dt || 0)) * (typeof physicsSpeed !== 'undefined' ? physicsSpeed : 1);
        const e = ((S.h1 - physics.heading + 540) % 360) - 180;
        const h = physics.heading * _apRad, fx = Math.sin(h), fz = Math.cos(h), ox = Math.cos(h) * S.out, oz = -Math.sin(h) * S.out;
        if (Math.abs(e) > 0.3) {
            const dh = Math.sign(e) * Math.min(Math.abs(e), 0.5 * d);
            physics.heading += dh;
            // 岸壁に当てた端を支点に回るので、重心は少し沖へ出る
            const HL = apShipLen() / 2, step = HL * Math.abs(dh) * _apRad * 0.9;
            physics.cgWorldX += ox * step; physics.cgWorldZ += oz * step;
            physics.speed = 0;
            return;
        }
        if (S.back && S.moved < S.need) {
            S.v = Math.min(1.2, S.v + 0.05 * d, Math.max(0.2, (S.need - S.moved) * 0.05));
            const step = Math.min(S.need - S.moved, S.v * d);
            physics.cgWorldX -= fx * step; physics.cgWorldZ -= fz * step; S.moved += step;
            physics.speed = 0;
            _apMsg(`後進で岸壁から下がっています（あと ${Math.round(S.need - S.moved)}m）`);
            return;
        }
        autopilot.selfDepart = null; autopilot._departGo = true;
        // 航路を引いたら、そのまま舵で回って出る（その場では回らない）
        Promise.resolve(autopilotStart(S.port)).then(() => { if (autopilot.active) autopilot.turnFirst = null; });
        autopilot._departGo = false;
        return;
    }
    if (autopilot.selfDepart) {
        const S = autopilot.selfDepart, d = Math.min(0.1, Math.max(0, dt || 0)) * (typeof physicsSpeed !== 'undefined' ? physicsSpeed : 1);
        const left = S.need - S.moved;
        if (left > 0.01) {
            S.v = Math.min(S.moved < 25 ? 0.6 : 1.6, S.v + 0.08 * d, Math.max(0.15, left * 0.08));
            const step = Math.min(left, S.v * d);
            physics.cgWorldX += S.dx * step; physics.cgWorldZ += S.dz * step; S.moved += step;
            if (typeof maneuverAutoVis === 'function' && typeof _shipFrame === 'function') { const F = _shipFrame(); maneuverAutoVis(Math.sign(S.dx * F.sx + S.dz * F.sz), 0); }
            physics.speed = 0;
            return;
        }
        // 港口の向きへ回る
        if (Number.isFinite(S.hOut)) {
            const e = ((S.hOut - physics.heading + 540) % 360) - 180;
            if (Math.abs(e) > 2) {
                const rate = Math.max(0.4, Math.min(3, 130 / Math.max(20, apShipLen())));
                physics.heading += Math.sign(e) * Math.min(Math.abs(e), rate * d);
                if (typeof maneuverAutoVis === 'function') maneuverAutoVis(0, Math.sign(e));
                _apMsg(`サイドスラスターで港口の方へ回っています（あと ${Math.round(Math.abs(e))}°）`);
                return;
            }
        }
        {
            autopilot.selfDepart = null; autopilot._departGo = true;
            // 航路が決まったら、最初の区間へ向く（浅い所にかかるならスラスターでその場で回す）
            Promise.resolve(autopilotStart(S.port)).then(() => { if (autopilot.active) autopilot.turnFirst = { t: 0, ownTugs: false, checked: false }; });
            autopilot._departGo = false;
        }
        return;
    }
    // 出港の用意：テレグラフが STAND BY になったら出る
    if (autopilot.pendingDepart && (physics.telegraphAnswerSpecial === 'standby' || physics.telegraphSpecial === 'standby')) {
        const p = autopilot.pendingDepart; autopilot.pendingDepart = null;
        autopilot._departGo = true; autopilotStart(p); autopilot._departGo = false;
    }
    // 原点が遠くなったら移す
    if (Math.hypot(physics.cgWorldX || 0, physics.cgWorldZ || 0) > AP_REBASE_DIST) worldRebase();
    if (!autopilot.active || !autopilot.route) return;
    if (typeof isDesignMode !== 'undefined' && isDesignMode) return;
    dt = Math.min(0.1, Math.max(0, dt || 0));
    // 手で舵を取ったら切る
    if ((typeof keys !== 'undefined' && (keys.a || keys.d)) || (typeof _br !== 'undefined' && _br.wheelDrag)) { autopilotStop('手で舵を取ったので、自動航行を切りました'); return; }
    // 座礁した：自動航行は切らずに、自力で → 無理ならタグを呼んで一緒に抜け出す
    if (autopilot.aground || (window.terrain && terrain.grounded)) { _apAground(dt); return; }
    if (autopilot.turnFirst) { if (_apTurnFirst(dt)) return; }
    // レバーで喫水を深くした（0.5m より多く）：レバーを動かし終えて 2 秒たったら、今の喫水で航路を引き直す
    if (autopilot.planDraft > 0 && autopilot.dest) {
        const dNow = worldShipDraft();
        if (dNow > autopilot.planDraft + 0.5) {
            if (Math.abs(dNow - (autopilot.draftSeen || 0)) > 0.02) { autopilot.draftSeen = dNow; autopilot.draftT = 0; }
            autopilot.draftT = (autopilot.draftT || 0) + dt;
            if (autopilot.draftT > 2) {
                const note = `喫水が ${autopilot.planDraft.toFixed(1)}m から ${dNow.toFixed(1)}m に深くなったので、航路を引き直しました`;
                autopilot.planDraft = 0;
                autopilotStart(autopilot.dest).then(() => { if (autopilot.active && !autopilot.note) { autopilot.note = note; renderAutopilotPanel(); } });
                return;
            }
        } else autopilot.draftT = 0;
    }
    const R = autopilot.route;
    const here = worldShipLatLon();
    let wp = R[autopilot.leg];
    let rc = rhumbCourse(here.lat, here.lon, wp.lat, wp.lon);
    // 変針点に着いた（近い、または通り過ぎた）ら次へ
    const hp = window.hullProfile;
    const L = ((hp && hp.ready) ? hp.halfLen * 2 : 12) * (physics.scale || 1);
    let reach = wp.final ? Math.max(60, L * 0.5) : wp.channel ? Math.max(150, L) : Math.max(900, L * 4);
    const prev = autopilot.leg > 0 ? R[autopilot.leg - 1] : autopilot.legFrom;
    // 次が航路・狭い水路なら、早めに変針して線を大きく外れないよう、回る角度と旋回の大きさから変針を始める所を決める
    const nxt = R[autopilot.leg + 1];
    if (!wp.final && nxt && (nxt.narrow || nxt.channel) && prev) {
        const c1 = rhumbCourse(prev.lat, prev.lon, wp.lat, wp.lon).course, c2 = rhumbCourse(wp.lat, wp.lon, nxt.lat, nxt.lon).course;
        const dC = Math.min(80, Math.abs(((c2 - c1 + 540) % 360) - 180));
        const Rt = _apTurnRadius();
        reach = Math.max(wp.channel ? Math.max(150, L) : 150, Math.min(2500, Rt * Math.tan(dC / 2 * _apRad)));
        // 短い区間が続く所（港の口のくねった航路など）では、前後の区間の半分より手前から曲がらない（点を飛ばさない）
        const lPrev = rhumbCourse(prev.lat, prev.lon, wp.lat, wp.lon).dist, lNext = rhumbCourse(wp.lat, wp.lon, nxt.lat, nxt.lon).dist;
        reach = Math.min(reach, Math.max(60, 0.5 * Math.min(lPrev, lNext)));
    }
    let passed = false;
    if (prev && !wp.final) {
        const leg = rhumbCourse(prev.lat, prev.lon, wp.lat, wp.lon);
        const diff = Math.abs(((rc.course - leg.course + 540) % 360) - 180);
        passed = diff > 100 && rc.dist < leg.dist;     // 目標が後ろになった
    }
    // 点のまわりを回り続けない：同じ変針点へ向かう間に 1 回り近く（330°）回ってしまったら、その点は通ったことにする
    //（大きな船が小さく曲がれない所。ベルファストの出口などで、いつまでもくるくる回っていた）
    if (!autopilot.circ || autopilot.circ.leg !== autopilot.leg || autopilot.circ.R !== R) autopilot.circ = { leg: autopilot.leg, R, h: physics.heading, turned: 0 };
    else { autopilot.circ.turned += Math.abs(((physics.heading - autopilot.circ.h + 540) % 360) - 180); autopilot.circ.h = physics.heading; }
    if (!wp.final && autopilot.circ.turned > 330 && autopilot.leg < R.length - 1) passed = true;
    // 最後の区間：止まるまでに進む距離（機関を止めると速さは 0.3/排水量 の割合で落ちる）を見て、
    // 早めに機関停止、足りなければ後進微速。止まりかけたら到着
    let finalOrder = null;
    if (wp.final) {
        const k = 0.3 / Math.max(0.05, physics.mass || 1);
        const v = Math.max(0, physics.speed || 0);
        const dStop = v / k;
        const near = rc.dist < Math.max(reach, dStop * 0.6);
        if (rc.dist < dStop * 1.15) finalOrder = 0;
        // 後進はスクリューが止まるまで効き続けるので、遅くなったら早めにやめる（後ろへ走り出さないように）
        if ((rc.dist < dStop * 0.6 || autopilot.overshoot) && v > 1.2) finalOrder = v > 4 ? -2 : -1;
        if ((physics.speed || 0) < -0.3) finalOrder = 0;             // 後進で後ろへ動き出したら止める
        autopilot.finalSlow = rc.dist < Math.max(2000, dStop * 3);   // 近づいたら微速に落としておく（強い後進が要らないよう）
        if (rc.dist < reach) autopilot.overshoot = true;            // 行き過ぎても、止まるまで後進
        // 止まったら到着（止まる前に港口を過ぎたら、後進で止まってから）。後ろへ動いていても「止まった」ではない
        // （スクリューもほぼ止まってから。後進のまま止めると、あとで後ろへ走り出す）
        const engStopped = Math.abs(physics.propRpm || 0) < 0.15 && !(Number.isFinite(physics.telegraphAnswer) && physics.telegraphAnswer !== 0);
        if (Math.abs(physics.speed || 0) < 0.5 && engStopped && (near || autopilot.overshoot)) rc.dist = 0;
        else if (rc.dist < reach) rc.dist = reach + 1;
    }
    if (rc.dist < reach || passed) {
        if (wp.final) {
            _apOrder(0);
            const nm = autopilot.dest ? autopilot.dest.name : '';
            // タグで着岸（50-harbor-auto.js）
            if (autopilot.berthPlan && autopilot.dest && typeof harborAutoStart === 'function') {
                const dest = autopilot.dest;
                if (typeof tugEscortStop === 'function') tugEscortStop(true);      // 付き添ってきたタグで、そのまま着岸
                autopilotStop('', false); autopilot.route = null; autopilot.resume = null;
                harborAutoStart('berth', harborBerthPlan(dest));
                return;
            }
            if (autopilot.dest && autopilot.dest.point) { autopilotStop(`指定した海域に着きました（水深 ${Math.round(terrain.depth || 0)}m）。機関停止`); autopilot.route = null; autopilot.resume = null; return; }
            autopilotStop(autopilot.deepShip ? `${nm} は船に対して浅いので、沖（水深 ${Math.round(terrain.depth || 0)}m）で止まりました。機関停止` : `${nm} の港口に着きました。機関停止`);
            autopilot.route = null; autopilot.resume = null; return;
        }
        autopilot.leg++;
        wp = R[autopilot.leg];
        rc = rhumbCourse(here.lat, here.lon, wp.lat, wp.lon);
    }
    // 針路：短い区間は線からのずれも直す（物理の面で）
    const from = autopilot.leg > 0 ? R[autopilot.leg - 1] : autopilot.legFrom;
    let course = rc.course;
    const legRc = rhumbCourse(from.lat, from.lon, wp.lat, wp.lon);
    {
        // 線からの横ずれ：メルカトル図（横＝経度、縦＝漸長緯度）の上では航程線はまっすぐなので、
        // その直線からの距離を、船のいる緯度の縮尺（R·cosφ）でメートルにする。長い区間でも使える
        const psiA = _apMercY(from.lat), dX = _apDLon(from.lon, wp.lon) * _apRad, dY = _apMercY(wp.lat) - psiA;
        const sX = _apDLon(from.lon, here.lon) * _apRad, sY = _apMercY(here.lat) - psiA;
        const dl = Math.hypot(dX, dY);
        if (dl > 1e-9) {
            const cross = (dX * sY - dY * sX) / dl * WORLD_R * Math.cos(here.lat * _apRad);   // ＋：線の左
            const corr = Math.max(-35, Math.min(35, cross / Math.max(60, L) * 12));
            course = (legRc.course + corr + 360) % 360;
            autopilot.xt = cross;
            // 目標までの針路と大きく違うとき（線の外から来た）は目標へ向かう
            const dd = Math.abs(((course - rc.course + 540) % 360) - 180);
            if (dd > 60) course = rc.course;
        }
    }
    // 最後の点のすぐ近く・行き過ぎたあとは、区間の針路を保ったまま止まる（点を追って舵を振り回さない）
    if (wp.final && (autopilot.overshoot || rc.dist < reach * 2)) course = legRc.course;
    autopilot.course = course;
    autopilot.wpDist = rc.dist;
    // 速さ：沖で減速、航路は微速
    let remain = rc.dist;
    for (let k = autopilot.leg; k < R.length - 1; k++) remain += rhumbCourse(R[k].lat, R[k].lon, R[k + 1].lat, R[k + 1].lon).dist;
    autopilot.remain = remain;
    let order = AP_SPEEDS[autopilot.cruise];
    if (wp.channel || R.slice(autopilot.leg).every(w => w.channel)) order = Math.min(order, 1);
    else if (remain < 5 * 1852) order = Math.min(order, 2);
    if (wp.final && autopilot.finalSlow) order = Math.min(order, 1);
    // 最後の点の手前が短い区間の連なり（港の口など）のときは、最後の区間に入る前から、残りの道のりで止め始める
    if (!wp.final && R[R.length - 1].final) {
        const vv = Math.max(0, physics.speed || 0), dAll = vv * Math.max(0.05, physics.mass || 1) / 0.3;
        if (remain < Math.max(2000, dAll * 3)) order = Math.min(order, 1);
        if (remain < dAll * 1.2) order = Math.min(order, 0);
    }
    if (finalOrder !== null) order = Math.min(order, finalOrder);
    // 狭い水路・浅い水道（航路の点の narrow）：手前でタグを呼び、持ち場に着くまで待って、
    // 付き添ってもらいながら微速（タグが力を出せる 4 くらいまで）で通る。抜けたら帰す
    let escorting = false;
    if (!apUseTugs('narrow') && !tugEscort.manual) {
        // タグを使わない：狭い水路は微速で
        if (wp.narrow) order = Math.min(order, 1);
        if (tugEscort.active || tugEscort.held) tugEscortStop();
        autopilot.escort = '';
    } else if (typeof tugEscortStart === 'function') {
        const narrowNow = !!wp.narrow || !!tugEscort.manual;           // 手で付き添いを頼んでいる間も（50-harbor-auto.js）
        let narrowAhead = Infinity;
        if (!narrowNow) {
            let d = rc.dist;
            for (let k = autopilot.leg + 1; k < R.length && d < 30000; k++) {
                if (R[k].narrow) { narrowAhead = d; break; }
                d += rhumbCourse(R[k - 1].lat, R[k - 1].lon, R[k].lat, R[k].lon).dist;
            }
        }
        const v = Math.max(0, physics.speed || 0);
        const dStop = v * Math.max(0.05, physics.mass || 1) / 0.3;
        const callDist = Math.max(3000, dStop * 2 + 1500);
        if (narrowNow || narrowAhead < callDist) {
            if (tugEscort.active && !tugEscortAlive()) tugEscort.active = false;     // いなくなったら呼び直す
            if (!tugEscort.active) tugEscortStart();
            // 一度そろったら、途中でタグが付き直している間も止まらない（その間は付いているタグだけで助ける）
            if (tugEscortReady()) tugEscort.readyOnce = true;
            const ready = tugEscortReady() || !!tugEscort.readyOnce;
            tugEscort.t = ready ? 0 : tugEscort.t + dt;
            if (tugEscort.t > 900) { autopilotStop('タグが持ち場に着けないので、狭い水路の手前で自動航行を止めました'); return; }
            // 速さ：タグが効く速さまで
            const cap = v > 4.5 ? 0 : v < 3.5 ? 1 : (autopilot.lastOrder === 0 ? 0 : 1);
            order = Math.min(order, cap);
            if (!ready && (narrowNow || narrowAhead < dStop * 1.2 + 300)) {
                order = Math.min(order, 0);
                if (v > 0.5 && (narrowNow || narrowAhead < dStop * 0.8)) order = -1;
                autopilot.escort = 'wait';
            } else autopilot.escort = narrowNow ? 'on' : 'ahead';
            escorting = narrowNow && ready;
        } else {
            if (!tugEscort.manual && (tugEscort.active || tugEscort.held)) tugEscortStop();
            autopilot.escort = '';
        }
    }
    _apOrder(order);
    // 舵：針路のずれ（物理の向き）と回る速さで
    const want = _apHeadingForTrue(course);
    const e = ((want - physics.heading + 540) % 360) - 180;          // +：heading を増やしたい（舵は −）
    if (escorting) tugEscortAssist(-(autopilot.xt || 0), e, dt);        // xt ＋：線の左（左舷側）にいる → 右舷（−x）へ
    const big = Math.abs(e) > 25;
    const cmd = -(e * 1.2) + (physics.turnRate || 0) * 6;
    _apHelm(Math.max(big ? -35 : -20, Math.min(big ? 35 : 20, cmd)), dt);
}
window.updateAutopilot = updateAutopilot;

// ── 原点を船の所へ移す（遠くまで航海したとき）──
function worldRebase() {
    const ll = worldShipLatLon();
    const trueC = worldTrueCompass();
    const ox = physics.cgWorldX || 0, oz = physics.cgWorldZ || 0;
    world.ref = { lat: ll.lat, lon: ll.lon };
    _wFrameCache = null;
    physics.cgWorldX = 0; physics.cgWorldZ = 0;
    const oldH = physics.heading;
    physics.heading = _apHeadingForTrue(trueC);                    // 真の針路はそのまま
    const dH = (physics.heading - oldH) * _apRad;
    // カメラ・見ている点も一緒にずらす
    const shift = new THREE.Vector3(-ox, 0, -oz);
    if (typeof camera !== 'undefined') camera.position.add(shift);
    if (typeof controls !== 'undefined' && controls.target) controls.target.add(shift);
    if (window.lastShipPos) window.lastShipPos.add(shift);
    if (Number.isFinite(window.lastChaseHeadingRot)) window.lastChaseHeadingRot += dH;
    if (typeof shipHistory !== 'undefined') shipHistory.length = 0;
    if (window.tugs) for (const tg of tugs) { tg.pos.add(shift); tg.g.position.add(shift); tg.path = null; }
    if (window._tugCrumbs) for (const c of _tugCrumbs) { c.x += shift.x; c.z += shift.z; }
    if (typeof subTorpShift === 'function') subTorpShift(shift, dH);
    if (typeof navalShift === 'function') navalShift(shift);
    if (typeof maneuverShift === 'function') maneuverShift(shift, dH);
    if (typeof _tugShip !== 'undefined') { _tugShip.lastX = null; }
    if (typeof worldTerrainModeChanged === 'function') worldTerrainModeChanged(true);
    if (typeof _worldSave === 'function') _worldSave();
}
window.worldRebase = worldRebase;

// ── 画面：ミニマップの下の小さな表示 ──
function _apEnsureDom() {
    if (document.getElementById('ap-panel')) return;
    const el = document.createElement('div');
    el.id = 'ap-panel';
    document.body.appendChild(el);
}
function _apFmtDist(m) { const nm = m / 1852; return nm < 10 ? nm.toFixed(1) + ' NM' : Math.round(nm) + ' NM'; }
function renderAutopilotPanel() {
    _apEnsureDom();
    const el = document.getElementById('ap-panel');
    const ha = typeof harborAuto !== 'undefined' ? harborAuto : null;
    const show = world.mode === 'world' && (autopilot.active || autopilot.planning || autopilot.pendingDepart || autopilot.selfDepart || autopilot.msg || autopilot.resume || (ha && (ha.mode || ha.msg || ha.resume)));
    el.classList.toggle('open', !!show);
    el.classList.toggle('folded', !!autopilot.folded);
    if (!show) return;
    const fold = `<button class="ap-fold" title="${autopilot.folded ? 'ひらく' : '小さくたたむ'}" onclick="autopilotFold(${!autopilot.folded})">${autopilot.folded ? '＋' : '－'}</button>`;
    // 小さくたたんだとき：1行だけ
    if (autopilot.folded) {
        let line;
        if (ha && ha.mode) line = `⚓ ${ha.mode === 'berth' ? '自動着岸' : '自動離岸'}中`;
        else if (autopilot.active && autopilot.escort === 'wait') line = '🚢 タグを待っています';
        else if (autopilot.active) line = `${autopilot.escort === 'on' ? '🚢' : '🧭'} ${autopilot.dest ? autopilot.dest.name : ''}　${Math.round(autopilot.course || 0).toString().padStart(3, '0')}°・残り ${_apFmtDist(autopilot.remain || 0)}`;
        else if (autopilot.planning) line = '🧭 航路を計算しています…';
        else if (autopilot.resume || (ha && ha.resume)) line = '⏸ 止まっています';
        else line = autopilot.msg || (ha && ha.msg) || '';
        // 決めることが待っているとき（出港の用意・止まっている）は、たたんでいてもボタンを出す
        //（以前は 1 行の説明だけで、「今すぐ出港」「再開」などのボタンが出なかった）
        const acts = [];
        if (!autopilot.active && !(ha && ha.mode)) {
            if (autopilot.planning) acts.push('<button onclick="autopilotStop(\'\')">やめる</button>');
            else if (autopilot.pendingDepart) {
                line = `⚓ ${autopilot.pendingDepart.name || ''} へ：STAND BY で出港`;
                acts.push('<button class="on" onclick="autopilotDepartNow()">▶ 今すぐ出港</button>', '<button onclick="autopilotCancelDepart()">やめる</button>');
            } else {
                if (autopilot.resume) acts.push('<button class="on" onclick="autopilotResume()">▶ 再開</button>');
                if (ha && ha.resume) acts.push(`<button class="on" onclick="harborAutoResume()">▶ ${ha.resume.mode === 'berth' ? '着岸' : '離岸'}を再開</button>`);
            }
        }
        uiSetHTML(el, `<div class="ap-line">${fold}<span>${line}</span></div>${acts.length ? `<div class="ap-row">${acts.join('')}</div>` : ''}`);
        return;
    }
    if (ha && ha.mode) {
        const ph = { tugs: 'タグを待っています', turn: '回しています', side: '岸壁へ寄せています', off: '岸壁から離しています' }[ha.phase] || '';
        uiSetHTML(el, `<div class="ap-title">${fold}⚓ ${ha.mode === 'berth' ? '自動着岸' : '自動離岸'}：${ha.plan.port.name}</div>
            <div class="ap-row">${ph}${ha.phase === 'side' && ha.remain !== undefined ? `（あと ${ha.remain.toFixed(1)} m）` : ''}</div>
            <div class="ap-row"><button class="ap-off" onclick="harborAutoStop('自動の離着岸を止めました')">止める</button></div>`);
        return;
    }
    if (!autopilot.active) {
        const msg = autopilot.msg || (ha && ha.msg) || '';
        const btns = [];
        if (autopilot.planning) btns.push('<button onclick="autopilotStop(\'\')">やめる</button>');
        else if (autopilot.pendingDepart) {
            btns.push('<button class="on" onclick="autopilotDepartNow()">▶ 今すぐ出港</button>');
            btns.push('<button onclick="autopilotCancelDepart()">やめる</button>');
        } else {
            if (autopilot.resume) btns.push(`<button class="on" onclick="autopilotResume()">▶ 再開（${autopilot.resume.dest.name}へ）</button>`);
            if (ha && ha.resume) btns.push(`<button class="on" onclick="harborAutoResume()">▶ ${ha.resume.mode === 'berth' ? '着岸' : '離岸'}を再開</button>`);
            btns.push('<button onclick="autopilotDismiss()">閉じる</button>');
        }
        uiSetHTML(el, `<div class="ap-title">${fold}🧭 自動航行</div><div class="ap-msg">${msg}</div><div class="ap-row">${btns.join('')}</div>${autopilot.pendingDepart ? apTugOptHTML() : ''}`);
        return;
    }
    const R = autopilot.route, wp = R[autopilot.leg];
    // 船が画面の中で実際に進む速さ（物理の速さの値 × 早送り の m/s）から、実時間であと何分か
    const v = Math.abs(physics.speed || 0) * (typeof physicsSpeed !== 'undefined' ? physicsSpeed : 1);
    const eta = v > 0.3 ? autopilot.remain / v / 3600 : null;
    const etaS = eta === null ? '—' : eta < 1 ? Math.round(eta * 60) + '分' : Math.floor(eta) + '時間' + Math.round((eta % 1) * 60) + '分';
    uiSetHTML(el, `
        <div class="ap-title">${fold}🧭 自動航行 → ${autopilot.dest ? autopilot.dest.name : ''}</div>
        <div class="ap-row">針路 <b>${Math.round(autopilot.course || 0).toString().padStart(3, '0')}°</b>（航程線）</div>
        <div class="ap-row">次：${wp.label} ${_apFmtDist(autopilot.wpDist || 0)}</div>
        <div class="ap-row">残り ${_apFmtDist(autopilot.remain || 0)}・${R.length - autopilot.leg} 区間・着くまで ${etaS}</div>
        ${autopilot.note ? `<div class="ap-row ap-msg">${autopilot.note}</div>` : ''}
        ${autopilot.escort ? `<div class="ap-row ap-escort">🚢 ${{ wait: 'タグを待っています（狭い水路の手前）', ahead: 'この先は狭い水路：タグが付き添います', on: 'タグの付き添いで狭い水路を微速で通っています' }[autopilot.escort]}</div>` : ''}
        <div class="ap-row">${Object.entries({ full: '全速', half: '半速', slow: '微速' }).map(([k, l]) => `<button class="${autopilot.cruise === k ? 'on' : ''}" onclick="autopilotSetCruise('${k}')">${l}</button>`).join('')}
            <button class="ap-off" onclick="autopilotStop('自動航行を切りました')">解除</button></div>
        ${autopilot.dest && autopilot.dest.point ? '' : `<div class="ap-row"><label><input type="checkbox" ${autopilot.berth ? 'checked' : ''} onchange="autopilotSetBerth(this.checked)"> 着いたらタグで岸壁に着岸</label> <select onchange="harborSetSidePref(this.value)" title="岸壁に付ける舷">${[['auto', '舷：自動'], ['port', '左舷付け'], ['starboard', '右舷付け']].map(([k, l]) => `<option value="${k}"${(harborAuto.sidePref || 'auto') === k ? ' selected' : ''}>${l}</option>`).join('')}</select>${autopilot.berthPlan ? '' : (autopilot.berth && autopilot.berthWhy ? `<div class="ap-msg">${autopilot.berthWhy}</div>` : '')}</div>`}
        ${apTugOptHTML()}
        ${autopilot.msg ? `<div class="ap-msg">${autopilot.msg}</div>` : ''}`);
}
window.renderAutopilotPanel = renderAutopilotPanel;
setInterval(() => {
    const el = document.getElementById('ap-panel');
    if (el) {
        const mm = document.getElementById('minimap');
        const tp = document.getElementById('telemetry-panel');
        let top = 0;
        if (mm && !mm.classList.contains('hidden') && !mm.classList.contains('off')) top = mm.getBoundingClientRect().bottom + 38;
        else if (tp) top = tp.getBoundingClientRect().bottom + 8;
        el.style.top = Math.round(top) + 'px';
    }
    if (autopilot.active || autopilot.planning || (typeof harborAuto !== 'undefined' && harborAuto.mode)) renderAutopilotPanel();
}, 500);

// 地図に描く航路（緯度・経度の列。航程線は細かく分けて）
function autopilotRoutePoints() {
    if (!autopilot.route) return null;
    const out = [];
    const R = [autopilot.legFrom || worldShipLatLon(), ...autopilot.route];
    for (let k = autopilot.leg; k < R.length - 1; k++) {
        const A = R[k], B = R[k + 1];
        const ya = _apMercY(A.lat), yb = _apMercY(B.lat), dl = _apDLon(A.lon, B.lon);
        const n = Math.max(1, Math.ceil(Math.hypot(dl, B.lat - A.lat) / 0.5));
        for (let q = 0; q <= n; q++) {
            const u = q / n;
            out.push({ lat: (2 * Math.atan(Math.exp(ya + (yb - ya) * u)) - Math.PI / 2) / _apRad, lon: A.lon + dl * u, wp: q === n, narrow: !!B.narrow && q > 0 });
        }
    }
    return out;
}
window.autopilotRoutePoints = autopilotRoutePoints;
