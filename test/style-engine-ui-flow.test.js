'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { Schema } = require('prosemirror-model');
const { createDocumentSnapshot, findingsToRanges } = require('../src/style-engine/pm-ranges');
const { analyzeStructural } = require('../src/style-engine/structural');
const { buildLinguisticBlocks } = require('../src/style-engine/linguistic');
const { loadAnalysis } = require('./analysis-harness');

const ROOT = path.resolve(__dirname, '..');
const SHADOW_SRC = fs.readFileSync(path.join(ROOT, 'renderer', 'app', '29-style-shadow.js'), 'utf8');

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline' },
  },
  marks: {},
});

function makeDoc(paragraphs) {
  return schema.node('doc', null, paragraphs.map((p) => schema.node('paragraph', null, p ? [schema.text(p)] : [])));
}

function makeEl() {
  const listeners = new Map();
  const attrs = {};
  return {
    hidden: false,
    disabled: false,
    checked: false,
    open: false,
    textContent: '',
    hasAttribute: (k) => Object.hasOwn(attrs, k),
    setAttribute: (k, v) => { attrs[k] = String(v); },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    async trigger(type) {
      for (const fn of listeners.get(type) || []) await fn({ target: this });
    },
  };
}

function makeStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    dump: () => Object.fromEntries(store.entries()),
  };
}

function makeTr(doc) {
  const metas = new Map();
  return {
    docChanged: false,
    doc,
    setMeta(k, v) { metas.set(k, v); return this; },
    getMeta(k) { return metas.get(k); },
  };
}

async function mountShadow({ storage, docText, apiStub, initialAn = null }) {
  const cats = initialAn || { chancery: true, redund: true, chain: true, weak: true, own: true, remark: true, tell: true, which: true };
  const analysisMod = await loadAnalysis(ROOT, 'ru');
  const [plugin] = analysisMod.TextAnalysis.plugins({
    getConfig: () => ({
      cats,
      longMin: 30,
      fillers: [],
      repeatWin: 25,
    }),
  });
  const doc = makeDoc([docText]);
  const state = { doc, tr: makeTr(doc), __an: null };
  state.__an = plugin.spec.state.init(null, state);
  const editor = {
    state,
    view: {
      dispatch(tr) {
        state.__an = plugin.spec.state.apply(tr, state.__an, null, state);
        state.tr = makeTr(state.doc);
      },
    },
  };

  const els = {
    '#styleEngineBox': makeEl(),
    '#styleEngineToggle': makeEl(),
    '#anModeHint': makeEl(),
  };
  const statusCalls = [];
  const errorCalls = [];

  const ctx = {
    window: {},
    document: { querySelector: (sel) => els[sel] || null },
    localStorage: storage,
    LANG: 'ru',
    settings: { an: { ...cats } },
    t: (s, ...a) => s.replace(/\{(\d+)\}/g, (m, i) => (a[i] === undefined ? m : a[i])),
    editor,
    api: apiStub,
    createDocumentSnapshot,
    findingsToRanges,
    analyzeStructural,
    buildLinguisticBlocks,
    applyEngineAnalysis: analysisMod.applyEngineAnalysis,
    analysisEngine: analysisMod.analysisEngine,
    analysisRanges: analysisMod.analysisRanges,
    setStatus: (kind, msg) => statusCalls.push({ kind, msg }),
    showError: (msg) => errorCalls.push(msg),
    performance: { now: () => Date.now() },
    setTimeout: (fn, ms) => global.setTimeout(fn, ms === 900 ? 15 : ms),
    clearTimeout: global.clearTimeout,
    Promise,
    JSON,
    Object,
    Array,
    Number,
    String,
    Error,
  };
  ctx.window = ctx;
  vm.runInNewContext(SHADOW_SRC, ctx, { filename: '29-style-shadow.js' });
  await new Promise((r) => setTimeout(r, 10));
  return { ctx, els, editor, analysisMod, statusCalls, errorCalls };
}

test('жизненный цикл встроенного стилевого движка: без ресурса скрыт, при готовой модели работает и переключается в базовый режим', async () => {
  const docText = 'Он вернулся обратно. Он был зол.';
  const storage = makeStorage();
  let modelReady = false;
  let parseCalls = 0;

  // Синтетический разбор первого предложения «Он вернулся обратно.» по контракту;
  // второе («Он был зол.») в гибридном режиме дополняется из src/style.js.
  const fakeParse = {
    schemaVersion: 1,
    parser: { name: 'udpipe-rs', version: '0.2', modelVersion: 'russian-gsd-ud-2.5-191206', modelSha256: 'ba63' },
    sentences: [{
      start: 0,
      end: 20,
      text: 'Он вернулся обратно.',
      tokens: [
        { id: 1, text: 'Он', lemma: 'он', upos: 'PRON', feats: { Case: 'Nom', Number: 'Sing', Person: '3' }, head: 2, deprel: 'nsubj', start: 0, end: 2 },
        { id: 2, text: 'вернулся', lemma: 'вернуться', upos: 'VERB', feats: { VerbForm: 'Fin' }, head: 0, deprel: 'root', start: 3, end: 11 },
        { id: 3, text: 'обратно', lemma: 'обратно', upos: 'ADV', feats: {}, head: 2, deprel: 'advmod', start: 12, end: 19 },
        { id: 4, text: '.', lemma: '.', upos: 'PUNCT', feats: {}, head: 2, deprel: 'punct', start: 19, end: 20 },
      ],
    }],
  };

  const makeApi = () => ({
    styleStatus: async () => ({ supported: true, ready: modelReady, modelVersion: 'russian-gsd-ud-2.5-191206' }),
    styleCancel: async () => true,
    styleParse: async (_text, taskId) => {
      parseCalls += 1;
      return { taskId, cancelled: false, parse: fakeParse };
    },
  });

  // 1. Когда модель недоступна (напр., на мобильной/веб-сборке): переключатель скрыт, style:parse не вызывается, работает базовый режим.
  const first = await mountShadow({ storage, docText, apiStub: makeApi() });
  assert.equal(first.els['#styleEngineBox'].hidden, true);
  assert.equal(first.els['#styleEngineToggle'].disabled, true);
  assert.equal(first.els['#styleEngineToggle'].checked, false);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(parseCalls, 0);
  assert.equal(first.editor.state.__an.engine, null);

  // 2. Встроенная модель готова сразу при запуске: переключатель виден и включён, есть подсветка и title.
  modelReady = true;
  const second = await mountShadow({ storage, docText, apiStub: makeApi() });
  assert.equal(second.els['#styleEngineBox'].hidden, false);
  assert.equal(second.els['#styleEngineToggle'].disabled, false);
  assert.equal(second.els['#styleEngineToggle'].checked, true);
  assert.match(second.els['#anModeHint'].textContent, /точный грамматический разбор/);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(parseCalls, 1);
  assert.equal(second.ctx.__styleShadow.status, 'ok');
  assert.equal(second.ctx.__styleShadow.acceptedRanges, 1);
  assert.equal(second.editor.state.__an.engine.hybrid, true);
  assert.equal(second.editor.state.__an.stats.redund, 1);
  assert.equal(second.editor.state.__an.stats.tell, 1);
  assert.equal(second.editor.state.__an.ranges.redund.length, 1);
  assert.equal(second.editor.state.__an.ranges.tell.length, 1);
  const redDeco = second.editor.state.__an.set.find((d) => d.attrs.class === 'an an-redund');
  assert.ok(redDeco && redDeco.attrs['data-an-tip'].length > 0, 'подсветка должна содержать объяснение в title');
  assert.match(redDeco.attrs['data-an-tip'], /Совет:/);
  const tellDeco = second.editor.state.__an.set.find((d) => d.attrs.class === 'an an-tell');
  assert.ok(tellDeco && tellDeco.attrs['data-an-tip'].length > 0, 'лексическое дополнение tell тоже должно подсвечиваться с title');
  assert.equal(second.analysisMod.stepIndex(second.editor.state.__an.ranges.redund, 0, 1), 0);

  // 3. Переключение в базовый режим (даже если ранее стоял флаг тени kabinet.styleEngineShadow='1').
  storage.setItem('kabinet.styleEngineShadow', '1');
  second.els['#styleEngineToggle'].checked = false;
  await second.els['#styleEngineToggle'].trigger('change');
  assert.equal(second.ctx.kabinetStyleShadow.enabled(), false);
  assert.equal(storage.getItem('kabinet.styleEngineMode'), 'basic');
  assert.equal(storage.getItem('kabinet.styleEngineShadow'), null);
  assert.equal(second.editor.state.__an.engine.active, false);
  assert.match(second.els['#anModeHint'].textContent, /приблизительный/);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(parseCalls, 1, 'в базовом режиме style:parse не вызывается');
});

test('интерфейс анализа и структурные советы: #anPop, сводка главы, быстрые переключатели и «Совет:» во всех 8 категориях', () => {
  const structuralSrc = fs.readFileSync(path.join(ROOT, 'src', 'style-engine', 'structural.js'), 'utf8');
  const adviceMatches = structuralSrc.match(/Совет:/g) || [];
  assert.equal(adviceMatches.length, 16, 'все 16 шаблонов правил в structural.js должны содержать практический «Совет:»');

  const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
  for (const needle of ['id="anPop"', 'id="anSummary"', 'id="anModeHint"', 'id="btnStyleAll"', 'id="btnStyleNone"', 'id="btnAnNone"', 'id="styleEngineBox"']) {
    assert.ok(html.includes(needle), `в index.html должен присутствовать ${needle}`);
  }
  assert.ok(!html.includes('btnStylePickModel'), 'кнопка ручного подключения файла модели должна быть удалена');
});

test('раздел «Проверка»: при готовой модели подключает пассив/повторы/времена и кэширует parse без лишних вызовов', async () => {
  const docText = 'Дверь была открыта ключом.';
  const storage = makeStorage();
  let parseCalls = 0;
  const fakeParse = {
    schemaVersion: 1,
    parser: { name: 'udpipe-rs', version: '0.2', modelVersion: 'russian-gsd-ud-2.5-191206', modelSha256: 'ba63' },
    sentences: [{
      start: 0,
      end: docText.length,
      text: docText,
      tokens: [
        { id: 1, text: 'Дверь', lemma: 'дверь', upos: 'NOUN', feats: { Case: 'Nom' }, head: 3, deprel: 'nsubj:pass', start: 0, end: 5 },
        { id: 2, text: 'была', lemma: 'быть', upos: 'AUX', feats: { VerbForm: 'Fin', Tense: 'Past' }, head: 3, deprel: 'aux:pass', start: 6, end: 10 },
        { id: 3, text: 'открыта', lemma: 'открыть', upos: 'VERB', feats: { VerbForm: 'Part', Voice: 'Pass', Variant: 'Short' }, head: 0, deprel: 'root', start: 11, end: 18 },
        { id: 4, text: 'ключом', lemma: 'ключ', upos: 'NOUN', feats: { Case: 'Ins' }, head: 3, deprel: 'obl', start: 19, end: 25 },
        { id: 5, text: '.', lemma: '.', upos: 'PUNCT', feats: {}, head: 3, deprel: 'punct', start: 25, end: 26 },
      ],
    }],
  };
  const apiStub = {
    styleStatus: async () => ({ supported: true, ready: true, modelVersion: 'russian-gsd-ud-2.5-191206' }),
    styleCancel: async () => true,
    styleParse: async (_text, taskId) => {
      parseCalls += 1;
      return { taskId, cancelled: false, parse: fakeParse };
    },
  };

  // Все категории стиля выключены — включён только «passive» в #checkPanel.
  const mounted = await mountShadow({ storage, docText, apiStub, initialAn: { passive: true } });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(parseCalls, 1, 'style:parse запускается даже при выключенном «Стиле текста»');
  assert.ok(mounted.editor.state.__an.engine.blocks instanceof Map);
  assert.equal(mounted.editor.state.__an.stats.passive, 1);
  assert.match(mounted.els['#anModeHint'].textContent, /точный грамматический разбор/);

  // Переключение галочек на неизменном тексте не вызывает style:parse повторно (берётся кэш).
  mounted.ctx.settings.an = { passive: true, verb: true, noun: true };
  mounted.ctx.scheduleStyleShadow();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(parseCalls, 1, 'кэш документа переиспользуется без повторного style:parse');
  assert.equal(mounted.editor.state.__an.stats.noun, 2);

  // Отключение точного разбора возвращает подсказку базового режима.
  mounted.els['#styleEngineToggle'].checked = false;
  await mounted.els['#styleEngineToggle'].trigger('change');
  assert.match(mounted.els['#anModeHint'].textContent, /приблизительный/);
});
