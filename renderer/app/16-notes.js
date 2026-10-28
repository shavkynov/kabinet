// ---------- заметки: список слева, текст в правой панели ----------

let noteId = null;
let noteDirty = false;
let noteTimer = null;
let noteToken = 0;

async function flushNote() {
  clearTimeout(noteTimer);
  noteTimer = null;
  if (!noteDirty || !noteId) return;
  const id = noteId;
  const text = $('#noteText').value;
  noteDirty = false;
  try {
    const res = await api.writeItem('note', id, text);
    setStatus('ok', 'Сохранено');
    noteSyncConflict(res);
  } catch (err) {
    noteDirty = true;
    setStatus('error', 'Не удалось сохранить заметку! Повтор через 3 с…');
    clearTimeout(noteTimer);
    noteTimer = setTimeout(flushNote, 3000);
    console.error('note save failed:', err);
  }
}

function resetNote() {
  noteId = null;
  noteDirty = false;
  clearTimeout(noteTimer);
  const ta = $('#noteText');
  ta.value = '';
  ta.disabled = true;
  updateNoteTitle();
}

function updateNoteTitle() {
  const el = $('#noteTitle');
  if (!el) return;
  const it = noteId ? itemsOf('note').find((c) => c.id === noteId) : null;
  el.textContent = it ? `· ${it.title}` : '';
}

async function openNote(id) {
  if (id === noteId) return;
  const token = ++noteToken;
  await flushNote();
  if (token !== noteToken) return;
  try {
    const text = await api.readItem('note', id);
    if (token !== noteToken) return;
    if (noteDirty) {
      await flushNote(); // пока читали, в прежней заметке успели напечатать
      if (token !== noteToken) return;
    }
    noteId = id;
    lastSelected.note = id;
    const ta = $('#noteText');
    ta.value = text;
    ta.disabled = false;
    ta.scrollTop = 0;
    if (document.body.classList.contains('notes-hidden')) applyNotesHidden(false);
    expandSection('notetext');
    updateNoteTitle();
    noteListCtl.updateSelection();
  } catch (err) {
    showError(err.message);
  }
}

async function addNote() {
  if (busy || !project) return;
  busy = true;
  try {
    await flushNote();
    const after = indexIn('note', lastSelected.note) >= 0 ? lastSelected.note : null;
    const res = await api.addItem('note', after);
    project = res.project;
    noteListCtl.render();
    await openNote(res.id);
    noteListCtl.renameById(res.id);
  } catch (err) {
    showError(err.message);
  } finally {
    busy = false;
  }
}

async function deleteNote(id) {
  if (!id || busy || !project) return;
  busy = true;
  try {
    const idx = indexIn('note', id);
    await flushNote();
    const updated = await api.deleteItem('note', id);
    if (!updated) return;
    project = updated;
    if (lastSelected.note === id) lastSelected.note = null;
    const wasOpen = noteId === id;
    if (wasOpen) resetNote();
    noteListCtl.render();
    if (wasOpen) {
      const list = itemsOf('note');
      const next = list[Math.min(idx, list.length - 1)];
      if (next) await openNote(next.id);
    }
  } catch (err) {
    showError(err.message);
  } finally {
    busy = false;
  }
}

function selectNoteRelative(delta) {
  const list = itemsOf('note');
  if (!list.length) return;
  const base = noteId || lastSelected.note;
  const i = base ? indexIn('note', base) : -1;
  const next = list[Math.max(0, Math.min(list.length - 1, i + delta))];
  if (next) openNote(next.id);
}

function wireNotes() {
  const ta = $('#noteText');
  ta.addEventListener('input', () => {
    if (!noteId) return;
    noteDirty = true;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(flushNote, SAVE_DELAY_MS);
  });
  ta.addEventListener('keydown', (e) => playKeySound(e, true));

  // ширина правой панели
  const root = document.documentElement;
  try {
    const w = Number(localStorage.getItem('kabinet.notesW'));
    if (w) root.style.setProperty('--notes-w', `${Math.max(200, Math.min(560, w))}px`);
  } catch { /* ignore */ }
  $('#notesResizer').addEventListener('mousedown', (e) => {
    e.preventDefault();
    document.body.classList.add('resizing');
    let w = 0;
    const onMove = (ev) => {
      w = Math.max(200, Math.min(560, Math.round(window.innerWidth - ev.clientX)));
      root.style.setProperty('--notes-w', `${w}px`);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.classList.remove('resizing');
      if (w) { try { localStorage.setItem('kabinet.notesW', String(w)); } catch { /* ignore */ } }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function applyNotesHidden(hidden) {
  document.body.classList.toggle('notes-hidden', hidden);
  try { localStorage.setItem('kabinet.notesHidden', hidden ? '1' : '0'); } catch { /* ignore */ }
  refreshBar();
  setTimeout(() => { updateTwPad(); layoutGoal(); }, 0);
}

function focusDocFrom(kind) {
  if (currentKind !== kind || !currentId) return false;
  if (isTextKind(kind)) editor.commands.focus('start');
  else cardView.focusFirst();
  return true;
}

function makeCardList(kind, selector) {
  return createList({
    el: $(selector),
    numbered: false,
    getItems: () => itemsOf(kind),
    getSelectedId: () => (currentKind === kind ? currentId : null),
    onOpen: (id) => openDoc(kind, id),
    onAdd: () => addDoc(kind),
    onDelete: () => deleteDoc(kind, currentKind === kind ? currentId : null),
    onRename: (id, title) => renameDoc(kind, id, title),
    onReorder: (id, to) => reorderDoc(kind, id, to),
    onContext: (item, x, y) => cardMenu(item, x, y, kind),
    badge: (item) => kind === 'character' && cardIdx.some((c) => c.kind === kind && c.id === item.id && c.protagonist),
    badgeTitle: t('Протагонист'),
    onSelectRelative: (d) => selectRelative(kind, d),
    onTab: () => focusDocFrom(kind),
    onError: (err) => showError(err.message),
  });
}

function wireLists() {
  chapterListCtl = createList({
    el: $('#chapterList'),
    numbered: true,
    showNumbers: () => !project || project.mode !== 'stories', // у рассказов нумерация не нужна
    getItems: () => itemsOf('chapter'),
    getSelectedId: () => (currentKind === 'chapter' ? currentId : null),
    markerColor: (m) => MARKER_COLORS[m] || '',
    onOpen: (id) => openDoc('chapter', id),
    onAdd: () => addDoc('chapter'),
    onDelete: () => deleteDoc('chapter', currentKind === 'chapter' ? currentId : null),
    onRename: (id, title) => renameDoc('chapter', id, title),
    onReorder: (id, to) => reorderDoc('chapter', id, to),
    onContext: chapterMenu,
    onSelectRelative: (d) => selectRelative('chapter', d),
    onTab: () => focusDocFrom('chapter'),
    onError: (err) => showError(err.message),
  });

  characterListCtl = makeCardList('character', '#characterList');
  placeListCtl = makeCardList('place', '#placeList');

  trashListCtl = createList({
    el: $('#trashList'),
    numbered: false,
    getItems: () => itemsOf('trash'),
    getSelectedId: () => trashSel,
    onOpen: (id) => { trashSel = id; trashListCtl.updateSelection(); },
    onAdd: () => restoreFromTrash(trashSel),
    onDelete: () => purgeFromTrash(trashSel),
    onRename: () => Promise.resolve(),
    onReorder: () => Promise.resolve(),
    onContext: trashMenu,
    onSelectRelative: (d) => {
      const list = itemsOf('trash');
      if (!list.length) return;
      const i = list.findIndex((c) => c.id === trashSel);
      trashSel = list[Math.max(0, Math.min(list.length - 1, i + d))].id;
      trashListCtl.updateSelection();
    },
    onTab: () => false,
    onError: (err) => showError(err.message),
  });

  noteListCtl = createList({
    el: $('#noteList'),
    numbered: false,
    getItems: () => itemsOf('note'),
    getSelectedId: () => noteId,
    onOpen: (id) => openNote(id),
    onAdd: () => addNote(),
    onDelete: () => deleteNote(noteId),
    onRename: (id, title) => renameDoc('note', id, title),
    onReorder: (id, to) => reorderDoc('note', id, to),
    onContext: (item, x, y) => cardMenu(item, x, y, 'note'),
    onSelectRelative: (d) => selectNoteRelative(d),
    onTab: () => {
      if (!noteId) return false;
      $('#noteText').focus();
      return true;
    },
    onError: (err) => showError(err.message),
  });

  cardView = createCardView({
    root: $('#cardView'),
    onChange: () => {
      if (loading || !currentId || isTextKind(currentKind)) return;
      markDirty();
    },
    onTitle: async (title) => {
      try {
        await renameDoc(currentKind, currentId, title);
        listCtl(currentKind).render();
      } catch (err) {
        showError(err.message);
        const item = itemsOf(currentKind).find((c) => c.id === currentId);
        if (item) cardView.setTitle(item.title);
      }
    },
    onAddField: (rect) => {
      const tpl = (project.templates && project.templates[currentKind]) || [];
      const have = new Set(cardView.fieldNames().map((n) => n.toLowerCase()));
      const missing = tpl.filter((n) => !have.has(n.toLowerCase()));
      const entries = missing.map((n) => ({ label: n, onClick: () => cardView.addField(n) }));
      if (entries.length) entries.push({ separator: true });
      entries.push({
        label: 'Своё поле…',
        onClick: async () => {
          const name = await askText('Название поля');
          if (name) cardView.addField(name);
        },
      });
      showMenu(rect.left, rect.bottom + 4, entries);
    },
    onKey: (e) => playKeySound(e, true),
    onOpenChapter: (id) => openDoc('chapter', id),
    onProtagonist: async () => { await flush(); loadMentions(); },
    onCommit: async () => { await flush(); loadMentions(); },
    getImageUrl,
    onPickImage: async () => {
      try {
        return await api.pickImage();
      } catch (err) {
        showError(err.message);
        return null;
      }
    },
  });

  $('#addChapter').addEventListener('click', () => addDoc('chapter'));
  $('#addNote').addEventListener('click', addNote);
  wireNotes();
  $('#btnNotes').addEventListener('click', () => applyNotesHidden(!document.body.classList.contains('notes-hidden')));
  try {
    if (localStorage.getItem('kabinet.notesHidden') === '1') document.body.classList.add('notes-hidden');
  } catch { /* ignore */ }
  $('#addCharacter').addEventListener('click', () => addDoc('character'));
  $('#addPlace').addEventListener('click', () => addDoc('place'));
  $('#btnRestore').addEventListener('click', () => restoreFromTrash(trashSel));
  $('#btnEmptyTrash').addEventListener('click', emptyTrashAll);
  // правый клик по заголовку «Персонажи» / «Места»: шаблон карточки
  for (const kind of ['character', 'place']) {
    document.querySelector(`[data-sec="${kind}"] .sec-head`).addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showMenu(e.clientX, e.clientY, [{ label: 'Шаблон карточки…', onClick: () => openTemplates(kind) }]);
    });
  }
  wireTemplates();
  wireSections();
}
