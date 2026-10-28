'use strict';
const test = require('node:test');
const assert = require('node:assert');
const lc = require('../src/langcheck');

test('адрес сервера нормализуется', () => {
  assert.equal(lc.normalizeServer(''), lc.PUBLIC_SERVER);
  assert.equal(lc.normalizeServer('localhost:8081'), 'http://localhost:8081/v2');
  assert.equal(lc.normalizeServer('https://x.org/v2/'), 'https://x.org/v2');
  assert.ok(lc.isLocalServer('localhost:8081'));
  assert.ok(!lc.isLocalServer(''));
});

test('куски: позиции частей совпадают с текстом', () => {
  const paras = ['Первый абзац.', '', 'Второй абзац, подлиннее.', 'Третий.'];
  const chunks = lc.buildChunks(paras, 40);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) {
    for (const p of c.parts) {
      assert.equal(c.text.slice(p.off, p.off + p.len), paras[p.para].slice(p.start, p.start + p.len));
    }
  }
});

test('длинный абзац режется по предложениям', () => {
  const long = 'Слово слово слово. '.repeat(50).trim();
  const chunks = lc.buildChunks([long], 200);
  assert.ok(chunks.length > 3);
  const joined = chunks.flatMap((c) => c.parts.map((p) => long.slice(p.start, p.start + p.len))).join('');
  assert.equal(joined, long);
});

test('замечания переносятся в позиции абзацев', () => {
  const chunks = lc.buildChunks(['Привет мир.', 'Это тесть.'], 100);
  const text = chunks[0].text;
  const off = text.indexOf('тесть');
  const res = lc.mapMatches(chunks[0], [{
    offset: off, length: 5, message: 'Ошибка', rule: { id: 'MORFOLOGIK_RULE_RU_RU', category: { id: 'TYPOS' } },
    replacements: [{ value: 'тест' }, { value: 'тесть' }],
  }]);
  assert.equal(res.length, 1);
  assert.equal(res[0].para, 1);
  assert.equal(res[0].offset, 4);
  assert.equal(res[0].text, 'тесть');
  assert.equal(res[0].kind, 'spelling');
  assert.deepEqual(res[0].replacements, ['тест']);
});

test('виды замечаний', () => {
  assert.equal(lc.kindOf({ rule: { id: 'X', category: { id: 'TYPOGRAPHY' } } }), 'typography');
  assert.equal(lc.kindOf({ rule: { id: 'RU_COMMA', category: { id: 'PUNCTUATION' } } }), 'punctuation');
  assert.equal(lc.kindOf({ rule: { id: 'X', category: { id: 'GRAMMAR' } } }), 'grammar');
});

test('проверка целиком с подставным сервером', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: init.body });
    const text = new URLSearchParams(init.body).get('text');
    const i = text.indexOf('тесть');
    return { ok: true, status: 200, json: async () => ({ matches: i < 0 ? [] : [{ offset: i, length: 5, message: 'm', rule: { id: 'R', category: { id: 'TYPOS' } }, replacements: [{ value: 'тест' }] }] }) };
  };
  const res = await lc.checkParagraphs(['Это тесть.', 'Всё хорошо.'], { server: 'localhost:8081', lang: 'ru', fetchImpl });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://localhost:8081/v2/check');
  assert.match(calls[0].body, /language=ru-RU/);
  assert.equal(res.length, 1);
  assert.equal(res[0].id, 1);
  const none = await lc.checkParagraphs(['Это тесть.'], { server: 'localhost:8081', fetchImpl, words: ['тесть'] });
  assert.equal(none.length, 0);
  const off = await lc.checkParagraphs(['Это тесть.'], { server: 'localhost:8081', fetchImpl, disabledRules: ['R'] });
  assert.equal(off.length, 0);
});

test('ошибка сети объясняется по-русски', async () => {
  const fetchImpl = async () => { throw new Error('boom'); };
  await assert.rejects(lc.checkParagraphs(['текст'], { server: 'localhost:1', fetchImpl }), /Не удалось связаться/);
});

test('виды замечаний: список скрытых видов очищается и порядок известен', () => {
  assert.deepEqual(lc.CHECK_KINDS, ['spelling', 'punctuation', 'grammar', 'style', 'typography', 'other']);
  assert.deepEqual(lc.cleanKinds(['style', 'spelling', 'style', 'bogus', 5, null]), ['spelling', 'style']);
  assert.deepEqual(lc.cleanKinds(null), []);
  assert.deepEqual(lc.cleanKinds('style'), []);
  assert.deepEqual(lc.cleanKinds([]), []);
});

test('фильтр по видам: скрытый вид убирает свои замечания, остальные и порядок не задеты', async () => {
  const cats = { тесть: 'TYPOS', запятая: 'PUNCTUATION', очень: 'STYLE', 'так...': 'TYPOGRAPHY', были: 'GRAMMAR' };
  const fetchImpl = async (url, init) => {
    const text = new URLSearchParams(init.body).get('text');
    const matches = Object.entries(cats).map(([w, c]) => ({ w, c, i: text.indexOf(w) })).filter((x) => x.i >= 0)
      .map((x) => ({ offset: x.i, length: x.w.length, message: x.w, rule: { id: `R_${x.c}`, category: { id: x.c } }, replacements: [] }));
    return { ok: true, status: 200, json: async () => ({ matches }) };
  };
  const paras = ['Это тесть, запятая очень так... были.'];
  const run = (extra = {}) => lc.checkParagraphs(paras, { server: 'localhost:8081', fetchImpl, ...extra });
  const all = await run();
  assert.deepEqual(all.map((x) => x.kind), ['spelling', 'punctuation', 'style', 'typography', 'grammar']);
  // по умолчанию виды не скрываются (настройка не задана или пустая)
  assert.equal((await run({ hiddenKinds: [] })).length, 5);
  const noStyle = await run({ hiddenKinds: ['style'] });
  assert.deepEqual(noStyle.map((x) => x.kind), ['spelling', 'punctuation', 'typography', 'grammar']);
  assert.deepEqual(noStyle.map((x) => x.id), [1, 2, 3, 4], 'номера идут подряд без пропусков');
  const two = await run({ hiddenKinds: ['spelling', 'typography', 'style'] });
  assert.deepEqual(two.map((x) => x.kind), ['punctuation', 'grammar']);
  assert.equal((await run({ hiddenKinds: lc.CHECK_KINDS })).length, 0, 'все виды скрыты');
  // вместе с отключёнными правилами и словарём
  const mixed = await run({ hiddenKinds: ['grammar'], disabledRules: ['R_STYLE'], words: ['тесть'] });
  assert.deepEqual(mixed.map((x) => x.kind), ['punctuation', 'typography']);
});

