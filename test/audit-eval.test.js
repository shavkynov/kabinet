'use strict';

// Метрики на размеченных наборах аудита: наречия, страдательный залог, ритм (precision, recall, F1).
// Пороги ниже достигнутого: это защита от регрессий, а не доказательство точности.
// Наборы A (adv-cases, passive-cases-2, rhythm-cases) разработочные: по ним искались и исправлялись ошибки, поэтому цифры на них
// оптимистичны (больше половины наречий набора A уже были в словаре кода). Набор B написан после исправлений, один раз измерен
// и не использовался для подгонки: он показывает, как исправления обобщаются. Выборки малы (по 50–60 предложений):
// доверительные интервалы широкие, см. docs/DEV-CHANGELOG.md.
// Для сравнения «до» (код 0.26.0), набор B: наречия P 83 % R 47 %; пассив P 69 % R 100 %; ритм P 100 % R 71 %.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const H = require('./eval-helpers');
const { loadAnalysis, makeDoc } = require('./analysis-harness');
const morph = require('../src/morph');

const adv = [require('./adv-cases'), require('./adv-cases-b')];
const pas = [require('./passive-cases-2'), require('./passive-cases-b')];
const rh = [require('./rhythm-cases'), require('./rhythm-cases-b')];

let mod;
test.before(async () => { mod = await loadAnalysis(path.join(__dirname, '..'), 'ru'); });

const floor = (m, p, r, name) => {
  assert.ok(m.precision >= p, `${name}: точность ${H.pct(m.precision)} < ${H.pct(p)}; ложные: ${m.fpList.slice(0, 8).join(' | ')}`);
  assert.ok(m.recall >= r, `${name}: полнота ${H.pct(m.recall)} < ${H.pct(r)}; пропуски: ${m.fnList.slice(0, 8).join(' | ')}`);
};

test('аудит: наречия, набор A (разработочный) и набор B (свежий)', () => {
  floor(H.evalAdverbs(morph, adv[0]), 0.95, 0.95, 'наречия A');
  floor(H.evalAdverbs(morph, adv[1]), 0.9, 0.45, 'наречия B');
});

test('аудит: страдательный залог, набор A (разработочный) и набор B (свежий)', () => {
  floor(H.evalPassive(morph, pas[0]), 0.95, 0.95, 'пассив A');
  floor(H.evalPassive(morph, pas[1]), 0.75, 0.95, 'пассив B');
});

test('аудит: ритм, набор A (разработочный) и набор B (свежий); число предложений в разметке совпадает', () => {
  const a = H.evalRhythm(mod, makeDoc, rh[0]);
  const b = H.evalRhythm(mod, makeDoc, rh[1]);
  assert.deepEqual(a.countMismatch, []);
  assert.deepEqual(b.countMismatch, []);
  floor(a, 0.95, 0.95, 'ритм A');
  floor(b, 0.85, 0.85, 'ритм B');
});

test('аудит: разметка наборов согласована (нет пустых и повторяющихся предложений)', () => {
  // одно и то же предложение может стоять и в наборе наречий, и в наборе пассива (разные задачи), но не дважды в одном виде
  const advLines = adv.flat().map((l) => H.parseMarkup(l).clean);
  const pasLines = pas.flat().map((c) => c.t);
  assert.equal(new Set(advLines).size, advLines.length, 'повторяющиеся предложения наречий');
  assert.equal(new Set(pasLines).size, pasLines.length, 'повторяющиеся предложения пассива');
  for (const c of pas.flat()) assert.ok(['pos', 'neg', 'amb'].includes(c.label) && (c.label !== 'neg' || c.anchors.length === 0));
  const ids = rh.flat().map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'повторяющиеся id ритм-случаев');
});
