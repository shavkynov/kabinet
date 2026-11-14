'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { guardWrite } = require('../src/syncguard');
const { noteRead } = require('../src/fsutil');

const now = new Date(2026, 10, 14, 3, 37, 0);
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kabinet-conflict-collision-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'aaaaaa.md');
  noteRead(file, 'base');
  return { dir, file };
}

test('two foreign versions in the same second must both remain', (t) => {
  const { dir, file } = setup(t);
  fs.writeFileSync(file, 'foreign one');
  const first = guardWrite(dir, file, 'mine', 'Chapter', now);
  fs.writeFileSync(file, 'foreign two');
  const second = guardWrite(dir, file, 'mine', 'Chapter', now);
  assert.notEqual(first, second);
  assert.equal(fs.readFileSync(path.join(dir, 'Конфликты', first), 'utf8'), 'foreign one');
  assert.equal(fs.readFileSync(path.join(dir, 'Конфликты', second), 'utf8'), 'foreign two');
});

test('documents with the same label do not replace each other', (t) => {
  const { dir, file } = setup(t);
  const other = path.join(dir, 'bbbbbb.md');
  noteRead(other, 'base');
  fs.writeFileSync(file, 'first document');
  fs.writeFileSync(other, 'second document');
  const first = guardWrite(dir, file, 'mine', 'Same title', now);
  const second = guardWrite(dir, other, 'mine', 'Same title', now);
  assert.notEqual(first, second);
  assert.equal(fs.readFileSync(path.join(dir, 'Конфликты', first), 'utf8'), 'first document');
});


test('an existing legacy conflict is not overwritten', (t) => {
  const { dir, file } = setup(t);
  const folder = path.join(dir, 'Конфликты');
  fs.mkdirSync(folder);
  const legacy = '2026-11-14 03-37-00 Chapter (с другого устройства).md';
  fs.writeFileSync(path.join(folder, legacy), 'legacy version');
  fs.writeFileSync(file, 'new foreign version');
  const name = guardWrite(dir, file, 'mine', 'Chapter', now);
  assert.notEqual(name, legacy);
  assert.equal(fs.readFileSync(path.join(folder, legacy), 'utf8'), 'legacy version');
  assert.equal(fs.readFileSync(path.join(folder, name), 'utf8'), 'new foreign version');
});

test('retrying the same foreign version preserves its content', (t) => {
  const { dir, file } = setup(t);
  fs.writeFileSync(file, 'foreign');
  const first = guardWrite(dir, file, 'mine', 'Chapter', now);
  const second = guardWrite(dir, file, 'mine', 'Chapter', now);
  assert.equal(first, second);
  assert.equal(fs.readFileSync(path.join(dir, 'Конфликты', first), 'utf8'), 'foreign');
});

test('long unicode labels keep a usable filename and extension', (t) => {
  const { dir, file } = setup(t);
  fs.writeFileSync(file, 'foreign');
  const name = guardWrite(dir, file, 'mine', '漢'.repeat(60), now);
  assert.ok(Buffer.byteLength(name, 'utf8') <= 220);
  assert.equal(path.extname(name), '.md');
  assert.equal(fs.readFileSync(path.join(dir, 'Конфликты', name), 'utf8'), 'foreign');
});

test('unchanged and identical versions remain non-conflicts', (t) => {
  const { dir, file } = setup(t);
  fs.writeFileSync(file, 'base');
  assert.equal(guardWrite(dir, file, 'mine', 'Chapter', now), null);
  fs.writeFileSync(file, 'mine');
  assert.equal(guardWrite(dir, file, 'mine', 'Chapter', now), null);
  assert.equal(fs.existsSync(path.join(dir, 'Конфликты')), false);
});

test('copy failure stops the guard without altering the source', (t) => {
  const { dir, file } = setup(t);
  fs.writeFileSync(file, 'foreign');
  fs.writeFileSync(path.join(dir, 'Конфликты'), 'not a directory');
  assert.throws(() => guardWrite(dir, file, 'mine', 'Chapter', now));
  assert.equal(fs.readFileSync(file, 'utf8'), 'foreign');
});


test('a manually edited conflict copy is not replaced on retry', (t) => {
  const { dir, file } = setup(t);
  fs.writeFileSync(file, 'foreign');
  const name = guardWrite(dir, file, 'mine', 'Chapter', now);
  const target = path.join(dir, 'Конфликты', name);
  fs.writeFileSync(target, 'manually edited copy');
  assert.throws(() => guardWrite(dir, file, 'mine', 'Chapter', now), /Сохранение остановлено/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'manually edited copy');
  assert.equal(fs.readFileSync(file, 'utf8'), 'foreign');
});
