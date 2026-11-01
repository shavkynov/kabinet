'use strict';
// Диагностика синхронизации (тестовая сборка): createFolderSync оборачивается снаружи, адаптер считает вызовы и время.
// Подписи отчёта на английском; панель импорта использует существующие переводы интерфейса.
const MAX_RUNS = 12;
const METHODS = new Set(['list', 'read', 'write', 'remove', 'mkdir']);
const OPS = new Set(['sync', 'push', 'replaceAll', 'importAll', 'exportAll']);
const HEADER = 'Kabinet sync diagnostics (test build), newest first.\nYandex Disk: read = 2 HTTP requests, write = 3+ plus up to 20 x 0.5 s polling.';
const runs = [];
const listeners = new Set();
let installed = null;

const changed = () => { for (const fn of listeners) { try { fn(); } catch { /* отчёт не мешает синхронизации */ } } };
const reset = () => { runs.length = 0; changed(); };
const recent = () => runs.slice();
const sec = (ms) => `${(ms / 1000).toFixed(1)}s`;
const pad = (n) => String(n).padStart(2, '0');

function startRun(name, clock = Date.now) {
  const run = { name, startedAt: clock(), ms: 0, done: false, error: '', calls: {}, files: 0, dirs: 0, summary: '', importTotal: 0, completed: 0, phase: 'listing' };
  runs.push(run);
  while (runs.length > MAX_RUNS) runs.shift();
  changed();
  return run;
}

function wrapAdapter(adapter, current, clock = Date.now) {
  if (!adapter || typeof adapter !== 'object') return adapter;
  return new Proxy(adapter, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      if (!METHODS.has(prop)) return value.bind(target);
      return async (...args) => {
        const run = current();
        const started = clock();
        if (run && run.name === 'importAll' && prop === 'read') run.phase = 'download';
        try {
          const out = await value.apply(target, args);
          if (run && prop === 'list' && Array.isArray(out)) {
            for (const it of out) {
              if (it && it.dir) run.dirs += 1; else run.files += 1;
              if (run.name === 'importAll' && it && !it.dir) {
                const rel = args[0] ? `${args[0]}/${it.name}` : it.name;
                if (require('./folder').isSyncable(rel)) run.importTotal += 1;
              }
            }
          }
          if (run && run.name === 'importAll' && prop === 'read' && out != null) run.completed += 1;
          return out;
        } finally {
          if (run) {
            const c = run.calls[prop] || (run.calls[prop] = { n: 0, ms: 0 });
            c.n += 1;
            c.ms += clock() - started;
          }
        }
      };
    },
  });
}

function summarize(out) {
  if (typeof out === 'number') return `hidden ${out}`;
  if (Array.isArray(out)) return `files ${out.length}`;
  if (!out || typeof out !== 'object') return '';
  return ['pulled', 'pushed', 'removed', 'conflicts'].filter((k) => Array.isArray(out[k])).map((k) => `${k} ${out[k].length}`).join(', ');
}

async function track(inst, name, fn, clock) {
  const run = startRun(name, clock);
  inst.active = run;
  try {
    const out = await fn();
    run.summary = summarize(out);
    return out;
  } catch (err) {
    run.error = String((err && err.message) || err);
    throw err;
  } finally {
    run.ms = clock() - run.startedAt;
    run.done = true;
    inst.active = null;
    changed();
  }
}

// Стадии одного экземпляра идут строго по очереди, как и внутри folder.js, поэтому запросы относятся к своей стадии.
function instrumentFolder(folder, clock = Date.now) {
  const original = folder.createFolderSync;
  folder.createFolderSync = function createFolderSync(dir, adapter, options) {
    const inst = { active: null, queue: Promise.resolve() };
    const sync = original.call(this, dir, wrapAdapter(adapter, () => inst.active, clock), options);
    return new Proxy(sync, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (typeof value !== 'function' || !OPS.has(prop)) return value;
        return (...args) => {
          const next = inst.queue.then(() => track(inst, prop, () => value.apply(target, args), clock));
          inst.queue = next.catch(() => {});
          return next;
        };
      },
    });
  };
  return () => { folder.createFolderSync = original; };
}

function describeRun(run, now = Date.now()) {
  let n = 0;
  let spent = 0;
  const parts = [];
  for (const key of METHODS) {
    const c = run.calls[key];
    if (!c) continue;
    n += c.n;
    spent += c.ms;
    parts.push(`${key} ${c.n} / ${sec(c.ms)}`);
  }
  const d = new Date(run.startedAt);
  const state = run.error ? `ERROR: ${run.error}` : run.done ? 'ok' : 'RUNNING';
  return [
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${run.name} ${sec(run.done ? run.ms : now - run.startedAt)} ${state}`,
    `  calls ${n}${n ? `, avg ${sec(spent / n)}` : ''}: ${parts.join(', ') || '-'}`,
    `  listed files ${run.files}, dirs ${run.dirs}${run.summary ? `; ${run.summary}` : ''}`,
  ].join('\n');
}

const report = (limit = 8) => runs.slice(-limit).reverse().map((r) => describeRun(r)).join('\n');

function importProgress() {
  const run = [...runs].reverse().find((r) => r.name === 'importAll' && !r.done);
  return run ? { phase: run.phase, total: run.importTotal, completed: run.completed } : null;
}

// Немодальная панель видна автоматически во время импорта, не забирает фокус и не блокирует мастер.
function mountImportProgress(doc, { setTimer = setInterval, clearTimer = clearInterval } = {}) {
  const t = require('./i18n').t;
  const banner = doc.createElement('section');
  banner.style.cssText = 'position:fixed;left:12px;right:12px;bottom:calc(76px + env(safe-area-inset-bottom,0px));z-index:150;max-width:520px;margin:auto;padding:14px 16px;border:1px solid var(--line);border-radius:12px;background:var(--paper);color:var(--text);box-shadow:0 4px 20px rgba(0,0,0,.22);font:14px/1.4 sans-serif;pointer-events:none';
  banner.setAttribute('role', 'status');
  banner.setAttribute('aria-live', 'polite');
  banner.setAttribute('aria-atomic', 'true');
  banner.hidden = true;
  const title = doc.createElement('div');
  title.style.cssText = 'font-weight:600;margin-bottom:6px';
  const detail = doc.createElement('div');
  const bar = doc.createElement('progress');
  bar.style.cssText = 'display:block;width:100%;height:10px;margin-top:8px;accent-color:var(--accent)';
  banner.append(title, detail, bar);
  const paint = () => {
    const state = importProgress();
    banner.hidden = !state;
    if (!state) return;
    title.textContent = t('Открыть проект из облака');
    const downloading = state.phase === 'download';
    detail.textContent = downloading ? `${t('Идёт синхронизация…')} ${state.completed} / ${state.total}` : t('Проверяю…');
    bar.hidden = !downloading || state.total === 0;
    bar.max = Math.max(1, state.total);
    bar.value = Math.min(state.completed, state.total);
    bar.setAttribute('aria-label', t('Идёт синхронизация…'));
  };
  const attach = () => { doc.body.append(banner); paint(); };
  if (doc.body) attach(); else doc.addEventListener('DOMContentLoaded', attach, { once: true });
  listeners.add(paint);
  const timer = setTimer(paint, 250);
  return () => {
    listeners.delete(paint);
    clearTimer(timer);
    doc.removeEventListener('DOMContentLoaded', attach);
    banner.remove();
  };
}

// Android: кнопка «diag» в углу экрана открывает отчёт поверх приложения.
function mountOverlay(doc, win) {
  const el = (tag, css, text) => {
    const e = doc.createElement(tag);
    e.style.cssText = css;
    if (text) e.textContent = text;
    if (tag === 'button') e.type = 'button';
    return e;
  };
  const button = el('button', 'position:fixed;left:6px;bottom:6px;z-index:2147483000;min-width:44px;min-height:44px;opacity:.55;font:12px monospace;border-radius:8px;border:1px solid #888;background:#222;color:#eee', 'diag');
  const panel = el('div', 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483001;display:none;flex-direction:column;padding:8px;background:#111;color:#ddd');
  const pre = el('pre', 'flex:1;overflow:auto;margin:0;white-space:pre-wrap;font:12px/1.4 monospace;user-select:text');
  const bar = el('div', 'display:flex;gap:8px;padding-top:8px');
  const copy = el('button', 'flex:1;min-height:44px', 'Copy');
  const close = el('button', 'flex:1;min-height:44px', 'Close');
  bar.append(copy, close);
  panel.append(pre, bar);
  let timer = null;
  const paint = () => { pre.textContent = `${HEADER}\n\n${report() || 'No sync runs yet.'}`; };
  const hide = () => { panel.style.display = 'none'; clearInterval(timer); };
  button.addEventListener('click', () => { paint(); panel.style.display = 'flex'; clearInterval(timer); timer = setInterval(paint, 1000); });
  close.addEventListener('click', hide);
  copy.addEventListener('click', () => { try { win.navigator.clipboard.writeText(pre.textContent); } catch { /* буфер недоступен */ } });
  const attach = () => doc.body.append(button, panel);
  if (doc.body) attach(); else doc.addEventListener('DOMContentLoaded', attach, { once: true });
  return () => { hide(); button.remove(); panel.remove(); };
}

// diagnostics:false отключает служебные панели и запись отчёта, сохраняя прогресс импорта.
function install({ folder, file, overlay, doc, win, diagnostics = true } = {}) {
  if (installed) return installed;
  const cleanups = [instrumentFolder(folder || require('./folder'))];
  if (diagnostics && typeof file === 'function') {
    const flush = () => { try { require('fs').writeFileSync(file(), `${HEADER}\n\n${report(MAX_RUNS)}\n`); } catch { /* отчёт не критичен */ } };
    const timer = setInterval(() => { if (runs.some((r) => !r.done)) flush(); }, 3000);
    if (timer.unref) timer.unref();
    listeners.add(flush);
    cleanups.push(() => { listeners.delete(flush); clearInterval(timer); });
  }
  const d = doc || (typeof document !== 'undefined' ? document : null);
  const w = win || (typeof window !== 'undefined' ? window : null);
  if (overlay && d && w) {
    if (diagnostics) cleanups.push(mountOverlay(d, w));
    cleanups.push(mountImportProgress(d));
  }
  installed = () => { while (cleanups.length) cleanups.pop()(); installed = null; };
  return installed;
}

module.exports = { install, report, recent, reset, startRun, wrapAdapter, instrumentFolder, describeRun, importProgress, mountImportProgress };
