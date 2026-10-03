// 22-hull-shape.js — 船体形状（船首・船尾を含む喫水線輪郭）の取得と参照
//
// ════════════════════════════════════════════════════════════════
//  なぜ作り直したか
// ════════════════════════════════════════════════════════════════
//  従来（v109〜v165）の船体形状は「along位置 → 半幅」という1枚のテーブルで
//  表現されていた。このテーブルのalong格子はモデル全体のAABBに固定されており、
//  どの高さでも同じ格子を使う。ところが実際の船は、
//
//    ・船首材にレーキ（傾斜）がある  → 喫水線の前端は、高いところほど前に出る
//    ・カウンタースターンの張り出し  → 喫水線の後端も、高さによって前後に動く
//
//  ため、「喫水線の前端・後端の位置そのものが高さの関数」である。固定格子の
//  半幅テーブルではこれを原理的に表現できない。Olympicのようにレーキした
//  船首と張り出したカウンタースターンを併せ持つ船で、船首尾の形が出ない
//  根本原因はここにあった。実測（RMS Olympicの実メッシュ、全長を31.3とする
//  モデル座標系）では、喫水線の前端は設計喫水の前後わずか0.7の高さ差で
//  13.51→14.60（差1.09＝全長の3.5%）動き、キールから甲板までで見ると
//  11.30→14.80（差3.5＝全長の11%）動く。後端も同様に -14.02→-16.45 と動く。
//
//  従来コードはこれを、船首尾専用の別データ（bowTipWidth / bowTipAlongNorm /
//  bowTipHeightProfile / bowTipAlongProfile / bowFinePoints …と船尾側の同等品）
//  を8種類ほど並列に持ち、それぞれ独自のフォールバックで埋める、という形で
//  回避しようとしていた。各々が別の近似なので互いに食い違い、船型によって
//  どれかが必ず破綻する。
//
// ════════════════════════════════════════════════════════════════
//  新しい表現
// ════════════════════════════════════════════════════════════════
//  高さレベルごとに「その高さでの喫水線輪郭」を実測し、**その輪郭自身の
//  前端・後端で正規化した**半幅プロファイルとして保持する。
//
//    levelY[k]      : k番目の高さ
//    sternAlong[k]  : その高さでの輪郭の後端（along座標）
//    bowAlong[k]    : その高さでの輪郭の前端（along座標）
//    hw[k][i]       : station i（正規化位置 t[i]）での半幅
//
//  station位置 t[i] はコサイン配置（両端ほど密）にする。船型の曲率は船首尾で
//  最大、平行中央部でほぼ0なので、等間隔よりはるかに効率がよい。
//  実測（Olympic）: 等間隔24点 → コサイン48点で、船首15%区間のRMS誤差が
//  0.010 → 0.002（約5分の1）、最大誤差 0.09 → 0.02 に改善。
//
//  実行時は「今この瞬間の水面高さ」で levelY を挟む2レベルを補間するだけ。
//  前端・後端も一緒に補間されるので、レーキも張り出しも自然に再現される。
//  船首尾専用の特別扱いは一切不要になった。
//
// ════════════════════════════════════════════════════════════════
//  座標系
// ════════════════════════════════════════════════════════════════
//  along : 船首尾方向（scanHullProfileのxIsForwardで決まる軸）。値は
//          モデルローカル（physics.scale適用前）の生座標。
//  perp  : 左右方向の中心線からの距離（常に非負＝半幅）。
//  y     : 上下方向。モデルローカルの生座標。

// station数。コサイン配置なので両端が密になる。48でOlympicの船首尾が
// 実用上ほぼ誤差なく再現できることを実測で確認している。
const HULL_SHAPE_STATIONS = 48;
// 高さレベル数。設計喫水付近を厚めにしたいので、レベルYは等間隔ではなく
// buildHullShape内で喫水付近に寄せて配置する。
const HULL_SHAPE_LEVELS = 20;

// ─────────────────────────────────────────
//  三角形群 × 平面y の交線を (along, perp) 線分として返す
//  戻り値: Float64Array [a0,p0, a1,p1,  a0,p0, a1,p1, ...]（8要素で1線分）
//  ※ perpは符号付きのまま返す（左右の判別が要る場面のため）。半幅を取る側で
//    絶対値にする。
// ─────────────────────────────────────────
function hullShapeSliceSegments(triVertsFlat, planeY, xIsForward) {
    const n = triVertsFlat.length / 9;
    const out = [];
    for (let ti = 0; ti < n; ti++) {
        const o = ti * 9;
        const x0=triVertsFlat[o],   y0=triVertsFlat[o+1], z0=triVertsFlat[o+2];
        const x1=triVertsFlat[o+3], y1=triVertsFlat[o+4], z1=triVertsFlat[o+5];
        const x2=triVertsFlat[o+6], y2=triVertsFlat[o+7], z2=triVertsFlat[o+8];
        const d0 = y0 - planeY, d1 = y1 - planeY, d2 = y2 - planeY;
        const s0 = d0 > 0, s1 = d1 > 0, s2 = d2 > 0;
        if (s0 === s1 && s1 === s2) continue; // 3頂点とも同じ側 → 交差しない
        let ax=0, az=0, bx=0, bz=0, found = 0;
        if (s0 !== s1) {
            const t = d0 / (d0 - d1);
            ax = x0 + t*(x1-x0); az = z0 + t*(z1-z0); found = 1;
        }
        if (s1 !== s2 && found < 2) {
            const t = d1 / (d1 - d2);
            if (found === 0) { ax = x1 + t*(x2-x1); az = z1 + t*(z2-z1); found = 1; }
            else             { bx = x1 + t*(x2-x1); bz = z1 + t*(z2-z1); found = 2; }
        }
        if (s2 !== s0 && found < 2) {
            const t = d2 / (d2 - d0);
            if (found === 0) { ax = x2 + t*(x0-x2); az = z2 + t*(z0-z2); found = 1; }
            else             { bx = x2 + t*(x0-x2); bz = z2 + t*(z0-z2); found = 2; }
        }
        if (found !== 2) continue;
        if (xIsForward) out.push(ax, az, bx, bz);
        else            out.push(az, ax, bz, bx);
    }
    return out;
}

// ─────────────────────────────────────────
//  station位置 t[i]（0=後端, 1=前端）。コサイン配置で両端を密にする。
// ─────────────────────────────────────────
function hullShapeStationParams(n) {
    const t = new Float64Array(n);
    for (let i = 0; i < n; i++) t[i] = 0.5 * (1 - Math.cos(Math.PI * i / (n - 1)));
    return t;
}

// ─────────────────────────────────────────
//  1レベル分の輪郭プロファイルを求める
//  segsFlat: hullShapeSliceSegments の戻り値
//  戻り値: { sternAlong, bowAlong, hw: Float64Array(nStations) } または null
//
//  【従来との違い】
//   ・半幅は「そのalong位置を跨ぐ線分のperp最大値」＝断面の外縁そのもの。
//     従来はmicro窓内のサンプルの**中央値**を取っていたが、断面の外縁を
//     求めたいのに中央値を使うのは原理的に誤りで、形状が急変する船首尾ほど
//     半幅を系統的に過小評価していた。
//   ・跨ぐ線分が無いstationは、**両隣の有効な値から線形補間**する。従来は
//     「最も近い線分端点の値をコピー」しており、これが「船体中央部の幅を
//     保ったまま船首尾へ平坦に伸びる」症状（＝船首尾が四角く見える）の
//     直接の原因だった。
//   ・along格子はこの輪郭自身の前端・後端で正規化する。これがレーキ／
//     張り出しを表現できる核心。
//
//  【引数】
//   segsFlat   : 幅のサンプリングに使う線分群（外板＋付属物）。
//   extentSegs : 輪郭の前端・後端（正規化の基準）を決めるのに使う線分群。
//                外板本体だけを渡すこと。スクリュー軸や舵のように船体より
//                後方へ突き出た付属物まで前後端の決定に混ぜると、輪郭が
//                付属物の先まで引き伸ばされ、船尾が細長いくさび形に化ける
//                （この表現は1本の閉じた輪郭なので、離れた細い突起を別パーツ
//                として持てない）。幅のサンプリングには付属物も含めるので、
//                「船体の前後範囲の中で、付属物のぶん外へ膨らむ」という
//                本来の意図どおりの挙動になる。
// ─────────────────────────────────────────
function hullShapeLevelProfile(segsFlat, extentSegs, tParams) {
    const nSeg = segsFlat.length / 4;
    if (nSeg === 0) return null;

    const ext = (extentSegs && extentSegs.length >= 4) ? extentSegs : segsFlat;
    const nExt = ext.length / 4;
    let aMin = Infinity, aMax = -Infinity;
    for (let i = 0; i < nExt; i++) {
        const a0 = ext[i*4], a1 = ext[i*4+2];
        if (a0 < aMin) aMin = a0; if (a0 > aMax) aMax = a0;
        if (a1 < aMin) aMin = a1; if (a1 > aMax) aMax = a1;
    }
    if (!(aMax - aMin > 1e-9)) return null;

    const N = tParams.length;
    const hw = new Float64Array(N);
    const valid = new Uint8Array(N);

    for (let i = 0; i < N; i++) {
        const x = aMin + (aMax - aMin) * tParams[i];
        let best = -1;
        for (let s = 0; s < nSeg; s++) {
            const a0 = segsFlat[s*4], p0 = segsFlat[s*4+1];
            const a1 = segsFlat[s*4+2], p1 = segsFlat[s*4+3];
            const lo = a0 < a1 ? a0 : a1, hi = a0 < a1 ? a1 : a0;
            if (x < lo || x > hi) continue;
            const span = a1 - a0;
            const tt = Math.abs(span) > 1e-12 ? (x - a0) / span : 0;
            const p = Math.abs(p0 + (p1 - p0) * tt);
            if (p > best) best = p;
        }
        if (best >= 0) { hw[i] = best; valid[i] = 1; }
    }

    // 欠損stationを両隣から補間する。端が欠損している場合は、有効な最寄り点から
    // 端（半幅0）へ向けて線形に絞る。船体は前後端で必ず幅0に収束するので、
    // これは形状としても正しい振る舞いになる。
    let firstValid = -1, lastValid = -1;
    for (let i = 0; i < N; i++) if (valid[i]) { if (firstValid < 0) firstValid = i; lastValid = i; }
    if (firstValid < 0) return null;

    for (let i = 0; i < firstValid; i++) {
        hw[i] = hw[firstValid] * (firstValid > 0 ? i / firstValid : 0);
    }
    for (let i = lastValid + 1; i < N; i++) {
        const denom = (N - 1 - lastValid);
        hw[i] = hw[lastValid] * (denom > 0 ? (N - 1 - i) / denom : 0);
    }
    let i0 = firstValid;
    while (i0 < lastValid) {
        let i1 = i0 + 1;
        while (i1 <= lastValid && !valid[i1]) i1++;
        if (i1 > i0 + 1) {
            for (let k = i0 + 1; k < i1; k++) {
                hw[k] = hw[i0] + (hw[i1] - hw[i0]) * ((k - i0) / (i1 - i0));
            }
        }
        i0 = i1;
    }

    return { sternAlong: aMin, bowAlong: aMax, hw };
}

// ─────────────────────────────────────────
//  船体形状を構築する
//    triPools : 三角形フラット配列の配列（船体本体プール＋LENIENT復元プール）。
//               同じ高さで両方の交線をまとめて使う（外縁＝最大値を採る）。
//    xIsForward, yLo, yHi : scanHullProfileが決めた軸と高さレンジ
//    designWaterlineY     : 設計喫水の高さ（レベル配置を喫水付近に寄せるため）
// ─────────────────────────────────────────
function buildHullShape(triPools, xIsForward, yLo, yHi, designWaterlineY) {
    if (!(yHi > yLo)) return null;
    const tParams = hullShapeStationParams(HULL_SHAPE_STATIONS);
    const M = HULL_SHAPE_LEVELS;

    // 高さレベルの配置。喫水線は上下動・ロール・ピッチで動くとはいえ、
    // 実際に水面が来る確率が高いのは設計喫水の周辺なので、そこを密にする。
    // u∈[0,1] を設計喫水の正規化位置 uW を中心にS字で引き寄せる。
    const uW = Math.min(0.9, Math.max(0.1, (designWaterlineY - yLo) / (yHi - yLo)));
    const levelY = new Float64Array(M);
    for (let k = 0; k < M; k++) {
        const u = k / (M - 1);
        // 設計喫水の正規化位置uWへレベルを寄せる単調写像。
        // レベル密度が高いのは ds/du が小さいところ。uWの直下では指数<1、
        // 直上では指数>1 にすると、両側からuWへ向かって密になる。
        // （指数を逆にすると逆にキール側が密になってしまう）
        const s = u < uW
            ? uW * Math.pow(u / Math.max(uW, 1e-6), 0.72)
            : uW + (1 - uW) * Math.pow((u - uW) / Math.max(1 - uW, 1e-6), 1.45);
        levelY[k] = yLo + (yHi - yLo) * s;
    }

    const sternAlong = new Float64Array(M);
    const bowAlong   = new Float64Array(M);
    const hwAll      = new Float64Array(M * HULL_SHAPE_STATIONS);
    const levelOk    = new Uint8Array(M);

    for (let k = 0; k < M; k++) {
        // triPools[0] が外板本体プール。前後端はこれだけで決める（上の
        // hullShapeLevelProfile のコメント参照）。
        let segs = [], extentSegs = null;
        for (let pi = 0; pi < triPools.length; pi++) {
            const pool = triPools[pi];
            if (!pool || pool.length === 0) continue;
            const sg = hullShapeSliceSegments(pool, levelY[k], xIsForward);
            if (!sg.length) continue;
            if (pi === 0) extentSegs = sg;
            segs = segs.length ? segs.concat(sg) : sg;
        }
        const prof = hullShapeLevelProfile(segs, extentSegs, tParams);
        if (!prof) continue;
        levelOk[k] = 1;
        sternAlong[k] = prof.sternAlong;
        bowAlong[k]   = prof.bowAlong;
        hwAll.set(prof.hw, k * HULL_SHAPE_STATIONS);
    }

    // 交差の取れなかったレベル（キール下端より下など）を、有効レベルから埋める。
    // 下側は「最下の有効レベルの形を、幅0へ向けて絞る」、上側は最上の有効レベルを
    // そのまま延長する（甲板より上は水面が来ない前提なので形は問われない）。
    let kFirst = -1, kLast = -1;
    for (let k = 0; k < M; k++) if (levelOk[k]) { if (kFirst < 0) kFirst = k; kLast = k; }
    if (kFirst < 0) return null;

    for (let k = 0; k < kFirst; k++) {
        const f = kFirst > 0 ? k / kFirst : 0;
        const mid = (sternAlong[kFirst] + bowAlong[kFirst]) * 0.5;
        sternAlong[k] = mid + (sternAlong[kFirst] - mid) * f;
        bowAlong[k]   = mid + (bowAlong[kFirst]   - mid) * f;
        for (let i = 0; i < HULL_SHAPE_STATIONS; i++) {
            hwAll[k * HULL_SHAPE_STATIONS + i] = hwAll[kFirst * HULL_SHAPE_STATIONS + i] * f;
        }
    }
    for (let k = kLast + 1; k < M; k++) {
        sternAlong[k] = sternAlong[kLast];
        bowAlong[k]   = bowAlong[kLast];
        for (let i = 0; i < HULL_SHAPE_STATIONS; i++) {
            hwAll[k * HULL_SHAPE_STATIONS + i] = hwAll[kLast * HULL_SHAPE_STATIONS + i];
        }
    }
    for (let k = kFirst + 1; k < kLast; k++) {
        if (levelOk[k]) continue;
        let k1 = k + 1;
        while (k1 <= kLast && !levelOk[k1]) k1++;
        const k0 = k - 1;
        for (let kk = k; kk < k1; kk++) {
            const f = (kk - k0) / (k1 - k0);
            sternAlong[kk] = sternAlong[k0] + (sternAlong[k1] - sternAlong[k0]) * f;
            bowAlong[kk]   = bowAlong[k0]   + (bowAlong[k1]   - bowAlong[k0])   * f;
            for (let i = 0; i < HULL_SHAPE_STATIONS; i++) {
                const a = hwAll[k0 * HULL_SHAPE_STATIONS + i];
                const b = hwAll[k1 * HULL_SHAPE_STATIONS + i];
                hwAll[kk * HULL_SHAPE_STATIONS + i] = a + (b - a) * f;
            }
        }
        k = k1;
    }

    // ─── 船体上端より上のレベルを切り捨てる ───
    // 高さレンジの上端は「船体本体高さの推定値×1.15」という見積もりなので、
    // 甲板より上まで伸びていることがある。そこまで行くと交線が船体外板ではなく
    // 甲板室・煙突・ボート等を拾い始め、輪郭の前後端が突然跳ぶ（実測: Olympicで
    // 船尾端が -16.45 から -9.68 へ、次のレベルで +7.45 へ飛んだ）。
    // 「前後方向の長さが、最大の輪郭に対して極端に短くなったレベル」を船体上端と
    // みなして、それより上は最後の正常なレベルで頭打ちにする。水面がそこまで
    // 来るのは船がほぼ水没したときだけなので、頭打ちで実用上問題ない。
    let maxSpan = 0;
    for (let k = kFirst; k <= kLast; k++) {
        const sp = bowAlong[k] - sternAlong[k];
        if (sp > maxSpan) maxSpan = sp;
    }
    const wlLevel = hullShapeLevelIndexFor(levelY, designWaterlineY);
    // 判定は2つ。実船の外板は高さに対して滑らかに変化するので、
    //  (a) 前後端が隣のレベルから大きく飛んだ  → 別の構造物を拾い始めた
    //  (b) 前後長が極端に短い                  → そもそも外板ではない
    // のどちらかが起きたレベルを船体上端の1つ上とみなす。
    // 甲板室・煙突・ボート等は外板よりずっと短いので (a) で確実に捕まる
    // （実測: Olympicで船尾端が -16.45 → -9.68 と 6.77 飛ぶ。しきい値は
    //  最大全長の8%=2.5なので確実に検出でき、カウンタースターンの正当な
    //  伸び（隣接レベル間で最大0.52）は誤検出しない）。
    const jumpLimit = maxSpan * 0.08;
    let kTop = kLast;
    const kScanFrom = Math.max(wlLevel, kFirst);
    for (let k = kScanFrom + 1; k <= kLast; k++) {
        const jumped = Math.abs(sternAlong[k] - sternAlong[k-1]) > jumpLimit
                    || Math.abs(bowAlong[k]   - bowAlong[k-1])   > jumpLimit;
        const tooShort = (bowAlong[k] - sternAlong[k]) < maxSpan * 0.6;
        if (jumped || tooShort) { kTop = k - 1; break; }
    }
    if (kTop < kScanFrom) kTop = kScanFrom;
    for (let k = kTop + 1; k < M; k++) {
        sternAlong[k] = sternAlong[kTop];
        bowAlong[k]   = bowAlong[kTop];
        for (let i = 0; i < HULL_SHAPE_STATIONS; i++) {
            hwAll[k * HULL_SHAPE_STATIONS + i] = hwAll[kTop * HULL_SHAPE_STATIONS + i];
        }
    }

    return {
        ready: true,
        xIsForward,
        nStations: HULL_SHAPE_STATIONS,
        nLevels: M,
        t: tParams,
        levelY, sternAlong, bowAlong, hw: hwAll,
        designWaterlineY,
        minLevelY: levelY[0], maxLevelY: levelY[M - 1],
        wlLevel, kTop, kFirst,
    };
}

// levelY配列からyを挟む下側インデックスを返す（二分探索）
function hullShapeLevelIndexFor(levelY, y) {
    const M = levelY.length;
    if (y <= levelY[0]) return 0;
    if (y >= levelY[M - 1]) return M - 1;
    let lo = 0, hi = M - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (levelY[mid] <= y) lo = mid; else hi = mid;
    }
    return lo;
}

// ─────────────────────────────────────────
//  実行時クエリ
// ─────────────────────────────────────────
// 高さyでの輪郭の前端・後端（along座標）を補間して返す
function hullShapeEndsAtY(shape, y, out) {
    // 実測できた最下レベル(kFirst)より下は、そのレベルの輪郭で頭打ちにする。
    // yLoはキールより少し下に取ってあるので、その下の「実測できなかった」
    // レベルは中心へ潰した埋め値になっている。そこへ補間しに行くと、
    // キール直上の高さで輪郭の前後端が実際より内側へ引っ張られてしまう
    // （実測: Olympicの Y=-1.30 で船首端が 11.35 → 9.87 と 1.5 も内側に出た）。
    // 水面がキールより下に来るのは船が完全に沈んだ状態なので、頭打ちで問題ない。
    const yMinUsable = shape.levelY[shape.kFirst];
    if (y < yMinUsable) y = yMinUsable;
    const k0 = hullShapeLevelIndexFor(shape.levelY, y);
    const k1 = Math.min(k0 + 1, shape.nLevels - 1);
    const y0 = shape.levelY[k0], y1 = shape.levelY[k1];
    const f = (k1 > k0 && y1 - y0 > 1e-12)
        ? Math.max(0, Math.min(1, (y - y0) / (y1 - y0)))
        : 0;
    out.k0 = k0; out.k1 = k1; out.f = f;
    out.sternAlong = shape.sternAlong[k0] + (shape.sternAlong[k1] - shape.sternAlong[k0]) * f;
    out.bowAlong   = shape.bowAlong[k0]   + (shape.bowAlong[k1]   - shape.bowAlong[k0])   * f;
    return out;
}

// station i における、高さyでの半幅
function hullShapeHalfWidthAtStation(shape, i, k0, k1, f) {
    const a = shape.hw[k0 * shape.nStations + i];
    const b = shape.hw[k1 * shape.nStations + i];
    return a + (b - a) * f;
}

// 正規化位置 u(0=後端, 1=前端) が station配列のどの区間に入るかを求める。
// t[]は単調増加なので二分探索。戻り値は共有オブジェクト（毎フレーム呼ばれるので
// アロケーションを避ける）。
function hullShapeStationSpan(shape, u, out) {
    const t = shape.t;
    const n = shape.nStations;
    if (u <= 0)      { out.lo = 0;     out.hi = 0;     out.tt = 0; return out; }
    if (u >= 1)      { out.lo = n - 1; out.hi = n - 1; out.tt = 0; return out; }
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (t[mid] <= u) lo = mid; else hi = mid;
    }
    const span = t[hi] - t[lo];
    out.lo = lo; out.hi = hi;
    out.tt = span > 1e-12 ? (u - t[lo]) / span : 0;
    return out;
}

// 正規化位置uにおける、高さ補間済み(k0,k1,f)の半幅
function hullShapeHwAtU(shape, k0, k1, f, u, spanOut) {
    const sp = hullShapeStationSpan(shape, u, spanOut);
    const a = hullShapeHalfWidthAtStation(shape, sp.lo, k0, k1, f);
    if (sp.lo === sp.hi) return a;
    const b = hullShapeHalfWidthAtStation(shape, sp.hi, k0, k1, f);
    return a + (b - a) * sp.tt;
}

// その高さの輪郭が「実際に水に接しているか」(0=離水, 1=接水)。
//
// 【なぜこれだけで足りるか】
// 高さyでの輪郭は、定義上「船体表面と水平面y の交線」そのものである。
// つまり輪郭の上にある点は、船首の先端であっても船尾の端であっても、
// すべて水と接している点だということ。船首が持ち上がれば、その場所の
// 局所水面は下がり、輪郭は自動的に短くなって後退する（前端・後端も
// 高さの関数として持っているため）。旧実装のように「固定のalong位置に
// 点を置いてから、そこが水面より上かどうかを別途判定する」必要がない。
//
// 従って抑制が要るのは「船全体（の、その断面）がキールより上に出た」
// 場合だけ。そこまで来ると hullShapeEndsAtY は最下レベルで頭打ちになり、
// 空中にあるのに輪郭が残ってしまうので、ここで消す。
//
// 【最初に書いた定義の誤り】当初は「そのalong位置の船底の高さ」を基準に
// していたが、輪郭の前端・後端では船底の高さ＝その水面高さそのものに
// なるため、構造的に必ず wet=0 になってしまった（船首波が出るべき船首
// 先端の泡が常に消えるという誤り）。さらに船底の高さはレベル単位の
// 階段状の量なので、station毎に値が飛んでムラの原因にもなっていた。
function hullShapeWetness(shape, localWaterY) {
    const keelY = shape.levelY[shape.kFirst];
    const draft = Math.max(shape.designWaterlineY - keelY, 1e-6);
    // 0.1 = 「キールから喫水の10%ぶん浸かれば完全に接水扱い」。
    // ユーザーが設計喫水より浅い喫水（physics.waterlineOffsetY）を設定して
    // いても泡が薄くならないよう、立ち上がりはキールのすぐ上で終わらせる。
    // 消えるのは本当に船底より上に水面が下がったとき（＝空中）だけ。
    const x = (localWaterY - keelY) / (draft * 0.1);
    const c = x < 0 ? 0 : (x > 1 ? 1 : x);
    return c * c * (3 - 2 * c);
}

// 高さyでの、絶対along位置における半幅。
// 輪郭は「その高さ自身の前後端」で正規化されているので、まず正規化位置を
// 求めてから station を補間する。前後端の外側は幅0（船体が無い）。
function hullShapeHalfWidthAtAlong(shape, y, along) {
    if (!shape || !shape.ready) return 0;
    const e = hullShapeHalfWidthAtAlong._e || (hullShapeHalfWidthAtAlong._e = {});
    hullShapeEndsAtY(shape, y, e);
    const span = e.bowAlong - e.sternAlong;
    if (!(span > 1e-9)) return 0;
    const u = (along - e.sternAlong) / span;
    if (u <= 0 || u >= 1) return 0;

    // t[]は単調増加なので二分探索でstation区間を求める
    const t = shape.t;
    let lo = 0, hi = shape.nStations - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (t[mid] <= u) lo = mid; else hi = mid;
    }
    const span2 = t[hi] - t[lo];
    const tt = span2 > 1e-12 ? (u - t[lo]) / span2 : 0;
    const a = hullShapeHalfWidthAtStation(shape, lo, e.k0, e.k1, e.f);
    const b = hullShapeHalfWidthAtStation(shape, hi, e.k0, e.k1, e.f);
    return a + (b - a) * tt;
}

// 設計喫水での半幅（静的な参照値。従来の _hullHalfWidthAtNorm 相当）。
// alongNorm は -1(船尾端)〜+1(船首端) で、hp.halfLen 基準の正規化値。
function hullShapeHalfWidthAtNorm(shape, alongNorm, halfLen) {
    if (!shape || !shape.ready) return 0;
    return hullShapeHalfWidthAtAlong(shape, shape.designWaterlineY, alongNorm * halfLen);
}
