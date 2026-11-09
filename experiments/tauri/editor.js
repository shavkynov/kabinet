import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import { Slice, Fragment } from '@tiptap/pm/model';
import { isOfficeHtml, officeTextToParagraphs } from '../../src/paste.js';

const sample = '# Тестовая глава\n\nЭто **жирный** и *курсивный* текст.\n\n— Реплика с тире.\n\nПроверьте ввод, выделение, вставку из Word, отмену и повтор.\n';
const status = document.querySelector('#status');
const markdown = document.querySelector('#markdown');

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
  status.textContent = 'Изменения только в памяти. Записи на диск нет.';
}

const editor = new Editor({
  element: document.querySelector('#editor'),
  extensions: [StarterKit, Markdown.configure({ html: false, tightLists: true, breaks: false, transformPastedText: true })],
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
};
for (const button of document.querySelectorAll('[data-command]')) {
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', () => commands[button.dataset.command]());
}
updatePreview(editor);
