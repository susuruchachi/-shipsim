package io.github.susuruchachi.shipsim;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.pm.PackageManager;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * ページ（JavaScript）から呼ぶ窓口。window.ShipSimNative として見える。
 *
 * WebView では &lt;a download&gt; でファイルを保存できないので、ページ側
 * （js/39-android-app.js）がファイルの中身を小分け（base64）にして渡し、ここで
 *   画像 → 写真（Pictures/ShipSim）
 *   動画 → 動画（Movies/ShipSim）
 *   それ以外（船の設定 .json・まとめて保存 .zip 等）→ ダウンロード（Download/ShipSim）
 * に保存する。
 */
final class NativeBridge {
    private final MainActivity act;
    private final Map<String, Session> sessions = new HashMap<>();
    private int nextId = 1;

    private static final class Session {
        final File tmp;
        final OutputStream out;
        final String name;
        final String mime;

        Session(File tmp, OutputStream out, String name, String mime) {
            this.tmp = tmp;
            this.out = out;
            this.name = name;
            this.mime = mime;
        }
    }

    NativeBridge(MainActivity act) {
        this.act = act;
    }

    @JavascriptInterface
    public String version() {
        return BuildConfig.VERSION_NAME;
    }

    @JavascriptInterface
    public void toast(String msg) {
        act.toast(msg);
    }

    /** 保存を始める。戻り値の番号を saveChunk / saveEnd に渡す（失敗なら空文字） */
    @JavascriptInterface
    public synchronized String saveBegin(String name, String mime) {
        try {
            File dir = new File(act.getCacheDir(), "saving");
            if (!dir.isDirectory() && !dir.mkdirs()) return "";
            File tmp = File.createTempFile("save", ".part", dir);
            String clean = cleanName(name);
            String m = (mime == null || mime.trim().isEmpty()) ? guessMime(clean) : mime.split(";")[0].trim();
            String id = String.valueOf(nextId++);
            sessions.put(id, new Session(tmp, new BufferedOutputStream(new FileOutputStream(tmp), 1 << 16), clean, m));
            return id;
        } catch (IOException e) {
            return "";
        }
    }

    @JavascriptInterface
    public synchronized boolean saveChunk(String id, String base64) {
        Session s = sessions.get(id);
        if (s == null) return false;
        try {
            s.out.write(Base64.decode(base64, Base64.DEFAULT));
            return true;
        } catch (IOException | IllegalArgumentException e) {
            abort(id);
            return false;
        }
    }

    /** 保存を終える。保存先の説明（例「写真（Pictures/ShipSim）」）を返す。失敗なら空文字 */
    @JavascriptInterface
    public String saveEnd(String id) {
        Session s;
        synchronized (this) {
            s = sessions.remove(id);
        }
        if (s == null) return "";
        try {
            s.out.close();
            String where = publish(s.tmp, s.name, s.mime);
            act.toast("保存しました：" + where);
            return where;
        } catch (Exception e) {
            act.toast("保存できませんでした");
            return "";
        } finally {
            //noinspection ResultOfMethodCallIgnored
            s.tmp.delete();
        }
    }

    @JavascriptInterface
    public synchronized void saveAbort(String id) {
        abort(id);
    }

    private void abort(String id) {
        Session s = sessions.remove(id);
        if (s == null) return;
        try {
            s.out.close();
        } catch (IOException ignored) {
        }
        //noinspection ResultOfMethodCallIgnored
        s.tmp.delete();
    }

    // ── 保存先へ書き出す ──
    private String publish(File tmp, String name, String mime) throws IOException {
        final String dirType;
        final String label;
        if (mime.startsWith("image/")) {
            dirType = Environment.DIRECTORY_PICTURES;
            label = "写真";
        } else if (mime.startsWith("video/")) {
            dirType = Environment.DIRECTORY_MOVIES;
            label = "動画";
        } else {
            dirType = Environment.DIRECTORY_DOWNLOADS;
            label = "ダウンロード";
        }
        final String sub = dirType + "/ShipSim";

        if (Build.VERSION.SDK_INT >= 29) {
            // Android 10 以降：MediaStore に登録（権限なしで保存でき、すぐ「写真」等に出る）
            ContentResolver cr = act.getContentResolver();
            Uri collection;
            if (mime.startsWith("image/")) collection = MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
            else if (mime.startsWith("video/")) collection = MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
            else collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
            v.put(MediaStore.MediaColumns.RELATIVE_PATH, sub);
            v.put(MediaStore.MediaColumns.IS_PENDING, 1);
            Uri item = cr.insert(collection, v);
            if (item == null) throw new IOException("insert failed");
            try (InputStream in = new FileInputStream(tmp); OutputStream out = cr.openOutputStream(item)) {
                if (out == null) throw new IOException("open failed");
                copy(in, out);
            } catch (IOException e) {
                cr.delete(item, null, null);
                throw e;
            }
            v.clear();
            v.put(MediaStore.MediaColumns.IS_PENDING, 0);
            cr.update(item, v, null, null);
            return label + "（" + sub + "）";
        }

        // Android 9 以下：保存の権限があれば共有フォルダへ。無ければアプリ専用のフォルダへ
        File dir;
        String where;
        boolean shared = act.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED;
        if (shared) {
            //noinspection deprecation
            dir = new File(Environment.getExternalStoragePublicDirectory(dirType), "ShipSim");
            where = label + "（" + sub + "）";
        } else {
            act.runOnUiThread(() -> act.requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, 2001));
            dir = act.getExternalFilesDir(dirType);
            if (dir == null) dir = new File(act.getFilesDir(), dirType);
            where = "アプリのフォルダ（" + dir.getAbsolutePath() + "）";
        }
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("mkdir failed");
        File dst = uniqueFile(dir, name);
        try (InputStream in = new FileInputStream(tmp); OutputStream out = new FileOutputStream(dst)) {
            copy(in, out);
        }
        MediaScannerConnection.scanFile(act, new String[]{dst.getAbsolutePath()}, new String[]{mime}, null);
        return where;
    }

    private static void copy(InputStream in, OutputStream out) throws IOException {
        byte[] buf = new byte[1 << 16];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
    }

    private static File uniqueFile(File dir, String name) {
        File f = new File(dir, name);
        if (!f.exists()) return f;
        int dot = name.lastIndexOf('.');
        String stem = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 1; i < 1000; i++) {
            f = new File(dir, stem + " (" + i + ")" + ext);
            if (!f.exists()) return f;
        }
        return new File(dir, stem + "_" + System.currentTimeMillis() + ext);
    }

    private static String cleanName(String name) {
        String n = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|\\x00-\\x1f]", "_").trim();
        return n.isEmpty() ? "shipsim_" + System.currentTimeMillis() : n;
    }

    private static String guessMime(String name) {
        String n = name.toLowerCase(Locale.ROOT);
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
        if (n.endsWith(".webp")) return "image/webp";
        if (n.endsWith(".mp4")) return "video/mp4";
        if (n.endsWith(".webm")) return "video/webm";
        if (n.endsWith(".json")) return "application/json";
        if (n.endsWith(".zip")) return "application/zip";
        return "application/octet-stream";
    }
}
