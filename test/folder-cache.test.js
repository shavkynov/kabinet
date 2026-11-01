'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFolderSync } = require('../src/folder');

function setup(t, metadata = true) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kab-folder-cache-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const dir = path.join(tmp, 'project');
  const stateFile = path.join(tmp, 'state.json');
  const nodes = new Map();
  let time = 1000;
  const reads = [];
  const put = (rel, text) => nodes.set(rel, { bytes: new Uint8Array(Buffer.from(text)), mtime: ++time });
  put('project.json', '{"chapters":[]}');
  put('Главы/aaaaaa.md', 'alpha');
  put('Заметки/bbbbbb.md', 'notes');
  const adapter = {
    async list(rel) {
      const prefix = rel ? `${rel}/` : '';
      const out = new Map();
      for (const [key, entry] of nodes) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (!rest) continue;
        const name = rest.split('/')[0];
        const item = { name, dir: rest.includes('/') };
        if (!item.dir && metadata) { item.size = entry.bytes.length; item.mtime = entry.mtime; }
        out.set(name, item);
      }
      return [...out.values()];
    },
    async read(rel) { reads.push(rel); return nodes.has(rel) ? new Uint8Array(nodes.get(rel).bytes) : null; },
    async write(rel, bytes) { nodes.set(rel, { bytes: new Uint8Array(bytes), mtime: ++time }); },
    async mkdir() {},
    async remove(rel) { nodes.delete(rel); },
  };
  const make = () => createFolderSync(dir, adapter, { stateFile });
  return { dir, stateFile, nodes, reads, put, make };
}

test('import primes signatures and reopening does not read unchanged files again', async (t) => {
  const x = setup(t);
  const imported = await x.make().importAll();
  assert.equal(imported.length, 3);
  assert.equal(x.reads.length, 3);
  x.reads.length = 0;
  const result = await x.make().sync();
  assert.deepEqual(x.reads, []);
  assert.deepEqual(result, { pulled: [], pushed: [], removed: [], conflicts: [] });
  await x.make().sync();
  assert.deepEqual(x.reads, []);
  const state = JSON.parse(fs.readFileSync(x.stateFile, 'utf8'));
  assert.ok(Object.values(state).every((hash) => typeof hash === 'string'));
});

test('external edit with the same size but a new modification time is downloaded', async (t) => {
  const x = setup(t);
  await x.make().importAll();
  x.put('Главы/aaaaaa.md', 'bravo');
  x.reads.length = 0;
  const result = await x.make().sync();
  assert.deepEqual(x.reads, ['Главы/aaaaaa.md']);
  assert.deepEqual(result.pulled, ['Главы/aaaaaa.md']);
  assert.equal(fs.readFileSync(path.join(x.dir, 'Главы/aaaaaa.md'), 'utf8'), 'bravo');
});

test('pushing one chapter invalidates only that chapter, including after reopening', async (t) => {
  const x = setup(t);
  await x.make().importAll();
  fs.writeFileSync(path.join(x.dir, 'Главы/aaaaaa.md'), 'local edit');
  const pushed = await x.make().push(['Главы/aaaaaa.md']);
  assert.deepEqual(pushed.pushed, ['Главы/aaaaaa.md']);
  x.reads.length = 0;
  await x.make().sync();
  assert.deepEqual(x.reads, ['Главы/aaaaaa.md']);
  assert.equal(Buffer.from(x.nodes.get('Главы/aaaaaa.md').bytes).toString(), 'local edit');
});

test('persisted cache does not suppress a real two-sided conflict', async (t) => {
  const x = setup(t);
  await x.make().importAll();
  fs.writeFileSync(path.join(x.dir, 'Главы/aaaaaa.md'), 'local version');
  x.put('Главы/aaaaaa.md', 'remote version');
  const result = await x.make().sync();
  assert.deepEqual(result.conflicts, ['Главы/aaaaaa.md']);
  assert.equal(fs.readFileSync(path.join(x.dir, 'Главы/aaaaaa.md'), 'utf8'), 'local version');
  const copies = [...x.nodes].filter(([rel]) => rel.startsWith('Конфликты/'));
  assert.ok(copies.some(([, entry]) => Buffer.from(entry.bytes).toString() === 'remote version'));
});

test('old snapshots and damaged cache safely fall back to a complete read', async (t) => {
  const x = setup(t);
  await x.make().importAll();
  fs.rmSync(`${x.stateFile}.cache`, { force: true });
  x.reads.length = 0;
  await x.make().sync();
  assert.equal(x.reads.length, 3);
  x.reads.length = 0;
  await x.make().sync();
  assert.deepEqual(x.reads, []);
  fs.writeFileSync(`${x.stateFile}.cache`, '{broken');
  x.reads.length = 0;
  await x.make().sync();
  assert.equal(x.reads.length, 3);
});

test('adapters without modification metadata continue reading content', async (t) => {
  const x = setup(t, false);
  await x.make().importAll();
  x.reads.length = 0;
  await x.make().sync();
  assert.equal(x.reads.length, 3);
});
