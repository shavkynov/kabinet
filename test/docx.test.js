'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const { buildDocx, mdToBody, runs } = require('../src/docx');

function entries(buf) {
  const out = {};
  let p = 0;
  while (buf.readUInt32LE(p) === 0x04034b50) {
    const size = buf.readUInt32LE(p + 18);
    const n = buf.readUInt16LE(p + 26);
    const name = buf.slice(p + 30, p + 30 + n).toString('utf8');
    out[name] = zlib.inflateRawSync(buf.slice(p + 30 + n, p + 30 + n + size)).toString('utf8');
    p += 30 + n + size;
  }
  return out;
}

test('docx: архив читается, части на месте, русский текст и спецсимволы', () => {
  const buf = buildDocx('Книга & «Роман»', [{ title: '1. Начало', text: 'Он **вошёл** и *сел* <b>.\n\n> Цитата\n\n---\n\n- пункт' }]);
  const e = entries(buf);
  assert.deepEqual(Object.keys(e), ['[Content_Types].xml', '_rels/.rels', 'word/_rels/document.xml.rels', 'word/styles.xml', 'word/document.xml']);
  const d = e['word/document.xml'];
  assert.ok(d.includes('Книга &amp; «Роман»') && d.includes('&lt;b&gt;') && d.includes('<w:b/>') && d.includes('<w:i/>'));
  assert.ok(d.includes('Quote') && d.includes('Separator') && d.includes('— пункт') && d.includes('pageBreakBefore'));
});

test('docx: разбор выделения', () => {
  assert.deepEqual(runs('a **b** *c* snake_case \\*x').map((r) => [r.text, !!r.b, !!r.i]),
    [['a ', false, false], ['b', true, false], [' ', false, false], ['c', false, true], [' snake_case *x', false, false]]);
  assert.ok(mdToBody('# Заголовок').includes('Heading2'));
});
