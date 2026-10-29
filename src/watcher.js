'use strict';

// Следит за файлами проекта и сообщает, когда что-то изменилось не нашей записью
// (например, облако принесло правки с другого устройства).

const fs = require('fs');
const path = require('path');
const { hashText, lastWritten } = require('./fsutil');

const FOLDERS = new Set(['Главы', 'Персонажи', 'Места', 'Предметы', 'Заметки']);

/** Относительный путь (с «/») интересен, если это project.json, файл глав, карточек или заметок. */
function isRelevant(rel) {
  const parts = String(rel).split(/[\\/]/).filter(Boolean);
  if (!parts.length) return false;
  const name = parts[parts.length - 1];
  if (name.endsWith('.tmp') || name.startsWith('.') || name === '.DS_Store') return false;
  if (parts.length === 1) return /^project.*\.json$/.test(name);
  return parts.length === 2 && FOLDERS.has(parts[0]);
}

/** Снимок «имя -> время изменения и размер» по нужным файлам: запасной способ, если система не прислала событие. */
function snapshot(dir) {
  const out = new Map();
  const add = (rel) => {
    try {
      const st = fs.statSync(path.join(dir, rel));
      out.set(rel, `${st.mtimeMs}:${st.size}`);
    } catch { /* файл исчез между чтением папки и проверкой */ }
  };
  try {
    for (const name of fs.readdirSync(dir)) if (isRelevant(name)) add(name);
  } catch { /* папка недоступна */ }
  for (const folder of FOLDERS) {
    try {
      for (const name of fs.readdirSync(path.join(dir, folder))) if (isRelevant(`${folder}/${name}`)) add(`${folder}/${name}`);
    } catch { /* папки может не быть */ }
  }
  return out;
}

function createWatcher(dir, onChange, { delay = 800, pollMs = 5000 } = {}) {
  const pending = new Set();
  const seen = new Map(); // что уже сообщали: путь -> хэш
  let timer = null;
  let w = null;

  function flush() {
    timer = null;
    const files = [];
    for (const rel of pending) {
      const file = path.join(dir, rel);
      let h = null;
      try { h = hashText(fs.readFileSync(file, 'utf8')); } catch { /* файла нет */ }
      if (h !== null && (h === lastWritten(file) || h === seen.get(file))) continue; // это наша запись или уже сообщали
      if (h === null && !seen.has(file) && lastWritten(file) === undefined) continue; // чужой временный файл
      seen.set(file, h);
      files.push(rel.split(path.sep).join('/'));
    }
    pending.clear();
    if (files.length) onChange(files);
  }

  const queue = (rel) => {
    pending.add(rel);
    clearTimeout(timer);
    timer = setTimeout(flush, delay);
  };

  // Запасной опрос: события файловой системы бывают неполными (замена файла, сетевые и облачные папки).
  let snap = snapshot(dir);
  const poller = setInterval(() => {
    const now = snapshot(dir);
    for (const [rel, sig] of now) if (snap.get(rel) !== sig) queue(rel);
    for (const rel of snap.keys()) if (!now.has(rel)) queue(rel);
    snap = now;
  }, pollMs);
  poller.unref();

  try {
    w = fs.watch(dir, { recursive: true }, (_ev, name) => {
      if (!name) return;
      const rel = String(name);
      if (isRelevant(rel)) queue(rel);
    });
    w.on('error', () => { /* папку отключили: следить больше нечем */ });
  } catch (err) {
    console.error('watch unavailable:', err.message);
  }

  return {
    close() {
      clearTimeout(timer);
      clearInterval(poller);
      if (w) { try { w.close(); } catch { /* ignore */ } }
      w = null;
    },
  };
}

module.exports = { createWatcher, isRelevant };
