'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

// Запускает часть интерфейса 36-dav.js с подставными зависимостями и возвращает всё, что нужно, чтобы нажать кнопку.
function setup({ mob, call }) {
  const log = { flushed: 0, entered: [], errors: [], desktopOpened: [], calls: [] };
  const buttons = new Map();
  const button = (id) => {
    if (!buttons.has(id)) {
      const attrs = new Map();
      buttons.set(id, {
        textContent: 'Open cloud', disabled: false, listeners: {},
        getAttribute(name) { return attrs.get(name) ?? null; },
        setAttribute(name, value) { attrs.set(name, String(value)); },
        removeAttribute(name) { attrs.delete(name); },
        addEventListener(name, fn) { this.listeners[name] = fn; },
      });
    }
    return buttons.get(id);
  };
  const frames = [];
  const sandbox = {
    document: { body: { classList: { contains: (name) => mob && name === 'mob' } } },
    $: (sel) => button(sel),
    api: { onOpenSync() {}, onDavEvent() {} },
    t: (s) => s, tdom: (s) => s, DAV: {}, project: null,
    flush: async () => { log.flushed += 1; },
    enterProject: (proj) => log.entered.push(proj),
    showError: (message) => log.errors.push(message),
    window: { kabinetBackend: { call: async (channel, ...args) => { log.calls.push([channel, ...args]); return call(channel); } } },
    requestAnimationFrame: (fn) => { frames.push(fn); },
    setTimeout: (fn) => { fn(); },
  };
  vm.createContext(sandbox);
  vm.runInContext(read('renderer', 'app', '36-dav.js'), sandbox, { filename: '36-dav.js' });
  sandbox.openSyncDialog = (mode) => log.desktopOpened.push(mode);
  sandbox.wireDav();
  return {
    log,
    button: button('#btnOpenCloud'),
    click: async () => {
      await button('#btnOpenCloud').listeners.click();
      while (frames.length) frames.shift()();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

function assertButtonRestored(x) {
  assert.equal(x.button.textContent, 'Open cloud');
  assert.equal(x.button.disabled, false);
  assert.equal(x.button.getAttribute('aria-busy'), null);
}

test('on the phone the start-page cloud button opens the project through the backend wizard', async () => {
  const proj = { name: 'Роман', chapters: [{ id: 'abcdef' }] };
  const x = setup({ mob: true, call: async () => proj });
  await x.click();
  assert.deepEqual(x.log.calls, [['folder:open']]);
  assert.equal(x.log.flushed, 1);
  assert.deepEqual(x.log.entered, [proj]);
  assert.deepEqual(x.log.desktopOpened, []);
  assert.deepEqual(x.log.errors, []);
  assertButtonRestored(x);
});

test('on the phone a cancelled wizard leaves the start page as it is', async () => {
  const x = setup({ mob: true, call: async () => null });
  await x.click();
  assert.deepEqual(x.log.entered, []);
  assert.deepEqual(x.log.errors, []);
  assertButtonRestored(x);
});

test('on the phone a wizard error is shown, not swallowed', async () => {
  const x = setup({ mob: true, call: async () => { throw new Error('В выбранной папке нет проекта Кабинета.'); } });
  await x.click();
  assert.deepEqual(x.log.entered, []);
  assert.deepEqual(x.log.errors, ['В выбранной папке нет проекта Кабинета.']);
  assertButtonRestored(x);
});

test('on the computer the button still opens the sync dialog', async () => {
  const x = setup({ mob: false, call: async () => { throw new Error('не должно вызываться'); } });
  await x.click();
  assert.deepEqual(x.log.desktopOpened, ['open']);
  assert.deepEqual(x.log.calls, []);
  assertButtonRestored(x);
});

test('phone styles no longer hide the cloud button and keep both start buttons easy to hit', () => {
  const css = read('renderer', 'mobile.css');
  assert.doesNotMatch(css, /#btnOpenCloud\s*\{[^}]*display\s*:\s*none/);
  assert.match(css, /\.start-actions button\s*\{[^}]*min-height:\s*48px/);
  assert.match(read('renderer', 'index.html'), /id="btnOpenCloud"/);
});
