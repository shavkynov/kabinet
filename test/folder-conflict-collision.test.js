'use strict';
// Две разные версии с одним названием и в одну секунду не должны затирать друг друга в «Конфликтах».
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const folder = require('../src/folder');

const bytes = (t) => new Uint8Array(Buffer.from(t, 'utf8'));
const utf8 = (b) => Buffer.from(b).toString('utf8');
const NOW = new Date(2026, 10, 14, 6, 0, 0);

function fakeFolder() {
  const nodes = new Map();
  const rel = (p) => String(p).split('/').filter(Boolean).join('/');
  return {
    nodes,
    async list(p) {
      const base = rel(p); const out = new Map();
      for (const key of nodes.keys()) {
        if (base && !key.startsWith(`${base}/`)) continue;
        const rest = base ? key.slice(base.length + 1) : key;
        const name = rest.split('/')[0];
        if (name) out.set(name, rest.includes('/'));
      }
      return [...out].map(([name, dir]) => ({ name, dir }));
    },
    async read(p) { const v = nodes.get(rel(p)); return v ? new Uint8Array(v) : null; },
    async write(p, d) { nodes.set(rel(p), new Uint8Array(d)); },
    async remove(p) { nodes.delete(rel(p)); },
    async mkdir(p) { if (rel(p)) nodes.set(`${rel(p)}/.keep`, new Uint8Array(0)); },
  };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kabinet-collision-'));
const remoteCopies = (ext) => [...ext.nodes].filter(([k]) => k.startsWith('Конфликты/') && !k.endsWith('.keep')).map(([k, v]) => [k, utf8(v)]);
const localCopies = (dir) => {
  const d = path.join(dir, 'Конфликты');
  return fs.existsSync(d) ? fs.readdirSync(d).map((f) => fs.readFileSync(path.join(d, f), 'utf8')) : [];
};
const setup = (ext) => {
  const dir = tmp();
  const sync = folder.createFolderSync(dir, ext, { stateFile: path.join(dir, '..', `${path.basename(dir)}-state.json`), now: () => NOW });
  return { dir, sync };
};

test('синхронизация: чужие версии одного файла за одну секунду сохраняются обе', async () => {
  const ext = fakeFolder();
  const { dir, sync } = setup(ext);
  fs.mkdirSync(path.join(dir, 'Главы'), { recursive: true });
  const file = path.join(dir, 'Главы', 'chap01.md');
  fs.writeFileSync(file, 'base');
  ext.nodes.set('Главы/chap01.md', bytes('base'));
  await sync.sync();

  fs.writeFileSync(file, 'local one'); ext.nodes.set('Главы/chap01.md', bytes('cloud one'));
  await sync.sync();
  fs.writeFileSync(file, 'local two'); ext.nodes.set('Главы/chap01.md', bytes('cloud two'));
  await sync.sync();

  for (const where of [localCopies(dir), remoteCopies(ext).map(([, t]) => t)]) {
    assert.ok(where.includes('cloud one'), `первая чужая версия потеряна: ${JSON.stringify(where)}`);
    assert.ok(where.includes('cloud two'), `вторая чужая версия потеряна: ${JSON.stringify(where)}`);
  }
});

test('заменить папку: одноимённые файлы с разным содержимым за одну секунду не затирают копии', async () => {
  const ext = fakeFolder();
  const { dir, sync } = setup(ext);
  fs.mkdirSync(path.join(dir, 'Главы'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.json'), '{"chapters":[]}');
  ext.nodes.set('Главы/same.md', bytes('folder one'));
  ext.nodes.set('Заметки/same.md', bytes('folder two'));
  await sync.replaceAll();
  const texts = remoteCopies(ext).map(([, t]) => t);
  assert.ok(texts.includes('folder one') && texts.includes('folder two'), `копия потеряна: ${JSON.stringify(texts)}`);
});

test('контроль: та же версия дважды даёт одну копию', async () => {
  const ext = fakeFolder();
  const { dir, sync } = setup(ext);
  fs.mkdirSync(path.join(dir, 'Главы'), { recursive: true });
  const file = path.join(dir, 'Главы', 'chap01.md');
  fs.writeFileSync(file, 'base'); ext.nodes.set('Главы/chap01.md', bytes('base'));
  await sync.sync();
  for (const n of ['one', 'two']) {
    fs.writeFileSync(file, `local ${n}`); ext.nodes.set('Главы/chap01.md', bytes('cloud same'));
    await sync.sync();
  }
  assert.strictEqual(localCopies(dir).filter((t) => t === 'cloud same').length, 1);
  assert.strictEqual(remoteCopies(ext).filter(([, t]) => t === 'cloud same').length, 1);
});
