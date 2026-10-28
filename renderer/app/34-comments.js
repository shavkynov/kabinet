// ---------- комментарии к фрагментам текста ----------
// Данные лежат в project.json у главы (поле comments), подсветка рисуется плагином renderer/comments.js.
// Привязка: цитата + 30 знаков до и после + примерная позиция. Диапазоны сопровождают правки сами; при сохранении
// цитата обновляется, если фрагмент поправили слегка, а если он удалён или изменён сильно, комментарий помечается
// как потерявший привязку и больше ничего не подсвечивает (на чужой текст он не переносится).

// Состояние комментариев объявлено в 01-state.js: init() в 28-analysis.js запускается раньше, чем выполнится эта часть.

const cmtFlat = (s) => String(s).replace(/ /g, ' ');
const cmtBlockText = (node) => node.textBetween(0, node.content.size, undefined, '￼');

/** Привязка для диапазона внутри одного абзаца: { quote, before, after } или null. */
function cmtAnchorAt(from, to) {
  const doc = editor.state.doc;
  const $from = doc.resolve(from);
  if (!$from.sameParent(doc.resolve(to)) || !$from.parent.isTextblock) return null;
  const text = cmtBlockText($from.parent);
  const off = from - $from.start();
  const quote = text.slice(off, off + (to - from));
  if (!quote.trim()) return null;
  return { quote, before: text.slice(Math.max(0, off - CMT_CTX), off), after: text.slice(off + quote.length, off + quote.length + CMT_CTX) };
}

/** Где в тексте сейчас находится привязка: { from, to } или null. Лучшее совпадение по окружению, затем по близости к прежней позиции. */
function cmtResolve(c) {
  if (!c.quote) return null;
  let best = null;
  editor.state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const text = cmtBlockText(node);
    let at = text.indexOf(c.quote);
    while (at >= 0) {
      const b = cmtFlat(text.slice(Math.max(0, at - CMT_CTX), at));
      const a = cmtFlat(text.slice(at + c.quote.length, at + c.quote.length + CMT_CTX));
      let score = 0;
      if (c.before && b.endsWith(cmtFlat(c.before).slice(-12))) score += 1;
      if (c.after && a.startsWith(cmtFlat(c.after).slice(0, 12))) score += 1;
      const from = pos + 1 + at;
      const dist = Math.abs(from - (c.pos || 0));
      if (!best || score > best.score || (score === best.score && dist < best.dist)) best = { from, to: from + c.quote.length, score, dist };
      at = text.indexOf(c.quote, at + 1);
    }
    return false;
  });
  return best ? { from: best.from, to: best.to, score: best.score } : null;
}

/** Фрагмент после правок остался «тем же»: общее начало и конец составляют не меньше половины. */
function cmtSimilar(a, b) {
  if (a === b) return true;
  const n = Math.max(a.length, b.length);
  if (!n) return false;
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p += 1;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s += 1;
  return (p + s) / n >= 0.5;
}

function loadComments(id, list) {
  cmtChapter = id;
  cmtDirty = false;
  cmtEditing = null;
  cmtActive = null;
  cmtList = (Array.isArray(list) ? list : []).map((c) => ({ ...c }));
  const ranges = [];
  let changed = false;
  for (const c of cmtList) {
    if (c.lost) continue;
    const r = cmtResolve(c);
    if (r) ranges.push({ id: c.id, from: r.from, to: r.to });
    else { c.lost = true; changed = true; }
  }
  if (editor) setCommentRanges(editor, ranges);
  if (changed) cmtMarkDirty();
  renderComments();
}

function clearComments() {
  clearTimeout(cmtRefreshTimer);
  if (cmtDirty && cmtChapter) flushComments();
  cmtList = [];
  cmtChapter = null;
  cmtEditing = null;
  cmtActive = null;
  hideCommentPop();
  if (editor) setCommentRanges(editor, []);
  renderComments();
}

function cmtMarkDirty() {
  cmtDirty = true;
  clearTimeout(cmtTimer);
  cmtTimer = setTimeout(flushComments, SAVE_DELAY_MS);
}

async function flushComments() {
  clearTimeout(cmtTimer);
  cmtTimer = null;
  if (!cmtDirty || !cmtChapter) return;
  const id = cmtChapter;
  const list = cmtList.map((c) => ({ ...c }));
  cmtDirty = false;
  try {
    await api.writeChapterMeta(id, { comments: list });
  } catch (err) {
    if (cmtChapter === id) cmtDirty = true;
    setStatus('error', 'Не удалось сохранить комментарии! Повтор через 3 с…');
    clearTimeout(cmtTimer);
    cmtTimer = setTimeout(flushComments, 3000);
    console.error('comments save failed:', err);
  }
}

/** Сверяет привязки с тем, что стало с текстом: обновляет цитату у слегка изменённых, теряет удалённые и сильно изменённые. */
function refreshCommentAnchors() {
  if (!editor || !cmtList.length || cmtChapter !== currentId || currentKind !== 'chapter' || loading) return;
  const ranges = commentRanges(editor.state);
  let changed = false;
  const drop = [];
  for (const c of cmtList) {
    if (c.lost) {
      // потерянный комментарий возвращается сам, только если то же место с тем же окружением снова на месте (например, после отмены правки)
      const back = cmtResolve(c);
      if (back && back.score >= 2) {
        delete c.lost;
        Object.assign(c, { pos: back.from });
        addCommentRange(editor, { id: c.id, from: back.from, to: back.to });
        changed = true;
      }
      continue;
    }
    const r = ranges[c.id];
    const a = r ? cmtAnchorAt(r.from, r.to) : null;
    if (!a || !cmtSimilar(c.quote, a.quote)) {
      c.lost = true;
      drop.push(c.id);
      changed = true;
    } else if (a.quote !== c.quote || a.before !== c.before || a.after !== c.after) {
      Object.assign(c, a, { pos: r.from });
      changed = true;
    }
  }
  for (const id of drop) removeCommentRange(editor, id);
  if (changed) {
    cmtMarkDirty();
    renderComments();
  }
}

function scheduleCommentRefresh() {
  if (!cmtList.length) return;
  clearTimeout(cmtRefreshTimer);
  cmtRefreshTimer = setTimeout(refreshCommentAnchors, 600);
}

// ---------- кнопка у выделения и поле ввода ----------

function commentSelection() {
  if (!editor || !editor.isEditable || currentKind !== 'chapter' || !cmtChapter) return null;
  const { from, to, empty } = editor.state.selection;
  if (empty || to - from > CMT_MAX_QUOTE) return null;
  const a = cmtAnchorAt(from, to);
  return a ? { from, to, ...a } : null;
}

function updateCommentButton() {
  const btn = $('#cmtBtn');
  if (!btn) return;
  const sel = !$('#cmtPop').hidden ? null : commentSelection();
  if (!sel) { btn.hidden = true; return; }
  try {
    const c = editor.view.coordsAtPos(sel.to);
    btn.hidden = false;
    btn.style.left = `${Math.max(6, Math.min(c.right + 6, window.innerWidth - 40))}px`;
    btn.style.top = `${Math.max(6, Math.min(c.bottom + 6, window.innerHeight - 40))}px`;
  } catch { btn.hidden = true; }
}

function hideCommentPop() {
  const pop = $('#cmtPop');
  if (pop) pop.hidden = true;
  cmtPending = null;
}

function openCommentPop() {
  const sel = commentSelection();
  if (!sel) return;
  cmtPending = sel;
  $('#cmtBtn').hidden = true;
  const pop = $('#cmtPop');
  $('#cmtPopQuote').textContent = sel.quote.length > 120 ? `${sel.quote.slice(0, 120)}…` : sel.quote;
  $('#cmtPopText').value = '';
  pop.hidden = false;
  const c = editor.view.coordsAtPos(sel.to);
  pop.style.left = `${Math.max(6, Math.min(c.right, window.innerWidth - 276))}px`;
  pop.style.top = `${Math.max(6, Math.min(c.bottom + 8, window.innerHeight - pop.offsetHeight - 6))}px`;
  $('#cmtPopText').focus();
}

function saveNewComment() {
  const text = $('#cmtPopText').value.trim();
  const sel = cmtPending;
  if (!sel || !text) { $('#cmtPopText').focus(); return; }
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  cmtList.push({ id, text, quote: sel.quote, before: sel.before, after: sel.after, pos: sel.from, ts: new Date().toISOString() });
  addCommentRange(editor, { id, from: sel.from, to: sel.to });
  hideCommentPop();
  editor.chain().focus().setTextSelection(sel.to).run();
  cmtMarkDirty();
  renderComments();
  expandSection('comments');
  setStatus('ok', 'Комментарий добавлен');
}

// ---------- список в правой панели ----------

function cmtOrder() {
  const ranges = editor ? commentRanges(editor.state) : {};
  const live = cmtList.filter((c) => ranges[c.id]).sort((a, b) => ranges[a.id].from - ranges[b.id].from);
  return [...live, ...cmtList.filter((c) => !ranges[c.id])];
}

function renderComments() {
  const box = $('#cmtList');
  if (!box) return;
  box.textContent = '';
  $('#cmtCount').textContent = cmtList.length ? String(cmtList.length) : '';
  if (!cmtList.length) {
    const p = document.createElement('div');
    p.className = 'cmt-empty';
    p.textContent = cmtChapter ? 'Выделите фрагмент текста и нажмите кнопку с облачком, чтобы оставить комментарий.' : 'Откройте главу, чтобы работать с комментариями.';
    box.append(p);
    return;
  }
  for (const c of cmtOrder()) {
    const item = document.createElement('div');
    item.className = `cmt-item${c.lost ? ' lost' : ''}${c.id === cmtActive ? ' active' : ''}`;
    item.dataset.id = c.id;
    const q = document.createElement('div');
    q.className = 'cmt-quote';
    q.setAttribute('translate', 'no');
    q.textContent = c.quote.length > 140 ? `${c.quote.slice(0, 140)}…` : c.quote;
    item.append(q);
    if (c.lost) {
      const w = document.createElement('div');
      w.className = 'cmt-warn';
      w.textContent = 'Фрагмент удалён или сильно изменён. Выделите новое место и нажмите «Привязать».';
      item.append(w);
    }
    if (cmtEditing === c.id) {
      const ta = document.createElement('textarea');
      ta.className = 'cmt-edit';
      ta.rows = 3;
      ta.maxLength = 5000;
      ta.value = c.text;
      ta.dataset.edit = c.id;
      item.append(ta);
      item.append(cmtActs([['save', 'Сохранить'], ['cancel', 'Отмена']]));
      setTimeout(() => ta.focus(), 0);
    } else {
      const tx = document.createElement('div');
      tx.className = 'cmt-text';
      tx.setAttribute('translate', 'no');
      tx.textContent = c.text;
      item.append(tx, cmtActs(c.lost ? [['attach', 'Привязать'], ['edit', 'Изменить'], ['del', 'Удалить']] : [['edit', 'Изменить'], ['del', 'Удалить']]));
    }
    box.append(item);
  }
}

function cmtActs(list) {
  const acts = document.createElement('div');
  acts.className = 'cmt-acts';
  for (const [act, label] of list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cmt-link';
    b.dataset.act = act;
    b.textContent = label;
    acts.append(b);
  }
  return acts;
}

function gotoComment(id) {
  const r = editor ? commentRanges(editor.state)[id] : null;
  cmtActive = id;
  if (editor) setActiveComment(editor, r ? id : null);
  if (r) {
    editor.chain().focus().setTextSelection({ from: r.from, to: r.to }).run();
    revealPos(r.from);
  }
  renderComments();
}

function commentAction(id, act) {
  const c = cmtList.find((x) => x.id === id);
  if (!c) return;
  if (act === 'edit') { cmtEditing = id; renderComments(); return; }
  if (act === 'cancel') { cmtEditing = null; renderComments(); return; }
  if (act === 'save') {
    const ta = document.querySelector(`#cmtList textarea[data-edit="${id}"]`);
    const text = ta ? ta.value.trim() : '';
    if (!text) { if (ta) ta.focus(); return; }
    c.text = text;
    cmtEditing = null;
    cmtMarkDirty();
    renderComments();
  } else if (act === 'del') {
    if (!confirm(t('Удалить комментарий?'))) return;
    cmtList = cmtList.filter((x) => x.id !== id);
    if (editor) removeCommentRange(editor, id);
    if (cmtActive === id) cmtActive = null;
    cmtMarkDirty();
    renderComments();
  } else if (act === 'attach') {
    const sel = commentSelection();
    if (!sel) { setStatus('error', 'Сначала выделите фрагмент в тексте главы'); return; }
    Object.assign(c, { quote: sel.quote, before: sel.before, after: sel.after, pos: sel.from });
    delete c.lost;
    addCommentRange(editor, { id, from: sel.from, to: sel.to });
    cmtMarkDirty();
    renderComments();
  }
}

function wireComments() {
  $('#cmtBtn').addEventListener('mousedown', (e) => e.preventDefault()); // выделение не должно сбрасываться
  $('#cmtBtn').addEventListener('click', openCommentPop);
  $('#cmtPopSave').addEventListener('click', saveNewComment);
  $('#cmtPopCancel').addEventListener('click', () => { hideCommentPop(); editor.commands.focus(); });
  $('#cmtPopText').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); hideCommentPop(); editor.commands.focus(); }
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveNewComment(); }
  });
  $('#cmtList').addEventListener('click', (e) => {
    const item = e.target.closest('.cmt-item');
    if (!item) return;
    const btn = e.target.closest('button[data-act]');
    if (btn) { commentAction(item.dataset.id, btn.dataset.act); return; }
    if (e.target.closest('textarea')) return;
    gotoComment(item.dataset.id);
  });
  $('#cmtList').addEventListener('keydown', (e) => {
    const ta = e.target.closest('textarea[data-edit]');
    if (!ta) return;
    if (e.key === 'Escape') { e.stopPropagation(); commentAction(ta.dataset.edit, 'cancel'); }
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commentAction(ta.dataset.edit, 'save'); }
  });
  editor.view.dom.addEventListener('mousedown', () => { if (!$('#cmtPop').hidden) hideCommentPop(); });
  // клик по жёлтому фрагменту в тексте подсвечивает комментарий в списке
  editor.view.dom.addEventListener('click', (e) => {
    const el = e.target.closest && e.target.closest('.cmt');
    if (el && editor.state.selection.empty) {
      cmtActive = el.dataset.cid;
      setActiveComment(editor, cmtActive);
      renderComments();
      const item = document.querySelector(`#cmtList .cmt-item[data-id="${cmtActive}"]`);
      if (item) item.scrollIntoView({ block: 'nearest' });
    }
  });
  $('#paper-area').addEventListener('scroll', updateCommentButton, { passive: true });
  window.addEventListener('resize', updateCommentButton);
  renderComments();
}
