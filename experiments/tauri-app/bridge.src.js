'use strict';
const declension = require('../../src/declension');
// Мост окна к Rust: тот же набор функций window.kabinet, что давал preload.js в Electron.
// Каждый вызов уходит в одну команду Rust `call(channel, args)`. Что ещё не перенесено, отвечает понятной ошибкой.
(function () {
  const tauri = window.__TAURI__;
  const invoke = tauri && tauri.core && tauri.core.invoke;
  async function call(channel, ...args) {
    if (!invoke) throw new Error('Оболочка Tauri недоступна.');
    try {
      return await invoke('call', { channel, args });
    } catch (err) {
      throw new Error(typeof err === 'string' ? err : (err && err.message) || String(err));
    }
  }
  const none = () => {}; // события из меню Electron: меню на Tauri пока нет
  const plat = /Mac/i.test(navigator.platform) ? 'darwin' : /Win/i.test(navigator.platform) ? 'win32' : 'linux';

  window.kabinet = {
    lang: 'ru',
    platform: plat,
    setLang: (l) => call('app:setLang', l),
    showAbout: () => call('app:about'),
    currentProject: () => call('project:current'),
    getCheckConfig: () => call('check:getConfig'),
    setCheckConfig: (p) => call('check:setConfig', p),
    runCheck: (paragraphs, extra) => call('check:run', paragraphs, extra),
    cancelCheck: () => call('check:cancel'),
    addCheckWord: (w) => call('check:addWord', w),
    getDictionary: () => call('check:getDictionary'),
    setDictionary: (w) => call('check:setDictionary', w),
    ignoreCheckRule: (id) => call('check:ignoreRule', id),
    editCommand: (c) => call('ctx:edit', c),
    replaceMisspelling: (w) => call('ctx:replaceMisspelling', w),
    webSearch: (t, e) => call('ctx:webSearch', t, e),
    listRecents: () => call('recents:list'),
    removeRecent: (p) => call('recents:remove', p),
    createProject: (n, m) => call('project:create', n, m),
    setProjectMode: (m) => call('project:setMode', m),
    setGoalUnit: (u) => call('project:setGoalUnit', u),
    setCharLimit: (l) => call('project:setCharLimit', l),
    openProjectDialog: () => call('project:openDialog'),
    openRecent: (p) => call('project:openRecent', p),
    closeProject: () => call('project:close'),
    addChapter: (a) => call('chapter:add', a),
    renameChapter: (id, t) => call('chapter:rename', id, t),
    moveChapter: (id, i) => call('chapter:move', id, i),
    setChapterGoal: (id, g) => call('chapter:setGoal', id, g),
    setDefaultGoal: (g) => call('project:setDefaultGoal', g),
    deleteChapter: (id) => call('chapter:delete', id),
    readChapter: (id) => call('chapter:read', id),
    writeChapter: (id, t) => call('chapter:write', id, t),
    setChapterMarker: (id, m) => call('chapter:setMarker', id, m),
    addItem: (k, a) => call('item:add', k, a),
    renameItem: (k, id, t) => call('item:rename', k, id, t),
    moveItem: (k, id, i) => call('item:move', k, id, i),
    setItemIcon: (k, id, i) => call('item:setIcon', k, id, i),
    deleteItem: (k, id) => call('item:delete', k, id),
    restoreTrash: (t) => call('trash:restore', t),
    purgeTrash: (t) => call('trash:purge', t),
    emptyTrash: () => call('trash:empty'),
    readItem: (k, id) => call('item:read', k, id),
    writeItem: (k, id, t) => call('item:write', k, id, t),
    readChapterMeta: (id) => call('chapter:readMeta', id),
    writeChapterMeta: (id, d) => call('chapter:writeMeta', id, d),
    searchProject: (q) => call('project:search', q),
    replaceProject: (f, r, d) => call('project:replace', f, r, d),
    exportProject: (o) => call('project:export', o),
    importFiles: () => call('project:import'),
    projectStats: () => call('project:stats'),
    backupNow: () => call('backup:now'),
    openBackupFolder: () => call('backup:openFolder'),
    appVersion: () => call('app:version'),
    setProjectGoal: (g) => call('project:setProjectGoal', g),
    setAnalysisSkip: (s) => call('project:setAnalysisSkip', s),
    setProjectDeadline: (d) => call('project:setDeadline', d),
    setDayWords: (d, w) => call('stats:setDay', d, w),
    statsSummary: (d, w) => call('stats:summary', d, w),
    projectBoard: () => call('project:board'),
    readSound: (s, f) => call('sounds:read', s, f),
    addSounds: (s) => call('sounds:add', s),
    removeSound: (s, f) => call('sounds:remove', s, f),
    cardIndex: async () => {
      const list = await call('cards:index');
      return list.map((c) => ({
        ...c,
        forms: c.inflect ? declension.nameForms(c.title, c.aliases, { kind: c.kind === 'item' ? 'place' : c.kind }) : [], // склонение остаётся на JS, как в Electron
      }));
    },
    cardMentions: (k, id) => call('cards:mentions', k, id),
    readImage: (f) => call('image:read', f),
    pickImage: () => call('image:pick'),
    setTemplate: (k, n) => call('project:setTemplate', k, n),
    // запись при закрытии окна: синхронного вызова в Tauri нет, поэтому отправляем запрос и не ждём ответа
    writeDocSync: (kind, id, text) => { if (kind === 'chapter') call('chapter:write', id, text).catch(() => {}); },
    popupMenu: (x, y) => call('app:popupMenu', x, y),
    reloadProject: () => call('project:reload'),
    dav: (op, ...args) => call(`dav:${op}`, ...args),
    setTheme: (t) => call('ui:setTheme', t),
    listFonts: () => call('fonts:list'),
    addFonts: () => call('fonts:add'),
    removeFont: (f) => call('fonts:remove', f),
    listSounds: () => call('sounds:list'),
    openSoundsFolder: () => call('sounds:openFolder'),
  };
  for (const name of [
    'onSetLang', 'onOpenCheck', 'onToggleSpell', 'onCheckProgress', 'onContextMenu', 'onToggleSidebar', 'onNewProject',
    'onOpenProject', 'onCloseProject', 'onToggleTypewriter', 'onToggleMarks', 'onToggleFocus', 'onOpenSettings',
    'onOpenSearch', 'onExport', 'onImportFiles', 'onMenuBar', 'onExternalChange', 'onOpenTemplates', 'onBackupNow',
    'onOpenBackups', 'onOpenSync', 'onSyncNow', 'onDavEvent', 'onToggleSound', 'onToggleAmbient',
  ]) window.kabinet[name] = none;
})();
