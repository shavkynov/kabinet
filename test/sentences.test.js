'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sentences, analyzeBlock } = require('../src/morph');

const split = (t) => sentences(t).map((s) => t.slice(s.start, s.end));

test('предложения: обычный текст делится как прежде', () => {
  assert.deepEqual(split('Он ушёл. Она осталась.'), ['Он ушёл.', 'Она осталась.']);
  assert.deepEqual(split('Кто там? Никто не ответил! Тишина…'), ['Кто там?', 'Никто не ответил!', 'Тишина…']);
  assert.deepEqual(split('Он вышел'), ['Он вышел']);
  assert.deepEqual(split('Он сказал: «Пойдём». Она кивнула.'), ['Он сказал: «Пойдём».', 'Она кивнула.']);
  assert.deepEqual(split('Он крикнул «Стой!». Она замерла.'), ['Он крикнул «Стой!».', 'Она замерла.']);
  assert.deepEqual(split('Дом стоял у реки (там, где был мост). Мы подошли.'), ['Дом стоял у реки (там, где был мост).', 'Мы подошли.']);
  assert.deepEqual(split('Он замолчал... Потом снова заговорил.'), ['Он замолчал...', 'Потом снова заговорил.']);
  assert.deepEqual(split(''), []);
  assert.deepEqual(split('   '), []);
});

test('предложения: сокращения не режут предложение', () => {
  assert.equal(split('Это было в 1999 г. в Москве. Потом они уехали.').length, 2);
  assert.equal(split('Он жил в г. Москве на ул. Ленина, в д. 5.').length, 1);
  assert.equal(split('Выступил проф. Иванов от имени Академии им. Пушкина.').length, 1);
  assert.equal(split('Мы уедем завтра, т. е. в субботу.').length, 1);
  assert.equal(split('Он купил хлеб, молоко и т. д. Потом вернулся домой.').length, 2);
  assert.equal(split('Он принёс яблоки и т. д. и т. п. Потом ушёл.').length, 2);
  assert.equal(split('См. рис. 3 и табл. 2. Дальше идёт текст.').length, 2);
  assert.equal(split('Книга вышла в 1999 г. Потом её переиздали.').length, 2);
  assert.equal(split('Книга стоила 100 руб. Это было дорого.').length, 2);
  assert.equal(split('Книга стоила 100 руб. дороже, чем ждали.').length, 1);
});

test('предложения: инициалы и числа', () => {
  assert.equal(split('А. С. Пушкин родился в Москве. Он писал стихи.').length, 2);
  assert.equal(split('Иванов И. И. прибыл вечером.').length, 1);
  assert.equal(split('Пришёл И. И. Иванов и сел.').length, 1);
  assert.equal(split('Цена была 3.5 рубля. Дорого!').length, 2);
  assert.equal(split('Поезд ушёл в 10.30 утра. Мы опоздали.').length, 2);
  assert.equal(split('Это случилось в 2020. Потом всё изменилось.').length, 2);
  assert.deepEqual(split('1. Первое правило. 2. Второе правило.'), ['1. Первое правило.', '2. Второе правило.']);
});

test('предложения: слова автора после реплики и продолжение после многоточия', () => {
  assert.deepEqual(split('«Ты придёшь?» — спросила она. «Не знаю», — ответил он.'), ['«Ты придёшь?» — спросила она.', '«Не знаю», — ответил он.']);
  assert.deepEqual(split('— Кто там?! — крикнул он.'), ['— Кто там?! — крикнул он.']);
  assert.deepEqual(split('— Привет, — сказал он. — Как дела?'), ['— Привет, — сказал он.', '— Как дела?']);
  assert.deepEqual(split('— Что? Где? Когда? — спросил он.'), ['— Что?', 'Где?', 'Когда? — спросил он.']);
  assert.deepEqual(split('— Да. — Он кивнул.'), ['— Да.', '— Он кивнул.']);
  assert.deepEqual(split('Он… э… не знаю.'), ['Он… э… не знаю.']);
  assert.deepEqual(split('«Стой!» — крикнул он. Она остановилась.'), ['«Стой!» — крикнул он.', 'Она остановилась.']);
});

test('предложения: слова считаются верно, числа с точкой это одно слово', () => {
  const [a] = sentences('Цена была 3.5 рубля.');
  assert.equal(a.words, 4);
  assert.equal(sentences('Поезд ушёл в 10.30 утра.')[0].words, 5);
  const b = analyzeBlock('Цена была 3.5 рубля.');
  assert.equal(b.words.filter((w) => w.pos === 'num').length, 1);
});

test('предложения: границы указывают на сам текст, закрывающие кавычки входят', () => {
  const t = 'Он сказал: «Иди». Она пошла.';
  const s = sentences(t);
  assert.equal(t.slice(s[0].start, s[0].end), 'Он сказал: «Иди».');
  assert.equal(t.slice(s[1].start, s[1].end), 'Она пошла.');
  assert.equal(s[0].end <= s[1].start, true);
});
