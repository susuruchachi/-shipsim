#!/usr/bin/env python3
"""詳しい港の地形（10m おき）を作る。

  python3 build_harbor.py southampton [--cache DIR]

・陸と水：OpenStreetMap（api.openstreetmap.org の map、小さな四角に分けて取る）
    - 海岸線（natural=coastline）は「進む向きの左が陸・右が海」なので、線を引いてから、
      線の右・左の点から塗りつぶして海と陸に分ける
    - ドック・泊地・川（natural=water の water=dock/basin/river…、waterway=dock/riverbank）は水
    - 桟橋・防波堤（man_made=pier/breakwater/groyne/quay の線・面）は陸
・水深：EMODnet Bathymetry DTM 2024（1/16 分 ≒ 115m おき、ERDDAP の esriAscii）をならして使う。
  ドックの中は港ごとに決めた深さ（HARBORS の dock_depth）。
・陸の高さ：岸壁の高さ（4m）。岸から離れた所は britain.png の高さ（4m より高ければ）。

アメリカの港（region='useast'）：
・陸と水：BBBike の OpenStreetMap のまとめファイル（pbf。HARBORS の pbf）。無い港は上と同じく API から
・水深・陸の高さ：NOAA NCEI Coastal Relief Model 2023（1 秒角 ≒ 30m、OPeNDAP。HARBORS の bathy='crm'）
・昔の港の形（history）：埋め立てた所を水に戻す（to_water）・かつての埠頭を足す（pier_groups・piers）
・着岸できる埠頭（berth の付いた埠頭）を <key>_berths.json に（43-world.js が港の一覧に足す）

出力：<key>.png（R×256＋G − 32768 ＝ 高さ[0.1m]、B ＝ 種類：0 海・1 陸・2 ドックの水・3 桟橋・4 港の敷地）
     <key>.json（範囲・行と列・1 升の度）
"""
import json, math, os, sys, time, subprocess
import xml.etree.ElementTree as ET
import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))

# 港ごとの設定：範囲（緯度・経度）、1 升[m]、ドックの深さ[m]
HARBORS = {
    'southampton': dict(name='サウサンプトン', lat0=50.775, lat1=50.918, lon0=-1.448, lon1=-1.240, cell=10, dock_depth=22.0, berth_depth=23.0, berth_reach=400,
                        # 本航路（ドック・ヘッド → サウサンプトン・ウォーター → カルショット沖）。最低潮位で 12.6m ＋ 潮の分
                        channels=[dict(width=260, depth=24.0, pts=[[50.8973, -1.4118], [50.8923, -1.4067], [50.889, -1.4016], [50.8793, -1.3913], [50.8347, -1.3155], [50.8142, -1.2956], [50.8128, -1.2940]])]),
    # リヴァプール：マージー川（ピア・ヘッドの浮き桟橋・ドック）から、クロスビー水道・クイーンズ水道を通ってリヴァプール湾へ
    'liverpool': dict(name='リヴァプール', lat0=53.385, lat1=53.555, lon0=-3.225, lon1=-2.955, cell=10, dock_depth=22.0, berth_depth=23.0, berth_reach=250,
                      # 掘った航路（潮の満ち引きが無いので、満潮を待たずに通れる深さにする）：ピア・ヘッド → マージー川（ナローズ）→ クロスビー水道 → クイーンズ水道 → 西の縁
                      channels=[dict(width=350, depth=24.0, pts=[[53.4025, -3.0010], [53.4100, -3.0060], [53.4250, -3.0150], [53.4410, -3.0265], [53.4577, -3.0367], [53.470, -3.062], [53.4808, -3.0790], [53.5151, -3.1017], [53.521, -3.130], [53.5307, -3.1887], [53.533, -3.226]]),
                                dict(width=450, depth=24.0, pts=[[53.5296, -3.1788], [53.5307, -3.1887], [53.533, -3.226]]),
                                # クロスビー水道からクイーンズ水道へ曲がる所は広く（大きな船が回れるように。内側の通り道は自動）
                                dict(width=700, depth=24.0, pts=[[53.5040, -3.0930], [53.5151, -3.1017], [53.5185, -3.1180]]),
                                dict(width=600, depth=24.0, pts=[[53.5067, -3.0962], [53.5124, -3.1061], [53.5181, -3.1160], [53.5215, -3.1320]]),
                                # シーフォースの川の埠頭（リヴァプール2）の前：岸壁から川の深い所まで
                                dict(width=450, depth=20.0, pts=[[53.45980, -3.03490], [53.45830, -3.03760]])]),
    # グラスゴー：クライド川（キング・ジョージ5世ドック・クライドバンクのジョン・ブラウン造船所）から、グリーノック沖（テイル・オブ・ザ・バンク）まで
    'glasgow': dict(name='グラスゴー', lat0=55.845, lat1=55.975, lon0=-4.790, lon1=-4.270, cell=10, dock_depth=14.0, berth_depth=14.0, berth_reach=150,
                    river_depth=14.0,
                    # クライド川（ボウリング → アースキン → クライドバンク → レンフルー → キング・ジョージ5世ドックの前）：川の真ん中を掘る
                    auto_channels=[dict(a=[55.9300, -4.5300], b=[55.8735, -4.3533], width=140, depth=14.0)],
                    # グリーノックのオーシャン・ターミナルの前と、クライド川の本航路（南岸寄り：グリーノック → ポート・グラスゴー → ダンバートン → ボウリング）
                    channels=[dict(width=300, depth=14.0, pts=[[55.95620, -4.76121], [55.95820, -4.76121]]),
                              dict(width=200, depth=14.0, pts=[[55.9568, -4.7598], [55.9420, -4.7000], [55.9380, -4.6807], [55.9340, -4.6200], [55.9324, -4.5747], [55.9284, -4.4996]])]),
    # ベルファスト：ハーランド＆ウルフ（クイーンズ島・トンプソン・ドック）・ヴィクトリア水道から、ベルファスト湾まで
    'belfast': dict(name='ベルファスト', lat0=54.595, lat1=54.725, lon0=-5.945, lon1=-5.600, cell=10, dock_depth=22.0, berth_depth=23.0, berth_reach=250,
                    # ヴィクトリア水道の口から、ベルファスト湾を北東へ、湾口の深い所まで
                    channels=[dict(width=350, depth=24.0, pts=[[54.6320, -5.8780], [54.6362, -5.8750], [54.6600, -5.8400], [54.6900, -5.7910], [54.6950, -5.7440], [54.6980, -5.7000], [54.7050, -5.6600], [54.7120, -5.6200], [54.7180, -5.6000]])]),
}

# アメリカの港の OpenStreetMap のまとめファイル（BBBike：<名前>.osm.pbf と <名前>.poly）を置いたフォルダ
OSM_DIR = os.environ.get('SHIPSIM_OSM', os.path.join(HERE, 'cache', 'osm'))
US = dict(region='useast', bathy='crm', pbf_dir=OSM_DIR)
HARBORS.update({
    # ニューヨーク（上の湾・ハドソン川（ノース・リバー）・イースト・リバー・ニューアーク湾・キル・ヴァン・カル）
    #  昔の港の形：バッテリー・パーク・シティ（1970〜80 年代の埋め立て）を水に戻し、ウェスト通りの岸壁から昔の埠頭を出す。
    #  マンハッタンのノース・リバー（1〜99 番）・イースト・リバー、ホーボーケン・ジャージーシティ・ウィーホーケン、
    #  ブルックリン（ブッシュ・ターミナル・陸軍ターミナル・ウィリアムズバーグ）、スタテン島（ステープルトン）の昔の埠頭を、
    #  番号ごとのおおよその位置から岸に合わせて置く（今も残っている埠頭はそのまま）
    'newyork': dict(US, name='ニューヨーク', pbf='NewYork', lat0=40.595, lat1=40.830, lon0=-74.205, lon1=-73.905, cell=10,
                    dock_depth=12.5, berth_depth=13.0, berth_reach=200, feat_near=350, feat_min_area=120,
                    restore_depth=11.0, turn_out=320,
                    # 埠頭からの航路の通り道：ナローズ → アンブローズ水道（ロワー・ベイの作り込みの中）→ 外洋
                    berth_via=[[40.6000, -74.0420], [40.5650, -74.0310], [40.5350, -74.0205], [40.5140, -73.9800], [40.4976, -73.9400], [40.4850, -73.9000]],
                    to_water=[[[40.7056, -74.0168], [40.7056, -74.0260], [40.7198, -74.0260], [40.7198, -74.0131], [40.7172, -74.0129],
                               [40.7137, -74.0133], [40.7108, -74.0142], [40.7087, -74.0151], [40.7068, -74.0161]]],
                    pier_groups=[
                        # マンハッタン・ノース・リバー（ハドソン川）：バッテリーから 59 丁目まで
                        dict(name='North River', fmt='{}番埠頭', out=420, depth=12.5, bearing=284, length=220, width=30,
                             nums=list(range(1, 54)) + list(range(65, 76)) + [78, 80, 81, 82, 94, 96, 98],
                             anchors=[[1, 40.7064, -74.0162, 284], [12, 40.7110, -74.0144, 284], [24, 40.7176, -74.0131, 284],
                                      [26, 40.7213, -74.0127, 283], [32, 40.7252, -74.0118, 282], [40, 40.7292, -74.0114, 281],
                                      [45, 40.7330, -74.0109, 280], [49, 40.7360, -74.0107, 280], [53, 40.7404, -74.0106, 283],
                                      [54, 40.7418, -74.0096, 285], [62, 40.7507, -74.0089, 290], [66, 40.7525, -74.0082, 298],
                                      [76, 40.7590, -74.0040, 300], [83, 40.7625, -74.0017, 300], [99, 40.7745, -73.9925, 300]],
                             lengths=dict([(n, 170) for n in range(1, 26)] + [(n, 245) for n in range(54, 63)] + [(n, 300) for n in range(77, 100)]),
                             widths=dict([(n, 26) for n in range(1, 26)] + [(n, 38) for n in range(54, 63)] + [(n, 40) for n in range(77, 100)])),
                        # チェルシー埠頭（1910 年：54〜62 番、長さ 800ft）。大きな客船が入れるよう、形を決めて置く（今ある物は片付ける）
                        dict(name='Chelsea', fmt='{}番埠頭', out=450, depth=13.0, bearing=273, length=300, width=38, force=True,
                             even=True, fixed_root=True, back=70,
                             nums=[54, 56, 57, 58, 59, 60, 61, 62],
                             anchors=[[54, 40.7418, -74.0093, 273], [62, 40.7510, -74.0086, 273]]),
                        # マンハッタン・イースト・リバー：ホワイトホールからコーリアーズ・フックを回って 23 丁目まで
                        dict(name='East River', fmt='イースト・リバー {}番埠頭', out=230, depth=10.0, bearing=145, length=110, width=22,
                             nums=list(range(1, 68)),
                             anchors=[[1, 40.7016, -74.0118, 140], [9, 40.7036, -74.0076, 145], [15, 40.7056, -74.0036, 148], [22, 40.7082, -73.9992, 155],
                                      [32, 40.7103, -73.9900, 160], [42, 40.7114, -73.9786, 170], [45, 40.7142, -73.9760, 100], [55, 40.7225, -73.9727, 100],
                                      [67, 40.7330, -73.9738, 100]],
                             lengths=dict((n, 150) for n in range(45, 68))),
                        # ホーボーケン（ラッカワナ駅の北、1 丁目〜16 丁目）：ハンブルク・アメリカ・ライン・北ドイツ・ロイド・ホランド・アメリカ・ライン
                        dict(name='Hoboken', fmt='ホーボーケン {}番埠頭', out=450, depth=13.0, bearing=97, length=300, width=38, force=True,
                             fixed_root=True, even=True, back=90,
                             nums=list(range(1, 17)),
                             anchors=[[1, 40.7372, -74.0268, 97], [16, 40.7562, -74.0236, 97]]),
                        # ウィーホーケン（ウェスト・ショア鉄道の埠頭）
                        dict(name='Weehawken', fmt='ウィーホーケン {}番埠頭', out=420, depth=11.0, bearing=112, length=230, width=32,
                             nums=list(range(1, 9)),
                             anchors=[[1, 40.7595, -74.0190, 110], [8, 40.7700, -74.0160, 114]]),
                        # ジャージーシティ（ポーラス・フック・エクスチェンジ・プレイス・ハーシマス・パヴォニア）
                        dict(name='Jersey City', fmt='ジャージーシティ {}番埠頭', out=420, depth=11.0, bearing=95, length=230, width=34,
                             nums=list(range(1, 15)),
                             anchors=[[1, 40.7140, -74.0336, 95], [7, 40.7225, -74.0335, 95], [14, 40.7320, -74.0300, 97]]),
                        # ジャージーシティ南（コミュニポー：ニュージャージー中央鉄道の駅と埠頭、ブラック・トム）
                        dict(name='Communipaw', fmt='コミュニポー {}番埠頭', out=420, depth=10.0, bearing=85, length=220, width=32,
                             nums=list(range(1, 9)),
                             anchors=[[1, 40.6990, -74.0390, 80], [8, 40.7085, -74.0365, 88]]),
                        # ブルックリン：ブッシュ・ターミナル（1〜8）と陸軍ターミナル
                        dict(name='Bush Terminal', fmt='ブッシュ・ターミナル {}番埠頭', out=520, depth=11.0, bearing=300, length=400, width=50,
                             nums=list(range(1, 9)),
                             anchors=[[1, 40.6630, -74.0110, 302], [8, 40.6515, -74.0215, 302]]),
                        dict(name='Army Terminal', fmt='ブルックリン陸軍ターミナル {}番埠頭', out=500, depth=11.0, bearing=305, length=380, width=55,
                             nums=[1, 2, 3, 4],
                             anchors=[[1, 40.6455, -74.0255, 305], [4, 40.6430, -74.0300, 305]]),
                        # ブルックリン北（ウィリアムズバーグ・グリーンポイント）
                        dict(name='Williamsburg', fmt='ウィリアムズバーグ {}番埠頭', out=230, depth=9.0, bearing=290, length=120, width=24,
                             nums=list(range(1, 13)),
                             anchors=[[1, 40.7060, -73.9690, 300], [6, 40.7160, -73.9655, 290], [12, 40.7300, -73.9620, 280]]),
                        # スタテン島：トンプキンズヴィル・ステープルトン・クリフトン（1920 年代の市営埠頭、1000ft）
                        dict(name='Stapleton', fmt='ステープルトン {}番埠頭', out=520, depth=12.5, bearing=100, length=300, width=40,
                             nums=list(range(6, 24)),
                             anchors=[[6, 40.6365, -74.0745, 92], [14, 40.6270, -74.0715, 105], [23, 40.6160, -74.0650, 112]]),
                    ],
                    berths={
                        '54番埠頭': ['ニューヨーク港 54番埠頭（キュナード・ライン）', 'passenger', 'LR'],
                        '56番埠頭': ['ニューヨーク港 56番埠頭（キュナード・ライン）', 'passenger', 'R'],
                        '57番埠頭': ['ニューヨーク港 57番埠頭（フレンチ・ライン）', 'passenger', 'R'],
                        '58番埠頭': ['ニューヨーク港 58番埠頭', 'passenger', 'R'],
                        '59番埠頭': ['ニューヨーク港 59番埠頭（ホワイト・スター・ライン）', 'passenger', 'LR'],
                        '60番埠頭': ['ニューヨーク港 60番埠頭（ホワイト・スター・ライン）', 'passenger', 'R'],
                        '61番埠頭': ['ニューヨーク港 61番埠頭', 'passenger', 'R'],
                        '62番埠頭': ['ニューヨーク港 62番埠頭', 'passenger', 'R'],
                        'ホーボーケン 2番埠頭': ['ニューヨーク港 ホーボーケン（ハンブルク・アメリカ・ライン）', 'passenger', 'L'],
                        'ホーボーケン 4番埠頭': ['ニューヨーク港 ホーボーケン（北ドイツ・ロイド）', 'passenger', 'L'],
                        'ホーボーケン 6番埠頭': ['ニューヨーク港 ホーボーケン（ホランド・アメリカ・ライン）', 'passenger', 'L'],
                        'ホーボーケン 10番埠頭': ['ニューヨーク港 ホーボーケン 10番埠頭', 'cargo', 'L'],
                        'ブルックリン陸軍ターミナル 2番埠頭': ['ニューヨーク港 ブルックリン陸軍ターミナル', 'cargo', 'R'],
                        'ブッシュ・ターミナル 2番埠頭': ['ニューヨーク港 ブッシュ・ターミナル', 'cargo', 'R'],
                        'ステープルトン 10番埠頭': ['ニューヨーク港 ステープルトン 10番埠頭', 'passenger', 'L'],
                        'ウィーホーケン 4番埠頭': ['ニューヨーク港 ウィーホーケン（ウェスト・ショア鉄道）', 'cargo', 'R'],
                        'ジャージーシティ 4番埠頭': ['ニューヨーク港 ジャージーシティ（ペンシルヴェニア鉄道）', 'cargo', 'L'],
                        '84番埠頭': ['ニューヨーク港 84番埠頭（イタリアン・ライン）', 'passenger', 'R'],
                        '86番埠頭': ['ニューヨーク港 86番埠頭（ユナイテッド・ステーツ・ライン）', 'passenger', 'R'],
                        '88番埠頭': ['ニューヨーク港 88番埠頭（フレンチ・ライン／マンハッタン・クルーズ・ターミナル）', 'passenger', 'LR'],
                        '90番埠頭': ['ニューヨーク港 90番埠頭（キュナード・ライン）', 'passenger', 'LR'],
                        '92番埠頭': ['ニューヨーク港 92番埠頭（キュナード・ライン）', 'passenger', 'L'],
                    },
                    # ラグジュアリー・ライナー・ロウ（1930 年代の 1100ft の埠頭）：今の埠頭の根元・向きのまま、昔の長さで置き直す
                    osm_rebuild=[['Pier 83', '83番埠頭', 300, 40], ['Pier 84', '84番埠頭', 330, 45], ['Pier 86', '86番埠頭', 330, 45],
                                 ['Pier 88', '88番埠頭', 330, 45], ['Pier 90', '90番埠頭', 330, 45], ['Pier 92', '92番埠頭', 330, 45]],
                    osm_berths=[['Pier 10', 'ニューヨーク港 レッド・フック・コンテナ・ターミナル', 'cargo', 'R'],
                                ['Pier J', 'ニューヨーク港 ブルックリン海軍工廠', 'naval', 'R'],
                                ['Homeport Pier', 'ニューヨーク港 スタテン島ホームポート（海軍）', 'naval', 'L']],
                    berth_group='ニューヨーク港'),
    # ボストン（内港：チャールズタウン・イースト・ボストン・サウス・ボストン、メイン・シップ・チャネルからプレジデント・ローズまで）
    'boston': dict(US, name='ボストン', pbf='CambridgeMa', lat0=42.295, lat1=42.400, lon0=-71.075, lon1=-70.870, cell=10,
                   dock_depth=12.5, berth_depth=12.5, berth_reach=200, feat_near=400, feat_min_area=100, berth_group='ボストン港',
                   # 埠頭からの航路：メイン・シップ・チャネル → キャッスル島沖 → プレジデント・ローズ → ノース・チャネル（ブロード・サウンド）→ 外洋
                   berth_via=[[42.3529, -71.0300], [42.3461, -71.0200], [42.3423, -71.0100], [42.3355, -71.0000], [42.3370, -70.9800],
                              [42.3386, -70.9600], [42.3500, -70.9340], [42.3650, -70.9200], [42.3800, -70.9100]],
                   min_slip=60,
                   osm_berths=[['Boston Fish Pier', 'ボストン港 フィッシュ埠頭', 'cargo', 'R'],
                               ['Commonwealth Pier', 'ボストン港 コモンウェルス埠頭（5番埠頭）', 'passenger', 'R']],
                   extra_auto=[['ボストン港 フリン・クルーズポート（ブラック・ファルコン）', 'passenger', 42.3432, -71.0262, 180],
                               ['ボストン港 コンリー・コンテナ・ターミナル', 'cargo', 42.3412, -71.0100, 45],
                               ['ボストン港 ミスティック埠頭（チャールズタウン）', 'cargo', 42.3878, -71.0590, 350]]),
    # フィラデルフィア（デラウェア川：ポート・リッチモンドから海軍工廠（リーグ島）・スクールキル川の河口まで、対岸のカムデン）
    'philadelphia': dict(US, name='フィラデルフィア', pbf='Philadelphia', lat0=39.860, lat1=39.985, lon0=-75.215, lon1=-75.075, cell=10,
                         dock_depth=12.5, berth_depth=12.5, berth_reach=200, feat_near=350, feat_min_area=120, berth_group='フィラデルフィア港',
                         # 埠頭からの航路：デラウェア川の本水路を下って（海軍工廠の沖 → フォート・ミフリン沖）、デラウェア湾から外洋へ
                         berth_via=[[39.8820, -75.1600], [39.8790, -75.1950], [39.8650, -75.2120], [39.8300, -75.3500], [39.7200, -75.5000], [39.4500, -75.5500]],
                         osm_berths=[['Pier 82', 'フィラデルフィア港 82番埠頭（SS ユナイテッド・ステーツ）', 'passenger', 'L'],
                                     ['Pier 84', 'フィラデルフィア港 84番埠頭', 'cargo', 'R'],
                                     ['Pier 1', 'フィラデルフィア港 クルーズ・ターミナル（海軍工廠 1番埠頭）', 'passenger', 'L'],
                                     ['Pier 4', 'フィラデルフィア港 フィラデルフィア海軍工廠（4番埠頭）', 'naval', 'L'],
                                     ['Pier 16', 'フィラデルフィア港 ポート・リッチモンド（レディング鉄道の石炭埠頭）', 'cargo', 'L']],
                         # 昔の客船の埠頭（ワシントン通りの移民の埠頭：アメリカン・ライン、レッド・スター・ライン）と、今のターミナル
                         extra_auto=[['フィラデルフィア港 ワシントン通り埠頭（アメリカン・ライン／レッド・スター・ライン）', 'passenger', 39.9330, -75.1395, 90],
                                     ['フィラデルフィア港 ペンズ・ランディング（客船）', 'passenger', 39.9450, -75.1385, 90],
                                     ['フィラデルフィア港 パッカー通りマリン・ターミナル（コンテナ）', 'cargo', 39.9025, -75.1330, 110],
                                     ['フィラデルフィア港 タイオガ・マリン・ターミナル', 'cargo', 39.9775, -75.0900, 160],
                                     ['フィラデルフィア港 カムデン（ブロードウェイ・ターミナル）', 'cargo', 39.9040, -75.1300, 290]]),
    # ボルティモア（パタプスコ川：インナー・ハーバー・ローカスト・ポイント・カントン・シーガート・ダンドーク・カーティス湾）
    'baltimore': dict(US, name='ボルティモア', lat0=39.140, lat1=39.290, lon0=-76.620, lon1=-76.400, cell=10,
                      dock_depth=12.5, berth_depth=12.5, berth_reach=200, feat_near=350, feat_min_area=120, berth_group='ボルティモア港',
                      # 埠頭からの航路：フォート・マクヘンリー水道 → ブルワートン水道 → クレイグヒル水道 → チェサピーク湾を下って外洋へ
                      berth_via=[[39.2400, -76.5600], [39.2150, -76.5300], [39.2000, -76.5000], [39.1900, -76.4740], [39.1830, -76.4500], [39.1725, -76.4300], [39.1590, -76.4200], [39.1470, -76.4100], [39.1406, -76.4046], [39.1300, -76.3960]],
                      osm_berths=[['Pier No. 8', 'ボルティモア港 ローカスト・ポイント 8番埠頭（北ドイツ・ロイド／移民の埠頭）', 'passenger', 'R'],
                                  ['Pier No. 5', 'ボルティモア港 ノース・ローカスト・ポイント（5番埠頭）', 'cargo', 'L']],
                      extra_auto=[['ボルティモア港 クルーズ・メリーランド（サウス・ローカスト・ポイント）', 'passenger', 39.2615, -76.5955, 180],
                                  ['ボルティモア港 サウス・ローカスト・ポイント（貨物）', 'cargo', 39.2605, -76.5890, 180],
                                  ['ボルティモア港 シーガート・マリン・ターミナル（コンテナ）', 'cargo', 39.2556, -76.5506, 230],
                                  ['ボルティモア港 ダンドーク・マリン・ターミナル', 'cargo', 39.2396, -76.5341, 200]]),
    # ハンプトン・ローズ（ノーフォーク海軍基地・ノーフォーク国際ターミナル・ランバーツ・ポイント・エリザベス川・ポーツマス・ニューポート・ニューズ）（15m おき）
    'norfolk': dict(US, name='ハンプトン・ローズ', lat0=36.815, lat1=37.010, lon0=-76.460, lon1=-76.270, cell=15, coast='crm',
                    dock_depth=13.0, berth_depth=13.0, berth_reach=200, feat_near=350, feat_min_area=150, berth_group='ノーフォーク港（ハンプトン・ローズ）',
                    # 埠頭からの航路：ハンプトン・ローズ → シンブル・ショール水道 → チェサピーク湾口 → 外洋
                    berth_via=[[36.9900, -76.3200], [36.9990, -76.2800], [36.9850, -76.1800], [36.9500, -76.0500]],
                    osm_berths=[['Pier 12', 'ノーフォーク港 ノーフォーク海軍基地 12番埠頭', 'naval', 'LR'],
                                ['Pier 14', 'ノーフォーク港 ノーフォーク海軍基地 14番埠頭', 'naval', 'L'],
                                ['Norfolk Southern Pier XI', 'ノーフォーク港 ランバーツ・ポイント（石炭埠頭）', 'cargo', 'L']],
                    extra_auto=[['ノーフォーク港 ノーフォーク国際ターミナル（コンテナ）', 'cargo', 36.9180, -76.3320, 270],
                                ['ノーフォーク港 ハーフ・ムーン・クルーズ・ターミナル（客船）', 'passenger', 36.8448, -76.2950, 180],
                                ['ノーフォーク港 ノーフォーク海軍工廠（ポーツマス）', 'naval', 36.8270, -76.2925, 90],
                                ['ノーフォーク港 ニューポート・ニューズ・マリン・ターミナル', 'cargo', 36.9690, -76.4300, 160],
                                ['ノーフォーク港 ニューポート・ニューズ造船所', 'naval', 36.9862, -76.4426, 230],
                                ['ノーフォーク港 ポーツマス・マリン・ターミナル', 'cargo', 36.8763, -76.3492, 100]]),
    # ニューヨークの外の湾（ロワー・ベイ）：ナローズからアンブローズ水道・サンディ・フック水道まで（20m おき）
    'newyork_bay': dict(US, name='ニューヨーク湾', pbf='NewYork', lat0=40.440, lat1=40.625, lon0=-74.140, lon1=-73.790, cell=20,
                        dock_depth=12.5, berth_depth=13.0, berth_reach=150, feat_near=300, feat_min_area=150),
})

UA = 'shipsim-harbor-builder/0.1 (personal ship simulator; one-off download)'


def curl(url, out, tries=4):
    for k in range(tries):
        r = subprocess.run(['curl', '-sS', '-m', '300', '-A', UA, '-o', out, '-w', '%{http_code}', url], capture_output=True, text=True)
        code = r.stdout.strip()
        if r.returncode == 0 and code == '200' and os.path.getsize(out) > 100:
            return True
        print('  retry', k + 1, code, r.stderr.strip()[:120], flush=True)
        time.sleep(3 * (k + 1))
    return False


# ── OpenStreetMap：小さな四角ごとに取って、ひとつにまとめる（点が多すぎる所は 4 つに割って取り直す）──
def fetch_tile(a, b, c, d, cache, depth=0):
    fn = os.path.join(cache, f'osm_{a:.5f}_{c:.5f}_{b:.5f}_{d:.5f}.xml')
    if os.path.exists(fn) and os.path.getsize(fn) > 200:
        return [fn]
    url = f'https://api.openstreetmap.org/api/0.6/map?bbox={c:.6f},{a:.6f},{d:.6f},{b:.6f}'
    r = subprocess.run(['curl', '-sS', '-m', '300', '-A', UA, '-o', fn + '.tmp', '-w', '%{http_code}', url], capture_output=True, text=True)
    code = r.stdout.strip()
    time.sleep(1.0)
    if code == '200' and os.path.getsize(fn + '.tmp') > 100:
        os.replace(fn + '.tmp', fn)
        print('osm', os.path.basename(fn), os.path.getsize(fn), flush=True)
        return [fn]
    if os.path.exists(fn + '.tmp'):
        os.remove(fn + '.tmp')
    if code == '400' and depth < 5:
        ma, mc = (a + b) / 2, (c + d) / 2
        out = []
        for (x0, x1) in ((a, ma), (ma, b)):
            for (y0, y1) in ((c, mc), (mc, d)):
                out += fetch_tile(x0, x1, y0, y1, cache, depth + 1)
        return out
    for k in range(3):
        time.sleep(4 * (k + 1))
        r = subprocess.run(['curl', '-sS', '-m', '300', '-A', UA, '-o', fn, '-w', '%{http_code}', url], capture_output=True, text=True)
        if r.stdout.strip() == '200' and os.path.getsize(fn) > 100:
            return [fn]
    raise SystemExit(f'OSM を取れませんでした: {url} ({code})')


def fetch_osm(H, cache):
    os.makedirs(cache, exist_ok=True)
    nodes, ways, rels, ntags = {}, {}, {}, {}
    dlat, dlon = 0.02, 0.025
    files = []
    lat = H['lat0']
    while lat < H['lat1'] - 1e-9:
        lon = H['lon0']
        while lon < H['lon1'] - 1e-9:
            files += fetch_tile(lat, min(H['lat1'], lat + dlat), lon, min(H['lon1'], lon + dlon), cache)
            lon += dlon
        lat += dlat
    pk = os.path.join(cache, 'parsed2.pickle')
    if os.path.exists(pk) and os.path.getmtime(pk) > max(os.path.getmtime(f) for f in files):
        import pickle
        nodes, ways, rels, ntags = pickle.load(open(pk, 'rb'))
        fetch_osm.ntags = ntags
        return nodes, ways, rels
    for fn in files:
        root = ET.parse(fn).getroot()
        for el in root:
            if el.tag == 'node':
                nid = int(el.get('id'))
                nodes[nid] = (float(el.get('lat')), float(el.get('lon')))
                for t in el:
                    if t.tag == 'tag' and (t.get('k').startswith('seamark') or t.get('k') in ('man_made', 'name', 'height', 'ref')):
                        ntags.setdefault(nid, {})[t.get('k')] = t.get('v')
            elif el.tag == 'way':
                wid = int(el.get('id'))
                if wid in ways:
                    continue
                nds = [int(n.get('ref')) for n in el if n.tag == 'nd']
                tags = {t.get('k'): t.get('v') for t in el if t.tag == 'tag'}
                ways[wid] = (nds, tags)
            elif el.tag == 'relation':
                rid = int(el.get('id'))
                mem = [(m.get('type'), int(m.get('ref')), m.get('role')) for m in el if m.tag == 'member']
                tags = {t.get('k'): t.get('v') for t in el if t.tag == 'tag'}
                rels[rid] = (mem, tags)
    import pickle
    fetch_osm.ntags = ntags
    pickle.dump((nodes, ways, rels, ntags), open(pk, 'wb'), protocol=4)
    return nodes, ways, rels


# ── EMODnet の水深（esriAscii）──
def fetch_emodnet(H, cache):
    fn = os.path.join(cache, 'emodnet.asc')
    # 港の枠を広げたあとは、前に取った分が枠を覆っていないので取り直す
    #（覆っていない所を外挿すると、何百 m もの深さのような、ありえない値になる）
    if os.path.exists(fn) and os.path.getsize(fn) > 1000:
        hd = {}
        with open(fn) as f:
            for _ in range(6):
                k, v = f.readline().split(); hd[k.lower()] = float(v)
        x1 = hd['xllcenter'] + (hd['ncols'] - 1) * hd['cellsize']; y1 = hd['yllcenter'] + (hd['nrows'] - 1) * hd['cellsize']
        if hd['xllcenter'] > H['lon0'] or hd['yllcenter'] > H['lat0'] or x1 < H['lon1'] or y1 < H['lat1']:
            print('EMODnet の範囲が港の枠を覆っていないので取り直します')
            os.remove(fn)
    if not (os.path.exists(fn) and os.path.getsize(fn) > 1000):
        url = ('https://erddap.emodnet.eu/erddap/griddap/bathymetry_dtm_2024.esriAscii?elevation'
               f'%5B({H["lat0"] - 0.01:.4f}):1:({H["lat1"] + 0.01:.4f})%5D%5B({H["lon0"] - 0.01:.4f}):1:({H["lon1"] + 0.01:.4f})%5D')
        if not curl(url, fn):
            raise SystemExit('EMODnet を取れませんでした')
    L = open(fn).read().split('\n')
    hdr = {}
    for l in L[:6]:
        k, v = l.split()
        hdr[k.lower()] = float(v)
    a = np.array([list(map(float, l.split())) for l in L[6:] if l.strip()], dtype=np.float64)
    a[a < -1e6] = np.nan
    # 行は北から南
    return dict(a=a, x0=hdr['xllcenter'], y0=hdr['yllcenter'], cs=hdr['cellsize'], nr=int(hdr['nrows']), nc=int(hdr['ncols']))


# ── NOAA NCEI Coastal Relief Model 2023（1 秒角、OPeNDAP の ascii）──
# （名前, 南, 北, 西, 東）。格子の点は 1/3600° おきで、端から半升目内側
CRM_VOLS = [('crm/cudem/crm_vol1_2023.nc', 39.0, 46.0, -77.0, -65.0),
            ('crm/cudem/crm_vol2_2023.nc', 32.0, 39.0, -83.0, -68.0),
            ('crm/cudem/crm_vol3_2023.nc', 24.0, 32.0, -84.0, -76.0)]


def fetch_crm(H, cache):
    os.makedirs(cache, exist_ok=True)
    fn = os.path.join(cache, 'crm.npz')
    la0, la1, lo0, lo1 = H['lat0'] - 0.01, H['lat1'] + 0.01, H['lon0'] - 0.01, H['lon1'] + 0.01
    if os.path.exists(fn):
        z = np.load(fn)
        d = dict(a=z['a'], x0=float(z['x0']), y0=float(z['y0']), cs=float(z['cs']), nr=int(z['nr']), nc=int(z['nc']))
        if d['x0'] <= lo0 + 1e-6 and d['y0'] <= la0 + 1e-6 and d['x0'] + (d['nc'] - 1) * d['cs'] >= lo1 - 1e-6 and d['y0'] + (d['nr'] - 1) * d['cs'] >= la1 - 1e-6:
            return d
    vol = next((v for v in CRM_VOLS if v[1] <= la0 and la1 <= v[2] and v[3] <= lo0 and lo1 <= v[4]), None)
    if not vol:
        raise SystemExit('CRM の範囲に入っていません')
    cs = 1 / 3600
    j0 = int(math.floor((la0 - (vol[1] + cs / 2)) / cs)); j1 = int(math.ceil((la1 - (vol[1] + cs / 2)) / cs))
    i0 = int(math.floor((lo0 - (vol[3] + cs / 2)) / cs)); i1 = int(math.ceil((lo1 - (vol[3] + cs / 2)) / cs))
    rows = []
    for a in range(j0, j1 + 1, 400):
        b = min(j1, a + 399)
        part = os.path.join(cache, f'crm_{a}_{b}_{i0}_{i1}.txt')
        if not (os.path.exists(part) and os.path.getsize(part) > 1000):
            url = f'https://www.ngdc.noaa.gov/thredds/dodsC/{vol[0]}.ascii?z%5B{a}:1:{b}%5D%5B{i0}:1:{i1}%5D'
            if not curl(url, part):
                raise SystemExit('CRM を取れませんでした')
        got = []
        with open(part) as f:
            on = False
            for line in f:
                if line.startswith('z.z['):
                    on = True; continue
                if on:
                    if not line.strip():
                        break
                    got.append([float(v) for v in line.split(',')[1:]])
        assert len(got) == b - a + 1, (part, len(got))
        rows += got
        print('crm rows', a, b, flush=True)
    A = np.array(rows, dtype=np.float64)[::-1]          # 北から南へ
    A[A < -1e4] = np.nan
    d = dict(a=A, x0=vol[3] + cs / 2 + i0 * cs, y0=vol[1] + cs / 2 + j0 * cs, cs=cs, nr=A.shape[0], nc=A.shape[1])
    np.savez_compressed(fn, **d)
    return d


# ── 粗い地形（data/<region>.png：britain・useast）──
def coarse_sampler(region='britain'):
    meta = json.load(open(os.path.join(HERE, '..', region + '.json')))
    im = np.asarray(Image.open(os.path.join(HERE, '..', region + '.png')).convert('RGB')).astype(np.int32)
    h = im[:, :, 0] * 256 + im[:, :, 1] - 32768
    def at(lat, lon):
        fy = (meta['lat1'] - lat) / meta['cell']; fx = (lon - meta['lon0']) / meta['cell']
        x0 = np.clip(np.floor(fx).astype(int), 0, meta['cols'] - 2); y0 = np.clip(np.floor(fy).astype(int), 0, meta['rows'] - 2)
        tx = fx - x0; ty = fy - y0
        return (h[y0, x0] * (1 - tx) + h[y0, x0 + 1] * tx) * (1 - ty) + (h[y0 + 1, x0] * (1 - tx) + h[y0 + 1, x0 + 1] * tx) * ty
    return at


# ── OpenStreetMap のまとめファイル（BBBike の pbf）から、港の枠の中の必要な物だけ ──
WATER_VALUES = {'dock', 'basin', 'river', 'canal', 'lock', 'harbour', 'tidal', 'riverbank', 'lagoon', 'bay'}


def is_water(t):
    return (t.get('natural') == 'water' and (t.get('water') in WATER_VALUES or 'water' not in t)) or t.get('waterway') in ('dock', 'riverbank', 'canal') or t.get('landuse') == 'basin' and t.get('basin') in ('tidal', None)


def is_dock(t):
    return (t.get('water') in ('dock', 'basin', 'lock', 'harbour') or t.get('waterway') == 'dock' or t.get('landuse') == 'basin'
            or (t.get('natural') == 'water' and 'Dock' in t.get('name', '')))


def is_drydock(t):
    return t.get('dock') == 'drydock' or t.get('disused:dock') == 'drydock' or 'Dry Dock' in t.get('name', '') or 'Graving' in t.get('name', '')


def is_port_land(t):
    nm = t.get('name', '') + ' ' + t.get('alt_name', '')
    return t.get('landuse') == 'port' or (t.get('landuse') == 'industrial' and (t.get('industrial') in ('port', 'shipyard') or 'Port' in nm or 'Dock' in nm))


def _osm_relevant(t):
    if not t:
        return False
    return (t.get('natural') == 'coastline' or is_water(t) or is_dock(t) or is_drydock(t) or is_port_land(t)
            or t.get('man_made') in ('pier', 'breakwater', 'groyne', 'quay', 'jetty', 'crane') or t.get('landuse') in ('port', 'industrial', 'basin'))


def load_pbf(H, cache):
    import osmium, pickle
    os.makedirs(cache, exist_ok=True)
    pbf = os.path.join(H['pbf_dir'], H['pbf'] + '.osm.pbf')
    pk = os.path.join(cache, 'pbf_parsed.pickle')
    if os.path.exists(pk) and os.path.getmtime(pk) > os.path.getmtime(pbf):
        nodes, ways, rels, ntags = pickle.load(open(pk, 'rb'))
        fetch_osm.ntags = ntags
        return nodes, ways, rels
    m = 0.03
    la0, la1, lo0, lo1 = H['lat0'] - m, H['lat1'] + m, H['lon0'] - m, H['lon1'] + m
    rels, need = {}, set()

    class RH(osmium.SimpleHandler):
        def relation(self, r):
            t = {x.k: x.v for x in r.tags}
            if t.get('type') != 'multipolygon' or not _osm_relevant(t):
                return
            mem = [('way' if mb.type == 'w' else 'node' if mb.type == 'n' else 'relation', mb.ref, mb.role) for mb in r.members]
            rels[r.id] = (mem, t)
            for typ, ref, role in mem:
                if typ == 'way':
                    need.add(ref)
    RH().apply_file(pbf)
    nodes, ways, ntags = {}, {}, {}

    class WH(osmium.SimpleHandler):
        def node(self, n):
            if not n.tags:
                return
            t = {x.k: x.v for x in n.tags}
            if not any(k.startswith('seamark') for k in t) and t.get('man_made') != 'crane':
                return
            lat, lon = n.location.lat, n.location.lon
            if la0 <= lat <= la1 and lo0 <= lon <= lo1:
                nodes[n.id] = (lat, lon)
                ntags[n.id] = {k: v for k, v in t.items() if k.startswith('seamark') or k in ('man_made', 'name', 'height', 'ref')}

        def way(self, w):
            mem = w.id in need
            t = {x.k: x.v for x in w.tags} if w.tags else {}
            if not mem and not _osm_relevant(t):
                return
            pts = [(nr.ref, nr.location.lat, nr.location.lon) for nr in w.nodes if nr.location.valid()]
            if not pts:
                return
            if not any(la0 <= a <= la1 and lo0 <= b <= lo1 for _, a, b in pts):
                if not mem:
                    return
            for ref, a, b in pts:
                nodes[ref] = (a, b)
            ways[w.id] = ([nr.ref for nr in w.nodes], t)
    WH().apply_file(pbf, locations=True, idx='flex_mem')
    # 枠の近くに掛からない関係は捨てる
    def near(rid):
        for typ, ref, role in rels[rid][0]:
            if typ == 'way' and ref in ways:
                for n in ways[ref][0]:
                    q = nodes.get(n)
                    if q and la0 <= q[0] <= la1 and lo0 <= q[1] <= lo1:
                        return True
        return False
    rels = {rid: v for rid, v in rels.items() if near(rid)}
    used = set(ref for mem, t in rels.values() for typ, ref, role in mem if typ == 'way')
    ways = {wid: v for wid, v in ways.items() if _osm_relevant(v[1]) or wid in used}
    print(f'pbf: {len(nodes)} nodes, {len(ways)} ways, {len(rels)} relations', flush=True)
    fetch_osm.ntags = ntags
    pickle.dump((nodes, ways, rels, ntags), open(pk, 'wb'), protocol=4)
    return nodes, ways, rels


def pbf_cover(H):
    """まとめファイルの範囲（BBBike の .poly：経度 緯度 の並び）。無ければ None"""
    fn = os.path.join(H['pbf_dir'], H['pbf'] + '.poly')
    if not os.path.exists(fn):
        return None
    P = []
    for line in open(fn):
        v = line.split()
        if len(v) == 2:
            try: P.append((float(v[1]), float(v[0])))
            except ValueError: pass
    return P


def pbf_buildings(H, la0, la1, lo0, lo1):
    """まとめファイルの建物（閉じた線）：(tags, [(緯度, 経度)…])。真ん中が枠の中のものだけ"""
    import osmium
    pbf = os.path.join(H['pbf_dir'], H['pbf'] + '.osm.pbf')
    out = []

    class BH(osmium.SimpleHandler):
        def way(self, w):
            if not w.tags or 'building' not in w.tags:
                return
            if len(w.nodes) < 4 or w.nodes[0].ref != w.nodes[-1].ref:
                return
            pts = [(nr.location.lat, nr.location.lon) for nr in w.nodes if nr.location.valid()]
            if len(pts) < 4:
                return
            clat = sum(p[0] for p in pts) / len(pts); clon = sum(p[1] for p in pts) / len(pts)
            if la0 <= clat <= la1 and lo0 <= clon <= lo1:
                out.append(({x.k: x.v for x in w.tags}, pts))
    BH().apply_file(pbf, locations=True, idx='flex_mem')
    print('pbf buildings in box', len(out), flush=True)
    return out


# ════════════════════════════════════════════════════════════════
#  昔の港の形（history）
# ════════════════════════════════════════════════════════════════
#  to_water：[[緯度, 経度]…] の多角形を水に戻す（埋め立て地）。深さは restore_depth
#  pier_groups：昔の埠頭の並び。anchors＝[[番号, 緯度, 経度]…]（岸の近くの点。番号の間は線で補う）、
#      nums＝作る番号、bearing＝岸から沖への向き[度]（anchors の 4 番目で点ごとにも）、length・width[m]、
#      depth＝埠頭の間（スリップ）の深さ、out＝岸を探し始める沖の距離、labels＝番号の呼び名（A など）
#      岸（陸）は、沖から埠頭の向きの逆へたどって最初に当たる陸。そこに今の埠頭があれば作らない
#  piers：一つずつ書く埠頭 [呼び名, 根元の緯度, 経度, 向き, 長さ, 幅]
#  berths：着岸できる埠頭。{ 番号か呼び名: [名前, 種類, 舷（'L'＝沖を向いて左・'R'＝右・'LR'）] }
#  osm_berths：OpenStreetMap の名前の付いた今の埠頭に着岸。[[OSM の名前, 名前, 種類, 舷]…]
def _ll_dir(brg):
    r = math.radians(brg)
    return math.sin(r), math.cos(r)        # 東・北の成分


def history_piers(H, kind, lat1, lon0, dLat, dLon, cell):
    rows, cols = kind.shape
    mLat, mLon = cell / dLat, cell / dLon
    def ij(lat, lon):
        return int(round((lat1 - lat) / dLat)), int(round((lon - lon0) / dLon))
    def kind_at(lat, lon):
        j, i = ij(lat, lon)
        return int(kind[j, i]) if 0 <= j < rows and 0 <= i < cols else -1
    out = []
    groups = list(H.get('pier_groups', []))
    for gi, G in enumerate(groups):
        A = G['anchors']
        force = G.get('force', False)
        def num_of(a):
            return a if isinstance(a, (int, float)) else G.get('labels', {}).get(a, 0)
        made = []
        for idx, num in enumerate(G['nums']):
            v = num_of(num)
            if G.get('even') and len(G['nums']) > 1:          # 番号に関係なく等間隔に
                v = num_of(A[0][0]) + (num_of(A[-1][0]) - num_of(A[0][0])) * idx / (len(G['nums']) - 1)
            k = 0
            while k < len(A) - 2 and num_of(A[k + 1][0]) < v:
                k += 1
            a, b = A[k], A[k + 1]
            na, nb = num_of(a[0]), num_of(b[0])
            t = 0 if nb == na else max(0.0, min(1.0, (v - na) / (nb - na)))
            lat = a[1] + (b[1] - a[1]) * t; lon = a[2] + (b[2] - a[2]) * t
            ba = a[3] if len(a) > 3 else G['bearing']; bb = b[3] if len(b) > 3 else G['bearing']
            db = ((bb - ba + 540) % 360) - 180
            brg = (ba + db * t) % 360
            L = G.get('lengths', {}).get(num, G['length']); W = G.get('widths', {}).get(num, G['width'])
            de, dn = _ll_dir(brg)
            # 沖から岸へたどる（fixed_root：書いた点をそのまま根元に。岸壁の線をそろえたい埠頭）
            o = G.get('out', 300)
            root = (lat, lon, 1, 0) if G.get('fixed_root') else None
            for d in ([] if root else np.arange(o, -400, -5.0)):
                la = lat + dn * d / mLat; lo = lon + de * d / mLon
                kd = kind_at(la, lo)
                if kd < 0:
                    continue
                if kd in ((1, 4) if force else (1, 3, 4)):
                    root = (la, lo, kd, d); break
            if not root:
                print('  pier', G.get('name'), num, 'no shore'); continue
            if root[2] == 3 and not force:
                print('  pier', G.get('name'), num, 'existing pier'); continue
            rl, ro = root[0], root[1]
            # 埠頭の形の中が水か（根元から 25m 先より沖。今の埠頭や陸にぶつかるなら作らない）
            bad = n = 0
            for u in np.arange(25, L, 10.0):
                for w in (-W / 2, 0, W / 2):
                    la = rl + (dn * u + de * w) / mLat; lo = ro + (de * u - dn * w) / mLon
                    kd = kind_at(la, lo); n += 1
                    if kd != 0 and kd != 2: bad += 1
            if bad > 0.12 * n and not force:
                print('  pier', G.get('name'), num, 'blocked', bad, n); continue
            made.append(dict(num=num, name=G.get('fmt', '{}').format(num), lat=rl, lon=ro, brg=brg, L=L, W=W, depth=G.get('depth', 12.0), group=gi, force=force,
                             back=G.get('back', 20)))
        out += made
        print('pier group', G.get('name'), 'made', len(made), 'of', len(G['nums']), flush=True)
    for q in H.get('piers', []):
        nm, la, lo, brg, L, W = q[:6]
        out.append(dict(num=nm, name=nm, lat=la, lon=lo, brg=brg, L=L, W=W, depth=q[6] if len(q) > 6 else 12.0, group=-1))
    # 今の埠頭（OpenStreetMap の名前）を、同じ根元・向きのきれいな長方形に置き直す（osm_rebuild：[[OSM の名前, 呼び名, 長さ, 幅]…]）
    if H.get('osm_rebuild'):
        boxes = osm_pier_boxes(H['_nodes'], H['_ways'])
        for onm, nm, L, W in H['osm_rebuild']:
            b = boxes.get(onm)
            if not b:
                print('  osm_rebuild: not found', onm); continue
            mLatG = 111195.0; mLonG = mLatG * math.cos(math.radians(b['clat']))
            best = None
            for pv in (b['pmin'], b['pmax']):
                la = b['clat'] + b['ey'] * pv / mLatG; lo = b['clon'] + b['ex'] * pv / mLonG
                sgn = 1 if pv > 0 else -1
                land = sum(1 for d in (15, 30, 45) if kind_at(la + b['ey'] * sgn * d / mLatG, lo + b['ex'] * sgn * d / mLonG) in (1, 4))
                if best is None or land > best[0]:
                    best = (land, la, lo, sgn)
            land, rl, ro, sgn = best
            brg = (math.degrees(math.atan2(-b['ex'] * sgn, -b['ey'] * sgn)) + 360) % 360
            out.append(dict(num=nm, name=nm, lat=rl, lon=ro, brg=brg, L=L, W=W, depth=H.get('rebuild_depth', 13.0), group=-2, force=True, back=30, clear_w=60))
            print('  osm_rebuild', onm, '->', nm, 'root', round(rl, 5), round(ro, 5), 'brg', round(brg, 1), flush=True)
    return out


def pier_poly(p, lat1, lon0, dLat, dLon, cell, back=20, extra=0, widen=0):
    """埠頭の四隅（画像の升目）。back：根元から陸の方へ伸ばす分、extra：沖へ伸ばす分、widen：横へ広げる分"""
    mLat, mLon = cell / dLat, cell / dLon
    de, dn = _ll_dir(p['brg'])
    pts = []
    for u, w in ((-back, -p['W'] / 2 - widen), (p['L'] + extra, -p['W'] / 2 - widen), (p['L'] + extra, p['W'] / 2 + widen), (-back, p['W'] / 2 + widen)):
        la = p['lat'] + (dn * u + de * w) / mLat; lo = p['lon'] + (de * u - dn * w) / mLon
        pts.append(((lo - lon0) / dLon, (lat1 - la) / dLat))
    return pts


def osm_pier_boxes(nodes, ways):
    """名前の付いた今の埠頭（閉じた線）：名前 → 根元・向き・長さ・幅（主軸で測る）。根元は陸の側＝いちばん岸寄りの端"""
    out = {}
    for wid, (nds, t) in ways.items():
        nm = t.get('name')
        if not nm or t.get('man_made') not in ('pier', 'quay', 'jetty') or len(nds) < 4 or nds[0] != nds[-1]:
            continue
        pts = [nodes[n] for n in nds if n in nodes]
        la = sum(p[0] for p in pts) / len(pts); lo = sum(p[1] for p in pts) / len(pts)
        mLat = 111195.0; mLon = mLat * math.cos(math.radians(la))
        xs = [(p[1] - lo) * mLon for p in pts]; ys = [(p[0] - la) * mLat for p in pts]
        sxx = sum(x * x for x in xs); syy = sum(y * y for y in ys); sxy = sum(x * y for x, y in zip(xs, ys))
        ang = 0.5 * math.atan2(2 * sxy, sxx - syy)
        ex, ey = math.cos(ang), math.sin(ang)
        pr = [x * ex + y * ey for x, y in zip(xs, ys)]; pp = [-x * ey + y * ex for x, y in zip(xs, ys)]
        L = max(pr) - min(pr)
        if nm in out and out[nm]['L'] >= L:
            continue
        out[nm] = dict(clat=la, clon=lo, ex=ex, ey=ey, L=L, W=max(pp) - min(pp), pmin=min(pr), pmax=max(pr))
    return out


def export_berths(H, key, piers, osm_boxes, kind, lat1, lon0, dLat, dLon, cell):
    """着岸できる埠頭を <key>_berths.json に（43-world.js の港の一覧の形）"""
    rows, cols = kind.shape
    mLat, mLon = cell / dLat, cell / dLon
    def kind_at(lat, lon):
        j = int(round((lat1 - lat) / dLat)); i = int(round((lon - lon0) / dLon))
        return int(kind[j, i]) if 0 <= j < rows and 0 <= i < cols else -1
    group = H.get('berth_group', H['name'] + '港')
    via = H.get('berth_via')
    out = []
    def add(name, typ, root, brg, L, W, side, neighbors):
        de, dn = _ll_dir(brg)
        s = -1 if side == 'L' else 1                     # 沖を向いて左：横の向きは -（東北の回転）
        nb = (brg + 90 * s) % 360                        # 面の外向き
        ne, nn = _ll_dir(nb)
        # 面の真ん中（長さの 55% の所）
        u = L * 0.55
        at = (root[0] + (dn * u + nn * W / 2) / mLat, root[1] + (de * u + ne * W / 2) / mLon)
        # となりの埠頭までのすき間（スリップ）の幅：面から外へたどって、最初に当たる陸・埠頭まで（長さの 3 か所の短い方）
        sws = []
        for f in (0.3, 0.55, 0.8):
            uu = L * f
            # （埠頭の縁の升目は丸めで 10m ほどはみ出すことがあるので、縁から外へ出て最初の水から測る）
            la0_ = root[0] + (dn * uu + nn * (W / 2)) / mLat; lo0_ = root[1] + (de * uu + ne * (W / 2)) / mLon
            hit = None; start = None
            for d in np.arange(0, 430, 3.0):
                kd = kind_at(la0_ + nn * d / mLat, lo0_ + ne * d / mLon)
                if start is None:
                    if kd in (0, 2): start = d
                    elif d > 30: break
                    continue
                if kd not in (0, 2):
                    hit = d - start + 4; break
            sws.append(hit)
        gap = all(v is not None for v in sws)
        sw = min(sws) if gap else 120.0                  # スリップの幅
        tip = L - 10
        ent = (root[0] + (dn * tip + nn * (W / 2 + sw / 2)) / mLat, root[1] + (de * tip + ne * (W / 2 + sw / 2)) / mLon)
        opt = dict(at=[round(at[0], 6), round(at[1], 6)], bearing=round(nb, 1), quay=round(L * 0.85),
                   group=group, berth=name.replace(group + ' ', ''))
        if gap:
            opt['dock'] = dict(entrance=[round(ent[0], 6), round(ent[1], 6)], inBearing=round((brg + 180) % 360, 1), turnOut=H.get('turn_out', 300))
        out.append([name, typ, round(at[0], 5), round(at[1], 5), via, opt])
        print('  berth', name, 'slip', round(sw) if gap else 'open', 'm', flush=True)
        if gap and sw < H.get('min_slip', 70):
            out.pop()
            print('    ！スリップが狭いので着岸の一覧に入れない', flush=True)
    by_name = {}
    for p in piers:
        by_name.setdefault(p['name'], p)
    for key_, spec in H.get('berths', {}).items():
        p = by_name.get(key_)
        if not p:
            print('  berth pier not made:', key_); continue
        name, typ, sides = spec
        nbrs = [q for q in piers if q is not p]
        for sd in sides:
            add(name if len(sides) == 1 else name + ('（北側）' if _side_north(p['brg'], sd) else '（南側）'), typ, (p['lat'], p['lon']), p['brg'], p['L'], p['W'], sd, nbrs)
    for nm, name, typ, sides in H.get('osm_berths', []):
        b = osm_boxes.get(nm)
        if not b:
            print('  osm pier not found:', nm); continue
        mLatG = 111195.0; mLonG = mLatG * math.cos(math.radians(b['clat']))
        # 主軸の両端のうち、陸に近い方が根元
        ends = []
        for pv in (b['pmin'], b['pmax']):
            la = b['clat'] + b['ey'] * pv / mLatG; lo = b['clon'] + b['ex'] * pv / mLonG
            land = sum(1 for d in (15, 30, 45) if kind_at(la + b['ey'] * (d if pv > 0 else -d) / mLatG, lo + b['ex'] * (d if pv > 0 else -d) / mLonG) in (1, 4))
            ends.append((land, la, lo, pv))
        ends.sort(key=lambda e: -e[0])
        land, rl, ro, pv = ends[0]
        brg = (math.degrees(math.atan2(-b['ex'] * math.copysign(1, pv), -b['ey'] * math.copysign(1, pv))) + 360) % 360
        root = (rl, ro)
        fake = dict(lat=rl, lon=ro, W=b['W'])
        nbrs = [dict(lat=q['clat'] - q['ey'] * (q['pmax'] - q['pmin']) / 2 / mLatG, lon=q['clon'] - q['ex'] * (q['pmax'] - q['pmin']) / 2 / mLonG, W=q['W'])
                for n2, q in osm_boxes.items() if n2 != nm and abs(q['clat'] - b['clat']) < 0.004 and abs(q['clon'] - b['clon']) < 0.005]
        nbrs += [q for q in piers if abs(q['lat'] - rl) < 0.004 and abs(q['lon'] - ro) < 0.005]
        for sd in sides:
            add(name if len(sides) == 1 else name + ('（北側）' if _side_north(brg, sd) else '（南側）'), typ, root, brg, b['L'], b['W'], sd, nbrs)
    for q in H.get('extra_berths', []):
        out.append(q)
    # extra_auto：[[名前, 種類, 緯度, 経度, 海の方の向き]…]（岸壁の前の水の上の点）から、向きの逆へたどって岸壁を探し、
    # まわりの岸の線に直線を合わせて、岸壁の向き・長さを決める
    def edge_from(la, lo, brg, maxd=600):
        de, dn = _ll_dir(brg)
        for d in np.arange(0, maxd, 2.0):
            a2 = la - dn * d / mLat; o2 = lo - de * d / mLon
            if kind_at(a2, o2) in (1, 3, 4):
                return (a2, o2, d)
        return None
    for nm, typ, la, lo, brg in H.get('extra_auto', []):
        if kind_at(la, lo) not in (0, 2):
            print('  extra_auto: start point is not water', nm); continue
        e0 = edge_from(la, lo, brg)
        if not e0:
            print('  extra_auto: shore not found', nm); continue
        for it in range(3):
            de, dn = _ll_dir(brg)
            se, sn = _ll_dir(brg + 90)                     # 岸に沿う向き
            pts = []
            for t in np.arange(-H.get('auto_fit', 140), H.get('auto_fit', 140) + 1, 10.0):
                sla = e0[0] + (dn * 40 + sn * t) / mLat; slo = e0[1] + (de * 40 + se * t) / mLon
                if kind_at(sla, slo) not in (0, 2):
                    continue
                e = edge_from(sla, slo, brg, 120)
                if e:
                    pts.append((t, e[2] - 40))               # 岸に沿う位置・基準からの奥行き
            # 真ん中から続いている所（となりとの差 12m まで）
            pts.sort()
            mid = min(range(len(pts)), key=lambda i: abs(pts[i][0])) if pts else None
            if mid is None:
                break
            run = [pts[mid]]
            for i in range(mid + 1, len(pts)):
                if abs(pts[i][1] - run[-1][1]) > 12 or pts[i][0] - run[-1][0] > 20: break
                run.append(pts[i])
            for i in range(mid - 1, -1, -1):
                if abs(pts[i][1] - run[0][1]) > 12 or run[0][0] - pts[i][0] > 20: break
                run.insert(0, pts[i])
            if len(run) < 4:
                break
            n = len(run); st = sum(p[0] for p in run); sd = sum(p[1] for p in run)
            stt = sum(p[0] ** 2 for p in run); std = sum(p[0] * p[1] for p in run)
            slope = (n * std - st * sd) / ((n * stt - st * st) or 1)
            ang = math.degrees(math.atan(slope))              # 奥行きが岸沿いに増える → 岸の線が回っている
            # 岸沿い（brg＋90° の向き）に進むほど岸が奥（陸の方）にあるなら、本当の岸の線は brg＋90° より陸の方へ
            # 回っている。海の方の向きは同じだけ右回りに回す（以前は逆に回していて、ずれが大きいと離れていった）
            brg = (brg + ang) % 360
            qlen = run[-1][0] - run[0][0] + 10
        tc = (run[0][0] + run[-1][0]) / 2 if len(run) >= 4 else 0
        de, dn = _ll_dir(brg); se, sn = _ll_dir(brg + 90)
        cl = e0[0] + (sn * tc) / mLat; co = e0[1] + (se * tc) / mLon
        e = edge_from(cl + dn * 40 / mLat, co + de * 40 / mLon, brg, 160) or (cl, co, 0)
        at = (e[0] + dn * 4 / mLat, e[1] + de * 4 / mLon)
        q = round(min(qlen, 500)) if len(run) >= 4 else 200
        out.append([nm, typ, round(at[0], 5), round(at[1], 5), via,
                    dict(at=[round(at[0], 6), round(at[1], 6)], bearing=round(brg, 1), quay=q, group=group, berth=nm.replace(group + ' ', ''))])
        print('  berth', nm, '(auto)', round(at[0], 5), round(at[1], 5), 'bearing', round(brg, 1), 'quay', q, flush=True)
    print('berths', len(out), flush=True)
    return out


def dredge_berths(berths, depth, water, lat1, lon0, dLat, dLon, cell, want=14.0, reach=120):
    """着岸の一覧に入れた埠頭の前（岸壁の長さ ×reach m）を掘る（今は浅くなった昔の埠頭の前も、大きな船が付けられるように）"""
    rows, cols = depth.shape
    mLat, mLon = cell / dLat, cell / dLon
    for b in berths:
        opt = b[5]
        la, lo = opt['at']; brg = opt['bearing']; half = opt.get('quay', 300) / 2 + 20
        de, dn = _ll_dir(brg); se, sn = _ll_dir(brg + 90)
        pts = []
        for u, w in ((-2, -half), (reach, -half), (reach, half), (-2, half)):
            a = la + (dn * u + sn * w) / mLat; o = lo + (de * u + se * w) / mLon
            pts.append(((o - lon0) / dLon, (lat1 - a) / dLat))
        img = Image.new('L', (cols, rows), 0)
        ImageDraw.Draw(img).polygon(pts, fill=255)
        m = (np.asarray(img) > 0) & water
        depth[m] = np.maximum(depth[m], want)


def _side_north(brg, side):
    nb = (brg + (90 if side == 'R' else -90)) % 360
    return math.cos(math.radians(nb)) > 0


def britain_sampler():
    meta = json.load(open(os.path.join(HERE, '..', 'britain.json')))
    im = np.asarray(Image.open(os.path.join(HERE, '..', 'britain.png')).convert('RGB')).astype(np.int32)
    h = im[:, :, 0] * 256 + im[:, :, 1] - 32768
    def at(lat, lon):
        fy = (meta['lat1'] - lat) / meta['cell']; fx = (lon - meta['lon0']) / meta['cell']
        x0 = np.clip(np.floor(fx).astype(int), 0, meta['cols'] - 2); y0 = np.clip(np.floor(fy).astype(int), 0, meta['rows'] - 2)
        tx = fx - x0; ty = fy - y0
        return (h[y0, x0] * (1 - tx) + h[y0, x0 + 1] * tx) * (1 - ty) + (h[y0 + 1, x0] * (1 - tx) + h[y0 + 1, x0 + 1] * tx) * ty
    return at



def build(key, cache):
    H = HARBORS[key]
    lat0, lat1, lon0, lon1, cell = H['lat0'], H['lat1'], H['lon0'], H['lon1'], H['cell']
    mLat = 6371000 * math.pi / 180
    latc = (lat0 + lat1) / 2
    mLon = mLat * math.cos(math.radians(latc))
    dLat, dLon = cell / mLat, cell / mLon
    rows = int(math.ceil((lat1 - lat0) / dLat)) + 1
    cols = int(math.ceil((lon1 - lon0) / dLon)) + 1
    print(f'{key}: {rows} x {cols} cells of {cell} m', flush=True)
    nodes, ways, rels = load_pbf(H, cache) if H.get('pbf') else fetch_osm(H, cache)
    print(f'osm: {len(nodes)} nodes, {len(ways)} ways, {len(rels)} relations', flush=True)

    def px(lat, lon):
        return ((lon - lon0) / dLon, (lat1 - lat) / dLat)

    def way_pts(wid):
        nds, _ = ways[wid]
        return [px(*nodes[n]) for n in nds if n in nodes]

    # 0 不明・1 線（海岸線）・2 海・3 陸
    img = Image.new('L', (cols, rows), 0)
    dr = ImageDraw.Draw(img)
    # coast='crm'：海岸線（OSM）を使わず、陸と水は水深（CRM）の正負で決める（海岸線の線が少なく、塗り分けが崩れる所：ハンプトン・ローズ）
    coast = [w for w, (nds, t) in ways.items() if t.get('natural') == 'coastline'] if H.get('coast') != 'crm' else []
    seeds = []
    for w in coast:
        P = way_pts(w)
        if len(P) < 2:
            continue
        dr.line(P, fill=1, width=2)
        for (x0, y0), (x1, y1) in zip(P, P[1:]):
            L = math.hypot(x1 - x0, y1 - y0)
            if L < 1e-6:
                continue
            ux, uy = (x1 - x0) / L, (y1 - y0) / L
            # 画像は y が下向き：進む向きの右（海）は (−uy, ux)、左（陸）は (uy, −ux)
            for t in np.arange(0.5, L, 4):
                mx, my = x0 + ux * t, y0 + uy * t
                for off in (2.2, 3.2):
                    seeds.append((mx - uy * off, my + ux * off, 2))
                    seeds.append((mx + uy * off, my - ux * off, 3))
    # まとめファイルの範囲の外（地図が無い所）：範囲の縁に線を引いて区切り、あとで水深の正負で海・陸を決める
    cover = pbf_cover(H) if H.get('pbf') else None
    cline = None
    if cover:
        dr.line([px(a, b) for a, b in cover] + [px(*cover[0])], fill=1, width=2)
        cline = Image.new('L', (cols, rows), 0)
        ImageDraw.Draw(cline).line([px(a, b) for a, b in cover] + [px(*cover[0])], fill=1, width=2)
    print('coastline ways', len(coast), 'seeds', len(seeds), flush=True)
    # 塗りつぶし（PIL の floodfill は 4 近傍）。区域ごとに、中にある目印の多い方（海・陸）にする
    #（細い桟橋のそばでは、目印が反対側に落ちることがあるので、ひとつの目印では決めない）
    SX = np.array([int(round(x)) for x, y, v in seeds]); SY = np.array([int(round(y)) for x, y, v in seeds]); SV = np.array([v for x, y, v in seeds])
    ok = (SX >= 0) & (SX < cols) & (SY >= 0) & (SY < rows)
    SX, SY, SV = SX[ok], SY[ok], SV[ok]
    nreg = 0
    for i in range(len(SX)):
        if img.getpixel((int(SX[i]), int(SY[i]))) != 0:
            continue
        ImageDraw.floodfill(img, (int(SX[i]), int(SY[i])), 200)
        A = np.asarray(img)
        inreg = A[SY, SX] == 200
        nw, nl = int((inreg & (SV == 2)).sum()), int((inreg & (SV == 3)).sum())
        ImageDraw.floodfill(img, (int(SX[i]), int(SY[i])), 2 if nw >= nl else 3)
        nreg += 1
    print('regions', nreg, flush=True)
    A = np.asarray(img).copy()
    # 範囲の縁の線そのもの（海岸線ではない）は、あとで水深の正負で決める（そのままだと海の上に一直線の陸ができる）
    if cline is not None:
        A[(np.asarray(cline) > 0) & (A == 1)] = 0
    # 塗られなかった所：EMODnet（アメリカは CRM）に水深がある所は海、それ以外は陸
    E = fetch_crm(H, cache) if H.get('bathy') == 'crm' else fetch_emodnet(H, cache)
    J, I = np.mgrid[0:rows, 0:cols]
    LAT = lat1 - J * dLat
    LON = lon0 + I * dLon
    fy = ((E['y0'] + (E['nr'] - 1) * E['cs']) - LAT) / E['cs']
    fx = (LON - E['x0']) / E['cs']
    x0i = np.clip(np.floor(fx).astype(int), 0, E['nc'] - 2); y0i = np.clip(np.floor(fy).astype(int), 0, E['nr'] - 2)
    tx = np.clip(fx - x0i, 0, 1); ty = np.clip(fy - y0i, 0, 1)       # 外挿はしない
    a = E['a']
    q = [a[y0i, x0i], a[y0i, x0i + 1], a[y0i + 1, x0i], a[y0i + 1, x0i + 1]]
    w = [(1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty]
    num = sum(np.where(np.isnan(v), 0, v) * ww for v, ww in zip(q, w))
    den = sum(np.where(np.isnan(v), 0, ww) for v, ww in zip(q, w))
    emod = np.where(den > 0.25, num / np.maximum(den, 1e-9), np.nan)
    emod[(fx < -0.5) | (fy < -0.5) | (fx > E['nc'] - 0.5) | (fy > E['nr'] - 0.5)] = np.nan   # 取った範囲の外
    if cover:
        cimg = Image.new('L', (cols, rows), 0)
        ImageDraw.Draw(cimg).polygon([px(a, b) for a, b in cover], fill=255)
        outside = np.asarray(cimg) == 0
        A[outside] = 0
    unk = A == 0
    # CRM は陸の高さもある（水深 -1m より深い所を海に）。EMODnet は海の所だけ値がある
    A[unk & (emod < (-0.5 if H.get('bathy') == 'crm' else -1))] = 2
    A[A == 0] = 3
    A[A == 1] = 3                       # 海岸線の上は陸（岸壁）
    kind = np.where(A == 2, 0, 1).astype(np.uint8)

    # ドック・泊地・川の水面
    wimg = Image.new('L', (cols, rows), 0)
    wd = ImageDraw.Draw(wimg)
    dimg = Image.new('L', (cols, rows), 0)       # ドック・泊地・閘門（決まった深さ）
    dkd = ImageDraw.Draw(dimg)
    pimg = Image.new('L', (cols, rows), 0)
    pd = ImageDraw.Draw(pimg)
    port = Image.new('L', (cols, rows), 0)
    pod = ImageDraw.Draw(port)

    def depth_tag(t):
        try:
            return float(str(t.get('depth', '')).replace('m', '').strip())
        except ValueError:
            return None
    dock_depths = []                    # (多角形, 深さ)
    dry = Image.new('L', (cols, rows), 0)
    dryd = ImageDraw.Draw(dry)

    def draw_area(drw, P, fill):
        if len(P) >= 3:
            drw.polygon(P, fill=fill)
    nd = 0
    for wid, (nds, t) in ways.items():
        closed = len(nds) > 3 and nds[0] == nds[-1]
        if closed and is_drydock(t):
            draw_area(dryd, way_pts(wid), 255)
        elif closed and is_water(t) and t.get('water') not in ('pond', 'reservoir', 'lake', 'wastewater') and (H.get('coast') != 'crm' or is_dock(t)):
            draw_area(wd, way_pts(wid), 255); nd += 1
            if is_dock(t):
                draw_area(dkd, way_pts(wid), 255)
                if depth_tag(t): dock_depths.append(([way_pts(wid)], depth_tag(t)))
        mm = t.get('man_made')
        if mm in ('pier', 'breakwater', 'groyne', 'quay', 'jetty') or t.get('seamark:type') == 'harbour' and False:
            P = way_pts(wid)
            if closed and t.get('area') != 'no':
                draw_area(pd, P, 255)
            elif len(P) >= 2:
                wid_m = float(t.get('width', 0) or 0) if str(t.get('width', '')).replace('.', '', 1).isdigit() else 0
                width = max(2, int(round((wid_m or (14 if mm in ('pier', 'jetty') else 10)) / cell)))
                pd.line(P, fill=255, width=width)
        if closed and is_port_land(t):
            draw_area(pod, way_pts(wid), 255)
    # 多角形の関係（multipolygon）：外側を塗って、内側を抜く
    for rid, (mem, t) in rels.items():
        if t.get('type') != 'multipolygon':
            continue
        target = None
        if is_drydock(t):
            for role, P in assemble_rings(mem, ways, nodes, px):
                if role == 'outer': draw_area(dryd, P, 255)
            continue
        # coast='crm' の港では、川・湾の大きな水の多角形は使わない（枠の外の部分が欠けて、陸の上まで水にしてしまう）。ドック・泊地だけ
        if is_water(t) and t.get('water') not in ('pond', 'reservoir', 'lake', 'wastewater') and (H.get('coast') != 'crm' or is_dock(t)):
            target = (wd, 255)
            if is_dock(t):
                rings = assemble_rings(mem, ways, nodes, px)
                for role, P in rings:
                    if role == 'outer': draw_area(dkd, P, 255)
                if depth_tag(t): dock_depths.append(([P for role, P in rings if role == 'outer'], depth_tag(t)))
                for role, P in rings:
                    if role == 'inner': draw_area(dkd, P, 0)
        elif is_port_land(t):
            target = (pod, 255)
        if not target:
            continue
        rings = assemble_rings(mem, ways, nodes, px)
        for role, P in rings:
            if role == 'outer':
                draw_area(target[0], P, target[1])
        for role, P in rings:
            if role == 'inner':
                draw_area(target[0], P, 0)
        nd += 1
    print('water areas', nd, flush=True)
    W = np.asarray(wimg) > 0
    DK = np.asarray(dimg) > 0
    Pm = np.asarray(pimg) > 0
    PORT = np.asarray(port) > 0
    DRY = np.asarray(dry) > 0
    kind[W] = 0
    kind[DK] = 2                        # ドック・泊地（決まった深さ）
    kind[DRY] = 1                       # 乾ドック（門で閉じている）は陸
    kind[Pm] = 3
    kind[(kind == 1) & PORT] = 4

    # 昔の港の形：埋め立て地を水に戻し、かつての埠頭を足す
    restored = np.zeros(kind.shape, bool)
    for poly in H.get('to_water', []):
        rimg = Image.new('L', (cols, rows), 0)
        ImageDraw.Draw(rimg).polygon([px(a, b) for a, b in poly], fill=255)
        rm = np.asarray(rimg) > 0
        restored |= rm & (kind != 0) & (kind != 2)
        kind[rm] = 0
    piers = history_piers(dict(H, _nodes=nodes, _ways=ways), kind, lat1, lon0, dLat, dLon, cell) if (H.get('pier_groups') or H.get('piers') or H.get('osm_rebuild')) else []
    slip = np.zeros(kind.shape, np.float32)
    # 形を決めて置く埠頭の並び（force）：埠頭の間（スリップ）にある今の構造物・埋め立て地は片付けて水に戻す
    for p in piers:
        if p.get('force'):
            zimg = Image.new('L', (cols, rows), 0)
            ImageDraw.Draw(zimg).polygon(pier_poly(p, lat1, lon0, dLat, dLon, cell, back=-5, extra=60, widen=p.get('clear_w', 75)), fill=255)
            zm = (np.asarray(zimg) > 0) & (kind != 0) & (kind != 2)
            restored |= zm & (kind != 3)
            kind[zm] = 0
    for p in piers:
        pimg2 = Image.new('L', (cols, rows), 0)
        ImageDraw.Draw(pimg2).polygon(pier_poly(p, lat1, lon0, dLat, dLon, cell, back=p.get('back', 20)), fill=255)
        kind[np.asarray(pimg2) > 0] = 3
        dimg2 = Image.new('L', (cols, rows), 0)
        ImageDraw.Draw(dimg2).polygon(pier_poly(p, lat1, lon0, dLat, dLon, cell, back=10, extra=80, widen=p.get('dredge_w', 90)), fill=255)
        dm = np.asarray(dimg2) > 0
        slip[dm] = np.maximum(slip[dm], p['depth'])
    # 決まった所を掘る（dredge：[深さ, [[緯度, 経度]…]]。昔の埠頭の前の浅くなった所など）
    for dd, poly in H.get('dredge', []):
        dimg3 = Image.new('L', (cols, rows), 0)
        ImageDraw.Draw(dimg3).polygon([px(a, b) for a, b in poly], fill=255)
        dm = np.asarray(dimg3) > 0
        slip[dm] = np.maximum(slip[dm], dd)
    if piers or restored.any():
        print('history: restored cells', int(restored.sum()), 'piers', len(piers), flush=True)

    # 水深
    water = (kind == 0) | (kind == 2)
    depth = np.where(np.isnan(emod), np.nan, -emod)
    depth[~water] = np.nan
    # 水深の無い水の升目：EMODnet の縁（80m まで）はまわりの値で埋め、その先は浅い（2.5m）
    for it in range(8):
        miss = water & np.isnan(depth)
        if not miss.any():
            break
        acc = np.zeros_like(depth); cnt = np.zeros_like(depth)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            sh = np.roll(np.roll(depth, dy, 0), dx, 1)
            ok = ~np.isnan(sh)
            acc += np.where(ok, sh, 0); cnt += ok
        fill = miss & (cnt > 0)
        depth[fill] = acc[fill] / cnt[fill]
    nodata = water & np.isnan(depth)
    depth[nodata] = 2.5
    # 大きな川（river_depth）：水深の測られていない川の中は、岸から離れるほど深く（岸から 15m は浅く、
    # そこから 4m 進むごとに 1m、river_depth まで）。大きな船が川の真ん中を遡れるように
    if H.get('river_depth'):
        rd = H['river_depth']
        er = water.copy(); dist = np.zeros(water.shape, np.float32)
        for it in range(int((rd * 4 + 15) / cell) + 2):
            er = er & np.roll(er, 1, 0) & np.roll(er, -1, 0) & np.roll(er, 1, 1) & np.roll(er, -1, 1)
            if not er.any():
                break
            dist += er
        prof = np.clip((dist * cell - 15) / 4.0, 0, rd)
        depth[nodata] = np.maximum(depth[nodata], prof[nodata])
    # 埋め立て地を戻した所・昔の埠頭の間（スリップ）・掘った所
    depth[restored & water] = np.maximum(np.nan_to_num(depth[restored & water], nan=0), H.get('restore_depth', 11.0))
    sm = water & (slip > 0)
    depth[sm] = np.maximum(np.nan_to_num(depth[sm], nan=0), slip[sm])
    # ドック：書いてある深さ（なければ港の決まり）。港の決まりより浅くはしない（1911 年の深さ：40ft ≒ 12m）
    depth[kind == 2] = np.maximum(depth[kind == 2], H['dock_depth'])
    # 港の敷地（岸壁）の前 berth_reach[m] は掘ってある
    reach = int(round(H.get('berth_reach', 200) / cell))
    near_port = PORT.copy()
    for it in range(reach):
        near_port = near_port | np.roll(near_port, 1, 0) | np.roll(near_port, -1, 0) | np.roll(near_port, 1, 1) | np.roll(near_port, -1, 1)
    bz = water & near_port
    depth[bz] = np.maximum(depth[bz], H.get('berth_depth', 12.0))
    # 港ごとに書いた掘った航路（線と幅・深さ）：水の所だけ。
    # 曲がり角には、大きな船（旋回半径 TURN_R）が回り始める所から回り終える所まで、内側を結ぶ通り道も掘る
    TURN_R = 2200
    chans = []
    for ch in H.get('channels', []):
        chans.append(ch)
        pts = ch['pts']
        for i in range(1, len(pts) - 1):
            (la0, lo0), (la1, lo1), (la2, lo2) = pts[i - 1], pts[i], pts[i + 1]
            ax, ay = (lo0 - lo1) * mLon, (la0 - la1) * mLat
            bx, by = (lo2 - lo1) * mLon, (la2 - la1) * mLat
            A, B = math.hypot(ax, ay), math.hypot(bx, by)
            if A < 1 or B < 1: continue
            turn = math.pi - math.acos(max(-1, min(1, (ax * bx + ay * by) / (A * B))))   # 曲がる角
            if turn < math.radians(12): continue
            reach = min(TURN_R * math.tan(turn / 2), 0.45 * A, 0.45 * B)
            t1 = (la1 + ay / A * reach / mLat, lo1 + ax / A * reach / mLon)
            t2 = (la1 + by / B * reach / mLat, lo1 + bx / B * reach / mLon)
            mid = ((t1[0] + t2[0]) / 2, (t1[1] + t2[1]) / 2)
            extra = TURN_R * (1 / math.cos(turn / 2) - 1)
            chans.append(dict(width=ch['width'] + 2 * extra, depth=ch['depth'], pts=[list(t1), list(mid), list(t2)]))
    # 川の航路（auto_channels）：a から b まで、岸からできるだけ離れた所（川の真ん中）を通る道を水の上で探し、
    # 折れ線にして掘る（川の線を手で書かなくてよい。曲がりくねった川を遡る大きな船のため）
    for ac in H.get('auto_channels', []):
        pts = river_path(water, lat1, lon0, dLat, dLon, cell, ac['a'], ac['b'])
        if pts:
            print('auto channel', len(pts), 'points')
            chans.append(dict(width=ac['width'], depth=ac['depth'], pts=pts))
    for ch in chans:
        r = int(round(ch['width'] / 2 / cell))
        yy, xx = np.mgrid[-r:r + 1, -r:r + 1]
        disk = (yy * yy + xx * xx) <= r * r
        P = [((lon - lon0) / dLon, (lat1 - lat) / dLat) for lat, lon in ch['pts']]
        for (x0, y0), (x1, y1) in zip(P, P[1:]):
            L = math.hypot(x1 - x0, y1 - y0)
            for t in np.arange(0, L + 1, max(1, r / 2)):
                cx, cy = int(round(x0 + (x1 - x0) * t / max(L, 1e-9))), int(round(y0 + (y1 - y0) * t / max(L, 1e-9)))
                ys, xs = slice(max(0, cy - r), min(rows, cy + r + 1)), slice(max(0, cx - r), min(cols, cx + r + 1))
                dk = disk[(ys.start - cy + r):(ys.stop - cy + r), (xs.start - cx + r):(xs.stop - cx + r)]
                sub = depth[ys, xs]; mm = dk & water[ys, xs]
                sub[mm] = np.maximum(sub[mm], ch['depth'])
    # 岸壁の前の掘った所を、いちばん近い深い所（EMODnet の航路）まで、幅 250m の水路でつなぐ
    connect_berths(depth, water, bz, (~np.isnan(emod)) & (-emod >= H.get('berth_depth', 12.0) - 1.5), cell, 250, H.get('berth_depth', 12.0))
    # 着岸できる埠頭（一覧）と、その前を掘る
    berths = None
    if H.get('berths') or H.get('osm_berths') or H.get('extra_berths') or H.get('extra_auto'):
        berths = export_berths(H, key, piers, osm_pier_boxes(nodes, ways), kind, lat1, lon0, dLat, dLon, cell)
        dredge_berths(berths, depth, water, lat1, lon0, dLat, dLon, cell, H.get('berth_dredge', 14.0))
    depth[water] = np.maximum(depth[water], 1.0)
    # 陸：岸壁の高さ。離れた所は粗い地形（アメリカは CRM の陸の高さ）
    bs = coarse_sampler(H.get('region', 'britain'))
    land_h = np.maximum(4.0, np.where(np.isnan(emod), bs(LAT, LON), emod) if H.get('bathy') == 'crm' else bs(LAT, LON))
    h = np.where(water, -depth, 4.0)
    # 水から 150m 以上離れた陸は、元の地形の高さへ
    near = water.copy()
    for it in range(int(150 / cell)):
        near = near | np.roll(near, 1, 0) | np.roll(near, -1, 0) | np.roll(near, 1, 1) | np.roll(near, -1, 1)
    h = np.where(~water & ~near, land_h, h)
    hdm = np.clip(np.round(h * 10), -32000, 32000).astype(np.int32) + 32768
    rgb = np.stack([(hdm >> 8).astype(np.uint8), (hdm & 255).astype(np.uint8), kind.astype(np.uint8)], axis=2)
    Image.fromarray(rgb, 'RGB').save(os.path.join(HERE, f'{key}.png'), optimize=True)
    meta = dict(key=key, name=H['name'], lat0=lat1 - (rows - 1) * dLat, lat1=lat1, lon0=lon0, lon1=lon0 + (cols - 1) * dLon,
                rows=rows, cols=cols, dLat=dLat, dLon=dLon, cell=cell, scale=0.1,
                kinds={'0': 'sea', '1': 'land', '2': 'dock water', '3': 'pier', '4': 'port land'})
    json.dump(meta, open(os.path.join(HERE, f'{key}.json'), 'w'), ensure_ascii=False, indent=1)
    export_features(key, cache, nodes, ways, water, lat1, lon0, dLat, dLon, cell)
    if berths is not None:
        json.dump(berths, open(os.path.join(HERE, f'{key}_berths.json'), 'w'), ensure_ascii=False, indent=0)
    print('water cells', int(water.sum()), 'dock cells', int((kind == 2).sum()), 'pier cells', int((kind == 3).sum()),
          'depth max', float(np.nanmax(depth)), flush=True)


def simplify(P, tol):
    """ダグラス・ピューカー（点の数を減らす）"""
    if len(P) < 4:
        return P
    def rec(a, b):
        (x0, y0), (x1, y1) = P[a], P[b]
        L = math.hypot(x1 - x0, y1 - y0) or 1e-9
        best, bi = -1, -1
        for i in range(a + 1, b):
            d = abs((x1 - x0) * (y0 - P[i][1]) - (x0 - P[i][0]) * (y1 - y0)) / L
            if d > best: best, bi = d, i
        if best > tol:
            return rec(a, bi)[:-1] + rec(bi, b)
        return [P[a], P[b]]
    return rec(0, len(P) - 1)


def export_features(key, cache, nodes, ways, water, lat1, lon0, dLat, dLon, cell):
    """建物（水の近く）・航路の標識・クレーンを <key>_feat.json に。座標は範囲の南西の角からの m（x 東・y 北）"""
    H = HARBORS[key]
    rows, cols = water.shape
    mLat = cell / dLat; mLon = cell / dLon
    lat0 = lat1 - (rows - 1) * dLat
    # 水から 600m 以内（港のまわりの街並みも：船から見える範囲）。建物の多い港は狭く（feat_near）
    near = water.copy()
    for it in range(int(H.get('feat_near', 600) / cell)):
        near = near | np.roll(near, 1, 0) | np.roll(near, -1, 0) | np.roll(near, 1, 1) | np.roll(near, -1, 1)
    def xy(lat, lon):
        return ((lon - lon0) * mLon, (lat - lat0) * mLat)
    def inside_near(lat, lon):
        r = int(round((lat1 - lat) / dLat)); c = int(round((lon - lon0) / dLon))
        return 0 <= r < rows and 0 <= c < cols and near[r, c]
    KIND = {'house': 0, 'residential': 0, 'semidetached_house': 0, 'detached': 0, 'bungalow': 0, 'terrace': 0, 'apartments': 0,
            'garage': 0, 'garages': 0, 'industrial': 1, 'warehouse': 1, 'hangar': 1, 'storage_tank': 3, 'silo': 3,
            'commercial': 2, 'retail': 2, 'office': 2, 'church': 4, 'cathedral': 4}
    DEFH = {0: 7.5, 1: 12.0, 2: 12.0, 3: 12.0, 4: 18.0}
    out_b = []
    min_area = H.get('feat_min_area', 40)

    def buildings():
        if H.get('pbf'):
            yield from pbf_buildings(H, lat0, lat1, lon0, lon0 + (cols - 1) * dLon)
            return
        for wid, (nds, t) in ways.items():
            if 'building' not in t or len(nds) < 4 or nds[0] != nds[-1]:
                continue
            yield t, [nodes[n] for n in nds if n in nodes]
    for t, pts in buildings():
        if len(pts) < 4:
            continue
        clat = sum(p[0] for p in pts) / len(pts); clon = sum(p[1] for p in pts) / len(pts)
        if not inside_near(clat, clon):
            continue
        P = [xy(*p) for p in pts]
        area = 0.5 * abs(sum(P[i][0] * P[i + 1][1] - P[i + 1][0] * P[i][1] for i in range(len(P) - 1)))
        if area < min_area:
            continue
        k = KIND.get(t.get('building'), 2 if area > 400 else 0)
        if t.get('man_made') in ('storage_tank', 'silo'): k = 3
        h = None
        for tag in ('height', 'building:height'):
            try: h = float(str(t.get(tag, '')).replace('m', '').strip()); break
            except ValueError: pass
        if h is None and t.get('building:levels'):
            try: h = float(t['building:levels']) * 3.2 + 1.5
            except ValueError: pass
        if h is None:
            h = DEFH[k] if area < 3000 else max(DEFH[k], 14.0)
        # 輪は、始まりから一番遠い点で 2 つに分けて減らす（始まりと終わりが同じ点だと、線が引けない）
        R = P[:-1]
        far = max(range(len(R)), key=lambda i: (R[i][0] - R[0][0]) ** 2 + (R[i][1] - R[0][1]) ** 2)
        P = simplify(R[:far + 1], 0.8)[:-1] + simplify(R[far:] + [R[0]], 0.8)[:-1]
        if len(P) < 3:
            continue
        flat = [k, round(h, 1)]
        for x, y in P: flat += [round(x, 1), round(y, 1)]
        out_b.append(flat)
    # 航路の標識（ブイ・立標・灯火）
    out_s = []
    ntags = getattr(fetch_osm, 'ntags', {})
    for nid, t in ntags.items():
        st = t.get('seamark:type')
        if not st or nid not in nodes:
            continue
        lat, lon = nodes[nid]
        if not (lat0 <= lat <= lat1 and lon0 <= lon <= lon0 + (cols - 1) * dLon):
            continue
        if st not in ('buoy_lateral', 'beacon_lateral', 'buoy_cardinal', 'beacon_cardinal', 'buoy_special_purpose', 'beacon_special_purpose',
                      'buoy_safe_water', 'buoy_isolated_danger', 'light_minor', 'light_major', 'landmark', 'berth'):
            continue
        base = st.split('_')[0] if st.startswith(('buoy', 'beacon')) else st
        colour = t.get(f'seamark:{st}:colour', t.get('seamark:light:colour', ''))
        cat = t.get(f'seamark:{st}:category', '')
        shape = t.get(f'seamark:{st}:shape', '')
        lc = t.get('seamark:light:colour', t.get('seamark:light:1:colour', ''))
        x, y = xy(lat, lon)
        out_s.append([round(x, 1), round(y, 1), st, colour, cat, shape, lc, t.get('seamark:name', t.get('name', ''))])
    out_c = []
    for nid, t in ntags.items():
        if t.get('man_made') == 'crane' and nid in nodes:
            x, y = xy(*nodes[nid]); out_c.append([round(x, 1), round(y, 1)])
    for wid, (nds, t) in ways.items():
        if t.get('man_made') == 'crane':
            pts = [nodes[n] for n in nds if n in nodes]
            if pts:
                x, y = xy(sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)); out_c.append([round(x, 1), round(y, 1)])
    json.dump({'b': out_b, 's': out_s, 'c': out_c}, open(os.path.join(HERE, f'{key}_feat.json'), 'w'), ensure_ascii=False, separators=(',', ':'))
    print('features: buildings', len(out_b), 'seamarks', len(out_s), 'cranes', len(out_c), 'bytes', os.path.getsize(os.path.join(HERE, f'{key}_feat.json')), flush=True)


def river_path(water, lat1, lon0, dLat, dLon, cell, A, B, f=2):
    """水の上で、A から B まで、岸から離れた所を通る道（緯度・経度の折れ線）。f 升ずつまとめて探す"""
    import heapq
    rows, cols = water.shape
    ny, nx = rows // f, cols // f
    w = water[:ny * f, :nx * f].reshape(ny, f, nx, f).all(axis=(1, 3))
    # 岸からの距離（升目）：削っていく
    d = np.zeros(w.shape, np.int32); er = w.copy()
    for it in range(40):
        er = er & np.roll(er, 1, 0) & np.roll(er, -1, 0) & np.roll(er, 1, 1) & np.roll(er, -1, 1)
        if not er.any(): break
        d += er
    cost = np.where(w, 1.0 + 60.0 / (1.0 + d.astype(np.float64)) ** 2, np.inf)
    def ij(q): return int(round((lat1 - q[0]) / dLat / f)), int(round((q[1] - lon0) / dLon / f))
    s, t = ij(A), ij(B)
    # 始まり・終わりが水でなければ、近くの水へ
    def snap(p):
        best = None
        for r in range(0, 30):
            for a in range(-r, r + 1):
                for b in (-r, r) if abs(a) != r else range(-r, r + 1):
                    j, i = p[0] + a, p[1] + b
                    if 0 <= j < ny and 0 <= i < nx and w[j, i]:
                        return (j, i)
        return None
    s, t = snap(s), snap(t)
    if not s or not t: return None
    dist = np.full(w.shape, np.inf); prev = {}
    dist[s] = 0; hq = [(0.0, s)]
    nb = [(1, 0, 1), (-1, 0, 1), (0, 1, 1), (0, -1, 1), (1, 1, 1.414), (1, -1, 1.414), (-1, 1, 1.414), (-1, -1, 1.414)]
    while hq:
        g, (j, i) = heapq.heappop(hq)
        if (j, i) == t: break
        if g > dist[j, i]: continue
        for a, b, L in nb:
            jj, ii = j + a, i + b
            if 0 <= jj < ny and 0 <= ii < nx and w[jj, ii]:
                ng = g + L * cost[jj, ii]
                if ng < dist[jj, ii]:
                    dist[jj, ii] = ng; prev[(jj, ii)] = (j, i); heapq.heappush(hq, (ng, (jj, ii)))
    if t not in prev: return None
    path = [t]
    while path[-1] != s: path.append(prev[path[-1]])
    path.reverse()
    # 間引き（線からのずれが 2 升以内なら省く）
    def simp(P):
        if len(P) < 3: return P
        (y0, x0), (y1, x1) = P[0], P[-1]
        L = math.hypot(y1 - y0, x1 - x0) or 1
        dm, k = -1, 0
        for q in range(1, len(P) - 1):
            y, x = P[q]; dd = abs((x1 - x0) * (y0 - y) - (x0 - x) * (y1 - y0)) / L
            if dd > dm: dm, k = dd, q
        return simp(P[:k + 1])[:-1] + simp(P[k:]) if dm > 2 else [P[0], P[-1]]
    P = simp(path)
    return [[round(lat1 - (j + 0.5) * f * dLat, 5), round(lon0 + (i + 0.5) * f * dLon, 5)] for j, i in P]


def connect_berths(depth, water, band, deep, cell, width_m, want):
    """岸壁の前の掘った所のうち、深い航路（deep）へ船が通れないまとまりを、水の上のいちばん近い道で掘ってつなぐ。
    通れるかは、ゲームの航路探し（43-world.js の _rwDetailRoute）と同じ見方：40m の升目の、中と四隅の浅い方が 6m 以上"""
    import heapq
    from collections import deque
    f = 4
    rows, cols = depth.shape
    ny, nx = (rows - 1) // f, (cols - 1) // f
    r = int(round(width_m / 2 / cell))
    yy, xx = np.mgrid[-r:r + 1, -r:r + 1]
    disk = (yy * yy + xx * xx) <= r * r
    done = 0
    for rnd in range(200):
        H = np.where(water, -depth, 4.0)
        pts = [(2, 2), (0, 0), (f, 0), (0, f), (f, f)]
        hm = np.max(np.stack([H[b:b + ny * f:f, a:a + nx * f:f][:ny, :nx] for a, b in pts]), axis=0)
        dep = -hm
        ok = dep >= 6
        # つなぐ道は、升目がまるごと水の所だけ（桟橋のすき間など、掘れない陸のあいだは通らない）
        Wd = np.min(np.stack([water[b:b + ny * f:f, a:a + nx * f:f][:ny, :nx] for a, b in pts]), axis=0)
        Dd = deep[2::f, 2::f][:ny, :nx] & ok
        Bd = band[2::f, 2::f][:ny, :nx] & ok
        # 深い航路から通れる所
        reach = np.zeros((ny, nx), bool)
        q = deque(zip(*np.nonzero(Dd)))
        for j, i in q: reach[j, i] = True
        while q:
            j, i = q.popleft()
            for a, b in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)):
                jj, ii = j + b, i + a
                if 0 <= jj < ny and 0 <= ii < nx and ok[jj, ii] and not reach[jj, ii]:
                    reach[jj, ii] = True; q.append((jj, ii))
        lost = Bd & ~reach
        if not lost.any():
            break
        # 届かない掘った所から、水の上を通って届く所へ（いちばん短い道）
        dist = np.full((ny, nx), np.inf); prev = np.full((ny, nx), -1, dtype=np.int64)
        hq = []
        for j, i in zip(*np.nonzero(reach)):
            dist[j, i] = 0; hq.append((0.0, int(j), int(i)))
        heapq.heapify(hq)
        while hq:
            dv, j, i = heapq.heappop(hq)
            if dv > dist[j, i]: continue
            for a, b in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)):
                jj, ii = j + b, i + a
                if 0 <= jj < ny and 0 <= ii < nx and Wd[jj, ii]:
                    nd = dv + math.hypot(a, b)
                    if nd < dist[jj, ii]:
                        dist[jj, ii] = nd; prev[jj, ii] = j * nx + i; heapq.heappush(hq, (nd, jj, ii))
        dd = np.where(lost, dist, np.inf)
        k = np.unravel_index(np.argmin(dd), dd.shape)
        if not np.isfinite(dd[k]):
            break
        cj, ci = k
        if rnd < 4 or rnd % 50 == 0:
            print('  connect', rnd, 'from block', k, 'dist', round(float(dd[k]), 1), 'lost blocks', int(lost.sum()), flush=True)
        n = 0
        while n < 20000:
            y0, x0 = cj * f + 2, ci * f + 2
            ys, xs = slice(max(0, y0 - r), min(rows, y0 + r + 1)), slice(max(0, x0 - r), min(cols, x0 + r + 1))
            dk = disk[(ys.start - y0 + r):(ys.stop - y0 + r), (xs.start - x0 + r):(xs.stop - x0 + r)]
            sub = depth[ys, xs]; m = dk & water[ys, xs]
            sub[m] = np.maximum(sub[m], want)
            pv = prev[cj, ci]
            if pv < 0: break
            cj, ci = divmod(int(pv), nx); n += 1
        done += 1
    print('berth connections', done, flush=True)


def assemble_rings(mem, ways, nodes, px):
    """multipolygon の外側・内側の線をつないで輪にする"""
    out = []
    for role in ('outer', 'inner'):
        segs = []
        for typ, ref, r in mem:
            if typ == 'way' and (r or 'outer') == role and ref in ways:
                nds = [n for n in ways[ref][0] if n in nodes]
                if len(nds) >= 2:
                    segs.append(nds)
        while segs:
            ring = segs.pop(0)
            changed = True
            while ring[0] != ring[-1] and changed:
                changed = False
                for i, s in enumerate(segs):
                    if s[0] == ring[-1]: ring = ring + s[1:]
                    elif s[-1] == ring[-1]: ring = ring + s[::-1][1:]
                    elif s[-1] == ring[0]: ring = s + ring[1:]
                    elif s[0] == ring[0]: ring = s[::-1] + ring[1:]
                    else: continue
                    segs.pop(i); changed = True; break
            out.append((role, [px(*nodes[n]) for n in ring]))
    return out


if __name__ == '__main__':
    key = sys.argv[1]
    cache = os.path.join(HERE, 'cache', key)
    if '--cache' in sys.argv:
        cache = os.path.join(sys.argv[sys.argv.index('--cache') + 1], key)
    build(key, cache)
