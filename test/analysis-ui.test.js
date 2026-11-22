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
  const title = (cls) => byClass(result.set, cls).map((d) => d.attrs['data-an-tip']);
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
  assert.deepEqual(byClass(result.set, 'an-long').map((d) => d.attrs['data-an-tip']), [
    'Длинное предложение: 1 слово (порог 1)', 'Длинное предложение: 2 слова (порог 1)', 'Длинное предложение: 5 слов (порог 1)',
    'Длинное предложение: 11 слов (порог 1)', 'Длинное предложение: 21 слово (порог 1)',
  ]);
});

test('подсказки на английском: число слов с «word/words»', async () => {
  const en = await loadAnalysis(ROOT, 'en');
  const { result } = runBuild(en, ['Один. Два слова.'], { cats: { long: true }, longMin: 1, fillers: [], repeatWin: 25 });
  assert.deepEqual(byClass(result.set, 'an-long').map((d) => d.attrs['data-an-tip']), ['Длинное предложение: 1 word (порог 1)', 'Длинное предложение: 2 words (порог 1)']);
});

test('переход «‹ ›»: места по категориям в порядке текста, в счётчиках те же числа', () => {
  const paras = ['Он вдруг просто ушёл. Дверь скрипнула медленно.', 'Дверь была закрыта рабочими, и он медленно вернулся вдруг просто так.'];
  const { result, state } = runBuild(mod, paras, cfg({ longMin: 6 }));
  const r = mod.analysisRanges(state);
  for (const cat of ['adv', 'passive', 'long', 'repeat', 'filler']) {
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
  assert.deepEqual(byClass(result.set, 'an-adv').map((d) => d.attrs['data-an-tip']), ['Наречие: «вдруг»']);
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
  assert.deepEqual(byClass(skipped.set, 'an-repeat').map((d) => d.attrs['data-an-tip']), ['Повтор: слово «Дорога» встретится снова через 4 слова', 'Повтор: слово «Дорога» уже было 4 слова назад']);
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
  const titles = (fillers) => byClass(runBuild(mod, paras, { ...only, fillers }).result.set, 'an-filler').map((d) => d.attrs['data-an-tip']);
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

test('стиль текста: все восемь категорий доходят до подсветки и мест «‹ ›»; реплики героев не проверяются', () => {
  const paras = [
    'Отряд осуществлял разведку и начал идти. Он был зол.',
    'Выяснение причины отсутствия желания затянулось.',
    '— Это является данностью, — прошипел он, скалясь.',
    'В феврале месяце он снял свою шляпу.',
    'Это дом, который стоял у реки, который видел лес, который шумел.',
  ];
  const cats = { chancery: true, weak: true, tell: true, chain: true, remark: true, redund: true, which: true, own: true };
  const { result, state } = runBuild(mod, paras, { cats, longMin: 30, fillers: [], repeatWin: 25 });
  const cls = (c) => byClass(result.set, c);
  const expected = { chancery: 1, weak: 1, tell: 1, chain: 1, remark: 1, redund: 1, which: 1, own: 1 };
  for (const [cat, n] of Object.entries(expected)) {
    assert.equal(cls(`an-${cat}`).length, n, `${cat}: подсветка`);
    assert.equal(result.stats[cat], n, `${cat}: счётчик`);
  }
  assert.match(cls('an-chancery')[0].attrs['data-an-tip'], /осуществлять/);
  assert.match(cls('an-weak')[0].attrs['data-an-tip'], /фазовый глагол/);
  assert.match(cls('an-tell')[0].attrs['data-an-tip'], /названо чувство/);
  assert.match(cls('an-redund')[0].attrs['data-an-tip'], /лишнее уточнение/);
  assert.match(cls('an-which')[0].attrs['data-an-tip'], /3 придаточных/);
  assert.match(cls('an-own')[0].attrs['data-an-tip'], /«свой»/);
  // «является» внутри реплики не считается; ремарка при этом отмечается
  assert.equal(result.stats.chancery, 1);
  const r = mod.analysisRanges(state);
  for (const cat of Object.keys(expected)) assert.equal(r[cat].length, expected[cat], `${cat}: места для «‹ ›»`);
});

test('движок: ranges заменяют старые стилевые категории, счётчики и навигация совпадают', () => {
  const text = 'Осуществление проверки выполнения требований.';
  const cfgEngine = { cats: { chain: true, chancery: true }, longMin: 30, fillers: [], repeatWin: 25 };
  const engine = {
    active: true,
    ranges: [{
      category: 'chain',
      from: 1,
      to: 1 + text.length,
      fragment: text,
      finding: { explanation: 'Цепочка из 4 существительных подряд.' },
    }],
  };
  const { result, state } = runBuild(mod, [text], cfgEngine, engine);
  assert.equal(result.stats.chain, 1);
  assert.equal(result.stats.chancery, 0);
  assert.equal(result.ranges.chain.length, 1);
  assert.equal(mod.analysisRanges(state).chain.length, 1);
  const decos = byClass(result.set, 'an-chain');
  assert.deepEqual(decos.map((d) => [d.from, d.to]), [[1, 1 + text.length]]);
  assert.equal(decos[0].attrs['data-an-tip'], 'Цепочка из 4 существительных подряд.');
  assert.equal(byClass(result.set, 'an-chancery').length, 0);
});

test('движок: project.analysisSkip применяется к новым ranges', () => {
  const text = 'Осуществление проверки выполнения требований.';
  const cfgEngine = { cats: { chain: true }, longMin: 30, fillers: [], repeatWin: 25, skip: { chain: [skipKey(text)] } };
  const engine = { active: true, ranges: [{ category: 'chain', from: 1, to: 1 + text.length, fragment: text }] };
  const { result, state } = runBuild(mod, [text], cfgEngine, engine);
  assert.equal(result.stats.chain, 0);
  assert.equal(result.ranges.chain.length, 0);
  assert.equal(mod.analysisRanges(state).chain.length, 0);
  assert.equal(byClass(result.set, 'an-chain').length, 0);
});

test('движок: при inactive ranges возвращается старый fallback', () => {
  const text = 'Отряд осуществлял разведку.';
  const cfgEngine = { cats: { chancery: true }, longMin: 30, fillers: [], repeatWin: 25 };
  const oldFallback = runBuild(mod, [text], cfgEngine).result;
  const { result } = runBuild(mod, [text], cfgEngine, { active: false, ranges: [] });
  assert.equal(result.stats.chancery, oldFallback.stats.chancery);
  assert.equal(byClass(result.set, 'an-chancery').length, byClass(oldFallback.set, 'an-chancery').length);
});

test('движок (гибрид): chain/which только от UDPipe, остальные категории дополняются src/style.js с приоритетом UDPipe и учётом analysisSkip', () => {
  // Текст с: пересечением chancery («осуществляет» vs UDPipe «осуществляет контроль»),
  // непересекающимися лексическими находками («является», «начал идти», «был зол», «прошипел он, скалясь», «в феврале месяце», «свою шляпу»),
  // и кандидатом для chain/which без вывода UDPipe (не должны браться из src/style.js).
  const text = 'Он является другом, осуществляет контроль, начал идти, был зол, в феврале месяце снял свою шляпу и сказал, что дом стоял, что сад шумел, что лес спал.';
  const remarkPara = '— Уходи! — прошипел он, скалясь.';
  const udpStart = text.indexOf('осуществляет контроль');
  const udpEnd = udpStart + 'осуществляет контроль'.length;
  const febStart = text.indexOf('в феврале месяце');
  const cfgEngine = {
    cats: { chancery: true, weak: true, tell: true, chain: true, remark: true, redund: true, which: true, own: true },
    longMin: 30,
    fillers: [],
    repeatWin: 25,
    skip: { redund: [skipKey('в феврале месяце')] },
  };
  const engine = {
    active: true,
    hybrid: true,
    ranges: [
      {
        category: 'chancery',
        from: 1 + udpStart,
        to: 1 + udpEnd,
        fragment: 'осуществляет контроль',
        finding: { explanation: 'Канцелярит (UDPipe).' },
      },
      {
        category: 'redund',
        from: 1 + febStart,
        to: 1 + febStart + 'в феврале месяце'.length,
        fragment: 'в феврале месяце',
        finding: { explanation: 'Плеоназм (UDPipe).' },
      },
    ],
  };
  const { result, state } = runBuild(mod, [text, remarkPara], cfgEngine, engine);
  // chain/which без UDPipe не подтягивают эвристику src/style.js
  assert.equal(result.stats.chain, 0);
  assert.equal(result.stats.which, 0);
  // chancery: «осуществляет контроль» от UDPipe + «является» от src/style.js; «осуществляет» не дублируется
  assert.equal(result.stats.chancery, 2);
  const chDecos = byClass(result.set, 'an-chancery');
  assert.equal(chDecos.length, 2);
  assert.ok(chDecos.some((d) => d.from === 1 + udpStart && d.to === 1 + udpEnd && d.attrs['data-an-tip'] === 'Канцелярит (UDPipe).'));
  // лексические дополнения от src/style.js доходят с подсказками и попадают в счётчики и навигацию
  assert.ok(result.stats.weak >= 1 && byClass(result.set, 'an-weak').every((d) => !!d.attrs['data-an-tip']));
  assert.ok(result.stats.tell >= 1 && byClass(result.set, 'an-tell').every((d) => !!d.attrs['data-an-tip']));
  assert.ok(result.stats.remark >= 1 && byClass(result.set, 'an-remark').every((d) => !!d.attrs['data-an-tip']));
  assert.ok(result.stats.own >= 1 && byClass(result.set, 'an-own').every((d) => !!d.attrs['data-an-tip']));
  assert.equal(mod.analysisRanges(state).chancery.length, 2);
  // analysisSkip убирает «в феврале месяце» и у UDPipe, и у src/style.js
  assert.equal(result.stats.redund, 0);
  assert.equal(byClass(result.set, 'an-redund').length, 0);
});

test('движок (blocks): переиспользует UDPipe для частей речи, пассива, повторов по леммам и времён с уважением analysisSkip', () => {
  const line = 'Иван читал книгу. Книгу была открыта Иваном. Иван читает.';
  const pos = (w, occurrence = 0) => {
    let idx = -1;
    for (let n = 0; n <= occurrence; n += 1) idx = line.indexOf(w, idx + 1);
    return { start: idx, end: idx + w.length, from: 1 + idx, to: 1 + idx + w.length };
  };
  const blocks = new Map([[1, {
    words: [
      { ...pos('Иван', 0), text: 'Иван', lemma: 'иван', pos: 'noun', proper: true },
      { ...pos('читал', 0), text: 'читал', lemma: 'читать', pos: 'verb', proper: false },
      { ...pos('книгу', 0), text: 'книгу', lemma: 'книга', pos: 'noun', proper: false },
      { ...pos('Книгу', 0), text: 'Книгу', lemma: 'книга', pos: 'noun', proper: false },
      { ...pos('была', 0), text: 'была', lemma: 'быть', pos: 'verb', proper: false },
      { ...pos('открыта', 0), text: 'открыта', lemma: 'открыть', pos: 'part', proper: false },
      { ...pos('Иваном', 0), text: 'Иваном', lemma: 'иван', pos: 'noun', proper: true },
      { ...pos('Иван', 1), text: 'Иван', lemma: 'иван', pos: 'noun', proper: true },
      { ...pos('читает', 0), text: 'читает', lemma: 'читать', pos: 'verb', proper: false },
    ],
    passive: [{ ...pos('была открыта', 0), text: 'была открыта' }],
    tense: {
      past: 1,
      present: 1,
      items: [
        { ...pos('читал', 0), kind: 'past', conf: 'high', why: 'actor' },
        { ...pos('читает', 0), kind: 'present', conf: 'high', why: 'actor' },
      ],
    },
  }]]);

  const cfgUd = cfg({
    cats: { verb: true, part: true, noun: true, passive: true, repeat: true, tense: true },
    repeatWin: 20,
    skip: { passive: [skipKey('была открыта')] },
  });
  // Намеренно проверяем с all engine ranges = [] (активны только блоки)
  const { result, state } = runBuild(mod, [line], cfgUd, { active: true, hybrid: true, ranges: [], blocks });
  // «читал», «была», «читает» -> verb (3), «открыта» -> part (1), «Иван», «книгу», «Книгу», «Иваном», «Иван» -> noun (5)
  assert.equal(result.stats.verb, 3);
  assert.equal(result.stats.part, 1);
  assert.equal(result.stats.noun, 5);
  // «была открыта» исключено через analysisSkip
  assert.equal(result.stats.passive, 0);
  // Повторы по леммам: «книгу»/«Книгу» и «читал»/«читает» (итого 4 выделения), PROPN «Иван»/«Иваном»/«Иван» не отмечается!
  const repTexts = byClass(result.set, 'an-repeat').map((d) => line.slice(d.from - 1, d.to - 1));
  assert.deepEqual(repTexts, ['читал', 'книгу', 'Книгу', 'читает']);
  //scanTense с engine.blocks использует UD-разметку; с пустым engine без all checkboxes engine тоже сохраняется
  assert.equal(mod.analysisEngine(state).blocks, blocks);
  const ts = mod.scanTense(state.doc, 'past', mod.analysisEngine(state));
  assert.equal(ts.items.length, 1);
  assert.equal(line.slice(ts.items[0].from - 1, ts.items[0].to - 1), 'читает');

  // При сбросе engine (active: false / null) падает обратно на базовый разбор
  const cfgNoSkip = cfg({ cats: cfgUd.cats, repeatWin: 20 });
  const plain = runBuild(mod, [line], cfgNoSkip, null);
  assert.equal(plain.result.stats.passive, 1);
  assert.equal(mod.analysisEngine(plain.state), null);
});
