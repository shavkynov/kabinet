// ---------- автоссылки и картинки ----------

let checker = null; // проверка текста (textcheck.js)
let cardIdx = []; // сводка по карточкам: имена, краткая справка, картинка
let lastLinks = null;
let lastMarks = false;
let lastMarksSpaces = false;
const imageCache = new Map();

function getImageUrl(file) {
  if (!imageCache.has(file)) {
    imageCache.set(file, api.readImage(file).catch((err) => { imageCache.delete(file); throw err; }));
  }
  return imageCache.get(file);
}

function applyLinks() {
  for (const ed of [editor, editor2]) {
    if (ed) setNameLinks(ed, settings.links ? cardIdx.filter((c) => kindEnabled(c.kind)) : []);
  }
}

async function refreshIndex() {
  if (!project) {
    cardIdx = [];
  } else {
    try {
      cardIdx = await api.cardIndex();
    } catch (err) {
      console.error('cards index:', err);
    }
  }
  applyLinks();
  try { listCtl('character').render(); } catch { /* списки ещё не созданы */ } // звёздочка у протагониста
}

function openCardById(kind, id) {
  if (kind !== 'character' && kind !== 'place' && kind !== 'item') return;
  expandSection(kind);
  openDoc(kind, id);
}

// Меняем карточку напрямую в файле: при редактировании главы карточка не открыта.
async function modifyCard(card, fn) {
  try {
    const raw = JSON.parse(await api.readItem(card.kind, card.id));
    fn(raw);
    await api.writeItem(card.kind, card.id, JSON.stringify(raw));
    await refreshIndex();
    return true;
  } catch (err) {
    showError(err.message);
    return false;
  }
}

async function bindWord(card, text) {
  const low = text.toLowerCase();
  const ok = await modifyCard(card, (raw) => {
    raw.ignore = (raw.ignore || []).filter((x) => x.toLowerCase() !== low);
    raw.aliases = raw.aliases || [];
    if (low !== card.title.toLowerCase() && !raw.aliases.some((a) => a.toLowerCase() === low)) raw.aliases.push(text);
  });
  if (ok) setStatus('ok', `«${text}» связано с карточкой «${card.title}»`);
}

async function unbindWord(card, word) {
  const low = word.toLowerCase();
  const ok = await modifyCard(card, (raw) => {
    raw.aliases = (raw.aliases || []).filter((a) => a.toLowerCase() !== low);
    raw.ignore = raw.ignore || [];
    if (!raw.ignore.some((x) => x.toLowerCase() === low)) raw.ignore.push(word);
  });
  if (ok) setStatus('ok', `«${word}» больше не считается ссылкой`);
}

// Правый клик в тексте: главный процесс присылает подсказки орфографии, а меню рисуем сами.
// Порядок: исправление слова, замечание проверки текста, ссылки на карточки, обычные команды правки.
function onNativeContext(p) {
  closeMenu();
  const target = document.elementFromPoint(p.x, p.y);
  const inEditor = !!(target && target.closest && target.closest('.ProseMirror')) && editor.isEditable;
  const groups = [];
  const wordTail = []; // нижний блок меню: связать с карточкой / создать карточку

  if (p.misspelledWord) {
    const g = p.suggestions.map((sg) => ({ label: sg, raw: true, onClick: () => api.replaceMisspelling(sg).catch((e) => showError(e.message)) }));
    if (!g.length) g.push({ label: t('Вариантов нет'), disabled: true });
    g.push({
      label: t('Добавить «{0}» в словарь', p.misspelledWord),
      onClick: () => api.addCheckWord(p.misspelledWord).then(() => setStatus('ok', t('«{0}» добавлено в словарь', p.misspelledWord))).catch((e) => showError(e.message)),
    });
    groups.push(g);
  }

  if (inEditor && checker) {
    const d = checker.issueAtPoint(p.x, p.y);
    if (d) {
      const sp = d.spec;
      const g = [{ label: sp.short || sp.message, disabled: true, raw: true }];
      for (const r of sp.replacements.slice(0, 5)) g.push({ label: r === '' ? t('(удалить)') : r, raw: true, onClick: () => checker.applyIssue(sp.id, r) });
      g.push({ label: t('Пропустить'), onClick: () => checker.skipIssue(sp.id) });
      if (sp.kind === 'spelling') g.push({ label: t('В словарь'), onClick: () => checker.addWord(sp.id) });
      else g.push({ label: t('Не проверять такое'), onClick: () => checker.ignoreRule(sp.id) });
      groups.push(g);
    }
  }

  if (inEditor && project) {
    const hits = analysisAt(editor.view, p.x, p.y);
    if (hits.length) {
      groups.push(hits.map((h) => ({
        label: hits.length > 1 ? t('Не отмечать здесь: {0}', t(NAV_NAMES[h.cat])) : t('Не отмечать здесь'),
        onClick: () => addAnalysisSkip(h.cat, h.text),
      })));
    }
  }

  if (inEditor) {
    const g = [];
    const el = settings.links ? target.closest('.name-link') : null;
    if (el) {
      const card = cardIdx.find((c) => c.kind === el.dataset.kind && c.id === el.dataset.card);
      if (card) {
        const word = el.textContent.trim();
        g.push(
          { label: t('Открыть карточку «{0}»', card.title), onClick: () => openCardById(card.kind, card.id) },
          { label: t('Не считать «{0}» ссылкой', word), onClick: () => unbindWord(card, word) },
        );
      }
    }
    // Про выделенное слово: «Связать с…» и «Создать…» собираются в самом низу меню (см. ниже).
    const { from, to, empty } = editor.state.selection;
    const sel = empty ? '' : editor.state.doc.textBetween(from, to, ' ').replace(/\s+/g, ' ').trim();
    if (sel && sel.length <= 80) {
      if (settings.links) {
        for (const [kind, title] of [['character', 'Связать с персонажем'], ['place', 'Связать с местом'], ['item', 'Связать с предметом']].filter(([k]) => kindEnabled(k))) {
          const list = cardIdx.filter((c) => c.kind === kind).slice(0, 60);
          if (!list.length) {
            wordTail.push({ label: t(title), disabled: true });
            continue;
          }
          const sub = list.map((c) => ({ label: `${c.icon ? `${c.icon} ` : ''}${c.title}`, raw: true, onClick: () => bindWord(c, sel) }));
          wordTail.push({ label: t(title), submenu: sub });
        }
      }
      const name = cardNameFromSelection(sel);
      if (name) {
        if (wordTail.length && (kindEnabled('character') || kindEnabled('place') || kindEnabled('item'))) wordTail.push({ separator: true });
        if (kindEnabled('character')) wordTail.push({ label: t('Создать персонажа'), onClick: () => createCardFromText('character', name) });
        if (kindEnabled('place')) wordTail.push({ label: t('Создать место'), onClick: () => createCardFromText('place', name) });
        if (kindEnabled('item')) wordTail.push({ label: t('Создать предмет'), onClick: () => createCardFromText('item', name) });
      }
    }
    if (g.length) groups.push(g);
  }

  if (inEditor) {
    const { from, to, empty } = editor.state.selection;
    const w = empty ? '' : cleanFiller(editor.state.doc.textBetween(from, to, ' '));
    if (w && w.split(' ').length <= 4 && !settings.fillers.includes(w)) {
      const shown = w.length > 28 ? `${w.slice(0, 28)}…` : w;
      groups.push([{ label: t('Добавить «{0}» в слова-паразиты', shown), raw: true, onClick: () => {
        addFiller(w);
        setStatus('ok', t('«{0}» добавлено в слова-паразиты', w));
      } }]);
    }
  }

  const picked = String(p.selectionText || '').replace(/\s+/g, ' ').trim();
  if (picked && picked.length <= 100) {
    const shown = picked.length > 28 ? `${picked.slice(0, 28)}…` : picked;
    groups.push([{ label: t('Искать в интернете: «{0}»', shown), raw: true, onClick: () => api.webSearch(picked, settings.searchEngine).catch((e) => showError(e.message)) }]);
  }

  const f = p.editFlags || {};
  const edit = [];
  if (p.isEditable) edit.push({ label: t('Вырезать'), disabled: !f.canCut, onClick: () => api.editCommand('cut') });
  if (p.isEditable || p.selectionText) edit.push({ label: t('Копировать'), disabled: !f.canCopy, onClick: () => api.editCommand('copy') });
  if (p.isEditable) {
    edit.push({ label: t('Вставить'), disabled: !f.canPaste, onClick: () => api.editCommand('paste') });
    edit.push({ label: t('Выделить всё'), onClick: () => api.editCommand('selectAll') });
  }
  if (edit.length) groups.push(edit);
  if (wordTail.length) groups.push(wordTail);

  const entries = [];
  groups.forEach((g, i) => { if (i) entries.push({ separator: true }); entries.push(...g); });
  if (entries.length) showMenu(p.x, p.y, entries);
}

// Название карточки из выделенного куска: без пробелов и знаков по краям, не длиннее 80 знаков.
function cardNameFromSelection(raw) {
  const w = String(raw || '').replace(/\s+/g, ' ').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').trim();
  return w.length >= 1 && w.length <= 80 ? w : '';
}

// Создаёт карточку персонажа или места прямо из текста. Файл появляется в «Персонажи» или «Места» проекта.
async function createCardFromText(kind, name) {
  if (busy || !project) return;
  const dup = cardIdx.find((c) => c.kind === kind && c.title.toLowerCase() === name.toLowerCase());
  if (dup) {
    setStatus('error', t('Карточка «{0}» уже есть', dup.title));
    return;
  }
  busy = true;
  try {
    await flush();
    const after = indexIn(kind, lastSelected[kind]) >= 0 ? lastSelected[kind] : null;
    const res = await api.addItem(kind, after);
    project = await api.renameItem(kind, res.id, name);
    expandSection(kind);
    refreshLists();
    await refreshIndex();
    setStatus('ok', t(kind === 'place' ? 'Создано место «{0}»' : kind === 'item' ? 'Создан предмет «{0}»' : 'Создан персонаж «{0}»', name));
  } catch (err) {
    showError(err.message);
  } finally {
    busy = false;
  }
}

// Какой звук соответствует клавише. Сочетания с Cmd/Ctrl/Option и стрелки звука не дают.
function playKeySound(e, force) {
  if ((!force && !editor.isEditable) || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
  if (e.key === 'Enter') sounds.play('enter');
  else if (e.key === 'Backspace' || e.key === 'Delete') sounds.play('backspace');
  else if (e.key === ' ') sounds.play('space');
  else if (e.key.length === 1) sounds.play('key');
}

function getMarkdown() {
  return editor.storage.markdown.getMarkdown();
}

// Подставляет текст главы так, чтобы он не считался правкой и не попадал в историю отмены.
function setEditorContent(markdown, editable) {
  loading = true;
  try {
    editor
      .chain()
      .command(({ tr }) => {
        tr.setMeta('addToHistory', false);
        return true;
      })
      .setContent(markdown, false)
      .run();
    editor.setEditable(editable, false);
  } finally {
    loading = false;
  }
  $('#paper-area').scrollTop = 0;
  updateToolbar();
  updateCounts(false); // новый текст: пересчёт без сигнала о цели
}

