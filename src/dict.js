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

/**
 * Правки словаря на двух устройствах сразу: файлы project.json разошлись, побеждает наш, но добавленные слова
 * не теряем. Возвращает новый текст нашего project.json со словами обеих сторон или null, если сливать нечего.
 * Слово, убранное на одной стороне, при таком слиянии может вернуться: потерять добавленное хуже, убрать ещё раз легко.
 */
function mergeMetaWords(localText, remoteText) {
  let local;
  let remote;
  try {
    local = JSON.parse(Buffer.from(localText).toString('utf8'));
    remote = JSON.parse(Buffer.from(remoteText).toString('utf8'));
  } catch { return null; }
  if (!local || !remote || !Array.isArray(local.words) || !Array.isArray(remote.words)) return null;
  const words = cleanWords([...local.words, ...remote.words]);
  if (words.length === cleanWords(local.words).length && words.every((w) => local.words.includes(w))) return null;
  return Buffer.from(JSON.stringify({ ...local, words }, null, 2), 'utf8');
}

module.exports = { cleanWords, effective, withWord, mergeShared, mergeMetaWords, MAX_WORDS, MAX_LEN };
