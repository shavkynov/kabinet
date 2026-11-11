'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dict = require('../src/dict');
const project = require('../src/project');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kabinet-dict-'));

test('словарь: чистка списка', () => {
  assert.deepEqual(dict.cleanWords([' Бэла ', 'Бэла', '', 5, null, 'x'.repeat(81), 'a\nb', 'Кабинет']), ['Бэла', 'Кабинет']);
  assert.deepEqual(dict.cleanWords('не список'), []);
  assert.equal(dict.cleanWords(Array.from({ length: 6000 }, (_, i) => `слово${i}`)).length, dict.MAX_WORDS);
});

test('словарь: действует список проекта, пока его нет — общий', () => {
  assert.deepEqual(dict.effective(null, ['а', 'б']), ['а', 'б']);
  assert.deepEqual(dict.effective(['в'], ['а', 'б']), ['в']);
  assert.deepEqual(dict.effective([], ['а', 'б']), []); // пустой список проекта — «слов нет», общий не подмешивается
});

test('словарь: первое добавленное слово начинает список проекта с общего словаря', () => {
  assert.deepEqual(dict.withWord(null, ['а', 'б'], 'в'), ['а', 'б', 'в']);
  assert.deepEqual(dict.withWord(['а'], ['б'], 'в'), ['а', 'в']);
  assert.deepEqual(dict.withWord(['а'], [], 'а'), ['а']);
});

test('словарь: убранное слово уходит и из общего списка, добавленное в него попадает', () => {
  assert.deepEqual(dict.mergeShared(['а', 'б', 'в'], ['а', 'б'], ['б', 'г']), ['б', 'в', 'г']);
});

test('словарь проекта: сохраняется в project.json и переживает переоткрытие', () => {
  const dir = path.join(tmp(), 'Роман');
  project.createProject(dir, 'Роман');
  assert.equal(project.projectWords(dir), null); // у нового проекта списка нет
  project.setProjectWords(dir, ['Бэла', ' Кабинет ', 'Бэла']);
  assert.deepEqual(project.projectWords(dir), ['Бэла', 'Кабинет']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')).words, ['Бэла', 'Кабинет']);
  project.setProjectWords(dir, []); // удаление всех слов тоже доезжает до других устройств
  assert.deepEqual(project.projectWords(dir), []);
  assert.ok('words' in JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')));
});

test('словарь проекта: повреждённое значение в project.json не ломает открытие', () => {
  const dir = path.join(tmp(), 'Роман');
  project.createProject(dir, 'Роман');
  const file = path.join(dir, 'project.json');
  const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
  meta.words = { не: 'список' };
  fs.writeFileSync(file, JSON.stringify(meta));
  assert.equal(project.projectWords(dir), null);
  assert.ok(project.openProject(dir).chapters.length >= 1);
  meta.words = ['ok', 7, ''];
  fs.writeFileSync(file, JSON.stringify(meta));
  assert.deepEqual(project.projectWords(dir), ['ok']);
});

test('словарь проекта: изменения глав и словарь не затирают друг друга', () => {
  const dir = path.join(tmp(), 'Роман');
  const p = project.createProject(dir, 'Роман');
  project.setProjectWords(dir, ['Бэла']);
  project.renameChapter(dir, p.chapters[0].id, 'Начало');
  assert.deepEqual(project.projectWords(dir), ['Бэла']);
  project.setProjectWords(dir, ['Бэла', 'Грушницкий']);
  assert.equal(project.openProject(dir).chapters[0].title, 'Начало');
});
