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

const run = (text, rows) => analyzeStructural(text, parse(text, rows), { weak: true });
const weakHits = (text, rows) => run(text, rows).weak;

test('weak: иметь + абстрактное существительное', () => {
  const text = 'Он имеет значение.';
  const rows = [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
    ['имеет', 'иметь', 'VERB', { VerbForm: 'Fin', Voice: 'Act' }, 0, 'root'],
    ['значение', 'значение', 'NOUN', { Case: 'Acc' }, 2, 'obj'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  const found = weakHits(text, rows);
  assert.equal(found.length, 1);
  assert.equal(found[0].fragment, 'имеет значение');
  assert.equal(found[0].ruleId, 'weak.support-verb-abstract-noun');
  assert.equal(found[0].fragment, text.slice(found[0].start, found[0].end));
  assert.notEqual(found[0].confidence, 'high');
});

test('weak: иметь + конкретное существительное не срабатывает', () => {
  const text = 'Он имеет дом.';
  const rows = [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
    ['имеет', 'иметь', 'VERB', { VerbForm: 'Fin', Voice: 'Act' }, 0, 'root'],
    ['дом', 'дом', 'NOUN', { Case: 'Acc' }, 2, 'obj'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  assert.deepEqual(weakHits(text, rows), []);
});

test('weak: вести + абстрактное существительное', () => {
  const text = 'Он ведёт борьбу.';
  const rows = [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
    ['ведёт', 'вести', 'VERB', { VerbForm: 'Fin', Voice: 'Act' }, 0, 'root'],
    ['борьбу', 'борьба', 'NOUN', { Case: 'Acc' }, 2, 'obj'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  assert.equal(weakHits(text, rows).length, 1);
});

test('weak: вести ребёнка — не слабое употребление', () => {
  const text = 'Он ведёт ребёнка.';
  const rows = [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
    ['ведёт', 'вести', 'VERB', { VerbForm: 'Fin', Voice: 'Act' }, 0, 'root'],
    ['ребёнка', 'ребёнок', 'NOUN', { Case: 'Acc' }, 2, 'obj'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  assert.deepEqual(weakHits(text, rows), []);
});

test('weak: находиться в состоянии — описательная конструкция', () => {
  const text = 'Он находится в состоянии.';
  const rows = [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
    ['находится', 'находиться', 'VERB', { VerbForm: 'Fin', Voice: 'Mid' }, 0, 'root'],
    ['в', 'в', 'ADP', {}, 4, 'case'],
    ['состоянии', 'состояние', 'NOUN', { Case: 'Loc' }, 2, 'obl'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  const found = weakHits(text, rows);
  assert.equal(found.length, 1);
  assert.equal(found[0].fragment, 'находится в состоянии');
  assert.equal(found[0].confidence, 'low');
});

test('weak: находиться в комнате — не срабатывает', () => {
  const text = 'Дом находится в комнате.';
  const rows = [
    ['Дом', 'дом', 'NOUN', { Case: 'Nom' }, 2, 'nsubj'],
    ['находится', 'находиться', 'VERB', { VerbForm: 'Fin', Voice: 'Mid' }, 0, 'root'],
    ['в', 'в', 'ADP', {}, 4, 'case'],
    ['комнате', 'комната', 'NOUN', { Case: 'Loc' }, 2, 'obl'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  assert.deepEqual(weakHits(text, rows), []);
});

test('weak: пользоваться популярностью и подвергаться критике', () => {
  const t1 = 'Он пользуется популярностью.';
  const r1 = [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
    ['пользуется', 'пользоваться', 'VERB', { VerbForm: 'Fin', Voice: 'Mid' }, 0, 'root'],
    ['популярностью', 'популярность', 'NOUN', { Case: 'Ins' }, 2, 'obl'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  assert.equal(weakHits(t1, r1).length, 1);
  const t2 = 'Он подвергается критике.';
  const r2 = [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
    ['подвергается', 'подвергаться', 'VERB', { VerbForm: 'Fin', Voice: 'Mid' }, 0, 'root'],
    ['критике', 'критика', 'NOUN', { Case: 'Dat' }, 2, 'obl'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  assert.equal(weakHits(t2, r2).length, 1);
});

test('weak: устойчивое «играть роль» и играть на скрипке не срабатывают', () => {
  const t1 = 'Он играет роль.';
  const r1 = [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
    ['играет', 'играть', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['роль', 'роль', 'NOUN', { Case: 'Acc' }, 2, 'obj'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  assert.deepEqual(weakHits(t1, r1), []);
  const t2 = 'Он играет на скрипке.';
  const r2 = [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
    ['играет', 'играть', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['на', 'на', 'ADP', {}, 5, 'case'],
    ['скрипке', 'скрипка', 'NOUN', { Case: 'Loc' }, 2, 'obl'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  assert.deepEqual(weakHits(t2, r2), []);
});

test('weak: связки и глаголы движения/восприятия не срабатывают', () => {
  const cases = [
    ['Он был зол.', [
      ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
      ['был', 'быть', 'AUX', { VerbForm: 'Fin' }, 3, 'cop'],
      ['зол', 'злой', 'ADJ', { Case: 'Nom' }, 0, 'root'],
      ['.', '.', 'PUNCT', {}, 3, 'punct'],
    ]],
    ['Он является важным.', [
      ['Он', 'он', 'PRON', { Case: 'Nom' }, 3, 'nsubj'],
      ['является', 'являться', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
      ['важным', 'важный', 'ADJ', { Case: 'Ins' }, 3, 'acomp'],
      ['.', '.', 'PUNCT', {}, 3, 'punct'],
    ]],
    ['Он идёт домой.', [
      ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
      ['идёт', 'идти', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
      ['домой', 'домой', 'ADV', {}, 2, 'advmod'],
      ['.', '.', 'PUNCT', {}, 2, 'punct'],
    ]],
    ['Он видит дом.', [
      ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
      ['видит', 'видеть', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
      ['дом', 'дом', 'NOUN', { Case: 'Acc' }, 2, 'obj'],
      ['.', '.', 'PUNCT', {}, 2, 'punct'],
    ]],
  ];
  for (const [text, rows] of cases) assert.deepEqual(weakHits(text, rows), [], text);
});

test('weak: не дублирует chancery для лёгкого глагола с событием', () => {
  const text = 'Он осуществил проверку.';
  const rows = [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
    ['осуществил', 'осуществить', 'VERB', { VerbForm: 'Fin', Voice: 'Act' }, 0, 'root'],
    ['проверку', 'проверка', 'NOUN', { Case: 'Acc' }, 2, 'obj'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  const result = analyzeStructural(text, parse(text, rows), { chancery: true, weak: true });
  assert.equal(result.chancery.length, 1);
  assert.deepEqual(result.weak, []);
});

test('weak: оказывать влияние остаётся weak, оказывать помощь — chancery', () => {
  const influence = 'Он оказывает влияние.';
  const r1 = [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
    ['оказывает', 'оказывать', 'VERB', { VerbForm: 'Fin', Voice: 'Act' }, 0, 'root'],
    ['влияние', 'влияние', 'NOUN', { Case: 'Acc' }, 2, 'obj'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  const res1 = analyzeStructural(influence, parse(influence, r1), { chancery: true, weak: true });
  assert.equal(res1.weak.length, 1);
  assert.deepEqual(res1.chancery, []);
  const help = 'Он оказывает помощь.';
  const r2 = [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
    ['оказывает', 'оказывать', 'VERB', { VerbForm: 'Fin', Voice: 'Act' }, 0, 'root'],
    ['помощь', 'помощь', 'NOUN', { Case: 'Acc' }, 2, 'obj'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  const res2 = analyzeStructural(help, parse(help, r2), { chancery: true, weak: true });
  assert.equal(res2.chancery.length, 1);
  assert.deepEqual(res2.weak, []);
});

test('weak: цитата и emoji offsets', () => {
  const quoted = '«Он имеет значение.»';
  const qRows = [
    ['«', '«', 'PUNCT', {}, 2, 'punct'],
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 3, 'nsubj'],
    ['имеет', 'иметь', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['значение', 'значение', 'NOUN', { Case: 'Acc' }, 3, 'obj'],
    ['.', '.', 'PUNCT', {}, 3, 'punct'],
    ['»', '»', 'PUNCT', {}, 3, 'punct'],
  ];
  assert.deepEqual(weakHits(quoted, qRows), []);
  const text = '😀 Он имеет значение.';
  const rows = [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
    ['имеет', 'иметь', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['значение', 'значение', 'NOUN', { Case: 'Acc' }, 2, 'obj'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  const found = weakHits(text, rows);
  assert.equal(found.length, 1);
  assert.equal(found[0].fragment, 'имеет значение');
  assert.equal(found[0].start, text.indexOf('имеет'));
});

test('weak: повреждённые данные не дают finding и не бросают', () => {
  const text = 'Он имеет значение.';
  const rows = [
    ['Он', 'он', 'PRON', {}, 2, 'nsubj'],
    ['имеет', 'иметь', 'VERB', {}, 99, 'root'],
    ['значение', 'значение', 'NOUN', {}, 2, 'obj'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  assert.doesNotThrow(() => weakHits(text, rows));
  assert.deepEqual(weakHits(text, rows), []);
});
