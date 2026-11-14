'use strict';

// Доступ к сетевой папке по WebDAV (Яндекс Диск, Nextcloud, Mail.ru Облако, NAS и т. п.).
// Модуль не знает, чем выполняются запросы: request({ method, url, headers, body }) отдаёт
// { status, headers (ключи в нижнем регистре), body: Uint8Array }. На компьютере это fetch,
// на Android — плагин Dav (OkHttp), потому что окно приложения не умеет PROPFIND и упирается в CORS.
//
// Интерфейс адаптера тот же, что у src/folder.js: list / read / write / remove / mkdir.

const enc = new TextEncoder();
const dec = new TextDecoder();

class DavError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status || 0;
  }
}

function toBase64(u8) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < u8.length; i += 3) {
    const a = u8[i];
    const b = i + 1 < u8.length ? u8[i + 1] : 0;
    const c = i + 2 < u8.length ? u8[i + 2] : 0;
    out += chars[a >> 2] + chars[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < u8.length ? chars[((b & 15) << 2) | (c >> 6)] : '=';
    out += i + 2 < u8.length ? chars[c & 63] : '=';
  }
  return out;
}

/** Адрес сервера в каноническом виде: https://host/путь без «/» в конце. Бросает понятную ошибку. */
function normalizeUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) throw new DavError('Введите адрес сервера.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { throw new DavError('Адрес сервера записан неверно.'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new DavError('Адрес должен начинаться с https://');
  const p = u.pathname.replace(/\/+$/, '');
  return `${u.protocol}//${u.host}${p}`;
}

const segs = (p) => String(p || '').split('/').filter(Boolean);
const encodePath = (parts) => parts.map((x) => encodeURIComponent(x)).join('/');

function unxml(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

/** Разбор ответа PROPFIND: [{ href (путь, раскодированный), dir, size, mtime }]. Префиксы пространств имён любые. */
function parseMultistatus(xml) {
  const out = [];
  const re = /<(?:[\w.-]+:)?response[\s>][\s\S]*?<\/(?:[\w.-]+:)?response>/gi;
  for (const block of String(xml).match(re) || []) {
    const hm = /<(?:[\w.-]+:)?href[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?href>/i.exec(block);
    if (!hm) continue;
    let href = unxml(hm[1]).trim();
    try {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(href)) href = new URL(href).pathname;
    } catch { /* оставляем как есть */ }
    // Декодируем по частям пути: %2F внутри имени не должен превращаться в разделитель и подменять файл.
    let bad = false;
    href = href.split('/').map((part) => {
      let d = part;
      try { d = decodeURIComponent(part); } catch { /* уже раскодирован */ }
      if (d.includes('/') || d.includes('\0')) bad = true;
      return d;
    }).join('/');
    if (bad) continue;
    const dir = /<(?:[\w.-]+:)?collection\s*\/?>/i.test(block);
    const sm = /<(?:[\w.-]+:)?getcontentlength[^>]*>(\d+)</i.exec(block);
    const mm = /<(?:[\w.-]+:)?getlastmodified[^>]*>([^<]*)</i.exec(block);
    out.push({ href, dir, size: sm ? Number(sm[1]) : 0, mtime: mm ? Date.parse(unxml(mm[1])) || 0 : 0 });
  }
  return out;
}

const PROPFIND_BODY = '<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><prop><resourcetype/><getcontentlength/><getlastmodified/></prop></propfind>';

/** http:// допустим только в домашней сети: пароль идёт открытым текстом, в интернете это недопустимо. */
function isHomeHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || h.endsWith('.local') || !h.includes('.') && !h.includes(':')) return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(h);
  if (!m) return /^f[cd][0-9a-f]{2}:/.test(h) || h.startsWith('fe80:'); // IPv6: частные и локальные адреса
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

function assertSafeTransport(base) {
  const u = new URL(base);
  if (u.protocol === 'http:' && !isHomeHost(u.hostname)) {
    throw new DavError('Логин и пароль нельзя отправлять по http:// через интернет. Укажите адрес с https://.');
  }
}

/**
 * Папка на сервере: { url, user, pass, root }, root — путь внутри сервера («/Кабинет/Мой роман»).
 * Пути в методах — относительно root.
 */
function createWebDav({ url, user, pass, root = '', request }) {
  const base = normalizeUrl(url);
  assertSafeTransport(base);
  const basePath = segs(new URL(base).pathname);
  const rootParts = segs(root);
  const auth = `Basic ${toBase64(enc.encode(`${user || ''}:${pass || ''}`))}`;
  const known = new Set(); // каталоги, которые точно есть (чтобы не слать MKCOL при каждой записи)

  const fullUrl = (parts) => `${new URL(base).origin}/${encodePath([...basePath, ...rootParts, ...parts])}`;
  const withSlash = (u, dir) => (dir && !u.endsWith('/') ? `${u}/` : u);
  const send = async (method, parts, extra = {}) => {
    let res;
    try {
      res = await request({ method, url: withSlash(fullUrl(parts), extra.dir), headers: { Authorization: auth, ...(extra.headers || {}) }, body: extra.body });
    } catch (e) {
      throw new DavError(`Нет связи с сервером: ${(e && e.message) || e}`);
    }
    if (res.status === 401) throw new DavError('Сервер не принял логин или пароль.', 401);
    if (res.status === 403) throw new DavError('Нет прав на эту папку.', 403);
    if (res.status === 507) throw new DavError('На сервере закончилось место.', 507);
    if (res.status === 429) throw new DavError('Сервер просит подождать: слишком много запросов.', 429);
    return res;
  };
  const okStatus = (s) => s >= 200 && s < 300;

  async function mkdirParts(parts) {
    for (let i = 1; i <= parts.length; i += 1) {
      const sub = parts.slice(0, i);
      const key = sub.join('/');
      if (known.has(key)) continue;
      const res = await send('MKCOL', sub, { dir: true });
      // 201 создана, 405 уже есть, 301/302 некоторые серверы отвечают так на существующую
      if (okStatus(res.status) || res.status === 405 || res.status === 301 || res.status === 302) known.add(key);
      else throw new DavError(`Не удалось создать папку «${sub[sub.length - 1]}» (код ${res.status}).`, res.status);
    }
  }

  // Создать root и родителей: MKCOL по очереди с самого верхнего уровня (basePath уже есть).
  async function mkdirRoot() {
    for (let i = 1; i <= rootParts.length; i += 1) {
      const sub = rootParts.slice(0, i);
      const key = `#r/${sub.join('/')}`;
      if (known.has(key)) continue;
      const url2 = `${new URL(base).origin}/${encodePath([...basePath, ...sub])}/`;
      let res;
      try { res = await request({ method: 'MKCOL', url: url2, headers: { Authorization: auth } }); } catch (e) { throw new DavError(`Нет связи с сервером: ${(e && e.message) || e}`); }
      if (res.status === 401) throw new DavError('Сервер не принял логин или пароль.', 401);
      if (res.status === 403) throw new DavError('Нет прав на эту папку.', 403);
      if (!(okStatus(res.status) || res.status === 405 || res.status === 301 || res.status === 302)) {
        throw new DavError(`Не удалось создать папку «${sub[sub.length - 1]}» (код ${res.status}).`, res.status);
      }
      known.add(key);
    }
  }

  async function propfind(parts, depth) {
    const res = await send('PROPFIND', parts, { dir: true, headers: { Depth: String(depth), 'Content-Type': 'application/xml; charset=utf-8' }, body: enc.encode(PROPFIND_BODY) });
    if (res.status === 404) return null;
    if (res.status !== 207 && !okStatus(res.status)) throw new DavError(`Сервер ответил кодом ${res.status}.`, res.status);
    return parseMultistatus(dec.decode(res.body || new Uint8Array(0)));
  }

  return {
    /** Проверка доступа: бросает понятную ошибку, если сервер не принял вход. */
    async check() {
      const items = await propfind([], 0);
      return items !== null;
    },

    /** Создать корневую папку (и родителей), если её ещё нет. */
    async ensureRoot() { await mkdirRoot(); },

    async list(rel) {
      const parts = segs(rel);
      const items = await propfind(parts, 1);
      if (!items) return [];
      const selfPath = [...basePath, ...rootParts, ...parts];
      const out = [];
      for (const it of items) {
        const hp = segs(it.href);
        // себя пропускаем: у записи тот же путь, что у запрошенной папки
        if (hp.length === selfPath.length && hp.every((x, i) => x === selfPath[i])) continue;
        const name = hp[hp.length - 1];
        if (!name) continue;
        out.push({ name, dir: it.dir, size: it.size, mtime: it.mtime });
      }
      return out;
    },

    async read(rel) {
      const parts = segs(rel);
      const res = await send('GET', parts);
      if (res.status === 404) return null;
      if (!okStatus(res.status)) throw new DavError(`Не удалось прочитать файл (код ${res.status}).`, res.status);
      return new Uint8Array(res.body || new Uint8Array(0));
    },

    async write(rel, bytes) {
      const parts = segs(rel);
      const put = () => send('PUT', parts, { body: bytes, headers: { 'Content-Type': 'application/octet-stream' } });
      if (rootParts.length) await mkdirRoot();
      let res = await put();
      if (res.status === 409 || res.status === 404) { // нет родительской папки
        await mkdirParts(parts.slice(0, -1));
        res = await put();
      }
      if (!okStatus(res.status)) throw new DavError(`Не удалось записать файл (код ${res.status}).`, res.status);
      for (let i = 1; i < parts.length; i += 1) known.add(parts.slice(0, i).join('/'));
    },

    async remove(rel) {
      const parts = segs(rel);
      const res = await send('DELETE', parts);
      if (res.status === 404) return;
      if (!okStatus(res.status)) throw new DavError(`Не удалось удалить (код ${res.status}).`, res.status);
    },

    async mkdir(rel) {
      const parts = segs(rel);
      if (!parts.length) return;
      if (rootParts.length) await mkdirRoot();
      await mkdirParts(parts);
    },
  };
}

/** Папки сервера для выбора: [{ name, path }] внутри path (путь от адреса сервера). */
async function browseFolders({ url, user, pass, path: at = '', request }) {
  const dav = createWebDav({ url, user, pass, root: at, request });
  const items = await dav.list('');
  const base = segs(at);
  return items
    .filter((x) => x.dir && !x.name.startsWith('.'))
    .map((x) => ({ name: x.name, path: `/${[...base, x.name].join('/')}` }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

/** Подсказки по адресам популярных сервисов: показываются в форме подключения. */
const PRESETS = [
  { id: 'yandex', name: 'Яндекс Диск', url: 'https://webdav.yandex.ru', hint: 'Логин — ваша почта на Яндексе. Пароль — не от почты, а пароль приложения: id.yandex.ru → Безопасность → Пароли приложений → «Файлы WebDAV».' },
  { id: 'mailru', name: 'Облако Mail.ru', url: 'https://webdav.cloud.mail.ru', hint: 'Логин — ваша почта. Пароль — пароль для внешнего приложения: Настройки аккаунта → Безопасность → Пароли для внешних приложений.' },
  { id: 'nextcloud', name: 'Nextcloud / ownCloud', url: '', hint: 'Адрес — из Настройки → WebDAV в самом Nextcloud, он вида https://сервер/remote.php/dav/files/ИМЯ. Пароль лучше создать отдельный: Настройки → Безопасность → «Создать пароль приложения».' },
  { id: 'other', name: 'Другой сервер WebDAV', url: '', hint: 'Адрес, логин и пароль вам даёт сервис или администратор сервера.' },
];

module.exports = { createWebDav, browseFolders, parseMultistatus, normalizeUrl, isHomeHost, toBase64, DavError, PRESETS };
