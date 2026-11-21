'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Schema } = require('prosemirror-model');
const { createDocumentSnapshot, findingsToRanges } = require('../src/style-engine/pm-ranges');
const { analyzeStructural } = require('../src/style-engine/structural');
const { buildLinguisticBlocks } = require('../src/style-engine/linguistic');
const { loadAnalysis } = require('./analysis-harness');

const ROOT = path.resolve(__dirname, '..');

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline' },
  },
  marks: {},
});

function build60kDoc() {
  const base = 'Он медленно шёл по тёмной улице мимо старых домов и тихо думал о том что случилось вчера вечером у пристани когда холодный ветер нёс запах дыма. Потом герой вернулся обратно к старому фонарю. Ветер дул сильнее и сильнее над рекой. ';
  // В базовом тексте 40 слов; 1500 абзацев = 60 000 слов.
  const paraNodes = [];
  for (let i = 0; i < 1500; i += 1) {
    const p = `${base}Глава строка номер ${i}.`;
    paraNodes.push(schema.node('paragraph', null, [schema.text(p)]));
  }
  return { doc: schema.node('doc', null, paraNodes), paraNodes };
}

test('60 000 слов: TextAnalysis при активном движке не перестраивает документ синхронно при наборе', async () => {
  const analysisMod = await loadAnalysis(ROOT, 'ru');
  const [plugin] = analysisMod.TextAnalysis.plugins({
    getConfig: () => ({ cats: { redund: true, adv: true }, longMin: 30, fillers: [], repeatWin: 25 }),
  });
  const { doc } = build60kDoc();
  let mapped = false;
  const fakeSet = { map: () => { mapped = true; return fakeSet; }, find: () => [] };
  const prevState = {
    active: true,
    set: fakeSet,
    stats: { redund: 1500 },
    ranges: {},
    engine: { active: true, ranges: [] },
    stale: false,
  };
  const tr = {
    docChanged: true,
    doc,
    mapping: {},
    getMeta: () => undefined,
  };
  const t0 = performance.now();
  const next = plugin.spec.state.apply(tr, prevState, null, { doc });
  const dt = performance.now() - t0;
  assert.equal(mapped, true);
  assert.equal(next.stale, true);
  assert.equal(next.engine, null);
  assert.ok(dt < 25, `apply при наборе занял ${dt.toFixed(1)} мс`);
});

test('60 000 слов: поабзацный LRU-кэш и порционный разбор style:parse в 29-style-shadow.js', async () => {
  const shadowSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'app', '29-style-shadow.js'), 'utf8');
  const analysisMod = await loadAnalysis(ROOT, 'ru');
  const { doc, paraNodes } = build60kDoc();
  const [plugin] = analysisMod.TextAnalysis.plugins({
    getConfig: () => ({ cats: { redund: true }, longMin: 30, fillers: [], repeatWin: 25 }),
  });

  const state = { doc, selection: { from: doc.content.size - 10 }, tr: { docChanged: false, doc, setMeta: () => state.tr, getMeta: () => undefined }, __an: null };
  state.__an = plugin.spec.state.init(null, state);
  const editor = {
    state,
    view: {
      dispatch(tr) {
        state.__an = plugin.spec.state.apply(tr, state.__an, null, state);
        state.tr = { docChanged: false, doc: state.doc, setMeta(k, v) { this[k] = v; return this; }, getMeta(k) { return this[k]; } };
      },
    },
  };

  const sentChars = [];
  let parseCalls = 0;
  const apiStub = {
    styleStatus: async () => ({ supported: true, ready: true, modelVersion: 'russian-gsd' }),
    styleCancel: async () => true,
    styleParse: async (text, taskId) => {
      parseCalls += 1;
      sentChars.push(text.length);
      // Разбиваем чанк по «Потом герой вернулся обратно к старому фонарю.» для синтетического разбора с точными UTF-16 смещениями.
      const sentences = [];
      const needle = 'Потом герой вернулся обратно к старому фонарю.';
      let idx = 0;
      while ((idx = text.indexOf(needle, idx)) >= 0) {
        const start = idx;
        const end = idx + needle.length;
        sentences.push({
          start,
          end,
          text: needle,
          tokens: [
            { id: 1, text: 'Потом', lemma: 'потом', upos: 'ADV', feats: {}, head: 3, deprel: 'advmod', start, end: start + 5 },
            { id: 2, text: 'герой', lemma: 'герой', upos: 'NOUN', feats: { Case: 'Nom' }, head: 3, deprel: 'nsubj', start: start + 6, end: start + 11 },
            { id: 3, text: 'вернулся', lemma: 'вернуться', upos: 'VERB', feats: { VerbForm: 'Fin' }, head: 0, deprel: 'root', start: start + 12, end: start + 20 },
            { id: 4, text: 'обратно', lemma: 'обратно', upos: 'ADV', feats: {}, head: 3, deprel: 'advmod', start: start + 21, end: start + 28 },
            { id: 5, text: '.', lemma: '.', upos: 'PUNCT', feats: {}, head: 3, deprel: 'punct', start: end - 1, end },
          ],
        });
        idx = end;
      }
      return { taskId, cancelled: false, parse: { schemaVersion: 1, parser: { name: 'udpipe-rs', version: '0.2' }, sentences } };
    },
  };

  const noopEl = { hidden: false, disabled: false, checked: false, addEventListener() {} };
  const ctx = {
    window: {},
    document: { querySelector: () => noopEl },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    LANG: 'ru',
    settings: { an: { redund: true } },
    t: (s) => s,
    editor,
    api: apiStub,
    createDocumentSnapshot,
    findingsToRanges,
    analyzeStructural,
    buildLinguisticBlocks,
    applyEngineAnalysis: analysisMod.applyEngineAnalysis,
    analysisEngine: analysisMod.analysisEngine,
    analysisRanges: analysisMod.analysisRanges,
    performance,
    setTimeout: (fn, ms) => global.setTimeout(fn, ms >= 900 ? 10 : ms),
    clearTimeout: global.clearTimeout,
  };
  ctx.window = ctx;

  vm.runInNewContext(shadowSrc, ctx, { filename: '29-style-shadow.js' });
  await new Promise((r) => setTimeout(r, 120));

  assert.ok(parseCalls > 20, `глава в 60k слов должна дробиться на чанки <= 8000 зн. (вызовов: ${parseCalls})`);
  assert.ok(Math.max(...sentChars) <= 8100, `максимальный чанк: ${Math.max(...sentChars)}`);
  assert.equal(ctx.__styleShadow.status, 'ok');
  assert.equal(ctx.__styleShadow.acceptedRanges, 1500);

  // Редактируем 1 абзац из 1500: в style:parse должен уйти ТОЛЬКО этот абзац!
  const editedNodes = paraNodes.slice();
  const replacementPara = 'Автор мгновенно поправил абзац и вернулся обратно к делу.';
  editedNodes[750] = schema.node('paragraph', null, [schema.text(replacementPara)]);
  state.doc = schema.node('doc', null, editedNodes);
  sentChars.length = 0;
  const callsBeforeEdit = parseCalls;
  ctx.scheduleStyleShadow();
  await new Promise((r) => setTimeout(r, 60));

  assert.equal(parseCalls - callsBeforeEdit, 1, 'после правки 1 абзаца должен быть ровно 1 вызов style:parse');
  assert.equal(sentChars[0], replacementPara.length, `в style:parse должен уйти только изменённый абзац (${replacementPara.length} зн., а ушло ${sentChars[0]})`);
  assert.equal(ctx.__styleShadow.status, 'ok');
  assert.equal(ctx.__styleShadow.acceptedRanges, 1499);
});

test('60 000 слов: поабзацный кэш computeStats совпадает с полным подсчётом и работает за < 25 мс', () => {
  const goalSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'app', '27-goal.js'), 'utf8');
  const { doc, paraNodes } = build60kDoc();
  const state = { doc };
  const ctx = {
    editor: {
      state,
      getText: ({ blockSeparator } = {}) => state.doc.textBetween(0, state.doc.content.size, blockSeparator || '\n', ''),
    },
    window: {},
    document: { querySelector: () => null },
  };
  ctx.window = ctx;
  vm.runInNewContext(goalSrc, ctx, { filename: '27-goal.js' });

  const fullText = ctx.editor.getText({ blockSeparator: '\n' });
  const flat = fullText.replace(/\n/g, '');
  const expectedWords = (fullText.match(/[\p{L}\p{N}]+(?:[-–’'][\p{L}\p{N}]+)*/gu) || []).length;
  assert.ok(expectedWords >= 60000, `слов в синтетической главе: ${expectedWords}`);

  const cold = ctx.computeStats();
  assert.equal(cold.words, expectedWords);
  assert.equal(cold.chars, flat.length);
  assert.equal(cold.charsNoSpace, flat.replace(/\s/g, '').length);

  // Повторный вызов после правки 1 абзаца из 1500
  const nextNodes = paraNodes.slice();
  nextNodes[500] = schema.node('paragraph', null, [schema.text('Короткая правка одного абзаца.')]);
  state.doc = schema.node('doc', null, nextNodes);
  const t0 = performance.now();
  const warm = ctx.computeStats();
  const dt = performance.now() - t0;
  const expectedWarm = (state.doc.textBetween(0, state.doc.content.size, '\n', '').match(/[\p{L}\p{N}]+(?:[-–’'][\p{L}\p{N}]+)*/gu) || []).length;
  assert.equal(warm.words, expectedWarm);
  assert.ok(dt < 25, `инкрементальный подсчёт 60 000 слов занял ${dt.toFixed(1)} мс`);
});
