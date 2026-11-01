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
| UKHO ADMIRALTY Marine Data Portal（水深） | 英国水路部 | 英国周辺の測量の水深面 | OGL v3.0 に 2 条件（航海・航海用の製品の作成に使わない／決められた出典文）を足したもの。ゲームの船のシミュレーターが「航海用の製品」に当たるかが不明確（8 章） | △ **要確認（UKHO へ問い合わせ）** |
| 国土数値情報 港湾データ（C02） | 国土交通省 | 港湾区域・港域の線、外郭施設・係留施設の延長（水深なし） | 「**非商用**」＝非商用目的のみ・**複製物の再配布は不可**（8 章）。水深・施設の形は無い | × |
| JODC J-EGG500 | 日本海洋データセンター | 日本周辺の 500m 格子の水深 | 公式の再配布・加工の条件を確認できず（メタデータの利用制約は「JODC に許可を求めること」）。500m で ETOPO 2022（15 秒角）と大差なし | × |
| 海しる（API v3） | 海上保安庁 | 各機関のデータの重ね表示。海上保安庁の「等深線」は 20・50・100・150・200m だけ | 本体の規約は公共データ利用規約 1.0（CC BY 4.0 と互換）。ただし水深は港には粗すぎる（8 章） | ×（条件は可、データが粗い） |
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
2. **UKHO の水深**：英国の港（サウサンプトン・リヴァプールなど）を実測にするなら、UKHO にこのアプリが「航海用の製品」に当たらないかを確かめてから（8 章）
3. **日本の港**：利用条件を確かめられた公開の細かい水深データが見つかっていない（今の日本の湾は ETOPO 2022 の 15 秒角のまま。8 章）
4. **ほかの米国の港を実測にするか**：今の深さ（実測）にすると、1911 年ごろの大きな客船（喫水 10m 超）が入れない港が出る

## 7. アメリカの全部の港へ（0.03.032.000）

- 作り込んだ港（`data/harbors/<key>`）を、アメリカの港ほぼ全部（東海岸・メキシコ湾・カリフォルニア・ハワイ・アラスカのジュノー・プエルトリコ・米領ヴァージン諸島）に広げた。
  範囲は `us_auto.json`（港のまわり 3.5km と、港の航路の最初の 9km。1 辺 24km まで。10m か 15m おき）。
  前からのニューヨーク・ニューヨーク湾・ボストン・フィラデルフィア・ボルティモア・ハンプトン・ローズも実測（`measured`）に作り直した
- 水深：BlueTopo → 無い所は CRM 2023（東海岸・メキシコ湾・プエルトリコ・ハワイ）。CRM の無い所（カリフォルニア・ジュノー）は BlueTopo だけ
  （陸の高さは世界の区画）。ニューオーリンズ（ミシシッピ川）とハワイは BlueTopo が無く、CRM だけ
- **BlueTopo の元の測量の利用条件**：CC0-1.0 と CC BY 4.0 を通す（CC BY 4.0：フロリダ内水路管理区・米地質調査所などの測量。出典を
  `<key>.json` の `sources[].attribution` に書き、地図の下に出典を出す）。利用条件の欄が空の測量は、提供元が NOAA なら CC0
  （Coast Survey の方針「All data acquired by Coast Survey is formally dedicated to the public domain」）。それ以外の空欄・ほかの条件は作るのを止める
- **昔の埠頭**：ニューヨークのチェルシー埠頭（59 番：ホワイト・スター・ライン）など、一覧（`<key>_berths.json`）に入れた埠頭の前と、
  埋め立て前に戻した所（history）・ドックだけは、その時代に合わせて掘り、いちばん近い実測の深い所へつなぐ（今は浅くなっている）。
  それ以外は測った深さのまま
- **まだ実測にしていない港**（公開の細かい水深が無い：BlueTopo も CRM 2023 も無い）：シアトル・タコマ・ブレマートン（ピュージェット湾）・
  アストリア（コロンビア川）・アンカレッジ・ダッチ・ハーバー。NOAA NCEI の地域ごとの DEM（パブリック・ドメイン）で作れる見込み
- 読み込み：一覧は `data/harbors/index.json`（1 つ読むだけ）。地形は船・行き先から 50km（自動航行の計画は 60km）に入った港だけ読み、
  120km より遠くなった港は捨てる（8 港まで）。画像は可逆の WebP
- 港の置き場所・航路（`data/world/overview_fairways.json`・`data/natl_fairways.json`）を、細かい地形の上で作り直した。
  実測の港の航路の深さは、その港の道すじの実測の深さ（浅い方から 5%）

### ほかの国の港

| 地域 | 使えるデータ | 状況 |
|---|---|---|
| 欧州 | EMODnet（CC BY 4.0、115m）＋OSM | 英国の 4 港は作り込み済み（実測ではなく、大きな客船のために掘ってある）。115m なので岸壁の前は細かくない |
| 英国 | UKHO（OGL＋条件） | 「航海用の製品」に当たらないかを UKHO に問い合わせるまで保留（8 章） |
| 日本 | — | 条件を確認できた公開の細かい水深なし（海しる・国土数値情報・JODC を再調査。8 章） |
| その他 | GEBCO・ETOPO（15 秒角）＋OSM の岸・桟橋 | 岸と港の施設の形だけなら、どこでも OSM で作れる（水深は粗いまま） |

## 8. 英国・日本の再調査（2026 年 11 月）

判断の基準：無料で取れる・見られるだけでは採らない。**GitHub Pages で誰でも見られる形で公開し、データを加工し、
加工したものをリポジトリに置いて配る**ところまで、条件で認められていることを確かめる。確かめられなければ保留。
水深の分からない所を、分かっているかのように描かない。

### 英国（UKHO）

UKHO には条件の違う 2 つの道がある。

| 道 | 条件（公式の記載） | このアプリ |
|---|---|---|
| **著作権の申請ライセンス**（copyright.ukho.gov.uk：非商用・低額商用。無料・1 年） | 非航海の目的で、個人・組織内の利用。直接・間接の収入なし。元の資料（海図など）を自分で持っていること。Web は「画像の形」で 1 日の閲覧 1,000 回未満。**UKHO の言う「航海の目的」には「航海者の訓練（シミュレーターを含む）」が入る** | **合わない**。海図などの複製のためのもの。1 年ごとの許可なので、期限が切れたらリポジトリの公開分を消すことになる。シミュレーターは航海の目的に入り得る |
| **Marine Data Portal の水深**（INSPIRE・測量の水深面） | **OGL v3.0＋2 条件**：(a) 航海、または航海用の製品の作成に使わない。(b) 出典文「Contains public sector information licensed under the Open Government Licence v3.0, from [メタデータにある所有者・作成者]」を入れる（UKHO の CoreTrustSeal 申請書 2022）。data.gov.uk の記録も「航海には不適」「作成者・所有者の表示が必要」 | OGL 自体は加工・再配布・Web 公開・商用まで可。**残る問題は 1 つだけ**：趣味の船のシミュレーターが (a) の「航海用の製品」に当たるか。前の道の定義では「シミュレーター」が航海の目的に入っているので、自分で「当たらない」と決めない |

- 結論：**保留**。UKHO（Licensingteam@ukho.gov.uk）に、
  「無料・広告なしのブラウザーの船のシミュレーター（ゲーム。航海や航海者の訓練には使わない）で、Marine Data Portal の
  水深を 10m の格子に作り直してリポジトリに置き、GitHub Pages で公開してよいか」を問い合わせて、文書で答えをもらってから。
- そのほか：港の中の測量は港の管理者（ABP サウサンプトン・Peel Ports リヴァプールなど）のもので、Portal に無いことがある。
  使える返事が来ても、港の中まで細かくなるかは、ダウンロードして確かめるまで分からない。

### 日本

| データ | 確かめたこと | 判定 |
|---|---|---|
| **海しる API v3**（開発者ポータル） | 2026 年 8 月 27 日にベータ、**10 月 30 日に正式版**（ArcGIS REST の形。v2 は 2027 年 12 月末で終了予定）。API の規約（portal.msil.go.jp/agreement）は、**中身の利用条件は「海洋状況表示システム利用規約」による**（第 6 条）。API を使ったサービスには「海しる API を利用して取得した情報をもとに作成しているが、サービスの内容は海上保安庁によって保証されたものではない」旨の表示が要る（第 5 条）。短期間の大量アクセスは禁止 | 下の本体の規約による |
| 海しる本体の規約（2026 年 9 月 1 日制定） | 特記の無い中身は**公共データ利用規約 1.0（PDL1.0）**、**CC BY 4.0 と互換**（加工・再配布・Web 公開可）。出典「出典：海洋状況表示システム（URL）」と、加工したらその旨。**第三者の権利の中身・API 連携で他から取っている中身は、その提供元の条件**。商用の可否は中身ごと。**水路業務法第 25 条**（海上保安庁の海図などに類似の刊行物を出すときは申請。電子参考図・等深線を表示する GPS プロッターも例に入っている）に注意 | 条件は○ |
| 海しるの「**等深線**」（海上保安庁、制約「-」） | 「水深のグリッドデータから作成した等深線」。実際に配信元（Hosted/depth_contour）を調べると、深さは **20・50・100・150・200m の 5 本だけ**（東京湾の中は 20m と 50m の線が 23 本） | ×：港には粗すぎる（今の ETOPO 2022 より情報が少ない） |
| 海しるの「海底地形図」 | GEBCO・海上保安庁・Esri ジャパンの背景図（画像）。数値の水深ではない | × |
| 海しるの港湾区域・港則法区域・航路・錨地など（海上保安庁） | PDL1.0 で使える。ただし区域の線で、水深・岸壁の形は無い。電子海図から取った地物（沈船・障害物など）は水路業務法第 25 条に気を付ける | 水深には使えない（使う場面ができたら検討） |
| **国土数値情報 港湾データ（C02）** | 利用許諾は「**非商用**」＝「非商用目的のみでの利用（ただし**複製物の再配布を除く**）」（国土数値情報ダウンロードサービスコンテンツ利用規約〔旧国土情報利用約款準拠版〕第 1 条）。点と線（港湾区域界・港域界）、施設延長は交付税の算定用の数値で実際と違う。水深なし | ×：リポジトリに置いて配れない。同じ港湾区域は海しる（PDL1.0）で取れる |
| **JODC J-EGG500** | 500m の格子（平滑化あり。沿岸では実測と大きく違うことがある、と JODC 自身が注意）。公式の利用条件は今回も確かめられず（jodc.go.jp は 2026 年 11 月 1 日時点でメンテナンス中）。国際カタログのメタデータでは利用制約「**JODC に許可を求めること**」 | ×：粗い・条件不明 |
| JODC の実測水深（MGD77 など） | オンラインで自由に一括ダウンロードできない。メタデータの「利用規約」「ライセンス」欄は空 | ×：条件不明 |
| 日本水路協会 M7000（海底地形デジタルデータ） | 有料の製品。使った地図には許可番号を付けている例がある。再配布の条件は確かめられず | × |

- 結論：**日本は引き続き ETOPO 2022 のまま**。条件を満たす公開データ（海しる）はあるが、港に使える細かさの水深が無い。
  細かい水深が要るなら、海上保安庁海洋情報部（または JODC）に、加工・リポジトリでの再配布・Web 公開の可否を問い合わせる。

### 段階的な構成（今の方針）

- 世界中の港の施設（岸・桟橋・防波堤・建物）：OSM（ODbL）で、できる所から
- アメリカ：条件を確かめた実測の水深（BlueTopo・CRM・NCF）
- 英国・日本：問い合わせの返事が来るまで保留（英国は EMODnet 115m、日本は ETOPO のまま）
- そのほかの国：条件がはっきりするまで ETOPO・GEBCO のまま

出典 URL（2026 年 11 月 1 日に確認）：
- UKHO 著作権ライセンス：https://copyright.ukho.gov.uk/ ・ 条件 https://copyright.ukho.gov.uk/QualifyingCriteria.aspx
- UKHO の水深の OGL＋2 条件：https://www.coretrustseal.org/wp-content/uploads/2022/07/20220706-uk-hydrographic-office_final.pdf （UKHO の申請書）・
  https://www.gov.uk/guidance/inspire-portal-and-medin-bathymetry-data-archive-centre
- 海しる API：https://portal.msil.go.jp/ ・ 規約 https://portal.msil.go.jp/agreement ・ v3 https://www.msil.go.jp/data/api/v3-release/
- 海しる本体の規約：https://www.msil.go.jp/data/terms-of-use-ja.pdf ・ カタログ https://www.msil.go.jp/data/catalogue/index.html?view=api
- 水路業務法第 25 条の申請：https://www.kaiho.mlit.go.jp/ope/apply/hyd01.html
- 国土数値情報 C02：https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-C02-v3_2.html ・ 規約 https://nlftp.mlit.go.jp/ksj/other/agreement_02.html
- J-EGG500：https://www.jodc.go.jp/data_set/jodc/jegg_intro.html ・ メタデータ https://zenodo.org/records/23517269
