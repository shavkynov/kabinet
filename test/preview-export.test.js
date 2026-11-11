'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
test('numbering preference defaults off, loads booleans, ignores invalid values', () => {
  for (const value of [undefined, false, true, 'true', 1]) {
    const context = { LANG: 'ru', DEFAULT_FILLERS: { ru: [] }, cleanFillerList: (v) => v, AN_CATS: [], AMBIENTS: {}, isEngine: () => false, isTheme: () => false, localStorage: { getItem: () => JSON.stringify({ exportNumbers: value }) } };
    vm.runInNewContext(read('renderer/app/21-look.js') + '\nresult = loadSettings().exportNumbers;', context);
    assert.equal(context.result, value === true);
  }
});
test('numbering checkbox, binding and renderer export option are connected', () => {
  assert.equal((read('renderer/index.html').match(/id="setExportNumbers"/g) || []).length, 1);
  assert.match(read('renderer/app/25-sound.js'), /bindSetting\('#setExportNumbers', 'exportNumbers', \(el\) => el.checked\)/);
  const parts = fs.readdirSync(path.join(__dirname, '../renderer/app')).filter((p) => p.endsWith('.js')).map((p) => read('renderer/app/' + p)).join('\n');
  assert.match(parts, /api\.exportProject\(\{ indent: settings\.para === 'indent', chapterNumbers: settings\.exportNumbers === true \}\)/);
});
for (const backend of ['main.js', 'mobile/backend.js']) {
  test(`${backend}: every export format receives the explicit numbering option`, async () => {
    const text = read(backend);
    const start = text.indexOf("handle('project:export',");
    const end = text.indexOf("handle('project:import',", start);
    assert.ok(start >= 0 && end > start);
    const block = text.slice(start, end);
    for (const enabled of [false, true]) {
      for (const format of (backend === 'main.js' ? ['pdf', 'docx', 'rtf', 'md', 'txt', 'html'] : ['docx', 'rtf', 'md', 'txt', 'html'])) {
        let run;
        const calls = [];
        const context = {
          handle: (_channel, fn) => { run = fn; }, requireDir: () => '/test/Book', path,
          t: (s) => s, win: null, TextEncoder, Uint8Array,
          app: { getPath: () => '/test' }, i18n: { getLang: () => 'ru' },
          exportTarget: { defaultPath: () => '/test/Book.' + format, remember() {}, filters: () => [] },
          dialog: { showSaveDialog: async () => ({ filePath: '/test/Book.' + format }), showErrorBox() {} },
          fs: { writeFileSync() {}, unlinkSync() {} }, shell: { showItemInFolder() {} },
          crypto: { randomBytes: () => Buffer.from('123456') },
          BrowserWindow: class { constructor() { this.webContents = { printToPDF: async () => Buffer.from('pdf') }; } async loadFile() {} destroy() {} },
          exporter: { buildExport: (...args) => { calls.push(args); return 'document'; } },
          EXPORT_FORMATS: [{ value: format, label: format, mime: 'test' }],
          host: { choose: async () => format, deliver: async () => {} }, console,
        };
        vm.runInNewContext(block, context);
        await run({ chapterNumbers: enabled });
        assert.equal(calls.length, 1);
        assert.equal(calls[0][3].chapterNumbers, enabled, backend + ':' + format);
      }
    }
  });
}
