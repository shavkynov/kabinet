// ---------- анализ текста: подсветка частей речи ----------

const AN_NAMES = { verb: 'Глаголы', noun: 'Существительные', adj: 'Прилагательные', adv: 'Наречия', part: 'Причастия и деепричастия', pron: 'Местоимения' };
let lastAn = '';

function applyAnalysisSettings() {
  for (const k of AN_CATS) $(`#an_${k}`).checked = !!settings.an[k];
  const inp = $('#anLongMin');
  if (document.activeElement !== inp) inp.value = String(settings.anLongMin);
  const win = $('#anRepeatWin');
  if (document.activeElement !== win) win.value = String(settings.anRepeatWin);
  renderFillers();
  $('#tenseMode').value = settings.tenseMode;
  document.querySelectorAll('#viewAnalysis [data-extra]').forEach((row) => { row.hidden = !settings.anShow[row.dataset.extra] && !settings.an[row.dataset.extra]; });
  document.querySelectorAll('#viewAnalysis input[data-anshow]').forEach((box) => { box.checked = !!settings.anShow[box.dataset.anshow]; });
  $('#btnCheck').classList.toggle('lit', AN_CATS.some((k) => settings.an[k]));
  $('#anFillerSpeech').checked = settings.fillerSkipSpeech;
  const sig = JSON.stringify([settings.an, settings.tenseMode, settings.anLongMin, settings.anRepeatWin, settings.fillers, settings.fillerSkipSpeech]);
  if (sig !== lastAn) {
    lastAn = sig;
    if (editor) refreshAnalysis(editor);
    else if (!AN_CATS.some((k) => settings.an[k])) showAnalysisStats({}, false);
    renderTense();
    renderRhythm();
  }
}

// Список слов-паразитов: стандартный набор, из него можно убрать лишнее и добавить свои слова и фразы.
let lastFillerSig = '';

function renderFillers() {
  const sig = JSON.stringify(settings.fillers);
  if (sig === lastFillerSig) return;
  lastFillerSig = sig;
  const box = $('#fillerList');
  box.textContent = '';
  for (const w of settings.fillers) {
    const chip = document.createElement('span');
    chip.className = 'chip-w';
    chip.setAttribute('translate', 'no');
    chip.append(w.endsWith('~') ? t('{0} (все формы)', w.slice(0, -1)) : w);
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = '×';
    del.title = t('Убрать из списка');
    del.addEventListener('click', () => setFillers(settings.fillers.filter((x) => x !== w)));
    chip.append(del);
    box.append(chip);
  }
  $('#fillerCount').textContent = String(settings.fillers.length);
}

function setFillers(list) {
  settings.fillers = cleanFillerList(list);
  applySettings();
  saveSettings();
}

function addFiller(raw) {
  const w = cleanFiller(raw);
  if (!w) return false;
  if (!settings.fillers.includes(w)) setFillers([...settings.fillers, w]);
  return true;
}

function showAnalysisStats(st, active) {
  for (const k of AN_CATS) {
    const el = $(`#anCount_${k}`);
    if (!active) { el.textContent = ''; continue; }
    const n = st[k] || 0;
    el.textContent = AN_NAMES[k] && st.words ? `${n} · ${Math.round((n / st.words) * 100)}%` : String(n);
  }
  $('#anTotal').textContent = active ? t('Слов в разборе: {0}', st.words || 0) : '';
  // «‹ ›» нужны только там, где есть что листать
  document.querySelectorAll('#viewAnalysis [data-an-nav]').forEach((b) => {
    const k = b.dataset.anNav;
    b.disabled = !(active && settings.an[k] && (st[k] || 0) > 0);
  });
}

// ---------- переход к предыдущему и следующему месту в «Подсветке» ----------
const NAV_NAMES = { adv: 'Наречия', passive: 'Страдательный залог', long: 'Длинные предложения', repeat: 'Повторы слов', filler: 'Слова-паразиты' };

function stepAnalysis(cat, dir) {
  if (!editor) return;
  const list = analysisRanges(editor.state)[cat] || [];
  const idx = stepIndex(list, editor.state.selection.from, dir);
  if (idx < 0) { setStatus('ok', t('Нет отмеченных мест')); return; }
  gotoRhythm(list[idx].from, list[idx].to); // тот же переход, что в «Ритме»
  setStatus('ok', t('{0}: {1} из {2}', t(NAV_NAMES[cat]), idx + 1, list.length));
}

// ---------- исключения «Не отмечать здесь» (хранятся в настройках проекта) ----------
function currentSkip() {
  return (project && project.analysisSkip) || {};
}

async function saveSkip(next) {
  if (!project) return;
  try {
    project = await api.setAnalysisSkip(next);
    if (editor) refreshAnalysis(editor);
    renderSkip();
  } catch (err) {
    showError(err.message);
  }
}

function addAnalysisSkip(cat, text) {
  const key = skipKey(text);
  if (!key || !AN_NAV_CATS.includes(cat)) return;
  const cur = currentSkip();
  if ((cur[cat] || []).includes(key)) return;
  saveSkip({ ...cur, [cat]: [...(cur[cat] || []), key] });
  setStatus('ok', t('«{0}» больше не отмечается', key.length > 40 ? `${key.slice(0, 40)}…` : key));
}

function removeAnalysisSkip(cat, key) {
  const cur = currentSkip();
  saveSkip({ ...cur, [cat]: (cur[cat] || []).filter((x) => x !== key) });
}

function renderSkip() {
  const box = $('#skipBox');
  if (!box) return;
  const cur = currentSkip();
  const entries = AN_NAV_CATS.flatMap((cat) => (cur[cat] || []).map((key) => ({ cat, key })));
  box.hidden = !entries.length;
  $('#skipCount').textContent = entries.length ? String(entries.length) : '';
  const list = $('#skipList');
  list.textContent = '';
  for (const { cat, key } of entries) {
    const chip = document.createElement('span');
    chip.className = 'chip-w';
    chip.setAttribute('translate', 'no');
    chip.append(`${t(NAV_NAMES[cat])}: ${key.length > 32 ? `${key.slice(0, 32)}…` : key}`);
    chip.title = key;
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = '×';
    del.title = t('Убрать исключение');
    del.addEventListener('click', () => removeAnalysisSkip(cat, key));
    chip.append(del);
    list.append(chip);
  }
}

function setCheckView(view) {
  const v = view === 'check' || view === 'tense' || view === 'rhythm' ? view : 'analysis';
  $('#viewAnalysis').hidden = v !== 'analysis';
  $('#viewCheck').hidden = v !== 'check';
  $('#viewTense').hidden = v !== 'tense';
  $('#viewRhythm').hidden = v !== 'rhythm';
  if (v === 'tense') renderTense();
  if (v === 'rhythm') renderRhythm();
  document.querySelectorAll('#checkPanel .seg button').forEach((b) => {
    const on = b.dataset.view === v;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  try { sessionStorage.setItem('kabinet.checkView', v); } catch { /* ignore */ }
}

// ---------- несогласованность времён: список как у проверки ошибок ----------
let tenseTimer = 0;
let tenseItems = [];

function scheduleTense() {
  if (!$('#checkPanel') || $('#checkPanel').hidden || $('#viewTense').hidden) return;
  clearTimeout(tenseTimer);
  tenseTimer = setTimeout(renderTense, 500);
}

function renderTense() {
  const box = $('#tenseList');
  if (!box || !editor || $('#viewTense').hidden) return;
  const res = scanTense(editor.state.doc, settings.tenseMode);
  tenseItems = res.items;
  const names = { present: t('настоящее'), past: t('прошедшее'), unknown: t('не определено') };
  $('#tenseBase').textContent = t('Основное время: {0}. Глаголов в главных предложениях: настоящего {1}, прошедшего {2}.', names[res.base], res.present, res.past);
  box.textContent = '';
  if (!res.items.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = res.base === 'unknown' ? t('Основное время не определено: слишком мало глаголов. Выберите его вручную.') : t('Несогласованности времён не найдено.');
    box.append(p);
    return;
  }
  const doc = editor.state.doc;
  res.items.slice(0, 200).forEach((it, idx) => {
    const row = document.createElement('div');
    row.className = 'chk-item tense-item';
    row.dataset.idx = String(idx);
    const head = document.createElement('div');
    head.className = 'chk-head';
    const tag = document.createElement('span');
    tag.className = 'chk-tag';
    tag.textContent = it.why === 'description' ? t('Возможный приём') : it.kind === 'past' ? t('Прошедшее') : t('Настоящее');
    const msg = document.createElement('span');
    msg.className = 'chk-msg';
    // почему отмечено: рядом глагол основного времени, действие героя или похоже на описание
    msg.textContent = it.why === 'description' ? t('похоже на описание или общую истину: проверьте, задумано ли')
      : it.why === 'mixed' ? t('в одном предложении с глаголом основного времени')
        : it.kind === 'past' ? t('в тексте о настоящем') : t('в тексте о прошлом');
    head.append(tag, msg);
    const $f = doc.resolve(it.from);
    const blockText = $f.parent.textBetween(0, $f.parent.content.size, '', '￼').replace(/\s+/g, ' ');
    const off = it.from - $f.start();
    const len = it.to - it.from;
    const ctx = document.createElement('div');
    ctx.className = 'chk-ctx';
    ctx.setAttribute('translate', 'no');
    const mark = document.createElement('mark');
    mark.textContent = doc.textBetween(it.from, it.to);
    ctx.append(document.createTextNode(`${off > 28 ? '…' : ''}${blockText.slice(Math.max(0, off - 28), off)}`), mark, document.createTextNode(blockText.slice(off + len, off + len + 28)));
    row.append(head, ctx);
    box.append(row);
  });
  if (res.items.length > 200) {
    const more = document.createElement('p');
    more.className = 'hint';
    more.textContent = t('Показаны первые 200 из {0}.', res.items.length);
    box.append(more);
  }
}

function gotoTense(idx) {
  const it = tenseItems[idx];
  if (!it || !editor) return;
  editor.chain().focus().setTextSelection({ from: it.from, to: it.to }).run();
  requestAnimationFrame(() => {
    try {
      const { node } = editor.view.domAtPos(it.from);
      const el = node.nodeType === 1 ? node : node.parentElement;
      if (el) el.scrollIntoView({ block: 'center' });
    } catch { /* текст успел измениться */ }
  });
}

function wireAnalysis() {
  $('#viewAnalysis').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-an-nav]');
    if (!b || b.disabled) return;
    e.preventDefault();
    stepAnalysis(b.dataset.anNav, Number(b.dataset.dir));
  });
  document.querySelectorAll('#viewAnalysis input[data-anshow]').forEach((box) => box.addEventListener('change', () => {
    settings.anShow = { ...settings.anShow, [box.dataset.anshow]: box.checked };
    if (!box.checked) delete settings.anShow[box.dataset.anshow];
    applySettings();
    saveSettings();
  }));
  $('#tenseMode').addEventListener('change', (e) => {
    settings.tenseMode = e.target.value === 'present' || e.target.value === 'past' ? e.target.value : 'auto';
    applySettings();
    saveSettings();
  });
  wireRhythm();
  wireMode();
  $('#tenseList').addEventListener('click', (e) => {
    const row = e.target.closest('.tense-item');
    if (!row) return;
    gotoTense(Number(row.dataset.idx));
  });
  document.querySelectorAll('#checkPanel input[data-an]').forEach((box) => {
    box.addEventListener('change', () => {
      settings.an = { ...settings.an, [box.dataset.an]: box.checked };
      if (!box.checked) delete settings.an[box.dataset.an];
      applySettings();
      saveSettings();
    });
  });
  const fin = $('#fillerInput');
  const addFromInput = () => {
    const raw = fin.value.trim();
    // галочка «Все формы слова» действует на одно слово без знаков
    const entry = $('#fillerForms').checked && /^[\p{L}-]+$/u.test(raw) ? `${raw}~` : raw;
    if (addFiller(entry)) fin.value = '';
    else if (raw) showError(t('Введите слово или фразу, от 2 до 40 знаков. Знак * или ~ только в конце одного слова после трёх букв.'));
    fin.focus();
  };
  $('#btnFillerAdd').addEventListener('click', addFromInput);
  fin.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addFromInput(); } });
  $('#btnFillerReset').addEventListener('click', () => {
    if (confirm(t('Вернуть стандартный список? Ваши слова из списка пропадут.'))) setFillers(DEFAULT_FILLERS[LANG] || DEFAULT_FILLERS.ru);
  });
  const win = $('#anRepeatWin');
  const commitWin = () => {
    settings.anRepeatWin = clampNum(String(win.value).replace(/\D/g, ''), 5, 200, 25);
    applySettings();
    saveSettings();
    win.value = String(settings.anRepeatWin);
  };
  win.addEventListener('change', commitWin);
  win.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitWin(); win.blur(); } });
  const inp = $('#anLongMin');
  const commit = () => {
    settings.anLongMin = clampNum(String(inp.value).replace(/\D/g, ''), 10, 200, 30);
    applySettings();
    saveSettings();
    inp.value = String(settings.anLongMin);
  };
  inp.addEventListener('change', commit);
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); inp.blur(); } });
  document.querySelectorAll('#checkPanel .seg button').forEach((b) => b.addEventListener('click', () => setCheckView(b.dataset.view)));
  let v = 'analysis';
  try { v = sessionStorage.getItem('kabinet.checkView') || v; } catch { /* ignore */ }
  setCheckView(v);
}

function openConsent() {
  return new Promise((resolve) => {
    const dlg = $('#consentDialog');
    dlg.returnValue = '';
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
    dlg.showModal();
  });
}

function init() {
  const plat = window.kabinet.platform;
  document.body.classList.add(plat === 'darwin' ? 'plat-mac' : plat === 'win32' ? 'plat-win' : 'plat-other');
  initDomTranslation();
  initKeyLabels();
  settings = loadSettings();
  fillFontSelect();
  initEditor();
  checker = initTextCheck({
    api,
    $,
    getEditor: () => editor,
    canCheck: () => !!(project && currentId && isTextKind(currentKind)),
    cardNames: () => cardIdx.flatMap((c) => [c.title, ...(c.aliases || []), ...(c.forms || [])]).flatMap((x) => String(x).split(/\s+/)).filter(Boolean),
    showError,
    setStatus,
    openConsent,
  });
  initEditor2();
  wireRightPanel();
  wireComments();
  wireSearch();
  wireBoard();
  wireProjGoal();
  wireChrome();
  wireAnalysis();
  wireGoal();
  applySettings();
  wireSidebar();
  wireMobile();
  // шрифты и звуки подгружаем в фоне; после загрузки применяем настройки ещё раз
  loadCustomFonts().then(applySettings);
  loadSounds();
  wireLists();

  $('#btnNewNovel').addEventListener('click', () => askNewProject('novel'));
  $('#btnNewStories').addEventListener('click', () => askNewProject('stories'));
  $('#btnOpen').addEventListener('click', openProjectFromDialog);

  enterConfirms($('#nameDialog'), $('#projectNameInput'));
  const dlg = $('#nameDialog');
  dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'ok') return;
    const name = $('#projectNameInput').value.trim();
    if (name) createProjectFromName(name, dlg.dataset.mode || 'novel');
  });

  api.onToggleSidebar(() => { if (project) toggleSidebar(); });
  api.onNewProject(() => { if (project) leaveProject(); else showStart(); }); // «Новый проект» ведёт на стартовую страницу: там выбор «Роман» или «Рассказы»
  api.onOpenProject(openProjectFromDialog);
  api.onCloseProject(() => { if (project) leaveProject(); });
  api.onToggleTypewriter(() => { if (project) toggleTypewriter(); });
  api.onToggleMarks(() => { settings.marks = !settings.marks; applySettings(); saveSettings(); });
  api.onToggleFocus(() => toggleFocusMode());
  api.onOpenSettings(() => { if (project) toggleSettings(); });
  api.onToggleSound(() => toggleSound());
  api.onToggleAmbient(() => toggleAmbient());
  api.onOpenSearch(openSearch);
  api.onExport(exportProject);
  api.onImportFiles(importFiles);
  api.onExternalChange(onExternalChange);
  // Windows и Linux: строку меню можно спрятать, тогда вместо неё в окне кнопка «☰» с тем же меню.
  api.onMenuBar((visible) => { $('#btnMenu').hidden = visible !== false; });
  $('#btnMenu').addEventListener('click', () => {
    const r = $('#btnMenu').getBoundingClientRect();
    api.popupMenu(r.left, r.bottom).catch((err) => showError(err.message));
  });
  api.onOpenTemplates(() => { if (project) { closePanels(); openTemplates('character'); } });
  api.onBackupNow(() => { if (project) backupNow(); });
  api.onOpenBackups(() => {
    if (project) api.openBackupFolder().catch((err) => showError(err.message));
  });
  api.onSetLang((l) => switchLang(l));
  api.onOpenCheck(() => { if (project) { setCheckView('check'); openPanel('check'); } });
  api.onToggleSpell(() => {
    settings.spellOn = !settings.spellOn;
    applySettings();
    saveSettings();
    setStatus('ok', settings.spellOn ? t('Орфография: подчёркивание включено') : t('Орфография: подчёркивание выключено'));
  });
  api.onContextMenu(onNativeContext);

  showStart().then(() => resumeAfterReload());
}

init();
