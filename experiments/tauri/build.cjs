'use strict';
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

async function main() {
  const out = path.join(__dirname, 'dist');
  fs.mkdirSync(out, { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'editor.js')],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: ['chrome120', 'safari15'],
    outfile: path.join(out, 'editor.js'),
    sourcemap: true,
    logLevel: 'info',
  });
  fs.copyFileSync(path.join(__dirname, 'index.html'), path.join(out, 'index.html'));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
