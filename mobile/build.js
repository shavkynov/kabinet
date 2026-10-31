'use strict';
// Собирает mobile/www — всё, что попадёт в приложение: интерфейс (dist/app.js), стили, index.html и boot.js.
//   node mobile/build.js
// Нужны зависимости корня (tiptap, esbuild: npm install) и mobile (npm install в mobile/).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const www = path.join(__dirname, 'www');
const shim = path.join(__dirname, 'shim');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

function loadEsbuild() {
  for (const p of [path.join(root, 'node_modules', 'esbuild'), path.join(__dirname, 'node_modules', 'esbuild'), 'esbuild']) {
    try { return require(p); } catch { /* пробуем дальше */ }
  }
  throw new Error('Не найден esbuild: выполните npm install в корне проекта.');
}

function replaceOnce(text, from, to, label) {
  const hit = typeof from === 'string' ? text.split(from).length - 1 : (text.match(from) || []).length;
  if (hit !== 1) throw new Error(`index.html: «${label}» найдено ${hit} раз (ожидалось 1). Мобильная сборка отстала от интерфейса.`);
  return text.replace(from, () => to);
}

// 1. интерфейс (тот же, что на компьютере)
execFileSync(process.execPath, [path.join(root, 'scripts', 'build.js')], { cwd: root, stdio: 'inherit' });

fs.rmSync(www, { recursive: true, force: true });
fs.mkdirSync(path.join(www, 'dist'), { recursive: true });

// 2. загрузчик с «главным процессом» внутри
loadEsbuild().buildSync({
  entryPoints: [path.join(__dirname, 'boot.js')],
  bundle: true,
  outfile: path.join(www, 'boot.js'),
  format: 'iife',
  platform: 'browser',
  target: 'chrome100',
  external: ['node:crypto'], // запасной путь только для проверок в Node; в Android есть globalThis.crypto
  logLevel: 'info',
  nodePaths: [path.join(__dirname, 'node_modules'), path.join(root, 'node_modules')],
  alias: {
    fs: path.join(shim, 'fs.js'),
    path: path.join(shim, 'path.js'),
    crypto: path.join(shim, 'crypto.js'),
    zlib: path.join(shim, 'zlib.js'),
    os: path.join(shim, 'os.js'),
    child_process: path.join(shim, 'child_process.js'),
  },
  define: { __APP_VERSION__: JSON.stringify(version) },
});

// 3. страница: тот же index.html с мобильными добавками
let html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
html = replaceOnce(html, /<meta http-equiv="Content-Security-Policy"[\s\S]*?>/,
  '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\' \'unsafe-inline\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data: blob:; media-src \'self\' data: blob:; font-src \'self\' data: blob:; connect-src \'self\' https: http: data: blob:">', 'CSP');
html = replaceOnce(html, '<meta name="viewport" content="width=device-width, initial-scale=1">',
  '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content">', 'viewport');
html = replaceOnce(html, '<link rel="stylesheet" href="style.css">', '<link rel="stylesheet" href="style.css">\n  <link rel="stylesheet" href="mobile.css">', 'style.css');
html = replaceOnce(html, '<body>', '<body class="mob">', 'body');
html = replaceOnce(html, '<script src="dist/app.js"></script>', '<script src="boot.js"></script>', 'script');
fs.writeFileSync(path.join(www, 'index.html'), html);

for (const f of ['style.css', 'mobile.css']) fs.copyFileSync(path.join(root, 'renderer', f), path.join(www, f));
fs.copyFileSync(path.join(root, 'renderer', 'dist', 'app.js'), path.join(www, 'dist', 'app.js'));

console.log(`mobile/www готов (версия ${version}).`);
