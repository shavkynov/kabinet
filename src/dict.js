'use strict';

// Пользовательский словарь («В словарь» при проверке текста). Слова лежат в project.json проекта и переезжают
// вместе с ним на другие устройства. Общий список настроек (check.json) остаётся: из него начинается словарь проекта,
// у которого своего списка ещё нет, и он же служит словарём до открытия проекта.

const MAX_WORDS = 5000;
const MAX_LEN = 80;

/** Список слов: строки без пробелов по краям, без пустых и повторов, не длиннее MAX_LEN, не больше MAX_WORDS. */
function cleanWords(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const x of raw) {
    const w = typeof x === 'string' ? x.trim() : '';
    if (!w || w.length > MAX_LEN || /[\u0000-\u001f]/.test(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= MAX_WORDS) break;
  }
  return out;
}

/** Какой словарь действует: список проекта, если он есть (даже пустой), иначе общий. */
function effective(projectWords, sharedWords) {
  return Array.isArray(projectWords) ? projectWords : cleanWords(sharedWords);
}

/** Список проекта после добавления слова; если у проекта списка не было, он начинается с общего словаря. */
function withWord(projectWords, sharedWords, word) {
  return cleanWords([...effective(projectWords, sharedWords), word]);
}

/** Общий список после правки словаря проекта: убранные слова уходят, добавленные появляются. Остальное не трогаем. */
function mergeShared(sharedWords, before, next) {
  const gone = new Set(before.filter((w) => !next.includes(w)));
  const fresh = next.filter((w) => !before.includes(w));
  return cleanWords([...cleanWords(sharedWords).filter((w) => !gone.has(w)), ...fresh]);
}

module.exports = { cleanWords, effective, withWord, mergeShared, MAX_WORDS, MAX_LEN };
