'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CATEGORIES, codePointOffsetToUtf16, validateParseResult, validateFinding } = require('../src/style-engine/contract');
const corpus = require('./fixtures/style-engine/parser-challenge.json');

test('parser challenge seed: уникальные кейсы и корректная разметка границ предложений', () => {
  assert.equal(corpus.corpusVersion, 1);
  assert.equal(corpus.cases.length, 18);
  const ids = new Set();
  for (const item of corpus.cases) {
    assert.ok(!ids.has(item.id), `повтор ID ${item.id}`);
    ids.add(item.id);
    assert.ok(item.text.length > 0);
    assert.ok(item.expectedSentences.length > 0);
    assert.equal(item.expectedSentences.join(''), item.text, `${item.id}: сегменты должны точно покрывать текст без потерь/вставок`);
  }
});

test('UTF-16 offsets: code point offset переводится корректно для кириллицы и supplementary Unicode', () => {
  const text = 'А😀Б';
  assert.equal(codePointOffsetToUtf16(text, 0), 0);
  assert.equal(codePointOffsetToUtf16(text, 1), 1);
  assert.equal(codePointOffsetToUtf16(text, 2), 3);
  assert.equal(codePointOffsetToUtf16(text, 3), 4);
  assert.throws(() => codePointOffsetToUtf16(text, 4), RangeError);
});

test('parse contract: принимает валидное дерево и сохраняет точные UTF-16 offsets', () => {
  const text = 'Он открыл дверь.';
  const result = {
    schemaVersion: 1,
    parser: { name: 'fixture-parser', version: '0.0.0' },
    sentences: [{
      start: 0, end: text.length, text,
      tokens: [
        { id: 1, text: 'Он', lemma: 'он', upos: 'PRON', feats: { Case: 'Nom' }, head: 2, deprel: 'nsubj', start: 0, end: 2, confidence: null },
        { id: 2, text: 'открыл', lemma: 'открыть', upos: 'VERB', feats: { VerbForm: 'Fin' }, head: 0, deprel: 'root', start: 3, end: 9, confidence: null },
        { id: 3, text: 'дверь', lemma: 'дверь', upos: 'NOUN', feats: { Case: 'Acc' }, head: 2, deprel: 'obj', start: 10, end: 14, confidence: null },
        { id: 4, text: '.', lemma: '.', upos: 'PUNCT', feats: {}, head: 2, deprel: 'punct', start: 14, end: 15, confidence: null }
      ]
    }]
  };
  assert.deepEqual(validateParseResult(text, result), { valid: true, errors: [] });
});

test('parse contract: отклоняет неверные offsets, head и отсутствующую лемму', () => {
  const text = 'Он открыл дверь.';
  const result = {
    schemaVersion: 1, parser: { name: 'fixture', version: '1' },
    sentences: [{ start: 0, end: text.length, text, tokens: [
      { id: 1, text: 'Он', lemma: '', upos: 'PRON', feats: {}, head: 9, deprel: 'nsubj', start: 0, end: 3 },
    ] }]
  };
  const checked = validateParseResult(text, result);
  assert.equal(checked.valid, false);
  assert.ok(checked.errors.some((e) => e.path.endsWith('.lemma')));
  assert.ok(checked.errors.some((e) => e.path.endsWith('.head')));
  assert.ok(checked.errors.some((e) => e.path.endsWith('.text')));
});

test('style finding contract: все восемь категорий, объяснение, метод, уверенность и ограничения обязательны', () => {
  const text = 'Причина отсутствия желания возвращаться.';
  const finding = {
    category: 'chain', start: 0, end: text.length, fragment: text,
    explanation: 'Вложенная генитивная цепочка.',
    method: ['dependency:nmod', 'morphology:Case=Gen'],
    confidence: 'medium',
    limitations: ['Возможна терминологическая или намеренная конструкция.']
  };
  assert.deepEqual(validateFinding(text, finding), { valid: true, errors: [] });
  for (const category of CATEGORIES) assert.ok(validateFinding(text, { ...finding, category }).valid, category);
  assert.equal(validateFinding(text, { ...finding, confidence: 'certain' }).valid, false);
  assert.equal(validateFinding(text, { ...finding, fragment: 'другой фрагмент' }).valid, false);
});
