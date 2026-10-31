// Сетевая папка на Android: мастер подключения (сервис → вход → папка) и адаптер для src/folder.js.
// Запросы выполняет плагин Dav (OkHttp, android-src/DavPlugin.java). Яндекс Диск подключается через браузер (OAuth, как на
// компьютере): токен лежит в защищённом хранилище телефона (плагин Secrets, Android Keystore), а в localStorage окна —
// только служебные сведения. Остальные сохранённые входы по паролю продолжают работать; в файлы проекта и в
// синхронизируемую папку входы не попадают.

import { registerPlugin } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { chooseBox, formBox, toast } from './ui.js';
import { waitBox } from './wait-box.js';
import i18n from '../src/i18n.js';
import webdav from '../src/webdav.js';
import yandex from './yandex-auth.js';

const Dav = registerPlugin('Dav');
const Secrets = registerPlugin('Secrets');
const t = i18n.t;
const KEY = 'kabinet.dav';

function fromB64(b64) {
  const bin = atob(b64 || '');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
function toB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Один запрос через плагин; формат ответа — как ждёт src/webdav.js. */
async function request({ method, url, headers, body }) {
  const res = await Dav.request({ method, url, headers: headers || {}, body: body && body.length ? toB64(body) : undefined });
  return { status: res.status, headers: res.headers || {}, body: fromB64(res.body) };
}

function load() {
  try { const raw = JSON.parse(localStorage.getItem(KEY) || '{}'); return raw && typeof raw === 'object' ? raw : {}; } catch { return {}; }
}
function save(map) {
  try { localStorage.setItem(KEY, JSON.stringify(map)); } catch { /* память окна недоступна */ }
}

// ---------- токен Яндекса в защищённом хранилище ----------
async function getSecret(key) {
  try {
    const res = await Secrets.get({ key });
    return res && typeof res.value === 'string' ? res.value : null;
  } catch { return null; }
}
const removeSecret = (key) => Secrets.remove({ key }).catch(() => {});
const isOAuth = (acc) => !!acc && yandex.isOAuthUser(acc.user);
const say = (e) => { const m = String((e && e.message) || e); return i18n.tdom(m) || m; };

const davOf = (acc, root) => {
  const at = root == null ? acc.root : root;
  if (isOAuth(acc)) return yandex.createLazyDisk({ user: acc.user, root: at, getSecret, request });
  return webdav.createWebDav({ url: acc.url, user: acc.user, pass: acc.pass, root: at, request });
};

/** Папки сервера для выбора: у входа через браузер свой способ, у остальных — WebDAV. */
const browse = (acc, at) => (isOAuth(acc)
  ? yandex.browseOAuthFolders({ user: acc.user, path: at || '', getSecret, request })
  : webdav.browseFolders({ url: acc.url, user: acc.user, pass: acc.pass, path: at || '', request }));

/** Адаптер для проекта, связанного с сетевой папкой. uri — «dav:…», как в folder-links.json. */
export function createDavAdapter(uri) {
  const acc = load()[uri];
  if (!acc) {
    const fail = async () => { throw new Error(t('Данные для входа в сетевую папку не найдены. Подключите папку заново.')); };
    return { list: fail, read: fail, write: fail, remove: fail, mkdir: fail };
  }
  return davOf(acc);
}

export const isDavUri = (uri) => typeof uri === 'string' && uri.startsWith('dav:');
export function forgetDav(uri) {
  const map = load();
  const acc = map[uri];
  if (!acc) return;
  delete map[uri];
  save(map);
  // Токен убираем из защищённого хранилища, когда им больше никто не пользуется.
  if (isOAuth(acc) && !Object.values(map).some((x) => x && x.user === acc.user)) removeSecret(acc.user);
}

const newId = () => `dav:${[...crypto.getRandomValues(new Uint8Array(6))].map((x) => x.toString(16).padStart(2, '0')).join('')}`;

/**
 * Шаг «вход» для Яндекса: страница Яндекса открывается в браузере, пароль вводится только там. После подтверждения
 * браузер возвращает в Кабинет (kabinet://oauth/yandex), токен кладётся в защищённое хранилище.
 * Возвращает { url, user, pass, preset, label } (пароля нет) или null.
 */
async function askLogin(preset) {
  const wait = waitBox({
    title: t('Подключение Яндекс Диска'),
    message: t('Завершите вход в браузере. Затем нажмите «Вернуться в Кабинет».'),
    cancel: t('Отмена'),
  });
  const run = yandex.startSignIn({
    request,
    open: (url) => Browser.open({ url }),
    close: () => Browser.close(),
    listen: (cb) => {
      const handle = App.addListener('appUrlOpen', (event) => cb(event && event.url));
      return () => { Promise.resolve(handle).then((h) => h && h.remove && h.remove()).catch(() => {}); };
    },
  });
  let cancelled = false;
  wait.dismissed.then((byUser) => { if (byUser) { cancelled = true; run.cancel(); } });
  let token;
  try {
    token = await run.promise;
  } catch (e) {
    wait.close();
    if (!cancelled) toast(say(e));
    return null;
  }
  wait.close();
  const user = yandex.newUser();
  try {
    await Secrets.set({ key: user, value: yandex.credentialsOf(token) });
  } catch {
    toast(t('Защищённое хранилище системы недоступно. Подключение Яндекса не сохранено.'));
    return null;
  }
  const acc = { url: preset.url, user, pass: '', preset: preset.id, label: preset.name };
  try {
    await davOf(acc, '').check();
  } catch (e) {
    await removeSecret(user);
    toast(say(e));
    return null;
  }
  return acc;
}

/** Просмотр папок сервера. Возвращает путь выбранной папки или null. */
async function pickFolder(acc, start) {
  let cur = start || '/';
  for (;;) {
    let folders = [];
    try {
      folders = await browse(acc, cur);
    } catch (e) {
      toast(String((e && e.message) || e));
      return null;
    }
    const up = cur.split('/').filter(Boolean).slice(0, -1);
    const options = [{ label: `✓ ${t('Выбрать эту папку')}`, value: { act: 'pick' } }];
    options.push({ label: `＋ ${t('Создать папку…')}`, value: { act: 'new' } });
    if (cur !== '/') options.push({ label: `↑ ${t('На уровень выше')}`, value: { act: 'up', path: `/${up.join('/')}` } });
    for (const f of folders) options.push({ label: `📁 ${f.name}`, value: { act: 'in', path: f.path } });
    const pick = await chooseBox({
      title: t('Выберите папку'),
      message: t('Сейчас: {0}\nНажмите на папку, чтобы открыть её.', cur),
      options,
      cancel: t('Отмена'),
    });
    if (!pick) return null;
    if (pick.act === 'pick') return cur;
    if (pick.act === 'up' || pick.act === 'in') { cur = pick.path; continue; }
    if (pick.act === 'new') {
      const made = await formBox({
        title: t('Новая папка'),
        fields: [{ key: 'name', label: t('Название'), value: 'Кабинет' }],
        submit: t('Создать'),
        cancel: t('Отмена'),
        onSubmit: async (v) => {
          if (!v.name || /[\\/:*?"<>|]/.test(v.name)) return t('Название не должно содержать символы \\ / : * ? " < > |');
          try { await davOf(acc, `${cur === '/' ? '' : cur}/${v.name}`).ensureRoot(); } catch (e) { return String((e && e.message) || e); }
          return null;
        },
      });
      if (made) cur = `${cur === '/' ? '' : cur}/${made.name}`;
    }
  }
}

/**
 * Мастер подключения. ctx: { mode: 'link' | 'open', name } — связать открытый проект или открыть проект из папки.
 * Возвращает { uri, name } для backend.js или null, если пользователь отказался.
 */
export async function chooseDavFolder(ctx = {}) {
  const saved = load();
  const logins = [];
  const seen = new Set();
  for (const acc of Object.values(saved)) {
    // Остальные сохранённые связи остаются рабочими, но не предлагаются для новых подключений.
    if (!acc || typeof acc !== 'object') continue;
    let isYandex = acc.preset === 'yandex';
    if (!isYandex) {
      try { isYandex = webdav.normalizeUrl(acc.url) === 'https://webdav.yandex.ru'; } catch { /* некорректный адрес */ }
    }
    if (!isYandex) continue;
    const k = `${acc.url}|${acc.user}`;
    if (seen.has(k)) continue;
    seen.add(k);
    logins.push(acc);
  }
  const options = logins.map((a, i) => ({
    label: isOAuth(a) ? `${t('Яндекс Диск — сохранённое подключение')} ${i + 1}` : `${a.label || a.url}: ${a.user}`,
    value: { saved: a },
  }));
  for (const p of webdav.PRESETS) {
    const available = p.id === 'yandex';
    options.push({
      label: available
        ? (logins.length ? `+ ${t(p.name)}` : t(p.name))
        : `${t(p.name)} — ${t('Временно недоступно')}`,
      value: { preset: p },
      disabled: !available,
    });
  }
  const first = await chooseBox({
    title: t('Сетевая папка'),
    message: t('Выберите сервис. Сейчас доступен только Яндекс Диск.'),
    options,
    cancel: t('Отмена'),
  });
  if (!first) return null;

  let acc = first.saved || null;
  if (!acc) {
    if (!first.preset || first.preset.id !== 'yandex') return null;
    acc = await askLogin(first.preset);
    if (!acc) return null;
  } else if (isOAuth(acc)) {
    // Сохранённое подключение: убеждаемся, что токен ещё в хранилище и действителен.
    try { await davOf(acc, '').check(); } catch (e) { toast(say(e)); return null; }
  }

  let root = null;
  if (ctx.mode === 'link') {
    const auto = `/Кабинет/${String(ctx.name || 'Проект').replace(/[\\/:*?"<>|]/g, '-')}`;
    const how = await chooseBox({
      title: t('Куда сохранить проект?'),
      message: t('Рекомендуем папку «{0}» на вашем диске. Она создастся сама.', auto.slice(1)),
      options: [
        { label: t('Создать «{0}» (рекомендуется)', auto.slice(1)), value: 'auto' },
        { label: t('Выбрать другую папку…'), value: 'pick' },
      ],
      cancel: t('Отмена'),
    });
    if (!how) return null;
    if (how === 'auto') {
      try { await davOf(acc, auto).ensureRoot(); } catch (e) { toast(String((e && e.message) || e)); return null; }
      root = auto;
    }
  }
  if (root == null) {
    let start = '/';
    try { if ((await browse(acc, '/Кабинет')).length) start = '/Кабинет'; } catch { /* такой папки нет */ }
    root = await pickFolder(acc, start);
    if (!root) return null;
  }

  const id = newId();
  const map = load();
  map[id] = { url: acc.url, user: acc.user, pass: acc.pass, preset: acc.preset, label: acc.label, root };
  save(map);
  return { uri: id, name: `${acc.label || acc.url}: ${root}` };
}
