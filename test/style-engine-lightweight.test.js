'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { findChainsLight, findWhichLight } = require('../src/style-engine/lightweight');

const frags = (hits, text) => hits.map((h) => text.slice(h.start, h.end));

test('A1: цепочка с прилагательным и формами родительного вида', () => {
  const text = 'Осуществление важной проверки выполнения требований затянулось.';
  assert.deepEqual(frags(findChainsLight(text, 'A1'), text), ['Осуществление важной проверки выполнения требований']);
});

test('A1: запятая, союз и случайное соседство не считаются цепочкой', () => {
  for (const text of [
    'Осуществление проверки, выполнения требований затянулось.',
    'Осуществление проверки и выполнения требований затянулось.',
    'Он вошёл в дом отца брата.',
    'Здание министерства образования и науки было построено.',
    'Ожидание затянулось.',
  ]) {
    assert.deepEqual(findChainsLight(text, 'A1'), [], text);
  }
});

test('A1: лексикализованное «здание» не засчитывает хвост', () => {
  const text = 'Осуществление проверки выполнения здания.';
  assert.deepEqual(findChainsLight(text, 'A1'), []);
});

test('A2: предложная цепочка найдена, A1 воздерживается', () => {
  const text = 'Вопрос о необходимости проведения проверки обсуждался.';
  assert.deepEqual(findChainsLight(text, 'A1'), []);
  assert.deepEqual(frags(findChainsLight(text, 'A2'), text), ['Вопрос о необходимости проведения проверки']);
});

test('A2: обычная предложная группа без цепочки не срабатывает', () => {
  for (const text of [
    'Он вошёл в дом отца.',
    'Разговор о жизни затянулся.',
    'Письмо от брата пришло.',
    'Осуществление проверки выполнения требований затянулось.',
  ]) {
    assert.deepEqual(findChainsLight(text, 'A2'), [], text);
  }
});

test('A2: местоимения и числительные разрывают цепочку', () => {
  const text = 'Осуществление проверки двух требований затянулось.';
  assert.deepEqual(findChainsLight(text, 'A2'), []);
});

test('B1: три маркера — эвристика перегруженности', () => {
  const text = 'Это человек, который знал, что дом, который стоит у реки, продаётся.';
  assert.deepEqual(frags(findWhichLight(text, 'B1'), text), [text]);
});

test('B1: два маркера не срабатывают', () => {
  const text = 'Это человек, который знал, что дом продаётся.';
  assert.deepEqual(findWhichLight(text, 'B1'), []);
});

test('B1: «что-то», «что ли» — не придаточные', () => {
  for (const text of [
    'Он знал, что-то случилось, что-то важное, что-то ещё.',
    'Он знал, что ли, что ли, что ли.',
    'Он сказал, что-то, что-то, что-то.',
  ]) {
    assert.deepEqual(findWhichLight(text, 'B1'), [], text);
  }
});

test('B1: составные союзы учитываются как маркеры, но не доказывают перегруженность', () => {
  const two = 'Он знал, что дом, который стоял.';
  assert.deepEqual(findWhichLight(two, 'B1'), []);
  const three = 'Он знал, что дом, который стоял, потому что был дождь, что всё изменилось.';
  const hits = findWhichLight(three, 'B1');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].fragment, three);
});

test('B1: уступительное «что бы ни» — полноценная клауза, не мусорный маркер', () => {
  const text = 'Что бы ни случилось, что бы ни было, что бы ни говорили, он останется.';
  assert.equal(findWhichLight(text, 'B1').length, 1);
});

test('B1: речь героев не считается', () => {
  const text = 'Он сказал: «Дом, который стоял, который видел лес, который шумел».';
  assert.deepEqual(findWhichLight(text, 'B1'), []);
});

test('B2: три пунктуационных сегмента с глаголами', () => {
  const text = 'Он знал, что дом, который стоял, потому что был дождь, что всё изменилось.';
  assert.equal(findWhichLight(text, 'B2').length, 1);
});

test('B2: перечисление без глаголов не срабатывает', () => {
  const text = 'Он знал, что дом, который сад, который лес, который берег.';
  assert.deepEqual(findWhichLight(text, 'B2'), []);
});

test('B1: «так что» — отдельная группа, не автоматический мусор', () => {
  const one = 'Дом, который стоял у реки, так что все видели его.';
  assert.equal(findWhichLight(one, 'B1').length, 0);
  const three = 'Дом, который стоял у реки, так что все видели, что он старый.';
  assert.equal(findWhichLight(three, 'B1').length, 1);
});

test('B1: «несмотря на то что» — отдельная группа', () => {
  const one = 'Он вышел, несмотря на то что было холодно.';
  assert.equal(findWhichLight(one, 'B1').length, 0);
  const three = 'Он вышел, несмотря на то что было холодно, хотя знал, что дом, который стоял, пуст.';
  assert.equal(findWhichLight(three, 'B1').length, 1);
});

test('B1: «при том что» — отдельная группа', () => {
  const one = 'Он вышел, при том что было холодно.';
  assert.equal(findWhichLight(one, 'B1').length, 0);
  const three = 'Он вышел, при том что было холодно, хотя знал, что дом, который стоял, пуст.';
  assert.equal(findWhichLight(three, 'B1').length, 1);
});

test('B1: «потому что» — отдельная группа', () => {
  const one = 'Он знал, что дом, который стоял, потому что был дождь.';
  assert.equal(findWhichLight(one, 'B1').length, 1); // три маркера
  const two = 'Он знал, что дом, потому что был дождь.';
  assert.equal(findWhichLight(two, 'B1').length, 0);
});
