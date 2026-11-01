'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const diag = require('../src/sync-diag');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const bytes = (text) => new Uint8Array(Buffer.from(text));

test('import progress excludes service files and counts only completed reads', async () => {
  diag.reset();
  const run = diag.startRun('importAll');
  const pending = [];
  const adapter = diag.wrapAdapter({
    async list(rel) {
      return rel ? [{ name: 'aaaaaa.md', dir: false }, { name: 'ignored.tmp', dir: false }]
        : [{ name: 'project.json', dir: false }, { name: 'kabinet.lock', dir: false }, { name: 'Главы', dir: true }];
    },
    async read(rel) { return new Promise((resolve) => pending.push({ rel, resolve })); },
  }, () => run);
  assert.deepEqual(diag.importProgress(), { phase: 'listing', total: 0, completed: 0 });
  await adapter.list('');
  await adapter.list('Главы');
  assert.equal(diag.importProgress().total, 2);
  const first = adapter.read('project.json');
  const second = adapter.read('Главы/aaaaaa.md');
  assert.deepEqual(diag.importProgress(), { phase: 'download', total: 2, completed: 0 });
  pending[1].resolve(bytes('chapter'));
  await second;
  assert.equal(diag.importProgress().completed, 1);
  pending[0].resolve(bytes('{}'));
  await first;
  assert.equal(diag.importProgress().completed, 2);
  run.done = true;
  assert.equal(diag.importProgress(), null);
  diag.reset();
});

test('failed import propagates the error and does not leave active progress', async () => {
  diag.reset();
  const failure = new Error('fixture offline');
  const mock = { createFolderSync(_dir, adapter) { return { importAll: () => adapter.read('project.json') }; } };
  const restore = diag.instrumentFolder(mock);
  try {
    const sync = mock.createFolderSync('', { async read() { throw failure; } });
    await assert.rejects(sync.importAll(), (error) => error === failure);
    assert.equal(diag.importProgress(), null);
    assert.equal(diag.recent()[0].completed, 0);
    assert.equal(diag.recent()[0].error, failure.message);
  } finally { restore(); diag.reset(); }
});

test('ordinary background sync does not display import progress', () => {
  diag.reset();
  diag.startRun('sync');
  assert.equal(diag.importProgress(), null);
  diag.reset();
});

test('import banner appears automatically, advances and cleans up without taking focus', async () => {
  diag.reset();
  class Element {
    constructor() { this.style = {}; this.children = []; this.attrs = new Map(); this.hidden = false; }
    append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
    setAttribute(name, value) { this.attrs.set(name, value); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((node) => node !== this); }
  }
  const focus = {};
  const doc = { body: new Element(), activeElement: focus, createElement: () => new Element(), removeEventListener() {} };
  let paint;
  let cleared = false;
  const off = diag.mountImportProgress(doc, { setTimer: (fn) => { paint = fn; return 1; }, clearTimer: () => { cleared = true; } });
  try {
    const banner = doc.body.children[0];
    assert.equal(banner.hidden, true);
    assert.equal(banner.attrs.get('role'), 'status');
    const run = diag.startRun('importAll');
    assert.equal(banner.hidden, false);
    assert.equal(banner.children[2].hidden, true);
    run.phase = 'download'; run.importTotal = 94; run.completed = 27;
    paint();
    assert.match(banner.children[1].textContent, /27 \/ 94/);
    assert.equal(banner.children[2].max, 94);
    assert.equal(banner.children[2].value, 27);
    assert.equal(banner.children[2].hidden, false);
    assert.equal(doc.activeElement, focus);
    run.done = true;
    paint();
    assert.equal(banner.hidden, true);
    await tick();
  } finally { off(); diag.reset(); }
  assert.equal(cleared, true);
  assert.equal(doc.body.children.length, 0);
});
