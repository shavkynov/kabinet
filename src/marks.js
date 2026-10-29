'use strict';

// Показ скрытых символов: какие знаки в тексте считаются «скрытыми» и как они называются в оформлении.
// Сам текст не меняется, метки рисуются поверх (см. renderer/marks.js).

const CLASSES = {
  ' ': 'mk-nb',   // неразрывный пробел
  ' ': 'mk-nn',   // узкий неразрывный пробел
  ' ': 'mk-th',   // тонкий пробел
  ' ': 'mk-em',   // длинный пробел (красная строка)
  ' ': 'mk-em',
  '\t': 'mk-tab',
  '­': 'mk-shy',  // мягкий перенос
  '​': 'mk-zw',   // невидимый пробел
  '﻿': 'mk-zw',
};

/** Найти скрытые знаки в строке -> [{ at, cls }]. spaces: отмечать и обычные пробелы. */
function scanMarks(text, spaces) {
  const out = [];
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const cls = CLASSES[c] || (spaces && c === ' ' ? 'mk-sp' : null);
    if (cls) out.push({ at: i, cls });
  }
  return out;
}

module.exports = { scanMarks, CLASSES };
