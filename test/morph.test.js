'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../src/morph');

const pos = (text) => Object.fromEntries(m.tokenize(text).map((w) => [w.text.toLowerCase(), w.pos]));

test('части речи: частые случаи', () => {
  const p = pos('Старый дом медленно строился. Она улыбнулась, увидев красивую птицу. Он шёл по длинной улице.');
  assert.equal(p['старый'], 'adj');
  assert.equal(p['дом'], 'noun');
  assert.equal(p['медленно'], 'adv');
  assert.equal(p['строился'], 'verb');
  assert.equal(p['улыбнулась'], 'verb');
  assert.equal(p['увидев'], 'part');
  assert.equal(p['красивую'], 'adj');
  assert.equal(p['шёл'], 'verb');
  assert.equal(p['длинной'], 'adj');
  assert.equal(p['она'], 'pron');
  assert.equal(p['по'], 'func');
});

test('существительные со схожими окончаниями не становятся глаголами', () => {
  const p = pos('Ответ был в кабинете, а солдат взял билет.');
  assert.equal(p['ответ'], 'noun');
  assert.equal(p['кабинете'], 'noun');
  assert.equal(p['солдат'], 'noun');
  assert.equal(p['билет'], 'noun');
  assert.equal(p['взял'], 'verb');
});

test('страдательный залог', () => {
  const t = 'Письмо было написано вчера, дверь была открыта, а дом строился рабочими. Он занимался спортом. Он написал письмо.';
  const spans = m.findPassive(m.tokenize(t)).map((s) => t.slice(s.start, s.end));
  assert.deepEqual(spans, ['было написано', 'была открыта', 'строился рабочими']);
});

test('определительные причастия не считаются страдательным залогом, но остаются причастиями', () => {
  const t = 'Закрытая дверь, любимый город и разрушенный мост.';
  const toks = m.tokenize(t);
  assert.deepEqual(m.findPassive(toks), []);
  assert.deepEqual(toks.filter((x) => x.pos === 'part').map((x) => x.text), ['Закрытая', 'любимый', 'разрушенный']);
});

test('предложения и их длина', () => {
  const s = m.sentences('Раз два три. Четыре пять! Шесть?');
  assert.deepEqual(s.map((x) => x.words), [3, 2, 1]);
  const t = 'Он пришёл. Она ушла.';
  const sn = m.sentences(t);
  assert.equal(t.slice(sn[1].start, sn[1].end), 'Она ушла.');
});

test('разбор пустого и латинского текста не падает', () => {
  assert.deepEqual(m.analyzeBlock('').words, []);
  assert.equal(pos('hello 123')['123'], 'num');
});
