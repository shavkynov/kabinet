'use strict';
// Виртуальная файловая система для Android: весь код проекта (src/*.js) пользуется синхронным fs,
// поэтому файлы живут в памяти, а на диск (IndexedDB) уходят отложенной записью (setStore + flush).
// Пути всегда POSIX и абсолютные: /Кабинет/Проекты/<имя>/...

const P = require('./path');

const files = new Map(); // путь → { data: Buffer, mtimeMs }
const dirs = new Set(['/']);
let store = null;
const dirty = new Set();
let timer = null;
let flushing = Promise.resolve();
let flushDelay = 250;

const B = () => globalThis.Buffer;

function err(code, syscall, p) {
  const msgs = { ENOENT: 'no such file or directory', EEXIST: 'file already exists', ENOTDIR: 'not a directory', EISDIR: 'illegal operation on a directory', ENOTEMPTY: 'directory not empty', EBADF: 'bad file descriptor', EINVAL: 'invalid argument' };
  const e = new Error(`${code}: ${msgs[code] || code}, ${syscall} '${p}'`);
  e.code = code; e.syscall = syscall; e.path = p;
  return e;
}

const norm = (p) => P.resolve(String(p));

// Слушатели изменений (нужны синхронизации с обычной папкой: любая запись — повод выгрузить изменения).
const watchers = new Set();
let muted = false;
function notify(p) {
  if (muted) return;
  for (const cb of watchers) {
    try { cb(p); } catch (e) { console.error('fs watcher:', e); }
  }
}
const onNodeChange = (cb) => {
  watchers.add(cb);
  return () => watchers.delete(cb);
};
/** На время cb не сообщать об изменениях (когда файлы приходят из внешней папки). */
function unmute(fn) {
  muted = true;
  try { return Promise.resolve(fn()).finally(() => { muted = false; }); } catch (e) { muted = false; throw e; }
}

const mark = (p) => { dirty.add(p); notify(p); schedule(); };

function schedule() {
  if (!store || timer) return;
  timer = setTimeout(() => { timer = null; flush(); }, flushDelay);
}

function toBuf(data, enc) {
  if (typeof data === 'string') return B().from(data, enc || 'utf8');
  if (B().isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return B().from(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) return B().from(data.buffer, data.byteOffset, data.byteLength);
  return B().from(String(data), 'utf8');
}

function ensureParents(p) {
  let d = P.dirname(p);
  const chain = [];
  while (!dirs.has(d)) { chain.push(d); d = P.dirname(d); }
  for (const x of chain.reverse()) { dirs.add(x); mark(x); }
}

// ---------- чтение ----------

function readFileSync(p, opts) {
  const n = norm(p);
  const f = files.get(n);
  if (!f) { if (dirs.has(n)) throw err('EISDIR', 'read', p); throw err('ENOENT', 'open', p); }
  const enc = typeof opts === 'string' ? opts : opts && opts.encoding;
  return enc ? f.data.toString(enc) : B().from(f.data); // копия: у вызывающего свой буфер
}

const existsSync = (p) => { const n = norm(p); return files.has(n) || dirs.has(n); };

function statSync(p) {
  const n = norm(p);
  const f = files.get(n);
  if (f) return { size: f.data.length, mtimeMs: f.mtimeMs, mtime: new Date(f.mtimeMs), isFile: () => true, isDirectory: () => false };
  if (dirs.has(n)) return { size: 0, mtimeMs: 0, mtime: new Date(0), isFile: () => false, isDirectory: () => true };
  throw err('ENOENT', 'stat', p);
}

function children(n) {
  const pre = n === '/' ? '/' : `${n}/`;
  const out = new Map(); // имя → isDir
  for (const k of files.keys()) {
    if (!k.startsWith(pre)) continue;
    const rest = k.slice(pre.length);
    const i = rest.indexOf('/');
    if (i < 0) out.set(rest, false); else if (!out.has(rest.slice(0, i))) out.set(rest.slice(0, i), true);
  }
  for (const k of dirs) {
    if (!k.startsWith(pre) || k === n) continue;
    const nm = k.slice(pre.length).split('/')[0];
    if (nm && !out.has(nm)) out.set(nm, true);
  }
  return out;
}

function readdirSync(p, opts) {
  const n = norm(p);
  if (!dirs.has(n)) throw err(files.has(n) ? 'ENOTDIR' : 'ENOENT', 'scandir', p);
  const names = [...children(n)].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  if (opts && opts.withFileTypes) return names.map(([name, isDir]) => ({ name, isDirectory: () => isDir, isFile: () => !isDir }));
  return names.map(([name]) => name);
}

// ---------- запись ----------

const fds = new Map();
let nextFd = 100;

function writeFileSync(target, data, opts) {
  const enc = typeof opts === 'string' ? opts : opts && opts.encoding;
  if (typeof target === 'number') {
    const h = fds.get(target);
    if (!h) throw err('EBADF', 'write', target);
    writeFileSync(h, data, opts);
    return;
  }
  const n = norm(target);
  if (dirs.has(n)) throw err('EISDIR', 'open', target);
  ensureParents(n);
  files.set(n, { data: toBuf(data, enc), mtimeMs: Date.now() });
  mark(n);
}

function appendFileSync(p, data, opts) {
  const n = norm(p);
  const old = files.get(n);
  writeFileSync(n, old ? B().concat([old.data, toBuf(data, opts)]) : data, opts);
}

function mkdirSync(p, opts) {
  const n = norm(p);
  if (files.has(n)) throw err('EEXIST', 'mkdir', p);
  if (dirs.has(n)) { if (opts && opts.recursive) return; throw err('EEXIST', 'mkdir', p); }
  if (opts && opts.recursive) {
    const chain = [];
    let d = n;
    while (!dirs.has(d)) { chain.push(d); d = P.dirname(d); }
    for (const x of chain.reverse()) { dirs.add(x); mark(x); }
    return;
  }
  if (!dirs.has(P.dirname(n))) throw err('ENOENT', 'mkdir', p);
  dirs.add(n); mark(n);
}

function unlinkSync(p) {
  const n = norm(p);
  if (!files.has(n)) throw err(dirs.has(n) ? 'EISDIR' : 'ENOENT', 'unlink', p);
  files.delete(n); mark(n);
}

function rmSync(p, opts) {
  const n = norm(p);
  const rec = opts && opts.recursive;
  if (files.has(n)) { files.delete(n); mark(n); return; }
  if (!dirs.has(n)) { if (opts && opts.force) return; throw err('ENOENT', 'rm', p); }
  const pre = `${n}/`;
  const inside = [...files.keys()].filter((k) => k.startsWith(pre));
  const subdirs = [...dirs].filter((k) => k.startsWith(pre));
  if (!rec && (inside.length || subdirs.length)) throw err('ENOTEMPTY', 'rm', p);
  for (const k of inside) { files.delete(k); mark(k); }
  for (const k of subdirs) { dirs.delete(k); mark(k); }
  dirs.delete(n); mark(n);
}

const rmdirSync = (p, opts) => rmSync(p, { recursive: !!(opts && opts.recursive) });

function renameSync(from, to) {
  const a = norm(from);
  const b = norm(to);
  if (a === b) return;
  if (files.has(a)) {
    if (dirs.has(b)) throw err('EISDIR', 'rename', to);
    ensureParents(b);
    const f = files.get(a);
    files.delete(a); files.set(b, f); mark(a); mark(b);
    return;
  }
  if (!dirs.has(a)) throw err('ENOENT', 'rename', from);
  if (b.startsWith(`${a}/`)) throw err('EINVAL', 'rename', to);
  if (files.has(b)) throw err('ENOTDIR', 'rename', to);
  if (dirs.has(b)) { if (children(b).size) throw err('ENOTEMPTY', 'rename', to); dirs.delete(b); mark(b); }
  ensureParents(b);
  const pre = `${a}/`;
  for (const k of [...files.keys()]) {
    if (!k.startsWith(pre)) continue;
    const nk = b + k.slice(a.length);
    files.set(nk, files.get(k)); files.delete(k); mark(k); mark(nk);
  }
  for (const k of [...dirs]) {
    if (k !== a && !k.startsWith(pre)) continue;
    const nk = b + k.slice(a.length);
    dirs.delete(k); dirs.add(nk); mark(k); mark(nk);
  }
}

function copyFileSync(from, to) {
  const f = files.get(norm(from));
  if (!f) throw err('ENOENT', 'copyfile', from);
  writeFileSync(to, B().from(f.data));
}

function cpSync(from, to, opts) {
  const a = norm(from);
  const b = norm(to);
  if (files.has(a)) { copyFileSync(a, b); return; }
  if (!dirs.has(a)) throw err('ENOENT', 'cp', from);
  mkdirSync(b, { recursive: true });
  for (const [name, isDir] of children(a)) {
    const src = `${a}/${name}`;
    if (opts && typeof opts.filter === 'function' && !opts.filter(src)) continue;
    if (isDir) cpSync(src, `${b}/${name}`, opts); else copyFileSync(src, `${b}/${name}`);
  }
}

function openSync(p, flags) {
  const n = norm(p);
  if (/^[wa]/.test(String(flags || 'r'))) writeFileSync(n, '');
  else if (!files.has(n)) throw err('ENOENT', 'open', p);
  const fd = nextFd;
  nextFd += 1;
  fds.set(fd, n);
  return fd;
}
const closeSync = (fd) => { fds.delete(fd); };
const fsyncSync = () => {};
const watch = () => ({ close() {}, on() {} });

// ---------- сохранение на диск ----------

function setStore(s, opts) { store = s; if (opts && opts.delay != null) flushDelay = opts.delay; }

async function loadAll() {
  if (!store) return;
  const rows = await store.loadAll();
  for (const r of rows) {
    if (r.dir) dirs.add(r.p);
    else files.set(r.p, { data: B().from(r.data), mtimeMs: r.m || 0 });
  }
  dirs.add('/');
}

function flush() {
  if (!store) return flushing;
  if (timer) { clearTimeout(timer); timer = null; }
  const paths = [...dirty];
  dirty.clear();
  if (!paths.length) return flushing;
  const puts = [];
  const dels = [];
  for (const p of paths) {
    if (files.has(p)) { const f = files.get(p); puts.push({ p, dir: false, data: new Uint8Array(f.data), m: f.mtimeMs }); }
    else if (dirs.has(p)) puts.push({ p, dir: true });
    else dels.push(p);
  }
  flushing = flushing.then(() => store.apply(puts, dels)).catch((e) => {
    for (const p of paths) dirty.add(p); // не вышло: попробуем ещё раз
    schedule();
    console.error('fs flush failed:', e);
  });
  return flushing;
}

function reset() { files.clear(); dirs.clear(); dirs.add('/'); dirty.clear(); fds.clear(); }

module.exports = {
  readFileSync, existsSync, statSync, readdirSync, writeFileSync, appendFileSync, mkdirSync, unlinkSync, rmSync, rmdirSync,
  renameSync, copyFileSync, cpSync, openSync, closeSync, fsyncSync, watch,
  // служебное (не из node:fs)
  setStore, loadAll, flush, reset, onNodeChange, unmute, _files: files, _dirs: dirs,
};
