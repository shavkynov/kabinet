package ru.kabinet.writer;

import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.IOException;
import java.util.Iterator;
import java.util.concurrent.TimeUnit;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * Один сетевой запрос для WebDAV (PROPFIND, MKCOL, PUT, GET, DELETE). Окно приложения такие запросы
 * не делает: PROPFIND и MKCOL ему недоступны, а чужие серверы без CORS-заголовков браузер блокирует.
 * Ответ отдаётся как есть: код, заголовки и тело в base64. Переходы по ссылкам не выполняются сами:
 * часть серверов отвечает 301 на уже существующую папку, и это нужно видеть.
 */
@CapacitorPlugin(name = "Dav")
public class DavPlugin extends Plugin {

    private static final OkHttpClient CLIENT = new OkHttpClient.Builder()
            .followRedirects(false)
            .followSslRedirects(false)
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(60, TimeUnit.SECONDS)
            .callTimeout(120, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build();

    // Методы плагинов Capacitor выполняются на одном общем потоке: блокирующий запрос задерживал бы все остальные вызовы
    // (в том числе чтение токена из защищённого хранилища). Поэтому запрос уходит асинхронно (enqueue), а общий срок
    // (callTimeout, включая поиск адреса в сети) не даёт ему зависнуть: при плохой связи он завершается ошибкой.
    @PluginMethod
    public void request(final PluginCall call) {
        String method = call.getString("method", "GET");
        String url = call.getString("url");
        if (url == null) {
            call.reject("Не указан адрес.");
            return;
        }
        try {
            Request.Builder rb = new Request.Builder().url(url);
            JSObject headers = call.getObject("headers");
            String contentType = "application/octet-stream";
            if (headers != null) {
                Iterator<String> keys = headers.keys();
                while (keys.hasNext()) {
                    String k = keys.next();
                    String v = headers.getString(k);
                    if (v == null) continue;
                    if (k.equalsIgnoreCase("Content-Type")) contentType = v;
                    rb.header(k, v);
                }
            }
            String b64 = call.getString("body");
            boolean needsBody = method.equals("PUT") || method.equals("POST") || method.equals("PROPFIND")
                    || method.equals("PROPPATCH") || method.equals("REPORT");
            RequestBody body = null;
            if (b64 != null && !b64.isEmpty()) {
                body = RequestBody.create(Base64.decode(b64, Base64.NO_WRAP), MediaType.parse(contentType));
            } else if (needsBody) {
                body = RequestBody.create(new byte[0], MediaType.parse(contentType));
            }
            if (method.equals("GET") || method.equals("HEAD")) body = null;
            rb.method(method, body);

            Integer ms = call.getInt("timeoutMs");
            int timeout = ms == null ? 120000 : Math.max(5000, Math.min(300000, ms));
            OkHttpClient client = CLIENT.newBuilder().callTimeout(timeout, TimeUnit.MILLISECONDS).build();
            client.newCall(rb.build()).enqueue(new Callback() {
                @Override
                public void onFailure(Call c, IOException e) {
                    call.reject(e.getMessage() == null ? e.toString() : e.getMessage());
                }

                @Override
                public void onResponse(Call c, Response res) {
                    try (Response r = res) {
                        JSObject out = new JSObject();
                        out.put("status", r.code());
                        JSObject h = new JSObject();
                        for (String name : r.headers().names()) h.put(name.toLowerCase(), r.header(name));
                        out.put("headers", h);
                        ResponseBody rbody = r.body();
                        byte[] bytes = rbody == null ? new byte[0] : rbody.bytes();
                        out.put("body", Base64.encodeToString(bytes, Base64.NO_WRAP));
                        call.resolve(out);
                    } catch (Exception e) {
                        call.reject(e.getMessage() == null ? e.toString() : e.getMessage());
                    }
                }
            });
        } catch (Exception e) {
            call.reject(e.getMessage() == null ? e.toString() : e.getMessage());
        }
    }
}
