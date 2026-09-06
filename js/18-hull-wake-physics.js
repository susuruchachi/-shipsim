// ============================================================
//  18-hull-wake-physics.js  — v10 実スケール修正版 + v12 ワールドスケール修正
//
//  【v10の根本修正】
//  scanHullProfile() の逆回転（-ryRad）を廃止。
//  relMat（invGroupMat * node.matrixWorld）にはノードの
//  translation/rotation/scaleが全て含まれるため、
//  スキャン後のAABBで szX vs szZ を比較して長軸を自動判定する。
//
//  updateHullSlicePositions() の軸補正は modelOffset.ry ≈ ±90° のとき
//  スキャン座標のX軸が船首方向 → sinT/cosT に +π/2 補正を追加。
//
//  【v12の修正: 引き波サイズが船体と合わない問題】
//  scanHullProfile()でスキャンしたhalfLen/halfBeam/halfWidthは
//  importedModelGroup（≒shipGroup）基準のローカル座標であり、
//  physics.scale（shipGroup.scale、実メートル換算の倍率）は含まれていない。
//  一方 physics.cgWorldX/Z 等は physics.scale 適用後のワールド座標。
//  これらを直接足し算していたため、引き波の発生位置が船体中心付近に
//  寄ってしまい、船の見た目サイズと合わなくなっていた
//  （model scaleスライダーを下げると見かけ上「合う」ように見えたのは、
//   船体の見た目サイズが縮んで、ズレていた引き波の位置に近づいたため）。
//  → 位置・距離計算（alongDist, srcX/Z, hw, lambda, maxD, decayDist等）には
//    必ず physics.scale を掛けたワールドスケール版を使うように修正。
//    振幅チューニング用のscaleRatio（mscale由来の見た目比率）はローカル値のまま。
//
//  【座標系】
//  波源のワールド座標:
//    totalRad = headingRad + ryRad [+ π/2 if xIsForward]
//    srcX = cgX + sin(totalRad) * alongDist   (alongDist はワールドスケール済み)
//    srcZ = cgZ + cos(totalRad) * alongDist
// ============================================================

const HULL_SLICES = 24;

window.hullProfile = {
    ready      : false,
    slices     : [],
    halfLen    : 6.0,
    halfBeam   : 1.5,
    totalDraft : 1.0,
    xIsForward : false,
    // v120: +along方向が実際の船首かどうか(+1=そのまま船首, -1=+along側は
    // 実は船尾で座標を反転済み)。modelOffset.ryから scanHullProfile() が判定する。
    // _wakeAxisRad()のaxisCorr計算で参照する。
    bowSign    : 1,
    // 排水量自動計算用の追加リファレンス（scanHullProfile内で設定）
    designWaterlineY : 0.0, // スキャン時に推定した喫水線のローカルY
    keelY            : 0.0, // スキャン時に推定したキール（船底）のローカルY
    bowTipWidth      : 0.0, // 船首最先端の実測半幅（ローカル、ウォーターラインポリゴン用）
    sternTipWidth    : 0.0, // 船尾最先端の実測半幅（ローカル、ウォーターラインポリゴン用）
    // 喫水線に沿った船首/船尾の実際のalong位置（alongNorm換算、-1〜+1）。
    // バウスプリットやレーキした甲板の張り出し等、喫水線より上で船体最先端
    // (AABB上の全長)より前方/後方に飛び出るパーツがあるモデルでは、
    // 単純に±1.0（AABB端）を使うとウォーターラインの先端が実際の喫水位置
    // よりかなり前後に飛び出てしまうため、喫水線以下の頂点だけで再計測する。
    bowTipAlongNorm   : 1.0,
    sternTipAlongNorm : -1.0,
};

// ─────────────────────────────────────────
//  scanHullProfile()
//  逆回転なしでrelMat座標をそのままスキャン。
//  szX vs szZ で長軸（船首軸）を自動判定。
// ─────────────────────────────────────────
// ─── 船体スキャン対象から除外する「付属物」ノード ───
// スクリュー・舵・軸・旗・マスト・錨などは別オブジェクトとして船体本体より
// 外側/下側に配置されていることが多く、そのままスキャンに混ぜると：
//   ・船尾スクリュー/軸の頂点が喫水線幅サンプルを汚染し、そこだけ喫水線が
//     暴れたり実際の船体表面から浮いたりする（ウォーターライン/波しぶきが
//     スクリュー軸に沿わない原因）
//   ・旗やマスト先端など船体よりかなり前方/後方/上方にある頂点がAABBの
//     全長(halfLen)を実際の船体より過大に引き伸ばし、スライス幅の割り当てが
//     ずれて船首付近の幅が実際より広く出てしまう（Titanicの船首が
//     先端以外で左右に広がりすぎる原因）
//   ・同じ理由でAABB先端が実船体より前に出ることで、船首波・引き波の発生
//     位置が実際の船首よりかなり前方にずれる（他の船で船首波が前に出過ぎる
//     原因）
// 統計的な外れ値除去だけでは、まとまった頂点数を持つ別パーツ（スクリュー翼、
// 旗ポリゴン等）を確実には除去しきれないため、ノード名によるホワイトリスト
// 方式で確実に除外する。
// v113: DeckHouse（甲板室・艦橋構造物等の上部構造）を追加。外板本体が複数
// セグメントに分割モデリングされている船（Mogami等）では、coverage不足の
// 外板本体セグメントを拾うための面積救済ロジック（HULL_AREA_RESCUE_RATIO、
// 下記参照）が、同時に面積の大きいDeckHouseメッシュまで「船体候補」として
// 拾ってしまうことがある（実測: MidBack_DeckHouse/MidFront_DeckHouseが
// coverage0.185/0.225で単体では足切りされるが、面積救済で復活していた）。
// DeckHouseは喫水線よりずっと上にあり、外板より幅が狭い（あるいは形状が
// 全く異なる）ことが多いため、その断面が外板の断面に混ざると「外側の輪郭＝
// 最大値」を採用する仕組み上、幅プロファイルが特定のalong位置だけ不自然に
// 跳ね上がる原因になる。水面と交わることは想定していない構造物なので、
// LENIENT版（shaft/rudder等、姿勢次第で水面と交わり得るため復元する枠）にも
// 含めず、両方から完全に除外する。
// v113: crack/patch（複数セグメントの継ぎ目を裏側から塞ぐためのメッシュ）を
// 追加。外板本体が複数セグメントに分割モデリングされている船（Mogami等）では、
// 継ぎ目部分に「crack」（裏当て）や「patch」（表側の穴埋め）と呼ばれる小メッシュ
// が存在することがある。これらはcoverage不足の外板本体を拾うための面積救済
// ロジック（HULL_AREA_RESCUE_RATIO、下記参照）によって船体候補に混入し得るが、
// 外板のような滑らかな1枚面ではなく、狭いalong範囲（1スライス幅未満）に非常に
// 多数の小三角形が密集した複雑な形状を持つことがある（実測: Mogami
// "MidBack_crack_MidFront_in"が幅わずか0.0017の範囲に149枚の三角形を密集）。
// 幅プロファイルのmicro窓中央値サンプリングはこの位置に来ると大量のサンプルを
// 拾ってしまい、外板本体だけを見れば滑らかなはずの箇所が不自然に凹む/跳ねる
// 原因になる。外板本体4パーツ側は面積救済で確実に拾われることを確認済みなので、
// 継ぎ目の裏当て/穴埋け用メッシュ自体は幅プロファイルの交差対象から完全に除外
// してよい（水面と交わる「露出した外板」ではなくあくまで内部の継ぎ目処理用）。
const HULL_SCAN_EXCLUDE_KEYWORDS = [
    'screw', 'propeller', 'prop', 'blade', 'shaft', 'rudder',
    'flag', 'pennant', 'wind', 'mast', 'anchor', 'jackstaff',
    'deckhouse', 'superstructure', 'crack', 'patch',
    'スクリュー', 'プロペラ', '羽根', '軸', '舵', 'ラダー', '旗', '風', 'マスト', '錨',
    '甲板室', '上部構造', '継ぎ目',
];

// v18: Blenderの初期プリミティブ名がそのまま残っている（サフィックス無しの
// 「円柱」「Cylinder」）ノードは、命名から用途を判別できないケースがある。
// 実際にTitanicモデルでは、無名の「円柱」1個がスクリュー軸（船体中心線上を
// 貫通する細長い円柱、キール付近の低いY、船体の一部としては極端に細い断面）
// で、幅サンプルの過半数を占めて喫水線を軸に沿わせてしまう事例を確認した。
// アスペクト比だけで「細長い付属物」を自動検出しようとしたが、大きな
// 船体パネル（Plane等、これも細長い場合がある）まで巻き込んでしまい危険
// すぎるため断念。代わりに、実害を確認できた「用途不明の裸名プリミティブ」
// だけを名前完全一致で個別に除外する。他モデルでこの裸名が船体パネル本体に
// 使われていた場合に誤除外するリスクはゼロではないが、他の2隻では該当ノード
// 自体が存在しないことを確認済み。根本的にはBlender側でこのノードに
// スクリュー等と分かる名前を付けて再エクスポートするのが最も確実。
const HULL_SCAN_EXCLUDE_EXACT_NAMES = ['円柱', 'Cylinder', 'Cylinder.000'];

// v19: 高さ別プロファイル（ビジュアル喫水線専用）は、STRICT除外リストに含まれる
// shaft/rudder系まで除外してしまうと「その瞬間の水面と船体外形(付属物含む)の
// 交線」を再現できなくなる。スクリュー軸や舵は実際に船体の外側に露出した
// 構造物であり、姿勢によっては水面と交わって然るべきだが、回転する
// プロペラ翼(screw/propeller/blade)は静的スキャンでは現在の回転位置を反映
// できず含める意味がないため引き続き除外する。旗・風向計・マスト・錨等も、
// 本来水面から離れた位置にあるはずのものなので引き続き除外する
// （こちらは高さレンジの上限カットでも二重に保護される）。
const HULL_SCAN_EXCLUDE_KEYWORDS_LENIENT = HULL_SCAN_EXCLUDE_KEYWORDS.filter(
    kw => !['shaft', 'rudder', '軸', '舵', 'ラダー'].includes(kw)
);
const HULL_SCAN_EXCLUDE_EXACT_NAMES_LENIENT = []; // 裸名「円柱」はTitanicではシャフトそのものなので残す

function _isExcludedBy(node, keywords, exactNames) {
    let n = node;
    while (n) {
        const name = (n.name || '').toLowerCase();
        for (const kw of keywords) {
            if (name.includes(kw.toLowerCase())) return true;
        }
        if (n.name && exactNames.includes(n.name)) return true;
        n = n.parent;
        if (!n || n === importedModelGroup) break;
    }
    return false;
}
function _isHullScanExcluded(node) {
    return _isExcludedBy(node, HULL_SCAN_EXCLUDE_KEYWORDS, HULL_SCAN_EXCLUDE_EXACT_NAMES);
}
function _isHullScanExcludedLenient(node) {
    return _isExcludedBy(node, HULL_SCAN_EXCLUDE_KEYWORDS_LENIENT, HULL_SCAN_EXCLUDE_EXACT_NAMES_LENIENT);
}

function scanHullProfile() {
    const hp = window.hullProfile;
    hp.ready  = false;
    hp.slices = [];

    if (!importedModelGroup) { console.warn('[HullScan] no importedModelGroup'); return; }

    const nodeGroups = []; // { pts: [{x,y,z,vertArea}], tris: Uint32Array|null, strictExcluded, lenientExcluded }
    const tmp = new THREE.Vector3(), tv0 = new THREE.Vector3(), tv1 = new THREE.Vector3(), tv2 = new THREE.Vector3();
    const tcross = new THREE.Vector3();

    importedModelGroup.updateWorldMatrix(true, true);
    // v119-fix: 従来はimportedModelGroup自体の変換だけを打ち消していたが、
    // importedModelGroupの子（modelOffset.position/ry/scaleが適用される
    // 対象）が持つ回転（ry、船首方向オフセット）はそのまま残っていた。
    // これは「船体本来の向きに対して回転が反映された座標系でスキャンする」
    // という意図（_wakeAxisRad等のコメント参照）だったが、この設計には
    // 副作用があった：以降のxIsForward判定（前後軸がXかZか）や、水平面
    // （ワールドXZ平面）での輪切り自体が、ry込みの回転した座標系のまま
    // 行われてしまう。ryが90°の倍数（0°,90°,180°,270°）のときはこれでも
    // 「船体本来の前後軸に垂直な断面」と一致するため問題が出ないが、rya
    // 中間角度（実測: 通常運用の基準-90°に対し+50した-40°）になると、
    // 水平スライスが船体を斜めに切ることになり、正しい断面が得られない
    // （実測: 本来なめらかな紡錘形であるべき断面が、中央部で不自然に
    // へこみ、一部binでは交差点が消失していた）。これが実機で報告された、
    // 船を斜めに向けたときの白波の異常な交差線の直接原因。
    // 対策: modelOffset.ryの逆回転をinvGroupMatに合成し、以降のrelMat計算
    // （invGroupMat * node.matrixWorld）が自動的に「ry回転を打ち消した、
    // 船体本来の向きの座標系」になるようにする。これにより、xIsForward
    // 判定・輪切り・along/perp計算のいずれも、常にry=0相当の座標系で
    // 行われるようになり、ryがどんな値でも安定する。
    const invGroupMat = new THREE.Matrix4().copy(importedModelGroup.matrixWorld).invert();
    {
        const ryDeg = (typeof modelOffset !== 'undefined' && modelOffset && typeof modelOffset.ry === 'number') ? modelOffset.ry : 0;
        if (ryDeg !== 0) {
            // relMat = invGroupMat * node.matrixWorld で頂点を変換した後、さらに
            // invRyMat（ry逆回転）を掛けたい。つまり最終的に欲しいのは
            // invRyMat * (invGroupMat * node.matrixWorld) = (invRyMat * invGroupMat) * node.matrixWorld
            // なので、invGroupMat自体を「invRyMat * invGroupMat」に置き換えればよい。
            // THREE.Matrix4の積は行優先(this = this.multiply(m) で this*m)なので、
            // invRyMat側から明示的に .multiply(invGroupMat) して代入する
            // （invGroupMat.premultiply(invRyMat)と等価だが、multiplyの方が
            // 「どちらが先に適用されるか」を読み違えにくいため、こちらを使う）。
            const invRyMat = new THREE.Matrix4().makeRotationY(-ryDeg * Math.PI / 180);
            invGroupMat.copy(invRyMat.multiply(invGroupMat));
        }
    }

    let excludedNodeCount = 0;
    importedModelGroup.traverse((node) => {
        if (!node.isMesh) return;
        const geo = node.geometry;
        if (!geo || !geo.attributes.position) return;
        const strictExcluded = _isHullScanExcluded(node);
        const lenientExcluded = strictExcluded ? _isHullScanExcludedLenient(node) : false;
        if (strictExcluded) excludedNodeCount++;
        if (strictExcluded && lenientExcluded) return; // 両方から除外＝完全にスキップ
        const pos = geo.attributes.position;
        node.updateWorldMatrix(true, false);
        const relMat = new THREE.Matrix4().multiplyMatrices(invGroupMat, node.matrixWorld);

        const pts = new Array(pos.count);
        const vertArea = new Float64Array(pos.count); // 各頂点が代表する実表面積（隣接三角形の1/3ずつの合計）
        for (let vi = 0; vi < pos.count; vi++) {
            tmp.fromBufferAttribute(pos, vi).applyMatrix4(relMat);
            pts[vi] = { x: tmp.x, y: tmp.y, z: tmp.z };
        }

        // v108: 「近くの頂点数」ではなく「実際の面積」で船体本体らしさを測る
        // （後段のノード選定・v109の交差対象選定に使う。密なメッシュ対策の
        // 経緯はv108の説明を参照）。三角形インデックスも同時に保持しておき、
        // v109の平面交差でそのまま使い回す（インデックスなしジオメトリは
        // 3頂点ごとの並びをそのままトライアングルリストとして扱う）。
        const idx = geo.index;
        let triIndices;
        if (idx) {
            triIndices = idx.array; // Uint16Array/Uint32Array、コピー不要（読み取り専用で使う）
        } else {
            triIndices = new Uint32Array(pts.length);
            for (let vi = 0; vi < pts.length; vi++) triIndices[vi] = vi;
        }
        for (let ti = 0; ti + 2 < triIndices.length; ti += 3) {
            const i0 = triIndices[ti], i1 = triIndices[ti + 1], i2 = triIndices[ti + 2];
            tv0.set(pts[i0].x, pts[i0].y, pts[i0].z);
            tv1.set(pts[i1].x, pts[i1].y, pts[i1].z);
            tv2.set(pts[i2].x, pts[i2].y, pts[i2].z);
            tv1.sub(tv0); tv2.sub(tv0);
            tcross.crossVectors(tv1, tv2);
            const triArea = tcross.length() * 0.5;
            const per = triArea / 3.0;
            vertArea[i0] += per; vertArea[i1] += per; vertArea[i2] += per;
        }
        for (let vi = 0; vi < pos.count; vi++) pts[vi].vertArea = vertArea[vi];

        nodeGroups.push({ pts, tris: triIndices, strictExcluded, lenientExcluded });
    });

    // v107: 「近くの頂点数が多いクラスタを外板とみなす」方式は、命名規則が
    // 意味を持たないGLB（Blenderの裸連番"平面.016"等）で、通気筒台座・甲板艤装
    // 等の局所的な付属物が船体外板本体より遥かに多い頂点数を持っていると、
    // その付属物に喫水線が引っ張られてしまう（Olympicモデルの船首付近で確認）。
    // ノード名キーワードでは正体不明な付属物まですべて拾いきることはできない
    // ため、頂点数ではなく「そのメッシュ(ノード)が船の全長方向にどれだけ
    // 広がっているか」を船体本体らしさの指標として使う。船体外板は船首から
    // 船尾まで(あるいはその大部分)を覆う「殻」である一方、通気筒・カウル・
    // 甲板艤装等の付属物は局所的な範囲にしか存在しないため、この指標で
    // 明確に区別できる（Arabic: 船体本体2枚が99%カバー、Olympic: 船体本体
    // "平面"が100%カバーに対し、疑わしい2メッシュは12%・14%カバーのみ）。
    let allMin = Infinity, allMax = -Infinity, allMinZ = Infinity, allMaxZ = -Infinity;
    for (const g of nodeGroups) {
        if (g.strictExcluded && g.lenientExcluded) continue;
        for (const p of g.pts) {
            if (p.x < allMin) allMin = p.x; if (p.x > allMax) allMax = p.x;
            if (p.z < allMinZ) allMinZ = p.z; if (p.z > allMaxZ) allMaxZ = p.z;
        }
    }
    const preXIsForward = (allMax - allMin) > (allMaxZ - allMinZ) * 1.5;
    const preSzAlong = preXIsForward ? (allMax - allMin) : (allMaxZ - allMinZ);

    // v120: 船首/船尾判定を「形状」ではなく「その瞬間の船の向き」基準にする。
    // 従来の設計は、長軸(preXIsForward)の+側を無条件に船首、-側を無条件に船尾と
    // 決め打ちしていた（後段のscanTipAlong()のedge計算、alongNormの符号等、
    // このファイル全体がこの前提の上に成り立っている）。これは、外装から
    // 「どちらが船首の形状か」を自動判別するのが本質的に難しい（バルバスバウ・
    // 波動砲・艦橋のような通常の客船と全く違うシルエットのモデルでは、丸みや
    // 張り出しといった経験則が通用しない）ため、代わりに、ユーザーがモデル
    // インポート後に「船首の見た目を正すため」既に調整している modelOffset.ry
    // （このモデル本来の船首がワールドのどちら向きに見えるようになっているか、
    // という最も確実な情報源）を使い、船体ローカル座標の「+along方向」が
    // heading=0（船の基準進路＝実際に今向いている方向）のときワールドZ+
    // （このコードベースの船首基準方向、_wakeAxisRad参照）に近いかZ-に近いかで、
    // +along側と-along側のどちらが実際の船首なのかを1回だけ確定する。
    // （*Note*: 実行中に船が旋回してheadingが変わっても、船体そのものは変形
    // しないため、このローカル座標内でのbow/stern割り当ては変えない。旋回後の
    // 実際のワールド向きは、従来通り_wakeAxisRad()がheadingRadを足す形で反映する。
    // ここで言う「その瞬間の進路方向」は、モデルが基準姿勢=heading0の状態で
    // 実際にどちらを向いているか、という意味）。
    // xIsForward=true のとき、ry=0相当の座標系での「+along(=+X)方向」は
    // 素のThree.js基準でワールドX+（_wakeAxisRadのaxisCorr=+π/2の導出と同じ)。
    // xIsForward=false のときはワールドZ+がそのまま基準。そこにmodelOffset.ryを
    // 足した角度のcosがプラス＝Z+寄り＝+along側が船首、マイナス＝Z-寄り＝
    // +along側は実は船尾、という判定になる。
    const preAxisCorr = preXIsForward ? Math.PI * 0.5 : 0;
    const preRyRad = (typeof modelOffset !== 'undefined' && modelOffset && typeof modelOffset.ry === 'number')
        ? modelOffset.ry * Math.PI / 180 : 0;
    const bowSign = Math.cos(preRyRad + preAxisCorr) >= 0 ? 1 : -1;
    if (bowSign < 0) {
        // +along側が実は船尾だったモデル: 該当軸の符号を反転し、以降の全処理
        // （hullWeight/areaWeight/verts/scanTipAlong/alongNorm等、このファイル
        // 内のあらゆる「+along=船首」前提のロジック）を一切変更せずに済むよう
        // 座標そのものを揃える。反転は一度だけ、ここでnodeGroups全体に対して行う。
        for (const g of nodeGroups) {
            for (const p of g.pts) {
                if (preXIsForward) p.x = -p.x; else p.z = -p.z;
            }
        }
        // AABB自体も反転に合わせて再計算（allMin/allMaxはpreXIsForward判定にしか
        // 使わなかったのでここでは読み替え不要だが、以後の一貫性のため更新しておく）
        if (preXIsForward) { const t = allMin; allMin = -allMax; allMax = -t; }
        else                { const t = allMinZ; allMinZ = -allMaxZ; allMaxZ = -t; }
    }
    window.hullProfile.bowSign = bowSign;

    // 各ノードのカバー率を求め、頂点ごとに船体本体らしさの重み(hullWeight)を
    // 付与する。カバー率50%以上を「船体候補」として重み1.0、それ未満は
    // 徐々に重みを下げる（0%付近で0.15程度まで下げるが完全ゼロにはしない
    // ＝真に局所的な外板パネル分割だった場合の保険）。
    const HULL_COVERAGE_FULL_WEIGHT = 0.5;   // これ以上のカバー率で重み1.0
    const HULL_COVERAGE_MIN_WEIGHT  = 0.15;  // カバー率0%でもこの重みは残す
    for (const g of nodeGroups) {
        if (g.pts.length === 0) { g.hullWeight = 1.0; continue; }
        let nmin = Infinity, nmax = -Infinity;
        for (const p of g.pts) {
            const a = preXIsForward ? p.x : p.z;
            if (a < nmin) nmin = a; if (a > nmax) nmax = a;
        }
        const coverage = preSzAlong > 0.001 ? (nmax - nmin) / preSzAlong : 1.0;
        const t = THREE.MathUtils.clamp(coverage / HULL_COVERAGE_FULL_WEIGHT, 0, 1);
        g.hullWeight = HULL_COVERAGE_MIN_WEIGHT + (1.0 - HULL_COVERAGE_MIN_WEIGHT) * t;
    }

    // v108: 「面で測る」— 頂点数ではなく実表面積で船体本体らしさを判定する。
    // 舷窓の縁取り・手すりの格子など、局所的だが極めて高いポリゴン密度を
    // 持つディテールは、カバー率による重み(上のhullWeight)だけでは
    // 抑えきれないことが判明した（Olympic実測: 疑わしい2メッシュはカバー率
    // 12%・14%で重みは下がっていたが、絶対頂点数が船体本体の70〜80倍あり、
    // 重み付き合計でも依然として船体本体を上回っていた）。
    // 実表面積で見るとこれらのメッシュは船体本体の1/350以下しかなく
    // （1頂点あたりの代表面積が船体本体の1/390〜1/790）、これは「面積が
    // 小さいのに頂点数だけ極端に多い」という高密度ディテールの典型的な
    // 特徴そのもの。
    // v108-fix: 当初は対数圧縮した相対値を重みにしていたが、対数で圧縮すると
    // 実際の面積差(280倍)に対して重みの差が15倍程度にしかならず、それでも
    // なお頂点数の差(70〜80倍)の方が大きいため多数決が覆らなかった。
    // → 正規化はする（船の規模に依存しないよう中央値で割る）が、対数は
    // 挟まず比率をほぼそのまま使う。これなら「実面積の合計」に近い形で
    // 集計されるため、頂点数がどれだけ多くても実面積が小さいメッシュは
    // 確実に少数派になる（1000万個あろうが面積の合計が小さければ負ける）。
    {
        const areaSamples = [];
        for (const g of nodeGroups) {
            if (g.strictExcluded && g.lenientExcluded) continue;
            for (const p of g.pts) if (p.vertArea > 0) areaSamples.push(p.vertArea);
        }
        let medianArea = 0.01;
        if (areaSamples.length > 0) {
            areaSamples.sort((a, b) => a - b);
            medianArea = areaSamples[Math.floor(areaSamples.length / 2)] || 0.01;
            if (medianArea <= 0) medianArea = 0.01;
        }
        const AREA_WEIGHT_MIN = 0.02;   // 面積寄与が極小の頂点でも完全ゼロにはしない下限
        const AREA_WEIGHT_MAX = 1000.0; // 異常な巨大三角形1個が支配しないための上限（中央値比）
        for (const g of nodeGroups) {
            if (g.strictExcluded && g.lenientExcluded) continue;
            for (const p of g.pts) {
                const rel = p.vertArea > 0 ? (p.vertArea / medianArea) : (AREA_WEIGHT_MIN * 0.5);
                p.areaWeight = THREE.MathUtils.clamp(rel, AREA_WEIGHT_MIN, AREA_WEIGHT_MAX);
            }
        }
    }

    const verts = [];         // STRICT除外: 浮力計算/単一喫水高さ用（従来通り）。各要素に hullWeight を付与
    let vertsExtraCount = 0;  // v19: STRICTでは除外されるがLENIENTでは復元される分の頂点数（ログ用）
    const lenientTriVerts = []; // v109: 上記のうち三角形（shaft/rudder等、船体本体プールとは別枠で交差計算）
    for (const g of nodeGroups) {
        if (g.strictExcluded && g.lenientExcluded) continue;
        if (!g.strictExcluded) {
            // v108: 最終的な投票重み = カバー率由来の重み(hullWeight) × 面積由来の
            // 重み(areaWeight)。どちらか一方だけでは補足しきれないケース
            // （カバー率は高いが局所的に高密度、あるいはその逆）の両方に対応する。
            for (const p of g.pts) { p.hullWeight = g.hullWeight * p.areaWeight; verts.push(p); }
        } else {
            // shaft/rudder等の差分のみ。船体本体プールとは別枠にする理由:
            // シャフトのような細い円柱は、水平面との交差で船体形状とは無関係な
            // 孤立した小さい線分を作るため、船体本体の断面にそのまま混ぜると
            // 「その位置だけ喫水線が不自然に飛び出す」の原因になる（旧方式で
            // 「プロペラ軸受けブラケットが喫水線幅として拾われる」として
            // 対策していた問題の再来）。別枠で交差を取り、その位置で船体本体
            // より外側に張り出している場合だけ幅に反映する（後段でmax合成）。
            vertsExtraCount += g.pts.length;
            const pts = g.pts, tris = g.tris;
            for (let ti = 0; ti + 2 < tris.length; ti += 3) {
                const a = pts[tris[ti]], b = pts[tris[ti + 1]], c = pts[tris[ti + 2]];
                lenientTriVerts.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
            }
        }
    }
    if (excludedNodeCount > 0) {
        console.log(`[HullScan] 付属物ノード${excludedNodeCount}個を物理/単一喫水面計算から除外 (screw/rudder/flag/mast等)。` +
                     `ビジュアル喫水線用の高さ別プロファイルではshaft/rudderのみ復元 (${vertsExtraCount}頂点)`);
    }

    // v109: 「頂点の位置から直接推定する」のをやめ、「実際に水平面がメッシュの
    // どこと交わるか」を幾何学的に計算する（Blenderのブーリアン/断面と同じ
    // 考え方）。喫水線の幅は本来、頂点がどこにあるかとは無関係に、外板という
    // 「面」が水面高さでどんな輪郭を描くかで決まるはず。頂点サンプリング＋
    // 重み付き多数決では、頂点分布の偏り（ハイポリ/ローポリの違い、密集した
    // ディテールの混入）に応じて推定値がブレる問題が最後まで残っていたため、
    // ここで根本的にアプローチを変える。
    // 対象は「船体本体候補」と判定されたメッシュの三角形のみ（カバー率が高く、
    // かつ1頂点あたりの平均面積が極端に小さくない＝高密度ディテールでない）。
    // 三角形はワールド座標のフラット配列(x0,y0,z0,x1,y1,z1,x2,y2,z2,...)としてまとめ、
    // 平面交差関数にそのまま渡せるようにする。
    const HULL_CANDIDATE_MIN_COVERAGE = 0.3; // これ未満のカバー率のメッシュは交差対象から除外
    // v112-fix: coverage(全長カバー率)だけで足切りすると、船体が複数セグメント
    // に分割モデリングされているモデル（例: Mogami — Bow/MidFront/MidBack/Stern
    // の4分割で、外板セグメント単体では全長の10〜30%程度しかカバーしない）で、
    // 本来の外板本体セグメントそのものがcoverage不足で除外されてしまう。この
    // 場合、代わりに継ぎ目処理用の小さな"patch"/"crack"メッシュ（たまたま2つの
    // セグメントに跨って作られておりcoverageだけは条件を満たす）が唯一の候補
    // として残り、その断面がそのまま船首/船尾近くまで一定の幅で伸びてしまう
    // （実測: Mogami船首でBowShape本体がcoverage0.189のため除外され、代わりに
    // 継ぎ目パッチが幅0.00310のまま船首側24点全てで一定値になっていた）。
    // 「そのメッシュ単体の表面積が、coverage条件を満たす他の候補群の合計面積
    // と比べて無視できないほど大きい」場合は、coverageが低くても救済する。
    // 通気筒・ハッチ等の小さな付属物は表面積が小さいため、この基準では拾われ
    // ない（v108のarea-based重み付けと同じ考え方を、v109の交差ベース選定にも
    // 適用する）。
    const HULL_AREA_RESCUE_RATIO = 0.05; // coverage十分な候補群合計面積の5%以上あれば救済
    function nodeGroupArea(g) {
        let a = 0;
        for (const p of g.pts) a += (p.vertArea || 0);
        return a;
    }
    let coverageOkAreaSum = 0;
    for (const g of nodeGroups) {
        if (g.strictExcluded && g.lenientExcluded) continue;
        if (g.strictExcluded) continue;
        if (g.pts.length === 0) continue;
        let nmin = Infinity, nmax = -Infinity;
        for (const p of g.pts) {
            const a = preXIsForward ? p.x : p.z;
            if (a < nmin) nmin = a; if (a > nmax) nmax = a;
        }
        const coverage = preSzAlong > 0.001 ? (nmax - nmin) / preSzAlong : 1.0;
        if (coverage >= HULL_CANDIDATE_MIN_COVERAGE) coverageOkAreaSum += nodeGroupArea(g);
    }
    const hullTriVerts = []; // フラット配列。9要素で1三角形。
    const hullCandidatePts = []; // v118-fix: 船体候補ノードの頂点そのもの（重複なし）。scanTipAlongで使う。
    let hullCandidateNodeCount = 0, hullCandidateTriCount = 0, areaRescuedNodeCount = 0;
    for (const g of nodeGroups) {
        if (g.strictExcluded && g.lenientExcluded) continue;
        if (g.strictExcluded) continue; // shaft/rudder等は交差対象にも含めない（外板ではないため）
        if (g.pts.length === 0) continue;
        let nmin = Infinity, nmax = -Infinity;
        for (const p of g.pts) {
            const a = preXIsForward ? p.x : p.z;
            if (a < nmin) nmin = a; if (a > nmax) nmax = a;
        }
        const coverage = preSzAlong > 0.001 ? (nmax - nmin) / preSzAlong : 1.0;
        let include = coverage >= HULL_CANDIDATE_MIN_COVERAGE;
        if (!include && coverageOkAreaSum > 0) {
            const areaShare = nodeGroupArea(g) / coverageOkAreaSum;
            if (areaShare >= HULL_AREA_RESCUE_RATIO) { include = true; areaRescuedNodeCount++; }
        }
        if (!include) continue; // 局所的な付属物 → 交差対象外
        hullCandidateNodeCount++;
        const pts = g.pts, tris = g.tris;
        for (const p of pts) hullCandidatePts.push(p); // v118-fix: 三角形分割の細かさに依存しない、重複なしの頂点集合
        for (let ti = 0; ti + 2 < tris.length; ti += 3) {
            const a = pts[tris[ti]], b = pts[tris[ti + 1]], c = pts[tris[ti + 2]];
            hullTriVerts.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
            hullCandidateTriCount++;
        }
    }
    console.log(`[HullScan] 交差計算の対象: 船体本体候補ノード${hullCandidateNodeCount}個` +
                 `（うちcoverage不足だが面積救済${areaRescuedNodeCount}個）、` +
                 `三角形${hullCandidateTriCount}個（カバー率${(HULL_CANDIDATE_MIN_COVERAGE*100).toFixed(0)}%以上、` +
                 `または面積比${(HULL_AREA_RESCUE_RATIO*100).toFixed(0)}%以上）`);

    // ─── 三角形-水平面 交差関数 ───
    // hullTriVerts（フラット配列、9要素/三角形）とY=planeYの交線を求める。
    // 各三角形は0本(交差なし)か2本(交差あり)のエッジが平面をまたぐ
    // （3頂点が全部同じ側、または平面上に厳密に乗る退化ケースを除く）。
    // 交差する2エッジそれぞれの交点を線形補間で求め、線分として返す。
    // 戻り値: Float64Array [ax0,az0,bx0,bz0, ax1,az1,bx1,bz1, ...]
    //         （高さ方向は交差面上で常にplaneYなので、x,zのみ保持すれば十分）
    function intersectTrianglesWithPlaneXZ(triVertsFlat, planeY) {
        const n = triVertsFlat.length / 9;
        const out = []; // [ax,az,bx,bz, ...]
        for (let ti = 0; ti < n; ti++) {
            const o = ti * 9;
            const x0=triVertsFlat[o],   y0=triVertsFlat[o+1], z0=triVertsFlat[o+2];
            const x1=triVertsFlat[o+3], y1=triVertsFlat[o+4], z1=triVertsFlat[o+5];
            const x2=triVertsFlat[o+6], y2=triVertsFlat[o+7], z2=triVertsFlat[o+8];
            const d0 = y0 - planeY, d1 = y1 - planeY, d2 = y2 - planeY;
            const s0 = d0 > 0, s1 = d1 > 0, s2 = d2 > 0;
            if (s0 === s1 && s1 === s2) continue; // 3頂点が同じ側 → 交差なし
            let ax, az, bx, bz, found = 0;
            // エッジ0-1
            if (s0 !== s1) {
                const t = d0 / (d0 - d1);
                if (found === 0) { ax = x0 + t*(x1-x0); az = z0 + t*(z1-z0); found = 1; }
                else             { bx = x0 + t*(x1-x0); bz = z0 + t*(z1-z0); found = 2; }
            }
            // エッジ1-2
            if (s1 !== s2 && found < 2) {
                const t = d1 / (d1 - d2);
                if (found === 0) { ax = x1 + t*(x2-x1); az = z1 + t*(z2-z1); found = 1; }
                else             { bx = x1 + t*(x2-x1); bz = z1 + t*(z2-z1); found = 2; }
            }
            // エッジ2-0
            if (s2 !== s0 && found < 2) {
                const t = d2 / (d2 - d0);
                if (found === 0) { ax = x2 + t*(x0-x2); az = z2 + t*(z0-z2); found = 1; }
                else             { bx = x2 + t*(x0-x2); bz = z2 + t*(z0-z2); found = 2; }
            }
            if (found === 2) out.push(ax, az, bx, bz);
        }
        return out;
    }

    if (verts.length === 0) { console.warn('[HullScan] no vertices'); return; }

    let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity,minZ=Infinity,maxZ=-Infinity;
    for (const v of verts) {
        if (v.x<minX)minX=v.x; if (v.x>maxX)maxX=v.x;
        if (v.y<minY)minY=v.y; if (v.y>maxY)maxY=v.y;
        if (v.z<minZ)minZ=v.z; if (v.z>maxZ)maxZ=v.z;
    }
    const szX = maxX-minX, szY = maxY-minY, szZ = maxZ-minZ;

    // v119-fix: xIsForward（船体の前後軸がX方向かZ方向か）の判定自体は、上で
    // invGroupMatにry逆回転を合成した効果により、常にry=0相当（船体本来の
    // 向き）の座標系で行われるようになった。ryの値によらず安定する。
    const xIsForward = szX > szZ * 1.5;
    hp.xIsForward = xIsForward;

    const alongMin = xIsForward ? minX : minZ;
    const szAlong  = xIsForward ? szX  : szZ;
    const szPerp   = xIsForward ? szZ  : szX;

    hp.halfLen    = szAlong * 0.5;
    hp.halfBeam   = szPerp  * 0.5;
    hp.totalDraft = szY;

    const sliceW = szAlong / HULL_SLICES;

    // 喫水線Y の推定:
    // 旧方式は「全高(szY)の30%」を喫水線とみなしていたが、szYは煙突・マスト
    // を含む全高であり、モデルごとに煙突高さの比率が大きく異なる。
    // 例: Titanicは煙突が船体本体とほぼ同じ高さまで伸びるため全高に対する船体の
    // 割合が小さく、szY基準の30%点が実際の喫水線より上に来て排水量を過小評価。
    // Aquitaniaはたまたまこの基準が喫水線付近に近く問題が表面化しなかった。
    //
    // 修正: Yを複数ビンに分けて各ビンの頂点密度と最大幅(perp)を調べ、
    // 煙突・マスト等の「密度が低く幅も細い」部分を除外した「船体上端(hullTopY)」
    // を検出する。密度の高い領域の中で最大幅の40%以上を保つ最上位ビンを船体上端
    // とみなし、hullHeight = hullTopY - minY を煙突高さに左右されない船体高さとして使う。
    const HULL_TOP_BINS = 40;
    let hullHeight = szY;
    {
        const edgeStep = szY / HULL_TOP_BINS;
        const binCount = new Array(HULL_TOP_BINS).fill(0);
        const binWidth = new Array(HULL_TOP_BINS).fill(0);
        if (edgeStep > 1e-6) {
            for (const v of verts) {
                let bi = Math.floor((v.y - minY) / edgeStep);
                if (bi < 0) bi = 0; if (bi >= HULL_TOP_BINS) bi = HULL_TOP_BINS - 1;
                binCount[bi]++;
                const p = Math.abs(xIsForward ? v.z : v.x);
                if (p > binWidth[bi]) binWidth[bi] = p;
            }
            const densityThresh = Math.max(5, verts.length / (HULL_TOP_BINS * 8));
            let maxWidthDense = 0;
            for (let b = 0; b < HULL_TOP_BINS; b++) {
                if (binCount[b] >= densityThresh && binWidth[b] > maxWidthDense) maxWidthDense = binWidth[b];
            }
            if (maxWidthDense > 0.001) {
                const widthThresh = maxWidthDense * 0.4;
                let hullTopBin = -1;
                for (let b = 0; b < HULL_TOP_BINS; b++) {
                    if (binCount[b] >= densityThresh && binWidth[b] >= widthThresh) hullTopBin = b;
                }
                if (hullTopBin >= 0) {
                    const hullTopY = minY + (hullTopBin + 1) * edgeStep;
                    const candidateHeight = hullTopY - minY;
                    if (candidateHeight > szY * 0.05) hullHeight = candidateHeight;
                }
            }
        }
    }

    const wlFrac = 0.30;   // 船体本体高さの下から30%を「喫水線付近」とみなす
    const wlY    = minY + hullHeight * wlFrac;   // この高さ以下の頂点が対象
    const keelY  = minY + hullHeight * 0.05;
    // 排水量自動計算（estimateDisplacementTons）で使うため保存しておく
    hp.designWaterlineY = wlY;
    hp.keelY = keelY;

    // ─── v19: 高さ方向インデックス付き断面プロファイル ───
    // 「静止喫水線での幅を1つ求め、そこからの深度比でテーパーさせる」という
    // 従来モデルでは、スクリュー軸のように喫水線とは別の高さにある突起が
    // 傾斜（ピッチ）で実際に水面と交差しても表現できない。逆に、マストの
    // ように本来水面から大きく離れているはずの細い突起が、極端な姿勢では
    // 誤って「水面との交線」を生成してしまうのも防ぎたい。
    // そこで、各スライスについて「その高さで実際に船体外形が水面と交わったら
    // 幅は何mか」を複数の高さレベルで事前計測しておき、実行時は現在の実際の
    // 水面高さに一番近いレベル間を補間するだけにする（ビジュアルのウォーター
    // ライン専用。sl.halfWidth/sl.draftを使う浮力計算等の物理系は変更しない）。
    // 高さレンジは「キール推定値より少し下」〜「船体本体高さ(マスト/煙突を
    // 除いた推定値)より少し上」に限定し、マストや煙突の高さまでは絶対に
    // 到達しないようにする。
    const HEIGHT_LEVELS   = 10;
    const heightProfMinY  = minY - szY * 0.02;
    const heightProfMaxY  = minY + hullHeight * 1.15;
    const heightProfStep  = Math.max((heightProfMaxY - heightProfMinY) / HEIGHT_LEVELS, 0.001);

    // ─── v109: 平面交差ベースの幅プロファイル事前計算 ───
    // HEIGHT_LEVELS個の高さ（と喫水線高さwlY）それぞれについて、船体本体候補の
    // 全三角形との交差を1回ずつ計算し、その断面（along位置ごとのperp最大値）を
    // 求めておく。「船首が1頂点で閉じていなくても、面同士が実際に交わる位置で
    // ぴったり幅0になる」という、頂点サンプリングでは原理的に不可能だった精度が
    // 得られる。
    const winHalf = sliceW * 0.8; // オーバーラップ窓の半幅（窓幅 = sliceWの1.6倍）
    // triVertsFlat: 対象三角形（フラット配列）。船体本体プール(hullTriVerts)か
    // LENIENT復元プール(lenientTriVerts)のどちらかを渡す。
    // alongPositions: 幅を求めたいalong位置の配列（通常は24スライス中心だが、
    // 船首/船尾ピンポイント位置を1点だけ渡すこともできる汎用関数）。
    // 戻り値: alongPositionsと同じ長さの配列（Float64Array）。この高さで
    // 全く交差が無ければnullを返す。
    function computeWidthAtPositions(triVertsFlat, planeY, alongPositions) {
        const segsFlat = intersectTrianglesWithPlaneXZ(triVertsFlat, planeY); // [ax,az,bx,bz, ...]
        const nSeg = segsFlat.length / 4;
        if (nSeg === 0) return null; // この高さでは船体と交差しない（キール下端より下、等）
        // v111-fix: 各線分の2端点をalong/perpに変換する。ここで「線分」という
        // ペア構造を最後まで保持するのが重要（下のバグ修正参照）。
        const segAlong0 = new Float64Array(nSeg), segPerp0 = new Float64Array(nSeg);
        const segAlong1 = new Float64Array(nSeg), segPerp1 = new Float64Array(nSeg);
        for (let i = 0; i < nSeg; i++) {
            const ax = segsFlat[i*4], az = segsFlat[i*4+1], bx = segsFlat[i*4+2], bz = segsFlat[i*4+3];
            segAlong0[i] = xIsForward ? ax : az;
            segPerp0[i]  = Math.abs(xIsForward ? az : ax);
            segAlong1[i] = xIsForward ? bx : bz;
            segPerp1[i]  = Math.abs(xIsForward ? bz : bx);
        }

        // v111-fix: v109/v110の実装は、全線分の全端点(2*nSeg個)をペアの対応関係
        // ごと捨てて1本の配列にまとめ、along値だけでグローバルにソートしてから
        // 「ソート順で隣り合った2点」を線形補間していた。これは断面が単純な
        // 凸形状（同じalong位置に交点が2つしかない）場合にしか正しく動作せず、
        // 実際の船体形状（同じalong位置に左右2本・場合によってはそれ以上の
        // 交差線分が存在しうる）では、本来無関係な2つの線分の端点同士が
        // 「たまたまalongが近い」というだけで繋がれてしまい、断面と無関係な
        // 値を生成していた。Olympic船首の突起（本来ごく狭い範囲で滑らかに
        // 収束すべき断面が、無関係な線分の端点と補間されて瞬間的に跳ね上がる）
        // と、最上の船首/船尾が四角く切れる症状（逆に必要な補間ができず、
        // 先端よりかなり手前の断面幅がそのまま採用される）の両方が、この
        // ペア構造破壊によるものだった。
        // 修正: 線分ごとの対応関係(along0,perp0)-(along1,perp1)を保持したまま、
        // 「xがその線分のalong区間内にあるか」を線分単位で判定して補間する。
        // 同じx位置を跨ぐ線分が複数ある場合（左右の舷、上下の凹凸等）は、
        // それぞれ別の断面境界を表すため、外側の輪郭＝最大値を採用する。
        // v113-fix: xを跨ぐ線分が1本も無い場合、従来は「最も近い端点1つの値を
        // そのままコピー」していた。この端点は継ぎ目パッチ等、意図しないメッシュ
        // の断片であることがあり、複数の隣接along位置が同じ端点に吸着すると
        // 「船体中央部の幅を保ったまま船首/船尾側へ平坦に伸びる」症状になる
        // （Mogami実測: Bow/Stern本体の断面が一部along位置で交差線分を持たず、
        // フォールバックが3〜4スライス連続で同じ値になっていた）。
        // ここでは「フォールバックが発動したか」を呼び出し元が判別できるよう
        // widthAt.usedFallback に記録する（呼び出し直後に読む一時的な副作用
        // フラグ。呼び出し元のcomputeWidthProfileAtHeightループで、フォール
        // バックが発動したスライスだけを後段でbowEdgeAlong/sternEdgeAlongに
        // 向けて再補間する）。
        function widthAt(x) {
            let best = -1;
            for (let i = 0; i < nSeg; i++) {
                const a0 = segAlong0[i], a1 = segAlong1[i];
                const lo = Math.min(a0, a1), hi = Math.max(a0, a1);
                if (x < lo || x > hi) continue; // この線分の区間外
                const span = a1 - a0;
                const t = Math.abs(span) > 1e-9 ? (x - a0) / span : 0;
                const p = segPerp0[i] + (segPerp1[i] - segPerp0[i]) * t;
                if (p > best) best = p;
            }
            if (best >= 0) { widthAt.usedFallback = false; return best; }
            // xを跨ぐ線分が1本も無い場合（该当along位置の少し先/手前で船体が
            // 途切れている等）は、最も近い端点の値をフォールバックとして使う。
            widthAt.usedFallback = true;
            let bestD = Infinity, bestP = 0;
            for (let i = 0; i < nSeg; i++) {
                const d0 = Math.abs(segAlong0[i] - x);
                if (d0 < bestD) { bestD = d0; bestP = segPerp0[i]; }
                const d1 = Math.abs(segAlong1[i] - x);
                if (d1 < bestD) { bestD = d1; bestP = segPerp1[i]; }
            }
            return bestP;
        }

        // v113-fix: 「micro窓を含めても実際に該当along位置に断面線分が1本も
        // 掛かっていない」位置を reliableMask=false として記録する。widthAt(x)
        // 単体のusedFallbackだけでなく、micro窓サンプル収集（下のループ）も
        // 0件だった場合に不確実とみなす。呼び出し元（widthProfileByLevel構築部）
        // はこのマスクを見て、不確実な位置を「有効な位置からbowEdgeAlong/
        // sternEdgeAlongへ向けた滑らかな減衰」で置き換える。
        const microHalf = sliceW * 0.15;
        const out = new Float64Array(alongPositions.length);
        const reliableMask = new Array(alongPositions.length).fill(true);
        for (let pi = 0; pi < alongPositions.length; pi++) {
            const x = alongPositions[pi];
            const centerVal = widthAt(x);
            const centerReliable = !widthAt.usedFallback;
            const samples = [centerVal];
            const microMin = x - microHalf, microMax = x + microHalf;
            let microHit = false;
            for (let i = 0; i < nSeg; i++) {
                const a0 = segAlong0[i], a1 = segAlong1[i];
                const lo = Math.min(a0, a1), hi = Math.max(a0, a1);
                if (hi < microMin || lo > microMax) continue; // micro窓と全く重ならない
                microHit = true;
                // 窓内にクリップしたうえで、その線分区間でのperp最大値をサンプルに使う
                const clipLo = Math.max(lo, microMin), clipHi = Math.min(hi, microMax);
                const span = a1 - a0;
                const tLo = Math.abs(span) > 1e-9 ? (clipLo - a0) / span : 0;
                const tHi = Math.abs(span) > 1e-9 ? (clipHi - a0) / span : 0;
                const pLo = segPerp0[i] + (segPerp1[i] - segPerp0[i]) * tLo;
                const pHi = segPerp0[i] + (segPerp1[i] - segPerp0[i]) * tHi;
                samples.push(Math.max(pLo, pHi));
            }
            samples.sort((a, b) => a - b);
            out[pi] = samples[Math.floor(samples.length / 2)];
            reliableMask[pi] = centerReliable || microHit;
        }
        out.reliableMask = reliableMask; // Float64Arrayへのプロパティ付与（呼び出し元専用の副次情報）
        return out;
    }
    // 24スライス中心位置（既存の呼び出しパターン用の配列を1回だけ作る）
    const sliceCenters = new Float64Array(HULL_SLICES);
    for (let si = 0; si < HULL_SLICES; si++) sliceCenters[si] = alongMin + (si + 0.5) * sliceW;

    // ─── 喫水線に沿った船首・船尾の実際のalong位置（船首が前に飛び出る問題の修正）───
    // v14での修正（喫水線以下 v.y<=wlY の頂点だけで前後端を再計測）は、レーキした
    // 船首の甲板張り出しには効くが、Mauretaniaのような完全に垂直な船首でも同じ
    // 問題が再現した。原因は船首形状（レーキ）ではなく、アンカー（錨）だった。
    // 舷側のホースパイプに収まる錨は、喫水線に近い高さまで垂れ下がり、かつ
    // 船首材（stem）そのものより前方に少しだけ突き出た位置にモデリングされて
    // いることが多く、v.y<=wlYの中での単純な最大/最小along値（1頂点でも決まる）
    // を取るとこの「錨の爪先」に引っ張られてしまう。
    // 対策: 先端付近をビン分割し、頂点密度が十分あるビン（＝面積を持つ本当の
    // 外板）の中で最も先端に近いものを採用する。錨のような少数頂点の孤立した
    // 突起は密度不足で無視され、外板の密集帯から先端位置が決まる。
    // v113: この関数（と bowEdgeAlong/sternEdgeAlong）は元々24スライス幅
    // プロファイル計算より後にあったが、下のwidthAt()フォールバック改修で
    // 「船体本体の実際の先端位置」を参照する必要が生じたため、ここに前倒しした。
    // 依存するverts/wlY/alongMin/szAlong/sliceW/xIsForwardは全てこの時点で
    // 揃っている。中身のロジックは変更なし。
    // v116-fix: 元のscanTipAlongは「喫水線(wlY)以下の頂点だけ」を対象に先端の
    // 密集開始位置を探していた。これはホースパイプに収まる錨のalong値に引っ
    // 張られるのを防ぐ目的（喫水線付近まで垂れ下がる錨を除外するため）。
    // だが実測（Olympic/Oceanic/大田で確認）：カウンタースターン系の丸みを
    // 帯びた船尾は、喫水線以下の高さに外板頂点がほぼ存在しないケースがある
    // （船尾上部が大きく張り出し、水面付近で急に細くなる形状のため）。この
    // 場合wlY制限だけでは「先端の密集」を検出できるサンプルが集まらず、
    // 実際の外板端よりかなり手前を先端と誤検出していた。結果、タイポイント
    // のalong位置が通常スライス最終列より内側に来る「逆転」が発生し、順序
    // 保証ロジック（下記）で外側へ押し戻そうとしても、そちらのMath.max(-1.0,
    // ...)クランプが先に効いてしまい逆転を解消しきれず、喫水線ポリゴンが
    // 船尾で凹んでから外側へ戻るいびつな形になっていた（左右に泡が張り出す
    // ように見える症状の直接原因）。
    // 対策：まずwlY制限で試し、サンプル不足ならhullHeight方向に上限を段階的
    // に引き上げて再試行する。錨は喫水線付近までしか垂れ下がらない一方、
    // 今回問題になる船尾上部頂点はhullHeightのほぼ全域に分布しているため、
    // 「段階的に緩めてサンプルが十分に集まった段階で確定する」ことで、狭い
    // 範囲では従来通り錨を除外しつつ、広い範囲まで探すケースだけ救済できる。
    // v118-fix: v116-fixまでの`scanTipAlong`は`verts`（STRICT除外のみ適用、
    // つまり名前で判別できない付属物も全部含む集合）をそのまま先端密度検出に
    // 使っていた。だが実測（Olympic4で確認）：舵（ノード名"平面.012"、日本語
    // "舵"を含まないため除外キーワードに引っかからない）やスクリュー周辺の
    // 小部品（同様に"円柱.009"のような裸連番）が、船体外板本体から離れた
    // 船尾ごく近くに孤立したクラスタとして存在するケースがある。この場合、
    // `scanTipAlong`の密度判定が「本物の外板が密集し始める位置」より先に、
    // この孤立クラスタを「先端」と誤検出してしまう（実測: 密度判定窓の
    // 先頭寄りbin6-13が舵由来で先に閾値を超え、本来の外板密集開始位置
    // bin15以降を素通りしてしまっていた）。結果、誤検出した位置で幅を測ると
    // 舵自体の太さを拾ってしまい、タイポイント幅が実測で0.007→0.753まで
    // 跳ね上がっていた（喫水線の泡が船尾で大きく左右に張り出す症状の直接
    // 原因）。
    // 孤立クラスタと本体の密集を密度パターンだけで頑健に見分けようと複数
    // 試したが（移動窓平均、GAP許容付きの塊検出等）、舵自体がそこそこの
    // 密度を持つため決め手に欠けた。船体候補選定（coverage/面積救済）は
    // 既に「本当に船体外板全体を覆っているメッシュか」を判定できているため、
    // 先端“位置”の検出だけは、その選定を通過したノードの頂点（上で構築した
    // hullCandidatePts）に絞る方が適切と判断した。一方scanTipWidthAndProfile
    // （先端“位置”が決まった後、その位置での“幅”を測る処理）は既存コメント
    // 通り舵等を含めた実測を保つ（可動構造物が実際に張り出している幅を
    // 無視すべきではないため）。
    // 注意: hullCandidatePtsは各ノードの頂点をそのまま集めたもの（重複なし）。
    // 三角形インデックス経由（hullTriVerts）で頂点を再構成すると、1頂点が
    // 複数の三角形に共有されるぶん重複してカウントされ、メッシュの三角形
    // 分割が細かい箇所ほど不当に「密」と判定されてしまう問題があったため
    // （実測: 同じ船体候補データでも、重複ありだと本来疎らな箇所が密度
    // しきい値を超えてしまい、船首側のtipAlongが13.20→14.57にずれた）、
    // 必ず重複なしの頂点集合を使うこと。
    function scanTipAlong(isBowSide) {
        const win  = Math.max(szAlong * 0.06, sliceW * 1.5); // 先端からこの範囲内を探索
        const edge = isBowSide ? (alongMin + szAlong) : alongMin;
        const BINS = 30;
        const binW = win / BINS;

        // 高さ上限の緩和ステップ: wlFrac(0.30) → 0.55 → 0.85 → 制限なし
        const heightCapFracs = [wlFrac, 0.55, 0.85, Infinity];
        const srcPts = hullCandidatePts.length > 0 ? hullCandidatePts : verts; // 候補が無ければ従来通りvertsにフォールバック

        for (const capFrac of heightCapFracs) {
            const capY = (capFrac === Infinity) ? Infinity : (minY + hullHeight * capFrac);
            const counts = new Array(BINS).fill(0);
            for (const v of srcPts) {
                if (v.y > capY) continue;
                const valAlong = xIsForward ? v.x : v.z;
                const d = isBowSide ? (edge - valAlong) : (valAlong - edge); // 0=先端側, win=窓の内側
                if (d < 0 || d >= win) continue;
                let bi = Math.floor(d / binW);
                if (bi < 0) bi = 0; if (bi >= BINS) bi = BINS - 1;
                counts[bi]++;
            }
            const totalInWin = counts.reduce((a, b) => a + b, 0);
            if (totalInWin < 5) continue; // このcapFracでは足りない→次を試す

            const densityThresh = Math.max(3, totalInWin / BINS * 0.5);
            let firstDenseBin = -1;
            for (let b = 0; b < BINS; b++) {
                if (counts[b] >= densityThresh) { firstDenseBin = b; break; }
            }
            if (firstDenseBin < 0) continue; // 全ビンが疎→次を試す

            const dAtTip = firstDenseBin * binW;
            return isBowSide ? (edge - dAtTip) : (edge + dAtTip);
        }
        return edge; // 最も緩い段階でも見つからなければ元のAABB端
    }
    const bowEdgeAlong   = scanTipAlong(true);
    const sternEdgeAlong = scanTipAlong(false);

    // v130: 先端along位置の高さ別プロファイル（沈み込みでタイポイントが
    // 前後に伸びる問題の修正）。
    // scanTipAlong()はwlY一点基準の密度スキャンで先端along位置を1個の
    // スカラーとして求めていた。幅(hwEff)はheightProfileで没水深に応じて
    // 動的にテーパー/頭打ちされるのに対し、along位置はこの1個のスカラー
    // （hp.bowTipAlongNorm/sternTipAlongNorm）に完全に固定されたままで、
    // 実行時に一切動かなかった。
    // ラウンドしたバウやオーバーハングした船尾のように、高さによって先端の
    // along位置自体が前後する船型では、設計喫水より深く沈み込むほど本来は
    // 実際の水面と船体の交線（喫水線）がこの固定along位置より前後に張り出す
    // はずだが、従来の実装では幅が頭打ちになるだけでalong位置が動かせず、
    // 「沈み込んだときに喫水線長より長くなる場合をカバーできていない」
    // 不具合の直接原因になっていた（浮き上がる側はhwEffが0に向けてテーパー
    // ＋NEARLY_VANISHED_FRACでの点除外があるため、こちらは既に正しく動いている）。
    // 対策として、scanTipAlong()と同じ密度ベースの先端検出を、hwRawの
    // heightProfileと全く同じ高さグリッド(heightProfMinY/heightProfStep/
    // HEIGHT_LEVELS)の高さ帯ごとに分けて適用し、「高さ→along位置」の
    // プロファイルを作る。サンプル不足の帯はscanTipWidthAndProfileと同じ
    // パターンで前後の実測帯から補間・延長する。
    // v130-fix: 当初は各高さレベルを排他的な狭い帯([yLo,yHi))だけで密度
    // スキャンしていたが、scanTipAlong()のコメント(v116-fix)で既に判明して
    // いた通り、カウンタースターン系の丸みを帯びた船尾（船尾上部が大きく
    // 張り出し、水面付近で急に細くなる形状）では、1レベル分の狭い帯だけだと
    // 外板頂点の密度が全然足りず、ほとんどのレベルでサンプル不足→null判定
    // となり、実際には形状が変化しているはずの高い位置でも変化を拾えず、
    // 補間で下の疎らな実測値のまま延ばされてしまっていた（実測で報告された、
    // 船尾の張り出しに追従できない不具合の直接原因）。
    // 対策：scanTipAlong()の「capFracを段階的に緩めて再試行」と同じ考え方で、
    // 各レベルを「船体最下部からそのレベルの上端まで累積」した点集合で
    // スキャンする（排他帯→累積帯）。レベルが上がるほど点集合は単調に
    // 増えるため、上のレベルほど必ずサンプルが揃い、丸みを帯びた船尾でも
    // 上部まで正しく検出できる。
    function scanTipAlongAtBand(isBowSide, capY) {
        const win  = Math.max(szAlong * 0.06, sliceW * 1.5);
        const edge = isBowSide ? (alongMin + szAlong) : alongMin;
        const BINS = 30;
        const binW = win / BINS;
        const srcPts = hullCandidatePts.length > 0 ? hullCandidatePts : verts;

        const counts = new Array(BINS).fill(0);
        for (const v of srcPts) {
            if (v.y > capY) continue;
            const valAlong = xIsForward ? v.x : v.z;
            const d = isBowSide ? (edge - valAlong) : (valAlong - edge);
            if (d < 0 || d >= win) continue;
            let bi = Math.floor(d / binW);
            if (bi < 0) bi = 0; if (bi >= BINS) bi = BINS - 1;
            counts[bi]++;
        }
        const totalInWin = counts.reduce((a, b) => a + b, 0);
        if (totalInWin < 5) return null; // 船体最下部からここまで累積しても足りない→呼び出し側で補間

        const densityThresh = Math.max(3, totalInWin / BINS * 0.5);
        let firstDenseBin = -1;
        for (let b = 0; b < BINS; b++) {
            if (counts[b] >= densityThresh) { firstDenseBin = b; break; }
        }
        if (firstDenseBin < 0) return null;

        const dAtTip = firstDenseBin * binW;
        return isBowSide ? (edge - dAtTip) : (edge + dAtTip);
    }
    function scanTipAlongProfile(isBowSide) {
        const raw = new Array(HEIGHT_LEVELS);
        const validMask = new Array(HEIGHT_LEVELS).fill(false);
        for (let lv = 0; lv < HEIGHT_LEVELS; lv++) {
            const yTop = heightProfMinY + (lv + 1) * heightProfStep;
            const along = scanTipAlongAtBand(isBowSide, yTop);
            if (along !== null) { raw[lv] = along; validMask[lv] = true; }
            else raw[lv] = 0;
        }
        const validLv = [];
        for (let lv = 0; lv < HEIGHT_LEVELS; lv++) if (validMask[lv]) validLv.push(lv);
        const fallbackEdge = isBowSide ? bowEdgeAlong : sternEdgeAlong;
        if (validLv.length === 0) {
            for (let lv = 0; lv < HEIGHT_LEVELS; lv++) raw[lv] = fallbackEdge;
        } else if (validLv.length < HEIGHT_LEVELS) {
            for (let lv = 0; lv < HEIGHT_LEVELS; lv++) {
                if (validMask[lv]) continue;
                let loLv = -1, hiLv = -1;
                for (let k = 0; k < validLv.length; k++) {
                    if (validLv[k] < lv) loLv = validLv[k];
                    if (validLv[k] > lv && hiLv < 0) hiLv = validLv[k];
                }
                if (loLv < 0) raw[lv] = raw[hiLv];
                else if (hiLv < 0) raw[lv] = raw[loLv];
                else {
                    const t = (lv - loLv) / (hiLv - loLv);
                    raw[lv] = raw[loLv] + (raw[hiLv] - raw[loLv]) * t;
                }
            }
        }

        // 単発ノイズ平滑化（隣接3レベル中央値、幅プロファイルと同じ手法）
        const rawCopy = raw.slice();
        const smoothed = new Array(HEIGHT_LEVELS);
        for (let lv = 0; lv < HEIGHT_LEVELS; lv++) {
            const lo = Math.max(0, lv - 1), hi = Math.min(HEIGHT_LEVELS - 1, lv + 1);
            const win3 = rawCopy.slice(lo, hi + 1).sort((a, b) => a - b);
            const mid = win3.length >> 1;
            smoothed[lv] = (win3.length % 2 === 1) ? win3[mid] : (win3[mid - 1] + win3[mid]) / 2;
        }

        const profile = [];
        for (let lv = 0; lv < HEIGHT_LEVELS; lv++) {
            const y = heightProfMinY + (lv + 0.5) * heightProfStep;
            profile.push({ y, along: smoothed[lv] });
        }
        return profile;
    }

    // v113-fix: computeWidthAtPositions()が返すreliableMask（そのalong位置に
    // 実際の断面線分が掛かっていたか）を使い、「不確実な区間」を有効な隣接値
    // からbowEdgeAlong/sternEdgeAlongへ向けた滑らかな減衰で置き換える。
    // 元のwidthAt()フォールバック（最寄り端点1点をそのままコピー）は、Bow/
    // Stern本体セグメントの断面がその位置で交差線分を持たない場合に、複数の
    // 隣接スライスが同じ値へ吸着し「船体中央部の幅を保ったまま船首/船尾側へ
    // 平坦に伸びる」症状の直接原因だった（Mogami実測で確認）。
    // 修正方針:
    //   ・不確実な区間が船体central寄り（両側とも有効値に挟まれている）なら、
    //     その2つの有効値の間を線形補間する（既存のnull埋め処理と同じ考え方）。
    //   ・不確実な区間が先端寄り（片側にしか有効値が無い）なら、その有効値
    //     から実際の船体端点(bowEdgeAlong/sternEdgeAlong)に向けて線形に0まで
    //     減衰させる。船体端点より外側のスライスは0とする。
    // これにより「一定値で伸びる」のではなく、実測済みの外板先端位置に向けて
    // 自然に先細りする断面になる。
    function reinterpolateUnreliable(profile) {
        if (!profile) return profile;
        const mask = profile.reliableMask;
        if (!mask) return profile; // reliableMask無し（呼び出し元の想定外経路）はそのまま
        const n = profile.length;
        const reliableIdx = [];
        for (let si = 0; si < n; si++) if (mask[si]) reliableIdx.push(si);
        if (reliableIdx.length === n) return profile; // 全部有効ならそのまま
        if (reliableIdx.length === 0) return profile;  // 有効値が1つも無ければ手の施しようがない

        const out = new Float64Array(n);
        for (let si = 0; si < n; si++) {
            if (mask[si]) { out[si] = profile[si]; continue; }
            // siより小さい側/大きい側の直近有効indexを探す
            let loI = -1, hiI = -1;
            for (let k = 0; k < reliableIdx.length; k++) {
                if (reliableIdx[k] < si) loI = reliableIdx[k];
                if (reliableIdx[k] > si && hiI < 0) hiI = reliableIdx[k];
            }
            if (loI >= 0 && hiI >= 0) {
                // 両側に有効値がある内側の穴 → 単純線形補間
                const t = (si - loI) / (hiI - loI);
                out[si] = profile[loI] + (profile[hiI] - profile[loI]) * t;
            } else if (hiI >= 0 && loI < 0) {
                // 船尾側の先端寄り（siより手前に有効値が無い）→
                // hiI(最初の有効値)からsternEdgeAlongへ向けて0まで減衰
                const xHi = sliceCenters[hiI], xSi = sliceCenters[si];
                const span = xHi - sternEdgeAlong;
                if (xSi <= sternEdgeAlong || Math.abs(span) < 1e-9) {
                    out[si] = 0;
                } else {
                    const t = THREE.MathUtils.clamp((xSi - sternEdgeAlong) / span, 0, 1);
                    out[si] = profile[hiI] * t;
                }
            } else if (loI >= 0 && hiI < 0) {
                // 船首側の先端寄り（siより先に有効値が無い）→
                // loI(最後の有効値)からbowEdgeAlongへ向けて0まで減衰
                const xLo = sliceCenters[loI], xSi = sliceCenters[si];
                const span = bowEdgeAlong - xLo;
                if (xSi >= bowEdgeAlong || Math.abs(span) < 1e-9) {
                    out[si] = 0;
                } else {
                    const t = THREE.MathUtils.clamp((bowEdgeAlong - xSi) / span, 0, 1);
                    out[si] = profile[loI] * t;
                }
            } else {
                out[si] = 0; // 理論上到達しない
            }
        }
        return out;
    }

    function computeWidthProfileAtHeight(triVertsFlat, planeY) {
        return reinterpolateUnreliable(computeWidthAtPositions(triVertsFlat, planeY, sliceCenters));
    }

    // 各高さレベルの中心Yで交差断面を事前計算（レベル境界ではなく中心を使うことで
    // 従来のheightCands集計＝各バケット中心を代表点とする考え方と揃える）。
    // 船体本体プール(hullTriVerts)とLENIENT復元プール(lenientTriVerts、shaft/
    // rudder等)の両方で交差を取り、各スライスでmax合成する。両者を最初から
    // 混ぜて1回で交差計算すると、細いシャフト等の孤立した交差線分が船体本体の
    // 断面に紛れ込み「その位置だけ喫水線が不自然に飛び出す」原因になるため、
    // 別々に計算してから幅の大きい方を採用する（旧方式で「プロペラ軸受け
    // ブラケットが喫水線幅として拾われる」として対策していた問題の再来を防ぐ）。
    function mergeProfiles(hullProf, lenientProf) {
        if (!hullProf && !lenientProf) return null;
        if (!lenientProf) return hullProf;
        if (!hullProf) return lenientProf;
        const merged = new Float64Array(HULL_SLICES);
        for (let si = 0; si < HULL_SLICES; si++) merged[si] = Math.max(hullProf[si], lenientProf[si]);
        return merged;
    }
    const hasLenientTris = lenientTriVerts.length > 0;
    const widthProfileByLevel = [];
    for (let lv = 0; lv < HEIGHT_LEVELS; lv++) {
        const y = heightProfMinY + (lv + 0.5) * heightProfStep;
        const hullProf = computeWidthProfileAtHeight(hullTriVerts, y);
        const lenientProf = hasLenientTris ? computeWidthProfileAtHeight(lenientTriVerts, y) : null;
        widthProfileByLevel.push(mergeProfiles(hullProf, lenientProf));
    }
    const widthProfileAtWl = mergeProfiles(
        computeWidthProfileAtHeight(hullTriVerts, wlY),
        hasLenientTris ? computeWidthProfileAtHeight(lenientTriVerts, wlY) : null
    );

    // v110-fix: 一部の高さレベルで対象メッシュの三角形が全く存在せず
    // （Arabicモデルで実測: 喫水線を含む中間の高さ帯に、船体本体メッシュの
    // 三角形が1枚も無い区間があった）widthProfileByLevel[lv]がnullのまま
    // だと、そのレベルの幅が一律hw=0として扱われ、水面付近の断面が不自然に
    // くびれる/はみ出す原因になる（sl.halfWidth自体は頂点ベースへ正しく
    // フォールバックするが、heightProfileはそのフォールバックを経由せず
    // 描画に直接使われるため、この0が実際の見た目にそのまま出てしまう）。
    // 「そのレベルにデータが無い」ことと「実際に幅が0である」ことを区別する
    // ため、null だったレベルは前後の有効なレベルの値から補間で埋める
    // （両端より外側は最も近い有効値をそのまま延長）。スライス位置(si)ごとに
    // 有効/無効が異なるため、各si列について独立に処理する。
    {
        const validLv = [];
        for (let lv = 0; lv < HEIGHT_LEVELS; lv++) if (widthProfileByLevel[lv]) validLv.push(lv);
        if (validLv.length > 0 && validLv.length < HEIGHT_LEVELS) {
            for (let lv = 0; lv < HEIGHT_LEVELS; lv++) {
                if (widthProfileByLevel[lv]) continue; // 既に有効
                // lvを挟む直近の有効レベルを探す
                let loLv = -1, hiLv = -1;
                for (let k = 0; k < validLv.length; k++) {
                    if (validLv[k] < lv) loLv = validLv[k];
                    if (validLv[k] > lv && hiLv < 0) hiLv = validLv[k];
                }
                const filled = new Float64Array(HULL_SLICES);
                if (loLv < 0) {
                    // lvより下に有効レベルが無い → 一番近い上側の値をそのまま使う
                    filled.set(widthProfileByLevel[hiLv]);
                } else if (hiLv < 0) {
                    // lvより上に有効レベルが無い → 一番近い下側の値をそのまま使う
                    filled.set(widthProfileByLevel[loLv]);
                } else {
                    const t = (lv - loLv) / (hiLv - loLv);
                    const lo = widthProfileByLevel[loLv], hi = widthProfileByLevel[hiLv];
                    for (let si = 0; si < HULL_SLICES; si++) filled[si] = lo[si] + (hi[si] - lo[si]) * t;
                }
                widthProfileByLevel[lv] = filled;
            }
        }
    }

    // ─── スライス断面スキャン（v13: ガタつき/凹み & 突起汚染 対策 / v14: バンド制限+適応窓）───
    // 従来は各スライスを [sliceMin, sliceMax) の排他区間で区切り、区間内頂点の
    // 「単純max」を幅として採用していた。低ポリゴンGLBは区間境界をまたぐ大きな
    // 面が多く、代表頂点が少ないスライスだけ幅が実際より小さく出て「喫水線が
    // 内側にガタガタと凹む」原因になっていた。また単純maxだとプロペラ軸受け
    // ブラケットやダビット等の細い突起1点でも幅が跳ね上がり、「船尾の喫水線が
    // 不自然に広がる」原因にもなっていた。
    // 対策: (1) 窓を1.6倍に広げ隣接区間とオーバーラップさせてサンプリング抜けを
    // 解消。(2) 区間内頂点を幅でソートし95パーセンタイルを採用（十分な頂点数を
    // 持つ「面」＝本当の外板だけを拾い、頂点数の少ない細い突起は無視される）。
    // (3) 後段で隣接3スライスの中央値を取り、残る単発的なガタつきを均す。
    // (4) v14: 幅サンプルの縦方向レンジを「キール〜wlY全域」から「wlYに近い
    //     上半分バンド」に狭め、キール付近にあるプロペラ軸受けブラケット等が
    //     喫水線幅として拾われて船尾が不自然に広がる問題を軽減する。
    // (5) v14: サンプル数が少ない(<8)スライスは窓を2.5倍に広げて再スキャンし、
    //     低ポリゴンモデル(Homeric/Majestic等)で局所的に頂点が疎になる区間の
    //     「喫水線が内側に凹む」症状を軽減する。
    // (6) v19: 上記(1)〜(5)の候補頂点収集を高さレンジ全体(heightProfMinY〜Max)
    //     に広げて1回だけ行い、そこから従来のwl-band集計と新しい高さレベル別
    //     集計の両方を導出する（頂点配列を2度スキャンしない）。
    const wlBand    = Math.max((wlY - keelY) * 0.5, szY * 0.01); // wlYから見た下方向のバンド幅
    const wlBandMinY = wlY - wlBand;

    function scanSliceCrossSection(sliceCenter, halfWin) {
        const winMin = sliceCenter - halfWin;
        const winMax = sliceCenter + halfWin;
        let maxPerp = 0, minYs = Infinity, perpAtKeel = 0, n = 0;
        for (const v of verts) {
            const valAlong = xIsForward ? v.x : v.z;
            if (valAlong < winMin || valAlong >= winMax) continue;
            const valPerp  = xIsForward ? v.z : v.x;
            const perp = Math.abs(valPerp);
            n++;
            if (perp > maxPerp) maxPerp = perp;
            if (v.y < minYs) minYs = v.y;
            if (v.y <= keelY + szY*0.10 && perp > perpAtKeel) perpAtKeel = perp;
        }
        return { maxPerp, minYs, perpAtKeel, n };
    }

    for (let si = 0; si < HULL_SLICES; si++) {
        const sliceCenter = alongMin + (si + 0.5) * sliceW;
        // alongNorm: -1=船尾, +1=船首。
        // v17修正: importedModelGroupの「ローカル原点(0,0,0)」を基準にした真の
        // 正規化位置にする（sliceCenterをhp.halfLenで割るだけ）。
        // 旧式は ((si+0.5)/HULL_SLICES)*2-1 という指数ベースの式で、これは実質
        // (sliceCenter - alongCenter)/halfLen（alongCenter=スキャンAABB自身の
        // 中心）と等価だった。scanHullProfile冒頭のコメント通り、このファイルの
        // 他の全関数（_hullOriginWorld, pushOutsideHull, updateHullSlicePositions
        // 等）は alongNorm=0 を「importedModelGroupのローカル原点」として扱って
        // いるが、旧式はAABB自身の中心を基準にしていたため、スクリュー/舵/軸等の
        // 付属物除外でAABBが片側（船尾側）だけ縮むと、AABB中心がローカル原点から
        // ズレて、喫水線ポリゴン全体が船体に対して前後にオフセットするバグになって
        // いた（付属物除外を追加するほど症状が出やすくなる）。
        const alongNorm = sliceCenter / hp.halfLen;

        // v109: draft(喫水深さ)・flareAngle(フレア角)の算出には、引き続き
        // 頂点ベースの情報（この区間の最下点minYs、キール付近の幅perpAtKeel）
        // が必要（交差は「特定の高さでの断面」しか教えてくれないため）。
        // 幅そのもの（halfWidth, heightProfile）は下で交差ベースの値を使う。
        const res = scanSliceCrossSection(sliceCenter, winHalf);
        const { maxPerp, minYs, perpAtKeel } = res;
        if (maxPerp < 0.001 && (!widthProfileAtWl || widthProfileAtWl[si] < 0.001)) continue;

        // v109: 「頂点をサンプリングして推定する」のではなく、事前計算しておいた
        // 実際の平面-メッシュ交差断面（widthProfileAtWl, widthProfileByLevel）を
        // そのまま使う。船首が1頂点で閉じていなくても、面同士が実際に交わる
        // 位置でぴったり幅が決まる（Blenderのブーリアン/断面と同じ精度）。
        const perpAtWl = widthProfileAtWl ? widthProfileAtWl[si] : 0;
        const heightProfile = [];
        for (let lv = 0; lv < HEIGHT_LEVELS; lv++) {
            const y = heightProfMinY + (lv + 0.5) * heightProfStep;
            const prof = widthProfileByLevel[lv];
            const hw = prof ? prof[si] : 0;
            heightProfile.push({ y, hw });
        }
        // 高さ方向の単発ノイズを軽減（隣接3レベルの中央値）。交差ベースでも、
        // ごく細い付属物（アンテナ線等）がその高さだけ偶然かすめて交差する
        // ケースはゼロではないため、平滑化自体は維持する。
        {
            const rawHw = heightProfile.map(p => p.hw);
            for (let lv = 0; lv < HEIGHT_LEVELS; lv++) {
                const lo = Math.max(0, lv - 1), hi = Math.min(HEIGHT_LEVELS - 1, lv + 1);
                const win = rawHw.slice(lo, hi + 1).sort((a, b) => a - b);
                const mid = win.length >> 1;
                heightProfile[lv].hw = (win.length % 2 === 1) ? win[mid] : (win[mid - 1] + win[mid]) / 2;
            }
        }

        const wlH = Math.abs(wlY - keelY);
        const flareAngle = wlH > 0.01
            ? Math.atan2(Math.abs(perpAtWl - perpAtKeel), wlH) * (180 / Math.PI)
            : 0;

        // 喫水線幅は交差ベースの値を優先。wlYちょうどでの直接交差が得られない
        // 場合は、上で（null埋め補間済みの）heightProfileからwlY相当の値を
        // 補間して使う。scanTipWidthAndProfile（船首/船尾ピンポイント点）と
        // 同じ優先順位にすることで、通常スライスと先端点の間で断面の求め方に
        // 一貫性を持たせる。それでも得られない極端なケースのみ、最後の保険と
        // して頂点ベースのmaxPerpにフォールバックする。
        let hw = perpAtWl;
        if (hw < 0.001) {
            const lvFloat = (wlY - heightProfMinY) / heightProfStep - 0.5;
            const lv0 = THREE.MathUtils.clamp(Math.floor(lvFloat), 0, HEIGHT_LEVELS - 1);
            const lv1 = THREE.MathUtils.clamp(lv0 + 1, 0, HEIGHT_LEVELS - 1);
            const t = THREE.MathUtils.clamp(lvFloat - lv0, 0, 1);
            const interp = heightProfile[lv0].hw + (heightProfile[lv1].hw - heightProfile[lv0].hw) * t;
            hw = interp > 0.001 ? interp : maxPerp * 0.55;
        }
        // draft: wlY-minYs が極小(トランサムスターン艦尾等)でも最低szY*0.05を保証
        const draftVal = Math.max(szY * 0.05, wlY - minYs);

        hp.slices.push({
            alongNorm,
            halfWidth  : hw,
            draft      : draftVal,
            flareAngle : THREE.MathUtils.clamp(flareAngle, 0, 70),
            heightProfile,   // v19: ビジュアル喫水線専用。物理(浮力等)はhalfWidth/draftを継続使用
            worldX: 0, worldZ: 0,
        });
    }

    // ─── 中央値スムージング（隣接5スライス）───
    // オーバーラップ窓と最大値近傍クラスタ方式でも残る局所的なガタつき（1〜2
    // スライス連続で異常に凹む/出っ張る）を、隣接スライスとの中央値で均す。
    // 窓を3→5スライスに拡大し、2連続の異常値にも対応できるようにした
    // （3スライス窓だと2連続の異常値の片方が中央値として生き残ってしまうケースが
    // あった）。船体の緩やかなテーパー傾向（単調な増減）は中央値では消えないので、
    // 形状の大枠は保たれる。
    // v18修正: 船首/船尾に近いスライスでは窓が端で切り詰められ偶数長（4枚）に
    // なる。従来コードは常にwin[Math.floor(len/2)]（偶数長では中央2つのうち
    // 「大きい方」）を採用しており、船首直前のスライスで隣接する広いスライスの
    // 値をそのまま引き継いでしまい、実際は先端に向けて先細っているはずの区間が
    // 不自然に一段広いまま停滞する（「船首の幅がおかしい」の原因）。
    // 偶数長では中央2要素の平均を取る正しい中央値に修正。
    if (hp.slices.length >= 3) {
        const rawHw = hp.slices.map(sl => sl.halfWidth);
        const half = 2; // 片側2枚 = 計5スライス窓（端は自動的に縮小）
        for (let i = 0; i < hp.slices.length; i++) {
            const iLo = Math.max(0, i - half);
            const iHi = Math.min(hp.slices.length - 1, i + half);
            const win = rawHw.slice(iLo, iHi + 1).sort((a, b) => a - b);
            const mid = win.length >> 1;
            hp.slices[i].halfWidth = (win.length % 2 === 1)
                ? win[mid]
                : (win[mid - 1] + win[mid]) / 2;
        }
    }

    // ─── 外れ値除去: 外輪・ウォーターホイール等の突起がhwを汚染するのを防ぐ ───
    // mean + 1.5*std を上限としてhwをクランプする（1.5*std = 外れ値6.7%以上を除去）。
    // 2.0*std だと外輪スライス2〜3枚程度では mean が引き上げられてクランプされない
    // ケースがあるため、1.5*std に厳しくして外輪・突起を確実に除去する。
    //   ・外輪(Britannia): 外輪スライスの大きなhwをクランプ
    //   ・通常のflare船体: 単調に増加するhwはstdが大きく過剰クランプにならない
    //   ・こんごうのカッタースターン: 船尾突起も同様に除去
    if (hp.slices.length > 1) {
        const hwVals = hp.slices.map(sl => sl.halfWidth);
        const hwMean = hwVals.reduce((s, v) => s + v, 0) / hwVals.length;
        const hwStd  = Math.sqrt(hwVals.reduce((s, v) => s + (v - hwMean) ** 2, 0) / hwVals.length);
        // 上限: mean + 1.5*std（厳格化）
        // ただし std が極小の場合 (=ほぼ均一船体) は mean*1.15 を最低上限とする
        const hwCap = Math.max(hwMean + 1.5 * hwStd, hwMean * 1.15);
        let clampedCount = 0;
        for (const sl of hp.slices) {
            if (sl.halfWidth > hwCap) {
                sl.halfWidth = hwCap;
                clampedCount++;
            }
        }
        // halfBeam を外れ値除去後の平均で再計算
        hp.halfBeam = hp.slices.reduce((s, sl) => s + sl.halfWidth, 0) / hp.slices.length;
        if (clampedCount > 0) {
            console.log(`[HullScan] hw外れ値クランプ: ${clampedCount}スライス → hwCap=${hwCap.toFixed(2)} (mean=${hwMean.toFixed(2)} std=${hwStd.toFixed(2)})`);
        }
    }

    // ─── 喫水線に沿った船首・船尾の実際のalong位置（船首が前に飛び出る問題の修正）───
    // v113: この計算ブロックは元々ここ（24スライス幅プロファイル計算より後）に
    // あったが、widthAt()のフォールバック処理（下記computeWidthAtPositions内）が
    // bowEdgeAlong/sternEdgeAlongを参照できるよう、computeWidthAtPositions定義
    // 直後・sliceCenters定義の直前に移動した。中身は変更なし。
    // ─── 船首・船尾の正確な先端幅（可視化ウォーターラインポリゴン用）───
    // 24分割の粗いスライスは代表点がスライス中心（alongMin/alongMaxから内側に
    // 半スライス分入った位置）に置かれるため、実際の船体最先端まで届かない。
    // そのままだと可視化ポリゴン（04-scene-and-water-init.js の
    // updateHullWaterlinePolygon）で舷同士が先端手前でブツ切りに繋がり、尖って
    // いるはずの船首が「四角く」切れて見えるバグの原因になっていた。
    // 上で求めた bowEdgeAlong/sternEdgeAlong（アンカー等を除外した本当の外板の
    // 先端位置）を基準に、通常スライスと全く同じ交差ベースの
    // computeWidthAtPositions で先端ピンポイントの幅とheightProfileを求め、
    // hp.bowTipWidth / hp.sternTipWidth / hp.bowTipHeightProfile /
    // hp.sternTipHeightProfile に保存する。
    // v110-fix: 以前はここだけ独自の頂点クラスタリング(重み付けなし、v107以前の
    // 方式のまま)を使っており、しかもheightProfileを一切生成していなかったため、
    // 04-scene-and-water-init.js側のemitPointで「heightProfileが無い場合の
    // 従来のβ乗則近似」に必ずフォールバックしていた。通常スライスをv109/v110で
    // 交差ベースに置き換えても、船首の一番先端（描画上まさに"先っぽ"の点）
    // だけはその恩恵を一切受けられず、水面追従も出来ていなかった。これが
    // 「先っぽだけ謎にはみ出す」の直接原因だったため、通常スライスと同じ
    // 交差ベースの計算に統一する。
    function scanTipWidthAndProfile(isBowSide, edge) {
        const pos = new Float64Array([edge]);

        // v110-fix: widthProfileByLevelと同じ理由で、この位置でも一部の高さ
        // レベルだけ交差が全く得られないことがある（船体本体メッシュがその
        // 高さ帯に三角形を持たない場合）。null判定のまま素通りさせるとhw=0が
        // 混入するため、有効なレベルが1つでもあれば前後から補間で埋める。
        // v114-fix: 上のnull判定（hp0/lp0が非nullか）は「この高さで船体の
        // *どこかしらに* 断面がある」ことしか保証せず、edge位置そのものに
        // 実際の交差線分が掛かっていたかは見ていなかった。そのため、先端
        // ちょうどの位置では直接交差が取れず widthAt() が「最寄り端点」の
        // フォールバック（reinterpolateUnreliableが通常スライスでは既に
        // ガードしている、まさにそのフォールバック）に落ちるケースでも、
        // その値をそのまま信頼できる実測として採用してしまっていた。最寄り
        // 端点は往々にして船体中央寄りのもっと太い断面の値であり、これが
        // 先端幅として hp.bowTipHeightProfile/hp.sternTipHeightProfile に
        // 混入し、水面の泡帯（updateHullWaterlinePolygon→hullEdgeFoam）が
        // 実際の船体輪郭より外側（左右）に張り出す直接の原因になっていた
        // （Olympic船首・Oceanic船尾で実測: 本来1未満のはずの半幅が、
        // フォールバック混入したレベルだけ船の全幅に迫る6〜16という値に
        // 跳ね上がっていた）。computeWidthAtPositions()が返すreliableMask
        // （そのalong位置に実際に断面線分が掛かっていたか）で判定すること
        // で、「edge位置での本物の交差」だけを実測値として採用し、
        // フォールバックしか得られなかったレベルは下の補間ループに委ねる
        // （前後の実測レベルの間を補間、片側にしか無ければそのまま延長＝
        // 　無関係な断面の値をコピーするより遥かに安全）。
        const hwRaw = new Array(HEIGHT_LEVELS);
        const validMask = new Array(HEIGHT_LEVELS).fill(false);
        for (let lv = 0; lv < HEIGHT_LEVELS; lv++) {
            const y = heightProfMinY + (lv + 0.5) * heightProfStep;
            const hp0 = computeWidthAtPositions(hullTriVerts, y, pos);
            const lp0 = hasLenientTris ? computeWidthAtPositions(lenientTriVerts, y, pos) : null;
            const hpReliable = !!(hp0 && hp0.reliableMask[0]);
            const lpReliable = !!(lp0 && lp0.reliableMask[0]);
            if (hpReliable || lpReliable) {
                hwRaw[lv] = Math.max(hpReliable ? hp0[0] : 0, lpReliable ? lp0[0] : 0);
                validMask[lv] = true;
            } else {
                hwRaw[lv] = 0;
            }
        }

        // v115-fix: reliableMask判定だけでは、ミラー化モデル特有の中心線の
        // 継ぎ目（左右反転コピーした半船体が中心線でぴったり合わさりきれず、
        // 先端＝中心線上にごく薄い/重複した三角形が残っているケース）を
        // 防げなかった。継ぎ目の三角形もwidthAt()から見れば「本物の交差」
        // なのでreliableMask自体はtrueになってしまう（Oceanic船尾で実測：
        // reliableMask=trueのレベルで測定した先端幅が、同じ高さの通常
        // スライス最終断面の幅を6〜8倍近く超えていた。v114-fixのreliableMask
        // 判定だけではこれを素通りさせてしまい、症状が変わらなかった）。
        // 対策として、隣接する通常スライス側の値（reinterpolateUnreliable
        // 適用済みで、24箇所の断面から求めた・継ぎ目1点に依存しない頑健な
        // 値）を同じ高さで参照し、それを大きく超える実測は継ぎ目由来の
        // 異常値とみなして「未実測」に格下げする（下の補間ループに委ねる）。
        // 実在するフレア/カウンタースターンのオーバーハングは許容したいので
        // 係数は緩め(1.35倍)にとどめる。
        const refSliceIdx = isBowSide ? [HULL_SLICES - 1, HULL_SLICES - 2] : [0, 1];
        const TIP_VS_SLICE_MAX_GROWTH = 1.35;
        for (let lv = 0; lv < HEIGHT_LEVELS; lv++) {
            if (!validMask[lv]) continue;
            const lvProf = widthProfileByLevel[lv];
            if (!lvProf) continue;
            let refW = 0;
            for (const si of refSliceIdx) refW = Math.max(refW, lvProf[si] || 0);
            if (refW > 0.001 && hwRaw[lv] > refW * TIP_VS_SLICE_MAX_GROWTH) {
                hwRaw[lv] = 0;
                validMask[lv] = false;
            }
        }
        const validLv = [];
        for (let lv = 0; lv < HEIGHT_LEVELS; lv++) if (validMask[lv]) validLv.push(lv);
        if (validLv.length > 0 && validLv.length < HEIGHT_LEVELS) {
            for (let lv = 0; lv < HEIGHT_LEVELS; lv++) {
                if (validMask[lv]) continue;
                let loLv = -1, hiLv = -1;
                for (let k = 0; k < validLv.length; k++) {
                    if (validLv[k] < lv) loLv = validLv[k];
                    if (validLv[k] > lv && hiLv < 0) hiLv = validLv[k];
                }
                if (loLv < 0) hwRaw[lv] = hwRaw[hiLv];
                else if (hiLv < 0) hwRaw[lv] = hwRaw[loLv];
                else {
                    const t = (lv - loLv) / (hiLv - loLv);
                    hwRaw[lv] = hwRaw[loLv] + (hwRaw[hiLv] - hwRaw[loLv]) * t;
                }
            }
        }

        // wlYちょうどの幅は、まず直接交差から求め、得られなければ上で補間済みの
        // hwRaw（wlYに最も近いレベル間の線形補間）にフォールバックする。
        // v114-fix: ここも上のhwRawループと同じ理由で、reliableMaskを見ずに
        // 「非null＝直接交差できた」と誤判定していた。フォールバック値を
        // 実測として採用しないよう、reliableMaskを確認してから使う。
        const hullProf   = computeWidthAtPositions(hullTriVerts, wlY, pos);
        const lenientProf = hasLenientTris ? computeWidthAtPositions(lenientTriVerts, wlY, pos) : null;
        const hullProfReliable    = !!(hullProf && hullProf.reliableMask[0]);
        const lenientProfReliable = !!(lenientProf && lenientProf.reliableMask[0]);
        let wlWidth = (hullProfReliable || lenientProfReliable)
            ? Math.max(hullProfReliable ? hullProf[0] : 0, lenientProfReliable ? lenientProf[0] : 0)
            : 0;
        // v115-fix: hwRawループと同じ継ぎ目対策をwlYちょうどの直接計測にも適用。
        {
            const wlRefW = widthProfileAtWl
                ? Math.max(widthProfileAtWl[refSliceIdx[0]] || 0, widthProfileAtWl[refSliceIdx[1]] || 0)
                : 0;
            if (wlRefW > 0.001 && wlWidth > wlRefW * TIP_VS_SLICE_MAX_GROWTH) wlWidth = 0;
        }
        if (wlWidth < 0.001 && validLv.length > 0) {
            const lvFloat = (wlY - heightProfMinY) / heightProfStep - 0.5;
            const lv0 = THREE.MathUtils.clamp(Math.floor(lvFloat), 0, HEIGHT_LEVELS - 1);
            const lv1 = THREE.MathUtils.clamp(lv0 + 1, 0, HEIGHT_LEVELS - 1);
            const t = THREE.MathUtils.clamp(lvFloat - lv0, 0, 1);
            wlWidth = hwRaw[lv0] + (hwRaw[lv1] - hwRaw[lv0]) * t;
        }

        const heightProfile = [];
        for (let lv = 0; lv < HEIGHT_LEVELS; lv++) {
            const y = heightProfMinY + (lv + 0.5) * heightProfStep;
            heightProfile.push({ y, hw: hwRaw[lv] });
        }
        // 高さ方向の単発ノイズ平滑化（通常スライスと同じ隣接3レベル中央値）
        {
            const rawHw = heightProfile.map(p => p.hw);
            for (let lv = 0; lv < HEIGHT_LEVELS; lv++) {
                const lo = Math.max(0, lv - 1), hi = Math.min(HEIGHT_LEVELS - 1, lv + 1);
                const win = rawHw.slice(lo, hi + 1).sort((a, b) => a - b);
                const mid = win.length >> 1;
                heightProfile[lv].hw = (win.length % 2 === 1) ? win[mid] : (win[mid - 1] + win[mid]) / 2;
            }
        }
        return { width: wlWidth, heightProfile };
    }
    const bowTipResult   = scanTipWidthAndProfile(true,  bowEdgeAlong);
    const sternTipResult = scanTipWidthAndProfile(false, sternEdgeAlong);
    hp.bowTipWidth   = bowTipResult.width;
    hp.sternTipWidth = sternTipResult.width;
    hp.bowTipHeightProfile   = bowTipResult.heightProfile;
    hp.sternTipHeightProfile = sternTipResult.heightProfile;
    // v130: 先端along位置の高さ別プロファイル（沈み込みで先端が前後に伸びる問題の修正、上のscanTipAlongProfile参照）
    hp.bowTipAlongProfile   = scanTipAlongProfile(true);
    hp.sternTipAlongProfile = scanTipAlongProfile(false);

    // v130: 通常24スライス（HULL_SLICES、均等間隔）の最後尾スライスから実際の
    // 先端(bowEdgeAlong/sternEdgeAlong)までの区間は、これまで先端タイポイント
    // 1点だけでカバーしていた。バルバスバウ／カウンタースターン／アトランティック
    // バウのようにこの区間自体が長く、かつ断面形状が急に変化する船型では解像度が
    // 足りず、喫水線の見た目の精度が落ちる（ユーザー報告）。
    // 対策として、この区間だけ追加でTIP_FINE_POINTS点を等分してscanTipWidth
    // AndProfile()を追加実行し、区間内の断面を細かく取得する。
    // HULL_SLICES自体（sliceCenters・sliceWidthベースの浮力/慣性モーメント積分
    // 等、物理計算が前提にしている一様間隔）には一切手を入れない。あくまで
    // 喫水線ポリゴン（見た目）専用の追加データとして hp.bowFinePoints /
    // hp.sternFinePoints に保存する。
    const TIP_FINE_POINTS = 2;
    function scanFinePoints(isBowSide, lastRegularAlong, edgeAlong) {
        const pts = [];
        for (let i = 1; i <= TIP_FINE_POINTS; i++) {
            const t = i / (TIP_FINE_POINTS + 1); // 例: 2点なら 1/3, 2/3
            const along = lastRegularAlong + (edgeAlong - lastRegularAlong) * t;
            const res = scanTipWidthAndProfile(isBowSide, along);
            pts.push({ alongNorm: along / hp.halfLen, width: res.width, heightProfile: res.heightProfile });
        }
        return pts; // 通常スライス側 → 先端側の順
    }
    hp.bowFinePoints   = scanFinePoints(true,  sliceCenters[HULL_SLICES - 1], bowEdgeAlong);
    hp.sternFinePoints = scanFinePoints(false, sliceCenters[0],               sternEdgeAlong);

    {
        // regular sliceのalongNorm修正と同じ理由で、AABB中心(alongCenter)を
        // 引かず、ローカル原点基準のままhp.halfLenで正規化する。
        if (hp.halfLen > 0.001) {
            hp.bowTipAlongNorm   = THREE.MathUtils.clamp(bowEdgeAlong   / hp.halfLen, 0.4, 1.0);
            hp.sternTipAlongNorm = THREE.MathUtils.clamp(sternEdgeAlong / hp.halfLen, -1.0, -0.4);
        } else {
            hp.bowTipAlongNorm   = 1.0;
            hp.sternTipAlongNorm = -1.0;
        }
    }

    // ─── 先端点が「最後の通常スライスより手前」に来ないことを保証 ───
    // scanTipAlong()は密度ベースで船首/船尾の縁を探すため、先端付近の頂点が
    // 疎（低ポリゴンのステム/スターン形状）だと、密度しきい値を満たす位置が
    // 最後の通常スライス（alongNorm ±0.958付近）より内側で見つかることがある。
    // その場合、更新後のウォーターラインポリゴンは
    // 「…→最後のスライス(先端寄り)→先端点(それより後ろ)→反対舷の先端点→
    //   反対舷の最後のスライス(再び先端寄り)→…」という順序になり、
    // along方向に前後する自己交差（ねじれ）が生まれて船首/船尾がV字に
    // 割れたり、水面に見当違いの多角形の白線が浮いたりする不具合の原因になる
    // （Titanicのモデルで実際にこの逆転が発生することを確認済み）。
    // 先端点は定義上「最後の通常スライスよりも必ず外側」にあるべきなので、
    // ここで単調性を強制する。実測値をそのまま使うのは先端が想定通り前方に
    // ある通常のケースのみで、逆転時だけ最小限のオフセットで押し出す。
    // v117-fix: 上のclamp(0.4,1.0)/clamp(-1.0,-0.4)は「タイポイントは船体
    // ローカル原点からhalfLen以上離れない」という前提で外側境界を±1.0に
    // 固定していた。だが実測（Olympic/Oceanic/大田で確認）：hp.halfLenは
    // szAlong*0.5（ローカル原点を中心とみなした半長）であり、モデルの
    // ローカル原点(0,0,0)がGLB上の船体幾何中心と一致しない場合（今回の
    // 3隻はいずれもミラー化モデルで、原点が幾何中心から片側にズレていた）、
    // 通常スライス自体のalongNorm（sliceCenter/hp.halfLen、上のv17修正で
    // 意図的にAABB中心ではなくローカル原点基準にしている）が理論範囲
    // ±1.0をわずかに超えて算出されるケースがある。この状態で下の
    // 「先端点を最後の通常スライスより外側に押し出す」処理がMath.min(1.0,
    // ...)/Math.max(-1.0,...)で外側境界を±1.0に固定したままだと、
    // 「押し出したい方向にこれ以上動かせない」状態になり、逆転を解消
    // しきれなかった（喫水線ポリゴンが先端で内側に凹んでから外側の通常
    // スライスへ戻るいびつな形になり、泡が左右に張り出して見える症状の
    // 直接原因）。対策：外側境界を1.0/-1.0固定ではなく、実際の最後尾
    // スライスの位置に合わせて動的に広げる（通常ケース、つまり最後尾
    // スライスが±1.0以内に収まっている場合は今まで通り1.0/-1.0が境界に
    // なるため、既存の挙動への影響はない）。
    if (hp.slices.length >= 2) {
        const lastBow   = hp.slices[hp.slices.length - 1];
        const lastStern = hp.slices[0];
        const bowEps   = Math.abs(hp.slices[hp.slices.length - 1].alongNorm - hp.slices[hp.slices.length - 2].alongNorm) * 0.15;
        const sternEps = Math.abs(hp.slices[1].alongNorm - hp.slices[0].alongNorm) * 0.15;
        const bowOuterBound   = Math.max(1.0, lastBow.alongNorm + bowEps);
        const sternOuterBound = Math.min(-1.0, lastStern.alongNorm - sternEps);
        if (hp.bowTipAlongNorm <= lastBow.alongNorm) {
            hp.bowTipAlongNorm = Math.min(bowOuterBound, lastBow.alongNorm + bowEps);
        }
        if (hp.sternTipAlongNorm >= lastStern.alongNorm) {
            hp.sternTipAlongNorm = Math.max(sternOuterBound, lastStern.alongNorm - sternEps);
        }
    }

    hp.ready = true;
    updateHullSlicePositions();

    // 船体スケールが確定したのでLODグリッドを最適な密度で再構築
    if (typeof rebuildWaterGeometry === 'function' && typeof perf !== 'undefined') {
        rebuildWaterGeometry(perf.waterSegments);
    }
    // モデル読込・再スキャンのたびに排水量を自動計算して mass も更新する
    // applyDisplacementToMass: 計算値→UIスライダー・physics.mass へ一括反映
    if (typeof applyDisplacementToMass === 'function') applyDisplacementToMass();
    else if (typeof updateDisplacementReadout === 'function') updateDisplacementReadout();

    console.log(
        `[HullScan] v12 | slices=${hp.slices.length}` +
        ` halfLen=${hp.halfLen.toFixed(2)} halfBeam=${hp.halfBeam.toFixed(2)}` +
        ` szX=${szX.toFixed(2)} szZ=${szZ.toFixed(2)} szY=${szY.toFixed(2)}` +
        ` hullHeight=${hullHeight.toFixed(2)}` +
        ` axis=${xIsForward ? 'X=bow' : 'Z=bow'}` +
        ` bowSign=${hp.bowSign}${hp.bowSign === -1 ? '(反転: 元+along側=船尾だったため座標反転済み)' : ''}` +
        ` wlY=${wlY.toFixed(2)} (minY=${minY.toFixed(2)} maxY=${maxY.toFixed(2)})` +
        ` bowTip=${hp.bowTipWidth.toFixed(2)} sternTip=${hp.sternTipWidth.toFixed(2)}` +
        ` bowTipAlongNorm=${hp.bowTipAlongNorm.toFixed(3)} sternTipAlongNorm=${hp.sternTipAlongNorm.toFixed(3)}`
    );
}

// ============================================================
//  排水量（displacement）自動計算
// ============================================================
//  scanHullProfile() で得た各スライスの「半幅(halfWidth)」と
//  「スキャン時喫水線までの深さ(draft)」から、現在の喫水線位置における
//  喫水線下の体積を近似計算し、排水量（トン）を推定する。
//
//  【近似方法】
//  各スライスの断面を「キールでゼロ幅、スキャン時喫水線(draft)でhalfWidthまで
//  sqrt状に広がるV型」とみなし、深さdepthでの実効半幅を
//    effHalfWidth = halfWidth * sqrt(min(1, depth/draft))
//  と近似する（多くの船型で見られる、キール付近が細く喫水線に向けて
//  急速に広がる断面形状に近い）。断面積は満載矩形の72%という経験的な
//  豊満度係数(船体中央〜端部の平均的なブロック係数相当)を掛ける。
//  スキャン時喫水線を超える深さ(浅い設定や大型化等)は側面がほぼ垂直という
//  仮定でhalfWidthのまま延長する。
//
//  船首・船尾・船体中部のどのスライスも対象にしているため、
//  船体形状（船首の細さ・船尾の絞り等）が自然に反映される。
// ============================================================

// ============================================================
//  精密排水量計算 — 多層積分版
// ============================================================
//  各スライスの断面を LAYERS 層に分割し、各層での実効幅を
//  scanHullProfile で収集した頂点データから直接推定する。
//
//  【断面幅の推定モデル】
//  船体断面は一般に「キール付近が細く喫水線に向かって急速に広がる」
//  形状を持つ。ここでは各層深度 d において：
//    - スキャン時喫水線(designWaterlineY)以下の部分:
//        effHalfW(d) = halfWidth * (d / draft)^BETA
//      ここで BETA=0.55 は一般的な商船の V 字〜U 字断面の中間値。
//      (BETA=0.5 → sqrt = 純V字, BETA=1.0 → 線形 = 完全U字)
//    - スキャン時喫水線より深い部分(draftOffsetが大きい等):
//        effHalfW = halfWidth (側面垂直近似)
//  層ごとに 2*effHalfW*layerH を積算して断面積を求め、sliceWidth を掛けて体積を得る。
//  LAYERS=40 層の積分により「断面近傍」ではなく
//  喫水線下の全体積を精密に近似できる。
// ============================================================
const DISP_LAYERS = 40; // 各スライスの深さ方向分割数
const DISP_BETA   = 0.55; // 断面形状指数 (0.5=V字, 1.0=U字)

// 喫水線下の体積（ローカル単位^3）を返す。localWaterlineY: モデル原点基準のローカルY座標。
// 【重要な修正】以前はこの関数だけ独自に「全スライス × DISP_LAYERS(40層)の
// 精密な数値積分」を使っていたが、実際にリアルタイム物理を計算する
// computeHullBuoyancyPhysics() は軽量化のため BUOY_SEG_COUNT(7)個の疎な
// サンプリングしか行っていない。この2つの積分方式が違うと、同じ喫水線
// 位置でも計算される体積がズレてしまい、「基準点ちょうどに質量を合わせた
// つもりでも、実際の物理はそこで釣り合わない」という不具合が起きる
// （船体形状が複雑な船ほどズレが大きく出た）。
// → 実際の物理計算と完全に同じサンプリング方式(BUOY_SEG_COUNT, 同じ
//   ループのインデックスの刻み方)に統一し、質量計算と実際の釣り合いが
//   ズレないようにした。
function computeSubmergedVolumeLocal(localWaterlineY) {
    const hp = window.hullProfile;
    if (!hp || !hp.ready || !hp.slices.length) return 0;
    const slices = hp.slices;
    const n = slices.length;
    const deltaZLocal = (2 * hp.halfLen) / BUOY_SEG_COUNT; // ローカル単位での区間幅（等幅ビン）

    let total = 0;
    for (const i of _buoySampleIndices(n)) {
        const sl = slices[i];
        if (sl.draft <= 0.0001 || sl.halfWidth <= 0) continue;
        const localKeelY = hp.designWaterlineY - sl.draft;
        const depthLocal = localWaterlineY - localKeelY; // 喫水線から見た全没水深
        if (depthLocal <= 0) continue;
        const area = _segSubmergedAreaLocal(sl.halfWidth, sl.draft, depthLocal);
        total += area * deltaZLocal;
    }
    return total;
}

// 現在の喫水線（draftOffset + waterlineOffsetY設定）における排水量をトンで返す。
// 海水密度1.025 t/m³で固定（「排水量は喫水線下体積の固定値でよい」というユーザー要望に対応し、
// 波による瞬間的な没水量変化は無視し、現在の設定値から一度だけ算出する想定）。
function estimateDisplacementTons() {
    const hp = window.hullProfile;
    if (!hp || !hp.ready) return null;
    const physScale = Math.max(0.25, physics.scale || 1);
    // 現在の喫水線のローカルY座標
    //  = waterlineOffsetY（喫水線基準点）+ draftOffset（ワールド単位）をローカル単位に変換して加算
    const localWaterlineY = physics.waterlineOffsetY + physics.draftOffset / physScale;
    const volumeLocal = computeSubmergedVolumeLocal(localWaterlineY);
    if (volumeLocal <= 0) return 0;
    const volumeWorldM3 = volumeLocal * physScale * physScale * physScale;
    const SEAWATER_DENSITY_T_PER_M3 = 1.025;
    return volumeWorldM3 * SEAWATER_DENSITY_T_PER_M3;
}

// 排水量(トン)から物理シミュ用のphysics.mass値を逆算するための換算係数。
// physics.mass の単位を「千トン」とみなす（デフォルト値1.5 ≒ 1500トン級の小型船）。
const MASS_TONS_PER_UNIT = 1000;

// 排水量を自動計算し、physics.massおよびUIスライダーへ反映する。
// 戻り値: 計算できた排水量(トン)。計算不可の場合はnull。
function applyDisplacementToMass() {
    const tons = estimateDisplacementTons();
    if (tons === null || !(tons > 0)) return null;
    const massSlider = $('mass-slider'), massNum = $('mass-num');
    let massVal = tons / MASS_TONS_PER_UNIT;
    if (massSlider) {
        const sliderMax = parseFloat(massSlider.max);
        const clamped = THREE.MathUtils.clamp(massVal, parseFloat(massSlider.min), sliderMax);
        if (clamped !== massVal) {
            console.warn(`[ShipConfig] 排水量${tons.toFixed(0)}トンがmassスライダーの上限` +
                `(${(sliderMax * MASS_TONS_PER_UNIT).toFixed(0)}トン相当)を超えたため切り詰められました。` +
                `喫水より浮き上がる場合はmass-sliderのmax属性を引き上げてください。`);
        }
        massVal = clamped;
    }
    physics.mass = massVal;
    if (massSlider) massSlider.value = massVal;
    if (massNum) massNum.value = massVal.toFixed(2);
    updateDisplacementReadout(tons);
    return tons;
}

// 排水量の読み取り専用表示を更新する（自動計算ボタン・各種スライダー変更時に呼ばれる）。
function updateDisplacementReadout(tonsOverride) {
    const el = $('displacement-readout');
    if (!el) return;
    const tons = (typeof tonsOverride === 'number') ? tonsOverride : estimateDisplacementTons();
    if (tons === null) {
        el.textContent = '推定排水量: モデル未スキャン';
    } else {
        el.textContent = `推定排水量: 約 ${Math.round(tons).toLocaleString()} トン（現在の喫水・船体形状から算出）`;
    }
}

// ============================================================
//  セグメント分割浮力（船首〜船尾の局所没水量から上下動・縦揺れ目標を求める）
// ============================================================
//  従来は「重心1点の喫水線サンプル」と「船首・船尾の波高サンプル2点」で
//  上下動／縦揺れの目標値を決めていたため、船体のどこが沈んでいて
//  どこが水面から離れているかが直接は反映されなかった。
//
//  ここでは scanHullProfile() で得た実際の船体形状（各スライスのhalfWidth・draft）
//  を再利用し、船体を BUOY_SEG_COUNT 個の区間に分けて「各区間が現在どれだけ
//  没水しているか」を断面積（閉形式の近似積分、ループ無し）で計算する。
//  これにより、船首が完全に水面から離れれば船首側の浮力だけが自然にゼロになり、
//  船尾が持ち上がりすぎれば船尾側だけが浮力を失う、という挙動が
//  船体形状から直接導かれる（追加コストは波高サンプリングを数回増やすだけで軽量）。
//
//  断面積の近似は estimateDisplacementTons() と同じ
//    effHalfW(d) = halfWidth * (d/draft)^DISP_BETA   (d<=draft)
//    effHalfW(d) = halfWidth                          (d>draft, 側面垂直近似)
//  を採用し、深さ0〜dの断面積は閉形式で積分する（多層ループ不要）。
// ============================================================
const BUOY_SEG_COUNT = 16; // サンプリングする区間数（軽量さ優先で少数に絞る）

// ─────────────────────────────────────────
//  _buoySampleIndices(n)
//  【修正】従来の `for (i=0; i<n; i+=step)` は必ず先頭(i=0)を拾う一方、
//  末尾側は step-1個分（最大でBUOY_SEG_COUNT分の1弱）取りこぼすことがあった。
//  船体形状は前後非対称（船首と船尾でテーパー形状が違う）なのが普通なので、
//  この「必ず片側から数え始める」サンプリングは浮力モーメント計算に一定方向
//  （常に船首寄り or 常に船尾寄り）のバイアスを生み、静水・無風でも船が
//  0.2〜0.5度ほど傾いたまま釣り合ってしまう原因になっていた
//  （＝重心を自動計算で合わせても解消しない系統誤差）。
//  全長をBUOY_SEG_COUNT個の等幅ビンに分け、各ビンの中心に最も近いスライスを
//  1つずつ選ぶことで、船首・船尾を対称に扱うようにする。
//  computeHullBuoyancyPhysics（このファイル）と、21-bow-stern-effects.js の
//  computeBowSubmergedVolume/computeBowDesignVolume/computeSternSubmergedVolume/
//  computeSternDesignVolume が共通で使う。
// ─────────────────────────────────────────
function _buoySampleIndices(n) {
    const idx = [];
    for (let bin = 0; bin < BUOY_SEG_COUNT; bin++) {
        idx.push(Math.min(n - 1, Math.floor((bin + 0.5) * n / BUOY_SEG_COUNT)));
    }
    return idx;
}

// 深さ depthLocal (ローカル単位, キールからの没水深) における断面積（ローカル単位^2）を
// 閉形式で返す。draft <= depthLocal の場合は側面垂直の延長分を加算する。
function _segSubmergedAreaLocal(halfWidth, draft, depthLocal) {
    if (depthLocal <= 0 || draft <= 0.0001 || halfWidth <= 0) return 0;
    const beta = DISP_BETA;
    const dClamped = Math.min(depthLocal, draft);
    let area = (2 * halfWidth * draft / (beta + 1)) * Math.pow(dClamped / draft, beta + 1);
    if (depthLocal > draft) area += 2 * halfWidth * (depthLocal - draft);
    return area;
}

// 【注】v? 以降、heave/pitchは下のcomputeHullBuoyancyPhysics（本物のρgV計算）に
// 置き換えられたため、この関数は現在main-loop.jsからは呼ばれていない（未使用）。
// 当面は参考用として残す。
// 船体形状ベースの浮力シグナルを返す。
//   effDisplacement : 旧来の「targetY - physics.y」に相当する上下動スプリング用の変位（ワールド単位）
//                      正＝設計喫水より深く沈んでいる（押し上げ方向）、負＝設計喫水より浮き上がっている
//   pitchSlope      : 旧来の「wavePitch」に相当する縦揺れ目標角の元になる傾き。
//                      【修正】従来は船体の「幾何中心」で前後に二分して差を取っていたため、
//                      実際の重心(cgOffset.z)が中心からズレている船では支点がズレて
//                      モーメントを正しく計算できず、船首が水に突っ込んだ後「いつまでも
//                      船尾が上がったまま」になる(復元モーメントが弱すぎ／符号がズレる)
//                      不具合があった。
//                      新実装: 各スライスの浮力偏差(biWorld)に「実際の重心からの距離」を
//                      掛けて積分し、浮力偏差の分布全体の重心位置(=LCB、水面と交わって
//                      いる範囲の平均位置に相当)が実際の重心からどれだけ・どちら側に
//                      離れているかを直接モーメントとして求める。これにより:
//                        ・重心位置 (cgOffset.z) を正しく支点として参照
//                        ・水面と交わっている範囲の浮力偏差を連続的に積分（二分法より正確）
//                        ・質量は呼び出し側のIPitch(=M×…)で割られる際に正しく効く
//                      ようになり、深く突っ込んだときほど大きな復元モーメントが働き、
//                      沈み込みながら船首が持ち上がる自然な動きになる。
function computeHullBuoyancySignal(cgWorldX, cgWorldZ, rotY, pitchAngle, shipY, waterlineYScaled, physScale, len, t, cgZScaled) {
    const hp = window.hullProfile;
    if (!hp || !hp.ready || hp.slices.length < 2) return null;

    const slices = hp.slices;
    const n = slices.length;
    const step = Math.max(1, Math.floor(n / BUOY_SEG_COUNT));
    const cgZ = cgZScaled || 0;

    let sumBAll = 0, sumAwpAll = 0;
    let sumBFront = 0, sumAwpFront = 0;
    let sumBBack = 0, sumAwpBack = 0;
    let sumMomentAboutCG = 0; // Σ biWorld * (実重心からの距離)
    let sumCurrentArea = 0, sumDesignArea = 0; // 没水割合算出用

    for (let i = 0; i < n; i += step) {
        const sl = slices[i];
        if (sl.draft <= 0.0001 || sl.halfWidth <= 0) continue;

        // v119-fix: 他の同種計算（computeHullBuoyancyPhysics等）と同じく
        // _wakeAxisRad(rotY)を経由させる（scanHullProfileの座標系からry補正が
        // 除去されたため、ここでも明示的に必要）。このコメント執筆時点で本関数
        // 自体は他から呼ばれていないが、一貫性のため直しておく。
        const totalRadSig = (typeof _wakeAxisRad === 'function') ? _wakeAxisRad(rotY) : rotY;
        const alongDistW = sl.alongNorm * len;
        const px = cgWorldX + Math.sin(totalRadSig) * alongDistW;
        const pz = cgWorldZ + Math.cos(totalRadSig) * alongDistW;
        const waveY = getWaveHeight(px, pz, t, true);

        // このスライスのキール（船底）のワールドY。ピッチによる縦方向の傾きを加味する。
        const baseKeelY = shipY - waterlineYScaled + (hp.designWaterlineY - sl.draft) * physScale;
        const keelY = baseKeelY - alongDistW * Math.sin(pitchAngle);

        const depthLocal = (waveY - keelY) / physScale;

        const areaCurrent = _segSubmergedAreaLocal(sl.halfWidth, sl.draft, Math.max(0, depthLocal));
        // ── バグ修正: areaDesign をユーザー設定喫水線基準に ──────────────────────
        // 旧実装: hp.designWaterlineY（スキャン時の推定喫水線）を基準に sl.draft を使用。
        // 問題: physics.waterlineOffsetY（スライダー値）と hp.designWaterlineY が
        //       ずれていると、平水時でも "浮力過剰 or 不足" と誤判定して沈み込む。
        // 修正: ユーザーの設定喫水線 (waterlineOffsetY + draftOffset/physScale) から
        //       キールまでの深さを "設計没水深" として使う。
        //       こうすると depthLocal == designDepthLocal のとき areaCurrent==areaDesign
        //       → effDisplacement==0 → 平水時に船が静止する。
        const userWLLocalY     = physics.waterlineOffsetY + physics.draftOffset / physScale;
        const designDepthLocal = userWLLocalY - (hp.designWaterlineY - sl.draft);
        const areaDesign       = _segSubmergedAreaLocal(sl.halfWidth, sl.draft, Math.max(0, designDepthLocal));

        const biWorld   = (areaCurrent - areaDesign) * physScale * physScale;
        const awpiWorld = 2 * sl.halfWidth * physScale;

        sumBAll += biWorld; sumAwpAll += awpiWorld;
        // 実際の重心(cgZ)を支点としたモーメント。重心より前(alongDistW>cgZ)の浮力過剰は
        // 船首を持ち上げる正のモーメント、重心より後ろは逆符号で効く。
        sumMomentAboutCG += biWorld * (alongDistW - cgZ);
        if (alongDistW >= cgZ) { sumBFront += biWorld; sumAwpFront += awpiWorld; }
        else                   { sumBBack  += biWorld; sumAwpBack  += awpiWorld; }
        // 没水割合算出: 各スライスの「今の没水面積 / 設計没水面積」を集計
        sumCurrentArea += Math.max(0, areaCurrent);
        sumDesignArea  += Math.max(0, areaDesign);
    }

    if (sumAwpAll < 1e-6) return null;

    const effDisplacement = sumBAll / sumAwpAll;
    const effDispFront = sumAwpFront > 1e-6 ? sumBFront / sumAwpFront : effDisplacement;
    const effDispBack  = sumAwpBack  > 1e-6 ? sumBBack  / sumAwpBack  : effDisplacement;

    // pitchSlope: 重心まわりの浮力モーメントから縦揺れ目標角を求める。
    // 【バグ修正】分母を len にすると大型船（len が大きい）ほど角度信号が小さくなり、
    // ピッチがほとんど出なかった。分母を max(3, len*0.4) にすることで
    // 大小どの船でも浮力差に比例した角度が出るようにする。
    const pitchRefLen   = Math.max(3.0, len * 0.4);
    const momentSignal  = sumMomentAboutCG / sumAwpAll; // 面積で正規化した「重心まわりの傾き信号」
    const pitchSlope    = Math.atan2(momentSignal, pitchRefLen);

    // effDispFront/Back を返してmain-loop側のバウプランジ閾値判定に使う
    // submergedFrac: 0=完全空中, 1=通常設計喫水での没水 （船首だけ水に入っていれば0〜1の中間値）
    const submergedFrac = sumDesignArea > 1e-6
        ? THREE.MathUtils.clamp(sumCurrentArea / sumDesignArea, 0, 1)
        : 0;
    return { effDisplacement, pitchSlope, effDispFront, effDispBack, submergedFrac };
}

// ============================================================
//  完全な浮力計算（アルキメデスの原理）── ρ・g・V を直接求める
// ============================================================
//  上のcomputeHullBuoyancySignalは「設計喫水との差分」を抽象的なバネ信号として
//  返すだけだったが、こちらは各スライスの没水断面積(_segSubmergedAreaLocalで
//  computeHullBuoyancySignalと同じ解析式を使用＝精度は同等)を実世界の長さ
//  (Δz, physScale²)で実際に積分し、本物の物理量を返す：
//
//    volSubmerged   : 実没水体積 [m³]（design基準の差分ではなく絶対量）
//    Awp            : 実水線面積 [m²]（静的復原力 K=ρ・g・Awp の算出に使用）
//    momentVolAboutCG: 実重心まわりの「体積×腕の長さ」[m⁴]（×ρ・g で縦揺れトルクになる）
//    IwpLong        : 水線面積の縦方向二次モーメント [m⁴]（縦メタセンタ半径
//                      BM_pitch = IwpLong / volSubmerged の算出や、減衰係数の
//                      基準剛性 K_pitch = ρ・g・IwpLong の算出に使用）
//    submergedFrac  : 0=完全空中 〜 1=設計喫水での通常没水（減衰のなめらかな
//                      on/offに使用。力の大きさ自体には使わない＝物理量はゼロから
//                      連続的に立ち上がるので人為的なon/off処理が不要になる）
//
//  呼び出し側(main-loop.js)では、これらに ρ_water・g を掛けるだけで
//  実際の力・トルクが得られる。「buoyancy」スライダーは、この実物理量に対する
//  倍率（既定1.0＝純粋な物理計算）として乗算する。
// ============================================================
function computeHullBuoyancyPhysics(cgWorldX, cgWorldZ, rotY, pitchAngle, shipY, waterlineYScaled, physScale, len, t, cgZScaled) {
    const hp = window.hullProfile;
    if (!hp || !hp.ready || hp.slices.length < 2) return null;

    const slices = hp.slices;
    const n = slices.length;
    const cgZ = cgZScaled || 0;
    const beta = DISP_BETA;

    // 【修正】このファイル内の他の関数（pushOutsideHull, updateHullSlicePositions,
    // _getHullDisplacement, getWakeHeightVisual, emitHullWakeParticles）と同じく、
    // ・totalRad = _wakeAxisRad(rotY) でスキャン座標系の向き補正を合わせ、
    // ・_hullOriginWorld() で「重心(cgOffset)がローカル原点からズレていても
    //   船体スキャン座標系(along/perp)の基準点が正しくワールド座標へ変換される」
    //   よう補正する。
    // これが抜けていたため、重心を前後・左右にずらすと浮力サンプリング位置だけが
    // 船体からズレ、ピッチ/ロール/上下動の物理計算が見た目の船体位置と合わなくなり、
    // 「重心を動かすと挙動がおかしくなる」原因になっていた。
    const totalRad = (typeof _wakeAxisRad === 'function') ? _wakeAxisRad(rotY) : rotY;
    const _origin  = (typeof _hullOriginWorld === 'function')
        ? _hullOriginWorld(cgWorldX, cgWorldZ, totalRad, physScale)
        : { x: cgWorldX, z: cgWorldZ };

    // 各サンプル区間が船体上で占める実世界での長さ[m]（等幅ビンなので一定）
    const deltaZWorld = (2 * len) / BUOY_SEG_COUNT;

    let volSubmerged = 0;        // m³
    let Awp = 0;                 // m²
    let momentVolAboutCG = 0;    // m⁴（× ρg でN・mのトルクになる）
    let IwpLong = 0;             // m⁴（減衰の基準剛性に使用）
    let sumCurrentArea = 0, sumDesignArea = 0; // submergedFrac算出用（従来通り）

    for (const i of _buoySampleIndices(n)) {
        const sl = slices[i];
        if (sl.draft <= 0.0001 || sl.halfWidth <= 0) continue;

        const alongDistW = sl.alongNorm * len;
        const px = _origin.x + Math.sin(totalRad) * alongDistW;
        const pz = _origin.z + Math.cos(totalRad) * alongDistW;
        // v105: 従来は excludeWake=true で船体が自身の引き波の影響を受けないように
        // していたが、「船首の引き波が船自身のピッチにも影響するように」という
        // 要望に基づき、ここだけ引き波を含めた水面高さを使うようにする。
        // これにより、船首が持ち上げた波が(伝播して)船体を押し上げ／沈める形で
        // ピッチにフィードバックされ、双方向の関係になる。
        const waveY = getWaveHeight(px, pz, t, false);

        const baseKeelY = shipY - waterlineYScaled + (hp.designWaterlineY - sl.draft) * physScale;
        const keelY = baseKeelY - alongDistW * Math.sin(pitchAngle);
        const depthLocal = (waveY - keelY) / physScale;

        const areaCurrent = _segSubmergedAreaLocal(sl.halfWidth, sl.draft, Math.max(0, depthLocal));
        const areaCurrentWorld = areaCurrent * physScale * physScale; // m²（実断面積）

        const dVi = areaCurrentWorld * deltaZWorld; // m³（この区間の実没水体積）
        volSubmerged += dVi;

        const awpiWorld = 2 * sl.halfWidth * physScale * deltaZWorld; // m²（この区間の実水線面積）
        Awp += awpiWorld;

        const arm = alongDistW - cgZ; // 実重心からの腕の長さ [m]
        momentVolAboutCG += dVi * arm;
        IwpLong += awpiWorld * arm * arm;

        // submergedFrac算出用（従来と同じ「設計喫水比」の参照）
        const userWLLocalY     = physics.waterlineOffsetY + physics.draftOffset / physScale;
        const designDepthLocal = userWLLocalY - (hp.designWaterlineY - sl.draft);
        const areaDesign       = _segSubmergedAreaLocal(sl.halfWidth, sl.draft, Math.max(0, designDepthLocal));
        sumCurrentArea += Math.max(0, areaCurrent);
        sumDesignArea  += Math.max(0, areaDesign);
    }

    const submergedFrac = sumDesignArea > 1e-6
        ? THREE.MathUtils.clamp(sumCurrentArea / sumDesignArea, 0, 1)
        : 0;

    return { volSubmerged, Awp, momentVolAboutCG, IwpLong, submergedFrac };
}

// ─────────────────────────────────────────
//  _wakeAxisRad()
//  モデルの実際の「船首方向」をワールド座標系で返す。
//
//  v119-fix: scanHullProfile() は invGroupMat に modelOffset.ry の逆回転を
//  合成するようになったため、relMat = invGroupMat * node.matrixWorld は
//  常に「ry=0相当、船体本来の向き」の座標系になった（xIsForward判定・輪切り
//  平面のいずれも、ryの値に関わらず安定する）。
//  この変更に伴い、ここで改めて modelOffset.ry の分を明示的に足す必要がある
//  （旧v118までは「ryは既にスキャン座標系に反映済み」だったため、ここで
//  足すと二重加算になっていたが、v119以降はスキャン座標系からryが除去された
//  ため、逆に足さないと引き波の向きが実際の船体の向きとズレる）。
//
//  xIsForward=true: スキャン座標のX+=船首
//    → Three.jsのZ+=0°基準なので、heading=0のとき船首はX+方向
//    → totalRad に +π/2 を足すと sin(π/2)=1,cos(π/2)=0 → X+方向 ✓
//  xIsForward=false: スキャン座標のZ+=船首（通常）
//    → 補正不要
// ─────────────────────────────────────────
function _wakeAxisRad(headingRad) {
    const hp   = window.hullProfile;
    let axisCorr = hp.xIsForward ? Math.PI * 0.5 : 0;
    // v120: scanHullProfile()がbowSign=-1（+along側が実は船尾だったモデル）の
    // 場合に船体本体の座標(pts[].x/z)そのものを反転しているため、以後「+along」
    // が指す実体は元のローカル軸から180°反転している。このワールド角度計算も
    // 同じ180°を足して揃えないと、位置(along/alongNorm)は正しい船首を指す一方で
    // 波源等のワールド向きだけ反対のまま、という食い違いが起きる。
    if (hp.bowSign === -1) axisCorr += Math.PI;
    const ryRad = (typeof modelOffset !== 'undefined' && modelOffset && typeof modelOffset.ry === 'number')
        ? modelOffset.ry * Math.PI / 180 : 0;
    return headingRad + ryRad + axisCorr;
}

// ─────────────────────────────────────────
//  _hullOriginWorld(cgWX, cgWZ, rotRad, physScale)
//
//  【重心を動かすと引き波・エフェクトだけが「置いていかれる」問題の修正】
//  scanHullProfile()が生成するalong/perp座標（hp.slices[].alongNorm等）は、
//  重心(physics.cgOffset)ではなく importedModelGroup のローカル原点(0,0,0)を
//  基準にしている。一方 physics.cgWorldX/Z は「重心」のワールド座標であり、
//  cgOffset.x/zが(0,0)でない場合はローカル原点のワールド座標とはズレる。
//
//  このファイル内の各所（pushOutsideHull, updateHullSlicePositions,
//  _getHullDisplacement, getWakeHeightVisual, emitHullWakeParticles,
//  computeHullBuoyancyPhysics等）は、いずれも「船体ローカル座標 ⇔ ワールド座標」
//  の変換をcgWorldX/Zを基準点として行っている。cgOffset.x/zが0のときはこれで
//  問題ないが、ユーザーが重心を前後・左右にずらすと、船体メッシュ自体は
//  （reanchorWorldPositionForPinOffsetChangeにより）正しい位置にとどまるのに、
//  この変換だけが古いズレのない前提のまま計算されるため、引き波・水面押しのけ・
//  浮力サンプリング位置などがすべて船体に対してズレてしまう
//  （＝船体だけが正しく見えて、それ以外のエフェクトが「置いていかれる」ように見える）。
//
//  対策: cgWorldX/Zから、現在のcgOffset.x/zをワールド回転・スケールした分を
//  差し引き、「船体ローカル原点」の本当のワールド座標を求めて返す。以後の
//  along/perp変換はこの補正済み原点を基準にする。
// ─────────────────────────────────────────
function _hullOriginWorld(cgWX, cgWZ, rotRad, physScale) {
    const WS = physScale || 1;
    const sin = Math.sin(rotRad), cos = Math.cos(rotRad);
    const cgXW = (physics.cgOffset.x || 0) * WS;
    const cgZW = (physics.cgOffset.z || 0) * WS;
    return {
        x: cgWX - (cgXW * cos + cgZW * sin),
        z: cgWZ - (-cgXW * sin + cgZW * cos),
    };
}

// ─────────────────────────────────────────
//  _hullHalfWidthAtNorm(alongNorm)
//  指定した along位置（-1=船尾〜+1=船首）における船体喫水線の
//  半幅（ローカル単位、physics.scale適用前）を隣接スライス間で線形補間して返す。
//  範囲外は両端のスライス値でクランプ（先端より前・末端より後ろは外挿しない）。
//  パーティクルを「船体と水面の境界に沿わせる」ための基準値として使う。
// ─────────────────────────────────────────
// v113-fix: 最後の通常スライスより外側（船首/船尾のごく先端付近）は、
// 従来は最後のスライスの値でそのままクランプしており、実際には船体が
// 先細りして0に近づいているはずの区間で幅が水平に保持されたままだった。
// これにより白波・引き波のマスク判定（このalongNorm範囲では船体がまだ
// 「その幅で」存在すると判定される）が甘くなり、水面の泡が実際の船体
// 輪郭より前方まで飛び出て見える原因になっていた（Olympic実測で確認）。
// scanHullProfileは既に実測の船首/船尾タイポイント(hp.bowTipAlongNorm/
// hp.bowTipWidth、hp.sternTipAlongNorm/hp.sternTipWidth)を持っているので、
// 最後の通常スライスからそのタイポイントへ向けて線形に減衰させ、
// タイポイントより外側は0を返す。
function _hullHalfWidthAtNorm(alongNorm) {
    const hp = window.hullProfile;
    if (!hp.ready || hp.slices.length === 0) return hp.halfBeam || 1.5;
    const slices = hp.slices;
    const first = slices[0], last = slices[slices.length - 1];
    if (alongNorm >= last.alongNorm) {
        const tipNorm  = (typeof hp.bowTipAlongNorm === 'number') ? hp.bowTipAlongNorm : last.alongNorm;
        const tipWidth = (typeof hp.bowTipWidth === 'number') ? hp.bowTipWidth : last.halfWidth;
        if (alongNorm >= tipNorm) return (tipNorm > last.alongNorm) ? 0 : tipWidth;
        const span = tipNorm - last.alongNorm;
        const tt = span > 1e-6 ? (alongNorm - last.alongNorm) / span : 0;
        return last.halfWidth * (1 - tt) + tipWidth * tt;
    }
    if (alongNorm <= first.alongNorm) {
        const tipNorm  = (typeof hp.sternTipAlongNorm === 'number') ? hp.sternTipAlongNorm : first.alongNorm;
        const tipWidth = (typeof hp.sternTipWidth === 'number') ? hp.sternTipWidth : first.halfWidth;
        if (alongNorm <= tipNorm) return (tipNorm < first.alongNorm) ? 0 : tipWidth;
        const span = first.alongNorm - tipNorm;
        const tt = span > 1e-6 ? (alongNorm - tipNorm) / span : 0;
        return tipWidth * (1 - tt) + first.halfWidth * tt;
    }
    for (let i = 0; i < slices.length - 1; i++) {
        const a = slices[i], b = slices[i + 1];
        if (alongNorm >= a.alongNorm && alongNorm <= b.alongNorm) {
            const span = b.alongNorm - a.alongNorm;
            const tt = span > 1e-6 ? (alongNorm - a.alongNorm) / span : 0;
            return a.halfWidth * (1 - tt) + b.halfWidth * tt;
        }
    }
    return hp.halfBeam;
}

// ───────────────────────────────────────
//  _hullWetHalfWidthAtNorm(alongNorm, side)
//
//  v165: 「今この瞬間の」喫水線の半幅（ローカル単位、physics.scale適用前）と
//  その場所の濡れ具合(0〜1)を返す。
//
//  _hullHalfWidthAtNorm() が返すのは静的な設計喫水での半幅で、ロール・ピッチ・
//  ヒーブ・波による喫水線の変化を一切含まない。一方、水面シェーダーの泡帯は
//  updateHullWaterlinePolygon()（04-scene-and-water-init.js）が毎フレーム計算する
//  実喫水線の輪郭を使う。両者が別の輪郭を指していたため、船が傾いたり波に
//  乗ったりすると喫水線の泡パーティクルだけが実際の喫水線から外へはみ出したり、
//  内側へ入り込んだりしていた（ユーザー報告の症状）。
//  ここで同じテーブル(window._hullWaterlineDyn)を参照し、両者の輪郭を一致させる。
//
//  テーブルが未生成（モデル未ロード、スキャン直後の1フレーム目など）の場合は
//  従来どおり静的な設計喫水値へフォールバックする。
// ───────────────────────────────────────
function _hullWetHalfWidthAtNorm(alongNorm, side) {
    const staticHw = _hullHalfWidthAtNorm(alongNorm);
    const d = window._hullWaterlineDyn;
    if (!d || !d.ready || d.n < 2) return { hw: staticHw, wet: 1 };

    const aArr = d.alongNorm;
    const hwArr  = (side >= 0) ? d.hwStbd  : d.hwPort;
    const wetArr = (side >= 0) ? d.wetStbd : d.wetPort;
    const N = d.n;

    // alongNormは昇順（船尾→船首）。範囲外は両端でクランプするが、
    // 先端より外側は _hullHalfWidthAtNorm と同じく「幅0へ収束する」扱いに
    // したいので、静的な値との小さい方を採る。
    if (alongNorm <= aArr[0])      return { hw: Math.min(staticHw, hwArr[0]),     wet: wetArr[0] };
    if (alongNorm >= aArr[N - 1])  return { hw: Math.min(staticHw, hwArr[N - 1]), wet: wetArr[N - 1] };
    for (let i = 0; i < N - 1; i++) {
        if (alongNorm >= aArr[i] && alongNorm <= aArr[i + 1]) {
            const span = aArr[i + 1] - aArr[i];
            const tt = span > 1e-9 ? (alongNorm - aArr[i]) / span : 0;
            return {
                hw:  hwArr[i]  + (hwArr[i + 1]  - hwArr[i])  * tt,
                wet: wetArr[i] + (wetArr[i + 1] - wetArr[i]) * tt,
            };
        }
    }
    return { hw: staticHw, wet: 1 };
}
window._hullWetHalfWidthAtNorm = _hullWetHalfWidthAtNorm;

// ─────────────────────────────────────────
//  _hullFlareAngleAtNorm(alongNorm)
//  _hullHalfWidthAtNorm()と同じ方式で、指定したalongNorm位置における
//  船体のフレア角度[度]を、両隣のスライスのslice.flareAngleから線形補間して返す。
//  水しぶきの放出方向を「船体のその場所の実際のフレア形状」に合わせるために使う
//  （船首先端だけでなく、船体前部のどの場所でも局所的なフレア度合いを参照できる）。
// ─────────────────────────────────────────
function _hullFlareAngleAtNorm(alongNorm) {
    const hp = window.hullProfile;
    if (!hp.ready || hp.slices.length === 0) return 30; // 未スキャン時の妥当な既定値
    const slices = hp.slices;
    if (alongNorm <= slices[0].alongNorm) return slices[0].flareAngle;
    const last = slices[slices.length - 1];
    if (alongNorm >= last.alongNorm) return last.flareAngle;
    for (let i = 0; i < slices.length - 1; i++) {
        const a = slices[i], b = slices[i + 1];
        if (alongNorm >= a.alongNorm && alongNorm <= b.alongNorm) {
            const span = b.alongNorm - a.alongNorm;
            const tt = span > 1e-6 ? (alongNorm - a.alongNorm) / span : 0;
            return a.flareAngle * (1 - tt) + b.flareAngle * tt;
        }
    }
    return 30;
}

// ─────────────────────────────────────────
//  pushOutsideHull(px, pz, marginWorld)
//  ワールド座標(px,pz)が現在の船体（喫水線断面を船首尾方向に押し出した形状）の
//  内側にあれば、最短距離で外側（marginWorld分の余白付き）へ押し出した{x,z}を
//  返す。船体の前後長さの範囲外、またはhullProfile未スキャン時はそのまま返す。
//
//  航跡泡・水しぶき・気泡など、水面〜船体付近で発生するエフェクトが船体メッシュの
//  内部に描画されてしまう問題を防ぐための共通の最終チェック。emitHullWakeProfile
//  と同じ「船体ローカル座標(along/perp)へ投影→_hullHalfWidthAtNormで外縁を取得」
//  というロジックを再利用し、エフェクトの種類を問わず一貫して適用できるようにした。
//
//  注意: これは喫水線の左右の広がり(along方向ごとの半幅)のみを見た2次元的な
//  判定であり、上下方向（甲板上の上部構造物の幅など）は考慮していない。
//  そのため、煙突から出る煙のように船体よりずっと高い位置にあるエフェクトに
//  そのまま適用すると、実際には船体に重なっていないのに不要に押し出されて
//  しまう可能性がある。呼び出し側で「水面付近にあるエフェクトにだけ適用する」
//  といった高さ方向のガードを別途行うこと。
// ─────────────────────────────────────────
function pushOutsideHull(px, pz, marginWorld) {
    const hp = window.hullProfile;
    if (!hp || !hp.ready || !hp.slices.length) return { x: px, z: pz, pushed: false };
    const WS = (physics && physics.scale) ? physics.scale : 1;
    const halfLenW = hp.halfLen * WS;
    if (halfLenW < 1e-6) return { x: px, z: pz, pushed: false };
    const headingRad = (physics.heading * Math.PI) / 180;
    const totalRad   = _wakeAxisRad(headingRad);
    const sinT = Math.sin(totalRad), cosT = Math.cos(totalRad);
    const _origin = _hullOriginWorld(physics.cgWorldX, physics.cgWorldZ, totalRad, WS);
    const cx0 = _origin.x, cz0 = _origin.z;
    const dx = px - cx0, dz = pz - cz0;
    const along = sinT * dx + cosT * dz;
    const perp  = cosT * dx - sinT * dz;
    if (Math.abs(along) > halfLenW * 1.02) return { x: px, z: pz, pushed: false };
    const alongNorm = THREE.MathUtils.clamp(along / halfLenW, -1, 1);
    // v165: 押し出しの基準も「今この瞬間の実喫水線」に揃える。設計喫水の
    // 静的な半幅で押し出していたため、船が傾いて片舷が浮き上がっている
    // ときに、実際の喫水線よりずっと外側まで泡が押し出されてしまい、
    // 船体から浮いた位置に泡の列が残っていた。
    const sideSign = perp >= 0 ? 1 : -1;
    const hwLocal = ((typeof _hullWetHalfWidthAtNorm === 'function')
        ? _hullWetHalfWidthAtNorm(alongNorm, sideSign).hw
        : _hullHalfWidthAtNorm(alongNorm)) * WS;
    const limit = hwLocal + (marginWorld || 0);
    if (Math.abs(perp) >= limit) return { x: px, z: pz, pushed: false };
    const newX = cx0 + sinT * along + cosT * sideSign * limit;
    const newZ = cz0 + cosT * along - sinT * sideSign * limit;
    return { x: newX, z: newZ, pushed: true };
}
window.pushOutsideHull = pushOutsideHull;

// ─────────────────────────────────────────
//  updateHullSlicePositions()  — 毎フレーム呼出
// ─────────────────────────────────────────
function updateHullSlicePositions() {
    const hp = window.hullProfile;
    if (!hp.ready || hp.slices.length === 0) return;

    const headingRad = (physics.heading * Math.PI) / 180;
    const totalRad   = _wakeAxisRad(headingRad);
    const sinT = Math.sin(totalRad);
    const cosT = Math.cos(totalRad);

    // hp.halfLen はモデルローカル座標系（shipGroup基準、physics.scale適用前）の値。
    // ワールド座標(cgWorldX/Z)と足し算するには physics.scale を掛けて実スケールに
    // 変換する必要がある（v12修正: これが抜けていたため引き波が船の中心付近に
    // 集まってしまい、船体サイズと合わなくなっていた）。
    const WS = (physics && physics.scale) ? physics.scale : 1;

    // 重心(cgOffset)がローカル原点からズレていても、船体スキャン座標系(along/perp)の
    // 基準点が正しくワールド座標へ変換されるよう補正する。
    const _origin = _hullOriginWorld(physics.cgWorldX, physics.cgWorldZ, totalRad, WS);
    const cx = _origin.x;
    const cz = _origin.z;

    for (const sl of hp.slices) {
        const d = sl.alongNorm * hp.halfLen * WS;
        sl.worldX = cx + sinT * d;
        sl.worldZ = cz + cosT * d;
    }
}

// ─────────────────────────────────────────
//  _getHullDisplacement(wx, wz)
//  現在の船体喫水線形状に基づき、観測点(wx,wz)が船体内部にあれば
//  水面を押しのける量（負値）を返す。船体外部は 0。
//  喫水線の「ふち」では滑らかにブレンドして段差をなくす。
// ─────────────────────────────────────────
function _getHullDisplacement(wx, wz) {
    const hp = window.hullProfile;
    if (!hp.ready || hp.slices.length === 0) return 0;

    const WS = (physics && physics.scale) ? physics.scale : 1;

    // 早期チェック: 船のキール（船底）が水面より明らかに上なら押しのけゼロ。
    // これがないと空中飛行中も水面頂点が押しのけられてしまい、
    // 水面グラフィック上で「空中なのに水が凹む」バグが起きる。
    // window._physicsWaveY: メインループで毎フレーム更新される重心位置での波高。
    // キール高さの近似: physics.y - waterlineYScaled - totalDraft * WS
    {
        const wlY       = (physics.waterlineOffsetY || 0) * WS;
        const keelApprox = physics.y - wlY - hp.totalDraft * WS;
        const waveRef    = window._physicsWaveY || 0;
        // キールが水面より 20cm以上（スケール比例）上にあれば即終了
        if (keelApprox > waveRef + 0.2 * WS) return 0;
    }

    const halfLenW = hp.halfLen * WS;

    const headingRad = (physics.heading * Math.PI) / 180;
    const totalRad   = _wakeAxisRad(headingRad);
    const sinT = Math.sin(totalRad), cosT = Math.cos(totalRad);
    const _origin = _hullOriginWorld(physics.cgWorldX, physics.cgWorldZ, totalRad, WS);
    const originX = _origin.x, originZ = _origin.z;

    // 観測点を船体ローカル座標（前後軸・横軸）へ投影
    const dx = wx - originX, dz = wz - originZ;
    const along =  sinT * dx + cosT * dz;  // 船首方向正
    const perp  =  cosT * dx - sinT * dz;  // 右舷方向正

    // 船体長さ範囲外は即スキップ
    if (Math.abs(along) > halfLenW * 1.05) return 0;

    // alongNorm に対応するスライスを補間して喫水線幅を求める
    const alongNorm = along / halfLenW;
    const slices = hp.slices;
    let hwLocal = hp.halfBeam; // フォールバック
    let draft   = hp.totalDraft * WS;

    // 隣接2スライス間を線形補間して hw/draft を取得
    // （1点最近傍だと外輪スライス境界でステップ状の誤判定が起きる）
    let sl0 = slices[0], sl1 = slices[0];
    let bestD0 = Infinity, bestD1 = Infinity;
    for (const sl of slices) {
        const d = sl.alongNorm - alongNorm;  // 符号付き距離
        if (d >= 0 && d < bestD0) { bestD0 = d; sl0 = sl; }  // 前側（船首寄り）
        if (d <  0 && -d < bestD1) { bestD1 = -d; sl1 = sl; } // 後側（船尾寄り）
    }
    // sl0(前側)とsl1(後側)の間で線形補間
    const totalD = bestD0 + bestD1;
    const t01 = totalD > 1e-6 ? bestD0 / totalD : 0.5;  // t01=0→sl0側, 1→sl1側
    hwLocal = (sl0.halfWidth * (1 - t01) + sl1.halfWidth * t01) * WS;
    const draftRaw = sl0.draft * (1 - t01) + sl1.draft * t01;
    draft   = draftRaw * WS;
    if (draft < 0.01) return 0;

    // 喫水線幅からの距離で押しのけ深さを決定
    // ウォーターラインパーティクルは外縁(perpRatio=1.0)の外側に放出されるため、
    // 凹みはそれより少し内側(perpRatio≦0.88)に収めることでパーティクルと自然につながる。
    const perpRatio = Math.abs(perp) / (hwLocal + 1e-6);
    if (perpRatio > 1.10) return 0;  // 外縁の10%外側まで許容（hw過小評価対策）

    // 長手方向ふちブレンド（船首尾は0.82から滑らかにフェード）
    const lenRatio = Math.abs(alongNorm);
    const lenBlend = lenRatio < 0.82
        ? 1.0
        : THREE.MathUtils.clamp(1.0 - (lenRatio - 0.82) / 0.22, 0, 1);

    // 横方向ふちブレンド: 外縁の80%以内は最大凹み、そこから外縁(100%)でゼロに
    // → パーティクルの発生位置(外縁付近)に向けて凹みが消え、段差なく接続される
    const perpBlend = perpRatio < 0.80
        ? 1.0
        : THREE.MathUtils.clamp(1.0 - (perpRatio - 0.80) / 0.30, 0, 1);

    // スムーズステップで凹みをさらになだらかに（エッジの段差をなくす）
    const blendFactor = lenBlend * perpBlend;
    const smooth = blendFactor * blendFactor * (3.0 - 2.0 * blendFactor);

    // 凹み量を0.18倍に抑制：ほぼ平らに保ちつつ軽い凹みだけ残す
    return -draft * 0.18 * smooth;
}

// ─────────────────────────────────────────
//  getWakeHeightVisual(wx, wz, t)
// ─────────────────────────────────────────
function getWakeHeightVisual(wx, wz, t) {
    const hp = window.hullProfile;
    if (!hp.ready || shipHistory.length < 2) return { y: 0, foam: 0 };

    // Three.js空間での実スケール比（autoScaleで12unitに正規化されている）
    const scaleRatio = hp.halfLen / 6.0;
    const halfLen    = hp.halfLen;   // ローカル単位（mscale等の見た目比率計算に使う）
    const halfBeam   = hp.halfBeam;  // ローカル単位

    // ワールド座標（cgWorldX/Z, wx, wz）と比較・加算するための実スケール変換版。
    // physics.scale（shipGroupのスケール = 1ローカル単位あたりの実メートル）を
    // 掛けないと、引き波の発生位置が船体の見た目サイズと一致しない（v12修正）。
    const WS      = (physics && physics.scale) ? physics.scale : 1;
    const halfLenW  = halfLen  * WS;
    const halfBeamW = halfBeam * WS;

    // ── 船体直下の水面押しのけ ──
    // 喫水線形状に基づいて船体内部の水面頂点を押し下げる。
    // 引波計算より先に返すことで波形との競合を避ける。
    // ※ hullDisp は「その瞬間の海面（波の高さ）を基準にした押しのけ量」にする。
    //   呼び出し元 updateWater() が waveData.height + wake.y を posAttr.setY するため、
    //   ここでは { y: hullDisp, foam:0 } を返すと
    //   頂点Y = getWaveCrestAndHeight().height + hullDisp になる（波に乗った凹み）。
    const hullDisp = _getHullDisplacement(wx, wz);
    if (hullDisp < -0.005) {
        return { y: hullDisp, foam: 0 };
    }

    let totalY    = 0.0;
    let totalFoam = 0.0;

    const histLen = shipHistory.length;
    // 直近は密に（細かい波を再現）、古いほど粗く（遠くの波は粗くていい）
    // インデックスをlogスケールで選ぶことで、14点固定より滑らかな波を実現
    const histSamples = [];
    {
        const maxSamples = 20;  // 従来14→20に増やして滑らかに
        const recent = Math.min(histLen, 8); // 直近8点は必ず全部使う
        for (let i = 0; i < recent; i++) histSamples.push(histLen - 1 - i);
        // 残りは対数的に間引き
        const older = histLen - recent;
        if (older > 0) {
            const extraSlots = maxSamples - recent;
            for (let s = 1; s <= extraSlots; s++) {
                const ratio = s / extraSlots;
                const idx = histLen - recent - Math.floor(older * ratio);
                if (idx >= 0 && !histSamples.includes(idx)) histSamples.push(idx);
            }
        }
    }

    for (let si = 0; si < histSamples.length; si++) {
        const p   = shipHistory[histSamples[si]];
        const spd = Math.abs(p.speed);
        if (spd < 0.3) continue;

        const age = t - p.t;
        if (age <= 0 || age > 14.0) continue;

        const ageDecay = Math.exp(-age * (0.22 / scaleRatio));
        if (ageDecay < 0.002) continue;

        const totalRad = _wakeAxisRad(p.headingRad);
        const sinT = Math.sin(totalRad);
        const cosT = Math.cos(totalRad);
        // この履歴サンプル記録時点の重心ワールド座標(p.x/p.z)から、
        // 船体スキャン座標系の基準点（ローカル原点）のワールド座標を補正して求める。
        const _origin = _hullOriginWorld(p.x, p.z, totalRad, WS);
        const originX = _origin.x, originZ = _origin.z;

        // 深水波パラメータ
        // ワールド座標(cgWorldX/Z, wx/wz)は physics.scale により実メートル相当の
        // スケールになっている（shipGroup.scale = physics.scale）ため、
        // 1 Three.jsワールド単位 ≈ 1mとしてそのまま実距離として扱える。
        // （v12修正: 以前は metersPerUnit という近似定数で変換していたが、
        //  これは halfLen/halfBeam にワールドスケールを掛け忘れていた旧バグを
        //  別の不正確な近似で部分的に打ち消していたものなので廃止）
        const V          = spd * 0.514;           // knots→m/s
        const g          = 9.81;
        const lambdaPhys = 2.0 * Math.PI * V * V / g;  // 実波長 [m] = ワールド単位
        // 波長の上限を halfLenW*0.8 に抑えて、船首〜船尾スライス間で明確な位相差が出るようにする
        const lambda     = THREE.MathUtils.clamp(lambdaPhys, halfLenW * 0.04, halfLenW * 0.8);
        const k          = 2.0 * Math.PI / lambda;
        const waveSpeed  = Math.sqrt(g * lambdaPhys / (2.0 * Math.PI));  // [m/s] = [ワールド単位/s]

        const nSlices   = hp.slices.length;
        if (nSlices === 0) continue;
        // スライスは均等に最大16点サンプル（従来14→16）
        // 船首/中央/船尾のスライスは必ず含める
        const sliceStep = Math.max(1, Math.floor(nSlices / 16));

        for (let si = 0; si < nSlices; si += sliceStep) {
            const sl = hp.slices[si];

            // この履歴フレームの波源位置（ワールド単位）
            const alongDist = sl.alongNorm * halfLenW;
            const srcX = originX + sinT * alongDist;
            const srcZ = originZ + cosT * alongDist;

            const dx = wx - srcX;
            const dz = wz - srcZ;
            const d2 = dx * dx + dz * dz;

            const maxD = waveSpeed * age * 2.8 + halfBeamW * 3.0;
            if (d2 > maxD * maxD) continue;

            const d = Math.sqrt(d2);
            if (d < 0.02) continue;

            // 観測点→波源の方向角 vs 進行方向
            const angleToVert = Math.atan2(dx, dz);
            const relAngle    = Math.abs(normalizeAngle(angleToVert - p.headingRad));

            // ── 船首ボウウェーブ (alongNorm > 0.5、前方先端のみ) ──
            if (sl.alongNorm > 0.5) {
                // 進行方向前方 ±52° のみ（絞って横漏れ防止）
                if (relAngle > Math.PI * 0.52) continue;

                const waveRadius  = waveSpeed * age;
                // distToFront > 0 = 波紋の外側（船体前方）のみ有効
                // 内側は0.3波長まで許容（段差防止、ただし以前より厳しく）
                const distToFront = d - waveRadius;
                if (distToFront < -lambda * 0.3) continue;
                const absDistToFront = Math.abs(distToFront);
                if (absDistToFront > lambda * 1.0) continue;

                // 観測点が波源より前方にある場合のみ
                const obsProjAlong = sinT * dx + cosT * dz; // 観測点の波源相対along
                if (obsProjAlong < -halfBeamW * 0.3) continue;

                // 波源（船体中心線）からの横方向距離
                const perpToSrc = Math.abs(cosT * dx - sinT * dz);
                const hwWS = sl.halfWidth * WS;
                // 横方向: 船体ラインから外側への広がりを抑制（シャープな肩波）
                // 時間経過に伴う拡散は最小限（age * 0.10）にして細い波を維持
                const lateralLimit = hwWS * 1.3 + waveSpeed * age * 0.10 + halfBeamW * 0.2;
                if (perpToSrc > lateralLimit) continue;

                // 横方向ガウシアン: sigmaを狭く(0.18)してシャープな稜線を作る
                const lateralSigma = hwWS * 0.18 + halfBeamW * 0.07 + 0.03;
                const edgeDist     = perpToSrc - hwWS;
                const lateralEnv   = Math.exp(-(edgeDist * edgeDist) / (2.0 * lateralSigma * lateralSigma));

                // 船首先端より前は急速に減衰（obsProjAlong > 0 でほぼゼロにする）
                // スケール係数を小さく(0.6)して船体ライン上でのみ盛り上がるように
                const frontFade = obsProjAlong > halfBeamW * 0.5
                    ? Math.exp(-(obsProjAlong - halfBeamW * 0.5) / (halfBeamW * 0.6 + 0.2))
                    : 1.0;

                // 振幅: 速度の2乗成分を加えて高速時に「めくり上げる」ような
                // 急激な盛り上がりを表現（実際の船の航走波もv^2に近い成長をする）。
                // フレア角の影響も強めて、外側に張った船体ほど水を持ち上げやすくする。
                const bowAmp = (spd * 0.018 + spd * spd * 0.0018) * scaleRatio
                             * (sl.halfWidth / (halfBeam + 0.001))
                             * (1.0 + sl.flareAngle * 0.014)
                             * ageDecay
                             * lateralEnv
                             * frontFade;
                if (bowAmp < 0.0004) continue;

                const h = bowAmp
                        * Math.sin(distToFront * k)
                        * Math.exp(-absDistToFront / (lambda * 0.45));
                totalY    += h;
                // 泡（白波）はこの肩波に強めに乗せる：船首が水をめくり上げる
                // 白いカール部分を視認しやすくする。
                if (h > 0.0025) totalFoam += Math.abs(h) * 1.1;
                continue;
            }

            // ── ケルビン引き波 (後方、relAngle > π*0.50) ──
            if (relAngle < Math.PI * 0.50) continue;

            const isStern = sl.alongNorm < -0.3;
            const waveRadius        = waveSpeed * age;
            const distToWaveFront   = d - waveRadius;
            const absDistToWaveFront = Math.abs(distToWaveFront);
            const spread = isStern ? 2.8 : 1.5;
            if (absDistToWaveFront > lambda * spread) continue;

            const decayDist = isStern
                ? halfLenW * 9.0 + 1.0
                : halfLenW * 3.5 + 1.0;

            const amp = spd * 0.020 * scaleRatio
                      * (sl.halfWidth / (halfBeam + 0.001))
                      * (1.0 + sl.flareAngle * 0.006)
                      * ageDecay
                      * Math.max(0, 1.0 - d / decayDist)
                      * Math.max(0, 1.0 - age / 14.0);
            if (amp < 0.0003) continue;

            // ケルビン角フィルタ
            const theta       = Math.PI - relAngle;
            const kelvinAngle = 0.3398;  // 19.47°
            const angleDist   = theta - kelvinAngle;
            const divEnv      = Math.exp(-angleDist * angleDist * (isStern ? 20.0 : 14.0));
            const tranEnv     = Math.exp(-theta * theta * 4.0) * (isStern ? 0.55 : 0.3);
            const angleEnv    = divEnv + tranEnv;
            if (angleEnv < 0.001) continue;

            const h = amp * Math.sin(distToWaveFront * k) * angleEnv;
            totalY += h;

            if (Math.abs(h) > 0.007 && absDistToWaveFront < lambda * 0.9) {
                totalFoam += (Math.abs(h) / (lambda * 0.04 + 0.01))
                           * angleEnv
                           * (7.0 + spd * 0.3)
                           * (isStern ? 1.0 : 0.4);
            }
        }
    }

    const maxRise = scaleRatio * 1.4;
    const maxSink = scaleRatio * 0.10;
    return {
        y    : THREE.MathUtils.clamp(totalY, -maxSink, maxRise),
        foam : Math.min(1.0, totalFoam),
    };
}

// ─────────────────────────────────────────
//  emitHullWakeParticles(t, dt)  v3
//  【v13 変更点】
//  ・先端/末端/喫水線全体のすべての放出位置を、船体喫水線の実際の
//    外縁（_hullHalfWidthAtNorm() で補間取得）から「huggingRadius」
//    （≒パーティクル半径分）だけ外側、に統一。
//    以前は放出タイプごとに hw*0.6 や hw*1.0 など倍率がバラバラで、
//    特に船首先端のbowSplashは外縁より内側に放出されることがあった。
//  ・ジッターは「境界に沿った方向（along方向）」のみに限定し、
//    境界からの距離（外向きオフセット）には基本的に効かせない。
//    → 泡・水しぶきが船体ラインをきれいになぞるように見える。
//  ・新規: 船首が海面をめくり上げるような「ボウ・カール」スプレーを追加。
//    喫水線の船首寄り（フレアが立ち上がる区間）に沿って、外側へ
//    巻き上がるような弧を描くスプレーを高速時ほど密に放出する。
//  【対象外】スクリュー泡(animateBubbles)・排煙(globalSmoke)はこの関数の対象外。
// ─────────────────────────────────────────
// Stage4: グリーンウォーター/ボウカールの発生数計算で使うアキュムレータ。
// フレーム毎に Math.floor(rate*dt + 0.5) するだけだと、rate*dtが1未満の時に
// 0個/1個の間を行き来してしまい「カクンカクン」という段階的な発生に見えてしまう
// （ユーザー報告のグリーンウォーターのカクつきはこれが原因）。
// 端数を次フレームへ持ち越すことで、平均発生率は保ったまま滑らかに発生させる。
let _wakeEmitAccumCurl  = 0;
let _wakeEmitAccumGreen = 0;
// 【重大バグ修正】波切りスプレー(Bow Cutting Spray)用のこのアキュムレータの宣言が
// 漏れていた。emitHullWakeParticles()内で`_wakeEmitAccumCut += ...`と複合代入して
// いたため、参照時にReferenceErrorが発生 → 船速0.5m/s以上になった瞬間、毎フレーム
// この関数が例外で中断 → main-loop.jsのanimate()内でこの関数より後ろのコード
// （shipGroupの位置更新・renderer.render()呼び出しを含む）が一切実行されなくなり、
// 「船が動き出した瞬間に画面が完全にフリーズする」という重大な不具合の原因になっていた。
let _wakeEmitAccumCut   = 0;

function emitHullWakeParticles(t, dt) {
    if (!wakeParticleGeo || shipHistory.length < 2) return;
    const spd = Math.abs(physics.speed);
    if (spd < 0.5) {
        window.hullWakeEmitterActive = false;
        return;
    }
    window.hullWakeEmitterActive = true;

    const posAttr  = wakeParticleGeo.attributes.position;
    const ageAttr  = wakeParticleGeo.attributes.age;
    const typeAttr = wakeParticleGeo.attributes.ptype;
    // 波切りストリーク(ptype=2)の画面空間向きをシェーダー側で計算するための、
    // パーティクルごとの現在速度ベクトル(GPU属性)。03-particle-systems.js側で
    // 頂点シェーダーが読み取り、速度方向へストリークテクスチャを回転させる。
    const velAttr  = wakeParticleGeo.attributes.velocity;

    const hp       = window.hullProfile;
    const halfLen  = hp.ready ? hp.halfLen  : 6.0;
    const slices   = hp.ready ? hp.slices   : [];
    const nSlices  = slices.length;

    const WS       = (physics && physics.scale) ? physics.scale : 1;
    const halfLenW = halfLen  * WS;

    const scaleRatio = halfLen / 6.0;
    // 細かく見せるためにサイズを抑制 (0.55 を掛けて小さく)
    const sizeScale  = THREE.MathUtils.clamp(scaleRatio * 0.38, 0.10, 2.0);
    const spdFactor  = Math.min(spd / 6.0, 1.0);

    // 船体境界に沿わせるための統一オフセット（≒パーティクル半径分、外側へ）。
    // 以前は放出タイプごとに 0.06〜0.10 とバラバラだった値を一つに統一。
    const huggingRadius = sizeScale * 0.10;

    const headingRad = (physics.heading * Math.PI) / 180;
    const totalRad   = _wakeAxisRad(headingRad);
    const sinT = Math.sin(totalRad), cosT = Math.cos(totalRad);
    const sinH = Math.sin(headingRad), cosH = Math.cos(headingRad);
    const _origin = _hullOriginWorld(physics.cgWorldX, physics.cgWorldZ, totalRad, WS);
    const cx = _origin.x, cz = _origin.z;
    const shipVx = sinH * physics.speed * 0.514;
    const shipVz = cosH * physics.speed * 0.514;

    // alongNorm（-1=船尾〜+1=船首）の位置における喫水線「外縁+huggingRadius」の
    // ワールド座標を返す。side=+1/-1 でどちらの舷かを指定。extraOut は追加の外側オフセット。
    // 【修正】以前は喫水線位置の半幅(hwLocal) + 固定の小さいマージン(huggingRadius)
    // だけで放出位置を決めていた。しかし実際の船体は喫水線からデッキに向かって
    // フレアで外側に張り出しているため、この位置は「フレアの張り出しの真下」に
    // なってしまうことが多く、ズームして見る/やや上から見る角度だとフレア本体が
    // 手前に来てパーティクルを遮ってしまい、「近くで見ると小さく（＝隠れて見えにくく）
    // 見える」原因になっていた。その場所の実際のフレア角度(_hullFlareAngleAtNorm)から、
    // 想定乾舷高さ分だけ外側に張り出しているとみなした追加オフセットを加えることで、
    // フレアの外側（＝実際に視界を遮られない位置）から放出されるようにする。
    // v165-fix【喫水線の泡が船体からはみ出す不具合】
    // 以前この関数は引数を取らず、常に assumedFreeboard = sizeScale * 3.0
    // （＝喫水線からデッキまでの高さ）でフレアの張り出しを計算し、それを
    // hullEdgePoint()内で全パーティクルに無条件で加算していた。
    // ところが実際の放出高さは、喫水線泡で水面+0.7*sizeScale程度、水しぶきでも
    // せいぜい+1.6*sizeScale程度しかない。つまりデッキの高さぶんのフレア
    // 張り出しを、水面すれすれの泡にまで足していたことになる。フレア角が
    // きつい船（tan(60°)≒1.7、上限82°なら約7.1）では船体から数メートル外へ
    // ずれて放出され、これが「泡が喫水線から外にはりでる」症状の主因だった。
    // 逆に、これを見越して外向きオフセットを控えめにしていた放出タイプでは
    // 泡が船体の内側へ食い込んで見えていた。
    // 対策: 張り出しを求める高さを呼び出し側が明示する。各放出点は自分が
    // 実際に発生する高さ(freeboard)を渡し、その高さでのフレア張り出しだけを
    // 受け取る。
    function flareOutwardBonus(alongNorm, freeboard) {
        if (typeof _hullFlareAngleAtNorm !== 'function') return 0;
        if (!(freeboard > 0)) return 0;
        const flareDeg = _hullFlareAngleAtNorm(alongNorm);
        const flareRad = THREE.MathUtils.clamp(flareDeg, 0, 82) * Math.PI / 180;
        return Math.tan(flareRad) * freeboard;
    }

    // alongNorm/side の位置における「今この瞬間の喫水線の外縁 + 余白」を返す。
    // freeboard は、そのパーティクルが水面から何メートル上で発生するか
    // （フレアに沿って外へ張り出す量の計算に使う。0なら喫水線ぴったり）。
    // 戻り値の wet は、その場所が今どれだけ水に浸かっているか(0〜1)。
    // v165: 半幅を静的な設計喫水値(_hullHalfWidthAtNorm)から、水面シェーダーの
    // 泡帯と共有する実喫水値(_hullWetHalfWidthAtNorm)に変更。これで
    // パーティクルとシェーダーの泡帯が必ず同じ輪郭に乗る。
    function hullEdgePoint(alongNorm, side, extraOut, freeboard) {
        const wl      = _hullWetHalfWidthAtNorm(alongNorm, side);
        const hwOut   = wl.hw * WS + huggingRadius
                      + flareOutwardBonus(alongNorm, freeboard)
                      + (extraOut || 0);
        const d       = alongNorm * halfLenW;
        const baseX   = cx + sinT * d;
        const baseZ   = cz + cosT * d;
        return {
            x: baseX + cosT * side * hwOut,
            z: baseZ - sinT * side * hwOut,
            wet: wl.wet
        };
    }

    // ── 喫水線の先端(bow tip)と末端(stern tip)スライスを探す ──
    let bowTipSl = null, sternTipSl = null;
    if (nSlices > 0) {
        let maxA = -Infinity, minA = Infinity;
        for (const sl of slices) {
            if (sl.alongNorm > maxA) { maxA = sl.alongNorm; bowTipSl   = sl; }
            if (sl.alongNorm < minA) { minA = sl.alongNorm; sternTipSl = sl; }
        }
    }
    const bowTipAlong = bowTipSl   ? bowTipSl.alongNorm   :  1.0;
    const sternAlong  = sternTipSl ? sternTipSl.alongNorm : -1.0;
    const bowFlare    = bowTipSl   ? (bowTipSl.flareAngle   || 0) : 0;

    // ── 放出数 ──
    const emitN  = Math.max(1, Math.floor(spd * 8.0 * dt + 0.5));
    const emitWL = Math.max(0, Math.floor(spd * nSlices * 0.35 * dt + 0.5));

    // ── 先端/末端パーティクル ──
    for (let n = 0; n < emitN; n++) {
        // 放出タイプの振り分け
        // 60% : 船首先端から引き波 foam
        // 25% : 船首先端から bowSplash spray（水飛沫）
        // 15% : 船尾末端から stern foam
        const roll = Math.random();
        const isBowSplash = (roll >= 0.60 && roll < 0.85);
        const isStern     = (roll >= 0.85);

        const side = Math.random() < 0.5 ? -1 : 1;
        // along方向（境界に沿った方向）のみの微小ジッター。外向き距離は変えない。
        const alongJitter = (Math.random() - 0.5) * 0.05;

        // v165: 発生高さ(freeboard)を明示して、その高さぶんのフレア張り出しだけを
        // 受け取る（下のposAttr.array[ii*3+1]に入れる値と一致させること）。
        const tipFreeboard = isBowSplash ? sizeScale * 0.08 : 0.0;
        let srcX, srcZ;
        if (!isStern) {
            const alongN = THREE.MathUtils.clamp(bowTipAlong - Math.abs(alongJitter), -1, bowTipAlong);
            const ep = hullEdgePoint(alongN, side, 0, tipFreeboard);
            srcX = ep.x; srcZ = ep.z;
        } else {
            const alongN = THREE.MathUtils.clamp(sternAlong + Math.abs(alongJitter), sternAlong, 1);
            const ep = hullEdgePoint(alongN, side, 0, tipFreeboard);
            srcX = ep.x; srcZ = ep.z;
        }

        // v107: 引き波エフェクト自体が、通常の海洋波(swell/chop)の高さだけでなく
        // 船が作っている引き波(wake)の盛り上がりの上にも乗るようにする。
        // 従来は getWaveCrestAndHeight (=通常波のみ) を使っており、引き波の
        // 帯が実際に盛り上がっているすぐ横で泡が本来の水面の高さのまま
        // 浮いてしまう不整合があった。getWaveHeight は内部で
        // getWaveCrestAndHeight(通常波)+getWakeHeight(引き波)を合成する。
        const surfaceY = (typeof getWaveHeight === 'function')
            ? getWaveHeight(srcX, srcZ, t, false) : 0.0;

        const isSpray = isBowSplash;

        const ii = wakeParticleIdx;
        posAttr.array[ii*3]   = srcX;
        posAttr.array[ii*3+1] = surfaceY + (isSpray ? sizeScale * 0.08 : 0.0);
        posAttr.array[ii*3+2] = srcZ;
        ageAttr.array[ii]     = 0.0;
        typeAttr.array[ii]    = isSpray ? 1 : 0;

        const outwardBoost = 1.0 + bowFlare * 0.01;
        const outSpd = (0.10 + 0.22 * spdFactor) * sizeScale * (isStern ? 0.6 : 1.0) * outwardBoost;
        const outX =  cosT * side * outSpd;
        const outZ = -sinT * side * outSpd;

        if (isSpray) {
            wakeParticleData[ii].vx = shipVx * 0.05 + outX * 1.2 + (Math.random()-0.5)*0.06*sizeScale;
            wakeParticleData[ii].vy = (0.35 + Math.random() * 1.0) * sizeScale * spdFactor;
            wakeParticleData[ii].vz = shipVz * 0.05 + outZ * 1.2 + (Math.random()-0.5)*0.06*sizeScale;
        } else if (isStern) {
            wakeParticleData[ii].vx = shipVx * 0.06 + outX * 0.40;
            wakeParticleData[ii].vy = 0.012 * sizeScale;
            wakeParticleData[ii].vz = shipVz * 0.06 + outZ * 0.40;
        } else {
            wakeParticleData[ii].vx = shipVx * 0.06 + outX * 0.55;
            wakeParticleData[ii].vy = 0.015 * sizeScale;
            wakeParticleData[ii].vz = shipVz * 0.06 + outZ * 0.55;
        }
        velAttr.array[ii*3]   = wakeParticleData[ii].vx;
        velAttr.array[ii*3+1] = wakeParticleData[ii].vy;
        velAttr.array[ii*3+2] = wakeParticleData[ii].vz;
        wakeParticleData[ii].rand = Math.random();
        wakeParticleData[ii].type = isSpray ? 1 : 0;
        // v164: 粒子がリングバッファで使い回された際、前の粒子(別の場所・別の
        // タイミングで生存していたfoam)が残していたwakeBonusキャッシュを
        // そのまま引き継がないよう、生成のたびに未計算状態へリセットする。
        // animateWakeParticles側で d.wakeBonus === undefined を「初回は必ず
        // 計算する」判定に使っているため、ここで明示的にundefinedへ戻す。
        wakeParticleData[ii].wakeBonus = undefined;
        wakeParticleData[ii].spawnTime = t;  // v98: 発生時刻を記録（当たり判定の無敵時間の基準）
        wakeParticleData[ii].sizeScale = sizeScale;  // v98: 初速と同じ基準で重力も掛ける
        wakeParticleIdx = (wakeParticleIdx + 1) % MAX_WAKE_PARTICLES;
    }

    // ── 船首が海面をめくり上げる「ボウ・カール」スプレー ──
    // 喫水線の船首寄り（フレアが立ち上がる区間 alongNorm 0.45〜先端）に沿って、
    // 外側へ巻き上がるように弧を描くスプレーを高速ほど密に放出する。
    // 写真のように、船首に近いほど高く・大きく跳ね上がるようにする。
    //
    // Stage4: 船型による描き分け。estimateBowShapeFactors()（21-bow-stern-effects.js）の
    // sharpnessNorm/flareNormを使い、鋭い船首（Lusitania的）ほど細く高く、
    // 丸くフレアの強い船首（Olympic的）ほど幅広く低くスプレーが出るようにする。
    const _bowShape = (typeof estimateBowShapeFactors === 'function') ? estimateBowShapeFactors() : null;
    const hasBowShape     = _bowShape && typeof _bowShape.sharpnessNorm === 'number';
    const sprayHeightMult = hasBowShape ? (0.7 + 0.6 * _bowShape.sharpnessNorm)       : 1.0; // 鋭いほど高く
    const sprayWidthMult  = hasBowShape ? (0.7 + 0.6 * (1 - _bowShape.sharpnessNorm)) : 1.0; // 丸いほど幅広く

    const bowCurlBand = Math.max(0.05, bowTipAlong - 0.45);
    // 【2026-07 やや縮小】速度のみで常時発生する「通常巡航スプレー」。20ノットで
    // 毎秒60個近い発生量になっており、これも「常に画面に白い波が居座る」ことへの
    // 寄与が大きいと考えられたため、他の演出ほど大胆にではないが控えめに調整
    // （旧0.55→0.40）。
    _wakeEmitAccumCurl += spd > 2.0 ? (spd * spd * 0.40 * dt) : 0;
    const emitCurl = Math.max(0, Math.floor(_wakeEmitAccumCurl));
    _wakeEmitAccumCurl -= emitCurl;
    for (let n = 0; n < emitCurl; n++) {
        const tipNear = Math.random();           // 0=帯の後端、1=船首先端付近
        const alongN  = bowTipAlong - (1.0 - tipNear) * bowCurlBand;
        const side    = Math.random() < 0.5 ? -1 : 1;
        const ep = hullEdgePoint(alongN, side, sizeScale * 0.05 * Math.random(), sizeScale * 0.05);
        const srcX = ep.x, srcZ = ep.z;

        const surfaceY = (typeof getWaveHeight === 'function')
            ? getWaveHeight(srcX, srcZ, t, false) : 0.0;

        const ii = wakeParticleIdx;
        posAttr.array[ii*3]   = srcX;
        posAttr.array[ii*3+1] = surfaceY + sizeScale * 0.05;
        posAttr.array[ii*3+2] = srcZ;
        ageAttr.array[ii]     = 0.0;
        typeAttr.array[ii]    = 1; // spray

        // 先端に近いほど高く・力強く巻き上がる
        const curlPower = (0.5 + tipNear * 1.3) * spdFactor;
        const outX =  cosT * side;
        const outZ = -sinT * side;
        const fwdX =  sinT;
        const fwdZ =  cosT;

        wakeParticleData[ii].vx = shipVx * 0.08
                                  + outX * (0.5 + 0.5 * spdFactor) * sizeScale * curlPower * sprayWidthMult
                                  + fwdX * 0.15 * sizeScale * curlPower
                                  + (Math.random()-0.5) * 0.05 * sizeScale;
        wakeParticleData[ii].vy = (0.5 + Math.random() * 1.3) * sizeScale * curlPower * sprayHeightMult;
        wakeParticleData[ii].vz = shipVz * 0.08
                                  + outZ * (0.5 + 0.5 * spdFactor) * sizeScale * curlPower * sprayWidthMult
                                  + fwdZ * 0.15 * sizeScale * curlPower
                                  + (Math.random()-0.5) * 0.05 * sizeScale;
        velAttr.array[ii*3]   = wakeParticleData[ii].vx;
        velAttr.array[ii*3+1] = wakeParticleData[ii].vy;
        velAttr.array[ii*3+2] = wakeParticleData[ii].vz;
        wakeParticleData[ii].rand = Math.random();
        wakeParticleData[ii].type = 1;
        wakeParticleData[ii].spawnTime = t;  // v98: 発生時刻を記録（当たり判定の無敵時間の基準）
        wakeParticleData[ii].sizeScale = sizeScale;  // v98: 初速と同じ基準で重力も掛ける
        wakeParticleIdx = (wakeParticleIdx + 1) % MAX_WAKE_PARTICLES;
    }

    // ── 【新規v69】波切りスプレー（Bow Cutting Spray）──
    // 目的:「船首が波を切り裂いている」という一体感のある見た目を作る。
    // 従来のボウ・カール/グリーンウォーターは粒子ごとにほぼ独立な方向へ飛ぶため、
    // 量を増やしても「点の集まり」には見えても「一枚のシートが波を切って
    // 左右へ流れる」感じにはなりにくかった。
    // → 喫水線帯(bowCurlBand)内での位置(tipNear: 0=帯の後端寄り, 1=船首先端)に
    //   応じて前後スイープの向きを揃える。船首先端付近ではわずかに前方
    //   （波の前面を押しのける「せり上がり」）、帯の後端寄り（フレアが立ち
    //   上がり始める辺り）に近いほど後方へ大きくスイープさせることで、
    //   「先端でせり上がり、脇腹に沿って後ろへ流れる」実際の波切りに近い形にする。
    //   鋭い船首(sharpnessNorm)ほどこの前後の振れ幅を大きく・きつくし、
    //   スパッと切り裂くような印象を強める。
    // 専用ptype=2で描画（03-particle-systems.js）。速度方向へ回転する楕円
    // ストリーク・テクスチャ(mapStreak/pangle)を使い、丸い水滴の集まりではなく
    // 「筋になって流れるシート」に見せる。
    // 「最終形態」: bowSlamRatioLiveが1.0を超えるスラミング時、通常巡航時の
    // 量・勢いから大きく跳ね上げる（スラミングバースト／グリーンウォーターとは
    // 別枠の、専用の「切り裂き」演出として追加。両方同時に出るのは意図通り）。
    // 【2026-07 v74修正】ここに「通常巡航時（速度なり）の基準発生レート」
    // (CUT_BASE_RATE)として、bowExcess/slamRatioに関係なく速度だけで常時
    // 一定量を発生させる項があったが、これが「HUD上はbowExcessVol=0・
    // slamRatio=0で水切り波は出ないはずなのに、正体不明のスプレーが船首から
    // 立ち続ける」というフィードバックの原因だった。従来のボウ・カール
    // (_wakeEmitAccumCurl)や喫水線全体foam(emitWL)など、速度だけで出る
    // 「通常巡航スプレー」は既に別枠で存在しているため、この専用ptype=2の
    // 「波切りシート」演出は本来の目的通り、実際にbowExcess超過やスラミングが
    // 起きている時だけ出るように、速度のみの基準発生分を撤去した。
    // 【2026-07 全体縮小】「シンプルに発生量が多すぎる/エフェクトが大きすぎるのでは」
    // という指摘を受け、逆算してみたところ、bowSlamRatioが0.5程度の穏やかな
    // 超過でも毎秒40〜50個規模の発生になり、寿命(1.3〜1.8秒)を考えると常時
    // 100個以上が画面に滞留する計算になっていた。物理側のノイズ対策(v80)とは
    // 別に、そもそも「普通に起きる程度のbowExcess/slamRatioの変動」に対して
    // 見た目の反応が大きすぎたと考えられるため、レート・ブースト倍率を
    // 全体的に約45%縮小する。
    const CUT_EXCESS_RATE   = 165;  // 旧300 → 165
    const CUT_ULTIMATE_MULT = 2.0;  // 旧3.6 → 2.0
    const CUT_WIDTH_MULT    = 2.2;  // 横方向（切り裂き幅）の勢い係数
    // 【調整】「打ち上がりすぎ」というフィードバックのため1.8→1.05に縮小。
    // 横方向(CUT_WIDTH_MULT)はそのままなので、水平に「シートが流れる」見た目の
    // 勢いは維持しつつ、鉛直方向だけ跳ね上がりを抑える。
    const CUT_HEIGHT_MULT   = 1.05; // 高さ（跳ね上がり）係数（旧1.8）

    const cutBowSharp   = hasBowShape ? _bowShape.sharpnessNorm : 0.5;
    // 【2026-07 重要な修正】以前は cutExcessRef を halfBeam²（面積＝長さの2乗）で
    // 計算していたが、bowExcessVol は体積（長さの3乗）。次元が合っていないため、
    // 船が大きくなるほど「同じ相対的な沈み込み具合」でも比率が過大に出てしまう
    // バグだった（10mの船の"船首が丸ごと沈む"と300mの船の"デッキ1枚分沈む"を
    // 同じ絶対量[m³]で比べてしまっていた）。船首設計没水体積(volBowDesign、
    // これも体積)を基準にすることで、船のサイズによらず「設計没水量に対して
    // 何割の超過か」という一貫した基準になり、大型船で細かい波でも過大な
    // スプレーが出ていた問題が解消するはず。
    const cutExcessRef = Math.max(1, window._volBowDesign || (hp.ready ? hp.halfLen * hp.halfBeam * hp.halfBeam : 50));
    const CUT_EXCESS_FRACTION_MAX = 1.2; // 設計没水量の何割の超過で最大強度になるか
    // （1.2 = 船首設計没水量の120%相当の超過があって初めて最大強度になる、という
    //   意味。細かい波程度の変動では十分穏やかな値に収まるようにしている）
    // 【修正】以前は bowExcessVol にほぼ線形（clampのみ）で反応していたため、
    // 波が少し当たっただけでも「いきなりドーーン」と量が跳ね上がって見えていた。
    // 「はじめはちょっとずつ強くなり、すっごい沈み込みでは思いっきりドーンと
    // 行く」というべき乗カーブ（序盤は緩やか、終盤で急激に立ち上がる）に変更。
    const cutExcessRaw01 = THREE.MathUtils.clamp((window._bowExcessVol || 0) / cutExcessRef / CUT_EXCESS_FRACTION_MAX, 0, 1);
    const cutExcessNorm  = Math.pow(cutExcessRaw01, 2.4) * 1.5;
    const cutSlamLive   = (typeof window._bowSlamRatioLive === 'number') ? window._bowSlamRatioLive : 0;
    // slamRatioが1.0を超えた分だけべき乗で急激に立ち上がる「最終形態」ブースト
    const cutUltimate = cutSlamLive > 1.0
        ? Math.pow(THREE.MathUtils.clamp((cutSlamLive - 1.0) / 3.0, 0, 1), 1.6) * CUT_ULTIMATE_MULT
        : 0;

    // 【v74】速度のみの基準発生(cutBaseFlux)を撤去したため、bowExcess/slamの
    // 超過分(cutExcessNorm/cutUltimate)が両方0なら発生量も厳密に0になる。
    _wakeEmitAccumCut += (cutExcessNorm + cutUltimate) * CUT_EXCESS_RATE * dt;
    let emitCut = Math.max(0, Math.floor(_wakeEmitAccumCut));
    _wakeEmitAccumCut -= emitCut;
    emitCut = Math.min(emitCut, 260); // 1フレームでの暴走防止（安全弁）


    for (let n = 0; n < emitCut; n++) {
        const tipNear = Math.random(); // 0=帯の後端寄り、1=船首先端付近
        const alongN  = bowTipAlong - (1.0 - tipNear) * bowCurlBand;
        const side    = Math.random() < 0.5 ? -1 : 1;

        const flareDeg = _hullFlareAngleAtNorm(alongN);
        const flareRad = THREE.MathUtils.clamp(flareDeg, 0, 90) * Math.PI / 180;

        // 【追加】「船体に上下方向でも沿うように」という要望に対応。
        // 以前は全パーティクルが喫水線の高さ(surfaceY)ぴったりから発生していて、
        // 水しぶきが船体のフレア曲面を"登っていく"立体感が無かった。
        // climbT(0〜1、低い位置に偏るようべき乗で調整)で「船体のどのくらいの
        // 高さまで這い上がった状態から発生するか」をランダムに決め、その高さに
        // 応じて追加の外向きオフセット（フレアの曲面なりの張り出し）も加える
        // ことで、垂直方向にも船体の丸みに沿って見えるようにする。
        const climbT          = Math.pow(Math.random(), 1.6); // 喫水線付近に偏らせる
        const climbFreeboard  = sizeScale * 1.6; // 這い上がりを許容する高さの目安
        const climbYOffset    = climbT * climbFreeboard;

        // v165: 這い上がった高さぶんのフレア張り出しは hullEdgePoint に
        // freeboard として渡す（以前はここで climbOutBonus として自前に加算した
        // 上に、hullEdgePoint内でもデッキ高さぶんの張り出しが無条件に加算されて
        // いて二重取りになっていた）。
        const ep = hullEdgePoint(alongN, side, sizeScale * 0.06 * Math.random(),
                                 sizeScale * 0.05 + climbYOffset);
        const srcX = ep.x, srcZ = ep.z;

        const surfaceY = (typeof getWaveHeight === 'function')
            ? getWaveHeight(srcX, srcZ, t, false) : 0.0;

        const ii = wakeParticleIdx;
        posAttr.array[ii*3]   = srcX;
        posAttr.array[ii*3+1] = surfaceY + sizeScale * 0.05 + climbYOffset;
        posAttr.array[ii*3+2] = srcZ;
        ageAttr.array[ii]     = 0.0;
        typeAttr.array[ii]    = 2; // 波切りシート専用type（ストリーク描画）

        // 前後スイープ: 先端(tipNear→1)でわずかに前方、帯の後端(tipNear→0)に
        // 近いほど後方へ大きくスイープ。鋭い船首ほど振れ幅を大きくする。
        const sweepRange = THREE.MathUtils.lerp(0.7, 1.7, cutBowSharp);
        const fwdBias    = THREE.MathUtils.lerp(-sweepRange, sweepRange * 0.3, tipNear);

        const outwardLean = 0.5 + 0.5 * Math.sin(flareRad); // 常に一定以上の横方向成分を確保

        const outX =  cosT * side;
        const outZ = -sinT * side;
        const fwdX =  sinT;
        const fwdZ =  cosT;

        const cutPower = (0.7 + 1.1 * spdFactor) * (1.0 + cutExcessNorm * 1.6 + cutUltimate * 2.2);

        wakeParticleData[ii].vx = shipVx * 0.10
            + outX * outwardLean * sizeScale * cutPower * CUT_WIDTH_MULT
            + fwdX * fwdBias * sizeScale * cutPower * 0.55
            + (Math.random() - 0.5) * 0.05 * sizeScale;
        wakeParticleData[ii].vy = (0.6 + Math.random() * 0.8) * sizeScale * cutPower * CUT_HEIGHT_MULT;
        wakeParticleData[ii].vz = shipVz * 0.10
            + outZ * outwardLean * sizeScale * cutPower * CUT_WIDTH_MULT
            + fwdZ * fwdBias * sizeScale * cutPower * 0.55
            + (Math.random() - 0.5) * 0.05 * sizeScale;
        velAttr.array[ii*3]   = wakeParticleData[ii].vx;
        velAttr.array[ii*3+1] = wakeParticleData[ii].vy;
        velAttr.array[ii*3+2] = wakeParticleData[ii].vz;
        wakeParticleData[ii].rand = Math.random();
        wakeParticleData[ii].type = 2;
        wakeParticleData[ii].spawnTime = t;  // v98: 発生時刻を記録（当たり判定の無敵時間の基準）
        wakeParticleData[ii].sizeScale = sizeScale;  // v98: 初速と同じ基準で重力も掛ける
        wakeParticleIdx = (wakeParticleIdx + 1) % MAX_WAKE_PARTICLES;
    }

    // ── 継続的な水しぶき（船首が波に沈み込んでいる間、bowSlamRatioに応じて出る） ──
    // 【変更】「ほぼ0から出て、bowSlamRatioが大きくなるほど、より上に・より濃く」
    // という要望に合わせ、閾値をほぼ0にして常時反応させ、代わりに比率に対する
    // 増え方をべき乗（growth）にすることで、小さい沈み込みでは控えめに、
    // 大きい沈み込みでは急激に量・高さが増える曲線にした。
    // 【再調整】閾値がほぼ0だったため、通常巡航中のごく小さな上下動（波による
    // 自然なヒーブ変動）でもslamRatioLiveが常にわずかに閾値を超え、「水切り波
    // 以外に、船首からずっと大量の水しぶきが立ち続ける」状態になっていた。加えて
    // 個々の粒(burst)の勢いが強すぎ、発生数は少ないまま1粒1粒が目立つ大きさに
    // なっていたため、「まばらなのに大きい」＝細かい霧ではなく点在する大粒に見えて
    // いた。→ 閾値を上げて「本当に沈み込んだ時だけ」反応するようにしつつ、1粒
    // あたりの勢い(burst)を大きく落とし、代わりに発生数をやや増やすことで、
    // 同じ濃さでも「大粒が疎らに」ではなく「細かい粒が密に」流れる見た目にした。
    const GREEN_WATER_TRIGGER = 0.10; // 旧0.03→0.10。ごく小さな上下動では反応しない
    const slamRatioLive = (typeof window._bowSlamRatioLive === 'number') ? window._bowSlamRatioLive : 0;
    const sprayRatio = Math.max(0, slamRatioLive - GREEN_WATER_TRIGGER);
    const sprayGrowth = Math.pow(sprayRatio, 1.6); // 比率が上がるほど急激に伸びる項

    if (sprayRatio > 0 && spd > 1.0) {
        // 密度（＝濃さ）: sprayRatioの線形成分 + sprayGrowthの急増成分
        // 【2026-07 全体縮小】波切りスプレーと同じ理由で、レート係数を約45%縮小。
        _wakeEmitAccumGreen += (sprayRatio * 1.0 + sprayGrowth * 9.0) * spd * dt;
        let emitGreen = Math.max(0, Math.floor(_wakeEmitAccumGreen));
        _wakeEmitAccumGreen -= emitGreen;
        emitGreen = Math.min(emitGreen, 90); // 1フレームでの暴走防止（安全弁）

        for (let n = 0; n < emitGreen; n++) {
            // ボウ・カール/スラミングバーストと同じ範囲(bowCurlBand)を使い、
            // 船首先端付近だけでなくフレア全体の広い範囲から出るようにする。
            const alongN = THREE.MathUtils.clamp(bowTipAlong - Math.random() * bowCurlBand, -1, bowTipAlong);
            const side   = Math.random() < 0.5 ? -1 : 1;
            // 外側への初期オフセットにも幅を持たせ、舷から離れた位置からも湧くようにする
            const lateralOffset = sizeScale * (0.2 + Math.random() * 1.6);
            const ep = hullEdgePoint(alongN, side, lateralOffset, sizeScale * 0.30);
            const srcX = ep.x, srcZ = ep.z;

            const surfaceY = (typeof getWaveHeight === 'function')
                ? getWaveHeight(srcX, srcZ, t, false) : 0.0;

            const ii = wakeParticleIdx;
            posAttr.array[ii*3]   = srcX;
            posAttr.array[ii*3+1] = surfaceY + sizeScale * 0.30;
            posAttr.array[ii*3+2] = srcZ;
            ageAttr.array[ii]     = 0.0;
            typeAttr.array[ii]    = 1; // spray素材を流用（damage/deck等の専用typeはStage6で検討）

            const fwdX = sinT, fwdZ = cosT;
            const outX =  cosT * side; // 舷の外向き方向
            const outZ = -sinT * side;
            // 「より濃く」＝勢い・量。sprayGrowthで比率が上がるほど急激に強くなる。
            // 【2026-07 全体縮小】発生数側を絞った分、1粒あたりの基準値も
            // あわせて縮小（旧: 0.6+rand*1.1 → 新: 0.4+rand*0.7）。
            const burst = (0.4 + Math.random() * 0.7) * sizeScale * (1.0 + sprayRatio + sprayGrowth * 3.0);
            // 【調整】打ち上げ高さを抑制。
            // 以前は burst（密度側にも sprayGrowth が効いている）と heightGrowth の
            // 両方に sprayGrowth がかかっており、実質ほぼ二乗で高さが伸びてしまい、
            // 「グリーンウォーターが上に打ち上げすぎ」になっていた。
            // → 高さの伸びを burst から切り離し、上限(cap)付きの緩やかな成長に変更。
            //   量・横方向の勢い(burst)は従来通りなので、密度感は変えずに高さだけ抑える。
            const heightGrowth = Math.min(1.0 + sprayGrowth * 1.6, 2.2);

            // スラミングバーストと同じく、その場所の実際のフレア角度
            // (_hullFlareAngleAtNorm)に沿って噴き出す向きにする。
            // 上方向はフレア角に関わらず常にしっかり確保し、フレア角は「横方向へ
            // どれだけ開くか」だけに使うようにした（＝フレアに沿って上に打ち上げる）。
            const flareDeg = _hullFlareAngleAtNorm(alongN);
            const flareRad = THREE.MathUtils.clamp(flareDeg, 0, 90) * Math.PI / 180;
            const outwardLean = Math.sin(flareRad); // 横方向への開き具合（0=真上, 1=水平に近い）

            wakeParticleData[ii].vx = shipVx * 0.10 + outX * outwardLean * 1.7 * burst + fwdX * 0.30 * burst + (Math.random()-0.5) * 0.30 * sizeScale;
            // 【調整】burst を掛けなくなった分、高さは sizeScale と heightGrowth（上限2.2倍）だけで
            // 決まるようになり、slamRatioがどれだけ大きくなっても打ち上げ高さが際限なく
            // 伸びることはなくなる。
            wakeParticleData[ii].vy = (1.2 + Math.random() * 1.6) * sizeScale * heightGrowth;
            wakeParticleData[ii].vz = shipVz * 0.10 + outZ * outwardLean * 1.7 * burst + fwdZ * 0.30 * burst + (Math.random()-0.5) * 0.30 * sizeScale;
            velAttr.array[ii*3]   = wakeParticleData[ii].vx;
            velAttr.array[ii*3+1] = wakeParticleData[ii].vy;
            velAttr.array[ii*3+2] = wakeParticleData[ii].vz;
            wakeParticleData[ii].rand = Math.random();
            wakeParticleData[ii].type = 1;
            wakeParticleData[ii].spawnTime = t;  // v98: 発生時刻を記録（当たり判定の無敵時間の基準）
            wakeParticleData[ii].sizeScale = sizeScale;  // v98: 初速と同じ基準で重力も掛ける
            wakeParticleIdx = (wakeParticleIdx + 1) % MAX_WAKE_PARTICLES;
        }
    }

    // ── 船首スラミングの一発バースト（「バッシャーン」瞬間衝撃） ──
    // 上のグリーンウォーターは bowExcess に応じた"連続的"な水しぶきだが、
    // 実際に波へ叩き込まれた瞬間(Stage1のslamming判定, window._bowSlamEvent)には
    // それとは別に、その一瞬だけ大量・放射状に広がる特大バーストを追加する。
    // window._bowSlamEvent.t が前回消費した時刻と変わっていたら「新しいスラム」とみなす
    // （閾値未満でも「処理済み」として記録し、同じイベントを取り違えないようにする）。
    const slamEvt = window._bowSlamEvent;
    if (slamEvt && slamEvt.t !== window._lastConsumedBowSlamT) {
        window._lastConsumedBowSlamT = slamEvt.t;

        // 【変更】水しぶきの発生自体は bowSlamRatio > 1.0 になった時だけ。
        // （0.5〜1.0の間は物理側のスラミング判定・減速だけ発生し、水しぶきは出さない）
        // 1.0を超えた分だけ、比率が大きいほどさらに量・勢いを増やす。
        const slamRatioForSpray = slamEvt.slamRatio || 0;
        if (slamRatioForSpray > 1.0) {
            const impactMag  = THREE.MathUtils.clamp(slamRatioForSpray / 1.0, 1.0, 14.0);
            const burstCount = Math.floor(70 + impactMag * 170);
            const fwdX = sinT, fwdZ = cosT;

            for (let n = 0; n < burstCount; n++) {
                // ボウ・カールと同じ範囲(bowCurlBand: 船首先端〜フレアが立ち上がり
                // 始める場所まで)から、船体前部の広い範囲にわたって発生させる。
                const alongN = THREE.MathUtils.clamp(bowTipAlong - Math.random() * bowCurlBand, -1, bowTipAlong);
                const sideSign = Math.random() < 0.5 ? -1 : 1;
                const spreadOut = sizeScale * 0.35 * Math.random(); // 中心〜舷外まで幅広く散らす
                const ep = hullEdgePoint(alongN, sideSign, spreadOut, sizeScale * 0.30);
                const srcX = ep.x, srcZ = ep.z;

                const surfaceY = (typeof getWaveHeight === 'function')
                    ? getWaveHeight(srcX, srcZ, t, false) : 0.0;

                const ii = wakeParticleIdx;
                posAttr.array[ii*3]   = srcX;
                posAttr.array[ii*3+1] = surfaceY + sizeScale * 0.30;
                posAttr.array[ii*3+2] = srcZ;
                ageAttr.array[ii]     = 0.0;
                typeAttr.array[ii]    = 1; // spray素材を流用

                // 【変更】以前は「全方位ランダム角」で単純に左右へ広げていたが、
                // 実際の船体のその場所のフレア角度(_hullFlareAngleAtNorm)に沿って
                // 噴き出す向きにする。
                // 【追加修正】フレアが強い場所ほど垂直成分を弱める設計だと、波の中で
                // 発生した時に勢いが横へ流れて水面下に埋もれ、見えなくなってしまう
                // 問題があった。上方向はフレア角に関わらず常にしっかり確保し、
                // フレア角は「横方向へどれだけ開くか」だけに使うようにした
                // （＝フレアに沿って上に打ち上げる）。
                const flareDeg = _hullFlareAngleAtNorm(alongN);
                const flareRad = THREE.MathUtils.clamp(flareDeg, 0, 90) * Math.PI / 180;
                const outwardLean = Math.sin(flareRad); // 横方向への開き具合（0=真上, 1=水平に近い）

                const outX =  cosT * sideSign; // 舷の外向き方向
                const outZ = -sinT * sideSign;
                const radial = (1.6 + Math.random() * 2.8) * sizeScale * impactMag;
                const jitterAng = (Math.random() - 0.5) * 0.6; // 向きに少しランダム性を持たせる

                wakeParticleData[ii].vx = shipVx * 0.2
                    + (outX * Math.cos(jitterAng) - outZ * Math.sin(jitterAng)) * outwardLean * radial
                    + fwdX * 0.30 * radial
                    + (Math.random()-0.5) * 0.15 * sizeScale;
                wakeParticleData[ii].vy = (3.2 + Math.random() * 3.6) * sizeScale * impactMag; // フレアに関わらず常に高く打ち上げる
                wakeParticleData[ii].vz = shipVz * 0.2
                    + (outZ * Math.cos(jitterAng) + outX * Math.sin(jitterAng)) * outwardLean * radial
                    + fwdZ * 0.30 * radial
                    + (Math.random()-0.5) * 0.15 * sizeScale;
                velAttr.array[ii*3]   = wakeParticleData[ii].vx;
                velAttr.array[ii*3+1] = wakeParticleData[ii].vy;
                velAttr.array[ii*3+2] = wakeParticleData[ii].vz;
                wakeParticleData[ii].rand = Math.random();
                wakeParticleData[ii].type = 1;
                wakeParticleData[ii].spawnTime = t;  // v98: 発生時刻を記録（当たり判定の無敵時間の基準）
                wakeParticleData[ii].sizeScale = sizeScale;  // v98: 初速と同じ基準で重力も掛ける
                wakeParticleIdx = (wakeParticleIdx + 1) % MAX_WAKE_PARTICLES;
            }
        }
    }

    // ── 喫水線全体 waterline foam ──
    // 全スライスの喫水線外縁から、引き波と同じ薄いfoamを均等に放出
    // 泡は船の進行方向に沿って流れるように速度を設定
    for (let n = 0; n < emitWL; n++) {
        // ランダムにスライスを選択
        const si   = Math.floor(Math.random() * nSlices);
        const sl   = slices[si];
        const side = Math.random() < 0.5 ? -1 : 1;

        // 【追加】波切りスプレーと同じ「船体のフレア曲面に沿って高さ方向にも
        // 這い上がった状態から発生する」climbT方式を、喫水線泡にも適用。
        // 以前は全パーティクルが喫水線ぴったりの高さから発生していて、垂直方向の
        // 立体感（船体の丸みに沿っている感じ）が無かった。喫水線泡は波切りスプレー
        // よりずっと薄く控えめな演出なので、這い上がる高さも控えめにしている。
        const wlClimbT         = Math.pow(Math.random(), 2.0); // 喫水線付近により強く偏らせる
        const wlClimbFreeboard = sizeScale * 0.7;
        const wlClimbYOffset   = wlClimbT * wlClimbFreeboard;

        // v165-fix【喫水線の泡が船体に沿わない不具合】
        //  ・這い上がり高さぶんのフレア張り出しは hullEdgePoint に freeboard として
        //    渡す。以前はここで wlClimbOutBonus として自前に足した上、hullEdgePoint
        //    内でも「デッキ高さ(sizeScale*3.0)ぶん」の張り出しが無条件に加算されて
        //    いた。喫水線の泡は水面から高々 sizeScale*0.7 の高さにしかいないのに、
        //    その4倍以上の高さのフレア張り出しを受けていたことになる。
        //    フレアのきつい船ほど泡が舷側から大きく外へ流れ出て見えていた。
        //  ・外縁も静的な設計喫水ではなく実喫水(hullEdgePoint内で
        //    _hullWetHalfWidthAtNorm)を見るようになったので、傾いて片舷が
        //    浮き上がったときに泡だけ船体の外へ取り残されることがなくなる。
        const ep = hullEdgePoint(sl.alongNorm, side, 0, wlClimbYOffset);
        const srcX = ep.x, srcZ = ep.z;

        // v165: そのステーションのその舷が今まさに離水しているなら泡は出さない。
        //   （水面シェーダーの泡帯も同じ wet で消えるので、両者の見た目が揃う）
        // wetが中間の値のときは確率的に間引いて、水線が上下する境目でも
        // パーティクルの量が滑らかに増減するようにする。
        if (ep.wet < 0.05 || Math.random() > ep.wet) continue;

        const surfaceY = (typeof getWaveHeight === 'function')
            ? getWaveHeight(srcX, srcZ, t, false) : 0.0;

        const ii = wakeParticleIdx;
        posAttr.array[ii*3]   = srcX;
        posAttr.array[ii*3+1] = surfaceY + wlClimbYOffset;
        posAttr.array[ii*3+2] = srcZ;
        ageAttr.array[ii]     = 0.0;
        typeAttr.array[ii]    = 0; // 常にfoam

        // ウォーターライン泡は船体に沿って後方へ流れる
        // ・進行方向の「後方」成分を強く（船尾方向へ押し出す）
        // ・外向き成分は控えめ
        // alongFactor: 船首〜船尾で均等に放出（以前は船尾側で激減していた）。
        // 速度は船首側ほど速く（波が激しい）、船尾側は少し遅めにする程度に留める。
        const alongFactor = THREE.MathUtils.clamp((sl.alongNorm + 1.0) * 0.35 + 0.30, 0.30, 1.0);
        const sternSpd = (0.12 + 0.28 * spdFactor) * sizeScale * alongFactor;
        // 外向き速度（ウォーターライン形状に沿ってわずかに広がる）
        const outSpd = (0.02 + 0.04 * spdFactor) * sizeScale;
        wakeParticleData[ii].vx = -sinH * sternSpd * physics.speed / (Math.abs(physics.speed) + 0.001)
                                  + cosT * side * outSpd
                                  + (Math.random()-0.5) * 0.01 * sizeScale;
        wakeParticleData[ii].vy = 0.005 * sizeScale;
        wakeParticleData[ii].vz = -cosH * sternSpd * physics.speed / (Math.abs(physics.speed) + 0.001)
                                  - sinT * side * outSpd
                                  + (Math.random()-0.5) * 0.01 * sizeScale;
        velAttr.array[ii*3]   = wakeParticleData[ii].vx;
        velAttr.array[ii*3+1] = wakeParticleData[ii].vy;
        velAttr.array[ii*3+2] = wakeParticleData[ii].vz;
        wakeParticleData[ii].rand = Math.random();
        wakeParticleData[ii].type = 0;
        // v164: リングバッファ再利用時の古いwakeBonusキャッシュ引き継ぎ防止
        // （上の isSpray 生成箇所と同じ理由）。
        wakeParticleData[ii].wakeBonus = undefined;
        wakeParticleData[ii].spawnTime = t;  // v98: 発生時刻を記録（当たり判定の無敵時間の基準）
        wakeParticleData[ii].sizeScale = sizeScale;  // v98: 初速と同じ基準で重力も掛ける
        wakeParticleIdx = (wakeParticleIdx + 1) % MAX_WAKE_PARTICLES;
    }

    posAttr.needsUpdate = true;
    ageAttr.needsUpdate = true;
    typeAttr.needsUpdate = true;
    velAttr.needsUpdate = true;
}

window.getWakeHeightVisual = getWakeHeightVisual;

// ============================================================
//  幾何的GM（メタセンタ高さ）自動計算
// ============================================================
//  scanHullProfile() のスライスデータから KB・BM_roll・BM_pitch・KG を
//  計算し、幾何的な GM を返す。
//
//  KB : キールから浮力中心（CB）までの高さ
//       = ∑(层面積 × 層Y) / V  （多層積分）
//  BM_roll  = I_L / V
//       I_L = ∑ sliceWidth × (2×halfWidth)³/12  （横揺れ、長手軸周り）
//  BM_pitch = I_T / V
//       I_T = ∑ 2×halfWidth × sliceWidth × z_i² （縦揺れ、横断軸周り、z_i=前後位置）
//  KG : キールから重心（physics.cgOffset.y）までの高さ
//  GM = KB + BM - KG
// ============================================================
function computeHullGM() {
    const hp = window.hullProfile;
    if (!hp || !hp.ready || !hp.slices.length) return null;

    const physScale       = Math.max(0.25, physics.scale || 1);
    const localWaterlineY = physics.waterlineOffsetY + physics.draftOffset / physScale;
    const localKeelY      = hp.keelY;

    const sliceWidth = (hp.halfLen * 2) / hp.slices.length;
    let V       = 0;  // 没水体積（ローカル³）
    let sumVy   = 0;  // KB積分（∑体積要素 × Y）
    let sumVz   = 0;  // LCB積分（∑体積要素 × 前後位置）
    let I_L     = 0;  // 横揺れ水面断面2次モーメント
    let I_T     = 0;  // 縦揺れ水面断面2次モーメント

    for (const sl of hp.slices) {
        if (sl.draft <= 0.0001 || sl.halfWidth <= 0) continue;
        const localKeelSliceY = hp.designWaterlineY - sl.draft;
        const totalDepth      = localWaterlineY - localKeelSliceY;
        if (totalDepth <= 0) continue;

        // 多層積分（DISP_LAYERSと同じ分割）
        const layerH = totalDepth / DISP_LAYERS;
        let sliceV = 0, sliceVy = 0;
        for (let li = 0; li < DISP_LAYERS; li++) {
            const dFromKeel = (li + 0.5) * layerH;
            const effHalfW  = dFromKeel <= sl.draft
                ? sl.halfWidth * Math.pow(dFromKeel / sl.draft, DISP_BETA)
                : sl.halfWidth;
            const dA = 2.0 * effHalfW * layerH;
            sliceV  += dA;
            sliceVy += dA * (localKeelSliceY + dFromKeel); // ローカルY積分
        }
        sliceV  *= sliceWidth;
        sliceVy *= sliceWidth;
        V      += sliceV;
        sumVy  += sliceVy;
        sumVz  += sliceV * (sl.alongNorm * hp.halfLen); // LCB積分（前後位置）

        // 水面での半幅（I 計算用）
        const hw = sl.halfWidth;
        // I_L: (2B)³/12 × sliceWidth  per スライス
        I_L += sliceWidth * (2 * hw) * (2 * hw) * (2 * hw) / 12.0;
        // I_T: A_wp_i × z_i²   (z_i = スライスの前後位置)
        const z_i = sl.alongNorm * hp.halfLen;
        I_T += 2.0 * hw * sliceWidth * z_i * z_i;
        // スライス奥行き分のセルフ I_T 項
        I_T += 2.0 * hw * (sliceWidth * sliceWidth * sliceWidth) / 12.0;
    }

    if (V < 1e-10) return null;

    // KB: キールからの浮力中心高さ（ローカル）
    const KB_local  = sumVy / V - localKeelY;
    const BM_roll_local  = I_L / V;
    const BM_pitch_local = I_T / V;

    // KG: キールから重心まで（ローカル）
    const KG_local  = physics.cgOffset.y - localKeelY;

    const GM_roll_local  = KB_local + BM_roll_local  - KG_local;
    const GM_pitch_local = KB_local + BM_pitch_local - KG_local;

    // LCB（浮力中心の前後位置、ローカル＝cgOffset.zと同じ座標系）
    // 船体形状は左右対称にスキャンしているため TCB（左右）は常に0。
    const LCB_local = sumVz / V;

    // ワールド単位(m)で返す
    return {
        KB:       KB_local       * physScale,
        KG:       KG_local       * physScale,
        BM_roll:  BM_roll_local  * physScale,
        BM_pitch: BM_pitch_local * physScale,
        GM_roll:  GM_roll_local  * physScale,
        GM_pitch: GM_pitch_local * physScale,
        V_m3:     V * physScale  * physScale * physScale,
        LCB_local: LCB_local,           // ローカル座標（cgOffset.zと同じ単位）
        LCB_world: LCB_local * physScale,
    };
}

// ============================================================
//  復元力パラメータ自動チューン
// ============================================================
//  computeHullGM() の幾何的 BM を 17-main-loop.js の物理モデルに当てはめ
//  physics.buoyancy と physics.waterlineOffsetY を自動設定する。
//
//  【buoyancy 逆算】
//    BM_roll_model = restoringBase × k_gyro_roll² / g_eff
//    restoringBase = 1 + buoyancy × 1.8
//    → buoyancy = (BM_roll_geom × g_eff / k_gyro_roll² - 1) / 1.8
//
//  【waterlineOffsetY 調整】
//    h_pend_geom = KB_geom - KG_geom  （浮力中心と重心の高さ差）
//    physics側:  h_pend = (waterlineOffsetY - cgOffset.y) × physScale
//    → waterlineOffsetY = cgOffset.y + h_pend_geom / physScale
// ============================================================
function autoTuneRestoration() {
    const hp = window.hullProfile;
    if (!hp || !hp.ready) {
        alert('先に船体モデルを読み込んでスキャンしてください。');
        return;
    }

    const gm = computeHullGM();
    if (!gm) {
        alert('GM計算失敗: スキャンデータが不足しています。');
        return;
    }

    const physScale        = Math.max(0.25, physics.scale || 1);
    const len              = hp.halfLen  * 2 * physScale;
    const wid              = hp.halfBeam * 2 * physScale;
    const g_eff            = 9.81;

    // 17-main-loop.js と同じジャイロ半径
    const k_gyro_roll  = wid * 0.35;

    // buoyancy 逆算（横揺れBMベース）
    const restoringBase_new = gm.BM_roll * g_eff / (k_gyro_roll * k_gyro_roll);
    const buoyancyNew = THREE.MathUtils.clamp(
        (restoringBase_new - 1.0) / 1.8,
        1.0, 50.0
    );

    // 参考値のみ計算（waterlineY は変更しない — 喫水が勝手に変わる問題を防ぐ）
    const h_pend_geom  = gm.KB - gm.KG;
    const waterlineYRef = THREE.MathUtils.clamp(
        physics.cgOffset.y + h_pend_geom / physScale,
        -5.0, 5.0
    );

    // ベース値を保存し、倍率スライダーを1.0にリセット
    // → setter経由で physics.buoyancy = buoyancyNew * 1.0 が設定される
    physics.buoyancyBase = buoyancyNew;

    const syncAndFire = (slId, numId, val, dec) => {
        const sl = document.getElementById(slId);
        const nm = document.getElementById(numId);
        if (!sl) return;
        sl.value = val;
        sl.dispatchEvent(new Event('input')); // → setter(v) → physics.xxx 更新
        if (nm) nm.value = val.toFixed(dec ?? 2);
    };
    syncAndFire('buoyancy-slider', 'buoyancy-num', 1.0, 2); // 倍率リセット → buoyancy = buoyancyNew
    // waterlineY-slider は変更しない（喫水が勝手に変わる問題を修正）

    // GM 表示を更新
    const el = document.getElementById('gm-readout');
    if (el) {
        el.style.display = 'block';
        el.innerHTML =
            `<b>幾何GM（自動計算結果）</b><br>` +
            `KB = ${gm.KB.toFixed(2)} m &nbsp; KG = ${gm.KG.toFixed(2)} m<br>` +
            `BM_roll = ${gm.BM_roll.toFixed(2)} m &nbsp; BM_pitch = ${gm.BM_pitch.toFixed(2)} m<br>` +
            `<b style="color:#0f0">GM_roll = ${gm.GM_roll.toFixed(2)} m</b> &nbsp;` +
            `GM_pitch = ${gm.GM_pitch.toFixed(2)} m<br>` +
            `排水量 = ${Math.round(gm.V_m3 * 1.025).toLocaleString()} t<br>` +
            `→ 復元力ベース = <b>${buoyancyNew.toFixed(1)}</b>（GM倍率で微調整可）<br>` +
            `<span style="color:#aaa">参考: 喫水線基準点 推奨値 = ${waterlineYRef.toFixed(2)}` +
            ` （現在: ${physics.waterlineOffsetY.toFixed(2)}）</span>`;
    }

    console.log(
        `[AutoTune] KB=${gm.KB.toFixed(2)} KG=${gm.KG.toFixed(2)}` +
        ` BM_roll=${gm.BM_roll.toFixed(2)} BM_pitch=${gm.BM_pitch.toFixed(2)}` +
        ` GM_roll=${gm.GM_roll.toFixed(2)} GM_pitch=${gm.GM_pitch.toFixed(2)}` +
        ` → buoyancyBase=${buoyancyNew.toFixed(1)} (waterlineY参考:${waterlineYRef.toFixed(2)}, 現在:${physics.waterlineOffsetY.toFixed(2)})`
    );
}

window.computeHullGM      = computeHullGM;
window.autoTuneRestoration = autoTuneRestoration;

// ============================================================
//  重心位置（前後・左右）自動バランス
// ============================================================
//  波が無くても船が斜めになるのは、多くの場合「重心(CG)の前後・左右位置」が
//  「浮力中心(LCB/TCB)」とズレているため。静止状態でのトリム/ヒールを0にするには
//  CG の水平位置を LCB（=ほぼTCBは船体形状が左右対称なら0）に一致させればよい。
//
//  高さ(KG = cgOffset.y)はユーザー指定式を維持し、ここでは触らない。
//  前後(cgOffset.z) → 船体形状から計算したLCBに自動設定
//  左右(cgOffset.x) → 船体は左右対称にスキャンしているため0に自動設定
// ============================================================
function autoTuneCG() {
    const hp = window.hullProfile;
    if (!hp || !hp.ready) {
        alert('先に船体モデルを読み込んでスキャンしてください。');
        return;
    }

    const gm = computeHullGM();
    if (!gm) {
        alert('重心バランス計算失敗: スキャンデータが不足しています。');
        return;
    }

    const cgZNew = THREE.MathUtils.clamp(gm.LCB_local, -10.0, 10.0);
    const cgXNew = 0.0; // 船体形状は左右対称スキャンのためTCB=0

    const syncAndFire = (slId, numId, val, dec) => {
        const sl = document.getElementById(slId);
        const nm = document.getElementById(numId);
        if (!sl) return;
        sl.value = val;
        sl.dispatchEvent(new Event('input')); // → setter(v) → physics.cgOffset.x/z 更新
        if (nm) nm.value = val.toFixed(dec ?? 2);
    };
    syncAndFire('cgz-slider', 'cgz-num', cgZNew, 2);
    syncAndFire('cgx-slider', 'cgx-num', cgXNew, 2);

    const el = document.getElementById('gm-readout');
    if (el) {
        el.style.display = 'block';
        el.innerHTML =
            `<b>重心バランス自動設定（前後・左右）</b><br>` +
            `LCB（浮力中心・前後） = ${gm.LCB_local.toFixed(2)} → CG Z に設定<br>` +
            `TCB（浮力中心・左右） = 0.00（左右対称）→ CG X に設定<br>` +
            `<span style="color:#aaa">CG Y（高さ）は変更していません（現在: ${physics.cgOffset.y.toFixed(2)}）</span>`;
    }

    console.log(`[AutoTuneCG] LCB_local=${gm.LCB_local.toFixed(3)} → cgOffset.z=${cgZNew.toFixed(3)}, cgOffset.x=${cgXNew.toFixed(3)}`);
}

window.autoTuneCG = autoTuneCG;

