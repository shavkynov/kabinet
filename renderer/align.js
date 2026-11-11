// Выравнивание и пустые абзацы. Пустые абзацы верхнего уровня хранятся обычными переводами строк.

import { Node, mergeAttributes } from '@tiptap/core';

function preserveEmptyParagraphs(md) {
  if (md.__kabinetEmptyParagraphs) return;
  md.__kabinetEmptyParagraphs = true;
  md.core.ruler.after('block', 'kabinet_empty_paragraphs', (state) => {
    if (state.inlineMode) return;
    const lines = state.src.split('\n');
    const tokens = [];
    let end = 0;
    let seen = false;
    const empty = (count) => {
      for (let i = 0; i < count; i += 1) {
        const open = new state.Token('paragraph_open', 'p', 1);
        const close = new state.Token('paragraph_close', 'p', -1);
        open.block = close.block = true;
        open.level = close.level = 0;
        tokens.push(open, close);
      }
    };
    for (const token of state.tokens) {
      if (token.level === 0 && token.map && token.nesting !== -1) {
        const start = token.map[0];
        const gap = lines.slice(end, start);
        if (gap.every((line) => /^[ \t]*$/.test(line))) empty(Math.max(0, gap.length - (seen ? 1 : 0)));
        end = token.map[1];
        seen = true;
      }
      tokens.push(token);
    }
    const tail = lines.slice(end);
    if (tail.every((line) => /^[ \t]*$/.test(line))) {
      if (seen) empty(Math.max(0, tail.length - 2));
      else empty(Math.max(0, tail.length - (state.src.endsWith('\n') ? 1 : 0)));
    }
    state.tokens = tokens;
  });
}

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
        serialize(state, node, parent) {
          if (parent?.type.name === 'doc' && node.content.size === 0) {
            state.write('\n');
            return;
          }
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
          setup: preserveEmptyParagraphs,
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

export function toggleAlign(editor, chain, align) {
  const cur = editor.getAttributes('paragraph').textAlign || null;
  return chain.updateAttributes('paragraph', { textAlign: cur === align ? null : align });
}
