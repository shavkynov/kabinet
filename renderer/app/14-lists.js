// ---------- списки в левой колонке: главы и карточки ----------

const LIST_KEY = { character: 'characters', place: 'places', item: 'items', note: 'notes' };
const TRASH_ICON = { chapter: '📄', character: '👤', place: '📍', item: '🗝', note: '📝' };
let trashSel = null; // выбранная в корзине запись (tid)
const MARKER_COLORS = { green: '#2fb344', red: '#e5484d', orange: '#f59f00' };

let chapterListCtl = null;
let characterListCtl = null;
let placeListCtl = null;
let itemListCtl = null;
let noteListCtl = null;
let trashListCtl = null;
let cardView = null;
const lastSelected = { chapter: null, character: null, place: null, item: null, note: null };

function itemsOf(kind) {
  if (!project) return [];
  if (kind === 'trash') return (project.trash || []).map((e) => ({ id: e.tid, title: e.title, icon: TRASH_ICON[e.kind] || '', entry: e }));
  return kind === 'chapter' ? project.chapters : project[LIST_KEY[kind]] || [];
}

function indexIn(kind, id) {
  return itemsOf(kind).findIndex((c) => c.id === id);
}

// Редактор TipTap показывает главы; заметки живут в правой панели; персонажи и места открываются карточкой.
function isTextKind(kind) {
  return kind === 'chapter';
}

function updateCenter() {
  const has = !!currentId && !!currentKind;
  const card = has && !isTextKind(currentKind);
  $('#paper').hidden = !has || card;
  $('#cardView').hidden = !card;
  $('#empty').hidden = has;
  document.body.classList.toggle('card-open', card);
  refreshGoalUI();
}

function allListCtls() {
  return [chapterListCtl, characterListCtl, placeListCtl, itemListCtl, noteListCtl, trashListCtl];
}

function updateAllSelections() {
  allListCtls().forEach((c) => c && c.updateSelection());
}

function refreshLists() {
  fillP2Select();
  allListCtls().forEach((c) => c && c.render());
  updateNoteTitle();
  const n = (project && project.trash ? project.trash.length : 0);
  $('#trashCount').textContent = String(n);
  $('#trashCount').hidden = n === 0;
}

function listCtl(kind) {
  return { chapter: chapterListCtl, character: characterListCtl, place: placeListCtl, item: itemListCtl, note: noteListCtl, trash: trashListCtl }[kind];
}

// Список глав, где встречается открытая карточка (под полями карточки).
async function loadMentions() {
  const kind = currentKind;
  const id = currentId;
  if (!id || isTextKind(kind)) return;
  try {
    const res = await api.cardMentions(kind, id);
    if (currentKind === kind && currentId === id) cardView.setMentions(res);
  } catch (err) {
    console.error('mentions:', err);
  }
}

function showNothing() {
  clearChapMeta();
  currentKind = null;
  currentId = null;
  setEditorContent('', false);
  updateCenter();
  updateAllSelections();
}

async function openDoc(kind, id) {
  if (id === currentId && kind === currentKind) return;
  const token = ++openToken;
  await flush(); // сохраняем предыдущий документ
  if (token !== openToken) return;
  try {
    const text = kind === 'chapter' ? await api.readChapter(id) : await api.readItem(kind, id);
    if (token !== openToken) return;
    if (dirty) {
      await flush(); // пока читали, в старом документе успели напечатать
      if (token !== openToken) return;
    }
    if (kind === 'chapter' && id === p2.id) await closePane2(); // одна глава не может быть открыта в двух местах
    currentKind = kind;
    currentId = id;
    lastSelected[kind] = id;
    closeGoalPop();
    if (isTextKind(kind)) {
      setEditorContent(text, true);
    } else {
      setEditorContent('', false);
      const item = itemsOf(kind).find((c) => c.id === id);
      let card = {};
      try { card = JSON.parse(text); } catch { /* пустая карточка */ }
      cardView.show({ title: item ? item.title : '', card, kind });
      loadMentions();
    }
    updateCenter();
    if (kind === 'chapter') loadChapMeta(id);
    else clearChapMeta();
    updateAllSelections();
  } catch (err) {
    showError(err.message);
  }
}

async function addDoc(kind) {
  if (busy || !project) return;
  busy = true;
  try {
    await flush();
    const after = indexIn(kind, lastSelected[kind]) >= 0 ? lastSelected[kind] : null;
    const res = kind === 'chapter' ? await api.addChapter(after) : await api.addItem(kind, after);
    project = res.project;
    if (kind === 'chapter') { chapterWords.set(res.id, 0); chapterChars.set(res.id, 0); }
    expandSection(kind);
    refreshLists();
    await openDoc(kind, res.id);
    if (kind !== 'chapter') listCtl(kind).renameById(res.id); // сразу просим дать название
  } catch (err) {
    showError(err.message);
  } finally {
    busy = false;
  }
}

async function deleteDoc(kind, id) {
  if (!id || busy || !project) return;
  busy = true;
  try {
    const idx = indexIn(kind, id);
    const removedTitle = (itemsOf(kind).find((c) => c.id === id) || {}).title || '';
    await flush();
    const updated = kind === 'chapter' ? await api.deleteChapter(id) : await api.deleteItem(kind, id);
    if (!updated) return; // отмена
    setStatus('ok', t('«{0}» перемещено в Корзину', removedTitle));
    if (kind === 'chapter') {
      chapterWords.delete(id);
      chapterChars.delete(id);
      if (p2.id === id) resetPane2();
    }
    project = updated;
    if (lastSelected[kind] === id) lastSelected[kind] = null;
    if (kind !== 'chapter') refreshIndex();
    const wasOpen = currentId === id && currentKind === kind;
    if (wasOpen) {
      currentId = null;
      currentKind = null;
      dirty = false;
      dirtyId = null;
      dirtyKind = null;
      if (kind === 'chapter') clearChapMeta();
    }
    refreshLists();
    if (wasOpen) {
      const list = itemsOf(kind);
      const next = list[Math.min(idx, list.length - 1)];
      if (next) await openDoc(kind, next.id);
      else showNothing();
    }
  } catch (err) {
    showError(err.message);
  } finally {
    busy = false;
  }
}

function selectRelative(kind, delta) {
  const list = itemsOf(kind);
  if (list.length === 0) return;
  const base = currentKind === kind ? currentId : lastSelected[kind];
  const i = base ? indexIn(kind, base) : -1;
  const next = list[Math.max(0, Math.min(list.length - 1, i + delta))];
  if (next) openDoc(kind, next.id);
}

async function renameDoc(kind, id, title) {
  project = kind === 'chapter' ? await api.renameChapter(id, title) : await api.renameItem(kind, id, title);
  if (currentKind === kind && currentId === id && cardView && !isTextKind(kind)) {
    const item = itemsOf(kind).find((c) => c.id === id);
    cardView.setTitle(item ? item.title : title);
  }
  if (kind === 'note') updateNoteTitle();
  if (kind !== 'chapter') refreshIndex();
}

async function reorderDoc(kind, id, to) {
  project = kind === 'chapter' ? await api.moveChapter(id, to) : await api.moveItem(kind, id, to);
}

async function setMarker(id, marker) {
  try {
    project = await api.setChapterMarker(id, marker);
    chapterListCtl.render();
  } catch (err) {
    showError(err.message);
  }
}

async function setIcon(kind, id, icon) {
  try {
    project = await api.setItemIcon(kind, id, icon);
    listCtl(kind).render();
  } catch (err) {
    showError(err.message);
  }
}

function chapterMenu(item, x, y) {
  const mk = (label, marker) => ({
    label,
    swatch: marker ? MARKER_COLORS[marker] : undefined,
    checked: marker ? item.marker === marker : !item.marker,
    onClick: () => setMarker(item.id, marker),
  });
  showMenu(x, y, [
    mk('Без отметки', null),
    mk('Текст готов', 'green'),
    mk('Только написан', 'red'),
    mk('Переписать', 'orange'),
    { separator: true },
    {
      label: 'Открыть справа',
      disabled: item.id === currentId && currentKind === 'chapter',
      onClick: () => openPane2(item.id),
    },
    { label: 'Переименовать', onClick: () => chapterListCtl.renameById(item.id) },
    { label: 'Переместить в Корзину', onClick: () => deleteDoc('chapter', item.id) },
  ]);
}

