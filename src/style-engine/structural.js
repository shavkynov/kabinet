'use strict';

const { speechRanges } = require('../speech');

const RELATIVE_CLAUSE = 'acl:relcl';
const WHAT_CLAUSE_RELATIONS = new Set(['ccomp', 'acl']);
const NOMINALIZATION_ENDINGS = /(?:ание|ение|яние|тие|ие|ция)$/u;
// Лексикализованные существительные с «отглагольным» суффиксом, но без процессного значения.
const NOMINALIZATION_STOP = new Set(['здание', 'мгновение', 'мнение', 'условие', 'знание', 'строение', 'воскресение', 'явление', 'событие', 'сознание', 'влияние', 'значение', 'внимание', 'ощущение', 'поведение', 'движение', 'положение', 'отношение', 'содержание', 'применение', 'изделие', 'оружие']);

const LIGHT_VERB_LEMMAS = new Set([
  'осуществлять', 'осуществить', 'проводить', 'провести', 'производить', 'произвести',
  'выполнять', 'выполнить', 'вести', 'оказывать', 'оказать', 'принимать', 'принять',
  'делать', 'сделать', 'совершать', 'совершить', 'давать', 'дать', 'издавать', 'издать',
]);
const EVENT_NOUN_LEMMAS = new Set([
  'проверка', 'анализ', 'контроль', 'помощь', 'оценка', 'подготовка', 'обработка',
  'поддержка', 'разработка', 'мероприятие', 'совещание', 'заседание', 'переговоры',
  'встреча', 'поездка', 'разведка', 'осмотр', 'обыск', 'ремонт', 'арест', 'доклад', 'отчет',
  'приказ', 'указание', 'распоряжение', 'согласование', 'исполнение', 'проведение',
  'осуществление', 'выполнение', 'формирование', 'создание', 'использование',
  'применение', 'обеспечение', 'предоставление', 'получение', 'рассмотрение',
  'утверждение', 'подписание', 'заключение', 'финансирование', 'управление',
  'координация', 'взаимодействие', 'решение', 'заявление', 'предложение',
]);
const NON_EVENT_NOUNS = new Set(['безопасность', 'документ', 'информация', 'оборудование', 'здание', 'мнение']);
const NON_PROCESS_NOUNS = new Set([...NON_EVENT_NOUNS, 'требование']);
const OFFICIAL_PREPOSITION_NOUNS = new Set([
  'цель', 'связь', 'соответствие', 'отношение', 'рамка', 'порядок', 'область',
  'процесс', 'ход', 'основание', 'результат', 'течение', 'сила', 'адрес',
]);
const EVENT_SUFFIX = /(?:ание|ение|яние|тие|ие|ция)$/u;

const WEAK_SUPPORT_VERBS = new Set([
  'иметь', 'делать', 'вести', 'носить', 'представлять', 'играть', 'оказывать',
  'производить', 'давать', 'вызывать', 'проявлять', 'привлекать', 'совершать',
]);
const WEAK_PREPOSITION_VERBS = new Set([
  'находиться', 'пользоваться', 'подвергаться', 'приходить', 'впадать',
  'пребывать', 'состоять', 'заключаться',
]);
const WEAK_VERB_SURFACE = new Set(['ведет', 'веду', 'ведешь', 'ведем', 'ведут', 'вел', 'вела', 'вело', 'вели']);
const ABSTRACT_NOUN_LEMMAS = new Set([
  'значение', 'место', 'роль', 'характер', 'возможность', 'влияние', 'впечатление',
  'сомнение', 'критика', 'популярность', 'состояние', 'восторг', 'борьба', 'ошибка',
  'вывод', 'выбор', 'решение', 'усилие', 'попытка', 'участие', 'поддержка', 'помощь',
  'польза', 'смысл', 'ценность', 'значимость', 'необходимость', 'важность', 'интерес',
  'успех', 'внимание', 'ответственность', 'инициатива', 'активность', 'деятельность',
  'развитие',
]);


function isEventNoun(token) {
  if (!token || token.upos !== 'NOUN' || !token.feats || Object.keys(token.feats).length === 0) return false;
  const lemma = lemmaOf(token);
  if (NON_EVENT_NOUNS.has(lemma)) return false;
  if (EVENT_NOUN_LEMMAS.has(lemma)) return true;
  return EVENT_SUFFIX.test(lemma) && !NOMINALIZATION_STOP.has(lemma);
}

function isProcessNoun(token) {
  return isEventNoun(token) && !NON_PROCESS_NOUNS.has(lemmaOf(token));
}

function tokenInSpeech(token, speech) {
  return speech.some(([a, b]) => token.start < b && token.end > a);
}


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

function possibleChancerySpan(text, start, end, speech) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > text.length) return false;
  if (text.slice(start, end).length !== end - start) return false;
  return !speech.some(([a, b]) => start < b && end > a);
}

function bestEventPath(root, children) {
  let best = [root];
  function walk(node, path, seen) {
    const next = (children.get(node.id) || []).filter((child) => isEventNoun(child)
      && (child.deprel === 'nmod' || child.deprel === 'nmod:poss')
      && child.feats && child.feats.Case === 'Gen'
      && !seen.has(child.id));
    if (!next.length) {
      if (path.length > best.length) best = path;
      return;
    }
    for (const child of next) {
      const nextSeen = new Set(seen);
      nextSeen.add(child.id);
      walk(child, [...path, child], nextSeen);
    }
  }
  walk(root, [root], new Set([root.id]));
  return best;
}

function findChancery(text, sentence, speech = speechRanges(text)) {
  const tokens = Array.isArray(sentence && sentence.tokens) ? sentence.tokens : [];
  if (!tokens.length || !hasValidDependencyForest(tokens)) return [];
  const byId = tokenIndex(tokens);
  const children = childrenByHead(tokens);
  const out = [];
  const seen = new Set();
  const add = (ruleId, start, end, explanation, method, confidence) => {
    if (!possibleChancerySpan(text, start, end, speech)) return;
    const key = `${ruleId}:${start}:${end}`;
    if (seen.has(key)) return;
    const finding = {
      category: 'chancery',
      ruleId,
      start,
      end,
      fragment: text.slice(start, end),
      explanation,
      method,
      confidence,
      limitations: [
        'Лексические классы/суффиксы — эвристика; контекст жанра и авторского замысла не анализируется.',
        'Термины, официальная речь персонажа и намеренная стилизация могут быть допустимы.',
        'Confidence не калиброван на независимом корпусе.',
      ],
    };
    // Для одного правила вложенный span заменяется максимальным, а не дублируется.
    const nested = out.findIndex((x) => x.ruleId === ruleId
      && ((start <= x.start && end >= x.end) || (x.start <= start && x.end >= end)));
    if (nested >= 0) {
      if (start <= out[nested].start && end >= out[nested].end) out[nested] = finding;
      return;
    }
    seen.add(key);
    out.push(finding);
  };

  for (const token of tokens) {
    if (!validSpan(token, text) || tokenInSpeech(token, speech)) continue;
    const kids = children.get(token.id) || [];

    // 1. Событийная номинализация в роли подлежащего при сказуемом.
    if (isEventNoun(token) && (token.deprel === 'nsubj' || token.deprel === 'nsubj:pass')) {
      const parent = byId.get(token.head);
      if (parent && (parent.upos === 'VERB' || parent.upos === 'AUX')) {
        const path = bestEventPath(token, children);
        if (path.length >= 2 && path.every((t) => validSpan(t, text) && !tokenInSpeech(t, speech))) {
          add('chancery.nominal-subject-cluster', path[0].start, path[path.length - 1].end,
            `Отглагольное существительное в роли подлежащего с зависимой событийной цепочкой (${path.length} элементов).`,
            ['dependency:nsubj', 'dependency:nmod', 'morphology:Case=Gen', 'derivational-or-lexical:event-noun'], 'medium');
        }
      }
    }

    // 2. Лёгкий глагол + событийное существительное.
    if (token.upos === 'VERB' && LIGHT_VERB_LEMMAS.has(lemmaOf(token))
      && token.feats && token.feats.Voice !== 'Pass' && !kids.some((c) => c.deprel === 'aux:pass')) {
      const event = kids.find((child) => ['obj', 'obl', 'nsubj'].includes(child.deprel) && isEventNoun(child));
      if (event && validSpan(event, text) && !tokenInSpeech(event, speech)) {
        add('chancery.light-verb-event-noun', Math.min(token.start, event.start), Math.max(token.end, event.end),
          `Действие выражено сочетанием лёгкого глагола «${token.text}» с событийным существительным «${event.text}».`,
          [`dependency:${event.deprel}`, 'lexicon:light-verb', 'lexicon-or-suffix:event-noun'], 'medium');
      }
    }

    // 3. Пассив без агенса + событийное существительное.
    const passive = token.upos === 'VERB' && ((token.feats && token.feats.Voice === 'Pass') || kids.some((c) => c.deprel === 'aux:pass'));
    if (passive && !kids.some((c) => c.deprel === 'obl:agent')) {
      const event = kids.find((child) => (child.deprel === 'nsubj:pass' || child.deprel === 'nsubj') && isEventNoun(child));
      if (event && validSpan(event, text) && !tokenInSpeech(event, speech)) {
        const aux = kids.find((c) => c.deprel === 'aux:pass');
        const start = Math.min(token.start, event.start, aux ? aux.start : token.start);
        const end = Math.max(token.end, event.end, aux ? aux.end : token.end);
        add('chancery.passive-event-nominal', start, end,
          `Пассивная конструкция без агенса с событийным существительным «${event.text}».`,
          ['dependency:aux:pass', 'morphology:Voice=Pass', 'dependency:nsubj:pass', 'lexicon-or-suffix:event-noun'], 'medium');
      }
    }

    // 4. Официальная предложная формула + процессное существительное.
    if (isProcessNoun(token)) {
      let ancestor = byId.get(token.head);
      const guard = new Set([token.id]);
      while (ancestor && !guard.has(ancestor.id)) {
        guard.add(ancestor.id);
        if (ancestor.upos === 'NOUN' && OFFICIAL_PREPOSITION_NOUNS.has(lemmaOf(ancestor))) {
          const caseChild = (children.get(ancestor.id) || []).find((c) => c.deprel === 'case'
            && ['в', 'во', 'с', 'со', 'на', 'по', 'при', 'из', 'от'].includes(lemmaOf(c)));
          if (caseChild && validSpan(caseChild, text) && !tokenInSpeech(caseChild, speech)) {
            add('chancery.official-preposition', caseChild.start, token.end,
              `Официальная предложная формула «${text.slice(caseChild.start, ancestor.end)}» с процессным существительным.`,
              ['dependency:case', 'lexicon:official-preposition', 'lexicon-or-suffix:event-noun'], 'low');
          }
          break;
        }
        ancestor = byId.get(ancestor.head);
      }
    }
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

function weakVerbLemma(token) {
  const lemma = lemmaOf(token);
  if (WEAK_SUPPORT_VERBS.has(lemma) || WEAK_PREPOSITION_VERBS.has(lemma)) return lemma;
  const surface = String(token.text || '').toLowerCase().replace(/ё/g, 'е');
  return WEAK_VERB_SURFACE.has(surface) ? 'вести' : lemma;
}

function isAbstractNoun(token) {
  return !!token && token.upos === 'NOUN' && token.feats && Object.keys(token.feats).length > 0
    && ABSTRACT_NOUN_LEMMAS.has(lemmaOf(token));
}

function isChanceryLightConstruction(verb, kids) {
  return LIGHT_VERB_LEMMAS.has(lemmaOf(verb))
    && kids.some((child) => ['obj', 'obl', 'nsubj'].includes(child.deprel) && isEventNoun(child));
}

function findWeak(text, sentence, speech = speechRanges(text)) {
  const tokens = Array.isArray(sentence && sentence.tokens) ? sentence.tokens : [];
  if (!tokens.length || !hasValidDependencyForest(tokens)) return [];
  const children = childrenByHead(tokens);
  const out = [];
  const seen = new Set();
  const add = (ruleId, start, end, explanation, method, confidence) => {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > text.length) return;
    if (text.slice(start, end).length !== end - start) return;
    if (speech.some(([a, b]) => start < b && end > a)) return;
    const key = `${ruleId}:${start}:${end}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      category: 'weak',
      ruleId,
      start,
      end,
      fragment: text.slice(start, end),
      explanation,
      method,
      confidence,
      limitations: [
        'Слабость глагола — структурная гипотеза, а не доказанная ошибка.',
        'Устойчивые выражения, идиомы и авторская интонация могут быть допустимы.',
        'Семантика и контекст жанра не анализируются; confidence не калиброван.',
      ],
    });
  };

  for (const token of tokens) {
    if (!validSpan(token, text) || tokenInSpeech(token, speech)) continue;
    if (token.upos !== 'VERB' || !token.feats || Object.keys(token.feats).length === 0) continue;
    if (token.feats.Voice === 'Pass') continue;
    const kids = children.get(token.id) || [];
    if (kids.some((c) => c.deprel === 'aux:pass' || c.deprel === 'cop')) continue;
    const lemma = weakVerbLemma(token);
    const direct = kids.find((child) => ['obj', 'nsubj', 'iobj'].includes(child.deprel) && isAbstractNoun(child));
    const prepared = kids.find((child) => ['obj', 'iobj', 'obl'].includes(child.deprel) && isAbstractNoun(child));

    if (WEAK_SUPPORT_VERBS.has(lemma)) {
      if (isChanceryLightConstruction(token, kids)) continue;
      const noun = direct;
      if (!noun) continue;
      const hasCase = (children.get(noun.id) || []).some((c) => c.deprel === 'case');
      add('weak.support-verb-abstract-noun', Math.min(token.start, noun.start), Math.max(token.end, noun.end),
        `Поддерживающий глагол «${token.text}» с абстрактным существительным «${noun.text}»; точное действие выражено именем, а не глаголом.`,
        [`dependency:${noun.deprel}`, 'lexicon:support-verb', 'lexicon:abstract-noun', ...(hasCase ? ['dependency:case'] : [])],
        hasCase ? 'low' : 'medium');
    } else if (WEAK_PREPOSITION_VERBS.has(lemma) && prepared) {
      const hasCase = (children.get(prepared.id) || []).some((c) => c.deprel === 'case');
      add('weak.prepositional-abstract-noun', Math.min(token.start, prepared.start), Math.max(token.end, prepared.end),
        `Глагол «${token.text}» образует описательную конструкцию с абстрактным существительным «${prepared.text}».`,
        ['dependency:obl', ...(hasCase ? ['dependency:case'] : []), 'lexicon:support-verb', 'lexicon:abstract-noun'], 'low');
    }
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
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

/** Запускает структурные категории 4, 7 и chancery по нормализованному parse contract. */
function analyzeStructural(text, parseResult, enabled = {}) {
  const result = { chain: [], which: [], chancery: [], weak: [] };
  if (!parseResult || !Array.isArray(parseResult.sentences)) return result;
  const speech = speechRanges(text);
  for (const sentence of parseResult.sentences) {
    if (enabled.chain) result.chain.push(...findNounChains(text, sentence));
    if (enabled.which) result.which.push(...findSubordinateAvalanches(text, sentence));
    if (enabled.chancery) result.chancery.push(...findChancery(text, sentence, speech));
    if (enabled.weak) result.weak.push(...findWeak(text, sentence, speech));
  }
  return result;
}

module.exports = { analyzeStructural, findNounChains, findSubordinateAvalanches, findChancery, findWeak };
