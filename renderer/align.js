// Выравнивание абзаца: по центру и по правому краю. В файле главы это «-> текст <-» и «-> текст ->» (см. src/align.js).

import { Node, mergeAttributes } from '@tiptap/core';

// Обычный абзац редактора (как в StarterKit) плюс выравнивание.
export const AlignParagraph = Node.create({
  name: 'paragraph',
  priority: 1000,
  group: 'block',
  content: 'inline*',
  parseHTML() { return [{ tag: 'p' }]; },
  renderHTML({ HTMLAttributes }) { return ['p', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0]; },
  addOptions() { return { HTMLAttributes: {} }; },
  addCommands() { return { setParagraph: () => ({ commands }) => commands.setNode(this.name) }; },
  addKeyboardShortcuts() { return { 'Mod-Alt-0': () => this.editor.commands.setParagraph() }; },
  addAttributes() {
    return {
      textAlign: {
        default: null,
        parseHTML: (el) => { const a = el.getAttribute('data-align'); return a === 'center' || a === 'right' ? a : null; },
        renderHTML: (attrs) => (attrs.textAlign ? { 'data-align': attrs.textAlign } : {}),
      },
    };
  },
  addStorage() {
    return {
      markdown: {
        serialize(state, node) {
          const a = node.attrs.textAlign;
          if (a && node.content.size) {
            state.write('-> ');
            state.renderInline(node);
            state.write(a === 'right' ? ' ->' : ' <-');
          } else {
            state.renderInline(node);
          }
          state.closeBlock(node);
        },
        parse: {
          updateDOM(element) {
            element.querySelectorAll('p').forEach((p) => {
              const m = /^-&gt;\s+([\s\S]*?)\s+(&lt;-|-&gt;)$/.exec(p.innerHTML.trim());
              if (!m || !m[1]) return;
              p.innerHTML = m[1];
              p.setAttribute('data-align', m[2] === '&lt;-' ? 'center' : 'right');
            });
          },
        },
      },
    };
  },
});

/** Цепочка команд: ставит выравнивание текущему абзацу; повторный выбор того же возвращает обычное. */
export function toggleAlign(editor, chain, align) {
  const cur = editor.getAttributes('paragraph').textAlign || null;
  return chain.updateAttributes('paragraph', { textAlign: cur === align ? null : align });
}
