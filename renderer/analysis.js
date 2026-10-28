// Подсветка частей речи, страдательного залога, длинных предложений, слов-паразитов и повторов. Как маркером поверх текста:
// сам текст не меняется. Разбор по правилам (src/morph.js), он приблизительный.

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { analyzeBlock as analyzeBlockRu } from '../src/morph.js';
import * as EN from '../src/en.js';
import { analyzeTenseBlock as analyzeTenseBlockRu, detectBase } from '../src/tense.js';
import { compileFillers, findFillers, repeatPairs, properFlags, skipKey } from '../src/editing.js';
import { t, LANG } from './i18n.js';

// Язык текста = язык интерфейса: для английского свои части речи, пассив, времена, основы слов и анафора.
const analyzeBlock = LANG === 'en' ? EN.analyzeBlock : analyzeBlockRu;
const analyzeTenseBlock = LANG === 'en' ? EN.analyzeTenseBlock : analyzeTenseBlockRu;
import { analyzeRhythm, isDialogueText, dialogueFlags } from '../src/rhythm.js';

export const analysisKey = new PluginKey('textAnalysis');

export const AN_CATS = ['verb', 'noun', 'adj', 'adv', 'part', 'pron', 'passive', 'long', 'filler', 'repeat', 'tense', 'rhythm'];
// Категории с подсказкой, переходом «‹ ›» и исключением «Не отмечать здесь».
export const AN_NAV_CATS = ['adv', 'passive', 'long', 'repeat', 'filler'];

// Подсказки к подсвеченным словам (атрибут title; цвет и форма подсветки не меняются). Шаблоны переводятся один раз:
// подсветка пересчитывается при наборе, а подсказок в тексте тысячи.
let TPL = null;
function tpl() {
  if (TPL) return TPL;
  const f = (ru) => t(ru, '\u0001', '\u0002');
  TPL = {
    adv: f('Наречие: «{0}»'),
    passive: f('Страдательный залог: «{0}»'),
    long: f('Длинное предложение: {0} (порог {1})'),
    repeatPrev: f('Повтор: слово «{0}» уже было {1} назад'),
    repeatNext: f('Повтор: слово «{0}» встретится снова через {1}'),
    filler: f('Слово-паразит из списка: «{0}»'),
  };
  return TPL;
}
const fill = (s, a, b) => s.replace('\u0001', () => a).replace('\u0002', () => (b === undefined ? '' : b));

/** «7 слов», «1 слово», «3 слова» (на английском: «7 words»). */
function wordsPhrase(n) {
  if (LANG !== 'ru') return `${n} ${n === 1 ? 'word' : 'words'}`;
  const a = n % 10;
  const b = n % 100;
  return `${n} ${a === 1 && b !== 11 ? 'слово' : a >= 2 && a <= 4 && (b < 12 || b > 14) ? 'слова' : 'слов'}`;
}

const emptyRanges = () => ({ adv: [], passive: [], long: [], repeat: [], filler: [] });

let fillerKey = null;
let fillerRe = null;
function fillerRegex(list) {
  const key = (list || []).join('\n');
  if (key !== fillerKey) { fillerKey = key; fillerRe = compileFillers(list || []); }
  return fillerRe;
}

const cache = new WeakMap(); // абзац (узел редактора) -> результат разбора; нетронутые абзацы не пересчитываются

function blockResult(node) {
  let r = cache.get(node);
  if (!r) {
    r = analyzeBlock(node.textBetween(0, node.content.size, '', '￼'));
    cache.set(node, r);
  }
  return r;
}

const tenseCache = new WeakMap();

/** Несогласованность времён: глаголы не того времени, что в основном повествовании. mode: auto (по тексту) | present | past. */
export function scanTense(doc, mode) {
  let past = 0;
  let present = 0;
  const found = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (node.type.name === 'codeBlock' || node.content.size === 0) return false;
    let tr = tenseCache.get(node);
    if (!tr) {
      const r = blockResult(node);
      tr = analyzeTenseBlock(node.textBetween(0, node.content.size, '', '￼'), r.words, r.sentences);
      tr.words = r.words;
      tenseCache.set(node, tr);
    }
    past += tr.past;
    present += tr.present;
    for (const it of tr.items) {
      found.push({ from: pos + 1 + it.start, to: pos + 1 + it.end, kind: it.kind, conf: it.conf, why: it.why });
    }
    return false;
  });
  const base = mode === 'present' || mode === 'past' ? mode : detectBase(past, present);
  const odd = base === 'present' ? 'past' : base === 'past' ? 'present' : null;
  return { base, items: found.filter((it) => it.kind === odd), past, present };
}

// Слова-паразиты по абзацу кэшируются: при наборе пересчитывается только изменённый абзац.
const fillerCache = new WeakMap();
function fillersOf(node, text, re, cfg) {
  const skip = cfg.fillerSkipSpeech !== false;
  const sig = `${skip ? 1 : 0}|${re.key || re.source}`;
  const c = fillerCache.get(node);
  if (c && c.sig === sig) return c.hits;
  const hits = findFillers(text, re, { skipSpeech: skip });
  fillerCache.set(node, { sig, hits });
  return hits;
}

const rhythmCache = new WeakMap();

/** Монотонность: предложения главы с позициями и найденные цепочки. Реплики и заголовки в расчёт не берутся. */
export function scanRhythm(doc) {
  const sentences = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (node.type.name === 'codeBlock' || node.content.size === 0) return false;
    let list = rhythmCache.get(node);
    if (!list) {
      const text = node.textBetween(0, node.content.size, '', '￼');
      const r = blockResult(node);
      const flags = dialogueFlags(text, r.sentences); // в абзаце с репликой повествование после слов автора считается
      const heading = node.type.name === 'heading';
      list = r.sentences.map((s, k) => {
        const w = r.words.find((x) => x.start >= s.start && x.start < s.end);
        return {
          start: s.start, end: s.end, words: s.words, dialogue: heading || flags[k],
          first: w ? w.text.toLowerCase().replace(/ё/g, '\u0435') : '',
          fStart: w ? w.start : s.start, fEnd: w ? w.end : s.start,
        };
      });
      rhythmCache.set(node, list);
    }
    const base = pos + 1;
    for (const s of list) {
      sentences.push({
        from: base + s.start, to: base + s.end, words: s.words, dialogue: s.dialogue,
        first: s.first, fromFirst: base + s.fStart, toFirst: base + s.fEnd,
      });
    }
    return false;
  });
  const res = analyzeRhythm(sentences, LANG === 'en' ? EN.ANAPHORA_STARTS : undefined);
  return { sentences, items: res.items, stats: res.stats };
}

function build(doc, cfg) {
  const cats = cfg.cats || {};
  const any = AN_CATS.some((k) => cats[k]);
  const stats = { words: 0, verb: 0, noun: 0, adj: 0, adv: 0, part: 0, pron: 0, passive: 0, long: 0, filler: 0, repeat: 0, tense: 0, rhythm: 0 };
  if (!any) return { set: DecorationSet.empty, stats, active: false, ranges: emptyRanges() };
  const decos = [];
  const T = tpl();
  const ranges = emptyRanges(); // места по категориям, в порядке текста: для «‹ ›» и меню «Не отмечать здесь»
  const skip = {}; // исключения «Не отмечать здесь» (настройки проекта)
  for (const cat of AN_NAV_CATS) skip[cat] = new Set((cfg.skip && cfg.skip[cat]) || []);
  if (cats.tense) {
    const ts = scanTense(doc, cfg.tenseMode);
    stats.tense = ts.items.length;
    for (const it of ts.items) decos.push(Decoration.inline(it.from, it.to, { class: it.conf === 'low' ? 'an an-tense an-tense-soft' : 'an an-tense' }));
  }
  if (cats.rhythm) {
    const rs = scanRhythm(doc);
    stats.rhythm = rs.items.length;
    for (const it of rs.items) {
      if (it.type === 'start') {
        for (let k = it.from; k <= it.to; k += 1) {
          const s = rs.sentences[k];
          if (s.toFirst > s.fromFirst) decos.push(Decoration.inline(s.fromFirst, s.toFirst, { class: 'an an-rhythm-start' }));
        }
      } else {
        for (let k = it.from; k <= it.to; k += 1) decos.push(Decoration.inline(rs.sentences[k].from, rs.sentences[k].to, { class: 'an an-rhythm' }));
      }
    }
  }
  const re = cats.filler ? fillerRegex(cfg.fillers) : null;
  const seq = []; // все слова подряд для поиска повторов: { text, pos, from, to }
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (node.type.name === 'codeBlock' || node.content.size === 0) return false;
    const base = pos + 1;
    const r = blockResult(node);
    const blockText = node.textBetween(0, node.content.size, '', '￼');
    // Слова-паразиты ищем первыми: слово, отмеченное как паразит, не красим ещё и как наречие
    const allFillerHits = re ? fillersOf(node, blockText, re, cfg) : [];
    const fillerHits = skip.filler.size ? allFillerHits.filter((f) => !skip.filler.has(skipKey(blockText.slice(f.start, f.end)))) : allFillerHits;
    for (const w of r.words) {
      if (w.pos === 'num' || w.pos === 'other') continue;
      stats.words += 1;
      // слово, отмеченное как паразит (даже исключённое из паразитов), не красим ещё и как наречие
      const asFiller = w.pos === 'adv' && allFillerHits.some((f) => w.start < f.end && w.end > f.start);
      const skipped = w.pos === 'adv' && skip.adv.size > 0 && skip.adv.has(skipKey(w.text));
      if (stats[w.pos] !== undefined && !asFiller && !skipped) stats[w.pos] += 1;
      if (cats[w.pos] && !asFiller && !skipped) {
        const attrs = { class: `an an-${w.pos}` };
        if (w.pos === 'adv') {
          attrs.title = fill(T.adv, w.text);
          ranges.adv.push({ from: base + w.start, to: base + w.end });
        }
        decos.push(Decoration.inline(base + w.start, base + w.end, attrs));
      }
    }
    if (cats.repeat) {
      const proper = properFlags(node.textBetween(0, node.content.size, '', '￼'), r.words, r.sentences);
      const hasSkip = skip.repeat.size > 0;
      r.words.forEach((w, i) => seq.push({ text: w.text, pos: w.pos, from: base + w.start, to: base + w.end, proper: proper[i], skip: hasSkip && skip.repeat.has(skipKey(w.text)) }));
    }
    for (const f of fillerHits) {
      stats.filler += 1;
      const from = base + f.start;
      const to = base + f.end;
      decos.push(Decoration.inline(from, to, { class: 'an an-filler', title: fill(T.filler, blockText.slice(f.start, f.end)) }));
      ranges.filler.push({ from, to });
    }
    for (const p of r.passive) {
      const text = blockText.slice(p.start, p.end);
      if (skip.passive.size && skip.passive.has(skipKey(text))) continue;
      stats.passive += 1;
      if (cats.passive) {
        decos.push(Decoration.inline(base + p.start, base + p.end, { class: 'an an-passive', title: fill(T.passive, text) }));
        ranges.passive.push({ from: base + p.start, to: base + p.end });
      }
    }
    for (const s of r.sentences) {
      if (s.words >= (cfg.longMin || 30)) {
        if (skip.long.size && skip.long.has(skipKey(blockText.slice(s.start, s.end)))) continue;
        stats.long += 1;
        if (cats.long) {
          decos.push(Decoration.inline(base + s.start, base + s.end, { class: 'an an-long', title: fill(T.long, wordsPhrase(s.words), String(cfg.longMin || 30)) }));
          ranges.long.push({ from: base + s.start, to: base + s.end });
        }
      }
    }
    return false;
  });
  if (cats.repeat) {
    const prev = new Map(); // слово -> предыдущее такое же (индекс и расстояние)
    const next = new Map();
    const marked = new Set();
    for (const [j, i] of repeatPairs(seq, cfg.repeatWin || 25)) {
      marked.add(i);
      marked.add(j);
      prev.set(i, { j, dist: i - j });
      if (!next.has(j)) next.set(j, { i, dist: i - j });
    }
    for (const i of [...marked].sort((a, b) => a - b)) {
      stats.repeat += 1;
      const p = prev.get(i);
      const title = p ? fill(T.repeatPrev, seq[p.j].text, wordsPhrase(p.dist)) : fill(T.repeatNext, seq[next.get(i).i].text, wordsPhrase(next.get(i).dist));
      decos.push(Decoration.inline(seq[i].from, seq[i].to, { class: 'an an-repeat', title }));
      ranges.repeat.push({ from: seq[i].from, to: seq[i].to });
    }
  }
  for (const cat of AN_NAV_CATS) ranges[cat].sort((a, b) => a.from - b.from);
  return { set: DecorationSet.create(doc, decos), stats, active: true, ranges };
}

export const TextAnalysis = Extension.create({
  name: 'textAnalysis',
  addOptions() {
    return { getConfig: () => ({ cats: {}, longMin: 30, fillers: [], repeatWin: 25, tenseMode: 'auto' }), onStats: () => {} };
  },
  addProseMirrorPlugins() {
    const opts = this.options;
    return [new Plugin({
      key: analysisKey,
      state: {
        init: (_, state) => build(state.doc, opts.getConfig()),
        apply: (tr, old, _o, state) => (tr.docChanged || tr.getMeta(analysisKey) ? build(state.doc, opts.getConfig()) : old),
      },
      props: { decorations(state) { return analysisKey.getState(state).set; } },
      view: () => ({
        update(view, prev) {
          const now = analysisKey.getState(view.state);
          if (now !== analysisKey.getState(prev)) opts.onStats(now.stats, now.active);
        },
      }),
    })];
  },
});

/** Места, отмеченные подсветкой, по категориям: { adv: [{ from, to }], passive, long, repeat, filler }. */
export function analysisRanges(state) {
  const s = analysisKey.getState(state);
  return s && s.ranges ? s.ranges : emptyRanges();
}

/** Какое место показать при переходе «‹ ›»: dir > 0 следующее после позиции from, dir < 0 предыдущее; по кругу. -1: мест нет. */
export function stepIndex(list, from, dir) {
  if (!list.length) return -1;
  if (dir > 0) {
    const i = list.findIndex((r) => r.from > from);
    return i < 0 ? 0 : i;
  }
  for (let i = list.length - 1; i >= 0; i -= 1) if (list[i].from < from) return i;
  return list.length - 1;
}

/** Что подсвечено в точке экрана: [{ cat, from, to, text }]. Для пункта меню «Не отмечать здесь». */
export function analysisAt(view, x, y) {
  const at = view.posAtCoords({ left: x, top: y });
  if (!at) return [];
  const ranges = analysisRanges(view.state);
  const out = [];
  for (const cat of AN_NAV_CATS) {
    const r = ranges[cat].find((m) => at.pos >= m.from && at.pos <= m.to);
    if (r) out.push({ cat, from: r.from, to: r.to, text: view.state.doc.textBetween(r.from, r.to, '', '￼') });
  }
  return out;
}

/** Просит редактор пересчитать подсветку (после смены настроек). */
export function refreshAnalysis(editor) {
  if (!editor) return;
  editor.view.dispatch(editor.state.tr.setMeta(analysisKey, true).setMeta('addToHistory', false));
}
