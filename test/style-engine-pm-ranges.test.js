'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Schema } = require('prosemirror-model');
const { createDocumentSnapshot, findingsToRanges } = require('../src/style-engine/pm-ranges');

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline' },
    heading: { content: 'inline*', group: 'block', attrs: { level: { default: 1 } }, defining: true },
    blockquote: { content: 'block+', group: 'block', defining: true },
    bullet_list: { content: 'list_item+', group: 'block' },
    list_item: { content: 'paragraph block*', defining: true },
    codeBlock: { content: 'text*', group: 'block', marks: '', code: true, defining: true },
    hardBreak: { inline: true, group: 'inline', selectable: false },
    image: { inline: true, group: 'inline', attrs: { src: { default: '' } } },
  },
  marks: {},
});

const p = (...content) => schema.node('paragraph', null, content);
const t = (text) => schema.text(text);
const hb = () => schema.node('hardBreak');
const img = () => schema.node('image', { src: 'x' });
const li = (...content) => schema.node('list_item', null, content);
const ul = (...content) => schema.node('bullet_list', null, content);

function makeDoc() {
  return schema.node('doc', null, [
    p(t('Первый абзац.')),
    ul(
      li(p(t('Пункт один')), ul(li(p(t('Вложенный пункт'))))),
      li(p(t('Пункт два'))),
    ),
    schema.node('blockquote', null, [p(t('Цитата'))]),
    schema.node('heading', { level: 2 }, [t('Заголовок')]),
    p(t('До'), hb(), t('После')),
    p(t('😀 emoji')),
    p(img()),
    schema.node('codeBlock', null, [t('code text')]),
    p(),
  ]);
}

function finding(snapshot, fragment, category = 'chain', extra = {}) {
  const start = snapshot.text.indexOf(fragment);
  assert.ok(start >= 0, `нет фрагмента ${fragment}`);
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
    ...extra,
  };
}

const map = (snapshot, findings, currentDoc = snapshot.doc) => findingsToRanges(snapshot, findings, currentDoc);

test('pm-ranges: snapshot text совпадает с doc.textBetween', () => {
  const doc = makeDoc();
  const snapshot = createDocumentSnapshot(doc);
  assert.equal(snapshot.text, doc.textBetween(0, doc.content.size, '\n\n', '\n'));
  assert.ok(snapshot.segments.length >= 7);
});

test('pm-ranges: обычные абзацы, вложенный список, blockquote и heading', () => {
  const doc = makeDoc();
  const snapshot = createDocumentSnapshot(doc);
  for (const fragment of ['Первый абзац.', 'Пункт один', 'Вложенный пункт', 'Цитата', 'Заголовок']) {
    const r = map(snapshot, [finding(snapshot, fragment)]).ranges;
    assert.equal(r.length, 1, fragment);
    assert.equal(doc.textBetween(r[0].from, r[0].to, '', ''), fragment, fragment);
  }
});

test('pm-ranges: hard break и inline leaf отклоняются', () => {
  const doc = makeDoc();
  const snapshot = createDocumentSnapshot(doc);
  const hard = map(snapshot, [finding(snapshot, 'До\nПосле')]);
  assert.deepEqual(hard.ranges, []);
  assert.ok(hard.diagnostics.some((d) => d.code === 'leaf-boundary'));
  const inlineLeaf = snapshot.segments.find((s) => s.text === '\n' && s.analyzable);
  assert.ok(inlineLeaf);
  const image = map(snapshot, [{
    category: 'chain', ruleId: 'test',
    start: inlineLeaf.parserStart, end: inlineLeaf.parserStart + 1,
    fragment: snapshot.text.slice(inlineLeaf.parserStart, inlineLeaf.parserStart + 1),
    explanation: 'test', method: ['test'], confidence: 'low', limitations: [],
  }]);
  assert.deepEqual(image.ranges, []);
  assert.ok(image.diagnostics.some((d) => d.code === 'leaf-boundary'));
});

test('pm-ranges: emoji и surrogate pairs сохраняют UTF-16 offsets', () => {
  const doc = makeDoc();
  const snapshot = createDocumentSnapshot(doc);
  const r = map(snapshot, [finding(snapshot, '😀 emoji')]).ranges;
  assert.equal(r.length, 1);
  assert.equal(r[0].fragment.length, '😀 emoji'.length);
  assert.equal(doc.textBetween(r[0].from, r[0].to, '', ''), '😀 emoji');
});

test('pm-ranges: codeBlock, пустой блок и граница сегментов отклоняются', () => {
  const doc = makeDoc();
  const snapshot = createDocumentSnapshot(doc);
  const code = map(snapshot, [finding(snapshot, 'code text')]);
  assert.deepEqual(code.ranges, []);
  assert.ok(code.diagnostics.some((d) => d.code === 'skipped-block'));
  const first = snapshot.text.indexOf('Первый абзац.');
  const second = snapshot.text.indexOf('Пункт один');
  const boundary = map(snapshot, [{
    category: 'chain', ruleId: 'test', start: first, end: second,
    fragment: snapshot.text.slice(first, second), explanation: 'test', method: ['test'], confidence: 'low', limitations: [],
  }]);
  assert.deepEqual(boundary.ranges, []);
  assert.ok(boundary.diagnostics.some((d) => d.code === 'crosses-segment'));
});
test('pm-ranges: пустой блок не анализируется', () => {
  const doc = makeDoc();
  const snapshot = createDocumentSnapshot(doc);
  const empty = snapshot.segments.find((s) => s.parserStart === s.parserEnd);
  assert.ok(empty);
  const start = empty.parserStart;
  const finding = {
    category: 'chain', ruleId: 'test', start, end: start + 1,
    fragment: snapshot.text.slice(start, start + 1),
    explanation: 'test', method: ['test'], confidence: 'low', limitations: [],
  };
  const res = map(snapshot, [finding]);
  assert.deepEqual(res.ranges, []);
  assert.ok(res.diagnostics.length > 0);
});

test('pm-ranges: без currentDoc возвращается missing-current-document', () => {
  const doc = makeDoc();
  const snapshot = createDocumentSnapshot(doc);
  const res = findingsToRanges(snapshot, [finding(snapshot, 'Цитата')]);
  assert.deepEqual(res.ranges, []);
  assert.ok(res.diagnostics.some((d) => d.code === 'missing-current-document'));
});

test('pm-ranges: изменённый документ отбрасывает результат', () => {
  const doc = makeDoc();
  const snapshot = createDocumentSnapshot(doc);
  const f = finding(snapshot, 'Первый абзац.');
  const changed = schema.node('doc', null, [p(t('Другой текст'))]);
  const res = map(snapshot, [f], changed);
  assert.deepEqual(res.ranges, []);
  assert.ok(res.diagnostics.some((d) => d.code === 'document-changed'));
});

test('pm-ranges: неверные offsets и fragment отклоняются', () => {
  const doc = makeDoc();
  const snapshot = createDocumentSnapshot(doc);
  const base = finding(snapshot, 'Цитата');
  const badRange = { ...base, start: -1 };
  const badFragment = { ...base, fragment: 'не то' };
  const res = map(snapshot, [badRange, badFragment]);
  assert.deepEqual(res.ranges, []);
  assert.equal(res.diagnostics.length, 2);
});

test('pm-ranges: частичные пересечения одной категории сохраняются', () => {
  const doc = makeDoc();
  const snapshot = createDocumentSnapshot(doc);
  const base = finding(snapshot, 'Первый абзац.');
  const left = { ...base, end: base.start + 8, fragment: snapshot.text.slice(base.start, base.start + 8) };
  const right = { ...base, start: base.start + 5, fragment: snapshot.text.slice(base.start + 5, base.end) };
  const res = map(snapshot, [left, right]);
  assert.equal(res.ranges.filter((r) => r.category === 'chain').length, 2);
  assert.equal(res.droppedNested, 0);
});

test('pm-ranges: вложенные дубли одной категории удаляются, разные категории сохраняются', () => {
  const doc = makeDoc();
  const snapshot = createDocumentSnapshot(doc);
  const outer = finding(snapshot, 'Первый абзац.');
  const inner = { ...finding(snapshot, 'абзац'), start: outer.start + 7, end: outer.start + 12 };
  inner.fragment = snapshot.text.slice(inner.start, inner.end);
  const sameOther = { ...outer, category: 'tell', ruleId: 'test.tell' };
  const res = map(snapshot, [inner, outer, sameOther]);
  assert.equal(res.ranges.filter((r) => r.category === 'chain').length, 1);
  assert.equal(res.ranges.filter((r) => r.category === 'tell').length, 1);
  assert.ok(res.droppedNested >= 1);
});
