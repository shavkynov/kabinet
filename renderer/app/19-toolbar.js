// ---------- панель форматирования ----------

const TOOLBAR = {
  bold: { active: () => editor.isActive('bold'), run: (c) => c.toggleBold() },
  italic: { active: () => editor.isActive('italic'), run: (c) => c.toggleItalic() },
  h1: { active: () => editor.isActive('heading', { level: 1 }), run: (c) => c.toggleHeading({ level: 1 }) },
  h2: { active: () => editor.isActive('heading', { level: 2 }), run: (c) => c.toggleHeading({ level: 2 }) },
  quote: { active: () => editor.isActive('blockquote'), run: (c) => c.toggleBlockquote() },
  bullet: { active: () => editor.isActive('bulletList'), run: (c) => c.toggleBulletList() },
  ordered: { active: () => editor.isActive('orderedList'), run: (c) => c.toggleOrderedList() },
  rule: { active: () => false, run: (c) => c.setHorizontalRule() },
};

function wireToolbar() {
  const group = $('#fmtGroup');
  // не отбираем фокус у текста при нажатии на кнопки
  group.addEventListener('mousedown', (e) => e.preventDefault());
  group.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-cmd]');
    if (!btn || !editor || !editor.isEditable) return;
    const def = TOOLBAR[btn.dataset.cmd];
    if (def) def.run(editor.chain().focus()).run();
  });

  const bar = $('#toolbar');
  bar.addEventListener('mousedown', (e) => e.preventDefault());
  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn || !project) return;
    switch (btn.dataset.act) {
      case 'typewriter': toggleTypewriter(); break;
      case 'sound': toggleSound(); break;
      case 'ambient': toggleAmbient(); break;
      case 'notes': applyNotesHidden(!document.body.classList.contains('notes-hidden')); break;
      case 'focus': toggleFocusMode(); break;
      case 'split': toggleSplit(); break;
      default:
    }
  });
}

function updateToolbar() {
  if (!editor) return;
  const group = $('#fmtGroup');
  group.classList.toggle('disabled', !editor.isEditable);
  group.querySelectorAll('button[data-cmd]').forEach((b) => {
    const def = TOOLBAR[b.dataset.cmd];
    b.classList.toggle('active', !!def && editor.isEditable && def.active());
  });
}

