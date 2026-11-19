'use strict';

// Прямая речь: места, которые принадлежат героям, а не автору (кавычки и реплики после тире).
// Общий модуль: им пользуются проверка времён, слова-паразиты и structural analyzer.
// Тире распознаётся отдельно в каждом абзаце: открытая реплика не продолжается
// на следующий авторский абзац.

/** [[от, до), …] по тексту; offsets глобальные, исходный текст не меняется. */
function speechRanges(text) {
  const out = [];
  const quotes = [];
  for (const m of text.matchAll(/«[^»]*»|„[^“”]*[“”]|“[^”]*”|"[^"]*"/g)) {
    const range = [m.index, m.index + m[0].length];
    quotes.push(range);
    out.push(range);
  }
  const inQuote = (pos) => quotes.some(([a, b]) => pos >= a && pos < b);

  // Абзацы разделяются пустой строкой; одиночный перевод строки остаётся внутри абзаца.
  const spans = [];
  let from = 0;
  for (const m of text.matchAll(/\r?\n[ \t]*\r?\n/g)) {
    spans.push([from, m.index]);
    from = m.index + m[0].length;
  }
  spans.push([from, text.length]);

  for (const [start, end] of spans) {
    if (end <= start) continue;
    const segment = text.slice(start, end);
    const lead = /^\s*[—–]\s*/.exec(segment);
    if (!lead) continue;
    let speech = true;
    let speechFrom = start + lead[0].length;
    for (const m of segment.matchAll(/\s[—–]\s/g)) {
      const globalPos = start + m.index;
      if (inQuote(globalPos)) continue; // тире внутри кавычек не переключает реплику
      const before = segment[m.index - 1];
      if (speech && !/[,.!?…]/.test(before || '')) continue; // тире внутри реплики: «Я — солдат»
      if (speech) out.push([speechFrom, globalPos]);
      speech = !speech;
      speechFrom = globalPos + m[0].length;
    }
    if (speech && speechFrom < end) out.push([speechFrom, end]);
  }
  return out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

module.exports = { speechRanges };
