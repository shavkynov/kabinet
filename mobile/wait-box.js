import { activateModal } from './modal-focus.js';
import syncDiag from '../src/sync-diag.js';
// Окно ожидания с кнопкой «Отмена» (вход в Яндекс через браузер). Те же стили и закрытие кнопкой «назад», что у окон в ui.js.

// Панель импорта остаётся доступной, служебная кнопка и отчёты отключены.
if (typeof document !== 'undefined' && typeof window !== 'undefined') syncDiag.install({ overlay: true, diagnostics: false });

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/**
 * Возвращает { dismissed, close }. dismissed — обещание: true, если пользователь сам закрыл окно («Отмена» или «назад»),
 * false, если окно закрыл код через close(). Касание вне окна его не закрывает: пока человек в браузере, случайное
 * нажатие не должно сорвать вход.
 */
export function waitBox({ title, message, cancel }) {
  const modal = el('div', 'mob-modal');
  const sheet = el('div', 'mob-sheet');
  modal.append(sheet);
  let done = false;
  let cleanup = () => {};
  let finish = () => {};
  const dismissed = new Promise((resolve) => { finish = resolve; });
  const end = (byUser) => {
    if (done) return;
    done = true;
    modal.remove();
    cleanup();
    finish(byUser);
  };
  sheet.append(el('h2', '', title));
  if (message) sheet.append(el('div', 'mob-msg', message));
  const acts = el('div', 'mob-actions');
  const button = el('button', '', cancel || 'Отмена');
  button.type = 'button';
  button.addEventListener('click', () => end(true));
  acts.append(button);
  sheet.append(acts);
  modal.addEventListener('mob-cancel', () => end(true));
  document.body.append(modal);
  cleanup = activateModal(modal, sheet, () => end(true));
  return { dismissed, close: () => end(false) };
}
