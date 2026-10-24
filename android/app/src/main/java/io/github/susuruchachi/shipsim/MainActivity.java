package io.github.susuruchachi.shipsim;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;
import android.window.OnBackInvokedDispatcher;

import org.json.JSONObject;

/**
 * ShipSim の Android アプリ。
 *
 * 中身はブラウザ版（GitHub Pages のページ）そのもので、それを全画面の WebView で開く。
 * ページを更新すれば、アプリを入れ直さなくても次に開いたときから新しい版になる。
 * 一度開けば、ページの Service Worker（sw.js）が中身を保存するので、電波が無くても起動できる。
 *
 * アプリにしたことで出来るようになること：
 *   ・ステータスバー・ナビゲーションバーを隠した全画面（端から指で引き出すと一時的に出る）
 *   ・画面が消えない（遊んでいる間はスリープしない）
 *   ・端末の「ゲーム」として扱われる（ゲームエンハンサー等の対象にできる）
 *   ・スクショ・動画・書き出したファイルを「写真」「動画」「ダウンロード」へ保存
 *     （WebView は &lt;a download&gt; で保存できないので、NativeBridge 経由で保存する）
 *   ・戻るボタン：開いているパネルを閉じる。何も開いていなければ、2回押しで終了
 */
public class MainActivity extends Activity {
    static final String HOME_URL = "https://susuruchachi.github.io/-shipsim/";
    private static final String HOME_HOST = "susuruchachi.github.io";
    private static final String HOME_PATH = "/-shipsim/";
    private static final String OFFLINE_URL = "file:///android_asset/offline.html";
    private static final int REQ_FILE = 1001;

    private FrameLayout root;
    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private long lastBackAt;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Window w = getWindow();
        // 遊んでいる間は画面を消さない
        w.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= 28) {
            WindowManager.LayoutParams lp = w.getAttributes();
            lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            w.setAttributes(lp);
        }

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0a1a2a"));
        setContentView(root);
        web = createWebView();
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        web.loadUrl(HOME_URL);

        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBack);
        }
        hideSystemBars();
    }

    @SuppressLint("SetJavaScriptEnabled")
    private WebView createWebView() {
        WebView v = new WebView(this);
        v.setBackgroundColor(Color.parseColor("#0a1a2a"));
        v.setOverScrollMode(View.OVER_SCROLL_NEVER);
        v.setVerticalScrollBarEnabled(false);
        v.setHorizontalScrollBarEnabled(false);

        WebSettings s = v.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);                 // localStorage / IndexedDB（船の保存）
        s.setMediaPlaybackRequiresUserGesture(false); // 音（Web Audio）をすぐ鳴らせるように
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setTextZoom(100);                           // 端末の文字サイズ設定で画面が崩れないように
        s.setAllowFileAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setUserAgentString(s.getUserAgentString() + " ShipSimAndroid/" + BuildConfig.VERSION_NAME);
        CookieManager.getInstance().setAcceptCookie(true);

        if (Build.VERSION.SDK_INT >= 26) {
            // 表示中は WebView の処理を優先。裏に回ったら優先度を下げる（電池のため）
            v.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, true);
        }

        v.addJavascriptInterface(new NativeBridge(this), "ShipSimNative");
        v.setWebViewClient(new ShipWebViewClient());
        v.setWebChromeClient(new ShipChromeClient());
        v.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            if (url.startsWith("blob:") || url.startsWith("data:")) {
                // 普通はページ側（39-android-app.js）が先に拾う。拾えなかったときの予備
                String name = android.webkit.URLUtil.guessFileName(url, contentDisposition, mimeType);
                v.evaluateJavascript("window.shipsimSaveUrl && shipsimSaveUrl(" + JSONObject.quote(url) + ","
                        + JSONObject.quote(name) + ")", null);
            } else {
                openExternal(Uri.parse(url));
            }
        });
        return v;
    }

    /** このアプリのページ（GitHub Pages の ShipSim）かどうか */
    static boolean isOurs(Uri u) {
        if (u == null) return false;
        String scheme = u.getScheme();
        if ("blob".equals(scheme) || "data".equals(scheme) || "about".equals(scheme)) return true;
        if ("file".equals(scheme)) return u.toString().startsWith("file:///android_asset/");
        if (!"https".equals(scheme)) return false;
        String path = u.getPath() == null ? "" : u.getPath();
        return HOME_HOST.equalsIgnoreCase(u.getHost()) && (path.startsWith(HOME_PATH) || (path + "/").equals(HOME_PATH));
    }

    private void openExternal(Uri u) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, u).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (ActivityNotFoundException e) {
            toast("開けませんでした");
        }
    }

    private class ShipWebViewClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            if (isOurs(u)) return false;
            // よそのページはアプリの中では開かず、ブラウザで開く
            openExternal(u);
            return true;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            // 初めて開くときに電波が無い等で、ページ自体が読めなかったとき
            if (request.isForMainFrame() && !OFFLINE_URL.equals(request.getUrl().toString())) {
                view.loadUrl(OFFLINE_URL);
            }
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            // 表示の処理（3D）がメモリ不足などで落ちたとき：アプリごと落ちないよう作り直す
            if (view == web) recreateWebView();
            return true;
        }
    }

    private class ShipChromeClient extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            // 「.glb」のような拡張子の指定は Android の種類（MIME）に直せないことが多いので、
            // すべて MIME のときだけ絞り込む（それ以外は全部のファイルを出す）
            String[] mimes = mimeTypesOnly(params.getAcceptTypes());
            i.setType(mimes.length == 1 ? mimes[0] : "*/*");
            if (mimes.length > 1) i.putExtra(Intent.EXTRA_MIME_TYPES, mimes);
            int mode = params.getMode();
            if (mode == FileChooserParams.MODE_OPEN_MULTIPLE || mode == 2 /* フォルダ：複数選択で代用 */) {
                i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            }
            try {
                startActivityForResult(i, REQ_FILE);
            } catch (ActivityNotFoundException e) {
                fileCallback = null;
                callback.onReceiveValue(null);
                toast("ファイルを選ぶアプリが見つかりません");
            }
            return true;
        }

        @Override
        public void onPermissionRequest(PermissionRequest request) {
            request.deny();   // カメラ・マイクは使わない
        }
    }

    private static String[] mimeTypesOnly(String[] accept) {
        if (accept == null) return new String[0];
        java.util.ArrayList<String> out = new java.util.ArrayList<>();
        for (String a : accept) {
            if (a == null) continue;
            for (String t : a.split(",")) {
                t = t.trim();
                if (t.isEmpty()) continue;
                if (!t.contains("/")) return new String[0];
                out.add(t);
            }
        }
        return out.toArray(new String[0]);
    }

    @Override
    @SuppressWarnings("deprecation")
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE) {
            ValueCallback<Uri[]> cb = fileCallback;
            fileCallback = null;
            if (cb == null) return;
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null) {
                ClipData clip = data.getClipData();
                if (clip != null && clip.getItemCount() > 0) {
                    result = new Uri[clip.getItemCount()];
                    for (int k = 0; k < clip.getItemCount(); k++) result[k] = clip.getItemAt(k).getUri();
                } else if (data.getData() != null) {
                    result = new Uri[]{data.getData()};
                }
            }
            cb.onReceiveValue(result);
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    private void recreateWebView() {
        if (web != null) {
            root.removeView(web);
            web.destroy();
        }
        web = createWebView();
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        web.loadUrl(HOME_URL);
        toast("表示の処理が止まったので、読み込み直しました");
    }

    // ── 全画面（ステータスバー・ナビゲーションバーを隠す）──
    @SuppressWarnings("deprecation")
    private void hideSystemBars() {
        Window w = getWindow();
        if (Build.VERSION.SDK_INT >= 30) {
            w.setDecorFitsSystemWindows(false);
            WindowInsetsController c = w.getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            w.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    // ── 戻るボタン ──
    // まずページに聞いて、開いているパネル等があれば閉じる。無ければ2回押しで終了
    private void handleBack() {
        if (web == null) { finish(); return; }
        if (OFFLINE_URL.equals(web.getUrl())) { finish(); return; }
        web.evaluateJavascript("(function(){try{return !!(window.shipsimOnBack&&window.shipsimOnBack());}catch(e){return false;}})()", value -> {
            if ("true".equals(value)) return;
            long now = SystemClock.uptimeMillis();
            if (now - lastBackAt < 2000) {
                finish();
            } else {
                lastBackAt = now;
                toast("もう一度押すと終了します");
            }
        });
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        handleBack();   // Android 12 以下（13以降は OnBackInvokedCallback から）
    }

    // ── 裏に回ったとき・戻ったとき ──
    @Override
    protected void onPause() {
        if (web != null) {
            web.evaluateJavascript("window.shipsimNativePause&&shipsimNativePause(true)", null);
            web.onPause();
            web.pauseTimers();
        }
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) {
            web.resumeTimers();
            web.onResume();
            web.evaluateJavascript("window.shipsimNativePause&&shipsimNativePause(false)", null);
        }
        hideSystemBars();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            root.removeView(web);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    void toast(String msg) {
        runOnUiThread(() -> Toast.makeText(this, msg, Toast.LENGTH_SHORT).show());
    }
}
