'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const en = require('../src/en');
const { typeChar, fixText, applyEdits } = require('../src/typo');
const { analyzeRhythm } = require('../src/rhythm');
const { compileFillers, findFillers, repeatPairs, DEFAULT_FILLERS } = require('../src/editing');

const pos = (text) => Object.fromEntries(en.tokenize(text).map((w) => [w.text.toLowerCase(), w.pos]));
const passive = (text) => en.analyzeBlock(text).passive.map((p) => text.slice(p.start, p.end));
const tense = (text) => {
  const b = en.analyzeBlock(text);
  return en.analyzeTenseBlock(text, b.words, b.sentences).items.map((i) => `${i.kind}:${text.slice(i.start, i.end)}`);
};

test('английский: части речи', () => {
  const p = pos('The old man quickly walked into a dark room.');
  assert.equal(p.old, 'adj');
  assert.equal(p.man, 'noun');
  assert.equal(p.quickly, 'adv');
  assert.equal(p.walked, 'verb');
  assert.equal(p.dark, 'adj');
  assert.equal(p.room, 'noun');
  assert.equal(pos('She was running home.').running, 'part');
  assert.equal(pos('He opened the door and John smiled.').john, 'noun');
  // регрессии: неизвестное слово перед глаголом прошедшего, perfect, обычные прилагательные
  assert.equal(pos('The door slammed shut behind her.').door, 'noun');
  assert.equal(pos('She had lost her keys.').lost, 'part');
  assert.equal(pos('They were hungry and tired.').hungry, 'adj');
});

test('английский: пассивный залог', () => {
  assert.deepEqual(passive('The door was opened slowly.'), ['was opened']);
  assert.deepEqual(passive('The house was being built by workers.'), ['was being built']);
  assert.deepEqual(passive('She was tired and he was excited.'), []);
  assert.deepEqual(passive('He opened the door.'), []);
  assert.deepEqual(passive('The letters were never sent.'), ['were never sent']);
});

test('английский: предложения и аббревиатуры', () => {
  const s = en.sentences('Mr. Smith came in. “Really?” she asked. It was 3.5 km away.');
  assert.equal(s.length, 3);
});

test('английский: несогласованность времён', () => {
  assert.deepEqual(tense('She walks into the room and sat down.'), ['present:walks', 'past:sat']);
  assert.deepEqual(tense('He opens the door. “I came yesterday,” he says.'), ['present:opens', 'present:says']);
  assert.deepEqual(tense('She sees the light. Yesterday he walked home.').filter((x) => x.startsWith('past')), []);
  assert.deepEqual(tense('He had been there before. She walked in.').filter((x) => x.includes('had')), []);
});

test('английский: повторы, паразиты, ритм', () => {
  const seq = ['walked', 'walking', 'sky', 'walk'].map((text) => ({ text, pos: 'verb' }));
  assert.equal(repeatPairs(seq, 10).length, 1);
  const re = compileFillers(DEFAULT_FILLERS.en);
  const text = 'It was really just a very quiet night.';
  assert.deepEqual(findFillers(text, re).map((m) => text.slice(m.start, m.end)), ['really', 'just', 'very']);
  const sents = ['and', 'and', 'and', 'but'].map((first) => ({ words: 5, first, dialogue: false }));
  assert.equal(analyzeRhythm(sents, en.ANAPHORA_STARTS).items.filter((i) => i.type === 'start').length, 0); // для «And» порог 4
});

test('английская типографика: кавычки, апостроф, тире', () => {
  const o = { lang: 'en' };
  assert.deepEqual(typeChar('', '"', o), { del: 0, ins: '“' });
  assert.deepEqual(typeChar('He said “hi', '"', o), { del: 0, ins: '”' });
  assert.deepEqual(typeChar('don', "'", o), { del: 0, ins: '’' });
  assert.deepEqual(typeChar('Wait-', '-', o), { del: 1, ins: '—' });
  assert.equal(applyEdits('He said "hi" -- don\'t', fixText('He said "hi" -- don\'t', o)), 'He said “hi” — don’t');
});

test('экспорт на английском: язык документа', () => {
  const { buildDocx } = require('../src/docx');
  const zlib = require('node:zlib');
  const buf = buildDocx('Book', [{ title: 'One', text: 'Text.' }], { lang: 'en' });
  // поиск styles.xml в архиве: имена хранятся без сжатия, данные сжаты deflate
  let p = 0;
  let styles = '';
  while (buf.readUInt32LE(p) === 0x04034b50) {
    const size = buf.readUInt32LE(p + 18);
    const n = buf.readUInt16LE(p + 26);
    const name = buf.slice(p + 30, p + 30 + n).toString('utf8');
    if (name === 'word/styles.xml') styles = zlib.inflateRawSync(buf.slice(p + 30 + n, p + 30 + n + size)).toString('utf8');
    p += 30 + n + size;
  }
  assert.ok(styles.includes('w:val="en-US"') && !styles.includes('ru-RU'));
});
