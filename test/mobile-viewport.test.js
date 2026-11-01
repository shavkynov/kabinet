'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../mobile/build.js'), 'utf8');
const input = '<!doctype html><html><head>\n<meta http-equiv="Content-Security-Policy" content="default-src self">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<link rel="stylesheet" href="style.css">\n</head><body><button id="btnOpenCloud">Cloud</button><script src="dist/app.js"></script></body></html>\n';
function runBuild(t, html = input) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kab-viewport-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of ['mobile', 'renderer/dist']) fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '0.35.0' }));
  fs.writeFileSync(path.join(dir, 'renderer/index.html'), html);
  for (const name of ['style.css', 'mobile.css', 'press-feedback.css', 'dist/app.js']) fs.writeFileSync(path.join(dir, 'renderer', name), 'fixture');
  const builds = [];
  vm.runInNewContext(source, {
    __dirname: path.join(dir, 'mobile'), process, console: { log() {} },
    require(id) {
      if (id === 'fs') return fs;
      if (id === 'path') return path;
      if (id === 'child_process') return { execFileSync() {} };
      if (id === 'esbuild' || /node_modules[\\/]esbuild$/.test(id)) return { buildSync: (options) => builds.push(options) };
      throw new Error(`Unexpected dependency: ${id}`);
    },
  });
  return { html: fs.readFileSync(path.join(dir, 'mobile/www/index.html'), 'utf8'), builds, dir };
}
test('generated mobile page does not prohibit user zoom', (t) => {
  const result = runBuild(t);
  const viewport = /<meta name="viewport" content="([^"]*)">/.exec(result.html)[1];
  assert.doesNotMatch(viewport, /user-scalable\s*=\s*(?:no|0)|maximum-scale\s*=/i);
  assert.match(viewport, /width=device-width/);
  assert.match(viewport, /initial-scale=1/);
  assert.match(viewport, /viewport-fit=cover/);
  assert.match(viewport, /interactive-widget=resizes-content/);
});
test('mobile page still loads boot, styles and cloud button without changing desktop input', (t) => {
  const result = runBuild(t);
  assert.match(result.html, /<body class="mob">/);
  assert.match(result.html, /<script src="boot.js"><\/script>/);
  assert.match(result.html, /href="mobile.css"/);
  assert.match(result.html, /href="press-feedback.css"/);
  assert.match(result.html, /id="btnOpenCloud"/);
  assert.match(result.html, /Content-Security-Policy/);
  assert.equal(fs.readFileSync(path.join(result.dir, 'renderer/index.html'), 'utf8'), input);
  assert.equal(fs.readFileSync(path.join(result.dir, 'mobile/www/dist/app.js'), 'utf8'), 'fixture');
  assert.equal(fs.readFileSync(path.join(result.dir, 'mobile/www/press-feedback.css'), 'utf8'), 'fixture');
  assert.equal(result.builds.length, 1);
  assert.equal(result.builds[0].define.__APP_VERSION__, '"0.35.0"');
});
test('unexpected viewport template fails explicitly instead of silently omitting accessibility settings', (t) => {
  assert.throws(() => runBuild(t, input.replace('width=device-width, initial-scale=1', 'width=320')), /viewport/);
});
