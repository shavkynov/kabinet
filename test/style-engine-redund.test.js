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

const redundHits = (text, rows) => analyzeStructural(text, parse(text, rows), { redund: true }).redund;

test('redund: направленный плеоназм «вернулся обратно»', () => {
  const text = 'Он вернулся обратно.';
  const rows = [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
    ['вернулся', 'вернуться', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['обратно', 'обратно', 'ADV', {}, 2, 'advmod'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  const found = redundHits(text, rows);
  assert.equal(found.length, 1);
  assert.equal(found[0].fragment, 'вернулся обратно');
  assert.equal(found[0].ruleId, 'redund.directional-pleonasm');
  assert.equal(found[0].confidence, 'low');
  assert.equal(found[0].fragment, text.slice(found[0].start, found[0].end));
});

test('redund: направленные пары поднялся наверх / вошёл внутрь', () => {
  const t1 = 'Он поднялся наверх.';
  const r1 = [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
    ['поднялся', 'подняться', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['наверх', 'наверх', 'ADV', {}, 2, 'advmod'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  assert.equal(redundHits(t1, r1)[0].fragment, 'поднялся наверх');
  const t2 = 'Он вошёл внутрь.';
  const r2 = [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
    ['вошёл', 'войти', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['внутрь', 'внутрь', 'ADV', {}, 2, 'advmod'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  assert.equal(redundHits(t2, r2)[0].fragment, 'вошёл внутрь');
});

test('redund: обычное направление без плеоназма не срабатывает', () => {
  const text = 'Он посмотрел вверх.';
  const rows = [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
    ['посмотрел', 'посмотреть', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['вверх', 'вверх', 'ADV', {}, 2, 'advmod'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  assert.deepEqual(redundHits(text, rows), []);
  const text2 = 'Он вернулся домой.';
  const rows2 = [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
    ['вернулся', 'вернуться', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['домой', 'домой', 'ADV', {}, 2, 'advmod'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  assert.deepEqual(redundHits(text2, rows2), []);
});

test('redund: тавтологическая пара «памятный сувенир»', () => {
  const text = 'Он купил памятный сувенир.';
  const rows = [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
    ['купил', 'купить', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['памятный', 'памятный', 'ADJ', { Case: 'Acc', Gender: 'Masc', Number: 'Sing' }, 4, 'amod'],
    ['сувенир', 'сувенир', 'NOUN', { Case: 'Acc', Gender: 'Masc', Number: 'Sing' }, 2, 'obj'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  const found = redundHits(text, rows);
  assert.equal(found.length, 1);
  assert.equal(found[0].fragment, 'памятный сувенир');
  assert.equal(found[0].ruleId, 'redund.tautological-pair');
});

test('redund: тавтологическая пара «период времени»', () => {
  const text = 'Прошёл период времени.';
  const rows = [
    ['Прошёл', 'пройти', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['период', 'период', 'NOUN', { Case: 'Nom', Gender: 'Masc', Number: 'Sing' }, 1, 'nsubj'],
    ['времени', 'время', 'NOUN', { Case: 'Gen', Gender: 'Neut', Number: 'Sing' }, 2, 'nmod'],
    ['.', '.', 'PUNCT', {}, 1, 'punct'],
  ];
  assert.equal(redundHits(text, rows)[0].fragment, 'период времени');
});

test('redund: тавтологическая пара «биография жизни»', () => {
  const text = 'Он написал биографию жизни.';
  const rows = [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
    ['написал', 'написать', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['биографию', 'биография', 'NOUN', { Case: 'Acc', Gender: 'Fem', Number: 'Sing' }, 2, 'obj'],
    ['жизни', 'жизнь', 'NOUN', { Case: 'Gen', Gender: 'Fem', Number: 'Sing' }, 3, 'nmod'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  assert.equal(redundHits(text, rows)[0].fragment, 'биографию жизни');
});

test('redund: свободная вакансия / взаимное сотрудничество / первый дебют / главный приоритет', () => {
  const cases = [
    ['Открылась свободная вакансия.', [
      ['Открылась', 'открыться', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
      ['свободная', 'свободный', 'ADJ', { Case: 'Nom', Gender: 'Fem', Number: 'Sing' }, 3, 'amod'],
      ['вакансия', 'вакансия', 'NOUN', { Case: 'Nom', Gender: 'Fem', Number: 'Sing' }, 1, 'nsubj'],
      ['.', '.', 'PUNCT', {}, 1, 'punct'],
    ], 'свободная вакансия'],
    ['Это взаимное сотрудничество.', [
      ['Это', 'это', 'PRON', { Case: 'Nom' }, 0, 'root'],
      ['взаимное', 'взаимный', 'ADJ', { Case: 'Nom', Gender: 'Neut', Number: 'Sing' }, 3, 'amod'],
      ['сотрудничество', 'сотрудничество', 'NOUN', { Case: 'Nom', Gender: 'Neut', Number: 'Sing' }, 1, 'nsubj'],
      ['.', '.', 'PUNCT', {}, 1, 'punct'],
    ], 'взаимное сотрудничество'],
    ['Это был первый дебют.', [
      ['Это', 'это', 'PRON', { Case: 'Nom' }, 0, 'root'],
      ['был', 'быть', 'AUX', { VerbForm: 'Fin' }, 4, 'cop'],
      ['первый', 'первый', 'ADJ', { Case: 'Nom', Gender: 'Masc', Number: 'Sing' }, 4, 'amod'],
      ['дебют', 'дебют', 'NOUN', { Case: 'Nom', Gender: 'Masc', Number: 'Sing' }, 1, 'nsubj'],
      ['.', '.', 'PUNCT', {}, 1, 'punct'],
    ], 'первый дебют'],
    ['Главный приоритет — безопасность.', [
      ['Главный', 'главный', 'ADJ', { Case: 'Nom', Gender: 'Masc', Number: 'Sing' }, 2, 'amod'],
      ['приоритет', 'приоритет', 'NOUN', { Case: 'Nom', Gender: 'Masc', Number: 'Sing' }, 0, 'root'],
      ['—', '—', 'PUNCT', {}, 2, 'punct'],
      ['безопасность', 'безопасность', 'NOUN', { Case: 'Nom', Gender: 'Fem', Number: 'Sing' }, 2, 'nsubj'],
      ['.', '.', 'PUNCT', {}, 2, 'punct'],
    ], 'Главный приоритет'],
  ];
  for (const [text, rows, expected] of cases) assert.equal(redundHits(text, rows)[0].fragment, expected, text);
});

test('redund: похожие, но не тавтологические пары не срабатывают', () => {
  const cases = [
    ['Он купил памятный подарок.', [
      ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
      ['купил', 'купить', 'VERB', {}, 0, 'root'],
      ['памятный', 'памятный', 'ADJ', { Case: 'Acc', Gender: 'Masc', Number: 'Sing' }, 4, 'amod'],
      ['подарок', 'подарок', 'NOUN', { Case: 'Acc', Gender: 'Masc', Number: 'Sing' }, 2, 'obj'],
      ['.', '.', 'PUNCT', {}, 2, 'punct'],
    ]],
    ['Свободный человек вошёл.', [
      ['Свободный', 'свободный', 'ADJ', { Case: 'Nom', Gender: 'Masc', Number: 'Sing' }, 2, 'amod'],
      ['человек', 'человек', 'NOUN', { Case: 'Nom', Gender: 'Masc', Number: 'Sing' }, 3, 'nsubj'],
      ['вошёл', 'войти', 'VERB', {}, 0, 'root'],
      ['.', '.', 'PUNCT', {}, 3, 'punct'],
    ]],
    ['У них взаимная любовь.', [
      ['У', 'у', 'ADP', {}, 4, 'case'],
      ['них', 'они', 'PRON', { Case: 'Gen' }, 4, 'obl'],
      ['взаимная', 'взаимный', 'ADJ', { Case: 'Nom', Gender: 'Fem', Number: 'Sing' }, 4, 'amod'],
      ['любовь', 'любовь', 'NOUN', { Case: 'Nom', Gender: 'Fem', Number: 'Sing' }, 0, 'root'],
      ['.', '.', 'PUNCT', {}, 4, 'punct'],
    ]],
    ['Первый день прошёл.', [
      ['Первый', 'первый', 'ADJ', { Case: 'Nom', Gender: 'Masc', Number: 'Sing' }, 2, 'amod'],
      ['день', 'день', 'NOUN', { Case: 'Nom', Gender: 'Masc', Number: 'Sing' }, 3, 'nsubj'],
      ['прошёл', 'пройти', 'VERB', {}, 0, 'root'],
      ['.', '.', 'PUNCT', {}, 3, 'punct'],
    ]],
    ['Главный герой ушёл.', [
      ['Главный', 'главный', 'ADJ', { Case: 'Nom', Gender: 'Masc', Number: 'Sing' }, 2, 'amod'],
      ['герой', 'герой', 'NOUN', { Case: 'Nom', Gender: 'Masc', Number: 'Sing' }, 3, 'nsubj'],
      ['ушёл', 'уйти', 'VERB', {}, 0, 'root'],
      ['.', '.', 'PUNCT', {}, 3, 'punct'],
    ]],
    ['Период отпуска закончился.', [
      ['Период', 'период', 'NOUN', { Case: 'Nom', Gender: 'Masc', Number: 'Sing' }, 3, 'nsubj'],
      ['отпуска', 'отпуск', 'NOUN', { Case: 'Gen', Gender: 'Masc', Number: 'Sing' }, 1, 'nmod'],
      ['закончился', 'закончиться', 'VERB', {}, 0, 'root'],
      ['.', '.', 'PUNCT', {}, 3, 'punct'],
    ]],
    ['Биография писателя вышла.', [
      ['Биография', 'биография', 'NOUN', { Case: 'Nom', Gender: 'Fem', Number: 'Sing' }, 3, 'nsubj'],
      ['писателя', 'писатель', 'NOUN', { Case: 'Gen', Gender: 'Masc', Number: 'Sing' }, 1, 'nmod'],
      ['вышла', 'выйти', 'VERB', {}, 0, 'root'],
      ['.', '.', 'PUNCT', {}, 3, 'punct'],
    ]],
  ];
  for (const [text, rows] of cases) assert.deepEqual(redundHits(text, rows), [], text);
});

test('redund: намеренный повтор не является избыточностью', () => {
  const cases = [
    ['Он сказал, что сказал.', [
      ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
      ['сказал', 'сказать', 'VERB', {}, 0, 'root'],
      [',', ',', 'PUNCT', {}, 2, 'punct'],
      ['что', 'что', 'SCONJ', {}, 5, 'mark'],
      ['сказал', 'сказать', 'VERB', {}, 2, 'ccomp'],
      ['.', '.', 'PUNCT', {}, 2, 'punct'],
    ]],
    ['Он шёл и шёл.', [
      ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
      ['шёл', 'идти', 'VERB', {}, 0, 'root'],
      ['и', 'и', 'CCONJ', {}, 4, 'cc'],
      ['шёл', 'идти', 'VERB', {}, 2, 'conj'],
      ['.', '.', 'PUNCT', {}, 2, 'punct'],
    ]],
    ['Дом был домом.', [
      ['Дом', 'дом', 'NOUN', { Case: 'Nom' }, 4, 'nsubj'],
      ['был', 'быть', 'AUX', {}, 4, 'cop'],
      ['домом', 'дом', 'NOUN', { Case: 'Ins' }, 0, 'root'],
      ['.', '.', 'PUNCT', {}, 4, 'punct'],
    ]],
  ];
  for (const [text, rows] of cases) assert.deepEqual(redundHits(text, rows), [], text);
});

test('redund: эмфаза и контраст отменяют тавтологическую пару', () => {
  const emphasis = 'Самый главный приоритет — безопасность.';
  const eRows = [
    ['Самый', 'самый', 'ADV', {}, 3, 'advmod'],
    ['главный', 'главный', 'ADJ', { Case: 'Nom', Gender: 'Masc', Number: 'Sing' }, 4, 'amod'],
    ['приоритет', 'приоритет', 'NOUN', { Case: 'Nom', Gender: 'Masc', Number: 'Sing' }, 0, 'root'],
    ['—', '—', 'PUNCT', {}, 3, 'punct'],
    ['безопасность', 'безопасность', 'NOUN', { Case: 'Nom', Gender: 'Fem', Number: 'Sing' }, 3, 'nsubj'],
    ['.', '.', 'PUNCT', {}, 3, 'punct'],
  ];
  assert.deepEqual(redundHits(emphasis, eRows), []);
  const contrast = 'Именно памятный сувенир был куплен.';
  const cRows = [
    ['Именно', 'именно', 'PART', {}, 3, 'advmod'],
    ['памятный', 'памятный', 'ADJ', { Case: 'Nom', Gender: 'Masc', Number: 'Sing' }, 4, 'amod'],
    ['сувенир', 'сувенир', 'NOUN', { Case: 'Nom', Gender: 'Masc', Number: 'Sing' }, 4, 'nsubj'],
    ['был', 'быть', 'AUX', {}, 4, 'cop'],
    ['куплен', 'купить', 'VERB', {}, 0, 'root'],
    ['.', '.', 'PUNCT', {}, 4, 'punct'],
  ];
  assert.deepEqual(redundHits(contrast, cRows), []);
});

test('redund: цитата не даёт finding', () => {
  const text = '«Он вернулся обратно.»';
  const rows = [
    ['«', '«', 'PUNCT', {}, 2, 'punct'],
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 3, 'nsubj'],
    ['вернулся', 'вернуться', 'VERB', {}, 0, 'root'],
    ['обратно', 'обратно', 'ADV', {}, 3, 'advmod'],
    ['.', '.', 'PUNCT', {}, 3, 'punct'],
    ['»', '»', 'PUNCT', {}, 3, 'punct'],
  ];
  assert.deepEqual(redundHits(text, rows), []);
});

test('redund: emoji и UTF-16 offsets', () => {
  const text = '😀 Он вернулся обратно.';
  const rows = [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
    ['вернулся', 'вернуться', 'VERB', {}, 0, 'root'],
    ['обратно', 'обратно', 'ADV', {}, 2, 'advmod'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  const found = redundHits(text, rows);
  assert.equal(found.length, 1);
  assert.equal(found[0].fragment, 'вернулся обратно');
  assert.equal(found[0].start, text.indexOf('вернулся'));
  assert.equal(found[0].fragment, text.slice(found[0].start, found[0].end));
});

test('redund: повреждённые данные и неполная морфология не дают finding', () => {
  const text = 'Он купил памятный сувенир.';
  const damaged = [
    ['Он', 'он', 'PRON', {}, 2, 'nsubj'],
    ['купил', 'купить', 'VERB', {}, 99, 'root'],
    ['памятный', 'памятный', 'ADJ', {}, 4, 'amod'],
    ['сувенир', 'сувенир', 'NOUN', {}, 2, 'obj'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  assert.doesNotThrow(() => redundHits(text, damaged));
  assert.deepEqual(redundHits(text, damaged), []);
  const noCase = [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
    ['купил', 'купить', 'VERB', {}, 0, 'root'],
    ['памятный', 'памятный', 'ADJ', { Gender: 'Masc', Number: 'Sing' }, 4, 'amod'],
    ['сувенир', 'сувенир', 'NOUN', { Gender: 'Masc', Number: 'Sing' }, 2, 'obj'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  assert.deepEqual(redundHits(text, noCase), []);
});

test('redund: obj/nsubj для направленного слова не считаются обстоятельством', () => {
  const objText = 'Он вернулся обратно.';
  const objRows = [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
    ['вернулся', 'вернуться', 'VERB', {}, 0, 'root'],
    ['обратно', 'обратно', 'ADV', {}, 2, 'obj'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  assert.deepEqual(redundHits(objText, objRows), []);
  const nsubjText = 'Он поднялся наверх.';
  const nsubjRows = [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
    ['поднялся', 'подняться', 'VERB', {}, 0, 'root'],
    ['наверх', 'наверх', 'NOUN', { Case: 'Nom' }, 2, 'nsubj'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ];
  assert.deepEqual(redundHits(nsubjText, nsubjRows), []);
});

test('redund: все направленные пары с advmod сохраняются', () => {
  const cases = [
    ['Он вернулся обратно.', 'вернулся', 'вернуться', 'обратно', 'ADV'],
    ['Он поднялся наверх.', 'поднялся', 'подняться', 'наверх', 'ADV'],
    ['Он спустился вниз.', 'спустился', 'спуститься', 'вниз', 'ADV'],
    ['Он вошёл внутрь.', 'вошёл', 'войти', 'внутрь', 'ADV'],
    ['Он вышел наружу.', 'вышел', 'выйти', 'наружу', 'ADV'],
    ['Он упал вниз.', 'упал', 'упасть', 'вниз', 'ADV'],
  ];
  for (const [text, verb, lemma, adverb, upos] of cases) {
    const rows = [
      ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
      [verb, lemma, 'VERB', {}, 0, 'root'],
      [adverb, adverb, upos, {}, 2, 'advmod'],
      ['.', '.', 'PUNCT', {}, 2, 'punct'],
    ];
    const found = redundHits(text, rows);
    assert.equal(found.length, 1, text);
    assert.equal(found[0].fragment, `${verb} ${adverb}`, text);
    assert.equal(found[0].fragment, text.slice(found[0].start, found[0].end), text);
  }
});
