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

// Возвращает false, если текст открытого документа записать не удалось: переходить к другому документу или закрывать проект нельзя.
async function flush() {
  refreshCommentAnchors();
  const results = [];
  results.push(await flushDoc());
  results.push(await flushNote());
  results.push(await flushComments());
  results.push(await flushChapMeta());
  results.push(await flushPane2());
  return results.every((saved) => saved === true)
    && !dirty && !noteDirty && !cmtDirty && !cmDirty && !p2.dirty && !failedWrite;
}

// Запись, которая не удалась (диск, права, закрытая папка). Повторяется с тем же текстом и в тот же документ,
// даже если на экране уже другая глава: иначе её текст ушёл бы в файл прежней.
let failedWrite = null; // { id, kind, text }

async function writeDocJob(job) {
  try {
    const res = job.kind === 'chapter' ? await api.writeChapter(job.id, job.text) : await api.writeItem(job.kind, job.id, job.text);
    if (failedWrite === job) failedWrite = null;
    setStatus('ok', 'Сохранено');
    noteSyncConflict(res);
    if (job.kind !== 'chapter') refreshIndex(); // имена и краткая справка могли измениться
    return true;
  } catch (err) {
    failedWrite = job;
    if (job.id === currentId && job.kind === currentKind) dirty = true; // на экране тот же документ: повторим уже с новым текстом
    setStatus('error', 'Не удалось сохранить! Повтор через 3 с…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 3000);
    console.error('save failed:', err);
    return false;
  }
}

async function flushDoc() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (failedWrite) {
    const newer = dirty && dirtyId === failedWrite.id && dirtyKind === failedWrite.kind;
    if (newer) failedWrite = null; // на экране тот же документ с более свежим текстом
    else if (!(await writeDocJob(failedWrite))) return false;
  }
  if (!dirty || !dirtyId) return true;
  const job = { id: dirtyId, kind: dirtyKind, text: snapshot(dirtyKind) };
  dirty = false;
  return writeDocJob(job);
}

// При закрытии окна ждать ответа нельзя, поэтому пишем синхронно.
window.addEventListener('beforeunload', () => {
  if (window.__TAURI__) return; // Tauri уже дождался подтверждённого асинхронного сохранения.
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
  if (failedWrite && !(dirty && dirtyId === failedWrite.id && dirtyKind === failedWrite.kind)) {
    try {
      api.writeDocSync(failedWrite.kind, failedWrite.id, failedWrite.text);
      failedWrite = null;
    } catch (err) {
      console.error('final save of failed write failed:', err);
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


if (window.__TAURI__) {
  api.prepareClose = async () => {
    openToken += 1;
    p2.token += 1;
    noteToken += 1;
    cmToken += 1;
    return flush();
  };
}
