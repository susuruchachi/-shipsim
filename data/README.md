# 現実世界の地形データ

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
