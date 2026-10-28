'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const stats = require('../src/stats');

test('stats: запись по дням берёт большее значение, мусор отвергается', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kabinet-st-'));
  stats.setDayWords(dir, '2026-10-18', 500);
  stats.setDayWords(dir, '2026-10-18', 300);
  assert.equal(stats.readDays(dir)['2026-10-18'], 500);
  assert.throws(() => stats.setDayWords(dir, '2026-13-40', 1), /Неверная дата/);
  assert.throws(() => stats.setDayWords(dir, '2026-10-18', -5), /Неверное число/);
});

test('stats: серия, последние дни и план до срока', () => {
  const days = { '2026-10-16': 200, '2026-10-17': 10, '2026-10-18': 400 };
  assert.equal(stats.streak(days, '2026-10-19'), 3); // сегодня пусто: считаем до вчера
  assert.equal(stats.streak({ ...days, '2026-10-19': 1 }, '2026-10-19'), 4);
  assert.equal(stats.streak({ '2026-10-10': 5 }, '2026-10-19'), 0);
  const last = stats.lastDays(days, '2026-10-19', 4);
  assert.deepEqual(last.map((d) => d.words), [200, 10, 400, 0]);

  const p = stats.dailyPlan(50000, 20000, '2026-10-29', '2026-10-19'); // 11 дней с сегодняшним
  assert.deepEqual(p, { left: 30000, daysLeft: 11, perDay: 2728, overdue: false, done: false });
  assert.equal(stats.dailyPlan(50000, 60000, '2026-10-29', '2026-10-19').done, true);
  assert.equal(stats.dailyPlan(50000, 20000, '2026-10-18', '2026-10-19').overdue, true);
  assert.equal(stats.dailyPlan(null, 0, '2026-10-29', '2026-10-19'), null);
  assert.equal(stats.dailyPlan(1000, 0, null, '2026-10-19'), null);
});
