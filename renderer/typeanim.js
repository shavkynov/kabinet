// Плавное появление набранных букв (0.29.3). Эффект рисует CSS Highlight API, а не разметка редактора:
// новые буквы получают цвет текста с растущей непрозрачностью (ступени STEPS за DURATION_MS, src/typeanim.js).
//
// Почему так. Раньше пометка была inline-декорацией с CSS-анимацией на узле буквы. Если редактор пересоздаёт этот узел
// (смена подсветки слова, подчёркивание, перерисовка абзаца), анимация стартует заново, и буква мерцает. Здесь в DOM
// редактора нет ни одного добавленного узла или класса: плагин хранит только позиции в документе (они сопровождают правки
// через tr.mapping), а диапазоны подсветки заново строятся по этим позициям в самом конце каждого обновления (до отрисовки
// кадра) и на каждом кадре, пока есть живые метки. Таймеров и обработчиков на букву нет: один цикл requestAnimationFrame,
// он останавливается, когда все метки отыграли. Текст документа, выделение и история отмены не затрагиваются.
// Если Highlight API недоступен или включено «уменьшить движение», буквы просто появляются сразу.

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { DURATION_MS, STEPS, animatedRange, advance, levelAt } from '../src/typeanim.js';

export const typeAnimKey = new PluginKey('typeAnim');
const NAME = (i) => `kab-ta-${i}`;
const supported = () => typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight === 'function';
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const views = new Set(); // оба редактора (основной и вторая панель) рисуют в один реестр подсветок, поэтому цикл общий
let raf = 0;
let inkAt = 0;

/** Цвет текста редактора в виде «r g b» для CSS-переменной: подсветка красит буквы тем же цветом, но прозрачнее. */
function refreshInk(view, now) {
  if (now - inkAt < 1000) return;
  inkAt = now;
  const m = getComputedStyle(view.dom).color.match(/[\d.]+/g);
  if (m && m.length >= 3) document.documentElement.style.setProperty('--ta-rgb', `${m[0]} ${m[1]} ${m[2]}`);
}

function domRange(view, from, to) {
  try {
    const a = view.domAtPos(from);
    const b = view.domAtPos(to);
    const r = document.createRange();
    r.setStart(a.node, a.offset);
    r.setEnd(b.node, b.offset);
    return r.collapsed ? null : r;
  } catch {
    return null; // позиция вне разметки (например, редактор перестраивается): этот кадр пропускаем
  }
}

/** Пересобирает подсветки по живым меткам всех редакторов. Возвращает, остались ли живые метки. */
function paint() {
  const now = performance.now();
  const byLevel = STEPS.map(() => []);
  let live = false;
  for (const view of views) {
    if (view.isDestroyed) continue;
    const items = typeAnimKey.getState(view.state) || [];
    for (const it of items) {
      const lv = levelAt(now - it.t);
      if (lv < 0) continue;
      const r = domRange(view, it.from, it.to);
      if (!r) continue;
      refreshInk(view, now);
      byLevel[lv].push(r);
      live = true;
    }
  }
  STEPS.forEach((_, i) => {
    if (byLevel[i].length) CSS.highlights.set(NAME(i), new Highlight(...byLevel[i]));
    else CSS.highlights.delete(NAME(i));
  });
  return live;
}

function tick() {
  raf = 0;
  if (paint()) raf = requestAnimationFrame(tick);
}

function ensureLoop() {
  if (!raf) raf = requestAnimationFrame(tick);
}

function installStyle() {
  if (document.getElementById('kab-ta-style')) return;
  const st = document.createElement('style');
  st.id = 'kab-ta-style';
  st.textContent = STEPS.map((a, i) => `::highlight(${NAME(i)}) { color: rgb(var(--ta-rgb, 128 128 128) / ${a}); }`).join('\n');
  document.head.appendChild(st);
}

export const TypeAnim = Extension.create({
  name: 'typeAnim',
  addOptions() {
    return { isEnabled: () => true };
  },
  onCreate() {
    if (supported()) installStyle();
  },
  addProseMirrorPlugins() {
    const opts = this.options;
    return [new Plugin({
      key: typeAnimKey,
      // Состояние: массив меток { from, to, t } в позициях документа. Это не декорации, DOM они не меняют.
      state: {
        init: () => [],
        apply(tr, items) {
          if (!items.length && !tr.docChanged) return items;
          const now = performance.now();
          let out = items;
          if (items.length) out = tr.docChanged ? advance(items, (p, assoc) => tr.mapping.map(p, assoc), now) : advance(items, (p) => p, now);
          // обычный набор: одна правка-вставка; вставка из буфера, undo/redo, ввод через IME и загрузка текста не анимируются
          if (!tr.docChanged || tr.steps.length !== 1 || !supported() || !opts.isEnabled() || reduced()) return out;
          if (tr.getMeta('paste') || tr.getMeta('history$') || tr.getMeta('composition') !== undefined || ['paste', 'cut', 'drop'].includes(tr.getMeta('uiEvent'))) return out;
          const st = tr.steps[0];
          const frag = st.slice && st.slice.content;
          const text = frag && frag.childCount === 1 && frag.firstChild.isText ? frag.firstChild.text : null;
          const range = animatedRange({ from: st.from, to: st.to, size: st.slice ? st.slice.size : 0, text });
          if (!range) return out;
          return [...out, { from: range[0], to: range[1], t: now }];
        },
      },
      view: (view) => {
        views.add(view);
        return {
          update() {
            // сразу после обновления DOM, до отрисовки кадра: диапазоны всегда привязаны к актуальным узлам
            if (!supported()) return;
            if (paint()) ensureLoop();
          },
          destroy() {
            views.delete(view);
            if (supported()) paint();
          },
        };
      },
    })];
  },
});
