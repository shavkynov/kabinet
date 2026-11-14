'use strict';
// Три устройства по очереди (дом, телефон, работа) и общая папка в облаке: что остаётся после офлайн-правок и удалений.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const folder = require('../src/folder');
const project = require('../src/project');

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

async function setup() {
  const cloud = fakeFolder();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kabinet-three-'));
  const dev = (name) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    return { name, dir, sync: folder.createFolderSync(dir, cloud, { stateFile: path.join(root, `${name}-state.json`) }) };
  };
  const home = dev('home'); const phone = dev('phone'); const work = dev('work');
  project.createProject(home.dir, 'Роман');
  const c1 = project.openProject(home.dir).chapters[0].id;
  project.renameChapter(home.dir, c1, 'Глава 1');
  project.writeChapter(home.dir, c1, 'Исходный текст.');
  await home.sync.exportAll(); await phone.sync.importAll(); await work.sync.importAll();
  const settle = async () => { for (let i = 0; i < 3; i += 1) for (const d of [work, home, phone]) await d.sync.sync(); };
  const chapters = (d) => project.openProject(d.dir).chapters.map((c) => `${c.title}: ${project.readChapter(d.dir, c.id).trim()}`);
  return { cloud, home, phone, work, c1, settle, chapters };
}

test('офлайн-правка на телефоне не стирает название главы, добавленной на работе', async () => {
  const { home, phone, work, c1, settle, chapters } = await setup();
  const c2 = project.addChapter(work.dir).id;
  project.renameChapter(work.dir, c2, 'Работа');
  project.writeChapter(work.dir, c2, 'Написано на работе.');
  await work.sync.sync();
  project.renameChapter(phone.dir, c1, 'Начало'); // телефон без связи
  project.writeChapter(phone.dir, c1, 'Исходный текст. Дописано в дороге.');
  await home.sync.sync();
  await phone.sync.sync();
  await settle();
  for (const d of [home, phone, work]) {
    assert.deepEqual(chapters(d), ['Начало: Исходный текст. Дописано в дороге.', 'Работа: Написано на работе.'], d.name);
  }
});

test('глава, удалённая на одном устройстве, не возвращается обычным проходом', async () => {
  const { cloud, home, phone, work, settle, chapters } = await setup();
  const c2 = project.addChapter(home.dir).id;
  project.renameChapter(home.dir, c2, 'Лишняя');
  project.writeChapter(home.dir, c2, 'Черновик.');
  await settle();
  project.deleteChapter(home.dir, c2);
  await settle();
  assert.ok(![...cloud.nodes.keys()].some((k) => k === `Главы/${c2}.md`), 'файл главы остался в облаке');
  for (const d of [home, phone, work]) {
    assert.deepEqual(chapters(d), ['Глава 1: Исходный текст.'], d.name);
    assert.ok(project.openProject(d.dir).trash.some((e) => e.id === c2), `${d.name}: глава должна лежать в корзине`);
  }
});

test('удалили на одном устройстве, а на другом успели дописать: дописанное остаётся', async () => {
  const { home, phone, work, settle, chapters } = await setup();
  const c2 = project.addChapter(home.dir).id;
  project.renameChapter(home.dir, c2, 'Спорная');
  project.writeChapter(home.dir, c2, 'Было.');
  await settle();
  project.writeChapter(phone.dir, c2, 'Было. Дописано на телефоне.');
  await phone.sync.sync();
  project.deleteChapter(home.dir, c2);
  await home.sync.sync();
  await settle();
  const all = [home, phone, work].map((d) => chapters(d).join('|') + fs.readdirSync(path.join(d.dir, 'Корзина')).map((f) => fs.readFileSync(path.join(d.dir, 'Корзина', f), 'utf8')).join('|'));
  for (const text of all) assert.ok(text.includes('Дописано на телефоне.'), `дописанное потеряно: ${text}`);
});

test('если на устройстве пропал project.json, синхронизация останавливается и облако не трогает', async () => {
  const { cloud, home } = await setup();
  const before = [...cloud.nodes.keys()].sort();
  fs.rmSync(path.join(home.dir, 'project.json'));
  fs.rmSync(path.join(home.dir, 'Главы'), { recursive: true });
  await assert.rejects(() => home.sync.sync(), /пуста|не видно|остановлена/);
  assert.deepEqual([...cloud.nodes.keys()].sort(), before);
});

test('слияние project.json не возвращает главу, которую мы уже удалили', () => {
  const { mergeMeta } = require('../src/meta-merge');
  const local = Buffer.from(JSON.stringify({ chapters: [{ id: 'aaaaaa', title: 'Одна' }], trash: [{ tid: 't1', kind: 'chapter', id: 'bbbbbb', title: 'Удалена', file: 'x.md' }] }));
  const remote = Buffer.from(JSON.stringify({ chapters: [{ id: 'aaaaaa', title: 'Одна' }, { id: 'bbbbbb', title: 'Удалена' }, { id: 'cccccc', title: 'Новая' }] }));
  const merged = JSON.parse(mergeMeta(local, remote).toString('utf8'));
  assert.deepEqual(merged.chapters.map((c) => c.id), ['aaaaaa', 'cccccc']);
});
