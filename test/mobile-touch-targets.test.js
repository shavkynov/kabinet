'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const css = fs.readFileSync(path.join(__dirname, '../renderer/mobile.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
function rule(selector) {
  const result = {};
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!match[1].split(/,\s*(?![^()]*\))/).some((s) => s.trim() === selector)) continue;
    for (const part of match[2].split(';')) {
      const colon = part.indexOf(':');
      if (colon >= 0) result[part.slice(0, colon).trim()] = part.slice(colon + 1).trim();
    }
  }
  return result;
}
test('mobile removal controls are visible without hover and have declared 44px targets', () => {
  for (const selector of ['body.mob .recent-remove', 'body.mob .cf-x']) {
    const r = rule(selector);
    assert.equal(r.opacity, '1'); assert.equal(r['min-width'], '44px'); assert.equal(r['min-height'], '44px');
  }
});
test('panel actions and section-add buttons declare larger mobile targets', () => {
  assert.equal(rule('body.mob .panel button')['min-height'], '44px');
  assert.equal(rule('body.mob .side-plus')['min-width'], '44px');
  assert.equal(rule('body.mob .side-plus')['min-height'], '44px');
});
test('compact sync indicator uses a real 44px button with a separate non-interactive dot', () => {
  const button = rule('body.mob.m-compact #syncDot'), dot = rule('body.mob.m-compact #syncDot::before');
  assert.equal(button.width, '44px'); assert.equal(button.height, '44px'); assert.equal(button.background, 'transparent');
  assert.equal(button['box-sizing'], 'border-box'); assert.equal(dot['pointer-events'], 'none');
  assert.equal(dot.inset, '13px'); assert.equal(44 - 2 * parseFloat(dot.inset), 18);
  for (const state of ['busy', 'err', 'conflict']) assert.ok(rule(`body.mob.m-compact #syncDot.${state}::before`).background);
  assert.equal(rule('#syncDot[hidden]').display, 'none');
});
test('mobile inputs, dialog sheets and sync control have explicit keyboard focus outlines', () => {
  for (const selector of ['body.mob .panel :is(button, input, select, textarea):focus-visible', 'body.mob .mob-sheet :is(button, input, select, textarea):focus-visible', 'body.mob .mob-sheet:focus-visible', 'body.mob.m-compact #syncDot:focus-visible']) {
    assert.equal(rule(selector).outline, '2px solid var(--accent)', selector);
  }
});
