'use strict';
// Синхронизация проекта с обычной папкой (src/folder.js): два «устройства» работают
// с одной папкой, как на компьютере через облако. Внешняя папка — подставная (Map),
// адаптер повторяет поведение плагина Saf на телефоне.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const folder = require('../src/folder');
const project = require('../src/project');

const utf8 = (bytes) => Buffer.from(bytes).toString('utf8');
const bytes = (text) => new Uint8Array(Buffer.from(text, 'utf8'));

/** Подставная внешняя папка: list/read/write/remove/mkdir поверх Map. */
function fakeFolder(initial = {}) {
  const nodes = new Map(Object.entries(initial).map(([k, v]) => [k, bytes(v)]));
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

function tmp(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kabinet-folder-${name}-`));
  return dir;
}

function make(dir, name = 'Роман') {
  return project.createProject(dir, name, { mode: 'novel' });
}

test('первый перенос: проект целиком уходит в папку и обратно', async () => {
  const local = tmp('export');
  const proj = make(local);
  const id = proj.chapters[0].id;
  project.writeChapter(local, id, 'Первая глава.');

  const ext = fakeFolder();
  const sync = folder.createFolderSync(local, ext, { stateFile: path.join(local, '..', 'state-a.json') });
  await sync.exportAll();

  assert.ok(ext.nodes.has('project.json'), 'project.json в папке');
  assert.ok(utf8(ext.nodes.get(`Главы/${id}.md`)).includes('Первая глава'));

  // другое устройство: скачивает ту же папку
  const other = tmp('import');
  const ext2 = { ...ext, nodes: ext.nodes };
  const sync2 = folder.createFolderSync(other, ext2, { stateFile: path.join(other, '..', 'state-b.json') });
  await sync2.importAll();
  assert.equal(project.openProject(other).name, 'Роман');
  assert.ok(project.readChapter(other, id).includes('Первая глава'));
});

test('правка на одном устройстве приходит на другое', async () => {
  const a = tmp('a');
  const b = tmp('b');
  const proj = make(a);
  const id = proj.chapters[0].id;
  project.writeChapter(a, id, 'Вариант А.');

  const ext = fakeFolder();
  const sa = folder.createFolderSync(a, ext, { stateFile: path.join(a, '..', 'sa.json') });
  await sa.exportAll();
  const sb = folder.createFolderSync(b, ext, { stateFile: path.join(b, '..', 'sb.json') });
  await sb.importAll();

  project.writeChapter(a, id, 'Вариант А, правка 2.');
  const pushed = await sa.push([`Главы/${id}.md`]);
  assert.deepEqual(pushed.pushed, [`Главы/${id}.md`]);

  const pulled = await sb.sync();
  assert.ok(pulled.pulled.includes(`Главы/${id}.md`));
  assert.ok(project.readChapter(b, id).includes('правка 2'));
});

test('правка с обеих сторон: чужая версия уходит в «Конфликты», своя остаётся', async () => {
  const a = tmp('ca');
  const b = tmp('cb');
  const proj = make(a);
  const id = proj.chapters[0].id;
  project.writeChapter(a, id, 'Общая основа.');

  const ext = fakeFolder();
  const sa = folder.createFolderSync(a, ext, { stateFile: path.join(a, '..', 'ca.json') });
  await sa.exportAll();
  const sb = folder.createFolderSync(b, ext, { stateFile: path.join(b, '..', 'cb.json') });
  await sb.importAll();

  project.writeChapter(a, id, 'Версия с телефона.');
  project.writeChapter(b, id, 'Версия с планшета.');

  await sa.push([`Главы/${id}.md`]);
  const res = await sb.sync();

  assert.ok(res.conflicts.includes(`Главы/${id}.md`), 'конфликт замечен');
  assert.ok(project.readChapter(b, id).includes('планшета'), 'своя версия не потеряна');
  const conflicts = fs.readdirSync(path.join(b, 'Конфликты'));
  assert.equal(conflicts.length, 1, 'чужая версия сохранена локально');
  assert.ok(conflicts[0].includes('с другого устройства'));
  assert.ok(utf8(ext.nodes.get(`Конфликты/${conflicts[0]}`)).includes('телефона'), 'чужая версия видна и в папке');
  assert.ok(utf8(ext.nodes.get(`Главы/${id}.md`)).includes('планшета'), 'в папке наша версия');
});

test('удаление главы убирает файл и из папки', async () => {
  const a = tmp('da');
  const proj = make(a);
  const id = proj.chapters[0].id;
  project.writeChapter(a, id, 'Текст');
  const ext = fakeFolder();
  const sync = folder.createFolderSync(a, ext, { stateFile: path.join(a, '..', 'da.json') });
  await sync.exportAll();
  assert.ok(ext.nodes.has(`Главы/${id}.md`));

  project.deleteChapter(a, id);
  const res = await sync.push([`Главы/${id}.md`]);
  assert.deepEqual(res.removed, [`Главы/${id}.md`]);
  assert.ok(!ext.nodes.has(`Главы/${id}.md`));
});

test('файл, удалённый снаружи, не возвращается, если у нас он не менялся', async () => {
  const a = tmp('rd');
  const proj = make(a);
  const id = proj.chapters[0].id;
  project.writeChapter(a, id, 'Текст');
  const ext = fakeFolder();
  const sync = folder.createFolderSync(a, ext, { stateFile: path.join(a, '..', 'rd.json') });
  await sync.exportAll();

  ext.nodes.delete(`Главы/${id}.md`); // удалили на другом устройстве
  const res = await sync.sync();
  assert.ok(res.pulled.includes(`Главы/${id}.md`));
  assert.ok(!fs.existsSync(path.join(a, 'Главы', `${id}.md`)), 'у нас тоже убран');
});

test('временные файлы и лишние папки не переносятся', () => {
  assert.equal(folder.isSyncable('project.json'), true);
  assert.equal(folder.isSyncable('stats.json'), true);
  assert.equal(folder.isSyncable('project (конфликт).json'), true);
  assert.equal(folder.isSyncable('Главы/abcdef.md'), true);
  assert.equal(folder.isSyncable('Конфликты/2026-10-31 10-00-00 x (с другого устройства).md'), true);
  assert.equal(folder.isSyncable('project.json.1234.tmp'), false);
  assert.equal(folder.isSyncable('.DS_Store'), false);
  assert.equal(folder.isSyncable('Копии/проект-1/project.json'), false);
  assert.equal(folder.isSyncable('Главы/подпапка/x.md'), false);
});

test('hasProject видит проект в выбранной папке', async () => {
  const a = tmp('hp');
  make(a);
  const ext = fakeFolder();
  const sync = folder.createFolderSync(a, ext, { stateFile: path.join(a, '..', 'hp.json') });
  assert.equal(await sync.hasProject(), false);
  await sync.exportAll();
  assert.equal(await sync.hasProject(), true);
});

test('одновременные проходы не мешают друг другу: проект не «удаляется» снаружи', async () => {
  // На телефоне первый выбор папки сразу выгружает проект, а следом по таймеру идёт обычная
  // синхронизация. Если проходы идут параллельно, второй видит пустую папку при заполненном
  // снимке и убирает только что записанные файлы.
  const a = tmp('race');
  const proj = make(a);
  const id = proj.chapters[0].id;
  project.writeChapter(a, id, 'Текст главы.');

  const ext = fakeFolder();
  const sync = folder.createFolderSync(a, ext, { stateFile: path.join(a, '..', 'race.json') });
  await Promise.all([sync.exportAll(), sync.sync(), sync.push(['project.json'])]);

  assert.ok(ext.nodes.has('project.json'), 'project.json остался в папке');
  assert.ok(ext.nodes.has(`Главы/${id}.md`), 'глава осталась в папке');
  assert.ok(fs.existsSync(path.join(a, 'project.json')), 'локальный проект цел');
  assert.ok(project.readChapter(a, id).includes('Текст главы'));
});

test('папка ответила пустым списком: главы у нас не удаляются, проход останавливается с ошибкой', async () => {
  const local = tmp('empty');
  const proj = make(local);
  const id = proj.chapters[0].id;
  project.writeChapter(local, id, 'Живой текст.');
  const ext = fakeFolder();
  const sync = folder.createFolderSync(local, ext, { stateFile: path.join(local, '..', 'state-empty.json') });
  await sync.exportAll();

  ext.nodes.clear(); // облако не отвечает: список пуст
  await assert.rejects(() => sync.sync(), /ничего не удалено/);
  assert.ok(project.readChapter(local, id).includes('Живой текст'), 'глава на месте');
  assert.ok(fs.existsSync(path.join(local, 'project.json')), 'project.json на месте');

  // облако вернулось: всё снова синхронизируется без потерь
  await sync.exportAll();
  const res = await sync.sync();
  assert.equal(res.removed.length + res.conflicts.length, 0);
});

test('сбой при чтении списка не превращается в удаление', async () => {
  const local = tmp('listfail');
  const proj = make(local);
  const id = proj.chapters[0].id;
  project.writeChapter(local, id, 'Текст.');
  const ext = fakeFolder();
  const sync = folder.createFolderSync(local, ext, { stateFile: path.join(local, '..', 'state-listfail.json') });
  await sync.exportAll();
  const broken = { ...ext, list: async () => { throw new Error('Папка не отвечает.'); } };
  const sync2 = folder.createFolderSync(local, broken, { stateFile: path.join(local, '..', 'state-listfail.json') });
  await assert.rejects(() => sync2.sync(), /не отвечает/);
  assert.ok(project.readChapter(local, id).includes('Текст'));
});

test('файл, не изменившийся по размеру и дате, заново не читается; изменившийся подтягивается', async () => {
  const local = tmp('sig');
  const proj = make(local);
  const id = proj.chapters[0].id;
  project.writeChapter(local, id, 'Версия один.');
  const ext = fakeFolder();
  const mtimes = new Map();
  let reads = 0;
  const withMeta = {
    ...ext,
    async list(p) {
      const items = await ext.list(p);
      return items.map((it) => {
        if (it.dir) return it;
        const key = [String(p).split('/').filter(Boolean).join('/'), it.name].filter(Boolean).join('/');
        return { ...it, size: ext.nodes.get(key).length, mtime: mtimes.get(key) || 1000 };
      });
    },
    async read(p) { reads += 1; return ext.read(p); },
  };
  const sync = folder.createFolderSync(local, withMeta, { stateFile: path.join(local, '..', 'state-sig.json') });
  await sync.exportAll();
  await sync.sync(); // первый проход читает всё и запоминает размер и дату
  reads = 0;
  await sync.sync();
  assert.equal(reads, 0, 'второй проход ничего не читает');

  // другое устройство поменяло главу (новая дата): она должна прийти к нам
  ext.nodes.set(`Главы/${id}.md`, bytes('Версия два, длиннее.'));
  mtimes.set(`Главы/${id}.md`, 2000);
  const res = await sync.sync();
  assert.ok(res.pulled.includes(`Главы/${id}.md`));
  assert.ok(project.readChapter(local, id).includes('Версия два'));
});
