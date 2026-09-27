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
const autopilot = { active: false, planning: false, route: null, leg: 0, dest: null, cruise: 'full', msg: '', lastOrder: null, phase: '' };
window.autopilot = autopilot;

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
        const WORLD_R = ${WORLD_R};
        ${_wNoise3.toString()}
        ${worldNoiseE.toString()}
        ${worldHeightFromE.toString()}
        ${worldShoal.toString()}
        ${worldHeightAt.toString()}
        const RAD = Math.PI / 180;
        function unit(lat, lon) { const a = lat * RAD, b = lon * RAD; return [Math.cos(a) * Math.cos(b), Math.sin(a), Math.cos(a) * Math.sin(b)]; }
        function mercY(lat) { const f = Math.max(-89.5, Math.min(89.5, lat)) * RAD; return Math.log(Math.tan(Math.PI / 4 + f / 2)); }
        function latOfY(y) { return (2 * Math.atan(Math.exp(y)) - Math.PI / 2) / RAD; }
        // 格子：緯度・経度の四角（lon は連続させた値）。cost 0 は通れない
        function makeGrid(lat0, lat1, lon0, lon1, cellDeg, fine, draft) {
            const nx = Math.max(2, Math.ceil((lon1 - lon0) / cellDeg)), ny = Math.max(2, Math.ceil((lat1 - lat0) / cellDeg));
            const cost = new Float32Array(nx * ny);
            for (let j = 0; j < ny; j++) {
                const lat = lat0 + (j + 0.5) * cellDeg;
                for (let i = 0; i < nx; i++) {
                    const u = unit(lat, lon0 + (i + 0.5) * cellDeg);
                    let c;
                    if (fine) {
                        const h = worldHeightAt(u[0], u[1], u[2], 14), d = -h;
                        c = d < draft + 4 ? 0 : d < draft + 15 ? 4 : d < 60 ? 1.6 : 1;
                    } else {
                        const h = worldHeightFromE(worldNoiseE(u[0], u[1], u[2], 10));
                        c = h > -20 ? 0 : h > -60 ? 6 : h > -140 ? 2 : 1;
                    }
                    cost[j * nx + i] = c;
                }
            }
            return { lat0, lon0, cellDeg, nx, ny, cost };
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
        function fineGrid(c, draft) {
            const dLat = ${AP_FINE_R} / WORLD_R / RAD, dLon = dLat / Math.max(0.2, Math.cos(c.lat * RAD));
            const cell = ${AP_FINE_CELL} / WORLD_R / RAD;
            return makeGrid(c.lat - dLat, c.lat + dLat, c.lon - dLon, c.lon + dLon, cell, true, draft);
        }
        onmessage = (ev) => {
            const q = ev.data;
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
                    const pts = simplify(G, [A, ...path.map(([i, j]) => llOf(G, i, j)), B]);
                    postMessage({ id: q.id, ok: true, pts });
                    return;
                }
                // 出発点のまわり：細かい格子で、縁のうち目的地に一番近づける所まで
                const escape = (P, T) => {
                    const G = fineGrid(P, q.draft);
                    const s = nearestOpen(G, ...cellOf(G, P.lat, P.lon), 8);
                    if (!s) throw new Error('blocked');
                    const [ti, tj] = cellOf(G, T.lat, T.lon);
                    const cl = Math.cos(P.lat * RAD);
                    const path = astar(G, s[0], s[1], (i, j) => i === 0 || j === 0 || i === G.nx - 1 || j === G.ny - 1, (i, j) => Math.hypot((i - ti) * cl, j - tj) * 0.999);
                    if (!path) throw new Error('trapped');
                    return { G, pts: simplify(G, [P, ...path.map(([i, j]) => llOf(G, i, j))]) };
                };
                const S = escape(A, B), E = escape(B, A);
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
                const pts = [...S.pts, ...mid.slice(1, -1), ...E.pts.slice().reverse()];
                postMessage({ id: q.id, ok: true, pts });
            } catch (err) {
                postMessage({ id: q.id, ok: false, err: String(err && err.message || err) });
            }
        };`;
    _apWorkerObj = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    return _apWorkerObj;
}
let _apReq = 0;
function worldPlanRoute(from, to) {
    const id = ++_apReq;
    const draft = (typeof worldShipDraft === 'function') ? worldShipDraft() : 8;
    return new Promise((resolve, reject) => {
        const w = _apWorker();
        const on = (ev) => {
            if (ev.data.id !== id) return;
            w.removeEventListener('message', on);
            if (ev.data.ok) resolve(ev.data.pts.map(p => ({ lat: p.lat, lon: ((p.lon + 540) % 360) - 180 })));
            else reject(new Error(ev.data.err));
        };
        w.addEventListener('message', on);
        w.postMessage({ id, from, to, draft });
    });
}
window.worldPlanRoute = worldPlanRoute;

// ── 始める・やめる ──
function _apMsg(s) { autopilot.msg = s; renderAutopilotPanel(); }
async function autopilotStart(port) {
    if (!port || world.mode !== 'world') return;
    autopilotStop('', true);
    autopilot.planning = true; autopilot.dest = port;
    _apMsg(`${port.name} への航路を計算しています…`);
    const T = PORT_TYPES[port.type];
    const hp = window.hullProfile;
    const halfLen = ((hp && hp.ready) ? hp.halfLen : 6) * (physics.scale || 1);
    const here = worldShipLatLon();
    const route = [];
    // 今いる港の航路の上なら、まず航路を沖へ出る
    const np = worldNearestPort(here.lat, here.lon);
    if (np && np.port !== port) {
        const P = np.port, TP = PORT_TYPES[P.type], chL = worldPortChannelLen(P);
        if (np.dist < TP.basin + chL + 1500) {
            route.push(Object.assign(portChannelPoint(P, TP.basin + chL - 200), { label: `${P.name} 航路の出口`, channel: true }));
        }
    }
    const chLen = worldPortChannelLen(port);
    const outer = portChannelPoint(port, T.basin + chLen + 1500);     // 目的の港の航路の沖
    const gate = portChannelPoint(port, T.basin + chLen - 200);        // 航路の入口
    const draft = (typeof worldShipDraft === 'function') ? worldShipDraft() : 8;
    let stopA = Math.min(Math.max(T.basin * 0.5, T.basin * 0.76 + halfLen + 100), T.basin + chLen - 400);
    // 港や航路より深い船は、船の端から端まで深さが足りる沖で止まる
    let deepShip = false;
    if (draft + 3 > T.depth + 2) {
        deepShip = true;
        const depthAt = (a) => { const q = portChannelPoint(port, a), u = worldLatLonToUnit(q.lat, q.lon); return -worldHeightAt(u.x, u.y, u.z, 16); };
        for (let a = T.basin * 0.76 + halfLen + 60; a < T.basin + chLen + 15000; a += 100) {
            stopA = a;
            if (depthAt(a - halfLen) > draft + 3 && depthAt(a) > draft + 3 && depthAt(a + halfLen) > draft + 3) break;
        }
    }
    const stop = portChannelPoint(port, stopA);
    autopilot.deepShip = deepShip;
    const from = route.length ? route[route.length - 1] : here;
    try {
        const pts = await worldPlanRoute(from, outer);
        if (autopilot.dest !== port || !autopilot.planning) return;      // 途中でやめた
        for (const p of pts.slice(1)) route.push({ lat: p.lat, lon: p.lon, label: '' });
        route[route.length - 1].label = `${port.name} 沖`;
        if (!deepShip) {
            route.push(Object.assign(gate, { label: `${port.name} 航路の入口`, channel: true }));
            route.push(Object.assign(stop, { label: `${port.name} 港口`, channel: true, final: true }));
        } else {
            // 止まる所が航路の中なら航路の入口を通ってから
            if (stopA < T.basin + chLen - 200) route.push(Object.assign(gate, { label: `${port.name} 航路の入口`, channel: true }));
            route.push(Object.assign(stop, { label: `${port.name} 沖の錨地`, channel: stopA < T.basin + chLen, final: true }));
        }
    } catch (e) {
        autopilot.planning = false; autopilot.dest = null;
        const why = /ocean|blocked|trapped/.test(e.message) ? '海とつながった航路がありません。湖の港か、とても狭い水路の奥の港かもしれません' : e.message;
        _apMsg(`${port.name} への航路が見つかりませんでした（${why}）`);
        return;
    }
    route.forEach((w, i) => { if (!w.label) w.label = `変針点 ${i + 1}`; });
    autopilot.route = route; autopilot.leg = 0; autopilot.planning = false; autopilot.active = true;
    autopilot.legFrom = worldShipLatLon(); autopilot.lastOrder = null; autopilot.overshoot = false;
    _apMsg('');
    if (typeof worldMapRedraw === 'function') worldMapRedraw(true);
}
function autopilotStop(msg, silent) {
    const was = autopilot.active;
    autopilot.active = false; autopilot.planning = false;
    if (!silent) { autopilot.route = null; autopilot.dest = null; }
    if (typeof _br !== 'undefined') _br.autoHelm = false;
    if (msg !== undefined) _apMsg(msg || '');
    if (was && typeof worldMapRedraw === 'function') worldMapRedraw(true);
}
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

// ── 毎フレーム ──
function updateAutopilot(t, dt) {
    if (!window.world || world.mode !== 'world') { if (autopilot.active) autopilotStop('世界を航海するモードではないので、自動航行を止めました'); return; }
    // 原点が遠くなったら移す
    if (Math.hypot(physics.cgWorldX || 0, physics.cgWorldZ || 0) > AP_REBASE_DIST) worldRebase();
    if (!autopilot.active || !autopilot.route) return;
    if (typeof isDesignMode !== 'undefined' && isDesignMode) return;
    dt = Math.min(0.1, Math.max(0, dt || 0));
    // 手で舵を取ったら切る
    if ((typeof keys !== 'undefined' && (keys.a || keys.d)) || (typeof _br !== 'undefined' && _br.wheelDrag)) { autopilotStop('手で舵を取ったので、自動航行を切りました'); return; }
    if (window.terrain && terrain.grounded) { _apOrder(0); autopilotStop('座礁したので、自動航行を止めました'); return; }
    const R = autopilot.route;
    const here = worldShipLatLon();
    let wp = R[autopilot.leg];
    let rc = rhumbCourse(here.lat, here.lon, wp.lat, wp.lon);
    // 変針点に着いた（近い、または通り過ぎた）ら次へ
    const hp = window.hullProfile;
    const L = ((hp && hp.ready) ? hp.halfLen * 2 : 12) * (physics.scale || 1);
    const reach = wp.final ? Math.max(60, L * 0.5) : wp.channel ? Math.max(150, L) : Math.max(900, L * 4);
    const prev = autopilot.leg > 0 ? R[autopilot.leg - 1] : autopilot.legFrom;
    let passed = false;
    if (prev && !wp.final) {
        const leg = rhumbCourse(prev.lat, prev.lon, wp.lat, wp.lon);
        const diff = Math.abs(((rc.course - leg.course + 540) % 360) - 180);
        passed = diff > 100 && rc.dist < leg.dist;     // 目標が後ろになった
    }
    // 最後の区間：止まるまでに進む距離（機関を止めると速さは 0.3/排水量 の割合で落ちる）を見て、
    // 早めに機関停止、足りなければ後進微速。止まりかけたら到着
    let finalOrder = null;
    if (wp.final) {
        const k = 0.3 / Math.max(0.05, physics.mass || 1);
        const v = Math.max(0, physics.speed || 0);
        const dStop = v / k;
        const near = rc.dist < Math.max(reach, dStop * 0.6);
        if (rc.dist < dStop * 1.15) finalOrder = 0;
        if ((rc.dist < dStop * 0.6 || autopilot.overshoot) && v > 0.5) finalOrder = v > 2.5 ? -2 : -1;
        if (rc.dist < reach) autopilot.overshoot = true;            // 行き過ぎても、止まるまで後進
        // 止まったら到着（止まる前に港口を過ぎたら、後進で止まってから）
        if (v < 0.5 && (near || autopilot.overshoot)) rc.dist = 0;
        else if (rc.dist < reach) rc.dist = reach + 1;
    }
    if (rc.dist < reach || passed) {
        if (wp.final) {
            _apOrder(0);
            const nm = autopilot.dest ? autopilot.dest.name : '';
            autopilotStop(autopilot.deepShip ? `${nm} は船に対して浅いので、沖（水深 ${Math.round(terrain.depth || 0)}m）で止まりました。機関停止` : `${nm} の港口に着きました。機関停止`);
            autopilot.route = null; return;
        }
        autopilot.leg++;
        wp = R[autopilot.leg];
        rc = rhumbCourse(here.lat, here.lon, wp.lat, wp.lon);
    }
    // 針路：短い区間は線からのずれも直す（物理の面で）
    const from = autopilot.leg > 0 ? R[autopilot.leg - 1] : autopilot.legFrom;
    let course = rc.course;
    const legRc = rhumbCourse(from.lat, from.lon, wp.lat, wp.lon);
    if (legRc.dist < 30000) {
        const a = worldUnitToLocal(worldLatLonToUnit(from.lat, from.lon)), b = worldUnitToLocal(worldLatLonToUnit(wp.lat, wp.lon));
        const lx = b.x - a.x, lz = b.z - a.z, ll = Math.hypot(lx, lz);
        if (ll > 1) {
            // 物理の面の +x は西。右（東）へのずれを正にする
            const px = (physics.cgWorldX || 0) - a.x, pz = (physics.cgWorldZ || 0) - a.z;
            const cross = (px * lz - pz * lx) / ll;       // 線の進む向きに対して +x 側（西寄り…＝左）へのずれ
            // 線の針路から、ずれを戻す向きへ最大 35° 振る
            const corr = Math.max(-35, Math.min(35, cross / Math.max(60, L) * 12));
            course = (legRc.course + corr + 360) % 360;
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
    if (finalOrder !== null) order = Math.min(order, finalOrder);
    _apOrder(order);
    // 舵：針路のずれ（物理の向き）と回る速さで
    const want = _apHeadingForTrue(course);
    const e = ((want - physics.heading + 540) % 360) - 180;          // +：heading を増やしたい（舵は −）
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
    if (window.tugs) for (const tg of tugs) { tg.pos.add(shift); tg.g.position.add(shift); }
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
    const show = world.mode === 'world' && (autopilot.active || autopilot.planning || autopilot.msg);
    el.classList.toggle('open', !!show);
    if (!show) return;
    if (!autopilot.active) {
        el.innerHTML = `<div class="ap-msg">${autopilot.msg || ''}</div>` + (autopilot.planning ? '<button onclick="autopilotStop(\'\')">やめる</button>' : '<button onclick="autopilotStop(\'\')">閉じる</button>');
        return;
    }
    const R = autopilot.route, wp = R[autopilot.leg];
    // 船が画面の中で実際に進む速さ（物理の速さの値 × 早送り の m/s）から、実時間であと何分か
    const v = Math.abs(physics.speed || 0) * (typeof physicsSpeed !== 'undefined' ? physicsSpeed : 1);
    const eta = v > 0.3 ? autopilot.remain / v / 3600 : null;
    const etaS = eta === null ? '—' : eta < 1 ? Math.round(eta * 60) + '分' : Math.floor(eta) + '時間' + Math.round((eta % 1) * 60) + '分';
    el.innerHTML = `
        <div class="ap-title">🧭 自動航行 → ${autopilot.dest ? autopilot.dest.name : ''}</div>
        <div class="ap-row">針路 <b>${Math.round(autopilot.course || 0).toString().padStart(3, '0')}°</b>（航程線）</div>
        <div class="ap-row">次：${wp.label} ${_apFmtDist(autopilot.wpDist || 0)}</div>
        <div class="ap-row">残り ${_apFmtDist(autopilot.remain || 0)}・${R.length - autopilot.leg} 区間・着くまで ${etaS}</div>
        <div class="ap-row">${Object.entries({ full: '全速', half: '半速', slow: '微速' }).map(([k, l]) => `<button class="${autopilot.cruise === k ? 'on' : ''}" onclick="autopilotSetCruise('${k}')">${l}</button>`).join('')}
            <button class="ap-off" onclick="autopilotStop('自動航行を切りました')">解除</button></div>
        ${autopilot.msg ? `<div class="ap-msg">${autopilot.msg}</div>` : ''}`;
}
window.renderAutopilotPanel = renderAutopilotPanel;
setInterval(() => {
    const el = document.getElementById('ap-panel');
    if (el) {
        const mm = document.getElementById('minimap');
        const tp = document.getElementById('telemetry-panel');
        let top = 0;
        if (mm && !mm.classList.contains('hidden') && !mm.classList.contains('off')) top = mm.getBoundingClientRect().bottom + 22;
        else if (tp) top = tp.getBoundingClientRect().bottom + 8;
        el.style.top = Math.round(top) + 'px';
    }
    if (autopilot.active || autopilot.planning) renderAutopilotPanel();
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
            out.push({ lat: (2 * Math.atan(Math.exp(ya + (yb - ya) * u)) - Math.PI / 2) / _apRad, lon: A.lon + dl * u, wp: q === n });
        }
    }
    return out;
}
window.autopilotRoutePoints = autopilotRoutePoints;
