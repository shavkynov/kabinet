'use strict';

// Быстрая проверка проекта одной командой: npm run check
// Синтаксис всех файлов, совпадение id в разметке и коде, повторные функции, тесты.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
require('./concat').buildApp();
let failed = 0;
const fail = (msg) => { failed += 1; console.error(`✗ ${msg}`); };

function syntax(file, asModule) {
  let target = file;
  if (asModule) {
    target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kab-')), `${path.basename(file, '.js')}.mjs`);
    fs.copyFileSync(file, target);
  }
  const r = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' });
  if (r.status !== 0) fail(`синтаксис ${path.relative(root, file)}\n${r.stderr}`);
}

for (const f of ['main.js', 'preload.js']) syntax(path.join(root, f), false);
for (const f of fs.readdirSync(path.join(root, 'src'))) if (f.endsWith('.js')) syntax(path.join(root, 'src', f), false);
for (const f of fs.readdirSync(path.join(root, 'scripts'))) if (f.endsWith('.js')) syntax(path.join(root, 'scripts', f), false);
const rdir = path.join(root, 'renderer');
const modules = fs.readdirSync(rdir).filter((f) => f.endsWith('.js'));
for (const f of modules) syntax(path.join(rdir, f), true);

// id в коде должны быть в index.html
const html = fs.readFileSync(path.join(rdir, 'index.html'), 'utf8');
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
for (const f of modules) {
  const code = fs.readFileSync(path.join(rdir, f), 'utf8');
  const used = new Set([...code.matchAll(/(?:\$|querySelector|getElementById)\(\s*['"]#([A-Za-z][\w-]*)['"]\s*\)/g)].map((m) => m[1]));
  for (const id of used) if (!ids.has(id)) fail(`${f}: в index.html нет #${id}`);
}

// одинаковые функции верхнего уровня в app.js: вторая молча затирает первую
const app = fs.readFileSync(path.join(rdir, 'app.gen.js'), 'utf8');
const seen = new Map();
for (const m of app.matchAll(/^(?:async )?function ([A-Za-z0-9_]+)/gm)) seen.set(m[1], (seen.get(m[1]) || 0) + 1);
for (const [name, n] of seen) if (n > 1) fail(`app: функция ${name} объявлена ${n} раза (части renderer/app/)`);

// IPC: каждый вызов call('канал') в preload должен иметь handle('канал') в main
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const pre = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
for (const m of pre.matchAll(/call\('([^']+)'/g)) {
  if (!main.includes(`handle('${m[1]}'`)) fail(`preload: в main.js нет handle('${m[1]}')`);
}
const api = new Set([...pre.matchAll(/^\s+([A-Za-z]+):/gm)].map((m) => m[1]));
for (const f of modules) {
  const code = fs.readFileSync(path.join(rdir, f), 'utf8');
  for (const m of code.matchAll(/\bapi\.([A-Za-z]+)\(/g)) if (!api.has(m[1])) fail(`${f}: в preload нет api.${m[1]}`);
}

const tests = fs.readdirSync(path.join(root, 'test')).filter((f) => f.endsWith('.test.js')).map((f) => path.join(root, 'test', f));
const t = spawnSync(process.execPath, ['--test', ...tests], { encoding: 'utf8' });
const pass = /# pass (\d+)/.exec(t.stdout);
const bad = /# fail (\d+)/.exec(t.stdout);
if (t.status !== 0 || (bad && bad[1] !== '0')) fail(`тесты не прошли\n${t.stdout.split('\n').filter((l) => /not ok|Error/.test(l)).join('\n')}`);
else console.log(`тесты: ${pass ? pass[1] : '?'} пройдено`);

if (failed) {
  console.error(`\nПроблем: ${failed}`);
  process.exit(1);
}
console.log('✓ всё в порядке');
