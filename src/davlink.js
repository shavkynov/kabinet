'use strict';

// Проект на компьютере, связанный с сетевой папкой (WebDAV). Те же правила, что у телефона
// (src/folder.js): правки с обеих сторон сохраняются, спорный текст уходит в «Конфликты».
// На компьютере у проекта нет события «файл изменён в приложении», поэтому выгрузку запускает
// наблюдение за папкой проекта (с задержкой) и таймер; вычитка идёт тем же проходом.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const webdav = require('./webdav');
const folderSync = require('./folder');
const cloud = require('./cloud');
const { writeFileAtomic } = require('./fsutil');
const { createSingleFlight } = require('./single-flight');

const PASS_MS = 30_000; // полный обход папки — десяток запросов, чаще не нужно
const PUSH_DELAY_MS = 4_000;
const LOCK_MS = 60_000;

/**
 * dataDir — папка данных приложения (связи и снимки состояния).
 * request — как в src/webdav.js. secret — { seal(строка) → строка, open(строка) → строка } для пароля.
 * onEvent({ type: 'conflict' | 'error' | 'changed', ... }) — сообщения для окна.
 */
function createDavLink({ dataDir, request, secret = { seal: (s) => s, open: (s) => s }, device = 'Компьютер', onEvent = () => {} }) {
  const linksFile = path.join(dataDir, 'dav-links.json');

  const loadLinks = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(linksFile, 'utf8'));
      return raw && typeof raw === 'object' ? raw : {};
    } catch { return {}; }
  };
  const saveLinks = (map) => { try { writeFileAtomic(linksFile, JSON.stringify(map, null, 2)); } catch (e) { console.error('dav links:', e); } };

  const davOf = (acc, root) => webdav.createWebDav({ url: acc.url, user: acc.user, pass: acc.pass, root: root == null ? acc.root : root, request });
  const stateFile = (dir, acc) => path.join(dataDir, `folder-state-${crypto.createHash('sha1').update(`${dir}|${acc.url}|${acc.user}|${acc.root}`).digest('hex').slice(0, 12)}.json`);

  /** Связь проекта с открытым паролем или null. */
  function linkOf(dir) {
    const raw = loadLinks()[dir];
    if (!raw) return null;
    try { return { ...raw, pass: secret.open(raw.pass) }; } catch { return null; }
  }
  function setLink(dir, acc) {
    const map = loadLinks();
    if (acc) map[dir] = { url: acc.url, user: acc.user, pass: secret.seal(acc.pass), root: acc.root, label: acc.label || '' };
    else delete map[dir];
    saveLinks(map);
  }

  // ---------- работа открытого проекта ----------
  let cur = null; // { dir, acc, sync, adapter, timer, lockTimer, watcher, pushTimer, busy, lastSync, lastError, conflict, quietUntil }

  const configGate = createSingleFlight();
  const configure = (action) => configGate.run(async () => {
    const c = cur;
    while (c && c.busy) await new Promise((resolve) => setTimeout(resolve, 50));
    return action();
  });

  function stopWork() {
    if (!cur) return;
    clearInterval(cur.timer);
    clearInterval(cur.lockTimer);
    clearTimeout(cur.pushTimer);
    if (cur.watcher) { try { cur.watcher.close(); } catch { /* уже закрыт */ } }
    cur = null;
  }

  async function writeLock(c) {
    try { await c.adapter.write(cloud.LOCK_FILE, new TextEncoder().encode(JSON.stringify({ device, time: Date.now() }))); } catch { /* замок не критичен */ }
  }
  async function releaseLock(c) {
    try {
      const bytes = await c.adapter.read(cloud.LOCK_FILE);
      if (!bytes) return;
      const raw = JSON.parse(new TextDecoder().decode(bytes));
      if (raw && raw.device === device) await c.adapter.remove(cloud.LOCK_FILE);
    } catch { /* замок не критичен */ }
  }

  /** Один полный проход: выгрузить своё, подтянуть чужое. */
  async function run(force = false) {
    const c = cur;
    if (!c || c.busy || (configGate.busy && force !== true)) return null;
    c.busy = true;
    try {
      const res = await c.sync.sync();
      c.lastSync = Date.now();
      c.lastError = '';
      if (res.conflicts && res.conflicts.length) {
        c.conflict = true;
        onEvent({ type: 'conflict' });
      }
      const touched = [...new Set([...(res.pulled || []), ...(res.conflicts || [])])];
      if (touched.length) onEvent({ type: 'changed', files: touched });
      return res;
    } catch (err) {
      c.lastError = String((err && err.message) || err);
      onEvent({ type: 'error', message: c.lastError });
      return null;
    } finally {
      c.busy = false;
      c.quietUntil = Date.now() + 3000; // записи самой вычитки не считаем новыми правками
    }
  }

  function start(dir) {
    stopWork();
    const acc = linkOf(dir);
    if (!acc) return false;
    const adapter = davOf(acc);
    cur = {
      dir, acc, adapter, sync: folderSync.createFolderSync(dir, adapter, { stateFile: stateFile(dir, acc) }),
      timer: null, lockTimer: null, watcher: null, pushTimer: null, busy: false, lastSync: 0, lastError: '', conflict: false, quietUntil: 0,
    };
    const c = cur;
    c.timer = setInterval(run, PASS_MS);
    c.timer.unref?.();
    c.lockTimer = setInterval(() => writeLock(c), LOCK_MS);
    c.lockTimer.unref?.();
    try {
      c.watcher = fs.watch(dir, { recursive: true }, (_ev, name) => {
        if (!name || c.busy || Date.now() < c.quietUntil) return;
        if (!folderSync.isSyncable(String(name).split(path.sep).join('/'))) return;
        clearTimeout(c.pushTimer);
        c.pushTimer = setTimeout(run, PUSH_DELAY_MS);
        c.pushTimer.unref?.();
      });
      c.watcher.on('error', () => {});
    } catch { /* без наблюдения остаётся таймер */ }
    writeLock(c);
    setTimeout(run, 1500).unref?.();
    return true;
  }

  /** Дописать всё в сетевую папку и снять замок (закрытие проекта, выход). */
  async function stop() {
    const c = cur;
    if (!c) return;
    clearInterval(c.timer);
    clearTimeout(c.pushTimer);
    for (let i = 0; i < 50 && c.busy; i += 1) await new Promise((r) => setTimeout(r, 100));
    await run(true);
    await releaseLock(c);
    if (cur === c) stopWork();
  }

  function status(dir) {
    const acc = dir ? linkOf(dir) : null;
    if (!acc) return { linked: false };
    const c = cur && cur.dir === dir ? cur : null;
    return {
      linked: true,
      label: acc.label || acc.url,
      root: acc.root,
      lastSync: c ? c.lastSync : 0,
      busy: c ? c.busy : false,
      error: c ? c.lastError : '',
      conflict: c ? c.conflict : false,
    };
  }

  async function syncNow() {
    if (configGate.busy) throw new Error('Идёт обмен…');
    if (!cur) throw new Error('Проект не связан с сетевой папкой.');
    cur.conflict = false;
    await run();
    return status(cur.dir);
  }

  // ---------- подключение ----------

  /** Вход на сервер: проверка логина и пароля, список папок. */
  async function login({ url, user, pass }) {
    const acc = { url: webdav.normalizeUrl(url), user: String(user || ''), pass: String(pass || '') };
    await davOf(acc, '').check();
    return acc;
  }

  const browse = (acc, at) => webdav.browseFolders({ url: acc.url, user: acc.user, pass: acc.pass, path: at || '', request });

  async function makeFolder(acc, at, name) {
    const clean = String(name || '').trim();
    if (!clean || /[\\/:*?"<>|]/.test(clean)) throw new Error('Название не должно содержать символы \\ / : * ? " < > |');
    const root = `${(at || '').replace(/\/+$/, '')}/${clean}`;
    await davOf(acc, root).ensureRoot();
    return root;
  }

  /**
   * Связать открытый проект с папкой. mode: 'ask' — если в папке уже есть проект, вернуть { exists: true } и ничего не менять;
   * 'cloud' — взять облако за основу, локальные версии уйдут в «Конфликты»;
   * 'replace' — выгрузить этот проект, облачное уйдёт в «Конфликты».
   */
  async function attach(dir, acc, mode = 'ask') {
    const previousDir = cur ? cur.dir : null;
    if (cur) await stop();
    try {
      await davOf(acc).ensureRoot();
      const probe = folderSync.createFolderSync(dir, davOf(acc), { stateFile: stateFile(dir, acc) });
      const exists = await probe.hasProject();
      if (exists && mode === 'ask') {
        if (previousDir) start(previousDir);
        return { exists: true };
      }
      if (exists && mode === 'replace') await probe.replaceAll();
      else if (exists && mode === 'cloud') await probe.takeCloud();
      else if (exists) throw new Error('Выберите, что делать с проектом в папке: взять облако или выгрузить своё.');
      else await probe.exportAll();
      setLink(dir, acc);
      start(dir);
      return { exists, status: status(dir) };
    } catch (error) {
      if (previousDir) start(previousDir);
      throw error;
    }
  }

  /** Копирует проект из сетевой папки в новый локальный каталог и связывает его. */
  async function openRemote(acc, targetDir) {
    const probe = folderSync.createFolderSync(targetDir, davOf(acc), { stateFile: stateFile(targetDir, acc) });
    if (!(await probe.hasProject())) throw new Error('В выбранной папке нет проекта Кабинета.');
    await probe.importAll();
    setLink(targetDir, acc);
    return true;
  }

  async function detach(dir) {
    if (cur && cur.dir === dir) {
      await stop();
    }
    setLink(dir, null);
    return true;
  }

  /** Входы, которые уже сохранены (для повторного использования без ввода пароля). */
  function logins() {
    const seen = new Set();
    const out = [];
    for (const dir of Object.keys(loadLinks())) {
      const acc = linkOf(dir);
      if (!acc) continue;
      const key = `${acc.url}|${acc.user}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ url: acc.url, user: acc.user, pass: acc.pass, label: acc.label || acc.url });
    }
    return out;
  }

  return { start, stop, stopWork, logins, status, syncNow, login, browse,
    makeFolder: (...args) => configure(() => makeFolder(...args)),
    attach: (...args) => configure(() => attach(...args)),
    openRemote: (...args) => configure(() => openRemote(...args)),
    detach: (...args) => configure(() => detach(...args)),
    linkOf };
}

module.exports = { createDavLink };
