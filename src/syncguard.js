'use strict';

// Защита данных при синхронизации: другое устройство может подменить файл, пока он открыт у нас. Перед записью сверяем, не изменился ли файл с тех пор, как мы его читали.
// Если изменился, чужую версию сохраняем в папку «Конфликты», а потом пишем свою: ничего не теряется.

const fs = require('fs');
const path = require('path');
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
const FOREIGN = 'с другого устройства';
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
  // Имя: время + название + пометка; если оно занято другой версией, добавляется номер. Та же версия переиспользуется.
  const head = `${stamp(now)} `;
  const tail = ` (${FOREIGN})`;
  let title = '';
  for (const char of safeName(label)) { // имя файла не длиннее ~220 байт: запас под номер, расширение и временный суффикс записи
    if (Buffer.byteLength(head + title + char + tail, 'utf8') > 200) break;
    title += char;
  }
  const base = head + title + tail;
  const ext = path.extname(file);
  for (let n = 1; n <= 9; n += 1) {
    const name = `${base}${n > 1 ? ` ${n}` : ''}${ext}`;
    const target = path.join(folder, name);
    try {
      if (fs.readFileSync(target, 'utf8') === disk) return name;
      continue;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    writeFileAtomic(target, disk);
    return name;
  }
  throw new Error('Копия в «Конфликты» уже существует и была изменена. Сохранение остановлено, чтобы не затереть её.');
}

module.exports = { CONFLICT_DIR, guardWrite, stamp, safeName };
