'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createCloseCoordinator } = require('../experiments/tauri-app/close-coordinator');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function fixture(overrides = {}) {
  const events = [];
  const guard = createCloseCoordinator({
    prepare: async () => true,
    exit: async () => { events.push('exit'); },
    cancel: async () => { events.push('cancel'); },
    report: () => { events.push('report'); },
    lock: () => { events.push('lock'); return 'previous'; },
    unlock: (previous) => { assert.equal(previous, 'previous'); events.push('unlock'); },
    ...overrides,
  });
  return { guard, events };
}
test('close waits for an already running write', async () => {
  const gate = deferred();
  const f = fixture();
  const write = f.guard.write('chapter', () => gate.promise);
  const closing = f.guard.close();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.events.includes('exit'), false);
  gate.resolve(); await write;
  assert.equal(await closing, true);
  assert.deepEqual(f.events, ['lock', 'exit']);
});
test('failed writes cancel close and restore the interface', async () => {
  const f = fixture();
  await assert.rejects(f.guard.write('chapter', async () => { throw new Error('disk full'); }));
  assert.equal(await f.guard.close(), false);
  assert.deepEqual(f.events, ['lock', 'cancel', 'report', 'unlock']);
  assert.equal(f.guard.isClosing(), false);
});
test('successful retry clears the failure for that document', async () => {
  let guard;
  const f = fixture({ prepare: async () => { await guard.write('chapter', async () => true); return true; } });
  guard = f.guard;
  await assert.rejects(guard.write('chapter', async () => { throw new Error('offline'); }));
  assert.equal(await guard.close(), true);
});
test('duplicate close requests do not duplicate the flush', async () => {
  const gate = deferred(); let calls = 0;
  const f = fixture({ prepare: async () => { calls += 1; return gate.promise; } });
  const first = f.guard.close();
  assert.equal(await f.guard.close(), false);
  gate.resolve(true);
  assert.equal(await first, true);
  assert.equal(calls, 1);
  assert.equal(f.events.filter((x) => x === 'exit').length, 1);
});
test('writes queued during preparation are also awaited', async () => {
  const gate = deferred(); let queued;
  const f = fixture({ prepare: async () => { queued = f.guard.write('comments', () => gate.promise); return true; } });
  const closing = f.guard.close();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.events.includes('exit'), false);
  gate.resolve(); await queued;
  assert.equal(await closing, true);
});
test('preparation failure and exit failure never approve closing', async () => {
  for (const options of [
    { prepare: async () => false },
    { prepare: async () => { throw new Error('renderer not ready'); } },
    { exit: async () => { throw new Error('native close failed'); } },
  ]) {
    const f = fixture(options);
    assert.equal(await f.guard.close(), false);
    assert.equal(f.guard.isClosing(), false);
    assert.equal(f.events.at(-1), 'unlock');
  }
});
test('a failed write does not stop later queued writes', async () => {
  const f = fixture(); const order = [];
  const first = f.guard.write('old', async () => { order.push(1); throw new Error('failed'); });
  const second = f.guard.write('new', async () => { order.push(2); return true; });
  await assert.rejects(first); assert.equal(await second, true);
  assert.deepEqual(order, [1, 2]);
  f.guard.forget((key) => key === 'old');
  assert.equal(await f.guard.close(), true);
});
const saveSource = fs.readFileSync(path.join(__dirname, '../renderer/app/13-save.js'), 'utf8');
for (const failed of ['flushDoc', 'flushNote', 'flushComments', 'flushChapMeta', 'flushPane2']) {
  test('shutdown refuses a failure in ' + failed, async () => {
    const context = {
      api: {}, window: { __TAURI__: {}, addEventListener() {} },
      dirty: false, noteDirty: false, cmtDirty: false, cmDirty: false,
      p2: { dirty: false, token: 0 }, openToken: 0, noteToken: 0, cmToken: 0,
      refreshCommentAnchors() {}, console,
    };
    for (const name of ['flushNote', 'flushComments', 'flushChapMeta', 'flushPane2']) context[name] = async () => name !== failed;
    vm.createContext(context);
    vm.runInContext(saveSource, context);
    context.flushDoc = async () => failed !== 'flushDoc';
    assert.equal(await context.api.prepareClose(), false);
  });
}
test('Tauri beforeunload does not clear unsaved flags or issue fire-and-forget writes', () => {
  const handlers = {}; let writes = 0;
  const context = {
    api: { writeDocSync: () => { writes += 1; } },
    window: { __TAURI__: {}, addEventListener: (event, fn) => { handlers[event] = fn; } },
    dirty: true, dirtyId: 'aaaaaa', dirtyKind: 'chapter',
    p2: { id: 'bbbbbb', dirty: true }, cmtDirty: true, cmDirty: true, noteDirty: true,
  };
  vm.createContext(context); vm.runInContext(saveSource, context);
  handlers.beforeunload();
  assert.equal(writes, 0); assert.equal(context.dirty, true); assert.equal(context.p2.dirty, true);
});
test('native shutdown has a quit guard and no forced five-second close', () => {
  const main = fs.readFileSync(path.join(__dirname, '../experiments/tauri-app/src-tauri/src/main.rs'), 'utf8');
  assert.match(main, /RunEvent::ExitRequested/);
  assert.match(main, /api\.prevent_exit\(\)/);
  assert.match(main, /"app:close-cancel"/);
  assert.doesNotMatch(main, /Если окно не ответило за 5 секунд/);
  assert.doesNotMatch(main, /let w = window\.clone\(\);\s*std::thread::spawn/);
});
