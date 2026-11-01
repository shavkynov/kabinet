'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function setup() {
  class Events {
    constructor() { this.listeners = new Map(); }
    addEventListener(name, fn) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(fn); }
    removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); }
    fire(name, data = {}) {
      const event = { target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...data };
      for (const fn of [...(this.listeners.get(name) || [])]) { fn(event); if (event.stopped) break; }
      return event;
    }
  }
  const document = new Events(), window = new Events(), timers = [];
  class Element extends Events {
    constructor(tag) { super(); this.tag = tag; this.children = []; this.parentNode = null; this.attrs = new Map(); this.style = {}; this.disabled = false; this.hidden = false; this.tabIndex = ['button', 'input', 'select', 'textarea'].includes(tag) ? 0 : -1; }
    fire(name, data = {}) {
      if (name === 'mob-cancel') {
        const event = window.fire(name, { target: this, ...data });
        if (event.stopped) return event;
      }
      return super.fire(name, data);
    }
    get isConnected() { return document.body.contains(this); }
    append(...nodes) { for (const node of nodes) { node.parentNode = this; this.children.push(node); } }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((n) => n !== this); this.parentNode = null; if (this.contains(document.activeElement)) document.activeElement = document.body; }
    setAttribute(name, value) { this.attrs.set(name, String(value)); }
    getAttribute(name) { return this.attrs.get(name) ?? null; }
    removeAttribute(name) { this.attrs.delete(name); }
    contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
    closest() { for (let node = this; node; node = node.parentNode) if (node.hidden || node.attrs.has('hidden') || node.attrs.has('inert') || node.getAttribute('aria-hidden') === 'true') return node; return null; }
    getClientRects() { return this.hidden || this.style.display === 'none' ? [] : [{}]; }
    focus() { document.activeElement = this; document.fire('focusin', { target: this }); }
    querySelectorAll(selector) {
      const all = []; const visit = (node) => { for (const child of node.children) { all.push(child); visit(child); } }; visit(this);
      return all.filter((node) => selector === '.mob-modal' ? node.className === 'mob-modal' : selector === 'h2' || selector === 'input' ? node.tag === selector : ['button', 'input', 'select', 'textarea'].includes(node.tag) || node.attrs.has('tabindex'));
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  }
  document.body = new Element('body'); document.activeElement = document.body;
  document.createElement = (tag) => new Element(tag);
  document.querySelectorAll = (selector) => document.body.querySelectorAll(selector);
  // Isolate the diagnostic overlay: these tests exercise modal focus, not sync metrics.
  const context = vm.createContext({ document, window, syncDiag: { install() {} }, setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout() {} });
  const load = (name, exports) => {
    let source = fs.readFileSync(path.join(__dirname, '../mobile', name), 'utf8');
    source = source
      .replace(/^import \{ activateModal \} from '\.\/modal-focus\.js';\r?\n/m, '')
      .replace(/^import syncDiag from '\.\.\/src\/sync-diag\.js';\r?\n/m, '')
      .replace(/export function /g, 'function ');
    return vm.runInContext(`(() => { ${source}\nreturn { ${exports} }; })()`, context);
  };
  context.activateModal = load('modal-focus.js', 'activateModal').activateModal;
  const ui = load('ui.js', 'chooseBox, confirmBox, formBox, menuBox');
  const wait = load('wait-box.js', 'waitBox').waitBox;
  const background = new Element('main'), trigger = new Element('button'); background.append(trigger); document.body.append(background); trigger.focus();
  const modal = () => document.querySelectorAll('.mob-modal').at(-1);
  const sheet = () => modal().children[0];
  const buttons = () => sheet().querySelectorAll('button, input');
  return { ui, wait, document, window, timers, background, trigger, modal, sheet, buttons };
}
const choices = { title: 'Choose', options: [{ label: 'Unavailable', value: 0, disabled: true }, { label: 'One', value: 1 }, { label: 'Two', value: 2 }], cancel: 'Cancel' };
test('sheet is labelled, isolates background and restores focus and existing attributes', async () => {
  const x = setup(); x.background.setAttribute('aria-hidden', 'false');
  const task = x.ui.chooseBox(choices), sheet = x.sheet();
  assert.equal(sheet.getAttribute('role'), 'dialog'); assert.equal(sheet.getAttribute('aria-modal'), 'true');
  assert.equal(sheet.getAttribute('aria-labelledby'), sheet.querySelector('h2').id);
  assert.equal(x.document.activeElement, sheet); assert.equal(x.background.getAttribute('inert'), '');
  x.buttons()[1].fire('click'); assert.equal(await task, 1);
  assert.equal(x.document.activeElement, x.trigger); assert.equal(x.background.getAttribute('inert'), null);
  assert.equal(x.background.getAttribute('aria-hidden'), 'false');
  assert.equal(x.window.listeners.get('keydown').size, 0); assert.equal(x.document.listeners.get('focusin').size, 0);
});
test('Tab wraps enabled controls and programmatic background focus is contained', async () => {
  const x = setup(), task = x.ui.chooseBox(choices), [disabled, first, second, cancel] = x.buttons();
  x.window.fire('keydown', { key: 'Tab' }); assert.equal(x.document.activeElement, first);
  x.window.fire('keydown', { key: 'Tab', shiftKey: true }); assert.equal(x.document.activeElement, cancel);
  x.window.fire('keydown', { key: 'Tab' }); assert.equal(x.document.activeElement, first);
  x.trigger.focus(); assert.equal(x.document.activeElement, x.sheet()); assert.equal(disabled.disabled, true);
  cancel.fire('click'); await task;
});
test('Escape cancels confirmation instead of accepting its first action', async () => {
  const x = setup(), task = x.ui.confirmBox({ message: 'Delete?', buttons: ['Delete', 'Cancel'], cancelId: 1 });
  assert.equal(x.window.fire('keydown', { key: 'Escape' }).defaultPrevented, true);
  assert.equal(await task, 1); assert.equal(x.document.activeElement, x.trigger);
});
test('OAuth waiting keeps user cancellation distinct from successful programmatic close', async () => {
  const x = setup(), first = x.wait({ title: 'Sign in', message: 'Browser' });
  x.modal().fire('mob-cancel'); assert.equal(await first.dismissed, true);
  const second = x.wait({ title: 'Sign in' }); second.close(); second.close();
  assert.equal(await second.dismissed, false); assert.equal(x.document.activeElement, x.trigger);
});
test('closing nested waiting sheet returns focus to its parent and leaves background isolated', async () => {
  const x = setup(), outer = x.ui.chooseBox(choices), parent = x.modal(), button = x.buttons()[1]; button.focus();
  const inner = x.wait({ title: 'Wait' }); assert.equal(parent.getAttribute('inert'), '');
  inner.close(); await inner.dismissed;
  assert.equal(parent.getAttribute('inert'), null); assert.equal(x.document.activeElement, button);
  assert.equal(x.background.getAttribute('inert'), ''); button.fire('click'); await outer;
});
test('out-of-order close cannot expose background behind a remaining sheet', async () => {
  const x = setup(), outer = x.ui.chooseBox(choices), cancel = x.buttons().at(-1);
  const inner = x.wait({ title: 'Wait' }); cancel.fire('click'); await outer;
  assert.equal(x.background.getAttribute('inert'), ''); assert.equal(x.document.activeElement, x.sheet());
  inner.close(); await inner.dismissed; assert.equal(x.background.getAttribute('inert'), null);
});
test('delayed form autofocus cannot steal focus after cancellation', async () => {
  const x = setup(), task = x.ui.formBox({ title: 'Folder', fields: [{ key: 'name', label: 'Name' }] });
  x.buttons().at(-1).fire('click'); assert.equal(await task, null);
  for (const fn of x.timers) fn(); assert.equal(x.document.activeElement, x.trigger);
});
test('Escape cancels menu and does not invoke an action', async () => {
  const x = setup(); let called = false;
  const task = x.ui.menuBox('Menu', [{ label: 'Action', run: () => { called = true; } }]);
  x.window.fire('keydown', { key: 'Escape' }); await task;
  for (const fn of x.timers) fn(); assert.equal(called, false);
});

test('Android Back routed to an older modal still cancels only the top sheet', async () => {
  const x = setup(), outer = x.ui.chooseBox(choices), parent = x.modal();
  const inner = x.wait({ title: 'Wait' });
  parent.fire('mob-cancel'); assert.equal(await inner.dismissed, true);
  assert.equal(x.modal(), parent); assert.equal(parent.getAttribute('inert'), null);
  x.buttons().at(-1).fire('click'); await outer;
  assert.equal(x.document.activeElement, x.trigger);
});
