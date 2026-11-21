// Теневой режим нового структурного анализатора. Старый анализ (src/style.js)
// остаётся единственным источником пользовательской подсветки; здесь только
// snapshot → Rust/UDPipe → structural findings → проверка диапазонов.

let shadowTimer = 0;
let shadowSeq = 0;
let shadowEpoch = 0;
let shadowPrev = 0;
let shadowForcedOff = false;
let styleModelReady = false;

const SHADOW_CATEGORIES = ['chain', 'which', 'chancery', 'weak', 'own', 'redund', 'remark', 'tell'];
const SHADOW_DEBOUNCE_MS = 900;
const SHADOW_DEFAULT_TIMEOUT_MS = 10000;

function styleShadowEnabled() {
  if (shadowForcedOff) return false;
  try {
    if (localStorage.getItem('kabinet.styleEngineShadow') === '1') return true;
    if (styleModelReady && localStorage.getItem('kabinet.styleEngineMode') !== 'basic') return true;
    return false;
  } catch { return styleModelReady; }
}

function shadowCategories() {
  const an = (typeof settings !== 'undefined' && settings && settings.an) || {};
  return SHADOW_CATEGORIES.filter((cat) => !!an[cat]);
}

function emptyShadowState() {
  const state = {
    sentences: 0,
    tokens: 0,
    categories: [],
    ruleErrors: [],
    diagnostics: [],
    findingsCount: 0,
    acceptedRanges: 0,
    rejectedFindings: 0,
    droppedNested: 0,
    mergedOverlaps: 0,
    analysisMs: 0,
    adapterMs: 0,
    error: '',
    reason: '',
  };
  for (const cat of SHADOW_CATEGORIES) {
    state[cat] = [];
    state[`${cat}Count`] = 0;
  }
  return state;
}

function setShadowState(task, epoch, state) {
  window.__styleShadow = { task, epoch, at: Date.now(), ...emptyShadowState(), ...state };
}

function fallbackStyleAnalysis() {
  if (!editor) return;
  try { applyEngineAnalysis(editor, { active: false, ranges: [] }); } catch { /* старый анализ должен остаться рабочим */ }
}

function applyStyleAnalysis(ranges) {
  if (!editor) return false;
  try {
    applyEngineAnalysis(editor, { active: true, ranges: Array.isArray(ranges) ? ranges : [] });
    return true;
  } catch {
    fallbackStyleAnalysis();
    return false;
  }
}

// Любое изменение документа/отключение режима делает текущий запрос устаревшим
// сразу, не дожидаясь debounce и следующего runStyleShadow.
function invalidateShadow() {
  shadowEpoch += 1;
  const old = shadowPrev;
  shadowPrev = 0;
  if (old && api && api.styleCancel) {
    try {
      const p = api.styleCancel(old);
      if (p && typeof p.catch === 'function') p.catch(() => { /* ошибка отмены не должна ломать новый запрос */ });
    } catch { /* ошибка отмены не должна ломать новый запрос */ }
  }
}

function scheduleStyleShadow() {
  if (!styleShadowEnabled() || LANG !== 'ru' || !editor) return;
  const categories = shadowCategories();
  if (!categories.length) {
    invalidateShadow();
    clearTimeout(shadowTimer);
    shadowSeq += 1;
    fallbackStyleAnalysis();
    setShadowState(shadowSeq, shadowEpoch, { status: 'unavailable', ok: false, reason: 'no-categories', error: '' });
    return;
  }
  invalidateShadow();
  clearTimeout(shadowTimer);
  setShadowState(++shadowSeq, shadowEpoch, { status: 'pending', ok: false, cancelled: false, categories });
  shadowTimer = setTimeout(runStyleShadow, SHADOW_DEBOUNCE_MS);
}

function timeoutError() {
  return Object.assign(new Error('Таймаут style:parse.'), { shadowTimeout: true });
}

async function runStyleShadow() {
  if (!styleShadowEnabled() || LANG !== 'ru' || !editor) return;
  const categories = shadowCategories();
  const epoch = shadowEpoch;
  const task = ++shadowSeq;
  if (!categories.length) {
    if (epoch === shadowEpoch) setShadowState(task, epoch, { status: 'unavailable', ok: false, reason: 'no-categories', error: '' });
    return;
  }
  if (!api.styleParse) {
    if (epoch === shadowEpoch) { fallbackStyleAnalysis(); setShadowState(task, epoch, { status: 'unavailable', ok: false, categories, reason: 'ipc-unavailable', error: 'Rust-команда style:parse недоступна.' }); }
    return;
  }

  let snapshot;
  try {
    snapshot = createDocumentSnapshot(editor.state.doc);
  } catch (err) {
    if (epoch === shadowEpoch) setShadowState(task, epoch, { status: 'error', ok: false, categories, error: err && err.message ? err.message : String(err) });
    return;
  }
  if (!snapshot.text.trim()) {
    if (epoch === shadowEpoch) setShadowState(task, epoch, { status: 'empty', ok: false, categories });
    return;
  }
  if (epoch !== shadowEpoch) return;

  setShadowState(task, epoch, { status: 'running', ok: false, categories });
  if (shadowPrev && api.styleCancel) {
    try { await api.styleCancel(shadowPrev); } catch { /* ошибка отмены не должна ломать новый запрос */ }
  }
  if (epoch !== shadowEpoch) return;
  shadowPrev = task;
  const t0 = performance.now();
  let timer = 0;
  let timedOut = false;

  try {
    const timeoutMs = Number(window.__styleTimeoutMs) > 0 ? Number(window.__styleTimeoutMs) : SHADOW_DEFAULT_TIMEOUT_MS;
    const parsePromise = api.styleParse(snapshot.text, task);
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(timeoutError());
      }, timeoutMs);
    });
    const res = await Promise.race([parsePromise, timeoutPromise]);
    clearTimeout(timer);
    timer = 0;
    if (task !== shadowSeq || epoch !== shadowEpoch) return;
    if (!res || typeof res !== 'object' || !res.parse || !Array.isArray(res.parse.sentences)) {
      throw new Error('Некорректный ответ style:parse.');
    }
    if (res.cancelled) {
      fallbackStyleAnalysis();
      setShadowState(task, epoch, { status: 'cancelled', ok: false, cancelled: true, categories, ms: Math.round(performance.now() - t0) });
      return;
    }

    const parse = res.parse;
    const enabled = Object.fromEntries(categories.map((cat) => [cat, true]));
    const analysis = analyzeStructural(snapshot.text, parse, enabled);
    if (task !== shadowSeq || epoch !== shadowEpoch) return;

    const findings = categories.flatMap((cat) => (Array.isArray(analysis[cat]) ? analysis[cat] : []));
    const adapterStart = performance.now();
    let rangeResult;
    const adapterErrors = [];
    try {
      rangeResult = findingsToRanges(snapshot, findings, editor.state.doc);
    } catch (err) {
      rangeResult = { ranges: [], diagnostics: [{ code: 'adapter-error', message: err && err.message ? err.message : String(err) }], droppedNested: 0, mergedOverlaps: 0 };
      adapterErrors.push({ category: 'adapter', error: err && err.message ? err.message : String(err) });
    }
    const adapterMs = Math.round(performance.now() - adapterStart);
    if (task !== shadowSeq || epoch !== shadowEpoch) return;

    if (rangeResult.diagnostics.some((d) => d.code === 'document-changed')) {
      shadowPrev = 0;
      fallbackStyleAnalysis();
      setShadowState(task, epoch, {
        status: 'stale', ok: false, categories, reason: 'document-changed',
        diagnostics: rangeResult.diagnostics, analysisMs: Math.round(performance.now() - t0),
      });
      scheduleStyleShadow();
      return;
    }

    const ruleErrors = [...(analysis.ruleErrors || []), ...adapterErrors];
    if (adapterErrors.length) {
      fallbackStyleAnalysis();
    } else if (!applyStyleAnalysis(rangeResult.ranges)) {
      ruleErrors.push({ category: 'adapter', error: 'не удалось применить ranges' });
    }
    const accepted = rangeResult.ranges.length;
    const rejected = rangeResult.diagnostics.filter((d) => d.code !== 'document-changed').length;
    const state = {
      status: 'ok',
      ok: true,
      cancelled: false,
      categories,
      sentences: parse.sentences.length,
      tokens: parse.sentences.reduce((n, s) => n + ((s.tokens && s.tokens.length) || 0), 0),
      ruleErrors,
      diagnostics: rangeResult.diagnostics,
      findingsCount: findings.length,
      acceptedRanges: accepted,
      rejectedFindings: rejected,
      droppedNested: rangeResult.droppedNested,
      mergedOverlaps: rangeResult.mergedOverlaps,
      analysisMs: Math.round(performance.now() - t0),
      adapterMs,
      error: '',
      reason: '',
    };
    for (const cat of SHADOW_CATEGORIES) {
      state[cat] = Array.isArray(analysis[cat]) ? analysis[cat] : [];
      state[`${cat}Count`] = state[cat].length;
    }
    setShadowState(task, epoch, state);
  } catch (err) {
    if (task !== shadowSeq || epoch !== shadowEpoch) return;
    shadowPrev = 0;
    if (timedOut || (err && err.shadowTimeout)) {
      if (api.styleCancel) {
        try { const p = api.styleCancel(task); if (p && typeof p.catch === 'function') p.catch(() => {}); } catch { /* игнорируем */ }
      }
      fallbackStyleAnalysis();
      setShadowState(task, epoch, { status: 'timeout', ok: false, categories, error: 'Таймаут style:parse.', analysisMs: Math.round(performance.now() - t0) });
    } else {
      fallbackStyleAnalysis();
      setShadowState(task, epoch, { status: 'error', ok: false, categories, error: err && err.message ? err.message : String(err), analysisMs: Math.round(performance.now() - t0) });
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function renderStyleEngineUi(st) {
  const box = typeof document !== 'undefined' ? document.querySelector('#styleEngineBox') : null;
  if (!box) return;
  if (!st || !st.supported) { box.hidden = true; return; }
  box.hidden = false;
  styleModelReady = !!st.ready;
  const toggle = document.querySelector('#styleEngineToggle');
  const status = document.querySelector('#styleEngineStatus');
  const btn = document.querySelector('#btnStylePickModel');
  if (toggle) {
    toggle.disabled = !styleModelReady;
    toggle.checked = styleModelReady && styleShadowEnabled();
  }
  if (status) {
    status.textContent = styleModelReady
      ? t('Подключена локальная модель ({0}).', st.modelVersion || 'russian-gsd')
      : t('Модель не подключена — работает базовый разбор.');
  }
  if (btn) {
    btn.textContent = styleModelReady ? t('Заменить файл модели…') : t('Подключить файл модели…');
  }
}

async function refreshStyleEngineUi() {
  if (typeof api === 'undefined' || !api || typeof api.styleStatus !== 'function') return;
  const wasReady = styleModelReady;
  try {
    const st = await api.styleStatus();
    renderStyleEngineUi(st);
    if (!wasReady && styleModelReady && styleShadowEnabled()) scheduleStyleShadow();
  } catch { /* платформа без статуса модели */ }
}

function wireStyleEngineUi() {
  const toggle = typeof document !== 'undefined' ? document.querySelector('#styleEngineToggle') : null;
  const btn = typeof document !== 'undefined' ? document.querySelector('#btnStylePickModel') : null;
  if (toggle) {
    toggle.addEventListener('change', () => {
      shadowForcedOff = false;
      try {
        if (toggle.checked) localStorage.removeItem('kabinet.styleEngineMode');
        else localStorage.setItem('kabinet.styleEngineMode', 'basic');
      } catch { /* нет хранилища */ }
      if (toggle.checked) {
        scheduleStyleShadow();
      } else {
        invalidateShadow();
        clearTimeout(shadowTimer);
        shadowSeq += 1;
        fallbackStyleAnalysis();
        window.__styleShadow = null;
      }
    });
  }
  if (btn && typeof api !== 'undefined' && api && typeof api.stylePickModel === 'function') {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const st = await api.stylePickModel();
        if (!st) return;
        shadowForcedOff = false;
        try { localStorage.removeItem('kabinet.styleEngineMode'); } catch { /* нет хранилища */ }
        renderStyleEngineUi(st);
        if (styleShadowEnabled()) scheduleStyleShadow();
        if (typeof setStatus === 'function') setStatus('ok', t('Языковая модель подключена'));
      } catch (err) {
        if (typeof showError === 'function') showError(err && err.message ? err.message : String(err));
      } finally {
        btn.disabled = false;
      }
    });
  }
  refreshStyleEngineUi();
}

// Внутреннее управление для диагностики и E2E.
window.kabinetStyleShadow = {
  enable() {
    shadowForcedOff = false;
    try { localStorage.setItem('kabinet.styleEngineShadow', '1'); localStorage.removeItem('kabinet.styleEngineMode'); } catch { /* нет хранилища */ }
    scheduleStyleShadow();
  },
  disable() {
    shadowForcedOff = true;
    try { localStorage.removeItem('kabinet.styleEngineShadow'); } catch { /* нет хранилища */ }
    invalidateShadow();
    clearTimeout(shadowTimer);
    shadowSeq += 1;
    fallbackStyleAnalysis();
    window.__styleShadow = null;
  },
  enabled: styleShadowEnabled,
  last: () => window.__styleShadow || null,
  // Только для E2E-диагностики: текст снимка и фактические ranges подсветки в текущем документе.
  inspect() {
    if (!editor) return null;
    const doc = editor.state.doc;
    const ranges = {};
    const all = analysisRanges(editor.state);
    for (const cat of SHADOW_CATEGORIES) {
      ranges[cat] = (all[cat] || []).map(({ from, to }) => ({ from, to, text: doc.textBetween(from, to, '', '') }));
    }
    return { text: createDocumentSnapshot(doc).text, size: doc.content.size, ranges };
  },
};

// Контур готов только после инициализации всех констант этого модуля;
// applyAnalysisSettings() вызывается раньше во время загрузки окна.
window.__styleShadowReady = true;
wireStyleEngineUi();
if (styleShadowEnabled()) scheduleStyleShadow();
