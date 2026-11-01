'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');

function listTests() {
  const dir = path.join(root, 'test');
  const tests = fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js'))
    .map((entry) => entry.name)
    .sort()
    .map((name) => path.join(dir, name));
  if (!tests.length) throw new Error('No test/*.test.js files found.');
  return tests;
}

function runTests(options = {}) {
  return spawnSync(process.execPath, ['--test', ...listTests()], {
    cwd: root,
    ...options,
  });
}

if (require.main === module) {
  try {
    const result = runTests({ stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.signal) console.error(`Test runner terminated by ${result.signal}`);
    process.exitCode = result.status === null ? 1 : result.status;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

module.exports = { listTests, runTests };
