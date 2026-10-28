'use strict';

// Типографика (русская; для английского ветка в начале typeChar): «ёлочки» (внутри них „лапки“), тире, многоточие, неразрывные пробелы.
// Модуль без Electron и без редактора: работает с обычными строками, поэтому проверяется тестами.
// typeChar: что сделать, когда автор набрал один символ. fixText: то же для готового текста.

const NB = ' ';

// Короткие слова, после которых пробел делается неразрывным, чтобы они не оставались в конце строки.
const SHORT = new Set([
  'в', 'во', 'к', 'ко', 'с', 'со', 'у', 'о', 'об', 'и', 'а', 'но', 'на', 'не', 'ни', 'за', 'из', 'от', 'до',
  'по', 'без', 'для', 'про', 'при', 'над', 'под', 'или', 'да', 'ли', 'бы', 'же',
]);

const OPEN_CONTEXT = /^$|[\s (\[{—–\-«„]$/;

function quoteDepth(before) {
  let d = 0;
  for (const c of before) {
    if (c === '«' || c === '„') d += 1;
    else if (c === '»' || c === '“') d = Math.max(0, d - 1);
  }
  return d;
}

/**
 * before: текст абзаца до курсора, ch: набранный символ.
 * Возвращает null (оставить как набрано) или { del, ins }: удалить del символов перед курсором
 * и вставить ins вместо набранного символа. opts: { quotes, dashes, nbsp } (по умолчанию всё включено).
 */
function typeChar(before, ch, opts = {}) {
  const o = { quotes: true, dashes: true, nbsp: true, ...opts };

  if (o.lang === 'en') { // английский: “двойные” и ‘одинарные’ кавычки, тире без пробелов, апостроф ’
    if ((ch === '"' || ch === "'") && o.quotes) {
      const open = /^$|[\s (\[{—–\-“‘]$/.test(before.slice(-1));
      if (ch === "'") {
        if (/[\p{L}\p{N}]$/u.test(before)) return { del: 0, ins: '’' }; // don't, John's
        return { del: 0, ins: open ? '‘' : '’' };
      }
      return { del: 0, ins: open ? '“' : '”' };
    }
    if (ch === '-' && o.dashes && before.endsWith('-')) return { del: 1, ins: '—' };
    if (ch === '.' && o.dashes && before.endsWith('..')) return { del: 2, ins: '…' };
    return null;
  }

  const sp = o.nbsp ? NB : ' '; // без неразрывных пробелов текст чище в Word и в онлайн-редакторах

  if (ch === '"' && o.quotes) {
    const d = quoteDepth(before);
    if (OPEN_CONTEXT.test(before.slice(-1))) return { del: 0, ins: d > 0 ? '„' : '«' };
    return { del: 0, ins: d > 1 ? '“' : '»' };
  }

  if (ch === '-' && o.dashes && before.endsWith('-')) {
    if (/[\s ]-$/.test(before)) return { del: 2, ins: `${sp}—` };
    return { del: 1, ins: '—' };
  }

  if (ch === '.' && o.dashes && before.endsWith('..')) return { del: 2, ins: '…' };

  if (ch === ' ') {
    if (o.dashes) {
      if (before === '-') return { del: 1, ins: '— ' }; // начало абзаца: реплика диалога
      if (/[\s ]-$/.test(before)) return { del: 2, ins: `${sp}— ` };
    }
    if (o.nbsp) {
      const m = /(^|[\s (\[«„—–\-])([А-Яа-яЁё]{1,4})$/.exec(before);
      if (m && SHORT.has(m[2].toLowerCase())) return { del: 0, ins: NB };
    }
  }
  return null;
}

/**
 * Прогоняет готовый текст так, будто его набирали по одному символу.
 * Возвращает правки в координатах исходной строки: [{ from, to, text }] (по возрастанию).
 */
function fixText(text, opts = {}) {
  const out = []; // { ch, src }: src = индекс в исходной строке или -1 для вставленного
  let before = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (opts.nbsp === false && ch === NB) { // неразрывные пробелы выключены: готовый текст тоже очищается от них
      out.push({ ch: ' ', src: -1 });
      before += ' ';
      continue;
    }
    const r = typeChar(before, ch, opts);
    if (!r) {
      out.push({ ch, src: i });
      before += ch;
    } else {
      for (let k = 0; k < r.del; k += 1) out.pop();
      for (const c of r.ins) out.push({ ch: c, src: -1 });
      before = before.slice(0, before.length - r.del) + r.ins;
    }
  }
  const edits = [];
  let prevSrc = -1; // последний сохранённый исходный индекс
  let ins = '';
  const flush = (nextSrc) => {
    if (nextSrc - prevSrc > 1 || ins) {
      edits.push({ from: prevSrc + 1, to: nextSrc, text: ins });
    }
    ins = '';
  };
  for (const o of out) {
    if (o.src === -1) { ins += o.ch; continue; }
    flush(o.src);
    prevSrc = o.src;
  }
  flush(text.length);
  return edits.filter((e) => text.slice(e.from, e.to) !== e.text);
}

function applyEdits(text, edits) {
  let s = text;
  for (const e of [...edits].reverse()) s = s.slice(0, e.from) + e.text + s.slice(e.to);
  return s;
}

module.exports = { NB, SHORT, typeChar, fixText, applyEdits };
