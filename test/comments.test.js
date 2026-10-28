'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const project = require('../src/project');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kab-cmt-'));
  project.createProject(dir, 'Тест');
  const id = project.openProject(dir).chapters[0].id;
  return { dir, id };
}

test('комментарии: сохраняются в project.json и не трогают синопсис и текст главы', () => {
  const { dir, id } = setup();
  project.writeChapter(dir, id, 'Он вошёл в дом.');
  project.writeChapterMeta(dir, id, { synopsis: 'О доме', notes: 'н' });
  const c = { id: 'a1', text: 'Проверить', quote: 'вошёл', before: 'Он ', after: ' в дом.', pos: 4, ts: '2026-01-01T00:00:00Z' };
  project.writeChapterMeta(dir, id, { comments: [c, { id: '../x', text: 'плохой id' }, null] });
  const meta = project.readChapterMeta(dir, id);
  assert.equal(meta.synopsis, 'О доме');
  assert.equal(meta.notes, 'н');
  assert.deepEqual(meta.comments, [c]);
  assert.equal(project.readChapter(dir, id), 'Он вошёл в дом.'); // Markdown главы без изменений
  // запись синопсиса без поля comments комментарии не стирает
  project.writeChapterMeta(dir, id, { synopsis: 'Новый', notes: '' });
  assert.equal(project.readChapterMeta(dir, id).comments.length, 1);
  // пустой список удаляет поле
  project.writeChapterMeta(dir, id, { comments: [] });
  assert.equal(project.readChapterMeta(dir, id).comments, undefined);
  assert.equal(project.readChapterMeta(dir, id).synopsis, 'Новый');
});

test('комментарии: старый проект без поля открывается, комментарии переживают Корзину', () => {
  const { dir, id } = setup();
  assert.equal(project.readChapterMeta(dir, id).comments, undefined);
  project.addChapter(dir); // чтобы удаляемая глава была не единственной
  project.writeChapterMeta(dir, id, { comments: [{ id: 'b2', text: 'т', quote: 'q' }] });
  const v = project.deleteChapter(dir, id);
  const tid = (v.trash || project.openProject(dir).trash)[0].tid;
  const back = project.restoreTrash(dir, tid);
  const restored = (back.chapters || project.openProject(dir).chapters).map((c) => c.id);
  assert.ok(restored.includes(id));
  assert.equal(project.readChapterMeta(dir, id).comments[0].id, 'b2');
});
