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
  dock.classList.toggle('empty', el.hidden && $('#cloudState').hidden);
  dock.hidden = !project;
}

function refreshCloudState() {
  const btn = $('#cloudState');
  const c = DOCK.cloud;
  let text = '';
  let err = false;
  if (project && c && c.linked) {
    if (c.error) { text = t('Облако: ошибка'); err = true; }
    else if (c.busy) {
      const pr = DOCK.progress;
      text = pr && pr.total > 0
        ? t(pr.phase === 'upload' ? 'Облако: отправлено {0} из {1}' : 'Облако: получено {0} из {1}', pr.done, pr.total)
        : t('Облако: обмен…');
    }
    else if (c.conflict) { text = t('Облако: есть конфликты'); err = true; }
    else if (c.lastSyncStart && c.lastSyncStart > SAVE.lastWriteAt && !saveIsPending()) text = t('Облако обновлено');
  }
  btn.textContent = text;
  btn.dataset.i = err ? '!' : c && c.busy ? '…' : '☁';
  btn.title = err && c.error ? c.error : t('Открыть окно синхронизации');
  btn.hidden = !text;
  const stop = $('#cloudStop');
  stop.hidden = !(project && c && c.linked && c.busy);
  btn.classList.toggle('err', err);
  refreshSaveState();
}

async function pollCloudState() {
  const activeProject = project;
  try {
    const st = project ? await api.dav('status') : null;
    if (project !== activeProject) return;
    DOCK.cloud = st;
    if (!st || !st.busy) DOCK.progress = null;
  } catch { DOCK.cloud = null; }
  refreshCloudState();
}

function wireDock() {
  // F11 — полный экран: окно просмотра забирает эту клавишу себе, поэтому ловим её сами (Rust не даст сработать дважды).
  // В полном экране полоска меню спрятана; Alt, нажатый и отпущенный отдельно, показывает или прячет её.
  if (!/Mac/i.test(navigator.platform || '') && api.toggleFullscreen) {
    let altAlone = false;
    document.addEventListener('keydown', (e) => {
      if (e.key === 'F11' && !e.ctrlKey && !e.altKey && !e.metaKey) { e.preventDefault(); api.toggleFullscreen().catch(() => {}); altAlone = false; return; }
      altAlone = e.key === 'Alt' && !e.repeat;
    }, true);
    document.addEventListener('keyup', (e) => {
      if (e.key === 'Alt' && altAlone) { altAlone = false; api.menuPeek().catch(() => {}); }
    }, true);
  }
  // Меню окна строит оболочка: при запуске на английском сообщаем язык (раньше это происходило только при переключении).
  if (LANG === 'en') api.setLang('en').catch(() => {});
  // Звук клавиш после долгого сворачивания: проверяем звуковой контекст, когда окно снова на виду.
  const reviveSound = () => { if (!document.hidden) sounds.revive(); };
  document.addEventListener('visibilitychange', reviveSound);
  window.addEventListener('focus', reviveSound);
  $('#cloudStop').addEventListener('click', async () => {
    const b = $('#cloudStop');
    b.disabled = true;
    try { await api.dav('stopPass'); setStatus('ok', t('Обмен остановлен.')); } catch { /* нет такого канала (Android) */ }
    b.disabled = false;
    DOCK.progress = null;
    pollCloudState();
  });
  $('#cloudState').addEventListener('click', () => openSyncDialog());
  DOCK.timer = setInterval(pollCloudState, 4000);
  pollCloudState();
}
wireDock();
