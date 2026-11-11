import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import { Slice, Fragment } from '@tiptap/pm/model';
import { isOfficeHtml, officeTextToParagraphs } from '../../src/paste.js';
import { labExtensions, installLabControls } from './editor-extensions.js';
import { AlignParagraph, toggleAlign } from '../../renderer/align.js';
import { installRoundtripLab } from './roundtrip-lab.js';

const sample = '# Тестовая глава\n\nЭто **жирный** и *курсивный* текст.\n\n— Реплика с тире.\n\nНеразрывный\u00a0пробел и обычный пробел.\n\nПроверьте ввод, выделение, вставку из Word, отмену и повтор.\n\n-> По центру <-\n\n-> Справа ->\n\nПосле этого абзаца две пустые строки.\n\n\n\nИ этот абзац идёт после них.\n';
const status = document.querySelector('#status');
const markdown = document.querySelector('#markdown');
const report = (message) => { status.textContent = `${message} Только в памяти, на диск не записано.`; };

function handleOfficePaste(view, event) {
  const cd = event.clipboardData;
  if (!cd || !view.editable || !isOfficeHtml(cd.getData('text/html'))) return false;
  const paragraphs = officeTextToParagraphs(cd.getData('text/plain'));
  if (!paragraphs.length) return false;
  const nodes = paragraphs.map((text) => view.state.schema.nodes.paragraph.create(null, view.state.schema.text(text)));
  event.preventDefault();
  view.dispatch(view.state.tr.replaceSelection(new Slice(Fragment.from(nodes), 1, 1)).scrollIntoView().setMeta('paste', true).setMeta('uiEvent', 'paste'));
  return true;
}

function updatePreview(instance) {
  markdown.textContent = instance.storage.markdown.getMarkdown();
  report('Тестовый текст изменён.');
}

// Набор расширений тот же, что у основного редактора (renderer/app/03-editor.js): абзац с выравниванием вместо абзаца StarterKit.
export const editorExtensions = () => [
  StarterKit.configure({ paragraph: false }),
  AlignParagraph,
  ...labExtensions,
  Markdown.configure({ html: false, tightLists: true, breaks: false, transformPastedText: true }),
];

const editor = new Editor({
  element: document.querySelector('#editor'),
  extensions: editorExtensions(),
  content: sample,
  editorProps: {
    handlePaste: handleOfficePaste,
    attributes: { role: 'textbox', 'aria-label': 'Тестовый текст главы', 'aria-multiline': 'true' },
  },
  onUpdate: ({ editor: instance }) => updatePreview(instance),
});

const commands = {
  bold: () => editor.chain().focus().toggleBold().run(),
  italic: () => editor.chain().focus().toggleItalic().run(),
  undo: () => editor.chain().focus().undo().run(),
  redo: () => editor.chain().focus().redo().run(),
  alignCenter: () => toggleAlign(editor, editor.chain().focus(), 'center').run(),
  alignRight: () => toggleAlign(editor, editor.chain().focus(), 'right').run(),
};
for (const button of document.querySelectorAll('[data-command]')) {
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', () => commands[button.dataset.command]());
}
installLabControls(editor, document.querySelector('#toolbar'), report);
installRoundtripLab(editor, document.querySelector('#toolbar'), report, editorExtensions);
updatePreview(editor);
