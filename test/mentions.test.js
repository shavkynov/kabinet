'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const project = require('../src/project');
const { cardMentions } = require('../src/mentions');

test('cardMentions: главы, псевдонимы, слово целиком, «не считать ссылкой», протагонист', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kabinet-men-')), 'Роман');
  const p = project.createProject(dir, 'Роман');
  const c1 = p.chapters[0].id;
  const c2 = project.addChapter(dir).id;
  project.addChapter(dir);
  project.writeChapter(dir, c1, 'Иван пришёл. Ивана не ждали, а Иванов спал.');
  project.writeChapter(dir, c2, 'Только *Иван* и ваня\u00a0лежали.');
  const id = project.addItem(dir, 'character').id;
  project.renameItem(dir, 'character', id, 'Иван');
  project.writeItem(dir, 'character', id, JSON.stringify({ aliases: ['Ивана', 'Ваня'], ignore: ['ваня'] }));

  let r = cardMentions(dir, 'character', id);
  assert.equal(r.protagonist, false);
  assert.deepEqual(r.chapters.map((c) => [c.n, c.count]), [[1, 2], [2, 1]]);

  project.writeItem(dir, 'character', id, JSON.stringify({ aliases: ['Ивана'], protagonist: true }));
  r = cardMentions(dir, 'character', id);
  assert.equal(r.protagonist, true);
  assert.deepEqual(r.chapters, []);
  assert.equal(project.cardIndex(dir)[0].protagonist, true);
});
