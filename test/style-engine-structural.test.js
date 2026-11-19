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
    ['желания', 'желание', 'NOUN', { Case: 'Gen' }, 2, 'nmod', 20],
    ['возвращаться', 'возвращаться', 'VERB', { VerbForm: 'Inf' }, 3, 'xcomp', 28],
    ['.', '.', 'PUNCT', {}, 1, 'punct', 41],
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

test('which: три реальные зависимые клаузы отмечаются, а не просто три слова «что/который»', () => {
  const text = 'Он понял, что дом, который стоял, продаётся, когда стемнело.';
  const parsed = parse(text, [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj', 0],
    ['понял', 'понять', 'VERB', { VerbForm: 'Fin' }, 0, 'root', 3],
    ['что', 'что', 'SCONJ', {}, 4, 'mark', 10],
    ['дом', 'дом', 'NOUN', { Case: 'Nom' }, 2, 'ccomp', 14],
    ['который', 'который', 'PRON', { Case: 'Nom' }, 6, 'nsubj', 19],
    ['стоял', 'стоять', 'VERB', { VerbForm: 'Fin' }, 4, 'acl:relcl', 27],
    ['продаётся', 'продаваться', 'VERB', { VerbForm: 'Fin' }, 4, 'conj', 34],
    ['когда', 'когда', 'SCONJ', {}, 9, 'mark', 44],
    ['стемнело', 'стемнеть', 'VERB', { VerbForm: 'Fin' }, 7, 'advcl', 50],
    ['.', '.', 'PUNCT', {}, 8, 'punct', 58],
  ]);
  const hits = analyzeStructural(text, parsed, { which: true }).which;
  assert.equal(hits.length, 1);
  assert.equal(hits[0].fragment, text);
  assert.match(hits[0].explanation, /3 зависимых клауз/);
});

test('which: омонимичное «что» и обычное предложение не дают срабатывания', () => {
  const text = 'Что лежало на столе, никто не заметил.';
  const parsed = parse(text, [
    ['Что', 'что', 'PRON', { Case: 'Nom' }, 2, 'nsubj', 0],
    ['лежало', 'лежать', 'VERB', { VerbForm: 'Fin' }, 0, 'root', 4],
    ['на', 'на', 'ADP', {}, 4, 'case', 11],
    ['столе', 'стол', 'NOUN', { Case: 'Loc' }, 2, 'obl', 13],
    ['никто', 'никто', 'PRON', { Case: 'Nom' }, 6, 'nsubj', 19],
    ['не', 'не', 'PART', {}, 6, 'advmod', 25],
    ['заметил', 'заметить', 'VERB', { VerbForm: 'Fin' }, 2, 'conj', 28],
    ['.', '.', 'PUNCT', {}, 7, 'punct', 35],
  ]);
  assert.deepEqual(analyzeStructural(text, parsed, { which: true }).which, []);
});

test('структурные правила не запускаются для отключённых категорий', () => {
  const text = 'Он понял, что дом, который стоял, продаётся, когда стемнело.';
  const parsed = parse(text, []);
  assert.deepEqual(analyzeStructural(text, parsed, {}).chain, []);
  assert.deepEqual(analyzeStructural(text, parsed, {}).which, []);
});
