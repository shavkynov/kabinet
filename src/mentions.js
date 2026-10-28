'use strict';

// Где встречается карточка: в каких главах и сколько раз. Правила те же, что у подсветки имён в тексте
// (renderer/links.js): название карточки и «Имена в тексте», без учёта регистра, слово целиком,
// слова из «Не считать ссылкой» пропускаются.

const project = require('./project');
const declension = require('./declension');
const { nameRegex, isCapital } = require('./namematch');

function namesOf(title, card) {
  const ignore = new Set((card.ignore || []).map((x) => String(x).trim().toLowerCase()));
  const out = new Set();
  for (const name of [title, ...(card.aliases || [])]) {
    const key = String(name).trim().toLowerCase();
    if (key.length >= 2 && !ignore.has(key)) out.add(key);
  }
  return [...out];
}

function buildRegex(names) {
  return nameRegex(names);
}

// Падежные формы (как в подсветке): не перекрывают явные имена, учитывают «Не считать ссылкой»; форма с большой буквы
// считается только с большой буквы в тексте, чтобы «Веру» не путалось с «веру».
function generatedOf(title, card, kind, explicit) {
  if (card.inflect === false) return { keys: [], capKeys: new Set() };
  const ignore = new Set((card.ignore || []).map((x) => String(x).trim().toLowerCase()));
  const keys = [];
  const capKeys = new Set();
  for (const f of declension.nameForms(title, card.aliases || [], { kind })) {
    const key = f.toLowerCase();
    if (key.length < 2 || ignore.has(key) || explicit.includes(key)) continue;
    keys.push(key);
    if (isCapital(f)) capKeys.add(key);
  }
  return { keys, capKeys };
}

function countIn(text, re, capKeys = null) {
  if (!re) return 0;
  const flat = String(text).replace(/\u00a0/g, ' ');
  re.lastIndex = 0;
  let n = 0;
  let m;
  while ((m = re.exec(flat)) !== null) {
    if (m[0].length === 0) { re.lastIndex += 1; continue; }
    if (capKeys && capKeys.has(m[0].toLowerCase()) && !isCapital(m[0])) continue;
    n += 1;
  }
  return n;
}

/** { protagonist, chapters: [{ id, title, n (номер главы), count }] }. У протагониста список не считаем. */
function cardMentions(dir, kind, id) {
  const title = project.itemTitle(dir, kind, id);
  let raw = {};
  try { raw = JSON.parse(project.readItem(dir, kind, id, { track: false })); } catch { /* пустая карточка */ }
  if (raw.protagonist === true) return { protagonist: true, chapters: [] };
  const explicit = namesOf(title, raw);
  const gen = generatedOf(title, raw, kind, explicit);
  const re = buildRegex([...explicit, ...gen.keys]);
  const view = project.openProject(dir);
  const chapters = [];
  view.chapters.forEach((c, i) => {
    const count = countIn(project.readChapter(dir, c.id, { track: false }), re, gen.capKeys);
    if (count > 0) chapters.push({ id: c.id, title: c.title, n: i + 1, count });
  });
  return { protagonist: false, chapters };
}

module.exports = { cardMentions, namesOf, countIn, buildRegex };
