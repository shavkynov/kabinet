// ---------- анализ текста: подсветка частей речи ----------

const AN_NAMES = { verb: 'Глаголы', noun: 'Существительные', adj: 'Прилагательные', adv: 'Наречия', part: 'Причастия и деепричастия', pron: 'Местоимения' };
let lastAn = '';

const STYLE_KEYS = ['chancery', 'weak', 'tell', 'chain', 'remark', 'redund', 'which', 'own'];

function applyAnalysisSettings() {
  for (const k of AN_CATS) $(`#an_${k}`).checked = !!settings.an[k];
  const inp = $('#anLongMin');
  if (document.activeElement !== inp) inp.value = String(settings.anLongMin);
  const win = $('#anRepeatWin');
  if (document.activeElement !== win) win.value = String(settings.anRepeatWin);
  renderFillers();
  $('#btnStyle').hidden = LANG !== 'ru'; // правила стиля написаны для русского текста
  if (LANG !== 'ru') $('#stylePanel').hidden = true;
  $('#tenseMode').value = settings.tenseMode;
  document.querySelectorAll('#viewAnalysis [data-extra]').forEach((row) => { row.hidden = !settings.anShow[row.dataset.extra] && !settings.an[row.dataset.extra]; });
  document.querySelectorAll('#viewAnalysis input[data-anshow]').forEach((box) => { box.checked = !!settings.anShow[box.dataset.anshow]; });
  const hasCheckOn = AN_CATS.some((k) => !STYLE_KEYS.includes(k) && settings.an[k]);
  const hasStyleOn = STYLE_KEYS.some((k) => settings.an[k]);
  $('#btnCheck').classList.toggle('lit', hasCheckOn);
  $('#btnStyle').classList.toggle('lit', hasStyleOn);
  if ($('#btnStyleNone')) $('#btnStyleNone').disabled = !hasStyleOn;
  if ($('#btnStyleAll')) $('#btnStyleAll').disabled = STYLE_KEYS.every((k) => settings.an[k]);
  if ($('#btnAnNone')) $('#btnAnNone').disabled = !hasCheckOn;
  $('#anFillerSpeech').checked = settings.fillerSkipSpeech;
  const sig = JSON.stringify([settings.an, settings.tenseMode, settings.anLongMin, settings.anRepeatWin, settings.fillers, settings.fillerSkipSpeech]);
  if (sig !== lastAn) {
    lastAn = sig;
    if (editor) { refreshAnalysis(editor); if (window.__styleShadowReady) scheduleStyleShadow(); }
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
  const sumEl = $('#anSummary');
  if (sumEl) {
    sumEl.textContent = '';
    const items = active ? AN_NAV_CATS.filter((k) => settings.an[k] && (st[k] || 0) > 0) : [];
    sumEl.hidden = !items.length;
    if (items.length) {
      const lbl = document.createElement('span');
      lbl.className = 'an-eg';
      lbl.style.width = '100%';
      lbl.textContent = t('Сводка главы — нажмите, чтобы перейти:');
      sumEl.append(lbl);
      for (const k of items) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'an-chip';
        chip.dataset.sumCat = k;
        const dot = document.createElement('span');
        dot.className = 'an-chip-dot';
        dot.style.background = `var(--an-${k})`;
        const name = document.createElement('span');
        name.textContent = t(NAV_NAMES[k]);
        const count = document.createElement('b');
        count.textContent = String(st[k]);
        chip.append(dot, name, count);
        sumEl.append(chip);
      }
    }
  }
  if (!active) hideAnalysisPop();
  // «‹ ›» нужны только там, где есть что листать
  // кнопки «‹ ›» есть и в «Подсветке» (#viewAnalysis), и в панели «Стиль текста» (#stylePanel)
  document.querySelectorAll('[data-an-nav]').forEach((b) => {
    const k = b.dataset.anNav;
    b.disabled = !(active && settings.an[k] && (st[k] || 0) > 0);
  });
}

// ---------- переход к предыдущему и следующему месту и всплывающий совет (#anPop) ----------
const NAV_NAMES = { adv: 'Наречия', passive: 'Страдательный залог', long: 'Длинные предложения', repeat: 'Повторы слов', filler: 'Слова-паразиты', chancery: 'Канцелярит и штампы', weak: 'Слабые глаголы', tell: 'Назвал, а не показал', chain: 'Цепочки существительных', remark: 'Ремарки при репликах', redund: 'Лишние слова и тавтология', which: 'Лавина «который» и «что»', own: 'Лишнее «свой» и «его»' };

let anPopTimer = 0;
let anPopHideTimer = 0;
let anPopPinUntil = 0;
let anPopState = null;

function clearAnPopTimers() {
  clearTimeout(anPopTimer);
  clearTimeout(anPopHideTimer);
  anPopTimer = 0;
  anPopHideTimer = 0;
}

function hideAnalysisPop() {
  clearAnPopTimers();
  anPopState = null;
  const pop = $('#anPop');
  if (pop) pop.hidden = true;
}

function scheduleHideAnPop() {
  clearTimeout(anPopTimer);
  anPopTimer = 0;
  clearTimeout(anPopHideTimer);
  anPopHideTimer = setTimeout(() => {
    anPopHideTimer = 0;
    hideAnalysisPop();
  }, 180);
}

function analysisCatOf(el) {
  if (!el || !el.classList) return null;
  for (const cls of el.classList) {
    if (cls.startsWith('an-')) {
      const cat = cls.slice(3);
      if (AN_NAV_CATS.includes(cat)) return cat;
    }
  }
  return null;
}

function takeAnalysisTip(el) {
  if (!el) return '';
  if (!el.dataset.anTip) {
    const raw = el.getAttribute('title') || '';
    if (!raw) return '';
    el.dataset.anTip = raw;
    el.removeAttribute('title');
  }
  return el.dataset.anTip;
}

function suppressAncestorTitles(el) {
  for (let cur = el.parentElement; cur && !cur.classList.contains('ProseMirror'); cur = cur.parentElement) {
    if (cur.classList.contains('an')) takeAnalysisTip(cur);
  }
}

function showAnalysisPopAt({ cat, text, tip, rect, el = null, hover = false }) {
  const pop = $('#anPop');
  if (!pop || !tip) return;
  clearAnPopTimers();
  anPopState = { cat, text, el, hover };
  $('#anPopCat').textContent = t(NAV_NAMES[cat] || '');
  $('#anPopText').textContent = tip;
  const hasNav = editor ? (analysisRanges(editor.state)[cat] || []).length > 1 : false;
  $('#anPopPrev').disabled = !hasNav;
  $('#anPopNext').disabled = !hasNav;
  $('#anPopSkip').hidden = !(AN_NAV_CATS.includes(cat) && text);
  pop.hidden = false;
  const pad = 8;
  const pw = pop.offsetWidth || 320;
  const ph = pop.offsetHeight || 120;
  const left = Math.max(pad, Math.min(rect.left, window.innerWidth - pw - pad));
  let top = rect.bottom + 8;
  if (top + ph > window.innerHeight - pad) top = Math.max(pad, rect.top - ph - 8);
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;
}

function showAnalysisPopFromRange(cat, from, to) {
  if (!editor) return;
  let el = null;
  let tip = '';
  try {
    const probe = to > from ? Math.min(from + 1, editor.state.doc.content.size) : from;
    const { node } = editor.view.domAtPos(probe);
    const dom = node.nodeType === 1 ? node : node.parentElement;
    el = dom && dom.closest ? dom.closest(`.an.an-${cat}`) : null;
    if (el) suppressAncestorTitles(el);
    tip = takeAnalysisTip(el);
  } catch { /* текст успел измениться */ }
  const text = editor.state.doc.textBetween(from, to, '', '￼').trim();
  if (!tip) tip = text ? `${t(NAV_NAMES[cat] || '')}: «${text}»` : '';
  let rect = el ? el.getBoundingClientRect() : null;
  if (!rect || (!rect.width && !rect.height)) {
    try {
      const a = editor.view.coordsAtPos(from);
      const b = editor.view.coordsAtPos(to);
      rect = { left: Math.min(a.left, b.left), top: Math.min(a.top, b.top), bottom: Math.max(a.bottom, b.bottom) };
    } catch { return; }
  }
  showAnalysisPopAt({ cat, text, tip, rect, el });
}

function stepAnalysis(cat, dir) {
  if (!editor) return;
  const list = analysisRanges(editor.state)[cat] || [];
  const idx = stepIndex(list, editor.state.selection.from, dir);
  if (idx < 0) { setStatus('ok', t('Нет отмеченных мест')); return; }
  anPopPinUntil = Date.now() + 400;
  const item = list[idx];
  gotoRhythm(item.from, item.to); // тот же переход, что в «Ритме»
  setStatus('ok', t('{0}: {1} из {2}', t(NAV_NAMES[cat]), idx + 1, list.length));
  requestAnimationFrame(() => requestAnimationFrame(() => showAnalysisPopFromRange(cat, item.from, item.to)));
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

function wireAnalysisPop() {
  const pop = $('#anPop');
  const paper = $('#paper');
  const scroller = $('#paper-area');
  if (!pop || !paper) return;
  $('#anPopClose').addEventListener('click', hideAnalysisPop);
  $('#anPopPrev').addEventListener('click', () => { if (anPopState) stepAnalysis(anPopState.cat, -1); });
  $('#anPopNext').addEventListener('click', () => { if (anPopState) stepAnalysis(anPopState.cat, 1); });
  $('#anPopSkip').addEventListener('click', () => {
    if (!anPopState || !anPopState.text) return;
    addAnalysisSkip(anPopState.cat, anPopState.text);
    hideAnalysisPop();
  });
  pop.addEventListener('mouseenter', () => { clearTimeout(anPopHideTimer); });
  pop.addEventListener('mouseleave', () => { if (anPopState && anPopState.hover) scheduleHideAnPop(); });
  paper.addEventListener('mouseover', (e) => {
    const el = e.target && e.target.closest ? e.target.closest('.ProseMirror .an') : null;
    if (!el) return;
    const cat = analysisCatOf(el);
    if (!cat) return;
    suppressAncestorTitles(el);
    const tip = takeAnalysisTip(el);
    if (!tip) return;
    if (anPopState && anPopState.el === el && !pop.hidden) { clearTimeout(anPopHideTimer); return; }
    clearTimeout(anPopTimer);
    clearTimeout(anPopHideTimer);
    anPopTimer = setTimeout(() => {
      anPopTimer = 0;
      if (!el.isConnected) return;
      showAnalysisPopAt({ cat, text: el.textContent.trim(), tip, rect: el.getBoundingClientRect(), el, hover: true });
    }, 160);
  });
  paper.addEventListener('mouseout', (e) => {
    clearTimeout(anPopTimer);
    anPopTimer = 0;
    const rel = e.relatedTarget;
    if (rel && (pop.contains(rel) || (rel.closest && rel.closest('.ProseMirror .an')))) return;
    if (anPopState && anPopState.hover) scheduleHideAnPop();
  });
  paper.addEventListener('mouseleave', () => {
    clearTimeout(anPopTimer);
    anPopTimer = 0;
    if (anPopState && anPopState.hover) scheduleHideAnPop();
  });
  for (const ev of ['keydown', 'input', 'contextmenu']) paper.addEventListener(ev, hideAnalysisPop);
  if (scroller) scroller.addEventListener('scroll', () => { if (Date.now() > anPopPinUntil) hideAnalysisPop(); }, { passive: true });
  document.addEventListener('mousedown', (e) => {
    if (pop.hidden) return;
    if (e.target.closest('#anPop, [data-an-nav], [data-sum-cat]')) return;
    hideAnalysisPop();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !pop.hidden) {
      e.stopPropagation();
      hideAnalysisPop();
    }
  }, true);
}

function wireAnalysis() {
  const onNavClick = (e) => {
    const b = e.target.closest('button[data-an-nav]');
    if (!b || b.disabled) return;
    e.preventDefault();
    stepAnalysis(b.dataset.anNav, Number(b.dataset.dir));
  };
  $('#viewAnalysis').addEventListener('click', onNavClick);
  $('#stylePanel').addEventListener('click', onNavClick);
  if ($('#anSummary')) {
    $('#anSummary').addEventListener('click', (e) => {
      const chip = e.target.closest('button[data-sum-cat]');
      if (!chip) return;
      e.preventDefault();
      stepAnalysis(chip.dataset.sumCat, 1);
    });
  }
  const setStyleGroup = (on) => {
    const next = { ...settings.an };
    for (const k of STYLE_KEYS) {
      if (on) next[k] = true;
      else delete next[k];
    }
    settings.an = next;
    applySettings();
    saveSettings();
  };
  if ($('#btnStyleAll')) $('#btnStyleAll').addEventListener('click', () => setStyleGroup(true));
  if ($('#btnStyleNone')) $('#btnStyleNone').addEventListener('click', () => setStyleGroup(false));
  if ($('#btnAnNone')) {
    $('#btnAnNone').addEventListener('click', () => {
      const next = { ...settings.an };
      for (const k of AN_CATS) if (!STYLE_KEYS.includes(k)) delete next[k];
      settings.an = next;
      applySettings();
      saveSettings();
    });
  }
  wireAnalysisPop();
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
  // Категории стиля живут в отдельной панели #stylePanel, а не в #checkPanel.
  document.querySelectorAll('input[data-an]').forEach((box) => {
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
  $('#btnFillerReset').addEventListener('click', async () => {
    if (await askConfirm(t('Вернуть стандартный список? Ваши слова из списка пропадут.'), t('Сбросить'))) setFillers(DEFAULT_FILLERS[LANG] || DEFAULT_FILLERS.ru);
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
  wireDav();
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

  enterConfirms($('#renameProjectDialog'), $('#renameProjectInput'));
  $('#renameProjectDialog').addEventListener('close', () => {
    if ($('#renameProjectDialog').returnValue === 'ok') renameProjectTo($('#renameProjectInput').value.trim());
  });
  $('#projectName').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showMenu(e.clientX, e.clientY, [{ label: 'Переименовать проект…', onClick: askRenameProject }]);
  });
  if (api.onRenameProject) api.onRenameProject(() => askRenameProject());
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
  if (api.onOpenFeedback) api.onOpenFeedback(() => { closePanels(); openFeedback(); });
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
