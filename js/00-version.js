// アプリの版（バージョン）：A.BB.CCC.DDD
//   A   … 正式版になったら 1
//   BB  … 大きな段階（世界・港の作り込みなど、まとまった節目）
//   CCC … 機能の追加（新しくできるようになったこと）
//   DDD … 修正・調整（不具合の修正、細かな直し）
// 上の桁を上げたら、下の桁は 0 に戻す。Push するたびに上げる。
//
// 0.01.000.000  版の番号を付け始めた。座礁から自力／タグで抜け出す、現実世界の航路が陸をかすめないように
// 0.01.000.001  サウサンプトン港の岸壁を南東（サウサンプトン・ウォーター）向きに。タイタニックが出港できる
// 0.02.000.000  作り込んだ港の仕組み（10m の地形：OpenStreetMap＋EMODnet、港のそばは 10m の3D地形、港の中の航路は
//               細かい地形の深い所をたどる）。サウサンプトンの地形。港は西ドックの岸壁
// 0.02.000.001  港のそばの細かい地形の網を、水から 100m 以内だけに（三角形 41 万 → 5 万。内陸は粗い網）
var APP_VERSION = '0.02.000.001';
if (typeof self !== 'undefined') self.APP_VERSION = APP_VERSION;
// 設定パネルの見出しに出す
if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => { const el = document.getElementById('app-version'); if (el) el.textContent = 'v' + APP_VERSION; });
