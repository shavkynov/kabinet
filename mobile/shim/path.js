'use strict';
// Минимальный path (POSIX) для браузера: в приложении пути всегда вида /Кабинет/...

function normalizeParts(p) {
  const abs = p.startsWith('/');
  const out = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else if (!abs) out.push('..'); } else out.push(seg);
  }
  return { abs, out };
}

function normalize(p) {
  p = String(p);
  if (!p) return '.';
  const { abs, out } = normalizeParts(p);
  const trail = p.endsWith('/') && out.length ? '/' : '';
  return (abs ? '/' : '') + out.join('/') + trail || (abs ? '/' : '.');
}

function join(...parts) {
  const s = parts.filter((x) => x !== '' && x != null).map(String).join('/');
  return s ? normalize(s) : '.';
}

function resolve(...parts) {
  let acc = '';
  for (let i = parts.length - 1; i >= 0 && !acc.startsWith('/'); i -= 1) {
    const p = String(parts[i]);
    if (p) acc = acc ? `${p}/${acc}` : p;
  }
  if (!acc.startsWith('/')) acc = `/${acc}`;
  const { out } = normalizeParts(acc);
  return `/${out.join('/')}`;
}

function basename(p, ext) {
  p = String(p).replace(/\/+$/, '');
  let b = p.slice(p.lastIndexOf('/') + 1);
  if (ext && b.endsWith(ext) && b !== ext) b = b.slice(0, -ext.length);
  return b;
}

function dirname(p) {
  p = String(p).replace(/\/+$/, '');
  const i = p.lastIndexOf('/');
  if (i < 0) return '.';
  return i === 0 ? '/' : p.slice(0, i);
}

function extname(p) {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i <= 0 ? '' : b.slice(i);
}

function parse(p) {
  const base = basename(p);
  const ext = extname(p);
  return { root: String(p).startsWith('/') ? '/' : '', dir: dirname(p), base, ext, name: ext ? base.slice(0, -ext.length) : base };
}

const isAbsolute = (p) => String(p).startsWith('/');

function relative(from, to) {
  const a = resolve(from).split('/').filter(Boolean);
  const b = resolve(to).split('/').filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}

const posix = { sep: '/', delimiter: ':', normalize, join, resolve, basename, dirname, extname, parse, isAbsolute, relative };
posix.posix = posix;
module.exports = posix;
