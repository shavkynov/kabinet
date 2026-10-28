'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { typeChar, fixText, applyEdits, NB } = require('../src/typo');

// Набираем строку по одному символу, как в редакторе.
function type(str, opts) {
  let s = '';
  for (const ch of str) {
    const r = typeChar(s, ch, opts);
    if (r) s = s.slice(0, s.length - r.del) + r.ins;
    else s += ch;
  }
  return s;
}
const fix = (s, o) => applyEdits(s, fixText(s, o));

test('кавычки: ёлочки и вложенные лапки', () => {
  assert.equal(type('Он сказал "да".'), 'Он сказал «да».');
  assert.equal(type('"Он сказал "да" и ушёл"'), `«Он сказал „да“ и${NB}ушёл»`);
  assert.equal(type('("текст")'), '(«текст»)');
});

test('тире и диалог', () => {
  assert.equal(type('- Привет'), '— Привет');
  assert.equal(type('Он -- вор'), `Он${NB}— вор`);
  assert.equal(type('Он - вор'), `Он${NB}— вор`);
  assert.equal(type('кто-то'), 'кто-то');
  assert.equal(type('5-10'), '5-10');
});

test('многоточие', () => {
  assert.equal(type('Ну...'), 'Ну…');
  assert.equal(type('Ну..'), 'Ну..');
});

test('неразрывный пробел после коротких слов', () => {
  assert.equal(type('Он пошёл в дом'), `Он пошёл в${NB}дом`);
  assert.equal(type('А потом'), `А${NB}потом`);
  assert.equal(type('Дом стоял'), 'Дом стоял');
});

test('переключатели', () => {
  assert.equal(type('"а"', { quotes: false }), '"а"');
  assert.equal(type('в дом', { nbsp: false }), 'в дом');
  assert.equal(type('- а', { dashes: false, nbsp: false }), '- а');
});

test('правка готового текста и повторный прогон ничего не меняет', () => {
  const src = '- Привет, - сказал он. - Ну... "да" в доме?';
  const once = fix(src);
  assert.equal(once, `— Привет,${NB}— сказал он.${NB}— Ну… «да» в${NB}доме?`);
  assert.deepEqual(fixText(once), []);
});

test('правки не задевают лишнее и корректны по позициям', () => {
  const src = 'Он "ушёл" к морю';
  const edits = fixText(src);
  assert.ok(edits.every((e) => e.from >= 0 && e.to <= src.length && e.from <= e.to));
  assert.equal(applyEdits(src, edits), `Он «ушёл» к${NB}морю`);
});

test('типографика без неразрывных пробелов: перед тире обычный пробел', () => {
  const { typeChar } = require('../src/typo');
  const r = typeChar('Он сказал -', '-', { nbsp: false });
  assert.ok(r && r.ins === ' —' && !r.ins.includes(' '));
  const r2 = typeChar('Он сказал -', ' ', { nbsp: false });
  assert.equal(r2.ins, ' — ');
  assert.equal(typeChar('Он в', ' ', { nbsp: false }), null); // после короткого слова пробел не заменяется
});

test('приведение в порядок без неразрывных пробелов заменяет и уже стоящие в тексте', () => {
  const src = `Он${NB}пошёл в${NB}дом${NB}${NB}и "ушёл".`;
  const out = applyEdits(src, fixText(src, { nbsp: false }));
  assert.equal(out, 'Он пошёл в дом  и «ушёл».');
  assert.equal(applyEdits(out, fixText(out, { nbsp: false })), out); // повторный прогон ничего не меняет
  assert.equal(fixText(`в${NB}дом`, { nbsp: true }).length, 0); // при включённых неразрывных пробелах они остаются
});
