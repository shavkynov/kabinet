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

test('Кнопка сохранения #btnSave на нижней панели, горячая клавиша ⌘S/Ctrl+S и проводка состояния', () => {
  const toolbarSection = html.slice(html.indexOf('id="toolbar"'), html.indexOf('id="status"'));
  const chromeSection = html.slice(html.indexOf('id="chromeRight"'), html.indexOf('id="settings"'));
  assert.match(toolbarSection, /id="btnSave"[^>]*data-act="save"/);
  assert.ok(!chromeSection.includes('id="btnSave"'), '#btnSave не должен перегружать #chromeRight');

  const saveApp = fs.readFileSync(path.join(ROOT, 'renderer', 'app', '13-save.js'), 'utf8');
  const barApp = fs.readFileSync(path.join(ROOT, 'renderer', 'app', '19-toolbar.js'), 'utf8');
  const dockApp = fs.readFileSync(path.join(ROOT, 'renderer', 'app', '38-dock.js'), 'utf8');
  assert.match(saveApp, /async function saveNow\(/);
  assert.match(saveApp, /e\.code === 'KeyS'/);
  assert.match(barApp, /case 'save': saveNow\(\); break;/);
  assert.match(dockApp, /#btnSave[\s\S]*saveBtn\.classList\.toggle\('dirty'/);
});

test('TypeSounds и Ambient восстанавливаются после простоя и зависания часов', async () => {
  const { TypeSounds } = await import('../renderer/sounds.js');
  const { Ambient } = await import('../renderer/ambient.js');

  const prev = {
    window: globalThis.window,
    document: globalThis.document,
    performance: globalThis.performance,
    CustomEvent: globalThis.CustomEvent,
    now: Date.now,
  };
  let perfNow = 0;
  let clockNow = 1000;
  let nextState = 'suspended';
  let nextCt = 0;
  const contexts = [];
  const docHandlers = {};
  const winHandlers = {};

  class FakeAudioContext {
    constructor() {
      this.sampleRate = 8000;
      this.state = nextState;
      this.currentTime = nextCt;
      this.destination = {};
      this.closed = false;
      this.resumes = 0;
      this.started = 0;
      this.listeners = new Map();
      contexts.push(this);
    }
    createGain() {
      return {
        context: this,
        gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, setTargetAtTime() {}, cancelScheduledValues() {} },
        connect() {}, disconnect() {},
      };
    }
    createBuffer(_ch, len) { return { getChannelData: () => new Float32Array(len) }; }
    createBufferSource() {
      const ctx = this;
      return { buffer: null, loop: false, playbackRate: { value: 1 }, connect() {}, start() { ctx.started += 1; }, stop() {} };
    }
    createBiquadFilter() { return { type: '', frequency: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, Q: { value: 1 }, gain: { value: 0 }, connect() {} }; }
    createOscillator() {
      const ctx = this;
      return { type: '', frequency: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, start() { ctx.started += 1; }, stop() {} };
    }
    resume() { this.resumes += 1; return Promise.resolve(); }
    close() { this.closed = true; this.state = 'closed'; return Promise.resolve(); }
    addEventListener(ev, fn) { this.listeners.set(ev, fn); }
  }

  let snd = null;
  let amb = null;
  try {
    Date.now = () => clockNow;
    globalThis.performance = { now: () => perfNow };
    globalThis.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };
    globalThis.document = {
      hidden: false,
      addEventListener(ev, fn) { (docHandlers[ev] ||= []).push(fn); },
    };
    globalThis.window = {
      AudioContext: FakeAudioContext,
      addEventListener(ev, fn) { (winHandlers[ev] ||= []).push(fn); },
      dispatchEvent() {},
    };

    snd = new TypeSounds();
    amb = new Ambient(snd);
    let resets = 0;
    snd.onReset(() => { amb.reset(); resets += 1; });

    // 1. Быстрая серия нажатий, пока AudioContext просыпается (suspended <= 1500 мс), не пересоздаёт контекст
    for (const t of [100, 160, 220, 280, 340, 400]) {
      perfNow = t;
      snd.play('key');
    }
    assert.equal(contexts.length, 1);
    assert.equal(contexts[0].resumes, 2); // троттлинг 250 мс: на t=100 и t=400

    // Перешёл в running и часы идут
    contexts[0].state = 'running';
    contexts[0].currentTime = 0.5;
    perfNow = 500;
    snd.play('key');
    assert.equal(contexts.length, 1);

    // 2. Если часы остановились (currentTime замер) даже при непрерывном быстром наборе каждые 100 мс — пересоздаём
    for (let t = 600; t <= 1900; t += 100) {
      perfNow = t;
      snd.play('key');
    }
    assert.equal(contexts.length, 2, 'застывшие часы должны пересоздавать контекст даже при частом наборе');
    assert.equal(contexts[0].closed, true);

    // 3. Эмбиент переподключается к новому контексту после долгого сворачивания (>10 с)
    contexts[1].state = 'running';
    contexts[1].currentTime = 1;
    amb.play('rain');
    assert.equal(amb.bus.context, contexts[1]);

    globalThis.document.hidden = true;
    clockNow = 2000;
    docHandlers.visibilitychange.forEach((fn) => fn());
    globalThis.document.hidden = false;
    clockNow = 15000;
    docHandlers.visibilitychange.forEach((fn) => fn());
    assert.equal(contexts[1].closed, true);
    assert.equal(amb.bus, null);
    assert.ok(resets >= 2);

    amb.play('rain');
    assert.equal(contexts.length, 3);
    assert.equal(amb.bus.context, contexts[2]);
  } finally {
    if (amb) amb.reset();
    if (snd) snd._drop();
    Date.now = prev.now;
    if (prev.window === undefined) delete globalThis.window; else globalThis.window = prev.window;
    if (prev.document === undefined) delete globalThis.document; else globalThis.document = prev.document;
    if (prev.performance === undefined) delete globalThis.performance; else globalThis.performance = prev.performance;
    if (prev.CustomEvent === undefined) delete globalThis.CustomEvent; else globalThis.CustomEvent = prev.CustomEvent;
  }
});
