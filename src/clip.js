'use strict';

// Копирование как обычный текст для сайтов и других программ: разделитель уходит строкой «***», а при режиме
// «Красная строка» перед абзацами ставится длинный пробел (в самом тексте главы он не хранится: Markdown обрезает
// пробельные знаки в начале абзаца). Модуль без редактора, поэтому проверяется тестами (test/clip.test.js).

const INDENT = ' '; // длинный пробел (em space): виден как отступ и копируется на сайты

/**
 * blocks: блоки верхнего уровня выделения [{ kind: 'paragraph' | 'heading' | 'quote' | 'rule' | 'other', text, partial }].
 * partial: абзац взят не с начала (выделение началось посреди него), красная строка перед ним не нужна.
 * Красной строки нет у абзаца сразу после заголовка и цитаты (как в окне), после разделителя она есть.
 * o.indent: ставить красные строки (там, где абзац ещё не начинается с пробела).
 */
function clipboardPlain(blocks, o = {}) {
  const parts = [];
  let skip = false;
  for (const b of blocks) {
    if (b.kind === 'rule') {
      parts.push('***');
      skip = false;
      continue;
    }
    let text = String(b.text || '');
    if (b.kind === 'paragraph') {
      if (o.indent && !skip && !b.partial && /^\S/.test(text)) text = INDENT + text;
      skip = false;
    } else {
      skip = b.kind === 'heading' || b.kind === 'quote';
    }
    parts.push(text);
  }
  return parts.join('\n\n');
}

module.exports = { INDENT, clipboardPlain };
