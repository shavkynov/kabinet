package ru.kabinet.writer;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * Доступ к обычной папке на телефоне или в облаке (Яндекс.Диск, Google Drive, Dropbox):
 * пользователь один раз выбирает её системным окном Android, приложение получает
 * постоянное разрешение и читает/пишет файлы. Так проект можно вести в одной папке
 * с компьютером.
 */
@CapacitorPlugin(name = "Saf")
public class SafPlugin extends Plugin {

    private static final String PREFS = "kabinet-saf";
    private static final String KEY_URI = "folder-uri";

    // ---------- выбор папки ----------

    @PluginMethod
    public void chooseFolder(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
                | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        startActivityForResult(call, intent, "chooseResult");
    }

    @ActivityCallback
    private void chooseResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (data == null || data.getData() == null) {
            call.resolve(new JSObject().put("uri", (String) null));
            return;
        }
        Uri tree = data.getData();
        int flags = Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
        try {
            getContext().getContentResolver().takePersistableUriPermission(tree, flags);
        } catch (Exception e) {
            call.reject("Не удалось сохранить доступ к папке: " + e.getMessage());
            return;
        }
        prefs().edit().putString(KEY_URI, tree.toString()).apply();
        JSObject res = new JSObject();
        res.put("uri", tree.toString());
        res.put("name", displayName(tree));
        call.resolve(res);
    }

    @PluginMethod
    public void getFolder(PluginCall call) {
        String saved = prefs().getString(KEY_URI, null);
        JSObject res = new JSObject();
        if (saved == null) {
            res.put("uri", (String) null);
            call.resolve(res);
            return;
        }
        Uri tree = Uri.parse(saved);
        if (!hasAccess(tree)) {
            prefs().edit().remove(KEY_URI).apply();
            res.put("uri", (String) null);
            res.put("expired", true);
            call.resolve(res);
            return;
        }
        res.put("uri", saved);
        res.put("name", displayName(tree));
        call.resolve(res);
    }

    @PluginMethod
    public void forgetFolder(PluginCall call) {
        String given = call.getString("uri");
        String saved = (given != null && !given.isEmpty()) ? given : prefs().getString(KEY_URI, null);
        if (saved != null) {
            try {
                getContext().getContentResolver().releasePersistableUriPermission(
                        Uri.parse(saved),
                        Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            } catch (Exception ignored) { }
            if (saved.equals(prefs().getString(KEY_URI, null))) prefs().edit().remove(KEY_URI).apply();
        }
        call.resolve();
    }

    // ---------- операции с файлами ----------
    // Каждый вызов получает uri дерева: у разных проектов могут быть разные папки, и брать
    // последнюю выбранную нельзя — иначе проект уедет в чужую папку.

    @PluginMethod
    public void list(PluginCall call) {
        String rel = call.getString("path", "");
        try {
            Uri dir = resolve(call, rel, false);
            JSArray items = new JSArray();
            if (dir != null) {
                Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(dir, DocumentsContract.getDocumentId(dir));
                String[] cols = {
                    DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                    DocumentsContract.Document.COLUMN_MIME_TYPE,
                    DocumentsContract.Document.COLUMN_SIZE,
                    DocumentsContract.Document.COLUMN_LAST_MODIFIED};
                try (Cursor c = getContext().getContentResolver().query(children, cols, null, null, null)) {
                    // null — провайдер не смог ответить. Пустым списком это быть не должно: синхронизация
                    // приняла бы его за «в папке всё удалили».
                    if (c == null) throw new Exception("Папка не отвечает. Попробуйте позже.");
                    while (c.moveToNext()) {
                        JSObject o = new JSObject();
                        o.put("name", c.getString(0));
                        o.put("dir", DocumentsContract.Document.MIME_TYPE_DIR.equals(c.getString(1)));
                        o.put("size", c.isNull(2) ? -1 : c.getLong(2));
                        o.put("mtime", c.isNull(3) ? 0 : c.getLong(3));
                        items.put(o);
                    }
                }
            }
            JSObject res = new JSObject();
            res.put("items", items);
            call.resolve(res);
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    @PluginMethod
    public void read(PluginCall call) {
        String rel = call.getString("path");
        if (rel == null) { call.reject("Нет пути"); return; }
        try {
            Uri file = resolve(call, rel, false);
            if (file == null) { call.reject("Файла нет: " + rel, "ENOENT"); return; }
            try (InputStream in = getContext().getContentResolver().openInputStream(file)) {
                if (in == null) { call.reject("Не удалось открыть: " + rel); return; }
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                JSObject res = new JSObject();
                res.put("data", android.util.Base64.encodeToString(out.toByteArray(), android.util.Base64.NO_WRAP));
                call.resolve(res);
            }
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    @PluginMethod
    public void write(PluginCall call) {
        String rel = call.getString("path");
        String b64 = call.getString("data");
        if (rel == null || b64 == null) { call.reject("Нет данных"); return; }
        try {
            byte[] bytes = android.util.Base64.decode(b64, android.util.Base64.DEFAULT);
            Uri tree = tree(call);
            Uri parent = resolve(call, parentOf(rel), true);
            String name = baseName(rel);
            Uri file = findChild(tree, parent, name);
            if (file == null) {
                file = DocumentsContract.createDocument(
                        getContext().getContentResolver(), parent, "application/octet-stream", name);
            }
            if (file == null) { call.reject("Не удалось создать: " + rel); return; }
            try (OutputStream os = getContext().getContentResolver().openOutputStream(file, "wt")) {
                if (os == null) { call.reject("Не удалось записать: " + rel); return; }
                os.write(bytes);
                os.flush();
            }
            call.resolve();
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String rel = call.getString("path");
        if (rel == null) { call.reject("Нет пути"); return; }
        try {
            Uri file = resolve(call, rel, false);
            if (file != null) DocumentsContract.deleteDocument(getContext().getContentResolver(), file);
            call.resolve();
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    @PluginMethod
    public void mkdir(PluginCall call) {
        String rel = call.getString("path");
        if (rel == null) { call.reject("Нет пути"); return; }
        try {
            resolve(call, rel, true);
            call.resolve();
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    // ---------- вспомогательное ----------

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Activity.MODE_PRIVATE);
    }

    /** Папка для вызова: uri из вызова (у проекта своя папка), иначе последняя выбранная. */
    private Uri tree(PluginCall call) throws Exception {
        String given = call == null ? null : call.getString("uri");
        String saved = (given != null && !given.isEmpty()) ? given : prefs().getString(KEY_URI, null);
        if (saved == null) throw new Exception("Папка не выбрана.");
        Uri tree = Uri.parse(saved);
        if (!hasAccess(tree)) throw new Exception("Нет доступа к папке. Выберите её заново.");
        return tree;
    }

    private boolean hasAccess(Uri tree) {
        for (android.content.UriPermission p : getContext().getContentResolver().getPersistedUriPermissions()) {
            if (p.getUri().equals(tree) && p.isReadPermission() && p.isWritePermission()) return true;
        }
        return false;
    }

    /** Человекочитаемое имя выбранной папки (для подписи в меню). */
    private String displayName(Uri tree) {
        String id = DocumentsContract.getTreeDocumentId(tree);
        String last = id.contains("/") ? id.substring(id.lastIndexOf('/') + 1) : id;
        if (last.isEmpty()) last = id;
        return last.replace("%20", " ");
    }

    /**
     * Возвращает URI элемента по относительному пути ("Главы/abc.md") или null, если его нет.
     * create=true — недостающие папки создаются.
     */
    private Uri resolve(PluginCall call, String rel, boolean create) throws Exception {
        Uri tree = tree(call);
        Uri cur = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
        if (rel == null || rel.isEmpty() || rel.equals(".")) return cur;
        for (String seg : rel.split("/")) {
            if (seg.isEmpty() || seg.equals(".")) continue;
            Uri child = findChild(tree, cur, seg);
            if (child == null) {
                if (!create) return null;
                child = DocumentsContract.createDocument(
                        getContext().getContentResolver(), cur,
                        DocumentsContract.Document.MIME_TYPE_DIR, seg);
                if (child == null) throw new Exception("Не удалось создать папку: " + seg);
            }
            cur = child;
        }
        return cur;
    }

    // Идентификатор документа у разных поставщиков устроен по-своему (у одних — путь, у других —
    // номер файла), поэтому берём его из ответа поставщика, а не собираем сами.
    private Uri findChild(Uri tree, Uri parent, String name) throws Exception {
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(parent, DocumentsContract.getDocumentId(parent));
        String[] cols = {DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_DOCUMENT_ID};
        // Ошибку провайдера нельзя выдавать за «такого файла нет»: иначе список папки получился бы пустым,
        // а запись — создала бы дубликат рядом с существующим файлом.
        try (Cursor c = getContext().getContentResolver().query(children, cols, null, null, null)) {
            if (c == null) throw new Exception("Папка не отвечает. Попробуйте позже.");
            while (c.moveToNext()) {
                if (name.equals(c.getString(0))) {
                    return DocumentsContract.buildDocumentUriUsingTree(tree, c.getString(1));
                }
            }
        }
        return null;
    }

    private static String parentOf(String rel) {
        int i = rel.lastIndexOf('/');
        return i < 0 ? "" : rel.substring(0, i);
    }

    private static String baseName(String rel) {
        int i = rel.lastIndexOf('/');
        return i < 0 ? rel : rel.substring(i + 1);
    }
}
