'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu, nativeTheme, session, shell, net, clipboard } = require('electron');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const isMac = process.platform === 'darwin';
const project = require('./src/project');
const recents = require('./src/recents');
const backup = require('./src/backup');
const searcher = require('./src/search');
const replacer = require('./src/replace');
const mentions = require('./src/mentions');
const stats = require('./src/stats');
const { termize } = require('./src/terms');
const cloud = require('./src/cloud');
const syncguard = require('./src/syncguard');
const { createWatcher } = require('./src/watcher');
const exporter = require('./src/export');
const importer = require('./src/import');
const { writeFileAtomic } = require('./src/fsutil');
const langcheck = require('./src/langcheck');
const i18n = require('./src/i18n');
const { t, tdom } = i18n;

// ---------- данные приложения: одна папка и для запуска из исходников, и для собранной программы ----------
// Настройки, шрифты, звуки и список проектов живут в «Application Support/Кабинет».
// Если раньше программа запускалась из исходников и данные лежали рядом (kabinet, Electron), переносим их один раз.
(function prepareUserData() {
  const target = path.join(app.getPath('appData'), 'Кабинет');
  const current = app.getPath('userData');
  if (current !== target && !fs.existsSync(target)) {
    const skip = new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'blob_storage', 'Crashpad', 'ShaderCache']);
    for (const old of [current, path.join(app.getPath('appData'), 'Electron')]) {
      if (!fs.existsSync(old)) continue;
      try {
        fs.cpSync(old, target, { recursive: true, filter: (src) => !skip.has(path.basename(src)) });
        break;
      } catch (err) {
        console.error('userData migration failed:', err);
      }
    }
  }
  app.setPath('userData', target);
})();

// Одно окно: два экземпляра писали бы в одни и те же файлы проекта.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on('second-instance', () => {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

let win = null;
let currentDir = null; // открытый проект; рендерер путь не передаёт, его знает только main

const recentsFile = () => path.join(app.getPath('userData'), 'recent-projects.json');

// Куда класть копии. Проект в облачной папке: копии храним на этом компьютере, вне облака,
// чтобы 60 копий не гонялись между устройствами и не пропадали вместе с проектом при ошибке синхронизации.
function backupRoot(dir) {
  if (!cloud.detectCloud(dir)) return path.join(dir, backup.BACKUP_DIR);
  const key = crypto.createHash('sha1').update(dir).digest('hex').slice(0, 8);
  const name = path.basename(dir).replace(/[\\/:*?"<>|]/g, '-') || 'project';
  return path.join(app.getPath('userData'), 'Копии', `${name}-${key}`);
}

// Копия при открытии проекта, закрытии и раз в 20 минут. Ошибка копирования не мешает писать.
function autoBackup() {
  if (!currentDir) return null;
  try {
    return backup.makeBackup(currentDir, { root: backupRoot(currentDir) });
  } catch (err) {
    console.error('backup failed:', err);
    return null;
  }
}
setInterval(autoBackup, 20 * 60 * 1000).unref();

// ---------- синхронизация через облачную папку ----------
// Своего сервера нет: проект лежит в iCloud Drive, Dropbox и т.п., а программа следит за файлами,
// не даёт затереть чужие правки (чужая версия уходит в «Конфликты») и предупреждает о втором устройстве.

let watcher = null;
let lockTimer = null;
let lockedDir = null;
let askingCopies = false;
const declinedCopies = new Set();

function syncStop() {
  if (watcher) { watcher.close(); watcher = null; }
  clearInterval(lockTimer);
  lockTimer = null;
  if (lockedDir) { cloud.releaseLock(lockedDir); lockedDir = null; }
}

function syncStart(dir) {
  syncStop();
  watcher = createWatcher(dir, (files) => {
    send('sync:changed', files);
    checkConflictCopies();
  });
  const where = cloud.detectCloud(dir);
  if (where) {
    cloud.writeLock(dir);
    lockedDir = dir;
    lockTimer = setInterval(() => cloud.writeLock(dir), 60 * 1000);
    lockTimer.unref();
    if (where === 'iCloud Drive') syncguard.requestDownload(dir);
  }
  setTimeout(checkConflictCopies, 2000);
}

async function confirmLock(dir) {
  const l = cloud.detectCloud(dir) ? cloud.foreignLock(dir) : null;
  if (!l) return true;
  const mins = Math.max(1, Math.round((Date.now() - l.time) / 60000));
  const res = await dialog.showMessageBox(win, {
    type: 'warning',
    message: t('Проект, похоже, открыт на другом устройстве: {0}', l.device),
    detail: t('Последний сигнал оттуда был {0} мин. назад. Если работать в обоих местах сразу, правки одной главы могут столкнуться: ничего не пропадёт, но чужая версия уйдёт в папку «Конфликты». Лучше закрыть проект на другом устройстве.', mins),
    buttons: [t('Всё равно открыть'), t('Отмена')],
    defaultId: 1,
    cancelId: 1,
  });
  return res.response === 0;
}

// Облако при конфликте создаёт копии файлов («имя 2.md» и т.п.). Предлагаем убрать их в «Конфликты», ничего не удаляя.
async function checkConflictCopies() {
  if (!currentDir || askingCopies) return;
  const dir = currentDir;
  let list;
  try {
    list = cloud.findConflictCopies(dir).filter((x) => !declinedCopies.has(x));
  } catch {
    return;
  }
  if (!list.length) return;
  askingCopies = true;
  try {
    const res = await dialog.showMessageBox(win, {
      type: 'info',
      message: t('Облако создало копии файлов: {0}', list.length),
      detail: t('Так бывает, когда один файл изменили на двух устройствах. Предлагаю перенести эти копии в папку «Конфликты» внутри проекта: ничего не удаляется, и вы сможете забрать нужный текст.'),
      buttons: [t('Перенести в «Конфликты»'), t('Не сейчас')],
      defaultId: 0,
      cancelId: 1,
    });
    if (dir !== currentDir) return;
    if (res.response === 0) {
      cloud.moveConflictCopies(dir, list);
      send('sync:changed', ['project.json']);
    } else {
      for (const x of list) declinedCopies.add(x);
    }
  } finally {
    askingCopies = false;
  }
}

async function showSyncInfo() {
  const dir = currentDir;
  const where = dir ? cloud.detectCloud(dir) : null;
  const lines = [];
  if (dir) lines.push(where ? t('Сейчас проект лежит в: {0}.', where) : t('Сейчас проект лежит в обычной папке, не в облаке.'));
  lines.push(
    t('Как включить: переместите папку проекта в iCloud Drive (есть на каждом Маке, 5 ГБ бесплатно), Dropbox, Яндекс Диск или Google Drive и откройте её оттуда. На втором устройстве откройте ту же папку.'),
    t('Что делает программа: сама подхватывает правки с другого устройства, не даёт затереть чужие правки (чужая версия сохраняется в папке «Конфликты») и предупреждает, если проект открыт в другом месте.'),
    t('Совет: работайте на одном устройстве за раз и закрывайте проект перед переходом на другое, чтобы облако успело всё передать. Резервные копии облачного проекта хранятся на этом компьютере, вне облака.'),
  );
  const res = await dialog.showMessageBox(win, {
    type: 'info',
    message: t('Синхронизация'),
    detail: lines.join('\n\n'),
    buttons: dir ? ['OK', t('Открыть папку «Конфликты»')] : ['OK'],
    defaultId: 0,
  });
  if (dir && res.response === 1) {
    const folder = path.join(dir, syncguard.CONFLICT_DIR);
    fs.mkdirSync(folder, { recursive: true });
    shell.openPath(folder);
  }
}

// «Отзывы» и «Обновления» в верхнем меню: адреса зашиты в код, наружу открываются только они.
const FEEDBACK_EMAIL = 'Shavkynov@gmail.com';
const UPDATES_URL = 'https://boosty.to/writer_room';

async function showFeedback() {
  const res = await dialog.showMessageBox(win, {
    type: 'info',
    message: t('Отзывы'),
    detail: [
      t('Расскажите, пожалуйста, о своём опыте работы с «Кабинетом»: что удобно, что мешает, чего не хватает, что работает не так.'),
      t('Напишите на почту: {0}', FEEDBACK_EMAIL),
    ].join('\n\n'),
    buttons: ['OK', t('Скопировать адрес'), t('Написать письмо')],
    defaultId: 0,
    cancelId: 0,
  });
  if (res.response === 1) clipboard.writeText(FEEDBACK_EMAIL);
  else if (res.response === 2) shell.openExternal(`mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(`Kabinet ${app.getVersion()} - feedback`)}`);
}

async function showUpdatesInfo() {
  const res = await dialog.showMessageBox(win, {
    type: 'info',
    message: t('Обновления'),
    detail: [
      t('Новые версии «Кабинета» выкладываются на Boosty: {0}', UPDATES_URL),
      t('Всё бесплатно: Boosty выбран просто потому, что автору так удобно публиковать новые версии.'),
      t('Сейчас у вас версия {0}.', app.getVersion()),
    ].join('\n\n'),
    buttons: ['OK', t('Открыть Boosty')],
    defaultId: 0,
    cancelId: 0,
  });
  if (res.response === 1) shell.openExternal(UPDATES_URL);
}

function requireDir() {
  if (!currentDir) throw new Error('Проект не открыт.');
  return currentDir;
}

async function openAt(dir) {
  const proj = project.openProject(dir);
  if (!(await confirmLock(dir))) return null; // автор передумал: проект открыт на другом устройстве
  currentDir = dir;
  projectMode = proj.mode;
  recents.add(recentsFile(), { path: dir, name: proj.name });
  autoBackup();
  syncStart(dir);
  return proj;
}

function safeFolderName(name) {
  const n = String(name ?? '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/^\.+/, '')
    .trim()
    .replace(/[. ]+$/, ''); // Windows не принимает точку и пробел в конце имени папки
  if (!n) throw new Error('Введите название проекта.');
  return (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(n) ? `_${n}` : n).slice(0, 80);
}

// Оборачиваем обработчики: ошибка не теряется, а доходит до окна понятным текстом.
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      const msg = String((err && err.message) || err);
      return { ok: false, error: tdom(msg) || msg };
    }
  });
}

// ---------- проекты ----------

handle('recents:list', () => recents.list(recentsFile()));

handle('recents:remove', (p) => {
  recents.remove(recentsFile(), String(p));
  return true;
});

handle('project:create', async (name, mode) => {
  const folder = safeFolderName(name);
  const res = await dialog.showOpenDialog(win, {
    title: t('Где создать проект?'),
    message: t('Выберите папку, внутри которой появится папка проекта'),
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: t('Выбрать'),
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const dir = path.join(res.filePaths[0], folder);
  const proj = project.createProject(dir, String(name), { mode });
  projectMode = proj.mode;
  currentDir = dir;
  recents.add(recentsFile(), { path: dir, name: proj.name });
  syncStart(dir);
  return proj;
});

handle('project:openDialog', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: t('Открыть проект'),
    message: t('Выберите папку проекта (в ней должен лежать файл project.json)'),
    properties: ['openDirectory'],
    buttonLabel: t('Открыть'),
  });
  if (res.canceled || !res.filePaths[0]) return null;
  return openAt(res.filePaths[0]);
});

handle('project:openRecent', (p) => {
  const dir = String(p);
  if (!recents.has(recentsFile(), dir)) throw new Error('Этого проекта нет в списке недавних.');
  return openAt(dir);
});

handle('backup:now', () => autoBackup());
handle('backup:openFolder', async () => {
  const dir = requireDir();
  const folder = backupRoot(dir);
  fs.mkdirSync(folder, { recursive: true });
  const err = await shell.openPath(folder);
  if (err) throw new Error(err);
  return true;
});
handle('chapter:readMeta', (id) => project.readChapterMeta(requireDir(), id));
handle('chapter:writeMeta', (id, data) => project.writeChapterMeta(requireDir(), id, data));
handle('project:search', (query) => searcher.searchProject(requireDir(), query));
// Замена по всему проекту. Перед настоящей заменой делаем копию; если копия не удалась, ничего не меняем.
handle('project:replace', (find, repl, dry) => {
  const dir = requireDir();
  if (!dry) backup.makeBackup(dir, { root: backupRoot(dir) });
  return replacer.replaceProject(dir, find, repl, { dry: !!dry });
});

// Экспорт всех глав одним файлом: PDF, DOCX, Markdown, текст или HTML (формат по расширению).
handle('project:export', async (opts) => {
  const dir = requireDir();
  const exportOpts = { indent: !!(opts && opts.indent) }; // красная строка: решает режим «Абзацы» в окне
  const res = await dialog.showSaveDialog(win, {
    title: t('Экспорт проекта'),
    defaultPath: path.join(app.getPath('documents'), `${path.basename(dir)}.pdf`),
    filters: [
      { name: 'PDF', extensions: ['pdf'] },
      { name: 'Word (DOCX)', extensions: ['docx'] },
      { name: 'RTF', extensions: ['rtf'] },
      { name: 'Markdown', extensions: ['md'] },
      { name: t('Обычный текст'), extensions: ['txt'] },
      { name: 'HTML', extensions: ['html'] },
    ],
    buttonLabel: t('Экспортировать'),
  });
  if (res.canceled || !res.filePath) return null;
  let file = res.filePath;
  let ext = path.extname(file).slice(1).toLowerCase();
  if (!['pdf', 'docx', 'rtf', 'md', 'txt', 'html'].includes(ext)) {
    ext = 'pdf';
    file += '.pdf';
  }
  if (ext === 'pdf') {
    const html = exporter.buildExport(dir, 'html', i18n.getLang(), exportOpts);
    const printer = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
    // Через временный файл, а не data:-адрес: у адреса есть предел длины (около 2 МБ), а кириллица в нём
    // раздувается примерно в 6 раз, так что длинная рукопись в адрес не помещалась.
    const tmpHtml = path.join(app.getPath('temp'), `kabinet-export-${crypto.randomBytes(6).toString('hex')}.html`);
    try {
      fs.writeFileSync(tmpHtml, html, 'utf8');
      await printer.loadFile(tmpHtml);
      const pdf = await printer.webContents.printToPDF({ pageSize: 'A4', printBackground: false });
      fs.writeFileSync(file, pdf);
    } finally {
      printer.destroy();
      try { fs.unlinkSync(tmpHtml); } catch { /* временный файл не критичен */ }
    }
  } else if (ext === 'docx') {
    fs.writeFileSync(file, exporter.buildExport(dir, 'docx', i18n.getLang()));
  } else {
    fs.writeFileSync(file, exporter.buildExport(dir, ext, i18n.getLang(), exportOpts), 'utf8');
  }
  shell.showItemInFolder(file);
  return file;
});

// Импорт глав из .docx, .md и .txt: файл (или несколько) становится главой, а при заголовках верхнего уровня делится на главы (src/import.js).
// Перед импортом делается резервная копия; файлы, которые не удалось прочитать, перечисляются в skipped.
handle('project:import', async () => {
  const dir = requireDir();
  const res = await dialog.showOpenDialog(win, {
    title: t('Импорт глав'),
    message: t('Выберите файлы Word, Markdown или обычного текста'),
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: t('Документы'), extensions: ['docx', 'rtf', 'md', 'markdown', 'txt'] }],
    buttonLabel: t('Импортировать'),
  });
  if (res.canceled || !res.filePaths.length) return null;
  const items = [];
  const skipped = [];
  for (const file of res.filePaths.slice().sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
    const name = path.basename(file);
    try {
      if (fs.statSync(file).size > importer.MAX_FILE) throw new Error(t('Файл слишком большой для импорта (больше 30 МБ).'));
      items.push(...importer.parseFile(name, fs.readFileSync(file)));
    } catch (err) {
      skipped.push(`${name}: ${tdom(String(err.message)) || err.message}`);
    }
  }
  if (!items.length) throw new Error(skipped.join('\n') || t('В файлах нет текста.'));
  backup.makeBackup(dir, { root: backupRoot(dir) });
  const out = project.importChapters(dir, items);
  return { project: out.project, ids: out.ids, skipped };
});

handle('project:stats', () => project.projectStats(requireDir()));

handle('project:setProjectGoal', (goal) => project.setProjectGoal(requireDir(), goal));
handle('project:setAnalysisSkip', (skip) => project.setAnalysisSkip(requireDir(), skip));
handle('project:setDeadline', (date) => project.setProjectDeadline(requireDir(), date));
handle('stats:setDay', (date, words) => { stats.setDayWords(requireDir(), date, words); return true; });
handle('stats:summary', (today, todayWords) => {
  const dir = requireDir();
  const v = project.openProject(dir);
  return stats.summary(dir, {
    today, todayWords, goal: v.projectGoal, deadline: v.deadline, total: (() => { const st = project.projectStats(dir); return v.mode === 'stories' && v.goalUnit === 'chars' ? st.totalChars : st.total; })(),
  });
});
handle('project:board', () => project.boardData(requireDir()));

handle('project:reload', () => project.openProject(requireDir()));

handle('project:setGoalUnit', (unit) => project.setGoalUnit(requireDir(), unit));
handle('project:setCharLimit', (limit) => project.setCharLimit(requireDir(), limit));

handle('project:setMode', (mode) => {
  const v = project.setProjectMode(requireDir(), mode);
  projectMode = v.mode;
  buildMenu(); // в меню меняются слова («панель глав» / «панель рассказов»)
  return v;
});

handle('project:close', () => {
  autoBackup();
  syncStop();
  currentDir = null;
  if (projectMode !== 'novel') { projectMode = 'novel'; buildMenu(); }
  return true;
});

// ---------- главы ----------

handle('chapter:add', (afterId) => project.addChapter(requireDir(), afterId || null));
handle('chapter:rename', (id, title) => project.renameChapter(requireDir(), id, title));
handle('chapter:move', (id, index) => project.moveChapter(requireDir(), id, index));
handle('chapter:setGoal', (id, goal) => project.setChapterGoal(requireDir(), id, goal));
handle('chapter:setMarker', (id, marker) => project.setChapterMarker(requireDir(), id, marker));

// ---------- карточки персонажей, места, заметки ----------

handle('item:add', (kind, afterId) => project.addItem(requireDir(), kind, afterId || null));
handle('item:rename', (kind, id, title) => project.renameItem(requireDir(), kind, id, title));
handle('item:move', (kind, id, index) => project.moveItem(requireDir(), kind, id, index));
handle('item:setIcon', (kind, id, icon) => project.setItemIcon(requireDir(), kind, id, icon));
handle('item:read', (kind, id) => project.readItem(requireDir(), kind, id));
handle('item:write', (kind, id, text) => project.writeItem(requireDir(), kind, id, text));
handle('cards:index', () => project.cardIndex(requireDir()));
handle('cards:mentions', (kind, id) => mentions.cardMentions(requireDir(), kind, id));
handle('image:read', (file) => project.readImage(requireDir(), file));
handle('image:pick', async () => {
  const dir = requireDir();
  const res = await dialog.showOpenDialog(win, {
    title: t('Выберите картинку'),
    properties: ['openFile'],
    filters: [{ name: t('Картинки'), extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
    buttonLabel: t('Выбрать'),
  });
  if (res.canceled || !res.filePaths[0]) return null;
  return project.addImage(dir, res.filePaths[0]);
});

handle('project:setTemplate', (kind, names) => project.setTemplate(requireDir(), kind, names));

// Удаление = перенос в «Корзину» проекта (откуда можно вернуть), поэтому без лишних вопросов.
handle('item:delete', (kind, id) => project.deleteItem(requireDir(), kind, id));
handle('project:setDefaultGoal', (goal) => project.setDefaultGoal(requireDir(), goal));
handle('chapter:read', (id) => project.readChapter(requireDir(), id));
handle('chapter:write', (id, text) => project.writeChapter(requireDir(), id, text));

handle('chapter:delete', (id) => project.deleteChapter(requireDir(), id));

// ---------- корзина проекта ----------

handle('trash:restore', (tid) => project.restoreTrash(requireDir(), String(tid)));

handle('trash:purge', async (tid) => {
  const dir = requireDir();
  const title = project.trashTitle(dir, String(tid));
  const res = await dialog.showMessageBox(win, {
    type: 'warning',
    message: t('Удалить «{0}» навсегда?', title),
    detail: t('Это нельзя отменить.'),
    buttons: [t('Удалить навсегда'), t('Отмена')],
    defaultId: 1,
    cancelId: 1,
  });
  if (res.response !== 0) return null;
  return project.purgeTrash(dir, String(tid));
});

handle('trash:empty', async () => {
  const dir = requireDir();
  const res = await dialog.showMessageBox(win, {
    type: 'warning',
    message: t('Очистить корзину?'),
    detail: t('Всё, что в ней лежит, будет удалено навсегда. Это нельзя отменить.'),
    buttons: [t('Очистить'), t('Отмена')],
    defaultId: 1,
    cancelId: 1,
  });
  if (res.response !== 0) return null;
  return project.emptyTrash(dir);
});

// ---------- оформление ----------

// Тема окна: «system» следует за macOS, «light» и «dark» принудительные.
handle('ui:setTheme', (theme) => {
  if (!['system', 'light', 'dark'].includes(theme)) throw new Error('Неизвестная тема.');
  nativeTheme.themeSource = theme;
  return true;
});

// ---------- свои шрифты ----------
// Файлы копируются в папку данных приложения, так что оригиналы можно потом удалить.

const FONT_EXT = /\.(ttf|otf|woff2?)$/i;
const MAX_FONT_BYTES = 40 * 1024 * 1024;
const fontsDir = () => path.join(app.getPath('userData'), 'fonts');

function familyFromFile(file) {
  return path.basename(file).replace(FONT_EXT, '').replace(/["'\\]/g, '').trim() || 'Шрифт';
}

function listFonts() {
  const dir = fontsDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => FONT_EXT.test(f))
    .sort()
    .map((f) => ({ file: f, family: familyFromFile(f), data: fs.readFileSync(path.join(dir, f)) }));
}

handle('fonts:list', () => listFonts());

handle('fonts:add', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: t('Добавить шрифты'),
    message: t('Выберите файлы шрифтов (.ttf, .otf, .woff, .woff2)'),
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: t('Шрифты'), extensions: ['ttf', 'otf', 'woff', 'woff2'] }],
    buttonLabel: t('Добавить'),
  });
  if (res.canceled) return [];
  fs.mkdirSync(fontsDir(), { recursive: true });
  const added = [];
  for (const src of res.filePaths) {
    const name = path.basename(src);
    if (!FONT_EXT.test(name)) continue;
    if (fs.statSync(src).size > MAX_FONT_BYTES) throw new Error(`Файл слишком большой: ${name}`);
    fs.copyFileSync(src, path.join(fontsDir(), name));
    added.push(name);
  }
  return added;
});

handle('fonts:remove', (file) => {
  const name = path.basename(String(file));
  const target = path.join(fontsDir(), name);
  if (FONT_EXT.test(name) && fs.existsSync(target)) fs.unlinkSync(target);
  return true;
});

// ---------- свои звуки ----------
// Папка userData/sounds: для каждого варианта своя подпапка (ambient/rain, keys/space и т.д.),
// в неё и копируются загруженные файлы. Оригиналы автор может потом удалить.

const SOUND_SLOTS = [
  'ambient/rain', 'ambient/fire', 'ambient/wind', 'ambient/sea', 'ambient/hum',
  'keys/key', 'keys/space', 'keys/backspace', 'keys/enter',
];
const AUDIO_EXT = /\.(wav|mp3|ogg|m4a|aac)$/i;
const userSoundsDir = () => path.join(app.getPath('userData'), 'sounds');

function slotDir(slot) {
  if (!SOUND_SLOTS.includes(slot)) throw new Error('Неизвестный вариант звука.');
  return path.join(userSoundsDir(), ...slot.split('/'));
}

// Файлы key…, space…, enter…, backspace… из прежних версий лежали прямо в папке звуков: переносим по подпапкам.
function migrateOldKeySounds() {
  const root = userSoundsDir();
  if (!fs.existsSync(root)) return;
  for (const f of fs.readdirSync(root)) {
    const m = /^(key|space|enter|backspace)/i.exec(f);
    const full = path.join(root, f);
    if (!m || !AUDIO_EXT.test(f) || !fs.statSync(full).isFile()) continue;
    const dir = slotDir(`keys/${m[1].toLowerCase()}`);
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(path.join(dir, f))) fs.renameSync(full, path.join(dir, f));
  }
}

handle('sounds:list', () => {
  migrateOldKeySounds();
  const out = {};
  for (const slot of SOUND_SLOTS) {
    const dir = slotDir(slot);
    out[slot] = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => AUDIO_EXT.test(f)).sort() : [];
  }
  return out;
});

handle('sounds:read', (slot, file) => {
  const name = path.basename(String(file));
  if (!AUDIO_EXT.test(name)) throw new Error('Это не звуковой файл.');
  return fs.readFileSync(path.join(slotDir(slot), name));
});

handle('sounds:add', async (slot) => {
  const dir = slotDir(slot);
  const res = await dialog.showOpenDialog(win, {
    title: t('Загрузить звук'),
    message: t('Выберите звуковые файлы (wav, mp3, ogg, m4a)'),
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: t('Звук'), extensions: ['wav', 'mp3', 'ogg', 'm4a', 'aac'] }],
    buttonLabel: t('Добавить'),
  });
  if (res.canceled) return [];
  fs.mkdirSync(dir, { recursive: true });
  const limit = slot.startsWith('ambient/') ? 60 : 10;
  const added = [];
  for (const src of res.filePaths) {
    const base = path.basename(src);
    if (!AUDIO_EXT.test(base)) continue;
    if (fs.statSync(src).size > limit * 1024 * 1024) throw new Error(`Файл слишком большой (больше ${limit} МБ): ${base}`);
    let name = base;
    for (let i = 2; fs.existsSync(path.join(dir, name)); i += 1) name = base.replace(/(\.[^.]+)$/, ` ${i}$1`);
    fs.copyFileSync(src, path.join(dir, name));
    added.push(name);
  }
  return added;
});

handle('sounds:remove', (slot, file) => {
  const name = path.basename(String(file));
  const target = path.join(slotDir(slot), name);
  if (AUDIO_EXT.test(name) && fs.existsSync(target)) fs.unlinkSync(target);
  return true;
});

handle('sounds:openFolder', async () => {
  fs.mkdirSync(userSoundsDir(), { recursive: true });
  const err = await shell.openPath(userSoundsDir());
  if (err) throw new Error(err);
  return true;
});

// Синхронная запись нужна только при закрытии окна, когда ждать ответа нельзя.
ipcMain.on('doc:writeSync', (event, kind, id, text) => {
  try {
    if (kind === 'chapter') project.writeChapter(requireDir(), id, text);
    else if (kind === 'chaptermeta') project.writeChapterMeta(requireDir(), id, JSON.parse(text));
    else project.writeItem(requireDir(), kind, id, text);
    event.returnValue = { ok: true };
  } catch (err) {
    event.returnValue = { ok: false, error: String((err && err.message) || err) };
  }
});

// ---------- окно и меню ----------

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---------- язык интерфейса ----------

const uiFile = () => path.join(app.getPath('userData'), 'ui.json');

function loadUi() {
  try {
    const raw = JSON.parse(fs.readFileSync(uiFile(), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function saveUi(obj) {
  writeFileAtomic(uiFile(), JSON.stringify(obj, null, 2));
}

i18n.setLang(loadUi().lang === 'en' ? 'en' : 'ru');

// Окно узнаёт язык синхронно при запуске, до первой отрисовки.
ipcMain.on('app:getLang', (event) => { event.returnValue = i18n.getLang(); });

// «О программе»: на macOS своя панель, на Windows и Linux обычное окно сообщения.
// Строка меню на Windows и Linux: по умолчанию видна, её можно спрятать (Вид → «Показывать строку меню»).
// Пока она спрятана, в окне появляется кнопка «☰» с тем же меню, а Alt показывает строку на время.
let menuBarVisible = true;

function applyMenuBar() {
  if (isMac || !win || win.isDestroyed()) return;
  win.setAutoHideMenuBar(!menuBarVisible);
  win.setMenuBarVisibility(menuBarVisible);
  send('ui:menuBar', menuBarVisible);
}

function setMenuBar(visible) {
  menuBarVisible = !!visible;
  try { saveUi({ ...loadUi(), menuBar: menuBarVisible }); } catch (err) { console.error('menuBar pref:', err.message); }
  applyMenuBar();
}

handle('app:popupMenu', (x, y) => {
  const m = Menu.getApplicationMenu();
  if (m && win) m.popup({ window: win, x: Math.round(Number(x) || 0), y: Math.round(Number(y) || 0) });
  return true;
});

function showAbout() {
  if (isMac) { app.showAboutPanel(); return; }
  dialog.showMessageBox(win, {
    type: 'info',
    title: 'Кабинет',
    message: t('Кабинет {0}', app.getVersion()),
    detail: t('Редактор Александра Шавкунова'),
    buttons: ['OK'],
  });
}

function applyAbout() {
  if (!isMac) return;
  app.setAboutPanelOptions({
    applicationName: 'Кабинет',
    applicationVersion: app.getVersion(),
    version: '',
    copyright: t('Редактор Александра Шавкунова'),
  });
}

handle('app:setLang', (lang) => {
  const next = lang === 'en' ? 'en' : 'ru';
  saveUi({ ...loadUi(), lang: next });
  i18n.setLang(next);
  try { // язык проверки грамматики следует за языком текста (кроме «определять автоматически»)
    const cfg = loadCheck();
    if (cfg.lang !== 'auto' && cfg.lang !== next) saveCheck({ ...cfg, lang: next });
  } catch (err) { console.error('check lang:', err.message); }
  buildMenu();
  applyAbout();
  return next;
});

handle('app:about', () => { showAbout(); return true; });

// После смены языка окно перезагружается; проект при этом остаётся открытым в main.
handle('project:current', () => (currentDir ? project.openProject(currentDir) : null));

// ---------- проверка орфографии, пунктуации и грамматики ----------
// Орфографию при наборе подчёркивает система (работает без интернета). Глубокую проверку делает LanguageTool:
// текст главы уходит на сервер только по кнопке и только после согласия автора (или на свой локальный сервер).

const checkFile = () => path.join(app.getPath('userData'), 'check.json');
const CHECK_DEFAULT = { consent: false, server: '', lang: 'ru', disabledRules: [], hiddenKinds: [], words: [] };

function loadCheck() {
  try {
    const raw = JSON.parse(fs.readFileSync(checkFile(), 'utf8'));
    return { ...CHECK_DEFAULT, lang: loadUi().lang === 'en' ? 'en' : 'ru', ...(raw && typeof raw === 'object' ? raw : {}) };
  } catch {
    return { ...CHECK_DEFAULT, lang: loadUi().lang === 'en' ? 'en' : 'ru' };
  }
}

function saveCheck(cfg) {
  writeFileAtomic(checkFile(), JSON.stringify(cfg, null, 2));
}

const strList = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, 5000) : []);

handle('check:getConfig', () => loadCheck());

handle('check:setConfig', (patch) => {
  const cur = loadCheck();
  const p = patch && typeof patch === 'object' ? patch : {};
  if ('consent' in p) cur.consent = !!p.consent;
  if ('lang' in p) cur.lang = ['ru', 'en', 'auto'].includes(p.lang) ? p.lang : 'ru';
  if ('server' in p) {
    const v = String(p.server || '').trim();
    if (v) {
      const u = new URL(langcheck.normalizeServer(v)); // выбросит ошибку, если адрес неверный
      if (!/^https?:$/.test(u.protocol)) throw new Error('Адрес сервера должен начинаться с http:// или https://');
    }
    cur.server = v;
  }
  if ('disabledRules' in p) cur.disabledRules = strList(p.disabledRules);
  if ('hiddenKinds' in p) cur.hiddenKinds = langcheck.cleanKinds(p.hiddenKinds);
  if ('words' in p) cur.words = strList(p.words);
  saveCheck(cur);
  return cur;
});

let checkCtl = null;

handle('check:run', async (paragraphs, extraWords) => {
  const cfg = loadCheck();
  if (!Array.isArray(paragraphs)) throw new Error('Нет текста для проверки.');
  if (!cfg.consent && !langcheck.isLocalServer(cfg.server)) throw new Error('Сначала нужно разрешить отправку текста службе проверки.');
  if (checkCtl) checkCtl.abort();
  const ctl = new AbortController();
  checkCtl = ctl;
  try {
    return await langcheck.checkParagraphs(paragraphs.map(String), {
      server: cfg.server,
      lang: cfg.lang,
      disabledRules: cfg.disabledRules,
      hiddenKinds: langcheck.cleanKinds(cfg.hiddenKinds),
      words: [...cfg.words, ...strList(extraWords)],
      fetchImpl: (u, init) => net.fetch(u, init),
      signal: ctl.signal,
      onProgress: (done, total) => send('check:progress', { done, total }),
    });
  } finally {
    if (checkCtl === ctl) checkCtl = null;
  }
});

handle('check:cancel', () => { if (checkCtl) checkCtl.abort(); return true; });

handle('check:addWord', (word) => {
  const w = String(word || '').trim();
  if (!w) return false;
  const cfg = loadCheck();
  if (!cfg.words.includes(w)) { cfg.words.push(w); saveCheck(cfg); }
  if (win && !win.isDestroyed()) win.webContents.session.addWordToSpellCheckerDictionary(w);
  return true;
});

handle('check:ignoreRule', (ruleId) => {
  const id = String(ruleId || '').trim();
  if (!id) return false;
  const cfg = loadCheck();
  if (!cfg.disabledRules.includes(id)) { cfg.disabledRules.push(id); saveCheck(cfg); }
  return cfg.disabledRules;
});

// ---------- контекстное меню текста ----------
// Electron не рисует своё меню: подсказки системной орфографии приходят в событии, а меню строит окно.

handle('ctx:edit', (cmd) => {
  if (!win || win.isDestroyed()) return false;
  const wc = win.webContents;
  const map = { cut: 'cut', copy: 'copy', paste: 'paste', selectAll: 'selectAll', undo: 'undo', redo: 'redo' };
  if (!map[cmd]) throw new Error('Неизвестная команда.');
  wc[map[cmd]]();
  return true;
});

handle('ctx:replaceMisspelling', (word) => {
  if (win && !win.isDestroyed()) win.webContents.replaceMisspelling(String(word));
  return true;
});

// ---------- меню ----------

// Режим открытого проекта: слова в меню («глав» / «рассказов»). Только для русского интерфейса.
let projectMode = 'novel';
const tm = (ru) => t(i18n.getLang() === 'ru' ? termize(ru, projectMode) : ru);

function buildMenu() {
  const lang = i18n.getLang();
  const sep = { type: 'separator' };
  const aboutItem = { label: t('О программе «Кабинет»'), click: showAbout };
  const langItem = {
    label: t('Язык интерфейса'),
    submenu: [
      { label: 'Русский', type: 'radio', checked: lang === 'ru', click: () => send('ui:setLang', 'ru') },
      { label: 'English', type: 'radio', checked: lang === 'en', click: () => send('ui:setLang', 'en') },
    ],
  };
  const template = [
    {
      label: 'Кабинет',
      submenu: [
        aboutItem,
        sep,
        langItem,
        sep,
        { label: t('Службы'), role: 'services' },
        sep,
        { label: t('Скрыть «Кабинет»'), role: 'hide' },
        { label: t('Скрыть остальные'), role: 'hideOthers' },
        { label: t('Показать все'), role: 'unhide' },
        sep,
        { label: t('Завершить «Кабинет»'), role: 'quit' },
      ],
    },
    {
      label: t('Файл'),
      submenu: [
        { label: t('Новый проект…'), accelerator: 'CmdOrCtrl+N', click: () => send('ui:newProject') },
        { label: t('Открыть проект…'), accelerator: 'CmdOrCtrl+O', click: () => send('ui:openProject') },
        { label: t('Импорт глав…'), click: () => send('ui:importFiles') },
        sep,
        { label: t('Экспорт проекта…'), accelerator: 'CmdOrCtrl+E', click: () => send('ui:export') },
        sep,
        { label: t('Шаблоны карточек…'), click: () => send('ui:openTemplates') },
        {
          label: t('Резервные копии'),
          submenu: [
            { label: t('Сделать копию сейчас'), click: () => send('ui:backupNow') },
            { label: t('Открыть папку копий'), click: () => send('ui:openBackups') },
          ],
        },
        { label: t('Синхронизация…'), click: showSyncInfo },
        sep,
        { label: t('Закрыть проект'), accelerator: 'CmdOrCtrl+Shift+W', click: () => send('ui:closeProject') },
        { label: t('Закрыть окно'), role: 'close' },
      ],
    },
    {
      label: t('Правка'),
      submenu: [
        { label: t('Отменить'), role: 'undo' },
        { label: t('Повторить'), role: 'redo' },
        sep,
        { label: t('Вырезать'), role: 'cut' },
        { label: t('Копировать'), role: 'copy' },
        { label: t('Вставить'), role: 'paste' },
        { label: t('Выделить всё'), role: 'selectAll' },
        sep,
        { label: tm('Проверить текст главы…'), accelerator: 'CmdOrCtrl+Shift+L', click: () => send('ui:openCheck') },
        { label: t('Орфография при наборе вкл / выкл'), click: () => send('ui:toggleSpell') },
      ],
    },
    {
      label: t('Вид'),
      submenu: [
        { label: t('Поиск по проекту…'), accelerator: 'CmdOrCtrl+F', click: () => send('ui:openSearch') },
        sep,
        { label: tm('Показать / скрыть панель глав'), accelerator: 'CmdOrCtrl+\\', click: () => send('ui:toggleSidebar') },
        { label: t('Только лист'), accelerator: 'CmdOrCtrl+Shift+F', click: () => send('ui:toggleFocus') },
        { label: t('Режим «печатная машинка»'), accelerator: 'CmdOrCtrl+Shift+T', click: () => send('ui:toggleTypewriter') },
        { label: t('Звуки клавиш вкл / выкл'), accelerator: 'CmdOrCtrl+Shift+M', click: () => send('ui:toggleSound') },
        { label: t('Фоновый эмбиент вкл / выкл'), accelerator: 'CmdOrCtrl+Shift+A', click: () => send('ui:toggleAmbient') },
        { label: t('Текст и оформление…'), accelerator: 'CmdOrCtrl+,', click: () => send('ui:openSettings') },
        { label: t('Открыть папку со звуками…'), click: () => {
          fs.mkdirSync(userSoundsDir(), { recursive: true });
          shell.openPath(userSoundsDir());
        } },
        sep,
        { label: t('Полный экран'), role: 'togglefullscreen' },
        ...(isMac ? [] : [sep, { label: t('Показывать строку меню'), type: 'checkbox', checked: menuBarVisible, click: (item) => setMenuBar(item.checked) }]),
      ],
    },
    { label: t('Отзывы'), submenu: [{ label: t('Написать отзыв…'), click: showFeedback }] },
    { label: t('Обновления'), submenu: [{ label: t('Где взять новые версии…'), click: showUpdatesInfo }] },
    {
      label: t('Окно'),
      submenu: [
        { label: t('Свернуть'), role: 'minimize' },
        { label: t('Масштаб'), role: 'zoom' },
        sep,
        { label: t('Все окна на передний план'), role: 'front' },
      ],
    },
  ];
  if (!isMac) {
    // Windows и Linux: нет меню программы, язык и «О программе» уходят в «Файл», вместо «Масштаб» и «На передний план» только «Свернуть»
    const [, fileMenu, ...rest] = template;
    const windowMenu = rest.pop();
    fileMenu.submenu.push(sep, langItem, aboutItem, sep, { label: t('Выход'), role: 'quit' });
    windowMenu.submenu = windowMenu.submenu.filter((i) => i.role === 'minimize');
    template.splice(0, template.length, fileMenu, ...rest, windowMenu);
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 700,
    minHeight: 480,
    ...(isMac
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 14 } }
      : { autoHideMenuBar: !menuBarVisible, icon: path.join(__dirname, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png') }),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1a18' : '#f5f3ee',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  win.webContents.on('did-finish-load', applyMenuBar); // окно узнаёт, показана ли строка меню
  win.webContents.on('context-menu', (_e, p) => {
    if (!p.isEditable && !p.selectionText) return;
    send('ui:contextMenu', {
      x: p.x,
      y: p.y,
      misspelledWord: p.misspelledWord || '',
      suggestions: (p.dictionarySuggestions || []).slice(0, 6),
      selectionText: p.selectionText || '',
      isEditable: !!p.isEditable,
      editFlags: p.editFlags || {},
    });
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
}

applyAbout();

handle('app:version', () => app.getVersion());

app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId('ru.kabinet.writer'); // значок и группировка окон на панели задач
  menuBarVisible = loadUi().menuBar !== false;
  const icon = path.join(__dirname, 'build', 'icon.png');
  if (isMac && app.dock && fs.existsSync(icon)) app.dock.setIcon(icon); // при запуске из исходников
  if (!isMac) {
    // На macOS орфографию проверяет система, на Windows и Linux Chromium сам скачивает словари при первом запуске
    try {
      const have = session.defaultSession.availableSpellCheckerLanguages;
      const want = ['ru', 'en-US'].filter((l) => have.includes(l));
      if (want.length) session.defaultSession.setSpellCheckerLanguages(want);
    } catch (err) { console.error('spellcheck languages:', err.message); }
  }
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => { autoBackup(); syncStop(); });
// Окно дописывает несохранённые правки при закрытии (beforeunload), это уже после before-quit:
// итоговую копию делаем, когда все окна закрыты.
app.on('will-quit', () => { autoBackup(); });
app.on('window-all-closed', () => app.quit());
