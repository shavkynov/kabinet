'use strict';

// Поиск в тексте одного абзаца в режиме «В главе»: поддерживает односимвольные запросы (например, `[`),
// учёт регистра и поиск слова целиком. Возвращает UTF-16 позиции [{ start, end }] для ProseMirror.

const WORD_CHAR = /[\p{L}\p{N}_]/u;

function findInText(rawText, query, opts = {}) {
  const q = String(query || '');
  if (!q || !rawText) return [];
  const matchCase = !!opts.matchCase;
  const wholeWord = !!opts.wholeWord;

  const base = q.includes('\u00a0') ? rawText : rawText.replace(/\u00a0/g, ' ');
  const needle = matchCase ? q : q.toLowerCase();
  const hay = matchCase ? base : base.toLowerCase();
  const step = Math.max(1, needle.length);

  // Редкий случай (например, турецкая İ): пересчитываем смещение символов только при расхождении длины.
  let charToRaw = null;
  if (!matchCase && hay.length !== base.length) {
    charToRaw = [0];
    let pos = 0;
    for (const ch of base) {
      const lowLen = ch.toLowerCase().length;
      for (let k = 1; k < lowLen; k += 1) charToRaw.push(pos);
      pos += ch.length;
      charToRaw.push(pos);
    }
  }

  const checkLeft = WORD_CHAR.test(needle[0]);
  const checkRight = WORD_CHAR.test(needle[needle.length - 1]);
  const hits = [];
  let from = 0;
  for (;;) {
    const idx = hay.indexOf(needle, from);
    if (idx < 0) break;
    const endIdx = idx + needle.length;
    const okLeft = !wholeWord || !checkLeft || idx === 0 || !WORD_CHAR.test(hay[idx - 1]);
    const okRight = !wholeWord || !checkRight || endIdx >= hay.length || !WORD_CHAR.test(hay[endIdx]);
    if (okLeft && okRight) {
      const start = charToRaw ? charToRaw[idx] : idx;
      const end = charToRaw ? charToRaw[endIdx] : endIdx;
      hits.push({ start, end });
    }
    from = idx + step;
  }
  return hits;
}

module.exports = { findInText };
