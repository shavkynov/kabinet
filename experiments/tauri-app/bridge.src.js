'use strict';
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
  // Двоичные данные приходят из Rust строкой base64; окну нужен Uint8Array, как Buffer из Electron.
  const fromB64 = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
  const closing = []; // записи, начатые при закрытии окна
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
    readSound: async (s, f) => fromB64(await call('sounds:read', s, f)),
    addSounds: (s) => call('sounds:add', s),
    removeSound: (s, f) => call('sounds:remove', s, f),
    cardIndex: async () => call('cards:index'), // падежные формы `forms` считает Rust (declension.rs)
    cardMentions: (kind, id) => call('cards:mentions', kind, id),
    readImage: (f) => call('image:read', f),
    pickImage: () => call('image:pick'),
    setTemplate: (k, n) => call('project:setTemplate', k, n),
    // Запись при закрытии окна: синхронного вызова в Tauri нет. Записи копятся в списке, а перед закрытием окно ждёт их (см. ниже).
    writeDocSync: (kind, id, text) => {
      const job = kind === 'chapter' ? call('chapter:write', id, text)
        : kind === 'chaptermeta' ? call('chapter:writeMeta', id, JSON.parse(text))
          : call('item:write', kind, id, text);
      closing.push(job.catch((e) => console.error('final save failed:', e && e.message)));
    },
    popupMenu: (x, y) => call('app:popupMenu', x, y),
    reloadProject: () => call('project:reload'),
    dav: (op, ...args) => call(`dav:${op}`, ...args),
    setTheme: (t) => call('ui:setTheme', t),
    listFonts: async () => (await call('fonts:list')).map((f) => ({ ...f, data: fromB64(f.data) })),
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
  // События из Rust: изменения от синхронизации и сообщения об обмене с облаком.
  const listen = tauri && tauri.event && tauri.event.listen;
  // Rust не закрывает окно сразу: просит сначала дописать несохранённое, ждёт записи и только потом закрывает.
  if (listen) {
    listen('app:close-requested', async () => {
      try { window.dispatchEvent(new Event('beforeunload')); await Promise.allSettled(closing); } catch (e) { console.error(e); }
      call('app:exit').catch(() => {});
    }).catch(() => {});
  }
  const subscribe = (event) => (cb) => { if (listen) listen(event, (e) => cb(e.payload)).catch(() => {}); };
  const subscribeVoid = (event) => (cb) => { if (listen) listen(event, () => cb()).catch(() => {}); };
  // Пункты главного меню (в Electron — send('ui:…')).
  const MENU = {
    onOpenCheck: 'ui:openCheck', onToggleSpell: 'ui:toggleSpell', onToggleSidebar: 'ui:toggleSidebar', onNewProject: 'ui:newProject',
    onOpenProject: 'ui:openProject', onCloseProject: 'ui:closeProject', onToggleTypewriter: 'ui:toggleTypewriter', onToggleMarks: 'ui:toggleMarks',
    onToggleFocus: 'ui:toggleFocus', onOpenSettings: 'ui:openSettings', onOpenSearch: 'ui:openSearch', onExport: 'ui:export',
    onImportFiles: 'ui:importFiles', onOpenTemplates: 'ui:openTemplates', onBackupNow: 'ui:backupNow', onOpenBackups: 'ui:openBackups',
    onOpenSync: 'ui:openSync', onSyncNow: 'ui:syncNow', onToggleSound: 'ui:toggleSound', onToggleAmbient: 'ui:toggleAmbient',
  };
  for (const [name, event] of Object.entries(MENU)) window.kabinet[name] = subscribeVoid(event);
  window.kabinet.onSetLang = subscribe('ui:setLang');
  window.kabinet.onCheckProgress = subscribe('check:progress');
  window.kabinet.onDavEvent = subscribe('dav:event');
  window.kabinet.onExternalChange = subscribe('sync:changed');
})();
