# 現実世界の地形データ

ゲームの「実在：世界」は、world/ の全体図と区画（世界全体の土台）の上に britain・useast の細かい格子を重ね
（縁の 0.12° でなめらかにつなぐ）、さらに harbors/ の作り込んだ港を重ねた 1 つの世界。
（以前の「実在：北大西洋」の土台 natl.png は、同じ 1.5 分角の world/ の区画に置き換えた。保存した位置はそのまま続きから）

## world/（世界全体の土台）

- `overview.webp` / `overview.json`：全体図。6 分角 ≒ 11km ごと（3601 × 1800 点、経度の端は 1 点重ねる）。いつも読む
  （地図・遠くの海の航路探し）。1.5 分角の 4 × 4 点のまとまりごとに、水が 6 点以上なら水の点の中ほどの深さ（細い海峡が閉じないように）
- `t{緯度の帯}_{経度の帯}.webp` / `index.json`：10°×10° の区画。1.5 分角 ≒ 2.8km ごと（401 × 401 点、となりと 1 点重ねる）。
  船のまわり・自動航行の道すじ・地図で見ている所だけ読む（43-world.js の worldEnsureTiles）。どこも 300m より深い区画（大洋の真ん中）と、
  どこも 20m より高い区画（内陸）は作らない（全体図で足りる）。442 区画
- 形式：可逆の WebP。1 画素が 1 点、高さ[m] ＝ R × 256 ＋ G − 32768（陸は＋、海は−）、上が北。
  船から見えない細かさは丸めてある（陸は 50〜300m を 5m・1500m までを 20m・その上を 50m、海は 200〜1000m を 20m・その下を 100m きざみ）
- 元データ：NOAA NCEI **ETOPO 2022**（15 秒角）を ERDDAP から 6 点おきに取ったもの（米国政府の作成：自由に利用・再配布できる。航海には使えない）
- 作り直し：`python3 fetch_world.py <作業フォルダ>`（72 個の netCDF、各 5.8MB）→ `python3 build_world.py <作業フォルダ>`（numpy・Pillow・scipy が要る）
- 運河・細い海峡・狭い湾口（スエズ・パナマ・キール・ボスポラス・ダーダネルス・関門・シンガポール海峡・グレートベルト・
  エルベ川・セント・ローレンス川・ゴールデン・ゲートなど）は、升目より狭いので、読んだときに線に沿って掘る（43-world.js の RW_CANALS）
- `ports.json`：世界の主な港（北大西洋の港の外）。`[名前, 種類, 緯度, 経度]`（6 番目に `{ at: [緯度, 経度], bearing: 沖の方位 }` を
  書くと、探さずにその位置・向きに置く）。位置はおおよそで、実際の海岸に合わせて数 km 以内で置き直す
- `lanes_src.txt` → `python3 build_lanes.py` → `lanes.json`：世界全体の航路の点（岬・海峡・港の沖）と区間。区画の地形で、
  浅い点を近くの深い所へ寄せ、まっすぐ結ぶと陸・浅瀬を横切る区間に沖の中継点を足す（67-sea-lanes.js が使う）
- `overview_fairways.json`：港の置き場所と航路（港から沖の深い所まで掘る水路）の前計算。ブラウザで世界（実在）を読んでから
  `worldBuildFairwayCache()` の結果を書き出したもの。北大西洋の港は `natl_fairways.json`（前の北大西洋の前計算）の値をそのまま使う

## world/lights*（街明かり・光害：70-night-sky.js）

- 元データ：NASA Earth Observatory **Black Marble 2016**（VIIRS の夜の地球の灯り、3km の灰色の版
  `BlackMarble_2016_3km_gray_geo.tif`。米国政府の作成：自由に利用・再配布できる）
  - 表示用に明るさを強めた画像（都市の中心は 255 で頭打ち）。リニアの明るさは (値/255)^2.2 とみなす
- `lights.webp`：全体の粗い図（0.08° ≒ 9km、4500 × 2250）。画素の値 ＝ √(3 × 3 画素の灯りの平均) × 255。光害（空の明るさ・
  地平線の光の丘）の計算に、まわり 250km を使う。いつも（世界（実在）では）読む
- `lights/lTT_JJ.webp`：海岸の区画（10°×10°、375 × 375 の元の 3km のまま。番号は地形の区画と同じ）。船のまわり 30km の陸に
  灯りの点を置くのに、要る所だけ読む。348 区画。`lights.json`：範囲と区画の一覧
- 作り直し：`python3 build_lights.py <BlackMarble_2016_3km_gray_geo.tif>`

## sky/（夜空：70-night-sky.js・05-sky-dome.js）

- `stars.bin`：7.5 等より明るい星 25,723 個（明るい順。1 個 6 バイト：赤経・赤緯（J2000）・等級・色（B−V））。
  元データ：**Hipparcos 星表**（ESA 1997）、NASA HEASARC の表 `heasarc_hipparcos`
- `milkyway.jpg`：天の川（明るい星を除いた星の光の地図、赤経・赤緯の正距円筒、2048 × 1024）。
  元データ：NASA/Goddard Space Flight Center Scientific Visualization Studio **Deep Star Maps 2020**（`milkyway_2020_4k.exr`。
  Gaia DR2：ESA/Gaia/DPAC）
- `moon.jpg`：月面（1024 × 512）。元データ：NASA SVS **CGI Moon Kit**（`lroc_color_poles_1k.jpg`：LRO の広角カメラの写真）
- 作り直し：`python3 build_sky.py <作業フォルダ>`（OpenEXR（pip の OpenEXR）が要る。入れるファイルは build_sky.py の最初に）

## japan.webp / japan.json（日本の主な湾：九州北部・関門・瀬戸内海・大阪湾・伊勢湾・東京湾・相模湾）

- 範囲：北緯 32.6°〜36.2°、東経 129.6°〜140.95°（15 秒角 ≒ 460m × 380m ごと、2725 × 865 点）。世界全体の区画（1.5 分角）の上に重ねる
  （43-world.js の REAL_WORLDS.japan。縁の 0.12° で土台となめらかにつなぐ）
- 元データ：NOAA NCEI **ETOPO 2022**（15 秒角）そのまま。形式は britain と同じ（高さ ＝ R × 256 ＋ G − 32768、上が北）、可逆の WebP
- 作り直し：`python3 fetch_japan.py <作業フォルダ>` → `python3 build_japan.py <作業フォルダ>`。作り直したら、範囲の中の港の
  置き場所・航路の前計算（world/overview_fairways.json）も作り直す（ブラウザで worldBuildFairwayCache()）

## britain.png / britain.json（ブリテン諸島・アイルランド島のまわり）

- 範囲：北緯 48.3°〜61.0°、西経 11.0°〜東経 3.0°（15 秒角 ≒ 460m ごと、3361 × 3050 点）
- 元データ：NOAA NCEI **ETOPO 2022**（15 arc-second global relief model）
  - https://www.ncei.noaa.gov/products/etopo-global-relief-model
  - 取得：ERDDAP（coastwatch.pfeg.noaa.gov、データセット `ETOPO_2022_v1_15s`）
  - 米国政府の作成したデータで、自由に利用・再配布できます（法的な用途・航海には使えません）。
- 形式：PNG の 1 画素が 1 点。高さ[m] ＝ R × 256 ＋ G − 32768（陸は＋、海は−）。上が北。
  `britain.json` に範囲・点の数・間隔。
- 作り直し：`python3 fetch_britain.py`（ERDDAP から取得）→ `python3 build_britain.py`

## harbors/（作り込んだ港：10m ごとの地形）

- `<key>.png`：R × 256 ＋ G − 32768 ＝ 高さ[0.1m]、B ＝ 種類（0 海・1 陸・2 ドックの水・3 桟橋・4 港の敷地）。上が北。
  `<key>.json` に範囲（緯度・経度）・行と列・1 升の度（dLat・dLon）。
- 作り方：`python3 harbors/build_harbor.py <key>`（範囲などは `HARBORS` に書く）
  - 陸と水・ドック・桟橋・港の敷地：**OpenStreetMap**（api.openstreetmap.org の map を小さな四角ごとに取得）
    - © OpenStreetMap contributors、Open Database License（ODbL）https://www.openstreetmap.org/copyright
  - 水深：**EMODnet Bathymetry** DTM 2024（1/16 分 ≒ 115m ごと、ERDDAP `bathymetry_dtm_2024`）
    - https://emodnet.ec.europa.eu/en/bathymetry （CC BY 4.0）
  - EMODnet に水深の無い所（川の上流など）は 2.5m。ドックは書いてある深さ（1911 年ごろの深さに合わせて最低 12.5m）。
    港の敷地の前（berth_reach）は掘ってあることにし、船が通れないまとまりは、水の上のいちばん近い道で深い航路へつなぐ。
  - 航海には使えません（見た目と遊びのための近似です）。
- 潮の満ち引きが無いので、満潮を待って通る航路（クロスビー水道など）は、港ごとの `channels`（線・幅・深さ）で掘ってある。
- `<key>_feat.json`：水の近くの建物（輪郭・高さ）・航路の標識（ブイ・立標・灯火・バース番号）・クレーン（同じく OpenStreetMap）。
- 今ある港：
  - southampton（サウサンプトン：西ドック・東ドック・オーシャン・ドック・テスト川・イッチェン川・サウサンプトン・ウォーター）
  - liverpool（リヴァプール：マージー川・ピア・ヘッドの浮き桟橋・ドック・クロスビー水道・クイーンズ水道）

## useast.png / useast.json（アメリカ東海岸：フロリダ〜メイン・ノヴァスコシア・バミューダ・バハマの北）

- 範囲：北緯 24.3°〜46.0°、西経 82.0°〜63.0°（20 秒角 ≒ 620m × 470m ごと、3421 × 3907 点）
- 元データ：NOAA NCEI **ETOPO 2022**（15 秒角）を 20 秒角に直したもの（iPad の canvas の大きさの上限と、メモリのため）
  - 船から見えない細かさは丸めてある（50m より高い陸は 5m、200m より深い海は 10m、1000m より深い海は 50m きざみ）
- 作り直し：`python3 fetch_useast.py <作業フォルダ>` → `python3 build_useast.py <作業フォルダ>`

## アメリカの作り込んだ港（harbors/newyork・newyork_bay・boston・philadelphia・baltimore・norfolk）

- 陸と水・桟橋・港の敷地・建物：**OpenStreetMap**（BBBike の都市ごとのまとめファイル：NewYork・CambridgeMa）
  - © OpenStreetMap contributors、Open Database License（ODbL）
  - 作るとき：`SHIPSIM_OSM=<pbf と .poly を置いたフォルダ> python3 harbors/build_harbor.py newyork`（pyosmium が要る）
  - BBBike に無いボルティモア・ハンプトン・ローズは、OpenStreetMap の API（map）から小さな四角に分けて取る
  - ハンプトン・ローズは海岸線の線が少なく塗り分けが崩れるので、陸と水は水深（CRM）の正負で決める（coast='crm'）
- 水深・陸の高さ：**NOAA NCEI Coastal Relief Model 2023**（1 秒角 ≒ 30m、www.ngdc.noaa.gov の THREDDS/OPeNDAP）
  - 米国政府の作成したデータ（パブリック・ドメイン）。航海には使えません
- ニューヨーク：バッテリー・パーク・シティ（1970〜80 年代の埋め立て）を水に戻し、ノース・リバー（マンハッタンの
  ハドソン川側 1〜99 番）・チェルシー埠頭（54〜62 番）・ラグジュアリー・ライナー・ロウ（83〜92 番、1100ft）・
  イースト・リバー・ホーボーケン・ウィーホーケン・ジャージーシティ・ブルックリン・スタテン島の昔の埠頭を、
  番号ごとのおおよその位置から岸に合わせて置いてある（build_harbor.py の pier_groups）。正確な昔の図面ではない
- newyork_bay は外の湾（ロワー・ベイ）を 20m おきで。アンブローズ水道を通って外洋へ出る
- `<key>_berths.json`：着岸できる埠頭の一覧（43-world.js が港の一覧に足す）。埠頭の前は 14m まで掘ってある
- フィラデルフィア（デラウェア川：ポート・リッチモンド〜海軍工廠、対岸のカムデン）・ボルティモア（パタプスコ川：
  ローカスト・ポイント・シーガート・ダンドーク、ブルワートン水道まで）・ハンプトン・ローズ（ノーフォーク海軍基地・
  ノーフォーク国際ターミナル・エリザベス川・ポーツマス・ニューポート・ニューズ、15m おき）も同じ作り方
