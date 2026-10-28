'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const project = require('../src/project');
const { buildExport } = require('../src/export');

test('экспорт в Markdown и текст: неразрывные пробелы заменены обычными', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kab-nbsp-'));
  project.createProject(dir, 'Тест');
  const id = project.openProject(dir).chapters[0].id;
  project.writeChapter(dir, id, 'Он вошёл в дом.');
  assert.ok(!buildExport(dir, 'md', 'ru').includes(' '));
  assert.ok(!buildExport(dir, 'txt', 'ru').includes(' '));
  assert.ok(buildExport(dir, 'md', 'ru').includes('Он вошёл в дом.'));
  assert.equal(project.readChapter(dir, id), 'Он вошёл в дом.'); // сама глава не тронута
});
