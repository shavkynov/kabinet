'use strict';
// Вход в Яндекс на Android и доступ к Диску по сохранённому токену. Здесь нет Capacitor и DOM, чтобы это можно было проверять в Node:
// открытие браузера, приём возврата kabinet://oauth/yandex и защищённое хранилище подставляет mobile/dav.js.

const crypto = require('crypto');
const { createYandexOAuth } = require('../src/yandex-oauth');
const { createYandexDisk, isOAuthUser, PREFIX } = require('../src/yandex-disk');
const config = require('../src/yandex-oauth-config.json');

const SIGN_IN_MS = 600000;

/** Идентификатор нового входа: oauth-yandex:<32 hex>. Он не секретный: по нему токен лежит в защищённом хранилище. */
const newUser = () => PREFIX + crypto.randomBytes(16).toString('hex');

/** Данные для Диска хранятся тем же JSON, что и на компьютере (kind: kabinet-yandex-oauth). */
const credentialsOf = (token) => JSON.stringify({ kind: 'kabinet-yandex-oauth', ...token });

/**
 * Вход через браузер. Зависимости:
 *   open(url)      открыть страницу Яндекса;  close() закрыть её после ответа (необязательно)
 *   listen(cb)     подписка на адреса, которыми открывается приложение; возвращает функцию отписки
 *   request(...)   сетевой запрос (на телефоне это плагин Dav)
 * Возвращает { promise (токен), cancel() }. Чужие ответы и повторные нажатия игнорируются, как и на компьютере.
 */
function startSignIn({ open, close, listen, request, makeOAuth = createYandexOAuth, timeoutMs = SIGN_IN_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const flow = makeOAuth({ request });
  let settled = false;
  let receiving = false;
  let unlisten = null;
  let timer = null;
  let end = () => {};
  const promise = new Promise((resolve, reject) => {
    end = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      if (unlisten) { try { unlisten(); } catch { /* подписка уже снята */ } }
      flow.cancel();
      if (close) { try { Promise.resolve(close()).catch(() => {}); } catch { /* вкладки браузера уже нет */ } }
      if (error) reject(error); else resolve(value);
    };
    let url;
    try { url = flow.begin(); } catch (e) { end(new Error(e.message)); return; }
    const state = new URL(url).searchParams.get('state');
    unlisten = listen((raw) => {
      if (settled || receiving || typeof raw !== 'string' || !raw.startsWith(config.callbackUri)) return;
      let u;
      try { u = new URL(raw); } catch { return; }
      if (u.searchParams.get('state') !== state) return; // чужой или старый ответ
      receiving = true;
      flow.complete(raw).then((token) => end(null, token), (e) => end(new Error(e.message)));
    });
    timer = setTimer(() => end(new Error('Время входа истекло. Повторите подключение.')), timeoutMs);
    Promise.resolve().then(() => open(url)).catch(() => end(new Error('Не удалось открыть браузер.')));
  });
  return { promise, cancel: () => end(new Error('Подключение отменено.')) };
}

/** Диск с токеном из защищённого хранилища: токен читается при первом обращении, а не при создании адаптера. */
function createLazyDisk({ user, root = '', getSecret, request, make = createYandexDisk }) {
  let inner = null;
  const disk = async () => {
    if (inner) return inner;
    const pass = await getSecret(user);
    if (!pass) throw new Error('Подключите Яндекс Диск заново.');
    inner = make({ pass, root, request });
    return inner;
  };
  const forward = (name) => async (...args) => (await disk())[name](...args);
  return { check: forward('check'), ensureRoot: forward('ensureRoot'), mkdir: forward('mkdir'), list: forward('list'), read: forward('read'), write: forward('write'), remove: forward('remove') };
}

/** Папки Диска для выбора: [{ name, path }] внутри path. Те же правила, что у компьютерной версии. */
async function browseOAuthFolders({ user, path: at = '', getSecret, request, make }) {
  const items = await createLazyDisk({ user, root: at, getSecret, request, make }).list('');
  const base = String(at).split('/').filter(Boolean);
  return items
    .filter((x) => x.dir && !x.name.startsWith('.'))
    .map((x) => ({ name: x.name, path: `/${[...base, x.name].join('/')}` }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

module.exports = { startSignIn, newUser, credentialsOf, createLazyDisk, browseOAuthFolders, isOAuthUser, PREFIX, SIGN_IN_MS };
