'use strict';

// Облачные папки: определяем, где лежит проект, ищем копии-конфликты, которые создаёт облако,
// и ведём замок «проект открыт на другом устройстве».

const fs = require('fs');
const os = require('os');
const path = require('path');
const project = require('./project');
const { writeFileAtomic } = require('./fsutil');
const { CONFLICT_DIR, stamp } = require('./syncguard');

/** Название облачного сервиса по пути папки или null. */
function detectCloud(dir) {
  const p = String(dir).replace(/\\/g, '/').toLowerCase();
  if (p.includes('/library/mobile documents/') || p.includes('com~apple~clouddocs')) return 'iCloud Drive';
  if (p.includes('/dropbox')) return 'Dropbox';
  if (p.includes('googledrive') || p.includes('google drive')) return 'Google Drive';
  if (p.includes('onedrive')) return 'OneDrive';
  if (p.includes('yandex') && p.includes('disk')) return 'Яндекс Диск';
  if (p.includes('/яндекс.диск') || p.includes('/yandexdisk')) return 'Яндекс Диск';
  return null;
}

// ---------- копии-конфликты, которые создаёт облако ----------

const FOLDERS = { 'Главы': '.md', 'Персонажи': '.json', 'Места': '.json', 'Заметки': '.md' };

/** Файлы вида «<id> 2.md», «<id> (conflicted copy …).md», «project (1).json»: облако так помечает спорные версии. */
function findConflictCopies(dir) {
  const view = project.openProject(dir);
  const ids = new Set([...view.chapters, ...view.characters, ...view.places, ...view.notes].map((x) => x.id));
  const out = [];
  for (const [folder, ext] of Object.entries(FOLDERS)) {
    let names = [];
    try { names = fs.readdirSync(path.join(dir, folder)); } catch { continue; }
    for (const name of names) {
      if (name.startsWith('.') || !name.endsWith(ext) || name.endsWith('.tmp')) continue;
      const base = name.slice(0, -ext.length);
      if (ids.has(base)) continue;
      const m = /^([a-z0-9]{6,32})[\s(._-]/.exec(base);
      if (m && ids.has(m[1])) out.push(`${folder}/${name}`);
    }
  }
  let top = [];
  try { top = fs.readdirSync(dir); } catch { /* нет доступа */ }
  for (const name of top) {
    if (/^project[\s(].*\.json$/.test(name)) out.push(name);
  }
  return out;
}

/** Переносит найденные копии в «Конфликты/<дата>/…». Ничего не удаляется. Возвращает число перенесённых. */
function moveConflictCopies(dir, list) {
  if (!list.length) return 0;
  const base = path.join(dir, CONFLICT_DIR, `облако ${stamp()}`);
  let n = 0;
  for (const rel of list) {
    const from = path.join(dir, rel);
    const to = path.join(base, rel);
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      n += 1;
    } catch (err) {
      console.error('conflict move:', err);
    }
  }
  return n;
}

// ---------- замок «открыто на другом устройстве» ----------

const LOCK_FILE = 'kabinet.lock';
const LOCK_FRESH_MS = 3 * 60 * 1000;
const deviceName = () => os.hostname();

function readLock(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, LOCK_FILE), 'utf8'));
    if (raw && typeof raw.device === 'string' && Number.isFinite(raw.time)) return { device: raw.device, time: raw.time };
  } catch { /* замка нет или он испорчен */ }
  return null;
}

/** Если проект недавно открывали на другом устройстве, возвращает { device, time }. */
function foreignLock(dir, device = deviceName(), now = Date.now()) {
  const l = readLock(dir);
  return l && l.device !== device && now - l.time < LOCK_FRESH_MS ? l : null;
}

function writeLock(dir, device = deviceName(), now = Date.now()) {
  try { writeFileAtomic(path.join(dir, LOCK_FILE), JSON.stringify({ device, time: now })); } catch (err) { console.error('lock:', err); }
}

function releaseLock(dir, device = deviceName()) {
  const l = readLock(dir);
  if (l && l.device === device) {
    try { fs.unlinkSync(path.join(dir, LOCK_FILE)); } catch { /* уже нет */ }
  }
}

module.exports = {
  detectCloud, findConflictCopies, moveConflictCopies, foreignLock, writeLock, releaseLock, readLock, LOCK_FILE, deviceName,
};
