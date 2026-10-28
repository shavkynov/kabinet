// ---------- вторая панель: другая глава рядом ----------

let editor2 = null;
const p2 = { id: null, dirty: false, timer: null, token: 0, loading: false };

function initEditor2() {
  editor2 = new Editor({
    element: $('#editor2'),
    extensions: [
      StarterKit,
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
  if (!p2.dirty || !p2.id) return;
  const id = p2.id;
  const text = pane2Markdown();
  p2.dirty = false;
  try {
    const res = await api.writeChapter(id, text);
    setStatus('ok', 'Сохранено');
    noteSyncConflict(res);
    refreshTotals();
  } catch (err) {
    p2.dirty = true;
    setStatus('error', 'Не удалось сохранить вторую панель! Повтор через 3 с…');
    clearTimeout(p2.timer);
    p2.timer = setTimeout(flushPane2, 3000);
    console.error('pane2 save failed:', err);
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
  setTimeout(() => { updateTwPad(); layoutGoal(); }, 0);
  refreshBar();
}

async function openPane2(id) {
  if (!project || !id) return;
  if (id === currentId && currentKind === 'chapter') {
    setStatus('ok', 'Эта глава уже открыта слева');
    fillP2Select();
    return;
  }
  const token = ++p2.token;
  await flushPane2();
  if (token !== p2.token) return;
  try {
    const text = await api.readChapter(id);
    if (token !== p2.token) return;
    p2.id = id;
    p2.loading = true;
    try {
      editor2
        .chain()
        .command(({ tr }) => { tr.setMeta('addToHistory', false); return true; })
        .setContent(text, false)
        .run();
      editor2.setEditable(true, false);
    } finally {
      p2.loading = false;
    }
    showPane2(true);
    fillP2Select();
    $('#p2Scroll').scrollTop = 0;
  } catch (err) {
    showError(err.message);
  }
}

async function closePane2() {
  p2.token += 1;
  await flushPane2();
  resetPane2();
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

function toggleSplit() {
  if (!project) return;
  if (p2.id) {
    closePane2();
    return;
  }
  const list = itemsOf('chapter');
  const i = indexIn('chapter', currentKind === 'chapter' ? currentId : lastSelected.chapter);
  const other = list[i + 1] || list[i - 1] || list.find((c) => c.id !== currentId);
  if (!other || (other.id === currentId && currentKind === 'chapter')) {
    setStatus('ok', 'Для второй панели нужна ещё одна глава');
    return;
  }
  openPane2(other.id);
}

