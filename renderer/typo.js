// Типографика при наборе: кавычки «», тире, многоточие, неразрывные пробелы.
// Правила в src/typo.js (с тестами). Здесь только подключение к редактору.

import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { typeChar, fixText } from '../src/typo.js';

export const Typography = Extension.create({
  name: 'typography',
  priority: 1000, // раньше правил Markdown: «- » в начале абзаца это реплика диалога, а не список
  addOptions() { return { getOptions: () => ({ quotes: true, dashes: true, nbsp: true, enabled: true }) }; },
  addProseMirrorPlugins() {
    const opts = this.options;
    return [new Plugin({
      props: {
        handleTextInput(view, from, to, text) {
          const o = opts.getOptions();
          if (!o.enabled || text.length !== 1 || from !== to || view.composing) return false;
          const $from = view.state.doc.resolve(from);
          const parent = $from.parent;
          if (!parent.isTextblock || parent.type.name === 'codeBlock') return false;
          const before = parent.textBetween(0, $from.parentOffset, '', '￼');
          const r = typeChar(before, text, o);
          if (!r) return false;
          view.dispatch(view.state.tr.insertText(r.ins, from - r.del, to));
          return true;
        },
      },
    })];
  },
});

/** Приводит типографику всей главы в порядок одной правкой (одна отмена на всё). Возвращает { fixed, removed }: число исправленных мест и убранных пустых абзацев. */
export function fixDocTypography(editor, o) {
  const { state } = editor;
  const edits = [];
  let removed = 0;
  const blank = (node) => {
    let only = true;
    node.forEach((c) => { if (!c.isText || /\S/.test(c.text)) only = false; });
    return only;
  };
  // Пустые абзацы между абзацами (о.dropEmpty): отступ между абзацами дают поля или красная строка, а не лишние пустые строки.
  const empties = new Set();
  if (o.dropEmpty) {
    state.doc.forEach((node, offset) => { if (node.type.name === 'paragraph' && blank(node)) empties.add(offset); });
    if (empties.size >= state.doc.childCount) empties.clear(); // пустой документ не трогаем
  }
  state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (empties.has(pos)) {
      edits.push({ from: pos, to: pos + node.nodeSize, text: '' });
      removed += 1;
      return false;
    }
    if (node.type.name !== 'codeBlock') {
      const text = node.textBetween(0, node.content.size, '', '￼');
      for (const e of fixText(text, o)) edits.push({ from: pos + 1 + e.from, to: pos + 1 + e.to, text: e.text });
    }
    return false;
  });
  if (!edits.length) return { fixed: 0, removed: 0 };
  const tr = state.tr;
  for (const e of edits.reverse()) {
    if (e.text) tr.insertText(e.text, e.from, e.to);
    else tr.delete(e.from, e.to);
  }
  editor.view.dispatch(tr);
  return { fixed: edits.length - removed, removed };
}
