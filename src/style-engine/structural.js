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

const POSSESSIVE_DET_LEMMAS = new Set(['свой', 'его', 'ее', 'их']);
const BODY_PART_NOUNS = new Set([
  'рука', 'нога', 'голова', 'глаз', 'лицо', 'волосы', 'спина', 'плечо', 'палец',
  'ладонь', 'кулак', 'шея', 'ухо', 'рот', 'нос', 'зуб', 'живот', 'колено', 'локоть',
  'бедро', 'стопа', 'запястье', 'бровь', 'ресница', 'щека', 'подбородок', 'сердце', 'кожа',
]);
const PHYSICAL_ACTION_VERBS = new Set([
  'поднимать', 'поднять', 'опускать', 'опустить', 'протягивать', 'протянуть',
  'покачивать', 'покачать', 'чесать', 'почесать', 'мыть', 'помыть', 'вытирать', 'вытереть',
  'закрывать', 'закрыть', 'открывать', 'открыть', 'поворачивать', 'повернуть',
  'наклонять', 'наклонить', 'поглаживать', 'погладить', 'ломать', 'сломать',
  'резать', 'порезать', 'бить', 'ударить', 'трогать', 'тронуть',
]);
const CONTRAST_LEMMAS = new Set(['а', 'но', 'однако', 'зато', 'чужой', 'собственный', 'именно', 'даже', 'же']);

const KNOWN_CASES = new Set(['Nom', 'Gen', 'Dat', 'Acc', 'Ins', 'Loc', 'Voc']);
const KNOWN_NUMBERS = new Set(['Sing', 'Plur']);
const KNOWN_GENDERS = new Set(['Masc', 'Fem', 'Neut', 'Com']);

const DIRECTIONAL_PLEONASMS = new Map([

  ['вернуться', new Set(['обратно'])],
  ['возвращаться', new Set(['обратно'])],
  ['подняться', new Set(['вверх', 'наверх'])],
  ['подниматься', new Set(['вверх', 'наверх'])],
  ['спуститься', new Set(['вниз'])],
  ['спускаться', new Set(['вниз'])],
  ['войти', new Set(['внутрь'])],
  ['входить', new Set(['внутрь'])],
  ['выйти', new Set(['наружу'])],
  ['выходить', new Set(['наружу'])],
  ['упасть', new Set(['вниз'])],
  ['упать', new Set(['вниз'])],
  ['падать', new Set(['вниз'])],
]);

const EXPERIENCE_VERBS = new Set(['почувствовать', 'чувствовать', 'ощутить', 'ощущать', 'испытывать']);
const EMOTION_VERBS = new Set([
  'испугаться', 'обрадоваться', 'разозлиться', 'расстроиться', 'удивиться',
  'обидеться', 'взволноваться', 'загрустить', 'разочароваться', 'смутиться',
  'встревожиться', 'возмутиться', 'восхититься', 'ужаснуться',
]);
const EMOTION_NOUNS = new Set([
  'страх', 'гнев', 'радость', 'печаль', 'тревога', 'обида', 'стыд', 'вина',
  'отвращение', 'зависть', 'нежность', 'восторг', 'ужас', 'паника', 'раздражение',
  'досада', 'грусть', 'тоска', 'смущение', 'волнение', 'удивление',
  'разочарование', 'облегчение', 'удовольствие', 'счастье', 'ярость', 'ненависть',
  'презрение', 'опасение', 'беспокойство', 'испуг', 'отчаяние',
]);
const SPEECH_VERB_LEMMAS = new Set([
  'сказать', 'говорить', 'ответить', 'отвечать', 'спросить', 'спрашивать',
  'произнести', 'проговорить', 'пробормотать', 'прошептать', 'крикнуть',
  'воскликнуть', 'добавить', 'заметить', 'возразить', 'повторить',
  'подтвердить', 'уточнить', 'перебить',
]);
const TAUTOLOGICAL_PAIRS = [
  { head: 'сувенир', dependent: 'памятный', deprel: 'amod' },
  { head: 'вакансия', dependent: 'свободный', deprel: 'amod' },
  { head: 'сотрудничество', dependent: 'взаимный', deprel: 'amod' },
  { head: 'дебют', dependent: 'первый', deprel: 'amod' },
  { head: 'приоритет', dependent: 'главный', deprel: 'amod' },
  { head: 'период', dependent: 'временной', deprel: 'amod' },
  { head: 'период', dependent: 'временный', deprel: 'amod' },
  { head: 'период', dependent: 'время', deprel: 'nmod' },
  { head: 'биография', dependent: 'жизнь', deprel: 'nmod' },
];


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
function findNounChains(text, sentence, speech = []) {
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
  // Вложенные ветви одной категории не должны давать дубли: оставляем
  // внешний (максимальный) span, частичные пересечения без вложенности — оба.
  const kept = [];
  for (const candidate of [...unique.values()].sort((a, b) => a.start - b.start || b.end - a.end)) {
    if (kept.some((outer) => outer.start <= candidate.start && outer.end >= candidate.end)) continue;
    kept.push(candidate);
  }
  return kept
    .filter((candidate) => !speech.some(([from, to]) => candidate.start < to && candidate.end > from))
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

function isPossessiveDet(token) {
  return !!token && token.upos === 'DET'
    && POSSESSIVE_DET_LEMMAS.has(lemmaOf(token))
    && (token.deprel === 'det' || token.deprel === 'nmod');
}

function hasContrastNear(tokens, start, end) {
  return tokens.some((token) => CONTRAST_LEMMAS.has(lemmaOf(token))
    && token.start < end + 24 && token.end > start - 24);
}

function hasCompletePossessiveAgreement(pronoun, noun) {
  if (!pronoun.feats || !noun.feats) return false;
  if (typeof pronoun.feats !== 'object' || typeof noun.feats !== 'object') return false;
  if (Object.keys(pronoun.feats).length === 0 || Object.keys(noun.feats).length === 0) return false;
  if (!KNOWN_CASES.has(pronoun.feats.Case) || !KNOWN_CASES.has(noun.feats.Case)) return false;
  if (!KNOWN_NUMBERS.has(pronoun.feats.Number) || !KNOWN_NUMBERS.has(noun.feats.Number)) return false;
  if (pronoun.feats.Case !== noun.feats.Case || pronoun.feats.Number !== noun.feats.Number) return false;
  const hasGender = pronoun.feats.Gender != null || noun.feats.Gender != null;
  if (hasGender) {
    if (!KNOWN_GENDERS.has(pronoun.feats.Gender) || !KNOWN_GENDERS.has(noun.feats.Gender)) return false;
    if (pronoun.feats.Gender !== noun.feats.Gender) return false;
  }
  return true;
}

function findOwn(text, sentence, speech = speechRanges(text)) {
  const tokens = Array.isArray(sentence && sentence.tokens) ? sentence.tokens : [];
  if (!tokens.length || !hasValidDependencyForest(tokens)) return [];
  const byId = tokenIndex(tokens);
  const children = childrenByHead(tokens);
  const out = [];
  const seen = new Set();
  const add = (ruleId, start, end, explanation, method) => {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > text.length) return;
    if (text.slice(start, end).length !== end - start) return;
    if (speech.some(([a, b]) => start < b && end > a)) return;
    const key = `${ruleId}:${start}:${end}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      category: 'own',
      ruleId,
      start,
      end,
      fragment: text.slice(start, end),
      explanation,
      method,
      confidence: 'low',
      limitations: [
        'Избыточность притяжательного местоимения — семантическая гипотеза; дискурсивная кореференция не устанавливается.',
        'Контраст, эмфаза, идиома и авторская интонация могут делать местоимение обязательным.',
        'Confidence не калиброван на независимом корпусе.',
      ],
    });
  };

  // 1. Два притяжательных детерминатива в одной именной группе.
  for (const noun of tokens) {
    if (!validSpan(noun, text) || noun.upos !== 'NOUN') continue;
    const possessive = (children.get(noun.id) || []).filter(isPossessiveDet);
    if (possessive.length < 2) continue;
    if (!possessive.some((t) => lemmaOf(t) === 'его')) continue;
    if (possessive.some((t) => !validSpan(t, text) || tokenInSpeech(t, speech))) continue;
    const start = Math.min(...possessive.map((t) => t.start));
    add('own.duplicate-possessive', start, noun.end,
      `В одной именной группе стоят два притяжательных определителя: «${possessive.map((t) => t.text).join('», «')}».`,
      ['dependency:det', 'morphology:possessive', 'construction:duplicate-possessive']);
  }

  // 2. Узкий случай: «свой» + телесное существительное при физическом действии
  // с локальным подлежащим-обладателем, без контраста/эмфазы/координации.
  for (const pronoun of tokens) {
    if (!validSpan(pronoun, text) || lemmaOf(pronoun) !== 'свой' || !isPossessiveDet(pronoun)) continue;
    if (tokenInSpeech(pronoun, speech)) continue;
    const noun = byId.get(pronoun.head);
    if (!noun || noun.upos !== 'NOUN' || !validSpan(noun, text) || tokenInSpeech(noun, speech)) continue;
    if (!['obj', 'obl'].includes(noun.deprel)) continue;
    if (!BODY_PART_NOUNS.has(lemmaOf(noun))) continue;
    if (noun.deprel === 'obl' && (children.get(noun.id) || []).some((c) => c.deprel === 'case')) continue;
    if (!hasCompletePossessiveAgreement(pronoun, noun)) continue;
    const verb = byId.get(noun.head);
    if (!verb || verb.upos !== 'VERB' || !PHYSICAL_ACTION_VERBS.has(lemmaOf(verb))) continue;
    if (verb.deprel !== 'root') continue; // вложенные клаузы оставляем для abstain
    const subjects = (children.get(verb.id) || []).filter((c) => c.deprel === 'nsubj' || c.deprel === 'nsubj:pass');
    if (subjects.length !== 1 || !validSpan(subjects[0], text) || tokenInSpeech(subjects[0], speech)) continue;
    if ((children.get(noun.id) || []).some((c) => c.deprel === 'conj' || c.deprel === 'amod')) continue;
    if ((children.get(noun.id) || []).some((c) => isPossessiveDet(c) && c.id !== pronoun.id)) continue;
    if (hasContrastNear(tokens, pronoun.start, noun.end)) continue;
    add('own.reflexive-body-part', pronoun.start, noun.end,
      `Возвратно-притяжательное «${pronoun.text}» при телесном существительном «${noun.text}» дублирует очевидного обладателя-подлежащее.`,
      ['dependency:det', 'dependency:nsubj', `dependency:${noun.deprel}`, 'morphology:Case', 'lexicon:body-part']);
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

function hasDegreeEmphasis(token, children) {
  if (token && token.feats && ['Cmp', 'Sup'].includes(token.feats.Degree)) return true;
  return (children.get(token.id) || []).some((c) => c.deprel === 'advmod'
    && ['самый', 'более', 'менее', 'наиболее', 'очень', 'действительно', 'поистине', 'особенно'].includes(lemmaOf(c)));
}

function findRedund(text, sentence, speech = speechRanges(text)) {
  const tokens = Array.isArray(sentence && sentence.tokens) ? sentence.tokens : [];
  if (!tokens.length || !hasValidDependencyForest(tokens)) return [];
  const children = childrenByHead(tokens);
  const out = [];
  const seen = new Set();
  const add = (ruleId, start, end, explanation, method) => {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > text.length) return;
    if (text.slice(start, end).length !== end - start) return;
    if (speech.some(([a, b]) => start < b && end > a)) return;
    const key = `${ruleId}:${start}:${end}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      category: 'redund',
      ruleId,
      start,
      end,
      fragment: text.slice(start, end),
      explanation,
      method,
      confidence: 'low',
      limitations: [
        'Избыточность установлена по узкой лексико-синтаксической паре, а не по частоте/близости.',
        'Устойчивое выражение, эмфаза и авторская интонация могут делать конструкцию намеренной.',
        'Confidence не калиброван на независимом корпусе.',
      ],
    });
  };

  for (const token of tokens) {
    if (!validSpan(token, text) || tokenInSpeech(token, speech)) continue;
    const kids = children.get(token.id) || [];

    // Направленный плеоназм: вернуться обратно, подняться вверх и т.п.
    if (token.upos === 'VERB' && DIRECTIONAL_PLEONASMS.has(lemmaOf(token))) {
      const allowed = DIRECTIONAL_PLEONASMS.get(lemmaOf(token));
      const adverb = kids.find((child) => child.deprel === 'advmod'
        && ['ADV', 'NOUN'].includes(child.upos)
        && (allowed.has(lemmaOf(child)) || allowed.has(String(child.text || '').toLowerCase().replace(/ё/g, 'е')))
        && validSpan(child, text) && !tokenInSpeech(child, speech));
      if (adverb) {
        add('redund.directional-pleonasm', Math.min(token.start, adverb.start), Math.max(token.end, adverb.end),
          `Направление уже выражено глаголом «${token.text}»; «${adverb.text}» дублирует его.`,
          [`dependency:${adverb.deprel}`, `lexicon:directional-pair:${lemmaOf(token)}+${lemmaOf(adverb)}`]);
      }
    }

    // Узкие тавтологические пары: памятный сувенир, период времени и т.п.
    if (token.upos === 'NOUN') {
      for (const pair of TAUTOLOGICAL_PAIRS) {
        if (lemmaOf(token) !== pair.head) continue;
        const dependent = kids.find((child) => child.deprel === pair.deprel
          && lemmaOf(child) === pair.dependent && validSpan(child, text) && !tokenInSpeech(child, speech));
        if (!dependent || !dependent.feats || !token.feats) continue;
        if (hasContrastNear(tokens, dependent.start, token.end)) continue;
        if (pair.deprel === 'amod' && !hasCompletePossessiveAgreement(dependent, token)) continue;
        if (pair.deprel === 'amod' && hasDegreeEmphasis(dependent, children)) continue;
        if (pair.deprel === 'nmod' && dependent.feats.Case !== 'Gen') continue;
        add('redund.tautological-pair', Math.min(token.start, dependent.start), Math.max(token.end, dependent.end),
          `«${dependent.text}» и «${token.text}» образуют устойчивую тавтологическую пару.`,
          [`dependency:${pair.deprel}`, 'lexicon:tautological-pair']);
      }
    }
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

function hasFiniteVerbForm(token) {
  return !!token && !!token.feats && token.feats.VerbForm === 'Fin';
}

function hasKnownNominalFeatures(token, requiredCase) {
  return !!token && !!token.feats
    && KNOWN_CASES.has(token.feats.Case)
    && KNOWN_NUMBERS.has(token.feats.Number)
    && (requiredCase === undefined || token.feats.Case === requiredCase);
}

function findTell(text, sentence, speech = speechRanges(text)) {
  const tokens = Array.isArray(sentence && sentence.tokens) ? sentence.tokens : [];
  if (!tokens.length || !hasValidDependencyForest(tokens)) return [];
  const children = childrenByHead(tokens);
  const out = [];
  const seen = new Set();
  const add = (ruleId, start, end, explanation, method) => {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > text.length) return;
    if (text.slice(start, end).length !== end - start) return;
    if (speech.some(([a, b]) => start < b && end > a)) return;
    const key = `${ruleId}:${start}:${end}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      category: 'tell',
      ruleId,
      start,
      end,
      fragment: text.slice(start, end),
      explanation,
      method,
      confidence: 'low',
      limitations: [
        'Прямое называние состояния — кандидат, а не доказанная стилистическая ошибка.',
        'Синтаксический разбор и ограниченные лексические классы не заменяют контекст и замысел автора.',
        'Телесные реакции, действия, метафоры и чужая речь намеренно не считаются tell.',
        'Confidence не калиброван на независимом корпусе.',
      ],
    });
  };

  for (const token of tokens) {
    if (!validSpan(token, text) || tokenInSpeech(token, speech)) continue;
    const kids = children.get(token.id) || [];

    // Прямое называние через глагол переживания + объект-эмоция.
    if (token.upos === 'VERB' && token.deprel === 'root' && EXPERIENCE_VERBS.has(lemmaOf(token))
      && hasFiniteVerbForm(token)) {
      if (kids.some((c) => !['nsubj', 'obj', 'punct'].includes(c.deprel))) continue;
      const subjects = kids.filter((c) => c.deprel === 'nsubj');
      const objects = kids.filter((c) => c.deprel === 'obj');
      if (subjects.length !== 1 || objects.length !== 1) continue;
      const subject = subjects[0];
      const emotion = objects[0];
      if (!isEmotionNoun(emotion) || !hasKnownNominalFeatures(subject, 'Nom') || !hasKnownNominalFeatures(emotion)) continue;
      if ((children.get(emotion.id) || []).some((c) => ['conj', 'acl', 'ccomp', 'xcomp'].includes(c.deprel))) continue;
      if (!validSpan(subject, text) || !validSpan(emotion, text) || tokenInSpeech(subject, speech) || tokenInSpeech(emotion, speech)) continue;
      add('tell.experience-emotion-object', Math.min(token.start, emotion.start), Math.max(token.end, emotion.end),
        `Прямое называние эмоции через «${token.text}» и объект «${emotion.text}».`,
        ['dependency:obj', 'lexicon:experience-verb', 'lexicon:emotion-noun']);
    }

    // Минимальное называние через возвратный эмоциональный глагол.
    if (token.upos === 'VERB' && token.deprel === 'root' && EMOTION_VERBS.has(lemmaOf(token))
      && hasFiniteVerbForm(token)) {
      if (kids.some((c) => !['nsubj', 'punct'].includes(c.deprel))) continue;
      const subjects = kids.filter((c) => c.deprel === 'nsubj');
      if (subjects.length !== 1) continue;
      const subject = subjects[0];
      if (!hasKnownNominalFeatures(subject, 'Nom') || !validSpan(subject, text) || tokenInSpeech(subject, speech)) continue;
      add('tell.minimal-emotion-verb', Math.min(token.start, subject.start), Math.max(token.end, subject.end),
        `Минимальное прямое называние состояния глаголом «${token.text}» с подлежащим «${subject.text}».`,
        ['dependency:nsubj', 'lexicon:emotion-verb']);
    }

    // Состояние «был в ярости»: копула + предложная эмоция.
    if (isEmotionNoun(token) && token.deprel === 'root' && hasKnownNominalFeatures(token, 'Loc')) {
      const allCases = kids.filter((c) => c.deprel === 'case');
      const cops = kids.filter((c) => c.deprel === 'cop' && ['быть', 'стать', 'казаться'].includes(lemmaOf(c)));
      const subjects = kids.filter((c) => c.deprel === 'nsubj');
      if (allCases.length !== 1 || !['в', 'во'].includes(lemmaOf(allCases[0]))) continue;
      if (cops.length !== 1 || subjects.length !== 1) continue;
      if (kids.some((c) => !['case', 'cop', 'nsubj', 'punct'].includes(c.deprel))) continue;
      if (!hasFiniteVerbForm(cops[0]) || !hasKnownNominalFeatures(subjects[0], 'Nom')) continue;
      if (!validSpan(allCases[0], text) || !validSpan(cops[0], text) || !validSpan(subjects[0], text)) continue;
      if ([allCases[0], cops[0], subjects[0]].some((t) => tokenInSpeech(t, speech))) continue;
      add('tell.emotion-state-noun', Math.min(cops[0].start, token.start), Math.max(token.end, cops[0].end),
        `Прямое называние состояния через копулу и предложное «${token.text}».`,
        ['dependency:cop', 'dependency:case', 'lexicon:emotion-noun']);
    }
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

function isEmotionNoun(token) {
  return !!token && token.upos === 'NOUN' && token.feats && Object.keys(token.feats).length > 0
    && EMOTION_NOUNS.has(lemmaOf(token));
}

function isMinimalAttribution(verb, children, text) {
  if (!verb || verb.upos !== 'VERB' || !SPEECH_VERB_LEMMAS.has(lemmaOf(verb))) return null;
  if (!verb.feats || Object.keys(verb.feats).length === 0) return null;
  const kids = children.get(verb.id) || [];
  if (kids.some((c) => !['punct', 'nsubj'].includes(c.deprel))) return null;
  const subjects = kids.filter((c) => c.deprel === 'nsubj');
  if (subjects.length !== 1) return null;
  const subject = subjects[0];
  if (!subject.feats || Object.keys(subject.feats).length === 0) return null;
  if (!validSpan(verb, text) || !validSpan(subject, text)) return null;
  return { start: Math.min(verb.start, subject.start), end: Math.max(verb.end, subject.end), verb, subject };
}

function findRemark(text, sentence, speech = speechRanges(text)) {
  const tokens = Array.isArray(sentence && sentence.tokens) ? sentence.tokens : [];
  if (!tokens.length || !speech.length || !hasValidDependencyForest(tokens)) return [];
  const children = childrenByHead(tokens);
  const attributions = [];
  for (const token of tokens) {
    if (tokenInSpeech(token, speech)) continue;
    const attribution = isMinimalAttribution(token, children, text);
    if (!attribution || tokenInSpeech(attribution.subject, speech)) continue;
    attributions.push(attribution);
  }
  if (attributions.length < 2) return [];
  attributions.sort((a, b) => a.start - b.start || a.end - b.end);
  const separator = /^[\s,.;:!?…—–-]*$/u;
  const out = [];
  const seen = new Set();
  for (let i = 0; i < attributions.length; i += 1) {
    for (let j = i + 1; j < attributions.length; j += 1) {
      const a = attributions[i];
      const b = attributions[j];
      if (lemmaOf(a.verb) !== lemmaOf(b.verb) || lemmaOf(a.subject) !== lemmaOf(b.subject)) continue;
      if (!separator.test(text.slice(a.end, b.start))) continue;
      const near = speech.some(([s, e]) => (e <= a.start && separator.test(text.slice(e, a.start)))
        || (s >= b.end && separator.test(text.slice(b.end, s))));
      if (!near) continue;
      const key = `${a.start}:${b.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        category: 'remark',
        ruleId: 'remark.duplicate-attribution',
        start: a.start,
        end: b.end,
        fragment: text.slice(a.start, b.end),
        explanation: 'Две минимальные атрибуции подряд с одинаковыми речевым глаголом и субъектом при одной реплике.',
        method: ['dependency:nsubj', 'lexicon:speech-verb', 'construction:minimal-attribution', 'direct-speech-boundary'],
        confidence: 'low',
        limitations: [
          'Повтор атрибуции может быть намеренным приёмом; finding — кандидат.',
          'Субъект сравнивается по лемме, дискурсивная кореференция не устанавливается.',
          'Ремарка с самостоятельным действием/интонацией не считается минимальной.',
          'Confidence не калиброван на независимом корпусе.',
        ],
      });
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

function findSubordinateAvalanches(text, sentence, speech = []) {
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
  return out.filter((finding) => !speech.some(([from, to]) => finding.start < to && finding.end > from))
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

/** Запускает структурные категории 4, 7 и chancery по нормализованному parse contract. */
function analyzeStructural(text, parseResult, enabled = {}) {
  const result = { chain: [], which: [], chancery: [], weak: [], own: [], redund: [], remark: [], tell: [], ruleErrors: [] };
  if (!parseResult || !Array.isArray(parseResult.sentences)) return result;
  const speech = speechRanges(text);
  const run = (category, fn) => {
    if (!enabled[category]) return;
    try {
      const findings = fn();
      if (!Array.isArray(findings)) throw new Error(`${category} rule вернул не массив.`);
      result[category].push(...findings);
    } catch (err) {
      result.ruleErrors.push({ category, error: err && err.message ? err.message : String(err) });
    }
  };
  for (const sentence of parseResult.sentences) {
    run('chain', () => findNounChains(text, sentence, speech));
    run('which', () => findSubordinateAvalanches(text, sentence, speech));
    run('chancery', () => findChancery(text, sentence, speech));
    run('weak', () => findWeak(text, sentence, speech));
    run('own', () => findOwn(text, sentence, speech));
    run('redund', () => findRedund(text, sentence, speech));
    run('remark', () => findRemark(text, sentence, speech));
    run('tell', () => findTell(text, sentence, speech));
  }
  return result;
}

module.exports = { analyzeStructural, findNounChains, findSubordinateAvalanches, findChancery, findWeak, findOwn, findRedund, findRemark, findTell };
