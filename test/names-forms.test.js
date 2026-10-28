'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const project = require('../src/project');
const mentions = require('../src/mentions');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kabinet-forms-'));

function setup() {
  const dir = path.join(tmp(), 'Роман');
  const v = project.createProject(dir, 'Роман');
  return { dir, ch: v.chapters[0].id };
}

function addCard(dir, kind, title, extra = {}) {
  const id = project.addItem(dir, kind).id;
  project.renameItem(dir, kind, id, title);
  project.writeItem(dir, kind, id, JSON.stringify({ short: '', aliases: [], ...extra }));
  return id;
}

test('индекс карточек: падежные формы названия и имён в тексте', () => {
  const { dir } = setup();
  addCard(dir, 'character', 'Анна', { aliases: ['Аня', 'Анны'] });
  addCard(dir, 'place', 'Москва');
  const idx = project.cardIndex(dir);
  const anna = idx.find((c) => c.title === 'Анна');
  assert.equal(anna.inflect, true);
  for (const f of ['Анну', 'Анной', 'Ане', 'Аню']) assert.ok(anna.forms.includes(f), f);
  assert.ok(!anna.forms.includes('Анны'), 'явное имя в формы не входит');
  assert.ok(idx.find((c) => c.title === 'Москва').forms.includes('Москве'));
});

test('отказ от склонения хранится в карточке и отключает формы', () => {
  const { dir } = setup();
  const id = addCard(dir, 'character', 'Мэри', { inflect: false });
  assert.equal(JSON.parse(project.readItem(dir, 'character', id)).inflect, false);
  const e = project.cardIndex(dir).find((c) => c.title === 'Мэри');
  assert.equal(e.inflect, false);
  assert.deepEqual(e.forms, []);
  // по умолчанию в файле поля inflect нет
  const id2 = addCard(dir, 'character', 'Иван');
  assert.ok(!('inflect' in JSON.parse(project.readItem(dir, 'character', id2))));
  assert.equal(project.cardIndex(dir).find((c) => c.title === 'Иван').inflect, true);
});

test('«Встречается в главах»: считает формы, уважает «Не считать ссылкой» и большую букву', () => {
  const { dir, ch } = setup();
  const anna = addCard(dir, 'character', 'Анна', { ignore: ['Анной'] });
  project.writeChapter(dir, ch, 'Анны не было. Он видел Анну и говорил с Анной. Анна ждала.');
  assert.equal(mentions.cardMentions(dir, 'character', anna).chapters[0].count, 3); // Анны, Анну, Анна; «Анной» исключено

  const vera = addCard(dir, 'character', 'Вера');
  project.writeChapter(dir, ch, 'Он верил в веру. Веру он любил. Вера ушла, и вера осталась.');
  // явное имя считается без учёта регистра (как раньше): «Вера», «вера»; форма «Веру» только с большой буквы
  assert.equal(mentions.cardMentions(dir, 'character', vera).chapters[0].count, 3);

  const ivan = addCard(dir, 'character', 'Иван');
  project.writeChapter(dir, ch, 'Иванов пришёл с Иванушкой и Иваном Петровичем.');
  assert.equal(mentions.cardMentions(dir, 'character', ivan).chapters[0].count, 1); // только «Иваном»
});

test('«Встречается в главах»: при отказе от склонения считаются только явные имена', () => {
  const { dir, ch } = setup();
  const id = addCard(dir, 'character', 'Анна', { inflect: false });
  project.writeChapter(dir, ch, 'Анны не было. Анна пришла.');
  assert.equal(mentions.cardMentions(dir, 'character', id).chapters[0].count, 1);
});
