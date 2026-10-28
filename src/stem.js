'use strict';

// Сведение русского слова к основе без словаря: формы одного слова дают одну основу, слова с разными корнями почти не совпадают.
// Имена, прилагательные и наречия: по мотивам стеммера Snowball для русского языка. Глаголы: свой разбор окончаний
// (прошедшее, настоящее, инфинитив, возвратные формы сводятся к одной основе: «смотрел, смотрела, смотрит, смотреть» → «смотр»).
// Слова не по-русски и слишком короткие возвращаются как есть. Ничего не правит, служит для сравнения слов (повторы, формы).

const VOWELS = 'аеиоуыэюя';
const isV = (c) => VOWELS.includes(c);
const cyr = /^[а-яё]+$/;

const norm = (w) => String(w).toLowerCase().replace(/ё/g, 'е');

function regions(w) {
  let rv = w.length;
  for (let i = 0; i < w.length; i += 1) if (isV(w[i])) { rv = i + 1; break; }
  let r1 = w.length;
  for (let i = 1; i < w.length; i += 1) if (!isV(w[i]) && isV(w[i - 1])) { r1 = i + 1; break; }
  let r2 = w.length;
  for (let i = r1 + 1; i < w.length; i += 1) if (!isV(w[i]) && isV(w[i - 1])) { r2 = i + 1; break; }
  return { rv, r2 };
}

const byLen = (list) => [...list].sort((a, b) => b.length - a.length);
const ADJ = byLen('ее ие ые ое ими ыми ей ий ый ой ем им ым ом его ого ему ому их ых ую юю ая яя ою ею'.split(' '));
const NOUN = byLen('а ев ов ие ье е иями ями ами еи ии и ией ей ой ий й иям ям ием ем ам ом о у ах иях ях ы ь ию ью ю ия ья я'.split(' '));
const VERB = byLen(`ешься ишься ете ите ешь ишь ают яют уют юют ает яет ует юет ала яла ила ела ула ыла али яли или ели ули ыли
  ало яло ило ело уло ыло ать ять ить еть уть ыть оть ти чь ет ит ут ют ат ят ем им ал ял ил ел ул ыл ла ло ли ть й л`.split(/\s+/));

function endsWith(w, list, min) {
  for (const s of list) if (w.endsWith(s) && w.length - s.length >= min) return s;
  return null;
}

function stemVerb(w) {
  let x = w;
  if (x.endsWith('ся') || x.endsWith('сь')) x = x.slice(0, -2);
  const e = endsWith(x, VERB, 3);
  if (e) x = x.slice(0, x.length - e.length);
  if (x.length >= 4 && isV(x[x.length - 1])) x = x.slice(0, -1);
  return x;
}

function stemOther(w) {
  const { rv, r2 } = regions(w);
  let x = w;
  const cut = (s) => { x = x.slice(0, x.length - s.length); };
  if (x.endsWith('ся') || x.endsWith('сь')) x = x.slice(0, -2);
  const a = endsWith(x, ADJ, rv);
  if (a) cut(a);
  else {
    const n = endsWith(x, NOUN, rv);
    if (n) cut(n);
  }
  if (x.endsWith('и') && x.length - 1 >= rv) x = x.slice(0, -1);
  const d = endsWith(x, ['ость', 'ост'], r2);
  if (d) cut(d);
  if (x.endsWith('нн') && x.length - 1 >= rv) x = x.slice(0, -1);
  else if (x.endsWith('ь') && x.length - 1 >= rv) x = x.slice(0, -1);
  return x;
}

const cache = new Map();

/** Основа слова. pos: 'verb' | 'noun' | 'adj' | 'adv' | другое. Для не русских слов возвращает слово в нижнем регистре. */
function stem(word, pos) {
  const w = norm(word);
  if (!cyr.test(w) || w.length < 4) return w;
  const key = `${pos === 'verb' ? 'v' : 'o'}${w}`;
  let r = cache.get(key);
  if (r === undefined) {
    r = pos === 'verb' ? stemVerb(w) : stemOther(w);
    if (r.length < 3) r = w.slice(0, Math.max(3, w.length - 2));
    if (cache.size > 50000) cache.clear();
    cache.set(key, r);
  }
  return r;
}

module.exports = { stem };
