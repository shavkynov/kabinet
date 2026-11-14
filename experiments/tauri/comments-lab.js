import { addCommentRange, removeCommentRange, commentRanges } from '../../renderer/comments.js';

export function installCommentsLab(editor, toolbar, report) {
  const records = new Map();
  let sequence = 0;
  const panel = document.createElement('section');
  panel.setAttribute('aria-label', 'Тестовые комментарии');
  const heading = document.createElement('h2');
  heading.textContent = 'Комментарии — только в памяти';
  const label = document.createElement('label');
  label.textContent = 'Выделите текст в редакторе и напишите комментарий';
  const input = document.createElement('textarea');
  input.id = 'lab-comment-text';
  input.maxLength = 5000;
  input.rows = 3;
  label.htmlFor = input.id;
  const add = document.createElement('button');
  add.type = 'button';
  add.textContent = 'Добавить к выделению';
  const list = document.createElement('ul');
  panel.append(heading, label, input, add, list);
  toolbar.after(panel);

  function unchanged(action) {
    const before = editor.storage.markdown.getMarkdown();
    action();
    if (editor.storage.markdown.getMarkdown() !== before) throw new Error('операция с комментарием изменила Markdown');
  }

  function render() {
    const ranges = commentRanges(editor.state);
    list.replaceChildren();
    for (const [id, record] of records) {
      const li = document.createElement('li');
      const text = document.createElement('p');
      text.textContent = record.text;
      const anchor = document.createElement('p');
      const range = ranges[id];
      anchor.textContent = range
        ? `Фрагмент: ${editor.state.doc.textBetween(range.from, range.to, ' ').slice(0, 200)}`
        : `Привязка потеряна. Исходная цитата: ${record.quote}`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Удалить комментарий';
      remove.addEventListener('click', () => {
        try {
          unchanged(() => removeCommentRange(editor, id));
          records.delete(id);
          render();
          report('Комментарий удалён; Markdown не изменился.');
        } catch (error) { report(`Ошибка проверки: ${error.message}`); }
      });
      li.append(text, anchor, remove);
      list.append(li);
    }
  }

  add.addEventListener('mousedown', (event) => event.preventDefault());
  add.addEventListener('click', () => {
    const { from, to, empty } = editor.state.selection;
    const text = input.value.trim();
    if (empty || !editor.state.doc.textBetween(from, to, ' ').trim()) {
      report('Сначала выделите непустой фрагмент текста.');
      return;
    }
    if (!text) { report('Введите текст комментария.'); return; }
    if (records.size >= 20) { report('В стенде допускается до 20 тестовых комментариев.'); return; }
    const id = `lab-${++sequence}`;
    const quote = editor.state.doc.textBetween(from, to, ' ').slice(0, 200);
    try {
      unchanged(() => addCommentRange(editor, { id, from, to }));
      records.set(id, { text, quote });
      input.value = '';
      render();
      report('Комментарий добавлен; Markdown не изменился.');
    } catch (error) { report(`Ошибка проверки: ${error.message}`); }
  });
  editor.on('transaction', render);
  editor.on('destroy', () => { records.clear(); panel.remove(); });
  render();
}
