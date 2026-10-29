'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { compareVersions, parseRelease } = require('../src/updates');

test('версии: сравнение номеров', () => {
  assert.equal(compareVersions('v0.31.2', '0.31.1'), 1);
  assert.equal(compareVersions('0.31.1', '0.31.1'), 0);
  assert.equal(compareVersions('0.9.0', '0.31.1'), -1);
  assert.equal(compareVersions('1.0', '0.99.9'), 1);
  assert.equal(compareVersions('мусор', '0.31.1'), 0);
});

test('версии: разбор ответа GitHub', () => {
  const r = parseRelease({ tag_name: 'v0.32.0', html_url: 'https://github.com/shavkynov/kabinet/releases/tag/v0.32.0', body: 'Что нового' });
  assert.deepEqual(r, { version: '0.32.0', url: 'https://github.com/shavkynov/kabinet/releases/tag/v0.32.0', notes: 'Что нового' });
  assert.equal(parseRelease({ tag_name: 'v1.0.0', prerelease: true }), null);
  assert.equal(parseRelease({ message: 'Not Found' }), null);
  assert.equal(parseRelease({ tag_name: '0.32.0', html_url: 'http://evil.example/x' }).url, null);
});
