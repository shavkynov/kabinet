'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { THEMES } = require('../src/themes');
const base = fs.readFileSync(path.join(__dirname, '../renderer/style.css'), 'utf8');
const mobile = fs.readFileSync(path.join(__dirname, '../renderer/mobile.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
function variables(id) {
  const block = new RegExp(`:root\\[data-theme="${id}"\\]\\s*\\{([^}]*)\\}`).exec(base);
  assert.ok(block, id);
  return Object.fromEntries([...block[1].matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]));
}
function rule(selector) {
  const result = {};
  for (const m of mobile.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!m[1].split(',').some((s) => s.trim() === selector)) continue;
    for (const declaration of m[2].split(';')) {
      const colon = declaration.indexOf(':');
      if (colon >= 0) result[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim();
    }
  }
  return result;
}
function luminance(hex) {
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
function ratio(a, b) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
test('mobile form errors use the theme danger colour, readable on each explicit theme paper', () => {
  assert.equal(rule('.mob-err').color, 'var(--danger)');
  for (const theme of THEMES) {
    const v = variables(theme.id);
    assert.ok(ratio(v.danger, v.paper) >= 4.5, theme.id);
  }
});
test('selected sound options use readable foreground text on selection backgrounds', () => {
  for (const selector of ['body.mob #chipProfile button.active', 'body.mob #chipAmbient button.active']) {
    assert.equal(rule(selector).color, 'var(--text)'); assert.equal(rule(selector).background, 'var(--sel)');
  }
  for (const theme of THEMES) {
    const v = variables(theme.id);
    assert.ok(ratio(v.text, v.sel) >= 4.5, theme.id);
  }
});
test('selected chapter numbers are not faded and have readable text on each explicit theme selection', () => {
  const number = rule('body.mob .ch.selected .num');
  assert.equal(number.color, 'var(--text)'); assert.equal(number.opacity, '1');
  for (const theme of THEMES) {
    const v = variables(theme.id);
    assert.ok(ratio(v.text, v.sel) >= 4.5, theme.id);
  }
});
