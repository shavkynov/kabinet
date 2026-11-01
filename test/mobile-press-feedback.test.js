'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const css = read('renderer/press-feedback.css');

test('press feedback is mobile-only and excludes disabled controls', () => {
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  assert.equal(rules.length, 3);
  for (const [, selector] of rules) {
    assert.ok(selector.trim().startsWith('body.mob'));
    assert.ok(selector.includes(':not(:disabled)'));
    assert.ok(selector.includes(':not([disabled])'));
    assert.ok(selector.includes(':not([aria-disabled="true"])'));
  }
});

test('only users without reduced-motion preference receive the 90ms scale effect', () => {
  const marker = css.indexOf('@media (prefers-reduced-motion: no-preference)');
  assert.ok(marker > 0);
  assert.doesNotMatch(css.slice(0, marker), /\b(?:scale|transition)\s*:/);
  assert.match(css.slice(marker), /transition:\s*scale 90ms ease-out/);
  assert.match(css.slice(marker), /scale:\s*\.97/);
  assert.doesNotMatch(css, /\b(?:transform|width|height|padding|margin|outline)\s*:/);
});

test('mobile build links and copies feedback stylesheet', () => {
  const build = read('mobile/build.js');
  assert.ok(build.includes('<link rel="stylesheet" href="press-feedback.css">'));
  assert.ok(build.includes("['style.css', 'mobile.css', 'press-feedback.css']"));
});
