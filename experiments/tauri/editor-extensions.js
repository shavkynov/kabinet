import { Typography } from '../../renderer/typo.js';
import { HiddenMarks, refreshMarks } from '../../renderer/marks.js';

const options = { typography: true, marks: false };

export const labExtensions = [
  Typography.configure({ getOptions: () => ({ enabled: options.typography, quotes: true, dashes: true, nbsp: true, lang: 'ru' }) }),
  HiddenMarks.configure({ getOptions: () => ({ on: options.marks, spaces: true }) }),
];

export function installLabControls(editor, toolbar, report) {
  const style = document.createElement('style');
  style.textContent = `
    .mk-para::after { content: '¶'; color: #648bc5; opacity: .7; }
    .mk-sp, .mk-nb, .mk-nn, .mk-th, .mk-em, .mk-tab, .mk-shy, .mk-zw { position: relative; }
    .mk-sp::before { content: '·'; position: absolute; color: #648bc5; pointer-events: none; }
    .mk-nb, .mk-nn, .mk-th, .mk-em { background: #648bc533; }
    .mk-tab { background: #b7780033; }
    .mk-shy, .mk-zw { border-left: 1px dotted #b77800; }
    .mk-br::before { content: '↵'; color: #648bc5; }
  `;
  document.head.append(style);

  function addToggle(label, read, toggle) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.setAttribute('aria-pressed', String(read()));
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', () => {
      try {
        toggle();
        button.setAttribute('aria-pressed', String(read()));
      } catch (error) {
        report(`Ошибка проверки: ${error.message}`);
      }
    });
    toolbar.append(button);
  }

  addToggle('Типографика при наборе', () => options.typography, () => {
    options.typography = !options.typography;
    report(options.typography ? 'Типографика включена для дальнейшего набора.' : 'Типографика выключена. Уже введённый текст не меняется.');
  });

  addToggle('Скрытые символы', () => options.marks, () => {
    const before = editor.storage.markdown.getMarkdown();
    const previous = options.marks;
    options.marks = !previous;
    refreshMarks(editor);
    if (editor.storage.markdown.getMarkdown() !== before) {
      options.marks = previous;
      refreshMarks(editor);
      throw new Error('переключение скрытых символов изменило Markdown');
    }
    report('Скрытые символы переключены; Markdown не изменился.');
  });
}
