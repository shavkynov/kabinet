'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { mdToText, buildExport } = require('../src/export');
const { INDENT } = require('../src/clip');
const project = require('../src/project');
for (const count of [1, 2, 3]) {
  test(`TXT preserves ${count} internal empty lines`, () => {
    const gap = '\n'.repeat(count + 1);
    assert.equal(mdToText(`Первый${gap}Второй`), `Первый${gap}Второй`);
    assert.equal(mdToText(`Первый${gap}Второй`, { indent: true }), `${INDENT}Первый${gap}${INDENT}Второй`);
  });
}
test('TXT normalizes CRLF without collapsing spacing or losing formatting text', () => {
  assert.equal(mdToText('**Первый**\r\n\r\n\r\n*Второй*'), 'Первый\n\n\nВторой');
  assert.equal(mdToText('\n\nПервый\n\n\nВторой\n\n'), 'Первый\n\n\nВторой');
});
test('whole-project TXT export preserves internal spacing without changing chapter file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kab-blank-'));
  try {
    const dir = path.join(root, 'Роман');
    const p = project.createProject(dir, 'Роман', { mode: 'novel' });
    const id = p.chapters[0].id;
    project.writeChapter(dir, id, 'Первый\n\n\n\nВторой');
    const before = project.readChapter(dir, id);
    assert.ok(buildExport(dir, 'txt', 'ru').includes('Первый\n\n\n\nВторой'));
    assert.equal(project.readChapter(dir, id), before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
