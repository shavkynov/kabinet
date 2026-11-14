'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(failRead) {
  const errors = [], statuses = [], rendered = [];
  const context = {
    currentId: 'aaaaaa', currentKind: 'chapter', openToken: 0, dirty: false, noteId: null,
    project: { name: 'Проверка', chapters: [{ id: 'aaaaaa', title: 'Первая' }, { id: 'bbbbbb', title: 'Вторая' }] },
    console, setTimeout, clearTimeout, SAVE_DELAY_MS: 1000,
    flush: async () => true,
    api: {
      readChapter: async () => { if (failRead) throw new Error('Файл главы не найден'); return ''; },
      reloadProject: async () => context.project,
    },
    showError: (message) => errors.push(message),
    setStatus: (kind, text) => statuses.push({ kind, text }),
    setEditorContent: (text, editable, keepView) => rendered.push({ text, editable, keepView }),
    closeGoalPop() {}, refreshGoalUI() {}, loadChapMeta() {}, refreshTotals() {},
    document: { body: { classList: { toggle() {} } } },
    $: () => ({ hidden: false, textContent: '', scrollTop: 0 }),
  };
  vm.createContext(context);
  const source = ['05-pane2.js', '14-lists.js', '31-sync.js']
    .map((name) => fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app', name), 'utf8')).join('\n');
  vm.runInContext(source + '\nglobalThis.subject = { openDoc, openPane2, applyExternal, panel: p2 };', context);
  return { context, errors, statuses, rendered, subject: context.subject };
}

test('failed chapter reload retains document identity and contents', async () => {
  const f = fixture(true);
  assert.equal(await f.subject.openDoc('chapter', 'aaaaaa', true), false);
  assert.equal(f.context.currentId, 'aaaaaa');
  assert.equal(f.context.currentKind, 'chapter');
  assert.equal(f.errors.length, 1);
  assert.equal(f.rendered.length, 0);
});

test('existing empty chapter can be reloaded', async () => {
  const f = fixture(false);
  assert.equal(await f.subject.openDoc('chapter', 'aaaaaa', true), true);
  assert.deepEqual(f.rendered, [{ text: '', editable: true, keepView: true }]);
  assert.equal(f.context.currentId, 'aaaaaa');
});

test('external failed reload keeps the active document and does not report success', async () => {
  const f = fixture(true);
  await f.subject.applyExternal(['Главы/aaaaaa.md']);
  assert.equal(f.context.currentId, 'aaaaaa');
  assert.equal(f.context.currentKind, 'chapter');
  assert.equal(f.errors.length, 1);
  assert.equal(f.rendered.length, 0);
  assert.equal(f.statuses.length, 0);
});

test('external failed reload keeps the second panel identity', async () => {
  const f = fixture(true);
  f.subject.panel.id = 'bbbbbb';
  await f.subject.applyExternal(['Главы/bbbbbb.md']);
  assert.equal(f.subject.panel.id, 'bbbbbb');
  assert.equal(f.context.currentId, 'aaaaaa');
  assert.equal(f.errors.length, 1);
  assert.equal(f.statuses.length, 0);
});
