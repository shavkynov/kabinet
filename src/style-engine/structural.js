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

const MARKER_LEMMAS = new Set(['который', 'что']);
const RELATIVE_DEPRELS = new Set(['nsubj', 'obj', 'obl', 'nmod', 'det', 'iobj', 'mark']);

function lemmaOf(token) {
  return String((token && (token.lemma || token.text)) || '').toLowerCase().replace(/ё/g, 'е');
}

function isMarker(token) {
  return MARKER_LEMMAS.has(lemmaOf(token));
}

function hasRelativeMarker(root, children) {
  return (children.get(root.id) || []).some((child) => RELATIVE_DEPRELS.has(child.deprel) && isMarker(child));
}

function hasWhatMark(root, children) {
  return (children.get(root.id) || []).some((child) => child.deprel === 'mark' && lemmaOf(child) === 'что');
}

function isSubordinateClauseRoot(token, children) {
  const dependents = children.get(token.id) || [];
  const hasPredicate = token.upos === 'VERB' || token.upos === 'AUX'
    || (['ADJ', 'NOUN'].includes(token.upos) && dependents.some((child) => child.deprel === 'cop' || child.deprel === 'nsubj' || child.deprel === 'nsubj:pass'));
  if (!hasPredicate) return false;
  if (token.deprel === RELATIVE_CLAUSE) return hasRelativeMarker(token, children);
  if (!WHAT_CLAUSE_RELATIONS.has(token.deprel)) return false;
  return hasWhatMark(token, children);
}

function hasValidDependencyForest(tokens) {
  const ids = new Set();
  for (const token of tokens) {
    if (!token || !Number.isInteger(token.id) || ids.has(token.id)) return false;
    ids.add(token.id);
    if (!Number.isInteger(token.head) || token.head < 0) return false;
  }
  const byId = new Map(tokens.map((token) => [token.id, token]));
  for (const token of tokens) {
    if (token.head > 0 && !byId.has(token.head)) return false;
  }
  for (const token of tokens) {
    const seen = new Set();
    let current = token;
    while (current && current.head > 0) {
      if (seen.has(current.id)) return false;
      seen.add(current.id);
      current = byId.get(current.head);
    }
  }
  return true;
}

function clauseBounds(root, children, text) {
  if (!validSpan(root, text)) return null;
  let start = root.start;
  let end = root.end;
  const marker = (children.get(root.id) || []).find((child) => (child.deprel === 'nsubj' || child.deprel === 'mark')
    && isMarker(child));
  if (marker) {
    if (!validSpan(marker, text)) return null;
    start = marker.start;
  }
  const visited = new Set();
  const stack = [root];
  while (stack.length) {
    const token = stack.pop();
    if (!token || visited.has(token.id)) return null; // цикл/повторное ребро: abstain
    visited.add(token.id);
    if (!validSpan(token, text)) return null;
    if (token.deprel !== 'conj' && token.deprel !== 'punct') end = Math.max(end, token.end);
    for (const child of children.get(token.id) || []) stack.push(child);
  }
  return [start, end];
}

function findSubordinateAvalanches(text, sentence) {
  const tokens = Array.isArray(sentence && sentence.tokens) ? sentence.tokens : [];
  if (!tokens.length) return [];
  if (!hasValidDependencyForest(tokens)) return [];
  const byId = tokenIndex(tokens);
  const children = childrenByHead(tokens);
  const clauseIds = new Set();
  const clauseRoots = [];
  for (const token of tokens) {
    if (!validSpan(token, text) || !isSubordinateClauseRoot(token, children)) continue;
    const bounds = clauseBounds(token, children, text);
    if (!bounds) return [];
    const [start, end] = bounds;
    if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start || end > text.length) continue;
    if (text.slice(start, end).length !== end - start) continue;
    clauseIds.add(token.id);
    clauseRoots.push({ token, start, end });
  }
  if (!clauseRoots.length) return [];

  const depthMemo = new Map();
  function clauseDepth(token, visiting = new Set()) {
    if (depthMemo.has(token.id)) return depthMemo.get(token.id);
    if (visiting.has(token.id)) return null;
    const next = new Set(visiting);
    next.add(token.id);
    let parent = byId.get(token.head);
    const seen = new Set([token.id]);
    while (parent && !seen.has(parent.id) && !clauseIds.has(parent.id)) { seen.add(parent.id); parent = byId.get(parent.head); }
    if (parent && seen.has(parent.id)) return null;
    let depth = 1;
    if (parent && clauseIds.has(parent.id)) {
      const parentDepth = clauseDepth(parent, next);
      if (parentDepth === null) return null;
      depth = parentDepth + 1;
    }
    depthMemo.set(token.id, depth);
    return depth;
  }

  const clauses = [];
  for (const clause of clauseRoots) {
    const depth = clauseDepth(clause.token);
    if (depth === null) return [];
    clauses.push({ ...clause, depth });
  }
  clauses.sort((a, b) => a.start - b.start || a.end - b.end);

  // Кластеры: вложенные/пересекающиеся клаузы или клаузы, разделённые только
  // пунктуацией/пробелами. Если между клаузами есть буквы (главная часть),
  // это отдельный кластер, чтобы не захватывать лишний текст.
  const clusters = [];
  for (const clause of clauses) {
    const current = clusters[clusters.length - 1];
    const joins = current && (clause.start < current.end || /^[\s,.;:!?…—–-]*$/u.test(text.slice(current.end, clause.start)));
    if (joins) {
      current.end = Math.max(current.end, clause.end);
      current.items.push(clause);
      current.maxDepth = Math.max(current.maxDepth, clause.depth);
    } else {
      clusters.push({ start: clause.start, end: clause.end, items: [clause], maxDepth: clause.depth });
    }
  }

  const out = [];
  for (const cluster of clusters) {
    if (cluster.items.length < 3 && cluster.maxDepth < 3) continue;
    if (!Number.isInteger(cluster.start) || !Number.isInteger(cluster.end) || cluster.end <= cluster.start || cluster.end > text.length) continue;
    const fragment = text.slice(cluster.start, cluster.end);
    if (fragment.length !== cluster.end - cluster.start) continue;
    const deprels = [...new Set(cluster.items.map(({ token }) => `dependency:${token.deprel}`))];
    out.push({
      category: 'which',
      start: cluster.start,
      end: cluster.end,
      fragment,
      explanation: `Кластер из ${cluster.items.length} относительных/изъяснительных придаточных; максимальная вложенность — ${cluster.maxDepth}.`,
      method: [...deprels, 'clause-cluster', 'sentence-boundary'],
      confidence: cluster.maxDepth >= 3 && cluster.items.length >= 3 ? 'high' : 'medium',
      limitations: [
        'Зависит от UDPipe: границы и типы клауз могут быть неполными.',
        'Смешанные/эллиптические/бессоюзные клаузы могут не распознаваться.',
        'Наличие трёх маркеров не доказывает стилистическую проблему; confidence не калиброван.',
      ],
    });
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
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
