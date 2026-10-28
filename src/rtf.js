'use strict';

// Экспорт в RTF без сторонних пакетов. Из Markdown главы берутся абзацы, заголовки, цитаты, списки, разделитель,
// жирный и курсив; вёрстка как в DOCX: Times New Roman 14, полуторный интервал, красная строка, каждая глава с новой страницы.
// Всё, что не ASCII, пишется как \uN? (Word, LibreOffice, TextEdit читают так без кодовых страниц). Чтение RTF находится в src/import.js.

const { runs } = require('./docx');

/** Текст → безопасная для RTF строка: служебные знаки экранируются, не-ASCII превращается в \uN?. */
function esc(text) {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c === 0x5c || c === 0x7b || c === 0x7d) out += `\\${text[i]}`;
    else if (c === 9) out += '\\tab ';
    else if (c < 32) continue;
    else if (c < 128) out += text[i];
    else out += `\\u${c > 32767 ? c - 65536 : c}?`;
  }
  return out;
}

/** Строка Markdown с **жирным** и *курсивом* → фрагменты RTF. */
function inline(line) {
  return runs(line).map((r) => {
    const t = esc(r.text);
    if (!r.b && !r.i) return t;
    return `{${r.b ? '\\b' : ''}${r.i ? '\\i' : ''} ${t}}`;
  }).join('');
}

const para = (props, content) => `{\\pard${props} ${content}\\par}\n`;

const BODY = '\\qj\\fi709\\sl360\\slmult1\\sa0';
const H1 = '\\s1\\outlinelevel0\\keepn\\sb0\\sa360\\fi0\\sl0\\slmult0\\b\\fs36';
const H2 = '\\s2\\outlinelevel1\\keepn\\sb240\\sa160\\fi0\\sl0\\slmult0\\b\\fs32';

/** Markdown главы → абзацы RTF. */
function mdToRtf(md) {
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let buf = [];
  let kind = null;
  const flush = () => {
    if (buf.length) {
      const text = buf.map(inline).join('\\line ');
      out.push(kind === 'q' ? para('\\s4\\li709\\fi0\\sl360\\slmult1\\i', text) : para(BODY, text));
    }
    buf = [];
    kind = null;
  };
  for (const line of lines) {
    let m;
    if (/^\s*$/.test(line)) flush();
    else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) { flush(); out.push(para(H2, esc(m[2]))); }
    else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push(para('\\qc\\sb240\\sa240\\fi0', '* * *')); }
    else if ((m = line.match(/^>\s?(.*)$/))) { if (kind !== 'q') flush(); kind = 'q'; buf.push(m[1]); }
    else if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) { flush(); out.push(para('\\li709\\fi0\\sl360\\slmult1', `\\u8212? ${inline(m[1])}`)); }
    else if ((m = line.match(/^\s*(\d+)[.)]\s+(.*)$/))) { flush(); out.push(para('\\li709\\fi0\\sl360\\slmult1', `${m[1]}. ${inline(m[2])}`)); }
    else { if (kind !== 'p') flush(); kind = 'p'; buf.push(line.trim()); }
  }
  flush();
  return out.join('');
}

/**
 * chapters: [{ title, text (Markdown) }]. Возвращает строку RTF (только ASCII).
 * opts.stories: названия по центру; opts.toc: заголовок и список «Содержание» после титула.
 */
function buildRtf(bookTitle, chapters, opts = {}) {
  const head = '{\\rtf1\\ansi\\ansicpg1251\\deff0\\uc1\n'
    + '{\\fonttbl{\\f0\\froman\\fcharset204 Times New Roman;}}\n'
    + '{\\stylesheet{\\s1 heading 1;}{\\s2 heading 2;}{\\s3 Title;}{\\s4 Quote;}}\n'
    + '\\paperw11906\\paperh16838\\margl1134\\margr1134\\margt1134\\margb1134\\f0\\fs28\n';
  const body = [para('\\s3\\qc\\sb4200\\sa0\\fi0\\b\\fs52', esc(bookTitle))];
  if (opts.toc) {
    body.push(para(`${H1}\\pagebb\\qc`, esc(opts.toc.heading)));
    for (const title of opts.toc.items) body.push(para('\\li709\\fi0\\sl360\\slmult1', esc(title)));
  }
  chapters.forEach((c) => {
    body.push(para(`${H1}\\pagebb${opts.stories ? '\\qc' : ''}`, esc(c.title)), mdToRtf(c.text));
  });
  return `${head}${body.join('')}}\n`;
}

module.exports = { buildRtf, mdToRtf, esc };
