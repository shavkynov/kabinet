// ---------- корзина ----------

function trashEntry(tid) {
  return (project && project.trash ? project.trash : []).find((e) => e.tid === tid) || null;
}

async function restoreFromTrash(tid) {
  const e = trashEntry(tid);
  if (!e || busy) return;
  busy = true;
  try {
    await flush();
    const res = await api.restoreTrash(tid);
    project = res.project;
    trashSel = null;
    if (res.kind === 'chapter') { chapterWords.set(res.id, 0); chapterChars.set(res.id, 0); refreshTotals(); }
    else refreshIndex();
    expandSection(res.kind);
    refreshLists();
    setStatus('ok', t('«{0}» возвращено', e.title));
    if (res.kind === 'note') await openNote(res.id);
    else await openDoc(res.kind, res.id);
  } catch (err) {
    showError(err.message);
  } finally {
    busy = false;
  }
}

async function purgeFromTrash(tid) {
  if (!tid || !trashEntry(tid) || busy) return;
  busy = true;
  try {
    const updated = await api.purgeTrash(tid);
    if (!updated) return;
    project = updated;
    if (trashSel === tid) trashSel = null;
    refreshLists();
  } catch (err) {
    showError(err.message);
  } finally {
    busy = false;
  }
}

async function emptyTrashAll() {
  if (busy || !project || !(project.trash || []).length) return;
  busy = true;
  try {
    const updated = await api.emptyTrash();
    if (!updated) return;
    project = updated;
    trashSel = null;
    refreshLists();
  } catch (err) {
    showError(err.message);
  } finally {
    busy = false;
  }
}

function trashMenu(item, x, y) {
  showMenu(x, y, [
    { label: 'Вернуть', onClick: () => restoreFromTrash(item.id) },
    { label: 'Удалить навсегда…', onClick: () => purgeFromTrash(item.id) },
    { separator: true },
    { label: 'Очистить корзину…', onClick: emptyTrashAll },
  ]);
}

function cardMenu(item, x, y, kind) {
  if (kind === 'trash') { trashMenu(item, x, y); return; }
  const ctl = listCtl(kind);
  const entries = [];
  if (kind !== 'note') {
    entries.push(
      { icons: kind === 'place' ? ICONS_PLACE : kind === 'item' ? ICONS_ITEM : ICONS_CHARACTER, current: item.icon, onPick: (icon) => setIcon(kind, item.id, icon) },
      { separator: true },
    );
  }
  entries.push(
    { label: 'Переименовать', onClick: () => ctl.renameById(item.id) },
    { label: 'Переместить в Корзину', onClick: () => (kind === 'note' ? deleteNote(item.id) : deleteDoc(kind, item.id)) },
  );
  showMenu(x, y, entries);
}

