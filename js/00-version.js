// アプリの版（バージョン）：A.BB.CCC.DDD
//   A   … 正式版になったら 1
//   BB  … 大きな段階（世界・港の作り込みなど、まとまった節目）
//   CCC … 機能の追加（新しくできるようになったこと）
//   DDD … 修正・調整（不具合の修正、細かな直し）
// 上の桁を上げたら、下の桁は 0 に戻す。Push するたびに上げる。
//
// 0.01.000.000  版の番号を付け始めた。座礁から自力／タグで抜け出す、現実世界の航路が陸をかすめないように
// 0.01.000.001  サウサンプトン港の岸壁を南東（サウサンプトン・ウォーター）向きに。タイタニックが出港できる
var APP_VERSION = '0.01.000.001';
if (typeof self !== 'undefined') self.APP_VERSION = APP_VERSION;
// 設定パネルの見出しに出す
if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => { const el = document.getElementById('app-version'); if (el) el.textContent = 'v' + APP_VERSION; });
