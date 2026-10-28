'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isOfficeHtml, officeTextToParagraphs: p } = require('../src/paste');

test('вставка из Word: распознаём офисный HTML, но не буфер самого редактора', () => {
  assert.ok(isOfficeHtml('<html xmlns:o="urn:schemas-microsoft-com:office:office"><p class=MsoNormal>Текст<o:p></o:p></p>'));
  assert.ok(isOfficeHtml('<meta name=ProgId content=Word.Document><p>x</p>'));
  assert.ok(!isOfficeHtml('<p data-pm-slice="1 1 []">Текст</p>'));
  assert.ok(!isOfficeHtml('<p>Обычная страница</p>'));
  assert.ok(!isOfficeHtml(''));
});

test('вставка из Word: абзац на строку, тире сохраняются, пустые строки убираются', () => {
  assert.deepEqual(p('Он вошёл.\r\n\r\n– Привет!\r\n–\tКак дела?\r\n- Нормально.\r\n— Хорошо.\r\n'),
    ['Он вошёл.', '– Привет!', '– Как дела?', '- Нормально.', '— Хорошо.']);
});

test('вставка из Word: мягкие переносы, маркеры списка и мусор', () => {
  assert.deepEqual(p('Строка\u000bвторая третья\r\n·\tпункт\r\n• ещё\r\n   с отступом  \r\n​скрытое'),
    ['Строка', 'вторая', 'третья', 'пункт', 'ещё', 'с отступом', 'скрытое']);
  assert.deepEqual(p(''), []);
  assert.deepEqual(p('Слово - дефис, а не реплика'), ['Слово - дефис, а не реплика']);
});
