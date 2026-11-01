'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const diag = require('../src/sync-diag');
const folder = require('../src/folder');

test('diagnostic adapter preserves values, this and failures while measuring calls', async () => {
  diag.reset();
  let now = 0;
  const clock = () => now;
  const run = diag.startRun('probe', clock);
  const failure = new Error('fixture failure');
  const adapter = {
    tag: 'fixture',
    async list() { now += 30; return [{ name: 'a', dir: false }, { name: 'b', dir: true }]; },
    async read(rel) { now += 20; if (rel === 'bad') throw failure; return this.tag; },
    helper() { return this.tag; },
  };
  const wrapped = diag.wrapAdapter(adapter, () => run, clock);
  assert.equal(await wrapped.read('ok'), 'fixture');
  await wrapped.list('');
  await assert.rejects(wrapped.read('bad'), (error) => error === failure);
  assert.deepEqual(run.calls, { read: { n: 2, ms: 40 }, list: { n: 1, ms: 30 } });
  assert.equal(run.files, 1);
  assert.equal(run.dirs, 1);
  assert.equal(wrapped.helper(), 'fixture');
  assert.equal(wrapped.tag, 'fixture');
});

test('diagnostics do not interfere with calls outside a tracked operation', async () => {
  const adapter = diag.wrapAdapter({ async read() { return null; } }, () => null);
  assert.equal(await adapter.read('missing'), null);
});

test('tracked stages retain order, results, errors and recover after failure', async () => {
  diag.reset();
  const failure = new Error('fixture offline');
  const mock = { createFolderSync(_dir, adapter) {
    return {
      state: { ready: true },
      async sync() { await adapter.list(''); return { pulled: ['one'] }; },
      async push(rels) { await adapter.write(rels[0]); return { pushed: rels }; },
      hasProject: async () => true,
    };
  } };
  const original = mock.createFolderSync;
  const restore = diag.instrumentFolder(mock);
  try {
    let fail = true;
    const sync = mock.createFolderSync('', {
      async list() { if (fail) throw failure; return []; },
      async write() {},
    });
    const first = sync.sync();
    const second = sync.push(['two']);
    await assert.rejects(first, (error) => error === failure);
    assert.deepEqual(await second, { pushed: ['two'] });
    fail = false;
    assert.deepEqual(await sync.sync(), { pulled: ['one'] });
    assert.equal(await sync.hasProject(), true);
    assert.deepEqual(sync.state, { ready: true });
    const runs = diag.recent();
    assert.deepEqual(runs.map((run) => run.name), ['sync', 'push', 'sync']);
    assert.ok(runs.every((run) => run.done));
    assert.equal(runs[0].error, failure.message);
    assert.equal(runs[0].calls.list.n, 1);
    assert.equal(runs[1].calls.write.n, 1);
    assert.equal(runs[1].calls.list, undefined);
    assert.match(diag.report(), /ERROR: fixture offline/);
  } finally { restore(); }
  assert.equal(mock.createFolderSync, original);
});

test('real folder export and sync preserve content and emit a desktop report', async (t) => {
  diag.reset();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kab-sync-diag-'));
  const local = path.join(tmp, 'project');
  fs.mkdirSync(path.join(local, 'Главы'), { recursive: true });
  fs.writeFileSync(path.join(local, 'project.json'), '{}');
  fs.writeFileSync(path.join(local, 'Главы', 'abcdef.md'), 'fixture text');
  const nodes = new Map();
  const adapter = {
    async list(rel) {
      const prefix = rel ? `${rel}/` : '';
      const entries = new Map();
      for (const key of nodes.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (!rest) continue;
        const name = rest.split('/')[0];
        entries.set(name, { name, dir: rest.includes('/') });
      }
      return [...entries.values()];
    },
    async read(rel) { return nodes.has(rel) ? new Uint8Array(nodes.get(rel)) : null; },
    async write(rel, bytes) { nodes.set(rel, new Uint8Array(bytes)); },
    async remove(rel) { nodes.delete(rel); },
    async mkdir() {},
  };
  const report = path.join(tmp, 'sync-metrics.txt');
  const original = folder.createFolderSync;
  const off = diag.install({ folder, file: () => report });
  t.after(() => { off(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const sync = folder.createFolderSync(local, adapter, { stateFile: path.join(tmp, 'state.json') });
  await sync.exportAll();
  const result = await sync.sync();
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.pulled.length, 0);
  assert.equal(Buffer.from(nodes.get('Главы/abcdef.md')).toString(), 'fixture text');
  assert.equal(fs.readFileSync(path.join(local, 'Главы', 'abcdef.md'), 'utf8'), 'fixture text');
  assert.deepEqual(diag.recent().map((run) => run.name), ['exportAll', 'sync']);
  assert.match(fs.readFileSync(report, 'utf8'), /exportAll/);
  assert.match(fs.readFileSync(report, 'utf8'), /sync .* ok/);
  off();
  assert.equal(folder.createFolderSync, original);
});

test('report history is bounded and resettable', () => {
  diag.reset();
  for (let i = 0; i < 20; i += 1) diag.startRun(`stage-${i}`);
  assert.equal(diag.recent().length, 12);
  assert.equal(diag.recent()[0].name, 'stage-8');
  assert.match(diag.report(1), /stage-19/);
  assert.doesNotMatch(diag.report(1), /stage-18/);
  diag.reset();
  assert.equal(diag.report(), '');
});
