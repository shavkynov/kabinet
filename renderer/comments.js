// Комментарии к фрагментам текста: жёлтая подсветка поверх текста (сам текст и Markdown не меняются).
// Плагин хранит только диапазоны; тексты комментариев и привязка (цитата с окружением) живут в renderer/app/34-comments.js.
// Диапазоны сопровождают правки через DecorationSet.map: удалённый фрагмент исчезает из набора.

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export const commentsKey = new PluginKey('chapterComments');

function deco(r, active) {
  return Decoration.inline(r.from, r.to, { class: `cmt${active === r.id ? ' cmt-active' : ''}`, 'data-cid': r.id }, { id: r.id });
}

export const Comments = Extension.create({
  name: 'chapterComments',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: commentsKey,
      state: {
        init: () => ({ set: DecorationSet.empty, active: null }),
        apply(tr, old) {
          let { set, active } = old;
          set = set.map(tr.mapping, tr.doc);
          const m = tr.getMeta(commentsKey);
          if (m) {
            if (m.reset) set = DecorationSet.empty;
            if (m.remove) set = set.remove(set.find(undefined, undefined, (s) => m.remove.includes(s.id)));
            if (m.add) set = set.add(tr.doc, m.add.filter((r) => r.to > r.from).map((r) => deco(r, active)));
            if (m.active !== undefined) {
              active = m.active;
              const cur = set.find().map((d) => ({ id: d.spec.id, from: d.from, to: d.to }));
              set = DecorationSet.create(tr.doc, cur.map((r) => deco(r, active)));
            }
          }
          return { set, active };
        },
      },
      props: { decorations(state) { return commentsKey.getState(state).set; } },
    })];
  },
});

/** Текущие диапазоны: { id: { from, to } } (те, чьи фрагменты не исчезли целиком). */
export function commentRanges(state) {
  const out = {};
  for (const d of commentsKey.getState(state).set.find()) out[d.spec.id] = { from: d.from, to: d.to };
  return out;
}

function send(editor, meta) {
  editor.view.dispatch(editor.state.tr.setMeta(commentsKey, meta).setMeta('addToHistory', false));
}
export const setCommentRanges = (editor, list) => send(editor, { reset: true, add: list });
export const addCommentRange = (editor, r) => send(editor, { add: [r] });
export const removeCommentRange = (editor, id) => send(editor, { remove: [id] });
export const setActiveComment = (editor, id) => send(editor, { active: id });
