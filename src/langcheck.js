'use strict';

// Проверка орфографии, пунктуации и грамматики через LanguageTool (публичный сервер или свой).
// Ничего не правит сама: возвращает список замечаний, автор принимает или пропускает каждое.
// Модуль без Electron: сеть передаётся параметром fetchImpl.

const PUBLIC_SERVER = 'https://api.languagetool.org/v2';
const MAX_CHUNK = 12000;       // публичный сервер принимает до 20 000 знаков за запрос
const PUBLIC_GAP_MS = 3200;    // публичный сервер: около 20 запросов в минуту

function normalizeServer(url) {
  let s = String(url || '').trim();
  if (!s) return PUBLIC_SERVER;
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  s = s.replace(/\/+$/, '');
  if (!/\/v2$/i.test(s)) s += '/v2';
  return s;
}

function isLocalServer(url) {
  try {
    const h = new URL(normalizeServer(url)).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
  } catch { return false; }
}

/**
 * Режет абзацы на куски не длиннее max знаков. Кусок: { text, parts: [{para, start, len, off}] },
 * где off смещение части внутри куска, start смещение части внутри абзаца.
 */
function buildChunks(paragraphs, max = MAX_CHUNK) {
  const chunks = [];
  let cur = { text: '', parts: [] };
  const flush = () => { if (cur.parts.length) chunks.push(cur); cur = { text: '', parts: [] }; };

  const pieces = [];
  paragraphs.forEach((p, para) => {
    const s = String(p);
    if (!s.trim()) return;
    if (s.length <= max) { pieces.push({ para, start: 0, text: s }); return; }
    let i = 0;
    while (i < s.length) {
      let end = Math.min(i + max, s.length);
      if (end < s.length) {
        const win = s.slice(i, end);
        let cut = Math.max(win.lastIndexOf('. '), win.lastIndexOf('! '), win.lastIndexOf('? '));
        if (cut < max * 0.5) cut = win.lastIndexOf(' ');
        if (cut > 0) end = i + cut + 1;
      }
      pieces.push({ para, start: i, text: s.slice(i, end) });
      i = end;
    }
  });

  for (const pc of pieces) {
    const add = pc.text.length + 1;
    if (cur.parts.length && cur.text.length + add > max) flush();
    cur.parts.push({ para: pc.para, start: pc.start, len: pc.text.length, off: cur.text.length });
    cur.text += `${pc.text}\n`;
  }
  flush();
  return chunks;
}

function kindOf(m) {
  const cat = String((m.rule && m.rule.category && m.rule.category.id) || '');
  const issue = String((m.rule && m.rule.issueType) || '').toLowerCase();
  if (cat === 'TYPOS' || issue === 'misspelling') return 'spelling';
  if (cat === 'PUNCTUATION' || /COMMA|PUNCT/i.test(String((m.rule && m.rule.id) || ''))) return 'punctuation';
  if (cat === 'TYPOGRAPHY' || issue === 'typographical') return 'typography';
  if (cat === 'STYLE' || cat === 'REDUNDANCY' || issue === 'style') return 'style';
  if (cat === 'GRAMMAR' || issue === 'grammar') return 'grammar';
  return 'other';
}

/** Переводит ответ сервера по куску в замечания с позициями внутри абзацев. */
function mapMatches(chunk, matches) {
  const out = [];
  for (const m of matches || []) {
    const part = chunk.parts.find((p) => m.offset >= p.off && m.offset < p.off + p.len + 1);
    if (!part) continue;
    const offset = part.start + (m.offset - part.off);
    const text = chunk.text.slice(m.offset, m.offset + m.length);
    if (!m.length || !text.trim()) continue;
    out.push({
      para: part.para,
      offset,
      length: m.length,
      text,
      message: String(m.message || ''),
      short: String(m.shortMessage || ''),
      ruleId: String((m.rule && m.rule.id) || ''),
      kind: kindOf(m),
      replacements: (m.replacements || []).slice(0, 6).map((r) => String(r.value)).filter((v) => v !== text),
    });
  }
  return out;
}

async function requestCheck(fetchImpl, server, text, opts, signal) {
  const body = new URLSearchParams();
  body.set('text', text);
  const lang = opts.lang === 'en' ? 'en-US' : opts.lang === 'auto' ? 'auto' : 'ru-RU';
  body.set('language', lang);
  if (lang === 'auto') body.set('preferredVariants', 'en-US');
  if (opts.disabledRules && opts.disabledRules.length) body.set('disabledRules', opts.disabledRules.join(','));

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 45000);
    const onAbort = () => ctl.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    let res;
    try {
      res = await fetchImpl(`${server}/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: body.toString(),
        signal: ctl.signal,
      });
    } catch (err) {
      if (signal && signal.aborted) throw new Error('Проверка остановлена.');
      throw new Error(`Не удалось связаться со службой проверки (${server.replace(/\/v2$/, '')}). Проверьте интернет или адрес сервера.`);
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
    if (res.status === 429 && attempt === 0) {
      await sleep(PUBLIC_GAP_MS * 4, signal);
      continue;
    }
    if (res.status === 429) throw new Error('Служба проверки просит подождать (слишком много запросов). Попробуйте через минуту.');
    if (!res.ok) throw new Error(`Служба проверки ответила ошибкой ${res.status}.`);
    return res.json();
  }
  return { matches: [] };
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

/** Виды замечаний, которые можно скрыть: орфография, пунктуация, грамматика, стиль, типографика и остальное. */
const CHECK_KINDS = ['spelling', 'punctuation', 'grammar', 'style', 'typography', 'other'];

/** Список скрытых видов из настроек: только известные виды, без повторов, в порядке CHECK_KINDS. */
function cleanKinds(list) {
  const set = new Set(Array.isArray(list) ? list.map((x) => String(x)) : []);
  return CHECK_KINDS.filter((k) => set.has(k));
}

function filterIssues(issues, { disabledRules = [], words = [], hiddenKinds = [] } = {}) {
  const off = new Set(disabledRules);
  const hidden = new Set(hiddenKinds);
  const known = new Set(words.map((w) => String(w).toLowerCase()));
  return issues.filter((i) => {
    if (off.has(i.ruleId)) return false;
    if (hidden.has(i.kind)) return false;
    if (i.kind === 'spelling' && known.has(i.text.toLowerCase())) return false;
    return true;
  });
}

/**
 * Проверяет абзацы. opts: { server, lang, disabledRules, hiddenKinds, words, fetchImpl, signal, onProgress, gapMs }
 * Возвращает замечания с полями id, para, offset, length, text, message, short, ruleId, kind, replacements.
 */
async function checkParagraphs(paragraphs, opts = {}) {
  const server = normalizeServer(opts.server);
  const fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!fetchImpl) throw new Error('Нет сетевого доступа.');
  const gap = opts.gapMs !== undefined ? opts.gapMs : (server === PUBLIC_SERVER ? PUBLIC_GAP_MS : 0);
  const chunks = buildChunks(paragraphs, opts.maxChunk || MAX_CHUNK);
  let all = [];
  for (let i = 0; i < chunks.length; i += 1) {
    if (opts.signal && opts.signal.aborted) throw new Error('Проверка остановлена.');
    if (opts.onProgress) opts.onProgress(i, chunks.length);
    if (i > 0 && gap) await sleep(gap, opts.signal);
    const json = await requestCheck(fetchImpl, server, chunks[i].text, opts, opts.signal);
    all = all.concat(mapMatches(chunks[i], json.matches));
  }
  if (opts.onProgress) opts.onProgress(chunks.length, chunks.length);
  all.sort((a, b) => a.para - b.para || a.offset - b.offset);
  all = filterIssues(all, opts);
  all.forEach((x, n) => { x.id = n + 1; });
  return all;
}

module.exports = { PUBLIC_SERVER, MAX_CHUNK, CHECK_KINDS, normalizeServer, isLocalServer, buildChunks, mapMatches, kindOf, cleanKinds, filterIssues, checkParagraphs };
