'use strict';
const { createCloseCoordinator } = require('./close-coordinator');
// Мост окна к Rust: набор функций window.kabinet, который нужен окну.
// Каждый вызов уходит в одну команду Rust `call(channel, args)`. Что ещё не перенесено, отвечает понятной ошибкой.
(function () {
  const tauri = window.__TAURI__;
  const invoke = tauri && tauri.core && tauri.core.invoke;
  async function invokeCall(channel, ...args) {
    if (!invoke) throw new Error('Оболочка Tauri недоступна.');
    try { return await invoke('call', { channel, args }); }
    catch (err) { throw new Error(typeof err === 'string' ? err : (err && err.message) || String(err)); }
  }
  const deferredEvents = [];
  const closeGuard = createCloseCoordinator({
    prepare: async () => {
      if (!window.kabinet || typeof window.kabinet.prepareClose !== 'function') throw new Error('Редактор ещё не готов к безопасному закрытию.');
      return window.kabinet.prepareClose();
    },
    exit: () => invokeCall('app:exit'),
    cancel: () => invokeCall('app:close-cancel'),
    report: (error) => {
      console.error('close canceled:', error);
      window.alert('Закрытие отменено: изменения не сохранены. Окно и текст оставлены открытыми. ' + (error && error.message || String(error)));
    },
    lock: () => {
      const body = document.body;
      const previous = { body, inert: body && body.inert };
      if (body) body.inert = true;
      return previous;
    },
    unlock: (previous) => {
      if (previous && previous.body) previous.body.inert = previous.inert;
      for (const notify of deferredEvents.splice(0)) Promise.resolve().then(notify).catch(console.error);
    },
  });
  const writeChannels = new Set(['chapter:write', 'item:write', 'chapter:writeMeta', 'stats:setDay']);
  function call(channel, ...args) {
    if (writeChannels.has(channel)) {
      const detail = channel === 'item:write' ? args[1] : channel === 'chapter:writeMeta' ? Object.keys(args[1] || {}).sort().join(',') : null;
      return closeGuard.write(JSON.stringify([channel, args[0], detail]), () => invokeCall(channel, ...args));
    }
    return invokeCall(channel, ...args).then((result) => {
      if (result && channel === 'chapter:delete') closeGuard.forget((key) => {
        const [op, id] = JSON.parse(key);
        return id === args[0] && (op === 'chapter:write' || op === 'chapter:writeMeta');
      });
      if (result && channel === 'item:delete') closeGuard.forget((key) => {
        const [op, kind, id] = JSON.parse(key);
        return op === 'item:write' && kind === args[0] && id === args[1];
      });
      if (result && ['project:create', 'project:openDialog', 'project:openRecent', 'project:close'].includes(channel)) closeGuard.forget();
      return result;
    });
  }
  // Двоичные данные приходят из Rust строкой base64; окну нужен Uint8Array.
  const fromB64 = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
  const none = () => {}; // события из меню: пока без подписки
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
    spellLearn: (w) => call('spell:learn', w),
    toggleFullscreen: () => call('app:fullscreen'),
    menuPeek: () => call('app:menuPeek'),
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
    renameProject: (name) => call('project:rename', name),
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
    backupList: () => call('backup:list'),
    restoreBackup: (name) => call('backup:restore', name),
    restoreBackupInteractive: () => call('backup:restoreInteractive'),
    openBackupFolder: () => call('backup:openFolder'),
    appVersion: () => call('app:version'),
    feedbackReport: (kind, text, withLog) => call('log:report', kind, text, withLog),
    feedbackOpen: (kind, text, withLog) => call('feedback:open', kind, text, withLog),
    openLogFolder: () => call('log:openFolder'),
    setProjectGoal: (g) => call('project:setProjectGoal', g),
    setAnalysisSkip: (s) => call('project:setAnalysisSkip', s),
    styleParse: (text, taskId) => call('style:parse', text, taskId),
    styleCancel: (taskId) => call('style:cancel', taskId),
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
    // Совместимый метод; безопасное закрытие использует асинхронный prepareClose и очередь записей.
    writeDocSync: (kind, id, text) => {
      const job = kind === 'chapter' ? call('chapter:write', id, text)
        : kind === 'chaptermeta' ? call('chapter:writeMeta', id, JSON.parse(text))
          : call('item:write', kind, id, text);
      return job;
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
    'onOpenProject', 'onCloseProject', 'onRenameProject', 'onToggleTypewriter', 'onToggleMarks', 'onToggleFocus', 'onOpenSettings',
    'onOpenSearch', 'onExport', 'onImportFiles', 'onMenuBar', 'onExternalChange', 'onOpenTemplates', 'onBackupNow',
    'onOpenBackups', 'onOpenFeedback', 'onOpenSync', 'onSyncNow', 'onDavEvent', 'onToggleSound', 'onToggleAmbient',
  ]) window.kabinet[name] = none;
  // Правая кнопка: системное меню окна (английское, без карточек и поиска) заменено меню приложения из renderer
  // (renderer/app/12-links.js, onNativeContext). Подсказок орфографии у системы здесь нет: слова проверяет сам Кабинет.
  window.kabinet.onContextMenu = (cb) => {
    // Слово под курсором: берём из текста вокруг точки щелчка (слово целиком в одном текстовом узле).
    const wordRangeAt = (x, y) => {
      const r = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
      if (!r || r.startContainer.nodeType !== 3) return null;
      const text = r.startContainer.textContent;
      const ch = /[\p{L}\p{M}'’-]/u;
      let a = r.startOffset;
      let b = a;
      while (a > 0 && ch.test(text[a - 1])) a -= 1;
      while (b < text.length && ch.test(text[b])) b += 1;
      while (a < b && /['’-]/.test(text[a])) a += 1;
      while (b > a && /['’-]/.test(text[b - 1])) b -= 1;
      if (b - a < 2) return null;
      const range = document.createRange();
      range.setStart(r.startContainer, a);
      range.setEnd(r.startContainer, b);
      return range;
    };
    document.addEventListener('contextmenu', async (e) => {
      if (e.defaultPrevented) return;
      e.preventDefault();
      const x = e.clientX;
      const y = e.clientY;
      const a = document.activeElement;
      const editable = !!(e.target.closest && e.target.closest('.ProseMirror[contenteditable="true"], textarea, input'));
      let selObj = window.getSelection();
      if (!editable && !String(selObj || '')) return;
      // Системная проверка орфографии (Windows, macOS): слово под курсором, ошибка ли это и варианты исправления.
      let misspelledWord = '';
      let suggestions = [];
      let spellAvailable = false;
      const inEditor = !!(e.target.closest && e.target.closest('.ProseMirror[contenteditable="true"]'));
      if (inEditor && document.documentElement.getAttribute('spellcheck') === 'true') {
        const range = wordRangeAt(x, y);
        const cur = String(selObj || '').trim();
        if (range && (!cur || cur === range.toString())) {
          const word = range.toString();
          try {
            const v = await Promise.race([call('spell:check', word), new Promise((r) => setTimeout(() => r(null), 500))]);
            if (v && v.available) {
              spellAvailable = true;
              if (!v.ok) {
                misspelledWord = word;
                suggestions = (v.suggestions || []).slice(0, 6);
                selObj.removeAllRanges(); // выделяем слово: замена варианта пойдёт на его место
                selObj.addRange(range);
              }
            }
          } catch { /* без подсказок */ }
        }
      }
      selObj = window.getSelection();
      const sel = String(selObj || '');
      const isEditable = editable || !!(a && a.isContentEditable);
      const editFlags = { canCut: isEditable && !!sel, canCopy: !!sel, canPaste: isEditable, canSelectAll: isEditable };
      cb({ x, y, misspelledWord, suggestions, spellAvailable, selectionText: sel.slice(0, 2000), isEditable, editFlags });
    });
  };
  // События из Rust: изменения от синхронизации и сообщения об обмене с облаком.
  const listen = tauri && tauri.event && tauri.event.listen;
  // Rust не закрывает окно сразу: просит сначала дописать несохранённое, ждёт записи и только потом закрывает.
  if (listen) {
    listen('app:close-requested', () => closeGuard.close()).catch((error) => console.error('close listener:', error));
  }
  const subscribe = (event) => (cb) => { if (listen) listen(event, (e) => {
    if (closeGuard.isClosing()) deferredEvents.push(() => cb(e.payload));
    else cb(e.payload);
  }).catch(() => {}); };
  const subscribeVoid = (event) => (cb) => { if (listen) listen(event, () => { if (!closeGuard.isClosing()) cb(); }).catch(() => {}); };
  // Пункты главного меню .
  const MENU = {
    onOpenCheck: 'ui:openCheck', onToggleSpell: 'ui:toggleSpell', onToggleSidebar: 'ui:toggleSidebar', onNewProject: 'ui:newProject',
    onOpenProject: 'ui:openProject', onCloseProject: 'ui:closeProject', onRenameProject: 'ui:renameProject', onToggleTypewriter: 'ui:toggleTypewriter', onToggleMarks: 'ui:toggleMarks',
    onToggleFocus: 'ui:toggleFocus', onOpenSettings: 'ui:openSettings', onOpenSearch: 'ui:openSearch', onExport: 'ui:export',
    onImportFiles: 'ui:importFiles', onOpenTemplates: 'ui:openTemplates', onBackupNow: 'ui:backupNow', onRestoreBackup: 'ui:restoreBackup', onOpenBackups: 'ui:openBackups', onOpenFeedback: 'ui:feedback',
    onOpenSync: 'ui:openSync', onSyncNow: 'ui:syncNow', onToggleSound: 'ui:toggleSound', onToggleAmbient: 'ui:toggleAmbient',
  };
  for (const [name, event] of Object.entries(MENU)) window.kabinet[name] = subscribeVoid(event);
  // Ошибки окна уходят в журнал приложения (не больше 30 за сеанс, чтобы цикл ошибок не раздул файл).
  let sent = 0;
  const report = (m) => { if (sent < 30) { sent += 1; call('log:write', 'error', String(m).slice(0, 800)).catch(() => {}); } };
  window.addEventListener('error', (e) => report(`${e.message} (${String(e.filename || '').split('/').pop()}:${e.lineno})`));
  window.addEventListener('unhandledrejection', (e) => report(`promise: ${(e.reason && e.reason.stack) || e.reason}`));
  // Диагностика звука (renderer/sounds.js): состояние звукового контекста пишется в журнал, до 10 раз за сеанс.
  let soundNotes = 0;
  window.addEventListener('kabinet:sound-note', (e) => { if (soundNotes < 10) { soundNotes += 1; call('log:write', 'info', `звук: ${String(e.detail).slice(0, 200)}`).catch(() => {}); } });
  window.kabinet.onSetLang = subscribe('ui:setLang');
  window.kabinet.onCheckProgress = subscribe('check:progress');
  window.kabinet.onDavEvent = subscribe('dav:event');
  window.kabinet.onExternalChange = subscribe('sync:changed');
})();
