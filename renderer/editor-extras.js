// Расширения редактора: подсветка совпадений поиска по главе и режим «Фокус на абзаце».

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { findInText } from '../src/chapter-search.js';

export const searchHlKey = new PluginKey('searchHighlight');
export const paraFocusKey = new PluginKey('paraFocus');

const EMPTY_SEARCH = {
  query: '',
  matchCase: false,
  wholeWord: false,
  matches: [],
  index: -1,
  decos: DecorationSet.empty,
};

const MAX_RENDERED_HITS = 2000;

function scanDoc(doc, query, matchCase, wholeWord) {
  if (!query) return [];
  const matches = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const raw = node.textBetween(0, node.content.size, undefined, '\ufffc');
    if (raw) {
      for (const h of findInText(raw, query, { matchCase, wholeWord })) {
        matches.push({ from: pos + 1 + h.start, to: pos + 1 + h.end });
      }
    }
    return false;
  });
  return matches;
}

function buildSearchDecos(doc, matches, index) {
  if (!matches.length) return DecorationSet.empty;
  const decos = [];
  const limit = Math.min(matches.length, MAX_RENDERED_HITS);
  for (let i = 0; i < limit; i += 1) {
    if (i === index) continue;
    const m = matches[i];
    decos.push(Decoration.inline(m.from, m.to, { class: 'sr-hit' }));
  }
  if (index >= 0 && index < matches.length) {
    const cur = matches[index];
    decos.push(Decoration.inline(cur.from, cur.to, { class: 'sr-cur' }));
  }
  return DecorationSet.create(doc, decos);
}

export const SearchHighlight = Extension.create({
  name: 'searchHighlight',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: searchHlKey,
        state: {
          init: () => EMPTY_SEARCH,
          apply(tr, old, _oldState, state) {
            const meta = tr.getMeta(searchHlKey);
            if (meta && meta.clear) return old.query ? EMPTY_SEARCH : old;
            if (!meta && !tr.docChanged) return old;
            if (!meta && !old.query) return old;

            const query = meta && 'query' in meta ? String(meta.query || '') : old.query;
            if (!query) return EMPTY_SEARCH;
            const matchCase = meta && 'matchCase' in meta ? !!meta.matchCase : old.matchCase;
            const wholeWord = meta && 'wholeWord' in meta ? !!meta.wholeWord : old.wholeWord;

            const needScan = tr.docChanged || query !== old.query || matchCase !== old.matchCase || wholeWord !== old.wholeWord;
            const matches = needScan ? scanDoc(state.doc, query, matchCase, wholeWord) : old.matches;

            let index = meta && typeof meta.index === 'number' ? meta.index : old.index;
            if (!matches.length) index = -1;
            else if (index < 0 || index >= matches.length) index = 0;

            return {
              query,
              matchCase,
              wholeWord,
              matches,
              index,
              decos: buildSearchDecos(state.doc, matches, index),
            };
          },
        },
        props: {
          decorations(state) {
            return (searchHlKey.getState(state) || EMPTY_SEARCH).decos;
          },
        },
      }),
    ];
  },
});

export function setSearchHighlight(editor, opts) {
  if (!editor || !editor.view) return;
  editor.view.dispatch(editor.state.tr.setMeta(searchHlKey, opts).setMeta('addToHistory', false));
}

export function clearSearchHighlight(editor) {
  if (!editor || !editor.view) return;
  const st = searchHlKey.getState(editor.state);
  if (!st || !st.query) return;
  editor.view.dispatch(editor.state.tr.setMeta(searchHlKey, { clear: true }).setMeta('addToHistory', false));
}

export function getSearchHighlightState(editor) {
  if (!editor || !editor.state) return EMPTY_SEARCH;
  return searchHlKey.getState(editor.state) || EMPTY_SEARCH;
}

function buildParaDeco(state) {
  const { $from, $to } = state.selection;
  if ($from.depth < 1) return DecorationSet.empty;
  const startIdx = $from.index(0);
  const endIdx = $to.depth >= 1 ? $to.index(0) : startIdx;
  if (startIdx === endIdx) {
    const pos = $from.before(1);
    const node = $from.node(1);
    return DecorationSet.create(state.doc, [Decoration.node(pos, pos + node.nodeSize, { class: 'pm-active' })]);
  }
  const decos = [];
  let pos = $from.before(1);
  for (let i = startIdx; i <= endIdx && i < state.doc.childCount; i += 1) {
    const child = state.doc.child(i);
    decos.push(Decoration.node(pos, pos + child.nodeSize, { class: 'pm-active' }));
    pos += child.nodeSize;
  }
  return DecorationSet.create(state.doc, decos);
}

export const ParaFocus = Extension.create({
  name: 'paraFocus',
  addOptions() {
    return { getEnabled: () => false };
  },
  addProseMirrorPlugins() {
    const getEnabled = this.options.getEnabled;
    return [
      new Plugin({
        key: paraFocusKey,
        state: {
          init: (_cfg, state) => (getEnabled() ? buildParaDeco(state) : DecorationSet.empty),
          apply(tr, old, _oldState, state) {
            if (!getEnabled()) return old === DecorationSet.empty ? old : DecorationSet.empty;
            if (tr.docChanged || tr.selectionSet || tr.getMeta(paraFocusKey) || old === DecorationSet.empty) {
              return buildParaDeco(state);
            }
            return old;
          },
        },
        props: {
          decorations(state) {
            return paraFocusKey.getState(state) || DecorationSet.empty;
          },
        },
      }),
    ];
  },
});

export function refreshParaFocus(editor) {
  if (editor && editor.view) {
    editor.view.dispatch(editor.state.tr.setMeta(paraFocusKey, 1).setMeta('addToHistory', false));
  }
}
