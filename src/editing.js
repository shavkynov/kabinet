'use strict';

// Помощники редактуры: слова-паразиты и повторы слов. Ничего не правят, только находят места.
// Повторы: слова сравниваются по основе, найденной алгоритмом (src/stem.js), поэтому «дверь, дверью, дверей» одно слово,
// а «голос» и «голова» разные. Имена собственные (слово с заглавной буквой не в начале предложения) не считаются.

const { norm, classify } = require('./morph');
const { speechRanges } = require('./speech');
const { stem } = require('./stem');
const en = require('./en');

const DEFAULT_FILLERS = {
  ru: [
    'просто', 'как бы', 'типа', 'короче', 'вообще', 'в общем', 'в общем-то', 'на самом деле', 'в принципе',
    'собственно', 'кстати', 'ну', 'значит', 'конечно', 'видимо', 'наверное', 'наверно', 'по сути',
    'фактически', 'буквально', 'практически', 'слегка', 'довольно', 'достаточно', 'очень', 'весьма',
    'крайне', 'вдруг', 'внезапно', 'неожиданно', 'казалось', 'казалось бы', 'как будто', 'почему-то',
    'вроде', 'вроде бы', 'пожалуй', 'так сказать', 'в некотором смысле', 'как-то',
  ],
  en: [
    'just', 'really', 'very', 'actually', 'basically', 'literally', 'quite', 'rather', 'somewhat',
    'suddenly', 'kind of', 'sort of', 'in fact', 'simply', 'definitely', 'probably', 'perhaps', 'maybe',
  ],
};

const MAX_FILLERS = 300;

/** Приводит запись из списка к виду «слово или фраза в нижнем регистре», либо '' если запись негодная. */
// Запись списка: слово или фраза; «слово*»: любое окончание после основы; «слово~»: все формы этого слова (по стеммеру).
// Знак ставится только в конце одного слова и после трёх букв и больше: «по*» отметило бы полтекста.
const WILDCARD_RE = /^[\p{L}][\p{L}-]{2,}[*~]$/u;

function cleanFiller(raw) {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (s.length < 2 || s.length > 40 || !/\p{L}/u.test(s)) return '';
  if (/[*~]/.test(s)) return WILDCARD_RE.test(s) ? s : '';
  return s;
}

function cleanFillerList(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const s = cleanFiller(raw);
    if (s && !seen.has(norm(s))) { seen.add(norm(s)); out.push(s); }
    if (out.length >= MAX_FILLERS) break;
  }
  return out;
}

/** Ключи «всех форм» слова для записи «слово~»: основа по стеммеру; у глаголов на -овать ещё основа настоящего времени. */
function formKeys(word) {
  const w = norm(word);
  const pos = classify(w);
  const s = stem(w, pos);
  if (s.length < 3) return [];
  const keys = [{ stem: s, pos }];
  if (pos === 'verb' && /ов$/.test(s) && s.length >= 6) keys.push({ stem: s.slice(0, -2), pos }); // почувствов- / почувств-
  return keys;
}

/**
 * Регулярное выражение для списка слов и фраз (е и ё считаются одной буквой); null, если список пуст.
 * Записи «слово~» в регулярку не входят: они лежат в re.forms и проверяются по основе слова (см. findFillers).
 * re.key: строка для сравнения списков (у списка из одних «~»-записей регулярка пустая).
 */
function compileFillers(list) {
  const clean = cleanFillerList(list);
  const forms = new Map(); // основа -> часть речи записи
  const plain = [];
  for (const s of clean) {
    const n = norm(s);
    if (n.endsWith('~')) { for (const k of formKeys(n.slice(0, -1))) forms.set(k.stem, k.pos); } else plain.push(n);
  }
  const escape = (w) => w.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&').replace(/е/g, '[её]');
  const parts = plain
    .sort((a, b) => b.length - a.length)
    .map((s) => (s.endsWith('*') ? `${escape(s.slice(0, -1))}\\p{L}*` : s.split(' ').map(escape).join('\\s+')));
  if (!parts.length && !forms.size) return null;
  const re = parts.length
    ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${parts.join('|')})(?![\\p{L}\\p{N}]|-\\p{L})`, 'giu')
    : new RegExp('(?!)', 'giu'); // ничего не находит: в списке только «все формы»
  re.forms = forms;
  re.key = JSON.stringify(clean);
  return re;
}

// Слова, которые в одних значениях паразиты, а в других обычные: решаем по соседним словам.
const prevWord = (text, start) => {
  const m = /([\p{L}]+)([^\p{L}]*)$/u.exec(text.slice(Math.max(0, start - 80), start)); // слово рядом, весь абзац не нужен
  return !m || /[.!?…—–«"„“]/.test(m[2]) ? '' : norm(m[1]);
};
const nextWord = (text, end) => {
  const m = /^([^\p{L}]*)([\p{L}]+)/u.exec(text.slice(end, end + 80));
  return !m || /[.!?…]/.test(m[1]) ? '' : norm(m[2]);
};
const INSTR = /(?:ым|им|ой|ей|ыми|ими|ою|ею)$/;
const TIME_AFTER = new Set('раз однажды вечером утром днём днем ночью летом зимой весной осенью давно'.split(' '));

const RULED = new Set(['значит', 'вдруг', 'довольно', 'достаточно', 'казалось', 'как-то', 'просто']);

/** true, если слово из списка здесь значит другое и паразитом не является. */
function isOrdinaryUse(text, phrase, start, end) {
  if (!RULED.has(phrase)) return false; // у остальных слов других значений нет
  const prev = prevWord(text, start);
  const next = nextWord(text, end);
  const after = /^\s*(.)/.exec(text.slice(end, end + 8));
  switch (phrase) {
    case 'значит': // «Что значит это слово?», «Это значит, что…», «Значит ли это…»
      return ['что', 'это', 'то', 'не', 'все', 'всё', 'также', 'ничего'].includes(prev) || next === 'ли';
    case 'вдруг': // «А вдруг она не придёт?»
      return ['а', 'что', 'если', 'ведь', 'ли'].includes(prev);
    case 'довольно':
      if (after && /[!.?…]/.test(after[1])) return true; // «Довольно! Хватит.», «С меня довольно.»: слово одно, это «хватит»
      if (next === 'с') return true; // «Довольно с меня»
      return !!next && classify(next, { prev: 'довольно' }) === 'verb'; // «довольно улыбнулся» = удовлетворённо
    case 'достаточно':
      if (after && /[!.?…]/.test(after[1])) return true;
      return next === 'с' || next === 'для' || next === 'чтобы';
    case 'казалось': // «Мне казалось странным его молчание»
      return INSTR.test(next);
    case 'как-то':
      return TIME_AFTER.has(next); // «Как-то раз летом…»
    case 'просто': // «Это было просто», «совсем не просто»
      return ['было', 'был', 'была', 'были', 'будет', 'не'].includes(prev);
    default:
      return false;
  }
}

/**
 * Места слов-паразитов в тексте: [{ start, end }].
 * opts.skipSpeech: не отмечать в прямой речи (кавычки, реплики после тире): разговорность героя задумана автором.
 * Слова-омонимы («Что значит…», «А вдруг…», «Довольно!») паразитами не считаются.
 */
function findFillers(text, re, opts = {}) {
  if (!re) return [];
  const speech = opts.skipSpeech ? speechRanges(text) : [];
  const out = [];
  const consider = (start, end) => {
    if (speech.some(([a, b]) => start >= a && start < b)) return;
    if (isOrdinaryUse(text, norm(text.slice(start, end)).replace(/\s+/g, ' '), start, end)) return;
    out.push({ start, end });
  };
  for (const m of text.matchAll(re)) consider(m.index, m.index + m[0].length);
  if (re.forms && re.forms.size) { // записи «слово~»: слово текста сводится к основе и сравнивается
    const seen = new Set(out.map((f) => f.start));
    for (const m of text.matchAll(/\p{L}+(?:-\p{L}+)*/gu)) {
      if (seen.has(m.index)) continue;
      const w = norm(m[0]);
      const pos = classify(w);
      const want = re.forms.get(stem(w, pos));
      // наречие «просто» не должно находить прилагательное «простой», поэтому для наречий часть речи должна совпасть
      if (want === undefined || (want === 'adv' && pos !== 'adv')) continue;
      consider(m.index, m.index + m[0].length);
    }
    out.sort((a, b) => a.start - b.start);
  }
  return out;
}

// Слова, которые повторяются в любом тексте и поэтому повтором не считаются.
const COMMON = new Set(`был была было были будет будут быть это этот эта эти тот такой который которая которое которые свой своя
свое свои весь вся все всё мочь мог могла могли есть можно нужно надо нет
сказал сказала сказали сказало сказать ответил ответила ответили ответить спросил спросила спросили спросить
стал стала стали стало стать хотел хотела хотели хотело хотеть`.split(/\s+/).map(norm));

const COMMON_EN = new Set(`said asked replied answered looked seemed went came took made thought knew about which these those other where there their would could should
  something nothing anything everything someone people thing things never always again before after through still little around another because while until`.split(/\s+/));
const REPEAT_POS = new Set(['verb', 'noun', 'adj', 'adv']);

/** Основа слова для сравнения; '' если слово не подходит для поиска повторов. */
function repeatKey(word) {
  const w = norm(word.text);
  if (w.length < 5 || !REPEAT_POS.has(word.pos) || COMMON.has(w)) return '';
  if (/^[a-z'’-]+$/.test(w)) { // английский: свои стоп-слова и основа
    if (COMMON_EN.has(w) || en.AUX.has(w)) return '';
    const s = en.stem(w, word.pos);
    return s.length >= 3 ? `${word.pos}:${s}` : '';
  }
  if (!/[а-я]/.test(w)) { // другой алфавит: грубое сведение к началу слова
    const cut = w.length >= 7 ? 3 : w.length === 6 ? 2 : 1;
    return `${word.pos}:${w.slice(0, -cut)}`;
  }
  const s = stem(w, word.pos);
  return s.length >= 3 ? `${word.pos}:${s}` : '';
}

/**
 * Какие слова похожи на имена собственные: заглавная буква не в начале предложения и не после двоеточия, тире, кавычки.
 * words: [{ start, text }], sentences: [{ start }] как в morph.js. Возвращает массив true/false по словам.
 */
function properFlags(text, words, sentences) {
  const first = new Set();
  for (const s of sentences) {
    const i = words.findIndex((w) => w.start >= s.start);
    if (i >= 0) first.add(i);
  }
  return words.map((w, i) => {
    const ch = w.text[0];
    if (!ch || ch === ch.toLowerCase() || first.has(i)) return false;
    const prev = text.slice(0, w.start).trimEnd().slice(-1);
    return prev !== '' && !/[:—–«„“"(]/.test(prev);
  });
}

/**
 * Повторы: слова с одной основой ближе друг к другу, чем windowSize слов.
 * seq: все слова подряд [{ text, pos }]. Возвращает Set номеров слов, у которых есть повтор рядом.
 */
function repeatPairs(seq, windowSize) {
  const last = new Map();
  const pairs = []; // [индекс предыдущего слова, индекс слова]
  // основы имён собственных (w.proper): пропускаем все формы и все вхождения, в том числе в начале предложения
  const names = new Set();
  for (const w of seq) {
    if (!w.proper) continue;
    const key = repeatKey({ text: w.text, pos: 'noun' });
    if (key) names.add(key.slice(key.indexOf(':') + 1));
  }
  seq.forEach((w, i) => {
    if (w.skip) return; // слово из «Не отмечать здесь»: в сравнении не участвует, но места в ряду занимает
    const key = repeatKey(w);
    if (!key) return;
    if (names.size && names.has(key.slice(key.indexOf(':') + 1))) return;
    const j = last.get(key);
    if (j !== undefined && i - j <= windowSize) pairs.push([j, i]);
    last.set(key, i);
  });
  return pairs;
}

/** Индексы слов, у которых есть такое же слово ближе windowSize слов. */
function findRepeats(seq, windowSize) {
  const marked = new Set();
  for (const [j, i] of repeatPairs(seq, windowSize)) { marked.add(i); marked.add(j); }
  return marked;
}

// ---------- исключения подсветки «Не отмечать здесь» (хранятся в настройках проекта) ----------
const SKIP_CATS = ['adv', 'passive', 'long', 'repeat', 'filler'];
const SKIP_MAX = 300; // записей на категорию
const SKIP_LEN = 160;

/** Ключ исключения: текст отмеченного места в нижнем регистре, «ё» как «е», пробелы сжаты. */
function skipKey(text) {
  return norm(String(text ?? '')).replace(/[\s\u00a0]+/g, ' ').trim().slice(0, SKIP_LEN);
}

/** Исключения из файла проекта: { adv: [ключи], ... } только известные категории, без повторов и пустых. */
function cleanSkip(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const cat of SKIP_CATS) {
    if (!Array.isArray(raw[cat])) continue;
    const list = [...new Set(raw[cat].map((x) => (typeof x === 'string' ? skipKey(x) : '')).filter(Boolean))].slice(0, SKIP_MAX);
    if (list.length) out[cat] = list;
  }
  return out;
}

module.exports = { DEFAULT_FILLERS, MAX_FILLERS, cleanFiller, cleanFillerList, compileFillers, findFillers, repeatKey, findRepeats, repeatPairs, properFlags, SKIP_CATS, skipKey, cleanSkip };
