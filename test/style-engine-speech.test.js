'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { speechRanges } = require('../src/speech');
const { analyzeStructural } = require('../src/style-engine/structural');

function sentence(text, start, rows) {
  let at = start;
  const tokens = rows.map(([word, lemma, upos, feats, head, deprel], i) => {
    const from = text.indexOf(word, at);
    if (from < 0) throw new Error(`fixture token not found: ${word}`);
    at = from + word.length;
    return { id: i + 1, text: word, lemma, upos, feats, head, deprel, start: from, end: from + word.length, confidence: null };
  });
  return { start, end: start + (text.slice(start).search(/\n\n|$/) >= 0 ? text.slice(start).search(/\n\n|$/) : 0), text: text.slice(start, start + text.slice(start).search(/\n\n|$/) || text.length), tokens };
}

function tellSentence(text, start, subject = 'Он') {
  return sentence(text, start, [
    [subject, subject === 'Она' ? 'она' : 'он', 'PRON', { Case: 'Nom', Gender: subject === 'Она' ? 'Fem' : 'Masc', Number: 'Sing' }, 2, 'nsubj'],
    ['почувствовал', 'почувствовать', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['страх', 'страх', 'NOUN', { Case: 'Acc', Gender: 'Masc', Number: 'Sing' }, 2, 'obj'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ]);
}

function authorEntry(text, start) {
  return sentence(text, start, [
    ['Он', 'он', 'PRON', { Case: 'Nom', Gender: 'Masc', Number: 'Sing' }, 2, 'nsubj'],
    ['вошёл', 'войти', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ]);
}

test('speech: реплика после авторского абзаца подавляет tell', () => {
  const text = 'Он вошёл.\n\n— Он почувствовал страх.';
  const dash = text.indexOf('—') + 2;
  const parsed = { sentences: [authorEntry(text, 0), tellSentence(text, dash)] };
  assert.deepEqual(speechRanges(text), [[dash, text.length]]);
  assert.deepEqual(analyzeStructural(text, parsed, { tell: true }).tell, []);
});

test('speech: авторский абзац после реплики снова анализируется', () => {
  const text = '— Он почувствовал страх.\n\nОн почувствовал страх.';
  const dash = text.indexOf('—') + 2;
  const second = text.indexOf('Он почувствовал страх.', 5);
  const parsed = { sentences: [tellSentence(text, dash), tellSentence(text, second)] };
  const hits = analyzeStructural(text, parsed, { tell: true }).tell;
  assert.equal(hits.length, 1);
  assert.equal(hits[0].fragment, 'почувствовал страх');
  assert.equal(hits[0].start, second + 'Он '.length);
  assert.equal(hits[0].fragment, text.slice(hits[0].start, hits[0].end));
});

test('speech: несколько последовательных абзацев диалога не объединяются', () => {
  const text = '— Он почувствовал страх.\n\n— Она почувствовала страх.';
  const ranges = speechRanges(text);
  assert.equal(ranges.length, 2);
  assert.ok(ranges[0][1] < ranges[1][0]);
  const parsed = { sentences: [tellSentence(text, ranges[0][0]), tellSentence(text, ranges[1][0], 'Она')] };
  assert.deepEqual(analyzeStructural(text, parsed, { tell: true }).tell, []);
});

test('speech: remark получает непустые диапазоны в тире-диалоге после авторского абзаца', () => {
  const text = 'Он вошёл.\n\n— Я не пойду, — сказал он, сказал он.';
  const dash = text.indexOf('—') + 2;
  assert.equal(speechRanges(text).length, 1);
  const parsed = { sentences: [authorEntry(text, 0), sentence(text, dash, [
    ['Я', 'я', 'PRON', { Case: 'Nom' }, 3, 'nsubj'],
    ['не', 'не', 'PART', {}, 3, 'advmod'],
    ['пойду', 'пойти', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    [',', ',', 'PUNCT', {}, 6, 'punct'],
    ['—', '—', 'PUNCT', {}, 6, 'punct'],
    ['сказал', 'сказать', 'VERB', { VerbForm: 'Fin' }, 3, 'parataxis'],
    ['он', 'он', 'PRON', { Case: 'Nom' }, 6, 'nsubj'],
    [',', ',', 'PUNCT', {}, 9, 'punct'],
    ['сказал', 'сказать', 'VERB', { VerbForm: 'Fin' }, 7, 'parataxis'],
    ['он', 'он', 'PRON', { Case: 'Nom' }, 9, 'nsubj'],
    ['.', '.', 'PUNCT', {}, 3, 'punct'],
  ])] };
  const hits = analyzeStructural(text, parsed, { remark: true }).remark;
  assert.equal(hits.length, 1);
  assert.equal(hits[0].fragment, 'сказал он, сказал он');
  assert.equal(hits[0].fragment, text.slice(hits[0].start, hits[0].end));
});

test('speech: кавычки сохраняются и исключают finding', () => {
  const text = 'Он сказал: «Я почувствовал страх».';
  assert.deepEqual(speechRanges(text), [[11, 33]]);
  const parsed = { sentences: [sentence(text, 0, [
    ['Он', 'он', 'PRON', { Case: 'Nom', Gender: 'Masc', Number: 'Sing' }, 2, 'nsubj'],
    ['сказал', 'сказать', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['«Я', '«я', 'PROPN', { Case: 'Nom' }, 5, 'nsubj'],
    ['почувствовал', 'почувствовать', 'VERB', { VerbForm: 'Fin' }, 2, 'parataxis'],
    ['страх»', 'страх»', 'PROPN', { Case: 'Acc' }, 5, 'obj'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ])] };
  assert.deepEqual(analyzeStructural(text, parsed, { tell: true }).tell, []);
});

test('speech: общий механизм исключения работает для redund и сохраняет offsets', () => {
  const text = '— Он вернулся обратно.\n\nОн вернулся обратно.';
  const dash = text.indexOf('—') + 2;
  const second = text.indexOf('Он вернулся обратно.', 5);
  const rows = (start) => [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
    ['вернулся', 'вернуться', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['обратно', 'обратно', 'ADV', {}, 2, 'advmod'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  const parsed = { sentences: [sentence(text, dash, rows(dash)), sentence(text, second, rows(second))] };
  const hits = analyzeStructural(text, parsed, { redund: true }).redund;
  assert.equal(hits.length, 1);
  assert.equal(hits[0].fragment, 'вернулся обратно');
  assert.equal(hits[0].start, second + 3);
  assert.equal(hits[0].fragment, text.slice(hits[0].start, hits[0].end));
});

function chainSentenceAt(text, start) {
  return sentence(text, start, [
    ['Осуществление', 'осуществление', 'NOUN', { Case: 'Nom' }, 0, 'root'],
    ['проверки', 'проверка', 'NOUN', { Case: 'Gen' }, 1, 'nmod'],
    ['выполнения', 'выполнение', 'NOUN', { Case: 'Gen' }, 2, 'nmod'],
    ['требований', 'требование', 'NOUN', { Case: 'Gen' }, 3, 'nmod'],
    ['.', '.', 'PUNCT', {}, 1, 'punct'],
  ]);
}

function whichSentenceAt(text, start) {
  return sentence(text, start, [
    ['Дом', 'дом', 'NOUN', { Case: 'Nom' }, 0, 'root'],
    [',', ',', 'PUNCT', {}, 4, 'punct'],
    ['который', 'который', 'PRON', { Case: 'Nom' }, 4, 'nsubj'],
    ['стоял', 'стоять', 'VERB', { VerbForm: 'Fin' }, 1, 'acl:relcl'],
    [',', ',', 'PUNCT', {}, 7, 'punct'],
    ['который', 'который', 'PRON', { Case: 'Nom' }, 7, 'nsubj'],
    ['видел', 'видеть', 'VERB', { VerbForm: 'Fin' }, 4, 'acl:relcl'],
    ['лес', 'лес', 'NOUN', { Case: 'Acc' }, 7, 'obj'],
    [',', ',', 'PUNCT', {}, 11, 'punct'],
    ['который', 'который', 'PRON', { Case: 'Nom' }, 11, 'nsubj'],
    ['шумел', 'шуметь', 'VERB', { VerbForm: 'Fin' }, 7, 'acl:relcl'],
    ['.', '.', 'PUNCT', {}, 1, 'punct'],
  ]);
}

test('speech: chain и which не отмечают прямую речь и работают в авторском абзаце', () => {
  const chainText = 'Он вошёл.\n\n— Осуществление проверки выполнения требований.';
  const chainStart = chainText.indexOf('—') + 2;
  const chainParsed = { sentences: [authorEntry(chainText, 0), chainSentenceAt(chainText, chainStart)] };
  assert.deepEqual(analyzeStructural(chainText, chainParsed, { chain: true }).chain, []);
  const chainAuthor = 'Осуществление проверки выполнения требований.';
  assert.equal(analyzeStructural(chainAuthor, { sentences: [chainSentenceAt(chainAuthor, 0)] }, { chain: true }).chain.length, 1);

  const whichText = 'Он вошёл.\n\n— Дом, который стоял, который видел лес, который шумел.';
  const whichStart = whichText.indexOf('—') + 2;
  const whichParsed = { sentences: [authorEntry(whichText, 0), whichSentenceAt(whichText, whichStart)] };
  assert.deepEqual(analyzeStructural(whichText, whichParsed, { which: true }).which, []);
  const whichAuthor = 'Дом, который стоял, который видел лес, который шумел.';
  assert.equal(analyzeStructural(whichAuthor, { sentences: [whichSentenceAt(whichAuthor, 0)] }, { which: true }).which.length, 1);
});
