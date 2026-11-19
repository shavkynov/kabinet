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

const ownHits = (text, rows) => analyzeStructural(text, parse(text, rows), { own: true }).own;

test('own: свой + телесное существительное при физическом действии', () => {
  const text = 'Он поднял свою руку.';
  const rows = [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
    ['поднял', 'поднять', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['свою', 'свой', 'DET', { Case: 'Acc', Gender: 'Fem', Number: 'Sing' }, 4, 'det'],
    ['руку', 'рука', 'NOUN', { Case: 'Acc', Gender: 'Fem', Number: 'Sing' }, 2, 'obj'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  const found = ownHits(text, rows);
  assert.equal(found.length, 1);
  assert.equal(found[0].fragment, 'свою руку');
  assert.equal(found[0].ruleId, 'own.reflexive-body-part');
  assert.equal(found[0].confidence, 'low');
  assert.equal(found[0].fragment, text.slice(found[0].start, found[0].end));
});

test('own: свой в творительном падеже при физическом действии', () => {
  const text = 'Он погладил своей рукой стол.';
  const rows = [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
    ['погладил', 'погладить', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['своей', 'свой', 'DET', { Case: 'Ins', Gender: 'Fem', Number: 'Sing' }, 4, 'det'],
    ['рукой', 'рука', 'NOUN', { Case: 'Ins', Gender: 'Fem', Number: 'Sing' }, 2, 'obl'],
    ['стол', 'стол', 'NOUN', { Case: 'Acc' }, 2, 'obj'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  const found = ownHits(text, rows);
  assert.equal(found.length, 1);
  assert.equal(found[0].fragment, 'своей рукой');
});

test('own: свой + обычное существительное не срабатывает', () => {
  const text = 'Он взял свою книгу.';
  const rows = [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
    ['взял', 'взять', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['свою', 'свой', 'DET', { Case: 'Acc', Gender: 'Fem', Number: 'Sing' }, 4, 'det'],
    ['книгу', 'книга', 'NOUN', { Case: 'Acc', Gender: 'Fem', Number: 'Sing' }, 2, 'obj'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  assert.deepEqual(ownHits(text, rows), []);
});

test('own: свой + телесное существительное, но не физическое действие', () => {
  const text = 'Он посмотрел своими глазами.';
  const rows = [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
    ['посмотрел', 'посмотреть', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['своими', 'свой', 'DET', { Case: 'Ins', Number: 'Plur' }, 4, 'det'],
    ['глазами', 'глаз', 'NOUN', { Case: 'Ins', Number: 'Plur' }, 2, 'obl'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  assert.deepEqual(ownHits(text, rows), []);
});

test('own: контраст и эмфаза отменяют finding', () => {
  const contrast = 'Он поднял свою руку, а не чужую.';
  const r1 = [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
    ['поднял', 'поднять', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['свою', 'свой', 'DET', { Case: 'Acc', Gender: 'Fem', Number: 'Sing' }, 4, 'det'],
    ['руку', 'рука', 'NOUN', { Case: 'Acc', Gender: 'Fem', Number: 'Sing' }, 2, 'obj'],
    [',', ',', 'PUNCT', {}, 2, 'punct'],
    ['а', 'а', 'CCONJ', {}, 2, 'cc'],
    ['не', 'не', 'PART', {}, 2, 'advmod'],
    ['чужую', 'чужой', 'ADJ', { Case: 'Acc', Gender: 'Fem' }, 4, 'conj'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  assert.deepEqual(ownHits(contrast, r1), []);
  const emphasis = 'Он поднял свою собственную руку.';
  const r2 = [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
    ['поднял', 'поднять', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['свою', 'свой', 'DET', { Case: 'Acc', Gender: 'Fem', Number: 'Sing' }, 5, 'det'],
    ['собственную', 'собственный', 'ADJ', { Case: 'Acc', Gender: 'Fem' }, 4, 'amod'],
    ['руку', 'рука', 'NOUN', { Case: 'Acc', Gender: 'Fem', Number: 'Sing' }, 2, 'obj'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  assert.deepEqual(ownHits(emphasis, r2), []);
});

test('own: координация и отсутствие местоимения не срабатывают', () => {
  const coord = 'Он поднял свою руку и ногу.';
  const r1 = [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
    ['поднял', 'поднять', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['свою', 'свой', 'DET', { Case: 'Acc', Gender: 'Fem', Number: 'Sing' }, 4, 'det'],
    ['руку', 'рука', 'NOUN', { Case: 'Acc', Gender: 'Fem', Number: 'Sing' }, 2, 'obj'],
    ['и', 'и', 'CCONJ', {}, 2, 'cc'],
    ['ногу', 'нога', 'NOUN', { Case: 'Acc', Gender: 'Fem', Number: 'Sing' }, 4, 'conj'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  assert.deepEqual(ownHits(coord, r1), []);
  const noPronoun = 'Он поднял руку.';
  const r2 = [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
    ['поднял', 'поднять', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['руку', 'рука', 'NOUN', { Case: 'Acc', Gender: 'Fem', Number: 'Sing' }, 2, 'obj'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  assert.deepEqual(ownHits(noPronoun, r2), []);
});

test('own: возвратно-притяжательное свой при физическом действии в подчинённой клаузе — abstain', () => {
  const text = 'Он сказал, что поднял свою руку.';
  const rows = [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
    ['сказал', 'сказать', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    [',', ',', 'PUNCT', {}, 2, 'punct'],
    ['что', 'что', 'SCONJ', {}, 6, 'mark'],
    ['поднял', 'поднять', 'VERB', { VerbForm: 'Fin' }, 2, 'ccomp'],
    ['свою', 'свой', 'DET', { Case: 'Acc', Gender: 'Fem', Number: 'Sing' }, 5, 'det'],
    ['руку', 'рука', 'NOUN', { Case: 'Acc', Gender: 'Fem', Number: 'Sing' }, 5, 'obj'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  assert.deepEqual(ownHits(text, rows), []);
});

test('own: его как личное дополнение не относится к категории', () => {
  const text = 'Он увидел его.';
  const rows = [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
    ['увидел', 'увидеть', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['его', 'он', 'PRON', { Case: 'Acc', Gender: 'Masc', Number: 'Sing' }, 2, 'obj'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  assert.deepEqual(ownHits(text, rows), []);
});

test('own: притяжательное его без структурного дублирования не срабатывает', () => {
  const text = 'Он взял его книгу.';
  const rows = [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
    ['взял', 'взять', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['его', 'его', 'DET', {}, 4, 'det'],
    ['книгу', 'книга', 'NOUN', { Case: 'Acc', Gender: 'Fem', Number: 'Sing' }, 2, 'obj'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  assert.deepEqual(ownHits(text, rows), []);
});

test('own: структурное дублирование двух притяжательных детерминативов', () => {
  const text = 'Он взял его свою книгу.';
  const rows = [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
    ['взял', 'взять', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['его', 'его', 'DET', {}, 5, 'det'],
    ['свою', 'свой', 'DET', { Case: 'Acc', Gender: 'Fem', Number: 'Sing' }, 5, 'det'],
    ['книгу', 'книга', 'NOUN', { Case: 'Acc', Gender: 'Fem', Number: 'Sing' }, 2, 'obj'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  const found = ownHits(text, rows);
  assert.equal(found.length, 1);
  assert.equal(found[0].fragment, 'его свою книгу');
  assert.equal(found[0].ruleId, 'own.duplicate-possessive');
});

test('own: формы и морфологическое рассогласование', () => {
  const text = 'Он поднял свою рука.';
  const rows = [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
    ['поднял', 'поднять', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['свою', 'свой', 'DET', { Case: 'Acc', Gender: 'Fem', Number: 'Sing' }, 4, 'det'],
    ['рука', 'рука', 'NOUN', { Case: 'Nom', Gender: 'Fem', Number: 'Sing' }, 2, 'obj'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  assert.deepEqual(ownHits(text, rows), []);
});

test('own: emoji и UTF-16 offsets', () => {
  const text = '😀 Он поднял свою руку.';
  const rows = [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
    ['поднял', 'поднять', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['свою', 'свой', 'DET', { Case: 'Acc', Gender: 'Fem', Number: 'Sing' }, 4, 'det'],
    ['руку', 'рука', 'NOUN', { Case: 'Acc', Gender: 'Fem', Number: 'Sing' }, 2, 'obj'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  const found = ownHits(text, rows);
  assert.equal(found.length, 1);
  assert.equal(found[0].fragment, 'свою руку');
  assert.equal(found[0].start, text.indexOf('свою'));
});

test('own: цитата и повреждённое дерево не дают finding', () => {
  const quoted = '«Он поднял свою руку.»';
  const qRows = [
    ['«', '«', 'PUNCT', {}, 2, 'punct'],
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 3, 'nsubj'],
    ['поднял', 'поднять', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['свою', 'свой', 'DET', { Case: 'Acc', Gender: 'Fem', Number: 'Sing' }, 5, 'det'],
    ['руку', 'рука', 'NOUN', { Case: 'Acc', Gender: 'Fem', Number: 'Sing' }, 3, 'obj'],
    ['.', '.', 'PUNCT', {}, 3, 'punct'],
    ['»', '»', 'PUNCT', {}, 3, 'punct'],
  ];
  assert.deepEqual(ownHits(quoted, qRows), []);
  const damaged = 'Он поднял свою руку.';
  const dRows = [
    ['Он', 'он', 'PRON', {}, 2, 'nsubj'],
    ['поднял', 'поднять', 'VERB', {}, 99, 'root'],
    ['свою', 'свой', 'DET', {}, 3, 'det'],
    ['руку', 'рука', 'NOUN', {}, 3, 'obj'],
    ['.', '.', 'PUNCT', {}, 3, 'punct'],
  ];
  assert.doesNotThrow(() => ownHits(damaged, dRows));
  assert.deepEqual(ownHits(damaged, dRows), []);
});

function bodyRows({ pronounFeats, nounFeats }) {
  return [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
    ['поднял', 'поднять', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['свою', 'свой', 'DET', pronounFeats, 4, 'det'],
    ['руку', 'рука', 'NOUN', nounFeats, 2, 'obj'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
}
const text = 'Он поднял свою руку.';

test('own morphology: отсутствует feats у свой — abstain', () => {
  assert.deepEqual(ownHits(text, bodyRows({ pronounFeats: undefined, nounFeats: { Case: 'Acc', Gender: 'Fem', Number: 'Sing' } })), []);
});

test('own morphology: отсутствует feats у существительного — abstain', () => {
  assert.deepEqual(ownHits(text, bodyRows({ pronounFeats: { Case: 'Acc', Gender: 'Fem', Number: 'Sing' }, nounFeats: undefined })), []);
});

test('own morphology: оба feats пустые — abstain', () => {
  assert.deepEqual(ownHits(text, bodyRows({ pronounFeats: {}, nounFeats: {} })), []);
});

test('own morphology: отсутствует Case у обоих — abstain', () => {
  assert.deepEqual(ownHits(text, bodyRows({
    pronounFeats: { Gender: 'Fem', Number: 'Sing' },
    nounFeats: { Gender: 'Fem', Number: 'Sing' },
  })), []);
});

test('own morphology: отсутствует Number у обоих — abstain', () => {
  assert.deepEqual(ownHits(text, bodyRows({
    pronounFeats: { Case: 'Acc', Gender: 'Fem' },
    nounFeats: { Case: 'Acc', Gender: 'Fem' },
  })), []);
});

test('own morphology: Gender есть только у свой — abstain', () => {
  assert.deepEqual(ownHits(text, bodyRows({
    pronounFeats: { Case: 'Acc', Gender: 'Fem', Number: 'Sing' },
    nounFeats: { Case: 'Acc', Number: 'Sing' },
  })), []);
});

test('own morphology: Gender есть только у существительного — abstain', () => {
  assert.deepEqual(ownHits(text, bodyRows({
    pronounFeats: { Case: 'Acc', Number: 'Sing' },
    nounFeats: { Case: 'Acc', Gender: 'Fem', Number: 'Sing' },
  })), []);
});

test('own morphology: полные признаки по-прежнему дают finding', () => {
  const found = ownHits(text, bodyRows({
    pronounFeats: { Case: 'Acc', Gender: 'Fem', Number: 'Sing' },
    nounFeats: { Case: 'Acc', Gender: 'Fem', Number: 'Sing' },
  }));
  assert.equal(found.length, 1);
  assert.equal(found[0].fragment, 'свою руку');
});
