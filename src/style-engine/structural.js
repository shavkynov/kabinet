'use strict';

const RELATIVE_CLAUSE = 'acl:relcl';
const WHAT_CLAUSE_RELATIONS = new Set(['ccomp', 'acl']);
const NOMINALIZATION_ENDINGS = /(?:ание|ение|яние|тие|ие|ция)$/u;
// Лексикализованные существительные с «отглагольным» суффиксом, но без процессного значения.
const NOMINALIZATION_STOP = new Set(['здание', 'мгновение', 'мнение', 'условие', 'знание', 'строение', 'воскресение', 'явление', 'событие', 'сознание', 'влияние', 'значение', 'внимание', 'ощущение', 'поведение', 'движение', 'положение', 'отношение', 'содержание', 'применение', 'изделие', 'оружие']);

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

function isNominalToken(token) {
  return !!token && (token.upos === 'NOUN' || token.upos === 'PROPN');
}

function isGenitiveNoun(token) {
  return isNominalToken(token)
    && token.feats && token.feats.Case === 'Gen'
    && (token.deprel === 'nmod' || token.deprel === 'nmod:poss');
}

function isNominalization(token) {
  const lemma = String(token.lemma || '').toLowerCase().replace(/ё/g, 'е');
  return token.upos === 'NOUN' && NOMINALIZATION_ENDINGS.test(lemma) && !NOMINALIZATION_STOP.has(lemma);
}

function validSpan(token, text) {
  return Number.isInteger(token.start) && Number.isInteger(token.end)
    && token.start >= 0 && token.end > token.start && token.end <= text.length
    && text.slice(token.start, token.end) === token.text;
}

/**
 * Цепочка — максимальный путь по рёбрам nmod/nmod:poss + Gen между именными
 * головами. Ветвление не склеивается: каждая ветвь даёт отдельный путь.
 * Стартуем только с головы без входящего генитивного ребра, поэтому
 * вложенные подцепочки не выдаются как отдельные findings.
 */
function findNounChains(text, sentence) {
  const tokens = Array.isArray(sentence && sentence.tokens) ? sentence.tokens : [];
  if (!tokens.length) return [];
  const byId = new Map(tokens.map((token) => [token.id, token]));
  const children = childrenByHead(tokens);
  const incoming = new Set();
  for (const token of tokens) {
    if (!isGenitiveNoun(token)) continue;
    const parent = byId.get(token.head);
    if (isNominalToken(parent)) incoming.add(token.id);
  }
  const roots = tokens.filter((token) => isNominalToken(token) && !incoming.has(token.id));
  const found = [];

  function evaluate(path) {
    if (path.length < 3) return;
    if (path.some((token) => token.upos === 'PROPN')) return; // имена/названия не считаем стилевой цепочкой
    if (path.some((token) => token.upos === 'NOUN' && NOMINALIZATION_STOP.has(String(token.lemma || '').toLowerCase().replace(/ё/g, 'е')))) return;
    const nominalizations = path.filter(isNominalization).length;
    if (nominalizations < 2) return;
    const start = Math.min(...path.map((token) => token.start));
    const end = Math.max(...path.map((token) => token.end));
    if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start || end > text.length) return;
    if (text.slice(start, end).length !== end - start) return;
    found.push({ path, nominalizations, start, end });
  }

  function walk(node, path, seen) {
    const next = (children.get(node.id) || [])
      .filter(isGenitiveNoun)
      .filter((child) => !seen.has(child.id))
      .filter((child) => validSpan(child, text));
    if (!next.length) {
      evaluate(path);
      return;
    }
    for (const child of next) {
      const nextSeen = new Set(seen);
      nextSeen.add(child.id);
      walk(child, [...path, child], nextSeen);
    }
  }

  for (const root of roots) {
    if (!validSpan(root, text)) continue;
    walk(root, [root], new Set([root.id]));
  }

  // Только точные дубли; пересекающиеся ветви не удаляем.
  const unique = new Map();
  for (const candidate of found) {
    const key = `${candidate.start}:${candidate.end}`;
    if (!unique.has(key)) unique.set(key, candidate);
  }
  return [...unique.values()]
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .map((candidate) => {
      const deprels = [...new Set(candidate.path.slice(1).map((token) => `dependency:${token.deprel}`))];
      return {
        category: 'chain',
        start: candidate.start,
        end: candidate.end,
        fragment: text.slice(candidate.start, candidate.end),
        explanation: `Потенциально тяжёлая именная цепь: ${candidate.path.length} именные головы, ${candidate.path.length - 1} генитивные связи, ${candidate.nominalizations} кандидата в отглагольные существительные.`,
        method: [...deprels, 'morphology:Case=Gen', 'derivational-suffix:nominalization'],
        // Суффикс — эвристика; без словаря/семантики high не выдаём.
        confidence: 'medium',
        limitations: [
          'Отглагольность определяется суффиксом/стоп-листом, а не словарём.',
          'Цепочка может быть термином, именем или авторской конструкцией; confidence не калиброван.',
          'Правило не доказывает стилистическую проблему, только показывает кандидата.',
        ],
      };
    });
}

function isSubordinateClauseRoot(token, children) {
  const dependents = children.get(token.id) || [];
  const hasPredicate = token.upos === 'VERB' || token.upos === 'AUX'
    || (['ADJ', 'NOUN'].includes(token.upos) && dependents.some((child) => child.deprel === 'cop' || child.deprel === 'nsubj' || child.deprel === 'nsubj:pass'));
  if (!hasPredicate) return false;
  if (token.deprel === RELATIVE_CLAUSE) return true;
  if (!WHAT_CLAUSE_RELATIONS.has(token.deprel)) return false;
  // Для «что»-клауз нужен именно союз/местоимение «что», а не любой advcl/csubj.
  return dependents.some((child) => child.deprel === 'mark' && ['что', 'который'].includes(String(child.lemma || child.text || '').toLowerCase()));
}


function clauseBounds(root, children) {
  let start = root.start;
  let end = root.end;
  const kids = children.get(root.id) || [];
  const marker = kids.find((child) => (child.deprel === 'nsubj' || child.deprel === 'mark')
    && ['который', 'что'].includes(String(child.lemma || child.text || '').toLowerCase()));
  if (marker) start = marker.start;
  const stack = [root];
  while (stack.length) {
    const token = stack.pop();
    if (token.deprel !== 'conj' && token.deprel !== 'punct') {
      end = Math.max(end, token.end);
    }
    for (const child of children.get(token.id) || []) stack.push(child);
  }
  return [start, end];
}

function findSubordinateAvalanches(text, sentence) {
  const tokens = sentence.tokens || [];
  const byId = tokenIndex(tokens);
  const children = childrenByHead(tokens);
  const clauseRoots = tokens.filter((token) => isSubordinateClauseRoot(token, children));

  const clauseIds = new Set(clauseRoots.map((t) => t.id));
  const depthMemo = new Map();
  function clauseDepth(token, visiting = new Set()) {
    if (depthMemo.has(token.id)) return depthMemo.get(token.id);
    if (visiting.has(token.id)) return 0;
    const next = new Set(visiting);
    next.add(token.id);
    let parent = byId.get(token.head);
    const seen = new Set([token.id]);
    while (parent && !seen.has(parent.id) && !clauseIds.has(parent.id)) { seen.add(parent.id); parent = byId.get(parent.head); }
    const depth = parent && clauseIds.has(parent.id) && !next.has(parent.id) ? clauseDepth(parent, next) + 1 : 1;
    depthMemo.set(token.id, depth);
    return depth;
  }

  const maxDepth = clauseRoots.length ? Math.max(...clauseRoots.map((t) => clauseDepth(t))) : 0;
  if (clauseRoots.length < 3 && maxDepth < 3) return [];

  const bounds = clauseRoots.map((root) => clauseBounds(root, children));
  const start = Math.min(...bounds.map((b) => b[0]));
  const end = Math.max(...bounds.map((b) => b[1]));
  return [{
    category: 'which',
    start,
    end,
    fragment: text.slice(start, end),
    explanation: `В предложении обнаружено ${clauseRoots.length} относительных/изъяснительных придаточных; максимальная вложенность — ${maxDepth}.`,
    method: [...new Set(clauseRoots.map((token) => `dependency:${token.deprel}`)), 'clause-nesting'],
    confidence: maxDepth >= 2 ? 'high' : 'medium',
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
