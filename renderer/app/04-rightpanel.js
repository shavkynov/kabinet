// ---------- панель справа: синопсис и заметки к главе ----------

let cmId = null;       // глава, чьи синопсис и заметки сейчас в полях
let cmDirty = false;
let cmTimer = null;
let cmToken = 0;

function chapMetaValue() {
  return { synopsis: $('#synopsisText').value, notes: $('#chapNotesText').value };
}

async function flushChapMeta() {
  clearTimeout(cmTimer);
  cmTimer = null;
  if (!cmDirty || !cmId) return;
  const id = cmId;
  const data = chapMetaValue();
  cmDirty = false;
  try {
    await api.writeChapterMeta(id, data);
    setStatus('ok', 'Сохранено');
  } catch (err) {
    cmDirty = true;
    setStatus('error', 'Не удалось сохранить синопсис! Повтор через 3 с…');
    clearTimeout(cmTimer);
    cmTimer = setTimeout(flushChapMeta, 3000);
    console.error('chapter meta save failed:', err);
  }
}

function clearChapMeta() {
  clearComments();
  cmToken += 1;
  cmId = null;
  cmDirty = false;
  clearTimeout(cmTimer);
  for (const sel of ['#synopsisText', '#chapNotesText']) {
    const ta = $(sel);
    ta.value = '';
    ta.disabled = true;
  }
  $('#paneChapter').classList.remove('has-chapter');
}

async function loadChapMeta(id) {
  const token = ++cmToken;
  await flushChapMeta();
  if (token !== cmToken) return;
  try {
    const meta = await api.readChapterMeta(id);
    if (token !== cmToken) return;
    cmId = id;
    $('#synopsisText').value = meta.synopsis;
    $('#chapNotesText').value = meta.notes;
    for (const sel of ['#synopsisText', '#chapNotesText']) $(sel).disabled = false;
    $('#paneChapter').classList.add('has-chapter');
    loadComments(id, meta.comments);
  } catch (err) {
    showError(err.message);
  }
}

function wireRightPanel() {
  for (const sel of ['#synopsisText', '#chapNotesText']) {
    const ta = $(sel);
    ta.addEventListener('input', () => {
      if (!cmId) return;
      cmDirty = true;
      clearTimeout(cmTimer);
      cmTimer = setTimeout(flushChapMeta, SAVE_DELAY_MS);
    });
    ta.addEventListener('keydown', (e) => playKeySound(e, true));
  }
}

