# ShipSim の Android アプリ（APK）

ブラウザ版（https://susuruchachi.github.io/-shipsim/ ）を、全画面のアプリとして開くための入れ物です。
中身はブラウザ版そのものなので、**ページを更新すれば、アプリを入れ直さなくても次に開いたときから新しい版になります**。
一度開けば、電波が無くても起動できます（ページの Service Worker が中身を保存するため）。

## アプリにすると変わること

- ステータスバー・ナビゲーションバーを隠した全画面（画面の端から指で引き出すと一時的に出る）
- 遊んでいる間は画面が消えない
- 端末の「ゲーム」として扱われる（Xperia の「ゲームエンハンサー」など、ゲーム用の機能の対象にできる）
- スクショ・動画・書き出したファイルは、次の場所に保存される
  - 画像 → 写真（`Pictures/ShipSim`）
  - 動画 → 動画（`Movies/ShipSim`）
  - 船の設定（.json）・まとめて保存（.zip）→ ダウンロード（`Download/ShipSim`）
- 戻るボタン：開いているパネル・メニューを閉じる。何も開いていなければ、2回押すと終了

## 入れ方

1. Android の Chrome でブラウザ版を開き、☰ Menu の「🤖 Androidアプリ（APK）をダウンロード」を押す
   （または https://susuruchachi.github.io/-shipsim/shipsim-android.apk を直接開く）
2. ダウンロードした `ShipSim.apk` を開く
3. 「提供元不明のアプリ」の許可を求められたら、Chrome（またはファイルアプリ）に許可する
4. 「インストール」

### 注意

- **アプリの中の保存データ（船の設定・モデル）は、Chrome の中の保存データとは別です。**
  Chrome で作った船をアプリで使うときは、Chrome 側で「船の保存」の ZIP 書き出しをして、アプリ側で ZIP から読み込んでください。
- アプリを**アンインストールすると、アプリの中の保存データも消えます**。消す前に ZIP で書き出してください。
  （上書きで入れ直すだけなら消えません）

## 作り直し方（アプリの入れ物を変えたときだけ。ページの更新では不要）

必要なもの：JDK 17 以上、Android SDK（platform 36・build-tools 36.0.0）

```sh
cd android
echo "sdk.dir=/path/to/android-sdk" > local.properties
./gradlew assembleRelease
cp app/build/outputs/apk/release/app-release.apk ../shipsim-android.apk
```

- 更新するときは `app/build.gradle` の `versionCode` を1つ増やす
- 署名の鍵は `keystore/`。**入れたアプリを上書き更新するには、毎回この同じ鍵で署名する必要があります**
  （鍵が変わると、いったんアンインストールが必要になり、アプリ内の保存データが消えます）。
  個人で入れて使うための鍵なので、パスワードも一緒に置いています（Play ストアでの配布用ではありません）。

## ファイル

- `app/src/main/java/.../MainActivity.java` … 全画面の WebView・ファイル選択・戻るボタン・画面が消えない設定
- `app/src/main/java/.../NativeBridge.java` … ページから呼ぶ窓口（ファイルの保存）
- `app/src/main/assets/offline.html` … 初めて開くときに電波が無かったときの画面
- ページ側の対応は `js/39-android-app.js`（アプリの中でだけ動く）
