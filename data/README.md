# 現実世界の地形データ

ゲームの「実在：北大西洋」は、下の natl（大洋の土台）の上に britain・useast の細かい格子を重ね（縁の 0.12° でなめらかにつなぐ）、
さらに harbors/ の作り込んだ港を重ねた 1 つの世界。

## natl.png / natl.json（北大西洋の土台：アメリカ東海岸〜ブリテン諸島・イベリア半島・アゾレス・ニューファンドランド）

- 範囲：北緯 24.3°〜61.0°、西経 82.0°〜東経 3.0°（1.5 分角 ≒ 2.8km ごと、3401 × 1469 点）
- 元データ：NOAA NCEI **ETOPO 2022**（15 秒角）を ERDDAP から 6 点おきに取ったもの
- 作り直し：`python3 fetch_natl.py <作業フォルダ>` → `python3 build_natl.py <作業フォルダ>`

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
