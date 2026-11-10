'use strict';

// Выравнивание абзаца в Markdown главы: «-> текст <-» по центру, «-> текст ->» по правому краю.
// Метки стоят в начале и в конце абзаца; без выравнивания абзац записывается как обычно.

/** lines: строки одного абзаца. Возвращает { align: 'center' | 'right', lines } без меток или null. */
function splitAlign(lines) {
  if (!lines.length) return null;
  if (lines.length === 1) {
    const m = /^->\s+(\S.*?)\s+(<-|->)$/.exec(lines[0]);
    return m ? { align: m[2] === '<-' ? 'center' : 'right', lines: [m[1]] } : null;
  }
  const first = lines[0];
  const last = lines[lines.length - 1];
  if (!/^->\s/.test(first)) return null;
  const tail = /\s(<-|->)$/.exec(last);
  if (!tail) return null;
  const out = lines.slice();
  out[0] = out[0].replace(/^->\s+/, '');
  out[out.length - 1] = out[out.length - 1].replace(/\s+(<-|->)$/, '');
  return { align: tail[1] === '<-' ? 'center' : 'right', lines: out };
}

/** Строки всей главы без меток выравнивания (для txt, где выравнивать нечем). */
function stripAlign(lines) {
  const out = [];
  let block = [];
  const flush = () => {
    const al = splitAlign(block);
    out.push(...(al ? al.lines : block));
    block = [];
  };
  for (const line of lines) {
    if (/^\s*$/.test(line)) { flush(); out.push(line); } else block.push(line);
  }
  flush();
  return out;
}

module.exports = { splitAlign, stripAlign };
