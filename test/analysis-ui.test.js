'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { loadAnalysis, runBuild } = require('./analysis-harness');
const { skipKey } = require('../src/editing');

const ROOT = path.join(__dirname, '..');
const ALL = { adv: true, passive: true, long: true, repeat: true, filler: true };
const TEXT = ['Дверь была открыта рабочими. Он медленно подошёл к двери и вдруг просто остановился.'];
const cfg = (extra = {}) => ({ cats: ALL, longMin: 5, fillers: ['просто'], repeatWin: 25, ...extra });
const byClass = (set, cls) => set.filter((d) => d.attrs.class.split(' ').includes(cls));

let mod;
test.before(async () => { mod = await loadAnalysis(ROOT, 'ru'); });

test('подсветка: подсказки во всех пяти категориях, цвет и форма (классы) прежние', () => {
  const { result } = runBuild(mod, TEXT, cfg());
  const title = (cls) => byClass(result.set, cls).map((d) => d.attrs.title);
  assert.deepEqual(title('an-adv'), ['Наречие: «медленно»', 'Наречие: «вдруг»']);
  assert.deepEqual(title('an-passive'), ['Страдательный залог: «была открыта»']);
  assert.deepEqual(title('an-filler'), ['Слово-паразит из списка: «просто»']);
  assert.deepEqual(title('an-long'), ['Длинное предложение: 9 слов (порог 5)']);
  assert.deepEqual(title('an-repeat'), ['Повтор: слово «двери» встретится снова через 8 слов', 'Повтор: слово «Дверь» уже было 8 слов назад']);
  // внешний вид: у каждой подсветки ровно прежние классы, никаких новых
  for (const d of result.set) assert.match(d.attrs.class, /^an an-(adv|passive|filler|long|repeat)$/);
});

test('подсветка: остальные виды (глаголы, существительные и т. д.) без подсказок и без изменений', () => {
  const { result } = runBuild(mod, TEXT, { cats: { verb: true, noun: true, adj: true, part: true, pron: true }, longMin: 30, fillers: [], repeatWin: 25 });
  assert.ok(result.set.length > 5);
  for (const d of result.set) {
    assert.ok(!('title' in d.attrs), `у «${d.attrs.class}» подсказки быть не должно`);
    assert.match(d.attrs.class, /^an an-(verb|noun|adj|part|pron)$/);
  }
});

test('подсказки: число слов склоняется («1 слово», «2 слова», «5 слов», «11 слов», «21 слово»)', () => {
  const sentence = (n) => `${Array.from({ length: n }, (_, i) => `слово${'абвгд'[i % 5]}`).join(' ')}.`;
  const { result } = runBuild(mod, [1, 2, 5, 11, 21].map(sentence), { cats: { long: true }, longMin: 1, fillers: [], repeatWin: 25 });
  assert.deepEqual(byClass(result.set, 'an-long').map((d) => d.attrs.title), [
    'Длинное предложение: 1 слово (порог 1)', 'Длинное предложение: 2 слова (порог 1)', 'Длинное предложение: 5 слов (порог 1)',
    'Длинное предложение: 11 слов (порог 1)', 'Длинное предложение: 21 слово (порог 1)',
  ]);
});

test('подсказки на английском: число слов с «word/words»', async () => {
  const en = await loadAnalysis(ROOT, 'en');
  const { result } = runBuild(en, ['Один. Два слова.'], { cats: { long: true }, longMin: 1, fillers: [], repeatWin: 25 });
  assert.deepEqual(byClass(result.set, 'an-long').map((d) => d.attrs.title), ['Длинное предложение: 1 word (порог 1)', 'Длинное предложение: 2 words (порог 1)']);
});

test('переход «‹ ›»: места по категориям в порядке текста, в счётчиках те же числа', () => {
  const paras = ['Он вдруг просто ушёл. Дверь скрипнула медленно.', 'Дверь была закрыта рабочими, и он медленно вернулся вдруг просто так.'];
  const { result, state } = runBuild(mod, paras, cfg({ longMin: 6 }));
  const r = mod.analysisRanges(state);
  for (const cat of mod.AN_NAV_CATS) {
    const list = r[cat];
    assert.ok(list.length > 0, `в категории ${cat} есть места`);
    assert.deepEqual(list, [...list].sort((a, b) => a.from - b.from), `${cat}: по порядку`);
    for (const m of list) assert.ok(m.to > m.from);
  }
  assert.equal(r.adv.length, result.stats.adv);
  assert.equal(r.passive.length, result.stats.passive);
  assert.equal(r.long.length, result.stats.long);
  assert.equal(r.repeat.length, result.stats.repeat);
  assert.equal(r.filler.length, result.stats.filler);
});

test('меню «Не отмечать здесь»: что подсвечено в точке и какой текст исключается', () => {
  const { state } = runBuild(mod, TEXT, cfg());
  const view = { state, posAtCoords: ({ left }) => ({ pos: left }) };
  const adv = mod.analysisAt(view, 35, 0);
  assert.deepEqual(adv.map((h) => [h.cat, h.text]), [['adv', 'медленно'], ['long', 'Он медленно подошёл к двери и вдруг просто остановился.']]);
  assert.deepEqual(mod.analysisAt(view, 10, 0).map((h) => [h.cat, h.text]), [['passive', 'была открыта']]);
  assert.deepEqual(mod.analysisAt(view, 500, 0), []);
  assert.deepEqual(mod.analysisAt({ ...view, posAtCoords: () => null }, 1, 1), []);
});

test('исключения: слово в категории больше не отмечается и не считается, остальное не задето', () => {
  const base = runBuild(mod, TEXT, cfg()).result;
  const skip = {
    adv: [skipKey('Медленно')],
    passive: ['была открыта'],
    filler: ['просто'],
    repeat: ['дверь'],
    long: [skipKey('Он медленно подошёл к двери и вдруг просто остановился.')],
  };
  const { result } = runBuild(mod, TEXT, cfg({ skip }));
  assert.deepEqual(byClass(result.set, 'an-adv').map((d) => d.attrs.title), ['Наречие: «вдруг»']);
  for (const cls of ['an-passive', 'an-filler', 'an-repeat', 'an-long']) assert.equal(byClass(result.set, cls).length, 0, cls);
  assert.equal(result.stats.adv, base.stats.adv - 1);
  assert.equal(result.stats.passive, 0);
  assert.equal(result.stats.filler, 0);
  assert.equal(result.stats.repeat, 0);
  assert.equal(result.stats.long, 0);
  assert.deepEqual(result.ranges.adv.length, 1);
  // исключение по одной категории не трогает другие: «просто» не стало наречием и не вернулось в подсветку наречий
  const onlyFiller = runBuild(mod, TEXT, cfg({ skip: { filler: ['просто'] } })).result;
  assert.equal(byClass(onlyFiller.set, 'an-filler').length, 0);
  assert.equal(byClass(onlyFiller.set, 'an-adv').length, 2);
  // пустые и неизвестные исключения ничего не меняют
  assert.equal(runBuild(mod, TEXT, cfg({ skip: {} })).result.set.length, base.set.length);
  assert.equal(runBuild(mod, TEXT, cfg({ skip: null })).result.set.length, base.set.length);
});

test('исключение повтора: расстояния до других повторов не меняются', () => {
  const paras = ['Туман стелился. Дорога петляла. Туман густел. Дорога терялась.'];
  const plain = runBuild(mod, paras, cfg({ cats: { repeat: true } })).result;
  assert.equal(plain.stats.repeat, 4);
  const skipped = runBuild(mod, paras, cfg({ cats: { repeat: true }, skip: { repeat: ['туман'] } })).result;
  assert.equal(skipped.stats.repeat, 2);
  assert.deepEqual(byClass(skipped.set, 'an-repeat').map((d) => d.attrs.title), ['Повтор: слово «Дорога» встретится снова через 4 слова', 'Повтор: слово «Дорога» уже было 4 слова назад']);
});

test('переход «‹ ›»: следующее и предыдущее место по кругу, пусто: -1', () => {
  const list = [{ from: 10, to: 15 }, { from: 40, to: 48 }, { from: 90, to: 95 }];
  assert.equal(mod.stepIndex([], 5, 1), -1);
  assert.equal(mod.stepIndex(list, 0, 1), 0, 'с начала: первое');
  assert.equal(mod.stepIndex(list, 10, 1), 1, 'стоим на первом: следующее второе');
  assert.equal(mod.stepIndex(list, 25, 1), 1, 'между местами: ближайшее вперёд');
  assert.equal(mod.stepIndex(list, 90, 1), 0, 'после последнего: по кругу к первому');
  assert.equal(mod.stepIndex(list, 40, -1), 0, 'стоим на втором: предыдущее первое');
  assert.equal(mod.stepIndex(list, 25, -1), 0, 'между местами: ближайшее назад');
  assert.equal(mod.stepIndex(list, 10, -1), 2, 'перед первым: по кругу к последнему');
  assert.equal(mod.stepIndex(list, 500, -1), 2);
  // после перехода на место курсор стоит в его начале: повторное «›» идёт дальше, а не на то же самое
  let at = 0;
  const seen = [];
  for (let i = 0; i < 4; i += 1) { const k = mod.stepIndex(list, at, 1); seen.push(k); at = list[k].from; }
  assert.deepEqual(seen, [0, 1, 2, 0]);
});


test('слова-паразиты: «слово*» и «слово~» работают в подсветке, смена списка не залипает в кэше абзацев', () => {
  const paras = ['Он почувствовал холод, она почувствовала страх, а они почувствуют всё.'];
  const only = { cats: { filler: true }, longMin: 30, repeatWin: 25 };
  const titles = (fillers) => byClass(runBuild(mod, paras, { ...only, fillers }).result.set, 'an-filler').map((d) => d.attrs.title);
  assert.deepEqual(titles(['почувствовал']), ['Слово-паразит из списка: «почувствовал»']);
  assert.deepEqual(titles(['почувствова*']), ['Слово-паразит из списка: «почувствовал»', 'Слово-паразит из списка: «почувствовала»']);
  assert.equal(titles(['почувствовал~']).length, 3, 'все формы: почувствовал, почувствовала, почувствуют');
  // один и тот же абзац (тот же узел документа) при смене списка пересчитывается
  const [plugin] = mod.TextAnalysis.plugins({ getConfig: () => cfgNow });
  let cfgNow = { ...only, fillers: ['почувствовал'] };
  const { makeDoc } = require('./analysis-harness');
  const doc = makeDoc(paras);
  const count = () => plugin.spec.state.init(null, { doc }).stats.filler;
  assert.equal(count(), 1);
  cfgNow = { ...only, fillers: ['почувствовал~'] };
  assert.equal(count(), 3);
  cfgNow = { ...only, fillers: ['почувствовал'] };
  assert.equal(count(), 1);
});
