'use strict';
// Ошибка чтения локального файла или папки не должна выглядеть как «удалено»: иначе удаление уходит в облако.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const folder = require('../src/folder');

const bytes = (t) => new Uint8Array(Buffer.from(t, 'utf8'));

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
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kabinet-walk-'));
function setup() {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'Главы'));
  fs.writeFileSync(path.join(dir, 'project.json'), '{"chapters":[]}');
  fs.writeFileSync(path.join(dir, 'Главы', 'aaaaaa.md'), 'текст');
  const ext = fakeFolder();
  const sync = folder.createFolderSync(dir, ext, { stateFile: path.join(dir, '..', `${path.basename(dir)}-state.json`) });
  return { dir, ext, sync };
}

test('нечитаемая папка с главами останавливает проход и не удаляет главы в облаке', async () => {
  const { dir, ext, sync } = setup();
  await sync.exportAll();
  fs.rmSync(path.join(dir, 'Главы'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Главы'), 'не папка');
  await assert.rejects(() => sync.sync(), /Не удалось прочитать/);
  assert.ok(ext.nodes.has('Главы/aaaaaa.md'), 'глава в облаке удалена из-за ошибки чтения');
});

test('нечитаемый файл (нет прав) не считается удалённым', async (t) => {
  const { dir, ext, sync } = setup();
  await sync.exportAll();
  const file = path.join(dir, 'Главы', 'aaaaaa.md');
  fs.chmodSync(file, 0o000);
  try { fs.readFileSync(file); fs.chmodSync(file, 0o644); t.skip('процесс читает любые файлы (root): проверка неприменима'); return; } catch { /* нужное состояние */ }
  try {
    await assert.rejects(() => sync.sync(), /Не удалось прочитать/);
  } finally { fs.chmodSync(file, 0o644); }
  assert.ok(ext.nodes.has('Главы/aaaaaa.md'));
});

test('контроль: папки с главами нет совсем — обычное удаление, без ошибки', async () => {
  const { dir, sync } = setup();
  await sync.exportAll();
  fs.rmSync(path.join(dir, 'Главы'), { recursive: true });
  const res = await sync.sync();
  assert.ok(res);
  assert.ok(!fs.existsSync(path.join(dir, 'Главы', 'aaaaaa.md')));
});

test('небезопасные имена из облака не синхронизируются (Windows: обратный слеш, двоеточие, устройства)', async () => {
  const { dir, ext, sync } = setup();
  await sync.exportAll();
  for (const bad of ['Главы/x\\..\\..\\evil.md', 'Главы/a:stream.md', 'Главы/CON.md', 'Главы/nul.txt', 'Главы/trailing.md.', 'Главы/a*b.md', 'Главы/tab\tname.md', 'project..\\x.json']) {
    ext.nodes.set(bad, bytes('evil'));
  }
  ext.nodes.set('Главы/bbbbbb.md', bytes('good'));
  await sync.sync();
  assert.deepEqual(fs.readdirSync(path.join(dir, 'Главы')).sort(), ['aaaaaa.md', 'bbbbbb.md']);
  assert.ok(!fs.existsSync(path.join(dir, '..', 'evil.md')));
  assert.ok(!fs.readdirSync(dir).some((n) => n.startsWith('project..')));
});

test('webdav: %2F внутри имени не становится разделителем пути', () => {
  const { parseMultistatus } = require('../src/webdav');
  const v = parseMultistatus('<D:multistatus xmlns:D="DAV:"><D:response><D:href>/dav/a%2Fb.md</D:href></D:response><D:response><D:href>/dav/%D0%B0.md</D:href></D:response></D:multistatus>');
  assert.deepEqual(v.map((x) => x.href), ['/dav/а.md']);
});
