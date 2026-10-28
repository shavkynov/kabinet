'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const project = require('../src/project');
const { replaceInText, replaceProject } = require('../src/replace');

test('replaceInText: без учёта регистра, неразрывный пробел, спецсимволы и $ в замене', () => {
  const r = replaceInText('Иван Петров и иван\u00a0петров. Цена (1+1) $&', 'иван петров', 'Пётр $1');
  assert.equal(r.count, 2);
  assert.equal(r.text, 'Пётр $1 и Пётр $1. Цена (1+1) $&');
  assert.equal(replaceInText('a.b axb', 'a.b', 'X').text, 'X axb');
});

test('replaceProject: главы, карточки, заметки; dry ничего не пишет', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kabinet-rep-')), 'Роман');
  const p = project.createProject(dir, 'Роман');
  const ch = p.chapters[0].id;
  project.writeChapter(dir, ch, 'Алиса пришла. Потом Алиса ушла.');
  const cardId = project.addItem(dir, 'character').id;
  project.writeItem(dir, 'character', cardId, JSON.stringify({
    short: 'Алиса, 20 лет', aliases: ['Алиса', 'Алиска'], fields: [{ name: 'Имя', value: 'Алиса' }],
  }));
  const noteId = project.addItem(dir, 'note').id;
  project.writeItem(dir, 'note', noteId, 'Спросить про Алису');

  const dry = replaceProject(dir, 'Алис', 'Лиз', { dry: true });
  assert.equal(dry.total, 7); // глава 2, краткое 1, псевдонимы 2, поле 1, заметка 1
  assert.equal(project.readChapter(dir, ch), 'Алиса пришла. Потом Алиса ушла.');

  const res = replaceProject(dir, 'Алис', 'Лиз');
  assert.equal(res.total, 7);
  assert.equal(project.readChapter(dir, ch), 'Лиза пришла. Потом Лиза ушла.');
  const card = JSON.parse(project.readItem(dir, 'character', cardId));
  assert.equal(card.short, 'Лиза, 20 лет');
  assert.deepEqual(card.aliases, ['Лиза', 'Лизка']);
  assert.equal(card.fields[0].value, 'Лиза');
  assert.equal(project.readItem(dir, 'note', noteId), 'Спросить про Лизу');
  assert.throws(() => replaceProject(dir, 'а', 'б'), /хотя бы два/);
});
