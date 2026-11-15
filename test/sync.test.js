'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const project = require('../src/project');

function mk() {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kabinet-sync-')), 'Роман');
  const p = project.createProject(dir, 'Роман');
  return { dir, id: p.chapters[0].id };
}

test('запись главы: чужая правка на диске не пропадает, а уходит в «Конфликты»', () => {
  const { dir, id } = mk();
  project.writeChapter(dir, id, 'моя версия 1');
  assert.equal(project.readChapter(dir, id), 'моя версия 1');
  // облако принесло другую версию, пока глава была открыта
  const file = path.join(dir, 'Главы', `${id}.md`);
  fs.writeFileSync(file, 'версия с другого устройства');
  const res = project.writeChapter(dir, id, 'моя версия 2');
  assert.ok(res.conflict, 'конфликт обнаружен');
  const saved = fs.readFileSync(path.join(dir, 'Конфликты', res.conflict), 'utf8');
  assert.equal(saved, 'версия с другого устройства');
  assert.equal(fs.readFileSync(file, 'utf8'), 'моя версия 2');
  // дальше всё как обычно
  assert.equal(project.writeChapter(dir, id, 'моя версия 3').conflict, null);
});

test('запись главы: свои записи и одинаковый текст конфликтом не считаются', () => {
  const { dir, id } = mk();
  project.readChapter(dir, id);
  assert.equal(project.writeChapter(dir, id, 'a').conflict, null);
  assert.equal(project.writeChapter(dir, id, 'b').conflict, null);
  fs.writeFileSync(path.join(dir, 'Главы', `${id}.md`), 'c');
  assert.equal(project.writeChapter(dir, id, 'c').conflict, null); // на диске уже то же самое
  assert.equal(fs.existsSync(path.join(dir, 'Конфликты')), false);
});

test('карточка: тоже защищена от затирания', () => {
  const { dir } = mk();
  const id = project.addItem(dir, 'character').id;
  project.readItem(dir, 'character', id);
  fs.writeFileSync(path.join(dir, 'Персонажи', `${id}.json`), JSON.stringify({ short: 'чужое' }));
  const res = project.writeItem(dir, 'character', id, JSON.stringify({ short: 'моё' }));
  assert.ok(res.conflict);
  assert.match(res.conflict, /\.json$/);
});

test('массовые чтения (статистика, поиск, карточки, упоминания) не отключают защиту от затирания', () => {
  const { dir, id } = mk();
  const search = require('../src/search');
  const mentions = require('../src/mentions');
  const file = path.join(dir, 'Главы', `${id}.md`);
  const readers = {
    projectStats: () => project.projectStats(dir),
    boardData: () => project.boardData(dir),
    search: () => search.searchProject(dir, 'текст'),
    mentions: () => mentions.cardMentions(dir, 'character', project.addItem(dir, 'character', null).id),
  };
  for (const [name, bulk] of Object.entries(readers)) {
    fs.writeFileSync(file, 'исходный текст');
    project.readChapter(dir, id); // окно открыло главу
    fs.writeFileSync(file, 'правка с другого устройства'); // облако подменило файл
    bulk(); // что-то прочитало все главы
    const res = project.writeChapter(dir, id, 'моя правка'); // автосохранение окна
    assert.ok(res.conflict, `${name}: конфликт должен быть замечен`);
    assert.equal(fs.readFileSync(path.join(dir, 'Конфликты', res.conflict), 'utf8'), 'правка с другого устройства', name);
    fs.rmSync(path.join(dir, 'Конфликты'), { recursive: true, force: true });
  }
});

test('массовое чтение карточек (cardIndex) не отключает защиту открытой карточки', () => {
  const { dir } = mk();
  const cid = project.addItem(dir, 'character', null).id;
  const file = path.join(dir, 'Персонажи', `${cid}.json`);
  const card = (short) => JSON.stringify({ short, aliases: [], ignore: [], image: '', fields: [], protagonist: false });
  project.writeItem(dir, 'character', cid, card('моя 1'));
  project.readItem(dir, 'character', cid); // карточка открыта
  fs.writeFileSync(file, card('чужая'));
  project.cardIndex(dir); // индекс для автоссылок читает все карточки
  const res = project.writeItem(dir, 'character', cid, card('моя 2'));
  assert.ok(res.conflict, 'конфликт должен быть замечен');
});

test('обычное чтение для открытия по-прежнему запоминает версию файла', () => {
  const { dir, id } = mk();
  const file = path.join(dir, 'Главы', `${id}.md`);
  fs.writeFileSync(file, 'версия A');
  project.readChapter(dir, id);
  // автор открыл главу после внешней правки: своя версия, конфликта нет
  fs.writeFileSync(file, 'версия B');
  project.readChapter(dir, id);
  assert.equal(project.writeChapter(dir, id, 'версия C').conflict, null);
});

