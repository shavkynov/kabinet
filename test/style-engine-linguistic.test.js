'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Schema } = require('prosemirror-model');
const { createDocumentSnapshot } = require('../src/style-engine/pm-ranges');
const { mapUdPos, findUdPassive, analyzeUdTenseBlock, buildLinguisticBlocks } = require('../src/style-engine/linguistic');
const { repeatPairs } = require('../src/editing');

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline' },
  },
  marks: {},
});

function makeDoc(paragraphs) {
  return schema.node('doc', null, paragraphs.map((p) => schema.node('paragraph', null, p ? [schema.text(p)] : [])));
}

function makeTokens(text, specs) {
  let cursor = 0;
  return specs.map(([word, lemma, upos, feats, head, deprel], idx) => {
    const start = text.indexOf(word, cursor);
    assert.ok(start >= 0, `не найден токен «${word}» в «${text}»`);
    cursor = start + word.length;
    return { id: idx + 1, text: word, lemma, upos, feats, head, deprel, start, end: cursor };
  });
}

test('mapUdPos: отображает все основные части речи UD и фильтрует пунктуацию', () => {
  assert.equal(mapUdPos({ text: 'бежал', upos: 'VERB', feats: { VerbForm: 'Fin' } }), 'verb');
  assert.equal(mapUdPos({ text: 'бегущий', upos: 'VERB', feats: { VerbForm: 'Part' } }), 'part');
  assert.equal(mapUdPos({ text: 'думая', upos: 'VERB', feats: { VerbForm: 'Conv' } }), 'part');
  assert.equal(mapUdPos({ text: 'открытый', upos: 'ADJ', feats: { VerbForm: 'Part' } }), 'part');
  assert.equal(mapUdPos({ text: 'был', upos: 'AUX', feats: { VerbForm: 'Fin' } }), 'verb');
  assert.equal(mapUdPos({ text: 'бы', upos: 'AUX', feats: { Mood: 'Cnd' } }), 'func');
  assert.equal(mapUdPos({ text: 'Иван', upos: 'PROPN', feats: {} }), 'noun');
  assert.equal(mapUdPos({ text: 'дом', upos: 'NOUN', feats: {} }), 'noun');
  assert.equal(mapUdPos({ text: 'старый', upos: 'ADJ', feats: {} }), 'adj');
  assert.equal(mapUdPos({ text: 'тихо', upos: 'ADV', feats: {} }), 'adv');
  assert.equal(mapUdPos({ text: 'свой', upos: 'DET', feats: {} }), 'pron');
  assert.equal(mapUdPos({ text: 'он', upos: 'PRON', feats: {} }), 'pron');
  assert.equal(mapUdPos({ text: 'три', upos: 'NUM', feats: {} }), 'num');
  assert.equal(mapUdPos({ text: 'через', upos: 'ADP', feats: {} }), 'func');
  assert.equal(mapUdPos({ text: '—', upos: 'PUNCT', feats: {} }), null);
  assert.equal(mapUdPos({ text: ',', upos: 'PUNCT', feats: {} }), null);
});

test('findUdPassive: находит аналитический и возвратный пассив и исключает состояния и псевдопассив', () => {
  const s1 = 'Дверь была открыта ключом.';
  const p1 = findUdPassive({
    start: 0,
    end: s1.length,
    tokens: makeTokens(s1, [
      ['Дверь', 'дверь', 'NOUN', { Case: 'Nom' }, 3, 'nsubj:pass'],
      ['была', 'быть', 'AUX', { VerbForm: 'Fin', Tense: 'Past' }, 3, 'aux:pass'],
      ['открыта', 'открыть', 'VERB', { VerbForm: 'Part', Voice: 'Pass', Variant: 'Short' }, 0, 'root'],
      ['ключом', 'ключ', 'NOUN', { Case: 'Ins' }, 3, 'obl'],
      ['.', '.', 'PUNCT', {}, 3, 'punct'],
    ]),
  }, s1);
  assert.deepEqual(p1.map((x) => s1.slice(x.start, x.end)), ['была открыта']);

  const s2 = 'Дом строился рабочими.';
  const p2 = findUdPassive({
    start: 0,
    end: s2.length,
    tokens: makeTokens(s2, [
      ['Дом', 'дом', 'NOUN', { Case: 'Nom' }, 2, 'nsubj:pass'],
      ['строился', 'строиться', 'VERB', { VerbForm: 'Fin', Voice: 'Pass' }, 0, 'root'],
      ['рабочими', 'рабочий', 'NOUN', { Case: 'Ins' }, 2, 'obl:agent'],
      ['.', '.', 'PUNCT', {}, 2, 'punct'],
    ]),
  }, s2);
  assert.deepEqual(p2.map((x) => s2.slice(x.start, x.end)), ['строился рабочими']);

  // Состояние («была влюблена»), творительный времени («годами») и личное местоимение («он улыбнулся») не считаются.
  const s3 = 'Она была влюблена. Дом строился годами. Он улыбнулся улыбкой.';
  assert.deepEqual(findUdPassive({
    start: 0,
    end: 19,
    tokens: makeTokens('Она была влюблена.', [
      ['Она', 'она', 'PRON', { Case: 'Nom' }, 3, 'nsubj'],
      ['была', 'быть', 'AUX', { VerbForm: 'Fin' }, 3, 'cop'],
      ['влюблена', 'влюбленный', 'ADJ', { VerbForm: 'Part', Voice: 'Pass', Variant: 'Short' }, 0, 'root'],
      ['.', '.', 'PUNCT', {}, 3, 'punct'],
    ]),
  }, 'Она была влюблена.'), []);

  const g = 'Дом строился годами.';
  assert.deepEqual(findUdPassive({
    start: 0,
    end: g.length,
    tokens: makeTokens(g, [
      ['Дом', 'дом', 'NOUN', { Case: 'Nom' }, 2, 'nsubj'],
      ['строился', 'строиться', 'VERB', { VerbForm: 'Fin', Voice: 'Pass' }, 0, 'root'],
      ['годами', 'год', 'NOUN', { Case: 'Ins' }, 2, 'obl'],
      ['.', '.', 'PUNCT', {}, 2, 'punct'],
    ]),
  }, g), []);

  const pr = 'Он улыбнулся широкой улыбкой.';
  assert.deepEqual(findUdPassive({
    start: 0,
    end: pr.length,
    tokens: makeTokens(pr, [
      ['Он', 'он', 'PRON', { Case: 'Nom', PronType: 'Prs' }, 2, 'nsubj'],
      ['улыбнулся', 'улыбнуться', 'VERB', { VerbForm: 'Fin', Voice: 'Pass' }, 0, 'root'],
      ['широкой', 'широкий', 'ADJ', { Case: 'Ins' }, 4, 'amod'],
      ['улыбкой', 'улыбка', 'NOUN', { Case: 'Ins' }, 2, 'obl'],
      ['.', '.', 'PUNCT', {}, 2, 'punct'],
    ]),
  }, pr), []);
});

test('analyzeUdTenseBlock: учитывает главные сказуемые и исключает придаточные, будущее, речь и воспоминания', () => {
  const s1 = 'Он знал, что она любит его, и уходит тихо.';
  const r1 = analyzeUdTenseBlock(s1, [{
    start: 0,
    end: s1.length,
    tokens: makeTokens(s1, [
      ['Он', 'он', 'PRON', { Case: 'Nom', PronType: 'Prs' }, 2, 'nsubj'],
      ['знал', 'знать', 'VERB', { VerbForm: 'Fin', Tense: 'Past', Mood: 'Ind' }, 0, 'root'],
      [',', ',', 'PUNCT', {}, 5, 'punct'],
      ['что', 'что', 'SCONJ', {}, 5, 'mark'],
      ['она', 'она', 'PRON', { Case: 'Nom', PronType: 'Prs' }, 5, 'nsubj'],
      ['любит', 'любить', 'VERB', { VerbForm: 'Fin', Tense: 'Pres', Aspect: 'Imp', Mood: 'Ind' }, 2, 'ccomp'],
      ['его', 'он', 'PRON', {}, 5, 'obj'],
      [',', ',', 'PUNCT', {}, 9, 'punct'],
      ['и', 'и', 'CCONJ', {}, 10, 'cc'],
      ['уходит', 'уходить', 'VERB', { VerbForm: 'Fin', Tense: 'Pres', Aspect: 'Imp', Mood: 'Ind' }, 2, 'conj'],
      ['тихо', 'тихо', 'ADV', {}, 10, 'advmod'],
      ['.', '.', 'PUNCT', {}, 2, 'punct'],
    ]),
  }], 0);
  assert.equal(r1.past, 1);
  assert.equal(r1.present, 1);
  assert.deepEqual(r1.items.map((x) => [s1.slice(x.start, x.end), x.kind, x.conf, x.why]), [
    ['знал', 'past', 'high', 'mixed'],
    ['уходит', 'present', 'high', 'mixed'],
  ]);

  // Будущее время (совершенный вид Pres+Perf и AUX+Inf), сослагательное («пришёл бы») и прямая речь пропускаются.
  const s2 = 'Он придёт и будет читать, но не ушёл бы. «Она смотрит», — сказал он. Вчера она ушла домой.';
  const part1 = 'Он придёт и будет читать, но не ушёл бы.';
  const part2 = '«Она смотрит», — сказал он.';
  const part3 = 'Вчера она ушла домой.';
  const p2Off = s2.indexOf(part2);
  const p3Off = s2.indexOf(part3);
  const r2 = analyzeUdTenseBlock(s2, [
    {
      start: 0,
      end: part1.length,
      tokens: makeTokens(part1, [
        ['Он', 'он', 'PRON', { Case: 'Nom', PronType: 'Prs' }, 2, 'nsubj'],
        ['придёт', 'прийти', 'VERB', { VerbForm: 'Fin', Tense: 'Pres', Aspect: 'Perf', Mood: 'Ind' }, 0, 'root'],
        ['и', 'и', 'CCONJ', {}, 4, 'cc'],
        ['будет', 'быть', 'AUX', { VerbForm: 'Fin', Tense: 'Fut' }, 5, 'aux'],
        ['читать', 'читать', 'VERB', { VerbForm: 'Inf' }, 2, 'conj'],
        [',', ',', 'PUNCT', {}, 9, 'punct'],
        ['но', 'но', 'CCONJ', {}, 9, 'cc'],
        ['не', 'не', 'PART', {}, 9, 'advmod'],
        ['ушёл', 'уйти', 'VERB', { VerbForm: 'Fin', Tense: 'Past', Mood: 'Ind' }, 2, 'conj'],
        ['бы', 'бы', 'AUX', { Mood: 'Cnd' }, 9, 'aux'],
        ['.', '.', 'PUNCT', {}, 2, 'punct'],
      ]),
    },
    {
      start: p2Off,
      end: p2Off + part2.length,
      tokens: makeTokens(part2, [
        ['«', '«', 'PUNCT', {}, 2, 'punct'],
        ['Она', 'она', 'PRON', { PronType: 'Prs' }, 3, 'nsubj'],
        ['смотрит', 'смотреть', 'VERB', { VerbForm: 'Fin', Tense: 'Pres', Aspect: 'Imp' }, 0, 'root'],
        ['»', '»', 'PUNCT', {}, 3, 'punct'],
        [',', ',', 'PUNCT', {}, 6, 'punct'],
        ['—', '—', 'PUNCT', {}, 7, 'punct'],
        ['сказал', 'сказать', 'VERB', { VerbForm: 'Fin', Tense: 'Past' }, 3, 'parataxis'],
        ['он', 'он', 'PRON', { PronType: 'Prs' }, 7, 'nsubj'],
        ['.', '.', 'PUNCT', {}, 3, 'punct'],
      ]).map((t) => ({ ...t, start: t.start + p2Off, end: t.end + p2Off })),
    },
    {
      start: p3Off,
      end: p3Off + part3.length,
      tokens: makeTokens(part3, [
        ['Вчера', 'вчера', 'ADV', {}, 3, 'advmod'],
        ['она', 'она', 'PRON', { PronType: 'Prs' }, 3, 'nsubj'],
        ['ушла', 'уйти', 'VERB', { VerbForm: 'Fin', Tense: 'Past' }, 0, 'root'],
        ['домой', 'домой', 'ADV', {}, 3, 'advmod'],
        ['.', '.', 'PUNCT', {}, 3, 'punct'],
      ]).map((t) => ({ ...t, start: t.start + p3Off, end: t.end + p3Off })),
    },
  ], 0);
  assert.equal(r2.past, 1); // только «сказал» в словах автора
  assert.equal(r2.present, 0);
  assert.equal(s2.slice(r2.items[0].start, r2.items[0].end), 'сказал');
});

test('repeatPairs: леммы объединяют разные основы и исключают все формы имён PROPN', () => {
  // «люди» (4 буквы) и «человека» имеют общую лемму «человек» (≥ 5 букв)
  const pairs = repeatPairs([
    { text: 'Люди', lemma: 'человек', pos: 'noun', proper: false },
    { text: 'шли', lemma: 'идти', pos: 'verb', proper: false },
    { text: 'мимо', lemma: 'мимо', pos: 'func', proper: false },
    { text: 'человека', lemma: 'человек', pos: 'noun', proper: false },
  ], 10);
  assert.deepEqual(pairs, [[0, 3]]);

  // PROPN в середине и в начале предложения (включая разные падежи) не считаются повторами
  const properPairs = repeatPairs([
    { text: 'Маша', lemma: 'маша', pos: 'noun', proper: true },
    { text: 'видела', lemma: 'видеть', pos: 'verb', proper: false },
    { text: 'Машу', lemma: 'маша', pos: 'noun', proper: false },
    { text: 'дома', lemma: 'дом', pos: 'noun', proper: false },
    { text: 'Иван', lemma: 'иван', pos: 'noun', proper: true },
    { text: 'позвал', lemma: 'позвать', pos: 'verb', proper: false },
    { text: 'Ивана', lemma: 'иван', pos: 'noun', proper: false },
  ], 20);
  assert.deepEqual(properPairs, []);
});

test('buildLinguisticBlocks: маппинг многоабзацного ProseMirror-документа и fail-closed при изменении doc', () => {
  const doc1 = makeDoc(['Он вошёл.', 'Дверь была открыта ключом.']);
  const doc2 = makeDoc(['Он вышел.', 'Дверь была открыта ключом.']);
  const snapshot = createDocumentSnapshot(doc1);
  // snapshot.text === "Он вошёл.\n\nДверь была открыта ключом."
  const p1 = 'Он вошёл.';
  const p2Start = snapshot.text.indexOf('Дверь');
  const p2 = 'Дверь была открыта ключом.';
  const parse = {
    schemaVersion: 1,
    sentences: [
      {
        start: 0,
        end: p1.length,
        tokens: makeTokens(p1, [
          ['Он', 'он', 'PRON', { Case: 'Nom', PronType: 'Prs' }, 2, 'nsubj'],
          ['вошёл', 'войти', 'VERB', { VerbForm: 'Fin', Tense: 'Past' }, 0, 'root'],
          ['.', '.', 'PUNCT', {}, 2, 'punct'],
        ]),
      },
      {
        start: p2Start,
        end: p2Start + p2.length,
        tokens: makeTokens(p2, [
          ['Дверь', 'дверь', 'NOUN', { Case: 'Nom' }, 3, 'nsubj:pass'],
          ['была', 'быть', 'AUX', { VerbForm: 'Fin', Tense: 'Past' }, 3, 'aux:pass'],
          ['открыта', 'открыть', 'VERB', { VerbForm: 'Part', Voice: 'Pass', Variant: 'Short' }, 0, 'root'],
          ['ключом', 'ключ', 'NOUN', { Case: 'Ins' }, 3, 'obl'],
          ['.', '.', 'PUNCT', {}, 3, 'punct'],
        ]).map((t) => ({ ...t, start: t.start + p2Start, end: t.end + p2Start })),
      },
    ],
  };

  assert.equal(buildLinguisticBlocks(snapshot, parse, doc2), null);

  const blocks = buildLinguisticBlocks(snapshot, parse, doc1);
  assert.ok(blocks instanceof Map);
  const seg1 = blocks.get(snapshot.segments[0].pmStart);
  const seg2 = blocks.get(snapshot.segments[1].pmStart);
  assert.equal(seg1.words.length, 2);
  assert.equal(doc1.textBetween(seg1.words[1].from, seg1.words[1].to, '', ''), 'вошёл');
  assert.equal(seg1.tense.past, 1);
  assert.equal(seg2.passive.length, 1);
  assert.equal(doc1.textBetween(seg2.passive[0].from, seg2.passive[0].to, '', ''), 'была открыта');
});
