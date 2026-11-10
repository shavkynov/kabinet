'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const esbuild = require('esbuild');
const output = path.resolve('ci-diagnostics/editor-roundtrip.json');
let window;
let temp;
function report(value) {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(value, null, 2) + '\n');
}
app.on('window-all-closed', () => {});
const timeout = setTimeout(() => {
  report({ status: 'error', error: 'Editor check timed out', results: [] });
  app.exit(2);
}, 60000);
app.whenReady().then(async () => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kab-editor-check-'));
  const source = `
    import { Editor } from '@tiptap/core';
    import StarterKit from '@tiptap/starter-kit';
    import { Markdown } from 'tiptap-markdown';
    import { AlignParagraph } from './renderer/align.js';
    import { Typography, fixDocTypography } from './renderer/typo.js';
    globalThis.collectEditorChecks = () => {
      const results = [];
      const paragraph = (text, attrs) => ({ type: 'paragraph', ...(attrs ? { attrs } : {}), ...(text ? { content: [{ type: 'text', text }] } : {}) });
      const create = (content) => new Editor({ element: document.createElement('div'), extensions: [StarterKit.configure({ paragraph: false }), AlignParagraph, Typography, Markdown.configure({ html: false, tightLists: true, breaks: false, transformPastedText: true })], content });
      const emptyCount = (e) => e.getJSON().content.filter((n) => n.type === 'paragraph' && (!n.content || !n.content.length)).length;
      for (let count = 1; count <= 3; count++) {
        const e = create({ type: 'doc', content: [paragraph('A'), ...Array.from({ length: count }, () => paragraph()), paragraph('B')] });
        const markdown = e.storage.markdown.getMarkdown();
        const reopened = create(markdown);
        const actual = emptyCount(reopened);
        results.push({ name: 'empty-paragraph-roundtrip-' + count, ok: actual === count, expected: count, actual, markdown });
        reopened.destroy(); e.destroy();
      }
      for (let keep = 0; keep <= 3; keep++) {
        const e = create({ type: 'doc', content: [paragraph('A'), ...Array.from({ length: 4 }, () => paragraph()), paragraph('B')] });
        const before = JSON.stringify(e.getJSON());
        fixDocTypography(e, { dropEmpty: true, keepEmpty: keep, quotes: true, dashes: true, nbsp: false, lang: 'ru' });
        const actual = emptyCount(e);
        const undone = e.commands.undo();
        results.push({ name: 'typography-and-single-undo-' + keep, ok: actual === keep && undone && JSON.stringify(e.getJSON()) === before, expected: keep, actual, undone });
        e.destroy();
      }
      for (const align of ['center', 'right']) {
        const e = create({ type: 'doc', content: [paragraph('Text', { textAlign: align })] });
        const markdown = e.storage.markdown.getMarkdown();
        const reopened = create(markdown);
        const actual = reopened.getJSON().content[0].attrs?.textAlign;
        results.push({ name: 'alignment-roundtrip-' + align, ok: actual === align, expected: align, actual, markdown });
        reopened.destroy(); e.destroy();
      }
      for (const edge of ['leading', 'trailing', 'only']) {
        for (let count = 1; count <= 3; count++) {
          const blanks = Array.from({ length: count }, () => paragraph());
          const content = edge === 'leading' ? [...blanks, paragraph('B')] : edge === 'trailing' ? [paragraph('A'), ...blanks] : blanks;
          const e = create({ type: 'doc', content });
          const markdown = e.storage.markdown.getMarkdown();
          const reopened = create(markdown);
          const actual = emptyCount(reopened);
          results.push({ name: 'empty-boundary-' + edge + '-' + count, ok: actual === count, expected: count, actual, markdown });
          reopened.destroy(); e.destroy();
        }
      }

      // Старые и вложенные случаи: второй проход не меняет файл, текст и разметка не теряются, пустые строки в коде остаются.
      const texts = (e) => { const out = []; e.state.doc.descendants((n) => { if (n.isTextblock && n.textContent.trim()) out.push(n.type.name + ':' + n.textContent); }); return out; };
      const blanksIn = (s) => (s.match(/\n\n\n/g) || []).length;
      const sources = {
        'old-2-blank-lines': 'A\n\n\nB',
        'old-3-blank-lines': 'A\n\n\n\nB',
        'old-4-blank-lines-and-final-newline': 'A\n\n\n\n\nB\n',
        'crlf': 'A\r\n\r\n\r\nB',
        'list-then-blanks': '- a\n- b\n\n\n\nC',
        'quote-with-blank-inside': '> a\n>\n> b\n\n\n\nC',
        'code-with-blank-lines': '```\na\n\n\nb\n```\n\n\nC',
        'marks-around-blanks': '**жирный**\n\n\n*курсив*\n\n\n[ссылка](http://x.y)',
        'aligned-around-blanks': '-> A <-\n\n\n\n-> B ->',
        'heading-then-blanks': '# H\n\n\n\nA',
        'rule-around-blanks': 'A\n\n\n---\n\n\nB',
        'ordered-list': '1. a\n2. b\n\n\nC',
      };
      for (const [name, src] of Object.entries(sources)) {
        const first = create(src);
        const md1 = first.storage.markdown.getMarkdown();
        const second = create(md1);
        const md2 = second.storage.markdown.getMarkdown();
        const same = JSON.stringify(texts(first)) === JSON.stringify(texts(second));
        const plain = create(src.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n'));
        const keepsText = JSON.stringify(texts(first)) === JSON.stringify(texts(plain));
        results.push({ name: 'source-' + name, ok: md1 === md2 && same && keepsText, stable: md1 === md2, sameText: same, keepsText, source: src, markdown: md1, empties: emptyCount(first) });
        first.destroy(); second.destroy(); plain.destroy();
      }
      for (const [name, wrap] of Object.entries({ quote: 'blockquote', item: 'listItem' })) {
        const inner = [paragraph('a'), paragraph(), paragraph('b')];
        const body = wrap === 'listItem' ? { type: 'bulletList', content: [{ type: 'listItem', content: inner }] } : { type: 'blockquote', content: inner };
        const e = create({ type: 'doc', content: [body, paragraph('C')] });
        const md1 = e.storage.markdown.getMarkdown();
        const re = create(md1);
        const md2 = re.storage.markdown.getMarkdown();
        results.push({ name: 'nested-empty-' + name, ok: md1 === md2 && JSON.stringify(texts(e)) === JSON.stringify(texts(re)), markdown: md1, stable: md1 === md2, sameText: JSON.stringify(texts(e)) === JSON.stringify(texts(re)) });
        e.destroy(); re.destroy();
      }
      const code = create({ type: 'doc', content: [{ type: 'codeBlock', content: [{ type: 'text', text: 'a\n\n\nb' }] }, paragraph('C')] });
      const cmd = code.storage.markdown.getMarkdown();
      const code2 = create(cmd);
      results.push({ name: 'code-blank-lines-kept', ok: code2.getJSON().content[0].content[0].text === 'a\n\n\nb', markdown: cmd });
      code.destroy(); code2.destroy();
      return results;
    };
  `;
  esbuild.buildSync({ stdin: { contents: source, resolveDir: process.cwd(), loader: 'js' }, bundle: true, platform: 'browser', outfile: path.join(temp, 'lab.js') });
  fs.writeFileSync(path.join(temp, 'index.html'), '<!doctype html><html><body><script src="lab.js"></script></body></html>');
  window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadFile(path.join(temp, 'index.html'));
  const results = await window.webContents.executeJavaScript('collectEditorChecks()');
  report({ status: 'complete', electron: process.versions.electron, results });
  window.destroy(); clearTimeout(timeout);
  fs.rmSync(temp, { recursive: true, force: true });
  app.exit(0);
}).catch((error) => {
  console.error(error);
  report({ status: 'error', error: String(error.stack || error), results: [] });
  if (window && !window.isDestroyed()) window.destroy();
  if (temp) fs.rmSync(temp, { recursive: true, force: true });
  app.exit(2);
});
