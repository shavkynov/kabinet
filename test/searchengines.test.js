'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ENGINES, isEngine, searchUrl } = require('../src/searchengines');

test('поиск: адреса и кодирование слова', () => {
  assert.equal(searchUrl('google', 'Лунный амулет', 'ru'), 'https://www.google.com/search?q=%D0%9B%D1%83%D0%BD%D0%BD%D1%8B%D0%B9%20%D0%B0%D0%BC%D1%83%D0%BB%D0%B5%D1%82');
  assert.ok(searchUrl('yandex', 'слово', 'ru').startsWith('https://yandex.ru/search/?text='));
  assert.ok(searchUrl('wikipedia', 'sword', 'en').startsWith('https://en.wikipedia.org/'));
  assert.ok(searchUrl('wikipedia', 'меч', 'ru').startsWith('https://ru.wikipedia.org/'));
});

test('поиск: пустое слово, неизвестная система, чужие знаки', () => {
  assert.equal(searchUrl('google', '   ', 'ru'), null);
  assert.ok(searchUrl('evil', 'слово', 'ru').startsWith('https://www.google.com/'));
  assert.ok(!isEngine('evil') && isEngine('bing'));
  assert.ok(searchUrl('bing', 'a&b=c#d', 'en').endsWith('a%26b%3Dc%23d'));
});

test('поиск: все системы есть в списке настроек', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  for (const e of ENGINES) assert.ok(html.includes(`<option value="${e.id}">`), e.id);
});
