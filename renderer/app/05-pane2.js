// ---------- вторая панель: другая глава рядом ----------

let editor2 = null;
const p2 = { id: null, dirty: false, timer: null, token: 0, loading: false };

function initEditor2() {
  editor2 = new Editor({
    element: $('#editor2'),
    extensions: [
      StarterKit.configure({ paragraph: false, horizontalRule: false }),
      AlignParagraph,
      KabinetRule,
      NameLinks,
      Markdown.configure({ html: false, tightLists: true, breaks: false, transformPastedText: true }),
    ],
    content: '',
    editable: false,
    editorProps: { handlePaste: handleOfficePaste, clipboardTextSerializer: clipboardText },
    onUpdate: () => {
      if (p2.loading || !p2.id) return;
      p2.dirty = true;
      clearTimeout(p2.timer);
      p2.timer = setTimeout(flushPane2, SAVE_DELAY_MS);
    },
  });
  editor2.view.dom.addEventListener('keydown', (e) => playKeySound(e, true));
  wireLinkHover({
    dom: editor2.view.dom,
    pop: $('#linkPop'),
    scroller: $('#p2Scroll'),
    getCard: (kind, id) => cardIdx.find((c) => c.kind === kind && c.id === id),
    getImageUrl,
    isEnabled: () => settings.links,
    onOpen: (kind, id) => openCardById(kind, id),
  });
  $('#p2Close').addEventListener('click', closePane2);
  $('#p2Select').addEventListener('change', (e) => {
    const id = e.target.value;
    if (id && id !== p2.id) openPane2(id);
    else fillP2Select();
  });
}

function pane2Markdown() {
  return editor2.storage.markdown.getMarkdown();
}

async function flushPane2() {
  clearTimeout(p2.timer);
  p2.timer = null;
  if (!p2.dirty || !p2.id) return true;
  const id = p2.id;
  const text = pane2Markdown();
  p2.dirty = false;
  try {
    const res = await api.writeChapter(id, text);
    noteSaved('pane2');
    noteSyncConflict(res);
    refreshTotals();
    return true;
  } catch (err) {
    p2.dirty = true;
    noteSaveFailed('pane2');
    setStatus('error', 'Не удалось сохранить вторую панель! Повтор через 3 с…');
    clearTimeout(p2.timer);
    p2.timer = setTimeout(flushPane2, 3000);
    console.error('pane2 save failed:', err);
    return false;
  }
}

function fillP2Select() {
  const sel = $('#p2Select');
  if (!sel) return;
  sel.setAttribute('translate', 'no');
  sel.textContent = '';
  itemsOf('chapter').forEach((c, i) => {
    sel.append(new Option(`${i + 1}. ${c.title}`, c.id));
  });
  if (p2.id) sel.value = p2.id;
}

function showPane2(on) {
  $('#canvas').classList.toggle('split', on);
  $('#pane2').hidden = !on;
  refreshSheetBar();
  setTimeout(() => { updateTwPad(); layoutGoal(); }, 0);
  refreshBar();
}

// keepView: перечитать ту же главу, не сбрасывая лист в начало.
async function openPane2(id, keepView) {
  if (!project || !id) return;
  if (id === currentId && currentKind === 'chapter') {
    setStatus('ok', 'Эта глава уже открыта слева');
    fillP2Select();
    return;
  }
  const token = ++p2.token;
  if (!(await flushPane2())) { // прежняя глава не записана: не заменяем её текст другим
    fillP2Select();
    return false;
  }
  if (token !== p2.token) return;
  try {
    const text = await api.readChapter(id);
    if (token !== p2.token) return;
    const top = $('#p2Scroll').scrollTop;
    const sel = keepView ? editor2.state.selection : null;
    p2.id = id;
    p2.loading = true;
    try {
      editor2
        .chain()
        .command(({ tr }) => { tr.setMeta('addToHistory', false); return true; })
        .setContent(text, false)
        .run();
      editor2.setEditable(true, false);
      if (sel) editor2.commands.setTextSelection({ from: sel.from, to: sel.to });
    } finally {
      p2.loading = false;
    }
    showPane2(true);
    fillP2Select();
    $('#p2Scroll').scrollTop = keepView ? top : 0;
    return true;
  } catch (err) {
    showError(err.message);
    return false;
  }
}

// Закрывает второй лист. Если запись не удалась, лист остаётся открытым: текст на экране, повтор записи идёт.
// Возвращает true, когда лист закрыт, и false, когда закрытие отложено из-за сбоя.
async function closePane2() {
  p2.token += 1;
  if (!(await flushPane2())) return false;
  resetPane2();
  return true;
}

// Закрывает панель без записи (запись уже сделана или не нужна).
function resetPane2() {
  p2.token += 1;
  clearTimeout(p2.timer);
  p2.id = null;
  p2.dirty = false;
  if (editor2) {
    p2.loading = true;
    try {
      editor2.commands.setContent('', false);
      editor2.setEditable(false, false);
    } finally {
      p2.loading = false;
    }
  }
  showPane2(false);
}

// «Рядом» сразу включает и «Только лист»: экран делится между двумя листами, а выбор глав живёт в меню вверху.
function toggleSplit() {
  if (!project) return;
  if (p2.id) {
    if (document.body.classList.contains('focus-mode')) toggleFocusMode(false); // выход из «Только лист» закрывает и второй лист
    else closePane2();
    return;
  }
  const list = itemsOf('chapter');
  const i = indexIn('chapter', currentKind === 'chapter' ? currentId : lastSelected.chapter);
  const other = list[i + 1] || list[i - 1] || list.find((c) => c.id !== currentId);
  if (!other || (other.id === currentId && currentKind === 'chapter')) {
    setStatus('ok', 'Для второй панели нужна ещё одна глава');
    return;
  }
  if (!document.body.classList.contains('focus-mode')) toggleFocusMode(true);
  openPane2(other.id);
}

// ---------- меню выбора листов вверху ----------

function refreshSheetBar() {
  const bar = $('#sheetBar');
  if (!bar) return;
  bar.hidden = !p2.id;
  if (!p2.id) { closeSheetMenu(); return; }
  const list = itemsOf('chapter');
  const label = (id) => {
    const i = list.findIndex((c) => c.id === id);
    return i < 0 ? t('Выбрать главу') : `${i + 1}. ${list[i].title}`;
  };
  for (const [sel, id] of [['#sheetL', currentKind === 'chapter' ? currentId : null], ['#sheetR', p2.id]]) {
    const b = $(sel);
    b.setAttribute('translate', 'no');
    b.textContent = '';
    const tx = document.createElement('span');
    tx.className = 'sp-t';
    tx.textContent = label(id);
    b.append(tx, Object.assign(document.createElement('span'), { className: 'sp-c', textContent: '▾' }));
  }
}

function closeSheetMenu() {
  const m = $('#sheetMenu');
  if (m.hidden) return;
  m.hidden = true;
  m.textContent = '';
  document.querySelectorAll('.sheet-pick.open').forEach((b) => b.classList.remove('open'));
}

function openSheetMenu(side) {
  if (!project || !p2.id) return;
  const menu = $('#sheetMenu');
  const btn = $(side === 'L' ? '#sheetL' : '#sheetR');
  if (!menu.hidden && btn.classList.contains('open')) { closeSheetMenu(); return; }
  closeSheetMenu();
  const mine = side === 'L' ? (currentKind === 'chapter' ? currentId : null) : p2.id;
  const other = side === 'L' ? p2.id : (currentKind === 'chapter' ? currentId : null);
  menu.setAttribute('translate', 'no');
  itemsOf('chapter').forEach((c, i) => {
    const it = document.createElement('button');
    it.type = 'button';
    it.className = 'sm-item';
    it.setAttribute('role', 'option');
    it.dataset.id = c.id;
    it.classList.toggle('cur', c.id === mine);
    it.disabled = c.id === other; // эта глава уже на соседнем листе
    it.append(Object.assign(document.createElement('span'), { className: 'sm-n', textContent: String(i + 1) }), Object.assign(document.createElement('span'), { className: 'sm-t', textContent: c.title }));
    menu.append(it);
  });
  menu.hidden = false;
  btn.classList.add('open');
  const cv = $('#canvas').getBoundingClientRect();
  const r = btn.getBoundingClientRect();
  const w = Math.min(320, cv.width / 2 - 16);
  menu.style.width = `${w}px`;
  menu.style.left = `${Math.max(8, Math.min(r.left + r.width / 2 - cv.left - w / 2, cv.width - w - 8))}px`;
  menu.style.top = `${r.bottom - cv.top + 2}px`;
  const cur = menu.querySelector('.cur') || menu.querySelector('.sm-item:not(:disabled)');
  if (cur) { cur.scrollIntoView({ block: 'center' }); cur.focus({ preventScroll: true }); }
  menu.dataset.side = side;
}

function wireSheetBar() {
  $('#sheetL').addEventListener('click', () => openSheetMenu('L'));
  $('#sheetR').addEventListener('click', () => openSheetMenu('R'));
  $('#sheetX').addEventListener('click', toggleSplit);
  const menu = $('#sheetMenu');
  menu.addEventListener('click', async (e) => {
    const it = e.target.closest('.sm-item');
    if (!it || it.disabled) return;
    const side = menu.dataset.side;
    closeSheetMenu();
    if (side === 'L') {
      if (currentKind === 'chapter' && currentId === it.dataset.id) return;
      await openDoc('chapter', it.dataset.id);
    } else if (it.dataset.id !== p2.id) {
      await openPane2(it.dataset.id);
    }
    refreshSheetBar();
  });
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); const side = menu.dataset.side; closeSheetMenu(); $(side === 'L' ? '#sheetL' : '#sheetR').focus(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...menu.querySelectorAll('.sm-item:not(:disabled)')];
    const i = items.indexOf(document.activeElement);
    const next = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
    if (next) next.focus();
  });
  document.addEventListener('mousedown', (e) => {
    if (menu.hidden || e.target.closest('#sheetMenu') || e.target.closest('.sheet-pick')) return;
    closeSheetMenu();
  });
}

