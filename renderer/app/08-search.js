// ---------- поиск по проекту и экспорт ----------

const KIND_NAME = { chapter: 'Глава', character: 'Персонаж', place: 'Место', note: 'Заметка' };
let searchTimer = null;
let searchToken = 0;
let searchQuery = '';

function openSearch() {
  if (!project) return;
  closeSettings();
  $('#search').hidden = false;
  const input = $('#searchInput');
  input.focus();
  input.select();
  if (input.value.trim().length >= 2) runSearch();
}

function closeSearch() {
  $('#search').hidden = true;
  clearTimeout(searchTimer);
  searchToken += 1;
}

async function runSearch() {
  const q = $('#searchInput').value.trim();
  const box = $('#searchResults');
  const token = ++searchToken;
  searchQuery = q;
  box.textContent = '';
  if (q.length < 2) return;
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
    if (document.body.classList.contains('notes-hidden')) applyNotesHidden(false);
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
    searchTimer = setTimeout(runSearch, 220);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      const first = $('#searchResults .sr-snip, #searchResults .sr-head');
      if (first) first.click();
      else runSearch();
    }
  });
  const rep = $('#replaceInput');
  rep.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); replaceAll(); }
  });
  $('#btnReplaceAll').addEventListener('click', replaceAll);
  document.addEventListener('mousedown', (e) => {
    if ($('#search').hidden) return;
    if (e.target.closest('#search')) return;
    closeSearch();
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
      t('Главы: {0}, карточки: {1}, заметки: {2}.', sum(['chapter']), sum(['character', 'place']), sum(['note'])),
      t('Перед заменой делается резервная копия проекта.'),
    ].join('\n');
    if (!confirm(text)) return;
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
    await openDoc(kind, id);
  }
  if (other) {
    p2.id = null;
    await openPane2(other);
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
    const file = await api.exportProject({ indent: settings.para === 'indent' });
    if (file) setStatus('ok', 'Экспорт готов');
  } catch (err) {
    showError(err.message);
  }
}

