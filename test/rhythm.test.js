'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeRhythm, isDialogueText } = require('../src/rhythm');

const S = (words, first = 'слово', dialogue = false) => ({ words, first, dialogue });

test('ритм: цепочка коротких предложений', () => {
  const r = analyzeRhythm([S(12), S(3, 'он'), S(2, 'вышел'), S(4, 'закрыл'), S(3, 'ушёл'), S(15)]);
  const it = r.items.filter((x) => x.type === 'short');
  assert.equal(it.length, 1);
  assert.deepEqual([it[0].from, it[0].to, it[0].min, it[0].max], [1, 4, 2, 4]);
  // три коротких подряд ещё не цепочка
  assert.equal(analyzeRhythm([S(3), S(2), S(4), S(14)]).items.filter((x) => x.type === 'short').length, 0);
});

test('ритм: ровный ритм (5+ предложений почти одной длины) и разброс', () => {
  const even = analyzeRhythm([S(11), S(12), S(13), S(12), S(11), S(30)]);
  const it = even.items.find((x) => x.type === 'even');
  assert.ok(it);
  assert.deepEqual([it.from, it.to, it.min, it.max], [0, 4, 11, 13]);
  // живой ритм: длина скачет, ровного ритма нет
  const alive = analyzeRhythm([S(4), S(22), S(9), S(31), S(7), S(15), S(3), S(26)]);
  assert.equal(alive.items.filter((x) => x.type === 'even').length, 0);
  assert.equal(alive.stats.spread, 'high');
});

test('ритм: одинаковое начало подряд; реплики цепочку рвут', () => {
  const a = analyzeRhythm([S(8, 'он'), S(9, 'он'), S(7, 'он'), S(10, 'она')]);
  const st = a.items.find((x) => x.type === 'start');
  assert.deepEqual([st.from, st.to, st.word], [0, 2, 'он']);
  const b = analyzeRhythm([S(8, 'он'), S(9, 'он'), S(5, 'он', true), S(7, 'он')]);
  assert.equal(b.items.filter((x) => x.type === 'start').length, 0);
  // два подряд: не цепочка
  assert.equal(analyzeRhythm([S(8, 'он'), S(9, 'он'), S(7, 'она')]).items.length, 0);
});

test('ритм: диалог не учитывается, пустой текст не ломает', () => {
  const r = analyzeRhythm([S(2, 'да', true), S(2, 'нет', true), S(3, 'ну', true), S(2, 'что', true), S(3, 'а', true)]);
  assert.deepEqual(r.items, []);
  assert.equal(r.stats.count, 0);
  assert.equal(r.stats.spread, 'unknown');
  assert.deepEqual(analyzeRhythm([]).items, []);
});

test('isDialogueText: реплики и прямая речь', () => {
  assert.equal(isDialogueText('— Привет, — сказал он.'), true);
  assert.equal(isDialogueText('«Пора», — подумал он.'), true);
  assert.equal(isDialogueText('Он вышел из дома.'), false);
  assert.equal(isDialogueText('  – Да.'), true);
  assert.equal(isDialogueText('-вот и всё'), false);
});

test('ритм: анафора «И… А… Но…» отмечается только от четырёх предложений подряд, остальные начала от трёх', () => {
  const starts = (first, n) => analyzeRhythm(Array.from({ length: n }, (_, i) => S(8 + (i % 3) * 2, first)).concat([S(7, 'она')])).items.filter((x) => x.type === 'start');
  for (const w of ['и', 'а', 'но']) {
    assert.equal(starts(w, 3).length, 0, `«${w}» ×3 не отмечается`);
    const four = starts(w, 4);
    assert.equal(four.length, 1, `«${w}» ×4 отмечается`);
    assert.deepEqual([four[0].from, four[0].to, four[0].word], [0, 3, w]);
    assert.equal(starts(w, 6)[0].to, 5);
  }
  // остальные начала: порог прежний, три
  assert.equal(starts('он', 3).length, 1);
  assert.equal(starts('когда', 2).length, 0);
  // разные союзы подряд цепочку не образуют
  const mixed = analyzeRhythm([S(8, 'и'), S(9, 'а'), S(7, 'но'), S(10, 'и'), S(6, 'а'), S(8, 'но')]);
  assert.equal(mixed.items.filter((x) => x.type === 'start').length, 0);
});


// ---------- аудит ритма: абзац с репликой может продолжаться повествованием ----------

const { dialogueFlags } = require('../src/rhythm');
const morph = require('../src/morph');

const flagsOf = (text) => dialogueFlags(text, morph.analyzeBlock(text).sentences);

test('ритм: после слов автора предложения без тире в абзаце с репликой — повествование', () => {
  assert.deepEqual(flagsOf('— Пойдём, — сказал он. Она встала. Он взял её за руку.'), [true, false, false]);
  assert.deepEqual(flagsOf('«Не успею», — подумал он. Он ускорил шаг. Дорога тянулась бесконечно.'), [true, false, false]);
});

test('ритм: продолжение реплики без тире, пока слов автора не было, остаётся репликой', () => {
  assert.deepEqual(flagsOf('— Идём. Пора. Нас ждут.'), [true, true, true]);
  assert.deepEqual(flagsOf('— Нет, — сказал он. — Не сегодня. Устал.'), [true, true, true]);
  assert.deepEqual(flagsOf('— Я не знаю, — сказал он. — Может быть, завтра.'), [true, true]);
});

test('ритм: повествовательный абзац и заголовки не задеты', () => {
  assert.deepEqual(flagsOf('Он встал. Она ушла. Дверь хлопнула.'), [false, false, false]);
  assert.deepEqual(flagsOf('Тихо.'), [false]);
});
