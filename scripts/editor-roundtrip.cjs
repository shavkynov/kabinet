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
