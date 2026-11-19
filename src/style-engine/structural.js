'use strict';

const { CATEGORIES } = require('./contract');

const SUBORDINATE_RELATIONS = new Set(['acl:relcl', 'ccomp', 'advcl', 'csubj', 'csubj:pass']);
const NOMINALIZATION_ENDINGS = /(?:ание|ение|яние|тие|ение|ция)$/u;

function tokenIndex(tokens) {
  const byId = new Map();
  for (const token of tokens) byId.set(token.id, token);
  return byId;
}

function childrenByHead(tokens) {
  const children = new Map();
  for (const token of tokens) {
    if (!children.has(token.head)) children.set(token.head, []);
    children.get(token.head).push(token);
  }
  return children;
}

function isGenitiveNoun(token) {
  return (token.upos === 'NOUN' || token.upos === 'PROPN')
    && token.feats && token.feats.Case === 'Gen'
    && (token.deprel === 'nmod' || token.deprel === 'nmod:poss');
}

function isNominalization(token) {
  const lemma = String(token.lemma || '').toLowerCase().replace(/ё/g, 'е');
  return token.upos === 'NOUN' && NOMINALIZATION_ENDINGS.test(lemma);
}

/**
 * Структурный поиск цепочек: требует dependency-цепь минимум из трёх существительных,
 * минимум двух генитивных связей и минимум двух морфологически/словообразовательно
 * распознаваемых отглагольных существительных. Соседство слов не используется.
 */
function findNounChains(text, sentence) {
  const tokens = sentence.tokens || [];
  const children = childrenByHead(tokens);
  const found = [];

  function walk(parent, path, seen) {
    const next = (children.get(parent.id) || [])
      .filter(isGenitiveNoun)
      .filter((child) => !seen.has(child.id));
    if (!next.length) {
      if (path.length >= 3) {
        const nominalizations = path.filter(isNominalization).length;
        const genitiveEdges = path.length - 1;
        if (genitiveEdges >= 2 && nominalizations >= 2) found.push({ path, nominalizations, genitiveEdges });
      }
      return;
    }
    for (const child of next) {
      const nextSeen = new Set(seen);
      nextSeen.add(child.id);
      walk(child, [...path, child], nextSeen);
    }
  }

  for (const token of tokens) {
    if (token.upos !== 'NOUN' && token.upos !== 'PROPN') continue;
    walk(token, [token], new Set([token.id]));
  }

  const unique = new Map();
  for (const candidate of found) {
    const start = Math.min(...candidate.path.map((t) => t.start));
    const end = Math.max(...candidate.path.map((t) => t.end));
    const key = `${start}:${end}`;
    const old = unique.get(key);
    if (!old || candidate.nominalizations > old.nominalizations) unique.set(key, candidate);
  }

  return [...unique.values()]
    .map((candidate) => {
      const start = Math.min(...candidate.path.map((t) => t.start));
      const end = Math.max(...candidate.path.map((t) => t.end));
      return {
        category: 'chain',
        start,
        end,
        fragment: text.slice(start, end),
        explanation: `Вложенная именная группа содержит ${candidate.path.length} существительных, ${candidate.genitiveEdges} генитивные связи и ${candidate.nominalizations} отглагольных существительных.`,
        method: ['dependency:nmod', 'morphology:Case=Gen', 'derivational-suffix:nominalization'],
        confidence: candidate.nominalizations >= 3 ? 'high' : 'medium',
        limitations: ['Словообразовательный суффикс — приближение; терминологические и авторские именные группы требуют проверки.'],
      };
    })
    .sort((a, b) => a.start - b.start || b.end - a.end);
}

function isSubordinateClauseRoot(token) {
  if (!SUBORDINATE_RELATIONS.has(token.deprel)) return false;
  return ['VERB', 'AUX', 'ADJ', 'NOUN'].includes(token.upos);
}

function findSubordinateAvalanches(text, sentence) {
  const tokens = sentence.tokens || [];
  const byId = tokenIndex(tokens);
  const clauseRoots = tokens.filter(isSubordinateClauseRoot);
  if (clauseRoots.length < 3) return [];

  const clauseIds = new Set(clauseRoots.map((t) => t.id));
  const depthMemo = new Map();
  function clauseDepth(token, visiting = new Set()) {
    if (depthMemo.has(token.id)) return depthMemo.get(token.id);
    if (visiting.has(token.id)) return 0;
    const next = new Set(visiting);
    next.add(token.id);
    let parent = byId.get(token.head);
    while (parent && parent.id !== token.id && !clauseIds.has(parent.id)) parent = byId.get(parent.head);
    const depth = parent && clauseIds.has(parent.id) ? clauseDepth(parent, next) + 1 : 1;
    depthMemo.set(token.id, depth);
    return depth;
  }

  const maxDepth = Math.max(...clauseRoots.map((t) => clauseDepth(t)));
  if (clauseRoots.length < 3 && maxDepth < 3) return [];

  const start = sentence.start;
  const end = sentence.end;
  return [{
    category: 'which',
    start,
    end,
    fragment: text.slice(start, end),
    explanation: `В предложении обнаружено ${clauseRoots.length} зависимых клауз; максимальная вложенность — ${maxDepth}.`,
    method: ['dependency:acl:relcl', 'dependency:ccomp', 'dependency:advcl', 'clause-nesting'],
    confidence: 'medium',
    limitations: ['Качество зависит от сегментации и синтаксического парсера; эллиптические и бессоюзные конструкции могут быть разобраны неполно.'],
  }];
}

/** Запускает структурные категории 4 и 7 по нормализованному parse contract. */
function analyzeStructural(text, parseResult, enabled = {}) {
  const result = { chain: [], which: [] };
  if (!parseResult || !Array.isArray(parseResult.sentences)) return result;
  for (const sentence of parseResult.sentences) {
    if (enabled.chain) result.chain.push(...findNounChains(text, sentence));
    if (enabled.which) result.which.push(...findSubordinateAvalanches(text, sentence));
  }
  return result;
}

module.exports = { analyzeStructural, findNounChains, findSubordinateAvalanches };
