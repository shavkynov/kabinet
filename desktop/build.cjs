'use strict';
// Собирает интерфейс Кабинета для Tauri: общий renderer плюс мост window.kabinet (bridge.js).
//   node desktop/build.cjs   (нужны зависимости корня: npm ci)
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const out = path.join(__dirname, 'dist');

function replaceOnce(text, from, to, label) {
  const hit = typeof from === 'string' ? text.split(from).length - 1 : (text.match(from) || []).length;
  if (hit !== 1) throw new Error(`index.html: «${label}» найдено ${hit} раз (ожидалось 1). Сборка Tauri отстала от интерфейса.`);
  return text.replace(from, () => to);
}

execFileSync(process.execPath, [path.join(root, 'scripts', 'build.js')], { cwd: root, stdio: 'inherit' });

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'dist'), { recursive: true });

let html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
html = replaceOnce(html, /<meta http-equiv="Content-Security-Policy"[\s\S]*?>/,
  '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data: blob:; font-src \'self\' data:; media-src \'self\' blob: data:; connect-src ipc: http://ipc.localhost">', 'CSP');
html = replaceOnce(html, '<script src="dist/app.js"></script>', '<script src="bridge.js"></script>\n  <script src="dist/app.js"></script>', 'script');
fs.writeFileSync(path.join(out, 'index.html'), html);
fs.copyFileSync(path.join(root, 'renderer', 'style.css'), path.join(out, 'style.css'));
fs.copyFileSync(path.join(root, 'renderer', 'dist', 'app.js'), path.join(out, 'dist', 'app.js'));
require('esbuild').buildSync({ entryPoints: [path.join(__dirname, 'bridge.src.js')], bundle: true, outfile: path.join(out, 'bridge.js'), format: 'iife', platform: 'browser', target: 'chrome120', logLevel: 'info' });

// Гарантируем существование resources/style-models и resources/licenses для cargo check / tauri build,
// даже когда сама 14-МБ модель ещё не скачана (например, в облегчённом rust-check).
const resRoot = path.join(__dirname, 'src-tauri', 'resources');
const resModels = path.join(resRoot, 'style-models');
const resLicenses = path.join(resRoot, 'licenses');
fs.mkdirSync(resModels, { recursive: true });
fs.mkdirSync(resLicenses, { recursive: true });
const licSrc = path.join(root, 'docs', 'licenses');
if (fs.existsSync(licSrc)) {
  for (const name of fs.readdirSync(licSrc)) {
    const p = path.join(licSrc, name);
    if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(resLicenses, name));
  }
}
const hasModel = fs.readdirSync(resModels).some((n) => n.endsWith('.udpipe'));
const placeholder = path.join(resModels, 'placeholder.txt');
if (hasModel) {
  try { fs.rmSync(placeholder, { force: true }); } catch { /* ignore */ }
} else {
  fs.writeFileSync(placeholder, 'Модель загружается на этапе сборки установщика (scripts/prepare-style-model.cjs).\n');
}
console.log('desktop/dist готов.');
