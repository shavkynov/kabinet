'use strict';

// Экспорт глав проекта одним файлом: Markdown, обычный текст, RTF, HTML (из него же печатается PDF).

const project = require('./project');
const { buildDocx } = require('./docx');
const { buildRtf } = require('./rtf');
const { t: tr } = require('./i18n');
const { INDENT } = require('./clip');

const escapeHtml = (s) => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(text) {
  let t = escapeHtml(text);
  t = t.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');
  t = t.replace(/(^|[^\w])_([^_\n]+?)_(?!\w)/g, '$1<em>$2</em>');
  return t.replace(/\\([*_#>\-\\])/g, '$1');
}

/** Небольшой преобразователь Markdown редактора (абзацы, заголовки, цитаты, списки, разделитель). */
function mdToHtml(md) {
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  let list = null; // 'ul' | 'ol'
  let quote = [];

  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  const flushQuote = () => {
    if (quote.length) out.push(`<blockquote><p>${quote.map(inline).join('<br>')}</p></blockquote>`);
    quote = [];
  };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };

  for (const line of lines) {
    let m;
    if (/^\s*$/.test(line)) {
      flushAll();
    } else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      flushAll();
      out.push(`<h${m[1].length + 1}>${inline(m[2])}</h${m[1].length + 1}>`);
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushAll();
      out.push('<hr>');
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      flushPara(); flushList();
      quote.push(m[1]);
    } else if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
      flushPara(); flushQuote();
      if (list !== 'ul') { flushList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flushPara(); flushQuote();
      if (list !== 'ol') { flushList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else {
      flushList(); flushQuote();
      para.push(line.trim());
    }
  }
  flushAll();
  return out.join('\n');
}

/** Markdown без разметки: заголовки и абзацы через пустую строку. */
function mdToText(md, o = {}) {
  let start = true; // строка начинает новый блок
  let skip = false; // предыдущий блок: заголовок или цитата, красной строки после них нет
  return String(md).replace(/\r\n?/g, '\n').split('\n').map((line) => {
    if (/^\s*$/.test(line)) { start = true; return line; }
    const first = start;
    start = false;
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { skip = false; return '***'; }
    const heading = /^#{1,6}\s/.test(line);
    const quote = /^>/.test(line);
    const list = /^\s*[-*+]\s+/.test(line);
    let text = line
      .replace(/^#{1,6}\s+/, '')
      .replace(/^>\s?/, '    ')
      .replace(/^\s*[-*+]\s+/, '— ')
      .replace(/\*\*([^*\n]+?)\*\*/g, '$1')
      .replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\*)/g, '$1$2')
      .replace(/(^|[^\w])_([^_\n]+?)_(?!\w)/g, '$1$2')
      .replace(/\\([*_#>\-\\])/g, '$1');
    if (first && !heading && !quote && !list) {
      if (o.indent && !skip && /^\S/.test(text)) text = INDENT + text; // красная строка при режиме «Красная строка»
      skip = false;
    } else if (first) {
      skip = heading || quote;
    }
    return text;
  }).join('\n').replace(/\n{3,}/g, '\n\n').replace(/^[ \t\n]+/, '').replace(/\s+$/, ''); // не trim(): он съел бы красную строку первого абзаца
}

const CSS = `
  @page { margin: 22mm 20mm; }
  body { font-family: Georgia, "Times New Roman", serif; font-size: 12pt; line-height: 1.55; color: #111; }
  h1.book { font-size: 26pt; text-align: center; margin: 30vh 0 0; page-break-after: always; }
  section.chapter { page-break-before: always; }
  section.chapter:first-of-type { page-break-before: auto; }
  h2.title { font-size: 18pt; margin: 0 0 1.2em; }
  body.stories h2.title { text-align: center; font-size: 20pt; margin: 2.5em 0 1.6em; }
  nav.toc { page-break-after: always; }
  nav.toc h2 { text-align: center; font-size: 18pt; margin: 0 0 1em; }
  nav.toc ol { list-style: none; padding: 0; line-height: 1.9; text-align: center; }
  p { margin: 0 0 .7em; text-align: justify; }
  blockquote { margin: 0 0 .7em 1.2em; padding-left: .8em; border-left: 2px solid #999; color: #444; }
  hr { border: none; text-align: center; margin: 1.2em 0; }
  hr::after { content: "* * *"; }
`;
const INDENT_CSS = `
  p { margin: 0; text-indent: 1.5em; }
  h2 + p, h3 + p, blockquote + p { text-indent: 0; }
`;

/**
 * Собирает документ из всех глав. format: 'md' | 'txt' | 'html' | 'rtf' | 'docx' (Buffer). PDF печатается из html.
 * Заголовок главы: номер по порядку и название.
 */
function buildExport(dir, format, lang, opts = {}) {
  const view = project.openProject(dir);
  const stories = view.mode === 'stories';
  // Рассказы: название без номера; в сборнике из двух и более рассказов после титула идёт «Содержание».
  const chapters = view.chapters.map((c, i) => ({
    title: stories ? c.title : `${i + 1}. ${c.title}`,
    text: project.readChapter(dir, c.id, { track: false }).trim(),
  }));
  const tocHeading = tr('Содержание');
  const toc = stories && chapters.length > 1 ? chapters.map((c) => c.title) : null;

  if (format === 'docx') {
    return buildDocx(view.name, chapters, { stories, lang, toc: toc ? { heading: tocHeading, items: toc } : null });
  }
  if (format === 'rtf') {
    return buildRtf(view.name, chapters, { stories, toc: toc ? { heading: tocHeading, items: toc } : null });
  }
  if (format === 'md') {
    const contents = toc ? `## ${tocHeading}\n\n${toc.map((x) => `- ${x}`).join('\n')}\n\n---\n\n` : '';
    return `# ${view.name}\n\n${contents}${chapters.map((c) => `## ${c.title}\n\n${c.text}`).join('\n\n---\n\n')}\n`.replace(/\u00a0/g, ' '); // для публикации: обычные пробелы
  }
  if (format === 'txt') {
    const contents = toc ? `${tocHeading}\n\n${toc.join('\n')}\n\n\n` : '';
    return `${view.name}\n\n\n${contents}${chapters.map((c) => `${c.title}\n\n${mdToText(c.text, { indent: !!opts.indent })}`).join('\n\n\n')}\n`.replace(/\u00a0/g, ' ');
  }
  if (format === 'html') {
    const body = chapters.map((c) => (
      `<section class="chapter"><h2 class="title">${escapeHtml(c.title)}</h2>\n${mdToHtml(c.text)}</section>`
    )).join('\n');
    const nav = toc
      ? `<nav class="toc"><h2>${escapeHtml(tocHeading)}</h2><ol>${toc.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ol></nav>\n`
      : '';
    return `<!doctype html>\n<html lang="${lang === 'en' ? 'en' : 'ru'}"><head><meta charset="utf-8"><title>${escapeHtml(view.name)}</title>` +
      `<style>${CSS}${opts.indent ? INDENT_CSS : ''}</style></head><body${stories ? ' class="stories"' : ''}>\n<h1 class="book">${escapeHtml(view.name)}</h1>\n${nav}${body}\n</body></html>\n`;
  }
  throw new Error('Неизвестный формат экспорта.');
}

module.exports = { buildExport, mdToHtml, mdToText };
