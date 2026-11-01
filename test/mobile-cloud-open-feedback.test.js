'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../renderer/app/36-dav.js'), 'utf8');
const start = source.indexOf('let phoneCloudOpening = false;');
const tick = () => new Promise((resolve) => setImmediate(resolve));
function setup({ flush = async () => {}, call = async () => null } = {}) {
  assert.ok(start >= 0);
  const attrs = new Map();
  const button = { textContent: 'Open cloud', disabled: false, getAttribute: (name) => attrs.get(name) ?? null, setAttribute: (name, value) => attrs.set(name, value), removeAttribute: (name) => attrs.delete(name) };
  const entered = [], errors = [], calls = [], frames = [];
  const context = { $: () => button, t: (text) => text, flush,
    window: { kabinetBackend: { call: async (channel) => { calls.push(channel); return call(channel); } } },
    enterProject: (project) => entered.push(project), showError: (message) => errors.push(message),
    requestAnimationFrame: (fn) => frames.push(fn), setTimeout: (fn) => { fn(); },
  };
  const open = vm.runInNewContext(`${source.slice(start)}\nopenCloudOnPhone`, context);
  return { open, button, attrs, entered, errors, calls, frames };
}

test('cloud button acknowledges immediately, yields a frame and suppresses duplicate opening', async () => {
  let finish;
  const project = { name: 'Fixture' };
  const x = setup({ call: () => new Promise((resolve) => { finish = resolve; }) });
  const task = x.open();
  assert.equal(x.button.disabled, true);
  assert.notEqual(x.button.textContent, 'Open cloud');
  assert.equal(x.attrs.get('aria-busy'), 'true');
  assert.equal(x.calls.length, 0);
  await x.open();
  assert.equal(x.frames.length, 1);
  x.frames.shift()();
  await tick();
  assert.deepEqual(x.calls, ['folder:open']);
  finish(project);
  await task;
  assert.deepEqual(x.entered, [project]);
  assert.equal(x.button.textContent, 'Open cloud');
  assert.equal(x.button.disabled, false);
  assert.equal(x.attrs.has('aria-busy'), false);
});

test('cancelling the wizard restores the button without entering a project', async () => {
  const x = setup();
  const task = x.open();
  x.frames.shift()();
  await task;
  assert.equal(x.button.disabled, false);
  assert.equal(x.button.textContent, 'Open cloud');
  assert.deepEqual(x.entered, []);
  assert.deepEqual(x.errors, []);
});

test('network and saving errors restore the button and allow retry', async () => {
  for (const stage of ['network', 'saving']) {
    let fail = true;
    const x = setup({
      flush: async () => { if (fail && stage === 'saving') throw new Error(stage); },
      call: async () => { if (fail && stage === 'network') throw new Error(stage); return null; },
    });
    const first = x.open(); x.frames.shift()(); await first;
    assert.deepEqual(x.errors, [stage]);
    assert.equal(x.button.disabled, false);
    assert.equal(x.attrs.has('aria-busy'), false);
    fail = false;
    const second = x.open(); x.frames.shift()(); await second;
    assert.equal(x.button.textContent, 'Open cloud');
    assert.equal(x.button.disabled, false);
  }
});
