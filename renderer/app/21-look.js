// ---------- оформление и режим «печатная машинка» ----------

const DEFAULT_SETTINGS = {
  an: {},          // какие виды слов подсвечены (анализ текста)
  anLongMin: 30,   // с скольких слов предложение считается длинным
  typo: true,
  typeAnim: true,   // плавное появление набираемых букв
  typoNbsp: false,  // неразрывные пробелы: по умолчанию выключены (Word и онлайн-публикации)
  spellOn: true,
  typewriter: false,
  links: true,
  theme: 'system',
  paper: 'none',
  font: 'iowan',
  size: 20,
  line: 1.7,
  width: 720,
  para: 'space',
  grain: 35,        // 0..100
  fontName: '',     // имя шрифта, установленного в системе (необязательно)
  soundOn: true,
  volume: 50,       // 0..100
  goalChime: true,  // динь при достижении цели по словам
  soundProfile: 'typewriter', // typewriter | soft | mech | pen
  fillers: [],      // список слов-паразитов (заполняется стандартным при первом запуске)
  anShow: {},       // дополнительные виды подсветки, вынесенные в список (глаголы, существительные…)
  tenseMode: 'auto', // основное время текста: auto (определять) | present (всегда настоящее)
  anRepeatWin: 25,  // повтор слова ближе, чем через столько слов
  keySrc: {},       // клавиша (key | space | backspace | enter) -> default | * | имя загруженного файла
  ambientSrc: {},   // вариант эмбиента -> default | имя загруженного файла
  ambientOn: false,
  ambient: 'rain',  // rain | fire | wind | sea | hum
  ambientVol: 40,   // 0..100
  projectGoalOn: true, // счётчик цели проекта в нижней панели
  fillerSkipSpeech: true, // слова-паразиты не отмечаются в репликах героев
  storyCharacters: false, // режим «Рассказы»: показывать раздел «Персонажи»
  storyPlaces: false,     // режим «Рассказы»: показывать раздел «Места»
};

// Допустимые значения для чисел, которые можно вписать вручную (шире, чем у ползунков).
const LIMITS = {
  size: { min: 8, max: 72, decimals: 0, step: 1 },
  line: { min: 1, max: 3, decimals: 2, step: 0.05 },
  width: { min: 300, max: 1600, decimals: 0, step: 20 },
  grain: { min: 0, max: 100, decimals: 0, step: 1 },
  volume: { min: 0, max: 100, decimals: 0, step: 1 },
  ambientVol: { min: 0, max: 100, decimals: 0, step: 1 },
};

const FONTS = {
  iowan: '"Iowan Old Style", "Palatino", "Palatino Linotype", Cambria, Georgia, serif',
  palatino: '"Palatino", "Palatino Linotype", Georgia, serif',
  georgia: 'Georgia, "Times New Roman", serif',
  times: '"Times New Roman", Times, serif',
  typewriter: '"American Typewriter", "Courier New", monospace',
  courier: '"Courier New", Courier, monospace',
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", sans-serif',
};

let settings = { ...DEFAULT_SETTINGS };
let followCaret = false; // true, пока пользователь печатает или двигает курсор клавишами
let twTarget = 0;
let twRaf = 0;
let lastTheme = null;
const customFonts = new Map(); // ключ 'custom:<файл>' -> имя семейства

function clampNum(v, min, max, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function loadSettings() {
  const s = { ...DEFAULT_SETTINGS, keySrc: {}, ambientSrc: {}, fillers: cleanFillerList(DEFAULT_FILLERS[LANG] || DEFAULT_FILLERS.ru) };
  try {
    const raw = JSON.parse(localStorage.getItem('kabinet.settings') || '{}');
    if (typeof raw.typewriter === 'boolean') s.typewriter = raw.typewriter;
    if (typeof raw.links === 'boolean') s.links = raw.links;
    if (raw.an && typeof raw.an === 'object') s.an = Object.fromEntries(AN_CATS.filter((k) => raw.an[k] === true).map((k) => [k, true]));
    s.anLongMin = clampNum(raw.anLongMin, 10, 200, 30);
    s.anRepeatWin = clampNum(raw.anRepeatWin, 5, 200, 25);
    if (raw.tenseMode === 'present' || raw.tenseMode === 'past') s.tenseMode = raw.tenseMode;
    if (raw.anShow && typeof raw.anShow === 'object') s.anShow = Object.fromEntries(['verb', 'noun', 'adj', 'part', 'pron'].filter((k) => raw.anShow[k] === true).map((k) => [k, true]));
    if (Array.isArray(raw.fillers)) s.fillers = cleanFillerList(raw.fillers);
    if (typeof raw.spellOn === 'boolean') s.spellOn = raw.spellOn;
    if (typeof raw.typo === 'boolean') s.typo = raw.typo;
    if (typeof raw.typeAnim === 'boolean') s.typeAnim = raw.typeAnim;
    if (typeof raw.typoNbsp === 'boolean') s.typoNbsp = raw.typoNbsp;
    if (raw.typoWeb !== true) s.typoNbsp = false; // один раз при обновлении неразрывные пробелы выключаются, дальше выбор за автором
    if (['system', 'light', 'dark'].includes(raw.theme)) s.theme = raw.theme;
    if (['none', 'grain', 'warm'].includes(raw.paper)) s.paper = raw.paper;
    if (typeof raw.font === 'string' && (Object.hasOwn(FONTS, raw.font) || raw.font.startsWith('custom:'))) {
      s.font = raw.font;
    }
    for (const key of Object.keys(LIMITS)) {
      s[key] = clampNum(raw[key], LIMITS[key].min, LIMITS[key].max, s[key]);
    }
    if (typeof raw.fontName === 'string') s.fontName = cleanFontName(raw.fontName);
    if (typeof raw.soundOn === 'boolean') s.soundOn = raw.soundOn;
    if (['typewriter', 'soft', 'mech', 'pen'].includes(raw.soundProfile)) s.soundProfile = raw.soundProfile;
    for (const [field, names] of [['keySrc', ['key', 'space', 'backspace', 'enter']], ['ambientSrc', Object.keys(AMBIENTS)]]) {
      if (!raw[field] || typeof raw[field] !== 'object') continue;
      for (const k of names) if (typeof raw[field][k] === 'string' && raw[field][k].length <= 200) s[field][k] = raw[field][k];
    }
    if (typeof raw.ambientOn === 'boolean') s.ambientOn = raw.ambientOn;
    if (typeof raw.projectGoalOn === 'boolean') s.projectGoalOn = raw.projectGoalOn;
    if (typeof raw.storyCharacters === 'boolean') s.storyCharacters = raw.storyCharacters;
    if (typeof raw.fillerSkipSpeech === 'boolean') s.fillerSkipSpeech = raw.fillerSkipSpeech;
    if (typeof raw.storyPlaces === 'boolean') s.storyPlaces = raw.storyPlaces;
    if (typeof raw.ambient === 'string' && Object.hasOwn(AMBIENTS, raw.ambient)) s.ambient = raw.ambient;
    if (typeof raw.goalChime === 'boolean') s.goalChime = raw.goalChime;
    if (['space', 'indent'].includes(raw.para)) s.para = raw.para;
  } catch { /* повреждённые настройки: берём стандартные */ }
  return s;
}

function saveSettings() {
  settings.typoWeb = true; // отметка: выключение неразрывных пробелов при обновлении уже сделано
  try { localStorage.setItem('kabinet.settings', JSON.stringify(settings)); } catch { /* ignore */ }
}

// Имя шрифта попадает в CSS, поэтому убираем всё, что могло бы его сломать.
function cleanFontName(name) {
  return String(name).replace(/["'\\;{}<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

// Полная цепочка шрифтов для текста: имя из системы > выбранный из списка > запасные.
function fontStack() {
  let base = FONTS.iowan;
  if (Object.hasOwn(FONTS, settings.font)) {
    base = FONTS[settings.font];
  } else if (customFonts.has(settings.font)) {
    base = `"${customFonts.get(settings.font)}", Georgia, serif`;
  }
  return settings.fontName ? `"${settings.fontName}", ${base}` : base;
}

// Показываем число в поле так, как оно хранится: без лишних нулей у целых.
function fmt(key, value) {
  return Number(value).toFixed(LIMITS[key].decimals);
}

function applySettings() {
  const root = document.documentElement;
  root.style.setProperty('--font-text', fontStack());
  root.style.setProperty('--text-size', `${settings.size}px`);
  root.style.setProperty('--text-line', String(settings.line));
  root.style.setProperty('--column-w', `${settings.width}px`);
  root.style.setProperty('--grain-level', String(settings.grain / 100));
  root.dataset.paper = settings.paper;
  root.dataset.para = settings.para;
  document.body.classList.toggle('typewriter', settings.typewriter);
  updateTwPad();

  // Тему применяет сама macOS-часть окна: так подстраиваются и меню, и полосы прокрутки
  if (settings.theme !== lastTheme) {
    lastTheme = settings.theme;
    api.setTheme(settings.theme).catch((err) => console.error('theme:', err));
  }

  sounds.setEnabled(settings.soundOn);
  sounds.setVolume(settings.volume / 100);
  sounds.setProfile(settings.soundProfile);
  for (const kind of ['key', 'space', 'backspace', 'enter']) sounds.setKeySel(kind, settings.keySrc[kind]);
  applyAmbient();
  markChips('#chipProfile', settings.soundProfile);
  markChips('#chipAmbient', settings.ambient);

  refreshBar();
  $('#setLinks').checked = settings.links;
  $('#setSpell').checked = settings.spellOn;
  applyAnalysisSettings();
  $('#setTypo').checked = settings.typo;
  $('#setTypoNbsp').checked = settings.typoNbsp;
  $('#setTypeAnim').checked = settings.typeAnim;
  document.documentElement.setAttribute('spellcheck', settings.spellOn ? 'true' : 'false');
  document.body.classList.toggle('links-off', !settings.links);
  if (settings.links !== lastLinks) {
    lastLinks = settings.links;
    applyLinks();
  }
  $('#setSoundOn').checked = settings.soundOn;
  $('#setAmbientOn').checked = settings.ambientOn;
  $('#setProjectGoalOn').checked = settings.projectGoalOn;
  $('#setStoryCharacters').checked = settings.storyCharacters;
  $('#setStoryPlaces').checked = settings.storyPlaces;
  applyKinds();
  if (project) renderTotal();
  if (!settings.projectGoalOn) closeProjPop();
  $('#setGoalChime').checked = settings.goalChime;
  $('#setTheme').value = settings.theme;
  $('#setPaper').value = settings.paper;
  $('#setPara').value = settings.para;

  // поле имени шрифта не трогаем, пока в нём печатают
  const nameInput = $('#setFontName');
  if (document.activeElement !== nameInput) nameInput.value = settings.fontName;

  if ([...$('#setFont').options].some((o) => o.value === settings.font)) {
    $('#setFont').value = settings.font;
  }
  $('#btnRemoveFont').hidden = !customFonts.has(settings.font);

  for (const key of Object.keys(LIMITS)) {
    const id = key.charAt(0).toUpperCase() + key.slice(1);
    $(`#set${id}`).value = String(settings[key]);
    const num = $(`#num${id}`);
    if (document.activeElement !== num) num.value = fmt(key, settings[key]);
  }
}

