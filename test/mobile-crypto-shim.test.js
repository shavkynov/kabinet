'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

// Загружает файл так, как его увидит WebView: без Node-модулей, только с тем, что выдано явно.
function load(file, deps = {}) {
  const module = { exports: {} };
  const sandbox = {
    module, exports: module.exports, URL, URLSearchParams, TextEncoder, TextDecoder, Buffer, btoa, atob, console,
    crypto: nodeCrypto.webcrypto,
    require: (id) => {
      if (Object.prototype.hasOwnProperty.call(deps, id)) return deps[id];
      throw new Error(`Модуль недоступен в приложении для Android: ${id}`);
    },
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  return module.exports;
}

const shim = load(path.join(root, 'mobile', 'shim', 'crypto.js'));
const config = JSON.parse(read('src', 'yandex-oauth-config.json'));

// Повторяемые «случайные» данные, чтобы сбой воспроизводился.
function bytesOf(length, seed = 1) {
  const out = new Uint8Array(length);
  let x = seed >>> 0;
  for (let i = 0; i < length; i += 1) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; out[i] = x >>> 24; }
  return out;
}

test('shim hashes equal Node for MD5, SHA-1 and SHA-256 around block boundaries', () => {
  const lengths = [...Array.from({ length: 200 }, (_, i) => i), 255, 256, 257, 1000, 4096, 65536, 100003];
  for (const algo of ['md5', 'sha1', 'sha256']) {
    for (const length of lengths) {
      const data = bytesOf(length, length + 7);
      const expected = nodeCrypto.createHash(algo).update(data);
      const actual = shim.createHash(algo).update(data);
      assert.equal(actual.digest('hex'), expected.digest('hex'), `${algo} ${length}`);
    }
  }
});

test('shim digest encodings and chunked input match Node', () => {
  const data = bytesOf(1234, 99);
  for (const algo of ['md5', 'sha1', 'sha256']) {
    for (const enc of ['hex', 'base64', 'base64url']) {
      const expected = nodeCrypto.createHash(algo).update(data).digest(enc);
      const actual = shim.createHash(algo).update(data.subarray(0, 500)).update(data.subarray(500)).digest(enc);
      assert.equal(actual, expected, `${algo} ${enc}`);
    }
    const raw = shim.createHash(algo).update(data).digest();
    assert.equal(Buffer.compare(Buffer.from(raw), nodeCrypto.createHash(algo).update(data).digest()), 0);
  }
  assert.equal(shim.createHash('sha256').update('Привет, мир — «кабинет»').digest('hex'),
    nodeCrypto.createHash('sha256').update('Привет, мир — «кабинет»').digest('hex'));
  assert.equal(shim.createHash('sha256').update('abc').digest('hex'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(shim.createHash('SHA-256').update('abc').digest('hex'), shim.createHash('sha256').update('abc').digest('hex'));
});

test('shim rejects unknown algorithms and encodings', () => {
  assert.throws(() => shim.createHash('sha512'));
  assert.throws(() => shim.createHash('sha256').update('x').digest('latin1'));
});

test('shim timingSafeEqual and randomBytes behave like Node', () => {
  const a = Buffer.from('same-value'), b = Buffer.from('same-value'), c = Buffer.from('same-valuf');
  assert.equal(shim.timingSafeEqual(a, b), true);
  assert.equal(shim.timingSafeEqual(a, c), false);
  assert.throws(() => shim.timingSafeEqual(a, Buffer.from('short')), { name: 'RangeError' });
  const r1 = shim.randomBytes(32), r2 = shim.randomBytes(32);
  assert.equal(r1.length, 32);
  assert.notEqual(Buffer.from(r1).toString('hex'), Buffer.from(r2).toString('hex'));
});

test('shared Yandex modules do not import Node-only modules', () => {
  for (const file of ['yandex-oauth.js', 'yandex-disk.js']) {
    assert.doesNotMatch(read('src', file), /require\(\s*['"]node:/, file);
  }
});

test('PKCE sign-in runs without Node modules and its challenge matches real SHA-256', async () => {
  const { createYandexOAuth } = load(path.join(root, 'src', 'yandex-oauth.js'), { crypto: shim, './yandex-oauth-config.json': config });
  const calls = [];
  const flow = createYandexOAuth({
    request: async (r) => {
      calls.push(r);
      return { status: 200, body: new TextEncoder().encode(JSON.stringify({ access_token: 'fixture', token_type: 'bearer', expires_in: 3600, refresh_token: 'refresh-fixture' })) };
    },
  });
  const start = new URL(flow.begin());
  const state = start.searchParams.get('state');
  assert.match(state, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(start.searchParams.get('code_challenge_method'), 'S256');
  const token = await flow.complete(`${config.callbackUri}?${new URLSearchParams({ state, code: '1234567' })}`);
  assert.equal(token.accessToken, 'fixture');
  assert.equal(token.refreshToken, 'refresh-fixture');
  const form = new URLSearchParams(new TextDecoder().decode(calls[0].body));
  const verifier = form.get('code_verifier');
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(start.searchParams.get('code_challenge'), nodeCrypto.createHash('sha256').update(verifier).digest('base64url'));
  assert.equal(form.has('client_secret'), false);
});

test('PKCE rejects a foreign state when compared with the Android shim', async () => {
  const { createYandexOAuth } = load(path.join(root, 'src', 'yandex-oauth.js'), { crypto: shim, './yandex-oauth-config.json': config });
  let exchanged = 0;
  const flow = createYandexOAuth({ request: async () => { exchanged += 1; return { status: 500, body: new Uint8Array() }; } });
  const start = new URL(flow.begin());
  const real = start.searchParams.get('state');
  const forged = `${real.slice(0, -1)}${real.endsWith('A') ? 'B' : 'A'}`;
  await assert.rejects(flow.complete(`${config.callbackUri}?${new URLSearchParams({ state: forged, code: '1234567' })}`));
  assert.equal(exchanged, 0);
});

test('Yandex Disk upload verification uses the shim MD5 across many blocks', async () => {
  const { createYandexDisk } = load(path.join(root, 'src', 'yandex-disk.js'), { crypto: shim });
  const pass = JSON.stringify({ kind: 'kabinet-yandex-oauth', accessToken: 'fixture-token', expiresAt: Date.now() + 3600000 });
  const json = (status, data) => ({ status, headers: {}, body: new TextEncoder().encode(JSON.stringify(data || {})) });
  const payload = bytesOf(300000, 5);
  const md5 = nodeCrypto.createHash('md5').update(payload).digest('hex');
  let uploaded = null;
  const disk = createYandexDisk({
    pass, root: '/Project', sleep: async () => {},
    request: async (r) => {
      const u = new URL(r.url);
      if (u.hostname === 'uploader.disk.yandex.net') { uploaded = r.body; return json(201); }
      if (r.method === 'PUT') return json(201);
      if (u.pathname.endsWith('/upload')) return json(200, { href: 'https://uploader.disk.yandex.net/upload' });
      return json(200, { type: 'file', md5, size: payload.length });
    },
  });
  await disk.write('Chapters/1.md', payload);
  assert.equal(uploaded.length, payload.length);
  const wrong = createYandexDisk({
    pass, root: '/Project', sleep: async () => {},
    request: async (r) => {
      const u = new URL(r.url);
      if (u.hostname === 'uploader.disk.yandex.net' || r.method === 'PUT') return json(201);
      if (u.pathname.endsWith('/upload')) return json(200, { href: 'https://uploader.disk.yandex.net/upload' });
      return json(200, { type: 'file', md5: '0'.repeat(32), size: payload.length });
    },
  });
  await assert.rejects(wrong.write('Chapters/1.md', payload), /не подтвердил/);
});
