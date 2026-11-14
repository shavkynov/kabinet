import { Editor } from '@tiptap/core';

// Диагностика круга «документ -> Markdown -> новый редактор -> Markdown» на тексте, который сейчас в окне.
// Ничего не меняет и не сохраняет: второй редактор создаётся вне страницы и сразу уничтожается.
export function installRoundtripLab(editor, toolbar, report, makeExtensions) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Проверить круг Markdown';
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', () => {
    let copy;
    try {
      const first = editor.storage.markdown.getMarkdown();
      copy = new Editor({ element: document.createElement('div'), extensions: makeExtensions(), content: first });
      const second = copy.storage.markdown.getMarkdown();
      const empties = (e) => e.getJSON().content.filter((n) => n.type === 'paragraph' && !(n.content && n.content.length)).length;
      const aligned = (e) => e.getJSON().content.filter((n) => n.attrs && n.attrs.textAlign).length;
      const same = first === second && empties(editor) === empties(copy) && aligned(editor) === aligned(copy);
      report(same
        ? `Круг Markdown сошёлся: пустых абзацев ${empties(copy)}, выровненных ${aligned(copy)}.`
        : `Круг Markdown НЕ сошёлся: пустых ${empties(editor)} -> ${empties(copy)}, выровненных ${aligned(editor)} -> ${aligned(copy)}, Markdown ${first === second ? 'тот же' : 'другой'}.`);
    } catch (error) {
      report(`Ошибка проверки круга: ${error.message}`);
    } finally {
      if (copy) copy.destroy();
    }
  });
  toolbar.append(button);
}
