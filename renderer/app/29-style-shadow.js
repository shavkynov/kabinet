// Гибридный структурный и грамматический анализ текста: при готовой встроенной
// модели передаёт снимок в Rust/UDPipe и строит разборы для панелей «Стиль»
// и «Проверка», иначе используется базовый разбор (src/style.js / src/analysis.js).

let shadowTimer = 0;
let shadowSeq = 0;
let shadowEpoch = 0;
let shadowPrev = 0;
let shadowForcedOff = false;
let styleModelReady = false;
let lastStyleParse = null;

const SHADOW_CATEGORIES = ['chain', 'which', 'chancery', 'weak', 'own', 'redund', 'remark', 'tell'];
const LINGUISTIC_CATEGORIES = ['verb', 'noun', 'adj', 'adv', 'part', 'pron', 'passive', 'repeat', 'tense'];
const SHADOW_DEBOUNCE_MS = 900;
const SHADOW_HUGE_DEBOUNCE_MS = 1400;
const SHADOW_CHUNK_CHARS = 8000;
const PARA_CACHE_MAX = 6000;
const SHADOW_DEFAULT_TIMEOUT_MS = 10000;
const paraParseCache = new Map(); // текст абзаца -> [{ start, end, text, tokens }] с относительными смещениями

function getCachedPara(text) {
  if (!paraParseCache.has(text)) return null;
  const val = paraParseCache.get(text);
  paraParseCache.delete(text);
  paraParseCache.set(text, val);
  return val;
}

function setCachedPara(text, sentences) {
  if (paraParseCache.has(text)) paraParseCache.delete(text);
  paraParseCache.set(text, sentences);
  if (paraParseCache.size > PARA_CACHE_MAX) {
    paraParseCache.delete(paraParseCache.keys().next().value);
  }
}

function isShadowOnlyMode() {
  try { return localStorage.getItem('kabinet.styleEngineShadow') === '1'; } catch { return false; }
}

function sameEngineDoc(a, b) {
  if (!a || !b) return false;
  return typeof a.eq === 'function' ? a.eq(b) : a === b;
}

function styleShadowEnabled() {
  if (shadowForcedOff) return false;
  try {
    if (localStorage.getItem('kabinet.styleEngineMode') === 'basic') return false;
    if (localStorage.getItem('kabinet.styleEngineShadow') === '1') return true;
    return styleModelReady;
  } catch { return styleModelReady; }
}

function shadowCategories() {
  const an = (typeof settings !== 'undefined' && settings && settings.an) || {};
  return SHADOW_CATEGORIES.filter((cat) => !!an[cat]);
}

function tenseViewOpen() {
  if (typeof document === 'undefined') return false;
  const cp = document.querySelector('#checkPanel');
  const vt = document.querySelector('#viewTense');
  return !!cp && !cp.hidden && !!vt && !vt.hidden;
}

function linguisticCategories() {
  const an = (typeof settings !== 'undefined' && settings && settings.an) || {};
  const cats = LINGUISTIC_CATEGORIES.filter((cat) => !!an[cat]);
  if (!cats.includes('tense') && tenseViewOpen()) cats.push('tense');
  return cats;
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
  try { applyEngineAnalysis(editor, { active: false, ranges: [], blocks: null }); } catch { /* старый анализ должен остаться рабочим */ }
  if (typeof renderTense === 'function') renderTense();
}

function applyStyleAnalysis(ranges, blocks = null) {
  if (!editor) return false;
  try {
    const hybrid = styleModelReady && !isShadowOnlyMode();
    applyEngineAnalysis(editor, { active: true, ranges: Array.isArray(ranges) ? ranges : [], hybrid, blocks: blocks || null });
    if (typeof renderTense === 'function') renderTense();
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
  const styleCats = shadowCategories();
  const lingCats = !isShadowOnlyMode() && styleModelReady ? linguisticCategories() : [];
  const categories = [...styleCats, ...lingCats];
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
  const delay = editor.state && editor.state.doc && editor.state.doc.content.size > 80000
    ? SHADOW_HUGE_DEBOUNCE_MS
    : SHADOW_DEBOUNCE_MS;
  shadowTimer = setTimeout(runStyleShadow, delay);
}

function timeoutError() {
  return Object.assign(new Error('Таймаут style:parse.'), { shadowTimeout: true });
}

function chunkMissingSegments(snapshot, selPos) {
  const seen = new Set();
  const missing = [];
  for (const seg of snapshot.segments || []) {
    if (seg.analyzable === false || !seg.text || !seg.text.trim()) continue;
    if (seen.has(seg.text) || getCachedPara(seg.text) !== null) continue;
    seen.add(seg.text);
    missing.push({ text: seg.text, pmStart: seg.pmStart || 0, pmEnd: (seg.pmStart || 0) + seg.text.length });
  }
  if (!missing.length) return [];

  const chunks = [];
  let cur = null;
  for (const item of missing) {
    const addLen = cur ? 2 + item.text.length : item.text.length;
    if (cur && cur.chunkText.length + addLen > SHADOW_CHUNK_CHARS) {
      chunks.push(cur);
      cur = null;
    }
    if (!cur) cur = { items: [], chunkText: '', minPm: item.pmStart, maxPm: item.pmEnd };
    if (cur.items.length) cur.chunkText += '\n\n';
    const localStart = cur.chunkText.length;
    cur.chunkText += item.text;
    cur.items.push({ text: item.text, localStart, localEnd: localStart + item.text.length });
    if (item.pmStart < cur.minPm) cur.minPm = item.pmStart;
    if (item.pmEnd > cur.maxPm) cur.maxPm = item.pmEnd;
  }
  if (cur && cur.items.length) chunks.push(cur);

  if (chunks.length > 1) {
    const dist = (c) => (selPos < c.minPm ? c.minPm - selPos : selPos > c.maxPm ? selPos - c.maxPm : 0);
    chunks.sort((a, b) => dist(a) - dist(b));
  }
  return chunks;
}

function shiftToken(tok, delta) {
  return {
    id: tok.id,
    text: tok.text,
    lemma: tok.lemma,
    upos: tok.upos,
    feats: tok.feats,
    head: tok.head,
    deprel: tok.deprel,
    start: tok.start + delta,
    end: tok.end + delta,
  };
}

function storeChunkSentences(chunk, chunkParse) {
  const buckets = chunk.items.map(() => []);
  let idx = 0;
  for (const sent of chunkParse.sentences || []) {
    if (!sent || typeof sent.start !== 'number' || typeof sent.end !== 'number') continue;
    while (idx < chunk.items.length && sent.start >= chunk.items[idx].localEnd) idx += 1;
    if (idx >= chunk.items.length) break;
    for (let j = idx; j < chunk.items.length; j += 1) {
      const it = chunk.items[j];
      if (it.localStart >= sent.end) break;
      const start = Math.max(0, sent.start - it.localStart);
      const end = Math.min(it.text.length, sent.end - it.localStart);
      if (end <= start) continue;
      const tokens = [];
      for (const tok of sent.tokens || []) {
        if (tok.start >= it.localStart && tok.end <= it.localEnd) {
          tokens.push(shiftToken(tok, -it.localStart));
        }
      }
      if (!tokens.length && j > idx) continue;
      buckets[j].push({ start, end, text: it.text.slice(start, end), tokens });
    }
  }
  for (let i = 0; i < chunk.items.length; i += 1) {
    setCachedPara(chunk.items[i].text, buckets[i]);
  }
}

function assembleParse(snapshot, parserMeta) {
  const sentences = [];
  for (const seg of snapshot.segments || []) {
    if (seg.analyzable === false || !seg.text || !seg.text.trim()) continue;
    const cachedSents = getCachedPara(seg.text);
    if (!cachedSents) continue;
    const base = seg.parserStart;
    for (const s of cachedSents) {
      sentences.push({
        start: base + s.start,
        end: base + s.end,
        text: s.text,
        tokens: (s.tokens || []).map((tok) => shiftToken(tok, base)),
      });
    }
  }
  return {
    schemaVersion: 1,
    parser: parserMeta || { name: 'udpipe-rs', version: '0.2' },
    sentences,
  };
}

async function parseChunkWithTimeout(text, task, onTimeout) {
  const timeoutMs = Number(window.__styleTimeoutMs) > 0 ? Number(window.__styleTimeoutMs) : SHADOW_DEFAULT_TIMEOUT_MS;
  let timer = 0;
  try {
    const parsePromise = api.styleParse(text, task);
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        if (onTimeout) onTimeout();
        reject(timeoutError());
      }, timeoutMs);
    });
    return await Promise.race([parsePromise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function applyParsedSnapshot({ snapshot, parse, task, epoch, t0, styleCats, lingCats, shadowFlag, categories, partial = false }) {
  const enabled = Object.fromEntries(styleCats.map((cat) => [cat, true]));
  const analysis = styleCats.length ? analyzeStructural(snapshot.text, parse, enabled) : { ruleErrors: [] };
  if (task !== shadowSeq || epoch !== shadowEpoch) return 'aborted';

  const findings = styleCats.flatMap((cat) => (Array.isArray(analysis[cat]) ? analysis[cat] : []));
  const adapterStart = performance.now();
  let rangeResult;
  const adapterErrors = [];
  try {
    rangeResult = findings.length
      ? findingsToRanges(snapshot, findings, editor.state.doc)
      : { ranges: [], diagnostics: [], droppedNested: 0, mergedOverlaps: 0 };
  } catch (err) {
    rangeResult = { ranges: [], diagnostics: [{ code: 'adapter-error', message: err && err.message ? err.message : String(err) }], droppedNested: 0, mergedOverlaps: 0 };
    adapterErrors.push({ category: 'adapter', error: err && err.message ? err.message : String(err) });
  }
  const blocks = !shadowFlag && styleModelReady && lingCats.length > 0 && typeof buildLinguisticBlocks === 'function'
    ? buildLinguisticBlocks(snapshot, parse, editor.state.doc)
    : null;
  const adapterMs = Math.round(performance.now() - adapterStart);
  if (task !== shadowSeq || epoch !== shadowEpoch) return 'aborted';

  const docChanged = rangeResult.diagnostics.some((d) => d.code === 'document-changed')
    || (!shadowFlag && styleModelReady && lingCats.length > 0 && blocks === null);
  if (docChanged) {
    shadowPrev = 0;
    fallbackStyleAnalysis();
    setShadowState(task, epoch, {
      status: 'stale', ok: false, categories, reason: 'document-changed',
      diagnostics: rangeResult.diagnostics, analysisMs: Math.round(performance.now() - t0),
    });
    scheduleStyleShadow();
    return 'stale';
  }

  const ruleErrors = [...(analysis.ruleErrors || []), ...adapterErrors];
  if (adapterErrors.length) {
    fallbackStyleAnalysis();
  } else if (!applyStyleAnalysis(rangeResult.ranges, blocks)) {
    ruleErrors.push({ category: 'adapter', error: 'не удалось применить ranges' });
  }
  if (partial) return 'ok';

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
  return 'ok';
}

async function runStyleShadow() {
  if (!styleShadowEnabled() || LANG !== 'ru' || !editor) return;
  const styleCats = shadowCategories();
  const shadowFlag = isShadowOnlyMode();
  const lingCats = !shadowFlag && styleModelReady ? linguisticCategories() : [];
  const categories = [...styleCats, ...lingCats];
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

  const docNow = editor.state.doc;
  const cached = !shadowFlag && lastStyleParse && sameEngineDoc(lastStyleParse.doc, docNow);
  let snapshot;
  let parse = null;
  let chunks = [];
  if (cached) {
    snapshot = lastStyleParse.snapshot;
    parse = lastStyleParse.parse;
  } else {
    try {
      snapshot = createDocumentSnapshot(docNow);
    } catch (err) {
      if (epoch === shadowEpoch) setShadowState(task, epoch, { status: 'error', ok: false, categories, error: err && err.message ? err.message : String(err) });
      return;
    }
    if (!snapshot.text.trim()) {
      if (epoch === shadowEpoch) setShadowState(task, epoch, { status: 'empty', ok: false, categories });
      return;
    }
    if (epoch !== shadowEpoch) return;

    const selPos = editor.state.selection ? editor.state.selection.from : 0;
    chunks = chunkMissingSegments(snapshot, selPos);
    if (!chunks.length) {
      parse = assembleParse(snapshot, lastStyleParse && lastStyleParse.parse && lastStyleParse.parse.parser);
      lastStyleParse = { doc: docNow, snapshot, parse };
    } else {
      setShadowState(task, epoch, { status: 'running', ok: false, categories });
      if (shadowPrev && api.styleCancel) {
        try { await api.styleCancel(shadowPrev); } catch { /* ошибка отмены не должна ломать новый запрос */ }
      }
      if (epoch !== shadowEpoch) return;
      shadowPrev = task;
    }
  }
  const t0 = performance.now();
  let timedOut = false;

  try {
    if (!parse) {
      let parserMeta = null;
      for (let ci = 0; ci < chunks.length; ci += 1) {
        if (task !== shadowSeq || epoch !== shadowEpoch) return;
        const res = await parseChunkWithTimeout(chunks[ci].chunkText, task, () => { timedOut = true; });
        if (task !== shadowSeq || epoch !== shadowEpoch) return;
        if (!res || typeof res !== 'object' || !res.parse || !Array.isArray(res.parse.sentences)) {
          throw new Error('Некорректный ответ style:parse.');
        }
        if (res.cancelled) {
          fallbackStyleAnalysis();
          setShadowState(task, epoch, { status: 'cancelled', ok: false, cancelled: true, categories, ms: Math.round(performance.now() - t0) });
          return;
        }
        if (res.parse.parser) parserMeta = res.parse.parser;
        storeChunkSentences(chunks[ci], res.parse);
        if (chunks.length > 1 && ci === 0) {
          const partialParse = assembleParse(snapshot, parserMeta);
          const stepStatus = applyParsedSnapshot({ snapshot, parse: partialParse, task, epoch, t0, styleCats, lingCats, shadowFlag, categories, partial: true });
          if (stepStatus !== 'ok') return;
        }
      }
      parse = assembleParse(snapshot, parserMeta);
      lastStyleParse = { doc: docNow, snapshot, parse };
    }
    applyParsedSnapshot({ snapshot, parse, task, epoch, t0, styleCats, lingCats, shadowFlag, categories });
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
  }
}

function updateCheckModeHint() {
  const el = typeof document !== 'undefined' ? document.querySelector('#anModeHint') : null;
  if (!el) return;
  const precise = styleModelReady && styleShadowEnabled() && !isShadowOnlyMode();
  el.textContent = precise
    ? t('Выбранные виды слов выделяются цветом, текст не меняется. Работает точный грамматический разбор.')
    : t('Выбранные виды слов выделяются цветом, текст не меняется. Разбор приблизительный: по окончаниям, без словаря.');
}

function renderStyleEngineUi(st) {
  const box = typeof document !== 'undefined' ? document.querySelector('#styleEngineBox') : null;
  if (!box) return;
  styleModelReady = !!(st && st.supported && st.ready);
  box.hidden = !styleModelReady;
  const toggle = document.querySelector('#styleEngineToggle');
  if (toggle) {
    toggle.disabled = !styleModelReady;
    toggle.checked = styleModelReady && styleShadowEnabled();
  }
  updateCheckModeHint();
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
  if (toggle) {
    toggle.addEventListener('change', () => {
      shadowForcedOff = false;
      try {
        if (toggle.checked) {
          localStorage.removeItem('kabinet.styleEngineMode');
        } else {
          localStorage.setItem('kabinet.styleEngineMode', 'basic');
          localStorage.removeItem('kabinet.styleEngineShadow');
        }
      } catch { /* нет хранилища */ }
      updateCheckModeHint();
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
  refreshStyleEngineUi();
}

// Внутреннее управление для диагностики и E2E.
window.kabinetStyleShadow = {
  enable() {
    shadowForcedOff = false;
    try { localStorage.setItem('kabinet.styleEngineShadow', '1'); localStorage.removeItem('kabinet.styleEngineMode'); } catch { /* нет хранилища */ }
    updateCheckModeHint();
    scheduleStyleShadow();
  },
  disable() {
    shadowForcedOff = true;
    try { localStorage.removeItem('kabinet.styleEngineShadow'); } catch { /* нет хранилища */ }
    updateCheckModeHint();
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
