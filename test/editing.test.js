'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ed = require('../src/editing');
const { tokenize } = require('../src/morph');

test('слова-паразиты: слова, фразы, е/ё, границы слов', () => {
  const re = ed.compileFillers(['просто', 'как бы', 'в общем-то', 'вдруг']);
  const text = 'Он просто стоял. Как  бы ничего. В общем-то, всё. Простор и вдруг!';
  const found = ed.findFillers(text, re).map((m) => text.slice(m.start, m.end));
  assert.deepEqual(found, ['просто', 'Как  бы', 'В общем-то', 'вдруг']); // «простор» не считается
  assert.deepEqual(ed.findFillers('ничего', null), []);
  const ё = ed.compileFillers(['всё равно']);
  assert.equal(ed.findFillers('Ему все равно.', ё).length, 1);
});

test('список паразитов: чистка, дубли, свои слова', () => {
  assert.deepEqual(ed.cleanFillerList(['  Просто ', 'просто', 'а', '123', 'Как   бы']), ['просто', 'как бы']);
  assert.equal(ed.cleanFiller('x'.repeat(41)), '');
  assert.ok(ed.DEFAULT_FILLERS.ru.length > 20 && ed.DEFAULT_FILLERS.en.length > 5);
  const re = ed.compileFillers(['мол (так)']); // скобки не ломают выражение
  assert.equal(ed.findFillers('он мол (так) сказал', re).length, 1);
});

test('повторы слов рядом', () => {
  const seq = tokenize('Дверь скрипнула. Он открыл дверь и вошёл в комнату, где другая дверь молчала. Потом прошло много времени, и вдали звучала музыка.');
  const marked = ed.findRepeats(seq, 12);
  const words = [...marked].map((i) => seq[i].text.toLowerCase()).sort();
  assert.deepEqual(words, ['дверь', 'дверь', 'дверь']);
  const far = ed.findRepeats(seq, 4);
  assert.equal(far.size, 2); // третья «дверь» уже далеко от первых двух
});

test('повторы: служебные слова и короткие не считаются', () => {
  const seq = tokenize('Это было так. Это было иначе. Он был там, она была там.');
  assert.equal(ed.findRepeats(seq, 30).size, 0);
});

test('repeatPairs: те же слова, что у findRepeats, с парой «раньше → позже»', () => {
  const words = 'дверь скрипнула и дверью кто то хлопнул дверей мало'.split(' ');
  const seq = words.map((text) => ({ text, pos: 'noun' }));
  const pairs = ed.repeatPairs(seq, 6);
  assert.deepEqual(pairs, [[0, 3], [3, 7]].filter(([j, i]) => i - j <= 6));
  const marked = [...ed.findRepeats(seq, 6)].sort((a, b) => a - b);
  assert.deepEqual(marked, [...new Set(pairs.flat())].sort((a, b) => a - b));
  // слово с пометкой skip не участвует в сравнении, но занимает место в ряду (расстояния не меняются)
  seq[3].skip = true;
  assert.deepEqual(ed.repeatPairs(seq, 7), [[0, 7]]);
  assert.deepEqual(ed.repeatPairs(seq, 6), []);
});

test('исключения подсветки: ключ и очистка данных из файла проекта', () => {
  assert.equal(ed.skipKey('  Ёлка\u00a0  ЕЛКА '), 'елка елка');
  assert.equal(ed.skipKey('x'.repeat(500)).length, 160);
  assert.deepEqual(ed.SKIP_CATS, ['adv', 'passive', 'long', 'repeat', 'filler']);
  const clean = ed.cleanSkip({ adv: ['Вдруг', 'вдруг', '', 5, 'ВДРУГ  '], passive: ['был построен'], bogus: ['x'], filler: 'нет', long: [] });
  assert.deepEqual(clean, { adv: ['вдруг'], passive: ['был построен'] });
  assert.deepEqual(ed.cleanSkip(null), {});
  assert.deepEqual(ed.cleanSkip([]), {});
  assert.equal(ed.cleanSkip({ adv: Array.from({ length: 400 }, (_, i) => `слово${i}`) }).adv.length, 300);
});


// ---------- Д2: «слово*» и «слово~» (все формы) в списке слов-паразитов ----------

const hitsOf = (text, list, opts) => ed.findFillers(text, ed.compileFillers(list), opts).map((h) => text.slice(h.start, h.end));

test('паразиты: запись со звёздочкой и отметка «все формы» принимаются только в безопасном виде', () => {
  for (const ok of ['почувствова*', 'ПОЧУВСТВОВА*', 'почувствовал~', 'как-то*', 'вдруг']) assert.ok(ed.cleanFiller(ok), ok);
  for (const bad of ['*', 'по*', 'а*', 'по*ом', '*слово', 'слово* еще', 'два слова~', 'а~', 'ну~~', '~', 'слово*~']) assert.equal(ed.cleanFiller(bad), '', bad);
  assert.deepEqual(ed.cleanFillerList(['почувствова*', 'Почувствова*', 'по*', 'вдруг', 'слово~']), ['почувствова*', 'вдруг', 'слово~']);
});

test('паразиты: «почувствова*» находит любое окончание, без звёздочки поведение прежнее', () => {
  const text = 'Он почувствовал, она почувствовала, они почувствовали. Почувствовав холод, он хотел почувствовать тепло, но почувствуют другие.';
  assert.deepEqual(hitsOf(text, ['почувствова*']), ['почувствовал', 'почувствовала', 'почувствовали', 'Почувствовав', 'почувствовать']);
  assert.deepEqual(hitsOf(text, ['почувствовал']), ['почувствовал'], 'без звёздочки только точное слово');
  assert.deepEqual(hitsOf(text, ['почувств*']).length, 6, 'более короткая основа находит и «почувствуют»');
  // ё и е, регистр, граница слова
  assert.deepEqual(hitsOf('Ёлка, елки, Ёлкин и ёлочка.', ['ёлк*']), ['Ёлка', 'елки', 'Ёлкин']);
  assert.deepEqual(hitsOf('Подсолнух, солнце, солнечный.', ['солн*']), ['солнце', 'солнечный'], 'часть слова не считается');
  // слова со смыслом «не паразит» по-прежнему отсеиваются и для записи со звёздочкой
  assert.deepEqual(hitsOf('А вдруг она не придёт? Он вдруг встал.', ['вдру*']), ['вдруг']);
});

test('паразиты: «слово~» находит формы того же слова, но не другие слова', () => {
  const text = 'Он почувствовал, она почувствовала, они почувствовали, я почувствую, ты почувствуешь, он почувствует, они почувствуют. Хотел почувствовать. Чувствовал страх. Это чувство.';
  const found = hitsOf(text, ['почувствовал~']);
  for (const w of ['почувствовал', 'почувствовала', 'почувствовали', 'почувствует', 'почувствуют', 'почувствовать']) assert.ok(found.includes(w), `нет «${w}»`);
  for (const w of ['Чувствовал', 'чувство']) assert.ok(!found.includes(w), `лишнее «${w}»`);
  // наречие не находит прилагательное с той же основой
  assert.deepEqual(hitsOf('Вопрос простой. Он просто ушёл.', ['просто~']), ['просто']);
  // фразы и обычные записи в одном списке; повторы мест не дублируются
  const both = hitsOf('Он вдруг почувствовал страх, вдруг почувствовала.', ['вдруг', 'почувствовал страх', 'почувствовал~']);
  assert.deepEqual(both, ['вдруг', 'почувствовал страх', 'вдруг', 'почувствовала']);
  // реплики героев по умолчанию не отмечаются и для «все формы»
  assert.deepEqual(hitsOf('— Я почувствовала, — сказал он. Она почувствовала.', ['почувствовал~'], { skipSpeech: true }), ['почувствовала']);
});

test('паразиты: список из одних «все формы» даёт рабочее выражение и свой ключ для кэша', () => {
  const re = ed.compileFillers(['почувствовал~']);
  assert.ok(re && re.forms.size >= 1);
  assert.deepEqual([...'слово'.matchAll(re)], [], 'само регулярное выражение ничего не находит');
  assert.notEqual(re.key, ed.compileFillers(['почувствовал']).key);
  assert.notEqual(ed.compileFillers(['вдруг', 'ничего~']).key, ed.compileFillers(['вдруг']).key);
  assert.equal(ed.compileFillers([]), null);
  assert.equal(ed.compileFillers(['по*']), null, 'недопустимая запись отбрасывается');
});
