'use strict';

// Экспорт в DOCX без сторонних пакетов: минимальный OOXML-документ, упакованный своим ZIP.
// Из Markdown редактора берутся абзацы, заголовки, цитаты, списки, разделитель, жирный и курсив.

const zlib = require('zlib');

const xmlEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  // символы, недопустимые в XML 1.0
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');

// ---------- ZIP ----------
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  const date = 0x5821; // 2024-01-01
  for (const [name, content] of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.from(content, 'utf8');
    const data = zlib.deflateRawSync(raw);
    const crc = crc32(raw);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6); // имена в UTF-8
    head.writeUInt16LE(8, 8);
    head.writeUInt16LE(0, 10);
    head.writeUInt16LE(date, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(raw.length, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    parts.push(head, nameBuf, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += head.length + nameBuf.length + data.length;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cenBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cenBuf, end]);
}

// ---------- Markdown → абзацы ----------
/** Разбирает строку на куски { text, b, i } по **жирному**, *курсиву* и _курсиву_. */
function runs(text) {
  const out = [];
  let b = false;
  let i = false;
  let buf = '';
  const push = () => { if (buf) out.push({ text: buf, b, i }); buf = ''; };
  const s = String(text);
  for (let k = 0; k < s.length; k += 1) {
    const ch = s[k];
    if (ch === '\\' && /[*_#>\-\\]/.test(s[k + 1] || '')) { buf += s[k + 1]; k += 1; continue; }
    if (ch === '*' && s[k + 1] === '*') { push(); b = !b; k += 1; continue; }
    if (ch === '*' || (ch === '_' && !/\w/.test(s[k - 1] || '') !== !/\w/.test(s[k + 1] || ''))) { push(); i = !i; continue; }
    buf += ch;
  }
  push();
  return out;
}

function runXml(r, extra = '') {
  const pr = `${r.b ? '<w:b/>' : ''}${r.i ? '<w:i/>' : ''}${extra}`;
  return `<w:r>${pr ? `<w:rPr>${pr}</w:rPr>` : ''}<w:t xml:space="preserve">${xmlEsc(r.text)}</w:t></w:r>`;
}

function para(style, lines, opts = {}) {
  const inner = [];
  lines.forEach((ln, idx) => {
    if (idx) inner.push('<w:r><w:br/></w:r>');
    for (const r of runs(ln)) inner.push(runXml(r));
  });
  const ppr = `${style ? `<w:pStyle w:val="${style}"/>` : ''}${opts.pageBreak ? '<w:pageBreakBefore/>' : ''}${opts.center ? '<w:jc w:val="center"/>' : ''}`;
  return `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}${inner.join('')}</w:p>`;
}

function mdToBody(md) {
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let buf = [];
  let kind = null; // 'p' | 'q'
  const flush = () => {
    if (buf.length) out.push(para(kind === 'q' ? 'Quote' : null, buf));
    buf = [];
    kind = null;
  };
  for (const line of lines) {
    let m;
    if (/^\s*$/.test(line)) flush();
    else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) { flush(); out.push(para('Heading2', [m[2]])); }
    else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push(para('Separator', ['\\* \\* \\*'])); } // звёздочки экранированы: иначе runs() принимал их за курсив, и разделитель выходил пустым
    else if ((m = line.match(/^>\s?(.*)$/))) { if (kind !== 'q') flush(); kind = 'q'; buf.push(m[1]); }
    else if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) { flush(); out.push(para('ListItem', [`— ${m[1]}`])); }
    else if ((m = line.match(/^\s*(\d+)[.)]\s+(.*)$/))) { flush(); out.push(para('ListItem', [`${m[1]}. ${m[2]}`])); }
    else { if (kind !== 'p') flush(); kind = 'p'; buf.push(line.trim()); }
  }
  flush();
  return out.join('');
}

const styles = (lang) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman" w:eastAsia="Times New Roman"/><w:sz w:val="28"/><w:szCs w:val="28"/><w:lang w:val="${lang}"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="360" w:lineRule="auto"/><w:jc w:val="both"/><w:ind w:firstLine="709"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="4200" w:after="0"/><w:jc w:val="center"/><w:ind w:firstLine="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="56"/><w:szCs w:val="56"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="0" w:after="360"/><w:jc w:val="left"/><w:ind w:firstLine="0"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="160"/><w:jc w:val="left"/><w:ind w:firstLine="0"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="30"/><w:szCs w:val="30"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="709" w:firstLine="0"/></w:pPr><w:rPr><w:i/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListItem"><w:name w:val="List Item"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="709" w:firstLine="0"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Separator"><w:name w:val="Separator"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="240" w:after="240"/><w:jc w:val="center"/><w:ind w:firstLine="0"/></w:pPr></w:style>
</w:styles>`;

/**
 * chapters: [{ title, text (Markdown) }]. Возвращает Buffer с .docx.
 * opts.stories: названия по центру; opts.toc: заголовок и список «Содержание» после титула (для сборника рассказов).
 */
function buildDocx(bookTitle, chapters, opts = {}) {
  const body = [para('Title', [bookTitle])];
  if (opts.toc) {
    body.push(para('Heading1', [opts.toc.heading], { pageBreak: true, center: true }));
    for (const title of opts.toc.items) body.push(para('ListItem', [title]));
  }
  chapters.forEach((c) => {
    body.push(para('Heading1', [c.title], { pageBreak: true, center: !!opts.stories }), mdToBody(c.text));
  });
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1701" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  return zip([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ['word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
    ['word/styles.xml', styles(opts.lang === 'en' ? 'en-US' : 'ru-RU')],
    ['word/document.xml', doc],
  ]);
}

module.exports = { buildDocx, mdToBody, runs, zip, crc32 };
