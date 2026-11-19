'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { conlluToContract } = require('../src/style-engine/conllu-contract');
const { analyzeStructural } = require('../src/style-engine/structural');
const { validateParseResult } = require('../src/style-engine/contract');

const text = 'Осуществление проверки выполнения требований затянулось.';
const conllu = `# text = ${text}
1	Осуществление	осуществление	NOUN	_	Animacy=Inan|Case=Nom|Gender=Neut|Number=Sing	5	nsubj	_	_
2	проверки	проверка	NOUN	_	Animacy=Inan|Case=Gen|Gender=Fem|Number=Sing	1	nmod	_	_
3	выполнения	выполнение	NOUN	_	Animacy=Inan|Case=Gen|Gender=Neut|Number=Sing	2	nmod	_	_
4	требований	требование	NOUN	_	Animacy=Inan|Case=Gen|Gender=Neut|Number=Plur	3	nmod	_	_
5	затянулось	затянуться	VERB	_	Aspect=Perf|Gender=Neut|Mood=Ind|Number=Sing|Tense=Past|VerbForm=Fin	0	root	_	_
6	.	.	PUNCT	_	_	5	punct	_	_
`;

test('CoNLL-U → contract: валидные UTF-16 offsets и структурная находка', () => {
  const parsed = conlluToContract(text, conllu, { name: 'udpipe', version: 'test' });
  assert.deepEqual(validateParseResult(text, parsed), { valid: true, errors: [] });
  assert.equal(parsed.sentences[0].text, text);
  assert.equal(parsed.sentences[0].tokens[0].start, 0);
  assert.equal(parsed.sentences[0].tokens[0].end, 'Осуществление'.length);
  const hits = analyzeStructural(text, parsed, { chain: true }).chain;
  assert.equal(hits.length, 1);
  assert.equal(hits[0].fragment, 'Осуществление проверки выполнения требований');
});

test('CoNLL-U → contract: два предложения сохраняют порядок и offsets', () => {
  const src = 'Он вошёл. Дом стоял.';
  const two = `# text = Он вошёл.
1	Он	он	PRON	_	Case=Nom	2	nsubj	_	_
2	вошёл	войти	VERB	_	VerbForm=Fin	0	root	_	_
3	.	.	PUNCT	_	_	2	punct	_	_

# text = Дом стоял.
1	Дом	дом	NOUN	_	Case=Nom	2	nsubj	_	_
2	стоял	стоять	VERB	_	VerbForm=Fin	0	root	_	_
3	.	.	PUNCT	_	_	2	punct	_	_
`;
  const parsed = conlluToContract(src, two);
  assert.equal(parsed.sentences.length, 2);
  assert.equal(parsed.sentences[1].start, 10);
  assert.equal(src.slice(parsed.sentences[1].start, parsed.sentences[1].end), 'Дом стоял.');
  assert.deepEqual(validateParseResult(src, parsed), { valid: true, errors: [] });
});
