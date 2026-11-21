'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { scanStyle } = require('../src/style');
const { analyzeBlock } = require('../src/morph');
const { analyzeStructural } = require('../src/style-engine/structural');
const { findUdPassive, analyzeUdTenseBlock } = require('../src/style-engine/linguistic');
const { repeatPairs } = require('../src/editing');
const { isFuturePerfective } = require('../src/tense');

function makeSent(text, specs) {
  let cursor = 0;
  const tokens = specs.map(([word, lemma, upos, feats, head, deprel], idx) => {
    const start = text.indexOf(word, cursor);
    assert.ok(start >= 0, `токен «${word}» не найден в «${text}»`);
    cursor = start + word.length;
    return { id: idx + 1, text: word, lemma, upos, feats, head, deprel, start, end: cursor };
  });
  return { start: 0, end: text.length, text, tokens };
}

const ALL_STYLE = { chancery: true, weak: true, tell: true, chain: true, remark: true, redund: true, which: true, own: true };
const scanLex = (text, kinds = ALL_STYLE) => {
  const a = analyzeBlock(text);
  return scanStyle(text, a.words, kinds, a.sentences);
};
const fragsLex = (text, kind) => scanLex(text, { [kind]: true })[kind].map((h) => text.slice(h.start, h.end));

test('калибровка src/style.js: «таким образом», INF-существительные, идиомы own, границы тавтологии и физический tell', () => {
  // «таким образом» как буквальный образ действия vs вводный оборот
  assert.deepEqual(fragsLex('Он шёл к ней таким образом в зимнее утро.', 'chancery'), []);
  assert.deepEqual(fragsLex('Таким образом, вопрос закрыт.', 'chancery'), ['Таким образом']);
  assert.deepEqual(fragsLex('Таким образом мы закончили вовремя.', 'chancery'), ['Таким образом']);
  assert.deepEqual(fragsLex('И, таким образом, работа остановилась.', 'chancery'), ['таким образом']);

  // «стало опять», «начал путь», «стало быть» — не слабые глаголы; «почтить» и «стал идти» — всё ещё ловятся
  assert.deepEqual(fragsLex('Небо стало опять синеть. Он начал путь домой. Стало быть, они ушли.', 'weak'), []);
  assert.deepEqual(fragsLex('Он стал почтить память героя. Она стала думать иначе. Он стал идти быстрее.', 'weak'), ['стал почтить', 'стала думать', 'стал идти']);

  // own: «свой лоб носовым» — не матчит «носовым»; идиомы и сравнения не шумят; реальное лишнее «свою шляпу» остаётся
  assert.deepEqual(fragsLex('Он не верил своим глазам.', 'own'), []);
  assert.deepEqual(fragsLex('Видавшим перед своими глазами смерть.', 'own'), []);
  assert.deepEqual(fragsLex('Своими руками вести заметки надёжнее.', 'own'), []);
  assert.deepEqual(fragsLex('Она прятала деньги в своих руках.', 'own'), []);
  assert.deepEqual(fragsLex('Графиня была бледнее своего платка.', 'own'), []);
  assert.deepEqual(fragsLex('Он снял свою шляпу и вытер свой лоб носовым платком.', 'own'), ['свою шляпу', 'свой лоб']);

  // redund: скобки и тире не склеиваются в ложную тавтологию, настоящая тавтология рядом остаётся
  assert.deepEqual(fragsLex('Из скупости (он был скуповат) он промолчал.', 'redund'), []);
  assert.deepEqual(fragsLex('Это редкий сорт граната — зелёный гранат.', 'redund'), []);
  assert.deepEqual(fragsLex('Он рассказал мне длинный рассказ.', 'redund'), ['рассказал мне длинный рассказ']);

  // findTautology при разной разметке одного слова/леммы (например UDPipe verb vs noun) — это повтор, не тавтология
  const sameLemmaText = 'Дети сидели рядом, потом сидели тихо.';
  assert.deepEqual(scanStyle(sameLemmaText, [
    { start: 5, end: 11, text: 'сидели', lemma: 'сидеть', pos: 'verb' },
    { start: 25, end: 31, text: 'сидели', lemma: 'сидеть', pos: 'noun' },
  ], { redund: true }).redund, []);
  const diffLemmaText = 'Он рассказал рассказ.';
  assert.equal(scanStyle(diffLemmaText, [
    { start: 3, end: 12, text: 'рассказал', lemma: 'рассказать', pos: 'verb' },
    { start: 13, end: 20, text: 'рассказ', lemma: 'рассказ', pos: 'noun' },
  ], { redund: true }).redund.length, 1);

  // tell: физическое проявление перед «от + чувство» снимает претензию, сухое называние — остаётся
  assert.deepEqual(fragsLex('Она вспыхнула румянцем от обиды.', 'tell'), []);
  assert.deepEqual(fragsLex('Он побледнел от злости и вышел.', 'tell'), []);
  assert.deepEqual(fragsLex('Он замолчал от обиды.', 'tell'), ['от обиды']);
  assert.deepEqual(fragsLex('Он слушал с искренним любопытством.', 'tell'), ['с искренним любопытством']);
});

test('калибровка structural.js: лексикализованные -ие/-ние, «осенние/зимние», предложный obl и «делать предложение»', () => {
  // «проводить осенние вечера», «проводил месяц в имении», «делать предложение» — не канцелярит
  const s1 = 'Она любила проводить осенние вечера в имении.';
  const sent1 = makeSent(s1, [
    ['Она', 'она', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
    ['любила', 'любить', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['проводить', 'проводить', 'VERB', { VerbForm: 'Inf', Voice: 'Act' }, 2, 'xcomp'],
    ['осенние', 'осенние', 'NOUN', { Case: 'Acc' }, 3, 'obj'],
    ['вечера', 'вечер', 'NOUN', { Case: 'Gen' }, 4, 'nmod'],
    ['в', 'в', 'ADP', {}, 7, 'case'],
    ['имении', 'имение', 'NOUN', { Case: 'Loc' }, 3, 'obl'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ]);
  assert.deepEqual(analyzeStructural(s1, { sentences: [sent1] }, { chancery: true }).chancery, []);

  const s2 = 'Он поехал делать предложение невесте.';
  const sent2 = makeSent(s2, [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 2, 'nsubj'],
    ['поехал', 'поехать', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['делать', 'делать', 'VERB', { VerbForm: 'Inf', Voice: 'Act' }, 2, 'xcomp'],
    ['предложение', 'предложение', 'NOUN', { Case: 'Acc' }, 3, 'obj'],
    ['невесте', 'невеста', 'NOUN', { Case: 'Dat' }, 3, 'iobj'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ]);
  assert.deepEqual(analyzeStructural(s2, { sentences: [sent2] }, { chancery: true }).chancery, []);

  // Деловой вариант с зависимым nmod («сделать предложение о сотрудничестве») остаётся канцеляритом
  const s3 = 'Комиссия решила сделать предложение о проведении проверки.';
  const sent3 = makeSent(s3, [
    ['Комиссия', 'комиссия', 'NOUN', { Case: 'Nom' }, 2, 'nsubj'],
    ['решила', 'решить', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['сделать', 'сделать', 'VERB', { VerbForm: 'Inf', Voice: 'Act' }, 2, 'xcomp'],
    ['предложение', 'предложение', 'NOUN', { Case: 'Acc' }, 3, 'obj'],
    ['о', 'о', 'ADP', {}, 6, 'case'],
    ['проведении', 'проведение', 'NOUN', { Case: 'Loc' }, 4, 'nmod'],
    ['проверки', 'проверка', 'NOUN', { Case: 'Gen' }, 6, 'nmod'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ]);
  assert.equal(analyzeStructural(s3, { sentences: [sent3] }, { chancery: true }).chancery.length, 1);

  // Реальная тяжёлая цепь событийных отглагольных по-прежнему ловится
  const s4 = 'Осуществление проверки выполнения требований затянулось.';
  const sent4 = makeSent(s4, [
    ['Осуществление', 'осуществление', 'NOUN', { Case: 'Nom' }, 5, 'nsubj'],
    ['проверки', 'проверка', 'NOUN', { Case: 'Gen' }, 1, 'nmod'],
    ['выполнения', 'выполнение', 'NOUN', { Case: 'Gen' }, 2, 'nmod'],
    ['требований', 'требование', 'NOUN', { Case: 'Gen' }, 3, 'nmod'],
    ['затянулось', 'затянуться', 'VERB', { VerbForm: 'Fin' }, 0, 'root'],
    ['.', '.', 'PUNCT', {}, 5, 'punct'],
  ]);
  assert.equal(analyzeStructural(s4, { sentences: [sent4] }, { chain: true }).chain.length, 1);
});

test('калибровка linguistic.js: пассив состояния/ошибки ADJ vs пассив с деятелем и фильтры времени', () => {
  // Краткие прилагательные/ошибки UDPipe не считаются пассивом
  const fp1 = 'В комнатах было душно.';
  assert.deepEqual(findUdPassive(makeSent(fp1, [
    ['В', 'в', 'ADP', {}, 2, 'case'],
    ['комнатах', 'комната', 'NOUN', { Case: 'Loc' }, 4, 'obl'],
    ['было', 'быть', 'AUX', { VerbForm: 'Fin' }, 4, 'aux:pass'],
    ['душно', 'душно', 'VERB', { VerbForm: 'Part', Voice: 'Pass', Variant: 'Short' }, 0, 'root'],
    ['.', '.', 'PUNCT', {}, 4, 'punct'],
  ]), fp1), []);

  const fp2 = 'Он был искренен.';
  assert.deepEqual(findUdPassive(makeSent(fp2, [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 3, 'nsubj:pass'],
    ['был', 'быть', 'AUX', { VerbForm: 'Fin' }, 3, 'aux:pass'],
    ['искренен', 'искренить', 'VERB', { VerbForm: 'Part', Voice: 'Pass', Variant: 'Short' }, 0, 'root'],
    ['.', '.', 'PUNCT', {}, 3, 'punct'],
  ]), fp2), []);

  const fp3 = 'Он был приятен и страшен.';
  assert.deepEqual(findUdPassive(makeSent(fp3, [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 3, 'nsubj:pass'],
    ['был', 'быть', 'AUX', { VerbForm: 'Fin' }, 3, 'aux:pass'],
    ['приятен', 'приятить', 'VERB', { VerbForm: 'Part', Voice: 'Pass', Variant: 'Short' }, 0, 'root'],
    ['и', 'и', 'CCONJ', {}, 5, 'cc'],
    ['страшен', 'страшить', 'VERB', { VerbForm: 'Part', Voice: 'Pass', Variant: 'Short' }, 3, 'conj'],
    ['.', '.', 'PUNCT', {}, 3, 'punct'],
  ]), fp3), []);

  // Состояние без агенса («дверь была закрыта») подавляется, с агенсом («открыта ключом», «расстроено предками») остаётся
  const stNoAgent = 'Дверь была закрыта.';
  assert.deepEqual(findUdPassive(makeSent(stNoAgent, [
    ['Дверь', 'дверь', 'NOUN', { Case: 'Nom' }, 3, 'nsubj:pass'],
    ['была', 'быть', 'AUX', { VerbForm: 'Fin' }, 3, 'aux:pass'],
    ['закрыта', 'закрыть', 'VERB', { VerbForm: 'Part', Voice: 'Pass', Variant: 'Short' }, 0, 'root'],
    ['.', '.', 'PUNCT', {}, 3, 'punct'],
  ]), stNoAgent), []);

  const stWithAgent = 'Родовое имение было расстроено предками.';
  const hitAgent = findUdPassive(makeSent(stWithAgent, [
    ['Родовое', 'родовой', 'ADJ', { Case: 'Nom' }, 2, 'amod'],
    ['имение', 'имение', 'NOUN', { Case: 'Nom' }, 4, 'nsubj:pass'],
    ['было', 'быть', 'AUX', { VerbForm: 'Fin' }, 4, 'aux:pass'],
    ['расстроено', 'расстроить', 'VERB', { VerbForm: 'Part', Voice: 'Pass', Variant: 'Short' }, 0, 'root'],
    ['предками', 'предок', 'NOUN', { Case: 'Ins' }, 4, 'obl:agent'],
    ['.', '.', 'PUNCT', {}, 4, 'punct'],
  ]), stWithAgent);
  assert.deepEqual(hitAgent.map((x) => stWithAgent.slice(x.start, x.end)), ['было расстроено']);

  // Возвратный непассивный глагол исключён
  const refl = 'Он занимался делом.';
  assert.deepEqual(findUdPassive(makeSent(refl, [
    ['Он', 'он', 'NOUN', { Case: 'Nom' }, 2, 'nsubj:pass'],
    ['занимался', 'заниматься', 'VERB', { VerbForm: 'Fin', Voice: 'Pass' }, 0, 'root'],
    ['делом', 'дело', 'NOUN', { Case: 'Ins' }, 2, 'obl'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ]), refl), []);

  // Будущее время, вводные, ошибки POS в настоящем и «приезжайте и скажите» не дают сдвигов времени
  assert.ok(isFuturePerfective('поведет'));
  assert.ok(isFuturePerfective('засверкает'));

  const checkSingle = (txt, rows) => analyzeUdTenseBlock(txt, [makeSent(txt, rows)], 0);
  assert.equal(checkSingle('Кажется, я не соглашался.', [
    ['Кажется', 'казаться', 'VERB', { VerbForm: 'Fin', Tense: 'Pres', Aspect: 'Imp' }, 0, 'root'],
    [',', ',', 'PUNCT', {}, 1, 'punct'],
    ['я', 'я', 'PRON', { Case: 'Nom', PronType: 'Prs' }, 4, 'nsubj'],
    ['не', 'не', 'PART', {}, 4, 'advmod'],
    ['соглашался', 'соглашаться', 'VERB', { VerbForm: 'Fin', Tense: 'Past' }, 1, 'conj'],
    ['.', '.', 'PUNCT', {}, 1, 'punct'],
  ]).present, 0);

  assert.equal(checkSingle('Он был одет бедно и краем шел, нет ли.', [
    ['Он', 'он', 'PRON', { Case: 'Nom' }, 3, 'nsubj'],
    ['был', 'быть', 'AUX', { VerbForm: 'Fin', Tense: 'Past' }, 3, 'cop'],
    ['одет', 'одеть', 'VERB', { VerbForm: 'Fin', Tense: 'Pres', Aspect: 'Imp' }, 0, 'root'],
    ['бедно', 'бедно', 'ADV', {}, 3, 'advmod'],
    ['и', 'и', 'CCONJ', {}, 7, 'cc'],
    ['краем', 'край', 'VERB', { VerbForm: 'Fin', Tense: 'Pres', Aspect: 'Imp' }, 7, 'obl'],
    ['шел', 'идти', 'VERB', { VerbForm: 'Fin', Tense: 'Past' }, 3, 'conj'],
    [',', ',', 'PUNCT', {}, 9, 'punct'],
    ['нет', 'нет', 'VERB', { VerbForm: 'Fin', Tense: 'Pres', Aspect: 'Imp' }, 7, 'conj'],
    ['ли', 'ли', 'PART', {}, 9, 'advmod'],
    ['.', '.', 'PUNCT', {}, 3, 'punct'],
  ]).present, 0);

  assert.equal(checkSingle('Разумеется, он ушёл.', [
    ['Разумеется', 'разуметься', 'VERB', { VerbForm: 'Fin', Tense: 'Pres', Aspect: 'Imp' }, 0, 'root'],
    [',', ',', 'PUNCT', {}, 1, 'punct'],
    ['он', 'он', 'PRON', { Case: 'Nom', PronType: 'Prs' }, 4, 'nsubj'],
    ['ушёл', 'уйти', 'VERB', { VerbForm: 'Fin', Tense: 'Past' }, 1, 'conj'],
    ['.', '.', 'PUNCT', {}, 1, 'punct'],
  ]).present, 0);

  assert.equal(checkSingle('Как водится, он опоздал.', [
    ['Как', 'как', 'SCONJ', {}, 2, 'mark'],
    ['водится', 'водиться', 'VERB', { VerbForm: 'Fin', Tense: 'Pres', Aspect: 'Imp' }, 5, 'parataxis'],
    [',', ',', 'PUNCT', {}, 2, 'punct'],
    ['он', 'он', 'PRON', { Case: 'Nom', PronType: 'Prs' }, 5, 'nsubj'],
    ['опоздал', 'опоздать', 'VERB', { VerbForm: 'Fin', Tense: 'Past' }, 0, 'root'],
    ['.', '.', 'PUNCT', {}, 5, 'punct'],
  ]).present, 0);

  assert.equal(checkSingle('Чёрт знает, куда он пошёл.', [
    ['Чёрт', 'чёрт', 'NOUN', { Case: 'Nom' }, 2, 'nsubj'],
    ['знает', 'знать', 'VERB', { VerbForm: 'Fin', Tense: 'Pres', Aspect: 'Imp' }, 0, 'root'],
    [',', ',', 'PUNCT', {}, 6, 'punct'],
    ['куда', 'куда', 'ADV', {}, 6, 'advmod'],
    ['он', 'он', 'PRON', { Case: 'Nom', PronType: 'Prs' }, 6, 'nsubj'],
    ['пошёл', 'пойти', 'VERB', { VerbForm: 'Fin', Tense: 'Past' }, 2, 'ccomp'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ]).present, 0);

  assert.equal(checkSingle('Может быть, он ошибся.', [
    ['Может', 'мочь', 'VERB', { VerbForm: 'Fin', Tense: 'Pres', Aspect: 'Imp' }, 0, 'root'],
    ['быть', 'быть', 'VERB', { VerbForm: 'Inf' }, 5, 'parataxis'],
    [',', ',', 'PUNCT', {}, 1, 'punct'],
    ['он', 'он', 'PRON', { Case: 'Nom', PronType: 'Prs' }, 5, 'nsubj'],
    ['ошибся', 'ошибиться', 'VERB', { VerbForm: 'Fin', Tense: 'Past' }, 1, 'parataxis'],
    ['.', '.', 'PUNCT', {}, 1, 'punct'],
  ]).present, 0);

  assert.equal(checkSingle('Он знает дорогу.', [
    ['Он', 'он', 'PRON', { Case: 'Nom', PronType: 'Prs' }, 2, 'nsubj'],
    ['знает', 'знать', 'VERB', { VerbForm: 'Fin', Tense: 'Pres', Aspect: 'Imp' }, 0, 'root'],
    ['дорогу', 'дорога', 'NOUN', { Case: 'Acc' }, 2, 'obj'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ]).present, 1);

  // Реальный сдвиг времени («вбегает» среди прошедшего) сохраняется
  const realShift = 'Дверь открылась, и Маша вбегает в зал.';
  const rReal = checkSingle(realShift, [
    ['Дверь', 'дверь', 'NOUN', { Case: 'Nom' }, 2, 'nsubj'],
    ['открылась', 'открыться', 'VERB', { VerbForm: 'Fin', Tense: 'Past' }, 0, 'root'],
    [',', ',', 'PUNCT', {}, 5, 'punct'],
    ['и', 'и', 'CCONJ', {}, 5, 'cc'],
    ['Маша', 'Маша', 'PROPN', { Case: 'Nom' }, 5, 'nsubj'],
    ['вбегает', 'вбегать', 'VERB', { VerbForm: 'Fin', Tense: 'Pres', Aspect: 'Imp' }, 2, 'conj'],
    ['в', 'в', 'ADP', {}, 7, 'case'],
    ['зал', 'зал', 'NOUN', { Case: 'Acc' }, 5, 'obl'],
    ['.', '.', 'PUNCT', {}, 2, 'punct'],
  ]);
  assert.equal(rReal.past, 1);
  assert.equal(rReal.present, 1);
  assert.equal(rReal.items[1].conf, 'high');
});

test('калибровка editing.js: служебные слова не дают ложных повторов', () => {
  const noRepeats = repeatPairs([
    { text: 'Когда', lemma: 'когда', pos: 'adv', proper: false },
    { text: 'него', lemma: 'он', pos: 'pron', proper: false },
    { text: 'было', lemma: 'быть', pos: 'verb', proper: false },
    { text: 'самом', lemma: 'самый', pos: 'adj', proper: false },
    { text: 'деле', lemma: 'дело', pos: 'noun', proper: false },
    { text: 'когда', lemma: 'когда', pos: 'adv', proper: false },
    { text: 'него', lemma: 'он', pos: 'pron', proper: false },
    { text: 'самых', lemma: 'самый', pos: 'adj', proper: false },
  ], 25);
  assert.deepEqual(noRepeats, []);

  // Существенные повторы по-прежнему определяются
  const realRepeat = repeatPairs([
    { text: 'Люди', lemma: 'человек', pos: 'noun', proper: false },
    { text: 'стояли', lemma: 'стоять', pos: 'verb', proper: false },
    { text: 'возле', lemma: 'возле', pos: 'func', proper: false },
    { text: 'человека', lemma: 'человек', pos: 'noun', proper: false },
  ], 25);
  assert.deepEqual(realRepeat, [[0, 3]]);
});
