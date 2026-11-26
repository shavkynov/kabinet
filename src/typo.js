'use strict';

// Типографика (русская; для английского ветка в начале typeChar): «ёлочки» (внутри них „лапки“), тире, многоточие, неразрывные пробелы.
// Модуль без редактора: работает с обычными строками, поэтому проверяется тестами.
// typeChar: что сделать, когда автор набрал один символ. fixText: то же для готового текста.

const NB = ' ';

// Короткие слова, после которых пробел делается неразрывным, чтобы они не оставались в конце строки.
const SHORT = new Set([
  'в', 'во', 'к', 'ко', 'с', 'со', 'у', 'о', 'об', 'и', 'а', 'но', 'на', 'не', 'ни', 'за', 'из', 'от', 'до',
  'по', 'без', 'для', 'про', 'при', 'над', 'под', 'или', 'да', 'ли', 'бы', 'же',
]);

const OPEN_CONTEXT = /^$|[\s (\[{—–\-«„]$/;

const KNOWN_ABBR = new Set([
  'dr', 'mr', 'mrs', 'ms', 'prof', 'st', 'vs', 'etc', 'eg', 'ie', 'jr', 'sr',
  'inc', 'ltd', 'corp', 'fig', 'no', 'vol', 'ch', 'pp', 'ed', 'eds', 'al',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'др', 'пр', 'см', 'ср', 'напр', 'стр', 'ст', 'рис', 'табл',
  'гл', 'разд', 'им', 'ул', 'пер', 'пр-т', 'просп', 'пл', 'наб', 'бул',
  'обл', 'р-н', 'пос', 'дер', 'гор', 'тыс', 'млн', 'млрд', 'руб', 'коп',
  'долл', 'экз', 'шт', 'кг', 'гг', 'вв', 'нэ', 'доц', 'проф', 'акад',
  'инж', 'тов', 'гр', 'тел', 'факс', 'кв', 'корп', 'эт', 'оф', 'мин',
  'сек', 'час', 'суб', 'вс', 'пн', 'вт', 'чт', 'пт', 'сб', 'янв', 'фев',
  'мар', 'апр', 'июн', 'июл', 'авг', 'сен', 'сент', 'окт', 'ноя', 'дек',
  'изд', 'ред', 'сост', 'прим', 'лат', 'греч', 'англ', 'нем', 'фр', 'рус',
  'устар', 'разг', 'книжн', 'перен',
]);

function endsWithSentencePunct(s) {
  const trimmed = s.replace(/[»”’"']+$/u, '');
  if (!trimmed || /[)\]]$/.test(trimmed)) return false;
  if (trimmed.endsWith('…') || trimmed.endsWith('..')) return false;
  const last = trimmed[trimmed.length - 1];
  if (last === '!' || last === '?') return true;
  if (last !== '.') return false;
  const beforeDot = trimmed.slice(0, -1);
  if (/\d$/.test(beforeDot)) return false;
  const m = /([\p{L}-]+)$/u.exec(beforeDot);
  if (!m || m[1].length <= 1) return false;
  return !KNOWN_ABBR.has(m[1].toLowerCase());
}

/**
 * Стоит ли курсор (текст до него = before) в начале нового предложения, где строчную букву надо сделать заглавной.
 * Повторяет логику офлайн-проверки (desktop/core/src/offline_spell.rs): не трогает многоточия, «1. пункт», «т. е.», «— сказал он».
 */
function isSentenceStartForTyping(before) {
  const afterOpen = before.replace(/[\s\u00a0«„“‘"'(\[]+$/u, '');
  if (afterOpen.endsWith('…') || afterOpen.endsWith('..')) return false;

  const trailing = before.slice(afterOpen.length);
  const headCheck = afterOpen.replace(/[\s\u00a0—–\-•*]+$/u, '');
  if (!headCheck) {
    return !afterOpen || /[\s\u00a0]/u.test(trailing);
  }

  const beforeDash = afterOpen.replace(/[—–]+$/u, '');
  const hadDash = beforeDash.length < afterOpen.length && /[\s\u00a0]$/u.test(beforeDash);
  if (hadDash) {
    if (!/[\s\u00a0]/u.test(trailing)) return false;
    const prev = beforeDash.replace(/[\s\u00a0]+$/u, '');
    const clean = prev.replace(/[»”’"']+$/u, '');
    if (clean.endsWith('!') || clean.endsWith('?') || clean.endsWith('…') || clean.endsWith('..')) return false;
    return endsWithSentencePunct(prev);
  }

  if (!/[\s\u00a0]/u.test(trailing)) return false;
  return endsWithSentencePunct(afterOpen);
}

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
 * и вставить ins вместо набранного символа. opts: { quotes, dashes, nbsp, autoCap } (autoCap по умолчанию выключен).
 */
function typeChar(before, ch, opts = {}) {
  const o = { quotes: true, dashes: true, nbsp: true, autoCap: false, ...opts };

  const maybeCap = () => {
    if (!o.autoCap || ch.length !== 1 || !/^\p{Ll}$/u.test(ch)) return null;
    if (!isSentenceStartForTyping(before)) return null;
    const up = ch.toUpperCase();
    return up !== ch ? { del: 0, ins: up } : null;
  };

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
    return maybeCap();
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
  return maybeCap();
}

const WS = /[  \t    　]/; // всё, что выглядит пробелом
const ODD_WS = /[\t  　]/;                  // странные пробелы, которые в тексте заменяются обычным
const JUNK = /[­​⁠﻿]/;               // мягкий перенос и невидимые знаки: на сайтах они ломают поиск и перенос строк
const isWs = (c) => !!c && WS.test(c);
const CYR = /[а-яё]/i;

/**
 * Уборка «для публикации» (opts.tidy). Работает со списком символов [{ ch, src }] и ничего не пишет сама:
 * убранный символ просто пропадает из списка, вставленный получает src = -1. Поэтому правки остаются точечными
 * и не трогают курсив, жирный, комментарии и ссылки на карточки.
 * Что делает: убирает мягкие переносы и невидимые знаки; пробелы и табуляции в начале и конце абзаца; двойные пробелы;
 * пробел перед , ; : ! ? . и внутри « »; ставит пробел после запятой между словами; приводит реплику («-Привет», «– Привет»)
 * к «— Привет»; заменяет короткое тире с пробелами вокруг на длинное (диапазоны вроде «10–20» не трогает).
 */
function tidyChars(arr) {
  let a = arr.filter((x) => !JUNK.test(x.ch));
  while (a.length && isWs(a[0].ch)) a.shift();
  while (a.length && isWs(a[a.length - 1].ch)) a.pop();

  // пробельные цепочки: остаётся первый знак; табуляция, em-пробел и ему подобные становятся обычным пробелом
  const b = [];
  for (const x of a) {
    const last = b[b.length - 1];
    if (isWs(x.ch) && last && isWs(last.ch)) continue;
    b.push(isWs(x.ch) && ODD_WS.test(x.ch) ? { ch: ' ', src: -1 } : x);
  }

  const c = [];
  for (let i = 0; i < b.length; i += 1) {
    const x = b[i];
    const prev = c[c.length - 1];
    const next = b[i + 1];
    const next2 = b[i + 2];
    if (isWs(x.ch) && prev && !isWs(prev.ch)) {
      const closing = next && ',;:!?.'.includes(next.ch) && !(next.ch === '.' && next2 && next2.ch === '.')
        && (!next2 || isWs(next2.ch) || ')»”"'.includes(next2.ch));
      if (closing && !'—–-'.includes(prev.ch)) continue; // «слово , слово» -> «слово, слово»
      if (prev.ch === '«' || prev.ch === '„' || (next && next.ch === '»')) continue; // «« Привет »» -> ««Привет»»
    }
    if ((x.ch === '–' || x.ch === '−') && prev && isWs(prev.ch) && next && isWs(next.ch)) {
      const p2 = c[c.length - 2];
      if (!(p2 && /\d/.test(p2.ch) && next2 && /\d/.test(next2.ch))) { // «10 – 20» остаётся диапазоном
        c.push({ ch: '—', src: -1 });
        continue;
      }
    }
    c.push(x);
    if ((x.ch === ',' || x.ch === ';') && next && CYR.test(next.ch) && i > 0 && CYR.test(b[i - 1].ch)) {
      c.push({ ch: ' ', src: -1 }); // «слово,слово» -> «слово, слово»; числа и адреса (1,5; a,b) не задеваются
    }
  }

  // реплика диалога в начале абзаца
  if (c.length && '-–−—'.includes(c[0].ch)) {
    const n = c[1];
    if (n && isWs(n.ch)) {
      if (c[0].ch !== '—') c[0] = { ch: '—', src: -1 };
    } else if (n && /[A-Za-zА-Яа-яЁё«„"…]/.test(n.ch)) {
      c.splice(0, 1, { ch: '—', src: -1 }, { ch: ' ', src: -1 });
    }
  }
  return c;
}

/**
 * Прогоняет готовый текст так, будто его набирали по одному символу.
 * Возвращает правки в координатах исходной строки: [{ from, to, text }] (по возрастанию).
 * opts.tidy: заодно прибирает пробелы и реплики (см. tidyChars). Без него поведение прежнее.
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
  for (const o of opts.tidy && opts.lang !== 'en' ? tidyChars(out) : out) {
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

/**
 * Какие пустые абзацы убрать при наведении порядка. flags[i] — абзац i пустой.
 * Пустые в начале и в конце документа убираются все; между абзацами из каждой серии пустых остаются первые `keep`
 * (0 — убрать все). Если пусты все абзацы, ничего не убираем: документ не трогаем.
 * Возвращает Set индексов.
 */
function emptyToDrop(flags, keep = 0) {
  const k = Math.max(0, Math.min(3, Math.trunc(Number(keep)) || 0));
  const drop = new Set();
  if (!flags.length || flags.every(Boolean)) return drop;
  let i = 0;
  while (i < flags.length) {
    if (!flags[i]) { i += 1; continue; }
    let j = i;
    while (j < flags.length && flags[j]) j += 1; // серия [i, j)
    const edge = i === 0 || j === flags.length;
    for (let n = i; n < j; n += 1) if (edge || n - i >= k) drop.add(n);
    i = j;
  }
  return drop;
}

module.exports = {
  emptyToDrop, NB, SHORT, isSentenceStartForTyping, typeChar, fixText, applyEdits };
