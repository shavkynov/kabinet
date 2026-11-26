'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { clipboardPlain, INDENT } = require('../src/clip');
const { mdToText } = require('../src/export');

const P = (text, partial) => ({ kind: 'paragraph', text, partial });

test('копирование: абзацы через пустую строку, разделитель строкой ***', () => {
  const out = clipboardPlain([P('Раз'), { kind: 'rule' }, P('Два')]);
  assert.equal(out, 'Раз\n\n***\n\nДва');
});

test('копирование: красная строка только в режиме «Красная строка»', () => {
  assert.equal(clipboardPlain([P('Раз'), P('Два')]), 'Раз\n\nДва');
  assert.equal(clipboardPlain([P('Раз'), P('Два')], { indent: true }), `${INDENT}Раз\n\n${INDENT}Два`);
});

test('копирование: красная строка после разделителя есть, после заголовка и цитаты нет, у уже сдвинутого и обрезанного не удваивается', () => {
  const out = clipboardPlain([
    { kind: 'heading', text: 'Глава' }, P('После заголовка'),
    { kind: 'rule' }, P('После разделителя'),
    { kind: 'quote', text: 'Цитата' }, P('После цитаты'),
    P(`${INDENT}Уже с отступом`), P('', false), P('С середины', true),
  ], { indent: true });
  assert.equal(out, ['Глава', 'После заголовка', '***', `${INDENT}После разделителя`, 'Цитата', 'После цитаты', `${INDENT}Уже с отступом`, '', 'С середины'].join('\n\n'));
});

test('экспорт в текст: красная строка и разделитель ***', () => {
  const md = 'Первый\n\nВторой\n\n---\n\nТретий\n\n## Часть\n\nПосле заголовка\n\n- пункт';
  assert.equal(mdToText(md), 'Первый\n\nВторой\n\n***\n\nТретий\n\nЧасть\n\nПосле заголовка\n\n— пункт');
  assert.equal(mdToText(md, { indent: true }), [`${INDENT}Первый`, `${INDENT}Второй`, '***', `${INDENT}Третий`, 'Часть', 'После заголовка', '— пункт'].join('\n\n'));
});

test('буфер HTML: разделитель *** сериализуется в центрированный абзац и распознаётся обратно', async () => {
  const { Schema } = require('@tiptap/pm/model');
  const { createClipboardSerializer, KabinetRule } = await import('../renderer/align.js');
  const schema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { group: 'block', content: 'text*' },
      horizontalRule: { group: 'block' },
      text: { group: 'inline' },
    },
  });
  const serializer = createClipboardSerializer(schema);
  assert.deepEqual(serializer.nodes.horizontalRule(), [
    'p',
    { 'data-kabinet-rule': '1', style: 'text-align: center;' },
    '***',
  ]);
  const rules = KabinetRule.config.parseHTML();
  assert.ok(rules.some((r) => r.tag === 'p[data-kabinet-rule]' && r.priority > 1000));
});
