'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const { mdToHtml, mdToText, chapterTitle } = require('../src/export');
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

test('экспорт: номер перед названием главы не дублируется', () => {
  assert.equal(chapterTitle('Начало', 0), '1. Начало');
  assert.equal(chapterTitle('Глава 1', 0), 'Глава 1');
  assert.equal(chapterTitle('Глава первая', 1), 'Глава первая');
  assert.equal(chapterTitle('~1~', 0), '~1~');
  assert.equal(chapterTitle('2. Ночь', 1), '2. Ночь');
  assert.equal(chapterTitle('Пролог', 0), 'Пролог');
  assert.equal(chapterTitle('Chapter 3', 2), 'Chapter 3');
  assert.equal(chapterTitle('Главный герой', 4), '5. Главный герой'); // «Глава…» только целым словом
  assert.equal(chapterTitle('Часовщик', 0), '1. Часовщик');
});
