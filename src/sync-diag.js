'use strict';
// Диагностика синхронизации (тестовая сборка): createFolderSync оборачивается снаружи, адаптер считает вызовы и время.
// Подписи на английском: русские строки пришлось бы вносить в словарь переводов.
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
  const run = { name, startedAt: clock(), ms: 0, done: false, error: '', calls: {}, files: 0, dirs: 0, summary: '' };
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
        try {
          const out = await value.apply(target, args);
          if (run && prop === 'list' && Array.isArray(out)) for (const it of out) { if (it && it.dir) run.dirs += 1; else run.files += 1; }
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

// file: () => путь для текстового отчёта (компьютер); overlay: кнопка «diag» (Android).
function install({ folder, file, overlay, doc, win } = {}) {
  if (installed) return installed;
  const cleanups = [instrumentFolder(folder || require('./folder'))];
  if (typeof file === 'function') {
    const flush = () => { try { require('fs').writeFileSync(file(), `${HEADER}\n\n${report(MAX_RUNS)}\n`); } catch { /* отчёт не критичен */ } };
    const timer = setInterval(() => { if (runs.some((r) => !r.done)) flush(); }, 3000);
    if (timer.unref) timer.unref();
    listeners.add(flush);
    cleanups.push(() => { listeners.delete(flush); clearInterval(timer); });
  }
  const d = doc || (typeof document !== 'undefined' ? document : null);
  const w = win || (typeof window !== 'undefined' ? window : null);
  if (overlay && d && w) cleanups.push(mountOverlay(d, w));
  installed = () => { while (cleanups.length) cleanups.pop()(); installed = null; };
  return installed;
}

module.exports = { install, report, recent, reset, startRun, wrapAdapter, instrumentFolder, describeRun };
