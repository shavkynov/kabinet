'use strict';
// Первое соединение проекта с папкой, где уже лежит другой проект (общей истории нет).
// Раньше «Соединить» записывало в облако project.json нового проекта поверх настоящего, а главы из облака приходили на телефон
// отдельными файлами и становились «Найденными главами». Здесь проверяется, что этого больше не происходит и ничего не теряется.

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
// Именно такие файлы openProject добавляет в список как «Найденная глава»: файл есть, записи в project.json нет.
const orphans = (dir) => { const known = new Set(metaOf(dir).chapters.map((c) => c.id)); return chapterFiles(dir).filter((id) => !known.has(id)); };
const conflictNames = (nodes) => [...nodes.keys()].filter((k) => k.startsWith('Конфликты/') && !k.endsWith('.keep'));

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

test('новый пустой проект, соединённый с папкой, где лежит роман: структура облака не меняется, лишних глав нет', async () => {
  const { ext, original } = await cloudWithBook();
  const phone = tmp('phone');
  makeProject(phone, { name: '1', chapters: [{ id: 'bbbbbb01', title: 'Глава 1', text: '' }] });

  const sync = folder.createFolderSync(phone, ext, { stateFile: stateIn(phone, 's') });
  const res = await sync.sync();

  assert.equal(utf8(ext.nodes.get('project.json')), original, 'project.json в облаке не изменился ни на байт');
  for (const c of BOOK) assert.ok(utf8(ext.nodes.get(`Главы/${c.id}.md`)).includes(c.text.trim()), 'тексты глав в облаке целы');
  assert.deepEqual(metaOf(phone).chapters.map((c) => c.title), ['Начало', 'Середина', 'Финал'], 'на телефоне те же главы, что в облаке');
  assert.equal(metaOf(phone).name, 'Мой роман');
  assert.deepEqual(orphans(phone), [], 'нет файлов глав без записи (будущих «Найденных глав»)');
  assert.ok(!ext.nodes.has('Главы/bbbbbb01.md'), 'пустая глава нового проекта в облако не уехала');
  assert.deepEqual(conflictNames(ext.nodes), [], 'мусора в «Конфликтах» нет');
  assert.deepEqual(res.conflicts.filter((x) => x === 'project.json'), []);
  for (const c of BOOK) assert.ok(fs.readFileSync(path.join(phone, 'Главы', `${c.id}.md`), 'utf8').includes(c.text.trim()));
});

test('проект со своим текстом: главы обеих сторон сохраняются, чужая структура остаётся основой', async () => {
  const { ext } = await cloudWithBook();
  const phone = tmp('phone2');
  makeProject(phone, { name: 'Рассказ', chapters: [{ id: 'bbbbbb01', title: 'Мой рассказ', text: 'Живой текст с телефона.\n' }, { id: 'bbbbbb02', title: 'Глава 2', text: '' }] });

  const res = await folder.createFolderSync(phone, ext, { stateFile: stateIn(phone, 's') }).sync();

  const titles = metaOf(phone).chapters.map((c) => c.title);
  assert.deepEqual(titles, ['Начало', 'Середина', 'Финал', 'Мой рассказ'], 'главы облака впереди, непустая глава телефона добавлена, пустая отброшена');
  assert.deepEqual(metaOf(phone).chapters.map((c) => c.title), metaOf(phone).chapters.map((c) => c.title));
  assert.deepEqual(JSON.parse(utf8(ext.nodes.get('project.json'))).chapters.map((c) => c.title), titles, 'облако получило объединённый список');
  assert.ok(utf8(ext.nodes.get('Главы/bbbbbb01.md')).includes('Живой текст с телефона'), 'текст телефона ушёл в облако');
  assert.ok(fs.readFileSync(path.join(phone, 'Главы', 'bbbbbb01.md'), 'utf8').includes('Живой текст'), 'и остался на телефоне');
  assert.deepEqual(orphans(phone), []);
  assert.ok(!fs.existsSync(path.join(phone, 'Главы', 'bbbbbb02.md')), 'пустая глава удалена локально');
  assert.equal(metaOf(phone).name, 'Мой роман');
  const kept = conflictNames(ext.nodes).filter((k) => k.includes('было на этом устройстве'));
  assert.equal(kept.length, 1, 'прежний project.json телефона сохранён в «Конфликты»');
  assert.ok(kept[0].endsWith('.json'));
  assert.equal(JSON.parse(utf8(ext.nodes.get(kept[0]))).name, 'Рассказ');
  assert.ok(fs.readdirSync(path.join(phone, 'Конфликты')).some((n) => n.includes('было на этом устройстве')), 'и локально');
  assert.deepEqual(res.pulled.sort(), res.pulled.sort());
});

test('повторная синхронизация после первого соединения ничего не меняет', async () => {
  const { ext } = await cloudWithBook();
  const phone = tmp('phone3');
  makeProject(phone, { name: 'Рассказ', chapters: [{ id: 'bbbbbb01', title: 'Мой рассказ', text: 'Текст.\n' }] });
  const sync = folder.createFolderSync(phone, ext, { stateFile: stateIn(phone, 's') });
  await sync.sync();
  const cloudBefore = utf8(ext.nodes.get('project.json'));
  const localBefore = fs.readFileSync(path.join(phone, 'project.json'), 'utf8');
  const second = await sync.sync();
  assert.deepEqual(second.pushed, []);
  assert.deepEqual(second.pulled, []);
  assert.deepEqual(second.conflicts, []);
  assert.equal(utf8(ext.nodes.get('project.json')), cloudBefore);
  assert.equal(fs.readFileSync(path.join(phone, 'project.json'), 'utf8'), localBefore);
  assert.deepEqual(orphans(phone), []);
});

test('второе устройство, подключившееся позже, получает то же самое и тоже без лишних глав', async () => {
  const { ext } = await cloudWithBook();
  const phone = tmp('phone4');
  makeProject(phone, { name: 'Рассказ', chapters: [{ id: 'bbbbbb01', title: 'Мой рассказ', text: 'Текст.\n' }] });
  await folder.createFolderSync(phone, ext, { stateFile: stateIn(phone, 's') }).sync();

  const tablet = tmp('tablet');
  makeProject(tablet, { name: '2', chapters: [{ id: 'cccccc01', title: 'Глава 1', text: '' }] });
  await folder.createFolderSync(tablet, ext, { stateFile: stateIn(tablet, 's') }).sync();
  assert.deepEqual(metaOf(tablet).chapters.map((c) => c.title), ['Начало', 'Середина', 'Финал', 'Мой рассказ']);
  assert.deepEqual(orphans(tablet), []);
});

test('если project.json в облаке нельзя прочитать, действует прежнее правило: чужая версия уходит в «Конфликты»', async () => {
  const ext = fakeFolder({ 'project.json': 'это не JSON', 'Главы/zzzzzz01.md': 'Текст.' });
  const phone = tmp('phone5');
  makeProject(phone, { name: 'Рассказ', chapters: [{ id: 'bbbbbb01', title: 'Мой рассказ', text: 'Текст.\n' }] });
  const res = await folder.createFolderSync(phone, ext, { stateFile: stateIn(phone, 's') }).sync();
  assert.ok(res.conflicts.includes('project.json'));
  assert.ok(conflictNames(ext.nodes).some((k) => utf8(ext.nodes.get(k)) === 'это не JSON'), 'испорченная версия сохранена, а не потеряна');
  assert.equal(JSON.parse(utf8(ext.nodes.get('project.json'))).name, 'Рассказ');
});

test('когда общая история есть, правка структуры с двух сторон по-прежнему даёт конфликт', async () => {
  const { ext } = await cloudWithBook();
  const other = tmp('other');
  const a = folder.createFolderSync(other, ext, { stateFile: stateIn(other, 's') });
  await a.importAll();

  const edited = JSON.parse(utf8(ext.nodes.get('project.json')));
  edited.chapters[0].title = 'Облачное название';
  ext.nodes.set('project.json', bytes(JSON.stringify(edited, null, 2)));
  const mine = metaOf(other);
  mine.chapters[0].title = 'Своё название';
  fs.writeFileSync(path.join(other, 'project.json'), JSON.stringify(mine, null, 2));

  const res = await a.sync();
  assert.ok(res.conflicts.includes('project.json'));
  assert.equal(metaOf(other).chapters[0].title, 'Своё название', 'своя версия не потеряна');
  assert.ok(conflictNames(ext.nodes).some((k) => utf8(ext.nodes.get(k)).includes('Облачное название')));
});

test('статистика: пустой проект не затирает накопленную в облаке', async () => {
  const { ext } = await cloudWithBook();
  ext.nodes.set('stats.json', bytes('{"days":{"2026-10-01":4200}}'));
  const phone = tmp('phone6');
  makeProject(phone, { name: '1', chapters: [{ id: 'bbbbbb01', title: 'Глава 1', text: '' }] });
  fs.writeFileSync(path.join(phone, 'stats.json'), '{"days":{"2026-11-01":0}}');
  await folder.createFolderSync(phone, ext, { stateFile: stateIn(phone, 's') }).sync();
  assert.equal(utf8(ext.nodes.get('stats.json')), '{"days":{"2026-10-01":4200}}');
  assert.equal(fs.readFileSync(path.join(phone, 'stats.json'), 'utf8'), '{"days":{"2026-10-01":4200}}');
  assert.deepEqual(conflictNames(ext.nodes), []);
});

test('одинаковые id, но разные названия: локальный project.json сохранён как конфликт, облачная структура остаётся базой', async () => {
  const { ext } = await cloudWithBook();
  const phone = tmp('same-ids');
  makeProject(phone, { name: 'Мой вариант', chapters: BOOK.map((c, i) => ({ ...c, title: i === 0 ? 'Моя версия названия' : c.title, text: `Локальный ${c.text}` })) });
  const sync = folder.createFolderSync(phone, ext, { stateFile: stateIn(phone, 's') });
  const res = await sync.sync();
  assert.equal(metaOf(phone).chapters[0].title, 'Начало');
  assert.equal(metaOf(phone).name, 'Мой роман');
  const backup = conflictNames(ext.nodes).find((k) => k.endsWith('.json') && k.includes('project'));
  assert.ok(backup, 'локальный project.json помещён в «Конфликты»');
  assert.equal(JSON.parse(utf8(ext.nodes.get(backup))).chapters[0].title, 'Моя версия названия');
  assert.deepEqual(res.conflicts, BOOK.map((c) => `Главы/${c.id}.md`), 'тексты глав с одинаковыми id обрабатываются прежней защитой от конфликтов');
  for (const c of BOOK) assert.ok(utf8(ext.nodes.get(`Главы/${c.id}.md`)).includes(`Локальный ${c.text.trim()}`));
});
