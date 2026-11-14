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
const { CONFLICT_DIR, conflictNames } = require('./syncguard');
const dictLib = require('./dict');

// Что переносим в папку и обратно. «Копии» (резервные) и временные файлы не нужны:
// на другом устройстве они только мешают. Замок kabinet.lock не входит: телефон пишет его
// в папку сам (через adapter) и иначе он вечно конфликтовал бы с компьютерным замком.
const FOLDERS = ['Главы', 'Персонажи', 'Места', 'Предметы', 'Заметки', 'Изображения', 'Корзина', CONFLICT_DIR];
// Сколько файлов должно пропасть снаружи за один проход (и не меньше половины отслеживаемых), чтобы счесть ответ неполным.
const MASS_DELETE_MIN = 5;
const ROOT_FILES = /^project.*\.json$|^stats\.json$/;

/**
 * Имя файла, безопасное на всех платформах. Облако (или чужая папка) может прислать имя с обратным слешем,
 * двоеточием, именем устройства Windows и т. п.: на Windows такое имя выходит за папку проекта или пишет в
 * поток/устройство. Такие файлы не синхронизируем.
 */
function isSafeFileName(name) {
  if (!name || name.endsWith('.') || name.endsWith(' ')) return false;
  if (/[\\/:*?"<>|\u0000-\u001f\u007f]/.test(name)) return false;
  const stem = name.split('.')[0].trimEnd().toUpperCase();
  return !(/^(CON|PRN|AUX|NUL)$/.test(stem) || /^(COM|LPT)[1-9]$/.test(stem));
}

function isSyncable(rel) {
  const parts = String(rel).split('/').filter(Boolean);
  if (!parts.length) return false;
  const name = parts[parts.length - 1];
  if (name.startsWith('.') || name.endsWith('.tmp') || name === '.DS_Store' || !isSafeFileName(name)) return false;
  if (parts.length === 1) return ROOT_FILES.test(name);
  return parts.length === 2 && FOLDERS.includes(parts[0]);
}

const hashBytes = (bytes) => crypto.createHash('sha1').update(bytes).digest('hex');

/** Снимок локального проекта: относительный путь → хэш содержимого. */
/**
 * Снимок локальной папки. Ошибку чтения НЕ принимаем за «файла нет»: иначе нечитаемый файл (нет прав, блокировка,
 * ещё не скачан из iCloud) выглядел бы удалённым, и удаление ушло бы в облако. Не ошибка: папки нет совсем (ENOENT)
 * или файл исчез между чтением каталога и файла.
 */
function walkLocal(dir) {
  const out = new Map();
  const fail = (what, err) => new Error(`Не удалось прочитать «${what}»: ${err.message}. Синхронизация остановлена, чтобы не принять файл за удалённый.`);
  const add = (rel) => {
    try {
      out.set(rel, hashBytes(new Uint8Array(fs.readFileSync(path.join(dir, rel)))));
    } catch (err) {
      if (err.code !== 'ENOENT') throw fail(rel, err);
    }
  };
  const list = (full, what, mustExist) => {
    try {
      return fs.readdirSync(full, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT' && !mustExist) return [];
      throw fail(what, err);
    }
  };
  const isFile = (entry, full) => {
    if (entry.isFile()) return true;
    if (!entry.isSymbolicLink()) return false;
    try { return fs.statSync(path.join(full, entry.name)).isFile(); } catch (err) {
      if (err.code === 'ENOENT') return false; // битая ссылка
      throw fail(entry.name, err);
    }
  };
  for (const e of list(dir, 'папку проекта', true)) if (isFile(e, dir) && isSyncable(e.name)) add(e.name);
  for (const folder of FOLDERS) {
    const full = path.join(dir, folder);
    for (const e of list(full, folder, false)) if (isFile(e, full) && isSyncable(`${folder}/${e.name}`)) add(`${folder}/${e.name}`);
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
  const files = [];
  const walk = async (rel) => {
    const items = await adapter.list(rel);
    for (const it of items) {
      const r = rel ? `${rel}/${it.name}` : it.name;
      if (it.dir) { await walk(r); continue; }
      if (!isSyncable(r)) continue;
      const sig = it.mtime > 0 && it.size >= 0 ? `${it.size}:${it.mtime}` : null;
      files.push({ rel: r, sig });
    }
  };
  // Сначала получаем списки. Ошибка списка не запускает чтение неполного снимка.
  await walk('');
  const entries = new Array(files.length);
  let next = 0;
  let failed = false;
  let failure;
  const worker = async () => {
    while (!failed) {
      const index = next++;
      if (index >= files.length) return;
      const { rel, sig } = files[index];
      try {
        const hit = sig && cache && cache.get(rel);
        if (hit && hit.sig === sig) {
          entries[index] = { hash: hit.hash, bytes: null, sig };
        } else {
          const bytes = await adapter.read(rel);
          if (bytes) entries[index] = { hash: hashBytes(bytes), bytes, sig };
        }
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    }
  };
  // После ошибки не берём новые файлы и ждём завершения всех уже начатых чтений.
  await Promise.all(Array.from({ length: Math.min(3, files.length) }, () => worker()));
  if (failed) throw failure;
  const out = new Map();
  // Порядок результата не зависит от того, какой запрос ответил первым.
  for (let i = 0; i < files.length; i += 1) if (entries[i]) out.set(files[i].rel, entries[i]);
  return out;
}

/**
 * Связка локального проекта с внешней папкой.
 * stateFile — где хранить хэши последней согласованной версии (вне проекта, чтобы не мозолить глаза).
 */
function createFolderSync(dir, adapter, { stateFile, now = () => new Date() } = {}) {
  let state = load();
  // Отдельный файл сохраняет совместимость со старым форматом stateFile.
  const cacheFile = stateFile ? `${stateFile}.cache` : null;
  const sigCache = loadCache();
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

  function loadCache() {
    const cache = new Map();
    if (!cacheFile) return cache;
    try {
      const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (!raw || raw.version !== 1 || !raw.files || typeof raw.files !== 'object' || Array.isArray(raw.files)) return cache;
      for (const [rel, entry] of Object.entries(raw.files)) {
        if (!isSyncable(rel) || !entry || typeof entry.sig !== 'string' || !/^\d+:\d+$/.test(entry.sig)) continue;
        if (typeof entry.hash !== 'string' || !/^[a-f0-9]{40}$/.test(entry.hash) || state[rel] !== entry.hash) continue;
        cache.set(rel, { sig: entry.sig, hash: entry.hash });
      }
    } catch { /* отсутствующий или повреждённый кэш означает полное чтение */ }
    return cache;
  }

  function save() {
    try {
      writeFileAtomic(stateFile, JSON.stringify(state, null, 2));
      if (cacheFile) {
        const files = Object.fromEntries([...sigCache].filter(([rel, entry]) => state[rel] === entry.hash));
        writeFileAtomic(cacheFile, JSON.stringify({ version: 1, files }, null, 2));
      }
    } catch (err) { console.error('folder state:', err); }
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
  // Хэш локального файла на диске; undefined, если файла уже нет. Нужен, чтобы заметить сохранение,
  // случившееся после снятия снимка walkLocal, но до обработки файла в проходе.
  const localHash = (rel) => {
    try { return hashBytes(readLocal(rel)); } catch { return undefined; }
  };

  /**
   * Имя копии в «Конфликты», которое не затрёт другую версию: обычное, а если оно занято другим содержимым —
   * с SHA-256. Та же версия под этим именем переиспользуется. withLocal: проверять и локальную папку.
   * Ошибка чтения папки имя не блокирует: запись в неё всё равно не удастся и будет обработана вызывающим.
   */
  async function freeConflictName(rel, label, suffix, bytes, withLocal) {
    const want = Buffer.from(bytes);
    for (const name of conflictNames(label, suffix, path.extname(rel), want, now())) {
      const relConflict = `${CONFLICT_DIR}/${name}`;
      let busy = false;
      if (withLocal) {
        try { busy = !fs.readFileSync(path.join(dir, relConflict)).equals(want); } catch (err) { if (err.code !== 'ENOENT') throw err; }
      }
      if (!busy) {
        let there = null;
        try { there = await adapter.read(relConflict); } catch { /* папка недоступна */ }
        if (there && !Buffer.from(there).equals(want)) busy = true;
      }
      if (!busy) return name;
    }
    throw new Error('Копия в «Конфликты» уже существует и была изменена. Сохранение остановлено, чтобы не затереть её.');
  }

  /** Чужую версию наружу не выбрасываем: складываем её в «Конфликты» и локально, и в папке. */
  async function keepForeign(rel, bytes, label) {
    const name = await freeConflictName(rel, label, 'с другого устройства', bytes, true);
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

  /** Сохранить вытесняемую локальную версию в «Конфликты» и в папке. Ошибка папки не подавляется. */
  async function keepLocalCopy(rel, bytes, label) {
    const name = await freeConflictName(rel, label, 'было на этом устройстве', bytes, true);
    const relConflict = `${CONFLICT_DIR}/${name}`;
    const target = path.join(dir, relConflict);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeFileAtomic(target, Buffer.from(bytes));
    await adapter.mkdir(CONFLICT_DIR);
    await adapter.write(relConflict, new Uint8Array(bytes));
    state[relConflict] = hashBytes(bytes);
    return name;
  }

  /**
   * Взять облако за основу при первом подключении к непустой папке: локальные версии, которые облако
   * заменит или не содержит, сначала сохраняются в «Конфликты», затем папка скачивается целиком,
   * а лишние локальные файлы убираются из проекта после подтверждённого сохранения их версий.
   */
  async function takeCloudOnce() {
    const remote = await walkRemote(adapter);
    const local = walkLocal(dir);
    const conflictPrefix = `${CONFLICT_DIR}/`;
    const keep = [];
    for (const [rel, hash] of local) {
      if (rel.startsWith(conflictPrefix)) continue;
      const there = remote.get(rel);
      if (there && there.hash === hash) continue;
      keep.push([rel, readLocal(rel)]);
    }
    for (const [rel, bytes] of keep) await keepLocalCopy(rel, bytes, labelOf(rel));
    const after = walkLocal(dir);
    for (const [rel, hash] of after) {
      if (rel.startsWith(conflictPrefix)) continue;
      if (local.get(rel) !== hash) throw new Error('Проект менялся во время подключения к папке. Ничего не перезаписано, повторите подключение.');
    }
    for (const rel of local.keys()) {
      if (!rel.startsWith(conflictPrefix) && !after.has(rel)) {
        throw new Error('Проект менялся во время подключения к папке. Ничего не перезаписано, повторите подключение.');
      }
    }
    await importAllOnce();
    for (const [rel, hash] of local) {
      if (rel.startsWith(conflictPrefix) || remote.has(rel)) continue;
      let nowHash = null;
      try { nowHash = hashBytes(readLocal(rel)); } catch (err) { if (err.code !== 'ENOENT') throw err; }
      if (nowHash !== null && nowHash !== hash) {
        throw new Error(`Файл «${rel}» изменился во время подключения. Он не удалён; повторите подключение.`);
      }
      fs.rmSync(path.join(dir, rel), { force: true });
    }
    return keep.length;
  }

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

    // Второй вид неполного ответа: корень на месте, но часть файлов не перечислена (обрыв, лимит страниц).
    // Одна-две удалённые главы — обычное дело; массовое исчезновение нельзя принимать за удаление на другом устройстве.
    const vanished = rels.filter((rel) => state[rel] !== undefined && !remote.has(rel) && local.get(rel) === state[rel]);
    const tracked = Object.keys(state).filter((rel) => isSyncable(rel)).length;
    if (vanished.length >= MASS_DELETE_MIN && vanished.length * 2 >= tracked) {
      throw new Error('Снаружи пропала большая часть файлов проекта. Похоже на неполный ответ облака, поэтому синхронизация остановлена и у вас ничего не удалено.');
    }

    for (const rel of rels) {
      // Решение по файлу принимаем заново, если перечитывание локального файла показало, что снимок l
      // устарел (сохранение во время прохода). Внутренний цикл завершается на каждой обычной ветке.
      for (;;) {
        const r = remote.has(rel) ? remote.get(rel).hash : undefined;
        const l = local.get(rel);
        const b = state[rel];
        if (r === undefined && l === undefined) { delete state[rel]; break; }
        if (r !== undefined && r === l) { state[rel] = r; break; }

        if (r !== undefined && l !== undefined) {
          if (b === r) { await adapter.write(rel, readLocal(rel)); state[rel] = l; res.pushed.push(rel); break; }
          if (b === l) {
            // Облако обновило файл, а снимок говорит, что мы его не меняли. Перед тем как затереть свой файл,
            // перечитаем его: сохранение во время этого прохода уже изменило файл (без await между проверкой и записью).
            const foreign = await remoteBytes(remote.get(rel), rel);
            const fresh = localHash(rel);
            if (fresh !== undefined && fresh !== l) { local.set(rel, fresh); continue; }
            writeFileAtomic(path.join(dir, rel), Buffer.from(foreign));
            state[rel] = r;
            res.pulled.push(rel);
            break;
          }
          const foreign = await remoteBytes(remote.get(rel), rel);
          await keepForeign(rel, foreign, labelOf(rel));
          const withWords = rel === 'project.json' ? dictLib.mergeMetaWords(readLocal(rel), foreign) : null; // слова, добавленные на другом устройстве, не теряем
          if (withWords) writeFileAtomic(path.join(dir, rel), withWords);
          await adapter.write(rel, readLocal(rel));
          state[rel] = withWords ? hashBytes(withWords) : l;
          res.pushed.push(rel);
          res.conflicts.push(rel);
          break;
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
          break;
        }

        // у нас есть, снаружи нет
        if (b === undefined) { // создали у нас: отправляем
          const parent = path.dirname(rel);
          if (parent !== '.') await adapter.mkdir(parent);
          await adapter.write(rel, readLocal(rel));
          state[rel] = l;
          res.pushed.push(rel);
        } else if (l === b) { // удалили на другом устройстве и мы не правили: убираем у себя
          // Перед удалением перечитаем файл: сохранение во время прохода могло изменить его.
          const fresh = localHash(rel);
          if (fresh !== undefined && fresh !== l) { local.set(rel, fresh); continue; }
          try { fs.rmSync(path.join(dir, rel), { force: true }); } catch { /* уже нет */ }
          delete state[rel];
          res.pulled.push(rel);
        } else { // снаружи удалили, а мы правили: свой текст остаётся и уйдёт наружу при выгрузке
          res.conflicts.push(rel);
        }
        break;
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
      sigCache.delete(rel);
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
   * Выгружает локальный проект поверх внешней папки: то, чего у нас нет,
   * а переносится в «Конфликты» — так «Заменить папку» тоже ничего не теряет.
   */
  async function replaceAllOnce() {
    const remote = await walkRemote(adapter);
    const local = walkLocal(dir);
    let hidden = 0;
    for (const rel of remote.keys()) {
      if (local.has(rel) || rel.startsWith(`${CONFLICT_DIR}/`)) continue;
      const bytes = remote.get(rel).bytes;
      const name = await freeConflictName(rel, labelOf(rel), 'было в папке', bytes, false);
      const relConflict = `${CONFLICT_DIR}/${name}`;
      await adapter.mkdir(CONFLICT_DIR);
      await adapter.write(relConflict, bytes);
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
    sigCache.clear();
    for (const [rel, { hash, bytes, sig }] of remote) {
      const target = path.join(dir, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      writeFileAtomic(target, Buffer.from(bytes));
      state[rel] = hash;
      if (sig) sigCache.set(rel, { sig, hash });
    }
    save();
    return [...remote.keys()];
  }

  /** Выгружает локальный проект в пустую внешнюю папку (первый перенос с телефона в облако). */
  async function exportAllOnce() {
    const local = walkLocal(dir);
    state = {};
    sigCache.clear();
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
    push: (rels) => serial(() => pushOnce(rels)),
    replaceAll: () => serial(replaceAllOnce),
    takeCloud: () => serial(takeCloudOnce),
    importAll: () => serial(importAllOnce),
    exportAll: () => serial(exportAllOnce),
    hasProject,
    reset,
    isSyncable,
    get state() { return { ...state }; },
  };
}

module.exports = { createFolderSync, isSyncable, walkLocal, walkRemote, FOLDERS };
