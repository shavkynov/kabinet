'use strict';

// Резервные копии проекта: обычные папки с копиями файлов, их можно открыть и взять любой файл.
// Копия делается, только если с прошлой копии что-то изменилось.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BACKUP_DIR = 'Резервные копии';
const SKIP = new Set([BACKUP_DIR, 'Корзина', 'kabinet.lock']);
const NAME_RE = /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}$/;

function listFiles(root, rel = '') {
  const out = [];
  for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? path.join(rel, entry.name) : entry.name;
    if (!rel && SKIP.has(entry.name)) continue;
    if (entry.name.endsWith('.tmp') || entry.name === '.DS_Store') continue;
    if (entry.isDirectory()) out.push(...listFiles(root, r));
    else if (entry.isFile()) out.push(r);
  }
  return out.sort();
}

// Тексты (главы, карточки, заметки, настройки) сверяем по содержимому. Картинки по размеру и времени изменения:
// они не правятся на месте (новая картинка получает новое имя), а читать их целиком при каждой проверке долго.
const TEXT_FILE_RE = /\.(md|json|txt)$/i;

function signature(root, files) {
  const h = crypto.createHash('sha1');
  for (const f of files) {
    const full = path.join(root, f);
    h.update(f);
    h.update('\0');
    if (TEXT_FILE_RE.test(f)) {
      h.update(fs.readFileSync(full));
    } else {
      const st = fs.statSync(full);
      h.update(`${st.size}:${Math.trunc(st.mtimeMs)}`);
    }
    h.update('\0');
  }
  return h.digest('hex');
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function stampName(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

/** Куда складывать копии по умолчанию: внутрь проекта. Для облачных проектов main передаёт другую папку. */
const defaultRoot = (dir) => path.join(dir, BACKUP_DIR);

function listBackups(dir, root = defaultRoot(dir)) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && NAME_RE.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Какие копии оставить: последние keep штук и самая поздняя копия каждого из keepDays последних дней,
 * в которые копии делались. Так недавняя история подробная, а старая остаётся по одной копии в день.
 * all: имена копий по возрастанию.
 */
function copiesToKeep(all, keep, keepDays) {
  const set = new Set(all.slice(Math.max(0, all.length - Math.max(0, keep))));
  const days = new Set();
  for (let i = all.length - 1; i >= 0 && keepDays > 0; i -= 1) {
    const day = all[i].slice(0, 10);
    if (days.has(day)) continue;
    if (days.size >= keepDays) break;
    days.add(day);
    set.add(all[i]);
  }
  return set;
}

/**
 * Делает копию проекта. Возвращает имя папки копии или null, если менять было нечего.
 * keep: сколько последних копий хранить; keepDays: за сколько последних дней хранить по копии на день;
 * root: папка для копий (по умолчанию «Резервные копии» внутри проекта).
 */
function makeBackup(dir, { keep = 60, keepDays = 30, now = new Date(), root = defaultRoot(dir) } = {}) {
  const files = listFiles(dir);
  if (files.length === 0) return null;
  const sig = signature(dir, files);
  const existing = listBackups(dir, root);
  const last = existing[existing.length - 1];
  if (last) {
    try {
      if (fs.readFileSync(path.join(root, last, '.sig'), 'utf8').trim() === sig) return null;
    } catch { /* нет подписи: делаем копию */ }
  }

  let name = stampName(now);
  if (existing.includes(name)) return null; // две копии в одну секунду не нужны
  const target = path.join(root, name);
  const tmp = `${target}.tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const f of files) {
    const to = path.join(tmp, f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(dir, f), to);
  }
  fs.writeFileSync(path.join(tmp, '.sig'), sig);
  fs.renameSync(tmp, target);

  const all = listBackups(dir, root);
  const keepSet = copiesToKeep(all, keep, keepDays);
  keepSet.add(name); // только что сделанную копию не удаляем никогда
  for (const old of all) {
    if (!keepSet.has(old)) fs.rmSync(path.join(root, old), { recursive: true, force: true });
  }
  return name;
}

module.exports = { BACKUP_DIR, makeBackup, listBackups, copiesToKeep };
