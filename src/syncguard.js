'use strict';

// Защита данных при работе через облако (iCloud Drive, Dropbox и т.п.): облако может подменить файл,
// пока он открыт у нас. Перед записью сверяем, не изменился ли файл с тех пор, как мы его читали.
// Если изменился, чужую версию сохраняем в папку «Конфликты», а потом пишем свою: ничего не теряется.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { writeFileAtomic, hashText, knownHash } = require('./fsutil');

const CONFLICT_DIR = 'Конфликты';

const pad = (n) => String(n).padStart(2, '0');
function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|\n\r\t]/g, '-').replace(/^\.+/, '').trim().slice(0, 60) || 'без названия';

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
  const name = `${stamp(now)} ${safeName(label)} (с другого устройства)${path.extname(file)}`;
  writeFileAtomic(path.join(folder, name), disk);
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

module.exports = { CONFLICT_DIR, guardWrite, requestDownload, assertNotPlaceholder, stamp, safeName };
