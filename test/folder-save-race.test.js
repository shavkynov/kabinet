'use strict';
// Гонка синхронизации: глава, сохранённая локально во время прохода (после снятия снимка,
// до обработки этой главы), не должна теряться — ни при обновлении из облака, ни при удалении
// из облака. Порт тех же сценариев, что в core/tests/sync_save_race.rs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const folder = require('../src/folder');
const project = require('../src/project');

const bytes = (text) => new Uint8Array(Buffer.from(text, 'utf8'));
const utf8 = (b) => Buffer.from(b).toString('utf8');

const BASE = 'base second chapter';
const LOCAL = 'local edit saved after the snapshot';
const CLOUD = 'new cloud version';

function fakeFolder() {
  const nodes = new Map();
  const rel = (p) => String(p).split('/').filter(Boolean).join('/');
  return {
    nodes,
    async list(p) {
      const base = rel(p);
      const out = new Map();
      for (const key of nodes.keys()) {
        if (base && !key.startsWith(`${base}/`)) continue;
        const rest = base ? key.slice(base.length + 1) : key;
        const name = rest.split('/')[0];
        if (!name) continue;
        out.set(name, rest.includes('/'));
      }
      return [...out].map(([name, dir]) => ({ name, dir }));
    },
    async read(p) { const v = nodes.get(rel(p)); return v ? new Uint8Array(v) : null; },
    async write(p, data) { nodes.set(rel(p), new Uint8Array(data)); },
    async remove(p) { nodes.delete(rel(p)); },
    async mkdir(p) { if (rel(p)) nodes.set(`${rel(p)}/.keep`, new Uint8Array(0)); },
  };
}

/**
 * Проект с двумя главами; сохранение второй главы происходит в момент, когда проход синхронизации
 * пишет первую главу наружу. Хук взводится только перед sync(), чтобы не сработать при exportAll.
 */
function setup({ cloudDelete }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kabinet-folder-race-'));
  const proj = project.createProject(dir, 'Race');
  const ids = [proj.chapters[0].id, project.addChapter(dir, null).id].sort();
  const first = ids[0]; // обрабатывается в проходе раньше второй главы
  const second = ids[1];
  project.writeChapter(dir, first, 'base first chapter');
  project.writeChapter(dir, second, BASE);

  const ext = fakeFolder();
  let armed = false;
  let savedDuringSync = false;
  const adapter = {
    ...ext,
    async write(p, data) {
      if (armed && p === `Главы/${first}.md`) {
        project.writeChapter(dir, second, LOCAL);
        savedDuringSync = true;
      }
      return ext.write(p, data);
    },
  };
  const sync = folder.createFolderSync(dir, adapter, { stateFile: path.join(dir, '..', 'race.json') });

  return {
    dir, first, second, ext, sync,
    savedDuringSync: () => savedDuringSync,
    localSecond: () => project.readChapter(dir, second),
    async prepare() {
      await sync.exportAll(); // первый перенос без хука
      project.writeChapter(dir, first, 'local first chapter edit');
      if (cloudDelete) ext.nodes.delete(`Главы/${second}.md`);
      else ext.nodes.set(`Главы/${second}.md`, bytes(CLOUD));
      armed = true; // взводим хук только на проход синхронизации
    },
  };
}

function conflictTexts(dir) {
  const conflicts = path.join(dir, 'Конфликты');
  if (!fs.existsSync(conflicts)) return [];
  return fs.readdirSync(conflicts).map((n) => utf8(fs.readFileSync(path.join(conflicts, n))));
}

test('локальное сохранение после снимка переживает обновление из облака', async () => {
  const s = setup({ cloudDelete: false });
  await s.prepare();
  await s.sync.sync();

  assert.ok(s.savedDuringSync(), 'локальное сохранение должно случиться внутри прохода');
  assert.equal(s.localSecond(), LOCAL, 'sync потерял успешно сохранённую локальную правку');
  assert.ok(conflictTexts(s.dir).some((t) => t === CLOUD), 'облачная версия должна остаться в «Конфликты»');
  assert.equal(utf8(s.ext.nodes.get(`Главы/${s.second}.md`)), LOCAL, 'наша версия ушла наружу');
});

test('локальное сохранение после снимка переживает удаление из облака', async () => {
  const s = setup({ cloudDelete: true });
  await s.prepare();
  await s.sync.sync();

  assert.ok(s.savedDuringSync(), 'локальное сохранение должно случиться внутри прохода');
  assert.equal(s.localSecond(), LOCAL, 'удаление из облака потеряло успешно сохранённую локальную правку');
  assert.ok(!s.ext.nodes.has(`Главы/${s.second}.md`), 'удаление на другом устройстве не должно воскрешаться');
});
