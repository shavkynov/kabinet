'use strict';

// Импорт текста в проект: .docx, .md и .txt превращаются в главы (название + Markdown).
// Модуль без Electron и без сторонних пакетов: docx читается напрямую (zip + XML), поэтому он проверяется тестами (test/import.test.js).
// Правила разбиения на главы: берётся самый высокий уровень заголовков, который встречается минимум дважды (в файле Кабинета это названия глав);
// один заголовок в самом начале становится названием главы; без заголовков вся глава получает имя файла.
// Всё, что в Markdown имеет особый смысл («*», «_», «#» и «-» в начале строки), экранируется, чтобы обычный текст не превратился в разметку.

const zlib = require('zlib');

const MAX_FILE = 30 * 1024 * 1024; // больше этого файл не читаем
const MAX_XML = 200 * 1024 * 1024; // предел распакованного XML (защита от «бомбы»)
const MAX_TITLE = 120;

const BOM = String.fromCharCode(0xfeff);
const LINE_SEPS = new RegExp(`[${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}${String.fromCharCode(0)}]`, 'g');
const normalize = (s) => String(s).replace(new RegExp(`^${BOM}`), '').replace(/\r\n?/g, '\n').replace(LINE_SEPS, '\n');

// ---------- кодировка ----------

/** Байты текстового файла → строка: UTF-8 (с BOM или без), UTF-16 с BOM, иначе Windows-1251 (старые Блокноты). */
function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return Buffer.from(buf.subarray(2)).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const b = Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1)));
    b.swap16();
    return b.toString('utf16le');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1251').decode(buf);
  }
}

// ---------- обычный текст ----------

const escapeInline = (s) => s.replace(/([\\*_`])/g, '\\$1');

/** Знаки, которые в начале строки Markdown стали бы заголовком, цитатой или списком. */
function escapeStart(line) {
  return line
    .replace(/^#/, '\\#')
    .replace(/^>/, '\\>')
    .replace(/^([-+])(?=\s)/, '\\$1')
    .replace(/^(\d+)([.)])(?=\s)/, '$1\\$2');
}

/** Строка из одних звёздочек, решёток, тире и т. п. (не меньше трёх знаков): разделитель сцен. */
const isSeparatorText = (t) => /^[\s*#~_=\-—–•·]+$/.test(t) && t.replace(/\s/g, '').length >= 3;

const WORD_NUM = '(?:перв|втор|трет|четвёрт|четверт|пят|шест|седьм|восьм|девят|десят|одиннадцат|двенадцат)[а-яё]*';
const CHAPTER_LINE = new RegExp(`^(?:(?:глава|часть|chapter|part)\\s+(?:\\d+|[IVXLC]+|${WORD_NUM})\\b.{0,60}|пролог\\.?|эпилог\\.?|prologue\\.?|epilogue\\.?)$`, 'iu');

/** Готовая строка абзаца: сначала диалоговое тире, потом защита начала строки. */
function finishPara(rendered, raw) {
  if (isSeparatorText(raw)) return '---';
  return escapeStart(rendered.replace(/^[-–]\s+/, '— '));
}

/**
 * Простой текст → Markdown. Обычно каждая строка файла — абзац; если абзацы разделены пустыми строками, а внутри них строки
 * перенесены вручную (больше 60 % блоков из нескольких строк), строки блока склеиваются. Строки вида «Глава 3», «Пролог» становятся заголовками.
 */
function txtToMarkdown(text) {
  const lines = normalize(text).split('\n').map((l) => l.replace(/\s+$/, ''));
  const blocks = [];
  let cur = [];
  for (const l of lines) {
    if (l.trim()) cur.push(l.trim());
    else if (cur.length) { blocks.push(cur); cur = []; }
  }
  if (cur.length) blocks.push(cur);
  const multi = blocks.filter((b) => b.length > 1).length;
  const wrapped = blocks.length > 1 && multi / blocks.length > 0.6;
  const paras = wrapped ? blocks.map((b) => b.join(' ')) : blocks.flat();
  return paras.map((p) => {
    if (p.length <= 70 && CHAPTER_LINE.test(p)) return `# ${p.replace(/\.$/, '')}`;
    return finishPara(escapeInline(p), p);
  }).join('\n\n');
}

// ---------- Markdown ----------

/** Нормализация .md: переводы строк, BOM, YAML-шапка (Obsidian и т. п.) убирается. */
function mdPrepare(text) {
  let s = normalize(text);
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(s);
  if (m && /^[\w-]+\s*:/.test(m[1]) && m[1].split('\n').length <= 40) s = s.slice(m[0].length);
  return s;
}

// ---------- разбиение на главы ----------

const CONTENTS_TITLE = /^(содержание|оглавление|contents|table of contents)$/i;

function cleanTitle(s, fallback) {
  const t = String(s || '')
    .replace(/\\([\\*_`#>\-+.)])/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE)
    .trim();
  return t || fallback;
}

function headingOf(line) {
  const m = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
  return m && m[2].replace(/#/g, '').trim() ? { level: m[1].length, text: m[2] } : null;
}

/**
 * Markdown → [{ title, text }]. fallback: имя файла без расширения (для текста без заголовков).
 */
function splitMarkdown(md, fallback) {
  const lines = normalize(md).split('\n');
  const heads = [];
  let fence = false;
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; return; }
    if (fence) return;
    const h = headingOf(line);
    if (h) heads.push({ i, ...h });
  });
  const body = (from, to) => lines.slice(from, to).join('\n').trim();
  let chapters = [];

  const count = {};
  for (const h of heads) count[h.level] = (count[h.level] || 0) + 1;
  const level = Object.keys(count).map(Number).sort((a, b) => a - b).find((l) => count[l] >= 2);

  if (level) {
    const bounds = heads.filter((h) => h.level === level);
    const preface = lines.slice(0, bounds[0].i).filter((l) => l.trim() && !headingOf(l));
    if (preface.length) chapters.push({ title: fallback, text: body(0, bounds[0].i) });
    bounds.forEach((h, k) => {
      chapters.push({ title: cleanTitle(h.text, `${fallback} ${k + 1}`), text: body(h.i + 1, k + 1 < bounds.length ? bounds[k + 1].i : lines.length) });
    });
  } else {
    const first = lines.findIndex((l) => l.trim());
    const only = heads.length === 1 && heads[0].i === first ? heads[0] : null;
    const lowest = heads.length ? Math.min(...heads.map((h) => h.level)) : 0;
    const lead = first >= 0 && heads[0] && heads[0].i === first && heads[0].level === lowest && count[lowest] === 1 ? heads[0] : null;
    const head = only || lead;
    if (head) chapters.push({ title: cleanTitle(head.text, fallback), text: body(head.i + 1, lines.length) });
    else chapters.push({ title: cleanTitle(fallback, 'Импорт'), text: body(0, lines.length) });
  }

  // содержание, сделанное Кабинетом или Word, главой не считается
  chapters = chapters.filter((c) => !(CONTENTS_TITLE.test(c.title) && c.text.split('\n').filter((l) => l.trim()).every((l) => l.length < 80)));
  return chapters.filter((c, i) => c.title || c.text || i === 0).filter((c) => c.title);
}

// ---------- docx ----------

/** Читает zip: Map имя → Buffer. Поддерживает «без сжатия» и deflate, этого достаточно для docx. */
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Файл не похож на документ Word (.docx).');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + elen + clen;
    if (!/^word\/(document|styles)\.xml$/.test(name)) continue;
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + csize);
    if (method === 0) files.set(name, Buffer.from(data));
    else if (method === 8) files.set(name, zlib.inflateRawSync(data, { maxOutputLength: MAX_XML }));
  }
  return files;
}

function decodeXml(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

const attr = (xml, tag, name = 'w:val') => {
  const m = new RegExp(`<${tag}\\b[^>]*\\s${name}="([^"]*)"`).exec(xml);
  return m ? decodeXml(m[1]) : null;
};

/** Стили документа: id → { name, outline, basedOn }. */
function readStyles(xml) {
  const map = new Map();
  if (!xml) return map;
  for (const m of xml.matchAll(/<w:style\b[^>]*\sw:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g)) {
    const o = attr(m[2], 'w:outlineLvl');
    map.set(m[1], { name: (attr(m[2], 'w:name') || '').toLowerCase(), outline: o === null ? null : Number(o), basedOn: attr(m[2], 'w:basedOn') });
  }
  return map;
}

/** Вид абзаца по стилю: { level } для заголовка, { title: true } для названия документа, { quote }, { toc }. */
function styleKind(styles, id, depth = 0) {
  if (!id) return {};
  const st = styles.get(id);
  const name = st ? st.name : id.toLowerCase();
  let m = /^(?:heading|заголовок)\s*(\d)$/.exec(name) || /^heading(\d)$/.exec(name);
  if (m) return { level: Math.min(6, Number(m[1])) };
  if (/^(title|название|заголовок)$/.test(name)) return { title: true };
  if (/^(?:toc|оглавление)\s*\d|^(?:toc|contents)\b|^оглавление/.test(name) || /^toc\d/i.test(id)) return { toc: true };
  if (/quote|цитата/.test(name)) return { quote: true };
  if (st && st.outline !== null && st.outline <= 5) return { level: st.outline + 1 };
  if (st && st.basedOn && depth < 5) return styleKind(styles, st.basedOn, depth + 1);
  return {};
}

const flag = (rpr, tag) => {
  const m = new RegExp(`<w:${tag}(?:\\s+w:val="([^"]*)")?\\s*\\/>`).exec(rpr);
  return !!m && !/^(0|false|off)$/i.test(m[1] || '');
};

/** Абзац → куски { text, b, i } подряд идущие с одинаковым начертанием склеены; перенос строки внутри абзаца — «\n». */
function paragraphRuns(inner) {
  const segs = [];
  for (const rm of inner.matchAll(/<w:r(?:\s[^>]*[^/>])?>([\s\S]*?)<\/w:r>/g)) {
    const run = rm[1];
    const rp = /<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(run);
    const rpr = rp ? rp[1] : '';
    if (flag(rpr, 'vanish')) continue;
    const b = flag(rpr, 'b');
    const i = flag(rpr, 'i');
    let text = '';
    for (const tm of run.replace(/<w:rPr>[\s\S]*?<\/w:rPr>/, '').matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\b([^>]*)\/>|<w:noBreakHyphen\s*\/>/g)) {
      if (tm[1] !== undefined) text += decodeXml(tm[1]);
      else if (tm[0].startsWith('<w:tab')) text += '\t';
      else if (tm[0].startsWith('<w:noBreak')) text += '-';
      else if (!/w:type="(page|column)"/.test(tm[2] || '')) text += '\n';
    }
    if (!text) continue;
    const last = segs[segs.length - 1];
    if (last && last.b === b && last.i === i) last.text += text;
    else segs.push({ text, b, i });
  }
  return segs;
}

/** Куски → строка Markdown: пробелы по краям выносятся за «**» и «*», чтобы разметка не ломалась. */
function renderRuns(segs) {
  let out = '';
  for (const s of segs) {
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s.text);
    const core = escapeInline(m[2]).replace(/\n/g, '  \n');
    if (!core.trim()) { out += s.text.replace(/\n/g, '  \n'); continue; }
    const mark = `${s.b ? '**' : ''}${s.i ? '*' : ''}`;
    const rev = `${s.i ? '*' : ''}${s.b ? '**' : ''}`;
    out += `${m[1]}${mark}${core}${rev}${m[3]}`;
  }
  return out;
}

/**
 * Абзацы документа → Markdown (общая часть для Word и RTF).
 * para: { segs: [{ text, b, i }], kind: { level, title, toc, quote }, outline: число или null, list: true для пункта списка }.
 */
function parasToMarkdown(paras) {
  const blocks = [];
  for (const pa of paras) {
    if (pa.kind.toc) continue;
    const raw = pa.segs.map((s) => s.text).join('').replace(/\t/g, ' ').replace(/\n/g, ' ').trim();
    if (!raw) continue;
    const level = pa.kind.level || (pa.outline !== null && pa.outline <= 5 ? pa.outline + 1 : 0);
    if (isSeparatorText(raw)) { blocks.push({ md: '---' }); continue; }
    if (level) { blocks.push({ level, md: `${'#'.repeat(level)} ${raw}` }); continue; }
    if (pa.kind.title) { blocks.push({ title: raw, md: `# ${raw}` }); continue; }
    // цитата в Word и RTF и так курсивная по стилю: курсив внутри неё отдельной разметкой не нужен
    const text = renderRuns(pa.segs.map((x) => ({ ...x, i: pa.kind.quote ? false : x.i, text: x.text.replace(/\t/g, ' ') }))).replace(/^\s+/, '').replace(/\s+$/, '');
    if (pa.kind.quote) { blocks.push({ md: `> ${text.replace(/\n/g, '\n> ')}` }); continue; }
    if (pa.list) { blocks.push({ md: `- ${text}` }); continue; }
    if (/^[•·▪●◦■]\s/.test(raw)) { blocks.push({ md: `- ${text.replace(/^[•·▪●◦■]\s*/, '')}` }); continue; } // маркер списка, записанный обычным текстом (pandoc, Блокнот)
    blocks.push({ md: finishPara(text, raw) });
  }
  // название документа (стиль Title) — не глава: есть заголовки, значит, оно лишнее
  const hasHeads = blocks.some((b) => b.level);
  return blocks.filter((b) => !(b.title && hasHeads)).map((b) => b.md).join('\n\n');
}

/** word/document.xml (+ стили) → Markdown. */
function docxToMarkdown(buf) {
  const files = readZip(buf);
  const docBuf = files.get('word/document.xml');
  if (!docBuf) throw new Error('В файле нет текста документа Word.');
  const styles = readStyles(files.has('word/styles.xml') ? files.get('word/styles.xml').toString('utf8') : '');
  const xml = docBuf.toString('utf8')
    .replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, '')
    .replace(/<w:txbxContent>[\s\S]*?<\/w:txbxContent>/g, '');
  const paras = [];
  for (const pm of xml.matchAll(/<w:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:p>)/g)) {
    if (pm[1] === undefined) continue;
    const pp = /<w:pPr>([\s\S]*?)<\/w:pPr>/.exec(pm[1]);
    const ppr = pp ? pp[1] : '';
    const ol = attr(ppr, 'w:outlineLvl');
    const numId = attr(ppr, 'w:numId');
    paras.push({
      segs: paragraphRuns(pm[1].replace(/<w:pPr>[\s\S]*?<\/w:pPr>/, '')),
      kind: styleKind(styles, attr(ppr, 'w:pStyle')),
      outline: ol === null ? null : Number(ol),
      list: /<w:numPr>/.test(ppr) && !!numId && numId !== '0',
    });
  }
  return parasToMarkdown(paras);
}

// ---------- rtf ----------

// Группы RTF, содержимое которых не текст документа.
const RTF_SKIP = new Set(['fonttbl', 'colortbl', 'info', 'pict', 'header', 'headerl', 'headerr', 'headerf', 'footer', 'footerl', 'footerr', 'footerf',
  'footnote', 'themedata', 'datastore', 'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'filetbl', 'revtbl', 'latentstyles',
  'colorschememapping', 'xmlnstbl', 'pgptbl', 'object', 'shp', 'listtext', 'pntext', 'pn', 'bkmkstart', 'bkmkend', 'fldinst']);
const RTF_CP = { 1250: 'windows-1250', 1251: 'windows-1251', 1252: 'windows-1252', 1253: 'windows-1253', 1254: 'windows-1254', 1257: 'windows-1257', 10000: 'macintosh', 65001: 'utf-8' };
const RTF_CHARS = { emdash: '—', endash: '–', bullet: '•', lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”', emspace: ' ', enspace: ' ', qmspace: ' ' };

/**
 * RTF (строка, где каждый байт — один знак) → абзацы для parasToMarkdown.
 * Понимает группы и пропускаемые «назначения», \\uN с запасными знаками (\\ucN), \\'hh в кодовой странице файла (\\ansicpgN),
 * \\par, \\line, \\tab, жирный и курсив, стили заголовков (\\sN из таблицы стилей) и \\outlinelevelN, пункты списков (\\lsN).
 */
function rtfParagraphs(src) {
  const sheet = new Map(); // номер стиля → { name, outline }
  const paras = [];
  const stack = [];
  let st = { b: false, i: false, hidden: false, skip: false, sheet: false, uc: 1 };
  let cp = 'windows-1252';
  let cur = { segs: [], style: null, outline: null, list: false };
  let bytes = [];
  let skipChars = 0;
  let first = false;
  let sheetNum = null;
  let sheetName = '';
  let sheetOutline = null;

  const add = (text) => {
    if (st.sheet) {
      const k = text.indexOf(';');
      sheetName += k < 0 ? text : text.slice(0, k);
      if (k >= 0) {
        if (sheetNum !== null) sheet.set(sheetNum, { name: sheetName.trim().toLowerCase(), outline: sheetOutline });
        sheetNum = null; sheetName = ''; sheetOutline = null;
      }
      return;
    }
    if (st.skip || st.hidden || !text) return;
    const last = cur.segs[cur.segs.length - 1];
    if (last && last.b === st.b && last.i === st.i) last.text += text;
    else cur.segs.push({ text, b: st.b, i: st.i });
  };
  const flushBytes = () => {
    if (!bytes.length) return;
    let t;
    try { t = new TextDecoder(cp).decode(Uint8Array.from(bytes)); } catch { t = Buffer.from(bytes).toString('latin1'); }
    bytes = [];
    add(t);
  };
  const endPara = () => {
    if (st.skip || st.sheet) return;
    paras.push(cur);
    cur = { segs: [], style: null, outline: null, list: false };
  };
  const text = (t) => { if (skipChars > 0) skipChars -= 1; else add(t); };

  for (let i = 0; i < src.length;) {
    const ch = src[i];
    const wasFirst = first;
    if (ch === '{') {
      flushBytes();
      stack.push(st);
      st = { ...st };
      first = true;
      i += 1;
    } else if (ch === '}') {
      flushBytes();
      st = stack.pop() || st;
      first = false;
      i += 1;
    } else if (ch === '\\') {
      first = false;
      const nx = src[i + 1];
      if (nx === undefined) break;
      if (/[a-zA-Z]/.test(nx)) {
        flushBytes();
        let j = i + 1;
        while (j < src.length && /[a-zA-Z]/.test(src[j])) j += 1;
        const word = src.slice(i + 1, j);
        let param = null;
        let k = j;
        if (src[k] === '-' || /\d/.test(src[k] || '')) {
          let m = k + (src[k] === '-' ? 1 : 0);
          while (m < src.length && /\d/.test(src[m])) m += 1;
          param = parseInt(src.slice(k, m), 10);
          k = m;
        }
        if (src[k] === ' ') k += 1;
        i = k;
        if (wasFirst && RTF_SKIP.has(word)) st.skip = true;
        switch (word) {
          case 'stylesheet': st.sheet = true; break;
          case 'ansicpg': cp = RTF_CP[param] || cp; break;
          case 'uc': st.uc = param === null ? 1 : param; break;
          case 'u': add(String.fromCharCode(param < 0 ? param + 65536 : param)); skipChars = st.uc; break;
          case 'par': case 'cell': case 'row': endPara(); break;
          case 'line': add('\n'); break;
          case 'tab': add('\t'); break;
          case 'pard': cur.style = null; cur.outline = null; cur.list = false; break;
          case 'plain': st.b = false; st.i = false; break;
          case 'b': st.b = param !== 0; break;
          case 'i': st.i = param !== 0; break;
          case 'v': st.hidden = param !== 0; break;
          case 's': if (st.sheet) sheetNum = param; else cur.style = param; break;
          case 'outlinelevel': if (st.sheet) sheetOutline = param; else cur.outline = param; break;
          case 'ls': if (!st.sheet && param > 0) cur.list = true; break;
          default: if (Object.hasOwn(RTF_CHARS, word)) add(RTF_CHARS[word]);
        }
      } else {
        i += 2;
        if (nx === "'") {
          const byte = parseInt(src.substr(i, 2), 16);
          i += 2;
          if (skipChars > 0) skipChars -= 1;
          else if (!Number.isNaN(byte)) bytes.push(byte);
        } else {
          flushBytes();
          if (nx === '*') { if (wasFirst) st.skip = true; } else if (nx === '~') add('\u00a0');
          else if (nx === '_') add('-');
          else if (nx === '\n' || nx === '\r') endPara();
          else if (nx === '{' || nx === '}' || nx === '\\') text(nx);
        }
      }
    } else if (ch === '\r' || ch === '\n') {
      i += 1; // переводы строк в самом файле RTF значения не имеют
    } else {
      first = false;
      if (skipChars > 0) skipChars -= 1;
      else if (ch.charCodeAt(0) >= 0x80) bytes.push(ch.charCodeAt(0));
      else { flushBytes(); add(ch); }
      i += 1;
    }
  }
  flushBytes();
  if (cur.segs.length) paras.push(cur);
  const styles = new Map([...sheet].map(([n, v]) => [String(n), { name: v.name, outline: v.outline, basedOn: null }]));
  return paras.map((p) => ({
    segs: p.segs,
    kind: p.style === null ? {} : styleKind(styles, String(p.style)),
    outline: p.outline,
    list: p.list,
  }));
}

function rtfToMarkdown(buf) {
  const src = Buffer.from(buf).toString('latin1');
  if (!/^\s*\{\\rtf/.test(src.slice(0, 64))) throw new Error('Файл не похож на документ RTF.');
  return parasToMarkdown(rtfParagraphs(src));
}

// ---------- вход ----------

/**
 * Файл → главы: [{ title, text }]. name: имя файла (по расширению выбирается разбор), buf: содержимое.
 */
function parseFile(name, buf) {
  if (buf.length > MAX_FILE) throw new Error('Файл слишком большой для импорта (больше 30 МБ).');
  const m = /\.([^.\\/]+)$/.exec(name);
  const ext = m ? m[1].toLowerCase() : '';
  const base = String(name).replace(/\.[^.\\/]+$/, '').trim() || 'Импорт';
  let md;
  if (ext === 'docx') md = docxToMarkdown(buf);
  else if (ext === 'rtf') md = rtfToMarkdown(buf);
  else if (ext === 'md' || ext === 'markdown') md = mdPrepare(decodeText(buf));
  else if (ext === 'txt' || ext === 'text') md = txtToMarkdown(decodeText(buf));
  else if (ext === 'doc') throw new Error('Старый формат .doc не поддерживается: сохраните файл в Word как .docx.');
  else throw new Error('Формат файла не поддерживается. Подойдут .docx, .rtf, .md и .txt.');
  if (!md.trim()) throw new Error('В файле нет текста.');
  const chapters = splitMarkdown(md, base);
  if (!chapters.length) throw new Error('В файле нет текста.');
  return chapters;
}

module.exports = { rtfParagraphs, rtfToMarkdown, parseFile, decodeText, txtToMarkdown, mdPrepare, splitMarkdown, docxToMarkdown, readZip, MAX_FILE };
