'use strict';
// Регрессия F.3.1-B2: кнопки «‹ ›» панели «Стиль текста» лежат вне #viewAnalysis, и обработчик клика
// с блокировкой пустых категорий был привязан только к нему, поэтому переход не работал.
// Здесь проверяется проводка по исходникам: каждая кнопка data-an-nav должна быть внутри контейнера,
// на который повешен обработчик.

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

test('Перетаскивание списков и доски: без нативного drag-n-drop, через pointer-события', () => {
  const tauriConf = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop', 'src-tauri', 'tauri.conf.json'), 'utf8'));
  assert.equal(tauriConf.app.windows[0].dragDropEnabled, false);

  for (const rel of ['renderer/lists.js', 'renderer/app/09-board.js']) {
    const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(!code.includes('dragstart'), `${rel} не должен использовать HTML5 dragstart`);
    assert.ok(!/\.draggable\s*=\s*true/.test(code), `${rel} не должен ставить draggable = true`);
    for (const ev of ['pointerdown', 'pointermove', 'pointerup']) {
      assert.ok(code.includes(ev), `${rel} должен обрабатывать ${ev}`);
    }
  }
});

test('Меню списков и split-панель синхронизируются при изменении порядка', () => {
  const listsApp = fs.readFileSync(path.join(ROOT, 'renderer', 'app', '14-lists.js'), 'utf8');
  const trashApp = fs.readFileSync(path.join(ROOT, 'renderer', 'app', '15-trash.js'), 'utf8');
  const notesApp = fs.readFileSync(path.join(ROOT, 'renderer', 'app', '16-notes.js'), 'utf8');

  assert.match(listsApp, /reorderDoc[\s\S]*if\s*\(kind\s*===\s*'chapter'\)\s*fillP2Select\(\)/);
  assert.ok(listsApp.includes('moveDocBy'));
  assert.ok(listsApp.includes('reorderMenuEntries'));
  assert.ok(listsApp.includes('...reorderMenuEntries(\'chapter\''));
  assert.ok(trashApp.includes('...reorderMenuEntries(kind'));
  assert.match(notesApp, /trashListCtl\s*=\s*createList\(\{[\s\S]*?reorderable:\s*false/);
});

test('Мой словарь склоняется в spellskip и применяется к обоим редакторам', () => {
  const skip = fs.readFileSync(path.join(ROOT, 'renderer', 'spellskip.js'), 'utf8');
  const links = fs.readFileSync(path.join(ROOT, 'renderer', 'app', '12-links.js'), 'utf8');
  assert.match(skip, /import\s*\{\s*expandWords\s*\}\s*from\s*'\.\.\/src\/dict\.js'/);
  assert.ok(skip.includes('expandWords(words || [])'));
  assert.match(links, /for\s*\(const\s+\w+\s+of\s+\[editor,\s*editor2\]\)/);
});

test('Нижняя полоса #statusDock и оформление панелей', () => {
  const dock = fs.readFileSync(path.join(ROOT, 'renderer', 'app', '38-dock.js'), 'utf8');
  const screens = fs.readFileSync(path.join(ROOT, 'renderer', 'app', '02-screens.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'renderer', 'style.css'), 'utf8');
  const checkJs = fs.readFileSync(path.join(ROOT, 'renderer', 'textcheck.js'), 'utf8');

  assert.match(dock, /dock\.classList\.toggle\('empty'/);
  assert.match(dock, /dock\.hidden\s*=\s*!project;/);
  assert.ok(screens.includes('refreshSaveState()'));
  assert.match(css, /body\.typing\s+#statusDock:not\(\.has-err\)\s*>\s*\*/);
  assert.match(css, /\.ctx-icons\s*\{[^}]*max-height:\s*\d+px[^}]*overflow-y:\s*auto/);
  assert.ok(checkJs.includes('#checkKindsBox'));
  assert.ok(checkJs.includes('#checkLtHint'));
});

test('Android: mobileBack закрывает .ctx-menu, а свайп не перехватывается поверх .ctx-menu', () => {
  const mob = fs.readFileSync(path.join(ROOT, 'renderer', 'app', '35-mobile.js'), 'utf8');
  assert.match(mob, /mobileBack[\s\S]*document\.querySelector\('\.ctx-menu'\)[\s\S]*closeMenu\(\)/);
  assert.match(mob, /closest\([^)]*\.ctx-menu[^)]*\)/);
  assert.doesNotMatch(mob, /closest\([^)]*#menu[^)]*\)/);
});
