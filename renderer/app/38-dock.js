// ---------- Строка состояния внизу справа ----------
// Одна короткая строка вместо всплывающих «Сохранено»: что с текстом на устройстве и что с облаком.
//   Не сохранено  — запись на устройство не удалась (красным, видна и в режиме фокуса);
//   Сохранено     — текст записан на устройство;
//   Облако обновлено — после последней записи облако успело пройти полный обмен (щелчок открывает «Синхронизацию»).
// Облачная часть есть только там, где ядро сообщает `lastSyncStart` (Rust/Tauri); без него она скрыта.

function saveIsPending() {
  return dirty || noteDirty || cmtDirty || cmDirty || p2.dirty;
}

function refreshSaveState() {
  const dock = $('#statusDock');
  const el = $('#saveState');
  if (!dock || !el) return;
  if (DOCK.project !== project) { DOCK.project = project; SAVE.lastWriteAt = 0; DOCK.cloud = null; }
  const failed = SAVE.failed.size > 0 || !!failedWrite;
  let text = '';
  if (failed) text = t('Не удалось сохранить');
  else if (saveIsPending()) text = t('Сохранение…');
  else if (SAVE.lastWriteAt) text = t('Сохранено');
  el.textContent = text;
  el.hidden = !text || !project;
  el.dataset.i = failed ? '!' : saveIsPending() ? '…' : '✓'; // значок дублирует подпись: цвет не единственный признак
  el.classList.toggle('err', failed);
  const cloudErr = !!(DOCK.cloud && DOCK.cloud.error);
  dock.classList.toggle('has-err', failed || cloudErr);
  dock.hidden = !project || (el.hidden && $('#cloudState').hidden);
}

function refreshCloudState() {
  const btn = $('#cloudState');
  const c = DOCK.cloud;
  let text = '';
  let err = false;
  if (project && c && c.linked) {
    if (c.error) { text = t('Облако: ошибка'); err = true; }
    else if (c.busy) text = t('Облако: обмен…');
    else if (c.conflict) { text = t('Облако: есть конфликты'); err = true; }
    else if (c.lastSyncStart && c.lastSyncStart > SAVE.lastWriteAt && !saveIsPending()) text = t('Облако обновлено');
  }
  btn.textContent = text;
  btn.dataset.i = err ? '!' : c && c.busy ? '…' : '☁';
  btn.title = err && c.error ? c.error : t('Открыть окно синхронизации');
  btn.hidden = !text;
  btn.classList.toggle('err', err);
  refreshSaveState();
}

async function pollCloudState() {
  const activeProject = project;
  try {
    const st = project ? await api.dav('status') : null;
    if (project !== activeProject) return;
    DOCK.cloud = st;
  } catch { DOCK.cloud = null; }
  refreshCloudState();
}

function wireDock() {
  $('#cloudState').addEventListener('click', () => openSyncDialog());
  DOCK.timer = setInterval(pollCloudState, 4000);
  pollCloudState();
}
wireDock();
