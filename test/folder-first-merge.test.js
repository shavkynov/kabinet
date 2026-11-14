'use strict';
// Первое подключение проекта к папке, где уже лежит другой проект (общей истории нет).
// Явный выбор «взять облако»: проект из папки становится основным, а локальные версии
// сохраняются в «Конфликты» и только после этого убираются из проекта. Ничего не теряется.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const folder = require('../src/folder');

const utf8 = (bytes) => Buffer.from(bytes).toString('utf8');
const bytes = (text) => new Uint8Array(Buffer.from(text, 'utf8'));

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

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `kabinet-first-${name}-`));
const stateIn = (dir, name) => path.join(dir, '..', `${path.basename(dir)}-${name}.json`);

/** Проект на диске в том виде, как его хранит программа: project.json и по файлу на главу. */
function makeProject(dir, { name, chapters, extra = {} }) {
  for (const d of ['Главы', 'Персонажи', 'Места', 'Предметы', 'Заметки', 'Изображения', 'Корзина']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  const meta = {
    app: 'kabinet', version: 1, name,
    chapters: chapters.map((c) => ({ id: c.id, title: c.title })),
    characters: [], places: [], items: [], notes: [],
    templates: { character: ['Общее описание'], place: ['Общее описание'] },
    ...extra,
  };
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(meta, null, 2));
  for (const c of chapters) fs.writeFileSync(path.join(dir, 'Главы', `${c.id}.md`), c.text);
  return meta;
}

const metaOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
const chapterFiles = (dir) => fs.readdirSync(path.join(dir, 'Главы')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort();
const conflictNames = (nodes) => [...nodes.keys()].filter((k) => k.startsWith('Конфликты/') && !k.endsWith('.keep'));
const conflictTexts = (dir) => fs.readdirSync(path.join(dir, 'Конфликты')).map((n) => fs.readFileSync(path.join(dir, 'Конфликты', n), 'utf8'));

const BOOK = [
  { id: 'aaaaaa01', title: 'Начало', text: 'Текст первой главы.\n' },
  { id: 'aaaaaa02', title: 'Середина', text: 'Текст второй главы.\n' },
  { id: 'aaaaaa03', title: 'Финал', text: 'Текст третьей главы.\n' },
];

/** Облако с настоящим романом, выгруженным «компьютером». */
async function cloudWithBook() {
  const desktop = tmp('desktop');
  makeProject(desktop, { name: 'Мой роман', chapters: BOOK });
  const ext = fakeFolder();
  await folder.createFolderSync(desktop, ext, { stateFile: stateIn(desktop, 's') }).exportAll();
  return { ext, desktop, original: utf8(ext.nodes.get('project.json')) };
}

test('взять облако: проект из папки становится основным, локальные версии — в «Конфликты»', async () => {
  const { ext, original } = await cloudWithBook();
  const phone = tmp('phone');
  makeProject(phone, { name: '1', chapters: [{ id: 'bbbbbb01', title: 'Глава 1', text: '' }] });

  const sync = folder.createFolderSync(phone, ext, { stateFile: stateIn(phone, 's') });
  const kept = await sync.takeCloud();

  assert.equal(utf8(ext.nodes.get('project.json')), original, 'project.json в облаке не изменился ни на байт');
  for (const c of BOOK) assert.ok(utf8(ext.nodes.get(`Главы/${c.id}.md`)).includes(c.text.trim()), 'тексты глав в облаке целы');
  assert.deepEqual(metaOf(phone).chapters.map((c) => c.title), ['Начало', 'Середина', 'Финал'], 'на телефоне те же главы, что в облаке');
  assert.equal(metaOf(phone).name, 'Мой роман');
  assert.deepEqual(chapterFiles(phone), BOOK.map((c) => c.id).sort(), 'в проекте нет лишних глав');
  assert.ok(!ext.nodes.has('Главы/bbbbbb01.md'), 'пустая глава нового проекта в облако не уехала');
  assert.ok(kept >= 2, 'сохранены локальная мета и глава');
  const texts = conflictTexts(phone);
  assert.ok(texts.some((t) => t.includes('bbbbbb01')), 'локальная мета сохранена в «Конфликты»');
  assert.ok(conflictNames(ext.nodes).length >= 2, 'копии сохранены и в папке');
  for (const c of BOOK) assert.ok(fs.readFileSync(path.join(phone, 'Главы', `${c.id}.md`), 'utf8').includes(c.text.trim()));
});

test('взять облако: текст со своего проекта не теряется и уходит в «Конфликты»', async () => {
  const { ext, original } = await cloudWithBook();
  const phone = tmp('phone2');
  makeProject(phone, { name: 'Рассказ', chapters: [{ id: 'bbbbbb01', title: 'Мой рассказ', text: 'Живой текст с телефона.\n' }] });

  await folder.createFolderSync(phone, ext, { stateFile: stateIn(phone, 's') }).takeCloud();

  assert.equal(utf8(ext.nodes.get('project.json')), original, 'облачный project.json не изменён');
  assert.ok(!ext.nodes.has('Главы/bbbbbb01.md'), 'текст телефона не выгружен в облако: выбран вариант «взять облако»');
  assert.deepEqual(chapterFiles(phone), BOOK.map((c) => c.id).sort(), 'в проекте остались только облачные главы');
  const texts = conflictTexts(phone);
  assert.ok(texts.some((t) => t.includes('Живой текст с телефона')), 'текст телефона сохранён в «Конфликты»');
  assert.ok(texts.some((t) => t.includes('Рассказ')), 'прежняя мета телефона сохранена в «Конфликты»');
  assert.ok(conflictNames(ext.nodes).some((k) => k.endsWith('.md')), 'и в папке есть копия главы');
});

test('взять облако при совпадающих файлах не создаёт копий', async () => {
  const { ext } = await cloudWithBook();
  const phone = tmp('phone3');
  makeProject(phone, { name: 'Мой роман', chapters: BOOK });
  const sync = folder.createFolderSync(phone, ext, { stateFile: stateIn(phone, 's') });
  assert.equal(await sync.takeCloud(), 0);
  assert.ok(!fs.existsSync(path.join(phone, 'Конфликты')), 'копий нет: всё совпало');
});

test('после «взять облако» обычный проход ничего не выгружает обратно', async () => {
  const { ext, original } = await cloudWithBook();
  const phone = tmp('phone4');
  makeProject(phone, { name: 'Рассказ', chapters: [{ id: 'bbbbbb01', title: 'Мой', text: 'Мой текст.\n' }] });
  const sync = folder.createFolderSync(phone, ext, { stateFile: stateIn(phone, 's') });
  await sync.takeCloud();
  await sync.sync();
  assert.equal(utf8(ext.nodes.get('project.json')), original, 'мета в облаке не изменилась повторным проходом');
  assert.ok(!ext.nodes.has('Главы/bbbbbb01.md'), 'вытесненная глава не вернулась в облако');
});
