'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const filename = path.join(__dirname, '../src/davlink.js');
const source = fs.readFileSync(filename, 'utf8');
const requireFromSource = createRequire(filename);

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kab-dav-persistence-'));
  const state = { writeError: new Error('fixture: disk full'), exists: false, exports: 0, imports: 0, timers: 0 };
  const adapter = { ensureRoot: async () => {}, read: async () => null, write: async () => {}, remove: async () => {} };
  const probe = {
    hasProject: async () => state.exists,
    exportAll: async () => { state.exports += 1; },
    importAll: async () => { state.imports += 1; },
    replaceAll: async () => {},
    sync: async () => ({ pulled: [], conflicts: [] }),
  };
  const dependencies = {
    fs: { ...fs, watch: () => ({ on() {}, close() {} }) },
    './webdav': { createWebDav: () => adapter },
    './folder': { isSyncable: () => true, createFolderSync: () => probe },
    './fsutil': { writeFileAtomic: (file, text) => {
      if (state.writeError) throw state.writeError;
      fs.writeFileSync(file, text);
    } },
  };
  const mod = { exports: {} };
  vm.runInNewContext(source, {
    module: mod, exports: mod.exports,
    require: (id) => Object.hasOwn(dependencies, id) ? dependencies[id] : requireFromSource(id),
    console, TextEncoder, TextDecoder,
    setInterval: () => { state.timers += 1; return { unref() {} }; },
    clearInterval: () => {},
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
  }, { filename });
  const link = mod.exports.createDavLink({ dataDir: dir, request: async () => { throw new Error('Unexpected network request'); } });
  t.after(() => { link.stopWork(); fs.rmSync(dir, { recursive: true, force: true }); });
  const acc = { url: 'https://example.org', user: 'alice', pass: 'fixture', root: '/project', label: 'Cloud' };
  const file = path.join(dir, 'dav-links.json');
  return { dir, file, link, acc, state };
}

test('failed connection persistence rejects attach before background work starts', async (t) => {
  const x = setup(t);
  await assert.rejects(x.link.attach(x.dir, x.acc), (error) => error === x.state.writeError);
  assert.equal(x.state.exports, 1);
  assert.equal(x.state.timers, 0);
  assert.equal(fs.existsSync(x.file), false);
  assert.equal(x.link.status(x.dir).linked, false);
});

test('connection can be retried after persistence recovers', async (t) => {
  const x = setup(t);
  await assert.rejects(x.link.attach(x.dir, x.acc));
  x.state.writeError = null;
  const result = await x.link.attach(x.dir, x.acc);
  assert.equal(result.status.linked, true);
  assert.equal(x.state.timers, 2);
  assert.equal(JSON.parse(fs.readFileSync(x.file, 'utf8'))[x.dir].root, x.acc.root);
});

test('failed detach persistence rejects and leaves saved connection intact', async (t) => {
  const x = setup(t);
  const records = { [x.dir]: x.acc };
  fs.writeFileSync(x.file, JSON.stringify(records));
  await assert.rejects(x.link.detach(x.dir), (error) => error === x.state.writeError);
  assert.deepEqual(JSON.parse(fs.readFileSync(x.file, 'utf8')), records);
  assert.equal(x.link.status(x.dir).linked, true);
});

test('remote import does not report success when connection persistence fails', async (t) => {
  const x = setup(t);
  x.state.exists = true;
  await assert.rejects(x.link.openRemote(x.acc, path.join(x.dir, 'project')), (error) => error === x.state.writeError);
  assert.equal(x.state.imports, 1);
  assert.equal(x.state.timers, 0);
  assert.equal(fs.existsSync(x.file), false);
});
