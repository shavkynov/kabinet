'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('zlib');
const project = require('../src/project');
const { buildExport, mdToHtml, mdToText, chapterTitle } = require('../src/export');
const { buildDocx, runs } = require('../src/docx');
const { buildRtf } = require('../src/rtf');

// Багрепорт: в экспорте перед «~» оставалась обратная косая: \~1\~ (редактор записывает ~ [ ] ` как \~ \[ \] \`).
const ESC = '\\~1\\~ и \\[скобки\\] и \\`код\\` и 1\\. точка';
const CLEAN = '~1~ и [скобки] и `код` и 1. точка';

test('экспорт: экранирование Markdown не попадает в txt и html', () => {
  assert.equal(mdToText(ESC), CLEAN);
  assert.ok(mdToHtml(ESC).includes(CLEAN));
  assert.ok(!mdToHtml(ESC).includes('\\'));
});

test('экспорт: экранированные &, < и > в html остаются экранированными сущностями', () => {
  assert.equal(mdToHtml('a \\& b \\< c \\> d'), '<p>a &amp; b &lt; c &gt; d</p>');
});

test('экспорт: экранирование не ломает курсив и жирный', () => {
  assert.equal(mdToText('\\*не курсив\\* и *курсив* и **жирный**'), '*не курсив* и курсив и жирный');
});

test('экспорт: docx и rtf без обратной косой', () => {
  assert.equal(runs(ESC).map((r) => r.text).join(''), CLEAN);
  const e = {};
  const buf = buildDocx('Книга', [{ title: '1. Глава', text: ESC }]);
  let p = 0;
  while (buf.readUInt32LE(p) === 0x04034b50) {
    const size = buf.readUInt32LE(p + 18); const n = buf.readUInt16LE(p + 26);
    e[buf.slice(p + 30, p + 30 + n).toString('utf8')] = zlib.inflateRawSync(buf.slice(p + 30 + n, p + 30 + n + size)).toString('utf8');
    p += 30 + n + size;
  }
  assert.ok(e['word/document.xml'].includes(CLEAN) && !e['word/document.xml'].includes('\\~'));
  const rtf = buildRtf('Книга', [{ title: '1. Глава', text: '\\~1\\~' }]);
  assert.ok(String(rtf).includes('~1~') && !String(rtf).includes('\\\\~'));
});

test('экспорт: номер перед названием главы по умолчанию не добавляется', () => {
  assert.equal(chapterTitle('Начало', 0), 'Начало');
  assert.equal(chapterTitle('Глава 1', 0), 'Глава 1');
  assert.equal(chapterTitle('Пролог', 0), 'Пролог');
});

test('экспорт: номер добавляется, если автор включил нумерацию', () => {
  assert.equal(chapterTitle('Начало', 0, true), '1. Начало');
  assert.equal(chapterTitle('Ночь', 4, true), '5. Ночь');
});

test('экспорт проекта: номера глав включаются параметром chapterNumbers', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kab-num-')), 'Роман');
  const created = project.createProject(dir, 'Роман', { mode: 'novel' });
  project.renameChapter(dir, created.chapters[0].id, 'Начало');
  const plain = buildExport(dir, 'md', 'ru');
  assert.ok(plain.includes('## Начало') && !plain.includes('1. Начало'));
  const numbered = buildExport(dir, 'md', 'ru', { chapterNumbers: true });
  assert.ok(numbered.includes('## 1. Начало'));
});

// Выравнивание абзаца: «-> текст <-» по центру, «-> текст ->» по правому краю.
const { splitAlign, stripAlign } = require('../src/align');

test('выравнивание: метки распознаются только в начале и в конце абзаца', () => {
  assert.deepEqual(splitAlign(['-> Глава <-']), { align: 'center', lines: ['Глава'] });
  assert.deepEqual(splitAlign(['-> Эпиграф ->']), { align: 'right', lines: ['Эпиграф'] });
  assert.deepEqual(splitAlign(['-> строка 1', 'строка 2 <-']), { align: 'center', lines: ['строка 1', 'строка 2'] });
  assert.equal(splitAlign(['-> без конца']), null);
  assert.equal(splitAlign(['обычный текст']), null);
  assert.equal(splitAlign(['->  <-']), null);
});

test('выравнивание: html, txt, docx и rtf', () => {
  const md = 'Обычный.\n\n-> По центру <-\n\n-> Справа ->';
  const html = mdToHtml(md);
  assert.ok(html.includes('text-align:center') && html.includes('>По центру</p>'));
  assert.ok(html.includes('text-align:right') && html.includes('>Справа</p>'));
  assert.ok(!/-&gt;|&lt;-/.test(html));
  assert.equal(mdToText(md), 'Обычный.\n\nПо центру\n\nСправа');
  assert.deepEqual(stripAlign(['-> а <-', '', 'б']), ['а', '', 'б']);
  const rtf = buildRtf('Книга', [{ title: 'Глава', text: md }]);
  assert.ok(rtf.includes('\\qc\\fi0') && rtf.includes('\\qr\\fi0'));
  assert.ok(!rtf.includes('<-'));
  const body = require('../src/docx').mdToBody(md);
  assert.ok(body.includes('<w:jc w:val="center"/>') && body.includes('<w:jc w:val="right"/>'));
  assert.ok(!body.includes('&lt;-') && !body.includes('-&gt;'));
});
