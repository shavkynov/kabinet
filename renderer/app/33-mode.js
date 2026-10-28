// ---------- режим проекта: «Роман» или «Рассказы» ----------
// Данные те же. В рассказах меняются слова («глава» → «рассказ»), у списка нет нумерации,
// над текстом стоит название рассказа, в строке внизу есть авторские листы (40 000 знаков с пробелами).

let storyHeadKey = '';
let kindsSig = '';

// В рассказах разделы «Персонажи» и «Места» по умолчанию скрыты, включаются в настройках (Aa).
// В романе виден всё. Скрытые виды не подсвечиваются в тексте и не предлагаются в контекстном меню.
function kindEnabled(kind) {
  if (!project || project.mode !== 'stories') return true;
  if (kind === 'character') return settings.storyCharacters === true;
  if (kind === 'place') return settings.storyPlaces === true;
  return true;
}

function applyKinds() {
  const sig = `${project ? project.mode : ''}|${settings.storyCharacters}|${settings.storyPlaces}`;
  if (sig === kindsSig) return;
  kindsSig = sig;
  for (const k of ['character', 'place']) {
    const sec = document.querySelector(`#binder [data-sec="${k}"]`);
    if (sec) sec.hidden = !kindEnabled(k);
  }
  applyLinks();
  if (project && currentKind && !kindEnabled(currentKind)) {
    if (project.chapters.length > 0) openDoc('chapter', project.chapters[0].id);
    else showNothing();
  }
}

function applyMode(mode) {
  const m = mode === 'stories' ? 'stories' : 'novel';
  setTermsMode(m);
  document.body.classList.toggle('mode-stories', m === 'stories');
  applyTermsDom();
  kindsSig = '';
  applyKinds();
  storyHeadKey = '';
  if (project) updateStoryHead();
  else $('#storyHead').hidden = true;
}

// Название рассказа над текстом. У рассказа без своего названия («Рассказ 3») поле пустое.
function updateStoryHead() {
  const head = $('#storyHead');
  const input = $('#storyTitle');
  const show = !!project && project.mode === 'stories' && currentKind === 'chapter' && !!currentId;
  head.hidden = !show;
  if (!show) { storyHeadKey = ''; return; }
  const c = project.chapters.find((x) => x.id === currentId);
  if (!c) return;
  const auto = /^(Глава|Рассказ|Chapter|Story) \d+$/.test(c.title);
  const key = `${c.id}\n${c.title}`;
  if (key === storyHeadKey || document.activeElement === input) return;
  storyHeadKey = key;
  input.value = auto ? '' : c.title;
}

async function commitStoryTitle() {
  const input = $('#storyTitle');
  if (!project || currentKind !== 'chapter' || !currentId) return;
  const c = project.chapters.find((x) => x.id === currentId);
  const value = input.value.trim();
  if (!c || !value || value === c.title) { storyHeadKey = ''; updateStoryHead(); return; }
  try {
    await renameDoc('chapter', currentId, value);
    refreshLists();
  } catch (err) {
    showError(err.message);
  }
  storyHeadKey = '';
  updateStoryHead();
}

function wireMode() {
  const input = $('#storyTitle');
  input.addEventListener('change', commitStoryTitle);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
      if (editor) editor.commands.focus('start');
    } else if (e.key === 'Escape') {
      storyHeadKey = '';
      input.blur();
      updateStoryHead();
    }
    e.stopPropagation();
  });
}
