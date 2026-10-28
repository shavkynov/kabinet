'use strict';

const fs = require('fs');
const crypto = require('crypto');

// На Windows переименование иногда ненадолго блокируется (антивирус, индексатор): пробуем ещё несколько раз.
function renameWithRetry(from, to) {
  for (let i = 0; ; i += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (i >= 6 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (i + 1));
    }
  }
}

/**
 * Безопасная запись файла: сначала во временный файл рядом,
 * потом переименование. Если что-то пойдёт не так посреди записи,
 * старый файл останется целым.
 */
// Что программа знает о файлах. Нужно для синхронизации через облако:
//   known: хэш текста, который программа последним прочитала или записала (защита от затирания чужих правок);
//   wrote: хэш того, что записала она сама (чтобы следилка не принимала свои записи за чужие).
const known = new Map();
const wrote = new Map();
const hashText = (text) => crypto.createHash('sha1').update(String(text)).digest('hex');
const noteRead = (file, text) => { known.set(file, hashText(text)); };
const knownHash = (file) => known.get(file);
const lastWritten = (file) => wrote.get(file);

function writeFileAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, data, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    renameWithRetry(tmp, file);
    if (typeof data === 'string') {
      const h = hashText(data);
      known.set(file, h);
      wrote.set(file, h);
    }
  } catch (err) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

module.exports = { writeFileAtomic, hashText, noteRead, knownHash, lastWritten };
