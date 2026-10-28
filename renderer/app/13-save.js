// ---------- сохранение ----------

function setStatus(kind, text) {
  const el = $('#status');
  clearTimeout(statusTimer);
  el.textContent = text;
  el.className = kind === 'error' ? 'error' : 'show';
  if (kind !== 'error') {
    statusTimer = setTimeout(() => { el.className = ''; }, 1600);
  }
}

// Что записать в файл: текст редактора (главы, заметки) или JSON карточки.
function snapshot(kind) {
  return isTextKind(kind) ? getMarkdown() : cardView.toJSON();
}

function markDirty() {
  dirty = true;
  dirtyId = currentId;
  dirtyKind = currentKind;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, SAVE_DELAY_MS);
}

async function flush() {
  refreshCommentAnchors();
  await flushDoc();
  await flushNote();
  await flushComments();
  await flushChapMeta();
  await flushPane2();
}

async function flushDoc() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!dirty || !dirtyId) return;
  const id = dirtyId;
  const kind = dirtyKind;
  const text = snapshot(kind);
  dirty = false;
  try {
    const res = kind === 'chapter' ? await api.writeChapter(id, text) : await api.writeItem(kind, id, text);
    setStatus('ok', 'Сохранено');
    noteSyncConflict(res);
    if (kind !== 'chapter') refreshIndex(); // имена и краткая справка могли измениться
  } catch (err) {
    dirty = true; // оставляем «грязным», чтобы повторить
    setStatus('error', 'Не удалось сохранить! Повтор через 3 с…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 3000);
    console.error('save failed:', err);
  }
}

// При закрытии окна ждать ответа нельзя, поэтому пишем синхронно.
window.addEventListener('beforeunload', () => {
  if (p2.dirty && p2.id) {
    try {
      api.writeDocSync('chapter', p2.id, pane2Markdown());
      p2.dirty = false;
    } catch (err) {
      console.error('final pane2 save failed:', err);
    }
  }
  if (cmtDirty && cmtChapter) {
    try {
      refreshCommentAnchors();
      api.writeDocSync('chaptermeta', cmtChapter, JSON.stringify({ comments: cmtList }));
      cmtDirty = false;
    } catch (err) {
      console.error('final comments save failed:', err);
    }
  }
  if (cmDirty && cmId) {
    try {
      api.writeDocSync('chaptermeta', cmId, JSON.stringify(chapMetaValue()));
      cmDirty = false;
    } catch (err) {
      console.error('final chapter meta save failed:', err);
    }
  }
  if (noteDirty && noteId) {
    try {
      api.writeDocSync('note', noteId, $('#noteText').value);
      noteDirty = false;
    } catch (err) {
      console.error('final note save failed:', err);
    }
  }
  if (dirty && dirtyId) {
    try {
      api.writeDocSync(dirtyKind, dirtyId, snapshot(dirtyKind));
      dirty = false;
    } catch (err) {
      console.error('final save failed:', err);
    }
  }
});
window.addEventListener('blur', () => { flush(); });

