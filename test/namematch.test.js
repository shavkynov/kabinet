'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { nameRegex, alternation, isCapital } = require('../src/namematch');

function all(re, text) {
  re.lastIndex = 0;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) { if (m[0]) out.push(m[0]); else re.lastIndex += 1; }
  return out;
}

test('сопоставитель: находит слова целиком, самые длинные имена первыми, без учёта регистра', () => {
  const re = nameRegex(['анна', 'анны', 'красная поляна', 'красная', 'ли', 'санкт-петербург']);
  assert.deepEqual(all(re, 'Анны не было. АННА видела Красная Поляна и красная роза. Ли ушёл из Санкт-Петербург.'),
    ['Анны', 'АННА', 'Красная Поляна', 'красная', 'Ли', 'Санкт-Петербург']);
  assert.deepEqual(all(re, 'Аннушка, Анненский, Лиловый'), [], 'часть слова не считается');
  assert.equal(nameRegex([]), null);
});

test('сопоставитель: дерево префиксов даёт те же совпадения, что обычное перечисление, и не тормозит на сотнях форм', () => {
  const words = [];
  for (let i = 0; i < 400; i += 1) words.push(`имя${i.toString(36)}а`, `имя${i.toString(36)}ой`, `имя${i.toString(36)}`);
  const fast = nameRegex(words);
  const slow = new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.sort((a, b) => b.length - a.length).join('|')})(?![\\p{L}\\p{N}])`, 'giu');
  const text = Array.from({ length: 6000 }, (_, i) => (i % 7 === 0 ? `имя${(i % 400).toString(36)}ой` : 'слово')).join(' ');
  const t0 = Date.now();
  const a = all(fast, text);
  const fastMs = Date.now() - t0;
  assert.deepEqual(a, all(slow, text));
  assert.ok(a.length > 800);
  assert.ok(fastMs < 500, `на 6000 слов ушло ${fastMs} мс`);
  assert.ok(alternation(['ab', 'a']).includes('?'), 'префикс-слово сохраняется как необязательное продолжение');
});

test('сопоставитель: признак «слово с большой буквы»', () => {
  assert.ok(isCapital('Анны') && isCapital('Ёж'));
  assert.ok(!isCapital('анны') && !isCapital(''));
});
