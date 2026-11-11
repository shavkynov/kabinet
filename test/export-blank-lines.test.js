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


{
  const { mdToHtml } = require('../src/export');
  const { mdToBody, buildDocx } = require('../src/docx');
  const { mdToRtf, buildRtf } = require('../src/rtf');
  const { exportLines } = require('../src/export-spacing');
  const zlib = require('node:zlib');
  const emptyHtml = '<p class="empty-line" style="margin:0;text-indent:0"><br></p>';
  const emptyRtf = mdToRtf('A\n\n\nB').split('\n')[1] + '\n';
  const occurrences = (text, needle) => text.split(needle).length - 1;
  const docXml = (zip) => {
    let pos = 0;
    while (zip.readUInt32LE(pos) === 0x04034b50) {
      const size = zip.readUInt32LE(pos + 18);
      const n = zip.readUInt16LE(pos + 26);
      const extra = zip.readUInt16LE(pos + 28);
      const name = zip.subarray(pos + 30, pos + 30 + n).toString();
      const start = pos + 30 + n + extra;
      if (name === 'word/document.xml') return zlib.inflateRawSync(zip.subarray(start, start + size)).toString();
      pos = start + size;
    }
    throw new Error('word/document.xml not found');
  };
  test('spacing helper distinguishes separators from extra blank lines', () => {
    assert.deepEqual(exportLines('A\n\nB'), ['A', '', 'B']);
    assert.deepEqual(exportLines('\nA\n\n\nB\n\n'), ['A', '', null, 'B']);
    assert.deepEqual(exportLines('  \n\n'), []);
  });
  for (const count of [0, 1, 2, 3]) {
    test(`HTML DOCX RTF preserve ${count} extra empty paragraphs`, () => {
      const md = 'A' + '\n'.repeat(count + 2) + 'B';
      assert.equal(occurrences(mdToHtml(md), emptyHtml), count);
      assert.equal(occurrences(mdToBody(md), '<w:p></w:p>'), count);
      assert.equal(occurrences(mdToRtf(md), emptyRtf), count);
      assert.equal(occurrences(docXml(buildDocx('Book', [{ title: 'Chapter', text: md }])), '<w:p></w:p>'), count);
      assert.equal(occurrences(buildRtf('Book', [{ title: 'Chapter', text: md }]), emptyRtf), count);
    });
  }
  test('extra blanks around headings quotes lists rules and alignment; CRLF', () => {
    for (const block of ['# Heading', '> Quote', '- Item', '1. Item', '***', '-> Center <-', '-> Right ->']) {
      const md = block + '\r\n\r\n \t\r\n\r\nB';
      assert.equal(occurrences(mdToHtml(md), emptyHtml), 2, block);
      assert.equal(occurrences(mdToBody(md), '<w:p></w:p>'), 2, block);
      assert.equal(occurrences(mdToRtf(md), emptyRtf), 2, block);
    }
    assert.equal(mdToHtml('A\n\nB'), '<p>A</p>\n<p>B</p>');
    assert.equal(mdToBody('A\n\nB'), mdToBody('\n\nA\n\nB\n\n'));
    assert.equal(mdToRtf('A\n\nB'), mdToRtf('\n\nA\n\nB\n\n'));
    assert.equal(mdToHtml('A\nB'), '<p>A<br>B</p>');
  });
  test('whole project HTML and Markdown preserve internal spacing; source untouched', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kab-spacing-'));
    try {
      const p = project.createProject(root, 'Book');
      const id = p.chapters[0].id;
      project.writeChapter(root, id, 'A\n\n\n\n\nB');
      const before = project.readChapter(root, id);
      assert.equal(occurrences(buildExport(root, 'html', 'ru'), emptyHtml), 3);
      assert.ok(buildExport(root, 'md', 'ru').includes('A\n\n\n\n\nB'));
      assert.equal(project.readChapter(root, id), before);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}
