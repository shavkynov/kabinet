// ---------- поиск (в главе и по проекту) и экспорт ----------

const KIND_NAME = { chapter: 'Глава', character: 'Персонаж', place: 'Место', item: 'Предмет', note: 'Заметка' };
let searchTimer = null;
let searchToken = 0;
let searchQuery = '';
let searchScope = 'chapter'; // 'chapter' | 'project'
let searchCase = false;
let searchWord = false;

function canSearchChapter() {
  return !!(editor && currentId && isTextKind(currentKind));
}

function setSearchScope(scope) {
  const next = scope === 'chapter' && canSearchChapter() ? 'chapter' : 'project';
  searchScope = next;
  const isChap = next === 'chapter';

  const tabChap = $('#srScopeChapter');
  const tabProj = $('#srScopeProject');
  if (tabChap) {
    tabChap.disabled = !canSearchChapter();
    tabChap.classList.toggle('active', isChap);
    tabChap.setAttribute('aria-selected', isChap ? 'true' : 'false');
  }
  if (tabProj) {
    tabProj.classList.toggle('active', !isChap);
    tabProj.setAttribute('aria-selected', !isChap ? 'true' : 'false');
  }

  for (const sel of ['#srCase', '#srWord', '#srCount', '#srPrev', '#srNext', '#btnReplaceOne']) {
    const el = $(sel);
    if (el) el.hidden = !isChap;
  }

  const input = $('#searchInput');
  if (input) {
    input.placeholder = isChap
      ? t('Найти в главе (можно один символ, например [)')
      : t('Поиск по главам, карточкам и заметкам');
  }
  const repAll = $('#btnReplaceAll');
  if (repAll) repAll.textContent = isChap ? t('Заменить всё') : t('Заменить всё…');

  if (isChap) {
    $('#searchResults').textContent = '';
    searchToken += 1;
    runChapterSearch(false);
  } else {
    clearSearchHighlight(editor);
    runSearch();
  }
}

function syncChapterSearchUi() {
  if ($('#search').hidden || searchScope !== 'chapter') return;
  const st = getSearchHighlightState(editor);
  const count = $('#srCount');
  if (!count) return;
  if (!st.query) count.textContent = '';
  else if (!st.matches.length) count.textContent = '0';
  else count.textContent = `${st.index + 1} / ${st.matches.length}`;
}

function revealChapterMatch(focusEditor = false) {
  const st = getSearchHighlightState(editor);
  if (!st.matches.length || st.index < 0) return;
  const m = st.matches[st.index];
  if (!m) return;
  if (focusEditor && editor && editor.isEditable) {
    const max = editor.state.doc.content.size;
    const from = Math.max(0, Math.min(m.from, max));
    const to = Math.max(from, Math.min(m.to, max));
    followCaret = true;
    editor.chain().focus().setTextSelection({ from, to }).run();
    revealPos(from);
    if (settings.typewriter) recenterNow();
    return;
  }
  requestAnimationFrame(() => {
    try {
      const curEl = editor.view.dom.querySelector('.sr-cur');
      if (curEl) {
        curEl.scrollIntoView({ block: 'center' });
        return;
      }
    } catch { /* ниже запасной путь */ }
    revealPos(m.from);
  });
}

function runChapterSearch(preserveIndex = false) {
  if ($('#search').hidden || searchScope !== 'chapter' || !canSearchChapter()) return;
  const q = $('#searchInput').value;
  if (!q) {
    clearSearchHighlight(editor);
    syncChapterSearchUi();
    return;
  }
  const prev = getSearchHighlightState(editor);
  const cursor = editor.state.selection.from;
  setSearchHighlight(editor, {
    query: q,
    matchCase: searchCase,
    wholeWord: searchWord,
    index: preserveIndex ? prev.index : -1,
  });
  const st = getSearchHighlightState(editor);
  if (st.matches.length && !preserveIndex) {
    const idx = st.matches.findIndex((m) => m.from >= cursor);
    const chosen = idx >= 0 ? idx : 0;
    if (chosen !== st.index) setSearchHighlight(editor, { index: chosen });
  }
  syncChapterSearchUi();
  revealChapterMatch(false);
}

function stepChapterMatch(delta) {
  if (searchScope !== 'chapter' || !canSearchChapter()) return;
  const st = getSearchHighlightState(editor);
  if (!st.matches.length) {
    runChapterSearch(false);
    return;
  }
  const next = (st.index + delta + st.matches.length) % st.matches.length;
  setSearchHighlight(editor, { index: next });
  syncChapterSearchUi();
  revealChapterMatch(false);
}

function replaceOneChapter() {
  if (searchScope !== 'chapter' || !canSearchChapter() || !editor.isEditable) return;
  const st = getSearchHighlightState(editor);
  if (!st.matches.length || st.index < 0) return;
  const m = st.matches[st.index];
  const rep = $('#replaceInput').value;
  const tr = editor.state.tr.insertText(rep, m.from, m.to).setMeta('kabinetNonTyped', true);
  editor.view.dispatch(tr);
  const nextSt = getSearchHighlightState(editor);
  if (nextSt.matches.length) {
    const idx = nextSt.matches.findIndex((hit) => hit.from >= m.from + rep.length);
    setSearchHighlight(editor, { index: idx >= 0 ? idx : 0 });
  }
  syncChapterSearchUi();
  revealChapterMatch(false);
}

function replaceAllChapter() {
  if (searchScope !== 'chapter' || !canSearchChapter() || !editor.isEditable) return;
  const st = getSearchHighlightState(editor);
  if (!st.matches.length) {
    setStatus('ok', t('Нечего заменять'));
    return;
  }
  const rep = $('#replaceInput').value;
  const tr = editor.state.tr.setMeta('kabinetNonTyped', true);
  for (let i = st.matches.length - 1; i >= 0; i -= 1) {
    tr.insertText(rep, st.matches[i].from, st.matches[i].to);
  }
  const total = st.matches.length;
  editor.view.dispatch(tr);
  setStatus('ok', t('Заменено: {0}', total));
  syncChapterSearchUi();
}

function refreshChapterSearchOnDoc() {
  if ($('#search').hidden) return;
  if (!canSearchChapter() && searchScope === 'chapter') {
    setSearchScope('project');
    return;
  }
  const tabChap = $('#srScopeChapter');
  if (tabChap) tabChap.disabled = !canSearchChapter();
  if (searchScope === 'chapter') runChapterSearch(false);
}

function openSearch() {
  if (!project || (typeof isChallengeActive === 'function' && isChallengeActive())) return;
  closeSettings();
  if (typeof closeBoard === 'function') closeBoard();
  const wasOpen = !$('#search').hidden;
  $('#search').hidden = false;
  const input = $('#searchInput');
  let picked = '';
  if (canSearchChapter() && editor) {
    const { from, to } = editor.state.selection;
    if (to > from && to - from <= 80) {
      const selected = editor.state.doc.textBetween(from, to, '\n', '');
      if (selected && !selected.includes('\n')) picked = selected;
    }
  }
  if (picked) {
    input.value = picked;
    setSearchScope('chapter');
  } else if (!wasOpen) {
    setSearchScope(canSearchChapter() ? 'chapter' : 'project');
  }
  input.focus();
  input.select();
}

function closeSearch(focusMatch = false) {
  if ($('#search').hidden) return;
  const wasChapter = searchScope === 'chapter';
  const active = wasChapter ? getSearchHighlightState(editor) : null;
  const curMatch = active && active.index >= 0 ? active.matches[active.index] : null;
  $('#search').hidden = true;
  clearTimeout(searchTimer);
  searchToken += 1;
  clearSearchHighlight(editor);
  if (focusMatch && wasChapter && editor && editor.isEditable && canSearchChapter()) {
    if (curMatch) {
      const max = editor.state.doc.content.size;
      const from = Math.max(0, Math.min(curMatch.from, max));
      const to = Math.max(from, Math.min(curMatch.to, max));
      editor.chain().focus().setTextSelection({ from, to }).run();
    } else {
      editor.commands.focus();
    }
  }
}

async function runSearch() {
  if (searchScope === 'chapter') {
    runChapterSearch(false);
    return;
  }
  const q = $('#searchInput').value.trim();
  const box = $('#searchResults');
  const token = ++searchToken;
  searchQuery = q;
  box.textContent = '';
  if (!q) return;
  if (q.length < 2) {
    const hint = document.createElement('div');
    hint.className = 'sr-empty';
    hint.textContent = t('Для поиска по всему проекту введите от 2 символов (в главе ищет от 1).');
    box.append(hint);
    return;
  }
  await flush(); // ищем по тому, что уже записано, включая только что набранное
  if (token !== searchToken) return;
  let hits = [];
  try {
    hits = await api.searchProject(q);
  } catch (err) {
    showError(err.message);
    return;
  }
  if (token !== searchToken) return;
  if (hits.length === 0) {
    const none = document.createElement('div');
    none.className = 'sr-empty';
    none.textContent = 'Ничего не найдено.';
    box.append(none);
    return;
  }
  const n = (v) => v.toLocaleString(LOCALE);
  for (const hit of hits) {
    const doc = document.createElement('div');
    doc.className = 'sr-doc';

    const head = document.createElement('div');
    head.className = 'sr-head';
    const kind = document.createElement('span');
    kind.className = 'sr-kind';
    kind.textContent = t(KIND_NAME[hit.kind] || '');
    const title = document.createElement('span');
    title.className = 'sr-title';
    title.setAttribute('translate', 'no');
    title.textContent = `${hit.icon ? `${hit.icon} ` : ''}${hit.title}`;
    const count = document.createElement('span');
    count.className = 'sr-count';
    count.textContent = hit.count ? n(hit.count) : 'в названии';
    head.append(kind, title, count);
    head.addEventListener('click', () => openSearchHit(hit, 0));
    doc.append(head);

    for (const sn of hit.snippets) {
      const row = document.createElement('div');
      row.className = 'sr-snip';
      row.setAttribute('translate', 'no');
      const mark = document.createElement('mark');
      mark.textContent = sn.match;
      row.append(`…${sn.before}`, mark, `${sn.after}…`);
      row.addEventListener('click', () => openSearchHit(hit, sn.n, sn));
      doc.append(row);
    }
    box.append(doc);
  }
}

// Выделяет в тексте главы найденное место. Номер вхождения в файле (с разметкой Markdown) может не совпасть
// с номером в тексте на экране, поэтому сначала ищем по окружению найденного куска, потом по номеру, потом первое.
const flatSearch = (s) => s.replace(/\u00a0/g, ' ').replace(/[*_\\`]/g, '').replace(/\s+/g, ' ').toLowerCase();

function selectInEditor(q, n, ctxHit) {
  const low = q.replace(/\u00a0/g, ' ').toLowerCase();
  const before = ctxHit ? flatSearch(ctxHit.before).slice(-14) : '';
  const after = ctxHit ? flatSearch(ctxHit.after).slice(0, 14) : '';
  const all = [];
  editor.state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const raw = node.textBetween(0, node.content.size, undefined, '\ufffc').replace(/\u00a0/g, ' ').toLowerCase();
    let from = 0;
    for (;;) {
      const i = raw.indexOf(low, from);
      if (i < 0) break;
      const b = flatSearch(raw.slice(Math.max(0, i - 30), i));
      const a = flatSearch(raw.slice(i + low.length, i + low.length + 30));
      let score = 0;
      if (before && (b.endsWith(before) || (b.length < before.length && before.endsWith(b)))) score += 1;
      if (after && (a.startsWith(after) || (a.length < after.length && after.startsWith(a)))) score += 1;
      all.push({ from: pos + 1 + i, to: pos + 1 + i + low.length, score });
      from = i + Math.max(1, low.length);
    }
    return false;
  });
  if (!all.length) return;
  let found = all[Math.min(n, all.length - 1)];
  if (ctxHit) {
    const best = all.reduce((m, x) => (x.score > m.score ? x : m), all[0]);
    if (best.score >= 2 || (best.score > found.score)) found = best;
  }
  followCaret = true;
  editor.chain().focus().setTextSelection({ from: found.from, to: found.to }).run();
  revealPos(found.from);
  if (settings.typewriter) recenterNow();
}

// Прокрутка так, чтобы место оказалось посередине окна, а не у самого края.
function revealPos(pos) {
  requestAnimationFrame(() => {
    try {
      const { node } = editor.view.domAtPos(pos);
      const el = node.nodeType === 1 ? node : node.parentElement;
      if (el) el.scrollIntoView({ block: 'center' });
    } catch { /* позиция уже изменилась */ }
  });
}

function selectInTextarea(ta, q, n) {
  const low = q.toLowerCase();
  const text = ta.value.toLowerCase();
  let at = -1;
  let from = 0;
  for (let k = 0; k <= n; k += 1) {
    at = text.indexOf(low, from);
    if (at < 0) return;
    from = at + Math.max(1, low.length);
  }
  ta.focus();
  ta.setSelectionRange(at, at + low.length);
}

async function openSearchHit(hit, n, sn) {
  const q = searchQuery;
  closeSearch();
  if (hit.kind === 'chapter') {
    await openDoc('chapter', hit.id);
    if (currentKind === 'chapter' && currentId === hit.id && q) selectInEditor(q, n, sn);
  } else if (hit.kind === 'note') {
    if (!notesShown()) applyNotesHidden(false);
    expandSection('note');
    await openNote(hit.id);
    if (noteId === hit.id && q) selectInTextarea($('#noteText'), q, n);
  } else {
    openCardById(hit.kind, hit.id);
  }
}

function wireSearch() {
  const input = $('#searchInput');
  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    if (searchScope === 'chapter') searchTimer = setTimeout(() => runChapterSearch(false), 40);
    else searchTimer = setTimeout(runSearch, 220);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      if (searchScope === 'chapter') {
        stepChapterMatch(e.shiftKey ? -1 : 1);
      } else {
        const first = $('#searchResults .sr-snip, #searchResults .sr-head');
        if (first) first.click();
        else runSearch();
      }
    }
  });
  const rep = $('#replaceInput');
  rep.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      if (searchScope === 'chapter') replaceOneChapter();
      else replaceAll();
    }
  });

  $('#srScopeChapter').addEventListener('click', () => { if (canSearchChapter()) setSearchScope('chapter'); });
  $('#srScopeProject').addEventListener('click', () => setSearchScope('project'));
  $('#srCase').addEventListener('click', () => {
    searchCase = !searchCase;
    const btn = $('#srCase');
    btn.classList.toggle('active', searchCase);
    btn.setAttribute('aria-pressed', searchCase ? 'true' : 'false');
    runChapterSearch(false);
  });
  $('#srWord').addEventListener('click', () => {
    searchWord = !searchWord;
    const btn = $('#srWord');
    btn.classList.toggle('active', searchWord);
    btn.setAttribute('aria-pressed', searchWord ? 'true' : 'false');
    runChapterSearch(false);
  });
  $('#srPrev').addEventListener('click', () => stepChapterMatch(-1));
  $('#srNext').addEventListener('click', () => stepChapterMatch(1));
  $('#srClose').addEventListener('click', () => closeSearch(true));
  $('#btnReplaceOne').addEventListener('click', replaceOneChapter);
  $('#btnReplaceAll').addEventListener('click', () => {
    if (searchScope === 'chapter') replaceAllChapter();
    else replaceAll();
  });
  document.addEventListener('mousedown', (e) => {
    if ($('#search').hidden) return;
    if (e.target.closest('#search')) return;
    if (searchScope === 'chapter' && e.target.closest('#paper-area, #toolbar')) return;
    closeSearch(false);
  });
}

// Заменить найденное во всём проекте: главы, заметки, тексты карточек (названия не меняются).
// Сначала считаем и спрашиваем, потом делаем копию проекта и меняем.
async function replaceAll() {
  if (!project || busy) return;
  const q = $('#searchInput').value.trim();
  const to = $('#replaceInput').value;
  if (q.length < 2) {
    setStatus('ok', t('Введите в поиске хотя бы два символа'));
    return;
  }
  busy = true;
  try {
    await flush();
    await flushPane2();
    const plan = await api.replaceProject(q, to, true);
    if (!plan.total) {
      setStatus('ok', t('Нечего заменять'));
      return;
    }
    const sum = (kinds) => plan.docs.filter((d) => kinds.includes(d.kind)).reduce((a, d) => a + d.count, 0);
    const text = [
      t('Заменить «{0}» на «{1}»?', q, to || t('(пусто)')),
      t('Вхождений: {0}, документов: {1}.', plan.total, plan.docs.length),
      t('Главы: {0}, карточки: {1}, заметки: {2}.', sum(['chapter']), sum(['character', 'place', 'item']), sum(['note'])),
      t('Перед заменой делается резервная копия проекта.'),
    ].join('\n');
    if (!(await askConfirm(text, t('Заменить')))) return;
    const res = await api.replaceProject(q, to, false);
    await reloadOpenDocs();
    await refreshIndex();
    setStatus('ok', t('Замена выполнена: {0}', res.total));
    runSearch();
  } catch (err) {
    showError(err.message);
  } finally {
    busy = false;
  }
}

// Перечитать открытые документы с диска (после замены или другого изменения файлов снаружи).
async function reloadOpenDocs() {
  const kind = currentKind;
  const id = currentId;
  const other = p2.id;
  if (id) {
    currentKind = null;
    currentId = null;
    await openDoc(kind, id, true);
  }
  if (other) {
    p2.id = null;
    await openPane2(other, true);
  }
}

// Импорт глав из файлов Word, Markdown и текста: новые главы встают в конец проекта, открывается первая из них.
async function importFiles() {
  if (!project) { setStatus('error', t('Сначала откройте или создайте проект')); return; }
  if (busy) return;
  busy = true;
  try {
    await flush();
    const res = await api.importFiles();
    if (!res) return;
    project = res.project;
    expandSection('chapter');
    refreshLists();
    await refreshTotals();
    await openDoc('chapter', res.ids[0]);
    setStatus(res.skipped.length ? 'error' : 'ok', res.skipped.length
      ? t('Импортировано глав: {0}. Не удалось прочитать: {1}', res.ids.length, res.skipped.join('; '))
      : t('Импортировано глав: {0}', res.ids.length));
  } catch (err) {
    showError(err.message);
  } finally {
    busy = false;
  }
}

async function exportProject() {
  if (!project) return;
  try {
    await flush();
    const file = await api.exportProject({ indent: settings.para === 'indent', chapterNumbers: settings.exportNumbers === true });
    if (file) setStatus('ok', 'Экспорт готов');
  } catch (err) {
    showError(err.message);
  }
}

