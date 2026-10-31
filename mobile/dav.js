// Сетевая папка по WebDAV на Android: мастер подключения (сервис → вход → папка) и адаптер для src/folder.js.
// Запросы выполняет плагин Dav (OkHttp, android-src/DavPlugin.java). Входы хранятся в памяти приложения
// (localStorage окна), в файлы проекта и в синхронизируемую папку они не попадают.

import { registerPlugin } from '@capacitor/core';
import { chooseBox, formBox, toast } from './ui.js';
import i18n from '../src/i18n.js';
import webdav from '../src/webdav.js';

const Dav = registerPlugin('Dav');
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

const davOf = (acc, root) => webdav.createWebDav({ url: acc.url, user: acc.user, pass: acc.pass, root: root == null ? acc.root : root, request });

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
  if (map[uri]) { delete map[uri]; save(map); }
}

const newId = () => `dav:${[...crypto.getRandomValues(new Uint8Array(6))].map((x) => x.toString(16).padStart(2, '0')).join('')}`;

/** Шаг «вход»: форма адрес/логин/пароль. Возвращает { url, user, pass, preset } или null. */
async function askLogin(preset) {
  const needUrl = !preset.url;
  const res = await formBox({
    title: t(preset.name),
    hint: t(preset.hint),
    fields: [
      ...(needUrl ? [{ key: 'url', label: t('Адрес сервера'), type: 'url', placeholder: 'https://…' }] : []),
      { key: 'user', label: t('Логин'), type: 'text' },
      { key: 'pass', label: t('Пароль приложения'), type: 'password' },
    ],
    submit: t('Войти'),
    cancel: t('Отмена'),
    onSubmit: async (v) => {
      if (!v.user || !v.pass) return t('Введите логин и пароль.');
      try {
        const url = webdav.normalizeUrl(needUrl ? v.url : preset.url);
        await davOf({ url, user: v.user, pass: v.pass, root: '' }).check();
      } catch (e) {
        const msg = String((e && e.message) || e);
        return msg;
      }
      return null;
    },
  });
  if (!res) return null;
  return { url: webdav.normalizeUrl(needUrl ? res.url : preset.url), user: res.user, pass: res.pass, preset: preset.id, label: preset.name };
}

/** Просмотр папок сервера. Возвращает путь выбранной папки или null. */
async function pickFolder(acc, start) {
  let cur = start || '/';
  for (;;) {
    let folders = [];
    try {
      folders = await webdav.browseFolders({ url: acc.url, user: acc.user, pass: acc.pass, path: cur, request });
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
  const options = logins.map((a) => ({ label: `${a.label || a.url}: ${a.user}`, value: { saved: a } }));
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
    try { if ((await webdav.browseFolders({ ...acc, path: '/Кабинет', request })).length) start = '/Кабинет'; } catch { /* такой папки нет */ }
    root = await pickFolder(acc, start);
    if (!root) return null;
  }

  const id = newId();
  const map = load();
  map[id] = { url: acc.url, user: acc.user, pass: acc.pass, preset: acc.preset, label: acc.label, root };
  save(map);
  return { uri: id, name: `${acc.label || acc.url}: ${root}` };
}
