'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const project = require('../src/project');
const backup = require('../src/backup');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kabinet-bk-'));

test('copiesToKeep: не более 30 суммарно — 10 последних, по одной за день, затем самые новые', () => {
  const all = [];
  for (let d = 1; d <= 20; d += 1) for (const h of [10, 11]) all.push(`2026-01-${String(d).padStart(2, '0')} ${h}-00-00`);
  const k = backup.copiesToKeep(all);
  assert.equal(k.size, backup.MAX_BACKUPS, 'суммарно не более 30');
  for (const name of all.slice(-10)) assert.ok(k.has(name), `последняя копия не сохранена: ${name}`);
  for (let d = 1; d <= 20; d += 1) assert.ok(k.has(`2026-01-${String(d).padStart(2, '0')} 11-00-00`), `нет самой поздней копии дня ${d}`);
  assert.ok(!k.has('2026-01-01 10-00-00'), 'старая копия сверх предела удаляется');
  assert.equal(backup.copiesToKeep([]).size, 0);
  assert.equal(backup.copiesToKeep(all.slice(0, 8)).size, 8, 'копий меньше предела — сохраняются все');
});

test('резервные копии: копий меньше 30 — сохраняются все, свежая содержит последнюю версию', () => {
  const dir = path.join(tmp(), 'P');
  const p = project.createProject(dir, 'P');
  const id = p.chapters[0].id;
  const root = path.join(tmp(), 'копии');
  const at = (d, h) => new Date(2026, 0, d, h, 0, 0);
  let n = 0;
  for (const [d, h] of [[1, 9], [1, 12], [1, 18], [2, 9], [2, 18], [3, 9], [3, 18]]) {
    n += 1;
    project.writeChapter(dir, id, `версия ${n}`);
    assert.ok(backup.makeBackup(dir, { now: at(d, h), root }));
  }
  const left = backup.listBackups(dir, root);
  assert.equal(left.length, 7, 'копий меньше 30 — все сохранены');
  // самая свежая копия содержит последнюю версию
  assert.equal(fs.readFileSync(path.join(root, left[left.length - 1], 'Главы', `${id}.md`), 'utf8'), 'версия 7');
});

test('резервные копии: не более 30 на проект, только что сделанная копия не удаляется', () => {
  const dir = path.join(tmp(), 'P');
  const p = project.createProject(dir, 'P');
  const id = p.chapters[0].id;
  const root = path.join(tmp(), 'копии');
  for (let i = 0; i < 33; i += 1) {
    project.writeChapter(dir, id, `версия ${i}`);
    assert.ok(backup.makeBackup(dir, { now: new Date(2026, 0, 1 + Math.floor(i / 3), 10, 0, i % 60), root }));
  }
  const left = backup.listBackups(dir, root);
  assert.equal(left.length, backup.MAX_BACKUPS, 'суммарно не более 30');
  assert.equal(fs.readFileSync(path.join(root, left[left.length - 1], 'Главы', `${id}.md`), 'utf8'), 'версия 32', 'самая новая копия не удалена');
});

test('подпись копии: текст сверяется по содержимому, картинки по размеру и времени', () => {
  const dir = path.join(tmp(), 'P');
  const p = project.createProject(dir, 'P');
  const id = p.chapters[0].id;
  const root = path.join(tmp(), 'копии');
  const at = (s) => new Date(2026, 0, 1, 10, 0, s);
  const chapter = path.join(dir, 'Главы', `${id}.md`);
  const img = path.join(dir, 'Картинки', 'abcdef123456.png');
  fs.mkdirSync(path.dirname(img), { recursive: true });
  fs.writeFileSync(img, Buffer.alloc(1000, 1));
  project.writeChapter(dir, id, 'aaaa');
  assert.ok(backup.makeBackup(dir, { now: at(0), root }));
  assert.equal(backup.makeBackup(dir, { now: at(1), root }), null, 'ничего не менялось');

  // текст изменён с тем же размером и тем же временем: всё равно замечен
  const st = fs.statSync(chapter);
  fs.writeFileSync(chapter, 'bbbb');
  fs.utimesSync(chapter, st.atime, st.mtime);
  assert.ok(backup.makeBackup(dir, { now: at(2), root }), 'правка текста замечена');

  // новая картинка (другой размер) замечена
  fs.writeFileSync(img, Buffer.alloc(2000, 2));
  assert.ok(backup.makeBackup(dir, { now: at(3), root }), 'изменение картинки замечено');
  assert.equal(backup.makeBackup(dir, { now: at(4), root }), null);
});
