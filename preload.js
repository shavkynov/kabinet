'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Вызов в main: если там случилась ошибка, здесь она становится обычным исключением.
async function call(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

function on(channel, cb) {
  ipcRenderer.on(channel, () => cb());
}

// Подписка с данными (контекстное меню, ход проверки, смена языка).
function onData(channel, cb) {
  ipcRenderer.on(channel, (_e, payload) => cb(payload));
}

// Язык интерфейса узнаётся один раз при загрузке окна.
let lang = 'ru';
try { lang = ipcRenderer.sendSync('app:getLang') === 'en' ? 'en' : 'ru'; } catch { /* остаётся русский */ }

contextBridge.exposeInMainWorld('kabinet', {
  lang,
  platform: process.platform,
  setLang: (l) => call('app:setLang', l),
  showAbout: () => call('app:about'),
  currentProject: () => call('project:current'),
  onSetLang: (cb) => onData('ui:setLang', cb),
  onOpenCheck: (cb) => on('ui:openCheck', cb),
  onToggleSpell: (cb) => on('ui:toggleSpell', cb),

  // версии главы

  // проверка текста и контекстное меню
  getCheckConfig: () => call('check:getConfig'),
  setCheckConfig: (patch) => call('check:setConfig', patch),
  runCheck: (paragraphs, extraWords) => call('check:run', paragraphs, extraWords),
  cancelCheck: () => call('check:cancel'),
  addCheckWord: (w) => call('check:addWord', w),
  ignoreCheckRule: (id) => call('check:ignoreRule', id),
  onCheckProgress: (cb) => onData('check:progress', cb),
  onContextMenu: (cb) => onData('ui:contextMenu', cb),
  editCommand: (cmd) => call('ctx:edit', cmd),
  replaceMisspelling: (w) => call('ctx:replaceMisspelling', w),
  // проекты
  listRecents: () => call('recents:list'),
  removeRecent: (p) => call('recents:remove', p),
  createProject: (name, mode) => call('project:create', name, mode),
  setProjectMode: (mode) => call('project:setMode', mode),
  setGoalUnit: (unit) => call('project:setGoalUnit', unit),
  setCharLimit: (limit) => call('project:setCharLimit', limit),
  openProjectDialog: () => call('project:openDialog'),
  openRecent: (p) => call('project:openRecent', p),
  closeProject: () => call('project:close'),

  // главы
  addChapter: (afterId) => call('chapter:add', afterId),
  renameChapter: (id, title) => call('chapter:rename', id, title),
  moveChapter: (id, index) => call('chapter:move', id, index),
  setChapterGoal: (id, goal) => call('chapter:setGoal', id, goal),
  setDefaultGoal: (goal) => call('project:setDefaultGoal', goal),
  deleteChapter: (id) => call('chapter:delete', id),
  readChapter: (id) => call('chapter:read', id),
  writeChapter: (id, text) => call('chapter:write', id, text),
  setChapterMarker: (id, marker) => call('chapter:setMarker', id, marker),

  // карточки персонажей, места и заметки (kind: 'character' | 'place' | 'note')
  addItem: (kind, afterId) => call('item:add', kind, afterId),
  renameItem: (kind, id, title) => call('item:rename', kind, id, title),
  moveItem: (kind, id, index) => call('item:move', kind, id, index),
  setItemIcon: (kind, id, icon) => call('item:setIcon', kind, id, icon),
  deleteItem: (kind, id) => call('item:delete', kind, id),
  restoreTrash: (tid) => call('trash:restore', tid),
  purgeTrash: (tid) => call('trash:purge', tid),
  emptyTrash: () => call('trash:empty'),
  readItem: (kind, id) => call('item:read', kind, id),
  writeItem: (kind, id, text) => call('item:write', kind, id, text),
  readChapterMeta: (id) => call('chapter:readMeta', id),
  writeChapterMeta: (id, data) => call('chapter:writeMeta', id, data),
  searchProject: (q) => call('project:search', q),
  replaceProject: (find, repl, dry) => call('project:replace', find, repl, dry),
  exportProject: (opts) => call('project:export', opts),
  importFiles: () => call('project:import'),
  projectStats: () => call('project:stats'),
  backupNow: () => call('backup:now'),
  openBackupFolder: () => call('backup:openFolder'),
  appVersion: () => call('app:version'),
  setProjectGoal: (goal) => call('project:setProjectGoal', goal),
  setAnalysisSkip: (skip) => call('project:setAnalysisSkip', skip),
  setProjectDeadline: (date) => call('project:setDeadline', date),
  setDayWords: (date, words) => call('stats:setDay', date, words),
  statsSummary: (today, todayWords) => call('stats:summary', today, todayWords),
  projectBoard: () => call('project:board'),
  readSound: (slot, file) => call('sounds:read', slot, file),
  addSounds: (slot) => call('sounds:add', slot),
  removeSound: (slot, file) => call('sounds:remove', slot, file),
  cardIndex: () => call('cards:index'),
  cardMentions: (kind, id) => call('cards:mentions', kind, id),
  readImage: (file) => call('image:read', file),
  pickImage: () => call('image:pick'),
  setTemplate: (kind, names) => call('project:setTemplate', kind, names),

  // запись при закрытии окна: ждать ответа нельзя, поэтому синхронно
  writeDocSync: (kind, id, text) => {
    const res = ipcRenderer.sendSync('doc:writeSync', kind, id, text);
    if (!res.ok) throw new Error(res.error);
  },

  // команды из меню
  onToggleSidebar: (cb) => on('ui:toggleSidebar', cb),
  onNewProject: (cb) => on('ui:newProject', cb),
  onOpenProject: (cb) => on('ui:openProject', cb),
  onCloseProject: (cb) => on('ui:closeProject', cb),
  onToggleTypewriter: (cb) => on('ui:toggleTypewriter', cb),
  onToggleFocus: (cb) => on('ui:toggleFocus', cb),
  onOpenSettings: (cb) => on('ui:openSettings', cb),

  onOpenSearch: (cb) => on('ui:openSearch', cb),
  onExport: (cb) => on('ui:export', cb),
  onImportFiles: (cb) => on('ui:importFiles', cb),
  onMenuBar: (cb) => onData('ui:menuBar', cb),
  popupMenu: (x, y) => call('app:popupMenu', x, y),
  onExternalChange: (cb) => onData('sync:changed', cb),
  reloadProject: () => call('project:reload'),
  onOpenTemplates: (cb) => on('ui:openTemplates', cb),
  onBackupNow: (cb) => on('ui:backupNow', cb),
  onOpenBackups: (cb) => on('ui:openBackups', cb),
  onToggleSound: (cb) => on('ui:toggleSound', cb),
  onToggleAmbient: (cb) => on('ui:toggleAmbient', cb),

  // оформление
  setTheme: (theme) => call('ui:setTheme', theme),
  listFonts: () => call('fonts:list'),
  addFonts: () => call('fonts:add'),
  removeFont: (file) => call('fonts:remove', file),
  listSounds: () => call('sounds:list'),
  openSoundsFolder: () => call('sounds:openFolder'),
});
