'use strict';

// Прямая речь: места в абзаце, которые принадлежат героям, а не автору (кавычки и реплики после тире).
// Общий модуль: им пользуются проверка времён и слова-паразиты (в репликах разговорность уместна).

/** [[от, до], …] по тексту абзаца. */
function speechRanges(text) {
  const out = [];
  for (const m of text.matchAll(/«[^»]*»|„[^“”]*[“”]|“[^”]*”|"[^"]*"/g)) out.push([m.index, m.index + m[0].length]);
  const lead = /^\s*[—–]\s*/.exec(text);
  if (lead) {
    let speech = true;
    let from = lead[0].length;
    for (const m of text.matchAll(/\s[—–]\s/g)) {
      const before = text[m.index - 1];
      if (speech && !/[,.!?…]/.test(before || '')) continue; // тире внутри реплики: «Я — солдат»
      if (speech) out.push([from, m.index]);
      speech = !speech;
      from = m.index + m[0].length;
    }
    if (speech) out.push([from, text.length]);
  }
  return out;
}

module.exports = { speechRanges };
