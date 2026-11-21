// Автоссылки: имена из карточек (название и «Имена в тексте») подсвечиваются в главах.
// Текст файла не меняется: подсветка рисуется поверх, поэтому ничего не портится.
// Название и «Имена в тексте» совпадают точно (без учёта регистра), слово целиком. К ним добавляются падежные
// формы, которые строит src/declension.js (флажок «Склонять имя автоматически» в карточке); сгенерированная форма
// с большой буквы подсвечивается только с большой буквы. Прозвища добавляются в «Имена в тексте» карточки
// или кнопкой «Связать с карточкой» из меню правого клика.

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { t } from './i18n.js';
import { isBig, lazyView } from './lazy.js';
import { nameRegex, isCapital } from '../src/namematch.js';

const linkKey = new PluginKey('nameLinks');
let matcher = null; // { re, map: имя в нижнем регистре -> { kind, id, cap } }
let matcherVer = 0;
const linkNodeCache = new WeakMap();

function buildMatcher(cards) {
  const map = new Map();
  const ignoreOf = (c) => new Set((c.ignore || []).map((x) => x.toLowerCase()));
  // сначала явные названия и «Имена в тексте» всех карточек: сгенерированная форма их не перекрывает
  for (const c of cards) {
    const ignore = ignoreOf(c);
    for (const name of [c.title, ...(c.aliases || [])]) {
      const key = String(name).trim().toLowerCase();
      if (key.length < 2 || ignore.has(key) || map.has(key)) continue;
      map.set(key, { kind: c.kind, id: c.id, cap: false });
    }
  }
  for (const c of cards) {
    const ignore = ignoreOf(c);
    for (const form of c.forms || []) {
      const key = String(form).trim().toLowerCase();
      if (key.length < 2 || ignore.has(key) || map.has(key)) continue;
      map.set(key, { kind: c.kind, id: c.id, cap: isCapital(form) });
    }
  }
  const re = nameRegex([...map.keys()]);
  return re ? { re, map } : null;
}

function nodeLinks(node) {
  const cached = linkNodeCache.get(node);
  if (cached && cached.ver === matcherVer) return cached.hits;
  const text = node.textBetween(0, node.content.size, undefined, '￼').replace(/\u00a0/g, ' '); // неразрывный пробел как обычный
  const hits = [];
  matcher.re.lastIndex = 0;
  let m;
  while ((m = matcher.re.exec(text)) !== null) {
    if (m[0].length === 0) { matcher.re.lastIndex += 1; continue; }
    const hit = matcher.map.get(m[0].toLowerCase());
    if (hit && !(hit.cap && !isCapital(m[0]))) {
      hits.push({ off: m.index, len: m[0].length, kind: hit.kind, id: hit.id });
    }
  }
  linkNodeCache.set(node, { ver: matcherVer, hits });
  return hits;
}

function decorate(doc) {
  if (!matcher) return DecorationSet.empty;
  const decos = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const base = pos + 1;
    for (const h of nodeLinks(node)) {
      const from = base + h.off;
      decos.push(Decoration.inline(from, from + h.len, {
        class: `name-link kind-${h.kind}`,
        'data-card': h.id,
        'data-kind': h.kind,
      }));
    }
    return false;
  });
  return DecorationSet.create(doc, decos);
}

export const NameLinks = Extension.create({
  name: 'nameLinks',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: linkKey,
        state: {
          init: (_, { doc }) => ({ set: decorate(doc), stale: false }),
          apply: (tr, old) => {
            if (tr.getMeta(linkKey)) return { set: decorate(tr.doc), stale: false };
            if (!tr.docChanged) return old;
            if (isBig(tr.doc)) return { set: old.set.map(tr.mapping, tr.doc), stale: true }; // см. lazy.js
            return { set: decorate(tr.doc), stale: false };
          },
        },
        props: { decorations: (state) => linkKey.getState(state).set },
        view: lazyView(linkKey, (st) => linkKey.getState(st).stale),
      }),
    ];
  },
});

/** Обновить список карточек (пустой список выключает подсветку). */
export function setNameLinks(editor, cards) {
  matcher = buildMatcher(cards);
  matcherVer += 1;
  editor.view.dispatch(editor.state.tr.setMeta(linkKey, true));
}

/**
 * Всплывающая подсказка при наведении и открытие карточки по ⌘-клику.
 * getCard(kind, id) -> запись сводки или undefined; getImageUrl(file) -> Promise<data-url>.
 */
export function wireLinkHover({ dom, pop, scroller, getCard, getImageUrl, isEnabled, onOpen }) {
  let showTimer = null;
  let hideTimer = null;
  let token = 0;
  const img = pop.querySelector('#linkPopImg');
  const titleEl = pop.querySelector('#linkPopTitle');
  const textEl = pop.querySelector('#linkPopText');

  const linkOf = (target) => (target && target.closest ? target.closest('.name-link') : null);

  function hide() {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    token += 1;
    pop.hidden = true;
  }

  async function show(el) {
    const card = getCard(el.dataset.kind, el.dataset.card);
    if (!card) return;
    const mine = ++token;
    titleEl.textContent = `${card.icon ? `${card.icon} ` : ''}${card.title}`;
    textEl.textContent = card.short || t('Краткой справки пока нет.');
    textEl.setAttribute('translate', 'no');
    titleEl.setAttribute('translate', 'no');
    textEl.classList.toggle('empty', !card.short);
    img.hidden = true;
    img.removeAttribute('src');
    pop.hidden = false;
    place(el);
    if (card.image) {
      try {
        const url = await getImageUrl(card.image);
        if (mine !== token) return;
        img.src = url;
        img.hidden = false;
        place(el);
      } catch { /* без картинки */ }
    }
  }

  function place(el) {
    const r = el.getBoundingClientRect();
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    let left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }

  dom.addEventListener('mouseover', (e) => {
    const el = linkOf(e.target);
    if (!el || !isEnabled()) return;
    clearTimeout(hideTimer);
    clearTimeout(showTimer);
    showTimer = setTimeout(() => show(el), 280);
  });
  dom.addEventListener('mouseout', (e) => {
    if (!linkOf(e.target)) return;
    clearTimeout(showTimer);
    hideTimer = setTimeout(hide, 120);
  });
  dom.addEventListener('mousedown', hide);
  dom.addEventListener('keydown', hide);
  scroller.addEventListener('scroll', hide, { passive: true });

  dom.addEventListener('click', (e) => {
    if (!(e.metaKey || e.ctrlKey) || !isEnabled()) return;
    const el = linkOf(e.target);
    if (!el) return;
    e.preventDefault();
    hide();
    onOpen(el.dataset.kind, el.dataset.card);
  });

  return { hide };
}
