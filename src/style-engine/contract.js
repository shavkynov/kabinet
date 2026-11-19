'use strict';

const CATEGORIES = Object.freeze([
  'chancery', 'weak', 'tell', 'chain', 'remark', 'redund', 'which', 'own',
]);

const CONFIDENCE = new Set(['high', 'medium', 'low']);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isInt = (value) => Number.isInteger(value);

/**
 * Переводит offset в Unicode code points в offset JavaScript/ProseMirror UTF-16.
 * Python-модели обычно считают code points, тогда как JS String.length считает UTF-16 units.
 */
function codePointOffsetToUtf16(text, offset) {
  if (typeof text !== 'string' || !isInt(offset) || offset < 0) {
    throw new TypeError('text должен быть строкой, offset — неотрицательным целым числом');
  }
  let points = 0;
  let units = 0;
  for (const char of text) {
    if (points === offset) return units;
    points += 1;
    units += char.length;
  }
  if (points === offset) return units;
  throw new RangeError('offset выходит за границы строки');
}

function validateParseResult(text, result) {
  const errors = [];
  const fail = (path, message) => errors.push({ path, message });
  if (typeof text !== 'string') return { valid: false, errors: [{ path: 'text', message: 'ожидалась строка' }] };
  if (!isObject(result)) return { valid: false, errors: [{ path: 'result', message: 'ожидался объект' }] };
  if (result.schemaVersion !== 1) fail('schemaVersion', 'поддерживается только версия 1');
  if (!Array.isArray(result.sentences)) fail('sentences', 'ожидался массив предложений');
  if (!isObject(result.parser) || typeof result.parser.name !== 'string' || !result.parser.name || typeof result.parser.version !== 'string' || !result.parser.version) {
    fail('parser', 'необходимы parser.name и parser.version');
  }
  if (!Array.isArray(result.sentences)) return { valid: errors.length === 0, errors };

  let previousSentenceEnd = 0;
  result.sentences.forEach((sentence, si) => {
    const sp = `sentences[${si}]`;
    if (!isObject(sentence)) { fail(sp, 'ожидался объект'); return; }
    if (!isInt(sentence.start) || !isInt(sentence.end) || sentence.start < 0 || sentence.end <= sentence.start || sentence.end > text.length) {
      fail(sp, 'некорректный UTF-16 диапазон предложения');
      return;
    }
    if (sentence.start < previousSentenceEnd) fail(sp, 'предложения пересекаются или идут не по порядку');
    previousSentenceEnd = sentence.end;
    if (typeof sentence.text !== 'string' || text.slice(sentence.start, sentence.end) !== sentence.text) {
      fail(`${sp}.text`, 'текст не совпадает с исходной строкой по UTF-16 offsets');
    }
    if (!Array.isArray(sentence.tokens)) { fail(`${sp}.tokens`, 'ожидался массив токенов'); return; }
    const tokens = sentence.tokens;
    const ids = new Set();
    tokens.forEach((token, ti) => {
      const tp = `${sp}.tokens[${ti}]`;
      if (!isObject(token)) { fail(tp, 'ожидался объект'); return; }
      if (!isInt(token.id) || token.id < 1 || ids.has(token.id)) fail(`${tp}.id`, 'id должен быть уникальным положительным целым числом');
      else ids.add(token.id);
      if (!isInt(token.start) || !isInt(token.end) || token.start < sentence.start || token.end <= token.start || token.end > sentence.end) {
        fail(tp, 'некорректный UTF-16 диапазон токена');
      } else if (text.slice(token.start, token.end) !== token.text) {
        fail(`${tp}.text`, 'текст токена не совпадает с исходной строкой по offsets');
      }
      if (typeof token.text !== 'string' || !token.text) fail(`${tp}.text`, 'текст токена обязателен');
      if (typeof token.lemma !== 'string' || !token.lemma) fail(`${tp}.lemma`, 'лемма обязательна');
      if (typeof token.upos !== 'string' || !token.upos) fail(`${tp}.upos`, 'UPOS обязателен');
      if (!isObject(token.feats)) fail(`${tp}.feats`, 'feats должен быть объектом (пустой объект допустим)');
      if (!isInt(token.head) || token.head < 0 || token.head > tokens.length || token.head === token.id) {
        fail(`${tp}.head`, 'head должен быть 0 (root) или id другого токена этого предложения');
      }
      if (typeof token.deprel !== 'string' || !token.deprel) fail(`${tp}.deprel`, 'deprel обязателен');
      if (token.confidence !== null && token.confidence !== undefined && (typeof token.confidence !== 'number' || token.confidence < 0 || token.confidence > 1)) {
        fail(`${tp}.confidence`, 'confidence должен быть null или числом от 0 до 1');
      }
    });
    for (const token of tokens) {
      if (isInt(token.head) && token.head > 0 && !ids.has(token.head)) fail(`${sp}.tokens[${token.id}].head`, 'ссылка head указывает на отсутствующий token id');
    }
  });
  return { valid: errors.length === 0, errors };
}

function validateFinding(text, finding) {
  if (typeof text !== 'string') return { valid: false, errors: [{ path: 'text', message: 'ожидалась строка' }] };
  const errors = [];
  const fail = (path, message) => errors.push({ path, message });
  if (typeof text !== 'string') fail('text', 'ожидалась строка');
  if (!isObject(finding)) return { valid: false, errors: [{ path: 'finding', message: 'ожидался объект' }] };
  if (!CATEGORIES.includes(finding.category)) fail('category', 'неизвестная категория');
  if (!isInt(finding.start) || !isInt(finding.end) || finding.start < 0 || finding.end <= finding.start || finding.end > text.length) {
    fail('range', 'некорректный UTF-16 диапазон результата');
  } else if (finding.fragment !== text.slice(finding.start, finding.end)) {
    fail('fragment', 'fragment не совпадает с исходным текстом по offsets');
  }
  if (typeof finding.explanation !== 'string' || !finding.explanation.trim()) fail('explanation', 'объяснение обязательно');
  if (!Array.isArray(finding.method) || finding.method.length === 0 || finding.method.some((x) => typeof x !== 'string' || !x.trim())) {
    fail('method', 'нужен непустой список реально использованных методов');
  }
  if (!CONFIDENCE.has(finding.confidence)) fail('confidence', 'confidence должен быть high, medium или low');
  if (!Array.isArray(finding.limitations) || finding.limitations.some((x) => typeof x !== 'string')) {
    fail('limitations', 'limitations должен быть массивом строк');
  }
  return { valid: errors.length === 0, errors };
}

module.exports = { CATEGORIES, codePointOffsetToUtf16, validateParseResult, validateFinding };
