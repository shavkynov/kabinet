// ---------- синхронизация: правки, пришедшие с другого устройства через облачную папку ----------
// main следит за файлами проекта и присылает список изменённых (свои записи он отсеивает).
// Здесь: обновляем списки и открытые документы. Документ с несохранёнными правками не трогаем:
// при его сохранении main сам спрячет чужую версию в папку «Конфликты».

const FOLDER_OF = { chapter: 'Главы', character: 'Персонажи', place: 'Места', note: 'Заметки' };
const EXT_OF = { chapter: 'md', character: 'json', place: 'json', note: 'md' };
let syncBusy = false;
let syncQueue = [];

const relFile = (kind, id) => `${FOLDER_OF[kind]}/${id}.${EXT_OF[kind]}`;

// Сообщение о том, что при сохранении нашлась чужая версия (res приходит из writeChapter / writeItem).
function noteSyncConflict(res) {
  if (res && res.conflict) {
    setStatus('ok', t('Этот текст изменили на другом устройстве. Чужая версия сохранена в папке «Конфликты».'));
  }
}

async function onExternalChange(files) {
  if (!project) return;
  syncQueue.push(...files);
  if (syncBusy) return;
  syncBusy = true;
  try {
    while (syncQueue.length) {
      const batch = [...new Set(syncQueue)];
      syncQueue = [];
      await applyExternal(batch);
    }
  } catch (err) {
    console.error('sync:', err);
  } finally {
    syncBusy = false;
  }
}

async function applyExternal(files) {
  const set = new Set(files);

  // 1. Структура проекта: порядок и названия глав, карточки, заметки, корзина.
  const fresh = await api.reloadProject();
  if (!project || JSON.stringify(fresh) !== JSON.stringify(project)) {
    project = fresh;
    $('#projectName').textContent = project.name;
    refreshLists();
    refreshTotals();
    if (currentId && !dirty && !itemsOf(currentKind).some((c) => c.id === currentId)) showNothing(); // удалили на другом устройстве
    if (p2.id && !project.chapters.some((c) => c.id === p2.id)) await closePane2();
  }

  // 2. Открытые документы, которые изменились и не правятся прямо сейчас.
  let reloaded = false;
  let kept = false;
  if (currentId && currentKind && set.has(relFile(currentKind, currentId))) {
    if (dirty) {
      kept = true;
    } else if (itemsOf(currentKind).some((c) => c.id === currentId)) {
      const kind = currentKind;
      const id = currentId;
      currentKind = null;
      currentId = null;
      await openDoc(kind, id);
      reloaded = true;
    }
  }
  if (p2.id && set.has(relFile('chapter', p2.id))) {
    if (p2.dirty) {
      kept = true;
    } else {
      const id = p2.id;
      p2.id = null;
      await openPane2(id);
      reloaded = true;
    }
  }
  if (noteId && set.has(relFile('note', noteId))) {
    if (noteDirty) {
      kept = true;
    } else {
      const id = noteId;
      noteId = null;
      await openNote(id);
      reloaded = true;
    }
  }

  // 3. Имена в тексте и счётчики.
  if ([...set].some((f) => f.startsWith('Персонажи/') || f.startsWith('Места/'))) await refreshIndex();
  if ([...set].some((f) => f.startsWith('Главы/'))) refreshTotals();

  if (kept) setStatus('ok', t('Этот текст изменили на другом устройстве. Ваша версия сохранится, чужая уйдёт в папку «Конфликты».'));
  else if (reloaded) setStatus('ok', t('Обновлено: изменения с другого устройства'));
}
