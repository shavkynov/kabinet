'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../src/tense');
const { tokenize, sentences } = require('../src/morph');

function run(text) {
  const words = tokenize(text);
  return T.analyzeTenseBlock(text, words, sentences(text, words));
}
const found = (text) => run(text).items.filter((i) => i.kind === 'past').map((i) => text.slice(i.start, i.end));

test('время: прошедшее среди настоящего находится', () => {
  assert.deepEqual(found('Он входит в комнату и сказал тихо.'), ['сказал']);
  assert.equal(run('Он входит в комнату. Она берёт чашку.').past, 0);
});

test('время: прямая речь, кавычки и воспоминания не считаются', () => {
  assert.deepEqual(found('— Я пришёл вчера, — говорит он.'), []);
  assert.deepEqual(found('Он говорит: «Она ушла».'), []);
  assert.deepEqual(found('Он молчит. Вчера она ушла домой.'), []);
  assert.deepEqual(found('Он вспоминает, как она ушла.'), []);
});

test('время: основное время главы', () => {
  assert.equal(T.detectBase(1, 2), 'unknown');
  assert.equal(T.detectBase(1, 9), 'present');
  assert.equal(T.detectBase(9, 1), 'past');
});

test('время: прошедшее повествование и глагол настоящего', () => {
  const r = run('Он вошёл в комнату. Она сидела у окна и смотрит на него.');
  assert.deepEqual(r.items.filter((i) => i.kind === 'present').map((i) => 'смотрит'), ['смотрит']);
  assert.ok(r.past >= 2);
});

// ---- И2: основное время по главным предложениям, придаточные, мысли, уверенность находок ----
const { analyzeBlock } = require('../src/morph');

/** Как в окне: считаем по всем абзацам, находки только «не того» времени. */
function chapter(paras) {
  let past = 0;
  let present = 0;
  const results = paras.map((p) => {
    const a = analyzeBlock(p);
    const r = T.analyzeTenseBlock(p, a.words, a.sentences);
    past += r.past;
    present += r.present;
    return { p, r };
  });
  const base = T.detectBase(past, present);
  const odd = base === 'present' ? 'past' : base === 'past' ? 'present' : null;
  const flagged = [];
  for (const { p, r } of results) for (const it of r.items) if (it.kind === odd) flagged.push({ word: p.slice(it.start, it.end), conf: it.conf, why: it.why });
  return { past, present, base, flagged };
}

test('время: настоящее в придаточных не переворачивает основное время', () => {
  const r = chapter([
    'Она сказала, что любит его, что ждёт его, что верит ему.',
    'Он ответил, что знает, что понимает, что согласен.',
    'Потом он ушёл.',
  ]);
  assert.equal(r.present, 0);
  assert.deepEqual(r.flagged, []);
  const r2 = chapter(['Он знал, что она любит его. Она сказала, что ждёт. Он видел, что она плачет. Она призналась, что боится.', 'Потом он вошёл в дом и сел за стол. Она посмотрела на него и вздохнула.']);
  assert.equal(r2.base, 'past');
  assert.deepEqual(r2.flagged, []);
});

test('время: придаточные с «как», «чтобы», «который», «когда» и вводное придаточное', () => {
  assert.equal(run('Они сидели у окна и слушали, как капли стучат по крыше.').present, 0);
  assert.equal(run('Она любила, когда идёт дождь.').present, 0);
  assert.equal(run('Дом, который стоит на холме, принадлежал старику.').present, 0);
  assert.equal(run('Он вернулся, чтобы увидеть, как она спит.').present, 0);
  const r = run('Когда шёл дождь, он сидел дома.');
  assert.equal(r.past, 1);
  assert.equal(r.present, 0);
  // главная часть после придаточного считается
  assert.equal(run('Когда идёт дождь, он сидит дома.').present, 1);
  // вопрос с «когда» без запятой придаточным не считается: глагол остаётся главным
  assert.equal(run('Когда он ушёл?').past, 1);
});

test('время: «, и вышел» после придаточного снова главная часть', () => {
  const r = run('Он знал, что она любит его, и вышел.');
  assert.equal(r.present, 0);
  assert.equal(r.past, 2);
});

test('время: мысль или речь без кавычек не считается', () => {
  assert.deepEqual(chapter(['Он вошёл в комнату и сел. Вода кипит при ста градусах, подумал он. Потом он взял чайник.', 'Она вернулась через час и ничего не сказала.']).flagged, []);
  assert.deepEqual(chapter(['Он остановился и подумал: она любит меня. Он вздохнул.', 'Потом он вернулся в дом и лёг спать. Она спала.']).flagged, []);
  // а обычная фраза с глаголом «подумала» в конце не прячет настоящую ошибку
  assert.equal(run('Она вошла в комнату, подумала о нём.').past, 3 - 1);
});

test('время: уверенность находок (смешение, герой, описание)', () => {
  const mixed = chapter(['Он вошёл в комнату и остановился. Она посмотрела на него и вдруг встаёт со стула. Он молчал.', 'Потом он сел за стол, взял перо и начал писать.']);
  assert.deepEqual(mixed.flagged.map((f) => [f.word, f.conf, f.why]), [['встаёт', 'high', 'mixed']]);
  const actor = chapter(['Он вошёл в комнату и остановился. Она смотрела на него и молчала. Она улыбается. Он ответил.', 'Потом он сел за стол и взял перо.']);
  assert.deepEqual(actor.flagged.map((f) => [f.word, f.conf, f.why]), [['улыбается', 'high', 'actor']]);
  const desc = chapter(['Мы шли весь день. Дорога идёт через лес, потом спускается к реке. К вечеру мы дошли до моста.', 'Он остановился и долго смотрел вниз.']);
  assert.deepEqual(desc.flagged.map((f) => [f.word, f.conf, f.why]), [['идёт', 'low', 'description'], ['спускается', 'low', 'description']]);
});

test('время: ничья при определении основного времени не угадывается', () => {
  assert.equal(T.detectBase(4, 4), 'unknown');
  assert.equal(T.detectBase(5, 4), 'past');
  assert.equal(T.detectBase(4, 5), 'present');
});

test('время: реальные ошибки по-прежнему находятся', () => {
  assert.deepEqual(chapter(['Он входит в комнату и останавливается. Она смотрит на него и молчит.', 'Он подошёл к ней и берёт её за руку. Она улыбается.']).flagged.map((f) => f.word), ['подошёл']);
  assert.deepEqual(chapter(['Он вскарабкался на крышу и замер. Ветер трепал ему волосы. Внизу копошатся люди.', 'Он спрыгнул, споткнулся и упал.']).flagged.map((f) => f.word), ['копошатся']);
});
