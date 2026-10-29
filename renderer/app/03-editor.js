// ---------- редактор ----------

// Вставка из Word и других офисных программ: абзац на строку, тире сохраняются (см. src/paste.js).
function handleOfficePaste(view, event) {
  const cd = event.clipboardData;
  if (!cd || !view.editable || !isOfficeHtml(cd.getData('text/html'))) return false;
  const paragraphs = officeTextToParagraphs(cd.getData('text/plain'));
  if (!paragraphs.length) return false;
  const { schema } = view.state;
  const nodes = paragraphs.map((p) => schema.nodes.paragraph.create(null, schema.text(p)));
  event.preventDefault();
  view.dispatch(view.state.tr.replaceSelection(new Slice(Fragment.from(nodes), 1, 1)).scrollIntoView().setMeta('paste', true).setMeta('uiEvent', 'paste'));
  return true;
}

// Копирование как обычный текст (см. src/clip.js): разделитель уходит строкой «***» (в окне он нарисован так же), а в режиме
// «Красная строка» перед абзацами ставится длинный пробел, чтобы отступ дошёл до сайта. Сам текст главы при этом не меняется.
function clipboardText(slice, view) {
  const leaf = (node) => {
    if (node.type.name === 'hardBreak') return '\n';
    const f = node.type.spec.leafText;
    return f ? f(node) : '';
  };
  const blocks = [];
  slice.content.forEach((child, _offset, i) => {
    const name = child.type.name;
    const text = child.textBetween(0, child.content.size, '\n\n', leaf);
    const kind = name === 'paragraph' ? 'paragraph' : name === 'heading' ? 'heading' : name === 'blockquote' ? 'quote' : name === 'horizontalRule' ? 'rule' : 'other';
    // первый абзац взят не с начала, если выделение началось посреди него (слайс при этом «открыт» с начала)
    const partial = i === 0 && slice.openStart > 0 && !(view && view.state && view.state.selection.$from.parentOffset === 0);
    blocks.push({ kind, text, partial });
  });
  return clipboardPlain(blocks, { indent: settings.para === 'indent' });
}

function initEditor() {
  editor = new Editor({
    element: $('#editor'),
    extensions: [
      StarterKit,
      NameLinks,
      Comments,
      TypeAnim.configure({ isEnabled: () => settings.typeAnim }),
      HiddenMarks.configure({ getOptions: () => ({ on: settings.marks, spaces: settings.marksSpaces }) }),
      Typography.configure({ getOptions: () => ({ enabled: settings.typo, quotes: true, dashes: true, nbsp: settings.typoNbsp, lang: LANG }) }),
      LangIssues.configure({ onChange: () => { if (checker) checker.scheduleRender(); } }),
      TextAnalysis.configure({ getConfig: () => ({ cats: settings.an, longMin: settings.anLongMin, fillers: settings.fillers, fillerSkipSpeech: settings.fillerSkipSpeech, repeatWin: settings.anRepeatWin, tenseMode: settings.tenseMode, skip: project ? project.analysisSkip : null }), onStats: showAnalysisStats }),
      Markdown.configure({ html: false, tightLists: true, breaks: false, transformPastedText: true }),
    ],
    content: '',
    editable: false,
    editorProps: { handlePaste: handleOfficePaste, clipboardTextSerializer: clipboardText },
    onUpdate: () => {
      scheduleTense();
      scheduleRhythm();
      scheduleCommentRefresh();
      if (loading || !currentId || !isTextKind(currentKind)) return;
      markDirty();
      scheduleCenter();
      scheduleCount();
    },
    onSelectionUpdate: () => { scheduleCenter(); updateSelectionInfo(); updateCommentButton(); },
    onTransaction: () => { updateToolbar(); },
  });

  // Строка держится по центру только пока пользователь печатает или двигает курсор клавишами.
  // Клик мышью в любое место текста лист не двигает.
  editor.view.dom.addEventListener('keydown', (e) => {
    followCaret = true;
    playKeySound(e);
  });
  editor.view.dom.addEventListener('mousedown', () => { followCaret = false; });
  wireLinkHover({
    dom: editor.view.dom,
    pop: $('#linkPop'),
    scroller: $('#paper-area'),
    getCard: (kind, id) => cardIdx.find((c) => c.kind === kind && c.id === id),
    getImageUrl,
    isEnabled: () => settings.links && !document.body.classList.contains('card-open'),
    onOpen: (kind, id) => openCardById(kind, id),
  });
}

