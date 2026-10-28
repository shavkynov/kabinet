'use strict';

// Список недавних проектов. Хранится в папке данных приложения, не в проектах.

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./fsutil');

const MAX = 15;

function readRaw(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(data)) return [];
    return data.filter((x) => x && typeof x.path === 'string');
  } catch {
    return [];
  }
}

function write(file, list) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify(list, null, 2));
}

function add(file, entry) {
  const list = readRaw(file).filter((x) => x.path !== entry.path);
  list.unshift({ path: entry.path, name: entry.name, lastOpened: new Date().toISOString() });
  write(file, list.slice(0, MAX));
}

function remove(file, projectPath) {
  write(file, readRaw(file).filter((x) => x.path !== projectPath));
}

function has(file, projectPath) {
  return readRaw(file).some((x) => x.path === projectPath);
}

/** Список для показа; exists = false, если папка проекта исчезла (диск отключён, папку перенесли). */
function list(file) {
  return readRaw(file).map((x) => ({
    ...x,
    exists: fs.existsSync(path.join(x.path, 'project.json')),
  }));
}

module.exports = { add, remove, has, list };
