// ---------- счётчик слов и цель по словам ----------

// Слово: буквы и цифры, допускается дефис или апостроф внутри («кто-то», «O'Neil»).
const WORD_RE = /[\p{L}\p{N}]+(?:[-–’'][\p{L}\p{N}]+)*/gu;

let stats = { words: 0, chars: 0, charsNoSpace: 0 };
let goalReached = false;   // цель достигнута в текущем состоянии текста
let countTimer = null;
const chimedGoals = new Set(); // «глава:цель», на которые уже звучал сигнал в этом сеансе

function computeStats() {
  const text = editor.getText({ blockSeparator: '\n' });
  const flat = text.replace(/\n/g, '');
  return {
    words: (text.match(WORD_RE) || []).length,
    chars: flat.length,
    charsNoSpace: flat.replace(/\s/g, '').length,
  };
}

// Что считать целью: слова или знаки с пробелами (рассказы: по умолчанию знаки, можно переключить).
function goalMetric() {
  return project && project.mode === 'stories' && project.goalUnit !== 'words' ? 'chars' : 'words';
}
const metricOf = (st) => (goalMetric() === 'chars' ? st.chars : st.words);
const unitText = (v) => (goalMetric() === 'chars' ? t('зн.') : wordsForm(v));
const limitWarned = new Set(); // рассказы, по которым в этом сеансе уже предупреждали о лимите знаков

// Цель главы, а если её нет, то общая цель проекта.
function effectiveGoal() {
  if (!project || !currentId || currentKind !== 'chapter') return null;
  const ch = project.chapters.find((c) => c.id === currentId);
  return (ch && ch.goal) || project.defaultGoal || null;
}

function scheduleCount() {
  clearTimeout(countTimer);
  countTimer = setTimeout(() => updateCounts(true), 150);
}

// fromUser = true: текст изменил пользователь, и пересечение цели даёт сигнал.
function updateCounts(fromUser) {
  clearTimeout(countTimer);
  countTimer = null;
  if (!editor || !project || !currentId || currentKind !== 'chapter') {
    lastWords = null;
    refreshGoalUI();
    return;
  }
  stats = computeStats();
  if (fromUser && lastWords !== null && stats.words > lastWords) addToday(stats.words - lastWords);
  lastWords = stats.words;
  chapterWords.set(currentId, stats.words);
  chapterChars.set(currentId, stats.chars);
  checkProjectGoal(fromUser);
  const limit = project.mode === 'stories' ? project.charLimit : null;
  if (limit && stats.chars > limit) {
    if (fromUser && !limitWarned.has(currentId)) {
      limitWarned.add(currentId);
      setStatus('ok', t('Превышен лимит знаков: +{0}', (stats.chars - limit).toLocaleString(LOCALE)));
    }
  } else {
    limitWarned.delete(currentId);
  }
  const goal = effectiveGoal();
  const reached = goal !== null && metricOf(stats) >= goal;
  if (fromUser && reached && !goalReached) {
    const key = `${currentId}:${goal}`;
    if (!chimedGoals.has(key)) {
      chimedGoals.add(key);
      celebrateGoal();
    }
  }
  goalReached = reached;
  refreshGoalUI();
}

function celebrateGoal() {
  if (settings.goalChime) sounds.chime();
  const box = $('#goal');
  box.classList.remove('hit');
  void box.offsetWidth; // перезапуск анимации
  box.classList.add('hit');
  setTimeout(() => box.classList.remove('hit'), 1400);
}

// Трекер слов главы убирается: его показывает и прячет щелчок по счётчику слов на нижней панели.
let goalShown = false;

function setGoalShown(on) {
  goalShown = on;
  try { localStorage.setItem('kabinet.goalShown', on ? '1' : '0'); } catch { /* ignore */ }
  refreshGoalUI();
}

function refreshGoalUI() {
  const box = $('#goal');
  const chapterOpen = !!project && !!currentId && currentKind === 'chapter';
  box.hidden = !(chapterOpen && goalShown);
  if (!goalShown) closeGoalPop();
  if (!chapterOpen) {
    closeGoalPop();
    layoutGoal();
    refreshBar();
    return;
  }

  const n = (v) => v.toLocaleString(LOCALE);
  const goal = effectiveGoal();
  const cur = metricOf(stats);
  const chars = goalMetric() === 'chars';
  $('#goalPopTitle').textContent = chars ? t('Цель в знаках') : t('Цель по словам');
  const text = $('#goalText');
  text.textContent = '';
  box.classList.toggle('no-goal', goal === null);

  if (goal === null) {
    const only = document.createElement('span');
    only.className = 'main';
    only.textContent = `${n(cur)} ${unitText(cur)}`;
    text.append(only);
    box.style.setProperty('--goal-color', 'var(--accent)');
    $('#goalBtn').title = chars ? t('Нажмите, чтобы задать цель в знаках') : 'Нажмите, чтобы задать цель по словам';
  } else {
    const p = Math.min(1, cur / goal);
    const reached = cur >= goal;
    // красный → оранжевый → жёлтый → зелёный по мере приближения; цель взята: синий
    const hue = reached ? 212 : Math.round(p * 125);
    box.style.setProperty('--goal-color', `hsl(${hue} 85% 50%)`);
    $('#goalFill').style.width = `${cur > 0 ? Math.max(3, p * 100) : 0}%`;

    const b = document.createElement('b');
    b.textContent = n(cur);
    const pct = document.createElement('span');
    pct.className = 'pct';
    pct.textContent = reached
      ? (cur > goal ? `✓ +${n(cur - goal)}` : '✓')
      : `${Math.floor(p * 100)}%`;
    const main = document.createElement('span');
    main.className = 'main';
    main.append(b, ` / ${n(goal)}`);
    text.append(main, pct);
    $('#goalBtn').title = reached ? 'Цель взята. Нажмите, чтобы изменить' : 'Нажмите, чтобы изменить цель';
  }

  $('#stWords').textContent = n(stats.words);
  $('#stChars').textContent = n(stats.chars);
  $('#stCharsNo').textContent = n(stats.charsNoSpace);
  layoutGoal();
  refreshBar();
}

// Где показать индикатор цели, чтобы он не наезжал на текст:
//   margin: в левом поле, если рядом с листом хватает места;
//   dock: компактная плашка над панелью форматирования (панель при этом сдвигается вправо);
//   line: тонкая полоса внизу окна (режим «только лист» без свободного поля).
function layoutGoal() {
  const box = $('#goal');
  const stage = $('#stage');
  if (!box || box.hidden) {
    if (stage) stage.style.setProperty('--dock-reserve', '0px');
    return;
  }
  const canvas = $('#canvas').getBoundingClientRect();
  const paper = $('#paper').getBoundingClientRect();
  const focus = document.body.classList.contains('focus-mode');
  const avail = paper.width > 0 ? paper.left - canvas.left - 18 - 14 : 0;

  let mode;
  let w;
  if (avail >= 150) {
    mode = 'margin';
    w = Math.min(200, Math.floor(avail));
  } else if (!focus) {
    mode = 'dock';
    w = Math.round(Math.max(120, Math.min(190, canvas.width / 4)));
  } else {
    mode = 'line';
    w = 0;
  }
  for (const m of ['margin', 'dock', 'line']) box.classList.toggle(m, m === mode);
  if (w) box.style.setProperty('--goal-w', `${w}px`);
  stage.style.setProperty('--dock-reserve', mode === 'dock' ? `${w + 24}px` : '0px');
}

// «1 слово, 2 слова, 5 слов»
function wordsForm(k) {
  if (LANG === 'en') return k === 1 ? 'word' : 'words';
  const m10 = k % 10;
  const m100 = k % 100;
  if (m10 === 1 && m100 !== 11) return 'слово';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'слова';
  return 'слов';
}

function openGoalPop() {
  if (!project || !currentId) return;
  fillGoalInputs();
  $('#goalPop').hidden = false;
  $('#goalInput').focus();
  $('#goalInput').select();
}

function closeGoalPop() {
  $('#goalPop').hidden = true;
}

function fillGoalInputs() {
  const ch = project.chapters.find((c) => c.id === currentId);
  $('#goalInput').value = ch && ch.goal ? String(ch.goal) : '';
  $('#goalDefaultInput').value = project.defaultGoal ? String(project.defaultGoal) : '';
  $('#goalUnitSelect').value = project.goalUnit === 'words' ? 'words' : 'chars';
  $('#limitInput').value = project.charLimit ? String(project.charLimit) : '';
}

// Пустое поле: цели нет (null). Непонятный ввод: undefined, значение не меняем.
function parseGoal(text) {
  const t = String(text).replace(/[\s ]/g, '').replace(',', '.');
  if (t === '') return null;
  const v = parseFloat(t);
  return Number.isFinite(v) && v >= 1 ? Math.min(1_000_000, Math.round(v)) : undefined;
}

async function commitGoalInputs() {
  const id = currentId;
  if (!id || !project) return;
  const chapterGoal = parseGoal($('#goalInput').value);
  const defaultGoal = parseGoal($('#goalDefaultInput').value);
  try {
    if (chapterGoal !== undefined) project = await api.setChapterGoal(id, chapterGoal);
    if (defaultGoal !== undefined) project = await api.setDefaultGoal(defaultGoal);
    if (project.mode === 'stories') {
      const limit = parseGoal($('#limitInput').value);
      if (limit !== undefined) project = await api.setCharLimit(limit);
    }
  } catch (err) {
    showError(err.message);
  }
  if (currentId === id) fillGoalInputs(); // показываем то, что реально сохранилось
  updateCounts(false); // смена цели сама по себе сигнала не даёт
}

function wireGoal() {
  try { goalShown = localStorage.getItem('kabinet.goalShown') === '1'; } catch { /* ignore */ }
  const stats = $('#barStats');
  stats.addEventListener('click', () => {
    if (currentKind === 'chapter' && currentId) setGoalShown(!goalShown);
  });
  stats.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); stats.click(); }
  });
  $('#goalBtn').addEventListener('click', () => {
    if ($('#goalPop').hidden) openGoalPop();
    else closeGoalPop();
  });

  $('#goalUnitSelect').addEventListener('change', async (e) => {
    try {
      project = await api.setGoalUnit(e.target.value);
      refreshTotals();
    } catch (err) {
      showError(err.message);
    }
    fillGoalInputs();
    updateCounts(false);
  });

  for (const sel of ['#goalInput', '#goalDefaultInput', '#limitInput']) {
    const el = $(sel);
    el.addEventListener('change', commitGoalInputs);
    el.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        await commitGoalInputs();
        closeGoalPop();
      }
      if (e.key !== 'Escape') e.stopPropagation();
    });
  }

  $('#goalClear').addEventListener('click', () => {
    $('#goalInput').value = '';
    commitGoalInputs();
  });

  document.addEventListener('mousedown', (e) => {
    if ($('#goalPop').hidden) return;
    if (e.target.closest('#goalPop') || e.target.closest('#goal')) return;
    closeGoalPop();
  });
}

function toggleAmbient() {
  settings.ambientOn = !settings.ambientOn;
  applySettings();
  saveSettings();
  setStatus('ok', settings.ambientOn ? `Эмбиент: ${AMBIENTS[settings.ambient] || ''}` : 'Эмбиент выключен');
}

function toggleSound() {
  settings.soundOn = !settings.soundOn;
  applySettings();
  saveSettings();
  setStatus('ok', settings.soundOn ? 'Звуки включены' : 'Звуки выключены');
}

function fixChapterTypography() {
  if (!project || !currentId || !isTextKind(currentKind) || !editor.isEditable) {
    showError(t('Откройте главу или заметку, чтобы привести в порядок её типографику.'));
    return;
  }
  const n = fixDocTypography(editor, { quotes: true, dashes: true, nbsp: settings.typoNbsp });
  setStatus('ok', n ? t('Типографика: исправлено мест — {0}. Отменить: ⌘Z', n) : t('Типографика уже в порядке'));
}

// Смена языка: сохраняем текст, запоминаем, где были, и перезагружаем окно.
async function switchLang(lang) {
  if (lang === LANG) return;
  try {
    await flush();
    sessionStorage.setItem('kabinet.resume', JSON.stringify(project && currentId ? { kind: currentKind, id: currentId } : { none: true }));
    await api.setLang(lang);
    location.reload();
  } catch (err) {
    showError(err.message);
  }
}

// После перезагрузки проект в main остался открытым: возвращаемся в него и в ту же главу.
async function resumeAfterReload() {
  let r = null;
  try { r = JSON.parse(sessionStorage.getItem('kabinet.resume') || 'null'); sessionStorage.removeItem('kabinet.resume'); } catch { /* ignore */ }
  if (!r) return false;
  try {
    const proj = await api.currentProject();
    if (!proj) return false;
    enterProject(proj);
    if (r.id && proj.chapters.some((c) => c.id === r.id) && r.kind === 'chapter') openDoc('chapter', r.id);
    return true;
  } catch { return false; }
}

