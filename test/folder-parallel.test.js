'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { walkRemote } = require('../src/folder');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const bytes = (text) => new Uint8Array(Buffer.from(text));

function deferredAdapter(count = 7) {
  const names = Array.from({ length: count }, (_, i) => `project${i}.json`);
  const pending = [];
  let active = 0;
  let peak = 0;
  const adapter = {
    async list() { return names.map((name) => ({ name, dir: false, size: 1, mtime: 1000 })); },
    async read(rel) {
      active += 1;
      peak = Math.max(peak, active);
      try {
        return await new Promise((resolve, reject) => pending.push({ rel, resolve, reject }));
      } finally { active -= 1; }
    },
  };
  return { names, pending, adapter, get active() { return active; }, get peak() { return peak; } };
}

test('remote walk reads at most three files and keeps traversal order', async () => {
  const x = deferredAdapter();
  const task = walkRemote(x.adapter);
  await tick();
  assert.equal(x.pending.length, 3);
  assert.equal(x.active, 3);
  for (const item of x.pending.slice(0, 3).reverse()) item.resolve(bytes(item.rel));
  await tick();
  assert.equal(x.pending.length, 6);
  assert.equal(x.active, 3);
  for (const item of x.pending.slice(3, 6).reverse()) item.resolve(bytes(item.rel));
  await tick();
  assert.equal(x.pending.length, 7);
  x.pending[6].resolve(bytes(x.pending[6].rel));
  const result = await task;
  assert.equal(x.peak, 3);
  assert.equal(x.active, 0);
  assert.deepEqual([...result.keys()], x.names);
  for (const [rel, entry] of result) {
    assert.equal(Buffer.from(entry.bytes).toString(), rel);
    assert.match(entry.hash, /^[a-f0-9]{40}$/);
  }
});

test('read failure stops scheduling and waits for already started reads', async () => {
  const x = deferredAdapter();
  const failure = new Error('fixture offline');
  const task = walkRemote(x.adapter);
  let settled = false;
  task.then(() => { settled = true; }, () => { settled = true; });
  await tick();
  x.pending[0].reject(failure);
  await tick();
  assert.equal(settled, false);
  assert.equal(x.pending.length, 3);
  x.pending[1].resolve(bytes('one'));
  x.pending[2].resolve(bytes('two'));
  await assert.rejects(task, (error) => error === failure);
  assert.equal(x.active, 0);
  assert.equal(x.pending.length, 3);
});

test('parallel walk uses matching cached signatures and reads only a changed file', async () => {
  const names = ['project0.json', 'project1.json'];
  const hash = 'a'.repeat(40);
  const cache = new Map(names.map((rel) => [rel, { sig: '1:1000', hash }]));
  const reads = [];
  const result = await walkRemote({
    async list() { return names.map((name, i) => ({ name, dir: false, size: 1, mtime: i ? 2000 : 1000 })); },
    async read(rel) { reads.push(rel); return bytes('x'); },
  }, cache);
  assert.deepEqual(reads, ['project1.json']);
  assert.equal(result.get('project0.json').bytes, null);
  assert.equal(result.get('project0.json').hash, hash);
  assert.equal(Buffer.from(result.get('project1.json').bytes).toString(), 'x');
});

test('listing failure starts no file reads from an incomplete snapshot', async () => {
  let reads = 0;
  const failure = new Error('fixture listing unavailable');
  await assert.rejects(walkRemote({
    async list(rel) {
      if (rel) throw failure;
      return [{ name: 'project.json', dir: false }, { name: 'Главы', dir: true }];
    },
    async read() { reads += 1; return bytes('x'); },
  }), (error) => error === failure);
  assert.equal(reads, 0);
});

test('empty folders and disappeared files preserve snapshot semantics', async () => {
  const empty = await walkRemote({ async list() { return []; }, async read() { throw new Error('Unexpected read'); } });
  assert.equal(empty.size, 0);
  const result = await walkRemote({
    async list() { return [{ name: 'project.json', dir: false }, { name: 'project1.json', dir: false }]; },
    async read(rel) { return rel === 'project.json' ? bytes('{}') : null; },
  });
  assert.deepEqual([...result.keys()], ['project.json']);
});
