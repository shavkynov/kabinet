'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yandex = require('../mobile/yandex-auth');
const config = require('../src/yandex-oauth-config.json');
const { createYandexDisk } = require('../src/yandex-disk');

const root = path.join(__dirname, '..');
const tokenBody = (extra = {}) => new TextEncoder().encode(JSON.stringify({ access_token: 'fixture-token', token_type: 'bearer', expires_in: 3600, refresh_token: 'refresh-fixture', ...extra }));
const tick = () => new Promise((resolve) => setImmediate(resolve));

// Подставные «браузер», приём адресов и сеть. fire(...) имитирует открытие приложения по ссылке kabinet://…
function setup(options = {}) {
  const log = { opened: [], closed: 0, unlistened: 0, requests: [] };
  let handler = null;
  const timers = [];
  const deps = {
    open: async (url) => { log.opened.push(url); if (options.openError) throw new Error('browser'); },
    close: async () => { log.closed += 1; },
    listen: (cb) => { handler = cb; return () => { log.unlistened += 1; }; },
    request: options.request || (async (r) => { log.requests.push(r); return { status: 200, body: tokenBody() }; }),
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => {},
  };
  const run = yandex.startSignIn(deps);
  const stateOf = () => new URL(log.opened[0]).searchParams.get('state');
  const callback = (extra = {}) => `${config.callbackUri}?${new URLSearchParams({ state: stateOf(), code: '1234567', ...extra })}`;
  return { run, log, timers, fire: (raw) => handler(raw), callback };
}

test('successful sign-in returns the token, closes the browser tab and unsubscribes', async () => {
  const x = setup();
  await tick();
  assert.equal(x.log.opened.length, 1);
  assert.match(x.log.opened[0], /^https:\/\/oauth\.yandex\.ru\/authorize\?/);
  x.fire(x.callback());
  const token = await x.run.promise;
  assert.equal(token.accessToken, 'fixture-token');
  assert.equal(token.refreshToken, 'refresh-fixture');
  assert.equal(x.log.requests.length, 1);
  assert.equal(x.log.closed, 1);
  assert.equal(x.log.unlistened, 1);
});

test('foreign addresses and wrong state are ignored until the real answer arrives', async () => {
  const x = setup();
  await tick();
  x.fire(undefined);
  x.fire('https://example.org/?state=x');
  x.fire('kabinet://other/path?state=x&code=1234567');
  x.fire(`${config.callbackUri}?state=forged&code=1234567`);
  await tick();
  assert.equal(x.log.requests.length, 0);
  x.fire(x.callback());
  assert.equal((await x.run.promise).accessToken, 'fixture-token');
  assert.equal(x.log.requests.length, 1);
});

test('a repeated callback during the exchange neither breaks it nor sends a second request', async () => {
  let release;
  const calls = [];
  const x = setup({ request: (r) => new Promise((resolve) => { calls.push(r); release = () => resolve({ status: 200, body: tokenBody() }); }) });
  await tick();
  x.fire(x.callback());
  x.fire(x.callback());
  await tick();
  assert.equal(calls.length, 1);
  release();
  assert.equal((await x.run.promise).accessToken, 'fixture-token');
});

test('cancel rejects with a clear message and later callbacks do nothing', async () => {
  const x = setup();
  await tick();
  x.run.cancel();
  await assert.rejects(x.run.promise, /Подключение отменено/);
  x.fire(x.callback());
  await tick();
  assert.equal(x.log.requests.length, 0);
  assert.equal(x.log.unlistened, 1);
});

test('timeout, browser failure and access denial end the attempt with readable errors', async () => {
  const slow = setup();
  await tick();
  assert.equal(slow.timers[0].ms, yandex.SIGN_IN_MS);
  slow.timers[0].fn();
  await assert.rejects(slow.run.promise, /Время входа истекло/);

  const broken = setup({ openError: true });
  await assert.rejects(broken.run.promise, /Не удалось открыть браузер/);

  const denied = setup();
  await tick();
  const url = new URL(denied.callback());
  url.searchParams.delete('code');
  url.searchParams.set('error', 'access_denied');
  denied.fire(url.href);
  await assert.rejects(denied.run.promise, /Доступ не предоставлен/);
});

test('a provider failure is reported without leaking provider text', async () => {
  const x = setup({ request: async () => ({ status: 400, body: new TextEncoder().encode('{"error":"sensitive-fixture"}') }) });
  await tick();
  x.fire(x.callback());
  await assert.rejects(x.run.promise, (e) => /не выдал токен/.test(e.message) && !e.message.includes('sensitive-fixture'));
});

test('a stored token is read lazily, once, and failures say to reconnect', async () => {
  const user = yandex.newUser();
  assert.equal(yandex.isOAuthUser(user), true);
  const pass = yandex.credentialsOf({ accessToken: 'fixture-token', refreshToken: null, expiresAt: Date.now() + 3600000, tokenType: 'bearer' });
  assert.doesNotThrow(() => createYandexDisk({ pass, request: async () => ({ status: 200, body: new Uint8Array() }) }));
  let reads = 0;
  const requests = [];
  const disk = yandex.createLazyDisk({
    user, root: '/Кабинет',
    getSecret: async (key) => { reads += 1; assert.equal(key, user); return pass; },
    request: async (r) => { requests.push(r); return { status: 200, body: new TextEncoder().encode(JSON.stringify({ type: 'dir' })) }; },
  });
  assert.equal(reads, 0);
  assert.equal(await disk.check(), true);
  await disk.check();
  assert.equal(reads, 1);
  assert.equal(requests[0].headers.Authorization, 'OAuth fixture-token');
  const missing = yandex.createLazyDisk({ user, getSecret: async () => null, request: async () => { throw new Error('no request expected'); } });
  await assert.rejects(missing.list(''), /Подключите Яндекс Диск заново/);
});

test('folder browsing keeps directories only, hides dot-folders and sorts in Russian', async () => {
  const user = yandex.newUser();
  const pass = yandex.credentialsOf({ accessToken: 'fixture-token', expiresAt: Date.now() + 3600000 });
  const items = [
    { name: 'Яблоки', type: 'dir' }, { name: 'Арбузы', type: 'dir' }, { name: '.скрытая', type: 'dir' }, { name: 'файл.md', type: 'file', size: 1 },
  ];
  const paths = [];
  const folders = await yandex.browseOAuthFolders({
    user, path: '/Кабинет', getSecret: async () => pass,
    request: async (r) => { paths.push(new URL(r.url).searchParams.get('path')); return { status: 200, body: new TextEncoder().encode(JSON.stringify({ _embedded: { total: items.length, items } })) }; },
  });
  assert.deepEqual(folders, [{ name: 'Арбузы', path: '/Кабинет/Арбузы' }, { name: 'Яблоки', path: '/Кабинет/Яблоки' }]);
  assert.deepEqual(paths, ['disk:/Кабинет']);
});

test('every native plugin is registered in the page under the same name', () => {
  const names = fs.readdirSync(path.join(root, 'mobile', 'android-src'))
    .filter((f) => f.endsWith('.java'))
    .map((f) => /@CapacitorPlugin\s*\(\s*name\s*=\s*"([^"]+)"/.exec(fs.readFileSync(path.join(root, 'mobile', 'android-src', f), 'utf8')))
    .filter(Boolean).map((m) => m[1]);
  const pageCode = fs.readdirSync(path.join(root, 'mobile')).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(root, 'mobile', f), 'utf8')).join('\n');
  assert.ok(names.includes('Secrets'));
  for (const name of names) assert.match(pageCode, new RegExp(`registerPlugin\\(\\s*['"]${name}['"]`), `в окне не подключён плагин ${name}`);
});

test('Yandex Android sign-in uses the browser flow and no password form', () => {
  const dav = fs.readFileSync(path.join(root, 'mobile', 'dav.js'), 'utf8');
  assert.match(dav, /startSignIn/);
  assert.match(dav, /Secrets\.set/);
  assert.doesNotMatch(dav, /type:\s*'password'/);
});
