# 港のまわりの詳しいデータ（水深・浚渫区域・港湾施設）：調査と試験実装

確認日：2026-10-31。各データの利用条件は変わることがあるので、使う前に出典の URL で確かめ直すこと。

## 0. 今の作り（調べた結果）

| 層 | ファイル | 中身 | 読み込み |
|---|---|---|---|
| 世界全体 | `data/world/overview.*`・`tNN_NN.webp` | ETOPO 2022（6 分角の全体図＋10° 区画の 1.5 分角） | 全体図は最初、区画は船・地図のまわりだけ |
| 地域の格子 | `data/britain.*`・`useast.*`・`japan.*` | ETOPO 2022 15〜20 秒角 | 船のまわりの区画を読むときに、かかる地域だけ（0.03.030.001 から） |
| 作り込んだ港 | `data/harbors/<key>.png`・`.json` | 10m 格子（高さ 0.1m・種類：海／陸／ドック／桟橋／港の敷地） | 港から 150km 以内に来たら（`worldEnsureHarbors`） |
| 港の施設 | `data/harbors/<key>_feat.json` | OpenStreetMap の建物・標識・クレーン | 同上（51-harbor-detail.js） |

高さの選び方は「作り込んだ港 → 地域の格子 → 10° 区画 → 全体図」の順（43-world.js の `worldHeightAt`）。
ETOPO の読み込み・描画はこの調査では変えていない。

これまでの作り込んだ港は、大きな客船が入れるように、港の航路（`_rwCarveHD`：24m）・岸壁の前（`berth_reach`）を
**ゲームのために掘っていた**（実際の水深ではない）。今回の試験の港（`measured`）では掘らない。

## 1. データ源と 2. 利用条件

判定：◎ 採用（試験で使用）／○ 使ってよい（今回は不要）／△ 保留（採用前に確認が必要）／× 採用しない

| データ | 提供元 | 中身・細かさ | ライセンス・利用条件（加工・再配布・Web 公開） | 判定 |
|---|---|---|---|---|
| **BlueTopo**（National Bathymetric Source） | NOAA Office of Coast Survey | 米国沿岸の水深の合成。港のそばは 2〜16m（フォール・リヴァーは 4m）。GeoTIFF（高さ・不確かさ・元の測量の番号）、NAD83/UTM、NAVD88[m] | 合成したもの全体は **CC0-1.0**（「There are no restrictions on the BlueTopo products」）。ただし元の測量ごとに条件があり得るので、**タイルの RAT の license_name を全部確かめる**（build_harbor.py の `BT_OK_LICENSES` 以外が 1 つでもあれば止まる）。フォール・リヴァーの 8 タイル・33 測量はすべて CC0-1.0（NOAA・USACE） | ◎ |
| **National Channel Framework**（ChannelReach） | U.S. Army Corps of Engineers | 連邦の航路・回頭水域・泊地の多角形と、計画水深（authorized）・維持水深（maintained）・幅（フィート） | 米国政府の著作物（17 U.S.C. §105：米国では著作権なし）。配布元の記載「While there are no explicit constraints on the use of the data」（利用の制限なし）。正確さの保証なし | ◎ |
| Coastal Relief Model 2023 | NOAA NCEI | 1 秒角（≒30m）の水深・陸の高さ、NAVD88 | 米国政府のデータ（パブリック・ドメイン）。すでに米国の港で使用 | ◎（BlueTopo の無い所） |
| OpenStreetMap | OpenStreetMap Foundation | 海岸線・桟橋・防波堤（man_made=pier/breakwater/groyne/quay）・港の敷地・建物 | **ODbL 1.0**：複製・配布・改変・Web 公開可。出典表示（© OpenStreetMap contributors）と、**加工したデータベース（`<key>.png`・`_feat.json` の陸と施設の部分）を公開するなら ODbL で**（共有の継承）。リポジトリは公開なので満たしている。すでに使用 | ◎ |
| EMODnet Bathymetry DTM | EMODnet（EU） | 欧州の水深 1/16 分（≒115m） | CC BY 4.0（出典表示で改変・再配布・Web 公開可）。すでに英国の港で使用 | ○ |
| GEBCO Grid | GEBCO（IHO・IOC） | 全球 15 秒角 | パブリック・ドメイン（複製・配布・改変・商用可。出典表示・公式と誤認させないこと・航海に使わないこと） | ○（港には粗すぎ。ETOPO 2022 と同程度） |
| **NOAA ENC**（S-57） | NOAA Office of Coast Survey | 海図の地物：浚渫区域（DRGARE＋DRVAL1）・水深区域（DEPARE）・測深（SOUNDG）・岸壁／防波堤（SLCONS）・バース（BERTHS）・錨地（ACHARE）など | NOAA の図書館の記録では **CC0-1.0**。一方、ENC の利用規約（User Agreement）は「再配布は自由」としつつ、**加工して他の製品に組み込むときは、その製品の作り手が全責任を負い、複製の条件（利用規約を見せて同意を得る・出典のサイトを示す）に従うこと**とある。Web アプリに組み込んだときに「利用規約の表示と同意」が要るのかが不明確 | △ **要確認** |
| UKHO ADMIRALTY Marine Data Portal（水深） | 英国水路部 | 英国周辺の測量の水深面 | Open Government Licence に「航海・航海用の製品に使わない」「決められた出典表示を入れる」の条件を足したもの、と説明がある。出典表示の文言・条件の全文を確認できていない | △ **要確認** |
| 国土数値情報 港湾データ（C02） | 国土交通省 | 港湾区域・港域の線、外郭施設・係留施設の延長（水深なし） | ページの利用条件が「**非商用**」。水深・施設の形は無い | × |
| JODC J-EGG500 | 日本海洋データセンター | 日本周辺の 500m 格子の水深 | 公式の再配布・加工の条件を確認できず（別サイトに CC BY の記載があるが裏付け不十分）。500m で ETOPO 2022（15 秒角）と大差なし | × |
| 海しる | 海上保安庁 | 各機関のデータの重ね表示 | データごとに提供元の方針に従う。条件を確認できず | × |
| USACE eHydro（航路の測量） | U.S. Army Corps of Engineers | 航路の中の測量 | NCF と同じく米国政府の著作物。BlueTopo に元の測量として入っている（フォール・リヴァーでは USACE の 2008〜2026 年の測量が入っている） | ○（BlueTopo 経由で使用） |

出典 URL：
- BlueTopo：https://nauticalcharts.noaa.gov/data/bluetopo.html ・ FAQ https://nauticalcharts.noaa.gov/data/bluetopo_faq.html ・ 仕様 https://nauticalcharts.noaa.gov/data/bluetopo_specs.html ・ データ https://noaa-ocs-nationalbathymetry-pds.s3.amazonaws.com/index.html ・ Coast Survey のライセンス https://nauticalcharts.noaa.gov/data/data-licensing.html
- National Channel Framework：https://geospatial-usace.opendata.arcgis.com/maps/9227967a27484109 （FeatureServer：https://services7.arcgis.com/n1YM8pTrFmm7L4hs/ArcGIS/rest/services/National_Channel_Framework/FeatureServer）
- Coastal Relief Model：https://www.ncei.noaa.gov/products/coastal-relief-model
- OpenStreetMap：https://www.openstreetmap.org/copyright
- EMODnet：https://emodnet.ec.europa.eu/en/bathymetry
- GEBCO：https://www.gebco.net/data-products/gridded-bathymetry/terms-of-use
- NOAA ENC：https://nauticalcharts.noaa.gov/charts/noaa-enc.html ・ 利用規約 https://charts.noaa.gov/ENCs/Agreement.shtml ・ CC0 の記録 https://repository.library.noaa.gov/view/noaa/71555
- UKHO：https://www.gov.uk/guidance/inspire-portal-and-medin-bathymetry-data-archive-centre
- 国土数値情報 C02：https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-C02-v3_2.html
- J-EGG500：https://www.jodc.go.jp/data_set/jodc/jegg_intro.html
- 海しる：https://www.msil.go.jp/

どのデータも「航海に使ってはいけない」（ゲームの見た目と遊びのための近似）。

## 3. 形式と容量（フォール・リヴァー：12.2km × 9.2km、10m 格子 1225 × 915）

| 形式 | 大きさ | ブラウザでの読み方 | 向き |
|---|---|---|---|
| 元の BlueTopo GeoTIFF（4m、3 層 float32、8 タイル） | 31.5MB（＋タイル割り 6.7MB） | GeoTIFF の読み込み部品（geotiff.js 等）が必要 | リポジトリには置かない（作るときだけ） |
| float32 の生データ / gzip | 4.5MB / 0.89MB | `DecompressionStream`＋自前の形式 | × |
| int16（0.1m）＋種類の生データ / gzip | 3.4MB / 0.73MB | 同上 | △ |
| **PNG（今の形式：R・G＝高さ 0.1m、B＝種類）** | **0.42MB** | `createImageBitmap`（ブラウザに元からある） | ◎ そのまま使う |
| WebP 可逆 | 0.26MB | 同上（読み込み側のファイル名を変えれば使える。日本の格子などは WebP） | ○（もっと小さくしたいとき） |
| PNG タイル（ズームごと） | — | 地図用の表示向き | 港 1 つなら不要。全球の細かい地形なら検討 |
| 浚渫区域 JSON（今回の形） / GeoJSON / gzip | 6.4KB / 6.7KB / 1.3KB | `JSON.parse` | ◎（施設・区域の線と面は JSON） |

港ごとに分けて、近づいた港だけ読む（`worldEnsureHarbors`）ので、遠くの港のデータは読まない。

## 4. 統合の方法（提案と、試験で入れた所）

1. **全球の土台は ETOPO のまま**。港の枠の中だけ、細かい格子（`<key>.png`）を優先し、枠の縁 250m でなじませる（今の仕組み）。
2. **水深と施設・区域を分けて持つ**：
   - `<key>.png`：測った水深・陸の高さ（BlueTopo → 無い所は CRM）と、陸／水／桟橋の種類（OSM）
   - `<key>_channels.json`：浚渫区域（範囲・計画水深・維持水深・基準面・出典）。**地形には混ぜない**
   - `<key>_feat.json`：建物・標識（OSM）
   - `<key>.json`：範囲・出典（`sources`：提供元・ライセンス・座標系・基準面・解像度・測量の年）
3. **実測の港（`measured`）では掘らない**：港の航路（`_rwCarveHD`）・岸壁の前（`_portAdjust`）・ドック・バースの前を掘らず、
   測った深さのまま。港の航路の深さ（`fairway.depth`：深い船を沖で止める判断に使う）は、浚渫区域の中の実測の深さ（浅い方から 5%）。
4. **浚渫区域の使い方**：港の中の航路探し（`_rwDetailRoute`）は、航路・回頭水域の中を通りやすく（実際の船と同じく掘ってある所を通る）。
   海図モードでは、範囲を破線、維持水深を「浚渫 10.7m」のように、測深値（斜体の数字）とは別に描く。
5. **座標系・基準面・単位**：
   - 平面：BlueTopo（NAD83 / UTM）→ 緯度・経度（WGS84）に置き直す（NAD83 と WGS84 の差は 1m ほどで、10m 格子では無視）
   - 高さ：BlueTopo・CRM は NAVD88[m]。ゲームの海面 0 ≒ 平均海面（ニューイングランドでは NAVD88 と平均海面の差は 0.1〜0.3m ほど）
   - 浚渫区域の深さ：フィート → m。基準面は記録に無い（米国の連邦航路はふつう MLLW＝平均低低潮面。フォール・リヴァーでは平均海面より 0.7m ほど低い）。
     換算はせず、**値と基準面をそのまま記録**する
   - 測量時期：`sources[].survey_years`（フォール・リヴァーは 1951〜2026 年の 33 測量）
6. **広げ方**：ほかの米国の港（ニューヨーク・ボストン・フィラデルフィア・ボルティモア・ノーフォーク）も `bathy='bluetopo'`・`ncf=True`・`measured=True` で
   作り直せる。ただし今は 1911 年ごろの大きな客船が入れるように深く掘ってあるので、実測にすると今の深さ（場所によっては浅い）になる（下の確認事項）。

## 5. 試験実装：フォール・リヴァー（マサチューセッツ州。マウント・ホープ湾〜トーントン川）

- 作り方：`python3 data/harbors/build_harbor.py fallriver --cache <作業フォルダ>`（tifffile・imagecodecs・pyproj が要る）
- できたもの：`fallriver.png`（419KB）・`fallriver.json`・`fallriver_channels.json`（14 区域：航路 12・回頭水域 1・泊地 1）・`fallriver_feat.json`
- 港の置き場所：州営埠頭（State Pier）の北西の面（前は実測 11〜12m）。航路はマウント・ホープ橋の下からナラガンセット湾の東水道へ
  （`data/world/overview_fairways.json`・`data/natl_fairways.json` のこの港だけ作り直した）
- 実測と計画の違い（浚渫区域ごとの実測の深さの中央値／維持水深 MLLW）：35ft 本航路 11.1〜13.2m／10.67m、
  30ft アクセス航路 **7.5m**／9.14m（埋まっている）、西の泊地 6.8m／7.62m。こうした違いを地形に混ぜずに残せている
- 確かめたこと：ニューヨーク・ボストン → フォール・リヴァーの航路、湾の中からの航海（座礁なし。船底の下の水深は最小 9.2m）、
  海図の表示、ほかの港（東京湾・サウサンプトン・フィラデルフィア）の航路が変わらないこと

## 6. 採用前に確認が必要なこと

1. **NOAA ENC**：加工したデータ（浚渫区域・岸壁・防波堤・バース・錨地の形）をこのアプリに組み込んで公開するとき、
   利用規約の「複製の条件（規約を見せて同意を得る）」が掛かるかが不明確。採用するなら、NOAA への問い合わせか、
   起動時に ENC の利用規約を表示するなどの対応を決めてから
2. **UKHO の水深**：英国の港（サウサンプトン・リヴァプールなど）を実測にするなら、出典表示の文言と条件の全文を確認してから
3. **日本の港**：利用条件を確かめられた公開の細かい水深データが見つかっていない（今の日本の湾は ETOPO 2022 の 15 秒角のまま）
4. **ほかの米国の港を実測にするか**：今の深さ（実測）にすると、1911 年ごろの大きな客船（喫水 10m 超）が入れない港が出る
