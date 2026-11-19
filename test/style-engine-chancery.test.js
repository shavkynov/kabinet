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
  tokens.forEach((token, i) => { token.id = i + 1; });
  return { schemaVersion: 1, parser: { name: 'synthetic-fixture', version: '1' }, sentences: [{ start: 0, end: text.length, text, tokens }] };
}

const hits = (text, rows) => analyzeStructural(text, parse(text, rows), { chancery: true }).chancery;

test('chancery: лёгкий глагол + событийное существительное', () => {
  const text = 'Он осуществлял проверку документов.';
  const rows = [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
    ['осуществлял', 'осуществлять', 'VERB', { VerbForm: 'Fin', Voice: 'Act' }, 0, 'root'],
    ['проверку', 'проверка', 'NOUN', { Case: 'Acc' }, 2, 'obj'],
    ['документов', 'документ', 'NOUN', { Case: 'Gen' }, 3, 'nmod'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  const found = hits(text, rows);
  assert.equal(found.length, 1);
  assert.equal(found[0].fragment, 'осуществлял проверку');
  assert.equal(found[0].ruleId, 'chancery.light-verb-event-noun');
  assert.equal(found[0].fragment, text.slice(found[0].start, found[0].end));
  assert.notEqual(found[0].confidence, 'high');
});

test('chancery: «принял гостя» — не канцелярит', () => {
  const text = 'Он принял гостя.';
  const rows = [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
    ['принял', 'принять', 'VERB', { VerbForm: 'Fin', Voice: 'Act' }, 0, 'root'],
    ['гостя', 'гость', 'NOUN', { Case: 'Acc' }, 2, 'obj'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  assert.deepEqual(hits(text, rows), []);
});

test('chancery: цепочка событийных существительных в роли подлежащего', () => {
  const text = 'Осуществление проверки выполнения требований затянулось.';
  const rows = [
    ['Осуществление', 'осуществление', 'NOUN', { Case: 'Nom' }, 5, 'nsubj'],
    ['проверки', 'проверка', 'NOUN', { Case: 'Gen' }, 1, 'nmod'],
    ['выполнения', 'выполнение', 'NOUN', { Case: 'Gen' }, 2, 'nmod'],
    ['требований', 'требование', 'NOUN', { Case: 'Gen' }, 3, 'nmod'],
    ['затянулось', 'затянуться', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['.', '.', 'PUNCT', {}, 5, 'punct'],
  ];
  const found = hits(text, rows);
  assert.equal(found.length, 1);
  assert.equal(found[0].fragment, 'Осуществление проверки выполнения требований');
  assert.equal(found[0].ruleId, 'chancery.nominal-subject-cluster');
});

test('chancery: одиночное отглагольное существительное не срабатывает', () => {
  const text = 'Ожидание затянулось.';
  const rows = [
    ['Ожидание', 'ожидание', 'NOUN', { Case: 'Nom' }, 2, 'nsubj'],
    ['затянулось', 'затянуться', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  assert.deepEqual(hits(text, rows), []);
});

test('chancery: пассив без агенса + событийное существительное', () => {
  const text = 'Было принято решение.';
  const rows = [
    ['Было', 'быть', 'AUX', { VerbForm: 'Fin' }, 2, 'aux:pass'],
    ['принято', 'принять', 'VERB', { VerbForm: 'Part', Voice: 'Pass' }, 0, 'root'],
    ['решение', 'решение', 'NOUN', { Case: 'Nom' }, 2, 'nsubj:pass'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  const found = hits(text, rows);
  assert.equal(found.length, 1);
  assert.equal(found[0].fragment, 'Было принято решение');
  assert.equal(found[0].ruleId, 'chancery.passive-event-nominal');
});

test('chancery: пассив с агенсом и пассив без событийного существительного не срабатывают', () => {
  const withAgent = 'Проверка была проведена комиссией.';
  const rows1 = [
    ['Проверка', 'проверка', 'NOUN', { Case: 'Nom' }, 3, 'nsubj:pass'],
    ['была', 'быть', 'AUX', { VerbForm: 'Fin' }, 3, 'aux:pass'],
    ['проведена', 'провести', 'VERB', { VerbForm: 'Part', Voice: 'Pass' }, 0, 'root'],
    ['комиссией', 'комиссия', 'NOUN', { Case: 'Ins' }, 3, 'obl:agent'],
    ['.', '.', 'PUNCT', {}, 3, 'punct'],
  ];
  assert.deepEqual(hits(withAgent, rows1), []);
  const noEvent = 'Дом был построен.';
  const rows2 = [
    ['Дом', 'дом', 'NOUN', { Case: 'Nom' }, 3, 'nsubj:pass'],
    ['был', 'быть', 'AUX', { VerbForm: 'Fin' }, 3, 'aux:pass'],
    ['построен', 'построить', 'VERB', { VerbForm: 'Part', Voice: 'Pass' }, 0, 'root'],
    ['.', '.', 'PUNCT', {}, 3, 'punct'],
  ];
  assert.deepEqual(hits(noEvent, rows2), []);
});

test('chancery: официальная предложная формула + процессное существительное', () => {
  const text = 'В целях осуществления проверки комиссия прибыла.';
  const rows = [
    ['В', 'в', 'ADP', {}, 2, 'case'],
    ['целях', 'цель', 'NOUN', { Case: 'Loc' }, 6, 'obl'],
    ['осуществления', 'осуществление', 'NOUN', { Case: 'Gen' }, 2, 'nmod'],
    ['проверки', 'проверка', 'NOUN', { Case: 'Gen' }, 3, 'nmod'],
    ['комиссия', 'комиссия', 'NOUN', { Case: 'Nom' }, 6, 'nsubj'],
    ['прибыла', 'прибыть', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['.', '.', 'PUNCT', {}, 6, 'punct'],
  ];
  const found = hits(text, rows);
  assert.equal(found.length, 1);
  assert.equal(found[0].fragment, 'В целях осуществления проверки');
  assert.equal(found[0].ruleId, 'chancery.official-preposition');
  assert.equal(found[0].confidence, 'low');
});

test('chancery: официальная лексика без процессного существительного не срабатывает', () => {
  const text = 'В соответствии с требованиями безопасности работа остановлена.';
  const rows = [
    ['В', 'в', 'ADP', {}, 2, 'case'],
    ['соответствии', 'соответствие', 'NOUN', { Case: 'Loc' }, 6, 'obl'],
    ['с', 'с', 'ADP', {}, 4, 'case'],
    ['требованиями', 'требование', 'NOUN', { Case: 'Ins' }, 2, 'nmod'],
    ['безопасности', 'безопасность', 'NOUN', { Case: 'Gen' }, 4, 'nmod'],
    ['работа', 'работа', 'NOUN', { Case: 'Nom' }, 7, 'nsubj'],
    ['остановлена', 'остановить', 'VERB', { VerbForm: 'Part', Voice: 'Pass' }, 0, 'root'],
    ['.', '.', 'PUNCT', {}, 7, 'punct'],
  ];
  assert.deepEqual(hits(text, rows), []);
});

test('chancery: цитата персонажа не считается авторским канцеляритом', () => {
  const text = '«Он осуществил проверку.»';
  const rows = [
    ['«', '«', 'PUNCT', {}, 2, 'punct'],
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 3, 'nsubj'],
    ['осуществил', 'осуществить', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['проверку', 'проверка', 'NOUN', { Case: 'Acc' }, 3, 'obj'],
    ['.', '.', 'PUNCT', {}, 3, 'punct'],
    ['»', '»', 'PUNCT', {}, 3, 'punct'],
  ];
  assert.deepEqual(hits(text, rows), []);
});

test('chancery: emoji перед finding не сдвигает UTF-16 offsets', () => {
  const text = '😀 Он осуществил проверку.';
  const rows = [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
    ['осуществил', 'осуществить', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['проверку', 'проверка', 'NOUN', { Case: 'Acc' }, 2, 'obj'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  const found = hits(text, rows);
  assert.equal(found.length, 1);
  assert.equal(found[0].fragment, 'осуществил проверку');
  assert.equal(found[0].start, text.indexOf('осуществил'));
  assert.equal(found[0].fragment, text.slice(found[0].start, found[0].end));
});

test('chancery: повреждённые данные не дают finding и не бросают', () => {
  const text = 'Он осуществил проверку.';
  const rows = [
    ['Он', 'он', 'PRON', {}, 2, 'nsubj'],
    ['осуществил', 'осуществить', 'VERB', {}, 99, 'root'],
    ['проверку', 'проверка', 'NOUN', {}, 2, 'obj'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  assert.doesNotThrow(() => hits(text, rows));
  assert.deepEqual(hits(text, rows), []);
});
