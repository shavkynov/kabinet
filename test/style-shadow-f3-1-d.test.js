'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Schema } = require('prosemirror-model');
const { EditorState, Plugin, PluginKey } = require('prosemirror-state');
const { history, undo, redo } = require('prosemirror-history');
const { createDocumentSnapshot, findingsToRanges } = require('../src/style-engine/pm-ranges');
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

function makeDoc(paragraphs) {
  return schema.node(
    'doc',
    null,
    paragraphs.map((p) => schema.node('paragraph', null, p ? [schema.text(p)] : [])),
  );
}

// Реальная логика состояния TextAnalysis из renderer/analysis.js (сброс engine при любом tr.docChanged).
function makeRealPmEnginePlugin(initialConfig) {
  const key = new PluginKey('textAnalysisF31D');
  const ENGINE_META = 'styleEngineRanges';
  const buildState = (doc, engine) => {
    if (engine && engine.active) {
      return { active: true, engine: true, ranges: engine.ranges || [], docSize: doc.content.size };
    }
    return { active: false, engine: false, ranges: [], docSize: doc.content.size };
  };
  const plugin = new Plugin({
    key,
    state: {
      init: (_, state) => buildState(state.doc, null),
      apply: (tr, old, _o, state) => {
        const engine = tr.getMeta(ENGINE_META);
        if (engine !== undefined) return buildState(state.doc, engine);
        if (tr.getMeta(key)) return buildState(state.doc, old.engine ? { active: true, ranges: old.ranges } : null);
        if (!tr.docChanged) return old;
        return buildState(state.doc, null);
      },
    },
  });
  return { key, plugin, ENGINE_META, initialConfig };
}

function makeFinding(snapshot, fragment, category = 'chancery') {
  const start = snapshot.text.indexOf(fragment);
  assert.ok(start >= 0, `не найден фрагмент: ${fragment}`);
  return {
    category,
    ruleId: `test.${category}`,
    start,
    end: start + fragment.length,
    fragment,
    explanation: 'test',
    method: ['test'],
    confidence: 'low',
    limitations: [],
  };
}

test('второй лист (05-pane2.js) изолирован от TextAnalysis и теневого анализа', () => {
  const pane2Src = fs.readFileSync(path.join(ROOT, 'renderer', 'app', '05-pane2.js'), 'utf8');
  assert.ok(!/\bTextAnalysis\b/.test(pane2Src), 'editor2 не должен подключать TextAnalysis');
  assert.ok(!/\bscheduleStyleShadow\b/.test(pane2Src), 'editor2 не должен запускать scheduleStyleShadow');
  assert.ok(!/\bapplyEngineAnalysis\b/.test(pane2Src), 'editor2 не должен вызывать applyEngineAnalysis');

  const { key, plugin, ENGINE_META } = makeRealPmEnginePlugin();
  let state1 = EditorState.create({ doc: makeDoc(['Осуществление проверки затянулось.']), plugins: [history(), plugin] });
  let state2 = EditorState.create({ doc: makeDoc(['Другой текст во втором листе.']), plugins: [history()] });

  const snap1 = createDocumentSnapshot(state1.doc);
  const adapted = findingsToRanges(snap1, [
    makeFinding(snap1, 'Осуществление проверки', 'chancery'),
  ], state1.doc);
  assert.equal(adapted.ranges.length, 1);

  state1 = state1.apply(state1.tr.setMeta(ENGINE_META, { active: true, ranges: adapted.ranges }).setMeta('addToHistory', false));
  assert.equal(key.getState(state1).ranges.length, 1);
  assert.equal(state2.doc.textContent, 'Другой текст во втором листе.');

  // Правка и замена текста во втором листе не трогают состояние первого листа.
  state2 = state2.apply(state2.tr.insertText('Ещё ', 1));
  assert.equal(key.getState(state1).ranges.length, 1);
  assert.equal(key.getState(state1).engine, true);
});

test('история редактирования: applyEngineAnalysis не попадает в undo, а undo/redo сбрасывают устаревшие ranges', async () => {
  const analysisMod = await loadAnalysis(ROOT, 'ru');
  assert.equal(typeof analysisMod.applyEngineAnalysis, 'function');

  // Проверяем по исходнику renderer/analysis.js, что applyEngineAnalysis ставит addToHistory: false.
  const analysisSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'analysis.js'), 'utf8');
  assert.match(analysisSrc, /setMeta\(ENGINE_META,\s*payload\s*\|\|\s*null\)\.setMeta\('addToHistory',\s*false\)/);

  const { key, plugin, ENGINE_META } = makeRealPmEnginePlugin();
  const initialText = 'Начало. Осуществление проверки затянулось. Конец.';
  let state = EditorState.create({ doc: makeDoc([initialText]), plugins: [history(), plugin] });

  const applyForCurrentDoc = (st) => {
    const snap = createDocumentSnapshot(st.doc);
    const adapted = findingsToRanges(snap, [
      makeFinding(snap, 'Осуществление проверки', 'chancery'),
    ], st.doc);
    assert.equal(adapted.ranges.length, 1);
    const r = adapted.ranges[0];
    assert.equal(st.doc.textBetween(r.from, r.to, '', ''), 'Осуществление проверки');
    return st.apply(st.tr.setMeta(ENGINE_META, { active: true, ranges: adapted.ranges }).setMeta('addToHistory', false));
  };

  state = applyForCurrentDoc(state);
  assert.equal(key.getState(state).ranges.length, 1);
  // После смены главы / применения движка стек undo пуст.
  assert.equal(undo(state, (tr) => { state = state.apply(tr); }), false);

  // Правка ДО найденного фрагмента и ПОСЛЕ него.
  state = state.apply(state.tr.insertText('Очень ', 1));
  assert.equal(key.getState(state).engine, false, 'правка должна сразу сбрасывать устаревшие ranges движка');
  assert.equal(key.getState(state).ranges.length, 0);

  state = applyForCurrentDoc(state);
  assert.equal(key.getState(state).ranges.length, 1);

  const endPos = state.doc.content.size - 1;
  state = state.apply(state.tr.insertText(' Точка.', endPos));
  assert.equal(key.getState(state).engine, false, 'правка после фрагмента тоже сбрасывает устаревшие ranges');

  // Ctrl+Z (undo) должен откатывать текст и не оставлять устаревшие ranges.
  const undone1 = undo(state, (tr) => { state = state.apply(tr); });
  assert.equal(undone1, true);
  assert.equal(key.getState(state).engine, false);
  assert.equal(state.doc.textContent, 'Очень ' + initialText);

  const undone2 = undo(state, (tr) => { state = state.apply(tr); });
  assert.equal(undone2, true);
  assert.equal(state.doc.textContent, initialText);

  // Повторный анализ актуального текста после undo.
  state = applyForCurrentDoc(state);
  assert.equal(key.getState(state).ranges.length, 1);

  // Ctrl+Shift+Z (redo) сбрасывает ranges и позволяет повторный анализ.
  const redone = redo(state, (tr) => { state = state.apply(tr); });
  assert.equal(redone, true);
  assert.equal(key.getState(state).engine, false);
  state = applyForCurrentDoc(state);
  assert.equal(key.getState(state).ranges.length, 1);
});

test('символы и границы текста: BOM в начале и внутри строки, NBSP, ZWSP, emoji, U+2028/U+2029', () => {
  const p1 = '\uFEFFОсуществление\u00A0проверки\u200B затянулось.';
  const p2 = 'Он 😀 пришёл\uFEFF и\u2028вернулся обратно.\u2029Конец.';
  const doc = makeDoc([p1, p2]);
  const snap = createDocumentSnapshot(doc);
  assert.equal(snap.text, `${p1}\n\n${p2}`);

  const targets = [
    { category: 'chancery', needle: 'Осуществление\u00A0проверки' },
    { category: 'redund', needle: 'вернулся обратно' },
  ];
  const findings = targets.map(({ category, needle }) => makeFinding(snap, needle, category));

  const res = findingsToRanges(snap, findings, doc);
  assert.equal(res.diagnostics.length, 0);
  assert.equal(res.ranges.length, 2);
  for (let i = 0; i < res.ranges.length; i += 1) {
    const r = res.ranges[i];
    assert.equal(doc.textBetween(r.from, r.to, '', ''), targets[i].needle);
  }
});
