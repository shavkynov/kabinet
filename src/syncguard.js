'use strict';

// Защита данных при работе через облако (iCloud Drive, Dropbox и т.п.): облако может подменить файл,
// пока он открыт у нас. Перед записью сверяем, не изменился ли файл с тех пор, как мы его читали.
// Если изменился, чужую версию сохраняем в папку «Конфликты», а потом пишем свою: ничего не теряется.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { writeFileAtomic, hashText, knownHash } = require('./fsutil');

const CONFLICT_DIR = 'Конфликты';

const pad = (n) => String(n).padStart(2, '0');
function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|\n\r\t]/g, '-').replace(/^\.+/, '').trim().slice(0, 60) || 'без названия';

// Полный SHA-256 содержимого различает версии даже при одинаковых времени и названии.
// Ограничиваем байты имени с запасом под временный суффикс writeFileAtomic.
function conflictName(label, ext, data, now = new Date(), suffix = 'с другого устройства') {
  const digest = crypto.createHash('sha256').update(data).digest('hex');
  const head = `${stamp(now)} `;
  const tail = ` (${suffix}) ${digest}${ext}`;
  let title = '';
  for (const char of safeName(label)) {
    if (Buffer.byteLength(head + title + char + tail, 'utf8') > 220) break;
    title += char;
  }
  return head + title + tail;
}

/**
 * Кандидаты имени конфликтной копии: обычное (время + название) и с SHA-256 содержимого.
 * Второе нужно, если под обычным именем уже лежит другая версия (та же секунда, то же название).
 */
function conflictNames(label, suffix, ext, data, now = new Date()) {
  return [
    `${stamp(now)} ${safeName(label)} (${suffix})${ext}`,
    conflictName(label, ext, data, now, suffix),
  ];
}

/**
 * Вызывать перед записью файла. Возвращает имя сохранённой чужой версии или null, если конфликта нет.
 * label: название главы или карточки для имени файла.
 */
function guardWrite(dir, file, newText, label, now = new Date()) {
  const k = knownHash(file);
  if (!k) return null; // файл в этом сеансе не читали: сравнивать не с чем
  let disk;
  try {
    disk = fs.readFileSync(file, 'utf8');
  } catch {
    return null; // файла нет (удалён на другом устройстве): просто запишем свой
  }
  const h = hashText(disk);
  if (h === k || h === hashText(newText)) return null;
  const folder = path.join(dir, CONFLICT_DIR);
  fs.mkdirSync(folder, { recursive: true });
  const name = conflictName(label, path.extname(file), disk, now);
  const target = path.join(folder, name);
  try {
    const saved = fs.readFileSync(target, 'utf8');
    if (saved === disk) return name;
    throw new Error('Копия в «Конфликты» уже существует и была изменена. Сохранение остановлено, чтобы не затереть её.');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  writeFileAtomic(target, disk);
  return name;
}

/** Просим macOS скачать файл или папку из iCloud (если это не iCloud, ничего не произойдёт). */
function requestDownload(target) {
  if (process.platform !== 'darwin') return;
  try {
    execFile('brctl', ['download', target], () => {});
  } catch { /* не критично */ }
}

const PLACEHOLDER_MSG = 'Файл ещё не скачан из iCloud. Подождите немного и откройте его снова.';

/** Если вместо файла лежит заглушка iCloud (.имя.icloud), запускаем скачивание и сообщаем понятной ошибкой. */
function assertNotPlaceholder(file) {
  const holder = path.join(path.dirname(file), `.${path.basename(file)}.icloud`);
  if (fs.existsSync(holder)) {
    requestDownload(file);
    throw new Error(PLACEHOLDER_MSG);
  }
}

module.exports = { CONFLICT_DIR, guardWrite, requestDownload, assertNotPlaceholder, stamp, safeName, conflictName, conflictNames };
