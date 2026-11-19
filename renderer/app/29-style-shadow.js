// Теневой режим нового стилевого парсера. Старый анализ (src/style.js) продолжает
// обслуживать подсветку; здесь только фоновый вызов Rust-парсера и диагностика.
// Включается только внутренней настройкой localStorage, без пользовательского UI.

let shadowTimer = 0;
let shadowSeq = 0;
let shadowPrev = 0;

function styleShadowEnabled() {
  try { return localStorage.getItem('kabinet.styleEngineShadow') === '1'; } catch { return false; }
}

function setShadowState(task, state) {
  window.__styleShadow = { task, at: Date.now(), ...state };
}

function scheduleStyleShadow() {
  if (!styleShadowEnabled() || LANG !== 'ru' || !editor) return;
  clearTimeout(shadowTimer);
  shadowTimer = setTimeout(runStyleShadow, 900);
}

async function runStyleShadow() {
  if (!styleShadowEnabled() || LANG !== 'ru' || !editor) return;
  const task = ++shadowSeq;
  if (!api.styleParse) {
    setShadowState(task, { status: 'error', ok: false, cancelled: false, sentences: 0, tokens: 0, error: 'Rust-команда style:parse недоступна.' });
    return;
  }
  const text = editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n\n', '\n');
  if (!text.trim()) return;
  // Старый результат не должен выглядеть как ответ на новый запрос.
  setShadowState(task, { status: 'running', ok: false, cancelled: false, sentences: 0, tokens: 0, error: '' });
  if (shadowPrev && api.styleCancel) {
    try { await api.styleCancel(shadowPrev); } catch { /* ошибка отмены не должна ломать новый запрос */ }
  }
  shadowPrev = task;
  const t0 = performance.now();
  try {
    const res = await api.styleParse(text, task);
    if (task !== shadowSeq) return; // ответ устаревшего запроса
    if (!res || typeof res !== 'object' || !res.parse || !Array.isArray(res.parse.sentences)) {
      throw new Error('Некорректный ответ style:parse.');
    }
    if (res.cancelled) {
      setShadowState(task, { status: 'cancelled', ok: false, cancelled: true, sentences: 0, tokens: 0, error: '', ms: Math.round(performance.now() - t0) });
      return;
    }
    const parse = res.parse;
    setShadowState(task, {
      status: 'ok',
      ok: true,
      cancelled: false,
      sentences: parse.sentences.length,
      tokens: parse.sentences.reduce((n, s) => n + ((s.tokens && s.tokens.length) || 0), 0),
      error: '',
      ms: Math.round(performance.now() - t0),
    });
  } catch (err) {
    if (task !== shadowSeq) return;
    setShadowState(task, { status: 'error', ok: false, cancelled: false, sentences: 0, tokens: 0, error: err && err.message ? err.message : String(err), ms: Math.round(performance.now() - t0) });
  }
}

// Внутреннее управление для диагностики; намеренно не выведено в интерфейс.
window.kabinetStyleShadow = {
  enable() { try { localStorage.setItem('kabinet.styleEngineShadow', '1'); } catch { /* нет хранилища */ } scheduleStyleShadow(); },
  disable() { try { localStorage.removeItem('kabinet.styleEngineShadow'); } catch { /* нет хранилища */ } clearTimeout(shadowTimer); window.__styleShadow = null; },
  enabled: styleShadowEnabled,
  last: () => window.__styleShadow || null,
};
