'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { THEMES, isTheme, themeMode } = require('../src/themes');

const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');

function lum(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};
function vars(id) {
  const m = css.match(new RegExp(`:root\\[data-theme="${id}"\\]\\s*\\{([^}]*)\\}`));
  assert.ok(m, `в style.css нет темы ${id}`);
  const out = {};
  for (const [, k, v] of m[1].matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)) out[k] = v;
  out.mode = /color-scheme:\s*(\w+)/.exec(m[1])[1];
  return out;
}

test('темы: допустимые значения и режим окна', () => {
  assert.ok(isTheme('system') && isTheme('light') && isTheme('dark-ember'));
  assert.ok(!isTheme('neon') && !isTheme(undefined));
  assert.equal(themeMode('system'), 'system');
  assert.equal(themeMode('light-sand'), 'light');
  assert.equal(themeMode('dark-forest'), 'dark');
});

test('темы: каждая есть в списке настроек', () => {
  for (const t of THEMES) assert.ok(html.includes(`<option value="${t.id}">`), `нет пункта ${t.id}`);
});

test('темы: цветные темы читаются (контраст текста, второстепенного текста и акцента)', () => {
  for (const t of THEMES.filter((x) => x.id.includes('-'))) {
    const v = vars(t.id);
    assert.equal(v.mode, t.mode, `${t.id}: режим`);
    assert.ok(ratio(v.text, v.paper) >= 7, `${t.id}: текст на бумаге ${ratio(v.text, v.paper).toFixed(1)}`);
    assert.ok(ratio(v.text, v.bg) >= 7, `${t.id}: текст на фоне`);
    assert.ok(ratio(v.muted, v.paper) >= 4.5, `${t.id}: второстепенный текст на бумаге`);
    assert.ok(ratio(v.muted, v.side) >= 4.5, `${t.id}: второстепенный текст на панели`);
    assert.ok(ratio(v.accent, v.paper) >= 4.5, `${t.id}: акцент на бумаге`);
    assert.ok(ratio(v.accent, v.side) >= 4.5, `${t.id}: акцент на панели`);
    assert.ok(ratio(v['sticky-text'], v.sticky) >= 7, `${t.id}: текст на стикере`);
    // слишком яркий белый на тёмном режет глаза: у тёмных тем текст не светлее #e8e8e8
    if (t.mode === 'dark') assert.ok(lum(v.text) < lum('#e8e8e8'), `${t.id}: текст слишком яркий`);
    // светлая бумага не должна быть ослепительно белой
    if (t.mode === 'light') assert.ok(lum(v.paper) < lum('#fefefe'), `${t.id}: бумага слишком белая`);
  }
});
