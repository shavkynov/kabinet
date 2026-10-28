'use strict';

// Замена текста по всему проекту: главы, заметки и тексты карточек (краткое описание, псевдонимы, значения полей).
// Названия глав и карточек не меняются. Сопоставление, как в поиске: без учёта регистра, неразрывный пробел = пробел.

const project = require('./project');

const MIN_LEN = 2;
const MAX_LEN = 200;

function buildRegex(find) {
  const q = String(find ?? '').replace(/\u00a0/g, ' ');
  const src = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '[ \\u00a0]');
  return new RegExp(src, 'giu');
}

/** Заменяет все вхождения в строке. Возвращает { text, count }. */
function replaceInText(text, find, repl) {
  const re = buildRegex(find);
  let count = 0;
  const out = String(text).replace(re, () => { count += 1; return repl; });
  return { text: out, count };
}

function replaceInCard(json, find, repl) {
  let c;
  try { c = JSON.parse(json); } catch { return { text: json, count: 0 }; }
  let count = 0;
  const one = (s) => {
    const r = replaceInText(String(s ?? ''), find, repl);
    count += r.count;
    return r.text;
  };
  c.short = one(c.short);
  if (Array.isArray(c.aliases)) c.aliases = c.aliases.map(one);
  if (Array.isArray(c.fields)) c.fields = c.fields.map((f) => ({ ...f, value: one(f && f.value) }));
  return { text: JSON.stringify(c, null, 2), count };
}

/**
 * Замена во всём проекте. dry = true: ничего не пишет, только считает.
 * Возвращает { total, docs: [{ kind, id, title, count }] }.
 */
function replaceProject(dir, find, repl, { dry = false } = {}) {
  const q = String(find ?? '').replace(/\u00a0/g, ' ').trim();
  if (q.length < MIN_LEN) throw new Error('Для замены введите хотя бы два символа.');
  if (q.length > MAX_LEN || String(repl ?? '').length > MAX_LEN * 5) throw new Error('Слишком длинный текст для замены.');
  const to = String(repl ?? '');
  const view = project.openProject(dir);
  const docs = [];

  const handle = (kind, item, read, transform, write) => {
    const r = transform(read());
    if (r.count === 0) return;
    if (!dry) write(r.text);
    docs.push({ kind, id: item.id, title: item.title, count: r.count });
  };

  for (const c of view.chapters) {
    handle('chapter', c, () => project.readChapter(dir, c.id, { track: false }), (t) => replaceInText(t, q, to),
      (t) => project.writeChapter(dir, c.id, t));
  }
  for (const [kind, list] of [['character', view.characters], ['place', view.places]]) {
    for (const c of list) {
      handle(kind, c, () => project.readItem(dir, kind, c.id, { track: false }), (t) => replaceInCard(t, q, to),
        (t) => project.writeItem(dir, kind, c.id, t));
    }
  }
  for (const c of view.notes) {
    handle('note', c, () => project.readItem(dir, 'note', c.id, { track: false }), (t) => replaceInText(t, q, to),
      (t) => project.writeItem(dir, 'note', c.id, t));
  }
  return { total: docs.reduce((a, d) => a + d.count, 0), docs };
}

module.exports = { replaceInText, replaceInCard, replaceProject };
