'use strict';
// Сбой записи не должен терять текст и не должен писать текст одной главы в файл другой.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer/app/13-save.js'), 'utf8')
  .replace(/window\.addEventListener\('blur'[^\n]*\n/, '');

function setup() {
  const writes = [];
  const ctx = {
    failing: false, editor: 'A text', writes,
    api: {
      writeChapter: async (id, text) => { if (ctx.failing) throw new Error('disk'); writes.push([id, text]); return {}; },
      writeItem: async () => ({}),
    },
    window: { addEventListener() {} },
    $: () => ({ textContent: '', className: '' }),
    console: { error() {} },
    setTimeout: () => 0, clearTimeout() {},
    isTextKind: () => true, getMarkdown: () => ctx.editor, cardView: { toJSON: () => '{}' },
    noteSyncConflict() {}, refreshIndex() {}, refreshCommentAnchors() {},
    // Успешное сохранение, в том числе без изменений, подтверждается явным true.
    flushNote: async () => true, flushComments: async () => true, flushChapMeta: async () => true, flushPane2: async () => true,
    SAVE_DELAY_MS: 1500,
  };
  vm.createContext(ctx);
  vm.runInContext(`let dirty = false, dirtyId = null, dirtyKind = null, currentId = null, currentKind = null, saveTimer = null, statusTimer = null, noteDirty = false, noteId = null, cmtDirty = false, cmtChapter = null, cmDirty = false, cmId = null;
    const p2 = { dirty: false, id: null };\n${src}`, ctx);
  return { ctx, run: (code) => vm.runInContext(code, ctx) };
}

test('успешная запись: flush возвращает true и пишет текст', async () => {
  const { ctx, run } = setup();
  run("currentId = 'c1'; currentKind = 'chapter'; markDirty();");
  assert.equal(await run('flush()'), true);
  assert.deepEqual(ctx.writes, [['c1', 'A text']]);
});

test('сбой записи: flush возвращает false, повтор идёт с тем же текстом и в ту же главу, а не с экрана другой главы', async () => {
  const { ctx, run } = setup();
  run("currentId = 'c1'; currentKind = 'chapter'; markDirty();");
  ctx.failing = true;
  assert.equal(await run('flush()'), false);
  // на экране оказалась другая глава (в обход проверки), набран другой текст
  ctx.editor = 'B text';
  run("currentId = 'c2'; currentKind = 'chapter'; markDirty();");
  ctx.failing = false;
  assert.equal(await run('flush()'), true);
  assert.deepEqual(ctx.writes, [['c1', 'A text'], ['c2', 'B text']]);
});

test('сбой записи, затем правки в той же главе: пишется свежий текст один раз', async () => {
  const { ctx, run } = setup();
  run("currentId = 'c1'; currentKind = 'chapter'; markDirty();");
  ctx.failing = true;
  assert.equal(await run('flush()'), false);
  ctx.editor = 'A text, ещё';
  run('markDirty()');
  ctx.failing = false;
  assert.equal(await run('flush()'), true);
  assert.deepEqual(ctx.writes, [['c1', 'A text, ещё']]);
});

test('пока запись не удалась, переход к другому документу запрещён (flush даёт false)', async () => {
  const { ctx, run } = setup();
  run("currentId = 'c1'; currentKind = 'chapter'; markDirty();");
  ctx.failing = true;
  assert.equal(await run('flush()'), false);
  assert.equal(await run('flush()'), false); // повтор тоже неудачен
  assert.equal(ctx.writes.length, 0);
});
