'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const project = require('../src/project');
const recents = require('../src/recents');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kabinet-test-'));
}

test('createProject создаёт структуру и одну главу', () => {
  const dir = path.join(tmp(), 'Роман');
  const p = project.createProject(dir, 'Роман');
  assert.equal(p.name, 'Роман');
  assert.equal(p.chapters.length, 1);
  for (const d of ['Главы', 'Персонажи', 'Места', 'Заметки', 'Изображения', 'Корзина']) {
    assert.ok(fs.existsSync(path.join(dir, d)), d);
  }
  assert.ok(fs.existsSync(path.join(dir, 'Главы', `${p.chapters[0].id}.md`)));
  assert.throws(() => project.createProject(dir, 'Роман'), /уже есть проект/);
});

test('добавление главы после выбранной и в конец', () => {
  const dir = path.join(tmp(), 'P');
  const p = project.createProject(dir, 'P');
  const a = p.chapters[0].id;
  const r1 = project.addChapter(dir, a);
  const r2 = project.addChapter(dir, a); // между первой и r1
  assert.deepEqual(r2.project.chapters.map((c) => c.id), [a, r2.id, r1.id]);
  const r3 = project.addChapter(dir, null);
  assert.equal(r3.project.chapters.at(-1).id, r3.id);
});

test('переименование не трогает номер: номер считает интерфейс по позиции', () => {
  const dir = path.join(tmp(), 'P');
  const p = project.createProject(dir, 'P');
  const id = p.chapters[0].id;
  const r = project.renameChapter(dir, id, '  Глава,   в которой героя убивают ');
  assert.equal(r.chapters[0].title, 'Глава, в которой героя убивают');
  // пустое имя игнорируется
  assert.equal(project.renameChapter(dir, id, '   ').chapters[0].title, 'Глава, в которой героя убивают');
});

test('перемещение глав', () => {
  const dir = path.join(tmp(), 'P');
  const p = project.createProject(dir, 'P');
  const a = p.chapters[0].id;
  const b = project.addChapter(dir, a).id;
  const c = project.addChapter(dir, b).id;
  assert.deepEqual(project.moveChapter(dir, c, 0).chapters.map((x) => x.id), [c, a, b]);
  assert.deepEqual(project.moveChapter(dir, c, 99).chapters.map((x) => x.id), [a, b, c]);
  assert.deepEqual(project.moveChapter(dir, a, 1).chapters.map((x) => x.id), [b, a, c]);
});

test('запись и чтение главы, кириллица', () => {
  const dir = path.join(tmp(), 'P');
  const id = project.createProject(dir, 'P').chapters[0].id;
  const text = '— Привет, — сказал он.\n\nЁжик в тумане.';
  project.writeChapter(dir, id, text);
  assert.equal(project.readChapter(dir, id), text);
  // временных файлов не остаётся
  const left = fs.readdirSync(path.join(dir, 'Главы')).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(left, []);
});

test('защита от чужих идентификаторов (выход из папки)', () => {
  const dir = path.join(tmp(), 'P');
  project.createProject(dir, 'P');
  assert.throws(() => project.readChapter(dir, '../../etc/passwd'), /Неверный идентификатор/);
  assert.throws(() => project.writeChapter(dir, '../evil', 'x'), /Неверный идентификатор|не найдена/);
  assert.ok(!fs.existsSync(path.join(dir, 'evil.md')));
  // валидный по виду id, но не из проекта
  assert.throws(() => project.writeChapter(dir, 'abcdef123456', 'x'), /не найдена/);
});

test('удаление переносит файл в Корзину', () => {
  const dir = path.join(tmp(), 'P');
  const p = project.createProject(dir, 'P');
  const a = p.chapters[0].id;
  const b = project.addChapter(dir, a).id;
  project.writeChapter(dir, b, 'важный текст');
  project.renameChapter(dir, b, 'Опасное: имя/с символами');
  const after = project.deleteChapter(dir, b);
  assert.deepEqual(after.chapters.map((c) => c.id), [a]);
  const trash = fs.readdirSync(path.join(dir, 'Корзина'));
  assert.equal(trash.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, 'Корзина', trash[0]), 'utf8'), 'важный текст');
  assert.ok(!fs.existsSync(path.join(dir, 'Главы', `${b}.md`)));
});

test('openProject подбирает файлы глав, которых нет в project.json', () => {
  const dir = path.join(tmp(), 'P');
  const p = project.createProject(dir, 'P');
  fs.writeFileSync(path.join(dir, 'Главы', 'zzzzzz999999.md'), 'потерянный текст');
  fs.writeFileSync(path.join(dir, 'Главы', `${p.chapters[0].id}.notes.md`), 'заметки'); // не глава
  const opened = project.openProject(dir);
  assert.equal(opened.chapters.length, 2);
  assert.equal(opened.chapters[1].id, 'zzzzzz999999');
  assert.equal(project.readChapter(dir, 'zzzzzz999999'), 'потерянный текст');
});

test('повреждённый project.json не перезаписывается', () => {
  const dir = path.join(tmp(), 'P');
  project.createProject(dir, 'P');
  const file = path.join(dir, 'project.json');
  fs.writeFileSync(file, '{ сломано');
  assert.throws(() => project.openProject(dir), /повреждён/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ сломано');
});

test('project.json.bak появляется после изменений', () => {
  const dir = path.join(tmp(), 'P');
  const p = project.createProject(dir, 'P');
  project.renameChapter(dir, p.chapters[0].id, 'Первая');
  assert.ok(fs.existsSync(path.join(dir, 'project.json.bak')));
});

test('папка без project.json: понятная ошибка', () => {
  assert.throws(() => project.openProject(tmp()), /нет проекта Кабинета/);
});

test('недавние проекты: порядок, дубликаты, лимит, удаление', () => {
  const dir = tmp();
  const file = path.join(dir, 'data', 'recent.json');
  const a = path.join(dir, 'A');
  const b = path.join(dir, 'B');
  project.createProject(a, 'A');
  recents.add(file, { path: a, name: 'A' });
  recents.add(file, { path: b, name: 'B' });
  recents.add(file, { path: a, name: 'A' });
  const list = recents.list(file);
  assert.deepEqual(list.map((x) => x.name), ['A', 'B']);
  assert.equal(list[0].exists, true);
  assert.equal(list[1].exists, false);
  assert.ok(recents.has(file, a));
  recents.remove(file, a);
  assert.ok(!recents.has(file, a));
  for (let i = 0; i < 30; i++) recents.add(file, { path: path.join(dir, `p${i}`), name: `p${i}` });
  assert.equal(recents.list(file).length, 15);
  // битый файл не ломает программу
  fs.writeFileSync(file, 'не json');
  assert.deepEqual(recents.list(file), []);
});

test('цели по словам: у главы и по умолчанию, сохраняются и проверяются', () => {
  const dir = path.join(tmp(), 'P');
  const p = project.createProject(dir, 'P');
  const a = p.chapters[0].id;
  assert.equal(p.chapters[0].goal, null);
  assert.equal(p.defaultGoal, null);

  let v = project.setChapterGoal(dir, a, '2 000'.replace(/\s/g, ''));
  assert.equal(v.chapters[0].goal, 2000);
  v = project.setDefaultGoal(dir, 1500.4);
  assert.equal(v.defaultGoal, 1500);

  // цель переживает переименование, перемещение и повторное открытие проекта
  const b = project.addChapter(dir, a).id;
  project.renameChapter(dir, a, 'Первая');
  project.moveChapter(dir, a, 1);
  const reopened = project.openProject(dir);
  assert.equal(reopened.chapters.find((c) => c.id === a).goal, 2000);
  assert.equal(reopened.chapters.find((c) => c.id === b).goal, null);
  assert.equal(reopened.defaultGoal, 1500);

  // неверные значения убирают цель
  for (const bad of [null, '', 0, -5, 'abc', 5_000_000, NaN]) {
    assert.equal(project.setChapterGoal(dir, a, bad).chapters.find((c) => c.id === a).goal, null, String(bad));
    project.setChapterGoal(dir, a, 300);
  }
  assert.equal(project.setDefaultGoal(dir, null).defaultGoal, null);
});

test('маркеры глав: ставятся, снимаются, не принимают лишнего', () => {
  const dir = path.join(tmp(), 'P');
  const a = project.createProject(dir, 'P').chapters[0].id;
  assert.equal(project.setChapterMarker(dir, a, 'orange').chapters[0].marker, 'orange');
  assert.equal(project.openProject(dir).chapters[0].marker, 'orange'); // переживает перезапуск
  assert.equal(project.setChapterMarker(dir, a, 'purple').chapters[0].marker, null);
  project.setChapterMarker(dir, a, 'green');
  assert.equal(project.setChapterMarker(dir, a, null).chapters[0].marker, null);
});

test('карточки: создаются из шаблона, шаблон меняется и не трогает старые', () => {
  const dir = path.join(tmp(), 'P');
  const p = project.createProject(dir, 'P');
  assert.ok(p.templates.character.includes('Глаза'));
  assert.ok(p.templates.place.includes('Климат'));

  const { project: v, id } = project.addItem(dir, 'character', null);
  assert.equal(v.characters[0].title, 'Новый персонаж');
  const card = JSON.parse(project.readItem(dir, 'character', id));
  assert.deepEqual(card.fields.map((f) => f.name), p.templates.character);
  assert.equal(card.short, '');
  assert.deepEqual(card.aliases, []);

  // свой шаблон: пустые и повторяющиеся названия отбрасываются
  const t = project.setTemplate(dir, 'character', ['Глаза', '  ', 'Глаза', 'Шрам']);
  assert.deepEqual(t.templates.character, ['Глаза', 'Шрам']);
  const second = project.addItem(dir, 'character', id);
  assert.deepEqual(
    JSON.parse(project.readItem(dir, 'character', second.id)).fields.map((f) => f.name),
    ['Глаза', 'Шрам'],
  );
  // старая карточка осталась прежней
  assert.deepEqual(JSON.parse(project.readItem(dir, 'character', id)).fields.map((f) => f.name), p.templates.character);
  // порядок: новая после выбранной
  assert.deepEqual(second.project.characters.map((c) => c.id), [id, second.id]);
  assert.throws(() => project.setTemplate(dir, 'note', ['x']), /Неизвестный шаблон/);
});

test('карточки: запись очищается, мусор отвергается', () => {
  const dir = path.join(tmp(), 'P');
  project.createProject(dir, 'P');
  const { id } = project.addItem(dir, 'place', null);
  project.writeItem(dir, 'place', id, JSON.stringify({
    short: 'Городок у реки',
    aliases: ['Ривер', ' Ривер ', '', 'Речной'],
    fields: [{ name: 'Климат', value: 'сырой' }, { name: '', value: 'без названия' }],
    evil: '<script>',
  }));
  const saved = JSON.parse(project.readItem(dir, 'place', id));
  assert.deepEqual(Object.keys(saved).sort(), ['aliases', 'fields', 'ignore', 'image', 'protagonist', 'short']);
  assert.deepEqual(saved.aliases, ['Ривер', 'Речной']);
  assert.equal(saved.fields[1].name, 'Поле');
  assert.throws(() => project.writeItem(dir, 'place', id, 'не json'), /неверный формат/);
  assert.throws(() => project.writeItem(dir, 'place', id, '[1,2]'), /Неверный формат/);
  assert.throws(() => project.writeItem(dir, 'place', 'abcdef123456', '{}'), /не найдена/);
  assert.throws(() => project.readItem(dir, 'place', '../x'), /Неверный идентификатор/);
  assert.throws(() => project.addItem(dir, 'chapter', null), /Неизвестный вид/);
});

test('корзина: если файл пропал, пустая запись под видом восстановленной не создаётся', () => {
  const dir = path.join(tmp(), 'Роман');
  const p = project.createProject(dir, 'Роман');
  const a = project.addChapter(dir, null).id;
  project.writeChapter(dir, a, 'важный текст');
  let v = project.deleteChapter(dir, a);
  const tid = v.trash[0].tid;
  const trashDir = path.join(dir, 'Корзина');
  for (const f of fs.readdirSync(trashDir)) fs.unlinkSync(path.join(trashDir, f)); // файл пропал
  assert.throws(() => project.restoreTrash(dir, tid), /пропал из Корзины/);
  v = project.openProject(dir);
  assert.equal(v.chapters.length, p.chapters.length, 'глава в список не вернулась');
  assert.equal(v.trash.length, 1, 'запись осталась в корзине');
  assert.equal(project.purgeTrash(dir, tid).trash.length, 0, 'её можно удалить насовсем');
});

test('корзина: глава, которой на диске не было при удалении, возвращается пустой', () => {
  const dir = path.join(tmp(), 'Роман');
  project.createProject(dir, 'Роман');
  const a = project.addChapter(dir, null).id;
  fs.unlinkSync(path.join(dir, 'Главы', `${a}.md`)); // файла нет
  const v = project.deleteChapter(dir, a);
  assert.equal(v.trash[0].id, a);
  const back = project.restoreTrash(dir, v.trash[0].tid);
  assert.ok(back.project.chapters.some((c) => c.id === a));
  assert.equal(project.readChapter(dir, a), '');
});

test('длинные тексты не обрезаются молча: синопсис, заметки к главе, поля карточки', () => {
  const dir = path.join(tmp(), 'Роман');
  const v = project.createProject(dir, 'Роман');
  const id = v.chapters[0].id;
  const synopsis = 'с'.repeat(100_000);
  const notes = 'з'.repeat(300_000);
  project.writeChapterMeta(dir, id, { synopsis, notes });
  assert.deepEqual(project.readChapterMeta(dir, id), { synopsis, notes });
  const cid = project.addItem(dir, 'character', null).id;
  const field = 'п'.repeat(200_000);
  const short = 'к'.repeat(20_000);
  project.writeItem(dir, 'character', cid, JSON.stringify({ short, aliases: [], fields: [{ name: 'Прошлое', value: field }] }));
  const card = JSON.parse(project.readItem(dir, 'character', cid));
  assert.equal(card.fields[0].value.length, field.length);
  assert.equal(card.short.length, short.length);
  // и после повторной загрузки project.json ничего не теряется
  project.renameChapter(dir, id, 'Новое название');
  assert.equal(project.readChapterMeta(dir, id).notes.length, notes.length);
});

test('поля, которых эта версия не знает, переживают сохранение, удаление и возврат', () => {
  const dir = path.join(tmp(), 'Роман');
  const v = project.createProject(dir, 'Роман');
  const id = v.chapters[0].id;
  const cid = project.addItem(dir, 'character', null).id;
  const file = path.join(dir, 'project.json');
  const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
  meta.chapters[0].future = { scene: 3 };
  meta.characters.find((c) => c.id === cid).badge = 'gold';
  fs.writeFileSync(file, JSON.stringify(meta).replace('"future"', '"__proto__":{"polluted":true},"future"'));
  assert.equal(({}).polluted, undefined);

  project.renameChapter(dir, id, 'Первая'); // любое сохранение project.json
  let saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(saved.chapters[0].future, { scene: 3 });
  assert.equal(saved.characters.find((c) => c.id === cid).badge, 'gold');
  assert.equal(({}).polluted, undefined, 'служебный ключ __proto__ не переносится');
  assert.equal(Object.getPrototypeOf(saved.chapters[0]), Object.prototype);

  // удаление в Корзину и возврат тоже не стирают чужие поля
  project.addChapter(dir, null); // чтобы удалять было можно
  const trashed = project.deleteChapter(dir, id);
  project.restoreTrash(dir, trashed.trash[0].tid);
  saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(saved.chapters.find((c) => c.id === id).future, { scene: 3 });
});

test('названия по умолчанию переводятся на язык интерфейса', () => {
  const i18n = require('../src/i18n');
  const dir = path.join(tmp(), 'Роман');
  const v = project.createProject(dir, 'Роман');
  const id = v.chapters[0].id;
  const cid = project.addItem(dir, 'character', null).id;
  const file = path.join(dir, 'project.json');
  const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
  meta.chapters[0].title = '';
  meta.characters.find((c) => c.id === cid).title = '';
  fs.writeFileSync(file, JSON.stringify(meta));
  fs.writeFileSync(path.join(dir, 'Главы', 'abcdef1234.md'), 'потерянный текст'); // файл, которого нет в списке
  i18n.setLang('en');
  try {
    const en = project.openProject(dir);
    assert.equal(en.chapters.find((c) => c.id === id).title, 'Untitled');
    assert.equal(en.characters.find((c) => c.id === cid).title, 'Untitled');
    assert.equal(en.chapters.find((c) => c.id === 'abcdef1234').title, 'Recovered chapter (abcd)');
    project.writeItem(dir, 'character', cid, JSON.stringify({ short: '', aliases: [], fields: [{ name: '', value: 'x' }] }));
    assert.equal(JSON.parse(project.readItem(dir, 'character', cid)).fields[0].name, 'Field');
  } finally {
    i18n.setLang('ru');
  }
  assert.equal(project.openProject(dir).chapters.find((c) => c.id === id).title, 'Untitled', 'сохранённое название остаётся');
});

test('исключения подсветки «Не отмечать здесь» хранятся в проекте и переживают перезапуск', () => {
  const dir = path.join(tmp(), 'Роман');
  const v0 = project.createProject(dir, 'Роман');
  assert.deepEqual(v0.analysisSkip, {});
  const v1 = project.setAnalysisSkip(dir, { adv: ['Вдруг', 'вдруг'], passive: ['был построен'], bogus: ['x'] });
  assert.deepEqual(v1.analysisSkip, { adv: ['вдруг'], passive: ['был построен'] });
  // «перезапуск»: проект открывается заново из файла
  assert.deepEqual(project.openProject(dir).analysisSkip, { adv: ['вдруг'], passive: ['был построен'] });
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
  assert.deepEqual(saved.analysisSkip, { adv: ['вдруг'], passive: ['был построен'] });
  // другие настройки проекта не задеты, пустой набор убирает поле
  project.setProjectGoal(dir, 5000);
  assert.deepEqual(project.openProject(dir).analysisSkip, { adv: ['вдруг'], passive: ['был построен'] });
  project.setAnalysisSkip(dir, {});
  assert.ok(!('analysisSkip' in JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'))));
});

test('заметки: текст, иконка, переименование, порядок, корзина', () => {
  const dir = path.join(tmp(), 'P');
  project.createProject(dir, 'P');
  const a = project.addItem(dir, 'note', null).id;
  const b = project.addItem(dir, 'note', a).id;
  project.writeItem(dir, 'note', a, 'мысль про финал');
  assert.equal(project.readItem(dir, 'note', a), 'мысль про финал');
  assert.equal(project.setItemIcon(dir, 'note', a, '💡').notes[0].icon, '💡');
  assert.equal(project.setItemIcon(dir, 'note', a, '').notes[0].icon, null);
  project.setItemIcon(dir, 'note', a, '📌');
  assert.equal(project.renameItem(dir, 'note', a, 'Финал').notes[0].title, 'Финал');
  assert.deepEqual(project.moveItem(dir, 'note', b, 0).notes.map((n) => n.id), [b, a]);
  const opened = project.openProject(dir);
  assert.equal(opened.notes.find((n) => n.id === a).icon, '📌');

  const after = project.deleteItem(dir, 'note', a);
  assert.deepEqual(after.notes.map((n) => n.id), [b]);
  const trash = fs.readdirSync(path.join(dir, 'Корзина'));
  assert.equal(trash.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, 'Корзина', trash[0]), 'utf8'), 'мысль про финал');
});

test('старые проекты без карточек открываются и получают шаблоны по умолчанию', () => {
  const dir = path.join(tmp(), 'P');
  const p = project.createProject(dir, 'P');
  const file = path.join(dir, 'project.json');
  const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete meta.characters; delete meta.places; delete meta.notes; delete meta.templates;
  fs.writeFileSync(file, JSON.stringify(meta));
  const opened = project.openProject(dir);
  assert.deepEqual(opened.characters, []);
  assert.deepEqual(opened.templates.character, p.templates.character);
});

test('сводка карточек и картинки', () => {
  const dir = path.join(tmp(), 'P');
  project.createProject(dir, 'P');
  const id = project.addItem(dir, 'character', null).id;
  project.renameItem(dir, 'character', id, 'Иван');
  const src = path.join(tmp(), 'pic.png');
  fs.writeFileSync(src, Buffer.from([137, 80, 78, 71]));
  const file = project.addImage(dir, src);
  assert.match(file, /^[a-z0-9]+\.png$/);
  assert.ok(project.readImage(dir, file).startsWith('data:image/png;base64,'));
  assert.throws(() => project.readImage(dir, '../project.json'));
  project.writeItem(dir, 'character', id, JSON.stringify({
    short: '', aliases: ['Ивана', 'Ивану'], ignore: ['ваня'], image: file,
    fields: [{ name: 'Общее описание', value: 'Кузнец.' }],
  }));
  const [it] = project.cardIndex(dir);
  assert.equal(it.title, 'Иван');
  assert.equal(it.short, 'Кузнец.');
  assert.deepEqual(it.aliases, ['Ивана', 'Ивану']);
  assert.deepEqual(it.ignore, ['ваня']);
  assert.equal(it.image, file);
  // чужое имя файла в карточке отбрасывается
  project.writeItem(dir, 'character', id, JSON.stringify({ image: '../../etc/passwd' }));
  assert.equal(project.cardIndex(dir)[0].image, '');
  const bad = path.join(tmp(), 'x.exe');
  fs.writeFileSync(bad, 'x');
  assert.throws(() => project.addImage(dir, bad));
});

test('синопсис, заметки к главе и счёт слов по проекту', () => {
  const dir = path.join(tmp(), 'P');
  project.createProject(dir, 'P');
  const { id } = project.addChapter(dir, null);
  project.writeChapter(dir, id, '# Заглавие\n\nКто-то пришёл домой.');
  project.writeChapterMeta(dir, id, { synopsis: 'Герой возвращается', notes: 'проверить даты' });
  assert.deepEqual(project.readChapterMeta(dir, id), { synopsis: 'Герой возвращается', notes: 'проверить даты' });
  const st = project.projectStats(dir);
  assert.equal(st.chapters.find((c) => c.id === id).words, 4);
  project.writeChapterMeta(dir, id, { synopsis: '', notes: '' });
  assert.deepEqual(project.readChapterMeta(dir, id), { synopsis: '', notes: '' });
  assert.throws(() => project.readChapterMeta(dir, 'abcdef123456'), /не найдена/);
});

test('резервные копии: только при изменениях, с ограничением числа', () => {
  const backup = require('../src/backup');
  const dir = path.join(tmp(), 'P');
  project.createProject(dir, 'P');
  const { id } = project.addChapter(dir, null);
  project.writeChapter(dir, id, 'первая версия');
  const t = (s) => new Date(2026, 0, 1, 10, 0, s);
  const outside = path.join(tmp(), 'копии');
  assert.ok(backup.makeBackup(dir, { now: t(0), root: outside }));
  assert.deepEqual(backup.listBackups(dir, outside).length, 1);
  assert.equal(backup.listBackups(dir).length, 0); // внутри проекта при этом ничего не появилось
  assert.ok(backup.makeBackup(dir, { now: t(1) }));
  assert.equal(backup.makeBackup(dir, { now: t(2) }), null);
  project.writeChapter(dir, id, 'вторая версия');
  assert.ok(backup.makeBackup(dir, { now: t(3), keep: 2 }));
  project.writeChapter(dir, id, 'третья версия');
  assert.ok(backup.makeBackup(dir, { now: t(4), keep: 2 }));
  const list = backup.listBackups(dir);
  assert.equal(list.length, 2);
  assert.equal(fs.readFileSync(path.join(dir, backup.BACKUP_DIR, list[1], 'Главы', `${id}.md`), 'utf8'), 'третья версия');
  assert.ok(!fs.existsSync(path.join(dir, backup.BACKUP_DIR, list[1], backup.BACKUP_DIR)));
});

test('поиск по проекту: главы, карточки, заметки', () => {
  const { searchProject } = require('../src/search');
  const dir = path.join(tmp(), 'P');
  project.createProject(dir, 'P');
  const ch = project.addChapter(dir, null).id;
  project.writeChapter(dir, ch, 'Иван пришёл домой. Потом Иван ушёл.');
  const card = project.addItem(dir, 'character', null).id;
  project.writeItem(dir, 'character', card, JSON.stringify({ short: 'брат Ивана', fields: [] }));
  const note = project.addItem(dir, 'note', null).id;
  project.writeItem(dir, 'note', note, 'ничего');
  const res = searchProject(dir, 'иван');
  assert.equal(res.length, 2);
  assert.equal(res[0].kind, 'chapter');
  assert.equal(res[0].count, 2);
  assert.equal(res[0].snippets[1].n, 1);
  assert.equal(res[0].snippets[0].match, 'Иван');
  assert.equal(res[1].kind, 'character');
  assert.deepEqual(searchProject(dir, 'и'), []);
  assert.deepEqual(searchProject(dir, 'zzz'), []);
});

test('экспорт: markdown, текст, html', () => {
  const { buildExport, mdToHtml } = require('../src/export');
  const dir = path.join(tmp(), 'P');
  const a = project.createProject(dir, 'Книга').chapters[0].id;
  project.renameChapter(dir, a, 'Начало');
  project.writeChapter(dir, a, 'Один **жирный** и *косой* <тег>.\n\n> цитата\n\n- раз\n- два\n\n---\n\nконец');
  const md = buildExport(dir, 'md');
  assert.match(md, /^# Книга/);
  assert.match(md, /## 1\. Начало/);
  const txt = buildExport(dir, 'txt');
  assert.match(txt, /Один жирный и косой <тег>\./);
  assert.match(txt, /\n\*\*\*\n/); // разделитель в тексте: строка ***
  assert.ok(!txt.replace('***', '').includes('**')); // а жирный без звёздочек
  const html = buildExport(dir, 'html');
  assert.match(html, /<strong>жирный<\/strong>/);
  assert.match(html, /<em>косой<\/em>/);
  assert.match(html, /&lt;тег&gt;/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /<li>раз<\/li>/);
  assert.match(html, /<hr>/);
  assert.equal(mdToHtml('# Заг'), '<h2>Заг</h2>');
  assert.throws(() => buildExport(dir, 'exe'));
});

test('цель проекта и данные доски', () => {
  const dir = path.join(tmp(), 'P');
  project.createProject(dir, 'P');
  const a = project.addChapter(dir, null).id;
  project.writeChapter(dir, a, 'раз два три');
  project.writeChapterMeta(dir, a, { synopsis: 'коротко', notes: '' });
  assert.equal(project.setProjectGoal(dir, 80000).projectGoal, 80000);
  assert.equal(project.openProject(dir).projectGoal, 80000);
  assert.equal(project.setProjectGoal(dir, '').projectGoal, null);
  const board = project.boardData(dir);
  const mine = board.find((c) => c.id === a);
  assert.deepEqual([mine.words, mine.synopsis], [3, 'коротко']);
});

test('корзина: удаление, возврат, окончательное удаление, названия «Глава N»', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kab-trash-'));
  project.createProject(dir, 'Т');
  let v = project.openProject(dir);
  assert.equal(v.chapters[0].title, 'Глава 1');
  let res = project.addChapter(dir, null);
  const second = res.id;
  res = project.addChapter(dir, null);
  const third = res.id;
  v = res.project;
  assert.deepEqual(v.chapters.map((c) => c.title), ['Глава 1', 'Глава 2', 'Глава 3']);
  project.writeChapter(dir, second, 'текст второй');
  project.renameChapter(dir, third, 'Финал');
  v = project.deleteChapter(dir, second);
  assert.deepEqual(v.chapters.map((c) => c.title), ['Глава 1', 'Финал']);
  assert.equal(v.trash.length, 1);
  assert.equal(v.trash[0].title, 'Глава 2');
  const back = project.restoreTrash(dir, v.trash[0].tid);
  assert.deepEqual(back.project.chapters.map((c) => c.title), ['Глава 1', 'Глава 2', 'Финал']);
  assert.equal(back.project.trash.length, 0);
  assert.equal(project.readChapter(dir, second), 'текст второй');
  // перетаскивание перенумеровывает стандартные названия
  v = project.moveChapter(dir, second, 0);
  assert.deepEqual(v.chapters.map((c) => c.title), ['Глава 1', 'Глава 2', 'Финал']);
  assert.equal(v.chapters[0].id, second);
  // карточка: возврат со значком
  const card = project.addItem(dir, 'character', null);
  project.setItemIcon(dir, 'character', card.id, '🧙');
  v = project.deleteItem(dir, 'character', card.id);
  assert.equal(v.characters.length, 0);
  const r2 = project.restoreTrash(dir, v.trash[0].tid);
  assert.equal(r2.project.characters[0].icon, '🧙');
  // окончательное удаление убирает файл
  v = project.deleteChapter(dir, third);
  const file = path.join(dir, 'Корзина', fs.readdirSync(path.join(dir, 'Корзина'))[0]);
  assert.ok(fs.existsSync(file));
  v = project.purgeTrash(dir, v.trash[0].tid);
  assert.equal(v.trash.length, 0);
  assert.ok(!fs.existsSync(file));
  v = project.deleteChapter(dir, second);
  v = project.emptyTrash(dir);
  assert.equal(v.trash.length, 0);
});
