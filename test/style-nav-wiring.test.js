'use strict';
// Регрессия F.3.1-B2: кнопки «‹ ›» панели «Стиль текста» лежат вне #viewAnalysis, и обработчик клика
// с блокировкой пустых категорий был привязан только к нему, поэтому переход не работал.
// Здесь проверяется проводка по исходникам: каждая кнопка data-an-nav должна быть внутри контейнера,
// на который повешен обработчик. Поведение в настоящем окне проверяет experiments/tauri-app/e2e/real-ipc.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
const src = fs.readFileSync(path.join(ROOT, 'renderer', 'app', '28-analysis.js'), 'utf8');

// Для каждой кнопки data-an-nav — id всех объемлющих div.
function navAncestors() {
  const stack = [];
  const found = [];
  const re = /<div\b([^>]*)>|<\/div>|<button\b([^>]*)>/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[0].startsWith('</div')) { stack.pop(); continue; }
    if (m[0].startsWith('<div')) {
      const id = /\bid="([^"]+)"/.exec(m[1]);
      stack.push(id ? id[1] : null);
      continue;
    }
    const nav = /data-an-nav="([^"]+)"/.exec(m[2] || '');
    if (nav) found.push({ cat: nav[1], ancestors: stack.filter(Boolean) });
  }
  return found;
}

test('«‹ ›»: обработчик клика повешен на каждый контейнер с кнопками data-an-nav', () => {
  const wired = [...src.matchAll(/\$\('#(\w+)'\)\.addEventListener\('click', onNavClick\)/g)].map((m) => m[1]);
  const buttons = navAncestors();
  assert.ok(buttons.length >= 26, `кнопок «‹ ›» найдено ${buttons.length}`);
  for (const b of buttons) {
    assert.ok(b.ancestors.some((id) => wired.includes(id)), `кнопки «${b.cat}» лежат в [${b.ancestors}], обработчик есть только у [${wired}]`);
  }
  assert.ok(wired.includes('stylePanel'), 'панель «Стиль текста» обслуживается');
});

test('«‹ ›»: блокировка пустых категорий не ограничена #viewAnalysis', () => {
  assert.ok(!/querySelectorAll\('#viewAnalysis \[data-an-nav\]'\)/.test(src));
  assert.ok(/querySelectorAll\('\[data-an-nav\]'\)/.test(src));
});
