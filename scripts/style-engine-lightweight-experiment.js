'use strict';

// Сравнение старых regex-правил и экспериментальных эвристик A1/A2/B1/B2.
// Не подключается к приложению. Probe — синтетический, не независимый корпус.

const fs = require('fs');
const path = require('path');
const { findChains, scanStyle } = require('../src/style');
const { analyzeBlock } = require('../src/morph');
const { speechRanges } = require('../src/speech');
const { findChainsLight, findWhichLight } = require('../src/style-engine/lightweight');

const root = path.join(__dirname, '..');
const controlPath = process.argv[2] || '/private/tmp/control-dragon.txt';
const probePath = process.argv[3] || path.join(root, 'test/fixtures/style-engine/lightweight-probe.json');
const control = fs.readFileSync(controlPath, 'utf8');
const paragraphs = control.split(/\n/).map((s) => s.trim()).filter(Boolean);
const probe = JSON.parse(fs.readFileSync(probePath, 'utf8'));

function oldFor(text) {
  const block = analyzeBlock(text);
  return {
    chain: findChains(text, speechRanges(text)).map((h) => ({ ...h, fragment: text.slice(h.start, h.end) })),
    which: scanStyle(text, block.words, { which: true }, block.sentences).which
      .map((h) => ({ ...h, fragment: text.slice(h.start, h.end) })),
  };
}

function experimentalFor(text) {
  return {
    A1: findChainsLight(text, 'A1'),
    A2: findChainsLight(text, 'A2'),
    B1: findWhichLight(text, 'B1'),
    B2: findWhichLight(text, 'B2'),
  };
}

function controlCounts() {
  const counts = {};
  const add = (k) => { counts[k] = (counts[k] || 0) + 1; };
  for (const p of paragraphs) {
    const old = oldFor(p);
    old.chain.forEach(() => add('old_chain'));
    old.which.forEach(() => add('old_which'));
    const e = experimentalFor(p);
    e.A1.forEach(() => add('A1'));
    e.A2.forEach(() => add('A2'));
    e.B1.forEach(() => add('B1'));
    e.B2.forEach(() => add('B2'));
  }
  return counts;
}

function controlFindings() {
  const all = [];
  for (const p of paragraphs) {
    const old = oldFor(p);
    const e = experimentalFor(p);
    for (const [variant, hits] of Object.entries({ old_chain: old.chain, old_which: old.which, A1: e.A1, A2: e.A2, B1: e.B1, B2: e.B2 })) {
      for (const h of hits) all.push({ variant, fragment: h.fragment || p.slice(h.start, h.end), start: h.start, end: h.end });
    }
  }
  return all;
}

function metrics(items, variant, mode = 'exact') {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  const misses = [];
  const falseHits = [];
  for (const item of items) {
    if (item.kind === 'ambiguous') continue;
    let found;
    if (variant === 'old_chain' || variant === 'old_which') {
      const old = oldFor(item.text);
      found = variant === 'old_chain' ? old.chain : old.which;
    } else {
      found = experimentalFor(item.text)[variant];
    }
    const expected = item.expected || [];
    const used = new Set();
    for (const h of found) {
      const e = expected.findIndex((x, i) => !used.has(i) && (mode === 'exact' ? (x.start === h.start && x.end === h.end) : (x.start < h.end && x.end > h.start)));
      if (e >= 0) { tp += 1; used.add(e); } else { fp += 1; falseHits.push({ id: item.id || item.text, fragment: h.fragment || item.text.slice(h.start, h.end) }); }
    }
    expected.forEach((x, i) => { if (!used.has(i)) { fn += 1; misses.push({ id: item.id || item.text, fragment: x.text }); } });
  }
  const precision = tp + fp ? tp / (tp + fp) : null;
  const recall = tp + fn ? tp / (tp + fn) : null;
  const f1 = precision !== null && recall !== null && precision + recall ? (2 * precision * recall) / (precision + recall) : null;
  return { tp, fp, fn, precision, recall, f1, misses, falseHits };
}

function time(fn, n = 20) {
  const times = [];
  for (let i = 0; i < n; i += 1) {
    const t0 = process.hrtime.bigint();
    fn();
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  const count = times.length;
  const medianMs = count % 2 === 1
    ? times[(count - 1) / 2]
    : (times[count / 2 - 1] + times[count / 2]) / 2;
  const p95Ms = times[Math.ceil(count * 0.95) - 1];
  return { medianMs, p95Ms };
}

const oldAll = paragraphs.map((p) => {
  const b = analyzeBlock(p);
  return { chain: findChains(p, speechRanges(p)), which: scanStyle(p, b.words, { which: true }, b.sentences).which };
});
const expAll = paragraphs.map((p) => experimentalFor(p));
const joined = paragraphs.join('\n\n');

const results = {
  note: 'Probe синтетический и не является независимым корпусом; независимо подтвердить фиксацию holdout по истории Git нельзя.',
  control: {
    paragraphs: paragraphs.length,
    counts: controlCounts(),
    findings: controlFindings(),
    timing: {
      old_chain: time(() => paragraphs.forEach((p) => findChains(p, speechRanges(p)))),
      old_which: time(() => paragraphs.forEach((p) => { const b = analyzeBlock(p); scanStyle(p, b.words, { which: true }, b.sentences); })),
      A1: time(() => paragraphs.forEach((p) => findChainsLight(p, 'A1'))),
      A2: time(() => paragraphs.forEach((p) => findChainsLight(p, 'A2'))),
      B1: time(() => paragraphs.forEach((p) => findWhichLight(p, 'B1'))),
      B2: time(() => paragraphs.forEach((p) => findWhichLight(p, 'B2'))),
    },
  },
  probe: {},
};

for (const rule of ['chain', 'which']) {
  const variants = rule === 'chain' ? ['old_chain', 'A1', 'A2'] : ['old_which', 'B1', 'B2'];
  for (const group of ['dev', 'holdout']) {
    for (const kind of ['positive', 'negative', 'ambiguous']) {
      const items = probe.items.filter((x) => x.rule === rule && x.group === group && x.kind === kind);
      if (!items.length) continue;
      for (const variant of variants) {
        const key = `${rule}.${group}.${kind}.${variant}`;
        if (kind === 'ambiguous') {
          // Для ambiguous считаем только число срабатываний, не TP/FP.
          let flagged = 0;
          for (const item of items) {
            const hit = variant.startsWith('old') ? oldFor(item.text)[rule] : experimentalFor(item.text)[variant];
            if (hit.length) flagged += 1;
          }
          results.probe[key] = { items: items.length, flagged };
        } else {
          results.probe[key] = { items: items.length, ...metrics(items, variant, 'exact'), overlap: metrics(items, variant, 'overlap') };
        }
      }
    }
  }
}

console.log(JSON.stringify(results, null, 2));
