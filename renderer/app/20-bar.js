// ---------- нижняя панель: сведения и быстрые переключатели ----------

let lastWords = null; // слов в главе на прошлом пересчёте (для счёта «сегодня»)

function todayStamp() {
  return new Date().toLocaleDateString('sv');
}

function readToday() {
  try {
    const raw = JSON.parse(localStorage.getItem('kabinet.today') || '{}');
    if (raw.date === todayStamp() && raw.by && typeof raw.by === 'object') return { date: raw.date, by: raw.by };
  } catch { /* начнём заново */ }
  return { date: todayStamp(), by: {} };
}

function todayWords() {
  return project ? Number(readToday().by[project.name]) || 0 : 0;
}

// Считаем только прибавку слов: стирание «сегодняшний итог» не уменьшает.
function addToday(n) {
  if (!project || n <= 0) return;
  const t = readToday();
  t.by[project.name] = (Number(t.by[project.name]) || 0) + n;
  try { localStorage.setItem('kabinet.today', JSON.stringify(t)); } catch { /* ignore */ }
  scheduleDayStat();
}

// Итог за день дублируем в файл проекта (stats.json), чтобы история по дням ехала вместе с проектом.
let dayStatTimer = null;
function scheduleDayStat() {
  clearTimeout(dayStatTimer);
  dayStatTimer = setTimeout(() => {
    if (!project) return;
    api.setDayWords(todayStamp(), todayWords()).catch((err) => console.error('day stat:', err));
  }, 2500);
}

function updateSelectionInfo() {
  if (!editor || !editor.isEditable) {
    $('#barSel').textContent = '';
    return;
  }
  const { from, to } = editor.state.selection;
  let words = 0;
  if (from !== to) words = (editor.state.doc.textBetween(from, to, ' ').match(WORD_RE) || []).length;
  $('#barSel').textContent = words ? `Выделено: ${words.toLocaleString(LOCALE)} ${wordsForm(words)}` : '';
  document.querySelector('.bar-info').classList.toggle('has-sel', words > 0);
}

function refreshBar() {
  const n = (v) => v.toLocaleString(LOCALE);
  const chapter = !!project && currentKind === 'chapter' && !!currentId;
  let info = '';
  if (chapter) {
    const limit = project.mode === 'stories' ? project.charLimit : null;
    const charsText = limit ? `${n(stats.chars)} / ${n(limit)}` : n(stats.chars);
    info = `${n(stats.words)} ${wordsForm(stats.words)} · ${charsText} зн.`;
    if (project.mode === 'stories') { // авторские листы: 40 000 знаков с пробелами
      info += ` · ${t('{0} а. л.', authorSheets(stats.chars).toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 }))}`;
    }
  }
  $('#barStats').textContent = info;
  $('#barStats').classList.toggle('on', goalShown);
  $('#barStats').classList.toggle('over', chapter && project.mode === 'stories' && !!project.charLimit && stats.chars > project.charLimit);
  $('#barRead').textContent = chapter && stats.words >= 90
    ? t('чтение ≈ {0} мин', Math.max(1, Math.round(stats.words / 180))) : '';
  const today = todayWords();
  $('#barToday').textContent = project && today > 0 ? `Сегодня +${n(today)}` : '';
  if (!chapter) $('#barSel').textContent = '';
  document.querySelector('.bar-info').classList.toggle('has-sel', $('#barSel').textContent !== '');
  renderTotal();
  updateStoryHead();

  const on = {
    typewriter: settings.typewriter,
    sound: settings.soundOn,
    ambient: settings.ambientOn,
    notes: notesShown(),
    split: !!p2.id,
    focus: document.body.classList.contains('focus-mode'),
  };
  document.querySelectorAll('#toolbar button[data-act]').forEach((b) => {
    b.classList.toggle('active', !!on[b.dataset.act]);
  });
}

