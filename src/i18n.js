'use strict';

// Переводы интерфейса. Исходный язык строк в коде русский: t('Русская строка') возвращает её же,
// а для английского ищет перевод в src/i18n-en.js. Значения подставляются в {0}, {1}.
// Нет перевода: показывается русская строка (интерфейс не ломается).
// Общий модуль: им пользуются и главный процесс, и окно (esbuild включает его в сборку окна).

const EN = require('./i18n-en');

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function format(str, args) {
  if (!args.length) return String(str);
  return String(str).replace(/\{(\d+)\}/g, (m, i) => (args[i] !== undefined ? String(args[i]) : m));
}

// Ключи с {0} превращаем в шаблоны: ими переводятся готовые строки, у которых значения уже подставлены.
function compilePatterns(dict) {
  const out = [];
  for (const [ru, en] of Object.entries(dict)) {
    const slots = [...ru.matchAll(/\{(\d+)\}/g)].map((m) => Number(m[1]));
    if (!slots.length) continue;
    const literal = ru.split(/\{\d+\}/);
    const re = new RegExp(`^${literal.map(escapeRe).join('([\\s\\S]+?)')}$`);
    out.push({ re, slots, en, weight: literal.join('').length });
  }
  return out.sort((a, b) => b.weight - a.weight);
}

function createTranslator(lang, dict = EN) {
  const english = lang === 'en';
  const patterns = english ? compilePatterns(dict) : [];

  const t = (ru, ...args) => {
    if (!english) return format(ru, args);
    const hit = dict[ru];
    return format(hit !== undefined ? hit : ru, args);
  };

  /** Перевод готового текста (из разметки или из сообщения об ошибке). Нет перевода: null. */
  t.dom = (text) => {
    if (!english) return null;
    const exact = dict[text];
    if (exact !== undefined && !/\{\d+\}/.test(text)) return exact;
    for (const p of patterns) {
      const m = p.re.exec(text);
      if (!m) continue;
      return p.en.replace(/\{(\d+)\}/g, (x, i) => {
        const k = p.slots.indexOf(Number(i));
        return k >= 0 ? m[k + 1] : x;
      });
    }
    return null;
  };

  t.lang = english ? 'en' : 'ru';
  return t;
}

let current = createTranslator('ru');

module.exports = {
  createTranslator,
  setLang(lang) { current = createTranslator(lang === 'en' ? 'en' : 'ru'); },
  getLang() { return current.lang; },
  t: (ru, ...args) => current(ru, ...args),
  tdom: (text) => current.dom(text),
};
