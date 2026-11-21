'use strict';

/**
 * Локальный инструмент калибровки функций Кабинета на реальных главах (.txt / .md).
 * Запускает точный продакшн-стек: StyleParser (Russian-GSD) + structural.js + style.js
 * + linguistic.js + repeatPairs + OfflineSpell (Hunspell).
 *
 * Использование:
 *   node scripts/calibrate-corpus.js <dir-or-file> [--out report.json] [--md report.md]
 *        [--lang ru|en|auto] [--no-parse] [--no-spell] [--custom-dict words.txt]
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const morph = require(path.join(root, 'src', 'morph'));
const { scanStyle } = require(path.join(root, 'src', 'style'));
const { analyzeStructural } = require(path.join(root, 'src', 'style-engine', 'structural'));
const { mapUdPos, findUdPassive, analyzeUdTenseBlock } = require(path.join(root, 'src', 'style-engine', 'linguistic'));
const { detectBase } = require(path.join(root, 'src', 'tense'));
const { repeatPairs, properFlags } = require(path.join(root, 'src', 'editing'));
const { speechRanges } = require(path.join(root, 'src', 'speech'));

const STYLE_CATS = ['chancery', 'weak', 'tell', 'chain', 'remark', 'redund', 'which', 'own'];
const HYBRID_LEXICAL_CATS = new Set(['chancery', 'weak', 'tell', 'remark', 'redund', 'own']);
const ALL_STYLE = Object.fromEntries(STYLE_CATS.map((k) => [k, true]));

function usage() {
  console.error('Использование: node scripts/calibrate-corpus.js <папка-или-файл> [--out report.json] [--md report.md] [--lang ru|en|auto] [--no-parse] [--no-spell] [--custom-dict file.txt]');
  process.exit(2);
}

function parseCli(argv) {
  const opts = {
    target: null,
    outJson: null,
    outMd: null,
    lang: 'ru',
    parse: true,
    spell: true,
    customDict: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') opts.outJson = argv[++i];
    else if (a === '--md') opts.outMd = argv[++i];
    else if (a === '--lang') opts.lang = argv[++i];
    else if (a === '--no-parse') opts.parse = false;
    else if (a === '--no-spell') opts.spell = false;
    else if (a === '--custom-dict') opts.customDict = argv[++i];
    else if (a === '--help' || a === '-h') usage();
    else if (a.startsWith('-')) { console.error(`Неизвестный флаг: ${a}`); usage(); }
    else if (!opts.target) opts.target = a;
    else { console.error(`Лишний аргумент: ${a}`); usage(); }
  }
  if (!opts.target) usage();
  if (!['ru', 'en', 'auto'].includes(opts.lang)) {
    console.error(`Неизвестный --lang: ${opts.lang}`);
    process.exit(2);
  }
  return opts;
}

function collectFiles(targetPath) {
  const abs = path.resolve(targetPath);
  if (!fs.existsSync(abs)) {
    console.error(`Путь не найден: ${abs}`);
    process.exit(1);
  }
  const st = fs.statSync(abs);
  if (st.isFile()) return [abs];
  const out = [];
  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile() && /\.(?:txt|md)$/i.test(ent.name)) out.push(full);
    }
  }
  walk(abs);
  return out;
}

function cleanMarkdownInline(s) {
  return s
    .replace(/^\s{0,3}#{1,6}\s+/u, '')
    .replace(/^\s{0,3}(?:>\s*)+/u, '')
    .replace(/!\[([^\]]*)\]\([^)]+\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, '$1')
    .replace(/`([^`]+)`/gu, '$1')
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/gu, '$2')
    .replace(/(^|[^\p{L}\p{N}])([*_])(?=\S)(.+?)(?<=\S)\2(?=[^\p{L}\p{N}]|$)/gu, '$1$3')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function splitParagraphs(rawText, ext) {
  let text = String(rawText || '').replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
  if (text.startsWith('---\n')) {
    const end = text.indexOf('\n---\n', 4);
    if (end >= 0) text = text.slice(end + 5);
  }
  const rawBlocks = text.split(/\n\s*\n+/).map((b) => b.split('\n').filter((l) => l.trim().length > 0)).filter((b) => b.length > 0);
  if (!rawBlocks.length) return [];

  const allLines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const avgLinesPerBlock = rawBlocks.reduce((s, b) => s + b.length, 0) / rawBlocks.length;
  const endPunctLines = allLines.filter((l) => /[.!?…»"”)]$/u.test(l) || /^[—–-]\s+/u.test(l)).length;
  const oneParaPerLine = avgLinesPerBlock <= 1.2 || (ext === '.txt' && allLines.length > 0 && endPunctLines / allLines.length >= 0.45) || endPunctLines / Math.max(1, allLines.length) >= 0.7;

  const linesOrBlocks = oneParaPerLine ? allLines : rawBlocks.map((b) => b.join(' '));
  const out = [];
  for (const item of linesOrBlocks) {
    if (/^\s*(?:---|\*\*\*|___)\s*$/.test(item)) continue;
    const cleaned = cleanMarkdownInline(item);
    if (cleaned.length > 0) out.push(cleaned);
  }
  return out;
}

function ensureHelperBinary() {
  const coreDir = path.join(root, 'desktop', 'core');
  const binName = process.platform === 'win32' ? 'calibrate_helper.exe' : 'calibrate_helper';
  const binPath = path.join(coreDir, 'target', 'release', 'examples', binName);
  const watchDirs = [path.join(coreDir, 'src'), path.join(coreDir, 'examples'), path.join(coreDir, 'Cargo.toml')];

  let latestSrc = 0;
  function scanMtime(p) {
    if (!fs.existsSync(p)) return;
    const st = fs.statSync(p);
    if (st.isFile()) latestSrc = Math.max(latestSrc, st.mtimeMs);
    else if (st.isDirectory()) {
      for (const e of fs.readdirSync(p)) scanMtime(path.join(p, e));
    }
  }
  for (const w of watchDirs) scanMtime(w);

  const needBuild = !fs.existsSync(binPath) || fs.statSync(binPath).mtimeMs < latestSrc;
  if (needBuild) {
    console.error('Сборка release-хелпера calibrate_helper...');
    const res = spawnSync('cargo', ['build', '--release', '--example', 'calibrate_helper', '--manifest-path', path.join(coreDir, 'Cargo.toml')], {
      cwd: root,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    if (res.status !== 0) {
      console.error('Ошибка сборки calibrate_helper');
      process.exit(1);
    }
  }
  return binPath;
}

function runHelperBatch(binPath, docs, opts) {
  return new Promise((resolve, reject) => {
    const args = ['--lang', opts.lang];
    if (!opts.parse) args.push('--no-parse');
    if (!opts.spell) args.push('--no-spell');

    const child = spawn(binPath, args, {
      cwd: root,
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    const results = new Map();
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const obj = JSON.parse(line);
        results.set(obj.id, obj);
      } catch (e) {
        reject(new Error(`Невалидный JSON от calibrate_helper: ${e.message}`));
      }
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`calibrate_helper завершился с кодом ${code}`));
      else resolve(results);
    });

    (async () => {
      for (const doc of docs) {
        const payload = JSON.stringify({
          id: doc.id,
          paragraphs: doc.paragraphs,
          customWords: doc.customWords,
        }) + '\n';
        if (!child.stdin.write(payload)) {
          await new Promise((r) => child.stdin.once('drain', r));
        }
      }
      child.stdin.end();
    })().catch(reject);
  });
}

function sentenceContext(text, start, end) {
  let s = start;
  while (s > 0 && !/[.!?…\n]/.test(text[s - 1])) s -= 1;
  while (s < start && /\s/.test(text[s])) s += 1;
  let e = end;
  while (e < text.length && !/[.!?…\n]/.test(text[e])) e += 1;
  if (e < text.length && /[.!?…]/.test(text[e])) e += 1;
  if (start - s > 90) s = start - 90;
  if (e - end > 90) e = end + 90;
  const before = text.slice(s, start).replace(/\s+/g, ' ');
  const mid = text.slice(start, end).replace(/\s+/g, ' ');
  const after = text.slice(end, e).replace(/\s+/g, ' ');
  return `${before}[[${mid}]]${after}`.trim();
}

function isSentenceStart(paraText, offset) {
  const before = paraText.slice(0, offset).replace(/[\s«„“"'(—–-]+$/u, '');
  if (before.length === 0) return true;
  const last = before[before.length - 1];
  return /[.!?…]/.test(last);
}

function addTop(map, key, example, meta = {}) {
  let rec = map.get(key);
  if (!rec) {
    rec = { key, count: 0, examples: [], meta };
    map.set(key, rec);
  }
  rec.count += 1;
  if (rec.examples.length < 5 && example && !rec.examples.includes(example)) rec.examples.push(example);
}

function analyzeDocument(doc, helperRes) {
  const joinedText = doc.paragraphs.filter((p) => p.trim().length > 0).join('\n\n');
  const parse = helperRes.parse;
  const paraStarts = helperRes.paraStarts || [];
  const docSpeech = speechRanges(joinedText);

  const findingsByCat = Object.fromEntries(STYLE_CATS.map((k) => [k, []]));
  const structuralSpansByCat = Object.fromEntries(STYLE_CATS.map((k) => [k, []]));
  const udWordDiffs = { morphTautology: 0, udTautology: 0, morphRemark: 0, udRemark: 0, tautFpRemovedWithUd: [], remarkFpRemovedWithUd: [] };

  // 1a. Structural analysis (Russian-GSD)
  if (parse && Array.isArray(parse.sentences)) {
    const struct = analyzeStructural(joinedText, parse, ALL_STYLE);
    for (const cat of STYLE_CATS) {
      for (const f of struct[cat] || []) {
        findingsByCat[cat].push({
          source: 'structural',
          ruleId: f.ruleId || `${cat}.structural`,
          start: f.start,
          end: f.end,
          fragment: f.fragment || joinedText.slice(f.start, f.end),
          tip: f.explanation || '',
          context: sentenceContext(joinedText, f.start, f.end),
        });
        structuralSpansByCat[cat].push([f.start, f.end]);
      }
    }
  }

  // Build paragraph -> UD sentences mapping & paragraph offsets
  const paraInfos = [];
  for (let i = 0; i < doc.paragraphs.length; i += 1) {
    const pStart = paraStarts[i];
    if (pStart === null || pStart === undefined) continue;
    const pText = doc.paragraphs[i];
    paraInfos.push({ idx: i, text: pText, start: pStart, end: pStart + pText.length, sents: [] });
  }
  if (parse && Array.isArray(parse.sentences) && paraInfos.length) {
    let pi = 0;
    for (const sent of parse.sentences) {
      if (!sent || !Array.isArray(sent.tokens)) continue;
      while (pi < paraInfos.length && sent.start >= paraInfos[pi].end) pi += 1;
      if (pi >= paraInfos.length) break;
      if (sent.start >= paraInfos[pi].start && sent.end <= paraInfos[pi].end) {
        paraInfos[pi].sents.push(sent);
      }
    }
  }

  // 1b. Lexical scanStyle per paragraph (hybrid mode matching renderer/analysis.js)
  let basicWordCount = 0;
  for (const p of paraInfos) {
    const morphRes = morph.analyzeBlock(p.text);
    basicWordCount += morphRes.words.length;
    let udWords = null;
    let udSents = null;
    if (p.sents.length) {
      udWords = [];
      udSents = p.sents.map((s) => ({ start: s.start - p.start, end: s.end - p.start }));
      for (const s of p.sents) {
        for (const tok of s.tokens) {
          const pos = mapUdPos(tok);
          if (!pos) continue;
          udWords.push({ start: tok.start - p.start, end: tok.end - p.start, text: tok.text, lemma: tok.lemma || '', pos, proper: tok.upos === 'PROPN' });
        }
      }
    }
    const st = scanStyle(p.text, udWords || morphRes.words, ALL_STYLE, p.sents.length ? udSents : morphRes.sentences);
    for (const cat of STYLE_CATS) {
      if (parse && !HYBRID_LEXICAL_CATS.has(cat)) continue;
      for (const h of st[cat] || []) {
        const absStart = p.start + h.start;
        const absEnd = p.start + h.end;
        if (parse && structuralSpansByCat[cat].some(([a, b]) => absStart < b && absEnd > a)) continue;
        findingsByCat[cat].push({
          source: 'lexical',
          ruleId: `${cat}.lexical`,
          start: absStart,
          end: absEnd,
          fragment: p.text.slice(h.start, h.end),
          tip: h.tip || '',
          context: sentenceContext(joinedText, absStart, absEnd),
        });
      }
    }

    // Diagnostic comparison: scanStyle with UD words vs morph words
    if (udWords) {
      const stMorph = scanStyle(p.text, morphRes.words, { redund: true, remark: true }, morphRes.sentences);
      const morphTauts = (stMorph.redund || []).filter((h) => (h.tip || '').startsWith('тавтология:'));
      const udTauts = (st.redund || []).filter((h) => (h.tip || '').startsWith('тавтология:'));
      udWordDiffs.morphTautology += morphTauts.length;
      udWordDiffs.udTautology += udTauts.length;
      for (const h of morphTauts) {
        if (!udTauts.some((u) => h.start < u.end && h.end > u.start)) {
          udWordDiffs.tautFpRemovedWithUd.push(sentenceContext(p.text, h.start, h.end));
        }
      }
      udWordDiffs.morphRemark += (stMorph.remark || []).length;
      udWordDiffs.udRemark += (st.remark || []).length;
      for (const h of stMorph.remark || []) {
        if (!(st.remark || []).some((u) => h.start < u.end && h.end > u.start)) {
          udWordDiffs.remarkFpRemovedWithUd.push(sentenceContext(p.text, h.start, h.end));
        }
      }
    }
  }

  // 2. Linguistic checks on Russian-GSD
  let udWordsCount = 0;
  const udPassive = [];
  let tensePast = 0;
  let tensePresent = 0;
  const allTenseItems = [];
  const seq = [];

  if (parse && Array.isArray(parse.sentences)) {
    for (const sent of parse.sentences) {
      for (const p of findUdPassive(sent, joinedText)) {
        udPassive.push({
          start: p.start,
          end: p.end,
          fragment: joinedText.slice(p.start, p.end),
          context: sentenceContext(joinedText, p.start, p.end),
        });
      }
    }
    for (const p of paraInfos) {
      const pWords = [];
      for (const s of p.sents) {
        for (const tok of s.tokens) {
          const pos = mapUdPos(tok);
          if (!pos) continue;
          if (pos !== 'num' && pos !== 'other') udWordsCount += 1;
          pWords.push({
            start: tok.start - p.start,
            end: tok.end - p.start,
            absStart: tok.start,
            absEnd: tok.end,
            text: tok.text,
            lemma: tok.lemma || '',
            pos,
            proper: tok.upos === 'PROPN',
          });
        }
      }
      const pSentsRel = p.sents.map((s) => ({ start: s.start - p.start, end: s.end - p.start }));
      const proper = properFlags(p.text, pWords, pSentsRel);
      pWords.forEach((w, idx) => {
        seq.push({
          text: w.text,
          lemma: w.lemma,
          pos: w.pos,
          proper: !!(w.proper || proper[idx]),
          absStart: w.absStart,
          absEnd: w.absEnd,
        });
      });

      const tb = analyzeUdTenseBlock(p.text, p.sents, p.start);
      tensePast += tb.past;
      tensePresent += tb.present;
      for (const it of tb.items) {
        allTenseItems.push({
          start: p.start + it.start,
          end: p.start + it.end,
          kind: it.kind,
          conf: it.conf,
          why: it.why,
          fragment: p.text.slice(it.start, it.end),
          context: sentenceContext(joinedText, p.start + it.start, p.start + it.end),
        });
      }
    }
  }

  const tenseBase = detectBase(tensePast, tensePresent);
  const tenseOdd = tenseBase === 'present' ? 'past' : tenseBase === 'past' ? 'present' : null;
  const udTenseOdd = allTenseItems.filter((it) => it.kind === tenseOdd);
  const udTenseHigh = udTenseOdd.filter((it) => it.conf !== 'low');
  const udTenseLow = udTenseOdd.filter((it) => it.conf === 'low');

  const repeatMarked = new Set();
  const repeatHits = [];
  if (seq.length) {
    const pairs = repeatPairs(seq, 25);
    for (const [j, i] of pairs) {
      if (!repeatMarked.has(i)) {
        repeatMarked.add(i);
        const w = seq[i];
        const prev = seq[j];
        repeatHits.push({
          start: w.absStart,
          end: w.absEnd,
          dist: i - j,
          fragment: `${prev.text} … ${w.text}`,
          lemma: w.lemma || w.text.toLowerCase(),
          context: sentenceContext(joinedText, w.absStart, w.absEnd),
        });
      }
    }
  }

  // 3. Offline Spell
  const spellCommon = [];
  const spellProper = [];
  if (Array.isArray(helperRes.spell)) {
    for (const it of helperRes.spell) {
      const pText = doc.paragraphs[it.para] || '';
      const tok = it.text || pText.slice(it.offset, it.offset + it.length);
      const firstCh = tok[0] || '';
      const startsUpper = firstCh !== firstCh.toLowerCase() && firstCh === firstCh.toUpperCase();
      const atSentStart = isSentenceStart(pText, it.offset);
      const isProperLike = startsUpper && !atSentStart && tok !== tok.toUpperCase();
      const entry = {
        word: tok,
        lower: tok.toLowerCase(),
        atSentenceStart: atSentStart,
        replacements: Array.isArray(it.replacements) ? it.replacements : [],
        context: sentenceContext(pText, it.offset, it.offset + it.length),
      };
      if (isProperLike) spellProper.push(entry);
      else spellCommon.push(entry);
    }
  }

  const wordsCount = parse ? udWordsCount : basicWordCount;
  return {
    id: doc.id,
    words: wordsCount,
    chars: joinedText.length,
    parseMs: helperRes.parseMs || 0,
    spellMs: helperRes.spellMs || 0,
    inSpeechCheck: docSpeech.length,
    style: findingsByCat,
    udWordDiffs,
    linguistic: {
      ud_passive: udPassive,
      tenseBase,
      tensePast,
      tensePresent,
      ud_tense_high: udTenseHigh,
      ud_tense_low: udTenseLow,
      repeat: repeatHits,
    },
    spell: {
      common: spellCommon,
      proper: spellProper,
    },
  };
}

function ratePer10k(count, words) {
  return words > 0 ? Number(((count * 10000) / words).toFixed(2)) : 0;
}

function aggregateCorpus(fileReports) {
  const totals = {
    files: fileReports.length,
    words: 0,
    chars: 0,
    parseMs: 0,
    spellMs: 0,
    categories: {},
    ruleBreakdown: {},
    topByCategory: {},
    udWordDiffs: { morphTautology: 0, udTautology: 0, morphRemark: 0, udRemark: 0, tautSampleRemoved: [], remarkSampleRemoved: [] },
    spellCommonTop: [],
    spellProperTop: [],
  };

  const allCats = [...STYLE_CATS, 'ud_passive', 'ud_tense_high', 'ud_tense_low', 'repeat', 'spell_common', 'spell_proper'];
  const catCounts = Object.fromEntries(allCats.map((c) => [c, 0]));
  const catMaps = Object.fromEntries(allCats.map((c) => [c, new Map()]));
  const ruleMaps = Object.fromEntries(STYLE_CATS.map((c) => [c, new Map()]));
  const spellCommonMap = new Map();
  const spellProperMap = new Map();

  for (const r of fileReports) {
    totals.words += r.words;
    totals.chars += r.chars;
    totals.parseMs += r.parseMs;
    totals.spellMs += r.spellMs;
    totals.udWordDiffs.morphTautology += r.udWordDiffs.morphTautology;
    totals.udWordDiffs.udTautology += r.udWordDiffs.udTautology;
    totals.udWordDiffs.morphRemark += r.udWordDiffs.morphRemark;
    totals.udWordDiffs.udRemark += r.udWordDiffs.udRemark;
    for (const s of r.udWordDiffs.tautFpRemovedWithUd) {
      if (totals.udWordDiffs.tautSampleRemoved.length < 20) totals.udWordDiffs.tautSampleRemoved.push(`[${r.id}] ${s}`);
    }
    for (const s of r.udWordDiffs.remarkFpRemovedWithUd) {
      if (totals.udWordDiffs.remarkSampleRemoved.length < 20) totals.udWordDiffs.remarkSampleRemoved.push(`[${r.id}] ${s}`);
    }

    for (const cat of STYLE_CATS) {
      const items = r.style[cat] || [];
      catCounts[cat] += items.length;
      for (const it of items) {
        ruleMaps[cat].set(it.ruleId, (ruleMaps[cat].get(it.ruleId) || 0) + 1);
        const key = `${it.ruleId} | ${it.fragment.toLowerCase().replace(/\s+/g, ' ')}`;
        addTop(catMaps[cat], key, `[${r.id}] ${it.context}`, { ruleId: it.ruleId, source: it.source, tip: it.tip });
      }
    }

    for (const lcat of ['ud_passive', 'ud_tense_high', 'ud_tense_low', 'repeat']) {
      const items = r.linguistic[lcat] || [];
      catCounts[lcat] += items.length;
      for (const it of items) {
        const key = (it.lemma || it.fragment).toLowerCase().replace(/\s+/g, ' ');
        addTop(catMaps[lcat], key, `[${r.id}] ${it.context}`);
      }
    }

    catCounts.spell_common += r.spell.common.length;
    for (const s of r.spell.common) {
      addTop(spellCommonMap, s.lower, `[${r.id}]${s.atSentenceStart ? ' (НАЧ.ПРЕДЛ)' : ''} ${s.context}`, { replacements: s.replacements, atSentenceStart: s.atSentenceStart });
    }
    catCounts.spell_proper += r.spell.proper.length;
    for (const s of r.spell.proper) {
      addTop(spellProperMap, s.word, `[${r.id}] ${s.context}`, { replacements: s.replacements });
    }
  }

  for (const cat of allCats) {
    totals.categories[cat] = {
      count: catCounts[cat],
      per10k: ratePer10k(catCounts[cat], totals.words),
    };
  }
  for (const cat of STYLE_CATS) {
    totals.ruleBreakdown[cat] = [...ruleMaps[cat].entries()]
      .map(([ruleId, count]) => ({ ruleId, count, per10k: ratePer10k(count, totals.words) }))
      .sort((a, b) => b.count - a.count);
    totals.topByCategory[cat] = [...catMaps[cat].values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 40);
  }
  for (const lcat of ['ud_passive', 'ud_tense_high', 'ud_tense_low', 'repeat']) {
    totals.topByCategory[lcat] = [...catMaps[lcat].values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 40);
  }
  totals.spellCommonTop = [...spellCommonMap.values()].sort((a, b) => b.count - a.count).slice(0, 80);
  totals.spellProperTop = [...spellProperMap.values()].sort((a, b) => b.count - a.count).slice(0, 40);
  totals.parseWordsPerSec = totals.parseMs > 0 ? Math.round((totals.words * 1000) / totals.parseMs) : 0;
  totals.spellWordsPerSec = totals.spellMs > 0 ? Math.round((totals.words * 1000) / totals.spellMs) : 0;
  return totals;
}

function renderMarkdown(agg, fileReports, opts) {
  const lines = [];
  lines.push(`# Отчёт калибровки: ${path.basename(path.resolve(opts.target))}`);
  lines.push('');
  lines.push(`- Файлов: **${agg.files}**, слов: **${agg.words}**, символов: **${agg.chars}**`);
  if (opts.parse) lines.push(`- Разбор Russian-GSD: **${agg.parseMs} мс** (~**${agg.parseWordsPerSec} слов/с**)`);
  if (opts.spell) lines.push(`- Офлайн-орфография: **${agg.spellMs} мс** (~**${agg.spellWordsPerSec} слов/с**)`);
  lines.push('');
  lines.push('## Сводка по категориям');
  lines.push('');
  lines.push('| Категория | Срабатываний | На 10 000 слов |');
  lines.push('|---|---:|---:|');
  for (const [cat, stat] of Object.entries(agg.categories)) {
    lines.push(`| \`${cat}\` | ${stat.count} | ${stat.per10k} |`);
  }
  lines.push('');
  lines.push('## Файлы');
  lines.push('');
  lines.push('| Файл | Слов | parse мс | spell мс | Пассив | Врем (H/L) | Повторы | Орф (common/proper) |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of fileReports) {
    lines.push(`| ${r.id} | ${r.words} | ${r.parseMs} | ${r.spellMs} | ${r.linguistic.ud_passive.length} | ${r.linguistic.ud_tense_high.length}/${r.linguistic.ud_tense_low.length} | ${r.linguistic.repeat.length} | ${r.spell.common.length}/${r.spell.proper.length} |`);
  }
  lines.push('');
  lines.push('## Диагностика: morph.js vs UD words для findTautology и findRemarks');
  lines.push('');
  lines.push(`- Тавтология (\`redund\`): morph=${agg.udWordDiffs.morphTautology}, UD=${agg.udWordDiffs.udTautology}`);
  lines.push(`- Ремарки (\`remark\`): morph=${agg.udWordDiffs.morphRemark}, UD=${agg.udWordDiffs.udRemark}`);
  if (agg.udWordDiffs.tautSampleRemoved.length) {
    lines.push('- Примеры тавтологии, которые исчезают при UD words:');
    for (const s of agg.udWordDiffs.tautSampleRemoved) lines.push(`  - ${s}`);
  }
  if (agg.udWordDiffs.remarkSampleRemoved.length) {
    lines.push('- Примеры ремарок, которые исчезают при UD words:');
    for (const s of agg.udWordDiffs.remarkSampleRemoved) lines.push(`  - ${s}`);
  }

  for (const cat of STYLE_CATS) {
    lines.push('');
    lines.push(`## Стиль: \`${cat}\` (всего ${agg.categories[cat].count}, ${agg.categories[cat].per10k} / 10k)`);
    if (agg.ruleBreakdown[cat].length) {
      lines.push('');
      lines.push('Разбивка по правилам:');
      for (const rb of agg.ruleBreakdown[cat]) {
        lines.push(`- \`${rb.ruleId}\`: ${rb.count} (${rb.per10k} / 10k)`);
      }
    }
    const top = agg.topByCategory[cat];
    if (top.length) {
      lines.push('');
      lines.push('Топ фрагментов и примеры:');
      for (const item of top) {
        lines.push(`- **${item.count}×** \`${item.key}\``);
        for (const ex of item.examples.slice(0, 2)) lines.push(`  - ${ex}`);
      }
    }
  }

  for (const lcat of ['ud_passive', 'ud_tense_high', 'ud_tense_low', 'repeat']) {
    lines.push('');
    lines.push(`## Проверка: \`${lcat}\` (всего ${agg.categories[lcat].count}, ${agg.categories[lcat].per10k} / 10k)`);
    const top = agg.topByCategory[lcat];
    if (top.length) {
      for (const item of top) {
        lines.push(`- **${item.count}×** \`${item.key}\``);
        for (const ex of item.examples.slice(0, 2)) lines.push(`  - ${ex}`);
      }
    }
  }

  if (opts.spell) {
    lines.push('');
    lines.push(`## Орфография: \`common\` (всего ${agg.categories.spell_common.count}, ${agg.categories.spell_common.per10k} / 10k)`);
    for (const s of agg.spellCommonTop) {
      const repl = s.meta && s.meta.replacements && s.meta.replacements.length ? ` → [${s.meta.replacements.join(', ')}]` : '';
      lines.push(`- **${s.count}×** \`${s.key}\`${repl}`);
      for (const ex of s.examples.slice(0, 2)) lines.push(`  - ${ex}`);
    }
    lines.push('');
    lines.push(`## Орфография: \`properLike\` (всего ${agg.categories.spell_proper.count}, ${agg.categories.spell_proper.per10k} / 10k)`);
    for (const s of agg.spellProperTop.slice(0, 25)) {
      lines.push(`- **${s.count}×** \`${s.key}\` — ${s.examples[0] || ''}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

async function main() {
  const opts = parseCli(process.argv.slice(2));
  const files = collectFiles(opts.target);
  if (!files.length) {
    console.error(`Не найдено .txt/.md файлов в ${opts.target}`);
    process.exit(1);
  }
  let customWords = [];
  if (opts.customDict) {
    customWords = fs.readFileSync(path.resolve(opts.customDict), 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }

  const baseDir = fs.statSync(path.resolve(opts.target)).isDirectory() ? path.resolve(opts.target) : path.dirname(path.resolve(opts.target));
  const docs = files.map((filePath) => {
    const raw = fs.readFileSync(filePath, 'utf8');
    const paragraphs = splitParagraphs(raw, path.extname(filePath).toLowerCase());
    return {
      id: path.relative(baseDir, filePath),
      paragraphs,
      customWords,
    };
  });

  const binPath = ensureHelperBinary();
  const helperMap = await runHelperBatch(binPath, docs, opts);

  const fileReports = docs.map((d) => analyzeDocument(d, helperMap.get(d.id) || { parseMs: 0, spellMs: 0, paraStarts: [], parse: null, spell: [] }));
  const aggregate = aggregateCorpus(fileReports);

  console.log(`\n=== Калибровка: ${path.basename(path.resolve(opts.target))} ===`);
  console.log(`Файлов: ${aggregate.files} | Слов: ${aggregate.words} | Символов: ${aggregate.chars}`);
  if (opts.parse) console.log(`Russian-GSD: ${aggregate.parseMs} мс (~${aggregate.parseWordsPerSec} слов/с)`);
  if (opts.spell) console.log(`Офлайн-орфография: ${aggregate.spellMs} мс (~${aggregate.spellWordsPerSec} слов/с)`);
  console.log('\nКатегория          Срабатываний   На 10 000 слов');
  console.log('------------------------------------------------');
  for (const [cat, stat] of Object.entries(aggregate.categories)) {
    console.log(`${cat.padEnd(18)} ${String(stat.count).padStart(12)}   ${String(stat.per10k).padStart(14)}`);
  }

  if (opts.outJson) {
    const p = path.resolve(opts.outJson);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ target: opts.target, aggregate, files: fileReports.map((f) => ({ ...f, style: undefined, linguistic: undefined, spell: undefined, counts: { ...Object.fromEntries(STYLE_CATS.map((c) => [c, f.style[c].length])), ud_passive: f.linguistic.ud_passive.length, ud_tense_high: f.linguistic.ud_tense_high.length, ud_tense_low: f.linguistic.ud_tense_low.length, repeat: f.linguistic.repeat.length, spell_common: f.spell.common.length, spell_proper: f.spell.proper.length } })) }, null, 2), 'utf8');
    console.log(`\nJSON-отчёт: ${p}`);
  }
  if (opts.outMd) {
    const p = path.resolve(opts.outMd);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, renderMarkdown(aggregate, fileReports, opts), 'utf8');
    console.log(`Markdown-отчёт: ${p}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
