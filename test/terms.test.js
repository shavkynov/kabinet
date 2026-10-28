'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { STORY, termize, cleanMode, authorSheets } = require('../src/terms');

const ROOT = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function sources() {
  const out = [read('renderer/index.html'), read('main.js'), read('src/project.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'renderer/app'))) out.push(read(`renderer/app/${f}`));
  for (const f of ['lists.js', 'cards.js', 'analysis.js']) out.push(read(`renderer/${f}`));
  return out.join('\n');
}

test('термины рассказов: каждая строка словаря есть в коде или разметке (словарь не устаревает)', () => {
  const all = sources();
  const missing = Object.keys(STORY).filter((k) => !all.includes(k.replace(/\\/g, '\\\\')) && !all.includes(k));
  assert.deepEqual(missing, []);
});

test('termize: роман без изменений, рассказы подменяют слова', () => {
  assert.equal(termize('Список глав', 'novel'), 'Список глав');
  assert.equal(termize('Список глав', 'stories'), 'Список рассказов');
  assert.equal(termize('Нет такой строки', 'stories'), 'Нет такой строки');
  assert.equal(termize('Глава {0}', 'stories'), 'Рассказ {0}');
  assert.equal(cleanMode('что угодно'), 'novel');
});

test('авторские листы: 40 000 знаков с пробелами', () => {
  assert.equal(authorSheets(40000), 1);
  assert.equal(authorSheets(8000), 0.2);
  assert.equal(authorSheets(0), 0);
});
