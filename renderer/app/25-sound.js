// ---------- звук: варианты, эмбиент ----------

function markChips(sel, value) {
  document.querySelectorAll(`${sel} button`).forEach((b) => {
    const on = b.dataset.value === value;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  });
}

let ambientToken = 0;

async function applyAmbient() {
  ambient.setVolume(settings.ambientVol / 100);
  const token = ++ambientToken;
  if (!(settings.ambientOn && project)) {
    ambient.stop();
    return;
  }
  const variant = settings.ambient;
  const file = settings.ambientSrc[variant] || 'default';
  let buffer = null;
  if (file !== 'default') {
    try { buffer = await getSoundBuffer(`ambient/${variant}`, file); } catch { buffer = null; }
  }
  if (token !== ambientToken) return; // за это время выбрали другое
  ambient.play(variant, buffer);
}

function wireChips() {
  $('#chipProfile').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-value]');
    if (!b) return;
    settings.soundProfile = b.dataset.value;
    settings.soundOn = true;
    applySettings();
    saveSettings();
    sounds.test();
  });
  $('#chipAmbient').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-value]');
    if (!b) return;
    ambientListOpen = b.dataset.value !== settings.ambient || !ambientListOpen;
    settings.ambient = b.dataset.value;
    settings.ambientOn = true;
    applySettings();
    saveSettings();
    renderMySounds();
  });
  $('#chipKeySlots').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-value]');
    if (!b) return;
    keySlotOpen = keySlotOpen === b.dataset.value ? null : b.dataset.value;
    renderMySounds();
  });

  // звук в браузере можно запустить только после действия пользователя
  const unlock = () => {
    const ctx = sounds.getContext();
    if (ctx && ctx.state === 'running') {
      document.removeEventListener('pointerdown', unlock, true);
      document.removeEventListener('keydown', unlock, true);
    }
  };
  document.addEventListener('pointerdown', unlock, true);
  document.addEventListener('keydown', unlock, true);
}

function toggleFocusMode(force) {
  const on = typeof force === 'boolean' ? force : !document.body.classList.contains('focus-mode');
  if (on && !project) return;
  document.body.classList.toggle('focus-mode', on);
  refreshBar();
  if (on) {
    closeSettings();
    if (currentId && isTextKind(currentKind)) editor.commands.focus();
  }
  setTimeout(() => { updateTwPad(); layoutGoal(); }, 0);
}

function wireChrome() {
  wireToolbar();

  $('#btnSidebar').addEventListener('click', toggleSidebar);
  $('#btnSettings').addEventListener('click', toggleSettings);
  $('#btnSound').addEventListener('click', () => togglePanel('sound'));
  wireChips();
  wireBinderTop();

  bindSetting('#setLinks', 'links', (el) => el.checked);
  bindSetting('#setSpell', 'spellOn', (el) => el.checked);
  bindSetting('#setTypo', 'typo', (el) => el.checked);
  bindSetting('#setTypoNbsp', 'typoNbsp', (el) => el.checked);
  bindSetting('#setTypoLayout', 'typoLayout', (el) => el.checked);
  bindSetting('#setTypeAnim', 'typeAnim', (el) => el.checked);
  bindSetting('#setSearchEngine', 'searchEngine', (el) => el.value);
  bindSetting('#setMarks', 'marks', (el) => el.checked);
  bindSetting('#setMarksSpaces', 'marksSpaces', (el) => el.checked);
  $('#btnFixTypo').addEventListener('click', fixChapterTypography);
  $('#btnCheck').addEventListener('click', () => togglePanel('check'));
  $('#btnTyping').addEventListener('click', () => togglePanel('typing'));
  wireSheetClick();
  document.querySelectorAll('.start-lang button').forEach((b) => {
    b.classList.toggle('on', b.dataset.lang === LANG);
    b.addEventListener('click', () => switchLang(b.dataset.lang));
  });
  bindSetting('#setTheme', 'theme', (el) => el.value);
  bindSetting('#setPaper', 'paper', (el) => el.value);
  bindSetting('#setFont', 'font', (el) => el.value);
  bindSetting('#setFontName', 'fontName', (el) => cleanFontName(el.value));
  bindSetting('#setPara', 'para', (el) => el.value);
  bindSetting('#setSoundOn', 'soundOn', (el) => el.checked);
  bindSetting('#setAmbientOn', 'ambientOn', (el) => el.checked);
  bindSetting('#setProjectGoalOn', 'projectGoalOn', (el) => el.checked);
  bindSetting('#setStoryCharacters', 'storyCharacters', (el) => el.checked);
  bindSetting('#anFillerSpeech', 'fillerSkipSpeech', (el) => el.checked);
  bindSetting('#setStoryPlaces', 'storyPlaces', (el) => el.checked);
  bindSetting('#setStoryItems', 'storyItems', (el) => el.checked);
  bindSetting('#setGoalChime', 'goalChime', (el) => el.checked);
  for (const key of Object.keys(LIMITS)) bindNumeric(key);

  // клавиши внутри полей настроек не должны попадать в текст или вызывать звуки
  document.querySelectorAll('.panel').forEach((p) => {
    p.addEventListener('keydown', (e) => { if (e.key !== 'Escape') e.stopPropagation(); });
  });

  $('#btnAddFont').addEventListener('click', addFontsFromFiles);
  $('#btnRemoveFont').addEventListener('click', removeCurrentFont);
  $('#btnTestSound').addEventListener('click', () => sounds.test());
  $('#btnSoundsFolder').addEventListener('click', () => {
    api.openSoundsFolder().catch((err) => showError(err.message));
  });

  // клик мимо панели настроек закрывает её
  document.addEventListener('mousedown', (e) => {
    if (!anyPanelOpen()) return;
    if (e.target.closest('.panel') || e.target.closest('#chromeRight')) return;
    if (!$('#checkPanel').hidden) return; // список замечаний остаётся, пока вы правите текст
    closePanels();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#board').hidden) {
      closeBoard();
    } else if (!$('#projPop').hidden) {
      closeProjPop();
    } else if (!$('#search').hidden) {
      closeSearch();
    } else if (!$('#goalPop').hidden) {
      closeGoalPop();
    } else if (anyPanelOpen()) {
      closePanels();
    } else if (document.body.classList.contains('focus-mode')) {
      toggleFocusMode(false);
    }
  });

  new ResizeObserver(updateTwPad).observe($('#paper-area'));
  const ro = new ResizeObserver(layoutGoal);
  ro.observe($('#canvas'));
  ro.observe($('#paper'));
}

