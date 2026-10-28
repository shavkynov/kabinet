'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ed = require('../src/editing');
const { speechRanges } = require('../src/speech');
const tense = require('../src/tense');

const re = ed.compileFillers(ed.DEFAULT_FILLERS.ru);
const found = (t, opts = {}) => ed.findFillers(t, re, opts).map((m) => t.slice(m.start, m.end).toLowerCase());

test('паразиты: настоящие находки сохраняются', () => {
  assert.deepEqual(found('Он просто взял и ушёл, не сказав ни слова.'), ['просто']);
  assert.deepEqual(found('Вдруг раздался выстрел.'), ['вдруг']);
  assert.deepEqual(found('Она пела очень тихо.'), ['очень']);
  assert.deepEqual(found('Они были довольно бедны, но достаточно счастливы.'), ['довольно', 'достаточно']);
  assert.deepEqual(found('Она как-то странно улыбнулась.'), ['как-то']);
  assert.deepEqual(found('Он, наверное, уже спит.'), ['наверное']);
  assert.deepEqual(found('Казалось, что время остановилось.'), ['казалось']);
  assert.deepEqual(found('Он довольно быстро вышел и довольно часто возвращался.'), ['довольно', 'довольно']);
  assert.deepEqual(found('Значит, так и будем сидеть?'), ['значит']);
});

test('паразиты: омонимы и обычные значения не отмечаются', () => {
  assert.deepEqual(found('Что значит это слово?'), []);
  assert.deepEqual(found('Это значит, что завтра мы уезжаем.'), []);
  assert.deepEqual(found('Значит ли это, что она ушла?'), []);
  assert.deepEqual(found('А вдруг она не придёт?'), []);
  assert.deepEqual(found('Я довольно улыбнулся.'), []);
  assert.deepEqual(found('Довольно! Хватит с меня.'), []);
  assert.deepEqual(found('С меня довольно.'), []);
  assert.deepEqual(found('Достаточно для одного дня.'), []);
  assert.deepEqual(found('Мне казалось странным его молчание.'), []);
  assert.deepEqual(found('Как-то раз летом они ушли в горы.'), []);
  assert.deepEqual(found('Это было совсем не просто.'), []);
  assert.deepEqual(found('Вообще-то он не любил рассказывать о войне.'), []);
  assert.deepEqual(found('Ну-ка, отойди от окна.'), []);
});

test('паразиты: в репликах героев не отмечаются (по умолчанию в окне), если включено', () => {
  const dialogue = '— Ну, значит, так и будем сидеть? — спросила она.';
  assert.deepEqual(found(dialogue, { skipSpeech: true }), []);
  assert.deepEqual(found(dialogue), ['ну', 'значит']); // без переключателя отмечается и речь
  const quoted = 'Он сказал: «Ну, это очень просто» и ушёл. Он очень устал.';
  assert.deepEqual(found(quoted, { skipSpeech: true }), ['очень']); // только слова автора
  // слова автора внутри абзаца с репликой отмечаются
  assert.deepEqual(found('— Идём, — сказал он очень тихо.', { skipSpeech: true }), ['очень']);
});

test('прямая речь вынесена в общий модуль и работает как раньше', () => {
  assert.equal(speechRanges, tense.speechRanges);
  assert.deepEqual(speechRanges('Он сказал: «Пойдём».'), [[11, 19]]);
});
