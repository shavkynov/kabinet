'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const diag = require('../src/sync-diag');
const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('desktop release entry does not install diagnostic reports', () => {
  const entry = read('src/electron-entry.js');
  assert.doesNotMatch(entry, /sync-diag|sync-metrics/);
  assert.ok(entry.includes("require('./yandex-desktop').installYandexDesktop()"));
  assert.ok(entry.includes("require('../main')"));
});

test('Android release explicitly disables diagnostics while retaining import UI', () => {
  assert.match(read('mobile/wait-box.js'), /syncDiag\.install\(\{\s*overlay:\s*true,\s*diagnostics:\s*false\s*\}\)/);
});

test('release configuration mounts progress but no diagnostic buttons or report writer', () => {
  diag.reset();
  class Element {
    constructor(tag) { this.tag = tag; this.style = {}; this.children = []; this.attrs = new Map(); this.hidden = false; }
    append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
    setAttribute(name, value) { this.attrs.set(name, value); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((node) => node !== this); }
  }
  const doc = { body: new Element('body'), createElement: (tag) => new Element(tag), removeEventListener() {} };
  const folder = { createFolderSync() { return {}; } };
  const original = folder.createFolderSync;
  let fileCalls = 0;
  const off = diag.install({ folder, doc, win: {}, overlay: true, diagnostics: false, file: () => { fileCalls += 1; throw new Error('Unexpected report access'); } });
  try {
    assert.equal(doc.body.children.length, 1);
    const banner = doc.body.children[0];
    assert.equal(banner.tag, 'section');
    assert.equal(banner.hidden, true);
    diag.startRun('importAll');
    assert.equal(banner.hidden, false);
    assert.equal(fileCalls, 0);
    assert.ok(banner.children.every((node) => node.tag !== 'button'));
  } finally { off(); diag.reset(); }
  assert.equal(doc.body.children.length, 0);
  assert.equal(folder.createFolderSync, original);
});
