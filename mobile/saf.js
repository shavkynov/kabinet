// Доступ к обычной папке на Android (плагин Saf, android-src/SafPlugin.java).
// Папку выбирает сам пользователь системным окном: это может быть память телефона,
// карточка, Яндекс.Диск, Google Drive или Dropbox — что видит проводник Android.
// Разрешение сохраняется между запусками, поэтому проект в такой папке работает
// как облачная папка на компьютере.

import { Capacitor, registerPlugin } from '@capacitor/core';

const Saf = registerPlugin('Saf');

const fromB64 = (b64) => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
};

function toB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

// Только настоящее «файла нет». Раньше регэксп /нет/ ловил и «Нет доступа к папке…», и ошибка выглядела как пропавший файл.
const isNotFound = (e) => !!e && (e.code === 'ENOENT' || /^Файла нет:|ENOENT|No such file|does not exist/i.test(String(e.message || e)));

/**
 * Интерфейс для createFolderSync (src/folder.js): list/read/write/remove/mkdir
 * с относительными путями через «/». read отдаёт null, когда файла нет.
 *
 * uri — папка именно этого проекта. Плагин помнит последнюю выбранную папку, но проектов
 * с разными папками может быть несколько: без uri второй проект писал бы в чужую папку.
 */
export function createSafAdapter(uri) {
  const base = uri ? { uri } : {};
  return {
    async list(rel) {
      const res = await Saf.list({ ...base, path: rel || '' });
      return (res && res.items ? [...res.items] : []).map((x) => ({ name: x.name, dir: !!x.dir, size: Number(x.size), mtime: Number(x.mtime) }));
    },
    async read(rel) {
      try {
        const res = await Saf.read({ ...base, path: rel });
        return res && res.data ? fromB64(res.data) : null;
      } catch (e) {
        if (isNotFound(e)) return null;
        throw e;
      }
    },
    async write(rel, bytes) {
      await Saf.write({ ...base, path: rel, data: toB64(bytes) });
    },
    async remove(rel) {
      try { await Saf.remove({ ...base, path: rel }); } catch (e) { if (!isNotFound(e)) throw e; }
    },
    async mkdir(rel) {
      if (!rel) return;
      try { await Saf.mkdir({ ...base, path: rel }); } catch (e) { if (!isNotFound(e)) throw e; }
    },
  };
}

/** Выбор папки системным окном. null — пользователь отменил. */
export async function chooseFolder() {
  const res = await Saf.chooseFolder({});
  return res && res.uri ? { uri: res.uri, name: res.name || '' } : null;
}

export async function forgetFolder(uri) {
  try { await Saf.forgetFolder(uri ? { uri } : {}); } catch { /* доступ уже снят */ }
}

export const safAvailable = () => Capacitor.isNativePlatform();
