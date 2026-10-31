// Окна выбора, подтверждения и меню для Android (на компьютере их рисовал Electron).

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function openModal(build) {
  return new Promise((resolve) => {
    const modal = el('div', 'mob-modal');
    const sheet = el('div', 'mob-sheet');
    modal.append(sheet);
    let done = false;
    const close = (value) => {
      if (done) return;
      done = true;
      modal.remove();
      resolve(value);
    };
    build(sheet, close);
    modal.addEventListener('mob-cancel', () => close(null));
    modal.addEventListener('click', (e) => { if (e.target === modal) close(null); });
    document.body.append(modal);
  });
}

/** Сообщение с кнопками. Возвращает номер нажатой кнопки (или cancelId). */
export function confirmBox({ message, detail, buttons = ['OK'], cancelId = buttons.length - 1 }) {
  return openModal((sheet, close) => {
    sheet.append(el('h2', '', message));
    if (detail) sheet.append(el('div', 'mob-msg', detail));
    const acts = el('div', 'mob-actions');
    buttons.forEach((label, i) => {
      const b = el('button', i === 0 && buttons.length > 1 ? 'mob-primary' : '', label);
      b.type = 'button';
      b.addEventListener('click', () => close(i));
      acts.append(b);
    });
    sheet.append(acts);
  }).then((v) => (v == null ? cancelId : v));
}

/** Список вариантов. Возвращает value выбранного пункта или null. */
export function chooseBox({ title, message, options, cancel }) {
  return openModal((sheet, close) => {
    sheet.append(el('h2', '', title));
    if (message) sheet.append(el('div', 'mob-msg', message));
    const list = el('div', 'mob-list');
    for (const o of options) {
      const b = el('button', '', o.label);
      b.type = 'button';
      b.addEventListener('click', () => close(o.value));
      list.append(b);
    }
    sheet.append(list);
    const acts = el('div', 'mob-actions');
    const c = el('button', '', cancel || 'Отмена');
    c.type = 'button';
    c.addEventListener('click', () => close(null));
    acts.append(c);
    sheet.append(acts);
  });
}

/** Меню программы: items — { head } | { sep } | { label, run, disabled }. */
export function menuBox(title, items) {
  return openModal((sheet, close) => {
    sheet.append(el('h2', '', title));
    const list = el('div', 'mob-list');
    for (const it of items) {
      if (it.head) { list.append(el('div', 'mob-head', it.head)); continue; }
      if (it.sep) { list.append(el('div', 'mob-sep')); continue; }
      const b = el('button', '', it.label);
      b.type = 'button';
      b.disabled = !!it.disabled;
      b.addEventListener('click', () => { close(null); setTimeout(() => it.run && it.run(), 30); });
      list.append(b);
    }
    sheet.append(list);
  });
}

let toastTimer = null;
export function toast(text) {
  document.querySelectorAll('.mob-toast').forEach((n) => n.remove());
  const t = el('div', 'mob-toast', text);
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 3200);
}

/** Выбор файлов в системном окне. Отмена даёт пустой список. */
export function pickFiles({ accept, multiple }) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = !!multiple;
    // Android плохо понимает расширения вроде .md или .ttf: фильтр оставляем только для картинок и звука
    const a = String(accept || '');
    input.accept = /^image\//.test(a) ? 'image/*' : /audio\//.test(a) ? 'audio/*,.wav,.mp3,.ogg,.m4a,.aac' : '*/*';
    input.style.display = 'none';
    document.body.append(input);
    let finished = false;
    const finish = (list) => {
      if (finished) return;
      finished = true;
      input.remove();
      window.removeEventListener('focus', onFocus);
      resolve(list);
    };
    const onFocus = () => setTimeout(() => { if (!finished && !input.files.length) finish([]); }, 1200);
    input.addEventListener('change', async () => {
      const out = [];
      for (const f of input.files) out.push({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) });
      finish(out);
    });
    input.addEventListener('cancel', () => finish([]));
    window.addEventListener('focus', onFocus);
    input.click();
  });
}
