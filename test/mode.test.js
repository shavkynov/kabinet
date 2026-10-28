'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const project = require('../src/project');
const { buildExport } = require('../src/export');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kabinet-mode-')), 'Проект');

test('режим: роман по умолчанию, в project.json поле не пишется', () => {
  const dir = tmp();
  const p = project.createProject(dir, 'Роман');
  assert.equal(p.mode, 'novel');
  assert.equal(p.chapters[0].title, 'Глава 1');
  assert.equal('mode' in JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')), false);
});

test('режим «Рассказы»: создание, названия по умолчанию, переключение туда и обратно', () => {
  const dir = tmp();
  const p = project.createProject(dir, 'Сборник', { mode: 'stories' });
  assert.equal(p.mode, 'stories');
  assert.equal(p.chapters[0].title, 'Рассказ 1');
  project.addChapter(dir);
  let v = project.openProject(dir);
  assert.deepEqual(v.chapters.map((c) => c.title), ['Рассказ 1', 'Рассказ 2']);
  project.renameChapter(dir, v.chapters[1].id, 'Лисья нора');
  v = project.setProjectMode(dir, 'novel');
  assert.equal(v.mode, 'novel');
  assert.deepEqual(v.chapters.map((c) => c.title), ['Глава 1', 'Лисья нора']); // своё название не трогаем
  assert.equal('mode' in JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')), false);
  v = project.setProjectMode(dir, 'stories');
  assert.equal(v.chapters[0].title, 'Рассказ 1');
  assert.equal(project.setProjectMode(dir, 'что угодно').mode, 'novel');
});

test('экспорт рассказов: названия без номеров и содержание; роман: нумерация как раньше', () => {
  const dir = tmp();
  const p = project.createProject(dir, 'Сборник', { mode: 'stories' });
  project.writeChapter(dir, p.chapters[0].id, 'Первый текст.');
  const second = project.addChapter(dir);
  const id2 = project.openProject(dir).chapters[1].id;
  project.renameChapter(dir, id2, 'Лисья нора');
  project.writeChapter(dir, id2, 'Второй текст.');
  void second;
  const md = buildExport(dir, 'md');
  assert.match(md, /## Содержание/);
  assert.match(md, /- Лисья нора/);
  assert.match(md, /## Лисья нора/);
  assert.doesNotMatch(md, /## 2\./);
  const html = buildExport(dir, 'html');
  assert.match(html, /<body class="stories">/);
  assert.match(html, /<nav class="toc">/);
  assert.ok(Buffer.isBuffer(buildExport(dir, 'docx')));

  project.setProjectMode(dir, 'novel');
  const novel = buildExport(dir, 'md');
  assert.match(novel, /## 2\. Лисья нора/);
  assert.doesNotMatch(novel, /Содержание/);
});

test('рассказы: единица цели и лимит знаков хранятся только в этом режиме', () => {
  const dir = tmp();
  project.createProject(dir, 'Сборник', { mode: 'stories' });
  let v = project.openProject(dir);
  assert.equal(v.goalUnit, 'chars'); // по умолчанию знаки
  assert.equal(v.charLimit, null);
  v = project.setCharLimit(dir, '20 000'.replace(' ', ''));
  assert.equal(v.charLimit, 20000);
  v = project.setGoalUnit(dir, 'words');
  assert.equal(v.goalUnit, 'words');
  v = project.setCharLimit(dir, '');
  assert.equal(v.charLimit, null);
  v = project.setCharLimit(dir, 15000);
  v = project.setProjectMode(dir, 'novel'); // в романе поля не действуют
  assert.equal(v.goalUnit, 'words');
  assert.equal(v.charLimit, null);
  assert.equal(project.setCharLimit(dir, 5000).charLimit, null); // в романе лимит не ставится
  v = project.setProjectMode(dir, 'stories'); // а при возврате прежние значения на месте
  assert.equal(v.charLimit, 15000);
  assert.equal(v.goalUnit, 'words');
});

test('знаки с пробелами: разметка и разделители сцен не считаются', () => {
  assert.equal(project.charCount('Один два.'), 9);
  assert.equal(project.charCount('**Один** и *два*.\n\nТри.'), 'Один и два.Три.'.length);
  assert.equal(project.charCount('Первая.\n\n---\n\nВторая.'), 'Первая.Вторая.'.length);
  assert.equal(project.charCount('## Заголовок\n\n> цитата'), 'Заголовокцитата'.length);
  const dir = tmp();
  const p = project.createProject(dir, 'Сборник', { mode: 'stories' });
  project.writeChapter(dir, p.chapters[0].id, 'Раз два три.');
  const st = project.projectStats(dir);
  assert.equal(st.chapters[0].chars, 12);
  assert.equal(st.totalChars, 12);
  assert.equal(st.total, 3);
});
