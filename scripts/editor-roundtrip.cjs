'use strict';
// Проверка настоящего редактора (TipTap + tiptap-markdown) в Electron: документ -> Markdown -> новый редактор.
// Каждая проверка идёт отдельным вызовом с таймаутом: зависание одной не прячет остальные. Отчёт: ci-diagnostics/editor-roundtrip.json
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const esbuild = require('esbuild');
const output = path.resolve('ci-diagnostics/editor-roundtrip.json');
const CASE_TIMEOUT_MS = 15000;
let temp;
let window;
const results = [];
function report(value) {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(value, null, 2) + '\n');
}
app.on('window-all-closed', () => {});
const overall = setTimeout(() => {
  report({ status: 'error', error: 'Editor check timed out', results });
  app.exit(2);
}, 240000);

const source = `
  import { Editor } from '@tiptap/core';
  import StarterKit from '@tiptap/starter-kit';
  import { Markdown } from 'tiptap-markdown';
  import { AlignParagraph } from './renderer/align.js';
  import { Typography, fixDocTypography } from './renderer/typo.js';
  const cases = [];
  const add = (name, fn) => cases.push({ name, fn });
  const paragraph = (text, attrs) => ({ type: 'paragraph', ...(attrs ? { attrs } : {}), ...(text ? { content: [{ type: 'text', text }] } : {}) });
  const create = (content) => new Editor({ element: document.createElement('div'), extensions: [StarterKit.configure({ paragraph: false }), AlignParagraph, Typography, Markdown.configure({ html: false, tightLists: true, breaks: false, transformPastedText: true })], content });
  const md = (e) => e.storage.markdown.getMarkdown();
  const emptyCount = (e) => e.getJSON().content.filter((n) => n.type === 'paragraph' && (!n.content || !n.content.length)).length;
  const texts = (e) => { const out = []; e.state.doc.descendants((n) => { if (n.isTextblock && n.textContent.trim()) out.push(n.type.name + ':' + n.textContent); }); return out; };
  const done = (...editors) => editors.forEach((e) => e.destroy());

  for (let count = 1; count <= 3; count++) add('empty-paragraph-roundtrip-' + count, () => {
    const e = create({ type: 'doc', content: [paragraph('A'), ...Array.from({ length: count }, () => paragraph()), paragraph('B')] });
    const markdown = md(e); const r = create(markdown); const actual = emptyCount(r); done(e, r);
    return { ok: actual === count, expected: count, actual, markdown };
  });
  for (let keep = 0; keep <= 3; keep++) add('typography-and-single-undo-' + keep, () => {
    const e = create({ type: 'doc', content: [paragraph('A'), ...Array.from({ length: 4 }, () => paragraph()), paragraph('B')] });
    const before = JSON.stringify(e.getJSON());
    fixDocTypography(e, { dropEmpty: true, keepEmpty: keep, quotes: true, dashes: true, nbsp: false, lang: 'ru' });
    const actual = emptyCount(e); const undone = e.commands.undo();
    const ok = actual === keep && undone && JSON.stringify(e.getJSON()) === before; done(e);
    return { ok, expected: keep, actual, undone };
  });
  for (const align of ['center', 'right']) add('alignment-roundtrip-' + align, () => {
    const e = create({ type: 'doc', content: [paragraph('Text', { textAlign: align })] });
    const markdown = md(e); const r = create(markdown); const actual = r.getJSON().content[0].attrs?.textAlign; done(e, r);
    return { ok: actual === align, expected: align, actual, markdown };
  });
  for (const edge of ['leading', 'trailing', 'only']) for (let count = 1; count <= 3; count++) add('empty-boundary-' + edge + '-' + count, () => {
    const blanks = Array.from({ length: count }, () => paragraph());
    const content = edge === 'leading' ? [...blanks, paragraph('B')] : edge === 'trailing' ? [paragraph('A'), ...blanks] : blanks;
    const e = create({ type: 'doc', content }); const markdown = md(e); const r = create(markdown); const actual = emptyCount(r); done(e, r);
    return { ok: actual === count, expected: count, actual, markdown };
  });

  // Старые файлы и вложенные блоки: второй проход не меняет Markdown, текст не теряется.
  const sources = {
    'old-2-blank-lines': 'A\\n\\n\\nB',
    'old-3-blank-lines': 'A\\n\\n\\n\\nB',
    'old-4-blank-lines-and-final-newline': 'A\\n\\n\\n\\n\\nB\\n',
    'crlf': 'A\\r\\n\\r\\n\\r\\nB',
    'list-then-blanks': '- a\\n- b\\n\\n\\n\\nC',
    'quote-with-blank-inside': '> a\\n>\\n> b\\n\\n\\n\\nC',
    'code-with-blank-lines': '\`\`\`\\na\\n\\n\\nb\\n\`\`\`\\n\\n\\nC',
    'marks-around-blanks': '**жирный**\\n\\n\\n*курсив*\\n\\n\\n[ссылка](http://x.y)',
    'aligned-around-blanks': '-> A <-\\n\\n\\n\\n-> B ->',
    'heading-then-blanks': '# H\\n\\n\\n\\nA',
    'rule-around-blanks': 'A\\n\\n\\n---\\n\\n\\nB',
    'ordered-list': '1. a\\n2. b\\n\\n\\nC',
  };
  for (const [name, src] of Object.entries(sources)) add('source-' + name, () => {
    const first = create(src); const md1 = md(first); const second = create(md1); const md2 = md(second);
    const plain = create(src.replace(/\\r\\n?/g, '\\n').replace(/\\n{3,}/g, '\\n\\n'));
    const sameText = JSON.stringify(texts(first)) === JSON.stringify(texts(second));
    const keepsText = src.includes('\`\`\`') || JSON.stringify(texts(first)) === JSON.stringify(texts(plain)); // в коде пустые строки значимы: сравнение с «сжатым» файлом там не нужно
    const r = { ok: md1 === md2 && sameText && keepsText, stable: md1 === md2, sameText, keepsText, source: src, markdown: md1, empties: emptyCount(first) };
    done(first, second, plain); return r;
  });
  for (const [name, wrap] of Object.entries({ quote: 'blockquote', item: 'listItem' })) add('nested-empty-' + name, () => {
    const inner = [paragraph('a'), paragraph(), paragraph('b')];
    const body = wrap === 'listItem' ? { type: 'bulletList', content: [{ type: 'listItem', content: inner }] } : { type: 'blockquote', content: inner };
    const e = create({ type: 'doc', content: [body, paragraph('C')] });
    const md1 = md(e); const re = create(md1); const md2 = md(re);
    const sameText = JSON.stringify(texts(e)) === JSON.stringify(texts(re));
    const r = { ok: md1 === md2 && sameText, markdown: md1, stable: md1 === md2, sameText }; done(e, re); return r;
  });
  add('code-blank-lines-kept', () => {
    const e = create({ type: 'doc', content: [{ type: 'codeBlock', content: [{ type: 'text', text: 'a\\n\\n\\nb' }] }, paragraph('C')] });
    const markdown = md(e); const r = create(markdown); const ok = r.getJSON().content[0].content[0].text === 'a\\n\\n\\nb'; done(e, r);
    return { ok, markdown };
  });
  globalThis.caseNames = () => cases.map((c) => c.name);
  globalThis.runCase = (i) => cases[i].fn();
`;

async function openWindow() {
  window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadFile(path.join(temp, 'index.html'));
}

app.whenReady().then(async () => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kab-editor-check-'));
  esbuild.buildSync({ stdin: { contents: source, resolveDir: process.cwd(), loader: 'js' }, bundle: true, platform: 'browser', outfile: path.join(temp, 'lab.js') });
  fs.writeFileSync(path.join(temp, 'index.html'), '<!doctype html><html><body><script src="lab.js"></script></body></html>');
  await openWindow();
  const names = await window.webContents.executeJavaScript('caseNames()');
  for (let i = 0; i < names.length; i += 1) {
    let r;
    try {
      r = await Promise.race([
        window.webContents.executeJavaScript(`runCase(${i})`),
        new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: 'hang: no answer in ' + CASE_TIMEOUT_MS + ' ms' }), CASE_TIMEOUT_MS)),
      ]);
    } catch (error) {
      r = { ok: false, error: String(error && error.message || error) };
    }
    results.push({ name: names[i], ...r });
    console.log((r.ok ? 'ok   ' : 'FAIL ') + names[i] + (r.ok ? '' : ' ' + JSON.stringify(r)));
    if (r.error && r.error.startsWith('hang')) { window.destroy(); await openWindow(); }
  }
  report({ status: 'complete', electron: process.versions.electron, results });
  clearTimeout(overall);
  fs.rmSync(temp, { recursive: true, force: true });
  app.exit(0);
}).catch((error) => {
  console.error(error);
  report({ status: 'error', error: String(error.stack || error), results });
  app.exit(2);
});
