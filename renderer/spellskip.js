// Слова из словаря проекта и «пропущенные» не подчёркиваются системной проверкой орфографии.
// В Electron это делал сам движок (addWordToSpellCheckerDictionary); в Tauri окно рисует волну само и API у него нет,
// поэтому такие слова оборачиваются в <span spellcheck="false">: текст главы при этом не меняется.

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

const skipKey = new PluginKey('spellSkip');
const WORD = /[\p{L}\p{M}][\p{L}\p{M}'’-]*/gu;
let dict = new Set();    // словарь проекта (нижний регистр)
let ignored = new Set(); // «Пропустить» до закрытия приложения

const norm = (w) => String(w).trim().replace(/-+$/, '').toLowerCase();

function decorate(doc) {
  if (!dict.size && !ignored.size) return DecorationSet.empty;
  const decos = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const text = node.textBetween(0, node.content.size, undefined, '￼');
    WORD.lastIndex = 0;
    let m;
    while ((m = WORD.exec(text)) !== null) {
      const key = norm(m[0]);
      if (dict.has(key) || ignored.has(key)) {
        const from = pos + 1 + m.index;
        decos.push(Decoration.inline(from, from + m[0].length, { spellcheck: 'false' }));
      }
    }
    return false;
  });
  return DecorationSet.create(doc, decos);
}

export const SpellSkip = Extension.create({
  name: 'spellSkip',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: skipKey,
      state: {
        init: (_, { doc }) => decorate(doc),
        apply: (tr, old) => (tr.docChanged || tr.getMeta(skipKey) ? decorate(tr.doc) : old),
      },
      props: { decorations: (state) => skipKey.getState(state) },
    })];
  },
});

function redraw(editor) {
  if (editor && editor.view) editor.view.dispatch(editor.state.tr.setMeta(skipKey, true));
}

/** Заменить список слов словаря и перерисовать. */
export function setSpellSkipWords(editor, words) {
  dict = new Set((words || []).map(norm).filter(Boolean));
  redraw(editor);
}

/** «Пропустить»: слово не подчёркивается до перезапуска. */
export function ignoreSpellWord(editor, word) {
  const k = norm(word);
  if (k) ignored.add(k);
  redraw(editor);
}

export const isSpellSkipped = (word) => { const k = norm(word); return dict.has(k) || ignored.has(k); };

/** Слово, на которое указывают координаты: { word, from, to } или null, если там не слово. */
export function wordRangeAtPoint(editor, x, y) {
  const hit = editor.view.posAtCoords({ left: x, top: y });
  if (!hit) return null;
  const $pos = editor.state.doc.resolve(hit.pos);
  if (!$pos.parent.isTextblock) return null;
  const text = $pos.parent.textBetween(0, $pos.parent.content.size, undefined, '￼');
  const off = $pos.parentOffset;
  WORD.lastIndex = 0;
  let m;
  while ((m = WORD.exec(text)) !== null) {
    if (off >= m.index && off <= m.index + m[0].length) {
      const word = m[0].replace(/-+$/, '');
      const from = $pos.start() + m.index;
      return { word, from, to: from + word.length };
    }
  }
  return null;
}

export function wordAtPoint(editor, x, y) {
  const r = wordRangeAtPoint(editor, x, y);
  return r ? r.word : '';
}
