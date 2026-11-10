'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomic } = require('./fsutil');
const FORMATS = new Set(['pdf', 'docx', 'rtf', 'md', 'txt', 'html']);
function settingsFile(dataDir, projectDir) {
  const key = crypto.createHash('sha256').update(path.resolve(projectDir)).digest('hex');
  return path.join(dataDir, 'export-targets', `${key}.json`);
}
function defaultPath(dataDir, projectDir, documents) {
  let saved;
  try { saved = JSON.parse(fs.readFileSync(settingsFile(dataDir, projectDir), 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return path.join(documents, `${path.basename(projectDir)}.pdf`); throw err; }
  if (!saved || typeof saved.folder !== 'string' || !path.isAbsolute(saved.folder) || !FORMATS.has(saved.format)) {
    throw new Error('Invalid export destination settings');
  }
  let folder = documents;
  try { if (fs.statSync(saved.folder).isDirectory()) folder = saved.folder; }
  catch (err) { if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(err.code)) throw err; }
  return path.join(folder, `${path.basename(projectDir)}.${saved.format}`);
}
function remember(dataDir, projectDir, file) {
  const format = path.extname(file).slice(1).toLowerCase();
  if (!path.isAbsolute(file) || !FORMATS.has(format)) throw new Error('Invalid export destination');
  const target = settingsFile(dataDir, projectDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  writeFileAtomic(target, JSON.stringify({ folder: path.dirname(file), format }) + '\n');
}
module.exports = { defaultPath, remember };
