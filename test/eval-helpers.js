'use strict';

// Подсчёт точности (precision), полноты (recall) и F1 на размеченных примерах: наречия, страдательный залог, ритм.
// Модули кода передаются снаружи, чтобы одну и ту же разметку можно было прогнать на старой и новой версии.

const prf = (tp, fp, fn) => {
  const p = tp + fp ? tp / (tp + fp) : 1;
  const r = tp + fn ? tp / (tp + fn) : 1;
  return { tp, fp, fn, precision: p, recall: r, f1: p + r ? (2 * p * r) / (p + r) : 0 };
};

/** Разбор разметки [[наречие]] и ((спорное)): чистый текст и размеченные слова. */
function parseMarkup(line) {
  let clean = '';
  const marks = [];
  const re = /\[\[(.+?)\]\]|\(\((.+?)\)\)/gu;
  let last = 0;
  let m;
  while ((m = re.exec(line)) !== null) {
    clean += line.slice(last, m.index);
    const word = m[1] || m[2];
    marks.push({ start: clean.length, end: clean.length + word.length, word, label: m[1] ? 'adv' : 'amb' });
    clean += word;
    last = m.index + m[0].length;
  }
  clean += line.slice(last);
  return { clean, marks };
}

/** Наречия: по словам предложений. Возвращает метрики и списки ошибок. */
function evalAdverbs(morph, cases, { skipWords = null } = {}) {
  let tp = 0; let fp = 0; let fn = 0;
  const fpList = []; const fnList = []; const amb = [];
  for (const line of cases) {
    const { clean, marks } = parseMarkup(line);
    const byStart = new Map(marks.map((x) => [x.start, x]));
    for (const tok of morph.tokenize(clean)) {
      const mark = byStart.get(tok.start);
      const pred = tok.pos === 'adv';
      if (skipWords && skipWords.has(tok.text.toLowerCase().replace(/ё/g, 'е'))) continue;
      if (mark && mark.label === 'amb') { amb.push(`${tok.text}: ${tok.pos}`); continue; }
      const gold = !!mark;
      if (gold && pred) tp += 1;
      else if (gold && !pred) { fn += 1; fnList.push(`${tok.text} [${tok.pos}] «${clean}»`); }
      else if (!gold && pred) { fp += 1; fpList.push(`${tok.text} «${clean}»`); }
    }
  }
  return { ...prf(tp, fp, fn), fpList, fnList, amb };
}

/** Страдательный залог. Полнота по опорным словам, точность по найденным местам. */
function evalPassive(morph, cases) {
  let tpSpans = 0; let fpSpans = 0; let anchors = 0; let found = 0;
  const fpList = []; const fnList = []; const amb = [];
  for (const c of cases) {
    const toks = morph.tokenize(c.t);
    const spans = morph.findPassive(toks);
    const covers = (sp, a) => toks.some((w) => w.text.toLowerCase().replace(/ё/g, 'е') === a.replace(/ё/g, 'е') && w.start >= sp.start && w.end <= sp.end);
    if (c.label === 'amb') { amb.push(`${c.t} → ${spans.map((s) => c.t.slice(s.start, s.end)).join(' | ') || '—'}`); continue; }
    for (const sp of spans) {
      const ok = c.label === 'pos' && c.anchors.some((a) => covers(sp, a));
      if (ok) tpSpans += 1; else { fpSpans += 1; fpList.push(`${c.t} → ${c.t.slice(sp.start, sp.end)}`); }
    }
    for (const a of c.anchors) {
      anchors += 1;
      if (spans.some((sp) => covers(sp, a))) found += 1; else fnList.push(`${c.t} (${a})`);
    }
  }
  const p = tpSpans + fpSpans ? tpSpans / (tpSpans + fpSpans) : 1;
  const r = anchors ? found / anchors : 1;
  return { tp: found, fp: fpSpans, fn: anchors - found, precision: p, recall: r, f1: p + r ? (2 * p * r) / (p + r) : 0, fpList, fnList, amb };
}

/** Ритм: точное совпадение места (тип, с, по) и мягкое (тип и пересечение). mod: загруженный renderer/analysis.js. */
function evalRhythm(mod, makeDoc, cases) {
  let tp = 0; let fp = 0; let fn = 0; let lenientTp = 0;
  const fpList = []; const fnList = []; const amb = []; const countMismatch = [];
  for (const c of cases) {
    const paras = c.paras.map((x) => (typeof x === 'string' ? x : { text: x.h, type: 'heading' }));
    const res = mod.scanRhythm(makeDoc(paras));
    if (res.sentences.length !== c.n) countMismatch.push(`${c.id}: ждали ${c.n} предложений, получили ${res.sentences.length}`);
    const got = res.items.map((x) => [x.type, x.from, x.to]);
    const key = (x) => x.join(':');
    if (c.label === 'amb') { amb.push(`${c.id}: ждали ${JSON.stringify(c.expect)}, нашли ${JSON.stringify(got)}`); continue; }
    const want = c.expect;
    for (const g of got) {
      if (want.some((w) => key(w) === key(g))) tp += 1;
      else { fp += 1; fpList.push(`${c.id}: ${key(g)}`); }
    }
    for (const w of want) {
      if (!got.some((g) => key(g) === key(w))) {
        fn += 1; fnList.push(`${c.id}: ${key(w)}`);
        if (got.some((g) => g[0] === w[0] && g[1] <= w[2] && g[2] >= w[1])) lenientTp += 1;
      }
    }
  }
  return { ...prf(tp, fp, fn), lenientTp, fpList, fnList, amb, countMismatch };
}

const pct = (x) => `${(x * 100).toFixed(0)} %`;
const line = (m) => `P ${pct(m.precision)}  R ${pct(m.recall)}  F1 ${pct(m.f1)}  (TP ${m.tp}, FP ${m.fp}, FN ${m.fn})`;

module.exports = { prf, parseMarkup, evalAdverbs, evalPassive, evalRhythm, pct, line };
