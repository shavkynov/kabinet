'use strict';

// Поиск по всему проекту: главы, заметки, карточки. Без учёта регистра, подстрока.

const project = require('./project');

const MAX_DOCS = 100;
const MAX_SNIPPETS = 4;
const CONTEXT = 48;

function cardText(json) {
  let c;
  try { c = JSON.parse(json); } catch { return ''; }
  const parts = [c.short, ...(c.aliases || []), ...(c.fields || []).map((f) => `${f.name}: ${f.value}`)];
  return parts.filter(Boolean).join('\n');
}

function scan(text, q) {
  const hay = text.replace(/\u00a0/g, ' ').toLowerCase(); // неразрывный пробел ищется как обычный
  const snippets = [];
  let count = 0;
  let from = 0;
  for (;;) {
    const i = hay.indexOf(q, from);
    if (i < 0) break;
    if (snippets.length < MAX_SNIPPETS) {
      const flat = (s) => s.replace(/\s+/g, ' ');
      snippets.push({
        n: count, // номер вхождения в документе, по нему открывающий документ находит место
        before: flat(text.slice(Math.max(0, i - CONTEXT), i)),
        match: text.slice(i, i + q.length),
        after: flat(text.slice(i + q.length, i + q.length + CONTEXT)),
      });
    }
    count += 1;
    from = i + Math.max(1, q.length);
  }
  return { count, snippets };
}

function searchProject(dir, query) {
  const q = String(query ?? '').replace(/\u00a0/g, ' ').trim().toLowerCase();
  if (q.length < 2) return [];
  const view = project.openProject(dir);
  const out = [];

  const add = (kind, item, text) => {
    const inTitle = item.title.toLowerCase().includes(q);
    const { count, snippets } = scan(text, q);
    if (count === 0 && !inTitle) return;
    out.push({ kind, id: item.id, title: item.title, icon: item.icon || null, count, titleMatch: inTitle, snippets });
  };

  for (const c of view.chapters) add('chapter', c, project.readChapter(dir, c.id, { track: false }));
  for (const c of view.characters) add('character', c, cardText(project.readItem(dir, 'character', c.id, { track: false })));
  for (const c of view.places) add('place', c, cardText(project.readItem(dir, 'place', c.id, { track: false })));
  for (const c of view.items) add('item', c, cardText(project.readItem(dir, 'item', c.id, { track: false })));
  for (const c of view.notes) add('note', c, project.readItem(dir, 'note', c.id, { track: false }));
  return out.slice(0, MAX_DOCS);
}

module.exports = { searchProject };
