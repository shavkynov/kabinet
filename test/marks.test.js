'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { scanMarks } = require('../src/marks');

test('скрытые символы: неразрывные пробелы, табуляция, мягкий перенос', () => {
  const nb = String.fromCharCode(0xa0), shy = String.fromCharCode(0xad);
  assert.deepStrictEqual(scanMarks(`а${nb}б\tв${shy}`, false), [
    { at: 1, cls: 'mk-nb' }, { at: 3, cls: 'mk-tab' }, { at: 5, cls: 'mk-shy' },
  ]);
});

test('скрытые символы: обычные пробелы только по запросу', () => {
  assert.equal(scanMarks('а б', false).length, 0);
  assert.deepStrictEqual(scanMarks('а б', true), [{ at: 1, cls: 'mk-sp' }]);
});
