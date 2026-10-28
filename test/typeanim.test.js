'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DURATION_MS, STEPS, animatedRange, expired, levelAt, advance } = require('../src/typeanim');

test('анимация набора: диапазон только для вставки одной буквы или короткой группы', () => {
  assert.deepEqual(animatedRange({ from: 5, to: 5, size: 1, text: 'а' }), [5, 6]);
  assert.deepEqual(animatedRange({ from: 5, to: 5, size: 3, text: 'abc' }), [5, 8]); // быстрый набор: две-три буквы за одну правку
  assert.equal(animatedRange({ from: 5, to: 5, size: 1, text: ' ' }), null); // пробел не видно
  assert.equal(animatedRange({ from: 5, to: 5, size: 200, text: 'x'.repeat(200) }), null); // вставка, загрузка главы
  assert.equal(animatedRange({ from: 5, to: 6, size: 1, text: 'а' }), null); // замена выделенного
  assert.equal(animatedRange({ from: 5, to: 5, size: 0, text: '' }), null); // удаление
  assert.equal(animatedRange({ from: 5, to: 5, size: 1, text: null }), null); // не текст
  assert.equal(animatedRange(null), null);
});

test('анимация набора: ступени растут от прозрачного к полному и заканчиваются ровно за DURATION_MS', () => {
  assert.equal(levelAt(0), 0);
  assert.equal(levelAt(DURATION_MS - 1), STEPS.length - 1);
  assert.equal(levelAt(DURATION_MS), -1);
  assert.equal(levelAt(-5), -1);
  assert.equal(levelAt(NaN), -1);
  let prev = -1;
  for (let age = 0; age < DURATION_MS; age += 1) { // ступени не убывают и ни одна не пропущена
    const lv = levelAt(age);
    assert.ok(lv >= prev && lv - prev <= 1);
    prev = lv;
  }
  assert.ok(STEPS.every((a, i) => a > 0 && a < 1 && (i === 0 || a > STEPS[i - 1]))); // непрозрачность строго растёт, полной нет: полный цвет у обычного текста
});

test('анимация набора: метки сопровождают правки, устаревшие и удалённые уходят', () => {
  const ins = (at, n) => (p, assoc) => (p > at || (p === at && assoc > 0) ? p + n : p); // вставка n знаков в позицию at
  const items = [{ from: 5, to: 6, t: 1000 }];
  assert.deepEqual(advance(items, ins(2, 1), 1010), [{ from: 6, to: 7, t: 1000 }]); // вставка раньше: метка сдвигается
  assert.deepEqual(advance(items, ins(6, 1), 1010), [{ from: 5, to: 6, t: 1000 }]); // следующая буква сразу за меткой её не растягивает
  assert.deepEqual(advance(items, ins(5, 1), 1010), [{ from: 6, to: 7, t: 1000 }]); // новая буква перед меткой тоже
  assert.deepEqual(advance(items, () => 4, 1010), []); // текст удалён, метка схлопнулась
  assert.deepEqual(advance(items, (p) => p, 1000 + DURATION_MS), []); // время вышло
  assert.equal(expired(1000, 1000 + DURATION_MS - 1), false);
  assert.equal(expired(1000, 1000 + DURATION_MS), true);
});
