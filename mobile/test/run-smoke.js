'use strict';
// node mobile/test/run-smoke.js — собирает smoke.entry.js с подменой fs/path/crypto и запускает.
const path = require('path');
const { execFileSync } = require('child_process');
let esbuild;
for (const p of ['esbuild', path.join(__dirname, '..', '..', 'node_modules', 'esbuild'), path.join(__dirname, '..', 'node_modules', 'esbuild')]) {
  try { esbuild = require(p); break; } catch { /* пробуем дальше */ }
}
if (!esbuild) throw new Error('Не найден esbuild: выполните npm install в корне проекта.');
const shim = path.join(__dirname, '..', 'shim');
const out = path.join(require('os').tmpdir(), 'kabinet-smoke.cjs');
esbuild.buildSync({
  entryPoints: [path.join(__dirname, 'smoke.entry.js')],
  bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'warning',
  define: { PRELOAD_SRC: JSON.stringify(require('fs').readFileSync(path.join(__dirname, '..', '..', 'preload.js'), 'utf8')) },
  alias: { fs: path.join(shim, 'fs.js'), path: path.join(shim, 'path.js') },
});
execFileSync(process.execPath, [out], { stdio: 'inherit' });
