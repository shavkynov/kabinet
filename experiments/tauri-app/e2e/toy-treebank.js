'use strict';
// Синтетический CoNLL-U-трибанк для ИГРУШЕЧНОЙ UDPipe-модели (make-toy-model.sh).
// Это собственные тестовые фразы, не данные UD Russian-GSD. Модель, обученная на них,
// проверяет только инфраструктуру (Tauri IPC, контракт, offsets, отмену), а не качество разбора.
// node toy-treebank.js <out.conllu>
const fs = require('fs');

let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const sample = (a, n) => { const c = a.slice(); const out = []; while (out.length < n && c.length) out.push(c.splice(Math.floor(rnd() * c.length), 1)[0]); return out; };

const N = (f, l, c, g, n = 'Sing') => [f, l, 'NOUN', `Case=${c}|Gender=${g}|Number=${n}`];
const nom = [N('Осуществление', 'осуществление', 'Nom', 'Neut'), N('Выполнение', 'выполнение', 'Nom', 'Neut'), N('Проведение', 'проведение', 'Nom', 'Neut'), N('Рассмотрение', 'рассмотрение', 'Nom', 'Neut')];
const gen = [N('проверки', 'проверка', 'Gen', 'Fem'), N('выполнения', 'выполнение', 'Gen', 'Neut'), N('требований', 'требование', 'Gen', 'Masc', 'Plur'), N('решения', 'решение', 'Gen', 'Neut'), N('вопросов', 'вопрос', 'Gen', 'Masc', 'Plur'), N('работы', 'работа', 'Gen', 'Fem')];
const V = (f, l) => [f, l, 'VERB', 'Gender=Neut|Mood=Ind|Number=Sing|Tense=Past|VerbForm=Fin'];
const verbs = [V('затянулось', 'затянуться'), V('продолжалось', 'продолжаться'), V('закончилось', 'закончиться')];
const pron = [['Он', 'он', 'PRON', 'Case=Nom|Gender=Masc|Number=Sing|Person=3'], ['Она', 'она', 'PRON', 'Case=Nom|Gender=Fem|Number=Sing|Person=3']];
const M = (f, l) => [f, l, 'VERB', 'Gender=Masc|Mood=Ind|Number=Sing|Tense=Past|VerbForm=Fin'];
const mverbs = [M('шёл', 'идти'), M('думал', 'думать'), M('вернулся', 'вернуться')];

const sent = (toks) => toks.map((t, i) => [i + 1, t[0], t[1], t[2], '_', t[3] || '_', t[4], t[5], '_', t[6] ? 'SpaceAfter=No' : '_'].join('\t')).join('\n') + '\n';

const out = [];
for (let k = 0; k < 40; k += 1) {
  const g = sample(gen, pick([2, 3])); const v = pick(verbs); const L = 2 + g.length;
  const toks = [[...pick(nom), L, 'nsubj']];
  g.forEach((x, j) => toks.push([...x, 1 + j, 'nmod']));
  toks.push([...v, 0, 'root']);
  toks.push(['.', '.', 'PUNCT', '', L, 'punct', true]);
  out.push(sent(toks));
}
for (let k = 0; k < 30; k += 1) {
  out.push(sent([
    [...pick(pron), 2, 'nsubj'], [...pick(mverbs), 0, 'root'], ['по', 'по', 'ADP', '', 5, 'case'],
    ['тёмной', 'тёмный', 'ADJ', 'Case=Dat|Degree=Pos|Gender=Fem|Number=Sing', 5, 'amod'],
    ['улице', 'улица', 'NOUN', 'Case=Dat|Gender=Fem|Number=Sing', 2, 'obl'], ['.', '.', 'PUNCT', '', 2, 'punct', true],
  ]));
}
fs.writeFileSync(process.argv[2] || 'toy.conllu', out.join('\n') + '\n', 'utf8');
console.log(`${out.length} предложений`);
