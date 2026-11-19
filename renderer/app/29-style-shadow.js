// Теневой режим нового стилевого парсера. Старый анализ (src/style.js) продолжает
// обслуживать подсветку;здесь только фоновый вызов Rust-парсера и диагностика.
// Включается только внутренней настройкой localStorage, без пользовательского UI.

let shadowTimer = 0;
let shadowSeq = 0;
let shadowPrev = 0;

function styleShadowEnabled() {
  try { return localStorage.getItem('kabinet.styleEngineShadow') === '1'; } catch { return false; }
}

function scheduleStyleShadow() {
  if (!styleShadowEnabled() || LANG !== 'ru' || !editor) return;
  clearTimeout(shadowTimer);
  shadowTimer = setTimeout(runStyleShadow, 900);
}

async function runStyleShadow() {
  if (!styleShadowEnabled() || LANG !== 'ru' || !editor || !api.styleParse) return;
  const text = editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n\n', '\n');
  if (!text.trim()) return;
  const task = ++shadowSeq;
  if (shadowPrev && api.styleCancel) { try { await api.styleCancel(shadowPrev); } catch { /* старый запрос уже мог завершиться */ } }
  shadowPrev = task;
  const t0 = performance.now();
  try {
    const res = await api.styleParse(text, task);
    if (task !== shadowSeq) return; // ответ устаревшего запроса
    const parse = res && res.parse;
    window.__styleShadow = {
      task,
      at: Date.now(),
      ms: Math.round(performance.now() - t0),
      ok: true,
      cancelled: !!(res && res.cancelled),
      sentences: parse && Array.isArray(parse.sentences) ? parse.sentences.length : 0,
      tokens: parse && Array.isArray(parse.sentences) ? parse.sentences.reduce((n, s) => n + ((s.tokens && s.tokens.length) || 0), 0) : 0,
      error: '',
    };
  } catch (err) {
    if (task !== shadowSeq) return;
    window.__styleShadow = { task, at: Date.now(), ms: Math.round(performance.now() - t0), ok: false, cancelled: false, sentences: 0, tokens: 0, error: err && err.message ? err.message : String(err) };
  }
}

// Внутреннее управление для диагностики; намеренно не выведено в интерфейс.
window.kabinetStyleShadow = {
  enable() { try { localStorage.setItem('kabinet.styleEngineShadow', '1'); } catch { /* нет хранилища */ } scheduleStyleShadow(); },
  disable() { try { localStorage.removeItem('kabinet.styleEngineShadow'); } catch { /* нет хранилища */ } clearTimeout(shadowTimer); },
  enabled: styleShadowEnabled,
  last: () => window.__styleShadow || null,
};
