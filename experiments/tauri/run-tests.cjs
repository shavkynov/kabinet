'use strict';
const { buildSync } = require('esbuild');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const dir = mkdtempSync(path.join(tmpdir(), 'kabinet-tauri-tests-'));
try {
  const outfile = path.join(dir, 'editor-plugins.test.cjs');
  buildSync({
    entryPoints: [path.join(__dirname, 'editor-plugins.test.mjs')],
    outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  });
  const result = spawnSync(process.execPath, ['--test', outfile], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status === null ? 1 : result.status;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
