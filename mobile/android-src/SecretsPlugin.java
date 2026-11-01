package ru.kabinet.writer;

import android.annotation.TargetApi;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Защищённое хранилище для токена Яндекса. Значение шифруется ключом из Android Keystore (AES-256-GCM): сам ключ
 * не покидает защищённую область телефона, а в памяти приложения (SharedPreferences) лежит только шифртекст.
 * Если ключ пропал (например, после переноса приложения на другой телефон), значение считается отсутствующим:
 * пользователь просто подключит Яндекс заново. Открытого хранения нет: на Android ниже 6.0 данные не сохраняются.
 */
@CapacitorPlugin(name = "Secrets")
public class SecretsPlugin extends Plugin {

    private static final String PROVIDER = "AndroidKeyStore";
    private static final String ALIAS = "ru.kabinet.writer.secrets.v1";
    private static final String PREFS = "kabinet_secrets";
    private static final String PREFIX = "s.";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";
    private static final int TAG_BITS = 128;

    private static boolean supported() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.M;
    }

    @TargetApi(Build.VERSION_CODES.M)
    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance(PROVIDER);
        store.load(null);
        if (store.containsAlias(ALIAS)) {
            SecretKey existing = (SecretKey) store.getKey(ALIAS, null);
            if (existing != null) return existing;
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER);
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return generator.generateKey();
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    @PluginMethod
    public void set(PluginCall call) {
        String name = call.getString("key");
        String value = call.getString("value");
        if (name == null || name.isEmpty() || value == null) {
            call.reject("Не указан ключ или значение.");
            return;
        }
        if (!supported()) {
            call.reject("Защищённое хранилище недоступно на этой версии Android.");
            return;
        }
        try {
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.ENCRYPT_MODE, key());
            byte[] iv = cipher.getIV();
            byte[] encrypted = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            String packed = Base64.encodeToString(iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(encrypted, Base64.NO_WRAP);
            if (!prefs().edit().putString(PREFIX + name, packed).commit()) {
                call.reject("Не удалось записать защищённые данные.");
                return;
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("Не удалось защитить данные.");
        }
    }

    @PluginMethod
    public void get(PluginCall call) {
        String name = call.getString("key");
        if (name == null || name.isEmpty()) {
            call.reject("Не указан ключ.");
            return;
        }
        JSObject out = new JSObject();
        String packed = prefs().getString(PREFIX + name, null);
        if (packed == null || !supported()) {
            out.put("value", JSObject.NULL);
            call.resolve(out);
            return;
        }
        try {
            String[] parts = packed.split(":");
            if (parts.length != 2) throw new IllegalStateException("format");
            byte[] iv = Base64.decode(parts[0], Base64.NO_WRAP);
            byte[] encrypted = Base64.decode(parts[1], Base64.NO_WRAP);
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(TAG_BITS, iv));
            out.put("value", new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8));
        } catch (Exception e) {
            // Ключ пропал или данные повреждены: убираем запись, пользователь подключит Яндекс заново.
            prefs().edit().remove(PREFIX + name).apply();
            out.put("value", JSObject.NULL);
        }
        call.resolve(out);
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String name = call.getString("key");
        if (name == null || name.isEmpty()) {
            call.reject("Не указан ключ.");
            return;
        }
        prefs().edit().remove(PREFIX + name).apply();
        call.resolve();
    }
}
