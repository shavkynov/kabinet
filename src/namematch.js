'use strict';

// Общий сопоставитель имён для подсветки в тексте (renderer/links.js) и счётчика «Встречается в главах»
// (src/mentions.js): одна регулярка из дерева префиксов вместо длинного перечисления через «|».
// С падежными формами имён вариантов становятся сотни, и обычная альтернация перебирала бы их в каждой позиции текста.

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function trieNode(node) {
  const keys = Object.keys(node).filter((k) => k !== '$').sort();
  if (!keys.length) return '';
  const parts = keys.map((k) => escapeRe(k) + trieNode(node[k]));
  if (parts.length === 1 && !node.$) return parts[0];
  return `(?:${parts.join('|')})${node.$ ? '?' : ''}`;
}

/** Исходный текст регулярки для набора строк (в нижнем регистре): строки целиком, самые длинные пробуются первыми. */
function alternation(keys) {
  const root = {};
  for (const key of keys) {
    let node = root;
    for (const ch of key) node = node[ch] || (node[ch] = {});
    node.$ = true;
  }
  return trieNode(root);
}

/** Регулярка «слово целиком, без учёта регистра» для набора имён в нижнем регистре; null, если имён нет. */
function nameRegex(keys) {
  const list = [...new Set(keys)];
  if (!list.length) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternation(list)})(?![\\p{L}\\p{N}])`, 'giu');
}

const isCapital = (s) => !!s && s[0] !== s[0].toLowerCase();

module.exports = { escapeRe, alternation, nameRegex, isCapital };
