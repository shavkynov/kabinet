// ---------- экраны ----------

function showScreen(name) {
  $('#start').hidden = name !== 'start';
  $('#workspace').hidden = name !== 'workspace';
  document.title = name === 'workspace' && project ? t('{0} — Кабинет', project.name) : t('Кабинет');
}

async function showStart() {
  document.body.classList.remove('focus-mode');
  closeSettings();
  applyAmbient();
  refreshGoalUI();
  showScreen('start');
  await renderRecents();
}

async function renderRecents() {
  let items = [];
  try {
    items = await api.listRecents();
  } catch (err) {
    showError(err.message);
  }
  const ul = $('#recentList');
  ul.textContent = '';
  $('#noRecent').hidden = items.length > 0;

  for (const it of items) {
    const li = document.createElement('li');
    li.className = 'recent' + (it.exists ? '' : ' missing');

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'recent-main';
    const name = document.createElement('div');
    name.className = 'recent-name';
    name.setAttribute('translate', 'no');
    name.textContent = it.name || it.path;
    const where = document.createElement('div');
    where.className = 'recent-path';
    where.setAttribute('translate', 'no');
    where.textContent = it.exists ? it.path : `${it.path} (папка не найдена)`;
    const date = document.createElement('div');
    date.className = 'recent-date';
    date.textContent = it.lastOpened
      ? new Date(it.lastOpened).toLocaleDateString(LOCALE, { day: 'numeric', month: 'long', year: 'numeric' })
      : '';
    main.append(name, where, date);
    main.addEventListener('click', () => openRecent(it));

    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'recent-remove';
    rm.textContent = '×';
    rm.title = 'Убрать из списка (файлы проекта не удаляются)';
    rm.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await api.removeRecent(it.path);
      } catch (err) {
        showError(err.message);
      }
      renderRecents();
    });

    li.append(main, rm);
    ul.append(li);
  }
}

async function openRecent(it) {
  if (!it.exists) {
    showError(`Папка проекта не найдена:\n${it.path}\n\nВозможно, её переместили или отключён диск.`);
    return;
  }
  try {
    const proj = await api.openRecent(it.path);
    if (proj) enterProject(proj);
  } catch (err) {
    showError(err.message);
  }
}

async function openProjectFromDialog() {
  await flush();
  try {
    const proj = await api.openProjectDialog();
    if (proj) enterProject(proj);
  } catch (err) {
    showError(err.message);
  }
}

function askNewProject(mode) {
  const dlg = $('#nameDialog');
  const input = $('#projectNameInput');
  $('#projectModeInput').value = mode === 'stories' ? 'stories' : 'novel';
  input.value = '';
  dlg.returnValue = '';
  dlg.showModal();
  input.focus();
}

async function createProjectFromName(name, mode) {
  await flush();
  try {
    const proj = await api.createProject(name, mode);
    if (proj) enterProject(proj);
  } catch (err) {
    showError(err.message);
  }
}

async function leaveProject() {
  await flush();
  try {
    await api.closeProject();
  } catch (err) {
    showError(err.message);
  }
  project = null;
  renderSkip();
  currentId = null;
  currentKind = null;
  applyMode('novel');
  clearChapMeta();
  resetPane2();
  await showStart();
}

function enterProject(proj) {
  project = proj;
  renderSkip();
  applyMode(proj.mode);
  currentId = null;
  currentKind = null;
  dirty = false;
  dirtyId = null;
  dirtyKind = null;
  for (const k of Object.keys(lastSelected)) lastSelected[k] = null;
  closeMenu();
  applyAmbient();
  resetNote();
  clearChapMeta();
  resetPane2();
  chapterWords.clear();
  chapterChars.clear();
  projReached = false;
  closeBoard();
  closeProjPop();
  cardIdx = [];
  refreshIndex();
  refreshTotals();
  lastWords = null;
  $('#projectName').setAttribute('translate', 'no');
  $('#projectName').textContent = proj.name;
  showScreen('workspace');
  refreshLists();
  if (proj.chapters.length > 0) {
    openDoc('chapter', proj.chapters[0].id);
  } else {
    showNothing();
  }
  $('#chapterList').focus();
  layoutGoal();
}

