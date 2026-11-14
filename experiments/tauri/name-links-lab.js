import { setNameLinks } from '../../renderer/links.js';

const cards = [
  { kind: 'character', id: 'lab-character', title: 'Александр', aliases: ['Саша'], forms: ['Александра', 'Александру'], short: 'Вымышленный персонаж для проверки автоссылок. Это не данные проекта.' },
  { kind: 'place', id: 'lab-place', title: 'Старая башня', aliases: [], forms: ['Старой башни'], short: 'Вымышленное место для проверки многословных названий.' },
];

export function installNameLinksLab(editor, toolbar, report) {
  let enabled = false;
  const panel = document.createElement('section');
  panel.setAttribute('aria-label', 'Тестовые ссылки на карточки');
  const heading = document.createElement('h2');
  heading.textContent = 'Автоссылки — тестовые карточки';
  const help = document.createElement('p');
  help.textContent = 'Наберите: Александр, Саша, Александру, Старая башня, Старой башни. Ctrl/⌘-клик по подсветке открывает справку ниже. Кнопки карточек доступны с клавиатуры.';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.textContent = 'Подсветка тестовых имён';
  toggle.setAttribute('aria-pressed', 'false');
  const list = document.createElement('div');
  const summary = document.createElement('p');
  summary.setAttribute('aria-live', 'polite');
  summary.textContent = 'Карточка не выбрана.';
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Закрыть справку';
  close.addEventListener('click', () => { summary.textContent = 'Карточка не выбрана.'; });

  function open(kind, id) {
    const card = cards.find((c) => c.kind === kind && c.id === id);
    if (!card) { report('Тестовая карточка не найдена.'); return; }
    summary.textContent = `${card.title}: ${card.short}`;
  }

  for (const card of cards) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `Справка: ${card.title}`;
    button.addEventListener('click', () => open(card.kind, card.id));
    list.append(button);
  }
  panel.append(heading, help, toggle, list, summary, close);
  toolbar.after(panel);

  toggle.addEventListener('mousedown', (event) => event.preventDefault());
  toggle.addEventListener('click', () => {
    const before = editor.storage.markdown.getMarkdown();
    const selection = JSON.stringify(editor.state.selection.toJSON());
    const next = !enabled;
    try {
      setNameLinks(editor, next ? cards : []);
      if (editor.storage.markdown.getMarkdown() !== before || JSON.stringify(editor.state.selection.toJSON()) !== selection) {
        setNameLinks(editor, enabled ? cards : []);
        throw new Error('переключение автоссылок изменило Markdown или выделение');
      }
      enabled = next;
      toggle.setAttribute('aria-pressed', String(enabled));
      report('Автоссылки переключены; Markdown и выделение не изменились.');
    } catch (error) { report(`Ошибка проверки: ${error.message}`); }
  });

  function onClick(event) {
    if (!enabled || !(event.ctrlKey || event.metaKey)) return;
    const link = event.target.closest?.('.name-link');
    if (!link || !editor.view.dom.contains(link)) return;
    event.preventDefault();
    open(link.dataset.kind, link.dataset.card);
  }
  editor.view.dom.addEventListener('click', onClick);
  editor.on('destroy', () => {
    editor.view.dom.removeEventListener('click', onClick);
    panel.remove();
  });
}
