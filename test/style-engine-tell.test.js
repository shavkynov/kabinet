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

const tellHits = (text, rows) => analyzeStructural(text, parse(text, rows), { tell: true }).tell;

test('tell: прямое называние эмоции через глагол переживания', () => {
  const text = 'Он почувствовал страх.';
  const rows = [
    ['Он', 'он', 'PRON', { Case: 'Nom', Gender: 'Masc', Number: 'Sing' }, 2, 'nsubj'],
    ['почувствовал', 'почувствовать', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['страх', 'страх', 'NOUN', { Case: 'Acc', Gender: 'Masc', Number: 'Sing' }, 2, 'obj'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  const found = tellHits(text, rows);
  assert.equal(found.length, 1);
  assert.equal(found[0].fragment, 'почувствовал страх');
  assert.equal(found[0].ruleId, 'tell.experience-emotion-object');
  assert.equal(found[0].confidence, 'low');
  assert.equal(found[0].fragment, text.slice(found[0].start, found[0].end));
});

test('tell: минимальное называние через возвратный глагол', () => {
  const text = 'Он испугался.';
  const rows = [
    ['Он', 'он', 'PRON', { Case: 'Nom', Gender: 'Masc', Number: 'Sing' }, 2, 'nsubj'],
    ['испугался', 'испугаться', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  const found = tellHits(text, rows);
  assert.equal(found.length, 1);
  assert.equal(found[0].fragment, 'Он испугался');
  assert.equal(found[0].ruleId, 'tell.minimal-emotion-verb');
});

test('tell: состояние «был в ярости»', () => {
  const text = 'Он был в ярости.';
  const rows = [
    ['Он', 'он', 'PRON', { Case: 'Nom', Gender: 'Masc', Number: 'Sing' }, 4, 'nsubj'],
    ['был', 'быть', 'AUX', { VerbForm: 'Fin', Gender: 'Masc', Number: 'Sing' }, 4, 'cop'],
    ['в', 'в', 'ADP', {}, 4, 'case'],
    ['ярости', 'ярость', 'NOUN', { Case: 'Loc', Gender: 'Fem', Number: 'Sing' }, 0, 'root'],
    ['.', '.', 'PUNCT', {}, 4, 'punct'],
  ];
  const found = tellHits(text, rows);
  assert.equal(found.length, 1);
  assert.equal(found[0].fragment, 'был в ярости');
  assert.equal(found[0].ruleId, 'tell.emotion-state-noun');
});

test('tell: телесная реакция не считается называнием', () => {
  const text = 'Его руки дрожали.';
  const rows = [
    ['Его', 'его', 'DET', {}, 2, 'det'],
    ['руки', 'рука', 'NOUN', { Case: 'Nom', Gender: 'Fem', Number: 'Plur' }, 3, 'nsubj'],
    ['дрожали', 'дрожать', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['.', '.', 'PUNCT', {}, 3, 'punct'],
  ];
  assert.deepEqual(tellHits(text, rows), []);
});

test('tell: действие и смешанная конструкция не срабатывают', () => {
  const action = 'Он отступил.';
  const aRows = [
    ['Он', 'он', 'PRON', { Case: 'Nom', Gender: 'Masc', Number: 'Sing' }, 2, 'nsubj'],
    ['отступил', 'отступить', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  assert.deepEqual(tellHits(action, aRows), []);
  const mixed = 'Он испугался и отшатнулся.';
  const mRows = [
    ['Он', 'он', 'PRON', { Case: 'Nom', Gender: 'Masc', Number: 'Sing' }, 2, 'nsubj'],
    ['испугался', 'испугаться', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['и', 'и', 'CCONJ', {}, 4, 'cc'],
    ['отшатнулся', 'отшатнуться', 'VERB', { VerbForm: 'Fin' }, 2, 'conj'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  assert.deepEqual(tellHits(mixed, mRows), []);
});

test('tell: эмоциональное слово в роли подлежащего/метафоры не срабатывает', () => {
  const text = 'Страх постепенно отступал.';
  const rows = [
    ['Страх', 'страх', 'NOUN', { Case: 'Nom', Gender: 'Masc', Number: 'Sing' }, 3, 'nsubj'],
    ['постепенно', 'постепенно', 'ADV', {}, 3, 'advmod'],
    ['отступал', 'отступать', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['.', '.', 'PUNCT', {}, 3, 'punct'],
  ];
  assert.deepEqual(tellHits(text, rows), []);
});

test('tell: отрицание и модальность не дают finding', () => {
  const neg = 'Он не почувствовал страх.';
  const nRows = [
    ['Он', 'он', 'PRON', { Case: 'Nom', Gender: 'Masc', Number: 'Sing' }, 3, 'nsubj'],
    ['не', 'не', 'PART', {}, 3, 'advmod'],
    ['почувствовал', 'почувствовать', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['страх', 'страх', 'NOUN', { Case: 'Acc', Gender: 'Masc', Number: 'Sing' }, 3, 'obj'],
    ['.', '.', 'PUNCT', {}, 3, 'punct'],
  ];
  assert.deepEqual(tellHits(neg, nRows), []);
  const modal = 'Он мог почувствовать страх.';
  const mRows = [
    ['Он', 'он', 'PRON', { Case: 'Nom', Gender: 'Masc', Number: 'Sing' }, 2, 'nsubj'],
    ['мог', 'мочь', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['почувствовать', 'почувствовать', 'VERB', { VerbForm: 'Inf' }, 2, 'xcomp'],
    ['страх', 'страх', 'NOUN', { Case: 'Acc', Gender: 'Masc', Number: 'Sing' }, 3, 'obj'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  assert.deepEqual(tellHits(modal, mRows), []);
});

test('tell: причинная и подчинённая конструкция не срабатывают', () => {
  const fear = 'Он испугался темноты.';
  const fRows = [
    ['Он', 'он', 'PRON', { Case: 'Nom', Gender: 'Masc', Number: 'Sing' }, 2, 'nsubj'],
    ['испугался', 'испугаться', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['темноты', 'темнота', 'NOUN', { Case: 'Gen', Gender: 'Fem', Number: 'Sing' }, 2, 'obl'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  assert.deepEqual(tellHits(fear, fRows), []);
  const when = 'Он испугался, когда стемнело.';
  const wRows = [
    ['Он', 'он', 'PRON', { Case: 'Nom', Gender: 'Masc', Number: 'Sing' }, 2, 'nsubj'],
    ['испугался', 'испугаться', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    [',', ',', 'PUNCT', {}, 5, 'punct'],
    ['когда', 'когда', 'SCONJ', {}, 5, 'mark'],
    ['стемнело', 'стемнеть', 'VERB', { VerbForm: 'Fin' }, 2, 'advcl'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  assert.deepEqual(tellHits(when, wRows), []);
});

test('tell: прямая речь и вложенные цитаты исключаются', () => {
  const text = 'Он сказал: «Я почувствовал страх».';
  const rows = [
    ['Он', 'он', 'PRON', { Case: 'Nom', Gender: 'Masc', Number: 'Sing' }, 2, 'nsubj'],
    ['сказал', 'сказать', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    [':', ':', 'PUNCT', {}, 2, 'punct'],
    ['«Я', '«я', 'PROPN', { Case: 'Nom' }, 5, 'nsubj'],
    ['почувствовал', 'почувствовать', 'VERB', { VerbForm: 'Fin' }, 2, 'parataxis'],
    ['страх»', 'страх»', 'PROPN', { Case: 'Nom' }, 5, 'obj'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  assert.deepEqual(tellHits(text, rows), []);
});

test('tell: неполная морфология и повреждённое дерево отменяют finding', () => {
  const text = 'Он почувствовал страх.';
  const noFeats = [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
    ['почувствовал', 'почувствовать', 'VERB', {}, 0, 'root'],
    ['страх', 'страх', 'NOUN', {}, 2, 'obj'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  assert.deepEqual(tellHits(text, noFeats), []);
  const broken = [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
    ['почувствовал', 'почувствовать', 'VERB', { VerbForm: 'Fin' }, 99, 'root'],
    ['страх', 'страх', 'NOUN', { Case: 'Acc' }, 2, 'obj'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  assert.doesNotThrow(() => tellHits(text, broken));
  assert.deepEqual(tellHits(text, broken), []);
});

test('tell: emoji и UTF-16 offsets', () => {
  const text = '😀 Он почувствовал страх.';
  const rows = [
    ['Он', 'он', 'PRON', { Case: 'Nom', Gender: 'Masc', Number: 'Sing' }, 2, 'nsubj'],
    ['почувствовал', 'почувствовать', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['страх', 'страх', 'NOUN', { Case: 'Acc', Gender: 'Masc', Number: 'Sing' }, 2, 'obj'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  const found = tellHits(text, rows);
  assert.equal(found.length, 1);
  assert.equal(found[0].fragment, 'почувствовал страх');
  assert.equal(found[0].start, text.indexOf('почувствовал'));
  assert.equal(found[0].fragment, text.slice(found[0].start, found[0].end));
});

test('tell: нейтральные существительные и чужие категории не смешиваются', () => {
  const cold = 'Он почувствовал холод.';
  const cRows = [
    ['Он', 'он', 'PRON', { Case: 'Nom', Gender: 'Masc', Number: 'Sing' }, 2, 'nsubj'],
    ['почувствовал', 'почувствовать', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['холод', 'холод', 'NOUN', { Case: 'Acc', Gender: 'Masc', Number: 'Sing' }, 2, 'obj'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  assert.deepEqual(tellHits(cold, cRows), []);
  const fear = 'Он почувствовал страх.';
  const fRows = [
    ['Он', 'он', 'PRON', { Case: 'Nom', Gender: 'Masc', Number: 'Sing' }, 2, 'nsubj'],
    ['почувствовал', 'почувствовать', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['страх', 'страх', 'NOUN', { Case: 'Acc', Gender: 'Masc', Number: 'Sing' }, 2, 'obj'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  const all = analyzeStructural(fear, parse(fear, fRows), { tell: true, weak: true, chancery: true, own: true, redund: true, remark: true, chain: true, which: true });
  assert.equal(all.tell.length, 1);
  assert.equal(all.weak.length, 0);
  assert.equal(all.chancery.length, 0);
  assert.equal(all.own.length, 0);
  assert.equal(all.redund.length, 0);
  assert.equal(all.remark.length, 0);
  assert.equal(all.chain.length, 0);
  assert.equal(all.which.length, 0);
});

test('tell morphology: частичные feats не дают finding', () => {
  const text = 'Он почувствовал страх.';
  const subjectNoNumber = [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
    ['почувствовал', 'почувствовать', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['страх', 'страх', 'NOUN', { Case: 'Acc', Number: 'Sing' }, 2, 'obj'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  assert.deepEqual(tellHits(text, subjectNoNumber), []);
  const nounOnlyCase = [
    ['Он', 'он', 'PRON', { Case: 'Nom', Number: 'Sing' }, 2, 'nsubj'],
    ['почувствовал', 'почувствовать', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['страх', 'страх', 'NOUN', { Case: 'Acc' }, 2, 'obj'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  assert.deepEqual(tellHits(text, nounOnlyCase), []);
  const verbNoForm = [
    ['Он', 'он', 'PRON', { Case: 'Nom', Number: 'Sing' }, 2, 'nsubj'],
    ['почувствовал', 'почувствовать', 'VERB', { Voice: 'Act' }, 0, 'root'],
    ['страх', 'страх', 'NOUN', { Case: 'Acc', Number: 'Sing' }, 2, 'obj'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  assert.deepEqual(tellHits(text, verbNoForm), []);
});

test('tell morphology: возвратный глагол требует Number у подлежащего', () => {
  const text = 'Он испугался.';
  const rows = [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
    ['испугался', 'испугаться', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  assert.deepEqual(tellHits(text, rows), []);
});

test('tell morphology: состояние требует Loc/Number и полные признаки копулы/подлежащего', () => {
  const text = 'Он был в ярости.';
  const nounOnlyCase = [
    ['Он', 'он', 'PRON', { Case: 'Nom', Number: 'Sing' }, 4, 'nsubj'],
    ['был', 'быть', 'AUX', { VerbForm: 'Fin' }, 4, 'cop'],
    ['в', 'в', 'ADP', {}, 4, 'case'],
    ['ярости', 'ярость', 'NOUN', { Case: 'Loc' }, 0, 'root'],
    ['.', '.', 'PUNCT', {}, 4, 'punct'],
  ];
  assert.deepEqual(tellHits(text, nounOnlyCase), []);
  const copNoForm = [
    ['Он', 'он', 'PRON', { Case: 'Nom', Number: 'Sing' }, 4, 'nsubj'],
    ['был', 'быть', 'AUX', { Voice: 'Act' }, 4, 'cop'],
    ['в', 'в', 'ADP', {}, 4, 'case'],
    ['ярости', 'ярость', 'NOUN', { Case: 'Loc', Number: 'Sing' }, 0, 'root'],
    ['.', '.', 'PUNCT', {}, 4, 'punct'],
  ];
  assert.deepEqual(tellHits(text, copNoForm), []);
  const subjectNoNumber = [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 4, 'nsubj'],
    ['был', 'быть', 'AUX', { VerbForm: 'Fin' }, 4, 'cop'],
    ['в', 'в', 'ADP', {}, 4, 'case'],
    ['ярости', 'ярость', 'NOUN', { Case: 'Loc', Number: 'Sing' }, 0, 'root'],
    ['.', '.', 'PUNCT', {}, 4, 'punct'],
  ];
  assert.deepEqual(tellHits(text, subjectNoNumber), []);
});

test('tell: дополнительный case-токен у состояния отменяет finding', () => {
  const text = 'Он был в ярости с улыбкой.';
  const rows = [
    ['Он', 'он', 'PRON', { Case: 'Nom', Number: 'Sing' }, 4, 'nsubj'],
    ['был', 'быть', 'AUX', { VerbForm: 'Fin' }, 4, 'cop'],
    ['в', 'в', 'ADP', {}, 4, 'case'],
    ['ярости', 'ярость', 'NOUN', { Case: 'Loc', Number: 'Sing' }, 0, 'root'],
    ['с', 'с', 'ADP', {}, 4, 'case'],
    ['улыбкой', 'улыбка', 'NOUN', { Case: 'Ins', Number: 'Sing' }, 4, 'nmod'],
    ['.', '.', 'PUNCT', {}, 4, 'punct'],
  ];
  assert.deepEqual(tellHits(text, rows), []);
});
