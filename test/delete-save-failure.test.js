'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (name) => fs.readFileSync(path.join(__dirname, '..', 'renderer/app', name), 'utf8');
const source = read('13-save.js') + '\n' + read('14-lists.js');
const keys = { chapter: 'chapters', character: 'characters', place: 'places', item: 'items', note: 'notes' };

function setup(kind = 'chapter', options = {}) {
  const elements = new Map();
  const events = [];
  const ctx = {
    text: 'unsaved text', failing: false, events,
    window: { __TAURI__: {}, addEventListener() {} },
    console: { error() {} }, setTimeout: () => 1, clearTimeout() {},
    $: (selector) => {
      if (!elements.has(selector)) elements.set(selector, { textContent: '', className: '' });
      return elements.get(selector);
    },
    document: { body: { classList: { toggle() {} } } },
    getMarkdown: () => ctx.text,
    refreshCommentAnchors() {}, noteSyncConflict() {}, refreshIndex() {},
    fillP2Select() {}, updateNoteTitle() {}, refreshGoalUI() {},
    clearChapMeta() {}, resetPane2() {},
    setEditorContent(text) { ctx.text = text; },
    showError(message) { events.push(['error', message]); },
    t: (text, value) => text.replace('{0}', value),
    SAVE_DELAY_MS: 1500,
  };
  for (const op of ['flushNote', 'flushComments', 'flushChapMeta', 'flushPane2']) {
    ctx[op] = async () => {
      if (options.failed === op) return false;
      return true;
    };
  }
  const updated = { chapters: [], characters: [], places: [], items: [], notes: [], trash: [] };
  async function write(k, id, text) {
    events.push(['write', k, id, text]);
    if (ctx.failing) throw new Error('disk full');
    return {};
  }
  async function remove(k, id) {
    events.push(['delete', k, id]);
    if (options.deleteThrows) throw new Error('trash unavailable');
    return options.cancelDelete ? null : updated;
  }
  ctx.api = {
    writeChapter: (id, text) => write('chapter', id, text),
    writeItem: write,
    deleteChapter: (id) => remove('chapter', id),
    deleteItem: remove,
  };
  vm.createContext(ctx);
  vm.runInContext(`
    let dirty = false, dirtyId = null, dirtyKind = null, currentId = 'aaaaaa', currentKind = ${JSON.stringify(kind)};
    let busy = false, saveTimer = null, statusTimer = null, noteDirty = false, cmtDirty = false, cmDirty = false;
    const p2 = { dirty: false, id: null, token: 0 };
    const chapterWords = new Map([['aaaaaa', 3]]), chapterChars = new Map([['aaaaaa', 12]]);
    let project = ${JSON.stringify({ chapters: [], characters: [], places: [], items: [], notes: [], trash: [], [keys[kind]]: [{ id: 'aaaaaa', title: 'Document' }] })};
    let openToken = 0, noteToken = 0, cmToken = 0;
    ${source}
    cardView = { toJSON: () => JSON.stringify({ short: text }) };
    lastSelected[currentKind] = currentId;
  `, ctx);
  const run = (code) => vm.runInContext(code, ctx);
  return { ctx, run, elements, events };
}

for (const kind of ['chapter', 'character', 'place', 'item']) {
  test('failed save blocks deletion and keeps retry state: ' + kind, async () => {
    const { ctx, run, elements, events } = setup(kind);
    run('markDirty()');
    ctx.failing = true;
    await run(`deleteDoc(${JSON.stringify(kind)}, 'aaaaaa')`);
    assert.equal(events.filter((e) => e[0] === 'delete').length, 0);
    assert.equal(run('currentId'), 'aaaaaa');
    assert.equal(run('dirty'), true);
    assert.equal(run('failedWrite.id'), 'aaaaaa');
    assert.equal(run('failedWrite.kind'), kind);
    assert.equal(run('lastSelected[currentKind]'), 'aaaaaa');
    assert.equal(ctx.text, 'unsaved text');
    assert.equal(run('busy'), false);
    assert.equal(elements.get('#status').className, 'error');
    assert.equal(run('itemsOf(currentKind).length'), 1);
    if (kind === 'chapter') assert.equal(run("chapterWords.has('aaaaaa') && chapterChars.has('aaaaaa')"), true);
  });
}

for (const failed of ['flushNote', 'flushComments', 'flushChapMeta', 'flushPane2']) {
  test('failed auxiliary save blocks deletion: ' + failed, async () => {
    const { run, events } = setup('chapter', { failed });
    await run("deleteDoc('chapter', 'aaaaaa')");
    assert.equal(events.some((e) => e[0] === 'delete'), false);
    assert.equal(run('currentId'), 'aaaaaa');
    assert.equal(run('project.chapters.length'), 1);
    assert.equal(run('busy'), false);
  });
}

for (const kind of ['chapter', 'character', 'note']) {
  test('successful flush still permits deletion: ' + kind, async () => {
    const { run, events } = setup(kind);
    await run(`deleteDoc(${JSON.stringify(kind)}, 'aaaaaa')`);
    assert.deepEqual(events.filter((e) => e[0] === 'delete'), [['delete', kind, 'aaaaaa']]);
    assert.equal(run('currentId'), null);
    assert.equal(run('busy'), false);
  });
}

test('retry writes the newest text before deletion', async () => {
  const { ctx, run, events } = setup();
  ctx.failing = true;
  run('markDirty()');
  await run("deleteDoc('chapter', 'aaaaaa')");
  assert.equal(events.some((e) => e[0] === 'delete'), false);
  ctx.text = 'newest text';
  ctx.failing = false;
  run('markDirty()');
  await run("deleteDoc('chapter', 'aaaaaa')");
  assert.deepEqual(events.slice(-2), [['write', 'chapter', 'aaaaaa', 'newest text'], ['delete', 'chapter', 'aaaaaa']]);
  assert.equal(run('failedWrite'), null);
});

test('backend deletion failure keeps the open document', async () => {
  const { ctx, run, events } = setup('chapter', { deleteThrows: true });
  await run("deleteDoc('chapter', 'aaaaaa')");
  assert.equal(run('currentId'), 'aaaaaa');
  assert.equal(run('project.chapters.length'), 1);
  assert.equal(ctx.text, 'unsaved text');
  assert.equal(run('busy'), false);
  assert.deepEqual(events.at(-1), ['error', 'trash unavailable']);
});

test('cancelled deletion keeps the open document', async () => {
  const { run } = setup('chapter', { cancelDelete: true });
  await run("deleteDoc('chapter', 'aaaaaa')");
  assert.equal(run('currentId'), 'aaaaaa');
  assert.equal(run('project.chapters.length'), 1);
  assert.equal(run('busy'), false);
});
