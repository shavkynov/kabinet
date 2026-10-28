// Язык интерфейса в окне. Русский: ничего не трогаем. Английский: t() переводит строки из кода,
// а готовая разметка (index.html) и динамические узлы переводятся по словарю src/i18n-en.js.
// Данные автора (названия глав, карточек, текст) помечаются translate="no" и не переводятся.

import { createTranslator } from '../src/i18n.js';
import { termize, STORY } from '../src/terms.js';

export const LANG = (window.kabinet && window.kabinet.lang) === 'en' ? 'en' : 'ru';
export const LOCALE = LANG === 'en' ? 'en-US' : 'ru-RU';
const tr = createTranslator(LANG);

// Режим проекта «Рассказы»: слова интерфейса «глава» заменяются на «рассказ» (только в русском интерфейсе).
let termsMode = 'novel';
export function setTermsMode(mode) { termsMode = mode === 'stories' ? 'stories' : 'novel'; }
export const t = (ru, ...args) => tr(LANG === 'ru' ? termize(ru, termsMode) : ru, ...args);
/** Перевод готового текста (сообщения об ошибках); нет перевода: тот же текст. */
export const tdom = (text) => { const en = tr.dom(String(text)); return en === null ? String(text) : en; };

const ATTRS = ['title', 'placeholder', 'aria-label', 'label'];
const SKIP = 'script, style, textarea, .ProseMirror, [translate="no"]';

function translateText(node) {
  const raw = node.nodeValue;
  const trimmed = raw.trim();
  if (!trimmed || !/[А-Яа-яЁё]/.test(trimmed)) return;
  const en = tr.dom(trimmed);
  if (en === null) return;
  node.nodeValue = raw.replace(trimmed, en);
}

function translateAttrs(el) {
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (!v || !/[А-Яа-яЁё]/.test(v)) continue;
    const en = tr.dom(v);
    if (en !== null) el.setAttribute(a, en);
  }
}

function walk(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    if (node.parentElement && !node.parentElement.closest(SKIP)) translateText(node);
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE || node.closest(SKIP)) return;
  translateAttrs(node);
  node.childNodes.forEach(walk);
}

// Готовая разметка: подменяем слова при смене режима и возвращаем обратно. Исходные строки запоминаем.
const TERM_ORIG = new WeakMap();
export function applyTermsDom() {
  if (LANG !== 'ru') return;
  const stories = termsMode === 'stories';
  const swap = (orig) => {
    const key = orig.trim();
    return stories ? orig.replace(key, () => STORY[key]) : orig;
  };
  const visit = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.parentElement && node.parentElement.closest(SKIP)) return;
      let orig = TERM_ORIG.get(node);
      if (orig === undefined) {
        if (STORY[node.nodeValue.trim()] === undefined) return;
        orig = node.nodeValue;
        TERM_ORIG.set(node, orig);
      }
      node.nodeValue = swap(orig);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE || node.closest(SKIP)) return;
    let saved = TERM_ORIG.get(node);
    for (const a of ATTRS) {
      const cur = node.getAttribute(a);
      let orig = saved && saved[a];
      if (orig === undefined) {
        if (!cur || STORY[cur] === undefined) continue;
        orig = cur;
        saved = saved || {};
        saved[a] = orig;
        TERM_ORIG.set(node, saved);
      }
      node.setAttribute(a, swap(orig));
    }
    node.childNodes.forEach(visit);
  };
  visit(document.body);
}

export function initDomTranslation() {
  document.documentElement.lang = LANG;
  if (LANG !== 'en') return;
  document.title = tr.dom(document.title) || document.title;
  walk(document.body);
  // повторный перевод безвреден: в английском тексте кириллицы уже нет
  const obs = new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'characterData') walk(m.target);
      else if (m.type === 'attributes') {
        if (m.target.closest && !m.target.closest(SKIP)) translateAttrs(m.target);
      } else m.addedNodes.forEach(walk);
    }
  });
  obs.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}

// Подписи горячих клавиш: на macOS ⌘⇧T, на Windows и Linux Ctrl+Shift+T.
const IS_MAC = (window.kabinet && window.kabinet.platform) === 'darwin';
const KEY_NAMES = { '⌘': 'Ctrl', '⌃': 'Ctrl', '⌥': 'Alt', '⇧': 'Shift' };

export function platformKeys(text) {
  if (IS_MAC || typeof text !== 'string' || !/[⌘⌃⌥⇧⌫]/.test(text)) return text;
  return text
    .replace(/([⌘⌃⌥⇧]+)(-?)/g, (_m, mods, dash) => `${[...new Set([...mods].map((c) => KEY_NAMES[c]))].join('+')}${dash || '+'}`)
    .replace(/⌫/g, 'Backspace');
}

export function initKeyLabels() {
  if (IS_MAC) return;
  const attrs = ['title', 'placeholder', 'aria-label'];
  const fixNode = (node) => {
    if (node.nodeType === 3) {
      const v = platformKeys(node.nodeValue);
      if (v !== node.nodeValue) node.nodeValue = v;
      return;
    }
    if (node.nodeType !== 1) return;
    for (const a of attrs) {
      const cur = node.getAttribute(a);
      if (cur) { const v = platformKeys(cur); if (v !== cur) node.setAttribute(a, v); }
    }
    node.childNodes.forEach(fixNode);
  };
  fixNode(document.body);
  new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'characterData') fixNode(m.target);
      else if (m.type === 'attributes') fixNode(m.target);
      else m.addedNodes.forEach(fixNode);
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: attrs });
}
