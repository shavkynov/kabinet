// ---------- режим «только лист» и панель настроек ----------

const PANELS = {
  text: ['#settings', '#btnSettings'],
  sound: ['#soundPanel', '#btnSound'],
  check: ['#checkPanel', '#btnCheck'],
  typing: ['#typingPanel', '#btnTyping'],
};

function anyPanelOpen() {
  return Object.values(PANELS).some(([panel]) => !$(panel).hidden);
}

function closePanels() {
  for (const [panel, btn] of Object.values(PANELS)) {
    $(panel).hidden = true;
    $(btn).classList.remove('on');
  }
}

function openPanel(name) {
  if (!project) return;
  closePanels();
  const [panel, btn] = PANELS[name];
  $(panel).hidden = false;
  $(btn).classList.add('on');
  if (name === 'check' && checker) checker.open();
}

function togglePanel(name) {
  if ($(PANELS[name][0]).hidden) openPanel(name);
  else closePanels();
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

