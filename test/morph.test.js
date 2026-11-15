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

test('части речи: «я», местоимения с н- после предлога, «каждой», «одеяло»', () => {
  const pos = (t) => m.tokenize(t).map((w) => w.pos);
  assert.equal(pos('Я иду')[0], 'pron');
  assert.equal(pos('у него')[1], 'pron');
  assert.equal(pos('с ними')[1], 'pron');
  assert.equal(pos('в каждой мышце')[1], 'pron');
  assert.equal(pos('натянула одеяло')[1], 'noun');
  assert.notEqual(pos('рука на штурвале')[2], 'verb');
});

test('предложения: многоточие из трёх точек перед строчной буквой не кончает предложение', () => {
  assert.equal(m.sentences('Вдруг... всё стихло. Тишина.').length, 2);
});

test('части речи: глагол после «я», существительные, похожие на глаголы, наречия', () => {
  const pos = (t) => m.tokenize(t).map((w) => w.pos);
  assert.equal(pos('Я почти слышу')[2], 'verb');
  assert.equal(pos('я знаю')[1], 'verb');
  assert.equal(pos('взгляд маршала')[1], 'noun');
  assert.equal(pos('на мой авторитет')[2], 'noun');
  assert.equal(pos('он явно устал')[1], 'adv');
});

test('наречия образа действия и приставочные узнаются, существительные на -о нет', () => {
  const pos = (t) => m.tokenize(t).map((w) => w.pos);
  assert.equal(pos('Он сердито хлопнул дверью')[1], 'adv');
  assert.equal(pos('Они тайком вышли')[1], 'adv');
  assert.equal(pos('Он заново перечитал письмо')[1], 'adv');
  assert.equal(pos('чёрное золото')[1], 'noun');
});

test('пассив: краткое причастие с деятелем без «был» и возвратные глаголы без пассива', () => {
  const sp = (t) => m.findPassive(m.tokenize(t)).map((x) => t.slice(x.start, x.end));
  assert.deepEqual(sp('Свитки небрежно брошены и прижаты мечом.'), ['прижаты мечом']);
  assert.deepEqual(sp('Она закуталась шарфом.'), []);
  assert.deepEqual(sp('Я управляюсь с новыми силами.'), []);
  assert.deepEqual(sp('Дом строился рабочими.'), ['строился рабочими']);
  assert.deepEqual(sp('Это была моя охрана.'), []);
});
