// Показ скрытых символов (¶, неразрывные пробелы, табуляции…): метки рисуются поверх текста декорациями,
// документ, копирование и экспорт не меняются. По умолчанию выключено.

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { scanMarks } from '../src/marks.js';

export const marksKey = new PluginKey('hiddenMarks');

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
      for (const m of scanMarks(node.text, spaces)) decos.push(Decoration.inline(pos + m.at, pos + m.at + 1, { class: m.cls }));
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
        init: () => ({ set: DecorationSet.empty, doc: null, on: false, spaces: false }),
        apply(tr, old, _o, state) {
          const o = getOptions();
          const on = !!o.on, spaces = !!o.spaces;
          if (!on) return old.on ? { set: DecorationSet.empty, doc: null, on: false, spaces } : old;
          if (old.on && old.spaces === spaces && old.doc === tr.doc) return old;
          return { set: build(state.doc || tr.doc, spaces), doc: tr.doc, on, spaces };
        },
      },
      props: { decorations(state) { return marksKey.getState(state).set; } },
    })];
  },
});

/** Перерисовать метки после смены настройки. */
export function refreshMarks(editor) {
  if (editor && editor.view) editor.view.dispatch(editor.state.tr.setMeta(marksKey, 1).setMeta('addToHistory', false));
}
