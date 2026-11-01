'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const css = fs.readFileSync(path.join(__dirname, '../renderer/mobile.css'), 'utf8');
function reducedBlock() {
  const start = css.indexOf('@media (prefers-reduced-motion: reduce)');
  assert.ok(start >= 0, 'mobile stylesheet must respect reduced motion');
  const open = css.indexOf('{', start);
  let depth = 1, end = open + 1;
  while (end < css.length && depth) {
    if (css[end] === '{') depth++;
    if (css[end] === '}') depth--;
    end++;
  }
  assert.equal(depth, 0);
  return css.slice(open + 1, end - 1);
}
function rule(selector) {
  const out = {};
  for (const m of reducedBlock().matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!m[1].split(',').some((s) => s.trim() === selector)) continue;
    for (const declaration of m[2].split(';')) {
      const colon = declaration.indexOf(':');
      if (colon >= 0) out[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim();
    }
  }
  return out;
}
test('reduced-motion overrides are scoped to mobile and do not hide state indicators', () => {
  for (const m of reducedBlock().matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const selector of m[1].split(',')) assert.ok(selector.trim().startsWith('body.mob'), selector);
    assert.ok(!/\b(?:display|visibility|background|color|transform)\s*:/.test(m[2]), m[2]);
  }
});
test('reduced-motion mode stops drawer, scrim, status and goal transitions', () => {
  for (const selector of ['body.mob.m-dl #sidebar', 'body.mob.m-dr #notesbar', 'body.mob #mobScrim', 'body.mob #status', 'body.mob #goalBtn', 'body.mob #goalBar i']) {
    assert.equal(rule(selector).transition, 'none', selector);
  }
});
test('reduced-motion mode stops pulse and goal celebration while keeping busy sync visible', () => {
  assert.equal(rule('body.mob #syncDot.busy').animation, 'none');
  assert.equal(rule('body.mob #syncDot.busy').opacity, '1');
  assert.equal(rule('body.mob #goal.hit #goalBtn').animation, 'none');
});
