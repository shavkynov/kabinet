'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createYandexDisk } = require('../src/yandex-disk');
const en = require('../src/i18n-sync-en');
const message = 'Яндекс Диск временно занят. Подождите немного и повторите действие.';
const pass = JSON.stringify({ kind: 'kabinet-yandex-oauth', accessToken: 'fixture-token', expiresAt: 10000000000000 });
const response = (status, data) => ({ status, headers: {}, body: new TextEncoder().encode(JSON.stringify(data || {})) });
function setup(request, root = '/Project') {
  const calls = [], sleeps = [];
  const disk = createYandexDisk({ pass, root, request: async (r) => { calls.push(r); return request(r, calls.length); }, sleep: async (ms) => { sleeps.push(ms); } });
  return { disk, calls, sleeps };
}
const isBusy = (error) => error.status === 423 && error.message === message && !error.message.includes('fixture-token');
for (const [operation, args] of [
  ['check', []], ['list', ['']], ['read', ['chapter.md']], ['ensureRoot', []],
  ['mkdir', ['Chapters']], ['write', ['chapter.md', new Uint8Array([1])]], ['remove', ['chapter.md']],
]) {
  test(`423 from ${operation} is a clear error, not success or an implicit retry`, async () => {
    const x = setup(() => response(423, { message: 'fixture-token' }));
    await assert.rejects(x.disk[operation](...args), isBusy);
    assert.equal(x.calls.length, 1);
    assert.equal(x.sleeps.length, 0);
  });
}
for (const method of ['GET', 'PUT']) {
  test(`423 during ${method} file transfer is not retried or acknowledged`, async () => {
    const x = setup((r) => new URL(r.url).hostname === 'cloud-api.yandex.net'
      ? response(200, { href: 'https://storage.yandex.net/file' }) : response(423), '');
    await assert.rejects(method === 'GET' ? x.disk.read('chapter.md') : x.disk.write('chapter.md', new Uint8Array([1])), isBusy);
    assert.equal(x.calls.length, 2);
    assert.equal(x.calls[1].method, method);
    assert.equal(x.calls[1].headers.Authorization, undefined);
    assert.equal(x.sleeps.length, 0);
  });
}
test('failed mkdir is not cached and a later explicit attempt can succeed', async () => {
  const x = setup((_r, n) => response(n === 1 ? 423 : 201));
  await assert.rejects(x.disk.ensureRoot(), isBusy);
  assert.equal(x.calls.length, 1);
  await x.disk.ensureRoot();
  assert.equal(x.calls.length, 2);
});
test('423 message has an English translation without promising an automatic retry', () => {
  assert.equal(en[message], 'Yandex Disk is temporarily busy. Wait a little and try again.');
});
