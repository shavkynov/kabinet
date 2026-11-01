'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const root = path.join(__dirname, '..');
const version = '0.36.2';
const previous = '0.36.1';
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
assert.equal(pkg.name, 'kabinet');
assert.equal(lock.name, 'kabinet');
assert.ok(lock.packages && lock.packages['']);
for (const actual of [pkg.version, lock.version, lock.packages[''].version]) {
  assert.ok(actual === previous || actual === version, `Unexpected version: ${actual}`);
}
const notes = read('docs/releases/0.36.2.txt').trim();
assert.ok(notes.startsWith(`${version}\n`));
let changelog = read('CHANGELOG.txt');
const hasVersion = changelog.split(/\r?\n/).some((line) => line.trim() === version);
if (hasVersion) {
  assert.ok(changelog.includes(notes), 'Existing changelog section differs; refusing to overwrite it.');
} else {
  changelog = `${changelog.trimEnd()}\n\n${notes}\n\n`;
}
pkg.version = version;
lock.version = version;
lock.packages[''].version = version;
fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
fs.writeFileSync(path.join(root, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
fs.writeFileSync(path.join(root, 'CHANGELOG.txt'), changelog);
