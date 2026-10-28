'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createTranslator } = require('../src/i18n');
const EN = require('../src/i18n-en');
const scan = require('../scripts/i18n-scan');

const slots = (s) => [...s.matchAll(/\{(\d+)\}/g)].map((m) => m[1]).sort().join(',');

test('словарь: {0} в переводе совпадают с оригиналом', () => {
  for (const [ru, en] of Object.entries(EN)) {
    assert.equal(slots(en), slots(ru), `не совпадают подстановки: ${ru}`);
    assert.ok(en.trim(), `пустой перевод: ${ru}`);
    assert.ok(!/[А-Яа-яЁё]{4,}/.test(en.replace(/“[^”]*”/g, '')), `в переводе осталась кириллица: ${ru}`);
  }
});

test('все русские строки в коде есть в словаре', () => {
  const missing = [...scan.collect().keys()].filter((k) => EN[k] === undefined);
  assert.deepEqual(missing, []);
});

test('перевод: точные строки, шаблоны, русский режим', () => {
  const en = createTranslator('en');
  const ru = createTranslator('ru');
  assert.equal(en('Сохранено'), 'Saved');
  assert.equal(en('Удалить главу «{0}»?', 'Тест'), 'Delete the chapter “Тест”?');
  assert.equal(en.dom('Удалить главу «Моя глава»?'), 'Delete the chapter “Моя глава”?');
  assert.equal(en.dom('Выделено: 12 words'), 'Selected: 12 words');
  assert.equal(en.dom('Никакой такой строки'), null);
  assert.equal(ru('Удалить главу «{0}»?', 'Тест'), 'Удалить главу «Тест»?');
  assert.equal(ru.dom('Сохранено'), null);
});

test('шаблоны не перехватывают чужие строки', () => {
  const en = createTranslator('en');
  assert.equal(en.dom('Глава 5'), 'Chapter 5');
  assert.equal(en.dom('Просто текст пользователя'), null);
  assert.equal(en.dom('Мои заметки о людях'), null);
});
