'use strict';

// Экспериментальные правила без Rust/UDPipe. Модуль не подключён к приложению:
// только скрипт сравнения и тесты. Морфология берётся из src/morph.js, где есть
// только часть речи; падеж и зависимости здесь не выдаются за анализ.

const { analyzeBlock } = require('../morph');
const { speechRanges } = require('../speech');

const NOMINALIZATION = /^\p{L}{2,}(?:ани|ени|ти|ви)(?:е|я|ю|ем|и|й|ям|ями|ях)$/u;
const GEN_LIKE = /(?:а|я|ы|и|ов|ев|ей|ий|ых|их|ого|его|ой|ей)$/u;
const NOT_GEN = /(?:л|ла|ло|ли|ся|сь)$/u;
const NOMINALIZATION_STOP_STEMS = [
  'здан', 'мгновен', 'мнен', 'услов', 'знан', 'строен', 'воскресен', 'явлен',
  'событ', 'сознан', 'влиян', 'значен', 'вниман', 'ощущен', 'поведен', 'движен',
  'положен', 'отношен', 'содержан', 'примен', 'издел', 'оруж', 'компан', 'парт',
  'врем', 'имен', 'плем', 'сем', 'знам', 'брем', 'стрем', 'демократ', 'крат',
];
const LOOKS_ADJECTIVAL = /(?:енн|анн|янн|ущ|ющ|ащ|ящ|вш)(?:ый|ая|ое|ые|ого|ой|ому|ым|ых|ыми|ую|ом|ем|а|я|о|ы|и)$/u;
const PREPOSITIONS = new Set(['в', 'во', 'на', 'о', 'об', 'обо', 'по', 'при', 'для', 'из', 'от', 'с', 'со', 'к', 'ко', 'под', 'над', 'за', 'перед', 'между', 'через', 'без', 'около', 'после']);
const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');
const clean = (s) => norm(s).replace(/[^а-я-]/g, '');
const onlyWhitespace = (text, a, b) => /^\s*$/.test(text.slice(a, b));

function isNominalization(word) {
  const w = clean(word);
  return NOMINALIZATION.test(w) && !NOMINALIZATION_STOP_STEMS.some((stem) => w.startsWith(stem));
}

function isLexicalizedStop(word) {
  if (word.pos !== 'noun' && !isNominalization(word.text)) return false;
  const w = clean(word.text);
  return NOMINALIZATION_STOP_STEMS.some((stem) => w.startsWith(stem));
}

function isNominalHead(word) {
  if (word.pos === 'noun') return !isLexicalizedStop(word) && !LOOKS_ADJECTIVAL.test(clean(word.text));
  return isNominalization(word.text) && !isLexicalizedStop(word);
}

function isModifier(word) {
  return word.pos === 'adj' || word.pos === 'part';
}

function isPrep(word) {
  return word.pos === 'func' && PREPOSITIONS.has(clean(word.text));
}

function isGenitiveLike(word) {
  const w = clean(word);
  return w.length >= 4 && GEN_LIKE.test(w) && !NOT_GEN.test(w);
}

function makeFinding(text, start, end, variant, confidence, explanation, method, limitations) {
  return {
    category: 'chain',
    start,
    end,
    fragment: text.slice(start, end),
    variant,
    confidence,
    explanation,
    method,
    limitations,
  };
}

function chainRuns(text, variant) {
  const speech = speechRanges(text);
  const words = analyzeBlock(text).words;
  const runs = [];
  let run = [];

  function flush() {
    if (!run.length) return;
    const heads = run.filter(isNominalHead);
    const nominalizations = heads.filter((h) => isNominalization(h.text)).length;
    const nonFirst = heads.slice(1);
    const genitiveCount = nonFirst.filter((h) => {
      const at = run.indexOf(h);
      const prev = run.slice(0, at).reverse().find((w) => w !== h);
      return isGenitiveLike(h.text) || (variant === 'A2' && prev && isPrep(prev));
    }).length;
    const hasPrep = run.some(isPrep);
    const structuralOk = variant === 'A1'
      ? (heads.length >= 3 && nominalizations >= 2 && genitiveCount === nonFirst.length)
      : (heads.length >= 4 && hasPrep && genitiveCount >= 2 && nominalizations >= 1);
    if (structuralOk) {
      const start = heads[0].start;
      const end = heads[heads.length - 1].end;
      runs.push({ text, start, end, heads, nominalizations, run, variant });
    }
    run = [];
  }

  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (speech.some(([a, b]) => w.start >= a && w.start < b)) { flush(); continue; }
    const prev = run[run.length - 1];
    const contiguous = prev && onlyWhitespace(text, prev.end, w.start);
    if (!contiguous) { flush(); }
    if (!contiguous && run.length === 0) {
      if (isNominalHead(w)) { run = [w]; continue; }
      continue;
    }
    if (isNominalHead(w)) {
      if (!run.length) { run = [w]; continue; }
      run.push(w);
      continue;
    }
    if (run.length && isLexicalizedStop(w) && contiguous) {
      // Лексикализованное слово не продолжает цепочку и не даёт засчитать её хвост.
      run = [];
      continue;
    }
    if (run.length && isModifier(w)) {
      const next = words[i + 1];
      const advOk = variant === 'A2' && w.pos === 'adv' && next && next.pos === 'adj';
      if (isModifier(w) || advOk) { run.push(w); continue; }
    }
    if (run.length && variant === 'A2' && isPrep(w)) { run.push(w); continue; }
    if (run.length && variant === 'A2' && w.pos === 'adv') {
      const next = words[i + 1];
      if (next && next.pos === 'adj') { run.push(w); continue; }
    }
    flush();
    // Не начинаем новый run с предлога/прилагательного: только с именной головы.
    if (isNominalHead(w)) run = [w];
  }
  flush();
  return runs;
}

function findChainsLight(text, variant = 'A1') {
  if (variant !== 'A1' && variant !== 'A2') throw new Error('variant должен быть A1 или A2');
  return chainRuns(text, variant).map((r) => makeFinding(
    text,
    r.start,
    r.end,
    variant,
    r.nominalizations >= 3 ? 'medium' : 'low',
    `Позиционная эвристика: ${r.heads.length} именные головы, ${r.nominalizations} кандидатов в номинализации; падеж не определялся.`,
    variant === 'A1'
      ? ['morph:pos', 'suffix:nominalization', 'form:genitive-like', 'sequence:whitespace']
      : ['morph:pos', 'suffix:nominalization', 'form:genitive-like', 'sequence:whitespace', 'preposition-proxy'],
    ['Падеж не определяется; GEN_LIKE — только окончание.', 'Зависимости не проверяются; это позиционная эвристика.'],
  ));
}

// ---------- B: перегруженность придаточными ----------

const MARKER_RE = /(?<![\p{L}])(?:потому что|так что|несмотря на то что|при том что|что бы ни|котор(?:ый|ая|ое|ые|ого|ой|ому|ым|ых|ыми|ую|ом))(?![\p{L}])|(?:,\s*)что(?![\p{L}-]|\s+(?:ли|бы)(?!\s+ни))(?![\p{L}])/giu;

function markerList(text, sentenceStart, sentenceEnd, speech) {
  const local = text.slice(sentenceStart, sentenceEnd);
  const out = [];
  for (const m of local.matchAll(MARKER_RE)) {
    const start = sentenceStart + m.index;
    if (speech.some(([a, b]) => start >= a && start < b)) continue;
    out.push({ start, end: start + m[0].length, text: m[0] });
  }
  return out.sort((a, b) => a.start - b.start);
}

function sentenceSpan(text, sentence) {
  let start = sentence.start;
  let end = sentence.end;
  while (start < end && /\s/.test(text[start])) start += 1;
  while (end > start && /\s/.test(text[end - 1])) end -= 1;
  return [start, end];
}

function findWhichLight(text, variant = 'B1') {
  if (variant !== 'B1' && variant !== 'B2') throw new Error('variant должен быть B1 или B2');
  const speech = speechRanges(text);
  const block = analyzeBlock(text);
  const out = [];
  for (const sentence of block.sentences) {
    const markers = markerList(text, sentence.start, sentence.end, speech);
    if (!markers.length) continue;
    let keep = markers;
    if (variant === 'B1') {
      if (markers.length < 3) continue;
    } else {
      // B2: разные пунктуационные сегменты, и в каждом есть глагол.
      const bySegment = new Map();
      for (const marker of markers) {
        const before = text.slice(sentence.start, marker.start);
        const seg = before.split(/[,;:]/).length - 1;
        if (!bySegment.has(seg)) bySegment.set(seg, []);
        bySegment.get(seg).push(marker);
      }
      const valid = [];
      for (const [seg, list] of bySegment) {
        const bounds = segmentBounds(text, sentence, seg);
        const hasVerb = block.words.some((w) => w.pos === 'verb' && w.start >= bounds[0] && w.end <= bounds[1]);
        if (hasVerb) valid.push(...list);
      }
      if (valid.length < 3) continue;
      keep = valid;
    }
    const [start, end] = sentenceSpan(text, sentence);
    out.push({
      category: 'which',
      start,
      end,
      fragment: text.slice(start, end),
      variant,
      confidence: 'low',
      explanation: `Эвристика перегруженности: ${keep.length} маркеров придаточных; это не подсчёт клауз по дереву.`,
      method: variant === 'B1'
        ? ['regex:marker', 'sentence-boundary', 'speech-boundary']
        : ['regex:marker', 'punctuation-segments', 'morph:verb', 'sentence-boundary', 'speech-boundary'],
      limitations: ['Нет дерева зависимостей; границы клауз приблизительны.', 'Союзы могут вводить полноценные придаточные; наличие маркера не доказывает перегруженность.'],
    });
  }
  return out;
}

function segmentBounds(text, sentence, segmentIndex) {
  const local = text.slice(sentence.start, sentence.end);
  const parts = local.split(/([,;:])/);
  let pos = sentence.start;
  let idx = 0;
  let start = sentence.start;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (i % 2 === 1) { // separator
      if (idx === segmentIndex) return [start, pos];
      idx += 1;
      pos += part.length;
      start = pos;
    } else {
      pos += part.length;
    }
  }
  return [start, sentence.end];
}

module.exports = { findChainsLight, findWhichLight, NOMINALIZATION_STOP_STEMS };
