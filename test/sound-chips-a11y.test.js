'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../renderer/app/25-sound.js'), 'utf8');
function setup() {
  const groups = new Map(), log = { saves: 0, previews: 0, renders: 0 };
  const document = { activeElement: null, addEventListener() {}, removeEventListener() {}, querySelectorAll: (selector) => groups.get(selector.split(' ')[0]).buttons };
  function group(id, values) {
    const node = { buttons: [], attrs: {}, listeners: {}, setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(k, fn) { this.listeners[k] = fn; }, contains(b) { return this.buttons.includes(b); }, querySelectorAll() { return this.buttons; } };
    node.buttons = values.map((value) => ({ dataset: { value }, disabled: false, attrs: {}, active: false, tabIndex: 0,
      setAttribute(k, v) { this.attrs[k] = v; }, closest() { return this; }, focus() { document.activeElement = this; },
      click() { if (!this.disabled) node.listeners.click({ target: this }); },
    }));
    for (const b of node.buttons) b.classList = { toggle: (_name, on) => { b.active = on; } };
    groups.set(id, node); return node;
  }
  const profile = group('#chipProfile', ['typewriter', 'soft', 'mech', 'pen']);
  const ambient = group('#chipAmbient', ['rain', 'fire', 'wind', 'sea', 'hum']);
  group('#chipKeySlots', ['key', 'space', 'backspace', 'enter']);
  const c = { document, $: (s) => groups.get(s), settings: { soundProfile: 'typewriter', ambient: 'rain', soundOn: false, ambientOn: false },
    ambientListOpen: false, keySlotOpen: null, saveSettings: () => { log.saves++; }, renderMySounds: () => { log.renders++; },
    sounds: { test: () => { log.previews++; }, getContext: () => ({ state: 'running' }) },
    applySettings: () => { c.markChips('#chipProfile', c.settings.soundProfile); c.markChips('#chipAmbient', c.settings.ambient); },
  };
  vm.createContext(c); vm.runInContext(source, c); c.wireChips();
  function key(node, button, name, extra = {}) {
    const e = { target: button, key: name, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...extra };
    node.listeners.keydown(e); return e;
  }
  return { c, log, document, profile, ambient, key };
}
function check(node, value) {
  assert.equal(node.attrs.role, 'radiogroup');
  assert.equal(node.buttons.filter((b) => b.tabIndex === 0).length, 1);
  for (const b of node.buttons) {
    assert.equal(b.attrs.role, 'radio'); assert.equal(b.attrs['aria-checked'], b.dataset.value === value ? 'true' : 'false');
    assert.equal(b.active, b.dataset.value === value); assert.equal(b.tabIndex, b.dataset.value === value ? 0 : -1);
  }
}
test('initial selection has radio roles, checked states and one Tab entry per group', () => {
  const x = setup(); check(x.profile, 'typewriter'); check(x.ambient, 'rain');
});
test('Right selects the next profile through the existing save and preview action', () => {
  const x = setup(), e = x.key(x.profile, x.profile.buttons[0], 'ArrowRight');
  check(x.profile, 'soft'); assert.equal(x.c.settings.soundProfile, 'soft'); assert.equal(x.c.settings.soundOn, true);
  assert.equal(x.document.activeElement, x.profile.buttons[1]); assert.equal(x.log.saves, 1); assert.equal(x.log.previews, 1);
  assert.equal(e.prevented, true); assert.equal(e.stopped, true);
});
test('Left and Up wrap backwards; Down wraps forwards', () => {
  const x = setup();
  x.key(x.profile, x.profile.buttons[0], 'ArrowLeft'); check(x.profile, 'pen');
  x.key(x.profile, x.profile.buttons[3], 'ArrowDown'); check(x.profile, 'typewriter');
  x.key(x.profile, x.profile.buttons[0], 'ArrowUp'); check(x.profile, 'pen');
});
test('Home and End select ambient endpoints without repeating an already selected action', () => {
  const x = setup();
  x.key(x.ambient, x.ambient.buttons[0], 'End'); check(x.ambient, 'hum'); assert.equal(x.c.settings.ambientOn, true);
  x.key(x.ambient, x.ambient.buttons[4], 'Home'); check(x.ambient, 'rain');
  const before = x.log.saves, opened = x.c.ambientListOpen;
  x.key(x.ambient, x.ambient.buttons[0], 'Home');
  assert.equal(x.log.saves, before); assert.equal(x.c.ambientListOpen, opened);
});
test('keyboard skips disabled choices', () => {
  const x = setup(); x.profile.buttons[1].disabled = true;
  x.key(x.profile, x.profile.buttons[0], 'ArrowRight'); check(x.profile, 'mech');
});
test('Tab, native activation keys and modified shortcuts are not intercepted', () => {
  const x = setup();
  for (const name of ['Tab', ' ', 'Enter', 'Escape']) assert.equal(x.key(x.profile, x.profile.buttons[0], name).prevented, false);
  for (const modifier of ['altKey', 'ctrlKey', 'metaKey']) assert.equal(x.key(x.profile, x.profile.buttons[0], 'ArrowRight', { [modifier]: true }).prevented, false);
  assert.equal(x.log.saves, 0); check(x.profile, 'typewriter');
});
test('pointer selection and restored settings update roles without stealing focus', () => {
  const x = setup(); x.profile.buttons[2].click(); check(x.profile, 'mech');
  x.profile.buttons[2].focus(); x.c.settings.soundProfile = 'pen'; x.c.applySettings(); check(x.profile, 'pen');
  assert.equal(x.document.activeElement, x.profile.buttons[2]);
});
test('unknown selection keeps a usable entry; a fully disabled group has none', () => {
  const x = setup(); x.c.markChips('#chipProfile', 'unknown');
  assert.equal(x.profile.buttons[0].tabIndex, 0); assert.ok(x.profile.buttons.every((b) => b.attrs['aria-checked'] === 'false'));
  for (const b of x.profile.buttons) b.disabled = true;
  x.c.markChips('#chipProfile', 'typewriter'); assert.ok(x.profile.buttons.every((b) => b.tabIndex === -1));
});
