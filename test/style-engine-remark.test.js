'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeStructural } = require('../src/style-engine/structural');

function parse(text, rows) {
  let at = 0;
  const tokens = rows.map(([word, lemma, upos, feats, head, deprel], i) => {
    const start = text.indexOf(word, at);
    if (start < 0) throw new Error(`fixture token not found: ${word}`);
    at = start + word.length;
    return { id: i + 1, text: word, lemma, upos, feats, head, deprel, start, end: start + word.length, confidence: null };
  });
  return { schemaVersion: 1, parser: { name: 'synthetic-fixture', version: '1' }, sentences: [{ start: 0, end: text.length, text, tokens }] };
}

const remarkHits = (text, rows) => analyzeStructural(text, parse(text, rows), { remark: true }).remark;

function duplicateRows() {
  return [
    ['«', '«', 'PUNCT', {}, 4, 'punct'],
    ['Я', 'я', 'PRON', { Case: 'Nom' }, 4, 'nsubj'],
    ['не', 'не', 'PART', {}, 4, 'advmod'],
    ['пойду', 'пойти', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['»', '»', 'PUNCT', {}, 4, 'punct'],
    [',', ',', 'PUNCT', {}, 8, 'punct'],
    ['—', '—', 'PUNCT', {}, 8, 'punct'],
    ['сказал', 'сказать', 'VERB', { VerbForm: 'Fin' }, 4, 'parataxis'],
    ['он', 'он', 'PRON', { Case: 'Nom' }, 8, 'nsubj'],
    [',', ',', 'PUNCT', {}, 12, 'punct'],
    ['—', '—', 'PUNCT', {}, 12, 'punct'],
    ['сказал', 'сказать', 'VERB', { VerbForm: 'Fin' }, 9, 'parataxis'],
    ['он', 'он', 'PRON', { Case: 'Nom' }, 12, 'nsubj'],
    ['.', '.', 'PUNCT', {}, 4, 'punct'],
  ];
}

test('remark: две соседние минимальные атрибуции с одинаковым субъектом и глаголом', () => {
  const text = '«Я не пойду», — сказал он, — сказал он.';
  const found = remarkHits(text, duplicateRows());
  assert.equal(found.length, 1);
  assert.equal(found[0].fragment, 'сказал он, — сказал он');
  assert.equal(found[0].ruleId, 'remark.duplicate-attribution');
  assert.equal(found[0].confidence, 'low');
  assert.equal(found[0].fragment, text.slice(found[0].start, found[0].end));
});

test('remark: одна минимальная атрибуция не срабатывает', () => {
  const text = '«Я не пойду», — сказал он.';
  const rows = [
    ['«', '«', 'PUNCT', {}, 4, 'punct'],
    ['Я', 'я', 'PRON', { Case: 'Nom' }, 3, 'nsubj'],
    ['не', 'не', 'PART', {}, 3, 'advmod'],
    ['пойду', 'пойти', 'VERB', {}, 0, 'root'],
    ['»', '»', 'PUNCT', {}, 3, 'punct'],
    [',', ',', 'PUNCT', {}, 7, 'punct'],
    ['—', '—', 'PUNCT', {}, 7, 'punct'],
    ['сказал', 'сказать', 'VERB', { VerbForm: 'Fin' }, 3, 'parataxis'],
    ['он', 'он', 'PRON', { Case: 'Nom' }, 7, 'nsubj'],
    ['.', '.', 'PUNCT', {}, 3, 'punct'],
  ];
  assert.deepEqual(remarkHits(text, rows), []);
});

test('remark: интонационная/эмоциональная ремарка не является минимальной', () => {
  const text = '«Я не пойду», — сказал он тихо.';
  const rows = [
    ['«', '«', 'PUNCT', {}, 4, 'punct'],
    ['Я', 'я', 'PRON', { Case: 'Nom' }, 3, 'nsubj'],
    ['не', 'не', 'PART', {}, 3, 'advmod'],
    ['пойду', 'пойти', 'VERB', {}, 0, 'root'],
    ['»', '»', 'PUNCT', {}, 3, 'punct'],
    [',', ',', 'PUNCT', {}, 9, 'punct'],
    ['—', '—', 'PUNCT', {}, 9, 'punct'],
    ['сказал', 'сказать', 'VERB', { VerbForm: 'Fin' }, 3, 'parataxis'],
    ['он', 'он', 'PRON', { Case: 'Nom' }, 8, 'nsubj'],
    ['тихо', 'тихо', 'ADV', {}, 8, 'advmod'],
    ['.', '.', 'PUNCT', {}, 3, 'punct'],
  ];
  assert.deepEqual(remarkHits(text, rows), []);
});

test('remark: самостоятельное действие в ремарке не срабатывает', () => {
  const text = '«Я не пойду», — сказал он и встал.';
  const rows = [
    ['«', '«', 'PUNCT', {}, 4, 'punct'],
    ['Я', 'я', 'PRON', { Case: 'Nom' }, 3, 'nsubj'],
    ['не', 'не', 'PART', {}, 3, 'advmod'],
    ['пойду', 'пойти', 'VERB', {}, 0, 'root'],
    ['»', '»', 'PUNCT', {}, 3, 'punct'],
    [',', ',', 'PUNCT', {}, 9, 'punct'],
    ['—', '—', 'PUNCT', {}, 9, 'punct'],
    ['сказал', 'сказать', 'VERB', { VerbForm: 'Fin' }, 3, 'parataxis'],
    ['он', 'он', 'PRON', { Case: 'Nom' }, 8, 'nsubj'],
    ['и', 'и', 'CCONJ', {}, 11, 'cc'],
    ['встал', 'встать', 'VERB', {}, 8, 'conj'],
    ['.', '.', 'PUNCT', {}, 3, 'punct'],
  ];
  assert.deepEqual(remarkHits(text, rows), []);
});

test('remark: другой субъект или другой речевой глагол отменяют finding', () => {
  const text = '«Я не пойду», — сказал он, — ответила она.';
  const rows = [
    ['«', '«', 'PUNCT', {}, 4, 'punct'],
    ['Я', 'я', 'PRON', { Case: 'Nom' }, 3, 'nsubj'],
    ['не', 'не', 'PART', {}, 3, 'advmod'],
    ['пойду', 'пойти', 'VERB', {}, 0, 'root'],
    ['»', '»', 'PUNCT', {}, 3, 'punct'],
    [',', ',', 'PUNCT', {}, 10, 'punct'],
    ['—', '—', 'PUNCT', {}, 10, 'punct'],
    ['сказал', 'сказать', 'VERB', {}, 3, 'parataxis'],
    ['он', 'он', 'PRON', { Case: 'Nom' }, 8, 'nsubj'],
    [',', ',', 'PUNCT', {}, 10, 'punct'],
    ['—', '—', 'PUNCT', {}, 10, 'punct'],
    ['ответила', 'ответить', 'VERB', {}, 8, 'parataxis'],
    ['она', 'она', 'PRON', { Case: 'Nom' }, 12, 'nsubj'],
    ['.', '.', 'PUNCT', {}, 3, 'punct'],
  ];
  assert.deepEqual(remarkHits(text, rows), []);
});

test('remark: две одинаковые ремарки через новую реплику не считаются дублем', () => {
  const text = '«Я не пойду», — сказал он. «Я пойду», — сказал он.';
  const rows = [
    ['«', '«', 'PUNCT', {}, 6, 'punct'],
    ['Я', 'я', 'PRON', { Case: 'Nom' }, 5, 'nsubj'],
    ['не', 'не', 'PART', {}, 5, 'advmod'],
    ['пойду', 'пойти', 'VERB', {}, 0, 'root'],
    ['»', '»', 'PUNCT', {}, 5, 'punct'],
    [',', ',', 'PUNCT', {}, 9, 'punct'],
    ['—', '—', 'PUNCT', {}, 9, 'punct'],
    ['сказал', 'сказать', 'VERB', {}, 5, 'parataxis'],
    ['он', 'он', 'PRON', { Case: 'Nom' }, 8, 'nsubj'],
    ['.', '.', 'PUNCT', {}, 5, 'punct'],
    ['«', '«', 'PUNCT', {}, 15, 'punct'],
    ['Я', 'я', 'PRON', { Case: 'Nom' }, 14, 'nsubj'],
    ['пойду', 'пойти', 'VERB', {}, 9, 'conj'],
    ['»', '»', 'PUNCT', {}, 14, 'punct'],
    [',', ',', 'PUNCT', {}, 18, 'punct'],
    ['—', '—', 'PUNCT', {}, 18, 'punct'],
    ['сказал', 'сказать', 'VERB', {}, 14, 'parataxis'],
    ['он', 'он', 'PRON', { Case: 'Nom' }, 17, 'nsubj'],
    ['.', '.', 'PUNCT', {}, 14, 'punct'],
  ];
  assert.deepEqual(remarkHits(text, rows), []);
});

test('remark: повтор речевого глагола в самой реплике не даёт finding', () => {
  const text = '«Я сказал», — сказал он.';
  const rows = [
    ['«', '«', 'PUNCT', {}, 5, 'punct'],
    ['Я', 'я', 'PRON', { Case: 'Nom' }, 4, 'nsubj'],
    ['сказал', 'сказать', 'VERB', {}, 0, 'root'],
    ['»', '»', 'PUNCT', {}, 4, 'punct'],
    [',', ',', 'PUNCT', {}, 7, 'punct'],
    ['—', '—', 'PUNCT', {}, 7, 'punct'],
    ['сказал', 'сказать', 'VERB', {}, 4, 'parataxis'],
    ['он', 'он', 'PRON', { Case: 'Nom' }, 7, 'nsubj'],
    ['.', '.', 'PUNCT', {}, 4, 'punct'],
  ];
  assert.deepEqual(remarkHits(text, rows), []);
});

test('remark: без прямой речи и с битым деревом — abstain', () => {
  const text = 'Он сказал он сказал.';
  const noSpeech = [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
    ['сказал', 'сказать', 'VERB', {}, 0, 'root'],
    ['он', 'он', 'PRON', { Case: 'Nom' }, 4, 'nsubj'],
    ['сказал', 'сказать', 'VERB', {}, 2, 'parataxis'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  assert.deepEqual(remarkHits(text, noSpeech), []);
  const quote = '«Я не пойду», — сказал он, — сказал он.';
  const broken = duplicateRows().map((row, i) => (i === 7 ? [...row.slice(0, 4), 99, row[5]] : row));
  assert.doesNotThrow(() => remarkHits(quote, broken));
  assert.deepEqual(remarkHits(quote, broken), []);
});

test('remark: emoji и UTF-16 offsets', () => {
  const text = '😀 «Я не пойду», — сказал он, — сказал он.';
  const rows = duplicateRows();
  const found = remarkHits(text, rows);
  assert.equal(found.length, 1);
  assert.equal(found[0].fragment, 'сказал он, — сказал он');
  assert.equal(found[0].start, text.indexOf('сказал он'));
  assert.equal(found[0].fragment, text.slice(found[0].start, found[0].end));
});

test('remark: неполная морфология отменяет finding', () => {
  const text = '«Я не пойду», — сказал он, — сказал он.';
  const rows = duplicateRows().map((row, i) => (i === 7 ? [...row.slice(0, 3), {}, row[4], row[5]] : row));
  assert.deepEqual(remarkHits(text, rows), []);
});
