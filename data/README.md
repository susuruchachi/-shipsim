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
