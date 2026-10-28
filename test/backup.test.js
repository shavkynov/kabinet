'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const project = require('../src/project');
const backup = require('../src/backup');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kabinet-bk-'));
const names = (list) => list.map((n) => n.slice(0, 16));

test('copiesToKeep: последние keep штук и последняя копия каждого из keepDays последних дней', () => {
  const all = [
    '2026-01-01 09-00-00', '2026-01-01 18-00-00',
    '2026-01-02 09-00-00', '2026-01-02 18-00-00',
    '2026-01-03 09-00-00', '2026-01-03 18-00-00',
    '2026-01-04 09-00-00', '2026-01-04 18-00-00',
  ];
  const k = backup.copiesToKeep(all, 2, 2);
  // последние две: 04 09, 04 18; по дню: 04 18, 03 18
  assert.deepEqual([...k].sort(), ['2026-01-03 18-00-00', '2026-01-04 09-00-00', '2026-01-04 18-00-00']);
  const k2 = backup.copiesToKeep(all, 3, 3);
  // последние три: 03 18, 04 09, 04 18; по дню: 04 18, 03 18, 02 18
  assert.deepEqual([...k2].sort(), ['2026-01-02 18-00-00', '2026-01-03 18-00-00', '2026-01-04 09-00-00', '2026-01-04 18-00-00']);
  assert.equal(backup.copiesToKeep(all, 1, 0).size, 1, 'без дневных копий работает как раньше');
  assert.equal(backup.copiesToKeep([], 5, 5).size, 0);
});

test('резервные копии: старые дни остаются по одной копии, свежая никогда не удаляется', () => {
  const dir = path.join(tmp(), 'P');
  const p = project.createProject(dir, 'P');
  const id = p.chapters[0].id;
  const root = path.join(tmp(), 'копии');
  const at = (d, h) => new Date(2026, 0, d, h, 0, 0);
  let n = 0;
  for (const [d, h] of [[1, 9], [1, 12], [1, 18], [2, 9], [2, 18], [3, 9], [3, 18]]) {
    n += 1;
    project.writeChapter(dir, id, `версия ${n}`);
    assert.ok(backup.makeBackup(dir, { now: at(d, h), keep: 2, keepDays: 3, root }));
  }
  const left = backup.listBackups(dir, root);
  assert.deepEqual(names(left), ['2026-01-01 18-00', '2026-01-02 18-00', '2026-01-03 09-00', '2026-01-03 18-00']);
  // самая свежая копия содержит последнюю версию
  assert.equal(fs.readFileSync(path.join(root, left[left.length - 1], 'Главы', `${id}.md`), 'utf8'), 'версия 7');
  // даже при keep: 0 только что сделанная копия остаётся
  project.writeChapter(dir, id, 'версия 8');
  const made = backup.makeBackup(dir, { now: at(4, 9), keep: 0, keepDays: 0, root });
  assert.deepEqual(backup.listBackups(dir, root), [made]);
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
