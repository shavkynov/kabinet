'use strict';

// renderer/app/NN-имя.js — части одного файла: склеиваются по номерам в renderer/app.gen.js
// (общие переменные у частей общие, поэтому это не модули, а куски одного скрипта).
// app.gen.js генерируется, руками не правится и не коммитится.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const partsDir = path.join(root, 'renderer', 'app');
const outFile = path.join(root, 'renderer', 'app.gen.js');

function partFiles() {
  return fs.readdirSync(partsDir).filter((f) => /^\d\d-.+\.js$/.test(f)).sort();
}

function buildApp() {
  const code = partFiles().map((f) => fs.readFileSync(path.join(partsDir, f), 'utf8')).join('');
  if (!fs.existsSync(outFile) || fs.readFileSync(outFile, 'utf8') !== code) fs.writeFileSync(outFile, code);
  return outFile;
}

module.exports = { buildApp, partFiles, partsDir, outFile };
