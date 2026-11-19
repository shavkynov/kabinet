'use strict';

// Мост UDPipe → parser-neutral contract. Держит точные UTF-16 offsets исходного
// текста: CoNLL-U сам по себе даёт только формы и комментарий # text.

const { validateParseResult } = require('./contract');

function featsObject(raw) {
  const out = {};
  for (const pair of String(raw || '').split('|')) {
    const i = pair.indexOf('=');
    if (i > 0) out[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return out;
}

function blocks(conllu) {
  return String(conllu || '').split(/\r?\n\s*\r?\n/).map((b) => b.trim()).filter(Boolean);
}

function sentenceFromBlock(block, source, cursor) {
  const lines = block.split(/\r?\n/);
  const comment = lines.find((line) => line.startsWith('# text = '));
  const rawTokens = [];
  for (const line of lines) {
    if (!line || line.startsWith('#')) continue;
    const cols = line.split('\t');
    if (cols.length < 8 || !/^\d+$/.test(cols[0])) continue;
    rawTokens.push({
      id: Number(cols[0]), text: cols[1], lemma: cols[2], upos: cols[3],
      feats: featsObject(cols[5]), head: Number(cols[6]), deprel: cols[7],
    });
  }
  const sentenceText = comment ? comment.slice(9) : rawTokens.map((t) => t.text).join(' ');
  // Комментарий # text может быть нормализован парсером (лишние пробелы, U+2028),
  // поэтому границы ищем по первому токену, а не по всей строке комментария.
  const first = rawTokens[0];
  let start = first ? source.indexOf(first.text, cursor) : source.indexOf(sentenceText, cursor);
  if (start < 0) start = cursor;
  let at = start;
  for (const token of rawTokens) {
    const found = source.indexOf(token.text, at);
    token.start = found >= 0 ? found : at;
    token.end = token.start + token.text.length;
    token.confidence = null;
    at = token.end;
  }
  const end = rawTokens.length ? rawTokens[rawTokens.length - 1].end : start + sentenceText.length;
  return {
    sentence: { start, end, text: source.slice(start, end), tokens: rawTokens },
    next: end,
  };
}

/**
 * @param {string} source исходный текст абзаца (UTF-16)
 * @param {string} conllu ответ UDPipe
 * @param {{name:string,version:string}} parser
 */
function conlluToContract(source, conllu, parser = { name: 'udpipe', version: '1.4.0' }) {
  if (typeof source !== 'string') throw new TypeError('source должен быть строкой');
  let cursor = 0;
  const sentences = [];
  for (const block of blocks(conllu)) {
    const built = sentenceFromBlock(block, source, cursor);
    if (built.sentence.tokens.length) sentences.push(built.sentence);
    cursor = built.next;
  }
  const result = { schemaVersion: 1, parser, sentences };
  const checked = validateParseResult(source, result);
  if (!checked.valid) {
    throw new Error(`UDPipe → contract: ${checked.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
  }
  return result;
}

module.exports = { conlluToContract, featsObject };
