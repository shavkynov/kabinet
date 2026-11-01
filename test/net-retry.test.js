'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { retrying, withTimeout } = require('../src/net-retry');

const fast = { sleep: async () => {} };
const ok = (status, headers = {}) => ({ status, headers, body: new Uint8Array(0) });

test('сбой сети: запрос повторяется и проходит', async () => {
  let n = 0;
  const req = retrying(async () => { n += 1; if (n < 3) throw new Error('Unable to resolve host'); return ok(200); }, fast);
  assert.equal((await req({ method: 'GET', url: 'x' })).status, 200);
  assert.equal(n, 3);
});

test('постоянный сбой: после трёх попыток ошибка наружу', async () => {
  let n = 0;
  const req = retrying(async () => { n += 1; throw new Error('timeout'); }, fast);
  await assert.rejects(() => req({}), /timeout/);
  assert.equal(n, 3);
});

test('временные ответы (423, 429, 503) повторяются, постоянные (404, 401) нет', async () => {
  for (const [codes, calls, final] of [[[423, 423, 200], 3, 200], [[429, 200], 2, 200], [[503, 503, 503], 3, 503], [[404], 1, 404], [[401], 1, 401], [[409], 1, 409]]) {
    let i = 0;
    const req = retrying(async () => ok(codes[Math.min(i++, codes.length - 1)]), fast);
    assert.equal((await req({})).status, final);
    assert.equal(i, calls, `коды ${codes}`);
  }
});

test('Retry-After учитывается, но не дольше 20 секунд', async () => {
  const waits = [];
  let i = 0;
  const req = retrying(async () => (i++ < 2 ? ok(429, { 'retry-after': '120' }) : ok(200)), { sleep: async (ms) => { waits.push(ms); } });
  await req({});
  assert.deepEqual(waits, [20000, 20000]);
});

test('зависший запрос завершается по сроку, а не висит вечно', async () => {
  let n = 0;
  const never = () => new Promise(() => {});
  const req = retrying(() => { n += 1; return never(); }, { ...fast, timeoutMs: 20, graceMs: 0, attempts: 2 });
  const t0 = Date.now();
  await assert.rejects(() => req({ timeoutMs: 5 }), /не отвечает/);
  assert.equal(n, 2);
  assert.ok(Date.now() - t0 < 2000);
});

test('withTimeout пропускает быстрый результат', async () => {
  assert.equal(await withTimeout(Promise.resolve(7), 1000), 7);
});
