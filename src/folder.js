'use strict';

// Двусторонняя синхронизация проекта с обычной папкой (на телефоне — выбранной через системное
// окно: локальная, Яндекс.Диск, Google Drive, Dropbox). Папка — то же самое, что облачная папка
// на компьютере: проект можно начать там, а продолжить здесь.
//
// Правило то же, что у syncguard: ничего не затираем молча. Для каждого файла храним хэш
// последней согласованной версии. Если файл изменили с обеих сторон, чужую версию кладём
// в «Конфликты», своей продолжаем работать и отправляем её наружу.
//
// adapter — асинхронный доступ к внешней папке (на телефоне его даёт плагин Saf):
//   list(rel)            → [{ name, dir }]
//   read(rel)            → Uint8Array | null (null: файла нет)
//   write(rel, bytes)
//   remove(rel)
//   mkdir(rel)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomic } = require('./fsutil');
const { CONFLICT_DIR, stamp, safeName } = require('./syncguard');

// Что переносим в папку и обратно. «Копии» (резервные) и временные файлы не нужны:
// на другом устройстве они только мешают. Замок kabinet.lock не входит: телефон пишет его
// в папку сам (через adapter) и иначе он вечно конфликтовал бы с компьютерным замком.
const FOLDERS = ['Главы', 'Персонажи', 'Места', 'Предметы', 'Заметки', 'Изображения', 'Корзина', CONFLICT_DIR];
const ROOT_FILES = /^project.*\.json$|^stats\.json$/;

function isSyncable(rel) {
  const parts = String(rel).split('/').filter(Boolean);
  if (!parts.length) return false;
  const name = parts[parts.length - 1];
  if (name.startsWith('.') || name.endsWith('.tmp') || name === '.DS_Store') return false;
  if (parts.length === 1) return ROOT_FILES.test(name);
  return parts.length === 2 && FOLDERS.includes(parts[0]);
}

const hashBytes = (bytes) => crypto.createHash('sha1').update(bytes).digest('hex');

/** Снимок локального проекта: относительный путь → хэш содержимого. */
function walkLocal(dir) {
  const out = new Map();
  const add = (rel) => {
    try {
      out.set(rel, hashBytes(new Uint8Array(fs.readFileSync(path.join(dir, rel)))));
    } catch { /* файл исчез между чтением папки и проверкой */ }
  };
  try {
    for (const name of fs.readdirSync(dir)) if (isSyncable(name)) add(name);
  } catch { /* нет доступа */ }
  for (const folder of FOLDERS) {
    try {
      for (const name of fs.readdirSync(path.join(dir, folder))) {
        if (isSyncable(`${folder}/${name}`)) add(`${folder}/${name}`);
      }
    } catch { /* папки может не быть */ }
  }
  return out;
}

/**
 * Снимок внешней папки: относительный путь → { hash, bytes, sig }.
 * cache (необязательно): rel → { sig, hash }. Если размер и дата файла не изменились с прошлого прохода,
 * содержимое не читается заново (bytes: null — дочитать через adapter.read, когда понадобится).
 * Пока адаптер не сообщает size и mtime (или mtime нулевой), кэш не используется.
 */
async function walkRemote(adapter, cache) {
  const out = new Map();
  const walk = async (rel) => {
    const items = await adapter.list(rel);
    for (const it of items) {
      const r = rel ? `${rel}/${it.name}` : it.name;
      if (it.dir) { await walk(r); continue; }
      if (!isSyncable(r)) continue;
      const sig = it.mtime > 0 && it.size >= 0 ? `${it.size}:${it.mtime}` : null;
      const hit = sig && cache && cache.get(r);
      if (hit && hit.sig === sig) { out.set(r, { hash: hit.hash, bytes: null, sig }); continue; }
      const bytes = await adapter.read(r);
      if (bytes) out.set(r, { hash: hashBytes(bytes), bytes, sig });
    }
  };
  await walk('');
  return out;
}

/**
 * Связка локального проекта с внешней папкой.
 * stateFile — где хранить хэши последней согласованной версии (вне проекта, чтобы не мозолить глаза).
 */
function createFolderSync(dir, adapter, { stateFile, now = () => new Date() } = {}) {
  let state = load();
  const sigCache = new Map(); // rel → { sig, hash } последнего прочитанного снаружи файла
  // Все проходы идут строго по одному: выгрузка сразу после первого выбора папки и первый же
  // проход синхронизации иначе видят разные снимки папки и «удаляют» только что записанный проект.
  let queue = Promise.resolve();
  const serial = (fn) => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
  };

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (raw && typeof raw === 'object') return { ...raw };
    } catch { /* первого снимка нет */ }
    return {};
  }

  function save() {
    try { writeFileAtomic(stateFile, JSON.stringify(state, null, 2)); } catch (err) { console.error('folder state:', err); }
  }

  /** Содержимое внешнего файла: уже прочитанное или дочитанное по требованию. */
  async function remoteBytes(entry, rel) {
    if (entry.bytes) return entry.bytes;
    const bytes = await adapter.read(rel);
    if (!bytes) throw new Error('Файл в папке недоступен. Синхронизация остановлена, ничего не удалено.');
    entry.bytes = bytes;
    return bytes;
  }

  const readLocal = (rel) => new Uint8Array(fs.readFileSync(path.join(dir, rel)));

  /** Чужую версию наружу не выбрасываем: складываем её в «Конфликты» и локально, и в папке. */
  async function keepForeign(rel, bytes, label) {
    const name = `${stamp(now())} ${safeName(label)} (с другого устройства)${path.extname(rel)}`;
    const relConflict = `${CONFLICT_DIR}/${name}`;
    const target = path.join(dir, relConflict);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeFileAtomic(target, Buffer.from(bytes));
    try {
      await adapter.mkdir(CONFLICT_DIR);
      await adapter.write(relConflict, new Uint8Array(bytes));
      state[relConflict] = hashBytes(bytes);
    } catch (err) { console.error('conflict to folder:', err); }
    return name;
  }

  const labelOf = (rel) => (rel.includes('/') ? path.basename(rel, path.extname(rel)) : rel);

  /** Один проход: что снаружи — к нам, что у нас — наружу. Возвращает списки изменений. */
  async function syncOnce() {
    const remote = await walkRemote(adapter, sigCache);
    const local = walkLocal(dir);
    const res = { pulled: [], pushed: [], removed: [], conflicts: [] };

    // Защита от неполного ответа папки (облако не отвечает, карточка отключена, провайдер вернул пусто):
    // если раньше в папке лежал project.json, а сейчас его нет, это не «удаление на другом устройстве».
    const hadRoot = Object.keys(state).some((k) => ROOT_FILES.test(k));
    const hasRoot = [...remote.keys()].some((k) => ROOT_FILES.test(k));
    if (hadRoot && !hasRoot) {
      throw new Error('В папке не видно файлов проекта (облако не отвечает или папка пуста). Синхронизация остановлена, ничего не удалено.');
    }

    const rels = [...new Set([...remote.keys(), ...local.keys(), ...Object.keys(state)])]
      .filter((rel) => isSyncable(rel))
      .sort();

    for (const rel of rels) {
      const r = remote.has(rel) ? remote.get(rel).hash : undefined;
      const l = local.get(rel);
      const b = state[rel];
      if (r === undefined && l === undefined) { delete state[rel]; continue; }
      if (r !== undefined && r === l) { state[rel] = r; continue; }

      if (r !== undefined && l !== undefined) {
        if (b === r) { await adapter.write(rel, readLocal(rel)); state[rel] = l; res.pushed.push(rel); continue; }
        if (b === l) {
          writeFileAtomic(path.join(dir, rel), Buffer.from(await remoteBytes(remote.get(rel), rel)));
          state[rel] = r;
          res.pulled.push(rel);
          continue;
        }
        await keepForeign(rel, await remoteBytes(remote.get(rel), rel), labelOf(rel));
        await adapter.write(rel, readLocal(rel));
        state[rel] = l;
        res.pushed.push(rel);
        res.conflicts.push(rel);
        continue;
      }

      if (r !== undefined) { // снаружи есть, у нас нет
        if (b === undefined) {
          const target = path.join(dir, rel);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          writeFileAtomic(target, Buffer.from(await remoteBytes(remote.get(rel), rel)));
          state[rel] = r;
          res.pulled.push(rel);
        } else {
          if (r !== b) await keepForeign(rel, await remoteBytes(remote.get(rel), rel), labelOf(rel));
          try { fs.rmSync(path.join(dir, rel), { force: true }); } catch { /* уже нет */ }
          delete state[rel];
          res.pulled.push(rel);
        }
        continue;
      }

      // у нас есть, снаружи нет
      if (b === undefined) { // создали у нас: отправляем
        const parent = path.dirname(rel);
        if (parent !== '.') await adapter.mkdir(parent);
        await adapter.write(rel, readLocal(rel));
        state[rel] = l;
        res.pushed.push(rel);
      } else if (l === b) { // удалили на другом устройстве и мы не правили: убираем у себя
        try { fs.rmSync(path.join(dir, rel), { force: true }); } catch { /* уже нет */ }
        delete state[rel];
        res.pulled.push(rel);
      } else { // снаружи удалили, а мы правили: свой текст остаётся и уйдёт наружу при выгрузке
        res.conflicts.push(rel);
      }
    }

    sigCache.clear();
    for (const [rel, e] of remote) if (e.sig && !res.pushed.includes(rel) && !res.conflicts.includes(rel)) sigCache.set(rel, { sig: e.sig, hash: e.hash });
    save();
    return res;
  }

  /**
   * Быстрая выгрузка только указанных файлов (их трогали с нашей стороны):
   * читает наружу лишь эти файлы, а не всю папку.
   */
  async function pushOnce(rels) {
    const res = { pushed: [], conflicts: [], removed: [] };
    for (const rel of new Set(rels)) {
      if (!isSyncable(rel)) continue;
      const here = fs.existsSync(path.join(dir, rel));
      if (!here) { // удалили у нас: сравниваем с тем, что снаружи, и убираем там
        if (state[rel] === undefined) continue;
        await afterLocalDelete(rel, res);
        continue;
      }
      const l = hashBytes(readLocal(rel));
      if (l === state[rel]) continue;
      let bytes = null;
      try { bytes = await adapter.read(rel); } catch (err) { console.error('folder read:', err); continue; }
      const r = bytes ? hashBytes(bytes) : undefined;
      if (r === l) { state[rel] = l; continue; }
      if (r !== undefined && r !== state[rel]) { // снаружи своя правка того же файла
        await keepForeign(rel, bytes, labelOf(rel));
        res.conflicts.push(rel);
      }
      const parent = path.dirname(rel);
      if (parent !== '.') await adapter.mkdir(parent);
      await adapter.write(rel, readLocal(rel));
      state[rel] = l;
      res.pushed.push(rel);
    }
    save();
    return res;
  }

  /** Файла у нас нет: если снаружи он не менялся — удаляем и там, иначе сначала бережём чужую версию. */
  async function afterLocalDelete(rel, res) {
    let bytes = null;
    try { bytes = await adapter.read(rel); } catch { /* папка недоступна */ }
    if (bytes && hashBytes(bytes) !== state[rel]) {
      await keepForeign(rel, bytes, labelOf(rel));
      res.conflicts.push(rel);
    }
    try { await adapter.remove(rel); } catch (err) { console.error('folder remove:', err); }
    delete state[rel];
    res.removed.push(rel);
  }

  /**
   * Выгружает локальный проект поверх внешней папки: то, чего у нас нет, не удаляется,
   * а переносится в «Конфликты» — так «Заменить папку» тоже ничего не теряет.
   */
  async function replaceAllOnce() {
    const remote = await walkRemote(adapter);
    const local = walkLocal(dir);
    let hidden = 0;
    for (const rel of remote.keys()) {
      if (local.has(rel) || rel.startsWith(`${CONFLICT_DIR}/`)) continue;
      const name = `${stamp(now())} ${safeName(labelOf(rel))} (было в папке)${path.extname(rel)}`;
      const relConflict = `${CONFLICT_DIR}/${name}`;
      await adapter.mkdir(CONFLICT_DIR);
      await adapter.write(relConflict, remote.get(rel).bytes);
      await adapter.remove(rel);
      hidden += 1;
    }
    await exportAllOnce();
    return hidden;
  }

  /** Есть ли в внешней папке проект Кабинета. */
  async function hasProject() {
    const bytes = await adapter.read('project.json');
    if (bytes) return true;
    const items = await adapter.list('');
    return items.some((it) => /^project.*\.json$/.test(it.name));
  }

  /** Копирует внешнюю папку в локальный каталог (первое открытие проекта из папки). */
  async function importAllOnce() {
    const remote = await walkRemote(adapter);
    state = {};
    for (const [rel, { hash, bytes }] of remote) {
      const target = path.join(dir, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      writeFileAtomic(target, Buffer.from(bytes));
      state[rel] = hash;
    }
    save();
    return [...remote.keys()];
  }

  /** Выгружает локальный проект в пустую внешнюю папку (первый перенос с телефона в облако). */
  async function exportAllOnce() {
    const local = walkLocal(dir);
    state = {};
    for (const [rel, hash] of local) {
      await adapter.mkdir(path.dirname(rel) === '.' ? '' : path.dirname(rel));
      await adapter.write(rel, readLocal(rel));
      state[rel] = hash;
    }
    save();
    return [...local.keys()];
  }

  /** Забыть снимок: следующая синхронизация сравнит всё заново (после смены папки). */
  function reset() { state = {}; sigCache.clear(); save(); }

  // Наружу — только последовательные проходы: один и тот же проект не может выгружаться
  // и вычитываться одновременно.
  return {
    sync: () => serial(syncOnce),
    push: (rels) => serial(async () => { sigCache.clear(); return pushOnce(rels); }),
    replaceAll: () => serial(replaceAllOnce),
    importAll: () => serial(importAllOnce),
    exportAll: () => serial(exportAllOnce),
    hasProject,
    reset,
    isSyncable,
    get state() { return { ...state }; },
  };
}

module.exports = { createFolderSync, isSyncable, walkLocal, walkRemote, FOLDERS };
