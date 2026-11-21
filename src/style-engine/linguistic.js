'use strict';

// Адаптер разбора Russian-GSD (UDPipe) для функций панели «Проверка»:
// части речи, страдательный залог, повторы (по леммам и PROPN) и несогласованность времён.
// Вычисляется по уже полученному разбору без повторного запуска модели.

const { norm, NOT_AGENT_RE, STATE_PART_STEMS, REFLEXIVE_STEMS, SHORT_ADJ_WORDS } = require('../morph');
const { speechRanges } = require('../speech');
const { ATTRIB, MEMORY, isFuturePerfective } = require('../tense');

const STATE_PASSIVE_LEMMAS = new Set([
  'влюбить', 'влюбленный', 'знакомый', 'занять', 'занятый',
  'обязать', 'обязанный', 'женатый', 'удивить', 'удивленный',
  'уверить', 'уверенный', 'убедить', 'убежденный', 'растерять', 'растерянный',
  'напугать', 'напуганный', 'испугать', 'испуганный', 'встревожить', 'встревоженный',
  'одеть', 'одетый', 'устать', 'усталый', 'поразить', 'пораженный',
  'смутить', 'смущенный', 'взволновать', 'взволнованный', 'рассердить', 'рассерженный',
  'раздражить', 'раздраженный', 'огорчить', 'огорченный', 'оскорбить', 'оскорбленный',
  'обидеть', 'обиженный', 'разочаровать', 'разочарованный', 'довольный',
  'полон', 'полный', 'привычный', 'настроить', 'настроенный', 'озаботить', 'озабоченный',
  'погрузить', 'погруженный', 'поглотить', 'поглощенный', 'растрогать', 'растроганный',
  'привязать', 'привязанный', 'образовать', 'образованный', 'заострить', 'заостренный',
  'научить', 'наученный', 'возбудить', 'возбужденный', 'закрыть', 'закрытый',
  'открыть', 'открытый', 'покрыть', 'покрытый', 'окружить', 'окруженный',
  'осветить', 'освещенный', 'наполнить', 'наполненный', 'запереть', 'запертый',
  'отворить', 'отворенный', 'расстроить', 'расстроенный', 'написать', 'написанный',
  'уложить', 'уложенный',
]);

const SHORT_ADJ_PASSIVE_STOP = new Set([
  ...SHORT_ADJ_WORDS,
  'искренен', 'искренна', 'искренно', 'искренни',
  'уверен', 'уверена', 'уверено', 'уверены',
  'склонен', 'склонна', 'склонно', 'склонны',
  'достоин', 'достойна', 'достойно', 'достойны',
  'способен', 'способна', 'способно', 'способны',
  'должен', 'должна', 'должно', 'должны',
  'согласен', 'согласна', 'согласно', 'согласны',
  'полон', 'полна', 'полно', 'полны',
  'свободен', 'свободна', 'свободно', 'свободны',
  'доволен', 'довольна', 'довольно', 'довольны',
  'виновен', 'виновна', 'виновно', 'виновны',
  'благодарен', 'благодарна', 'благодарно', 'благодарны',
  'верен', 'верна', 'верно', 'верны',
  'равен', 'равна', 'равно', 'равны',
  'болен', 'больна', 'больно', 'больны',
  'виден', 'видна', 'видно', 'видны',
  'слышен', 'слышна', 'слышно', 'слышны',
  'приятен', 'приятна', 'приятно', 'приятны',
  'страшен', 'страшна', 'страшно', 'страшны',
  'громаден', 'громадна', 'громадно', 'громадны',
  'опасен', 'опасна', 'опасно', 'опасны',
  'ужасен', 'ужасна', 'ужасно', 'ужасны',
  'прекрасен', 'прекрасна', 'прекрасно', 'прекрасны',
  'интересен', 'интересна', 'интересно', 'интересны',
  'понятен', 'понятна', 'понятно', 'понятны',
  'заметен', 'заметна', 'заметно', 'заметны',
  'известен', 'известна', 'известно', 'известны',
]);

const SHORT_PASSIVE_END_RE = /(?:[аяе]н[аоы]?|[аяеиоуыюэр]т[аоы]?)$/u;
const NON_PART_ADJ_LEMMA_RE = /(?:[^н]ный|ной|ний)$/u;

const PRES_VALID_END_RE = /(?:[еиуюая]т|[еи]шь|ем|им|ете|ите|[ую])(?:ся|сь)?$/u;
const PRES_PARTICIPLE_BUGS = new Set(['одет', 'раздет', 'надет', 'согрет', 'заперт', 'прогрет', 'отпет', 'выбрит']);
const PRES_NOUN_HOMONYMS = new Set(['краем', 'путем', 'боем', 'роем', 'слоем', 'строем', 'чаем', 'лаем', 'маем', 'раем', 'паем']);
const PRES_NON_NARRATIVE = new Set([
  'нет', 'есть', 'кажется', 'думается', 'помнится', 'случается', 'бывает', 'касается',
  'признаюсь', 'знаешь', 'знаете', 'видишь', 'видите', 'понимаешь', 'понимаете',
  'скажем', 'допустим', 'предположим', 'оказывается', 'выходит', 'значит', 'разумеется',
]);
const PRES_IDIOM_KNOW_SUBJ = new Set(['черт', 'бог', 'господь', 'бес', 'леший', 'кто']);

const PERSONAL_PRS = new Set(['я', 'ты', 'он', 'она', 'мы', 'вы', 'они']);
const SUBORDINATE_DEPRELS = new Set(['ccomp', 'xcomp', 'advcl', 'acl', 'acl:relcl', 'csubj', 'csubj:pass']);
const MAIN_CHAIN_DEPRELS = new Set(['root', 'conj', 'parataxis']);

function indexTokens(tokens) {
  const byId = new Map();
  const children = new Map();
  for (const t of tokens) byId.set(t.id, t);
  for (const t of tokens) {
    if (!children.has(t.head)) children.set(t.head, []);
    children.get(t.head).push(t);
  }
  return { byId, children };
}

/** Отображает UPOS + UD feats токена в категорию Кабинета или null для пунктуации/знаков. */
function mapUdPos(token) {
  if (!token || !token.text || !/[\p{L}\p{N}]/u.test(token.text)) return null;
  const f = token.feats || {};
  switch (token.upos) {
    case 'VERB':
      return f.VerbForm === 'Part' || f.VerbForm === 'Conv' ? 'part' : 'verb';
    case 'AUX':
      return f.Mood === 'Cnd' || norm(token.text) === 'бы' || norm(token.text) === 'б' ? 'func' : 'verb';
    case 'NOUN':
    case 'PROPN':
      return 'noun';
    case 'ADJ':
      return f.VerbForm === 'Part' ? 'part' : 'adj';
    case 'ADV':
      return 'adv';
    case 'PRON':
    case 'DET':
      return 'pron';
    case 'NUM':
      return 'num';
    case 'ADP':
    case 'CCONJ':
    case 'SCONJ':
    case 'PART':
    case 'INTJ':
      return 'func';
    default:
      return 'other';
  }
}

function isPlausibleShortPassiveParticiple(token) {
  const n = norm(token.text || '');
  if (!n || n.includes('-') || SHORT_ADJ_PASSIVE_STOP.has(n)) return false;
  const lem = norm(token.lemma || '');
  if (lem && NON_PART_ADJ_LEMMA_RE.test(lem)) return false;
  return SHORT_PASSIVE_END_RE.test(n);
}

function isStatePassive(token) {
  const n = norm(token.text || '');
  if (STATE_PASSIVE_LEMMAS.has(norm(token.lemma || ''))) return true;
  return STATE_PART_STEMS.some((st) => n.startsWith(st));
}

function isNonPassiveReflexive(token) {
  const low = norm(token.text || '');
  return REFLEXIVE_STEMS.some((st) => low.startsWith(st));
}

function isIgnoredPresentVerb(token, byId, children) {
  const low = norm(token.text || '');
  if (!low || isFuturePerfective(low) || PRES_NON_NARRATIVE.has(low)) return true;
  if (!PRES_VALID_END_RE.test(low)) return true;
  if (PRES_PARTICIPLE_BUGS.has(low) || PRES_NOUN_HOMONYMS.has(low)) return true;
  const kids = children.get(token.id) || [];
  const head = byId.get(token.head);
  const prevTok = byId.get(token.id - 1);
  const nextTok = byId.get(token.id + 1);
  if (low === 'может' && (
    kids.some((c) => norm(c.text || '') === 'быть')
    || (head && norm(head.text || '') === 'быть')
    || (nextTok && norm(nextTok.text || '') === 'быть')
  )) {
    return true;
  }
  if (low === 'водится' && (
    kids.some((c) => norm(c.text || '') === 'как')
    || (prevTok && norm(prevTok.text || '') === 'как')
  )) {
    return true;
  }
  if (low === 'знает' && (
    kids.some((c) => c.deprel === 'nsubj' && PRES_IDIOM_KNOW_SUBJ.has(norm(c.text || '')))
    || (prevTok && PRES_IDIOM_KNOW_SUBJ.has(norm(prevTok.text || '')))
  )) {
    return true;
  }
  if (token.deprel === 'conj' && head && head.feats && head.feats.Mood === 'Imp' && /(?:ите|ьте)$/.test(low)) {
    return true;
  }
  return false;
}

function findAgent(kids, children) {
  return kids.find((c) => {
    if (c.deprel === 'obl:agent') return true;
    if (c.deprel !== 'obl') return false;
    const cf = c.feats || {};
    if (cf.Case !== 'Ins' || (c.upos !== 'NOUN' && c.upos !== 'PROPN')) return false;
    if ((children.get(c.id) || []).some((gc) => gc.deprel === 'case')) return false;
    return !NOT_AGENT_RE.test(norm(c.text || ''));
  });
}

function spanText(text, start, end) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > text.length) return '';
  return text.slice(start, end);
}

/** Страдательный залог по dependency-разбору одного предложения. Возвращает [{ start, end }]. */
function findUdPassive(sentence, text) {
  const tokens = Array.isArray(sentence && sentence.tokens) ? sentence.tokens : [];
  if (!tokens.length) return [];
  const { children } = indexTokens(tokens);
  const raw = [];
  const pushSpan = (start, end) => {
    if (!spanText(text, start, end)) return;
    raw.push({ start, end });
  };

  for (const token of tokens) {
    const f = token.feats || {};
    const kids = children.get(token.id) || [];

    // Аналитический пассив: «был построен», «была освещена», «будет сделано»
    if ((token.upos === 'VERB' || token.upos === 'ADJ') && f.VerbForm === 'Part' && f.Voice === 'Pass'
      && token.deprel !== 'amod') {
      if (!isPlausibleShortPassiveParticiple(token)) continue;
      const ag = findAgent(kids, children);
      if (!ag && isStatePassive(token)) continue;
      const aux = kids.find((c) => c.deprel === 'aux:pass' || (c.deprel === 'cop' && norm(c.lemma || c.text) === 'быть'));
      if (aux) {
        if (Math.abs(aux.id - token.id) <= 3) pushSpan(Math.min(aux.start, token.start), Math.max(aux.end, token.end));
        else pushSpan(token.start, token.end);
        continue;
      }
      // Краткое страдательное причастие без «быть» с творительным деятеля: «прижаты мечом»
      if (token.upos === 'VERB' && f.Variant === 'Short' && ag) {
        if (Math.abs(ag.id - token.id) <= 3) pushSpan(Math.min(token.start, ag.start), Math.max(token.end, ag.end));
        else pushSpan(token.start, token.end);
      }
      continue;
    }

    // Возвратный пассив: «дом строился рабочими»
    if (token.upos === 'VERB' && f.VerbForm === 'Fin' && /(?:ся|сь)$/i.test(token.text || '')) {
      if (isNonPassiveReflexive(token)) continue;
      const passiveSignal = f.Voice === 'Pass' || kids.some((c) => c.deprel === 'nsubj:pass' || c.deprel === 'obl:agent');
      if (!passiveSignal) continue;
      const subjects = kids.filter((c) => c.deprel === 'nsubj' || c.deprel === 'nsubj:pass');
      const hasPrsSubj = subjects.some((s) => s.upos === 'PRON' && ((s.feats && s.feats.PronType === 'Prs') || PERSONAL_PRS.has(norm(s.text || ''))));
      if (hasPrsSubj) continue;
      const ag = findAgent(kids, children);
      if (!ag) continue;
      if (Math.abs(ag.id - token.id) <= 3) pushSpan(Math.min(token.start, ag.start), Math.max(token.end, ag.end));
      else pushSpan(token.start, token.end);
    }
  }

  raw.sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  for (const sp of raw) {
    const prev = out[out.length - 1];
    if (prev && sp.start < prev.end) {
      if (sp.end > prev.end) prev.end = sp.end;
      continue;
    }
    out.push({ start: sp.start, end: sp.end });
  }
  return out;
}

function isMainClause(token, byId) {
  let cur = token;
  if (cur.deprel === 'cop' || cur.deprel === 'aux:pass' || cur.deprel === 'aux') {
    cur = byId.get(cur.head);
    if (!cur) return false;
  }
  const seen = new Set();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (SUBORDINATE_DEPRELS.has(cur.deprel)) return false;
    if (cur.head === 0 || cur.deprel === 'root') return true;
    if (!MAIN_CHAIN_DEPRELS.has(cur.deprel)) return false;
    cur = byId.get(cur.head);
  }
  return false;
}

function clauseHasConditionalParticle(token, byId, children) {
  const clauseId = token.deprel === 'cop' || token.deprel === 'aux:pass' || token.deprel === 'aux'
    ? token.head
    : token.id;
  for (const id of new Set([token.id, clauseId])) {
    const kids = children.get(id) || [];
    if (kids.some((c) => (c.feats && c.feats.Mood === 'Cnd') || norm(c.text || '') === 'бы' || norm(c.text || '') === 'б')) {
      return true;
    }
  }
  const head = byId.get(clauseId);
  return !!(head && head.feats && head.feats.Mood === 'Cnd');
}

function collectThoughtIds(sentence, sentText, segStart, inSpeech) {
  const thought = new Set();
  const tokens = Array.isArray(sentence.tokens) ? sentence.tokens : [];
  const toks = tokens.filter((t) => {
    const pos = mapUdPos(t);
    const relStart = t.start - segStart;
    return pos && pos !== 'other' && relStart >= 0 && !inSpeech(relStart);
  });

  let sep = -1;
  for (const m of sentText.matchAll(/[,—–]/g)) sep = m.index;
  if (sep >= 0) {
    const tail = toks.filter((t) => (t.start - sentence.start) > sep);
    const head = toks.filter((t) => (t.start - sentence.start) < sep);
    if (tail.length > 0 && tail.length <= 5 && tail.some((t) => ATTRIB.test(norm(t.text || '')))
      && head.length >= 2 && !head.some((t) => t.feats && t.feats.VerbForm === 'Fin' && t.feats.Tense === 'Past')) {
      head.forEach((t) => thought.add(t.id));
    }
  }

  const colon = sentText.indexOf(':');
  if (colon >= 0) {
    const before = toks.filter((t) => (t.start - sentence.start) < colon).slice(-3);
    if (before.some((t) => ATTRIB.test(norm(t.text || '')))) {
      toks.filter((t) => (t.start - sentence.start) > colon).forEach((t) => thought.add(t.id));
    }
  }
  return thought;
}

/**
 * Несогласованность времён по UDPipe-разбору предложений одного абзаца.
 * Возвращает { past, present, items: [{ start, end, kind, conf, why }] }, offsets относительно blockText.
 */
function analyzeUdTenseBlock(blockText, sentences, segStart = 0) {
  const speech = speechRanges(blockText);
  const inSpeech = (relPos) => speech.some(([a, b]) => relPos >= a && relPos < b);
  const res = { past: 0, present: 0, items: [] };
  let scope = false;

  for (const sent of sentences) {
    const tokens = Array.isArray(sent && sent.tokens) ? sent.tokens : [];
    if (!tokens.length) continue;
    const sStart = Math.max(0, sent.start - segStart);
    const sEnd = Math.min(blockText.length, sent.end - segStart);
    const sentText = blockText.slice(sStart, sEnd);

    const { byId, children } = indexTokens(tokens);
    const mem = MEMORY.test(norm(sentText));
    const hasPresentNarrative = tokens.some((t) => {
      const f = t.feats || {};
      const relStart = t.start - segStart;
      return !inSpeech(relStart) && (t.upos === 'VERB' || t.upos === 'AUX')
        && f.VerbForm === 'Fin' && f.Tense === 'Pres' && f.Aspect !== 'Perf'
        && !isIgnoredPresentVerb(t, byId, children);
    });
    const inMem = mem || (scope && !hasPresentNarrative);
    scope = inMem;
    if (inMem) continue;

    const thought = collectThoughtIds(sent, sentText, segStart, inSpeech);

    const actor = tokens.some((t) => {
      const relStart = t.start - segStart;
      if (inSpeech(relStart) || thought.has(t.id)) return false;
      if (t.deprel !== 'nsubj' && t.deprel !== 'nsubj:pass') return false;
      if (!isMainClause(t, byId)) return false;
      return t.upos === 'PROPN' || (t.feats && t.feats.PronType === 'Prs') || PERSONAL_PRS.has(norm(t.text || ''));
    });

    const verbs = [];
    for (const token of tokens) {
      const relStart = token.start - segStart;
      if (relStart < 0 || token.end - segStart > blockText.length || inSpeech(relStart) || thought.has(token.id)) continue;
      if (token.upos !== 'VERB' && token.upos !== 'AUX') continue;
      const f = token.feats || {};
      if (f.VerbForm !== 'Fin') continue;
      if (f.Mood === 'Imp' || f.Mood === 'Cnd') continue;
      if (clauseHasConditionalParticle(token, byId, children)) continue;
      if (token.upos === 'AUX') {
        if (f.Tense === 'Fut') continue;
        const head = byId.get(token.head);
        if (token.deprel === 'aux' && head && head.feats && head.feats.VerbForm === 'Inf') continue;
      }
      if (!isMainClause(token, byId)) continue;

      let kind = null;
      if (f.Tense === 'Past') kind = 'past';
      else if (f.Tense === 'Pres' && f.Aspect !== 'Perf' && !isIgnoredPresentVerb(token, byId, children)) kind = 'present';
      if (!kind) continue;
      verbs.push({ token, kind });
    }

    for (const v of verbs) {
      if (v.kind === 'present') res.present += 1; else res.past += 1;
      const mixed = verbs.some((o) => o.kind !== v.kind);
      const why = mixed ? 'mixed' : actor ? 'actor' : 'description';
      res.items.push({
        start: v.token.start - segStart,
        end: v.token.end - segStart,
        kind: v.kind,
        conf: why === 'description' ? 'low' : 'high',
        why,
      });
    }
  }
  return res;
}

function mapSpan(seg, doc, absStart, absEnd, expectedText) {
  const start = absStart - seg.parserStart;
  const end = absEnd - seg.parserStart;
  if (start < 0 || end <= start || end > seg.charMap.length) return null;
  for (let i = start; i < end; i += 1) if (seg.charMap[i] < 0) return null;
  const from = seg.charMap[start];
  const to = seg.charMap[end - 1] + 1;
  if (!Number.isInteger(from) || from < 0 || to <= from || to > doc.content.size) return null;
  if (expectedText !== undefined && doc.textBetween(from, to, '', '') !== expectedText) return null;
  return { start, end, from, to };
}

/**
 * Отображает полный разбор документа в Map: base (pmStart) -> { words, passive, tense }.
 * Возвращает null при несовпадении документа (fail closed).
 */
function buildLinguisticBlocks(snapshot, parse, currentDoc) {
  if (!snapshot || !Array.isArray(snapshot.segments) || !parse || !Array.isArray(parse.sentences) || !currentDoc) return null;
  const sameDoc = typeof snapshot.doc.eq === 'function' ? snapshot.doc.eq(currentDoc) : snapshot.doc === currentDoc;
  if (!sameDoc) return null;

  const blocks = new Map();
  for (const seg of snapshot.segments) {
    if (!seg.analyzable || seg.parserEnd <= seg.parserStart) continue;
    const sents = parse.sentences.filter((s) => s && Array.isArray(s.tokens)
      && s.start >= seg.parserStart && s.end <= seg.parserEnd);
    if (!sents.length) continue;

    const words = [];
    const passive = [];
    for (const sent of sents) {
      for (const tok of sent.tokens) {
        const pos = mapUdPos(tok);
        if (!pos) continue;
        const m = mapSpan(seg, currentDoc, tok.start, tok.end, tok.text);
        if (!m) continue;
        words.push({
          ...m,
          text: tok.text,
          lemma: tok.lemma || '',
          pos,
          proper: tok.upos === 'PROPN',
        });
      }
      for (const p of findUdPassive(sent, snapshot.text)) {
        const expected = snapshot.text.slice(p.start, p.end);
        const m = mapSpan(seg, currentDoc, p.start, p.end, expected);
        if (!m) continue;
        passive.push({ ...m, text: expected });
      }
    }

    const rawTense = analyzeUdTenseBlock(seg.text, sents, seg.parserStart);
    const tenseItems = [];
    for (const it of rawTense.items) {
      const absStart = seg.parserStart + it.start;
      const absEnd = seg.parserStart + it.end;
      const expected = seg.text.slice(it.start, it.end);
      const m = mapSpan(seg, currentDoc, absStart, absEnd, expected);
      if (!m) continue;
      tenseItems.push({ ...m, kind: it.kind, conf: it.conf, why: it.why });
    }

    blocks.set(seg.pmStart, {
      words,
      passive,
      tense: { past: rawTense.past, present: rawTense.present, items: tenseItems },
    });
  }
  return blocks;
}

module.exports = { mapUdPos, findUdPassive, analyzeUdTenseBlock, buildLinguisticBlocks };
