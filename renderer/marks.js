// Показ скрытых символов (¶, неразрывные пробелы, табуляции…): метки рисуются поверх текста декорациями,
// документ, копирование и экспорт не меняются. По умолчанию выключено.

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { scanMarks } from '../src/marks.js';
import { isBig, lazyView } from './lazy.js';

export const marksKey = new PluginKey('hiddenMarks');

const marksNodeCache = new WeakMap();
function textMarks(node, spaces) {
  let cached = marksNodeCache.get(node);
  if (cached && cached.spaces === spaces) return cached.hits;
  const hits = scanMarks(node.text, spaces);
  marksNodeCache.set(node, { spaces, hits });
  return hits;
}

function build(doc, spaces) {
  const decos = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock) decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'mk-para' }));
    if (node.type.name === 'hardBreak') {
      const w = document.createElement('span');
      w.className = 'mk-br';
      w.contentEditable = 'false';
      decos.push(Decoration.widget(pos, w, { side: -1, key: 'br' }));
    }
    if (node.isText) {
      for (const m of textMarks(node, spaces)) decos.push(Decoration.inline(pos + m.at, pos + m.at + 1, { class: m.cls }));
    }
  });
  return DecorationSet.create(doc, decos);
}

export const HiddenMarks = Extension.create({
  name: 'hiddenMarks',
  addOptions() { return { getOptions: () => ({ on: false, spaces: false }) }; },
  addProseMirrorPlugins() {
    const getOptions = this.options.getOptions;
    return [new Plugin({
      key: marksKey,
      state: {
        init: () => ({ set: DecorationSet.empty, doc: null, on: false, spaces: false, stale: false }),
        apply(tr, old, _o, state) {
          const o = getOptions();
          const on = !!o.on, spaces = !!o.spaces;
          if (!on) return old.on ? { set: DecorationSet.empty, doc: null, on: false, spaces, stale: false } : old;
          if (tr.getMeta(marksKey)) return { set: build(state.doc || tr.doc, spaces), doc: tr.doc, on: true, spaces, stale: false };
          if (old.on && old.spaces === spaces && old.doc === tr.doc && !old.stale) return old;
          if (old.on && old.spaces === spaces && tr.docChanged && isBig(tr.doc)) {
            return { set: old.set.map(tr.mapping, tr.doc), doc: tr.doc, on: true, spaces, stale: true };
          }
          return { set: build(state.doc || tr.doc, spaces), doc: tr.doc, on: true, spaces, stale: false };
        },
      },
      props: { decorations(state) { return marksKey.getState(state).set; } },
      view: lazyView(marksKey, (st) => !!marksKey.getState(st).stale),
    })];
  },
});

/** Перерисовать метки после смены настройки. */
export function refreshMarks(editor) {
  if (editor && editor.view) editor.view.dispatch(editor.state.tr.setMeta(marksKey, 1).setMeta('addToHistory', false));
}
