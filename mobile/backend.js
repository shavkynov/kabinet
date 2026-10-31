'use strict';
// «Главный процесс» Кабинета для Android. Повторяет обработчики main.js (те же каналы и те же ответы),
// но работает внутри окна: файлы лежат в виртуальной ФС (mobile/shim/fs.js), диалоги и выдача файлов — через host.
//
// host (задаёт boot.js; в тестах подставляется заглушка):
//   confirm({ message, detail, buttons, cancelId })  → номер нажатой кнопки
//   choose({ title, message, options:[{label,value}], cancel }) → value или null
//   pickFiles({ accept, multiple })                  → [{ name, data: Uint8Array }]
//   deliver({ name, mime, data })                    → сохранить или отправить файл
//   openUrl(url)
//   zip(entries:[{path,data}]) → Uint8Array;  unzip(bytes) → [{path,data}]   (необязательно)
//   version, platform

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const project = require('../src/project');
const recents = require('../src/recents');
const backup = require('../src/backup');
const searcher = require('../src/search');
const replacer = require('../src/replace');
const mentions = require('../src/mentions');
const stats = require('../src/stats');
const exporter = require('../src/export');
const importer = require('../src/import');
const { writeFileAtomic } = require('../src/fsutil');
const langcheck = require('../src/langcheck');
const i18n = require('../src/i18n');
const themes = require('../src/themes');
const searchEngines = require('../src/searchengines');

const { t, tdom } = i18n;

const ROOT = '/Кабинет';
const PROJECTS = `${ROOT}/Проекты`;
const APP = `${ROOT}/_app`;
const COPIES = `${ROOT}/Копии`;

const FONT_EXT = /\.(ttf|otf|woff2?)$/i;
const MAX_FONT_BYTES = 40 * 1024 * 1024;
const SOUND_SLOTS = [
  'ambient/rain', 'ambient/fire', 'ambient/wind', 'ambient/sea', 'ambient/hum',
  'keys/key', 'keys/space', 'keys/backspace', 'keys/enter',
];
const AUDIO_EXT = /\.(wav|mp3|ogg|m4a|aac)$/i;
const CHECK_DEFAULT = { consent: false, server: '', lang: 'ru', disabledRules: [], hiddenKinds: [], words: [] };
const strList = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, 5000) : []);

function safeFolderName(name) {
  const n = String(name ?? '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/^\.+/, '')
    .trim()
    .replace(/[. ]+$/, '');
  if (!n) throw new Error('Введите название проекта.');
  return n.slice(0, 80);
}

function createBackend(host, { session } = {}) {
  const sess = session || { get: () => null, set: () => {} };
  let currentDir = sess.get('currentDir');
  if (currentDir && !fs.existsSync(path.join(currentDir, 'project.json'))) currentDir = null;
  const listeners = new Map();
  let checkCtl = null;

  fs.mkdirSync(PROJECTS, { recursive: true });
  fs.mkdirSync(APP, { recursive: true });

  const recentsFile = () => path.join(APP, 'recent-projects.json');
  const uiFile = () => path.join(APP, 'ui.json');
  const checkFile = () => path.join(APP, 'check.json');
  const fontsDir = () => path.join(APP, 'fonts');
  const userSoundsDir = () => path.join(APP, 'sounds');

  function loadUi() {
    try {
      const raw = JSON.parse(fs.readFileSync(uiFile(), 'utf8'));
      return raw && typeof raw === 'object' ? raw : {};
    } catch { return {}; }
  }
  const saveUi = (obj) => writeFileAtomic(uiFile(), JSON.stringify(obj, null, 2));
  i18n.setLang(loadUi().lang === 'en' ? 'en' : 'ru');

  function loadCheck() {
    const lang = loadUi().lang === 'en' ? 'en' : 'ru';
    try {
      const raw = JSON.parse(fs.readFileSync(checkFile(), 'utf8'));
      return { ...CHECK_DEFAULT, lang, ...(raw && typeof raw === 'object' ? raw : {}) };
    } catch { return { ...CHECK_DEFAULT, lang }; }
  }
  const saveCheck = (cfg) => writeFileAtomic(checkFile(), JSON.stringify(cfg, null, 2));

  function backupRoot(dir) {
    const key = crypto.createHash('sha1').update(dir).digest('hex').slice(0, 8);
    const name = path.basename(dir).replace(/[\\/:*?"<>|]/g, '-') || 'project';
    return path.join(COPIES, `${name}-${key}`);
  }

  // Копии лежат вне проекта и хранятся короче, чем на компьютере: память телефона не безгранична.
  const BACKUP_OPTS = { keep: 20, keepDays: 14 };

  function autoBackup() {
    if (!currentDir) return null;
    try { return backup.makeBackup(currentDir, { ...BACKUP_OPTS, root: backupRoot(currentDir) }); } catch (err) {
      console.error('backup failed:', err);
      return null;
    }
  }

  const requireDir = () => {
    if (!currentDir) throw new Error('Проект не открыт.');
    return currentDir;
  };

  function setCurrent(dir) {
    currentDir = dir;
    sess.set('currentDir', dir);
  }

  function openAt(dir) {
    const proj = project.openProject(dir);
    setCurrent(dir);
    recents.add(recentsFile(), { path: dir, name: proj.name });
    autoBackup();
    return proj;
  }

  // ---------- каналы ----------

  const handlers = {};
  const handle = (channel, fn) => { handlers[channel] = fn; };

  const uniqueDir = (base) => {
    let dir = path.join(PROJECTS, base);
    for (let i = 2; fs.existsSync(dir); i += 1) dir = path.join(PROJECTS, `${base} ${i}`);
    return dir;
  };

  const projectList = () => {
    const out = [];
    for (const e of fs.readdirSync(PROJECTS, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const dir = path.join(PROJECTS, e.name);
      if (!fs.existsSync(path.join(dir, 'project.json'))) continue;
      let name = e.name;
      try { name = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')).name || name; } catch { /* имя папки */ }
      out.push({ dir, name });
    }
    return out;
  };

  // Проект из ZIP-копии: в архиве папка проекта или сразу файлы (project.json в корне).
  function importZipProject(bytes, fallbackName) {
    if (!host.unzip) throw new Error('Чтение ZIP здесь недоступно.');
    const entries = host.unzip(bytes).filter((e) => e.data && !e.path.endsWith('/'));
    const meta = entries.find((e) => /(^|\/)project\.json$/.test(e.path));
    if (!meta) throw new Error('В архиве нет файла project.json: это не копия проекта.');
    const prefix = meta.path.slice(0, meta.path.length - 'project.json'.length);
    let label = fallbackName;
    try { label = JSON.parse(Buffer.from(meta.data).toString('utf8')).name || label; } catch { /* имя файла */ }
    const dir = uniqueDir(safeFolderName(label || 'Проект'));
    for (const e of entries) {
      if (!e.path.startsWith(prefix)) continue;
      const rel = e.path.slice(prefix.length);
      if (!rel || rel.split('/').includes('..')) continue;
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), Buffer.from(e.data));
    }
    return dir;
  }

  handle('recents:list', () => recents.list(recentsFile()));
  handle('recents:remove', (p) => { recents.remove(recentsFile(), String(p)); return true; });

  handle('project:create', (name, mode) => {
    const dir = uniqueDir(safeFolderName(name));
    const proj = project.createProject(dir, String(name), { mode });
    setCurrent(dir);
    recents.add(recentsFile(), { path: dir, name: proj.name });
    return proj;
  });

  handle('project:openDialog', async () => {
    const list = projectList();
    const options = list.map((p) => ({ label: p.name, value: p.dir }));
    if (host.unzip) options.push({ label: t('Из ZIP-копии…'), value: '\0zip' });
    if (!options.length) throw new Error('Проектов пока нет. Создайте новый на стартовой странице.');
    const pick = await host.choose({ title: t('Открыть проект'), message: t('Выберите проект'), options, cancel: t('Отмена') });
    if (!pick) return null;
    if (pick === '\0zip') {
      const files = await host.pickFiles({ accept: '.zip,application/zip', multiple: false });
      if (!files.length) return null;
      return openAt(importZipProject(files[0].data, files[0].name.replace(/\.zip$/i, '')));
    }
    return openAt(pick);
  });

  handle('project:openRecent', (p) => {
    const dir = String(p);
    if (!recents.has(recentsFile(), dir)) throw new Error('Этого проекта нет в списке недавних.');
    return openAt(dir);
  });

  handle('backup:now', () => autoBackup());
  // Папки копий на телефоне не видно, поэтому вместо «открыть папку» отдаём ZIP со всем проектом.
  handle('backup:openFolder', () => exportZip());
  handle('chapter:readMeta', (id) => project.readChapterMeta(requireDir(), id));
  handle('chapter:writeMeta', (id, data) => project.writeChapterMeta(requireDir(), id, data));
  handle('project:search', (query) => searcher.searchProject(requireDir(), query));
  handle('project:replace', (find, repl, dry) => {
    const dir = requireDir();
    if (!dry) backup.makeBackup(dir, { ...BACKUP_OPTS, root: backupRoot(dir) });
    return replacer.replaceProject(dir, find, repl, { dry: !!dry });
  });

  const EXPORT_FORMATS = [
    { label: 'Word (DOCX)', value: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    { label: 'RTF', value: 'rtf', mime: 'application/rtf' },
    { label: 'Markdown', value: 'md', mime: 'text/markdown' },
    { label: 'Обычный текст (TXT)', value: 'txt', mime: 'text/plain' },
    { label: 'HTML (в браузере: «Печать» → PDF)', value: 'html', mime: 'text/html' },
  ];

  handle('project:export', async (opts) => {
    const dir = requireDir();
    const exportOpts = { indent: !!(opts && opts.indent) };
    const fmt = await host.choose({
      title: t('Экспорт проекта'),
      message: t('Формат файла'),
      options: EXPORT_FORMATS.map((f) => ({ label: f.label.startsWith('Обычный') || f.label.startsWith('HTML') ? t(f.label) : f.label, value: f.value })),
      cancel: t('Отмена'),
    });
    if (!fmt) return null;
    const def = EXPORT_FORMATS.find((f) => f.value === fmt);
    const out = exporter.buildExport(dir, fmt, i18n.getLang(), fmt === 'docx' ? undefined : exportOpts);
    const data = typeof out === 'string' ? new TextEncoder().encode(out) : new Uint8Array(out);
    const name = `${path.basename(dir)}.${fmt}`;
    await host.deliver({ name, mime: def.mime, data });
    return name;
  });

  handle('project:import', async () => {
    const dir = requireDir();
    const picked = await host.pickFiles({ accept: '.docx,.rtf,.md,.markdown,.txt', multiple: true });
    if (!picked.length) return null;
    const items = [];
    const skipped = [];
    for (const f of picked.slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
      try {
        if (f.data.length > importer.MAX_FILE) throw new Error(t('Файл слишком большой для импорта (больше 30 МБ).'));
        items.push(...importer.parseFile(f.name, Buffer.from(f.data)));
      } catch (err) {
        skipped.push(`${f.name}: ${tdom(String(err.message)) || err.message}`);
      }
    }
    if (!items.length) throw new Error(skipped.join('\n') || t('В файлах нет текста.'));
    backup.makeBackup(dir, { ...BACKUP_OPTS, root: backupRoot(dir) });
    const out = project.importChapters(dir, items);
    return { project: out.project, ids: out.ids, skipped };
  });

  // Весь проект одним ZIP-файлом: надёжный способ сохранить или перенести работу.
  async function exportZip() {
    const dir = requireDir();
    if (!host.zip) throw new Error('Создание ZIP здесь недоступно.');
    const entries = [];
    const walk = (rel) => {
      for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(r);
        else if (!e.name.endsWith('.tmp')) entries.push({ path: `${path.basename(dir)}/${r}`, data: new Uint8Array(fs.readFileSync(path.join(dir, r))) });
      }
    };
    walk('');
    const name = `${path.basename(dir)}.zip`;
    await host.deliver({ name, mime: 'application/zip', data: host.zip(entries) });
    return name;
  }

  handle('project:stats', () => project.projectStats(requireDir()));
  handle('project:setProjectGoal', (goal) => project.setProjectGoal(requireDir(), goal));
  handle('project:setAnalysisSkip', (skip) => project.setAnalysisSkip(requireDir(), skip));
  handle('project:setDeadline', (date) => project.setProjectDeadline(requireDir(), date));
  handle('stats:setDay', (date, words) => { stats.setDayWords(requireDir(), date, words); return true; });
  handle('stats:summary', (today, todayWords) => {
    const dir = requireDir();
    const v = project.openProject(dir);
    return stats.summary(dir, {
      today,
      todayWords,
      goal: v.projectGoal,
      deadline: v.deadline,
      total: (() => { const st = project.projectStats(dir); return v.mode === 'stories' && v.goalUnit === 'chars' ? st.totalChars : st.total; })(),
    });
  });
  handle('project:board', () => project.boardData(requireDir()));
  handle('project:reload', () => project.openProject(requireDir()));
  handle('project:setGoalUnit', (unit) => project.setGoalUnit(requireDir(), unit));
  handle('project:setCharLimit', (limit) => project.setCharLimit(requireDir(), limit));
  handle('project:setMode', (mode) => project.setProjectMode(requireDir(), mode));
  handle('project:close', () => {
    autoBackup();
    setCurrent(null);
    return true;
  });

  handle('chapter:add', (afterId) => project.addChapter(requireDir(), afterId || null));
  handle('chapter:rename', (id, title) => project.renameChapter(requireDir(), id, title));
  handle('chapter:move', (id, index) => project.moveChapter(requireDir(), id, index));
  handle('chapter:setGoal', (id, goal) => project.setChapterGoal(requireDir(), id, goal));
  handle('chapter:setMarker', (id, marker) => project.setChapterMarker(requireDir(), id, marker));
  handle('chapter:read', (id) => project.readChapter(requireDir(), id));
  handle('chapter:write', (id, text) => project.writeChapter(requireDir(), id, text));
  handle('chapter:delete', (id) => project.deleteChapter(requireDir(), id));
  handle('project:setDefaultGoal', (goal) => project.setDefaultGoal(requireDir(), goal));

  handle('item:add', (kind, afterId) => project.addItem(requireDir(), kind, afterId || null));
  handle('item:rename', (kind, id, title) => project.renameItem(requireDir(), kind, id, title));
  handle('item:move', (kind, id, index) => project.moveItem(requireDir(), kind, id, index));
  handle('item:setIcon', (kind, id, icon) => project.setItemIcon(requireDir(), kind, id, icon));
  handle('item:read', (kind, id) => project.readItem(requireDir(), kind, id));
  handle('item:write', (kind, id, text) => project.writeItem(requireDir(), kind, id, text));
  handle('item:delete', (kind, id) => project.deleteItem(requireDir(), kind, id));
  handle('cards:index', () => project.cardIndex(requireDir()));
  handle('cards:mentions', (kind, id) => mentions.cardMentions(requireDir(), kind, id));
  handle('image:read', (file) => project.readImage(requireDir(), file));
  handle('image:pick', async () => {
    const dir = requireDir();
    const picked = await host.pickFiles({ accept: 'image/png,image/jpeg,image/webp,image/gif', multiple: false });
    if (!picked.length) return null;
    const tmp = path.join('/tmp', `pick-${Date.now()}-${path.basename(picked[0].name)}`);
    fs.writeFileSync(tmp, Buffer.from(picked[0].data));
    try { return project.addImage(dir, tmp); } finally { try { fs.unlinkSync(tmp); } catch { /* временный файл */ } }
  });
  handle('project:setTemplate', (kind, names) => project.setTemplate(requireDir(), kind, names));

  handle('trash:restore', (tid) => project.restoreTrash(requireDir(), String(tid)));
  handle('trash:purge', async (tid) => {
    const dir = requireDir();
    const title = project.trashTitle(dir, String(tid));
    const res = await host.confirm({
      message: t('Удалить «{0}» навсегда?', title),
      detail: t('Это нельзя отменить.'),
      buttons: [t('Удалить навсегда'), t('Отмена')],
      cancelId: 1,
    });
    if (res !== 0) return null;
    return project.purgeTrash(dir, String(tid));
  });
  handle('trash:empty', async () => {
    const dir = requireDir();
    const res = await host.confirm({
      message: t('Очистить корзину?'),
      detail: t('Всё, что в ней лежит, будет удалено навсегда. Это нельзя отменить.'),
      buttons: [t('Очистить'), t('Отмена')],
      cancelId: 1,
    });
    if (res !== 0) return null;
    return project.emptyTrash(dir);
  });

  handle('ui:setTheme', (theme) => {
    if (!themes.isTheme(theme)) throw new Error('Неизвестная тема.');
    return true;
  });

  // ----- шрифты -----
  const familyFromFile = (file) => path.basename(file).replace(FONT_EXT, '').replace(/["'\\]/g, '').trim() || 'Шрифт';
  handle('fonts:list', () => {
    const dir = fontsDir();
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => FONT_EXT.test(f)).sort()
      .map((f) => ({ file: f, family: familyFromFile(f), data: new Uint8Array(fs.readFileSync(path.join(dir, f))) }));
  });
  handle('fonts:add', async () => {
    const picked = await host.pickFiles({ accept: '.ttf,.otf,.woff,.woff2,font/*', multiple: true });
    if (!picked.length) return [];
    fs.mkdirSync(fontsDir(), { recursive: true });
    const added = [];
    for (const f of picked) {
      const name = path.basename(f.name);
      if (!FONT_EXT.test(name)) continue;
      if (f.data.length > MAX_FONT_BYTES) throw new Error(`Файл слишком большой: ${name}`);
      fs.writeFileSync(path.join(fontsDir(), name), Buffer.from(f.data));
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

  // ----- свои звуки -----
  function slotDir(slot) {
    if (!SOUND_SLOTS.includes(slot)) throw new Error('Неизвестный вариант звука.');
    return path.join(userSoundsDir(), ...slot.split('/'));
  }
  handle('sounds:list', () => {
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
    return new Uint8Array(fs.readFileSync(path.join(slotDir(slot), name)));
  });
  handle('sounds:add', async (slot) => {
    const dir = slotDir(slot);
    const picked = await host.pickFiles({ accept: '.wav,.mp3,.ogg,.m4a,.aac,audio/*', multiple: true });
    if (!picked.length) return [];
    fs.mkdirSync(dir, { recursive: true });
    const limit = slot.startsWith('ambient/') ? 60 : 10;
    const added = [];
    for (const f of picked) {
      const base = path.basename(f.name);
      if (!AUDIO_EXT.test(base)) continue;
      if (f.data.length > limit * 1024 * 1024) throw new Error(`Файл слишком большой (больше ${limit} МБ): ${base}`);
      let name = base;
      for (let i = 2; fs.existsSync(path.join(dir, name)); i += 1) name = base.replace(/(\.[^.]+)$/, ` ${i}$1`);
      fs.writeFileSync(path.join(dir, name), Buffer.from(f.data));
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
  handle('sounds:openFolder', () => { throw new Error('На телефоне своих звуков добавляют кнопкой «Добавить» у нужного варианта.'); });

  // ----- язык, версия -----
  handle('app:setLang', (lang) => {
    const next = lang === 'en' ? 'en' : 'ru';
    saveUi({ ...loadUi(), lang: next });
    i18n.setLang(next);
    try {
      const cfg = loadCheck();
      if (cfg.lang !== 'auto' && cfg.lang !== next) saveCheck({ ...cfg, lang: next });
    } catch (err) { console.error('check lang:', err.message); }
    return next;
  });
  handle('app:about', async () => {
    await host.confirm({ message: t('Кабинет {0}', host.version), detail: t('Редактор Александра Шавкунова'), buttons: ['OK'], cancelId: 0 });
    return true;
  });
  handle('app:version', () => host.version);
  handle('project:current', () => (currentDir ? project.openProject(currentDir) : null));
  handle('app:popupMenu', (x, y) => { if (host.popupMenu) host.popupMenu(x, y); return true; });

  // ----- проверка текста (LanguageTool) -----
  handle('check:getConfig', () => loadCheck());
  handle('check:setConfig', (patch) => {
    const cur = loadCheck();
    const p = patch && typeof patch === 'object' ? patch : {};
    if ('consent' in p) cur.consent = !!p.consent;
    if ('lang' in p) cur.lang = ['ru', 'en', 'auto'].includes(p.lang) ? p.lang : 'ru';
    if ('server' in p) {
      const v = String(p.server || '').trim();
      if (v) {
        const u = new URL(langcheck.normalizeServer(v));
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
        fetchImpl: (u, init) => fetch(u, init),
        signal: ctl.signal,
        onProgress: (done, total) => emit('check:progress', { done, total }),
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
    return true;
  });
  handle('check:ignoreRule', (ruleId) => {
    const id = String(ruleId || '').trim();
    if (!id) return false;
    const cfg = loadCheck();
    if (!cfg.disabledRules.includes(id)) { cfg.disabledRules.push(id); saveCheck(cfg); }
    return cfg.disabledRules;
  });

  // ----- правка и поиск в интернете -----
  handle('ctx:edit', async (cmd) => {
    if (!['cut', 'copy', 'paste', 'selectAll', 'undo', 'redo'].includes(cmd)) throw new Error('Неизвестная команда.');
    if (cmd === 'paste') {
      try {
        const text = await navigator.clipboard.readText();
        if (text) document.execCommand('insertText', false, text);
      } catch { /* буфер недоступен */ }
      return true;
    }
    if (typeof document !== 'undefined') document.execCommand(cmd);
    return true;
  });
  handle('ctx:replaceMisspelling', () => true);
  handle('ctx:webSearch', (text, engine) => {
    const url = searchEngines.searchUrl(engine, text, i18n.getLang());
    if (!url) return false;
    host.openUrl(url);
    return true;
  });

  // Синхронная запись при закрытии окна.
  function writeDocSync(kind, id, text) {
    if (kind === 'chapter') project.writeChapter(requireDir(), id, text);
    else if (kind === 'chaptermeta') project.writeChapterMeta(requireDir(), id, JSON.parse(text));
    else project.writeItem(requireDir(), kind, id, text);
    fs.flush();
  }

  // ---------- события ----------
  function emit(channel, payload) {
    for (const cb of listeners.get(channel) || []) {
      try { cb(payload); } catch (err) { console.error(channel, err); }
    }
  }
  const on = (channel) => (cb) => {
    if (!listeners.has(channel)) listeners.set(channel, []);
    listeners.get(channel).push(cb);
  };

  async function call(channel, ...args) {
    const fn = handlers[channel];
    if (!fn) throw new Error(`Нет такого канала: ${channel}`);
    try {
      return await fn(...args);
    } catch (err) {
      const msg = String((err && err.message) || err);
      throw new Error(tdom(msg) || msg);
    }
  }

  const api = {
    lang: i18n.getLang(),
    platform: host.platform || 'android',
    setLang: (l) => call('app:setLang', l),
    showAbout: () => call('app:about'),
    currentProject: () => call('project:current'),
    onSetLang: on('ui:setLang'),
    onOpenCheck: on('ui:openCheck'),
    onToggleSpell: on('ui:toggleSpell'),
    getCheckConfig: () => call('check:getConfig'),
    setCheckConfig: (patch) => call('check:setConfig', patch),
    runCheck: (paragraphs, extraWords) => call('check:run', paragraphs, extraWords),
    cancelCheck: () => call('check:cancel'),
    addCheckWord: (w) => call('check:addWord', w),
    ignoreCheckRule: (id) => call('check:ignoreRule', id),
    onCheckProgress: on('check:progress'),
    onContextMenu: on('ui:contextMenu'),
    editCommand: (cmd) => call('ctx:edit', cmd),
    replaceMisspelling: (w) => call('ctx:replaceMisspelling', w),
    webSearch: (text, engine) => call('ctx:webSearch', text, engine),
    listRecents: () => call('recents:list'),
    removeRecent: (p) => call('recents:remove', p),
    createProject: (name, mode) => call('project:create', name, mode),
    setProjectMode: (mode) => call('project:setMode', mode),
    setGoalUnit: (unit) => call('project:setGoalUnit', unit),
    setCharLimit: (limit) => call('project:setCharLimit', limit),
    openProjectDialog: () => call('project:openDialog'),
    openRecent: (p) => call('project:openRecent', p),
    closeProject: () => call('project:close'),
    addChapter: (afterId) => call('chapter:add', afterId),
    renameChapter: (id, title) => call('chapter:rename', id, title),
    moveChapter: (id, index) => call('chapter:move', id, index),
    setChapterGoal: (id, goal) => call('chapter:setGoal', id, goal),
    setDefaultGoal: (goal) => call('project:setDefaultGoal', goal),
    deleteChapter: (id) => call('chapter:delete', id),
    readChapter: (id) => call('chapter:read', id),
    writeChapter: (id, text) => call('chapter:write', id, text),
    setChapterMarker: (id, marker) => call('chapter:setMarker', id, marker),
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
    writeDocSync: (kind, id, text) => writeDocSync(kind, id, text),
    onToggleSidebar: on('ui:toggleSidebar'),
    onNewProject: on('ui:newProject'),
    onOpenProject: on('ui:openProject'),
    onCloseProject: on('ui:closeProject'),
    onToggleTypewriter: on('ui:toggleTypewriter'),
    onToggleMarks: on('ui:toggleMarks'),
    onToggleFocus: on('ui:toggleFocus'),
    onOpenSettings: on('ui:openSettings'),
    onOpenSearch: on('ui:openSearch'),
    onExport: on('ui:export'),
    onImportFiles: on('ui:importFiles'),
    onMenuBar: on('ui:menuBar'),
    popupMenu: (x, y) => call('app:popupMenu', x, y),
    onExternalChange: on('sync:changed'),
    reloadProject: () => call('project:reload'),
    onOpenTemplates: on('ui:openTemplates'),
    onBackupNow: on('ui:backupNow'),
    onOpenBackups: on('ui:openBackups'),
    onToggleSound: on('ui:toggleSound'),
    onToggleAmbient: on('ui:toggleAmbient'),
    setTheme: (theme) => call('ui:setTheme', theme),
    listFonts: () => call('fonts:list'),
    addFonts: () => call('fonts:add'),
    removeFont: (file) => call('fonts:remove', file),
    listSounds: () => call('sounds:list'),
    openSoundsFolder: () => call('sounds:openFolder'),
  };

  return {
    api,
    emit,
    call,
    autoBackup,
    exportZip,
    hasProject: () => !!currentDir,
    handlers,
    PATHS: { ROOT, PROJECTS, APP, COPIES },
  };
}

module.exports = { createBackend, safeFolderName };
