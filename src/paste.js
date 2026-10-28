'use strict';

// Вставка из Word и других офисных программ. Их HTML тащит служебную разметку (списки с «тире» в виде маркеров,
// мягкие переносы, пустые абзацы), а обычный текст при вставке читался как Markdown: одиночные переносы склеивались,
// «- реплика» превращалась в список. Поэтому из такого буфера берём обычный текст и делаем абзац на каждую строку.

/** HTML из Word, LibreOffice, Google Документов (но не буфер самого редактора). */
function isOfficeHtml(html) {
  const h = String(html || '');
  if (!h || h.includes('data-pm-slice')) return false;
  return /urn:schemas-microsoft-com|class="?Mso|ProgId"?\s+content="?Word|<o:p>|<w:|xmlns:[ovw]=|mso-[a-z-]+:|StartFragment|docs-internal-guid|Generator"?\s+content="?(?:LibreOffice|Microsoft)/i.test(h);
}

const PUA_MARK = new RegExp(`^\\s*[${String.fromCharCode(0xe000)}-${String.fromCharCode(0xf8ff)}][\\t\\s]*`); // символьные шрифты Word: маркер приходит знаком из личной области
const BULLETS = /^\s*[·•●▪◦o][\t  ]+/; // маркеры списка Word (Symbol, bullet, «o»)
const DASH_MARK = /^\s*([–—‒-])[\t  ]+/; // «-табуляция-текст» и «- текст»
const BREAKS = new RegExp(`[${String.fromCharCode(11, 0x2028, 0x2029)}]`, 'g'); // мягкие переносы строки
const JUNK = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(12)}${String.fromCharCode(14)}-${String.fromCharCode(31)}${String.fromCharCode(0x200b)}]`, 'g'); // служебные символы и невидимый пробел

/** Обычный текст из буфера -> массив абзацев без пустых. */
function officeTextToParagraphs(text) {
  const out = [];
  for (let line of String(text || '').replace(/\r\n?/g, '\n').replace(BREAKS, '\n').split('\n')) {
    line = line.replace(JUNK, '').replace(/\u00ad/g, '').replace(/[ \t]+$/, '');
    const dash = DASH_MARK.exec(line);
    if (PUA_MARK.test(line)) line = `— ${line.replace(PUA_MARK, '')}`;
    else if (dash) line = `${dash[1]} ${line.slice(dash[0].length)}`; // тире остаётся, табуляция после него уходит
    else line = line.replace(BULLETS, '');
    line = line.replace(/^[ \t ]+/, ''); // отступы Word не нужны: абзацный отступ задаёт оформление
    if (line.trim()) out.push(line);
  }
  return out;
}

module.exports = { isOfficeHtml, officeTextToParagraphs };
