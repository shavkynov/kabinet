'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../renderer/app/36-dav.js'), 'utf8');
function setup(result = { linked: true, lastSync: 1 }) {
  const calls = [], messages = [];
  const ctx = vm.createContext({
    project: {}, dirty: false, noteDirty: false, cmtDirty: false, cmDirty: false, p2: { dirty: false },
    t: (s, v) => s.replace('{0}', v), tdom: (s) => s,
    setStatus: (kind, text) => messages.push({ kind, text }),
    showError: (text) => messages.push({ kind: 'error', text }),
    flush: async () => {},
    api: { dav: async (op) => { calls.push(op); return op === 'status' ? { linked: true } : result; } },
  });
  vm.runInContext(source, ctx);
  vm.runInContext('openSyncDialog = async () => { globalThis.opened = true; };', ctx);
  return { ctx, calls, messages, run: () => ctx.davQuickSync() };
}
test('F5 reports actual success', async () => {
  const h = setup(); await h.run();
  assert.equal(h.messages.at(-1).text, 'Синхронизировано');
});
for (const [label, result, expected] of [
  ['network error', { linked: true, error: 'offline', lastSync: 1 }, 'Синхронизация: offline'],
  ['busy', { linked: true, busy: true, lastSync: 1 }, 'Идёт обмен…'],
  ['conflict', { linked: true, conflict: true, lastSync: 1 }, 'Был конфликт: чужая версия текста лежит в папке «Конфликты» проекта.'],
  ['no completed sync', { linked: true, lastSync: 0 }, 'Ещё не обновлялось.'],
]) test(`F5: ${label} is not success`, async () => {
  const h = setup(result); await h.run();
  assert.equal(h.messages.at(-1).text, expected);
});
for (const flag of ['dirty', 'noteDirty', 'cmtDirty', 'cmDirty', 'pane2']) test(`F5 stops when ${flag} remains unsaved`, async () => {
  const h = setup();
  if (flag === 'pane2') h.ctx.p2.dirty = true; else h.ctx[flag] = true;
  await h.run(); assert.deepEqual(h.calls, ['status']);
  assert.equal(h.messages.at(-1).kind, 'error');
});
test('F5 ignores repeated press while awaiting status and unlocks after rejection', async () => {
  const h = setup(); let reject;
  h.ctx.api.dav = (op) => { h.calls.push(op); return new Promise((_r, no) => { reject = no; }); };
  const first = h.run(); await h.run();
  assert.equal(h.calls.length, 1); reject(new Error('offline')); await first;
  assert.equal(h.messages.at(-1).text, 'offline');
  h.ctx.api.dav = async () => ({ linked: false }); await h.run();
  assert.equal(h.ctx.opened, true);
});
test('F5 does not show a stale result after changing projects', async () => {
  const h = setup(); h.ctx.flush = async () => { h.ctx.project = {}; };
  await h.run(); assert.deepEqual(h.calls, ['status']); assert.equal(h.messages.length, 0);
});
test('F5 does not claim new edits made during sync are synced', async () => {
  const h = setup();
  h.ctx.api.dav = async (op) => {
    if (op === 'syncNow') h.ctx.dirty = true;
    return { linked: true, lastSync: 1 };
  };
  await h.run(); assert.equal(h.messages.length, 0);
});
