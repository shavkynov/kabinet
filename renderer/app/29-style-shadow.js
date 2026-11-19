// Теневой режим нового стилевого парсера. Старый анализ (src/style.js) продолжает
// обслуживать подсветку; здесь только фоновый вызов Rust-парсера и диагностика.
// Включается только внутренней настройкой localStorage, без пользовательского UI.

let shadowTimer = 0;
let shadowSeq = 0;
let shadowEpoch = 0;
let shadowPrev = 0;

function styleShadowEnabled() {
  try { return localStorage.getItem('kabinet.styleEngineShadow') === '1'; } catch { return false; }
}

function setShadowState(task, epoch, state) {
  window.__styleShadow = { task, epoch, at: Date.now(), ...state };
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
  invalidateShadow();
  clearTimeout(shadowTimer);
  setShadowState(++shadowSeq, shadowEpoch, { status: 'pending', ok: false, cancelled: false, sentences: 0, tokens: 0, chain: [], chainCount: 0, which: [], whichCount: 0, chancery: [], chanceryCount: 0, weak: [], weakCount: 0, own: [], ownCount: 0, redund: [], redundCount: 0, ruleErrors: [], error: '' });
  shadowTimer = setTimeout(runStyleShadow, 900);
}

async function runStyleShadow() {
  if (!styleShadowEnabled() || LANG !== 'ru' || !editor) return;
  const epoch = shadowEpoch;
  const task = ++shadowSeq;
  if (!api.styleParse) {
    if (epoch === shadowEpoch) setShadowState(task, epoch, { status: 'error', ok: false, cancelled: false, sentences: 0, tokens: 0, chain: [], chainCount: 0, which: [], whichCount: 0, chancery: [], chanceryCount: 0, weak: [], weakCount: 0, own: [], ownCount: 0, redund: [], redundCount: 0, ruleErrors: [], error: 'Rust-команда style:parse недоступна.' });
    return;
  }
  const text = editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n\n', '\n');
  if (!text.trim()) {
    if (epoch === shadowEpoch) setShadowState(task, epoch, { status: 'empty', ok: false, cancelled: false, sentences: 0, tokens: 0, chain: [], chainCount: 0, which: [], whichCount: 0, chancery: [], chanceryCount: 0, weak: [], weakCount: 0, own: [], ownCount: 0, redund: [], redundCount: 0, ruleErrors: [], error: '' });
    return;
  }
  if (epoch !== shadowEpoch) return;
  // Старый результат не должен выглядеть как ответ на новый запрос.
  setShadowState(task, epoch, { status: 'running', ok: false, cancelled: false, sentences: 0, tokens: 0, chain: [], chainCount: 0, which: [], whichCount: 0, chancery: [], chanceryCount: 0, weak: [], weakCount: 0, own: [], ownCount: 0, redund: [], redundCount: 0, ruleErrors: [], error: '' });
  if (shadowPrev && api.styleCancel) {
    try { await api.styleCancel(shadowPrev); } catch { /* ошибка отмены не должна ломать новый запрос */ }
  }
  if (epoch !== shadowEpoch) return;
  shadowPrev = task;
  const t0 = performance.now();
  try {
    const res = await api.styleParse(text, task);
    if (task !== shadowSeq || epoch !== shadowEpoch) return; // ответ устаревшего запроса
    if (!res || typeof res !== 'object' || !res.parse || !Array.isArray(res.parse.sentences)) {
      throw new Error('Некорректный ответ style:parse.');
    }
    if (res.cancelled) {
      setShadowState(task, epoch, { status: 'cancelled', ok: false, cancelled: true, sentences: 0, tokens: 0, chain: [], chainCount: 0, which: [], whichCount: 0, chancery: [], chanceryCount: 0, weak: [], weakCount: 0, own: [], ownCount: 0, redund: [], redundCount: 0, ruleErrors: [], error: '', ms: Math.round(performance.now() - t0) });
      return;
    }
    const parse = res.parse;
    let chain = [];
    let which = [];
    let chancery = [];
    let weak = [];
    let own = [];
    let redund = [];
    const ruleErrors = [];
    try {
      chain = analyzeStructural(text, parse, { chain: true }).chain;
      if (!Array.isArray(chain)) throw new Error('chain rule вернул не массив.');
    } catch (err) {
      // Ошибка правила не должна ломать редактор и не отменяет diagnostics parser.
      chain = [];
      ruleErrors.push({ category: 'chain', error: err && err.message ? err.message : String(err) });
    }
    try {
      which = analyzeStructural(text, parse, { which: true }).which;
      if (!Array.isArray(which)) throw new Error('which rule вернул не массив.');
    } catch (err) {
      which = [];
      ruleErrors.push({ category: 'which', error: err && err.message ? err.message : String(err) });
    }
    try {
      chancery = analyzeStructural(text, parse, { chancery: true }).chancery;
      if (!Array.isArray(chancery)) throw new Error('chancery rule вернул не массив.');
    } catch (err) {
      chancery = [];
      ruleErrors.push({ category: 'chancery', error: err && err.message ? err.message : String(err) });
    }
    try {
      weak = analyzeStructural(text, parse, { weak: true }).weak;
      if (!Array.isArray(weak)) throw new Error('weak rule вернул не массив.');
    } catch (err) {
      weak = [];
      ruleErrors.push({ category: 'weak', error: err && err.message ? err.message : String(err) });
    }
    try {
      own = analyzeStructural(text, parse, { own: true }).own;
      if (!Array.isArray(own)) throw new Error('own rule вернул не массив.');
    } catch (err) {
      own = [];
      ruleErrors.push({ category: 'own', error: err && err.message ? err.message : String(err) });
    }
    try {
      redund = analyzeStructural(text, parse, { redund: true }).redund;
      if (!Array.isArray(redund)) throw new Error('redund rule вернул не массив.');
    } catch (err) {
      redund = [];
      ruleErrors.push({ category: 'redund', error: err && err.message ? err.message : String(err) });
    }
    setShadowState(task, epoch, {
      status: 'ok',
      ok: true,
      cancelled: false,
      sentences: parse.sentences.length,
      tokens: parse.sentences.reduce((n, s) => n + ((s.tokens && s.tokens.length) || 0), 0),
      chain,
      chainCount: chain.length,
      which,
      whichCount: which.length,
      chancery,
      chanceryCount: chancery.length,
      weak,
      weakCount: weak.length,
      own,
      ownCount: own.length,
      redund,
      redundCount: redund.length,
      ruleErrors,
      error: '',
      ms: Math.round(performance.now() - t0),
    });
  } catch (err) {
    if (task !== shadowSeq || epoch !== shadowEpoch) return;
    setShadowState(task, epoch, { status: 'error', ok: false, cancelled: false, sentences: 0, tokens: 0, chain: [], chainCount: 0, which: [], whichCount: 0, chancery: [], chanceryCount: 0, weak: [], weakCount: 0, own: [], ownCount: 0, redund: [], redundCount: 0, ruleErrors: [], error: err && err.message ? err.message : String(err), ms: Math.round(performance.now() - t0) });
  }
}

// Внутреннее управление для диагностики; намеренно не выведено в интерфейс.
window.kabinetStyleShadow = {
  enable() { try { localStorage.setItem('kabinet.styleEngineShadow', '1'); } catch { /* нет хранилища */ } scheduleStyleShadow(); },
  disable() {
    invalidateShadow();
    clearTimeout(shadowTimer);
    shadowSeq += 1;
    window.__styleShadow = null;
  },
  enabled: styleShadowEnabled,
  last: () => window.__styleShadow || null,
};
