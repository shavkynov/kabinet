// ---------- Android: телефон, планшет, клавиатура ----------
// Режимы (классы на body; считает applyMobileLayout, стили в renderer/mobile.css):
//   mob        приложение запущено на Android
//   m-tablet   короткая сторона экрана от 600 dp
//   m-kbd      подключена физическая клавиатура (только тогда звучат клавиши)
//   m-full     планшет или клавиатура: доступен весь функционал
//   m-compact  телефон без клавиатуры: лист и две панели, выезжающие по свайпу
//   m-dl/m-dr  левая / правая панель выезжает поверх листа (иначе стоит рядом с ним)
//   m-narrow   узкое окно: окна настроек раскрываются снизу
// Состояние лежит в MOB (01-state.js): части с номерами выше 28 выполняются уже после init().

function sidebarShown() {
  const b = document.body;
  return b.classList.contains('m-dl') ? MOB.drawer === 'l' : !b.classList.contains('sidebar-hidden');
}

function notesShown() {
  const b = document.body;
  return b.classList.contains('m-dr') ? MOB.drawer === 'r' : !b.classList.contains('notes-hidden');
}

function applyMobileLayout() {
  const b = document.body;
  if (!b.classList.contains('mob')) return;
  const w = window.innerWidth;
  const tablet = Math.min(window.screen.width, window.screen.height) >= 600;
  const full = tablet || MOB.kbd;
  const dl = !full || w < 720;
  const dr = !full || w < 1000;
  b.classList.toggle('m-tablet', tablet);
  b.classList.toggle('m-kbd', MOB.kbd);
  b.classList.toggle('m-full', full);
  b.classList.toggle('m-compact', !full);
  b.classList.toggle('m-dl', dl);
  b.classList.toggle('m-dr', dr);
  b.classList.toggle('m-narrow', w < 720);
  if (!dl && MOB.drawer === 'l') setDrawer('l', false);
  if (!dr && MOB.drawer === 'r') setDrawer('r', false);
  if (!full && p2.id && typeof closePane2 === 'function') closePane2(); // второй лист на телефоне не нужен
  // Телефон в альбомной ориентации: печатная машинка включается сама, чтобы строка с курсором не пряталась под клавиатурой.
  const land = !full && window.innerWidth > window.innerHeight;
  b.classList.toggle('m-land', land);
  b.classList.toggle('typewriter', twOn());
  setTimeout(() => { updateTwPad(); layoutGoal(); refreshBar(); if (land) recenterNow(); }, 0);
}

function setDrawer(side, open) {
  const b = document.body;
  const next = open ? side : (MOB.drawer === side ? null : MOB.drawer);
  if (next === MOB.drawer) return;
  MOB.drawer = next;
  b.classList.toggle('drawer-l', next === 'l');
  b.classList.toggle('drawer-r', next === 'r');
  if (next) {
    // экранная клавиатура мешала бы панели: прячем её
    const a = document.activeElement;
    if (a && a !== document.body && a.matches && a.matches('input, textarea, [contenteditable="true"]') && !a.closest('#sidebar, #notesbar')) a.blur();
  }
  try { refreshBar(); } catch { /* панель сведений ещё не готова */ }
}

function closeDrawers() { setDrawer(MOB.drawer, false); }

// Системная кнопка «назад»: закрывает то, что открыто сверху. false: закрывать нечего, приложение можно свернуть.
function mobileBack() {
  const dlg = document.querySelector('dialog[open]');
  if (dlg) { dlg.close(); return true; }
  const modal = document.querySelector('.mob-modal');
  if (modal) { modal.dispatchEvent(new Event('mob-cancel')); return true; }
  if (MOB.drawer) { closeDrawers(); return true; }
  const shown = (sel) => { const el = $(sel); return !!el && !el.hidden; };
  if (shown('#board') || shown('#projPop') || shown('#search') || shown('#goalPop') || shown('#cmtPop')
    || anyPanelOpen() || document.body.classList.contains('focus-mode')) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return true;
  }
  return false;
}

// Панель клавиш над экранной клавиатурой: курсив, жирный, тире, кавычки, отмена. Горячих клавиш на телефоне нет.
function wireMobileKeys() {
  const bar = document.createElement('div');
  bar.id = 'mobKeys';
  bar.setAttribute('role', 'toolbar');
  const defs = [
    ['italic', 'К', 'Курсив'], ['bold', 'Ж', 'Жирный'], ['dash', '—', 'Тире'], ['quotes', '«»', 'Кавычки'],
    ['undo', '↶', 'Отменить'], ['redo', '↷', 'Вернуть'], ['hide', '⌄', 'Скрыть клавиатуру'],
  ];
  for (const [id, text, title] of defs) {
    const bt = document.createElement('button');
    bt.type = 'button';
    bt.dataset.k = id;
    bt.textContent = text;
    bt.title = t(title);
    bt.setAttribute('aria-label', t(title));
    bar.append(bt);
  }
  $('#stage').insertBefore(bar, $('#toolbar'));
  bar.addEventListener('mousedown', (e) => e.preventDefault()); // фокус остаётся в тексте, клавиатура не закрывается
  bar.addEventListener('click', (e) => {
    const bt = e.target.closest('button[data-k]');
    if (!bt || !editor || !editor.isEditable) return;
    const c = editor.chain().focus();
    switch (bt.dataset.k) {
      case 'italic': c.toggleItalic().run(); break;
      case 'bold': c.toggleBold().run(); break;
      case 'dash': c.insertContent('—').run(); break;
      case 'undo': c.undo().run(); break;
      case 'redo': c.redo().run(); break;
      case 'hide': if (document.activeElement) document.activeElement.blur(); break;
      case 'quotes': {
        const { from, to } = editor.state.selection;
        if (from === to) { c.insertContent('«»').run(); editor.commands.setTextSelection(from + 1); }
        else c.insertContentAt(to, '»').insertContentAt(from, '«').run();
        break;
      }
      default:
    }
    paintKeys();
  });
  const paintKeys = () => {
    if (!editor) return;
    for (const id of ['italic', 'bold']) bar.querySelector(`[data-k="${id}"]`).classList.toggle('active', editor.isActive(id));
  };
  const inEditor = () => !!document.activeElement && !!document.activeElement.closest && !!document.activeElement.closest('#editor');
  const sync = () => { document.body.classList.toggle('m-typing', inEditor()); if (inEditor()) paintKeys(); };
  document.addEventListener('focusin', sync);
  document.addEventListener('focusout', () => setTimeout(sync, 0));
  document.addEventListener('selectionchange', () => { if (document.body.classList.contains('m-typing')) paintKeys(); });
}

function wireMobile() {
  const b = document.body;
  if (!b.classList.contains('mob')) return;

  $('#btnMenu').hidden = false; // на телефоне нет строки меню: кнопка нужна всегда

  const hw = api.hw || { connected: () => false, onChange: () => {} };
  MOB.kbd = !!hw.connected();
  hw.onChange((v) => { MOB.kbd = !!v; applyMobileLayout(); });

  const scrim = document.createElement('div');
  scrim.id = 'mobScrim';
  scrim.addEventListener('click', closeDrawers);
  b.append(scrim);

  // Свайп вправо открывает левую панель, влево — правую; на открытой панели свайп в сторону её края закрывает.
  let g = null;
  document.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { g = null; return; }
    const p = e.touches[0];
    g = { x: p.clientX, y: p.clientY, t: Date.now(), target: e.target };
  }, { passive: true });
  document.addEventListener('touchcancel', () => { g = null; }, { passive: true });
  document.addEventListener('touchend', (e) => {
    if (!g) return;
    const p = e.changedTouches[0];
    const dx = p.clientX - g.x;
    const dy = p.clientY - g.y;
    const fast = Date.now() - g.t < 800;
    const target = g.target;
    g = null;
    if (!fast || Math.abs(dx) < 64 || Math.abs(dx) < Math.abs(dy) * 1.6) return;
    if (MOB.drawer === 'l') { if (dx < 0) setDrawer('l', false); return; }
    if (MOB.drawer === 'r') { if (dx > 0) setDrawer('r', false); return; }
    if (target && target.closest && target.closest('.panel, #search, #board, #projPop, dialog, .mob-modal, input, select, #menu')) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return; // идёт выделение текста
    if (dx > 0 && b.classList.contains('m-dl')) setDrawer('l', true);
    else if (dx < 0 && b.classList.contains('m-dr')) setDrawer('r', true);
  }, { passive: true });

  // Выбрали главу или карточку в левой панели: панель убирается, чтобы сразу писать.
  $('#sidebar').addEventListener('click', (e) => {
    if (MOB.drawer !== 'l') return;
    if (!e.target.closest('.ch') || e.target.closest('input')) return;
    setTimeout(() => { if (MOB.drawer === 'l') closeDrawers(); }, 160);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && MOB.drawer) {
      e.stopImmediatePropagation();
      closeDrawers();
    }
  }, true);

  wireMobileKeys();
  document.addEventListener('visibilitychange', async () => { // уход в фон: дописываем главу и сразу выгружаем в папку
    if (!document.hidden) return;
    try { await flush(); } catch { /* сохранится позже */ }
    try { await window.kabinetBackend.flushFolder(); } catch { /* папка не подключена */ }
  });
  window.addEventListener('resize', applyMobileLayout);
  window.addEventListener('orientationchange', applyMobileLayout);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', () => { updateTwPad(); if (twOn()) recenterNow(); });
  applyMobileLayout();
  window.kabinetMobile = { back: mobileBack };
  requestAnimationFrame(() => requestAnimationFrame(() => b.classList.add('m-ready')));
}
