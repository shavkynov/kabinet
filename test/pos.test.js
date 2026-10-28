'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classify, tokenize, analyzeBlock } = require('../src/morph');
const T = require('../src/tense');
const gold = require('./gold-pos');
const goldMore = [require('./gold-pos-2'), require('./gold-pos-3'), require('./gold-pos-4')];

const MAP = { verb: 'V', noun: 'N', adj: 'A', adv: 'D', part: 'P', pron: 'R', func: 'F', num: 'U', other: '?' };

function metrics(corpus = gold) {
  const conf = {};
  let total = 0;
  let ok = 0;
  for (const s of corpus) {
    let prev = '';
    for (const [w, g] of s) {
      const p = MAP[classify(w, { prev })];
      total += 1;
      if (p === g) ok += 1;
      conf[`${g}>${p}`] = (conf[`${g}>${p}`] || 0) + 1;
      prev = w;
    }
  }
  const of = (c) => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const [k, n] of Object.entries(conf)) {
      const [g, p] = k.split('>');
      if (g === c && p === c) tp += n;
      else if (g === c) fn += n;
      else if (p === c) fp += n;
    }
    return { precision: tp / (tp + fp || 1), recall: tp / (tp + fn || 1) };
  };
  return { accuracy: ok / total, total, V: of('V'), P: of('P'), N: of('N'), A: of('A'), D: of('D') };
}

test('части речи: на размеченном корпусе (653 слова) точность не ниже порогов', () => {
  const m = metrics();
  assert.ok(m.total >= 600);
  assert.ok(m.accuracy >= 0.93, `общая точность ${(m.accuracy * 100).toFixed(1)}%`);
  assert.ok(m.V.recall >= 0.97, `глаголы, полнота ${(m.V.recall * 100).toFixed(0)}%`);
  assert.ok(m.V.precision >= 0.96, `глаголы, точность ${(m.V.precision * 100).toFixed(0)}%`);
  assert.ok(m.P.recall >= 0.9, `причастия, полнота ${(m.P.recall * 100).toFixed(0)}%`);
  assert.ok(m.P.precision >= 0.95, `причастия, точность ${(m.P.precision * 100).toFixed(0)}%`);
  assert.ok(m.N.recall >= 0.95, `существительные, полнота ${(m.N.recall * 100).toFixed(0)}%`);
});

test('части речи: прошедшее время после согласной основы и короткие формы это глаголы', () => {
  const verbs = 'пришла пришли вышла вышли нашла нашли ушла ушли ушло прошли вошла зашла смолкла смолкло стихла пахло погасла принесла росла замёрзла лил пил бил выл мыл исчез помог'.split(' ');
  assert.deepEqual(verbs.filter((w) => classify(w) !== 'verb'), []);
});

test('части речи: существительные, похожие на глаголы, остаются существительными', () => {
  const nouns = 'игла метла мгла кукла свёкла стекло число село масло кресло весло горло стола угла орла осла петли угли гусли Белла Нелли Изабелла выстрел пепел колокол гости Павел Михаил'.split(' ');
  assert.deepEqual(nouns.filter((w) => classify(w) === 'verb'), []);
});

test('части речи: имя собственное не в начале предложения это существительное', () => {
  const pos = (text, word) => tokenize(text).find((t) => t.text === word).pos;
  assert.equal(pos('Он позвал Павла и Гавриила.', 'Гавриила'), 'noun');
  assert.equal(pos('Вчера пришёл Михаил и долго молчал.', 'Михаил'), 'noun');
  assert.equal(pos('Она сказала: Уйти нельзя.', 'Уйти'), 'verb'); // после двоеточия заглавная буква не признак имени
});

test('части речи: причастия и деепричастия', () => {
  const part = 'закрыто открыто написано запечатано забыто налито закрыта открыта забыта крича звеня глядя неся сидя стоя рассказывая рискуя покрывая произнося'.split(' ');
  assert.deepEqual(part.filter((w) => classify(w) !== 'part'), []);
  assert.equal(classify('молча'), 'adv'); // «молча» наречие, а не деепричастие
  const notPart = 'окно вино зерно бревно пятно полено веретено пшено копыто корыто лето молоко стена цена жена сцена страна поляна'.split(' ');
  assert.deepEqual(notPart.filter((w) => classify(w) === 'part'), []);
});

test('времена: будущее совершенного вида не считается настоящим', () => {
  const future = 'придёт придёшь придут уйдёт найдёт выйдет пойдёт скажет покажет расскажет сделает прочитает напишет посмотрит увидит услышит подумает позвонит поймёт займёт поднимет обнимет положит возьмёт станет'.split(' ');
  assert.deepEqual(future.filter((w) => T.isPresentVerb(w, classify(w))), []);
  const present = 'идёт ведёт смотрит видит слышит понимает думает знает говорит любит ждёт пишет читает стоит сидит лежит живёт работает открывает закрывает кладёт берёт делает кажется показывает рассказывает приходит находит'.split(' ');
  assert.deepEqual(present.filter((w) => !T.isPresentVerb(w, classify(w))), []);
});

test('времена: прошедшее после согласной основы считается прошедшим', () => {
  const count = (text) => {
    const a = analyzeBlock(text);
    return T.analyzeTenseBlock(text, a.words, a.sentences);
  };
  assert.equal(count('Над лесом стихла гроза, и в доме смолкли голоса.').past, 2);
  assert.equal(count('Он знал, что она придёт завтра.').present, 0);
  assert.equal(count('Они вышли на крыльцо и долго стояли молча.').past, 2);
});

test('части речи: прилагательные и наречия на размеченных корпусах (653 + 330 + 222 + 112 слов)', () => {
  const m = metrics([...gold, ...goldMore.flat()]);
  assert.ok(m.total >= 1300);
  assert.ok(m.A.recall >= 0.93, `прилагательные, полнота ${(m.A.recall * 100).toFixed(0)}%`);
  assert.ok(m.A.precision >= 0.88, `прилагательные, точность ${(m.A.precision * 100).toFixed(0)}%`);
  assert.ok(m.D.recall >= 0.85, `наречия, полнота ${(m.D.recall * 100).toFixed(0)}%`);
  assert.ok(m.D.precision >= 0.95, `наречия, точность ${(m.D.precision * 100).toFixed(0)}%`);
  // чистый корпус (слова вне списков): прилагательные ловятся хорошо, наречия вне списка нет, порог фиксирует достигнутое
  const clean = metrics(goldMore[2]);
  assert.ok(clean.A.recall >= 0.85, `чистый корпус, прилагательные ${(clean.A.recall * 100).toFixed(0)}%`);
  assert.ok(clean.D.precision >= 0.95, `чистый корпус, наречия, точность ${(clean.D.precision * 100).toFixed(0)}%`);
});

test('части речи: формы прилагательных, которые по окончанию похожи на существительные', () => {
  const adj = 'тёплом белым тихим тихую жарким последним зыбким большом старом пустом свежим широким ясным красива молода горд рад пуста красивы незнакомого странный туманный естественный ядовитый знакомый'.split(' ');
  assert.deepEqual(adj.filter((w) => classify(w) !== 'adj'), []);
});

test('части речи: наречия на -о и слова состояния', () => {
  const adv = 'тихо резко спокойно осторожно аккуратно вкусно душно прохладно торопливо задумчиво сонно безмятежно честно теперь утром ночью босиком едва порой нужно'.split(' ');
  assert.deepEqual(adv.filter((w) => classify(w) !== 'adv'), []);
  assert.equal(classify('странно', { prev: 'очень' }), 'adv');
  assert.equal(classify('тихо', { prev: 'так' }), 'adv');
});

test('части речи: существительные и глаголы не превращаются в прилагательные и наречия', () => {
  const other = 'столом ножом окном вином сном письмом городом домом лесом лето село окно вино пятно зерно бревно кольцо лицо слово дело тело дым дымом бежим говорим слышим смотрим стоим любим видим решим дышим спешим держим лежим молчим кричим учим топливо пиво кружево диво мука рука вода жена нога гора дорога страна стена полотно блюдо место тесто пшено стекло'.split(' ');
  assert.deepEqual(other.filter((w) => ['adj', 'adv'].includes(classify(w))), []);
});


// ---------- аудит наречий: контекст, слова с дефисом, «-о/-е» не всегда наречие ----------

const posIn = (text, word) => tokenize(text).find((x) => x.text === word).pos;

test('наречия в контексте: «уверенно», «домой», «по-русски» и другие формы', () => {
  assert.equal(posIn('Он уверенно шагнул вперёд.', 'уверенно'), 'adv');
  assert.equal(posIn('Мы вернулись домой поздно.', 'домой'), 'adv');
  assert.equal(posIn('Она ответила по-русски.', 'по-русски'), 'adv');
  for (const w of ['по-английски', 'по-детски', 'по-своему', 'по-прежнему', 'по-зимнему', 'по-хозяйски', 'по-французски']) {
    assert.equal(posIn(`Он ответил ${w} и ушёл.`, w), 'adv', w);
  }
  assert.equal(posIn('Он как-то зашёл к нам.', 'как-то'), 'adv');
  assert.equal(posIn('Приходи когда-нибудь ещё.', 'когда-нибудь'), 'adv');
  assert.equal(posIn('Он кое-как добрался.', 'кое-как'), 'adv');
  assert.equal(posIn('Он что-то пробормотал.', 'что-то'), 'pron');
  assert.equal(posIn('Ты слева, он справа.', 'слева'), 'adv');
  assert.equal(posIn('Он бесшумно вошёл.', 'бесшумно'), 'adv');
  assert.equal(posIn('Он нехорошо поступил.', 'нехорошо'), 'adv');
});

test('наречия: слова на «-о», «-е», «-ски», «-ьма», которые не наречия', () => {
  const nouns = 'окно вино слово письмо кольцо лицо зеркало колесо дерево мясо ведро перо пятно бревно полотно метро кино радио пальто кофе облако молоко яблоко стекло село число сито зарево блюдо кружево пиво лето поле море горе здание платье варенье расстояние состояние объявление'.split(' ');
  assert.deepEqual(nouns.filter((w) => posIn(`Он увидел ${w} вдали.`, w) === 'adv'), []);
  for (const w of ['письма', 'краски', 'сосиски', 'пляски', 'записки', 'маски', 'ласки']) assert.notEqual(posIn(`Рядом лежали ${w} и книга.`, w), 'adv', w);
  assert.equal(posIn('Он весьма доволен.', 'весьма'), 'adv');
  assert.equal(posIn('Он дружески улыбнулся.', 'дружески'), 'adv');
  assert.equal(posIn('Он вёл себя критически.', 'критически'), 'adv');
});

test('наречия: «дома» после предлога существительное, «мимо» и «вокруг» наречия только в конце оборота', () => {
  assert.equal(posIn('У дома росла берёза.', 'дома'), 'noun');
  assert.equal(posIn('Он вышел из дома.', 'дома'), 'noun');
  assert.equal(posIn('Мы шли около дома.', 'дома'), 'noun');
  assert.equal(posIn('Дети играли дома.', 'дома'), 'adv');
  assert.equal(posIn('Он прошёл мимо, не поздоровавшись.', 'мимо'), 'adv');
  assert.equal(posIn('Он прошёл мимо дома.', 'мимо'), 'func');
  assert.equal(posIn('Он оглянулся вокруг.', 'вокруг'), 'adv');
  assert.equal(posIn('Вокруг дома шумел лес.', 'Вокруг'), 'func');
  // без контекста классификатор ведёт себя как раньше
  assert.equal(classify('мимо'), 'func');
  assert.equal(classify('дома'), 'adv');
});

test('наречия: слово после «так» или «совсем» не наречие только потому, что оно на «-о»', () => {
  assert.notEqual(posIn('Так окно не закрывается.', 'окно'), 'adv');
  assert.notEqual(posIn('Так вино не наливают.', 'вино'), 'adv');
  assert.notEqual(posIn('Совсем дело плохо.', 'дело'), 'adv');
  assert.equal(posIn('Он говорил так тихо.', 'тихо'), 'adv');
  assert.equal(posIn('Ему было очень уютно.', 'уютно'), 'adv');
});
