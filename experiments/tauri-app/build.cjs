'use strict';
// Собирает интерфейс Кабинета для Tauri: тот же renderer, что в Electron, плюс мост window.kabinet (bridge.js).
//   node experiments/tauri-app/build.cjs   (нужны зависимости корня: npm ci)
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..', '..');
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
fs.copyFileSync(path.join(__dirname, 'bridge.js'), path.join(out, 'bridge.js'));
console.log('experiments/tauri-app/dist готов.');
