'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeStructural } = require('../src/style-engine/structural');

function parse(text, tokenRows) {
  const tokens = tokenRows.map(([word, lemma, upos, feats, head, deprel, start]) => ({
    id: tokenRows.indexOf(tokenRows.find((row) => row[0] === word && row[6] === start)) + 1,
    text: word, lemma, upos, feats, head, deprel, start, end: start + word.length, confidence: null,
  }));
  // Reassign stable 1-based ids in array order; head values in fixtures refer to these ids.
  tokens.forEach((token, i) => { token.id = i + 1; });
  return {
    schemaVersion: 1, parser: { name: 'hand-annotated-fixture', version: '1' },
    sentences: [{ start: 0, end: text.length, text, tokens }],
  };
}

test('chain: dependency-based genitive chain with two nominalizations is found', () => {
  const text = 'Причина отсутствия желания возвращаться.';
  const parsed = parse(text, [
    ['Причина', 'причина', 'NOUN', { Case: 'Nom' }, 0, 'root', 0],
    ['отсутствия', 'отсутствие', 'NOUN', { Case: 'Gen' }, 1, 'nmod', 8],
    ['желания', 'желание', 'NOUN', { Case: 'Gen' }, 2, 'nmod', 19],
    ['возвращаться', 'возвращаться', 'VERB', { VerbForm: 'Inf' }, 3, 'xcomp', 27],
    ['.', '.', 'PUNCT', {}, 1, 'punct', 40],
  ]);
  const hits = analyzeStructural(text, parsed, { chain: true }).chain;
  assert.equal(hits.length, 1);
  assert.equal(hits[0].fragment, 'Причина отсутствия желания');
  assert.equal(hits[0].category, 'chain');
  assert.equal(hits[0].confidence, 'medium');
  assert.ok(hits[0].method.includes('dependency:nmod'));
});

test('chain: соседство существительных без генитивной dependency-цепи не срабатывает', () => {
  const text = 'Дом отца брата стоял у реки.';
  const parsed = parse(text, [
    ['Дом', 'дом', 'NOUN', { Case: 'Nom' }, 0, 'root', 0],
    ['отца', 'отец', 'NOUN', { Case: 'Gen' }, 1, 'nmod', 4],
    ['брата', 'брат', 'NOUN', { Case: 'Gen' }, 2, 'nmod', 9],
    ['стоял', 'стоять', 'VERB', { VerbForm: 'Fin' }, 1, 'acl', 15],
    ['у', 'у', 'ADP', {}, 6, 'case', 21],
    ['реки', 'река', 'NOUN', { Case: 'Gen' }, 4, 'obl', 23],
    ['.', '.', 'PUNCT', {}, 4, 'punct', 27],
  ]);
  assert.deepEqual(analyzeStructural(text, parsed, { chain: true }).chain, []);
});

test('chain: «здание министерства образования» — не цепочка номинализаций', () => {
  const text = 'Здание министерства образования было построено.';
  const parsed = parse(text, [
    ['Здание', 'здание', 'NOUN', { Case: 'Nom' }, 4, 'nsubj:pass', 0],
    ['министерства', 'министерство', 'NOUN', { Case: 'Gen' }, 1, 'nmod', 7],
    ['образования', 'образование', 'NOUN', { Case: 'Gen' }, 2, 'nmod', 20],
    ['было', 'быть', 'AUX', { VerbForm: 'Fin' }, 5, 'aux:pass', 32],
    ['построено', 'построить', 'VERB', { VerbForm: 'Part' }, 0, 'root', 37],
    ['.', '.', 'PUNCT', {}, 5, 'punct', 46],
  ]);
  assert.deepEqual(analyzeStructural(text, parsed, { chain: true }).chain, []);
});

test('chain: нормальная согласованная именная группа не срабатывает', () => {
  const text = 'Старые книги лежали на столе.';
  const parsed = parse(text, [
    ['Старые', 'старый', 'ADJ', { Case: 'Nom', Number: 'Plur' }, 2, 'amod', 0],
    ['книги', 'книга', 'NOUN', { Case: 'Nom', Number: 'Plur' }, 3, 'nsubj', 7],
    ['лежали', 'лежать', 'VERB', { VerbForm: 'Fin' }, 0, 'root', 13],
    ['на', 'на', 'ADP', {}, 5, 'case', 20],
    ['столе', 'стол', 'NOUN', { Case: 'Loc' }, 3, 'obl', 23],
    ['.', '.', 'PUNCT', {}, 3, 'punct', 28],
  ]);
  assert.deepEqual(analyzeStructural(text, parsed, { chain: true }).chain, []);
});

test('which: три вложенных относительных придаточных отмечаются', () => {
  const text = 'Дом, который стоял у реки, который видел лес, который шумел, продаётся.';
  const parsed = parse(text, [
    ['Дом', 'дом', 'NOUN', { Case: 'Nom' }, 0, 'root', 0],
    [',', ',', 'PUNCT', {}, 4, 'punct', 3],
    ['который', 'который', 'PRON', { Case: 'Nom' }, 4, 'nsubj', 5],
    ['стоял', 'стоять', 'VERB', { VerbForm: 'Fin' }, 1, 'acl:relcl', 13],
    ['у', 'у', 'ADP', {}, 6, 'case', 19],
    ['реки', 'река', 'NOUN', { Case: 'Gen' }, 4, 'obl', 21],
    [',', ',', 'PUNCT', {}, 9, 'punct', 25],
    ['который', 'который', 'PRON', { Case: 'Nom' }, 9, 'nsubj', 27],
    ['видел', 'видеть', 'VERB', { VerbForm: 'Fin' }, 6, 'acl:relcl', 35],
    ['лес', 'лес', 'NOUN', { Case: 'Acc' }, 9, 'obj', 41],
    [',', ',', 'PUNCT', {}, 13, 'punct', 44],
    ['который', 'который', 'PRON', { Case: 'Nom' }, 13, 'nsubj', 46],
    ['шумел', 'шуметь', 'VERB', { VerbForm: 'Fin' }, 10, 'acl:relcl', 54],
    [',', ',', 'PUNCT', {}, 15, 'punct', 59],
    ['продаётся', 'продаваться', 'VERB', { VerbForm: 'Fin' }, 13, 'conj', 61],
    ['.', '.', 'PUNCT', {}, 1, 'punct', 70],
  ]);
  const hits = analyzeStructural(text, parsed, { which: true }).which;
  assert.equal(hits.length, 1);
  assert.equal(hits[0].fragment, 'который стоял у реки, который видел лес, который шумел');
  assert.equal(hits[0].confidence, 'high');
  assert.match(hits[0].explanation, /3 относительных/);
  assert.match(hits[0].explanation, /вложенность — 3/);
});

test('which: цепочка advcl/csubj без «который/что» не считается лавиной', () => {
  const text = 'Он шёл, думая, как придётся терпеть.';
  const parsed = parse(text, [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj', 0],
    ['шёл', 'идти', 'VERB', { VerbForm: 'Fin' }, 0, 'root', 3],
    [',', ',', 'PUNCT', {}, 4, 'punct', 6],
    ['думая', 'думать', 'VERB', { VerbForm: 'Conv' }, 2, 'advcl', 7],
    [',', ',', 'PUNCT', {}, 6, 'punct', 12],
    ['как', 'как', 'SCONJ', {}, 7, 'mark', 13],
    ['придётся', 'прийтись', 'VERB', { VerbForm: 'Fin' }, 4, 'advcl', 16],
    ['терпеть', 'терпеть', 'VERB', { VerbForm: 'Inf' }, 7, 'csubj', 24],
    ['.', '.', 'PUNCT', {}, 2, 'punct', 30],
  ]);
  assert.deepEqual(analyzeStructural(text, parsed, { which: true }).which, []);
});

test('which: омонимичное «что» и обычное предложение не дают срабатывания', () => {
  const text = 'Что лежало на столе, никто не заметил.';
  const parsed = parse(text, [
    ['Что', 'что', 'PRON', { Case: 'Nom' }, 2, 'nsubj', 0],
    ['лежало', 'лежать', 'VERB', { VerbForm: 'Fin' }, 0, 'root', 4],
    ['на', 'на', 'ADP', {}, 4, 'case', 11],
    ['столе', 'стол', 'NOUN', { Case: 'Loc' }, 2, 'obl', 13],
    ['никто', 'никто', 'PRON', { Case: 'Nom' }, 7, 'nsubj', 21],
    ['не', 'не', 'PART', {}, 7, 'advmod', 27],
    ['заметил', 'заметить', 'VERB', { VerbForm: 'Fin' }, 2, 'conj', 30],
    ['.', '.', 'PUNCT', {}, 7, 'punct', 37],
  ]);
  assert.deepEqual(analyzeStructural(text, parsed, { which: true }).which, []);
});

test('структурные правила не запускаются для отключённых категорий', () => {
  const text = 'Он понял, что дом, который стоял, продаётся, когда стемнело.';
  const parsed = parse(text, []);
  assert.deepEqual(analyzeStructural(text, parsed, {}).chain, []);
  assert.deepEqual(analyzeStructural(text, parsed, {}).which, []);
});
