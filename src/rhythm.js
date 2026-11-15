'use strict';

// Монотонность повествования: ровный ритм, цепочки коротких предложений, одинаковые начала.
// Работает со списком предложений (длина в словах и первое слово), без редактора: проверяется тестами.
// Реплики в диалоге не считаются, они сами по себе короткие и ломают цепочки.
// Это подсказка, а не приговор: ровный ритм бывает намеренным (скороговорка действия, анафора).

const SHORT_MAX = 6; // «короткое» предложение: до 6 слов
const LONG_MIN = 18; // «длинное»: от 18 слов
const MIN_SHORT_RUN = 4; // сколько коротких подряд считать цепочкой
const MIN_EVEN_RUN = 5; // сколько предложений одной длины подряд считать ровным ритмом
const MIN_START_RUN = 3; // сколько предложений подряд с одним началом
// Начало на «И», «А», «Но»: анафора («И… И… И…») классический намеренный приём, поэтому порог выше.
const { ANAPHORA_STARTS } = require('./morph');
const MIN_ANAPHORA_RUN = 4;
// «Гусеница»: длинное предложение, которое тянется на однородных сказуемых, деепричастиях или одних и тех же союзах.
const CAT_MIN_WORDS = 16; // короче такое предложение гусеницей не считаем
const CAT_PREDICATES = 4; // сказуемых и деепричастий в предложении
const CAT_SAME_CONJ = 3; // один и тот же союз столько раз («и… и… и…»)
const CAT_CONJ = 4; // всех сочинительных союзов
const RU_CONJ = new Set(['и', 'а', 'но', 'да', 'или', 'либо']);
const norm = (w) => w.toLowerCase().replace(/ё/g, 'е');

/**
 * Черты предложения для «гусеницы»: words — слова предложения [{ text, pos }] из morph.js.
 * pred: личные глаголы (без инфинитивов) и деепричастия; conj: сочинительные союзы; same: самый частый из них.
 */
function sentenceTraits(words, conjSet = RU_CONJ) {
  let pred = 0;
  let conj = 0;
  const seen = new Map();
  for (const w of words) {
    const low = norm(w.text);
    if (conjSet.has(low)) {
      conj += 1;
      seen.set(low, (seen.get(low) || 0) + 1);
    } else if (w.pos === 'verb' && !/(?:ть|ти|чь)(?:ся)?$/.test(low)) {
      pred += 1;
    } else if (w.pos === 'part' && /(?:[аяуюеи]я|[ая]|в|вши|вшись|ясь|аясь)$/.test(low) && !/(?:щая|щяя|вшая|нная|тая|ная)$/.test(low)) {
      pred += 1; // деепричастие: «прижимая», «указывая», «встав»
    }
  }
  return { pred, conj, same: Math.max(0, ...seen.values()) };
}

/** Начало реплики или прямой речи: такие абзацы пропускаем. */
function isDialogueText(text) {
  return /^\s*[—–«„"“-]/.test(text) && /^\s*(?:[—–]|[«„"“])/.test(text);
}

/**
 * Какие предложения абзаца реплики. Абзац, начинающийся с реплики, может продолжаться повествованием:
 * «— Пойдём, — сказал он. Она встала. Он взял её за руку.» После слов автора («, — сказал он.») предложения без тире в начале
 * уже повествование и в ритм входят; пока слов автора не было, продолжение без тире ещё реплика.
 * text: текст абзаца; sentences: [{ start, end }]. Возвращает массив булевых (true: реплика).
 */
function dialogueFlags(text, sentences) {
  const flags = sentences.map(() => false);
  if (!isDialogueText(text)) return flags;
  const startsSpeech = (t) => /^\s*[—–«„"“-]/.test(t);
  let speech = true; // абзац начинается с реплики
  sentences.forEach((s, i) => {
    const t = text.slice(s.start, s.end);
    if (startsSpeech(t)) {
      flags[i] = true;
      speech = !/[,!?…»”]\s*[—–]\s/.test(t.trim().slice(1)); // есть слова автора: дальше повествование
      return;
    }
    flags[i] = speech;
  });
  return flags;
}

/**
 * sentences: [{ words, first, dialogue }] по порядку (first: первое слово без регистра и «ё»).
 * Возвращает { items, stats }. item: { type: 'short' | 'even' | 'start', from, to (включительно), min, max, word }.
 */
function analyzeRhythm(sentences, anaphora = ANAPHORA_STARTS) {
  const items = [];
  const n = sentences.length;
  const narr = (i) => !sentences[i].dialogue && sentences[i].words > 0;

  // 1. Цепочки коротких предложений.
  const inShort = new Array(n).fill(false);
  for (let i = 0; i < n;) {
    if (!narr(i) || sentences[i].words > SHORT_MAX) { i += 1; continue; }
    let j = i;
    while (j + 1 < n && narr(j + 1) && sentences[j + 1].words <= SHORT_MAX) j += 1;
    if (j - i + 1 >= MIN_SHORT_RUN) {
      const w = sentences.slice(i, j + 1).map((s) => s.words);
      items.push({ type: 'short', from: i, to: j, min: Math.min(...w), max: Math.max(...w) });
      for (let k = i; k <= j; k += 1) inShort[k] = true;
    }
    i = j + 1;
  }

  // 2. Ровный ритм: подряд идущие не короткие предложения почти одной длины.
  for (let i = 0; i < n;) {
    if (!narr(i) || sentences[i].words <= SHORT_MAX) { i += 1; continue; }
    let j = i;
    let lo = sentences[i].words;
    let hi = lo;
    while (j + 1 < n && narr(j + 1) && sentences[j + 1].words > SHORT_MAX) {
      const w = sentences[j + 1].words;
      const nlo = Math.min(lo, w);
      const nhi = Math.max(hi, w);
      if (nhi - nlo > Math.max(3, Math.round(nlo * 0.3))) break;
      lo = nlo;
      hi = nhi;
      j += 1;
    }
    if (j - i + 1 >= MIN_EVEN_RUN) {
      items.push({ type: 'even', from: i, to: j, min: lo, max: hi });
      i = j + 1;
    } else {
      i += 1;
    }
  }

  // 3. Одинаковое начало подряд.
  for (let i = 0; i < n;) {
    if (!narr(i) || !sentences[i].first) { i += 1; continue; }
    let j = i;
    while (j + 1 < n && narr(j + 1) && sentences[j + 1].first === sentences[i].first) j += 1;
    const need = anaphora.has(sentences[i].first) ? MIN_ANAPHORA_RUN : MIN_START_RUN;
    if (j - i + 1 >= need) items.push({ type: 'start', from: i, to: j, word: sentences[i].first });
    i = j + 1;
  }

  // 4. «Гусеницы»: длинные предложения с цепочкой сказуемых или повторяющимися союзами.
  for (let i = 0; i < n; i += 1) {
    const x = sentences[i];
    if (!narr(i) || x.words < CAT_MIN_WORDS || x.pred === undefined) continue;
    if (x.pred >= CAT_PREDICATES || x.same >= CAT_SAME_CONJ || x.conj >= CAT_CONJ) {
      items.push({ type: 'caterpillar', from: i, to: i, words: x.words, pred: x.pred, conj: x.conj });
    }
  }

  items.sort((a, b) => a.from - b.from || a.to - b.to);

  // Сводка по повествованию.
  const w = sentences.filter((_s, i) => narr(i)).map((s) => s.words);
  const count = w.length;
  const mean = count ? w.reduce((a, b) => a + b, 0) / count : 0;
  const sd = count ? Math.sqrt(w.reduce((a, b) => a + (b - mean) ** 2, 0) / count) : 0;
  const cv = mean ? sd / mean : 0;
  const share = (f) => (count ? Math.round((w.filter(f).length / count) * 100) : 0);
  const stats = {
    count,
    mean: Math.round(mean * 10) / 10,
    short: share((x) => x <= SHORT_MAX),
    long: share((x) => x >= LONG_MIN),
    cv: Math.round(cv * 100) / 100,
    spread: count < 8 ? 'unknown' : cv < 0.4 ? 'low' : cv > 0.65 ? 'high' : 'normal',
  };
  stats.medium = count ? Math.max(0, 100 - stats.short - stats.long) : 0;
  return { items, stats };
}

module.exports = { analyzeRhythm, sentenceTraits, isDialogueText, dialogueFlags, SHORT_MAX, LONG_MIN };
