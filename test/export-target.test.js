'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const target = require('../src/export-target');
function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kab-target-'));
  const data = path.join(root, 'data');
  const docs = path.join(root, 'docs');
  const out = path.join(root, 'out');
  fs.mkdirSync(docs); fs.mkdirSync(out);
  try { fn({ root, data, docs, out, project: path.join(root, 'Book') }); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}
test('new project keeps Documents/PDF default; remembers every supported format across reload', () => fixture(({ data, docs, out, project }) => {
  assert.equal(target.defaultPath(data, project, docs), path.join(docs, 'Book.pdf'));
  for (const ext of ['pdf', 'docx', 'rtf', 'md', 'txt', 'html']) {
    target.remember(data, project, path.join(out, `custom.${ext}`));
    delete require.cache[require.resolve('../src/export-target')];
    assert.equal(require('../src/export-target').defaultPath(data, project, docs), path.join(out, `Book.${ext}`));
  }
}));
test('projects are independent; missing folder falls back without changing stored format', () => fixture(({ root, data, docs, out, project }) => {
  target.remember(data, project, path.join(out, 'Book.docx'));
  assert.equal(target.defaultPath(data, path.join(root, 'Other'), docs), path.join(docs, 'Other.pdf'));
  fs.rmdirSync(out);
  assert.equal(target.defaultPath(data, project, docs), path.join(docs, 'Book.docx'));
  fs.mkdirSync(out);
  assert.equal(target.defaultPath(data, project, docs), path.join(out, 'Book.docx'));
}));
test('corrupt settings and write failures are not silently ignored; project files untouched', () => fixture(({ root, data, docs, out, project }) => {
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'project.json'), 'unchanged');
  target.remember(data, project, path.join(out, 'Book.txt'));
  assert.equal(fs.readFileSync(path.join(project, 'project.json'), 'utf8'), 'unchanged');
  assert.deepEqual(fs.readdirSync(project), ['project.json']);
  const settings = path.join(data, 'export-targets', fs.readdirSync(path.join(data, 'export-targets'))[0]);
  fs.writeFileSync(settings, '{');
  assert.throws(() => target.defaultPath(data, project, docs));
  const blocked = path.join(root, 'blocked'); fs.writeFileSync(blocked, 'file');
  assert.throws(() => target.remember(blocked, project, path.join(out, 'Book.txt')));
  assert.throws(() => target.remember(data, project, 'relative.txt'));
}));
function handler({ canceled = false, failWrite = false, failRemember = false } = {}) {
  let run;
  const events = [];
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = source.indexOf("handle('project:export',");
  const end = source.indexOf('// Импорт глав', start);
  assert.ok(start >= 0 && end > start);
  vm.runInNewContext(source.slice(start, end), {
    handle: (_name, fn) => { run = fn; },
    requireDir: () => '/project/Book', path, t: (s) => s,
    app: { getPath: () => '/local' },
    exportTarget: { defaultPath: () => '/out/Book.txt', remember: () => { events.push('remember'); if (failRemember) throw new Error('settings'); } },
    dialog: { showSaveDialog: async (win, opts) => { events.push(opts.defaultPath); return { canceled, filePath: '/out/Book.txt' }; }, showErrorBox: () => events.push('warning') },
    win: null, console: { error: () => {} },
    fs: { writeFileSync: () => { events.push('write'); if (failWrite) throw new Error('disk'); } },
    exporter: { buildExport: () => 'text' }, i18n: { getLang: () => 'ru' },
    shell: { showItemInFolder: () => events.push('show') },
  });
  return { run, events };
}
test('cancel does not remember; failed export does not remember; success remembers after write', async () => {
  const canceled = handler({ canceled: true });
  assert.equal(await canceled.run(), null);
  assert.deepEqual(canceled.events, ['/out/Book.txt']);
  const failed = handler({ failWrite: true });
  await assert.rejects(failed.run(), /disk/);
  assert.deepEqual(failed.events, ['/out/Book.txt', 'write']);
  const good = handler();
  assert.equal(await good.run(), '/out/Book.txt');
  assert.deepEqual(good.events, ['/out/Book.txt', 'write', 'remember', 'show']);
  const settings = handler({ failRemember: true });
  assert.equal(await settings.run(), '/out/Book.txt');
  assert.deepEqual(settings.events, ['/out/Book.txt', 'write', 'remember', 'warning', 'show']);
});
