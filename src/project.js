'use strict';

// Всё, что связано с хранением проекта на диске.
// Проект = обычная папка:
//   project.json   порядок глав и названия
//   Главы/<id>.md  текст каждой главы (имя файла без номера и названия)
//   Корзина/       удалённые главы (на всякий случай)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomic, noteRead } = require('./fsutil');
const declension = require('./declension');
const { cleanSkip } = require('./editing');
const { guardWrite, assertNotPlaceholder } = require('./syncguard');

const META = 'project.json';
const CHAPTERS_DIR = 'Главы';
const TRASH_DIR = 'Корзина';
const SUBDIRS = [CHAPTERS_DIR, 'Персонажи', 'Места', 'Заметки', 'Изображения', TRASH_DIR];

// Предельные размеры текстов. Это защита от испорченных файлов, а не рабочие ограничения:
// всё, что автор мог ввести в поле, должно сохраняться целиком, поэтому пределы с большим запасом.
const SYNOPSIS_MAX = 200_000;
const NOTES_MAX = 500_000;
const FIELD_MAX = 500_000;
const SHORT_MAX = 50_000;

const ID_RE = /^[a-z0-9]{6,32}$/;
const ORPHAN_RE = /^([a-z0-9]{6,32})\.md$/;
const { t: tr } = require('./i18n'); // названия по умолчанию подставляются на языке интерфейса при создании
// Главы, которым автор не давал своего названия, называются «Глава N» и сами перенумеровываются по месту в списке.
// В режиме «Рассказы» то же самое, но «Рассказ N».
const AUTO_TITLE_RE = /^(Глава|Рассказ|Chapter|Story) \d+$/;
const { cleanMode } = require('./terms');
const unitTitle = (meta, n) => tr(meta.mode === 'stories' ? 'Рассказ {0}' : 'Глава {0}', n);
function renumber(meta) {
  meta.chapters.forEach((c, i) => {
    if (AUTO_TITLE_RE.test(c.title)) c.title = unitTitle(meta, i + 1);
  });
}

// Цветовые маркеры глав: красный = только написана, оранжевый = переписать, зелёный = готово.
const MARKERS = ['red', 'orange', 'green'];

// Карточки персонажей и мест (JSON) и заметки (Markdown). Названия и порядок лежат в project.json.
const KINDS = {
  character: { list: 'characters', dir: 'Персонажи', ext: 'json', title: 'Новый персонаж' },
  place: { list: 'places', dir: 'Места', ext: 'json', title: 'Новое место' },
  note: { list: 'notes', dir: 'Заметки', ext: 'md', title: 'Новая заметка' },
};

const DEFAULT_TEMPLATES = {
  character: [
    'Общее описание', 'Возраст', 'Рост и телосложение', 'Волосы', 'Глаза', 'Особые приметы',
    'Одежда', 'Характер', 'Привычки и манера речи', 'Прошлое', 'Цели и страхи', 'Связи с другими',
  ],
  place: [
    'Общее описание', 'Расположение', 'Климат', 'Атмосфера', 'Население',
    'Достопримечательности', 'История', 'Связанные персонажи',
  ],
};

// ---------- вспомогательные ----------

function metaPath(dir) {
  return path.join(dir, META);
}

function chapterFile(dir, id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    throw new Error('Неверный идентификатор главы.');
  }
  return path.join(dir, CHAPTERS_DIR, `${id}.md`);
}

function newId(taken) {
  for (;;) {
    const id = crypto.randomBytes(5).toString('hex');
    if (!taken.has(id)) return id;
  }
}

function cleanTitle(title) {
  return String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

// Поля, которых эта версия не знает (например, из более новой), переносим как есть: иначе первое же сохранение их сотрёт.
function carryUnknown(src, out, known) {
  for (const k of Object.keys(src)) {
    if (k !== '__proto__' && !known.has(k) && !Object.hasOwn(out, k)) out[k] = src[k];
  }
  return out;
}
const CHAPTER_KEYS = new Set(['id', 'title', 'goal', 'marker', 'synopsis', 'notes', 'comments']);

// Комментарии к фрагментам главы. Текст главы не меняется: привязка хранится как цитата с окружением.
const COMMENTS_MAX = 500;
function cleanComments(list) {
  if (!Array.isArray(list)) return [];
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  const out = [];
  for (const c of list.slice(0, COMMENTS_MAX)) {
    if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !/^[\w-]{1,40}$/.test(c.id)) continue;
    const e = {
      id: c.id,
      text: str(c.text, 5000),
      quote: str(c.quote, 2000),
      before: str(c.before, 60),
      after: str(c.after, 60),
      pos: Number.isFinite(c.pos) ? Math.max(0, Math.trunc(c.pos)) : 0,
      ts: str(c.ts, 40),
    };
    if (c.lost === true) e.lost = true;
    out.push(e);
  }
  return out;
}
const ITEM_KEYS = new Set(['id', 'title', 'icon']);
const TRASH_KEYS = new Set(['tid', 'kind', 'id', 'title', 'index', 'file', 'deleted', 'icon', 'goal', 'marker', 'synopsis', 'notes']);
// Служебные поля записи корзины: при возврате в список они не переносятся.
const TRASH_OWN = new Set(['tid', 'kind', 'id', 'title', 'index', 'file', 'deleted']);

function loadMeta(dir) {
  let raw;
  try {
    raw = fs.readFileSync(metaPath(dir), 'utf8');
    noteRead(metaPath(dir), raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      assertNotPlaceholder(metaPath(dir)); // файл мог быть выгружен из iCloud
      throw new Error('В этой папке нет проекта Кабинета (нет файла project.json).');
    }
    throw err;
  }
  let meta;
  try {
    meta = JSON.parse(raw);
  } catch {
    throw new Error(
      'Файл project.json повреждён. Программа его не изменяла. ' +
      'Рядом может лежать копия project.json.bak: её можно переименовать в project.json.'
    );
  }
  if (!meta || typeof meta !== 'object' || !Array.isArray(meta.chapters)) {
    throw new Error('Файл project.json имеет неожиданный вид. Программа его не изменяла.');
  }
  if (cleanMode(meta.mode) === 'stories') meta.mode = 'stories';
  else delete meta.mode; // роман: поле не пишем, старые проекты остаются как были
  meta.chapters = meta.chapters
    .filter((c) => c && typeof c.id === 'string' && ID_RE.test(c.id))
    .map((c) => {
      const chapter = { id: c.id, title: cleanTitle(c.title) || tr('Без названия') };
      const goal = cleanGoal(c.goal);
      if (goal) chapter.goal = goal; // цель по словам для этой главы
      if (MARKERS.includes(c.marker)) chapter.marker = c.marker;
      if (typeof c.synopsis === 'string' && c.synopsis) chapter.synopsis = c.synopsis.slice(0, SYNOPSIS_MAX);
      if (typeof c.notes === 'string' && c.notes) chapter.notes = c.notes.slice(0, NOTES_MAX);
      const comments = cleanComments(c.comments);
      if (comments.length) chapter.comments = comments;
      return carryUnknown(c, chapter, CHAPTER_KEYS);
    });
  for (const k of Object.values(KINDS)) {
    const src = Array.isArray(meta[k.list]) ? meta[k.list] : [];
    meta[k.list] = src
      .filter((c) => c && typeof c.id === 'string' && ID_RE.test(c.id))
      .map((c) => {
        const item = { id: c.id, title: cleanTitle(c.title) || tr('Без названия') };
        const icon = cleanIcon(c.icon);
        if (icon) item.icon = icon;
        return carryUnknown(c, item, ITEM_KEYS);
      });
  }
  meta.trash = (Array.isArray(meta.trash) ? meta.trash : [])
    .filter((e) => e && typeof e.tid === 'string' && typeof e.id === 'string' && ID_RE.test(e.id)
      && (e.kind === 'chapter' || Object.hasOwn(KINDS, e.kind)))
    .map((e) => {
      const out = {
        tid: e.tid.slice(0, 40),
        kind: e.kind,
        id: e.id,
        title: cleanTitle(e.title) || tr('Без названия'),
        index: Number.isFinite(Number(e.index)) ? Math.max(0, Math.trunc(Number(e.index))) : 0,
        file: path.basename(String(e.file || '')),
        deleted: typeof e.deleted === 'string' ? e.deleted : '',
      };
      const icon = cleanIcon(e.icon);
      if (icon) out.icon = icon;
      const goal = cleanGoal(e.goal);
      if (goal) out.goal = goal;
      if (MARKERS.includes(e.marker)) out.marker = e.marker;
      if (typeof e.synopsis === 'string' && e.synopsis) out.synopsis = e.synopsis.slice(0, SYNOPSIS_MAX);
      if (typeof e.notes === 'string' && e.notes) out.notes = e.notes.slice(0, NOTES_MAX);
      return carryUnknown(e, out, TRASH_KEYS);
    });
  const t = meta.templates && typeof meta.templates === 'object' ? meta.templates : {};
  meta.templates = {
    character: cleanTemplate(t.character) ?? DEFAULT_TEMPLATES.character.map((x) => tr(x)),
    place: cleanTemplate(t.place) ?? DEFAULT_TEMPLATES.place.map((x) => tr(x)),
  };
  const projectGoal = cleanGoal(meta.projectGoal);
  if (projectGoal) meta.projectGoal = projectGoal;
  else delete meta.projectGoal;
  const analysisSkip = cleanSkip(meta.analysisSkip);
  if (Object.keys(analysisSkip).length) meta.analysisSkip = analysisSkip;
  else delete meta.analysisSkip;
  const deadline = cleanDeadline(meta.deadline);
  if (deadline) meta.deadline = deadline;
  else delete meta.deadline;
  const defaultGoal = cleanGoal(meta.defaultGoal);
  if (defaultGoal) meta.defaultGoal = defaultGoal;
  else delete meta.defaultGoal;
  // Для рассказов: в чём считать цели и лимит знаков на один рассказ (знаков с пробелами).
  // В романе поля не используются, но и не стираются: при возврате в режим «Рассказы» всё на месте.
  if (meta.goalUnit !== 'words' && meta.goalUnit !== 'chars') delete meta.goalUnit;
  const charLimit = cleanGoal(meta.charLimit);
  if (charLimit) meta.charLimit = charLimit;
  else delete meta.charLimit;
  return meta;
}

/** Цель по словам: целое число от 1 до 1 000 000, иначе «цели нет» (null). */
/** Срок сдачи: дата ГГГГ-ММ-ДД или null. */
function cleanDeadline(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value ? value : null;
}

function cleanGoal(value) {
  const n = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(n)) return null;
  const g = Math.round(n);
  return g >= 1 && g <= 1_000_000 ? g : null;
}

/** Иконка строки списка: короткая строка (обычно один эмодзи). */
function cleanIcon(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return v && v.length <= 16 ? v : null;
}

/** Шаблон карточки: список названий полей. null, если пришло не то, что нужно. */
function cleanTemplate(value) {
  if (!Array.isArray(value)) return null;
  const names = [];
  for (const raw of value) {
    const n = cleanTitle(raw).slice(0, 100);
    if (n && !names.includes(n)) names.push(n);
  }
  return names.slice(0, 60);
}

function saveMeta(dir, meta) {
  const p = metaPath(dir);
  if (fs.existsSync(p)) {
    try { fs.copyFileSync(p, `${p}.bak`); } catch { /* копия не критична */ }
  }
  writeFileAtomic(p, JSON.stringify(meta, null, 2));
}

function view(dir, meta) {
  return {
    name: meta.name || path.basename(dir),
    defaultGoal: meta.defaultGoal ?? null,
    projectGoal: meta.projectGoal ?? null,
    analysisSkip: meta.analysisSkip ?? {},
    deadline: meta.deadline ?? null,
    mode: meta.mode === 'stories' ? 'stories' : 'novel',
    goalUnit: meta.mode === 'stories' ? (meta.goalUnit || 'chars') : 'words',
    charLimit: meta.mode === 'stories' ? (meta.charLimit ?? null) : null,
    chapters: meta.chapters.map((c) => ({
      id: c.id, title: c.title, goal: c.goal ?? null, marker: c.marker ?? null,
    })),
    characters: meta.characters.map((c) => ({ id: c.id, title: c.title, icon: c.icon ?? null })),
    places: meta.places.map((c) => ({ id: c.id, title: c.title, icon: c.icon ?? null })),
    notes: meta.notes.map((c) => ({ id: c.id, title: c.title, icon: c.icon ?? null })),
    templates: { character: [...meta.templates.character], place: [...meta.templates.place] },
    trash: meta.trash.slice().reverse().map((e) => ({
      tid: e.tid, kind: e.kind, id: e.id, title: e.title, icon: e.icon ?? null, deleted: e.deleted,
    })),
  };
}

function findIndex(meta, id) {
  const i = meta.chapters.findIndex((c) => c.id === id);
  if (i < 0) throw new Error('Глава не найдена в проекте.');
  return i;
}

function stamp() {
  return new Date().toISOString().replace('T', '_').replace(/\..+$/, '').replace(/:/g, '-');
}

// ---------- проект ----------

function createProject(dir, name, { mode } = {}) {
  if (fs.existsSync(metaPath(dir))) {
    throw new Error('В этой папке уже есть проект.');
  }
  fs.mkdirSync(dir, { recursive: true });
  for (const d of SUBDIRS) fs.mkdirSync(path.join(dir, d), { recursive: true });
  const id = newId(new Set());
  writeFileAtomic(chapterFile(dir, id), '');
  const meta = {
    app: 'kabinet',
    version: 1,
    name: cleanTitle(name) || path.basename(dir),
    ...(mode === 'stories' ? { mode: 'stories' } : {}),
    chapters: [{ id, title: tr(mode === 'stories' ? 'Рассказ {0}' : 'Глава {0}', 1) }],
    characters: [],
    places: [],
    notes: [],
    templates: {
      character: DEFAULT_TEMPLATES.character.map((x) => tr(x)),
      place: DEFAULT_TEMPLATES.place.map((x) => tr(x)),
    },
  };
  saveMeta(dir, meta);
  return view(dir, loadMeta(dir));
}

/**
 * Открывает проект. Если в папке «Главы» есть файлы, которых нет в project.json
 * (например, при сбое), они добавляются в конец списка, чтобы текст не потерялся.
 */
function openProject(dir) {
  const meta = loadMeta(dir);
  for (const d of SUBDIRS) fs.mkdirSync(path.join(dir, d), { recursive: true });

  const known = new Set(meta.chapters.map((c) => c.id));
  let files = [];
  try {
    files = fs.readdirSync(path.join(dir, CHAPTERS_DIR));
  } catch { /* папки нет — нечего искать */ }

  let changed = false;
  for (const f of files.sort()) {
    const m = ORPHAN_RE.exec(f);
    if (m && !known.has(m[1])) {
      meta.chapters.push({ id: m[1], title: tr('Найденная глава ({0})', m[1].slice(0, 4)) });
      known.add(m[1]);
      changed = true;
    }
  }
  if (changed) saveMeta(dir, meta);
  return view(dir, meta);
}

// ---------- главы ----------

function addChapter(dir, afterId) {
  const meta = loadMeta(dir);
  const taken = new Set(meta.chapters.map((c) => c.id));
  const id = newId(taken);
  // Сначала файл, потом запись в project.json: ссылка никогда не ведёт в пустоту.
  writeFileAtomic(chapterFile(dir, id), '');
  let at = meta.chapters.length;
  if (afterId) {
    const i = meta.chapters.findIndex((c) => c.id === afterId);
    if (i >= 0) at = i + 1;
  }
  meta.chapters.splice(at, 0, { id, title: unitTitle(meta, at + 1) });
  renumber(meta);
  saveMeta(dir, meta);
  return { project: view(dir, meta), id };
}

function renameChapter(dir, id, title) {
  const meta = loadMeta(dir);
  const i = findIndex(meta, id);
  const t = cleanTitle(title);
  if (t) meta.chapters[i].title = t;
  saveMeta(dir, meta);
  return view(dir, meta);
}

/**
 * Импорт: добавляет в конец проекта главы [{ title, text }] (текст в Markdown). Возвращает проект и номера новых глав.
 * Каждая глава создаётся обычным путём (файл, потом запись в project.json), поэтому обрыв посередине оставляет проект целым.
 */
function importChapters(dir, items) {
  if (!Array.isArray(items) || !items.length) throw new Error('Нечего импортировать.');
  if (items.length > 500) throw new Error('За один раз можно импортировать не больше 500 глав.');
  const ids = [];
  // В новом проекте есть одна пустая глава с названием по умолчанию: первый импортированный текст занимает её место.
  const meta0 = loadMeta(dir);
  const only = meta0.chapters.length === 1 ? meta0.chapters[0] : null;
  const reuse = only && AUTO_TITLE_RE.test(only.title) && !readChapter(dir, only.id).trim() ? only.id : null;
  items.forEach((it, k) => {
    const id = k === 0 && reuse ? reuse : addChapter(dir).id;
    if (it.title) renameChapter(dir, id, it.title);
    if (it.text) writeChapter(dir, id, String(it.text));
    ids.push(id);
  });
  const meta = loadMeta(dir);
  renumber(meta); // названия «Глава N» в программе всегда идут по порядку: приводим их к нему сразу
  saveMeta(dir, meta);
  return { project: view(dir, meta), ids };
}

/** Цель главы по словам. goal = null или пустое значение убирает цель. */
function setChapterGoal(dir, id, goal) {
  const meta = loadMeta(dir);
  const i = findIndex(meta, id);
  const g = cleanGoal(goal);
  if (g) meta.chapters[i].goal = g;
  else delete meta.chapters[i].goal;
  saveMeta(dir, meta);
  return view(dir, meta);
}

/** Цель для всех глав, у которых нет своей. */
function setDefaultGoal(dir, goal) {
  const meta = loadMeta(dir);
  const g = cleanGoal(goal);
  if (g) meta.defaultGoal = g;
  else delete meta.defaultGoal;
  saveMeta(dir, meta);
  return view(dir, meta);
}

/** Единица цели в режиме «Рассказы»: 'chars' (знаки с пробелами, по умолчанию) или 'words'. */
function setGoalUnit(dir, unit) {
  const meta = loadMeta(dir);
  if (meta.mode === 'stories') meta.goalUnit = unit === 'words' ? 'words' : 'chars';
  saveMeta(dir, meta);
  return view(dir, meta);
}

/** Лимит знаков с пробелами на один рассказ (конкурсы): число или пусто. Только в режиме «Рассказы». */
function setCharLimit(dir, limit) {
  const meta = loadMeta(dir);
  if (meta.mode === 'stories') {
    const g = cleanGoal(limit);
    if (g) meta.charLimit = g;
    else delete meta.charLimit;
    saveMeta(dir, meta);
  }
  return view(dir, meta);
}

/** Цель по словам для всего проекта (считаются только главы). */
function setProjectGoal(dir, goal) {
  const meta = loadMeta(dir);
  const g = cleanGoal(goal);
  if (g) meta.projectGoal = g;
  else delete meta.projectGoal;
  saveMeta(dir, meta);
  return view(dir, meta);
}

/** Исключения подсветки «Не отмечать здесь»: { adv: [...], passive: [...], long: [...], repeat: [...], filler: [...] }. */
function setAnalysisSkip(dir, raw) {
  const meta = loadMeta(dir);
  const skip = cleanSkip(raw);
  if (Object.keys(skip).length) meta.analysisSkip = skip;
  else delete meta.analysisSkip;
  saveMeta(dir, meta);
  return view(dir, meta);
}

/** Режим проекта: 'novel' (главы) или 'stories' (рассказы). Тексты и файлы не меняются. */
function setProjectMode(dir, mode) {
  const meta = loadMeta(dir);
  if (cleanMode(mode) === 'stories') meta.mode = 'stories';
  else delete meta.mode;
  renumber(meta); // «Глава 3» ↔ «Рассказ 3»: только названия, которые автор не менял
  saveMeta(dir, meta);
  return view(dir, meta);
}

function setProjectDeadline(dir, date) {
  const meta = loadMeta(dir);
  const d = cleanDeadline(date);
  if (d) meta.deadline = d;
  else delete meta.deadline;
  saveMeta(dir, meta);
  return view(dir, meta);
}

/** Данные для доски со стикерами: порядок глав, отметка, синопсис, слова. */
function boardData(dir) {
  const meta = loadMeta(dir);
  const st = projectStats(dir);
  const words = new Map(st.chapters.map((c) => [c.id, c.words]));
  return meta.chapters.map((c) => ({
    id: c.id,
    title: c.title,
    marker: c.marker ?? null,
    synopsis: c.synopsis || '',
    words: words.get(c.id) || 0,
  }));
}

/** Цветовой маркер главы: 'red' | 'orange' | 'green' | null (нет маркера). */
function setChapterMarker(dir, id, marker) {
  const meta = loadMeta(dir);
  const i = findIndex(meta, id);
  if (MARKERS.includes(marker)) meta.chapters[i].marker = marker;
  else delete meta.chapters[i].marker;
  saveMeta(dir, meta);
  return view(dir, meta);
}

// ---------- карточки персонажей, места и заметки ----------

function kindOf(kind) {
  if (typeof kind !== 'string' || !Object.hasOwn(KINDS, kind)) throw new Error('Неизвестный вид записи.');
  return KINDS[kind];
}

function itemFile(dir, kind, id) {
  const k = kindOf(kind);
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('Неверный идентификатор.');
  return path.join(dir, k.dir, `${id}.${k.ext}`);
}

function itemIndex(meta, kind, id) {
  const i = meta[kindOf(kind).list].findIndex((c) => c.id === id);
  if (i < 0) throw new Error('Запись не найдена в проекте.');
  return i;
}

/** Приводит карточку к безопасному виду: ограничивает размеры, отбрасывает лишнее. */
const IMAGE_DIR = 'Картинки';
const IMAGE_RE = /^[a-z0-9]{6,32}\.(png|jpe?g|webp|gif)$/;
const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function sanitizeCard(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Неверный формат карточки.');
  const str = (v, max) => String(v ?? '').slice(0, max);
  const fields = Array.isArray(raw.fields)
    ? raw.fields.slice(0, 80).map((f) => ({
      name: str(f && f.name, 100).trim() || tr('Поле'),
      value: str(f && f.value, FIELD_MAX),
    }))
    : [];
  const aliases = Array.isArray(raw.aliases)
    ? [...new Set(raw.aliases.map((a) => str(a, 80).trim()).filter(Boolean))].slice(0, 100)
    : [];
  const ignore = Array.isArray(raw.ignore)
    ? [...new Set(raw.ignore.map((a) => str(a, 80).trim()).filter(Boolean))].slice(0, 100)
    : [];
  const image = typeof raw.image === 'string' && IMAGE_RE.test(raw.image) ? raw.image : '';
  const card = { short: str(raw.short, SHORT_MAX), aliases, ignore, image, fields, protagonist: raw.protagonist === true };
  if (raw.inflect === false) card.inflect = false; // по умолчанию имя склоняется автоматически, в файле хранится только отказ
  return card;
}

function emptyCardFor(meta, kind) {
  return sanitizeCard({
    short: '',
    aliases: [],
    fields: (meta.templates[kind] || []).map((name) => ({ name, value: '' })),
  });
}

function addItem(dir, kind, afterId) {
  const k = kindOf(kind);
  const meta = loadMeta(dir);
  const list = meta[k.list];
  const id = newId(new Set(list.map((c) => c.id)));
  const content = k.ext === 'json' ? JSON.stringify(emptyCardFor(meta, kind), null, 2) : '';
  writeFileAtomic(itemFile(dir, kind, id), content);
  let at = list.length;
  if (afterId) {
    const i = list.findIndex((c) => c.id === afterId);
    if (i >= 0) at = i + 1;
  }
  list.splice(at, 0, { id, title: tr(k.title) });
  saveMeta(dir, meta);
  return { project: view(dir, meta), id };
}

function renameItem(dir, kind, id, title) {
  const meta = loadMeta(dir);
  const i = itemIndex(meta, kind, id);
  const t = cleanTitle(title);
  if (t) meta[kindOf(kind).list][i].title = t;
  saveMeta(dir, meta);
  return view(dir, meta);
}

function moveItem(dir, kind, id, newIndex) {
  const meta = loadMeta(dir);
  const list = meta[kindOf(kind).list];
  const from = itemIndex(meta, kind, id);
  const [item] = list.splice(from, 1);
  const to = Math.max(0, Math.min(list.length, Math.trunc(Number(newIndex)) || 0));
  list.splice(to, 0, item);
  saveMeta(dir, meta);
  return view(dir, meta);
}

/** Иконка строки. null или пустая строка возвращает значок по умолчанию. */
function setItemIcon(dir, kind, id, icon) {
  const meta = loadMeta(dir);
  const i = itemIndex(meta, kind, id);
  const clean = cleanIcon(icon);
  const item = meta[kindOf(kind).list][i];
  if (clean) item.icon = clean;
  else delete item.icon;
  saveMeta(dir, meta);
  return view(dir, meta);
}

/** Удаление = перенос файла в «Корзину» внутри проекта. */
function deleteItem(dir, kind, id) {
  const k = kindOf(kind);
  const meta = loadMeta(dir);
  const i = itemIndex(meta, kind, id);
  const [removed] = meta[k.list].splice(i, 1);
  const file = moveToTrash(dir, itemFile(dir, kind, id), removed.title, id, k.ext);
  pushTrash(meta, kind, removed, i, file);
  saveMeta(dir, meta);
  return view(dir, meta);
}

function itemTitle(dir, kind, id) {
  const meta = loadMeta(dir);
  return meta[kindOf(kind).list][itemIndex(meta, kind, id)].title;
}

// track: false для массовых чтений (статистика, поиск, карточки, замена, экспорт): они не должны
// обновлять «известный» хэш файла, иначе защита от затирания (guardWrite) не заметит чужую правку.
function readItem(dir, kind, id, { track = true } = {}) {
  const k = kindOf(kind);
  const file = itemFile(dir, kind, id);
  try {
    const text = fs.readFileSync(file, 'utf8');
    if (track) noteRead(file, text);
    return text;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    assertNotPlaceholder(file);
    return k.ext === 'json' ? JSON.stringify(sanitizeCard({}), null, 2) : '';
  }
}

function writeItem(dir, kind, id, text) {
  const k = kindOf(kind);
  if (typeof text !== 'string') throw new Error('Содержимое должно быть строкой.');
  const meta = loadMeta(dir);
  const title = meta[k.list][itemIndex(meta, kind, id)].title;
  let out = text;
  if (k.ext === 'json') {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('Карточка имеет неверный формат.');
    }
    out = JSON.stringify(sanitizeCard(parsed), null, 2);
  }
  const file = itemFile(dir, kind, id);
  const conflict = guardWrite(dir, file, out, title);
  writeFileAtomic(file, out);
  return { conflict };
}

/** Шаблон новых карточек: kind = 'character' | 'place', names = список названий полей. */
function setTemplate(dir, kind, names) {
  if (kind !== 'character' && kind !== 'place') throw new Error('Неизвестный шаблон.');
  const meta = loadMeta(dir);
  const clean = cleanTemplate(names);
  if (!clean) throw new Error('Шаблон должен быть списком названий полей.');
  meta.templates[kind] = clean;
  saveMeta(dir, meta);
  return view(dir, meta);
}

function moveChapter(dir, id, newIndex) {
  const meta = loadMeta(dir);
  const from = findIndex(meta, id);
  const [item] = meta.chapters.splice(from, 1);
  const to = Math.max(0, Math.min(meta.chapters.length, Math.trunc(Number(newIndex)) || 0));
  meta.chapters.splice(to, 0, item);
  renumber(meta);
  saveMeta(dir, meta);
  return view(dir, meta);
}

/** Удаление = перенос файла в «Корзину» внутри проекта. Ничего не стирается. */
function deleteChapter(dir, id) {
  const meta = loadMeta(dir);
  const i = findIndex(meta, id);
  const [removed] = meta.chapters.splice(i, 1);
  const file = moveToTrash(dir, chapterFile(dir, id), removed.title, id, 'md');
  pushTrash(meta, 'chapter', removed, i, file);
  renumber(meta);
  saveMeta(dir, meta);
  return view(dir, meta);
}

/** Файл уходит в «Корзину» внутри проекта; возвращает его имя там ('' если файла не было). */
function moveToTrash(dir, src, title, id, ext) {
  if (!fs.existsSync(src)) return '';
  const safe = title.replace(/[\\/:*?"<>|]/g, '-').slice(0, 60);
  const name = `${safe} (${id}) ${stamp()}.${ext}`;
  fs.mkdirSync(path.join(dir, TRASH_DIR), { recursive: true });
  fs.renameSync(src, path.join(dir, TRASH_DIR, name));
  return name;
}

/** Запись о удалённом: чтобы вернуть главу или карточку со всеми отметками. */
function pushTrash(meta, kind, removed, index, file) {
  const taken = new Set(meta.trash.map((e) => e.tid));
  const entry = { tid: newId(taken), kind, id: removed.id, title: removed.title, index, file, deleted: new Date().toISOString() };
  for (const k of Object.keys(removed)) if (k !== '__proto__' && !TRASH_OWN.has(k) && removed[k] !== undefined) entry[k] = removed[k];
  meta.trash.push(entry);
}

function trashEntry(meta, tid) {
  const i = meta.trash.findIndex((e) => e.tid === tid);
  if (i < 0) throw new Error('Записи нет в корзине.');
  return i;
}

/** Возвращает главу или карточку из корзины на прежнее место. */
function restoreTrash(dir, tid) {
  const meta = loadMeta(dir);
  const i = trashEntry(meta, tid);
  const e = meta.trash[i];
  const isChapter = e.kind === 'chapter';
  const list = isChapter ? meta.chapters : meta[KINDS[e.kind].list];
  if (list.some((c) => c.id === e.id)) throw new Error('Такая запись уже есть в проекте.');
  const dest = isChapter ? chapterFile(dir, e.id) : itemFile(dir, e.kind, e.id);
  const src = e.file ? path.join(dir, TRASH_DIR, e.file) : '';
  if (src && fs.existsSync(src)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(src, dest);
  } else if (!fs.existsSync(dest)) {
    // Файл был в Корзине, но пропал (например, после восстановления проекта из копии: копии «Корзину» не содержат).
    // Пустую запись под видом восстановленной не создаём; если файла не было и при удалении, возвращаем пустую.
    if (e.file) throw new Error('Файл этой записи пропал из Корзины, вернуть её нельзя. Запись можно удалить из корзины насовсем.');
    writeFileAtomic(dest, isChapter || KINDS[e.kind].ext === 'md' ? '' : JSON.stringify(sanitizeCard({}), null, 2));
  }
  const item = { id: e.id, title: e.title };
  for (const k of Object.keys(e)) if (k !== '__proto__' && !TRASH_OWN.has(k) && e[k] !== undefined) item[k] = e[k];
  list.splice(Math.min(e.index, list.length), 0, item);
  meta.trash.splice(i, 1);
  if (isChapter) renumber(meta);
  saveMeta(dir, meta);
  return { project: view(dir, meta), kind: e.kind, id: e.id };
}

function removeTrashFile(dir, e) {
  if (!e.file) return;
  try { fs.unlinkSync(path.join(dir, TRASH_DIR, e.file)); } catch (err) { if (err.code !== 'ENOENT') throw err; }
}

/** Окончательное удаление одной записи из корзины. */
function purgeTrash(dir, tid) {
  const meta = loadMeta(dir);
  const i = trashEntry(meta, tid);
  removeTrashFile(dir, meta.trash[i]);
  meta.trash.splice(i, 1);
  saveMeta(dir, meta);
  return view(dir, meta);
}

function emptyTrash(dir) {
  const meta = loadMeta(dir);
  for (const e of meta.trash) removeTrashFile(dir, e);
  meta.trash = [];
  saveMeta(dir, meta);
  return view(dir, meta);
}

function trashTitle(dir, tid) {
  const meta = loadMeta(dir);
  return meta.trash[trashEntry(meta, tid)].title;
}

function readChapter(dir, id, { track = true } = {}) {
  const file = chapterFile(dir, id);
  try {
    const text = fs.readFileSync(file, 'utf8');
    if (track) noteRead(file, text);
    return text;
  } catch (err) {
    if (err.code === 'ENOENT') {
      assertNotPlaceholder(file); // выгруженный из iCloud файл нельзя принимать за пустую главу
      return '';
    }
    throw err;
  }
}

function writeChapter(dir, id, text) {
  if (typeof text !== 'string') throw new Error('Текст главы должен быть строкой.');
  const meta = loadMeta(dir);
  const title = meta.chapters[findIndex(meta, id)].title; // пишем только в главы, которые есть в проекте
  const file = chapterFile(dir, id);
  const conflict = guardWrite(dir, file, text, title); // файл изменили снаружи: чужую версию сохраняем отдельно
  writeFileAtomic(file, text);
  return { conflict };
}

function chapterTitle(dir, id) {
  const meta = loadMeta(dir);
  return meta.chapters[findIndex(meta, id)].title;
}

/** Копирует картинку в папку проекта «Картинки», возвращает новое имя файла. */
function addImage(dir, srcPath) {
  const ext = path.extname(String(srcPath)).slice(1).toLowerCase();
  if (!IMAGE_MIME[ext]) throw new Error('Поддерживаются картинки png, jpg, webp и gif.');
  const size = fs.statSync(srcPath).size;
  if (size > MAX_IMAGE_BYTES) throw new Error('Картинка слишком большая (больше 10 МБ).');
  const folder = path.join(dir, IMAGE_DIR);
  fs.mkdirSync(folder, { recursive: true });
  const taken = new Set(fs.readdirSync(folder).map((f) => path.parse(f).name));
  const file = `${newId(taken)}.${ext === 'jpeg' ? 'jpg' : ext}`;
  const target = path.join(folder, file);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, fs.readFileSync(srcPath));
  fs.renameSync(tmp, target);
  return file;
}

/** Картинка как data: адрес (окну разрешено показывать только свои файлы и data:). */
function readImage(dir, file) {
  if (typeof file !== 'string' || !IMAGE_RE.test(file)) throw new Error('Неверное имя картинки.');
  const ext = path.extname(file).slice(1);
  const buf = fs.readFileSync(path.join(dir, IMAGE_DIR, file));
  return `data:${IMAGE_MIME[ext]};base64,${buf.toString('base64')}`;
}

/**
 * Сводка по всем карточкам для автоссылок и всплывающих подсказок:
 * [{ kind, id, title, icon, short, aliases, ignore, image }]
 * Если краткой справки нет, берётся поле «Общее описание».
 */
function cardIndex(dir) {
  const meta = loadMeta(dir);
  const out = [];
  for (const kind of ['character', 'place']) {
    for (const item of meta[kindOf(kind).list]) {
      let card;
      try {
        card = sanitizeCard(JSON.parse(readItem(dir, kind, item.id, { track: false })));
      } catch {
        card = sanitizeCard({});
      }
      let short = card.short.trim();
      if (!short) {
        const f = card.fields.find((x) => ['общее описание', 'general description'].includes(x.name.trim().toLowerCase()) && x.value.trim());
        if (f) short = f.value.trim();
      }
      const inflect = card.inflect !== false;
      out.push({
        kind,
        id: item.id,
        title: item.title,
        icon: item.icon || '',
        short: short.slice(0, 400),
        aliases: card.aliases,
        ignore: card.ignore,
        image: card.image,
        protagonist: card.protagonist,
        inflect,
        forms: inflect ? declension.nameForms(item.title, card.aliases, { kind }) : [], // падежные формы названия и имён
      });
    }
  }
  return out;
}

/** Синопсис и заметки к главе (лежат в project.json рядом с названием). */
function readChapterMeta(dir, id) {
  const meta = loadMeta(dir);
  const c = meta.chapters[findIndex(meta, id)];
  const out = { synopsis: c.synopsis || '', notes: c.notes || '' };
  if (c.comments) out.comments = c.comments; // поле есть только у глав с комментариями
  return out;
}

function writeChapterMeta(dir, id, data) {
  if (!data || typeof data !== 'object') throw new Error('Неверные данные главы.');
  const meta = loadMeta(dir);
  const c = meta.chapters[findIndex(meta, id)];
  if ('synopsis' in data || 'notes' in data || !Array.isArray(data.comments)) { // запись одних комментариев синопсис и заметки не трогает
    const synopsis = String(data.synopsis ?? '').slice(0, SYNOPSIS_MAX);
    const notes = String(data.notes ?? '').slice(0, NOTES_MAX);
    if (synopsis) c.synopsis = synopsis; else delete c.synopsis;
    if (notes) c.notes = notes; else delete c.notes;
  }
  if (Array.isArray(data.comments)) { // поле необязательно: запись синопсиса комментарии не трогает
    const comments = cleanComments(data.comments);
    if (comments.length) c.comments = comments; else delete c.comments;
  }
  saveMeta(dir, meta);
  return true;
}

const WORD_RE = /[\p{L}\p{N}]+(?:[-–’'][\p{L}\p{N}]+)*/gu;

/** Слова во всём проекте: { total, chapters: [{ id, words }] }. */
/** Знаки с пробелами в тексте главы (Markdown без разметки и без переводов строк, как считает окно). */
function charCount(md) {
  return String(md)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((l) => !/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(l)) // разделитель сцен
    .map((l) => l.replace(/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, ''))
    .join('')
    .replace(/\\([*_#>\-\\])/g, '$1')
    .replace(/(\*\*|\*|__|_)/g, '')
    .length;
}

function projectStats(dir) {
  const meta = loadMeta(dir);
  const chapters = meta.chapters.map((c) => {
    const text = readChapter(dir, c.id, { track: false });
    return { id: c.id, words: (text.match(WORD_RE) || []).length, chars: charCount(text) };
  });
  return {
    total: chapters.reduce((a, c) => a + c.words, 0),
    totalChars: chapters.reduce((a, c) => a + c.chars, 0),
    chapters,
  };
}

module.exports = {
  importChapters,
  setAnalysisSkip,
  restoreTrash,
  purgeTrash,
  emptyTrash,
  trashTitle,
  setProjectGoal,
  setProjectDeadline,
  setProjectMode,
  setGoalUnit,
  setCharLimit,
  charCount,
  boardData,
  readChapterMeta,
  writeChapterMeta,
  projectStats,
  addImage,
  readImage,
  cardIndex,
  META,
  createProject,
  openProject,
  addChapter,
  renameChapter,
  moveChapter,
  setChapterGoal,
  setDefaultGoal,
  setChapterMarker,
  addItem,
  renameItem,
  moveItem,
  setItemIcon,
  deleteItem,
  itemTitle,
  readItem,
  writeItem,
  setTemplate,
  deleteChapter,
  readChapter,
  writeChapter,
  chapterTitle,
};
