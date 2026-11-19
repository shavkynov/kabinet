// ---------- режим «только лист» и панель настроек ----------

const PANELS = {
  text: ['#settings', '#btnSettings'],
  sound: ['#soundPanel', '#btnSound'],
  check: ['#checkPanel', '#btnCheck'],
  typing: ['#typingPanel', '#btnTyping'],
  style: ['#stylePanel', '#btnStyle'],
};

function anyPanelOpen() {
  return Object.values(PANELS).some(([panel]) => !$(panel).hidden);
}

function closePanels() {
  const inside = Object.values(PANELS).some(([panel]) => $(panel).contains(document.activeElement));
  for (const [panel, btn] of Object.values(PANELS)) {
    $(panel).hidden = true;
    $(btn).classList.remove('on');
  }
  // Фокус не должен пропасть вместе с панелью: возвращаем его в текст.
  if (inside && editor && editor.isEditable && currentId && isTextKind(currentKind)) editor.commands.focus();
}

function openPanel(name) {
  if (!project) return;
  closePanels();
  const [panel, btn] = PANELS[name];
  $(panel).hidden = false;
  $(btn).classList.add('on');
  if (name === 'check' && checker) checker.open();
  // Клавиатура сразу работает внутри открытой панели (Tab, стрелки, пробел). Список замечаний не трогаем: там правят текст.
  if (name !== 'check') {
    const first = $(panel).querySelector('input:not([disabled]), select:not([disabled]), button:not([disabled])');
    if (first) first.focus({ preventScroll: true });
  }
}

function togglePanel(name) {
  if ($(PANELS[name][0]).hidden) openPanel(name);
  else closePanels();
}

// Кнопки «Панель глав» и «Панель справа» ездят вместе с краем своей панели (см. style.css). Правой кнопке нужно знать,
// сколько места занимают остальные значки справа: меряем их и кладём ширину в --tools-w.
function wireChromeLayout() {
  const box = $('#chromeRight');
  if (!box || typeof ResizeObserver === 'undefined') return;
  const set = () => document.documentElement.style.setProperty('--tools-w', `${Math.ceil(box.getBoundingClientRect().width)}px`);
  new ResizeObserver(set).observe(box);
  set();
}
wireChromeLayout();

// Узкое окно: боковые панели не сжимают лист, а выезжают поверх него; клик по листу их убирает.
const NARROW_W = 900;
function wireNarrowLayout() {
  const b = document.body;
  const hideSides = () => {
    b.classList.add('sidebar-hidden', 'notes-hidden');
    refreshBar();
  };
  const apply = () => {
    if (b.classList.contains('mob')) return;
    const narrow = window.innerWidth < NARROW_W;
    if (narrow === b.classList.contains('narrow')) return;
    b.classList.toggle('narrow', narrow);
    if (narrow) {
      hideSides();
    } else {
      let sh = false; let nh = false;
      try { sh = localStorage.getItem('kabinet.sidebarHidden') === '1'; nh = localStorage.getItem('kabinet.notesHidden') === '1'; } catch { /* ignore */ }
      b.classList.toggle('sidebar-hidden', sh);
      b.classList.toggle('notes-hidden', nh);
      refreshBar();
    }
    setTimeout(() => { updateTwPad(); layoutGoal(); }, 0);
  };
  window.addEventListener('resize', apply);
  apply();
  $('#stage').addEventListener('mousedown', () => {
    if (b.classList.contains('narrow') && (!b.classList.contains('sidebar-hidden') || !b.classList.contains('notes-hidden'))) hideSides();
  });
}

const openSettings = () => openPanel('text');
const closeSettings = closePanels;
const toggleSettings = () => togglePanel('text');

// Клик по самому листу, вне строк текста (поля, пустое место сверху и снизу в режиме «Машинка»), ставит курсор в текст:
// выше текста в начало, ниже в конец, сбоку в ближайшее место строки. Полосу прокрутки и поля ввода не трогаем.
function wireSheetClick() {
  const area = $('#paper-area');
  area.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !editor || !editor.isEditable || document.body.classList.contains('card-open')) return;
    if (e.target.closest('.ProseMirror, input, textarea, select, button, a, #cardView')) return;
    const r = area.getBoundingClientRect();
    if (e.clientX > r.left + area.clientWidth || e.clientY > r.top + area.clientHeight) return; // полоса прокрутки
    const box = editor.view.dom.getBoundingClientRect();
    e.preventDefault();
    if (e.clientY >= box.bottom) { editor.commands.focus('end'); return; }
    if (e.clientY <= box.top) { editor.commands.focus('start'); return; }
    const hit = editor.view.posAtCoords({ left: Math.min(Math.max(e.clientX, box.left + 1), box.right - 1), top: e.clientY });
    if (hit) editor.chain().focus().setTextSelection(hit.pos).run();
    else editor.commands.focus('end');
  });
}


// Пока вы печатаете, кнопки по краям окна гаснут; вернутся от движения мыши. Открытая панель не гаснет.
function wireChromeFade() {
  const b = document.body;
  const show = () => b.classList.remove('typing');
  document.addEventListener('keydown', (e) => {
    if (!settings.chromeFade || anyPanelOpen() || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key.length !== 1 && e.key !== 'Backspace' && e.key !== 'Enter') return;
    if (e.target.closest && e.target.closest('.ProseMirror')) b.classList.add('typing');
  }, true);
  let lx = -1; let ly = -1;
  document.addEventListener('mousemove', (e) => {
    if (Math.abs(e.clientX - lx) + Math.abs(e.clientY - ly) > 3) show();
    lx = e.clientX; ly = e.clientY;
  });
  document.addEventListener('mousedown', show);
}
