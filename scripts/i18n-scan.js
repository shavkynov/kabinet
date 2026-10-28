'use strict';

// Ищет русские строки в коде и разметке и показывает те, которых нет в словаре src/i18n-en.js.
// npm run i18n          показать недостающие
// npm run i18n -- --json  то же в виде JSON (для заполнения словаря)
// Из шаблонных строк `${...}` превращается в {0}, {1}: так их понимает словарь.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const CYR = /[А-Яа-яЁё]/;
// Технические имена (папки на диске, имена шрифтов, службы): не переводятся.
const IGNORE = new Set(['Корзина', 'Версии', 'Главы', 'Изображения', 'Картинки', 'Конфликты', 'общее описание', 'Мой диск', 'Яндекс.Диск', '"Кабинет:', 'Кабинет:', 'Кабинет: {0}',
  // имена файлов и путей, которые создаёт программа, и части путей для сравнения
  'Копии', 'Персонажи/', 'Места/', 'Главы/', '/яндекс.диск', 'облако {0}', 'без названия', '{0} {1} (с другого устройства){2}']);

/** Достаёт литералы строк из JS: [{text, tpl}] (комментарии и регулярные выражения пропускаются). */
function jsStrings(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  let prev = ''; // последний значимый символ, чтобы отличить деление от регулярки

  function readTemplate() { // i стоит после открывающей `
    let text = '';
    let k = 0;
    while (i < n) {
      const c = src[i];
      if (c === '\\') { text += src[i + 1] === 'n' ? '\n' : src[i + 1]; i += 2; continue; }
      if (c === '`') { i += 1; break; }
      if (c === '$' && src[i + 1] === '{') {
        i += 2;
        let depth = 1;
        const start = i;
        while (i < n && depth > 0) {
          const d = src[i];
          if (d === '{') depth += 1;
          else if (d === '}') depth -= 1;
          else if (d === '`') { i += 1; readTemplate(); continue; }
          else if (d === "'" || d === '"') { const q = d; i += 1; while (i < n && src[i] !== q) { if (src[i] === '\\') i += 1; i += 1; } }
          i += 1;
        }
        for (const inner of jsStrings(src.slice(start, i - 1))) out.push(inner); // строки внутри ${ ... }
        text += `{${k}}`;
        k += 1;
        continue;
      }
      text += c;
      i += 1;
    }
    out.push(text);
    return text;
  }

  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2); i = i < 0 ? n : i + 2; continue; }
    if (c === "'" || c === '"') {
      const q = c;
      i += 1;
      let text = '';
      while (i < n && src[i] !== q && src[i] !== '\n') {
        if (src[i] === '\\') {
          const e = src[i + 1];
          text += e === 'n' ? '\n' : e === 't' ? '\t' : e;
          i += 2;
        } else { text += src[i]; i += 1; }
      }
      i += 1;
      out.push(text);
      prev = q;
      continue;
    }
    if (c === '`') { i += 1; readTemplate(); prev = '`'; continue; }
    if (c === '/' && /[(,=:[!&|?{};]/.test(prev || ';')) { // регулярное выражение
      i += 1;
      let cls = false;
      while (i < n && (src[i] !== '/' || cls) && src[i] !== '\n') {
        if (src[i] === '\\') i += 1;
        else if (src[i] === '[') cls = true;
        else if (src[i] === ']') cls = false;
        i += 1;
      }
      i += 1;
      prev = '/';
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i += 1;
  }
  return out;
}

function htmlStrings(src) {
  const out = [];
  const body = src.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)[\s\S]*?<\/\1>/g, '');
  for (const m of body.matchAll(/>([^<>]+)</g)) out.push(m[1]);
  for (const m of body.matchAll(/\b(?:title|placeholder|aria-label|label)="([^"]*)"/g)) out.push(m[1]);
  return out;
}

const norm = (s) => s.replace(/\s+/g, ' ').trim();

function collect() {
  require('./concat').buildApp();
  const found = new Map(); // ключ -> файлы
  const add = (file, s) => {
    const k = file.endsWith('.html') ? norm(s) : s.trim();
    if (!k || !CYR.test(k) || IGNORE.has(k)) return;
    if (!found.has(k)) found.set(k, new Set());
    found.get(k).add(path.basename(file));
  };
  const files = [];
  for (const dir of ['renderer', 'src', '.']) {
    const full = path.join(root, dir);
    for (const f of fs.readdirSync(full)) {
      const p = path.join(full, f);
      if (!fs.statSync(p).isFile()) continue;
      if (dir === '.' && !['main.js', 'preload.js'].includes(f)) continue;
      if (dir === 'src' && (f === 'i18n-en.js' || f === 'typo.js' || f === 'morph.js' || f === 'editing.js' || f === 'tense.js' || f === 'import.js' || f === 'terms.js' || f === 'stem.js' || f === 'declension.js')) continue; // словарь и список коротких слов
      if (/\.(js|html)$/.test(f)) files.push(p);
    }
  }
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const list = f.endsWith('.html') ? htmlStrings(src) : jsStrings(src);
    list.forEach((s) => add(f, s));
  }
  return found;
}

if (require.main === module) {
  const dict = require('../src/i18n-en');
  const found = collect();
  const missing = [...found.keys()].filter((k) => dict[k] === undefined);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(Object.fromEntries(missing.map((k) => [k, ''])), null, 1));
  } else if (missing.length) {
    for (const k of missing) console.log(`${[...found.get(k)].join(',').padEnd(18)} ${JSON.stringify(k)}`);
    console.log(`\nНе переведено: ${missing.length} из ${found.size}`);
  } else {
    console.log(`Все строки переведены (${found.size}).`);
  }
  process.exitCode = missing.length && process.argv.includes('--strict') ? 1 : 0;
}

module.exports = { collect, jsStrings, htmlStrings };
