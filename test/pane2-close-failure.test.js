'use strict';
// Второй лист: если запись не удалась, закрытие листа и смена его главы не должны терять несохранённый текст.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer/app/05-pane2.js'), 'utf8');

function setup() {
  const writes = [];
  const timers = [];
  const cleared = [];
  const setContentCalls = [];
  const el = () => new Proxy(function () {}, {
    get: (_, k) => (k === 'classList' ? { toggle() {}, add() {}, remove() {} } : k === 'scrollTop' ? 0 : el()),
    set: () => true,
    apply: () => el(),
  });
  const ctx = {
    failing: false, writes, timers, cleared, setContentCalls,
    chapters: { c2: 'Второй лист', c3: 'Третья глава' },
    api: {
      writeChapter: async (id, text) => { if (ctx.failing) throw new Error('disk'); writes.push([id, text]); return {}; },
      readChapter: async (id) => ctx.chapters[id],
    },
    $: () => el(),
    t: (s) => s,
    document: el(), // 05-pane2.js сам объявляет refreshSheetBar (меню выбора листов), он ходит в document
    console: { error() {} },
    setTimeout: (fn, ms) => { timers.push([fn, ms]); return timers.length; },
    clearTimeout: (id) => { cleared.push(id); },
    setStatus() {}, showError() {}, noteSaved() {}, noteSaveFailed() {}, noteSyncConflict() {},
    refreshTotals() {}, refreshBar() {}, updateTwPad() {}, layoutGoal() {}, refreshSheetBar() {},
    itemsOf: () => [], Option: function Option() {},
    project: {}, currentId: 'c1', currentKind: 'chapter',
    SAVE_DELAY_MS: 1500,
  };
  vm.createContext(ctx);
  vm.runInContext(`${src}\n
    editor2 = {
      text: 'Текст во втором листе',
      storage: { markdown: { getMarkdown: () => editor2.text } },
      commands: { setContent: (t) => setContentCalls.push(t), setTextSelection() {} },
      setEditable() {},
      state: { selection: { from: 0, to: 0 } },
      chain() { const c = { command: () => c, setContent: (t) => { setContentCalls.push(t); return c; }, run() {} }; return c; },
    };
    p2.id = 'c2'; p2.dirty = true;`, ctx);
  return { ctx, run: (code) => vm.runInContext(code, ctx) };
}

test('закрытие при сбое записи: лист остаётся, текст не стирается, повтор записи не отменён', async () => {
  const { ctx, run } = setup();
  ctx.failing = true;
  assert.equal(await run('closePane2()'), false);
  assert.equal(run('p2.id'), 'c2');
  assert.equal(run('p2.dirty'), true);
  assert.deepEqual(ctx.setContentCalls, []); // редактор не очищен
  assert.ok(ctx.timers.some(([, ms]) => ms === 3000)); // повтор запланирован
  assert.ok(!ctx.cleared.includes(ctx.timers.length)); // таймер повтора (последний поставленный) не сброшен
});

test('после устранения сбоя закрытие записывает тот же текст в ту же главу и закрывает лист', async () => {
  const { ctx, run } = setup();
  ctx.failing = true;
  assert.equal(await run('closePane2()'), false);
  ctx.failing = false;
  assert.equal(await run('closePane2()'), true);
  assert.deepEqual(ctx.writes, [['c2', 'Текст во втором листе']]);
  assert.equal(run('p2.id'), null);
  assert.equal(run('p2.dirty'), false);
});

test('успешное закрытие: запись, затем закрытие', async () => {
  const { ctx, run } = setup();
  assert.equal(await run('closePane2()'), true);
  assert.deepEqual(ctx.writes, [['c2', 'Текст во втором листе']]);
  assert.equal(run('p2.id'), null);
});

test('смена главы второго листа при сбое записи: прежняя глава и текст остаются, новая не читается', async () => {
  const { ctx, run } = setup();
  ctx.failing = true;
  let read = false;
  const readChapter = ctx.api.readChapter;
  ctx.api.readChapter = async (id) => { read = true; return readChapter(id); };
  assert.equal(await run("openPane2('c3')"), false);
  assert.equal(run('p2.id'), 'c2');
  assert.equal(run('p2.dirty'), true);
  assert.equal(read, false);
  assert.deepEqual(ctx.setContentCalls, []);
});

test('смена главы второго листа без сбоя: прежняя глава записана, новая открыта', async () => {
  const { ctx, run } = setup();
  assert.equal(await run("openPane2('c3')"), true);
  assert.deepEqual(ctx.writes, [['c2', 'Текст во втором листе']]);
  assert.equal(run('p2.id'), 'c3');
});
